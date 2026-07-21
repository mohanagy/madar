import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'

import * as ts from 'typescript'

import type { ExtractionNode } from '../contracts.js'
import { addNode, addUniqueEdge, createEdge, createNode, _makeId } from '../core.js'
import type { ExtractionFragment } from '../dispatch.js'
import { unparenthesizeExpression } from '../typescript-utils.js'
import { resolveImportPath, scriptKindForPath } from './js-import-paths.js'
import type { JsFrameworkAdapter, JsFrameworkContext } from './types.js'

const NEXT_MATCH_PATTERN = /(^|[/\\])(app|pages)([/\\])|(^|[/\\])middleware\.[cm]?[jt]sx?$|['"]use client['"]|['"]use server['"]/
const NEXT_APP_FILE_STEMS = new Set(['page', 'layout', 'template', 'loading', 'error', 'not-found', 'default', 'route'])
const NEXT_PAGES_SPECIAL_STEMS = new Set(['_app', '_document', '_error'])
const HTTP_METHOD_EXPORTS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'] as const

type RuntimeBoundary = 'client' | 'server'

interface NextProjectDirs {
  rootDir: string
  appDir?: string | undefined
  pagesDir?: string | undefined
}

interface NextExportReference {
  id: string
  label: string
  sourceFile: string
  line: number
  nodeKind: NonNullable<ExtractionNode['node_kind']>
  frameworkRole?: string | undefined
  runtimeBoundary?: RuntimeBoundary | undefined
}

interface NextModuleAnalysis {
  exports: Map<string, NextExportReference>
  fileBoundary?: RuntimeBoundary | undefined
}

interface AppFileInfo {
  rootDir: string
  appDir: string
  filePath: string
  stem: string
  routePath: string
  dirPath: string
  slotName?: string | undefined
}

interface PagesFileInfo {
  rootDir: string
  pagesDir: string
  filePath: string
  stem: string
  routePath?: string | undefined
  kind: 'page' | 'api' | 'special'
}

interface NextSemanticSpec {
  id: string
  label: string
  sourceFile: string
  line: number
  nodeKind: NonNullable<ExtractionNode['node_kind']>
  frameworkRole?: string | undefined
  routePath?: string | undefined
  runtimeBoundary?: RuntimeBoundary | undefined
  parallelSlot?: string | undefined
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function findBaseNode(context: JsFrameworkContext, name: string) {
  const candidates = new Set([name, `${name}()`, `.${name}()`])
  return context.baseExtraction.nodes?.find((node) => candidates.has(node.label)) ?? null
}

function normalizeRoutePath(parts: readonly string[]): string {
  const segments = parts
    .map((part) => part.trim())
    .filter(Boolean)

  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

function nextRouteNodeId(rootDir: string, routePath: string): string {
  return _makeId(resolve(rootDir), 'nextjs', 'route', routePath)
}

function nextSemanticNodeId(rootDir: string, role: string, routePath: string, extra?: string): string {
  return _makeId(resolve(rootDir), 'nextjs', role, routePath, extra ?? '')
}

function nextSpecialNodeId(rootDir: string, label: string): string {
  return _makeId(resolve(rootDir), 'nextjs', 'special', label)
}

function upsertFrameworkNode(nodes: ExtractionNode[], seenIds: Set<string>, node: ExtractionNode): string {
  const existingIndex = nodes.findIndex((candidate) => candidate.id === node.id)
  if (existingIndex >= 0) {
    nodes[existingIndex] = {
      ...nodes[existingIndex],
      ...node,
    }
    return node.id
  }

  addNode(nodes, seenIds, node)
  return node.id
}

function createFrameworkNode(spec: NextSemanticSpec): ExtractionNode {
  const node: ExtractionNode = {
    ...createNode(spec.id, spec.label, spec.sourceFile, spec.line),
    id: spec.id,
    node_kind: spec.nodeKind,
    framework: 'nextjs',
  }
  if (spec.frameworkRole) {
    node.framework_role = spec.frameworkRole
  }
  if (spec.routePath) {
    node.route_path = spec.routePath
  }
  if (spec.runtimeBoundary) {
    node.runtime_boundary = spec.runtimeBoundary
  }
  if (spec.parallelSlot) {
    node.parallel_slot = spec.parallelSlot
  }
  return node
}

function addSemanticNode(nodes: ExtractionNode[], seenIds: Set<string>, spec: NextSemanticSpec): string {
  return upsertFrameworkNode(nodes, seenIds, createFrameworkNode(spec))
}

function addAugmentedBaseNode(
  context: JsFrameworkContext,
  nodes: ExtractionNode[],
  seenIds: Set<string>,
  label: string,
  nodeKind: NonNullable<ExtractionNode['node_kind']>,
  frameworkRole: string,
  runtimeBoundary?: RuntimeBoundary,
): string {
  const baseNode = findBaseNode(context, label)
  const id = baseNode?.id ?? _makeId(resolve(context.filePath), label)
  const node: ExtractionNode = {
    ...(baseNode ?? createNode(id, label, context.filePath, 1)),
    id,
    node_kind: nodeKind,
    framework: 'nextjs',
    framework_role: frameworkRole,
  }
  if (runtimeBoundary) {
    node.runtime_boundary = runtimeBoundary
  }
  return upsertFrameworkNode(nodes, seenIds, node)
}

function hasDirectivePrologue(statements: readonly ts.Statement[], directive: string): boolean {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) {
      break
    }
    if (statement.expression.text === directive) {
      return true
    }
  }
  return false
}

function sourceFileBoundary(sourceFile: ts.SourceFile): RuntimeBoundary | undefined {
  if (hasDirectivePrologue(sourceFile.statements, 'use client')) {
    return 'client'
  }
  if (hasDirectivePrologue(sourceFile.statements, 'use server')) {
    return 'server'
  }
  return undefined
}

function functionBoundary(node: ts.FunctionLikeDeclarationBase): RuntimeBoundary | undefined {
  if (!node.body || !ts.isBlock(node.body)) {
    return undefined
  }
  if (hasDirectivePrologue(node.body.statements, 'use server')) {
    return 'server'
  }
  if (hasDirectivePrologue(node.body.statements, 'use client')) {
    return 'client'
  }
  return undefined
}

function hasExportModifier(node: ts.Node): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function hasDefaultExportModifier(node: ts.Node): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false
}

