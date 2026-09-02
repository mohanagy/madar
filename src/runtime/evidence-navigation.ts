import { createHash } from 'node:crypto'
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path'
import ts from 'typescript'

export type EvidenceResolution =
  | 'exact_resolved'
  | 'ambiguous'
  | 'unresolved'
  | 'unsupported'
  | 'truncated'

export type EvidenceKind =
  | 'path'
  | 'literal'
  | 'route'
  | 'symbol'
  | 'definition'
  | 'reference'
  | 'source'

export interface EvidencePosition {
  line: number
  column: number
}

export interface EvidenceRange {
  start: EvidencePosition
  end: EvidencePosition
}

export interface EvidenceItem {
  path: string
  range: EvidenceRange
  evidence_kind: EvidenceKind
  name?: string
  symbol_kind?: string
  container_name?: string
  route_method?: string
  route_path?: string
  preview?: string
  is_definition?: boolean
}

export interface EvidenceProjectMetadata {
  config_path: string | null
  provider_capability: 'available' | 'unsupported'
}

export interface EvidenceResult {
  schema_version: 1
  operation: 'resolve_anchor' | 'search_exact' | 'read_evidence' | 'definition' | 'references'
  resolution: EvidenceResolution
  provider: 'madar-exact' | 'typescript-language-service'
  provider_version: string
  repository_revision: string
  project: EvidenceProjectMetadata
  query: string
  truncated: boolean
  evidence: EvidenceItem[]
  detail?: string
  digest: string
}

export interface EvidenceNavigatorOptions {
  rootDir: string
  maxSearchResults?: number
  maxScannedFiles?: number
  maxFileBytes?: number
}

export interface LocationRequest {
  anchor?: string
  path?: string
  line?: number
  column?: number
  limit?: number
}

interface ProjectState {
  configPath: string
  configRelativePath: string
  parsed: ts.ParsedCommandLine
  languageService: ts.LanguageService
}

interface CandidateLocation {
  fileName: string
  start: number
  length: number
  name?: string
  kind?: string
  containerName?: string
}

const DEFAULT_MAX_RESULTS = 100
const DEFAULT_MAX_SCANNED_FILES = 20_000
const DEFAULT_MAX_FILE_BYTES = 2_000_000
const MAX_READ_LINES = 400
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonc', '.yaml', '.yml',
  '.md', '.mdx', '.txt', '.toml', '.graphql', '.gql',
])
const IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.jj',
  'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.astro', '.vite', '.turbo', '.nx',
  '.cache', '.parcel-cache', '.serverless', '.vercel', '.netlify',
  '.madar', 'madar-cache', 'madar-report',
])
const ROUTE_METHODS = new Map<string, string>([
  ['Get', 'GET'],
  ['Post', 'POST'],
  ['Put', 'PUT'],
  ['Patch', 'PATCH'],
  ['Delete', 'DELETE'],
  ['Options', 'OPTIONS'],
  ['Head', 'HEAD'],
  ['All', 'ALL'],
])
const DIRECT_ROUTE_METHODS = new Map<string, string>([
  ['get', 'GET'],
  ['post', 'POST'],
  ['put', 'PUT'],
  ['patch', 'PATCH'],
  ['delete', 'DELETE'],
  ['options', 'OPTIONS'],
  ['head', 'HEAD'],
  ['all', 'ALL'],
])

