import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base'

import { godNodes, semanticAnomalies, workspaceBridges, type SemanticAnomaly, type WorkspaceBridge } from '../pipeline/analyze.js'
import { buildCommunityLabels } from '../pipeline/community-naming.js'
import type { Communities } from '../pipeline/cluster.js'
import { loadGraphArtifact } from '../adapters/filesystem/graph-artifact.js'
import { isRecord } from '../shared/guards.js'
import { sanitizeLabel, validateGraphPath } from '../shared/security.js'
import type { KnowledgeGraph } from '../domain/graph/directed-multigraph.js'

const MAX_TRAVERSAL_DEPTH = 6
const MAX_STORED_SEMANTIC_ANOMALIES = 10_000
const MAX_STORED_ANOMALY_ID_LENGTH = 256
const MAX_STORED_ANOMALY_TEXT_LENGTH = 2_048

export type QueryRankBy = 'relevance' | 'degree'
export type QueryTraversalDirection = 'outgoing' | 'incident'

export interface QueryFilters {
  community?: number
  fileType?: string
}

export interface QueryGraphOptions {
  mode?: 'bfs' | 'dfs'
  depth?: number
  tokenBudget?: number
  rankBy?: QueryRankBy
  direction?: QueryTraversalDirection
  filters?: QueryFilters
}

export const QUERY_CHARS_PER_TOKEN = 3
export const QUERY_TOKEN_ESTIMATOR = {
  source: 'local_tokenizer',
  model: 'cl100k_base',
  exact: false,
} as const

export function estimateQueryTokens(text: string): number {
  return Math.max(1, countTokens(text))
}

function normalizeQueryFilters(filters?: QueryFilters): QueryFilters | undefined {
  if (!filters) {
    return undefined
  }

  const normalizedFileType = filters.fileType?.trim().toLowerCase()
  const normalizedFilters: QueryFilters = {
    ...(typeof filters.community === 'number' && Number.isInteger(filters.community) && filters.community >= 0 ? { community: filters.community } : {}),
    ...(normalizedFileType ? { fileType: normalizedFileType } : {}),
  }

  return normalizedFilters.community !== undefined || normalizedFilters.fileType !== undefined ? normalizedFilters : undefined
}

function matchesQueryFilters(attributes: Record<string, unknown>, filters?: QueryFilters): boolean {
  if (!filters) {
    return true
  }

  if (filters.community !== undefined) {
    const rawCommunity = attributes.community
    const community =
      typeof rawCommunity === 'number' && Number.isFinite(rawCommunity)
        ? rawCommunity
        : typeof rawCommunity === 'string' && rawCommunity.trim() !== '' && !Number.isNaN(Number(rawCommunity))
          ? Number(rawCommunity)
          : undefined

    if (community !== filters.community) {
      return false
    }
  }

  if (filters.fileType !== undefined) {
    const fileType = String(attributes.file_type ?? '')
      .trim()
      .toLowerCase()
    if (fileType !== filters.fileType) {
      return false
    }
  }

  return true
}

function allowedNodeIds(graph: KnowledgeGraph, filters?: QueryFilters): Set<string> | undefined {
  if (!filters) {
    return undefined
  }

  return new Set(
    graph
      .nodeEntries()
      .filter(([, attributes]) => matchesQueryFilters(attributes, filters))
      .map(([nodeId]) => nodeId),
  )
}

function describeQueryFilters(filters?: QueryFilters): string | null {
  if (!filters) {
    return null
  }

  const parts = [
    ...(filters.community !== undefined ? [`community=${filters.community}`] : []),
    ...(filters.fileType !== undefined ? [`file_type=${filters.fileType}`] : []),
  ]

  return parts.length > 0 ? parts.join(', ') : null
}

function readGraphArtifactRecord(graphPath: string): Record<string, unknown> {
  return loadGraphArtifact(graphPath).graph
}

function storedCommunityLabels(rawLabels: unknown): Record<number, string> {
  if (!rawLabels || typeof rawLabels !== 'object' || Array.isArray(rawLabels)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(rawLabels as Record<string, unknown>)
      .map(([communityIdRaw, labelRaw]) => [Number(communityIdRaw), typeof labelRaw === 'string' ? labelRaw.trim() : ''] as const)
      .filter(([communityId, label]) => Number.isInteger(communityId) && communityId >= 0 && label.length > 0),
  )
}

