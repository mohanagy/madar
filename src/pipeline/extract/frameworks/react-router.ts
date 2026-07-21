import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import * as ts from 'typescript'

import type { ExtractionNode } from '../contracts.js'
import { addNode, addUniqueEdge, createEdge, createNode, _makeId } from '../core.js'
import { unparenthesizeExpression } from '../typescript-utils.js'
import { resolveImportPath, scriptKindForPath } from './js-import-paths.js'
import type { JsFrameworkAdapter, JsFrameworkContext } from './types.js'

const REACT_ROUTER_MATCH_PATTERN = /\bcreateBrowserRouter\b|\bcreateRoutesFromElements\b|\buseRoutes\b|<Route\b|<Routes\b/
const REACT_ROUTER_MODULE_SPECIFIERS = new Set(['react-router', 'react-router-dom'])

interface RouteNodeRecord {
  id: string
  fullPath: string
  line: number
}

interface ReactRouterImportBindings {
  createBrowserRouter: Set<string>
  createRoutesFromElements: Set<string>
  useRoutes: Set<string>
  route: Set<string>
  routes: Set<string>
  namespaces: Set<string>
}

interface AddReferenceOptions {
  nodeKind: NonNullable<ExtractionNode['node_kind']>
  frameworkRole: string
  fallbackSuffix: string
}

interface ImportedRouteReference {
  id: string
  label: string
  sourceFile: string
  line: number
  nodeKind: NonNullable<ExtractionNode['node_kind']>
  anonymousDefault?: boolean
}

interface JsModuleAnalysis {
  exports: Map<string, ImportedRouteReference>
}

type RouteObjectProperty = ts.PropertyAssignment | ts.MethodDeclaration | ts.ShorthandPropertyAssignment
interface InitializerBinding {
  expression: ts.Expression
  scope: ts.Node
  pos: number
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

function createExportedReference(
  filePath: string,
  name: string,
  line: number,
  label: string,
  nodeKind: NonNullable<ExtractionNode['node_kind']>,
  anonymousDefault = false,
): ImportedRouteReference {
  return {
    id: _makeId(resolve(filePath), name),
    label,
    sourceFile: filePath,
    line,
    nodeKind,
    anonymousDefault,
  }
}

function referenceForVariableDeclaration(filePath: string, declaration: ts.VariableDeclaration, sourceFile: ts.SourceFile): ImportedRouteReference | null {
  if (!ts.isIdentifier(declaration.name)) {
    return null
  }

  const initializer = declaration.initializer ? unparenthesizeExpression(declaration.initializer) : null
  const name = declaration.name.text
  const line = lineOf(declaration.name, sourceFile)

  if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
    return createExportedReference(filePath, name, line, `${name}()`, 'function')
  }

  if (initializer && ts.isClassExpression(initializer)) {
    return createExportedReference(filePath, name, line, name, 'class')
  }

  return createExportedReference(filePath, name, line, name, 'function')
}

function importedReferenceForLocalName(reference: ImportedRouteReference, localName: string): ImportedRouteReference {
  if (!reference.anonymousDefault) {
    return reference
  }

  return {
    ...reference,
    label: reference.nodeKind === 'function' ? `${localName}()` : localName,
  }
}

