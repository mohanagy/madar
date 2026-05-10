// SPI v1 — NestJS framework layer (slice 3b of #72).
//
// Detects NestJS decorators on classes and methods and:
//   * Sets `framework_role` on the matching SpiSymbol
//     (nest_module / nest_controller / nest_provider / nest_route).
//   * Emits framework edges:
//       - module_imports / module_provides / module_exports
//         (Module class -> referenced class, parsed from the @Module
//          options object literal)
//       - controller_route
//         (Controller class -> route-handler method, one per @Get/@Post
//          /... decorator)
//
// Per the SPI v1 design (docs/designs/2026-05-10-spi-v1.md), all framework
// edges carry source: 'framework-decorator' and confidence: 'high' when the
// decorator and the binding both resolve through the type checker. Decorator
// matching is by name only (Module / Controller / Get / etc.) — it does not
// verify the import is actually `@nestjs/common`. False positives in non-Nest
// projects are theoretically possible but require a same-named symbol used
// as a class decorator, which is rare enough to be acceptable for v1.
//
// Deferred to a follow-up slice (3b-ii): @UseGuards / @UsePipes /
// @UseInterceptors + constructor parameter injection (`injects` edges) +
// custom @Inject('TOKEN') string-token providers.

import ts from 'typescript'

import type { SpiEdge, SpiFrameworkRole, SpiRange, SpiSymbol, SpiSymbolKind } from './types.js'

const NEST_CLASS_DECORATORS: ReadonlyMap<string, SpiFrameworkRole> = new Map([
  ['Module', 'nest_module'],
  ['Controller', 'nest_controller'],
  ['Injectable', 'nest_provider'],
])

const NEST_ROUTE_DECORATOR_NAMES: ReadonlySet<string> = new Set([
  'Get', 'Post', 'Put', 'Patch', 'Delete', 'Options', 'Head', 'All',
])

const NEST_MODULE_OPTION_TO_EDGE_KIND: Readonly<Record<string, 'module_imports' | 'module_provides' | 'module_exports'>> = {
  imports: 'module_imports',
  providers: 'module_provides',
  exports: 'module_exports',
  // Controllers are something the module declares/owns; they share the
  // module_provides relationship in this v1 mapping.
  controllers: 'module_provides',
}

export type VisitNestJsClassOptions = {
  classNode: ts.ClassDeclaration
  fileId: string
  sourceFile: ts.SourceFile
  checker: ts.TypeChecker
  pathToFileId: Map<string, string>
  symbolsById: Map<string, SpiSymbol>
  edges: SpiEdge[]
  seen: Set<string>
}

