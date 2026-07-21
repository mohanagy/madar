
import ts from 'typescript'

import type { IndexEdge, IndexFrameworkRole, IndexSymbol } from '../../domain/index/model.js'

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
  symbolsByFile: Map<string, IndexSymbol[]>
  /** Flat canonical symbol list, including synthesized handlers. */
  symbols: IndexSymbol[]
  edges: IndexEdge[]
  /** Resolves declarations so lexical shadows do not become route facts. */
  checker?: ts.TypeChecker
  /** Resolves imported routers to canonical file facts. */
  pathToFileId?: Map<string, string>
}

type ExpressBindingRecord = {
  symbol: IndexSymbol
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

  const expressBindings = new Map<string, ExpressBindingRecord>()
  for (const stmt of ctx.sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0
    const symbolKind: IndexSymbol['kind'] = isConst ? 'constant' : 'variable'
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      const role = factoryCallRole(decl.initializer, bindings)
      if (!role) continue
      const tagged = tagSymbol(ctx.symbolsByFile, ctx.fileId, symbolKind, decl.name.text, role)
      if (tagged && (role === 'express_app' || role === 'express_router')) {
        expressBindings.set(decl.name.text, { symbol: tagged, declaration: decl })
      }
    }
  }

  if (expressBindings.size === 0) return
  walkRouteCalls(ctx, expressBindings)
}

function walkRouteCalls(
  ctx: DetectExpressFrameworkContext,
  expressBindings: Map<string, ExpressBindingRecord>,
): void {
  const seenEdgeKeys = new Set<string>()
  for (const edge of ctx.edges) {
    const range = edge.evidence?.range
    if (edge.kind === 'route_handler' && range) seenEdgeKeys.add(
      `${edge.from}|${edge.to}|${range.start.line}:${range.start.column}|${range.end.line}:${range.end.column}`,
    )
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
            emitRouteForCall(ctx, bindingRecord.symbol, node, seenEdgeKeys, methodName)
          } else if (methodName === 'use') {
            emitMiddlewareForCall(ctx, bindingRecord.symbol, node, seenEdgeKeys)
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
  bindingSymbol: IndexSymbol,
  callExpr: ts.CallExpression,
  seenEdgeKeys: Set<string>,
): void {
  const args = callExpr.arguments
  const mountPath = args.length > 0 ? stringLiteralValue(args[0]) : null

  for (const arg of args) {
    let handlerSymbol: IndexSymbol | null = null
    if (ts.isIdentifier(arg)) {
      handlerSymbol = resolveHandlerSymbol(arg, ctx)
      if (!handlerSymbol) {
        handlerSymbol = resolveCrossFileSymbol(arg, ctx)
      }
    } else if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
      handlerSymbol = mintSyntheticHandlerSymbol(ctx, callExpr, arg, 'express_middleware')
    }
    if (!handlerSymbol) continue

    if (mountPath !== null) {
      handlerSymbol.framework_metadata = {
        ...(handlerSymbol.framework_metadata ?? {}),
        mount_path: mountPath,
      }
    }

    if (handlerSymbol.framework_role === undefined) handlerSymbol.framework_role = 'express_middleware'
    emitHandlerEdge(ctx, bindingSymbol, handlerSymbol, callExpr, seenEdgeKeys, mountPath === null
      ? {}
      : { mount_path: mountPath })
  }
}

/** Apply mounted-router prefixes after all Express files are indexed. */
export function finalizeExpressMountPrefixes(opts: {
  symbols: IndexSymbol[]
  edges: IndexEdge[]
}): void {
  const routerById = new Map<string, IndexSymbol>()
  const routeHandlerById = new Map<string, IndexSymbol>()
  for (const sym of opts.symbols) {
    if (sym.framework_role === 'express_router') routerById.set(sym.id, sym)
    if (sym.framework_role === 'express_route') routeHandlerById.set(sym.id, sym)
  }

  for (const edge of opts.edges) {
    if (edge.kind !== 'route_handler') continue
    const router = routerById.get(edge.from)
    if (!router) continue
    const mountPath = router.framework_metadata?.mount_path
    if (typeof mountPath !== 'string' || mountPath.length === 0) continue
    const handler = routeHandlerById.get(edge.to)
    if (!handler) continue
    const existingPath = handler.framework_metadata?.route_path
    if (typeof existingPath !== 'string') continue
    handler.framework_metadata = {
      ...(handler.framework_metadata ?? {}),
      route_path: joinRoutePath(mountPath, existingPath),
    }
  }
}

