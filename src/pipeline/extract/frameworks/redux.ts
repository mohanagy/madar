import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import * as ts from 'typescript'

import type { ExtractionNode } from '../../../contracts/types.js'
import { addNode, addUniqueEdge, createEdge, createNode, _makeId } from '../core.js'
import { unparenthesizeExpression } from '../typescript-utils.js'
import { resolveImportPath, scriptKindForPath } from './js-import-paths.js'
import type { JsFrameworkAdapter, JsFrameworkContext } from './types.js'

const REDUX_MATCH_PATTERN = /@reduxjs\/toolkit|\bcreateSlice\b|\bconfigureStore\b|\bcreateAsyncThunk\b|\bcreateAction\b/
const REDUX_TOOLKIT_MODULE_SPECIFIERS = new Set(['@reduxjs/toolkit'])

interface SliceRecord {
  nodeId: string
  label: string
  sourceFile: string
  line: number
  memberLines: Map<string, number>
}

interface NamedReferenceOptions {
  nodeKind: NonNullable<ExtractionNode['node_kind']>
  frameworkRole: string
  fallbackSuffix: string
}

interface ReduxReference {
  id: string
  label: string
  sourceFile: string
  line: number
  nodeKind: NonNullable<ExtractionNode['node_kind']>
  frameworkRole: string
  kind: 'slice' | 'thunk' | 'action' | 'selector'
  memberLines?: ReadonlyMap<string, number>
}

interface ReduxModuleAnalysis {
  exports: Map<string, ReduxReference>
}

interface InitializerBinding {
  expression: ts.Expression
  scope: ts.Node
  pos: number
}

interface ReduxToolkitImportBindings {
  createSlice: Set<string>
  configureStore: Set<string>
  createAsyncThunk: Set<string>
  createAction: Set<string>
  namespaces: Set<string>
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text
  }

  return null
}

function findBaseNode(context: JsFrameworkContext, name: string) {
  const candidates = new Set([name, `${name}()`, `.${name}()`])
  return context.baseExtraction.nodes?.find((node) => candidates.has(node.label)) ?? null
}

function addNamedNode(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  seenIds: Set<string>,
  name: string,
  line: number,
  options: NamedReferenceOptions,
): string {
  const baseNode = findBaseNode(context, name)
  const id = baseNode?.id ?? _makeId(context.filePath, name, options.fallbackSuffix)
  addNode(nodes, seenIds, {
    ...(baseNode ?? createNode(id, name, context.filePath, line)),
    id,
    node_kind: options.nodeKind,
    framework: 'redux-toolkit',
    framework_role: options.frameworkRole,
  })
  return id
}

function addReduxReferenceNode(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  seenIds: Set<string>,
  reference: ReduxReference,
): string {
  const baseNode = reference.sourceFile === context.filePath ? findBaseNode(context, reference.label) ?? findBaseNode(context, reference.label.replace(/\(\)$/, '')) : null
  const id = baseNode?.id ?? reference.id
  addNode(nodes, seenIds, {
    ...(baseNode ?? createNode(id, reference.label, reference.sourceFile, reference.line)),
    id,
    node_kind: reference.nodeKind,
    framework: 'redux-toolkit',
    framework_role: reference.frameworkRole,
  })
  return id
}

function stringPropertyValue(node: ts.ObjectLiteralExpression, propertyName: string): string | null {
  for (const property of node.properties) {
    if (
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      propertyNameText(property.name) === propertyName
    ) {
      const initializer = ts.isShorthandPropertyAssignment(property)
        ? property.name
        : unparenthesizeExpression(property.initializer)
      if (ts.isStringLiteralLike(initializer)) {
        return initializer.text
      }
    }
  }

  return null
}

function objectProperty(node: ts.ObjectLiteralExpression, propertyName: string): ts.ObjectLiteralElementLike | null {
  for (const property of node.properties) {
    if (
      (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property) || ts.isShorthandPropertyAssignment(property)) &&
      propertyNameText(property.name) === propertyName
    ) {
      return property
    }
  }

  return null
}
function sliceMemberLines(options: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile): Map<string, number> {
  const lines = new Map<string, number>()
  for (const [propertyName, role] of [['reducers', 'redux_action'], ['selectors', 'redux_selector']] as const) {
    const property = objectProperty(options, propertyName)
    if (!property || !ts.isPropertyAssignment(property)) continue
    const members = unparenthesizeExpression(property.initializer)
    if (!ts.isObjectLiteralExpression(members)) continue
    for (const member of members.properties) {
      const name = 'name' in member && member.name ? propertyNameText(member.name) : null
      if (name) lines.set(`${role}:${name}`, lineOf(member, sourceFile))
    }
  }
  return lines
}

