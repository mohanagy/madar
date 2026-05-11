// SPI v1 — file + symbol + call + type + test + framework layer builder
// (slices 1a + 1b + 2a + 2b + 3a + 3c + 3b of #72; the diff overlay is
// surfaced separately via diff-overlay.ts).
//
// Produces a SemanticProgramIndex containing:
//   - workspace metadata + fingerprint
//   - one SpiFile per supported source file under the workspace root
//   - imports / exports edges between files (syntactic only — no type checker)
//   - one SpiSymbol per declared function/class/interface/type/enum/method/
//     constant/variable/namespace in each file
//   - declares edges (file -> symbol) for every emitted symbol
//   - calls edges (caller symbol -> callee symbol), resolved via the
//     TypeScript type checker. High-confidence when the resolution is
//     unique; medium when the callee identifier has sibling overload
//     declarations.
//   - type edges via the same type checker pass:
//       * extends   (class -> class, interface -> interface)
//       * implements (class -> interface)
//       * param_type  (function/method -> type/interface/class)
//       * return_type (function/method -> type/interface/class)
//     All emitted at high confidence; skipped silently for builtins
//     (string, number, etc.), inline object types, generic parameters,
//     and unions/intersections that don't map to a single declaration.
//   - covered_by edges (heuristic test layer, slice 3c) from source files
//     to test files that import them.
//   - NestJS framework edges:
//       * Slice 3b base: module_imports/provides/exports, controller_route,
//         plus framework_role tagging on detected module/controller/provider
//         classes and route methods.
//       * Slice 3b-ii: guards / pipes / intercepts edges from
//         @UseGuards / @UsePipes / @UseInterceptors at class or method
//         level; injects edges from constructor parameter types and from
//         @Inject('TOKEN') decorators (resolved through a workspace-wide
//         token map built from `useClass` / `useExisting` provider
//         bindings); low-confidence module_imports edges for dynamic
//         module shapes (`Module.forRoot(...)` / `forRootAsync(...)` /
//         register variants) with an info-level diagnostic recording
//         that the runtime providers list could not be enumerated.
//
// This module never touches the existing pipeline; it is pure additive
// substrate.

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
import { addTestLayerEdges } from './test-layer.js'
import { collectNestTokenMap, detectNestFramework } from './framework-nestjs.js'
import { detectExpressFramework, finalizeExpressMountPrefixes } from './framework-express.js'
import { detectNextjsFramework } from './framework-nextjs.js'
import { detectReactRouterFramework } from './framework-react-router.js'
import { detectReduxFramework } from './framework-redux.js'
import { detectHonoFramework } from './framework-hono.js'
import { detectFastifyFramework } from './framework-fastify.js'
import { detectTrpcFramework } from './framework-trpc.js'
import { detectPrismaFramework } from './framework-prisma.js'

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
  const extractorVersion = opts.extractorVersion ?? 'spi-v1.0.0-slice-3b-ii'
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
    // Always store keys as forward-slash absolute paths. TypeScript normalizes
    // sourceFile.fileName to forward slashes on every OS, and so does the
    // program.getSourceFile() lookup, so the map must match that convention.
    pathToFileId.set(toPosix(abs), fileId)
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

  // Slices 2a + 2b: a second pass uses ts.Program + the type checker to
  // emit calls / extends / implements / param_type / return_type edges.
  addTypeCheckerEdges({ files, root, pathToFileId, symbols, edges, diagnostics })

  // Slice 3c: heuristic test layer. Walks the imports edges produced above
  // to emit covered_by edges from source files to the test files that
  // import them. No type-checker dependency.
  addTestLayerEdges({ files, edges })

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
      const id = pathToFileId.get(toPosix(resolve(fromDir, variant + ext)))
      if (id) return id
    }
    for (const tail of INDEX_RESOLUTION_CANDIDATES) {
      const id = pathToFileId.get(toPosix(resolve(fromDir, variant + tail)))
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

// ─────────────────────────────────────────────────────────────────────────────
// Type-checker pass: call layer (slice 2a) + type layer (slice 2b)
// ─────────────────────────────────────────────────────────────────────────────

type TypeCheckerEdgeContext = {
  files: SpiFile[]
  root: string
  pathToFileId: Map<string, string>
  symbols: SpiSymbol[]
  edges: SpiEdge[]
  diagnostics: SpiDiagnostic[]
}

function addTypeCheckerEdges(ctx: TypeCheckerEdgeContext): void {
  const { files, root, pathToFileId, symbols, edges, diagnostics } = ctx
  const rootNames = files.map((f) => toPosix(join(root, f.path)))
  if (rootNames.length === 0) return

  const compilerOptions = loadCompilerOptions(root)
  let program: ts.Program
  try {
    program = ts.createProgram({ rootNames, options: compilerOptions })
  } catch (err) {
    // ts.createProgram can throw on misconfigured workspaces (e.g., circular
    // path mappings). Record a diagnostic so the failure is visible without
    // tanking the rest of the index.
    diagnostics.push({
      id: 'spi.call.program-create-failed',
      level: 'warn',
      message: `SPI call+type layer skipped: ts.createProgram threw (${(err as Error).message})`,
    })
    return
  }
  const checker = program.getTypeChecker()
  const seenCalls = new Set<string>()
  const seenTypeEdges = new Set<string>()

  // Pre-index symbols by file so the framework pass can tag framework_role
  // in O(symbols-in-this-file) instead of scanning the whole symbol list per
  // class.
  const symbolsByFile = new Map<string, SpiSymbol[]>()
  for (const sym of symbols) {
    const list = symbolsByFile.get(sym.file_id)
    if (list) list.push(sym)
    else symbolsByFile.set(sym.file_id, [sym])
  }

  // Workspace-level NestJS token-binding pass (slice 3b-ii). Walked once
  // before the per-file framework detection so @Inject('TOKEN') in any
  // file can resolve against any module's `useClass` / `useExisting`
  // bindings regardless of file order.
  const programSourceFiles = files
    .map((f) => program.getSourceFile(toPosix(join(root, f.path))))
    .filter((sf): sf is ts.SourceFile => sf !== undefined)
  const tokenMap = collectNestTokenMap({
    sourceFiles: programSourceFiles,
    pathToFileId,
    checker,
  })

  for (const file of files) {
    const abs = toPosix(join(root, file.path))
    const sourceFile = program.getSourceFile(abs)
    if (!sourceFile) continue
    walkCallExpressions(sourceFile, file.id, checker, pathToFileId, edges, seenCalls)
    walkTypeReferences(sourceFile, file.id, checker, pathToFileId, edges, seenTypeEdges)
    detectNestFramework({
      sourceFile,
      fileId: file.id,
      symbolsByFile,
      edges,
      diagnostics,
      pathToFileId,
      checker,
      tokenMap,
    })
    // Slice 1c-ii.b + 1c-ii.c: Express detector. Tags app/router factory
    // variables (1c-ii.b) and named-handler route registrations (1c-ii.c)
    // emitting route_handler edges from binding→handler. Middleware and
    // synthetic route nodes land in 1c-ii.d and 1c-ii.e respectively.
    // The checker is passed through for declaration-identity resolution
    // so lexical shadows don't produce false-positive route tags.
    // pathToFileId unlocks slice 1c-ii.h's cross-file mount resolution
    // (imported routers mounted via app.use('/prefix', importedRouter)).
    detectExpressFramework({
      sourceFile,
      fileId: file.id,
      symbolsByFile,
      symbols,
      edges,
      checker,
      pathToFileId,
    })
    // Slice 1c-iv.a: convention-based Next.js detector. Tags exported
    // symbols in app/.../page.tsx, app/.../route.ts, pages/api/...,
    // pages/..., and root middleware.ts with the matching nextjs_*
    // framework_role.
    detectNextjsFramework({
      sourceFile,
      fileId: file.id,
      filePath: file.path,
      symbolsByFile,
    })
    // Slice 1c-v.a: React Router substrate. Tags createBrowserRouter
    // results and named loader/action exports in files importing
    // react-router(-dom).
    detectReactRouterFramework({
      sourceFile,
      fileId: file.id,
      symbolsByFile,
    })
    // Slice 1c-vi.a: Redux Toolkit substrate. Tags createSlice /
    // configureStore / createSelector / createAsyncThunk / createApi
    // factory results in files importing from a Redux module.
    detectReduxFramework({
      sourceFile,
      fileId: file.id,
      symbolsByFile,
    })
    // v0.17 (#83): Hono substrate. Tags `new Hono()` apps, http-method
    // route registrations, and `app.use(...)` middleware.
    detectHonoFramework({
      sourceFile,
      fileId: file.id,
      symbolsByFile,
    })
    // v0.17 (#83): Fastify substrate. Tags `Fastify()` apps, route
    // registrations, and `app.register(plugin)` plugin registrations.
    detectFastifyFramework({
      sourceFile,
      fileId: file.id,
      symbolsByFile,
    })
    // v0.17 (#83): tRPC substrate. Tags `t.router({...})` results and
    // synthesizes procedure entries for `.query` / `.mutation` /
    // `.subscription` properties. Needs the global symbols array
    // because procedure synthesis appends new entries.
    detectTrpcFramework({
      sourceFile,
      fileId: file.id,
      symbolsByFile,
      symbols,
    })
    // v0.17 (#83): Prisma substrate. Tags `new PrismaClient()` bindings.
    detectPrismaFramework({
      sourceFile,
      fileId: file.id,
      symbolsByFile,
    })
  }

  // Slice 1c-ii.g — workspace-level finalizer that applies mounted-router
  // prefixes to route handlers. Runs once after every per-file detector
  // has had a chance to record the necessary metadata (each router's
  // mount_path + each route handler's route_path). Works cross-file
  // because the per-router symbol is mutated regardless of which file
  // detected the mount call.
  finalizeExpressMountPrefixes({ symbols, edges })
}

function walkCallExpressions(
  sourceFile: ts.SourceFile,
  fileId: string,
  checker: ts.TypeChecker,
  pathToFileId: Map<string, string>,
  edges: SpiEdge[],
  seen: Set<string>,
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callerId = findEnclosingSpiSymbolId(node, fileId)
      if (callerId) {
        const callee = resolveCallee(node, checker, pathToFileId)
        if (callee && callee.id !== callerId) {
          const dedupeKey = `${callerId}|${callee.id}`
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey)
            edges.push({
              from: callerId,
              to: callee.id,
              kind: 'calls',
              confidence: callee.confidence,
              source: 'typescript-semantic',
              evidence: { file_id: fileId, range: rangeOf(node, sourceFile) },
            })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function findEnclosingSpiSymbolId(callExpr: ts.CallExpression, fileId: string): string | null {
  let current: ts.Node | undefined = callExpr.parent
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return makeSymbolId(fileId, 'function', current.name.text)
    }
    if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) {
      const cls = current.parent
      if (ts.isClassDeclaration(cls) && cls.name) {
        return makeSymbolId(fileId, 'method', `${cls.name.text}.${current.name.text}`)
      }
    }
    if (ts.isConstructorDeclaration(current)) {
      const cls = current.parent
      if (ts.isClassDeclaration(cls) && cls.name) {
        return makeSymbolId(fileId, 'method', `${cls.name.text}.constructor`)
      }
    }
    if (
      (ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) &&
      current.name &&
      ts.isIdentifier(current.name)
    ) {
      const cls = current.parent
      if (ts.isClassDeclaration(cls) && cls.name) {
        return makeSymbolId(fileId, 'method', `${cls.name.text}.${current.name.text}`)
      }
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      const list = current.parent
      const stmt = list.parent
      // Only top-level variable statements have a SpiSymbol in v1 — local
      // variables inside another function aren't emitted, so keep walking up
      // past them until we find an enclosing function/method/class.
      if (ts.isVariableStatement(stmt) && ts.isSourceFile(stmt.parent)) {
        const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0
        const kind: SpiSymbolKind = isConst ? 'constant' : 'variable'
        return makeSymbolId(fileId, kind, current.name.text)
      }
    }
    current = current.parent
  }
  return null
}

