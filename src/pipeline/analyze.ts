import { canonicalJsonString } from '../domain/graph/canonical-json.js'
import { KnowledgeGraph, type GraphAttributes } from '../domain/graph/directed-multigraph.js'
import { AUDIO_EXTENSIONS, CODE_EXTENSIONS, DOC_EXTENSIONS, IMAGE_EXTENSIONS, PAPER_EXTENSIONS, VIDEO_EXTENSIONS } from './detect.js'
import { cluster, cohesionScore, type Communities } from './cluster.js'

export interface GodNode {
  id: string
  label: string
  edges: number
}

export interface SurprisingConnection {
  source: string
  target: string
  source_files: [string, string]
  confidence: string
  confidence_score?: number
  relation: string
  why: string
  note?: string
}

export interface SuggestedQuestion {
  type: string
  question: string | null
  why: string
}

export interface SemanticAnomaly {
  id: string
  kind: 'bridge_node' | 'cross_boundary_edge' | 'low_cohesion_community'
  severity: 'HIGH' | 'MEDIUM' | 'LOW'
  score: number
  summary: string
  why: string
}

export interface GraphDiffResult {
  new_nodes: Array<{ id: string; label: string }>
  removed_nodes: Array<{ id: string; label: string }>
  new_edges: Array<{ id: string; source: string; target: string; relation: string; confidence: string; attributes: GraphAttributes }>
  removed_edges: Array<{ id: string; source: string; target: string; relation: string; confidence: string; attributes: GraphAttributes }>
  summary: string
}

export interface GraphStructureMetrics {
  total_nodes: number
  total_edges: number
  weakly_connected_components: number
  singleton_components: number
  isolated_nodes: number
  largest_component_nodes: number
  largest_component_ratio: number
  low_cohesion_communities: number
  largest_low_cohesion_community_nodes: number
  largest_low_cohesion_community_score: number
}

export interface WorkspaceBridgeCommunity {
  id: number
  label: string
  node_count: number
}

export interface WorkspaceBridge {
  id: string
  label: string
  community_id: number | null
  community_label: string
  connected_communities: WorkspaceBridgeCommunity[]
  degree: number
  score: number
  source_files: string[]
}

const MAX_BETWEENNESS_ANALYSIS_NODES = 2_000
const MAX_SEMANTIC_ANOMALIES_PER_KIND = 3
const LOW_COHESION_THRESHOLD = 0.15
const LOW_COHESION_MIN_NODES = 5
const nodeBetweennessCache = new WeakMap<KnowledgeGraph, Map<string, number>>()

function edgePairKey(left: string, right: string): string {
  return [left, right].sort().join('\u0000')
}

function nodeLabel(graph: KnowledgeGraph, nodeId: string): string {
  return String(graph.nodeAttributes(nodeId).label ?? nodeId)
}

function nodeSourceFile(graph: KnowledgeGraph, nodeId: string): string {
  return String(graph.nodeAttributes(nodeId).source_file ?? '')
}

function nodeDegreeMap(graph: KnowledgeGraph): Map<string, number> {
  return new Map(graph.nodeIds().map((nodeId) => [nodeId, graph.degree(nodeId)]))
}

function edgeBetweenness(graph: KnowledgeGraph): Map<string, number> {
  const scores = new Map<string, number>()
  for (const [source, target] of graph.edgeEntries()) {
    scores.set(edgePairKey(source, target), 0)
  }

  for (const sourceNode of graph.nodeIds()) {
    const stack: string[] = []
    const predecessors = new Map<string, string[]>()
    const sigma = new Map<string, number>()
    const distance = new Map<string, number>()

    for (const nodeId of graph.nodeIds()) {
      predecessors.set(nodeId, [])
      sigma.set(nodeId, 0)
      distance.set(nodeId, -1)
    }

    sigma.set(sourceNode, 1)
    distance.set(sourceNode, 0)
    const queue: string[] = [sourceNode]

    while (queue.length > 0) {
      const vertex = queue.shift()
      if (!vertex) {
        continue
      }
      stack.push(vertex)

      for (const neighbor of graph.incidentNeighbors(vertex)) {
        if ((distance.get(neighbor) ?? -1) < 0) {
          queue.push(neighbor)
          distance.set(neighbor, (distance.get(vertex) ?? 0) + 1)
        }
        if ((distance.get(neighbor) ?? -1) === (distance.get(vertex) ?? 0) + 1) {
          sigma.set(neighbor, (sigma.get(neighbor) ?? 0) + (sigma.get(vertex) ?? 0))
          predecessors.get(neighbor)?.push(vertex)
        }
      }
    }

    const delta = new Map<string, number>(graph.nodeIds().map((nodeId) => [nodeId, 0]))
    while (stack.length > 0) {
      const vertex = stack.pop()
      if (!vertex) {
        continue
      }
      for (const predecessor of predecessors.get(vertex) ?? []) {
        const contribution = ((sigma.get(predecessor) ?? 0) / (sigma.get(vertex) ?? 1)) * (1 + (delta.get(vertex) ?? 0))
        const key = edgePairKey(predecessor, vertex)
        scores.set(key, (scores.get(key) ?? 0) + contribution)
        delta.set(predecessor, (delta.get(predecessor) ?? 0) + contribution)
      }
    }
  }

  for (const [key, value] of scores.entries()) {
    scores.set(key, value / 2)
  }

  return scores
}

