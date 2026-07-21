import { KnowledgeGraph } from '../domain/graph/directed-multigraph.js'

export type Communities = Record<number, string[]>

const MAX_LOUVAIN_PASSES = 20
const MAX_COMMUNITY_SIZE = 150
const MAX_SUB_CLUSTER_DEPTH = 2

function edgeKey(left: string, right: string): string {
  return [left, right].sort().join('\u0000')
}

function edgeWeight(attributes: Record<string, unknown>): number {
  const weight = attributes.weight
  return typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? weight : 1
}

interface LouvainState {
  nodeIds: string[]
  community: Map<string, number>
  neighborWeights: Map<string, Map<string, number>>
  nodeDegree: Map<string, number>
  communityInternalWeight: Map<number, number>
  communityTotalDegree: Map<number, number>
  totalWeight: number
}

function buildLouvainState(graph: KnowledgeGraph): LouvainState {
  const nodeIds = [...graph.nodeIds()].sort()
  const community = new Map<string, number>()
  const neighborWeights = new Map<string, Map<string, number>>()
  const nodeDegree = new Map<string, number>()
  const communityInternalWeight = new Map<number, number>()
  const communityTotalDegree = new Map<number, number>()

  // Assign each node to its own community
  for (let index = 0; index < nodeIds.length; index += 1) {
    const nodeId = nodeIds[index]!
    community.set(nodeId, index)
    neighborWeights.set(nodeId, new Map())
    nodeDegree.set(nodeId, 0)
  }

  // Build adjacency with weights
  let totalWeight = 0
  for (const [source, target, attributes] of graph.edgeEntries()) {
    const weight = edgeWeight(attributes)
    totalWeight += weight

    const sourceNeighbors = neighborWeights.get(source)
    if (sourceNeighbors) {
      sourceNeighbors.set(target, (sourceNeighbors.get(target) ?? 0) + weight)
    }

    const targetNeighbors = neighborWeights.get(target)
    if (targetNeighbors) {
      targetNeighbors.set(source, (targetNeighbors.get(source) ?? 0) + weight)
    }

    nodeDegree.set(source, (nodeDegree.get(source) ?? 0) + weight)
    nodeDegree.set(target, (nodeDegree.get(target) ?? 0) + weight)
  }

  // Initialize community aggregates
  for (const nodeId of nodeIds) {
    const communityId = community.get(nodeId)!
    communityInternalWeight.set(communityId, 0)
    communityTotalDegree.set(communityId, nodeDegree.get(nodeId) ?? 0)
  }

  return { nodeIds, community, neighborWeights, nodeDegree, communityInternalWeight, communityTotalDegree, totalWeight }
}

function modularityGain(
  state: LouvainState,
  nodeId: string,
  targetCommunity: number,
  edgeWeightToCommunity: number,
): number {
  const { communityTotalDegree, totalWeight, nodeDegree } = state
  if (totalWeight === 0) {
    return 0
  }

  const ki = nodeDegree.get(nodeId) ?? 0
  const sumTot = communityTotalDegree.get(targetCommunity) ?? 0
  const m2 = 2 * totalWeight

  return edgeWeightToCommunity - (sumTot * ki) / m2
}

function removeNodeFromCommunity(state: LouvainState, nodeId: string): void {
  const communityId = state.community.get(nodeId)!
  const ki = state.nodeDegree.get(nodeId) ?? 0

  // Calculate internal weight contribution
  let internalWeight = 0
  const neighbors = state.neighborWeights.get(nodeId)
  if (neighbors) {
    for (const [neighbor, weight] of neighbors) {
      if (state.community.get(neighbor) === communityId) {
        internalWeight += weight
      }
    }
  }

  state.communityInternalWeight.set(communityId, (state.communityInternalWeight.get(communityId) ?? 0) - internalWeight)
  state.communityTotalDegree.set(communityId, (state.communityTotalDegree.get(communityId) ?? 0) - ki)
}

function addNodeToCommunity(state: LouvainState, nodeId: string, targetCommunity: number): void {
  state.community.set(nodeId, targetCommunity)
  const ki = state.nodeDegree.get(nodeId) ?? 0

  let internalWeight = 0
  const neighbors = state.neighborWeights.get(nodeId)
  if (neighbors) {
    for (const [neighbor, weight] of neighbors) {
      if (state.community.get(neighbor) === targetCommunity) {
        internalWeight += weight
      }
    }
  }

  state.communityInternalWeight.set(targetCommunity, (state.communityInternalWeight.get(targetCommunity) ?? 0) + internalWeight)
  state.communityTotalDegree.set(targetCommunity, (state.communityTotalDegree.get(targetCommunity) ?? 0) + ki)
}

