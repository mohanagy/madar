#!/usr/bin/env node
/**
 * Stage 3 artifact and load delta for #658.
 *
 * Stage 3 changes what `out/graph.madar` contains and what a load has to
 * validate, so the qualification the earlier stages carried does not
 * automatically extend to it. The whole-issue receipt in
 * `verify-integrity-receipts.mjs` measures the candidate-accounting boundary
 * and stops there: it never serializes an artifact and never loads one. This
 * runner measures the two things Stage 3 actually moved.
 *
 * Deliberately a second runner rather than an extension of the first. The
 * whole-issue receipt is frozen evidence with its own mutation anchors and
 * self-tests; growing it to answer a different question would put both at risk
 * for no gain, since neither shares a measurement with the other.
 *
 * Protocol, matching the runner it sits beside:
 *
 *   - one canonical extraction, produced once and handed byte-identically to
 *     both heads, so a comparison cannot be two different extractions;
 *   - every arm in its own process, so neither head inherits the other's heap;
 *   - counterbalanced arm order, so a warm-up or thermal drift cannot be
 *     attributed to whichever head happened to run second;
 *   - the baseline built from an exact commit in a throwaway worktree, so the
 *     command is the evidence rather than a checkout someone prepared by hand.
 *
 * Read-only with respect to the repository: it writes only the receipt it is
 * asked to write, plus temporary directories it owns and removes.
 *
 * Usage:
 *   node scripts/verify-stage3-artifact-delta.mjs --baseline <ref> [--out <path>] [--runs N]
 */
import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import { runChildOrThrow } from './lib/child-runner.mjs'
import {
  assertCleanTree,
  assertDistinctArms,
  assertFreshBuild,
  resolveExactCommit,
} from './lib/receipt-guards.mjs'
import {
  createResourceRegistry,
  directoryCleanup,
  installSignalCoordinator,
  worktreeCleanup,
} from './lib/resource-registry.mjs'

const ROOT = process.cwd()
const BUILD_TIMEOUT_MS = 15 * 60 * 1000
const ARM_TIMEOUT_MS = 10 * 60 * 1000

const REGISTRY = createResourceRegistry({
  onWarning: (message) => console.error(`warning: ${message}`),
})
installSignalCoordinator(REGISTRY, {
  onWarning: (message) => console.error(`warning: ${message}`),
})

const argv = process.argv.slice(2)
const argOf = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : null
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/**
 * The gate #705 established and #658 inherits. A formal ratio above this is a
 * human decision, never a threshold this runner may raise.
 */
const RATIO_GATE = 2.0

/** Sub-1.0 is measurement variation, not a speedup, and is reported as such. */
function classifyRatio(ratio) {
  if (!Number.isFinite(ratio)) return 'not_established'
  if (ratio > RATIO_GATE) return 'above_gate'
  if (ratio < 1) return 'within_variation'
  return 'below_gate'
}

/** Every TypeScript file under src, in a stable order, with a content digest. */
function corpus() {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path)
    }
  }
  walk(join(ROOT, 'src'))
  return {
    files,
    count: files.length,
    checksum: sha256(files.map((path) => `${relative(ROOT, path)}:${sha256(readFileSync(path))}`).join('\n')),
  }
}

/**
 * Runs one measurement arm in its own process and returns what it measured.
 *
 * The arm re-enters this same file with `--arm`, so the code under measurement
 * is the built pipeline of the head being measured and nothing else.
 */