function exportReferenceLabel(name: string, nodeKind: NonNullable<ExtractionNode['node_kind']>): string {
  return nodeKind === 'class' ? name : `${name}()`
}

function exportReferenceForDeclaration(
  filePath: string,
  name: string,
  nodeKind: NonNullable<ExtractionNode['node_kind']>,
  line: number,
  frameworkRole?: string,
  runtimeBoundary?: RuntimeBoundary,
): NextExportReference {
  const reference: NextExportReference = {
    id: _makeId(resolve(filePath), name),
    label: exportReferenceLabel(name, nodeKind),
    sourceFile: filePath,
    line,
    nodeKind,
  }
  if (frameworkRole) {
    reference.frameworkRole = frameworkRole
  }
  if (runtimeBoundary) {
    reference.runtimeBoundary = runtimeBoundary
  }
  return reference
}

function roleForBoundary(boundary: RuntimeBoundary | undefined): string | undefined {
  if (boundary === 'client') {
    return 'next_client_component'
  }
  if (boundary === 'server') {
    return 'next_server_action'
  }
  return undefined
}

function analyzeNextModule(filePath: string, cache: Map<string, NextModuleAnalysis>): NextModuleAnalysis {
  const resolvedFilePath = resolve(filePath)
  const cached = cache.get(resolvedFilePath)
  if (cached) {
    return cached
  }

  const analysis: NextModuleAnalysis = {
    exports: new Map<string, NextExportReference>(),
  }
  cache.set(resolvedFilePath, analysis)

  let sourceText: string
  try {
    sourceText = readFileSync(resolvedFilePath, 'utf8')
  } catch {
    return analysis
  }

  const sourceFile = ts.createSourceFile(resolvedFilePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(resolvedFilePath))
  const fileBoundary = sourceFileBoundary(sourceFile)
  if (fileBoundary) {
    analysis.fileBoundary = fileBoundary
  }
  const localBindings = new Map<string, NextExportReference>()

  const recordExport = (exportName: string, reference: NextExportReference) => {
    analysis.exports.set(exportName, reference)
  }

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const boundary = functionBoundary(statement) ?? fileBoundary
      const reference = exportReferenceForDeclaration(
        resolvedFilePath,
        statement.name.text,
        'function',
        lineOf(statement.name, sourceFile),
        roleForBoundary(boundary),
        boundary,
      )
      localBindings.set(statement.name.text, reference)
      if (hasExportModifier(statement)) {
        recordExport(statement.name.text, reference)
      }
      if (hasDefaultExportModifier(statement)) {
        recordExport('default', reference)
      }
      continue
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      const reference = exportReferenceForDeclaration(
        resolvedFilePath,
        statement.name.text,
        'class',
        lineOf(statement.name, sourceFile),
        roleForBoundary(fileBoundary),
        fileBoundary,
      )
      localBindings.set(statement.name.text, reference)
      if (hasExportModifier(statement)) {
        recordExport(statement.name.text, reference)
      }
      if (hasDefaultExportModifier(statement)) {
        recordExport('default', reference)
      }
      continue
    }

    if (ts.isVariableStatement(statement)) {
      const exported = hasExportModifier(statement)
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue
        }
        const initializer = unparenthesizeExpression(declaration.initializer)
        const functionLike = ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) ? initializer : null
        const classLike = ts.isClassExpression(initializer)
        if (!functionLike && !classLike) {
          continue
        }
        const nodeKind: NonNullable<ExtractionNode['node_kind']> = classLike ? 'class' : 'function'
        const boundary = functionLike ? functionBoundary(functionLike) ?? fileBoundary : fileBoundary
        const reference = exportReferenceForDeclaration(
          resolvedFilePath,
          declaration.name.text,
          nodeKind,
          lineOf(declaration.name, sourceFile),
          roleForBoundary(boundary),
          boundary,
        )
        localBindings.set(declaration.name.text, reference)
        if (exported) {
          recordExport(declaration.name.text, reference)
        }
      }
      continue
    }

    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = unparenthesizeExpression(statement.expression)
      if (ts.isIdentifier(expression)) {
        const reference = localBindings.get(expression.text)
        if (reference) {
          recordExport('default', reference)
        }
      }
    }
  }

  return analysis
}

