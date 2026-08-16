import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import {
  UNREGISTERED_RELATION_AT_STORAGE_BOUNDARY,
  loadGraphArtifact,
  parseGraphArtifactV2,
  serializeGraphArtifactV2,
} from '../../src/contracts/graph-artifact.js'

/** The five relations that were silently deleting graph facts. */
const RESTORED_RELATIONS = ['controller_route', 'route_handler', 'related_to', 'covered_by', 'exports'] as const

function pair(): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })
  graph.addNode('a', {})
  graph.addNode('b', {})
  return graph
}

function serialize(graph: KnowledgeGraph): Buffer {
  return serializeGraphArtifactV2({
    graph,
    repositoryRevision: 'rev',
    generationMode: 'full',
    generatedAt: '2026-08-15T00:00:00.000Z',
  })
}

describe('restored producer relations', () => {
  for (const relation of RESTORED_RELATIONS) {
    it(`stores ${relation} as a traversable semantic fact`, () => {
      const graph = pair()

      const admission = graph.addEdge('a', 'b', { relation })

      expect(admission.status).toBe('stored')
      expect(graph.numberOfFacts()).toBe(1)
      expect(graph.numberOfEndpointPairs()).toBe(1)
      expect(graph.hasEdge('a', 'b')).toBe(true)
      expect(graph.relationsBetween('a', 'b')).toContain(relation)
      expect(graph.factsBetween('a', 'b')).toHaveLength(1)
      expect(graph.storageAdmissionSummary().unresolvedUnregisteredRelationCandidates).toBe(0)
    })
  }

  it('keeps distinct restored relations on one pair as distinct facts', () => {
    const graph = pair()
    for (const relation of RESTORED_RELATIONS) graph.addEdge('a', 'b', { relation })

    expect(graph.numberOfFacts()).toBe(RESTORED_RELATIONS.length)
    expect(graph.numberOfEndpointPairs()).toBe(1)
  })
})

describe('unregistered relation admission', () => {
  it('refuses the fact but records the attempt', () => {
    const graph = pair()

    const admission = graph.addEdge('a', 'b', { relation: 'future_relation_not_registered' })

    expect(admission.status).toBe('unresolved_degraded')
    expect(graph.numberOfFacts()).toBe(0)
    expect(graph.numberOfOccurrences()).toBe(0)
    expect(graph.numberOfEndpointPairs()).toBe(0)
    expect(graph.hasEdge('a', 'b')).toBe(false)
    expect(graph.successors('a')).toEqual([])
    expect(graph.storageAdmissionSummary()).toEqual({
      unresolvedUnregisteredRelationCandidates: 1,
      unregisteredRelationCounts: { future_relation_not_registered: 1 },
    })
  })

  it('records the attempt even when the caller ignores the returned disposition', () => {
    const graph = pair()

    // Deliberately discarding the result: this is the exact shape of the
    // original defect, where an accurate refusal was returned and dropped.
    void graph.addEdge('a', 'b', { relation: 'future_relation_not_registered' })

    expect(graph.storageAdmissionSummary().unresolvedUnregisteredRelationCandidates).toBe(1)
  })

  it('counts repeated and distinct candidates deterministically', () => {
    const graph = pair()
    graph.addEdge('a', 'b', { relation: 'zeta_unknown' })
    graph.addEdge('a', 'b', { relation: 'alpha_unknown' })
    graph.addEdge('a', 'b', { relation: 'zeta_unknown' })

    const summary = graph.storageAdmissionSummary()

    expect(summary.unresolvedUnregisteredRelationCandidates).toBe(3)
    expect(Object.keys(summary.unregisteredRelationCounts)).toEqual(['alpha_unknown', 'zeta_unknown'])
    expect(summary.unregisteredRelationCounts).toEqual({ alpha_unknown: 1, zeta_unknown: 2 })
  })

  it('keeps the total equal to the sum of its per-relation counts', () => {
    const graph = pair()
    for (const relation of ['one_unknown', 'two_unknown', 'one_unknown']) {
      graph.addEdge('a', 'b', { relation })
    }
    const summary = graph.storageAdmissionSummary()

    const sum = Object.values(summary.unregisteredRelationCounts).reduce((total, count) => total + count, 0)
    expect(summary.unresolvedUnregisteredRelationCandidates).toBe(sum)
  })

  it('returns a detached projection that cannot mutate the graph', () => {
    const graph = pair()
    graph.addEdge('a', 'b', { relation: 'frozen_unknown' })

    const summary = graph.storageAdmissionSummary()
    expect(() => {
      (summary.unregisteredRelationCounts as Record<string, number>).frozen_unknown = 99
    }).toThrow()
    expect(graph.storageAdmissionSummary().unregisteredRelationCounts.frozen_unknown).toBe(1)
  })

  it('survives copy so a copy never looks cleaner than its source', () => {
    const graph = pair()
    graph.addEdge('a', 'b', { relation: 'copied_unknown' })

    expect(graph.copy().storageAdmissionSummary()).toEqual(graph.storageAdmissionSummary())
  })
})