function nodeBetweenness(graph: KnowledgeGraph): Map<string, number> {
  const cached = nodeBetweennessCache.get(graph)
  if (cached) {
    return cached
  }

  const nodeIds = graph.nodeIds()
  const scores = new Map(nodeIds.map((nodeId) => [nodeId, 0]))

  for (const sourceNodeId of nodeIds) {
    const stack: string[] = []
    const predecessors = new Map(nodeIds.map((nodeId) => [nodeId, [] as string[]]))
    const sigma = new Map(nodeIds.map((nodeId) => [nodeId, 0]))
    const distance = new Map(nodeIds.map((nodeId) => [nodeId, -1]))

    sigma.set(sourceNodeId, 1)
    distance.set(sourceNodeId, 0)
    const queue: string[] = [sourceNodeId]

    while (queue.length > 0) {
      const vertex = queue.shift()
      if (!vertex) {
        continue
      }
      stack.push(vertex)

      for (const neighbor of graph.incidentNeighbors(vertex)) {
        if ((distance.get(neighbor) ?? -1) < 0) {
          queue.push(neighbor)
          distance.set(neighbor, (distance.get(vertex) ?? 0) + 1)
        }

        if ((distance.get(neighbor) ?? -1) === (distance.get(vertex) ?? 0) + 1) {
          sigma.set(neighbor, (sigma.get(neighbor) ?? 0) + (sigma.get(vertex) ?? 0))
          predecessors.get(neighbor)?.push(vertex)
        }
      }
    }

    const delta = new Map(nodeIds.map((nodeId) => [nodeId, 0]))
    while (stack.length > 0) {
      const vertex = stack.pop()
      if (!vertex) {
        continue
      }

      for (const predecessor of predecessors.get(vertex) ?? []) {
        const contribution = ((sigma.get(predecessor) ?? 0) / (sigma.get(vertex) ?? 1)) * (1 + (delta.get(vertex) ?? 0))
        delta.set(predecessor, (delta.get(predecessor) ?? 0) + contribution)
      }

      if (vertex !== sourceNodeId) {
        scores.set(vertex, (scores.get(vertex) ?? 0) + (delta.get(vertex) ?? 0))
      }
    }
  }

  for (const [nodeId, value] of scores.entries()) {
    scores.set(nodeId, value / 2)
  }

  nodeBetweennessCache.set(graph, scores)
  return scores
}

export function _nodeCommunityMap(communities: Communities): Record<string, number> {
  const mapping: Record<string, number> = {}
  for (const [communityId, nodeIds] of Object.entries(communities)) {
    for (const nodeId of nodeIds) {
      mapping[nodeId] = Number(communityId)
    }
  }
  return mapping
}

export function _isFileNode(graph: KnowledgeGraph, nodeId: string): boolean {
  const attrs = graph.nodeAttributes(nodeId)
  const label = String(attrs.label ?? '')
  if (!label) {
    return false
  }

  const sourceFile = String(attrs.source_file ?? '')
  if (sourceFile) {
    const fileName = sourceFile.split('/').at(-1)
    if (label === fileName) {
      return true
    }
  }

  if (label.startsWith('.') && label.endsWith('()')) {
    return true
  }

  if (label.endsWith('()') && graph.degree(nodeId) <= 1) {
    return true
  }

  return false
}

export function _isConceptNode(graph: KnowledgeGraph, nodeId: string): boolean {
  const sourceFile = nodeSourceFile(graph, nodeId)
  if (!sourceFile) {
    return true
  }
  return !sourceFile.split('/').at(-1)?.includes('.')
}

export function _fileCategory(path: string): 'code' | 'paper' | 'image' | 'audio' | 'video' | 'doc' {
  const extension = path.includes('.') ? `.${path.split('.').at(-1)?.toLowerCase() ?? ''}` : ''
  if (CODE_EXTENSIONS.has(extension)) {
    return 'code'
  }
  if (PAPER_EXTENSIONS.has(extension)) {
    return 'paper'
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image'
  }
  if (AUDIO_EXTENSIONS.has(extension)) {
    return 'audio'
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return 'video'
  }
  if (DOC_EXTENSIONS.has(extension)) {
    return 'doc'
  }
  return 'doc'
}

function analysisNodeIds(graph: KnowledgeGraph): string[] {
  return graph.nodeIds().filter((nodeId) => isAnalysisEntityNode(graph, nodeId))
}

function analysisCommunityNodeIds(graph: KnowledgeGraph, nodeIds: string[]): string[] {
  return nodeIds.filter((nodeId) => isAnalysisEntityNode(graph, nodeId))
}

