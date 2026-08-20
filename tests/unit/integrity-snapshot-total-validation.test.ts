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

function graph(): KnowledgeGraph {
  return buildFromJson(extraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
}

function finalizeWith(overrides: Record<string, unknown>): () => unknown {
  const g = graph()
  const accounting = g.normalizedAccountingSummary()!
  const patched = { ...accounting } as Record<string, unknown>
  const top: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(overrides)) {
    if (key.startsWith('accounting.')) patched[key.slice('accounting.'.length)] = value
    else top[key] = value
  }
  const input = {
    accountingResult: patched,
    facts: g.numberOfFacts(),
    occurrences: g.numberOfOccurrences(),
    endpointPairs: g.numberOfEndpointPairs(),
    endpointIdentityMatrix: g.endpointIdentityMatrix(),
    reasonFactCounts: g.endpointReasonFactSummary(),
    storageAdmission: g.storageAdmissionSummary(),
    ...top,
  }
  return () => finalizeNormalizedIntegritySnapshot(input as never)
}

/** Every rejection must be the typed graph invariant, never a raw TypeError. */
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
  expect(thrown).not.toBeInstanceOf(RangeError)
}

function record(): Record<string, unknown> {
  return { ...graph().normalizedAccountingSummary()!.unresolvedRecords[0]! } as Record<string, unknown>
}

const withRecord = (mutate: (record: Record<string, unknown>) => void): () => unknown => {
  const subject = record()
  mutate(subject)
  return finalizeWith({ 'accounting.unresolvedRecords': [subject] })
}

describe('V1 — closed schemas reject unknown fields', () => {
  it('rejects an unknown verification-target field', () => {
    expectTyped(withRecord((r) => {
      r['verificationTargets'] = [{ file: 'src/a.ts', reason: 'missing_target_endpoint', note: 'x' }]
    }))
  })

  it('rejects an unknown record field', () => {
    expectTyped(withRecord((r) => { r['annotation'] = 'x' }))
  })

  it('rejects an unknown storage-admission field', () => {
    expectTyped(finalizeWith({
      storageAdmission: {
        unresolvedUnregisteredRelationCandidates: 1,
        unregisteredRelationCounts: { totally_unregistered: 1 },
        extra: 1,
      },
    }))
  })

  it('rejects an unknown recordRetention kind', () => {
    const accounting = graph().normalizedAccountingSummary()!
    expectTyped(finalizeWith({
      'accounting.recordRetention': { ...accounting.recordRetention, invented: accounting.recordRetention.unresolved },
    }))
  })
})

describe('V1 — verification-target ranges are validated exactly', () => {
  const target = (range: unknown): unknown => (
    [{ file: 'src/a.ts', reason: 'missing_target_endpoint', range }]
  )

  it('accepts a well-formed range', () => {
    expect(withRecord((r) => {
      r['verificationTargets'] = target({ start: { line: 1, column: 0 }, end: { line: 2, column: 4 } })
    })()).toBeDefined()
  })

  it.each([
    ['a missing end', { start: { line: 1, column: 0 } }],
    ['an unknown range field', { start: { line: 1, column: 0 }, end: { line: 2, column: 0 }, note: 'x' }],
    ['an unknown position field', { start: { line: 1, column: 0, offset: 3 }, end: { line: 2, column: 0 } }],
    ['a negative line', { start: { line: -1, column: 0 }, end: { line: 2, column: 0 } }],
    ['a fractional column', { start: { line: 1, column: 0.5 }, end: { line: 2, column: 0 } }],
    ['a non-numeric line', { start: { line: '1', column: 0 }, end: { line: 2, column: 0 } }],
    ['an end before its start', { start: { line: 5, column: 0 }, end: { line: 2, column: 0 } }],
    ['an end column before its start on one line', { start: { line: 1, column: 9 }, end: { line: 1, column: 2 } }],
    ['a non-object range', 'lines 1-2'],
  ])('rejects %s', (_label, range) => {
    expectTyped(withRecord((r) => { r['verificationTargets'] = target(range) }))
  })
})

describe('V1 — identities must name what they claim to', () => {
  it.each([
    ['a truncated hash', 'uc_abc123'],
    ['a wrong prefix', 'zz_0000000000000000000000000000000000000000000000000000000000000000'],
    ['another record class prefix', 'rc_0000000000000000000000000000000000000000000000000000000000000000'],
    ['uppercase hex', 'uc_ABCDEF0000000000000000000000000000000000000000000000000000000000'],
    ['a non-string', 42],
  ])('rejects a record id that is %s', (_label, id) => {
    expectTyped(withRecord((r) => { r['id'] = id }))
  })

  it.each([
    ['a wrong prefix', 'uc_0000000000000000000000000000000000000000000000000000000000000000'],
    ['a truncated hash', 'cf_00'],
  ])('rejects a candidate fingerprint that has %s', (_label, fingerprint) => {
    expectTyped(withRecord((r) => { r['candidateFingerprint'] = fingerprint }))
  })

  it('rederives the fingerprint and rejects one that disagrees with its own projection', () => {
    // A well-formed fingerprint that simply belongs to a different candidate.
    expectTyped(withRecord((r) => {
      r['candidateFingerprint'] = `cf_${'a'.repeat(64)}`
    }))
  })

  it('rejects a projection edited without its fingerprint', () => {
    expectTyped(withRecord((r) => { r['target'] = 'somewhere_else' }))
  })
})

