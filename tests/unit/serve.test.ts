import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, test } from 'vitest'

import { serializeGraphArtifact } from '../../src/domain/graph/artifact.js'
import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import { bfs, communitiesFromGraph, dfs, getNode, loadGraph, queryGraph, scoreNodes, semanticAnomaliesSummary, subgraphToText } from '../../src/runtime/serve.js'

function withTempDir(callback: (tempDir: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-serve-'))
  try {
    callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function makeGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.addNode('n1', { label: 'extract', source_file: 'extract.py', source_location: 'L10', community: 0 })
  graph.addNode('n2', { label: 'cluster', source_file: 'cluster.py', source_location: 'L5', community: 0 })
  graph.addNode('n3', { label: 'build', source_file: 'build.py', source_location: 'L1', community: 1 })
  graph.addNode('n4', { label: 'report', source_file: 'report.py', source_location: 'L1', community: 1 })
  graph.addNode('n5', { label: 'isolated', source_file: 'other.py', source_location: 'L1', community: 2 })
  graph.addEdge('n1', 'n2', { relation: 'calls', confidence: 'INFERRED' })
  graph.addEdge('n2', 'n3', { relation: 'imports', confidence: 'EXTRACTED' })
  graph.addEdge('n3', 'n4', { relation: 'uses', confidence: 'EXTRACTED' })
  return graph
}

function writeGraphArtifact(
  graphPath: string,
  options: {
    metadata?: Record<string, unknown>
    nodes?: Array<{ id: string; attributes: Record<string, unknown> }>
    edges?: Array<{ source: string; target: string; attributes: Record<string, unknown> }>
  } = {},
): void {
  const graph = new KnowledgeGraph(options.metadata)
  for (const node of options.nodes ?? []) graph.addNode(node.id, node.attributes)
  for (const edge of options.edges ?? []) graph.addEdge(edge.source, edge.target, edge.attributes)
  writeFileSync(graphPath, serializeGraphArtifact(graph), 'utf8')
}

function makeRankedGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.addNode('hub', { label: 'AuthService', source_file: 'auth.ts', source_location: 'L1', file_type: 'code', community: 0 })
  graph.addNode('leaf', { label: 'AuthLeaf', source_file: 'leaf.ts', source_location: 'L2', file_type: 'code', community: 0 })
  graph.addNode('guide', { label: 'AuthGuide', source_file: 'guide.md', source_location: 'L3', file_type: 'document', community: 1 })
  graph.addNode('other1', { label: 'HelperOne', source_file: 'helper-one.ts', source_location: 'L4', file_type: 'code', community: 0 })
  graph.addNode('other2', { label: 'HelperTwo', source_file: 'helper-two.ts', source_location: 'L5', file_type: 'code', community: 0 })
  graph.addEdge('hub', 'leaf', { relation: 'calls', confidence: 'EXTRACTED' })
  graph.addEdge('hub', 'other1', { relation: 'calls', confidence: 'EXTRACTED' })
  graph.addEdge('hub', 'other2', { relation: 'calls', confidence: 'EXTRACTED' })
  graph.addEdge('leaf', 'guide', { relation: 'documents', confidence: 'EXTRACTED' })
  return graph
}

function makeWorkspaceBridgeGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.addNode('api', { label: 'loginUser()', source_file: 'backend/api.ts', source_location: 'L4', file_type: 'code', community: 0 })
  graph.addNode('web', { label: 'loadSession()', source_file: 'web/session.ts', source_location: 'L3', file_type: 'code', community: 1 })
  graph.addNode('shared', { label: 'createSession()', source_file: 'shared/auth.ts', source_location: 'L1', file_type: 'code', community: 2 })
  graph.addEdge('api', 'shared', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'backend/api.ts' })
  graph.addEdge('web', 'shared', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'web/session.ts' })
  graph.graph.community_labels = {
    0: 'Backend API',
    1: 'Web Session',
    2: 'Shared Auth',
  }
  return graph
}

