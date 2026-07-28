import ts from 'typescript'

import type { IndexEdge, IndexFrameworkRole, IndexStorageOperation, IndexSymbol } from '../../domain/index/model.js'

type PrismaOperation = IndexStorageOperation
const READS = new Set<PrismaOperation>([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany',
  'count', 'aggregate', 'groupBy',
])
const WRITES = new Set<PrismaOperation>([
  'create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert', '$transaction',
])

export type DetectPrismaFrameworkContext = {
  sourceFile: ts.SourceFile
  fileId: string
  symbolsByFile: Map<string, IndexSymbol[]>
  symbols: IndexSymbol[]
  edges: IndexEdge[]
  checker: ts.TypeChecker
}

export function detectPrismaFramework(ctx: DetectPrismaFrameworkContext): void {
  const localClasses = prismaClassBindings(ctx.sourceFile)
  for (const stmt of ctx.sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      if (isPrismaConstruction(decl.initializer, localClasses)) {
        tagSymbol(ctx, decl.name.text, 'prisma_client')
      }
    }
  }

  const seen = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const detected = detectOperation(node.expression)
      if (detected && isPrismaIdentifier(detected.root, ctx, new Set())) {
        const operation = synthesizeOperation(ctx, node, detected.operation, seen)
        const caller = enclosingSymbol(node, ctx)
        if (operation && caller) {
          ctx.edges.push({
            from: caller.id,
            to: operation.id,
            kind: 'calls',
            confidence: 'high',
            source: 'typescript-semantic',
            evidence: { file_id: ctx.fileId, range: rangeOf(node, ctx.sourceFile) },
            metadata: { storage_operation: detected.operation },
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ctx.sourceFile)
}

function prismaClassBindings(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (stmt.moduleSpecifier.text !== '@prisma/client') continue
    const named = stmt.importClause.namedBindings
    if (!named || !ts.isNamedImports(named)) continue
    for (const element of named.elements) {
      if ((element.propertyName?.text ?? element.name.text) === 'PrismaClient') names.add(element.name.text)
    }
  }
  return names
}

function isPrismaConstruction(expr: ts.Expression, classes: ReadonlySet<string>): boolean {
  return ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && classes.has(expr.expression.text)
}

function detectOperation(expression: ts.LeftHandSideExpression): { root: ts.Identifier; operation: PrismaOperation } | null {
  if (!ts.isPropertyAccessExpression(expression)) return null
  const operation = expression.name.text as PrismaOperation
  if (!READS.has(operation) && !WRITES.has(operation)) return null
  if (operation === '$transaction') {
    return ts.isIdentifier(expression.expression) ? { root: expression.expression, operation } : null
  }
  const model = expression.expression
  return ts.isPropertyAccessExpression(model) && ts.isIdentifier(model.expression)
    ? { root: model.expression, operation }
    : null
}

function isPrismaIdentifier(
  identifier: ts.Identifier,
  ctx: DetectPrismaFrameworkContext,
  seen: Set<ts.Declaration>,
): boolean {
  let symbol = ctx.checker.getSymbolAtLocation(identifier)
  if (!symbol) return false
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try { symbol = ctx.checker.getAliasedSymbol(symbol) } catch { return false }
  }
  for (const decl of symbol.declarations ?? []) {
    if (seen.has(decl)) continue
    seen.add(decl)
    if (!ts.isVariableDeclaration(decl) || !decl.initializer) continue
    if (isPrismaConstruction(decl.initializer, prismaClassBindings(decl.getSourceFile()))) return true
    if (ts.isIdentifier(decl.initializer) && isPrismaIdentifier(decl.initializer, ctx, seen)) return true
  }
  return false
}

function enclosingSymbol(node: ts.Node, ctx: DetectPrismaFrameworkContext): IndexSymbol | null {
  let current: ts.Node | undefined = node.parent
  while (current) {
    let name: string | null = null
    if (ts.isFunctionDeclaration(current) && current.name) name = current.name.text
    else if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name) && ts.isClassDeclaration(current.parent) && current.parent.name) {
      name = `${current.parent.name.text}.${current.name.text}`
    } else if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) name = current.name.text
    if (name) return (ctx.symbolsByFile.get(ctx.fileId) ?? []).find((symbol) => symbol.name === name) ?? null
    current = current.parent
  }
  return null
}

function synthesizeOperation(
  ctx: DetectPrismaFrameworkContext,
  call: ts.CallExpression,
  operation: PrismaOperation,
  seen: Set<string>,
): IndexSymbol | null {
  const range = rangeOf(call.expression, ctx.sourceFile)
  const id = `symbol:${ctx.fileId}/function/prisma.${operation}.L${range.start.line}.C${range.start.column}`
  if (seen.has(id)) return null
  seen.add(id)
  const symbol: IndexSymbol = {
    id,
    file_id: ctx.fileId,
    name: `prisma.${operation}.L${range.start.line}.C${range.start.column}`,
    kind: 'function',
    range,
    exported: false,
    framework_role: READS.has(operation) ? 'prisma_model_reader' : 'prisma_model_writer',
    framework_metadata: { storage_operation: operation },
  }
  ctx.symbols.push(symbol)
  const fileSymbols = ctx.symbolsByFile.get(ctx.fileId)
  if (fileSymbols) fileSymbols.push(symbol)
  else ctx.symbolsByFile.set(ctx.fileId, [symbol])
  return symbol
}

function tagSymbol(ctx: DetectPrismaFrameworkContext, name: string, role: IndexFrameworkRole): void {
  const symbol = (ctx.symbolsByFile.get(ctx.fileId) ?? []).find((candidate) => candidate.name === name)
  if (symbol && symbol.framework_role === undefined) symbol.framework_role = role
}

function rangeOf(node: ts.Node, sourceFile: ts.SourceFile): IndexSymbol['range'] {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd())
  return {
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  }
}
