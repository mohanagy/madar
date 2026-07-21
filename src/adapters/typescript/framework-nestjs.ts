
import { createHash } from 'node:crypto'
import ts from 'typescript'

import type {
  IndexDiagnostic,
  IndexEdge,
  IndexEdgeConfidence,
  IndexFrameworkRole,
  IndexRange,
  IndexSymbol,
  IndexSymbolKind,
} from '../../domain/index/model.js'

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

const DYNAMIC_MODULE_FACTORY_METHODS: ReadonlySet<string> = new Set([
  'forRoot',
  'forRootAsync',
  'forFeature',
  'forFeatureAsync',
  'register',
  'registerAsync',
])

const BULL_CLASS_DECORATOR_NAMES: ReadonlySet<string> = new Set([
  'Processor',
])

const BULL_METHOD_DECORATOR_NAMES: ReadonlySet<string> = new Set([
  'Process',
])

type NestBindings = {
  module: Set<string>
  controller: Set<string>
  injectable: Set<string>
  routeDecorators: Set<string>
  useGuards: Set<string>
  useInterceptors: Set<string>
  usePipes: Set<string>
  inject: Set<string>
}

export type NestTokenBinding = {
  classSymbolId: string
  confidence: IndexEdgeConfidence
}
export type NestTokenMap = Map<string, NestTokenBinding>

export type DetectNestFrameworkContext = {
  program: ts.Program
  sourceFile: ts.SourceFile
  fileId: string
  symbolsByFile: Map<string, IndexSymbol[]>
  edges: IndexEdge[]
  diagnostics: IndexDiagnostic[]
  pathToFileId: Map<string, string>
  checker: ts.TypeChecker
  tokenMap: NestTokenMap
  workerIndex: BullWorkerIndex
}

export type BullWorkerIndex = {
  handlersByKey: Map<string, Set<string>>
  handlersByQueue: Map<string, Set<string>>
}

type BullEnqueueSite = {
  jobNameLiteral: ts.StringLiteralLike
  workerKey: string
}

export type CollectNestTokenMapOptions = {
  sourceFiles: readonly ts.SourceFile[]
  pathToFileId: Map<string, string>
  checker: ts.TypeChecker
}

export function collectNestTokenMap(opts: CollectNestTokenMapOptions): NestTokenMap {
  const tokens: NestTokenMap = new Map()
  for (const sourceFile of opts.sourceFiles) {
    const bindings = collectNestBindings(sourceFile)
    if (bindings.module.size === 0) continue
    for (const stmt of sourceFile.statements) {
      if (!ts.isClassDeclaration(stmt) || !stmt.name) continue
      for (const decorator of decoratorsOf(stmt)) {
        const name = decoratorIdentifierName(decorator)
        if (!name || !bindings.module.has(name)) continue
        registerProviderTokens(decorator, opts, tokens)
      }
    }
  }
  return tokens
}

function registerProviderTokens(
  decorator: ts.Decorator,
  opts: CollectNestTokenMapOptions,
  tokens: NestTokenMap,
): void {
  if (!ts.isCallExpression(decorator.expression)) return
  const arg = decorator.expression.arguments[0]
  if (!arg || !ts.isObjectLiteralExpression(arg)) return
  const providers = providerArrayFor(arg, 'providers')
  if (!providers) return

  for (const element of providers.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue
    const tokenLiteral = stringPropertyValue(element, 'provide')
    if (!tokenLiteral) continue
    const useClass = identifierPropertyValue(element, 'useClass')
    const useExisting = identifierPropertyValue(element, 'useExisting')
    const target = useClass ?? useExisting
    if (!target) continue
    const classId = resolveStaticClassFromIdentifier(target, opts.checker, opts.pathToFileId)
    if (!classId) continue
    tokens.set(tokenLiteral, { classSymbolId: classId, confidence: 'medium' })
  }
}

