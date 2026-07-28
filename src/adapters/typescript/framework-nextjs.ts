
import ts from 'typescript'

import type {
  IndexFrameworkMetadata,
  IndexFrameworkRole,
  IndexRuntimeBoundary,
  IndexSymbol,
} from '../../domain/index/model.js'

const APP_FILE_CONVENTIONS: ReadonlyMap<string, IndexFrameworkRole> = new Map([
  ['page', 'nextjs_app_page'],
  ['layout', 'nextjs_app_layout'],
  ['loading', 'nextjs_app_loading'],
  ['error', 'nextjs_app_error'],
  ['template', 'nextjs_app_template'],
])

const ROUTE_HTTP_NAMES: ReadonlySet<string> = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD',
])

type NextjsConventionMatch =
  | { kind: 'default'; role: IndexFrameworkRole; routePath: string }
  | { kind: 'http_methods'; role: IndexFrameworkRole; routePath: string }

export type DetectNextjsFrameworkContext = {
  sourceFile: ts.SourceFile
  fileId: string
  /** Workspace-relative POSIX-normalized file path (the IndexFile.path). */
  filePath: string
  symbolsByFile: Map<string, IndexSymbol[]>
}

export function detectNextjsFramework(ctx: DetectNextjsFrameworkContext): void {
  const match = matchConvention(ctx.filePath)

  if (match) {
    if (match.kind === 'default') {
      const metadata: IndexFrameworkMetadata = { route_path: match.routePath }
      if (isAppDirectoryFile(ctx.filePath)) {
        metadata.runtime_boundary = sourceFileBoundary(ctx.sourceFile) ?? 'server'
      }
      tagDefaultExport(ctx, match.role, metadata)
    } else {
      tagHttpMethodExports(ctx, match.role, match.routePath)
    }
  }

  if (isAppDirectoryFile(ctx.filePath)) {
    tagStaticAppBoundaryExports(ctx)
  }
}

function matchConvention(filePath: string): NextjsConventionMatch | null {
  const normalized = normalizeNextjsConventionPath(filePath)

  if (normalized === 'middleware.ts' || normalized === 'middleware.tsx') {
    return { kind: 'default', role: 'nextjs_middleware', routePath: '/*' }
  }

  if (normalized.startsWith('app/')) {
    const basename = stripExtension(getBasename(normalized))
    if (basename === 'route') {
      return { kind: 'http_methods', role: 'nextjs_app_route', routePath: appRoutePath(normalized) }
    }
    const role = APP_FILE_CONVENTIONS.get(basename)
    if (role) return { kind: 'default', role, routePath: appRoutePath(normalized) }
    return null
  }

  if (normalized.startsWith('pages/')) {
    if (normalized.startsWith('pages/api/')) {
      return { kind: 'default', role: 'nextjs_pages_api', routePath: pagesRoutePath(normalized) }
    }
    const basename = stripExtension(getBasename(normalized))
    if (basename.startsWith('_')) return null
    return { kind: 'default', role: 'nextjs_pages_page', routePath: pagesRoutePath(normalized) }
  }

  return null
}

/** Derive a URL path from a Next.js app-router file path. The file's
 *  basename (`page`, `layout`, `route`, etc.) is stripped because in the
 *  app router the URL is determined by the *directory* containing the
 *  convention file, not the file name. */
function appRoutePath(normalized: string): string {
  const withoutPrefix = normalized.slice('app/'.length)
  const segments = withoutPrefix.split('/').slice(0, -1)
  return segmentsToRoutePath(segments)
}

/** Derive a URL path from a Next.js pages-router file path. Both regular
 *  pages and pages/api use the basename (minus extension) as the trailing
 *  segment — except `index`, which collapses to the parent directory. */
function pagesRoutePath(normalized: string): string {
  const withoutPrefix = normalized.slice('pages/'.length)
  const parts = withoutPrefix.split('/')
  const last = parts[parts.length - 1] ?? ''
  const lastStem = stripExtension(last)
  const allSegments = parts.slice(0, -1)
  if (lastStem !== 'index') allSegments.push(lastStem)
  return segmentsToRoutePath(allSegments)
}

