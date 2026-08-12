import { KnowledgeGraph } from '../contracts/graph.js'
import type { Communities } from './cluster.js'

export interface CommunityDetailsMicro {
  id: number
  label: string
  node_count: number
  top_nodes: string[]
}

export interface CommunityDetailsMid {
  id: number
  label: string
  node_count: number
  edge_count: number
  entry_points: Array<{ label: string; in_degree: number }>
  exit_points: Array<{ label: string; target_community: string }>
  bridge_nodes: string[]
  dominant_file: string | null
  key_nodes: Array<{ label: string; degree: number; node_kind: string }>
}

export interface CommunityDetailsMacro {
  id: number
  label: string
  node_count: number
  edge_count: number
  nodes: Array<{ label: string; source_file: string; node_kind: string; degree: number }>
  internal_edges: Array<{ from: string; to: string; relation: string }>
  cross_community_edges: Array<{ from: string; to: string; relation: string; target_community: string }>
  file_distribution: Array<{ file: string; node_count: number }>
}

export type CommunityZoomLevel = 'micro' | 'mid' | 'macro'

function parseCommunityId(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw
  }
  if (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw))) {
    return Number(raw)
  }
  return null
}

function nodeLabel(graph: KnowledgeGraph, nodeId: string): string {
  return String(graph.nodeAttributes(nodeId).label ?? nodeId)
}

function buildNodeCommunityMap(communities: Communities): Map<string, number> {
  const map = new Map<string, number>()
  for (const [communityIdRaw, nodeIds] of Object.entries(communities)) {
    const communityId = Number(communityIdRaw)
    for (const nodeId of nodeIds) {
      map.set(nodeId, communityId)
    }
  }
  return map
}

function edgeKey(a: string, b: string): string {
  return [a, b].sort().join('\u0000')
}

export function communityDetailsMicro(
  graph: KnowledgeGraph,
  communities: Communities,
  communityLabels: Record<number, string>,
): CommunityDetailsMicro[] {
  return Object.entries(communities)
    .map(([communityIdRaw, nodeIds]) => {
      const communityId = Number(communityIdRaw)
      const topNodes = [...nodeIds]
        .sort((a, b) => graph.uniqueNeighborDegree(b) - graph.uniqueNeighborDegree(a))
        .slice(0, 3)
        .map((id) => nodeLabel(graph, id))

      return {
        id: communityId,
        label: communityLabels[communityId] ?? `Community ${communityId}`,
        node_count: nodeIds.length,
        top_nodes: topNodes,
      }
    })
    .sort((a, b) => b.node_count - a.node_count)
}

export function communityDetailsMid(
  graph: KnowledgeGraph,
  communities: Communities,
  communityLabels: Record<number, string>,
  communityId: number,
): CommunityDetailsMid | null {
  const nodeIds = communities[communityId]
  if (!nodeIds || nodeIds.length === 0) {
    return null
  }

  const nodeSet = new Set(nodeIds)
  const nodeCommunityMap = buildNodeCommunityMap(communities)

  // Count internal edges
  let edgeCount = 0
  const seenEdges = new Set<string>()
  for (const { source, target } of graph.endpointEntries()) {
    if (nodeSet.has(source) && nodeSet.has(target)) {
      const key = edgeKey(source, target)
      if (!seenEdges.has(key)) {
        seenEdges.add(key)
        edgeCount += 1
      }
    }
  }

  // Entry points: nodes with high in-degree from outside the community
  const externalInDegree = new Map<string, number>()
  for (const nodeId of nodeIds) {
    let count = 0
    for (const neighbor of graph.incidentNeighbors(nodeId)) {
      if (!nodeSet.has(neighbor)) {
        count += 1
      }
    }
    if (count > 0) {
      externalInDegree.set(nodeId, count)
    }
  }

  const entryPoints = [...externalInDegree.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([nodeId, inDegree]) => ({ label: nodeLabel(graph, nodeId), in_degree: inDegree }))

  // Exit points: nodes that connect to other communities
  const exitPointMap = new Map<string, Set<string>>()
  for (const nodeId of nodeIds) {
    for (const neighbor of graph.incidentNeighbors(nodeId)) {
      if (nodeSet.has(neighbor)) {
        continue
      }
      const neighborCommunity = nodeCommunityMap.get(neighbor)
      if (neighborCommunity === undefined) {
        continue
      }
      const targetLabel = communityLabels[neighborCommunity] ?? `Community ${neighborCommunity}`
      if (!exitPointMap.has(nodeId)) {
        exitPointMap.set(nodeId, new Set())
      }
      exitPointMap.get(nodeId)!.add(targetLabel)
    }
  }

  const exitPoints = [...exitPointMap.entries()]
    .flatMap(([nodeId, targets]) => [...targets].map((target) => ({ label: nodeLabel(graph, nodeId), target_community: target })))
    .slice(0, 5)

  // Bridge nodes: nodes connected to 2+ other communities
  const bridgeNodes = [...exitPointMap.entries()]
    .filter(([, targets]) => targets.size >= 2)
    .map(([nodeId]) => nodeLabel(graph, nodeId))

  // Key nodes by degree
  const keyNodes = [...nodeIds]
    .sort((a, b) => graph.uniqueNeighborDegree(b) - graph.uniqueNeighborDegree(a))
    .slice(0, 5)
    .map((nodeId) => ({
      label: nodeLabel(graph, nodeId),
      degree: graph.uniqueNeighborDegree(nodeId),
      node_kind: String(graph.nodeAttributes(nodeId).node_kind ?? ''),
    }))

  // Dominant file
  const fileCounts = new Map<string, number>()
  for (const nodeId of nodeIds) {
    const file = String(graph.nodeAttributes(nodeId).source_file ?? '')
    if (file) {
      fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1)
    }
  }
  const dominantFile = [...fileCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  return {
    id: communityId,
    label: communityLabels[communityId] ?? `Community ${communityId}`,
    node_count: nodeIds.length,
    edge_count: edgeCount,
    entry_points: entryPoints,
    exit_points: exitPoints,
    bridge_nodes: bridgeNodes,
    dominant_file: dominantFile,
    key_nodes: keyNodes,
  }
}

