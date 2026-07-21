import { basename, extname } from 'node:path'
import { readFileSync, statSync } from 'node:fs'

import { strFromU8, unzipSync, type UnzipFileInfo } from 'fflate'

import type { ExtractionEdge, ExtractionNode } from '../contracts.js'
import { MAX_TEXT_BYTES, sanitizeLabel } from '../../../shared/security.js'

const BASELINE_TEXT_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/g
const OOXML_TITLE_PATTERN = /<dc:title>([\s\S]*?)<\/dc:title>/i
const OOXML_CREATOR_PATTERN = /<dc:creator>([\s\S]*?)<\/dc:creator>/i
const OOXML_SUBJECT_PATTERN = /<dc:subject>([\s\S]*?)<\/dc:subject>/i
const OOXML_DESCRIPTION_PATTERN = /<dc:description>([\s\S]*?)<\/dc:description>/i
const DOCX_PARAGRAPH_PATTERN = /<w:p\b[\s\S]{0,65536}?<\/w:p>/g
const DOCX_PARAGRAPH_STYLE_PATTERN = /<w:pStyle[^>]*w:val="([^"]+)"[^>]*\/>/i
const DOCX_TEXT_PATTERN = /<w:t(?:\s[^>]*)?>([\s\S]{0,8192}?)<\/w:t>/g
const DOCX_MAX_COMPRESSED_ENTRY_BYTES = 2_097_152
const DOCX_MAX_ENTRY_ORIGINAL_BYTES = 4_194_304
const DOCX_MAX_TOTAL_ORIGINAL_BYTES = 6_291_456
const DOCX_MAX_PARAGRAPHS = 5_000
const DOCX_MAX_TEXT_RUNS_PER_PARAGRAPH = 256
const DOCX_MAX_PARAGRAPH_TEXT_CHARS = 32_768
const XLSX_SHEET_PATTERN = /<sheet\b[^>]*name="([^"]{1,256})"[^>]*\/?/gi
const XLSX_SHARED_STRING_ITEM_PATTERN = /<si\b[\s\S]{0,65536}?<\/si>/g
const XLSX_TEXT_PATTERN = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]{0,8192}?)<\/(?:\w+:)?t>/g
const MAX_STRUCTURED_TEXT_LINES = 100_000
const REFERENCE_SECTION_LABELS = new Set(['references', 'bibliography', 'works cited', 'citations'])

type StructuredTextFileType = 'document' | 'paper'

interface ExtractionFragment {
  nodes: ExtractionNode[]
  edges: ExtractionEdge[]
}

interface PendingReferenceCitation {
  sourceId: string
  lineNumber: number
  referenceIndices: number[]
}

interface MarkdownHeading {
  level: number
  text: string
  consumedLines: number
}

interface ReferenceEntry {
  rawIndex: string
  referenceIndex: number
  summary: string
}

