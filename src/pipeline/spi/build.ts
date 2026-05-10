// SPI v1 — file + symbol layer builder (slices 1a + 1b of #72).
//
// Produces a SemanticProgramIndex containing:
//   - workspace metadata + fingerprint
//   - one SpiFile per supported source file under the workspace root
//   - imports / exports edges between files (syntactic only — no type checker)
//   - one SpiSymbol per declared function/class/interface/type/enum/method/
//     constant/variable/namespace in each file
//   - declares edges (file -> symbol) for every emitted symbol
//
// Calls, type relationships, tests, framework, and diff overlay land in
// subsequent slices of #72. This module never touches the existing pipeline;
// it is pure additive substrate.

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
  SpiSymbol,
  SpiSymbolKind,
} from './types.js'

export type BuildSpiOptions = {
  root: string
  graphifyVersion: string
  extractorVersion?: string
  // Override the wall-clock used in `generated_at`. Test-only escape hatch
  // so snapshot tests can assert deterministic output.
  now?: () => Date
}

// Backward-compat alias for the slice-1a name. New callers should use
// BuildSpiOptions / buildSpi directly.
export type BuildSpiFileLayerOptions = BuildSpiOptions

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

export function buildSpi(opts: BuildSpiOptions): SemanticProgramIndex {
  const root = resolve(opts.root)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`SPI build: workspace root not found or not a directory: ${root}`)
  }
  const extractorVersion = opts.extractorVersion ?? 'spi-v1.0.0-slice-1b'
  const now = opts.now ?? (() => new Date())

  const files: SpiFile[] = []
  const symbols: SpiSymbol[] = []
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
    visitFile(sourceFile, file, root, pathToFileId, symbols, edges, diagnostics)
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  symbols.sort((a, b) => a.id.localeCompare(b.id))
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
    symbols,
    edges,
    diagnostics,
  }
}

// Backward-compat alias for the slice-1a entry point. New callers should use
// buildSpi directly.
export const buildSpiFileLayer = buildSpi

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
  symbols: SpiSymbol[],
  edges: SpiEdge[],
  diagnostics: SpiDiagnostic[],
): void {
  // Per-(class+method-name) overload counters so duplicate method names in the
  // same class get deterministic #0/#1/... suffixes in source order.
  const methodOverloadCounts = new Map<string, number>()

  const emitTopLevelDeclarations = (parent: ts.Node): void => {
    ts.forEachChild(parent, (node) => {
      const exported = hasExportModifier(node) || hasDefaultModifier(node)

      if (ts.isFunctionDeclaration(node) && node.name) {
        emitSymbol({ name: node.name.text, kind: 'function', node, exported, sourceFile, file, symbols, edges })
      } else if (ts.isClassDeclaration(node) && node.name) {
        emitSymbol({ name: node.name.text, kind: 'class', node, exported, sourceFile, file, symbols, edges })
        emitClassMethods(node, file, symbols, edges, sourceFile, methodOverloadCounts)
      } else if (ts.isInterfaceDeclaration(node)) {
        emitSymbol({ name: node.name.text, kind: 'interface', node, exported, sourceFile, file, symbols, edges })
      } else if (ts.isTypeAliasDeclaration(node)) {
        emitSymbol({ name: node.name.text, kind: 'type-alias', node, exported, sourceFile, file, symbols, edges })
      } else if (ts.isEnumDeclaration(node)) {
        emitSymbol({ name: node.name.text, kind: 'enum', node, exported, sourceFile, file, symbols, edges })
      } else if (ts.isVariableStatement(node)) {
        const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0
        const kind: SpiSymbolKind = isConst ? 'constant' : 'variable'
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            emitSymbol({ name: decl.name.text, kind, node: decl, exported, sourceFile, file, symbols, edges })
          }
          // Destructured declarations (`const { a, b } = ...`) are intentionally
          // skipped in slice 1b: there's no single-source-name to mint a stable
          // ID from. They re-enter when the symbol layer ships destructure
          // tracking in slice 2.
        }
      } else if (ts.isModuleDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        // Namespace declaration (`namespace Foo { ... }` or
        // `module Foo { ... }`). External module augmentations
        // (`declare module 'foo'`) use a string-literal name and are skipped.
        emitSymbol({ name: node.name.text, kind: 'namespace', node, exported, sourceFile, file, symbols, edges })
        // Members of namespaces are deferred: SPI v1 represents the namespace
        // itself but does not enumerate its inner declarations. Slice 2 can
        // expand this once cross-namespace references matter.
      }
    })
  }

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
  emitTopLevelDeclarations(sourceFile)
}

type EmitSymbolArgs = {
  name: string
  kind: SpiSymbolKind
  node: ts.Node
  exported: boolean
  sourceFile: ts.SourceFile
  file: SpiFile
  symbols: SpiSymbol[]
  edges: SpiEdge[]
}

function emitSymbol(args: EmitSymbolArgs): SpiSymbol {
  const { name, kind, node, exported, sourceFile, file, symbols, edges } = args
  const symbol: SpiSymbol = {
    id: makeSymbolId(file.id, kind, name),
    file_id: file.id,
    name,
    kind,
    range: rangeOf(node, sourceFile),
    exported,
  }
  symbols.push(symbol)
  edges.push({
    from: file.id,
    to: symbol.id,
    kind: 'declares',
    confidence: 'high',
    source: 'typescript-syntactic',
    evidence: { file_id: file.id, range: symbol.range },
  })
  return symbol
}

function emitClassMethods(
  classNode: ts.ClassDeclaration,
  file: SpiFile,
  symbols: SpiSymbol[],
  edges: SpiEdge[],
  sourceFile: ts.SourceFile,
  methodOverloadCounts: Map<string, number>,
): void {
  if (!classNode.name) return
  const className = classNode.name.text
  for (const member of classNode.members) {
    let methodName: string | null = null
    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      methodName = member.name.text
    } else if (ts.isConstructorDeclaration(member)) {
      methodName = 'constructor'
    } else if (
      (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
      member.name &&
      ts.isIdentifier(member.name)
    ) {
      methodName = member.name.text
    }
    if (methodName === null) continue

    const overloadKey = `${file.id}/${className}/${methodName}`
    const overloadIndex = methodOverloadCounts.get(overloadKey) ?? 0
    methodOverloadCounts.set(overloadKey, overloadIndex + 1)
    const qualifiedName = `${className}.${methodName}`
    const baseId = makeSymbolId(file.id, 'method', qualifiedName)
    const id = overloadIndex === 0 ? baseId : `${baseId}#${overloadIndex}`

    const symbol: SpiSymbol = {
      id,
      file_id: file.id,
      name: qualifiedName,
      kind: 'method',
      range: rangeOf(member, sourceFile),
      // Methods inherit their containing class's export status for v1; SPI's
      // selector layer can refine this when public-API surface scoring lands.
      exported: hasExportModifier(classNode) || hasDefaultModifier(classNode),
    }
    symbols.push(symbol)
    edges.push({
      from: file.id,
      to: symbol.id,
      kind: 'declares',
      confidence: 'high',
      source: 'typescript-syntactic',
      evidence: { file_id: file.id, range: symbol.range },
    })
  }
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

function hasDefaultModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  if (!modifiers) return false
  for (const mod of modifiers) {
    if (mod.kind === ts.SyntaxKind.DefaultKeyword) return true
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

function makeSymbolId(fileId: string, kind: SpiSymbolKind, name: string): string {
  return `symbol:${fileId}/${kind}/${name}`
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
