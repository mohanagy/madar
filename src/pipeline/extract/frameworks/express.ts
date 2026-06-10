import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'

import * as ts from 'typescript'

import { addNode, addUniqueEdge, createEdge, createNode, fileStemForPath, _makeId } from '../core.js'
import type { ExtractionFragment } from '../dispatch.js'
import { unparenthesizeExpression } from '../typescript-utils.js'
import type { JsFrameworkAdapter, JsFrameworkContext } from './types.js'

const HTTP_ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all'])
const EXPRESS_ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use'])
const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']
const EXPRESS_MATCH_PATTERN = /\bexpress\b/
const IMPORTED_OWNER_ROUTE_PATTERN = /\.(?:route|get|post|put|patch|delete|all|use)\s*\(/
const MODULE_IMPORT_PATTERN = /\bimport\b|\brequire\s*\(/

type ExtractionNodeRecord = NonNullable<ExtractionFragment['nodes']>[number]

interface ExpressEntity {
  id: string
  name: string
  kind: 'app' | 'router'
}

interface FunctionInfo {
  line: number
  arity: number
}

interface ImportedBindingTarget {
  id: string
  kind: 'app' | 'router' | 'function'
  sourceFile: string
  label?: string
  line?: number
  synthesizeNode?: boolean
}

interface RouteAttachment {
  relation: 'middleware' | 'handles_route'
  targetId: string
  ownedByRoute?: boolean
}

interface RouteRecord {
  ownerId: string
  ownerName: string
  method: string
  path: string
  line: number
  sourceFile: string
  attachments: RouteAttachment[]
}

interface MountRecord {
  owner: ExpressEntity
  prefix: string
  line: number
  inheritedMiddleware: RouteAttachment[]
  routerTarget: {
    id: string
    sourceFile: string
  }
}

interface ExpressModuleAnalysis {
  sourceText: string
  stem: string
  exportedBindings: Map<string, ImportedBindingTarget>
  routeRecords: RouteRecord[]
}

const expressModuleAnalysisCache = new Map<string, ExpressModuleAnalysis>()

function normalizedRoutePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/') {
    return '/'
  }

  return `/${trimmed.replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`
}

function routeNodeId(filePath: string, ownerName: string, method: string, path: string, line: number): string {
  return _makeId(filePath, ownerName, method.toUpperCase(), path, String(line))
}

function expressEntityId(filePath: string, bindingName: string): string {
  return _makeId(filePath, bindingName, 'express')
}

function moduleStem(filePath: string): string {
  return fileStemForPath(filePath)
}

function functionNodeId(filePath: string, bindingName: string): string {
  return _makeId(moduleStem(filePath), bindingName)
}

function resolveImportPath(filePath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null
  }

  const resolvedSpecifier = resolve(dirname(filePath), specifier)
  const resolvedSpecifierExists = existsSync(resolvedSpecifier)
  if (resolvedSpecifierExists && statSync(resolvedSpecifier).isFile()) {
    return resolvedSpecifier
  }

  const declaredExtension = extname(resolvedSpecifier)
  if (JS_EXTENSIONS.includes(declaredExtension)) {
    const specifierStem = resolvedSpecifier.slice(0, -declaredExtension.length)
    for (const extension of JS_EXTENSIONS) {
      const candidate = `${specifierStem}${extension}`
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate
      }
    }
  }

  for (const extension of JS_EXTENSIONS) {
    const candidate = `${resolvedSpecifier}${extension}`
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }

  for (const extension of JS_EXTENSIONS) {
    const candidate = resolve(resolvedSpecifier, `index${extension}`)
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }

  if (resolvedSpecifierExists) {
    return null
  }

  return resolvedSpecifier
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX
  }
  if (filePath.endsWith('.jsx')) {
    return ts.ScriptKind.JSX
  }
  if (filePath.endsWith('.js') || filePath.endsWith('.cjs') || filePath.endsWith('.mjs')) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.TS
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function stringLiteralPath(expression: ts.Expression | undefined): string | null {
  if (!expression) {
    return null
  }

  const unwrapped = unparenthesizeExpression(expression)
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return normalizedRoutePath(unwrapped.text)
  }

  return null
}

function isRequireCall(expression: ts.Expression, moduleName: string): boolean {
  const unwrapped = unparenthesizeExpression(expression)
  const firstArgument = ts.isCallExpression(unwrapped) ? unwrapped.arguments[0] : undefined
  return (
    ts.isCallExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    unwrapped.expression.text === 'require' &&
    unwrapped.arguments.length === 1 &&
    firstArgument !== undefined &&
    ts.isStringLiteral(firstArgument) &&
    firstArgument.text === moduleName
  )
}

function importEqualsModuleSpecifier(node: ts.Node): { localName: string; moduleSpecifier: string } | null {
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression &&
    ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    return {
      localName: node.name.text,
      moduleSpecifier: node.moduleReference.expression.text,
    }
  }

  return null
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text
  }

  return null
}

function isExpressFactoryCallee(expression: ts.Expression, expressFactoryAliases: ReadonlySet<string>): boolean {
  const unwrapped = unparenthesizeExpression(expression)
  return (ts.isIdentifier(unwrapped) && expressFactoryAliases.has(unwrapped.text)) || isRequireCall(unwrapped, 'express')
}

function isExpressRouterCallee(
  expression: ts.Expression,
  expressFactoryAliases: ReadonlySet<string>,
  expressRouterAliases: ReadonlySet<string>,
): boolean {
  const unwrapped = unparenthesizeExpression(expression)
  return (
    ((ts.isPropertyAccessExpression(unwrapped) &&
      unwrapped.name.text === 'Router' &&
      ((ts.isIdentifier(unwrapped.expression) && expressFactoryAliases.has(unwrapped.expression.text)) ||
        isRequireCall(unwrapped.expression, 'express'))) ||
      (ts.isIdentifier(unwrapped) && expressRouterAliases.has(unwrapped.text)))
  )
}

function flattenedExpressions(expression: ts.Expression): ts.Expression[] {
  const unwrapped = unparenthesizeExpression(expression)
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements.flatMap((element) => {
      if (ts.isSpreadElement(element)) {
        return ts.isArrayLiteralExpression(unparenthesizeExpression(element.expression))
          ? flattenedExpressions(element.expression)
          : [element.expression]
      }
      return ts.isExpression(element) ? flattenedExpressions(element) : []
    })
  }

  return [unwrapped]
}