function sliceReference(record: SliceRecord): ReduxReference {
  return {
    id: record.nodeId,
    label: record.label,
    sourceFile: record.sourceFile,
    line: record.line,
    nodeKind: 'slice',
    frameworkRole: 'redux_slice',
    kind: 'slice',
    memberLines: record.memberLines,
  }
}

function actionReference(filePath: string, name: string, line: number, frameworkRole: ReduxReference['frameworkRole']): ReduxReference {
  return {
    id: _makeId(filePath, name, frameworkRole === 'redux_thunk' ? 'thunk' : 'action'),
    label: name,
    sourceFile: filePath,
    line,
    nodeKind: 'function',
    frameworkRole,
    kind: frameworkRole === 'redux_thunk' ? 'thunk' : 'action',
  }
}

function selectorReference(filePath: string, name: string, line: number): ReduxReference {
  return {
    id: _makeId(filePath, name, 'redux_selector'),
    label: name,
    sourceFile: filePath,
    line,
    nodeKind: 'function',
    frameworkRole: 'redux_selector',
    kind: 'selector',
  }
}

function exportedSliceMemberReference(
  filePath: string,
  name: string,
  line: number,
  frameworkRole: 'redux_action' | 'redux_selector',
  aliased: boolean,
): ReduxReference {
  const suffix = aliased ? (frameworkRole === 'redux_action' ? 'action' : 'selector') : frameworkRole
  return frameworkRole === 'redux_selector'
    ? {
        ...selectorReference(filePath, name, line),
        id: _makeId(filePath, name, suffix),
      }
    : {
        ...actionReference(filePath, name, line, 'redux_action'),
        id: _makeId(filePath, name, suffix),
      }
}

function sliceActionReference(
  context: JsFrameworkContext,
  slice: ReduxReference,
  actionName: string,
): ReduxReference {
  const baseNode = slice.sourceFile === context.filePath ? findBaseNode(context, actionName) : null
  return {
    id: baseNode?.id ?? _makeId(slice.sourceFile, actionName, 'redux_action'),
    label: actionName,
    sourceFile: slice.sourceFile,
    line: slice.memberLines?.get(`redux_action:${actionName}`) ?? slice.line,
    nodeKind: 'function',
    frameworkRole: 'redux_action',
    kind: 'action',
  }
}

function createReduxToolkitImportBindings(): ReduxToolkitImportBindings {
  return {
    createSlice: new Set<string>(),
    configureStore: new Set<string>(),
    createAsyncThunk: new Set<string>(),
    createAction: new Set<string>(),
    namespaces: new Set<string>(),
  }
}

function collectReduxToolkitImportBindings(sourceFile: ts.SourceFile): ReduxToolkitImportBindings {
  const bindings = createReduxToolkitImportBindings()

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue
    }

    if (!REDUX_TOOLKIT_MODULE_SPECIFIERS.has(statement.moduleSpecifier.text)) {
      continue
    }

    const namedBindings = statement.importClause.namedBindings
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      bindings.namespaces.add(namedBindings.name.text)
      continue
    }

    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text
        const localName = element.name.text
        if (importedName === 'createSlice') {
          bindings.createSlice.add(localName)
        } else if (importedName === 'configureStore') {
          bindings.configureStore.add(localName)
        } else if (importedName === 'createAsyncThunk') {
          bindings.createAsyncThunk.add(localName)
        } else if (importedName === 'createAction') {
          bindings.createAction.add(localName)
        }
      }
    }
  }

  return bindings
}

function isReduxToolkitBindingCall(
  expression: ts.Expression,
  bindings: ReduxToolkitImportBindings,
  localBindings: ReadonlySet<string>,
  memberName: 'createSlice' | 'configureStore' | 'createAsyncThunk' | 'createAction',
): boolean {
  const candidate = unparenthesizeExpression(expression)
  if (ts.isIdentifier(candidate)) {
    return localBindings.has(candidate.text)
  }

  return (
    ts.isPropertyAccessExpression(candidate) &&
    ts.isIdentifier(candidate.expression) &&
    bindings.namespaces.has(candidate.expression.text) &&
    candidate.name.text === memberName
  )
}

function isCreateCall(
  initializer: ts.Expression,
  bindings: ReduxToolkitImportBindings,
  localBindings: ReadonlySet<string>,
  calleeName: 'createSlice' | 'createAsyncThunk' | 'createAction',
): boolean {
  const candidate = unparenthesizeExpression(initializer)
  const callee = ts.isCallExpression(candidate) ? unparenthesizeExpression(candidate.expression) : null
  return ts.isCallExpression(candidate) && !!callee && isReduxToolkitBindingCall(callee, bindings, localBindings, calleeName)
}

