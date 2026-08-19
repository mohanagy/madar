import { describe, expect, it, vi } from 'vitest'

import { ENDPOINT_IDENTITY_STATUSES } from '../../src/contracts/endpoint-identity.js'
import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { assertDetailRetention, assertRecordRetention } from '../../src/contracts/graph-integrity.js'
import { NormalizedAccountingSession } from '../../src/contracts/graph-integrity-session.js'
import { finalizeNormalizedIntegritySnapshot } from '../../src/contracts/graph-integrity-snapshot.js'
import { buildFromJson } from '../../src/pipeline/build.js'

function extraction(): Record<string, unknown> {
  return {
    schema_version: 1,
    directed: true,
    nodes: [
      { id: 'alpha', label: 'Alpha', file_type: 'code', source_file: 'src/alpha.ts' },
      { id: 'beta', label: 'Beta', file_type: 'code', source_file: 'src/beta.ts' },
      { id: 'gamma', label: 'Gamma', file_type: 'code', source_file: 'src/gamma.ts' },
    ],
    edges: [
      { source: 'alpha', target: 'beta', relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
      { source: 'beta', target: 'gamma', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'src/beta.ts' },
      { source: 'alpha', target: 'nowhere', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
      { source: 'beta', target: 'gamma', relation: 'totally_unregistered', confidence: 'EXTRACTED', source_file: 'src/beta.ts' },
    ],
  }
}

function built(): KnowledgeGraph {
  return buildFromJson(extraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
}

describe('R3 — production attaches one complete snapshot', () => {
  it('is attached by a real normalized build, not only by a helper', () => {
    // The blocker: the receipt builder had no production caller at all.
    expect(built().normalizedIntegritySnapshot()).not.toBeNull()
  })

  it('carries every field a serializer needs', () => {
    const snapshot = built().normalizedIntegritySnapshot()!
    for (const field of [
      'accountingScope', 'emittedCandidates', 'terminalCounts', 'terminalReasonCounts',
      'status', 'reasons', 'graphTotals', 'endpointIdentityMatrix', 'reasonFactCounts',
      'storageAdmission', 'unresolvedRecords', 'rejectedRecords', 'conflictRecords',
      'recordRetention', 'scopeFailures', 'scopeFailureRetention',
    ]) {
      expect(snapshot, `missing ${field}`).toHaveProperty(field)
    }
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('declares the normalized scope', () => {
    expect(built().normalizedIntegritySnapshot()!.accountingScope).toBe('normalized_extraction_boundary')
  })

  it('agrees with the graph APIs on totals', () => {
    const graph = built()
    const snapshot = graph.normalizedIntegritySnapshot()!
    expect(snapshot.graphTotals).toEqual({
      facts: graph.numberOfFacts(),
      occurrences: graph.numberOfOccurrences(),
      endpointPairs: graph.numberOfEndpointPairs(),
    })
  })

  it('carries an endpoint matrix that partitions the retained facts', () => {
    const graph = built()
    const snapshot = graph.normalizedIntegritySnapshot()!
    let sum = 0
    for (const source of ENDPOINT_IDENTITY_STATUSES) {
      for (const target of ENDPOINT_IDENTITY_STATUSES) sum += snapshot.endpointIdentityMatrix[source][target]
    }
    expect(sum).toBe(graph.numberOfFacts())
  })

  it('reconciles the storage-admission summary exactly', () => {
    const graph = built()
    const snapshot = graph.normalizedIntegritySnapshot()!
    expect(snapshot.storageAdmission.unresolvedUnregisteredRelationCandidates)
      .toBe(snapshot.terminalReasonCounts.unsupported_relation ?? 0)
  })

  it('carries per-kind record retention agreeing with the arrays', () => {
    const snapshot = built().normalizedIntegritySnapshot()!
    expect(snapshot.recordRetention.unresolved.retained).toBe(snapshot.unresolvedRecords.length)
    expect(snapshot.recordRetention.rejected.retained).toBe(snapshot.rejectedRecords.length)
    expect(snapshot.recordRetention.conflicting.retained).toBe(snapshot.conflictRecords.length)
  })

  it('balances the candidate equation', () => {
    const snapshot = built().normalizedIntegritySnapshot()!
    const sum = Object.values(snapshot.terminalCounts).reduce((a, b) => a + b, 0)
    expect(sum).toBe(snapshot.emittedCandidates)
  })
})

describe('R3 — Stage 3 needs no second full pass', () => {
  it('reads the snapshot without walking facts or candidates', () => {
    const graph = built()
    // Serializer-facing access is a property read. If it walked facts, this spy
    // would fire -- which is the whole point of finalizing once.
    const factRecords = vi.spyOn(graph, 'factRecords')
    const occurrenceEntries = vi.spyOn(graph, 'occurrenceEntries')

    const snapshot = graph.normalizedIntegritySnapshot()!
    void snapshot.terminalCounts
    void snapshot.endpointIdentityMatrix
    void snapshot.graphTotals
    void snapshot.recordRetention

    expect(factRecords).not.toHaveBeenCalled()
    expect(occurrenceEntries).not.toHaveBeenCalled()
    factRecords.mockRestore()
    occurrenceEntries.mockRestore()
  })

  it('returns the identical frozen object on repeated access', () => {
    const graph = built()
    expect(graph.normalizedIntegritySnapshot()).toBe(graph.normalizedIntegritySnapshot())
  })

  it('builds the endpoint matrix during insertion, not on demand', () => {
    // O(1) whatever the graph size: the matrix is maintained as facts land.
    const graph = built()
    const first = graph.endpointIdentityMatrix()
    const second = graph.endpointIdentityMatrix()
    expect(second).toEqual(first)
    // Detached, so a consumer cannot mutate graph state through it.
    expect(second).not.toBe(first)
  })
})

describe('R3 — a snapshot can never describe a graph that moved on', () => {
  it('is invalidated when a fact is added afterwards', () => {
    const graph = built()
    expect(graph.normalizedIntegritySnapshot()).not.toBeNull()

    graph.addNode('delta', {})
    graph.addEdge('alpha', 'delta', { relation: 'calls', confidence: 'EXTRACTED' })

    // Dropped rather than silently kept: a stale snapshot would serialize as
    // authoritative.
    expect(graph.normalizedIntegritySnapshot()).toBeNull()
  })

  it('keeps the accounting ledger even when the snapshot is invalidated', () => {
    const graph = built()
    graph.addNode('delta', {})
    graph.addEdge('alpha', 'delta', { relation: 'calls', confidence: 'EXTRACTED' })
    expect(graph.normalizedAccountingSummary()).not.toBeNull()
  })
})

describe('R3 — copy, subgraph and compatibility loads stay truthful', () => {
  it('a full copy inherits the snapshot, because it describes the same graph', () => {
    const graph = built()
    expect(graph.copy().normalizedIntegritySnapshot()).toBe(graph.normalizedIntegritySnapshot())
  })

  it('a subgraph gets no snapshot, because it describes fewer facts', () => {
    const graph = built()
    expect(graph.subgraph(['alpha', 'beta']).normalizedIntegritySnapshot()).toBeNull()
  })

  it('a hand-built graph has no snapshot', () => {
    expect(new KnowledgeGraph({ directed: true }).normalizedIntegritySnapshot()).toBeNull()
  })

  it('a compatibility build has no snapshot', () => {
    const graph = buildFromJson(extraction(), { directed: true })
    expect(graph.normalizedIntegritySnapshot()).toBeNull()
    expect(graph.normalizedAccountingSummary()).toBeNull()
  })
})

describe('R2 — retention metadata is validated, never trusted', () => {
  const valid = { retained: 3, total: 10, omitted: 7, truncated: true } as const

  it('accepts a self-consistent retention object', () => {
    expect(() => assertDetailRetention(valid, 'test')).not.toThrow()
  })

  it.each([
    ['total below retained', { retained: 5, total: 2, omitted: 0, truncated: false }, /exceeds total/],
    ['negative retained', { retained: -1, total: 5, omitted: 6, truncated: true }, /non-negative safe integer/],
    ['negative total', { retained: 0, total: -1, omitted: 0, truncated: false }, /non-negative safe integer/],
    ['negative omitted', { retained: 1, total: 1, omitted: -1, truncated: false }, /non-negative safe integer/],
    ['fractional', { retained: 1.5, total: 5, omitted: 3.5, truncated: true }, /non-negative safe integer/],
    ['unsafe integer', { retained: 0, total: Number.MAX_SAFE_INTEGER + 10, omitted: 0, truncated: false }, /non-negative safe integer/],
    ['omitted mismatch', { retained: 3, total: 10, omitted: 2, truncated: true }, /omitted is 2 but total - retained is 7/],
    ['truncated false with omissions', { retained: 3, total: 10, omitted: 7, truncated: false }, /truncated is false with 7 omitted/],
    ['truncated true with none omitted', { retained: 3, total: 3, omitted: 0, truncated: true }, /truncated is true with 0 omitted/],
  ])('rejects %s', (_label, retention, message) => {
    expect(() => assertDetailRetention(retention as never, 'test')).toThrow(message)
  })

  it('rejects a record whose array disagrees with its own retained count', () => {
    const graph = built()
    const record = graph.normalizedIntegritySnapshot()!.unresolvedRecords[0]!
    const tampered = {
      ...record,
      occurrenceRetention: { retained: 9, total: 9, omitted: 0, truncated: false },
    }
    expect(() => assertRecordRetention(tampered as never, 'tampered'))
      .toThrow(/carries 0 occurrences but claims 9/)
  })

  it('reports per-kind retention with omitted and truncated, not just two numbers', () => {
    // The blocker: Stage 3 would otherwise have to subtract to learn that
    // detail was dropped.
    const snapshot = built().normalizedIntegritySnapshot()!
    for (const kind of ['unresolved', 'rejected', 'conflicting'] as const) {
      const retention = snapshot.recordRetention[kind]
      expect(retention, kind).toHaveProperty('omitted')
      expect(retention, kind).toHaveProperty('truncated')
      expect(retention.omitted).toBe(retention.total - retention.retained)
      expect(retention.truncated).toBe(retention.omitted > 0)
    }
  })

  it('carries the true total when records are capped', () => {
    const session = new NormalizedAccountingSession()
    const groups = 1100
    for (let index = 0; index < groups; index += 1) {
      session.dispose(`cf_${index}`, {
        state: 'unresolved',
        reasons: ['missing_target_endpoint'],
        source: 'alpha',
        target: `missing_${index}`,
      })
    }
    const retention = session.finalize().recordRetention.unresolved
    expect(retention).toEqual({ retained: 1000, total: groups, omitted: 100, truncated: true })
  })

  it('refuses to finalize a snapshot carrying a record with tampered retention', () => {
    // Records reaching the snapshot may come from a decoded artifact, not only
    // from the session that built them, so the boundary re-checks each one.
    const graph = built()
    const accounting = graph.normalizedAccountingSummary()!
    const [first, ...rest] = accounting.unresolvedRecords
    const tampered = {
      ...first!,
      occurrenceRetention: { retained: 4, total: 4, omitted: 0, truncated: false },
    }
    expect(() => finalizeNormalizedIntegritySnapshot({
      accountingResult: { ...accounting, unresolvedRecords: [tampered as never, ...rest] },
      facts: graph.numberOfFacts(),
      occurrences: graph.numberOfOccurrences(),
      endpointPairs: graph.numberOfEndpointPairs(),
      endpointIdentityMatrix: graph.endpointIdentityMatrix(),
      reasonFactCounts: graph.endpointReasonFactSummary(),
      storageAdmission: graph.storageAdmissionSummary(),
    })).toThrow(/carries 0 occurrences but claims 4/)
  })

  it('refuses to finalize a snapshot whose arrays disagree with its retention', () => {
    const graph = built()
    const accounting = graph.normalizedAccountingSummary()!
    expect(() => finalizeNormalizedIntegritySnapshot({
      accountingResult: {
        ...accounting,
        recordRetention: {
          ...accounting.recordRetention,
          unresolved: { retained: 99, total: 99, omitted: 0, truncated: false },
        },
      },
      facts: graph.numberOfFacts(),
      occurrences: graph.numberOfOccurrences(),
      endpointPairs: graph.numberOfEndpointPairs(),
      endpointIdentityMatrix: graph.endpointIdentityMatrix(),
      reasonFactCounts: graph.endpointReasonFactSummary(),
      storageAdmission: graph.storageAdmissionSummary(),
    })).toThrow(/carries \d+ entries but claims 99 retained/)
  })
})
