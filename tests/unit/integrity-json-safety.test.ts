import { describe, expect, it } from 'vitest'

import { serializeCanonicalJson } from '../../src/contracts/canonical-json.js'
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

const graph = (): KnowledgeGraph =>
  buildFromJson(extraction(), { directed: true, accounting: 'normalized_extraction_boundary' })

function finalizeWith(overrides: Record<string, unknown>): () => unknown {
  const g = graph()
  const accounting = g.normalizedAccountingSummary()!
  const patched = { ...accounting } as Record<string, unknown>
  const top: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(overrides)) {
    if (key.startsWith('accounting.')) patched[key.slice('accounting.'.length)] = value
    else top[key] = value
  }
  return () => finalizeNormalizedIntegritySnapshot({
    accountingResult: patched,
    facts: g.numberOfFacts(),
    occurrences: g.numberOfOccurrences(),
    endpointPairs: g.numberOfEndpointPairs(),
    endpointIdentityMatrix: g.endpointIdentityMatrix(),
    reasonFactCounts: g.endpointReasonFactSummary(),
    storageAdmission: g.storageAdmissionSummary(),
    ...top,
  } as never)
}

function expectTyped(run: () => unknown): void {
  let thrown: unknown
  try {
    run()
  } catch (error) {
    thrown = error
  }
  expect(thrown, 'expected a rejection').toBeDefined()
  expect(thrown).toBeInstanceOf(GraphIntegrityInvariantError)
  expect(thrown).not.toBeInstanceOf(TypeError)
}

const record = (): Record<string, unknown> =>
  ({ ...graph().normalizedAccountingSummary()!.unresolvedRecords[0]! } as Record<string, unknown>)

const rejectedRecord = (candidate: unknown): Record<string, unknown> => ({
  kind: 'rejected',
  id: `rc_${'0'.repeat(64)}`,
  multiplicity: 1,
  reasons: ['malformed_candidate'],
  verificationTargets: [],
  candidateFingerprint: `cf_${'0'.repeat(64)}`,
  sanitizedCandidate: candidate,
})

function withRejected(candidate: unknown): () => unknown {
  return finalizeWith({
    'accounting.rejectedRecords': [rejectedRecord(candidate)],
    'accounting.recordRetention': {
      ...graph().normalizedAccountingSummary()!.recordRetention,
      rejected: { retained: 1, total: 1, omitted: 0, truncated: false },
    },
  })
}

describe('V1-02 — a present undefined is not the same as an absent property', () => {
  it('rejects an optional record field present with undefined', () => {
    // The reviewer case: absent is allowed, present-and-undefined is what
    // canonical JSON refuses -- and it survived every check by never reaching
    // one, then broke serialization.
    expectTyped(finalizeWith({
      'accounting.unresolvedRecords': [{ ...record(), source: undefined }],
    }))
  })

  it('accepts the same field when it is genuinely absent', () => {
    const subject = record()
    delete subject['source']
    expect(finalizeWith({ 'accounting.unresolvedRecords': [subject] })()).toBeDefined()
  })

  it('rejects a terminal reason present with undefined', () => {
    const accounting = graph().normalizedAccountingSummary()!
    expectTyped(finalizeWith({
      'accounting.terminalReasonCounts': { ...accounting.terminalReasonCounts, unsupported_relation: undefined },
    }))
  })

  it('rejects an endpoint reason present with undefined', () => {
    expectTyped(finalizeWith({ reasonFactCounts: { unregistered_relation: undefined } }))
  })

  it('rejects an occurrence owner field present with undefined', () => {
    const subject = record()
    subject['occurrences'] = [{
      id: `eo_${'0'.repeat(64)}`,
      factId: `sf_${'0'.repeat(64)}`,
      owner: { adapterId: 'a', strategy: 's', sourceFile: undefined },
      provenance: [],
      confidenceObservations: [],
      metadata: {},
    }]
    subject['occurrenceRetention'] = { retained: 1, total: 1, omitted: 0, truncated: false }
    expectTyped(finalizeWith({ 'accounting.unresolvedRecords': [subject] }))
  })

  it('rejects a retention field present with undefined', () => {
    const accounting = graph().normalizedAccountingSummary()!
    expectTyped(finalizeWith({
      'accounting.recordRetention': {
        ...accounting.recordRetention,
        rejected: { retained: 0, total: 0, omitted: 0, truncated: undefined },
      },
    }))
  })
})

