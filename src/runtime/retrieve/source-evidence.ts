import { realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

import { sourceFunctionOccurrence } from '../../shared/source-function-occurrences.js'
import { JS_TS_SOURCE_EXTENSIONS } from '../../shared/source-extensions.js'
import { isPackageManifestPath, readPackageManifest } from '../../shared/package-manifest.js'
import type { KnowledgeGraph } from '../../contracts/graph.js'
import { sensitiveArtifactReason } from '../../shared/discovery-safety.js'
import { readBoundedSource, sourcePathsAllowedByCurrentPolicy } from '../../shared/source-access.js'
import { lineRangeFromSourceLocation, type SourceLineRange } from '../../shared/source-location.js'
import { tokenizeQuestion } from './pipeline.js'
import { extractPromptExclusions, retrievalEvidencePrompt, retrievalSearchPrompt } from '../retrieval-gate.js'
import { selectedCallbackExcerptLines } from './source-callback-excerpts.js'

const SOURCE_EXTENSIONS = new Set([...JS_TS_SOURCE_EXTENSIONS, '.py', '.go', '.rs', '.java', '.kt', '.kts', '.rb', '.php', '.c', '.cc', '.cpp', '.h', '.cs', '.swift', '.scala', '.sh', '.sql', '.vue', '.svelte'])
const MAX_FILE_BYTES = 256 * 1024
const MAX_SEARCH_BYTES = 16 * 1024 * 1024
const MAX_SEARCH_FILES = 1024
const MAX_OWNER_ASSIGNMENTS = 500_000
const MAX_SOURCE_MATCHES = 128
const MAX_COMPLETE_LINES = 80
const MAX_EXCERPT_CHARS = 12_000
const BODY_BM25_K1 = 1.2
const BODY_BM25_B = 0.75
const BODY_QUERY_NOISE = new Set(['code', 'function', 'functions', 'method', 'methods', 'class', 'explain', 'find', 'show', 'handled', 'handle', 'where', 'defined', 'definition', 'work', 'works', 'called', 'calls', 'flow', 'end', 'implement', 'implementation', 'return', 'returns', 'thrown', 'throws', 'than'])
type DeclarationKind = 'function' | 'class' | 'type' | 'value'
type SourceDeclaration = SourceLineRange & {
  name: string; qualifiedName: string; nameLine: number; kind: DeclarationKind
  node: ts.Node; occurrence?: true; enclosingValue?: ts.VariableDeclaration
}
const declarationCache = new WeakMap<readonly string[], SourceDeclaration[]>()
const declarationParseErrors = new WeakSet<readonly string[]>()
const syntaxCache = new WeakMap<readonly string[], ts.SourceFile>()

/** Reuse only the parse of these exact, already-read lines and this language. */
export function sourceSyntaxTree(lines: readonly string[], sourceFile: string): ts.SourceFile {
  const cached = syntaxCache.get(lines)
  if (cached?.fileName === sourceFile) return cached
  const source = ts.createSourceFile(sourceFile, lines.join('\n'), ts.ScriptTarget.Latest, true)
  syntaxCache.set(lines, source)
  return source
}

export interface EvidenceLineRange { start_line: number; end_line: number }

export interface SourceBodyMatch {
  score: number
  exact_literal: boolean
  /** All matching lines are static module navigation for this behavior query. */
  navigation_only?: true
  /** Distinct query evidence covered, weighted by frequency among source owners. */
  coverage: number
  /** Length-normalized lexical rank; separate from coverage and literal admission. */
  relevance?: number
  matched_literals: string[]
  lines: number[]
}

export interface SourceBodySearch {
  matches: Map<string, SourceBodyMatch>
  scanned_files: number
  scanned_bytes: number
  bounded: boolean
}

function withinRoot(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path)
  return pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot)
}

export type SourceEvidencePathInspection =
  | { status: 'available'; path: string }
  | { status: 'bounded'; path: string; reason: 'source_file_byte_limit'; maxBytes: number }
  | { status: 'unavailable' }

/** The index is not authority to read arbitrary paths or symlink targets.
 * A bounded path still requires the caller's current ignore and request scope.
 */
export function inspectSourceEvidencePath(sourceFile: string, rootPath?: string): SourceEvidencePathInspection {
  if (isPackageManifestPath(sourceFile)) {
    const path = readPackageManifest(sourceFile, rootPath)?.path
    return path ? { status: 'available', path } : { status: 'unavailable' }
  }
  try {
    const root = resolve(rootPath ?? dirname(resolve(sourceFile)))
    const path = resolve(root, sourceFile)
    if (!SOURCE_EXTENSIONS.has(extname(path).toLowerCase()) || !withinRoot(path, root)) return { status: 'unavailable' }
    if (sensitiveArtifactReason(path, root, { isSourceFile: true })) return { status: 'unavailable' }
    const realRoot = realpathSync(root)
    const realPath = realpathSync(path)
    if (!SOURCE_EXTENSIONS.has(extname(realPath).toLowerCase()) || !withinRoot(realPath, realRoot) || sensitiveArtifactReason(realPath, realRoot, { isSourceFile: true })) return { status: 'unavailable' }
    const stat = statSync(realPath)
    if (!stat.isFile()) return { status: 'unavailable' }
    return stat.size <= MAX_FILE_BYTES ? { status: 'available', path: realPath }
      : { status: 'bounded', path: realPath, reason: 'source_file_byte_limit', maxBytes: MAX_FILE_BYTES }
  } catch {
    return { status: 'unavailable' }
  }
}