function collectImportedBindings(filePath: string, sourceFile: ts.SourceFile, cache: Map<string, NextModuleAnalysis>): Map<string, NextExportReference> {
  const importedBindings = new Map<string, NextExportReference>()

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue
    }
    const targetFilePath = resolveImportPath(filePath, statement.moduleSpecifier.text)
    if (!targetFilePath) {
      continue
    }
    const exportedBindings = analyzeNextModule(targetFilePath, cache).exports

    if (statement.importClause.name) {
      const binding = exportedBindings.get('default')
      if (binding) {
        importedBindings.set(statement.importClause.name.text, binding)
      }
    }

    const namedBindings = statement.importClause.namedBindings
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text
        const binding = exportedBindings.get(importedName)
        if (binding) {
          importedBindings.set(element.name.text, binding)
        }
      }
    }
  }

  return importedBindings
}

function collectUsedIdentifiers(sourceFile: ts.SourceFile): Set<string> {
  const identifiers = new Set<string>()

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      return
    }
    if (ts.isIdentifier(node)) {
      identifiers.add(node.text)
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sourceFile, visit)
  return identifiers
}

function preferredNextDir(rootDir: string, name: 'app' | 'pages'): string | undefined {
  const directPath = join(rootDir, name)
  if (existsSync(directPath)) {
    return directPath
  }

  const srcPath = join(rootDir, 'src', name)
  if (existsSync(srcPath)) {
    return srcPath
  }

  return undefined
}

function findNextProjectDirs(filePath: string): NextProjectDirs | null {
  const resolvedFilePath = resolve(filePath)
  const parts = resolvedFilePath.split(sep)
  const appIndex = parts.indexOf('app')
  const pagesIndex = parts.indexOf('pages')
  const relevantIndex = [appIndex, pagesIndex].filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? -1
  if (relevantIndex > 0) {
    const rootDir = parts.slice(0, relevantIndex).join(sep) || sep
    return {
      rootDir,
      appDir: preferredNextDir(rootDir, 'app'),
      pagesDir: preferredNextDir(rootDir, 'pages'),
    }
  }

  let currentDir = dirname(resolvedFilePath)
  while (currentDir !== dirname(currentDir)) {
    const appDir = preferredNextDir(currentDir, 'app')
    const pagesDir = preferredNextDir(currentDir, 'pages')
    if (appDir || pagesDir) {
      return { rootDir: currentDir, appDir, pagesDir }
    }
    currentDir = dirname(currentDir)
  }

  return null
}

function isRouteGroup(segment: string): boolean {
  return segment.startsWith('(') && segment.endsWith(')')
}

function parseAppFileInfo(filePath: string): AppFileInfo | null {
  const projectDirs = findNextProjectDirs(filePath)
  if (!projectDirs?.appDir) {
    return null
  }

  const resolvedFilePath = resolve(filePath)
  const relativePath = relative(projectDirs.appDir, resolvedFilePath)
  if (relativePath === '' || relativePath.startsWith('..')) {
    return null
  }

  const parts = relativePath.split(sep)
  const fileName = parts.pop()
  if (!fileName) {
    return null
  }
  const stem = basename(fileName, extname(fileName))
  if (!NEXT_APP_FILE_STEMS.has(stem)) {
    return null
  }

  const dirPath = dirname(resolvedFilePath)
  const slotSegment = parts.at(-1)
  const slotName = slotSegment?.startsWith('@') ? slotSegment.slice(1) : undefined
  const visibleSegments = parts.filter((segment) => !segment.startsWith('@') && !isRouteGroup(segment))

  return {
    rootDir: projectDirs.rootDir,
    appDir: projectDirs.appDir,
    filePath: resolvedFilePath,
    stem,
    routePath: normalizeRoutePath(visibleSegments),
    dirPath,
    slotName,
  }
}

