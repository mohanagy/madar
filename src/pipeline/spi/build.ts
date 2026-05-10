// SPI v1 — file-layer builder (slice 1a of #72).
//
// Produces a SemanticProgramIndex containing:
//   - workspace metadata + fingerprint
//   - one SpiFile per supported source file under the workspace root
//   - imports / exports edges between files (syntactic only — no type checker)
//
// Symbols, calls, types, framework, and diff overlay land in subsequent
// slices of #72. This module never touches the existing pipeline; it is
// pure additive substrate.

import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import type {
  SemanticProgramIndex,
  SpiDiagnostic,
  SpiEdge,
  SpiEdgeEvidence,
  SpiFile,
  SpiLanguage,
  SpiRange,
} from './types.js'

export type BuildSpiFileLayerOptions = {
  root: string
  graphifyVersion: string
  extractorVersion?: string
  // Override the wall-clock used in `generated_at`. Test-only escape hatch
  // so snapshot tests can assert deterministic output.
  now?: () => Date
}

const SKIP_DIRS = new Set<string>([
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.git',
  'graphify-out',
  '.test-artifacts',
  '.turbo',
  '.vercel',
])

const EXT_TO_LANG: Record<string, SpiLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
}

const RESOLUTION_CANDIDATE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx'] as const
const INDEX_RESOLUTION_CANDIDATES = [
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
] as const

export function buildSpiFileLayer(opts: BuildSpiFileLayerOptions): SemanticProgramIndex {
  const root = resolve(opts.root)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`SPI build: workspace root not found or not a directory: ${root}`)
  }
  const extractorVersion = opts.extractorVersion ?? 'spi-v1.0.0-slice-1a'
  const now = opts.now ?? (() => new Date())

  const files: SpiFile[] = []
  const edges: SpiEdge[] = []
  const diagnostics: SpiDiagnostic[] = []

  const absPaths: string[] = []
  collectFiles(root, absPaths)

  const pathToFileId = new Map<string, string>()
  for (const abs of absPaths) {
    const ext = extname(abs).toLowerCase()
    const language = EXT_TO_LANG[ext]
    if (!language) continue
    const rel = toPosix(relative(root, abs))
    const content = readFileSync(abs, 'utf8')
    const fileId = makeFileId(rel)
    pathToFileId.set(abs, fileId)
    files.push({
      id: fileId,
      path: rel,
      language,
      loc: countLines(content),
      hash: sha256(content),
    })
  }

  for (const file of files) {
    const abs = join(root, file.path)
    const content = readFileSync(abs, 'utf8')
    const sourceFile = ts.createSourceFile(
      file.path,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(file.language),
    )
    visitFile(sourceFile, file, root, pathToFileId, edges, diagnostics)
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  edges.sort((a, b) =>
    `${a.from}|${a.to}|${a.kind}`.localeCompare(`${b.from}|${b.to}|${b.kind}`),
  )
  diagnostics.sort((a, b) => a.id.localeCompare(b.id))

  return {
    version: 1,
    generated_at: now().toISOString(),
    workspace: {
      root,
      fingerprint: workspaceFingerprint(root, extractorVersion),
      extractor_version: extractorVersion,
      graphify_version: opts.graphifyVersion,
    },
    files,
    symbols: [],
    edges,
    diagnostics,
  }
}

function collectFiles(dir: string, out: string[]): void {
  let entries: import('node:fs').Dirent<string>[]
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectFiles(full, out)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
}