async function runArm({ dir, sha, label, runs, inputPath }) {
  const outPath = join(mkdtempSync(join(tmpdir(), 'madar-s3-arm-')), 'arm.json')
  const token = REGISTRY.register(`arm output ${outPath}`, directoryCleanup(dirname(outPath)))
  try {
    await runChildOrThrow(process.execPath, [
      resolve(ROOT, 'scripts/verify-stage3-artifact-delta.mjs'),
      '--arm', dir,
      '--arm-label', label,
      '--arm-input', inputPath,
      '--arm-out', outPath,
      '--runs', String(runs),
    ], {
      cwd: ROOT,
      registry: REGISTRY,
      description: `stage3 arm ${label} at ${sha}`,
      timeoutMs: ARM_TIMEOUT_MS,
    })
    const measured = JSON.parse(readFileSync(outPath, 'utf8'))
    if (measured.label !== label || measured.runs !== runs) {
      throw new Error(`arm ${label} returned a result for ${measured.label} with ${measured.runs} runs`)
    }
    return measured
  } finally {
    REGISTRY.release(token)
  }
}

/** Median of a sample list, reported to one decimal like the sibling runner. */
function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return Number(sorted[Math.floor(sorted.length / 2)].toFixed(1))
}

// ---------------------------------------------------------------- arm process

const ARM_DIR = argOf('--arm')
if (ARM_DIR !== null) {
  const label = argOf('--arm-label')
  const runs = Number(argOf('--runs') ?? 3)
  const input = JSON.parse(readFileSync(argOf('--arm-input'), 'utf8'))

  const base = `${ARM_DIR}/dist/src`
  const { buildFromJson } = await import(`${base}/pipeline/build.js`)
  const artifact = await import(`${base}/contracts/graph-artifact.js`)

  const generatedAt = '2026-08-24T00:00:00.000Z'
  const buildSamples = []
  const serializeSamples = []
  const loadSamples = []
  let graph = null
  let bytes = null

  for (let index = 0; index < runs; index += 1) {
    let started = process.hrtime.bigint()
    graph = buildFromJson(input, {
      directed: true,
      accounting: 'normalized_extraction_boundary',
      repositoryRoot: ARM_DIR,
    })
    buildSamples.push(Number(process.hrtime.bigint() - started) / 1e6)

    started = process.hrtime.bigint()
    bytes = artifact.serializeGraphArtifactV2({
      graph,
      repositoryRevision: 'stage3-delta',
      generationMode: 'full',
      generatedAt,
    })
    serializeSamples.push(Number(process.hrtime.bigint() - started) / 1e6)

    started = process.hrtime.bigint()
    artifact.loadGraphArtifact(bytes)
    loadSamples.push(Number(process.hrtime.bigint() - started) / 1e6)
  }

  const receipt = JSON.parse(bytes.toString('utf8').slice(artifact.GRAPH_ARTIFACT_V2_HEADER.length)).integrity_receipt
  const block = receipt.normalized_accounting ?? null
  const snapshot = graph.normalizedIntegritySnapshot()

  // Written to a temporary file and renamed, so a partially flushed payload can
  // never be read as a complete measurement.
  const payload = `${JSON.stringify({
    label,
    runs,
    arm_sha_dir: ARM_DIR,
    build_samples_ms: buildSamples.map((value) => Number(value.toFixed(1))),
    serialize_samples_ms: serializeSamples.map((value) => Number(value.toFixed(1))),
    load_samples_ms: loadSamples.map((value) => Number(value.toFixed(1))),
    peak_rss_mib: Math.round(process.resourceUsage().maxRSS / 1024),
    artifact_bytes: bytes.length,
    artifact_digest: sha256(bytes),
    normalized_block_present: block !== null,
    normalized_block_bytes: block === null ? 0 : Buffer.byteLength(JSON.stringify(block), 'utf8'),
    facts: graph.numberOfFacts(),
    occurrences: graph.numberOfOccurrences(),
    endpoint_pairs: graph.numberOfEndpointPairs(),
    emitted_candidates: snapshot === null ? null : snapshot.emittedCandidates,
    terminal_counts: snapshot === null ? null : snapshot.terminalCounts,
    record_retention: snapshot === null ? null : snapshot.recordRetention,
    scope_failure_retention: snapshot === null ? null : snapshot.scopeFailureRetention,
  }, null, 2)}\n`
  const staged = `${argOf('--arm-out')}.partial`
  const handle = openSync(staged, 'w')
  writeSync(handle, payload)
  fsyncSync(handle)
  closeSync(handle)
  renameSync(staged, argOf('--arm-out'))
  process.exit(0)
}