function parsePagesFileInfo(filePath: string): PagesFileInfo | null {
  const projectDirs = findNextProjectDirs(filePath)
  if (!projectDirs?.pagesDir) {
    return null
  }

  const resolvedFilePath = resolve(filePath)
  const relativePath = relative(projectDirs.pagesDir, resolvedFilePath)
  if (relativePath === '' || relativePath.startsWith('..')) {
    return null
  }

  const parts = relativePath.split(sep)
  const fileName = parts.pop()
  if (!fileName) {
    return null
  }
  const stem = basename(fileName, extname(fileName))

  if (NEXT_PAGES_SPECIAL_STEMS.has(stem)) {
    return {
      rootDir: projectDirs.rootDir,
      pagesDir: projectDirs.pagesDir,
      filePath: resolvedFilePath,
      stem,
      kind: 'special',
    }
  }

  const routeParts = [...parts]
  if (routeParts[0] === 'api') {
    routeParts.push(stem === 'index' ? '' : stem)
    return {
      rootDir: projectDirs.rootDir,
      pagesDir: projectDirs.pagesDir,
      filePath: resolvedFilePath,
      stem,
      kind: 'api',
      routePath: normalizeRoutePath(routeParts.filter(Boolean)),
    }
  }

  if (stem !== 'index') {
    routeParts.push(stem)
  }

  return {
    rootDir: projectDirs.rootDir,
    pagesDir: projectDirs.pagesDir,
    filePath: resolvedFilePath,
    stem,
    kind: 'page',
    routePath: normalizeRoutePath(routeParts),
  }
}

function findExistingFile(basePath: string): string | null {
  for (const extension of JS_EXTENSIONS) {
    const candidate = `${basePath}${extension}`
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

function findMiddlewareFile(rootDir: string): string | null {
  return findExistingFile(join(rootDir, 'middleware'))
}

function middlewareMatchers(filePath: string): string[] {
  let sourceText: string
  try {
    sourceText = readFileSync(filePath, 'utf8')
  } catch {
    return []
  }

  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(filePath))
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) {
      continue
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'config' || !declaration.initializer) {
        continue
      }
      const initializer = unparenthesizeExpression(declaration.initializer)
      if (!ts.isObjectLiteralExpression(initializer)) {
        continue
      }
      for (const property of initializer.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== 'matcher') {
          continue
        }
        const matcherValue = unparenthesizeExpression(property.initializer)
        if (ts.isStringLiteralLike(matcherValue)) {
          return [matcherValue.text]
        }
        if (ts.isArrayLiteralExpression(matcherValue)) {
          return matcherValue.elements
            .map((element) => (ts.isStringLiteralLike(element) ? element.text : null))
            .filter((value): value is string => value !== null)
        }
      }
    }
  }

  return []
}

function matcherAppliesToRoute(matcher: string, routePath: string): boolean {
  if (!matcher.startsWith('/')) {
    return false
  }

  const matcherSegments = matcher.split('/').filter(Boolean)
  const routeSegments = routePath.split('/').filter(Boolean)
  let matcherIndex = 0
  let routeIndex = 0

  while (matcherIndex < matcherSegments.length) {
    const matcherSegment = matcherSegments[matcherIndex]
    if (!matcherSegment) {
      matcherIndex += 1
      continue
    }

    if (matcherSegment.startsWith(':')) {
      if (matcherSegment.endsWith('*')) {
        return matcherIndex === matcherSegments.length - 1 ? routeSegments.length >= routeIndex : true
      }
      if (routeIndex >= routeSegments.length) {
        return false
      }
      matcherIndex += 1
      routeIndex += 1
      continue
    }

    if (routeSegments[routeIndex] !== matcherSegment) {
      return false
    }

    matcherIndex += 1
    routeIndex += 1
  }

  return routeIndex === routeSegments.length
}

function middlewareAppliesToRoute(filePath: string, routePath: string): boolean {
  const matchers = middlewareMatchers(filePath)
  if (matchers.length === 0) {
    return true
  }
  return matchers.some((matcher) => matcherAppliesToRoute(matcher, routePath))
}

