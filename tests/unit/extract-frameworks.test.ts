import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildGraph as buildGraphBase, buildGraphFromExtraction as buildGraphFromExtractionBase } from '../../src/application/build-graph.js'
import * as detectModule from '../../src/pipeline/detect.js'
import { _makeId, createEdge, createNode } from '../../src/pipeline/extract/core.js'
import { applyJsFrameworkAdapters } from '../../src/pipeline/extract/frameworks/core.js'
import type { ExtractionFragment } from '../../src/pipeline/extract/dispatch.js'
import { resolveImportPath } from '../../src/pipeline/extract/frameworks/js-import-paths.js'
import type { JsFrameworkAdapter, JsFrameworkContext } from '../../src/pipeline/extract/frameworks/types.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { inspectReduxModuleExports } from '../../src/pipeline/extract/frameworks/redux.js'
 
const REPO_ROOT = process.cwd()
const FIXTURES_DIR = join(REPO_ROOT, 'tests', 'fixtures')
const TEST_ARTIFACTS_DIR = join(REPO_ROOT, '.test-artifacts', 'framework-adapter-tests')
const buildGraph: typeof buildGraphBase = (extractions, options = {}) =>
  buildGraphBase(extractions, { rootPath: REPO_ROOT, ...options })
const buildGraphFromExtraction: typeof buildGraphFromExtractionBase = (extraction, options = {}) =>
  buildGraphFromExtractionBase(extraction, { rootPath: REPO_ROOT, ...options })

afterEach(() => {
  vi.restoreAllMocks()
})

function normalizeFileNameForAssertion(filePath: string): string {
  return filePath.replaceAll('\\', '/')
}

function createFrameworkContext(filePath: string, sourceText: string, baseExtraction: ExtractionFragment): JsFrameworkContext {
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : filePath.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TS

  return {
    filePath,
    sourceText,
    sourceFile: ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind),
    stem: 'app',
    fileNodeId: _makeId('app'),
    isJsxFile: filePath.endsWith('.tsx') || filePath.endsWith('.jsx'),
    baseExtraction,
  }
}

function createBaseExtraction(filePath: string, stem: string, labels: readonly string[]): ExtractionFragment {
  return {
    nodes: [
      createNode(_makeId(stem), `${stem}.ts`, filePath, 1),
      ...labels.map((label, index) => createNode(_makeId(stem, label), label, filePath, index + 2)),
    ],
    edges: [],
  }
}

function nodeIdForLabel(fragment: ExtractionFragment, label: string): string {
  const nodeId = fragment.nodes?.find((node) => node.label === label)?.id
  expect(nodeId).toBeDefined()
  return nodeId!
}

function graphNodeIdForLabel(graph: ReturnType<typeof buildGraph>, label: string): string {
  for (const [nodeId, attributes] of graph.nodeEntries()) {
    if (attributes.label === label) {
      return nodeId
    }
  }
  throw new Error(`Missing graph node for label: ${label}`)
}

function writeScratchFiles(rootDir: string, files: Record<string, string>): void {
  mkdirSync(rootDir, { recursive: true })
  for (const [relativePath, sourceText] of Object.entries(files)) {
    const filePath = join(rootDir, relativePath)
    mkdirSync(join(filePath, '..'), { recursive: true })
    writeFileSync(filePath, sourceText)
  }
}