function storedSemanticAnomalies(rawAnomalies: unknown, topN: number): SemanticAnomaly[] {
  if (!Array.isArray(rawAnomalies) || rawAnomalies.length > MAX_STORED_SEMANTIC_ANOMALIES) {
    return []
  }

  const results: SemanticAnomaly[] = []

  for (const value of rawAnomalies) {
    if (!isRecord(value)) {
      continue
    }

    const kind = value.kind
    const severity = value.severity
    const score = typeof value.score === 'number' ? value.score : Number.NaN
    const summary = sanitizeLabel(typeof value.summary === 'string' ? value.summary.slice(0, MAX_STORED_ANOMALY_TEXT_LENGTH) : '').trim()
    const why = sanitizeLabel(typeof value.why === 'string' ? value.why.slice(0, MAX_STORED_ANOMALY_TEXT_LENGTH) : '').trim()
    const id = sanitizeLabel(typeof value.id === 'string' ? value.id.slice(0, MAX_STORED_ANOMALY_ID_LENGTH) : '').trim()

    if (
      (kind !== 'bridge_node' && kind !== 'cross_boundary_edge' && kind !== 'low_cohesion_community') ||
      (severity !== 'HIGH' && severity !== 'MEDIUM' && severity !== 'LOW') ||
      !Number.isFinite(score) ||
      id.length === 0 ||
      summary.length === 0 ||
      why.length === 0
    ) {
      continue
    }

    results.push({
      id,
      kind,
      severity,
      score,
      summary,
      why,
    } satisfies SemanticAnomaly)

    if (results.length >= topN) {
      break
    }
  }

  return results
}

export function communityLabelsFromGraph(graph: KnowledgeGraph, communities: Communities): Record<number, string> {
  return {
    ...buildCommunityLabels(graph, communities),
    ...storedCommunityLabels(graph.graph.community_labels),
  }
}

function bridgeSummaryLine(bridge: WorkspaceBridge): string {
  const connected = bridge.connected_communities.map((community) => community.label).join(', ')
  return `  - ${bridge.label}: connects ${connected}; home ${bridge.community_label}; degree ${bridge.degree}; score ${bridge.score}`
}

function workspaceBridgeMap(graph: KnowledgeGraph): Map<string, WorkspaceBridge> {
  const communities = communitiesFromGraph(graph)
  const communityLabels = communityLabelsFromGraph(graph, communities)
  return new Map(workspaceBridges(graph, communities, communityLabels).map((bridge) => [bridge.id, bridge]))
}

export function loadGraph(graphPath: string): KnowledgeGraph {
  return loadGraphArtifact(graphPath)
}

export function communitiesFromGraph(graph: KnowledgeGraph): Communities {
  const buckets = new Map<number, string[]>()

  for (const [nodeId, attributes] of graph.nodeEntries()) {
    const community = attributes.community
    if (typeof community === 'number' && Number.isFinite(community)) {
      const nodes = buckets.get(community) ?? []
      nodes.push(nodeId)
      buckets.set(community, nodes)
      continue
    }
    if (typeof community === 'string' && community.trim() !== '' && !Number.isNaN(Number(community))) {
      const communityId = Number(community)
      const nodes = buckets.get(communityId) ?? []
      nodes.push(nodeId)
      buckets.set(communityId, nodes)
    }
  }

  return Object.fromEntries([...buckets.entries()].map(([communityId, nodes]) => [communityId, [...nodes]]))
}

export function scoreNodes(graph: KnowledgeGraph, terms: string[], options: Pick<QueryGraphOptions, 'rankBy' | 'filters'> = {}): Array<[number, string]> {
  const normalizedTerms = terms.map((term) => term.toLowerCase()).filter((term) => term.length > 0)
  if (normalizedTerms.length === 0) {
    return []
  }

  const rankBy = options.rankBy === 'degree' ? 'degree' : 'relevance'
  const filters = normalizeQueryFilters(options.filters)

  return graph
    .nodeEntries()
    .map(([nodeId, attributes]) => {
      if (!matchesQueryFilters(attributes, filters)) {
        return null
      }

      const label = String(attributes.label ?? '').toLowerCase()
      const source = String(attributes.source_file ?? '').toLowerCase()
      const score = normalizedTerms.reduce((total, term) => total + (label.includes(term) ? 1 : 0) + (source.includes(term) ? 0.5 : 0), 0)
      return {
        degree: graph.degree(nodeId),
        nodeId,
        score,
      }
    })
    .filter((entry): entry is { degree: number; nodeId: string; score: number } => entry !== null && entry.score > 0)
    .sort((left, right) => {
      if (rankBy === 'degree') {
        return right.degree - left.degree || right.score - left.score || left.nodeId.localeCompare(right.nodeId)
      }
      return right.score - left.score || left.nodeId.localeCompare(right.nodeId)
    })
    .map((entry) => [entry.score, entry.nodeId] as [number, string])
}

