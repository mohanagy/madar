import { KnowledgeGraph } from '../contracts/graph.js'
import { relativizeSourceFile } from '../shared/source-path.js'
import { requireDirectedGraph } from './direction.js'
import { communitiesFromGraph } from './serve.js'

const MAX_IMPACT_DEPTH = 5
const MAX_IMPACT_NODES = 500

export interface ImpactOptions {
  label?: string
  nodeId?: string
  depth?: number
  edgeTypes?: string[]
}

export interface ImpactNode {
  node_id: string
  label: string
  source_file: string
  node_kind?: string
  framework_role: string | null
  file_type: string
  community: number | null
  community_label: string | null
  distance: number
  relation: string
}

export type ImpactTraversalStatus = 'complete' | 'depth_limited' | 'node_limited'

export interface ImpactTraversal {
  /** Completeness of traversal in the supplied static graph, not runtime behavior. */
  status: ImpactTraversalStatus
  depth: number
  /** Includes the target node. */
  node_limit: number
}

export interface ImpactResult {
  target: string
  target_node_id?: string
  target_file: string
  target_file_type?: string
  depth: number
  direct_dependents: ImpactNode[]
  transitive_dependents: ImpactNode[]
  affected_files: string[]
  affected_communities: Array<{ id: number; label: string; node_count: number }>
  top_paths_per_community: Array<{ id: number; label: string; distance: number; path: string[] }>
  total_affected: number
  /** Absent on legacy stored results; current analyses always report traversal scope. */
  traversal?: ImpactTraversal
}

export interface CompactImpactNode extends Omit<ImpactNode, 'community_label' | 'file_type' | 'framework_role'> {
  file_type?: string
}

export interface CompactImpactResult extends Omit<ImpactResult, 'direct_dependents' | 'transitive_dependents'> {
  direct_dependents: CompactImpactNode[]
  transitive_dependents: CompactImpactNode[]
  shared_file_type?: string
}

interface TraversalCandidate {
  neighborId: string
  relation: string
}

interface CommunityPathSummary {
  summary_rank: number
  distance: number
  path: string[]
}

function frameworkSummaryRank(node: { node_kind?: string; framework_role?: string | null }): number {
  if (
    node.node_kind === 'route' ||
    node.framework_role === 'express_route' ||
    node.framework_role === 'react_router_route' ||
    node.framework_role === 'nest_route' ||
    node.framework_role === 'next_route' ||
    node.framework_role === 'next_route_handler'
  ) {
    return 4
  }
  if (
    node.node_kind === 'slice' ||
    node.node_kind === 'store' ||
    node.framework_role === 'redux_slice' ||
    node.framework_role === 'redux_store' ||
    node.framework_role === 'nest_module' ||
    node.framework_role === 'nest_controller' ||
    node.framework_role === 'next_page' ||
    node.framework_role === 'next_layout' ||
    node.framework_role === 'next_pages_app' ||
    node.framework_role === 'next_pages_document' ||
    node.framework_role === 'next_pages_error'
  ) {
    return 3
  }
  if (
    node.framework_role === 'express_handler' ||
    node.framework_role === 'express_middleware' ||
    node.framework_role === 'redux_selector' ||
    node.framework_role === 'redux_action' ||
    node.framework_role === 'redux_thunk' ||
    node.framework_role === 'react_router_loader' ||
    node.framework_role === 'react_router_action' ||
    node.framework_role === 'react_router_component' ||
    node.framework_role === 'nest_provider' ||
    node.framework_role === 'nest_guard' ||
    node.framework_role === 'nest_pipe' ||
    node.framework_role === 'nest_interceptor' ||
    node.framework_role === 'next_template' ||
    node.framework_role === 'next_loading' ||
    node.framework_role === 'next_error' ||
    node.framework_role === 'next_not_found' ||
    node.framework_role === 'next_default' ||
    node.framework_role === 'next_middleware' ||
    node.framework_role === 'next_server_action' ||
    node.framework_role === 'next_client_component'
  ) {
    return 2
  }
  return 0
}

function forwardImpactRelation(relation: string): boolean {
  return relation === 'defines_action' || relation === 'defines_selector' || relation === 'registered_in_store'
}

