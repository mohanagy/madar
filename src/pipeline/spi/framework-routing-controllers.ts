import ts from 'typescript'

import type {
  SpiEdge,
  SpiFrameworkRole,
  SpiSymbol,
} from './types.js'

const ROUTING_CONTROLLERS_SPECIFIER = 'routing-controllers'

const ROUTE_DECORATORS = new Map<string, string>([
  ['Get', 'GET'],
  ['Post', 'POST'],
  ['Put', 'PUT'],
  ['Patch', 'PATCH'],
  ['Delete', 'DELETE'],
  ['All', 'ALL'],
  ['Head', 'HEAD'],
])

type RoutingControllersBindings = {
  controller: Set<string>
  jsonController: Set<string>
  routeDecorators: Map<string, string>
  createExpressServer: Set<string>
  useExpressServer: Set<string>
  createKoaServer: Set<string>
  useKoaServer: Set<string>
}

export type DetectRoutingControllersFrameworkContext = {
  sourceFile: ts.SourceFile
  fileId: string
  symbolsByFile: Map<string, SpiSymbol[]>
  edges: SpiEdge[]
  checker: ts.TypeChecker
  pathToFileId: Map<string, string>
}

type ControllerRecord = {
  classId: string
  declaration: ts.ClassDeclaration
  basePath: string
}

export function detectRoutingControllersFramework(ctx: DetectRoutingControllersFrameworkContext): void {
  const bindings = collectBindings(ctx.sourceFile)
  if (!hasAnyBinding(bindings)) {
    return
  }

  if (bindings.controller.size > 0 || bindings.jsonController.size > 0 || bindings.routeDecorators.size > 0) {
    detectControllerClasses(ctx, bindings)
  }

  emitBootstrapRegistrations(ctx, bindings)
}

function collectBindings(sourceFile: ts.SourceFile): RoutingControllersBindings {
  const bindings: RoutingControllersBindings = {
    controller: new Set<string>(),
    jsonController: new Set<string>(),
    routeDecorators: new Map<string, string>(),
    createExpressServer: new Set<string>(),
    useExpressServer: new Set<string>(),
    createKoaServer: new Set<string>(),
    useKoaServer: new Set<string>(),
  }

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier) || stmt.moduleSpecifier.text !== ROUTING_CONTROLLERS_SPECIFIER) continue

    const named = stmt.importClause.namedBindings
    if (!named || !ts.isNamedImports(named)) continue

    for (const element of named.elements) {
      const importedName = element.propertyName?.text ?? element.name.text
      const localName = element.name.text
      if (importedName === 'Controller') bindings.controller.add(localName)
      else if (importedName === 'JsonController') bindings.jsonController.add(localName)
      else if (importedName === 'createExpressServer') bindings.createExpressServer.add(localName)
      else if (importedName === 'useExpressServer') bindings.useExpressServer.add(localName)
      else if (importedName === 'createKoaServer') bindings.createKoaServer.add(localName)
      else if (importedName === 'useKoaServer') bindings.useKoaServer.add(localName)
      else {
        const httpMethod = ROUTE_DECORATORS.get(importedName)
        if (httpMethod) bindings.routeDecorators.set(localName, httpMethod)
      }
    }
  }

  return bindings
}

function hasAnyBinding(bindings: RoutingControllersBindings): boolean {
  return bindings.controller.size > 0
    || bindings.jsonController.size > 0
    || bindings.routeDecorators.size > 0
    || bindings.createExpressServer.size > 0
    || bindings.useExpressServer.size > 0
    || bindings.createKoaServer.size > 0
    || bindings.useKoaServer.size > 0
}