export function detectNestFramework(ctx: DetectNestFrameworkContext): void {
  const bindings = collectNestBindings(ctx.sourceFile)
  const hasBullEnqueueSites = sourceFileHasBullEnqueueSite(ctx.sourceFile)
  if (!hasAnyBinding(bindings) && !hasBullEnqueueSites) return

  if (hasAnyBinding(bindings)) {
    for (const stmt of ctx.sourceFile.statements) {
      if (!ts.isClassDeclaration(stmt) || !stmt.name) continue

      const classDecorators = decoratorsOf(stmt)
      const decoratorRole = classDecoratorRole(classDecorators, bindings)
      if (decoratorRole.role === null) continue

      const classId = symbolIdFor(ctx.fileId, 'class', stmt.name.text)
      setFrameworkRole(ctx.symbolsByFile, ctx.fileId, classId, decoratorRole.role)

      if (decoratorRole.role === 'nest_module' && decoratorRole.decorator) {
        emitModuleEdges(ctx, classId, decoratorRole.decorator)
        emitConstructorInjects(ctx, classId, stmt, bindings)
      } else if (decoratorRole.role === 'nest_controller') {
        emitClassUseEdges(ctx, classId, classDecorators, bindings)
        emitConstructorInjects(ctx, classId, stmt, bindings)
        emitControllerRoutes(ctx, classId, stmt, bindings)
      } else if (decoratorRole.role === 'nest_provider') {
        emitConstructorInjects(ctx, classId, stmt, bindings)
      }
    }
  }

  if (hasBullEnqueueSites) {
    emitEnqueueJobEdges(ctx)
  }
}

function collectNestBindings(sourceFile: ts.SourceFile): NestBindings {
  const bindings: NestBindings = {
    module: new Set<string>(),
    controller: new Set<string>(),
    injectable: new Set<string>(),
    routeDecorators: new Set<string>(),
    useGuards: new Set<string>(),
    useInterceptors: new Set<string>(),
    usePipes: new Set<string>(),
    inject: new Set<string>(),
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
      else if (importedName === 'UseGuards') bindings.useGuards.add(localName)
      else if (importedName === 'UseInterceptors') bindings.useInterceptors.add(localName)
      else if (importedName === 'UsePipes') bindings.usePipes.add(localName)
      else if (importedName === 'Inject') bindings.inject.add(localName)
      else if (ROUTE_DECORATOR_NAMES.has(importedName)) bindings.routeDecorators.add(localName)
    }
  }
  return bindings
}

function hasAnyBinding(b: NestBindings): boolean {
  return (
    b.module.size > 0 ||
    b.controller.size > 0 ||
    b.injectable.size > 0 ||
    b.routeDecorators.size > 0 ||
    b.useGuards.size > 0 ||
    b.useInterceptors.size > 0 ||
    b.usePipes.size > 0 ||
    b.inject.size > 0
  )
}

function classDecoratorRole(
  decorators: readonly ts.Decorator[],
  bindings: NestBindings,
): { role: IndexFrameworkRole | null; decorator: ts.Decorator | null } {
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
      pushDiagnostic(
        ctx,
        'canonical.nest.module-metadata.non-array',
        'info',
        `NestJS @Module ${key}: non-array initializer cannot be enumerated statically`,
        ctx.sourceFile,
        initializer,
      )
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
  const staticTarget = resolveStaticClassReference(element, ctx)
  if (staticTarget) {
    ctx.edges.push({
      from: moduleClassId,
      to: staticTarget,
      kind: edgeKind,
      confidence: 'high',
      source: 'framework-decorator',
      evidence: { file_id: ctx.fileId, range: rangeOf(element, ctx.sourceFile) },
    })
    return
  }

  const dynamicTarget = resolveDynamicModuleReceiver(element, ctx)
  if (dynamicTarget) {
    ctx.edges.push({
      from: moduleClassId,
      to: dynamicTarget.classSymbolId,
      kind: edgeKind,
      confidence: 'low',
      source: 'framework-decorator',
      evidence: { file_id: ctx.fileId, range: rangeOf(element, ctx.sourceFile) },
    })
    pushDiagnostic(
      ctx,
      'canonical.nest.module-metadata.dynamic',
      'info',
      `NestJS @Module ${edgeKind}: dynamic module shape via .${dynamicTarget.factoryName}() — runtime providers not resolved`,
      ctx.sourceFile,
      element,
    )
    return
  }

  pushDiagnostic(
    ctx,
    'canonical.nest.module-metadata.unresolved',
    'info',
    `NestJS @Module ${edgeKind}: unresolved entry (likely spread, conditional, or computed)`,
    ctx.sourceFile,
    element,
  )
}

