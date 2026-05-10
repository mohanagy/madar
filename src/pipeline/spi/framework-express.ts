// SPI v1 — Express framework layer (slices 1c-ii.b + 1c-ii.c + 1c-ii.d
// of #72).
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
// the handler's symbol with confidence 'high'.
//
// Slice 1c-ii.d — middleware detection: walks `<binding>.use(...)` call
// expressions. Every Identifier argument that resolves to a top-level
// function/constant/variable in the same file is tagged with
// framework_role: 'express_middleware'. The optional first string-
// literal path argument (`app.use('/api', mw1, mw2)`) is skipped. No
// edge is emitted for middleware — the framework_role tag plus
// projector layer (slice 1c-ii.a's framework propagation) is enough to
// surface 'framework: express, framework_role: express_middleware' on
// the consumer side. Inline arrow middleware is deferred to slice
// 1c-ii.e (same anonymous-callback synthesis territory as inline route
// handlers).
//
// Future slice:
//
//   * 1c-ii.e — full byte-equivalence with the legacy
//     extract/frameworks/express.ts surface (~1,669 lines): synthetic
//     route nodes with route_path, mounted-router prefix resolution,
//     dynamic compositions, anonymous-callback handler synthesis.

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
  /** Type checker for the program — used to resolve callee/handler
   *  identifiers to their *declarations* so lexical shadows don't
   *  produce false-positive route tags (CodeRabbit catch on slice
   *  1c-ii.c). When omitted, the detector falls back to bare-name
   *  matching, which is correct only when no inner scope shadows the
   *  receiver or handler identifier. */
  checker?: ts.TypeChecker
}

/** Internal record: pairs a tagged Express binding's SpiSymbol with the
 *  ts.VariableDeclaration that produced it, so call-site resolution can
 *  verify a `<id>.method(...)` callee resolves back to the SAME
 *  declaration instead of any other binding that happens to share the
 *  identifier text. */
type ExpressBindingRecord = {
  spiSymbol: SpiSymbol
  declaration: ts.VariableDeclaration
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
  // Slice 1c-ii.c — record (name → { spiSymbol, declaration }) so the
  // route walker can verify call-site receivers resolve back to the
  // SAME declaration (defends against lexical shadows where an inner
  // `const app = { get: ... }` would otherwise hijack the outer
  // express_app binding).
  const expressBindings = new Map<string, ExpressBindingRecord>()
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
        expressBindings.set(decl.name.text, { spiSymbol: tagged, declaration: decl })
      }
    }
  }

  // Slice 1c-ii.c — route detection: walk every call expression in the
  // file. When the callee is `<binding>.<httpMethod>(...)` and `<binding>`
  // is a tagged express_app/express_router (verified by declaration
  // identity, not bare name), resolve the LAST argument to a named
  // handler symbol in the same file. If found, tag the handler with
  // framework_role: 'express_route' and emit a route_handler edge.
  if (expressBindings.size === 0) return
  walkRouteCalls(ctx, expressBindings)
}

