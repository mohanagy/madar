import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import { buildRankedRisk, compareRankedRisks, riskMap } from '../../src/runtime/risk-map.js'

describe('riskMap', () => {
  it('returns blast radius risks plus structural hotspots for a feature question', () => {
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

    const result = riskMap(graph, {
      question: 'where should I edit the user profile route',
      budget: 2500,
      limit: 3,
      fileType: 'code',
    })

    expect(result.summary).toContain('getUserProfile')
    expect(result.top_risks[0]).toEqual(
      expect.objectContaining({
        label: 'getUserProfile',
        severity: 'high',
      }),
    )
    expect(result.top_risks[0]?.reason).toContain('communities')
    expect(result.top_risks[0]?.affected_files).toEqual(
      expect.arrayContaining(['src/routes/users.ts', 'src/account/screen.ts']),
    )
    expect(result.structural_hotspots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'getUserProfile',
          type: 'bridge',
        }),
      ]),
    )
    expect(result.starter_files[0]?.path).toBe('src/routes/users.ts')
  })

  it('sorts ranked risks by total score before tie-breaker signals', () => {
    const lowerScoreMoreHotspots = buildRankedRisk({
      label: 'LowerScoreMoreHotspots',
      totalAffected: 1,
      affectedFiles: ['src/one.ts'],
      affectedCommunities: ['One'],
      hotspotKinds: ['bridge', 'god node'],
      dependentCount: 1,
    })
    const higherScoreFewerHotspots = buildRankedRisk({
      label: 'HigherScoreFewerHotspots',
      totalAffected: 20,
      affectedFiles: ['src/two.ts'],
      affectedCommunities: ['One'],
      hotspotKinds: [],
      dependentCount: 0,
    })

    expect([lowerScoreMoreHotspots, higherScoreFewerHotspots].sort(compareRankedRisks).map((risk) => risk.label)).toEqual([
      'HigherScoreFewerHotspots',
      'LowerScoreMoreHotspots',
    ])
  })
})