function detectControllerClasses(
  ctx: DetectRoutingControllersFrameworkContext,
  bindings: RoutingControllersBindings,
): Map<string, ControllerRecord> {
  const controllers = new Map<string, ControllerRecord>()

  for (const stmt of ctx.sourceFile.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue

    const controllerDecorator = findControllerDecorator(stmt, bindings)
    if (!controllerDecorator) continue

    const classSymbol = findSymbol(ctx.symbolsByFile, ctx.fileId, 'class', stmt.name.text)
    if (!classSymbol) continue

    classSymbol.framework_role = 'routing_controllers_controller'
    classSymbol.framework_metadata = {
      ...(classSymbol.framework_metadata ?? {}),
      mount_path: controllerDecorator.basePath,
    }

    const record: ControllerRecord = {
      classId: classSymbol.id,
      declaration: stmt,
      basePath: controllerDecorator.basePath,
    }
    controllers.set(stmt.name.text, record)
    emitRouteMethods(ctx, bindings, record)
  }

  return controllers
}

function findControllerDecorator(
  classDecl: ts.ClassDeclaration,
  bindings: RoutingControllersBindings,
): { basePath: string } | null {
  for (const decorator of decoratorsOf(classDecl)) {
    const name = decoratorIdentifierName(decorator)
    if (!name) continue
    if (!bindings.controller.has(name) && !bindings.jsonController.has(name)) continue
    return {
      basePath: normalizeRouteSegment(decoratorFirstStringArg(decorator) ?? '/'),
    }
  }
  return null
}

function emitRouteMethods(
  ctx: DetectRoutingControllersFrameworkContext,
  bindings: RoutingControllersBindings,
  controller: ControllerRecord,
): void {
  const className = controller.declaration.name?.text
  if (!className) return

  for (const member of controller.declaration.members) {
    if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue
    const routeDecorator = findRouteDecorator(member, bindings)
    if (!routeDecorator) continue

    const methodSymbol = findSymbol(ctx.symbolsByFile, ctx.fileId, 'method', `${className}.${member.name.text}`)
    if (!methodSymbol) continue

    methodSymbol.framework_role = 'routing_controllers_route'
    methodSymbol.framework_metadata = {
      ...(methodSymbol.framework_metadata ?? {}),
      route_path: joinRoutePath(controller.basePath, routeDecorator.path),
      http_method: routeDecorator.httpMethod,
    }

    if (!hasEdge(ctx.edges, controller.classId, methodSymbol.id, 'controller_route')) {
      ctx.edges.push({
        from: controller.classId,
        to: methodSymbol.id,
        kind: 'controller_route',
        confidence: 'high',
        source: 'framework-decorator',
        evidence: {
          file_id: ctx.fileId,
          range: rangeOf(member.name, ctx.sourceFile),
        },
      })
    }
  }
}

function findRouteDecorator(
  methodDecl: ts.MethodDeclaration,
  bindings: RoutingControllersBindings,
): { httpMethod: string; path: string } | null {
  for (const decorator of decoratorsOf(methodDecl)) {
    const name = decoratorIdentifierName(decorator)
    if (!name) continue
    const httpMethod = bindings.routeDecorators.get(name)
    if (!httpMethod) continue
    return {
      httpMethod,
      path: normalizeRouteSegment(decoratorFirstStringArg(decorator) ?? '/'),
    }
  }
  return null
}

