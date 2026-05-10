// SPI v1 — Express framework layer (slice 1c-ii.b of #72).
//
// Detects Express's `app = express()` and `router = Router()` factory call
// patterns and tags the resulting variable symbols with framework_role.
// Slice 1c-ii.b is the SUBSTRATE layer of the Express port: it adds the
// minimum SPI tagging the projector needs to surface 'framework: express'
// on the produced ExtractionNode (via slice 1c-ii.a's framework_role
// propagation).
//
// Future slices extend this:
//
//   * 1c-ii.c — call-site route detection: walk app.get / app.post / etc.
//     emit `controller_route`-equivalent edges from app/router symbols
//     to the route handler.
//   * 1c-ii.d — middleware detection: app.use(...) tags middleware
//     functions with framework_role: 'express_middleware'.
//   * 1c-ii.e — full byte-equivalence with the legacy
//     extract/frameworks/express.ts surface (~1,669 lines): synthetic
//     route nodes with route_path, framework metadata, mounted-router
//     resolution.
//
// Confidence rules: high when the factory binding resolves to the
// 'express' module specifier; otherwise the tagging is skipped (no
// best-effort low-confidence tags here, since Express's runtime patterns
// are too dynamic for cheap heuristics to reliably distinguish).

import ts from 'typescript'

import type { SpiFrameworkRole, SpiSymbol } from './types.js'

const EXPRESS_MODULE_SPECIFIER = 'express'

type ExpressBindings = {
  /** Local name(s) for the default `express` export — i.e., the factory
   *  callable that produces an app. Typically {'express'}. */
  appFactory: Set<string>
  /** Local name(s) for the named `Router` export. Typically {'Router'}. */
  routerFactory: Set<string>
  /** Local name(s) for namespace imports: `import * as e from 'express'`. */
  namespaceAlias: Set<string>
}

export type DetectExpressFrameworkContext = {
  sourceFile: ts.SourceFile
  fileId: string
  symbolsByFile: Map<string, SpiSymbol[]>
}

export function detectExpressFramework(ctx: DetectExpressFrameworkContext): void {
  const bindings = collectExpressBindings(ctx.sourceFile)
  if (!hasAnyBinding(bindings)) return

  // Walk top-level variable statements looking for `const name = express()`
  // or `const name = Router()` patterns. Tag the variable symbol with the
  // matching framework_role.
  for (const stmt of ctx.sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0
    const symbolKind: SpiSymbol['kind'] = isConst ? 'constant' : 'variable'
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      const role = factoryCallRole(decl.initializer, bindings)
      if (!role) continue
      tagSymbol(ctx.symbolsByFile, ctx.fileId, symbolKind, decl.name.text, role)
    }
  }
}

function collectExpressBindings(sourceFile: ts.SourceFile): ExpressBindings {
  const bindings: ExpressBindings = {
    appFactory: new Set<string>(),
    routerFactory: new Set<string>(),
    namespaceAlias: new Set<string>(),
  }
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (stmt.moduleSpecifier.text !== EXPRESS_MODULE_SPECIFIER) continue

    // Default import: `import express from 'express'` — the local name is
    // the factory callable that yields an Express app.
    if (stmt.importClause.name) {
      bindings.appFactory.add(stmt.importClause.name.text)
    }

    const namedBindings = stmt.importClause.namedBindings
    if (!namedBindings) continue

    if (ts.isNamespaceImport(namedBindings)) {
      // `import * as e from 'express'` — both e() and e.Router() are
      // factory calls. We track the namespace alias and resolve member
      // accesses below.
      bindings.namespaceAlias.add(namedBindings.name.text)
      continue
    }

    if (ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text
        const localName = element.name.text
        if (importedName === 'Router') bindings.routerFactory.add(localName)
        // `import { default as express, Router } from 'express'` is the
        // explicit form of the default-import pattern above. Treat the
        // 'default' aliased import as an app factory.
        if (importedName === 'default') bindings.appFactory.add(localName)
      }
    }
  }
  return bindings
}

function hasAnyBinding(b: ExpressBindings): boolean {
  return b.appFactory.size > 0 || b.routerFactory.size > 0 || b.namespaceAlias.size > 0
}

function factoryCallRole(initializer: ts.Expression, bindings: ExpressBindings): SpiFrameworkRole | null {
  if (!ts.isCallExpression(initializer)) return null
  const callee = initializer.expression

  // `express()` — direct call to the app factory.
  if (ts.isIdentifier(callee) && bindings.appFactory.has(callee.text)) {
    return 'express_app'
  }

  // `e.Router()` or `e()` via a namespace import alias.
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ts.isIdentifier(callee.name)) {
    const namespaceName = callee.expression.text
    const memberName = callee.name.text
    if (bindings.namespaceAlias.has(namespaceName)) {
      if (memberName === 'Router') return 'express_router'
      // Namespace.default() is unusual but legal; treat as app factory.
      if (memberName === 'default') return 'express_app'
    }
  }

  // `Router()` — named-import call to the Router factory.
  if (ts.isIdentifier(callee) && bindings.routerFactory.has(callee.text)) {
    return 'express_router'
  }

  return null
}

function tagSymbol(
  symbolsByFile: Map<string, SpiSymbol[]>,
  fileId: string,
  kind: SpiSymbol['kind'],
  name: string,
  role: SpiFrameworkRole,
): void {
  const symbols = symbolsByFile.get(fileId)
  if (!symbols) return
  for (const symbol of symbols) {
    if (symbol.kind === kind && symbol.name === name) {
      symbol.framework_role = role
      return
    }
  }
}
