import { readFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'

import * as ts from 'typescript'

import type { ExtractionNode } from '../../../contracts/types.js'
import { detect } from '../../detect.js'
import { addNode, addUniqueEdge, createEdge, createNode, fileStemForPath, _makeId } from '../core.js'
import type { ExtractionFragment } from '../dispatch.js'
import { unparenthesizeExpression } from '../typescript-utils.js'
import { resolveImportPath, scriptKindForPath } from './js-import-paths.js'
import type { JsFrameworkAdapter, JsFrameworkContext } from './types.js'

const NEST_MATCH_PATTERN = /@nestjs\/common|\b@Controller\s*\(|\b@Module\s*\(|\b@Injectable\s*\(|\b@(?:Get|Post|Put|Patch|Delete|Options|Head|All|Processor|Process)\s*\(|\.add\s*\(\s*['"`][^'"`\n]+\.[^'"`\n]+['"`]/
const NEST_COMMON_MODULE_SPECIFIERS = new Set(['@nestjs/common'])
const BULL_CLASS_DECORATOR_NAMES = new Set(['Processor'])
const BULL_METHOD_DECORATOR_NAMES = new Set(['Process'])
const TS_LIKE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'])
const ROUTE_DECORATOR_METHODS = new Map<string, string>([
  ['Get', 'GET'],
  ['Post', 'POST'],
  ['Put', 'PUT'],
  ['Patch', 'PATCH'],
  ['Delete', 'DELETE'],
  ['Options', 'OPTIONS'],
  ['Head', 'HEAD'],
  ['All', 'ALL'],
])

interface NestImportBindings {
  module: Set<string>
  controller: Set<string>
  injectable: Set<string>
  useGuards: Set<string>
  useInterceptors: Set<string>
  usePipes: Set<string>
  routeDecorators: Map<string, string>
  namespaces: Set<string>
}

interface NestReference {
  id: string
  label: string
  sourceFile: string
  line: number
  frameworkRole?: string | undefined
}

interface NestModuleAnalysis {
  exports: Map<string, NestReference>
}

interface NestDecoratorCall {
  name: string
  args: readonly ts.Expression[]
}

interface BullWorkerIndex {
  handlersByKey: Map<string, Set<string>>
  handlersByQueue: Map<string, Set<string>>
}

interface BullWorkerIndexCacheEntry {
  files: Set<string>
  index: BullWorkerIndex
}

const BULL_WORKER_INDEX_CACHE = new Map<string, BullWorkerIndexCacheEntry>()

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text
  }

  return null
}

function createNestImportBindings(): NestImportBindings {
  return {
    module: new Set<string>(),
    controller: new Set<string>(),
    injectable: new Set<string>(),
    useGuards: new Set<string>(),
    useInterceptors: new Set<string>(),
    usePipes: new Set<string>(),
    routeDecorators: new Map<string, string>(),
    namespaces: new Set<string>(),
  }
}

function registerNestImports(sourceFile: ts.SourceFile, bindings: NestImportBindings): void {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue
    }
    if (!NEST_COMMON_MODULE_SPECIFIERS.has(statement.moduleSpecifier.text)) {
      continue
    }

    const namedBindings = statement.importClause.namedBindings
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      bindings.namespaces.add(namedBindings.name.text)
      continue
    }

    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue
    }

    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text
      const localName = element.name.text
      if (importedName === 'Module') {
        bindings.module.add(localName)
      } else if (importedName === 'Controller') {
        bindings.controller.add(localName)
      } else if (importedName === 'Injectable') {
        bindings.injectable.add(localName)
      } else if (importedName === 'UseGuards') {
        bindings.useGuards.add(localName)
      } else if (importedName === 'UseInterceptors') {
        bindings.useInterceptors.add(localName)
      } else if (importedName === 'UsePipes') {
        bindings.usePipes.add(localName)
      } else {
        const method = ROUTE_DECORATOR_METHODS.get(importedName)
        if (method) {
          bindings.routeDecorators.set(localName, method)
        }
      }
    }
  }
}