function analyzeJsModule(filePath: string, cache: Map<string, JsModuleAnalysis>): JsModuleAnalysis {
  const resolvedFilePath = resolve(filePath)
  const cached = cache.get(resolvedFilePath)
  if (cached) {
    return cached
  }

  const analysis: JsModuleAnalysis = {
    exports: new Map<string, ImportedRouteReference>(),
  }
  cache.set(resolvedFilePath, analysis)

  let sourceText: string
  try {
    sourceText = readFileSync(resolvedFilePath, 'utf8')
  } catch {
    return analysis
  }

  const sourceFile = ts.createSourceFile(resolvedFilePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(resolvedFilePath))
  const importedBindings = new Map<string, ImportedRouteReference>()
  const localBindings = new Map<string, ImportedRouteReference>()

  const resolveLocalBinding = (name: string): ImportedRouteReference | null => localBindings.get(name) ?? importedBindings.get(name) ?? null

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue
    }

    const targetFilePath = resolveImportPath(resolvedFilePath, statement.moduleSpecifier.text)
    if (!targetFilePath) {
      continue
    }

    const exportedBindings = analyzeJsModule(targetFilePath, cache).exports
    if (statement.importClause.name) {
      const binding = exportedBindings.get('default')
      if (binding) {
        importedBindings.set(statement.importClause.name.text, importedReferenceForLocalName(binding, statement.importClause.name.text))
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
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
    const defaultExport = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false

    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name) {
        const reference = createExportedReference(
          resolvedFilePath,
          statement.name.text,
          lineOf(statement.name, sourceFile),
          `${statement.name.text}()`,
          'function',
        )
        localBindings.set(statement.name.text, reference)
        if (exported) {
          analysis.exports.set(statement.name.text, reference)
        }
        if (defaultExport) {
          analysis.exports.set('default', reference)
        }
      } else if (defaultExport) {
        analysis.exports.set('default', createExportedReference(resolvedFilePath, 'default', lineOf(statement, sourceFile), 'default', 'function', true))
      }
      continue
    }

    if (ts.isClassDeclaration(statement)) {
      if (statement.name) {
        const reference = createExportedReference(resolvedFilePath, statement.name.text, lineOf(statement.name, sourceFile), statement.name.text, 'class')
        localBindings.set(statement.name.text, reference)
        if (exported) {
          analysis.exports.set(statement.name.text, reference)
        }
        if (defaultExport) {
          analysis.exports.set('default', reference)
        }
      } else if (defaultExport) {
        analysis.exports.set('default', createExportedReference(resolvedFilePath, 'default', lineOf(statement, sourceFile), 'default', 'class', true))
      }
      continue
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const reference = referenceForVariableDeclaration(resolvedFilePath, declaration, sourceFile)
        if (!reference || !ts.isIdentifier(declaration.name)) {
          continue
        }

        localBindings.set(declaration.name.text, reference)
        if (exported) {
          analysis.exports.set(declaration.name.text, reference)
        }
      }
      continue
    }

    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = unparenthesizeExpression(statement.expression)
      if (ts.isIdentifier(expression)) {
        const reference = resolveLocalBinding(expression.text)
        if (reference) {
          analysis.exports.set('default', reference)
        }
      } else if ((ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) && expression.name?.text) {
        analysis.exports.set(
          'default',
          createExportedReference(resolvedFilePath, expression.name.text, lineOf(expression, sourceFile), `${expression.name.text}()`, 'function'),
        )
      } else if (ts.isClassExpression(expression) && expression.name?.text) {
        analysis.exports.set(
          'default',
          createExportedReference(resolvedFilePath, expression.name.text, lineOf(expression, sourceFile), expression.name.text, 'class'),
        )
      } else if (ts.isClassExpression(expression)) {
        analysis.exports.set('default', createExportedReference(resolvedFilePath, 'default', lineOf(statement, sourceFile), 'default', 'class', true))
      } else {
        analysis.exports.set('default', createExportedReference(resolvedFilePath, 'default', lineOf(statement, sourceFile), 'default', 'function', true))
      }
      continue
    }

    if (ts.isExportDeclaration(statement)) {
      const targetFilePath =
        statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
          ? resolveImportPath(resolvedFilePath, statement.moduleSpecifier.text)
          : null
      const targetExports = targetFilePath ? analyzeJsModule(targetFilePath, cache).exports : null

      if (!statement.exportClause && targetExports) {
        for (const [exportName, reference] of targetExports) {
          if (exportName !== 'default' && !analysis.exports.has(exportName)) {
            analysis.exports.set(exportName, reference)
          }
        }
      } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const exportName = element.name.text
          const localName = element.propertyName?.text ?? element.name.text
          const reference = targetExports?.get(localName) ?? resolveLocalBinding(localName)
          if (reference) {
            analysis.exports.set(exportName, reference)
          }
        }
      }
    }
  }

  return analysis
}