function walkRouteCalls(
  ctx: DetectExpressFrameworkContext,
  expressBindings: Map<string, ExpressBindingRecord>,
): void {
  // O(1) edge-dedupe set keyed by `${from}|${to}|route_handler`. Replaces
  // the previous O(n) linear scan over ctx.edges per candidate.
  const seenEdgeKeys = new Set<string>()
  for (const edge of ctx.edges) {
    if (edge.kind === 'route_handler') {
      seenEdgeKeys.add(`${edge.from}|${edge.to}|route_handler`)
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression
      if (ts.isIdentifier(callee.expression) && ts.isIdentifier(callee.name)) {
        const bindingName = callee.expression.text
        const methodName = callee.name.text
        const bindingRecord = expressBindings.get(bindingName)
        if (bindingRecord && receiverMatchesBinding(callee.expression, bindingRecord, ctx.checker)) {
          if (HTTP_ROUTE_METHODS.has(methodName)) {
            emitRouteForCall(ctx, bindingRecord.spiSymbol, node, seenEdgeKeys)
          } else if (methodName === 'use') {
            // Slice 1c-ii.d — middleware detection.
            emitMiddlewareForCall(ctx, node)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ctx.sourceFile)
}

function emitMiddlewareForCall(
  ctx: DetectExpressFrameworkContext,
  callExpr: ts.CallExpression,
): void {
  // Iterate every argument. String-literal path prefixes (e.g.,
  // `app.use('/api', mw)`) are skipped — they're routing metadata, not
  // middleware. Every Identifier that resolves to a top-level
  // function/const/var in the same file is tagged with
  // framework_role: 'express_middleware'. Inline arrow middleware
  // (`app.use((req, res, next) => {...})`) is intentionally skipped;
  // tagging anonymous callbacks requires the symbol-synthesis layer
  // that lands in slice 1c-ii.e.
  for (const arg of callExpr.arguments) {
    if (!ts.isIdentifier(arg)) continue
    const handlerSymbol = resolveHandlerSymbol(arg, ctx)
    if (!handlerSymbol) continue
    // If a symbol is BOTH used as a route handler and a middleware in the
    // same file, the route-handler tag wins (it carries more semantic
    // weight). The express_route role is set first because route
    // detection runs in the same walk; only set express_middleware when
    // the symbol isn't already framework-role-tagged.
    if (handlerSymbol.framework_role === 'express_route') continue
    handlerSymbol.framework_role = 'express_middleware'
  }
}

/** Returns true iff the call-site receiver identifier resolves to the
 *  SAME declaration that we tagged earlier. Without a checker we fall
 *  back to bare-name matching (the legacy behavior), which can produce
 *  false positives in shadowed inner scopes. With a checker we walk the
 *  resolved ts.Symbol's declarations and compare against the tagged
 *  ts.VariableDeclaration node directly. */
function receiverMatchesBinding(
  identifier: ts.Identifier,
  bindingRecord: ExpressBindingRecord,
  checker: ts.TypeChecker | undefined,
): boolean {
  if (!checker) return true
  const tsSymbol = checker.getSymbolAtLocation(identifier)
  const declarations = tsSymbol?.declarations
  if (!declarations || declarations.length === 0) return false
  return declarations.some((decl) => decl === bindingRecord.declaration)
}

function emitRouteForCall(
  ctx: DetectExpressFrameworkContext,
  bindingSymbol: SpiSymbol,
  callExpr: ts.CallExpression,
  seenEdgeKeys: Set<string>,
): void {
  // The route handler is the last argument. Earlier args may be the path
  // string, parameter regexes, or middleware functions.
  const args = callExpr.arguments
  if (args.length === 0) return
  const handlerArg = args[args.length - 1]
  if (!handlerArg || !ts.isIdentifier(handlerArg)) return

  // Resolve the handler. With a checker, prefer declaration-identity
  // resolution so shadowed inner handlers don't tag the outer symbol.
  const handlerSymbol = resolveHandlerSymbol(handlerArg, ctx)
  if (!handlerSymbol) return

  handlerSymbol.framework_role = 'express_route'
  const range = handlerSymbol.range
  const edgeKey = `${bindingSymbol.id}|${handlerSymbol.id}|route_handler`
  if (seenEdgeKeys.has(edgeKey)) return
  seenEdgeKeys.add(edgeKey)
  ctx.edges.push({
    from: bindingSymbol.id,
    to: handlerSymbol.id,
    kind: 'route_handler',
    confidence: 'high',
    source: 'framework-decorator',
    evidence: { file_id: ctx.fileId, range },
  })
}

function resolveHandlerSymbol(
  handlerIdentifier: ts.Identifier,
  ctx: DetectExpressFrameworkContext,
): SpiSymbol | null {
  const symbols = ctx.symbolsByFile.get(ctx.fileId) ?? []
  const handlerName = handlerIdentifier.text

  // With a checker, resolve the identifier to its declaration and only
  // accept top-level declarations (parent === SourceFile or a
  // top-level VariableStatement). This rejects shadowed inner scopes.
  if (ctx.checker) {
    const tsSymbol = ctx.checker.getSymbolAtLocation(handlerIdentifier)
    const declarations = tsSymbol?.declarations
    if (!declarations || declarations.length === 0) return null
    const isTopLevel = declarations.some((decl) => isTopLevelDeclaration(decl))
    if (!isTopLevel) return null
  }

  return symbols.find((s) =>
    s.name === handlerName && (s.kind === 'function' || s.kind === 'constant' || s.kind === 'variable'),
  ) ?? null
}

function isTopLevelDeclaration(decl: ts.Declaration): boolean {
  // Function declarations: `function foo() {}` directly under a SourceFile.
  if (ts.isFunctionDeclaration(decl)) return ts.isSourceFile(decl.parent)
  // Variable declarations: `const foo = ...` — parent chain is
  // VariableDeclaration → VariableDeclarationList → VariableStatement →
  // SourceFile.
  if (ts.isVariableDeclaration(decl)) {
    const list = decl.parent
    const stmt = list.parent
    return ts.isVariableStatement(stmt) && ts.isSourceFile(stmt.parent)
  }
  return false
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