function semanticSpecForAppFile(filePath: string): NextSemanticSpec | null {
  const info = parseAppFileInfo(filePath)
  if (!info || info.stem === 'route') {
    return null
  }

  const roleByStem: Record<string, string> = {
    page: 'next_page',
    layout: 'next_layout',
    template: 'next_template',
    loading: 'next_loading',
    error: 'next_error',
    'not-found': 'next_not_found',
    default: 'next_default',
  }
  const label = info.stem === 'default' && info.slotName
    ? `default ${info.routePath} @${info.slotName}`
    : `${info.stem} ${info.routePath}`

  return {
    id: nextSemanticNodeId(info.rootDir, info.stem, info.routePath, info.slotName),
    label,
    sourceFile: info.filePath,
    line: 1,
    nodeKind: 'component',
    frameworkRole: roleByStem[info.stem] ?? 'next_page',
    routePath: info.routePath,
    ...(info.slotName ? { parallelSlot: info.slotName } : {}),
  }
}

function semanticSpecForPagesFile(filePath: string): NextSemanticSpec | null {
  const info = parsePagesFileInfo(filePath)
  if (!info) {
    return null
  }

  if (info.kind === 'page' && info.routePath) {
    return {
      id: nextSemanticNodeId(info.rootDir, 'page', info.routePath),
      label: `page ${info.routePath}`,
      sourceFile: info.filePath,
      line: 1,
      nodeKind: 'component',
      frameworkRole: 'next_page',
      routePath: info.routePath,
      runtimeBoundary: 'server',
    }
  }

  if (info.kind === 'api' && info.routePath) {
    return {
      id: nextSemanticNodeId(info.rootDir, 'api', info.routePath),
      label: `API ${info.routePath}`,
      sourceFile: info.filePath,
      line: 1,
      nodeKind: 'route',
      frameworkRole: 'next_route_handler',
      routePath: info.routePath,
      runtimeBoundary: 'server',
    }
  }

  const roleByStem: Record<string, string> = {
    _app: 'next_pages_app',
    _document: 'next_pages_document',
    _error: 'next_pages_error',
  }
  return {
    id: nextSpecialNodeId(info.rootDir, info.stem),
    label: info.stem,
    sourceFile: info.filePath,
    line: 1,
    nodeKind: 'component',
    frameworkRole: roleByStem[info.stem] ?? 'next_pages_app',
  }
}

function routeSpecForAppPath(rootDir: string, routePath: string): NextSemanticSpec {
  return {
    id: nextRouteNodeId(rootDir, routePath),
    label: routePath,
    sourceFile: join(rootDir, 'app'),
    line: 1,
    nodeKind: 'route',
    frameworkRole: 'next_route',
    routePath,
  }
}

function middlewareSpec(rootDir: string, middlewareFilePath: string): NextSemanticSpec {
  return {
    id: nextSpecialNodeId(rootDir, 'middleware'),
    label: 'middleware',
    sourceFile: middlewareFilePath,
    line: 1,
    nodeKind: 'function',
    frameworkRole: 'next_middleware',
    runtimeBoundary: 'server',
  }
}

function defaultExportName(sourceFile: ts.SourceFile): string | null {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && hasDefaultExportModifier(statement) && statement.name) {
      return statement.name.text
    }
    if (ts.isClassDeclaration(statement) && hasDefaultExportModifier(statement) && statement.name) {
      return statement.name.text
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = unparenthesizeExpression(statement.expression)
      if (ts.isIdentifier(expression)) {
        return expression.text
      }
    }
  }

  return null
}

function namedExportName(sourceFile: ts.SourceFile, exportName: string): string | null {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === exportName && hasExportModifier(statement)) {
      return exportName
    }
    if (ts.isClassDeclaration(statement) && statement.name?.text === exportName && hasExportModifier(statement)) {
      return exportName
    }
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) {
      continue
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === exportName) {
        return exportName
      }
    }
  }

  return null
}