interface TraversalStep {
  neighbor: string
  edge: [string, string]
}

function traversalSteps(
  graph: KnowledgeGraph,
  nodeId: string,
  direction: QueryTraversalDirection,
): TraversalStep[] {
  const outgoing = graph.successors(nodeId).map((neighbor) => ({
    neighbor,
    edge: [nodeId, neighbor] as [string, string],
  }))
  if (direction === 'outgoing') {
    return outgoing
  }

  return [
    ...outgoing,
    ...graph.predecessors(nodeId).map((neighbor) => ({
      neighbor,
      edge: [neighbor, nodeId] as [string, string],
    })),
  ]
}

export function bfs(
  graph: KnowledgeGraph,
  startNodes: string[],
  depth: number,
  allowedNodes?: ReadonlySet<string>,
  direction: QueryTraversalDirection = 'outgoing',
): { visited: Set<string>; edges: Array<[string, string]> } {
  if (depth < 0) {
    throw new Error('depth must be non-negative')
  }

  const seeds = startNodes.filter((nodeId) => graph.hasNode(nodeId) && (!allowedNodes || allowedNodes.has(nodeId)))
  const visited = new Set(seeds)
  let frontier = new Set(seeds)
  const edges: Array<[string, string]> = []

  for (let level = 0; level < depth; level += 1) {
    const nextFrontier = new Set<string>()
    for (const nodeId of frontier) {
      for (const { neighbor, edge } of traversalSteps(graph, nodeId, direction)) {
        if (allowedNodes && !allowedNodes.has(neighbor)) {
          continue
        }
        if (visited.has(neighbor)) {
          continue
        }
        nextFrontier.add(neighbor)
        edges.push(edge)
      }
    }
    for (const nodeId of nextFrontier) {
      visited.add(nodeId)
    }
    frontier = nextFrontier
  }

  return { visited, edges }
}

export function dfs(
  graph: KnowledgeGraph,
  startNodes: string[],
  depth: number,
  allowedNodes?: ReadonlySet<string>,
  direction: QueryTraversalDirection = 'outgoing',
): { visited: Set<string>; edges: Array<[string, string]> } {
  if (depth < 0) {
    throw new Error('depth must be non-negative')
  }

  const visited = new Set<string>()
  const edges: Array<[string, string]> = []
  const stack: Array<[string, number]> = [...startNodes]
    .filter((nodeId) => graph.hasNode(nodeId) && (!allowedNodes || allowedNodes.has(nodeId)))
    .reverse()
    .map((nodeId) => [nodeId, 0])

  while (stack.length > 0) {
    const entry = stack.pop()
    if (!entry) {
      continue
    }

    const [nodeId, currentDepth] = entry
    if (visited.has(nodeId) || currentDepth > depth) {
      continue
    }

    visited.add(nodeId)
    for (const { neighbor, edge } of traversalSteps(graph, nodeId, direction)) {
      if (allowedNodes && !allowedNodes.has(neighbor)) {
        continue
      }
      if (visited.has(neighbor)) {
        continue
      }
      stack.push([neighbor, currentDepth + 1])
      edges.push(edge)
    }
  }

  return { visited, edges }
}