function collectImportedRouteBindings(
  filePath: string,
  sourceFile: ts.SourceFile,
  cache: Map<string, JsModuleAnalysis>,
): Map<string, ImportedRouteReference> {
  const importedBindings = new Map<string, ImportedRouteReference>()

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const targetFilePath = resolveImportPath(filePath, node.moduleSpecifier.text)
      const exportedBindings = targetFilePath ? analyzeJsModule(targetFilePath, cache).exports : null
      if (!exportedBindings) {
        ts.forEachChild(node, visit)
        return
      }

      if (node.importClause.name) {
        const binding = exportedBindings.get('default')
        if (binding) {
          importedBindings.set(node.importClause.name.text, importedReferenceForLocalName(binding, node.importClause.name.text))
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

function createReactRouterImportBindings(): ReactRouterImportBindings {
  return {
    createBrowserRouter: new Set<string>(),
    createRoutesFromElements: new Set<string>(),
    useRoutes: new Set<string>(),
    route: new Set<string>(),
    routes: new Set<string>(),
    namespaces: new Set<string>(),
  }
}

function collectReactRouterImportBindings(sourceFile: ts.SourceFile): ReactRouterImportBindings {
  const bindings = createReactRouterImportBindings()

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue
    }

    if (!REACT_ROUTER_MODULE_SPECIFIERS.has(statement.moduleSpecifier.text)) {
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
        if (importedName === 'createBrowserRouter') {
          bindings.createBrowserRouter.add(localName)
        } else if (importedName === 'createRoutesFromElements') {
          bindings.createRoutesFromElements.add(localName)
        } else if (importedName === 'useRoutes') {
          bindings.useRoutes.add(localName)
        } else if (importedName === 'Route') {
          bindings.route.add(localName)
        } else if (importedName === 'Routes') {
          bindings.routes.add(localName)
        }
      }
    }
  }

  return bindings
}

function isReactRouterBindingCall(
  expression: ts.Expression,
  bindings: ReactRouterImportBindings,
  localBindings: ReadonlySet<string>,
  memberName: 'createBrowserRouter' | 'createRoutesFromElements' | 'useRoutes',
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

function isReactRouterRouteTag(tagName: ts.JsxTagNameExpression, bindings: ReactRouterImportBindings): boolean {
  if (ts.isIdentifier(tagName)) {
    return bindings.route.has(tagName.text)
  }

  return (
    ts.isPropertyAccessExpression(tagName) &&
    ts.isIdentifier(tagName.expression) &&
    bindings.namespaces.has(tagName.expression.text) &&
    tagName.name.text === 'Route'
  )
}

function isReactRouterRoutesTag(tagName: ts.JsxTagNameExpression, bindings: ReactRouterImportBindings): boolean {
  if (ts.isIdentifier(tagName)) {
    return bindings.routes.has(tagName.text)
  }

  return (
    ts.isPropertyAccessExpression(tagName) &&
    ts.isIdentifier(tagName.expression) &&
    bindings.namespaces.has(tagName.expression.text) &&
    tagName.name.text === 'Routes'
  )
}

function addNamedReference(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  seenIds: Set<string>,
  name: string,
  line: number,
  options: AddReferenceOptions,
  importedReference: ImportedRouteReference | null = null,
): string {
  const baseNode = findBaseNode(context, name)
  const id = importedReference?.id ?? baseNode?.id ?? _makeId(context.filePath, name, options.fallbackSuffix)
  addNode(nodes, seenIds, {
    ...(importedReference
      ? createNode(importedReference.id, importedReference.label, importedReference.sourceFile, importedReference.line)
      : baseNode ?? createNode(id, name, context.filePath, line)),
    id,
    node_kind: importedReference?.nodeKind ?? baseNode?.node_kind ?? options.nodeKind,
    framework: 'react-router',
    framework_role: options.frameworkRole,
  })
  return id
}

function ensureRouteOwnerNode(
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

  const id = _makeId(context.filePath, name, 'react_router_owner')
  addNode(nodes, seenIds, {
    ...createNode(id, label, context.filePath, line),
    id,
    node_kind: 'function',
  })
  return id
}

function enclosingRouteOwnerId(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  seenIds: Set<string>,
  node: ts.Node,
): string {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return ensureRouteOwnerNode(context, nodes, seenIds, current.name.text, lineOf(current.name, context.sourceFile))
    }

    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.initializer &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    ) {
      return ensureRouteOwnerNode(context, nodes, seenIds, current.name.text, lineOf(current.name, context.sourceFile))
    }

    if (
      ts.isPropertyAssignment(current) &&
      ts.isIdentifier(current.name) &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    ) {
      return ensureRouteOwnerNode(context, nodes, seenIds, current.name.text, lineOf(current.name, context.sourceFile), `.${current.name.text}()`)
    }

    if (ts.isMethodDeclaration(current)) {
      const methodName = current.name ? propertyNameText(current.name) : null
      if (methodName) {
        return ensureRouteOwnerNode(context, nodes, seenIds, methodName, lineOf(current.name, context.sourceFile), `.${methodName}()`)
      }
    }

    current = current.parent
  }

  return context.fileNodeId
}

