import { basename, dirname, extname, resolve } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'

import { strFromU8, unzipSync, type UnzipFileInfo } from 'fflate'
import * as ts from 'typescript'

import type { ExtractionData, ExtractionEdge, ExtractionNode } from '../contracts/types.js'
import { runPipelineStage } from '../core/pipeline/stage.js'
import { loadCached, saveCached } from '../infrastructure/cache.js'
import { builtinCapabilityRegistry } from '../infrastructure/capabilities.js'
import { CODE_EXTENSIONS, FileType, classifyFile, detect } from './detect.js'
import { mergeExtractionFragments } from './extract/combine.js'
import { addPendingCall, addResolvedCalls, braceDelta, normalizeImportTarget, type PendingCall, type PendingCallInput } from './extract/call-resolution.js'
import {
  dispatchSingleFileExtractionWithOutcome,
  type ExtractionDispatchResult,
  type ExtractionFileOutcome,
  type ExtractionFragment,
  type PipelineExtractorHandlerMap,
  type StagedExtractionFragment,
} from './extract/dispatch.js'
import {
  buildExtractionDiscoveryPlan,
  projectExtractionDiagnostics,
  resolveCrossFileExtraction,
  type ExtractionPipelineResult,
  type ExtractionStageObserver,
} from './extract/pipeline.js'
import { applyJsFrameworkAdapters } from './extract/frameworks/core.js'
import { extractGenericCode, normalizeTypeName } from './extract/generic.js'
import {
  _makeId,
  addEdge,
  addNode,
  addUniqueEdge,
  createEdge,
  createFileNode,
  createNode,
  fileNodeIdForPath,
  fileStemForPath,
  indentationLevel,
  normalizeLabel,
  stripHashComment,
  withExtractionFileStemContext,
  withExtractionFileStemMapContext,
} from './extract/core.js'
import { unparenthesizeExpression } from './extract/typescript-utils.js'
import {
  extractAudioFile as extractAudioFragment,
  createCodeFileOnlyExtraction as createTextFallbackExtraction,
  ensureTextFileWithinLimit as isTextFileWithinLimit,
  extractDocument as extractDocumentFile,
  extractImageFile as extractImageFragment,
  extractPaper as extractPaperFile,
  extractVideoFile as extractVideoFragment,
} from './extract/non-code.js'
import { extractPythonRationale } from './extract/python-rationale.js'
import { isRecord } from '../shared/guards.js'
import { MAX_TEXT_BYTES, sanitizeLabel } from '../shared/security.js'
import { createTreeSitterWasmParser, treeSitterWasmError, type TreeSitterNode } from './tree-sitter-wasm.js'

export { _makeId } from './extract/core.js'
export type {
  ExtractionFileDiagnostic,
  ExtractionPipelineResult,
  ExtractionStageDiagnostic,
  ExtractionStageObserver,
} from './extract/pipeline.js'

export const EXTRACTOR_CACHE_VERSION = 68
const PYTHON_KEYWORDS = new Set(['if', 'elif', 'else', 'for', 'while', 'return', 'class', 'def', 'lambda', 'with', 'print', 'sum'])
const GENERIC_CODE_EXTENSIONS = new Set(['.go', '.rs', '.java', '.kt', '.kts', '.scala', '.cs', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.swift', '.php', '.zig'])
const RUBY_KEYWORDS = new Set(['if', 'elsif', 'else', 'unless', 'while', 'until', 'return', 'super', 'yield', 'class', 'def'])
const RUBY_AST_NESTED_DECLARATION_TYPES = new Set(['class', 'module', 'method', 'singleton_method'])
const MAX_RUBY_AST_DEPTH = 64
const RUST_TYPE_DECLARATIONS = new Set(['struct_item', 'enum_item', 'trait_item', 'union_item', 'type_item'])
const RUST_NESTED_DECLARATION_TYPES = new Set(['mod_item', 'impl_item', 'function_item', ...RUST_TYPE_DECLARATIONS])
const RUST_IGNORED_PATH_SEGMENTS = new Set(['pub', 'use', 'mut'])
const LUA_KEYWORDS = new Set(['if', 'then', 'elseif', 'else', 'for', 'while', 'repeat', 'until', 'return', 'function', 'local', 'require'])
const ELIXIR_KEYWORDS = new Set(['if', 'unless', 'case', 'cond', 'fn', 'def', 'defp', 'defmodule'])
const JULIA_KEYWORDS = new Set(['if', 'elseif', 'else', 'while', 'for', 'return', 'function', 'struct', 'mutable', 'macro'])
const POWERSHELL_KEYWORDS = new Set(['if', 'else', 'elseif', 'foreach', 'switch', 'return', 'function', 'class', 'param'])
const MARKDOWN_HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const SETEXT_H1_PATTERN = /^={3,}\s*$/
const SETEXT_H2_PATTERN = /^-{3,}\s*$/
const LOCAL_LINK_PATTERN = /(!)?\[[^\]]*\]\(([^)]+)\)/g
const PDF_METADATA_TITLE_PATTERN = /\/Title\s*\(([^)]{1,300})\)/i
const PDF_TEXT_OPERATOR_PATTERN = /\((?:\\.|[^()\\]){1,2000}\)\s*Tj/g
const PDF_COMMON_SECTION_LABELS = new Set([
  'abstract',
  'introduction',
  'background',
  'method',
  'methods',
  'approach',
  'results',
  'discussion',
  'conclusion',
  'conclusions',
  'references',
])
const DOCX_TITLE_PATTERN = /<dc:title>([\s\S]*?)<\/dc:title>/i
const DOCX_PARAGRAPH_PATTERN = /<w:p\b[\s\S]{0,65536}?<\/w:p>/g
const DOCX_PARAGRAPH_STYLE_PATTERN = /<w:pStyle[^>]*w:val="([^"]+)"[^>]*\/>/i
const DOCX_TEXT_PATTERN = /<w:t(?:\s[^>]*)?>([\s\S]{0,8192}?)<\/w:t>/g
const DOCX_MAX_COMPRESSED_ENTRY_BYTES = 2_097_152
const DOCX_MAX_ENTRY_ORIGINAL_BYTES = 4_194_304
const DOCX_MAX_TOTAL_ORIGINAL_BYTES = 6_291_456
const DOCX_MAX_PARAGRAPHS = 5_000
const DOCX_MAX_TEXT_RUNS_PER_PARAGRAPH = 256
const DOCX_MAX_PARAGRAPH_TEXT_CHARS = 32_768
const DOI_CITATION_PATTERN = /\b10\.\d{4,9}\/[\-._;()/:A-Za-z0-9]{1,200}\b/gi
const ARXIV_CITATION_PATTERN = /(?:\barxiv\s{0,5}:?\s{0,5}|arxiv\.org\/abs\/)([A-Za-z\-.]{1,50}\/\d{7}|\d{4}\.\d{4,5}(?:v\d{1,3})?)/gi
const LATEX_CITATION_PATTERN = /\\cite\w{0,20}\{([^}]{1,512})\}/g
const MAX_REFERENCE_LABEL_CHARS = 220
const MAX_CITATION_KEYS_PER_LINE = 16
const REFERENCE_SECTION_LABELS = new Set(['references', 'bibliography', 'works cited', 'citations'])
const TREE_SITTER_FALLBACK_WARNINGS = new Set<string>()

type NonCodeFileType = Extract<ExtractionNode['file_type'], 'document' | 'paper' | 'image' | 'audio' | 'video'>

interface CollectFilesOptions {
  followSymlinks?: boolean
}

interface CachedExtractionPayload extends ExtractionFragment {
  __madarTsExtractorVersion: number
  __madarFileStem: string
}

interface PendingReferenceCitation {
  sourceId: string
  lineNumber: number
  referenceIndices: number[]
}

const MAX_TS_NESTED_FUNCTION_DEPTH = 10

function resolveModuleName(specifier: string): string {
  const normalized = specifier
    .replaceAll('\\', '/')
    .replace(/^node:/, '')
    .replace(/^\.\//, '')
    .replace(/^\.\//, '')
  const lastSegment = normalized.split('/').filter(Boolean).at(-1) ?? normalized
  const extension = extname(lastSegment)
  return extension ? lastSegment.slice(0, -extension.length) : lastSegment
}

function parseFrontmatterScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) {
    return trimmed
  }

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\(["'])/g, '$1')
  }

  return trimmed
}

function parseFrontmatterList(value: string): string[] {
  const inner = value.trim().slice(1, -1)
  const entries: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index]
    if (!character) {
      continue
    }

    if (quote) {
      if (character === '\\' && index + 1 < inner.length) {
        current += inner[index + 1] ?? ''
        index += 1
        continue
      }

      if (character === quote) {
        quote = null
        continue
      }

      current += character
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      continue
    }

    if (character === ',') {
      const parsed = parseFrontmatterScalar(current)
      if (parsed) {
        entries.push(parsed)
      }
      current = ''
      continue
    }

    current += character
  }

  const parsed = parseFrontmatterScalar(current)
  if (parsed) {
    entries.push(parsed)
  }

  return entries
}

function parseFrontmatterValue(rawValue: string): string | string[] {
  const trimmed = rawValue.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return parseFrontmatterList(trimmed)
  }

  return parseFrontmatterScalar(trimmed)
}

function parseStructuredTextFrontmatter(lines: string[]): { metadata: Record<string, unknown>; contentStartIndex: number } {
  if (lines[0]?.trim() !== '---') {
    return { metadata: {}, contentStartIndex: 0 }
  }

  const metadata: Record<string, unknown> = {}
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()

    if (trimmed === '---') {
      return { metadata, contentStartIndex: index + 1 }
    }

    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separatorIndex = line.indexOf(':')
    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    if (!key) {
      continue
    }

    metadata[key] = parseFrontmatterValue(line.slice(separatorIndex + 1))
  }

  return { metadata, contentStartIndex: lines.length }
}

function normalizeSectionLabel(label: string): string {
  return sanitizeLabel(
    label
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[\*_`~]/g, '')
      .trim(),
  )
}

function sectionNodeId(filePath: string, label: string, line: number): string {
  return _makeId(fileStemForPath(filePath), label, String(line))
}

function parseMarkdownHeading(lines: string[], index: number): { level: number; text: string; consumedLines: number } | null {
  const currentLine = lines[index]?.trim() ?? ''
  if (!currentLine) {
    return null
  }

  const atxMatch = currentLine.match(MARKDOWN_HEADING_PATTERN)
  if (atxMatch?.[1] && atxMatch[2]) {
    const headingText = normalizeSectionLabel(atxMatch[2])
    if (!headingText) {
      return null
    }

    return {
      level: atxMatch[1].length,
      text: headingText,
      consumedLines: 1,
    }
  }

  const nextLine = lines[index + 1]?.trim() ?? ''
  if (!nextLine) {
    return null
  }

  if (SETEXT_H1_PATTERN.test(nextLine)) {
    return {
      level: 1,
      text: normalizeSectionLabel(currentLine),
      consumedLines: 2,
    }
  }

  if (SETEXT_H2_PATTERN.test(nextLine)) {
    return {
      level: 2,
      text: normalizeSectionLabel(currentLine),
      consumedLines: 2,
    }
  }

  return null
}

function targetNodeId(targetPath: string): string {
  return fileNodeIdForPath(targetPath)
}

function isExternalReference(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)
}

function cleanReferenceTarget(rawTarget: string): string {
  return rawTarget.trim().replace(/^<|>$/g, '').split('#')[0]?.split('?')[0] ?? ''
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function addCorpusReferenceEdge(
  edges: ExtractionEdge[],
  sourceId: string,
  targetPath: string,
  relation: 'references' | 'embeds',
  filePath: string,
  lineNumber: number,
  seenEdges?: Set<string>,
): void {
  const targetId = targetNodeId(targetPath)
  if (sourceId === targetId) {
    return
  }

  const edge = createEdge(sourceId, targetId, relation, filePath, lineNumber)
  if (seenEdges) {
    addUniqueEdge(edges, seenEdges, edge)
    return
  }

  addEdge(edges, edge)
}

function addLocalReferenceEdges(
  edges: ExtractionEdge[],
  line: string,
  filePath: string,
  sourceId: string,
  lineNumber: number,
  allowedTargets: ReadonlySet<string>,
  seenEdges?: Set<string>,
): void {
  for (const match of line.matchAll(LOCAL_LINK_PATTERN)) {
    const isImage = Boolean(match[1])
    const rawTarget = match[2]
    if (!rawTarget || isExternalReference(rawTarget)) {
      continue
    }

    const cleanedTarget = cleanReferenceTarget(rawTarget)
    if (!cleanedTarget) {
      continue
    }

    const resolvedTarget = resolve(dirname(filePath), cleanedTarget)
    if (!allowedTargets.has(resolvedTarget) || !existsSync(resolvedTarget)) {
      continue
    }

    const relationTargetType = classifyFile(resolvedTarget)
    if (!relationTargetType) {
      continue
    }

    const relation = isImage || relationTargetType === FileType.IMAGE ? 'embeds' : 'references'
    addCorpusReferenceEdge(edges, sourceId, resolvedTarget, relation, filePath, lineNumber, seenEdges)
  }
}

function addMentionReferenceEdges(
  edges: ExtractionEdge[],
  line: string,
  filePath: string,
  sourceId: string,
  lineNumber: number,
  allowedTargets: ReadonlySet<string>,
  seenEdges?: Set<string>,
): void {
  const normalizedLine = line.toLowerCase()

  for (const targetPath of allowedTargets) {
    if (resolve(targetPath) === resolve(filePath) || !existsSync(targetPath)) {
      continue
    }

    const relationTargetType = classifyFile(targetPath)
    if (!relationTargetType) {
      continue
    }

    const targetName = basename(targetPath).toLowerCase()
    if (!targetName) {
      continue
    }

    const mentionPattern = new RegExp(`(^|[^a-z0-9_])${escapeRegExp(targetName)}(?=[^a-z0-9_]|$)`, 'i')
    if (!mentionPattern.test(normalizedLine)) {
      continue
    }

    const relation = relationTargetType === FileType.IMAGE ? 'embeds' : 'references'
    addCorpusReferenceEdge(edges, sourceId, targetPath, relation, filePath, lineNumber, seenEdges)
  }
}

function trimCitationValue(value: string): string {
  return value
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[.,;]+$/g, '')
}

function stripInlineCodeSpans(text: string): string {
  return text.replace(/`[^`\n]{1,200}`/g, ' ')
}

function createSemanticPaperNode(
  id: string,
  label: string,
  sourceFile: string,
  line: number,
  semanticKind: 'citation' | 'reference',
  extra: Record<string, unknown> = {},
): ExtractionNode {
  return {
    ...createNode(id, label, sourceFile, line, 'paper'),
    virtual: true,
    semantic_kind: semanticKind,
    ...extra,
  }
}

function addPaperCitationNode(
  nodes: ExtractionNode[],
  seenIds: Set<string>,
  kind: 'doi' | 'arxiv' | 'citation_key',
  value: string,
  filePath: string,
  lineNumber: number,
): string | null {
  const normalizedValue = trimCitationValue(value)
  if (!normalizedValue) {
    return null
  }

  const label = kind === 'doi' ? `DOI:${normalizedValue}` : kind === 'arxiv' ? `arXiv:${normalizedValue}` : `cite:${normalizedValue}`
  const nodeId = _makeId('citation', kind, normalizedValue)
  addNode(
    nodes,
    seenIds,
    createSemanticPaperNode(nodeId, label, filePath, lineNumber, 'citation', {
      citation_kind: kind,
      citation_value: normalizedValue,
    }),
  )
  return nodeId
}

function parseInlineReferenceCitationIndices(text: string): number[] {
  const citationText = stripInlineCodeSpans(text)
  if (/^\[(\d{1,3})\]\s+/.test(citationText.trim())) {
    return []
  }

  const indices: number[] = []
  const seen = new Set<number>()
  for (const match of citationText.matchAll(/\[(\d{1,3}(?:\s*(?:,|-)\s*\d{1,3})*)\](?!\()/g)) {
    const rawBlock = match[1]
    if (!rawBlock) {
      continue
    }

    for (const rawPart of rawBlock.split(',')) {
      const part = rawPart.trim()
      if (!part) {
        continue
      }

      if (part.includes('-')) {
        const [startPart, endPart] = part.split('-', 2)
        const startRaw = startPart ? Number.parseInt(startPart.trim(), 10) : Number.NaN
        const endRaw = endPart ? Number.parseInt(endPart.trim(), 10) : Number.NaN
        if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw) || startRaw < 1 || endRaw < startRaw) {
          continue
        }

        for (let index = startRaw; index <= endRaw && indices.length < 32; index += 1) {
          if (seen.has(index)) {
            continue
          }
          seen.add(index)
          indices.push(index)
        }
        continue
      }

      const referenceIndex = Number.parseInt(part, 10)
      if (!Number.isFinite(referenceIndex) || referenceIndex < 1 || seen.has(referenceIndex)) {
        continue
      }

      seen.add(referenceIndex)
      indices.push(referenceIndex)
      if (indices.length >= 32) {
        break
      }
    }
  }

  return indices
}

function addInlineReferenceCitationEdgesFromText(
  edges: ExtractionEdge[],
  seenEdges: Set<string>,
  text: string,
  sourceId: string,
  filePath: string,
  lineNumber: number,
  referenceNodeIdsByIndex: ReadonlyMap<number, string>,
  pendingReferenceCitations: PendingReferenceCitation[],
): void {
  const unresolvedIndices: number[] = []
  for (const referenceIndex of parseInlineReferenceCitationIndices(text)) {
    const referenceNodeId = referenceNodeIdsByIndex.get(referenceIndex)
    if (referenceNodeId) {
      addUniqueEdge(edges, seenEdges, createEdge(sourceId, referenceNodeId, 'cites', filePath, lineNumber))
      continue
    }
    unresolvedIndices.push(referenceIndex)
  }

  if (unresolvedIndices.length > 0) {
    pendingReferenceCitations.push({ sourceId, lineNumber, referenceIndices: unresolvedIndices })
  }
}

function flushPendingReferenceCitations(
  edges: ExtractionEdge[],
  seenEdges: Set<string>,
  filePath: string,
  referenceNodeIdsByIndex: ReadonlyMap<number, string>,
  pendingReferenceCitations: readonly PendingReferenceCitation[],
): void {
  for (const pending of pendingReferenceCitations) {
    for (const referenceIndex of pending.referenceIndices) {
      const referenceNodeId = referenceNodeIdsByIndex.get(referenceIndex)
      if (!referenceNodeId) {
        continue
      }
      addUniqueEdge(edges, seenEdges, createEdge(pending.sourceId, referenceNodeId, 'cites', filePath, pending.lineNumber))
    }
  }
}

function parseNumberedReferenceEntry(text: string): { rawIndex: string; referenceIndex: number; summary: string } | null {
  const match = text.match(/^\[(\d{1,3})\]\s+(.{1,400})$/)
  if (!match?.[1] || !match[2]) {
    return null
  }

  const referenceIndex = Number.parseInt(match[1], 10)
  if (Number.isNaN(referenceIndex) || referenceIndex < 1 || referenceIndex > 999) {
    return null
  }

  const summary = sanitizeLabel(match[2].replace(/\s+/g, ' ').trim()).slice(0, MAX_REFERENCE_LABEL_CHARS)
  if (!summary) {
    return null
  }

  return { rawIndex: match[1], referenceIndex, summary }
}

function parseReferenceMetadata(summary: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  const doi = summary.match(/\b10\.\d{4,9}\/[\-._;()/:A-Za-z0-9]{1,200}\b/i)?.[0]
  const arxivId = summary.match(/(?:\barxiv\s{0,5}:?\s{0,5}|arxiv\.org\/abs\/)([A-Za-z\-.]{1,50}\/\d{7}|\d{4}\.\d{4,5}(?:v\d{1,3})?)/i)?.[1]
  const yearMatch = summary.match(/\b(19|20)\d{2}\b/)

  if (doi) {
    metadata.doi = trimCitationValue(doi)
  }
  if (arxivId) {
    metadata.arxiv_id = trimCitationValue(arxivId)
  }
  if (yearMatch?.[0]) {
    const parsedYear = Number.parseInt(yearMatch[0], 10)
    if (Number.isFinite(parsedYear)) {
      metadata.reference_year = parsedYear
    }

    const authors = sanitizeLabel(summary.slice(0, yearMatch.index ?? 0).replace(/[\s.,;:-]+$/g, ''))
    if (authors) {
      metadata.reference_authors = authors
    }

    const titleSource = summary
      .slice((yearMatch.index ?? 0) + yearMatch[0].length)
      .replace(/^[\])}.:;\s-]+/, '')
      .replace(/\b(?:doi|arxiv)\s*:?[\s\S]*$/i, '')
      .trim()
    const title = sanitizeLabel(titleSource.split(/\.(?:\s|$)/, 1)[0] ?? '')
    if (title) {
      metadata.reference_title = title
    }
  }

  return metadata
}