function visitFile(
  sourceFile: ts.SourceFile,
  file: SpiFile,
  root: string,
  pathToFileId: Map<string, string>,
  edges: SpiEdge[],
  diagnostics: SpiDiagnostic[],
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const moduleSpec = node.moduleSpecifier
      if (ts.isStringLiteral(moduleSpec)) {
        const isTypeOnly = node.importClause?.isTypeOnly ?? false
        addImportEdge(moduleSpec.text, isTypeOnly, node, sourceFile, file, root, pathToFileId, edges, diagnostics)
      }
    } else if (ts.isExportDeclaration(node)) {
      addExportEdge(node, sourceFile, file, edges)
      const moduleSpec = node.moduleSpecifier
      if (moduleSpec && ts.isStringLiteral(moduleSpec)) {
        const isTypeOnly = node.isTypeOnly
        addImportEdge(moduleSpec.text, isTypeOnly, node, sourceFile, file, root, pathToFileId, edges, diagnostics)
      }
    } else if (ts.isExportAssignment(node)) {
      addExportEdge(node, sourceFile, file, edges)
    } else if (
      // export const | export function | export class etc.
      hasExportModifier(node) &&
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isVariableStatement(node))
    ) {
      addExportEdge(node, sourceFile, file, edges)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function addImportEdge(
  spec: string,
  isTypeOnly: boolean,
  node: ts.Node,
  sourceFile: ts.SourceFile,
  file: SpiFile,
  root: string,
  pathToFileId: Map<string, string>,
  edges: SpiEdge[],
  diagnostics: SpiDiagnostic[],
): void {
  const evidence: SpiEdgeEvidence = { file_id: file.id, range: rangeOf(node, sourceFile) }
  // Bare module specifiers are external — skip silently for v1.
  if (!spec.startsWith('.') && !spec.startsWith('/')) return

  const targetFileId = resolveRelativeImport(spec, file.path, root, pathToFileId)
  if (targetFileId) {
    edges.push({
      from: file.id,
      to: targetFileId,
      kind: 'imports',
      confidence: isTypeOnly ? 'low' : 'high',
      source: 'typescript-syntactic',
      evidence,
    })
    return
  }
  edges.push({
    from: file.id,
    to: 'file:unresolved/' + spec,
    kind: 'imports',
    confidence: 'medium',
    source: 'typescript-syntactic',
    evidence,
  })
  diagnostics.push({
    id: 'spi.import.unresolved.' + sha256(file.id + ':' + spec).slice(0, 12),
    level: 'info',
    message: `Unresolved relative import "${spec}" from ${file.path}`,
    evidence,
  })
}

function addExportEdge(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  file: SpiFile,
  edges: SpiEdge[],
): void {
  // File-layer export edge: file -> file (self). Symbol-level exports land in
  // slice 1b once SpiSymbols exist.
  edges.push({
    from: file.id,
    to: file.id,
    kind: 'exports',
    confidence: 'high',
    source: 'typescript-syntactic',
    evidence: { file_id: file.id, range: rangeOf(node, sourceFile) },
  })
}

function hasExportModifier(node: ts.Node): boolean {
  // ts.canHaveModifiers / ts.getModifiers on the public ts namespace.
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  if (!modifiers) return false
  for (const mod of modifiers) {
    if (mod.kind === ts.SyntaxKind.ExportKeyword) return true
  }
  return false
}

function resolveRelativeImport(
  spec: string,
  fromPath: string,
  root: string,
  pathToFileId: Map<string, string>,
): string | null {
  const fromAbs = resolve(root, fromPath)
  const fromDir = dirname(fromAbs)
  const variants = expandJsToTsVariants(spec)

  for (const variant of variants) {
    for (const ext of RESOLUTION_CANDIDATE_EXTS) {
      const id = pathToFileId.get(resolve(fromDir, variant + ext))
      if (id) return id
    }
    for (const tail of INDEX_RESOLUTION_CANDIDATES) {
      const id = pathToFileId.get(resolve(fromDir, variant + tail))
      if (id) return id
    }
  }
  return null
}

// Node ESM with TypeScript convention: relative imports keep the `.js` suffix
// at write time but resolve to the matching `.ts`/`.tsx` source. Translate so
// the file-layer resolver matches what the type checker would.
function expandJsToTsVariants(spec: string): string[] {
  if (spec.endsWith('.js')) {
    const base = spec.slice(0, -3)
    return [spec, base, base + '.ts', base + '.tsx']
  }
  if (spec.endsWith('.jsx')) {
    const base = spec.slice(0, -4)
    return [spec, base, base + '.tsx', base + '.ts']
  }
  return [spec]
}

function rangeOf(node: ts.Node, sourceFile: ts.SourceFile): SpiRange {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd())
  return {
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  }
}

function makeFileId(relPath: string): string {
  return 'file:' + sha256(relPath).slice(0, 16)
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function countLines(text: string): number {
  if (text.length === 0) return 0
  let count = 1
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1
  }
  return count
}

function scriptKindFor(language: SpiLanguage): ts.ScriptKind {
  switch (language) {
    case 'typescript':
      return ts.ScriptKind.TS
    case 'tsx':
      return ts.ScriptKind.TSX
    case 'javascript':
      return ts.ScriptKind.JS
    case 'jsx':
      return ts.ScriptKind.JSX
    default:
      return ts.ScriptKind.Unknown
  }
}

function workspaceFingerprint(root: string, extractorVersion: string): string {
  const tsConfigPath = join(root, 'tsconfig.json')
  let tsConfigContent = ''
  if (existsSync(tsConfigPath)) {
    try {
      tsConfigContent = readFileSync(tsConfigPath, 'utf8')
    } catch {
      // Best-effort fingerprint; missing or unreadable tsconfig is acceptable.
    }
  }
  return sha256(`${root}|${tsConfigContent}|${extractorVersion}`).slice(0, 16)
}

function toPosix(p: string): string {
  return p.split('\\').join('/')
}