function resolveDynamicModuleReceiver(
  expr: ts.Expression,
  ctx: DetectNestFrameworkContext,
): { classSymbolId: string; factoryName: string } | null {
  if (!ts.isCallExpression(expr)) return null
  const callee = expr.expression
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return null
  const factoryName = callee.name.text
  if (!DYNAMIC_MODULE_FACTORY_METHODS.has(factoryName)) return null
  const receiver = callee.expression
  if (!ts.isIdentifier(receiver)) return null
  const id = resolveStaticClassFromIdentifier(receiver, ctx.checker, ctx.pathToFileId)
  if (!id) return null
  return { classSymbolId: id, factoryName }
}

function emitControllerRoutes(
  ctx: DetectNestFrameworkContext,
  controllerClassId: string,
  classDecl: ts.ClassDeclaration,
  bindings: NestBindings,
): void {
  if (!classDecl.name) return
  const className = classDecl.name.text

  for (const member of classDecl.members) {
    if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) {
      continue
    }

    const methodName = member.name.text
    const memberDecorators = decoratorsOf(member)
    const routeDecorator = findRouteDecorator(memberDecorators, bindings)
    if (!routeDecorator) {
      continue
    }

    const methodId = symbolIdFor(ctx.fileId, 'method', `${className}.${methodName}`)

    setFrameworkRole(ctx.symbolsByFile, ctx.fileId, methodId, 'nest_route')

    ctx.edges.push({
      from: controllerClassId,
      to: methodId,
      kind: 'controller_route',
      confidence: 'high',
      source: 'framework-decorator',
      evidence: { file_id: ctx.fileId, range: rangeOf(member.name, ctx.sourceFile) },
    })

    emitMethodUseEdges(ctx, methodId, memberDecorators, bindings)
  }
}

function findRouteDecorator(decorators: readonly ts.Decorator[], bindings: NestBindings): ts.Decorator | null {
  for (const decorator of decorators) {
    const name = decoratorIdentifierName(decorator)
    if (name && bindings.routeDecorators.has(name)) return decorator
  }
  return null
}

function emitClassUseEdges(
  ctx: DetectNestFrameworkContext,
  classId: string,
  decorators: readonly ts.Decorator[],
  bindings: NestBindings,
): void {
  emitUseEdgesFor(ctx, classId, decorators, bindings.useGuards, 'guards')
  emitUseEdgesFor(ctx, classId, decorators, bindings.useInterceptors, 'intercepts')
  emitUseEdgesFor(ctx, classId, decorators, bindings.usePipes, 'pipes')
}

function emitMethodUseEdges(
  ctx: DetectNestFrameworkContext,
  methodId: string,
  decorators: readonly ts.Decorator[],
  bindings: NestBindings,
): void {
  emitUseEdgesFor(ctx, methodId, decorators, bindings.useGuards, 'guards')
  emitUseEdgesFor(ctx, methodId, decorators, bindings.useInterceptors, 'intercepts')
  emitUseEdgesFor(ctx, methodId, decorators, bindings.usePipes, 'pipes')
}

