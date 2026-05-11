// SPI v1 — Prisma framework layer (v0.17 #83).
//
// Prisma's main schema lives in `schema.prisma` (a Prisma-specific DSL),
// not TypeScript. The TypeScript surface is the generated client:
//
//   import { PrismaClient } from '@prisma/client'
//   const prisma = new PrismaClient()
//   await prisma.user.findMany()      // model access pattern
//   await prisma.user.create({...})
//
// Detection scope (intentionally narrow for this initial slice):
//
//   * `new PrismaClient()` instantiation → variable tagged `prisma_client`
//
// Out of scope (deferred):
//   * Model-access tagging (`prisma.user.findMany`) — would require
//     visiting every property-access chain in the workspace; substantial
//     and noisy. Would need careful per-symbol attribution.
//   * schema.prisma parsing — Prisma DSL isn't TypeScript; a real schema
//     substrate is its own slice train.
//   * Custom-named client imports / re-exports — covered for the most
//     common `import { PrismaClient } from '@prisma/client'` pattern.

import ts from 'typescript'

import type { SpiFrameworkRole, SpiSymbol } from './types.js'

const PRISMA_MODULE_SPECIFIERS: ReadonlySet<string> = new Set([
  '@prisma/client',
])

export type DetectPrismaFrameworkContext = {
  sourceFile: ts.SourceFile
  fileId: string
  symbolsByFile: Map<string, SpiSymbol[]>
}

interface PrismaBindings {
  hasPrismaImport: boolean
  /** Local names that refer to PrismaClient class. */
  prismaClassNames: Set<string>
}

export function detectPrismaFramework(ctx: DetectPrismaFrameworkContext): void {
  const bindings = collectBindings(ctx.sourceFile)
  if (!bindings.hasPrismaImport || bindings.prismaClassNames.size === 0) return

  // Find `const prisma = new PrismaClient()` patterns and tag the binding.
  for (const stmt of ctx.sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      if (!ts.isNewExpression(decl.initializer)) continue
      if (!ts.isIdentifier(decl.initializer.expression)) continue
      if (!bindings.prismaClassNames.has(decl.initializer.expression.text)) continue
      tagSymbolByName(ctx, decl.name.text, 'prisma_client', null)
    }
  }
}

function collectBindings(sourceFile: ts.SourceFile): PrismaBindings {
  const bindings: PrismaBindings = {
    hasPrismaImport: false,
    prismaClassNames: new Set<string>(),
  }
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (!PRISMA_MODULE_SPECIFIERS.has(stmt.moduleSpecifier.text)) continue
    bindings.hasPrismaImport = true
    const named = stmt.importClause.namedBindings
    if (!named || !ts.isNamedImports(named)) continue
    for (const element of named.elements) {
      const importedName = element.propertyName?.text ?? element.name.text
      if (importedName === 'PrismaClient') {
        bindings.prismaClassNames.add(element.name.text)
      }
    }
  }
  return bindings
}

function tagSymbolByName(
  ctx: DetectPrismaFrameworkContext,
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
