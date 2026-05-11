// SPI v1 — Fastify framework layer (v0.17 #83).
//
// Fastify uses a factory function + chainable registration API:
//
//   import Fastify from 'fastify'
//   const app = Fastify()                          // factory call
//   app.get('/users', listUsers)                   // route
//   app.post('/users/:id', updateUser)             // route
//   app.register(authPlugin, { prefix: '/api' })   // plugin registration
//   app.addHook('preHandler', authHook)            // hook registration
//
// Detection:
//
//   * `Fastify()` / `fastify()` (default-imported factory)  → `fastify_app`
//   * `app.<HTTP_METHOD>(path, [opts,] handler)`            → `fastify_route`
//                                                             with `route_path` + `http_method`
//   * `app.register(plugin, [opts])`                        → `fastify_plugin`
//                                                             on the plugin identifier
//
// Out of scope: route-options objects (preHandler, schema, etc.) — they
// belong on the route node but adding them requires walking the second
// argument; deferred until a real codebase asks for it.

import ts from 'typescript'

import type { SpiFrameworkRole, SpiSymbol } from './types.js'

const FASTIFY_MODULE_SPECIFIERS: ReadonlySet<string> = new Set([
  'fastify',
])

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all',
])

export type DetectFastifyFrameworkContext = {
  sourceFile: ts.SourceFile
  fileId: string
  symbolsByFile: Map<string, SpiSymbol[]>
}

interface FastifyBindings {
  hasFastifyImport: boolean
  /** Local names that refer to the Fastify factory (default import or
   *  named import `import { fastify } from 'fastify'`). */
  factoryNames: Set<string>
}

export function detectFastifyFramework(ctx: DetectFastifyFrameworkContext): void {
  const bindings = collectBindings(ctx.sourceFile)
  if (!bindings.hasFastifyImport || bindings.factoryNames.size === 0) return

  // 1. Find Fastify app bindings: `const app = Fastify()` / `fastify()`.
  const appNames = new Set<string>()
  for (const stmt of ctx.sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      if (!ts.isCallExpression(decl.initializer)) continue
      const callee = decl.initializer.expression
      if (!ts.isIdentifier(callee)) continue
      if (!bindings.factoryNames.has(callee.text)) continue
      appNames.add(decl.name.text)
      tagSymbolByName(ctx, decl.name.text, 'fastify_app', null)
    }
  }
  if (appNames.size === 0) return

  // 2. Walk for `<app>.<method>(path, [opts,] handler)` and `<app>.register(plugin, ...)`.
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      appNames.has(node.expression.expression.text)
    ) {
      const methodName = node.expression.name.text
      if (HTTP_METHODS.has(methodName)) {
        handleRouteCall(ctx, node, methodName)
      } else if (methodName === 'register') {
        handlePluginCall(ctx, node)
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(ctx.sourceFile)
}

function handleRouteCall(
  ctx: DetectFastifyFrameworkContext,
  call: ts.CallExpression,
  httpMethod: string,
): void {
  // Fastify signature: app.METHOD(path, [opts,] handler). Last arg is
  // always the handler.
  const args = call.arguments
  if (args.length < 2) return
  const pathArg = args[0]
  if (!pathArg || !ts.isStringLiteralLike(pathArg)) return
  const routePath = pathArg.text
  const handler = args[args.length - 1]
  if (!handler || !ts.isIdentifier(handler)) return
  tagSymbolByName(ctx, handler.text, 'fastify_route', {
    route_path: routePath,
    http_method: httpMethod.toUpperCase(),
  })
}

function handlePluginCall(
  ctx: DetectFastifyFrameworkContext,
  call: ts.CallExpression,
): void {
  // Fastify signature: app.register(plugin, [opts]). First arg is the
  // plugin function — tag it. Options' `prefix` field could be a mount
  // path, but that lives on the plugin's internal routes; not surfaced here.
  const first = call.arguments[0]
  if (!first || !ts.isIdentifier(first)) return
  let prefix: string | null = null
  const opts = call.arguments[1]
  if (opts && ts.isObjectLiteralExpression(opts)) {
    for (const prop of opts.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === 'prefix' &&
        ts.isStringLiteralLike(prop.initializer)
      ) {
        prefix = prop.initializer.text
      }
    }
  }
  tagSymbolByName(ctx, first.text, 'fastify_plugin', prefix !== null ? { mount_path: prefix } : null)
}

function collectBindings(sourceFile: ts.SourceFile): FastifyBindings {
  const bindings: FastifyBindings = {
    hasFastifyImport: false,
    factoryNames: new Set<string>(),
  }
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (!FASTIFY_MODULE_SPECIFIERS.has(stmt.moduleSpecifier.text)) continue
    bindings.hasFastifyImport = true
    // default import: `import Fastify from 'fastify'`
    if (stmt.importClause.name) {
      bindings.factoryNames.add(stmt.importClause.name.text)
    }
    // named import: `import { fastify } from 'fastify'`
    const named = stmt.importClause.namedBindings
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        const importedName = element.propertyName?.text ?? element.name.text
        if (importedName === 'fastify' || importedName === 'default') {
          bindings.factoryNames.add(element.name.text)
        }
      }
    }
  }
  return bindings
}

function tagSymbolByName(
  ctx: DetectFastifyFrameworkContext,
  name: string,
  role: SpiFrameworkRole,
  metadata: Record<string, unknown> | null,
): void {
  const symbols = ctx.symbolsByFile.get(ctx.fileId)
  if (!symbols) return
  for (const symbol of symbols) {
    if (symbol.name === name && symbol.framework_role === undefined) {
      symbol.framework_role = role
      if (metadata && Object.keys(metadata).length > 0) {
        const merged: Record<string, unknown> = { ...(symbol.framework_metadata ?? {}) }
        for (const [key, value] of Object.entries(metadata)) {
          if (value !== undefined) merged[key] = value
        }
        symbol.framework_metadata = merged
      }
      return
    }
  }
}