function decoratorCallInfo(decorator: ts.Decorator): NestDecoratorCall | null {
  const expression = unparenthesizeExpression(decorator.expression)
  if (ts.isCallExpression(expression)) {
    const callee = unparenthesizeExpression(expression.expression)
    if (ts.isIdentifier(callee)) {
      return { name: callee.text, args: expression.arguments }
    }
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
      return { name: callee.name.text, args: expression.arguments }
    }
    return null
  }

  if (ts.isIdentifier(expression)) {
    return { name: expression.text, args: [] }
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
    return { name: expression.name.text, args: [] }
  }

  return null
}

function getDecorators(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []
}

function stringLiteralValue(expression: ts.Expression | undefined): string | null {
  if (!expression) {
    return null
  }

  const unwrapped = unparenthesizeExpression(expression)
  if (ts.isStringLiteralLike(unwrapped)) {
    return unwrapped.text
  }

  if (ts.isObjectLiteralExpression(unwrapped)) {
    for (const property of unwrapped.properties) {
      if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === 'path') {
        const initializer = unparenthesizeExpression(property.initializer)
        if (ts.isStringLiteralLike(initializer)) {
          return initializer.text
        }
      }
    }
  }

  return null
}

function normalizedRoutePath(...parts: string[]): string {
  const segments = parts
    .flatMap((part) => part.split('/'))
    .map((part) => part.trim())
    .filter(Boolean)

  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

function findBaseNode(context: JsFrameworkContext, name: string) {
  const candidates = new Set([name, `${name}()`, `.${name}()`])
  return context.baseExtraction.nodes?.find((node) => candidates.has(node.label)) ?? null
}

function createNestReference(filePath: string, name: string, line: number, frameworkRole?: string): NestReference {
  const reference: NestReference = {
    id: _makeId(moduleStem(filePath), name),
    label: name,
    sourceFile: filePath,
    line,
  }
  if (frameworkRole) {
    reference.frameworkRole = frameworkRole
  }
  return reference
}

function createReferenceFromClassDeclaration(filePath: string, declaration: ts.ClassDeclaration, sourceFile: ts.SourceFile, bindings: NestImportBindings): NestReference | null {
  if (!declaration.name) {
    return null
  }

  let frameworkRole: string | undefined
  for (const decorator of getDecorators(declaration)) {
    const call = decoratorCallInfo(decorator)
    if (!call) {
      continue
    }
    if (bindings.module.has(call.name)) {
      frameworkRole = 'nest_module'
    } else if (bindings.controller.has(call.name)) {
      frameworkRole = 'nest_controller'
    } else if (bindings.injectable.has(call.name)) {
      frameworkRole = 'nest_provider'
    }
  }

  return createNestReference(filePath, declaration.name.text, lineOf(declaration.name, sourceFile), frameworkRole)
}

function analyzeNestModule(filePath: string, cache: Map<string, NestModuleAnalysis>): NestModuleAnalysis {
  const resolvedFilePath = resolve(filePath)
  const cached = cache.get(resolvedFilePath)
  if (cached) {
    return cached
  }

  const analysis: NestModuleAnalysis = { exports: new Map<string, NestReference>() }
  cache.set(resolvedFilePath, analysis)

  let sourceText: string
  try {
    sourceText = readFileSync(resolvedFilePath, 'utf8')
  } catch {
    return analysis
  }

  const sourceFile = ts.createSourceFile(resolvedFilePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(resolvedFilePath))
  const bindings = createNestImportBindings()
  registerNestImports(sourceFile, bindings)

  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) {
      continue
    }

    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
    const defaultExport = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false
    const reference = createReferenceFromClassDeclaration(resolvedFilePath, statement, sourceFile, bindings)
    if (!reference) {
      continue
    }

    if (exported) {
      analysis.exports.set(statement.name.text, reference)
    }
    if (defaultExport) {
      analysis.exports.set('default', reference)
    }
  }

  return analysis
}