/** Normalise the list of route segments into a leading-`/` URL string.
 *  Applies Next.js' three dynamic-segment transforms:
 *    [foo]      → :foo
 *    [...foo]   → *           (catch-all)
 *    [[...foo]] → *?          (optional catch-all)
 *  Route groups `(group)` and parallel routes `@group` are erased from the
 *  URL — they exist only in the file layout. */
function segmentsToRoutePath(segments: string[]): string {
  const transformed: string[] = []
  for (const raw of segments) {
    if (raw.startsWith('(') && raw.endsWith(')')) continue
    if (raw.startsWith('@')) continue

    const stripped = raw.replace(/^\(\.{1,3}\)/, '')
    transformed.push(normalizeSegment(stripped))
  }
  if (transformed.length === 0) return '/'
  return '/' + transformed.join('/')
}

function normalizeSegment(segment: string): string {
  if (segment.startsWith('[[...') && segment.endsWith(']]')) return '*?'
  if (segment.startsWith('[...') && segment.endsWith(']')) return '*'
  if (segment.startsWith('[') && segment.endsWith(']')) {
    return ':' + segment.slice(1, -1)
  }
  return segment
}

function stripLeadingSrc(filePath: string): string {
  return filePath.startsWith('src/') ? filePath.slice(4) : filePath
}

function isAppDirectoryFile(filePath: string): boolean {
  return normalizeNextjsConventionPath(filePath).startsWith('app/')
}

function normalizeNextjsConventionPath(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/')
  const stripped = stripLeadingSrc(normalized)
  if (
    stripped.startsWith('app/')
    || stripped.startsWith('pages/')
    || stripped === 'middleware.ts'
    || stripped === 'middleware.tsx'
  ) {
    return stripped
  }

  const segments = normalized.split('/').filter(Boolean)
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index] === 'app' || segments[index] === 'pages') {
      return segments.slice(index).join('/')
    }
  }
  const basename = segments.at(-1) ?? ''
  if (basename === 'middleware.ts' || basename === 'middleware.tsx') {
    return basename
  }

  return stripped
}

function getBasename(filePath: string): string {
  const slash = filePath.lastIndexOf('/')
  return slash === -1 ? filePath : filePath.slice(slash + 1)
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? name : name.slice(0, dot)
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

function sourceFileBoundary(sourceFile: ts.SourceFile): IndexRuntimeBoundary | undefined {
  if (hasDirectivePrologue(sourceFile.statements, 'use client')) return 'client'
  if (hasDirectivePrologue(sourceFile.statements, 'use server')) return 'server'
  return undefined
}

function functionBoundary(node: ts.FunctionLikeDeclarationBase): IndexRuntimeBoundary | undefined {
  if (!node.body || !ts.isBlock(node.body)) return undefined
  if (hasDirectivePrologue(node.body.statements, 'use server')) return 'server'
  if (hasDirectivePrologue(node.body.statements, 'use client')) return 'client'
  return undefined
}

function isClientComponent(name: string, node: ts.Node): boolean {
  if (!/^[A-Z]/.test(name)) return false
  let found = false
  const visit = (child: ts.Node): void => {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
      found = true
    } else if (!found) {
      ts.forEachChild(child, visit)
    }
  }
  visit(node)
  return found
}

function serverActionBoundaryForInitializer(
  initializer: ts.Expression,
  fileBoundary: IndexRuntimeBoundary | undefined,
): IndexRuntimeBoundary | undefined {
  if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) {
    return undefined
  }
  return functionBoundary(initializer) ?? (fileBoundary === 'server' ? 'server' : undefined)
}

