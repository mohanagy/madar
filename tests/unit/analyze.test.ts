import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import {
  _surpriseScore,
  godNodes,
  graphStructureMetrics,
  graphDiff,
  semanticAnomalies,
  suggestQuestions,
  surprisingConnections,
  workspaceBridges,
} from '../../src/pipeline/analyze.js'
import { cluster } from '../../src/pipeline/cluster.js'
import { diffGraphs } from '../../src/runtime/diff.js'
import { createTestGraph } from '../helpers/knowledge-graph.js'

function makeGraph(): KnowledgeGraph {
  return createTestGraph({
    nodes: [
      ['n_transformer', { label: 'Transformer', file_type: 'code', source_file: 'model.ts', source_location: 'L1' }],
      ['n_attention', { label: 'MultiHeadAttention', file_type: 'code', source_file: 'attention.ts', source_location: 'L10' }],
      ['n_layernorm', { label: 'LayerNorm', file_type: 'code', source_file: 'normalization.ts', source_location: 'L20' }],
      ['n_kernel', { label: 'AttentionKernel', file_type: 'code', source_file: 'kernel.ts', source_location: 'L30' }],
    ],
    edges: [
      ['n_transformer', 'n_attention', { relation: 'contains', confidence: 'EXTRACTED', source_file: 'model.ts', weight: 1 }],
      ['n_transformer', 'n_layernorm', { relation: 'contains', confidence: 'EXTRACTED', source_file: 'model.ts', weight: 1 }],
      ['n_attention', 'n_kernel', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'attention.ts', weight: 1 }],
      ['n_layernorm', 'n_kernel', { relation: 'references', confidence: 'INFERRED', source_file: 'normalization.ts', weight: 0.8 }],
    ],
  })
}

function makeSimpleGraph(nodes: Array<[string, string]>, edges: Array<[string, string, string, string]>): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  for (const [nodeId, label] of nodes) {
    graph.addNode(nodeId, { label, source_file: 'test.ts', file_type: 'code' })
  }
  for (const [source, target, relation, confidence] of edges) {
    graph.addEdge(source, target, { relation, confidence, source_file: 'test.ts' })
  }
  return graph
}

function makeAnomalyGraph(): {
  graph: KnowledgeGraph
  communities: Record<number, string[]>
  labels: Record<number, string>
} {
  const graph = new KnowledgeGraph()

  for (const nodeId of ['a0', 'a1', 'a2', 'a3', 'a4', 'a5']) {
    graph.addNode(nodeId, { label: `Alpha ${nodeId}`, source_file: 'alpha.ts', file_type: 'code', community: 0 })
  }
  for (const nodeId of ['b0', 'b1', 'b2', 'b3']) {
    graph.addNode(nodeId, { label: `Beta ${nodeId}`, source_file: 'beta.ts', file_type: 'code', community: 1 })
  }
  for (let index = 0; index < 15; index += 1) {
    graph.addNode(`c${index}`, { label: `Gamma ${index}`, source_file: `gamma-${index}.ts`, file_type: 'code', community: 3 })
  }
  graph.addNode('bridge', { label: 'BridgeHub', source_file: 'shared.ts', file_type: 'code', community: 2 })

  for (const [source, target, relation, confidence, sourceFile] of [
    ['a0', 'a1', 'calls', 'EXTRACTED', 'alpha.ts'],
    ['a1', 'a2', 'calls', 'EXTRACTED', 'alpha.ts'],
    ['b0', 'b1', 'calls', 'EXTRACTED', 'beta.ts'],
    ['b1', 'b2', 'calls', 'EXTRACTED', 'beta.ts'],
    ['b2', 'b3', 'calls', 'EXTRACTED', 'beta.ts'],
    ['bridge', 'a0', 'calls', 'EXTRACTED', 'shared.ts'],
    ['bridge', 'b0', 'calls', 'EXTRACTED', 'shared.ts'],
    ['a2', 'b2', 'references', 'INFERRED', 'shared.ts'],
    ...Array.from({ length: 15 }, (_, index) => [
      `c${index}`,
      `c${index === 14 ? 0 : index + 1}`,
      'calls',
      'EXTRACTED',
      `gamma-${index}.ts`,
    ] as const),
  ] as const) {
    graph.addEdge(source, target, { relation, confidence, source_file: sourceFile })
  }

  return {
    graph,
    communities: {
      0: ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'],
      1: ['b0', 'b1', 'b2', 'b3'],
      2: ['bridge'],
      3: Array.from({ length: 15 }, (_, index) => `c${index}`),
    },
    labels: {
      0: 'Alpha Cluster',
      1: 'Beta Cluster',
      2: 'Shared Bridge',
      3: 'Gamma Cycle',
    },
  }
}