// ------------------------------------------------------------- parent process

const BASELINE = argOf('--baseline')
const OUT = argOf('--out') ?? join(ROOT, 'stage3-artifact-delta.json')
const RUNS = Number(argOf('--runs') ?? 3)
if (BASELINE === null) {
  console.error('usage: verify-stage3-artifact-delta.mjs --baseline <ref> [--out <path>] [--runs N]')
  process.exit(2)
}

assertCleanTree(ROOT)
const candidateSha = resolveExactCommit(ROOT, 'HEAD')
const baselineSha = resolveExactCommit(ROOT, BASELINE)
assertDistinctArms(baselineSha, candidateSha)

const inventory = corpus()

/** One extraction, produced by the candidate head and reused byte-for-byte. */
const { extract } = await import(`${ROOT}/dist/src/pipeline/extract.js`)
const canonicalInput = extract(inventory.files)
const inputDir = mkdtempSync(join(tmpdir(), 'madar-s3-input-'))
const inputToken = REGISTRY.register(`canonical input ${inputDir}`, directoryCleanup(inputDir))
const inputPath = join(inputDir, 'input.json')
writeFileSync(inputPath, JSON.stringify(canonicalInput), 'utf8')
const inputChecksum = sha256(readFileSync(inputPath))

const baselineDir = mkdtempSync(join(tmpdir(), 'madar-s3-baseline-'))
const baselineToken = REGISTRY.register(`worktree ${baselineSha} at ${baselineDir}`, worktreeCleanup(ROOT, baselineDir))

