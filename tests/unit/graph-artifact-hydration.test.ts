import { describe, expect, it } from 'vitest'

import {
  loadGraphArtifact,
  serializeGraphArtifactV2,
} from '../../src/contracts/graph-artifact.js'
import { KnowledgeGraph, artifactHydrationToken } from '../../src/contracts/graph.js'

function graphWith(relations: readonly string[]): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })
  graph.addNode('a', { label: 'Alpha', source_file: 'a.ts' })
  graph.addNode('b', { label: 'Beta', source_file: 'b.ts' })
  for (const [index, relation] of relations.entries()) {
    graph.addEdge('a', 'b', { relation, confidence: 'EXTRACTED' }, {
      recordOccurrence: true,
      occurrence: {
        owner: { adapterId: 'test-adapter', strategy: 'probe' },
        sourceFile: 'a.ts',
        adapterEvidenceKey: `site-${index}`,
      },
    })
  }
  return graph
}

function artifact(graph: KnowledgeGraph): Buffer {
  return serializeGraphArtifactV2({
    graph,
    repositoryRevision: 'rev',
    generationMode: 'full',
    generatedAt: '2026-08-15T00:00:00.000Z',
  })
}

describe('verified hydration produces an identical graph', () => {
  it('matches normal construction on facts, pairs and occurrences', () => {
    const source = graphWith(['calls', 'injects', 'depends_on'])

    const loaded = loadGraphArtifact(artifact(source)).graph

    expect(loaded.numberOfFacts()).toBe(source.numberOfFacts())
    expect(loaded.numberOfEndpointPairs()).toBe(source.numberOfEndpointPairs())
    expect(loaded.numberOfOccurrences()).toBe(source.numberOfOccurrences())
    expect(loaded.numberOfNodes()).toBe(source.numberOfNodes())
  })

  it('matches normal construction on every index', () => {
    const source = graphWith(['calls', 'injects'])
    const loaded = loadGraphArtifact(artifact(source)).graph

    expect(loaded.factRecords().map(({ fact }) => fact.id))
      .toEqual(source.factRecords().map(({ fact }) => fact.id))
    expect(loaded.endpointEntries()).toEqual(source.endpointEntries())
    expect(loaded.relationsBetween('a', 'b')).toEqual(source.relationsBetween('a', 'b'))
    expect(loaded.successors('a')).toEqual(source.successors('a'))
    expect(loaded.predecessors('b')).toEqual(source.predecessors('b'))
    expect(loaded.uniqueNeighborDegree('a')).toBe(source.uniqueNeighborDegree('a'))
    expect(loaded.factsBetween('a', 'b')).toHaveLength(source.factsBetween('a', 'b').length)
  })

  it('re-serializes to identical bytes after a round trip', () => {
    const source = graphWith(['calls', 'injects'])
    const bytes = artifact(source)

    expect(artifact(loadGraphArtifact(bytes).graph)).toEqual(bytes)
  })

  it('carries the storage-admission diagnostic through hydration', () => {
    const source = graphWith(['calls'])
    source.addEdge('a', 'b', { relation: 'future_relation_not_registered' })

    const loaded = loadGraphArtifact(artifact(source))

    expect(loaded.receipt.storage_admission.unresolved_unregistered_relation_candidates).toBe(1)
  })
})

describe('hydration is not reachable as a bypass', () => {
  it('refuses a fabricated token', () => {
    const graph = graphWith(['calls'])
    const [record] = graph.factRecords()

    expect(() => graph.hydrateVerifiedFact(Symbol('forged'), record!.fact, {}))
      .toThrow(/reserved for the artifact loader/)
    expect(() => graph.hydrateVerifiedOccurrence(Symbol('forged'), graph.occurrenceEntries()[0]!))
      .toThrow(/reserved for the artifact loader/)
  })

  it('refuses to mint a token for any other caller', () => {
    expect(() => artifactHydrationToken('not-the-loader' as never))
      .toThrow(/reserved for the artifact loader/)
  })

  it('rejects a duplicate fact id carrying a different payload', () => {
    const graph = graphWith(['calls'])
    const token = artifactHydrationToken('graph-artifact-loader')
    const [record] = graph.factRecords()
    const tampered = { ...record!.fact, relation: 'injects' }

    expect(() => graph.hydrateVerifiedFact(token, tampered as never, {}))
      .toThrow(/carries a different payload/)
  })

  it('rejects an occurrence whose fact is absent', () => {
    const graph = graphWith(['calls'])
    const token = artifactHydrationToken('graph-artifact-loader')
    const orphan = { ...graph.occurrenceEntries()[0]!, factId: 'sf_' + '0'.repeat(64) }

    expect(() => graph.hydrateVerifiedOccurrence(token, orphan as never)).toThrow()
  })
})

describe('artifact tampering still fails after the optimization', () => {
  const tamper = (from: string, to: string): (() => unknown) => {
    const bytes = artifact(graphWith(['calls', 'injects']))
    const text = bytes.toString('utf8')
    const mutated = text.replace(from, to)
    expect(mutated).not.toBe(text)
    return () => loadGraphArtifact(mutated)
  }

  it('rejects a mutated fact id', () => {
    expect(tamper('"id":"sf_', '"id":"sf_0')).toThrow()
  })

  it('rejects a mutated fact source endpoint', () => {
    // Endpoints are identity-bearing, so the derived id stops matching.
    expect(tamper('"source":"a"', '"source":"b"')).toThrow()
  })

  it('rejects a mutated endpoint status', () => {
    expect(tamper('"status":"unknown"', '"status":"stable"')).toThrow()
  })

  it('rejects a mutated matrix cell', () => {
    expect(tamper('"unknown":{"stable":0', '"unknown":{"stable":7')).toThrow()
  })
})