function impactNeighbors(graph: KnowledgeGraph, nodeId: string, edgeTypes: string[] | undefined): TraversalCandidate[] {
  const candidates = new Map<string, TraversalCandidate>()

  for (const dependentId of graph.predecessors(nodeId)) {
    const relation = edgeRelation(graph, dependentId, nodeId)
    if (matchesEdgeType(relation, edgeTypes)) {
      candidates.set(`pred:${dependentId}`, { neighborId: dependentId, relation })
    }
  }

  for (const successorId of graph.successors(nodeId)) {
    const relation = edgeRelation(graph, nodeId, successorId)
    if (forwardImpactRelation(relation) && matchesEdgeType(relation, edgeTypes)) {
      candidates.set(`succ:${successorId}`, { neighborId: successorId, relation })
    }
  }

  return [...candidates.values()]
}

function findNodeByLabel(graph: KnowledgeGraph, label: string): string | null {
  const normalizedLabel = label.toLowerCase()

  for (const [nodeId, attributes] of graph.nodeEntries()) {
    const nodeLabel = String(attributes.label ?? '').toLowerCase()
    if (nodeLabel === normalizedLabel) {
      return nodeId
    }
  }

  // Prefix match fallback
  for (const [nodeId, attributes] of graph.nodeEntries()) {
    const nodeLabel = String(attributes.label ?? '').toLowerCase()
    if (nodeLabel.startsWith(normalizedLabel) || normalizedLabel.startsWith(nodeLabel)) {
      return nodeId
    }
  }

  return null
}

export interface ImpactTargetCandidate {
  node_id: string
  label: string
  source_file: string
}

export class ImpactTargetResolutionError extends Error {
  constructor(
    readonly status: 'ambiguous_target' | 'target_not_found',
    readonly selector: string,
    readonly candidates: ImpactTargetCandidate[] = [],
  ) {
    super(status === 'ambiguous_target'
      ? `Impact target ${JSON.stringify(selector)} is ambiguous; use node_id: ${candidates.map((node) => `${node.node_id} (${node.source_file})`).join(', ')}`
      : `Impact target ${JSON.stringify(selector)} was not found; refresh the graph or select an existing node_id or label.`)
    this.name = 'ImpactTargetResolutionError'
  }
}

function resolveImpactTarget(graph: KnowledgeGraph, options: ImpactOptions): string | null {
  // An explicit identity is authoritative, including when it is stale or invalid.
  if (options.nodeId !== undefined) {
    if (!graph.hasNode(options.nodeId)) {
      throw new ImpactTargetResolutionError('target_not_found', options.nodeId)
    }
    return options.nodeId
  }

  const label = options.label?.trim() ?? ''
  if (!label) return null
  const normalizedLabel = label.toLowerCase()
  const exact: ImpactTargetCandidate[] = []
  const prefixes: ImpactTargetCandidate[] = []
  const rootPath = typeof graph.graph.root_path === 'string' ? graph.graph.root_path : undefined
  for (const [nodeId, attributes] of graph.nodeEntries()) {
    const nodeLabel = String(attributes.label ?? '').trim()
    if (!nodeLabel) continue
    const normalizedNodeLabel = nodeLabel.toLowerCase()
    const candidate = {
      node_id: nodeId,
      label: nodeLabel,
      source_file: relativizeSourceFile(String(attributes.source_file ?? ''), rootPath),
    }
    if (normalizedNodeLabel === normalizedLabel) exact.push(candidate)
    else if (normalizedNodeLabel.startsWith(normalizedLabel) || normalizedLabel.startsWith(normalizedNodeLabel)) prefixes.push(candidate)
  }
  const candidates = exact.length > 0 ? exact : prefixes
  if (candidates.length > 1) {
    candidates.sort((a, b) => a.source_file.localeCompare(b.source_file) || a.node_id.localeCompare(b.node_id))
    throw new ImpactTargetResolutionError('ambiguous_target', label, candidates)
  }
  return candidates[0]?.node_id ?? null
}

function parseCommunityId(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw
  }
  if (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw))) {
    return Number(raw)
  }
  return null
}

function edgeRelation(graph: KnowledgeGraph, source: string, target: string): string {
  try {
    return String(graph.edgeAttributes(source, target).relation ?? 'related_to')
  } catch {
    try {
      return String(graph.edgeAttributes(target, source).relation ?? 'related_to')
    } catch {
      return 'related_to'
    }
  }
}

function matchesEdgeType(relation: string, edgeTypes: string[] | undefined): boolean {
  if (!edgeTypes || edgeTypes.length === 0) {
    return true
  }
  return edgeTypes.some((type) => relation === type)
}

