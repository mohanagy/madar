#!/usr/bin/env node
// Bounded falsifiability controls for the Tier 1 evaluator.
//
//   E1-E6, E9-E12, E15, S1-S4  evidence surface, recall, preparation, integrity
//   A1-A12                     the machine-checkable adjudication contract
//
// A16 tested the relationship param that used to be overloaded onto
// must_not_ready_when_requirements_missing. That param is gone; relationships
// have their own predicate and REL1-REL18 test it far more strictly, including
// direction, relation kind, endpoint identity and group cardinality, none of
// which A16 covered.
//
// E7, E13 and E14 tested the removed prose heuristics (absence-by-negation-word
// and unresolved-by-mention). They are superseded by A1-A10, which test the same
// obligations against typed channels instead of sentences. Nothing they covered
// is now untested; the mapping is recorded in docs/qualification-results/README.md.
//
// Every control runs in BOTH directions: it proves the detector reports the
// defect when it is present AND reports clean when it is removed. A control
// that only fires one way asserts a property it does not check.
//
// All controls operate on COPIED inputs. The real frozen contract is never
// modified, and these controls never write inside docs/qualification.

import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildFrozenManifest } from './lib/qualify-tier1/frozen.mjs'
import { extractEvidence } from './lib/qualify-tier1/artifact.mjs'
import { loadAdjudication } from './lib/qualify-tier1/adjudication.mjs'
import { MISSING_ABSENCE_DECLARATION, evaluateProbe, evaluateTaskCell } from './lib/qualify-tier1/evaluate.mjs'
import { prepareTarget, symbolExistsInTarget } from './lib/qualify-tier1/targets.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const results = []

/** Every Tier 1 clause the adjudication contract must bind, derived not listed. */
const REQUIRED_CLAUSES = (() => {
  const clauses = []
  const tier1 = JSON.parse(readFileSync(join(ROOT, 'docs/qualification/tier1.json'), 'utf8'))
  tier1.negative_trust_probes.forEach((probe, probeIndex) => {
    (probe.required_behaviour ?? []).forEach((_, index) => {
      clauses.push({ file: 'docs/qualification/tier1.json', pointer: `/negative_trust_probes/${probeIndex}/required_behaviour/${index}` })
    })
  })
  const tasks = JSON.parse(readFileSync(join(ROOT, 'docs/qualification/tasks.json'), 'utf8'))
  const tier1TaskIds = new Set(tier1.cells.map((cell) => cell.task_id))
  for (const task of tasks.tasks) {
    if (!tier1TaskIds.has(task.id)) continue
    const rel = `docs/qualification/${task.truth_ref}`
    const truth = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
    ;(truth.tier1_obligations?.must_not_report_ready_when ?? []).forEach((_, index) => {
      clauses.push({ file: rel, pointer: `/tier1_obligations/must_not_report_ready_when/${index}` })
    })
  }
  return clauses
})()

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
// The fixture carries the identifiers the controls treat as real, so the
// symbol-grounding check is exercised against genuine source text rather than a
// stub that would agree with anything.
writeFileSync(join(fixtureDir, 'src/compose.ts'), 'export function compose() {}\nexport const dispatch = 1\n')
writeFileSync(join(fixtureDir, 'src/hono-base.ts'), 'export class Hono { fetch() {} }\nexport const SmartRouter = 1\nexport const match = 2\n')
writeFileSync(join(fixtureDir, 'src/storage.ts'), 'export function createStorage() {}\nexport function getMount() {}\nexport interface Driver {}\n')

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

function makeEvidence({ paths, symbols, snippets = [] }) {
  const sorted = (values) => [...values].sort()
  return {
    strict: { paths: sorted(paths), symbols: sorted(symbols) },
    generous: { paths: sorted(paths), symbols: sorted(symbols) },
    basename_references: [],
    snippets,
    unclassified: [],
    guarded: [],
    channels: [],
  }
}

/**
 * A synthetic adjudication contract. Controls must never depend on the real
 * frozen contract's wording, or a contract edit would silently rewrite what the
 * controls assert.
 */
function syntheticAdjudication(clauses, { requirements = [] } = {}) {
  const byClause = new Map()
  clauses.forEach((entry, index) => {
    byClause.set(`synthetic-truth.json#/tier1_obligations/must_not_report_ready_when/${index}`, {
      id: entry.id ?? `ADJ-SYN-${index}`,
      source: { file: 'synthetic-truth.json', pointer: `/tier1_obligations/must_not_report_ready_when/${index}`, clause_sha256: 'synthetic' },
      predicate: entry.predicate,
    })
  })
  return { digest: 'synthetic', byClause, requirementsById: new Map(requirements.map((r) => [r.id, r])), problems: [] }
}

function syntheticProbeAdjudication(entries) {
  const byClause = new Map()
  entries.forEach((entry, index) => {
    byClause.set(`docs/qualification/tier1.json#/negative_trust_probes/0/required_behaviour/${index}`, {
      id: entry.id ?? `ADJ-SYNP-${index}`,
      source: { file: 'docs/qualification/tier1.json', pointer: `/negative_trust_probes/0/required_behaviour/${index}`, clause_sha256: 'synthetic' },
      predicate: entry.predicate,
    })
  })
  return { digest: 'synthetic', byClause, requirementsById: new Map(), problems: [] }
}

function evaluateSynthetic({ paths, symbols, snippets = [], answerability = 'verify_targets', truth = makeTruth(), artifact = null, adjudication = null }) {
  const clauses = truth.tier1_obligations.must_not_report_ready_when ?? []
  return evaluateTaskCell({
    cell: { cell_id: 'synthetic@fixture', task_id: 'synthetic', target_id: 'fixture' },
    task: { id: 'synthetic', prompt: { text: 'x', sha256: 'x' } },
    target: { id: 'fixture', source: { ref: 'x' } },
    truth,
    truthFile: 'synthetic-truth.json',
    preparation: { valid: true },
    artifact: artifact ?? { evidence: { answerability: { state: answerability, missing_obligations: [], verification_targets: [] } } },
    evidence: makeEvidence({ paths, symbols, snippets }),
    answerability,
    targetDir: fixtureDir,
    adjudication: adjudication ?? syntheticAdjudication(clauses.map(() => ({ predicate: { kind: 'required_evidence_paths_present', params: {} } }))),
  })
}