function analyzeReduxModule(filePath: string, cache: Map<string, ReduxModuleAnalysis>): ReduxModuleAnalysis {
  const resolvedFilePath = resolve(filePath)
  const cached = cache.get(resolvedFilePath)
  if (cached) {
    return cached
  }

  const analysis: ReduxModuleAnalysis = {
    exports: new Map<string, ReduxReference>(),
  }
  cache.set(resolvedFilePath, analysis)

  let sourceText: string
  try {
    sourceText = readFileSync(resolvedFilePath, 'utf8')
  } catch {
    return analysis
  }

  const sourceFile = ts.createSourceFile(resolvedFilePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(resolvedFilePath))
  const toolkitBindings = collectReduxToolkitImportBindings(sourceFile)
  const importedBindings = new Map<string, ReduxReference>()
  const slicesByBinding = new Map<string, SliceRecord>()
  const thunkBindings = new Map<string, ReduxReference>()
  const actionBindings = new Map<string, ReduxReference>()
  const selectorBindings = new Map<string, ReduxReference>()
  const aliases = new Map<string, ReduxReference>()

  const lookupBinding = (name: string): ReduxReference | null =>
    thunkBindings.get(name)
    ?? actionBindings.get(name)
    ?? selectorBindings.get(name)
    ?? aliases.get(name)
    ?? (slicesByBinding.get(name) ? sliceReference(slicesByBinding.get(name)!) : null)
    ?? importedBindings.get(name)
    ?? null

  const resolveSliceMemberBinding = (initializer: ts.Expression): ReduxReference | null => {
    const candidate = unparenthesizeExpression(initializer)
    if (!ts.isPropertyAccessExpression(candidate) || !ts.isIdentifier(candidate.expression)) {
      return null
    }

    const sliceBinding = lookupBinding(candidate.expression.text)
    if (sliceBinding?.kind !== 'slice') {
      return null
    }

    if (candidate.name.text === 'actions') {
      return {
        ...actionReference(sliceBinding.sourceFile, '__placeholder__', sliceBinding.line, 'redux_action'),
        id: '',
        label: '',
        ...(sliceBinding.memberLines ? { memberLines: sliceBinding.memberLines } : {}),
      }
    }

    if (candidate.name.text === 'selectors') {
      return {
        ...selectorReference(sliceBinding.sourceFile, '__placeholder__', sliceBinding.line),
        id: '',
        label: '',
        ...(sliceBinding.memberLines ? { memberLines: sliceBinding.memberLines } : {}),
      }
    }

    return null
  }

  const resolveBindingReference = (expression: ts.Expression | undefined): ReduxReference | null => {
    if (!expression) {
      return null
    }

    const candidate = unparenthesizeExpression(expression)
    if (ts.isIdentifier(candidate)) {
      return lookupBinding(candidate.text)
    }

    if (
      ts.isPropertyAccessExpression(candidate) &&
      candidate.name.text === 'reducer' &&
      ts.isIdentifier(candidate.expression)
    ) {
      const target = lookupBinding(candidate.expression.text)
      return target?.kind === 'slice' ? target : null
    }

    return null
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue
    }

    const targetFilePath = resolveImportPath(resolvedFilePath, statement.moduleSpecifier.text)
    if (!targetFilePath) {
      continue
    }

    const exportedBindings = analyzeReduxModule(targetFilePath, cache).exports
    if (statement.importClause.name) {
      const defaultBinding = exportedBindings.get('default')
      if (defaultBinding) {
        importedBindings.set(statement.importClause.name.text, defaultBinding)
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

  for (const statement of sourceFile.statements) {
    const exported = (ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined)?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false

    if (!ts.isVariableStatement(statement)) {
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        const binding = resolveBindingReference(statement.expression)
        if (binding) {
          analysis.exports.set('default', binding)
        }
      }

      if (ts.isExportDeclaration(statement)) {
        const targetFilePath =
          statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
            ? resolveImportPath(resolvedFilePath, statement.moduleSpecifier.text)
            : null
        const targetExports = targetFilePath ? analyzeReduxModule(targetFilePath, cache).exports : null

        if (!statement.exportClause && targetExports) {
          for (const [exportName, binding] of targetExports) {
            if (exportName !== 'default' && !analysis.exports.has(exportName)) {
              analysis.exports.set(exportName, binding)
            }
          }
        } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            const exportName = element.name.text
            const localName = element.propertyName?.text ?? element.name.text
            const binding = targetExports?.get(localName) ?? lookupBinding(localName)
            if (binding) {
              analysis.exports.set(exportName, binding)
            }
          }
        }
      }
      continue
    }

    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer) {
        continue
      }

      const initializer = unparenthesizeExpression(declaration.initializer)
      if (ts.isObjectBindingPattern(declaration.name)) {
        const sliceMemberBinding = resolveSliceMemberBinding(initializer)
        if (sliceMemberBinding) {
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name)) {
              continue
            }

            const bindingName = element.name.text
            const aliased = !!element.propertyName
            const bindingLine = !aliased
              ? sliceMemberBinding.memberLines?.get(`${sliceMemberBinding.frameworkRole}:${bindingName}`) ?? lineOf(element.name, sourceFile)
              : lineOf(element.name, sourceFile)
            const binding = exportedSliceMemberReference(
              sliceMemberBinding.sourceFile,
              bindingName,
              bindingLine,
              sliceMemberBinding.frameworkRole as 'redux_action' | 'redux_selector',
              aliased,
            )

            if (binding.frameworkRole === 'redux_selector') {
              selectorBindings.set(bindingName, binding)
            } else {
              actionBindings.set(bindingName, binding)
            }

            if (exported) {
              analysis.exports.set(bindingName, binding)
            }
          }
        }
        continue
      }

      if (!ts.isIdentifier(declaration.name)) {
        continue
      }

      const bindingName = declaration.name.text
      const bindingLine = lineOf(declaration.name, sourceFile)

      if (isCreateCall(initializer, toolkitBindings, toolkitBindings.createSlice, 'createSlice')) {
        const options = ts.isCallExpression(initializer) ? initializer.arguments[0] : null
        const sliceOptions = options ? unparenthesizeExpression(options) : null
        const sliceName = sliceOptions && ts.isObjectLiteralExpression(sliceOptions)
          ? stringPropertyValue(sliceOptions, 'name') ?? bindingName
          : bindingName
        slicesByBinding.set(bindingName, {
          nodeId: _makeId(resolvedFilePath, sliceName, 'slice'),
          label: `${sliceName} slice`,
          sourceFile: resolvedFilePath,
          line: bindingLine,
          memberLines: sliceOptions && ts.isObjectLiteralExpression(sliceOptions)
            ? sliceMemberLines(sliceOptions, sourceFile) : new Map(),
        })
      } else if (isCreateCall(initializer, toolkitBindings, toolkitBindings.createAsyncThunk, 'createAsyncThunk')) {
        thunkBindings.set(bindingName, actionReference(resolvedFilePath, bindingName, bindingLine, 'redux_thunk'))
      } else if (isCreateCall(initializer, toolkitBindings, toolkitBindings.createAction, 'createAction')) {
        actionBindings.set(bindingName, actionReference(resolvedFilePath, bindingName, bindingLine, 'redux_action'))
      } else {
        const aliasTarget = resolveBindingReference(initializer)
        if (aliasTarget) {
          aliases.set(bindingName, aliasTarget)
        }
      }

      if (!exported) {
        continue
      }

      const exportedBinding = lookupBinding(bindingName)
      if (exportedBinding) {
        analysis.exports.set(bindingName, exportedBinding)
      }
    }
  }

  return analysis
}