function addCitationEdgesFromText(
  nodes: ExtractionNode[],
  edges: ExtractionEdge[],
  seenIds: Set<string>,
  seenEdges: Set<string>,
  text: string,
  sourceId: string,
  filePath: string,
  lineNumber: number,
): void {
  const citationText = stripInlineCodeSpans(text)

  for (const match of citationText.matchAll(DOI_CITATION_PATTERN)) {
    const doi = match[0]
    if (!doi) {
      continue
    }

    const citationId = addPaperCitationNode(nodes, seenIds, 'doi', doi, filePath, lineNumber)
    if (!citationId) {
      continue
    }
    addUniqueEdge(edges, seenEdges, createEdge(sourceId, citationId, 'cites', filePath, lineNumber))
  }

  for (const match of citationText.matchAll(ARXIV_CITATION_PATTERN)) {
    const arxivId = match[1]
    if (!arxivId) {
      continue
    }

    const citationId = addPaperCitationNode(nodes, seenIds, 'arxiv', arxivId, filePath, lineNumber)
    if (!citationId) {
      continue
    }
    addUniqueEdge(edges, seenEdges, createEdge(sourceId, citationId, 'cites', filePath, lineNumber))
  }

  for (const match of citationText.matchAll(LATEX_CITATION_PATTERN)) {
    const rawKeys = match[1]
    if (!rawKeys) {
      continue
    }

    for (const key of rawKeys
      .split(',')
      .map((value) => trimCitationValue(value))
      .filter(Boolean)
      .slice(0, MAX_CITATION_KEYS_PER_LINE)) {
      const citationId = addPaperCitationNode(nodes, seenIds, 'citation_key', key, filePath, lineNumber)
      if (!citationId) {
        continue
      }
      addUniqueEdge(edges, seenEdges, createEdge(sourceId, citationId, 'cites', filePath, lineNumber))
    }
  }
}

function addReferenceNodeFromText(
  nodes: ExtractionNode[],
  edges: ExtractionEdge[],
  seenIds: Set<string>,
  seenEdges: Set<string>,
  text: string,
  filePath: string,
  lineNumber: number,
  containerId: string,
): string | null {
  const entry = parseNumberedReferenceEntry(text)
  if (!entry) {
    return null
  }

  const referenceId = _makeId(fileStemForPath(filePath), 'reference', entry.rawIndex)
  addNode(
    nodes,
    seenIds,
    createSemanticPaperNode(referenceId, `[${entry.rawIndex}] ${entry.summary}`, filePath, lineNumber, 'reference', {
      reference_index: entry.referenceIndex,
      ...parseReferenceMetadata(entry.summary),
    }),
  )
  addUniqueEdge(edges, seenEdges, createEdge(containerId, referenceId, 'contains', filePath, lineNumber))
  return referenceId
}

function isCachedExtraction(value: unknown): value is CachedExtractionPayload {
  return isRecord(value)
    && value.__madarTsExtractorVersion === EXTRACTOR_CACHE_VERSION
    && typeof value.__madarFileStem === 'string'
    && Array.isArray(value.nodes)
    && Array.isArray(value.edges)
    && (
      value.diagnostics === undefined
      || (
        Array.isArray(value.diagnostics)
        && value.diagnostics.every((diagnostic) =>
          isRecord(diagnostic)
          && typeof diagnostic.code === 'string'
          && (diagnostic.level === 'info' || diagnostic.level === 'warning' || diagnostic.level === 'error')
          && (diagnostic.message === undefined || typeof diagnostic.message === 'string'))
      )
    )
}

function moduleSpecifierFromRequireCall(node: ts.CallExpression): string | null {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'require') {
    return null
  }

  const [specifier] = node.arguments
  return specifier && ts.isStringLiteralLike(specifier) ? specifier.text : null
}

function addTsImportEdge(edges: ExtractionEdge[], seenImportEdges: Set<string>, sourceId: string, specifier: string, filePath: string, line: number): void {
  const trimmedSpecifier = specifier.trim()
  if (!trimmedSpecifier || trimmedSpecifier.length > 512) {
    return
  }

  addUniqueEdge(edges, seenImportEdges, createEdge(sourceId, _makeId(resolveModuleName(trimmedSpecifier)), 'imports_from', filePath, line))
}

export function readCachedExtraction(filePath: string): ExtractionFragment | null {
  const cached = loadCached(filePath)
  if (!isCachedExtraction(cached)) {
    return null
  }
  if (cached.__madarFileStem !== fileStemForPath(filePath)) {
    return null
  }
  return {
    nodes: cached.nodes,
    edges: cached.edges,
    ...(cached.diagnostics?.length ? { diagnostics: cached.diagnostics } : {}),
  }
}

export function writeCachedExtraction(filePath: string, extraction: ExtractionFragment): void {
  saveCached(filePath, {
    __madarTsExtractorVersion: EXTRACTOR_CACHE_VERSION,
    __madarFileStem: fileStemForPath(filePath),
    nodes: extraction.nodes,
    edges: extraction.edges,
    ...(extraction.diagnostics?.length ? { diagnostics: extraction.diagnostics } : {}),
  })
}

export function collectFiles(root: string, options: CollectFilesOptions = {}): string[] {
  const result = detect(root, options.followSymlinks === undefined ? {} : { followSymlinks: options.followSymlinks })
  return result.files.code
}

function extractPythonRegex(filePath: string): ExtractionFragment {
  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = fileStemForPath(filePath)
  const fileNodeId = fileNodeIdForPath(filePath)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  const classStack: Array<{ indent: number; id: string; name: string }> = []
  const functionStack: Array<{ indent: number; id: string; classId?: string }> = []

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      return
    }

    const indent = line.length - line.trimStart().length

    while (functionStack.length > 0 && indent <= (functionStack.at(-1)?.indent ?? -1)) {
      functionStack.pop()
    }
    while (classStack.length > 0 && indent <= (classStack.at(-1)?.indent ?? -1)) {
      classStack.pop()
    }

    const importMatch = trimmed.match(/^import\s+([A-Za-z0-9_.,\s]+)/)
    if (importMatch) {
      const moduleList = importMatch[1]
      if (!moduleList) {
        return
      }
      for (const rawModule of moduleList.split(',')) {
        const moduleName = rawModule.split(' as ')[0]?.trim().replace(/^\.+/, '')
        if (!moduleName) {
          continue
        }
        addEdge(edges, createEdge(fileNodeId, _makeId(moduleName), 'imports', filePath, lineNumber))
      }
      return
    }

    const importFromMatch = trimmed.match(/^from\s+([A-Za-z0-9_\.]+)\s+import\s+/)
    if (importFromMatch) {
      const moduleName = importFromMatch[1]?.replace(/^\.+/, '')
      if (moduleName) {
        addEdge(edges, createEdge(fileNodeId, _makeId(moduleName), 'imports_from', filePath, lineNumber))
      }
      return
    }

    const classMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]+)\))?:/)
    if (classMatch) {
      const className = classMatch[1]
      if (!className) {
        return
      }
      const baseName = classMatch[2]?.split(',')[0]?.trim()
      const classId = _makeId(stem, className)
      addNode(nodes, seenIds, createNode(classId, className, filePath, lineNumber))
      addEdge(edges, createEdge(fileNodeId, classId, 'contains', filePath, lineNumber))
      if (baseName) {
        addEdge(edges, createEdge(classId, _makeId(baseName), 'inherits', filePath, lineNumber))
      }
      classStack.push({ indent, id: classId, name: className })
      return
    }

    const functionMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
    if (functionMatch) {
      const functionName = functionMatch[1]
      if (!functionName) {
        return
      }
      const parentClass = classStack.at(-1)
      if (parentClass) {
        const functionId = _makeId(parentClass.id, functionName)
        addNode(nodes, seenIds, createNode(functionId, `.${functionName}()`, filePath, lineNumber))
        addEdge(edges, createEdge(parentClass.id, functionId, 'method', filePath, lineNumber))
        methodIdsByClass.set(`${parentClass.id}:${functionName.toLowerCase()}`, functionId)
        functionStack.push({ indent, id: functionId, classId: parentClass.id })
      } else {
        const functionId = _makeId(stem, functionName)
        addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, lineNumber))
        addEdge(edges, createEdge(fileNodeId, functionId, 'contains', filePath, lineNumber))
        functionStack.push({ indent, id: functionId })
      }
      return
    }

    const currentFunction = functionStack.at(-1)
    if (!currentFunction) {
      return
    }

    const selfCallPattern = /\bself\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
    for (const match of trimmed.matchAll(selfCallPattern)) {
      const calleeName = match[1]
      if (!calleeName) {
        continue
      }
      addPendingCall(pendingCalls, {
        callerId: currentFunction.id,
        calleeName,
        line: lineNumber,
        preferredClassId: currentFunction.classId,
      })
    }

    const plainCallPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
    for (const match of trimmed.matchAll(plainCallPattern)) {
      const calleeName = match[1]
      const matchIndex = match.index ?? -1
      if (!calleeName || PYTHON_KEYWORDS.has(calleeName) || (matchIndex > 0 && trimmed[matchIndex - 1] === '.')) {
        continue
      }
      addPendingCall(pendingCalls, {
        callerId: currentFunction.id,
        calleeName,
        line: lineNumber,
      })
    }
  })

  addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
  const rationale = extractPythonRationale(filePath)
  nodes.push(...rationale.nodes)
  edges.push(...rationale.edges)

  const validNodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
  }
}

function pythonDefinitionNode(node: TreeSitterNode): TreeSitterNode | null {
  if (node.type !== 'decorated_definition') {
    return node
  }

  return namedTreeSitterChildren(node).find((child) => child.type === 'class_definition' || child.type === 'function_definition') ?? null
}

function collectPythonCalls(node: TreeSitterNode, sourceText: string, callerId: string, pendingCalls: PendingCall[], currentOwnerId?: string, isRoot = true): void {
  if (!isRoot && (node.type === 'function_definition' || node.type === 'class_definition' || node.type === 'decorated_definition')) {
    return
  }

  if (node.type === 'call') {
    const functionNode = node.childForFieldName('function')
    const line = node.startPosition.row + 1

    if (functionNode?.type === 'identifier') {
      const calleeName = treeSitterNodeText(sourceText, functionNode)?.trim()
      if (calleeName) {
        addPendingCall(pendingCalls, {
          callerId,
          calleeName,
          line,
        })
      }
    } else if (functionNode?.type === 'attribute') {
      const calleeName = treeSitterNodeText(sourceText, functionNode.childForFieldName('attribute'))?.trim()
      const objectName = treeSitterNodeText(sourceText, functionNode.childForFieldName('object'))?.trim()
      if (calleeName) {
        addPendingCall(pendingCalls, {
          callerId,
          calleeName,
          line,
          preferredClassId: currentOwnerId && (objectName === 'self' || objectName === 'cls') ? currentOwnerId : undefined,
        })
      }
    }
  }

  for (const child of namedTreeSitterChildren(node)) {
    collectPythonCalls(child, sourceText, callerId, pendingCalls, currentOwnerId, false)
  }
}

