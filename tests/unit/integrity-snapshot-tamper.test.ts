import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { GraphIntegrityInvariantError } from '../../src/contracts/graph-integrity.js'
import { finalizeNormalizedIntegritySnapshot } from '../../src/contracts/graph-integrity-snapshot.js'
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

/** Finalizes with one part of a genuine snapshot input replaced. */
function finalizeWith(overrides: Record<string, unknown>): () => unknown {
  const g = graph()
  const accounting = g.normalizedAccountingSummary()!
  const base = {
    accountingResult: accounting,
    facts: g.numberOfFacts(),
    occurrences: g.numberOfOccurrences(),
    endpointPairs: g.numberOfEndpointPairs(),
    endpointIdentityMatrix: g.endpointIdentityMatrix(),
    reasonFactCounts: g.endpointReasonFactSummary(),
    storageAdmission: g.storageAdmissionSummary(),
  }
  const accountingOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([key]) => key.startsWith('accounting.')),
  )
  const topOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([key]) => !key.startsWith('accounting.')),
  )
  const patchedAccounting = { ...accounting }
  for (const [key, value] of Object.entries(accountingOverrides)) {
    ;(patchedAccounting as Record<string, unknown>)[key.slice('accounting.'.length)] = value
  }
  const input = { ...base, ...topOverrides, accountingResult: patchedAccounting }
  return () => finalizeNormalizedIntegritySnapshot(input as never)
}

/** Every rejection must be the typed graph invariant, never a raw TypeError. */
function expectTypedRejection(run: () => unknown): void {
  let thrown: unknown
  try {
    run()
  } catch (error) {
    thrown = error
  }
  expect(thrown, 'expected a rejection').toBeDefined()
  expect(thrown).toBeInstanceOf(GraphIntegrityInvariantError)
  expect(thrown).not.toBeInstanceOf(TypeError)
  expect(thrown).not.toBeInstanceOf(RangeError)
}

function firstUnresolved(): Record<string, unknown> {
  return { ...graph().normalizedAccountingSummary()!.unresolvedRecords[0]! } as Record<string, unknown>
}

describe('R1/R2-02 — an unsafe payload cannot be attached', () => {
  it('refuses a record carrying an absolute private path', () => {
    const record = firstUnresolved()
    record['source'] = '/Users/reviewer/secret.ts'
    expectTypedRejection(finalizeWith({ 'accounting.unresolvedRecords': [record] }))
  })

  it('refuses an unsafe verification target even on an otherwise valid record', () => {
    const record = firstUnresolved()
    record['verificationTargets'] = [{ file: '/Users/reviewer/secret.ts', reason: 'missing_target_endpoint' }]
    expectTypedRejection(finalizeWith({ 'accounting.unresolvedRecords': [record] }))
  })

  it.each([
    ['a percent-encoded separator', 'src%2F..%2Fsecret.ts'],
    ['a Unicode separator look-alike', 'src\u2215secret.ts'],
    ['a traversal escape', '../../secret.ts'],
    ['a home-relative path', '~/secret.ts'],
    ['a UNC path', '\\\\server\\share\\secret.ts'],
    ['a drive path', 'C:\\secret.ts'],
  ])('refuses %s in a verification target', (_label, file) => {
    const record = firstUnresolved()
    record['verificationTargets'] = [{ file, reason: 'missing_target_endpoint' }]
    expectTypedRejection(finalizeWith({ 'accounting.unresolvedRecords': [record] }))
  })

  it('refuses an unsafe string hidden in a rejected candidate projection', () => {
    const record = {
      kind: 'rejected',
      id: 'cr_0000000000000000000000000000000000000000000000000000000000000000',
      multiplicity: 1,
      reasons: ['malformed_candidate'],
      verificationTargets: [],
      candidateFingerprint: 'cf_0000000000000000000000000000000000000000000000000000000000000000',
      sanitizedCandidate: { source: '/Users/reviewer/secret.ts' },
    }
    expectTypedRejection(finalizeWith({
      'accounting.rejectedRecords': [record],
      'accounting.recordRetention': {
        ...graph().normalizedAccountingSummary()!.recordRetention,
        rejected: { retained: 1, total: 1, omitted: 0, truncated: false },
      },
    }))
  })
})

