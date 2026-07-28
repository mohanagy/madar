
import ts from 'typescript'

import type { IndexEdge, IndexFrameworkRole, IndexSymbol } from '../../domain/index/model.js'

const REACT_ROUTER_MODULE_SPECIFIERS: ReadonlySet<string> = new Set([
  'react-router',
  'react-router-dom',
])

const ROUTER_FACTORY_NAMES: ReadonlySet<string> = new Set([
  'createBrowserRouter',
  'createHashRouter',
  'createMemoryRouter',
  'createStaticRouter',
])

const ROUTE_MODULE_EXPORT_NAMES: ReadonlyMap<string, IndexFrameworkRole> = new Map([
  ['loader', 'react_router_loader'],
  ['action', 'react_router_action'],
])

type ReactRouterBindings = {
  /** Local names for the named factory imports. */
  routerFactories: Set<string>
  /** True when the file imports anything from react-router(-dom). */
  hasReactRouterImport: boolean
}

export type DetectReactRouterFrameworkContext = {
  sourceFile: ts.SourceFile
  fileId: string
  symbolsByFile: Map<string, IndexSymbol[]>
  edges: IndexEdge[]
  checker: ts.TypeChecker
  pathToFileId: Map<string, string>
}

export function detectReactRouterFramework(ctx: DetectReactRouterFrameworkContext): void {
  const bindings = collectBindings(ctx.sourceFile)
  if (!bindings.hasReactRouterImport) return

  for (const stmt of ctx.sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      if (!isFactoryCall(decl.initializer, bindings.routerFactories)) continue

      const configArg = (decl.initializer as ts.CallExpression).arguments[0]
      const collected: RouteAssignment[] = []
      const resolvedArray = resolveRouteConfigArray(configArg, ctx.sourceFile)
      if (resolvedArray) {
        collectRouteAssignments(resolvedArray, '', collected)
      }

      const topPaths = collected
        .filter((a) => a.depth === 0)
        .map((a) => a.routePath)
      const routerRoutePath = topPaths.length === 1
        ? topPaths[0]
        : (topPaths.length === 0 ? '/' : topPaths.join('|'))
      const router = tagSymbolByName(ctx, decl.name.text, 'react_router_router', { route_path: routerRoutePath })
      if (!router) continue
      for (const assignment of collected) {
        emitAssignment(ctx, router, assignment.loaderName, assignment.loaderNode, 'react_router_loader', assignment.routePath)
        emitAssignment(ctx, router, assignment.actionName, assignment.actionNode, 'react_router_action', assignment.routePath)
      }
    }
  }

  for (const stmt of ctx.sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      const role = ROUTE_MODULE_EXPORT_NAMES.get(stmt.name.text)
      if (role) tagSymbolByName(ctx, stmt.name.text, role)
      continue
    }

    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue
        const role = ROUTE_MODULE_EXPORT_NAMES.get(decl.name.text)
        if (role) tagSymbolByName(ctx, decl.name.text, role)
      }
    }
  }
}

/** Resolve the config argument to an ArrayLiteralExpression. Accepts:
 *   - the array literal directly (the common inline case)
 *   - an Identifier that refers to a same-file const/let/var whose
 *     initializer is an array literal
 *  Returns null when neither shape matches; the detector skips route-
 *  assignment collection but still tags the router with its role. */
function resolveRouteConfigArray(
  expr: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
): ts.ArrayLiteralExpression | null {
  if (!expr) return null
  if (ts.isArrayLiteralExpression(expr)) return expr
  if (!ts.isIdentifier(expr)) return null
  const name = expr.text
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== name) continue
      if (decl.initializer && ts.isArrayLiteralExpression(decl.initializer)) {
        return decl.initializer
      }
      return null
    }
  }
  return null
}

/** A flat record describing one route node in the config tree, after path
 *  composition with its ancestors. `depth` is the nesting level — top-
 *  level routes have depth 0. */
type RouteAssignment = {
  routePath: string
  depth: number
  loaderName: string | null
  actionName: string | null
  loaderNode: ts.Node | null
  actionNode: ts.Node | null
}