function maybeLinkSemanticOwnerToDefaultExport(
  context: JsFrameworkContext,
  nodes: ExtractionNode[],
  edges: NonNullable<ExtractionFragment['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  semanticNodeId: string,
  sourceFile: ts.SourceFile,
): void {
  const exportName = defaultExportName(sourceFile)
  if (!exportName) {
    return
  }
  const baseNode = findBaseNode(context, exportName)
  if (!baseNode) {
    return
  }

  upsertFrameworkNode(nodes, seenIds, {
    ...baseNode,
    id: baseNode.id,
  })
  addUniqueEdge(edges, seenEdges, createEdge(semanticNodeId, baseNode.id, 'renders', context.filePath, baseNode.source_location ? Number.parseInt(String(baseNode.source_location).replace('L', ''), 10) || 1 : 1))
}

function findAncestorLayoutFiles(appInfo: AppFileInfo): string[] {
  const layouts: string[] = []
  let currentDir = appInfo.dirPath

  while (true) {
    const layoutPath = findExistingFile(join(currentDir, 'layout'))
    if (layoutPath) {
      layouts.push(layoutPath)
    }
    if (relative(appInfo.appDir, currentDir) === '') {
      break
    }
    const parentDir = dirname(currentDir)
    if (parentDir === currentDir || relative(appInfo.appDir, parentDir).startsWith('..')) {
      break
    }
    currentDir = parentDir
  }

  return layouts
}

function findParallelDefaultFiles(appInfo: AppFileInfo): string[] {
  const defaults: string[] = []
  try {
    for (const entry of readdirSync(appInfo.dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('@')) {
        continue
      }
      const defaultPath = findExistingFile(join(appInfo.dirPath, entry.name, 'default'))
      if (defaultPath) {
        defaults.push(defaultPath)
      }
    }
  } catch {
    return defaults
  }

  return defaults
}

function linkRouteDependency(
  nodes: ExtractionNode[],
  edges: NonNullable<ExtractionFragment['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  routeNodeId: string,
  spec: NextSemanticSpec | null,
  relation: string,
  sourceFile: string,
): void {
  if (!spec) {
    return
  }
  const targetId = addSemanticNode(nodes, seenIds, spec)
  addUniqueEdge(edges, seenEdges, createEdge(routeNodeId, targetId, relation, sourceFile, spec.line))
}

function annotateBoundaryExports(
  context: JsFrameworkContext,
  nodes: ExtractionNode[],
  seenIds: Set<string>,
  sourceFile: ts.SourceFile,
): void {
  const fileBoundary = sourceFileBoundary(sourceFile)
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement)) {
      const boundary = functionBoundary(statement) ?? fileBoundary
      const role = roleForBoundary(boundary)
      if (role) {
        addAugmentedBaseNode(context, nodes, seenIds, statement.name.text, 'function', role, boundary)
      }
      continue
    }

    if (ts.isClassDeclaration(statement) && statement.name && hasExportModifier(statement)) {
      const role = roleForBoundary(fileBoundary)
      if (role) {
        addAugmentedBaseNode(context, nodes, seenIds, statement.name.text, 'class', role, fileBoundary)
      }
      continue
    }

    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue
        }
        const initializer = unparenthesizeExpression(declaration.initializer)
        const functionLike = ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) ? initializer : null
        const classLike = ts.isClassExpression(initializer)
        if (!functionLike && !classLike) {
          continue
        }
        const boundary = functionLike ? functionBoundary(functionLike) ?? fileBoundary : fileBoundary
        const role = roleForBoundary(boundary)
        if (role) {
          addAugmentedBaseNode(context, nodes, seenIds, declaration.name.text, classLike ? 'class' : 'function', role, boundary)
        }
      }
    }
  }
}