export function analyzeImpact(
  graph: KnowledgeGraph,
  communityLabels: Record<number, string>,
  options: ImpactOptions,
): ImpactResult {
  requireDirectedGraph(graph, 'Impact analysis')

  const maxDepth = Math.min(options.depth ?? 3, MAX_IMPACT_DEPTH)
  const targetNodeId = resolveImpactTarget(graph, options)
  const rootPath = typeof graph.graph.root_path === 'string' ? graph.graph.root_path : undefined

  if (!targetNodeId) {
    throw new ImpactTargetResolutionError('target_not_found', options.label?.trim() ?? '')
  }

  const targetAttributes = graph.nodeAttributes(targetNodeId)
  const communities = communitiesFromGraph(graph)

  // BFS to find all dependents at each distance
  const visited = new Map<string, number>() // nodeId -> distance
  const queue: Array<{ nodeId: string; distance: number; path: string[] }> = [{ nodeId: targetNodeId, distance: 0, path: [targetNodeId] }]
  visited.set(targetNodeId, 0)

  const directDependents: ImpactNode[] = []
  const transitiveDependents: ImpactNode[] = []
  const discoveredDependents: Array<{ nodeId: string; path: string[]; node: ImpactNode }> = []
  let traversalStatus: ImpactTraversalStatus = 'complete'

  traversal: while (queue.length > 0) {
    const current = queue.shift()
    if (!current || current.distance >= maxDepth) {
      continue
    }

    for (const { neighborId, relation } of impactNeighbors(graph, current.nodeId, options.edgeTypes)) {
      if (visited.has(neighborId)) {
        continue
      }
      // Reaching capacity alone is not truncation: a graph with exactly this
      // many reachable nodes may be exhausted. Only an unseen eligible node
      // proves that further impact was omitted.
      if (visited.size >= MAX_IMPACT_NODES) {
        traversalStatus = 'node_limited'
        break traversal
      }

      const distance = current.distance + 1
      const path = [...current.path, neighborId]
      visited.set(neighborId, distance)

      const attributes = graph.nodeAttributes(neighborId)
      const community = parseCommunityId(attributes.community)
      const nodeKind = String(attributes.node_kind ?? '')
      const node: ImpactNode = {
        node_id: neighborId,
        label: String(attributes.label ?? neighborId),
        source_file: relativizeSourceFile(String(attributes.source_file ?? ''), rootPath),
        framework_role: String(attributes.framework_role ?? '') || null,
        file_type: String(attributes.file_type ?? ''),
        community,
        community_label: community !== null ? (communityLabels[community] ?? null) : null,
        distance,
        relation,
        ...(nodeKind.trim().length > 0 ? { node_kind: nodeKind } : {}),
      }

      if (distance === 1) {
        directDependents.push(node)
      } else {
        transitiveDependents.push(node)
      }

      discoveredDependents.push({ nodeId: neighborId, path, node })
      queue.push({ nodeId: neighborId, distance, path })
    }
  }

  // Inspect the final frontier so a boundary edge to an already visited node
  // (including a cycle) does not incorrectly imply omitted impact.
  if (traversalStatus !== 'node_limited') {
    for (const [nodeId, distance] of visited) {
      if (distance >= maxDepth && impactNeighbors(graph, nodeId, options.edgeTypes).some(({ neighborId }) => !visited.has(neighborId))) {
        traversalStatus = 'depth_limited'
        break
      }
    }
  }

  // Affected files (deduplicated)
  const fileSet = new Set<string>()
  for (const discovered of discoveredDependents) {
    if (discovered.node.source_file) {
      fileSet.add(discovered.node.source_file)
    }
  }

  // Affected communities (deduplicated with counts)
  const communityMap = new Map<number, number>()
  const topPathsByCommunity = new Map<number, CommunityPathSummary>()
  for (const discovered of discoveredDependents) {
    const { node, path } = discovered
    if (node.community !== null) {
      communityMap.set(node.community, (communityMap.get(node.community) ?? 0) + 1)

      const labeledPath = path.map((nodeId) => String(graph.nodeAttributes(nodeId).label ?? nodeId))
      const existing = topPathsByCommunity.get(node.community)
      const summaryRank = frameworkSummaryRank(node)
      const shouldReplace =
        !existing ||
        summaryRank > existing.summary_rank ||
        (summaryRank === existing.summary_rank &&
          (node.distance < existing.distance ||
            (node.distance === existing.distance && labeledPath.join('\u0000') < existing.path.join('\u0000'))))

      if (shouldReplace) {
        topPathsByCommunity.set(node.community, { summary_rank: summaryRank, distance: node.distance, path: labeledPath })
      }
    }
  }

  const affectedCommunities = [...communityMap.entries()]
    .map(([id, count]) => ({
      id,
      label: communityLabels[id] ?? `Community ${id}`,
      node_count: count,
    }))
    .sort((a, b) => b.node_count - a.node_count)

  const topPathsPerCommunity = [...topPathsByCommunity.entries()]
    .map(([id, value]) => ({
      id,
      label: communityLabels[id] ?? `Community ${id}`,
      distance: value.distance,
      path: value.path,
    }))
    .sort((a, b) => a.distance - b.distance || a.label.localeCompare(b.label))

  return {
    target: String(targetAttributes.label ?? targetNodeId),
    target_node_id: targetNodeId,
    target_file: relativizeSourceFile(String(targetAttributes.source_file ?? ''), rootPath),
    ...(String(targetAttributes.file_type ?? '').trim().length > 0 ? { target_file_type: String(targetAttributes.file_type) } : {}),
    depth: maxDepth,
    direct_dependents: directDependents.sort(
      (a, b) =>
        frameworkSummaryRank(b) - frameworkSummaryRank(a) ||
        a.label.localeCompare(b.label) || a.node_id.localeCompare(b.node_id),
    ),
    transitive_dependents: transitiveDependents.sort(
      (a, b) =>
        frameworkSummaryRank(b) - frameworkSummaryRank(a) ||
        a.distance - b.distance ||
        a.label.localeCompare(b.label) || a.node_id.localeCompare(b.node_id),
    ),
    affected_files: [...fileSet].sort(),
    affected_communities: affectedCommunities,
    top_paths_per_community: topPathsPerCommunity,
    total_affected: directDependents.length + transitiveDependents.length,
    traversal: { status: traversalStatus, depth: maxDepth, node_limit: MAX_IMPACT_NODES },
  }
}