export function subgraphToText(graph: KnowledgeGraph, nodes: Set<string>, edges: Array<[string, string]>, tokenBudget = 2000): string {
  if (tokenBudget <= 0) {
    throw new Error('tokenBudget must be positive')
  }

  const charBudget = tokenBudget * QUERY_CHARS_PER_TOKEN
  const lines: string[] = []
  const emittedEdgeIds = new Set<string>()

  const sortedNodes = [...nodes].filter((nodeId) => graph.hasNode(nodeId)).sort((left, right) => graph.degree(right) - graph.degree(left) || left.localeCompare(right))
  for (const nodeId of sortedNodes) {
    const attributes = graph.nodeAttributes(nodeId)
    lines.push(
      `NODE ${sanitizeLabel(String(attributes.label ?? nodeId))} [src=${String(attributes.source_file ?? '')} loc=${String(attributes.source_location ?? '')} community=${String(attributes.community ?? '')}]`,
    )
  }

  for (const [source, target] of edges) {
    if (!nodes.has(source) || !nodes.has(target)) {
      continue
    }
    if (!graph.hasNode(source) || !graph.hasNode(target)) {
      continue
    }

    for (const edge of graph.edgesBetween(source, target)) {
      if (emittedEdgeIds.has(edge.id)) {
        continue
      }
      emittedEdgeIds.add(edge.id)
      lines.push(
        `EDGE ${sanitizeLabel(String(graph.nodeAttributes(source).label ?? source))} --${String(edge.attributes.relation ?? '')} [${String(edge.attributes.confidence ?? '')}]--> ${sanitizeLabel(String(graph.nodeAttributes(target).label ?? target))}`,
      )
    }
  }

  const output = lines.join('\n')
  if (output.length > charBudget) {
    return `${output.slice(0, charBudget)}\n... (truncated to ~${tokenBudget} token budget)`
  }
  return output
}

function findNodeIds(graph: KnowledgeGraph, label: string): string[] {
  const term = label.toLowerCase()
  return graph
    .nodeEntries()
    .filter(([nodeId, attributes]) => {
      const nodeLabel = String(attributes.label ?? '').toLowerCase()
      return nodeLabel.includes(term) || nodeId.toLowerCase() === term
    })
    .map(([nodeId]) => nodeId)
}

export function queryGraph(graph: KnowledgeGraph, question: string, options: QueryGraphOptions = {}): string {
  const mode = options.mode ?? 'bfs'
  const depth = Math.min(Math.max(options.depth ?? 2, 0), MAX_TRAVERSAL_DEPTH)
  const tokenBudget = options.tokenBudget ?? 2000
  const rankBy = options.rankBy === 'degree' ? 'degree' : 'relevance'
  // A generic context query describes a neighborhood, not a directional flow.
  // Incident traversal preserves that historical behavior now that stored code graphs are directed.
  const direction = options.direction ?? 'incident'
  const filters = normalizeQueryFilters(options.filters)
  const terms = question
    .split(/\s+/)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 2)
  const startNodes = scoreNodes(graph, terms, { rankBy, ...(filters ? { filters } : {}) })
    .slice(0, 5)
    .map(([, nodeId]) => nodeId)

  if (startNodes.length === 0) {
    const filterDescription = describeQueryFilters(filters)
    return filterDescription ? `No matching nodes found for the current query and filters (${filterDescription}).` : 'No matching nodes found.'
  }

  const allowedNodes = allowedNodeIds(graph, filters)
  const traversal = mode === 'dfs'
    ? dfs(graph, startNodes, depth, allowedNodes, direction)
    : bfs(graph, startNodes, depth, allowedNodes, direction)
  const startLabels = startNodes.map((nodeId) => String(graph.nodeAttributes(nodeId).label ?? nodeId))
  const summary = [
    `Traversal: ${mode.toUpperCase()} depth=${depth}`,
    ...(rankBy !== 'relevance' ? [`Rank: ${rankBy.toUpperCase()}`] : []),
    ...(describeQueryFilters(filters) ? [`Filters: ${describeQueryFilters(filters)}`] : []),
    `Start: ${JSON.stringify(startLabels)}`,
    `${traversal.visited.size} nodes found`,
  ]
  const bridgesById = workspaceBridgeMap(graph)
  const bridgeContext = [...traversal.visited]
    .map((nodeId) => bridgesById.get(nodeId))
    .filter((bridge): bridge is WorkspaceBridge => bridge !== undefined)

  const sections = [summary.join(' | ')]
  if (bridgeContext.length > 0) {
    sections.push(['Workspace bridges:', ...bridgeContext.map(bridgeSummaryLine)].join('\n'))
  }
  sections.push(subgraphToText(graph, traversal.visited, traversal.edges, tokenBudget))
  return sections.join('\n\n')
}

