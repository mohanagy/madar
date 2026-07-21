import { basename } from 'node:path'
import { readFileSync } from 'node:fs'

import type { ExtractionEdge, ExtractionNode } from '../contracts.js'
import { MAX_TEXT_BYTES, sanitizeLabel } from '../../../shared/security.js'

const BASELINE_TEXT_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/g
const PDF_METADATA_TITLE_PATTERN = /\/Title\s*\(([^)]{1,300})\)/i
const PDF_METADATA_AUTHOR_PATTERN = /\/Author\s*\(([^)]{1,300})\)/i
const PDF_METADATA_SUBJECT_PATTERN = /\/Subject\s*\(([^)]{1,300})\)/i
const PDF_TEXT_OPERATOR_PATTERN = /\((?:\\.|[^()\\]){1,2000}\)\s*Tj/g
const PDF_TEXT_ARRAY_OPERATOR_PATTERN = /\[((?:\\.|[^\]\\]){1,4000})\]\s*TJ/g
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
const REFERENCE_SECTION_LABELS = new Set(['references', 'bibliography', 'works cited', 'citations'])

interface ExtractionFragment {
  nodes: ExtractionNode[]
  edges: ExtractionEdge[]
}

interface PendingReferenceCitation {
  sourceId: string
  lineNumber: number
  referenceIndices: number[]
}

interface ReferenceEntry {
  rawIndex: string
  referenceIndex: number
  summary: string
}

export interface PdfExtractionHelpers {
  createBinaryMetadataAwareFileNode(filePath: string, fileType: 'paper'): ExtractionNode
  finalizeNonCodeFragment(fragment: ExtractionFragment): ExtractionFragment
  addNode(nodes: ExtractionNode[], seenIds: Set<string>, node: ExtractionNode): void
  addEdge(edges: ExtractionEdge[], edge: ExtractionEdge): void
  createNode(id: string, label: string, filePath: string, line: number, fileType?: ExtractionNode['file_type']): ExtractionNode
  createEdge(source: string, target: string, relation: string, filePath: string, line: number): ExtractionEdge
  normalizeLabel(value: string): string
  sectionNodeId(filePath: string, label: string, line: number): string
  parseNumberedReferenceEntry(text: string): ReferenceEntry | null
  addReferenceNodeFromText(
    nodes: ExtractionNode[],
    edges: ExtractionEdge[],
    seenIds: Set<string>,
    seenEdges: Set<string>,
    text: string,
    filePath: string,
    lineNumber: number,
    containerId: string,
  ): string | null
  addCitationEdgesFromText(
    nodes: ExtractionNode[],
    edges: ExtractionEdge[],
    seenIds: Set<string>,
    seenEdges: Set<string>,
    text: string,
    sourceId: string,
    filePath: string,
    lineNumber: number,
  ): void
  addMentionReferenceEdges(
    edges: ExtractionEdge[],
    line: string,
    filePath: string,
    sourceId: string,
    lineNumber: number,
    allowedTargets: ReadonlySet<string>,
    seenEdges?: Set<string>,
  ): void
  addInlineReferenceCitationEdgesFromText(
    edges: ExtractionEdge[],
    seenEdges: Set<string>,
    text: string,
    sourceId: string,
    filePath: string,
    lineNumber: number,
    referenceNodeIdsByIndex: ReadonlyMap<number, string>,
    pendingReferenceCitations: PendingReferenceCitation[],
  ): void
  flushPendingReferenceCitations(
    edges: ExtractionEdge[],
    seenEdges: Set<string>,
    filePath: string,
    referenceNodeIdsByIndex: ReadonlyMap<number, string>,
    pendingReferenceCitations: readonly PendingReferenceCitation[],
  ): void
}