export function inspectReduxModuleExports(filePath: string): ReadonlyMap<string, ReduxReference> {
  return analyzeReduxModule(filePath, new Map<string, ReduxModuleAnalysis>()).exports
}

function collectImportedReduxBindings(
  filePath: string,
  sourceFile: ts.SourceFile,
  cache: Map<string, ReduxModuleAnalysis>,
): Map<string, ReduxReference> {
  const importedBindings = new Map<string, ReduxReference>()

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const targetFilePath = resolveImportPath(filePath, node.moduleSpecifier.text)
      const exportedBindings = targetFilePath ? analyzeReduxModule(targetFilePath, cache).exports : null
      if (!exportedBindings) {
        ts.forEachChild(node, visit)
        return
      }

      if (node.importClause.name) {
        const binding = exportedBindings.get('default')
        if (binding) {
          importedBindings.set(node.importClause.name.text, binding)
        }
      }

      const namedBindings = node.importClause.namedBindings
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

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return importedBindings
}

function recordActionOrSelectorMembers(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  slice: SliceRecord,
  property: ts.ObjectLiteralElementLike | null,
  relation: 'defines_action' | 'defines_selector',
  frameworkRole: 'redux_action' | 'redux_selector',
): void {
  if (!property || !(ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property))) {
    return
  }

  if (ts.isMethodDeclaration(property)) {
    return
  }

  const initializer = unparenthesizeExpression(property.initializer)
  const members = ts.isObjectLiteralExpression(initializer) ? initializer.properties : []

  for (const member of members) {
    if (!('name' in member) || !member.name) {
      continue
    }

    const memberName = propertyNameText(member.name)
    if (!memberName) {
      continue
    }

    const memberLine = lineOf(member, context.sourceFile)
    const memberId = addNamedNode(context, nodes, seenIds, memberName, memberLine, {
      nodeKind: 'function',
      frameworkRole,
      fallbackSuffix: frameworkRole,
    })
    addUniqueEdge(edges, seenEdges, createEdge(slice.nodeId, memberId, relation, context.filePath, lineOf(member, context.sourceFile)))
  }
}