function emitUseEdgesFor(
  ctx: DetectNestFrameworkContext,
  fromId: string,
  decorators: readonly ts.Decorator[],
  bindingNames: ReadonlySet<string>,
  edgeKind: 'guards' | 'intercepts' | 'pipes',
): void {
  if (bindingNames.size === 0) return
  for (const decorator of decorators) {
    const name = decoratorIdentifierName(decorator)
    if (!name || !bindingNames.has(name)) continue
    if (!ts.isCallExpression(decorator.expression)) continue
    for (const arg of decorator.expression.arguments) {
      const targets = flattenUseDecoratorArg(arg)
      for (const target of targets) {
        const targetId = resolveStaticClassReference(target, ctx)
        if (!targetId) {
          pushDiagnostic(
            ctx,
            'canonical.nest.use-decorator.unresolved',
            'info',
            `NestJS @Use* ${edgeKind}: unresolved target (instance literal, computed expression, or untyped)`,
            ctx.sourceFile,
            target,
          )
          continue
        }
        ctx.edges.push({
          from: fromId,
          to: targetId,
          kind: edgeKind,
          confidence: 'high',
          source: 'framework-decorator',
          evidence: { file_id: ctx.fileId, range: rangeOf(target, ctx.sourceFile) },
        })
      }
    }
  }
}

function flattenUseDecoratorArg(arg: ts.Expression): ts.Expression[] {
  if (ts.isArrayLiteralExpression(arg)) {
    const out: ts.Expression[] = []
    for (const element of arg.elements) {
      if (ts.isExpression(element)) {
        out.push(...flattenUseDecoratorArg(element))
      }
    }
    return out
  }
  return [arg]
}

function emitConstructorInjects(
  ctx: DetectNestFrameworkContext,
  classId: string,
  classDecl: ts.ClassDeclaration,
  bindings: NestBindings,
): void {
  const ctor = classDecl.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m))
  if (!ctor) return

  const seen = new Set<string>()
  for (const param of ctor.parameters) {
    const tokenName = injectTokenFromParameter(param, bindings)
    if (tokenName !== null) {
      const binding = ctx.tokenMap.get(tokenName)
      if (!binding) {
        pushDiagnostic(
          ctx,
          'canonical.nest.inject-token.unresolved',
          'info',
          `NestJS @Inject('${tokenName}'): no useClass / useExisting binding found in any module`,
          ctx.sourceFile,
          param,
        )
        continue
      }
      const dedupeKey = `${classId}|${binding.classSymbolId}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      ctx.edges.push({
        from: classId,
        to: binding.classSymbolId,
        kind: 'injects',
        confidence: binding.confidence,
        source: 'framework-decorator',
        evidence: { file_id: ctx.fileId, range: rangeOf(param, ctx.sourceFile) },
      })
      continue
    }

    if (!param.type) continue
    const targetId = resolveTypeNodeToClass(param.type, ctx)
    if (!targetId) continue
    if (targetId === classId) continue // self-reference — skip
    const dedupeKey = `${classId}|${targetId}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    ctx.edges.push({
      from: classId,
      to: targetId,
      kind: 'injects',
      confidence: 'high',
      source: 'framework-decorator',
      evidence: { file_id: ctx.fileId, range: rangeOf(param, ctx.sourceFile) },
    })
  }
}

function emitEnqueueJobEdges(ctx: DetectNestFrameworkContext): void {
  const workerIndex = ctx.workerIndex
  if (workerIndex.handlersByKey.size === 0 && workerIndex.handlersByQueue.size === 0) return

  const emitted = new Set<string>()

  for (const stmt of ctx.sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const functionId = symbolIdFor(ctx.fileId, 'function', stmt.name.text)
      emitEnqueueEdgesInCallable(ctx, workerIndex, functionId, stmt.body, emitted)
      continue
    }

    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue

    const className = stmt.name.text
    for (const member of stmt.members) {
      if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) {
        continue
      }

      const methodName = member.name.text
      const methodId = symbolIdFor(ctx.fileId, 'method', `${className}.${methodName}`)
      emitEnqueueEdgesInCallable(ctx, workerIndex, methodId, member.body, emitted)
    }
  }
}