function identifierName(expression: ts.Expression): string | null {
  const unwrapped = unparenthesizeExpression(expression)
  if (ts.isIdentifier(unwrapped)) {
    return unwrapped.text
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return unwrapped.name.text
  }
  return null
}

function resolveImportedBindingTarget(
  expression: ts.Expression,
  importedBindingsByLocalName: ReadonlyMap<string, ImportedBindingTarget>,
  importedModulePathsByLocalName: ReadonlyMap<string, string>,
): ImportedBindingTarget | null {
  const unwrapped = unparenthesizeExpression(expression)
  if (ts.isIdentifier(unwrapped)) {
    return importedBindingsByLocalName.get(unwrapped.text) ?? null
  }

  if (ts.isPropertyAccessExpression(unwrapped) && ts.isIdentifier(unwrapped.expression)) {
    const importedModulePath = importedModulePathsByLocalName.get(unwrapped.expression.text)
    if (!importedModulePath) {
      return null
    }
    return analyzeExpressModule(importedModulePath).exportedBindings.get(unwrapped.name.text) ?? null
  }

  return null
}

function resolveExpressOwnerTarget(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  filePath: string,
  expressEntities: ReadonlyMap<string, ExpressEntity>,
  importedBindingsByLocalName: ReadonlyMap<string, ImportedBindingTarget>,
  importedModulePathsByLocalName: ReadonlyMap<string, string>,
): { entity: ExpressEntity; sourceFile: string } | null {
  const candidate = unparenthesizeExpression(expression)
  if (ts.isIdentifier(candidate)) {
    const localEntity = expressEntities.get(candidate.text)
    if (localEntity) {
      return { entity: localEntity, sourceFile: filePath }
    }
  }

  const importedTarget = resolveImportedBindingTarget(candidate, importedBindingsByLocalName, importedModulePathsByLocalName)
  if (!importedTarget || (importedTarget.kind !== 'router' && importedTarget.kind !== 'app')) {
    return null
  }

  return {
    entity: {
      id: importedTarget.id,
      name: candidate.getText(sourceFile),
      kind: importedTarget.kind,
    },
    sourceFile: importedTarget.sourceFile,
  }
}

function resolveRouterTarget(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  expressEntities: ReadonlyMap<string, ExpressEntity>,
  importedBindingsByLocalName: ReadonlyMap<string, ImportedBindingTarget>,
  importedModulePathsByLocalName: ReadonlyMap<string, string>,
  filePath: string,
): MountRecord['routerTarget'] | null {
  const ownerTarget = resolveExpressOwnerTarget(
    expression,
    sourceFile,
    filePath,
    expressEntities,
    importedBindingsByLocalName,
    importedModulePathsByLocalName,
  )
  if (ownerTarget) {
    return { id: ownerTarget.entity.id, sourceFile: ownerTarget.sourceFile }
  }

  return null
}

function createExpressEntityNode(
  entity: ExpressEntity,
  context: JsFrameworkContext,
  line: number,
  nodes: ReturnType<NonNullable<ExtractionFragment['nodes']>['slice']>,
  seenNodeIds: Set<string>,
  edges: ReturnType<NonNullable<ExtractionFragment['edges']>['slice']>,
  seenEdges: Set<string>,
): void {
  addNode(
    nodes,
    seenNodeIds,
    {
      ...createNode(entity.id, entity.name, context.filePath, line),
      node_kind: 'router',
      framework: 'express',
      framework_role: entity.kind === 'app' ? 'express_app' : 'express_router',
    },
  )
  addUniqueEdge(edges, seenEdges, createEdge(context.fileNodeId, entity.id, 'declares', context.filePath, line))
}

function resolveWrappedTargetExpression(expression: ts.Expression): ts.Expression | null {
  const unwrapped = unparenthesizeExpression(expression)
  if (ts.isCallExpression(unwrapped)) {
    for (let index = unwrapped.arguments.length - 1; index >= 0; index -= 1) {
      const candidate = resolveWrappedTargetExpression(unwrapped.arguments[index]!)
      if (candidate) {
        return candidate
      }
    }
  }

  if (
    ts.isIdentifier(unwrapped) ||
    ts.isPropertyAccessExpression(unwrapped) ||
    ts.isArrowFunction(unwrapped) ||
    ts.isFunctionExpression(unwrapped)
  ) {
    return unwrapped
  }

  return null
}

function frameworkRoleForCallable(relation: 'middleware' | 'handles_route', arity: number | null): string {
  if (relation === 'handles_route') {
    return 'express_handler'
  }

  return arity !== null && arity >= 4 ? 'express_error_middleware' : 'express_middleware'
}

function resolveNamedBaseNodeId(name: string, baseNodeIdsByLabel: ReadonlyMap<string, string>): string | null {
  for (const candidate of [name, `${name}()`, `.${name}()`]) {
    const nodeId = baseNodeIdsByLabel.get(candidate.toLowerCase())
    if (nodeId) {
      return nodeId
    }
  }
  return null
}

function joinRoutePaths(prefix: string, path: string): string {
  if (prefix === '/') {
    return path
  }
  if (path === '/') {
    return prefix
  }
  return normalizedRoutePath(`${prefix}/${path}`)
}

function routeRecordKey(record: RouteRecord): string {
  return [record.ownerId, record.method, record.path, String(record.line), record.sourceFile].join('|')
}

function dedupeRouteRecords(records: readonly RouteRecord[]): RouteRecord[] {
  const seen = new Set<string>()
  const deduped: RouteRecord[] = []

  for (const record of records) {
    const key = routeRecordKey(record)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(record)
  }

  return deduped
}

function ownedRouteCacheKey(ownerId: string, seenTargets: ReadonlySet<string>): string {
  return `${ownerId}|${[...seenTargets].sort().join(',')}`
}

function createMountedRouteRecord(mountRecord: MountRecord, descendantRoute: RouteRecord): RouteRecord {
  return {
    ownerId: mountRecord.owner.id,
    ownerName: `${mountRecord.owner.name}->${descendantRoute.ownerName}`,
    method: descendantRoute.method,
    path: joinRoutePaths(mountRecord.prefix, descendantRoute.path),
    line: descendantRoute.line,
    sourceFile: descendantRoute.sourceFile,
    attachments: [...mountRecord.inheritedMiddleware, ...descendantRoute.attachments],
  }
}

