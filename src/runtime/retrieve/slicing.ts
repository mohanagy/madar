import type {
  ContextPackSliceAnchor,
  ContextPackSliceMetadata,
  ContextPackSlicePath,
} from '../../contracts/context-pack.js'
import type { KnowledgeGraph } from '../../contracts/graph.js'
import type { RetrievalIntent } from '../../contracts/retrieval-gate.js'
import { classifySourceDomain, isPollutedSourcePath } from '../../shared/source-discovery.js'
import { relativizeSourceFile } from '../../shared/source-path.js'

export interface SliceScoredNode {
  id: string
  label: string
  sourceFile: string
  nodeKind?: string | undefined
  frameworkRole?: string | undefined
  exactLabelMatch: boolean
  literalPathMatch?: boolean
  sourcePathMatch: boolean
  score: number
}

interface SliceOptions {
  prompt?: string | undefined
  mentionedSymbols?: readonly string[] | undefined
  excludedDomains?: readonly string[] | undefined
  excludedTerms?: readonly string[] | undefined
  excludedPathHints?: readonly string[] | undefined
  rootPath?: string | undefined
}

function sliceNodeFromGraph(graph: KnowledgeGraph, nodeId: string): SliceScoredNode {
  const attributes = graph.nodeAttributes(nodeId)
  return {
    id: nodeId,
    label: String(attributes.label ?? nodeId),
    sourceFile: String(attributes.source_file ?? ''),
    nodeKind: typeof attributes.node_kind === 'string' ? attributes.node_kind : undefined,
    frameworkRole: typeof attributes.framework_role === 'string' ? attributes.framework_role : undefined,
    exactLabelMatch: false,
    literalPathMatch: false,
    sourcePathMatch: false,
    score: 0.25,
  }
}

type SliceMode = ContextPackSliceMetadata['mode']

interface SlicePolicy {
  mode: SliceMode
  directions: Array<'forward' | 'backward'>
  backward_relations: ReadonlySet<string>
  forward_relations: ReadonlySet<string>
  backward_depth: number
  forward_depth: number
  helper_relations: ReadonlySet<string>
  runtime_flow_only?: boolean
}

const EXPLAIN_BACKWARD = new Set(['calls', 'controller_route', 'route_handler'])
const EXPLAIN_FORWARD = new Set(['calls', 'contains', 'method', 'route_handler', 'controller_route'])
const DEBUG_BACKWARD = new Set(['calls', 'controller_route', 'route_handler'])
const DEBUG_FORWARD = new Set(['calls', 'contains', 'method', 'route_handler', 'controller_route'])
const IMPACT_BACKWARD = new Set(['calls', 'controller_route', 'route_handler'])
const IMPACT_FORWARD = new Set(['calls', 'contains', 'method', 'route_handler', 'controller_route'])
const DEBUG_HELPERS = new Set(['uses_guard', 'guarded_by', 'reads_env', 'uses_config', 'depends_on', 'covered_by', 'injects'])
const EXPLAIN_HELPERS = new Set(['covered_by', 'reads_env', 'uses_config'])
const IMPACT_HELPERS = new Set(['covered_by', 'reads_env', 'uses_config', 'depends_on', 'exports'])

function policyForIntent(intent: RetrievalIntent): SlicePolicy {
  switch (intent) {
    case 'debug':
      return {
        mode: 'debug',
        directions: ['backward', 'forward'],
        backward_relations: DEBUG_BACKWARD,
        forward_relations: DEBUG_FORWARD,
        backward_depth: 1,
        forward_depth: 1,
        helper_relations: DEBUG_HELPERS,
      }
    case 'impact':
      return {
        mode: 'impact',
        directions: ['backward', 'forward'],
        backward_relations: IMPACT_BACKWARD,
        forward_relations: IMPACT_FORWARD,
        backward_depth: 2,
        forward_depth: 1,
        helper_relations: IMPACT_HELPERS,
      }
    case 'review':
      return {
        mode: 'review',
        directions: ['backward', 'forward'],
        backward_relations: IMPACT_BACKWARD,
        forward_relations: IMPACT_FORWARD,
        backward_depth: 1,
        forward_depth: 1,
        helper_relations: IMPACT_HELPERS,
      }
    case 'explain':
    default:
      return {
        mode: 'explain',
        directions: ['backward', 'forward'],
        backward_relations: EXPLAIN_BACKWARD,
        forward_relations: EXPLAIN_FORWARD,
        backward_depth: 1,
        forward_depth: 1,
        helper_relations: EXPLAIN_HELPERS,
      }
  }
}

