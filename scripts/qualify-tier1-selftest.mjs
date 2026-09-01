#!/usr/bin/env node
// Bounded falsifiability controls for the Tier 1 evaluator (E1-E15, S1-S4).
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
import { extractDeclarations, extractEvidence, probeSubjectTerms } from './lib/qualify-tier1/artifact.mjs'
import { MISSING_ABSENCE_DECLARATION, evaluateProbe, evaluateTaskCell } from './lib/qualify-tier1/evaluate.mjs'
import { prepareTarget, symbolExistsInTarget } from './lib/qualify-tier1/targets.mjs'

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

function evaluateSynthetic({ paths, symbols, snippets = [], declarations = [], answerability = 'verify_targets', truth = makeTruth() }) {
  return evaluateTaskCell({
    cell: { cell_id: 'synthetic@fixture', task_id: 'synthetic', target_id: 'fixture' },
    task: { id: 'synthetic', prompt: { text: 'x', sha256: 'x' } },
    target: { id: 'fixture', source: { ref: 'x' } },
    truth,
    preparation: { valid: true },
    artifact: { evidence: { answerability: { state: answerability, missing_obligations: [], verification_targets: [] } } },
    evidence: makeEvidence({ paths, symbols, snippets }),
    declarations,
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


// --- E7: removing an observable absence declaration must break the probe -----
// The frozen negative probes require the artifact to DECLARE that the requested
// behaviour was not found. Attempt 1 recorded that requirement as unobservable
// and still returned `pass`. Both arms below are run against the same probe, so
// the only difference is whether the declaration is present.
{
  const probe = {
    id: 'synthetic-absence-probe',
    prompt: { text: 'How does this library encrypt values at rest before writing them through a backend?' },
    ground_truth: 'There is no cryptography anywhere in src/.',
    required_behaviour: [
      'The artifact must not report a ready state.',
      'The artifact must declare that the requested behaviour was not found.',
      'No fabricated path or symbol may appear in the evidence set.',
    ],
  }
  const evidence = makeEvidence({ paths: REAL_PATHS, symbols: ['compose'] })
  const truthful = [{ schema_path: '.evidence.answerability.caveats[]', channel: '.evidence.answerability.caveats[]', text: 'No encrypt or backend key-management behaviour was found in this repository.' }]

  const withDeclaration = evaluateProbe({
    probe, evidence, declarations: truthful, answerability: 'verify_targets', targetDir: fixtureDir, relabelCandidates: [],
  })
  check('E7', 'observable absence declaration', 'declaration present', 'pass', withDeclaration.state,
    `matched ${JSON.stringify(withDeclaration.observed.absence_declaration.matches.map((entry) => entry.term))}`)
  check('E7', 'observable absence declaration', 'declaration present (observed)', true,
    withDeclaration.observed.absence_declaration.observed)

  // Remove the declaration from an otherwise identical truthful result.
  const withoutDeclaration = evaluateProbe({
    probe, evidence, declarations: [], answerability: 'verify_targets', targetDir: fixtureDir, relabelCandidates: [],
  })
  check('E7', 'observable absence declaration', 'declaration removed', 'fail', withoutDeclaration.state,
    withoutDeclaration.reasons[0] ?? 'no reason recorded')
  check('E7', 'observable absence declaration', 'declaration removed (exact reason)', true,
    withoutDeclaration.reasons.some((reason) => reason.startsWith(MISSING_ABSENCE_DECLARATION)))

  // A declaration that talks only about the pack's own coverage is not a
  // declaration about the requested behaviour.
  const genericOnly = evaluateProbe({
    probe,
    evidence,
    declarations: [
      { schema_path: '.evidence.answerability.missing_obligations[]', channel: '.evidence.answerability.missing_obligations[]', text: 'evidence:supporting' },
      { schema_path: '.negative_guidance[]', channel: '.negative_guidance[]', text: 'Do not assume missing required evidence is covered: supporting.' },
    ],
    answerability: 'verify_targets', targetDir: fixtureDir, relabelCandidates: [],
  })
  check('E7', 'observable absence declaration', 'generic coverage prose only', 'fail', genericOnly.state,
    genericOnly.reasons[0] ?? 'no reason recorded')
}

// --- E8: a task cell raised to a ready state on missing evidence -------------
// The frozen must_not_report_ready_when contract is not limited to the negative
// probes. Attempt 1 reported impact-hono at `ready_with_caveat` with 0/4
// required paths and a false-ready count of zero.
{
  // The clause names required evidence of this cell, which is what makes it
  // decidable at all — see E14 for the case where it does not.
  const relationshipTruth = makeTruth({
    must_not_report_ready_when: [
      'the call from the dispatch entry point in src/hono-base.ts into compose in src/compose.ts is neither present in the graph nor declared as unresolved',
    ],
  })

  // Not ready: the clause is vacuously satisfied, so false-ready must be false.
  const notReady = evaluateSynthetic({ paths: [], symbols: [], answerability: 'verify_targets', truth: relationshipTruth })
  check('E8', 'task-cell false ready', 'not a ready state', false, notReady.metrics.false_ready,
    notReady.ready_clauses.detail ?? '')

  // Ready with the required evidence present: nothing to enforce.
  const readyWithEvidence = evaluateSynthetic({
    paths: REAL_PATHS, symbols: ['compose', 'dispatch'], answerability: 'ready_with_caveat', truth: relationshipTruth,
  })
  check('E8', 'task-cell false ready', 'ready with required evidence', false, readyWithEvidence.metrics.false_ready,
    `state=${readyWithEvidence.state}`)

  // Ready with the required evidence missing and nothing declaring it
  // unresolved: this is the false-ready shape the frozen clause forbids.
  const readyWithoutEvidence = evaluateSynthetic({
    paths: [], symbols: [], answerability: 'ready_with_caveat', truth: relationshipTruth,
  })
  check('E8', 'task-cell false ready', 'ready_with_caveat on missing evidence', true, readyWithoutEvidence.metrics.false_ready,
    readyWithoutEvidence.reasons.find((reason) => reason.includes('must_not_report_ready_when')) ?? 'no clause reason recorded')
  check('E8', 'task-cell false ready', 'ready_with_caveat on missing evidence (cell fails)', 'fail', readyWithoutEvidence.state)

  // `ready` behaves the same way: both states are terminal for the consumer.
  const fullyReady = evaluateSynthetic({ paths: [], symbols: [], answerability: 'ready', truth: relationshipTruth })
  check('E8', 'task-cell false ready', 'ready on missing evidence', true, fullyReady.metrics.false_ready)

  // Declaring the gap as unresolved is the clause's own escape hatch, so the
  // control fires on the ready claim, not merely on the missing evidence.
  const declaredUnresolved = evaluateSynthetic({
    paths: [], symbols: [], answerability: 'ready_with_caveat', truth: relationshipTruth,
    declarations: [
      { schema_path: '.evidence.answerability.caveats[]', channel: '.evidence.answerability.caveats[]', text: 'src/compose.ts was not resolved in this pack.' },
    ],
  })
  check('E8', 'task-cell false ready', 'gap declared unresolved', false, declaredUnresolved.metrics.false_ready,
    declaredUnresolved.ready_clauses.undetermined[0] ?? '')
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

// --- E9: an unmeasured frozen requirement can never be represented as pass ----
{
  const probe = {
    id: 'synthetic-unmeasured-probe',
    prompt: { text: 'How does this library encrypt values at rest?' },
    ground_truth: 'nothing',
    required_behaviour: ['The artifact must hum a tune this evaluator cannot hear.'],
  }
  const verdict = evaluateProbe({
    probe, evidence: makeEvidence({ paths: REAL_PATHS, symbols: [] }), declarations: [],
    answerability: 'verify_targets', targetDir: fixtureDir, relabelCandidates: [],
  })
  check('E9', 'unmeasured requirement', 'clause with no observation', 'invalid', verdict.state,
    verdict.reasons[0] ?? 'no reason recorded')
  check('E9', 'unmeasured requirement', 'never pass', false, verdict.state === 'pass')

  // Replace it with a clause the evaluator does measure: the same run passes.
  const measurable = evaluateProbe({
    probe: { ...probe, required_behaviour: ['The artifact must not report a ready state.'] },
    evidence: makeEvidence({ paths: REAL_PATHS, symbols: [] }), declarations: [],
    answerability: 'verify_targets', targetDir: fixtureDir, relabelCandidates: [],
  })
  check('E9', 'unmeasured requirement', 'measurable clause', 'pass', measurable.state)
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

// --- E12: the real frozen probes yield stable subject terms -------------------
// The absence-declaration rule reads the frozen bytes, so its inputs must be a
// function of the contract and nothing else.
{
  const tier1 = JSON.parse(readFileSync(join(ROOT, 'docs/qualification/tier1.json'), 'utf8'))
  for (const probe of tier1.negative_trust_probes) {
    const first = probeSubjectTerms(probe.prompt.text)
    const second = probeSubjectTerms(probe.prompt.text)
    check('E12', 'probe subject terms', `${probe.id} deterministic`, JSON.stringify(first), JSON.stringify(second))
    check('E12', 'probe subject terms', `${probe.id} non-empty`, true, first.length > 0, JSON.stringify(first))
  }
  // Declarations are read from the artifact, so an artifact with none yields none.
  check('E12', 'probe subject terms', 'no declarations in an empty artifact', 0, extractDeclarations({}).length)
}


// --- E13: naming the subject is not declaring it absent ----------------------
// The declaration channels include affirmative prose. A string that mentions the
// probe's subject while asserting its PRESENCE is the opposite of the frozen
// requirement, and must not satisfy it.
{
  const probe = {
    id: 'synthetic-affirmative-probe',
    prompt: { text: 'Where does this framework persist compiled route matchers to disk, and how is that cache invalidated?' },
    ground_truth: 'nothing persists',
    required_behaviour: [
      'The artifact must not report a ready state.',
      'The artifact must state that no on-disk matcher cache exists.',
    ],
  }
  const evidence = makeEvidence({ paths: REAL_PATHS, symbols: [] })
  const call = (declarations) => evaluateProbe({
    probe, evidence, declarations, answerability: 'verify_targets', targetDir: fixtureDir, relabelCandidates: [],
  })

  const affirmative = call([{ schema_path: '.claims[0].text', channel: '.claims[].text', text: 'supporting evidence for the route matcher cache' }])
  check('E13', 'subject mention is not an absence declaration', 'affirmative claim naming the subject', 'fail', affirmative.state,
    affirmative.reasons[0] ?? 'no reason recorded')
  check('E13', 'subject mention is not an absence declaration', 'affirmative claim is recorded, not counted', 1,
    affirmative.observed.absence_declaration.subject_mentioned_without_asserting_absence.length)

  const declaring = call([{ schema_path: '.evidence.answerability.caveats[]', channel: '.evidence.answerability.caveats[]', text: 'No on-disk route matcher cache exists in this repository.' }])
  check('E13', 'subject mention is not an absence declaration', 'truthful absence declaration', 'pass', declaring.state,
    `matched ${JSON.stringify(declaring.observed.absence_declaration.matches.map((entry) => entry.term))}`)

  // Absence language about something else entirely is not a declaration either.
  const wrongSubject = call([{ schema_path: '.evidence.answerability.caveats[]', channel: '.evidence.answerability.caveats[]', text: 'No database migration evidence was found.' }])
  check('E13', 'subject mention is not an absence declaration', 'absence language, wrong subject', 'fail', wrongSubject.state)
}

// --- E14: a must-not-ready clause only bites on evidence it names -------------
// Substituting aggregate recall for the relationship a clause names is wrong in
// both directions: unrelated missing evidence would read as a violation, and a
// clause whose subject is present would still fire.
{
  const clause = 'the relationship between createStorage and the Driver interface is neither present in the graph nor declared as unresolved'
  const namedTruth = makeTruth({
    required_evidence_paths: [],
    required_evidence_symbols: ['createStorage', 'Driver'],
    must_not_report_ready_when: [clause],
  })
  const unrelatedTruth = makeTruth({
    required_evidence_paths: ['src/compose.ts', 'src/hono-base.ts'],
    required_evidence_symbols: [],
    must_not_report_ready_when: [clause],
  })

  // The clause names a required symbol that is missing: ready violates it.
  const named = evaluateSynthetic({ paths: [], symbols: [], answerability: 'ready', truth: namedTruth })
  check('E14', 'clause bites only on evidence it names', 'clause names the missing evidence', true, named.metrics.false_ready,
    named.ready_clauses.violated[0] ?? 'no clause violated')

  // The missing evidence is NOT what the clause is about: undetermined, not violated.
  const unrelated = evaluateSynthetic({ paths: ['src/compose.ts'], symbols: [], answerability: 'ready', truth: unrelatedTruth })
  check('E14', 'clause bites only on evidence it names', 'unrelated missing evidence', false, unrelated.metrics.false_ready,
    unrelated.ready_clauses.undetermined[0] ?? 'no undetermined clause recorded')
  check('E14', 'clause bites only on evidence it names', 'unrelated missing evidence is recorded, never assumed clean', 1,
    unrelated.ready_clauses.undetermined.length)

  // The clause's own escape hatch still applies when the named item is declared.
  const declared = evaluateSynthetic({
    paths: [], symbols: [], answerability: 'ready', truth: namedTruth,
    declarations: [{ schema_path: '.evidence.answerability.caveats[]', channel: '.evidence.answerability.caveats[]', text: 'createStorage was not resolved; Driver is unresolved in this pack.' }],
  })
  check('E14', 'clause bites only on evidence it names', 'named item declared unresolved', false, declared.metrics.false_ready)

  // The real frozen impact clause, against the real missing set.
  const impactTruth = makeTruth({
    required_evidence_paths: ['src/hono.ts'],
    required_evidence_symbols: [],
    must_not_report_ready_when: ['the relationship between the constructor in src/hono.ts and the three router implementations is missing from the evidence set and is not declared as unresolved'],
  })
  const impact = evaluateSynthetic({ paths: [], symbols: [], answerability: 'ready_with_caveat', truth: impactTruth })
  check('E14', 'clause bites only on evidence it names', 'frozen impact clause naming src/hono.ts', true, impact.metrics.false_ready)
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
  const probeClean = evaluateProbe({
    probe, evidence: makeEvidence({ paths: REAL_PATHS, symbols: ['compose'] }), declarations: [],
    answerability: 'verify_targets', targetDir: fixtureDir, relabelCandidates: [],
  })
  check('E15', 'task cells gate on paths, not symbols', 'probe with grounded symbols', 'pass', probeClean.state)
  const probeFabricated = evaluateProbe({
    probe, evidence: makeEvidence({ paths: REAL_PATHS, symbols: ['ZzNotInTheFixtureAtAll'] }), declarations: [],
    answerability: 'verify_targets', targetDir: fixtureDir, relabelCandidates: [],
  })
  check('E15', 'task cells gate on paths, not symbols', 'probe with a fabricated symbol', 'fail', probeFabricated.state,
    probeFabricated.reasons[0] ?? '')
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
