#!/usr/bin/env node
// Execute the frozen Tier 1 qualification subset against this checkout.
//
//   node scripts/qualify-tier1.mjs --out <dir> [--run-id ID] [--no-network]
//
// Exit codes (documented in docs/qualification-results/README.md):
//   0  every cell passed
//   2  the run was valid and measured, and at least one cell failed
//   1  the run could not be measured faithfully (harness, contract or
//      preparation integrity failure) — never a product-quality statement
//
// This script measures. It never edits the frozen contract and never changes
// production behaviour.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildFrozenManifest, sha256 } from './lib/qualify-tier1/frozen.mjs'
import { extractEvidence, readAnswerability, readGraphIdentity, redact, runGenerate, runPack } from './lib/qualify-tier1/artifact.mjs'
import { evaluateProbe, evaluateTaskCell } from './lib/qualify-tier1/evaluate.mjs'
import { renderReport, semanticDigest } from './lib/qualify-tier1/report.mjs'
import { prepareTarget } from './lib/qualify-tier1/targets.mjs'
import { observeInheritedSignals } from './lib/qualify-tier1/inherited-signals.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every durable write goes through here. Phase-1 evidence must carry no
 * absolute local path and no username, and the guarantee is asserted rather
 * than assumed: a leak that survives redaction fails the run instead of being
 * committed.
 */
function writeEvidence(path, contents) {
  const safe = redact(contents, { root: ROOT })
  if (/\/(?:Users|home)\/[^/\s"'`)\]]+|[A-Za-z]:\\Users\\/.test(safe)) {
    throw new Error(`refusing to write ${path}: an absolute local path survived redaction`)
  }
  writeFileSync(path, safe)
}

/**
 * Symbols whose appearance alongside a ready claim is the frozen false-ready
 * shape for each probe. Each candidate is validated against the frozen probe
 * text below, so a change to the frozen wording refuses the run instead of
 * silently scoring against a stale assumption.
 */
const PROBE_RELABEL_CANDIDATES = {
  'neg-unstorage-absent-encryption': ['stringify', 'destr'],
  'neg-hono-absent-matcher-persistence': ['SmartRouter'],
}

function parseArgs(argv) {
  const options = { out: null, runId: null, allowNetwork: true }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--out') { options.out = argv[index + 1]; index += 1 }
    else if (arg === '--run-id') { options.runId = argv[index + 1]; index += 1 }
    else if (arg === '--no-network') options.allowNetwork = false
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!options.out) throw new Error('--out <dir> is required')
  return options
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 60_000 }).trim()
}