function addNestNode(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  seenIds: Set<string>,
  reference: NestReference,
  frameworkRole = reference.frameworkRole,
): string {
  const baseNode = reference.sourceFile === context.filePath ? findBaseNode(context, reference.label) : null
  let id = baseNode?.id ?? reference.id
  const baseCollision = context.baseExtraction.nodes?.find((node) => node.id === id && node.source_file !== reference.sourceFile) ?? null
  const collidingNode = nodes.find((node) => node.id === id)
  if (baseCollision || (collidingNode && collidingNode.source_file !== reference.sourceFile)) {
    id = _makeId(resolve(reference.sourceFile), reference.label)
  }
  const nextNode: ExtractionNode = {
    ...(baseNode ?? createNode(id, reference.label, reference.sourceFile, reference.line)),
    id,
    node_kind: 'class',
    framework: 'nestjs',
  }
  if (frameworkRole) {
    nextNode.framework_role = frameworkRole
  }
  const existingIndex = nodes.findIndex((node) => node.id === id)
  if (existingIndex >= 0) {
    nodes[existingIndex] = {
      ...nodes[existingIndex],
      ...nextNode,
      framework: 'nestjs',
    }
    if (frameworkRole) {
      nodes[existingIndex]!.framework_role = frameworkRole
    }
    return id
  }

  addNode(nodes, seenIds, nextNode)
  return id
}

function routeNodeId(filePath: string, controllerName: string, method: string, path: string, line: number): string {
  return _makeId(filePath, controllerName, method, path, String(line))
}

function flattenDecoratorTargets(expressions: readonly ts.Expression[]): ts.Expression[] {
  const flattened: ts.Expression[] = []
  for (const expression of expressions) {
    const unwrapped = unparenthesizeExpression(expression)
    if (ts.isArrayLiteralExpression(unwrapped)) {
      flattened.push(...unwrapped.elements.filter(ts.isExpression).flatMap((element) => flattenDecoratorTargets([element])))
    } else {
      flattened.push(unwrapped)
    }
  }
  return flattened
}

function localOrImportedReference(
  expression: ts.Expression | ts.EntityName,
  localBindings: ReadonlyMap<string, NestReference>,
  importedBindings: ReadonlyMap<string, NestReference>,
): NestReference | null {
  if (ts.isQualifiedName(expression)) {
    return localBindings.get(expression.right.text) ?? importedBindings.get(expression.right.text) ?? null
  }

  const unwrapped = unparenthesizeExpression(expression)
  if (ts.isIdentifier(unwrapped)) {
    return localBindings.get(unwrapped.text) ?? importedBindings.get(unwrapped.text) ?? null
  }
  if (ts.isPropertyAccessExpression(unwrapped) && ts.isIdentifier(unwrapped.name)) {
    return localBindings.get(unwrapped.name.text) ?? importedBindings.get(unwrapped.name.text) ?? null
  }
  if (ts.isNewExpression(unwrapped)) {
    return localOrImportedReference(unwrapped.expression, localBindings, importedBindings)
  }
  return null
}

function collectImportedBindings(filePath: string, sourceFile: ts.SourceFile, cache: Map<string, NestModuleAnalysis>): Map<string, NestReference> {
  const importedBindings = new Map<string, NestReference>()

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue
    }

    const targetFilePath = resolveImportPath(filePath, statement.moduleSpecifier.text)
    if (!targetFilePath) {
      continue
    }

    const exportedBindings = analyzeNestModule(targetFilePath, cache).exports
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

function collectUseTargets(
  decorators: readonly ts.Decorator[],
  decoratorAliases: ReadonlySet<string>,
  localBindings: ReadonlyMap<string, NestReference>,
  importedBindings: ReadonlyMap<string, NestReference>,
): NestReference[] {
  const references: NestReference[] = []

  for (const decorator of decorators) {
    const call = decoratorCallInfo(decorator)
    if (!call || !decoratorAliases.has(call.name)) {
      continue
    }

    for (const expression of flattenDecoratorTargets(call.args)) {
      const reference = localOrImportedReference(expression, localBindings, importedBindings)
      if (reference) {
        references.push(reference)
      }
    }
  }

  return references
}

