#!/usr/bin/env node
// Bounded falsifiability controls for the Tier 1 evaluator (E1-E6).
//
// Every control runs in BOTH directions: it proves the detector reports the
// defect when it is present AND reports clean when it is removed. A control
// that only fires one way asserts a property it does not check.
//
// All controls operate on COPIED inputs. The real frozen contract is never
// modified, and these controls never write inside docs/qualification.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildFrozenManifest } from './lib/qualify-tier1/frozen.mjs'
import { evaluateProbe, evaluateTaskCell } from './lib/qualify-tier1/evaluate.mjs'
import { prepareTarget } from './lib/qualify-tier1/targets.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const results = []

function record(id, title, arm, expectation, actual, passed, detail) {
  results.push({ id, title, arm, expectation, actual, passed, detail })
}

function check(id, title, arm, expectation, actual, detail = null) {
  const passed = expectation === actual
  record(id, title, arm, expectation, actual, passed, detail)
}

// --- shared synthetic inputs -------------------------------------------------
// A tiny stand-in target tree so path-existence checks are real, not stubbed.
const fixtureDir = mkdtempSync(join(tmpdir(), 'madar-tier1-selftest-'))
const REAL_PATHS = ['src/compose.ts', 'src/hono-base.ts']
mkdirSync(join(fixtureDir, 'src'), { recursive: true })
for (const rel of REAL_PATHS) {
  writeFileSync(join(fixtureDir, rel), '// selftest fixture\n')
}

function makeTruth(overrides = {}) {
  return {
    contract_version: '1.0.0',
    task_id: 'synthetic',
    tier1_obligations: {
      required_evidence_paths: ['src/compose.ts', 'src/hono-base.ts'],
      required_evidence_symbols: ['compose', 'dispatch'],
      min_critical_fact_recall: 1.0,
      must_not_report_ready_when: ['any required_evidence_path is absent from the evidence set'],
      ...overrides,
    },
  }
}

function makeEvidence({ paths, symbols }) {
  const sorted = (values) => [...values].sort()
  return {
    strict: { paths: sorted(paths), symbols: sorted(symbols) },
    generous: { paths: sorted(paths), symbols: sorted(symbols) },
  }
}

function evaluateSynthetic({ paths, symbols, answerability = 'verify_targets', truth = makeTruth() }) {
  return evaluateTaskCell({
    cell: { cell_id: 'synthetic@fixture', task_id: 'synthetic', target_id: 'fixture' },
    task: { id: 'synthetic', prompt: { text: 'x', sha256: 'x' } },
    target: { id: 'fixture', source: { ref: 'x' } },
    truth,
    preparation: { valid: true },
    artifact: { evidence: { answerability: { missing_obligations: [], verification_targets: [] } } },
    evidence: makeEvidence({ paths, symbols }),
    answerability,
    targetDir: fixtureDir,
  })
}

// --- E1: missing required fact ----------------------------------------------
{
  const clean = evaluateSynthetic({ paths: REAL_PATHS, symbols: ['compose', 'dispatch'] })
  check('E1', 'missing required fact', 'defect absent', 'pass', clean.state,
    `recall paths=${clean.metrics.critical_fact_recall.paths.ratio} symbols=${clean.metrics.critical_fact_recall.symbols.ratio}`)

  // Remove one expected critical fact from the observed result.
  const mutated = evaluateSynthetic({ paths: ['src/compose.ts'], symbols: ['compose', 'dispatch'] })
  check('E1', 'missing required fact', 'defect present', 'fail', mutated.state,
    mutated.reasons[0] ?? 'no reason recorded')
}

// --- E2: fabricated unsupported claim ---------------------------------------
{
  const clean = evaluateSynthetic({ paths: REAL_PATHS, symbols: ['compose', 'dispatch'] })
  check('E2', 'fabricated unsupported claim', 'defect absent', 0, clean.metrics.unsupported_claims)

  // A confident claim citing a path that does not exist in the pinned target.
  const mutated = evaluateSynthetic({
    paths: [...REAL_PATHS, 'src/totally-fabricated-encryption.ts'],
    symbols: ['compose', 'dispatch'],
  })
  check('E2', 'fabricated unsupported claim', 'defect present', 'fail', mutated.state,
    `unsupported_claims=${mutated.metrics.unsupported_claims}`)
  check('E2', 'fabricated unsupported claim', 'defect present (count)', 1, mutated.metrics.unsupported_claims)
}

// --- E3: false ready ---------------------------------------------------------
{
  const probe = { id: 'synthetic-probe', ground_truth: 'nothing', required_behaviour: [] }
  const clean = evaluateProbe({
    probe, evidence: makeEvidence({ paths: REAL_PATHS, symbols: [] }),
    answerability: 'verify_targets', targetDir: fixtureDir, relabelCandidates: [],
  })
  check('E3', 'false ready', 'defect absent', 'pass', clean.state)

  // Raise the probe's answerability above its frozen maximum.
  const mutated = evaluateProbe({
    probe, evidence: makeEvidence({ paths: REAL_PATHS, symbols: [] }),
    answerability: 'ready', targetDir: fixtureDir, relabelCandidates: [],
  })
  check('E3', 'false ready', 'defect present', 'fail', mutated.state, mutated.reasons[0] ?? '')
  check('E3', 'false ready', 'defect present (flag)', true, mutated.metrics.false_ready)
}