function joinRoutePath(parentPath: string | null, currentPath: string | null, isIndex: boolean): string {
  if (isIndex) {
    return parentPath || '/'
  }

  if (!currentPath || currentPath === '/') {
    return parentPath || '/'
  }

  if (currentPath.startsWith('/')) {
    return currentPath.replace(/\/{2,}/g, '/')
  }

  const base = parentPath && parentPath !== '/' ? parentPath : ''
  return `${base}/${currentPath}`.replace(/\/{2,}/g, '/')
}

function routeLabel(fullPath: string, isIndex: boolean): string {
  return isIndex ? `${fullPath} (index)` : fullPath
}

function routeLabelForLayout(fullPath: string): string {
  return `${fullPath} (layout)`
}

function objectProperty(node: ts.ObjectLiteralExpression, propertyName: string): RouteObjectProperty | null {
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

function booleanProperty(node: ts.ObjectLiteralExpression, propertyName: string): boolean {
  const property = objectProperty(node, propertyName)
  if (!property) {
    return false
  }

  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name.text === propertyName
  }

  if (!ts.isPropertyAssignment(property)) {
    return false
  }

  const initializer = unparenthesizeExpression(property.initializer)
  return initializer.kind === ts.SyntaxKind.TrueKeyword
}

function stringProperty(node: ts.ObjectLiteralExpression, propertyName: string): string | null {
  const property = objectProperty(node, propertyName)
  if (!property || !ts.isPropertyAssignment(property)) {
    return null
  }

  const initializer = unparenthesizeExpression(property.initializer)
  return ts.isStringLiteralLike(initializer) ? initializer.text : null
}

function expressionProperty(node: ts.ObjectLiteralExpression, propertyName: string): ts.Expression | null {
  const property = objectProperty(node, propertyName)
  if (!property || !ts.isPropertyAssignment(property)) {
    return null
  }

  return unparenthesizeExpression(property.initializer)
}

function identifierFromExpression(expression: ts.Expression): string | null {
  const candidate = unparenthesizeExpression(expression)
  if (ts.isIdentifier(candidate)) {
    return candidate.text
  }
  if (ts.isPropertyAccessExpression(candidate)) {
    return candidate.name.text
  }
  return null
}

function componentNameFromElementExpression(expression: ts.Expression): string | null {
  const candidate = unparenthesizeExpression(expression)
  if (ts.isJsxSelfClosingElement(candidate)) {
    return ts.isIdentifier(candidate.tagName) ? candidate.tagName.text : candidate.tagName.getText()
  }
  if (ts.isJsxElement(candidate)) {
    return ts.isIdentifier(candidate.openingElement.tagName)
      ? candidate.openingElement.tagName.text
      : candidate.openingElement.tagName.getText()
  }
  if (ts.isIdentifier(candidate) || ts.isPropertyAccessExpression(candidate)) {
    return identifierFromExpression(candidate)
  }
  return null
}

function createRouteNode(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  seenIds: Set<string>,
  fullPath: string,
  line: number,
   options: {
     isIndex: boolean
     isPathlessLayout: boolean
   },
): RouteNodeRecord {
  const id = _makeId(context.filePath, 'route', fullPath, String(line))
  addNode(nodes, seenIds, {
    ...createNode(
      id,
      options.isPathlessLayout ? routeLabelForLayout(fullPath) : routeLabel(fullPath, options.isIndex),
      context.filePath,
      line,
    ),
    node_kind: 'route',
    framework: 'react-router',
    framework_role: options.isPathlessLayout ? 'react_router_layout' : 'react_router_route',
    ...(options.isPathlessLayout ? {} : { route_path: fullPath }),
  })
  return { id, fullPath, line }
}

