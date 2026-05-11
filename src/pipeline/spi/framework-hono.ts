// SPI v1 — Hono framework layer (v0.17 #83).
//
// Hono is a small, edge-friendly web framework with an Express-like
// routing API:
//
//   import { Hono } from 'hono'
//   const app = new Hono()
//   app.get('/users', listUsers)
//   app.post('/users/:id', updateUser)
//   app.use('/api/*', authMiddleware)
//
// Detection mirrors the Express substrate's first-pass shape:
//
//   * `new Hono()` (or sub-router via `new Hono()`) → `hono_app`
//   * `app.<HTTP_METHOD>(path, ...handlers)`        → `hono_route` on the
//                                                     last handler with
//                                                     `route_path`, `http_method`
//   * `app.use(...)`                                → `hono_middleware`
//
// Out of scope for this initial slice:
//   * `app.route('/prefix', subApp)` mount-prefix propagation (parallels
//     Express slice 1c-ii.g; can land later if codebases ask for it)
//   * Inline arrow-function handler synthesis (deferred — Hono usage
//     overwhelmingly defines handlers as separate functions)
//   * `c.json(...)` / `c.text(...)` response-shape detection — out of
//     SPI's structural scope.

import ts from 'typescript'

import type { SpiFrameworkRole, SpiSymbol } from './types.js'

const HONO_MODULE_SPECIFIERS: ReadonlySet<string> = new Set([
  'hono',
  'hono/quick',
])

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all',
])

export type DetectHonoFrameworkContext = {
  sourceFile: ts.SourceFile
  fileId: string
  symbolsByFile: Map<string, SpiSymbol[]>
}

interface HonoBindings {
  /** True iff the file imports anything from `hono`. */
  hasHonoImport: boolean
  /** Local names of identifiers imported as `Hono` (class). */
  honoClassNames: Set<string>
}

export function detectHonoFramework(ctx: DetectHonoFrameworkContext): void {
  const bindings = collectBindings(ctx.sourceFile)
  if (!bindings.hasHonoImport) return

  // 1. Find Hono app bindings: `const app = new Hono()`.
  const honoAppNames = new Set<string>()
  for (const stmt of ctx.sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      if (!ts.isNewExpression(decl.initializer)) continue
      if (!ts.isIdentifier(decl.initializer.expression)) continue
      if (!bindings.honoClassNames.has(decl.initializer.expression.text)) continue
      honoAppNames.add(decl.name.text)
      tagSymbolByName(ctx, decl.name.text, 'hono_app', null)
    }
  }
  if (honoAppNames.size === 0) return

  // 2. Walk all expression statements for `<app>.<method>(path, ...handlers)`.
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      honoAppNames.has(node.expression.expression.text)
    ) {
      const methodName = node.expression.name.text
      if (HTTP_METHODS.has(methodName)) {
        handleRouteCall(ctx, node, methodName)
      } else if (methodName === 'use') {
        handleMiddlewareCall(ctx, node)
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(ctx.sourceFile)
}

function handleRouteCall(
  ctx: DetectHonoFrameworkContext,
  call: ts.CallExpression,
  httpMethod: string,
): void {
  // Hono signature: app.METHOD(path, [middleware...,] handler).
  // The last argument is the route handler; tag it with route_path +
  // http_method.
  const args = call.arguments
  if (args.length < 2) return
  const pathArg = args[0]
  if (!pathArg || !ts.isStringLiteralLike(pathArg)) return
  const routePath = pathArg.text
  const handler = args[args.length - 1]
  if (!handler || !ts.isIdentifier(handler)) return
  tagSymbolByName(ctx, handler.text, 'hono_route', {
    route_path: routePath,
    http_method: httpMethod.toUpperCase(),
  })
}

function handleMiddlewareCall(
  ctx: DetectHonoFrameworkContext,
  call: ts.CallExpression,
): void {
  // Hono signature: app.use([path], ...middleware). Path is optional.
  const args = call.arguments
  if (args.length === 0) return
  const first = args[0]
  if (!first) return
  let mountPath: string | null = null
  let firstHandlerIndex = 0
  if (ts.isStringLiteralLike(first)) {
    mountPath = first.text
    firstHandlerIndex = 1
  }
  for (let i = firstHandlerIndex; i < args.length; i += 1) {
    const handler = args[i]
    if (handler && ts.isIdentifier(handler)) {
      tagSymbolByName(
        ctx,
        handler.text,
        'hono_middleware',
        mountPath !== null ? { mount_path: mountPath } : null,
      )
    }
  }
}

function collectBindings(sourceFile: ts.SourceFile): HonoBindings {
  const bindings: HonoBindings = {
    hasHonoImport: false,
    honoClassNames: new Set<string>(),
  }
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (!HONO_MODULE_SPECIFIERS.has(stmt.moduleSpecifier.text)) continue
    bindings.hasHonoImport = true
    const named = stmt.importClause.namedBindings
    if (!named || !ts.isNamedImports(named)) continue
    for (const element of named.elements) {
      const importedName = element.propertyName?.text ?? element.name.text
      if (importedName === 'Hono') {
        bindings.honoClassNames.add(element.name.text)
      }
    }
  }
  return bindings
}

function tagSymbolByName(
  ctx: DetectHonoFrameworkContext,
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