function codePointCompare(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0)
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0)
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]
    const rightPoint = rightPoints[index]
    if (leftPoint === undefined || rightPoint === undefined) break
    if (leftPoint < rightPoint) return -1
    if (leftPoint > rightPoint) return 1
  }
  return leftPoints.length - rightPoints.length
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalValue(entry))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => codePointCompare(left, right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    )
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function resultDigest(value: Omit<EvidenceResult, 'digest'>): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function normalizeSlash(value: string): string {
  return value.replaceAll('\\', '/')
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

function normalizeRoutePath(...parts: string[]): string {
  const joined = parts
    .map((part) => trimSlashes(part.trim()))
    .filter((part) => part.length > 0)
    .join('/')
  return joined.length === 0 ? '/' : `/${joined}`
}

function lineTextAt(text: string, position: number): string {
  const start = Math.max(0, text.lastIndexOf('\n', Math.max(0, position - 1)) + 1)
  const newline = text.indexOf('\n', position)
  const end = newline === -1 ? text.length : newline
  return text.slice(start, end).trim()
}

function offsetRange(text: string, start: number, length: number): EvidenceRange {
  const sourceFile = ts.createSourceFile('evidence.ts', text, ts.ScriptTarget.Latest, false)
  return spanRange(sourceFile, start, length)
}

function spanRange(sourceFile: ts.SourceFile, start: number, length: number): EvidenceRange {
  const safeStart = Math.max(0, Math.min(start, sourceFile.text.length))
  const safeEnd = Math.max(safeStart, Math.min(safeStart + Math.max(0, length), sourceFile.text.length))
  const startPosition = sourceFile.getLineAndCharacterOfPosition(safeStart)
  const endPosition = sourceFile.getLineAndCharacterOfPosition(safeEnd)
  return {
    start: { line: startPosition.line + 1, column: startPosition.character + 1 },
    end: { line: endPosition.line + 1, column: endPosition.character + 1 },
  }
}

function parseGitDir(rootDir: string): string | null {
  const dotGit = resolve(rootDir, '.git')
  try {
    const stat = lstatSync(dotGit)
    if (stat.isDirectory()) return dotGit
    if (!stat.isFile()) return null
    const content = readFileSync(dotGit, 'utf8').trim()
    const match = /^gitdir:\s*(.+)$/i.exec(content)
    if (!match?.[1]) return null
    return resolve(rootDir, match[1])
  } catch {
    return null
  }
}

function gitCommonDir(gitDir: string): string {
  try {
    const common = readFileSync(resolve(gitDir, 'commondir'), 'utf8').trim()
    return resolve(gitDir, common)
  } catch {
    return gitDir
  }
}

function readGitRevision(rootDir: string): string {
  const gitDir = parseGitDir(rootDir)
  if (!gitDir) return 'unknown'
  let head: string
  try {
    head = readFileSync(resolve(gitDir, 'HEAD'), 'utf8').trim()
  } catch {
    return 'unknown'
  }
  if (/^[0-9a-f]{40,64}$/i.test(head)) return head.toLowerCase()
  const refMatch = /^ref:\s*(.+)$/.exec(head)
  if (!refMatch?.[1]) return 'unknown'
  const ref = refMatch[1]
  const commonDir = gitCommonDir(gitDir)
  for (const directory of [gitDir, commonDir]) {
    try {
      const value = readFileSync(resolve(directory, ref), 'utf8').trim()
      if (/^[0-9a-f]{40,64}$/i.test(value)) return value.toLowerCase()
    } catch {
      // Fall through to packed refs.
    }
  }
  try {
    const packedRefs = readFileSync(resolve(commonDir, 'packed-refs'), 'utf8')
    for (const line of packedRefs.split(/\r?\n/)) {
      if (line.startsWith('#') || line.startsWith('^')) continue
      const [sha, packedRef] = line.trim().split(/\s+/, 2)
      if (packedRef === ref && sha && /^[0-9a-f]{40,64}$/i.test(sha)) return sha.toLowerCase()
    }
  } catch {
    // No packed refs.
  }
  return 'unknown'
}

function isInsideRoot(rootDir: string, candidate: string): boolean {
  const relativePath = relative(rootDir, candidate)
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
}

function safeExistingFile(rootDir: string, rawPath: string): string | null {
  if (rawPath.trim().length === 0 || isAbsolute(rawPath)) return null
  const normalized = normalizeSlash(rawPath).replace(/^\.\//, '')
  if (normalized.split('/').some((segment) => segment === '..' || segment === '')) return null
  const candidate = resolve(rootDir, normalized)
  if (!isInsideRoot(rootDir, candidate)) return null
  try {
    const realRoot = realpathSync(rootDir)
    const realCandidate = realpathSync(candidate)
    if (!isInsideRoot(realRoot, realCandidate)) return null
    return statSync(realCandidate).isFile() ? realCandidate : null
  } catch {
    return null
  }
}

function relativeEvidencePath(rootDir: string, fileName: string): string | null {
  let realRoot: string
  let realFile: string
  try {
    realRoot = realpathSync(rootDir)
    realFile = realpathSync(fileName)
  } catch {
    return null
  }
  if (!isInsideRoot(realRoot, realFile)) return null
  const value = normalizeSlash(relative(realRoot, realFile))
  return value.length > 0 && !value.startsWith('../') ? value : null
}

function isIdentifierQuery(value: string): boolean {
  return /^[\p{ID_Start}_$][\p{ID_Continue}$]*(?:\.[\p{ID_Start}_$][\p{ID_Continue}$]*)*$/u.test(value)
}

function looksLikePath(value: string): boolean {
  return /^(?:\.\/)?[^\0]+\.[A-Za-z0-9]+$/.test(value) && (value.includes('/') || value.includes('\\'))
}

function staticStringValues(node: ts.Expression | undefined): string[] | null {
  if (!node) return ['']
  if (ts.isStringLiteralLike(node)) return [node.text]
  if (ts.isArrayLiteralExpression(node)) {
    const values: string[] = []
    for (const element of node.elements) {
      if (!ts.isStringLiteralLike(element)) return null
      values.push(element.text)
    }
    return values
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue
      const name = property.name
      const propertyName = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null
      if (propertyName === 'path') return staticStringValues(property.initializer)
    }
  }
  return null
}

function decoratorName(expression: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return null
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []
}

function decoratorPaths(node: ts.Node, expectedName: string): string[] | null {
  for (const decorator of decoratorsOf(node)) {
    if (!ts.isCallExpression(decorator.expression)) continue
    if (decoratorName(decorator.expression.expression) !== expectedName) continue
    return staticStringValues(decorator.expression.arguments[0])
  }
  return null
}

function methodNameOf(member: ts.MethodDeclaration): string | undefined {
  if (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name) || ts.isNumericLiteral(member.name)) {
    return member.name.text
  }
  return undefined
}