function resolveCallee(
  callExpr: ts.CallExpression,
  checker: ts.TypeChecker,
  pathToFileId: Map<string, string>,
): { id: string; confidence: 'high' | 'medium' | 'low' } | null {
  const signature = checker.getResolvedSignature(callExpr)
  if (!signature) return null
  const decl = signature.getDeclaration() as ts.Declaration | undefined
  if (!decl) return null

  const sourceFile = decl.getSourceFile()
  if (sourceFile.isDeclarationFile) return null
  const targetFileId = pathToFileId.get(sourceFile.fileName)
  if (!targetFileId) return null

  const id = lookupSpiSymbolForDeclaration(decl, targetFileId)
  if (!id) return null

  // Confidence: medium when the callee identifier has multiple declarations
  // (overloads, ambient + impl), high otherwise.
  const exprSymbol = checker.getSymbolAtLocation(callExpr.expression)
    ?? (callExpr.expression.kind === ts.SyntaxKind.PropertyAccessExpression
      ? checker.getSymbolAtLocation((callExpr.expression as ts.PropertyAccessExpression).name)
      : undefined)
  const overloadCount = exprSymbol?.declarations?.length ?? 1
  const confidence: 'high' | 'medium' = overloadCount > 1 ? 'medium' : 'high'
  return { id, confidence }
}

