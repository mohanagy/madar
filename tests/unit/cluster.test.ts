import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import { buildGraphFromExtraction } from '../../src/application/build-graph.js'
import { cluster, cohesionScore, scoreAll } from '../../src/pipeline/cluster.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

function makeGraph(): KnowledgeGraph {
  return buildGraphFromExtraction(JSON.parse(readFileSync(join(FIXTURES_DIR, 'extraction.json'), 'utf8')))
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

function makeOrderSensitiveGraph(reverseEdges = false): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  for (const nodeId of ['action-file', 'action', 'page-file', 'page', 'route', 'route-page', 'client-file', 'client']) {
    graph.addNode(nodeId, { label: nodeId, file_type: 'code', source_file: `${nodeId}.ts` })
  }
  const edges = [
    ['action-file', 'action', 'contains'],
    ['page-file', 'action-file', 'imports_from'],
    ['page-file', 'client-file', 'imports_from'],
    ['page-file', 'page', 'contains'],
    ['route', 'route-page', 'depends_on'],
    ['route-page', 'page', 'renders'],
    ['client-file', 'client', 'contains'],
    ['page-file', 'action', 'imports_from'],
    ['page-file', 'client', 'imports_from'],
  ] as const

  for (const [source, target, relation] of reverseEdges ? [...edges].reverse() : edges) {
    graph.addEdge(source, target, { relation, confidence: 'EXTRACTED', source_file: `${source}.ts`, weight: 1 })
  }
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

  it('is independent of edge insertion order when community gains tie', () => {
    expect(cluster(makeOrderSensitiveGraph())).toEqual(cluster(makeOrderSensitiveGraph(true)))
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