/** Preserve the ordinary evidence reader's path and size policy. */
export function sourcePathForEvidence(sourceFile: string, rootPath?: string): string | null {
  const inspected = inspectSourceEvidencePath(sourceFile, rootPath)
  return inspected.status === 'available' ? inspected.path : null
}

export function readEvidenceLines(sourceFile: string, rootPath?: string, cache?: Map<string, string[] | null>): string[] | null {
  if (isPackageManifestPath(sourceFile)) return readPackageManifest(sourceFile, rootPath)?.text.split(/\r?\n/) ?? null
  const root = resolve(rootPath ?? dirname(resolve(sourceFile)))
  if (!sourcePathsAllowedByCurrentPolicy([sourceFile], root)) return null
  const path = sourcePathForEvidence(sourceFile, root)
  if (!path) return null
  if (cache?.has(path)) return cache.get(path) ?? null
  try {
    const text = readBoundedSource(resolve(root, sourceFile), root, realpathSync(root), MAX_FILE_BYTES, true, true).text
    if (!sourcePathsAllowedByCurrentPolicy([sourceFile], root)) return null
    const lines = text.split(/\r?\n/)
    cache?.set(path, lines)
    return lines
  } catch {
    cache?.set(path, null)
    return null
  }
}

function sourceSymbolName(label: string): string {
  const member = label.replace(/\(\)$/, '').split(/[.:]/).at(-1) ?? ''
  return member.startsWith('#') ? member : member.split('#').at(-1) ?? ''
}

