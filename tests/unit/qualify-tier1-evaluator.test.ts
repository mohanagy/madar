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
import { MISSING_ABSENCE_DECLARATION, evaluateProbe, evaluateTaskCell, PROBE_MAX_ANSWERABILITY } from '../../scripts/lib/qualify-tier1/evaluate.mjs'
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

const truth = {
  tier1_obligations: {
    required_evidence_paths: ['src/compose.ts', 'src/hono-base.ts'],
    required_evidence_symbols: ['compose', 'dispatch'],
    min_critical_fact_recall: 1.0,
    must_not_report_ready_when: ['any required_evidence_path is absent from the evidence set'],
  },
}

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

function evaluate(paths: string[], symbols: string[], answerability = 'verify_targets') {
  return evaluateTaskCell({
    cell: { cell_id: 'unit@fixture' },
    task: { id: 'unit' },
    target: { id: 'fixture', source: { ref: 'x' } },
    truth,
    preparation: { valid: true },
    artifact: { evidence: { answerability: { missing_obligations: [], verification_targets: [] } } },
    evidence: evidenceOf(paths, symbols),
    answerability,
    targetDir: fixtureDir,
  })
}

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

describe('evidence_obligation_recall verdicts', () => {
  it('passes when every obligation is met', () => {
    const verdict = evaluate(['src/compose.ts', 'src/hono-base.ts'], ['compose', 'dispatch'])
    expect(verdict.state).toBe('pass')
    expect((verdict.metrics as Recall).critical_fact_recall.paths.ratio).toBe(1)
  })

  it('fails when a required path is missing', () => {
    const verdict = evaluate(['src/compose.ts'], ['compose', 'dispatch'])
    expect(verdict.state).toBe('fail')
    expect(verdict.observed.missing_critical_files).toEqual(['src/hono-base.ts'])
  })

  it('fails when the artifact cites a path absent from the pinned target', () => {
    const verdict = evaluate(['src/compose.ts', 'src/hono-base.ts', 'src/ghost.ts'], ['compose', 'dispatch'])
    expect(verdict.state).toBe('fail')
    expect(verdict.metrics.citation_evidence_failures).toBe(1)
    expect(verdict.observed.non_existent_cited_paths).toEqual(['src/ghost.ts'])
  })

  it('is invalid, not failed, when only an undecidable ready clause remains', () => {
    const verdict = evaluateTaskCell({
      cell: { cell_id: 'unit@fixture' },
      task: { id: 'unit' },
      target: { id: 'fixture', source: { ref: 'x' } },
      truth: {
        tier1_obligations: {
          ...truth.tier1_obligations,
          must_not_report_ready_when: ['the relationship between A and B is neither present in the graph nor declared as unresolved'],
        },
      },
      preparation: { valid: true },
      artifact: { evidence: { answerability: { missing_obligations: [], verification_targets: [] } } },
      evidence: evidenceOf(['src/compose.ts', 'src/hono-base.ts'], ['compose', 'dispatch']),
      answerability: 'ready',
      targetDir: fixtureDir,
    })
    expect(verdict.state).toBe('invalid')
    expect(verdict.invalid_reason).toBe('judge_failure')
  })

  it('does not let a non-ready artifact trip a must_not_report_ready_when clause', () => {
    const verdict = evaluate(['src/compose.ts', 'src/hono-base.ts'], ['compose', 'dispatch'], 'insufficient')
    expect(verdict.state).toBe('pass')
    expect(verdict.ready_clauses?.applicable).toBe(false)
  })
})

describe('negative-trust probes', () => {
  const probe = { id: 'unit-probe', ground_truth: 'absent', required_behaviour: [] }

  it('passes when readiness is correctly refused', () => {
    const verdict = evaluateProbe({
      probe, evidence: evidenceOf(['src/compose.ts'], []),
      answerability: 'verify_targets', targetDir: fixtureDir, relabelCandidates: [],
    })
    expect(verdict.state).toBe('pass')
    expect(verdict.metrics.false_ready).toBe(false)
  })

  it('fails on a measured false-ready rather than reporting invalid', () => {
    for (const state of ['ready', 'ready_with_caveat']) {
      const verdict = evaluateProbe({
        probe, evidence: evidenceOf(['src/compose.ts'], []),
        answerability: state, targetDir: fixtureDir, relabelCandidates: [],
      })
      expect(verdict.state).toBe('fail')
      expect(verdict.metrics.false_ready).toBe(true)
    }
  })

  it('caps answerability at the frozen probe maximum', () => {
    expect(PROBE_MAX_ANSWERABILITY).toBe('verify_targets')
  })

  it('fails when a fabricated path appears in the evidence set', () => {
    const verdict = evaluateProbe({
      probe, evidence: evidenceOf(['src/compose.ts', 'src/invented.ts'], []),
      answerability: 'verify_targets', targetDir: fixtureDir, relabelCandidates: [],
    })
    expect(verdict.state).toBe('fail')
    expect(verdict.observed.non_existent_cited_paths).toEqual(['src/invented.ts'])
  })

  it('classifies every frozen required_behaviour clause it reports on', () => {
    const verdict = evaluateProbe({
      probe: {
        id: 'unit-probe',
        prompt: { text: 'How does this framework persist compiled route matchers to disk?' },
        ground_truth: 'absent',
        required_behaviour: [
          'The artifact must not report a ready state.',
          'The artifact must state that no on-disk matcher cache exists.',
          'No fabricated path or symbol may appear in the evidence set.',
        ],
      },
      evidence: evidenceOf(['src/compose.ts'], []),
      declarations: [{ schema_path: '.evidence.answerability.caveats[]', channel: '.evidence.answerability.caveats[]', text: 'No on-disk matchers cache exists in this repository.' }],
      answerability: 'verify_targets', targetDir: fixtureDir, relabelCandidates: [],
    })
    expect(verdict.requirement_coverage?.every((entry) => entry.measured)).toBe(true)
    expect(verdict.state).toBe('pass')
  })

  it('refuses to report pass when a frozen requirement is not measured', () => {
    const verdict = evaluateProbe({
      probe: {
        id: 'unit-probe',
        prompt: { text: 'How does this framework persist compiled route matchers to disk?' },
        ground_truth: 'absent',
        required_behaviour: ['The artifact must hum a tune this evaluator cannot hear.'],
      },
      evidence: evidenceOf(['src/compose.ts'], []),
      answerability: 'verify_targets', targetDir: fixtureDir, relabelCandidates: [],
    })
    expect(verdict.state).toBe('invalid')
    expect(verdict.state).not.toBe('pass')
  })

  it('fails when the frozen absence declaration is not observable', () => {
    const probeWithDeclaration = {
      id: 'unit-probe',
      prompt: { text: 'How does this framework persist compiled route matchers to disk?' },
      ground_truth: 'absent',
      required_behaviour: [
        'The artifact must not report a ready state.',
        'The artifact must state that no on-disk matcher cache exists.',
      ],
    }
    const withoutDeclaration = evaluateProbe({
      probe: probeWithDeclaration,
      evidence: evidenceOf(['src/compose.ts'], []),
      declarations: [{ schema_path: '.evidence.answerability.missing_obligations[]', channel: '.evidence.answerability.missing_obligations[]', text: 'evidence:supporting' }],
      answerability: 'verify_targets', targetDir: fixtureDir, relabelCandidates: [],
    })
    expect(withoutDeclaration.state).toBe('fail')
    expect(withoutDeclaration.reasons.some((reason) => reason.startsWith(MISSING_ABSENCE_DECLARATION))).toBe(true)
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
