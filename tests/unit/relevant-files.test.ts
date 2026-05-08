import { vi } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { relevantFiles } from '../../src/runtime/relevant-files.js'

describe('relevantFiles', () => {
  it('ranks files and explains why they matter for a feature question', () => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.graph.root_path = '/workspace'
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

    const result = relevantFiles(graph, {
      question: 'where should I edit the user profile route',
      budget: 2500,
      limit: 2,
      fileType: 'code',
    })

    expect(result.relevant_files.map((entry) => entry.path)).toEqual([
      'src/routes/users.ts',
      'src/services/users.ts',
    ])
    expect(result.relevant_files[0]).toEqual(
      expect.objectContaining({
        path: 'src/routes/users.ts',
        matched_symbols: expect.arrayContaining(['GET /users/:id', 'showUserProfile']),
      }),
    )
    expect(result.relevant_files[0]?.why).toContain('GET /users/:id')
    expect(result.relevant_files[1]?.why).toContain('getUserProfile')
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

    const { relevantFiles: mockedRelevantFiles } = await import('../../src/runtime/relevant-files.js')
    const result = mockedRelevantFiles(new KnowledgeGraph(), {
      question: 'where should I edit auth',
      budget: 2500,
    })

    expect(result).not.toHaveProperty('coverage')
    expect(result).not.toHaveProperty('missing_context')
  })
})