/** Do not attribute current source to a symbol whose indexed range moved. */
export function sourceRangeMatchesSymbol(lines: readonly string[], range: SourceLineRange, label: string, sourceFile: string): boolean {
  if (!/\.[cm]?[jt]sx?$/i.test(sourceFile)) return true
  const name = sourceSymbolName(label)
  if (!/^#?[A-Za-z_$][\w$]*$/.test(name) || label === basename(sourceFile)) return true
  let declarations = declarationCache.get(lines)
  if (!declarations) {
    declarations = []
    const source = sourceSyntaxTree(lines, sourceFile)
    if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) declarationParseErrors.add(lines)
    const visit = (node: ts.Node): void => {
      const occurrence = sourceFunctionOccurrence(node, source)
      if (occurrence) {
        let enclosingValue: ts.VariableDeclaration | undefined
        if (ts.isFunctionExpression(node)) {
          for (let parent: ts.Node | undefined = node.parent; parent && !ts.isFunctionLike(parent); parent = parent.parent) {
            if (ts.isVariableDeclaration(parent)) { enclosingValue = parent; break }
          }
        }
        declarations!.push({ name: occurrence.name, qualifiedName: occurrence.qualifiedName,
          kind: 'function', start: occurrence.start, nameLine: occurrence.start, end: occurrence.end,
          node, occurrence: true, ...(enclosingValue ? { enclosingValue } : {}) })
      }
      const namedDeclaration = (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node)
        || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isVariableDeclaration(node)
        || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)
        || ts.isPropertyDeclaration(node)) && node.name && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name))
        ? node.name : undefined
      if (namedDeclaration || ts.isConstructorDeclaration(node)) {
        const declarationName = namedDeclaration?.text ?? 'constructor'
        const containers: string[] = []
        for (let parent = node.parent; parent; parent = parent.parent) {
          if ((ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isModuleDeclaration(parent)) && parent.name && ts.isIdentifier(parent.name)) containers.unshift(parent.name.text)
        }
        declarations!.push({
          node,
          name: declarationName,
          qualifiedName: [...containers, declarationName].join('.'),
          kind: ts.isClassDeclaration(node) ? 'class'
            : ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? 'type'
              : ts.isFunctionLike(node) || (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) ? 'function' : 'value',
          start: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          nameLine: source.getLineAndCharacterOfPosition((namedDeclaration ?? node).getStart(source)).line + 1,
          end: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    declarationCache.set(lines, declarations)
  }
  const expressionOccurrences = declarations.filter(entry => entry.occurrence
    && entry.start === range.start && entry.end === range.end)
  const requestedOccurrence = label.replace(/\(\)$/, '')
  const matchesOccurrence = expressionOccurrences.some(entry => entry.name === name
    && (!requestedOccurrence.includes('.') || requestedOccurrence === entry.qualifiedName))
  if (matchesOccurrence) {
    const occurrence = expressionOccurrences[0]!
    const identities = declarations.filter(entry => entry.name === name
      && entry.start <= range.start && entry.nameLine >= range.start
      && (!requestedOccurrence.includes('.') || requestedOccurrence === entry.qualifiedName)
      && (range.start === range.end || entry.end === range.end))
    // A wrapper value may contain this exact named callback on the same lines.
    // Only AST ancestry establishes that relationship; unrelated same-line
    // values and all other function occurrences remain competing identities.
    const independent = identities.filter(entry => !(entry.kind === 'value'
      && entry.node === occurrence.enclosingValue && entry.name === occurrence.name
      && entry.qualifiedName === occurrence.qualifiedName
      && entry.start === occurrence.start && entry.end === occurrence.end))
    if (declarationParseErrors.has(lines) || expressionOccurrences.length !== 1 || independent.length !== 1) return false
    const requested = label.replace(/\(\)$/, '')
    return occurrence.name === name && (!requested.includes('.') || requested === occurrence.qualifiedName)
  }
  // Synthetic framework labels have no declaration identity to validate.
  const atStart = declarations.filter((declaration) => !declaration.occurrence
    && declaration.start <= range.start && declaration.nameLine >= range.start)
  if (atStart.length === 0) return !/\(\)$/.test(label)
  const qualified = label.replace(/\(\)$/, '')
  return atStart.some((declaration) => declaration.name === name
    && (!declaration.occurrence || !declarationParseErrors.has(lines))
    && (!qualified.includes('.') || qualified.startsWith('.') || declaration.qualifiedName === qualified)
    && (range.end === range.start || declaration.end === range.end))
}

export function sourceDeclarationKind(lines: readonly string[], range: SourceLineRange, label: string, sourceFile: string): DeclarationKind | undefined {
  if (!sourceRangeMatchesSymbol(lines, range, label, sourceFile)) return undefined
  const name = sourceSymbolName(label)
  const declarations = declarationCache.get(lines)
  // Callable graph labels identify the verified source occurrence. A bare
  // wrapper variable keeps its value kind; this proves no runtime binding.
  if (/\(\)$/.test(label)) {
    const occurrence = declarations?.find(entry => entry.occurrence && entry.name === name
      && entry.start === range.start && entry.end === range.end
      && (!label.includes('.') || entry.qualifiedName === label.replace(/\(\)$/, '')))
    if (occurrence) return occurrence.kind
  }
  return declarations?.find(entry => entry.name === name && entry.start <= range.start && entry.nameLine >= range.start)?.kind
}

/** Default indexes may store bare method labels; ownership comes from source. */
export function sourceDeclarationQualifiedName(lines: readonly string[], range: SourceLineRange, label: string, sourceFile: string): string | undefined {
  if (!sourceRangeMatchesSymbol(lines, range, label, sourceFile) || declarationParseErrors.has(lines)) return undefined
  const name = sourceSymbolName(label)
  const identities = new Set(declarationCache.get(lines)?.filter(entry => entry.name === name
    && entry.start <= range.start && entry.nameLine >= range.start
    && (range.end === range.start || entry.end === range.end)).map(entry => entry.qualifiedName))
  // A line-only index can cover same-named members of distinct classes. The
  // first parser declaration is not proof that it owns this graph node.
  return identities.size === 1 ? identities.values().next().value : undefined
}

/** Recover complete named declarations from old point-only indexes without reading siblings. */
export function resolveSourceSymbolRange(lines: readonly string[], range: SourceLineRange, label: string, sourceFile: string): SourceLineRange | null {
  if (!sourceRangeMatchesSymbol(lines, range, label, sourceFile)) return null
  if (range.end > range.start) return range
  const name = sourceSymbolName(label)
  const qualified = label.replace(/\(\)$/, '')
  if (declarationCache.get(lines)?.some(entry => entry.occurrence && entry.name === name
    && entry.start === range.start && entry.end === range.end
    && (!qualified.includes('.') || entry.qualifiedName === qualified))) return range
  const declaration = declarationCache.get(lines)?.find((entry) => !entry.occurrence && entry.name === name
    && entry.start <= range.start && entry.nameLine >= range.start)
  if (declaration) return { start: range.start, end: declaration.end }
  if (extname(sourceFile) !== '.go' || !/^[A-Za-z_]\w*$/.test(name)) return range
  const firstLine = lines[range.start - 1] ?? ''
  if (!new RegExp(`^\\s*func(?:\\s+\\([^)]*\\))?\\s+${name}\\b`).test(firstLine)) return range
  let depth = 0
  let opened = false
  let quote = ''
  let blockComment = false
  for (let index = range.start - 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    for (let column = 0; column < line.length; column += 1) {
      const char = line[column]!
      const next = line[column + 1]
      if (blockComment) {
        if (char === '*' && next === '/') { blockComment = false; column += 1 }
        continue
      }
      if (quote) {
        if (char === '\\' && quote !== '`') { column += 1; continue }
        if (char === quote) quote = ''
        continue
      }
      if (char === '/' && next === '/') break
      if (char === '/' && next === '*') { blockComment = true; column += 1; continue }
      if (char === '"' || char === "'" || char === '`') { quote = char; continue }
      if (char === '{') { depth += 1; opened = true }
      if (char === '}') depth -= 1
      if (opened && depth === 0) return { start: range.start, end: index + 1 }
    }
  }
  return range
}

interface SourceQueryLiteralSpan { value: string; start: number; end: number }

function sourceQueryLiteralSpans(question: string): SourceQueryLiteralSpan[] {
  const quoted: SourceQueryLiteralSpan[] = []
  let fence: { marker: string; length: number } | undefined
  for (let start = 0; start < question.length;) {
    // Fence markers delimit code, not one large literal. Scan their contents
    // normally so strings inside a fenced example remain discoverable.
    if (start === 0 || question[start - 1] === '\n') {
      const newline = question.indexOf('\n', start)
      const end = newline < 0 ? question.length : newline
      const marker = /^[ \t]*(`{3,}|~{3,})([^\r\n]*)\r?$/.exec(question.slice(start, end))
      if (marker && (!fence && (marker[1]![0] !== '`' || !marker[2]!.includes('`'))
        || fence && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim())) {
        fence = fence ? undefined : { marker: marker[1]![0]!, length: marker[1]!.length }
        start = end + (newline < 0 ? 0 : 1)
        continue
      }
    }
    const quote = question[start]!
    if (quote === '\\') { start += 2; continue }
    // Python string prefixes and SQL N/E strings are code, while an arbitrary
    // word before an apostrophe is prose. Keep the prefix at a token boundary.
    const prefixedQuote = quote === "'" && /(?:^|[^\p{L}\p{N}_$])(?:[rubftne]|br|rb|fr|rf|tr|rt)$/iu.test(question.slice(Math.max(0, start - 4), start))
    if (!/[`"']/.test(quote) || quote === "'" && !fence && !prefixedQuote && /[\p{L}\p{N}_$]/u.test(question[start - 1] ?? '')) {
      start++
      continue
    }
    let width = 1
    if (quote === '`' && !fence) while (question[start + width] === '`') width++
    let cursor = start + width, end: number | undefined
    while (cursor < question.length) {
      const char = question[cursor]!
      if (quote !== '`' && /[\r\n]/.test(char)) break
      if (char === '\\') {
        // Preserve the source spelling of escapes; they only affect where the
        // quoted span ends, not the literal's value or its UTF-16 offsets.
        cursor += question[cursor + 1] === '\r' && question[cursor + 2] === '\n' ? 3 : 2
      } else if (char === quote) {
        let closingWidth = 1
        if (quote === '`') while (question[cursor + closingWidth] === '`') closingWidth++
        if (closingWidth === width) { end = cursor + width; break }
        cursor += closingWidth
      } else cursor++
    }
    // Outside a fence, paired backticks may delimit Markdown containing a
    // backtick. A lone empty pair is still consumed as an empty value.
    if (end === undefined && quote === '`' && width === 2) end = start + width
    if (end !== undefined) {
      const raw = question.slice(start + width, end - width), value = raw.trim()
      if (raw.length >= 2 && raw.length <= 160 && value.length >= 2 && !/[\r\n]/.test(raw)) quoted.push({ value, start, end })
    }
    // Consume empty, short, oversized and unmatched spans too. Reusing their
    // closing quote as a later opener used to manufacture unrelated literals.
    start = end ?? Math.max(start + width, cursor)
  }
  const identifiers = [...question.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[a-zA-Z_$][\w$]*(?:_[\w$]+|[a-z][A-Z][\w$]*)\b|\/[\w-]+(?:\/[\w:.-]+)+/g)].map((match) => ({
    value: match[0].trim(), start: match.index, end: match.index + match[0].length,
  }))
  // A qualified private name is not written contiguously at its declaration.
  // This creates candidates only; the caller still verifies the class owner.
  const privateNames = [...question.matchAll(/(?<![\w$/])#[A-Za-z_$][\w$]*/g)].map((match) => ({
    value: match[0].trim(), start: match.index, end: match.index + match[0].length,
  }))
  return [...quoted, ...identifiers, ...privateNames].filter((span) => span.value.length > 0)
}

