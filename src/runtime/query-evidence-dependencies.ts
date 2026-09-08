import { extname } from 'node:path'

import * as ts from 'typescript'

export interface RepresentedQueryEvidenceSource {
  startLine: number
  endLine: number
  text: string
}

export interface OwnerDeclarationEvidenceLine {
  lineNumber: number
  text: string
}

export interface OwnerDeclarationEvidence {
  startLine: number
  endLine: number
  lines: OwnerDeclarationEvidenceLine[]
}

export interface OwnerDeclarationCompletionInput {
  sourceFilePath: string
  sourceLines: readonly string[]
  ownerRange: { start: number; end: number }
  representedSource: readonly RepresentedQueryEvidenceSource[]
}

export interface QueryEvidenceSourceProjection {
  text: string
  literalLineBreaks: Array<{ offset: number; lineNumber: number }>
  hasProtectedTokens: boolean
}

export interface CompleteSmallOwnerSourceInput {
  sourceFilePath: string
  sourceLines: readonly string[]
  ownerRange: { start: number; end: number }
  label: string
  nodeKind?: string
  externalCall?: boolean
}

export interface CompleteSmallOwnerSourceEvidence {
  snippet: string
  lineNumber: number
}

interface ParsedSourceSnapshot {
  sourceFilePath: string
  sourceText: string
  sourceFile: ts.SourceFile
}

interface SourceSnapshotProvenance {
  sourceFilePath: string
  normalizedSourceText: string
  sourceText: string
}

interface ConstBinding {
  declaration: ts.VariableDeclaration
  statement: ts.VariableStatement
}

type FunctionOwner = (
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration
) & { body: ts.ConciseBody }

const parsedSourceSnapshots = new WeakMap<readonly string[], ParsedSourceSnapshot>()
const sourceSnapshotProvenance = new WeakMap<readonly string[], SourceSnapshotProvenance>()
const sourceFilesWithNormalizedLineCaches = new WeakSet<ts.SourceFile>()
const JS_TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const COMPLETE_SMALL_OWNER_MAX_LINES = 25
const COMPLETE_SMALL_OWNER_MAX_CHARACTERS = 2000

/** Retains bytes from the existing source read alongside its normalized line cache. */
export function retainQueryEvidenceSourceSnapshot(input: {
  sourceFilePath: string
  sourceLines: readonly string[]
  sourceText: string
}): void {
  const normalizedSourceText = input.sourceLines.join('\n')
  if (input.sourceText.split(/\r?\n/).join('\n') !== normalizedSourceText) {
    sourceSnapshotProvenance.delete(input.sourceLines)
    return
  }
  sourceSnapshotProvenance.set(input.sourceLines, {
    sourceFilePath: input.sourceFilePath,
    normalizedSourceText,
    sourceText: input.sourceText,
  })
}

function scriptKindForPath(sourceFilePath: string): ts.ScriptKind | null {
  switch (extname(sourceFilePath).toLowerCase()) {
    case '.ts':
    case '.mts':
    case '.cts':
      return ts.ScriptKind.TS
    case '.tsx':
      return ts.ScriptKind.TSX
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS
    case '.jsx':
      return ts.ScriptKind.JSX
    default:
      return null
  }
}

function parsedSourceForSnapshot(
  sourceFilePath: string,
  sourceLines: readonly string[],
): ts.SourceFile | null {
  const extension = extname(sourceFilePath).toLowerCase()
  if (!JS_TS_EXTENSIONS.has(extension)) {
    return null
  }
  const scriptKind = scriptKindForPath(sourceFilePath)
  if (scriptKind === null) {
    return null
  }

  const normalizedSourceText = sourceLines.join('\n')
  const provenance = sourceSnapshotProvenance.get(sourceLines)
  const sourceText = (
    provenance?.sourceFilePath === sourceFilePath
    && provenance.normalizedSourceText === normalizedSourceText
  )
    ? provenance.sourceText
    : normalizedSourceText
  const cached = parsedSourceSnapshots.get(sourceLines)
  if (
    cached
    && cached.sourceFilePath === sourceFilePath
    && cached.sourceText === sourceText
  ) {
    return cached.sourceFile
  }

  const sourceFile = ts.createSourceFile(
    sourceFilePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  )
  if (sourceText !== normalizedSourceText) {
    sourceFilesWithNormalizedLineCaches.add(sourceFile)
  }
  parsedSourceSnapshots.set(sourceLines, { sourceFilePath, sourceText, sourceFile })
  return sourceFile
}

function lineRangeOf(node: ts.Node, sourceFile: ts.SourceFile): { start: number; end: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  const finalPosition = Math.max(node.getStart(sourceFile), node.getEnd() - 1)
  const end = sourceFile.getLineAndCharacterOfPosition(finalPosition).line + 1
  return { start, end }
}

function evidenceLineRangeOf(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
): { start: number; end: number } {
  const tokenRange = lineRangeOf(statement, sourceFile)
  let start = tokenRange.start
  let end = tokenRange.end

  const leadingComments = ts.getLeadingCommentRanges(
    sourceFile.text,
    statement.getFullStart(),
  ) ?? []
  for (let index = leadingComments.length - 1; index >= 0; index -= 1) {
    const comment = leadingComments[index]!
    const commentEnd = sourceFile.getLineAndCharacterOfPosition(
      Math.max(comment.pos, comment.end - 1),
    ).line + 1
    if (commentEnd !== start) {
      break
    }
    start = sourceFile.getLineAndCharacterOfPosition(comment.pos).line + 1
  }

  const trailingComments = ts.getTrailingCommentRanges(
    sourceFile.text,
    statement.getEnd(),
  ) ?? []
  for (const comment of trailingComments) {
    const commentStart = sourceFile.getLineAndCharacterOfPosition(comment.pos).line + 1
    if (commentStart > end) {
      break
    }
    end = Math.max(
      end,
      sourceFile.getLineAndCharacterOfPosition(
        Math.max(comment.pos, comment.end - 1),
      ).line + 1,
    )
  }

  return { start, end }
}