function extractPythonTreeSitter(filePath: string): ExtractionFragment | null {
  const parser = createTreeSitterWasmParser('python')
  if (!parser) {
    return null
  }

  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = fileStemForPath(filePath)
  const fileNodeId = fileNodeIdForPath(filePath)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenStructuralEdges = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []
  const pendingInherits: Array<{ sourceId: string; baseName: string; line: number }> = []
  let tree: ReturnType<typeof parser.parse> | null = null

  const ensureClassNode = (className: string, line: number, parentOwnerId?: string): string => {
    const classId = _makeId(stem, className)
    addNode(nodes, seenIds, createNode(classId, className, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(parentOwnerId ?? fileNodeId, classId, 'contains', filePath, line))
    return classId
  }

  const addPythonImports = (): void => {
    lines.forEach((line, index) => {
      const lineNumber = index + 1
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) {
        return
      }

      const importMatch = trimmed.match(/^import\s+([A-Za-z0-9_.,\s]+)/)
      if (importMatch?.[1]) {
        for (const rawModule of importMatch[1].split(',')) {
          const moduleName = rawModule.split(' as ')[0]?.trim().replace(/^\.+/, '')
          if (!moduleName) {
            continue
          }

          addUniqueEdge(edges, seenStructuralEdges, createEdge(fileNodeId, _makeId(moduleName), 'imports', filePath, lineNumber))
        }
        return
      }

      const importFromMatch = trimmed.match(/^from\s+([A-Za-z0-9_\.]+)\s+import\s+/)
      if (importFromMatch?.[1]) {
        const moduleName = importFromMatch[1].replace(/^\.+/, '')
        if (moduleName) {
          addUniqueEdge(edges, seenStructuralEdges, createEdge(fileNodeId, _makeId(moduleName), 'imports_from', filePath, lineNumber))
        }
      }
    })
  }

  const processFunction = (node: TreeSitterNode, ownerId?: string): void => {
    const functionName = treeSitterNodeText(sourceText, node.childForFieldName('name'))?.trim()
    if (!functionName) {
      return
    }

    const line = node.startPosition.row + 1
    const functionId = ownerId ? _makeId(ownerId, functionName) : _makeId(stem, functionName)
    addNode(nodes, seenIds, createNode(functionId, `${ownerId ? '.' : ''}${functionName}()`, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(ownerId ?? fileNodeId, functionId, ownerId ? 'method' : 'contains', filePath, line))
    if (ownerId) {
      methodIdsByClass.set(`${ownerId}:${functionName.toLowerCase()}`, functionId)
    }

    const bodyNode = node.childForFieldName('body')
    if (bodyNode) {
      collectPythonCalls(bodyNode, sourceText, functionId, pendingCalls, ownerId)
    }
  }

  const walkClass = (node: TreeSitterNode, parentOwnerId?: string): void => {
    const className = treeSitterNodeText(sourceText, node.childForFieldName('name'))?.trim()
    if (!className) {
      return
    }

    const line = node.startPosition.row + 1
    const classId = ensureClassNode(className, line, parentOwnerId)

    const superclassesNode = node.childForFieldName('superclasses')
    if (superclassesNode) {
      for (const child of namedTreeSitterChildren(superclassesNode)) {
        const baseName = normalizeTypeName(treeSitterNodeText(sourceText, child)?.trim() ?? '')
        if (!baseName) {
          continue
        }

        pendingInherits.push({
          sourceId: classId,
          baseName,
          line: child.startPosition.row + 1,
        })
      }
    }

    const bodyNode = node.childForFieldName('body')
    if (!bodyNode) {
      return
    }

    for (const child of namedTreeSitterChildren(bodyNode)) {
      const definitionNode = pythonDefinitionNode(child)
      if (!definitionNode) {
        continue
      }

      if (definitionNode.type === 'class_definition') {
        walkClass(definitionNode, classId)
        continue
      }

      if (definitionNode.type === 'function_definition') {
        processFunction(definitionNode, classId)
      }
    }
  }

  try {
    tree = parser.parse(sourceText)
    if (!tree) {
      return null
    }

    addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))
    addPythonImports()

    for (const child of namedTreeSitterChildren(tree.rootNode)) {
      const definitionNode = pythonDefinitionNode(child)
      if (!definitionNode) {
        continue
      }

      if (definitionNode.type === 'class_definition') {
        walkClass(definitionNode)
        continue
      }

      if (definitionNode.type === 'function_definition') {
        processFunction(definitionNode)
      }
    }

    const labelToId = new Map<string, string>()
    for (const node of nodes) {
      labelToId.set(normalizeLabel(node.label), node.id)
    }

    for (const pendingInheritance of pendingInherits) {
      const baseId = labelToId.get(normalizeLabel(pendingInheritance.baseName))
      if (!baseId) {
        continue
      }

      addUniqueEdge(edges, seenStructuralEdges, createEdge(pendingInheritance.sourceId, baseId, 'inherits', filePath, pendingInheritance.line))
    }

    addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
    const rationale = extractPythonRationale(filePath)
    nodes.push(...rationale.nodes)
    edges.push(...rationale.edges)

    const validNodeIds = new Set(nodes.map((node) => node.id))
    return {
      nodes,
      edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
    }
  } finally {
    tree?.delete()
    parser.delete()
  }
}

export function extractPython(filePath: string): ExtractionFragment {
  const extraction = extractPythonTreeSitter(filePath)
  if (extraction !== null) {
    return extraction
  }

  warnTreeSitterFallback('python')
  return withTreeSitterFallbackDiagnostic('python', extractPythonRegex(filePath))
}

function extractRubyScanner(filePath: string): ExtractionFragment {
  if (!isTextFileWithinLimit(filePath)) {
    return createTextFallbackExtraction(filePath)
  }

  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = fileStemForPath(filePath)
  const fileNodeId = fileNodeIdForPath(filePath)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  const ownerStack: Array<{ id: string; name: string }> = []
  const functionStack: Array<{ id: string; classId?: string }> = []
  const blockStack: Array<'class' | 'module' | 'def'> = []

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const trimmed = stripHashComment(line).trim()
    if (!trimmed) {
      return
    }

    if (trimmed === 'end') {
      const blockType = blockStack.pop()
      if (blockType === 'def') {
        functionStack.pop()
      }
      if (blockType === 'class' || blockType === 'module') {
        ownerStack.pop()
      }
      return
    }

    const requireRelativeMatch = trimmed.match(/^require_relative\s+['"]([^'"]+)['"]/)
    if (requireRelativeMatch?.[1]) {
      addEdge(edges, createEdge(fileNodeId, _makeId(normalizeImportTarget(requireRelativeMatch[1])), 'imports_from', filePath, lineNumber))
      return
    }

    const requireMatch = trimmed.match(/^require\s+['"]([^'"]+)['"]/)
    if (requireMatch?.[1]) {
      addEdge(edges, createEdge(fileNodeId, _makeId(normalizeImportTarget(requireMatch[1])), 'imports', filePath, lineNumber))
      return
    }

    const moduleMatch = trimmed.match(/^module\s+([A-Za-z_][A-Za-z0-9_:]*)/)
    if (moduleMatch?.[1]) {
      const moduleName = moduleMatch[1].split('::').at(-1)
      if (!moduleName) {
        return
      }
      const moduleId = _makeId(stem, moduleName)
      addNode(nodes, seenIds, createNode(moduleId, moduleName, filePath, lineNumber))
      addEdge(edges, createEdge(ownerStack[ownerStack.length - 1]?.id ?? fileNodeId, moduleId, 'contains', filePath, lineNumber))
      ownerStack.push({ id: moduleId, name: moduleName })
      blockStack.push('module')
      return
    }

    const classMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_:]*)(?:\s*<\s*([A-Za-z_][A-Za-z0-9_:]*))?/)
    if (classMatch?.[1]) {
      const className = classMatch[1].split('::').at(-1)
      if (!className) {
        return
      }
      const classId = _makeId(stem, className)
      addNode(nodes, seenIds, createNode(classId, className, filePath, lineNumber))
      addEdge(edges, createEdge(ownerStack[ownerStack.length - 1]?.id ?? fileNodeId, classId, 'contains', filePath, lineNumber))

      const baseName = classMatch[2]?.split('::').at(-1)
      if (baseName) {
        addEdge(edges, createEdge(classId, _makeId(stem, baseName), 'inherits', filePath, lineNumber))
      }

      ownerStack.push({ id: classId, name: className })
      blockStack.push('class')
      return
    }

    const functionMatch = trimmed.match(/^def\s+(?:(self|[A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_!?=]*)/)
    if (functionMatch?.[2]) {
      const functionName = functionMatch[2]
      const explicitOwner = functionMatch[1] && functionMatch[1] !== 'self' ? functionMatch[1] : undefined
      const parentClassId = explicitOwner ? _makeId(stem, explicitOwner) : ownerStack[ownerStack.length - 1]?.id

      if (parentClassId) {
        addNode(nodes, seenIds, createNode(parentClassId, explicitOwner ?? ownerStack[ownerStack.length - 1]?.name ?? stem, filePath, lineNumber))
        const functionId = _makeId(parentClassId, functionName)
        addNode(nodes, seenIds, createNode(functionId, `.${functionName}()`, filePath, lineNumber))
        addEdge(edges, createEdge(parentClassId, functionId, 'method', filePath, lineNumber))
        methodIdsByClass.set(`${parentClassId}:${functionName.toLowerCase()}`, functionId)
        functionStack.push({ id: functionId, classId: parentClassId })
      } else {
        const functionId = _makeId(stem, functionName)
        addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, lineNumber))
        addEdge(edges, createEdge(fileNodeId, functionId, 'contains', filePath, lineNumber))
        functionStack.push({ id: functionId })
      }

      blockStack.push('def')
      return
    }

    const currentFunction = functionStack[functionStack.length - 1]
    if (!currentFunction) {
      return
    }

    for (const match of trimmed.matchAll(/\bself\.([A-Za-z_][A-Za-z0-9_!?=]*)\s*\(/g)) {
      const calleeName = match[1]
      if (!calleeName) {
        continue
      }
      addPendingCall(pendingCalls, {
        callerId: currentFunction.id,
        calleeName,
        line: lineNumber,
        preferredClassId: currentFunction.classId,
      })
    }

    for (const match of trimmed.matchAll(/\b([A-Za-z_][A-Za-z0-9_!?=]*)\s*\(/g)) {
      const calleeName = match[1]
      const matchIndex = match.index ?? -1
      if (!calleeName || RUBY_KEYWORDS.has(calleeName) || (matchIndex > 0 && trimmed[matchIndex - 1] === '.')) {
        continue
      }
      addPendingCall(pendingCalls, {
        callerId: currentFunction.id,
        calleeName,
        line: lineNumber,
        preferredClassId: currentFunction.classId,
      })
    }
  })

  addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)

  const validNodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
  }
}

export function extractRuby(filePath: string): ExtractionFragment {
  const extraction = extractRubyTreeSitter(filePath)
  if (extraction !== null) {
    return extraction
  }

  warnTreeSitterFallback('ruby')
  return withTreeSitterFallbackDiagnostic('ruby', extractRubyScanner(filePath))
}