function joinRoutePath(prefix: string, path: string): string {
  const cleanPrefix = prefix.replace(/\/+$/, '')
  if (path === '/' || path === '') return cleanPrefix === '' ? '/' : cleanPrefix
  const cleanPath = path.startsWith('/') ? path : '/' + path
  return cleanPrefix + cleanPath
}

/** Require the call receiver to resolve to the declaration that was tagged. */
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
  bindingSymbol: IndexSymbol,
  callExpr: ts.CallExpression,
  seenEdgeKeys: Set<string>,
  httpMethod: string,
): void {
  const args = callExpr.arguments
  if (args.length === 0) return
  const handlerArg = args[args.length - 1]
  if (!handlerArg) return

  const routePath = stringLiteralValue(args[0])

  let handlerSymbol: IndexSymbol | null = null
  if (ts.isIdentifier(handlerArg)) {
    handlerSymbol = resolveHandlerSymbol(handlerArg, ctx) ?? resolveCrossFileSymbol(handlerArg, ctx)
  } else if (ts.isArrowFunction(handlerArg) || ts.isFunctionExpression(handlerArg)) {
    handlerSymbol = mintSyntheticHandlerSymbol(ctx, callExpr, handlerArg, 'express_route')
  }
  if (!handlerSymbol) return

  handlerSymbol.framework_role = 'express_route'
  if (routePath !== null) {
    handlerSymbol.framework_metadata = {
      ...(handlerSymbol.framework_metadata ?? {}),
      route_path: routePath,
      http_method: httpMethod.toUpperCase(),
    }
  }

  emitHandlerEdge(ctx, bindingSymbol, handlerSymbol, callExpr, seenEdgeKeys, {
    ...(routePath === null ? {} : { route_path: routePath }),
    http_method: httpMethod.toUpperCase(),
  })
}

