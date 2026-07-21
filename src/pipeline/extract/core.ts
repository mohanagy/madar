import { basename, extname, resolve } from 'node:path'

import { DEFAULT_EXTRACTION_LAYER, type ExtractionEdge, type ExtractionNode } from './contracts.js'
import { createBaselineProvenance } from '../../core/provenance/types.js'
import { builtinCapabilityRegistry } from '../../infrastructure/capabilities.js'
import { sanitizeLabel } from '../../shared/security.js'
import { classifyFile, FileType, type FileTypeValue } from '../detect.js'

const EXTRACTION_STAGE = 'extract'
const CAPABILITY_CACHE = new Map<string, string | null>()
const MAX_STORED_SNIPPET_LINES = 25
const MAX_STORED_SNIPPET_CHARS = 2_000
let currentFileStemByPath: ReadonlyMap<string, string> | null = null

export interface CreateNodeOptions {
  endLine?: number
  snippet?: string
}

function normalizeStemPath(filePath: string): string {
  return resolve(filePath).replaceAll('\\', '/')
}

/**
 * Build deterministic, collision-free stems for a complete extraction corpus.
 * The temporary legacy and non-code companion passes reuse this map so files
 * with the same basename cannot overwrite one another after merging.
 */
export function createFileStemMap(filePaths: Iterable<string>): Map<string, string> {
  const normalizedPaths = [...new Set([...filePaths].map((filePath) => normalizeStemPath(filePath)))]
  const stemCounts = new Map<string, number>()
  for (const filePath of normalizedPaths) {
    const stemId = _makeId(basename(filePath, extname(filePath)))
    stemCounts.set(stemId, (stemCounts.get(stemId) ?? 0) + 1)
  }

  let commonRoot = ''
  const [firstPath] = normalizedPaths
  if (firstPath) {
    const slashAt = firstPath.lastIndexOf('/')
    commonRoot = slashAt > 0 ? firstPath.slice(0, slashAt) : ''
  }

  for (const filePath of normalizedPaths.slice(1)) {
    while (commonRoot && !(filePath === commonRoot || filePath.startsWith(`${commonRoot}/`))) {
      const slashAt = commonRoot.lastIndexOf('/')
      commonRoot = slashAt > 0 ? commonRoot.slice(0, slashAt) : ''
    }
  }

  const stems = new Map<string, string>()
  for (const filePath of normalizedPaths) {
    const basenameStem = basename(filePath, extname(filePath))
    if ((stemCounts.get(_makeId(basenameStem)) ?? 0) <= 1) {
      stems.set(filePath, basenameStem)
      continue
    }

    const withoutExtension = filePath.slice(0, filePath.length - extname(filePath).length)
    const relativeStem = commonRoot && withoutExtension.startsWith(`${commonRoot}/`)
      ? withoutExtension.slice(commonRoot.length + 1)
      : withoutExtension.replace(/^[A-Za-z]:\//, '').replace(/^\//, '')
    const segments = relativeStem.split('/').filter(Boolean)
    stems.set(filePath, segments.length > 0 ? segments.join('_') : basenameStem)
  }

  const assignedStemIds = new Set<string>()
  for (const filePath of [...normalizedPaths].sort()) {
    const stem = stems.get(filePath)!
    let uniqueStem = stem
    if (assignedStemIds.has(_makeId(uniqueStem))) {
      let suffix = 2
      while (assignedStemIds.has(_makeId(`${stem}_${suffix}`))) {
        suffix += 1
      }
      uniqueStem = `${stem}_${suffix}`
      stems.set(filePath, uniqueStem)
    }
    assignedStemIds.add(_makeId(uniqueStem))
  }

  return stems
}

export function withExtractionFileStemContext<T>(filePaths: Iterable<string>, callback: () => T): T {
  const previous = currentFileStemByPath
  currentFileStemByPath = createFileStemMap(filePaths)
  try {
    return callback()
  } finally {
    currentFileStemByPath = previous
  }
}

/**
 * Reuse a precomputed corpus-wide stem map across separate companion passes.
 * Legacy-only code and non-code files are extracted independently but share
 * one final graph with the canonical JS/TS index.
 */
export function withExtractionFileStemMapContext<T>(
  fileStemByAbsolutePath: ReadonlyMap<string, string>,
  callback: () => T,
): T {
  const previous = currentFileStemByPath
  currentFileStemByPath = fileStemByAbsolutePath
  try {
    return callback()
  } finally {
    currentFileStemByPath = previous
  }
}

export function fileStemForPath(filePath: string): string {
  return currentFileStemByPath?.get(normalizeStemPath(filePath)) ?? basename(filePath, extname(filePath))
}

export function fileNodeIdForPath(filePath: string): string {
  return _makeId(fileStemForPath(filePath))
}

function sourceFileTypeForNode(fileType: ExtractionNode['file_type']): FileTypeValue | null {
  switch (fileType) {
    case FileType.CODE:
    case FileType.DOCUMENT:
    case FileType.PAPER:
    case FileType.IMAGE:
    case FileType.AUDIO:
    case FileType.VIDEO:
      return fileType
    default:
      return null
  }
}

function extractCapabilityId(sourceFile: string, fileType?: FileTypeValue | null): string | null {
  const cacheKey = `${sourceFile}\u0000${fileType ?? ''}`
  if (CAPABILITY_CACHE.has(cacheKey)) {
    return CAPABILITY_CACHE.get(cacheKey) ?? null
  }

  const detectedFileType = fileType ?? classifyFile(sourceFile)
  const capabilityId = builtinCapabilityRegistry.resolveExtractorForPath(sourceFile, detectedFileType)?.id ?? null
  CAPABILITY_CACHE.set(cacheKey, capabilityId)
  return capabilityId
}

function createExtractionProvenance(sourceFile: string, line: number, fileType?: ExtractionNode['file_type']): NonNullable<ExtractionNode['provenance']> | null {
  const sourceFileType = fileType ? sourceFileTypeForNode(fileType) : null
  const capabilityId = extractCapabilityId(sourceFile, sourceFileType)

  if (!capabilityId) {
    return null
  }

  return [
    createBaselineProvenance({
      capabilityId,
      stage: EXTRACTION_STAGE,
      sourceFile,
      sourceLocation: toLocation(line),
    }),
  ]
}

function createEdgeProvenance(sourceFile: string, line: number): NonNullable<ExtractionEdge['provenance']> | null {
  const capabilityId = extractCapabilityId(sourceFile)

  if (!capabilityId) {
    return null
  }

  return [
    createBaselineProvenance({
      capabilityId,
      stage: EXTRACTION_STAGE,
      sourceFile,
      sourceLocation: toLocation(line),
    }),
  ]
}

export function _makeId(...parts: string[]): string {
  const combined = parts
    .map((part) => part.replace(/^[_\.]+|[_\.]+$/g, ''))
    .filter(Boolean)
    .join('_')
  return combined
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

export function toLocation(line: number, endLine?: number): string {
  return typeof endLine === 'number' && endLine > line ? `L${line}-L${endLine}` : `L${line}`
}

export function normalizeLabel(label: string): string {
  return label.replaceAll('(', '').replaceAll(')', '').replace(/^\./, '').toLowerCase()
}

export function stripHashComment(line: string): string {
  let inSingleQuote = false
  let inDoubleQuote = false
  let interpolationDepth = 0
  let escaped = false

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (!character) {
      continue
    }

    if (escaped) {
      escaped = false
      continue
    }

    if (character === '\\' && (inSingleQuote || inDoubleQuote)) {
      escaped = true
      continue
    }

    if (inDoubleQuote && character === '#' && line[index + 1] === '{') {
      interpolationDepth += 1
      index += 1
      continue
    }

    if (inDoubleQuote && interpolationDepth > 0 && character === '}') {
      interpolationDepth -= 1
      continue
    }

    if (character === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (character === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    if (character === '#' && !inSingleQuote && !inDoubleQuote && interpolationDepth === 0) {
      return line.slice(0, index)
    }
  }

  return line
}

function normalizeStoredSnippet(snippet: string | undefined): string | undefined {
  if (typeof snippet !== 'string') {
    return undefined
  }

  const normalized = snippet.replace(/\r\n?/g, '\n').trim()
  if (!normalized) {
    return undefined
  }

  const truncatedByLines = normalized.split('\n').slice(0, MAX_STORED_SNIPPET_LINES).join('\n').trim()
  if (!truncatedByLines) {
    return undefined
  }

  if (truncatedByLines.length <= MAX_STORED_SNIPPET_CHARS) {
    return truncatedByLines
  }

  return `${truncatedByLines.slice(0, MAX_STORED_SNIPPET_CHARS).trimEnd()}...`
}

export function createNode(
  id: string,
  label: string,
  sourceFile: string,
  line: number,
  fileType: ExtractionNode['file_type'] = 'code',
  options: CreateNodeOptions = {},
): ExtractionNode {
  const provenance = createExtractionProvenance(sourceFile, line, fileType)
  const snippet = normalizeStoredSnippet(options.snippet)

  return {
    id,
    label: sanitizeLabel(label),
    file_type: fileType,
    source_file: sourceFile,
    source_location: toLocation(line, options.endLine),
    layer: DEFAULT_EXTRACTION_LAYER,
    ...(provenance ? { provenance } : {}),
    ...(snippet ? { snippet } : {}),
  }
}

export function createFileNode(filePath: string, fileType: ExtractionNode['file_type']): ExtractionNode {
  return createNode(fileNodeIdForPath(filePath), basename(filePath), filePath, 1, fileType)
}

export function createEdge(
  source: string,
  target: string,
  relation: string,
  sourceFile: string,
  line: number,
  confidence: ExtractionEdge['confidence'] = 'EXTRACTED',
  weight = 1.0,
): ExtractionEdge {
  const provenance = createEdgeProvenance(sourceFile, line)

  return {
    source,
    target,
    relation,
    confidence,
    source_file: sourceFile,
    source_location: toLocation(line),
    layer: DEFAULT_EXTRACTION_LAYER,
    ...(provenance ? { provenance } : {}),
    weight,
  }
}

export function indentationLevel(line: string): number {
  return line.length - line.trimStart().length
}

export function addNode(nodes: ExtractionNode[], seenIds: Set<string>, node: ExtractionNode): void {
  if (!seenIds.has(node.id)) {
    seenIds.add(node.id)
    nodes.push(node)
  }
}

export function addEdge(edges: ExtractionEdge[], edge: ExtractionEdge): void {
  edges.push(edge)
}

export function addUniqueEdge(edges: ExtractionEdge[], seen: Set<string>, edge: ExtractionEdge): void {
  const key = `${edge.source}|${edge.target}|${edge.relation}`
  if (seen.has(key)) {
    return
  }
  seen.add(key)
  edges.push(edge)
}