function functionOwnerWithBody(node: ts.Node): FunctionOwner | null {
  if (
    !ts.isFunctionDeclaration(node)
    && !ts.isFunctionExpression(node)
    && !ts.isArrowFunction(node)
    && !ts.isMethodDeclaration(node)
    && !ts.isGetAccessorDeclaration(node)
    && !ts.isSetAccessorDeclaration(node)
    && !ts.isConstructorDeclaration(node)
  ) {
    return null
  }
  return node.body ? node as FunctionOwner : null
}

function identifyingRangeOf(owner: FunctionOwner, sourceFile: ts.SourceFile): { start: number; end: number } {
  let wrapped: ts.Node = owner
  while (
    (ts.isParenthesizedExpression(wrapped.parent)
      || ts.isAsExpression(wrapped.parent)
      || ts.isSatisfiesExpression(wrapped.parent)
      || ts.isTypeAssertionExpression(wrapped.parent)
      || ts.isNonNullExpression(wrapped.parent))
    && wrapped.parent.expression === wrapped
  ) {
    wrapped = wrapped.parent
  }
  if (
    ts.isVariableDeclaration(wrapped.parent)
    && wrapped.parent.initializer === wrapped
    && ts.isVariableDeclarationList(wrapped.parent.parent)
    && ts.isVariableStatement(wrapped.parent.parent.parent)
  ) {
    return lineRangeOf(wrapped.parent.parent.parent, sourceFile)
  }
  return lineRangeOf(owner, sourceFile)
}

