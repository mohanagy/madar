// SPI v1 — NestJS framework layer (slice 3b base of #72).
//
// Detects classes decorated with @Module / @Controller / @Injectable from
// '@nestjs/common' and emits the design's framework-layer edges:
//
//   * `framework_role` tagging on the SpiSymbol of each detected class
//     (nest_module / nest_controller / nest_provider). Methods of a
//     controller that carry an HTTP route decorator additionally inherit
//     `framework_role: 'nest_route'`.
//   * `module_imports`   — module class → other module class (resolved via
//                          the type checker through `imports: [...]`).
//   * `module_provides`  — module class → provider OR controller class
//                          listed in `providers: [...]` / `controllers: [...]`.
//                          The design's edge enum has no dedicated
//                          `module_controllers` kind; both lists project
//                          onto `module_provides` here, and the
//                          provider-vs-controller distinction lives on the
//                          target's `framework_role` once that file is
//                          visited.
//   * `module_exports`   — module class → re-exported provider OR module.
//   * `controller_route` — controller class → method that carries an HTTP
//                          route decorator (@Get/@Post/@Put/@Patch/@Delete/
//                          @Options/@Head/@All).
//
// Slice 3b-ii layers @UseGuards / @UsePipes / @UseInterceptors,
// constructor injection, @Inject('TOKEN') string tokens, and dynamic
// Module.forRoot/forRootAsync shapes on top of this base.
//
// Confidence rules:
//   * `high`   — decorator binding resolves AND target identifier resolves
//                through ts.TypeChecker to a class declaration in a file
//                we have indexed.
//   * `low`    — element of a metadata array that we cannot statically
//                resolve to a class (call expression, spread, conditional,
//                or unresolved identifier). Emitted with a diagnostic so
//                the gap is auditable rather than silent.
//
// All emitted edges carry `source: 'framework-decorator'`.

import { createHash } from 'node:crypto'
import ts from 'typescript'

import type {
  SpiDiagnostic,
  SpiEdge,
  SpiFrameworkRole,
  SpiRange,
  SpiSymbol,
  SpiSymbolKind,
} from './types.js'

const NEST_COMMON_SPECIFIER = '@nestjs/common'

const ROUTE_DECORATOR_NAMES: ReadonlySet<string> = new Set([
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'Options',
  'Head',
  'All',
])

type NestBindings = {
  module: Set<string>
  controller: Set<string>
  injectable: Set<string>
  routeDecorators: Set<string>
}

export type DetectNestFrameworkContext = {
  sourceFile: ts.SourceFile
  fileId: string
  symbolsByFile: Map<string, SpiSymbol[]>
  edges: SpiEdge[]
  diagnostics: SpiDiagnostic[]
  pathToFileId: Map<string, string>
  checker: ts.TypeChecker
}

export function detectNestFramework(ctx: DetectNestFrameworkContext): void {
  const bindings = collectNestBindings(ctx.sourceFile)
  if (!hasAnyBinding(bindings)) return

  for (const stmt of ctx.sourceFile.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue

    const classDecorators = decoratorsOf(stmt)
    const decoratorRole = classDecoratorRole(classDecorators, bindings)
    if (decoratorRole.role === null) continue

    const classId = symbolIdFor(ctx.fileId, 'class', stmt.name.text)
    setFrameworkRole(ctx.symbolsByFile, ctx.fileId, classId, decoratorRole.role)

    if (decoratorRole.role === 'nest_module' && decoratorRole.decorator) {
      emitModuleEdges(ctx, classId, decoratorRole.decorator)
    } else if (decoratorRole.role === 'nest_controller') {
      emitControllerRoutes(ctx, classId, stmt, bindings)
    }
    // nest_provider currently emits role only; provider-side edges
    // (injects/uses_*) are slice 3b-ii's domain.
  }
}

