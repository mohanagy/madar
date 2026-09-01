import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  ANSWERABILITY_ORDER,
  READY_STATES,
  answerabilityRank,
  extractEvidence,
  normaliseSymbol,
  readAnswerability,
  redact,
} from '../../scripts/lib/qualify-tier1/artifact.mjs'
import { loadAdjudication, PREDICATE_KINDS } from '../../scripts/lib/qualify-tier1/adjudication.mjs'
import { MISSING_ABSENCE_DECLARATION, evaluateProbe, evaluateTaskCell } from '../../scripts/lib/qualify-tier1/evaluate.mjs'
import { buildFrozenManifest } from '../../scripts/lib/qualify-tier1/frozen.mjs'

type Recall = { critical_fact_recall: { paths: { ratio: number }; symbols: { ratio: number } } }

const ROOT = resolve('.')

// A tiny real directory so path-existence checks are genuinely exercised rather
// than stubbed: asserting against a mock would prove nothing about the check.
const fixtureDir = mkdtempSync(join(tmpdir(), 'madar-tier1-unit-'))
mkdirSync(join(fixtureDir, 'src'), { recursive: true })
// The fixture carries the identifiers the obligations name, so the
// symbol-grounding check runs against real source text rather than a stub.
writeFileSync(join(fixtureDir, 'src/compose.ts'), 'export function compose() {}\nexport const dispatch = 1\n')
writeFileSync(join(fixtureDir, 'src/hono-base.ts'), 'export class Hono { fetch() {} }\n')
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }))

function evidenceOf(paths: string[], symbols: string[]) {
  return {
    strict: { paths: [...paths].sort(), symbols: [...symbols].sort() },
    generous: { paths: [...paths].sort(), symbols: [...symbols].sort() },
    basename_references: [],
    snippets: [],
    unclassified: [],
    guarded: [],
    channels: [],
  }
}


const REQUIRED_CLAUSES = (() => {
  const clauses: { file: string; pointer: string }[] = []
  const tier1 = JSON.parse(readFileSync(join(ROOT, 'docs/qualification/tier1.json'), 'utf8'))
  tier1.negative_trust_probes.forEach((probe: { required_behaviour?: string[] }, probeIndex: number) => {
    (probe.required_behaviour ?? []).forEach((_: string, index: number) => {
      clauses.push({ file: 'docs/qualification/tier1.json', pointer: `/negative_trust_probes/${probeIndex}/required_behaviour/${index}` })
    })
  })
  const tasks = JSON.parse(readFileSync(join(ROOT, 'docs/qualification/tasks.json'), 'utf8'))
  const tier1TaskIds = new Set(tier1.cells.map((cell: { task_id: string }) => cell.task_id))
  for (const task of tasks.tasks) {
    if (!tier1TaskIds.has(task.id)) continue
    const rel = `docs/qualification/${task.truth_ref}`
    const truth = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
    ;(truth.tier1_obligations?.must_not_report_ready_when ?? []).forEach((_: string, index: number) => {
      clauses.push({ file: rel, pointer: `/tier1_obligations/must_not_report_ready_when/${index}` })
    })
  }
  return clauses
})()

function syntheticAdjudication(predicates: { kind: string; params: Record<string, unknown> }[], requirements: { id: string; source?: { file: string; pointer: string }; identity_sha256?: string; path?: string; symbols?: string[] }[] = []) {
  const byClause = new Map()
  predicates.forEach((predicate, index) => {
    byClause.set(`synthetic-truth.json#/tier1_obligations/must_not_report_ready_when/${index}`, {
      id: `ADJ-UNIT-${index}`,
      source: { file: 'synthetic-truth.json', pointer: `/tier1_obligations/must_not_report_ready_when/${index}`, clause_sha256: 'unit' },
      predicate,
    })
  })
  return { contract: null, digest: 'unit', byClause, requirementsById: new Map(requirements.map((r) => [r.id, r])), problems: [] }
}