export function sourceQueryLiterals(question: string): string[] {
  return [...new Set(sourceQueryLiteralSpans(question).map((span) => span.value))].slice(0, 8)
}

/** Mask recognized occurrences only; ordinary matching words outside them remain. */
export function sourceQueryWithoutLiteralSpans(question: string): string {
  const recognized = new Set(sourceQueryLiterals(question))
  const chars = question.split('')
  for (const span of sourceQueryLiteralSpans(question)) {
    if (recognized.has(span.value)) chars.fill(' ', span.start, span.end)
  }
  return chars.join('')
}

/** Query and source body terms share one vocabulary; exact literals stay separate. */
export function sourceBodyWords(text: string): string[] {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)
}

function bodyTerms(question: string): string[] {
  return [...new Set(tokenizeQuestion(sourceBodyWords(retrievalSearchPrompt(question)).join(' ')).filter((term) => term.length >= 3 && !BODY_QUERY_NOISE.has(term)))].slice(0, 32)
}

/** Preserve positions while hiding quoted text and balanced source calls from prose boundaries. */
export function sourceRequestProse(question: string): string {
  const chars = question.split('')
  const quotedEnd = (start: number): number => {
    const quote = question[start]
    for (let index = start + 1; index < question.length; index++) {
      if (question[index] === '\\') index++
      else if (question[index] === quote) return index + 1
    }
    return question.length
  }
  for (let index = 0; index < question.length;) {
    if (/[`"']/.test(question[index]!) && (index === 0 || !/[\w$]/.test(question[index - 1]!))) {
      const end = quotedEnd(index); chars.fill(' ', index, end); chars[index] = '#'; index = end; continue
    }
    const call = (index === 0 || !/[\w$]/.test(question[index - 1]!))
      ? /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(/.exec(question.slice(index)) : null
    if (call) {
      let end = index + call[0].length, depth = 1
      while (end < question.length && depth) {
        if (/[`"']/.test(question[end]!)) { end = quotedEnd(end); continue }
        if (question[end] === '(') depth++
        else if (question[end] === ')') depth--
        end++
      }
      chars.fill(' ', index, end); chars[index] = '#'; index = end; continue
    }
    index++
  }
  return chars.join('')
}