function emitBootstrapRegistrations(
  ctx: DetectRoutingControllersFrameworkContext,
  bindings: RoutingControllersBindings,
): void {
  const seen = new Set<string>()

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const bootstrap = bootstrapConfigArgument(node, bindings)
      if (bootstrap) {
        const controllers = controllerIdentifiersFromBootstrapConfig(bootstrap)
        for (const identifier of controllers) {
          const targetId = resolveStaticClassReference(identifier, ctx)
          if (!targetId) continue
          const key = `${ctx.fileId}|${targetId}|registers_controller`
          if (seen.has(key) || hasEdge(ctx.edges, ctx.fileId, targetId, 'registers_controller')) continue
          seen.add(key)
          ctx.edges.push({
            from: ctx.fileId,
            to: targetId,
            kind: 'registers_controller',
            confidence: 'high',
            source: 'framework-decorator',
            evidence: {
              file_id: ctx.fileId,
              range: rangeOf(identifier, ctx.sourceFile),
            },
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(ctx.sourceFile)
}

function bootstrapConfigArgument(
  callExpr: ts.CallExpression,
  bindings: RoutingControllersBindings,
): ts.ObjectLiteralExpression | null {
  const calleeName = callIdentifierName(callExpr.expression)
  if (!calleeName) return null

  if (bindings.createExpressServer.has(calleeName) || bindings.createKoaServer.has(calleeName)) {
    const arg = callExpr.arguments[0]
    return arg && ts.isObjectLiteralExpression(arg) ? arg : null
  }

  if (bindings.useExpressServer.has(calleeName) || bindings.useKoaServer.has(calleeName)) {
    const arg = callExpr.arguments[1]
    return arg && ts.isObjectLiteralExpression(arg) ? arg : null
  }

  return null
}

function controllerIdentifiersFromBootstrapConfig(config: ts.ObjectLiteralExpression): ts.Identifier[] {
  const controllers: ts.Identifier[] = []
  for (const property of config.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = propertyNameText(property.name)
    if (name !== 'controllers' || !ts.isArrayLiteralExpression(property.initializer)) continue
    for (const element of property.initializer.elements) {
      if (ts.isIdentifier(element)) {
        controllers.push(element)
      }
    }
  }
  return controllers
}

function resolveStaticClassReference(
  identifier: ts.Identifier,
  ctx: DetectRoutingControllersFrameworkContext,
): string | null {
  const symbol = ctx.checker.getSymbolAtLocation(identifier)
  if (!symbol) return null
  const aliased = symbol.flags & ts.SymbolFlags.Alias ? ctx.checker.getAliasedSymbol(symbol) : symbol
  for (const declaration of aliased.declarations ?? []) {
    if (!ts.isClassDeclaration(declaration) || !declaration.name) continue
    const fileName = declaration.getSourceFile().fileName.replace(/\\/g, '/')
    const fileId = ctx.pathToFileId.get(fileName)
    if (!fileId) continue
    return symbolIdFor(fileId, 'class', declaration.name.text)
  }
  return null
}

function hasEdge(edges: readonly SpiEdge[], from: string, to: string, kind: SpiEdge['kind']): boolean {
  return edges.some((edge) => edge.from === from && edge.to === to && edge.kind === kind)
}

function findSymbol(
  symbolsByFile: Map<string, SpiSymbol[]>,
  fileId: string,
  kind: SpiSymbol['kind'],
  name: string,
): SpiSymbol | undefined {
  return symbolsByFile.get(fileId)?.find((symbol) => symbol.kind === kind && symbol.name === name)
}

function symbolIdFor(fileId: string, kind: SpiSymbol['kind'], name: string): string {
  return `symbol:${fileId}/${kind}/${name}`
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []
}

function decoratorIdentifierName(decorator: ts.Decorator): string | null {
  const expression = decorator.expression
  if (ts.isCallExpression(expression)) {
    return callIdentifierName(expression.expression)
  }
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) return expression.name.text
  return null
}

function callIdentifierName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) return expression.name.text
  return null
}

function decoratorFirstStringArg(decorator: ts.Decorator): string | null {
  if (!ts.isCallExpression(decorator.expression)) return null
  const first = decorator.expression.arguments[0]
  if (first && ts.isStringLiteralLike(first)) return first.text
  return null
}

function normalizeRouteSegment(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === '/') return '/'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function joinRoutePath(basePath: string, methodPath: string): string {
  const normalizedBase = normalizeRouteSegment(basePath)
  const normalizedMethod = normalizeRouteSegment(methodPath)
  if (normalizedMethod === '/') {
    return normalizedBase
  }
  if (normalizedBase === '/') {
    return normalizedMethod
  }
  return `${normalizedBase.replace(/\/+$/, '')}${normalizedMethod}`
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return null
}

function rangeOf(node: ts.Node, sourceFile: ts.SourceFile) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd())
  return {
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  }
}