describe('V1 — reason vocabularies are closed', () => {
  it('rejects an unknown endpoint reason key', () => {
    expectTyped(finalizeWith({ reasonFactCounts: { invented_reason: 1 } }))
  })

  it('rejects an unknown terminal reason key', () => {
    expectTyped(finalizeWith({ 'accounting.terminalReasonCounts': { invented_reason: 1 } }))
  })

  it('does not require reason counts to sum to any total', () => {
    // Overlapping diagnostics: one fact can carry several reasons, so a sum
    // constraint would be wrong, not merely strict.
    const snapshot = graph().normalizedIntegritySnapshot()!
    const total = Object.values(snapshot.reasonFactCounts).reduce((a, b) => a + (b ?? 0), 0)
    expect(total).toBeGreaterThanOrEqual(0)
    expect(snapshot.graphTotals.facts).toBeGreaterThanOrEqual(0)
  })
})

describe('V1 — non-JSON values cannot attach', () => {
  it('rejects a BigInt nested in a rejected projection', () => {
    const rejected = {
      kind: 'rejected',
      id: `rc_${'0'.repeat(64)}`,
      multiplicity: 1,
      reasons: ['malformed_candidate'],
      verificationTargets: [],
      candidateFingerprint: `cf_${'0'.repeat(64)}`,
      sanitizedCandidate: { nested: { count: BigInt(3) } },
    }
    expectTyped(finalizeWith({
      'accounting.rejectedRecords': [rejected],
      'accounting.recordRetention': {
        ...graph().normalizedAccountingSummary()!.recordRetention,
        rejected: { retained: 1, total: 1, omitted: 0, truncated: false },
      },
    }))
  })

  it.each([
    ['a function', () => 'x'],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a Set', new Set()],
    ['a typed array', new Uint8Array(2)],
  ])('rejects %s nested in a rejected projection', (_label, value) => {
    const rejected = {
      kind: 'rejected',
      id: `rc_${'0'.repeat(64)}`,
      multiplicity: 1,
      reasons: ['malformed_candidate'],
      verificationTargets: [],
      candidateFingerprint: `cf_${'0'.repeat(64)}`,
      sanitizedCandidate: { nested: { value } },
    }
    expectTyped(finalizeWith({
      'accounting.rejectedRecords': [rejected],
      'accounting.recordRetention': {
        ...graph().normalizedAccountingSummary()!.recordRetention,
        rejected: { retained: 1, total: 1, omitted: 0, truncated: false },
      },
    }))
  })

  it('rejects a cyclic projection', () => {
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic['self'] = cyclic
    const rejected = {
      kind: 'rejected',
      id: `rc_${'0'.repeat(64)}`,
      multiplicity: 1,
      reasons: ['malformed_candidate'],
      verificationTargets: [],
      candidateFingerprint: `cf_${'0'.repeat(64)}`,
      sanitizedCandidate: cyclic,
    }
    expectTyped(finalizeWith({
      'accounting.rejectedRecords': [rejected],
      'accounting.recordRetention': {
        ...graph().normalizedAccountingSummary()!.recordRetention,
        rejected: { retained: 1, total: 1, omitted: 0, truncated: false },
      },
    }))
  })

  it('rejects a private path nested below the top level of a projection', () => {
    const rejected = {
      kind: 'rejected',
      id: `rc_${'0'.repeat(64)}`,
      multiplicity: 1,
      reasons: ['malformed_candidate'],
      verificationTargets: [],
      candidateFingerprint: `cf_${'0'.repeat(64)}`,
      sanitizedCandidate: { outer: { inner: '/Users/reviewer/secret.ts' } },
    }
    expectTyped(finalizeWith({
      'accounting.rejectedRecords': [rejected],
      'accounting.recordRetention': {
        ...graph().normalizedAccountingSummary()!.recordRetention,
        rejected: { retained: 1, total: 1, omitted: 0, truncated: false },
      },
    }))
  })
})

describe('V1 — a finalized snapshot survives the serializer Stage 3 will use', () => {
  it('serializes canonically without throwing', () => {
    // The probe: whatever the guards accept, the real serializer must also
    // accept. If these two ever disagree, Stage 3 would attach successfully and
    // then fail while writing bytes.
    const snapshot = graph().normalizedIntegritySnapshot()!
    expect(() => serializeCanonicalJson(snapshot as never, { arraySemantics: 'ordered' })).not.toThrow()
  })

  it('produces byte-identical output for two identical builds', () => {
    const left = serializeCanonicalJson(graph().normalizedIntegritySnapshot() as never, { arraySemantics: 'ordered' })
    const right = serializeCanonicalJson(graph().normalizedIntegritySnapshot() as never, { arraySemantics: 'ordered' })
    expect(left).toBe(right)
  })

  it('carries no absolute path anywhere in its serialized form', () => {
    const serialized = serializeCanonicalJson(
      graph().normalizedIntegritySnapshot() as never,
      { arraySemantics: 'ordered' },
    )
    expect(serialized).not.toMatch(/"\/[A-Za-z]/)
    expect(serialized).not.toContain('\\\\')
  })
})

describe('V1 — a genuine snapshot still finalizes', () => {
  it('accepts the real production payload', () => {
    expect(graph().normalizedIntegritySnapshot()).not.toBeNull()
  })

  it('finalizes with no overrides applied', () => {
    expect(finalizeWith({})()).toBeDefined()
  })
})
