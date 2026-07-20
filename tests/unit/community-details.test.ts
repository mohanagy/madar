import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import { communityDetailsMicro, communityDetailsMid, communityDetailsMacro, communityDetailsAtZoom } from '../../src/pipeline/community-details.js'

function buildTestGraph(): { graph: KnowledgeGraph; communities: Record<number, string[]>; labels: Record<number, string> } {
  const graph = new KnowledgeGraph()

  graph.addNode('a1', { label: 'AuthHandler', source_file: '/src/auth.ts', node_kind: 'function', file_type: 'code', community: 0 })
  graph.addNode('a2', { label: 'SessionManager', source_file: '/src/auth.ts', node_kind: 'class', file_type: 'code', community: 0 })
  graph.addNode('a3', { label: 'TokenValidator', source_file: '/src/auth.ts', node_kind: 'function', file_type: 'code', community: 0 })
  graph.addNode('b1', { label: 'DatabasePool', source_file: '/src/db.ts', node_kind: 'class', file_type: 'code', community: 1 })
  graph.addNode('b2', { label: 'QueryBuilder', source_file: '/src/db.ts', node_kind: 'class', file_type: 'code', community: 1 })

  graph.addEdge('a1', 'a2', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/auth.ts' })
  graph.addEdge('a1', 'a3', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/auth.ts' })
  graph.addEdge('a2', 'b1', { relation: 'depends_on', confidence: 'EXTRACTED', source_file: 'src/auth.ts' })
  graph.addEdge('b1', 'b2', { relation: 'contains', confidence: 'EXTRACTED', source_file: 'src/db.ts' })
  graph.addEdge('b2', 'a3', { relation: 'notifies', confidence: 'EXTRACTED', source_file: 'src/db.ts' })

  return {
    graph,
    communities: { 0: ['a1', 'a2', 'a3'], 1: ['b1', 'b2'] },
    labels: { 0: 'Auth Module', 1: 'Database' },
  }
}

describe('community-details', () => {
  describe('communityDetailsMicro', () => {
    it('returns all communities with top nodes', () => {
      const { graph, communities, labels } = buildTestGraph()
      const result = communityDetailsMicro(graph, communities, labels)

      expect(result.length).toBe(2)
      expect(result[0]!.label).toBe('Auth Module')
      expect(result[0]!.node_count).toBe(3)
      expect(result[0]!.top_nodes.length).toBeLessThanOrEqual(3)
    })

    it('sorts by node count descending', () => {
      const { graph, communities, labels } = buildTestGraph()
      const result = communityDetailsMicro(graph, communities, labels)

      expect(result[0]!.node_count).toBeGreaterThanOrEqual(result[1]!.node_count)
    })
  })

  describe('communityDetailsMid', () => {
    it('returns entry points, exit points, and key nodes', () => {
      const { graph, communities, labels } = buildTestGraph()
      const result = communityDetailsMid(graph, communities, labels, 0)

      expect(result).not.toBeNull()
      expect(result!.label).toBe('Auth Module')
      expect(result!.key_nodes.length).toBeGreaterThan(0)
      expect(result!.dominant_file).toBe('/src/auth.ts')
    })

    it('detects exit points to other communities', () => {
      const { graph, communities, labels } = buildTestGraph()
      const result = communityDetailsMid(graph, communities, labels, 0)

      expect(result!.exit_points.length).toBeGreaterThan(0)
      expect(result!.exit_points.some((e) => e.target_community === 'Database')).toBe(true)
      expect(result!.exit_points.every((e) => e.label === 'SessionManager')).toBe(true)
    })

    it('counts only external incoming edges as entry points', () => {
      const { graph, communities, labels } = buildTestGraph()
      const result = communityDetailsMid(graph, communities, labels, 0)

      expect(result!.entry_points).toEqual([{ label: 'TokenValidator', in_degree: 1 }])
    })

    it('returns null for unknown community', () => {
      const { graph, communities, labels } = buildTestGraph()
      expect(communityDetailsMid(graph, communities, labels, 999)).toBeNull()
    })
  })

  describe('communityDetailsMacro', () => {
    it('returns all nodes and edges', () => {
      const { graph, communities, labels } = buildTestGraph()
      const result = communityDetailsMacro(graph, communities, labels, 0)

      expect(result).not.toBeNull()
      expect(result!.nodes.length).toBe(3)
      expect(result!.internal_edges.length).toBeGreaterThan(0)
      expect(result!.cross_community_edges.length).toBeGreaterThan(0)
    })

    it('includes file distribution', () => {
      const { graph, communities, labels } = buildTestGraph()
      const result = communityDetailsMacro(graph, communities, labels, 0)

      expect(result!.file_distribution.length).toBeGreaterThan(0)
      expect(result!.file_distribution[0]!.file).toBe('/src/auth.ts')
    })

    it('preserves parallel edge identity, direction, relation, and evidence', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('caller', { label: 'Caller', source_file: '/src/caller.ts' })
      graph.addNode('callee', { label: 'Callee', source_file: '/src/callee.ts' })
      graph.addEdge('caller', 'callee', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: 'src/caller.ts',
        evidence: { expression: 'first()' },
      })
      graph.addEdge('caller', 'callee', {
        relation: 'imports',
        confidence: 'INFERRED',
        source_file: 'src/caller.ts',
        evidence: { specifier: './callee.js' },
      })
      graph.addEdge('callee', 'caller', {
        relation: 'returns_to',
        confidence: 'AMBIGUOUS',
        source_file: 'src/callee.ts',
        evidence: { expression: 'callback()' },
      })
      const communities = { 0: ['caller', 'callee'] }

      expect(communityDetailsMid(graph, communities, { 0: 'Flow' }, 0)?.edge_count).toBe(3)
      const edges = communityDetailsMacro(graph, communities, { 0: 'Flow' }, 0)!.internal_edges
      expect(new Set(edges.map((edge) => edge.id)).size).toBe(3)
      expect(edges.map(({ from, to, relation, attributes }) => ({
        from,
        to,
        relation,
        evidence: attributes.evidence,
      }))).toEqual(expect.arrayContaining([
        { from: 'Caller', to: 'Callee', relation: 'calls', evidence: { expression: 'first()' } },
        { from: 'Caller', to: 'Callee', relation: 'imports', evidence: { specifier: './callee.js' } },
        { from: 'Callee', to: 'Caller', relation: 'returns_to', evidence: { expression: 'callback()' } },
      ]))
    })
  })

  describe('communityDetailsAtZoom', () => {
    it('returns micro level', () => {
      const { graph, communities, labels } = buildTestGraph()
      const result = communityDetailsAtZoom(graph, communities, labels, 0, 'micro')

      expect(result).not.toBeNull()
      expect('top_nodes' in result!).toBe(true)
    })

    it('returns mid level', () => {
      const { graph, communities, labels } = buildTestGraph()
      const result = communityDetailsAtZoom(graph, communities, labels, 0, 'mid')

      expect(result).not.toBeNull()
      expect('entry_points' in result!).toBe(true)
    })

    it('returns macro level', () => {
      const { graph, communities, labels } = buildTestGraph()
      const result = communityDetailsAtZoom(graph, communities, labels, 0, 'macro')

      expect(result).not.toBeNull()
      expect('internal_edges' in result!).toBe(true)
    })
  })
})