export function getNode(graph: KnowledgeGraph, label: string): string {
  const match = findNodeIds(graph, label)[0]
  if (!match) {
    return `No node matching '${label.toLowerCase()}' found.`
  }

  const attributes = graph.nodeAttributes(match)
  const lines = [
    `Node: ${String(attributes.label ?? match)}`,
    `  ID: ${match}`,
    `  Source: ${String(attributes.source_file ?? '')} ${String(attributes.source_location ?? '')}`.trimEnd(),
    `  Type: ${String(attributes.file_type ?? '')}`,
    `  Community: ${String(attributes.community ?? '')}`,
    `  Degree: ${graph.degree(match)}`,
  ]

  const bridge = workspaceBridgeMap(graph).get(match)
  if (bridge) {
    lines.push(`  Workspace bridge: connects ${bridge.connected_communities.map((community) => community.label).join(', ')}; home ${bridge.community_label}`)
  }

  return lines.join('\n')
}

export function getNeighbors(graph: KnowledgeGraph, label: string, relationFilter = ''): string {
  const match = findNodeIds(graph, label)[0]
  if (!match) {
    return `No node matching '${label.toLowerCase()}' found.`
  }

  const normalizedFilter = relationFilter.toLowerCase()
  const lines = [`Neighbors of ${String(graph.nodeAttributes(match).label ?? match)}:`]
  for (const neighbor of graph.successors(match)) {
    for (const edge of graph.edgesBetween(match, neighbor)) {
      const relation = String(edge.attributes.relation ?? '')
      if (normalizedFilter && !relation.toLowerCase().includes(normalizedFilter)) {
        continue
      }
      lines.push(`  --> ${String(graph.nodeAttributes(neighbor).label ?? neighbor)} [${relation}] [${String(edge.attributes.confidence ?? '')}]`)
    }
  }
  return lines.join('\n')
}

export function getCommunity(graph: KnowledgeGraph, communities: Communities, communityId: number): string {
  const nodes = communities[communityId] ?? []
  if (nodes.length === 0) {
    return `Community ${communityId} not found.`
  }

  const lines = [`Community ${communityId} (${nodes.length} nodes):`]
  for (const nodeId of nodes) {
    const attributes = graph.nodeAttributes(nodeId)
    lines.push(`  ${String(attributes.label ?? nodeId)} [${String(attributes.source_file ?? '')}]`)
  }
  return lines.join('\n')
}

export function graphStats(graph: KnowledgeGraph, communities: Communities = communitiesFromGraph(graph)): string {
  const confidences = graph.edgeEntries().map(([, , attributes]) => String(attributes.confidence ?? 'EXTRACTED'))
  const total = confidences.length || 1
  return [
    `Nodes: ${graph.numberOfNodes()}`,
    `Edges: ${graph.numberOfEdges()}`,
    `Communities: ${Object.keys(communities).length}`,
    `EXTRACTED: ${Math.round((confidences.filter((confidence) => confidence === 'EXTRACTED').length / total) * 100)}%`,
    `INFERRED: ${Math.round((confidences.filter((confidence) => confidence === 'INFERRED').length / total) * 100)}%`,
    `AMBIGUOUS: ${Math.round((confidences.filter((confidence) => confidence === 'AMBIGUOUS').length / total) * 100)}%`,
  ].join('\n')
}

export function semanticAnomaliesSummary(graphPath: string, topN = 5): string {
  if (topN <= 0) {
    throw new Error('topN must be positive')
  }

  const safeGraphPath = validateGraphPath(graphPath)
  const artifactRecord = readGraphArtifactRecord(safeGraphPath)
  const stored = storedSemanticAnomalies(artifactRecord.semantic_anomalies, topN)
  const anomalies =
    stored.length > 0
      ? stored
      : (() => {
          const graph = loadGraph(safeGraphPath)
          const communities = communitiesFromGraph(graph)
          const communityLabels = {
            ...buildCommunityLabels(graph, communities),
            ...storedCommunityLabels(artifactRecord.community_labels),
          }
          return semanticAnomalies(graph, communities, communityLabels, topN)
        })()

  if (anomalies.length === 0) {
    return 'Semantic anomalies: none detected.'
  }

  return [
    `Semantic anomalies (${anomalies.length} shown):`,
    ...anomalies.map((anomaly, index) => `  ${index + 1}. [${anomaly.severity}] ${anomaly.summary}\n     ${anomaly.why}`),
  ].join('\n')
}