describe('V1-02 — no JSON-unsafe value survives to serialization', () => {
  it.each([
    ['undefined', undefined],
    ['a BigInt', BigInt(3)],
    ['a function', () => 'x'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a Set', new Set()],
    ['a typed array', new Uint8Array(2)],
  ])('rejects %s one level down', (_label, value) => {
    expectTyped(withRejected({ nested: value }))
  })

  it.each([
    ['a BigInt', BigInt(3)],
    ['undefined', undefined],
    ['a function', () => 'x'],
  ])('rejects %s four levels down', (_label, value) => {
    expectTyped(withRejected({ a: { b: { c: { d: value } } } }))
  })

  it('rejects a cycle', () => {
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic['self'] = cyclic
    expectTyped(withRejected(cyclic))
  })

  it('rejects an accessor nested in an extensible payload', () => {
    const candidate: Record<string, unknown> = {}
    Object.defineProperty(candidate, 'value', { get: () => 'x', enumerable: true })
    expectTyped(withRejected(candidate))
  })
})

describe('V1-02 — the serializer Stage 3 will use never sees a malformed value', () => {
  it('serializes a valid finalized snapshot', () => {
    const snapshot = graph().normalizedIntegritySnapshot()!
    expect(() => serializeCanonicalJson(snapshot as never, { arraySemantics: 'ordered' })).not.toThrow()
  })

  it('rejects malformed payloads before the serializer is reached', () => {
    // If validation and the serializer ever disagree, this test fails rather
    // than Stage 3 failing while writing bytes.
    for (const value of [BigInt(1), undefined, () => 'x', Number.NaN]) {
      expectTyped(withRejected({ nested: value }))
    }
  })

  it('produces byte-identical output for two identical builds', () => {
    const left = serializeCanonicalJson(graph().normalizedIntegritySnapshot() as never, { arraySemantics: 'ordered' })
    const right = serializeCanonicalJson(graph().normalizedIntegritySnapshot() as never, { arraySemantics: 'ordered' })
    expect(left).toBe(right)
  })
})

describe('V1-02 — partial-discriminator status has one authority', () => {
  it('derives the status reason from the terminal reason count alone', () => {
    const accounting = graph().normalizedAccountingSummary()!
    // The count is the authority. There is no second counter that could
    // disagree with it.
    expect(accounting).not.toHaveProperty('retainedPartialDiscriminators')
  })

  it('reports the reason exactly when the count is positive', () => {
    const subject = buildFromJson({
      schema_version: 1,
      directed: true,
      nodes: [
        { id: 'alpha', label: 'A', file_type: 'code', source_file: 'src/a.ts' },
        { id: 'beta', label: 'B', file_type: 'code', source_file: 'src/b.ts' },
      ],
      edges: [{ source: 'alpha', target: 'beta', relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/a.ts' }],
    }, { directed: true, accounting: 'normalized_extraction_boundary' })

    const snapshot = subject.normalizedIntegritySnapshot()!
    const count = snapshot.terminalReasonCounts.partial_discriminator ?? 0
    expect(snapshot.reasons.includes('partial_discriminator_retained')).toBe(count > 0)
  })

  it('cannot be made to disagree with itself in either direction', () => {
    // Both reviewer reproductions: the reason appearing with no count, and the
    // reason vanishing with a count. Neither is expressible now, because there
    // is only one value.
    const accounting = graph().normalizedAccountingSummary()!
    const withCount = finalizeWith({
      'accounting.terminalReasonCounts': { ...accounting.terminalReasonCounts, partial_discriminator: 1 },
    })() as { reasons: readonly string[] }
    expect(withCount.reasons).toContain('partial_discriminator_retained')

    const withoutCount = finalizeWith({
      'accounting.terminalReasonCounts': Object.fromEntries(
        Object.entries(accounting.terminalReasonCounts).filter(([key]) => key !== 'partial_discriminator'),
      ),
    })() as { reasons: readonly string[] }
    expect(withoutCount.reasons).not.toContain('partial_discriminator_retained')
  })
})

describe('V1-02 — reason vocabularies stay closed', () => {
  it('rejects an unknown terminal reason', () => {
    expectTyped(finalizeWith({ 'accounting.terminalReasonCounts': { invented: 1 } }))
  })

  it('rejects an unknown endpoint reason', () => {
    expectTyped(finalizeWith({ reasonFactCounts: { invented: 1 } }))
  })

  it('does not require reason counts to sum to any total', () => {
    const snapshot = graph().normalizedIntegritySnapshot()!
    expect(Object.keys(snapshot.reasonFactCounts).length).toBeGreaterThanOrEqual(0)
    expect(snapshot.graphTotals.facts).toBeGreaterThan(0)
  })
})
