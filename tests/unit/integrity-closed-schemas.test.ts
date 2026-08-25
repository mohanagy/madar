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

/**
 * Every malformed shape must fail as the typed graph invariant, and no getter
 * may be invoked to discover that it is a getter -- running caller code inside
 * validation is how a throwing accessor escaped as a raw TypeError.
 */
function expectTypedRejection(run: () => unknown, probe?: { invoked: boolean }): void {
  let thrown: unknown
  try {
    run()
  } catch (error) {
    thrown = error
  }
  expect(thrown, 'expected a rejection').toBeDefined()
  expect(thrown).toBeInstanceOf(GraphIntegrityInvariantError)
  expect(thrown).not.toBeInstanceOf(TypeError)
  if (probe !== undefined) expect(probe.invoked, 'a getter was invoked during validation').toBe(false)
}

/** The nine ways a closed schema can be violated, applied to any object. */
function corruptions(sound: Record<string, unknown>, requiredKey: string): Array<[string, unknown]> {
  const withGetter = { ...sound }
  Object.defineProperty(withGetter, requiredKey, {
    get: () => { throw new Error('getter should never run') },
    enumerable: true,
    configurable: true,
  })
  const withSetter = { ...sound }
  Object.defineProperty(withSetter, requiredKey, {
    set: () => undefined,
    get: () => sound[requiredKey],
    enumerable: true,
    configurable: true,
  })
  const inherited = Object.create({ [requiredKey]: sound[requiredKey] }) as Record<string, unknown>
  for (const [key, value] of Object.entries(sound)) {
    if (key !== requiredKey) inherited[key] = value
  }
  const missing = { ...sound }
  delete missing[requiredKey]
  const symbolKeyed = { ...sound }
  Object.defineProperty(symbolKeyed, Symbol('hidden'), { value: BigInt(1), enumerable: true })

  return [
    ['a custom prototype', Object.assign(Object.create({ custom: true }), sound)],
    ['a symbol key', symbolKeyed],
    ['a getter', withGetter],
    ['a setter', withSetter],
    ['an unknown field', { ...sound, invented: 'x' }],
    ['a missing required field', missing],
    ['an inherited required field', inherited],
    ['an array', Object.assign([], sound)],
    ['null', null],
  ]
}

function unresolvedRecord(): Record<string, unknown> {
  return { ...graph().normalizedAccountingSummary()!.unresolvedRecords[0]! } as Record<string, unknown>
}

describe('V1-01 — the unresolved record schema is closed', () => {
  it.each(corruptions(unresolvedRecord(), 'kind'))('rejects %s', (_label, record) => {
    expectTypedRejection(finalizeWith({ 'accounting.unresolvedRecords': [record] }))
  })

  it('never invokes a throwing discriminant getter', () => {
    // The exact reviewer case: `kind` as a throwing getter escaped as a raw
    // TypeError because the value was read before the descriptor was inspected.
    const probe = { invoked: false }
    const record = { ...unresolvedRecord() }
    Object.defineProperty(record, 'kind', {
      get: () => { probe.invoked = true; throw new Error('boom') },
      enumerable: true,
      configurable: true,
    })
    expectTypedRejection(finalizeWith({ 'accounting.unresolvedRecords': [record] }), probe)
  })

  it('rejects a record copied onto a custom prototype', () => {
    const record = Object.assign(Object.create({ custom: true }), unresolvedRecord())
    expectTypedRejection(finalizeWith({ 'accounting.unresolvedRecords': [record] }))
  })

  it('rejects a symbol-keyed record carrying a BigInt', () => {
    const record = { ...unresolvedRecord() }
    Object.defineProperty(record, Symbol('leak'), { value: BigInt(1), enumerable: true })
    expectTypedRejection(finalizeWith({ 'accounting.unresolvedRecords': [record] }))
  })
})

describe('V1-01 — the verification-target schema is closed', () => {
  const sound = { file: 'src/alpha.ts', reason: 'missing_target_endpoint' }
  it.each(corruptions(sound, 'file'))('rejects %s', (_label, target) => {
    const record = { ...unresolvedRecord(), verificationTargets: [target] }
    expectTypedRejection(finalizeWith({ 'accounting.unresolvedRecords': [record] }))
  })
})

describe('V1-01 — the source range and position schemas are closed', () => {
  const range = { start: { line: 1, column: 0 }, end: { line: 2, column: 0 } }

  it.each(corruptions(range, 'start'))('rejects a range with %s', (_label, corrupted) => {
    const record = {
      ...unresolvedRecord(),
      verificationTargets: [{ file: 'src/alpha.ts', reason: 'missing_target_endpoint', range: corrupted }],
    }
    expectTypedRejection(finalizeWith({ 'accounting.unresolvedRecords': [record] }))
  })

  it.each(corruptions({ line: 1, column: 0 }, 'line'))('rejects a position with %s', (_label, position) => {
    const record = {
      ...unresolvedRecord(),
      verificationTargets: [{
        file: 'src/alpha.ts',
        reason: 'missing_target_endpoint',
        range: { start: position, end: { line: 2, column: 0 } },
      }],
    }
    expectTypedRejection(finalizeWith({ 'accounting.unresolvedRecords': [record] }))
  })
})

