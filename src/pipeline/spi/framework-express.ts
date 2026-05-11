// SPI v1 — Express framework layer (slices 1c-ii.b through 1c-ii.e of
// #72).
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
// and a `route_handler` SpiEdge is emitted with confidence 'high'.
//
// Slice 1c-ii.d — middleware detection: walks `<binding>.use(...)` call
// expressions. Every Identifier argument that resolves to a top-level
// function/constant/variable in the same file is tagged with
// framework_role: 'express_middleware' (only when no other express_*
// role already exists; mounted routers keep their express_router tag).
//
// Slice 1c-ii.e — anonymous handler synthesis: when the route/middleware
// argument is an ArrowFunction or FunctionExpression instead of an
// Identifier (the common `app.get('/p', (req, res) => {...})` pattern),
// the detector mints a synthetic SpiSymbol with kind 'function' and a
// deterministic id derived from (file_id, binding name, http method,
// handler line). The synthetic symbol is tagged with the matching
// framework_role and pushed into BOTH the flat symbols list and the
// per-file index so it survives into the projector. For routes, the
// matching route_handler edge is emitted from the binding to the
// synthetic symbol.
//
// Future slice:
//
//   * 1c-ii.f — full byte-equivalence with the legacy
//     extract/frameworks/express.ts surface: route_path metadata on the
//     synthetic symbols (extends SpiSymbol with framework_metadata field),
//     mounted-router prefix resolution (`app.use('/api', usersRouter)` →
//     /api/... path prefix), dynamic compositions.

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
  /** Slice 1c-ii.e pushes synthesized inline-handler SpiSymbols into
   *  this flat list so they survive into the SPI's symbol set. The
   *  per-file index (symbolsByFile) is updated in lockstep — both
   *  references point to the same symbol objects, but only `symbols`
   *  is what buildSpi sorts/returns. */
  symbols: SpiSymbol[]
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
  // Slice 1c-ii.f — extract the optional path-prefix from the first arg
  // if it's a string literal. `app.use('/api', mw1, mw2)` → mount_path:
  // '/api'. Attached to every middleware symbol in the same call so
  // downstream consumers can see which prefix triggered the middleware.
  const args = callExpr.arguments
  const mountPath = args.length > 0 ? stringLiteralValue(args[0]) : null

  for (const arg of args) {
    let handlerSymbol: SpiSymbol | null = null
    if (ts.isIdentifier(arg)) {
      handlerSymbol = resolveHandlerSymbol(arg, ctx)
    } else if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
      handlerSymbol = mintSyntheticHandlerSymbol(ctx, callExpr, arg, 'express_middleware')
    }
    if (!handlerSymbol) continue
    // Never overwrite an existing framework_role. A symbol that already
    // has a role carries more semantic weight than the middleware
    // fallback:
    //   * express_route — the symbol was already detected as a route
    //     handler earlier in the same walk; route wins.
    //   * express_router — the symbol is a Router instance being mounted
    //     via `app.use(router)`. The mount call attaches the router to
    //     the app but the router's own role stays the more specific tag.
    //   * any future express_* role — same reasoning; middleware is the
    //     fallback for symbols that have no other Express identity.
    if (handlerSymbol.framework_role !== undefined && handlerSymbol.framework_role !== 'express_middleware') continue
    handlerSymbol.framework_role = 'express_middleware'
    if (mountPath !== null) {
      handlerSymbol.framework_metadata = {
        ...(handlerSymbol.framework_metadata ?? {}),
        mount_path: mountPath,
      }
    }
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
  if (!handlerArg) return

  // Slice 1c-ii.f — extract the route path string from the FIRST
  // argument if it's a string literal. \`app.get('/users/:id', ...)\` →
  // route_path: '/users/:id'. Dynamic paths (template literals, computed
  // expressions) are skipped — the metadata only carries statically
  // known values; consumers shouldn't trust a partial path.
  const routePath = stringLiteralValue(args[0])

  // Resolve the handler in priority order:
  //   1. Identifier — existing slice 1c-ii.c path.
  //   2. ArrowFunction / FunctionExpression — slice 1c-ii.e synthesizes
  //      a deterministic SpiSymbol for the anonymous callback.
  let handlerSymbol: SpiSymbol | null = null
  if (ts.isIdentifier(handlerArg)) {
    handlerSymbol = resolveHandlerSymbol(handlerArg, ctx)
  } else if (ts.isArrowFunction(handlerArg) || ts.isFunctionExpression(handlerArg)) {
    handlerSymbol = mintSyntheticHandlerSymbol(ctx, callExpr, handlerArg, 'express_route')
  }
  if (!handlerSymbol) return

  handlerSymbol.framework_role = 'express_route'
  if (routePath !== null) {
    handlerSymbol.framework_metadata = {
      ...(handlerSymbol.framework_metadata ?? {}),
      route_path: routePath,
    }
  }

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

/** Extract the value of a string-literal node (single or double-quoted,
 *  or a no-substitution template literal). Returns null for anything
 *  more complex — template literals with expressions, computed
 *  identifiers, etc. */
function stringLiteralValue(node: ts.Expression | undefined): string | null {
  if (!node) return null
  if (ts.isStringLiteral(node)) return node.text
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

/**
 * Slice 1c-ii.e — synthesize a SpiSymbol for an inline arrow or function
 * expression used as a route/middleware handler. The symbol's id is
 * deterministic across builds for the same source: derived from the
 * file_id, the binding identifier, the HTTP method (or "use" for
 * middleware), and the handler's starting line number. Two route
 * registrations at the same line on the same binding/method are rare
 * but would collide — accept the collision; the second push is a no-op
 * thanks to the seenEdgeKeys dedupe downstream.
 */
function mintSyntheticHandlerSymbol(
  ctx: DetectExpressFrameworkContext,
  callExpr: ts.CallExpression,
  handler: ts.ArrowFunction | ts.FunctionExpression,
  role: SpiFrameworkRole,
): SpiSymbol | null {
  const callee = callExpr.expression
  if (!ts.isPropertyAccessExpression(callee)) return null
  if (!ts.isIdentifier(callee.expression) || !ts.isIdentifier(callee.name)) return null
  const bindingName = callee.expression.text
  const methodName = callee.name.text
  const range = rangeOfNode(handler, ctx.sourceFile)
  const name = `${bindingName}.${methodName}.L${range.start.line}`
  const id = `symbol:${ctx.fileId}/function/${name}`

  // Don't re-mint if we already minted this one (e.g., on a second walk
  // over the same source file in a future pipeline change).
  const fileSymbols = ctx.symbolsByFile.get(ctx.fileId)
  if (fileSymbols) {
    const existing = fileSymbols.find((s) => s.id === id)
    if (existing) {
      existing.framework_role = role
      return existing
    }
  }

  const synthetic: SpiSymbol = {
    id,
    file_id: ctx.fileId,
    name,
    kind: 'function',
    range,
    exported: false,
    framework_role: role,
  }
  ctx.symbols.push(synthetic)
  if (fileSymbols) fileSymbols.push(synthetic)
  else ctx.symbolsByFile.set(ctx.fileId, [synthetic])
  return synthetic
}

function rangeOfNode(node: ts.Node, sourceFile: ts.SourceFile): SpiSymbol['range'] {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd())
  return {
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  }
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