export function godNodesSummary(graph: KnowledgeGraph, topN = 10): string {
  if (topN <= 0) {
    throw new Error('topN must be positive')
  }

  const items = godNodes(graph, topN)
  if (items.length === 0) {
    return 'No non-file nodes found.'
  }

  return [`God nodes (${items.length} shown):`, ...items.map((item, index) => `  ${index + 1}. ${item.label} [${item.edges} edges]`)].join('\n')
}

function shortestPathNodeIds(graph: KnowledgeGraph, sourceNodeId: string, targetNodeId: string, maxDepth: number): string[] | null {
  if (sourceNodeId === targetNodeId) {
    return [sourceNodeId]
  }

  const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: sourceNodeId, depth: 0 }]
  const previous = new Map<string, string>()
  const visited = new Set<string>([sourceNodeId])

  while (queue.length > 0) {
    const entry = queue.shift()
    if (!entry) {
      continue
    }

    const { nodeId, depth } = entry
    if (depth >= maxDepth) {
      continue
    }

    for (const neighbor of graph.successors(nodeId)) {
      if (visited.has(neighbor)) {
        continue
      }
      visited.add(neighbor)
      previous.set(neighbor, nodeId)
      if (neighbor === targetNodeId) {
        const path = [targetNodeId]
        let cursor = targetNodeId
        while (previous.has(cursor)) {
          const prior = previous.get(cursor)
          if (!prior) {
            break
          }
          path.unshift(prior)
          cursor = prior
        }
        return path
      }
      queue.push({ nodeId: neighbor, depth: depth + 1 })
    }
  }

  return null
}

export function shortestPath(graph: KnowledgeGraph, source: string, target: string, maxHops = 8): string {
  if (maxHops <= 0) {
    throw new Error('maxHops must be positive')
  }

  const sourceMatch = scoreNodes(
    graph,
    source
      .split(/\s+/)
      .map((term) => term.toLowerCase())
      .filter((term) => term.length > 0),
  )[0]
  const targetMatch = scoreNodes(
    graph,
    target
      .split(/\s+/)
      .map((term) => term.toLowerCase())
      .filter((term) => term.length > 0),
  )[0]

  if (!sourceMatch) {
    return `No node matching source '${source}' found.`
  }
  if (!targetMatch) {
    return `No node matching target '${target}' found.`
  }

  const path = shortestPathNodeIds(graph, sourceMatch[1], targetMatch[1], maxHops)
  if (!path) {
    return `No path found within max_hops=${maxHops} between '${String(graph.nodeAttributes(sourceMatch[1]).label ?? sourceMatch[1])}' and '${String(graph.nodeAttributes(targetMatch[1]).label ?? targetMatch[1])}'.`
  }

  const hops = path.length - 1

  const firstNodeId = path[0]
  if (!firstNodeId) {
    return `No path found between '${String(graph.nodeAttributes(sourceMatch[1]).label ?? sourceMatch[1])}' and '${String(graph.nodeAttributes(targetMatch[1]).label ?? targetMatch[1])}'.`
  }

  const segments = [String(graph.nodeAttributes(firstNodeId).label ?? firstNodeId)]
  for (let index = 0; index < path.length - 1; index += 1) {
    const sourceNodeId = path[index]
    const targetNodeId = path[index + 1]
    if (!sourceNodeId || !targetNodeId) {
      continue
    }
    const edgeLabels = graph.edgesBetween(sourceNodeId, targetNodeId).map((edge) => {
      const confidence = String(edge.attributes.confidence ?? '')
      return `${String(edge.attributes.relation ?? '')}${confidence ? ` [${confidence}]` : ''}`
    })
    const relationText = edgeLabels.length === 1 ? edgeLabels[0] : `{${edgeLabels.join(' | ')}}`
    segments.push(`--${relationText}--> ${String(graph.nodeAttributes(targetNodeId).label ?? targetNodeId)}`)
  }

  return `Shortest path (${hops} hops):\n  ${segments.join(' ')}`
}