function handleAppFile(
  context: JsFrameworkContext,
  appInfo: AppFileInfo,
  nodes: ExtractionNode[],
  edges: NonNullable<ExtractionFragment['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  moduleCache: Map<string, NextModuleAnalysis>,
): void {
  if (appInfo.stem === 'route') {
    const middlewareFile = findMiddlewareFile(appInfo.rootDir)
    const middlewareNode = middlewareFile ? middlewareSpec(appInfo.rootDir, middlewareFile) : null

    for (const statement of context.sourceFile.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name || !hasExportModifier(statement)) {
        continue
      }
      const method = HTTP_METHOD_EXPORTS.find((candidate) => candidate === statement.name!.text)
      if (!method) {
        continue
      }
      const routeSpec: NextSemanticSpec = {
        id: nextSemanticNodeId(appInfo.rootDir, 'route-handler', appInfo.routePath, method),
        label: `${method} ${appInfo.routePath}`,
        sourceFile: context.filePath,
        line: lineOf(statement.name, context.sourceFile),
        nodeKind: 'route',
        frameworkRole: 'next_route_handler',
        routePath: appInfo.routePath,
        runtimeBoundary: 'server',
      }
      const routeNodeId = addSemanticNode(nodes, seenIds, routeSpec)
      const baseNode = findBaseNode(context, statement.name.text)
      if (baseNode) {
        upsertFrameworkNode(nodes, seenIds, { ...baseNode, id: baseNode.id })
        addUniqueEdge(edges, seenEdges, createEdge(routeNodeId, baseNode.id, 'depends_on', context.filePath, routeSpec.line))
      }
      if (middlewareNode && middlewareAppliesToRoute(middlewareFile!, appInfo.routePath)) {
        linkRouteDependency(nodes, edges, seenIds, seenEdges, routeNodeId, middlewareNode, 'middleware', context.filePath)
      }
    }
    return
  }

  const routeNodeId = addSemanticNode(nodes, seenIds, routeSpecForAppPath(appInfo.rootDir, appInfo.routePath))
  const semanticSpec = semanticSpecForAppFile(context.filePath)
  if (!semanticSpec) {
    return
  }
  const fileBoundary = sourceFileBoundary(context.sourceFile)
  if (fileBoundary) {
    semanticSpec.runtimeBoundary = fileBoundary
  } else if (semanticSpec.frameworkRole === 'next_page') {
    semanticSpec.runtimeBoundary = 'server'
  }
  const semanticNodeId = addSemanticNode(nodes, seenIds, semanticSpec)
  addUniqueEdge(edges, seenEdges, createEdge(routeNodeId, semanticNodeId, 'depends_on', context.filePath, semanticSpec.line))
  maybeLinkSemanticOwnerToDefaultExport(context, nodes, edges, seenIds, seenEdges, semanticNodeId, context.sourceFile)

  if (appInfo.stem !== 'page') {
    return
  }

  for (const layoutFile of findAncestorLayoutFiles(appInfo)) {
    if (resolve(layoutFile) === resolve(context.filePath)) {
      continue
    }
    linkRouteDependency(nodes, edges, seenIds, seenEdges, routeNodeId, semanticSpecForAppFile(layoutFile), 'depends_on', context.filePath)
  }
  for (const siblingStem of ['template', 'loading', 'error', 'not-found'] as const) {
    const siblingFile = findExistingFile(join(appInfo.dirPath, siblingStem))
    if (!siblingFile || resolve(siblingFile) === resolve(context.filePath)) {
      continue
    }
    linkRouteDependency(nodes, edges, seenIds, seenEdges, routeNodeId, semanticSpecForAppFile(siblingFile), 'depends_on', context.filePath)
  }
  for (const defaultFile of findParallelDefaultFiles(appInfo)) {
    linkRouteDependency(nodes, edges, seenIds, seenEdges, routeNodeId, semanticSpecForAppFile(defaultFile), 'depends_on', context.filePath)
  }

  const middlewareFile = findMiddlewareFile(appInfo.rootDir)
  if (middlewareFile && middlewareAppliesToRoute(middlewareFile, appInfo.routePath)) {
    linkRouteDependency(nodes, edges, seenIds, seenEdges, routeNodeId, middlewareSpec(appInfo.rootDir, middlewareFile), 'middleware', context.filePath)
  }

  const importedBindings = collectImportedBindings(context.filePath, context.sourceFile, moduleCache)
  const usedIdentifiers = collectUsedIdentifiers(context.sourceFile)
  for (const [localName, binding] of importedBindings) {
    if (!usedIdentifiers.has(localName)) {
      continue
    }
    const bindingNode = createFrameworkNode({
      id: binding.id,
      label: binding.label,
      sourceFile: binding.sourceFile,
      line: binding.line,
      nodeKind: binding.nodeKind,
      ...(binding.frameworkRole ? { frameworkRole: binding.frameworkRole } : {}),
      ...(binding.runtimeBoundary ? { runtimeBoundary: binding.runtimeBoundary } : {}),
    })
    upsertFrameworkNode(nodes, seenIds, bindingNode)
    if (binding.frameworkRole === 'next_server_action') {
      addUniqueEdge(edges, seenEdges, createEdge(semanticNodeId, binding.id, 'defines_action', context.filePath, binding.line))
    } else if (binding.frameworkRole === 'next_client_component') {
      addUniqueEdge(edges, seenEdges, createEdge(semanticNodeId, binding.id, 'renders', context.filePath, binding.line))
    }
  }
}