function lookupReduxBinding(
  name: string,
  slicesByBinding: ReadonlyMap<string, SliceRecord>,
  thunkBindings: ReadonlyMap<string, ReduxReference>,
  actionBindings: ReadonlyMap<string, ReduxReference>,
  importedBindings: ReadonlyMap<string, ReduxReference>,
): ReduxReference | null {
  return thunkBindings.get(name)
    ?? actionBindings.get(name)
    ?? (slicesByBinding.get(name) ? sliceReference(slicesByBinding.get(name)!) : null)
    ?? importedBindings.get(name)
    ?? null
}

function recordThunkReferences(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  slice: SliceRecord,
  extraReducersProperty: ts.ObjectLiteralElementLike | null,
  slicesByBinding: ReadonlyMap<string, SliceRecord>,
  thunkBindings: ReadonlyMap<string, ReduxReference>,
  actionBindings: ReadonlyMap<string, ReduxReference>,
  importedBindings: ReadonlyMap<string, ReduxReference>,
): void {
  if (!extraReducersProperty || !(ts.isPropertyAssignment(extraReducersProperty) || ts.isMethodDeclaration(extraReducersProperty))) {
    return
  }

  const callback = ts.isMethodDeclaration(extraReducersProperty)
    ? extraReducersProperty
    : (() => {
        const initializer = unparenthesizeExpression(extraReducersProperty.initializer)
        return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) ? initializer : null
      })()

  if (!callback) {
    return
  }

  const resolveAddCaseBinding = (expression: ts.Expression): ReduxReference | null => {
    const candidate = unparenthesizeExpression(expression)
    if (ts.isIdentifier(candidate)) {
      return lookupReduxBinding(candidate.text, slicesByBinding, thunkBindings, actionBindings, importedBindings)
    }

    if (!ts.isPropertyAccessExpression(candidate)) {
      return null
    }

    const owner = unparenthesizeExpression(candidate.expression)
    if (ts.isIdentifier(owner)) {
      return lookupReduxBinding(owner.text, slicesByBinding, thunkBindings, actionBindings, importedBindings)
    }

    if (ts.isPropertyAccessExpression(owner) && owner.name.text === 'actions' && ts.isIdentifier(owner.expression)) {
      const sliceBinding = lookupReduxBinding(owner.expression.text, slicesByBinding, thunkBindings, actionBindings, importedBindings)
      if (sliceBinding?.kind === 'slice') {
        return sliceActionReference(context, sliceBinding, candidate.name.text)
      }
    }

    return null
  }

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      (() => {
        const expression = unparenthesizeExpression(node.expression)
        return ts.isPropertyAccessExpression(expression) && expression.name.text === 'addCase'
      })() &&
      node.arguments.length > 0
    ) {
      const binding = resolveAddCaseBinding(node.arguments[0]!)
      if (binding?.kind === 'thunk' || binding?.kind === 'action') {
        const bindingId = addReduxReferenceNode(context, nodes, seenIds, binding)
        addUniqueEdge(
          edges,
          seenEdges,
          createEdge(bindingId, slice.nodeId, 'updates_slice', context.filePath, lineOf(node, context.sourceFile)),
        )
      }
    }

    ts.forEachChild(node, visit)
  }

  const callbackBody = callback.body
  if (callbackBody) {
    visit(callbackBody)
  }
}

function sliceReducerTarget(
  expression: ts.Expression,
  slicesByBinding: ReadonlyMap<string, SliceRecord>,
  importedBindings: ReadonlyMap<string, ReduxReference>,
): ReduxReference | null {
  const candidate = unparenthesizeExpression(expression)
  if (
    ts.isPropertyAccessExpression(candidate) &&
    candidate.name.text === 'reducer' &&
    ts.isIdentifier(candidate.expression)
  ) {
    const localSlice = slicesByBinding.get(candidate.expression.text)
    if (localSlice) {
      return sliceReference(localSlice)
    }
  }

  if (ts.isIdentifier(candidate)) {
    const localSlice = slicesByBinding.get(candidate.text)
    if (localSlice) {
      return sliceReference(localSlice)
    }

    const importedBinding = importedBindings.get(candidate.text)
    return importedBinding?.kind === 'slice' ? importedBinding : null
  }

  if (
    ts.isPropertyAccessExpression(candidate) &&
    candidate.name.text === 'reducer' &&
    ts.isIdentifier(candidate.expression)
  ) {
    const importedBinding = importedBindings.get(candidate.expression.text)
    return importedBinding?.kind === 'slice' ? importedBinding : null
  }

  return null
}

function lexicalScope(node: ts.Node): ts.Node | null {
  let current: ts.Node | undefined = node
  while (current) {
    if (
      ts.isSourceFile(current) ||
      ts.isBlock(current) ||
      ts.isModuleBlock(current) ||
      ts.isCaseBlock(current) ||
      ts.isCatchClause(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current)
    ) {
      return current
    }
    current = current.parent
  }
  return null
}

