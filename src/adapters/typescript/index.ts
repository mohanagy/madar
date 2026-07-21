
import { createHash } from 'node:crypto'
import {
  existsSync,
  realpathSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

import { KnowledgeGraph } from '../../domain/graph/directed-multigraph.js'
import type {
  IndexDiagnostic,
  IndexEdge,
  IndexEdgeEvidence,
  IndexFile,
  IndexFrameworkRole,
  IndexLanguage,
  IndexRange,
  IndexSymbol,
  IndexSymbolKind,
} from '../../domain/index/model.js'
import { createBaselineProvenance } from '../../core/provenance/types.js'
import { collectBullWorkerIndex, collectNestTokenMap, detectNestFramework } from './framework-nestjs.js'
import { detectExpressFramework, finalizeExpressMountPrefixes } from './framework-express.js'
import { detectNextjsFramework } from './framework-nextjs.js'
import { detectReactRouterFramework } from './framework-react-router.js'
import { detectHonoFramework } from './framework-hono.js'
import { detectFastifyFramework } from './framework-fastify.js'
import { detectTrpcFramework } from './framework-trpc.js'
import { detectPrismaFramework } from './framework-prisma.js'

export interface BuildCanonicalTypeScriptIndexOptions {
  root: string
  /** Explicit scanner-owned source paths. The adapter never walks the tree. */
  files: readonly string[]
}

export interface CanonicalTypeScriptIndexResult {
  graph: KnowledgeGraph
  files: IndexFile[]
  diagnostics: IndexDiagnostic[]
}

const EXT_TO_LANG: Record<string, IndexLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
}

export const CANONICAL_TYPESCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(EXT_TO_LANG))

export function isCanonicalTypeScriptSourceFile(filePath: string): boolean {
  return CANONICAL_TYPESCRIPT_EXTENSIONS.has(extname(filePath).toLowerCase())
}

/**
 * Resolve the explicit source set passed by generation. The detector already
 * applies the workspace's safe symlink policy; this preserves those logical
 * paths for INDEX instead of re-walking the tree and silently dropping them.
 */
export function collectCanonicalTypeScriptFiles(rootPath: string, includedFiles: readonly string[]): string[] {
  const root = resolve(rootPath)
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return []
  }

  const files = new Set<string>()
  for (const candidate of includedFiles) {
    const filePath = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate)
    const relativePath = relative(root, filePath)
    if (
      !relativePath
      || relativePath.startsWith(`..${sep}`)
      || relativePath === '..'
      || isAbsolute(relativePath)
      || !isCanonicalTypeScriptSourceFile(filePath)
    ) {
      continue
    }
    try {
      if (!statSync(filePath).isFile()) continue
      const realFilePath = realpathSync(filePath)
      const realRelativePath = relative(realRoot, realFilePath)
      if (
        realRelativePath.startsWith(`..${sep}`)
        || realRelativePath === '..'
        || isAbsolute(realRelativePath)
      ) {
        continue
      }
      files.add(filePath)
    } catch {
    }
  }
  return [...files].sort(compareCodeUnits)
}

const RESOLUTION_CANDIDATE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx'] as const
const INDEX_RESOLUTION_CANDIDATES = [
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
] as const