function collectNestBindings(sourceFile: ts.SourceFile): NestBindings {
  const bindings: NestBindings = {
    module: new Set<string>(),
    controller: new Set<string>(),
    injectable: new Set<string>(),
    routeDecorators: new Set<string>(),
  }
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (stmt.moduleSpecifier.text !== NEST_COMMON_SPECIFIER) continue

    const named = stmt.importClause.namedBindings
    if (!named || !ts.isNamedImports(named)) continue

    for (const element of named.elements) {
      const importedName = element.propertyName?.text ?? element.name.text
      const localName = element.name.text
      if (importedName === 'Module') bindings.module.add(localName)
      else if (importedName === 'Controller') bindings.controller.add(localName)
      else if (importedName === 'Injectable') bindings.injectable.add(localName)
      else if (ROUTE_DECORATOR_NAMES.has(importedName)) bindings.routeDecorators.add(localName)
    }
  }
  return bindings
}

function hasAnyBinding(b: NestBindings): boolean {
  return b.module.size > 0 || b.controller.size > 0 || b.injectable.size > 0 || b.routeDecorators.size > 0
}

type DetectedClassDecorator = {
  role: SpiFrameworkRole
  decorator: ts.Decorator
}

function classDecoratorRole(
  decorators: readonly ts.Decorator[],
  bindings: NestBindings,
): { role: SpiFrameworkRole | null; decorator: ts.Decorator | null } {
  for (const decorator of decorators) {
    const name = decoratorIdentifierName(decorator)
    if (!name) continue
    if (bindings.module.has(name)) return { role: 'nest_module', decorator }
    if (bindings.controller.has(name)) return { role: 'nest_controller', decorator }
    if (bindings.injectable.has(name)) return { role: 'nest_provider', decorator }
  }
  return { role: null, decorator: null }
}

function decoratorIdentifierName(decorator: ts.Decorator): string | null {
  const expr = decorator.expression
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression
    if (ts.isIdentifier(callee)) return callee.text
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text
    return null
  }
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name.text
  return null
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []
}

function emitModuleEdges(
  ctx: DetectNestFrameworkContext,
  moduleClassId: string,
  decorator: ts.Decorator,
): void {
  if (!ts.isCallExpression(decorator.expression)) return
  const firstArg = decorator.expression.arguments[0]
  if (!firstArg || !ts.isObjectLiteralExpression(firstArg)) return

  for (const property of firstArg.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const key = propertyKeyText(property.name)
    if (!key) continue

    const edgeKind = METADATA_KEY_TO_EDGE_KIND[key]
    if (!edgeKind) continue

    const initializer = property.initializer
    if (!ts.isArrayLiteralExpression(initializer)) {
      // e.g. `imports: someComputedArray` — not statically inspectable in
      // slice 3b base. Record so the gap is visible to downstream layers.
      pushDiagnostic(ctx, 'spi.nest.module-metadata.non-array', 'info', `NestJS @Module ${key}: non-array initializer cannot be enumerated statically`, ctx.sourceFile, initializer)
      continue
    }

    for (const element of initializer.elements) {
      emitModuleMetadataEdge(ctx, moduleClassId, edgeKind, element)
    }
  }
}

const METADATA_KEY_TO_EDGE_KIND: Record<string, 'module_imports' | 'module_provides' | 'module_exports'> = {
  imports: 'module_imports',
  providers: 'module_provides',
  controllers: 'module_provides',
  exports: 'module_exports',
}

function emitModuleMetadataEdge(
  ctx: DetectNestFrameworkContext,
  moduleClassId: string,
  edgeKind: 'module_imports' | 'module_provides' | 'module_exports',
  element: ts.Expression,
): void {
  const targetId = resolveStaticClassReference(element, ctx)
  if (!targetId) {
    pushDiagnostic(ctx, 'spi.nest.module-metadata.unresolved', 'info', `NestJS @Module ${edgeKind}: unresolved entry (likely dynamic — Module.forRoot, spread, or conditional)`, ctx.sourceFile, element)
    return
  }
  ctx.edges.push({
    from: moduleClassId,
    to: targetId,
    kind: edgeKind,
    confidence: 'high',
    source: 'framework-decorator',
    evidence: { file_id: ctx.fileId, range: rangeOf(element, ctx.sourceFile) },
  })
}