function probeAdjudication(predicates: { kind: string; params: Record<string, unknown> }[]) {
  const byClause = new Map()
  predicates.forEach((predicate, index) => {
    byClause.set(`docs/qualification/tier1.json#/negative_trust_probes/0/required_behaviour/${index}`, {
      id: `ADJ-UNITP-${index}`,
      source: { file: 'docs/qualification/tier1.json', pointer: `/negative_trust_probes/0/required_behaviour/${index}`, clause_sha256: 'unit' },
      predicate,
    })
  })
  return { contract: null, digest: 'unit', byClause, requirementsById: new Map(), problems: [] }
}

const TYPED_ABSENCE = [{
  channel: '.evidence.answerability.unresolved_subjects[]',
  shape: 'typed_record',
  status_field: 'status',
  status_values: ['not_found', 'absent', 'missing'],
  subject_field: 'subject_id',
  subject_values: ['capability:on-disk-matcher-cache'],
}]

describe('the adjudication contract binds every frozen prose clause', () => {
  it('loads the real contract with no problem and covers every Tier 1 clause', () => {
    const loaded = loadAdjudication(ROOT, { requiredClauses: REQUIRED_CLAUSES })
    expect(loaded.problems).toEqual([])
    expect(loaded.byClause.size).toBe(REQUIRED_CLAUSES.length)
  })

  it('binds each clause to exactly one entry with a kind from the closed union', () => {
    const loaded = loadAdjudication(ROOT, { requiredClauses: REQUIRED_CLAUSES })
    for (const entry of loaded.byClause.values()) {
      expect(PREDICATE_KINDS.has(entry.predicate.kind)).toBe(true)
    }
  })

  it('declares no natural-language predicate kind', () => {
    for (const banned of ['prose_matches', 'semantic_text_match', 'natural_language_assertion', 'negation_marker']) {
      expect(PREDICATE_KINDS.has(banned)).toBe(false)
    }
  })
})

describe('absence is decided by typed channels, never by prose', () => {
  const probe = {
    id: 'unit-probe',
    prompt: { text: 'Where does this framework persist compiled route matchers to disk?' },
    ground_truth: 'nothing persists',
    required_behaviour: ['The artifact must state that no on-disk matcher cache exists.'],
  }
  const run = (artifact: Record<string, unknown>) => evaluateProbe({
    probe, probeIndex: 0, evidence: evidenceOf([], []), artifact,
    answerability: 'verify_targets', targetDir: fixtureDir,
    adjudication: probeAdjudication([{ kind: 'required_typed_absence', params: { subject_id: 'capability:on-disk-matcher-cache', accepted_channels: TYPED_ABSENCE, prohibited_substitutions: null } }]),
  })

  it('rejects an affirmative sentence that contains a negation word', () => {
    const verdict = run({ claims: [{ text: 'There is no doubt that an on-disk matcher cache exists.' }] })
    expect(verdict.state).toBe('fail')
    expect(verdict.reasons.some((reason) => reason.includes(MISSING_ABSENCE_DECLARATION))).toBe(true)
  })

  it('rejects a double negation', () => {
    expect(run({ evidence: { answerability: { caveats: ['The cache is not missing.'] } } }).state).toBe('fail')
  })

  it('rejects a perfectly worded sentence in a free-text channel', () => {
    expect(run({ claims: [{ text: 'No on-disk matcher cache exists in this repository.' }] }).state).toBe('fail')
  })

  it('accepts an approved typed record for the exact subject', () => {
    const verdict = run({ evidence: { answerability: { unresolved_subjects: [{ subject_id: 'capability:on-disk-matcher-cache', status: 'not_found' }] } } })
    expect(verdict.state).toBe('pass')
  })

  it('rejects a typed record for a different subject', () => {
    expect(run({ evidence: { answerability: { unresolved_subjects: [{ subject_id: 'capability:encryption-at-rest', status: 'not_found' }] } } }).state).toBe('fail')
  })

  it('fails rather than turning invalid when nothing qualifies', () => {
    const verdict = run({ evidence: { answerability: { missing_obligations: ['evidence:supporting'] } } })
    expect(verdict.state).toBe('fail')
    expect(verdict.state).not.toBe('invalid')
  })
})