function resolveInitializerBinding(
  name: string,
  fromNode: ts.Node,
  initializers: ReadonlyMap<string, readonly InitializerBinding[]>,
): InitializerBinding | null {
  const bindings = initializers.get(name)
  if (!bindings) {
    return null
  }

  let scope = lexicalScope(fromNode)
  while (scope) {
    const candidates = bindings.filter((binding) => binding.scope === scope && binding.pos < fromNode.pos)
    if (candidates.length > 0) {
      return candidates[candidates.length - 1] ?? null
    }
    scope = scope.parent ? lexicalScope(scope.parent) : null
  }

  return null
}

function resolveReduxInitializerExpression(
  expression: ts.Expression,
  initializers: ReadonlyMap<string, readonly InitializerBinding[]>,
  fromNode: ts.Node,
): ts.Expression {
  const seen = new Set<string>()
  let current = unparenthesizeExpression(expression)
  let currentNode: ts.Node = fromNode

  while (ts.isIdentifier(current) && !seen.has(current.text)) {
    seen.add(current.text)
    const initializer = resolveInitializerBinding(current.text, currentNode, initializers)
    if (!initializer) {
      break
    }
    current = unparenthesizeExpression(initializer.expression)
    currentNode = initializer.expression
  }

  return current
}

function isReduxSelectorHookCall(callee: ts.Expression): boolean {
  const candidate = unparenthesizeExpression(callee)
  return ts.isIdentifier(candidate) && /^use(?:[A-Za-z0-9_$]*?)Selector$/.test(candidate.text)
}

function ensureReduxUsageOwnerNode(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  seenIds: Set<string>,
  name: string,
  line: number,
  label = `${name}()`,
): string {
  const baseNode = findBaseNode(context, name)
  if (baseNode) {
    return baseNode.id
  }

  const id = _makeId(context.filePath, name, 'redux_usage_owner')
  addNode(nodes, seenIds, {
    ...createNode(id, label, context.filePath, line),
    id,
    node_kind: 'function',
  })
  return id
}

function enclosingReduxUsageOwnerId(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  seenIds: Set<string>,
  node: ts.Node,
): string {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return ensureReduxUsageOwnerNode(context, nodes, seenIds, current.name.text, lineOf(current.name, context.sourceFile))
    }

    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.initializer &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    ) {
      return ensureReduxUsageOwnerNode(context, nodes, seenIds, current.name.text, lineOf(current.name, context.sourceFile))
    }

    if (
      ts.isPropertyAssignment(current) &&
      ts.isIdentifier(current.name) &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    ) {
      return ensureReduxUsageOwnerNode(
        context,
        nodes,
        seenIds,
        current.name.text,
        lineOf(current.name, context.sourceFile),
        `.${current.name.text}()`,
      )
    }

    if (ts.isMethodDeclaration(current)) {
      const methodName = current.name ? propertyNameText(current.name) : null
      if (methodName) {
        return ensureReduxUsageOwnerNode(context, nodes, seenIds, methodName, lineOf(current.name, context.sourceFile), `.${methodName}()`)
      }
    }

    current = current.parent
  }

  return context.fileNodeId
}

