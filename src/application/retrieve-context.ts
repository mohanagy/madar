import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'

import { canonicalJsonString } from '../domain/graph/canonical-json.js'
import type { GraphAttributes } from '../domain/graph/directed-multigraph.js'
import { type QueryIndex, type ReadyQueryIndex } from '../domain/query/index-status.js'
import type { IndexRange } from '../domain/index/model.js'
import { rankQueryAnchors } from '../domain/query/rank.js'
import { sliceEvidence } from '../domain/query/slice.js'
import { traverseEvidencePaths } from '../domain/query/traverse.js'
import {
  normalizeRetrieveRequest, type EvidenceBoundary, type EvidenceNode,
  type EvidenceRelationship, type NormalizedRetrieveRequest, type QueryPathEdge,
  type RetrieveContextResult, type RetrieveOutcome,
} from '../domain/query/types.js'

type AuthenticatedSource = { state: 'ready'; text: string }
  | { state: 'stale' | 'unavailable'; subject: string }
type AuthenticatedNode = { state: 'ready'; node: EvidenceNode }
  | { state: 'corrupt' | 'stale' | 'unavailable'; subject: string }

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function isPositiveLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function stringFact(attributes: GraphAttributes, key: string): string | null {
  const value = attributes[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function sourceIsBeneathRoot(root: string, source: string): boolean {
  const path = relative(root, source)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function readAuthenticatedSource(
  index: ReadyQueryIndex, sourceFile: string, cache: Map<string, AuthenticatedSource>,
): AuthenticatedSource {
  const cached = cache.get(sourceFile)
  if (cached) return cached
  const remember = (result: AuthenticatedSource): AuthenticatedSource => {
    cache.set(sourceFile, result)
    return result
  }

  const expectedHash = index.file_hashes.get(sourceFile)
  if (!expectedHash) return remember({ state: 'stale', subject: sourceFile })

  try {
    const root = realpathSync(index.root_path)
    const candidate = realpathSync(resolve(root, sourceFile))
    if (isAbsolute(sourceFile) || !sourceIsBeneathRoot(root, candidate)) {
      return remember({ state: 'unavailable', subject: sourceFile })
    }
    const bytes = readFileSync(candidate)
    const text = utf8.decode(bytes)
    const hash = createHash('sha256').update(bytes).digest('hex')
    return remember(hash === expectedHash
      ? { state: 'ready', text }
      : { state: 'stale', subject: sourceFile })
  } catch {
    return remember({ state: 'unavailable', subject: sourceFile })
  }
}

function offsetOf(text: string, position: IndexRange['start']): number | null {
  if (!Number.isSafeInteger(position.line) || position.line < 1
    || !Number.isSafeInteger(position.column) || position.column < 1) return null
  const starts = [0], ends: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (![10, 13, 0x2028, 0x2029].includes(code)) continue
    ends.push(index)
    if (code === 13 && text.charCodeAt(index + 1) === 10) index += 1
    starts.push(index + 1)
  }
  ends.push(text.length)
  const start = starts[position.line - 1], end = ends[position.line - 1]
  if (start === undefined || end === undefined) return null
  const offset = start + position.column - 1
  return offset <= end ? offset : null
}

function validRange(value: unknown): value is IndexRange {
  if (!value || typeof value !== 'object') return false
  const range = value as IndexRange
  return offsetPosition(range.start) <= offsetPosition(range.end)
}

function offsetPosition(position: IndexRange['start'] | undefined): number {
  return position && Number.isSafeInteger(position.line) && position.line > 0
    && Number.isSafeInteger(position.column) && position.column > 0
    ? position.line * 0x1_0000_0000 + position.column
    : Number.NaN
}

function exactRange(text: string, range: IndexRange): string | null {
  const start = offsetOf(text, range.start), end = offsetOf(text, range.end)
  return start === null || end === null || end < start ? null : text.slice(start, end)
}

function authenticateNode(
  index: ReadyQueryIndex, nodeId: string, sourceCache: Map<string, AuthenticatedSource>,
): AuthenticatedNode {
  if (!index.graph.hasNode(nodeId)) return { state: 'corrupt', subject: nodeId }
  const attributes = index.graph.nodeAttributes(nodeId)
  const label = stringFact(attributes, 'label')
  const nodeKind = stringFact(attributes, 'node_kind')
  const sourceFile = stringFact(attributes, 'source_file')
  const sourceLocation = stringFact(attributes, 'source_location')
  const provenance = attributes.provenance
  const contentHash = sourceFile ? index.file_hashes.get(sourceFile) : undefined

  if (!label || !nodeKind || !sourceFile
    || !Array.isArray(provenance) || provenance.length === 0 || !contentHash) {
    return { state: 'corrupt', subject: nodeId }
  }

  const source = readAuthenticatedSource(index, sourceFile, sourceCache)
  if (source.state !== 'ready') return source
  const sourceDomain = stringFact(attributes, 'source_domain')
  const common = {
    node_id: nodeId, label, source_file: sourceFile, provenance,
    content_hash: contentHash,
    ...(sourceDomain ? { source_domain: sourceDomain } : {}),
  }
  if (nodeKind === 'file') {
    return { state: 'ready', node: { ...common, evidence_kind: 'structural_file', node_kind: 'file' } }
  }

  const startLine = attributes.line_number
  const endLine = attributes.end_line_number
  const definitionRange = attributes.definition_range
  const declarationRange = attributes.declaration_range
  if (!sourceLocation || !isPositiveLine(startLine) || !isPositiveLine(endLine)
    ) return { state: 'corrupt', subject: nodeId }
  if (!validRange(definitionRange) || !validRange(declarationRange)
    || offsetPosition(declarationRange.start) < offsetPosition(definitionRange.start)
    || offsetPosition(declarationRange.end) > offsetPosition(definitionRange.end)) {
    return { state: 'stale', subject: sourceFile }
  }
  const expectedLocation = definitionRange.end.line > definitionRange.start.line
    ? `L${definitionRange.start.line}-L${definitionRange.end.line}`
    : `L${definitionRange.start.line}`
  if (startLine !== definitionRange.start.line || endLine !== definitionRange.end.line
    || sourceLocation !== expectedLocation) return { state: 'stale', subject: sourceFile }
  const snippet = exactRange(source.text, declarationRange)
  if (snippet === null || exactRange(source.text, definitionRange) === null) {
    return { state: 'stale', subject: sourceFile }
  }

  return {
    state: 'ready',
    node: {
      ...common, evidence_kind: 'symbol_declaration', node_kind: nodeKind,
      source_location: sourceLocation, line_number: startLine, end_line_number: endLine,
      definition_range: definitionRange, declaration_range: declarationRange, snippet,
    },
  }
}

function relationshipFromEdge(edge: QueryPathEdge): EvidenceRelationship | null {
  const sourceFile = edge.attributes.source_file
  const sourceLocation = edge.attributes.source_location
  const provenance = edge.attributes.provenance
  if (!Array.isArray(provenance) || provenance.length === 0) return null
  return {
    id: edge.id,
    from_id: edge.from,
    to_id: edge.to,
    relation: edge.relation,
    ...(typeof sourceFile === 'string' && sourceFile.length > 0 ? { source_file: sourceFile } : {}),
    ...(typeof sourceLocation === 'string' && sourceLocation.length > 0 ? { source_location: sourceLocation } : {}),
    provenance,
  }
}

function outcomeFrom(nodes: readonly EvidenceNode[], boundaries: readonly EvidenceBoundary[]): RetrieveOutcome {
  if (nodes.length > 0) return 'evidence'
  for (const state of ['corrupt', 'unavailable', 'stale', 'unsupported', 'missing'] as const) {
    if (boundaries.some((boundary) => boundary.kind === state)) return state
  }
  return 'missing'
}

function boundary(kind: EvidenceBoundary['kind'], subject: string): EvidenceBoundary {
  return { kind, subject }
}

function emptyResult(
  request: NormalizedRetrieveRequest, outcome: RetrieveOutcome, boundaries: EvidenceBoundary[],
): RetrieveContextResult {
  return sliceEvidence({
    request, outcome,
    matchedNodes: [],
    relationships: [],
    boundaries, priorityNodeIds: [], closurePasses: 0,
  })
}

export function retrieveContext(index: QueryIndex, input: unknown): RetrieveContextResult {
  const request = normalizeRetrieveRequest(input)
  if (index.state !== 'ready') {
    return emptyResult(request, index.state, [boundary(index.state, index.subject)])
  }

  const ranking = rankQueryAnchors(index, request)
  if (ranking.anchors.length === 0) {
    const boundaries = ranking.boundaries.length > 0
      ? ranking.boundaries
      : [boundary('missing', request.question)]
    return emptyResult(request, outcomeFrom([], boundaries), boundaries)
  }

  const traversal = traverseEvidencePaths(index, ranking)
  const sourceCache = new Map<string, AuthenticatedSource>()
  let matchedNodes: EvidenceNode[] = []
  const boundaries = [...ranking.boundaries, ...traversal.boundaries]

  for (const nodeId of traversal.nodeIds) {
    const authenticated = authenticateNode(index, nodeId, sourceCache)
    if (authenticated.state === 'ready') {
      matchedNodes.push(authenticated.node)
    } else {
      boundaries.push(boundary(authenticated.state, authenticated.subject))
    }
  }

  const selectedNodeIds = new Set(matchedNodes.map((node) => node.node_id))
  const relationships: EvidenceRelationship[] = []
  for (const edge of traversal.edges) {
    if (!selectedNodeIds.has(edge.from) || !selectedNodeIds.has(edge.to)) continue
    const relationship = relationshipFromEdge(edge)
    if (relationship) relationships.push(relationship)
    else boundaries.push(boundary('corrupt', edge.id))
  }
  const related = new Set(relationships.flatMap((edge) => [edge.from_id, edge.to_id]))
  const orphanFiles = matchedNodes.filter((node) =>
    node.evidence_kind === 'structural_file' && !related.has(node.node_id))
  for (const node of orphanFiles) boundaries.push(boundary('unavailable', node.source_file))
  const orphanIds = new Set(orphanFiles.map((node) => node.node_id))
  matchedNodes = matchedNodes.filter((node) => !orphanIds.has(node.node_id))
  return sliceEvidence({
    request,
    outcome: outcomeFrom(matchedNodes, boundaries),
    matchedNodes,
    relationships,
    boundaries,
    // Direct query anchors are mandatory evidence. Closure intermediates remain
    // eligible, but must not evict an explicitly requested endpoint at a hard
    // file or token cap.
    priorityNodeIds: ranking.priorityAnchorIds
      ? [...ranking.priorityAnchorIds]
      : ranking.anchors.map((anchor) => anchor.id),
    closurePasses: traversal.closurePasses,
    structuralRequired: ranking.structuralRequired === true,
    structuralCoverageComplete:
      ranking.structuralCoverageComplete !== false,
  })
}

export function serializeRetrieveContextResult(result: RetrieveContextResult): string {
  return canonicalJsonString(result)
}