function emitEnqueueEdgesInCallable(
  ctx: DetectNestFrameworkContext,
  workerIndex: BullWorkerIndex,
  callerId: string,
  body: ts.Block | ts.ConciseBody | undefined,
  emitted: Set<string>,
): void {
  if (!body || !symbolExists(ctx.symbolsByFile, ctx.fileId, callerId)) return

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const enqueueSite = resolveBullEnqueueSite(node, ctx)
      if (enqueueSite) {
        const targetId = uniqueBullWorkerTarget(workerIndex, enqueueSite.workerKey)
        if (targetId && targetId !== callerId) {
          const edgeKey = `${callerId}|${targetId}|${enqueueSite.workerKey}`
          if (!emitted.has(edgeKey)) {
            emitted.add(edgeKey)
            ctx.edges.push({
              from: callerId,
              to: targetId,
              kind: 'enqueues_job',
              confidence: 'high',
              source: 'heuristic',
              evidence: { file_id: ctx.fileId, range: rangeOf(enqueueSite.jobNameLiteral, ctx.sourceFile) },
            })
          }
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(body)
}

function sourceFileHasBullEnqueueSite(sourceFile: ts.SourceFile): boolean {
  let found = false

  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node) && bullEnqueueJobNameLiteral(node)) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return found
}

export function collectBullWorkerIndex(program: ts.Program, pathToFileId: Map<string, string>): BullWorkerIndex {
  const handlersByKey = new Map<string, Set<string>>()
  const handlersByQueue = new Map<string, Set<string>>()

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue
    const fileId = pathToFileId.get(sourceFile.fileName)
    if (!fileId) continue

    for (const stmt of sourceFile.statements) {
      if (!ts.isClassDeclaration(stmt) || !stmt.name) continue

      const queueName = bullProcessorQueueName(stmt)
      if (!queueName) continue

      const className = stmt.name.text
      for (const member of stmt.members) {
        if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) {
          continue
        }

        const methodName = member.name.text
        const jobName = bullProcessJobName(member)
        const methodId = symbolIdFor(fileId, 'method', `${className}.${methodName}`)
        if (jobName) {
          addBullWorkerTarget(handlersByKey, bullWorkerKey(queueName, jobName), methodId)
        }
        if (isBullWorkerHostProcessMethod(stmt, member)) {
          addBullWorkerTarget(handlersByQueue, queueName, methodId)
        }
      }
    }
  }

  return { handlersByKey, handlersByQueue }
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
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue
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

function bullProcessorQueueName(classDecl: ts.ClassDeclaration): string | null {
  for (const decorator of decoratorsOf(classDecl)) {
    const decoratorName = decoratorIdentifierName(decorator)
    if (!decoratorName || !BULL_CLASS_DECORATOR_NAMES.has(decoratorName)) continue
    if (!ts.isCallExpression(decorator.expression)) continue
    const arg = decorator.expression.arguments[0]
    if (!arg) continue
    if (ts.isStringLiteralLike(arg)) return arg.text
  }

  return null
}

function bullProcessJobName(methodDecl: ts.MethodDeclaration): string | null {
  for (const decorator of decoratorsOf(methodDecl)) {
    const decoratorName = decoratorIdentifierName(decorator)
    if (!decoratorName || !BULL_METHOD_DECORATOR_NAMES.has(decoratorName)) continue
    if (!ts.isCallExpression(decorator.expression)) continue
    const arg = decorator.expression.arguments[0]
    if (!arg) continue
    if (ts.isStringLiteralLike(arg)) return arg.text
  }

  return null
}

function bullEnqueueJobNameLiteral(callExpr: ts.CallExpression): ts.StringLiteralLike | null {
  const callee = callExpr.expression
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'add') return null
  const arg = callExpr.arguments[0]
  if (!arg) return null
  return ts.isStringLiteralLike(arg) ? arg : null
}