function louvainPass(state: LouvainState): boolean {
  let improved = false
  const shuffled = [...state.nodeIds]

  // Deterministic shuffle based on node degree for reproducibility
  shuffled.sort((a, b) => (state.nodeDegree.get(b) ?? 0) - (state.nodeDegree.get(a) ?? 0) || a.localeCompare(b))

  for (const nodeId of shuffled) {
    const currentCommunity = state.community.get(nodeId)!
    const neighbors = state.neighborWeights.get(nodeId)
    if (!neighbors || neighbors.size === 0) {
      continue
    }

    // Calculate edge weights to neighboring communities
    const communityWeights = new Map<number, number>()
    for (const [neighbor, weight] of neighbors) {
      const neighborCommunity = state.community.get(neighbor)!
      communityWeights.set(neighborCommunity, (communityWeights.get(neighborCommunity) ?? 0) + weight)
    }

    // Remove node from current community
    removeNodeFromCommunity(state, nodeId)

    // Find best community
    let bestCommunity = currentCommunity
    let bestGain = 0

    // Check gain for staying in current community
    const currentWeight = communityWeights.get(currentCommunity) ?? 0
    const stayGain = modularityGain(state, nodeId, currentCommunity, currentWeight)

    for (const [candidateCommunity, weightToCommunity] of [...communityWeights.entries()]
      .sort(([leftCommunity], [rightCommunity]) => leftCommunity - rightCommunity)) {
      const gain = modularityGain(state, nodeId, candidateCommunity, weightToCommunity)
      if (gain - stayGain > 1e-10) {
        if (gain - stayGain > bestGain) {
          bestGain = gain - stayGain
          bestCommunity = candidateCommunity
        }
      }
    }

    // Move node to best community
    addNodeToCommunity(state, nodeId, bestCommunity)

    if (bestCommunity !== currentCommunity) {
      improved = true
    }
  }

  return improved
}

function louvain(graph: KnowledgeGraph): Map<string, number> {
  if (graph.numberOfNodes() === 0 || graph.numberOfEdges() === 0) {
    const result = new Map<string, number>()
    const nodeIds = [...graph.nodeIds()].sort()
    for (let index = 0; index < nodeIds.length; index += 1) {
      result.set(nodeIds[index]!, index)
    }
    return result
  }

  const state = buildLouvainState(graph)

  for (let pass = 0; pass < MAX_LOUVAIN_PASSES; pass += 1) {
    if (!louvainPass(state)) {
      break
    }
  }

  return state.community
}

function subClusterLargeCommunity(graph: KnowledgeGraph, nodeIds: string[], depth: number): string[][] {
  if (depth >= MAX_SUB_CLUSTER_DEPTH || nodeIds.length <= MAX_COMMUNITY_SIZE) {
    return [nodeIds]
  }

  // Build a subgraph with only the community's nodes
  const nodeSet = new Set(nodeIds)
  const subgraph = new KnowledgeGraph(typeof graph.graph.root_path === 'string' ? { root_path: graph.graph.root_path } : {})

  for (const nodeId of nodeIds) {
    subgraph.addNode(nodeId, graph.nodeAttributes(nodeId))
  }

  for (const [source, target, attributes] of graph.edgeEntries()) {
    if (nodeSet.has(source) && nodeSet.has(target)) {
      subgraph.addEdge(source, target, attributes)
    }
  }

  if (subgraph.numberOfEdges() === 0) {
    return [nodeIds]
  }

  const subCommunityMap = louvain(subgraph)

  // Group by sub-community
  const buckets = new Map<number, string[]>()
  for (const [nodeId, communityId] of subCommunityMap) {
    const bucket = buckets.get(communityId) ?? []
    bucket.push(nodeId)
    buckets.set(communityId, bucket)
  }

  const subCommunities = [...buckets.values()]

  // If Louvain didn't split (everything in one community), don't recurse
  if (subCommunities.length <= 1) {
    return [nodeIds]
  }

  // Recursively sub-cluster any still-large communities
  const result: string[][] = []
  for (const subNodes of subCommunities) {
    if (subNodes.length > MAX_COMMUNITY_SIZE) {
      result.push(...subClusterLargeCommunity(graph, subNodes, depth + 1))
    } else {
      result.push(subNodes)
    }
  }

  return result
}

export function cluster(graph: KnowledgeGraph): Communities {
  if (graph.numberOfNodes() === 0) {
    return {}
  }

  if (graph.numberOfEdges() === 0) {
    return Object.fromEntries([...graph.nodeIds()].sort().map((nodeId, index) => [index, [nodeId]]))
  }

  // Phase 1: Louvain community detection
  const communityMap = louvain(graph)

  // Group nodes by community
  const buckets = new Map<number, string[]>()
  for (const [nodeId, communityId] of communityMap) {
    const bucket = buckets.get(communityId) ?? []
    bucket.push(nodeId)
    buckets.set(communityId, bucket)
  }

  // Phase 2: Sub-cluster large communities
  const finalCommunities: string[][] = []
  for (const nodes of buckets.values()) {
    if (nodes.length > MAX_COMMUNITY_SIZE) {
      finalCommunities.push(...subClusterLargeCommunity(graph, nodes, 0))
    } else {
      finalCommunities.push(nodes)
    }
  }

  // Sort: largest communities first, then alphabetically by first node
  for (const community of finalCommunities) {
    community.sort()
  }
  finalCommunities.sort((left, right) => right.length - left.length || left[0]!.localeCompare(right[0]!))

  return Object.fromEntries(finalCommunities.map((nodes, index) => [index, nodes]))
}

export function cohesionScore(graph: KnowledgeGraph, communityNodes: string[]): number {
  const nodeCount = communityNodes.length
  if (nodeCount <= 1) {
    return 1
  }

  const communitySet = new Set(communityNodes)
  const actualEdges = new Set<string>()
  for (const [source, target] of graph.edgeEntries()) {
    if (communitySet.has(source) && communitySet.has(target)) {
      actualEdges.add(edgeKey(source, target))
    }
  }

  const possibleEdges = (nodeCount * (nodeCount - 1)) / 2
  return possibleEdges > 0 ? Math.round((actualEdges.size / possibleEdges) * 100) / 100 : 0
}

export function scoreAll(graph: KnowledgeGraph, communities: Communities): Record<number, number> {
  return Object.fromEntries(Object.entries(communities).map(([communityId, nodeIds]) => [Number(communityId), cohesionScore(graph, nodeIds)]))
}