describe('R1/R2-02 — malformed structures fail typed, never as a TypeError', () => {
  it('refuses a missing per-kind retention object', () => {
    const retention = { ...graph().normalizedAccountingSummary()!.recordRetention } as Record<string, unknown>
    delete retention['rejected']
    expectTypedRejection(finalizeWith({ 'accounting.recordRetention': retention }))
  })

  it('refuses a missing nested retention object on a record', () => {
    const record = firstUnresolved()
    delete record['occurrenceRetention']
    expectTypedRejection(finalizeWith({ 'accounting.unresolvedRecords': [record] }))
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'retention'],
    ['an array', []],
  ])('refuses per-kind retention that is %s', (_label, value) => {
    const retention = { ...graph().normalizedAccountingSummary()!.recordRetention, rejected: value }
    expectTypedRejection(finalizeWith({ 'accounting.recordRetention': retention }))
  })

  it('refuses a relabelled record that keeps fields its new kind has no schema for', () => {
    // The exact reviewer case: an unresolved record relabelled `rejected` still
    // carries occurrences and occurrenceRetention. Every individual field is
    // well-formed, so only cross-field agreement catches it.
    const record = firstUnresolved()
    record['kind'] = 'rejected'
    record['sanitizedCandidate'] = {}
    expectTypedRejection(finalizeWith({
      'accounting.unresolvedRecords': [],
      'accounting.rejectedRecords': [record],
      'accounting.recordRetention': {
        ...graph().normalizedAccountingSummary()!.recordRetention,
        unresolved: { retained: 0, total: 0, omitted: 0, truncated: false },
        rejected: { retained: 1, total: 1, omitted: 0, truncated: false },
      },
    }))
  })

  it('refuses an unknown record kind', () => {
    const record = firstUnresolved()
    record['kind'] = 'invented'
    expectTypedRejection(finalizeWith({ 'accounting.unresolvedRecords': [record] }))
  })

  it('refuses a record placed in the wrong array', () => {
    const record = firstUnresolved()
    expectTypedRejection(finalizeWith({
      'accounting.unresolvedRecords': [],
      'accounting.rejectedRecords': [record],
      'accounting.recordRetention': {
        ...graph().normalizedAccountingSummary()!.recordRetention,
        unresolved: { retained: 0, total: 0, omitted: 0, truncated: false },
        rejected: { retained: 1, total: 1, omitted: 0, truncated: false },
      },
    }))
  })

  it('refuses a duplicate id carrying a different payload', () => {
    const first = firstUnresolved()
    const second = { ...first, multiplicity: 9 }
    expectTypedRejection(finalizeWith({
      'accounting.unresolvedRecords': [first, second],
      'accounting.recordRetention': {
        ...graph().normalizedAccountingSummary()!.recordRetention,
        unresolved: { retained: 2, total: 2, omitted: 0, truncated: false },
      },
    }))
  })

  it('refuses an invalid reason code', () => {
    const record = firstUnresolved()
    record['reasons'] = ['not_a_real_reason']
    expectTypedRejection(finalizeWith({ 'accounting.unresolvedRecords': [record] }))
  })

  it('refuses an empty reason list', () => {
    const record = firstUnresolved()
    record['reasons'] = []
    expectTypedRejection(finalizeWith({ 'accounting.unresolvedRecords': [record] }))
  })
})

describe('R1/R2-02 — totals, matrices and counters are validated', () => {
  it.each([
    ['occurrences', 'occurrences'],
    ['endpointPairs', 'endpointPairs'],
    ['facts', 'facts'],
  ])('refuses a negative %s total', (_label, field) => {
    expectTypedRejection(finalizeWith({ [field]: -1 }))
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a fraction', 1.5],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 10],
    ['a string', '4'],
  ])('refuses an occurrence total that is %s', (_label, value) => {
    expectTypedRejection(finalizeWith({ occurrences: value }))
  })

  it('refuses a matrix whose sum disagrees with the fact count', () => {
    const g = graph()
    const matrix = g.endpointIdentityMatrix() as unknown as Record<string, Record<string, number>>
    matrix['legacy']!['legacy'] = (matrix['legacy']!['legacy'] ?? 0) + 5
    expectTypedRejection(finalizeWith({ endpointIdentityMatrix: matrix }))
  })

  it('refuses a negative matrix cell', () => {
    const g = graph()
    const matrix = g.endpointIdentityMatrix() as unknown as Record<string, Record<string, number>>
    matrix['legacy']!['legacy'] = -1
    expectTypedRejection(finalizeWith({ endpointIdentityMatrix: matrix }))
  })

  it('refuses an unknown matrix status row', () => {
    const g = graph()
    const matrix = { ...g.endpointIdentityMatrix() } as unknown as Record<string, unknown>
    matrix['invented'] = { legacy: 0 }
    expectTypedRejection(finalizeWith({ endpointIdentityMatrix: matrix }))
  })

  it('refuses a negative reason-fact count', () => {
    expectTypedRejection(finalizeWith({ reasonFactCounts: { unregistered_relation: -1 } }))
  })

  it('refuses a storage-admission total that disagrees with its components', () => {
    expectTypedRejection(finalizeWith({
      storageAdmission: {
        unresolvedUnregisteredRelationCandidates: 99,
        unregisteredRelationCounts: { totally_unregistered: 1 },
      },
    }))
  })

  it('refuses a negative storage-admission counter', () => {
    expectTypedRejection(finalizeWith({
      storageAdmission: {
        unresolvedUnregisteredRelationCandidates: -1,
        unregisteredRelationCounts: {},
      },
    }))
  })

  it('refuses a storage-admission summary that is missing entirely', () => {
    expectTypedRejection(finalizeWith({ storageAdmission: undefined }))
  })

  it('refuses terminal counts that break the candidate equation', () => {
    const accounting = graph().normalizedAccountingSummary()!
    expectTypedRejection(finalizeWith({
      'accounting.counts': { ...accounting.counts, unresolved: accounting.counts.unresolved + 1 },
    }))
  })

  it('refuses an unknown terminal state', () => {
    const accounting = graph().normalizedAccountingSummary()!
    expectTypedRejection(finalizeWith({
      'accounting.counts': { ...accounting.counts, invented_state: 0 },
    }))
  })

  it('refuses record arrays that disagree with their retention', () => {
    const accounting = graph().normalizedAccountingSummary()!
    expectTypedRejection(finalizeWith({
      'accounting.recordRetention': {
        ...accounting.recordRetention,
        unresolved: { retained: 99, total: 99, omitted: 0, truncated: false },
      },
    }))
  })

  it('refuses an unsafe scope failure', () => {
    expectTypedRejection(finalizeWith({
      'accounting.scopeFailures': ['/Users/reviewer/secret.ts'],
      'accounting.scopeFailureRetention': { retained: 1, total: 1, omitted: 0, truncated: false },
    }))
  })
})

describe('R1/R2-02 — a genuine snapshot still finalizes', () => {
  it('accepts the real production payload unchanged', () => {
    expect(graph().normalizedIntegritySnapshot()).not.toBeNull()
  })

  it('finalizes with no overrides applied', () => {
    expect(finalizeWith({})()).toBeDefined()
  })
})