function createRouteRecordResolver(
  filePath: string,
  routeRecords: readonly RouteRecord[],
  mountRecords: readonly MountRecord[],
  resolveExternalRoutes: (routerTarget: MountRecord['routerTarget']) => readonly RouteRecord[],
): (routerTarget: MountRecord['routerTarget']) => RouteRecord[] {
  const directRouteRecordsByOwner = new Map<string, RouteRecord[]>()
  const mountRecordsByOwner = new Map<string, MountRecord[]>()
  const ownedRouteCache = new Map<string, RouteRecord[]>()

  for (const routeRecord of routeRecords) {
    const records = directRouteRecordsByOwner.get(routeRecord.ownerId)
    if (records) {
      records.push(routeRecord)
    } else {
      directRouteRecordsByOwner.set(routeRecord.ownerId, [routeRecord])
    }
  }

  for (const mountRecord of mountRecords) {
    const records = mountRecordsByOwner.get(mountRecord.owner.id)
    if (records) {
      records.push(mountRecord)
    } else {
      mountRecordsByOwner.set(mountRecord.owner.id, [mountRecord])
    }
  }

  const collectOwnedRoutes = (ownerId: string, seenTargets: Set<string>): RouteRecord[] => {
    const cacheKey = ownedRouteCacheKey(ownerId, seenTargets)
    const cached = ownedRouteCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const ownedRoutes = [...(directRouteRecordsByOwner.get(ownerId) ?? [])]
    for (const mountRecord of mountRecordsByOwner.get(ownerId) ?? []) {
      const targetKey = `${mountRecord.routerTarget.sourceFile}:${mountRecord.routerTarget.id}`
      if (seenTargets.has(targetKey)) {
        continue
      }

      const descendantRoutes =
        mountRecord.routerTarget.sourceFile === filePath
          ? collectOwnedRoutes(mountRecord.routerTarget.id, new Set([...seenTargets, targetKey]))
          : resolveExternalRoutes(mountRecord.routerTarget)

      for (const descendantRoute of descendantRoutes) {
        ownedRoutes.push(createMountedRouteRecord(mountRecord, descendantRoute))
      }
    }

    const dedupedRoutes = dedupeRouteRecords(ownedRoutes)
    ownedRouteCache.set(cacheKey, dedupedRoutes)
    return dedupedRoutes
  }

  return (routerTarget) =>
    routerTarget.sourceFile === filePath
      ? collectOwnedRoutes(routerTarget.id, new Set([`${routerTarget.sourceFile}:${routerTarget.id}`]))
      : [...resolveExternalRoutes(routerTarget)]
}

function resolveLocalRouteAttachment(
  expression: ts.Expression,
  routeLabel: string,
  relation: 'middleware' | 'handles_route',
  sourceFile: ts.SourceFile,
  filePath: string,
  functionInfoByName: ReadonlyMap<string, FunctionInfo>,
  importedBindingsByLocalName: ReadonlyMap<string, ImportedBindingTarget>,
  importedModulePathsByLocalName: ReadonlyMap<string, string>,
): RouteAttachment | null {
  const candidate = resolveWrappedTargetExpression(expression)
  if (!candidate) {
    return null
  }

  const label = identifierName(candidate)
  if (label && functionInfoByName.has(label)) {
    return {
      relation,
      targetId: functionNodeId(filePath, label),
    }
  }

  const importedBinding = resolveImportedBindingTarget(candidate, importedBindingsByLocalName, importedModulePathsByLocalName)
  if (importedBinding?.kind === 'function') {
    return {
      relation,
      targetId: importedBinding.id,
    }
  }

  if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) {
    const functionName = candidate.name?.text ?? `inline ${relation} ${routeLabel}`
    return {
      relation,
      targetId: _makeId(filePath, relation, routeLabel, String(lineOf(candidate, sourceFile)), functionName),
      ownedByRoute: relation === 'handles_route',
    }
  }

  return null
}