describe('must_not_report_ready_when is decided by frozen identities and typed records', () => {
  const requirements = [
    { id: 'req.a', path: 'src/compose.ts', symbols: ['compose'] },
    { id: 'req.b', path: 'src/hono-base.ts', symbols: ['Hono.fetch'] },
  ]
  const unresolvedChannels = [{
    channel: '.evidence.answerability.unresolved_requirements[]',
    shape: 'typed_record', status_field: 'status', status_values: ['unresolved'],
    subject_field: 'requirement_id', subject_values: ['req.a', 'req.b'],
  }]
  const run = (paths: string[], symbols: string[], answerability: string, artifact: Record<string, unknown> = {}) => evaluateTaskCell({
    cell: { cell_id: 'unit@fixture' }, task: { id: 'unit' }, target: { id: 'fixture', source: { ref: 'x' } },
    truth: { tier1_obligations: { required_evidence_paths: [], required_evidence_symbols: [], min_critical_fact_recall: 1.0, must_not_report_ready_when: ['clause'] } },
    truthFile: 'synthetic-truth.json', preparation: { valid: true },
    artifact: { evidence: { answerability: { state: answerability } }, ...artifact },
    evidence: evidenceOf(paths, symbols), answerability, targetDir: fixtureDir,
    adjudication: syntheticAdjudication([{ kind: 'must_not_ready_when_requirements_missing', params: {
      requirement_ids: ['req.a', 'req.b'], match: 'any_missing',
      ready_states: ['ready', 'ready_with_caveat'], unresolved: { channels: unresolvedChannels },
    } }], requirements),
  })

  it('fires on a ready state with the named frozen requirements missing', () => {
    expect(run([], [], 'ready_with_caveat').metrics.false_ready).toBe(true)
  })

  it('does not fire when the named requirements are present', () => {
    expect(run(['src/compose.ts', 'src/hono-base.ts'], ['compose', 'Hono.fetch'], 'ready_with_caveat').metrics.false_ready).toBe(false)
  })

  it('does not fire when the artifact is not in a ready state', () => {
    expect(run([], [], 'verify_targets').metrics.false_ready).toBe(false)
  })

  it('is suppressed only when every missing requirement has its own record', () => {
    const partial = run([], [], 'ready_with_caveat', { evidence: { answerability: { state: 'ready_with_caveat', unresolved_requirements: [{ requirement_id: 'req.a', status: 'unresolved' }] } } })
    expect(partial.metrics.false_ready).toBe(true)

    const complete = run([], [], 'ready_with_caveat', { evidence: { answerability: { state: 'ready_with_caveat', unresolved_requirements: [
      { requirement_id: 'req.a', status: 'unresolved' },
      { requirement_id: 'req.b', status: 'unresolved' },
    ] } } })
    expect(complete.metrics.false_ready).toBe(false)
  })

  it('is not suppressed by a record naming a requirement that is present', () => {
    // req.a is surfaced; req.b is the one actually missing. A record for req.a
    // carries nothing about the req.b gap.
    const wrong = run(['src/compose.ts'], ['compose'], 'ready_with_caveat', { evidence: { answerability: { state: 'ready_with_caveat', unresolved_requirements: [{ requirement_id: 'req.a', status: 'unresolved' }] } } })
    expect(wrong.metrics.false_ready).toBe(true)

    const right = run(['src/compose.ts'], ['compose'], 'ready_with_caveat', { evidence: { answerability: { state: 'ready_with_caveat', unresolved_requirements: [{ requirement_id: 'req.b', status: 'unresolved' }] } } })
    expect(right.metrics.false_ready).toBe(false)
  })

  it('is not suppressed by an affirmative claim naming the missing file', () => {
    const affirmative = run([], [], 'ready_with_caveat', { claims: [{ text: 'Supporting evidence for src/compose.ts is available.' }] })
    expect(affirmative.metrics.false_ready).toBe(true)
  })
})