function routeDecoratorMethod(
  decorators: readonly ts.Decorator[],
  bindings: NestImportBindings,
): { method: string; path: string } | null {
  for (const decorator of decorators) {
    const call = decoratorCallInfo(decorator)
    if (!call) {
      continue
    }
    const method = bindings.routeDecorators.get(call.name)
    if (!method) {
      continue
    }
    return {
      method,
      path: stringLiteralValue(call.args[0]) ?? '',
    }
  }

  return null
}

function moduleMetadataProperty(decorator: NestDecoratorCall, key: string): ts.ArrayLiteralExpression | null {
  const firstArg = decorator.args[0]
  if (!firstArg) {
    return null
  }
  const unwrapped = unparenthesizeExpression(firstArg)
  if (!ts.isObjectLiteralExpression(unwrapped)) {
    return null
  }

  for (const property of unwrapped.properties) {
    if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === key) {
      const initializer = unparenthesizeExpression(property.initializer)
      return ts.isArrayLiteralExpression(initializer) ? initializer : null
    }
  }

  return null
}

function bullProcessorQueueName(classDecl: ts.ClassDeclaration): string | null {
  for (const decorator of getDecorators(classDecl)) {
    const call = decoratorCallInfo(decorator)
    if (!call || !BULL_CLASS_DECORATOR_NAMES.has(call.name)) {
      continue
    }

    const queueName = stringLiteralValue(call.args[0])
    if (queueName) {
      return queueName
    }
  }

  return null
}

function bullProcessJobName(methodDecl: ts.MethodDeclaration): string | null {
  for (const decorator of getDecorators(methodDecl)) {
    const call = decoratorCallInfo(decorator)
    if (!call || !BULL_METHOD_DECORATOR_NAMES.has(call.name)) {
      continue
    }

    const jobName = stringLiteralValue(call.args[0])
    if (jobName) {
      return jobName
    }
  }

  return null
}

function bullEnqueueJobNameLiteral(callExpr: ts.CallExpression): ts.StringLiteralLike | null {
  const callee = unparenthesizeExpression(callExpr.expression)
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'add') {
    return null
  }

  const [firstArg] = callExpr.arguments
  return firstArg && ts.isStringLiteralLike(firstArg) ? firstArg : null
}

function bullQualifiedJobKey(jobName: string): string | null {
  if (!jobName.includes('.')) {
    return null
  }

  const segments = jobName.split('.')
  return segments.some((segment) => segment.length === 0) ? null : jobName
}

function bullWorkerKey(queueName: string, jobName: string): string {
  return jobName.startsWith(`${queueName}.`) ? jobName : `${queueName}.${jobName}`
}

function expressionNameText(expression: ts.Expression): string | null {
  const unwrapped = unparenthesizeExpression(expression)
  if (ts.isIdentifier(unwrapped)) {
    return unwrapped.text
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return unwrapped.name.text
  }
  if (ts.isElementAccessExpression(unwrapped) && ts.isStringLiteralLike(unwrapped.argumentExpression)) {
    return unwrapped.argumentExpression.text
  }
  if (ts.isAsExpression(unwrapped) || ts.isTypeAssertionExpression(unwrapped)) {
    return expressionNameText(unwrapped.expression)
  }
  if (ts.isCallExpression(unwrapped)) {
    return expressionNameText(unwrapped.expression)
  }
  if (ts.isNewExpression(unwrapped)) {
    return expressionNameText(unwrapped.expression)
  }
  if (unwrapped.kind === ts.SyntaxKind.ThisKeyword) {
    return 'this'
  }
  return null
}

function declarationNameText(node: ts.Node): string | null {
  const namedNode = node as ts.Node & { name?: ts.DeclarationName }
  const name = namedNode.name
  if (!name) {
    return null
  }
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text
  }
  return null
}

