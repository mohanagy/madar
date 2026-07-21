import ts from 'typescript'

import {
  emitFrameworkEdge,
  mergeFrameworkMetadata,
  resolveOrMintHandler,
  resolvedDeclaration,
  stringValue,
  tagLocal,
  type FrameworkHttpContext,
} from './framework-http.js'

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'])

export type DetectHonoFrameworkContext = FrameworkHttpContext

export function detectHonoFramework(ctx: DetectHonoFrameworkContext): void {
  const classes = honoBindings(ctx.sourceFile)
  if (classes.size === 0) return
  const apps = new Map<string, { symbol: NonNullable<ReturnType<typeof tagLocal>>; declaration: ts.VariableDeclaration }>()

  for (const stmt of ctx.sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer || !ts.isNewExpression(decl.initializer)) continue
      if (!ts.isIdentifier(decl.initializer.expression) || !classes.has(decl.initializer.expression.text)) continue
      const symbol = tagLocal(ctx, decl.name.text, 'hono_app')
      if (symbol) apps.set(decl.name.text, { symbol, declaration: decl })
    }
  }
  if (apps.size === 0) return

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
      const app = apps.get(node.expression.expression.text)
      const declaration = resolvedDeclaration(node.expression.expression, ctx.checker)
      if (app && declaration === app.declaration) {
        const method = node.expression.name.text
        if (HTTP_METHODS.has(method)) emitRoute(ctx, app.symbol, node, method)
        else if (method === 'use') emitMiddleware(ctx, app.symbol, node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ctx.sourceFile)
}

function emitRoute(
  ctx: DetectHonoFrameworkContext,
  app: NonNullable<ReturnType<typeof tagLocal>>,
  call: ts.CallExpression,
  method: string,
): void {
  const path = stringValue(call.arguments[0])
  const arg = call.arguments.at(-1)
  if (path === null || !arg) return
  const handler = resolveOrMintHandler(ctx, arg, 'hono', 'hono_route')
  if (!handler) return
  const metadata = { route_path: path, http_method: method.toUpperCase() }
  mergeFrameworkMetadata(handler, metadata)
  emitFrameworkEdge(ctx, app, handler, call, metadata)
}

function emitMiddleware(
  ctx: DetectHonoFrameworkContext,
  app: NonNullable<ReturnType<typeof tagLocal>>,
  call: ts.CallExpression,
): void {
  const path = stringValue(call.arguments[0])
  const start = path === null ? 0 : 1
  for (let index = start; index < call.arguments.length; index += 1) {
    const arg = call.arguments[index]
    if (!arg) continue
    const handler = resolveOrMintHandler(ctx, arg, 'hono', 'hono_middleware')
    if (!handler) continue
    const metadata = path === null ? {} : { mount_path: path }
    mergeFrameworkMetadata(handler, metadata)
    emitFrameworkEdge(ctx, app, handler, call, metadata)
  }
}

function honoBindings(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (stmt.moduleSpecifier.text !== 'hono' && stmt.moduleSpecifier.text !== 'hono/quick') continue
    const named = stmt.importClause.namedBindings
    if (!named || !ts.isNamedImports(named)) continue
    for (const element of named.elements) {
      if ((element.propertyName?.text ?? element.name.text) === 'Hono') names.add(element.name.text)
    }
  }
  return names
}