function analyzeExpressModule(filePath: string): ExpressModuleAnalysis {
  const sourceText = existsSync(filePath) && statSync(filePath).isFile() ? readFileSync(filePath, 'utf8') : ''
  const stem = moduleStem(filePath)
  const cached = expressModuleAnalysisCache.get(filePath)
  if (cached && cached.sourceText === sourceText && cached.stem === stem) {
    return cached
  }

  const analysis: ExpressModuleAnalysis = {
    sourceText,
    stem,
    exportedBindings: new Map<string, ImportedBindingTarget>(),
    routeRecords: [],
  }
  expressModuleAnalysisCache.set(filePath, analysis)

  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(filePath))
  const expressFactoryAliases = new Set<string>()
  const expressRouterAliases = new Set<string>()
  const importedBindingsByLocalName = new Map<string, ImportedBindingTarget>()
  const importedModulePathsByLocalName = new Map<string, string>()
  const expressEntities = new Map<string, ExpressEntity>()
  const functionInfoByName = new Map<string, FunctionInfo>()
  const callableClassNames = new Set<string>()
  const routeRecords: RouteRecord[] = []
  const mountRecords: MountRecord[] = []
  const exportedBindings = analysis.exportedBindings

  const registerExpressEntity = (name: string, kind: ExpressEntity['kind']): void => {
    if (expressEntities.has(name)) {
      return
    }
    expressEntities.set(name, {
      id: expressEntityId(filePath, name),
      name,
      kind,
    })
  }

  const collectImportAliases = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleSpecifier = node.moduleSpecifier.text
      const importClause = node.importClause
      if (moduleSpecifier === 'express') {
        if (importClause?.name) {
          expressFactoryAliases.add(importClause.name.text)
        }
        const bindings = importClause?.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) {
          expressFactoryAliases.add(bindings.name.text)
        }
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const importedName = element.propertyName?.text ?? element.name.text
            if (importedName === 'Router') {
              expressRouterAliases.add(element.name.text)
            }
          }
        }
      }
    }

    const importEqualsSpecifier = importEqualsModuleSpecifier(node)
    if (importEqualsSpecifier?.moduleSpecifier === 'express') {
      expressFactoryAliases.add(importEqualsSpecifier.localName)
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'require' &&
      ts.isStringLiteral(node.initializer.arguments[0]!)
    ) {
      const requiredModule = node.initializer.arguments[0]!.text
      if (requiredModule === 'express') {
        expressFactoryAliases.add(node.name.text)
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'require' &&
      ts.isStringLiteral(node.initializer.arguments[0]!)
    ) {
      const requiredModule = node.initializer.arguments[0]!.text
      if (requiredModule === 'express') {
        for (const element of node.name.elements) {
          const importedName =
            element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : element.name.getText(sourceFile)
          if (importedName === 'Router' && ts.isIdentifier(element.name)) {
            expressRouterAliases.add(element.name.text)
          }
        }
      }
    }

    ts.forEachChild(node, collectImportAliases)
  }

  const resolveImportedBindings = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleSpecifier = node.moduleSpecifier.text
      const importClause = node.importClause
      if (moduleSpecifier !== 'express') {
        const resolvedImportPath = resolveImportPath(filePath, moduleSpecifier)
        const importedModule = resolvedImportPath ? analyzeExpressModule(resolvedImportPath) : null
        if (resolvedImportPath && importedModule && importClause?.name) {
          const importedTarget = importedModule.exportedBindings.get('default')
          if (importedTarget) {
            importedBindingsByLocalName.set(importClause.name.text, importedTarget)
          }
        }
        const bindings = importClause?.namedBindings
        if (resolvedImportPath && bindings && ts.isNamespaceImport(bindings)) {
          importedModulePathsByLocalName.set(bindings.name.text, resolvedImportPath)
        }
        if (resolvedImportPath && importedModule && bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const importedName = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text
            const importedTarget = importedModule.exportedBindings.get(importedName)
            if (importedTarget) {
              importedBindingsByLocalName.set(element.name.text, importedTarget)
            }
          }
        }
      }
    }

    const importEqualsSpecifier = importEqualsModuleSpecifier(node)
    if (importEqualsSpecifier && importEqualsSpecifier.moduleSpecifier !== 'express') {
      const resolvedImportPath = resolveImportPath(filePath, importEqualsSpecifier.moduleSpecifier)
      const importedModule = resolvedImportPath ? analyzeExpressModule(resolvedImportPath) : null
      if (resolvedImportPath) {
        importedModulePathsByLocalName.set(importEqualsSpecifier.localName, resolvedImportPath)
      }
      if (resolvedImportPath && importedModule) {
        const importedTarget = importedModule.exportedBindings.get('default')
        if (importedTarget) {
          importedBindingsByLocalName.set(importEqualsSpecifier.localName, importedTarget)
        }
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'require' &&
      ts.isStringLiteral(node.initializer.arguments[0]!)
    ) {
        const requiredModule = node.initializer.arguments[0]!.text
        if (requiredModule !== 'express') {
          const resolvedImportPath = resolveImportPath(filePath, requiredModule)
          const importedModule = resolvedImportPath ? analyzeExpressModule(resolvedImportPath) : null
          if (resolvedImportPath) {
            importedModulePathsByLocalName.set(node.name.text, resolvedImportPath)
          }
          if (resolvedImportPath && importedModule) {
            const importedTarget = importedModule.exportedBindings.get('default')
            if (importedTarget) {
              importedBindingsByLocalName.set(node.name.text, importedTarget)
            }
        }
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'require' &&
      ts.isStringLiteral(node.initializer.arguments[0]!)
    ) {
      const requiredModule = node.initializer.arguments[0]!.text
      if (requiredModule !== 'express') {
        const resolvedImportPath = resolveImportPath(filePath, requiredModule)
        const importedModule = resolvedImportPath ? analyzeExpressModule(resolvedImportPath) : null
        if (resolvedImportPath && importedModule) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) {
              continue
            }
            const importedName =
              !element.propertyName || ts.isIdentifier(element.propertyName)
                ? (element.propertyName?.text ?? element.name.text)
                : element.propertyName.getText(sourceFile)
            const importedTarget = importedModule.exportedBindings.get(importedName)
            if (importedTarget) {
              importedBindingsByLocalName.set(element.name.text, importedTarget)
            }
          }
        }
      }
    }

    ts.forEachChild(node, resolveImportedBindings)
  }

  const collectFunctionInfo = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      functionInfoByName.set(node.name.text, {
        line: lineOf(node, sourceFile),
        arity: node.parameters.length,
      })
    }

    if (ts.isClassDeclaration(node) && node.name) {
      callableClassNames.add(node.name.text)
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      functionInfoByName.set(node.name.text, {
        line: lineOf(node, sourceFile),
        arity: node.initializer.parameters.length,
      })
    }

    ts.forEachChild(node, collectFunctionInfo)
  }

  const registerBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const initializer = node.initializer
      const callee = unparenthesizeExpression(initializer.expression)

      if (isExpressFactoryCallee(callee, expressFactoryAliases)) {
        registerExpressEntity(node.name.text, 'app')
      }

      if (isExpressRouterCallee(callee, expressFactoryAliases, expressRouterAliases)) {
        registerExpressEntity(node.name.text, 'router')
      }
    }

    ts.forEachChild(node, registerBindings)
  }

  const resolveExportedBinding = (localName: string): ImportedBindingTarget | null => {
    const entity = expressEntities.get(localName)
    if (entity) {
      return {
        id: entity.id,
        kind: entity.kind,
        sourceFile: filePath,
      }
    }

    if (functionInfoByName.has(localName)) {
      return {
        id: functionNodeId(filePath, localName),
        kind: 'function',
        sourceFile: filePath,
      }
    }

    if (callableClassNames.has(localName)) {
      return {
        id: functionNodeId(filePath, localName),
        kind: 'function',
        sourceFile: filePath,
      }
    }

    return null
  }

  const addExportedBinding = (exportName: string, localName: string): void => {
    const binding = resolveExportedBinding(localName)
    if (binding) {
      exportedBindings.set(exportName, binding)
    }
  }

  const addCallableExportedBinding = (exportName: string, expression: ts.Expression, fallbackBindingName = exportName): void => {
    const exportExpression = unparenthesizeExpression(expression)
    const exportIdentifier = identifierName(exportExpression)
    if (exportIdentifier) {
      addExportedBinding(exportName, exportIdentifier)
      return
    }

    if (ts.isArrowFunction(exportExpression) || ts.isFunctionExpression(exportExpression)) {
      const bindingName = exportExpression.name?.text ?? fallbackBindingName
      exportedBindings.set(exportName, {
        id: functionNodeId(filePath, bindingName),
        kind: 'function',
        sourceFile: filePath,
        label: `${bindingName}()`,
        line: lineOf(exportExpression, sourceFile),
        synthesizeNode: true,
      })
      return
    }

    if (ts.isClassExpression(exportExpression)) {
      const bindingName = exportExpression.name?.text ?? fallbackBindingName
      exportedBindings.set(exportName, {
        id: functionNodeId(filePath, bindingName),
        kind: 'function',
        sourceFile: filePath,
        label: bindingName,
        line: lineOf(exportExpression, sourceFile),
        synthesizeNode: true,
      })
    }
  }

  const collectRoutes = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const parsedRoute = parseRouteCall(
        node,
        sourceFile,
        filePath,
        expressEntities,
        importedBindingsByLocalName,
        importedModulePathsByLocalName,
      )
      if (parsedRoute) {
        const method = parsedRoute.method.toUpperCase()
        const routeLabel = `${method} ${parsedRoute.path}`
        const flattenedArgs = parsedRoute.routeArgs.flatMap((argument) => flattenedExpressions(argument))
        const attachments: RouteAttachment[] = []

        if (parsedRoute.method === 'use') {
          for (const argument of flattenedArgs) {
            const routerTarget = resolveRouterTarget(
              argument,
              sourceFile,
              expressEntities,
              importedBindingsByLocalName,
              importedModulePathsByLocalName,
              filePath,
            )

            if (routerTarget) {
              mountRecords.push({
                owner: parsedRoute.owner,
                prefix: parsedRoute.path,
                line: lineOf(node, sourceFile),
                inheritedMiddleware: [...attachments],
                routerTarget,
              })
              continue
            }

            const attachment = resolveLocalRouteAttachment(
              argument,
              routeLabel,
              'middleware',
                sourceFile,
                filePath,
                functionInfoByName,
                importedBindingsByLocalName,
                importedModulePathsByLocalName,
              )
              if (attachment) {
                attachments.push(attachment)
            }
          }
        } else if (HTTP_ROUTE_METHODS.has(parsedRoute.method) && flattenedArgs.length > 0) {
          for (let index = 0; index < flattenedArgs.length; index += 1) {
            const relation = index === flattenedArgs.length - 1 ? 'handles_route' : 'middleware'
            const attachment = resolveLocalRouteAttachment(
              flattenedArgs[index]!,
              routeLabel,
              relation,
              sourceFile,
              filePath,
              functionInfoByName,
              importedBindingsByLocalName,
              importedModulePathsByLocalName,
            )
            if (attachment) {
              attachments.push(attachment)
            }
          }
        }

        routeRecords.push({
          ownerId: parsedRoute.owner.id,
          ownerName: parsedRoute.owner.name,
          method,
          path: parsedRoute.path,
          line: lineOf(node, sourceFile),
          sourceFile: filePath,
          attachments,
        })
      }
    }

    ts.forEachChild(node, collectRoutes)
  }

  const collectExports = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
      if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        addExportedBinding(node.name.text, node.name.text)
        if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
          addExportedBinding('default', node.name.text)
        }
      }
    }

    if (ts.isFunctionDeclaration(node) && !node.name) {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
      if (
        modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
        modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
      ) {
        exportedBindings.set('default', {
          id: functionNodeId(filePath, 'default'),
          kind: 'function',
          sourceFile: filePath,
          label: 'default()',
          line: lineOf(node, sourceFile),
        })
      }
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
      if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        addExportedBinding(node.name.text, node.name.text)
        if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
          addExportedBinding('default', node.name.text)
        }
      }
    }

    if (ts.isClassDeclaration(node) && !node.name) {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
      if (
        modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
        modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
      ) {
        exportedBindings.set('default', {
          id: functionNodeId(filePath, 'default'),
          kind: 'function',
          sourceFile: filePath,
          label: 'default',
          line: lineOf(node, sourceFile),
        })
      }
    }

    if (ts.isVariableStatement(node)) {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
      if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            addExportedBinding(declaration.name.text, declaration.name.text)
          }
        }
      }
    }

    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause) && !node.moduleSpecifier) {
      for (const element of node.exportClause.elements) {
        const localName = element.propertyName?.text ?? element.name.text
        addExportedBinding(element.name.text, localName)
      }
    }

    if (ts.isExportAssignment(node)) {
      addCallableExportedBinding('default', node.expression)
    }

    if (
      ts.isExpressionStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = unparenthesizeExpression(node.expression.left)
      const right = unparenthesizeExpression(node.expression.right)

      if (
        ts.isPropertyAccessExpression(left) &&
        ts.isIdentifier(left.expression) &&
        left.expression.text === 'module' &&
        left.name.text === 'exports'
      ) {
        if (ts.isObjectLiteralExpression(right)) {
          for (const property of right.properties) {
            if (ts.isShorthandPropertyAssignment(property)) {
              addExportedBinding(property.name.text, property.name.text)
              continue
            }

            if (!ts.isPropertyAssignment(property)) {
              continue
            }

            const exportPropertyName = propertyNameText(property.name)
            const localName = identifierName(property.initializer)
            if (exportPropertyName && localName) {
              addExportedBinding(exportPropertyName, localName)
            }
          }
        } else {
          addCallableExportedBinding('default', right)
        }
      }

      if (
        ts.isPropertyAccessExpression(left) &&
        ts.isPropertyAccessExpression(left.expression) &&
        ts.isIdentifier(left.expression.expression) &&
        left.expression.expression.text === 'module' &&
        left.expression.name.text === 'exports'
      ) {
        addCallableExportedBinding(left.name.text, right, left.name.text)
      }

      if (
        ts.isPropertyAccessExpression(left) &&
        ts.isIdentifier(left.expression) &&
        left.expression.text === 'exports'
      ) {
        addCallableExportedBinding(left.name.text, right, left.name.text)
      }
    }

    ts.forEachChild(node, collectExports)
  }

  collectImportAliases(sourceFile)
  collectFunctionInfo(sourceFile)
  registerBindings(sourceFile)
  collectExports(sourceFile)
  resolveImportedBindings(sourceFile)
  collectRoutes(sourceFile)
  analysis.routeRecords = routeRecords

  const resolveRouteRecords = createRouteRecordResolver(filePath, routeRecords, mountRecords, (routerTarget) =>
    analyzeExpressModule(routerTarget.sourceFile).routeRecords.filter((record) => record.ownerId === routerTarget.id),
  )
  analysis.routeRecords = dedupeRouteRecords([
    ...routeRecords,
    ...mountRecords.flatMap((mountRecord) => resolveRouteRecords(mountRecord.routerTarget).map((record) => createMountedRouteRecord(mountRecord, record))),
  ])

  expressModuleAnalysisCache.set(filePath, analysis)
  return analysis
}