describe('communitiesFromGraph', () => {
  test('reconstructs communities from node attributes', () => {
    const communities = communitiesFromGraph(makeGraph())
    expect(communities[0]).toContain('n1')
    expect(communities[0]).toContain('n2')
    expect(communities[1]).toContain('n3')
    expect(communities[2]).toContain('n5')
  })

  test('ignores nodes without a community attribute', () => {
    const graph = new KnowledgeGraph()
    graph.addNode('a', { label: 'foo' })
    expect(communitiesFromGraph(graph)).toEqual({})
  })
})

describe('scoreNodes', () => {
  test('prefers exact label matches', () => {
    const scored = scoreNodes(makeGraph(), ['extract'])
    expect(scored[0]?.[1]).toBe('n1')
    expect(scored[0]?.[0]).toBeGreaterThan(0)
  })

  test('returns empty list for missing terms', () => {
    expect(scoreNodes(makeGraph(), ['xyzzy'])).toEqual([])
  })

  test('scores partial source file matches at lower weight', () => {
    const scored = scoreNodes(makeGraph(), ['cluster'])
    expect(scored.map(([, id]) => id)).toContain('n2')
  })

  test('can rank matching nodes by degree', () => {
    const scored = scoreNodes(makeRankedGraph(), ['auth'], { rankBy: 'degree' })

    expect(scored.map(([, id]) => id)).toEqual(['hub', 'leaf', 'guide'])
  })

  test('applies query filters before scoring nodes', () => {
    const scored = scoreNodes(makeRankedGraph(), ['auth'], {
      filters: {
        community: 0,
        fileType: 'code',
      },
    })

    expect(scored.map(([, id]) => id)).toEqual(['hub', 'leaf'])
  })
})

describe('queryGraph', () => {
  test('reports query ranking and filters in the traversal summary', () => {
    const result = queryGraph(makeRankedGraph(), 'auth', {
      rankBy: 'degree',
      filters: {
        community: 0,
        fileType: 'code',
      },
    })

    expect(result).toContain('Rank: DEGREE')
    expect(result).toContain('Filters: community=0, file_type=code')
    expect(result).toContain('AuthService')
    expect(result).not.toContain('AuthGuide')
  })

  test('explains when filters eliminate all matching nodes', () => {
    const result = queryGraph(makeRankedGraph(), 'auth', {
      filters: {
        community: 99,
      },
    })

    expect(result).toContain('No matching nodes found')
    expect(result).toContain('community=99')
  })

  test('surfaces workspace bridge context for broad mixed-workspace questions', () => {
    const result = queryGraph(makeWorkspaceBridgeGraph(), 'login session', { depth: 1 })

    expect(result).toContain('Workspace bridges:')
    expect(result).toContain('createSession()')
    expect(result).toContain('connects Backend API, Web Session')
  })

  test('includes workspace bridge context when explaining a bridge node', () => {
    const result = getNode(makeWorkspaceBridgeGraph(), 'createSession')

    expect(result).toContain('Node: createSession()')
    expect(result).toContain('Workspace bridge:')
    expect(result).toContain('connects Backend API, Web Session')
  })
})

describe('bfs', () => {
  test('respects traversal depth', () => {
    const { visited } = bfs(makeGraph(), ['n1'], 1)
    expect(visited.has('n1')).toBe(true)
    expect(visited.has('n2')).toBe(true)
    expect(visited.has('n3')).toBe(false)
  })

  test('returns traversed edges', () => {
    const { edges } = bfs(makeGraph(), ['n1'], 1)
    expect(edges.some(([source, target]) => source === 'n1' || target === 'n1')).toBe(true)
  })

  test('traverses outgoing edges only for directed graphs', () => {
    const graph = new KnowledgeGraph()
    graph.addNode('a', { label: 'A' })
    graph.addNode('b', { label: 'B' })
    graph.addNode('c', { label: 'C' })
    graph.addEdge('a', 'b', { relation: 'calls', confidence: 'EXTRACTED' })
    graph.addEdge('c', 'a', { relation: 'feeds', confidence: 'EXTRACTED' })

    const { visited } = bfs(graph, ['a'], 2)

    expect(visited.has('a')).toBe(true)
    expect(visited.has('b')).toBe(true)
    expect(visited.has('c')).toBe(false)
  })

  test('can traverse incident edges when a non-directional context surface requests them', () => {
    const graph = new KnowledgeGraph()
    graph.addNode('owner', { label: 'Owner' })
    graph.addNode('method', { label: 'method()' })
    graph.addNode('effect', { label: 'Effect' })
    graph.addEdge('owner', 'method', { relation: 'contains', confidence: 'EXTRACTED' })
    graph.addEdge('method', 'owner', { relation: 'reports_to', confidence: 'EXTRACTED' })
    graph.addEdge('method', 'effect', { relation: 'calls', confidence: 'EXTRACTED' })

    const { visited, edges } = bfs(graph, ['method'], 1, undefined, 'incident')

    expect([...visited]).toEqual(expect.arrayContaining(['owner', 'method', 'effect']))
    expect(edges).toEqual(expect.arrayContaining([
      ['owner', 'method'],
      ['method', 'owner'],
      ['method', 'effect'],
    ]))
  })
})