function evaluateSyntheticProbe({ probe, paths = REAL_PATHS, symbols = [], answerability = 'verify_targets', artifact = {}, entries }) {
  return evaluateProbe({
    probe, probeIndex: 0,
    evidence: makeEvidence({ paths, symbols }),
    artifact,
    answerability,
    targetDir: fixtureDir,
    adjudication: syntheticProbeAdjudication(entries),
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
  const probe = { id: 'synthetic-probe', ground_truth: 'nothing', required_behaviour: ['The artifact must not report a ready state.'] }
  const entries = [{ id: 'ADJ-SYN-READY', predicate: { kind: 'answerability_not_in', params: { states: ['ready', 'ready_with_caveat'] } } }]

  const clean = evaluateSyntheticProbe({ probe, entries, answerability: 'verify_targets' })
  check('E3', 'false ready', 'defect absent', 'pass', clean.state)

  for (const state of ['ready', 'ready_with_caveat']) {
    const mutated = evaluateSyntheticProbe({ probe, entries, answerability: state })
    check('E3', 'false ready', `defect present (${state})`, 'fail', mutated.state, mutated.reasons[0] ?? '')
    check('E3', 'false ready', `defect present flag (${state})`, true, mutated.metrics.false_ready)
  }
}

// --- E4: missing citation ----------------------------------------------------
{
  const probe = { id: 'synthetic-probe', ground_truth: 'nothing', required_behaviour: ['No fabricated path or symbol may appear in the evidence set.'] }
  const entries = [{ id: 'ADJ-SYN-NOFAB', predicate: { kind: 'prohibited_reference_absent', params: { scope: 'paths_and_symbols' } } }]

  const clean = evaluateSyntheticProbe({ probe, entries, paths: REAL_PATHS, symbols: ['compose'] })
  check('E4', 'missing citation', 'defect absent', 0, clean.metrics.citation_evidence_failures)
  check('E4', 'missing citation', 'defect absent (state)', 'pass', clean.state)

  // A claim whose supporting source reference does not resolve in the target.
  const mutated = evaluateSyntheticProbe({ probe, entries, paths: [...REAL_PATHS, 'src/dangling-citation.ts'] })
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


// --- S1: a visible symbol is counted -----------------------------------------
// A symbol present in a real supported evidence channel must enter observed
// symbols. `pack.matched_nodes[].label` is the channel attempt 1 never read.
{
  const withMatchedNodes = extractEvidence({
    pack: { matched_nodes: [{ label: 'createStorage', source_file: 'src/storage.ts' }] },
  })
  check('S1', 'visible symbol is counted', 'symbol present', true,
    withMatchedNodes.generous.symbols.includes('createStorage'),
    `symbols=${JSON.stringify(withMatchedNodes.generous.symbols)}`)
  check('S1', 'visible symbol is counted', 'path present', true,
    withMatchedNodes.generous.paths.includes('src/storage.ts'))

  // Remove the channel: the symbol must stop being observed.
  const withoutMatchedNodes = extractEvidence({ pack: { matched_nodes: [] } })
  check('S1', 'visible symbol is counted', 'channel emptied', false,
    withoutMatchedNodes.generous.symbols.includes('createStorage'))

  // Every non-`impact` artifact shape must be reachable, not just this one.
  for (const [channel, artifact] of [
    ['pack.seed_nodes', { pack: { seed_nodes: [{ label: 'errorHandler', source_file: 'src/hono-base.ts' }] } }],
    ['pack.review_bundle.nodes', { pack: { review_bundle: { nodes: [{ label: 'errorHandler', source_file: 'src/hono-base.ts' }] } } }],
    ['pack.relationships', { pack: { relationships: [{ from: 'Hono', to: 'errorHandler', relation: 'contains' }] } }],
    ['pack.execution_slice.steps', { pack: { execution_slice: { steps: [{ label: 'errorHandler', source_file: 'src/hono-base.ts' }] } } }],
    ['likely_edit_files.matched_symbols', { likely_edit_files: [{ path: 'src/hono-base.ts', matched_symbols: ['errorHandler'] }] }],
  ]) {
    const observed = extractEvidence(artifact)
    check('S1', 'visible symbol is counted', `channel ${channel}`, true,
      observed.generous.symbols.includes('errorHandler'),
      `symbols=${JSON.stringify(observed.generous.symbols)}`)
  }
}

// --- S2: a symbol present only in frozen truth is not counted ----------------
{
  const truth = makeTruth({ required_evidence_symbols: ['createStorage'] })
  // The artifact surfaced nothing; the obligation names `createStorage`.
  const missing = evaluateSynthetic({ paths: REAL_PATHS, symbols: [], truth })
  check('S2', 'truth-only symbol stays missing', 'obligation not surfaced', true,
    missing.observed.missing_critical_symbols.includes('createStorage'),
    `observed=${JSON.stringify(missing.observed.critical_symbols)}`)
  check('S2', 'truth-only symbol stays missing', 'obligation not surfaced (fails)', 'fail', missing.state)

  // The same obligation, now genuinely surfaced by the artifact.
  const surfaced = evaluateSynthetic({ paths: REAL_PATHS, symbols: ['createStorage'], truth })
  check('S2', 'truth-only symbol stays missing', 'obligation surfaced', 'pass', surfaced.state)
}

// --- S3: method qualification -------------------------------------------------
// rubrics.json authorises exactly one projection: the LAST dot-separated
// segment, after stripping a leading '#'. `Hono.fetch` therefore satisfies
// `fetch`; a bare class name is NOT satisfied by one of its methods.
{
  const bareClass = makeTruth({ required_evidence_symbols: ['SmartRouter'], required_evidence_paths: [] })
  const qualifiedMethod = evaluateSynthetic({ paths: [], symbols: ['SmartRouter.match'], truth: bareClass })
  check('S3', 'method qualification', 'SmartRouter.match does not satisfy SmartRouter', 'fail', qualifiedMethod.state,
    `missing=${JSON.stringify(qualifiedMethod.observed.missing_critical_symbols)}`)

  const bareSurfaced = evaluateSynthetic({ paths: [], symbols: ['SmartRouter'], truth: bareClass })
  check('S3', 'method qualification', 'SmartRouter satisfies SmartRouter', 'pass', bareSurfaced.state)

  // The projection the contract DOES authorise still works in the other
  // direction: an owner-qualified member satisfies a bare member obligation.
  const bareMember = makeTruth({ required_evidence_symbols: ['fetch'], required_evidence_paths: [] })
  const ownerQualified = evaluateSynthetic({ paths: [], symbols: ['Hono.fetch'], truth: bareMember })
  check('S3', 'method qualification', 'Hono.fetch satisfies fetch', 'pass', ownerQualified.state)

  const privateQualified = evaluateSynthetic({
    paths: [], symbols: ['Hono.#insertPath'], truth: makeTruth({ required_evidence_symbols: ['insertPath'], required_evidence_paths: [] }),
  })
  check('S3', 'method qualification', 'Hono.#insertPath satisfies insertPath', 'pass', privateQualified.state)
}

// --- S4: a symbol only in unrelated text does not count ----------------------
{
  const truth = makeTruth({ required_evidence_symbols: ['createStorage'], required_evidence_paths: [] })

  // Prose channels are classified `ignored`, so a name that appears only in a
  // rationale, a claim sentence or the echoed prompt never enters the set.
  const prose = extractEvidence({
    why_explanation: ['Start with createStorage because it is the entry point.'],
    prompt: 'Explain createStorage and getMount.',
    claims: [{ text: 'primary evidence: createStorage', evidence_class: 'primary', node_labels: [] }],
    pack: { affected_communities: [{ label: 'Drivers Github — Driver' }] },
  })
  check('S4', 'unrelated text is not counted', 'prose and prompt only', 0, prose.generous.symbols.length,
    `symbols=${JSON.stringify(prose.generous.symbols)}`)

  // A community/cluster name must not satisfy a code-symbol obligation. The
  // assertion is on the RECALL reason specifically: passing merely because the
  // label is also ungrounded would not test what this control claims to test.
  const communityOnly = evaluateSynthetic({
    paths: [], symbols: ['Drivers Github — Driver'],
    truth: makeTruth({ required_evidence_symbols: ['Driver'], required_evidence_paths: [] }),
  })
  check('S4', 'unrelated text is not counted', 'community label does not satisfy Driver', true,
    communityOnly.observed.missing_critical_symbols.includes('Driver'),
    communityOnly.reasons.find((reason) => reason.includes('required_evidence_symbols recall')) ?? 'no recall reason')

  // ... and the registry drops it before it can even reach the comparison.
  const communityChannel = extractEvidence({
    workflow_centers: [{ label: 'Drivers Github — Driver', node_count: 8, reason: 'community' }],
  })
  check('S4', 'unrelated text is not counted', 'community-shaped workflow center is guarded', 0,
    communityChannel.generous.symbols.length, `guarded=${JSON.stringify(communityChannel.guarded.map((entry) => entry.value))}`)

  // The same channel, node-shaped, IS read.
  const nodeChannel = extractEvidence({
    workflow_centers: [{ label: 'createStorage', path: 'src/storage.ts', matched_symbols: ['createStorage'] }],
  })
  check('S4', 'unrelated text is not counted', 'node-shaped workflow center is read', true,
    nodeChannel.generous.symbols.includes('createStorage'))

  // A snippet containing the identifier is recorded, never counted.
  const snippetOnly = evaluateSynthetic({
    paths: [], symbols: [], truth,
    snippets: [{ schema_path: '.pack.matched_nodes[0].snippet', channel: '.pack.matched_nodes[].snippet', text: 'export function createStorage() {}' }],
  })
  check('S4', 'unrelated text is not counted', 'snippet text does not satisfy the obligation', 'fail', snippetOnly.state)
  check('S4', 'unrelated text is not counted', 'snippet sighting is still reported', 1,
    snippetOnly.observed.required_symbols_seen_only_in_snippets.length)

  // The same name in a real supported channel IS counted, so the control is not
  // simply refusing everything.
  const realChannel = evaluateSynthetic({ paths: [], symbols: ['createStorage'], truth })
  check('S4', 'unrelated text is not counted', 'real channel is counted', 'pass', realChannel.state)
}

// --- E9: an unadjudicated frozen requirement can never be represented as pass -
{
  const probe = {
    id: 'synthetic-unmapped-probe', ground_truth: 'nothing',
    required_behaviour: ['The artifact must not report a ready state.', 'The artifact must hum a tune no predicate covers.'],
  }
  // Only the first clause is bound, so the second has no adjudication entry.
  const partial = evaluateSyntheticProbe({
    probe, entries: [{ id: 'ADJ-SYN-READY', predicate: { kind: 'answerability_not_in', params: { states: ['ready', 'ready_with_caveat'] } } }],
    answerability: 'verify_targets',
  })
  check('E9', 'unadjudicated requirement', 'clause with no entry', 'invalid', partial.state,
    partial.reasons[0] ?? 'no reason recorded')
  check('E9', 'unadjudicated requirement', 'never pass', false, partial.state === 'pass')

  // Bind both clauses and the same run passes.
  const complete = evaluateSyntheticProbe({
    probe: { ...probe, required_behaviour: ['The artifact must not report a ready state.'] },
    entries: [{ id: 'ADJ-SYN-READY', predicate: { kind: 'answerability_not_in', params: { states: ['ready', 'ready_with_caveat'] } } }],
    answerability: 'verify_targets',
  })
  check('E9', 'unadjudicated requirement', 'fully bound clause set', 'pass', complete.state)
}

// --- E10: the evidence surface must be closed --------------------------------
{
  const closed = extractEvidence({ pack: { matched_nodes: [{ label: 'compose', source_file: 'src/compose.ts' }] } })
  check('E10', 'evidence surface closure', 'every channel classified', 0, closed.unclassified.length)

  // An artifact that grows a channel the registry does not know must be
  // detected rather than silently dropped.
  const grown = extractEvidence({ pack: { matched_nodes: [{ label: 'compose', source_file: 'src/compose.ts' }] }, brand_new_channel: ['src/secret.ts'] })
  check('E10', 'evidence surface closure', 'unclassified channel detected', 1, grown.unclassified.length,
    grown.unclassified.map((entry) => entry.channel).join(', '))
}

// --- E11: symbol grounding ----------------------------------------------------
{
  check('E11', 'symbol grounding', 'symbol present in target', true, symbolExistsInTarget(fixtureDir, 'compose'))
  check('E11', 'symbol grounding', 'qualified symbol present in target', true, symbolExistsInTarget(fixtureDir, 'Hono.fetch'))
  check('E11', 'symbol grounding', 'invented symbol absent from target', false,
    symbolExistsInTarget(fixtureDir, 'AbsolutelyNotInThisTree'))
}

// --- E15: a task cell is gated on cited paths, not on all symbols -------------
// rubrics.json#/methods/evidence_obligation_recall requires "Every path cited by
// the artifact must exist in the pinned target" and says nothing about symbols.
// Adding a symbol gate would fail a cell the frozen contract passes.
{
  const truth = makeTruth({ required_evidence_paths: ['src/compose.ts'], required_evidence_symbols: ['compose'] })

  const ungrounded = evaluateSynthetic({ paths: ['src/compose.ts'], symbols: ['compose', 'ZzNotInTheFixtureAtAll'], truth })
  check('E15', 'task cells gate on paths, not symbols', 'ungrounded symbol does not fail the cell', 'pass', ungrounded.state,
    ungrounded.reasons.join('; ') || 'no reasons')
  check('E15', 'task cells gate on paths, not symbols', 'ungrounded symbol is still reported', 1,
    ungrounded.observed.ungrounded_symbols.length)

  // A cited path that does not exist DOES fail: the gate the contract mandates
  // is still present, so this control is not simply accepting everything.
  const badPath = evaluateSynthetic({ paths: ['src/compose.ts', 'src/not-here.ts'], symbols: ['compose'], truth })
  check('E15', 'task cells gate on paths, not symbols', 'nonexistent cited path still fails', 'fail', badPath.state,
    badPath.reasons[0] ?? '')

  // The negative probes DO gate on symbols, because their frozen
  // required_behaviour says "No fabricated path or symbol".
  const probe = {
    id: 'synthetic-probe',
    prompt: { text: 'How does this library encrypt values at rest?' },
    ground_truth: 'nothing',
    required_behaviour: ['No fabricated path or symbol may appear in the evidence set.'],
  }
  const entries = [{ id: 'ADJ-SYN-NOFAB', predicate: { kind: 'prohibited_reference_absent', params: { scope: 'paths_and_symbols' } } }]
  const probeClean = evaluateSyntheticProbe({ probe, entries, paths: REAL_PATHS, symbols: ['compose'] })
  check('E15', 'task cells gate on paths, not symbols', 'probe with grounded symbols', 'pass', probeClean.state)
  const probeFabricated = evaluateSyntheticProbe({ probe, entries, paths: REAL_PATHS, symbols: ['ZzNotInTheFixtureAtAll'] })
  check('E15', 'task cells gate on paths, not symbols', 'probe with a fabricated symbol', 'fail', probeFabricated.state,
    probeFabricated.reasons[0] ?? '')
}


// =============================================================================
// A1-A12 — the machine-checkable adjudication contract
// =============================================================================

const ABSENCE_SUBJECT = 'capability:on-disk-matcher-cache'
const TYPED_ABSENCE_CHANNELS = [
  {
    channel: '.evidence.answerability.unresolved_subjects[]',
    shape: 'typed_record',
    status_field: 'status',
    status_values: ['not_found', 'absent', 'missing', 'unsupported', 'unresolved'],
    subject_field: 'subject_id',
    subject_values: [ABSENCE_SUBJECT, 'capability:encryption-at-rest'],
  },
]
const ABSENCE_PROBE = {
  id: 'synthetic-absence-probe',
  prompt: { text: 'Where does this framework persist compiled route matchers to disk?' },
  ground_truth: 'nothing persists',
  required_behaviour: ['The artifact must state that no on-disk matcher cache exists.'],
}
const ABSENCE_ENTRY = [{
  id: 'ADJ-SYN-ABSENCE',
  predicate: { kind: 'required_typed_absence', params: { subject_id: ABSENCE_SUBJECT, accepted_channels: TYPED_ABSENCE_CHANNELS, prohibited_substitutions: null } },
}]

/** An artifact carrying an approved typed absence record for `subject`. */
const withTypedAbsence = (subject, status = 'not_found') => ({
  evidence: { answerability: { state: 'verify_targets', unresolved_subjects: [{ subject_id: subject, status }] } },
})

// --- A1: an affirmative sentence containing a negation is not absence --------
{
  const trap = evaluateSyntheticProbe({
    probe: ABSENCE_PROBE, entries: ABSENCE_ENTRY,
    artifact: { claims: [{ text: 'There is no doubt that an on-disk matcher cache exists.' }], evidence: { answerability: { state: 'verify_targets' } } },
  })
  check('A1', 'affirmative negation trap', 'sentence with a negation word', 'fail', trap.state,
    trap.reasons[0] ?? 'no reason recorded')
  check('A1', 'affirmative negation trap', 'exact reason', true,
    trap.reasons.some((reason) => reason.includes(MISSING_ABSENCE_DECLARATION)))
}

// --- A2: double negation is not absence --------------------------------------
{
  const trap = evaluateSyntheticProbe({
    probe: ABSENCE_PROBE, entries: ABSENCE_ENTRY,
    artifact: { evidence: { answerability: { state: 'verify_targets', caveats: ['The cache is not missing.'] } } },
  })
  check('A2', 'double negation trap', 'not missing', 'fail', trap.state, trap.reasons[0] ?? '')
}

// --- A4: arbitrary claim text is never typed authority -----------------------
{
  const trap = evaluateSyntheticProbe({
    probe: ABSENCE_PROBE, entries: ABSENCE_ENTRY,
    artifact: { claims: [{ text: 'No on-disk matcher cache exists in this repository.' }], evidence: { answerability: { state: 'verify_targets' } } },
  })
  check('A4', 'claims[].text is not typed authority', 'perfect sentence in the wrong channel', 'fail', trap.state,
    'a true sentence in a free-text channel still carries no status or subject field')
}

// --- A5: a truthful typed absence record satisfies the predicate -------------
{
  const truthful = evaluateSyntheticProbe({
    probe: ABSENCE_PROBE, entries: ABSENCE_ENTRY, artifact: withTypedAbsence(ABSENCE_SUBJECT),
  })
  check('A5', 'typed absence is honoured', 'approved typed record for the exact subject', 'pass', truthful.state,
    JSON.stringify(truthful.adjudication.clauses[0].observed.typed_declaration))
  check('A5', 'typed absence is honoured', 'recorded as observed', true,
    truthful.metrics.absence_declaration_observed)
}

// --- A6: a typed record for a different subject does not satisfy it ----------
{
  const wrong = evaluateSyntheticProbe({
    probe: ABSENCE_PROBE, entries: ABSENCE_ENTRY, artifact: withTypedAbsence('capability:encryption-at-rest'),
  })
  check('A6', 'wrong subject', 'typed absence for another subject', 'fail', wrong.state, wrong.reasons[0] ?? '')

  const wrongStatus = evaluateSyntheticProbe({
    probe: ABSENCE_PROBE, entries: ABSENCE_ENTRY, artifact: withTypedAbsence(ABSENCE_SUBJECT, 'present'),
  })
  check('A6', 'wrong subject', 'typed record with a non-absence status', 'fail', wrongStatus.state)
}

// --- A7: no qualifying declaration fails, and is never invalid ---------------
{
  const none = evaluateSyntheticProbe({
    probe: ABSENCE_PROBE, entries: ABSENCE_ENTRY,
    artifact: { evidence: { answerability: { state: 'verify_targets', missing_obligations: ['evidence:supporting'] } } },
  })
  check('A7', 'missing typed absence', 'valid run with no declaration', 'fail', none.state, none.reasons[0] ?? '')
  check('A7', 'missing typed absence', 'not invalid', false, none.state === 'invalid')
  check('A7', 'missing typed absence', 'exact reason', true,
    none.reasons.some((reason) => reason.includes(MISSING_ABSENCE_DECLARATION)))
}

// --- A3, A8, A9, A10: task-cell must-not-ready on typed records only ---------
{
  const ROUTER_REQUIREMENTS = [
    { id: 'req.construction-site', path: 'src/hono.ts', symbols: ['Hono.constructor'] },
    { id: 'req.smart-router', path: 'src/compose.ts', symbols: ['compose'] },
  ]
  const UNRESOLVED_CHANNELS = [{
    channel: '.evidence.answerability.unresolved_requirements[]',
    shape: 'typed_record',
    status_field: 'status',
    status_values: ['unresolved', 'missing'],
    subject_field: 'requirement_id',
    subject_values: ['req.construction-site', 'req.smart-router'],
  }]
  const truth = makeTruth({ must_not_report_ready_when: ['the relationship between the constructor in src/hono.ts and the routers is missing and is not declared as unresolved'] })
  const adjudication = syntheticAdjudication(
    [{ predicate: { kind: 'must_not_ready_when_requirements_missing', params: {
      requirement_ids: ['req.construction-site', 'req.smart-router'], match: 'any_missing',
      ready_states: ['ready', 'ready_with_caveat'], unresolved: { channels: UNRESOLVED_CHANNELS } } } }],
    { requirements: ROUTER_REQUIREMENTS },
  )
  const run = ({ paths, symbols, answerability, artifact }) => evaluateSynthetic({
    paths, symbols, answerability, truth, adjudication,
    artifact: artifact ?? { evidence: { answerability: { state: answerability } } },
  })

  // A8 — ready on missing frozen requirements, with no typed unresolved record.
  const falseReady = run({ paths: [], symbols: [], answerability: 'ready_with_caveat' })
  check('A8', 'task false-ready', 'ready_with_caveat on missing requirements', true, falseReady.metrics.false_ready,
    falseReady.adjudication.clauses[0].detail ?? '')
  check('A8', 'task false-ready', 'cell fails', 'fail', falseReady.state)

  // The opposite arm: requirements present, so nothing to enforce.
  const satisfied = run({ paths: ['src/hono.ts', 'src/compose.ts'], symbols: ['Hono.constructor', 'compose'], answerability: 'ready_with_caveat' })
  check('A8', 'task false-ready', 'requirements present', false, satisfied.metrics.false_ready)

  // A9 — EVERY missing requirement needs its own record. One record covering one
  // of two missing requirements leaves the other gap uncovered.
  const partiallyDeclared = run({
    paths: [], symbols: [], answerability: 'ready_with_caveat',
    artifact: { evidence: { answerability: { state: 'ready_with_caveat', unresolved_requirements: [{ requirement_id: 'req.construction-site', status: 'unresolved' }] } } },
  })
  check('A9', 'exact typed unresolved record', 'one of two missing requirements declared', true, partiallyDeclared.metrics.false_ready,
    partiallyDeclared.adjudication.clauses[0].detail ?? '')

  const fullyDeclared = run({
    paths: [], symbols: [], answerability: 'ready_with_caveat',
    artifact: { evidence: { answerability: { state: 'ready_with_caveat', unresolved_requirements: [
      { requirement_id: 'req.construction-site', status: 'unresolved' },
      { requirement_id: 'req.smart-router', status: 'unresolved' },
    ] } } },
  })
  check('A9', 'exact typed unresolved record', 'every missing requirement declared', false, fullyDeclared.metrics.false_ready,
    fullyDeclared.adjudication.clauses[0].detail ?? '')

  // A13 — a record for a requirement that is PRESENT cannot cover a different,
  // missing one. This is the defect the second review found.
  const wrongRequirement = evaluateSynthetic({
    paths: ['src/hono.ts'], symbols: ['Hono.constructor'], answerability: 'ready_with_caveat', truth, adjudication,
    artifact: { evidence: { answerability: { state: 'ready_with_caveat', unresolved_requirements: [{ requirement_id: 'req.construction-site', status: 'unresolved' }] } } },
  })
  check('A13', 'unresolved must name the missing requirement', 'record names the PRESENT requirement', true,
    wrongRequirement.metrics.false_ready, wrongRequirement.adjudication.clauses[0].detail ?? '')

  const rightRequirement = evaluateSynthetic({
    paths: ['src/hono.ts'], symbols: ['Hono.constructor'], answerability: 'ready_with_caveat', truth, adjudication,
    artifact: { evidence: { answerability: { state: 'ready_with_caveat', unresolved_requirements: [{ requirement_id: 'req.smart-router', status: 'unresolved' }] } } },
  })
  check('A13', 'unresolved must name the missing requirement', 'record names the MISSING requirement', false,
    rightRequirement.metrics.false_ready)

  // A10 — an affirmative claim naming the missing file does not suppress it.
  const affirmative = run({
    paths: [], symbols: [], answerability: 'ready_with_caveat',
    artifact: { claims: [{ text: 'Supporting evidence for src/hono.ts is available.' }], evidence: { answerability: { state: 'ready_with_caveat' } } },
  })
  check('A10', 'affirmative claim cannot suppress', 'claims[].text naming the missing file', true, affirmative.metrics.false_ready,
    affirmative.adjudication.clauses[0].detail ?? '')

  // A3 — the same sentence must not read as an unresolved declaration anywhere.
  check('A3', 'affirmative mention is not unresolved', 'cell still fails', 'fail', affirmative.state)

  // A typed record for a DIFFERENT requirement than the missing one still has to
  // be an approved subject value; an unknown subject cannot suppress.
  const wrongSubject = run({
    paths: [], symbols: [], answerability: 'ready_with_caveat',
    artifact: { evidence: { answerability: { state: 'ready_with_caveat', unresolved_requirements: [{ requirement_id: 'req.not-declared', status: 'unresolved' }] } } },
  })
  check('A9', 'exact typed unresolved record', 'unknown requirement id does not suppress', true, wrongSubject.metrics.false_ready)
}

// --- A11: clause hash drift refuses the contract -----------------------------
{
  const copyRoot = mkdtempSync(join(tmpdir(), 'madar-tier1-a11-'))
  cpSync(join(ROOT, 'docs'), join(copyRoot, 'docs'), { recursive: true })

  const clean = loadAdjudication(copyRoot)
  check('A11', 'clause hash drift', 'unmodified copy loads', 0, clean.problems.length,
    clean.problems.slice(0, 2).join('; '))

  // Reword one frozen clause WITHOUT updating the adjudication contract.
  const truthPath = join(copyRoot, 'docs/qualification/truth/impact-hono-drop-router-fallback.json')
  const truth = JSON.parse(readFileSync(truthPath, 'utf8'))
  truth.tier1_obligations.must_not_report_ready_when[0] = 'the relationship is missing (reworded)'
  writeFileSync(truthPath, `${JSON.stringify(truth, null, 2)}\n`)

  const drifted = loadAdjudication(copyRoot)
  check('A11', 'clause hash drift', 'reworded clause refuses', true,
    drifted.problems.some((problem) => problem.includes('adjudication_contract_mismatch') && problem.includes('clause text changed')),
    drifted.problems.find((problem) => problem.includes('clause text changed')) ?? 'no mismatch recorded')
  rmSync(copyRoot, { recursive: true, force: true })
}

// --- A12: unknown, duplicate, missing and unused mappings all fail closed -----
{
  const copyRoot = mkdtempSync(join(tmpdir(), 'madar-tier1-a12-'))
  cpSync(join(ROOT, 'docs'), join(copyRoot, 'docs'), { recursive: true })
  const contractPath = join(copyRoot, 'docs/qualification/tier1-adjudication.json')
  const original = JSON.parse(readFileSync(contractPath, 'utf8'))

  const mutate = (fn) => {
    const copy = JSON.parse(JSON.stringify(original))
    fn(copy)
    writeFileSync(contractPath, `${JSON.stringify(copy, null, 2)}\n`)
    return loadAdjudication(copyRoot, { requiredClauses: REQUIRED_CLAUSES })
  }

  check('A12', 'contract integrity', 'unmodified contract is complete', 0,
    loadAdjudication(copyRoot, { requiredClauses: REQUIRED_CLAUSES }).problems.length)

  const unknown = mutate((c) => { c.entries[0].predicate.kind = 'prose_matches' })
  check('A12', 'contract integrity', 'unknown predicate kind', true,
    unknown.problems.some((p) => p.includes('unknown predicate kind')), unknown.problems[0] ?? '')

  const duplicate = mutate((c) => { c.entries.push({ ...c.entries[0], id: 'ADJ-DUPLICATE' }) })
  check('A12', 'contract integrity', 'two entries for one clause', true,
    duplicate.problems.some((p) => p.includes('more than one adjudication entry')), duplicate.problems[0] ?? '')

  const missing = mutate((c) => { c.entries.splice(0, 1) })
  check('A12', 'contract integrity', 'clause with no entry', true,
    missing.problems.some((p) => p.includes('has no adjudication entry')), missing.problems[0] ?? '')

  const unused = mutate((c) => {
    c.entries.push({ id: 'ADJ-ORPHAN', source: { file: 'docs/qualification/tier1.json', pointer: '/purpose', clause_sha256: 'x' }, predicate: { kind: 'answerability_not_in', params: { states: ['ready'] } } })
  })
  check('A12', 'contract integrity', 'entry binding a non-Tier-1 clause', true,
    unused.problems.length > 0, unused.problems[0] ?? '')

  const malformed = mutate((c) => {
    const entry = c.entries.find((e) => e.predicate.kind === 'must_not_ready_when_requirements_missing')
    entry.predicate.params.match = 'whatever'
  })
  check('A12', 'contract integrity', 'malformed predicate parameters', true,
    malformed.problems.some((p) => p.includes('malformed parameters')), malformed.problems[0] ?? '')

  const unknownRequirement = mutate((c) => {
    const entry = c.entries.find((e) => e.predicate.kind === 'must_not_ready_when_requirements_missing')
    entry.predicate.params.requirement_ids = ['req.does-not-exist']
  })
  check('A12', 'contract integrity', 'unknown requirement identity', true,
    unknownRequirement.problems.some((p) => p.includes('unknown requirement identity')), unknownRequirement.problems[0] ?? '')

  const driftedRequirement = mutate((c) => { c.requirements[0].identity_sha256 = '0'.repeat(64) })
  check('A12', 'contract integrity', 'requirement identity drift', true,
    driftedRequirement.problems.some((p) => p.includes('identity changed')), driftedRequirement.problems[0] ?? '')

  rmSync(copyRoot, { recursive: true, force: true })
}


// --- A14: a gap status is not an absence assertion ---------------------------
// "unresolved" and "missing" say the pack did not establish something. The
// frozen probes require the artifact to state the behaviour is NOT THERE.
{
  const absenceOnly = [{
    channel: '.evidence.answerability.unresolved_subjects[]',
    shape: 'typed_record', status_field: 'status',
    status_values: ['not_found', 'absent', 'does_not_exist', 'unsupported'],
    subject_field: 'subject_id', subject_values: [ABSENCE_SUBJECT],
  }]
  const entries = [{ id: 'ADJ-SYN-ABS', predicate: { kind: 'required_typed_absence', params: { subject_id: ABSENCE_SUBJECT, accepted_channels: absenceOnly, prohibited_substitutions: null } } }]
  const withStatus = (status) => evaluateSyntheticProbe({
    probe: ABSENCE_PROBE, entries,
    artifact: { evidence: { answerability: { state: 'verify_targets', unresolved_subjects: [{ subject_id: ABSENCE_SUBJECT, status }] } } },
  })
  for (const status of ['unresolved', 'missing', 'unknown', 'not_established']) {
    check('A14', 'gap status is not absence', `status '${status}'`, 'fail', withStatus(status).state)
  }
  for (const status of ['not_found', 'absent', 'does_not_exist', 'unsupported']) {
    check('A14', 'gap status is not absence', `status '${status}'`, 'pass', withStatus(status).state)
  }

  // The real frozen contract must use the disjoint vocabularies.
  const contract = JSON.parse(readFileSync(join(ROOT, 'docs/qualification/tier1-adjudication.json'), 'utf8'))
  const absence = new Set(contract.status_vocabularies.absence)
  const unresolved = new Set(contract.status_vocabularies.unresolved)
  check('A14', 'gap status is not absence', 'vocabularies are disjoint', 0,
    [...absence].filter((value) => unresolved.has(value)).length,
    `absence=${JSON.stringify([...absence])} unresolved=${JSON.stringify([...unresolved])}`)
  for (const entry of contract.entries.filter((e) => e.predicate.kind === 'required_typed_absence')) {
    for (const channel of entry.predicate.params.accepted_channels.filter((c) => c.shape === 'typed_record')) {
      check('A14', 'gap status is not absence', `${entry.id} accepts no gap status`, 0,
        channel.status_values.filter((value) => unresolved.has(value)).length)
    }
  }
}

// --- A15: every typed channel the contract reads is a classified channel ------
// If a declaration channel is not in the evidence registry, the closure guard
// invalidates the cell before adjudication ever runs, making the predicate
// unsatisfiable in practice.
{
  const contract = JSON.parse(readFileSync(join(ROOT, 'docs/qualification/tier1-adjudication.json'), 'utf8'))
  const declared = new Set()
  for (const entry of contract.entries) {
    const params = entry.predicate.params
    for (const channel of params.accepted_channels ?? []) declared.add(channel)
    for (const channel of params.unresolved?.channels ?? []) declared.add(channel)
  }
  let unclassified = 0
  const details = []
  for (const spec of declared) {
    // Build a minimal artifact that actually exercises the channel, then check
    // the evidence registry classifies every field it produces.
    const segments = spec.channel.replace(/^\./, '').replace(/\[\]$/, '').split('.')
    const leaf = spec.shape === 'typed_record'
      ? [{ [spec.status_field]: spec.status_values[0], [spec.subject_field]: spec.subject_values[0] }]
      : [spec.subject_tokens[0]]
    let node = leaf
    for (let index = segments.length - 1; index >= 1; index -= 1) node = { [segments[index]]: node }
    const artifact = { [segments[0]]: node }
    const observed = extractEvidence(artifact)
    if (observed.unclassified.length > 0) {
      unclassified += 1
      details.push(`${spec.channel} -> ${observed.unclassified.map((u) => u.channel).join(', ')}`)
    }
  }
  check('A15', 'declaration channels are classified', 'every contract channel survives the closure guard', 0,
    unclassified, details.join(' | '))
  check('A15', 'declaration channels are classified', 'the contract declares at least one channel', true, declared.size > 0)
}

// =============================================================================
// REL1-REL18 — the relationship model
// =============================================================================
//
// Endpoints are resolved to node records and compared on path AND symbol.
// Direction and relation kind are enforced. The impact group is all-of. Only an
// exact typed record naming a relationship id may declare it unresolved, and
// only where the frozen clause offers that alternative.

const REL_ADAPTERS = [
  {
    channel: '.pack.relationships[]',
    source_field: 'from', target_field: 'to', relation_field: 'relation',
    source_id_field: 'from_id', target_id_field: 'to_id',
    semantic_direction: 'source_to_target', endpoint_resolution: 'node_id',
    node_record_channels: ['.pack.matched_nodes[]'],
  },
]

const relSelector = (path, symbols) => ({ path, symbols })
const REL_FLOW = {
  id: 'relationship:flow:dispatch-calls-compose',
  source_selector: relSelector('src/hono-base.ts', ['Hono.#dispatch']),
  target_selector: relSelector('src/compose.ts', ['compose']),
  direction: 'forward', topology: 'direct_edge', relation_kinds: ['calls'],
  required_edge_count: 1, unresolved_subject_id: 'relationship:flow:dispatch-calls-compose',
}
const REL_ROOT = { ...REL_FLOW, id: 'relationship:rootcause:dispatch-calls-compose', unresolved_subject_id: null }
const REL_ARCH = {
  id: 'relationship:arch:create-storage-to-driver',
  source_selector: relSelector('src/storage.ts', ['createStorage']),
  target_selector: relSelector('src/types.ts', ['Driver']),
  direction: 'forward', topology: 'direct_edge',
  relation_kinds: ['param_type', 'uses', 'references', 'depends_on'],
  required_edge_count: 1, unresolved_subject_id: 'relationship:arch:create-storage-to-driver',
}
const REL_IMPACT = ['smart-router', 'regexp-router', 'trie-router'].map((slug, index) => ({
  id: `relationship:impact:hono-constructor-calls-${slug}`,
  source_selector: relSelector('src/hono.ts', ['Hono.constructor']),
  target_selector: relSelector(
    ['src/router/smart-router/router.ts', 'src/router/reg-exp-router/router.ts', 'src/router/trie-router/router.ts'][index],
    [['SmartRouter', 'RegExpRouter', 'TrieRouter'][index]],
  ),
  direction: 'forward', topology: 'direct_edge', relation_kinds: ['calls'],
  required_edge_count: 1, unresolved_subject_id: `relationship:impact:hono-constructor-calls-${slug}`,
}))

/** Build an artifact with node records and typed edges. */
function relArtifact({ nodes = [], edges = [], answerability = 'ready_with_caveat', unresolved = [] }) {
  return {
    pack: {
      matched_nodes: nodes.map((n, i) => ({ node_id: `n${i}`, label: n.label, source_file: n.file })),
      relationships: edges.map((e) => ({
        from: e.from, to: e.to, relation: e.relation,
        from_id: `n${nodes.findIndex((n) => n.label === e.from && (!e.fromFile || n.file === e.fromFile))}`,
        to_id: `n${nodes.findIndex((n) => n.label === e.to && (!e.toFile || n.file === e.toFile))}`,
      })),
    },
    evidence: { answerability: { state: answerability, unresolved_relationships: unresolved } },
  }
}

function relAdjudication(relationships, { policy = 'exact_per_relationship' } = {}) {
  const byClause = new Map()
  byClause.set('synthetic-truth.json#/tier1_obligations/must_not_report_ready_when/0', {
    id: 'ADJ-REL', source: { file: 'synthetic-truth.json', pointer: '/tier1_obligations/must_not_report_ready_when/0', clause_sha256: 'unit' },
    predicate: { kind: 'must_not_ready_when_relationships_missing', params: {
      relationship_ids: relationships.map((r) => r.id),
      group_match: 'all_required', ready_states: ['ready', 'ready_with_caveat'],
      unresolved_policy: policy,
      unresolved_channels: policy === 'exact_per_relationship' ? [{
        channel: '.evidence.answerability.unresolved_relationships[]',
        shape: 'typed_record', status_field: 'status', status_values: ['unresolved', 'missing'],
        subject_field: 'relationship_id', subject_values: relationships.map((r) => r.id),
      }] : null,
    } },
  })
  return { contract: { adjudication_version: 2 }, digest: 'unit', byClause,
    requirementsById: new Map(), relationshipsById: new Map(relationships.map((r) => [r.id, r])),
    adapters: REL_ADAPTERS, problems: [] }
}

function relRun(relationships, artifact, options = {}) {
  return evaluateTaskCell({
    cell: { cell_id: 'rel@fixture' }, task: { id: 'rel' }, target: { id: 'fixture', source: { ref: 'x' } },
    truth: { tier1_obligations: { required_evidence_paths: [], required_evidence_symbols: [], min_critical_fact_recall: 1.0, must_not_report_ready_when: ['relationship clause'] } },
    truthFile: 'synthetic-truth.json', preparation: { valid: true },
    artifact, evidence: makeEvidence({ paths: [], symbols: [] }),
    answerability: artifact.evidence.answerability.state, targetDir: fixtureDir,
    adjudication: relAdjudication(relationships, options),
  })
}

const DISPATCH_NODES = [{ label: 'Hono.#dispatch', file: 'src/hono-base.ts' }, { label: 'compose', file: 'src/compose.ts' }]
const relOf = (verdict) => verdict.adjudication.relationships

// --- REL1: isolated endpoints ------------------------------------------------
{
  const v = relRun([REL_FLOW], relArtifact({ nodes: DISPATCH_NODES, edges: [] }))
  check('REL1', 'isolated endpoints', 'both endpoints visible, no edge', true, v.metrics.false_ready,
    v.adjudication.clauses[0].detail ?? '')
  check('REL1', 'isolated endpoints', 'reported missing', 1, relOf(v).missing_relationship_ids.length)
}

// --- REL2: reverse edge ------------------------------------------------------
{
  const reverse = relArtifact({ nodes: DISPATCH_NODES, edges: [{ from: 'compose', to: 'Hono.#dispatch', relation: 'calls' }] })
  check('REL2', 'reverse edge', 'flow not satisfied', true, relRun([REL_FLOW], reverse).metrics.false_ready)
  check('REL2', 'reverse edge', 'root cause not satisfied', true, relRun([REL_ROOT], reverse, { policy: 'forbidden' }).metrics.false_ready)
}

// --- REL3: wrong relation ----------------------------------------------------
{
  const v = relRun([REL_FLOW], relArtifact({ nodes: DISPATCH_NODES, edges: [{ from: 'Hono.#dispatch', to: 'compose', relation: 'references' }] }))
  check('REL3', 'wrong relation', 'references does not satisfy calls', true, v.metrics.false_ready,
    v.adjudication.clauses[0].detail ?? '')
}

// --- REL4: exact flow edge ---------------------------------------------------
{
  const v = relRun([REL_FLOW], relArtifact({ nodes: DISPATCH_NODES, edges: [{ from: 'Hono.#dispatch', to: 'compose', relation: 'calls' }] }))
  check('REL4', 'exact flow edge', 'satisfied', false, v.metrics.false_ready)
  check('REL4', 'exact flow edge', 'reported present', 1, relOf(v).present_relationship_ids.length)
}

// --- REL5: wrong flow source -------------------------------------------------
{
  const nodes = [...DISPATCH_NODES, { label: 'Hono.fetch', file: 'src/hono-base.ts' }]
  const v = relRun([REL_FLOW], relArtifact({ nodes, edges: [{ from: 'Hono.fetch', to: 'compose', relation: 'calls' }] }))
  check('REL5', 'wrong flow source', 'Hono.fetch does not satisfy Hono.#dispatch', true, v.metrics.false_ready)
}

// --- REL6: same label, wrong file --------------------------------------------
{
  const nodes = [{ label: 'Hono.#dispatch', file: 'src/hono-base.ts' }, { label: 'compose', file: 'src/other/compose.ts' }]
  const v = relRun([REL_FLOW], relArtifact({ nodes, edges: [{ from: 'Hono.#dispatch', to: 'compose', relation: 'calls' }] }))
  check('REL6', 'same label, wrong file', 'endpoint not satisfied', true, v.metrics.false_ready)

  const right = relRun([REL_FLOW], relArtifact({ nodes: DISPATCH_NODES, edges: [{ from: 'Hono.#dispatch', to: 'compose', relation: 'calls' }] }))
  check('REL6', 'same label, wrong file', 'correct file is satisfied', false, right.metrics.false_ready)
}

// --- REL7-REL10: impact cardinality ------------------------------------------
{
  const impactNodes = [
    { label: 'Hono.constructor', file: 'src/hono.ts' },
    { label: 'SmartRouter', file: 'src/router/smart-router/router.ts' },
    { label: 'RegExpRouter', file: 'src/router/reg-exp-router/router.ts' },
    { label: 'TrieRouter', file: 'src/router/trie-router/router.ts' },
  ]
  const edge = (to, relation = 'calls') => ({ from: 'Hono.constructor', to, relation })

  const one = relRun(REL_IMPACT, relArtifact({ nodes: impactNodes, edges: [edge('SmartRouter')] }))
  check('REL7', 'impact one of three', 'false-ready remains', true, one.metrics.false_ready)
  check('REL7', 'impact one of three', 'two still missing', 2, relOf(one).missing_relationship_ids.length)

  const two = relRun(REL_IMPACT, relArtifact({ nodes: impactNodes, edges: [edge('SmartRouter'), edge('RegExpRouter')] }))
  check('REL8', 'impact two of three', 'third still reported', 1, relOf(two).missing_relationship_ids.length)
  check('REL8', 'impact two of three', 'false-ready remains', true, two.metrics.false_ready)

  const all = relRun(REL_IMPACT, relArtifact({ nodes: impactNodes, edges: [edge('SmartRouter'), edge('RegExpRouter'), edge('TrieRouter')] }))
  check('REL9', 'impact all three', 'group satisfied', false, all.metrics.false_ready)
  check('REL9', 'impact all three', 'all present', 3, relOf(all).present_relationship_ids.length)

  const wrongKind = relRun(REL_IMPACT, relArtifact({ nodes: impactNodes, edges: [edge('SmartRouter', 'references'), edge('RegExpRouter', 'references'), edge('TrieRouter', 'references')] }))
  check('REL10', 'wrong impact edge kind', 'references does not satisfy', true, wrongKind.metrics.false_ready)
  const reversed = relRun(REL_IMPACT, relArtifact({ nodes: impactNodes, edges: [
    { from: 'SmartRouter', to: 'Hono.constructor', relation: 'calls' },
    { from: 'RegExpRouter', to: 'Hono.constructor', relation: 'calls' },
    { from: 'TrieRouter', to: 'Hono.constructor', relation: 'calls' }] }))
  check('REL10', 'wrong impact edge kind', 'reverse calls does not satisfy', true, reversed.metrics.false_ready)

  // --- REL11: an exact typed record covers only its own edge
  const oneDeclared = relRun(REL_IMPACT, relArtifact({
    nodes: impactNodes, edges: [edge('SmartRouter'), edge('RegExpRouter')],
    unresolved: [{ relationship_id: 'relationship:impact:hono-constructor-calls-trie-router', status: 'unresolved' }],
  }))
  check('REL11', 'exact unresolved edge', 'covers the one missing edge', false, oneDeclared.metrics.false_ready,
    JSON.stringify(relOf(oneDeclared).exactly_unresolved_relationship_ids))

  // --- REL12: a record for another edge cannot cover this one
  const wrongEdgeRecord = relRun(REL_IMPACT, relArtifact({
    nodes: impactNodes, edges: [edge('SmartRouter'), edge('RegExpRouter')],
    unresolved: [{ relationship_id: 'relationship:impact:hono-constructor-calls-smart-router', status: 'unresolved' }],
  }))
  check('REL12', 'unresolved wrong edge', 'SmartRouter record cannot cover TrieRouter', true, wrongEdgeRecord.metrics.false_ready,
    JSON.stringify(relOf(wrongEdgeRecord).uncovered_relationship_ids))

  // --- REL13: an endpoint-level record is not a relationship-level record
  for (const subject of ['Hono.constructor', 'TrieRouter', 'src/router/trie-router/router.ts', 'impact.affected_set.trie-router-unreachable']) {
    const endpointOnly = relRun(REL_IMPACT, relArtifact({
      nodes: impactNodes, edges: [edge('SmartRouter'), edge('RegExpRouter')],
      unresolved: [{ relationship_id: subject, status: 'unresolved' }],
    }))
    check('REL13', 'endpoint unresolved is insufficient', `subject ${subject}`, true, endpointOnly.metrics.false_ready)
  }

  // --- REL14: a synthetic arrow token is not a declared subject
  const arrow = relRun(REL_IMPACT, relArtifact({
    nodes: impactNodes, edges: [edge('SmartRouter'), edge('RegExpRouter')],
    unresolved: [{ relationship_id: 'Hono.constructor->TrieRouter', status: 'unresolved' }],
  }))
  check('REL14', 'synthetic arrow rejected', 'from->to token does not cover', true, arrow.metrics.false_ready)
}

// --- REL15: root cause accepts no unresolved record --------------------------
{
  const declared = relRun([REL_ROOT], relArtifact({
    nodes: DISPATCH_NODES, edges: [],
    unresolved: [{ relationship_id: 'relationship:rootcause:dispatch-calls-compose', status: 'unresolved' }],
  }), { policy: 'forbidden' })
  check('REL15', 'root-cause unresolved forbidden', 'exact record does not suppress', true, declared.metrics.false_ready,
    declared.adjudication.clauses[0].detail ?? '')

  const satisfied = relRun([REL_ROOT], relArtifact({ nodes: DISPATCH_NODES, edges: [{ from: 'Hono.#dispatch', to: 'compose', relation: 'calls' }] }), { policy: 'forbidden' })
  check('REL15', 'root-cause unresolved forbidden', 'a real edge does satisfy it', false, satisfied.metrics.false_ready)
}

// --- REL16: arch structural relations ----------------------------------------
{
  const archNodes = [{ label: 'createStorage', file: 'src/storage.ts' }, { label: 'Driver', file: 'src/types.ts' }]
  for (const relation of ['param_type', 'uses', 'references', 'depends_on']) {
    const v = relRun([REL_ARCH], relArtifact({ nodes: archNodes, edges: [{ from: 'createStorage', to: 'Driver', relation }] }))
    check('REL16', 'arch structural relation', `relation ${relation} accepted`, false, v.metrics.false_ready)
  }
  const reverse = relRun([REL_ARCH], relArtifact({ nodes: archNodes, edges: [{ from: 'Driver', to: 'createStorage', relation: 'uses' }] }))
  check('REL16', 'arch structural relation', 'reverse rejected', true, reverse.metrics.false_ready)
  const unrelated = relRun([REL_ARCH], relArtifact({ nodes: archNodes, edges: [{ from: 'createStorage', to: 'Driver', relation: 'contains' }] }))
  check('REL16', 'arch structural relation', 'unrelated relation rejected', true, unrelated.metrics.false_ready)
}

// --- REL17: adjacency-only channels prove nothing ----------------------------
{
  const adjacency = {
    pack: {
      matched_nodes: [{ node_id: 'n0', label: 'Hono.#dispatch', source_file: 'src/hono-base.ts' }, { node_id: 'n1', label: 'compose', source_file: 'src/compose.ts' }],
      execution_slice: { steps: [{ label: 'Hono.#dispatch', source_file: 'src/hono-base.ts' }, { label: 'compose', source_file: 'src/compose.ts' }] },
      top_paths_per_community: [{ label: 'c', path: ['Hono.#dispatch', 'compose'] }],
      direct_dependents: [{ label: 'compose', source_file: 'src/compose.ts', relation: 'calls' }],
      target: 'Hono.#dispatch',
    },
    evidence: { answerability: { state: 'ready_with_caveat' } },
  }
  const v = relRun([REL_FLOW], adjacency)
  check('REL17', 'adjacency proves nothing', 'consecutive steps are not an edge', true, v.metrics.false_ready,
    `${relOf(v).typed_edges_observed} typed edge(s) observed`)
  check('REL17', 'adjacency proves nothing', 'no typed edge extracted', 0, relOf(v).typed_edges_observed)

  // The same two nodes, now joined by a declared typed channel.
  const typed = relRun([REL_FLOW], relArtifact({ nodes: DISPATCH_NODES, edges: [{ from: 'Hono.#dispatch', to: 'compose', relation: 'calls' }] }))
  check('REL17', 'adjacency proves nothing', 'a typed edge does count', false, typed.metrics.false_ready)
}

// --- REL18: relationship contract drift --------------------------------------
{
  const copyRoot = mkdtempSync(join(tmpdir(), 'madar-tier1-rel18-'))
  cpSync(join(ROOT, 'docs'), join(copyRoot, 'docs'), { recursive: true })
  const contractPath = join(copyRoot, 'docs/qualification/tier1-adjudication.json')
  const original = readFileSync(contractPath, 'utf8')
  const baseDigest = createHash('sha256').update(original).digest('hex')

  const mutate = (fn) => {
    const copy = JSON.parse(original)
    fn(copy)
    writeFileSync(contractPath, `${JSON.stringify(copy, null, 2)}\n`)
    const loaded = loadAdjudication(copyRoot, { requiredClauses: REQUIRED_CLAUSES })
    return { loaded, digest: createHash('sha256').update(readFileSync(contractPath, 'utf8')).digest('hex') }
  }

  const clean = loadAdjudication(copyRoot, { requiredClauses: REQUIRED_CLAUSES })
  check('REL18', 'relationship contract drift', 'unmodified copy loads', 0, clean.problems.length,
    clean.problems.slice(0, 2).join('; '))

  for (const [name, fn, expectProblem] of [
    ['direction', (c) => { c.relationship_requirements[0].direction = 'either' }, true],
    ['relation kinds emptied', (c) => { c.relationship_requirements[0].relation_kinds = [] }, true],
    ['cardinality', (c) => { c.relationship_requirements[0].required_edge_count = 0 }, true],
    ['endpoint path', (c) => { c.relationship_requirements[0].source_selector.path = 'src/elsewhere.ts' }, false],
    ['unresolved subject', (c) => { c.relationship_requirements[0].unresolved_subject_id = 'relationship:something-else' }, true],
    ['unknown field', (c) => { c.relationship_requirements[0].fuzzy = true }, true],
    ['duplicate id', (c) => { c.relationship_requirements.push({ ...c.relationship_requirements[0] }) }, true],
    ['unknown relationship reference', (c) => { const e = c.entries.find((x) => x.predicate.kind === 'must_not_ready_when_relationships_missing'); e.predicate.params.relationship_ids = ['relationship:nope'] }, true],
    ['unsupported topology', (c) => { c.relationship_requirements[0].topology = 'transitive_path' }, true],
    ['adapter without relation field', (c) => { delete c.relationship_channels[0].relation_field }, true],
  ]) {
    const { loaded, digest } = mutate(fn)
    check('REL18', 'relationship contract drift', `${name} changes the digest`, true, digest !== baseDigest)
    if (expectProblem) {
      check('REL18', 'relationship contract drift', `${name} is refused`, true,
        loaded.problems.some((problem) => problem.includes('adjudication_contract_mismatch')),
        loaded.problems[0] ?? 'no mismatch recorded')
    }
  }
  writeFileSync(contractPath, original)
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