function recordImportedSelectorUsage(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  importedBindings: ReadonlyMap<string, ReduxReference>,
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unparenthesizeExpression(node.expression)
      if (ts.isIdentifier(callee)) {
        const binding = importedBindings.get(callee.text)
        if (binding?.kind === 'selector') {
          const selectorId = addReduxReferenceNode(context, nodes, seenIds, binding)
          addUniqueEdge(
            edges,
            seenEdges,
            createEdge(
              enclosingReduxUsageOwnerId(context, nodes, seenIds, node),
              selectorId,
              'uses',
              context.filePath,
              lineOf(node, context.sourceFile),
            ),
          )
        }
      }

      if (isReduxSelectorHookCall(callee)) {
        const selectorArgument = node.arguments[0] ? unparenthesizeExpression(node.arguments[0]) : null
        if (selectorArgument && ts.isIdentifier(selectorArgument)) {
          const binding = importedBindings.get(selectorArgument.text)
          if (binding?.kind === 'selector') {
            const selectorId = addReduxReferenceNode(context, nodes, seenIds, binding)
            addUniqueEdge(
              edges,
              seenEdges,
              createEdge(
                enclosingReduxUsageOwnerId(context, nodes, seenIds, node),
                selectorId,
                'uses',
                context.filePath,
                lineOf(node, context.sourceFile),
              ),
            )
          }
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(context.sourceFile)
}

function handleStoreRegistration(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  toolkitBindings: ReduxToolkitImportBindings,
  slicesByBinding: ReadonlyMap<string, SliceRecord>,
  importedBindings: ReadonlyMap<string, ReduxReference>,
  initializers: ReadonlyMap<string, readonly InitializerBinding[]>,
  declaration: ts.VariableDeclaration,
): void {
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
    return
  }

  const initializer = unparenthesizeExpression(declaration.initializer)
  if (!ts.isCallExpression(initializer)) {
    return
  }
  const callee = unparenthesizeExpression(initializer.expression)
  if (!isReduxToolkitBindingCall(callee, toolkitBindings, toolkitBindings.configureStore, 'configureStore')) {
    return
  }

  const options = initializer.arguments[0]
  const optionsExpression = options ? unparenthesizeExpression(options) : null
  if (!optionsExpression || !ts.isObjectLiteralExpression(optionsExpression)) {
    return
  }

  const storeId = addNamedNode(context, nodes, seenIds, declaration.name.text, lineOf(declaration.name, context.sourceFile), {
    nodeKind: 'store',
    frameworkRole: 'redux_store',
    fallbackSuffix: 'store',
  })
  const reducerProperty = objectProperty(optionsExpression, 'reducer')
  if (!reducerProperty || !(ts.isPropertyAssignment(reducerProperty) || ts.isShorthandPropertyAssignment(reducerProperty))) {
    return
  }

  const reducerInitializer = ts.isShorthandPropertyAssignment(reducerProperty)
    ? reducerProperty.name
    : unparenthesizeExpression(reducerProperty.initializer)
  const resolvedReducerInitializer = resolveReduxInitializerExpression(reducerInitializer, initializers, reducerInitializer)

  if (ts.isObjectLiteralExpression(resolvedReducerInitializer)) {
    for (const property of resolvedReducerInitializer.properties) {
      if (!(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))) {
        continue
      }

      const targetSlice = sliceReducerTarget(
        resolveReduxInitializerExpression(
          ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer,
          initializers,
          ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer,
        ),
        slicesByBinding,
        importedBindings,
      )
      if (!targetSlice) {
        continue
      }

      const targetSliceId = addReduxReferenceNode(context, nodes, seenIds, targetSlice)
      addUniqueEdge(
        edges,
        seenEdges,
        createEdge(targetSliceId, storeId, 'registered_in_store', context.filePath, lineOf(property, context.sourceFile)),
      )
    }
    return
  }

  const targetSlice = sliceReducerTarget(resolvedReducerInitializer, slicesByBinding, importedBindings)
  if (!targetSlice) {
    return
  }

  const targetSliceId = addReduxReferenceNode(context, nodes, seenIds, targetSlice)
  addUniqueEdge(
    edges,
    seenEdges,
    createEdge(targetSliceId, storeId, 'registered_in_store', context.filePath, lineOf(reducerProperty, context.sourceFile)),
  )
}

function handleExportedMembers(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  slicesByBinding: ReadonlyMap<string, SliceRecord>,
  declaration: ts.VariableDeclaration,
): void {
  if (!ts.isObjectBindingPattern(declaration.name) || !declaration.initializer) {
    return
  }

  const initializer = unparenthesizeExpression(declaration.initializer)
  if (!ts.isPropertyAccessExpression(initializer) || !ts.isIdentifier(initializer.expression)) {
    return
  }

  const slice = slicesByBinding.get(initializer.expression.text)
  if (!slice) {
    return
  }

  const kind = initializer.name.text === 'actions'
    ? {
        relation: 'defines_action' as const,
        frameworkRole: 'redux_action' as const,
        fallbackSuffix: 'action',
      }
    : initializer.name.text === 'selectors'
      ? {
          relation: 'defines_selector' as const,
          frameworkRole: 'redux_selector' as const,
          fallbackSuffix: 'selector',
        }
      : null

  if (!kind) {
    return
  }

  for (const element of declaration.name.elements) {
    const exportName = ts.isIdentifier(element.name) ? element.name.text : null
    if (!exportName) {
      continue
    }

    const nodeId = _makeId(context.filePath, exportName, element.propertyName ? kind.fallbackSuffix : kind.frameworkRole)
    const baseNode = findBaseNode(context, exportName)
    const sourceLine = element.propertyName
      ? lineOf(element.name, context.sourceFile)
      : slice.memberLines.get(`${kind.frameworkRole}:${exportName}`) ?? lineOf(element.name, context.sourceFile)
    addNode(nodes, seenIds, {
      ...(baseNode ?? {}),
      ...createNode(nodeId, exportName, context.filePath, sourceLine),
      id: nodeId,
      node_kind: 'function',
      framework: 'redux-toolkit',
      framework_role: kind.frameworkRole,
    })
    addUniqueEdge(edges, seenEdges, createEdge(slice.nodeId, nodeId, kind.relation, context.filePath, lineOf(element, context.sourceFile)))
  }
}