describe('frozen contract cross-reference', () => {
  const built = buildFrozenManifest(ROOT)

  it('resolves the real frozen contract with no inconsistency', () => {
    expect(built.problems).toEqual([])
  })

  it('declares exactly the frozen Tier 1 population', () => {
    expect(built.cells).toHaveLength(6)
    expect(built.probes).toHaveLength(2)
    expect(built.cells.map((cell) => String(cell.cell_id)).sort()).toEqual([
      'arch-unstorage-driver-seam@unstorage',
      'flow-hono-request-dispatch@hono',
      'impact-hono-drop-router-fallback@hono',
      'plan-unstorage-add-driver@unstorage',
      'review-hono-error-handling@hono-seeded-error-disclosure',
      'rootcause-hono-middleware-rerun@hono-seeded-compose',
    ])
    expect(built.probes.map((probe) => String(probe.id)).sort()).toEqual([
      'neg-hono-absent-matcher-persistence',
      'neg-unstorage-absent-encryption',
    ])
  })

  it('resolves every referenced id exactly once and derives every referenced file', () => {
    const ids = built.manifest.referenced_ids
    expect(new Set(ids.task_ids).size).toBe(ids.task_ids.length)
    expect(new Set(ids.target_ids).size).toBe(ids.target_ids.length)
    // Truth files and patches are DERIVED, never listed by hand.
    expect(built.manifest.derived_references).toContain('docs/qualification/truth/flow-hono-request-dispatch.json')
    expect(built.manifest.derived_references).toContain('docs/qualification/patches/hono-compose-reentrancy-guard.patch')
  })

  it('produces a manifest digest that is stable across builds', () => {
    expect(buildFrozenManifest(ROOT).manifest.digest).toBe(built.manifest.digest)
  })
})

describe('symbol normalisation follows the frozen rubric', () => {
  it('compares the last dot-separated segment after stripping a leading #', () => {
    expect(normaliseSymbol('Hono.fetch')).toBe('fetch')
    expect(normaliseSymbol('Hono.#dispatch')).toBe('dispatch')
    expect(normaliseSymbol('compose.dispatch')).toBe('dispatch')
    expect(normaliseSymbol('getPath')).toBe('getPath')
  })

  it('is case-sensitive', () => {
    expect(normaliseSymbol('Hono.Fetch')).not.toBe('fetch')
  })
})

describe('answerability ordering', () => {
  it('orders states from least to most confident', () => {
    expect(ANSWERABILITY_ORDER).toEqual(['insufficient', 'verify_targets', 'ready_with_caveat', 'ready'])
    expect(answerabilityRank('ready')).toBeGreaterThan(answerabilityRank('verify_targets'))
  })

  it('treats ready_with_caveat as a ready state', () => {
    expect(READY_STATES.has('ready_with_caveat')).toBe(true)
    expect(READY_STATES.has('verify_targets')).toBe(false)
  })
})

describe('evidence extraction', () => {
  it('collects paths and symbols the artifact presents, and never absolute paths', () => {
    const evidence = extractEvidence({
      target: 'compose',
      pack: {
        target: 'compose',
        target_file: 'src/compose.ts',
        direct_dependents: [{ label: 'Hono.#dispatch', source_file: 'src/hono-base.ts' }],
        affected_files: ['src/context.ts', '/Users/someone/leaked.ts'],
      },
      claims: [{ node_labels: ['SmartRouter'] }],
      evidence: { answerability: { state: 'verify_targets', verification_targets: [{ focus_files: ['src/router.ts'] }] } },
    })
    expect(evidence.strict.paths).toEqual(['src/compose.ts', 'src/context.ts', 'src/hono-base.ts'])
    expect(evidence.strict.paths).not.toContain('/Users/someone/leaked.ts')
    expect(evidence.strict.symbols).toContain('SmartRouter')
    // The generous set adds pointers the pack did not select.
    expect(evidence.generous.paths).toContain('src/router.ts')
    expect(evidence.strict.paths).not.toContain('src/router.ts')
  })

  it('reads answerability from the artifact', () => {
    expect(readAnswerability({ evidence: { answerability: { state: 'insufficient' } } })).toBe('insufficient')
    expect(readAnswerability({ governance: { directive: { answerability: 'ready' } } })).toBe('ready')
    expect(readAnswerability({})).toBeNull()
  })
})






