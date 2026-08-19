import { describe, expect, it } from 'vitest'

import { KnowledgeGraph, NormalizedAccountingAlreadyAttachedError } from '../../src/contracts/graph.js'
import { GraphIntegrityInvariantError } from '../../src/contracts/graph-integrity.js'
import {
  NormalizedAccountingSession,
  candidateFingerprint,
  sanitizeCandidate,
} from '../../src/contracts/graph-integrity-session.js'
import { buildFromJson } from '../../src/pipeline/build.js'

/**
 * One representative extraction exercising every disposition `buildFromJson`
 * can reach, so the equation is proved on a single run rather than on a
 * collection of single-case fixtures that never interact.
 */
function representativeExtraction(): Record<string, unknown> {
  return {
    schema_version: 1,
    directed: true,
    nodes: [
      { id: 'alpha', label: 'Alpha', file_type: 'code', source_file: 'src/alpha.ts' },
      { id: 'beta', label: 'Beta', file_type: 'code', source_file: 'src/beta.ts' },
      { id: 'gamma', label: 'Gamma', file_type: 'code', source_file: 'src/gamma.ts' },
    ],
    edges: [
      // retained_new_fact
      { source: 'alpha', target: 'beta', relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
      // retained_additional_occurrence -- same fact, a distinct evidence site
      {
        source: 'alpha',
        target: 'beta',
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: 'src/alpha.ts',
        source_range: { start: { line: 9, column: 1 }, end: { line: 9, column: 20 } },
      },
      // deliberately_merged_duplicate -- byte-identical repeat of the first
      { source: 'alpha', target: 'beta', relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
      // unresolved -- missing target
      { source: 'alpha', target: 'nowhere', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
      // unresolved -- missing source
      { source: 'ghost', target: 'beta', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'src/ghost.ts' },
      // unresolved -- both missing
      { source: 'ghost', target: 'nowhere', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'src/ghost.ts' },
      // rejected -- unsupported relation
      { source: 'beta', target: 'gamma', relation: 'totally_unregistered_relation', confidence: 'EXTRACTED', source_file: 'src/beta.ts' },
      // rejected -- malformed, endpoints are not strings
      { source: 42, target: 'gamma', relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/beta.ts' },
      // rejected -- malformed, not a record at all
      'not-an-edge',
    ],
  }
}

function accountingFor(extraction: Record<string, unknown>): NonNullable<ReturnType<KnowledgeGraph['normalizedAccountingSummary']>> {
  const graph = buildFromJson(extraction, { directed: true })
  const accounting = graph.normalizedAccountingSummary()
  expect(accounting, 'expected accounting to be attached').not.toBeNull()
  return accounting!
}

describe('every normalized candidate reaches exactly one terminal state', () => {
  it('balances the equation on a fixture exercising every reachable disposition', () => {
    const extraction = representativeExtraction()
    const accounting = accountingFor(extraction)
    const entries = (extraction.edges as readonly unknown[]).length

    expect(accounting.emittedCandidates).toBe(entries)
    const sum = Object.values(accounting.counts).reduce((total, count) => total + count, 0)
    expect(sum).toBe(accounting.emittedCandidates)
  })

  it('assigns each disposition its expected count', () => {
    const accounting = accountingFor(representativeExtraction())
    expect(accounting.counts).toEqual({
      retained_new_fact: 1,
      retained_additional_occurrence: 1,
      deliberately_merged_duplicate: 1,
      unresolved: 3,
      rejected: 3,
      conflicting: 0,
      invariant_failed: 0,
    })
  })

  it('reports graph totals separately from the candidate ledger', () => {
    const extraction = representativeExtraction()
    const graph = buildFromJson(extraction, { directed: true })
    const accounting = graph.normalizedAccountingSummary()!

    // Nine candidates produced ONE fact carrying TWO occurrences across ONE
    // endpoint pair. Four different quantities from one ledger -- which is the
    // whole reason graph totals sit beside the equation instead of inside it.
    expect(accounting.emittedCandidates).toBe(9)
    expect(graph.numberOfFacts()).toBe(1)
    expect(graph.numberOfOccurrences()).toBe(2)
    expect(graph.numberOfEndpointPairs()).toBe(1)
    expect(graph.numberOfFacts()).not.toBe(accounting.emittedCandidates)
  })
})

describe('the three retained states are told apart by occurrence disposition', () => {
  it('separates a distinct evidence site from an exact repeat', () => {
    const accounting = accountingFor(representativeExtraction())
    // Without the occurrence disposition surfaced on the admission result these
    // two would be indistinguishable and both would land in one bucket.
    expect(accounting.counts.retained_additional_occurrence).toBe(1)
    expect(accounting.counts.deliberately_merged_duplicate).toBe(1)
  })

  it('collapses an exact repeat onto the same occurrence', () => {
    const graph = buildFromJson(representativeExtraction(), { directed: true })
    // Three calls candidates, two occurrences: the repeat merged rather than
    // inflating evidence.
    expect(graph.numberOfOccurrences()).toBe(2)
  })
})

describe('missing endpoints are retained as records, never as topology', () => {
  it('names which endpoint was missing', () => {
    const accounting = accountingFor(representativeExtraction())
    const reasons = accounting.terminalReasonCounts
    expect(reasons.missing_target_endpoint).toBe(1)
    expect(reasons.missing_source_endpoint).toBe(1)
    expect(reasons.missing_both_endpoints).toBe(1)
  })

  it('creates no placeholder node for a missing endpoint', () => {
    const graph = buildFromJson(representativeExtraction(), { directed: true })
    expect(graph.hasNode('nowhere')).toBe(false)
    expect(graph.hasNode('ghost')).toBe(false)
    expect(graph.nodeIds().sort()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('creates no topology for an unresolved candidate', () => {
    const graph = buildFromJson(representativeExtraction(), { directed: true })
    expect(graph.hasEdge('alpha', 'nowhere')).toBe(false)
    expect(graph.successors('alpha')).toEqual(['beta'])
  })

  it('keeps the unaffected valid facts usable', () => {
    const graph = buildFromJson(representativeExtraction(), { directed: true })
    expect(graph.numberOfFacts()).toBe(1)
    expect(graph.relationsBetween('alpha', 'beta')).toEqual(['calls'])
  })

  it('retains a durable record per distinct unresolved candidate', () => {
    const accounting = accountingFor(representativeExtraction())
    expect(accounting.unresolvedRecords).toHaveLength(3)
    expect(accounting.unresolvedRetention).toEqual({ retained: 3, total: 3 })
    for (const record of accounting.unresolvedRecords) {
      expect(record.id).toMatch(/^uc_[a-f0-9]{64}$/)
      expect(record.reasons.length).toBeGreaterThan(0)
    }
  })

  it('adds an external-boundary reason only on positive builtin evidence', () => {
    const accounting = accountingFor({
      schema_version: 1,
      nodes: [{ id: 'alpha', label: 'Alpha', file_type: 'code', source_file: 'src/alpha.ts' }],
      edges: [
        { source: 'alpha', target: 'fs', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
        { source: 'alpha', target: 'some_local_module', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
      ],
    })
    // `fs` is a runtime builtin, so the claim is evidenced. The other is simply
    // missing -- no internal claim is invented for it.
    expect(accounting.terminalReasonCounts.unresolved_external_module_boundary).toBe(1)
    expect(accounting.terminalReasonCounts.missing_target_endpoint).toBe(2)
    expect(accounting.terminalReasonCounts.unresolved_internal_target).toBeUndefined()
  })
})

describe('unsupported and malformed candidates are rejected, not dropped', () => {
  it('records an unsupported relation as a rejection with a reason', () => {
    const accounting = accountingFor(representativeExtraction())
    expect(accounting.terminalReasonCounts.unsupported_relation).toBe(1)
  })

  it('keeps an unsupported relation out of facts and topology', () => {
    const graph = buildFromJson(representativeExtraction(), { directed: true })
    expect(graph.hasEdge('beta', 'gamma')).toBe(false)
  })

  it('agrees with the storage-boundary admission counter', () => {
    const graph = buildFromJson(representativeExtraction(), { directed: true })
    const accounting = graph.normalizedAccountingSummary()!
    expect(graph.storageAdmissionSummary().unresolvedUnregisteredRelationCandidates)
      .toBe(accounting.terminalReasonCounts.unsupported_relation)
  })

  it('rejects a non-record entry rather than letting the normalizer drop it', () => {
    const accounting = accountingFor(representativeExtraction())
    expect(accounting.terminalReasonCounts.malformed_candidate).toBe(2)
    // Three rejections in total: two malformed plus one unsupported relation.
    expect(accounting.counts.rejected).toBe(3)
    expect(accounting.rejectedRecords).toHaveLength(3)
  })

  it('keeps only a sanitized projection of a rejected candidate', () => {
    const accounting = accountingFor(representativeExtraction())
    for (const record of accounting.rejectedRecords) {
      const serialized = JSON.stringify(record.sanitizedCandidate)
      expect(serialized).not.toContain('/Users/')
      expect(record.sanitizedCandidate).not.toHaveProperty('source_file')
    }
  })
})

describe('partial discriminators are visible on retained facts', () => {
  it('counts a retained candidate whose registered policy is only partial', () => {
    const accounting = accountingFor(representativeExtraction())
    // `calls` is registered `partial`, so every retained calls candidate carries
    // the reason even though the fact was kept.
    expect(accounting.terminalReasonCounts.partial_discriminator).toBeGreaterThan(0)
    expect(accounting.retainedPartialDiscriminators).toBeGreaterThan(0)
  })

  it('does not claim a partial discriminator for an endpoint-only relation', () => {
    const accounting = accountingFor({
      schema_version: 1,
      nodes: [
        { id: 'alpha', label: 'Alpha', file_type: 'code', source_file: 'src/alpha.ts' },
        { id: 'beta', label: 'Beta', file_type: 'code', source_file: 'src/beta.ts' },
      ],
      edges: [
        { source: 'alpha', target: 'beta', relation: 'contains', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
      ],
    })
    expect(accounting.retainedPartialDiscriminators).toBe(0)
  })
})

describe('verification targets appear only when a root makes them safe', () => {
  it('emits no target when producer paths are absolute and no root is supplied', () => {
    const accounting = accountingFor({
      schema_version: 1,
      nodes: [{ id: 'alpha', label: 'Alpha', file_type: 'code', source_file: '/abs/src/alpha.ts' }],
      edges: [
        { source: 'alpha', target: 'nowhere', relation: 'imports_from', confidence: 'EXTRACTED', source_file: '/abs/src/alpha.ts' },
      ],
    })
    expect(accounting.unresolvedRecords[0]!.verificationTargets).toEqual([])
  })

  it('emits a repository-relative target once a root is supplied', () => {
    const accounting = accountingFor({
      schema_version: 1,
      root_path: '/abs',
      nodes: [{ id: 'alpha', label: 'Alpha', file_type: 'code', source_file: '/abs/src/alpha.ts' }],
      edges: [
        { source: 'alpha', target: 'nowhere', relation: 'imports_from', confidence: 'EXTRACTED', source_file: '/abs/src/alpha.ts' },
      ],
    })
    expect(accounting.unresolvedRecords[0]!.verificationTargets).toEqual([
      { file: 'src/alpha.ts', reason: 'missing_target_endpoint' },
    ])
  })

  it('never emits a target that escapes the supplied root', () => {
    const accounting = accountingFor({
      schema_version: 1,
      root_path: '/abs/project',
      nodes: [{ id: 'alpha', label: 'Alpha', file_type: 'code', source_file: '/abs/elsewhere/alpha.ts' }],
      edges: [
        { source: 'alpha', target: 'nowhere', relation: 'imports_from', confidence: 'EXTRACTED', source_file: '/abs/elsewhere/alpha.ts' },
      ],
    })
    expect(accounting.unresolvedRecords[0]!.verificationTargets).toEqual([])
  })
})

describe('determinism', () => {
  it('produces identical accounting for identical input', () => {
    const first = accountingFor(representativeExtraction())
    const second = accountingFor(representativeExtraction())
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('groups repeated identical candidates by multiplicity, not by sequence id', () => {
    const repeated = {
      schema_version: 1,
      nodes: [{ id: 'alpha', label: 'Alpha', file_type: 'code', source_file: 'src/alpha.ts' }],
      edges: Array.from({ length: 4 }, () => ({
        source: 'alpha',
        target: 'nowhere',
        relation: 'imports_from',
        confidence: 'EXTRACTED',
        source_file: 'src/alpha.ts',
      })),
    }
    const accounting = accountingFor(repeated)
    expect(accounting.counts.unresolved).toBe(4)
    expect(accounting.unresolvedRecords).toHaveLength(1)
    expect(accounting.unresolvedRecords[0]!.multiplicity).toBe(4)
  })

  it('emits the reason breakdown in a stable key order', () => {
    const accounting = accountingFor(representativeExtraction())
    const keys = Object.keys(accounting.terminalReasonCounts)
    expect(keys.length).toBeGreaterThan(1)
    expect(keys).toEqual([...keys].sort())
  })

  it('produces the same breakdown whatever order the candidates arrive in', () => {
    // Map iteration is insertion-ordered, so without an explicit sort two runs
    // over the same candidates in a different order would serialize differently
    // and the artifact bytes would move for no semantic reason.
    const forward = representativeExtraction()
    const reversed = representativeExtraction()
    reversed.edges = [...(reversed.edges as readonly unknown[])].reverse()

    expect(JSON.stringify(accountingFor(reversed).terminalReasonCounts))
      .toBe(JSON.stringify(accountingFor(forward).terminalReasonCounts))
  })

  it('orders durable records deterministically', () => {
    const accounting = accountingFor(representativeExtraction())
    const ids = accounting.unresolvedRecords.map((record) => record.id)
    expect(ids).toEqual([...ids].sort())
  })
})

describe('the raw-to-normalized correlation the ledger depends on', () => {
  it('normalizes exactly the record entries, in order', () => {
    // buildFromJson pairs each record entry with normalized.edges positionally.
    // The guard inside buildFromJson cannot fire while this holds, so the
    // property is pinned here rather than left to a branch no input can reach.
    const extraction = representativeExtraction()
    const raw = extraction.edges as readonly unknown[]
    const recordEntries = raw.filter((entry) => (
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    ))
    const accounting = accountingFor(extraction)

    expect(recordEntries).toHaveLength(raw.length - 1)
    // Every record entry was disposed, plus the one non-record entry.
    expect(accounting.emittedCandidates).toBe(raw.length)
    expect(accounting.counts.invariant_failed).toBe(0)
  })

  it('reports a correlation drift as an invariant failure, not a silent skip', () => {
    // A record entry with no normalized counterpart would be disposed
    // invariant_failed rather than dropped. Asserting the disposition exists in
    // the vocabulary and is reachable through the session keeps the intent
    // pinned even though the current normalizer cannot produce the drift.
    const session = new NormalizedAccountingSession()
    session.dispose('cf_drift', {
      state: 'invariant_failed',
      reasons: ['candidate_accounting_mismatch'],
    })
    const result = session.finalize()
    expect(result.counts.invariant_failed).toBe(1)
    expect(result.terminalReasonCounts.candidate_accounting_mismatch).toBe(1)
  })
})

describe('the accounting session is the single owner', () => {
  it('refuses to finalize twice', () => {
    const session = new NormalizedAccountingSession()
    session.finalize()
    expect(() => session.finalize()).toThrow(/already finalized/)
  })

  it('refuses to dispose after finalizing', () => {
    const session = new NormalizedAccountingSession()
    session.finalize()
    expect(() => session.dispose('cf_x', { state: 'retained_new_fact' }))
      .toThrow(GraphIntegrityInvariantError)
  })

  it('refuses a second accounting result on one graph', () => {
    const graph = buildFromJson(representativeExtraction(), { directed: true })
    const other = new NormalizedAccountingSession().finalize()
    expect(() => graph.attachNormalizedAccounting(other))
      .toThrow(NormalizedAccountingAlreadyAttachedError)
  })

  it('supports every one of the seven states', () => {
    const session = new NormalizedAccountingSession()
    session.dispose('cf_1', { state: 'retained_new_fact' })
    session.dispose('cf_2', { state: 'retained_additional_occurrence' })
    session.dispose('cf_3', { state: 'deliberately_merged_duplicate' })
    session.dispose('cf_4', { state: 'unresolved', reasons: ['missing_target_endpoint'] })
    session.dispose('cf_5', { state: 'rejected', reasons: ['malformed_candidate'] })
    session.dispose('cf_6', {
      state: 'conflicting',
      reasons: ['conflicting_behavior_metadata'],
      groupFingerprints: ['cf_a', 'cf_b'],
    })
    session.dispose('cf_7', { state: 'invariant_failed', reasons: ['hash_payload_invariant_failure'] })
    const result = session.finalize()

    expect(result.emittedCandidates).toBe(7)
    for (const count of Object.values(result.counts)) expect(count).toBe(1)
    expect(result.conflictRecords).toHaveLength(1)
  })

  it('keeps a scope failure out of the candidate equation', () => {
    const session = new NormalizedAccountingSession()
    session.dispose('cf_1', { state: 'retained_new_fact' })
    session.recordScopeFailure('src/broken.ts')
    const result = session.finalize()

    // A file that emitted no candidate must not invent one.
    expect(result.emittedCandidates).toBe(1)
    expect(result.scopeFailures).toEqual(['src/broken.ts'])
  })
})

describe('a graph with no build reports no accounting rather than zeros', () => {
  it('returns null on a hand-built graph', () => {
    const graph = new KnowledgeGraph({ directed: true })
    expect(graph.normalizedAccountingSummary()).toBeNull()
  })

  it('preserves accounting through copy so a copy cannot look cleaner', () => {
    const graph = buildFromJson(representativeExtraction(), { directed: true })
    const copied = graph.copy()
    expect(copied.normalizedAccountingSummary()).toBe(graph.normalizedAccountingSummary())
    expect(copied.normalizedAccountingSummary()!.counts.unresolved).toBe(3)
  })
})

describe('a copy helper that rebuilds a graph cannot launder degradation', () => {
  it('carries accounting and admission counters onto a rebuilt graph', () => {
    const source = buildFromJson(representativeExtraction(), { directed: true })
    expect(source.storageAdmissionSummary().unresolvedUnregisteredRelationCandidates).toBe(1)

    // What the direction-changing copy in generate does: a fresh graph with the
    // facts replayed. copy() preserves degradation itself; this path does not,
    // so it has to carry it explicitly or the rebuilt graph looks clean.
    const rebuilt = new KnowledgeGraph({ directed: false })
    rebuilt.inheritDegradationFrom(source)

    expect(rebuilt.normalizedAccountingSummary()).toBe(source.normalizedAccountingSummary())
    expect(rebuilt.storageAdmissionSummary().unresolvedUnregisteredRelationCandidates).toBe(1)
  })

  it('refuses to overwrite accounting already attached to the target', () => {
    const source = buildFromJson(representativeExtraction(), { directed: true })
    const target = buildFromJson(representativeExtraction(), { directed: true })
    expect(() => target.inheritDegradationFrom(source))
      .toThrow(NormalizedAccountingAlreadyAttachedError)
  })

  it('is a no-op for accounting when the source never ran a build', () => {
    const source = new KnowledgeGraph({ directed: true })
    const target = new KnowledgeGraph({ directed: true })
    target.inheritDegradationFrom(source)
    expect(target.normalizedAccountingSummary()).toBeNull()
  })
})

describe('candidate sanitization', () => {
  it('keeps allowlisted primitives only', () => {
    expect(sanitizeCandidate({
      relation: 'calls',
      confidence: 'EXTRACTED',
      source_file: '/Users/someone/secret/a.ts',
      arbitrary: { nested: 'value' },
      weight: 0.5,
    })).toEqual({ relation: 'calls', confidence: 'EXTRACTED' })
  })

  it('drops an unsafe path even from an allowlisted key', () => {
    expect(sanitizeCandidate({ kind: '/Users/someone/x.ts' })).toEqual({})
  })

  it('returns an empty projection for a non-record', () => {
    expect(sanitizeCandidate('nope')).toEqual({})
    expect(sanitizeCandidate(null)).toEqual({})
    expect(sanitizeCandidate([1, 2])).toEqual({})
  })
})

describe('candidate fingerprints', () => {
  it('are content-derived and stable', () => {
    const input = { index: 3, source: 'a', target: 'b', relation: 'calls' }
    expect(candidateFingerprint(input)).toBe(candidateFingerprint(input))
    expect(candidateFingerprint(input)).toMatch(/^cf_[a-f0-9]{64}$/)
  })

  it('ignore the entry index when the triple is usable', () => {
    expect(candidateFingerprint({ index: 1, source: 'a', target: 'b', relation: 'calls' }))
      .toBe(candidateFingerprint({ index: 99, source: 'a', target: 'b', relation: 'calls' }))
  })

  it('separate unidentifiable entries so they cannot collapse and be undercounted', () => {
    expect(candidateFingerprint({ index: 1 })).not.toBe(candidateFingerprint({ index: 2 }))
  })
})