function handleSliceDeclaration(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  toolkitBindings: ReduxToolkitImportBindings,
  slicesByBinding: Map<string, SliceRecord>,
  thunkBindings: Map<string, ReduxReference>,
  actionBindings: Map<string, ReduxReference>,
  importedBindings: ReadonlyMap<string, ReduxReference>,
  declaration: ts.VariableDeclaration,
): void {
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
    return
  }

  const initializer = unparenthesizeExpression(declaration.initializer)
  if (!ts.isCallExpression(initializer)) {
    return
  }
  const callee = unparenthesizeExpression(initializer.expression)
  if (isReduxToolkitBindingCall(callee, toolkitBindings, toolkitBindings.createAsyncThunk, 'createAsyncThunk')) {
    thunkBindings.set(
      declaration.name.text,
      actionReference(context.filePath, declaration.name.text, lineOf(declaration.name, context.sourceFile), 'redux_thunk'),
    )
    return
  }

  if (isReduxToolkitBindingCall(callee, toolkitBindings, toolkitBindings.createAction, 'createAction')) {
    actionBindings.set(
      declaration.name.text,
      actionReference(context.filePath, declaration.name.text, lineOf(declaration.name, context.sourceFile), 'redux_action'),
    )
    return
  }

  if (!isReduxToolkitBindingCall(callee, toolkitBindings, toolkitBindings.createSlice, 'createSlice')) {
    return
  }

  const options = initializer.arguments[0]
  const optionsExpression = options ? unparenthesizeExpression(options) : null
  if (!optionsExpression || !ts.isObjectLiteralExpression(optionsExpression)) {
    return
  }

  const sliceOptions = optionsExpression
  const sliceName = stringPropertyValue(sliceOptions, 'name') ?? declaration.name.text
  const sliceNodeId = _makeId(context.filePath, sliceName, 'slice')
  addNode(nodes, seenIds, {
    ...createNode(sliceNodeId, `${sliceName} slice`, context.filePath, lineOf(declaration.name, context.sourceFile)),
    node_kind: 'slice',
    framework: 'redux-toolkit',
    framework_role: 'redux_slice',
  })

  const sliceRecord: SliceRecord = {
    nodeId: sliceNodeId,
    label: `${sliceName} slice`,
    sourceFile: context.filePath,
    line: lineOf(declaration.name, context.sourceFile),
    memberLines: sliceMemberLines(sliceOptions, context.sourceFile),
  }
  slicesByBinding.set(declaration.name.text, sliceRecord)

  recordActionOrSelectorMembers(
    context,
    nodes,
    edges,
    seenIds,
    seenEdges,
    sliceRecord,
    objectProperty(sliceOptions, 'reducers'),
    'defines_action',
    'redux_action',
  )
  recordActionOrSelectorMembers(
    context,
    nodes,
    edges,
    seenIds,
    seenEdges,
    sliceRecord,
    objectProperty(sliceOptions, 'selectors'),
    'defines_selector',
    'redux_selector',
  )
  recordThunkReferences(
    context,
    nodes,
    edges,
    seenIds,
    seenEdges,
    sliceRecord,
    objectProperty(sliceOptions, 'extraReducers'),
    slicesByBinding,
    thunkBindings,
    actionBindings,
    importedBindings,
  )
}

export const reduxAdapter: JsFrameworkAdapter = {
  id: 'redux-toolkit',
  matches(_filePath, sourceText) {
    return REDUX_MATCH_PATTERN.test(sourceText)
  },
  extract(context) {
    const nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']> = []
    const edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']> = []
    const seenIds = new Set<string>()
    const seenEdges = new Set<string>()
    const slicesByBinding = new Map<string, SliceRecord>()
    const thunkBindings = new Map<string, ReduxReference>()
    const actionBindings = new Map<string, ReduxReference>()
    const initializers = new Map<string, InitializerBinding[]>()
    const moduleAnalysisCache = new Map<string, ReduxModuleAnalysis>()
    const importedBindings = collectImportedReduxBindings(context.filePath, context.sourceFile, moduleAnalysisCache)
    const toolkitBindings = collectReduxToolkitImportBindings(context.sourceFile)

    const collectInitializers = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const bindings = initializers.get(node.name.text) ?? []
        bindings.push({
          expression: node.initializer,
          scope: lexicalScope(node) ?? context.sourceFile,
          pos: node.pos,
        })
        initializers.set(node.name.text, bindings)
      }
      ts.forEachChild(node, collectInitializers)
    }
    collectInitializers(context.sourceFile)

    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node)) {
        handleSliceDeclaration(
          context,
          nodes,
          edges,
          seenIds,
          seenEdges,
          toolkitBindings,
          slicesByBinding,
          thunkBindings,
          actionBindings,
          importedBindings,
          node,
        )
        handleStoreRegistration(context, nodes, edges, seenIds, seenEdges, toolkitBindings, slicesByBinding, importedBindings, initializers, node)
        handleExportedMembers(context, nodes, edges, seenIds, seenEdges, slicesByBinding, node)
      }

      ts.forEachChild(node, visit)
    }

    visit(context.sourceFile)
    recordImportedSelectorUsage(context, nodes, edges, seenIds, seenEdges, importedBindings)

    return { nodes, edges }
  },
}