function resolveTargetNodeId(
  expression: ts.Expression,
  routeLabel: string,
  relation: 'middleware' | 'handles_route',
  context: JsFrameworkContext,
  baseNodeIdsByLabel: ReadonlyMap<string, string>,
  baseNodesById: ReadonlyMap<string, ExtractionNodeRecord>,
  functionInfoByName: ReadonlyMap<string, FunctionInfo>,
  importedBindingsByLocalName: ReadonlyMap<string, ImportedBindingTarget>,
  importedModulePathsByLocalName: ReadonlyMap<string, string>,
  nodes: ReturnType<NonNullable<ExtractionFragment['nodes']>['slice']>,
  seenNodeIds: Set<string>,
): RouteAttachment | null {
  const candidate = resolveWrappedTargetExpression(expression)
  if (!candidate) {
    return null
  }

  const label = identifierName(candidate)
  if (label) {
    const nodeId = resolveNamedBaseNodeId(label, baseNodeIdsByLabel)
    if (nodeId) {
      const baseNode = baseNodesById.get(nodeId)
      const functionInfo = functionInfoByName.get(label)
      if (baseNode) {
        addNode(
          nodes,
          seenNodeIds,
          {
            ...baseNode,
            node_kind: 'function',
            framework: 'express',
            framework_role: frameworkRoleForCallable(relation, functionInfo?.arity ?? null),
          },
        )
      }
      return { relation, targetId: nodeId }
    }

    const importedBinding = resolveImportedBindingTarget(candidate, importedBindingsByLocalName, importedModulePathsByLocalName)
    if (importedBinding?.kind === 'function') {
      if (importedBinding.synthesizeNode && importedBinding.label) {
        addNode(
          nodes,
          seenNodeIds,
          createNode(importedBinding.id, importedBinding.label, importedBinding.sourceFile, importedBinding.line ?? 1),
        )
      }
      return { relation, targetId: importedBinding.id }
    }
  }

  if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) {
    const functionName = candidate.name?.text ?? `inline ${relation} ${routeLabel}`
    const id = _makeId(context.filePath, relation, routeLabel, String(lineOf(candidate, context.sourceFile)), functionName)
    addNode(
      nodes,
      seenNodeIds,
      {
        ...createNode(id, functionName, context.filePath, lineOf(candidate, context.sourceFile)),
        node_kind: 'function',
        framework: 'express',
        framework_role: frameworkRoleForCallable(relation, candidate.parameters.length),
      },
    )
    return { relation, targetId: id, ownedByRoute: relation === 'handles_route' }
  }

  return null
}

