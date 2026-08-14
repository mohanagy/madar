import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { GraphRelationshipView } from '../../src/contracts/graph.js'
import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { buildFromJson } from '../../src/pipeline/build.js'
import { _edgeWeight, cluster, cohesionScore, scoreAll } from '../../src/pipeline/cluster.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

function makeGraph(): KnowledgeGraph {
  return buildFromJson(JSON.parse(readFileSync(join(FIXTURES_DIR, 'extraction.json'), 'utf8')))
}

function makeBridgeGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  for (let index = 0; index < 5; index += 1) {
    graph.addNode(`a${index}`, { label: `A${index}`, file_type: 'code', source_file: 'single.py' })
    graph.addNode(`b${index}`, { label: `B${index}`, file_type: 'code', source_file: 'single.py' })
  }
  for (let index = 0; index < 4; index += 1) {
    graph.addEdge(`a${index}`, `a${index + 1}`, { relation: 'calls', confidence: 'EXTRACTED', source_file: 'single.py', weight: 1.0 })
    graph.addEdge(`b${index}`, `b${index + 1}`, { relation: 'calls', confidence: 'EXTRACTED', source_file: 'single.py', weight: 1.0 })
  }
  graph.addEdge('a4', 'b0', { relation: 'references', confidence: 'INFERRED', source_file: 'single.py', weight: 0.5 })
  return graph
}

describe('cluster', () => {
  it('returns an object keyed by community id', () => {
    const communities = cluster(makeGraph())
    expect(typeof communities).toBe('object')
  })

  it('covers all nodes in the graph', () => {
    const graph = makeGraph()
    const communities = cluster(graph)
    const allNodes = new Set(Object.values(communities).flat())
    expect(allNodes).toEqual(new Set(graph.nodeIds()))
  })

  it('splits simple bridge graphs into multiple communities', () => {
    const communities = cluster(makeBridgeGraph())
    expect(Object.keys(communities).length).toBeGreaterThanOrEqual(2)
  })

  it('treats directed graphs like their undirected equivalents for clustering', () => {
    const directedGraph = new KnowledgeGraph(true)
    const undirectedGraph = new KnowledgeGraph()

    for (const graph of [directedGraph, undirectedGraph]) {
      graph.addNode('a', { label: 'A', file_type: 'code', source_file: 'directed.py' })
      graph.addNode('b', { label: 'B', file_type: 'code', source_file: 'directed.py' })
      graph.addNode('c', { label: 'C', file_type: 'code', source_file: 'directed.py' })
      graph.addEdge('a', 'b', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'directed.py', weight: 1.0 })
      graph.addEdge('b', 'c', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'directed.py', weight: 1.0 })
    }

    expect(cluster(directedGraph)).toEqual(cluster(undirectedGraph))
  })

  it('scores complete graphs at 1.0 cohesion', () => {
    const graph = new KnowledgeGraph()
    for (const nodeId of ['0', '1', '2', '3']) {
      graph.addNode(nodeId, { label: nodeId, file_type: 'code', source_file: 'complete.py' })
    }
    const nodeIds = graph.nodeIds()
    for (let sourceIndex = 0; sourceIndex < nodeIds.length; sourceIndex += 1) {
      for (let targetIndex = sourceIndex + 1; targetIndex < nodeIds.length; targetIndex += 1) {
        graph.addEdge(nodeIds[sourceIndex]!, nodeIds[targetIndex]!, { relation: 'calls', confidence: 'EXTRACTED', source_file: 'complete.py', weight: 1.0 })
      }
    }
    expect(cohesionScore(graph, graph.nodeIds())).toBe(1)
  })

  it('scores single-node communities at 1.0 cohesion', () => {
    const graph = new KnowledgeGraph()
    graph.addNode('a', { label: 'A', file_type: 'code', source_file: 'solo.py' })
    expect(cohesionScore(graph, ['a'])).toBe(1)
  })

  it('scores disconnected communities at 0.0 cohesion', () => {
    const graph = new KnowledgeGraph()
    for (const nodeId of ['a', 'b', 'c']) {
      graph.addNode(nodeId, { label: nodeId, file_type: 'code', source_file: 'empty.py' })
    }
    expect(cohesionScore(graph, ['a', 'b', 'c'])).toBe(0)
  })

  it('keeps cohesion scores in range', () => {
    const graph = makeGraph()
    const communities = cluster(graph)
    for (const nodes of Object.values(communities)) {
      const score = cohesionScore(graph, nodes)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })

  it('returns score maps aligned with the community keys', () => {
    const graph = makeGraph()
    const communities = cluster(graph)
    const scores = scoreAll(graph, communities)
    expect(new Set(Object.keys(scores))).toEqual(new Set(Object.keys(communities)))
  })
})

// A stub satisfying only the `factsBetween` surface `_edgeWeight` reads. The real
// KnowledgeGraph store cannot yet hold more than one fact per endpoint pair (that
// lands in #657), so this simulates the future multi-fact shape directly to prove
// `_edgeWeight` stays non-additive ahead of that migration.
function graphWithFacts(facts: readonly Partial<GraphRelationshipView>[]): KnowledgeGraph {
  return {
    factsBetween: () => facts as readonly GraphRelationshipView[],
  } as unknown as KnowledgeGraph
}

describe('_edgeWeight fact-multiplicity topology weight', () => {
  it('does not inflate weight when multiple facts share one endpoint pair', () => {
    const graph = graphWithFacts([{ weight: 2 }, { weight: 5 }, { weight: 3 }])
    // A summing implementation would return 10; topology weight must stay the
    // strongest single valid weight regardless of how many parallel facts exist.
    expect(_edgeWeight(graph, 'a', 'b')).toBe(5)
  })

  it('ignores invalid weights among multiple facts and still returns the strongest valid one', () => {
    const graph = graphWithFacts([{ weight: -1 }, { weight: Number.NaN }, { weight: 'bad' as unknown as number }, { weight: 4 }])
    expect(_edgeWeight(graph, 'a', 'b')).toBe(4)
  })

  it('defaults every invalid or missing weight to 1 without summing them', () => {
    const graph = graphWithFacts([{}, { weight: -1 }, { weight: 0 }])
    // Three facts each defaulting to 1 must not sum to 3.
    expect(_edgeWeight(graph, 'a', 'b')).toBe(1)
  })

  it('returns 0 for an endpoint pair with no facts', () => {
    const graph = graphWithFacts([])
    expect(_edgeWeight(graph, 'a', 'b')).toBe(0)
  })

  it('matches current single-fact behavior for a real endpoint pair with an explicit weight', () => {
    const graph = new KnowledgeGraph()
    graph.addEdge('a', 'b', { relation: 'calls', weight: 2.5 })
    expect(_edgeWeight(graph, 'a', 'b')).toBe(2.5)
  })

  it('matches current single-fact behavior for a real endpoint pair with no weight attribute', () => {
    const graph = new KnowledgeGraph()
    graph.addEdge('a', 'b', { relation: 'calls' })
    expect(_edgeWeight(graph, 'a', 'b')).toBe(1)
  })
})
