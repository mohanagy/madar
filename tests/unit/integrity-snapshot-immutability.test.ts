import { describe, expect, it } from 'vitest'

import { ENDPOINT_IDENTITY_STATUSES } from '../../src/contracts/endpoint-identity.js'
import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { GraphIntegrityInvariantError } from '../../src/contracts/graph-integrity.js'
import { buildFromJson } from '../../src/pipeline/build.js'

function extraction(): Record<string, unknown> {
  return {
    schema_version: 1,
    directed: true,
    nodes: [
      { id: 'alpha', label: 'Alpha', file_type: 'code', source_file: 'src/alpha.ts' },
      { id: 'beta', label: 'Beta', file_type: 'code', source_file: 'src/beta.ts' },
    ],
    edges: [
      { source: 'alpha', target: 'beta', relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
      { source: 'alpha', target: 'nowhere', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
      { source: 'beta', target: 'alpha', relation: 'totally_unregistered', confidence: 'EXTRACTED', source_file: 'src/beta.ts' },
    ],
  }
}

function graph(): KnowledgeGraph {
  return buildFromJson(extraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
}

/**
 * Assigning to a frozen property is a silent no-op outside strict mode and a
 * TypeError inside it. Test files are modules, so this runs strict -- but the
 * value check is what actually matters, and it holds either way.
 */
function expectImmutable(mutate: () => void, read: () => unknown): void {
  const before = read()
  try {
    mutate()
  } catch {
    // A TypeError here is the strict-mode form of the same guarantee.
  }
  expect(read()).toStrictEqual(before)
}

describe('R3-05 — the snapshot is immutable all the way down', () => {
  it('freezes the snapshot itself', () => {
    expect(Object.isFrozen(graph().normalizedIntegritySnapshot())).toBe(true)
  })

  it('freezes every endpoint-matrix row', () => {
    // The exact reviewer case: the outer matrix was frozen, every row was not.
    const snapshot = graph().normalizedIntegritySnapshot()!
    for (const status of ENDPOINT_IDENTITY_STATUSES) {
      expect(Object.isFrozen(snapshot.endpointIdentityMatrix[status]), status).toBe(true)
    }
    expectImmutable(
      () => { (snapshot.endpointIdentityMatrix as never as Record<string, Record<string, number>>)['legacy']!['legacy'] = 999 },
      () => snapshot.endpointIdentityMatrix.legacy.legacy,
    )
  })

  it('freezes the matrix handed out by the graph accessor too', () => {
    const matrix = graph().endpointIdentityMatrix()
    for (const status of ENDPOINT_IDENTITY_STATUSES) {
      expect(Object.isFrozen(matrix[status]), status).toBe(true)
    }
  })

  it.each([
    'graphTotals', 'terminalCounts', 'terminalReasonCounts',
    'reasonFactCounts', 'storageAdmission', 'recordRetention', 'scopeFailureRetention',
  ])('freezes %s', (field) => {
    const snapshot = graph().normalizedIntegritySnapshot()! as unknown as Record<string, unknown>
    expect(Object.isFrozen(snapshot[field])).toBe(true)
  })

  it.each(['unresolvedRecords', 'rejectedRecords', 'conflictRecords', 'scopeFailures', 'reasons'])(
    'freezes the %s array',
    (field) => {
      const snapshot = graph().normalizedIntegritySnapshot()! as unknown as Record<string, unknown[]>
      expect(Object.isFrozen(snapshot[field])).toBe(true)
    },
  )

  it('freezes each record and its nested arrays and retention', () => {
    const snapshot = graph().normalizedIntegritySnapshot()!
    const record = snapshot.unresolvedRecords[0]!
    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.isFrozen(record.reasons)).toBe(true)
    expect(Object.isFrozen(record.verificationTargets)).toBe(true)
    expect(Object.isFrozen(record.occurrences)).toBe(true)
    expect(Object.isFrozen(record.occurrenceRetention)).toBe(true)
  })

  it('freezes each verification target', () => {
    const snapshot = graph().normalizedIntegritySnapshot()!
    const target = snapshot.unresolvedRecords.flatMap((record) => record.verificationTargets)[0]
    expect(target, 'fixture must produce a verification target').toBeDefined()
    expect(Object.isFrozen(target)).toBe(true)
  })

  it('refuses a record rewrite through the projection', () => {
    const snapshot = graph().normalizedIntegritySnapshot()!
    expectImmutable(
      () => { (snapshot.unresolvedRecords[0] as never as Record<string, unknown>)['multiplicity'] = 9999 },
      () => snapshot.unresolvedRecords[0]!.multiplicity,
    )
  })

  it('refuses a retention rewrite through the projection', () => {
    const snapshot = graph().normalizedIntegritySnapshot()!
    expectImmutable(
      () => { (snapshot.recordRetention.unresolved as never as Record<string, unknown>)['omitted'] = 9999 },
      () => snapshot.recordRetention.unresolved.omitted,
    )
  })

  it('does not expose the graph counters the matrix was built from', () => {
    const subject = graph()
    const first = subject.endpointIdentityMatrix()
    // Detached as well as frozen: whatever a consumer attempts against the copy
    // it was handed, the next read is still truthful.
    expectImmutable(
      () => { (first as never as Record<string, Record<string, number>>)['legacy']!['legacy'] = 999 },
      () => subject.endpointIdentityMatrix().legacy.legacy,
    )
    expect(subject.endpointIdentityMatrix()).toStrictEqual(graph().endpointIdentityMatrix())
  })
})

describe('R3-05 — attachment is all-or-nothing', () => {
  function accountingOf(): Record<string, unknown> {
    return { ...graph().normalizedAccountingSummary() } as Record<string, unknown>
  }

  it('leaves both fields null when a first attachment is rejected', () => {
    const target = new KnowledgeGraph({ directed: true })
    const invalid = { ...accountingOf(), emittedCandidates: -1 }
    expect(() => target.attachNormalizedAccounting(invalid as never))
      .toThrow(GraphIntegrityInvariantError)
    // The precise failure the review found: accounting attached, snapshot not.
    expect(target.normalizedAccountingSummary()).toBeNull()
    expect(target.normalizedIntegritySnapshot()).toBeNull()
  })

  it.each([
    ['a broken candidate equation', (a: Record<string, unknown>) => ({
      ...a,
      counts: { ...(a['counts'] as Record<string, number>), unresolved: 99 },
    })],
    ['an unsafe record', (a: Record<string, unknown>) => ({
      ...a,
      unresolvedRecords: [{
        ...(a['unresolvedRecords'] as Record<string, unknown>[])[0],
        source: '/Users/reviewer/secret.ts',
      }],
    })],
    ['retention that disagrees with its array', (a: Record<string, unknown>) => ({
      ...a,
      recordRetention: {
        ...(a['recordRetention'] as Record<string, unknown>),
        unresolved: { retained: 77, total: 77, omitted: 0, truncated: false },
      },
    })],
  ])('leaves both fields null when attachment is rejected for %s', (_label, corrupt) => {
    const target = new KnowledgeGraph({ directed: true })
    expect(() => target.attachNormalizedAccounting(corrupt(accountingOf()) as never)).toThrow()
    expect(target.normalizedAccountingSummary()).toBeNull()
    expect(target.normalizedIntegritySnapshot()).toBeNull()
  })

  it('preserves the exact prior pair when a replacement is refused', () => {
    const subject = graph()
    const accounting = subject.normalizedAccountingSummary()
    const snapshot = subject.normalizedIntegritySnapshot()
    expect(accounting).not.toBeNull()

    expect(() => subject.attachNormalizedAccounting(accountingOf() as never)).toThrow()

    expect(subject.normalizedAccountingSummary()).toBe(accounting)
    expect(subject.normalizedIntegritySnapshot()).toBe(snapshot)
  })

  it('exposes one internally consistent pair after a successful attachment', () => {
    const subject = graph()
    const accounting = subject.normalizedAccountingSummary()!
    const snapshot = subject.normalizedIntegritySnapshot()!
    expect(snapshot.emittedCandidates).toBe(accounting.emittedCandidates)
    expect(snapshot.terminalCounts).toStrictEqual(accounting.counts)
    expect(snapshot.recordRetention).toStrictEqual(accounting.recordRetention)
    expect(snapshot.unresolvedRecords).toStrictEqual(accounting.unresolvedRecords)
  })
})