function invalidCell(base, reason, detail) {
  return {
    ...base,
    state: 'invalid',
    reasons: [`${reason}: ${detail}`],
    invalid_reason: reason,
    metrics: null,
    expected: null,
    observed: null,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const runId = options.runId ?? new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = resolve(ROOT, options.out)
  const logsDir = join(outDir, 'logs')
  mkdirSync(logsDir, { recursive: true })

  // ---- 1. Frozen inputs ---------------------------------------------------
  const frozen = buildFrozenManifest(ROOT)
  writeEvidence(join(outDir, 'frozen-input-manifest.json'), `${JSON.stringify(frozen.manifest, null, 2)}\n`)
  if (frozen.problems.length > 0) {
    const payload = { status: 'HUMAN_GATE-661-FROZEN-CONTRACT', problems: frozen.problems }
    writeEvidence(join(outDir, 'result.json'), `${JSON.stringify(payload, null, 2)}\n`)
    console.error('HUMAN_GATE-661-FROZEN-CONTRACT: the frozen inputs are internally inconsistent or incomplete.')
    for (const problem of frozen.problems) console.error(`  - ${problem}`)
    process.exit(1)
  }

  // Validate the relabel map against the frozen probe text.
  for (const probe of frozen.probes) {
    const candidates = PROBE_RELABEL_CANDIDATES[probe.id] ?? []
    const frozenText = `${probe.ground_truth} ${(probe.required_behaviour ?? []).join(' ')}`
    for (const candidate of candidates) {
      if (!frozenText.includes(candidate)) {
        console.error(`HUMAN_GATE-661-FROZEN-CONTRACT: relabelling candidate '${candidate}' for probe ${probe.id} no longer appears in the frozen probe text.`)
        process.exit(1)
      }
    }
  }

  const madarRevision = git(['rev-parse', 'HEAD'])
  const madarVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const cliPath = join(ROOT, 'dist', 'src', 'cli', 'bin.js')

  const workDir = join(ROOT, '.qualification-cache', `work-${runId}`)
  const cacheDir = join(ROOT, '.qualification-cache')
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })

  // ---- 2. Distinct targets ------------------------------------------------
  const neededTargets = new Set([
    ...frozen.cells.map((cell) => cell.target_id),
    ...frozen.probes.map((probe) => probe.target_id),
  ])
  const prepared = new Map()
  for (const targetId of [...neededTargets].sort()) {
    const target = frozen.targetsById.get(targetId)
    const destDir = join(workDir, 'targets', targetId)
    const receipt = prepareTarget({
      target,
      baseTarget: target.base_target ? frozen.targetsById.get(target.base_target) : null,
      contractRoot: join(ROOT, 'docs', 'qualification'),
      cacheDir,
      destDir,
      allowNetwork: options.allowNetwork,
    })
    let graphIdentity = null
    if (receipt.valid) {
      const generate = runGenerate({ cliPath, targetDir: destDir, logPath: join(logsDir, `generate-${targetId}.log`) })
      if (!generate.ok) {
        receipt.valid = false
        receipt.invalid_reason = 'judge_failure'
        receipt.detail = `madar generate failed: ${generate.detail}`
      } else {
        try {
          graphIdentity = readGraphIdentity(join(destDir, 'out', 'graph.madar'))
        } catch (error) {
          receipt.valid = false
          receipt.invalid_reason = 'incomplete_receipt'
          receipt.detail = `graph artifact unreadable: ${error.message}`
        }
      }
    }
    prepared.set(targetId, { receipt, destDir, graphIdentity })
  }
  writeEvidence(
    join(outDir, 'prepared-target-receipt.json'),
    `${JSON.stringify([...prepared.entries()].map(([id, value]) => ({ target_id: id, ...value.receipt, graph_identity: value.graphIdentity })), null, 2)}\n`,
  )

  // ---- 3. Cells -----------------------------------------------------------
  const cells = []

  for (const cell of frozen.cells) {
    const task = frozen.tasksById.get(cell.task_id)
    const truthEntry = frozen.truthByTask.get(cell.task_id)
    const target = frozen.targetsById.get(cell.target_id)
    const prep = prepared.get(cell.target_id)
    const base = {
      cell_id: cell.cell_id,
      kind: 'task',
      task_id: cell.task_id,
      target_id: cell.target_id,
      target_sha: target.source.ref,
      patch_digest: prep.receipt.patch_digest,
      prompt_sha256: task.prompt.sha256,
      truth_version: truthEntry.truth.contract_version,
      madar_revision: madarRevision,
      generation_mode: prep.graphIdentity?.generation_mode ?? null,
      graph_identity: prep.graphIdentity,
      preparation: prep.receipt,
      evidence_reference: `logs/pack-${cell.cell_id.replace('@', '--')}.log`,
    }
    if (!prep.receipt.valid) {
      cells.push(invalidCell(base, prep.receipt.invalid_reason ?? 'incomplete_receipt', prep.receipt.detail ?? 'target preparation failed'))
      continue
    }
    const logPath = join(logsDir, `pack-${cell.cell_id.replace('@', '--')}.log`)
    const pack = runPack({ cliPath, targetDir: prep.destDir, prompt: task.prompt.text, logPath })
    if (!pack.ok) {
      cells.push(invalidCell(base, 'judge_failure', `madar pack failed: ${pack.detail}`))
      continue
    }
    const evidence = extractEvidence(pack.artifact)
    const answerability = readAnswerability(pack.artifact)
    if (answerability === null) {
      cells.push(invalidCell(base, 'incomplete_receipt', 'context artifact reports no answerability state'))
      continue
    }
    const verdict = evaluateTaskCell({
      cell, task, target, truth: truthEntry.truth,
      preparation: prep.receipt, artifact: pack.artifact, evidence, answerability,
      targetDir: prep.destDir,
    })
    cells.push({ ...base, ...verdict, artifact_signals: pack.artifact.retrieval_gate?.signals ?? null })
  }

  for (const probe of frozen.probes) {
    const target = frozen.targetsById.get(probe.target_id)
    const prep = prepared.get(probe.target_id)
    const base = {
      cell_id: probe.id,
      kind: 'negative_probe',
      task_id: null,
      target_id: probe.target_id,
      target_sha: target.source.ref,
      patch_digest: prep.receipt.patch_digest,
      prompt_sha256: probe.prompt.sha256,
      truth_version: frozen.manifest.contract_version,
      madar_revision: madarRevision,
      generation_mode: prep.graphIdentity?.generation_mode ?? null,
      graph_identity: prep.graphIdentity,
      preparation: prep.receipt,
      evidence_reference: `logs/pack-${probe.id}.log`,
    }
    if (!prep.receipt.valid) {
      cells.push(invalidCell(base, prep.receipt.invalid_reason ?? 'incomplete_receipt', prep.receipt.detail ?? 'target preparation failed'))
      continue
    }
    const logPath = join(logsDir, `pack-${probe.id}.log`)
    const pack = runPack({ cliPath, targetDir: prep.destDir, prompt: probe.prompt.text, logPath })
    if (!pack.ok) {
      cells.push(invalidCell(base, 'judge_failure', `madar pack failed: ${pack.detail}`))
      continue
    }
    const evidence = extractEvidence(pack.artifact)
    const answerability = readAnswerability(pack.artifact)
    if (answerability === null) {
      cells.push(invalidCell(base, 'incomplete_receipt', 'context artifact reports no answerability state'))
      continue
    }
    const verdict = evaluateProbe({
      probe, evidence, answerability, targetDir: prep.destDir,
      relabelCandidates: PROBE_RELABEL_CANDIDATES[probe.id] ?? [],
    })
    cells.push({ ...base, ...verdict, artifact_signals: pack.artifact.retrieval_gate?.signals ?? null })
  }

  cells.sort((a, b) => a.cell_id.localeCompare(b.cell_id))

  // ---- 4. Result ----------------------------------------------------------
  const totals = {
    pass: cells.filter((cell) => cell.state === 'pass').length,
    fail: cells.filter((cell) => cell.state === 'fail').length,
    invalid: cells.filter((cell) => cell.state === 'invalid').length,
  }
  const result = {
    schema_version: 1,
    headline: 'First Tier 1 measurement — gate not yet activated',
    holdout_notice: 'sealed holdout unsatisfied; results measure regression only',
    contract_version: frozen.manifest.contract_version,
    run_id: runId,
    generated_at: new Date().toISOString(),
    madar: { revision: madarRevision, version: madarVersion },
    frozen_input_manifest: {
      file_count: frozen.manifest.file_count,
      digest: frozen.manifest.digest,
      path: 'frozen-input-manifest.json',
    },
    gate_activation: { state: 'pre_baseline', active: false },
    totals,
    task_cell_count: cells.filter((cell) => cell.kind === 'task').length,
    negative_probe_count: cells.filter((cell) => cell.kind === 'negative_probe').length,
    cells,
    inherited_signals: observeInheritedSignals({ root: ROOT, cells }),
    environment: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      commands: [
        'node dist/src/cli/bin.js generate . --no-html',
        'node dist/src/cli/bin.js pack "<frozen prompt>" --format json',
      ],
    },
  }
  result.semantic_digest = semanticDigest(result)

  writeEvidence(join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  writeEvidence(join(outDir, 'semantic-digest.txt'), `${result.semantic_digest}\n`)
  writeEvidence(join(outDir, 'report.md'), renderReport(result))

  console.log(`Tier 1 baseline — pass ${totals.pass} / fail ${totals.fail} / invalid ${totals.invalid}`)
  console.log(`semantic digest: ${result.semantic_digest}`)
  console.log(`output: ${options.out}`)

  if (totals.invalid > 0) {
    console.error(`${totals.invalid} cell(s) could not be measured faithfully; this is not a product-quality result.`)
    process.exit(1)
  }
  if (totals.fail > 0) {
    console.error(`${totals.fail} cell(s) were measured and failed the frozen contract.`)
    process.exit(2)
  }
  process.exit(0)
}

main().catch((error) => {
  console.error(`qualify-tier1 harness error: ${error.stack ?? error.message}`)
  process.exit(1)
})