export function extractLua(filePath: string): ExtractionFragment {
  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = fileStemForPath(filePath)
  const fileNodeId = fileNodeIdForPath(filePath)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []
  const ownerIdsByName = new Map<string, string>()
  const functionStack: Array<{ id: string; classId?: string }> = []
  const blockStack: Array<'function' | 'block'> = []

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  const ensureOwner = (ownerName: string, lineNumber: number): string => {
    const existingId = ownerIdsByName.get(ownerName)
    if (existingId) {
      return existingId
    }

    const ownerId = _makeId(stem, ownerName)
    ownerIdsByName.set(ownerName, ownerId)
    addNode(nodes, seenIds, createNode(ownerId, ownerName, filePath, lineNumber))
    addEdge(edges, createEdge(fileNodeId, ownerId, 'contains', filePath, lineNumber))
    return ownerId
  }

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const trimmed = stripHashComment(line).trim()
    if (!trimmed) {
      return
    }

    if (trimmed === 'end' || trimmed === 'until') {
      const blockType = blockStack.length > 0 ? blockStack.pop() : undefined
      if (blockType === 'function') {
        functionStack.pop()
      }
      return
    }

    const requireMatch = trimmed.match(/^local\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*require\(["']([^"']+)["']\)/) ?? trimmed.match(/^require\(["']([^"']+)["']\)/)
    if (requireMatch?.[1]) {
      addEdge(edges, createEdge(fileNodeId, _makeId(normalizeImportTarget(requireMatch[1])), 'imports', filePath, lineNumber))
      return
    }

    const tableMatch = trimmed.match(/^(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{\s*\}$/)
    if (tableMatch?.[1]) {
      ensureOwner(tableMatch[1], lineNumber)
      return
    }

    const methodMatch = trimmed.match(/^function\s+([A-Za-z_][A-Za-z0-9_]*)[:.]([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
    if (methodMatch?.[1] && methodMatch[2]) {
      const ownerId = ensureOwner(methodMatch[1], lineNumber)
      const functionName = methodMatch[2]
      const functionId = _makeId(ownerId, functionName)
      addNode(nodes, seenIds, createNode(functionId, `.${functionName}()`, filePath, lineNumber))
      addEdge(edges, createEdge(ownerId, functionId, 'method', filePath, lineNumber))
      methodIdsByClass.set(`${ownerId}:${functionName.toLowerCase()}`, functionId)
      functionStack.push({ id: functionId, classId: ownerId })
      blockStack.push('function')
      return
    }

    const functionMatch = trimmed.match(/^(?:local\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
    if (functionMatch?.[1]) {
      const functionName = functionMatch[1]
      const functionId = _makeId(stem, functionName)
      addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, lineNumber))
      addEdge(edges, createEdge(fileNodeId, functionId, 'contains', filePath, lineNumber))
      functionStack.push({ id: functionId })
      blockStack.push('function')
      return
    }

    if (/\b(?:if|for|while|repeat|do)\b/.test(trimmed)) {
      blockStack.push('block')
    }

    const currentFunction = functionStack[functionStack.length - 1]
    if (!currentFunction) {
      return
    }

    for (const match of trimmed.matchAll(/\bself[:.]([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const calleeName = match[1]
      if (!calleeName) {
        continue
      }
      addPendingCall(pendingCalls, {
        callerId: currentFunction.id,
        calleeName,
        line: lineNumber,
        preferredClassId: currentFunction.classId,
      })
    }

    for (const match of trimmed.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const calleeName = match[1]
      const matchIndex = match.index ?? -1
      if (!calleeName || LUA_KEYWORDS.has(calleeName) || (matchIndex > 0 && (trimmed[matchIndex - 1] === '.' || trimmed[matchIndex - 1] === ':'))) {
        continue
      }
      addPendingCall(pendingCalls, {
        callerId: currentFunction.id,
        calleeName,
        line: lineNumber,
        preferredClassId: currentFunction.classId,
      })
    }
  })

  addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)

  const validNodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
  }
}

function extractToc(filePath: string, allowedTargets: ReadonlySet<string>): ExtractionFragment {
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const fileNode = createFileNode(filePath, 'document')

  addNode(nodes, seenIds, fileNode)

  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    const lineNumber = index + 1
    if (!trimmed) {
      continue
    }

    const metadataMatch = trimmed.match(/^##\s*([A-Za-z][A-Za-z0-9 _-]*):\s*(.+)$/)
    if (metadataMatch?.[1] && metadataMatch[2]) {
      const label = `${metadataMatch[1]}: ${metadataMatch[2].trim()}`
      const metadataId = sectionNodeId(filePath, label, lineNumber)
      addNode(nodes, seenIds, createNode(metadataId, label, filePath, lineNumber, 'document'))
      addEdge(edges, createEdge(fileNode.id, metadataId, 'contains', filePath, lineNumber))
      continue
    }

    if (trimmed.startsWith('#')) {
      continue
    }

    const cleanedTarget = cleanReferenceTarget(trimmed)
    if (!cleanedTarget) {
      continue
    }

    const resolvedTarget = resolve(dirname(filePath), cleanedTarget)
    if (!allowedTargets.has(resolvedTarget) || !existsSync(resolvedTarget)) {
      continue
    }

    addEdge(edges, createEdge(fileNode.id, targetNodeId(resolvedTarget), 'references', filePath, lineNumber))
  }

  return { nodes, edges }
}

export function extractElixir(filePath: string): ExtractionFragment {
  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = fileStemForPath(filePath)
  const fileNodeId = fileNodeIdForPath(filePath)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  const ownerStack: Array<{ id: string; name: string }> = []
  const functionStack: Array<{ id: string; classId?: string }> = []
  const blockStack: Array<'module' | 'def'> = []

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const trimmed = stripHashComment(line).trim()
    if (!trimmed) {
      return
    }

    if (trimmed === 'end') {
      const blockType = blockStack.pop()
      if (blockType === 'def') {
        functionStack.pop()
      }
      if (blockType === 'module') {
        ownerStack.pop()
      }
      return
    }

    const importMatch = trimmed.match(/^(?:alias|import|use)\s+([A-Za-z_][A-Za-z0-9_.]*)/)
    if (importMatch?.[1]) {
      addEdge(edges, createEdge(fileNodeId, _makeId(normalizeImportTarget(importMatch[1])), 'imports_from', filePath, lineNumber))
      return
    }

    const moduleMatch = trimmed.match(/^defmodule\s+([A-Za-z_][A-Za-z0-9_.]*)\s+do\b/)
    if (moduleMatch?.[1]) {
      const moduleName = moduleMatch[1].split('.').at(-1)
      if (!moduleName) {
        return
      }
      const moduleId = _makeId(stem, moduleName)
      addNode(nodes, seenIds, createNode(moduleId, moduleName, filePath, lineNumber))
      addEdge(edges, createEdge(ownerStack[ownerStack.length - 1]?.id ?? fileNodeId, moduleId, 'contains', filePath, lineNumber))
      ownerStack.push({ id: moduleId, name: moduleName })
      blockStack.push('module')
      return
    }

    const functionMatch = trimmed.match(/^defp?\s+([A-Za-z_][A-Za-z0-9_!?]*)\b(?:\s*\(|\s+do\b)/)
    if (functionMatch?.[1]) {
      const functionName = functionMatch[1]
      const parentId = ownerStack[ownerStack.length - 1]?.id
      const functionId = parentId ? _makeId(parentId, functionName) : _makeId(stem, functionName)
      addNode(nodes, seenIds, createNode(functionId, `${parentId ? '.' : ''}${functionName}()`, filePath, lineNumber))
      addEdge(edges, createEdge(parentId ?? fileNodeId, functionId, parentId ? 'method' : 'contains', filePath, lineNumber))
      if (parentId) {
        methodIdsByClass.set(`${parentId}:${functionName.toLowerCase()}`, functionId)
      }
      functionStack.push({ id: functionId, ...(parentId ? { classId: parentId } : {}) })
      blockStack.push('def')
      return
    }

    const currentFunction = functionStack[functionStack.length - 1]
    if (!currentFunction) {
      return
    }

    for (const match of trimmed.matchAll(/\b([A-Za-z_][A-Za-z0-9_!?]*)\s*\(/g)) {
      const calleeName = match[1]
      if (!calleeName || ELIXIR_KEYWORDS.has(calleeName)) {
        continue
      }
      addPendingCall(pendingCalls, {
        callerId: currentFunction.id,
        calleeName,
        line: lineNumber,
        preferredClassId: currentFunction.classId,
      })
    }
  })

  addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
  const validNodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
  }
}

export function extractJulia(filePath: string): ExtractionFragment {
  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = fileStemForPath(filePath)
  const fileNodeId = fileNodeIdForPath(filePath)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  const ownerStack: Array<{ id: string; name: string }> = []
  const functionStack: Array<{ id: string; classId?: string }> = []
  const blockStack: Array<'struct' | 'function'> = []

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const trimmed = stripHashComment(line).trim()
    if (!trimmed) {
      return
    }

    if (trimmed === 'end') {
      const blockType = blockStack.pop()
      if (blockType === 'function') {
        functionStack.pop()
      }
      if (blockType === 'struct') {
        ownerStack.pop()
      }
      return
    }

    const importMatch = trimmed.match(/^(?:using|import)\s+([A-Za-z_][A-Za-z0-9_.:]*)/)
    if (importMatch?.[1]) {
      addEdge(edges, createEdge(fileNodeId, _makeId(normalizeImportTarget(importMatch[1])), 'imports', filePath, lineNumber))
      return
    }

    const structMatch = trimmed.match(/^(?:mutable\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
    if (structMatch?.[1]) {
      const structName = structMatch[1]
      const structId = _makeId(stem, structName)
      addNode(nodes, seenIds, createNode(structId, structName, filePath, lineNumber))
      addEdge(edges, createEdge(ownerStack[ownerStack.length - 1]?.id ?? fileNodeId, structId, 'contains', filePath, lineNumber))
      ownerStack.push({ id: structId, name: structName })
      blockStack.push('struct')
      return
    }

    const functionMatch = trimmed.match(/^function\s+([A-Za-z_][A-Za-z0-9_!]*)\s*\(/) ?? trimmed.match(/^([A-Za-z_][A-Za-z0-9_!]*)\s*\([^=]*\)\s*=/)
    if (functionMatch?.[1]) {
      const functionName = functionMatch[1]
      const functionId = _makeId(stem, functionName)
      addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, lineNumber))
      addEdge(edges, createEdge(fileNodeId, functionId, 'contains', filePath, lineNumber))

      const inlineDefinition = trimmed.includes('=') && !trimmed.startsWith('function ')
      if (!inlineDefinition) {
        functionStack.push({ id: functionId })
        blockStack.push('function')
      }

      if (inlineDefinition) {
        const bodyStart = trimmed.indexOf('=') + 1
        for (const match of trimmed.slice(bodyStart).matchAll(/\b([A-Za-z_][A-Za-z0-9_!]*)\s*\(/g)) {
          const calleeName = match[1]
          if (!calleeName || JULIA_KEYWORDS.has(calleeName)) {
            continue
          }
          addPendingCall(pendingCalls, { callerId: functionId, calleeName, line: lineNumber })
        }
      }
      return
    }

    const currentFunction = functionStack[functionStack.length - 1]
    if (!currentFunction) {
      return
    }

    for (const match of trimmed.matchAll(/\b([A-Za-z_][A-Za-z0-9_!]*)\s*\(/g)) {
      const calleeName = match[1]
      if (!calleeName || JULIA_KEYWORDS.has(calleeName)) {
        continue
      }
      addPendingCall(pendingCalls, { callerId: currentFunction.id, calleeName, line: lineNumber })
    }
  })

  addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
  const validNodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
  }
}

export function extractPowerShell(filePath: string): ExtractionFragment {
  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = fileStemForPath(filePath)
  const fileNodeId = fileNodeIdForPath(filePath)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  let braceDepth = 0
  const classStack: Array<{ braceDepth: number; id: string; name: string }> = []
  const functionStack: Array<{ braceDepth: number; id: string; classId?: string }> = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    const lineNumber = index + 1
    if (!trimmed || trimmed.startsWith('//')) {
      braceDepth += braceDelta(line)
      continue
    }

    while (functionStack.length > 0 && braceDepth < (functionStack[functionStack.length - 1]?.braceDepth ?? 0)) {
      functionStack.pop()
    }
    while (classStack.length > 0 && braceDepth < (classStack[classStack.length - 1]?.braceDepth ?? 0)) {
      classStack.pop()
    }

    const importMatch = trimmed.match(/^Import-Module\s+([A-Za-z0-9_.-]+)/i) ?? trimmed.match(/^using\s+module\s+([A-Za-z0-9_.-]+)/i)
    if (importMatch?.[1]) {
      addEdge(edges, createEdge(fileNodeId, _makeId(normalizeImportTarget(importMatch[1])), 'imports', filePath, lineNumber))
      braceDepth += braceDelta(line)
      continue
    }

    const classMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)\b/i)
    if (classMatch?.[1]) {
      const className = classMatch[1]
      const classId = _makeId(stem, className)
      addNode(nodes, seenIds, createNode(classId, className, filePath, lineNumber))
      addEdge(edges, createEdge(fileNodeId, classId, 'contains', filePath, lineNumber))

      const nextBraceDepth = braceDepth + braceDelta(line)
      if (trimmed.includes('{')) {
        classStack.push({ braceDepth: Math.max(nextBraceDepth, braceDepth + 1), id: classId, name: className })
      }
      braceDepth = nextBraceDepth
      continue
    }

    let functionName: string | null = null
    let ownerClassId: string | undefined
    const currentClass = classStack[classStack.length - 1]

    const psFunctionMatch = trimmed.match(/^function\s+([A-Za-z_][A-Za-z0-9_-]*)\b/i)
    if (psFunctionMatch?.[1]) {
      functionName = psFunctionMatch[1]
    } else {
      const psMethodMatch = trimmed.match(/^\[[^\]]+\]\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\([^)]*\)\s*\{/)
      if (psMethodMatch?.[1]) {
        functionName = psMethodMatch[1]
        ownerClassId = currentClass?.id
      }
    }

    if (functionName) {
      const functionId = ownerClassId ? _makeId(ownerClassId, functionName) : _makeId(stem, functionName)
      addNode(nodes, seenIds, createNode(functionId, `${ownerClassId ? '.' : ''}${functionName}()`, filePath, lineNumber))
      addEdge(edges, createEdge(ownerClassId ?? fileNodeId, functionId, ownerClassId ? 'method' : 'contains', filePath, lineNumber))
      if (ownerClassId) {
        methodIdsByClass.set(`${ownerClassId}:${functionName.toLowerCase()}`, functionId)
      }

      const nextBraceDepth = braceDepth + braceDelta(line)
      if (trimmed.includes('{')) {
        functionStack.push({ braceDepth: Math.max(nextBraceDepth, braceDepth + 1), id: functionId, ...(ownerClassId ? { classId: ownerClassId } : {}) })
      }
      braceDepth = nextBraceDepth
      continue
    }

    const currentFunction = functionStack[functionStack.length - 1]
    if (currentFunction) {
      for (const match of trimmed.matchAll(/\b([A-Za-z_][A-Za-z0-9_-]*)\b/g)) {
        const calleeName = match[1]
        if (!calleeName || POWERSHELL_KEYWORDS.has(calleeName.toLowerCase()) || calleeName === currentClass?.name) {
          continue
        }
        const previous = trimmed[(match.index ?? 0) - 1] ?? ''
        if (previous === '$' || previous === '-' || previous === '.') {
          continue
        }
        addPendingCall(pendingCalls, { callerId: currentFunction.id, calleeName, line: lineNumber, preferredClassId: currentFunction.classId })
        break
      }
    }

    braceDepth += braceDelta(line)
  }

  addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
  const validNodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
  }
}

export function extractObjectiveC(filePath: string): ExtractionFragment {
  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  const stem = fileStemForPath(filePath)
  const fileNodeId = fileNodeIdForPath(filePath)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  let currentClass: { id: string; name: string } | undefined
  let braceDepth = 0
  const functionStack: Array<{ braceDepth: number; id: string; classId?: string }> = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    const lineNumber = index + 1
    if (!trimmed || trimmed.startsWith('//')) {
      braceDepth += braceDelta(line)
      continue
    }

    while (functionStack.length > 0 && braceDepth < (functionStack[functionStack.length - 1]?.braceDepth ?? 0)) {
      functionStack.pop()
    }

    const importMatch = trimmed.match(/^#import\s+[<"]([^>"]+)[>"]/)
    if (importMatch?.[1]) {
      addEdge(edges, createEdge(fileNodeId, _makeId(normalizeImportTarget(importMatch[1])), 'imports_from', filePath, lineNumber))
      braceDepth += braceDelta(line)
      continue
    }

    if (trimmed === '@end') {
      currentClass = undefined
      braceDepth += braceDelta(line)
      continue
    }

    const classMatch = trimmed.match(/^@(?:interface|implementation)\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
    if (classMatch?.[1]) {
      const className = classMatch[1]
      const classId = _makeId(stem, className)
      addNode(nodes, seenIds, createNode(classId, className, filePath, lineNumber))
      addEdge(edges, createEdge(fileNodeId, classId, 'contains', filePath, lineNumber))
      currentClass = { id: classId, name: className }
      braceDepth += braceDelta(line)
      continue
    }

    const methodMatch = trimmed.match(/^[+-]\s*\([^)]*\)\s*([A-Za-z_][A-Za-z0-9_]*)[^;]*\{/)
    if (methodMatch?.[1] && currentClass) {
      const functionName = methodMatch[1]
      const functionId = _makeId(currentClass.id, functionName)
      addNode(nodes, seenIds, createNode(functionId, `.${functionName}()`, filePath, lineNumber))
      addEdge(edges, createEdge(currentClass.id, functionId, 'method', filePath, lineNumber))
      methodIdsByClass.set(`${currentClass.id}:${functionName.toLowerCase()}`, functionId)

      const nextBraceDepth = braceDepth + braceDelta(line)
      functionStack.push({ braceDepth: Math.max(nextBraceDepth, braceDepth + 1), id: functionId, classId: currentClass.id })

      const inlineStart = trimmed.indexOf('{') + 1
      if (inlineStart > 0) {
        for (const match of trimmed.slice(inlineStart).matchAll(/\[[^\]]+\s+([A-Za-z_][A-Za-z0-9_]*)\]/g)) {
          const calleeName = match[1]
          if (!calleeName) {
            continue
          }
          addPendingCall(pendingCalls, { callerId: functionId, calleeName, line: lineNumber, preferredClassId: currentClass.id })
        }
      }

      braceDepth = nextBraceDepth
      continue
    }

    const currentFunction = functionStack[functionStack.length - 1]
    if (currentFunction) {
      for (const match of trimmed.matchAll(/\[[^\]]+\s+([A-Za-z_][A-Za-z0-9_]*)\]/g)) {
        const calleeName = match[1]
        if (!calleeName) {
          continue
        }
        addPendingCall(pendingCalls, { callerId: currentFunction.id, calleeName, line: lineNumber, preferredClassId: currentFunction.classId })
      }
    }

    braceDepth += braceDelta(line)
  }

  addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
  const validNodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
  }
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  const extension = extname(filePath).toLowerCase()
  switch (extension) {
    case '.ts':
      return ts.ScriptKind.TS
    case '.tsx':
      return ts.ScriptKind.TSX
    case '.jsx':
      return ts.ScriptKind.JSX
    default:
      return ts.ScriptKind.JS
  }
}

function namedTreeSitterChildren(node: TreeSitterNode): TreeSitterNode[] {
  return node.namedChildren.filter((child): child is TreeSitterNode => child !== null)
}

function treeSitterNodeText(sourceText: string, node: TreeSitterNode | null | undefined): string | null {
  if (!node) {
    return null
  }

  return sourceText.slice(node.startIndex, node.endIndex)
}

function warnTreeSitterFallback(language: 'go' | 'java' | 'python' | 'ruby' | 'rust'): void {
  const runtimeError = treeSitterWasmError()
  const warningKey = `${language}:${runtimeError ?? 'parser-unavailable'}`
  if (TREE_SITTER_FALLBACK_WARNINGS.has(warningKey)) {
    return
  }

  TREE_SITTER_FALLBACK_WARNINGS.add(warningKey)
  const suffix = runtimeError ? ` (${runtimeError})` : ''
  console.warn(`[madar] tree-sitter ${language} parser unavailable; falling back to the legacy extractor${suffix}`)
}

function withTreeSitterFallbackDiagnostic(
  language: 'go' | 'java' | 'python' | 'ruby' | 'rust',
  extraction: ExtractionFragment,
): ExtractionFragment {
  const runtimeError = treeSitterWasmError()
  return {
    ...extraction,
    diagnostics: [{
      code: `tree_sitter_${language}_fallback`,
      level: 'warning',
      ...(runtimeError ? { message: runtimeError } : {}),
    }],
  }
}

function collectGoImports(node: TreeSitterNode, sourceText: string): string[] {
  const imports: string[] = []
  for (const match of sourceText.slice(node.startIndex, node.endIndex).matchAll(/"([^"]+)"/g)) {
    const importPath = match[1]
    if (importPath) {
      imports.push(importPath)
    }
  }

  return imports
}

function lastScopedRubyName(name: string | null | undefined): string | null {
  const trimmed = name?.trim()
  if (!trimmed) {
    return null
  }

  const normalized = trimmed.replace(/^<\s*/, '').replace(/^::/, '').trim()
  if (!normalized) {
    return null
  }

  const parts = normalized.split('::').filter(Boolean)
  return parts.at(-1) ?? normalized
}