function analysisGraph(graph: KnowledgeGraph): KnowledgeGraph {
  const entityGraph = new KnowledgeGraph(typeof graph.graph.root_path === 'string' ? { root_path: graph.graph.root_path } : {})
  const nodeIds = analysisNodeIds(graph)
  const nodeIdSet = new Set(nodeIds)
  for (const nodeId of nodeIds) {
    entityGraph.addNode(nodeId, graph.nodeAttributes(nodeId))
  }
  for (const [sourceNodeId, targetNodeId, attributes] of graph.edgeEntries()) {
    if (!nodeIdSet.has(sourceNodeId) || !nodeIdSet.has(targetNodeId)) {
      continue
    }
    entityGraph.addEdge(sourceNodeId, targetNodeId, attributes)
  }
  return entityGraph
}

function lowCohesionCommunities(
  graph: KnowledgeGraph,
  communities: Communities,
): Array<{ communityId: number; nodeIds: string[]; cohesion: number }> {
  return Object.entries(communities)
    .map(([communityIdRaw, nodeIds]) => {
      const analysisNodes = analysisCommunityNodeIds(graph, nodeIds)
      return {
        communityId: Number(communityIdRaw),
        nodeIds: analysisNodes,
        cohesion: cohesionScore(graph, analysisNodes),
      }
    })
    .filter(({ nodeIds, cohesion }) => nodeIds.length >= LOW_COHESION_MIN_NODES && cohesion < LOW_COHESION_THRESHOLD)
    .sort(
      (left, right) =>
        right.nodeIds.length - left.nodeIds.length || left.cohesion - right.cohesion || left.communityId - right.communityId,
    )
}

function lowCohesionEntityCommunities(graph: KnowledgeGraph): Array<{ communityId: number; nodeIds: string[]; cohesion: number }> {
  const entityGraph = analysisGraph(graph)
  return lowCohesionCommunities(entityGraph, cluster(entityGraph))
}

function overlapCommunityLabel(
  nodeIds: string[],
  communities: Communities,
  communityLabels: Record<number, string>,
  fallbackCommunityId: number,
): string {
  const nodeIdSet = new Set(nodeIds)
  let bestCommunityId: number | null = null
  let bestOverlap = 0
  for (const [communityIdRaw, communityNodeIds] of Object.entries(communities)) {
    const overlap = communityNodeIds.filter((nodeId) => nodeIdSet.has(nodeId)).length
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      bestCommunityId = Number(communityIdRaw)
    }
  }
  if (bestCommunityId !== null) {
    return communityLabels[bestCommunityId] ?? `Community ${bestCommunityId}`
  }
  return communityLabels[fallbackCommunityId] ?? `Community ${fallbackCommunityId}`
}

function topLevelDir(path: string): string {
  return path.includes('/') ? (path.split('/')[0] ?? path) : path
}

function isExplicitFileNode(graph: KnowledgeGraph, nodeId: string): boolean {
  const attrs = graph.nodeAttributes(nodeId)
  const label = String(attrs.label ?? '')
  const sourceFile = String(attrs.source_file ?? '')
  if (!label || !sourceFile) {
    return false
  }

  return label === sourceFile.split('/').at(-1)
}

export function isAnalysisEntityNode(graph: KnowledgeGraph, nodeId: string): boolean {
  return !isExplicitFileNode(graph, nodeId) && !_isConceptNode(graph, nodeId)
}

export function analysisEntityDegree(graph: KnowledgeGraph, nodeId: string): number {
  return graph.incidentNeighbors(nodeId).filter((neighborId) => isAnalysisEntityNode(graph, neighborId)).length
}

export function _surpriseScore(
  graph: KnowledgeGraph,
  sourceNodeId: string,
  targetNodeId: string,
  edgeData: Record<string, unknown>,
  nodeCommunity: Record<string, number>,
  sourceFile: string,
  targetFile: string,
): [number, string[]] {
  let score = 0
  const reasons: string[] = []

  const confidence = String(edgeData.confidence ?? 'EXTRACTED')
  const confidenceBonus = confidence === 'AMBIGUOUS' ? 3 : confidence === 'INFERRED' ? 2 : 1
  score += confidenceBonus
  if (confidence === 'AMBIGUOUS' || confidence === 'INFERRED') {
    reasons.push(`${confidence.toLowerCase()} connection - not explicitly stated in source`)
  }

  const sourceCategory = _fileCategory(sourceFile)
  const targetCategory = _fileCategory(targetFile)
  if (sourceCategory !== targetCategory) {
    score += 2
    reasons.push(`crosses file types (${sourceCategory} ↔ ${targetCategory})`)
  }

  if (topLevelDir(sourceFile) !== topLevelDir(targetFile)) {
    score += 2
    reasons.push('connects across different repos/directories')
  }

  const sourceCommunity = nodeCommunity[sourceNodeId]
  const targetCommunity = nodeCommunity[targetNodeId]
  if (sourceCommunity !== undefined && targetCommunity !== undefined && sourceCommunity !== targetCommunity) {
    score += 1
    reasons.push('bridges separate communities')
  }

  if (String(edgeData.relation ?? '') === 'semantically_similar_to') {
    score = Math.trunc(score * 1.5)
    reasons.push('semantically similar concepts with no structural link')
  }

  const sourceDegree = graph.degree(sourceNodeId)
  const targetDegree = graph.degree(targetNodeId)
  if (Math.min(sourceDegree, targetDegree) <= 2 && Math.max(sourceDegree, targetDegree) >= 5) {
    score += 1
    const peripheralId = sourceDegree <= 2 ? sourceNodeId : targetNodeId
    const hubId = sourceDegree <= 2 ? targetNodeId : sourceNodeId
    reasons.push(`peripheral node \`${nodeLabel(graph, peripheralId)}\` unexpectedly reaches hub \`${nodeLabel(graph, hubId)}\``)
  }

  return [score, reasons]
}