function addRouteBindings(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  route: RouteNodeRecord,
  componentExpression: ts.Expression | null,
  loaderExpression: ts.Expression | null,
  actionExpression: ts.Expression | null,
  importedBindings: ReadonlyMap<string, ImportedRouteReference>,
): void {
  const componentName = componentExpression ? componentNameFromElementExpression(componentExpression) : null
  if (componentName) {
    const componentId = addNamedReference(
      context,
      nodes,
      seenIds,
      componentName,
      lineOf(componentExpression!, context.sourceFile),
      {
        nodeKind: 'component',
        frameworkRole: 'react_router_component',
        fallbackSuffix: 'component',
      },
      importedBindings.get(componentName) ?? null,
    )
    addUniqueEdge(edges, seenEdges, createEdge(route.id, componentId, 'renders', context.filePath, route.line))
  }

  const loaderName = loaderExpression ? identifierFromExpression(loaderExpression) : null
  if (loaderName) {
    const loaderId = addNamedReference(
      context,
      nodes,
      seenIds,
      loaderName,
      lineOf(loaderExpression!, context.sourceFile),
      {
        nodeKind: 'function',
        frameworkRole: 'react_router_loader',
        fallbackSuffix: 'loader',
      },
      importedBindings.get(loaderName) ?? null,
    )
    addUniqueEdge(edges, seenEdges, createEdge(route.id, loaderId, 'loads_route', context.filePath, route.line))
  }

  const actionName = actionExpression ? identifierFromExpression(actionExpression) : null
  if (actionName) {
    const actionId = addNamedReference(
      context,
      nodes,
      seenIds,
      actionName,
      lineOf(actionExpression!, context.sourceFile),
      {
        nodeKind: 'function',
        frameworkRole: 'react_router_action',
        fallbackSuffix: 'action',
      },
      importedBindings.get(actionName) ?? null,
    )
    addUniqueEdge(edges, seenEdges, createEdge(route.id, actionId, 'submits_route', context.filePath, route.line))
  }
}

function jsxAttributeExpression(attribute: ts.JsxAttribute | undefined): ts.Expression | null {
  if (!attribute?.initializer) {
    return null
  }

  if (ts.isJsxExpression(attribute.initializer)) {
    return attribute.initializer.expression ? unparenthesizeExpression(attribute.initializer.expression) : null
  }

  if (ts.isStringLiteral(attribute.initializer)) {
    return attribute.initializer
  }

  return null
}

function jsxAttribute(node: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && ts.isIdentifier(property.name) && property.name.text === name,
  )
}

function routeNodeFromJsxElement(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  routerId: string,
  element: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment,
  parentRoute: RouteNodeRecord | null,
  importedBindings: ReadonlyMap<string, ImportedRouteReference>,
  reactRouterBindings: ReactRouterImportBindings,
): RouteNodeRecord | null {
  if (ts.isJsxFragment(element)) {
    for (const child of element.children) {
      if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
        routeNodeFromJsxElement(context, nodes, edges, seenIds, seenEdges, routerId, child, parentRoute, importedBindings, reactRouterBindings)
      }
    }
    return null
  }

  const openingElement = ts.isJsxElement(element) ? element.openingElement : element
  if (isReactRouterRoutesTag(openingElement.tagName, reactRouterBindings)) {
    if (ts.isJsxElement(element)) {
      for (const child of element.children) {
        if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
          routeNodeFromJsxElement(context, nodes, edges, seenIds, seenEdges, routerId, child, parentRoute, importedBindings, reactRouterBindings)
        }
      }
    }
    return null
  }

  if (!isReactRouterRouteTag(openingElement.tagName, reactRouterBindings)) {
    return null
  }

  const pathExpression = jsxAttributeExpression(jsxAttribute(openingElement, 'path'))
  const isIndex = Boolean(jsxAttribute(openingElement, 'index'))
  const fullPath = joinRoutePath(
    parentRoute?.fullPath ?? null,
    pathExpression && ts.isStringLiteralLike(pathExpression) ? pathExpression.text : null,
    isIndex,
  )
  const isPathlessLayout = !isIndex && !pathExpression
  const route = createRouteNode(
    context,
    nodes,
    seenIds,
    fullPath,
    lineOf(openingElement, context.sourceFile),
    { isIndex, isPathlessLayout },
  )

  addUniqueEdge(
    edges,
    seenEdges,
    createEdge(parentRoute ? parentRoute.id : routerId, route.id, parentRoute ? 'contains' : 'registers_route', context.filePath, route.line),
  )

  addRouteBindings(
    context,
    nodes,
    edges,
    seenIds,
    seenEdges,
    route,
    jsxAttributeExpression(jsxAttribute(openingElement, 'Component')) ??
      jsxAttributeExpression(jsxAttribute(openingElement, 'element')),
    jsxAttributeExpression(jsxAttribute(openingElement, 'loader')),
    jsxAttributeExpression(jsxAttribute(openingElement, 'action')),
    importedBindings,
  )

  if (ts.isJsxElement(element)) {
    for (const child of element.children) {
      if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
        routeNodeFromJsxElement(context, nodes, edges, seenIds, seenEdges, routerId, child, route, importedBindings, reactRouterBindings)
      }
    }
  }

  return route
}

