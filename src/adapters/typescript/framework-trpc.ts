import ts from 'typescript'

import type { IndexEdge, IndexFrameworkRole, IndexSymbol } from '../../domain/index/model.js'

const PROCEDURE_ROLES: ReadonlyMap<string, IndexFrameworkRole> = new Map([
  ['query', 'trpc_procedure_query'],
  ['mutation', 'trpc_procedure_mutation'],
  ['subscription', 'trpc_procedure_subscription'],
])

export type DetectTrpcFrameworkContext = {
  sourceFile: ts.SourceFile
  fileId: string
  symbolsByFile: Map<string, IndexSymbol[]>
  symbols: IndexSymbol[]
  edges: IndexEdge[]
  checker: ts.TypeChecker
}

export function detectTrpcFramework(ctx: DetectTrpcFrameworkContext): void {
  forEachVariable(ctx.sourceFile, (decl) => {
    if (!decl.initializer || !isDerivedCall(decl.initializer, 'router', ctx.checker)) return
    const call = decl.initializer as ts.CallExpression
    const config = call.arguments[0]
    if (!config || !ts.isObjectLiteralExpression(config)) return
    const router = tagSymbol(ctx, decl.name.text, 'trpc_router')
    if (!router) return
    for (const prop of config.properties) {
      if (!ts.isPropertyAssignment(prop)) continue
      const name = propertyName(prop.name)
      const role = procedureRole(prop.initializer, ctx.checker)
      if (!name || !role) continue
      const procedure = synthesizeProcedure(ctx, name, role, decl.name.text, prop)
      ctx.edges.push({
        from: router.id,
        to: procedure.id,
        kind: 'route_handler',
        confidence: 'high',
        source: 'typescript-semantic',
        evidence: { file_id: ctx.fileId, range: rangeOf(prop, ctx.sourceFile) },
        metadata: { procedure_name: name },
      })
    }
  })
}

function forEachVariable(sourceFile: ts.SourceFile, visit: (decl: ts.VariableDeclaration & { name: ts.Identifier }) => void): void {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) visit(decl as ts.VariableDeclaration & { name: ts.Identifier })
    }
  }
}

type TrpcDerivation = 'instance' | 'router' | 'procedure'

function procedureRole(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): IndexFrameworkRole | null {
  if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) return null
  const role = PROCEDURE_ROLES.get(expr.expression.name.text) ?? null
  return role && deriveTrpc(expr.expression.expression, checker, new Set()) === 'procedure' ? role : null
}

function isDerivedCall(expr: ts.Expression, kind: TrpcDerivation, checker: ts.TypeChecker): boolean {
  return ts.isCallExpression(expr) && deriveTrpc(expr.expression, checker, new Set()) === kind
}

function deriveTrpc(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Declaration>,
): TrpcDerivation | null {
  if (ts.isParenthesizedExpression(expr)) return deriveTrpc(expr.expression, checker, seen)
  if (ts.isCallExpression(expr)) {
    if (isInitCreateCall(expr)) return 'instance'
    return deriveTrpc(expr.expression, checker, seen)
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const base = deriveTrpc(expr.expression, checker, seen)
    if (base === 'instance' && expr.name.text === 'router') return 'router'
    if (base === 'instance' && expr.name.text === 'procedure') return 'procedure'
    if (base === 'procedure') return 'procedure'
    return null
  }
  if (!ts.isIdentifier(expr)) return null
  const declaration = resolvedDeclaration(expr, checker)
  if (!declaration || seen.has(declaration) || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return null
  seen.add(declaration)
  return deriveTrpc(declaration.initializer, checker, seen)
}

function isInitCreateCall(expr: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(expr.expression) || expr.expression.name.text !== 'create') return false
  let root: ts.Expression = expr.expression.expression
  while (ts.isCallExpression(root) || ts.isPropertyAccessExpression(root)) {
    root = ts.isCallExpression(root) ? root.expression : root.expression
  }
  return ts.isIdentifier(root) && isNamedImport(root, '@trpc/server', 'initTRPC')
}

function isNamedImport(identifier: ts.Identifier, module: string, importedName: string): boolean {
  for (const stmt of identifier.getSourceFile().statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (stmt.moduleSpecifier.text !== module) continue
    const named = stmt.importClause.namedBindings
    if (!named || !ts.isNamedImports(named)) continue
    if (named.elements.some((element) =>
      element.name.text === identifier.text
      && (element.propertyName?.text ?? element.name.text) === importedName,
    )) return true
  }
  return false
}

function resolvedDeclaration(identifier: ts.Identifier, checker: ts.TypeChecker): ts.Declaration | null {
  let symbol = checker.getSymbolAtLocation(identifier)
  if ((symbol?.flags ?? 0) & ts.SymbolFlags.Alias) {
    try { symbol = checker.getAliasedSymbol(symbol as ts.Symbol) } catch { return null }
  }
  return symbol?.declarations?.[0] ?? null
}

function synthesizeProcedure(
  ctx: DetectTrpcFrameworkContext,
  name: string,
  role: IndexFrameworkRole,
  routerName: string,
  prop: ts.PropertyAssignment,
): IndexSymbol {
  const existing = (ctx.symbolsByFile.get(ctx.fileId) ?? []).find((symbol) =>
    symbol.name === name && symbol.framework_role === undefined,
  )
  if (existing) {
    existing.framework_role = role
    existing.framework_metadata = { procedure_name: name, router_name: routerName }
    return existing
  }
  const range = rangeOf(prop, ctx.sourceFile)
  const symbol: IndexSymbol = {
    id: `symbol:${ctx.fileId}/function/${routerName}.${name}.L${range.start.line}`,
    file_id: ctx.fileId,
    name: `${routerName}.${name}`,
    kind: 'function',
    range,
    exported: false,
    framework_role: role,
    framework_metadata: { procedure_name: name, router_name: routerName },
  }
  ctx.symbols.push(symbol)
  const fileSymbols = ctx.symbolsByFile.get(ctx.fileId)
  if (fileSymbols) fileSymbols.push(symbol)
  else ctx.symbolsByFile.set(ctx.fileId, [symbol])
  return symbol
}

function tagSymbol(ctx: DetectTrpcFrameworkContext, name: string, role: IndexFrameworkRole): IndexSymbol | null {
  const symbol = (ctx.symbolsByFile.get(ctx.fileId) ?? []).find((candidate) =>
    candidate.name === name && candidate.framework_role === undefined,
  )
  if (symbol) symbol.framework_role = role
  return symbol ?? null
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null
}

function rangeOf(node: ts.Node, sourceFile: ts.SourceFile): IndexSymbol['range'] {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd())
  return {
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  }
}