function typeNodeNameText(typeNode: ts.TypeNode): string | null {
  if (ts.isTypeReferenceNode(typeNode)) {
    return ts.isIdentifier(typeNode.typeName) ? typeNode.typeName.text : typeNode.typeName.right.text
  }
  return null
}

function queueNameCandidatesFromClass(classDecl: ts.ClassDeclaration | null, propertyName: string): string[] {
  if (!classDecl) {
    return []
  }

  const candidates = new Set<string>()
  const addCandidate = (value: string | null | undefined): void => {
    if (value) {
      candidates.add(value)
    }
  }

  for (const member of classDecl.members) {
    if (
      (ts.isPropertyDeclaration(member) || ts.isParameter(member))
      && declarationNameText(member) === propertyName
    ) {
      if (member.type) {
        addCandidate(typeNodeNameText(member.type))
      }
      if ('initializer' in member && member.initializer && ts.isNewExpression(member.initializer)) {
        addCandidate(expressionNameText(member.initializer.expression))
      }
    }
  }

  return [...candidates]
}

function looksLikeQueueCandidate(candidate: string): boolean {
  const trimmed = candidate.trim()
  if (!trimmed) {
    return false
  }

  if (/(?:^|[.)])Queue(?:<|$)/.test(trimmed)) {
    return true
  }

  const tokens = trimmed
    .split(/[^A-Za-z0-9]+/)
    .flatMap((segment) => segment.match(/[A-Z]+(?=[A-Z][a-z0-9])|[A-Z]?[a-z0-9]+/g) ?? [])
    .map((token) => token.toLowerCase())

  if (tokens.length === 2 && tokens[0] === 'de' && tokens[1] === 'queue') {
    return false
  }

  return tokens.at(-1) === 'queue'
}

function bullReceiverLooksLikeQueue(expression: ts.Expression, classDecl: ts.ClassDeclaration | null): boolean {
  const candidates = new Set<string>()
  const addCandidate = (value: string | null | undefined): void => {
    if (value) {
      candidates.add(value)
    }
  }

  const unwrapped = unparenthesizeExpression(expression)
  addCandidate(expressionNameText(unwrapped))

  if (ts.isPropertyAccessExpression(unwrapped)) {
    addCandidate(unwrapped.name.text)
    if (unwrapped.expression.kind === ts.SyntaxKind.ThisKeyword) {
      for (const candidate of queueNameCandidatesFromClass(classDecl, unwrapped.name.text)) {
        addCandidate(candidate)
      }
    }
  }

  return [...candidates].some(looksLikeQueueCandidate)
}

function uniqueBullWorkerTarget(workerIndex: BullWorkerIndex, key: string): string | null {
  const targets = workerIndex.handlersByKey.get(key)
  if (targets?.size === 1) {
    return [...targets][0] ?? null
  }

  const queueTargets = new Set<string>()
  for (const [queueName, queueHandlers] of workerIndex.handlersByQueue) {
    if (key !== queueName && !key.startsWith(`${queueName}.`)) {
      continue
    }
    for (const target of queueHandlers) {
      queueTargets.add(target)
    }
  }

  if (queueTargets.size !== 1) {
    return null
  }
  return [...queueTargets][0] ?? null
}

function addBullWorkerTarget(index: Map<string, Set<string>>, key: string, methodId: string): void {
  let targets = index.get(key)
  if (!targets) {
    targets = new Set<string>()
    index.set(key, targets)
  }
  targets.add(methodId)
}

function classExtendsNamedBase(classDecl: ts.ClassDeclaration, baseName: string): boolean {
  for (const clause of classDecl.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
      continue
    }
    for (const type of clause.types) {
      if (expressionNameText(type.expression) === baseName) {
        return true
      }
    }
  }
  return false
}

function isBullWorkerHostProcessMethod(classDecl: ts.ClassDeclaration, methodDecl: ts.MethodDeclaration): boolean {
  return !!methodDecl.name
    && ts.isIdentifier(methodDecl.name)
    && methodDecl.name.text === 'process'
    && classExtendsNamedBase(classDecl, 'WorkerHost')
}

