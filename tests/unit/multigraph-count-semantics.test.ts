import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { graphStructureMetrics } from '../../src/pipeline/analyze.js'

/**
 * The contract fixture: two semantic facts, one endpoint pair, two occurrences.
 *
 * Every count surface must state which of the three it reports. They agree on
 * the self-graph today only because multiplicity there is exactly 1.000, which
 * is why an undeclared divergence could sit unnoticed.
 */
function contractGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })
  graph.addNode('a', { label: 'Alpha()', source_file: 'a.ts', file_type: 'code', community: 0 })
  graph.addNode('b', { label: 'Beta()', source_file: 'b.ts', file_type: 'code', community: 0 })

  for (const [relation, site] of [['calls', 'site-one'], ['injects', 'site-two']] as const) {
    graph.addEdge('a', 'b', { relation, confidence: 'EXTRACTED' }, {
      recordOccurrence: true,
      occurrence: {
        owner: { adapterId: 'test-adapter', strategy: 'probe' },
        sourceFile: 'a.ts',
        adapterEvidenceKey: site,
      },
    })
  }
  return graph
}

describe('count semantics at N > 1', () => {
  it('separates facts, endpoint pairs and occurrences on the graph itself', () => {
    const graph = contractGraph()

    expect(graph.numberOfFacts()).toBe(2)
    expect(graph.numberOfEndpointPairs()).toBe(1)
    expect(graph.numberOfOccurrences()).toBe(2)
  })

  it('keeps GraphStructureMetrics.total_edges an endpoint-pair count', () => {
    const metrics = graphStructureMetrics(contractGraph())

    // Historically a topology measure; preserved rather than switched to facts.
    expect(metrics.total_edges).toBe(1)
    expect(metrics.total_endpoint_pairs).toBe(1)
  })

  it('pins total_edges as an exact alias of total_endpoint_pairs', () => {
    const metrics = graphStructureMetrics(contractGraph())

    expect(metrics.total_edges).toBe(metrics.total_endpoint_pairs)
  })
})

describe('the two "edges" surfaces are allowed to disagree', () => {
  it('reports 1 structural edge and 2 semantic facts for the same graph', () => {
    const graph = contractGraph()
    const metrics = graphStructureMetrics(graph)

    // This is the divergence, made deliberate: both were called "edges", and
    // both were right about different things.
    expect(metrics.total_edges).toBe(1)
    expect(graph.numberOfFacts()).toBe(2)
    expect(metrics.total_edges).not.toBe(graph.numberOfFacts())
  })

  it('collapses to the same number only when multiplicity is one', () => {
    const single = new KnowledgeGraph({ directed: true })
    single.addNode('a', { label: 'Alpha()', source_file: 'a.ts', file_type: 'code', community: 0 })
    single.addNode('b', { label: 'Beta()', source_file: 'b.ts', file_type: 'code', community: 0 })
    single.addEdge('a', 'b', { relation: 'calls', confidence: 'EXTRACTED' })

    // The historical state, and the reason the divergence went unnoticed.
    expect(graphStructureMetrics(single).total_edges).toBe(single.numberOfFacts())
  })
})
