import { describe, expect, test } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { getCommunity, getNeighbors, getNode, graphStats, queryGraph, shortestPath } from '../../src/runtime/serve.js'

function makeGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.addNode('n1', { label: 'extract', source_file: 'extract.py', source_location: 'L10', community: 0, file_type: 'code' })
  graph.addNode('n2', { label: 'cluster', source_file: 'cluster.py', source_location: 'L5', community: 0, file_type: 'code' })
  graph.addNode('n3', { label: 'build', source_file: 'build.py', source_location: 'L1', community: 1, file_type: 'code' })
  graph.addNode('n4', { label: 'report', source_file: 'report.py', source_location: 'L1', community: 1, file_type: 'code' })
  graph.addNode('n5', { label: 'isolated', source_file: 'other.py', source_location: 'L1', community: 2, file_type: 'code' })
  graph.addEdge('n1', 'n2', { relation: 'calls', confidence: 'INFERRED', source_file: 'extract.py', _src: 'n1', _tgt: 'n2' })
  graph.addEdge('n2', 'n3', { relation: 'imports', confidence: 'EXTRACTED', source_file: 'cluster.py', _src: 'n2', _tgt: 'n3' })
  graph.addEdge('n3', 'n4', { relation: 'uses', confidence: 'EXTRACTED', source_file: 'build.py', _src: 'n3', _tgt: 'n4' })
  return graph
}

function makeDirectedGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph(true)
  graph.addNode('src', { label: 'source', source_file: 'extract.py', source_location: 'L1', community: 0, file_type: 'code' })
  graph.addNode('mid', { label: 'middle', source_file: 'cluster.py', source_location: 'L2', community: 0, file_type: 'code' })
  graph.addNode('sink', { label: 'sink', source_file: 'report.py', source_location: 'L3', community: 1, file_type: 'code' })
  graph.addEdge('src', 'mid', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'extract.py', _src: 'src', _tgt: 'mid' })
  graph.addEdge('mid', 'sink', { relation: 'uses', confidence: 'EXTRACTED', source_file: 'cluster.py', _src: 'mid', _tgt: 'sink' })
  return graph
}

const COMMUNITIES = { 0: ['n1', 'n2'], 1: ['n3', 'n4'], 2: ['n5'] }

describe('queryGraph', () => {
  test('renders traversal text for matching questions', () => {
    const result = queryGraph(makeGraph(), 'how does extract connect', { depth: 2 })
    expect(result).toContain('Traversal: BFS')
    expect(result).toContain('extract')
    expect(result).toContain('cluster')
  })

  test('uses Python-compatible defaults when depth is omitted', () => {
    const result = queryGraph(makeGraph(), 'how does extract connect')
    expect(result).toContain('Traversal: BFS depth=2')
  })

  test('supports dfs traversal mode', () => {
    const result = queryGraph(makeGraph(), 'how does extract connect', { mode: 'dfs', depth: 2 })
    expect(result).toContain('Traversal: DFS')
  })

  test('returns a no-match message when nothing scores', () => {
    expect(queryGraph(makeGraph(), 'xyzzy plugh', { depth: 2 })).toContain('No matching nodes found')
  })

  test('can restrict a generic query to outgoing traversal in directed mode', () => {
    const result = queryGraph(makeDirectedGraph(), 'sink', { depth: 2, direction: 'outgoing' })
    expect(result).toContain('sink')
    expect(result).not.toContain('middle')
    expect(result).not.toContain('source')
  })

  test('defaults generic directed-graph queries to incident context', () => {
    const result = queryGraph(makeDirectedGraph(), 'sink', { depth: 2 })
    expect(result).toContain('sink')
    expect(result).toContain('middle')
    expect(result).toContain('source')
    expect(result).toContain('EDGE middle --uses [EXTRACTED]--> sink')
    expect(result).toContain('EDGE source --calls [EXTRACTED]--> middle')
  })
})

describe('getNode', () => {
  test('returns node details by label', () => {
    const result = getNode(makeGraph(), 'extract')
    expect(result).toContain('Node: extract')
    expect(result).toContain('extract.py')
    expect(result).toContain('Degree: 1')
  })
})

describe('getNeighbors', () => {
  test('lists direct neighbors and relation details', () => {
    const result = getNeighbors(makeGraph(), 'cluster')
    expect(result).toContain('Neighbors of cluster')
    expect(result).toContain('extract')
    expect(result).toContain('build')
  })

  test('filters by relation type', () => {
    const result = getNeighbors(makeGraph(), 'cluster', 'imports')
    expect(result).toContain('build')
    expect(result).not.toContain('extract')
  })

  test('lists only outgoing edges for directed graphs', () => {
    const result = getNeighbors(makeDirectedGraph(), 'middle')
    expect(result).toContain('sink')
    expect(result).not.toContain('source')
  })
})

describe('getCommunity', () => {
  test('renders nodes for a known community', () => {
    const result = getCommunity(makeGraph(), COMMUNITIES, 0)
    expect(result).toContain('Community 0 (2 nodes)')
    expect(result).toContain('extract')
    expect(result).toContain('cluster')
  })
})

describe('graphStats', () => {
  test('summarizes node, edge, and confidence counts', () => {
    const result = graphStats(makeGraph(), COMMUNITIES)
    expect(result).toContain('Nodes: 5')
    expect(result).toContain('Edges: 3')
    expect(result).toContain('Communities: 3')
    expect(result).toContain('EXTRACTED')
    expect(result).toContain('INFERRED')
  })
})

describe('shortestPath', () => {
  test('renders the shortest path with relations and confidence', () => {
    const result = shortestPath(makeGraph(), 'extract', 'report')
    expect(result).toContain('Shortest path (3 hops)')
    expect(result).toContain('--calls [INFERRED]-->')
    expect(result).toContain('report')
  })

  test('returns a no-path message for disconnected nodes', () => {
    const result = shortestPath(makeGraph(), 'extract', 'isolated')
    expect(result).toContain('No path found')
  })

  test('stops searching beyond the max_hops bound', () => {
    const result = shortestPath(makeGraph(), 'extract', 'report', 2)
    expect(result).toContain('No path found within max_hops=2')
  })

  test('rejects invalid max hop values', () => {
    expect(() => shortestPath(makeGraph(), 'extract', 'report', 0)).toThrow(/maxHops/i)
  })

  test('respects edge direction when searching for shortest paths', () => {
    const result = shortestPath(makeDirectedGraph(), 'sink', 'source')
    expect(result).toContain('No path found')
  })
})
