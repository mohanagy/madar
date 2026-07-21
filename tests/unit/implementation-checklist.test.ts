import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import { implementationChecklist } from '../../src/runtime/implementation-checklist.js'

describe('implementationChecklist', () => {
  it('returns ordered edit steps plus validation checkpoints for a feature question', () => {
    const graph = new KnowledgeGraph()
    graph.graph.root_path = '/workspace'
    graph.graph.community_labels = {
      0: 'Routes',
      1: 'Services',
      2: 'Persistence',
      3: 'Account UI',
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
    graph.addNode('database', {
      label: 'DatabaseConnection',
      source_file: '/workspace/src/persistence/database.ts',
      line_number: 4,
      node_kind: 'class',
      file_type: 'code',
      community: 2,
    })
    graph.addNode('hydrate_account', {
      label: 'hydrateAccountScreen',
      source_file: '/workspace/src/account/screen.ts',
      line_number: 14,
      node_kind: 'function',
      file_type: 'code',
      community: 3,
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
    graph.addEdge('hydrate_account', 'get_user_profile', {
      relation: 'calls',
      confidence: 'EXTRACTED',
      source_file: '/workspace/src/account/screen.ts',
    })
    graph.addEdge('get_user_profile', 'database', {
      relation: 'calls',
      confidence: 'EXTRACTED',
      source_file: '/workspace/src/services/users.ts',
    })

    const result = implementationChecklist(graph, {
      question: 'where should I edit the user profile route',
      budget: 2500,
      limit: 3,
      fileType: 'code',
    })

    expect(result.summary).toContain('src/routes/users.ts')
    expect(result.edit_steps[0]).toEqual(
      expect.objectContaining({
        path: 'src/routes/users.ts',
      }),
    )
    expect(result.edit_steps[0]?.why).toContain('entry point')
    expect(result.edit_steps[1]).toEqual(
      expect.objectContaining({
        path: 'src/services/users.ts',
      }),
    )
    expect(result.validation_steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: expect.stringContaining('GET /users/:id'),
        }),
        expect.objectContaining({
          title: expect.stringContaining('getUserProfile'),
        }),
      ]),
    )
  })
})
