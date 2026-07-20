import { vi } from 'vitest'

import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import { featureMap } from '../../src/runtime/feature-map.js'

describe('featureMap', () => {
  it('returns communities, entry points, and starter files for a feature question', () => {
    const graph = new KnowledgeGraph()
    graph.graph.root_path = '/workspace'
    graph.graph.community_labels = {
      0: 'Routes',
      1: 'Services',
      2: 'Utilities',
    }

    graph.addNode('route_users_show', {
      label: 'GET /users/:id',
      source_file: '/workspace/src/routes/users.ts',
      line_number: 12,
      node_kind: 'route',
      file_type: 'code',
      community: 0,
      framework: 'express',
      framework_role: 'express_route',
    })
    graph.addNode('show_user_profile', {
      label: 'showUserProfile',
      source_file: '/workspace/src/routes/users.ts',
      line_number: 24,
      node_kind: 'function',
      file_type: 'code',
      community: 0,
    })
    graph.addNode('get_user_profile', {
      label: 'getUserProfile',
      source_file: '/workspace/src/services/users.ts',
      line_number: 8,
      node_kind: 'function',
      file_type: 'code',
      community: 1,
      contextual_prefix: 'Loads user profile data for the users route handler.',
    })
    graph.addNode('logger', {
      label: 'Logger',
      source_file: '/workspace/src/utils/logger.ts',
      line_number: 3,
      node_kind: 'class',
      file_type: 'code',
      community: 2,
    })

    graph.addEdge('route_users_show', 'show_user_profile', {
      relation: 'handles_route',
      confidence: 'EXTRACTED',
      source_file: '/workspace/src/routes/users.ts',
    })
    graph.addEdge('show_user_profile', 'get_user_profile', {
      relation: 'calls',
      confidence: 'EXTRACTED',
      source_file: '/workspace/src/routes/users.ts',
    })
    graph.addEdge('show_user_profile', 'logger', {
      relation: 'calls',
      confidence: 'EXTRACTED',
      source_file: '/workspace/src/routes/users.ts',
    })

    const result = featureMap(graph, {
      question: 'where should I edit the user profile route',
      budget: 2500,
      limit: 2,
      fileType: 'code',
    })

    expect(result.summary).toContain('Routes')
    expect(result.communities.map((community) => community.label)).toEqual(['Routes', 'Services'])
    expect(result.communities[0]).toEqual(
      expect.objectContaining({
        label: 'Routes',
        top_symbols: expect.arrayContaining(['GET /users/:id', 'showUserProfile']),
      }),
    )
    expect(result.entry_points[0]).toEqual(
      expect.objectContaining({
        label: 'GET /users/:id',
        source_file: 'src/routes/users.ts',
        node_kind: 'route',
      }),
    )
    expect(result.relevant_files[0]?.path).toBe('src/routes/users.ts')
  })

  it('omits missing_context when retrieve coverage was not computed', async () => {
    vi.resetModules()
    vi.doMock('../../src/runtime/retrieve.js', () => ({
      retrieveContext: vi.fn().mockReturnValue({
        question: 'where should I edit auth',
        token_count: 42,
        matched_nodes: [],
        relationships: [],
        community_context: [],
        graph_signals: { god_nodes: [], bridge_nodes: [] },
      }),
    }))

    const { featureMap: mockedFeatureMap } = await import('../../src/runtime/feature-map.js')
    const result = mockedFeatureMap(new KnowledgeGraph(), {
      question: 'where should I edit auth',
      budget: 2500,
    })

    expect(result).not.toHaveProperty('coverage')
    expect(result).not.toHaveProperty('missing_context')
  })
})