function emitControllerRoutes(
  ctx: DetectNestFrameworkContext,
  controllerClassId: string,
  classDecl: ts.ClassDeclaration,
  bindings: NestBindings,
): void {
  if (!classDecl.name) return
  const className = classDecl.name.text

  // Per-method overload counters mirror build.ts emitClassMethods so the
  // method symbol id we link to here matches the one the symbol layer emits.
  // Increment for every named method declaration (including non-route ones)
  // so the index of a route method on, say, the third overload of `foo`
  // resolves to `foo#2` — the same id the symbol layer minted.
  const overloadCounts = new Map<string, number>()

  for (const member of classDecl.members) {
    if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) {
      // Constructors, accessors, and properties keep their own counters in
      // build.ts emitClassMethods (different name keys), so skipping them
      // here does not desync indices for method declarations.
      continue
    }

    const methodName = member.name.text
    const overloadKey = `${className}.${methodName}`
    const overloadIndex = overloadCounts.get(overloadKey) ?? 0
    overloadCounts.set(overloadKey, overloadIndex + 1)

    const routeDecorator = findRouteDecorator(member, bindings)
    if (!routeDecorator) continue

    const baseId = symbolIdFor(ctx.fileId, 'method', `${className}.${methodName}`)
    const methodId = overloadIndex === 0 ? baseId : `${baseId}#${overloadIndex}`

    setFrameworkRole(ctx.symbolsByFile, ctx.fileId, methodId, 'nest_route')

    ctx.edges.push({
      from: controllerClassId,
      to: methodId,
      kind: 'controller_route',
      confidence: 'high',
      source: 'framework-decorator',
      evidence: { file_id: ctx.fileId, range: rangeOf(member.name, ctx.sourceFile) },
    })
  }
}

function findRouteDecorator(member: ts.MethodDeclaration, bindings: NestBindings): ts.Decorator | null {
  for (const decorator of decoratorsOf(member)) {
    const name = decoratorIdentifierName(decorator)
    if (name && bindings.routeDecorators.has(name)) return decorator
  }
  return null
}

// Resolves an expression that names a class (e.g. `UsersModule`,
// `users.UsersModule`) to its SPI class symbol id. Returns null for any
// expression we cannot statically resolve (call expressions, spread,
// conditional, etc.) — those are slice 3b-ii's responsibility.
function resolveStaticClassReference(
  expr: ts.Expression,
  ctx: DetectNestFrameworkContext,
): string | null {
  let target: ts.Identifier | null = null
  if (ts.isIdentifier(expr)) {
    target = expr
  } else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    target = expr.name
  } else {
    return null
  }

  const symbol = followAlias(ctx.checker.getSymbolAtLocation(target), ctx.checker)
  const decl = symbol?.declarations?.[0]
  if (!decl) return null
  if (!ts.isClassDeclaration(decl) || !decl.name) return null

  const declSourceFile = decl.getSourceFile()
  if (declSourceFile.isDeclarationFile) return null
  const targetFileId = ctx.pathToFileId.get(declSourceFile.fileName)
  if (!targetFileId) return null

  return symbolIdFor(targetFileId, 'class', decl.name.text)
}

function followAlias(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (!symbol) return undefined
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol
  try {
    return checker.getAliasedSymbol(symbol)
  } catch {
    return undefined
  }
}

function setFrameworkRole(
  symbolsByFile: Map<string, SpiSymbol[]>,
  fileId: string,
  symbolId: string,
  role: SpiFrameworkRole,
): void {
  const symbols = symbolsByFile.get(fileId)
  if (!symbols) return
  for (const symbol of symbols) {
    if (symbol.id === symbolId) {
      symbol.framework_role = role
      return
    }
  }
}

function symbolIdFor(fileId: string, kind: SpiSymbolKind, name: string): string {
  return `symbol:${fileId}/${kind}/${name}`
}

function propertyKeyText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return null
}

function rangeOf(node: ts.Node, sourceFile: ts.SourceFile): SpiRange {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd())
  return {
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  }
}

function pushDiagnostic(
  ctx: DetectNestFrameworkContext,
  prefix: string,
  level: SpiDiagnostic['level'],
  message: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
): void {
  const range = rangeOf(node, sourceFile)
  const stableSlug = createHash('sha256')
    .update(`${ctx.fileId}|${prefix}|${range.start.line}:${range.start.column}|${node.getText(sourceFile)}`)
    .digest('hex')
    .slice(0, 12)
  ctx.diagnostics.push({
    id: `${prefix}.${stableSlug}`,
    level,
    message,
    evidence: { file_id: ctx.fileId, range },
  })
}
