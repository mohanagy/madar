// SPI v1 — Express framework layer (slices 1c-ii.b + 1c-ii.c of #72).
//
// Slice 1c-ii.b — substrate: detects Express's `app = express()` and
// `router = Router()` factory call patterns and tags the resulting
// variable symbols with framework_role.
//
// Slice 1c-ii.c — route detection: walks `<binding>.get/post/put/patch/
// delete/all/options/head(...)` call expressions. When the receiver
// resolves to a previously-tagged express_app/express_router binding and
// the LAST argument is a named identifier (function or variable symbol
// in the same file), the handler is tagged framework_role: 'express_route'
// and a `route_handler` SpiEdge is emitted from the binding's symbol to
// the handler's symbol with confidence 'high'. Inline arrow handlers
// (`app.get('/p', (req, res) => {...})`) are intentionally NOT tagged in
// this slice — they require synthesizing route nodes from anonymous
// callbacks, which is slice 1c-ii.e territory.
//
// Future slices:
//
//   * 1c-ii.d — middleware detection: app.use(...) tags handlers with
//     framework_role: 'express_middleware'.
//   * 1c-ii.e — full byte-equivalence with the legacy
//     extract/frameworks/express.ts surface (~1,669 lines): synthetic
//     route nodes with route_path, mounted-router prefix resolution,
//     dynamic compositions.

import ts from 'typescript'

import type { SpiEdge, SpiFrameworkRole, SpiSymbol } from './types.js'

const EXPRESS_MODULE_SPECIFIER = 'express'

type ExpressBindings = {
  /** Local name(s) for the default `express` export — i.e., the factory
   *  callable that produces an app. Typically {'express'}. */
  appFactory: Set<string>
  /** Local name(s) for the named `Router` export. Typically {'Router'}. */
  routerFactory: Set<string>
  /** Local name(s) for namespace imports: `import * as e from 'express'`. */
  namespaceAlias: Set<string>
}

export type DetectExpressFrameworkContext = {
  sourceFile: ts.SourceFile
  fileId: string
  symbolsByFile: Map<string, SpiSymbol[]>
  /** Slice 1c-ii.c writes route_handler SpiEdges into this array when a
   *  named handler is resolved from a `<binding>.<httpMethod>(...)` call. */
  edges: SpiEdge[]
}

const HTTP_ROUTE_METHODS: ReadonlySet<string> = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'all',
  'options',
  'head',
])

export function detectExpressFramework(ctx: DetectExpressFrameworkContext): void {
  const bindings = collectExpressBindings(ctx.sourceFile)
  if (!hasAnyBinding(bindings)) return

  // Slice 1c-ii.b — substrate: tag app/router factory variables.
  // Track the (variable name → symbol) map for slice 1c-ii.c's route
  // walker so we can resolve `app.get(...)` against the tagged binding.
  const expressBindingSymbols = new Map<string, SpiSymbol>()
  for (const stmt of ctx.sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0
    const symbolKind: SpiSymbol['kind'] = isConst ? 'constant' : 'variable'
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      const role = factoryCallRole(decl.initializer, bindings)
      if (!role) continue
      const tagged = tagSymbol(ctx.symbolsByFile, ctx.fileId, symbolKind, decl.name.text, role)
      if (tagged && (role === 'express_app' || role === 'express_router')) {
        expressBindingSymbols.set(decl.name.text, tagged)
      }
    }
  }

  // Slice 1c-ii.c — route detection: walk every call expression in the
  // file. When the callee is `<binding>.<httpMethod>(...)` and `<binding>`
  // is a tagged express_app/express_router, resolve the LAST argument to
  // a named handler symbol in the same file. If found, tag the handler
  // with framework_role: 'express_route' and emit a route_handler edge.
  if (expressBindingSymbols.size === 0) return
  walkRouteCalls(ctx, expressBindingSymbols)
}

