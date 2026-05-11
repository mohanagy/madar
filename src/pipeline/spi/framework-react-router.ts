// SPI v1 — React Router framework layer (slice 1c-v.a of #72).
//
// React Router (v6.4+ data-router idiom) has two structural patterns the
// SPI substrate cares about:
//
//   1. Router factories — `createBrowserRouter([...])`,
//      `createHashRouter([...])`, `createMemoryRouter([...])`, and
//      `createStaticRouter([...])`. The factory call's receiving variable
//      is tagged with framework_role: 'react_router_router'.
//
//   2. Route-module convention — when a file imports from 'react-router'
//      or 'react-router-dom' AND exports a named function or const called
//      exactly `loader` or `action`, those exports are tagged with
//      framework_role: 'react_router_loader' / 'react_router_action'.
//
// JSX route definitions (`<Route path="/x" element={<X />} />`) and
// hook-based detection (useNavigate, useLoaderData, etc.) are intentionally
// out of scope for this substrate slice — they're structurally more
// invasive and land in slice 1c-v.b once the basic shape is proven.

import ts from 'typescript'

import type { SpiFrameworkRole, SpiSymbol } from './types.js'

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

const ROUTE_MODULE_EXPORT_NAMES: ReadonlyMap<string, SpiFrameworkRole> = new Map([
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
  symbolsByFile: Map<string, SpiSymbol[]>
}

export function detectReactRouterFramework(ctx: DetectReactRouterFrameworkContext): void {
  const bindings = collectBindings(ctx.sourceFile)
  if (!bindings.hasReactRouterImport) return

  // 1. Router factory detection: walk top-level variable declarations,
  // tag those initialised with a known factory call.
  for (const stmt of ctx.sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      if (isFactoryCall(decl.initializer, bindings.routerFactories)) {
        tagSymbolByName(ctx, decl.name.text, 'react_router_router')
      }
    }
  }

  // 2. Route-module convention: tag named exports called `loader` or
  // `action`. Three AST shapes to recognise:
  //   * export function loader() {}
  //   * export const loader = () => {}
  //   * function loader() {}; export { loader }   (re-export form — skipped here)
  for (const stmt of ctx.sourceFile.statements) {
    // export function loader() {}
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      const role = ROUTE_MODULE_EXPORT_NAMES.get(stmt.name.text)
      if (role) tagSymbolByName(ctx, stmt.name.text, role)
      continue
    }

    // export const loader = ...
    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue
        const role = ROUTE_MODULE_EXPORT_NAMES.get(decl.name.text)
        if (role) tagSymbolByName(ctx, decl.name.text, role)
      }
    }
  }
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
  role: SpiFrameworkRole,
): void {
  const symbols = ctx.symbolsByFile.get(ctx.fileId)
  if (!symbols) return
  for (const symbol of symbols) {
    if (symbol.name === name && symbol.framework_role === undefined) {
      symbol.framework_role = role
      return
    }
  }
}