export interface DocumentExtractionHelpers {
  createFileNode(filePath: string, fileType: StructuredTextFileType): ExtractionNode
  createBinaryMetadataAwareFileNode(filePath: string, fileType: 'document'): ExtractionNode
  finalizeNonCodeFragment(fragment: ExtractionFragment): ExtractionFragment
  addNode(nodes: ExtractionNode[], seenIds: Set<string>, node: ExtractionNode): void
  addEdge(edges: ExtractionEdge[], edge: ExtractionEdge): void
  createNode(id: string, label: string, filePath: string, line: number, fileType?: ExtractionNode['file_type']): ExtractionNode
  createEdge(source: string, target: string, relation: string, filePath: string, line: number): ExtractionEdge
  normalizeLabel(value: string): string
  sectionNodeId(filePath: string, label: string, line: number): string
  parseStructuredTextFrontmatter(lines: string[]): { metadata: Record<string, unknown>; contentStartIndex: number }
  parseMarkdownHeading(lines: string[], index: number): MarkdownHeading | null
  addLocalReferenceEdges(
    edges: ExtractionEdge[],
    line: string,
    filePath: string,
    sourceId: string,
    lineNumber: number,
    allowedTargets: ReadonlySet<string>,
    seenEdges?: Set<string>,
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

export function decodeXmlText(text: string): string {
  return sanitizeLabel(
    text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

function extractCoreMetadata(coreXml: string): Record<string, unknown> {
  const title = decodeXmlText(coreXml.match(OOXML_TITLE_PATTERN)?.[1] ?? '')
  const author = decodeXmlText(coreXml.match(OOXML_CREATOR_PATTERN)?.[1] ?? '')
  const subject = decodeXmlText(coreXml.match(OOXML_SUBJECT_PATTERN)?.[1] ?? '')
  const description = decodeXmlText(coreXml.match(OOXML_DESCRIPTION_PATTERN)?.[1] ?? '')

  return {
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(subject ? { subject } : {}),
    ...(description ? { description } : {}),
  }
}

function isAllowedOfficeEntry(
  file: UnzipFileInfo,
  selectedOriginalBytes: { value: number },
  allowedNames: ReadonlySet<string>,
  maxCompressedBytes: number,
  maxOriginalBytes: number,
  maxTotalOriginalBytes: number,
): boolean {
  if (!allowedNames.has(file.name)) {
    return false
  }

  if (file.size > maxCompressedBytes || file.originalSize > maxOriginalBytes) {
    return false
  }

  selectedOriginalBytes.value += file.originalSize
  return selectedOriginalBytes.value <= maxTotalOriginalBytes
}

export function extractStructuredText(
  filePath: string,
  fileType: StructuredTextFileType,
  allowedTargets: ReadonlySet<string>,
  helpers: DocumentExtractionHelpers,
): ExtractionFragment {
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenSemanticEdges = new Set<string>()
  const fileNode = helpers.createFileNode(filePath, fileType)

  helpers.addNode(nodes, seenIds, fileNode)

  try {
    if (statSync(filePath).size > MAX_TEXT_BYTES) {
      return { nodes, edges }
    }
  } catch {
    return { nodes, edges }
  }

  const sourceText = readFileSync(filePath, 'utf8')
  const lines = sourceText.split(/\r?\n/)
  if (lines.length > MAX_STRUCTURED_TEXT_LINES) {
    return { nodes, edges }
  }
  const { metadata: frontmatterMetadata, contentStartIndex } = helpers.parseStructuredTextFrontmatter(lines)

  if (Object.keys(frontmatterMetadata).length > 0) {
    nodes[0] = { ...frontmatterMetadata, ...fileNode }
  }

  const headingStack: Array<{ level: number; id: string; label: string }> = []
  const referenceNodeIdsByIndex = new Map<number, string>()
  const pendingReferenceCitations: PendingReferenceCitation[] = []
  let fenceMarker: '```' | '~~~' | null = null

  for (let index = contentStartIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    const lineNumber = index + 1

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      const marker = trimmed.startsWith('```') ? '```' : '~~~'
      fenceMarker = fenceMarker === marker ? null : marker
      continue
    }

    if (fenceMarker) {
      continue
    }

    const heading = helpers.parseMarkdownHeading(lines, index)
    if (heading && heading.text) {
      const nodeId = helpers.sectionNodeId(filePath, heading.text, lineNumber)
      helpers.addNode(nodes, seenIds, helpers.createNode(nodeId, heading.text, filePath, lineNumber, fileType))

      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= heading.level) {
        headingStack.pop()
      }

      const parentId = headingStack[headingStack.length - 1]?.id ?? fileNode.id
      helpers.addEdge(edges, helpers.createEdge(parentId, nodeId, 'contains', filePath, lineNumber))
      headingStack.push({ level: heading.level, id: nodeId, label: helpers.normalizeLabel(heading.text) })

      helpers.addLocalReferenceEdges(edges, line, filePath, nodeId, lineNumber, allowedTargets, seenSemanticEdges)
      helpers.addMentionReferenceEdges(edges, line, filePath, nodeId, lineNumber, allowedTargets, seenSemanticEdges)

      if (heading.consumedLines === 2) {
        index += 1
      }
      continue
    }

    if (!trimmed) {
      continue
    }

    const currentSectionId = headingStack[headingStack.length - 1]?.id ?? fileNode.id
    const currentSectionLabel = headingStack[headingStack.length - 1]?.label
    const referenceEntry = currentSectionLabel && REFERENCE_SECTION_LABELS.has(currentSectionLabel) ? helpers.parseNumberedReferenceEntry(line) : null
    const referenceNodeId = referenceEntry
      ? helpers.addReferenceNodeFromText(nodes, edges, seenIds, seenSemanticEdges, line, filePath, lineNumber, currentSectionId)
      : null
    if (referenceEntry && referenceNodeId) {
      referenceNodeIdsByIndex.set(referenceEntry.referenceIndex, referenceNodeId)
    }

    helpers.addLocalReferenceEdges(edges, line, filePath, currentSectionId, lineNumber, allowedTargets, seenSemanticEdges)
    helpers.addMentionReferenceEdges(edges, line, filePath, currentSectionId, lineNumber, allowedTargets, seenSemanticEdges)
    helpers.addCitationEdgesFromText(nodes, edges, seenIds, seenSemanticEdges, line, referenceNodeId ?? currentSectionId, filePath, lineNumber)
    helpers.addInlineReferenceCitationEdgesFromText(
      edges,
      seenSemanticEdges,
      line,
      currentSectionId,
      filePath,
      lineNumber,
      referenceNodeIdsByIndex,
      pendingReferenceCitations,
    )
  }

  helpers.flushPendingReferenceCitations(edges, seenSemanticEdges, filePath, referenceNodeIdsByIndex, pendingReferenceCitations)
  return helpers.finalizeNonCodeFragment({ nodes, edges })
}

export function extractDocxParagraphText(paragraphXml: string): string {
  let combined = ''
  let runCount = 0

  for (const match of paragraphXml.matchAll(DOCX_TEXT_PATTERN)) {
    const fragment = match[1] ?? ''
    if (!fragment) {
      continue
    }

    combined += fragment
    runCount += 1
    if (runCount >= DOCX_MAX_TEXT_RUNS_PER_PARAGRAPH || combined.length >= DOCX_MAX_PARAGRAPH_TEXT_CHARS) {
      break
    }
  }

  return decodeXmlText(combined.slice(0, DOCX_MAX_PARAGRAPH_TEXT_CHARS))
}

export function extractDocxDocument(
  filePath: string,
  allowedTargets: ReadonlySet<string>,
  helpers: DocumentExtractionHelpers,
): ExtractionFragment {
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenSemanticEdges = new Set<string>()
  const fileNode = helpers.createBinaryMetadataAwareFileNode(filePath, 'document')

  helpers.addNode(nodes, seenIds, fileNode)

  const finalize = (): ExtractionFragment => helpers.finalizeNonCodeFragment({ nodes, edges })

  let archive: Record<string, Uint8Array>
  try {
    const buffer = readFileSync(filePath)
    if (buffer.byteLength > MAX_TEXT_BYTES) {
      return finalize()
    }
    const selectedOriginalBytes = { value: 0 }
    archive = unzipSync(new Uint8Array(buffer), {
      filter: (file) =>
        isAllowedOfficeEntry(
          file,
          selectedOriginalBytes,
          new Set(['word/document.xml', 'docProps/core.xml']),
          DOCX_MAX_COMPRESSED_ENTRY_BYTES,
          DOCX_MAX_ENTRY_ORIGINAL_BYTES,
          DOCX_MAX_TOTAL_ORIGINAL_BYTES,
        ),
    })
  } catch {
    return finalize()
  }

  const coreXmlBytes = archive['docProps/core.xml']
  if (coreXmlBytes && coreXmlBytes.byteLength > DOCX_MAX_ENTRY_ORIGINAL_BYTES) {
    return finalize()
  }
  const coreXml = coreXmlBytes ? strFromU8(coreXmlBytes) : ''
  const coreMetadata = extractCoreMetadata(coreXml)
  if (Object.keys(coreMetadata).length > 0) {
    nodes[0] = { ...fileNode, ...coreMetadata }
  }

  const title = typeof coreMetadata.title === 'string' ? coreMetadata.title : ''
  if (title) {
    const titleId = helpers.sectionNodeId(filePath, title, 1)
    helpers.addNode(nodes, seenIds, helpers.createNode(titleId, title, filePath, 1, 'document'))
    helpers.addEdge(edges, helpers.createEdge(fileNode.id, titleId, 'contains', filePath, 1))
  }

  const documentXmlBytes = archive['word/document.xml']
  if (!documentXmlBytes || documentXmlBytes.byteLength > DOCX_MAX_ENTRY_ORIGINAL_BYTES) {
    return finalize()
  }

  const documentXml = strFromU8(documentXmlBytes)
  const headingStack: Array<{ level: number; id: string; label: string }> = []
  const referenceNodeIdsByIndex = new Map<number, string>()
  const pendingReferenceCitations: PendingReferenceCitation[] = []
  let syntheticLine = title ? 2 : 1
  let paragraphCount = 0

  for (const paragraph of documentXml.matchAll(DOCX_PARAGRAPH_PATTERN)) {
    paragraphCount += 1
    if (paragraphCount > DOCX_MAX_PARAGRAPHS) {
      break
    }

    const paragraphXml = paragraph[0]
    if (!paragraphXml || paragraphXml.length > DOCX_MAX_PARAGRAPH_TEXT_CHARS * 2) {
      continue
    }

    const text = extractDocxParagraphText(paragraphXml)
    if (!text) {
      continue
    }

    const style = paragraphXml.match(DOCX_PARAGRAPH_STYLE_PATTERN)?.[1] ?? ''
    const headingLevelMatch = style.match(/Heading([1-6])/i)
    const headingLevel = headingLevelMatch?.[1] ? Number.parseInt(headingLevelMatch[1], 10) : style.toLowerCase() === 'title' ? 1 : null

    if (headingLevel) {
      const nodeId = helpers.sectionNodeId(filePath, text, syntheticLine)
      helpers.addNode(nodes, seenIds, helpers.createNode(nodeId, text, filePath, syntheticLine, 'document'))

      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= headingLevel) {
        headingStack.pop()
      }

      const parentId = headingStack[headingStack.length - 1]?.id ?? fileNode.id
      helpers.addEdge(edges, helpers.createEdge(parentId, nodeId, 'contains', filePath, syntheticLine))
      headingStack.push({ level: headingLevel, id: nodeId, label: helpers.normalizeLabel(text) })
      helpers.addLocalReferenceEdges(edges, text, filePath, nodeId, syntheticLine, allowedTargets, seenSemanticEdges)
      helpers.addMentionReferenceEdges(edges, text, filePath, nodeId, syntheticLine, allowedTargets, seenSemanticEdges)
    } else if (headingStack.length > 0) {
      const currentSectionId = headingStack[headingStack.length - 1]!.id
      const currentSectionLabel = headingStack[headingStack.length - 1]!.label
      const referenceEntry = REFERENCE_SECTION_LABELS.has(currentSectionLabel) ? helpers.parseNumberedReferenceEntry(text) : null
      const referenceNodeId = referenceEntry
        ? helpers.addReferenceNodeFromText(nodes, edges, seenIds, seenSemanticEdges, text, filePath, syntheticLine, currentSectionId)
        : null
      if (referenceEntry && referenceNodeId) {
        referenceNodeIdsByIndex.set(referenceEntry.referenceIndex, referenceNodeId)
      }

      helpers.addLocalReferenceEdges(edges, text, filePath, currentSectionId, syntheticLine, allowedTargets, seenSemanticEdges)
      helpers.addMentionReferenceEdges(edges, text, filePath, currentSectionId, syntheticLine, allowedTargets, seenSemanticEdges)
      helpers.addCitationEdgesFromText(nodes, edges, seenIds, seenSemanticEdges, text, referenceNodeId ?? currentSectionId, filePath, syntheticLine)
      helpers.addInlineReferenceCitationEdgesFromText(
        edges,
        seenSemanticEdges,
        text,
        currentSectionId,
        filePath,
        syntheticLine,
        referenceNodeIdsByIndex,
        pendingReferenceCitations,
      )
    } else {
      helpers.addLocalReferenceEdges(edges, text, filePath, fileNode.id, syntheticLine, allowedTargets, seenSemanticEdges)
      helpers.addMentionReferenceEdges(edges, text, filePath, fileNode.id, syntheticLine, allowedTargets, seenSemanticEdges)
      helpers.addCitationEdgesFromText(nodes, edges, seenIds, seenSemanticEdges, text, fileNode.id, filePath, syntheticLine)
      helpers.addInlineReferenceCitationEdgesFromText(
        edges,
        seenSemanticEdges,
        text,
        fileNode.id,
        filePath,
        syntheticLine,
        referenceNodeIdsByIndex,
        pendingReferenceCitations,
      )
    }

    syntheticLine += 1
  }

  helpers.flushPendingReferenceCitations(edges, seenSemanticEdges, filePath, referenceNodeIdsByIndex, pendingReferenceCitations)
  return finalize()
}

function normalizeCompareBaselineTextLine(line: string): string {
  return line.replace(BASELINE_TEXT_CONTROL_CHAR_RE, '')
}

function decodeCompareBaselineXmlText(text: string): string {
  return normalizeCompareBaselineTextLine(
    text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

function extractCompareBaselineCoreMetadata(coreXml: string): Record<string, unknown> {
  const title = decodeCompareBaselineXmlText(coreXml.match(OOXML_TITLE_PATTERN)?.[1] ?? '')
  const author = decodeCompareBaselineXmlText(coreXml.match(OOXML_CREATOR_PATTERN)?.[1] ?? '')
  const subject = decodeCompareBaselineXmlText(coreXml.match(OOXML_SUBJECT_PATTERN)?.[1] ?? '')
  const description = decodeCompareBaselineXmlText(coreXml.match(OOXML_DESCRIPTION_PATTERN)?.[1] ?? '')

  return {
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(subject ? { subject } : {}),
    ...(description ? { description } : {}),
  }
}

function extractCompareBaselineDocxParagraphText(paragraphXml: string): string {
  let combined = ''
  let runCount = 0

  for (const match of paragraphXml.matchAll(DOCX_TEXT_PATTERN)) {
    const fragment = match[1] ?? ''
    if (!fragment) {
      continue
    }

    combined += fragment
    runCount += 1
    if (runCount >= DOCX_MAX_TEXT_RUNS_PER_PARAGRAPH || combined.length >= DOCX_MAX_PARAGRAPH_TEXT_CHARS) {
      break
    }
  }

  return decodeCompareBaselineXmlText(combined.slice(0, DOCX_MAX_PARAGRAPH_TEXT_CHARS))
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

export function extractCompareBaselineDocxText(filePath: string): string {
  let archive: Record<string, Uint8Array>
  try {
    const buffer = readFileSync(filePath)
    if (buffer.byteLength > MAX_TEXT_BYTES) {
      throw new Error(`Compare baseline could not extract text from graph-backed file: ${filePath}`)
    }
    const selectedOriginalBytes = { value: 0 }
    archive = unzipSync(new Uint8Array(buffer), {
      filter: (file) =>
        isAllowedOfficeEntry(
          file,
          selectedOriginalBytes,
          new Set(['word/document.xml', 'docProps/core.xml']),
          DOCX_MAX_COMPRESSED_ENTRY_BYTES,
          DOCX_MAX_ENTRY_ORIGINAL_BYTES,
          DOCX_MAX_TOTAL_ORIGINAL_BYTES,
        ),
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('Compare baseline could not extract text')) {
      throw error
    }
    throw new Error(`Compare baseline failed to extract text from graph-backed file: ${filePath}`)
  }

  const lines: string[] = []
  const coreXmlBytes = archive['docProps/core.xml']
  if (coreXmlBytes && coreXmlBytes.byteLength <= DOCX_MAX_ENTRY_ORIGINAL_BYTES) {
    const coreMetadata = extractCompareBaselineCoreMetadata(strFromU8(coreXmlBytes))
    for (const value of [coreMetadata.title, coreMetadata.author, coreMetadata.subject, coreMetadata.description]) {
      if (typeof value === 'string') {
        lines.push(value)
      }
    }
  }

  const documentXmlBytes = archive['word/document.xml']
  if (!documentXmlBytes || documentXmlBytes.byteLength > DOCX_MAX_ENTRY_ORIGINAL_BYTES) {
    throw new Error(`Compare baseline failed to extract text from graph-backed file: ${filePath}`)
  }

  let paragraphCount = 0
  for (const paragraph of strFromU8(documentXmlBytes).matchAll(DOCX_PARAGRAPH_PATTERN)) {
    paragraphCount += 1
    if (paragraphCount > DOCX_MAX_PARAGRAPHS) {
      break
    }

    const paragraphXml = paragraph[0]
    if (!paragraphXml || paragraphXml.length > DOCX_MAX_PARAGRAPH_TEXT_CHARS * 2) {
      continue
    }

    const text = extractCompareBaselineDocxParagraphText(paragraphXml)
    if (text) {
      lines.push(text)
    }
  }

  return uniqueNonEmptyLines(lines)
}

function extractCompareBaselineXlsxSharedStringTexts(sharedStringsXml: string): string[] {
  const texts: string[] = []
  let count = 0

  for (const item of sharedStringsXml.matchAll(XLSX_SHARED_STRING_ITEM_PATTERN)) {
    const text = decodeCompareBaselineXmlText([...(item[0] ?? '').matchAll(XLSX_TEXT_PATTERN)].map((match) => match[1] ?? '').join(' '))
    if (!text) {
      continue
    }

    texts.push(text)
    count += 1
    if (count >= 128) {
      break
    }
  }

  return texts
}

function extractXlsxSharedStringTexts(sharedStringsXml: string): string[] {
  const texts: string[] = []
  let count = 0

  for (const item of sharedStringsXml.matchAll(XLSX_SHARED_STRING_ITEM_PATTERN)) {
    const text = decodeXmlText([...(item[0] ?? '').matchAll(XLSX_TEXT_PATTERN)].map((match) => match[1] ?? '').join(' '))
    if (!text) {
      continue
    }

    texts.push(text)
    count += 1
    if (count >= 128) {
      break
    }
  }

  return texts
}

export function extractXlsxDocument(
  filePath: string,
  allowedTargets: ReadonlySet<string>,
  helpers: DocumentExtractionHelpers,
): ExtractionFragment {
  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenIds = new Set<string>()
  const seenSemanticEdges = new Set<string>()
  const fileNode = helpers.createBinaryMetadataAwareFileNode(filePath, 'document')

  helpers.addNode(nodes, seenIds, fileNode)

  const finalize = (): ExtractionFragment => helpers.finalizeNonCodeFragment({ nodes, edges })

  let archive: Record<string, Uint8Array>
  try {
    const buffer = readFileSync(filePath)
    if (buffer.byteLength > MAX_TEXT_BYTES) {
      return finalize()
    }

    const selectedOriginalBytes = { value: 0 }
    archive = unzipSync(new Uint8Array(buffer), {
      filter: (file) =>
        isAllowedOfficeEntry(
          file,
          selectedOriginalBytes,
          new Set(['xl/workbook.xml', 'xl/sharedStrings.xml', 'docProps/core.xml']),
          DOCX_MAX_COMPRESSED_ENTRY_BYTES,
          DOCX_MAX_ENTRY_ORIGINAL_BYTES,
          DOCX_MAX_TOTAL_ORIGINAL_BYTES,
        ),
    })
  } catch {
    return finalize()
  }

  const coreXml = archive['docProps/core.xml'] ? strFromU8(archive['docProps/core.xml']!) : ''
  const coreMetadata = extractCoreMetadata(coreXml)
  if (Object.keys(coreMetadata).length > 0) {
    nodes[0] = { ...fileNode, ...coreMetadata }
  }

  const workbookXmlBytes = archive['xl/workbook.xml']
  if (!workbookXmlBytes || workbookXmlBytes.byteLength > DOCX_MAX_ENTRY_ORIGINAL_BYTES) {
    return finalize()
  }

  const workbookXml = strFromU8(workbookXmlBytes)
  let syntheticLine = 1
  for (const match of workbookXml.matchAll(XLSX_SHEET_PATTERN)) {
    const sheetName = decodeXmlText(match[1] ?? '')
    if (!sheetName) {
      continue
    }

    const nodeId = helpers.sectionNodeId(filePath, sheetName, syntheticLine)
    helpers.addNode(nodes, seenIds, helpers.createNode(nodeId, sheetName, filePath, syntheticLine, 'document'))
    helpers.addEdge(edges, helpers.createEdge(fileNode.id, nodeId, 'contains', filePath, syntheticLine))
    helpers.addLocalReferenceEdges(edges, sheetName, filePath, nodeId, syntheticLine, allowedTargets, seenSemanticEdges)
    helpers.addMentionReferenceEdges(edges, sheetName, filePath, nodeId, syntheticLine, allowedTargets, seenSemanticEdges)
    syntheticLine += 1
  }

  const sharedStringsXml = archive['xl/sharedStrings.xml'] ? strFromU8(archive['xl/sharedStrings.xml']!) : ''
  const referenceNodeIdsByIndex = new Map<number, string>()
  const pendingReferenceCitations: PendingReferenceCitation[] = []
  for (const text of extractXlsxSharedStringTexts(sharedStringsXml)) {
    helpers.addLocalReferenceEdges(edges, text, filePath, fileNode.id, syntheticLine, allowedTargets, seenSemanticEdges)
    helpers.addMentionReferenceEdges(edges, text, filePath, fileNode.id, syntheticLine, allowedTargets, seenSemanticEdges)
    helpers.addCitationEdgesFromText(nodes, edges, seenIds, seenSemanticEdges, text, fileNode.id, filePath, syntheticLine)
    helpers.addInlineReferenceCitationEdgesFromText(
      edges,
      seenSemanticEdges,
      text,
      fileNode.id,
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

export function extractCompareBaselineXlsxText(filePath: string): string {
  let archive: Record<string, Uint8Array>
  try {
    const buffer = readFileSync(filePath)
    if (buffer.byteLength > MAX_TEXT_BYTES) {
      throw new Error(`Compare baseline could not extract text from graph-backed file: ${filePath}`)
    }

    const selectedOriginalBytes = { value: 0 }
    archive = unzipSync(new Uint8Array(buffer), {
      filter: (file) =>
        isAllowedOfficeEntry(
          file,
          selectedOriginalBytes,
          new Set(['xl/workbook.xml', 'xl/sharedStrings.xml', 'docProps/core.xml']),
          DOCX_MAX_COMPRESSED_ENTRY_BYTES,
          DOCX_MAX_ENTRY_ORIGINAL_BYTES,
          DOCX_MAX_TOTAL_ORIGINAL_BYTES,
        ),
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('Compare baseline could not extract text')) {
      throw error
    }
    throw new Error(`Compare baseline failed to extract text from graph-backed file: ${filePath}`)
  }

  const lines: string[] = []
  const coreXml = archive['docProps/core.xml'] ? strFromU8(archive['docProps/core.xml']!) : ''
  const coreMetadata = extractCompareBaselineCoreMetadata(coreXml)
  for (const value of [coreMetadata.title, coreMetadata.author, coreMetadata.subject, coreMetadata.description]) {
    if (typeof value === 'string') {
      lines.push(value)
    }
  }

  const workbookXmlBytes = archive['xl/workbook.xml']
  if (workbookXmlBytes && workbookXmlBytes.byteLength <= DOCX_MAX_ENTRY_ORIGINAL_BYTES) {
    const workbookXml = strFromU8(workbookXmlBytes)
    for (const match of workbookXml.matchAll(XLSX_SHEET_PATTERN)) {
      const sheetName = decodeCompareBaselineXmlText(match[1] ?? '')
      if (sheetName) {
        lines.push(sheetName)
      }
    }
  }

  const sharedStringsXml = archive['xl/sharedStrings.xml'] ? strFromU8(archive['xl/sharedStrings.xml']!) : ''
  return uniqueNonEmptyLines([...lines, ...extractCompareBaselineXlsxSharedStringTexts(sharedStringsXml)])
}