function walkRouteCalls(
  ctx: DetectExpressFrameworkContext,
  expressBindingSymbols: Map<string, SpiSymbol>,
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression
      if (ts.isIdentifier(callee.expression) && ts.isIdentifier(callee.name)) {
        const bindingName = callee.expression.text
        const httpMethod = callee.name.text
        const bindingSymbol = expressBindingSymbols.get(bindingName)
        if (bindingSymbol && HTTP_ROUTE_METHODS.has(httpMethod)) {
          emitRouteForCall(ctx, bindingSymbol, node)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ctx.sourceFile)
}

function emitRouteForCall(
  ctx: DetectExpressFrameworkContext,
  bindingSymbol: SpiSymbol,
  callExpr: ts.CallExpression,
): void {
  // The route handler is the last argument. Earlier args may be the path
  // string, parameter regexes, or middleware functions.
  const args = callExpr.arguments
  if (args.length === 0) return
  const handlerArg = args[args.length - 1]
  if (!handlerArg || !ts.isIdentifier(handlerArg)) return

  // Look up the handler in the file's symbol list. Match function or
  // constant/variable symbols by exact name; method symbols (with
  // ClassName.foo) and namespace symbols don't match the bare identifier
  // pattern callers use here.
  const handlerName = handlerArg.text
  const symbols = ctx.symbolsByFile.get(ctx.fileId) ?? []
  const handlerSymbol = symbols.find((s) =>
    s.name === handlerName && (s.kind === 'function' || s.kind === 'constant' || s.kind === 'variable'),
  )
  if (!handlerSymbol) return

  // Tag and emit edge. Multiple route registrations against the same
  // handler are common (the same fn registered on / and /alias). The
  // framework_role assignment is idempotent; the edge dedupe is the
  // caller's job (build.ts already passes edges through addUniqueEdge-
  // free push semantics, so we dedupe here).
  handlerSymbol.framework_role = 'express_route'
  const range = handlerSymbol.range
  const edgeKey = `${bindingSymbol.id}|${handlerSymbol.id}|route_handler`
  if (ctx.edges.some((e) => e.from === bindingSymbol.id && e.to === handlerSymbol.id && e.kind === 'route_handler')) {
    return
  }
  void edgeKey
  ctx.edges.push({
    from: bindingSymbol.id,
    to: handlerSymbol.id,
    kind: 'route_handler',
    confidence: 'high',
    source: 'framework-decorator',
    evidence: { file_id: ctx.fileId, range },
  })
}

function collectExpressBindings(sourceFile: ts.SourceFile): ExpressBindings {
  const bindings: ExpressBindings = {
    appFactory: new Set<string>(),
    routerFactory: new Set<string>(),
    namespaceAlias: new Set<string>(),
  }
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (stmt.moduleSpecifier.text !== EXPRESS_MODULE_SPECIFIER) continue

    // Default import: `import express from 'express'` — the local name is
    // the factory callable that yields an Express app.
    if (stmt.importClause.name) {
      bindings.appFactory.add(stmt.importClause.name.text)
    }

    const namedBindings = stmt.importClause.namedBindings
    if (!namedBindings) continue

    if (ts.isNamespaceImport(namedBindings)) {
      // `import * as e from 'express'` — both e() and e.Router() are
      // factory calls. We track the namespace alias and resolve member
      // accesses below.
      bindings.namespaceAlias.add(namedBindings.name.text)
      continue
    }

    if (ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text
        const localName = element.name.text
        if (importedName === 'Router') bindings.routerFactory.add(localName)
        // `import { default as express, Router } from 'express'` is the
        // explicit form of the default-import pattern above. Treat the
        // 'default' aliased import as an app factory.
        if (importedName === 'default') bindings.appFactory.add(localName)
      }
    }
  }
  return bindings
}

function hasAnyBinding(b: ExpressBindings): boolean {
  return b.appFactory.size > 0 || b.routerFactory.size > 0 || b.namespaceAlias.size > 0
}

function factoryCallRole(initializer: ts.Expression, bindings: ExpressBindings): SpiFrameworkRole | null {
  if (!ts.isCallExpression(initializer)) return null
  const callee = initializer.expression

  // `express()` — direct call to the app factory.
  if (ts.isIdentifier(callee) && bindings.appFactory.has(callee.text)) {
    return 'express_app'
  }

  // `e.Router()` or `e()` via a namespace import alias.
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ts.isIdentifier(callee.name)) {
    const namespaceName = callee.expression.text
    const memberName = callee.name.text
    if (bindings.namespaceAlias.has(namespaceName)) {
      if (memberName === 'Router') return 'express_router'
      // Namespace.default() is unusual but legal; treat as app factory.
      if (memberName === 'default') return 'express_app'
    }
  }

  // `Router()` — named-import call to the Router factory.
  if (ts.isIdentifier(callee) && bindings.routerFactory.has(callee.text)) {
    return 'express_router'
  }

  return null
}

function tagSymbol(
  symbolsByFile: Map<string, SpiSymbol[]>,
  fileId: string,
  kind: SpiSymbol['kind'],
  name: string,
  role: SpiFrameworkRole,
): SpiSymbol | null {
  const symbols = symbolsByFile.get(fileId)
  if (!symbols) return null
  for (const symbol of symbols) {
    if (symbol.kind === kind && symbol.name === name) {
      symbol.framework_role = role
      return symbol
    }
  }
  return null
}