/** The fragment planner locates source witnesses; it does not plan a broad explanation. */
export function sourceQueryRequestsClauseLocations(positiveQuestion: string): boolean {
  if (positiveQuestion.length > 8192) return false
  const prose = sourceRequestProse(positiveQuestion).replace(
    /(?:\.\/)?[\w@-]+(?:[./\\][\w@*-]+)+/g, value => ' '.repeat(value.length),
  )
  // These requests need the existing relation/task selection, even when their
  // wording also asks to show source. Quoted code and paths cannot set intent.
  if (/\b(?:callers?|called|dependents?|impact|affected|changes?|modify|fix|debug|refactor|update)\b/i.test(prose)) return false
  if (/(?:^\s*|[.;!?]\s+|\band\s+)(?:(?:also|then|next)\s+)?(?:explain|describe|analyze|trace|how|why)\b/i.test(prose)) return false
  const requests = [...prose.matchAll(/(?:^\s*|[.;!?]\s+|\band\s+)(?:(?:please|also|then|next)\s+)*(find|locate|show)(?:\s+me)?\s+/gi)]
  if (requests.length < 2 || requests.length > 8 || requests[0]!.index !== 0) return false
  const bodies = requests.map((request, index) => prose.slice(request.index + request[0].length, requests[index + 1]?.index ?? prose.length).trim())
  if (!/\b(?:source|code|implementation|definitions?)\b/i.test(bodies[0]!)) return false
  return bodies.every(body => body.length > 0 && !/^(?:how|why|whether|what|when|which|explain)\b/i.test(body))
}