describe('js framework extraction contract', () => {
  it('returns no extra nodes for plain ts utility files', () => {
    const filePath = join(FIXTURES_DIR, 'sample.ts')
    const result = extractJs(filePath)

    expect(result.nodes.map((node) => node.label)).toEqual(
      expect.arrayContaining(['sample.ts', 'HttpClient', '.constructor()', '.get()', '.post()', 'buildHeaders()']),
    )
    expect(result.nodes).toHaveLength(6)
    expect(result.edges.filter((edge) => edge.relation.startsWith('framework_'))).toHaveLength(0)
  })

  it('accepts js/ts ast context and keeps emitted nodes through graph building', () => {
    const filePath = join(FIXTURES_DIR, 'app.tsx')
    const sourceText = ['export function App() {', '  return null', '}'].join('\n')
    const fileNodeId = _makeId('app')
    const routeNodeId = _makeId('app', 'route')
    const baseExtraction: ExtractionFragment = {
      nodes: [createNode(fileNodeId, 'app.tsx', filePath, 1)],
      edges: [],
    }

    const adapter: JsFrameworkAdapter = {
      id: 'test:framework-route',
      matches(candidatePath, candidateSourceText) {
        return candidatePath === filePath && candidateSourceText === sourceText
      },
      extract(context) {
        expect(context.filePath).toBe(filePath)
        expect(context.sourceText).toBe(sourceText)
        expect(normalizeFileNameForAssertion(context.sourceFile.fileName)).toBe(normalizeFileNameForAssertion(filePath))
        expect(ts.isSourceFile(context.sourceFile)).toBe(true)
        expect(context.baseExtraction).toEqual(baseExtraction)

        return {
          nodes: [createNode(routeNodeId, 'AppRoute', filePath, 1)],
          edges: [createEdge(context.fileNodeId, routeNodeId, 'framework_declares_route', filePath, 1)],
        }
      },
    }

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction), [adapter])
    const graph = buildGraphFromExtraction({
      nodes: result.nodes,
      edges: result.edges,
    })

    expect(result.nodes.find((node) => node.id === routeNodeId)?.label).toBe('AppRoute')
    expect(graph.hasNode(routeNodeId)).toBe(true)
    expect(graph.uniqueEdgeBetween(fileNodeId, routeNodeId).attributes.relation).toBe('framework_declares_route')
  })

  it('treats TypeScript SourceFile names as equivalent across path separators', () => {
    const filePath = 'D:\\a\\madar\\madar\\tests\\fixtures\\app.tsx'
    const sourceFile = ts.createSourceFile(filePath, 'export function App() { return null }', ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

    expect(normalizeFileNameForAssertion(sourceFile.fileName)).toBe(normalizeFileNameForAssertion(filePath))
  })

  it('allows adapters to augment existing nodes with additional attributes', () => {
    const filePath = join(FIXTURES_DIR, 'app.tsx')
    const sourceText = ['export function App() {', '  return null', '}'].join('\n')
    const fileNodeId = _makeId('app')
    const componentNodeId = _makeId('app', 'app')
    const baseExtraction: ExtractionFragment = {
      nodes: [createNode(fileNodeId, 'app.tsx', filePath, 1), createNode(componentNodeId, 'App', filePath, 1)],
      edges: [],
    }

    const adapter: JsFrameworkAdapter = {
      id: 'test:framework-augmentation',
      matches() {
        return true
      },
      extract() {
        return {
          nodes: [
            {
              ...createNode(componentNodeId, 'App', filePath, 1),
              node_kind: 'component',
              framework_role: 'root',
            },
          ],
          edges: [],
        }
      },
    }

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction), [adapter])
    const graph = buildGraphFromExtraction({
      nodes: result.nodes,
      edges: result.edges,
    })

    expect(result.nodes.find((node) => node.id === componentNodeId)).toEqual(
      expect.objectContaining({
        id: componentNodeId,
        label: 'App',
        node_kind: 'component',
        framework_role: 'root',
      }),
    )
    expect(graph.nodeAttributes(componentNodeId)).toEqual(
      expect.objectContaining({
        label: 'App',
        node_kind: 'component',
        framework_role: 'root',
      }),
    )
  })

  it('preserves stable explicit relation names from framework adapters', () => {
    const filePath = join(FIXTURES_DIR, 'router.tsx')
    const sourceText = readFileSync(join(FIXTURES_DIR, 'sample.ts'), 'utf8')
    const fileNodeId = _makeId('app')
    const routerNodeId = _makeId('app', 'router')
    const providerNodeId = _makeId('app', 'provider')
    const baseExtraction: ExtractionFragment = {
      nodes: [createNode(fileNodeId, 'router.tsx', filePath, 1)],
      edges: [],
    }

    const adapter: JsFrameworkAdapter = {
      id: 'test:framework-relations',
      matches() {
        return true
      },
      extract() {
        return {
          nodes: [createNode(routerNodeId, 'AppRouter', filePath, 1), createNode(providerNodeId, 'RouterProvider', filePath, 1)],
          edges: [
            createEdge(fileNodeId, routerNodeId, 'framework_registers_router', filePath, 1),
            createEdge(routerNodeId, providerNodeId, 'framework_renders_provider', filePath, 1),
          ],
        }
      },
    }

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction), [adapter])

    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: fileNodeId, target: routerNodeId, relation: 'framework_registers_router' }),
        expect.objectContaining({ source: routerNodeId, target: providerNodeId, relation: 'framework_renders_provider' }),
      ]),
    )
  })

  it('preserves same-pair baseline and framework relations as parallel edges', () => {
    const filePath = join(FIXTURES_DIR, 'router.tsx')
    const sourceText = ['export function App() {', '  return null', '}'].join('\n')
    const fileNodeId = _makeId('app')
    const componentNodeId = _makeId('app', 'component')
    const baseExtraction: ExtractionFragment = {
      nodes: [createNode(fileNodeId, 'app.tsx', filePath, 1), createNode(componentNodeId, 'App', filePath, 1)],
      edges: [createEdge(fileNodeId, componentNodeId, 'declares', filePath, 1)],
    }

    const adapter: JsFrameworkAdapter = {
      id: 'test:framework-edge-collision',
      matches() {
        return true
      },
      extract() {
        return {
          nodes: [],
          edges: [createEdge(fileNodeId, componentNodeId, 'framework_declares_component', filePath, 2)],
        }
      },
    }

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction), [adapter])
    const graph = buildGraphFromExtraction({
      nodes: result.nodes,
      edges: result.edges,
    })

    expect(graph.relationKindsBetween(fileNodeId, componentNodeId)).toEqual([
      'declares',
      'framework_declares_component',
    ])
  })

  it('preserves reverse-direction framework edges', () => {
    const filePath = join(FIXTURES_DIR, 'router.tsx')
    const sourceText = ['export function App() {', '  return null', '}'].join('\n')
    const fileNodeId = _makeId('app')
    const componentNodeId = _makeId('app', 'component')
    const baseExtraction: ExtractionFragment = {
      nodes: [createNode(fileNodeId, 'app.tsx', filePath, 1), createNode(componentNodeId, 'App', filePath, 1)],
      edges: [createEdge(fileNodeId, componentNodeId, 'declares', filePath, 1)],
    }

    const adapter: JsFrameworkAdapter = {
      id: 'test:framework-directed-reverse-edge',
      matches() {
        return true
      },
      extract() {
        return {
          nodes: [],
          edges: [createEdge(componentNodeId, fileNodeId, 'framework_references_component', filePath, 2)],
        }
      },
    }

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction), [adapter])
    const graph = buildGraphFromExtraction(
      {
        nodes: result.nodes,
        edges: result.edges,
      },
    )

    expect(result.edges.filter((edge) => new Set([edge.source, edge.target]).size === 2)).toEqual([
      expect.objectContaining({ source: componentNodeId, target: fileNodeId, relation: 'framework_references_component' }),
      expect.objectContaining({ source: fileNodeId, target: componentNodeId, relation: 'declares' }),
    ])
    expect(graph.uniqueEdgeBetween(fileNodeId, componentNodeId).attributes).toEqual(
      expect.objectContaining({
        relation: 'declares',
      }),
    )
    expect(graph.uniqueEdgeBetween(componentNodeId, fileNodeId).attributes).toEqual(
      expect.objectContaining({
        relation: 'framework_references_component',
      }),
    )
  })

  it('preserves framework-scoped cross-file edges until the combined graph contains their targets', () => {
    const filePath = join(FIXTURES_DIR, 'app.tsx')
    const sourceText = ['export function App() {', '  return null', '}'].join('\n')
    const fileNodeId = _makeId('app')
    const routeNodeId = _makeId('routes', 'app-route')
    const baseExtraction: ExtractionFragment = {
      nodes: [createNode(fileNodeId, 'app.tsx', filePath, 1)],
      edges: [],
    }

    const adapter: JsFrameworkAdapter = {
      id: 'test:framework-cross-file-edge',
      matches() {
        return true
      },
      extract() {
        return {
          nodes: [],
          edges: [createEdge(fileNodeId, routeNodeId, 'framework_registers_route', filePath, 2)],
        }
      },
    }

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction), [adapter])

    expect(result.edges).toEqual([
      expect.objectContaining({
        source: fileNodeId,
        target: routeNodeId,
        relation: 'framework_registers_route',
      }),
    ])

    const graph = buildGraph([
      {
        schema_version: 1,
        nodes: result.nodes,
        edges: result.edges,
      },
      {
        schema_version: 1,
        nodes: [createNode(routeNodeId, 'AppRoute', join(FIXTURES_DIR, 'routes.ts'), 1)],
        edges: [],
      },
    ])

    expect(graph.hasNode(routeNodeId)).toBe(true)
    expect(graph.uniqueEdgeBetween(fileNodeId, routeNodeId).attributes).toEqual(
      expect.objectContaining({
        relation: 'framework_registers_route',
      }),
    )
  })

  it('extracts express routes, middleware, handlers, and same-file router mounts', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-express-app.ts')
    const sourceText = [
      "import express from 'express'",
      '',
      'function requireAuth(_req: unknown, _res: unknown, next: () => void) {',
      '  next()',
      '}',
      '',
      'const auditTrail = (_req: unknown, _res: unknown, next: () => void) => next()',
      '',
      'function showUser() {}',
      'function createUser() {}',
      'function updateUser() {}',
      'function patchUser() {}',
      'function replaceUser() {}',
      'function removeUser() {}',
      'function fallbackHandler() {}',
      '',
      'const app = express()',
      'const router = express.Router()',
      '',
      "app.use('/api', requireAuth, [auditTrail], router)",
      "app.get('/health', (_req: unknown, _res: unknown) => {})",
      "app.post('/users', requireAuth, createUser)",
      "app.patch('/users/:id/profile', requireAuth, patchUser)",
      "app.put('/users/:id/profile', requireAuth, replaceUser)",
      "app.delete('/users/:id/profile', requireAuth, removeUser)",
      "app.all('/users/:id/audit', requireAuth, fallbackHandler)",
      "app.route('/users/:id').put([requireAuth], updateUser).delete(controller(showUser))",
      '',
      "router.get('/profile/:id', auditTrail, showUser)",
      "router.post('/users/:id/notes', auditTrail, createUser)",
      "router.use('/errors/:id', requireAuth, function onUserError(_err: unknown, _req: unknown, _res: unknown, next: () => void) {",
      '  next()',
      '})',
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-express-app', [
      'requireAuth',
      'auditTrail',
      'showUser',
      'createUser',
      'updateUser',
      'patchUser',
      'replaceUser',
      'removeUser',
      'fallbackHandler',
    ])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'app', node_kind: 'router', framework_role: 'express_app' }),
        expect.objectContaining({ label: 'router', node_kind: 'router', framework_role: 'express_router' }),
        expect.objectContaining({ label: 'requireAuth', node_kind: 'function', framework_role: 'express_middleware' }),
        expect.objectContaining({ label: 'createUser', node_kind: 'function', framework_role: 'express_handler' }),
        expect.objectContaining({ label: 'inline handles_route GET /health', node_kind: 'function', framework_role: 'express_handler' }),
        expect.objectContaining({ label: 'onUserError', node_kind: 'function', framework_role: 'express_error_middleware' }),
        expect.objectContaining({ label: 'USE /api', node_kind: 'route', http_method: 'USE', route_path: '/api' }),
        expect.objectContaining({ label: 'GET /health', node_kind: 'route', http_method: 'GET', route_path: '/health' }),
        expect.objectContaining({ label: 'POST /users', node_kind: 'route', http_method: 'POST', route_path: '/users' }),
        expect.objectContaining({ label: 'PATCH /users/:id/profile', node_kind: 'route', http_method: 'PATCH', route_path: '/users/:id/profile' }),
        expect.objectContaining({ label: 'PUT /users/:id/profile', node_kind: 'route', http_method: 'PUT', route_path: '/users/:id/profile' }),
        expect.objectContaining({ label: 'DELETE /users/:id/profile', node_kind: 'route', http_method: 'DELETE', route_path: '/users/:id/profile' }),
        expect.objectContaining({ label: 'ALL /users/:id/audit', node_kind: 'route', http_method: 'ALL', route_path: '/users/:id/audit' }),
        expect.objectContaining({ label: 'PUT /users/:id', node_kind: 'route', http_method: 'PUT', route_path: '/users/:id' }),
        expect.objectContaining({ label: 'DELETE /users/:id', node_kind: 'route', http_method: 'DELETE', route_path: '/users/:id' }),
        expect.objectContaining({ label: 'GET /profile/:id', node_kind: 'route', http_method: 'GET', route_path: '/profile/:id' }),
        expect.objectContaining({ label: 'POST /users/:id/notes', node_kind: 'route', http_method: 'POST', route_path: '/users/:id/notes' }),
        expect.objectContaining({ label: 'USE /errors/:id', node_kind: 'route', http_method: 'USE', route_path: '/errors/:id' }),
      ]),
    )

    const appNodeId = nodeIdForLabel(result, 'app')
    const routerNodeId = nodeIdForLabel(result, 'router')
    const useApiRouteId = nodeIdForLabel(result, 'USE /api')
    const getHealthRouteId = nodeIdForLabel(result, 'GET /health')
    const getHealthInlineHandlerId = nodeIdForLabel(result, 'inline handles_route GET /health')
    const postUsersRouteId = nodeIdForLabel(result, 'POST /users')
    const patchProfileRouteId = nodeIdForLabel(result, 'PATCH /users/:id/profile')
    const putProfileRouteId = nodeIdForLabel(result, 'PUT /users/:id/profile')
    const deleteProfileRouteId = nodeIdForLabel(result, 'DELETE /users/:id/profile')
    const allAuditRouteId = nodeIdForLabel(result, 'ALL /users/:id/audit')
    const putUsersRouteId = nodeIdForLabel(result, 'PUT /users/:id')
    const deleteUsersRouteId = nodeIdForLabel(result, 'DELETE /users/:id')
    const getProfileRouteId = nodeIdForLabel(result, 'GET /profile/:id')
    const postNotesRouteId = nodeIdForLabel(result, 'POST /users/:id/notes')
    const useErrorsRouteId = nodeIdForLabel(result, 'USE /errors/:id')

    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: appNodeId, target: routerNodeId, relation: 'mounts_router' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'requireAuth'), target: useApiRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'auditTrail'), target: useApiRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: getHealthInlineHandlerId, target: getHealthRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: getHealthRouteId, target: getHealthInlineHandlerId, relation: 'contains' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'requireAuth'), target: postUsersRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'createUser'), target: postUsersRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'requireAuth'), target: patchProfileRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'patchUser'), target: patchProfileRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'requireAuth'), target: putProfileRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'replaceUser'), target: putProfileRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'requireAuth'), target: deleteProfileRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'removeUser'), target: deleteProfileRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'requireAuth'), target: allAuditRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'fallbackHandler'), target: allAuditRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'requireAuth'), target: putUsersRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'updateUser'), target: putUsersRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'showUser'), target: deleteUsersRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'auditTrail'), target: getProfileRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'showUser'), target: getProfileRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'auditTrail'), target: postNotesRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'createUser'), target: postNotesRouteId, relation: 'handles_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'requireAuth'), target: useErrorsRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'onUserError'), target: useErrorsRouteId, relation: 'middleware' }),
        expect.objectContaining({ source: appNodeId, target: getHealthRouteId, relation: 'registers_route' }),
        expect.objectContaining({ source: routerNodeId, target: getProfileRouteId, relation: 'registers_route' }),
      ]),
    )
  })

  it('preserves imported express router mounts until the mounted router node is available', () => {
    const appFilePath = join(FIXTURES_DIR, 'virtual-express-parent.ts')
    const routesFilePath = join(FIXTURES_DIR, 'virtual-express-child.ts')
    const appSourceText = readFileSync(appFilePath, 'utf8')
    const routesSourceText = readFileSync(routesFilePath, 'utf8')
    const appBaseExtraction = createBaseExtraction(appFilePath, 'virtual-express-parent', [])
    const routesBaseExtraction = createBaseExtraction(routesFilePath, 'virtual-express-child', ['listUser'])

    const appResult = applyJsFrameworkAdapters(
      appBaseExtraction,
      createFrameworkContext(appFilePath, appSourceText, appBaseExtraction),
    )
    const routesResult = applyJsFrameworkAdapters(
      routesBaseExtraction,
      createFrameworkContext(routesFilePath, routesSourceText, routesBaseExtraction),
    )

    const appNodeId = nodeIdForLabel(appResult, 'app')
    const apiRouterNodeId = nodeIdForLabel(routesResult, 'apiRouter')

    expect(appResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: appNodeId, target: apiRouterNodeId, relation: 'mounts_router' }),
      ]),
    )

    const graph = buildGraph([
      {
        schema_version: 1,
        nodes: appResult.nodes ?? [],
        edges: appResult.edges ?? [],
      },
      {
        schema_version: 1,
        nodes: routesResult.nodes ?? [],
        edges: routesResult.edges ?? [],
      },
    ])

    expect(graph.hasNode(apiRouterNodeId)).toBe(true)
    expect(graph.uniqueEdgeBetween(appNodeId, apiRouterNodeId).attributes).toEqual(
      expect.objectContaining({
        relation: 'mounts_router',
      }),
    )
  })

  it('preserves imported express router mounts for default imports and CommonJS require bindings', () => {
    const defaultAppFilePath = join(FIXTURES_DIR, 'express-default-import-parent.ts')
    const defaultRoutesFilePath = join(FIXTURES_DIR, 'express-default-import-child.ts')
    const requireAppFilePath = join(FIXTURES_DIR, 'express-commonjs-parent.ts')
    const requireRoutesFilePath = join(FIXTURES_DIR, 'express-commonjs-child.ts')

    const defaultAppSourceText = readFileSync(defaultAppFilePath, 'utf8')
    const defaultRoutesSourceText = readFileSync(defaultRoutesFilePath, 'utf8')
    const requireAppSourceText = readFileSync(requireAppFilePath, 'utf8')
    const requireRoutesSourceText = readFileSync(requireRoutesFilePath, 'utf8')

    const defaultAppBaseExtraction = createBaseExtraction(defaultAppFilePath, 'virtual-express-default-parent', [])
    const defaultRoutesBaseExtraction = createBaseExtraction(defaultRoutesFilePath, 'virtual-express-default-child', ['listUser'])
    const requireAppBaseExtraction = createBaseExtraction(requireAppFilePath, 'virtual-express-require-parent', [])
    const requireRoutesBaseExtraction = createBaseExtraction(requireRoutesFilePath, 'virtual-express-require-child', ['listUser'])

    const defaultAppResult = applyJsFrameworkAdapters(
      defaultAppBaseExtraction,
      createFrameworkContext(defaultAppFilePath, defaultAppSourceText, defaultAppBaseExtraction),
    )
    const defaultRoutesResult = applyJsFrameworkAdapters(
      defaultRoutesBaseExtraction,
      createFrameworkContext(defaultRoutesFilePath, defaultRoutesSourceText, defaultRoutesBaseExtraction),
    )
    const requireAppResult = applyJsFrameworkAdapters(
      requireAppBaseExtraction,
      createFrameworkContext(requireAppFilePath, requireAppSourceText, requireAppBaseExtraction),
    )
    const requireRoutesResult = applyJsFrameworkAdapters(
      requireRoutesBaseExtraction,
      createFrameworkContext(requireRoutesFilePath, requireRoutesSourceText, requireRoutesBaseExtraction),
    )

    const defaultAppNodeId = nodeIdForLabel(defaultAppResult, 'app')
    const defaultRouterNodeId = nodeIdForLabel(defaultRoutesResult, 'apiRouter')
    const requireAppNodeId = nodeIdForLabel(requireAppResult, 'app')
    const requireRouterNodeId = nodeIdForLabel(requireRoutesResult, 'router')

    expect(defaultAppResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: defaultAppNodeId, target: defaultRouterNodeId, relation: 'mounts_router' }),
      ]),
    )
    expect(requireAppResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: requireAppNodeId, target: requireRouterNodeId, relation: 'mounts_router' }),
      ]),
    )
  })

  it('resolves imported express router mounts from namespace and CommonJS module-object bindings', () => {
    const namespaceParentFilePath = join(FIXTURES_DIR, 'express-namespace-module-parent.ts')
    const namespaceChildFilePath = join(FIXTURES_DIR, 'express-namespace-module-child.ts')
    const commonjsParentFilePath = join(FIXTURES_DIR, 'express-commonjs-module-parent.ts')
    const commonjsChildFilePath = join(FIXTURES_DIR, 'express-commonjs-module-child.ts')

    const namespaceParentResult = extractJs(namespaceParentFilePath)
    const namespaceChildResult = extractJs(namespaceChildFilePath)
    const commonjsParentResult = extractJs(commonjsParentFilePath)
    const commonjsChildResult = extractJs(commonjsChildFilePath)

    expect(namespaceParentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: nodeIdForLabel(namespaceParentResult, 'app'),
          target: nodeIdForLabel(namespaceChildResult, 'router'),
          relation: 'mounts_router',
        }),
      ]),
    )
    expect(commonjsParentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: nodeIdForLabel(commonjsParentResult, 'app'),
          target: nodeIdForLabel(commonjsChildResult, 'router'),
          relation: 'mounts_router',
        }),
      ]),
    )

    const namespaceGraph = buildGraph([namespaceParentResult, namespaceChildResult])
    const commonjsGraph = buildGraph([commonjsParentResult, commonjsChildResult])

    expect(graphNodeIdForLabel(namespaceGraph, 'GET /api/users/:id')).toBeDefined()
    expect(graphNodeIdForLabel(commonjsGraph, 'GET /api/users/:id')).toBeDefined()
  })

  it('extracts routes registered on imported express owners without local express imports', () => {
    const namedChildFilePath = join(FIXTURES_DIR, 'express-imported-owner-router-child.ts')
    const namedParentFilePath = join(FIXTURES_DIR, 'express-imported-owner-router-parent.ts')
    const defaultChildFilePath = join(FIXTURES_DIR, 'express-imported-owner-app-child.ts')
    const defaultParentFilePath = join(FIXTURES_DIR, 'express-imported-owner-app-parent.ts')
    const commonjsChildFilePath = join(FIXTURES_DIR, 'express-imported-owner-commonjs-child.ts')
    const commonjsParentFilePath = join(FIXTURES_DIR, 'express-imported-owner-commonjs-parent.ts')

    const namedChildResult = extractJs(namedChildFilePath)
    const namedParentResult = extractJs(namedParentFilePath)
    const defaultChildResult = extractJs(defaultChildFilePath)
    const defaultParentResult = extractJs(defaultParentFilePath)
    const commonjsChildResult = extractJs(commonjsChildFilePath)
    const commonjsParentResult = extractJs(commonjsParentFilePath)

    expect(namedParentResult.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'GET /users/:id', node_kind: 'route', route_path: '/users/:id' })]),
    )
    expect(defaultParentResult.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'POST /users', node_kind: 'route', route_path: '/users' })]),
    )
    expect(commonjsParentResult.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'DELETE /users/:id', node_kind: 'route', route_path: '/users/:id' })]),
    )

    expect(namedParentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: nodeIdForLabel(namedChildResult, 'apiRouter'),
          target: nodeIdForLabel(namedParentResult, 'GET /users/:id'),
          relation: 'registers_route',
        }),
        expect.objectContaining({
          source: nodeIdForLabel(namedParentResult, 'showUser()'),
          target: nodeIdForLabel(namedParentResult, 'GET /users/:id'),
          relation: 'handles_route',
        }),
      ]),
    )
    expect(defaultParentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: nodeIdForLabel(defaultChildResult, 'apiApp'),
          target: nodeIdForLabel(defaultParentResult, 'POST /users'),
          relation: 'registers_route',
        }),
        expect.objectContaining({
          source: nodeIdForLabel(defaultParentResult, 'createUser()'),
          target: nodeIdForLabel(defaultParentResult, 'POST /users'),
          relation: 'handles_route',
        }),
      ]),
    )
    expect(commonjsParentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: nodeIdForLabel(commonjsChildResult, 'apiRouter'),
          target: nodeIdForLabel(commonjsParentResult, 'DELETE /users/:id'),
          relation: 'registers_route',
        }),
        expect.objectContaining({
          source: nodeIdForLabel(commonjsParentResult, 'removeUser()'),
          target: nodeIdForLabel(commonjsParentResult, 'DELETE /users/:id'),
          relation: 'handles_route',
        }),
      ]),
    )
  })

  it('recognizes direct CommonJS express app and router construction', () => {
    const directAppFilePath = join(FIXTURES_DIR, 'express-commonjs-direct-app.ts')
    const directRouterFilePath = join(FIXTURES_DIR, 'express-commonjs-direct-router.ts')

    const directAppResult = extractJs(directAppFilePath)
    const directRouterResult = extractJs(directRouterFilePath)

    const appNodeId = nodeIdForLabel(directAppResult, 'app')
    const appRouteId = nodeIdForLabel(directAppResult, 'GET /health')
    const appHandlerId = nodeIdForLabel(directAppResult, 'listHealth()')
    const routerNodeId = nodeIdForLabel(directRouterResult, 'router')
    const routerRouteId = nodeIdForLabel(directRouterResult, 'GET /users/:id')
    const routerHandlerId = nodeIdForLabel(directRouterResult, 'listUser()')

    expect(directAppResult.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'app', node_kind: 'router', framework_role: 'express_app' }),
        expect.objectContaining({ label: 'GET /health', node_kind: 'route', route_path: '/health' }),
      ]),
    )
    expect(directRouterResult.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'router', node_kind: 'router', framework_role: 'express_router' }),
        expect.objectContaining({ label: 'GET /users/:id', node_kind: 'route', route_path: '/users/:id' }),
      ]),
    )

    expect(directAppResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: appNodeId, target: appRouteId, relation: 'registers_route' }),
        expect.objectContaining({ source: appHandlerId, target: appRouteId, relation: 'handles_route' }),
      ]),
    )
    expect(directRouterResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: routerNodeId, target: routerRouteId, relation: 'registers_route' }),
        expect.objectContaining({ source: routerHandlerId, target: routerRouteId, relation: 'handles_route' }),
      ]),
    )
  })

  it('uses each literal path for direct chained app and router verb calls', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-express-direct-chained.ts')
    const sourceText = [
      "import express from 'express'",
      '',
      'function first() {}',
      'function second() {}',
      'function showUser() {}',
      'function createUser() {}',
      '',
      'const app = express()',
      'const router = express.Router()',
      '',
      "app.get('/a', first).post('/b', second)",
      "router.get('/users/:id', showUser).post('/users', createUser)",
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-express-direct-chained', [
      'first',
      'second',
      'showUser',
      'createUser',
    ])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'GET /a', node_kind: 'route', route_path: '/a' }),
        expect.objectContaining({ label: 'POST /b', node_kind: 'route', route_path: '/b' }),
        expect.objectContaining({ label: 'GET /users/:id', node_kind: 'route', route_path: '/users/:id' }),
        expect.objectContaining({ label: 'POST /users', node_kind: 'route', route_path: '/users' }),
      ]),
    )
    expect(result.nodes).not.toEqual(expect.arrayContaining([expect.objectContaining({ label: 'POST /', node_kind: 'route' })]))

    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: nodeIdForLabel(result, 'first'),
          target: nodeIdForLabel(result, 'GET /a'),
          relation: 'handles_route',
        }),
        expect.objectContaining({
          source: nodeIdForLabel(result, 'second'),
          target: nodeIdForLabel(result, 'POST /b'),
          relation: 'handles_route',
        }),
        expect.objectContaining({
          source: nodeIdForLabel(result, 'showUser'),
          target: nodeIdForLabel(result, 'GET /users/:id'),
          relation: 'handles_route',
        }),
        expect.objectContaining({
          source: nodeIdForLabel(result, 'createUser'),
          target: nodeIdForLabel(result, 'POST /users'),
          relation: 'handles_route',
        }),
      ]),
    )
  })

  it('recognizes TypeScript import-equals express app construction', () => {
    const filePath = join(FIXTURES_DIR, 'express-import-equals-app.ts')

    const result = extractJs(filePath)

    const appNodeId = nodeIdForLabel(result, 'app')
    const routeId = nodeIdForLabel(result, 'GET /health')
    const handlerId = nodeIdForLabel(result, 'listHealth()')

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'app', node_kind: 'router', framework_role: 'express_app' }),
        expect.objectContaining({ label: 'GET /health', node_kind: 'route', route_path: '/health' }),
      ]),
    )
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: appNodeId, target: routeId, relation: 'registers_route' }),
        expect.objectContaining({ source: handlerId, target: routeId, relation: 'handles_route' }),
      ]),
    )
  })

  it('resolves import-equals child routers exported through module.exports properties', () => {
    const parentFilePath = join(FIXTURES_DIR, 'express-import-equals-parent.ts')
    const childFilePath = join(FIXTURES_DIR, 'express-import-equals-child.ts')

    const graph = buildGraph([extractJs(parentFilePath), extractJs(childFilePath)])

    expect(graph.nodeAttributes(graphNodeIdForLabel(graph, 'GET /api/users/:id'))).toEqual(
      expect.objectContaining({ route_path: '/api/users/:id' }),
    )
  })

  it('resolves child routers exported through module.exports object literals', () => {
    const parentFilePath = join(FIXTURES_DIR, 'express-commonjs-object-parent.ts')
    const childFilePath = join(FIXTURES_DIR, 'express-commonjs-object-child.ts')

    const graph = buildGraph([extractJs(parentFilePath), extractJs(childFilePath)])

    expect(graph.nodeAttributes(graphNodeIdForLabel(graph, 'GET /api/users/:id'))).toEqual(
      expect.objectContaining({ route_path: '/api/users/:id' }),
    )
  })

  it('ignores malformed direct CommonJS expressions without crashing', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-express-malformed.ts')
    const sourceText = [
      "const express = require('express')",
      'const app = require()()',
      'const router = require().Router()',
      "const extraArgApp = require('express', 'extra')()",
      "const extraArgRouter = require('express', 'extra').Router()",
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-express-malformed', [])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))

    expect(result.nodes?.filter((node) => node.framework === 'express')).toEqual([])
  })

  it('extractJs preserves named middleware and method handlers with real base labels', () => {
    const filePath = join(FIXTURES_DIR, 'express-named-handlers.ts')
    const result = extractJs(filePath)

    const routeId = nodeIdForLabel(result, 'GET /users/:id')
    const middlewareId = nodeIdForLabel(result, 'requireAuth()')
    const handlerId = nodeIdForLabel(result, '.showUser()')

    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: middlewareId, target: routeId, relation: 'middleware' }),
        expect.objectContaining({ source: handlerId, target: routeId, relation: 'handles_route' }),
      ]),
    )
  })

  it('treats imported middleware passed to use() as middleware instead of a mounted router', () => {
    const middlewareFilePath = join(FIXTURES_DIR, 'express-imported-middleware.ts')
    const parentFilePath = join(FIXTURES_DIR, 'express-imported-middleware-parent.ts')

    const middlewareResult = extractJs(middlewareFilePath)
    const parentResult = extractJs(parentFilePath)

    const routeId = nodeIdForLabel(parentResult, 'USE /api')
    const middlewareId = nodeIdForLabel(middlewareResult, 'requireAuth()')

    expect(parentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: middlewareId, target: routeId, relation: 'middleware' }),
      ]),
    )
    expect(parentResult.edges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relation: 'mounts_router', target: middlewareId }),
      ]),
    )
  })

  it('resolves default-exported express callables from ESM imports and CommonJS bindings', () => {
    const esmMiddlewareFilePath = join(FIXTURES_DIR, 'express-default-export-middleware.ts')
    const esmHandlerFilePath = join(FIXTURES_DIR, 'express-default-export-handler-class.ts')
    const esmParentFilePath = join(FIXTURES_DIR, 'express-default-export-callables-parent.ts')
    const commonjsMiddlewareFilePath = join(FIXTURES_DIR, 'express-commonjs-default-middleware.ts')
    const commonjsHandlerFilePath = join(FIXTURES_DIR, 'express-commonjs-default-handler-class.ts')
    const commonjsParentFilePath = join(FIXTURES_DIR, 'express-commonjs-default-callables-parent.ts')

    const esmMiddlewareResult = extractJs(esmMiddlewareFilePath)
    const esmHandlerResult = extractJs(esmHandlerFilePath)
    const esmParentResult = extractJs(esmParentFilePath)
    const commonjsMiddlewareResult = extractJs(commonjsMiddlewareFilePath)
    const commonjsHandlerResult = extractJs(commonjsHandlerFilePath)
    const commonjsParentResult = extractJs(commonjsParentFilePath)

    const esmRouteId = nodeIdForLabel(esmParentResult, 'GET /users/:id')
    const commonjsRouteId = nodeIdForLabel(commonjsParentResult, 'GET /users/:id')
    const commonjsMiddlewareId = nodeIdForLabel(commonjsParentResult, 'requireAuth()')
    const commonjsHandlerId = nodeIdForLabel(commonjsParentResult, 'ShowUser')

    expect(esmParentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: nodeIdForLabel(esmMiddlewareResult, 'requireAuth()'),
          target: esmRouteId,
          relation: 'middleware',
        }),
        expect.objectContaining({
          source: nodeIdForLabel(esmHandlerResult, 'ShowUser'),
          target: esmRouteId,
          relation: 'handles_route',
        }),
      ]),
    )
    expect(commonjsParentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: nodeIdForLabel(commonjsParentResult, 'requireAuth()'),
          target: commonjsRouteId,
          relation: 'middleware',
        }),
        expect.objectContaining({
          source: commonjsHandlerId,
          target: commonjsRouteId,
          relation: 'handles_route',
        }),
      ]),
    )

    const esmGraph = buildGraph([esmMiddlewareResult, esmHandlerResult, esmParentResult])
    const commonjsGraph = buildGraph([commonjsMiddlewareResult, commonjsHandlerResult, commonjsParentResult])

    expect(esmGraph.hasNode(nodeIdForLabel(esmMiddlewareResult, 'requireAuth()'))).toBe(true)
    expect(commonjsGraph.hasNode(commonjsMiddlewareId)).toBe(true)
    expect(commonjsGraph.uniqueEdgeBetween(commonjsHandlerId, commonjsRouteId).attributes).toEqual(
      expect.objectContaining({ relation: 'handles_route' }),
    )
  })

  it('resolves callable CommonJS default exports through ES default imports', () => {
    const middlewareFilePath = join(FIXTURES_DIR, 'express-commonjs-default-arrow-middleware.ts')
    const handlerFilePath = join(FIXTURES_DIR, 'express-commonjs-default-function-handler.ts')
    const parentFilePath = join(FIXTURES_DIR, 'express-commonjs-default-import-callables-parent.js')

    const middlewareResult = extractJs(middlewareFilePath)
    const handlerResult = extractJs(handlerFilePath)
    const parentResult = extractJs(parentFilePath)

    const routeId = nodeIdForLabel(parentResult, 'GET /users/:id')
    const handlerId = nodeIdForLabel(parentResult, 'showUser()')
    const middlewareEdge = parentResult.edges.find((edge) => edge.target === routeId && edge.relation === 'middleware')

    expect(middlewareEdge).toBeDefined()

    expect(parentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: middlewareEdge!.source,
          target: routeId,
          relation: 'middleware',
        }),
        expect.objectContaining({
          source: handlerId,
          target: routeId,
          relation: 'handles_route',
        }),
      ]),
    )

    const graph = buildGraph([middlewareResult, handlerResult, parentResult])

    expect(graph.hasNode(middlewareEdge!.source)).toBe(true)
    expect(graph.hasNode(handlerId)).toBe(true)
  })

  it('resolves callable CommonJS property exports through ES named imports and require destructuring', () => {
    const moduleMiddlewareFilePath = join(FIXTURES_DIR, 'express-commonjs-module-callable-middleware.ts')
    const moduleHandlerFilePath = join(FIXTURES_DIR, 'express-commonjs-module-callable-handler.ts')
    const moduleParentFilePath = join(FIXTURES_DIR, 'express-commonjs-module-callables-parent.js')
    const exportsMiddlewareFilePath = join(FIXTURES_DIR, 'express-commonjs-exports-callable-middleware.ts')
    const exportsHandlerFilePath = join(FIXTURES_DIR, 'express-commonjs-exports-callable-handler.ts')
    const exportsParentFilePath = join(FIXTURES_DIR, 'express-commonjs-exports-callables-parent.js')

    const moduleMiddlewareResult = extractJs(moduleMiddlewareFilePath)
    const moduleHandlerResult = extractJs(moduleHandlerFilePath)
    const moduleParentResult = extractJs(moduleParentFilePath)
    const exportsMiddlewareResult = extractJs(exportsMiddlewareFilePath)
    const exportsHandlerResult = extractJs(exportsHandlerFilePath)
    const exportsParentResult = extractJs(exportsParentFilePath)

    const moduleRouteId = nodeIdForLabel(moduleParentResult, 'GET /users/:id')
    const exportsRouteId = nodeIdForLabel(exportsParentResult, 'GET /users/:id')
    const moduleMiddlewareId = nodeIdForLabel(moduleParentResult, 'requireAuth()')
    const moduleHandlerId = nodeIdForLabel(moduleParentResult, 'showUser()')
    const exportsMiddlewareId = nodeIdForLabel(exportsParentResult, 'requireAuth()')
    const exportsHandlerId = nodeIdForLabel(exportsParentResult, 'showUser()')

    expect(moduleParentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: moduleMiddlewareId,
          target: moduleRouteId,
          relation: 'middleware',
        }),
        expect.objectContaining({
          source: moduleHandlerId,
          target: moduleRouteId,
          relation: 'handles_route',
        }),
      ]),
    )
    expect(exportsParentResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: exportsMiddlewareId,
          target: exportsRouteId,
          relation: 'middleware',
        }),
        expect.objectContaining({
          source: exportsHandlerId,
          target: exportsRouteId,
          relation: 'handles_route',
        }),
      ]),
    )

    const moduleGraph = buildGraph([moduleMiddlewareResult, moduleHandlerResult, moduleParentResult])
    const exportsGraph = buildGraph([exportsMiddlewareResult, exportsHandlerResult, exportsParentResult])

    expect(moduleGraph.hasNode(moduleMiddlewareId)).toBe(true)
    expect(moduleGraph.hasNode(moduleHandlerId)).toBe(true)
    expect(exportsGraph.hasNode(exportsMiddlewareId)).toBe(true)
    expect(exportsGraph.hasNode(exportsHandlerId)).toBe(true)
  })

  it('propagates mount prefixes and inherited middleware to mounted child router routes', () => {
    const parentFilePath = join(FIXTURES_DIR, 'express-mounted-router-parent.ts')
    const childFilePath = join(FIXTURES_DIR, 'express-mounted-router-child.ts')

    const graph = buildGraph([extractJs(parentFilePath), extractJs(childFilePath)])

    const mountedRouteId = graphNodeIdForLabel(graph, 'GET /api/users/:id')
    const middlewareId = graphNodeIdForLabel(graph, 'requireAuth()')
    const handlerId = graphNodeIdForLabel(graph, 'showUser()')

    expect(graph.nodeAttributes(mountedRouteId)).toEqual(
      expect.objectContaining({
        label: 'GET /api/users/:id',
        node_kind: 'route',
        route_path: '/api/users/:id',
      }),
    )
    expect(graph.uniqueEdgeBetween(middlewareId, mountedRouteId).attributes).toEqual(expect.objectContaining({ relation: 'middleware' }))
    expect(graph.uniqueEdgeBetween(handlerId, mountedRouteId).attributes).toEqual(expect.objectContaining({ relation: 'handles_route' }))
  })

  it('recursively propagates nested mounted router prefixes and inherited middleware', () => {
    const parentFilePath = join(FIXTURES_DIR, 'express-nested-router-parent.ts')
    const childFilePath = join(FIXTURES_DIR, 'express-nested-router-child.ts')
    const grandchildFilePath = join(FIXTURES_DIR, 'express-nested-router-grandchild.ts')

    const graph = buildGraph([extractJs(parentFilePath), extractJs(childFilePath), extractJs(grandchildFilePath)])

    const mountedRouteId = graphNodeIdForLabel(graph, 'GET /api/v1/users/:id')
    const authMiddlewareId = graphNodeIdForLabel(graph, 'requireAuth()')
    const auditMiddlewareId = graphNodeIdForLabel(graph, 'auditTrail()')
    const handlerId = graphNodeIdForLabel(graph, 'showUser()')

    expect(graph.nodeAttributes(mountedRouteId)).toEqual(
      expect.objectContaining({
        label: 'GET /api/v1/users/:id',
        node_kind: 'route',
        route_path: '/api/v1/users/:id',
      }),
    )
    expect(graph.uniqueEdgeBetween(authMiddlewareId, mountedRouteId).attributes).toEqual(expect.objectContaining({ relation: 'middleware' }))
    expect(graph.uniqueEdgeBetween(auditMiddlewareId, mountedRouteId).attributes).toEqual(expect.objectContaining({ relation: 'middleware' }))
    expect(graph.uniqueEdgeBetween(handlerId, mountedRouteId).attributes).toEqual(expect.objectContaining({ relation: 'handles_route' }))
  })

  it('handles circular cross-file router imports without recursing indefinitely', () => {
    const appFilePath = join(FIXTURES_DIR, 'express-cross-file-cycle-app.ts')
    const routerAFilePath = join(FIXTURES_DIR, 'express-cross-file-cycle-router-a.ts')
    const routerBFilePath = join(FIXTURES_DIR, 'express-cross-file-cycle-router-b.ts')

    const graph = buildGraph([extractJs(appFilePath), extractJs(routerAFilePath), extractJs(routerBFilePath)])

    expect(graph.nodeAttributes(graphNodeIdForLabel(graph, 'GET /api/local'))).toEqual(
      expect.objectContaining({ route_path: '/api/local' }),
    )
    expect(graph.nodeAttributes(graphNodeIdForLabel(graph, 'GET /api/b/leaf'))).toEqual(
      expect.objectContaining({ route_path: '/api/b/leaf' }),
    )
  })

  it('resolves directory router imports to index files before extraction', () => {
    const parentFilePath = join(FIXTURES_DIR, 'express-directory-import-parent.ts')
    const routesFilePath = join(FIXTURES_DIR, 'express-directory-routes', 'index.ts')

    const graph = buildGraph([extractJs(parentFilePath), extractJs(routesFilePath)])

    expect(graph.nodeAttributes(graphNodeIdForLabel(graph, 'GET /api/users'))).toEqual(
      expect.objectContaining({ route_path: '/api/users' }),
    )
  })

  it('does not let recursive mount cycle detection poison sibling mounted router expansions', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-express-cycle.ts')
    const sourceText = [
      "import express from 'express'",
      '',
      'function showUser() {}',
      '',
      'const app = express()',
      'const routerA = express.Router()',
      'const routerB = express.Router()',
      '',
      "routerA.use('/sub', routerB)",
      "routerB.use('/loop', routerA)",
      "routerB.get('/leaf', showUser)",
      '',
      "app.use('/a', routerA)",
      "app.use('/b', routerB)",
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-express-cycle', ['showUser'])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))
    const graph = buildGraph([result])

    expect(graph.nodeAttributes(graphNodeIdForLabel(graph, 'GET /a/sub/leaf'))).toEqual(
      expect.objectContaining({ route_path: '/a/sub/leaf' }),
    )
    expect(graph.nodeAttributes(graphNodeIdForLabel(graph, 'GET /b/leaf'))).toEqual(
      expect.objectContaining({ route_path: '/b/leaf' }),
    )
  })

  it('extracts redux toolkit slices, actions, selectors, thunks, and store registration', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-redux-store.ts')
    const sourceText = [
      "import { createAsyncThunk, createSlice, configureStore } from '@reduxjs/toolkit'",
      '',
      "const fetchProfile = createAsyncThunk('auth/fetchProfile', async () => ({ id: '1' }))",
      '',
      'const authSlice = createSlice({',
      "  name: 'auth',",
      '  initialState: { token: null as string | null, status: \'idle\' as \'idle\' | \'ready\' },',
      '  reducers: {',
      '    loginSucceeded(state, action: { payload: string }) {',
      '      state.token = action.payload',
      '    },',
      '    logout(state) {',
      '      state.token = null',
      '    },',
      '  },',
      '  selectors: {',
      '    selectToken: (state) => state.token,',
      '    selectStatus: (state) => state.status,',
      '  },',
      '  extraReducers: (builder) => {',
      '    builder.addCase(fetchProfile.fulfilled, (state) => {',
      "      state.status = 'ready'",
      '    })',
      '  },',
      '})',
      '',
      'export const { loginSucceeded, logout } = authSlice.actions',
      'export const { selectToken, selectStatus } = authSlice.selectors',
      'export const store = configureStore({',
      '  reducer: {',
      '    auth: authSlice.reducer,',
      '  },',
      '})',
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-redux-store', [
      'fetchProfile',
      'authSlice',
      'loginSucceeded',
      'logout',
      'selectToken',
      'selectStatus',
      'store',
    ])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))
    const graph = buildGraphFromExtraction({
      nodes: result.nodes,
      edges: result.edges,
    })

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'auth slice', node_kind: 'slice', framework_role: 'redux_slice', framework: 'redux-toolkit' }),
        expect.objectContaining({ label: 'fetchProfile', framework_role: 'redux_thunk', framework: 'redux-toolkit' }),
        expect.objectContaining({ label: 'loginSucceeded', framework_role: 'redux_action', framework: 'redux-toolkit' }),
        expect.objectContaining({ label: 'logout', framework_role: 'redux_action', framework: 'redux-toolkit' }),
        expect.objectContaining({ label: 'selectToken', framework_role: 'redux_selector', framework: 'redux-toolkit' }),
        expect.objectContaining({ label: 'selectStatus', framework_role: 'redux_selector', framework: 'redux-toolkit' }),
        expect.objectContaining({ label: 'store', node_kind: 'store', framework_role: 'redux_store', framework: 'redux-toolkit' }),
      ]),
    )

    const sliceNodeId = nodeIdForLabel(result, 'auth slice')
    const storeNodeId = nodeIdForLabel(result, 'store')

    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: sliceNodeId, target: nodeIdForLabel(result, 'loginSucceeded'), relation: 'defines_action' }),
        expect.objectContaining({ source: sliceNodeId, target: nodeIdForLabel(result, 'logout'), relation: 'defines_action' }),
        expect.objectContaining({ source: sliceNodeId, target: nodeIdForLabel(result, 'selectToken'), relation: 'defines_selector' }),
        expect.objectContaining({ source: sliceNodeId, target: nodeIdForLabel(result, 'selectStatus'), relation: 'defines_selector' }),
        expect.objectContaining({ source: sliceNodeId, target: storeNodeId, relation: 'registered_in_store' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'fetchProfile'), target: sliceNodeId, relation: 'updates_slice' }),
      ]),
    )
    expect(graph.nodeAttributes(sliceNodeId)).toEqual(
      expect.objectContaining({
        label: 'auth slice',
        node_kind: 'slice',
      }),
    )
    expect(graph.uniqueEdgeBetween(sliceNodeId, storeNodeId).attributes).toEqual(
      expect.objectContaining({
        relation: 'registered_in_store',
      }),
    )
  })

  it('extracts redux store registration through aliased reducer object variables', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-redux-reducer-alias.ts')
    const sourceText = [
      "import { createSlice, configureStore } from '@reduxjs/toolkit'",
      '',
      'const authSlice = createSlice({',
      "  name: 'auth',",
      '  initialState: { token: null as string | null },',
      '  reducers: {},',
      '})',
      '',
      'const reducer = {',
      '  auth: authSlice.reducer,',
      '}',
      '',
      'export const store = configureStore({ reducer })',
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-redux-reducer-alias', ['authSlice', 'store', 'reducer'])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'auth slice', node_kind: 'slice', framework_role: 'redux_slice', framework: 'redux-toolkit' }),
        expect.objectContaining({ label: 'store', node_kind: 'store', framework_role: 'redux_store', framework: 'redux-toolkit' }),
      ]),
    )
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: nodeIdForLabel(result, 'auth slice'), target: nodeIdForLabel(result, 'store'), relation: 'registered_in_store' }),
      ]),
    )
  })

  it('keeps redux reducer alias resolution scoped to the store declaration context', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-redux-reducer-shadowing.ts')
    const sourceText = [
      "import { createSlice, configureStore } from '@reduxjs/toolkit'",
      '',
      'const authSlice = createSlice({',
      "  name: 'auth',",
      '  initialState: { token: null as string | null },',
      '  reducers: {},',
      '})',
      '',
      'const reducer = {',
      '  auth: authSlice.reducer,',
      '}',
      '',
      'function shadowReducer() {',
      '  const reducer = {',
      '    wrong: null,',
      '  }',
      '  return reducer',
      '}',
      '',
      'shadowReducer()',
      'export const store = configureStore({ reducer })',
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-redux-reducer-shadowing', ['authSlice', 'shadowReducer', 'store', 'reducer'])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))

    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: nodeIdForLabel(result, 'auth slice'), target: nodeIdForLabel(result, 'store'), relation: 'registered_in_store' }),
      ]),
    )
  })

  it('extracts aliased redux toolkit helpers without classifying same-named local helpers', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-redux-aliased.ts')
    const sourceText = [
      "import { createAction as makeAction, createAsyncThunk as makeThunk, createSlice as makeSlice, configureStore as makeStore } from '@reduxjs/toolkit'",
      '',
      'const createAction = (type: string) => ({ type })',
      'const createAsyncThunk = (_type: string, factory: () => Promise<unknown>) => factory',
      'const createSlice = <T,>(value: T) => value',
      'const configureStore = <T,>(value: T) => value',
      '',
      "const ignoredAction = createAction('ignored/localAction')",
      "const ignoredThunk = createAsyncThunk('ignored/localThunk', async () => null)",
      "const ignoredSlice = createSlice({ name: 'ignored' })",
      'const ignoredStore = configureStore({ reducer: {} })',
      '',
      "const fetchProfile = makeThunk('auth/fetchProfile', async () => ({ id: '1' }))",
      "const resetAuth = makeAction('auth/reset')",
      'const authSlice = makeSlice({',
      "  name: 'auth',",
      '  initialState: { status: \'idle\' as \'idle\' | \'ready\' },',
      '  reducers: {',
      '    loginSucceeded(state) {',
      "      state.status = 'ready'",
      '    },',
      '  },',
      '  extraReducers: (builder) => {',
      '    builder.addCase(fetchProfile.fulfilled, (state) => {',
      "      state.status = 'ready'",
      '    })',
      '    builder.addCase(resetAuth, (state) => {',
      "      state.status = 'idle'",
      '    })',
      '  },',
      '})',
      '',
      'export const store = makeStore({',
      '  reducer: {',
      '    auth: authSlice.reducer,',
      '  },',
      '})',
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-redux-aliased', [
      'createAction',
      'createAsyncThunk',
      'createSlice',
      'configureStore',
      'ignoredAction',
      'ignoredThunk',
      'ignoredSlice',
      'ignoredStore',
      'fetchProfile',
      'resetAuth',
      'authSlice',
      'loginSucceeded',
      'store',
    ])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))
    const authSliceNodeId = nodeIdForLabel(result, 'auth slice')
    const storeNodeId = nodeIdForLabel(result, 'store')

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'auth slice', framework_role: 'redux_slice', framework: 'redux-toolkit' }),
        expect.objectContaining({ label: 'fetchProfile', framework_role: 'redux_thunk', framework: 'redux-toolkit' }),
        expect.objectContaining({ label: 'resetAuth', framework_role: 'redux_action', framework: 'redux-toolkit' }),
        expect.objectContaining({ label: 'loginSucceeded', framework_role: 'redux_action', framework: 'redux-toolkit' }),
        expect.objectContaining({ label: 'store', framework_role: 'redux_store', framework: 'redux-toolkit' }),
      ]),
    )
    expect(result.nodes.find((node) => node.label === 'ignored slice')).toBeUndefined()
    expect(result.nodes.find((node) => node.label === 'ignoredAction' && node.framework === 'redux-toolkit')).toBeUndefined()
    expect(result.nodes.find((node) => node.label === 'ignoredThunk' && node.framework === 'redux-toolkit')).toBeUndefined()
    expect(result.nodes.find((node) => node.label === 'ignoredStore' && node.framework === 'redux-toolkit')).toBeUndefined()
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: authSliceNodeId, target: nodeIdForLabel(result, 'loginSucceeded'), relation: 'defines_action' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'fetchProfile'), target: authSliceNodeId, relation: 'updates_slice' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'resetAuth'), target: authSliceNodeId, relation: 'updates_slice' }),
        expect.objectContaining({ source: authSliceNodeId, target: storeNodeId, relation: 'registered_in_store' }),
      ]),
    )
  })

  it('extracts react router object routes with nested loaders, actions, and component mappings', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-react-router-object.tsx')
    const sourceText = [
      "import { createBrowserRouter } from 'react-router-dom'",
      '',
      'function RootLayout() {',
      '  return null',
      '}',
      '',
      'function DashboardPage() {',
      '  return null',
      '}',
      '',
      'function SettingsPage() {',
      '  return null',
      '}',
      '',
      'function settingsLoader() {',
      '  return null',
      '}',
      '',
      'function settingsAction() {',
      '  return null',
      '}',
      '',
      'export const router = createBrowserRouter([',
      '  {',
      "    path: '/',",
      '    Component: RootLayout,',
      '    children: [',
      '      {',
      '        index: true,',
      '        element: <DashboardPage />,',
      '      },',
      '      {',
      "        path: 'settings',",
      '        loader: settingsLoader,',
      '        action: settingsAction,',
      '        Component: SettingsPage,',
      '      },',
      '    ],',
      '  },',
      '])',
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-react-router-object', [
      'RootLayout',
      'DashboardPage',
      'SettingsPage',
      'settingsLoader',
      'settingsAction',
      'router',
    ])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '/', node_kind: 'route', route_path: '/', framework_role: 'react_router_route', framework: 'react-router' }),
        expect.objectContaining({ label: '/ (index)', node_kind: 'route', route_path: '/', framework_role: 'react_router_route', framework: 'react-router' }),
        expect.objectContaining({ label: '/settings', node_kind: 'route', route_path: '/settings', framework_role: 'react_router_route', framework: 'react-router' }),
      ]),
    )

    const rootRouteId = nodeIdForLabel(result, '/')
    const indexRouteId = nodeIdForLabel(result, '/ (index)')
    const settingsRouteId = nodeIdForLabel(result, '/settings')

    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: nodeIdForLabel(result, 'router'), target: rootRouteId, relation: 'registers_route' }),
        expect.objectContaining({ source: rootRouteId, target: nodeIdForLabel(result, 'RootLayout'), relation: 'renders' }),
        expect.objectContaining({ source: indexRouteId, target: nodeIdForLabel(result, 'DashboardPage'), relation: 'renders' }),
        expect.objectContaining({ source: settingsRouteId, target: nodeIdForLabel(result, 'SettingsPage'), relation: 'renders' }),
        expect.objectContaining({ source: settingsRouteId, target: nodeIdForLabel(result, 'settingsLoader'), relation: 'loads_route' }),
        expect.objectContaining({ source: settingsRouteId, target: nodeIdForLabel(result, 'settingsAction'), relation: 'submits_route' }),
        expect.objectContaining({ source: rootRouteId, target: indexRouteId, relation: 'contains' }),
        expect.objectContaining({ source: rootRouteId, target: settingsRouteId, relation: 'contains' }),
      ]),
    )
  })

  it('extracts react router jsx route declarations and outlet layouts', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-react-router-jsx.tsx')
    const sourceText = [
      "import { Outlet, Route, createBrowserRouter, createRoutesFromElements } from 'react-router-dom'",
      '',
      'function AppLayout() {',
      '  return <Outlet />',
      '}',
      '',
      'function HomePage() {',
      '  return null',
      '}',
      '',
      'function SettingsPage() {',
      '  return null',
      '}',
      '',
      'function settingsLoader() {',
      '  return null',
      '}',
      '',
      'function settingsAction() {',
      '  return null',
      '}',
      '',
      'export const router = createBrowserRouter(',
      '  createRoutesFromElements(',
      '    <Route path="/" element={<AppLayout />}>',
      '      <Route index element={<HomePage />} />',
      '      <Route path="settings" loader={settingsLoader} action={settingsAction} Component={SettingsPage} />',
      '    </Route>,',
      '  ),',
      ')',
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-react-router-jsx', [
      'AppLayout',
      'HomePage',
      'SettingsPage',
      'settingsLoader',
      'settingsAction',
      'router',
    ])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '/', node_kind: 'route', route_path: '/', framework_role: 'react_router_route', framework: 'react-router' }),
        expect.objectContaining({ label: '/ (index)', node_kind: 'route', route_path: '/', framework_role: 'react_router_route', framework: 'react-router' }),
        expect.objectContaining({ label: '/settings', node_kind: 'route', route_path: '/settings', framework_role: 'react_router_route', framework: 'react-router' }),
      ]),
    )

    const rootRouteId = nodeIdForLabel(result, '/')
    const settingsRouteId = nodeIdForLabel(result, '/settings')

    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: rootRouteId, target: nodeIdForLabel(result, 'AppLayout'), relation: 'renders' }),
        expect.objectContaining({ source: nodeIdForLabel(result, '/ (index)'), target: nodeIdForLabel(result, 'HomePage'), relation: 'renders' }),
        expect.objectContaining({ source: settingsRouteId, target: nodeIdForLabel(result, 'SettingsPage'), relation: 'renders' }),
        expect.objectContaining({ source: settingsRouteId, target: nodeIdForLabel(result, 'settingsLoader'), relation: 'loads_route' }),
        expect.objectContaining({ source: settingsRouteId, target: nodeIdForLabel(result, 'settingsAction'), relation: 'submits_route' }),
      ]),
    )
  })

  it('extracts plain react router jsx route trees rendered through Routes components', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-react-router-routes-component.tsx')
    const sourceText = [
      "import { Route, Routes } from 'react-router-dom'",
      '',
      'function HomePage() {',
      '  return null',
      '}',
      '',
      'function SettingsPage() {',
      '  return null',
      '}',
      '',
      'function settingsLoader() {',
      '  return null',
      '}',
      '',
      'function settingsAction() {',
      '  return null',
      '}',
      '',
      'export function AppRoutes() {',
      '  return (',
      '    <Routes>',
      '      <Route path="/" element={<HomePage />} />',
      '      <Route path="/settings" loader={settingsLoader} action={settingsAction} Component={SettingsPage} />',
      '    </Routes>',
      '  )',
      '}',
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-react-router-routes-component', [
      'HomePage',
      'SettingsPage',
      'settingsLoader',
      'settingsAction',
      'AppRoutes',
    ])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '/', node_kind: 'route', route_path: '/', framework_role: 'react_router_route', framework: 'react-router' }),
        expect.objectContaining({ label: '/settings', node_kind: 'route', route_path: '/settings', framework_role: 'react_router_route', framework: 'react-router' }),
      ]),
    )
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: nodeIdForLabel(result, 'AppRoutes'), target: nodeIdForLabel(result, '/'), relation: 'registers_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'AppRoutes'), target: nodeIdForLabel(result, '/settings'), relation: 'registers_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, '/'), target: nodeIdForLabel(result, 'HomePage'), relation: 'renders' }),
        expect.objectContaining({ source: nodeIdForLabel(result, '/settings'), target: nodeIdForLabel(result, 'SettingsPage'), relation: 'renders' }),
        expect.objectContaining({ source: nodeIdForLabel(result, '/settings'), target: nodeIdForLabel(result, 'settingsLoader'), relation: 'loads_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, '/settings'), target: nodeIdForLabel(result, 'settingsAction'), relation: 'submits_route' }),
      ]),
    )
  })

  it('extracts react router useRoutes object trees from component hooks', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-react-router-use-routes.tsx')
    const sourceText = [
      "import { useRoutes } from 'react-router-dom'",
      '',
      'function DashboardPage() {',
      '  return null',
      '}',
      '',
      'function SettingsPage() {',
      '  return null',
      '}',
      '',
      'function settingsLoader() {',
      '  return null',
      '}',
      '',
      'export function AppRoutes() {',
      '  return useRoutes([',
      '    {',
      "      path: '/',",
      '      Component: DashboardPage,',
      '    },',
      '    {',
      "      path: '/settings',",
      '      loader: settingsLoader,',
      '      Component: SettingsPage,',
      '    },',
      '  ])',
      '}',
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-react-router-use-routes', [
      'DashboardPage',
      'SettingsPage',
      'settingsLoader',
      'AppRoutes',
    ])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '/', node_kind: 'route', route_path: '/', framework_role: 'react_router_route', framework: 'react-router' }),
        expect.objectContaining({ label: '/settings', node_kind: 'route', route_path: '/settings', framework_role: 'react_router_route', framework: 'react-router' }),
      ]),
    )
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: nodeIdForLabel(result, 'AppRoutes'), target: nodeIdForLabel(result, '/'), relation: 'registers_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'AppRoutes'), target: nodeIdForLabel(result, '/settings'), relation: 'registers_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, '/'), target: nodeIdForLabel(result, 'DashboardPage'), relation: 'renders' }),
        expect.objectContaining({ source: nodeIdForLabel(result, '/settings'), target: nodeIdForLabel(result, 'SettingsPage'), relation: 'renders' }),
        expect.objectContaining({ source: nodeIdForLabel(result, '/settings'), target: nodeIdForLabel(result, 'settingsLoader'), relation: 'loads_route' }),
      ]),
    )
  })

  it('extracts react router routes from default exported routers', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-react-router-default-export.tsx')
    const sourceText = [
      "import { createBrowserRouter } from 'react-router-dom'",
      '',
      'function HomePage() {',
      '  return null',
      '}',
      '',
      'function SettingsPage() {',
      '  return null',
      '}',
      '',
      'export default createBrowserRouter([',
      '  {',
      "    path: '/',",
      '    Component: HomePage,',
      '  },',
      '  {',
      "    path: '/settings',",
      '    Component: SettingsPage,',
      '  },',
      '])',
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-react-router-default-export', [
      'HomePage',
      'SettingsPage',
    ])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'default', node_kind: 'router', framework_role: 'react_router', framework: 'react-router' }),
        expect.objectContaining({ label: '/', node_kind: 'route', route_path: '/', framework_role: 'react_router_route', framework: 'react-router' }),
        expect.objectContaining({ label: '/settings', node_kind: 'route', route_path: '/settings', framework_role: 'react_router_route', framework: 'react-router' }),
      ]),
    )
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: nodeIdForLabel(result, 'default'), target: nodeIdForLabel(result, '/'), relation: 'registers_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'default'), target: nodeIdForLabel(result, '/settings'), relation: 'registers_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, '/'), target: nodeIdForLabel(result, 'HomePage'), relation: 'renders' }),
        expect.objectContaining({ source: nodeIdForLabel(result, '/settings'), target: nodeIdForLabel(result, 'SettingsPage'), relation: 'renders' }),
      ]),
    )
  })

  it('keeps react router route alias resolution scoped to the hook call context', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-react-router-shadowed-routes.tsx')
    const sourceText = [
      "import { useRoutes } from 'react-router-dom'",
      '',
      'function HomePage() {',
      '  return null',
      '}',
      '',
      'const routes = [',
      '  {',
      "    path: '/',",
      '    Component: HomePage,',
      '  },',
      ']',
      '',
      'function shadowRoutes() {',
      '  const routes = []',
      '  return routes',
      '}',
      '',
      'shadowRoutes()',
      '',
      'export function AppRoutes() {',
      '  return useRoutes(routes)',
      '}',
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-react-router-shadowed-routes', ['HomePage', 'shadowRoutes', 'AppRoutes', 'routes'])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '/', node_kind: 'route', route_path: '/', framework_role: 'react_router_route', framework: 'react-router' }),
      ]),
    )
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: nodeIdForLabel(result, 'AppRoutes'), target: nodeIdForLabel(result, '/'), relation: 'registers_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, '/'), target: nodeIdForLabel(result, 'HomePage'), relation: 'renders' }),
      ]),
    )
  })

  it('extracts react router namespace and aliased bindings without classifying local Route components', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-react-router-aliased.tsx')
    const sourceText = [
      "import * as ReactRouter from 'react-router-dom'",
      "import { Route as RouterRoute } from 'react-router-dom'",
      '',
      'function AppLayout() {',
      '  return null',
      '}',
      '',
      'function AccountPage() {',
      '  return null',
      '}',
      '',
      'function Route(_props: { children?: unknown }) {',
      '  return null',
      '}',
      '',
      'export const router = ReactRouter.createBrowserRouter(',
      '  ReactRouter.createRoutesFromElements(',
      '    <>',
      '      <Route>',
      '        <span>ignore local route component</span>',
      '      </Route>',
      '      <RouterRoute path="/" Component={AppLayout}>',
      '        <ReactRouter.Route path="account" Component={AccountPage} />',
      '      </RouterRoute>',
      '    </>,',
      '  ),',
      ')',
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-react-router-aliased', ['AppLayout', 'AccountPage', 'Route', 'router'])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '/', node_kind: 'route', route_path: '/', framework_role: 'react_router_route', framework: 'react-router' }),
        expect.objectContaining({ label: '/account', node_kind: 'route', route_path: '/account', framework_role: 'react_router_route', framework: 'react-router' }),
      ]),
    )
    expect(result.nodes.filter((node) => node.framework_role === 'react_router_route')).toHaveLength(2)
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: nodeIdForLabel(result, 'router'), target: nodeIdForLabel(result, '/'), relation: 'registers_route' }),
        expect.objectContaining({ source: nodeIdForLabel(result, '/'), target: nodeIdForLabel(result, 'AppLayout'), relation: 'renders' }),
        expect.objectContaining({ source: nodeIdForLabel(result, '/account'), target: nodeIdForLabel(result, 'AccountPage'), relation: 'renders' }),
        expect.objectContaining({ source: nodeIdForLabel(result, '/'), target: nodeIdForLabel(result, '/account'), relation: 'contains' }),
      ]),
    )
    expect(result.edges.find((edge) => edge.target === nodeIdForLabel(result, 'Route') && edge.relation === 'renders')).toBeUndefined()
  })

  it('does not extract react router semantics from same-named local helpers without router imports', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-react-router-local-collision.tsx')
    const sourceText = [
      'const createBrowserRouter = <T,>(value: T) => value',
      'const createRoutesFromElements = <T,>(value: T) => value',
      '',
      'function Route(_props: { path?: string; children?: unknown }) {',
      '  return null',
      '}',
      '',
      'export const router = createBrowserRouter(',
      '  createRoutesFromElements(',
      '    <Route path="/">',
      '      <Route path="settings" />',
      '    </Route>,',
      '  ),',
      ')',
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-react-router-local-collision', [
      'createBrowserRouter',
      'createRoutesFromElements',
      'Route',
      'router',
    ])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))

    expect(result.nodes.filter((node) => node.framework === 'react-router')).toHaveLength(0)
    expect(result.edges.filter((edge) => ['registers_route', 'contains', 'renders', 'loads_route', 'submits_route'].includes(edge.relation))).toHaveLength(0)
  })

  it('represents pathless react router layout routes distinctly from real root routes', () => {
    const filePath = join(FIXTURES_DIR, 'virtual-react-router-pathless-layout.tsx')
    const sourceText = [
      "import { createBrowserRouter } from 'react-router-dom'",
      '',
      'function RootLayout() {',
      '  return null',
      '}',
      '',
      'function AuthLayout() {',
      '  return null',
      '}',
      '',
      'function LoginPage() {',
      '  return null',
      '}',
      '',
      'export const router = createBrowserRouter([{',
      "  path: '/',",
      '  Component: RootLayout,',
      '  children: [',
      '    {',
      '      Component: AuthLayout,',
      '      children: [',
      '        {',
      "          path: 'login',",
      '          Component: LoginPage,',
      '        },',
      '      ],',
      '    },',
      '  ],',
      '}])',
    ].join('\n')
    const baseExtraction = createBaseExtraction(filePath, 'virtual-react-router-pathless-layout', [
      'RootLayout',
      'AuthLayout',
      'LoginPage',
      'router',
    ])

    const result = applyJsFrameworkAdapters(baseExtraction, createFrameworkContext(filePath, sourceText, baseExtraction))
    const rootRouteId = nodeIdForLabel(result, '/')
    const layoutRoute = result.nodes.find((node) => node.label === '/ (layout)')

    expect(result.nodes.filter((node) => node.label === '/')).toHaveLength(1)
    expect(layoutRoute).toEqual(
      expect.objectContaining({
        label: '/ (layout)',
        node_kind: 'route',
        framework: 'react-router',
        framework_role: 'react_router_layout',
      }),
    )
    expect(layoutRoute?.route_path).toBeUndefined()
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '/login', node_kind: 'route', route_path: '/login', framework_role: 'react_router_route' }),
      ]),
    )
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: nodeIdForLabel(result, 'router'), target: rootRouteId, relation: 'registers_route' }),
        expect.objectContaining({ source: rootRouteId, target: nodeIdForLabel(result, 'RootLayout'), relation: 'renders' }),
        expect.objectContaining({ source: rootRouteId, target: layoutRoute?.id, relation: 'contains' }),
        expect.objectContaining({ source: layoutRoute?.id, target: nodeIdForLabel(result, 'AuthLayout'), relation: 'renders' }),
        expect.objectContaining({ source: layoutRoute?.id, target: nodeIdForLabel(result, '/login'), relation: 'contains' }),
        expect.objectContaining({ source: nodeIdForLabel(result, '/login'), target: nodeIdForLabel(result, 'LoginPage'), relation: 'renders' }),
      ]),
    )
  })

  it('resolves redux slices registered in stores across files', () => {
    const sliceFilePath = join(FIXTURES_DIR, 'redux-cross-file-slice.ts')
    const storeFilePath = join(FIXTURES_DIR, 'redux-cross-file-store.ts')

    const sliceResult = extractJs(sliceFilePath)
    const storeResult = extractJs(storeFilePath)
    const graph = buildGraph([sliceResult, storeResult])

    const sliceNodeId = nodeIdForLabel(sliceResult, 'auth slice')
    const storeNodeId = nodeIdForLabel(storeResult, 'store')

    expect(storeResult.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: sliceNodeId, label: 'auth slice', source_file: sliceFilePath, framework_role: 'redux_slice' }),
      ]),
    )
    expect(storeResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: sliceNodeId, target: storeNodeId, relation: 'registered_in_store' }),
      ]),
    )
    expect(graph.uniqueEdgeBetween(sliceNodeId, storeNodeId).attributes).toEqual(
      expect.objectContaining({
        relation: 'registered_in_store',
      }),
    )
  })

  it('re-analyzes imported redux slices on later extraction runs instead of reusing stale module cache', () => {
    const scratchDir = join(TEST_ARTIFACTS_DIR, 'redux-cache-freshness')
    const sliceFilePath = join(scratchDir, 'slice.ts')
    const storeFilePath = join(scratchDir, 'store.ts')

    try {
      writeScratchFiles(scratchDir, {
        'slice.ts': [
          "import { createSlice } from '@reduxjs/toolkit'",
          '',
          'const authSlice = createSlice({',
          "  name: 'auth',",
          '  initialState: { token: null as string | null },',
          '  reducers: {},',
          '})',
          '',
          'export default authSlice.reducer',
        ].join('\n'),
        'store.ts': [
          "import { configureStore } from '@reduxjs/toolkit'",
          "import authReducer from './slice'",
          '',
          'export const store = configureStore({',
          '  reducer: {',
          '    auth: authReducer,',
          '  },',
          '})',
        ].join('\n'),
      })

      const initialStoreResult = extractJs(storeFilePath)
      expect(initialStoreResult.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'auth slice' })]))

      writeScratchFiles(scratchDir, {
        'slice.ts': [
          "import { createSlice } from '@reduxjs/toolkit'",
          '',
          'const sessionSlice = createSlice({',
          "  name: 'session',",
          '  initialState: { token: null as string | null },',
          '  reducers: {},',
          '})',
          '',
          'export default sessionSlice.reducer',
        ].join('\n'),
      })

      const updatedStoreResult = extractJs(storeFilePath)
      expect(updatedStoreResult.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'session slice' })]))
      expect(updatedStoreResult.nodes.find((node) => node.label === 'auth slice')).toBeUndefined()
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('resolves redux slices registered in stores across files when reducers are default exported', () => {
    const sliceFilePath = join(FIXTURES_DIR, 'redux-cross-file-default-slice.ts')
    const storeFilePath = join(FIXTURES_DIR, 'redux-cross-file-default-store.ts')

    const sliceResult = extractJs(sliceFilePath)
    const storeResult = extractJs(storeFilePath)
    const graph = buildGraph([sliceResult, storeResult])

    const sliceNodeId = nodeIdForLabel(sliceResult, 'auth slice')
    const storeNodeId = nodeIdForLabel(storeResult, 'store')

    expect(storeResult.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: sliceNodeId, label: 'auth slice', source_file: sliceFilePath, framework_role: 'redux_slice' }),
      ]),
    )
    expect(storeResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: sliceNodeId, target: storeNodeId, relation: 'registered_in_store' }),
      ]),
    )
    expect(graph.uniqueEdgeBetween(sliceNodeId, storeNodeId).attributes).toEqual(
      expect.objectContaining({
        relation: 'registered_in_store',
      }),
    )
  })

  it('only marks createAsyncThunk addCase targets as redux thunks', () => {
    const filePath = join(FIXTURES_DIR, 'redux-cross-file-slice.ts')
    const result = extractJs(filePath)
    const sliceNodeId = nodeIdForLabel(result, 'auth slice')

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'fetchProfile', framework_role: 'redux_thunk', framework: 'redux-toolkit' }),
        expect.objectContaining({ label: 'refreshProfile', framework_role: 'redux_action', framework: 'redux-toolkit' }),
      ]),
    )
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: nodeIdForLabel(result, 'fetchProfile'), target: sliceNodeId, relation: 'updates_slice' }),
        expect.objectContaining({ source: nodeIdForLabel(result, 'refreshProfile'), target: sliceNodeId, relation: 'updates_slice' }),
      ]),
    )
  })

  it('resolves slice.actions addCase targets for local slices and imported slice aliases', () => {
    const sliceFilePath = join(FIXTURES_DIR, 'redux-cross-file-default-slice.ts')
    const consumerFilePath = join(FIXTURES_DIR, 'redux-cross-file-slice-actions-consumer.ts')

    const sliceResult = extractJs(sliceFilePath)
    const consumerResult = extractJs(consumerFilePath)

    const logoutActionNodeId = nodeIdForLabel(sliceResult, 'logout')
    const auditSliceNodeId = nodeIdForLabel(sliceResult, 'audit slice')
    const sessionSliceNodeId = nodeIdForLabel(consumerResult, 'session slice')

    expect(sliceResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: logoutActionNodeId, target: auditSliceNodeId, relation: 'updates_slice' }),
      ]),
    )
    expect(consumerResult.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: logoutActionNodeId,
          label: 'logout',
          source_file: sliceFilePath,
          source_location: sliceResult.nodes.find((node) => node.id === logoutActionNodeId)?.source_location,
          framework_role: 'redux_action',
        }),
      ]),
    )
    expect(consumerResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: logoutActionNodeId, target: sessionSliceNodeId, relation: 'updates_slice' }),
      ]),
    )
  })

  it('rejects relative framework imports that resolve outside the workspace root', () => {
    const scratchDir = join(TEST_ARTIFACTS_DIR, 'import-path-escape')
    const filePath = join(scratchDir, 'nested', 'router.tsx')
    const escapedFilePath = join(process.cwd(), '..', 'framework-import-escape-target.ts')

    try {
      writeScratchFiles(scratchDir, {
        'nested/router.tsx': 'export const router = null\n',
      })
      writeFileSync(escapedFilePath, 'export const escaped = true\n', 'utf8')

      const specifier = relative(dirname(filePath), escapedFilePath).replaceAll('\\', '/')

      expect(resolveImportPath(filePath, specifier)).toBeNull()
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
      rmSync(escapedFilePath, { force: true })
    }
  })

  it('resolves redux bindings through wildcard barrel re-exports', () => {
    const scratchDir = join(TEST_ARTIFACTS_DIR, 'redux-barrel-reexports')
    const sliceFilePath = join(scratchDir, 'slice.ts')
    const consumerFilePath = join(scratchDir, 'consumer.ts')

    try {
      writeScratchFiles(scratchDir, {
        'slice.ts': [
          "import { createSlice } from '@reduxjs/toolkit'",
          '',
          'const authSlice = createSlice({',
          "  name: 'auth',",
          "  initialState: { status: 'idle' as 'idle' | 'ready' },",
          '  reducers: {',
          '    logout(state) {',
          "      state.status = 'idle'",
          '    },',
          '  },',
          '})',
          '',
          'export const { logout } = authSlice.actions',
        ].join('\n'),
        'index.ts': "export * from './slice'\n",
        'consumer.ts': [
          "import { createSlice } from '@reduxjs/toolkit'",
          "import { logout } from './index'",
          '',
          'const sessionSlice = createSlice({',
          "  name: 'session',",
          "  initialState: { status: 'idle' as 'idle' | 'ready' },",
          '  reducers: {},',
          '  extraReducers: (builder) => {',
          '    builder.addCase(logout, (state) => {',
          "      state.status = 'idle'",
          '    })',
          '  },',
          '})',
          '',
          'export { sessionSlice }',
        ].join('\n'),
      })

      const sliceResult = extractJs(sliceFilePath)
      const consumerResult = extractJs(consumerFilePath)
      const logoutNodeId = nodeIdForLabel(sliceResult, 'logout')
      const sessionSliceNodeId = nodeIdForLabel(consumerResult, 'session slice')

      expect(consumerResult.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: logoutNodeId, label: 'logout', source_file: sliceFilePath, framework_role: 'redux_action' }),
        ]),
      )
      expect(consumerResult.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: logoutNodeId, target: sessionSliceNodeId, relation: 'updates_slice' }),
        ]),
      )
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('resolves imported react router modules to their source-file symbols', () => {
    const moduleFilePath = join(FIXTURES_DIR, 'react-router-imported-module.tsx')
    const routerFilePath = join(FIXTURES_DIR, 'react-router-imported-router.tsx')

    const routerResult = extractJs(routerFilePath)
    const settingsRouteId = nodeIdForLabel(routerResult, '/settings')
    const settingsPageNode = routerResult.nodes.find(
      (node) => node.label === 'SettingsPage()' && node.source_file === moduleFilePath && node.framework_role === 'react_router_component',
    )
    const settingsLoaderNode = routerResult.nodes.find(
      (node) => node.label === 'settingsLoader()' && node.source_file === moduleFilePath && node.framework_role === 'react_router_loader',
    )
    const settingsActionNode = routerResult.nodes.find(
      (node) => node.label === 'settingsAction()' && node.source_file === moduleFilePath && node.framework_role === 'react_router_action',
    )

    expect(settingsPageNode).toEqual(expect.objectContaining({ label: 'SettingsPage()', source_file: moduleFilePath }))
    expect(settingsLoaderNode).toEqual(expect.objectContaining({ label: 'settingsLoader()', source_file: moduleFilePath }))
    expect(settingsActionNode).toEqual(expect.objectContaining({ label: 'settingsAction()', source_file: moduleFilePath }))
    expect(routerResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: settingsRouteId, target: settingsPageNode?.id, relation: 'renders' }),
        expect.objectContaining({ source: settingsRouteId, target: settingsLoaderNode?.id, relation: 'loads_route' }),
        expect.objectContaining({ source: settingsRouteId, target: settingsActionNode?.id, relation: 'submits_route' }),
      ]),
    )
  })

  it('resolves react router route modules through wildcard barrel re-exports', () => {
    const scratchDir = join(TEST_ARTIFACTS_DIR, 'react-router-barrel-reexports')
    const routeModuleFilePath = join(scratchDir, 'route-module.tsx')
    const routerFilePath = join(scratchDir, 'router.tsx')

    try {
      writeScratchFiles(scratchDir, {
        'route-module.tsx': [
          'export function SettingsPage() {',
          '  return null',
          '}',
          'export async function settingsLoader() {',
          '  return null',
          '}',
          'export async function settingsAction() {',
          '  return null',
          '}',
        ].join('\n'),
        'index.ts': "export * from './route-module'\n",
        'router.tsx': [
          "import { createBrowserRouter } from 'react-router-dom'",
          "import { SettingsPage, settingsLoader, settingsAction } from './index'",
          '',
          'export const router = createBrowserRouter([{',
          "  path: '/settings',",
          '  Component: SettingsPage,',
          '  loader: settingsLoader,',
          '  action: settingsAction,',
          '}])',
        ].join('\n'),
      })

      const routerResult = extractJs(routerFilePath)
      const settingsRouteId = nodeIdForLabel(routerResult, '/settings')
      const settingsPageNode = routerResult.nodes.find(
        (node) => node.label === 'SettingsPage()' && node.source_file === routeModuleFilePath && node.framework_role === 'react_router_component',
      )
      const settingsLoaderNode = routerResult.nodes.find(
        (node) => node.label === 'settingsLoader()' && node.source_file === routeModuleFilePath && node.framework_role === 'react_router_loader',
      )
      const settingsActionNode = routerResult.nodes.find(
        (node) => node.label === 'settingsAction()' && node.source_file === routeModuleFilePath && node.framework_role === 'react_router_action',
      )

      expect(settingsPageNode).toEqual(expect.objectContaining({ label: 'SettingsPage()', source_file: routeModuleFilePath }))
      expect(settingsLoaderNode).toEqual(expect.objectContaining({ label: 'settingsLoader()', source_file: routeModuleFilePath }))
      expect(settingsActionNode).toEqual(expect.objectContaining({ label: 'settingsAction()', source_file: routeModuleFilePath }))
      expect(routerResult.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: settingsRouteId, target: settingsPageNode?.id, relation: 'renders' }),
          expect.objectContaining({ source: settingsRouteId, target: settingsLoaderNode?.id, relation: 'loads_route' }),
          expect.objectContaining({ source: settingsRouteId, target: settingsActionNode?.id, relation: 'submits_route' }),
        ]),
      )
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('re-analyzes imported react router modules between runs and labels anonymous default exports with the local alias', () => {
    const scratchDir = join(TEST_ARTIFACTS_DIR, 'react-router-cache-freshness')
    const moduleFilePath = join(scratchDir, 'page.tsx')
    const routerFilePath = join(scratchDir, 'router.tsx')

    try {
      writeScratchFiles(scratchDir, {
        'page.tsx': [
          'export default () => null',
          'export const settingsLoader = async () => null',
        ].join('\n'),
        'router.tsx': [
          "import { createBrowserRouter } from 'react-router-dom'",
          "import SettingsPage, { settingsLoader } from './page'",
          '',
          'export const router = createBrowserRouter([{',
          "  path: '/settings',",
          '  Component: SettingsPage,',
          '  loader: settingsLoader,',
          '}])',
        ].join('\n'),
      })

      const initialRouterResult = extractJs(routerFilePath)
      expect(initialRouterResult.nodes).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: 'SettingsPage()', source_file: moduleFilePath })]),
      )

      writeScratchFiles(scratchDir, {
        'page.tsx': [
          'export default function AccountPage() {',
          '  return null',
          '}',
          'export const settingsLoader = async () => null',
        ].join('\n'),
      })

      const updatedRouterResult = extractJs(routerFilePath)
      expect(updatedRouterResult.nodes).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: 'AccountPage()', source_file: moduleFilePath })]),
      )
      expect(updatedRouterResult.nodes.find((node) => node.label === 'SettingsPage()' && node.source_file === moduleFilePath)).toBeUndefined()
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('keeps imported react router references distinct for same-named source modules', () => {
    const adminModuleFilePath = join(FIXTURES_DIR, 'react-router-colliding-routes', 'admin', 'index.tsx')
    const settingsModuleFilePath = join(FIXTURES_DIR, 'react-router-colliding-routes', 'settings', 'index.tsx')
    const routerFilePath = join(FIXTURES_DIR, 'react-router-colliding-router.tsx')

    const routerResult = extractJs(routerFilePath)

    const adminRouteId = nodeIdForLabel(routerResult, '/admin')
    const settingsRouteId = nodeIdForLabel(routerResult, '/settings')
    const importedNodes = routerResult.nodes.filter((node) =>
      node.framework?.toString() === 'react-router' &&
      (node.source_file === adminModuleFilePath || node.source_file === settingsModuleFilePath),
    )
    const adminPageNode = importedNodes.find((node) => node.label === 'RouteComponent()' && node.source_file === adminModuleFilePath)
    const adminLoaderNode = importedNodes.find((node) => node.label === 'routeLoader()' && node.source_file === adminModuleFilePath)
    const adminActionNode = importedNodes.find((node) => node.label === 'routeAction()' && node.source_file === adminModuleFilePath)
    const settingsPageNode = importedNodes.find((node) => node.label === 'RouteComponent()' && node.source_file === settingsModuleFilePath)
    const settingsLoaderNode = importedNodes.find((node) => node.label === 'routeLoader()' && node.source_file === settingsModuleFilePath)
    const settingsActionNode = importedNodes.find((node) => node.label === 'routeAction()' && node.source_file === settingsModuleFilePath)

    expect(importedNodes).toHaveLength(6)
    expect(new Set(importedNodes.map((node) => node.id)).size).toBe(6)
    expect(routerResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: adminRouteId, target: adminPageNode?.id, relation: 'renders' }),
        expect.objectContaining({ source: adminRouteId, target: adminLoaderNode?.id, relation: 'loads_route' }),
        expect.objectContaining({ source: adminRouteId, target: adminActionNode?.id, relation: 'submits_route' }),
        expect.objectContaining({ source: settingsRouteId, target: settingsPageNode?.id, relation: 'renders' }),
        expect.objectContaining({ source: settingsRouteId, target: settingsLoaderNode?.id, relation: 'loads_route' }),
        expect.objectContaining({ source: settingsRouteId, target: settingsActionNode?.id, relation: 'submits_route' }),
      ]),
    )
  })

  it('exports destructured redux actions and selectors for cross-file resolution', () => {
    const sliceFilePath = join(FIXTURES_DIR, 'redux-destructured-exports.ts')
    const consumerFilePath = join(FIXTURES_DIR, 'redux-destructured-exports-consumer.ts')

    const exportedBindings = inspectReduxModuleExports(sliceFilePath)
    const sliceResult = extractJs(sliceFilePath)
    const consumerResult = extractJs(consumerFilePath)
    const authSliceNodeId = nodeIdForLabel(sliceResult, 'auth slice')
    const sessionSliceNodeId = nodeIdForLabel(consumerResult, 'session slice')
    const logoutNodeId = nodeIdForLabel(sliceResult, 'logout')
    const signInSucceededNodeId = nodeIdForLabel(sliceResult, 'signInSucceeded')
    const selectTokenNodeId = nodeIdForLabel(sliceResult, 'selectToken')
    const selectAuthStatusNodeId = nodeIdForLabel(sliceResult, 'selectAuthStatus')

    expect(exportedBindings.get('logout')).toEqual(
      expect.objectContaining({ id: logoutNodeId, frameworkRole: 'redux_action', sourceFile: sliceFilePath }),
    )
    expect(exportedBindings.get('signInSucceeded')).toEqual(
      expect.objectContaining({ id: signInSucceededNodeId, frameworkRole: 'redux_action', sourceFile: sliceFilePath }),
    )
    expect(exportedBindings.get('selectToken')).toEqual(
      expect.objectContaining({ id: selectTokenNodeId, frameworkRole: 'redux_selector', sourceFile: sliceFilePath }),
    )
    expect(exportedBindings.get('selectAuthStatus')).toEqual(
      expect.objectContaining({ id: selectAuthStatusNodeId, frameworkRole: 'redux_selector', sourceFile: sliceFilePath }),
    )
    expect(consumerResult.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: logoutNodeId, label: 'logout', source_file: sliceFilePath, framework_role: 'redux_action' }),
        expect.objectContaining({ id: signInSucceededNodeId, label: 'signInSucceeded', source_file: sliceFilePath, framework_role: 'redux_action' }),
      ]),
    )
    expect(sliceResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: authSliceNodeId, target: logoutNodeId, relation: 'defines_action' }),
        expect.objectContaining({ source: authSliceNodeId, target: signInSucceededNodeId, relation: 'defines_action' }),
        expect.objectContaining({ source: authSliceNodeId, target: selectTokenNodeId, relation: 'defines_selector' }),
        expect.objectContaining({ source: authSliceNodeId, target: selectAuthStatusNodeId, relation: 'defines_selector' }),
      ]),
    )
    expect(consumerResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: logoutNodeId, target: sessionSliceNodeId, relation: 'updates_slice' }),
        expect.objectContaining({ source: signInSucceededNodeId, target: sessionSliceNodeId, relation: 'updates_slice' }),
      ]),
    )
  })

  it('surfaces imported destructured redux selectors when consumer files call them', () => {
    const sliceFilePath = join(FIXTURES_DIR, 'redux-destructured-exports.ts')
    const consumerFilePath = join(FIXTURES_DIR, 'redux-destructured-selector-consumer.ts')

    const sliceResult = extractJs(sliceFilePath)
    const consumerResult = extractJs(consumerFilePath)
    const readSessionStateNodeId = nodeIdForLabel(consumerResult, 'readSessionState()')
    const selectTokenNodeId = nodeIdForLabel(sliceResult, 'selectToken')
    const selectAuthStatusNodeId = nodeIdForLabel(sliceResult, 'selectAuthStatus')

    expect(consumerResult.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: selectTokenNodeId, label: 'selectToken', source_file: sliceFilePath, framework_role: 'redux_selector' }),
        expect.objectContaining({
          id: selectAuthStatusNodeId,
          label: 'selectAuthStatus',
          source_file: sliceFilePath,
          framework_role: 'redux_selector',
        }),
      ]),
    )
    expect(consumerResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: readSessionStateNodeId, target: selectTokenNodeId, relation: 'uses' }),
        expect.objectContaining({ source: readSessionStateNodeId, target: selectAuthStatusNodeId, relation: 'uses' }),
      ]),
    )
  })

  it('surfaces imported redux selectors passed to selector hooks', () => {
    const scratchDir = join(TEST_ARTIFACTS_DIR, 'redux-selector-hooks')
    const sliceFilePath = join(scratchDir, 'slice.ts')
    const consumerFilePath = join(scratchDir, 'consumer.tsx')

    try {
      writeScratchFiles(scratchDir, {
        'slice.ts': [
          "import { createSlice } from '@reduxjs/toolkit'",
          '',
          'const authSlice = createSlice({',
          "  name: 'auth',",
          '  initialState: { token: null as string | null, status: \'idle\' as \'idle\' | \'ready\' },',
          '  reducers: {},',
          '  selectors: {',
          '    selectToken: (state) => state.token,',
          '    selectAuthStatus: (state) => state.status,',
          '  },',
          '})',
          '',
          'export const { selectToken, selectAuthStatus } = authSlice.selectors',
        ].join('\n'),
        'consumer.tsx': [
          "import { createSlice } from '@reduxjs/toolkit'",
          "import { useSelector } from 'react-redux'",
          "import { selectAuthStatus, selectToken as tokenSelector } from './slice'",
          '',
          'const useAppSelector = useSelector',
          '',
          'export function SessionPanel() {',
          '  const token = useAppSelector(tokenSelector)',
          '  const status = useSelector(selectAuthStatus)',
          '  return token ?? status ?? null',
          '}',
          '',
          'export const sessionSlice = createSlice({',
          "  name: 'session',",
          '  initialState: { ready: false },',
          '  reducers: {},',
          '})',
        ].join('\n'),
      })

      const sliceResult = extractJs(sliceFilePath)
      const consumerResult = extractJs(consumerFilePath)
      const sessionPanelNodeId = consumerResult.nodes.find((node) => ['SessionPanel', 'SessionPanel()', '.SessionPanel()'].includes(node.label))?.id
      const selectTokenNodeId = nodeIdForLabel(sliceResult, 'selectToken')
      const selectAuthStatusNodeId = nodeIdForLabel(sliceResult, 'selectAuthStatus')

      expect(sessionPanelNodeId).toBeDefined()
      expect(consumerResult.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: selectTokenNodeId, label: 'selectToken', source_file: sliceFilePath, framework_role: 'redux_selector' }),
          expect.objectContaining({
            id: selectAuthStatusNodeId,
            label: 'selectAuthStatus',
            source_file: sliceFilePath,
            framework_role: 'redux_selector',
          }),
        ]),
      )
      expect(consumerResult.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: sessionPanelNodeId, target: selectTokenNodeId, relation: 'uses' }),
          expect.objectContaining({ source: sessionPanelNodeId, target: selectAuthStatusNodeId, relation: 'uses' }),
        ]),
      )
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('attributes imported destructured redux selector calls inside object property arrow functions', () => {
    const sliceFilePath = join(FIXTURES_DIR, 'redux-destructured-exports.ts')
    const consumerFilePath = join(FIXTURES_DIR, 'redux-destructured-selector-object-consumer.ts')

    const sliceResult = extractJs(sliceFilePath)
    const consumerResult = extractJs(consumerFilePath)
    const readSessionStateNodeId = consumerResult.nodes.find((node) => ['readSessionState()', '.readSessionState()'].includes(node.label))?.id
    const selectTokenNodeId = nodeIdForLabel(sliceResult, 'selectToken')
    const selectAuthStatusNodeId = nodeIdForLabel(sliceResult, 'selectAuthStatus')

    expect(readSessionStateNodeId).toBeDefined()
    expect(consumerResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: readSessionStateNodeId, target: selectTokenNodeId, relation: 'uses' }),
        expect.objectContaining({ source: readSessionStateNodeId, target: selectAuthStatusNodeId, relation: 'uses' }),
      ]),
    )
  })

  it('extracts react router jsx route declarations wrapped in fragments', () => {
    const filePath = join(FIXTURES_DIR, 'react-router-fragment-routes.tsx')
    const result = extractJs(filePath)

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '/', node_kind: 'route', route_path: '/', framework_role: 'react_router_route', framework: 'react-router' }),
        expect.objectContaining({ label: '/ (index)', node_kind: 'route', route_path: '/', framework_role: 'react_router_route', framework: 'react-router' }),
        expect.objectContaining({ label: '/settings', node_kind: 'route', route_path: '/settings', framework_role: 'react_router_route', framework: 'react-router' }),
      ]),
    )

    const rootRouteId = nodeIdForLabel(result, '/')
    const indexRouteId = nodeIdForLabel(result, '/ (index)')
    const settingsRouteId = nodeIdForLabel(result, '/settings')

    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: nodeIdForLabel(result, 'router'), target: rootRouteId, relation: 'registers_route' }),
        expect.objectContaining({ source: rootRouteId, target: nodeIdForLabel(result, 'AppLayout()'), relation: 'renders' }),
        expect.objectContaining({ source: indexRouteId, target: nodeIdForLabel(result, 'HomePage()'), relation: 'renders' }),
        expect.objectContaining({ source: settingsRouteId, target: nodeIdForLabel(result, 'SettingsPage()'), relation: 'renders' }),
        expect.objectContaining({ source: rootRouteId, target: indexRouteId, relation: 'contains' }),
        expect.objectContaining({ source: rootRouteId, target: settingsRouteId, relation: 'contains' }),
      ]),
    )
  })

  it('extracts nest modules, controllers, providers, routes, and controller attachments across files', () => {
    const moduleFilePath = join(FIXTURES_DIR, 'nest-auth.module.ts')
    const controllerFilePath = join(FIXTURES_DIR, 'nest-auth.controller.ts')
    const serviceFilePath = join(FIXTURES_DIR, 'nest-auth.service.ts')

    const moduleResult = extractJs(moduleFilePath)
    const controllerResult = extractJs(controllerFilePath)
    const serviceResult = extractJs(serviceFilePath)
    const graph = buildGraph([moduleResult, controllerResult, serviceResult])

    const moduleNodeId = nodeIdForLabel(moduleResult, 'AuthModule')
    const controllerNodeId = nodeIdForLabel(controllerResult, 'AuthController')
    const serviceNodeId = nodeIdForLabel(serviceResult, 'AuthService')
    const guardNodeId = nodeIdForLabel(controllerResult, 'AuthGuard')
    const pipeNodeId = nodeIdForLabel(controllerResult, 'TrimBodyPipe')
    const interceptorNodeId = nodeIdForLabel(controllerResult, 'AuditInterceptor')
    const profileRouteNodeId = nodeIdForLabel(controllerResult, 'GET /auth/profile')
    const loginRouteNodeId = nodeIdForLabel(controllerResult, 'POST /auth/login')
    expect([...moduleResult.nodes, ...controllerResult.nodes, ...serviceResult.nodes]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'AuthModule', node_kind: 'class', framework: 'nestjs', framework_role: 'nest_module' }),
        expect.objectContaining({ label: 'AuthController', node_kind: 'class', framework: 'nestjs', framework_role: 'nest_controller' }),
        expect.objectContaining({ label: 'AuthService', node_kind: 'class', framework: 'nestjs', framework_role: 'nest_provider' }),
        expect.objectContaining({ label: 'AuthGuard', node_kind: 'class', framework: 'nestjs', framework_role: 'nest_guard' }),
        expect.objectContaining({ label: 'TrimBodyPipe', node_kind: 'class', framework: 'nestjs', framework_role: 'nest_pipe' }),
        expect.objectContaining({ label: 'AuditInterceptor', node_kind: 'class', framework: 'nestjs', framework_role: 'nest_interceptor' }),
        expect.objectContaining({
          label: 'GET /auth/profile',
          node_kind: 'route',
          framework: 'nestjs',
          framework_role: 'nest_route',
          route_path: '/auth/profile',
        }),
        expect.objectContaining({
          label: 'POST /auth/login',
          node_kind: 'route',
          framework: 'nestjs',
          framework_role: 'nest_route',
          route_path: '/auth/login',
        }),
      ]),
    )

    expect(moduleResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: moduleNodeId, target: controllerNodeId, relation: 'declares_controller' }),
        expect.objectContaining({ source: moduleNodeId, target: serviceNodeId, relation: 'provides' }),
      ]),
    )
    expect(controllerResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: controllerNodeId, target: serviceNodeId, relation: 'injects' }),
        expect.objectContaining({ source: controllerNodeId, target: profileRouteNodeId, relation: 'handles_route' }),
        expect.objectContaining({ source: controllerNodeId, target: loginRouteNodeId, relation: 'handles_route' }),
        expect.objectContaining({ source: profileRouteNodeId, target: controllerNodeId, relation: 'depends_on' }),
        expect.objectContaining({ source: profileRouteNodeId, target: guardNodeId, relation: 'uses_guard' }),
        expect.objectContaining({ source: profileRouteNodeId, target: pipeNodeId, relation: 'uses_pipe' }),
        expect.objectContaining({ source: profileRouteNodeId, target: interceptorNodeId, relation: 'uses_interceptor' }),
      ]),
    )

    expect(graph.uniqueEdgeBetween(moduleNodeId, controllerNodeId).attributes).toEqual(expect.objectContaining({ relation: 'declares_controller' }))
    expect(graph.uniqueEdgeBetween(moduleNodeId, serviceNodeId).attributes).toEqual(expect.objectContaining({ relation: 'provides' }))
    expect(graph.uniqueEdgeBetween(controllerNodeId, serviceNodeId).attributes).toEqual(expect.objectContaining({ relation: 'injects' }))
    expect(graph.uniqueEdgeBetween(controllerNodeId, profileRouteNodeId).attributes).toEqual(expect.objectContaining({ relation: 'handles_route' }))
    expect(graph.uniqueEdgeBetween(profileRouteNodeId, controllerNodeId).attributes).toEqual(expect.objectContaining({ relation: 'depends_on' }))
    expect(graph.uniqueEdgeBetween(profileRouteNodeId, guardNodeId).attributes).toEqual(expect.objectContaining({ relation: 'uses_guard' }))
    expect(graph.uniqueEdgeBetween(profileRouteNodeId, pipeNodeId).attributes).toEqual(expect.objectContaining({ relation: 'uses_pipe' }))
    expect(graph.uniqueEdgeBetween(profileRouteNodeId, interceptorNodeId).attributes).toEqual(expect.objectContaining({ relation: 'uses_interceptor' }))
  })

  it('extracts next app-router, pages-router, middleware, and boundary semantics across files', () => {
    const nextAppDir = join(FIXTURES_DIR, 'next-app')
    const nextPagesDir = join(FIXTURES_DIR, 'next-pages', 'pages')
    const middlewareFilePath = join(nextAppDir, 'middleware.ts')
    const layoutFilePath = join(nextAppDir, 'app', '(marketing)', 'dashboard', '[team]', 'layout.tsx')
    const pageFilePath = join(nextAppDir, 'app', '(marketing)', 'dashboard', '[team]', 'page.tsx')
    const templateFilePath = join(nextAppDir, 'app', '(marketing)', 'dashboard', '[team]', 'template.tsx')
    const loadingFilePath = join(nextAppDir, 'app', '(marketing)', 'dashboard', '[team]', 'loading.tsx')
    const errorFilePath = join(nextAppDir, 'app', '(marketing)', 'dashboard', '[team]', 'error.tsx')
    const notFoundFilePath = join(nextAppDir, 'app', '(marketing)', 'dashboard', '[team]', 'not-found.tsx')
    const defaultFilePath = join(nextAppDir, 'app', '(marketing)', 'dashboard', '[team]', '@modal', 'default.tsx')
    const actionFilePath = join(nextAppDir, 'app', '(marketing)', 'dashboard', '[team]', 'actions.ts')
    const clientFilePath = join(nextAppDir, 'app', '(marketing)', 'dashboard', '[team]', 'ClientTeamPanel.tsx')
    const routeHandlerFilePath = join(nextAppDir, 'app', 'api', 'teams', '[team]', 'route.ts')
    const accountFilePath = join(nextPagesDir, 'account.tsx')
    const pagesAppFilePath = join(nextPagesDir, '_app.tsx')
    const pagesDocumentFilePath = join(nextPagesDir, '_document.tsx')
    const pagesErrorFilePath = join(nextPagesDir, '_error.tsx')
    const pagesApiFilePath = join(nextPagesDir, 'api', 'auth', '[...nextauth].ts')

    const middlewareResult = extractJs(middlewareFilePath)
    const layoutResult = extractJs(layoutFilePath)
    const pageResult = extractJs(pageFilePath)
    const templateResult = extractJs(templateFilePath)
    const loadingResult = extractJs(loadingFilePath)
    const errorResult = extractJs(errorFilePath)
    const notFoundResult = extractJs(notFoundFilePath)
    const defaultResult = extractJs(defaultFilePath)
    const actionResult = extractJs(actionFilePath)
    const clientResult = extractJs(clientFilePath)
    const routeHandlerResult = extractJs(routeHandlerFilePath)
    const accountResult = extractJs(accountFilePath)
    const pagesAppResult = extractJs(pagesAppFilePath)
    const pagesDocumentResult = extractJs(pagesDocumentFilePath)
    const pagesErrorResult = extractJs(pagesErrorFilePath)
    const pagesApiResult = extractJs(pagesApiFilePath)
    const graph = buildGraph([
      middlewareResult,
      layoutResult,
      pageResult,
      templateResult,
      loadingResult,
      errorResult,
      notFoundResult,
      defaultResult,
      actionResult,
      clientResult,
      routeHandlerResult,
      accountResult,
      pagesAppResult,
      pagesDocumentResult,
      pagesErrorResult,
      pagesApiResult,
    ])

    const appRouteNodeId = nodeIdForLabel(pageResult, '/dashboard/[team]')
    const appPageNodeId = nodeIdForLabel(pageResult, 'page /dashboard/[team]')
    const layoutNodeId = nodeIdForLabel(pageResult, 'layout /dashboard/[team]')
    const templateNodeId = nodeIdForLabel(pageResult, 'template /dashboard/[team]')
    const loadingNodeId = nodeIdForLabel(pageResult, 'loading /dashboard/[team]')
    const errorNodeId = nodeIdForLabel(pageResult, 'error /dashboard/[team]')
    const notFoundNodeId = nodeIdForLabel(pageResult, 'not-found /dashboard/[team]')
    const defaultNodeId = nodeIdForLabel(pageResult, 'default /dashboard/[team] @modal')
    const middlewareNodeId = nodeIdForLabel(pageResult, 'middleware')
    const actionNodeId = nodeIdForLabel(pageResult, 'saveTeamSettings()')
    const apiGetNodeId = nodeIdForLabel(routeHandlerResult, 'GET /api/teams/[team]')
    const apiPostNodeId = nodeIdForLabel(routeHandlerResult, 'POST /api/teams/[team]')
    const pagesRouteNodeId = nodeIdForLabel(accountResult, '/account')
    const pagesPageNodeId = nodeIdForLabel(accountResult, 'page /account')
    const pagesAppNodeId = nodeIdForLabel(accountResult, '_app')
    const pagesDocumentNodeId = nodeIdForLabel(accountResult, '_document')
    const pagesErrorNodeId = nodeIdForLabel(accountResult, '_error')

    expect([
      ...middlewareResult.nodes,
      ...layoutResult.nodes,
      ...pageResult.nodes,
      ...templateResult.nodes,
      ...loadingResult.nodes,
      ...errorResult.nodes,
      ...notFoundResult.nodes,
      ...defaultResult.nodes,
      ...actionResult.nodes,
      ...clientResult.nodes,
      ...routeHandlerResult.nodes,
      ...accountResult.nodes,
      ...pagesAppResult.nodes,
      ...pagesDocumentResult.nodes,
      ...pagesErrorResult.nodes,
      ...pagesApiResult.nodes,
    ]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '/dashboard/[team]', node_kind: 'route', framework: 'nextjs', framework_role: 'next_route', route_path: '/dashboard/[team]' }),
        expect.objectContaining({ label: 'page /dashboard/[team]', node_kind: 'component', framework: 'nextjs', framework_role: 'next_page', route_path: '/dashboard/[team]', runtime_boundary: 'server' }),
        expect.objectContaining({ label: 'layout /dashboard/[team]', node_kind: 'component', framework: 'nextjs', framework_role: 'next_layout', route_path: '/dashboard/[team]' }),
        expect.objectContaining({ label: 'template /dashboard/[team]', node_kind: 'component', framework: 'nextjs', framework_role: 'next_template', route_path: '/dashboard/[team]' }),
        expect.objectContaining({ label: 'loading /dashboard/[team]', node_kind: 'component', framework: 'nextjs', framework_role: 'next_loading', route_path: '/dashboard/[team]' }),
        expect.objectContaining({ label: 'error /dashboard/[team]', node_kind: 'component', framework: 'nextjs', framework_role: 'next_error', route_path: '/dashboard/[team]', runtime_boundary: 'client' }),
        expect.objectContaining({ label: 'not-found /dashboard/[team]', node_kind: 'component', framework: 'nextjs', framework_role: 'next_not_found', route_path: '/dashboard/[team]' }),
        expect.objectContaining({ label: 'default /dashboard/[team] @modal', node_kind: 'component', framework: 'nextjs', framework_role: 'next_default', route_path: '/dashboard/[team]', parallel_slot: 'modal' }),
        expect.objectContaining({ label: 'middleware', node_kind: 'function', framework: 'nextjs', framework_role: 'next_middleware' }),
        expect.objectContaining({ label: 'GET /api/teams/[team]', node_kind: 'route', framework: 'nextjs', framework_role: 'next_route_handler', route_path: '/api/teams/[team]' }),
        expect.objectContaining({ label: 'POST /api/teams/[team]', node_kind: 'route', framework: 'nextjs', framework_role: 'next_route_handler', route_path: '/api/teams/[team]' }),
        expect.objectContaining({ label: '/account', node_kind: 'route', framework: 'nextjs', framework_role: 'next_route', route_path: '/account' }),
        expect.objectContaining({ label: 'page /account', node_kind: 'component', framework: 'nextjs', framework_role: 'next_page', route_path: '/account', runtime_boundary: 'server' }),
        expect.objectContaining({ label: 'API /api/auth/[...nextauth]', node_kind: 'route', framework: 'nextjs', framework_role: 'next_route_handler', route_path: '/api/auth/[...nextauth]' }),
        expect.objectContaining({ label: '_app', node_kind: 'component', framework: 'nextjs', framework_role: 'next_pages_app' }),
        expect.objectContaining({ label: '_document', node_kind: 'component', framework: 'nextjs', framework_role: 'next_pages_document' }),
        expect.objectContaining({ label: '_error', node_kind: 'component', framework: 'nextjs', framework_role: 'next_pages_error' }),
        expect.objectContaining({ label: 'saveTeamSettings()', node_kind: 'function', framework: 'nextjs', framework_role: 'next_server_action', runtime_boundary: 'server' }),
        expect.objectContaining({ label: 'ClientTeamPanel()', framework: 'nextjs', framework_role: 'next_client_component', runtime_boundary: 'client' }),
      ]),
    )

    expect(pageResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: appRouteNodeId, target: appPageNodeId, relation: 'depends_on' }),
        expect.objectContaining({ source: appRouteNodeId, target: layoutNodeId, relation: 'depends_on' }),
        expect.objectContaining({ source: appRouteNodeId, target: templateNodeId, relation: 'depends_on' }),
        expect.objectContaining({ source: appRouteNodeId, target: loadingNodeId, relation: 'depends_on' }),
        expect.objectContaining({ source: appRouteNodeId, target: errorNodeId, relation: 'depends_on' }),
        expect.objectContaining({ source: appRouteNodeId, target: notFoundNodeId, relation: 'depends_on' }),
        expect.objectContaining({ source: appRouteNodeId, target: defaultNodeId, relation: 'depends_on' }),
        expect.objectContaining({ source: appRouteNodeId, target: middlewareNodeId, relation: 'middleware' }),
        expect.objectContaining({ source: appPageNodeId, target: actionNodeId, relation: 'defines_action' }),
      ]),
    )
    expect(routeHandlerResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: apiGetNodeId, target: middlewareNodeId, relation: 'middleware' }),
        expect.objectContaining({ source: apiPostNodeId, target: middlewareNodeId, relation: 'middleware' }),
      ]),
    )
    expect(accountResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: pagesRouteNodeId, target: pagesPageNodeId, relation: 'depends_on' }),
        expect.objectContaining({ source: pagesRouteNodeId, target: pagesAppNodeId, relation: 'depends_on' }),
        expect.objectContaining({ source: pagesRouteNodeId, target: pagesDocumentNodeId, relation: 'depends_on' }),
        expect.objectContaining({ source: pagesRouteNodeId, target: pagesErrorNodeId, relation: 'depends_on' }),
      ]),
    )

    expect(graph.uniqueEdgeBetween(appRouteNodeId, appPageNodeId).attributes).toEqual(expect.objectContaining({ relation: 'depends_on' }))
    expect(graph.uniqueEdgeBetween(appRouteNodeId, middlewareNodeId).attributes).toEqual(expect.objectContaining({ relation: 'middleware' }))
    expect(graph.uniqueEdgeBetween(apiGetNodeId, middlewareNodeId).attributes).toEqual(expect.objectContaining({ relation: 'middleware' }))
    expect(graph.uniqueEdgeBetween(pagesRouteNodeId, pagesAppNodeId).attributes).toEqual(expect.objectContaining({ relation: 'depends_on' }))
  })

  it('does not duplicate pages-router API route handlers', () => {
    const pagesApiFilePath = join(FIXTURES_DIR, 'next-pages', 'pages', 'api', 'auth', '[...nextauth].ts')
    const pagesApiResult = extractJs(pagesApiFilePath)
    const apiNodes = pagesApiResult.nodes.filter(
      (node) => node.label === 'API /api/auth/[...nextauth]' && node.framework_role === 'next_route_handler',
    )

    expect(apiNodes).toHaveLength(1)
  })

  it('matches next middleware parameters in the middle of a route pattern', () => {
    const scratchDir = join(TEST_ARTIFACTS_DIR, 'next-middleware-parameter-middle')
    try {
      writeScratchFiles(scratchDir, {
        'middleware.ts': [
          'export default function middleware() {',
          '  return null',
          '}',
          '',
          'export const config = {',
          "  matcher: ['/api/:userId/posts'],",
          '}',
        ].join('\n'),
        'app/api/[userId]/posts/route.ts': [
          'export async function GET() {',
          '  return { ok: true }',
          '}',
        ].join('\n'),
      })

      const routeFilePath = join(scratchDir, 'app', 'api', '[userId]', 'posts', 'route.ts')
      const routeResult = extractJs(routeFilePath)
      const routeNodeId = nodeIdForLabel(routeResult, 'GET /api/[userId]/posts')
      const middlewareNodeId = nodeIdForLabel(routeResult, 'middleware')

      expect(routeResult.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: routeNodeId, target: middlewareNodeId, relation: 'middleware' }),
        ]),
      )
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('links next app route-handler nodes to their exported HTTP method implementations', () => {
    const routeFilePath = join(FIXTURES_DIR, 'next-app', 'app', 'api', 'teams', '[team]', 'route.ts')
    const routeResult = extractJs(routeFilePath)
    const getRouteNodeId = nodeIdForLabel(routeResult, 'GET /api/teams/[team]')
    const postRouteNodeId = nodeIdForLabel(routeResult, 'POST /api/teams/[team]')
    const getImplementationNodeId = nodeIdForLabel(routeResult, 'GET()')
    const postImplementationNodeId = nodeIdForLabel(routeResult, 'POST()')

    expect(routeResult.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: getRouteNodeId, target: getImplementationNodeId, relation: 'depends_on' }),
        expect.objectContaining({ source: postRouteNodeId, target: postImplementationNodeId, relation: 'depends_on' }),
      ]),
    )
  })

  it('links next named middleware exports to the middleware semantic node', () => {
    const scratchDir = join(TEST_ARTIFACTS_DIR, 'next-named-middleware-export')
    try {
      writeScratchFiles(scratchDir, {
        'middleware.ts': [
          'export function middleware() {',
          '  return null',
          '}',
          '',
          'export const config = {',
          "  matcher: ['/dashboard/:team'],",
          '}',
        ].join('\n'),
        'app/page.tsx': 'export default function Page() { return null }',
      })

      const middlewareFilePath = join(scratchDir, 'middleware.ts')
      const middlewareResult = extractJs(middlewareFilePath)
      const middlewareSemanticNodeId = nodeIdForLabel(middlewareResult, 'middleware')
      const middlewareImplementationNodeId = nodeIdForLabel(middlewareResult, 'middleware()')

      expect(middlewareResult.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: middlewareSemanticNodeId, target: middlewareImplementationNodeId, relation: 'depends_on' }),
        ]),
      )
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('only annotates exported Next boundary callables', () => {
    const scratchDir = join(TEST_ARTIFACTS_DIR, 'next-exported-boundary-callables')
    try {
      writeScratchFiles(scratchDir, {
        'app/actions.ts': [
          "'use server'",
          '',
          'function localHelper() {',
          '  return 1',
          '}',
          '',
          'const localAction = async () => 2',
          '',
          'export async function saveSettings() {',
          '  return 3',
          '}',
          '',
          'export const publish = async () => 4',
          '',
          'export const config = {',
          "  runtime: 'nodejs',",
          '}',
        ].join('\n'),
      })

      const actionsFilePath = join(scratchDir, 'app', 'actions.ts')
      const actionsResult = extractJs(actionsFilePath)

      expect(actionsResult.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'saveSettings()', framework_role: 'next_server_action', runtime_boundary: 'server' }),
          expect.objectContaining({ label: 'publish()', framework_role: 'next_server_action', runtime_boundary: 'server' }),
        ]),
      )
      expect(actionsResult.nodes.find((node) => node.label === 'localHelper()' && node.framework_role === 'next_server_action')).toBeUndefined()
      expect(actionsResult.nodes.find((node) => node.label === 'localAction()' && node.framework_role === 'next_server_action')).toBeUndefined()
      expect(actionsResult.nodes.find((node) => node.label === 'config' && node.framework_role === 'next_server_action')).toBeUndefined()
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('does not assign next server-action roles to imported plain helper functions', () => {
    const scratchDir = join(TEST_ARTIFACTS_DIR, 'next-imported-plain-helper')
    try {
      writeScratchFiles(scratchDir, {
        'app/page.tsx': [
          "import { formatTeamName } from '../helpers'",
          '',
          'export default function Page() {',
          '  return <div>{formatTeamName(\'team\')}</div>',
          '}',
        ].join('\n'),
        'helpers.ts': [
          'export function formatTeamName(value: string) {',
          '  return value.toUpperCase()',
          '}',
        ].join('\n'),
      })

      const pageFilePath = join(scratchDir, 'app', 'page.tsx')
      const pageResult = extractJs(pageFilePath)
      const helperNode = pageResult.nodes.find((node) => node.label === 'formatTeamName()')

      expect(helperNode).toBeDefined()
      expect(helperNode?.framework_role).toBeUndefined()
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('does not synthesize callable imported bindings for non-callable Next exports', () => {
    const scratchDir = join(TEST_ARTIFACTS_DIR, 'next-imported-non-callable-export')
    try {
      writeScratchFiles(scratchDir, {
        'app/page.tsx': [
          "import { config } from '../helpers'",
          '',
          'export default function Page() {',
          '  return <div>{config.mode}</div>',
          '}',
        ].join('\n'),
        'helpers.ts': [
          'export const config = {',
          "  mode: 'team',",
          '}',
        ].join('\n'),
      })

      const pageFilePath = join(scratchDir, 'app', 'page.tsx')
      const pageResult = extractJs(pageFilePath)

      expect(pageResult.nodes.find((node) => node.label === 'config()')).toBeUndefined()
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('keeps imported nest providers distinct when same-named classes come from same-stem files', () => {
    const scratchDir = join(TEST_ARTIFACTS_DIR, 'nest-same-stem-provider-collision')
    try {
      writeScratchFiles(scratchDir, {
        'feature/auth.service.ts': [
          "import { Injectable } from '@nestjs/common'",
          '',
          '@Injectable()',
          'export class AuthService {}',
        ].join('\n'),
        'users/auth.service.ts': [
          "import { Injectable } from '@nestjs/common'",
          '',
          '@Injectable()',
          'export class AuthService {}',
        ].join('\n'),
        'app.module.ts': [
          "import { Module } from '@nestjs/common'",
          "import { AuthService as FeatureAuthService } from './feature/auth.service'",
          "import { AuthService as UserAuthService } from './users/auth.service'",
          '',
          '@Module({',
          '  providers: [FeatureAuthService, UserAuthService],',
          '})',
          'export class AppModule {}',
        ].join('\n'),
      })

      const moduleResult = extractJs(join(scratchDir, 'app.module.ts'))
      const featureResult = extractJs(join(scratchDir, 'feature', 'auth.service.ts'))
      const userResult = extractJs(join(scratchDir, 'users', 'auth.service.ts'))
      const graph = buildGraph([moduleResult, featureResult, userResult])
      const providerNodes = moduleResult.nodes.filter((node) => node.label === 'AuthService' && node.framework_role === 'nest_provider')

      expect(providerNodes).toHaveLength(2)
      expect(new Set(providerNodes.map((node) => node.id)).size).toBe(2)
      expect(new Set(providerNodes.map((node) => node.source_file)).size).toBe(2)
      expect(moduleResult.edges.filter((edge) => edge.relation === 'provides')).toHaveLength(2)
      expect(
        [...graph.nodeEntries()].filter(([, attributes]) => attributes.label === 'AuthService' && attributes.framework_role === 'nest_provider'),
      ).toHaveLength(2)
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('propagates controller-level nest pipes to each extracted route', () => {
    const scratchDir = join(TEST_ARTIFACTS_DIR, 'nest-controller-level-pipes')
    try {
      writeScratchFiles(scratchDir, {
        'auth.controller.ts': [
          "import { Controller, Get, Injectable, Post, UsePipes } from '@nestjs/common'",
          '',
          '@Injectable()',
          'export class TrimBodyPipe {}',
          '',
          "@Controller('auth')",
          '@UsePipes(TrimBodyPipe)',
          'export class AuthController {',
          "  @Get('profile')",
          '  getProfile() {',
          '    return true',
          '  }',
          '',
          "  @Post('login')",
          '  login() {',
          '    return true',
          '  }',
          '}',
        ].join('\n'),
      })

      const controllerResult = extractJs(join(scratchDir, 'auth.controller.ts'))
      const profileRouteNodeId = nodeIdForLabel(controllerResult, 'GET /auth/profile')
      const loginRouteNodeId = nodeIdForLabel(controllerResult, 'POST /auth/login')
      const pipeNodeId = nodeIdForLabel(controllerResult, 'TrimBodyPipe')

      expect(controllerResult.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: profileRouteNodeId, target: pipeNodeId, relation: 'uses_pipe' }),
          expect.objectContaining({ source: loginRouteNodeId, target: pipeNodeId, relation: 'uses_pipe' }),
        ]),
      )
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('keeps imported nest providers distinct from same-stem local base classes in the current file', () => {
    const scratchDir = join(TEST_ARTIFACTS_DIR, 'nest-base-extraction-provider-collision')
    try {
      writeScratchFiles(scratchDir, {
        'shared/auth.service.ts': [
          "import { Injectable } from '@nestjs/common'",
          '',
          '@Injectable()',
          'export class AuthService {}',
        ].join('\n'),
        'feature/auth.service.ts': [
          "import { Module } from '@nestjs/common'",
          "import { AuthService as SharedAuthService } from '../shared/auth.service'",
          '',
          'class AuthService {}',
          '',
          '@Module({',
          '  providers: [SharedAuthService],',
          '})',
          'export class FeatureModule {}',
        ].join('\n'),
      })

      const featureResult = extractJs(join(scratchDir, 'feature', 'auth.service.ts'))
      const authServiceNodes = featureResult.nodes.filter((node) => node.label === 'AuthService')
      const providerNodes = authServiceNodes.filter((node) => node.framework_role === 'nest_provider')

      expect(authServiceNodes).toHaveLength(2)
      expect(providerNodes).toHaveLength(1)
      expect(providerNodes[0]).toEqual(
        expect.objectContaining({
          source_file: join(scratchDir, 'shared', 'auth.service.ts'),
          framework_role: 'nest_provider',
        }),
      )
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('emits nest queue job edges for literal BullMQ-style enqueue sites without inventing direct worker calls', () => {
    const scratchDir = join(TEST_ARTIFACTS_DIR, 'nest-queue-job-edge')
    try {
      writeScratchFiles(scratchDir, {
        'pipeline.ts': [
          "import { Controller, Injectable, Post } from '@nestjs/common'",
          '',
          'function Processor(_queueName: string): ClassDecorator {',
          '  return () => undefined',
          '}',
          '',
          'function Process(_jobName: string): MethodDecorator {',
          '  return () => undefined',
          '}',
          '',
          'type PipelineJobPayload = {',
          '  problem: string',
          '  ideaId: string',
          '}',
          '',
          'class PipelineQueue {',
          '  async add(jobName: string, input: PipelineJobPayload) {',
          '    return {',
          '      id: `${input.ideaId}:${jobName}`,',
          '    }',
          '  }',
          '}',
          '',
          '@Injectable()',
          'class QueueRegistryService {',
          '  private readonly pipelineQueue = new PipelineQueue()',
          '',
          '  async addJob(input: PipelineJobPayload) {',
          "    return this.pipelineQueue.add('legacy.pipeline.edge.process', input)",
          '  }',
          '}',
          '',
          '@Injectable()',
          'class PipelineTriggerService {',
          '  constructor(private readonly queueRegistryService: QueueRegistryService) {}',
          '',
          '  async startPipeline(problem: string, ideaId: string) {',
          '    return this.queueRegistryService.addJob({ problem, ideaId })',
          '  }',
          '}',
          '',
          "@Processor('legacy.pipeline.edge')",
          'class OrchestratorWorker {',
          "  @Process('legacy.pipeline.edge.process')",
          '  async process(job: { data: PipelineJobPayload }) {',
          '    return job.data.ideaId',
          '  }',
          '}',
          '',
          "@Controller('ideas')",
          'class IdeaGenerationController {',
          '  constructor(private readonly pipelineTriggerService: PipelineTriggerService) {}',
          '',
          "  @Post('generate')",
          '  async generateFromProblem(problem: string, ideaId: string) {',
          '    return this.pipelineTriggerService.startPipeline(problem, ideaId)',
          '  }',
          '}',
        ].join('\n'),
      })

      const result = extractJs(join(scratchDir, 'pipeline.ts'))
      const addJobNodeId = nodeIdForLabel(result, '.addJob()')
      const workerNodeId = nodeIdForLabel(result, 'OrchestratorWorker')
      const processNodeId = result.edges.find(
        (edge) => edge.relation === 'method' && edge.source === workerNodeId,
      )?.target

      expect(processNodeId).toBeDefined()

      expect(result.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: addJobNodeId, target: processNodeId, relation: 'enqueues_job' }),
        ]),
      )
      expect(result.edges).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: addJobNodeId, target: processNodeId, relation: 'calls' }),
        ]),
      )
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('reuses the cached bull worker index without rediscovering the workspace on repeated extracts', () => {
    mkdirSync(TEST_ARTIFACTS_DIR, { recursive: true })
    const scratchDir = mkdtempSync(join(TEST_ARTIFACTS_DIR, 'nest-queue-job-edge-cache-'))
    const originalCwd = process.cwd()

    try {
      writeScratchFiles(scratchDir, {
        'pipeline.ts': [
          "import { Injectable } from '@nestjs/common'",
          '',
          'function Processor(_queueName: string): ClassDecorator {',
          '  return () => undefined',
          '}',
          '',
          'function Process(_jobName: string): MethodDecorator {',
          '  return () => undefined',
          '}',
          '',
          'type PipelineJobPayload = {',
          '  problem: string',
          '  ideaId: string',
          '}',
          '',
          'class PipelineQueue {',
          '  async add(jobName: string, input: PipelineJobPayload) {',
          '    return {',
          '      id: `${input.ideaId}:${jobName}`,',
          '    }',
          '  }',
          '}',
          '',
          '@Injectable()',
          'class QueueRegistryService {',
          '  private readonly pipelineQueue = new PipelineQueue()',
          '',
          '  async addJob(input: PipelineJobPayload) {',
          "    return this.pipelineQueue.add('legacy.pipeline.edge.process', input)",
          '  }',
          '}',
          '',
          "@Processor('legacy.pipeline.edge')",
          'class OrchestratorWorker {',
          "  @Process('legacy.pipeline.edge.process')",
          '  async process(job: { data: PipelineJobPayload }) {',
          '    return job.data.ideaId',
          '  }',
          '}',
        ].join('\n'),
      })

      const fixturePath = join(scratchDir, 'pipeline.ts')
      const detectSpy = vi.spyOn(detectModule, 'detect').mockReturnValue({
        files: {
          code: [fixturePath],
          document: [],
          paper: [],
          image: [],
          audio: [],
          video: [],
        },
        total_files: 1,
        total_words: 0,
        needs_graph: false,
        warning: null,
        skipped_sensitive: [],
        exclusions: [],
        madarignore_patterns: 0,
      })

      process.chdir(scratchDir)
      extractJs(fixturePath)
      extractJs(fixturePath)

      expect(detectSpy).toHaveBeenCalledTimes(1)
    } finally {
      process.chdir(originalCwd)
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('emits nest queue job edges for WorkerHost-style processors without @Process decorators', () => {
    mkdirSync(TEST_ARTIFACTS_DIR, { recursive: true })
    const scratchDir = mkdtempSync(join(TEST_ARTIFACTS_DIR, 'nest-worker-host-queue-edge-'))

    try {
      writeScratchFiles(scratchDir, {
        'pipeline.ts': [
          "import { Injectable } from '@nestjs/common'",
          '',
          'function Processor(_queueName: string): ClassDecorator {',
          '  return () => undefined',
          '}',
          '',
          'type PipelineJobPayload = {',
          '  problem: string',
          '  ideaId: string',
          '}',
          '',
          'type BullJob<T> = {',
          '  name: string',
          '  data: T',
          '}',
          '',
          'abstract class WorkerHost {',
          '  abstract process(job: BullJob<PipelineJobPayload>): Promise<string>',
          '}',
          '',
          'class PipelineQueue {',
          '  async add(jobName: string, input: PipelineJobPayload) {',
          '    return {',
          '      id: `${input.ideaId}:${jobName}`,',
          '    }',
          '  }',
          '}',
          '',
          '@Injectable()',
          'class QueueRegistryService {',
          '  private readonly pipelineQueue = new PipelineQueue()',
          '',
          '  async addJob(input: PipelineJobPayload) {',
          "    return this.pipelineQueue.add('legacy.pipeline.edge.process', input)",
          '  }',
          '}',
          '',
          "@Processor('legacy.pipeline.edge')",
          'class OrchestratorWorker extends WorkerHost {',
          '  async process(job: BullJob<PipelineJobPayload>) {',
          '    return job.data.ideaId',
          '  }',
          '}',
        ].join('\n'),
      })

      const result = extractJs(join(scratchDir, 'pipeline.ts'))
      const addJobNodeId = nodeIdForLabel(result, '.addJob()')
      const workerNodeId = nodeIdForLabel(result, 'OrchestratorWorker')
      const processNodeId = result.edges.find(
        (edge) => edge.relation === 'method' && edge.source === workerNodeId,
      )?.target

      expect(processNodeId).toBeDefined()

      expect(result.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: addJobNodeId, target: processNodeId, relation: 'enqueues_job' }),
        ]),
      )
      expect(result.edges).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: addJobNodeId, target: processNodeId, relation: 'calls' }),
        ]),
      )
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('uses the outermost next app directory when nested route segments are literally named app', () => {
    const scratchDir = join(TEST_ARTIFACTS_DIR, 'next-outermost-app-root')
    try {
      writeScratchFiles(scratchDir, {
        'app/app/page.tsx': [
          'export default function NestedAppPage() {',
          '  return null',
          '}',
        ].join('\n'),
      })

      const pageResult = extractJs(join(scratchDir, 'app', 'app', 'page.tsx'))

      expect(pageResult.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: '/app', framework_role: 'next_route', route_path: '/app' }),
          expect.objectContaining({ label: 'page /app', framework_role: 'next_page', route_path: '/app' }),
        ]),
      )
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})
