import ts from 'typescript'

import type { IndexEdge, IndexFrameworkRole, IndexSymbol } from '../../domain/index/model.js'

export type FrameworkIdentifierContext = {
  symbolsByFile: Map<string, IndexSymbol[]>
  checker?: ts.TypeChecker
  pathToFileId?: Map<string, string>
}

export type FrameworkHttpContext = FrameworkIdentifierContext & {
  sourceFile: ts.SourceFile
  fileId: string
  symbols: IndexSymbol[]
  edges: IndexEdge[]
  checker: ts.TypeChecker
  pathToFileId: Map<string, string>
}

export function tagLocal(ctx: FrameworkHttpContext, name: string, role: IndexFrameworkRole): IndexSymbol | null {
  const symbol = (ctx.symbolsByFile.get(ctx.fileId) ?? []).find((candidate) => candidate.name === name)
  if (symbol && symbol.framework_role === undefined) symbol.framework_role = role
  return symbol ?? null
}

export function resolveOrMintHandler(
  ctx: FrameworkHttpContext,
  expr: ts.Expression,
  framework: string,
  role: IndexFrameworkRole,
): IndexSymbol | null {
  if (ts.isIdentifier(expr)) {
    const resolved = resolveIdentifier(ctx, expr)
    if (resolved && ['function', 'constant', 'variable'].includes(resolved.kind)) {
      if (resolved.framework_role === undefined) resolved.framework_role = role
      return resolved
    }
  }
  if (!ts.isArrowFunction(expr) && !ts.isFunctionExpression(expr)) return null
  const range = rangeOf(expr, ctx.sourceFile)
  const name = `${framework}.${role}.L${range.start.line}.C${range.start.column}`
  const existing = (ctx.symbolsByFile.get(ctx.fileId) ?? []).find((symbol) => symbol.name === name)
  if (existing) return existing
  const symbol: IndexSymbol = {
    id: `symbol:${ctx.fileId}/function/${name}`,
    file_id: ctx.fileId,
    name,
    kind: 'function',
    range,
    exported: false,
    framework_role: role,
  }
  ctx.symbols.push(symbol)
  const fileSymbols = ctx.symbolsByFile.get(ctx.fileId)
  if (fileSymbols) fileSymbols.push(symbol)
  else ctx.symbolsByFile.set(ctx.fileId, [symbol])
  return symbol
}

export function resolveIdentifier(ctx: FrameworkIdentifierContext, identifier: ts.Identifier): IndexSymbol | null {
  if (!ctx.checker || !ctx.pathToFileId) return null
  const declaration = resolvedDeclaration(identifier, ctx.checker)
  if (!declaration || !isTopLevelDeclaration(declaration)) return null
  const fileId = ctx.pathToFileId.get(declaration.getSourceFile().fileName.replaceAll('\\', '/'))
  const name = declarationName(declaration)
  const kind = declarationKind(declaration)
  if (!fileId || !name || !kind) return null
  const range = rangeOf(declaration, declaration.getSourceFile())
  return (ctx.symbolsByFile.get(fileId) ?? []).find((candidate) =>
    candidate.name === name
    && candidate.kind === kind
    && containsRange(candidate.range, range),
  ) ?? null
}

export function resolvedDeclaration(expr: ts.Expression | undefined, checker: ts.TypeChecker): ts.Declaration | undefined {
  if (!expr || !ts.isIdentifier(expr)) return undefined
  let symbol = ts.isShorthandPropertyAssignment(expr.parent) && expr.parent.name === expr
    ? checker.getShorthandAssignmentValueSymbol(expr.parent)
    : checker.getSymbolAtLocation(expr)
  if ((symbol?.flags ?? 0) & ts.SymbolFlags.Alias) {
    try { symbol = checker.getAliasedSymbol(symbol as ts.Symbol) } catch { return undefined }
  }
  return symbol?.declarations?.[0]
}

export function isTopLevelDeclaration(decl: ts.Declaration): boolean {
  if (ts.isFunctionDeclaration(decl)) return ts.isSourceFile(decl.parent)
  if (!ts.isVariableDeclaration(decl)) return false
  const statement = decl.parent.parent
  return ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent)
}

function declarationName(decl: ts.Declaration): string | null {
  if (ts.isFunctionDeclaration(decl) && decl.name) return decl.name.text
  if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) return decl.name.text
  return null
}

function declarationKind(decl: ts.Declaration): IndexSymbol['kind'] | null {
  if (ts.isFunctionDeclaration(decl)) return 'function'
  if (!ts.isVariableDeclaration(decl) || !ts.isVariableDeclarationList(decl.parent)) return null
  return (decl.parent.flags & ts.NodeFlags.Const) !== 0 ? 'constant' : 'variable'
}

function containsRange(outer: IndexSymbol['range'], inner: IndexSymbol['range']): boolean {
  return comparePosition(outer.start, inner.start) <= 0 && comparePosition(outer.end, inner.end) >= 0
}

function comparePosition(left: IndexSymbol['range']['start'], right: IndexSymbol['range']['start']): number {
  return left.line - right.line || left.column - right.column
}

export function mergeFrameworkMetadata(symbol: IndexSymbol, metadata: Record<string, unknown>): void {
  symbol.framework_metadata = { ...(symbol.framework_metadata ?? {}), ...metadata }
}

export function emitFrameworkEdge(
  ctx: FrameworkHttpContext,
  from: IndexSymbol,
  to: IndexSymbol,
  call: ts.CallExpression,
  metadata: Record<string, unknown>,
): void {
  ctx.edges.push({
    from: from.id,
    to: to.id,
    kind: 'route_handler',
    confidence: 'high',
    source: 'typescript-semantic',
    evidence: { file_id: ctx.fileId, range: rangeOf(call, ctx.sourceFile) },
    metadata,
  })
}

export function stringValue(expr: ts.Expression | undefined): string | null {
  return expr && ts.isStringLiteralLike(expr) ? expr.text : null
}

export function rangeOf(node: ts.Node, sourceFile: ts.SourceFile): IndexSymbol['range'] {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd())
  return {
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  }
}