function tagStaticAppBoundaryExports(ctx: DetectNextjsFrameworkContext): void {
  const fileBoundary = sourceFileBoundary(ctx.sourceFile)

  for (const statement of ctx.sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement)) {
      const boundary = functionBoundary(statement) ?? (fileBoundary === 'server' ? 'server' : undefined)
      if (boundary === 'server') {
        tagSymbolByName(ctx, statement.name.text, 'nextjs_server_action', { runtime_boundary: 'server' })
        continue
      }

      if (fileBoundary === 'client' && isClientComponent(statement.name.text, statement)) {
        tagSymbolByName(ctx, statement.name.text, 'nextjs_client_component', { runtime_boundary: 'client' })
      }
      continue
    }

    if (ts.isClassDeclaration(statement) && statement.name && hasExportModifier(statement)) {
      if (fileBoundary === 'client' && isClientComponent(statement.name.text, statement)) {
        tagSymbolByName(ctx, statement.name.text, 'nextjs_client_component', { runtime_boundary: 'client' })
      }
      continue
    }

    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue

      const boundary = serverActionBoundaryForInitializer(declaration.initializer, fileBoundary)
      if (boundary === 'server') {
        tagSymbolByName(ctx, declaration.name.text, 'nextjs_server_action', { runtime_boundary: 'server' })
        continue
      }

      if (fileBoundary === 'client' && isClientComponent(declaration.name.text, declaration.initializer)) {
        tagSymbolByName(ctx, declaration.name.text, 'nextjs_client_component', { runtime_boundary: 'client' })
      }
    }
  }
}

function tagDefaultExport(ctx: DetectNextjsFrameworkContext, role: IndexFrameworkRole, metadata: IndexFrameworkMetadata): void {
  const defaultExportName = findDefaultExportName(ctx.sourceFile)
  if (defaultExportName === null) return
  tagSymbolByName(ctx, defaultExportName, role, metadata)
}

function tagHttpMethodExports(ctx: DetectNextjsFrameworkContext, role: IndexFrameworkRole, routePath: string): void {
  for (const stmt of ctx.sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      if (!hasExportModifier(stmt)) continue
      if (!ROUTE_HTTP_NAMES.has(stmt.name.text)) continue
      tagSymbolByName(ctx, stmt.name.text, role, {
        route_path: routePath,
        http_method: stmt.name.text,
      })
      continue
    }

    if (!ts.isVariableStatement(stmt) || !hasExportModifier(stmt)) continue
    for (const declaration of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      if (!ROUTE_HTTP_NAMES.has(declaration.name.text)) continue
      tagSymbolByName(ctx, declaration.name.text, role, {
        route_path: routePath,
        http_method: declaration.name.text,
      })
    }
  }
}

function findDefaultExportName(sourceFile: ts.SourceFile): string | null {
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportDefaultModifiers(stmt)) {
      return stmt.name.text
    }
    if (ts.isClassDeclaration(stmt) && stmt.name && hasExportDefaultModifiers(stmt)) {
      return stmt.name.text
    }
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals && ts.isIdentifier(stmt.expression)) {
      return stmt.expression.text
    }
  }
  return null
}

function hasExportDefaultModifiers(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  if (!modifiers) return false
  let hasExport = false
  let hasDefault = false
  for (const mod of modifiers) {
    if (mod.kind === ts.SyntaxKind.ExportKeyword) hasExport = true
    if (mod.kind === ts.SyntaxKind.DefaultKeyword) hasDefault = true
  }
  return hasExport && hasDefault
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
  ctx: DetectNextjsFrameworkContext,
  name: string,
  role: IndexFrameworkRole,
  metadata: IndexFrameworkMetadata,
): void {
  const symbols = ctx.symbolsByFile.get(ctx.fileId)
  if (!symbols) return
  for (const symbol of symbols) {
    if (symbol.name === name && symbol.framework_role === undefined) {
      symbol.framework_role = role
      symbol.framework_metadata = {
        ...(symbol.framework_metadata ?? {}),
        ...metadata,
      }
      return
    }
  }
}