describe('dfs', () => {
  test('respects traversal depth', () => {
    const { visited } = dfs(makeGraph(), ['n1'], 1)
    expect(visited.has('n1')).toBe(true)
    expect(visited.has('n2')).toBe(true)
    expect(visited.has('n3')).toBe(false)
  })

  test('can walk the full chain', () => {
    const { visited } = dfs(makeGraph(), ['n1'], 5)
    expect(visited.has('n4')).toBe(true)
  })

  test('can traverse incoming edges without reversing their stored orientation', () => {
    const graph = new KnowledgeGraph()
    graph.addNode('owner', { label: 'Owner' })
    graph.addNode('method', { label: 'method()' })
    graph.addEdge('owner', 'method', { relation: 'contains', confidence: 'EXTRACTED' })

    const { visited, edges } = dfs(graph, ['method'], 1, undefined, 'incident')

    expect(visited.has('owner')).toBe(true)
    expect(edges).toContainEqual(['owner', 'method'])
  })
})

describe('subgraphToText', () => {
  test('includes labels and relations', () => {
    const text = subgraphToText(makeGraph(), new Set(['n1', 'n2']), [['n1', 'n2']])
    expect(text).toContain('extract')
    expect(text).toContain('cluster')
    expect(text).toContain('EDGE')
    expect(text).toContain('calls')
  })

  test('truncates at the token budget', () => {
    const text = subgraphToText(makeGraph(), new Set(['n1', 'n2', 'n3', 'n4']), [['n1', 'n2']], 1)
    expect(text).toContain('truncated')
  })
})