describe('artifact receipt carries the admission diagnostic', () => {
  it('asserts a zero rather than omitting the field', () => {
    const graph = pair()
    graph.addEdge('a', 'b', { relation: 'calls' })

    const receipt = (parseGraphArtifactV2(serialize(graph)) as { integrity_receipt: {
      status: string
      reasons: readonly string[]
      storage_admission: { unresolved_unregistered_relation_candidates: number }
    } }).integrity_receipt

    expect(receipt.storage_admission.unresolved_unregistered_relation_candidates).toBe(0)
    expect(receipt.reasons).not.toContain(UNREGISTERED_RELATION_AT_STORAGE_BOUNDARY)
    // Still degraded: full emission accounting remains unavailable regardless.
    expect(receipt.status).toBe('degraded')
  })

  it('discloses the reason and exact counts when candidates exist', () => {
    const graph = pair()
    graph.addEdge('a', 'b', { relation: 'calls' })
    graph.addEdge('a', 'b', { relation: 'future_relation_not_registered' })
    graph.addEdge('a', 'b', { relation: 'future_relation_not_registered' })

    const bytes = serialize(graph)
    const receipt = (parseGraphArtifactV2(bytes) as { integrity_receipt: {
      status: string
      reasons: readonly string[]
      storage_admission: {
        unresolved_unregistered_relation_candidates: number
        unregistered_relation_counts: Record<string, number>
      }
    } }).integrity_receipt

    expect(receipt.status).toBe('degraded')
    expect(receipt.reasons).toContain(UNREGISTERED_RELATION_AT_STORAGE_BOUNDARY)
    expect(receipt.storage_admission.unresolved_unregistered_relation_candidates).toBe(2)
    expect(receipt.storage_admission.unregistered_relation_counts).toEqual({ future_relation_not_registered: 2 })
    // The refused candidates created no fact and no topology.
    expect((parseGraphArtifactV2(bytes) as { facts: readonly unknown[] }).facts).toHaveLength(1)
  })

  it('round-trips the diagnostic through a load', () => {
    const graph = pair()
    graph.addEdge('a', 'b', { relation: 'calls' })
    graph.addEdge('a', 'b', { relation: 'future_relation_not_registered' })

    const loaded = loadGraphArtifact(serialize(graph))

    expect(loaded.receipt.storage_admission.unresolved_unregistered_relation_candidates).toBe(1)
    expect(loaded.receipt.reasons).toContain(UNREGISTERED_RELATION_AT_STORAGE_BOUNDARY)
  })

  it('stays byte-identical across repeated serialization', () => {
    const graph = pair()
    graph.addEdge('a', 'b', { relation: 'beta_unknown' })
    graph.addEdge('a', 'b', { relation: 'alpha_unknown' })

    expect(serialize(graph)).toEqual(serialize(graph))
  })

  it('rejects an artifact whose admission total disagrees with its counts', () => {
    const graph = pair()
    graph.addEdge('a', 'b', { relation: 'calls' })
    graph.addEdge('a', 'b', { relation: 'tampered_unknown' })
    const text = serialize(graph).toString('utf8')

    const tampered = text.replace(
      '"unresolved_unregistered_relation_candidates":1',
      '"unresolved_unregistered_relation_candidates":7',
    )
    expect(tampered).not.toBe(text)
    // parseGraphArtifactV2 checks payload shape; receipt invariants are
    // enforced where the receipt is actually interpreted, on load.
    expect(() => loadGraphArtifact(tampered)).toThrow(/disagrees with its per-relation counts/)
  })

  it('rejects an artifact missing the admission field entirely', () => {
    const graph = pair()
    graph.addEdge('a', 'b', { relation: 'calls' })
    const text = serialize(graph).toString('utf8')

    const stripped = text.replace(
      /,"storage_admission":\{[^}]*\{[^}]*\}[^}]*\}/,
      '',
    )
    expect(stripped).not.toBe(text)
    expect(() => loadGraphArtifact(stripped)).toThrow(/storage_admission/)
  })
})