function decodePdfLiteral(raw: string): string {
  return sanitizeLabel(
    raw
      .replace(/\\([()\\])/g, '$1')
      .replace(/\\r/g, ' ')
      .replace(/\\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

export function extractPdfArrayText(raw: string): string {
  return sanitizeLabel(
    [...raw.matchAll(/\((?:\\.|[^()\\]){1,2000}\)/g)]
      .map((match) => decodePdfLiteral(match[0].slice(1, -1)))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

export function extractPdfTextOperations(pdfText: string): string[] {
  const operations: Array<{ index: number; text: string }> = []
  const seenOperations = new Set<string>()

  const addPdfTextOperation = (index: number, text: string): void => {
    const key = `${index}\u0000${text}`
    if (seenOperations.has(key)) {
      return
    }

    seenOperations.add(key)
    operations.push({ index, text })
  }

  for (const match of pdfText.matchAll(PDF_TEXT_OPERATOR_PATTERN)) {
    const raw = match[0]
    const endIndex = raw.lastIndexOf(') Tj')
    if (endIndex <= 0) {
      continue
    }

    const text = decodePdfLiteral(raw.slice(1, endIndex))
    if (!text) {
      continue
    }

    addPdfTextOperation(match.index ?? operations.length, text)
  }

  for (const match of pdfText.matchAll(PDF_TEXT_ARRAY_OPERATOR_PATTERN)) {
    const text = extractPdfArrayText(match[1] ?? '')
    if (!text) {
      continue
    }

    addPdfTextOperation(match.index ?? operations.length, text)
  }

  let lineOffset = 0
  for (const line of pdfText.split('\n')) {
    if (line.includes('Tj') && line.includes('(') && line.includes(')')) {
      const startIndex = line.indexOf('(')
      const endIndex = line.lastIndexOf(')')
      if (startIndex >= 0 && endIndex > startIndex && /^\)\s*Tj\b/.test(line.slice(endIndex))) {
        const text = decodePdfLiteral(line.slice(startIndex + 1, endIndex))
        if (text) {
          addPdfTextOperation(lineOffset + startIndex, text)
        }
      }
    }

    lineOffset += line.length + 1
  }

  return operations.sort((left, right) => left.index - right.index).map((entry) => entry.text)
}

export function extractPdfPaper(
  filePath: string,
  allowedTargets: ReadonlySet<string>,
  helpers: PdfExtractionHelpers,
): ExtractionFragment {
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenSemanticEdges = new Set<string>()
  const fileNode = helpers.createBinaryMetadataAwareFileNode(filePath, 'paper')

  helpers.addNode(nodes, seenIds, fileNode)

  const finalize = (): ExtractionFragment => helpers.finalizeNonCodeFragment({ nodes, edges })

  let buffer: Buffer
  try {
    buffer = readFileSync(filePath)
    if (buffer.byteLength > MAX_TEXT_BYTES) {
      return finalize()
    }
  } catch {
    return finalize()
  }

  const pdfText = buffer.toString('latin1')
  const title = decodePdfLiteral(pdfText.match(PDF_METADATA_TITLE_PATTERN)?.[1] ?? '')
  const author = decodePdfLiteral(pdfText.match(PDF_METADATA_AUTHOR_PATTERN)?.[1] ?? '')
  const subject = decodePdfLiteral(pdfText.match(PDF_METADATA_SUBJECT_PATTERN)?.[1] ?? '')
  if (title || author || subject) {
    nodes[0] = {
      ...fileNode,
      ...(title ? { title } : {}),
      ...(author ? { author } : {}),
      ...(subject ? { subject } : {}),
    }
  }
  if (title && helpers.normalizeLabel(title) !== helpers.normalizeLabel(basename(filePath))) {
    const titleId = helpers.sectionNodeId(filePath, title, 1)
    helpers.addNode(nodes, seenIds, helpers.createNode(titleId, title, filePath, 1, 'paper'))
    helpers.addEdge(edges, helpers.createEdge(fileNode.id, titleId, 'contains', filePath, 1))
  }

  const sectionLabels = new Set<string>()
  const referenceNodeIdsByIndex = new Map<number, string>()
  const pendingReferenceCitations: PendingReferenceCitation[] = []
  let currentSectionId = fileNode.id
  let currentSectionLabel: string | undefined
  let syntheticLine = 2
  for (const label of extractPdfTextOperations(pdfText)) {
    if (PDF_COMMON_SECTION_LABELS.has(helpers.normalizeLabel(label)) && !sectionLabels.has(label)) {
      sectionLabels.add(label)
      const sectionId = helpers.sectionNodeId(filePath, label, syntheticLine)
      helpers.addNode(nodes, seenIds, helpers.createNode(sectionId, label, filePath, syntheticLine, 'paper'))
      helpers.addEdge(edges, helpers.createEdge(fileNode.id, sectionId, 'contains', filePath, syntheticLine))
      currentSectionId = sectionId
      currentSectionLabel = helpers.normalizeLabel(label)
      syntheticLine += 1
      continue
    }

    const referenceEntry = currentSectionLabel && REFERENCE_SECTION_LABELS.has(currentSectionLabel) ? helpers.parseNumberedReferenceEntry(label) : null
    const referenceNodeId = referenceEntry
      ? helpers.addReferenceNodeFromText(nodes, edges, seenIds, seenSemanticEdges, label, filePath, syntheticLine, currentSectionId)
      : null
    if (referenceEntry && referenceNodeId) {
      referenceNodeIdsByIndex.set(referenceEntry.referenceIndex, referenceNodeId)
    }

    helpers.addMentionReferenceEdges(edges, label, filePath, currentSectionId, syntheticLine, allowedTargets, seenSemanticEdges)
    helpers.addCitationEdgesFromText(nodes, edges, seenIds, seenSemanticEdges, label, referenceNodeId ?? currentSectionId, filePath, syntheticLine)
    helpers.addInlineReferenceCitationEdgesFromText(
      edges,
      seenSemanticEdges,
      label,
      currentSectionId,
      filePath,
      syntheticLine,
      referenceNodeIdsByIndex,
      pendingReferenceCitations,
    )
    syntheticLine += 1
  }

  helpers.flushPendingReferenceCitations(edges, seenSemanticEdges, filePath, referenceNodeIdsByIndex, pendingReferenceCitations)
  return finalize()
}

function normalizeCompareBaselineTextLine(line: string): string {
  return line.replace(BASELINE_TEXT_CONTROL_CHAR_RE, '')
}

function decodeCompareBaselinePdfLiteral(raw: string): string {
  return normalizeCompareBaselineTextLine(
    raw
      .replace(/\\([()\\])/g, '$1')
      .replace(/\\r/g, ' ')
      .replace(/\\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

function extractCompareBaselinePdfArrayText(raw: string): string {
  return normalizeCompareBaselineTextLine(
    [...raw.matchAll(/\((?:\\.|[^()\\]){1,2000}\)/g)]
      .map((match) => decodeCompareBaselinePdfLiteral(match[0].slice(1, -1)))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

function extractCompareBaselinePdfTextOperations(pdfText: string): string[] {
  const operations: Array<{ index: number; text: string }> = []
  const seenOperations = new Set<string>()

  const addPdfTextOperation = (index: number, text: string): void => {
    const key = `${index}\u0000${text}`
    if (seenOperations.has(key)) {
      return
    }

    seenOperations.add(key)
    operations.push({ index, text })
  }

  for (const match of pdfText.matchAll(PDF_TEXT_OPERATOR_PATTERN)) {
    const raw = match[0]
    const endIndex = raw.lastIndexOf(') Tj')
    if (endIndex <= 0) {
      continue
    }

    const text = decodeCompareBaselinePdfLiteral(raw.slice(1, endIndex))
    if (!text) {
      continue
    }

    addPdfTextOperation(match.index ?? operations.length, text)
  }

  for (const match of pdfText.matchAll(PDF_TEXT_ARRAY_OPERATOR_PATTERN)) {
    const text = extractCompareBaselinePdfArrayText(match[1] ?? '')
    if (!text) {
      continue
    }

    addPdfTextOperation(match.index ?? operations.length, text)
  }

  let lineOffset = 0
  for (const line of pdfText.split('\n')) {
    if (line.includes('Tj') && line.includes('(') && line.includes(')')) {
      const startIndex = line.indexOf('(')
      const endIndex = line.lastIndexOf(')')
      if (startIndex >= 0 && endIndex > startIndex && /^\)\s*Tj\b/.test(line.slice(endIndex))) {
        const text = decodeCompareBaselinePdfLiteral(line.slice(startIndex + 1, endIndex))
        if (text) {
          addPdfTextOperation(lineOffset + startIndex, text)
        }
      }
    }

    lineOffset += line.length + 1
  }

  return operations.sort((left, right) => left.index - right.index).map((entry) => entry.text)
}

function uniqueNonEmptyLines(lines: string[]): string {
  const seen = new Set<string>()
  const uniqueLines: string[] = []

  for (const line of lines) {
    const trimmed = normalizeCompareBaselineTextLine(line).trim()
    if (!trimmed || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    uniqueLines.push(trimmed)
  }

  return uniqueLines.join('\n').trimEnd()
}

export function extractCompareBaselinePdfText(filePath: string): string {
  let buffer: Buffer
  try {
    buffer = readFileSync(filePath)
    if (buffer.byteLength > MAX_TEXT_BYTES) {
      throw new Error(`Compare baseline could not extract text from graph-backed file: ${filePath}`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Compare baseline could not extract text')) {
      throw error
    }
    throw new Error(`Compare baseline failed to extract text from graph-backed file: ${filePath}`)
  }

  const pdfText = buffer.toString('latin1')
  const lines = [
    decodeCompareBaselinePdfLiteral(pdfText.match(PDF_METADATA_TITLE_PATTERN)?.[1] ?? ''),
    decodeCompareBaselinePdfLiteral(pdfText.match(PDF_METADATA_AUTHOR_PATTERN)?.[1] ?? ''),
    decodeCompareBaselinePdfLiteral(pdfText.match(PDF_METADATA_SUBJECT_PATTERN)?.[1] ?? ''),
    ...extractCompareBaselinePdfTextOperations(pdfText),
  ]
  return uniqueNonEmptyLines(lines)
}