function routeRequest(value: string): { method: string; path: string } | null {
  const match = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|ALL)\s+(\/\S*)$/i.exec(value.trim())
  if (!match?.[1] || !match[2]) return null
  return { method: match[1].toUpperCase(), path: normalizeRoutePath(match[2]) }
}

function sortEvidence(items: EvidenceItem[]): EvidenceItem[] {
  return [...items].sort((left, right) => {
    const pathOrder = codePointCompare(left.path, right.path)
    if (pathOrder !== 0) return pathOrder
    const lineOrder = left.range.start.line - right.range.start.line
    if (lineOrder !== 0) return lineOrder
    const columnOrder = left.range.start.column - right.range.start.column
    if (columnOrder !== 0) return columnOrder
    const kindOrder = codePointCompare(left.evidence_kind, right.evidence_kind)
    if (kindOrder !== 0) return kindOrder
    return codePointCompare(left.name ?? '', right.name ?? '')
  })
}

function dedupeEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>()
  const result: EvidenceItem[] = []
  for (const item of sortEvidence(items)) {
    const key = canonicalJson({
      path: item.path,
      range: item.range,
      evidence_kind: item.evidence_kind,
      name: item.name ?? null,
      symbol_kind: item.symbol_kind ?? null,
      route_method: item.route_method ?? null,
      route_path: item.route_path ?? null,
      is_definition: item.is_definition ?? null,
    })
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

export class EvidenceNavigator {
  readonly rootDir: string
  readonly repositoryRevision: string
  readonly maxSearchResults: number
  readonly maxScannedFiles: number
  readonly maxFileBytes: number
  private projectState: ProjectState | null | undefined
  private configPathHint: string | null | undefined

  constructor(options: EvidenceNavigatorOptions) {
    const resolved = resolve(options.rootDir)
    const stat = statSync(resolved)
    if (!stat.isDirectory()) throw new Error(`Evidence root is not a directory: ${resolved}`)
    this.rootDir = realpathSync(resolved)
    this.repositoryRevision = readGitRevision(this.rootDir)
    this.maxSearchResults = Math.max(1, Math.min(options.maxSearchResults ?? DEFAULT_MAX_RESULTS, 500))
    this.maxScannedFiles = Math.max(1, Math.min(options.maxScannedFiles ?? DEFAULT_MAX_SCANNED_FILES, 100_000))
    this.maxFileBytes = Math.max(1_024, Math.min(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 10_000_000))
  }

  resolveAnchor(anchor: string, limit = this.maxSearchResults): EvidenceResult {
    const query = anchor.trim()
    if (!query) return this.finish('resolve_anchor', 'unresolved', 'madar-exact', query, [], false, 'anchor must not be empty')

    const route = routeRequest(query)
    if (route) {
      return this.resolveRoute(query, route, limit)
    }

    if (looksLikePath(query)) {
      const pathItem = this.resolvePath(query)
      return pathItem
        ? this.finish('resolve_anchor', 'exact_resolved', 'madar-exact', query, [pathItem], false)
        : this.finish('resolve_anchor', 'unresolved', 'madar-exact', query, [], false, 'exact repository-relative path was not found')
    }

    if (isIdentifierQuery(query)) {
      const symbols = this.symbolCandidates(query, limit)
      if (symbols.state === 'unsupported') {
        const literal = this.literalItems(query, limit)
        if (literal.items.length > 0) {
          return this.finish('resolve_anchor', literal.truncated ? 'truncated' : literal.items.length === 1 ? 'exact_resolved' : 'ambiguous', 'madar-exact', query, literal.items, literal.truncated)
        }
        return this.finish('resolve_anchor', 'unsupported', 'typescript-language-service', query, [], false, symbols.detail)
      }
      if (symbols.items.length > 0) {
        const resolution: EvidenceResolution = symbols.truncated
          ? 'truncated'
          : symbols.items.length === 1 ? 'exact_resolved' : 'ambiguous'
        return this.finish('resolve_anchor', resolution, 'typescript-language-service', query, symbols.items, symbols.truncated)
      }
    }

    const literal = this.literalItems(query, limit)
    if (literal.items.length === 0) {
      return this.finish('resolve_anchor', 'unresolved', 'madar-exact', query, [], false, 'no exact path, route, symbol, or literal occurrence was found')
    }
    return this.finish(
      'resolve_anchor',
      literal.truncated ? 'truncated' : literal.items.length === 1 ? 'exact_resolved' : 'ambiguous',
      'madar-exact',
      query,
      literal.items,
      literal.truncated,
    )
  }

  searchExact(literal: string, limit = this.maxSearchResults): EvidenceResult {
    const query = literal
    if (query.length === 0) return this.finish('search_exact', 'unresolved', 'madar-exact', query, [], false, 'literal must not be empty')
    const found = this.literalItems(query, limit)
    if (found.items.length === 0) return this.finish('search_exact', 'unresolved', 'madar-exact', query, [], false, 'exact literal was not found')
    return this.finish(
      'search_exact',
      found.truncated ? 'truncated' : found.items.length === 1 ? 'exact_resolved' : 'ambiguous',
      'madar-exact',
      query,
      found.items,
      found.truncated,
    )
  }

  readEvidence(path: string, startLine = 1, endLine = startLine + 79): EvidenceResult {
    const query = path.trim()
    const fileName = safeExistingFile(this.rootDir, query)
    if (!fileName) return this.finish('read_evidence', 'unresolved', 'madar-exact', query, [], false, 'path must name an existing repository-relative file and may not escape the repository')
    const relativePath = relativeEvidencePath(this.rootDir, fileName)
    if (!relativePath) return this.finish('read_evidence', 'unresolved', 'madar-exact', query, [], false, 'resolved path escaped the repository')
    let text: string
    try {
      const stat = statSync(fileName)
      if (stat.size > this.maxFileBytes) return this.finish('read_evidence', 'unsupported', 'madar-exact', query, [], false, `file exceeds ${this.maxFileBytes} byte prototype read limit`)
      text = readFileSync(fileName, 'utf8')
    } catch {
      return this.finish('read_evidence', 'unresolved', 'madar-exact', query, [], false, 'file could not be read as UTF-8 evidence')
    }
    const lines = text.split(/\r?\n/)
    const boundedStart = Math.max(1, Math.min(Math.trunc(startLine), Math.max(1, lines.length)))
    const requestedEnd = Math.max(boundedStart, Math.trunc(endLine))
    const boundedEnd = Math.min(lines.length, Math.min(requestedEnd, boundedStart + MAX_READ_LINES - 1))
    const preview = lines.slice(boundedStart - 1, boundedEnd).join('\n')
    const truncated = requestedEnd > boundedEnd
    const item: EvidenceItem = {
      path: relativePath,
      range: {
        start: { line: boundedStart, column: 1 },
        end: { line: boundedEnd, column: (lines[boundedEnd - 1]?.length ?? 0) + 1 },
      },
      evidence_kind: 'source',
      preview,
    }
    return this.finish('read_evidence', truncated ? 'truncated' : 'exact_resolved', 'madar-exact', query, [item], truncated)
  }

  definition(request: LocationRequest): EvidenceResult {
    return this.semanticLocationOperation('definition', request)
  }

  references(request: LocationRequest): EvidenceResult {
    return this.semanticLocationOperation('references', request)
  }

  private semanticLocationOperation(operation: 'definition' | 'references', request: LocationRequest): EvidenceResult {
    const query = request.anchor?.trim() ?? `${request.path ?? ''}:${request.line ?? ''}:${request.column ?? ''}`
    const project = this.ensureProject()
    if (!project) {
      return this.finish(operation, 'unsupported', 'typescript-language-service', query, [], false, 'no usable tsconfig.json was found for this repository')
    }

    let location: CandidateLocation | null = null
    if (request.path) {
      const fileName = safeExistingFile(this.rootDir, request.path)
      if (!fileName) return this.finish(operation, 'unresolved', 'typescript-language-service', query, [], false, 'path must name an existing repository-relative file')
      const source = project.languageService.getProgram()?.getSourceFile(fileName)
      if (!source) return this.finish(operation, 'unsupported', 'typescript-language-service', query, [], false, 'file is not part of the active TypeScript project')
      const line = Math.max(1, Math.trunc(request.line ?? 1))
      const column = Math.max(1, Math.trunc(request.column ?? 1))
      const lineStarts = source.getLineStarts()
      if (line > lineStarts.length) return this.finish(operation, 'unresolved', 'typescript-language-service', query, [], false, 'requested line is outside the file')
      const lineStart = lineStarts[line - 1] ?? 0
      const lineEnd = line < lineStarts.length ? (lineStarts[line] ?? source.text.length) : source.text.length
      const position = Math.min(lineEnd, lineStart + column - 1)
      location = { fileName, start: position, length: 0 }
    } else if (request.anchor) {
      const candidates = this.symbolCandidateLocations(request.anchor, request.limit ?? this.maxSearchResults)
      if (candidates.state === 'unsupported') return this.finish(operation, 'unsupported', 'typescript-language-service', query, [], false, candidates.detail)
      if (candidates.items.length === 0) return this.finish(operation, 'unresolved', 'typescript-language-service', query, [], false, 'exact symbol was not resolved')
      if (candidates.items.length > 1 || candidates.truncated) {
        const evidence = candidates.items.map((candidate) => this.candidateEvidence(candidate, 'symbol')).filter((item): item is EvidenceItem => item !== null)
        return this.finish(operation, candidates.truncated ? 'truncated' : 'ambiguous', 'typescript-language-service', query, evidence, candidates.truncated, 'select an unambiguous source location before semantic navigation')
      }
      location = candidates.items[0] ?? null
    }

    if (!location) return this.finish(operation, 'unresolved', 'typescript-language-service', query, [], false, 'anchor or source location is required')

    if (operation === 'definition') {
      const definitions = project.languageService.getDefinitionAtPosition(location.fileName, location.start) ?? []
      const evidence = dedupeEvidence(definitions.flatMap((definition) => {
        const item = this.locationEvidence(definition.fileName, definition.textSpan.start, definition.textSpan.length, 'definition', {
          name: definition.name,
          symbol_kind: definition.kind,
          is_definition: true,
        })
        return item ? [item] : []
      }))
      return evidence.length === 0
        ? this.finish(operation, 'unresolved', 'typescript-language-service', query, [], false, 'provider returned no definition for the resolved location')
        : this.finish(operation, evidence.length === 1 ? 'exact_resolved' : 'ambiguous', 'typescript-language-service', query, evidence, false)
    }

    const referencedSymbols = project.languageService.findReferences(location.fileName, location.start) ?? []
    const flattened: EvidenceItem[] = []
    for (const symbol of referencedSymbols) {
      const definition = symbol.definition
      const definitionItem = this.locationEvidence(definition.fileName, definition.textSpan.start, definition.textSpan.length, 'definition', {
        name: definition.name,
        symbol_kind: definition.kind,
        is_definition: true,
      })
      if (definitionItem) flattened.push(definitionItem)
      for (const reference of symbol.references) {
        const item = this.locationEvidence(reference.fileName, reference.textSpan.start, reference.textSpan.length, 'reference', {
          ...(reference.isDefinition !== undefined ? { is_definition: reference.isDefinition } : {}),
        })
        if (item) flattened.push(item)
      }
    }
    const deduped = dedupeEvidence(flattened)
    const limit = Math.max(1, Math.min(request.limit ?? this.maxSearchResults, this.maxSearchResults))
    const truncated = deduped.length > limit
    const evidence = deduped.slice(0, limit)
    return evidence.length === 0
      ? this.finish(operation, 'unresolved', 'typescript-language-service', query, [], false, 'provider returned no references for the resolved location')
      : this.finish(operation, truncated ? 'truncated' : evidence.length === 1 ? 'exact_resolved' : 'ambiguous', 'typescript-language-service', query, evidence, truncated)
  }

  private resolvePath(query: string): EvidenceItem | null {
    const fileName = safeExistingFile(this.rootDir, query)
    if (!fileName) return null
    const relativePath = relativeEvidencePath(this.rootDir, fileName)
    if (!relativePath) return null
    return {
      path: relativePath,
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      evidence_kind: 'path',
      name: relativePath,
    }
  }

  private resolveRoute(query: string, route: { method: string; path: string }, limit: number): EvidenceResult {
    const project = this.ensureProject()
    if (!project) return this.finish('resolve_anchor', 'unsupported', 'typescript-language-service', query, [], false, 'route resolution requires a usable TypeScript project')
    const program = project.languageService.getProgram()
    if (!program) return this.finish('resolve_anchor', 'unsupported', 'typescript-language-service', query, [], false, 'TypeScript provider did not create a program')
    const items: EvidenceItem[] = []

    for (const sourceFile of program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue
      const relativePath = relativeEvidencePath(this.rootDir, sourceFile.fileName)
      if (!relativePath) continue

      const visit = (node: ts.Node): void => {
        if (ts.isClassDeclaration(node)) {
          const controllerPaths = decoratorPaths(node, 'Controller')
          if (controllerPaths) {
            for (const member of node.members) {
              if (!ts.isMethodDeclaration(member)) continue
              for (const decorator of decoratorsOf(member)) {
                if (!ts.isCallExpression(decorator.expression)) continue
                const routeDecorator = decoratorName(decorator.expression.expression)
                if (!routeDecorator) continue
                const method = ROUTE_METHODS.get(routeDecorator)
                if (!method || method !== route.method) continue
                const methodPaths = staticStringValues(decorator.expression.arguments[0])
                if (!methodPaths) continue
                for (const controllerPath of controllerPaths) {
                  for (const methodPath of methodPaths) {
                    const fullPath = normalizeRoutePath(controllerPath, methodPath)
                    if (fullPath !== route.path) continue
                    const start = member.name.getStart(sourceFile)
                    const length = member.name.getWidth(sourceFile)
                    const memberName = methodNameOf(member)
                    items.push({
                      path: relativePath,
                      range: spanRange(sourceFile, start, length),
                      evidence_kind: 'route',
                      ...(memberName ? { name: memberName } : {}),
                      ...(node.name?.text ? { container_name: node.name.text } : {}),
                      route_method: method,
                      route_path: fullPath,
                      preview: lineTextAt(sourceFile.text, member.getStart(sourceFile)),
                    })
                  }
                }
              }
            }
          }
        }

        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const method = DIRECT_ROUTE_METHODS.get(node.expression.name.text)
          if (method === route.method) {
            const paths = staticStringValues(node.arguments[0])
            if (paths?.some((candidate) => normalizeRoutePath(candidate) === route.path)) {
              items.push({
                path: relativePath,
                range: spanRange(sourceFile, node.getStart(sourceFile), Math.max(1, node.expression.getWidth(sourceFile))),
                evidence_kind: 'route',
                name: node.expression.name.text,
                route_method: method,
                route_path: route.path,
                preview: lineTextAt(sourceFile.text, node.getStart(sourceFile)),
              })
            }
          }
        }

        ts.forEachChild(node, visit)
      }
      visit(sourceFile)
    }

    const deduped = dedupeEvidence(items)
    const boundedLimit = Math.max(1, Math.min(limit, this.maxSearchResults))
    const truncated = deduped.length > boundedLimit
    const evidence = deduped.slice(0, boundedLimit)
    if (evidence.length === 0) return this.finish('resolve_anchor', 'unresolved', 'typescript-language-service', query, [], false, `no exact ${route.method} ${route.path} route registration was found`)
    return this.finish('resolve_anchor', truncated ? 'truncated' : evidence.length === 1 ? 'exact_resolved' : 'ambiguous', 'typescript-language-service', query, evidence, truncated)
  }

  private symbolCandidates(query: string, limit: number): { state: 'available' | 'unsupported'; items: EvidenceItem[]; truncated: boolean; detail?: string } {
    const candidates = this.symbolCandidateLocations(query, limit)
    if (candidates.state === 'unsupported') return { state: 'unsupported', items: [], truncated: false, ...(candidates.detail ? { detail: candidates.detail } : {}) }
    return {
      state: 'available',
      items: candidates.items.map((candidate) => this.candidateEvidence(candidate, 'symbol')).filter((item): item is EvidenceItem => item !== null),
      truncated: candidates.truncated,
    }
  }

  private symbolCandidateLocations(query: string, limit: number): { state: 'available' | 'unsupported'; items: CandidateLocation[]; truncated: boolean; detail?: string } {
    const project = this.ensureProject()
    if (!project) return { state: 'unsupported', items: [], truncated: false, detail: 'no usable tsconfig.json was found for this repository' }
    const pieces = query.split('.')
    const name = pieces.pop() ?? query
    const qualifier = pieces.join('.')
    const qualifierTail = pieces[pieces.length - 1] ?? ''
    const maxResultCount = Math.max(this.maxSearchResults * 4, Math.min(limit * 4, 2_000))
    const raw = project.languageService.getNavigateToItems(name, maxResultCount, undefined, true, true)
    const exact = raw.filter((item) => {
      if (item.name !== name) return false
      if (!relativeEvidencePath(this.rootDir, item.fileName)) return false
      if (!qualifier) return true
      const container = item.containerName ?? ''
      return container === qualifier || container === qualifierTail || container.endsWith(`.${qualifier}`)
    })
    const deduped = new Map<string, CandidateLocation>()
    for (const item of exact) {
      const key = `${item.fileName}\u0000${item.textSpan.start}\u0000${item.textSpan.length}\u0000${item.name}\u0000${item.kind}`
      if (!deduped.has(key)) {
        deduped.set(key, {
          fileName: item.fileName,
          start: item.textSpan.start,
          length: item.textSpan.length,
          name: item.name,
          kind: item.kind,
          ...(item.containerName ? { containerName: item.containerName } : {}),
        })
      }
    }
    const sorted = [...deduped.values()].sort((left, right) => {
      const leftPath = relativeEvidencePath(this.rootDir, left.fileName) ?? left.fileName
      const rightPath = relativeEvidencePath(this.rootDir, right.fileName) ?? right.fileName
      const pathOrder = codePointCompare(leftPath, rightPath)
      return pathOrder !== 0 ? pathOrder : left.start - right.start
    })
    const boundedLimit = Math.max(1, Math.min(limit, this.maxSearchResults))
    return { state: 'available', items: sorted.slice(0, boundedLimit), truncated: sorted.length > boundedLimit }
  }

  private candidateEvidence(candidate: CandidateLocation, evidenceKind: EvidenceKind): EvidenceItem | null {
    return this.locationEvidence(candidate.fileName, candidate.start, candidate.length, evidenceKind, {
      ...(candidate.name ? { name: candidate.name } : {}),
      ...(candidate.kind ? { symbol_kind: candidate.kind } : {}),
      ...(candidate.containerName ? { container_name: candidate.containerName } : {}),
      is_definition: true,
    })
  }

  private locationEvidence(
    fileName: string,
    start: number,
    length: number,
    evidenceKind: EvidenceKind,
    extras: Omit<EvidenceItem, 'path' | 'range' | 'evidence_kind'> = {},
  ): EvidenceItem | null {
    const relativePath = relativeEvidencePath(this.rootDir, fileName)
    if (!relativePath) return null
    let text: string
    try {
      text = readFileSync(fileName, 'utf8')
    } catch {
      return null
    }
    const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false)
    return {
      path: relativePath,
      range: spanRange(sourceFile, start, length),
      evidence_kind: evidenceKind,
      ...extras,
      preview: lineTextAt(text, start),
    }
  }

  private literalItems(literal: string, limit: number): { items: EvidenceItem[]; truncated: boolean } {
    const files = this.textFiles()
    const boundedLimit = Math.max(1, Math.min(limit, this.maxSearchResults))
    const items: EvidenceItem[] = []
    let truncated = false

    outer: for (const fileName of files) {
      let text: string
      try {
        if (statSync(fileName).size > this.maxFileBytes) continue
        text = readFileSync(fileName, 'utf8')
      } catch {
        continue
      }
      let offset = 0
      while (offset <= text.length) {
        const index = text.indexOf(literal, offset)
        if (index < 0) break
        const relativePath = relativeEvidencePath(this.rootDir, fileName)
        if (relativePath) {
          items.push({
            path: relativePath,
            range: offsetRange(text, index, literal.length),
            evidence_kind: 'literal',
            name: literal,
            preview: lineTextAt(text, index),
          })
          if (items.length > boundedLimit) {
            truncated = true
            break outer
          }
        }
        offset = index + Math.max(1, literal.length)
      }
    }

    return { items: sortEvidence(items).slice(0, boundedLimit), truncated }
  }

  private textFiles(): string[] {
    const files: string[] = []
    const visit = (directory: string): void => {
      if (files.length >= this.maxScannedFiles) return
      let entries
      try {
        entries = readdirSync(directory, { withFileTypes: true })
      } catch {
        return
      }
      entries.sort((left, right) => codePointCompare(left.name, right.name))
      for (const entry of entries) {
        if (files.length >= this.maxScannedFiles) return
        if (entry.isSymbolicLink()) continue
        const absolutePath = resolve(directory, entry.name)
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) visit(absolutePath)
          continue
        }
        if (!entry.isFile()) continue
        const extension = extname(entry.name).toLowerCase()
        if (TEXT_EXTENSIONS.has(extension) || entry.name === 'package.json' || entry.name.startsWith('tsconfig')) files.push(absolutePath)
      }
    }
    visit(this.rootDir)
    return files
  }

  private projectConfigRelativePath(): string | null {
    if (this.projectState) return this.projectState.configRelativePath
    if (this.configPathHint === undefined) {
      this.configPathHint = ts.findConfigFile(this.rootDir, ts.sys.fileExists, 'tsconfig.json') ?? null
    }
    if (!this.configPathHint) return null
    return relativeEvidencePath(this.rootDir, this.configPathHint) ?? normalizeSlash(relative(this.rootDir, this.configPathHint))
  }

  private ensureProject(): ProjectState | null {
    if (this.projectState !== undefined) return this.projectState
    const configPath = this.configPathHint === undefined
      ? (ts.findConfigFile(this.rootDir, ts.sys.fileExists, 'tsconfig.json') ?? null)
      : this.configPathHint
    this.configPathHint = configPath
    if (!configPath) {
      this.projectState = null
      return null
    }
    const read = ts.readConfigFile(configPath, ts.sys.readFile)
    if (read.error) {
      this.projectState = null
      return null
    }
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath)
    if (parsed.errors.length > 0 && parsed.fileNames.length === 0) {
      this.projectState = null
      return null
    }

    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => parsed.options,
      getScriptFileNames: () => parsed.fileNames,
      getScriptVersion: () => '0',
      getScriptSnapshot: (fileName) => {
        if (!ts.sys.fileExists(fileName)) return undefined
        const text = ts.sys.readFile(fileName)
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
      },
      getCurrentDirectory: () => this.rootDir,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      ...(ts.sys.realpath ? { realpath: ts.sys.realpath } : {}),
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getNewLine: () => ts.sys.newLine,
      getProjectVersion: () => '0',
    }
    const languageService = ts.createLanguageService(host, ts.createDocumentRegistry())
    const relativeConfig = relativeEvidencePath(this.rootDir, configPath) ?? normalizeSlash(relative(this.rootDir, configPath))
    this.projectState = { configPath, configRelativePath: relativeConfig, parsed, languageService }
    return this.projectState
  }

  private finish(
    operation: EvidenceResult['operation'],
    resolution: EvidenceResolution,
    provider: EvidenceResult['provider'],
    query: string,
    evidence: EvidenceItem[],
    truncated: boolean,
    detail?: string,
  ): EvidenceResult {
    const project = provider === 'typescript-language-service' ? this.ensureProject() : this.projectState ?? null
    const configPath = project?.configRelativePath ?? this.projectConfigRelativePath()
    const withoutDigest: Omit<EvidenceResult, 'digest'> = {
      schema_version: 1,
      operation,
      resolution,
      provider,
      provider_version: provider === 'typescript-language-service' ? ts.version : '1',
      repository_revision: this.repositoryRevision,
      project: {
        config_path: configPath,
        provider_capability: project || configPath ? 'available' : 'unsupported',
      },
      query,
      truncated,
      evidence: dedupeEvidence(evidence),
      ...(detail ? { detail } : {}),
    }
    return { ...withoutDigest, digest: resultDigest(withoutDigest) }
  }
}