/** A field mentioned in a behavior question is evidence, not a symbol lookup. */
export function sourceQueryIsLiteralLookup(question: string): boolean {
  const literals = sourceQueryLiterals(question)
  const prose = sourceRequestProse(question)
  return literals.some((literal) => {
    const position = question.indexOf(literal)
    const prefix = question.slice(0, position).trim().replace(/[`"']$/, '').trim()
    const suffix = question.slice(position + literal.length)
    const proseSuffix = prose.slice(position + literal.length)
    // A location clause followed by another question needs task evidence, not
    // the fixed-size list of literal occurrences. Simple "thrown?" stays local.
    if (/(?:\b(?:and|or|but|then|also)\b|[.!?;,])\s*(?:explain\s+)?(?:how|why|when|whether|what)\b/i.test(proseSuffix)
      || /(?:[.!?;,]\s+|\b(?:and|or|but|then|also)\s+)(?:(?:also|then|next)\s+)?(?:find|locate|show|trace|explain|describe)\s+\S/i.test(proseSuffix)) return false
    if (!prefix) return suffix.replace(/[`"'?!.\s]/g, '').length === 0
    return /^(?:please\s+)?(?:where\s+(?:is|are|can\s+I\s+find)|(?:find|locate|show)(?:\s+me)?)(?:\s+(?:the|a|an|error|literal|string|identifier|symbol|function|method|definition|source|code|occurrences|locations|references|for|containing|of))*$/i.test(prefix)
  })
}

function matchesSourceLiteral(text: string, literal: string): boolean {
  if (!/^#?[A-Za-z_$][\w$]*$/.test(literal)) return text.includes(literal)
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}(?=$|[^A-Za-z0-9_$])`).test(text)
}

function lineMatch(text: string, literals: readonly string[], terms: readonly string[], words?: ReadonlySet<string>): { exact: boolean; literals: string[]; terms: string[] } {
  const matchedLiterals = literals.filter(literal => matchesSourceLiteral(text, literal))
  const lineWords = words ?? new Set(sourceBodyWords(text))
  return { exact: matchedLiterals.length > 0, literals: matchedLiterals, terms: terms.filter((term) => lineWords.has(term)) }
}

/** Search indexed source only, and assign hits to the smallest enclosing symbol. */
export function searchSourceBodies(graph: KnowledgeGraph, question: string, rootPath?: string, cache?: Map<string, string[] | null>): SourceBodySearch {
  return searchSourceBodyQuestions(graph, [question], rootPath, cache)[0]!
}

/** Static imports/exports identify navigation targets, not a file's behavior. */
function sourceNavigationLines(lines: readonly string[], sourceFile: string): Set<number> {
  const navigation = new Set<number>()
  if (!JS_TS_SOURCE_EXTENSIONS.includes(extname(sourceFile).toLowerCase())) return navigation
  const source = sourceSyntaxTree(lines, sourceFile)
  if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return navigation
  const statements = source.statements.map(statement => ({
    navigation: ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement) || ts.isExportDeclaration(statement),
    start: source.getLineAndCharacterOfPosition(statement.getStart(source)).line,
    end: source.getLineAndCharacterOfPosition(Math.max(statement.getStart(source), statement.getEnd() - 1)).line,
  }))
  for (const statement of statements.filter(statement => statement.navigation)) {
    for (let line = statement.start; line <= statement.end; line++) navigation.add(line)
  }
  // An import and executable statement can share a physical line. Preserve
  // that line as body evidence rather than guessing which occurrence matched.
  for (const statement of statements.filter(statement => !statement.navigation)) {
    for (let line = statement.start; line <= statement.end; line++) navigation.delete(line)
  }
  return navigation
}

/** Reuse source ownership and line tokens across already bounded query clauses. */
export function searchSourceBodyQuestions(graph: KnowledgeGraph, questions: readonly string[], rootPath?: string, cache?: Map<string, string[] | null>): SourceBodySearch[] {
  const queries = questions.map(question => {
    const literals = sourceQueryLiterals(question)
    const terms = bodyTerms(question)
    const literalLookup = sourceQueryIsLiteralLookup(question)
    const navigationLookup = literalLookup || /\b(?:imports?|imported|importing|exports?|exported|exporting|files?|filepath|paths?|directories|directory|folders?)\b/i.test(sourceRequestProse(question))
      || /\.[cm]?[jt]sx?\b/i.test(question)
    const behaviorTerms = literals.length > 0 && !literalLookup
      ? new Set(bodyTerms(sourceQueryWithoutLiteralSpans(question))) : undefined
    return { literals, terms, literalLookup, navigationLookup, behaviorTerms,
      bodyHits: new Map<string, { literals: Set<string>; terms: Set<string>; lines: number[]; navigationOnly: boolean }>() }
  })
  const activeQueries = queries.filter(query => query.literals.length > 0 || query.terms.length > 0)
  const result: SourceBodySearch = { matches: new Map(), scanned_files: 0, scanned_bytes: 0, bounded: false }
  if (!activeQueries.length) return queries.map(() => ({ ...result, matches: new Map() }))
  const rankingTerms = new Set(activeQueries.flatMap(query => query.terms))
  const ownerStatistics = new Map<string, { length: number; frequencies: Map<string, number> }>()
  const files = new Map<string, Array<{ id: string; label: string; range: SourceLineRange; file: boolean }>>()
  const hintLiterals = [...new Set(questions.flatMap(question => sourceQueryLiterals(retrievalEvidencePrompt(question))))]
  const hintedFiles = new Set<string>()
  for (const [id, node] of graph.nodeEntries()) {
    if (node.file_type !== 'code' || node.external_call === true) continue
    const path = String(node.source_file ?? '')
    const range = lineRangeFromSourceLocation(node.source_location)
    if (!path || !range) continue
    const entries = files.get(path) ?? []
    entries.push({ id, label: String(node.label ?? ''), range, file: String(node.label ?? '') === basename(path) })
    files.set(path, entries)
    // Index text only directs the bounded scan. Current source ownership and
    // matching below remain the sole authority for admission and ranking.
    if (!hintedFiles.has(path) && [node.label, node.snippet].some(text => typeof text === 'string'
      && hintLiterals.some(literal => matchesSourceLiteral(text, literal)))) hintedFiles.add(path)
  }
  let assignments = 0
  for (const [sourceFile, entries] of [...files].sort(([left], [right]) => (
    Number(hintedFiles.has(right)) - Number(hintedFiles.has(left)) || left.localeCompare(right)
  ))) {
    const path = sourcePathForEvidence(sourceFile, rootPath)
    if (!path) { result.bounded = true; continue }
    let size: number
    try { size = statSync(path).size } catch { result.bounded = true; continue }
    if (result.scanned_files >= MAX_SEARCH_FILES || result.scanned_bytes + size > MAX_SEARCH_BYTES) {
      result.bounded = true
      break
    }
    const lines = readEvidenceLines(sourceFile, rootPath, cache)
    if (!lines) { result.bounded = true; continue }
    result.scanned_files += 1
    result.scanned_bytes += size
    const fileOwner = entries.find((entry) => entry.file)?.id
    const navigationLines = fileOwner ? sourceNavigationLines(lines, sourceFile) : new Set<number>()
    const owners = new Array<string | undefined>(lines.length).fill(fileOwner)
    // Larger containers first; methods/inner declarations then replace their owners.
    const symbols = entries.filter((entry) => !entry.file).sort((left, right) => (
      (right.range.end - right.range.start) - (left.range.end - left.range.start)
      || left.id.localeCompare(right.id)
    ))
    for (const entry of symbols) {
      const range = resolveSourceSymbolRange(lines, entry.range, entry.label, sourceFile)
      if (!range) { result.bounded = true; continue }
      // Synthetic graph labels can retain navigation excerpts, but only a
      // current declaration can own JS/TS body matches at that source range.
      if (/\.[cm]?[jt]sx?$/i.test(sourceFile) && sourceDeclarationKind(lines, entry.range, entry.label, sourceFile) === undefined) continue
      const start = Math.max(0, range.start - 1)
      const end = Math.min(lines.length, range.end)
      if (assignments + end - start > MAX_OWNER_ASSIGNMENTS) { result.bounded = true; break }
      for (let index = start; index < end; index += 1) owners[index] = entry.id
      assignments += end - start
    }
    lines.forEach((line, index) => {
      const owner = owners[index]
      if (!owner) return
      const tokens = sourceBodyWords(line).filter(Boolean)
      const words = new Set(tokens)
      // Count every nonempty owner, including owners with no query matches.
      // Inner declarations already own their lines; their words must not also
      // inflate an enclosing function's relevance or length.
      if (tokens.length) {
        const statistics = ownerStatistics.get(owner) ?? { length: 0, frequencies: new Map<string, number>() }
        statistics.length += tokens.length
        for (const term of tokens) {
          if (rankingTerms.has(term)) statistics.frequencies.set(term, (statistics.frequencies.get(term) ?? 0) + 1)
        }
        ownerStatistics.set(owner, statistics)
      }
      for (const query of activeQueries) {
        const hit = lineMatch(line, query.literals, query.terms, words)
        if (!hit.exact && hit.terms.length === 0) continue
        const entry = query.bodyHits.get(owner) ?? { literals: new Set<string>(), terms: new Set<string>(), lines: [], navigationOnly: true }
        entry.navigationOnly &&= owner === fileOwner && navigationLines.has(index) && !query.navigationLookup
        hit.literals.forEach((literal) => entry.literals.add(literal))
        hit.terms.forEach((term) => entry.terms.add(term))
        if (entry.lines.length < 8) entry.lines.push(index + 1)
        query.bodyHits.set(owner, entry)
      }
    })
  }
  const documentCount = ownerStatistics.size
  let totalLength = 0
  const termDocuments = new Map<string, number>()
  for (const statistics of ownerStatistics.values()) {
    totalLength += statistics.length
    for (const term of statistics.frequencies.keys()) termDocuments.set(term, (termDocuments.get(term) ?? 0) + 1)
  }
  const averageLength = documentCount > 0 ? totalLength / documentCount : 1
  const inverseFrequency = (count: number): number => documentCount > 0
    ? Math.log(1 + (documentCount - Math.min(count, documentCount) + 0.5) / (Math.min(count, documentCount) + 0.5)) : 0
  const termWeights = new Map([...rankingTerms].map(term => [term, inverseFrequency(termDocuments.get(term) ?? 0)]))
  return queries.map(query => {
    const { literals, terms, literalLookup, behaviorTerms, bodyHits } = query
    if (!literals.length && !terms.length) return { matches: new Map(), scanned_files: 0, scanned_bytes: 0, bounded: false }
    const current: SourceBodySearch = { ...result, matches: new Map() }
    // Count presence once per enclosing source owner. Repeating a common field
    // cannot outweigh coverage of several distinct parts of the question.
    const frequencies = new Map<string, number>()
    for (const hit of bodyHits.values()) {
      for (const term of hit.terms) frequencies.set(`term:${term}`, (frequencies.get(`term:${term}`) ?? 0) + 1)
      for (const literal of hit.literals) frequencies.set(`literal:${literal}`, (frequencies.get(`literal:${literal}`) ?? 0) + 1)
    }
    const weight = (key: string): number => {
      const count = frequencies.get(key)
      return count ? 1 + Math.log((bodyHits.size + 1) / (count + 1)) : 0
    }
    const totalWeight = terms.reduce((sum, term) => sum + weight(`term:${term}`), 0)
      + literals.reduce((sum, literal) => sum + weight(`literal:${literal}`), 0)
    for (const [id, hit] of bodyHits) {
      const exact = hit.literals.size > 0
      // A lookup requires the occurrence. Mixed behavior can use other owners,
      // but literal fragments alone are not evidence for those other phases.
      if (literals.length > 0 && !exact
        && (literalLookup || ![...hit.terms].some((term) => behaviorTerms?.has(term)))) continue
      if (!exact && hit.terms.size === 0) continue
      const coveredWeight = [...hit.terms].reduce((sum, term) => sum + weight(`term:${term}`), 0)
        + [...hit.literals].reduce((sum, literal) => sum + weight(`literal:${literal}`), 0)
      const coverage = totalWeight > 0 ? coveredWeight / totalWeight : 0
      const statistics = ownerStatistics.get(id)
      const lengthNormalization = BODY_BM25_K1 * (1 - BODY_BM25_B + BODY_BM25_B * (statistics?.length ?? 0) / averageLength)
      const termFrequency = (frequency: number): number => frequency * (BODY_BM25_K1 + 1) / (frequency + lengthNormalization)
      const relevance = terms.reduce((sum, term) => sum + (termWeights.get(term) ?? 0) * termFrequency(statistics?.frequencies.get(term) ?? 0), 0)
        + [...hit.literals].reduce((sum, literal) => sum + inverseFrequency(frequencies.get(`literal:${literal}`) ?? 0) * termFrequency(1), 0)
      current.matches.set(id, { score: (exact ? 8 : 0) + Math.min(3, hit.terms.size * 0.5), exact_literal: exact, coverage, relevance, matched_literals: [...hit.literals], lines: hit.lines, ...(hit.navigationOnly ? { navigation_only: true } : {}) })
    }
    if (current.matches.size > MAX_SOURCE_MATCHES) current.bounded = true
    current.matches = new Map([...current.matches].sort((left, right) => Number(right[1].exact_literal) - Number(left[1].exact_literal) || (right[1].relevance ?? 0) - (left[1].relevance ?? 0) || right[1].coverage - left[1].coverage || right[1].score - left[1].score || left[0].localeCompare(right[0])).slice(0, MAX_SOURCE_MATCHES))
    return current
  })
}

export interface CoherentSourceSnippet {
  snippet: string
  lineNumber: number
  scope: 'symbol' | 'source_file'
  lineRange: EvidenceLineRange
  omittedRanges: EvidenceLineRange[]
}

/** Complete small bodies; bounded contiguous windows with omissions for large bodies. */
export function coherentSourceSnippet(lines: readonly string[], range: SourceLineRange, question: string, scope: 'symbol' | 'source_file', sourceFile?: string): CoherentSourceSnippet | null {
  const start = Math.max(1, range.start)
  const end = Math.min(lines.length, range.end)
  if (start > end) return null
  const whole = lines.slice(start - 1, end).join('\n')
  const selected = new Set<number>()
  if (end - start + 1 <= MAX_COMPLETE_LINES && whole.length <= MAX_EXCERPT_CHARS) {
    for (let line = start; line <= end; line += 1) selected.add(line)
  } else {
    const literals = sourceQueryLiterals(question)
    const terms = bodyTerms(question)
    const hits = lines.slice(start - 1, end).map((text, index) => {
      const hit = lineMatch(text, literals, terms)
      return { line: start + index, hit, score: (hit.exact ? 100 : 0) + hit.terms.length }
    })
    const focus = [...hits].sort((left, right) => right.score - left.score || left.line - right.line)[0]?.line ?? start
    for (let line = start; line <= Math.min(start + 3, end); line += 1) selected.add(line)
    for (let line = Math.max(start, focus - 12); line <= Math.min(end, focus + 20); line += 1) selected.add(line)
    selected.add(end)
    // A strong line can locate one part of a large owner while hiding a
    // separately requested branch. Preserve that first witness and add only
    // one bounded window for query evidence it does not already contain.
    if (scope === 'symbol' && !sourceQueryIsLiteralLookup(question)) {
      const positive = retrievalEvidencePrompt(question)
      const positiveLiterals = sourceQueryLiterals(positive)
      const positiveTerms = bodyTerms(positive)
      const positiveHits = hits.map(({ line }) => ({ line, hit: lineMatch(lines[line - 1] ?? '', positiveLiterals, positiveTerms) }))
      const covered = positiveHits.filter(entry => selected.has(entry.line))
      const coveredLiterals = new Set(covered.flatMap(entry => entry.hit.literals))
      const coveredTerms = new Set(covered.flatMap(entry => entry.hit.terms))
      const additional = positiveHits.map(entry => ({
        line: entry.line,
        score: entry.hit.literals.filter(literal => !coveredLiterals.has(literal)).length * 100
          + entry.hit.terms.filter(term => !coveredTerms.has(term)).length,
      })).filter(entry => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.line - right.line)[0]
      if (additional) {
        const expanded = new Set(selected)
        for (let line = Math.max(start, additional.line - 12); line <= Math.min(end, additional.line + 20); line += 1) expanded.add(line)
        // Optional source must not push an existing witness past the character
        // limit; omit the whole addition if both windows cannot fit.
        const chars = [...expanded].reduce((total, line) => total + (lines[line - 1]?.length ?? 0) + 1, 0)
        if (chars <= MAX_EXCERPT_CHARS) for (const line of expanded) selected.add(line)
      }
    }
    if (scope === 'symbol' && sourceFile && JS_TS_SOURCE_EXTENSIONS.includes(extname(sourceFile).toLowerCase())
      && question.trim() && question.length <= 8192 && !sourceQueryIsLiteralLookup(question)) {
      const exclusions = extractPromptExclusions(question)
      if (!exclusions.excludedTerms.length && !exclusions.excludedPathHints.length && !exclusions.excludedDomains.length) {
        const completion = selectedCallbackExcerptLines(sourceSyntaxTree(lines, sourceFile), lines, { start, end }, selected, MAX_COMPLETE_LINES, MAX_EXCERPT_CHARS)
        if (completion) for (const line of completion) selected.add(line)
      }
    }
  }
  const retained: number[] = []
  let chars = 0
  for (const line of [...selected].sort((left, right) => left - right)) {
    const length = (lines[line - 1] ?? '').length + 1
    // Never cut a source line into misleading code. Oversized lines are omitted explicitly.
    if (chars + length > MAX_EXCERPT_CHARS) continue
    retained.push(line)
    chars += length
  }
  if (retained.length === 0) return null
  const omittedRanges: EvidenceLineRange[] = []
  const text: string[] = []
  let next = start
  for (const line of retained) {
    if (line > next) {
      omittedRanges.push({ start_line: next, end_line: line - 1 })
      text.push(`[omitted lines ${next}-${line - 1}]`)
    }
    text.push(lines[line - 1] ?? '')
    next = line + 1
  }
  if (next <= end) {
    omittedRanges.push({ start_line: next, end_line: end })
    text.push(`[omitted lines ${next}-${end}]`)
  }
  return { snippet: text.join('\n'), lineNumber: retained[0]!, scope, lineRange: { start_line: start, end_line: end }, omittedRanges }
}