describe('loadGraph', () => {
  test('restores directed graph metadata when loading exported graph json', () => {
    withTempDir((tempDir) => {
      const outDir = join(tempDir, 'out')
      const graphPath = join(outDir, 'graph.json')
      mkdirSync(outDir, { recursive: true })
      writeGraphArtifact(graphPath, {
        nodes: [
          { id: 'n1', attributes: { label: 'extract', community: 0, source_file: 'extract.py', file_type: 'code' } },
          { id: 'n2', attributes: { label: 'cluster', community: 0, source_file: 'cluster.py', file_type: 'code' } },
        ],
        edges: [{ source: 'n1', target: 'n2', attributes: { relation: 'calls', confidence: 'EXTRACTED', source_file: 'extract.py' } }],
      })

      const graph = loadGraph(graphPath)
      expect(graph.isDirected()).toBe(true)
      expect(graph.numberOfEdges()).toBe(1)
      expect(graph.successors('n1')).toEqual(['n2'])
      expect(graph.successors('n2')).toEqual([])
    })
  })

  test('restores stored community labels for runtime bridge context', () => {
    withTempDir((tempDir) => {
      const outDir = join(tempDir, 'out')
      const graphPath = join(outDir, 'graph.json')
      mkdirSync(outDir, { recursive: true })
      writeGraphArtifact(graphPath, {
        metadata: { community_labels: { '0': 'Backend API', '1': 'Web Session', '2': 'Shared Auth' } },
        nodes: [
          { id: 'api', attributes: { label: 'loginUser()', community: 0, source_file: 'backend/api.ts', file_type: 'code' } },
          { id: 'web', attributes: { label: 'loadSession()', community: 1, source_file: 'web/session.ts', file_type: 'code' } },
          { id: 'shared', attributes: { label: 'createSession()', community: 2, source_file: 'shared/auth.ts', file_type: 'code' } },
        ],
        edges: [
          { source: 'api', target: 'shared', attributes: { relation: 'calls', confidence: 'EXTRACTED', source_file: 'backend/api.ts' } },
          { source: 'web', target: 'shared', attributes: { relation: 'calls', confidence: 'EXTRACTED', source_file: 'web/session.ts' } },
        ],
      })

      const graph = loadGraph(graphPath)
      const result = queryGraph(graph, 'login session', { depth: 1 })

      expect(result).toContain('Workspace bridges:')
      expect(result).toContain('connects Backend API, Web Session')
    })
  })

  test('throws when the graph file is missing', () => {
    withTempDir((tempDir) => {
      const outDir = join(tempDir, 'out')
      expect(() => loadGraph(join(outDir, 'missing.json'))).toThrow(/graph/i)
    })
  })

  test('rejects invalid json content', () => {
    withTempDir((tempDir) => {
      const outDir = join(tempDir, 'out')
      const graphPath = join(outDir, 'graph.json')
      mkdirSync(outDir, { recursive: true })
      writeFileSync(graphPath, '{bad-json', 'utf8')
      expect(() => loadGraph(graphPath)).toThrow(/corrupt|json/i)
    })
  })

  test('summarizes semantic anomalies stored in graph artifacts', () => {
    withTempDir((tempDir) => {
      const outDir = join(tempDir, 'out')
      const graphPath = join(outDir, 'graph.json')
      mkdirSync(outDir, { recursive: true })
      writeGraphArtifact(graphPath, {
        metadata: {
          community_labels: { '0': 'Alpha Cluster' },
          semantic_anomalies: [
            {
              id: 'low-cohesion-alpha',
              kind: 'low_cohesion_community',
              severity: 'MEDIUM',
              score: 5.4,
              summary: 'Alpha Cluster is weakly connected for its size.',
              why: 'Cohesion score is below the anomaly threshold.',
            },
          ],
        },
        nodes: [
          { id: 'n1', attributes: { label: 'extract', community: 0, source_file: 'extract.py', file_type: 'code' } },
          { id: 'n2', attributes: { label: 'cluster', community: 0, source_file: 'cluster.py', file_type: 'code' } },
        ],
        edges: [{ source: 'n1', target: 'n2', attributes: { relation: 'calls', confidence: 'EXTRACTED', source_file: 'extract.py' } }],
      })

      const result = semanticAnomaliesSummary(graphPath, 5)

      expect(result).toContain('Semantic anomalies (1 shown)')
      expect(result).toContain('Alpha Cluster is weakly connected for its size.')
    })
  })

  test('ignores oversized stored anomaly payloads and sanitizes anomaly text', () => {
    withTempDir((tempDir) => {
      const outDir = join(tempDir, 'out')
      const graphPath = join(outDir, 'graph.json')
      mkdirSync(outDir, { recursive: true })
      writeGraphArtifact(graphPath, {
        metadata: {
          semantic_anomalies: [
            {
              id: 'valid-id',
              kind: 'bridge_node',
              severity: 'HIGH',
              score: 7.2,
              summary: 'Bridge\u0007 node summary',
              why: 'Because\u0000 it links distant communities.',
            },
          ],
        },
      })

      const sanitized = semanticAnomaliesSummary(graphPath, 5)

      expect(sanitized).toContain('Bridge node summary')
      expect(sanitized).not.toContain('\u0007')
      expect(sanitized).not.toContain('\u0000')

      writeGraphArtifact(graphPath, {
        metadata: {
          semantic_anomalies: Array.from({ length: 10001 }, (_, index) => ({
            id: `anomaly-${index}`,
            kind: 'bridge_node',
            severity: 'HIGH',
            score: 9,
            summary: `Oversized anomaly ${index}`,
            why: 'Too many anomalies should be ignored.',
          })),
        },
      })

      const oversized = semanticAnomaliesSummary(graphPath, 5)

      expect(oversized).toBe('Semantic anomalies: none detected.')
    })
  })
})
