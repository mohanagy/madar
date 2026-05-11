// SPI v1 — tRPC framework layer (v0.17 #83).
//
// tRPC builds typed RPC routers from a builder instance:
//
//   import { initTRPC } from '@trpc/server'
//   const t = initTRPC.create()
//   export const appRouter = t.router({
//     getUser: t.procedure.input(z.string()).query(({ input }) => ...),
//     createUser: t.procedure.input(schema).mutation(({ input }) => ...),
//     onMessage: t.procedure.subscription(() => ...),
//   })
//
// The substrate captures three structural facts:
//
//   * `t.router({...})` factory call result → `trpc_router` (variable holding it)
//   * Object-literal entries inside the router whose value chain ends in
//     `.query(...)`, `.mutation(...)`, or `.subscription(...)`
//     are tagged with `trpc_procedure_query/mutation/subscription` and
//     get `procedure_name` on framework_metadata.
//
// Since procedures live as object-literal entries (not standalone
// variables), the detector synthesises SpiSymbol entries when the
// procedure has a property-name identifier — mirroring slice 1c-ii.e's
// inline-handler synthesis for Express. If the file already has a
// same-named top-level symbol, the existing symbol is tagged in place.
//
// Out of scope:
//   * `mergeRouters({...})` composition — secondary; same pattern as
//     factory call.
//   * Procedure input/output type analysis (`.input(schema)`,
//     `.output(schema)`) — would require the type checker; deferred.
//   * Subroutes (nested router objects) — punted to a follow-up slice.

import ts from 'typescript'

import type { SpiFrameworkRole, SpiSymbol } from './types.js'

const TRPC_MODULE_SPECIFIERS: ReadonlySet<string> = new Set([
  '@trpc/server',
  '@trpc/server/adapters',
  '@trpc/client',
])

const PROCEDURE_METHOD_TO_ROLE: ReadonlyMap<string, SpiFrameworkRole> = new Map([
  ['query', 'trpc_procedure_query'],
  ['mutation', 'trpc_procedure_mutation'],
  ['subscription', 'trpc_procedure_subscription'],
])

export type DetectTrpcFrameworkContext = {
  sourceFile: ts.SourceFile
  fileId: string
  symbolsByFile: Map<string, SpiSymbol[]>
  /** Global symbols array — synthesized procedure symbols must be
   *  pushed here too so they appear in spi.symbols, not just in the
   *  per-file lookup map. */
  symbols: SpiSymbol[]
}

interface TrpcBindings {
  hasTrpcImport: boolean
}

export function detectTrpcFramework(ctx: DetectTrpcFrameworkContext): void {
  const bindings = collectBindings(ctx.sourceFile)
  if (!bindings.hasTrpcImport) return

  // Walk top-level variable declarations. For each, check if the
  // initializer is a `<builder>.router({...})` call — if so, tag the
  // variable as `trpc_router` and walk the object literal for procedures.
  for (const stmt of ctx.sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      const routerArg = extractRouterCall(decl.initializer)
      if (!routerArg) continue
      tagSymbolByName(ctx, decl.name.text, 'trpc_router', null)
      walkProcedures(ctx, routerArg, decl.name.text)
    }
  }
}

/** Returns the first-argument object literal if expr is `X.router({...})`. */
function extractRouterCall(expr: ts.Expression): ts.ObjectLiteralExpression | null {
  if (!ts.isCallExpression(expr)) return null
  if (!ts.isPropertyAccessExpression(expr.expression)) return null
  if (expr.expression.name.text !== 'router') return null
  const arg = expr.arguments[0]
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null
  return arg
}

/** Walk an object literal looking for `<key>: <chain>.query/mutation/subscription(...)` */
function walkProcedures(
  ctx: DetectTrpcFrameworkContext,
  obj: ts.ObjectLiteralExpression,
  routerName: string,
): void {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const key = readPropertyKey(prop.name)
    if (!key) continue
    const role = procedureRole(prop.initializer)
    if (!role) continue
    // Procedures don't exist as top-level SpiSymbols, so synthesize a
    // dedicated entry — same pattern Express slice 1c-ii.e used for
    // inline arrow-function handlers.
    synthesizeProcedureSymbol(ctx, key, role, routerName, prop)
  }
}

/** Returns the matching role iff the expression chain ends in
 *  `.query(...)`, `.mutation(...)`, or `.subscription(...)`. */
function procedureRole(expr: ts.Expression): SpiFrameworkRole | null {
  if (!ts.isCallExpression(expr)) return null
  const callee = expr.expression
  if (!ts.isPropertyAccessExpression(callee)) return null
  return PROCEDURE_METHOD_TO_ROLE.get(callee.name.text) ?? null
}

function synthesizeProcedureSymbol(
  ctx: DetectTrpcFrameworkContext,
  procedureName: string,
  role: SpiFrameworkRole,
  routerName: string,
  prop: ts.PropertyAssignment,
): void {
  const symbols = ctx.symbolsByFile.get(ctx.fileId)
  if (!symbols) return

  // If a top-level symbol with the same name already exists, tag it in
  // place. Otherwise synthesize a new entry.
  const existing = symbols.find((s) => s.name === procedureName && s.framework_role === undefined)
  if (existing) {
    existing.framework_role = role
    existing.framework_metadata = {
      ...(existing.framework_metadata ?? {}),
      procedure_name: procedureName,
      router_name: routerName,
    }
    return
  }

  // Synthesize. Range from the property assignment's location.
  const sourceFile = prop.getSourceFile()
  const start = sourceFile.getLineAndCharacterOfPosition(prop.getStart(sourceFile))
  const end = sourceFile.getLineAndCharacterOfPosition(prop.getEnd())
  const synthetic: SpiSymbol = {
    id: `symbol:${ctx.fileId}/function/${routerName}.${procedureName}.L${start.line + 1}`,
    file_id: ctx.fileId,
    name: `${routerName}.${procedureName}`,
    kind: 'function',
    range: {
      start: { line: start.line + 1, column: start.character + 1 },
      end: { line: end.line + 1, column: end.character + 1 },
    },
    exported: false,
    framework_role: role,
    framework_metadata: {
      procedure_name: procedureName,
      router_name: routerName,
    },
  }
  symbols.push(synthetic)
  // Also push to the global symbols array so the synthesized symbol
  // appears in spi.symbols, not just the per-file lookup map.
  ctx.symbols.push(synthetic)
}

function readPropertyKey(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text
  if (ts.isStringLiteralLike(name)) return name.text
  return null
}

function collectBindings(sourceFile: ts.SourceFile): TrpcBindings {
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (TRPC_MODULE_SPECIFIERS.has(stmt.moduleSpecifier.text)) {
      return { hasTrpcImport: true }
    }
  }
  return { hasTrpcImport: false }
}

function tagSymbolByName(
  ctx: DetectTrpcFrameworkContext,
  name: string,
  role: SpiFrameworkRole,
  metadata: Record<string, unknown> | null,
): void {
  const symbols = ctx.symbolsByFile.get(ctx.fileId)
  if (!symbols) return
  for (const symbol of symbols) {
    if (symbol.name === name && symbol.framework_role === undefined) {
      symbol.framework_role = role
      if (metadata && Object.keys(metadata).length > 0) {
        const merged: Record<string, unknown> = { ...(symbol.framework_metadata ?? {}) }
        for (const [key, value] of Object.entries(metadata)) {
          if (value !== undefined) merged[key] = value
        }
        symbol.framework_metadata = merged
      }
      return
    }
  }
}