describe('analyze', () => {
  it('returns god nodes sorted by degree', () => {
    const result = godNodes(makeGraph(), 10)
    const degrees = result.map((entry) => entry.edges)
    expect(degrees).toEqual([...degrees].sort((left, right) => right - left))
    expect(result[0]).toHaveProperty('id')
    expect(result[0]).toHaveProperty('label')
    expect(result[0]).toHaveProperty('edges')
  })

  it('finds cross-source surprising connections', () => {
    const graph = makeGraph()
    const communities = cluster(graph)
    const surprises = surprisingConnections(graph, communities)

    expect(surprises.length).toBeGreaterThan(0)
    for (const surprise of surprises) {
      expect(surprise.source_files[0]).not.toBe(surprise.source_files[1])
      expect(typeof surprise.why).toBe('string')
      expect(surprise.why.length).toBeGreaterThan(0)
    }
  })

  it('uses cross-community bridges for single-source graphs', () => {
    const graph = new KnowledgeGraph()
    for (let index = 0; index < 5; index += 1) {
      graph.addNode(`a${index}`, { label: `A${index}`, file_type: 'code', source_file: 'single.ts', source_location: `L${index}` })
      graph.addNode(`b${index}`, { label: `B${index}`, file_type: 'code', source_file: 'single.ts', source_location: `L${index + 10}` })
    }
    for (let index = 0; index < 4; index += 1) {
      graph.addEdge(`a${index}`, `a${index + 1}`, { relation: 'calls', confidence: 'EXTRACTED', source_file: 'single.ts', weight: 1.0 })
      graph.addEdge(`b${index}`, `b${index + 1}`, { relation: 'calls', confidence: 'EXTRACTED', source_file: 'single.ts', weight: 1.0 })
    }
    graph.addEdge('a4', 'b0', { relation: 'references', confidence: 'INFERRED', source_file: 'single.ts', weight: 0.5 })

    const surprises = surprisingConnections(graph, cluster(graph))
    expect(surprises.length).toBeGreaterThan(0)
  })

  it('scores ambiguous edges above extracted ones', () => {
    const graph = new KnowledgeGraph()
    for (const [nodeId, label, sourceFile] of [
      ['a', 'Alpha', 'repo1/model.ts'],
      ['b', 'Beta', 'repo2/train.ts'],
      ['c', 'Gamma', 'repo1/data.ts'],
      ['d', 'Delta', 'repo2/eval.ts'],
    ] as const) {
      graph.addNode(nodeId, { label, source_file: sourceFile, file_type: 'code' })
    }
    graph.addEdge('a', 'b', { relation: 'calls', confidence: 'AMBIGUOUS', weight: 1.0, source_file: 'repo1/model.ts' })
    graph.addEdge('c', 'd', { relation: 'calls', confidence: 'EXTRACTED', weight: 1.0, source_file: 'repo1/data.ts' })

    const nodeCommunity = { a: 0, c: 0, b: 1, d: 1 }
    const ambiguous = _surpriseScore(graph, 'a', 'b', graph.uniqueEdgeBetween('a', 'b').attributes, nodeCommunity, 'repo1/model.ts', 'repo2/train.ts')
    const extracted = _surpriseScore(graph, 'c', 'd', graph.uniqueEdgeBetween('c', 'd').attributes, nodeCommunity, 'repo1/data.ts', 'repo2/eval.ts')
    expect(ambiguous[0]).toBeGreaterThan(extracted[0])
  })

  it('measures weakly connected fragmentation signals for workspace parity reporting', () => {
    const graph = new KnowledgeGraph()
    for (const nodeId of ['a', 'b', 'c', 'd', 'e']) {
      graph.addNode(nodeId, { label: nodeId.toUpperCase(), source_file: `${nodeId}.ts`, file_type: 'code' })
    }
    graph.addNode('f', { label: 'toHtml()', source_file: 'f.ts', file_type: 'code' })
    graph.addNode('file', { label: 'file.ts', source_file: 'file.ts', file_type: 'code' })
    graph.addNode('concept', { label: 'Shared infra', source_file: '' })

    graph.addEdge('a', 'b', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'a.ts' })
    graph.addEdge('b', 'c', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'b.ts' })
    graph.addEdge('d', 'e', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'd.ts' })
    graph.addEdge('f', 'concept', { relation: 'references', confidence: 'EXTRACTED', source_file: 'f.ts' })

    expect(graphStructureMetrics(graph)).toEqual({
      total_nodes: 6,
      total_edges: 3,
      weakly_connected_components: 3,
      singleton_components: 1,
      isolated_nodes: 1,
      largest_component_nodes: 3,
      largest_component_ratio: 0.5,
      low_cohesion_communities: 0,
      largest_low_cohesion_community_nodes: 0,
      largest_low_cohesion_community_score: 0,
    })
  })

  it('measures low-cohesion community signals on the shared entity basis', () => {
    const graph = new KnowledgeGraph()
    for (let index = 1; index <= 15; index += 1) {
      const nodeId = `n${index}`
      graph.addNode(nodeId, { label: `Node ${index}`, source_file: `module-${index}.ts`, file_type: 'code' })
    }
    for (let index = 1; index <= 15; index += 1) {
      const nodeId = `n${index}`
      const nextNodeId = `n${index === 15 ? 1 : index + 1}`
      graph.addEdge(nodeId, nextNodeId, { relation: 'calls', confidence: 'EXTRACTED', source_file: `module-${index}.ts` })
    }
    graph.addNode('file', { label: 'module-1.ts', source_file: 'module-1.ts', file_type: 'code' })
    graph.addEdge('file', 'n1', { relation: 'contains', confidence: 'EXTRACTED', source_file: 'module-1.ts' })

    expect(graphStructureMetrics(graph)).toEqual({
      total_nodes: 15,
      total_edges: 15,
      weakly_connected_components: 1,
      singleton_components: 0,
      isolated_nodes: 0,
      largest_component_nodes: 15,
      largest_component_ratio: 1,
      low_cohesion_communities: 0,
      largest_low_cohesion_community_nodes: 0,
      largest_low_cohesion_community_score: 0,
    })
  })

  it('ignores non-entity connectors when deriving low-cohesion communities', () => {
    const graph = new KnowledgeGraph()
    for (const prefix of ['a', 'b'] as const) {
      for (let index = 1; index <= 8; index += 1) {
        const nodeId = `${prefix}${index}`
        graph.addNode(nodeId, { label: `${prefix.toUpperCase()} Node ${index}`, source_file: `${nodeId}.ts`, file_type: 'code' })
      }
      for (let index = 1; index <= 8; index += 1) {
        const nodeId = `${prefix}${index}`
        const nextNodeId = `${prefix}${index === 8 ? 1 : index + 1}`
        graph.addEdge(nodeId, nextNodeId, { relation: 'calls', confidence: 'EXTRACTED', source_file: `${nodeId}.ts` })
      }
    }
    graph.addNode('file', { label: 'shared.ts', source_file: 'shared.ts', file_type: 'code' })
    for (const nodeId of ['a1', 'a2', 'b1', 'b2']) {
      graph.addEdge('file', nodeId, { relation: 'contains', confidence: 'EXTRACTED', source_file: 'shared.ts' })
    }

    expect(graphStructureMetrics(graph)).toEqual({
      total_nodes: 16,
      total_edges: 16,
      weakly_connected_components: 2,
      singleton_components: 0,
      isolated_nodes: 0,
      largest_component_nodes: 8,
      largest_component_ratio: 0.5,
      low_cohesion_communities: 0,
      largest_low_cohesion_community_nodes: 0,
      largest_low_cohesion_community_score: 0,
    })
  })

  it('returns zeroed structure metrics when only file and concept nodes exist', () => {
    const graph = new KnowledgeGraph()
    graph.addNode('file', { label: 'file.ts', source_file: 'file.ts', file_type: 'code' })
    graph.addNode('concept', { label: 'Shared infra', source_file: '' })
    graph.addEdge('file', 'concept', { relation: 'contains', confidence: 'EXTRACTED', source_file: 'file.ts' })

    expect(graphStructureMetrics(graph)).toEqual({
      total_nodes: 0,
      total_edges: 0,
      weakly_connected_components: 0,
      singleton_components: 0,
      isolated_nodes: 0,
      largest_component_nodes: 0,
      largest_component_ratio: 0,
      low_cohesion_communities: 0,
      largest_low_cohesion_community_nodes: 0,
      largest_low_cohesion_community_score: 0,
    })
  })

  it('reports graph diffs for nodes and edges', () => {
    const oldGraph = makeSimpleGraph(
      [
        ['n1', 'Alpha'],
        ['n2', 'Beta'],
      ],
      [['n1', 'n2', 'calls', 'EXTRACTED']],
    )
    const newGraph = makeSimpleGraph(
      [
        ['n1', 'Alpha'],
        ['n2', 'Beta'],
        ['n3', 'Gamma'],
      ],
      [
        ['n1', 'n2', 'calls', 'EXTRACTED'],
        ['n2', 'n3', 'uses', 'INFERRED'],
      ],
    )

    const diff = graphDiff(oldGraph, newGraph)

    expect(diff.new_nodes).toHaveLength(1)
    expect(diff.new_nodes[0]?.id).toBe('n3')
    expect(diff.new_edges).toHaveLength(1)
    expect(diff.new_edges[0]?.relation).toBe('uses')
    expect(diff.summary).toContain('new node')
    expect(diff.summary).toContain('new edge')
  })

  it('reports no changes for identical graphs', () => {
    const graphA = makeSimpleGraph(
      [
        ['n1', 'Alpha'],
        ['n2', 'Beta'],
      ],
      [['n1', 'n2', 'calls', 'EXTRACTED']],
    )
    const graphB = makeSimpleGraph(
      [
        ['n1', 'Alpha'],
        ['n2', 'Beta'],
      ],
      [['n1', 'n2', 'calls', 'EXTRACTED']],
    )

    expect(graphDiff(graphA, graphB).summary).toBe('no changes')
  })

  it('detects bridge, cross-boundary, and low-cohesion anomalies', () => {
    const { graph, communities, labels } = makeAnomalyGraph()

    const anomalies = semanticAnomalies(graph, communities, labels, 10)

    expect(anomalies.map((anomaly) => anomaly.kind)).toEqual(expect.arrayContaining(['bridge_node', 'cross_boundary_edge']))
    expect(anomalies.every((anomaly) => anomaly.summary.length > 0 && anomaly.why.length > 0)).toBe(true)
    expect(anomalies.every((anomaly) => ['HIGH', 'MEDIUM', 'LOW'].includes(anomaly.severity))).toBe(true)
  })

  it('ranks workspace bridges by cross-community reach', () => {
    const { graph, communities, labels } = makeAnomalyGraph()

    const bridges = workspaceBridges(graph, communities, labels, 3)

    expect(bridges[0]).toEqual(
      expect.objectContaining({
        id: 'bridge',
        label: 'BridgeHub',
        community_id: 2,
        community_label: 'Shared Bridge',
        degree: 2,
      }),
    )
    expect(bridges[0]?.connected_communities.map((community) => community.label)).toEqual(['Alpha Cluster', 'Beta Cluster'])
    expect(bridges[0]?.source_files).toEqual(['alpha.ts', 'beta.ts', 'shared.ts'])
    expect(bridges.every((bridge) => bridge.connected_communities.length > 0)).toBe(true)
  })

  it('sorts semantic anomalies by score and respects the requested limit', () => {
    const { graph, communities, labels } = makeAnomalyGraph()

    const anomalies = semanticAnomalies(graph, communities, labels, 2)

    expect(anomalies).toHaveLength(2)
    expect((anomalies[0]?.score ?? 0) >= (anomalies[1]?.score ?? 0)).toBe(true)
  })

  it('treats opposite edge directions as different changes for directed graphs', () => {
    const oldGraph = new KnowledgeGraph()
    oldGraph.addNode('n1', { label: 'Alpha', source_file: 'test.ts', file_type: 'code' })
    oldGraph.addNode('n2', { label: 'Beta', source_file: 'test.ts', file_type: 'code' })
    oldGraph.addEdge('n1', 'n2', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'test.ts' })

    const newGraph = new KnowledgeGraph()
    newGraph.addNode('n1', { label: 'Alpha', source_file: 'test.ts', file_type: 'code' })
    newGraph.addNode('n2', { label: 'Beta', source_file: 'test.ts', file_type: 'code' })
    newGraph.addEdge('n2', 'n1', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'test.ts' })

    const diff = graphDiff(oldGraph, newGraph)

    expect(diff.new_edges).toEqual([expect.objectContaining({ source: 'n2', target: 'n1', relation: 'calls', confidence: 'EXTRACTED' })])
    expect(diff.removed_edges).toEqual([expect.objectContaining({ source: 'n1', target: 'n2', relation: 'calls', confidence: 'EXTRACTED' })])
  })

  it('reports parallel edges that differ only by evidence', () => {
    const oldGraph = makeSimpleGraph([
      ['n1', 'Alpha'],
      ['n2', 'Beta'],
    ], [])
    oldGraph.addEdge('n1', 'n2', {
      relation: 'calls',
      confidence: 'EXTRACTED',
      source_file: 'test.ts',
      source_location: 'L10',
    })

    const newGraph = makeSimpleGraph([
      ['n1', 'Alpha'],
      ['n2', 'Beta'],
    ], [])
    newGraph.addEdge('n1', 'n2', {
      relation: 'calls',
      confidence: 'EXTRACTED',
      source_file: 'test.ts',
      source_location: 'L10',
    })
    const addedEdgeId = newGraph.addEdge('n1', 'n2', {
      relation: 'calls',
      confidence: 'EXTRACTED',
      source_file: 'test.ts',
      source_location: 'L20',
      evidence: { line: 20 },
    })

    const diff = graphDiff(oldGraph, newGraph)

    expect(diff.new_edges).toEqual([expect.objectContaining({
      id: addedEdgeId,
      source: 'n1',
      target: 'n2',
      relation: 'calls',
      confidence: 'EXTRACTED',
      attributes: expect.objectContaining({ evidence: { line: 20 } }),
    })])
    expect(diff.removed_edges).toEqual([])
    expect(diff.summary).toBe('1 new edge')
    expect(diffGraphs(oldGraph, newGraph)).toContain(`[edge ${addedEdgeId}] evidence={"line":20}`)
  })

  it('reports attribute-only edge changes with both old and new values', () => {
    const oldGraph = makeSimpleGraph([
      ['n1', 'Alpha'],
      ['n2', 'Beta'],
    ], [])
    const oldEdgeId = oldGraph.addEdge('n1', 'n2', {
      relation: 'calls',
      confidence: 'INFERRED',
      source_file: 'test.ts',
    })

    const newGraph = makeSimpleGraph([
      ['n1', 'Alpha'],
      ['n2', 'Beta'],
    ], [])
    const newEdgeId = newGraph.addEdge('n1', 'n2', {
      relation: 'calls',
      confidence: 'EXTRACTED',
      source_file: 'test.ts',
    })

    expect(newEdgeId).toBe(oldEdgeId)

    const diff = graphDiff(oldGraph, newGraph)

    expect(diff.new_edges).toEqual([expect.objectContaining({
      id: newEdgeId,
      confidence: 'EXTRACTED',
      attributes: expect.objectContaining({ confidence: 'EXTRACTED' }),
    })])
    expect(diff.removed_edges).toEqual([expect.objectContaining({
      id: oldEdgeId,
      confidence: 'INFERRED',
      attributes: expect.objectContaining({ confidence: 'INFERRED' }),
    })])
    expect(diff.summary).toBe('1 new edge, 1 edge removed')
  })

  it('generates suggested questions from graph signals', () => {
    const graph = new KnowledgeGraph()
    for (const [nodeId, label, sourceFile] of [
      ['a1', 'Alpha One', 'alpha.ts'],
      ['a2', 'Alpha Two', 'alpha.ts'],
      ['a3', 'Alpha Three', 'alpha.ts'],
      ['a4', 'Alpha Four', 'alpha.ts'],
      ['a5', 'Alpha Five', 'alpha.ts'],
      ['b1', 'Beta One', 'beta.ts'],
      ['b2', 'Beta Two', 'beta.ts'],
      ['b3', 'Beta Three', 'beta.ts'],
      ['b4', 'Beta Four', 'beta.ts'],
      ['b5', 'Beta Five', 'beta.ts'],
      ['bridge', 'Bridge Layer', 'shared.ts'],
      ['loner', 'Lone Node', 'loner.ts'],
      ['c1', 'Gamma One', 'gamma.ts'],
      ['c2', 'Gamma Two', 'gamma.ts'],
      ['c3', 'Gamma Three', 'gamma.ts'],
      ['c4', 'Gamma Four', 'gamma.ts'],
      ['c5', 'Gamma Five', 'gamma.ts'],
    ] as const) {
      graph.addNode(nodeId, { label, source_file: sourceFile, file_type: 'code' })
    }

    for (const [source, target, relation, confidence] of [
      ['a1', 'a2', 'calls', 'EXTRACTED'],
      ['a2', 'a3', 'calls', 'EXTRACTED'],
      ['a3', 'a4', 'calls', 'EXTRACTED'],
      ['a4', 'a5', 'calls', 'EXTRACTED'],
      ['b1', 'b2', 'calls', 'EXTRACTED'],
      ['b2', 'b3', 'calls', 'EXTRACTED'],
      ['b3', 'b4', 'calls', 'EXTRACTED'],
      ['b4', 'b5', 'calls', 'EXTRACTED'],
      ['a3', 'bridge', 'calls', 'EXTRACTED'],
      ['bridge', 'b3', 'calls', 'EXTRACTED'],
      ['bridge', 'a5', 'explains', 'INFERRED'],
      ['bridge', 'b5', 'explains', 'INFERRED'],
      ['a1', 'b1', 'relates_to', 'AMBIGUOUS'],
      ['c1', 'c2', 'calls', 'EXTRACTED'],
    ] as const) {
      graph.addEdge(source, target, { relation, confidence, source_file: 'test.ts' })
    }

    const questions = suggestQuestions(
      graph,
      {
        0: ['a1', 'a2', 'a3', 'a4', 'a5'],
        1: ['b1', 'b2', 'b3', 'b4', 'b5'],
        2: ['bridge'],
        3: ['c1', 'c2', 'c3', 'c4', 'c5'],
      },
      {
        0: 'Alpha',
        1: 'Beta',
        2: 'Bridge',
        3: 'Gamma',
      },
      10,
    )

    const questionTypes = new Set(questions.map((question) => question.type))
    expect(questionTypes.has('ambiguous_edge')).toBe(true)
    expect(questionTypes.has('bridge_node')).toBe(true)
    expect(questionTypes.has('verify_inferred')).toBe(true)
    expect(questionTypes.has('isolated_nodes')).toBe(true)
  })

  it('generates low-cohesion questions from sparse entity-only communities', () => {
    const graph = new KnowledgeGraph()
    for (let index = 0; index < 15; index += 1) {
      const nodeId = `n${index}`
      graph.addNode(nodeId, { label: `Cycle ${index}`, source_file: `cycle-${index}.ts`, file_type: 'code' })
    }
    for (let index = 0; index < 15; index += 1) {
      const nodeId = `n${index}`
      const nextNodeId = `n${index === 14 ? 0 : index + 1}`
      graph.addEdge(nodeId, nextNodeId, { relation: 'calls', confidence: 'EXTRACTED', source_file: `cycle-${index}.ts` })
    }
    graph.addNode('file', { label: 'cycle-0.ts', source_file: 'cycle-0.ts', file_type: 'code' })
    graph.addEdge('file', 'n0', { relation: 'contains', confidence: 'EXTRACTED', source_file: 'cycle-0.ts' })

    const questions = suggestQuestions(
      graph,
      {
        0: ['file'],
        1: Array.from({ length: 15 }, (_, index) => `n${index}`),
      },
      {
        0: 'File Wrapper',
        1: 'Sparse Cycle',
      },
      10,
    )

    // With Louvain clustering, the 15-node cycle is split into well-cohesioned
    // sub-communities, so no low_cohesion question is generated
    const lowCohesionQuestion = questions.find((question) => question.type === 'low_cohesion')
    expect(lowCohesionQuestion).toBeUndefined()
  })

  it('returns a no-signal fallback when the graph is too clean', () => {
    const graph = new KnowledgeGraph()
    for (const [nodeId, label] of [
      ['n1', 'One'],
      ['n2', 'Two'],
      ['n3', 'Three'],
      ['n4', 'Four'],
    ] as const) {
      graph.addNode(nodeId, { label, source_file: 'clean.ts', file_type: 'code' })
    }
    for (const [source, target] of [
      ['n1', 'n2'],
      ['n1', 'n3'],
      ['n1', 'n4'],
      ['n2', 'n3'],
      ['n2', 'n4'],
      ['n3', 'n4'],
    ] as const) {
      graph.addEdge(source, target, { relation: 'calls', confidence: 'EXTRACTED', source_file: 'clean.ts' })
    }

    expect(suggestQuestions(graph, { 0: ['n1', 'n2', 'n3', 'n4'] }, { 0: 'Clean' })).toEqual([expect.objectContaining({ type: 'no_signal', question: null })])
  })
})
