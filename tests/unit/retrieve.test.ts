import * as nodeFs from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import * as analyze from '../../src/pipeline/analyze.js'
import { build } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { inspectReduxModuleExports } from '../../src/pipeline/extract/frameworks/redux.js'
import { classifyTaskContract } from '../../src/runtime/context-pack.js'
import {
  compactRetrieveResult,
  compactRetrieveResultForStdio,
  contextPackFromRetrieveResult,
  reciprocalRankFuse,
  retrieveContext,
  scoreNode,
  tokenWeightsForQuestion,
  tokenizeLabel,
  tokenizeQuestion,
} from '../../src/runtime/retrieve.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { afterEach, vi } from 'vitest'

describe('retrieve', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doUnmock('node:fs')
  })

  describe('tokenizeQuestion', () => {
    it('splits words and removes stop words', () => {
      const tokens = tokenizeQuestion('how does auth middleware work?')
      expect(tokens).toEqual(['auth', 'middleware', 'work'])
    })

    it('splits camelCase in questions', () => {
      const tokens = tokenizeQuestion('authenticateUser flow')
      expect(tokens).toEqual(['authenticate', 'user', 'flow'])
    })

    it('returns empty for all stop words', () => {
      expect(tokenizeQuestion('how does the')).toEqual([])
    })

    it('filters single character tokens', () => {
      expect(tokenizeQuestion('a b c auth')).toEqual(['auth'])
    })
  })

  describe('tokenizeLabel', () => {
    it('splits camelCase labels', () => {
      expect(tokenizeLabel('authenticateUser')).toEqual(['authenticate', 'user'])
    })

    it('splits snake_case labels', () => {
      expect(tokenizeLabel('session_manager')).toEqual(['session', 'manager'])
    })

    it('splits mixed separators', () => {
      expect(tokenizeLabel('auth-middleware.handler')).toEqual(['auth', 'middleware', 'handler'])
    })

    it('handles all lowercase', () => {
      expect(tokenizeLabel('database')).toEqual(['database'])
    })
  })

  describe('scoreNode', () => {
    it('scores prefix matches', () => {
      const score = scoreNode(['auth'], ['authenticate', 'user'])
      expect(score).toBe(1)
    })

    it('scores reverse prefix matches', () => {
      const score = scoreNode(['authentication'], ['auth'])
      expect(score).toBe(1)
    })

    it('scores zero for unrelated terms', () => {
      const score = scoreNode(['database'], ['authenticate', 'user'])
      expect(score).toBe(0)
    })

    it('scores multiple matches', () => {
      const score = scoreNode(['auth', 'user'], ['authenticate', 'user'])
      expect(score).toBe(2)
    })
  })

  describe('reciprocalRankFuse', () => {
    it('prefers candidates that appear across multiple evidence rankings', () => {
      const fused = reciprocalRankFuse([
        ['focused', 'label_only'],
        ['path_only', 'focused'],
        ['focused', 'community_only'],
      ])

      expect((fused.get('focused') ?? 0)).toBeGreaterThan(fused.get('label_only') ?? 0)
      expect((fused.get('focused') ?? 0)).toBeGreaterThan(fused.get('path_only') ?? 0)
    })
  })

  describe('retrieveContext', () => {
    function buildTestGraph(): KnowledgeGraph {
      const graph = new KnowledgeGraph()

      graph.addNode('auth_user', {
        label: 'authenticateUser',
        source_file: '/src/auth.ts',
        line_number: 10,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })

      graph.addNode('session_mgr', {
        label: 'SessionManager',
        source_file: '/src/session.ts',
        line_number: 5,
        node_kind: 'class',
        file_type: 'code',
        community: 0,
      })

      graph.addNode('db_conn', {
        label: 'DatabaseConnection',
        source_file: '/src/db.ts',
        line_number: 1,
        node_kind: 'class',
        file_type: 'code',
        community: 1,
      })

      graph.addNode('user_model', {
        label: 'UserModel',
        source_file: '/src/models/user.ts',
        line_number: 3,
        node_kind: 'class',
        file_type: 'code',
        community: 0,
      })

      graph.addNode('logger', {
        label: 'Logger',
        source_file: '/src/utils/logger.ts',
        line_number: 1,
        node_kind: 'class',
        file_type: 'code',
        community: 2,
      })

      graph.addEdge('auth_user', 'session_mgr', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })
      graph.addEdge('auth_user', 'user_model', { relation: 'uses', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })
      graph.addEdge('session_mgr', 'db_conn', { relation: 'depends_on', confidence: 'EXTRACTED', source_file: '/src/session.ts' })
      graph.addEdge('auth_user', 'logger', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })

      return graph
    }

    function buildExpansionGraph(): KnowledgeGraph {
      const graph = new KnowledgeGraph()

      graph.addNode('auth_user', {
        label: 'authenticateUser',
        source_file: '/src/auth.ts',
        line_number: 10,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('auth_flow_controller', {
        label: 'AuthFlowController',
        source_file: '/src/auth/flow-controller.ts',
        line_number: 20,
        node_kind: 'class',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('auth_guard', {
        label: 'AuthGuard',
        source_file: '/src/auth/guard.ts',
        line_number: 30,
        node_kind: 'class',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('auth_policy', {
        label: 'AuthPolicy',
        source_file: '/src/auth/policy.ts',
        line_number: 40,
        node_kind: 'class',
        file_type: 'code',
        community: 0,
      })

      graph.addNode('session_mgr', {
        label: 'SessionManager',
        source_file: '/src/session.ts',
        source_location: 'L5-L8',
        node_kind: 'class',
        file_type: 'code',
        community: 2,
      })
      graph.addNode('session_validator', {
        label: 'SessionValidator',
        source_file: '/src/session-validator.ts',
        line_number: 6,
        node_kind: 'class',
        file_type: 'code',
        community: 2,
      })
      graph.addNode('session_router', {
        label: 'SessionRouter',
        source_file: '/src/session-router.ts',
        line_number: 7,
        node_kind: 'class',
        file_type: 'code',
        community: 2,
      })
      graph.addNode('session_policy', {
        label: 'SessionPolicy',
        source_file: '/src/session-policy.ts',
        line_number: 8,
        node_kind: 'class',
        file_type: 'code',
        community: 2,
      })

      graph.addNode('billing_store', {
        label: 'BillingStore',
        source_file: '/src/billing.ts',
        line_number: 9,
        node_kind: 'class',
        file_type: 'code',
        community: 1,
      })
      graph.addNode('billing_cache', {
        label: 'BillingCache',
        source_file: '/src/billing-cache.ts',
        line_number: 10,
        node_kind: 'class',
        file_type: 'code',
        community: 1,
      })
      graph.addNode('invoice_ledger', {
        label: 'InvoiceLedger',
        source_file: '/src/invoice-ledger.ts',
        line_number: 11,
        node_kind: 'class',
        file_type: 'code',
        community: 1,
      })
      graph.addNode('tax_rules', {
        label: 'TaxRules',
        source_file: '/src/tax-rules.ts',
        line_number: 12,
        node_kind: 'class',
        file_type: 'code',
        community: 1,
      })

      graph.addEdge('auth_user', 'session_mgr', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })
      graph.addEdge('auth_flow_controller', 'session_validator', {
        relation: 'imports_from',
        confidence: 'EXTRACTED',
        source_file: '/src/auth/flow-controller.ts',
      })
      graph.addEdge('auth_guard', 'session_router', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/auth/guard.ts',
      })
      graph.addEdge('auth_policy', 'session_policy', {
        relation: 'defines',
        confidence: 'EXTRACTED',
        source_file: '/src/auth/policy.ts',
      })
      graph.addEdge('auth_guard', 'billing_store', {
        relation: 'depends_on',
        confidence: 'EXTRACTED',
        source_file: '/src/auth/guard.ts',
      })
      graph.addEdge('billing_store', 'billing_cache', {
        relation: 'depends_on',
        confidence: 'EXTRACTED',
        source_file: '/src/billing.ts',
      })
      graph.addEdge('billing_store', 'invoice_ledger', {
        relation: 'uses',
        confidence: 'EXTRACTED',
        source_file: '/src/billing.ts',
      })
      graph.addEdge('billing_store', 'tax_rules', {
        relation: 'uses',
        confidence: 'EXTRACTED',
        source_file: '/src/billing.ts',
      })
      graph.graph.community_labels = {
        0: 'Authentication',
        1: 'Billing',
        2: 'Session',
      }

      return graph
    }

    function stripFileNodes(extraction: ReturnType<typeof extractJs>): ReturnType<typeof extractJs> {
      const nodeIds = new Set(extraction.nodes.filter((node) => String(node.node_kind ?? '') !== '').map((node) => node.id))
      return {
        ...extraction,
        nodes: extraction.nodes.filter((node) => nodeIds.has(node.id)),
        edges: extraction.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
      }
    }

    function buildReduxAliasBaselineGraph(
      sliceExtraction: ReturnType<typeof extractJs>,
      storeExtraction: ReturnType<typeof extractJs>,
      sliceFilePath: string,
    ): KnowledgeGraph {
      const exportedBindings = inspectReduxModuleExports(sliceFilePath)
      const semanticSliceNode = sliceExtraction.nodes.find((node) => node.label === 'auth slice')
      const semanticSelectorNode = sliceExtraction.nodes.find((node) => node.label === 'selectAuthStatus')
      const semanticStoreNode = storeExtraction.nodes.find((node) => node.label === 'store')

      expect(semanticSliceNode).toBeDefined()
      expect(semanticSelectorNode).toBeDefined()
      expect(semanticStoreNode).toBeDefined()
      expect(exportedBindings.get('authSlice')).toBeDefined()
      expect(exportedBindings.get('authReducer')).toBeDefined()
      expect(exportedBindings.get('selectAuthStatus')).toBeDefined()

      const authSliceBinding = exportedBindings.get('authSlice')!
      const authReducerBinding = exportedBindings.get('authReducer')!
      const selectAuthStatusBinding = exportedBindings.get('selectAuthStatus')!

      return build(
        [
          {
            nodes: [
              {
                ...semanticStoreNode!,
                framework: undefined,
                framework_role: undefined,
              },
              {
                ...semanticSliceNode!,
                id: `${semanticSliceNode!.id}__authSlice`,
                label: 'authSlice',
                node_kind: 'function',
                framework: undefined,
                framework_role: undefined,
                line_number: authSliceBinding.line,
              },
              {
                ...semanticSliceNode!,
                id: `${semanticSliceNode!.id}__authReducer`,
                label: 'authReducer',
                node_kind: 'function',
                framework: undefined,
                framework_role: undefined,
                line_number: authReducerBinding.line,
              },
              {
                ...semanticSelectorNode!,
                id: `${semanticSelectorNode!.id}__selectAuthStatus`,
                label: 'selectAuthStatus',
                framework: undefined,
                framework_role: undefined,
                line_number: selectAuthStatusBinding.line,
              },
            ],
            edges: [
              {
                source: semanticStoreNode!.id,
                target: `${semanticSliceNode!.id}__authReducer`,
                relation: 'uses',
                confidence: 'INFERRED',
                source_file: semanticStoreNode!.source_file,
                line_number: semanticStoreNode!.line_number,
              },
              {
                source: `${semanticSliceNode!.id}__authSlice`,
                target: `${semanticSliceNode!.id}__authReducer`,
                relation: 'defines',
                confidence: 'INFERRED',
                source_file: authSliceBinding.sourceFile,
                line_number: authReducerBinding.line,
              },
              {
                source: `${semanticSliceNode!.id}__authSlice`,
                target: `${semanticSelectorNode!.id}__selectAuthStatus`,
                relation: 'uses',
                confidence: 'INFERRED',
                source_file: authSliceBinding.sourceFile,
                line_number: selectAuthStatusBinding.line,
              },
            ],
          },
        ],
        { directed: true },
      )
    }

    it('returns empty result for no matching tokens', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'how does the', budget: 5000 })

      expect(result.question).toBe('how does the')
      expect(result.token_count).toBe(0)
      expect(result.matched_nodes).toEqual([])
      expect(result.relationships).toEqual([])
    })

    it('matches nodes by label tokens', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'auth user', budget: 5000 })

      expect(result.matched_nodes.length).toBeGreaterThan(0)
      const labels = result.matched_nodes.map((n) => n.label)
      expect(labels).toContain('authenticateUser')
    })

    it('prefers focused label matches over noisy long labels for narrow symbol queries', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('noisy_auth', {
        label: 'AuthServiceControllerSessionLogger',
        source_file: '/src/noisy-auth.ts',
        line_number: 1,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('focused_auth', {
        label: 'AuthService',
        source_file: '/src/auth.ts',
        line_number: 1,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })

      const result = retrieveContext(graph, { question: 'auth service class', budget: 3000 })

      expect(result.matched_nodes[0]?.label).toBe('AuthService')
    })

    it('ranks express route nodes first for route-shaped questions', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('route_users_show', {
        label: 'GET /users/:id',
        source_file: '/src/routes/users.ts',
        line_number: 12,
        node_kind: 'route',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('require_auth', {
        label: 'requireAuth',
        source_file: '/src/middleware/auth.ts',
        line_number: 3,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('show_user', {
        label: 'showUser',
        source_file: '/src/controllers/users.ts',
        line_number: 7,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
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

      const result = retrieveContext(graph, {
        question: 'where is GET /users/:id defined',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'GET /users/:id',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
    })

    it('prefers express route summaries for middleware-shaped questions over helper functions', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('route_users_show', {
        label: 'GET /users/:id',
        source_file: '/src/routes/users.ts',
        line_number: 12,
        node_kind: 'route',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_route',
        community: 0,
      })
      graph.addNode('require_auth', {
        label: 'requireAuth',
        source_file: '/src/middleware/auth.ts',
        line_number: 3,
        node_kind: 'function',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_middleware',
        community: 0,
      })
      graph.addNode('show_user', {
        label: 'showUser',
        source_file: '/src/controllers/users.ts',
        line_number: 7,
        node_kind: 'function',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_handler',
        community: 0,
      })
      graph.addNode('auth_users_helper', {
        label: 'authUsersMiddlewareHelper',
        source_file: '/src/utils/auth-users.ts',
        line_number: 20,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
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
      graph.addEdge('auth_users_helper', 'require_auth', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/utils/auth-users.ts',
      })

      const result = retrieveContext(graph, {
        question: 'which express route uses auth middleware for users',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'GET /users/:id',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
      expect(result.matched_nodes.slice(0, 3).map((node) => node.label)).toEqual(expect.arrayContaining(['requireAuth']))
      expect(result.matched_nodes.findIndex((node) => node.label === 'GET /users/:id')).toBeLessThan(
        result.matched_nodes.findIndex((node) => node.label === 'authUsersMiddlewareHelper'),
      )
    })

    it('does not boost react router routes for express-shaped questions in mixed-framework graphs', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('express_route', {
        label: 'GET /users',
        source_file: '/src/server/users.ts',
        line_number: 10,
        node_kind: 'route',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_route',
        community: 0,
      })
      graph.addNode('require_auth', {
        label: 'requireAuth',
        source_file: '/src/server/auth.ts',
        line_number: 4,
        node_kind: 'function',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_middleware',
        community: 0,
      })
      graph.addNode('show_user', {
        label: 'showUser',
        source_file: '/src/server/users.ts',
        line_number: 20,
        node_kind: 'function',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_handler',
        community: 0,
      })
      graph.addNode('react_route', {
        label: '/users',
        source_file: '/src/app/routes.tsx',
        line_number: 12,
        node_kind: 'route',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_route',
        community: 1,
      })
      graph.addNode('users_page', {
        label: 'UsersPage',
        source_file: '/src/app/users-page.tsx',
        line_number: 3,
        node_kind: 'component',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_component',
        community: 1,
      })
      graph.addEdge('express_route', 'require_auth', {
        relation: 'depends_on',
        confidence: 'EXTRACTED',
        source_file: '/src/server/users.ts',
      })
      graph.addEdge('express_route', 'show_user', {
        relation: 'depends_on',
        confidence: 'EXTRACTED',
        source_file: '/src/server/users.ts',
      })
      graph.addEdge('react_route', 'users_page', {
        relation: 'renders',
        confidence: 'EXTRACTED',
        source_file: '/src/app/routes.tsx',
      })

      const result = retrieveContext(graph, {
        question: 'which express route uses auth middleware for users',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes.findIndex((node) => node.label === 'GET /users')).toBeLessThan(
        result.matched_nodes.findIndex((node) => node.label === '/users'),
      )
      expect(result.matched_nodes.findIndex((node) => node.label === 'requireAuth')).toBeLessThan(
        result.matched_nodes.findIndex((node) => node.label === '/users'),
      )
    })

    it('does not boost express routes for react-router-shaped questions in mixed-framework graphs', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('express_route', {
        label: 'GET /users',
        source_file: '/src/server/users.ts',
        line_number: 10,
        node_kind: 'route',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_route',
        community: 0,
      })
      graph.addNode('show_user', {
        label: 'showUser',
        source_file: '/src/server/users.ts',
        line_number: 20,
        node_kind: 'function',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_handler',
        community: 0,
      })
      graph.addNode('react_route', {
        label: '/users',
        source_file: '/src/app/routes.tsx',
        line_number: 12,
        node_kind: 'route',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_route',
        community: 1,
      })
      graph.addNode('users_page', {
        label: 'UsersPage',
        source_file: '/src/app/users-page.tsx',
        line_number: 3,
        node_kind: 'component',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_component',
        community: 1,
      })
      graph.addEdge('express_route', 'show_user', {
        relation: 'depends_on',
        confidence: 'EXTRACTED',
        source_file: '/src/server/users.ts',
      })
      graph.addEdge('react_route', 'users_page', {
        relation: 'renders',
        confidence: 'EXTRACTED',
        source_file: '/src/app/routes.tsx',
      })

      const result = retrieveContext(graph, {
        question: 'which react router route renders users page',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes.findIndex((node) => node.label === '/users')).toBeLessThan(
        result.matched_nodes.findIndex((node) => node.label === 'GET /users'),
      )
      expect(result.matched_nodes.findIndex((node) => node.label === 'UsersPage')).toBeLessThan(
        result.matched_nodes.findIndex((node) => node.label === 'GET /users'),
      )
    })

    it('ranks mounted express route nodes by their propagated prefix', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const graph = build([
        extractJs(join(fixturesDir, 'express-mounted-router-parent.ts')),
        extractJs(join(fixturesDir, 'express-mounted-router-child.ts')),
      ])

      const result = retrieveContext(graph, {
        question: 'where is GET /api/users/:id defined',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'GET /api/users/:id',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
    })

    it('ranks recursively mounted express route nodes by their propagated prefixes', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const graph = build([
        extractJs(join(fixturesDir, 'express-nested-router-parent.ts')),
        extractJs(join(fixturesDir, 'express-nested-router-child.ts')),
        extractJs(join(fixturesDir, 'express-nested-router-grandchild.ts')),
      ])

      const result = retrieveContext(graph, {
        question: 'where is GET /api/v1/users/:id defined',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'GET /api/v1/users/:id',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
    })

    it('ranks patch and all express route nodes by their verb labels', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const graph = build([extractJs(join(fixturesDir, 'express-patch-all.ts'))])

      const patchResult = retrieveContext(graph, {
        question: 'where is PATCH /users/:id/profile defined',
        budget: 5000,
        fileType: 'code',
      })
      const allResult = retrieveContext(graph, {
        question: 'where is ALL /users/:id/audit defined',
        budget: 5000,
        fileType: 'code',
      })

      expect(patchResult.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'PATCH /users/:id/profile',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
      expect(allResult.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'ALL /users/:id/audit',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
    })

    it('does not route-boost free-text middleware usage questions because of "use"', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('auth_middleware_route', {
        label: 'USE /auth',
        source_file: '/src/server/auth.ts',
        line_number: 12,
        node_kind: 'route',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_route',
        community: 0,
      })
      graph.addNode('auth_middleware', {
        label: 'authMiddleware',
        source_file: '/src/server/auth-middleware.ts',
        line_number: 4,
        node_kind: 'function',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_middleware',
        community: 0,
      })
      graph.addNode('apply_auth_middleware', {
        label: 'applyAuthMiddleware',
        source_file: '/src/server/bootstrap.ts',
        line_number: 20,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addEdge('auth_middleware_route', 'auth_middleware', {
        relation: 'depends_on',
        confidence: 'EXTRACTED',
        source_file: '/src/server/auth.ts',
      })
      graph.addEdge('apply_auth_middleware', 'auth_middleware', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/server/bootstrap.ts',
      })

      const result = retrieveContext(graph, {
        question: 'Where do we use auth middleware?',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'authMiddleware',
          framework_boost: 2.5,
        }),
      )
      expect(result.matched_nodes.find((node) => node.label === 'USE /auth')).toEqual(
        expect.objectContaining({
          framework_boost: 0,
        }),
      )
    })

    it('does not route-boost free-text handler questions', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('auth_handler_route', {
        label: 'GET /auth',
        source_file: '/src/server/auth.ts',
        line_number: 12,
        node_kind: 'route',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_route',
        community: 0,
      })
      graph.addNode('auth_handler', {
        label: 'authHandler',
        source_file: '/src/server/auth-handler.ts',
        line_number: 4,
        node_kind: 'function',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_handler',
        community: 0,
      })
      graph.addNode('bind_auth_handler', {
        label: 'bindAuthHandler',
        source_file: '/src/server/bootstrap.ts',
        line_number: 20,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addEdge('auth_handler_route', 'auth_handler', {
        relation: 'depends_on',
        confidence: 'EXTRACTED',
        source_file: '/src/server/auth.ts',
      })
      graph.addEdge('bind_auth_handler', 'auth_handler', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/server/bootstrap.ts',
      })

      const result = retrieveContext(graph, {
        question: 'Where is the auth handler used?',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'authHandler',
          framework_boost: 2.5,
        }),
      )
      expect(result.matched_nodes.find((node) => node.label === 'GET /auth')).toEqual(
        expect.objectContaining({
          framework_boost: 0,
        }),
      )
    })

    it('does not infer express route intent from "all" in redux selector questions', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('all_auth_route', {
        label: 'ALL /auth',
        source_file: '/src/server/auth.ts',
        line_number: 12,
        node_kind: 'route',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_route',
        community: 0,
      })
      graph.addNode('auth_slice', {
        label: 'auth slice',
        source_file: '/src/state/authSlice.ts',
        line_number: 5,
        node_kind: 'slice',
        file_type: 'code',
        framework: 'redux-toolkit',
        framework_role: 'redux_slice',
        community: 1,
      })
      graph.addNode('select_auth_state', {
        label: 'selectAuthState',
        source_file: '/src/state/authSlice.ts',
        line_number: 14,
        node_kind: 'function',
        file_type: 'code',
        framework: 'redux-toolkit',
        framework_role: 'redux_selector',
        community: 1,
      })
      graph.addEdge('auth_slice', 'select_auth_state', {
        relation: 'defines_selector',
        confidence: 'EXTRACTED',
        source_file: '/src/state/authSlice.ts',
      })

      const result = retrieveContext(graph, {
        question: 'show all selectors for auth state',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'selectAuthState',
          framework_boost: 3.5,
        }),
      )
      expect(result.matched_nodes.find((node) => node.label === 'ALL /auth')).toEqual(
        expect.objectContaining({
          framework_boost: 0,
        }),
      )
    })

    it('still route-boosts real HEAD route questions', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('head_health', {
        label: 'HEAD /health',
        source_file: '/src/server/health.ts',
        line_number: 8,
        node_kind: 'route',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_route',
        community: 0,
      })
      graph.addNode('health_handler', {
        label: 'healthHandler',
        source_file: '/src/server/health.ts',
        line_number: 16,
        node_kind: 'function',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_handler',
        community: 0,
      })
      graph.addEdge('head_health', 'health_handler', {
        relation: 'depends_on',
        confidence: 'EXTRACTED',
        source_file: '/src/server/health.ts',
      })

      const result = retrieveContext(graph, {
        question: 'where is HEAD /health defined',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'HEAD /health',
          node_kind: 'route',
          framework_boost: 4,
        }),
      )
    })

    it('still route-boosts HEAD request questions without an explicit route path', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('head_health', {
        label: 'HEAD /health',
        source_file: '/src/server/health.ts',
        line_number: 8,
        node_kind: 'route',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_route',
        community: 0,
      })
      graph.addNode('health_handler', {
        label: 'healthHandler',
        source_file: '/src/server/health.ts',
        line_number: 16,
        node_kind: 'function',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_handler',
        community: 0,
      })
      graph.addEdge('head_health', 'health_handler', {
        relation: 'depends_on',
        confidence: 'EXTRACTED',
        source_file: '/src/server/health.ts',
      })

      const result = retrieveContext(graph, {
        question: 'which HEAD requests are defined',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'HEAD /health',
          node_kind: 'route',
          framework_boost: 4,
        }),
      )
    })

    it('does not infer express route intent from "all requests" in redux questions', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('all_auth_route', {
        label: 'ALL /auth',
        source_file: '/src/server/auth.ts',
        line_number: 12,
        node_kind: 'route',
        file_type: 'code',
        framework: 'express',
        framework_role: 'express_route',
        community: 0,
      })
      graph.addNode('auth_slice', {
        label: 'auth slice',
        source_file: '/src/state/authSlice.ts',
        line_number: 5,
        node_kind: 'slice',
        file_type: 'code',
        framework: 'redux-toolkit',
        framework_role: 'redux_slice',
        community: 1,
      })
      graph.addNode('select_auth_state', {
        label: 'selectAuthState',
        source_file: '/src/state/authSlice.ts',
        line_number: 14,
        node_kind: 'function',
        file_type: 'code',
        framework: 'redux-toolkit',
        framework_role: 'redux_selector',
        community: 1,
      })
      graph.addEdge('auth_slice', 'select_auth_state', {
        relation: 'defines_selector',
        confidence: 'EXTRACTED',
        source_file: '/src/state/authSlice.ts',
      })

      const result = retrieveContext(graph, {
        question: 'show all requests for auth state',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'auth slice',
          framework_boost: 3.5,
        }),
      )
      expect(result.matched_nodes.find((node) => node.label === 'ALL /auth')).toEqual(
        expect.objectContaining({
          framework_boost: 0,
        }),
      )
    })

    it('ranks routes registered on imported express owners without local express imports', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const graph = build([
        extractJs(join(fixturesDir, 'express-imported-owner-router-child.ts')),
        extractJs(join(fixturesDir, 'express-imported-owner-router-parent.ts')),
        extractJs(join(fixturesDir, 'express-imported-owner-app-child.ts')),
        extractJs(join(fixturesDir, 'express-imported-owner-app-parent.ts')),
      ])

      const namedResult = retrieveContext(graph, {
        question: 'where is GET /users/:id defined',
        budget: 5000,
        fileType: 'code',
      })
      const defaultResult = retrieveContext(graph, {
        question: 'where is POST /users defined',
        budget: 5000,
        fileType: 'code',
      })

      expect(namedResult.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'GET /users/:id',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
      expect(defaultResult.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'POST /users',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
    })

    it('ranks module-object mounted express route nodes by their propagated prefixes', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const namespaceGraph = build([
        extractJs(join(fixturesDir, 'express-namespace-module-parent.ts')),
        extractJs(join(fixturesDir, 'express-namespace-module-child.ts')),
      ])
      const commonjsGraph = build([
        extractJs(join(fixturesDir, 'express-commonjs-module-parent.ts')),
        extractJs(join(fixturesDir, 'express-commonjs-module-child.ts')),
      ])

      const namespaceResult = retrieveContext(namespaceGraph, {
        question: 'where is GET /api/users/:id defined',
        budget: 5000,
        fileType: 'code',
      })
      const commonjsResult = retrieveContext(commonjsGraph, {
        question: 'where is GET /api/users/:id defined',
        budget: 5000,
        fileType: 'code',
      })

      expect(namespaceResult.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'GET /api/users/:id',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
      expect(commonjsResult.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'GET /api/users/:id',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
    })

    it('answers auth slice questions from extracted redux toolkit graphs with fewer low-level baseline matches', () => {
      const sliceFilePath = join(process.cwd(), 'tests', 'fixtures', 'redux-retrieve-auth-slice.ts')
      const storeFilePath = join(process.cwd(), 'tests', 'fixtures', 'redux-retrieve-auth-store.ts')
      const semanticSliceExtraction = stripFileNodes(extractJs(sliceFilePath))
      const semanticStoreExtraction = stripFileNodes(extractJs(storeFilePath))
      const semanticGraph = build([semanticSliceExtraction, semanticStoreExtraction], { directed: true })
      const baselineGraph = buildReduxAliasBaselineGraph(semanticSliceExtraction, semanticStoreExtraction, sliceFilePath)

      const semanticResult = retrieveContext(semanticGraph, {
        question: 'which slice owns auth state',
        budget: 5000,
        fileType: 'code',
      })
      const baselineResult = retrieveContext(baselineGraph, {
        question: 'which slice owns auth state',
        budget: 5000,
        fileType: 'code',
      })

      const isLowLevelMatch = (label: string, nodeKind?: string): boolean =>
        nodeKind !== 'slice' &&
        nodeKind !== 'store' &&
        tokenizeLabel(label).some((token) => ['auth', 'state', 'slice'].some((queryToken) => token.startsWith(queryToken) || queryToken.startsWith(token)))
      const semanticLowLevelMatches = semanticResult.matched_nodes.filter((node) => isLowLevelMatch(node.label, node.node_kind))
      const baselineLowLevelMatches = baselineResult.matched_nodes.filter((node) => isLowLevelMatch(node.label, node.node_kind))

      expect(semanticResult.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'auth slice',
          node_kind: 'slice',
          relevance_band: 'direct',
        }),
      )
      expect(semanticResult.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: 'auth slice',
            to: 'store',
            relation: 'registered_in_store',
          }),
        ]),
      )
      expect(semanticLowLevelMatches.map((node) => node.label)).toEqual(expect.arrayContaining(['selectAuthStatus']))
      expect(baselineLowLevelMatches.map((node) => node.label)).toEqual(
        expect.arrayContaining(['authSlice', 'authReducer', 'selectAuthStatus']),
      )
      expect(semanticLowLevelMatches.length).toBeLessThan(baselineLowLevelMatches.length)
      const semanticCompact = compactRetrieveResult(semanticResult)
      const baselineCompact = compactRetrieveResult(baselineResult)

      expect(
        semanticCompact.matched_nodes.filter((node) => isLowLevelMatch(node.label, node.node_kind)).length,
      ).toBeLessThanOrEqual(
        baselineCompact.matched_nodes.filter((node) => isLowLevelMatch(node.label, node.node_kind)).length,
      )
    })

    it('prefers redux slice and selector summaries over utility helpers for redux-shaped questions', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('auth_slice', {
        label: 'auth slice',
        source_file: '/src/state/authSlice.ts',
        line_number: 5,
        node_kind: 'slice',
        file_type: 'code',
        framework: 'redux-toolkit',
        framework_role: 'redux_slice',
        community: 0,
      })
      graph.addNode('select_auth_status', {
        label: 'selectAuthStatus',
        source_file: '/src/state/authSlice.ts',
        line_number: 24,
        node_kind: 'function',
        file_type: 'code',
        framework: 'redux-toolkit',
        framework_role: 'redux_selector',
        community: 0,
      })
      graph.addNode('store', {
        label: 'store',
        source_file: '/src/state/store.ts',
        line_number: 3,
        node_kind: 'store',
        file_type: 'code',
        framework: 'redux-toolkit',
        framework_role: 'redux_store',
        community: 0,
      })
      graph.addNode('auth_state_helpers', {
        label: 'authStateHelpers',
        source_file: '/src/utils/authStateHelpers.ts',
        line_number: 9,
        node_kind: 'function',
        file_type: 'code',
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
      graph.addEdge('auth_state_helpers', 'select_auth_status', {
        relation: 'uses',
        confidence: 'EXTRACTED',
        source_file: '/src/utils/authStateHelpers.ts',
      })

      const result = retrieveContext(graph, {
        question: 'which redux selector reads auth state',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes.slice(0, 2).map((node) => node.label)).toEqual(
        expect.arrayContaining(['auth slice', 'selectAuthStatus']),
      )
      expect(result.matched_nodes.findIndex((node) => node.label === 'auth slice')).toBeLessThan(
        result.matched_nodes.findIndex((node) => node.label === 'authStateHelpers'),
      )
      expect(result.matched_nodes.findIndex((node) => node.label === 'selectAuthStatus')).toBeLessThan(
        result.matched_nodes.findIndex((node) => node.label === 'authStateHelpers'),
      )
    })

    it('does not boost redux metadata for non-framework-shaped questions', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('auth_status_helper', {
        label: 'AuthStatus',
        source_file: '/src/utils/auth-status.ts',
        line_number: 8,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('auth_status_selector', {
        label: 'AuthStatus',
        source_file: '/src/state/auth-status.ts',
        line_number: 12,
        node_kind: 'function',
        file_type: 'code',
        framework: 'redux-toolkit',
        framework_role: 'redux_selector',
        community: 0,
      })
      graph.addNode('status_formatter', {
        label: 'StatusFormatter',
        source_file: '/src/utils/status-formatter.ts',
        line_number: 18,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('status_labels', {
        label: 'statusLabels',
        source_file: '/src/utils/status-labels.ts',
        line_number: 4,
        node_kind: 'variable',
        file_type: 'code',
        community: 0,
      })

      graph.addEdge('status_formatter', 'auth_status_helper', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/utils/status-formatter.ts',
      })
      graph.addEdge('status_labels', 'auth_status_helper', {
        relation: 'uses',
        confidence: 'EXTRACTED',
        source_file: '/src/utils/status-labels.ts',
      })

      const result = retrieveContext(graph, {
        question: 'auth status',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'AuthStatus',
          source_file: '/src/utils/auth-status.ts',
        }),
      )
      expect(result.matched_nodes.findIndex((node) => node.source_file === '/src/utils/auth-status.ts')).toBeLessThan(
        result.matched_nodes.findIndex((node) => node.source_file === '/src/state/auth-status.ts'),
      )
    })

    it('does not treat a generic path query as framework-shaped', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('path_builder', {
        label: 'PathBuilder',
        source_file: '/src/utils/path-builder.ts',
        line_number: 3,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('settings_route', {
        label: '/settings/path',
        source_file: '/src/routes/settings.tsx',
        line_number: 12,
        node_kind: 'route',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_route',
        community: 0,
      })

      const result = retrieveContext(graph, {
        question: 'path',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes.slice(0, 2).map((node) => node.label)).toEqual(['PathBuilder', '/settings/path'])
      expect(result.matched_nodes.find((node) => node.label === 'PathBuilder')?.relevance_band).toBe('direct')
      expect(result.matched_nodes.find((node) => node.label === '/settings/path')?.relevance_band).toBe('direct')
    })

    it('does not treat file path component questions as react router route intent', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('login_component', {
        label: 'Login',
        source_file: '/src/auth/Login.tsx',
        line_number: 18,
        node_kind: 'component',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('login_route', {
        label: '/login',
        source_file: '/src/routes/login.tsx',
        line_number: 8,
        node_kind: 'route',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_route',
        community: 1,
      })
      graph.addNode('login_page', {
        label: 'LoginPage',
        source_file: '/src/routes/login-page.tsx',
        line_number: 20,
        node_kind: 'component',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_component',
        community: 1,
      })
      graph.addEdge('login_route', 'login_page', {
        relation: 'renders',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/login.tsx',
      })

      const result = retrieveContext(graph, {
        question: 'how does src/auth/Login.tsx component work',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'Login',
          source_file: '/src/auth/Login.tsx',
        }),
      )
      expect(result.matched_nodes.find((node) => node.label === '/login')?.framework_boost).toBe(0)
    })

    it('does not treat a generic router question as react router intent', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('settings_router', {
        label: 'SettingsRouter',
        source_file: '/src/server/settings-router.ts',
        line_number: 5,
        node_kind: 'class',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('settings_route', {
        label: '/settings',
        source_file: '/src/routes/settings.tsx',
        line_number: 12,
        node_kind: 'route',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_route',
        community: 1,
      })
      graph.addNode('settings_page', {
        label: 'SettingsPage',
        source_file: '/src/routes/settings-page.tsx',
        line_number: 20,
        node_kind: 'component',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_component',
        community: 1,
      })
      graph.addEdge('settings_route', 'settings_page', {
        relation: 'renders',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/settings.tsx',
      })

      const result = retrieveContext(graph, {
        question: 'which router handles settings',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'SettingsRouter',
          source_file: '/src/server/settings-router.ts',
        }),
      )
      expect(result.matched_nodes.find((node) => node.label === '/settings')?.framework_boost).toBe(0)
    })

    it('answers route rendering questions with extracted react router route semantics', () => {
      const routerFilePath = join(process.cwd(), 'tests', 'fixtures', 'react-router-imported-router.tsx')
      const moduleFilePath = join(process.cwd(), 'tests', 'fixtures', 'react-router-imported-module.tsx')
      const semanticExtraction = extractJs(routerFilePath)
      const semanticNodeIds = new Set(
        semanticExtraction.nodes.filter((node) => node.label !== 'react-router-imported-router.tsx').map((node) => node.id),
      )
      const semanticGraph = build(
        [
          {
            ...semanticExtraction,
            nodes: semanticExtraction.nodes.filter((node) => semanticNodeIds.has(node.id)),
            edges: semanticExtraction.edges.filter((edge) => semanticNodeIds.has(edge.source) && semanticNodeIds.has(edge.target)),
          },
        ],
        { directed: true },
      )

      const baselineGraph = new KnowledgeGraph({ directed: true })
      baselineGraph.addNode('router_variable', {
        label: 'router',
        source_file: routerFilePath,
        line_number: 1,
        node_kind: 'variable',
        file_type: 'code',
        community: 1,
      })
      baselineGraph.addNode('settings_page_component', {
        label: 'SettingsPage()',
        source_file: moduleFilePath,
        line_number: 2,
        node_kind: 'function',
        file_type: 'code',
        community: 1,
      })
      baselineGraph.addNode('settings_loader_baseline', {
        label: 'settingsLoader()',
        source_file: moduleFilePath,
        line_number: 12,
        node_kind: 'function',
        file_type: 'code',
        community: 1,
      })
      baselineGraph.addNode('settings_action_baseline', {
        label: 'settingsAction()',
        source_file: moduleFilePath,
        line_number: 16,
        node_kind: 'function',
        file_type: 'code',
        community: 1,
      })
      baselineGraph.addEdge('router_variable', 'settings_page_component', {
        relation: 'uses',
        confidence: 'EXTRACTED',
        source_file: routerFilePath,
      })
      baselineGraph.addEdge('router_variable', 'settings_loader_baseline', {
        relation: 'uses',
        confidence: 'EXTRACTED',
        source_file: routerFilePath,
      })
      baselineGraph.addEdge('router_variable', 'settings_action_baseline', {
        relation: 'uses',
        confidence: 'EXTRACTED',
        source_file: routerFilePath,
      })

      const semanticResult = retrieveContext(semanticGraph, {
        question: 'which route renders settings page',
        budget: 5000,
        fileType: 'code',
      })
      const baselineResult = retrieveContext(baselineGraph, {
        question: 'which route renders settings page',
        budget: 5000,
        fileType: 'code',
      })
      const semanticLowLevelMatches = semanticResult.matched_nodes.filter(
        (node) => node.node_kind !== 'route' && node.node_kind !== 'router',
      )
      const baselineLowLevelMatches = baselineResult.matched_nodes

      expect(semanticResult.matched_nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: '/settings',
            node_kind: 'route',
            relevance_band: 'direct',
          }),
        ]),
      )
      expect(baselineResult.matched_nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'router',
          }),
        ]),
      )
      expect(semanticResult.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: '/settings', to: 'SettingsPage()', relation: 'renders' }),
        ]),
      )
      expect(semanticLowLevelMatches).toHaveLength(3)
      expect(baselineLowLevelMatches.map((node) => node.label)).toEqual(
        expect.arrayContaining(['router', 'SettingsPage()', 'settingsLoader()', 'settingsAction()']),
      )
      expect(semanticLowLevelMatches.length).toBeLessThan(baselineLowLevelMatches.length)
    })

    it('keeps react router boosts when react-specific route evidence is present', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('settings_route', {
        label: '/settings',
        source_file: '/src/routes/settings.tsx',
        line_number: 12,
        node_kind: 'route',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_route',
        community: 0,
      })
      graph.addNode('settings_page', {
        label: 'SettingsPage',
        source_file: '/src/routes/settings-page.tsx',
        line_number: 20,
        node_kind: 'component',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_component',
        community: 0,
      })
      graph.addNode('settings_router_helper', {
        label: 'settingsRouterHelper',
        source_file: '/src/utils/settings-router-helper.ts',
        line_number: 3,
        node_kind: 'function',
        file_type: 'code',
        community: 1,
      })
      graph.addEdge('settings_route', 'settings_page', {
        relation: 'renders',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/settings.tsx',
      })

      const result = retrieveContext(graph, {
        question: 'which react router renders settings page',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: '/settings',
          node_kind: 'route',
        }),
      )
      expect(result.matched_nodes.find((node) => node.label === '/settings')?.framework_boost).toBeGreaterThan(0)
    })

    it('keeps framework boosts for framework-shaped react router path questions', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('settings_route', {
        label: '/settings/path',
        source_file: '/src/routes/settings.tsx',
        line_number: 12,
        node_kind: 'route',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_route',
        community: 0,
      })
      graph.addNode('settings_page', {
        label: 'SettingsPage',
        source_file: '/src/routes/settings-page.tsx',
        line_number: 20,
        node_kind: 'function',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_component',
        community: 0,
      })
      graph.addNode('path_builder', {
        label: 'PathBuilder',
        source_file: '/src/utils/path-builder.ts',
        line_number: 3,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addEdge('settings_route', 'settings_page', {
        relation: 'renders',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/settings.tsx',
      })

      const result = retrieveContext(graph, {
        question: 'which react router path renders settings page',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: '/settings/path',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
      expect(result.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: '/settings/path', to: 'SettingsPage', relation: 'renders' }),
        ]),
      )
      expect(result.matched_nodes.findIndex((node) => node.label === '/settings/path')).toBeLessThan(
        result.matched_nodes.findIndex((node) => node.label === 'PathBuilder'),
      )
    })

    it('keeps framework boosts for real route path questions', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('login_route', {
        label: '/login',
        source_file: '/src/routes/login.tsx',
        line_number: 8,
        node_kind: 'route',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_route',
        community: 0,
      })
      graph.addNode('login_page', {
        label: 'LoginPage',
        source_file: '/src/routes/login-page.tsx',
        line_number: 20,
        node_kind: 'component',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_component',
        community: 0,
      })
      graph.addNode('login_guide', {
        label: 'LoginGuide',
        source_file: '/docs/login.md',
        line_number: 3,
        node_kind: 'section',
        file_type: 'document',
        community: 0,
      })
      graph.addEdge('login_route', 'login_page', {
        relation: 'renders',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/login.tsx',
      })

      const result = retrieveContext(graph, {
        question: 'which react router route renders /login',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: '/login',
          node_kind: 'route',
          relevance_band: 'direct',
        }),
      )
      expect(result.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: '/login', to: 'LoginPage', relation: 'renders' }),
        ]),
      )
      expect(result.matched_nodes.find((node) => node.label === '/login')?.framework_boost).toBeGreaterThan(0)
    })

    it('keeps framework boosts for real route path questions with trailing punctuation', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('login_route', {
        label: '/login',
        source_file: '/src/routes/login.tsx',
        line_number: 8,
        node_kind: 'route',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_route',
        community: 0,
      })
      graph.addNode('login_page', {
        label: 'LoginPage',
        source_file: '/src/routes/login-page.tsx',
        line_number: 20,
        node_kind: 'component',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_component',
        community: 0,
      })
      graph.addEdge('login_route', 'login_page', {
        relation: 'renders',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/login.tsx',
      })

      const result = retrieveContext(graph, {
        question: 'what react page renders /login.',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: '/login',
          node_kind: 'route',
        }),
      )
      expect(result.matched_nodes.find((node) => node.label === '/login')?.framework_boost).toBeGreaterThan(0)
    })

    it('requires explicit route intent before boosting react router nodes', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('settings_route', {
        label: '/settings',
        source_file: '/src/routes/settings.tsx',
        line_number: 12,
        node_kind: 'route',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_route',
        community: 0,
      })
      graph.addNode('settings_component', {
        label: 'SettingsComponent',
        source_file: '/src/components/SettingsComponent.tsx',
        line_number: 20,
        node_kind: 'component',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_component',
        community: 0,
      })
      graph.addEdge('settings_route', 'settings_component', {
        relation: 'renders',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/settings.tsx',
      })

      const genericReactResult = retrieveContext(graph, {
        question: 'how does the react settings component work',
        budget: 5000,
        fileType: 'code',
      })
      const routeQuestionResult = retrieveContext(graph, {
        question: 'which react router path renders the settings component',
        budget: 5000,
        fileType: 'code',
      })

      expect(genericReactResult.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'SettingsComponent',
          source_file: '/src/components/SettingsComponent.tsx',
        }),
      )
      expect(genericReactResult.matched_nodes.find((node) => node.label === '/settings')?.framework_boost).toBe(0)
      expect(routeQuestionResult.matched_nodes.find((node) => node.label === '/settings')?.framework_boost).toBeGreaterThan(0)
    })

    it('keeps direct symbol matches above path-only matches after structural boosts', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('direct_symbol', {
        label: 'LoginController',
        source_file: '/src/controllers.ts',
        line_number: 1,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('path_only', {
        label: 'RenderPage',
        source_file: '/src/login/handler.ts',
        line_number: 2,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('guide_a', {
        label: 'LoginHandlerGuideA',
        source_file: '/docs/login-a.md',
        line_number: 3,
        node_kind: 'section',
        file_type: 'document',
        community: 0,
      })
      graph.addNode('guide_b', {
        label: 'LoginHandlerGuideB',
        source_file: '/docs/login-b.md',
        line_number: 4,
        node_kind: 'section',
        file_type: 'document',
        community: 0,
      })
      graph.addNode('guide_c', {
        label: 'LoginHandlerGuideC',
        source_file: '/docs/login-c.md',
        line_number: 5,
        node_kind: 'section',
        file_type: 'document',
        community: 0,
      })
      graph.addNode('guide_d', {
        label: 'LoginHandlerGuideD',
        source_file: '/docs/login-d.md',
        line_number: 6,
        node_kind: 'section',
        file_type: 'document',
        community: 1,
      })
      graph.addEdge('path_only', 'guide_a', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/login/handler.ts',
      })
      graph.addEdge('path_only', 'guide_d', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/login/handler.ts',
      })

      const result = retrieveContext(graph, { question: 'login', budget: 5000, fileType: 'code' })

      expect(result.matched_nodes.map((node) => node.label).slice(0, 2)).toEqual(['LoginController', 'RenderPage'])
      expect(result.matched_nodes.find((node) => node.label === 'LoginController')?.relevance_band).toBe('direct')
      expect(result.matched_nodes.find((node) => node.label === 'RenderPage')?.relevance_band).toBe('related')
    })

    it('keeps direct symbol matches above community-only matches after structural boosts', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('direct_symbol', {
        label: 'AuthGateway',
        source_file: '/src/auth.ts',
        line_number: 1,
        node_kind: 'class',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('community_only', {
        label: 'SessionCoordinator',
        source_file: '/src/session.ts',
        line_number: 2,
        node_kind: 'class',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('guide_a', {
        label: 'AuthGuideA',
        source_file: '/docs/auth-a.md',
        line_number: 3,
        node_kind: 'section',
        file_type: 'document',
        community: 0,
      })
      graph.addNode('guide_b', {
        label: 'AuthGuideB',
        source_file: '/docs/auth-b.md',
        line_number: 4,
        node_kind: 'section',
        file_type: 'document',
        community: 0,
      })
      graph.addNode('guide_c', {
        label: 'AuthGuideC',
        source_file: '/docs/auth-c.md',
        line_number: 5,
        node_kind: 'section',
        file_type: 'document',
        community: 0,
      })
      graph.addNode('guide_d', {
        label: 'AuthGuideD',
        source_file: '/docs/auth-d.md',
        line_number: 6,
        node_kind: 'section',
        file_type: 'document',
        community: 1,
      })
      graph.addEdge('community_only', 'guide_a', {
        relation: 'depends_on',
        confidence: 'EXTRACTED',
        source_file: '/src/session.ts',
      })
      graph.addEdge('community_only', 'guide_d', {
        relation: 'depends_on',
        confidence: 'EXTRACTED',
        source_file: '/src/session.ts',
      })
      graph.graph.community_labels = { 0: 'Auth' }

      const result = retrieveContext(graph, { question: 'auth', budget: 5000, fileType: 'code' })

      expect(result.matched_nodes.map((node) => node.label).slice(0, 2)).toEqual(['AuthGateway', 'SessionCoordinator'])
      expect(result.matched_nodes.find((node) => node.label === 'AuthGateway')?.relevance_band).toBe('direct')
      expect(result.matched_nodes.find((node) => node.label === 'SessionCoordinator')?.relevance_band).toBe('related')
    })

    it('includes neighbors of matched nodes', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'auth', budget: 5000 })

      const labels = result.matched_nodes.map((n) => n.label)
      expect(labels).toContain('authenticateUser')
      // SessionManager is a neighbor of authenticateUser
      expect(labels).toContain('SessionManager')
    })

    it('includes predecessors of matched nodes in directed graphs', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('caller', {
        label: 'CallerService',
        source_file: '/src/caller.ts',
        line_number: 1,
        node_kind: 'function',
        file_type: 'code',
      })
      graph.addNode('target', {
        label: 'TargetHandler',
        source_file: '/src/target.ts',
        line_number: 2,
        node_kind: 'function',
        file_type: 'code',
      })
      graph.addEdge('caller', 'target', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/caller.ts',
      })

      const result = retrieveContext(graph, { question: 'target', budget: 5000, retrievalLevel: 4 })
      const labels = result.matched_nodes.map((node) => node.label)

      expect(labels).toContain('TargetHandler')
      expect(labels).toContain('CallerService')
      expect(result.matched_nodes.find((node) => node.label === 'CallerService')?.relevance_band).toBe('related')
    })

    it('includes relationships between matched nodes', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'auth', budget: 5000, retrievalLevel: 4 })

      expect(result.relationships.length).toBeGreaterThan(0)
      const callsEdge = result.relationships.find((r) => r.from === 'authenticateUser' && r.to === 'SessionManager')
      expect(callsEdge).toBeDefined()
      expect(callsEdge?.relation).toBe('calls')
    })

    it('includes community context for matched nodes', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'auth', budget: 5000 })

      expect(result.community_context.length).toBeGreaterThan(0)
      const community0 = result.community_context.find((c) => c.id === 0)
      expect(community0).toBeDefined()
    })

    it('prefers calls and imports edges over generic second-hop expansion', () => {
      const graph = buildExpansionGraph()

      const result = retrieveContext(graph, { question: 'auth', budget: 5000 })
      const labels = result.matched_nodes.map((node) => node.label)

      expect(labels).toContain('SessionValidator')
      expect(labels).toContain('SessionRouter')
      expect(labels).toContain('SessionManager')
      if (labels.includes('BillingCache')) {
        expect(labels.indexOf('SessionValidator')).toBeLessThan(labels.indexOf('BillingCache'))
        expect(result.matched_nodes.find((node) => node.label === 'BillingCache')?.relevance_band).toBe('peripheral')
      }
      if (labels.includes('InvoiceLedger')) {
        expect(labels.indexOf('SessionRouter')).toBeLessThan(labels.indexOf('InvoiceLedger'))
      }
      if (labels.includes('TaxRules')) {
        expect(labels.indexOf('SessionManager')).toBeLessThan(labels.indexOf('TaxRules'))
      }
    })

    it('avoids promoting weak peripheral nodes when budget is tight', () => {
      const graph = buildExpansionGraph()

      const result = retrieveContext(graph, { question: 'auth flow', budget: 80 })
      const labels = result.matched_nodes.map((node) => node.label)

      expect(labels).toEqual(expect.arrayContaining(['authenticateUser']))
      expect(labels).not.toContain('BillingCache')
      expect(labels).not.toContain('InvoiceLedger')
      expect(labels).not.toContain('TaxRules')
    })

    it('keeps supporting code nodes alongside top framework matches in compact framework-shaped retrievals', () => {
      const graph = new KnowledgeGraph({ directed: true })

      graph.addNode('settings_route', {
        label: '/settings',
        source_file: '/src/routes/settings.tsx',
        line_number: 5,
        node_kind: 'route',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_route',
        community: 0,
      })
      graph.addNode('settings_loader', {
        label: 'settingsLoader',
        source_file: '/src/routes/settings.tsx',
        line_number: 10,
        node_kind: 'function',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_loader',
        community: 0,
      })
      graph.addNode('settings_action', {
        label: 'settingsAction',
        source_file: '/src/routes/settings.tsx',
        line_number: 16,
        node_kind: 'function',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_action',
        community: 0,
      })
      graph.addNode('settings_page', {
        label: 'SettingsPage',
        source_file: '/src/routes/settings.tsx',
        line_number: 24,
        node_kind: 'component',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_component',
        community: 0,
      })
      graph.addNode('settings_layout', {
        label: 'SettingsLayout',
        source_file: '/src/routes/settings.tsx',
        line_number: 30,
        node_kind: 'route',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_layout',
        community: 0,
      })
      graph.addNode('load_settings_data', {
        label: 'loadSettingsData',
        source_file: '/src/services/settings.ts',
        line_number: 8,
        node_kind: 'function',
        file_type: 'code',
        community: 1,
      })
      graph.addNode('save_settings_data', {
        label: 'saveSettingsData',
        source_file: '/src/services/settings.ts',
        line_number: 18,
        node_kind: 'function',
        file_type: 'code',
        community: 1,
      })

      graph.addEdge('settings_route', 'settings_loader', {
        relation: 'loads_route',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/settings.tsx',
      })
      graph.addEdge('settings_route', 'settings_action', {
        relation: 'submits_route',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/settings.tsx',
      })
      graph.addEdge('settings_route', 'settings_page', {
        relation: 'renders',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/settings.tsx',
      })
      graph.addEdge('settings_layout', 'settings_route', {
        relation: 'contains',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/settings.tsx',
      })
      graph.addEdge('settings_loader', 'load_settings_data', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/settings.tsx',
      })
      graph.addEdge('settings_action', 'save_settings_data', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/settings.tsx',
      })

      const result = retrieveContext(graph, {
        question: 'which react router route loads settings data',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes.slice(0, 5).map((node) => node.label)).toEqual(expect.arrayContaining(['/settings']))
      expect(result.matched_nodes.slice(0, 5).map((node) => node.label)).toEqual(
        expect.arrayContaining(['loadSettingsData']),
      )
    })

    it('respects community filter', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'database', budget: 5000, community: 1 })

      for (const node of result.matched_nodes) {
        expect(node.community).toBe(1)
      }
    })

    it('respects file type filter', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'auth', budget: 5000, fileType: 'code' })

      for (const node of result.matched_nodes) {
        expect(node.file_type).toBe('code')
      }
    })

    it('respects token budget', () => {
      const graph = buildTestGraph()
      // Very small budget should limit results
      const smallResult = retrieveContext(graph, { question: 'auth', budget: 10 })
      const largeResult = retrieveContext(graph, { question: 'auth', budget: 50000 })

      expect(smallResult.matched_nodes.length).toBeLessThanOrEqual(largeResult.matched_nodes.length)
      // First node always included even if it exceeds budget
      expect(smallResult.token_count).toBeLessThan(largeResult.token_count)
    })

    it('returns token_count reflecting actual usage', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'auth', budget: 5000 })
      const exactTokenCount = result.matched_nodes.reduce((total, node) => {
        const nodeText = `${node.label} ${node.source_file}:${node.line_number} ${node.snippet ?? ''}`
        return total + estimateQueryTokens(nodeText)
      }, 0)

      expect(result.token_count).toBeGreaterThan(0)
      expect(result.token_count).toBeLessThanOrEqual(5000)
      expect(result.token_count).toBe(exactTokenCount)
    })

    it('attaches explain context-pack metadata and coverage when the budget truncates support evidence', () => {
      const graph = buildExpansionGraph()
      const result = retrieveContext(graph, { question: 'auth', budget: 1 })

      expect(result.task_contract).toEqual(expect.objectContaining({
        task_kind: 'explain',
        required_evidence: ['primary', 'supporting', 'structural'],
      }))
      expect(result.matched_nodes[0]?.evidence_class).toBe('primary')
      expect(result.claims?.[0]).toEqual(expect.objectContaining({
        evidence_class: 'primary',
        node_labels: expect.arrayContaining([result.matched_nodes[0]?.label]),
      }))
      expect(result.coverage).toEqual(expect.objectContaining({
        missing_required: expect.arrayContaining(['supporting', 'structural']),
      }))
      expect(result.expandable).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'nodes',
          evidence_class: 'supporting',
          preview: expect.arrayContaining([
            expect.objectContaining({
              node_id: 'session_mgr',
              label: 'SessionManager',
              source_file: '/src/session.ts',
              line_range: {
                start_line: 5,
                end_line: 8,
              },
            }),
          ]),
          follow_up: expect.objectContaining({
            kind: 'context_pack',
            task_kind: 'explain',
            evidence_class: 'supporting',
            focus_files: expect.arrayContaining(['/src/session-router.ts', '/src/session-validator.ts', '/src/session.ts']),
            focus_ranges: expect.arrayContaining([
              {
                source_file: '/src/session.ts',
                start_line: 5,
                end_line: 8,
              },
            ]),
          }),
        }),
      ]))
    })

    it('reuses cached graph signals for repeated retrieve calls on the same graph', () => {
      const graph = buildTestGraph()
      const godNodesSpy = vi.spyOn(analyze, 'godNodes')
      const workspaceBridgesSpy = vi.spyOn(analyze, 'workspaceBridges')

      retrieveContext(graph, { question: 'auth', budget: 5000 })
      retrieveContext(graph, { question: 'session', budget: 5000 })

      expect(godNodesSpy).toHaveBeenCalledTimes(1)
      expect(workspaceBridgesSpy).toHaveBeenCalledTimes(1)
    })

    it('omits fallback expandable ranges for malformed line numbers', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('auth_service', {
        label: 'AuthService',
        file_type: 'code',
        source_file: '/src/auth.ts',
        source_location: 'L1',
        community: 0,
      })
      graph.addNode('session_mgr', {
        label: 'SessionManager',
        file_type: 'code',
        source_file: '/src/session.ts',
        line_number: Infinity,
        community: 0,
      })
      graph.addEdge('auth_service', 'session_mgr', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/auth.ts',
      })

      const result = retrieveContext(graph, { question: 'auth', budget: 1 })
      const preview = (result.expandable ?? []).flatMap((entry) => entry.preview).find((entry) => entry.node_id === 'session_mgr')

      expect(preview).toBeDefined()
      expect(preview).not.toHaveProperty('line_range')
    })

    it('renders retrieve packs task-aware without changing selected labels or compact compatibility', () => {
      const baseResult = {
        question: 'auth callback flow',
        token_count: 999,
        matched_nodes: [
          {
            node_id: 'auth_service',
            label: 'AuthService.login',
            source_file: '/src/auth/service.ts',
            line_number: 18,
            node_kind: 'method',
            file_type: 'code',
            snippet: [
              'export class AuthService {',
              '  async login(input: LoginInput) {',
              '    return this.sessionStore.create(input.userId)',
              '  }',
              '}',
            ].join('\n'),
            match_score: 10,
            relevance_band: 'direct' as const,
            community: 0,
            community_label: 'Auth',
            evidence_class: 'primary' as const,
          },
          {
            node_id: 'auth_controller',
            label: 'AuthController.callback',
            source_file: '/src/auth/controller.ts',
            line_number: 10,
            node_kind: 'method',
            file_type: 'code',
            snippet: [
              'export class AuthController {',
              '  async callback(input: LoginInput) {',
              '    return this.authService.login(input)',
              '  }',
              '}',
            ].join('\n'),
            match_score: 8,
            relevance_band: 'related' as const,
            community: 0,
            community_label: 'Auth',
            evidence_class: 'structural' as const,
          },
        ],
        relationships: [
          {
            from_id: 'auth_controller',
            from: 'AuthController.callback',
            to_id: 'auth_service',
            to: 'AuthService.login',
            relation: 'calls',
          },
        ],
        community_context: [{ id: 0, label: 'Auth', node_count: 2 }],
        graph_signals: { god_nodes: [], bridge_nodes: ['AuthController.callback'] },
      }

      const explainResult = {
        ...baseResult,
        task_contract: classifyTaskContract('explain', { budget: 256, prompt: 'Explain the auth callback flow' }),
      }
      const reviewResult = {
        ...baseResult,
        task_contract: classifyTaskContract('review', { budget: 256, prompt: 'Review the auth callback changes' }),
      }

      const explainPack = contextPackFromRetrieveResult(explainResult)
      const reviewPack = contextPackFromRetrieveResult(reviewResult)
      const compactReview = compactRetrieveResult(reviewResult)

      expect(explainPack.nodes.map((node) => node.label)).toEqual(reviewPack.nodes.map((node) => node.label))
      expect(explainPack.nodes.find((node) => node.node_id === 'auth_controller')?.representation_type).toBe('detail')
      expect(explainPack.nodes.find((node) => node.node_id === 'auth_controller')?.representation_reason).toBe('explain detail preserved')
      expect(reviewPack.nodes.find((node) => node.node_id === 'auth_controller')?.representation_type).toBe('signature')
      expect(reviewPack.token_count).toBeLessThan(explainPack.token_count)
      expect(compactReview.shared_file_type).toBe('code')
      expect(compactReview.matched_nodes[0]).toEqual(expect.objectContaining({
        label: reviewResult.matched_nodes[0]?.label,
        representation_type: 'signature',
      }))
      expect(compactReview.matched_nodes[0]).not.toHaveProperty('community_label')
      expect(compactReview.matched_nodes[0]).not.toHaveProperty('evidence_class')
      expect(compactReview.matched_nodes[0]).not.toHaveProperty('file_type')
    })

    it('compacts repeated node metadata for default payloads', () => {
      const graph = buildTestGraph()
      graph.graph.community_labels = { 0: 'Auth', 1: 'Data', 2: 'Observability' }

      const rawResult = retrieveContext(graph, { question: 'auth', budget: 5000, fileType: 'code' })
      const compactResult = compactRetrieveResult(rawResult)

      expect(JSON.stringify(compactResult).length).toBeLessThan(JSON.stringify(rawResult).length)
      expect(compactResult.shared_file_type).toBe('code')
      expect(compactResult.matched_nodes[0]).not.toHaveProperty('file_type')
      expect(compactResult.matched_nodes[0]).not.toHaveProperty('community_label')
    })

    it('keeps raw framework retrieval budget-driven and caps only compact serialization', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('dashboard_route', {
        label: '/dashboard',
        source_file: '/src/routes/dashboard.tsx',
        line_number: 5,
        node_kind: 'route',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_route',
        community: 0,
      })
      graph.addNode('dashboard_layout', {
        label: 'DashboardLayout',
        source_file: '/src/routes/dashboard-layout.tsx',
        line_number: 9,
        node_kind: 'component',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_layout',
        community: 0,
      })
      graph.addNode('dashboard_page', {
        label: 'DashboardPage',
        source_file: '/src/routes/dashboard-page.tsx',
        line_number: 12,
        node_kind: 'component',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_component',
        community: 0,
      })
      graph.addNode('dashboard_loader', {
        label: 'dashboardLoader',
        source_file: '/src/routes/dashboard-loader.ts',
        line_number: 18,
        node_kind: 'function',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_loader',
        community: 0,
      })
      graph.addNode('dashboard_action', {
        label: 'dashboardAction',
        source_file: '/src/routes/dashboard-action.ts',
        line_number: 24,
        node_kind: 'function',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_action',
        community: 0,
      })
      graph.addNode('dashboard_router', {
        label: 'dashboardRouter',
        source_file: '/src/routes/router.tsx',
        line_number: 30,
        node_kind: 'router',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router',
        community: 0,
      })
      graph.addNode('dashboard_helper', {
        label: 'dashboardHelper',
        source_file: '/src/routes/dashboard-helper.ts',
        line_number: 36,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addEdge('dashboard_route', 'dashboard_layout', {
        relation: 'renders',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/dashboard.tsx',
      })
      graph.addEdge('dashboard_route', 'dashboard_page', {
        relation: 'renders',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/dashboard.tsx',
      })
      graph.addEdge('dashboard_route', 'dashboard_loader', {
        relation: 'loads_route',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/dashboard.tsx',
      })
      graph.addEdge('dashboard_route', 'dashboard_action', {
        relation: 'submits_route',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/dashboard.tsx',
      })
      graph.addEdge('dashboard_router', 'dashboard_route', {
        relation: 'contains',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/router.tsx',
      })
      graph.addEdge('dashboard_helper', 'dashboard_loader', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/dashboard-helper.ts',
      })

      const rawResult = retrieveContext(graph, {
        question: 'which react router route renders dashboard page',
        budget: 5000,
        fileType: 'code',
      })
      const compactResult = compactRetrieveResult(rawResult)

      expect(rawResult.matched_nodes.length).toBeGreaterThan(5)
      expect(rawResult.matched_nodes.map((node) => node.label)).toEqual(expect.arrayContaining(['dashboardHelper']))
      expect(compactResult.matched_nodes).toHaveLength(5)
      expect(compactResult.matched_nodes.length).toBeLessThan(rawResult.matched_nodes.length)
    })

    it('recomputes compact token_count after truncating matched nodes', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('dashboard_route', {
        label: '/dashboard',
        source_file: '/src/routes/dashboard.tsx',
        line_number: 5,
        node_kind: 'route',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_route',
        community: 0,
      })
      graph.addNode('dashboard_layout', {
        label: 'DashboardLayout',
        source_file: '/src/routes/dashboard-layout.tsx',
        line_number: 9,
        node_kind: 'component',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_layout',
        community: 0,
      })
      graph.addNode('dashboard_page', {
        label: 'DashboardPage',
        source_file: '/src/routes/dashboard-page.tsx',
        line_number: 12,
        node_kind: 'component',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_component',
        community: 0,
      })
      graph.addNode('dashboard_loader', {
        label: 'dashboardLoader',
        source_file: '/src/routes/dashboard-loader.ts',
        line_number: 18,
        node_kind: 'function',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_loader',
        community: 0,
      })
      graph.addNode('dashboard_action', {
        label: 'dashboardAction',
        source_file: '/src/routes/dashboard-action.ts',
        line_number: 24,
        node_kind: 'function',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router_action',
        community: 0,
      })
      graph.addNode('dashboard_router', {
        label: 'dashboardRouter',
        source_file: '/src/routes/router.tsx',
        line_number: 30,
        node_kind: 'router',
        file_type: 'code',
        framework: 'react-router',
        framework_role: 'react_router',
        community: 0,
      })
      graph.addNode('dashboard_helper', {
        label: 'dashboardHelper',
        source_file: '/src/routes/dashboard-helper.ts',
        line_number: 36,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addEdge('dashboard_route', 'dashboard_layout', {
        relation: 'renders',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/dashboard.tsx',
      })
      graph.addEdge('dashboard_route', 'dashboard_page', {
        relation: 'renders',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/dashboard.tsx',
      })
      graph.addEdge('dashboard_route', 'dashboard_loader', {
        relation: 'loads_route',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/dashboard.tsx',
      })
      graph.addEdge('dashboard_route', 'dashboard_action', {
        relation: 'submits_route',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/dashboard.tsx',
      })
      graph.addEdge('dashboard_router', 'dashboard_route', {
        relation: 'contains',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/router.tsx',
      })
      graph.addEdge('dashboard_helper', 'dashboard_loader', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/src/routes/dashboard-helper.ts',
      })

      const rawResult = retrieveContext(graph, {
        question: 'which react router route renders dashboard page',
        budget: 5000,
        fileType: 'code',
      })
      const compactResult = compactRetrieveResult(rawResult)
      const compactTokenCount = compactResult.matched_nodes.reduce((total, node) => {
        const nodeText = `${node.label} ${node.source_file}:${node.line_number} ${node.snippet ?? ''}`
        return total + estimateQueryTokens(nodeText)
      }, 0)

      expect(compactResult.matched_nodes.length).toBeLessThan(rawResult.matched_nodes.length)
      expect(compactResult.token_count).toBe(compactTokenCount)
      expect(compactResult.token_count).toBeLessThan(rawResult.token_count)
    })

    it('drops relationships for truncated same-label nodes during compact serialization', () => {
      const compactResult = compactRetrieveResult({
        question: 'which react router route renders dashboard page',
        token_count: 999,
        matched_nodes: [
          {
            node_id: 'dashboard_route',
            label: '/dashboard',
            source_file: '/src/routes/dashboard.tsx',
            line_number: 5,
            node_kind: 'route',
            framework_boost: 4,
            file_type: 'code',
            snippet: null,
            match_score: 15,
            relevance_band: 'direct',
            community: 0,
            community_label: 'Routes',
          },
          {
            node_id: 'dashboard_layout',
            label: 'DashboardLayout',
            source_file: '/src/routes/dashboard-layout.tsx',
            line_number: 9,
            node_kind: 'component',
            framework_boost: 3,
            file_type: 'code',
            snippet: null,
            match_score: 14,
            relevance_band: 'direct',
            community: 0,
            community_label: 'Routes',
          },
          {
            node_id: 'dashboard_page_primary',
            label: 'DashboardPage',
            source_file: '/src/routes/dashboard-page.tsx',
            line_number: 12,
            node_kind: 'component',
            framework_boost: 3,
            file_type: 'code',
            snippet: null,
            match_score: 13,
            relevance_band: 'direct',
            community: 0,
            community_label: 'Routes',
          },
          {
            node_id: 'dashboard_loader',
            label: 'dashboardLoader',
            source_file: '/src/routes/dashboard-loader.ts',
            line_number: 18,
            node_kind: 'function',
            framework_boost: 2,
            file_type: 'code',
            snippet: null,
            match_score: 12,
            relevance_band: 'related',
            community: 0,
            community_label: 'Routes',
          },
          {
            node_id: 'dashboard_action',
            label: 'dashboardAction',
            source_file: '/src/routes/dashboard-action.ts',
            line_number: 24,
            node_kind: 'function',
            framework_boost: 2,
            file_type: 'code',
            snippet: null,
            match_score: 11,
            relevance_band: 'related',
            community: 0,
            community_label: 'Routes',
          },
          {
            node_id: 'dashboard_page_secondary',
            label: 'DashboardPage',
            source_file: '/src/legacy/dashboard-page.ts',
            line_number: 30,
            node_kind: 'function',
            framework_boost: 0,
            file_type: 'code',
            snippet: null,
            match_score: 2,
            relevance_band: 'related',
            community: 1,
            community_label: 'Legacy',
          },
        ],
        relationships: [
          {
            from: '/dashboard',
            to: 'DashboardPage',
            relation: 'renders',
            from_id: 'dashboard_route',
            to_id: 'dashboard_page_primary',
          },
          {
            from: '/dashboard',
            to: 'DashboardPage',
            relation: 'uses',
            from_id: 'dashboard_route',
            to_id: 'dashboard_page_secondary',
          },
        ],
        community_context: [
          { id: 0, label: 'Routes', node_count: 5 },
          { id: 1, label: 'Legacy', node_count: 1 },
        ],
        graph_signals: {
          god_nodes: ['/dashboard'],
          bridge_nodes: ['DashboardPage'],
        },
      } as unknown as Parameters<typeof compactRetrieveResult>[0])

      expect(compactResult.matched_nodes).toHaveLength(5)
      expect(compactResult.matched_nodes.filter((node) => node.label === 'DashboardPage')).toHaveLength(1)
      expect(compactResult.relationships.map(({ from, to, relation }) => ({ from, to, relation }))).toEqual([
        {
          from: '/dashboard',
          to: 'DashboardPage',
          relation: 'renders',
        },
      ])
    })

    it('omits empty node_kind during compact retrieve serialization', () => {
      const compactResult = compactRetrieveResult({
        question: 'where is auth defined',
        token_count: 10,
        matched_nodes: [
          {
            node_id: 'auth_service',
            label: 'AuthService',
            source_file: 'src/auth.ts',
            line_number: 1,
            node_kind: '',
            file_type: 'code',
            snippet: null,
            match_score: 3,
            relevance_band: 'direct',
            community: 0,
            community_label: 'Auth',
          },
        ],
        relationships: [],
        community_context: [{ id: 0, label: 'Auth', node_count: 1 }],
        graph_signals: { god_nodes: [], bridge_nodes: [] },
      })

      expect(compactResult.matched_nodes[0]).not.toHaveProperty('node_kind')
    })

    it('strips evidence_class from compact stdio retrieve payloads', () => {
      const graph = buildExpansionGraph()
      const rawResult = retrieveContext(graph, { question: 'auth', budget: 1 })

      expect(rawResult.matched_nodes[0]?.evidence_class).toBe('primary')

      const compactResult = compactRetrieveResultForStdio(rawResult)

      expect(compactResult.matched_nodes[0]).toEqual(expect.objectContaining({
        label: rawResult.matched_nodes[0]?.label,
      }))
      expect(compactResult.matched_nodes[0]).not.toHaveProperty('evidence_class')
      expect(compactResult.claims).toEqual(rawResult.claims)
      expect(compactResult.coverage).toEqual(rawResult.coverage)
    })

    it('assigns higher match_score to direct matches than neighbors', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'auth', budget: 5000 })

      const authNode = result.matched_nodes.find((n) => n.label === 'authenticateUser')
      const otherNodes = result.matched_nodes.filter((n) => n.label !== 'authenticateUser')

      expect(authNode).toBeDefined()
      expect(authNode!.match_score).toBeGreaterThan(0)
      for (const other of otherNodes) {
        expect(authNode!.match_score).toBeGreaterThanOrEqual(other.match_score)
      }
    })

    it('returns matches even when a query token appears in every node', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('auth_service', { label: 'AuthService', file_type: 'code', source_file: 'src/auth.ts', source_location: 'L1' })
      const result = retrieveContext(graph, { question: 'auth', budget: 3000 })

      expect(result.matched_nodes.length).toBeGreaterThan(0)
      expect(result.matched_nodes[0]!.match_score).toBeGreaterThan(0)
    })

    it('omits empty node_kind from retrieve payload nodes', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('auth_service', { label: 'AuthService', file_type: 'code', source_file: 'src/auth.ts', source_location: 'L1' })

      const result = retrieveContext(graph, { question: 'auth', budget: 3000 })

      expect(result.matched_nodes[0]).not.toHaveProperty('node_kind')
    })

    it('returns snippet as null when source file does not exist', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'auth', budget: 5000 })

      for (const node of result.matched_nodes) {
        expect(node.snippet).toBeNull()
      }
    })

    it('prefers stored snippets over file-window fallback', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('logout', {
        label: 'logout()',
        file_type: 'code',
        source_file: '/missing/auth.ts',
        source_location: 'L7-L9',
        snippet: ['function logout() {', '  return false', '}'].join('\n'),
      })

      const result = retrieveContext(graph, { question: 'logout', budget: 3000 })

      expect(result.matched_nodes[0]?.line_number).toBe(7)
      expect(result.matched_nodes[0]?.snippet).toBe(['function logout() {', '  return false', '}'].join('\n'))
    })

    it('reuses file contents when multiple matched nodes come from the same source file', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'graphify-retrieve-cache-'))
      try {
        const filePath = join(tempDir, 'auth.ts')
        writeFileSync(
          filePath,
          [
            'export function AuthService() {',
            '  return true',
            '}',
            '',
            'export function AuthController() {',
            '  return AuthService()',
            '}',
          ].join('\n'),
          'utf8',
        )

        const graph = new KnowledgeGraph()
        graph.addNode('auth_service', {
          label: 'AuthService',
          file_type: 'code',
          source_file: filePath,
          source_location: 'L1',
        })
        graph.addNode('auth_controller', {
          label: 'AuthController',
          file_type: 'code',
          source_file: filePath,
          source_location: 'L5',
        })

        const readFileSync = vi.fn((path: nodeFs.PathOrFileDescriptor, encoding?: BufferEncoding | null) =>
          nodeFs.readFileSync(path, encoding),
        )
        vi.doMock('node:fs', async () => {
          const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
          return {
            ...actual,
            readFileSync,
          }
        })
        const { retrieveContext: retrieveContextWithMock } = await import('../../src/runtime/retrieve.js')
        const result = retrieveContextWithMock(graph, { question: 'auth', budget: 3000 })

        expect(result.matched_nodes).toHaveLength(2)
        expect(result.matched_nodes.every((node) => node.snippet !== null)).toBe(true)
        expect(readFileSync.mock.calls.filter(([path]) => path === filePath)).toHaveLength(1)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it('collects default-path relationships without scanning every graph edge', () => {
      const graph = buildTestGraph()
      const edgeEntriesSpy = vi.spyOn(graph, 'edgeEntries')

      const result = retrieveContext(graph, { question: 'auth', budget: 5000, fileType: 'code' })

      expect(edgeEntriesSpy).not.toHaveBeenCalled()
      expect(result.relationships).toEqual(expect.arrayContaining([
        {
          from_id: 'auth_user',
          from: 'authenticateUser',
          to_id: 'session_mgr',
          to: 'SessionManager',
          relation: 'calls',
        },
        {
          from_id: 'auth_user',
          from: 'authenticateUser',
          to_id: 'user_model',
          to: 'UserModel',
          relation: 'uses',
        },
        {
          from_id: 'auth_user',
          from: 'authenticateUser',
          to_id: 'logger',
          to: 'Logger',
          relation: 'calls',
        },
      ]))
    })

    it('derives line_number and snippet from source_location when line_number is absent', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'graphify-retrieve-'))
      try {
        const filePath = join(tempDir, 'auth.ts')
        writeFileSync(
          filePath,
          [
            'const session = 1',
            'export function AuthService() {',
            '  return session',
            '}',
          ].join('\n'),
          'utf8',
        )

        const graph = new KnowledgeGraph()
        graph.addNode('auth_service', {
          label: 'AuthService',
          file_type: 'code',
          source_file: filePath,
          source_location: 'L2',
        })

        const result = retrieveContext(graph, { question: 'auth', budget: 3000 })

        expect(result.matched_nodes[0]?.line_number).toBe(2)
        expect(result.matched_nodes[0]?.snippet).toContain('export function AuthService() {')
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it('does not treat exclusion terms as substrings inside production identifiers', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('contest_service', {
        label: 'ContestService',
        file_type: 'code',
        source_file: '/src/contest/service.ts',
        line_number: 12,
        node_kind: 'class',
      })
      graph.addNode('contest_service_test', {
        label: 'ContestService.spec',
        file_type: 'code',
        source_file: '/src/__tests__/contest.service.spec.ts',
        line_number: 4,
        node_kind: 'function',
      })

      const result = retrieveContext(graph, {
        question: 'Explain ContestService runtime path. Exclude tests.',
        budget: 3000,
      })

      expect(result.matched_nodes).toHaveLength(1)
      expect(result.matched_nodes[0]?.label).toBe('ContestService')
      expect(result.matched_nodes[0]?.source_file).toBe('/src/contest/service.ts')
    })

    it('does not suppress absolute tmp sources when graph.root_path is unset', () => {
      const graph = new KnowledgeGraph()
      const sourceFile = process.platform === 'win32' ? 'C:/tmp/auth.ts' : '/tmp/auth.ts'
      graph.addNode('auth_service', {
        label: 'AuthService',
        file_type: 'code',
        source_file: sourceFile,
        source_location: 'L2',
      })

      const result = retrieveContext(graph, { question: 'AuthService', budget: 3000 })

      expect(result.matched_nodes).toHaveLength(1)
      expect(result.matched_nodes[0]?.label).toBe('AuthService')
      expect(result.matched_nodes[0]?.line_number).toBe(2)
    })

    it('does not suppress windows-style absolute tmp sources on non-windows hosts', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('auth_service', {
        label: 'AuthService',
        file_type: 'code',
        source_file: 'C:/tmp/auth.ts',
        source_location: 'L2',
      })

      const result = retrieveContext(graph, { question: 'AuthService', budget: 3000 })

      expect(result.matched_nodes).toHaveLength(1)
      expect(result.matched_nodes[0]?.label).toBe('AuthService')
      expect(result.matched_nodes[0]?.line_number).toBe(2)
    })

    it('relativizes in-root source files while preserving outside-root matches', () => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.graph.root_path = '/workspace/app'
      graph.addNode('auth_service', {
        label: 'AuthService',
        source_file: '/workspace/app/src/auth/service.ts',
        line_number: 12,
        node_kind: 'function',
        file_type: 'code',
        community: 0,
      })
      graph.addNode('shared_auth', {
        label: 'SharedAuthPolicy',
        source_file: '/opt/shared/auth/policy.ts',
        line_number: 4,
        node_kind: 'function',
        file_type: 'code',
        community: 1,
      })
      graph.addEdge('auth_service', 'shared_auth', {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: '/workspace/app/src/auth/service.ts',
      })

      const result = retrieveContext(graph, { question: 'auth', budget: 5000, fileType: 'code' })

      expect(result.matched_nodes.find((node) => node.label === 'AuthService')?.source_file).toBe('src/auth/service.ts')
      expect(result.matched_nodes.find((node) => node.label === 'SharedAuthPolicy')?.source_file).toBe('/opt/shared/auth/policy.ts')
    })

    it('does not special-case repository source paths during retrieve serialization', () => {
      const graph = new KnowledgeGraph()
      graph.graph.root_path = '/workspace/app'
      graph.addNode('report_repository_save', {
        label: 'save()',
        source_file: '/workspace/app/src/repositories/report.repository.ts',
        line_number: 14,
        node_kind: 'method',
        file_type: 'code',
        framework: 'repository',
        framework_role: 'repository_writer',
        framework_metadata: {
          storage_operation: 'save',
        },
        community: 0,
      })

      const result = retrieveContext(graph, {
        question: 'save repository method',
        budget: 3000,
        fileType: 'code',
      })

      expect(result.matched_nodes).toHaveLength(1)
      expect(result.matched_nodes[0]?.source_file).toBe('src/repositories/report.repository.ts')
    })

    it('adds repository storage boosts only for storage-oriented prompts', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('report_repository_save', {
        label: 'save()',
        source_file: '/src/repositories/report.repository.ts',
        line_number: 14,
        node_kind: 'method',
        file_type: 'code',
        framework: 'repository',
        framework_role: 'repository_writer',
        framework_metadata: {
          storage_operation: 'save',
        },
        community: 0,
      })

      const result = retrieveContext(graph, {
        question: 'which database method saves reports',
        budget: 3000,
        fileType: 'code',
      })
      const unrelated = retrieveContext(graph, {
        question: 'how does the report footer work',
        budget: 3000,
        fileType: 'code',
      })

      expect(result.matched_nodes).toHaveLength(1)
      expect(result.matched_nodes[0]?.framework_boost ?? 0).toBeGreaterThan(0)
      expect(unrelated.matched_nodes).toHaveLength(1)
      expect(unrelated.matched_nodes[0]?.framework_boost ?? 0).toBe(0)
    })

    it('keeps repository method introspection prompts neutral', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('report_repository_save', {
        label: 'save()',
        source_file: '/src/repositories/report.repository.ts',
        line_number: 14,
        node_kind: 'method',
        file_type: 'code',
        framework: 'repository',
        framework_role: 'repository_writer',
        framework_metadata: {
          storage_operation: 'save',
        },
        community: 0,
      })
      graph.addNode('report_repository_find', {
        label: 'findAll()',
        source_file: '/src/repositories/report.repository.ts',
        line_number: 20,
        node_kind: 'method',
        file_type: 'code',
        framework: 'repository',
        framework_role: 'repository_reader',
        framework_metadata: {
          storage_operation: 'findAll',
        },
        community: 0,
      })

      const result = retrieveContext(graph, {
        question: 'list all repository class methods',
        budget: 3000,
        fileType: 'code',
      })

      expect(result.matched_nodes).toHaveLength(2)
      expect(result.matched_nodes.every((node) => (node.framework_boost ?? 0) === 0)).toBe(true)
    })

    it('does not reduce Prisma client or model-access boosts for mixed model persistence prompts', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('prisma_client', {
        label: 'PrismaClient',
        source_file: '/src/db/client.ts',
        line_number: 2,
        node_kind: 'variable',
        file_type: 'code',
        framework: 'prisma',
        framework_role: 'prisma_client',
        community: 0,
      })
      graph.addNode('prisma_model_access', {
        label: 'UserModelAccess',
        source_file: '/src/db/user.ts',
        line_number: 8,
        node_kind: 'property',
        file_type: 'code',
        framework: 'prisma',
        framework_role: 'prisma_model_access',
        community: 0,
      })

      const modelOnly = retrieveContext(graph, {
        question: 'which Prisma models exist',
        budget: 3000,
        fileType: 'code',
      })
      const mixed = retrieveContext(graph, {
        question: 'which Prisma models get persisted',
        budget: 3000,
        fileType: 'code',
      })

      const modelOnlyClient = modelOnly.matched_nodes.find((node) => node.label === 'PrismaClient')
      const mixedClient = mixed.matched_nodes.find((node) => node.label === 'PrismaClient')
      const modelOnlyAccess = modelOnly.matched_nodes.find((node) => node.label === 'UserModelAccess')
      const mixedAccess = mixed.matched_nodes.find((node) => node.label === 'UserModelAccess')

      expect(modelOnlyClient).toBeDefined()
      expect(mixedClient).toBeDefined()
      expect(modelOnlyAccess).toBeDefined()
      expect(mixedAccess).toBeDefined()
      expect(mixedClient?.framework_boost ?? 0).toBeGreaterThanOrEqual(modelOnlyClient?.framework_boost ?? 0)
      expect(mixedAccess?.framework_boost ?? 0).toBeGreaterThanOrEqual(modelOnlyAccess?.framework_boost ?? 0)
    })

    it('matches storage operations on whole tokens only', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('report_repository_save', {
        label: 'save()',
        source_file: '/src/repositories/report.repository.ts',
        line_number: 14,
        node_kind: 'method',
        file_type: 'code',
        framework: 'repository',
        framework_role: 'repository_writer',
        framework_metadata: {
          storage_operation: 'save',
        },
        community: 0,
      })
      graph.addNode('report_repository_update', {
        label: 'update()',
        source_file: '/src/repositories/report.repository.ts',
        line_number: 20,
        node_kind: 'method',
        file_type: 'code',
        framework: 'repository',
        framework_role: 'repository_writer',
        framework_metadata: {
          storage_operation: 'update',
        },
        community: 0,
      })

      const result = retrieveContext(graph, {
        question: 'which storage savefile repository methods exist',
        budget: 3000,
        fileType: 'code',
      })

      const saveNode = result.matched_nodes.find((node) => node.label === 'save()')
      const updateNode = result.matched_nodes.find((node) => node.label === 'update()')

      expect(saveNode).toBeDefined()
      expect(updateNode).toBeDefined()
      expect(saveNode?.framework_boost ?? 0).toBe(updateNode?.framework_boost ?? 0)
    })

    it('preserves question in result', () => {
      const graph = buildTestGraph()
      const result = retrieveContext(graph, { question: 'how does auth work?', budget: 5000 })

      expect(result.question).toBe('how does auth work?')
    })

    it('labels matched nodes with direct, related, and peripheral relevance bands', () => {
      const graph = buildTestGraph()
      graph.addNode('billing_store', {
        label: 'BillingStore',
        source_file: '/src/billing.ts',
        line_number: 2,
        node_kind: 'class',
        file_type: 'code',
      })
      graph.addEdge('session_mgr', 'billing_store', { relation: 'depends_on', confidence: 'EXTRACTED', source_file: '/src/session.ts' })
      const result = retrieveContext(graph, { question: 'auth', budget: 5000, retrievalLevel: 4 })

      expect(result.matched_nodes.find((node) => node.label === 'authenticateUser')?.relevance_band).toBe('direct')
      expect(result.matched_nodes.find((node) => node.label === 'SessionManager')?.relevance_band).toBe('related')
      expect(result.matched_nodes.find((node) => node.label === 'BillingStore')?.relevance_band).toBe('peripheral')
    })

    it('answers nest controller and service questions with extracted nest semantics', () => {
      const fixturesDir = join(process.cwd(), 'tests', 'fixtures')
      const graph = build([
        extractJs(join(fixturesDir, 'nest-auth.module.ts')),
        extractJs(join(fixturesDir, 'nest-auth.controller.ts')),
        extractJs(join(fixturesDir, 'nest-auth.service.ts')),
      ])

      const result = retrieveContext(graph, {
        question: 'which nest controller calls AuthService',
        budget: 5000,
        fileType: 'code',
      })

      expect(result.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'AuthController',
          framework_role: 'nest_controller',
          framework: 'nestjs',
        }),
      )
      expect(result.matched_nodes[0]?.framework_boost).toBeGreaterThan(0)
    })

    it('answers next route, client, and server-action questions with extracted next semantics', () => {
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
      ])

      const routeResult = retrieveContext(graph, {
        question: 'which next route owns the team settings page',
        budget: 5000,
        fileType: 'code',
      })
      expect(routeResult.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: '/dashboard/[team]',
          framework: 'nextjs',
          framework_role: 'next_route',
        }),
      )

      const clientResult = retrieveContext(graph, {
        question: 'which next component is client only',
        budget: 5000,
        fileType: 'code',
      })
      expect(clientResult.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'ClientTeamPanel()',
          framework: 'nextjs',
          framework_role: 'next_client_component',
        }),
      )

      const actionResult = retrieveContext(graph, {
        question: 'which next server action updates team settings',
        budget: 5000,
        fileType: 'code',
      })
      expect(actionResult.matched_nodes[0]).toEqual(
        expect.objectContaining({
          label: 'saveTeamSettings()',
          framework: 'nextjs',
          framework_role: 'next_server_action',
        }),
      )
      expect(actionResult.matched_nodes[0]?.framework_boost).toBeGreaterThan(0)
    })
  })

  describe('tokenWeightsForQuestion', () => {
    it('reuses cached token weights for the same graph instance and query tokens', () => {
      const graph = new KnowledgeGraph()
      graph.addNode('auth_service', { label: 'AuthService' })
      graph.addNode('auth_controller', { label: 'AuthController' })

      const questionTokens = tokenizeQuestion('auth flow')
      const first = tokenWeightsForQuestion(graph, questionTokens)
      const second = tokenWeightsForQuestion(graph, questionTokens)
      const different = tokenWeightsForQuestion(graph, tokenizeQuestion('controller'))

      expect(second).toBe(first)
      expect(different).not.toBe(first)
    })
  })
})