function extractRubyStringArgument(sourceText: string, node: TreeSitterNode | null | undefined): string | null {
  if (!node) {
    return null
  }

  const stringNode =
    node.type === 'argument_list' ? (namedTreeSitterChildren(node).find((child) => child.type === 'string') ?? null) : node.type === 'string' ? node : null

  if (!stringNode) {
    return null
  }

  const contentNode = namedTreeSitterChildren(stringNode).find((child) => child.type === 'string_content') ?? stringNode
  const rawValue = treeSitterNodeText(sourceText, contentNode)?.trim()
  if (!rawValue) {
    return null
  }

  return rawValue.replace(/^['"]|['"]$/g, '')
}

function collectRubyImports(
  node: TreeSitterNode,
  sourceText: string,
  fileNodeId: string,
  filePath: string,
  edges: ExtractionEdge[],
  seenStructuralEdges: Set<string>,
  depth = 0,
): void {
  if (depth >= MAX_RUBY_AST_DEPTH) {
    return
  }

  if (node.type === 'call') {
    const receiverNode = node.childForFieldName('receiver')
    const methodNode = node.childForFieldName('method') ?? namedTreeSitterChildren(node).find((child) => child.type === 'identifier') ?? null
    const methodName = treeSitterNodeText(sourceText, methodNode)?.trim()
    if (!receiverNode && (methodName === 'require' || methodName === 'require_relative')) {
      const importTarget = extractRubyStringArgument(sourceText, node.childForFieldName('arguments'))
      if (importTarget) {
        addUniqueEdge(
          edges,
          seenStructuralEdges,
          createEdge(
            fileNodeId,
            _makeId(normalizeImportTarget(importTarget)),
            methodName === 'require_relative' ? 'imports_from' : 'imports',
            filePath,
            node.startPosition.row + 1,
          ),
        )
      }
    }
  }

  for (const child of namedTreeSitterChildren(node)) {
    collectRubyImports(child, sourceText, fileNodeId, filePath, edges, seenStructuralEdges, depth + 1)
  }
}

function collectRubyCalls(
  node: TreeSitterNode,
  sourceText: string,
  stem: string,
  callerId: string,
  pendingCalls: PendingCall[],
  currentOwnerId?: string,
  depth = 0,
): void {
  if (depth >= MAX_RUBY_AST_DEPTH) {
    return
  }

  if (node.type === 'call') {
    const methodNode = node.childForFieldName('method') ?? namedTreeSitterChildren(node).find((child) => child.type === 'identifier') ?? null
    const methodName = treeSitterNodeText(sourceText, methodNode)?.trim()
    if (methodName && !RUBY_KEYWORDS.has(methodName)) {
      const receiverNode = node.childForFieldName('receiver')
      const receiverText = treeSitterNodeText(sourceText, receiverNode)?.trim()
      let preferredClassId: string | undefined

      if (receiverNode?.type === 'self') {
        preferredClassId = currentOwnerId
      } else if (receiverText && (/^[A-Z]/.test(receiverText) || receiverText.includes('::'))) {
        const ownerName = lastScopedRubyName(receiverText)
        if (ownerName) {
          preferredClassId = _makeId(stem, ownerName)
        }
      } else if (!receiverNode) {
        preferredClassId = currentOwnerId
      }

      addPendingCall(pendingCalls, {
        callerId,
        calleeName: methodName,
        line: node.startPosition.row + 1,
        preferredClassId,
      })
    }
    return
  }

  for (const child of namedTreeSitterChildren(node)) {
    if (RUBY_AST_NESTED_DECLARATION_TYPES.has(child.type)) {
      continue
    }

    if (node.type === 'body_statement' && child.type === 'identifier') {
      const calleeName = treeSitterNodeText(sourceText, child)?.trim()
      if (calleeName && !RUBY_KEYWORDS.has(calleeName)) {
        addPendingCall(pendingCalls, {
          callerId,
          calleeName,
          line: child.startPosition.row + 1,
          preferredClassId: currentOwnerId,
        })
      }
      continue
    }

    collectRubyCalls(child, sourceText, stem, callerId, pendingCalls, currentOwnerId, depth + 1)
  }
}

function extractRubyTreeSitter(filePath: string): ExtractionFragment | null {
  const parser = createTreeSitterWasmParser('ruby')
  if (!parser) {
    return null
  }

  if (!isTextFileWithinLimit(filePath)) {
    return createTextFallbackExtraction(filePath)
  }

  const sourceText = readFileSync(filePath, 'utf8')
  const stem = fileStemForPath(filePath)
  const fileNodeId = fileNodeIdForPath(filePath)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenStructuralEdges = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []
  let tree: ReturnType<typeof parser.parse> | null = null

  const ensureOwnerNode = (ownerName: string, line: number, parentOwnerId?: string): string => {
    const ownerId = _makeId(stem, ownerName)
    addNode(nodes, seenIds, createNode(ownerId, ownerName, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(parentOwnerId ?? fileNodeId, ownerId, 'contains', filePath, line))
    return ownerId
  }

  const ensureMethodNode = (ownerId: string, methodName: string, line: number): string => {
    const methodId = _makeId(ownerId, methodName)
    addNode(nodes, seenIds, createNode(methodId, `.${methodName}()`, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(ownerId, methodId, 'method', filePath, line))
    methodIdsByClass.set(`${ownerId}:${methodName.toLowerCase()}`, methodId)
    return methodId
  }

  const ensureFunctionNode = (functionName: string, line: number): string => {
    const functionId = _makeId(stem, functionName)
    addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(fileNodeId, functionId, 'contains', filePath, line))
    return functionId
  }

  const walkRubyStatements = (node: TreeSitterNode, parentOwnerId?: string, depth = 0): void => {
    if (depth >= MAX_RUBY_AST_DEPTH) {
      return
    }

    for (const child of namedTreeSitterChildren(node)) {
      if (child.type === 'module') {
        const ownerName = lastScopedRubyName(treeSitterNodeText(sourceText, child.childForFieldName('name')))
        if (!ownerName) {
          continue
        }

        const ownerId = ensureOwnerNode(ownerName, child.startPosition.row + 1, parentOwnerId)
        const bodyNode = child.childForFieldName('body')
        if (bodyNode) {
          walkRubyStatements(bodyNode, ownerId, depth + 1)
        }
        continue
      }

      if (child.type === 'class') {
        const ownerName = lastScopedRubyName(treeSitterNodeText(sourceText, child.childForFieldName('name')))
        if (!ownerName) {
          continue
        }

        const ownerId = ensureOwnerNode(ownerName, child.startPosition.row + 1, parentOwnerId)
        const superclassName = lastScopedRubyName(treeSitterNodeText(sourceText, child.childForFieldName('superclass')))
        if (superclassName) {
          addUniqueEdge(edges, seenStructuralEdges, createEdge(ownerId, _makeId(stem, superclassName), 'inherits', filePath, child.startPosition.row + 1))
        }

        const bodyNode = child.childForFieldName('body')
        if (bodyNode) {
          walkRubyStatements(bodyNode, ownerId, depth + 1)
        }
        continue
      }

      if (child.type === 'method') {
        const methodName = treeSitterNodeText(sourceText, child.childForFieldName('name'))?.trim()
        if (!methodName) {
          continue
        }

        const methodId = parentOwnerId
          ? ensureMethodNode(parentOwnerId, methodName, child.startPosition.row + 1)
          : ensureFunctionNode(methodName, child.startPosition.row + 1)
        const bodyNode = child.childForFieldName('body')
        if (bodyNode) {
          collectRubyCalls(bodyNode, sourceText, stem, methodId, pendingCalls, parentOwnerId, depth + 1)
        }
        continue
      }

      if (child.type === 'singleton_method') {
        const methodName = treeSitterNodeText(sourceText, child.childForFieldName('name'))?.trim()
        if (!methodName) {
          continue
        }

        const objectText = treeSitterNodeText(sourceText, child.childForFieldName('object'))?.trim()
        let ownerId: string | undefined
        if (objectText === 'self') {
          ownerId = parentOwnerId
        } else {
          const explicitOwnerName = lastScopedRubyName(objectText)
          if (explicitOwnerName) {
            ownerId = ensureOwnerNode(explicitOwnerName, child.startPosition.row + 1, parentOwnerId)
          }
        }

        const methodId = ownerId ? ensureMethodNode(ownerId, methodName, child.startPosition.row + 1) : ensureFunctionNode(methodName, child.startPosition.row + 1)
        const bodyNode = child.childForFieldName('body')
        if (bodyNode) {
          collectRubyCalls(bodyNode, sourceText, stem, methodId, pendingCalls, ownerId ?? parentOwnerId, depth + 1)
        }
        continue
      }
    }
  }

  try {
    tree = parser.parse(sourceText)
    if (!tree) {
      return null
    }

    addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))
    collectRubyImports(tree.rootNode, sourceText, fileNodeId, filePath, edges, seenStructuralEdges)
    walkRubyStatements(tree.rootNode)

    addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
    const validNodeIds = new Set(nodes.map((node) => node.id))
    return {
      nodes,
      edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
    }
  } finally {
    tree?.delete()
    parser.delete()
  }
}

function goReceiverInfo(sourceText: string, receiverNode: TreeSitterNode | null): { ownerName: string; receiverName?: string } | null {
  if (!receiverNode) {
    return null
  }

  const parameterNode = namedTreeSitterChildren(receiverNode).find((child) => child.type === 'parameter_declaration')
  if (!parameterNode) {
    return null
  }

  const receiverName = treeSitterNodeText(sourceText, parameterNode.childForFieldName('name')) ?? undefined
  const typeNode = parameterNode.childForFieldName('type')
  const ownerTypeNode =
    typeNode?.type === 'pointer_type'
      ? (namedTreeSitterChildren(typeNode).find((child) => child.type === 'type_identifier') ?? null)
      : typeNode?.type === 'type_identifier'
        ? typeNode
        : (namedTreeSitterChildren(typeNode ?? parameterNode).find((child) => child.type === 'type_identifier') ?? null)

  const ownerName = treeSitterNodeText(sourceText, ownerTypeNode)?.trim()
  if (!ownerName) {
    return null
  }

  return {
    ownerName,
    ...(receiverName ? { receiverName } : {}),
  }
}

function collectGoCalls(node: TreeSitterNode, sourceText: string, callerId: string, pendingCalls: PendingCall[], receiverName?: string, currentOwnerId?: string): void {
  if (node.type === 'call_expression') {
    const functionNode = node.childForFieldName('function')
    const line = node.startPosition.row + 1
    if (functionNode?.type === 'identifier') {
      const calleeName = treeSitterNodeText(sourceText, functionNode)?.trim()
      if (calleeName) {
        addPendingCall(pendingCalls, {
          callerId,
          calleeName,
          line,
        })
      }
    } else if (functionNode?.type === 'selector_expression') {
      const operandNode = functionNode.childForFieldName('operand')
      const fieldNode = functionNode.childForFieldName('field')
      const calleeName = treeSitterNodeText(sourceText, fieldNode)?.trim()
      if (calleeName) {
        const operandName = treeSitterNodeText(sourceText, operandNode)?.trim()
        addPendingCall(pendingCalls, {
          callerId,
          calleeName,
          line,
          preferredClassId: currentOwnerId && receiverName && operandName === receiverName ? currentOwnerId : undefined,
        })
      }
    }
  }

  for (const child of namedTreeSitterChildren(node)) {
    collectGoCalls(child, sourceText, callerId, pendingCalls, receiverName, currentOwnerId)
  }
}

function extractGoTreeSitter(filePath: string): ExtractionFragment | null {
  const parser = createTreeSitterWasmParser('go')
  if (!parser) {
    return null
  }

  const sourceText = readFileSync(filePath, 'utf8')
  const stem = fileStemForPath(filePath)
  const fileNodeId = fileNodeIdForPath(filePath)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenStructuralEdges = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []
  let tree: ReturnType<typeof parser.parse> | null = null

  const ensureOwnerNode = (ownerName: string, line: number): string => {
    const ownerId = _makeId(stem, ownerName)
    addNode(
      nodes,
      seenIds,
      {
        ...createNode(ownerId, ownerName, filePath, line),
        node_kind: 'class',
      },
    )
    addUniqueEdge(edges, seenStructuralEdges, createEdge(fileNodeId, ownerId, 'contains', filePath, line))
    return ownerId
  }

  const ensureMethodNode = (ownerId: string, methodName: string, line: number): string => {
    const methodId = _makeId(ownerId, methodName)
    addNode(
      nodes,
      seenIds,
      {
        ...createNode(methodId, `.${methodName}()`, filePath, line),
        node_kind: 'method',
      },
    )
    addUniqueEdge(edges, seenStructuralEdges, createEdge(ownerId, methodId, 'method', filePath, line))
    methodIdsByClass.set(`${ownerId}:${methodName.toLowerCase()}`, methodId)
    return methodId
  }

  try {
    tree = parser.parse(sourceText)
    if (!tree) {
      return null
    }

    addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

    for (const node of namedTreeSitterChildren(tree.rootNode)) {
      if (node.type === 'import_declaration') {
        for (const importPath of collectGoImports(node, sourceText)) {
          addUniqueEdge(edges, seenStructuralEdges, createEdge(fileNodeId, _makeId(resolveModuleName(importPath)), 'imports_from', filePath, node.startPosition.row + 1))
        }
        continue
      }

      if (node.type === 'type_declaration') {
        for (const typeSpec of namedTreeSitterChildren(node).filter((child) => child.type === 'type_spec')) {
          const nameNode = typeSpec.childForFieldName('name')
          const typeName = treeSitterNodeText(sourceText, nameNode)?.trim()
          if (!typeName) {
            continue
          }

          const ownerId = ensureOwnerNode(typeName, typeSpec.startPosition.row + 1)
          const typeNode = typeSpec.childForFieldName('type')
          if (typeNode?.type !== 'interface_type') {
            continue
          }

          for (const memberNode of namedTreeSitterChildren(typeNode).filter((child) => child.type === 'method_elem')) {
            const methodName = treeSitterNodeText(sourceText, memberNode.childForFieldName('name'))?.trim()
            if (!methodName) {
              continue
            }

            ensureMethodNode(ownerId, methodName, memberNode.startPosition.row + 1)
          }
        }
        continue
      }

      if (node.type === 'method_declaration') {
        const receiver = goReceiverInfo(sourceText, node.childForFieldName('receiver'))
        const methodName = treeSitterNodeText(sourceText, node.childForFieldName('name'))?.trim()
        if (!receiver?.ownerName || !methodName) {
          continue
        }

        const ownerId = ensureOwnerNode(receiver.ownerName, node.startPosition.row + 1)
        const methodId = ensureMethodNode(ownerId, methodName, node.startPosition.row + 1)
        const bodyNode = node.childForFieldName('body')
        if (bodyNode) {
          collectGoCalls(bodyNode, sourceText, methodId, pendingCalls, receiver.receiverName, ownerId)
        }
        continue
      }

      if (node.type === 'function_declaration') {
        const nameNode = node.childForFieldName('name')
        const functionName = treeSitterNodeText(sourceText, nameNode)?.trim()
        if (!functionName) {
          continue
        }

        const functionId = _makeId(stem, functionName)
        addNode(
          nodes,
          seenIds,
          {
            ...createNode(functionId, `${functionName}()`, filePath, node.startPosition.row + 1),
            node_kind: 'function',
          },
        )
        addUniqueEdge(edges, seenStructuralEdges, createEdge(fileNodeId, functionId, 'contains', filePath, node.startPosition.row + 1))

        const bodyNode = node.childForFieldName('body')
        if (bodyNode) {
          collectGoCalls(bodyNode, sourceText, functionId, pendingCalls)
        }
      }
    }

    addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
    const validNodeIds = new Set(nodes.map((node) => node.id))
    return {
      nodes,
      edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
    }
  } finally {
    tree?.delete()
    parser.delete()
  }
}

const JAVA_TYPE_DECLARATIONS = new Set(['class_declaration', 'interface_declaration', 'record_declaration', 'enum_declaration'])

function collectJavaCalls(node: TreeSitterNode, sourceText: string, callerId: string, pendingCalls: PendingCall[]): void {
  if (node.type === 'method_invocation') {
    const methodName = treeSitterNodeText(sourceText, node.childForFieldName('name'))?.trim()
    if (methodName) {
      addPendingCall(pendingCalls, {
        callerId,
        calleeName: methodName,
        line: node.startPosition.row + 1,
      })
    }
  }

  for (const child of namedTreeSitterChildren(node)) {
    if (JAVA_TYPE_DECLARATIONS.has(child.type)) {
      continue
    }

    collectJavaCalls(child, sourceText, callerId, pendingCalls)
  }
}

function extractJavaImportTarget(importText: string): string | null {
  const match = importText.match(/\bimport\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_$.]*)\s*;/)
  if (!match?.[1]) {
    return null
  }

  return normalizeImportTarget(match[1])
}