export function godNodes(graph: KnowledgeGraph, topN = 10): GodNode[] {
  return [...graph.nodeIds()]
    .filter((nodeId) => isAnalysisEntityNode(graph, nodeId))
    .sort((left, right) => graph.degree(right) - graph.degree(left) || nodeLabel(graph, left).localeCompare(nodeLabel(graph, right)))
    .slice(0, topN)
    .map((nodeId) => ({
      id: nodeId,
      label: nodeLabel(graph, nodeId),
      edges: graph.degree(nodeId),
    }))
}

export function graphStructureMetrics(graph: KnowledgeGraph): GraphStructureMetrics {
  const nodeIds = analysisNodeIds(graph)
  const nodeIdSet = new Set(nodeIds)
  if (nodeIds.length === 0) {
    return {
      total_nodes: 0,
      total_edges: 0,
      weakly_connected_components: 0,
      singleton_components: 0,
      isolated_nodes: 0,
      largest_component_nodes: 0,
      largest_component_ratio: 0,
      low_cohesion_communities: 0,
      largest_low_cohesion_community_nodes: 0,
      largest_low_cohesion_community_score: 0,
    }
  }

  const visited = new Set<string>()
  const componentSizes: number[] = []

  for (const startNodeId of nodeIds) {
    if (visited.has(startNodeId)) {
      continue
    }

    let size = 0
    const queue = [startNodeId]
    let queueIndex = 0
    visited.add(startNodeId)

    while (queueIndex < queue.length) {
      const nodeId = queue[queueIndex]
      queueIndex += 1
      if (!nodeId) {
        continue
      }

      size += 1
      for (const neighborId of graph.incidentNeighbors(nodeId)) {
        if (!nodeIdSet.has(neighborId)) {
          continue
        }
        if (visited.has(neighborId)) {
          continue
        }
        visited.add(neighborId)
        queue.push(neighborId)
      }
    }

    componentSizes.push(size)
  }

  const largestComponentNodes = Math.max(...componentSizes)
  const entityEdges = graph
    .edgeEntries()
    .filter(([sourceNodeId, targetNodeId]) => nodeIdSet.has(sourceNodeId) && nodeIdSet.has(targetNodeId)).length
  const lowCohesionSignals = lowCohesionEntityCommunities(graph)
  const largestLowCohesionCommunity = lowCohesionSignals[0]
  return {
    total_nodes: nodeIds.length,
    total_edges: entityEdges,
    weakly_connected_components: componentSizes.length,
    singleton_components: componentSizes.filter((size) => size === 1).length,
    isolated_nodes: nodeIds.filter((nodeId) => analysisEntityDegree(graph, nodeId) === 0).length,
    largest_component_nodes: largestComponentNodes,
    largest_component_ratio: largestComponentNodes / nodeIds.length,
    low_cohesion_communities: lowCohesionSignals.length,
    largest_low_cohesion_community_nodes: largestLowCohesionCommunity?.nodeIds.length ?? 0,
    largest_low_cohesion_community_score: largestLowCohesionCommunity?.cohesion ?? 0,
  }
}