function resolveBullEnqueueSite(
  callExpr: ts.CallExpression,
  ctx: DetectNestFrameworkContext,
): BullEnqueueSite | null {
  const jobNameLiteral = bullEnqueueJobNameLiteral(callExpr)
  if (!jobNameLiteral) return null

  const callee = callExpr.expression
  if (!ts.isPropertyAccessExpression(callee)) return null
  if (!bullReceiverLooksLikeQueue(callee.expression, ctx.checker)) return null

  const workerKey = bullQualifiedJobKey(jobNameLiteral.text)
  if (!workerKey) return null

  return { jobNameLiteral, workerKey }
}

function bullWorkerKey(queueName: string, jobName: string): string {
  if (jobName.startsWith(`${queueName}.`)) {
    return jobName
  }

  return `${queueName}.${jobName}`
}

function bullQualifiedJobKey(jobName: string): string | null {
  if (!jobName.includes('.')) return null
  const segments = jobName.split('.')
  if (segments.some((segment) => segment.length === 0)) return null
  return jobName
}

function uniqueBullWorkerTarget(workerIndex: BullWorkerIndex, key: string): string | null {
  const targets = workerIndex.handlersByKey.get(key)
  if (targets?.size === 1) return [...targets][0] ?? null

  const queueTargets = new Set<string>()
  for (const [queueName, queueHandlers] of workerIndex.handlersByQueue) {
    if (key !== queueName && !key.startsWith(`${queueName}.`)) {
      continue
    }
    for (const target of queueHandlers) {
      queueTargets.add(target)
    }
  }

  if (queueTargets.size !== 1) return null
  return [...queueTargets][0] ?? null
}

function bullReceiverLooksLikeQueue(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  return bullQueueNameCandidates(expr, checker).some(looksLikeQueueCandidate)
}

function bullQueueNameCandidates(expr: ts.Expression, checker: ts.TypeChecker): string[] {
  const candidates = new Set<string>()
  const addCandidate = (value: string | null | undefined): void => {
    if (value && value.length > 0) candidates.add(value)
  }

  addCandidate(expressionNameText(expr))

  const type = checker.getTypeAtLocation(expr)
  addCandidate(type.symbol?.getName())
  addCandidate(type.aliasSymbol?.getName())

  const typeText = checker.typeToString(type)
  if (typeText && !typeText.startsWith('{')) {
    addCandidate(typeText)
  }

  const symbol = checker.getSymbolAtLocation(queueReceiverSymbolNode(expr))
  if (!symbol) return [...candidates]

  addCandidate(symbol.getName())
  for (const declaration of symbol.declarations ?? []) {
    addCandidate(declarationNameText(declaration))
    if (
      (ts.isPropertyDeclaration(declaration)
        || ts.isPropertySignature(declaration)
        || ts.isParameter(declaration)
        || ts.isVariableDeclaration(declaration))
      && declaration.type
    ) {
      addCandidate(checker.typeToString(checker.getTypeFromTypeNode(declaration.type)))
    }
    if (
      (ts.isPropertyDeclaration(declaration) || ts.isVariableDeclaration(declaration))
      && declaration.initializer
      && ts.isNewExpression(declaration.initializer)
    ) {
      addCandidate(expressionNameText(declaration.initializer.expression))
    }
  }

  return [...candidates]
}

function looksLikeQueueCandidate(candidate: string): boolean {
  const trimmed = candidate.trim()
  if (!trimmed) return false

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

function queueReceiverSymbolNode(expr: ts.Expression): ts.Node {
  if (ts.isPropertyAccessExpression(expr)) return expr.name
  if (ts.isElementAccessExpression(expr)) return expr.argumentExpression ?? expr.expression
  return expr
}

function expressionNameText(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return 'this'
  if (ts.isParenthesizedExpression(expr)) return expressionNameText(expr.expression)
  if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr)) {
    return expressionNameText(expr.expression)
  }
  if (ts.isNewExpression(expr)) return expressionNameText(expr.expression)
  if (ts.isCallExpression(expr)) return expressionNameText(expr.expression)
  return null
}