function extractJavaTreeSitter(filePath: string): ExtractionFragment | null {
  const parser = createTreeSitterWasmParser('java')
  if (!parser) {
    return null
  }

  const sourceText = readFileSync(filePath, 'utf8')
  const stem = fileStemForPath(filePath)
  const fileNodeId = fileNodeIdForPath(filePath)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenStructuralEdges = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []
  let tree: ReturnType<typeof parser.parse> | null = null

  const ensureTypeNode = (typeName: string, line: number, parentOwnerId?: string): string => {
    const typeId = _makeId(stem, typeName)
    addNode(nodes, seenIds, createNode(typeId, typeName, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(parentOwnerId ?? fileNodeId, typeId, 'contains', filePath, line))
    return typeId
  }

  const ensureMethodNode = (ownerId: string, methodName: string, line: number): string => {
    const methodId = _makeId(ownerId, methodName)
    addNode(nodes, seenIds, createNode(methodId, `.${methodName}()`, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(ownerId, methodId, 'method', filePath, line))
    methodIdsByClass.set(`${ownerId}:${methodName.toLowerCase()}`, methodId)
    return methodId
  }

  const walkTypeDeclaration = (node: TreeSitterNode, parentOwnerId?: string): void => {
    const nameNode = node.childForFieldName('name')
    const typeName = treeSitterNodeText(sourceText, nameNode)?.trim()
    if (!typeName) {
      return
    }

    const ownerId = ensureTypeNode(typeName, node.startPosition.row + 1, parentOwnerId)
    const bodyNode = node.childForFieldName('body')
    if (!bodyNode) {
      return
    }

    for (const child of namedTreeSitterChildren(bodyNode)) {
      if (JAVA_TYPE_DECLARATIONS.has(child.type)) {
        walkTypeDeclaration(child, ownerId)
        continue
      }

      if (child.type !== 'method_declaration' && child.type !== 'constructor_declaration') {
        continue
      }

      const methodName = treeSitterNodeText(sourceText, child.childForFieldName('name'))?.trim() ?? (child.type === 'constructor_declaration' ? typeName : null)
      if (!methodName) {
        continue
      }

      const methodId = ensureMethodNode(ownerId, methodName, child.startPosition.row + 1)
      const methodBody = child.childForFieldName('body')
      if (methodBody) {
        collectJavaCalls(methodBody, sourceText, methodId, pendingCalls)
      }
    }
  }

  try {
    tree = parser.parse(sourceText)
    if (!tree) {
      return null
    }

    addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

    for (const node of namedTreeSitterChildren(tree.rootNode)) {
      if (node.type === 'import_declaration') {
        const importTarget = extractJavaImportTarget(sourceText.slice(node.startIndex, node.endIndex))
        if (importTarget) {
          addUniqueEdge(edges, seenStructuralEdges, createEdge(fileNodeId, _makeId(importTarget), 'imports_from', filePath, node.startPosition.row + 1))
        }
        continue
      }

      if (JAVA_TYPE_DECLARATIONS.has(node.type)) {
        walkTypeDeclaration(node)
      }
    }

    addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
    const validNodeIds = new Set(nodes.map((node) => node.id))
    return {
      nodes,
      edges: edges.filter((edge) => validNodeIds.has(edge.source) && (validNodeIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from')),
    }
  } finally {
    tree?.delete()
    parser.delete()
  }
}

function findNamedTreeSitterChild(node: TreeSitterNode, ...types: string[]): TreeSitterNode | null {
  for (const child of namedTreeSitterChildren(node)) {
    if (types.includes(child.type)) {
      return child
    }
  }

  return null
}

interface RustScopedPath {
  isAbsolute: boolean
  superDepth: number
  segments: string[]
}

interface RustImportBinding {
  bindingName: string
  path: RustScopedPath
}

function rustScopedPath(text: string): RustScopedPath {
  const rawSegments = (text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter((segment) => !RUST_IGNORED_PATH_SEGMENTS.has(segment))
  let index = 0
  let isAbsolute = false
  let superDepth = 0

  if (rawSegments[index] === 'crate') {
    isAbsolute = true
    index += 1
  } else {
    while (rawSegments[index] === 'super') {
      superDepth += 1
      index += 1
    }

    if (rawSegments[index] === 'self') {
      index += 1
    }
  }

  return {
    isAbsolute,
    superDepth,
    segments: rawSegments.slice(index),
  }
}

function rustResolveScopedPath(path: RustScopedPath, currentNamespacePath: readonly string[]): string[] {
  if (path.isAbsolute) {
    return [...path.segments]
  }

  const basePath =
    path.superDepth > 0
      ? currentNamespacePath.slice(0, Math.max(0, currentNamespacePath.length - path.superDepth))
      : currentNamespacePath

  return [...basePath, ...path.segments]
}

function joinRustScopedPath(prefix: RustScopedPath | null, suffix: RustScopedPath): RustScopedPath {
  if (!prefix || suffix.isAbsolute || suffix.superDepth > 0) {
    return suffix
  }

  return {
    isAbsolute: prefix.isAbsolute,
    superDepth: prefix.superDepth,
    segments: [...prefix.segments, ...suffix.segments],
  }
}

function rustPathSegments(text: string): string[] {
  return rustScopedPath(text).segments
}

function rustLastPathSegment(text: string | null | undefined): string | null {
  const segments = rustPathSegments(text?.trim() ?? '')
  return segments.at(-1) ?? null
}

function rustOwnerPathKey(pathSegments: readonly string[]): string {
  return pathSegments.join('::')
}

function rustImportScopeKey(pathSegments: readonly string[]): string {
  return rustOwnerPathKey(pathSegments)
}

function rustTypeNameFromNode(node: TreeSitterNode | null | undefined, sourceText: string): string | null {
  if (!node) {
    return null
  }

  if (node.type === 'generic_type') {
    return rustTypeNameFromNode(findNamedTreeSitterChild(node, 'type_identifier', 'scoped_type_identifier'), sourceText)
  }

  if (node.type === 'type_identifier' || node.type === 'identifier') {
    return rustLastPathSegment(treeSitterNodeText(sourceText, node))
  }

  if (node.type === 'scoped_type_identifier' || node.type === 'scoped_identifier') {
    return rustLastPathSegment(treeSitterNodeText(sourceText, node))
  }

  return rustLastPathSegment(treeSitterNodeText(sourceText, node))
}

function rustScopedPathFromNode(node: TreeSitterNode | null | undefined, sourceText: string): RustScopedPath {
  if (!node) {
    return { isAbsolute: false, superDepth: 0, segments: [] }
  }

  if (node.type === 'generic_type') {
    return rustScopedPathFromNode(findNamedTreeSitterChild(node, 'type_identifier', 'scoped_type_identifier', 'scoped_identifier'), sourceText)
  }

  if (node.type === 'type_identifier' || node.type === 'identifier' || node.type === 'scoped_type_identifier' || node.type === 'scoped_identifier') {
    return rustScopedPath(treeSitterNodeText(sourceText, node) ?? '')
  }

  return rustScopedPath(treeSitterNodeText(sourceText, node) ?? '')
}

function collectRustImportPaths(node: TreeSitterNode, sourceText: string, prefix: RustScopedPath | null = null): RustImportBinding[] {
  if (node.type === 'identifier' || node.type === 'type_identifier') {
    const leafName = rustLastPathSegment(treeSitterNodeText(sourceText, node))
    return leafName ? [{ bindingName: leafName, path: joinRustScopedPath(prefix, { isAbsolute: false, superDepth: 0, segments: [leafName] }) }] : []
  }

  if (node.type === 'scoped_identifier' || node.type === 'scoped_type_identifier') {
    const scopedPath = rustScopedPath(treeSitterNodeText(sourceText, node) ?? '')
    const bindingName = scopedPath.segments.at(-1)
    return bindingName ? [{ bindingName, path: joinRustScopedPath(prefix, scopedPath) }] : []
  }

  if (node.type === 'scoped_use_list') {
    const scopedChildren = namedTreeSitterChildren(node)
    const prefixNode = scopedChildren[0]
    const listNode = scopedChildren[1]
    const nextPrefix = prefixNode ? joinRustScopedPath(prefix, rustScopedPath(treeSitterNodeText(sourceText, prefixNode) ?? '')) : prefix
    return listNode ? collectRustImportPaths(listNode, sourceText, nextPrefix) : []
  }

  if (node.type === 'use_list') {
    return namedTreeSitterChildren(node).flatMap((child) => collectRustImportPaths(child, sourceText, prefix))
  }

  if (node.type === 'use_as_clause') {
    const namedChildren = namedTreeSitterChildren(node)
    const targetNode = namedChildren[0]
    const aliasNode = namedChildren[1]
    const bindingName = rustLastPathSegment(treeSitterNodeText(sourceText, aliasNode))
    if (!targetNode || !bindingName) {
      return []
    }

    const targetBindings = collectRustImportPaths(targetNode, sourceText, prefix)
    const targetBinding = targetBindings[0]
    return targetBinding ? [{ bindingName, path: targetBinding.path }] : []
  }

  return namedTreeSitterChildren(node)
    .filter((child) => child.type !== 'visibility_modifier')
    .flatMap((child) => collectRustImportPaths(child, sourceText, prefix))
}

function collectRustCalls(
  node: TreeSitterNode,
  sourceText: string,
  callerId: string,
  pendingCalls: PendingCall[],
  ownerIdsByPath: ReadonlyMap<string, string>,
  functionIdsByPath: ReadonlyMap<string, string>,
  importedOwnerIdsByScope: ReadonlyMap<string, ReadonlyMap<string, string>>,
  externalTargetIds: Set<string>,
  currentNamespacePath: readonly string[] = [],
  currentOwnerId?: string,
): void {
  const localOwnerIds = new Set(ownerIdsByPath.values())
  const resolveImportedOwner = (receiverName: string): string | undefined => {
    return importedOwnerIdsByScope.get(rustImportScopeKey(currentNamespacePath))?.get(receiverName)
  }

  const resolveOwnerFromScopedPath = (path: RustScopedPath): string | undefined => {
    const resolvedPath = rustResolveScopedPath(path, currentNamespacePath)
    const resolvedOwnerId = ownerIdsByPath.get(rustOwnerPathKey(resolvedPath))
    if (resolvedOwnerId) {
      return resolvedOwnerId
    }

    return !path.isAbsolute && path.superDepth === 0 && path.segments.length === 1 ? resolveImportedOwner(path.segments[0] ?? '') : undefined
  }

  const addStrictRustMethodCall = (preferredOwnerId: string, callee: string, line: number): void => {
    const preferredTargetId = _makeId(preferredOwnerId, callee)
    if (!localOwnerIds.has(preferredOwnerId)) {
      externalTargetIds.add(preferredTargetId)
    }

    addPendingCall(pendingCalls, {
      callerId,
      calleeName: callee,
      line,
      preferredClassId: preferredOwnerId,
      preferredTargetId,
      strictPreferredClass: true,
    })
  }

  if (node.type === 'call_expression') {
    const functionNode = node.childForFieldName('function') ?? namedTreeSitterChildren(node).find((child) => child.type !== 'arguments') ?? null
    let calleeName: string | null = null
    let preferredClassId: string | undefined
    let strictPreferredClass = false

    if (functionNode?.type === 'field_expression') {
      const receiverNode = namedTreeSitterChildren(functionNode)[0] ?? null
      const fieldNode = namedTreeSitterChildren(functionNode).at(-1) ?? null
      calleeName = rustLastPathSegment(treeSitterNodeText(sourceText, fieldNode))
      strictPreferredClass = true
      const receiverText = treeSitterNodeText(sourceText, receiverNode)?.trim()
      if (receiverText === 'self' || receiverText === 'Self') {
        preferredClassId = currentOwnerId
      } else {
        const receiverPath = rustScopedPath(receiverText ?? '')
        preferredClassId = resolveOwnerFromScopedPath(receiverPath)
        if (!preferredClassId || !calleeName) {
          calleeName = null
        } else {
          addStrictRustMethodCall(preferredClassId, calleeName, node.startPosition.row + 1)
          calleeName = null
        }
      }
    } else {
      const functionText = treeSitterNodeText(sourceText, functionNode)?.trim()
      const scopedFunctionPath = rustScopedPath(functionText ?? '')
      calleeName = scopedFunctionPath.segments.at(-1) ?? null
      const resolvedFunctionPath = rustResolveScopedPath(scopedFunctionPath, currentNamespacePath)
      const resolvedFunctionId = functionIdsByPath.get(rustOwnerPathKey(resolvedFunctionPath))
      const receiverPath: RustScopedPath = {
        ...scopedFunctionPath,
        segments: scopedFunctionPath.segments.slice(0, -1),
      }
      if (!receiverPath.isAbsolute && receiverPath.superDepth === 0 && receiverPath.segments.length === 1 && (receiverPath.segments[0] === 'self' || receiverPath.segments[0] === 'Self')) {
        preferredClassId = currentOwnerId
        strictPreferredClass = true
      } else if (resolvedFunctionId && (receiverPath.isAbsolute || receiverPath.superDepth > 0 || receiverPath.segments.length > 0)) {
        if (!calleeName) {
          calleeName = null
        } else {
          addPendingCall(pendingCalls, {
            callerId,
            calleeName,
            line: node.startPosition.row + 1,
            preferredTargetId: resolvedFunctionId,
            strictPreferredClass: true,
          })
          calleeName = null
        }
      } else if (receiverPath.segments.length === 0 && (receiverPath.isAbsolute || receiverPath.superDepth > 0)) {
        calleeName = null
      } else if (receiverPath.segments.length > 0) {
        strictPreferredClass = true
        preferredClassId = resolveOwnerFromScopedPath(receiverPath)
        if (!preferredClassId || !calleeName) {
          calleeName = null
        } else {
          addStrictRustMethodCall(preferredClassId, calleeName, node.startPosition.row + 1)
          calleeName = null
        }
      }
    }

    if (calleeName) {
      addPendingCall(pendingCalls, {
        callerId,
        calleeName,
        line: node.startPosition.row + 1,
        ...(preferredClassId ? { preferredClassId, ...(strictPreferredClass ? { strictPreferredClass: true } : {}) } : {}),
      })
    }
  }

  for (const child of namedTreeSitterChildren(node)) {
    if (RUST_NESTED_DECLARATION_TYPES.has(child.type)) {
      continue
    }

    collectRustCalls(child, sourceText, callerId, pendingCalls, ownerIdsByPath, functionIdsByPath, importedOwnerIdsByScope, externalTargetIds, currentNamespacePath, currentOwnerId)
  }
}

function extractRustTreeSitter(filePath: string): ExtractionFragment | null {
  const parser = createTreeSitterWasmParser('rust')
  if (!parser) {
    return null
  }

  const sourceText = readFileSync(filePath, 'utf8')
  const stem = fileStemForPath(filePath)
  const fileNodeId = fileNodeIdForPath(filePath)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenStructuralEdges = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []
  const pendingRustImports: Array<{ paths: RustImportBinding[]; line: number; scopePath: readonly string[]; sourceId: string }> = []
  const pendingRustInheritances: Array<{ sourceId: string; traitPath: RustScopedPath; scopePath: readonly string[]; line: number }> = []
  const pendingRustCallBodies: Array<{ node: TreeSitterNode; callerId: string; currentNamespacePath: readonly string[]; currentOwnerId?: string }> = []
  const ownerIdsByPath = new Map<string, string>()
  const functionIdsByPath = new Map<string, string>()
  const importedOwnerIdsByScope = new Map<string, Map<string, string>>()
  const externalRustTargetIds = new Set<string>()
  let tree: ReturnType<typeof parser.parse> | null = null

  const ensureOwnerNode = (ownerPath: readonly string[], line: number): string => {
    const ownerPathKey = rustOwnerPathKey(ownerPath)
    const existingOwnerId = ownerIdsByPath.get(ownerPathKey)
    if (existingOwnerId) {
      return existingOwnerId
    }

    const ownerName = ownerPath.at(-1)
    if (!ownerName) {
      return fileNodeId
    }

    const parentOwnerPath = ownerPath.slice(0, -1)
    const parentOwnerId = parentOwnerPath.length > 0 ? ensureOwnerNode(parentOwnerPath, line) : undefined
    const ownerId = _makeId(stem, ...ownerPath)
    addNode(nodes, seenIds, createNode(ownerId, ownerName, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(parentOwnerId ?? fileNodeId, ownerId, 'contains', filePath, line))
    ownerIdsByPath.set(ownerPathKey, ownerId)
    return ownerId
  }

  const ensureMethodNode = (ownerId: string, methodName: string, line: number): string => {
    const methodId = _makeId(ownerId, methodName)
    addNode(nodes, seenIds, createNode(methodId, `.${methodName}()`, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(ownerId, methodId, 'method', filePath, line))
    methodIdsByClass.set(`${ownerId}:${methodName.toLowerCase()}`, methodId)
    return methodId
  }

  const ensureFunctionNode = (functionPath: readonly string[], functionName: string, line: number, parentOwnerId?: string): string => {
    const functionId = parentOwnerId ? _makeId(parentOwnerId, functionName) : _makeId(stem, functionName)
    addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, line))
    addUniqueEdge(edges, seenStructuralEdges, createEdge(parentOwnerId ?? fileNodeId, functionId, 'contains', filePath, line))
    functionIdsByPath.set(rustOwnerPathKey(functionPath), functionId)
    return functionId
  }

  const walkRustItems = (node: TreeSitterNode, parentOwnerId?: string, parentOwnerPath: readonly string[] = []): void => {
    for (const child of namedTreeSitterChildren(node)) {
      if (child.type === 'use_declaration') {
        pendingRustImports.push({
          paths: collectRustImportPaths(child, sourceText),
          line: child.startPosition.row + 1,
          scopePath: parentOwnerPath,
          sourceId: parentOwnerId ?? fileNodeId,
        })
        continue
      }

      if (child.type === 'mod_item') {
        const moduleName = rustLastPathSegment(treeSitterNodeText(sourceText, child.childForFieldName('name') ?? findNamedTreeSitterChild(child, 'identifier')))
        if (!moduleName) {
          continue
        }

        const modulePath = [...parentOwnerPath, moduleName]
        const moduleId = ensureOwnerNode(modulePath, child.startPosition.row + 1)
        const bodyNode = child.childForFieldName('body') ?? findNamedTreeSitterChild(child, 'declaration_list')
        if (bodyNode) {
          walkRustItems(bodyNode, moduleId, modulePath)
        }
        continue
      }

      if (RUST_TYPE_DECLARATIONS.has(child.type)) {
        const typeName = rustTypeNameFromNode(child.childForFieldName('name') ?? findNamedTreeSitterChild(child, 'type_identifier', 'identifier'), sourceText)
        if (!typeName) {
          continue
        }

        const ownerId = ensureOwnerNode([...parentOwnerPath, typeName], child.startPosition.row + 1)
        if (child.type !== 'trait_item') {
          continue
        }

        const bodyNode = child.childForFieldName('body') ?? findNamedTreeSitterChild(child, 'declaration_list')
        if (!bodyNode) {
          continue
        }

        for (const member of namedTreeSitterChildren(bodyNode)) {
          if (member.type !== 'function_item' && member.type !== 'function_signature_item') {
            continue
          }

          const methodName = rustLastPathSegment(
            treeSitterNodeText(sourceText, member.childForFieldName('name') ?? findNamedTreeSitterChild(member, 'identifier')),
          )
          if (!methodName) {
            continue
          }

          const methodId = ensureMethodNode(ownerId, methodName, member.startPosition.row + 1)
          const methodBody = member.childForFieldName('body') ?? findNamedTreeSitterChild(member, 'block')
          if (methodBody) {
            pendingRustCallBodies.push({ node: methodBody, callerId: methodId, currentNamespacePath: parentOwnerPath, currentOwnerId: ownerId })
          }
        }
        continue
      }

      if (child.type === 'impl_item') {
        const ownerTypeNode = child.childForFieldName('type') ?? findNamedTreeSitterChild(child, 'generic_type', 'type_identifier', 'scoped_type_identifier', 'scoped_identifier')
        const ownerPath = rustScopedPathFromNode(ownerTypeNode, sourceText)
        if (ownerPath.segments.length === 0) {
          continue
        }

        const effectiveOwnerPath = rustResolveScopedPath(ownerPath, parentOwnerPath)
        const ownerName = effectiveOwnerPath.at(-1)
        if (!ownerName) {
          continue
        }

        const ownerId = ensureOwnerNode(effectiveOwnerPath, child.startPosition.row + 1)
        const traitNode = child.childForFieldName('trait')
        const traitPath = rustScopedPathFromNode(traitNode, sourceText)
        if (traitPath.segments.length > 0) {
          pendingRustInheritances.push({
            sourceId: ownerId,
            traitPath,
            scopePath: parentOwnerPath,
            line: child.startPosition.row + 1,
          })
        }
        const bodyNode = child.childForFieldName('body') ?? findNamedTreeSitterChild(child, 'declaration_list')
        if (!bodyNode) {
          continue
        }

        for (const member of namedTreeSitterChildren(bodyNode)) {
          if (member.type !== 'function_item') {
            continue
          }

          const methodName = rustLastPathSegment(
            treeSitterNodeText(sourceText, member.childForFieldName('name') ?? findNamedTreeSitterChild(member, 'identifier')),
          )
          if (!methodName) {
            continue
          }

          const methodId = ensureMethodNode(ownerId, methodName, member.startPosition.row + 1)
          const methodBody = member.childForFieldName('body') ?? findNamedTreeSitterChild(member, 'block')
          if (methodBody) {
            pendingRustCallBodies.push({ node: methodBody, callerId: methodId, currentNamespacePath: parentOwnerPath, currentOwnerId: ownerId })
          }
        }
        continue
      }

      if (child.type === 'function_item') {
        const functionName = rustLastPathSegment(
          treeSitterNodeText(sourceText, child.childForFieldName('name') ?? findNamedTreeSitterChild(child, 'identifier')),
        )
        if (!functionName) {
          continue
        }

        const functionId = ensureFunctionNode([...parentOwnerPath, functionName], functionName, child.startPosition.row + 1, parentOwnerId)
        const bodyNode = child.childForFieldName('body') ?? findNamedTreeSitterChild(child, 'block')
        if (bodyNode) {
          pendingRustCallBodies.push({ node: bodyNode, callerId: functionId, currentNamespacePath: parentOwnerPath })
        }
      }
    }
  }

  try {
    tree = parser.parse(sourceText)
    if (!tree) {
      return null
    }

    addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))
    walkRustItems(tree.rootNode)
    for (const pendingImport of pendingRustImports) {
      for (const importBinding of pendingImport.paths) {
        const resolvedImportPath = rustResolveScopedPath(importBinding.path, pendingImport.scopePath)
        const pathKey = rustOwnerPathKey(resolvedImportPath)
        const targetId = ownerIdsByPath.get(pathKey) ?? _makeId(...resolvedImportPath)
        const scopeKey = rustImportScopeKey(pendingImport.scopePath)
        const scopedImports = importedOwnerIdsByScope.get(scopeKey) ?? new Map<string, string>()
        scopedImports.set(importBinding.bindingName, targetId)
        importedOwnerIdsByScope.set(scopeKey, scopedImports)
        if (!ownerIdsByPath.has(pathKey)) {
          externalRustTargetIds.add(targetId)
        }
        addUniqueEdge(edges, seenStructuralEdges, createEdge(pendingImport.sourceId, targetId, 'imports_from', filePath, pendingImport.line))
      }
    }

    const resolveRustInheritedTraitId = (traitPath: RustScopedPath, scopePath: readonly string[], line: number): string | null => {
      if (traitPath.segments.length === 0) {
        return null
      }

      const resolvedTraitPath = rustResolveScopedPath(traitPath, scopePath)
      if (traitPath.isAbsolute || traitPath.superDepth > 0 || traitPath.segments.length > 1) {
        const localTraitId = ownerIdsByPath.get(rustOwnerPathKey(resolvedTraitPath))
        if (localTraitId) {
          return localTraitId
        }

        const externalTraitId = _makeId(...resolvedTraitPath)
        externalRustTargetIds.add(externalTraitId)
        return externalTraitId
      }

      const localTraitId = ownerIdsByPath.get(rustOwnerPathKey(resolvedTraitPath))
      if (localTraitId) {
        return localTraitId
      }

      const importedTraitId = importedOwnerIdsByScope.get(rustImportScopeKey(scopePath))?.get(traitPath.segments[0] ?? '')
      if (importedTraitId) {
        if (!ownerIdsByPath.has(rustOwnerPathKey(resolvedTraitPath))) {
          externalRustTargetIds.add(importedTraitId)
        }
        return importedTraitId
      }

      return ensureOwnerNode(resolvedTraitPath, line)
    }

    for (const pendingInheritance of pendingRustInheritances) {
      const targetId = resolveRustInheritedTraitId(pendingInheritance.traitPath, pendingInheritance.scopePath, pendingInheritance.line)
      if (!targetId || targetId === pendingInheritance.sourceId) {
        continue
      }

      addUniqueEdge(
        edges,
        seenStructuralEdges,
        createEdge(pendingInheritance.sourceId, targetId, 'inherits', filePath, pendingInheritance.line),
      )
    }

    for (const pendingCallBody of pendingRustCallBodies) {
      collectRustCalls(
        pendingCallBody.node,
        sourceText,
        pendingCallBody.callerId,
        pendingCalls,
        ownerIdsByPath,
        functionIdsByPath,
        importedOwnerIdsByScope,
        externalRustTargetIds,
        pendingCallBody.currentNamespacePath,
        pendingCallBody.currentOwnerId,
      )
    }

    addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)
    const validNodeIds = new Set(nodes.map((node) => node.id))
    return {
      nodes,
      edges: edges.filter(
        (edge) =>
          validNodeIds.has(edge.source) &&
          (validNodeIds.has(edge.target) || externalRustTargetIds.has(edge.target) || edge.relation === 'imports' || edge.relation === 'imports_from'),
      ),
    }
  } finally {
    tree?.delete()
    parser.delete()
  }
}

function bodyContainsJsx(body: ts.Node): boolean {
  const jsxKinds = new Set([
    ts.SyntaxKind.JsxElement,
    ts.SyntaxKind.JsxSelfClosingElement,
    ts.SyntaxKind.JsxFragment,
    ts.SyntaxKind.JsxOpeningElement,
  ])
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (jsxKinds.has(n.kind)) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(body)
  return found
}

function collectJsxRenders(root: ts.Node, sourceFile: ts.SourceFile): string[] {
  const names: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isJsxElement(n)) {
      const tagName = n.openingElement.tagName.getText(sourceFile)
      if (tagName && /^[A-Z]/.test(tagName)) {
        names.push(tagName)
      }
    } else if (ts.isJsxSelfClosingElement(n)) {
      const tagName = n.tagName.getText(sourceFile)
      if (tagName && /^[A-Z]/.test(tagName)) {
        names.push(tagName)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(root)
  return [...new Set(names)]
}

function extractJsStages(filePath: string): StagedExtractionFragment {
  const sourceText = readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(filePath))
  const stem = fileStemForPath(filePath)
  const fileNodeId = fileNodeIdForPath(filePath)
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenImportEdges = new Set<string>()
  const methodIdsByClass = new Map<string, string>()
  const pendingCalls: PendingCall[] = []
  const isJsxFile = filePath.endsWith('.tsx') || filePath.endsWith('.jsx')

  addNode(nodes, seenIds, createNode(fileNodeId, basename(filePath), filePath, 1))

  const defaultExportId = _makeId(stem, 'default')

  const nodeOptionsForTsNode = (node: ts.Node): Parameters<typeof createNode>[5] => {
    const start = node.getStart(sourceFile)
    const end = node.getEnd()
    const endPosition = Math.max(start, end - 1)

    return {
      endLine: sourceFile.getLineAndCharacterOfPosition(endPosition).line + 1,
      snippet: sourceText.slice(start, end),
    }
  }

  const maybeMarkComponent = (functionId: string, functionName: string, body: ts.ConciseBody | undefined, line: number): void => {
    if (!isJsxFile || !body || !/^[A-Z]/.test(functionName)) return
    if (!bodyContainsJsx(body)) return
    const componentNode = nodes.find((n) => n.id === functionId)
    if (componentNode) componentNode.node_kind = 'component'
    for (const tag of collectJsxRenders(body, sourceFile)) {
      addEdge(edges, createEdge(functionId, `${tag}__jsx_proxy`, 'renders', filePath, line))
    }
  }

  const addTsFunctionNode = (functionId: string, label: string, declarationNode: ts.Node, body?: ts.ConciseBody): void => {
    const line = sourceFile.getLineAndCharacterOfPosition(declarationNode.getStart(sourceFile)).line + 1
    addNode(nodes, seenIds, createNode(functionId, label, filePath, line, 'code', nodeOptionsForTsNode(declarationNode)))
    addEdge(edges, createEdge(fileNodeId, functionId, 'contains', filePath, line))
    if (body) {
      addTsCalls(body, functionId)
      addNestedTsFunctions(body, functionId)
    }
  }

  const addTsClassNode = (classId: string, label: string, line: number, node: ts.ClassDeclaration | ts.ClassExpression): void => {
    addNode(nodes, seenIds, createNode(classId, label, filePath, line, 'code', nodeOptionsForTsNode(node)))
    addEdge(edges, createEdge(fileNodeId, classId, 'contains', filePath, line))

    for (const heritageClause of node.heritageClauses ?? []) {
      for (const heritageType of heritageClause.types) {
        const baseName = normalizeTypeName(heritageType.expression.getText(sourceFile))
        if (!baseName) {
          continue
        }

        const baseId = _makeId(stem, baseName)
        addNode(nodes, seenIds, createNode(baseId, baseName, filePath, line))
        addEdge(edges, createEdge(classId, baseId, 'inherits', filePath, line))
      }
    }

    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member) && !ts.isConstructorDeclaration(member)) {
        if (!ts.isPropertyDeclaration(member) || !member.name || !member.initializer) {
          continue
        }

        if (!ts.isArrowFunction(member.initializer) && !ts.isFunctionExpression(member.initializer)) {
          continue
        }

        const methodName = ts.isIdentifier(member.name)
          ? member.name.text
          : ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)
            ? member.name.text
            : member.name.getText(sourceFile)
        if (!methodName) {
          continue
        }

        const methodLine = sourceFile.getLineAndCharacterOfPosition(member.name.getStart(sourceFile)).line + 1
        const methodId = _makeId(classId, methodName)
        addNode(nodes, seenIds, createNode(methodId, `.${methodName}()`, filePath, methodLine, 'code', nodeOptionsForTsNode(member)))
        addEdge(edges, createEdge(classId, methodId, 'method', filePath, methodLine))
        methodIdsByClass.set(`${classId}:${methodName.toLowerCase()}`, methodId)
        addTsCalls(member.initializer.body, methodId, classId)
        addNestedTsFunctions(member.initializer.body, methodId, classId)
        continue
      }

      const methodName = ts.isConstructorDeclaration(member)
        ? 'constructor'
        : member.name && ts.isIdentifier(member.name)
          ? member.name.text
          : member.name
            ? member.name.getText(sourceFile)
            : null
      if (!methodName) {
        continue
      }

      const methodLine = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line + 1
      const methodId = _makeId(classId, methodName)
      addNode(nodes, seenIds, createNode(methodId, `.${methodName}()`, filePath, methodLine, 'code', nodeOptionsForTsNode(member)))
      addEdge(edges, createEdge(classId, methodId, 'method', filePath, methodLine))
      methodIdsByClass.set(`${classId}:${methodName.toLowerCase()}`, methodId)
      if (member.body) {
        addTsCalls(member.body, methodId, classId)
        addNestedTsFunctions(member.body, methodId, classId)
      }
    }
  }

  const addTsCalls = (node: ts.Node, callerId: string, currentClassId?: string, isRoot = true): void => {
    if (
      !isRoot &&
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node))
    ) {
      return
    }

    if (ts.isCallExpression(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      const expression = node.expression
      if (expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [specifier] = node.arguments
        if (specifier && ts.isStringLiteralLike(specifier)) {
          addTsImportEdge(edges, seenImportEdges, callerId, specifier.text, filePath, line)
        }
      } else if (moduleSpecifierFromRequireCall(node)) {
        addTsImportEdge(edges, seenImportEdges, callerId, moduleSpecifierFromRequireCall(node) ?? '', filePath, line)
      } else if (ts.isIdentifier(expression)) {
        addPendingCall(pendingCalls, {
          callerId,
          calleeName: expression.text,
          line,
        })
      } else if (ts.isPropertyAccessExpression(expression)) {
        addPendingCall(pendingCalls, {
          callerId,
          calleeName: expression.name.text,
          line,
          preferredClassId: expression.expression.kind === ts.SyntaxKind.ThisKeyword ? currentClassId : undefined,
        })
      }
    }
    ts.forEachChild(node, (child) => addTsCalls(child, callerId, currentClassId, false))
  }

  const addNestedTsFunctions = (node: ts.Node, ownerId: string, currentClassId?: string, depth = 0): void => {
    if (depth >= MAX_TS_NESTED_FUNCTION_DEPTH) {
      return
    }

    const visitNested = (candidate: ts.Node): void => {
      if (ts.isFunctionDeclaration(candidate) && candidate.name) {
        const functionName = candidate.name.text
        const functionLine = sourceFile.getLineAndCharacterOfPosition(candidate.name.getStart(sourceFile)).line + 1
        const functionId = _makeId(ownerId, functionName)
        addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, functionLine, 'code', nodeOptionsForTsNode(candidate)))
        addEdge(edges, createEdge(ownerId, functionId, 'contains', filePath, functionLine))
        if (candidate.body) {
          addTsCalls(candidate.body, functionId, currentClassId)
          addNestedTsFunctions(candidate.body, functionId, currentClassId, depth + 1)
        }
        return
      }

      if (ts.isVariableStatement(candidate)) {
        for (const declaration of candidate.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
            continue
          }

          if (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer)) {
            continue
          }

          const functionName = declaration.name.text
          const functionLine = sourceFile.getLineAndCharacterOfPosition(declaration.name.getStart(sourceFile)).line + 1
          const functionId = _makeId(ownerId, functionName)
          addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, functionLine, 'code', nodeOptionsForTsNode(declaration)))
          addEdge(edges, createEdge(ownerId, functionId, 'contains', filePath, functionLine))
          addTsCalls(declaration.initializer.body, functionId, currentClassId)
          addNestedTsFunctions(declaration.initializer.body, functionId, currentClassId, depth + 1)
        }
        return
      }

      ts.forEachChild(candidate, visitNested)
    }

    ts.forEachChild(node, visitNested)
  }

  const visitTopLevel = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      addTsImportEdge(
        edges,
        seenImportEdges,
        fileNodeId,
        node.moduleSpecifier.text,
        filePath,
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      )
      return
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      addTsImportEdge(
        edges,
        seenImportEdges,
        fileNodeId,
        node.moduleSpecifier.text,
        filePath,
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      )
      return
    }

    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      addTsImportEdge(
        edges,
        seenImportEdges,
        fileNodeId,
        node.moduleReference.expression.text,
        filePath,
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      )
      return
    }

    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const requireSpecifier = moduleSpecifierFromRequireCall(node.expression)
      if (requireSpecifier) {
        addTsImportEdge(edges, seenImportEdges, fileNodeId, requireSpecifier, filePath, sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1)
      }
      return
    }

    if (ts.isInterfaceDeclaration(node)) {
      const interfaceName = node.name.text
      const interfaceId = _makeId(stem, interfaceName)
      const interfaceLine = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile)).line + 1
      addNode(nodes, seenIds, createNode(interfaceId, interfaceName, filePath, interfaceLine, 'code', nodeOptionsForTsNode(node)))
      addEdge(edges, createEdge(fileNodeId, interfaceId, 'contains', filePath, interfaceLine))

      for (const heritageClause of node.heritageClauses ?? []) {
        for (const heritageType of heritageClause.types) {
          const baseName = normalizeTypeName(heritageType.expression.getText(sourceFile))
          if (!baseName) {
            continue
          }

          const baseId = _makeId(stem, baseName)
          addNode(nodes, seenIds, createNode(baseId, baseName, filePath, interfaceLine))
          addEdge(edges, createEdge(interfaceId, baseId, 'inherits', filePath, interfaceLine))
        }
      }
      return
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text
      const classId = _makeId(stem, className)
      const classLine = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile)).line + 1
      addTsClassNode(classId, className, classLine, node)
      return
    }

    if (ts.isClassDeclaration(node)) {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
      const isDefaultExport =
        (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false) &&
        (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false)
      if (isDefaultExport) {
        const classLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
        addTsClassNode(defaultExportId, 'default', classLine, node)
        return
      }
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      const functionName = node.name.text
      const functionId = _makeId(stem, functionName)
      const functionLine = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile)).line + 1
      addTsFunctionNode(functionId, `${functionName}()`, node, node.body)
      maybeMarkComponent(functionId, functionName, node.body, functionLine)
      return
    }

    if (ts.isFunctionDeclaration(node)) {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
      const isDefaultExport =
        (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false) &&
        (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false)
      if (isDefaultExport) {
        addTsFunctionNode(defaultExportId, 'default()', node, node.body)
        return
      }
    }

    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const exportLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      const exportExpression = unparenthesizeExpression(node.expression)
      if (ts.isArrowFunction(exportExpression) || ts.isFunctionExpression(exportExpression)) {
        addTsFunctionNode(defaultExportId, 'default()', node, exportExpression.body)
        return
      }

      if (ts.isClassExpression(exportExpression)) {
        addTsClassNode(defaultExportId, 'default', exportLine, exportExpression)
        return
      }
    }

    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue
        }

        if (ts.isCallExpression(declaration.initializer)) {
          const requireSpecifier = moduleSpecifierFromRequireCall(declaration.initializer)
          if (requireSpecifier) {
            const importLine = sourceFile.getLineAndCharacterOfPosition(declaration.name.getStart(sourceFile)).line + 1
            addTsImportEdge(edges, seenImportEdges, fileNodeId, requireSpecifier, filePath, importLine)
          }
        }

        if (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer)) {
          continue
        }

        const functionName = declaration.name.text
        const functionLine = sourceFile.getLineAndCharacterOfPosition(declaration.name.getStart(sourceFile)).line + 1
        const functionId = _makeId(stem, functionName)
        addNode(nodes, seenIds, createNode(functionId, `${functionName}()`, filePath, functionLine, 'code', nodeOptionsForTsNode(declaration)))
        addEdge(edges, createEdge(fileNodeId, functionId, 'contains', filePath, functionLine))

        const body = declaration.initializer.body
        if (body) {
          addTsCalls(body, functionId)
          addNestedTsFunctions(body, functionId)
          maybeMarkComponent(functionId, functionName, body, functionLine)
        }
      }
      return
    }

    ts.forEachChild(node, visitTopLevel)
  }

  visitTopLevel(sourceFile)
  addResolvedCalls(edges, pendingCalls, nodes, filePath, methodIdsByClass)

  const validNodeIds = new Set(nodes.map((node) => node.id))
  const baseExtraction: ExtractionFragment = {
    nodes,
    edges: edges.filter(
      (edge) =>
        validNodeIds.has(edge.source) &&
        (validNodeIds.has(edge.target) ||
          edge.relation === 'imports' ||
          edge.relation === 'imports_from' ||
          (edge.relation === 'renders' && typeof edge.target === 'string' && edge.target.endsWith('__jsx_proxy'))),
    ),
  }

  return {
    fragment: baseExtraction,
    augmentFramework: () => applyJsFrameworkAdapters(baseExtraction, {
      filePath,
      sourceText,
      sourceFile,
      stem,
      fileNodeId,
      isJsxFile,
      baseExtraction,
    }),
  }
}