let receipt
try {
  await runChildOrThrow('git', ['worktree', 'add', '--detach', baselineDir, baselineSha], {
    cwd: ROOT, registry: REGISTRY, description: `git worktree add ${baselineSha}`, timeoutMs: BUILD_TIMEOUT_MS,
  })
  for (const step of [['ci'], ['run', 'build']]) {
    await runChildOrThrow('npm', step, {
      cwd: baselineDir,
      registry: REGISTRY,
      description: `npm ${step.join(' ')} at ${baselineSha}`,
      timeoutMs: BUILD_TIMEOUT_MS,
    })
  }
  assertFreshBuild(baselineDir, baselineSha)

  // Counterbalanced: baseline first in one session, candidate first in the
  // other. A warm-up or thermal effect that favoured whichever ran second would
  // otherwise be attributed to the head rather than to the order.
  const sessions = []
  for (const [first, second] of [['baseline', 'candidate'], ['candidate', 'baseline']]) {
    const armFor = (name) => (name === 'baseline'
      ? { dir: baselineDir, sha: baselineSha }
      : { dir: ROOT, sha: candidateSha })
    const firstResult = await runArm({ ...armFor(first), label: first, runs: RUNS, inputPath })
    const secondResult = await runArm({ ...armFor(second), label: second, runs: RUNS, inputPath })
    sessions.push({ order: [first, second], [first]: firstResult, [second]: secondResult })
  }

  const armsOf = (name) => sessions.map((session) => session[name])
  const metric = (name, key) => median(armsOf(name).flatMap((arm) => arm[key]))
  const scalar = (name, key) => Math.max(...armsOf(name).map((arm) => arm[key]))

  const ratios = {}
  for (const [label, key, kind] of [
    ['build_wall', 'build_samples_ms', 'samples'],
    ['serialize_wall', 'serialize_samples_ms', 'samples'],
    ['load_wall', 'load_samples_ms', 'samples'],
    ['peak_rss', 'peak_rss_mib', 'scalar'],
    ['artifact_bytes', 'artifact_bytes', 'scalar'],
  ]) {
    const base = kind === 'samples' ? metric('baseline', key) : scalar('baseline', key)
    const candidate = kind === 'samples' ? metric('candidate', key) : scalar('candidate', key)
    const ratio = base === 0 ? Number.POSITIVE_INFINITY : Number((candidate / base).toFixed(3))
    ratios[label] = { baseline: base, candidate, ratio, verdict: classifyRatio(ratio) }
  }

  const candidateArm = armsOf('candidate')[0]
  const baselineArm = armsOf('baseline')[0]

  // Every arm must have seen the same graph. A delta between two different
  // graphs is not a delta.
  const parity = {
    facts: candidateArm.facts === baselineArm.facts,
    occurrences: candidateArm.occurrences === baselineArm.occurrences,
    endpoint_pairs: candidateArm.endpoint_pairs === baselineArm.endpoint_pairs,
    emitted_candidates: candidateArm.emitted_candidates === baselineArm.emitted_candidates,
    terminal_counts: JSON.stringify(candidateArm.terminal_counts) === JSON.stringify(baselineArm.terminal_counts),
  }

  receipt = {
    receipt: 'stage3-artifact-delta',
    generated_by: 'scripts/verify-stage3-artifact-delta.mjs',
    baseline_ref: BASELINE,
    baseline_sha: baselineSha,
    candidate_sha: candidateSha,
    runs_per_arm: RUNS,
    sessions: sessions.length,
    corpus: { scope: 'src-only', file_count: inventory.count, checksum: inventory.checksum },
    canonical_input_checksum: inputChecksum,
    ratio_gate: RATIO_GATE,
    ratios,
    graph_parity: parity,
    normalized_block: {
      baseline_present: baselineArm.normalized_block_present,
      candidate_present: candidateArm.normalized_block_present,
      candidate_bytes: candidateArm.normalized_block_bytes,
      candidate_share_of_artifact: Number(
        (candidateArm.normalized_block_bytes / candidateArm.artifact_bytes).toFixed(4),
      ),
      record_retention: candidateArm.record_retention,
      scope_failure_retention: candidateArm.scope_failure_retention,
    },
    arms: sessions,
  }
} finally {
  REGISTRY.release(baselineToken)
  REGISTRY.release(inputToken)
}

mkdirSync(dirname(resolve(ROOT, OUT)), { recursive: true })
writeFileSync(resolve(ROOT, OUT), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')

const failures = Object.entries(receipt.ratios).filter(([, entry]) => entry.verdict === 'above_gate')
const parityFailures = Object.entries(receipt.graph_parity).filter(([, ok]) => ok !== true)

console.log(`stage 3 artifact delta  ${baselineSha.slice(0, 8)} -> ${candidateSha.slice(0, 8)}`)
console.log(`corpus                  ${inventory.count} files, checksum ${inventory.checksum.slice(0, 12)}`)
for (const [label, entry] of Object.entries(receipt.ratios)) {
  console.log(`  ${label.padEnd(16)} ${String(entry.baseline).padStart(12)} -> ${String(entry.candidate).padStart(12)}  ${entry.ratio}x  ${entry.verdict}`)
}
console.log(`normalized block        ${receipt.normalized_block.candidate_bytes} bytes `
  + `(${(receipt.normalized_block.candidate_share_of_artifact * 100).toFixed(2)}% of the artifact)`)
console.log(`graph parity            ${parityFailures.length === 0 ? 'identical' : 'DIFFERENT'}`)
console.log(`receipt                 ${relative(ROOT, resolve(ROOT, OUT))}`)

if (parityFailures.length > 0) {
  console.error(`graph parity failed: ${parityFailures.map(([name]) => name).join(', ')}`)
  process.exit(1)
}
if (failures.length > 0) {
  console.error(`HUMAN_GATE: ${failures.map(([name]) => name).join(', ')} above ${RATIO_GATE}x`)
  process.exit(1)
}
console.log('STAGE 3 ARTIFACT DELTA PASS')
