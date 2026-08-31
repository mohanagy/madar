import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { evaluateProbe, evaluateTaskCell, PROBE_MAX_ANSWERABILITY } from '../../scripts/lib/qualify-tier1/evaluate.mjs'
import { buildFrozenManifest } from '../../scripts/lib/qualify-tier1/frozen.mjs'

type Recall = { critical_fact_recall: { paths: { ratio: number }; symbols: { ratio: number } } }

const ROOT = resolve('.')

// A tiny real directory so path-existence checks are genuinely exercised rather
// than stubbed: asserting against a mock would prove nothing about the check.
const fixtureDir = mkdtempSync(join(tmpdir(), 'madar-tier1-unit-'))
mkdirSync(join(fixtureDir, 'src'), { recursive: true })
for (const rel of ['src/compose.ts', 'src/hono-base.ts']) {
  writeFileSync(join(fixtureDir, rel), '// fixture\n')
}
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

  it('records the limits of what a context artifact can evidence', () => {
    const verdict = evaluateProbe({
      probe, evidence: evidenceOf(['src/compose.ts'], []),
      answerability: 'verify_targets', targetDir: fixtureDir, relabelCandidates: [],
    })
    expect((verdict.measurement_limits ?? []).join(' ')).toMatch(/not observable at this tier/)
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