export function workspaceBridges(
  graph: KnowledgeGraph,
  communities: Communities,
  communityLabels: Record<number, string> = {},
  topN = 6,
): WorkspaceBridge[] {
  if (topN <= 0 || graph.numberOfEdges() === 0 || Object.keys(communities).length === 0) {
    return []
  }

  const nodeCommunity = _nodeCommunityMap(communities)
  const communitySizes = new Map(Object.entries(communities).map(([communityId, nodeIds]) => [Number(communityId), nodeIds.length]))
  const centrality =
    graph.numberOfNodes() <= MAX_BETWEENNESS_ANALYSIS_NODES ? nodeBetweenness(graph) : new Map<string, number>()

  return graph
    .nodeIds()
    .filter((nodeId) => isAnalysisEntityNode(graph, nodeId))
    .map((nodeId) => {
      const homeCommunity = nodeCommunity[nodeId]
      const neighborCommunityIds = new Set<number>()
      const sourceFiles = new Set<string>()
      const ownSourceFile = nodeSourceFile(graph, nodeId)
      if (ownSourceFile) {
        sourceFiles.add(ownSourceFile)
      }

      for (const neighborId of graph.incidentNeighbors(nodeId)) {
        if (!isAnalysisEntityNode(graph, neighborId)) {
          continue
        }
        const neighborCommunity = nodeCommunity[neighborId]
        if (neighborCommunity !== undefined && neighborCommunity !== homeCommunity) {
          neighborCommunityIds.add(neighborCommunity)
        }
        const neighborSourceFile = nodeSourceFile(graph, neighborId)
        if (neighborSourceFile) {
          sourceFiles.add(neighborSourceFile)
        }
      }

      const degree = analysisEntityDegree(graph, nodeId)
      if (neighborCommunityIds.size === 0) {
        return null
      }
      if (homeCommunity !== undefined && neighborCommunityIds.size === 1 && degree <= 1) {
        return null
      }

      const connectedCommunities = [...neighborCommunityIds]
        .map((communityId) => ({
          id: communityId,
          label: communityLabels[communityId] ?? `Community ${communityId}`,
          node_count: communitySizes.get(communityId) ?? 0,
        }))
        .sort((left, right) => left.label.localeCompare(right.label) || left.id - right.id)
      const betweenness = centrality.get(nodeId) ?? 0
      const score = Math.round((connectedCommunities.length * 10 + degree + betweenness) * 100) / 100

      return {
        id: nodeId,
        label: nodeLabel(graph, nodeId),
        community_id: homeCommunity ?? null,
        community_label: homeCommunity !== undefined ? (communityLabels[homeCommunity] ?? `Community ${homeCommunity}`) : 'Unassigned',
        connected_communities: connectedCommunities,
        degree,
        score,
        source_files: [...sourceFiles].sort((left, right) => left.localeCompare(right)),
      } satisfies WorkspaceBridge
    })
    .filter((bridge): bridge is WorkspaceBridge => bridge !== null)
    .sort(
      (left, right) =>
        right.connected_communities.length - left.connected_communities.length ||
        right.score - left.score ||
        right.degree - left.degree ||
        left.label.localeCompare(right.label),
    )
    .slice(0, topN)
}

function crossFileSurprises(graph: KnowledgeGraph, communities: Communities, topN: number): SurprisingConnection[] {
  const nodeCommunity = _nodeCommunityMap(communities)
  const candidates = graph
    .edgeEntries()
    .map(([sourceNodeId, targetNodeId, edgeData]) => {
      const relation = String(edgeData.relation ?? '')
      if (relation === 'imports' || relation === 'imports_from' || relation === 'contains' || relation === 'method') {
        return null
      }
      if (!isAnalysisEntityNode(graph, sourceNodeId) || !isAnalysisEntityNode(graph, targetNodeId)) {
        return null
      }

      const sourceFile = nodeSourceFile(graph, sourceNodeId)
      const targetFile = nodeSourceFile(graph, targetNodeId)
      if (!sourceFile || !targetFile || sourceFile === targetFile) {
        return null
      }

      const [score, reasons] = _surpriseScore(graph, sourceNodeId, targetNodeId, edgeData, nodeCommunity, sourceFile, targetFile)
      return {
        _score: score,
        connection: {
          source: nodeLabel(graph, sourceNodeId),
          target: nodeLabel(graph, targetNodeId),
          source_files: [nodeSourceFile(graph, sourceNodeId), nodeSourceFile(graph, targetNodeId)] as [string, string],
          confidence: String(edgeData.confidence ?? 'EXTRACTED'),
          ...(typeof edgeData.confidence_score === 'number' ? { confidence_score: edgeData.confidence_score } : {}),
          relation,
          why: reasons.length > 0 ? reasons.join('; ') : 'cross-file semantic connection',
        } satisfies SurprisingConnection,
      }
    })
    .filter((candidate): candidate is { _score: number; connection: SurprisingConnection } => candidate !== null)

  candidates.sort((left, right) => right._score - left._score)
  return candidates.slice(0, topN).map((candidate) => candidate.connection)
}