export function communityDetailsMacro(
  graph: KnowledgeGraph,
  communities: Communities,
  communityLabels: Record<number, string>,
  communityId: number,
): CommunityDetailsMacro | null {
  const nodeIds = communities[communityId]
  if (!nodeIds || nodeIds.length === 0) {
    return null
  }

  const nodeSet = new Set(nodeIds)
  const nodeCommunityMap = buildNodeCommunityMap(communities)

  const nodes = nodeIds.map((nodeId) => {
    const attributes = graph.nodeAttributes(nodeId)
    return {
      label: String(attributes.label ?? nodeId),
      source_file: String(attributes.source_file ?? ''),
      node_kind: String(attributes.node_kind ?? ''),
      degree: graph.uniqueNeighborDegree(nodeId),
    }
  }).sort((a, b) => b.degree - a.degree)

  const internalEdges: CommunityDetailsMacro['internal_edges'] = []
  const crossCommunityEdges: CommunityDetailsMacro['cross_community_edges'] = []
  const seenEdges = new Set<string>()

  for (const { source, target } of graph.endpointEntries()) {
    const sourceIn = nodeSet.has(source)
    const targetIn = nodeSet.has(target)

    if (sourceIn && targetIn) {
      const key = edgeKey(source, target)
      if (seenEdges.has(key)) {
        continue
      }
      seenEdges.add(key)
      for (const attributes of graph.factsBetween(source, target)) {
        internalEdges.push({
          from: nodeLabel(graph, source),
          to: nodeLabel(graph, target),
          relation: String(attributes.relation ?? 'related_to'),
        })
      }
    } else if (sourceIn && !targetIn) {
      const targetCommunity = nodeCommunityMap.get(target)
      for (const attributes of graph.factsBetween(source, target)) {
        crossCommunityEdges.push({
          from: nodeLabel(graph, source),
          to: nodeLabel(graph, target),
          relation: String(attributes.relation ?? 'related_to'),
          target_community: targetCommunity !== undefined ? (communityLabels[targetCommunity] ?? `Community ${targetCommunity}`) : 'unknown',
        })
      }
    } else if (!sourceIn && targetIn) {
      const sourceCommunity = nodeCommunityMap.get(source)
      for (const attributes of graph.factsBetween(source, target)) {
        crossCommunityEdges.push({
          from: nodeLabel(graph, source),
          to: nodeLabel(graph, target),
          relation: String(attributes.relation ?? 'related_to'),
          target_community: sourceCommunity !== undefined ? (communityLabels[sourceCommunity] ?? `Community ${sourceCommunity}`) : 'unknown',
        })
      }
    }
  }

  // File distribution
  const fileCounts = new Map<string, number>()
  for (const node of nodes) {
    if (node.source_file) {
      fileCounts.set(node.source_file, (fileCounts.get(node.source_file) ?? 0) + 1)
    }
  }

  const fileDistribution = [...fileCounts.entries()]
    .map(([file, count]) => ({ file, node_count: count }))
    .sort((a, b) => b.node_count - a.node_count)

  return {
    id: communityId,
    label: communityLabels[communityId] ?? `Community ${communityId}`,
    node_count: nodeIds.length,
    edge_count: internalEdges.length,
    nodes,
    internal_edges: internalEdges,
    cross_community_edges: crossCommunityEdges,
    file_distribution: fileDistribution,
  }
}

export function communityDetailsAtZoom(
  graph: KnowledgeGraph,
  communities: Communities,
  communityLabels: Record<number, string>,
  communityId: number,
  zoom: CommunityZoomLevel,
): CommunityDetailsMicro | CommunityDetailsMid | CommunityDetailsMacro | null {
  switch (zoom) {
    case 'micro':
      return communityDetailsMicro(graph, communities, communityLabels).find((c) => c.id === communityId) ?? null
    case 'mid':
      return communityDetailsMid(graph, communities, communityLabels, communityId)
    case 'macro':
      return communityDetailsMacro(graph, communities, communityLabels, communityId)
  }
}