export function extractJs(filePath: string): ExtractionFragment {
  return extractJsStages(filePath).augmentFramework()
}

const SINGLE_FILE_EXTRACTOR_HANDLERS: PipelineExtractorHandlerMap = {
  'builtin:extract:python': (filePath) => extractPython(filePath),
  'builtin:extract:ruby': (filePath) => extractRuby(filePath),
  'builtin:extract:lua': (filePath) => extractLua(filePath),
  'builtin:extract:toc': (filePath, allowedTargets) => extractToc(filePath, allowedTargets),
  'builtin:extract:elixir': (filePath) => extractElixir(filePath),
  'builtin:extract:julia': (filePath) => extractJulia(filePath),
  'builtin:extract:powershell': (filePath) => extractPowerShell(filePath),
  'builtin:extract:objective-c': (filePath) => extractObjectiveC(filePath),
  'builtin:extract:typescript': (filePath) => extractJsStages(filePath),
  'builtin:extract:javascript': (filePath) => extractJsStages(filePath),
  'builtin:extract:go': (filePath) => {
    const extraction = extractGoTreeSitter(filePath)
    if (extraction !== null) {
      return extraction
    }

    warnTreeSitterFallback('go')
    return withTreeSitterFallbackDiagnostic('go', extractGenericCode(filePath))
  },
  'builtin:extract:java': (filePath) => {
    const extraction = extractJavaTreeSitter(filePath)
    if (extraction !== null) {
      return extraction
    }

    warnTreeSitterFallback('java')
    return withTreeSitterFallbackDiagnostic('java', extractGenericCode(filePath))
  },
  'builtin:extract:c-family': (filePath) => extractGenericCode(filePath),
  'builtin:extract:rust': (filePath) => {
    const extraction = extractRustTreeSitter(filePath)
    if (extraction !== null) {
      return extraction
    }

    warnTreeSitterFallback('rust')
    return withTreeSitterFallbackDiagnostic('rust', extractGenericCode(filePath))
  },
  'builtin:extract:swift': (filePath) => extractGenericCode(filePath),
  'builtin:extract:kotlin': (filePath) => extractGenericCode(filePath),
  'builtin:extract:csharp': (filePath) => extractGenericCode(filePath),
  'builtin:extract:scala': (filePath) => extractGenericCode(filePath),
  'builtin:extract:php': (filePath) => extractGenericCode(filePath),
  'builtin:extract:zig': (filePath) => extractGenericCode(filePath),
  'builtin:extract:markdown': (filePath, allowedTargets) => extractDocumentFile(filePath, allowedTargets),
  'builtin:extract:markdown-paper': (filePath, allowedTargets) => extractPaperFile(filePath, allowedTargets),
  'builtin:extract:text': (filePath, allowedTargets) => extractDocumentFile(filePath, allowedTargets),
  'builtin:extract:text-paper': (filePath, allowedTargets) => extractPaperFile(filePath, allowedTargets),
  'builtin:extract:paper': (filePath, allowedTargets) => extractPaperFile(filePath, allowedTargets),
  'builtin:extract:docx': (filePath, allowedTargets) => extractDocumentFile(filePath, allowedTargets),
  'builtin:extract:xlsx': (filePath, allowedTargets) => extractDocumentFile(filePath, allowedTargets),
  'builtin:extract:image': (filePath) => extractImageFragment(filePath),
  'builtin:extract:audio': (filePath) => extractAudioFragment(filePath),
  'builtin:extract:video': (filePath) => extractVideoFragment(filePath),
}