describe('V1-01 — the retention container and its entries are closed', () => {
  const retention = { retained: 0, total: 0, omitted: 0, truncated: false }

  it.each(corruptions(retention, 'retained'))('rejects a DetailRetention with %s', (_label, corrupted) => {
    const accounting = graph().normalizedAccountingSummary()!
    expectTypedRejection(finalizeWith({
      'accounting.recordRetention': { ...accounting.recordRetention, rejected: corrupted },
    }))
  })

  it.each(corruptions(
    { unresolved: retention, rejected: retention, conflicting: retention },
    'rejected',
  ))('rejects a recordRetention container with %s', (_label, container) => {
    expectTypedRejection(finalizeWith({ 'accounting.recordRetention': container }))
  })
})

describe('V1-01 — the storage-admission summary is closed', () => {
  const sound = {
    unresolvedUnregisteredRelationCandidates: 1,
    unregisteredRelationCounts: { totally_unregistered: 1 },
  }
  it.each(corruptions(sound, 'unregisteredRelationCounts'))('rejects %s', (_label, admission) => {
    expectTypedRejection(finalizeWith({ storageAdmission: admission }))
  })
})

describe('V1-01 — the endpoint matrix and its rows are closed', () => {
  function mutableMatrix(): Record<string, Record<string, number>> {
    return JSON.parse(JSON.stringify(graph().endpointIdentityMatrix())) as Record<string, Record<string, number>>
  }

  it('rejects a matrix row on a custom prototype', () => {
    // The exact reviewer case: rows were only checked for being objects.
    const matrix = mutableMatrix()
    matrix['legacy'] = Object.assign(Object.create({ custom: true }), matrix['legacy'])
    expectTypedRejection(finalizeWith({ endpointIdentityMatrix: matrix }))
  })

  it('rejects a matrix row carrying a getter', () => {
    const probe = { invoked: false }
    const matrix = mutableMatrix()
    const row = { ...matrix['legacy'] }
    Object.defineProperty(row, 'legacy', {
      get: () => { probe.invoked = true; return 0 },
      enumerable: true,
      configurable: true,
    })
    matrix['legacy'] = row as never
    expectTypedRejection(finalizeWith({ endpointIdentityMatrix: matrix }), probe)
  })

  it('rejects a matrix row with a symbol key', () => {
    const matrix = mutableMatrix()
    Object.defineProperty(matrix['legacy']!, Symbol('leak'), { value: 1, enumerable: true })
    expectTypedRejection(finalizeWith({ endpointIdentityMatrix: matrix }))
  })

  it('rejects a matrix on a custom prototype', () => {
    expectTypedRejection(finalizeWith({
      endpointIdentityMatrix: Object.assign(Object.create({ custom: true }), mutableMatrix()),
    }))
  })
})

describe('V1-01 — the terminal counts container is closed', () => {
  it.each(corruptions(
    graph().normalizedAccountingSummary()!.counts as unknown as Record<string, unknown>,
    'unresolved',
  ))('rejects terminal counts with %s', (_label, counts) => {
    expectTypedRejection(finalizeWith({ 'accounting.counts': counts }))
  })
})

describe('V1-01 — a sound payload still attaches', () => {
  it('accepts the real production snapshot', () => {
    expect(graph().normalizedIntegritySnapshot()).not.toBeNull()
  })

  it('leaves the graph unattached when finalization rejects', () => {
    const target = new KnowledgeGraph({ directed: true })
    const accounting = { ...graph().normalizedAccountingSummary() } as Record<string, unknown>
    accounting['counts'] = Object.assign(Object.create({ custom: true }), accounting['counts'])
    expect(() => target.attachNormalizedAccounting(accounting as never)).toThrow(GraphIntegrityInvariantError)
    expect(target.normalizedAccountingSummary()).toBeNull()
    expect(target.normalizedIntegritySnapshot()).toBeNull()
  })
})

describe('V1-01 — a missing required key is named, not merely rejected', () => {
  it('reports which field is missing rather than failing further downstream', () => {
    // Deleting a key is usually caught later, when something reads it and finds
    // undefined. That produces a rejection but not an explanation. The
    // required-key check is what turns it into a message naming the field.
    const record = { ...unresolvedRecord() }
    delete record['occurrenceRetention']
    let thrown: unknown
    try {
      finalizeWith({ 'accounting.unresolvedRecords': [record] })()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(GraphIntegrityInvariantError)
    expect((thrown as Error).message).toContain('missing required field')
    expect((thrown as Error).message).toContain('occurrenceRetention')
  })

  it('names a missing key on a nested closed schema too', () => {
    const record = {
      ...unresolvedRecord(),
      verificationTargets: [{ file: 'src/alpha.ts' }],
    }
    let thrown: unknown
    try {
      finalizeWith({ 'accounting.unresolvedRecords': [record] })()
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error).message).toContain('missing required field')
    expect((thrown as Error).message).toContain('reason')
  })
})