function buildBullWorkerIndex(filePaths: readonly string[]): BullWorkerIndex {
  const handlersByKey = new Map<string, Set<string>>()
  const handlersByQueue = new Map<string, Set<string>>()

  for (const filePath of filePaths) {
    let sourceText: string
    try {
      sourceText = readFileSync(filePath, 'utf8')
    } catch {
      continue
    }

    if (!/@Processor\s*\(|@Process\s*\(/.test(sourceText)) {
      continue
    }

    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(filePath))
    for (const statement of sourceFile.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) {
        continue
      }

      const queueName = bullProcessorQueueName(statement)
      if (!queueName) {
        continue
      }

      const classId = _makeId(moduleStem(filePath), statement.name.text)
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) {
          continue
        }

        const methodId = _makeId(classId, member.name.text)
        const jobName = bullProcessJobName(member)
        if (jobName) {
          addBullWorkerTarget(handlersByKey, bullWorkerKey(queueName, jobName), methodId)
        }
        if (isBullWorkerHostProcessMethod(statement, member)) {
          addBullWorkerTarget(handlersByQueue, queueName, methodId)
        }
      }
    }
  }

  return { handlersByKey, handlersByQueue }
}

function sameFileSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false
    }
  }

  return true
}

function getBullWorkerIndex(currentFilePath: string): BullWorkerIndex {
  const workspaceRoot = resolve(process.cwd())
  const cached = BULL_WORKER_INDEX_CACHE.get(workspaceRoot)
  const resolvedCurrentFilePath = resolve(currentFilePath)
  if (cached && cached.files.has(resolvedCurrentFilePath)) {
    return cached.index
  }

  const files = new Set(
    detect(workspaceRoot).files.code
      .map((filePath) => resolve(filePath))
      .filter((filePath) => TS_LIKE_EXTENSIONS.has(extname(filePath))),
  )
  files.add(resolvedCurrentFilePath)
  if (cached && sameFileSet(cached.files, files)) {
    return cached.index
  }

  const index = buildBullWorkerIndex([...files])
  BULL_WORKER_INDEX_CACHE.set(workspaceRoot, { files, index })
  return index
}

function emitBullEnqueueEdgesInBody(
  context: JsFrameworkContext,
  edges: NonNullable<ExtractionFragment['edges']>,
  seenEdges: Set<string>,
  workerIndex: BullWorkerIndex,
  callerId: string,
  body: ts.Block | ts.ConciseBody | undefined,
  classDecl: ts.ClassDeclaration | null,
): void {
  if (!body || !context.baseExtraction.nodes?.some((node) => node.id === callerId)) {
    return
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const jobNameLiteral = bullEnqueueJobNameLiteral(node)
      const callee = unparenthesizeExpression(node.expression)
      if (jobNameLiteral && ts.isPropertyAccessExpression(callee) && bullReceiverLooksLikeQueue(callee.expression, classDecl)) {
        const workerKey = bullQualifiedJobKey(jobNameLiteral.text)
        const targetId = workerKey ? uniqueBullWorkerTarget(workerIndex, workerKey) : null
        if (targetId && targetId !== callerId) {
          addUniqueEdge(edges, seenEdges, createEdge(callerId, targetId, 'enqueues_job', context.filePath, lineOf(jobNameLiteral, context.sourceFile)))
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(body)
}

function emitBullEnqueueEdges(
  context: JsFrameworkContext,
  edges: NonNullable<ExtractionFragment['edges']>,
  seenEdges: Set<string>,
): void {
  const workerIndex = getBullWorkerIndex(context.filePath)
  if (workerIndex.handlersByKey.size === 0 && workerIndex.handlersByQueue.size === 0) {
    return
  }

  for (const statement of context.sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      emitBullEnqueueEdgesInBody(
        context,
        edges,
        seenEdges,
        workerIndex,
        _makeId(moduleStem(context.filePath), statement.name.text),
        statement.body,
        null,
      )
      continue
    }

    if (!ts.isClassDeclaration(statement) || !statement.name) {
      continue
    }

    const classId = _makeId(moduleStem(context.filePath), statement.name.text)
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) {
        continue
      }

      emitBullEnqueueEdgesInBody(
        context,
        edges,
        seenEdges,
        workerIndex,
        _makeId(classId, member.name.text),
        member.body,
        statement,
      )
    }
  }
}