/** Walks a route-config array literal and emits one RouteAssignment per
 *  recognised object literal. Children inherit the parent's path; index
 *  routes (`{ index: true }`) reuse the parent's path verbatim. Pathless
 *  layout routes (no `path` property but `children` present) pass through
 *  transparently — the grandparent's path is used for children. */
function collectRouteAssignments(
  array: ts.ArrayLiteralExpression,
  parentPath: string,
  out: RouteAssignment[],
  depth = 0,
): void {
  for (const element of array.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue
    const fields = readRouteFields(element)

    let effectivePath: string
    if (fields.path !== null) {
      effectivePath = joinRoutePaths(parentPath, fields.path)
    } else if (fields.isIndex) {
      effectivePath = parentPath === '' ? '/' : parentPath
    } else {
      effectivePath = parentPath
    }

    if (fields.path !== null || fields.isIndex || fields.loaderName || fields.actionName) {
      out.push({
        routePath: effectivePath === '' ? '/' : effectivePath,
        depth,
        loaderName: fields.loaderName,
        actionName: fields.actionName,
        loaderNode: fields.loaderNode,
        actionNode: fields.actionNode,
      })
    }

    if (fields.children) {
      collectRouteAssignments(fields.children, effectivePath, out, depth + 1)
    }
  }
}

type RouteFields = {
  path: string | null
  isIndex: boolean
  loaderName: string | null
  actionName: string | null
  children: ts.ArrayLiteralExpression | null
  loaderNode: ts.Node | null
  actionNode: ts.Node | null
}

function readRouteFields(obj: ts.ObjectLiteralExpression): RouteFields {
  const fields: RouteFields = {
    path: null,
    isIndex: false,
    loaderName: null,
    actionName: null,
    children: null,
    loaderNode: null,
    actionNode: null,
  }
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      if (ts.isShorthandPropertyAssignment(prop)) {
        const key = prop.name.text
        if (key === 'loader') { fields.loaderName = prop.name.text; fields.loaderNode = prop }
        else if (key === 'action') { fields.actionName = prop.name.text; fields.actionNode = prop }
      }
      continue
    }
    const key = readPropertyKey(prop.name)
    if (key === null) continue
    if (key === 'path' && ts.isStringLiteralLike(prop.initializer)) {
      fields.path = prop.initializer.text
    } else if (key === 'index' && prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
      fields.isIndex = true
    } else if (key === 'loader' && ts.isIdentifier(prop.initializer)) {
      fields.loaderName = prop.initializer.text
      fields.loaderNode = prop
    } else if (key === 'action' && ts.isIdentifier(prop.initializer)) {
      fields.actionName = prop.initializer.text
      fields.actionNode = prop
    } else if (key === 'children' && ts.isArrayLiteralExpression(prop.initializer)) {
      fields.children = prop.initializer
    }
  }
  return fields
}

function readPropertyKey(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text
  if (ts.isStringLiteralLike(name)) return name.text
  return null
}

/** Join the parent's URL path with a child's URL fragment. React Router
 *  treats trailing/leading slashes leniently — we apply the same rule:
 *  the join is exactly one `/` between the two parts, and the result has
 *  no trailing slash (unless the result IS just `/`). */
function joinRoutePaths(parent: string, child: string): string {
  if (child.startsWith('/')) {
    return child === '/' ? '/' : child.replace(/\/+$/, '')
  }
  const trimmedParent = parent.replace(/\/+$/, '')
  const trimmedChild = child.replace(/^\/+/, '').replace(/\/+$/, '')
  if (trimmedChild === '') return trimmedParent === '' ? '/' : trimmedParent
  const joined = trimmedParent + '/' + trimmedChild
  return joined.startsWith('/') ? joined : '/' + joined
}