describe('evidence surface', () => {
  it('reads the selected-node channels of every artifact shape', () => {
    for (const artifact of [
      { pack: { matched_nodes: [{ label: 'compose', source_file: 'src/compose.ts' }] } },
      { pack: { seed_nodes: [{ label: 'compose', source_file: 'src/compose.ts' }] } },
      { pack: { review_bundle: { nodes: [{ label: 'compose', source_file: 'src/compose.ts' }] } } },
      { pack: { direct_dependents: [{ label: 'compose', source_file: 'src/compose.ts', relation: 'calls' }] } },
    ]) {
      const evidence = extractEvidence(artifact)
      expect(evidence.generous.symbols).toContain('compose')
      expect(evidence.generous.paths).toContain('src/compose.ts')
      expect(evidence.unclassified).toEqual([])
    }
  })

  it('refuses to silently drop a channel the registry does not classify', () => {
    const evidence = extractEvidence({ pack: {}, an_unknown_future_channel: ['src/x.ts'] })
    expect(evidence.unclassified.map((entry) => entry.channel)).toEqual(['.an_unknown_future_channel[]'])
  })

  it('classifies every channel the real retained artifacts present', () => {
    // The declared registry has to cover what Madar actually emits, not a
    // sample of it: a channel that falls through is scored as if the product
    // never surfaced it.
    const logs = join(ROOT, 'docs/qualification-results/tier1/2026-09-01-first-baseline/run-a/logs')
    const packs = readdirSync(logs).filter((name) => name.startsWith('pack-'))
    expect(packs.length).toBe(8)
    for (const name of packs) {
      const artifact = JSON.parse(readFileSync(join(logs, name), 'utf8'))
      expect({ name, unclassified: extractEvidence(artifact).unclassified }).toEqual({ name, unclassified: [] })
    }
  })

  it('keeps a community label out of the symbol set but reads a node-shaped entry', () => {
    const community = extractEvidence({ workflow_centers: [{ label: 'Drivers Github — Driver', node_count: 4 }] })
    expect(community.generous.symbols).toEqual([])
    expect(community.guarded.map((entry) => entry.value)).toEqual(['Drivers Github — Driver'])

    const node = extractEvidence({ workflow_centers: [{ label: 'createStorage', path: 'src/storage.ts' }] })
    expect(node.generous.symbols).toEqual(['createStorage'])
  })

  it('never mines snippet text for obligation recall', () => {
    const evidence = extractEvidence({
      pack: { matched_nodes: [{ label: 'other', source_file: 'src/compose.ts', snippet: 'export function compose() {}' }] },
    })
    expect(evidence.generous.symbols).not.toContain('compose')
    expect(evidence.snippets).toHaveLength(1)
  })
})

describe('durable evidence carries no absolute local path', () => {
  it('redacts target, repo and home prefixes', () => {
    const redacted = redact('/repo/x/out/graph.madar plus /Users/someone/y and /home/other/z', {
      targetDir: '/repo/x',
      root: '/repo',
    })
    expect(redacted).toContain('<target>')
    expect(redacted).not.toMatch(/\/Users\/[^/\s]+/)
    expect(redacted).not.toMatch(/\/home\/[a-z][^/\s]*/)
  })
})