export function buildCanonicalTypeScriptIndex(opts: BuildCanonicalTypeScriptIndexOptions): CanonicalTypeScriptIndexResult {
  const root = resolve(opts.root)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Canonical TypeScript index root is not a directory: ${root}`)
  }

  const files: IndexFile[] = []
  const symbols: IndexSymbol[] = []
  const symbolById = new Map<string, IndexSymbol>()
  const edges: IndexEdge[] = []
  const diagnostics: IndexDiagnostic[] = []

  const absPaths = collectCanonicalTypeScriptFiles(root, opts.files)

  const pathToFileId = new CanonicalPathMap<string>()
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

  const compiler = createCanonicalProgram(root, files, pathToFileId, diagnostics)
  if (compiler) {
    for (const file of files) {
      const sourceFile = compiler.program.getSourceFile(toPosix(join(root, file.path)))
      if (sourceFile) visitFile(sourceFile, file, root, pathToFileId, compiler.resolveModule, symbols, symbolById, edges, diagnostics)
    }
    addTypeCheckerEdges({ files, root, pathToFileId, symbols, edges, diagnostics, program: compiler.program })
  }

  files.sort((a, b) => compareCodeUnits(a.path, b.path))
  symbols.sort((a, b) => compareCodeUnits(symbolSortKey(a), symbolSortKey(b)))
  edges.sort((a, b) => compareCodeUnits(edgeSortKey(a), edgeSortKey(b)))
  diagnostics.sort((a, b) => compareCodeUnits(diagnosticSortKey(a), diagnosticSortKey(b)))

  return { graph: writeCanonicalGraph(root, files, symbols, edges), files, diagnostics }
}

const confidence = {
  high: { confidence: 'EXTRACTED', confidence_score: 1 },
  medium: { confidence: 'INFERRED', confidence_score: 0.6 },
  low: { confidence: 'AMBIGUOUS', confidence_score: 0.3 },
} as const

function writeCanonicalGraph(
  root: string,
  files: readonly IndexFile[],
  symbols: readonly IndexSymbol[],
  edges: readonly IndexEdge[],
): KnowledgeGraph {
  const graph = new KnowledgeGraph({ root_path: root, schema_version: 1, canonical_typescript_index: true })
  const fileById = new Map(files.map((file) => [file.id, file]))
  const symbolById = new Map(symbols.map((symbol) => [symbol.id, symbol]))

  for (const file of files) {
    graph.addNode(file.id, {
      label: basename(file.path),
      node_kind: 'file',
      file_type: 'code',
      source_file: file.path,
      source_location: 'L1',
      line_number: 1,
      language: file.language,
      loc: file.loc,
      content_hash: file.hash,
      extraction_strategy: 'canonical',
      layer: 'semantic',
      provenance: [provenance(file.path, 'L1')],
    })
  }

  for (const symbol of symbols) {
    const file = fileById.get(symbol.file_id)
    if (!file) continue
    const location = locationOf(symbol.range)
    const metadata = symbol.framework_metadata ?? {}
    graph.addNode(symbol.id, {
      label: symbolLabel(symbol),
      qualified_name: symbol.name,
      node_kind: nodeKind(symbol),
      file_type: 'code',
      source_file: file.path,
      source_location: location,
      line_number: symbol.range.start.line,
      end_line_number: symbol.range.end.line,
      language: file.language,
      exported: symbol.exported,
      extraction_strategy: 'canonical',
      layer: 'semantic',
      ...(symbol.framework_role ? {
        framework: frameworkName(symbol.framework_role),
        framework_role: symbol.framework_role,
      } : {}),
      ...(Object.keys(metadata).length > 0 ? { framework_metadata: metadata, ...metadata } : {}),
      provenance: [provenance(file.path, location)],
    })
  }

  for (const edge of edges) {
    let source = edge.from
    const target = edge.to
    let relation: string = edge.kind
    if (edge.kind === 'declares') {
      const symbol = symbolById.get(target)
      if (!symbol) continue
      if (symbol.kind === 'method') {
        const className = symbol.name.slice(0, symbol.name.lastIndexOf('.'))
        const classId = makeSymbolId(symbol.file_id, 'class', className)
        const parent = graph.hasNode(classId) ? classId : makeSymbolId(symbol.file_id, 'interface', className)
        if (!graph.hasNode(parent)) continue
        source = parent
        relation = 'method'
      } else {
        relation = 'contains'
      }
    } else if (edge.kind === 'imports') {
      relation = 'imports_from'
    } else if (edge.kind === 'reexports') {
      relation = 'reexports_from'
    }
    if (source === target || !graph.hasNode(source) || !graph.hasNode(target)) continue
    const evidenceFile = edge.evidence ? fileById.get(edge.evidence.file_id) : undefined
    const sourceSymbol = symbolById.get(source)
    const sourceFile = evidenceFile?.path
      ?? (sourceSymbol ? fileById.get(sourceSymbol.file_id)?.path : fileById.get(source)?.path)
    if (!sourceFile) continue
    const range = edge.evidence?.range
    const location = range ? locationOf(range) : 'L1'
    const attributes = {
      relation,
      ...confidence[edge.confidence],
      source_file: sourceFile,
      source_location: location,
      layer: 'semantic',
      extraction_strategy: 'canonical',
      evidence: { source: edge.source, ...(range ? { range } : {}) },
      ...(edge.metadata ?? {}),
      provenance: [provenance(sourceFile, location)],
    }
    graph.addEdge(source, target, attributes)
    if (edge.kind === 'declares' && relation === 'method') {
      // Preserve both generic ownership and the more specific member fact.
      // The directed multigraph keeps these as distinct canonical relations.
      graph.addEdge(source, target, { ...attributes, relation: 'contains' })
    }
  }
  return graph
}

function provenance(sourceFile: string, sourceLocation: string) {
  return createBaselineProvenance({
    capabilityId: 'builtin:index:typescript',
    stage: 'index',
    sourceFile,
    sourceLocation,
  })
}

function locationOf(range: IndexRange): string {
  return range.end.line > range.start.line ? `L${range.start.line}-L${range.end.line}` : `L${range.start.line}`
}

function symbolLabel(symbol: IndexSymbol): string {
  if (symbol.framework_metadata?.external_call === true) return symbol.name
  const operation = symbol.framework_metadata?.storage_operation
  if (typeof operation === 'string' && symbol.framework_role?.startsWith('prisma_')) return `.${operation}()`
  if (symbol.kind === 'method') return `.${symbol.name.slice(symbol.name.lastIndexOf('.') + 1)}()`
  return symbol.kind === 'function' ? `${symbol.name}()` : symbol.name
}

function nodeKind(symbol: IndexSymbol): string {
  const role = symbol.framework_role
  if (role?.endsWith('_route') || role?.startsWith('trpc_procedure_') || role === 'nextjs_pages_api') return 'route'
  if (role?.endsWith('_router')) return 'router'
  if (role === 'nextjs_client_component') return 'component'
  if (role?.startsWith('nest_') || role === 'prisma_client') return 'class'
  if (symbol.kind === 'type-alias') return 'type'
  return symbol.kind
}

function frameworkName(role: IndexFrameworkRole): string {
  if (role.startsWith('nest_')) return 'nestjs'
  if (role.startsWith('react_router_')) return 'react-router'
  const prefix = role.split('_')[0]
  return prefix === 'nextjs' ? 'nextjs' : prefix ?? 'unknown'
}

function visitFile(
  sourceFile: ts.SourceFile,
  file: IndexFile,
  root: string,
  pathToFileId: Map<string, string>,
  resolveModule: IndexedModuleResolver,
  symbols: IndexSymbol[],
  symbolById: Map<string, IndexSymbol>,
  edges: IndexEdge[],
  diagnostics: IndexDiagnostic[],
): void {
  const commonJsExportedNames = new Set<string>()
  const localExportAliases = new Map<string, Set<string>>()
  const directCommonJsExports: Array<{ node: ts.FunctionExpression | ts.ArrowFunction | ts.ClassExpression; name: string }> = []

  const exportAliases = (name: string): string[] => [...(localExportAliases.get(name) ?? [])].sort(compareCodeUnits)
  const isExported = (node: ts.Node, name: string): boolean =>
    hasExportModifier(node) || hasDefaultModifier(node) || localExportAliases.has(name)

  const emitTopLevelDeclarations = (parent: ts.Node): void => {
    ts.forEachChild(parent, (node) => {
      if (ts.isFunctionDeclaration(node) && (node.name || hasDefaultModifier(node))) {
        const name = node.name?.text ?? 'default'
        emitSymbol({ name, kind: 'function', node, exported: isExported(node, name), exportAliases: exportAliases(name), sourceFile, file, symbols, symbolById, edges })
      } else if (ts.isClassDeclaration(node) && (node.name || hasDefaultModifier(node))) {
        const name = node.name?.text ?? 'default'
        const exported = isExported(node, name)
        emitSymbol({ name, kind: 'class', node, exported, exportAliases: exportAliases(name), sourceFile, file, symbols, symbolById, edges })
        emitClassMethods(node, name, exported, file, symbols, symbolById, edges, sourceFile)
      } else if (ts.isInterfaceDeclaration(node)) {
        const name = node.name.text
        const exported = isExported(node, name)
        emitSymbol({ name, kind: 'interface', node, exported, exportAliases: exportAliases(name), sourceFile, file, symbols, symbolById, edges })
        emitClassMethods(node, name, exported, file, symbols, symbolById, edges, sourceFile)
      } else if (ts.isTypeAliasDeclaration(node)) {
        const name = node.name.text
        emitSymbol({ name, kind: 'type-alias', node, exported: isExported(node, name), exportAliases: exportAliases(name), sourceFile, file, symbols, symbolById, edges })
      } else if (ts.isEnumDeclaration(node)) {
        const name = node.name.text
        emitSymbol({ name, kind: 'enum', node, exported: isExported(node, name), exportAliases: exportAliases(name), sourceFile, file, symbols, symbolById, edges })
      } else if (ts.isVariableStatement(node)) {
        const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0
        const kind: IndexSymbolKind = isConst ? 'constant' : 'variable'
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const name = decl.name.text
            emitSymbol({ name, kind, node: decl, exported: isExported(node, name), exportAliases: exportAliases(name), sourceFile, file, symbols, symbolById, edges })
          }
        }
      } else if (ts.isModuleDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        const name = node.name.text
        emitSymbol({ name, kind: 'namespace', node, exported: isExported(node, name), exportAliases: exportAliases(name), sourceFile, file, symbols, symbolById, edges })
      }
    })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const moduleSpec = node.moduleSpecifier
      if (ts.isStringLiteral(moduleSpec)) {
        const isTypeOnly = node.importClause?.isTypeOnly ?? false
        addModuleEdge('imports', moduleSpec.text, isTypeOnly, node, sourceFile, file, root, pathToFileId, resolveModule, edges, diagnostics)
      }
    } else if (ts.isExportDeclaration(node)) {
      const moduleSpec = node.moduleSpecifier
      if (moduleSpec && ts.isStringLiteral(moduleSpec)) {
        addModuleEdge('reexports', moduleSpec.text, node.isTypeOnly, node, sourceFile, file, root, pathToFileId, resolveModule, edges, diagnostics)
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const localName = element.propertyName?.text ?? element.name.text
          const aliases = localExportAliases.get(localName) ?? new Set<string>()
          aliases.add(element.name.text)
          localExportAliases.set(localName, aliases)
        }
      }
    } else if (ts.isExportAssignment(node) && !node.isExportEquals && ts.isIdentifier(node.expression)) {
      const aliases = localExportAliases.get(node.expression.text) ?? new Set<string>()
      aliases.add('default')
      localExportAliases.set(node.expression.text, aliases)
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const specifier = node.arguments[0]
      if (specifier && ts.isStringLiteralLike(specifier)) {
        addModuleEdge(isCommonJsReexport(node) ? 'reexports' : 'imports', specifier.text, false, node, sourceFile, file, root, pathToFileId, resolveModule, edges, diagnostics)
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      collectCommonJsExportedNames(node, commonJsExportedNames)
      const directExport = directCommonJsExport(node)
      if (directExport) directCommonJsExports.push(directExport)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  emitTopLevelDeclarations(sourceFile)
  for (const direct of directCommonJsExports) {
    const kind = ts.isClassExpression(direct.node) ? 'class' : 'function'
    emitSymbol({ name: direct.name, kind, node: direct.node, exported: true, sourceFile, file, symbols, symbolById, edges })
    if (ts.isClassExpression(direct.node)) {
      emitClassMethods(direct.node, direct.name, true, file, symbols, symbolById, edges, sourceFile)
    }
  }
  for (const symbol of symbols) {
    if (symbol.file_id === file.id && commonJsExportedNames.has(symbol.name)) symbol.exported = true
  }
}

type EmitSymbolArgs = {
  name: string
  kind: IndexSymbolKind
  node: ts.Node
  exported: boolean
  exportAliases?: readonly string[]
  sourceFile: ts.SourceFile
  file: IndexFile
  symbols: IndexSymbol[]
  symbolById: Map<string, IndexSymbol>
  edges: IndexEdge[]
}

function emitSymbol(args: EmitSymbolArgs): IndexSymbol {
  const { name, kind, node, exported, exportAliases = [], sourceFile, file, symbols, symbolById, edges } = args
  const id = makeSymbolId(file.id, kind, name)
  const existing = symbolById.get(id)
  if (existing) {
    existing.range = mergeRanges(existing.range, rangeOf(node, sourceFile))
    existing.exported ||= exported
    mergeExportAliases(existing, exportAliases)
    const declaration = edges.find((edge) => edge.kind === 'declares' && edge.to === id)
    if (declaration?.evidence) declaration.evidence.range = existing.range
    return existing
  }
  const symbol: IndexSymbol = {
    id,
    file_id: file.id,
    name,
    kind,
    range: rangeOf(node, sourceFile),
    exported,
    ...(exportAliases.length > 0 ? { framework_metadata: { export_aliases: [...exportAliases].sort(compareCodeUnits) } } : {}),
  }
  symbols.push(symbol)
  symbolById.set(symbol.id, symbol)
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
  classNode: ts.ClassLikeDeclaration | ts.InterfaceDeclaration,
  className: string,
  exported: boolean,
  file: IndexFile,
  symbols: IndexSymbol[],
  symbolById: Map<string, IndexSymbol>,
  edges: IndexEdge[],
  sourceFile: ts.SourceFile,
): void {
  for (const member of classNode.members) {
    let methodName: string | null = null
    if ((ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) && member.name && ts.isIdentifier(member.name)) {
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

    const qualifiedName = `${className}.${methodName}`
    emitSymbol({ name: qualifiedName, kind: 'method', node: member, exported, sourceFile, file, symbols, symbolById, edges })
  }
}

type IndexedModuleResolver = (specifier: string, containingFile: string) => string | null

function addModuleEdge(
  kind: Extract<IndexEdge['kind'], 'imports' | 'reexports'>,
  spec: string,
  isTypeOnly: boolean,
  node: ts.Node,
  sourceFile: ts.SourceFile,
  file: IndexFile,
  root: string,
  pathToFileId: Map<string, string>,
  resolveModule: IndexedModuleResolver,
  edges: IndexEdge[],
  diagnostics: IndexDiagnostic[],
): void {
  const evidence: IndexEdgeEvidence = { file_id: file.id, range: rangeOf(node, sourceFile) }
  const targetFileId = resolveModule(spec, resolve(root, file.path))
    ?? resolveRelativeImport(spec, file.path, root, pathToFileId)
  if (targetFileId) {
    edges.push({
      from: file.id,
      to: targetFileId,
      kind,
      confidence: isTypeOnly ? 'low' : 'high',
      source: 'typescript-syntactic',
      evidence,
      metadata: moduleEdgeMetadata(kind, spec, isTypeOnly, node),
    })
    return
  }
  if (!spec.startsWith('.') && !spec.startsWith('/')) return
  edges.push({
    from: file.id,
    to: 'file:unresolved/' + spec,
    kind,
    confidence: 'medium',
    source: 'typescript-syntactic',
    evidence,
    metadata: moduleEdgeMetadata(kind, spec, isTypeOnly, node),
  })
  diagnostics.push({
    id: 'canonical-index.module.unresolved.' + sha256(file.id + ':' + spec).slice(0, 12),
    level: 'info',
    message: `Unresolved module "${spec}" from ${file.path}`,
    evidence,
  })
}

function moduleEdgeMetadata(
  kind: Extract<IndexEdge['kind'], 'imports' | 'reexports'>,
  specifier: string,
  isTypeOnly: boolean,
  node: ts.Node,
): Record<string, unknown> {
  const bindings: string[] = []
  let form = kind === 'imports' ? 'import' : 'reexport'
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause
    if (clause?.name) bindings.push(`default:${clause.name.text}`)
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      bindings.push(`*:${clause.namedBindings.name.text}`)
    } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.push(`${element.propertyName?.text ?? element.name.text}:${element.name.text}`)
      }
    }
  } else if (ts.isExportDeclaration(node)) {
    if (!node.exportClause) form = 'wildcard-reexport'
    else if (ts.isNamespaceExport(node.exportClause)) {
      form = 'namespace-reexport'
      bindings.push(`*:${node.exportClause.name.text}`)
    } else {
      form = 'named-reexport'
      for (const element of node.exportClause.elements) {
        bindings.push(`${element.propertyName?.text ?? element.name.text}:${element.name.text}`)
      }
    }
  } else {
    form = kind === 'reexports' ? 'commonjs-reexport' : 'commonjs-require'
  }
  return {
    module_specifier: specifier,
    module_form: form,
    is_type_only: isTypeOnly,
    ...(bindings.length > 0 ? { module_bindings: bindings.sort() } : {}),
  }
}

function collectCommonJsExportedNames(node: ts.BinaryExpression, names: Set<string>): void {
  const left = node.left
  const isModuleExports = ts.isPropertyAccessExpression(left)
    && ts.isIdentifier(left.expression)
    && left.expression.text === 'module'
    && left.name.text === 'exports'
  const isExportsProperty = ts.isPropertyAccessExpression(left)
    && ((ts.isIdentifier(left.expression) && left.expression.text === 'exports')
      || (ts.isPropertyAccessExpression(left.expression)
        && ts.isIdentifier(left.expression.expression)
        && left.expression.expression.text === 'module'
        && left.expression.name.text === 'exports'))
  if (!isModuleExports && !isExportsProperty) return
  if (ts.isIdentifier(node.right)) names.add(node.right.text)
  if (isModuleExports && ts.isObjectLiteralExpression(node.right)) {
    for (const property of node.right.properties) {
      if (ts.isShorthandPropertyAssignment(property)) names.add(property.name.text)
      else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) {
        names.add(property.initializer.text)
      }
    }
  }
}

function directCommonJsExport(
  node: ts.BinaryExpression,
): { node: ts.FunctionExpression | ts.ArrowFunction | ts.ClassExpression; name: string } | null {
  if (!ts.isExpressionStatement(node.parent)) return null
  const exportName = commonJsExportName(node.left)
  if (!exportName || (!ts.isFunctionExpression(node.right) && !ts.isArrowFunction(node.right) && !ts.isClassExpression(node.right))) return null
  return {
    node: node.right,
    name: exportName === 'default' ? node.right.name?.text ?? exportName : exportName,
  }
}

function commonJsExportName(node: ts.Expression): string | null {
  if (!ts.isPropertyAccessExpression(node)) return null
  if (ts.isIdentifier(node.expression) && node.expression.text === 'exports') return node.name.text
  if (ts.isIdentifier(node.expression) && node.expression.text === 'module' && node.name.text === 'exports') {
    return 'default'
  }
  return ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'module'
    && node.expression.name.text === 'exports'
    ? node.name.text
    : null
}

function mergeExportAliases(symbol: IndexSymbol, aliases: readonly string[]): void {
  if (aliases.length === 0) return
  const prior = Array.isArray(symbol.framework_metadata?.export_aliases)
    ? symbol.framework_metadata.export_aliases.filter((value): value is string => typeof value === 'string')
    : []
  symbol.framework_metadata = {
    ...(symbol.framework_metadata ?? {}),
    export_aliases: [...new Set([...prior, ...aliases])].sort(compareCodeUnits),
  }
}

function mergeRanges(left: IndexRange, right: IndexRange): IndexRange {
  const start = comparePosition(left.start, right.start) <= 0 ? left.start : right.start
  const end = comparePosition(left.end, right.end) >= 0 ? left.end : right.end
  return { start: { ...start }, end: { ...end } }
}

function comparePosition(left: IndexRange['start'], right: IndexRange['start']): number {
  return left.line - right.line || left.column - right.column
}

function isCommonJsReexport(node: ts.CallExpression): boolean {
  const parent = node.parent
  if (!ts.isBinaryExpression(parent) || parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false
  const target = parent.left
  return ts.isPropertyAccessExpression(target)
    && ((ts.isIdentifier(target.expression)
      && (target.expression.text === 'exports'
        || (target.expression.text === 'module' && target.name.text === 'exports')))
      || (ts.isPropertyAccessExpression(target.expression)
        && ts.isIdentifier(target.expression.expression)
        && target.expression.expression.text === 'module'
        && target.expression.name.text === 'exports'))
}

function hasExportModifier(node: ts.Node): boolean {
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
  const resolvedPath = resolveRelativeImportAbsolute(spec, fromAbs, pathToFileId)
  return resolvedPath ? pathToFileId.get(resolvedPath) ?? null : null
}

function resolveRelativeImportAbsolute(
  spec: string,
  fromAbs: string,
  pathToFileId: Map<string, string>,
): string | null {
  const fromDir = dirname(fromAbs)
  const variants = expandJsToTsVariants(spec)

  for (const variant of variants) {
    for (const ext of RESOLUTION_CANDIDATE_EXTS) {
      const candidate = toPosix(resolve(fromDir, variant + ext))
      if (pathToFileId.has(candidate)) return candidate
    }
    for (const tail of INDEX_RESOLUTION_CANDIDATES) {
      const candidate = toPosix(resolve(fromDir, variant + tail))
      if (pathToFileId.has(candidate)) return candidate
    }
  }
  return null
}

function createIndexCompilerHost(
  root: string,
  compilerOptions: ts.CompilerOptions,
  pathToFileId: Map<string, string>,
  compilerOptionsForFile?: (containingFile: string) => ts.CompilerOptions,
): ts.CompilerHost {
  const host = ts.createCompilerHost(compilerOptions, true)
  const baseFileExists = host.fileExists.bind(host)
  const baseReadFile = host.readFile.bind(host)
  const baseGetSourceFile = host.getSourceFile.bind(host)
  const baseResolveModuleNames = host.resolveModuleNames?.bind(host)
  const canRead = (fileName: string): boolean =>
    !isSameOrNestedPath(fileName, root)
    || isDeclarationFilePath(fileName)
    || isCompilerMetadataPath(fileName)
    || !isProgramSourcePath(fileName)
    || pathToFileId.has(fileName)

  host.fileExists = (fileName) => canRead(fileName) && baseFileExists(fileName)
  host.readFile = (fileName) => canRead(fileName) ? baseReadFile(fileName) : undefined
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    canRead(fileName)
      ? baseGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : undefined

  // The scanner already supplied the complete source set. Keep referenced
  // projects source-backed so one Program can index their facts without
  // depending on prebuilt declaration output.
  ;(host as ts.CompilerHost & { useSourceOfProjectReferenceRedirect: () => boolean })
    .useSourceOfProjectReferenceRedirect = () => true

  host.resolveModuleNames = (moduleNames, containingFile, reusedNames, redirectedReference, options) => {
    const effectiveOptions = compilerOptionsForFile?.(toPosix(containingFile)) ?? options
    const resolutionHost: ts.ModuleResolutionHost = {
      fileExists: host.fileExists.bind(host),
      readFile: host.readFile.bind(host),
      getCurrentDirectory: host.getCurrentDirectory.bind(host),
      ...(host.directoryExists ? { directoryExists: host.directoryExists.bind(host) } : {}),
      ...(host.getDirectories ? { getDirectories: host.getDirectories.bind(host) } : {}),
      ...(host.realpath ? { realpath: host.realpath.bind(host) } : {}),
    }

    const fallbackResolve = (moduleName: string) =>
      resolveModuleWithRelativeFallback(
        moduleName,
        containingFile,
        effectiveOptions,
        resolutionHost,
        pathToFileId,
      )

    if (baseResolveModuleNames) {
      const resolved = baseResolveModuleNames(
        moduleNames,
        containingFile,
        reusedNames,
        redirectedReference,
        effectiveOptions,
      )
      return resolved.map((entry, index) => {
        const moduleName = moduleNames[index]
        return entry ?? (moduleName ? fallbackResolve(moduleName) : undefined)
      })
    }

    return moduleNames.map((moduleName) => fallbackResolve(moduleName))
  }

  return host
}

interface CanonicalProgram {
  program: ts.Program
  resolveModule: IndexedModuleResolver
}

function createCanonicalProgram(
  root: string,
  files: readonly IndexFile[],
  pathToFileId: Map<string, string>,
  diagnostics: IndexDiagnostic[],
): CanonicalProgram | null {
  const rootNames = files.map((file) => toPosix(join(root, file.path)))
  if (rootNames.length === 0) return null
  const optionsResolver = createCompilerOptionsResolver(root)
  const options = optionsResolver.defaultOptions
  const host = createIndexCompilerHost(root, options, pathToFileId, optionsResolver.forContainingFile)
  try {
    const configPath = findProjectConfigWithinRoot(root, root)
    const configPaths = new Set(files.map((file) => findProjectConfigWithinRoot(join(root, file.path), root)))
    if (configPath) configPaths.add(configPath)
    for (const path of configPaths) {
      if (path) collectConfigDiagnostics(path, root, rootNames, pathToFileId, diagnostics)
    }
    const projectReferences = configPath ? loadProjectReferences(configPath) : undefined
    const program = ts.createProgram({
      rootNames,
      options,
      host,
      ...(projectReferences ? { projectReferences } : {}),
    })
    const resolveModule: IndexedModuleResolver = (specifier, containingFile) => {
      const effectiveOptions = optionsResolver.forContainingFile(containingFile)
      const resolved = ts.resolveModuleName(specifier, containingFile, effectiveOptions, host).resolvedModule
      if (!resolved) return null
      return pathToFileId.get(toPosix(resolve(resolved.resolvedFileName))) ?? null
    }
    collectCompilerDiagnostics(program, root, pathToFileId, diagnostics)
    return { program, resolveModule }
  } catch (error) {
    diagnostics.push({
      id: 'canonical-index.program-create-failed',
      level: 'error',
      message: `TypeScript Program creation failed: ${error instanceof Error ? error.message : String(error)}`,
    })
    return null
  }
}

function isDeclarationFilePath(filePath: string): boolean {
  return /\.d\.[cm]?ts$/i.test(filePath)
}

function isProgramSourcePath(filePath: string): boolean {
  return /\.(?:[cm]?[jt]sx?|json)$/i.test(filePath)
}

function isCompilerMetadataPath(filePath: string): boolean {
  const name = basename(filePath)
  return name === 'package.json' || /^(?:ts|js)config(?:\..+)?\.json$/i.test(name)
}

function collectConfigDiagnostics(
  configPath: string,
  root: string,
  sourceFiles: readonly string[],
  pathToFileId: Map<string, string>,
  diagnostics: IndexDiagnostic[],
): void {
  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  const parseHost: ts.ParseConfigHost = {
    ...CONFIG_PARSE_HOST,
    readDirectory: (directory, extensions) => sourceFiles.filter((file) =>
      isSameOrNestedPath(file, directory)
      && (!extensions || extensions.some((extension) => file.endsWith(extension)))),
  }
  const parsed = read.config
    ? ts.parseJsonConfigFileContent(read.config, parseHost, dirname(configPath), INDEX_COMPILER_OVERRIDES, configPath)
    : null
  addTypeScriptDiagnostics(
    [...(read.error ? [read.error] : []), ...(parsed?.errors ?? [])],
    'config',
    root,
    pathToFileId,
    diagnostics,
  )
}

function collectCompilerDiagnostics(
  program: ts.Program,
  root: string,
  pathToFileId: Map<string, string>,
  diagnostics: IndexDiagnostic[],
): void {
  addTypeScriptDiagnostics([
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
  ], 'compiler', root, pathToFileId, diagnostics)
}

function addTypeScriptDiagnostics(
  values: readonly ts.Diagnostic[],
  scope: string,
  root: string,
  pathToFileId: Map<string, string>,
  diagnostics: IndexDiagnostic[],
): void {
  const seen = new Set(diagnostics.map((diagnostic) => diagnostic.id))
  for (const value of values) {
    const message = ts.flattenDiagnosticMessageText(value.messageText, '\n')
    const fileId = value.file ? pathToFileId.get(value.file.fileName) : undefined
    const range = value.file && value.start !== undefined
      ? rangeFromOffsets(value.file, value.start, value.start + (value.length ?? 0))
      : undefined
    const sourceIdentity = value.file
      ? fileId ?? (isSameOrNestedPath(value.file.fileName, root)
          ? toPosix(relative(root, resolve(value.file.fileName)))
          : `external:${basename(value.file.fileName)}`)
      : ''
    const stableMessage = message.replaceAll(root, '<root>').replaceAll(toPosix(root), '<root>')
    const id = `canonical-index.${scope}.${value.code}.${sha256(`${sourceIdentity}:${value.start ?? ''}:${stableMessage}`).slice(0, 12)}`
    if (seen.has(id)) continue
    seen.add(id)
    diagnostics.push({
      id,
      level: value.category === ts.DiagnosticCategory.Error
        ? 'error'
        : value.category === ts.DiagnosticCategory.Warning ? 'warn' : 'info',
      message: `TS${value.code}: ${message}`,
      ...(fileId ? { evidence: { file_id: fileId, ...(range ? { range } : {}) } } : {}),
    })
  }
}

function rangeFromOffsets(sourceFile: ts.SourceFile, startOffset: number, endOffset: number): IndexRange {
  const start = sourceFile.getLineAndCharacterOfPosition(startOffset)
  const end = sourceFile.getLineAndCharacterOfPosition(endOffset)
  return {
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  }
}

function resolveModuleWithRelativeFallback(
  moduleName: string,
  containingFile: string,
  compilerOptions: ts.CompilerOptions,
  host: ts.ModuleResolutionHost,
  pathToFileId: Map<string, string>,
): ts.ResolvedModuleFull | undefined {
  const resolved = ts.resolveModuleName(
    moduleName,
    containingFile,
    compilerOptions,
    host,
  ).resolvedModule
  if (resolved) {
    return resolved
  }

  if (!moduleName.startsWith('.') && !moduleName.startsWith('/')) {
    return undefined
  }

  const resolvedPath = resolveRelativeImportAbsolute(moduleName, containingFile, pathToFileId)
  if (!resolvedPath) {
    return undefined
  }

  return {
    resolvedFileName: resolvedPath,
    extension: extensionForResolvedFile(resolvedPath),
    isExternalLibraryImport: false,
  }
}

function extensionForResolvedFile(filePath: string): ts.Extension {
  if (filePath.endsWith('.tsx')) return ts.Extension.Tsx
  if (filePath.endsWith('.jsx')) return ts.Extension.Jsx
  if (filePath.endsWith('.js')) return ts.Extension.Js
  return ts.Extension.Ts
}

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

function rangeOf(node: ts.Node, sourceFile: ts.SourceFile): IndexRange {
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

function makeSymbolId(fileId: string, kind: IndexSymbolKind, name: string): string {
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

function toPosix(p: string): string {
  return p.split('\\').join('/')
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalPathKey(path: string): string {
  const normalized = toPosix(resolve(path))
  return process.platform === 'win32' || /^[A-Za-z]:\//.test(normalized)
    ? normalized.toLowerCase()
    : normalized
}

class CanonicalPathMap<Value> extends Map<string, Value> {
  override get(key: string): Value | undefined { return super.get(canonicalPathKey(key)) }
  override has(key: string): boolean { return super.has(canonicalPathKey(key)) }
  override set(key: string, value: Value): this { return super.set(canonicalPathKey(key), value) }
}

function symbolSortKey(symbol: IndexSymbol): string {
  return `${symbol.id}|${rangeSortKey(symbol.range)}`
}

function edgeSortKey(edge: IndexEdge): string {
  return [edge.from, edge.to, edge.kind, edge.source, edge.evidence?.file_id ?? '',
    edge.evidence ? rangeSortKey(edge.evidence.range) : '', JSON.stringify(edge.metadata ?? {})].join('|')
}

function diagnosticSortKey(diagnostic: IndexDiagnostic): string {
  return `${diagnostic.id}|${diagnostic.evidence?.file_id ?? ''}|${diagnostic.evidence?.range ? rangeSortKey(diagnostic.evidence.range) : ''}`
}

function rangeSortKey(range: IndexRange): string {
  return [range.start.line, range.start.column, range.end.line, range.end.column]
    .map((value) => String(value).padStart(10, '0')).join(':')
}

function normalizeAbsolutePath(path: string): string {
  return canonicalPathKey(path)
}

function comparablePath(path: string): string {
  return canonicalPathKey(path)
}

function isSameOrNestedPath(path: string, root: string): boolean {
  const comparable = comparablePath(path)
  const comparableRoot = comparablePath(root)
  return comparable === comparableRoot || comparable.startsWith(`${comparableRoot}/`)
}

type TypeCheckerEdgeContext = {
  files: IndexFile[]
  root: string
  pathToFileId: Map<string, string>
  symbols: IndexSymbol[]
  edges: IndexEdge[]
  diagnostics: IndexDiagnostic[]
  program: ts.Program
}

function addTypeCheckerEdges(ctx: TypeCheckerEdgeContext): void {
  const { files, root, pathToFileId, symbols, edges, diagnostics, program } = ctx
  const checker = program.getTypeChecker()
  const seenCalls = new Set<string>()
  const seenTypeEdges = new Set<string>()
  const knownSymbolIds = new Set(symbols.map((symbol) => symbol.id))

  const symbolsByFile = new Map<string, IndexSymbol[]>()
  for (const sym of symbols) {
    const list = symbolsByFile.get(sym.file_id)
    if (list) list.push(sym)
    else symbolsByFile.set(sym.file_id, [sym])
  }

  const programSourceFiles = files
    .map((f) => program.getSourceFile(toPosix(join(root, f.path))))
    .filter((sf): sf is ts.SourceFile => sf !== undefined)
  const tokenMap = collectNestTokenMap({
    sourceFiles: programSourceFiles,
    pathToFileId,
    checker,
  })
  const workerIndex = collectBullWorkerIndex(program, pathToFileId)

  for (const file of files) {
    const abs = toPosix(join(root, file.path))
    const sourceFile = program.getSourceFile(abs)
    if (!sourceFile) continue
    walkCallExpressions(sourceFile, file.id, checker, pathToFileId, symbols, edges, seenCalls, knownSymbolIds)
    walkTypeReferences(sourceFile, file.id, checker, pathToFileId, edges, seenTypeEdges)
    detectNestFramework({
      program,
      sourceFile,
      fileId: file.id,
      symbolsByFile,
      edges,
      diagnostics,
      pathToFileId,
      checker,
      tokenMap,
      workerIndex,
    })
    detectExpressFramework({
      sourceFile,
      fileId: file.id,
      symbolsByFile,
      symbols,
      edges,
      checker,
      pathToFileId,
    })
    detectNextjsFramework({
      sourceFile,
      fileId: file.id,
      filePath: file.path,
      symbolsByFile,
    })
    detectReactRouterFramework({
      sourceFile,
      fileId: file.id,
      symbolsByFile,
      edges,
      checker,
      pathToFileId,
    })
    detectHonoFramework({
      sourceFile,
      fileId: file.id,
      symbolsByFile,
      symbols,
      edges,
      checker,
      pathToFileId,
    })
    detectFastifyFramework({
      sourceFile,
      fileId: file.id,
      symbolsByFile,
      symbols,
      edges,
      checker,
      pathToFileId,
    })
    detectTrpcFramework({
      sourceFile,
      fileId: file.id,
      symbolsByFile,
      symbols,
      edges,
      checker,
    })
    detectPrismaFramework({
      sourceFile,
      fileId: file.id,
      symbolsByFile,
      symbols,
      edges,
      checker,
    })
  }

  finalizeExpressMountPrefixes({ symbols, edges })
}

function walkCallExpressions(
  sourceFile: ts.SourceFile,
  fileId: string,
  checker: ts.TypeChecker,
  pathToFileId: Map<string, string>,
  symbols: IndexSymbol[],
  edges: IndexEdge[],
  seen: Set<string>,
  knownSymbolIds: Set<string>,
): void {
  const externalImportedBindings = collectExternalImportedBindings(sourceFile)

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (isInsideDecorator(node)) {
        ts.forEachChild(node, visit)
        return
      }
      const callerId = findEnclosingIndexSymbolId(node, fileId)
      if (callerId) {
        const resolvedCallee = resolveCallee(node, checker, pathToFileId)
        const syntheticCallee = resolvedCallee
          ? null
          : resolveSyntheticExternalCall(
            node,
            fileId,
            sourceFile,
            checker,
            externalImportedBindings,
            symbols,
            edges,
            knownSymbolIds,
        )
        const callee = resolvedCallee ?? syntheticCallee
        if (callee && callee.id !== callerId) {
          const range = rangeOf(node, sourceFile)
          const dedupeKey = `${callerId}|${callee.id}|${range.start.line}:${range.start.column}|${range.end.line}:${range.end.column}`
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey)
            edges.push({
              from: callerId,
              to: callee.id,
              kind: 'calls',
              confidence: callee.confidence,
              source: resolvedCallee ? 'typescript-semantic' : 'heuristic',
              evidence: { file_id: fileId, range },
            })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function isInsideDecorator(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (ts.isDecorator(current)) return true
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false
    current = current.parent
  }
  return false
}

function resolveSyntheticExternalCall(
  callExpr: ts.CallExpression,
  fileId: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  externalImportedBindings: ReadonlySet<string>,
  symbols: IndexSymbol[],
  edges: IndexEdge[],
  knownSymbolIds: Set<string>,
): { id: string; confidence: 'medium' } | null {
  const label = resolveSyntheticExternalCallLabel(callExpr, checker, externalImportedBindings)
  if (!label) return null

  const symbolId = makeSymbolId(fileId, 'function', label)
  if (!knownSymbolIds.has(symbolId)) {
    const range = rangeOf(callExpr, sourceFile)
    knownSymbolIds.add(symbolId)
    symbols.push({
      id: symbolId,
      file_id: fileId,
      name: label,
      kind: 'function',
      range,
      exported: false,
      framework_metadata: {
        external_call: true,
      },
    })
    edges.push({
      from: fileId,
      to: symbolId,
      kind: 'declares',
      confidence: 'medium',
      source: 'heuristic',
      evidence: { file_id: fileId, range },
    })
  }

  return {
    id: symbolId,
    confidence: 'medium',
  }
}

function resolveSyntheticExternalCallLabel(
  callExpr: ts.CallExpression,
  checker: ts.TypeChecker,
  externalImportedBindings: ReadonlySet<string>,
): string | null {
  if (ts.isIdentifier(callExpr.expression)) {
    if (externalImportedBindings.has(callExpr.expression.text)) {
      return `${callExpr.expression.text}()`
    }
    const symbol = followAlias(checker.getSymbolAtLocation(callExpr.expression), checker)
    return resolvesToDeclarationFile(symbol) ? `${callExpr.expression.text}()` : null
  }

  if (ts.isPropertyAccessExpression(callExpr.expression) && ts.isIdentifier(callExpr.expression.expression)) {
    const receiver = callExpr.expression.expression
    if (externalImportedBindings.has(receiver.text)) {
      return `${receiver.text}.${callExpr.expression.name.text}`
    }
    const symbol = followAlias(checker.getSymbolAtLocation(receiver), checker)
    if (!resolvesToDeclarationFile(symbol)) return null
    return `${receiver.text}.${callExpr.expression.name.text}`
  }

  return null
}

function resolvesToDeclarationFile(symbol: ts.Symbol | undefined): boolean {
  const declarations = symbol?.declarations
  if (!declarations || declarations.length === 0) {
    return false
  }

  return declarations.some((decl) => decl.getSourceFile().isDeclarationFile)
}

function collectExternalImportedBindings(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const bindings = new Set<string>()

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }

    const specifier = statement.moduleSpecifier.text
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      continue
    }

    const importClause = statement.importClause
    if (!importClause || importClause.isTypeOnly) {
      continue
    }

    if (importClause.name) {
      bindings.add(importClause.name.text)
    }

    const namedBindings = importClause.namedBindings
    if (!namedBindings) {
      continue
    }

    if (ts.isNamespaceImport(namedBindings)) {
      bindings.add(namedBindings.name.text)
      continue
    }

    for (const element of namedBindings.elements) {
      if (!element.isTypeOnly) {
        bindings.add(element.name.text)
      }
    }
  }

  return bindings
}

function findEnclosingIndexSymbolId(callExpr: ts.CallExpression, fileId: string): string | null {
  let current: ts.Node | undefined = callExpr.parent
  while (current) {
    if (ts.isFunctionDeclaration(current) && (current.name || hasDefaultModifier(current))) {
      return makeSymbolId(fileId, 'function', current.name?.text ?? 'default')
    }
    if ((ts.isFunctionExpression(current) || ts.isArrowFunction(current)) && ts.isBinaryExpression(current.parent)) {
      const direct = directCommonJsExport(current.parent)
      if (direct) return makeSymbolId(fileId, 'function', direct.name)
    }
    if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) {
      const className = indexedClassName(current.parent)
      if (className) return makeSymbolId(fileId, 'method', `${className}.${current.name.text}`)
    }
    if (ts.isConstructorDeclaration(current)) {
      const className = indexedClassName(current.parent)
      if (className) return makeSymbolId(fileId, 'method', `${className}.constructor`)
    }
    if (
      (ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) &&
      current.name &&
      ts.isIdentifier(current.name)
    ) {
      const className = indexedClassName(current.parent)
      if (className) return makeSymbolId(fileId, 'method', `${className}.${current.name.text}`)
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      const list = current.parent
      const stmt = list.parent
      if (ts.isVariableStatement(stmt) && ts.isSourceFile(stmt.parent)) {
        const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0
        const kind: IndexSymbolKind = isConst ? 'constant' : 'variable'
        return makeSymbolId(fileId, kind, current.name.text)
      }
    }
    current = current.parent
  }
  return null
}

function indexedClassName(node: ts.Node): string | null {
  if (!ts.isClassDeclaration(node) && !ts.isClassExpression(node)) return null
  if (ts.isClassExpression(node) && ts.isBinaryExpression(node.parent)) {
    return directCommonJsExport(node.parent)?.name ?? node.name?.text ?? null
  }
  if (node.name) return node.name.text
  if (ts.isClassDeclaration(node) && hasDefaultModifier(node)) return 'default'
  return null
}

function resolveCallee(
  callExpr: ts.CallExpression,
  checker: ts.TypeChecker,
  pathToFileId: Map<string, string>,
): { id: string; confidence: 'high' | 'medium' | 'low' } | null {
  const signatureResolved = resolveCalleeFromSignature(callExpr, checker, pathToFileId)
  if (signatureResolved) {
    return signatureResolved
  }

  return resolveThisPropertyAccessFallback(callExpr, checker, pathToFileId)
}

function resolveCalleeFromSignature(
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

  const id = lookupIndexSymbolForDeclaration(decl, targetFileId)
  if (!id) return null

  const exprSymbol = checker.getSymbolAtLocation(callExpr.expression)
    ?? (callExpr.expression.kind === ts.SyntaxKind.PropertyAccessExpression
      ? checker.getSymbolAtLocation((callExpr.expression as ts.PropertyAccessExpression).name)
      : undefined)
  const overloadCount = exprSymbol?.declarations?.length ?? 1
  const confidence: 'high' | 'medium' = overloadCount > 1 ? 'medium' : 'high'
  return { id, confidence }
}

function resolveThisPropertyAccessFallback(
  callExpr: ts.CallExpression,
  checker: ts.TypeChecker,
  pathToFileId: Map<string, string>,
): { id: string; confidence: 'high' | 'medium' | 'low' } | null {
  if (!ts.isPropertyAccessExpression(callExpr.expression)) {
    return null
  }

  const methodName = callExpr.expression.name.text
  const receiver = callExpr.expression.expression

  if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
    const sameClassMethodId = resolveSameClassMethodFallback(callExpr, methodName, pathToFileId)
    return sameClassMethodId ? { id: sameClassMethodId, confidence: 'medium' } : null
  }

  if (
    !ts.isPropertyAccessExpression(receiver)
    || receiver.expression.kind !== ts.SyntaxKind.ThisKeyword
  ) {
    return null
  }

  const propertyTarget = resolveMethodFromReceiverType(receiver, methodName, checker, pathToFileId)
  if (propertyTarget) {
    return { id: propertyTarget, confidence: 'medium' }
  }

  const enclosingClass = findEnclosingClassDeclaration(callExpr)
  if (!enclosingClass) {
    return null
  }

  const constructorParam = findConstructorParameterProperty(enclosingClass, receiver.name.text)
  if (!constructorParam) {
    return null
  }

  const targetClass = resolveProviderClassFromParameter(constructorParam, checker, pathToFileId)
  if (!targetClass) {
    return null
  }

  const targetMethodId = lookupUniqueMethodOnClass(targetClass, methodName, pathToFileId)
  return targetMethodId ? { id: targetMethodId, confidence: 'low' } : null
}

function resolveSameClassMethodFallback(
  callExpr: ts.CallExpression,
  methodName: string,
  pathToFileId: Map<string, string>,
): string | null {
  const enclosingClass = findEnclosingClassDeclaration(callExpr)
  if (!enclosingClass) {
    return null
  }

  return lookupUniqueMethodOnClass(enclosingClass, methodName, pathToFileId)
}

function resolveMethodFromReceiverType(
  receiver: ts.PropertyAccessExpression,
  methodName: string,
  checker: ts.TypeChecker,
  pathToFileId: Map<string, string>,
): string | null {
  const receiverType = checker.getTypeAtLocation(receiver)
  const methodSymbol = followAlias(checker.getPropertyOfType(receiverType, methodName), checker)
  const declaration = methodSymbol?.declarations?.find((decl) =>
    ts.isMethodDeclaration(decl)
    || ts.isGetAccessorDeclaration(decl)
    || ts.isSetAccessorDeclaration(decl))
  if (!declaration) {
    return null
  }

  const sourceFile = declaration.getSourceFile()
  if (sourceFile.isDeclarationFile) {
    return null
  }

  const targetFileId = pathToFileId.get(sourceFile.fileName)
  return targetFileId ? lookupIndexSymbolForDeclaration(declaration, targetFileId) : null
}

function findEnclosingClassDeclaration(node: ts.Node): ts.ClassDeclaration | null {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (ts.isClassDeclaration(current)) {
      return current
    }
    current = current.parent
  }
  return null
}

function findConstructorParameterProperty(
  classDecl: ts.ClassDeclaration,
  propertyName: string,
): ts.ParameterDeclaration | null {
  const ctor = classDecl.members.find((member): member is ts.ConstructorDeclaration =>
    ts.isConstructorDeclaration(member))
  if (!ctor) {
    return null
  }

  for (const param of ctor.parameters) {
    if (ts.isIdentifier(param.name) && param.name.text === propertyName) {
      return param
    }
  }

  return null
}

function resolveProviderClassFromParameter(
  param: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
  pathToFileId: Map<string, string>,
): ts.ClassDeclaration | null {
  if (param.type) {
    const fromTypeNode = resolveClassDeclarationFromTypeNode(param.type, checker)
    if (fromTypeNode?.name) {
      const targetFileId = pathToFileId.get(fromTypeNode.getSourceFile().fileName)
      if (targetFileId) {
        return fromTypeNode
      }
    }
  }

  const parameterType = checker.getTypeAtLocation(param)
  const symbol = followAlias(parameterType.getSymbol(), checker)
  const declaration = symbol?.declarations?.find((decl): decl is ts.ClassDeclaration =>
    ts.isClassDeclaration(decl) && !!decl.name)
  if (!declaration || declaration.getSourceFile().isDeclarationFile) {
    return null
  }

  const targetFileId = pathToFileId.get(declaration.getSourceFile().fileName)
  return targetFileId ? declaration : null
}

function resolveClassDeclarationFromTypeNode(
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
): ts.ClassDeclaration | null {
  if (!ts.isTypeReferenceNode(typeNode)) {
    return null
  }

  const typeName = ts.isQualifiedName(typeNode.typeName)
    ? typeNode.typeName.right
    : typeNode.typeName
  const symbol = followAlias(checker.getSymbolAtLocation(typeName), checker)
  const declaration = symbol?.declarations?.find((decl): decl is ts.ClassDeclaration =>
    ts.isClassDeclaration(decl) && !!decl.name)
  return declaration ?? null
}

function lookupUniqueMethodOnClass(
  classDecl: ts.ClassDeclaration,
  methodName: string,
  pathToFileId: Map<string, string>,
): string | null {
  if (!classDecl.name || classDecl.getSourceFile().isDeclarationFile) {
    return null
  }

  const matches = classDecl.members.filter((member) =>
    (ts.isMethodDeclaration(member)
      || ts.isGetAccessorDeclaration(member)
      || ts.isSetAccessorDeclaration(member))
    && !!member.name
    && ts.isIdentifier(member.name)
    && member.name.text === methodName)

  if (matches.length !== 1) {
    return null
  }

  const targetFileId = pathToFileId.get(classDecl.getSourceFile().fileName)
  if (!targetFileId) {
    return null
  }

  return makeSymbolId(targetFileId, 'method', `${classDecl.name.text}.${methodName}`)
}

function lookupIndexSymbolForDeclaration(decl: ts.Declaration, fileId: string): string | null {
  if (ts.isFunctionDeclaration(decl) && (decl.name || hasDefaultModifier(decl))) {
    return makeSymbolId(fileId, 'function', decl.name?.text ?? 'default')
  }
  if ((ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl)) && decl.name && ts.isIdentifier(decl.name)) {
    const ownerName = ts.isInterfaceDeclaration(decl.parent) ? decl.parent.name.text : indexedClassName(decl.parent)
    if (ownerName) return makeSymbolId(fileId, 'method', `${ownerName}.${decl.name.text}`)
  }
  if (ts.isConstructorDeclaration(decl)) {
    const className = indexedClassName(decl.parent)
    if (className) return makeSymbolId(fileId, 'method', `${className}.constructor`)
  }
  if (
    (ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl)) &&
    decl.name &&
    ts.isIdentifier(decl.name)
  ) {
    const className = indexedClassName(decl.parent)
    if (className) return makeSymbolId(fileId, 'method', `${className}.${decl.name.text}`)
  }
  if (ts.isFunctionExpression(decl) || ts.isArrowFunction(decl)) {
    if (ts.isBinaryExpression(decl.parent)) {
      const direct = directCommonJsExport(decl.parent)
      if (direct) return makeSymbolId(fileId, 'function', direct.name)
    }
    const vd = decl.parent
    if (ts.isVariableDeclaration(vd) && ts.isIdentifier(vd.name)) {
      const stmt = vd.parent.parent
      if (ts.isVariableStatement(stmt)) {
        const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0
        const kind: IndexSymbolKind = isConst ? 'constant' : 'variable'
        return makeSymbolId(fileId, kind, vd.name.text)
      }
    }
  }
  return null
}

function loadCompilerOptions(root: string): ts.CompilerOptions {
  const tsConfigPath = findProjectConfigWithinRoot(root, root)
  return tsConfigPath ? loadCompilerOptionsFromConfig(tsConfigPath) ?? defaultCompilerOptions() : defaultCompilerOptions()
}

type CompilerOptionsResolver = {
  defaultOptions: ts.CompilerOptions
  forContainingFile: (containingFile: string) => ts.CompilerOptions
}

function createCompilerOptionsResolver(root: string): CompilerOptionsResolver {
  const defaultOptions = loadCompilerOptions(root)
  const discoveredConfigPathByDir = new Map<string, string | null>()
  const compilerOptionsByConfigPath = new Map<string, ts.CompilerOptions>()

  const forContainingFile = (containingFile: string): ts.CompilerOptions => {
    const currentDir = dirname(resolve(containingFile))
    const cacheKey = normalizeAbsolutePath(currentDir)
    let configPath = discoveredConfigPathByDir.get(cacheKey)
    if (configPath === undefined) {
      configPath = findProjectConfigWithinRoot(currentDir, root)
      discoveredConfigPathByDir.set(cacheKey, configPath)
    }

    if (configPath) {
      let compilerOptions = compilerOptionsByConfigPath.get(configPath)
      if (!compilerOptions) {
        compilerOptions = loadCompilerOptionsFromConfig(configPath) ?? defaultOptions
        compilerOptionsByConfigPath.set(configPath, compilerOptions)
      }
      return compilerOptions
    }

    return defaultOptions
  }

  return {
    defaultOptions,
    forContainingFile,
  }
}

function loadCompilerOptionsFromConfig(tsConfigPath: string | null): ts.CompilerOptions | null {
  if (!tsConfigPath || !existsSync(tsConfigPath)) return null
  if (existsSync(tsConfigPath)) {
    try {
      const content = readFileSync(tsConfigPath, 'utf8')
      const parsed = ts.parseConfigFileTextToJson(tsConfigPath, content)
      if (parsed.config) {
        const configDir = dirname(tsConfigPath)
        const config = ts.parseJsonConfigFileContent(parsed.config, CONFIG_PARSE_HOST, configDir, INDEX_COMPILER_OVERRIDES)
        return { ...config.options, ...INDEX_COMPILER_OVERRIDES }
      }
    } catch {
    }
  }
  return null
}

function loadProjectReferences(tsConfigPath: string): readonly ts.ProjectReference[] | undefined {
  try {
    const content = readFileSync(tsConfigPath, 'utf8')
    const parsed = ts.parseConfigFileTextToJson(tsConfigPath, content)
    if (!parsed.config) return undefined
    return ts.parseJsonConfigFileContent(parsed.config, CONFIG_PARSE_HOST, dirname(tsConfigPath)).projectReferences
  } catch {
    return undefined
  }
}

export function findNearestProjectConfigPath(startPath: string): string | null {
  const resolvedStartPath = resolve(startPath)
  const searchDir =
    existsSync(resolvedStartPath) && statSync(resolvedStartPath).isDirectory()
      ? resolvedStartPath
      : dirname(resolvedStartPath)
  return ts.findConfigFile(searchDir, ts.sys.fileExists, 'tsconfig.json')
    ?? ts.findConfigFile(searchDir, ts.sys.fileExists, 'jsconfig.json')
    ?? null
}

function findProjectConfigWithinRoot(startPath: string, root: string): string | null {
  const config = findNearestProjectConfigPath(startPath)
  return config && isSameOrNestedPath(config, root) ? config : null
}

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    strict: false,
    esModuleInterop: true,
    isolatedModules: true,
    ...INDEX_COMPILER_OVERRIDES,
  }
}

const INDEX_COMPILER_OVERRIDES = {
  noEmit: true,
  skipLibCheck: true,
  ignoreDeprecations: '6.0',
} satisfies ts.CompilerOptions

const CONFIG_PARSE_HOST: ts.ParseConfigHost = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: () => [],
}

type TypeEdgeKind = 'extends' | 'implements' | 'param_type' | 'return_type'

function walkTypeReferences(
  sourceFile: ts.SourceFile,
  fileId: string,
  checker: ts.TypeChecker,
  pathToFileId: Map<string, string>,
  edges: IndexEdge[],
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
      ts.isMethodSignature(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      const fromId = lookupIndexSymbolForDeclaration(node, fileId)
      if (fromId) visitSignatureTypes(node, fromId, sourceFile, fileId, checker, pathToFileId, edges, seen)
    }

    if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && ts.isVariableDeclaration(node.parent)) {
      const fromId = lookupIndexSymbolForDeclaration(node, fileId)
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
  edges: IndexEdge[],
  seen: Set<string>,
): void {
  if (!clauses) return
  for (const clause of clauses) {
    const kind: TypeEdgeKind = clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements'
    for (const heritageType of clause.types) {
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
  edges: IndexEdge[],
  seen: Set<string>,
): void {
  for (const param of node.parameters) {
    if (param.type) emitNestedTypeEdges(fromId, 'param_type', param.type, sourceFile, fileId, checker, pathToFileId, edges, seen)
  }
  if (node.type) emitNestedTypeEdges(fromId, 'return_type', node.type, sourceFile, fileId, checker, pathToFileId, edges, seen)
}

function emitNestedTypeEdges(
  fromId: string,
  kind: Extract<TypeEdgeKind, 'param_type' | 'return_type'>,
  typeNode: ts.TypeNode,
  sourceFile: ts.SourceFile,
  fileId: string,
  checker: ts.TypeChecker,
  pathToFileId: Map<string, string>,
  edges: IndexEdge[],
  seen: Set<string>,
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      const symbol = followAlias(checker.getSymbolAtLocation(node.typeName), checker)
      emitTypeEdgeFromSymbol(fromId, kind, symbol, node, sourceFile, fileId, pathToFileId, edges, seen)
    }
    ts.forEachChild(node, visit)
  }
  visit(typeNode)
}

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
  edges: IndexEdge[],
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

  const range = rangeOf(evidenceNode, sourceFile)
  const dedupeKey = `${fromId}|${toId}|${kind}|${range.start.line}:${range.start.column}|${range.end.line}:${range.end.column}`
  if (seen.has(dedupeKey)) return
  seen.add(dedupeKey)

  edges.push({
    from: fromId,
    to: toId,
    kind,
    confidence: 'high',
    source: 'typescript-semantic',
    evidence: { file_id: fileId, range },
  })
}

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