function promptWantsRuntimePipeline(prompt: string | undefined): boolean {
  if (!prompt) {
    return false
  }

  return /\b(runtime|pipeline|service|orchestrator|job|agent|scoring|report builder|persistence|repository)\b/i.test(prompt)
}

function methodLikeNode(node: SliceScoredNode): boolean {
  return node.nodeKind?.toLowerCase() === 'method' || /(?:[.#:]|^\.)[A-Za-z_$][\w$]*\(?\)?$/u.test(node.label)
}

function methodNameFromLabel(label: string): string | undefined {
  const trimmed = label.trim().replace(/`/g, '').replace(/\(\)$/, '')
  const qualified = trimmed.match(/(?:\.|#|::)([A-Za-z_$][\w$]*)$/)
  if (qualified?.[1]) {
    return qualified[1].toLowerCase()
  }
  const dotted = trimmed.match(/^\.([A-Za-z_$][\w$]*)$/)
  if (dotted?.[1]) {
    return dotted[1].toLowerCase()
  }
  return undefined
}

function effectivePolicy(
  intent: RetrievalIntent,
  anchors: readonly ContextPackSliceAnchor[],
  anchorNodes: readonly SliceScoredNode[],
  prompt: string | undefined,
): SlicePolicy {
  const base = policyForIntent(intent)
  const hasMethodAnchor = anchorNodes.some((anchor) => methodLikeNode(anchor))
  const hasExactMethodAnchor = anchors.some((anchor, index) => {
    const node = anchorNodes[index]
    return node !== undefined
      && methodLikeNode(node)
      && (anchor.reason === 'symbol mention' || anchor.reason === 'path mention')
  })
  const pipelinePrompt = promptWantsRuntimePipeline(prompt)

  if (!hasMethodAnchor && !pipelinePrompt) {
    return base
  }

  if (hasExactMethodAnchor && pipelinePrompt) {
    return {
      ...base,
      backward_relations: new Set(['controller_route', 'route_handler', 'method']),
      forward_relations: new Set(['calls']),
      helper_relations: new Set([
        ...base.helper_relations,
        'injects',
        'depends_on',
        'module_provides',
      ]),
      backward_depth: 1,
      forward_depth: Math.max(base.forward_depth, 4),
      runtime_flow_only: true,
    }
  }

  const forwardRelations = new Set(base.forward_relations)
  if (hasMethodAnchor) {
    forwardRelations.delete('contains')
    forwardRelations.delete('method')
  }

  const helperRelations = new Set(base.helper_relations)
  if (pipelinePrompt) {
    helperRelations.add('injects')
    helperRelations.add('depends_on')
    helperRelations.add('module_provides')
  }

  return {
    ...base,
    forward_relations: forwardRelations,
    helper_relations: helperRelations,
    backward_depth: pipelinePrompt ? Math.max(base.backward_depth, 3) : base.backward_depth,
    forward_depth: pipelinePrompt ? Math.max(base.forward_depth, 3) : base.forward_depth,
  }
}

function isBarrelLike(label: string, sourceFile: string): boolean {
  return label.trim().toLowerCase() === 'index.ts' || /(?:^|\/)index\.ts$/i.test(sourceFile)
}

function shouldSuppressNode(
  graph: KnowledgeGraph,
  node: SliceScoredNode,
  anchoredIds: ReadonlySet<string>,
  options: SliceOptions,
): boolean {
  if (anchoredIds.has(node.id)) {
    return false
  }

  const sourceDomain = classifySourceDomain(node.sourceFile, options.rootPath)
  if ((options.excludedDomains ?? []).includes(sourceDomain)) {
    return true
  }
  if (isPollutedSourcePath(node.sourceFile, options.rootPath)) {
    return true
  }
  const comparableSourceFile = relativizeSourceFile(node.sourceFile, options.rootPath).toLowerCase()
  const excludedTerms = [...(options.excludedTerms ?? []), ...(options.excludedPathHints ?? [])].map((term) => term.toLowerCase())
  if (excludedTerms.some((term) => node.label.toLowerCase().includes(term) || comparableSourceFile.includes(term))) {
    return true
  }

  if (isBarrelLike(node.label, node.sourceFile)) {
    return true
  }

  return graph.degree(node.id) >= 40
}

function buildAnchors(scored: readonly SliceScoredNode[]): ContextPackSliceAnchor[] {
  const anchors: ContextPackSliceAnchor[] = []
  const seen = new Set<string>()
  const matchedAnchors = scored.filter((node) => node.exactLabelMatch || node.sourcePathMatch)
  const exactMethodAnchors = matchedAnchors.filter((node) => node.exactLabelMatch && methodLikeNode(node))
  const nonBarrelMatchedAnchors = matchedAnchors.filter((node) => !isBarrelLike(node.label, node.sourceFile))
  const anchorPool = exactMethodAnchors.length > 0
    ? exactMethodAnchors.slice(0, 1)
    : matchedAnchors.length > 0
    ? (nonBarrelMatchedAnchors.length > 0 ? nonBarrelMatchedAnchors : matchedAnchors)
    : scored.filter((node) => !isBarrelLike(node.label, node.sourceFile)).slice(0, 1)

  for (const node of anchorPool) {
    const reason = node.exactLabelMatch
      ? 'symbol mention'
      : node.literalPathMatch
        ? 'path mention'
        : node.sourcePathMatch
          ? 'source path token match'
        : 'top lexical match'
    if (!reason || seen.has(node.id)) {
      continue
    }
    anchors.push({
      node_id: node.id,
      label: node.label,
      reason,
    })
    seen.add(node.id)
    if (anchors.length >= 2) {
      break
    }
  }

  return anchors
}

function recordPath(
  paths: ContextPackSlicePath[],
  seen: Set<string>,
  path: ContextPackSlicePath,
): void {
  const key = `${path.direction}:${path.from_id ?? path.from}:${path.relation}:${path.to_id ?? path.to}`
  if (seen.has(key)) {
    return
  }
  seen.add(key)
  paths.push(path)
}

function traverseDirection(
  graph: KnowledgeGraph,
  scoredById: Map<string, SliceScoredNode>,
  anchorIds: readonly string[],
  selectedIds: Set<string>,
  orderedIds: string[],
  pathSeen: Set<string>,
  selectedPaths: ContextPackSlicePath[],
  anchoredIds: ReadonlySet<string>,
  options: SliceOptions,
  direction: 'forward' | 'backward',
  relations: ReadonlySet<string>,
  maxDepth: number,
  runtimeFlowOnly: boolean = false,
  anchorMethodNames: ReadonlySet<string> = new Set(),
): void {
  const queue = anchorIds.map((id) => ({ id, depth: 0 }))
  const seen = new Set<string>(anchorIds)
  const depths = new Map<string, number>(anchorIds.map((id) => [id, 0]))

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.depth >= maxDepth) {
      continue
    }

    const currentNode = scoredById.get(current.id) ?? sliceNodeFromGraph(graph, current.id)
    scoredById.set(current.id, currentNode)
    if (
      direction === 'forward'
      && runtimeFlowOnly
      && current.depth > 0
      && !shouldExpandRuntimePathNode(graph, currentNode, anchorMethodNames)
    ) {
      continue
    }

    const neighbors = direction === 'forward' ? graph.successors(current.id) : graph.predecessors(current.id)
    for (const neighborId of neighbors) {
      const sourceId = direction === 'forward' ? current.id : neighborId
      const targetId = direction === 'forward' ? neighborId : current.id
      const relation = String(graph.edgeAttributes(sourceId, targetId).relation ?? 'related_to')
      if (!relations.has(relation)) {
        continue
      }

      const neighborDepth = depths.get(neighborId)
      if (neighborDepth !== undefined && neighborDepth <= current.depth) {
        continue
      }

      const neighbor = scoredById.get(neighborId) ?? sliceNodeFromGraph(graph, neighborId)
      scoredById.set(neighborId, neighbor)
      if (shouldSuppressNode(graph, neighbor, anchoredIds, options)) {
        continue
      }

      if (!selectedIds.has(neighborId)) {
        selectedIds.add(neighborId)
        orderedIds.push(neighborId)
      }

      recordPath(selectedPaths, pathSeen, {
        from_id: sourceId,
        from: direction === 'forward' ? currentNode?.label ?? sourceId : neighbor.label,
        to_id: targetId,
        to: direction === 'forward' ? neighbor.label : currentNode?.label ?? targetId,
        relation,
        direction,
      })

      if (!seen.has(neighborId)) {
        seen.add(neighborId)
        depths.set(neighborId, current.depth + 1)
        queue.push({ id: neighborId, depth: current.depth + 1 })
      }
    }
  }
}

function pipelineBridgeLikeNode(node: SliceScoredNode): boolean {
  const lower = `${node.label} ${node.frameworkRole ?? ''} ${node.sourceFile}`.toLowerCase()
  return /\bpipeline|trigger|queue|job|worker|orchestrator|planner|research|agent|scoring|report|repository|persistence|save|process|search|score|addjob\b/.test(lower)
}

function highValueRuntimeExpansionNode(node: SliceScoredNode): boolean {
  const lower = `${node.label} ${node.frameworkRole ?? ''} ${node.sourceFile}`.toLowerCase()
  return /\bpipeline|trigger|worker|orchestrator|planner|research|agent|scoring|report|repository|persistence|save|process|search|score|dispatch|assemble|persist|builder\b/.test(lower)
}

function sharedHubLikeNode(graph: KnowledgeGraph, node: SliceScoredNode): boolean {
  const lower = `${node.label} ${node.frameworkRole ?? ''}`.toLowerCase()
  return graph.degree(node.id) >= 12
    || /requireideasuserid|addjob|callllm|resolve|logger|\.info\(\)|\.error\(\)|\.warn\(\)|planenforcement/.test(lower)
}

function shouldExpandRuntimePathNode(
  graph: KnowledgeGraph,
  node: SliceScoredNode,
  anchorMethodNames: ReadonlySet<string>,
): boolean {
  if (sharedHubLikeNode(graph, node) && !highValueRuntimeExpansionNode(node)) {
    return false
  }

  if (highValueRuntimeExpansionNode(node)) {
    return true
  }

  const methodName = methodNameFromLabel(node.label)
  if (methodName && anchorMethodNames.has(methodName)) {
    return true
  }

  const role = (node.frameworkRole ?? '').toLowerCase()
  const kind = (node.nodeKind ?? '').toLowerCase()
  if (role.includes('controller') || role.includes('route') || kind === 'class') {
    return false
  }

  return false
}

function addHelperNeighbors(
  graph: KnowledgeGraph,
  scoredById: Map<string, SliceScoredNode>,
  helperRelations: ReadonlySet<string>,
  selectedIds: Set<string>,
  orderedIds: string[],
  pathSeen: Set<string>,
  selectedPaths: ContextPackSlicePath[],
  anchoredIds: ReadonlySet<string>,
  options: SliceOptions,
): void {
  for (const currentId of [...orderedIds]) {
    const currentNode = scoredById.get(currentId)
    if (!currentNode) {
      continue
    }

    for (const neighborId of graph.successors(currentId)) {
      const relation = String(graph.edgeAttributes(currentId, neighborId).relation ?? 'related_to')
      if (!helperRelations.has(relation)) {
        continue
      }

      const neighbor = scoredById.get(neighborId) ?? sliceNodeFromGraph(graph, neighborId)
      scoredById.set(neighborId, neighbor)
      if (shouldSuppressNode(graph, neighbor, anchoredIds, options)) {
        continue
      }

      if (!selectedIds.has(neighborId)) {
        selectedIds.add(neighborId)
        orderedIds.push(neighborId)
      }

      recordPath(selectedPaths, pathSeen, {
        from_id: currentId,
        from: currentNode.label,
        to_id: neighborId,
        to: neighbor.label,
        relation,
        direction: 'forward',
      })
    }
  }
}

function addAnchorPredecessors(
  graph: KnowledgeGraph,
  scoredById: Map<string, SliceScoredNode>,
  anchorIds: readonly string[],
  selectedIds: Set<string>,
  orderedIds: string[],
  pathSeen: Set<string>,
  selectedPaths: ContextPackSlicePath[],
  anchoredIds: ReadonlySet<string>,
  options: SliceOptions,
  relations: ReadonlySet<string>,
): void {
  for (const anchorId of anchorIds) {
    const anchorNode = scoredById.get(anchorId) ?? sliceNodeFromGraph(graph, anchorId)
    scoredById.set(anchorId, anchorNode)

    for (const predecessorId of graph.predecessors(anchorId)) {
      const relation = String(graph.edgeAttributes(predecessorId, anchorId).relation ?? 'related_to')
      if (!relations.has(relation)) {
        continue
      }

      const predecessor = scoredById.get(predecessorId) ?? sliceNodeFromGraph(graph, predecessorId)
      scoredById.set(predecessorId, predecessor)
      if (shouldSuppressNode(graph, predecessor, anchoredIds, options)) {
        continue
      }

      if (!selectedIds.has(predecessorId)) {
        selectedIds.add(predecessorId)
        orderedIds.push(predecessorId)
      }

      recordPath(selectedPaths, pathSeen, {
        from_id: predecessorId,
        from: predecessor.label,
        to_id: anchorId,
        to: anchorNode.label,
        relation,
        direction: 'backward',
      })
    }
  }
}

export function sliceCandidatesForRetrieve(
  graph: KnowledgeGraph,
  scoredCandidates: readonly SliceScoredNode[],
  intent: RetrievalIntent,
  options: SliceOptions = {},
): { ordered_ids: string[]; metadata: ContextPackSliceMetadata } | null {
  if (scoredCandidates.length === 0) {
    return null
  }

  const anchors = buildAnchors(scoredCandidates)
  if (anchors.length === 0) {
    return null
  }

  const anchorNodes = anchors
    .map((anchor) => scoredCandidates.find((candidate) => candidate.id === anchor.node_id))
    .filter((candidate): candidate is SliceScoredNode => candidate !== undefined)
  const policy = effectivePolicy(intent, anchors, anchorNodes, options.prompt)
  const anchorIds = anchors.map((anchor) => anchor.node_id).filter((id): id is string => typeof id === 'string')
  const orderedIds = [...anchorIds]
  const selectedIds = new Set(anchorIds)
  const anchoredIds = new Set(anchorIds)
  const scoredById = new Map(scoredCandidates.map((candidate) => [candidate.id, candidate]))
  const selectedPaths: ContextPackSlicePath[] = []
  const pathSeen = new Set<string>()
  const anchorMethodNames = new Set(
    anchors
      .map((anchor) => methodNameFromLabel(anchor.label))
      .filter((methodName): methodName is string => typeof methodName === 'string' && methodName.length > 0),
  )

  if (policy.directions.includes('backward')) {
    traverseDirection(
      graph,
      scoredById,
      anchorIds,
      selectedIds,
      orderedIds,
      pathSeen,
      selectedPaths,
      anchoredIds,
      options,
      'backward',
      policy.backward_relations,
      policy.backward_depth,
      false,
      anchorMethodNames,
    )

    addAnchorPredecessors(
      graph,
      scoredById,
      anchorIds,
      selectedIds,
      orderedIds,
      pathSeen,
      selectedPaths,
      anchoredIds,
      options,
      policy.backward_relations,
    )
  }

  if (policy.directions.includes('forward')) {
    traverseDirection(
      graph,
      scoredById,
      anchorIds,
      selectedIds,
      orderedIds,
      pathSeen,
      selectedPaths,
      anchoredIds,
      options,
      'forward',
      policy.forward_relations,
      policy.forward_depth,
      policy.runtime_flow_only === true,
      anchorMethodNames,
    )
  }

  addHelperNeighbors(
    graph,
    scoredById,
    policy.helper_relations,
    selectedIds,
    orderedIds,
    pathSeen,
    selectedPaths,
    anchoredIds,
    options,
  )

  return {
    ordered_ids: orderedIds,
    metadata: {
      mode: policy.mode,
      anchors,
      directions: policy.directions,
      selected_paths: selectedPaths,
    },
  }
}