function lookupSpiSymbolForDeclaration(decl: ts.Declaration, fileId: string): string | null {
  if (ts.isFunctionDeclaration(decl) && decl.name) {
    return makeSymbolId(fileId, 'function', decl.name.text)
  }
  if (ts.isMethodDeclaration(decl) && decl.name && ts.isIdentifier(decl.name)) {
    const cls = decl.parent
    if (ts.isClassDeclaration(cls) && cls.name) {
      return makeSymbolId(fileId, 'method', `${cls.name.text}.${decl.name.text}`)
    }
  }
  if (ts.isConstructorDeclaration(decl)) {
    const cls = decl.parent
    if (ts.isClassDeclaration(cls) && cls.name) {
      return makeSymbolId(fileId, 'method', `${cls.name.text}.constructor`)
    }
  }
  if (
    (ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl)) &&
    decl.name &&
    ts.isIdentifier(decl.name)
  ) {
    const cls = decl.parent
    if (ts.isClassDeclaration(cls) && cls.name) {
      return makeSymbolId(fileId, 'method', `${cls.name.text}.${decl.name.text}`)
    }
  }
  if (ts.isFunctionExpression(decl) || ts.isArrowFunction(decl)) {
    const vd = decl.parent
    if (ts.isVariableDeclaration(vd) && ts.isIdentifier(vd.name)) {
      const stmt = vd.parent.parent
      if (ts.isVariableStatement(stmt)) {
        const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0
        const kind: SpiSymbolKind = isConst ? 'constant' : 'variable'
        return makeSymbolId(fileId, kind, vd.name.text)
      }
    }
  }
  return null
}