function emitHandlerEdge(
  ctx: DetectExpressFrameworkContext,
  bindingSymbol: IndexSymbol,
  handlerSymbol: IndexSymbol,
  callExpr: ts.CallExpression,
  seenEdgeKeys: Set<string>,
  metadata: Record<string, unknown>,
): void {
  const range = rangeOfNode(callExpr, ctx.sourceFile)
  const edgeKey = `${bindingSymbol.id}|${handlerSymbol.id}|${range.start.line}:${range.start.column}|${range.end.line}:${range.end.column}`
  if (seenEdgeKeys.has(edgeKey)) return
  seenEdgeKeys.add(edgeKey)
  ctx.edges.push({
    from: bindingSymbol.id,
    to: handlerSymbol.id,
    kind: 'route_handler',
    confidence: 'high',
    source: 'typescript-semantic',
    evidence: { file_id: ctx.fileId, range },
    metadata,
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

/** Synthesize a stable symbol for an inline route or middleware handler. */
function mintSyntheticHandlerSymbol(
  ctx: DetectExpressFrameworkContext,
  callExpr: ts.CallExpression,
  handler: ts.ArrowFunction | ts.FunctionExpression,
  role: IndexFrameworkRole,
): IndexSymbol | null {
  const callee = callExpr.expression
  if (!ts.isPropertyAccessExpression(callee)) return null
  if (!ts.isIdentifier(callee.expression) || !ts.isIdentifier(callee.name)) return null
  const bindingName = callee.expression.text
  const methodName = callee.name.text
  const range = rangeOfNode(handler, ctx.sourceFile)
  const name = `${bindingName}.${methodName}.L${range.start.line}`
  const id = `symbol:${ctx.fileId}/function/${name}`

  const fileSymbols = ctx.symbolsByFile.get(ctx.fileId)
  if (fileSymbols) {
    const existing = fileSymbols.find((s) => s.id === id)
    if (existing) {
      existing.framework_role = role
      return existing
    }
  }

  const synthetic: IndexSymbol = {
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

function rangeOfNode(node: ts.Node, sourceFile: ts.SourceFile): IndexSymbol['range'] {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd())
  return {
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  }
}

/** Resolve an imported mounted router back to its canonical symbol. */
function resolveCrossFileSymbol(
  identifier: ts.Identifier,
  ctx: DetectExpressFrameworkContext,
): IndexSymbol | null {
  if (!ctx.checker || !ctx.pathToFileId) return null
  const localSymbol = ctx.checker.getSymbolAtLocation(identifier)
  if (!localSymbol) return null
  const aliasedSymbol = (localSymbol.flags & ts.SymbolFlags.Alias) !== 0
    ? safeGetAliasedSymbol(localSymbol, ctx.checker)
    : localSymbol
  if (!aliasedSymbol) return null
  const declaration = aliasedSymbol.declarations?.[0]
  if (!declaration) return null
  if (!isTopLevelDeclaration(declaration)) return null

  const declSourceFile = declaration.getSourceFile()
  const declaredFileId = ctx.pathToFileId.get(declSourceFile.fileName)
  if (!declaredFileId) return null

  const declName = declaredName(declaration)
  if (!declName) return null
  const fileSymbols = ctx.symbolsByFile.get(declaredFileId) ?? []
  return fileSymbols.find((s) =>
    s.name === declName && (s.kind === 'function' || s.kind === 'constant' || s.kind === 'variable'),
  ) ?? null
}

function safeGetAliasedSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol | null {
  try {
    return checker.getAliasedSymbol(symbol)
  } catch {
    return null
  }
}

function declaredName(decl: ts.Declaration): string | null {
  if (ts.isFunctionDeclaration(decl) && decl.name) return decl.name.text
  if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) return decl.name.text
  return null
}

function resolveHandlerSymbol(
  handlerIdentifier: ts.Identifier,
  ctx: DetectExpressFrameworkContext,
): IndexSymbol | null {
  const symbols = ctx.symbolsByFile.get(ctx.fileId) ?? []
  const handlerName = handlerIdentifier.text

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
  if (ts.isFunctionDeclaration(decl)) return ts.isSourceFile(decl.parent)
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

    if (stmt.importClause.name) {
      bindings.appFactory.add(stmt.importClause.name.text)
    }

    const namedBindings = stmt.importClause.namedBindings
    if (!namedBindings) continue

    if (ts.isNamespaceImport(namedBindings)) {
      bindings.namespaceAlias.add(namedBindings.name.text)
      continue
    }

    if (ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text
        const localName = element.name.text
        if (importedName === 'Router') bindings.routerFactory.add(localName)
        if (importedName === 'default') bindings.appFactory.add(localName)
      }
    }
  }
  return bindings
}

function hasAnyBinding(b: ExpressBindings): boolean {
  return b.appFactory.size > 0 || b.routerFactory.size > 0 || b.namespaceAlias.size > 0
}

function factoryCallRole(initializer: ts.Expression, bindings: ExpressBindings): IndexFrameworkRole | null {
  if (!ts.isCallExpression(initializer)) return null
  const callee = initializer.expression

  if (ts.isIdentifier(callee) && bindings.appFactory.has(callee.text)) {
    return 'express_app'
  }

  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ts.isIdentifier(callee.name)) {
    const namespaceName = callee.expression.text
    const memberName = callee.name.text
    if (bindings.namespaceAlias.has(namespaceName)) {
      if (memberName === 'Router') return 'express_router'
      if (memberName === 'default') return 'express_app'
    }
  }

  if (ts.isIdentifier(callee) && bindings.routerFactory.has(callee.text)) {
    return 'express_router'
  }

  return null
}

function tagSymbol(
  symbolsByFile: Map<string, IndexSymbol[]>,
  fileId: string,
  kind: IndexSymbol['kind'],
  name: string,
  role: IndexFrameworkRole,
): IndexSymbol | null {
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
