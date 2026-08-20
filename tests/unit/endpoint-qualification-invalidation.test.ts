import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
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
    ],
  }
}

function withSnapshot(): KnowledgeGraph {
  const graph = buildFromJson(extraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
  expect(graph.normalizedIntegritySnapshot(), 'fixture must start with a snapshot').not.toBeNull()
  return graph
}

const QUALIFY = {
  stable: { status: 'stable', reasons: [] },
  contextBound: { status: 'context_bound', reasons: ['source_location_derived'] },
  unknown: { status: 'unknown', reasons: ['identity_policy_not_audited'] },
} as const

/** Node state is both halves: stored attributes and endpoint qualification. */
function stateOf(graph: KnowledgeGraph): string {
  return JSON.stringify({
    nodes: graph.nodeIds().sort().map((id) => [id, graph.nodeAttributes(id), graph.nodeEndpointIdentity(id)]),
    facts: graph.numberOfFacts(),
    occurrences: graph.numberOfOccurrences(),
    matrix: graph.endpointIdentityMatrix(),
  })
}

describe('V3 — a qualification change is a state change', () => {
  it.each([
    ['stable to context_bound', QUALIFY.stable, QUALIFY.contextBound],
    ['context_bound to unknown', QUALIFY.contextBound, QUALIFY.unknown],
    ['unknown to stable', QUALIFY.unknown, QUALIFY.stable],
  ])('invalidates on %s', (_label, from, to) => {
    const graph = withSnapshot()
    graph.addNode('gamma', { label: 'G', endpointIdentity: from })
    const reattached = withSnapshot()
    reattached.addNode('alpha', { ...reattached.nodeAttributes('alpha'), endpointIdentity: from })
    expect(reattached.normalizedIntegritySnapshot()).toBeNull()

    // The case the review found: attributes identical, qualification different.
    const subject = withSnapshot()
    const attributes = { ...subject.nodeAttributes('alpha') }
    subject.addNode('alpha', { ...attributes, endpointIdentity: to })
    expect(subject.normalizedIntegritySnapshot()).toBeNull()
  })

  it('invalidates when an absent qualification becomes explicit', () => {
    const graph = withSnapshot()
    const attributes = { ...graph.nodeAttributes('alpha') }
    // The fixture declares no endpointIdentity, so alpha holds the undeclared
    // qualification. Declaring one explicitly is a real change even though the
    // stored attributes are byte-identical.
    graph.addNode('alpha', { ...attributes, endpointIdentity: QUALIFY.stable })
    expect(graph.normalizedIntegritySnapshot()).toBeNull()
  })

  it('invalidates on an attribute-only change', () => {
    const graph = withSnapshot()
    graph.addNode('alpha', { ...graph.nodeAttributes('alpha'), label: 'Renamed' })
    expect(graph.normalizedIntegritySnapshot()).toBeNull()
  })

  it('invalidates on a new node', () => {
    const graph = withSnapshot()
    graph.addNode('gamma', {})
    expect(graph.normalizedIntegritySnapshot()).toBeNull()
  })
})

describe('V3 — an identical re-add is still a no-op', () => {
  /** Both halves of node state, as addNode itself would receive them. */
  function fullAttributes(graph: KnowledgeGraph, id: string): Record<string, unknown> {
    return { ...graph.nodeAttributes(id), endpointIdentity: graph.nodeEndpointIdentity(id) }
  }

  it('preserves the snapshot when both halves are unchanged', () => {
    const graph = withSnapshot()
    const snapshot = graph.normalizedIntegritySnapshot()
    graph.addNode('alpha', fullAttributes(graph, 'alpha'))
    expect(graph.normalizedIntegritySnapshot()).toBe(snapshot)
  })

  it('preserves the snapshot when an explicit qualification is re-declared identically', () => {
    const graph = withSnapshot()
    graph.addNode('gamma', { label: 'G', endpointIdentity: QUALIFY.contextBound })
    const reattached = withSnapshot()
    reattached.addNode('gamma', { label: 'G', endpointIdentity: QUALIFY.contextBound })
    const snapshot = reattached.normalizedIntegritySnapshot()
    reattached.addNode('gamma', { label: 'G', endpointIdentity: QUALIFY.contextBound })
    expect(reattached.normalizedIntegritySnapshot()).toBe(snapshot)
  })

  it('treats dropping an explicit qualification as a change, not a round-trip', () => {
    // nodeAttributes() deliberately omits endpointIdentity, so re-adding its
    // result alone resets the qualification to undeclared. That is a real state
    // change and must invalidate. Before this fix it silently reset the
    // qualification while reporting the node unchanged, which is precisely how
    // a stale snapshot survived.
    const graph = withSnapshot()
    graph.addNode('gamma', { label: 'G', endpointIdentity: QUALIFY.stable })
    const reattached = withSnapshot()
    reattached.addNode('gamma', { label: 'G', endpointIdentity: QUALIFY.stable })

    reattached.addNode('gamma', reattached.nodeAttributes('gamma'))

    expect(reattached.nodeEndpointIdentity('gamma')).not.toStrictEqual(QUALIFY.stable)
    expect(reattached.normalizedIntegritySnapshot()).toBeNull()
  })

  it('copy carries qualification, so a copied graph is not silently requalified', () => {
    const graph = withSnapshot()
    graph.addNode('gamma', { label: 'G', endpointIdentity: QUALIFY.contextBound })
    expect(graph.copy().nodeEndpointIdentity('gamma')).toStrictEqual(QUALIFY.contextBound)
  })
})

describe('V3 — a refused node changes nothing', () => {
  it.each([
    ['a malformed status', { endpointIdentity: { status: 'invented', reasons: [] } }],
    ['non-array reasons', { endpointIdentity: { status: 'stable', reasons: 'none' } }],
    ['a non-object qualification', { endpointIdentity: 'stable' }],
  ])('preserves graph and snapshot when validation rejects %s', (_label, attributes) => {
    const graph = withSnapshot()
    const snapshot = graph.normalizedIntegritySnapshot()
    const before = stateOf(graph)

    expect(() => graph.addNode('alpha', { ...graph.nodeAttributes('alpha'), ...attributes })).toThrow()

    // Nothing written: not the attributes, not the qualification, not the snapshot.
    expect(stateOf(graph)).toBe(before)
    expect(graph.normalizedIntegritySnapshot()).toBe(snapshot)
  })

  it('does not create a node that failed validation', () => {
    const graph = withSnapshot()
    expect(() => graph.addNode('delta', { endpointIdentity: { status: 'invented', reasons: [] } })).toThrow()
    expect(graph.hasNode('delta')).toBe(false)
  })
})

describe('V3 — existing facts keep the qualification they captured', () => {
  it('leaves stored facts and the matrix unchanged when a node is requalified', () => {
    // A fact captures its endpoint qualification at admission, and the matrix
    // and reason counts accumulate from that captured value. Requalifying a
    // node therefore changes what FUTURE facts would record without making any
    // stored fact disagree with the counters derived from it.
    const graph = withSnapshot()
    const factsBefore = graph.factRecords().map((record) => record.fact.endpointIdentity)
    const matrixBefore = graph.endpointIdentityMatrix()

    graph.addNode('alpha', { ...graph.nodeAttributes('alpha'), endpointIdentity: QUALIFY.unknown })

    expect(graph.factRecords().map((record) => record.fact.endpointIdentity)).toStrictEqual(factsBefore)
    expect(graph.endpointIdentityMatrix()).toStrictEqual(matrixBefore)
    // The graph state changed, so the snapshot must not outlive it.
    expect(graph.normalizedIntegritySnapshot()).toBeNull()
  })

  it('reports the new qualification for the node itself', () => {
    const graph = withSnapshot()
    graph.addNode('alpha', { ...graph.nodeAttributes('alpha'), endpointIdentity: QUALIFY.unknown })
    expect(graph.nodeEndpointIdentity('alpha')).toStrictEqual(QUALIFY.unknown)
  })

  it('applies the new qualification to a fact admitted afterwards', () => {
    const graph = withSnapshot()
    graph.addNode('gamma', { endpointIdentity: QUALIFY.unknown })
    graph.addEdge('alpha', 'gamma', { relation: 'calls', confidence: 'EXTRACTED' })
    const added = graph.factRecords().find((record) => record.fact.target === 'gamma')!
    expect(added.fact.endpointIdentity.target.status).toBe('unknown')
  })
})