function routeNodeFromObjectLiteral(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  routerId: string,
  routeObject: ts.ObjectLiteralExpression,
  parentRoute: RouteNodeRecord | null,
  importedBindings: ReadonlyMap<string, ImportedRouteReference>,
): RouteNodeRecord {
  const isIndex = booleanProperty(routeObject, 'index')
  const path = stringProperty(routeObject, 'path')
  const fullPath = joinRoutePath(parentRoute?.fullPath ?? null, path, isIndex)
  const route = createRouteNode(context, nodes, seenIds, fullPath, lineOf(routeObject, context.sourceFile), {
    isIndex,
    isPathlessLayout: !isIndex && !path,
  })

  addUniqueEdge(
    edges,
    seenEdges,
    createEdge(parentRoute ? parentRoute.id : routerId, route.id, parentRoute ? 'contains' : 'registers_route', context.filePath, route.line),
  )

  addRouteBindings(
    context,
    nodes,
    edges,
    seenIds,
    seenEdges,
    route,
    expressionProperty(routeObject, 'Component') ?? expressionProperty(routeObject, 'element'),
    expressionProperty(routeObject, 'loader'),
    expressionProperty(routeObject, 'action'),
    importedBindings,
  )

  const childrenExpression = expressionProperty(routeObject, 'children')
  if (childrenExpression && ts.isArrayLiteralExpression(childrenExpression)) {
    for (const child of childrenExpression.elements) {
      const candidate = unparenthesizeExpression(child)
      if (ts.isObjectLiteralExpression(candidate)) {
        routeNodeFromObjectLiteral(context, nodes, edges, seenIds, seenEdges, routerId, candidate, route, importedBindings)
      }
    }
  }

  return route
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

function resolveInitializerExpression(
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

function extractRoutesFromExpression(
  context: JsFrameworkContext,
  nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']>,
  edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']>,
  seenIds: Set<string>,
  seenEdges: Set<string>,
  ownerId: string,
  routesExpression: ts.Expression | null,
  importedBindings: ReadonlyMap<string, ImportedRouteReference>,
  reactRouterBindings: ReactRouterImportBindings,
  initializers: ReadonlyMap<string, readonly InitializerBinding[]>,
): void {
  const resolvedRoutesExpression = routesExpression ? resolveInitializerExpression(routesExpression, initializers, routesExpression) : null
  if (!resolvedRoutesExpression) {
    return
  }

  if (ts.isArrayLiteralExpression(resolvedRoutesExpression)) {
    for (const element of resolvedRoutesExpression.elements) {
      const candidate = unparenthesizeExpression(element)
      if (ts.isObjectLiteralExpression(candidate)) {
        routeNodeFromObjectLiteral(context, nodes, edges, seenIds, seenEdges, ownerId, candidate, null, importedBindings)
      }
    }
    return
  }

  if (ts.isCallExpression(resolvedRoutesExpression)) {
    const routeFactory = unparenthesizeExpression(resolvedRoutesExpression.expression)
    if (
      isReactRouterBindingCall(
        routeFactory,
        reactRouterBindings,
        reactRouterBindings.createRoutesFromElements,
        'createRoutesFromElements',
      )
    ) {
      const rootElement = resolvedRoutesExpression.arguments[0]
        ? resolveInitializerExpression(resolvedRoutesExpression.arguments[0], initializers, resolvedRoutesExpression.arguments[0])
        : null
      if (rootElement && (ts.isJsxElement(rootElement) || ts.isJsxSelfClosingElement(rootElement) || ts.isJsxFragment(rootElement))) {
        routeNodeFromJsxElement(context, nodes, edges, seenIds, seenEdges, ownerId, rootElement, null, importedBindings, reactRouterBindings)
      }
    }
    return
  }

  if (ts.isJsxElement(resolvedRoutesExpression) || ts.isJsxSelfClosingElement(resolvedRoutesExpression) || ts.isJsxFragment(resolvedRoutesExpression)) {
    routeNodeFromJsxElement(
      context,
      nodes,
      edges,
      seenIds,
      seenEdges,
      ownerId,
      resolvedRoutesExpression,
      null,
      importedBindings,
      reactRouterBindings,
    )
  }
}

export const reactRouterAdapter: JsFrameworkAdapter = {
  id: 'react-router',
  matches(_filePath, sourceText) {
    return REACT_ROUTER_MATCH_PATTERN.test(sourceText)
  },
  extract(context) {
    const nodes: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['nodes']> = []
    const edges: NonNullable<ReturnType<JsFrameworkAdapter['extract']>['edges']> = []
    const seenIds = new Set<string>()
    const seenEdges = new Set<string>()
    const initializers = new Map<string, InitializerBinding[]>()
    const moduleAnalysisCache = new Map<string, JsModuleAnalysis>()
    const importedBindings = collectImportedRouteBindings(context.filePath, context.sourceFile, moduleAnalysisCache)
    const reactRouterBindings = collectReactRouterImportBindings(context.sourceFile)

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
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const initializer = unparenthesizeExpression(node.initializer)
        const callee = ts.isCallExpression(initializer) ? unparenthesizeExpression(initializer.expression) : null
        if (
          ts.isCallExpression(initializer) &&
          callee &&
          isReactRouterBindingCall(callee, reactRouterBindings, reactRouterBindings.createBrowserRouter, 'createBrowserRouter')
        ) {
          const routerId = addNamedReference(context, nodes, seenIds, node.name.text, lineOf(node.name, context.sourceFile), {
            nodeKind: 'router',
            frameworkRole: 'react_router',
            fallbackSuffix: 'router',
          })
          extractRoutesFromExpression(
            context,
            nodes,
            edges,
            seenIds,
            seenEdges,
            routerId,
            initializer.arguments[0] ?? null,
            importedBindings,
            reactRouterBindings,
            initializers,
          )
        }
      }

      if (ts.isCallExpression(node)) {
        const callee = unparenthesizeExpression(node.expression)
        if (isReactRouterBindingCall(callee, reactRouterBindings, reactRouterBindings.useRoutes, 'useRoutes')) {
          extractRoutesFromExpression(
            context,
            nodes,
            edges,
            seenIds,
            seenEdges,
            enclosingRouteOwnerId(context, nodes, seenIds, node),
            node.arguments[0] ?? null,
            importedBindings,
            reactRouterBindings,
            initializers,
          )
        }
      }

      if (ts.isExportAssignment(node) && !node.isExportEquals) {
        const expression = unparenthesizeExpression(node.expression)
        if (!ts.isCallExpression(expression)) {
          ts.forEachChild(node, visit)
          return
        }
        const initializer = expression
        const callee = unparenthesizeExpression(initializer.expression)
        if (isReactRouterBindingCall(callee, reactRouterBindings, reactRouterBindings.createBrowserRouter, 'createBrowserRouter')) {
          const routerId = addNamedReference(context, nodes, seenIds, 'default', lineOf(node, context.sourceFile), {
            nodeKind: 'router',
            frameworkRole: 'react_router',
            fallbackSuffix: 'router',
          })
          extractRoutesFromExpression(
            context,
            nodes,
            edges,
            seenIds,
            seenEdges,
            routerId,
            initializer.arguments[0] ?? null,
            importedBindings,
            reactRouterBindings,
            initializers,
          )
        }
      }

      if (
        (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) &&
        !ts.isCallExpression(node.parent) &&
        !ts.isExportAssignment(node.parent)
      ) {
        const openingElement = ts.isJsxFragment(node) ? null : ts.isJsxElement(node) ? node.openingElement : node
        if (openingElement && isReactRouterRoutesTag(openingElement.tagName, reactRouterBindings)) {
          routeNodeFromJsxElement(
            context,
            nodes,
            edges,
            seenIds,
            seenEdges,
            enclosingRouteOwnerId(context, nodes, seenIds, node),
            node,
            null,
            importedBindings,
            reactRouterBindings,
          )
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(context.sourceFile)

    return { nodes, edges }
  },
}