function loadCompilerOptions(root: string): ts.CompilerOptions {
  const tsConfigPath = join(root, 'tsconfig.json')
  if (existsSync(tsConfigPath)) {
    try {
      const content = readFileSync(tsConfigPath, 'utf8')
      const parsed = ts.parseConfigFileTextToJson(tsConfigPath, content)
      if (parsed.config) {
        const config = ts.parseJsonConfigFileContent(parsed.config, ts.sys, root)
        // Always keep type-check side effects suppressed; we only want the
        // checker for resolution, not diagnostics.
        return { ...config.options, noEmit: true, skipLibCheck: true }
      }
    } catch {
      // Fall through to defaults if the user's tsconfig is malformed; the call
      // layer is best-effort, not a blocker.
    }
  }
  return defaultCompilerOptions()
}

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    noEmit: true,
    skipLibCheck: true,
    strict: false,
    esModuleInterop: true,
    isolatedModules: true,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Type layer (slice 2b): extends / implements / param_type / return_type edges
// ─────────────────────────────────────────────────────────────────────────────

type TypeEdgeKind = 'extends' | 'implements' | 'param_type' | 'return_type'

function walkTypeReferences(
  sourceFile: ts.SourceFile,
  fileId: string,
  checker: ts.TypeChecker,
  pathToFileId: Map<string, string>,
  edges: SpiEdge[],
  seen: Set<string>,
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const fromId = makeSymbolId(fileId, 'class', node.name.text)
      visitHeritageClauses(node.heritageClauses, fromId, sourceFile, fileId, checker, pathToFileId, edges, seen)
    } else if (ts.isInterfaceDeclaration(node)) {
      const fromId = makeSymbolId(fileId, 'interface', node.name.text)
      visitHeritageClauses(node.heritageClauses, fromId, sourceFile, fileId, checker, pathToFileId, edges, seen)
    }

    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      const fromId = lookupSpiSymbolForDeclaration(node, fileId)
      if (fromId) visitSignatureTypes(node, fromId, sourceFile, fileId, checker, pathToFileId, edges, seen)
    }

    if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && ts.isVariableDeclaration(node.parent)) {
      // Const/let/var holding an arrow function: param/return types attribute
      // to the variable's SpiSymbol.
      const fromId = lookupSpiSymbolForDeclaration(node, fileId)
      if (fromId) visitSignatureTypes(node, fromId, sourceFile, fileId, checker, pathToFileId, edges, seen)
    }

    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function visitHeritageClauses(
  clauses: ts.NodeArray<ts.HeritageClause> | undefined,
  fromId: string,
  sourceFile: ts.SourceFile,
  fileId: string,
  checker: ts.TypeChecker,
  pathToFileId: Map<string, string>,
  edges: SpiEdge[],
  seen: Set<string>,
): void {
  if (!clauses) return
  for (const clause of clauses) {
    const kind: TypeEdgeKind = clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements'
    for (const heritageType of clause.types) {
      // heritageType is ExpressionWithTypeArguments. Its `.expression` is the
      // identifier or property access that names the parent type.
      const symbol = followAlias(checker.getSymbolAtLocation(heritageType.expression), checker)
      emitTypeEdgeFromSymbol(fromId, kind, symbol, heritageType, sourceFile, fileId, pathToFileId, edges, seen)
    }
  }
}

