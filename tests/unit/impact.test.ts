import { join } from 'node:path'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { build } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { analyzeImpact, callChains, compactImpactResult } from '../../src/runtime/impact.js'

function buildTestGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })

  graph.addNode('auth', { label: 'authenticateUser', source_file: '/src/auth.ts', node_kind: 'function', file_type: 'code', community: 0 })
  graph.addNode('session', { label: 'SessionManager', source_file: '/src/session.ts', node_kind: 'class', file_type: 'code', community: 0 })
  graph.addNode('db', { label: 'DatabaseConnection', source_file: '/src/db.ts', node_kind: 'class', file_type: 'code', community: 1 })
  graph.addNode('user', { label: 'UserModel', source_file: '/src/models/user.ts', node_kind: 'class', file_type: 'code', community: 0 })
  graph.addNode('api', { label: 'ApiHandler', source_file: '/src/api.ts', node_kind: 'function', file_type: 'code', community: 2 })
  graph.addNode('logger', { label: 'Logger', source_file: '/src/utils/logger.ts', node_kind: 'class', file_type: 'code', community: 3 })

  graph.addEdge('api', 'auth', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/api.ts' })
  graph.addEdge('auth', 'session', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })
  graph.addEdge('auth', 'user', { relation: 'uses', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })
  graph.addEdge('session', 'db', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/session.ts' })
  graph.addEdge('auth', 'logger', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })

  return graph
}

function buildExpressRouteGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })

  graph.addNode('require_auth', {
    label: 'requireAuth',
    source_file: '/src/middleware/auth.ts',
    node_kind: 'function',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('show_user', {
    label: 'showUser',
    source_file: '/src/controllers/users.ts',
    node_kind: 'function',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('route_users_show', {
    label: 'GET /users/:id',
    source_file: '/src/routes/users.ts',
    node_kind: 'route',
    file_type: 'code',
    community: 1,
  })

  graph.addEdge('require_auth', 'route_users_show', {
    relation: 'middleware',
    confidence: 'EXTRACTED',
    source_file: '/src/routes/users.ts',
  })
  graph.addEdge('show_user', 'route_users_show', {
    relation: 'handles_route',
    confidence: 'EXTRACTED',
    source_file: '/src/routes/users.ts',
  })
  graph.addEdge('route_users_show', 'require_auth', {
    relation: 'depends_on',
    confidence: 'EXTRACTED',
    source_file: '/src/routes/users.ts',
  })
  graph.addEdge('route_users_show', 'show_user', {
    relation: 'depends_on',
    confidence: 'EXTRACTED',
    source_file: '/src/routes/users.ts',
  })

  return graph
}

describe('impact', () => {
  describe('analyzeImpact', () => {
    it('rejects undirected graphs instead of reporting reverse-edge false positives', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('caller', { label: 'caller', source_file: '/src/caller.ts' })
      graph.addNode('dependency', { label: 'dependency', source_file: '/src/dependency.ts' })
      graph.addEdge('caller', 'dependency', { relation: 'calls' })

      expect(() => analyzeImpact(graph, {}, { label: 'caller' })).toThrow(
        'Impact analysis requires a directed graph because edge orientation is part of the result.',
      )
    })

    it('finds direct dependents of a node', () => {
      const graph = buildTestGraph()
      const result = analyzeImpact(graph, {}, { label: 'authenticateUser' })

      expect(result.target).toBe('authenticateUser')
      expect(result.direct_dependents.map((d) => d.label)).toEqual(['ApiHandler'])
    })

    it('finds transitive dependents at depth 2+', () => {
      const graph = buildTestGraph()
      const result = analyzeImpact(graph, {}, { label: 'DatabaseConnection', depth: 3 })

      const transitiveLabels = result.transitive_dependents.map((d) => d.label)
      expect(transitiveLabels).toContain('authenticateUser')
      expect(transitiveLabels).toContain('ApiHandler')
    })

    it('reports affected files', () => {
      const graph = buildTestGraph()
      const result = analyzeImpact(graph, {}, { label: 'DatabaseConnection', depth: 3 })

      expect(result.affected_files.length).toBeGreaterThan(0)
      expect(result.affected_files).toContain('/src/session.ts')
    })

    it('relativizes in-root impact paths while preserving outside-root files', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.graph.root_path = '/workspace/app'
      graph.addNode('db', {
        label: 'DatabaseConnection',
        source_file: '/workspace/app/src/db.ts',
        node_kind: 'class',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('service', {
        label: 'AuthService',
        source_file: '/workspace/app/src/auth/service.ts',
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('vendor', {
        label: 'SharedAuditLogger',
        source_file: '/opt/shared/audit/logger.ts',
        node_kind: 'function',
        file_type: 'code',
        community: 1,
      })
      graph.addEdge('service', 'db', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/workspace/app/src/auth/service.ts' })
      graph.addEdge('vendor', 'service', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/opt/shared/audit/logger.ts' })

      const result = analyzeImpact(graph, {}, { label: 'DatabaseConnection', depth: 3 })

      expect(result.target_file).toBe('src/db.ts')
      expect(result.direct_dependents.find((node) => node.label === 'AuthService')?.source_file).toBe('src/auth/service.ts')
      expect(result.transitive_dependents.find((node) => node.label === 'SharedAuditLogger')?.source_file).toBe('/opt/shared/audit/logger.ts')
      expect(result.affected_files).toEqual(['/opt/shared/audit/logger.ts', 'src/auth/service.ts'])
    })

    it('reports affected communities', () => {
      const graph = buildTestGraph()
      const result = analyzeImpact(graph, { 0: 'Auth Module', 1: 'Database', 2: 'API Layer' }, { label: 'DatabaseConnection', depth: 3 })

      expect(result.affected_communities.length).toBeGreaterThan(0)
    })

    it('returns empty result for unknown label', () => {
      const graph = buildTestGraph()
      const result = analyzeImpact(graph, {}, { label: 'nonexistent' })

      expect(result.total_affected).toBe(0)
      expect(result.direct_dependents).toEqual([])
    })

    it('respects depth limit', () => {
      const graph = buildTestGraph()
      const shallow = analyzeImpact(graph, {}, { label: 'DatabaseConnection', depth: 1 })
      const deep = analyzeImpact(graph, {}, { label: 'DatabaseConnection', depth: 3 })

      expect(shallow.total_affected).toBeLessThanOrEqual(deep.total_affected)
      expect(shallow.transitive_dependents.length).toBe(0)
    })

    it('filters by edge types', () => {
      const graph = buildTestGraph()
      const callsOnly = analyzeImpact(graph, {}, { label: 'DatabaseConnection', edgeTypes: ['calls'] })
      const allEdges = analyzeImpact(graph, {}, { label: 'DatabaseConnection' })

      expect(callsOnly.total_affected).toBeLessThanOrEqual(allEdges.total_affected)
    })

    it('includes distance on each dependent', () => {
      const graph = buildTestGraph()
      const result = analyzeImpact(graph, {}, { label: 'DatabaseConnection', depth: 3 })

      for (const dep of result.direct_dependents) {
        expect(dep.distance).toBe(1)
      }
      for (const dep of result.transitive_dependents) {
        expect(dep.distance).toBeGreaterThan(1)
      }
    })

    it('returns shortest path evidence per affected community', () => {
      const graph = buildTestGraph()
      const result = analyzeImpact(graph, { 0: 'Auth Module', 2: 'API Layer' }, { label: 'SessionManager', depth: 3 })

      expect(result.top_paths_per_community).toEqual([
        {
          id: 0,
          label: 'Auth Module',
          distance: 1,
          path: ['SessionManager', 'authenticateUser'],
        },
        {
          id: 2,
          label: 'API Layer',
          distance: 2,
          path: ['SessionManager', 'authenticateUser', 'ApiHandler'],
        },
      ])
    })

    it('shows express routes as direct dependents of middleware and handlers', () => {
      const graph = buildExpressRouteGraph()

      const middlewareImpact = analyzeImpact(graph, {}, { label: 'requireAuth' })
      const handlerImpact = analyzeImpact(graph, {}, { label: 'showUser' })

      expect(middlewareImpact.direct_dependents).toEqual([
        expect.objectContaining({
          label: 'GET /users/:id',
          relation: 'depends_on',
        }),
      ])
      expect(handlerImpact.direct_dependents).toEqual([
        expect.objectContaining({
          label: 'GET /users/:id',
          relation: 'depends_on',
        }),
      ])
    })

    it('shows mounted child routes as direct dependents of inherited mount middleware', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const graph = build([
        extractJs(join(fixturesDir, 'express-mounted-router-parent.ts')),
        extractJs(join(fixturesDir, 'express-mounted-router-child.ts')),
      ], { directed: true })

      const result = analyzeImpact(graph, {}, { label: 'requireAuth' })

      expect(result.direct_dependents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'USE /api',
            relation: 'depends_on',
          }),
          expect.objectContaining({
            label: 'GET /api/users/:id',
            relation: 'depends_on',
          }),
        ]),
      )
    })

    it('shows recursively mounted child routes as direct dependents of inherited mount middleware', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const graph = build([
        extractJs(join(fixturesDir, 'express-nested-router-parent.ts')),
        extractJs(join(fixturesDir, 'express-nested-router-child.ts')),
        extractJs(join(fixturesDir, 'express-nested-router-grandchild.ts')),
      ], { directed: true })

      const authImpact = analyzeImpact(graph, {}, { label: 'requireAuth' })
      const auditImpact = analyzeImpact(graph, {}, { label: 'auditTrail' })

      expect(authImpact.direct_dependents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'GET /api/v1/users/:id',
          }),
        ]),
      )
      expect(auditImpact.direct_dependents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'GET /api/v1/users/:id',
          }),
        ]),
      )
    })

    it('shows patch and all express routes as direct dependents of middleware and handlers', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const graph = build([extractJs(join(fixturesDir, 'express-patch-all.ts'))], { directed: true })

      const middlewareImpact = analyzeImpact(graph, {}, { label: 'requireAuth' })
      const patchHandlerImpact = analyzeImpact(graph, {}, { label: 'patchUser' })
      const allHandlerImpact = analyzeImpact(graph, {}, { label: 'handleAudit' })

      expect(middlewareImpact.direct_dependents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'PATCH /users/:id/profile', relation: 'depends_on' }),
          expect.objectContaining({ label: 'ALL /users/:id/audit', relation: 'depends_on' }),
        ]),
      )
      expect(patchHandlerImpact.direct_dependents).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: 'PATCH /users/:id/profile', relation: 'depends_on' })]),
      )
      expect(allHandlerImpact.direct_dependents).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: 'ALL /users/:id/audit', relation: 'depends_on' })]),
      )
    })

    it('shows imported middleware routes as direct dependents across files', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const graph = build(
        [
          extractJs(join(fixturesDir, 'express-imported-middleware.ts')),
          extractJs(join(fixturesDir, 'express-imported-middleware-parent.ts')),
        ],
        { directed: true },
      )

      const result = analyzeImpact(graph, {}, { label: 'requireAuth' })

      expect(result.direct_dependents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'USE /api',
            relation: 'depends_on',
          }),
        ]),
      )
    })

    it('shows mounted child routes as direct dependents of cross-file handlers', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const graph = build(
        [
          extractJs(join(fixturesDir, 'express-mounted-router-parent.ts')),
          extractJs(join(fixturesDir, 'express-mounted-router-child.ts')),
        ],
        { directed: true },
      )

      const result = analyzeImpact(graph, {}, { label: 'showUser' })

      expect(result.direct_dependents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'GET /api/users/:id',
            relation: 'depends_on',
          }),
        ]),
      )
    })

    it('shows imported-owner express routes as direct dependents of cross-file handlers', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const graph = build(
        [
          extractJs(join(fixturesDir, 'express-imported-owner-router-child.ts')),
          extractJs(join(fixturesDir, 'express-imported-owner-router-parent.ts')),
          extractJs(join(fixturesDir, 'express-imported-owner-app-child.ts')),
          extractJs(join(fixturesDir, 'express-imported-owner-app-parent.ts')),
        ],
        { directed: true },
      )

      const routerResult = analyzeImpact(graph, {}, { label: 'showUser' })
      const appResult = analyzeImpact(graph, {}, { label: 'createUser' })

      expect(routerResult.direct_dependents).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: 'GET /users/:id', relation: 'depends_on' })]),
      )
      expect(appResult.direct_dependents).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: 'POST /users', relation: 'depends_on' })]),
      )
    })

    it('shows module-object mounted child routes as direct dependents of inherited mount middleware', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const namespaceGraph = build([
        extractJs(join(fixturesDir, 'express-namespace-module-parent.ts')),
        extractJs(join(fixturesDir, 'express-namespace-module-child.ts')),
      ], { directed: true })
      const commonjsGraph = build([
        extractJs(join(fixturesDir, 'express-commonjs-module-parent.ts')),
        extractJs(join(fixturesDir, 'express-commonjs-module-child.ts')),
      ], { directed: true })

      const namespaceResult = analyzeImpact(namespaceGraph, {}, { label: 'requireAuth' })
      const commonjsResult = analyzeImpact(commonjsGraph, {}, { label: 'requireAuth' })

      expect(namespaceResult.direct_dependents).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: 'GET /api/users/:id', relation: 'depends_on' })]),
      )
      expect(commonjsResult.direct_dependents).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: 'GET /api/users/:id', relation: 'depends_on' })]),
      )
    })

    it('shows redux slice blast radius through selectors, components, and routes', () => {
      const graph = new KnowledgeGraph({ directed: true })

      graph.addNode('auth_slice', {
        label: 'auth slice',
        source_file: '/src/state/authSlice.ts',
        node_kind: 'slice',
        file_type: 'code',
        framework: 'redux-toolkit',
        framework_role: 'redux_slice',
        community: 0,
      })
      graph.addNode('select_auth_status', {
        label: 'selectAuthStatus',
        source_file: '/src/state/authSlice.ts',
        node_kind: 'function',
        file_type: 'code',
        framework: 'redux-toolkit',
        framework_role: 'redux_selector',
        community: 0,
      })
      graph.addNode('store', {
        label: 'store',
        source_file: '/src/state/store.ts',
        node_kind: 'store',
        file_type: 'code',
        framework: 'redux-toolkit',
        framework_role: 'redux_store',
        community: 0,
      })
      graph.addNode('auth_status_badge', {
        label: 'AuthStatusBadge',
        source_file: '/src/components/AuthStatusBadge.tsx',
        node_kind: 'component',
        file_type: 'code',
        community: 1,
      })
      graph.addNode('settings_route', {
        label: '/settings',
        source_file: '/src/routes/settings.tsx',
        node_kind: 'route',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_route',
        community: 1,
      })

      graph.addEdge('auth_slice', 'select_auth_status', {
        relation: 'defines_selector',
        confidence: 'EXTRACTED',
        source_file: '/src/state/authSlice.ts',
      })
      graph.addEdge('auth_slice', 'store', {
        relation: 'registered_in_store',
        confidence: 'EXTRACTED',
        source_file: '/src/state/store.ts',
      })
      graph.addEdge('auth_status_badge', 'select_auth_status', {
        relation: 'uses',
        confidence: 'EXTRACTED',
        source_file: '/src/components/AuthStatusBadge.tsx',
      })
      graph.addEdge('settings_route', 'auth_status_badge', {
        relation: 'renders',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/settings.tsx',
      })

      const result = analyzeImpact(graph, { 0: 'State', 1: 'UI' }, { label: 'auth slice', depth: 4 })

      expect(result.direct_dependents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'selectAuthStatus' }),
          expect.objectContaining({ label: 'store' }),
        ]),
      )
      expect(result.transitive_dependents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'AuthStatusBadge' }),
          expect.objectContaining({ label: '/settings' }),
        ]),
      )
    })

    it('prefers higher-level route summaries for service blast radius within a community', () => {
      const graph = new KnowledgeGraph({ directed: true })

      graph.addNode('user_service', {
        label: 'userService',
        source_file: '/src/services/userService.ts',
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('normalize_user_record', {
        label: 'normalizeUserRecord',
        source_file: '/src/controllers/users.ts',
        node_kind: 'function',
        file_type: 'code',
        community: 1,
      })
      graph.addNode('show_user', {
        label: 'showUser',
        source_file: '/src/controllers/users.ts',
        node_kind: 'function',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_handler',
        community: 1,
      })
      graph.addNode('route_users_show', {
        label: 'GET /users/:id',
        source_file: '/src/routes/users.ts',
        node_kind: 'route',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_route',
        community: 1,
      })

      graph.addEdge('normalize_user_record', 'user_service', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/controllers/users.ts',
      })
      graph.addEdge('show_user', 'user_service', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/controllers/users.ts',
      })
      graph.addEdge('route_users_show', 'show_user', {
        relation: 'depends_on',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/users.ts',
      })

      const result = analyzeImpact(graph, { 0: 'Data', 1: 'Delivery' }, { label: 'userService', depth: 4 })

      expect(result.direct_dependents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'normalizeUserRecord' }),
          expect.objectContaining({ label: 'showUser' }),
        ]),
      )
      expect(result.top_paths_per_community).toEqual([
        {
          id: 1,
          label: 'Delivery',
          distance: 2,
          path: ['userService', 'showUser', 'GET /users/:id'],
        },
      ])
    })

    it('prefers higher-level route summaries for loader blast radius within a community', () => {
      const graph = new KnowledgeGraph({ directed: true })

      graph.addNode('dashboard_loader_service', {
        label: 'dashboardLoaderService',
        source_file: '/src/services/dashboardLoaderService.ts',
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('coerce_dashboard_data', {
        label: 'coerceDashboardData',
        source_file: '/src/routes/dashboard.tsx',
        node_kind: 'function',
        file_type: 'code',
        community: 1,
      })
      graph.addNode('dashboard_loader', {
        label: 'dashboardLoader',
        source_file: '/src/routes/dashboard.tsx',
        node_kind: 'function',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_loader',
        community: 1,
      })
      graph.addNode('dashboard_route', {
        label: '/dashboard',
        source_file: '/src/routes/dashboard.tsx',
        node_kind: 'route',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_route',
        community: 1,
      })

      graph.addEdge('coerce_dashboard_data', 'dashboard_loader_service', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/dashboard.tsx',
      })
      graph.addEdge('dashboard_loader', 'dashboard_loader_service', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/dashboard.tsx',
      })
      graph.addEdge('dashboard_route', 'dashboard_loader', {
        relation: 'loads_route',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/dashboard.tsx',
      })

      const result = analyzeImpact(graph, { 0: 'Data', 1: 'Routes' }, { label: 'dashboardLoaderService', depth: 4 })

      expect(result.direct_dependents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'coerceDashboardData' }),
          expect.objectContaining({ label: 'dashboardLoader' }),
        ]),
      )
      expect(result.top_paths_per_community).toEqual([
        {
          id: 1,
          label: 'Routes',
          distance: 2,
          path: ['dashboardLoaderService', 'dashboardLoader', '/dashboard'],
        },
      ])
    })

    it('sorts framework-aware direct dependents ahead of generic functions', () => {
      const graph = new KnowledgeGraph({ directed: true })

      graph.addNode('dashboard_loader_service', {
        label: 'dashboardLoaderService',
        source_file: '/src/services/dashboardLoaderService.ts',
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('coerce_dashboard_data', {
        label: 'coerceDashboardData',
        source_file: '/src/routes/dashboard.tsx',
        node_kind: 'function',
        file_type: 'code',
        community: 1,
      })
      graph.addNode('dashboard_loader', {
        label: 'dashboardLoader',
        source_file: '/src/routes/dashboard.tsx',
        node_kind: 'function',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_loader',
        community: 1,
      })

      graph.addEdge('coerce_dashboard_data', 'dashboard_loader_service', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/dashboard.tsx',
      })
      graph.addEdge('dashboard_loader', 'dashboard_loader_service', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/dashboard.tsx',
      })

      const result = analyzeImpact(graph, { 0: 'Data', 1: 'Routes' }, { label: 'dashboardLoaderService', depth: 2 })

      expect(result.direct_dependents.map((node) => node.label)).toEqual(['dashboardLoader', 'coerceDashboardData'])
    })

    it('compacts repeated dependent metadata for default payloads', () => {
      const graph = buildTestGraph()
      const rawResult = analyzeImpact(graph, { 0: 'Auth', 1: 'Data', 2: 'API', 3: 'Observability' }, {
        label: 'DatabaseConnection',
        depth: 3,
      })

      const compactResult = compactImpactResult(rawResult)

      expect(JSON.stringify(compactResult).length).toBeLessThan(JSON.stringify(rawResult).length)
      expect(compactResult.target_file_type).toBe('code')
      expect(compactResult.shared_file_type).toBe('code')
      expect(compactResult.direct_dependents[0]).not.toHaveProperty('file_type')
      expect(compactResult.direct_dependents[0]).not.toHaveProperty('community_label')
    })

    it('omits empty node_kind from raw and compact impact payloads', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('db', {
        label: 'DatabaseConnection',
        source_file: '/src/db.ts',
        node_kind: 'class',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('auth', {
        label: 'AuthService',
        source_file: '/src/auth.ts',
        file_type: 'code',
        community: 0,
      })
      graph.addEdge('auth', 'db', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })

      const rawResult = analyzeImpact(graph, {}, { label: 'DatabaseConnection', depth: 2 })
      const compactResult = compactImpactResult(rawResult)

      expect(rawResult.direct_dependents[0]).not.toHaveProperty('node_kind')
      expect(compactResult.direct_dependents[0]).not.toHaveProperty('node_kind')
    })

    it('shows nest controllers, modules, and routes as dependents of injected services', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const graph = build([
        extractJs(join(fixturesDir, 'nest-auth.module.ts')),
        extractJs(join(fixturesDir, 'nest-auth.controller.ts')),
        extractJs(join(fixturesDir, 'nest-auth.service.ts')),
      ], { directed: true })

      const result = analyzeImpact(graph, {}, { label: 'AuthService', depth: 2 })

      expect(result.direct_dependents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'AuthController', relation: 'injects' }),
          expect.objectContaining({ label: 'AuthModule', relation: 'provides' }),
        ]),
      )
      expect(result.transitive_dependents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'GET /auth/profile', relation: 'depends_on' }),
          expect.objectContaining({ label: 'POST /auth/login', relation: 'depends_on' }),
        ]),
      )
    })

    it('shows next routes as dependents of middleware and shared pages wrappers', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const graph = build([
        extractJs(join(fixturesDir, 'next-app', 'middleware.ts')),
        extractJs(join(fixturesDir, 'next-app', 'app', '(marketing)', 'dashboard', '[team]', 'layout.tsx')),
        extractJs(join(fixturesDir, 'next-app', 'app', '(marketing)', 'dashboard', '[team]', 'page.tsx')),
        extractJs(join(fixturesDir, 'next-app', 'app', '(marketing)', 'dashboard', '[team]', 'template.tsx')),
        extractJs(join(fixturesDir, 'next-app', 'app', '(marketing)', 'dashboard', '[team]', 'loading.tsx')),
        extractJs(join(fixturesDir, 'next-app', 'app', '(marketing)', 'dashboard', '[team]', 'error.tsx')),
        extractJs(join(fixturesDir, 'next-app', 'app', '(marketing)', 'dashboard', '[team]', 'not-found.tsx')),
        extractJs(join(fixturesDir, 'next-app', 'app', '(marketing)', 'dashboard', '[team]', '@modal', 'default.tsx')),
        extractJs(join(fixturesDir, 'next-app', 'app', '(marketing)', 'dashboard', '[team]', 'actions.ts')),
        extractJs(join(fixturesDir, 'next-app', 'app', '(marketing)', 'dashboard', '[team]', 'ClientTeamPanel.tsx')),
        extractJs(join(fixturesDir, 'next-app', 'app', 'api', 'teams', '[team]', 'route.ts')),
        extractJs(join(fixturesDir, 'next-pages', 'pages', 'account.tsx')),
        extractJs(join(fixturesDir, 'next-pages', 'pages', '_app.tsx')),
        extractJs(join(fixturesDir, 'next-pages', 'pages', '_document.tsx')),
        extractJs(join(fixturesDir, 'next-pages', 'pages', '_error.tsx')),
        extractJs(join(fixturesDir, 'next-pages', 'pages', 'api', 'auth', '[...nextauth].ts')),
      ], { directed: true })

      const middlewareResult = analyzeImpact(graph, {}, { label: 'middleware', depth: 2 })
      expect(middlewareResult.direct_dependents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: '/dashboard/[team]', relation: 'middleware' }),
          expect.objectContaining({ label: 'GET /api/teams/[team]', relation: 'middleware' }),
          expect.objectContaining({ label: 'POST /api/teams/[team]', relation: 'middleware' }),
        ]),
      )

      const appResult = analyzeImpact(graph, {}, { label: '_app', depth: 2 })
      expect(appResult.direct_dependents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: '/account', relation: 'depends_on' }),
        ]),
      )
    })
  })

  describe('callChains', () => {
    it('rejects undirected graphs instead of inventing reverse call chains', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('caller', { label: 'caller' })
      graph.addNode('dependency', { label: 'dependency' })
      graph.addEdge('caller', 'dependency', { relation: 'calls' })

      expect(() => callChains(graph, 'dependency', 'caller')).toThrow(
        'Call-chain analysis requires a directed graph because edge orientation is part of the result.',
      )
    })

    it('finds execution paths between two nodes', () => {
      const graph = buildTestGraph()
      const chains = callChains(graph, 'ApiHandler', 'DatabaseConnection')

      expect(chains.length).toBeGreaterThan(0)
      // Should find: ApiHandler -> authenticateUser -> SessionManager -> DatabaseConnection
      const longChain = chains.find((c) => c.length === 4)
      expect(longChain).toBeDefined()
      expect(longChain![0]).toBe('ApiHandler')
      expect(longChain![longChain!.length - 1]).toBe('DatabaseConnection')
    })

    it('returns empty for unknown labels', () => {
      const graph = buildTestGraph()
      const chains = callChains(graph, 'Nonexistent1', 'Nonexistent2')

      expect(chains.length).toBe(0)
    })

    it('returns empty for single unknown label', () => {
      const graph = buildTestGraph()
      const chains = callChains(graph, 'nonexistent', 'DatabaseConnection')

      expect(chains.length).toBe(0)
    })

    it('respects max hops', () => {
      const graph = buildTestGraph()
      const short = callChains(graph, 'ApiHandler', 'DatabaseConnection', 2)
      const long = callChains(graph, 'ApiHandler', 'DatabaseConnection', 8)

      expect(short.length).toBeLessThanOrEqual(long.length)
    })

    it('returns chains sorted by length', () => {
      const graph = buildTestGraph()
      const chains = callChains(graph, 'ApiHandler', 'DatabaseConnection')

      for (let i = 1; i < chains.length; i++) {
        expect(chains[i]!.length).toBeGreaterThanOrEqual(chains[i - 1]!.length)
      }
    })
  })
})
