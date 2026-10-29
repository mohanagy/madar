import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'

function buildBeforeGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })

  graph.addNode('web', { label: 'WebApp', source_file: '/src/web.ts', node_kind: 'module', file_type: 'code', community: 2 })
  graph.addNode('mobile', { label: 'MobileClient', source_file: '/src/mobile.ts', node_kind: 'module', file_type: 'code', community: 2 })
  graph.addNode('api', { label: 'ApiHandler', source_file: '/src/api.ts', node_kind: 'function', file_type: 'code', community: 2 })
  graph.addNode('auth', { label: 'AuthService', source_file: '/src/auth.ts', node_kind: 'class', file_type: 'code', community: 0 })
  graph.addNode('session', { label: 'SessionStore', source_file: '/src/session.ts', node_kind: 'class', file_type: 'code', community: 0 })
  graph.addNode('db', { label: 'DatabaseConnection', source_file: '/src/db.ts', node_kind: 'class', file_type: 'code', community: 1 })

  graph.addEdge('web', 'api', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/web.ts' })
  graph.addEdge('mobile', 'api', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/mobile.ts' })
  graph.addEdge('api', 'auth', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/api.ts' })
  graph.addEdge('auth', 'session', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })
  graph.addEdge('session', 'db', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/session.ts' })

  graph.graph.community_labels = {
    0: 'Auth Layer',
    1: 'Data Layer',
    2: 'App Layer',
  }

  return graph
}

function buildAfterGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })

  graph.addNode('web', { label: 'WebApp', source_file: '/src/web.ts', node_kind: 'module', file_type: 'code', community: 2 })
  graph.addNode('mobile', { label: 'MobileClient', source_file: '/src/mobile.ts', node_kind: 'module', file_type: 'code', community: 2 })
  graph.addNode('api', { label: 'ApiHandler', source_file: '/src/api.ts', node_kind: 'function', file_type: 'code', community: 2 })
  graph.addNode('auth', { label: 'AuthService', source_file: '/src/auth.ts', node_kind: 'class', file_type: 'code', community: 1 })
  graph.addNode('session', { label: 'SessionStore', source_file: '/src/session.ts', node_kind: 'class', file_type: 'code', community: 0 })
  graph.addNode('db', { label: 'DatabaseConnection', source_file: '/src/db.ts', node_kind: 'class', file_type: 'code', community: 1 })
  graph.addNode('guide', { label: 'MigrationGuide', source_file: '/docs/migration.md', node_kind: 'document', file_type: 'document', community: 3 })

  graph.addEdge('web', 'api', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/web.ts' })
  graph.addEdge('mobile', 'api', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/mobile.ts' })
  graph.addEdge('api', 'auth', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/api.ts' })
  graph.addEdge('auth', 'session', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })
  graph.addEdge('session', 'db', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/session.ts' })

  graph.graph.community_labels = {
    0: 'Auth Layer',
    1: 'Security Layer',
    2: 'App Layer',
    3: 'Docs',
  }

  return graph
}

function buildUnlabeledBeforeGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })

  graph.addNode('web', { label: 'WebApp', source_file: '/src/web.ts', node_kind: 'module', file_type: 'code', community: 2 })
  graph.addNode('gateway', { source_file: '/src/gateway.ts', node_kind: 'function', file_type: 'code', community: 1 })

  graph.addEdge('web', 'gateway', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/web.ts' })

  return graph
}

function buildUnlabeledAfterGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })

  graph.addNode('web', { label: 'WebApp', source_file: '/src/web.ts', node_kind: 'module', file_type: 'code', community: 2 })
  graph.addNode('gateway', { source_file: '/src/gateway.ts', node_kind: 'function', file_type: 'code', community: 1 })
  graph.addNode('mobile', { label: 'MobileClient', source_file: '/src/mobile.ts', node_kind: 'module', file_type: 'code', community: 2 })

  graph.addEdge('web', 'gateway', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/web.ts' })
  graph.addEdge('mobile', 'gateway', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/mobile.ts' })

  return graph
}

describe('time travel runtime regression coverage', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.doUnmock('../../src/pipeline/analyze.js')
    vi.doUnmock('../../src/pipeline/community-naming.js')
    vi.doUnmock('../../src/runtime/impact.js')
    vi.doUnmock('../../src/runtime/serve.js')
    vi.clearAllMocks()
  })

  it('computes the graph diff once per comparison', async () => {
    const actualAnalyze = await vi.importActual<typeof import('../../src/pipeline/analyze.js')>('../../src/pipeline/analyze.js')
    const graphDiffSpy = vi.fn(actualAnalyze.graphDiff)

    vi.doMock('../../src/pipeline/analyze.js', () => ({
      ...actualAnalyze,
      graphDiff: graphDiffSpy,
    }))

    const { compareTimeTravelGraphs } = await import('../../src/runtime/time-travel.js')

    compareTimeTravelGraphs(buildBeforeGraph(), buildAfterGraph(), { view: 'summary', limit: 5 })

    expect(graphDiffSpy).toHaveBeenCalledTimes(1)
  })

  it('ranks risk by node identity without building an after-graph label lookup', async () => {
    const analyzeImpact = vi.fn((graph: KnowledgeGraph, _labels: Record<number, string>, options: { nodeId: string }) => ({
      target: String(graph.nodeAttributes(options.nodeId).label ?? options.nodeId),
      target_file: '',
      depth: 3,
      direct_dependents: [],
      transitive_dependents: graph.hasNode('web') && options.nodeId === 'auth' ? [{
        label: 'WebApp',
        source_file: '/src/web.ts',
        node_kind: 'module',
        file_type: 'code',
        community: 2,
        community_label: 'App Layer',
        distance: 2,
        relation: 'calls',
      }] : [],
      affected_files: [],
      affected_communities: [],
      top_paths_per_community: [],
      total_affected: 0,
    }))

    vi.doMock('../../src/pipeline/community-naming.js', () => ({
      buildCommunityLabels: () => ({}),
    }))
    vi.doMock('../../src/runtime/serve.js', () => ({
      communitiesFromGraph: () => ({}),
    }))
    vi.doMock('../../src/runtime/impact.js', () => ({
      analyzeImpact,
    }))

    const { compareTimeTravelGraphs } = await import('../../src/runtime/time-travel.js')
    const afterGraph = buildAfterGraph()
    const nodeEntriesSpy = vi.spyOn(afterGraph, 'nodeEntries')

    const result = compareTimeTravelGraphs(buildBeforeGraph(), afterGraph, { view: 'risk', limit: 3 })

    expect(result.risk.topImpacts[0]?.label).toBe('AuthService')
    expect(result.risk.topImpacts[0]).toMatchObject({ node_id: 'auth', graph_side: 'after' })
    expect(analyzeImpact).toHaveBeenCalledWith(afterGraph, expect.any(Object), { nodeId: 'auth' })
    expect(nodeEntriesSpy).not.toHaveBeenCalled()
  })

  it('resolves community labels once per graph before ranking risk', async () => {
    const analyzeImpact = vi.fn((graph: KnowledgeGraph, _labels: Record<number, string>, options: { nodeId: string }) => ({
      target: String(graph.nodeAttributes(options.nodeId).label ?? options.nodeId),
      target_file: '',
      depth: 3,
      direct_dependents: [],
      transitive_dependents: [],
      affected_files: [],
      affected_communities: [],
      top_paths_per_community: [],
      total_affected: 0,
    }))
    const buildCommunityLabels = vi.fn(() => ({}))
    const communitiesFromGraph = vi.fn(() => ({}))

    vi.doMock('../../src/pipeline/community-naming.js', () => ({
      buildCommunityLabels,
    }))
    vi.doMock('../../src/runtime/serve.js', () => ({
      communitiesFromGraph,
    }))
    vi.doMock('../../src/runtime/impact.js', () => ({
      analyzeImpact,
    }))

    const { compareTimeTravelGraphs } = await import('../../src/runtime/time-travel.js')

    compareTimeTravelGraphs(buildBeforeGraph(), buildAfterGraph(), { view: 'risk', limit: 5 })

    expect(analyzeImpact.mock.calls.length).toBeGreaterThan(1)
    expect(buildCommunityLabels).toHaveBeenCalledTimes(2)
    expect(communitiesFromGraph).toHaveBeenCalledTimes(2)
  })

  it('uses node id fallback when selecting risk impact graphs for unlabeled changed nodes', async () => {
    const analyzeImpact = vi.fn((graph: KnowledgeGraph, _labels: Record<number, string>, options: { nodeId: string }) => ({
      target: String(graph.nodeAttributes(options.nodeId).label ?? options.nodeId),
      target_file: '',
      depth: 3,
      direct_dependents: [],
      transitive_dependents: options.nodeId === 'gateway' && graph.hasNode('mobile') ? [{
        label: 'MobileClient',
        source_file: '/src/mobile.ts',
        node_kind: 'module',
        file_type: 'code',
        community: 2,
        community_label: 'App Layer',
        distance: 2,
        relation: 'calls',
      }] : [],
      affected_files: [],
      affected_communities: [],
      top_paths_per_community: [],
      total_affected: 0,
    }))

    vi.doMock('../../src/pipeline/community-naming.js', () => ({
      buildCommunityLabels: () => ({}),
    }))
    vi.doMock('../../src/runtime/serve.js', () => ({
      communitiesFromGraph: () => ({}),
    }))
    vi.doMock('../../src/runtime/impact.js', () => ({
      analyzeImpact,
    }))

    const { compareTimeTravelGraphs } = await import('../../src/runtime/time-travel.js')

    const afterGraph = buildUnlabeledAfterGraph()
    const result = compareTimeTravelGraphs(buildUnlabeledBeforeGraph(), afterGraph, { view: 'risk', limit: 5 })

    expect(result.risk.topImpacts).toContainEqual(expect.objectContaining({
      label: 'gateway', node_id: 'gateway', graph_side: 'after', transitiveDependents: 1,
    }))
    expect(analyzeImpact).toHaveBeenCalledWith(afterGraph, expect.any(Object), { nodeId: 'gateway' })
  })
})
