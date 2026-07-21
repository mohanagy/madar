import { KnowledgeGraph } from '../domain/graph/directed-multigraph.js'
import { sanitizeLabel } from '../shared/security.js'
import { communitiesFromGraph, communityLabelsFromGraph } from './serve.js'

const SUMMARY_ARRAY_CAP = 10

const ENTRY_NODE_KINDS = new Set(['route', 'router', 'controller', 'page', 'layout', 'middleware'])
const ENTRY_FRAMEWORK_ROLE_HINTS = ['route', 'router', 'controller', 'page', 'layout', 'middleware', 'app', 'plugin', 'procedure']
const RUNTIME_METADATA_KEYS = ['route_path', 'mount_path', 'procedure_name', 'router_name'] as const
const MAX_RUNTIME_PATH_HOPS = 6
const RELATION_QUALITY_SCORES: Record<string, number> = {
  enqueues_job: 5,
  controller_route: 4,
  route_handler: 4,
  calls: 4,
  method: 3,
  registers_controller: 2,
  guarded_by: 1,
  uses_authorization: 1,
  uses_middleware: 1,
  intercepts: 1,
}

export interface GraphSummaryTopModule {
  label: string
  degree: number
}

export interface GraphSummaryEntrypoint {
  label: string
  source_file: string
}

export interface GraphSummaryRuntimePath {
  from: string
  to: string
  hops: number
}

export interface GraphSummary {
  graph_version?: string
  generated_at?: string
  node_count: number
  edge_count: number
  file_count: number
  community_count: number
  source_domains: Record<string, number>
  source_domains_status?: 'not_detected'
  source_domains_reason?: string
  frameworks: string[]
  top_modules: GraphSummaryTopModule[]
  entrypoints: GraphSummaryEntrypoint[]
  runtime_paths: GraphSummaryRuntimePath[]
  runtime_paths_status?: 'not_detected'
  runtime_paths_reason?: string
}

type NodeSummary = {
  id: string
  label: string
  sourceFile: string
  degree: number
  predecessors: string[]
  successors: string[]
  explicitEntrySignal: boolean
  runtimeStartSignal: boolean
  runtimeEligible: boolean
  sourceDomain: string
}

type RuntimeTraversal = {
  hops: number
  relationScore: number
  minDomainScore: number
}