function addRouteAttachmentEdges(
  edges: ReturnType<NonNullable<ExtractionFragment['edges']>['slice']>,
  seenEdges: Set<string>,
  sourceFile: string,
  line: number,
  routeId: string,
  attachment: RouteAttachment,
): void {
  addUniqueEdge(edges, seenEdges, createEdge(attachment.targetId, routeId, attachment.relation, sourceFile, line))
  addUniqueEdge(edges, seenEdges, createEdge(routeId, attachment.targetId, 'depends_on', sourceFile, line))
  if (attachment.ownedByRoute) {
    addUniqueEdge(edges, seenEdges, createEdge(routeId, attachment.targetId, 'contains', sourceFile, line))
  }
}

function parseRouteCall(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
  expressEntities: ReadonlyMap<string, ExpressEntity>,
  importedBindingsByLocalName: ReadonlyMap<string, ImportedBindingTarget>,
  importedModulePathsByLocalName: ReadonlyMap<string, string>,
): { owner: ExpressEntity; method: string; path: string; routeArgs: readonly ts.Expression[] } | null {
  const callee = unparenthesizeExpression(call.expression)
  if (!ts.isPropertyAccessExpression(callee)) {
    return null
  }

  const method = callee.name.text
  if (!EXPRESS_ROUTE_METHODS.has(method)) {
    return null
  }

  const resolveRouteTarget = (expression: ts.Expression): { owner: ExpressEntity; path: string } | null => {
    const unwrapped = unparenthesizeExpression(expression)
    const ownerTarget = resolveExpressOwnerTarget(
      unwrapped,
      sourceFile,
      filePath,
      expressEntities,
      importedBindingsByLocalName,
      importedModulePathsByLocalName,
    )
    if (ownerTarget) {
      return { owner: ownerTarget.entity, path: '/' }
    }

    if (!ts.isCallExpression(unwrapped)) {
      return null
    }

    const routeCallee = unparenthesizeExpression(unwrapped.expression)
    if (ts.isPropertyAccessExpression(routeCallee) && routeCallee.name.text === 'route') {
      const ownerTarget = resolveExpressOwnerTarget(
        routeCallee.expression,
        sourceFile,
        filePath,
        expressEntities,
        importedBindingsByLocalName,
        importedModulePathsByLocalName,
      )
      const path = stringLiteralPath(unwrapped.arguments[0])
      return ownerTarget && path ? { owner: ownerTarget.entity, path } : null
    }

    if (ts.isPropertyAccessExpression(routeCallee) && EXPRESS_ROUTE_METHODS.has(routeCallee.name.text)) {
      return resolveRouteTarget(routeCallee.expression)
    }

    return null
  }

  const ownerExpression = unparenthesizeExpression(callee.expression)
  const ownerTarget = resolveExpressOwnerTarget(
    ownerExpression,
    sourceFile,
    filePath,
    expressEntities,
    importedBindingsByLocalName,
    importedModulePathsByLocalName,
  )
  if (ownerTarget) {
    const path = stringLiteralPath(call.arguments[0]) ?? (method === 'use' ? '/' : null)
    if (!path) {
      return null
    }

    return {
      owner: ownerTarget.entity,
      method,
      path,
      routeArgs: call.arguments.slice(stringLiteralPath(call.arguments[0]) ? 1 : 0),
    }
  }

  const routeTarget = resolveRouteTarget(ownerExpression)
  if (!routeTarget || method === 'use') {
    return null
  }

  const directPath = stringLiteralPath(call.arguments[0])

  return {
    owner: routeTarget.owner,
    method,
    path: directPath ?? routeTarget.path,
    routeArgs: call.arguments.slice(directPath ? 1 : 0),
  }
}