function crossCommunitySurprises(graph: KnowledgeGraph, communities: Communities, topN: number): SurprisingConnection[] {
  if (Object.keys(communities).length === 0) {
    const scores = edgeBetweenness(graph)
    return graph
      .edgeEntries()
      .map(([sourceNodeId, targetNodeId, edgeData]) => ({
        score: scores.get(edgePairKey(sourceNodeId, targetNodeId)) ?? 0,
        connection: {
          source: nodeLabel(graph, sourceNodeId),
          target: nodeLabel(graph, targetNodeId),
          source_files: [nodeSourceFile(graph, sourceNodeId), nodeSourceFile(graph, targetNodeId)] as [string, string],
          confidence: String(edgeData.confidence ?? 'EXTRACTED'),
          ...(typeof edgeData.confidence_score === 'number' ? { confidence_score: edgeData.confidence_score } : {}),
          relation: String(edgeData.relation ?? ''),
          why: `bridges graph structure (betweenness=${(scores.get(edgePairKey(sourceNodeId, targetNodeId)) ?? 0).toFixed(3)})`,
          note: `bridges graph structure (betweenness=${(scores.get(edgePairKey(sourceNodeId, targetNodeId)) ?? 0).toFixed(3)})`,
        } satisfies SurprisingConnection,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, topN)
      .map((entry) => entry.connection)
  }

  const nodeCommunity = _nodeCommunityMap(communities)
  const order = new Map([
    ['AMBIGUOUS', 0],
    ['INFERRED', 1],
    ['EXTRACTED', 2],
  ])

  const candidates: Array<{ pair: string; priority: number; connection: SurprisingConnection }> = []
  for (const [sourceNodeId, targetNodeId, edgeData] of graph.edgeEntries()) {
    const sourceCommunity = nodeCommunity[sourceNodeId]
    const targetCommunity = nodeCommunity[targetNodeId]
    const relation = String(edgeData.relation ?? '')
    if (sourceCommunity === undefined || targetCommunity === undefined || sourceCommunity === targetCommunity) {
      continue
    }
    if (!isAnalysisEntityNode(graph, sourceNodeId) || !isAnalysisEntityNode(graph, targetNodeId)) {
      continue
    }
    if (relation === 'imports' || relation === 'imports_from' || relation === 'contains' || relation === 'method') {
      continue
    }

    candidates.push({
      pair: [sourceCommunity, targetCommunity].sort((left, right) => left - right).join('\u0000'),
      priority: order.get(String(edgeData.confidence ?? 'EXTRACTED')) ?? 3,
      connection: {
        source: nodeLabel(graph, sourceNodeId),
        target: nodeLabel(graph, targetNodeId),
        source_files: [nodeSourceFile(graph, sourceNodeId), nodeSourceFile(graph, targetNodeId)],
        confidence: String(edgeData.confidence ?? 'EXTRACTED'),
        ...(typeof edgeData.confidence_score === 'number' ? { confidence_score: edgeData.confidence_score } : {}),
        relation,
        why: `bridges community ${sourceCommunity} → community ${targetCommunity}`,
        note: `bridges community ${sourceCommunity} → community ${targetCommunity}`,
      },
    })
  }

  candidates.sort((left, right) => left.priority - right.priority)

  const seenPairs = new Set<string>()
  const result: SurprisingConnection[] = []
  for (const candidate of candidates) {
    if (seenPairs.has(candidate.pair)) {
      continue
    }
    seenPairs.add(candidate.pair)
    result.push(candidate.connection)
    if (result.length >= topN) {
      break
    }
  }

  return result
}

export function surprisingConnections(graph: KnowledgeGraph, communities: Communities = {}, topN = 5): SurprisingConnection[] {
  const sourceFiles = new Set(
    graph
      .nodeEntries()
      .map(([, attrs]) => String(attrs.source_file ?? ''))
      .filter((sourceFile) => sourceFile.length > 0),
  )

  if (sourceFiles.size > 1) {
    return crossFileSurprises(graph, communities, topN)
  }
  return crossCommunitySurprises(graph, communities, topN)
}

function anomalySeverity(score: number, thresholds: { high: number; medium: number }): SemanticAnomaly['severity'] {
  if (score >= thresholds.high) {
    return 'HIGH'
  }
  if (score >= thresholds.medium) {
    return 'MEDIUM'
  }
  return 'LOW'
}

export function semanticAnomalies(graph: KnowledgeGraph, communities: Communities, communityLabels: Record<number, string> = {}, topN = 5): SemanticAnomaly[] {
  if (topN <= 0) {
    return []
  }

  const nodeCommunity = _nodeCommunityMap(communities)
  const candidates: SemanticAnomaly[] = []

  if (graph.numberOfEdges() > 0 && graph.numberOfNodes() <= MAX_BETWEENNESS_ANALYSIS_NODES) {
    const bridges = [...nodeBetweenness(graph).entries()]
      .filter(([nodeId, score]) => isAnalysisEntityNode(graph, nodeId) && score > 0)
      .sort((left, right) => right[1] - left[1] || nodeLabel(graph, left[0]).localeCompare(nodeLabel(graph, right[0])))

    for (const [nodeId, centrality] of bridges) {
      const communityId = nodeCommunity[nodeId]
      const neighborCommunities = new Set(
        graph
          .incidentNeighbors(nodeId)
          .map((neighborId) => nodeCommunity[neighborId])
          .filter((neighborCommunityId): neighborCommunityId is number => neighborCommunityId !== undefined && neighborCommunityId !== communityId),
      )

      if (neighborCommunities.size === 0) {
        continue
      }

      const score = Math.round(centrality * (neighborCommunities.size + 1) * 100) / 100
      const homeLabel = communityId !== undefined ? (communityLabels[communityId] ?? `Community ${communityId}`) : 'its home community'
      const otherLabels = [...neighborCommunities].map((neighborCommunityId) => communityLabels[neighborCommunityId] ?? `Community ${neighborCommunityId}`)

      candidates.push({
        id: `bridge_node:${nodeId}`,
        kind: 'bridge_node',
        severity: anomalySeverity(score, { high: 4, medium: 1.5 }),
        score,
        summary: `${nodeLabel(graph, nodeId)} bridges ${homeLabel} and ${otherLabels.join(', ')}.`,
        why: `High betweenness centrality (${centrality.toFixed(3)}) across ${neighborCommunities.size + 1} communities makes this node a likely dependency chokepoint.`,
      })
    }
  }

  for (const { communityId, nodeIds, cohesion } of lowCohesionEntityCommunities(graph)) {
    const label = overlapCommunityLabel(nodeIds, communities, communityLabels, communityId)
    const score = Math.round((LOW_COHESION_THRESHOLD - cohesion) * nodeIds.length * 10 * 100) / 100
    candidates.push({
      id: `low_cohesion_community:${communityId}`,
      kind: 'low_cohesion_community',
      severity: anomalySeverity(score, { high: 6, medium: 3 }),
      score,
      summary: `${label} is weakly connected for its size.`,
      why: `Cohesion score ${cohesion} across ${nodeIds.length} nodes suggests this community may mix unrelated responsibilities.`,
    })
  }

  const surpriseCandidates = surprisingConnections(graph, communities, Math.max(topN * 2, 5))
  for (const surprise of surpriseCandidates) {
    const score =
      (surprise.confidence === 'AMBIGUOUS' ? 4 : surprise.confidence === 'INFERRED' ? 3 : 2) +
      (surprise.source_files[0] !== surprise.source_files[1] ? 2 : 0) +
      (surprise.why.includes('bridges') ? 1 : 0)

    candidates.push({
      id: `cross_boundary_edge:${surprise.source}->${surprise.target}:${surprise.relation}`,
      kind: 'cross_boundary_edge',
      severity: anomalySeverity(score, { high: 5, medium: 3 }),
      score,
      summary: `${surprise.source} → ${surprise.target} crosses graph boundaries in an unexpected way.`,
      why: surprise.why,
    })
  }

  const limitedByKind = new Map<SemanticAnomaly['kind'], number>()
  const results: SemanticAnomaly[] = []

  for (const candidate of candidates.sort((left, right) => right.score - left.score || left.summary.localeCompare(right.summary))) {
    const count = limitedByKind.get(candidate.kind) ?? 0
    if (count >= MAX_SEMANTIC_ANOMALIES_PER_KIND) {
      continue
    }

    limitedByKind.set(candidate.kind, count + 1)
    results.push(candidate)
    if (results.length >= topN) {
      break
    }
  }

  return results
}

export function suggestQuestions(graph: KnowledgeGraph, communities: Communities, communityLabels: Record<number, string>, topN = 7): SuggestedQuestion[] {
  const questions: SuggestedQuestion[] = []
  const nodeCommunity = _nodeCommunityMap(communities)

  for (const [sourceNodeId, targetNodeId, edgeData] of graph.edgeEntries()) {
    if (String(edgeData.confidence ?? 'EXTRACTED') !== 'AMBIGUOUS') {
      continue
    }

    questions.push({
      type: 'ambiguous_edge',
      question: `What is the exact relationship between \`${nodeLabel(graph, sourceNodeId)}\` and \`${nodeLabel(graph, targetNodeId)}\`?`,
      why: `Edge tagged AMBIGUOUS (relation: ${String(edgeData.relation ?? 'related to')}) - confidence is low.`,
    })
  }

  if (graph.numberOfEdges() > 0 && graph.numberOfNodes() <= MAX_BETWEENNESS_ANALYSIS_NODES) {
    const bridges = [...nodeBetweenness(graph).entries()]
      .filter(([nodeId, score]) => isAnalysisEntityNode(graph, nodeId) && score > 0)
      .sort((left, right) => right[1] - left[1] || nodeLabel(graph, left[0]).localeCompare(nodeLabel(graph, right[0])))
      .slice(0, 3)

    for (const [nodeId, score] of bridges) {
      const communityId = nodeCommunity[nodeId]
      const communityName = communityId !== undefined ? (communityLabels[communityId] ?? `Community ${communityId}`) : 'unknown'
      const neighborCommunities = new Set(
        graph
          .incidentNeighbors(nodeId)
          .map((neighborId) => nodeCommunity[neighborId])
          .filter((neighborCommunityId): neighborCommunityId is number => neighborCommunityId !== undefined && neighborCommunityId !== communityId),
      )

      if (neighborCommunities.size === 0) {
        continue
      }

      const otherLabels = [...neighborCommunities].map((neighborCommunityId) => communityLabels[neighborCommunityId] ?? `Community ${neighborCommunityId}`)
      questions.push({
        type: 'bridge_node',
        question: `Why does \`${nodeLabel(graph, nodeId)}\` connect \`${communityName}\` to ${otherLabels.map((label) => `\`${label}\``).join(', ')}?`,
        why: `High betweenness centrality (${score.toFixed(3)}) - this node is a cross-community bridge.`,
      })
    }
  }

  const topNodes = [...graph.nodeIds()]
    .filter((nodeId) => isAnalysisEntityNode(graph, nodeId))
    .sort((left, right) => graph.degree(right) - graph.degree(left) || nodeLabel(graph, left).localeCompare(nodeLabel(graph, right)))
    .slice(0, 5)

  for (const nodeId of topNodes) {
    const inferred = graph.edgeEntries().filter(([sourceNodeId, targetNodeId, edgeData]) => {
      if (String(edgeData.confidence ?? 'EXTRACTED') !== 'INFERRED') {
        return false
      }
      return sourceNodeId === nodeId || targetNodeId === nodeId
    })

    if (inferred.length < 2) {
      continue
    }

    const otherLabels = inferred.slice(0, 2).map(([sourceNodeId, targetNodeId]) => {
      const otherNodeId = sourceNodeId === nodeId ? targetNodeId : sourceNodeId
      return nodeLabel(graph, otherNodeId)
    })

    questions.push({
      type: 'verify_inferred',
      question: `Are the ${inferred.length} inferred relationships involving \`${nodeLabel(graph, nodeId)}\` (e.g. with \`${otherLabels[0]}\` and \`${otherLabels[1]}\`) actually correct?`,
      why: `\`${nodeLabel(graph, nodeId)}\` has ${inferred.length} INFERRED edges - model-reasoned connections that need verification.`,
    })
  }

  const isolated = graph
    .nodeIds()
    .filter((nodeId) => isAnalysisEntityNode(graph, nodeId) && analysisEntityDegree(graph, nodeId) <= 1)
  if (isolated.length > 0) {
    const labels = isolated.slice(0, 3).map((nodeId) => `\`${nodeLabel(graph, nodeId)}\``)
    questions.push({
      type: 'isolated_nodes',
      question: `What connects ${labels.join(', ')} to the rest of the system?`,
      why: `${isolated.length} weakly-connected nodes found - possible documentation gaps or missing edges.`,
    })
  }

  for (const { communityId, nodeIds, cohesion } of lowCohesionEntityCommunities(graph)) {
    const label = overlapCommunityLabel(nodeIds, communities, communityLabels, communityId)
    questions.push({
      type: 'low_cohesion',
      question: `Should \`${label}\` be split into smaller, more focused modules?`,
      why: `Cohesion score ${cohesion} across ${nodeIds.length} entity nodes - this community may mix unrelated responsibilities.`,
    })
  }

  if (questions.length === 0) {
    return [
      {
        type: 'no_signal',
        question: null,
        why: 'Not enough signal to generate questions. This usually means the corpus has no AMBIGUOUS edges, no bridge nodes, no INFERRED relationships, and all communities are tightly cohesive. Add more files or extract richer edges.',
      },
    ]
  }

  return questions.slice(0, topN)
}

export function graphDiff(oldGraph: KnowledgeGraph, newGraph: KnowledgeGraph): GraphDiffResult {
  const oldNodes = new Set(oldGraph.nodeIds())
  const newNodes = new Set(newGraph.nodeIds())

  const newNodesList = [...newNodes].filter((nodeId) => !oldNodes.has(nodeId)).map((nodeId) => ({ id: nodeId, label: nodeLabel(newGraph, nodeId) }))
  const removedNodesList = [...oldNodes].filter((nodeId) => !newNodes.has(nodeId)).map((nodeId) => ({ id: nodeId, label: nodeLabel(oldGraph, nodeId) }))

  const oldEdges = new Map(oldGraph.edgeEntries().map(([, , attributes, id]) => [id, canonicalJsonString(attributes)]))
  const newEdges = new Map(newGraph.edgeEntries().map(([, , attributes, id]) => [id, canonicalJsonString(attributes)]))

  const newEdgesList = newGraph.edgeEntries()
    .filter(([, , attributes, id]) => oldEdges.get(id) !== canonicalJsonString(attributes))
    .map(([source, target, attributes, id]) => ({ id, source, target, relation: String(attributes.relation ?? ''), confidence: String(attributes.confidence ?? ''), attributes }))
  const removedEdgesList = oldGraph.edgeEntries()
    .filter(([, , attributes, id]) => newEdges.get(id) !== canonicalJsonString(attributes))
    .map(([source, target, attributes, id]) => ({ id, source, target, relation: String(attributes.relation ?? ''), confidence: String(attributes.confidence ?? ''), attributes }))

  const summaryParts: string[] = []
  if (newNodesList.length > 0) {
    summaryParts.push(`${newNodesList.length} new node${newNodesList.length === 1 ? '' : 's'}`)
  }
  if (newEdgesList.length > 0) {
    summaryParts.push(`${newEdgesList.length} new edge${newEdgesList.length === 1 ? '' : 's'}`)
  }
  if (removedNodesList.length > 0) {
    summaryParts.push(`${removedNodesList.length} node${removedNodesList.length === 1 ? '' : 's'} removed`)
  }
  if (removedEdgesList.length > 0) {
    summaryParts.push(`${removedEdgesList.length} edge${removedEdgesList.length === 1 ? '' : 's'} removed`)
  }

  return {
    new_nodes: newNodesList,
    removed_nodes: removedNodesList,
    new_edges: newEdgesList,
    removed_edges: removedEdgesList,
    summary: summaryParts.length > 0 ? summaryParts.join(', ') : 'no changes',
  }
}