function uniquelyIdentifiedOwner(
  sourceFile: ts.SourceFile,
  ownerRange: { start: number; end: number },
): FunctionOwner | null {
  const owners: FunctionOwner[] = []
  const visit = (node: ts.Node): void => {
    const owner = functionOwnerWithBody(node)
    if (owner) {
      const range = identifyingRangeOf(owner, sourceFile)
      if (range.start === ownerRange.start && range.end === ownerRange.end) {
        owners.push(owner)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return owners.length === 1 ? owners[0]! : null
}

interface IdentifiedCompleteOwner {
  owner: FunctionOwner
  sourceNode: ts.Node
  ownerKind: 'function' | 'method'
  label: string
  alternateLabel?: string
}

function unwrapOwnerExpression(owner: ts.FunctionExpression | ts.ArrowFunction): ts.Expression {
  let expression: ts.Expression = owner
  while (
    (ts.isParenthesizedExpression(expression.parent)
      || ts.isAsExpression(expression.parent)
      || ts.isSatisfiesExpression(expression.parent)
      || ts.isTypeAssertionExpression(expression.parent)
      || ts.isNonNullExpression(expression.parent))
    && expression.parent.expression === expression
  ) {
    expression = expression.parent
  }
  return expression
}

function simplePropertyName(name: ts.PropertyName | undefined): string | null {
  if (!name) {
    return null
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return null
}

function identifiedCompleteOwner(owner: FunctionOwner): IdentifiedCompleteOwner | null {
  if (ts.isFunctionDeclaration(owner)) {
    if (owner.name) {
      return {
        owner,
        sourceNode: owner,
        ownerKind: 'function',
        label: `${owner.name.text}()`,
        alternateLabel: owner.name.text,
      }
    }
    const modifiers = ts.canHaveModifiers(owner) ? ts.getModifiers(owner) : undefined
    const defaultExport = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
      && modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    return defaultExport
      ? { owner, sourceNode: owner, ownerKind: 'function', label: 'default()', alternateLabel: 'default' }
      : null
  }

  if (ts.isMethodDeclaration(owner)) {
    const name = simplePropertyName(owner.name)
    return name
      ? { owner, sourceNode: owner, ownerKind: 'method', label: `.${name}()`, alternateLabel: name }
      : null
  }

  if (ts.isConstructorDeclaration(owner)) {
    return {
      owner,
      sourceNode: owner,
      ownerKind: 'method',
      label: '.constructor()',
      alternateLabel: 'constructor',
    }
  }

  if (!ts.isFunctionExpression(owner) && !ts.isArrowFunction(owner)) {
    return null
  }
  const expression = unwrapOwnerExpression(owner)
  const parent = expression.parent
  if (
    ts.isVariableDeclaration(parent)
    && parent.initializer === expression
    && ts.isIdentifier(parent.name)
    && ts.isVariableDeclarationList(parent.parent)
    && parent.parent.declarations.length === 1
    && ts.isVariableStatement(parent.parent.parent)
  ) {
    return {
      owner,
      sourceNode: parent.parent.parent,
      ownerKind: 'function',
      label: `${parent.name.text}()`,
      alternateLabel: parent.name.text,
    }
  }
  if (
    ts.isPropertyDeclaration(parent)
    && parent.initializer === expression
  ) {
    const name = simplePropertyName(parent.name)
    return name
      ? { owner, sourceNode: parent, ownerKind: 'method', label: `.${name}()`, alternateLabel: name }
      : null
  }
  if (ts.isExportAssignment(parent) && parent.expression === expression && !parent.isExportEquals) {
    return {
      owner,
      sourceNode: parent,
      ownerKind: 'function',
      label: 'default()',
      alternateLabel: 'default',
    }
  }
  return null
}

function compatibleCompleteOwnerNodeKind(
  ownerKind: IdentifiedCompleteOwner['ownerKind'],
  nodeKind: string | undefined,
): boolean {
  const kind = nodeKind?.trim().toLowerCase() ?? ''
  if (kind.length === 0) {
    return true
  }
  return ownerKind === 'function'
    ? kind === 'function' || kind === 'component'
    : kind === 'method' || kind === 'function' || kind === 'route'
}

function sourceSpanForCompleteOwner(
  identified: IdentifiedCompleteOwner,
  sourceFile: ts.SourceFile,
): { text: string; startLine: number; endLine: number } | null {
  let start = identified.sourceNode.getStart(sourceFile)
  let end = identified.sourceNode.getEnd()
  const lineStarts = sourceFile.getLineStarts()
  const startLineIndex = sourceFile.getLineAndCharacterOfPosition(start).line
  const endLineIndex = sourceFile.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line
  const lineStart = lineStarts[startLineIndex]
  const nextLineStart = lineStarts[endLineIndex + 1] ?? sourceFile.text.length
  if (lineStart === undefined) {
    return null
  }

  if (sourceFile.text.slice(lineStart, start).trim().length === 0) {
    start = lineStart
  }
  let lineContentEnd = nextLineStart
  if (sourceFile.text.slice(Math.max(0, lineContentEnd - 2), lineContentEnd) === '\r\n') {
    lineContentEnd -= 2
  } else if (/^[\r\n]$/.test(sourceFile.text.slice(Math.max(0, lineContentEnd - 1), lineContentEnd))) {
    lineContentEnd -= 1
  }
  if (sourceFile.text.slice(end, lineContentEnd).trim().length === 0) {
    end = lineContentEnd
  }
  if (start >= end) {
    return null
  }

  return {
    text: sourceFile.text.slice(start, end),
    startLine: startLineIndex + 1,
    endLine: endLineIndex + 1,
  }
}

function numberPhysicalSourceRows(sourceText: string, startLine: number): {
  snippet: string
  endLine: number
} {
  const lineBreakPattern = /\r\n|\r|\n/g
  let snippet = ''
  let cursor = 0
  let lineNumber = startLine
  for (const match of sourceText.matchAll(lineBreakPattern)) {
    const offset = match.index
    snippet += `L${lineNumber}: ${sourceText.slice(cursor, offset)}${match[0]}`
    cursor = offset + match[0].length
    lineNumber += 1
  }
  snippet += `L${lineNumber}: ${sourceText.slice(cursor)}`
  return { snippet, endLine: lineNumber }
}

/**
 * Authenticates and serializes a complete, exact JS/TS function or method
 * owner from the source snapshot already retained by retrieval.
 */
function authenticatedCompleteOwnerSourceEvidence(
  input: CompleteSmallOwnerSourceInput,
  limits?: { maxLines: number; maxCharacters: number },
): CompleteSmallOwnerSourceEvidence | null {
  try {
    if (
      input.externalCall === true
      || !Number.isInteger(input.ownerRange.start)
      || !Number.isInteger(input.ownerRange.end)
      || input.ownerRange.start < 1
      || input.ownerRange.end < input.ownerRange.start
      || (limits && input.ownerRange.end - input.ownerRange.start + 1 > limits.maxLines)
    ) {
      return null
    }
    const sourceFile = parsedSourceForSnapshot(input.sourceFilePath, input.sourceLines)
    if (!sourceFile || input.ownerRange.end > sourceFile.getLineStarts().length) {
      return null
    }
    const parseDiagnostics = (sourceFile as ts.SourceFile & {
      parseDiagnostics?: readonly ts.Diagnostic[]
    }).parseDiagnostics
    if (parseDiagnostics && parseDiagnostics.length > 0) {
      return null
    }

    const candidates: IdentifiedCompleteOwner[] = []
    const visit = (node: ts.Node): void => {
      const owner = functionOwnerWithBody(node)
      if (owner) {
        const identified = identifiedCompleteOwner(owner)
        if (
          identified
          && (identified.label === input.label || identified.alternateLabel === input.label)
          && compatibleCompleteOwnerNodeKind(identified.ownerKind, input.nodeKind)
        ) {
          const range = lineRangeOf(identified.sourceNode, sourceFile)
          if (range.start === input.ownerRange.start && range.end === input.ownerRange.end) {
            candidates.push(identified)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    if (candidates.length !== 1) {
      return null
    }

    const source = sourceSpanForCompleteOwner(candidates[0]!, sourceFile)
    if (
      !source
      || source.startLine !== input.ownerRange.start
      || source.endLine !== input.ownerRange.end
      || (limits && source.text.length > limits.maxCharacters)
    ) {
      return null
    }
    const numbered = numberPhysicalSourceRows(source.text, source.startLine)
    if (numbered.endLine !== source.endLine) {
      return null
    }
    return {
      snippet: numbered.snippet,
      lineNumber: source.startLine,
    }
  } catch {
    return null
  }
}

/** Authenticates and serializes an exact owner for budget-aware allocation. */
export function completeOwnerSourceEvidence(
  input: CompleteSmallOwnerSourceInput,
): CompleteSmallOwnerSourceEvidence | null {
  return authenticatedCompleteOwnerSourceEvidence(input)
}

/** Preserves the established bounded small-owner representation contract. */
export function completeSmallOwnerSourceEvidence(
  input: CompleteSmallOwnerSourceInput,
): CompleteSmallOwnerSourceEvidence | null {
  return authenticatedCompleteOwnerSourceEvidence(input, {
    maxLines: COMPLETE_SMALL_OWNER_MAX_LINES,
    maxCharacters: COMPLETE_SMALL_OWNER_MAX_CHARACTERS,
  })
}

function normalizedSource(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

interface ProtectedSourceToken {
  start: number
  end: number
  text: string
  representedText: string
}

interface PhysicalSourceProjection extends QueryEvidenceSourceProjection {
  identityText: string
  sourceStart: number
  sourceEnd: number
  tokens: ProtectedSourceToken[]
}

const PROTECTED_LITERAL_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
])

function physicalSourceBounds(
  range: { start: number; end: number },
  sourceFile: ts.SourceFile,
): { start: number; end: number } | null {
  const lineStarts = sourceFile.getLineStarts()
  const start = lineStarts[range.start - 1]
  if (start === undefined) {
    return null
  }
  return {
    start,
    end: lineStarts[range.end] ?? sourceFile.text.length,
  }
}

function protectedTokensForRange(
  range: { start: number; end: number },
  sourceFile: ts.SourceFile,
  allowClippedTokens = false,
): ProtectedSourceToken[] | null {
  const bounds = physicalSourceBounds(range, sourceFile)
  if (!bounds) {
    return null
  }
  const tokens: ProtectedSourceToken[] = []
  let clippedToken = false
  const visit = (node: ts.Node): void => {
    if (PROTECTED_LITERAL_KINDS.has(node.kind)) {
      const start = node.getStart(sourceFile)
      const end = node.getEnd()
      if (start < bounds.end && bounds.start < end) {
        if (start < bounds.start || end > bounds.end) {
          if (!allowClippedTokens) {
            clippedToken = true
            return
          }
          const segmentStart = Math.max(start, bounds.start)
          let segmentEnd = Math.min(end, bounds.end)
          if (end > bounds.end) {
            if (sourceFile.text.slice(segmentEnd - 2, segmentEnd) === '\r\n') {
              segmentEnd -= 2
            } else if (/^[\r\n]$/.test(sourceFile.text.slice(segmentEnd - 1, segmentEnd))) {
              segmentEnd -= 1
            }
          }
          if (segmentStart >= segmentEnd) {
            clippedToken = true
            return
          }
          const text = sourceFile.text.slice(segmentStart, segmentEnd)
          tokens.push({
            start: segmentStart,
            end: segmentEnd,
            text,
            representedText: sourceFilesWithNormalizedLineCaches.has(sourceFile)
              ? text.replace(/\r\n/g, '\n')
              : text,
          })
          return
        }
        const text = sourceFile.text.slice(start, end)
        tokens.push({
          start,
          end,
          text,
          representedText: sourceFilesWithNormalizedLineCaches.has(sourceFile)
            ? text.replace(/\r\n/g, '\n')
            : text,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (clippedToken) {
    return null
  }
  return tokens.sort((left, right) => left.start - right.start || left.end - right.end)
}

function tokenMarker(index: number): string {
  return `\u0000literal-${index}\u0000`
}

function physicalProjectionForRange(
  range: { start: number; end: number },
  sourceFile: ts.SourceFile,
  allowClippedTokens = false,
): PhysicalSourceProjection | null {
  const bounds = physicalSourceBounds(range, sourceFile)
  const tokens = protectedTokensForRange(range, sourceFile, allowClippedTokens)
  if (!bounds || !tokens) {
    return null
  }

  let marked = ''
  let cursor = bounds.start
  for (const [index, token] of tokens.entries()) {
    marked += sourceFile.text.slice(cursor, token.start)
    marked += tokenMarker(index)
    cursor = token.end
  }
  marked += sourceFile.text.slice(cursor, bounds.end)
  const identityText = normalizedSource(marked)

  let text = identityText
  const literalLineBreaks: Array<{ offset: number; lineNumber: number }> = []
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!
    const marker = tokenMarker(index)
    const markerOffset = text.indexOf(marker)
    if (markerOffset < 0) {
      return null
    }
    text = `${text.slice(0, markerOffset)}${token.text}${text.slice(markerOffset + marker.length)}`
  }

  let projectedOffset = 0
  let identityCursor = 0
  for (const [index, token] of tokens.entries()) {
    const marker = tokenMarker(index)
    const markerOffset = identityText.indexOf(marker, identityCursor)
    if (markerOffset < 0) {
      return null
    }
    projectedOffset += markerOffset - identityCursor
    let lineNumber = sourceFile.getLineAndCharacterOfPosition(token.start).line + 1
    for (let tokenOffset = 0; tokenOffset < token.text.length; tokenOffset += 1) {
      if (token.text[tokenOffset] !== '\n') {
        continue
      }
      lineNumber += 1
      literalLineBreaks.push({
        offset: projectedOffset + tokenOffset,
        lineNumber,
      })
    }
    projectedOffset += token.text.length
    identityCursor = markerOffset + marker.length
  }

  return {
    text,
    identityText,
    sourceStart: bounds.start,
    sourceEnd: bounds.end,
    literalLineBreaks,
    hasProtectedTokens: tokens.length > 0,
    tokens,
  }
}

function alignedOutsideSourceEnd(
  physicalText: string,
  representedText: string,
  representedStart: number,
  trimStart: boolean,
  trimEnd: boolean,
): number | null {
  let physicalOffset = 0
  let representedOffset = representedStart
  if (trimStart && physicalText.length > 0) {
    while (/\s/.test(representedText[representedOffset] ?? '')) {
      representedOffset += 1
    }
  }
  while (physicalOffset < physicalText.length) {
    if (/\s/.test(physicalText[physicalOffset]!)) {
      const whitespaceStart = physicalOffset
      while (physicalOffset < physicalText.length && /\s/.test(physicalText[physicalOffset]!)) {
        physicalOffset += 1
      }
      const optional = (trimStart && whitespaceStart === 0)
        || (trimEnd && physicalOffset === physicalText.length)
      if (!optional && !/\s/.test(representedText[representedOffset] ?? '')) {
        return null
      }
      while (/\s/.test(representedText[representedOffset] ?? '')) {
        representedOffset += 1
      }
      continue
    }
    if (representedText[representedOffset] !== physicalText[physicalOffset]) {
      return null
    }
    physicalOffset += 1
    representedOffset += 1
  }
  return representedOffset
}

function representedSourceIdentity(
  representedText: string,
  projection: PhysicalSourceProjection,
  sourceFile: ts.SourceFile,
): string | null {
  let marked = ''
  let physicalCursor = projection.sourceStart
  let representedCursor = 0
  for (const [index, token] of projection.tokens.entries()) {
    const tokenOffset = alignedOutsideSourceEnd(
      sourceFile.text.slice(physicalCursor, token.start),
      representedText,
      representedCursor,
      physicalCursor === projection.sourceStart,
      false,
    )
    if (
      tokenOffset === null
      || representedText.slice(tokenOffset, tokenOffset + token.representedText.length)
        !== token.representedText
    ) {
      return null
    }
    marked += representedText.slice(representedCursor, tokenOffset)
    marked += tokenMarker(index)
    physicalCursor = token.end
    representedCursor = tokenOffset + token.representedText.length
  }
  const representedEnd = alignedOutsideSourceEnd(
    sourceFile.text.slice(physicalCursor, projection.sourceEnd),
    representedText,
    representedCursor,
    projection.tokens.length === 0,
    true,
  )
  if (representedEnd === null || representedText.slice(representedEnd).trim().length > 0) {
    return null
  }
  marked += representedText.slice(representedCursor, representedEnd)
  return normalizedSource(marked)
}

function representedSourceMatchesPhysicalRange(
  representedText: string,
  range: { start: number; end: number },
  sourceFile: ts.SourceFile,
): boolean {
  const projection = physicalProjectionForRange(range, sourceFile)
  return projection !== null
    && representedSourceIdentity(representedText, projection, sourceFile) === projection.identityText
}

function literalDelimiterPreservingLines(
  range: { start: number; end: number },
  sourceFile: ts.SourceFile,
  sourceLines: readonly string[],
): OwnerDeclarationEvidenceLine[] {
  const tokens = protectedTokensForRange(range, sourceFile) ?? []
  const lineStarts = sourceFile.getLineStarts()
  return sourceLines
    .slice(range.start - 1, range.end)
    .map((text, offset) => {
      const lineNumber = range.start + offset
      const nextLineStart = lineStarts[lineNumber]
      const hasProtectedCRLF = nextLineStart !== undefined
        && sourceFile.text.slice(nextLineStart - 2, nextLineStart) === '\r\n'
        && tokens.some((token) => (
          token.start <= nextLineStart - 2 && nextLineStart <= token.end
        ))
      return {
        lineNumber,
        text: hasProtectedCRLF && !text.endsWith('\r') ? `${text}\r` : text,
      }
    })
}

function isStrictAncestorOf(ancestor: ts.Node, descendant: ts.Node): boolean {
  let current = descendant.parent
  while (current) {
    if (current === ancestor) {
      return true
    }
    current = current.parent
  }
  return false
}

/**
 * Projects already-shaped query evidence back onto its authenticated physical
 * source while normalizing layout only outside string/template/regex tokens.
 */
export function queryEvidenceSourceProjection(input: {
  sourceFilePath: string
  sourceLines: readonly string[]
  representedSource: readonly RepresentedQueryEvidenceSource[]
  shapedText: string
}): QueryEvidenceSourceProjection | null {
  try {
    const sourceFile = parsedSourceForSnapshot(input.sourceFilePath, input.sourceLines)
    if (!sourceFile) {
      return null
    }
    const parseDiagnostics = (sourceFile as ts.SourceFile & {
      parseDiagnostics?: readonly ts.Diagnostic[]
    }).parseDiagnostics
    if (parseDiagnostics && parseDiagnostics.length > 0) {
      return null
    }

    const lineCount = sourceFile.getLineStarts().length
    const shapedText = normalizedSource(input.shapedText)
    let cursor = 0
    let projectedText = ''
    let hasProtectedTokens = false
    const literalLineBreaks: Array<{ offset: number; lineNumber: number }> = []
    for (const represented of input.representedSource) {
      if (
        !Number.isInteger(represented.startLine)
        || !Number.isInteger(represented.endLine)
        || represented.startLine < 1
        || represented.endLine > lineCount
        || represented.startLine > represented.endLine
      ) {
        return null
      }
      const range = { start: represented.startLine, end: represented.endLine }
      const projection = physicalProjectionForRange(range, sourceFile, true)
      if (
        !projection
        || representedSourceIdentity(represented.text, projection, sourceFile) !== projection.identityText
      ) {
        return null
      }
      hasProtectedTokens ||= projection.hasProtectedTokens
      const normalizedComponent = normalizedSource(represented.text)
      const componentOffset = shapedText.indexOf(normalizedComponent, cursor)
      if (normalizedComponent.length === 0 || componentOffset < 0) {
        return null
      }
      projectedText += shapedText.slice(cursor, componentOffset)
      const projectionStart = projectedText.length
      projectedText += projection.text
      for (const lineBreak of projection.literalLineBreaks) {
        literalLineBreaks.push({
          offset: projectionStart + lineBreak.offset,
          lineNumber: lineBreak.lineNumber,
        })
      }
      cursor = componentOffset + normalizedComponent.length
    }
    projectedText += shapedText.slice(cursor)
    return {
      text: projectedText,
      literalLineBreaks,
      hasProtectedTokens,
    }
  } catch {
    return null
  }
}

/**
 * Expands exact selected source fragments to their uniquely containing
 * literal-bearing statement while preserving other authenticated fragments.
 */
export function completeQueryEvidenceLiteralStatement(input: {
  sourceFilePath: string
  sourceLines: readonly string[]
  ownerRange: { start: number; end: number }
  representedSource: readonly RepresentedQueryEvidenceSource[]
}): RepresentedQueryEvidenceSource[] | null {
  try {
    if (input.representedSource.length === 0) {
      return null
    }
    const sourceFile = parsedSourceForSnapshot(input.sourceFilePath, input.sourceLines)
    if (!sourceFile) {
      return null
    }
    const parseDiagnostics = (sourceFile as ts.SourceFile & {
      parseDiagnostics?: readonly ts.Diagnostic[]
    }).parseDiagnostics
    if (parseDiagnostics && parseDiagnostics.length > 0) {
      return null
    }

    const owner = uniquelyIdentifiedOwner(sourceFile, input.ownerRange)
    if (!owner || !ts.isBlock(owner.body)) {
      return null
    }
    const authenticated = [...input.representedSource]
      .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)
    const representedSource: RepresentedQueryEvidenceSource[] = []
    for (const represented of authenticated) {
      if (
        !Number.isInteger(represented.startLine)
        || !Number.isInteger(represented.endLine)
        || represented.startLine < input.ownerRange.start
        || represented.endLine > input.ownerRange.end
        || represented.startLine > represented.endLine
        || represented.text !== input.sourceLines
          .slice(represented.startLine - 1, represented.endLine)
          .join('\n')
      ) {
        return null
      }
      const previous = representedSource.at(-1)
      if (
        previous
        && previous.startLine === represented.startLine
        && previous.endLine === represented.endLine
        && previous.text === represented.text
      ) {
        continue
      }
      if (previous && represented.startLine <= previous.endLine) {
        return null
      }
      representedSource.push(represented)
    }
    const candidates: Array<{
      statement: ts.Statement
      range: { start: number; end: number }
    }> = []
    const visit = (node: ts.Node): void => {
      if (node !== owner && isNestedFunctionOrClass(node)) {
        return
      }
      if (node !== owner && ts.isStatement(node)) {
        const range = evidenceLineRangeOf(node, sourceFile)
        const completesRepresentedFragment = representedSource.some((represented) => {
          const representedRange = { start: represented.startLine, end: represented.endLine }
          if (
            input.ownerRange.start > range.start
            || range.end > input.ownerRange.end
            || range.start > representedRange.start
            || representedRange.end > range.end
            || (range.start === representedRange.start && range.end === representedRange.end)
          ) {
            return false
          }
          let crossesRepresentedBoundary = false
          const findCrossingLiteral = (descendant: ts.Node): void => {
            if (crossesRepresentedBoundary || (descendant !== node && isNestedFunctionOrClass(descendant))) {
              return
            }
            if (PROTECTED_LITERAL_KINDS.has(descendant.kind)) {
              const literalRange = lineRangeOf(descendant, sourceFile)
              if (
                literalRange.start <= representedRange.end
                && representedRange.start <= literalRange.end
                && (
                  literalRange.start < representedRange.start
                  || literalRange.end > representedRange.end
                )
              ) {
                crossesRepresentedBoundary = true
                return
              }
            }
            ts.forEachChild(descendant, findCrossingLiteral)
          }
          findCrossingLiteral(node)
          return crossesRepresentedBoundary
        })
        if (completesRepresentedFragment) {
          candidates.push({ statement: node, range })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(owner)
    const innermostCandidates = candidates.filter((candidate) => (
      !candidates.some((other) => (
        other !== candidate
        && isStrictAncestorOf(candidate.statement, other.statement)
      ))
    ))
    if (innermostCandidates.length !== 1) {
      return null
    }
    const range = innermostCandidates[0]!.range
    const completed: RepresentedQueryEvidenceSource = {
      startLine: range.start,
      endLine: range.end,
      text: input.sourceLines.slice(range.start - 1, range.end).join('\n'),
    }
    const result: RepresentedQueryEvidenceSource[] = []
    let insertedCompletion = false
    for (const represented of representedSource) {
      const insideCompletion = range.start <= represented.startLine && represented.endLine <= range.end
      const overlapsCompletion = represented.startLine <= range.end && range.start <= represented.endLine
      if (overlapsCompletion && !insideCompletion) {
        return null
      }
      if (insideCompletion) {
        if (!insertedCompletion) {
          result.push(completed)
          insertedCompletion = true
        }
      } else {
        result.push(represented)
      }
    }
    return insertedCompletion ? result : null
  } catch {
    return null
  }
}

function representedStatements(
  owner: FunctionOwner,
  representedSource: readonly RepresentedQueryEvidenceSource[],
  sourceFile: ts.SourceFile,
): ts.Statement[] {
  const ownerRange = lineRangeOf(owner, sourceFile)
  const lineCount = sourceFile.getLineStarts().length
  const verifiedRepresentedRanges = representedSource.flatMap((represented) => {
    if (
      !Number.isInteger(represented.startLine)
      || !Number.isInteger(represented.endLine)
      || represented.startLine < ownerRange.start
      || represented.endLine > ownerRange.end
      || represented.startLine > represented.endLine
      || represented.endLine > lineCount
    ) {
      return []
    }
    const range = { start: represented.startLine, end: represented.endLine }
    return representedSourceMatchesPhysicalRange(represented.text, range, sourceFile)
      ? [range]
      : []
  })

  const statements: ts.Statement[] = []
  const visit = (node: ts.Node): void => {
    if (node !== owner) {
      if (functionOwnerWithBody(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        return
      }
      if (ts.isStatement(node)) {
        const range = evidenceLineRangeOf(node, sourceFile)
        if (range.start < ownerRange.start || range.end > ownerRange.end) {
          return
        }
        const coveredLines = new Set<number>()
        for (const represented of verifiedRepresentedRanges) {
          if (represented.start < range.start || represented.end > range.end) {
            continue
          }
          for (let line = represented.start; line <= represented.end; line += 1) {
            coveredLines.add(line)
          }
        }
        if (
          coveredLines.size === range.end - range.start + 1
          && coveredLines.has(range.start)
          && coveredLines.has(range.end)
        ) {
          statements.push(node)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(owner)
  return statements
}

function isNestedFunctionOrClass(node: ts.Node): boolean {
  return functionOwnerWithBody(node) !== null
    || ts.isClassDeclaration(node)
    || ts.isClassExpression(node)
}

function isValueReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === identifier) {
    return true
  }
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier)
    || (ts.isLabeledStatement(parent) && parent.label === identifier)
    || ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === identifier)
  ) {
    return false
  }
  if ('name' in parent && (parent as ts.NamedDeclaration).name === identifier) {
    return false
  }
  return true
}

function collectValueReferences(
  root: ts.Node,
  rejectNestedFunctions: boolean,
): { identifiers: ts.Identifier[]; supported: boolean } {
  const identifiers: ts.Identifier[] = []
  let supported = true
  const visit = (node: ts.Node): void => {
    if (!supported) {
      return
    }
    if (node !== root && isNestedFunctionOrClass(node)) {
      supported = !rejectNestedFunctions
      return
    }
    if (ts.isTypeNode(node)) {
      return
    }
    if (
      ts.isYieldExpression(node)
      || (ts.isDeleteExpression(node))
      || (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
      || (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      )
    ) {
      supported = false
      return
    }
    if (ts.isIdentifier(node) && isValueReference(node)) {
      identifiers.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return { identifiers, supported }
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text]
  }
  return name.elements.flatMap((element) => (
    ts.isBindingElement(element) ? bindingNames(element.name) : []
  ))
}

function assignmentTargetIdentifiers(node: ts.Node): ts.Identifier[] {
  if (ts.isIdentifier(node)) {
    return [node]
  }
  if (ts.isParenthesizedExpression(node)) {
    return assignmentTargetIdentifiers(node.expression)
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element) => assignmentTargetIdentifiers(element))
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return [property.name]
      }
      if (ts.isPropertyAssignment(property)) {
        return assignmentTargetIdentifiers(property.initializer)
      }
      if (ts.isSpreadAssignment(property)) {
        return assignmentTargetIdentifiers(property.expression)
      }
      return []
    })
  }
  if (ts.isSpreadElement(node)) {
    return assignmentTargetIdentifiers(node.expression)
  }
  return []
}

function functionScopedVarDeclarations(
  owner: FunctionOwner,
  expected: string,
): ts.VariableDeclaration[] {
  const declarations: ts.VariableDeclaration[] = []
  const visit = (node: ts.Node): void => {
    if (node !== owner && isNestedFunctionOrClass(node)) {
      return
    }
    if (
      ts.isVariableDeclarationList(node)
      && (node.flags & ts.NodeFlags.BlockScoped) === 0
    ) {
      for (const declaration of node.declarations) {
        if (hasBindingName(declaration.name, expected)) {
          declarations.push(declaration)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(owner)
  return declarations
}

type LexicalScope =
  | ts.Block
  | ts.CaseBlock
  | ts.CatchClause
  | ts.ForStatement
  | ts.ForInStatement
  | ts.ForOfStatement

function lexicalScopeChain(node: ts.Node, owner: FunctionOwner): LexicalScope[] | null {
  const scopes: LexicalScope[] = []
  let current: ts.Node | undefined = node.parent
  while (current && current !== owner) {
    if (
      ts.isBlock(current)
      || ts.isCaseBlock(current)
      || ts.isCatchClause(current)
      || ts.isForStatement(current)
      || ts.isForInStatement(current)
      || ts.isForOfStatement(current)
    ) {
      scopes.push(current)
    }
    if (isNestedFunctionOrClass(current)) {
      return null
    }
    current = current.parent
  }
  return ts.isBlock(owner.body) && scopes.includes(owner.body) ? scopes : null
}

type LexicalEnvironment = (
  | LexicalScope
  | FunctionOwner
  | ts.ClassDeclaration
  | ts.ClassExpression
)

interface ResolvedLexicalBinding {
  binding: ConstBinding | null
  identity: ts.Node | null
  invalidDependency: boolean
}

function lexicalEnvironmentChain(
  node: ts.Node,
  owner: FunctionOwner,
  crossNestedOwners: boolean,
): LexicalEnvironment[] | null {
  const environments: LexicalEnvironment[] = []
  let foundOwner = false
  let current: ts.Node | undefined = node.parent
  while (current) {
    const functionOwner = functionOwnerWithBody(current)
    if (functionOwner) {
      if (functionOwner !== owner && !crossNestedOwners) {
        return null
      }
      environments.push(functionOwner)
      if (functionOwner === owner) {
        foundOwner = true
        break
      }
    } else if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      environments.push(current)
    } else if (
      ts.isBlock(current)
      || ts.isCaseBlock(current)
      || ts.isCatchClause(current)
      || ts.isForStatement(current)
      || ts.isForInStatement(current)
      || ts.isForOfStatement(current)
    ) {
      environments.push(current)
    }
    current = current.parent
  }
  return foundOwner ? environments : null
}

function hasBindingName(name: ts.BindingName, expected: string): boolean {
  return bindingNames(name).includes(expected)
}

function resolveLexicalBinding(
  identifier: ts.Identifier,
  owner: FunctionOwner,
  crossNestedOwners: boolean,
): ResolvedLexicalBinding {
  let environments: LexicalEnvironment[] | null
  if (crossNestedOwners) {
    environments = lexicalEnvironmentChain(identifier, owner, true)
  } else {
    const scopes = lexicalScopeChain(identifier, owner)
    environments = scopes
      ? scopes.flatMap<LexicalEnvironment>((scope) => (
          scope === owner.body ? [scope, owner] : [scope]
        ))
      : null
  }
  if (!environments) {
    return { binding: null, identity: null, invalidDependency: false }
  }

  for (const environment of environments) {
    const functionOwner = functionOwnerWithBody(environment)
    if (functionOwner) {
      const parameter = functionOwner.parameters.find((candidate) => (
        hasBindingName(candidate.name, identifier.text)
      ))
      const functionName = (
        (ts.isFunctionDeclaration(functionOwner) || ts.isFunctionExpression(functionOwner))
        && functionOwner.name?.text === identifier.text
      )
        ? functionOwner
        : null
      const varDeclarations = functionScopedVarDeclarations(functionOwner, identifier.text)
      const identity = parameter ?? functionName ?? varDeclarations[0] ?? null
      if (identity) {
        return { binding: null, identity, invalidDependency: false }
      }
      continue
    }

    if (
      (ts.isClassDeclaration(environment) || ts.isClassExpression(environment))
      && environment.name?.text === identifier.text
    ) {
      return { binding: null, identity: environment, invalidDependency: false }
    }
    if (
      ts.isCatchClause(environment)
      && environment.variableDeclaration
      && hasBindingName(environment.variableDeclaration.name, identifier.text)
    ) {
      return {
        binding: null,
        identity: environment.variableDeclaration,
        invalidDependency: false,
      }
    }
    if (ts.isForStatement(environment) || ts.isForInStatement(environment) || ts.isForOfStatement(environment)) {
      const initializer = environment.initializer
      if (initializer && ts.isVariableDeclarationList(initializer)) {
        const declaration = initializer.declarations.find((candidate) => (
          hasBindingName(candidate.name, identifier.text)
        ))
        if (declaration) {
          return { binding: null, identity: declaration, invalidDependency: false }
        }
      }
      continue
    }

    const declarations: Array<{
      declaration: ts.VariableDeclaration
      statement: ts.VariableStatement
      declarationKind: 'const' | 'mutable'
    }> = []
    const unsupportedBindings: ts.Node[] = []
    const statements = ts.isBlock(environment)
      ? environment.statements
      : ts.isCaseBlock(environment)
        ? environment.clauses.flatMap((clause) => [...clause.statements])
        : []
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        const blockScopedFlags = statement.declarationList.flags & ts.NodeFlags.BlockScoped
        const declarationKind = blockScopedFlags === ts.NodeFlags.Const
          ? 'const'
          : 'mutable'
        for (const declaration of statement.declarationList.declarations) {
          if (!hasBindingName(declaration.name, identifier.text)) {
            continue
          }
          declarations.push({ declaration, statement, declarationKind })
        }
      } else if (
        ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement))
          && statement.name?.text === identifier.text)
      ) {
        unsupportedBindings.push(statement)
      }
    }

    if (declarations.length === 0 && unsupportedBindings.length === 0) {
      continue
    }
    if (declarations.length !== 1 || unsupportedBindings.length > 0) {
      return {
        binding: null,
        identity: declarations[0]?.declaration ?? unsupportedBindings[0] ?? environment,
        invalidDependency: true,
      }
    }

    const candidate = declarations[0]!
    if (
      candidate.declarationKind !== 'const'
      || !ts.isIdentifier(candidate.declaration.name)
      || !candidate.declaration.initializer
    ) {
      return {
        binding: null,
        identity: candidate.declaration,
        invalidDependency: false,
      }
    }
    return {
      binding: { declaration: candidate.declaration, statement: candidate.statement },
      identity: candidate.declaration,
      invalidDependency: false,
    }
  }
  return { binding: null, identity: null, invalidDependency: false }
}

function writtenBindings(owner: FunctionOwner): Set<ts.Node> {
  const bindings = new Set<ts.Node>()
  const visit = (node: ts.Node): void => {
    let targets: ts.Identifier[] = []
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      targets = assignmentTargetIdentifiers(node.left)
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      targets = assignmentTargetIdentifiers(node.operand)
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (!ts.isVariableDeclarationList(node.initializer)) {
        targets = assignmentTargetIdentifiers(node.initializer)
      }
    }
    for (const target of targets) {
      const resolved = resolveLexicalBinding(target, owner, true)
      if (resolved.identity) {
        bindings.add(resolved.identity)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(owner)
  return bindings
}

function constBindingForReference(
  identifier: ts.Identifier,
  owner: FunctionOwner,
  written: ReadonlySet<ts.Node>,
): { binding: ConstBinding | null; invalidDependency: boolean } {
  const resolved = resolveLexicalBinding(identifier, owner, false)
  if (!resolved.binding || resolved.invalidDependency) {
    return { binding: null, invalidDependency: resolved.invalidDependency }
  }
  const candidate = resolved.binding
  if (candidate.declaration.getStart() >= identifier.getStart()) {
    return { binding: null, invalidDependency: true }
  }
  if (candidate.statement.declarationList.declarations.some((declaration) => (
    !ts.isIdentifier(declaration.name) || !declaration.initializer
  ))) {
    return { binding: null, invalidDependency: true }
  }
  if (written.has(candidate.declaration)) {
    return { binding: null, invalidDependency: false }
  }
  return { binding: candidate, invalidDependency: false }
}

function declarationClosure(
  owner: FunctionOwner,
  seedStatements: readonly ts.Statement[],
): ts.VariableStatement[] | null {
  const written = writtenBindings(owner)
  const statements = new Set<ts.VariableStatement>()
  const completed = new Set<ts.VariableDeclaration>()
  const visiting = new Set<ts.VariableDeclaration>()

  const completeBinding = (binding: ConstBinding): boolean => {
    if (completed.has(binding.declaration)) {
      return true
    }
    if (visiting.has(binding.declaration)) {
      return false
    }
    visiting.add(binding.declaration)
    const references = collectValueReferences(binding.declaration.initializer!, true)
    if (!references.supported) {
      return false
    }
    for (const reference of references.identifiers) {
      const resolved = constBindingForReference(reference, owner, written)
      if (resolved.invalidDependency) {
        return false
      }
      if (resolved.binding && !completeBinding(resolved.binding)) {
        return false
      }
    }
    visiting.delete(binding.declaration)
    completed.add(binding.declaration)
    statements.add(binding.statement)
    return true
  }

  for (const statement of seedStatements) {
    const references = collectValueReferences(statement, false)
    for (const reference of references.identifiers) {
      const resolved = constBindingForReference(reference, owner, written)
      if (resolved.invalidDependency) {
        continue
      }
      if (resolved.binding && !completeBinding(resolved.binding)) {
        return null
      }
    }
  }
  return [...statements]
}

/**
 * Returns a complete, source-local const-declaration closure for exact source
 * statements already represented in a query excerpt. It intentionally does
 * not perform type checking, value inference, repository traversal, or reads.
 */
export function ownerLocalDeclarationEvidence(
  input: OwnerDeclarationCompletionInput,
): OwnerDeclarationEvidence[] {
  try {
    const sourceFile = parsedSourceForSnapshot(input.sourceFilePath, input.sourceLines)
    if (!sourceFile) {
      return []
    }
    const parseDiagnostics = (sourceFile as ts.SourceFile & {
      parseDiagnostics?: readonly ts.Diagnostic[]
    }).parseDiagnostics
    if (parseDiagnostics && parseDiagnostics.length > 0) {
      return []
    }

    const owner = uniquelyIdentifiedOwner(sourceFile, input.ownerRange)
    if (!owner || !ts.isBlock(owner.body)) {
      return []
    }
    const seeds = representedStatements(owner, input.representedSource, sourceFile)
    if (seeds.length === 0) {
      return []
    }
    const closure = declarationClosure(owner, seeds)
    if (!closure || closure.length === 0) {
      return []
    }

    const representedRanges = input.representedSource.map((represented) => ({
      start: represented.startLine,
      end: represented.endLine,
    }))
    const eligibleRanges = closure
      .map((statement) => evidenceLineRangeOf(statement, sourceFile))
      .filter((range) => (
        input.ownerRange.start <= range.start
        && range.end <= input.ownerRange.end
      ))
      .filter((range) => !representedRanges.some((represented) => (
        represented.start <= range.end && range.start <= represented.end
      )))
      .sort((left, right) => left.start - right.start || left.end - right.end)
    const physicalRanges: Array<{ start: number; end: number }> = []
    for (const range of eligibleRanges) {
      const previous = physicalRanges.at(-1)
      if (previous && range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end)
      } else {
        physicalRanges.push({ ...range })
      }
    }
    return physicalRanges.map((range) => ({
      startLine: range.start,
      endLine: range.end,
      lines: literalDelimiterPreservingLines(range, sourceFile, input.sourceLines),
    }))
  } catch {
    return []
  }
}