function visitSignatureTypes(
  node: ts.SignatureDeclaration,
  fromId: string,
  sourceFile: ts.SourceFile,
  fileId: string,
  checker: ts.TypeChecker,
  pathToFileId: Map<string, string>,
  edges: SpiEdge[],
  seen: Set<string>,
): void {
  for (const param of node.parameters) {
    if (param.type) {
      const symbol = symbolForTypeNode(param.type, checker)
      emitTypeEdgeFromSymbol(fromId, 'param_type', symbol, param.type, sourceFile, fileId, pathToFileId, edges, seen)
    }
  }
  if (node.type) {
    const symbol = symbolForTypeNode(node.type, checker)
    emitTypeEdgeFromSymbol(fromId, 'return_type', symbol, node.type, sourceFile, fileId, pathToFileId, edges, seen)
  }
}

function symbolForTypeNode(typeNode: ts.TypeNode, checker: ts.TypeChecker): ts.Symbol | undefined {
  // Direct TypeReference: walk to the typeName for the most reliable lookup.
  if (ts.isTypeReferenceNode(typeNode)) {
    return followAlias(checker.getSymbolAtLocation(typeNode.typeName), checker)
  }
  // Other type nodes (object literal types, unions, intersections, builtins)
  // fall back to the resolved type's symbol. Builtins return undefined or a
  // synthetic intrinsic symbol with no usable declarations — naturally
  // skipped downstream.
  return followAlias(checker.getTypeFromTypeNode(typeNode).getSymbol(), checker)
}

// Imported types come back as alias symbols whose own declaration is the
// ImportSpecifier, not the underlying interface/class/type-alias/enum. Walk
// the alias chain so the lookup lands on the real declaration in the
// originating file.
function followAlias(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (!symbol) return undefined
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol
  try {
    return checker.getAliasedSymbol(symbol)
  } catch {
    return undefined
  }
}

function emitTypeEdgeFromSymbol(
  fromId: string,
  kind: TypeEdgeKind,
  symbol: ts.Symbol | undefined,
  evidenceNode: ts.Node,
  sourceFile: ts.SourceFile,
  fileId: string,
  pathToFileId: Map<string, string>,
  edges: SpiEdge[],
  seen: Set<string>,
): void {
  if (!symbol) return
  const decl = symbol.declarations?.[0]
  if (!decl) return
  const declSourceFile = decl.getSourceFile()
  if (declSourceFile.isDeclarationFile) return
  const targetFileId = pathToFileId.get(declSourceFile.fileName)
  if (!targetFileId) return

  const toId = lookupTypeReferenceSymbolId(decl, targetFileId)
  if (!toId) return
  if (toId === fromId) return // skip self-references

  const dedupeKey = `${fromId}|${toId}|${kind}`
  if (seen.has(dedupeKey)) return
  seen.add(dedupeKey)

  edges.push({
    from: fromId,
    to: toId,
    kind,
    confidence: 'high',
    source: 'typescript-semantic',
    evidence: { file_id: fileId, range: rangeOf(evidenceNode, sourceFile) },
  })
}

// Type-side counterpart to lookupSpiSymbolForDeclaration: maps
// class/interface/type-alias/enum declarations onto their SpiSymbol id.
function lookupTypeReferenceSymbolId(decl: ts.Declaration, fileId: string): string | null {
  if (ts.isClassDeclaration(decl) && decl.name) {
    return makeSymbolId(fileId, 'class', decl.name.text)
  }
  if (ts.isInterfaceDeclaration(decl)) {
    return makeSymbolId(fileId, 'interface', decl.name.text)
  }
  if (ts.isTypeAliasDeclaration(decl)) {
    return makeSymbolId(fileId, 'type-alias', decl.name.text)
  }
  if (ts.isEnumDeclaration(decl)) {
    return makeSymbolId(fileId, 'enum', decl.name.text)
  }
  return null
}