function collectBindings(sourceFile: ts.SourceFile): ReactRouterBindings {
  const bindings: ReactRouterBindings = {
    routerFactories: new Set<string>(),
    hasReactRouterImport: false,
  }
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (!REACT_ROUTER_MODULE_SPECIFIERS.has(stmt.moduleSpecifier.text)) continue

    bindings.hasReactRouterImport = true
    const named = stmt.importClause.namedBindings
    if (!named || !ts.isNamedImports(named)) continue
    for (const element of named.elements) {
      const importedName = element.propertyName?.text ?? element.name.text
      if (ROUTER_FACTORY_NAMES.has(importedName)) {
        bindings.routerFactories.add(element.name.text)
      }
    }
  }
  return bindings
}

function isFactoryCall(expression: ts.Expression, factoryNames: ReadonlySet<string>): boolean {
  if (!ts.isCallExpression(expression)) return false
  const callee = expression.expression
  if (ts.isIdentifier(callee)) return factoryNames.has(callee.text)
  return false
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  if (!modifiers) return false
  for (const mod of modifiers) {
    if (mod.kind === ts.SyntaxKind.ExportKeyword) return true
  }
  return false
}

function tagSymbolByName(
  ctx: DetectReactRouterFrameworkContext,
  name: string,
  role: IndexFrameworkRole,
  metadata?: Record<string, unknown>,
): IndexSymbol | null {
  const symbols = ctx.symbolsByFile.get(ctx.fileId)
  if (!symbols) return null
  for (const symbol of symbols) {
    if (symbol.name === name && symbol.framework_role === undefined) {
      symbol.framework_role = role
      if (metadata) {
        const merged: Record<string, unknown> = { ...(symbol.framework_metadata ?? {}) }
        for (const [key, value] of Object.entries(metadata)) {
          if (value !== undefined) merged[key] = value
        }
        symbol.framework_metadata = merged
      }
      return symbol
    }
  }
  return null
}

function emitAssignment(
  ctx: DetectReactRouterFrameworkContext,
  router: IndexSymbol,
  name: string | null,
  node: ts.Node | null,
  role: IndexFrameworkRole,
  routePath: string,
): void {
  if (!name || !node) return
  const handler = tagSymbolByName(ctx, name, role, { route_path: routePath })
    ?? tagImportedHandler(ctx, node, role, routePath)
  if (!handler) return
  const start = ctx.sourceFile.getLineAndCharacterOfPosition(node.getStart(ctx.sourceFile))
  const end = ctx.sourceFile.getLineAndCharacterOfPosition(node.getEnd())
  ctx.edges.push({
    from: router.id,
    to: handler.id,
    kind: 'route_handler',
    confidence: 'high',
    source: 'typescript-semantic',
    evidence: {
      file_id: ctx.fileId,
      range: {
        start: { line: start.line + 1, column: start.character + 1 },
        end: { line: end.line + 1, column: end.character + 1 },
      },
    },
    metadata: { route_path: routePath },
  })
}

function tagImportedHandler(
  ctx: DetectReactRouterFrameworkContext,
  node: ts.Node,
  role: IndexFrameworkRole,
  routePath: string,
): IndexSymbol | null {
  const identifier = ts.isShorthandPropertyAssignment(node)
    ? node.name
    : ts.isPropertyAssignment(node) && ts.isIdentifier(node.initializer)
      ? node.initializer
      : null
  if (!identifier) return null
  let symbol = ts.isShorthandPropertyAssignment(node)
    ? ctx.checker.getShorthandAssignmentValueSymbol(node)
    : ctx.checker.getSymbolAtLocation(identifier)
  if ((symbol?.flags ?? 0) & ts.SymbolFlags.Alias) {
    try { symbol = ctx.checker.getAliasedSymbol(symbol as ts.Symbol) } catch { return null }
  }
  const declaration = symbol?.declarations?.[0]
  const name = symbol?.name
  if (!declaration || !name) return null
  const fileId = ctx.pathToFileId.get(declaration.getSourceFile().fileName.replaceAll('\\', '/'))
  const handler = fileId
    ? (ctx.symbolsByFile.get(fileId) ?? []).find((candidate) => candidate.name === name)
    : null
  if (!handler) return null
  if (handler.framework_role === undefined) handler.framework_role = role
  handler.framework_metadata = { ...(handler.framework_metadata ?? {}), route_path: routePath }
  return handler
}