// --- E4: missing citation ----------------------------------------------------
{
  const probe = { id: 'synthetic-probe', ground_truth: 'nothing', required_behaviour: [] }
  const clean = evaluateProbe({
    probe, evidence: makeEvidence({ paths: REAL_PATHS, symbols: [] }),
    answerability: 'verify_targets', targetDir: fixtureDir, relabelCandidates: [],
  })
  check('E4', 'missing citation', 'defect absent', 0, clean.metrics.citation_evidence_failures)

  // A claim whose supporting source reference does not resolve in the target.
  const mutated = evaluateProbe({
    probe, evidence: makeEvidence({ paths: [...REAL_PATHS, 'src/dangling-citation.ts'], symbols: [] }),
    answerability: 'verify_targets', targetDir: fixtureDir, relabelCandidates: [],
  })
  check('E4', 'missing citation', 'defect present', 'fail', mutated.state, mutated.reasons[0] ?? '')
  check('E4', 'missing citation', 'defect present (count)', 1, mutated.metrics.citation_evidence_failures)
}

// --- E5: preparation mismatch ------------------------------------------------
{
  const corpus = JSON.parse(readFileSync(join(ROOT, 'docs/qualification/corpus.json'), 'utf8'))
  const hono = corpus.targets.find((entry) => entry.id === 'hono')
  const cacheDir = join(ROOT, '.qualification-cache')
  const workRoot = mkdtempSync(join(tmpdir(), 'madar-tier1-e5-'))

  const cleanReceipt = prepareTarget({
    target: hono, baseTarget: null,
    contractRoot: join(ROOT, 'docs', 'qualification'),
    cacheDir, destDir: join(workRoot, 'clean'), allowNetwork: true,
  })
  check('E5', 'preparation mismatch', 'defect absent', true, cleanReceipt.valid,
    `head=${cleanReceipt.head} blobs=${cleanReceipt.cited_blobs_verified}/${cleanReceipt.cited_blobs_total}`)

  // Change ONE cited blob digest on a COPY of the target definition.
  const mutatedTarget = JSON.parse(JSON.stringify(hono))
  const firstPath = Object.keys(mutatedTarget.cited_blobs)[0]
  mutatedTarget.cited_blobs[firstPath] = '0'.repeat(40)
  const mutatedReceipt = prepareTarget({
    target: mutatedTarget, baseTarget: null,
    contractRoot: join(ROOT, 'docs', 'qualification'),
    cacheDir, destDir: join(workRoot, 'mutated'), allowNetwork: true,
  })
  check('E5', 'preparation mismatch', 'defect present', 'target_revision_mismatch', mutatedReceipt.invalid_reason,
    mutatedReceipt.detail ?? '')
  check('E5', 'preparation mismatch', 'defect present (not valid)', false, mutatedReceipt.valid)
  rmSync(workRoot, { recursive: true, force: true })
}

// --- E6: truth mutation ------------------------------------------------------
{
  // Work entirely on a COPY of the contract. The real one is never touched.
  const copyRoot = mkdtempSync(join(tmpdir(), 'madar-tier1-e6-'))
  cpSync(join(ROOT, 'docs'), join(copyRoot, 'docs'), { recursive: true })

  const cleanManifest = buildFrozenManifest(copyRoot)
  check('E6', 'truth mutation', 'defect absent', 0, cleanManifest.problems.length,
    cleanManifest.problems.slice(0, 2).join('; '))

  // Mutate a frozen threshold on the copy.
  const truthPath = join(copyRoot, 'docs/qualification/truth/rootcause-hono-middleware-rerun.json')
  const truth = JSON.parse(readFileSync(truthPath, 'utf8'))
  truth.tier1_obligations.min_critical_fact_recall = 0.1
  writeFileSync(truthPath, `${JSON.stringify(truth, null, 2)}\n`)

  const mutatedManifest = buildFrozenManifest(copyRoot)
  const refused = mutatedManifest.problems.some((problem) => /content changed since it was frozen/.test(problem))
  check('E6', 'truth mutation (threshold)', 'defect present', true, refused,
    mutatedManifest.problems.find((problem) => /content changed/.test(problem)) ?? 'no digest refusal recorded')

  // Mutate a prohibited-claim rule (a negative probe's required behaviour).
  const tier1Path = join(copyRoot, 'docs/qualification/tier1.json')
  const tier1 = JSON.parse(readFileSync(tier1Path, 'utf8'))
  tier1.negative_trust_probes[0].required_behaviour = ['anything goes']
  writeFileSync(tier1Path, `${JSON.stringify(tier1, null, 2)}\n`)
  const mutatedRules = buildFrozenManifest(copyRoot)
  const refusedRules = mutatedRules.problems.some((problem) => /tier1\.json content changed since it was frozen/.test(problem))
  check('E6', 'truth mutation (prohibited-claim rule)', 'defect present', true, refusedRules,
    mutatedRules.problems.find((problem) => /tier1\.json content changed/.test(problem)) ?? 'no digest refusal recorded')

  rmSync(copyRoot, { recursive: true, force: true })
}

rmSync(fixtureDir, { recursive: true, force: true })

// --- report ------------------------------------------------------------------
const failed = results.filter((entry) => !entry.passed)
for (const entry of results) {
  const status = entry.passed ? 'ok  ' : 'FAIL'
  console.log(`${status} ${entry.id} [${entry.arm}] ${entry.title} — expected ${JSON.stringify(entry.expectation)}, got ${JSON.stringify(entry.actual)}${entry.detail ? ` :: ${entry.detail}` : ''}`)
}
console.log(`\n${results.length - failed.length}/${results.length} control assertions passed`)
if (failed.length > 0) {
  console.error(`${failed.length} control assertion(s) failed — the evaluator is not falsifiable as claimed.`)
  process.exit(1)
}
process.exit(0)