type RuntimePathCandidate = {
  path: GraphSummaryRuntimePath
  fromSourceFile: string
  toSourceFile: string
  startScore: number
  entryScore: number
  minDomainScore: number
  relationScore: number
  terminalScore: number
  hopScore: number
  helperPair: boolean
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeLabel(value: unknown): string {
  return sanitizeLabel(normalizeString(value)).trim()
}

function normalizeBoolean(value: unknown): boolean {
  return value === true
}

function frameworkMetadata(attributes: Record<string, unknown>): Record<string, unknown> {
  const metadata = attributes.framework_metadata
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {}
}

function frameworkMetadataString(attributes: Record<string, unknown>, key: (typeof RUNTIME_METADATA_KEYS)[number]): string {
  const direct = normalizeString(attributes[key])
  if (direct.length > 0) {
    return direct
  }
  return normalizeString(frameworkMetadata(attributes)[key])
}

function isCodeLikeNode(attributes: Record<string, unknown>): boolean {
  const fileType = normalizeString(attributes.file_type).toLowerCase()
  return fileType.length === 0 || fileType === 'code'
}

function isExplicitEntrypoint(attributes: Record<string, unknown>): boolean {
  const nodeKind = normalizeString(attributes.node_kind).toLowerCase()
  if (ENTRY_NODE_KINDS.has(nodeKind)) {
    return true
  }

  const frameworkRole = normalizeString(attributes.framework_role).toLowerCase()
  if (frameworkRole.length > 0 && ENTRY_FRAMEWORK_ROLE_HINTS.some((hint) => frameworkRole.includes(hint))) {
    return true
  }

  return RUNTIME_METADATA_KEYS.some((key) => frameworkMetadataString(attributes, key).length > 0)
}

function normalizedRuntimeStartText(...values: unknown[]): string {
  return values
    .map(normalizeString)
    .join(' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function isExplicitRuntimeStart(attributes: Record<string, unknown>): boolean {
  if (isExplicitEntrypoint(attributes)) {
    return true
  }

  const roleText = normalizedRuntimeStartText(
    attributes.node_kind,
    attributes.framework_role,
  )
  if (/\b(worker|processor|consumer|queue consumer|event handler|job|task)\b/.test(roleText)) {
    return true
  }

  const nodeText = normalizedRuntimeStartText(
    attributes.label,
    attributes.source_file,
  )
  if (/\b(worker|processor|consumer|queue consumer|event handler)\b/.test(nodeText)) {
    return true
  }

  const sourceFileText = normalizedRuntimeStartText(attributes.source_file)
  return /\bjobs?\b|\btasks?\b/.test(sourceFileText)
}

function normalizedFramework(attributes: Record<string, unknown>): string {
  const framework = normalizeString(attributes.framework).toLowerCase()
  if (framework.length > 0) {
    return framework
  }

  const frameworkRole = normalizeString(attributes.framework_role).toLowerCase()
  if (frameworkRole.startsWith('express_')) return 'express'
  if (frameworkRole.startsWith('routing_controllers_')) return 'routing-controllers'
  if (frameworkRole.startsWith('react_router_')) return 'react-router'
  if (frameworkRole.startsWith('redux_')) return 'redux-toolkit'
  if (frameworkRole.startsWith('nest_')) return 'nestjs'
  if (frameworkRole.startsWith('nextjs_') || frameworkRole.startsWith('next_')) return 'nextjs'
  if (frameworkRole.startsWith('hono_')) return 'hono'
  if (frameworkRole.startsWith('fastify_')) return 'fastify'
  if (frameworkRole.startsWith('trpc_')) return 'trpc'
  if (frameworkRole.startsWith('prisma_')) return 'prisma'
  return ''
}

function nodeLabel(graph: KnowledgeGraph, nodeId: string, communityLabels: Record<number, string>): string {
  const attributes = graph.nodeAttributes(nodeId)
  const label = normalizeLabel(attributes.label)
  if (label.length > 0) {
    return label
  }

  const sourceFile = normalizeLabel(attributes.source_file)
  if (sourceFile.length > 0) {
    return sourceFile
  }

  const community = attributes.community
  if (typeof community === 'number' && Number.isFinite(community) && communityLabels[community]) {
    return normalizeLabel(communityLabels[community]!)
  }
  if (typeof community === 'string' && community.trim() !== '' && !Number.isNaN(Number(community)) && communityLabels[Number(community)]) {
    return normalizeLabel(communityLabels[Number(community)]!)
  }

  return normalizeLabel(nodeId)
}

function buildNodeSummaries(graph: KnowledgeGraph, communityLabels: Record<number, string>): NodeSummary[] {
  return graph.nodeEntries().map(([nodeId, attributes]) => {
    const sourceDomain = normalizeString(attributes.source_domain).toLowerCase()
    const runtimeEligible = isCodeLikeNode(attributes) && sourceDomain !== 'test' && sourceDomain !== 'docs'
    return {
      id: nodeId,
      label: nodeLabel(graph, nodeId, communityLabels),
      sourceFile: normalizeString(attributes.source_file),
      degree: graph.degree(nodeId),
      predecessors: graph.predecessors(nodeId),
      successors: graph.successors(nodeId),
      explicitEntrySignal: isExplicitEntrypoint(attributes),
      runtimeStartSignal: isExplicitRuntimeStart(attributes),
      runtimeEligible,
      sourceDomain,
    }
  })
}

function sortedBounded<T>(values: readonly T[], compare: (left: T, right: T) => number): T[] {
  return [...values].sort(compare).slice(0, SUMMARY_ARRAY_CAP)
}

function collectSourceDomains(graph: KnowledgeGraph): Record<string, number> {
  const counts = new Map<string, number>()
  for (const [, attributes] of graph.nodeEntries()) {
    const domain = normalizeString(attributes.source_domain).toLowerCase()
    if (domain.length === 0) {
      continue
    }
    counts.set(domain, (counts.get(domain) ?? 0) + 1)
  }

  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

function collectFrameworks(graph: KnowledgeGraph): string[] {
  const frameworks = new Set<string>()
  for (const [, attributes] of graph.nodeEntries()) {
    const framework = normalizedFramework(attributes)
    if (framework.length > 0) {
      frameworks.add(framework)
    }
  }
  return sortedBounded([...frameworks], (left, right) => left.localeCompare(right))
}

function topModules(nodes: readonly NodeSummary[]): GraphSummaryTopModule[] {
  return sortedBounded(
    nodes.filter((node) => node.label.length > 0),
    (left, right) => right.degree - left.degree
      || left.label.localeCompare(right.label)
      || left.sourceFile.localeCompare(right.sourceFile),
  ).map((node) => ({ label: node.label, degree: node.degree }))
}

function entrypointScore(node: NodeSummary, exported: boolean): number {
  let score = 0
  if (node.predecessors.length === 0) {
    score += 3
  }
  if (node.explicitEntrySignal) {
    score += 4
  }
  if (exported) {
    score += 1
  }
  return score
}

function sourceDomainScore(sourceDomain: string): number {
  switch (sourceDomain) {
    case 'production':
      return 7
    case '':
    case 'unknown':
      return 6
    case 'config':
      return 5
    case 'docs':
      return 2
    case 'test':
    case 'fixture':
    case 'benchmark':
    case 'generated':
      return 0
    default:
      return 4
  }
}

function relationQualityScore(relation: unknown): number {
  const normalized = normalizeString(relation).toLowerCase()
  return RELATION_QUALITY_SCORES[normalized] ?? 1
}

function runtimeNodeText(node: NodeSummary, graph: KnowledgeGraph): string {
  const attributes = graph.nodeAttributes(node.id)
  return [
    node.label,
    node.sourceFile,
    normalizeString(attributes.node_kind),
    normalizeString(attributes.framework_role),
  ].join(' ').toLowerCase()
}

function helperEndpointPenalty(normalized: string): number {
  let score = 0
  if (/\b(helper|util|utility|dto|logger|logging|log|type|schema|constant|formatter)\b/.test(normalized)) {
    score -= 4
  }
  if (/\.(cachekey|addjob|addanalyticsjob|setcontext|info|debug|warn|warning|error|trace|build[a-z0-9_]*|calculate[a-z0-9_]*|format[a-z0-9_]*|normalize[a-z0-9_]*|sanitize[a-z0-9_]*|serialize[a-z0-9_]*)\s*\(/.test(normalized)) {
    score -= 6
  }
  return score
}

function isHelperLikeEndpoint(node: NodeSummary, graph: KnowledgeGraph): boolean {
  return helperEndpointPenalty(runtimeNodeText(node, graph)) < 0
}

function startNodeScore(node: NodeSummary, graph: KnowledgeGraph): number {
  const normalized = runtimeNodeText(node, graph)

  let score = 0
  if (node.runtimeStartSignal) {
    score += 6
  }
  if (node.predecessors.length === 0) {
    score += 2
  }
  if (/\b(route|router|controller|page|layout|middleware|procedure|endpoint|handler)\b/.test(normalized)) {
    score += 4
  }
  score += helperEndpointPenalty(normalized)
  return score
}

function terminalNodeScore(node: NodeSummary, graph: KnowledgeGraph): number {
  const normalized = runtimeNodeText(node, graph)
  const normalizedLabel = normalizeLabel(node.label).toLowerCase()

  let score = 0
  if (/\b(worker|consumer|processor|repository|repo|store|persistence|sink|database|db)\b/.test(normalized)) {
    score += 6
  }
  if (/\b(gateway|client)\b/.test(normalized)) {
    score += 3
  }
  if (/\b(queue|job)\b/.test(normalized)) {
    score += 2
  }
  if (/\b(service)\b/.test(normalized)) {
    score += 2
  }
  if (normalizedLabel === 'job' || normalizedLabel === 'queue') {
    score -= 4
  }
  score += helperEndpointPenalty(normalized)
  return score
}

function runtimeHopScore(hops: number): number {
  if (hops <= 0) {
    return 0
  }
  if (hops === 1) {
    return 1
  }
  if (hops <= 4) {
    return 3
  }
  if (hops <= MAX_RUNTIME_PATH_HOPS) {
    return 2
  }
  return 0
}

function compareNodeIdentity(left: NodeSummary, right: NodeSummary): number {
  return left.label.localeCompare(right.label)
    || left.sourceFile.localeCompare(right.sourceFile)
    || left.id.localeCompare(right.id)
}

function entrypoints(graph: KnowledgeGraph, nodes: readonly NodeSummary[]): GraphSummaryEntrypoint[] {
  return sortedBounded(
    nodes
      .filter((node) => node.sourceFile.length > 0)
      .filter((node) => {
        const attributes = graph.nodeAttributes(node.id)
        return isCodeLikeNode(attributes) && entrypointScore(node, normalizeBoolean(attributes.exported)) > 0
      }),
    (left, right) => {
      const leftScore = entrypointScore(left, normalizeBoolean(graph.nodeAttributes(left.id).exported))
      const rightScore = entrypointScore(right, normalizeBoolean(graph.nodeAttributes(right.id).exported))
      return rightScore - leftScore
        || left.label.localeCompare(right.label)
        || left.sourceFile.localeCompare(right.sourceFile)
    },
  ).map((node) => ({
    label: node.label,
    source_file: node.sourceFile,
  }))
}

function runtimeEntryCandidates(nodes: readonly NodeSummary[]): NodeSummary[] {
  const runtimeNodeIds = new Set(nodes.filter((node) => node.runtimeEligible).map((node) => node.id))
  return nodes
    .filter((node) => node.runtimeEligible && node.successors.some((neighbor) => runtimeNodeIds.has(neighbor)))
    .filter((node) => {
      const runtimePredecessors = node.predecessors.filter((neighbor) => runtimeNodeIds.has(neighbor))
      return runtimePredecessors.length === 0 || node.runtimeStartSignal
    })
}

function strongerRuntimeTraversal(candidate: RuntimeTraversal, existing: RuntimeTraversal): boolean {
  if (candidate.hops !== existing.hops) {
    return candidate.hops < existing.hops
  }
  if (candidate.relationScore !== existing.relationScore) {
    return candidate.relationScore > existing.relationScore
  }
  if (candidate.minDomainScore !== existing.minDomainScore) {
    return candidate.minDomainScore > existing.minDomainScore
  }
  return false
}

function bestRuntimeTraversals(
  graph: KnowledgeGraph,
  start: NodeSummary,
  runtimeNodeIds: ReadonlySet<string>,
  nodeMap: ReadonlyMap<string, NodeSummary>,
): Map<string, RuntimeTraversal> {
  const traversals = new Map<string, RuntimeTraversal>([[
    start.id,
    {
      hops: 0,
      relationScore: 0,
      minDomainScore: sourceDomainScore(start.sourceDomain),
    },
  ]])
  const queue = [start.id]

  while (queue.length > 0) {
    const nodeId = queue.shift()
    if (!nodeId) {
      continue
    }

    const traversal = traversals.get(nodeId)
    if (!traversal) {
      continue
    }

    if (traversal.hops >= MAX_RUNTIME_PATH_HOPS) {
      continue
    }

    const neighbors = graph.successors(nodeId)
      .filter((neighbor) => runtimeNodeIds.has(neighbor))
      .map((neighbor) => nodeMap.get(neighbor))
      .filter((neighbor): neighbor is NodeSummary => neighbor !== undefined)
      .sort(compareNodeIdentity)

    for (const neighbor of neighbors) {
      const edgeRelationScore = Math.max(
        0,
        ...graph.relationKindsBetween(nodeId, neighbor.id).map(relationQualityScore),
      )
      const candidate: RuntimeTraversal = {
        hops: traversal.hops + 1,
        relationScore: traversal.relationScore + edgeRelationScore,
        minDomainScore: Math.min(traversal.minDomainScore, sourceDomainScore(neighbor.sourceDomain)),
      }
      const existing = traversals.get(neighbor.id)
      if (existing && !strongerRuntimeTraversal(candidate, existing)) {
        continue
      }
      traversals.set(neighbor.id, candidate)
      queue.push(neighbor.id)
    }
  }

  return traversals
}

function compareRuntimePathCandidates(left: RuntimePathCandidate, right: RuntimePathCandidate): number {
  return right.startScore - left.startScore
    || right.terminalScore - left.terminalScore
    || right.entryScore - left.entryScore
    || right.minDomainScore - left.minDomainScore
    || right.relationScore - left.relationScore
    || right.hopScore - left.hopScore
    || right.path.hops - left.path.hops
    || stableRuntimePathOrder(left) - stableRuntimePathOrder(right)
}

function runtimePathCandidate(
  graph: KnowledgeGraph,
  start: NodeSummary,
  terminal: NodeSummary,
  traversal: RuntimeTraversal,
): RuntimePathCandidate {
  const startAttributes = graph.nodeAttributes(start.id)
  return {
    path: {
      from: start.label,
      to: terminal.label,
      hops: traversal.hops,
    },
    fromSourceFile: start.sourceFile,
    toSourceFile: terminal.sourceFile,
    startScore: startNodeScore(start, graph),
    entryScore: entrypointScore(start, normalizeBoolean(startAttributes.exported)),
    minDomainScore: traversal.minDomainScore,
    relationScore: traversal.relationScore,
    terminalScore: terminalNodeScore(terminal, graph),
    hopScore: runtimeHopScore(traversal.hops),
    helperPair: isHelperLikeEndpoint(start, graph) && isHelperLikeEndpoint(terminal, graph),
  }
}

function stableRuntimePathOrder(candidate: RuntimePathCandidate): number {
  const input = [
    candidate.path.from,
    candidate.path.to,
    candidate.fromSourceFile,
    candidate.toSourceFile,
  ].join('\u0000')

  let hash = 2166136261
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function runtimePaths(graph: KnowledgeGraph, nodes: readonly NodeSummary[]): GraphSummaryRuntimePath[] {
  const runtimeNodeIds = new Set(nodes.filter((node) => node.runtimeEligible).map((node) => node.id))
  const nodeMap = new Map(nodes.map((node) => [node.id, node] as const))
  const paths = new Map<string, RuntimePathCandidate>()

  for (const start of runtimeEntryCandidates(nodes)) {
    const traversals = bestRuntimeTraversals(graph, start, runtimeNodeIds, nodeMap)
    const terminals = [...traversals.entries()]
      .filter(([nodeId, traversal]) => nodeId !== start.id && traversal.hops > 0)
      .map(([nodeId, traversal]) => ({
        node: nodeMap.get(nodeId),
        traversal,
      }))
      .filter((entry): entry is { node: NodeSummary; traversal: RuntimeTraversal } => entry.node !== undefined)
      .map(({ node, traversal }) => runtimePathCandidate(graph, start, node, traversal))
      .filter((candidate) => !candidate.helperPair)
      .sort(compareRuntimePathCandidates)

    const best = terminals[0]
    if (!best) {
      continue
    }

    const path = best.path
    const key = JSON.stringify([path.from, path.to])
    const existing = paths.get(key)
    if (!existing || compareRuntimePathCandidates(best, existing) < 0) {
      paths.set(key, best)
    }
  }

  return sortedBounded(
    [...paths.values()],
    compareRuntimePathCandidates,
  ).map((candidate) => candidate.path)
}

export function buildGraphSummary(graph: KnowledgeGraph): GraphSummary {
  const communities = communitiesFromGraph(graph)
  const communityLabels = communityLabelsFromGraph(graph, communities)
  const nodes = buildNodeSummaries(graph, communityLabels)
  const fileCount = new Set(nodes.map((node) => node.sourceFile).filter((sourceFile) => sourceFile.length > 0)).size
  const sourceDomains = collectSourceDomains(graph)
  const runtimePathsSummary = runtimePaths(graph, nodes)
  const summary: GraphSummary = {
    node_count: graph.numberOfNodes(),
    edge_count: graph.numberOfEdges(),
    file_count: fileCount,
    community_count: Object.keys(communities).length,
    source_domains: sourceDomains,
    frameworks: collectFrameworks(graph),
    top_modules: topModules(nodes),
    entrypoints: entrypoints(graph, nodes),
    runtime_paths: runtimePathsSummary,
  }

  if (Object.keys(sourceDomains).length === 0) {
    summary.source_domains_status = 'not_detected'
    summary.source_domains_reason = 'No source_domain tags were present on graph nodes.'
  }

  if (runtimePathsSummary.length === 0) {
    summary.runtime_paths_status = 'not_detected'
    summary.runtime_paths_reason = 'No bounded runtime path was detected from the current summary heuristics.'
  }

  const graphVersion = normalizeString(graph.graph.graph_version)
  if (graphVersion.length > 0) {
    summary.graph_version = graphVersion
  }

  const generatedAt = normalizeString(graph.graph.generated_at)
  if (generatedAt.length > 0) {
    summary.generated_at = generatedAt
  }

  return summary
}
