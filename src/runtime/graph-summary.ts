import { KnowledgeGraph } from '../contracts/graph.js'
import { communitiesFromGraph, communityLabelsFromGraph } from './serve.js'

const SUMMARY_ARRAY_CAP = 10

const ENTRY_NODE_KINDS = new Set(['route', 'router', 'controller', 'page', 'layout', 'middleware'])
const ENTRY_FRAMEWORK_ROLE_HINTS = ['route', 'router', 'controller', 'page', 'layout', 'middleware', 'app', 'plugin', 'procedure']
const RUNTIME_METADATA_KEYS = ['route_path', 'mount_path', 'procedure_name', 'router_name'] as const

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
  frameworks: string[]
  top_modules: GraphSummaryTopModule[]
  entrypoints: GraphSummaryEntrypoint[]
  runtime_paths: GraphSummaryRuntimePath[]
}

type NodeSummary = {
  id: string
  label: string
  sourceFile: string
  degree: number
  predecessors: string[]
  successors: string[]
  explicitEntrySignal: boolean
  runtimeEligible: boolean
  sourceDomain: string
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
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

function normalizedFramework(attributes: Record<string, unknown>): string {
  const framework = normalizeString(attributes.framework).toLowerCase()
  if (framework.length > 0) {
    return framework
  }

  const frameworkRole = normalizeString(attributes.framework_role).toLowerCase()
  if (frameworkRole.startsWith('express_')) return 'express'
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
  const label = normalizeString(attributes.label)
  if (label.length > 0) {
    return label
  }

  const sourceFile = normalizeString(attributes.source_file)
  if (sourceFile.length > 0) {
    return sourceFile
  }

  const community = attributes.community
  if (typeof community === 'number' && Number.isFinite(community) && communityLabels[community]) {
    return communityLabels[community]!
  }
  if (typeof community === 'string' && community.trim() !== '' && !Number.isNaN(Number(community)) && communityLabels[Number(community)]) {
    return communityLabels[Number(community)]!
  }

  return nodeId
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
      return runtimePredecessors.length === 0 || node.explicitEntrySignal
    })
}

function shortestRuntimeDistances(graph: KnowledgeGraph, startId: string, runtimeNodeIds: ReadonlySet<string>): Map<string, number> {
  const distances = new Map<string, number>([[startId, 0]])
  const queue = [startId]

  while (queue.length > 0) {
    const nodeId = queue.shift()
    if (!nodeId) {
      continue
    }

    const distance = distances.get(nodeId)
    if (distance === undefined) {
      continue
    }

    for (const neighbor of graph.successors(nodeId)) {
      if (!runtimeNodeIds.has(neighbor) || distances.has(neighbor)) {
        continue
      }
      distances.set(neighbor, distance + 1)
      queue.push(neighbor)
    }
  }

  return distances
}

function runtimePaths(graph: KnowledgeGraph, nodes: readonly NodeSummary[]): GraphSummaryRuntimePath[] {
  const runtimeNodeIds = new Set(nodes.filter((node) => node.runtimeEligible).map((node) => node.id))
  const nodeMap = new Map(nodes.map((node) => [node.id, node] as const))
  const paths = new Map<string, GraphSummaryRuntimePath>()

  for (const start of runtimeEntryCandidates(nodes)) {
    const distances = shortestRuntimeDistances(graph, start.id, runtimeNodeIds)
    const terminals = [...distances.entries()]
      .filter(([nodeId, hops]) => nodeId !== start.id && hops > 0)
      .filter(([nodeId]) => graph.successors(nodeId).filter((neighbor) => runtimeNodeIds.has(neighbor)).length === 0)
      .map(([nodeId, hops]) => ({
        node: nodeMap.get(nodeId),
        hops,
      }))
      .filter((entry): entry is { node: NodeSummary; hops: number } => entry.node !== undefined)
      .sort((left, right) => right.hops - left.hops
        || left.node.label.localeCompare(right.node.label)
        || left.node.sourceFile.localeCompare(right.node.sourceFile))

    const best = terminals[0]
    if (!best) {
      continue
    }

    const path = {
      from: start.label,
      to: best.node.label,
      hops: best.hops,
    }
    paths.set(`${path.from}\u0000${path.to}`, path)
  }

  return sortedBounded(
    [...paths.values()],
    (left, right) => left.from.localeCompare(right.from)
      || left.to.localeCompare(right.to)
      || left.hops - right.hops,
  )
}

export function buildGraphSummary(graph: KnowledgeGraph): GraphSummary {
  const communities = communitiesFromGraph(graph)
  const communityLabels = communityLabelsFromGraph(graph, communities)
  const nodes = buildNodeSummaries(graph, communityLabels)
  const fileCount = new Set(nodes.map((node) => node.sourceFile).filter((sourceFile) => sourceFile.length > 0)).size
  const summary: GraphSummary = {
    node_count: graph.numberOfNodes(),
    edge_count: graph.numberOfEdges(),
    file_count: fileCount,
    community_count: Object.keys(communities).length,
    source_domains: collectSourceDomains(graph),
    frameworks: collectFrameworks(graph),
    top_modules: topModules(nodes),
    entrypoints: entrypoints(graph, nodes),
    runtime_paths: runtimePaths(graph, nodes),
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