function declarationNameText(node: ts.Node): string | null {
  const namedNode = node as ts.Node & { name?: ts.DeclarationName }
  const name = namedNode.name
  if (!name) return null
  if (ts.isIdentifier(name)) return name.text
  if (ts.isStringLiteralLike(name)) return name.text
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text
  }
  return null
}

function injectTokenFromParameter(param: ts.ParameterDeclaration, bindings: NestBindings): string | null {
  if (bindings.inject.size === 0) return null
  for (const decorator of decoratorsOf(param)) {
    const name = decoratorIdentifierName(decorator)
    if (!name || !bindings.inject.has(name)) continue
    if (!ts.isCallExpression(decorator.expression)) continue
    const arg = decorator.expression.arguments[0]
    if (!arg) continue
    if (ts.isStringLiteralLike(arg)) return arg.text
  }
  return null
}

function resolveTypeNodeToClass(typeNode: ts.TypeNode, ctx: DetectNestFrameworkContext): string | null {
  if (!ts.isTypeReferenceNode(typeNode)) return null
  let target: ts.Identifier | null = null
  if (ts.isIdentifier(typeNode.typeName)) target = typeNode.typeName
  else if (ts.isQualifiedName(typeNode.typeName)) target = typeNode.typeName.right
  if (!target) return null
  return resolveStaticClassFromIdentifier(target, ctx.checker, ctx.pathToFileId)
}

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
  return resolveStaticClassFromIdentifier(target, ctx.checker, ctx.pathToFileId)
}

function resolveStaticClassFromIdentifier(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
  pathToFileId: Map<string, string>,
): string | null {
  const symbol = followAlias(checker.getSymbolAtLocation(identifier), checker)
  const decl = symbol?.declarations?.[0]
  if (!decl) return null
  if (!ts.isClassDeclaration(decl) || !decl.name) return null
  const declSourceFile = decl.getSourceFile()
  if (declSourceFile.isDeclarationFile) return null
  const targetFileId = pathToFileId.get(declSourceFile.fileName)
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
  symbolsByFile: Map<string, IndexSymbol[]>,
  fileId: string,
  symbolId: string,
  role: IndexFrameworkRole,
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

function symbolExists(
  symbolsByFile: Map<string, IndexSymbol[]>,
  fileId: string,
  symbolId: string,
): boolean {
  const symbols = symbolsByFile.get(fileId)
  return symbols?.some((symbol) => symbol.id === symbolId) === true
}

function symbolIdFor(fileId: string, kind: IndexSymbolKind, name: string): string {
  return `symbol:${fileId}/${kind}/${name}`
}

function propertyKeyText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return null
}

function providerArrayFor(
  metadataObject: ts.ObjectLiteralExpression,
  key: string,
): ts.ArrayLiteralExpression | null {
  for (const property of metadataObject.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    if (propertyKeyText(property.name) !== key) continue
    return ts.isArrayLiteralExpression(property.initializer) ? property.initializer : null
  }
  return null
}

function stringPropertyValue(obj: ts.ObjectLiteralExpression, key: string): string | null {
  for (const property of obj.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    if (propertyKeyText(property.name) !== key) continue
    if (ts.isStringLiteralLike(property.initializer)) return property.initializer.text
    return null
  }
  return null
}

function identifierPropertyValue(obj: ts.ObjectLiteralExpression, key: string): ts.Identifier | null {
  for (const property of obj.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    if (propertyKeyText(property.name) !== key) continue
    return ts.isIdentifier(property.initializer) ? property.initializer : null
  }
  return null
}

function rangeOf(node: ts.Node, sourceFile: ts.SourceFile): IndexRange {
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
  level: IndexDiagnostic['level'],
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
