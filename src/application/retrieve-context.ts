import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'

import { canonicalJsonString } from '../domain/graph/canonical-json.js'
import type { GraphAttributes } from '../domain/graph/directed-multigraph.js'
import { type QueryIndex, type ReadyQueryIndex } from '../domain/query/index-status.js'
import { rankQueryAnchors } from '../domain/query/rank.js'
import { classifySourceDomain, type SourceDomain } from '../domain/query/source-domain.js'
import { sliceEvidence } from '../domain/query/slice.js'
import { traverseEvidencePaths } from '../domain/query/traverse.js'
import {
  normalizeRetrieveRequest,
  type EvidenceBoundary,
  type EvidenceNode,
  type EvidenceRelationship,
  type NormalizedRetrieveRequest,
  type QueryPathEdge,
  type RetrieveContextResult,
  type RetrieveOutcome,
} from '../domain/query/types.js'

type AuthenticatedSource =
  | { state: 'ready'; text: string }
  | { state: 'stale' | 'unavailable'; subject: string }

type AuthenticatedNode =
  | { state: 'ready'; node: EvidenceNode }
  | { state: 'corrupt' | 'stale' | 'unavailable'; subject: string }

const utf8 = new TextDecoder('utf-8', { fatal: true })
const SOURCE_DOMAINS = new Set<SourceDomain>([
  'production', 'test', 'benchmark', 'fixture', 'generated', 'docs', 'config',
  'build_artifact', 'unknown',
])

function isPositiveLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function stringFact(attributes: GraphAttributes, key: string): string | null {
  const value = attributes[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function sourceDomainFact(attributes: GraphAttributes, sourceFile: string, root: string): SourceDomain {
  const value = attributes.source_domain
  return typeof value === 'string' && SOURCE_DOMAINS.has(value as SourceDomain)
    ? value as SourceDomain
    : classifySourceDomain(sourceFile, root)
}

function sourceIsBeneathRoot(root: string, source: string): boolean {
  const path = relative(root, source)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function readAuthenticatedSource(
  index: ReadyQueryIndex,
  sourceFile: string,
  cache: Map<string, AuthenticatedSource>,
): AuthenticatedSource {
  const cached = cache.get(sourceFile)
  if (cached) return cached

  const expectedHash = index.file_hashes.get(sourceFile)
  if (!expectedHash) {
    const result = { state: 'stale', subject: sourceFile } as const
    cache.set(sourceFile, result)
    return result
  }

  try {
    const root = realpathSync(index.root_path)
    const candidate = realpathSync(resolve(root, sourceFile))
    if (isAbsolute(sourceFile) || !sourceIsBeneathRoot(root, candidate)) {
      const result = { state: 'unavailable', subject: sourceFile } as const
      cache.set(sourceFile, result)
      return result
    }
    const bytes = readFileSync(candidate)
    const text = utf8.decode(bytes)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const result: AuthenticatedSource = hash === expectedHash
      ? { state: 'ready', text }
      : { state: 'stale', subject: sourceFile }
    cache.set(sourceFile, result)
    return result
  } catch {
    const result = { state: 'unavailable', subject: sourceFile } as const
    cache.set(sourceFile, result)
    return result
  }
}

interface SourceLine {
  start: number
  end: number
}

function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charCodeAt(index)
    if (character !== 10 && character !== 13 && character !== 0x2028 && character !== 0x2029) {
      continue
    }
    lines.push({ start, end: index })
    if (character === 13 && text.charCodeAt(index + 1) === 10) index += 1
    start = index + 1
  }
  lines.push({ start, end: text.length })
  return lines
}

function exactLineRange(text: string, startLine: number, endLine: number): string | null {
  const lines = sourceLines(text)
  const start = lines[startLine - 1]
  const end = lines[endLine - 1]
  if (!start || !end || endLine < startLine) return null
  return text.slice(start.start, end.end)
}

function authenticateNode(
  index: ReadyQueryIndex,
  nodeId: string,
  sourceCache: Map<string, AuthenticatedSource>,
): AuthenticatedNode {
  if (!index.graph.hasNode(nodeId)) return { state: 'corrupt', subject: nodeId }
  const attributes = index.graph.nodeAttributes(nodeId)
  const label = stringFact(attributes, 'label')
  const nodeKind = stringFact(attributes, 'node_kind')
  const sourceFile = stringFact(attributes, 'source_file')
  const sourceLocation = stringFact(attributes, 'source_location')
  const startLine = attributes.line_number
  const endLine = attributes.end_line_number
  const provenance = attributes.provenance
  const contentHash = sourceFile ? index.file_hashes.get(sourceFile) : undefined

  if (!label || !nodeKind || !sourceFile || !sourceLocation
    || !isPositiveLine(startLine) || !isPositiveLine(endLine)
    || !Array.isArray(provenance) || provenance.length === 0 || !contentHash) {
    return { state: 'corrupt', subject: nodeId }
  }

  const source = readAuthenticatedSource(index, sourceFile, sourceCache)
  if (source.state !== 'ready') return source
  const snippet = exactLineRange(source.text, startLine, endLine)
  if (snippet === null) return { state: 'stale', subject: sourceFile }

  return {
    state: 'ready',
    node: {
      node_id: nodeId,
      label,
      node_kind: nodeKind,
      source_file: sourceFile,
      source_location: sourceLocation,
      line_number: startLine,
      end_line_number: endLine,
      source_domain: sourceDomainFact(attributes, sourceFile, index.root_path),
      provenance,
      content_hash: contentHash,
      snippet,
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
  request: NormalizedRetrieveRequest,
  outcome: RetrieveOutcome,
  boundaries: EvidenceBoundary[],
): RetrieveContextResult {
  return sliceEvidence({
    request,
    outcome,
    matchedNodes: [],
    relationships: [],
    boundaries,
    priorityNodeIds: [],
    closurePasses: 0,
  })
}

export function normalizeRetrieveContextRequest(input: unknown): NormalizedRetrieveRequest {
  return normalizeRetrieveRequest(input)
}

export function retrieveContext(index: QueryIndex, input: unknown): RetrieveContextResult {
  const request = normalizeRetrieveContextRequest(input)
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
  const matchedNodes: EvidenceNode[] = []
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

  return sliceEvidence({
    request,
    outcome: outcomeFrom(matchedNodes, boundaries),
    matchedNodes,
    relationships,
    boundaries,
    priorityNodeIds: ranking.anchors.map((anchor) => anchor.id),
    closurePasses: traversal.closurePasses,
  })
}

export function serializeRetrieveContextResult(result: RetrieveContextResult): string {
  return canonicalJsonString(result)
}
