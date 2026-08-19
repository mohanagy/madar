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
  const graph = buildFromJson(extraction, { directed: true, accounting: 'normalized_extraction_boundary' })
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
    const graph = buildFromJson(extraction, { directed: true, accounting: 'normalized_extraction_boundary' })
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
    const graph = buildFromJson(representativeExtraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
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
    const graph = buildFromJson(representativeExtraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
    expect(graph.hasNode('nowhere')).toBe(false)
    expect(graph.hasNode('ghost')).toBe(false)
    expect(graph.nodeIds().sort()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('creates no topology for an unresolved candidate', () => {
    const graph = buildFromJson(representativeExtraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
    expect(graph.hasEdge('alpha', 'nowhere')).toBe(false)
    expect(graph.successors('alpha')).toEqual(['beta'])
  })

  it('keeps the unaffected valid facts usable', () => {
    const graph = buildFromJson(representativeExtraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
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
    const graph = buildFromJson(representativeExtraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
    expect(graph.hasEdge('beta', 'gamma')).toBe(false)
  })

  it('agrees with the storage-boundary admission counter', () => {
    const graph = buildFromJson(representativeExtraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
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
    const graph = buildFromJson(representativeExtraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
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
    const graph = buildFromJson(representativeExtraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
    const copied = graph.copy()
    expect(copied.normalizedAccountingSummary()).toBe(graph.normalizedAccountingSummary())
    expect(copied.normalizedAccountingSummary()!.counts.unresolved).toBe(3)
  })
})

describe('record retention is bounded and independent of arrival order', () => {
  const CAP = 1000

  function unresolvedGroups(count: number, order: 'forward' | 'reverse' | 'shuffle' | 'chunked'): NormalizedAccountingSession {
    const indexes = Array.from({ length: count }, (_, index) => index)
    if (order === 'reverse') indexes.reverse()
    if (order === 'shuffle') {
      // Deterministic shuffle: no Math.random, so a failure is reproducible.
      indexes.sort((left, right) => ((left * 7919) % count) - ((right * 7919) % count))
    }
    if (order === 'chunked') {
      const chunks: number[][] = []
      for (let i = 0; i < indexes.length; i += 97) chunks.push(indexes.slice(i, i + 97))
      indexes.length = 0
      for (const chunk of chunks.reverse()) indexes.push(...chunk)
    }

    const session = new NormalizedAccountingSession()
    for (const index of indexes) {
      session.dispose(`cf_${index}`, {
        state: 'unresolved',
        reasons: ['missing_target_endpoint'],
        source: 'alpha',
        target: `missing_${index}`,
      })
    }
    return session
  }

  it('keeps the distinct total exact once the cap is exceeded', () => {
    const groups = CAP + 100
    const result = unresolvedGroups(groups, 'forward').finalize()

    // The equation is untouched by any cap.
    expect(result.emittedCandidates).toBe(groups)
    expect(result.counts.unresolved).toBe(groups)
    // Detail is capped; the total stays exact so the loss is disclosed.
    expect(result.unresolvedRecords).toHaveLength(CAP)
    expect(result.unresolvedRetention).toEqual({ retained: CAP, total: groups })
  })

  it.each(['reverse', 'shuffle', 'chunked'] as const)(
    'produces byte-identical output under %s arrival order',
    (order) => {
      // The blocker: "first K encountered" made the retained subset depend on
      // arrival, which cannot be a deterministic artifact contract.
      const forward = unresolvedGroups(CAP + 100, 'forward').finalize()
      const other = unresolvedGroups(CAP + 100, order).finalize()
      expect(JSON.stringify(other)).toBe(JSON.stringify(forward))
    },
  )

  it('retains the lexicographically smallest record ids, not the earliest', () => {
    const result = unresolvedGroups(CAP + 100, 'forward').finalize()
    const ids = result.unresolvedRecords.map((record) => record.id)
    expect(ids).toEqual([...ids].sort())

    // Every retained id sorts at or below every id the reverse run retained,
    // which is only true if selection is by identity rather than arrival.
    const reverse = unresolvedGroups(CAP + 100, 'reverse').finalize()
    expect(reverse.unresolvedRecords.map((record) => record.id)).toEqual(ids)
  })

  it('keeps multiplicity exact for a retained group however often it repeats', () => {
    const session = unresolvedGroups(CAP + 100, 'forward')
    const retainedId = session.finalize().unresolvedRecords[0]!.id

    // Rebuild and repeat one group that is known to be retained.
    const repeated = unresolvedGroups(CAP + 100, 'forward')
    const target = unresolvedGroups(CAP + 100, 'forward').finalize().unresolvedRecords[0]!
    for (let i = 0; i < 4; i += 1) {
      repeated.dispose(target.candidateFingerprint, {
        state: 'unresolved',
        reasons: [...target.reasons],
        ...(target.source !== undefined ? { source: target.source } : {}),
        ...(target.target !== undefined ? { target: target.target } : {}),
      })
    }
    const result = repeated.finalize()
    const found = result.unresolvedRecords.find((record) => record.id === retainedId)

    expect(found?.multiplicity).toBe(5)
    // Repeats raise multiplicity, never the distinct total.
    expect(result.unresolvedRetention.total).toBe(CAP + 100)
    expect(result.counts.unresolved).toBe(CAP + 104)
  })

  it('counts an evicted group in the terminal counters even though its detail is gone', () => {
    const groups = CAP + 100
    const result = unresolvedGroups(groups, 'forward').finalize()
    const retainedIds = new Set(result.unresolvedRecords.map((record) => record.id))

    // 100 groups have no record at all, yet every one of them is counted.
    expect(retainedIds.size).toBe(CAP)
    expect(result.counts.unresolved).toBe(groups)
    expect(result.unresolvedRetention.total - result.unresolvedRetention.retained).toBe(100)
  })

  it('does not let an evicted id re-enter when it reappears', () => {
    // Eviction is monotone: the K-th smallest id only decreases, so an id
    // dropped once can never sort back in. Without that, a late repeat could
    // re-enter carrying a multiplicity of 1 and understate itself.
    const groups = CAP + 100
    const first = unresolvedGroups(groups, 'forward').finalize()

    const session = unresolvedGroups(groups, 'forward')
    const evicted = [...Array(groups).keys()]
      .map((index) => `cf_${index}`)
      .find((fingerprint) => !first.unresolvedRecords.some((r) => r.candidateFingerprint === fingerprint))
    expect(evicted, 'expected at least one evicted group').toBeDefined()

    // Re-disposed with IDENTICAL content, so it derives the SAME record id.
    // Different content would be a different group, which proves nothing.
    const evictedIndex = Number(evicted!.slice('cf_'.length))
    session.dispose(evicted!, {
      state: 'unresolved',
      reasons: ['missing_target_endpoint'],
      source: 'alpha',
      target: `missing_${evictedIndex}`,
    })
    const result = session.finalize()

    expect(result.unresolvedRecords.some((r) => r.candidateFingerprint === evicted)).toBe(false)
    expect(result.counts.unresolved).toBe(groups + 1)
    // And it must not inflate the distinct total by being seen twice.
    expect(result.unresolvedRetention.total).toBe(groups)
  })
})

describe('a copy helper that rebuilds a graph cannot launder degradation', () => {
  it('carries accounting and admission counters onto a rebuilt graph', () => {
    const source = buildFromJson(representativeExtraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
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
    const source = buildFromJson(representativeExtraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
    const target = buildFromJson(representativeExtraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
    expect(() => target.inheritDegradationFrom(source))
      .toThrow(NormalizedAccountingAlreadyAttachedError)
  })

  it('leaves the target untouched when it refuses', () => {
    // The guard used to run AFTER the admission counts were added, so a refused
    // call still doubled them and reported failure -- the worst combination.
    const source = buildFromJson(representativeExtraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
    const target = buildFromJson(representativeExtraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
    const before = target.storageAdmissionSummary().unresolvedUnregisteredRelationCandidates

    expect(() => target.inheritDegradationFrom(source)).toThrow()
    expect(target.storageAdmissionSummary().unresolvedUnregisteredRelationCandidates).toBe(before)
  })

  it('refuses to inherit onto a graph that already carries admissions', () => {
    const source = buildFromJson(representativeExtraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
    const target = new KnowledgeGraph({ directed: true })
    target.addNode('a', {})
    target.addNode('b', {})
    target.addEdge('a', 'b', { relation: 'totally_unregistered_relation' })
    expect(target.storageAdmissionSummary().unresolvedUnregisteredRelationCandidates).toBe(1)

    expect(() => target.inheritDegradationFrom(source))
      .toThrow(/only be inherited onto a graph that has none/)
  })

  it('copies admission counts rather than adding to them', () => {
    const source = buildFromJson(representativeExtraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
    const target = new KnowledgeGraph({ directed: true })
    target.inheritDegradationFrom(source)
    expect(target.storageAdmissionSummary())
      .toEqual(source.storageAdmissionSummary())
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

  it('drops a WINDOWS absolute path, which has no forward slash', () => {
    // A `!value.includes('/')` shortcut previously let this straight through.
    expect(sanitizeCandidate({ kind: 'C:\\Users\\me\\secret.ts' })).toEqual({})
  })

  it('drops a UNC path', () => {
    expect(sanitizeCandidate({ kind: '\\\\server\\share\\secret.ts' })).toEqual({})
  })

  it('drops a url-shaped value', () => {
    expect(sanitizeCandidate({ kind: 'https://example.com/x.ts' })).toEqual({})
  })

  it('drops a path that escapes the repository', () => {
    expect(sanitizeCandidate({ kind: '../../etc/passwd' })).toEqual({})
  })

  it('keeps a repository-relative path in normalized form', () => {
    expect(sanitizeCandidate({ kind: 'src\\pipeline\\build.ts' }))
      .toEqual({ kind: 'src/pipeline/build.ts' })
  })

  it('drops an over-long value rather than truncating it', () => {
    // Half a path is neither safe nor useful, and artifact-size headroom is thin.
    expect(sanitizeCandidate({ kind: 'x'.repeat(500) })).toEqual({})
    expect(sanitizeCandidate({ kind: 'x'.repeat(50) })).toEqual({ kind: 'x'.repeat(50) })
  })

  it('sanitizes a relation the same way as any other allowlisted string', () => {
    // `relation` used to be exempt, so a path-shaped relation slipped through.
    expect(sanitizeCandidate({ relation: '/Users/me/evil' })).toEqual({})
    expect(sanitizeCandidate({ relation: 'unregistered_thing' }))
      .toEqual({ relation: 'unregistered_thing' })
  })

  it('drops a home-relative path', () => {
    expect(sanitizeCandidate({ kind: '~/secret.ts' })).toEqual({})
  })

  it('drops a percent-encoded separator that would hide a path', () => {
    expect(sanitizeCandidate({ kind: '%2FUsers%2Fme' })).toEqual({})
  })

  it('drops a unicode separator look-alike a slash check would miss', () => {
    // U+2215 DIVISION SLASH is not `/`, so a path check that only knows the
    // ASCII separators would have let this through intact.
    expect(sanitizeCandidate({ kind: 'src\u2215evil.ts' })).toEqual({})
  })

  it('drops control characters', () => {
    expect(sanitizeCandidate({ kind: 'src/a\u0000.ts' })).toEqual({})
    expect(sanitizeCandidate({ kind: 'src/a\n.ts' })).toEqual({})
  })

  it('still keeps ordinary printable values', () => {
    expect(sanitizeCandidate({ kind: 'src/a b.ts' })).toEqual({ kind: 'src/a b.ts' })
    expect(sanitizeCandidate({ kind: './src/a.ts' })).toEqual({ kind: 'src/a.ts' })
    expect(sanitizeCandidate({ http_method: 'GET' })).toEqual({ http_method: 'GET' })
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

describe('normalized accounting is opt-in, so compatibility loads cannot claim it', () => {
  const V1_ARTIFACT = {
    schema_version: 1,
    directed: true,
    nodes: [
      { id: 'alpha', label: 'Alpha', file_type: 'code', source_file: 'src/alpha.ts' },
      { id: 'beta', label: 'Beta', file_type: 'code', source_file: 'src/beta.ts' },
    ],
    // `links` is the v1 shape; serve reshapes it into extraction `edges`.
    links: [
      { source: 'alpha', target: 'beta', relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
      { source: 'alpha', target: 'gone', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
    ],
  }

  /** Exactly what serve.ts does with a parsed v1 artifact before building. */
  function asServeReshapes(parsed: Record<string, unknown>): Record<string, unknown> {
    return {
      schema_version: parsed.schema_version,
      directed: parsed.directed === true,
      root_path: parsed.root_path,
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.links) ? parsed.links : Array.isArray(parsed.edges) ? parsed.edges : [],
      hyperedges: Array.isArray(parsed.hyperedges) ? parsed.hyperedges : [],
    }
  }

  it('attaches no accounting when a v1 artifact is rehydrated', () => {
    const graph = buildFromJson(asServeReshapes(V1_ARTIFACT), { directed: true, validateExtraction: false })
    expect(graph.normalizedAccountingSummary()).toBeNull()
  })

  it('still builds the legacy graph correctly', () => {
    // Absence of a ledger must not mean absence of a graph.
    const graph = buildFromJson(asServeReshapes(V1_ARTIFACT), { directed: true, validateExtraction: false })
    expect(graph.numberOfFacts()).toBe(1)
    expect(graph.hasEdge('alpha', 'beta')).toBe(true)
    expect(graph.hasNode('gone')).toBe(false)
  })

  it('defaults an unannotated call to no accounting', () => {
    // A future caller that forgets to think about this gets no ledger rather
    // than a fabricated one. Forgetting to opt in costs a ledger; forgetting to
    // opt out would fabricate provenance.
    const graph = buildFromJson(representativeExtraction())
    expect(graph.normalizedAccountingSummary()).toBeNull()
  })

  it('treats an explicit none the same as absence', () => {
    const graph = buildFromJson(representativeExtraction(), { directed: true, accounting: 'none' })
    expect(graph.normalizedAccountingSummary()).toBeNull()
  })

  it('still admits every valid candidate when accounting is off', () => {
    const withLedger = buildFromJson(representativeExtraction(), {
      directed: true,
      accounting: 'normalized_extraction_boundary',
    })
    const withoutLedger = buildFromJson(representativeExtraction(), { directed: true })

    // The graph must be byte-identical either way: accounting observes, it does
    // not decide what is admitted.
    expect(withoutLedger.numberOfFacts()).toBe(withLedger.numberOfFacts())
    expect(withoutLedger.numberOfOccurrences()).toBe(withLedger.numberOfOccurrences())
    expect(withoutLedger.numberOfEndpointPairs()).toBe(withLedger.numberOfEndpointPairs())
    expect(withoutLedger.nodeIds().sort()).toEqual(withLedger.nodeIds().sort())
  })

  it('still records storage-boundary admissions when accounting is off', () => {
    // The #657 counters are independent of #658's ledger and must not vanish.
    const graph = buildFromJson(representativeExtraction(), { directed: true })
    expect(graph.storageAdmissionSummary().unresolvedUnregisteredRelationCandidates).toBe(1)
  })

  it('produces normalized accounting when a real build opts in', () => {
    const graph = buildFromJson(representativeExtraction(), {
      directed: true,
      accounting: 'normalized_extraction_boundary',
    })
    expect(graph.normalizedAccountingSummary()).not.toBeNull()
    expect(graph.normalizedAccountingSummary()!.emittedCandidates).toBe(9)
  })
})