export const nestAdapter: JsFrameworkAdapter = {
  id: 'nestjs',
  matches(_filePath, sourceText) {
    return NEST_MATCH_PATTERN.test(sourceText)
  },
  extract(context) {
    const nodes: NonNullable<ExtractionFragment['nodes']> = []
    const edges: NonNullable<ExtractionFragment['edges']> = []
    const seenIds = new Set<string>()
    const seenEdges = new Set<string>()
    const sourceFile = context.sourceFile
    const bindings = createNestImportBindings()
    registerNestImports(sourceFile, bindings)
    const moduleCache = new Map<string, NestModuleAnalysis>()
    const importedBindings = collectImportedBindings(context.filePath, sourceFile, moduleCache)
    const localBindings = new Map<string, NestReference>()

    for (const statement of sourceFile.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) {
        continue
      }
      const reference = createReferenceFromClassDeclaration(context.filePath, statement, sourceFile, bindings) ?? createNestReference(
        context.filePath,
        statement.name.text,
        lineOf(statement.name, sourceFile),
      )
      localBindings.set(statement.name.text, reference)
    }

    for (const statement of sourceFile.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) {
        continue
      }

      const className = statement.name.text
      const classReference = localBindings.get(className)
      if (!classReference) {
        continue
      }

      let classNodeId: string | null = null
      const classDecorators = getDecorators(statement)
      const controllerDecorator = classDecorators.map(decoratorCallInfo).find((decorator): decorator is NestDecoratorCall => Boolean(decorator && bindings.controller.has(decorator.name))) ?? null
      const moduleDecorator = classDecorators.map(decoratorCallInfo).find((decorator): decorator is NestDecoratorCall => Boolean(decorator && bindings.module.has(decorator.name))) ?? null

      if (classReference.frameworkRole) {
        classNodeId = addNestNode(context, nodes, seenIds, classReference)
      }

      if (moduleDecorator) {
        classNodeId ??= addNestNode(context, nodes, seenIds, { ...classReference, frameworkRole: 'nest_module' }, 'nest_module')
        const controllers = moduleMetadataProperty(moduleDecorator, 'controllers')
        const providers = moduleMetadataProperty(moduleDecorator, 'providers')

        for (const expression of controllers?.elements.filter(ts.isExpression) ?? []) {
          const reference = localOrImportedReference(expression, localBindings, importedBindings)
          if (!reference) {
            continue
          }
          const targetId = addNestNode(context, nodes, seenIds, { ...reference, frameworkRole: reference.frameworkRole ?? 'nest_controller' }, 'nest_controller')
          addUniqueEdge(edges, seenEdges, createEdge(classNodeId, targetId, 'declares_controller', context.filePath, lineOf(expression, sourceFile)))
        }

        for (const expression of providers?.elements.filter(ts.isExpression) ?? []) {
          const reference = localOrImportedReference(expression, localBindings, importedBindings)
          if (!reference) {
            continue
          }
          const role = reference.frameworkRole && reference.frameworkRole !== 'nest_controller' && reference.frameworkRole !== 'nest_module'
            ? reference.frameworkRole
            : 'nest_provider'
          const targetId = addNestNode(context, nodes, seenIds, { ...reference, frameworkRole: role }, role)
          addUniqueEdge(edges, seenEdges, createEdge(classNodeId, targetId, 'provides', context.filePath, lineOf(expression, sourceFile)))
        }
      }

      if (!controllerDecorator) {
        continue
      }

      classNodeId ??= addNestNode(context, nodes, seenIds, { ...classReference, frameworkRole: 'nest_controller' }, 'nest_controller')
      const controllerPrefix = stringLiteralValue(controllerDecorator.args[0]) ?? ''
      const classGuardRefs = collectUseTargets(classDecorators, bindings.useGuards, localBindings, importedBindings)
      const classInterceptorRefs = collectUseTargets(classDecorators, bindings.useInterceptors, localBindings, importedBindings)
      const classPipeRefs = collectUseTargets(classDecorators, bindings.usePipes, localBindings, importedBindings)

      for (const member of statement.members) {
        if (!ts.isConstructorDeclaration(member)) {
          continue
        }
        for (const parameter of member.parameters) {
          const typeNode = parameter.type
          if (!typeNode || !ts.isTypeReferenceNode(typeNode)) {
            continue
          }
          const reference = localOrImportedReference(typeNode.typeName, localBindings, importedBindings)
          if (!reference) {
            continue
          }
          const targetId = addNestNode(context, nodes, seenIds, { ...reference, frameworkRole: reference.frameworkRole ?? 'nest_provider' }, reference.frameworkRole ?? 'nest_provider')
          addUniqueEdge(edges, seenEdges, createEdge(classNodeId, targetId, 'injects', context.filePath, lineOf(parameter, sourceFile)))
        }
      }

      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || !member.name) {
          continue
        }

        const routeDecorator = routeDecoratorMethod(getDecorators(member), bindings)
        if (!routeDecorator) {
          continue
        }

        const routePath = normalizedRoutePath(controllerPrefix, routeDecorator.path)
        const routeLine = lineOf(member.name, sourceFile)
        const routeId = routeNodeId(context.filePath, className, routeDecorator.method, routePath, routeLine)
        addNode(nodes, seenIds, {
          ...createNode(routeId, `${routeDecorator.method} ${routePath}`, context.filePath, routeLine),
          node_kind: 'route',
          route_path: routePath,
          framework: 'nestjs',
          framework_role: 'nest_route',
        })
        addUniqueEdge(edges, seenEdges, createEdge(classNodeId, routeId, 'handles_route', context.filePath, routeLine))
        addUniqueEdge(edges, seenEdges, createEdge(routeId, classNodeId, 'depends_on', context.filePath, routeLine))

        const guardRefs = [...classGuardRefs, ...collectUseTargets(getDecorators(member), bindings.useGuards, localBindings, importedBindings)]
        const interceptorRefs = [...classInterceptorRefs, ...collectUseTargets(getDecorators(member), bindings.useInterceptors, localBindings, importedBindings)]
        const pipeRefs = [...classPipeRefs, ...collectUseTargets(getDecorators(member), bindings.usePipes, localBindings, importedBindings)]

        for (const reference of guardRefs) {
          const targetId = addNestNode(context, nodes, seenIds, { ...reference, frameworkRole: 'nest_guard' }, 'nest_guard')
          addUniqueEdge(edges, seenEdges, createEdge(routeId, targetId, 'uses_guard', context.filePath, routeLine))
        }
        for (const reference of interceptorRefs) {
          const targetId = addNestNode(context, nodes, seenIds, { ...reference, frameworkRole: 'nest_interceptor' }, 'nest_interceptor')
          addUniqueEdge(edges, seenEdges, createEdge(routeId, targetId, 'uses_interceptor', context.filePath, routeLine))
        }
        for (const reference of pipeRefs) {
          const targetId = addNestNode(context, nodes, seenIds, { ...reference, frameworkRole: 'nest_pipe' }, 'nest_pipe')
          addUniqueEdge(edges, seenEdges, createEdge(routeId, targetId, 'uses_pipe', context.filePath, routeLine))
        }
      }
    }

    emitBullEnqueueEdges(context, edges, seenEdges)

    return { nodes, edges }
  },
}
function moduleStem(filePath: string): string {
  return fileStemForPath(filePath)
}