export function compactImpactResult(result: ImpactResult): CompactImpactResult {
  const dependents = [...result.direct_dependents, ...result.transitive_dependents]
  const sharedFileType =
    dependents.length > 0 && dependents.every((node) => node.file_type === dependents[0]?.file_type)
      ? dependents[0]?.file_type
      : undefined
  const compactNode = ({ community_label: _communityLabel, file_type: fileType, framework_role: _frameworkRole, ...node }: ImpactNode): CompactImpactNode => ({
    ...node,
    ...(sharedFileType ? {} : { file_type: fileType }),
  })

  return {
    target: result.target,
    ...(result.target_node_id !== undefined ? { target_node_id: result.target_node_id } : {}),
    target_file: result.target_file,
    ...(result.target_file_type ? { target_file_type: result.target_file_type } : {}),
    depth: result.depth,
    direct_dependents: result.direct_dependents.map(compactNode),
    transitive_dependents: result.transitive_dependents.map(compactNode),
    affected_files: result.affected_files,
    affected_communities: result.affected_communities,
    top_paths_per_community: result.top_paths_per_community,
    total_affected: result.total_affected,
    ...(result.traversal ? { traversal: result.traversal } : {}),
    ...(sharedFileType ? { shared_file_type: sharedFileType } : {}),
  }
}

export function callChains(
  graph: KnowledgeGraph,
  source: string,
  target: string,
  maxHops = 8,
  edgeTypes: string[] = ['calls', 'imports_from'],
): string[][] {
  requireDirectedGraph(graph, 'Call-chain analysis')

  const sourceNodeId = findNodeByLabel(graph, source)
  const targetNodeId = findNodeByLabel(graph, target)

  if (!sourceNodeId || !targetNodeId) {
    return []
  }

  const chains: string[][] = []
  const maxChains = 10

  const dfs = (current: string, path: string[], visited: Set<string>): void => {
    if (chains.length >= maxChains) {
      return
    }
    if (path.length > maxHops + 1) {
      return
    }

    if (current === targetNodeId && path.length > 1) {
      chains.push(path.map((nodeId) => String(graph.nodeAttributes(nodeId).label ?? nodeId)))
      return
    }

    for (const neighbor of graph.neighbors(current)) {
      if (visited.has(neighbor)) {
        continue
      }

      const relation = edgeRelation(graph, current, neighbor)
      if (!matchesEdgeType(relation, edgeTypes)) {
        continue
      }

      visited.add(neighbor)
      dfs(neighbor, [...path, neighbor], visited)
      visited.delete(neighbor)
    }
  }

  const visited = new Set<string>([sourceNodeId])
  dfs(sourceNodeId, [sourceNodeId], visited)

  return chains.sort((a, b) => a.length - b.length)
}