function handlePagesFile(
  context: JsFrameworkContext,
  pagesInfo: PagesFileInfo,
  nodes: ExtractionNode[],
  edges: NonNullable<ExtractionFragment['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
): void {
  const semanticSpec = semanticSpecForPagesFile(context.filePath)
  if (!semanticSpec) {
    return
  }

  if (pagesInfo.kind === 'special') {
    addSemanticNode(nodes, seenIds, semanticSpec)
    maybeLinkSemanticOwnerToDefaultExport(context, nodes, edges, seenIds, seenEdges, semanticSpec.id, context.sourceFile)
    return
  }

  const routePath = pagesInfo.routePath
  if (!routePath) {
    return
  }

  if (pagesInfo.kind === 'api') {
    const routeNodeId = addSemanticNode(nodes, seenIds, semanticSpec)
    maybeLinkSemanticOwnerToDefaultExport(context, nodes, edges, seenIds, seenEdges, routeNodeId, context.sourceFile)

    const middlewareFile = findMiddlewareFile(pagesInfo.rootDir)
    if (middlewareFile && middlewareAppliesToRoute(middlewareFile, routePath)) {
      linkRouteDependency(nodes, edges, seenIds, seenEdges, routeNodeId, middlewareSpec(pagesInfo.rootDir, middlewareFile), 'middleware', context.filePath)
    }
    return
  }

  const routeSpec: NextSemanticSpec = {
    id: nextRouteNodeId(pagesInfo.rootDir, routePath),
    label: routePath,
    sourceFile: context.filePath,
    line: 1,
    nodeKind: 'route',
    frameworkRole: 'next_route',
    routePath,
  }
  const routeNodeId = addSemanticNode(nodes, seenIds, routeSpec)
  const ownerNodeId = addSemanticNode(nodes, seenIds, semanticSpec)
  addUniqueEdge(edges, seenEdges, createEdge(routeNodeId, ownerNodeId, 'depends_on', context.filePath, semanticSpec.line))
  maybeLinkSemanticOwnerToDefaultExport(context, nodes, edges, seenIds, seenEdges, ownerNodeId, context.sourceFile)

  const middlewareFile = findMiddlewareFile(pagesInfo.rootDir)
  if (middlewareFile && middlewareAppliesToRoute(middlewareFile, routePath)) {
    linkRouteDependency(nodes, edges, seenIds, seenEdges, routeNodeId, middlewareSpec(pagesInfo.rootDir, middlewareFile), 'middleware', context.filePath)
  }

  if (pagesInfo.kind === 'page') {
    for (const specialStem of NEXT_PAGES_SPECIAL_STEMS) {
      const specialPath = findExistingFile(join(pagesInfo.pagesDir, specialStem))
      if (!specialPath) {
        continue
      }
      linkRouteDependency(nodes, edges, seenIds, seenEdges, routeNodeId, semanticSpecForPagesFile(specialPath), 'depends_on', context.filePath)
    }
  }
}

function handleMiddlewareFile(
  context: JsFrameworkContext,
  nodes: ExtractionNode[],
  edges: NonNullable<ExtractionFragment['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
): void {
  const projectDirs = findNextProjectDirs(context.filePath)
  if (!projectDirs) {
    return
  }
  const semanticNodeId = addSemanticNode(nodes, seenIds, middlewareSpec(projectDirs.rootDir, context.filePath))
  const exportName = namedExportName(context.sourceFile, 'middleware') ?? defaultExportName(context.sourceFile)
  if (!exportName) {
    return
  }
  const baseNode = findBaseNode(context, exportName)
  if (!baseNode) {
    return
  }
  upsertFrameworkNode(nodes, seenIds, {
    ...baseNode,
    id: baseNode.id,
    framework: 'nextjs',
    framework_role: 'next_middleware',
    runtime_boundary: 'server',
  })
  addUniqueEdge(edges, seenEdges, createEdge(semanticNodeId, baseNode.id, 'depends_on', context.filePath, 1))
}

export const nextAdapter: JsFrameworkAdapter = {
  id: 'nextjs',
  matches(filePath, sourceText) {
    return NEXT_MATCH_PATTERN.test(filePath) || NEXT_MATCH_PATTERN.test(sourceText)
  },
  extract(context) {
    const nodes: NonNullable<ExtractionFragment['nodes']> = []
    const edges: NonNullable<ExtractionFragment['edges']> = []
    const seenIds = new Set<string>()
    const seenEdges = new Set<string>()
    const moduleCache = new Map<string, NextModuleAnalysis>()

    annotateBoundaryExports(context, nodes, seenIds, context.sourceFile)

    if (basename(context.filePath).startsWith('middleware.')) {
      handleMiddlewareFile(context, nodes, edges, seenIds, seenEdges)
    }

    const appInfo = parseAppFileInfo(context.filePath)
    if (appInfo) {
      handleAppFile(context, appInfo, nodes, edges, seenIds, seenEdges, moduleCache)
    }

    const pagesInfo = parsePagesFileInfo(context.filePath)
    if (pagesInfo) {
      handlePagesFile(context, pagesInfo, nodes, edges, seenIds, seenEdges)
    }

    return { nodes, edges }
  },
}
