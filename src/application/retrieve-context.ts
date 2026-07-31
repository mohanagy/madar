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

type AuthenticatedSource = {
  state: 'ready'
  text: string
  lineStarts: readonly number[]
  lineEnds: readonly number[]
  proofHashes: Map<string, string>
}
  | { state: 'stale' | 'unavailable'; subject: string }
type AuthenticatedNode = { state: 'ready'; node: EvidenceNode }
  | { state: 'corrupt' | 'stale' | 'unavailable'; subject: string }
type ChannelProof = readonly [edgeId: string, attributes: GraphAttributes]

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const proofCache = new WeakMap<
ReadyQueryIndex,
Map<string, ChannelProof[]>
>()

function validLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function stringFact(attrs: GraphAttributes, key: string): string | null {
  const value = attrs[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function insideRoot(root: string, source: string): boolean {
  const path = relative(root, source)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function readSource(
  index: ReadyQueryIndex, file: string, cache: Map<string, AuthenticatedSource>,
): AuthenticatedSource {
  const cached = cache.get(file)
  if (cached) return cached
  const remember = (result: AuthenticatedSource): AuthenticatedSource => {
    cache.set(file, result)
    return result
  }

  const expected = index.file_hashes.get(file)
  if (!expected) return remember({ state: 'stale', subject: file })

  try {
    const root = realpathSync(index.root_path)
    const candidate = realpathSync(resolve(root, file))
    if (isAbsolute(file) || !insideRoot(root, candidate)) {
      return remember({ state: 'unavailable', subject: file })
    }
    const bytes = readFileSync(candidate)
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected) {
      return remember({ state: 'stale', subject: file })
    }
    const text = utf8.decode(bytes)
    const lines = lineOffsets(text)
    return remember({
      state: 'ready', text, lineStarts: lines.starts, lineEnds: lines.ends,
      proofHashes: new Map(),
    })
  } catch {
    return remember({ state: 'unavailable', subject: file })
  }
}

function lineOffsets(text: string): {
  starts: readonly number[]
  ends: readonly number[]
} {
  const starts = [0], ends: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (![10, 13, 0x2028, 0x2029].includes(code)) continue
    ends.push(index)
    if (code === 13 && text.charCodeAt(index + 1) === 10) index += 1
    starts.push(index + 1)
  }
  ends.push(text.length)
  return { starts, ends }
}

function offset(
  source: Extract<AuthenticatedSource, { state: 'ready' }>,
  pos: IndexRange['start'],
): number | null {
  if (!Number.isSafeInteger(pos.line) || pos.line < 1
    || !Number.isSafeInteger(pos.column) || pos.column < 1) return null
  const start = source.lineStarts[pos.line - 1]
  const end = source.lineEnds[pos.line - 1]
  if (start === undefined || end === undefined) return null
  const offset = start + pos.column - 1
  return offset <= end ? offset : null
}

function validRange(value: unknown): value is IndexRange {
  if (!value || typeof value !== 'object') return false
  const range = value as IndexRange
  return positionKey(range.start) <= positionKey(range.end)
}

function positionKey(pos: IndexRange['start'] | undefined): number {
  return pos && Number.isSafeInteger(pos.line) && pos.line > 0
    && Number.isSafeInteger(pos.column) && pos.column > 0
    ? pos.line * 0x1_0000_0000 + pos.column
    : Number.NaN
}

function excerpt(
  source: Extract<AuthenticatedSource, { state: 'ready' }>,
  range: IndexRange,
): string | null {
  const start = offset(source, range.start)
  const end = offset(source, range.end)
  return start === null || end === null || end < start
    ? null
    : source.text.slice(start, end)
}

function checkFactProofs(
  index: ReadyQueryIndex,
  ownerId: string,
  source: Extract<AuthenticatedSource, { state: 'ready' }>,
): boolean {
  for (const fact of index.operations_by_owner.get(ownerId) ?? []) {
    if (!proofMatches(
      source,
      fact.evidence.statement_range,
      fact.evidence.excerpt_sha256,
    )) return false
  }
  return true
}

function proofMatches(
  source: Extract<AuthenticatedSource, { state: 'ready' }>,
  range: IndexRange,
  expected: string,
): boolean {
  const key = `${range.start.line}:${range.start.column}:${
    range.end.line}:${range.end.column}`
  let actual = source.proofHashes.get(key)
  if (!actual) {
    const proofText = excerpt(source, range)
    if (proofText === null) return false
    actual = createHash('sha256').update(proofText, 'utf8').digest('hex')
    source.proofHashes.set(key, actual)
  }
  return actual === expected
}

function channelProofs(index: ReadyQueryIndex, ownerId: string): readonly ChannelProof[] {
  let byOwner = proofCache.get(index)
  if (!byOwner) {
    byOwner = new Map()
    for (const [, , attrs, edgeId] of index.graph.edgeEntries()) {
      const owner = attrs.execution_owner_id
      if (typeof owner !== 'string'
        || !['publishes_to', 'routes_through', 'consumed_by']
          .includes(String(attrs.relation))) continue
      const proofs = byOwner.get(owner) ?? []
      proofs.push([edgeId, attrs])
      byOwner.set(owner, proofs)
    }
    proofCache.set(index, byOwner)
  }
  return byOwner.get(ownerId) ?? []
}

function checkChannelProofs(
  index: ReadyQueryIndex,
  ownerId: string,
  sources: Map<string, AuthenticatedSource>,
): { state: 'ready' } | { state: 'corrupt' | 'stale' | 'unavailable'; subject: string } {
  for (const [edgeId, attrs] of channelProofs(index, ownerId)) {
    const file = attrs.source_file
    const evidence = attrs.evidence as Record<string, unknown> | undefined
    const range = evidence?.statement_range
    const expected = evidence?.excerpt_sha256
    if (typeof file !== 'string' || !validRange(range)
      || typeof expected !== 'string') {
      return { state: 'corrupt', subject: edgeId }
    }
    const source = readSource(index, file, sources)
    if (source.state !== 'ready') return source
    if (!proofMatches(source, range, expected)) {
      return { state: 'corrupt', subject: edgeId }
    }
  }
  return { state: 'ready' }
}

function authenticateNode(
  index: ReadyQueryIndex, nodeId: string, sources: Map<string, AuthenticatedSource>,
): AuthenticatedNode {
  if (!index.graph.hasNode(nodeId)) return { state: 'corrupt', subject: nodeId }
  const attrs = index.graph.nodeAttributes(nodeId)
  const label = stringFact(attrs, 'label')
  const nodeKind = stringFact(attrs, 'node_kind')
  const file = stringFact(attrs, 'source_file')
  const location = stringFact(attrs, 'source_location')
  const provenance = attrs.provenance
  const contentHash = file ? index.file_hashes.get(file) : undefined

  if (!label || !nodeKind || !file
    || !Array.isArray(provenance) || provenance.length === 0 || !contentHash) {
    return { state: 'corrupt', subject: nodeId }
  }

  const source = readSource(index, file, sources)
  if (source.state !== 'ready') return source
  if (!checkFactProofs(index, nodeId, source)) {
    return { state: 'corrupt', subject: nodeId }
  }
  const channelProof = checkChannelProofs(
    index,
    nodeId,
    sources,
  )
  if (channelProof.state !== 'ready') return channelProof
  const domain = stringFact(attrs, 'source_domain')
  const common = {
    node_id: nodeId, label, source_file: file, provenance,
    content_hash: contentHash,
    ...(domain ? { source_domain: domain } : {}),
  }
  if (nodeKind === 'file') {
    return { state: 'ready', node: { ...common, evidence_kind: 'structural_file', node_kind: 'file' } }
  }

  const startLine = attrs.line_number
  const endLine = attrs.end_line_number
  const definition = attrs.definition_range
  const declaration = attrs.declaration_range
  if (!location || !validLine(startLine) || !validLine(endLine)
    ) return { state: 'corrupt', subject: nodeId }
  if (!validRange(definition) || !validRange(declaration)
    || positionKey(declaration.start) < positionKey(definition.start)
    || positionKey(declaration.end) > positionKey(definition.end)) {
    return { state: 'stale', subject: file }
  }
  const expectedLocation = definition.end.line > definition.start.line
    ? `L${definition.start.line}-L${definition.end.line}`
    : `L${definition.start.line}`
  if (startLine !== definition.start.line || endLine !== definition.end.line
    || location !== expectedLocation) return { state: 'stale', subject: file }
  const snippet = excerpt(source, declaration)
  if (snippet === null || excerpt(source, definition) === null) {
    return { state: 'stale', subject: file }
  }

  return {
    state: 'ready',
    node: {
      ...common, evidence_kind: 'symbol_declaration', node_kind: nodeKind,
      source_location: location, line_number: startLine, end_line_number: endLine,
      definition_range: definition, declaration_range: declaration, snippet,
    },
  }
}

function edgeResult(edge: QueryPathEdge): EvidenceRelationship | null {
  const file = edge.attributes.source_file
  const location = edge.attributes.source_location
  const provenance = edge.attributes.provenance
  if (!Array.isArray(provenance) || provenance.length === 0) return null
  return {
    id: edge.id,
    from_id: edge.from,
    to_id: edge.to,
    relation: edge.relation,
    ...(typeof file === 'string' && file.length > 0 ? { source_file: file } : {}),
    ...(typeof location === 'string' && location.length > 0 ? { source_location: location } : {}),
    provenance,
  }
}

function outcome(nodes: readonly EvidenceNode[], boundaries: readonly EvidenceBoundary[]): RetrieveOutcome {
  if (nodes.length > 0) return 'evidence'
  for (const state of ['corrupt', 'unavailable', 'stale', 'unsupported', 'missing'] as const) {
    if (boundaries.some((limit) => limit.kind === state)) return state
  }
  return 'missing'
}

function limit(kind: EvidenceBoundary['kind'], subject: string): EvidenceBoundary {
  return { kind, subject }
}

function empty(
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
    return empty(request, index.state, [limit(index.state, index.subject)])
  }

  const ranking = rankQueryAnchors(index, request)
  if (ranking.anchors.length === 0) {
    const boundaries = ranking.boundaries.length > 0
      ? ranking.boundaries
      : [limit('missing', request.question)]
    return empty(request, outcome([], boundaries), boundaries)
  }

  const traversal = traverseEvidencePaths(index, ranking)
  const sources = new Map<string, AuthenticatedSource>()
  let matchedNodes: EvidenceNode[] = []
  const boundaries = [...ranking.boundaries, ...traversal.boundaries]

  for (const nodeId of traversal.nodeIds) {
    const checked = authenticateNode(index, nodeId, sources)
    if (checked.state === 'ready') {
      matchedNodes.push(checked.node)
    } else {
      boundaries.push(limit(checked.state, checked.subject))
    }
  }

  const selected = new Set(matchedNodes.map((node) => node.node_id))
  const relationships: EvidenceRelationship[] = []
  for (const edge of traversal.edges) {
    if (!selected.has(edge.from) || !selected.has(edge.to)) continue
    const relationship = edgeResult(edge)
    if (relationship) relationships.push(relationship)
    else boundaries.push(limit('corrupt', edge.id))
  }
  const related = new Set(relationships.flatMap((edge) => [edge.from_id, edge.to_id]))
  const orphans = matchedNodes.filter((node) =>
    node.evidence_kind === 'structural_file' && !related.has(node.node_id))
  for (const node of orphans) boundaries.push(limit('unavailable', node.source_file))
  const orphanIds = new Set(orphans.map((node) => node.node_id))
  matchedNodes = matchedNodes.filter((node) => !orphanIds.has(node.node_id))
  return sliceEvidence({
    request,
    outcome: outcome(matchedNodes, boundaries),
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