export function visitNestJsClass(opts: VisitNestJsClassOptions): void {
  const { classNode, fileId, sourceFile, checker, pathToFileId, symbolsById, edges, seen } = opts
  if (!classNode.name) return
  const className = classNode.name.text
  const classId = makeSymbolId(fileId, 'class', className)
  const classSymbol = symbolsById.get(classId)
  if (!classSymbol) return

  const classDecorators = ts.canHaveDecorators(classNode) ? ts.getDecorators(classNode) : undefined
  if (classDecorators) {
    for (const decorator of classDecorators) {
      const callExpr = ts.isCallExpression(decorator.expression) ? decorator.expression : null
      const decoratorName = callExpr ? getDecoratorName(callExpr.expression) : getDecoratorName(decorator.expression)
      if (!decoratorName) continue
      const role = NEST_CLASS_DECORATORS.get(decoratorName)
      if (!role) continue

      classSymbol.framework_role = role

      // For @Module, walk the options object literal and emit edges to the
      // referenced classes. Both the array-shape (preferred) and the bare
      // class-reference shape are supported on different option fields.
      if (decoratorName === 'Module' && callExpr && callExpr.arguments.length > 0) {
        const arg = callExpr.arguments[0]
        if (arg && ts.isObjectLiteralExpression(arg)) {
          emitModuleEdgesFromOptions(arg, classId, fileId, sourceFile, checker, pathToFileId, edges, seen)
        }
      }
    }
  }

  for (const member of classNode.members) {
    if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue
    const methodName = member.name.text
    const methodId = makeSymbolId(fileId, 'method', `${className}.${methodName}`)
    const methodSymbol = symbolsById.get(methodId)
    if (!methodSymbol) continue

    const methodDecorators = ts.canHaveDecorators(member) ? ts.getDecorators(member) : undefined
    if (!methodDecorators) continue
    for (const decorator of methodDecorators) {
      const callExpr = ts.isCallExpression(decorator.expression) ? decorator.expression : null
      const decoratorName = callExpr ? getDecoratorName(callExpr.expression) : getDecoratorName(decorator.expression)
      if (!decoratorName) continue
      if (!NEST_ROUTE_DECORATOR_NAMES.has(decoratorName)) continue

      methodSymbol.framework_role = 'nest_route'

      const dedupeKey = `${classId}|${methodId}|controller_route`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      edges.push({
        from: classId,
        to: methodId,
        kind: 'controller_route',
        confidence: 'high',
        source: 'framework-decorator',
        evidence: { file_id: fileId, range: rangeOf(decorator, sourceFile) },
      })
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

function emitModuleEdgesFromOptions(
  options: ts.ObjectLiteralExpression,
  classId: string,
  fileId: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  pathToFileId: Map<string, string>,
  edges: SpiEdge[],
  seen: Set<string>,
): void {
  for (const prop of options.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    if (!ts.isIdentifier(prop.name)) continue
    const edgeKind = NEST_MODULE_OPTION_TO_EDGE_KIND[prop.name.text]
    if (!edgeKind) continue
    if (!ts.isArrayLiteralExpression(prop.initializer)) continue

    for (const element of prop.initializer.elements) {
      // We only handle the bare-identifier form here:
      //   imports: [AuthModule, UserModule]
      // The dynamic forms (`AuthModule.forRoot(...)`, conditional spreads)
      // are intentionally left for a slice 3b-ii follow-up so this PR
      // stays narrowly scoped to the static, statically-resolvable cases.
      if (!ts.isIdentifier(element)) continue
      const targetId = resolveClassReferenceToSpiId(element, checker, pathToFileId)
      if (!targetId) continue

      const dedupeKey = `${classId}|${targetId}|${edgeKind}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)

      edges.push({
        from: classId,
        to: targetId,
        kind: edgeKind,
        confidence: 'high',
        source: 'framework-decorator',
        evidence: { file_id: fileId, range: rangeOf(element, sourceFile) },
      })
    }
  }
}

function resolveClassReferenceToSpiId(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
  pathToFileId: Map<string, string>,
): string | null {
  const symbol = checker.getSymbolAtLocation(identifier)
  if (!symbol) return null
  const aliased = (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? safeGetAliasedSymbol(symbol, checker)
    : symbol
  if (!aliased) return null
  const decl = aliased.declarations?.[0]
  if (!decl || !ts.isClassDeclaration(decl) || !decl.name) return null
  const declSourceFile = decl.getSourceFile()
  if (declSourceFile.isDeclarationFile) return null
  const targetFileId = pathToFileId.get(declSourceFile.fileName)
  if (!targetFileId) return null
  return makeSymbolId(targetFileId, 'class', decl.name.text)
}

function safeGetAliasedSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol | undefined {
  try {
    return checker.getAliasedSymbol(symbol)
  } catch {
    return undefined
  }
}

function getDecoratorName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  return null
}

// Local copies of the same helpers build.ts uses. Kept in sync by visual
// inspection — they're trivial and used in only one place each here.
function makeSymbolId(fileId: string, kind: SpiSymbolKind, name: string): string {
  return `symbol:${fileId}/${kind}/${name}`
}

function rangeOf(node: ts.Node, sourceFile: ts.SourceFile): SpiRange {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd())
  return {
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  }
}