function extractSingleFile(
  filePath: string,
  allowedTargets: ReadonlySet<string>,
  recoverFailures: boolean,
  onFileOutcome?: (outcome: ExtractionFileOutcome) => void,
  onStageDiagnostic?: ExtractionStageObserver,
): ExtractionDispatchResult {
  return dispatchSingleFileExtractionWithOutcome(filePath, allowedTargets, SINGLE_FILE_EXTRACTOR_HANDLERS, {
    registry: builtinCapabilityRegistry,
    readCached: readCachedExtraction,
    writeCached: writeCachedExtraction,
    classifySourceFile: classifyFile,
    ...(onFileOutcome ? { onOutcome: onFileOutcome } : {}),
    ...(onStageDiagnostic ? { onStageDiagnostic } : {}),
    ...(recoverFailures ? { recoverFailures: true } : {}),
  })
}

export interface ExtractOptions {
  allowedTargets?: Iterable<string>
  contextNodes?: ExtractionNode[]
  /** Reuse corpus-wide file stems when this pass is merged with another one. */
  fileStemByAbsolutePath?: ReadonlyMap<string, string>
  onFileOutcome?: (outcome: ExtractionFileOutcome) => void
  /** Source-safe stage timing/count observer; never receives paths, labels, source, or snippets. */
  onStageDiagnostic?: ExtractionStageObserver
}

export function extract(files: string[]): ExtractionData
export function extract(files: string[], options: ExtractOptions): ExtractionData
export function extract(files: string[], options: ExtractOptions = {}): ExtractionData {
  return runExtractionPipeline(files, options, options.onFileOutcome !== undefined).data
}

function runExtractionPipeline(
  files: string[],
  options: ExtractOptions,
  recoverFailures: boolean,
): ExtractionPipelineResult {
  const discovery = runPipelineStage({
    pipeline: 'extraction',
    stage: 'discovery_outcome',
    inputCount: files.length,
    outputCount: (output) => output.files.length,
    ...(options.onStageDiagnostic ? { observer: options.onStageDiagnostic } : {}),
  }, () => buildExtractionDiscoveryPlan({
    files,
    ...(options.allowedTargets ? { allowedTargets: options.allowedTargets } : {}),
    ...(options.contextNodes ? { contextNodes: options.contextNodes } : {}),
  }))
  const runWithStemContext = <T>(callback: () => T): T => options.fileStemByAbsolutePath
    ? withExtractionFileStemMapContext(options.fileStemByAbsolutePath, callback)
    : withExtractionFileStemContext(discovery.stemContextFiles, callback)

  return runWithStemContext(() => {
    const dispatchResults = discovery.files.map((filePath) => extractSingleFile(
      filePath,
      discovery.allowedTargets,
      recoverFailures,
      options.onFileOutcome,
      options.onStageDiagnostic,
    ))
    const fileOutcomes = dispatchResults.map((result) => result.outcome)
    const merged = runPipelineStage({
      pipeline: 'extraction',
      stage: 'fragment_merge',
      inputCount: dispatchResults.length,
      outputCount: (output) => output.nodes.length + output.edges.length,
      ...(options.onStageDiagnostic ? { observer: options.onStageDiagnostic } : {}),
    }, () => mergeExtractionFragments(dispatchResults.map((result) => result.fragment)))
    const data = runPipelineStage({
      pipeline: 'extraction',
      stage: 'cross_file_relationships',
      inputCount: merged.nodes.length + merged.edges.length,
      outputCount: (output) => output.nodes.length + output.edges.length,
      ...(options.onStageDiagnostic ? { observer: options.onStageDiagnostic } : {}),
    }, () => resolveCrossFileExtraction({
      files: discovery.files,
      data: merged,
      ...(options.contextNodes ? { contextNodes: options.contextNodes } : {}),
    }))
    const diagnostics = runPipelineStage({
      pipeline: 'extraction',
      stage: 'diagnostics_projection',
      inputCount: fileOutcomes.length,
      outputCount: (output) => output.length,
      warningCount: (output) => output.filter((entry) => entry.diagnostic.level !== 'info').length,
      ...(options.onStageDiagnostic ? { observer: options.onStageDiagnostic } : {}),
    }, () => projectExtractionDiagnostics(fileOutcomes))

    return { data, fileOutcomes, diagnostics }
  })
}

export function extractWithPipelineResult(
  files: string[],
  options: ExtractOptions = {},
): ExtractionPipelineResult {
  return runExtractionPipeline(files, options, true)
}