export const expressAdapter: JsFrameworkAdapter = {
  id: 'js:express',
  matches(_filePath, sourceText) {
    return EXPRESS_MATCH_PATTERN.test(sourceText) || (IMPORTED_OWNER_ROUTE_PATTERN.test(sourceText) && MODULE_IMPORT_PATTERN.test(sourceText))
  },
  extract(context) {
    const nodes: NonNullable<ExtractionFragment['nodes']> = []
    const edges: NonNullable<ExtractionFragment['edges']> = []
    const seenNodeIds = new Set<string>()
    const seenEdges = new Set<string>()
    const baseNodeIdsByLabel = new Map(
      (context.baseExtraction.nodes ?? []).map((node) => [String(node.label).toLowerCase(), node.id] as const),
    )
    const baseNodesById = new Map((context.baseExtraction.nodes ?? []).map((node) => [node.id, node] as const))
    const expressFactoryAliases = new Set<string>()
    const expressRouterAliases = new Set<string>()
    const importedBindingsByLocalName = new Map<string, ImportedBindingTarget>()
    const importedModulePathsByLocalName = new Map<string, string>()
    const expressEntities = new Map<string, ExpressEntity>()
    const functionInfoByName = new Map<string, FunctionInfo>()
    const routeRecords: RouteRecord[] = []
    const mountRecords: MountRecord[] = []

    const registerExpressEntity = (name: string, kind: ExpressEntity['kind'], line: number): void => {
      if (expressEntities.has(name)) {
        return
      }

      const entity: ExpressEntity = {
        id: expressEntityId(context.filePath, name),
        name,
        kind,
      }
      expressEntities.set(name, entity)
      createExpressEntityNode(entity, context, line, nodes, seenNodeIds, edges, seenEdges)
    }

    const registerImports = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const moduleSpecifier = node.moduleSpecifier.text
        const importClause = node.importClause
        if (moduleSpecifier === 'express') {
          if (importClause?.name) {
            expressFactoryAliases.add(importClause.name.text)
          }
          const bindings = importClause?.namedBindings
          if (bindings && ts.isNamespaceImport(bindings)) {
            expressFactoryAliases.add(bindings.name.text)
          }
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              const importedName = element.propertyName?.text ?? element.name.text
              if (importedName === 'Router') {
                expressRouterAliases.add(element.name.text)
              }
            }
          }
        } else {
          const resolvedImportPath = resolveImportPath(context.filePath, moduleSpecifier)
          const importedModule = resolvedImportPath ? analyzeExpressModule(resolvedImportPath) : null
          if (resolvedImportPath && importedModule && importClause?.name) {
            const importedTarget = importedModule.exportedBindings.get('default')
            if (importedTarget) {
              importedBindingsByLocalName.set(importClause.name.text, importedTarget)
            }
          }
          const bindings = importClause?.namedBindings
          if (resolvedImportPath && bindings && ts.isNamespaceImport(bindings)) {
            importedModulePathsByLocalName.set(bindings.name.text, resolvedImportPath)
          }
          if (resolvedImportPath && importedModule && bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              const importedName = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text
              const importedTarget = importedModule.exportedBindings.get(importedName)
              if (importedTarget) {
                importedBindingsByLocalName.set(element.name.text, importedTarget)
              }
            }
          }
        }
      }

      const importEqualsSpecifier = importEqualsModuleSpecifier(node)
      if (importEqualsSpecifier) {
        if (importEqualsSpecifier.moduleSpecifier === 'express') {
          expressFactoryAliases.add(importEqualsSpecifier.localName)
        } else {
          const resolvedImportPath = resolveImportPath(context.filePath, importEqualsSpecifier.moduleSpecifier)
          const importedModule = resolvedImportPath ? analyzeExpressModule(resolvedImportPath) : null
          if (resolvedImportPath) {
            importedModulePathsByLocalName.set(importEqualsSpecifier.localName, resolvedImportPath)
          }
          if (resolvedImportPath && importedModule) {
            const importedTarget = importedModule.exportedBindings.get('default')
            if (importedTarget) {
              importedBindingsByLocalName.set(importEqualsSpecifier.localName, importedTarget)
            }
          }
        }
      }

      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'require' &&
        ts.isStringLiteral(node.initializer.arguments[0]!)
      ) {
        const requiredModule = node.initializer.arguments[0]!.text
        if (requiredModule === 'express') {
          expressFactoryAliases.add(node.name.text)
        } else {
          const resolvedImportPath = resolveImportPath(context.filePath, requiredModule)
          const importedModule = resolvedImportPath ? analyzeExpressModule(resolvedImportPath) : null
          if (resolvedImportPath) {
            importedModulePathsByLocalName.set(node.name.text, resolvedImportPath)
          }
          if (resolvedImportPath && importedModule) {
            const importedTarget = importedModule.exportedBindings.get('default')
            if (importedTarget) {
              importedBindingsByLocalName.set(node.name.text, importedTarget)
            }
          }
        }
      }

      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'require' &&
        ts.isStringLiteral(node.initializer.arguments[0]!)
      ) {
        const requiredModule = node.initializer.arguments[0]!.text
        if (requiredModule === 'express') {
          for (const element of node.name.elements) {
            const importedName =
              element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.getText(context.sourceFile)
            if (importedName === 'Router' && ts.isIdentifier(element.name)) {
              expressRouterAliases.add(element.name.text)
            }
          }
        } else {
          const resolvedImportPath = resolveImportPath(context.filePath, requiredModule)
          const importedModule = resolvedImportPath ? analyzeExpressModule(resolvedImportPath) : null
          if (resolvedImportPath && importedModule) {
            for (const element of node.name.elements) {
              if (!ts.isIdentifier(element.name)) {
                continue
              }
              const importedName =
                !element.propertyName || ts.isIdentifier(element.propertyName)
                  ? (element.propertyName?.text ?? element.name.text)
                  : element.propertyName.getText(context.sourceFile)
              const importedTarget = importedModule.exportedBindings.get(importedName)
              if (importedTarget) {
                importedBindingsByLocalName.set(element.name.text, importedTarget)
              }
            }
          }
        }
      }

      ts.forEachChild(node, registerImports)
    }

    registerImports(context.sourceFile)

    const collectFunctionInfo = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        functionInfoByName.set(node.name.text, {
          line: lineOf(node, context.sourceFile),
          arity: node.parameters.length,
        })
      }

      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        functionInfoByName.set(node.name.text, {
          line: lineOf(node, context.sourceFile),
          arity: node.initializer.parameters.length,
        })
      }

      ts.forEachChild(node, collectFunctionInfo)
    }

    collectFunctionInfo(context.sourceFile)

    const registerBindings = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
        const initializer = node.initializer
        const callee = unparenthesizeExpression(initializer.expression)
        const line = lineOf(node, context.sourceFile)

        if (isExpressFactoryCallee(callee, expressFactoryAliases)) {
          registerExpressEntity(node.name.text, 'app', line)
        }

        if (isExpressRouterCallee(callee, expressFactoryAliases, expressRouterAliases)) {
          registerExpressEntity(node.name.text, 'router', line)
        }
      }

      ts.forEachChild(node, registerBindings)
    }

    registerBindings(context.sourceFile)

    const visitRoutes = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const parsedRoute = parseRouteCall(
          node,
          context.sourceFile,
          context.filePath,
          expressEntities,
          importedBindingsByLocalName,
          importedModulePathsByLocalName,
        )
        if (parsedRoute) {
          const method = parsedRoute.method.toUpperCase()
          const routeLabel = `${method} ${parsedRoute.path}`
          const routeLine = lineOf(node, context.sourceFile)
          const routeId = routeNodeId(context.filePath, parsedRoute.owner.name, method, parsedRoute.path, routeLine)

          addNode(
            nodes,
            seenNodeIds,
            {
              ...createNode(routeId, routeLabel, context.filePath, routeLine),
              node_kind: 'route',
              framework: 'express',
              framework_role: 'express_route',
              http_method: method,
              route_path: parsedRoute.path,
            },
          )
          addUniqueEdge(edges, seenEdges, createEdge(context.fileNodeId, routeId, 'declares', context.filePath, routeLine))
          addUniqueEdge(edges, seenEdges, createEdge(parsedRoute.owner.id, routeId, 'registers_route', context.filePath, routeLine))

          const flattenedArgs = parsedRoute.routeArgs.flatMap((argument) => flattenedExpressions(argument))
          const routeRecord: RouteRecord = {
            ownerId: parsedRoute.owner.id,
            ownerName: parsedRoute.owner.name,
            method,
            path: parsedRoute.path,
            line: routeLine,
            sourceFile: context.filePath,
            attachments: [],
          }

          if (parsedRoute.method === 'use') {
            const inheritedMiddleware: RouteAttachment[] = []
            for (const argument of flattenedArgs) {
                const routerTarget = resolveRouterTarget(
                  argument,
                  context.sourceFile,
                  expressEntities,
                  importedBindingsByLocalName,
                  importedModulePathsByLocalName,
                  context.filePath,
                )

                if (routerTarget) {
                addUniqueEdge(edges, seenEdges, createEdge(parsedRoute.owner.id, routerTarget.id, 'mounts_router', context.filePath, routeLine))
                mountRecords.push({
                  owner: parsedRoute.owner,
                  prefix: parsedRoute.path,
                  line: routeLine,
                  inheritedMiddleware: [...inheritedMiddleware],
                  routerTarget,
                })
                continue
              }

              const middlewareAttachment = resolveTargetNodeId(
                argument,
                routeLabel,
                'middleware',
                context,
                baseNodeIdsByLabel,
                baseNodesById,
                functionInfoByName,
                importedBindingsByLocalName,
                importedModulePathsByLocalName,
                nodes,
                seenNodeIds,
              )
              if (middlewareAttachment) {
                addRouteAttachmentEdges(edges, seenEdges, context.filePath, routeLine, routeId, middlewareAttachment)
                inheritedMiddleware.push(middlewareAttachment)
                routeRecord.attachments.push(middlewareAttachment)
              }
            }
          } else if (HTTP_ROUTE_METHODS.has(parsedRoute.method) && flattenedArgs.length > 0) {
            for (let index = 0; index < flattenedArgs.length; index += 1) {
              const argument = flattenedArgs[index]!
              const relation = index === flattenedArgs.length - 1 ? 'handles_route' : 'middleware'
              const attachment = resolveTargetNodeId(
                argument,
                routeLabel,
                relation,
                context,
                baseNodeIdsByLabel,
                baseNodesById,
                functionInfoByName,
                importedBindingsByLocalName,
                importedModulePathsByLocalName,
                nodes,
                seenNodeIds,
              )
              if (attachment) {
                addRouteAttachmentEdges(edges, seenEdges, context.filePath, routeLine, routeId, attachment)
                routeRecord.attachments.push(attachment)
              }
            }
          }

          routeRecords.push(routeRecord)
        }
      }

      ts.forEachChild(node, visitRoutes)
    }

    visitRoutes(context.sourceFile)

    const resolveRouteRecords = createRouteRecordResolver(context.filePath, routeRecords, mountRecords, (routerTarget) =>
      analyzeExpressModule(routerTarget.sourceFile).routeRecords.filter((record) => record.ownerId === routerTarget.id),
    )

    for (const mountRecord of mountRecords) {
      const descendantRoutes = resolveRouteRecords(mountRecord.routerTarget)

      for (const descendantRoute of descendantRoutes) {
        const mountedRouteRecord = createMountedRouteRecord(mountRecord, descendantRoute)
        const mountedLabel = `${mountedRouteRecord.method} ${mountedRouteRecord.path}`
        const mountedRouteId = routeNodeId(
          context.filePath,
          mountedRouteRecord.ownerName,
          mountedRouteRecord.method,
          mountedRouteRecord.path,
          mountedRouteRecord.line,
        )

        addNode(
          nodes,
          seenNodeIds,
          {
            ...createNode(mountedRouteId, mountedLabel, mountedRouteRecord.sourceFile, mountedRouteRecord.line),
            node_kind: 'route',
            framework: 'express',
            framework_role: 'express_route',
            http_method: mountedRouteRecord.method,
            route_path: mountedRouteRecord.path,
          },
        )
        addUniqueEdge(edges, seenEdges, createEdge(context.fileNodeId, mountedRouteId, 'declares', context.filePath, mountRecord.line))
        addUniqueEdge(edges, seenEdges, createEdge(mountRecord.owner.id, mountedRouteId, 'registers_route', context.filePath, mountRecord.line))

        for (const attachment of mountedRouteRecord.attachments) {
          addRouteAttachmentEdges(edges, seenEdges, context.filePath, mountRecord.line, mountedRouteId, attachment)
        }
      }
    }

    return { nodes, edges }
  },
}
