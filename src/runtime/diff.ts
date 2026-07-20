import type { KnowledgeGraph } from '../domain/graph/directed-multigraph.js'
import { graphDiff } from '../pipeline/analyze.js'

const DEFAULT_GRAPH_DIFF_LIMIT = 10

interface GraphDiffEdgeLike {
  id: string
  source: string
  target: string
  relation: string
  confidence: string
  attributes: Record<string, unknown>
}

interface GraphDiffNodeLike {
  id: string
  label: string
}

export interface GraphDiffFormatOptions {
  limit?: number
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function resolvedLimit(limit?: number): number {
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_GRAPH_DIFF_LIMIT
}

function formatNode(graph: KnowledgeGraph, node: GraphDiffNodeLike): string {
  const label = graph.hasNode(node.id) ? String(graph.nodeAttributes(node.id).label ?? node.label ?? node.id) : node.label || node.id
  return `${label} [${node.id}]`
}

function formatEdge(graph: KnowledgeGraph, edge: GraphDiffEdgeLike): string {
  const sourceLabel = graph.hasNode(edge.source) ? String(graph.nodeAttributes(edge.source).label ?? edge.source) : edge.source
  const targetLabel = graph.hasNode(edge.target) ? String(graph.nodeAttributes(edge.target).label ?? edge.target) : edge.target
  const confidence = edge.confidence ? ` [${edge.confidence}]` : ''
  return `${sourceLabel} --${edge.relation}${confidence}--> ${targetLabel} [edge ${edge.id}] evidence=${JSON.stringify(edge.attributes.evidence ?? null)} provenance=${JSON.stringify(edge.attributes.provenance ?? [])}`
}

function sectionHeading(title: string, total: number, limit: number): string {
  return total > limit ? `${title} (showing ${limit} of ${total}):` : `${title} (${total}):`
}

function formatNodeSection(title: string, nodes: GraphDiffNodeLike[], graph: KnowledgeGraph, limit: number): string[] {
  if (nodes.length === 0) {
    return []
  }

  return [sectionHeading(title, nodes.length, limit), ...nodes.slice(0, limit).map((node) => `  - ${formatNode(graph, node)}`)]
}

function formatEdgeSection(title: string, edges: GraphDiffEdgeLike[], graph: KnowledgeGraph, limit: number): string[] {
  if (edges.length === 0) {
    return []
  }

  return [sectionHeading(title, edges.length, limit), ...edges.slice(0, limit).map((edge) => `  - ${formatEdge(graph, edge)}`)]
}

export function diffGraphs(baselineGraph: KnowledgeGraph, currentGraph: KnowledgeGraph, options: GraphDiffFormatOptions = {}): string {
  const limit = resolvedLimit(options.limit)
  const diff = graphDiff(baselineGraph, currentGraph)
  const lines = [
    `Graph diff: ${diff.summary}`,
    `Before: ${pluralize(baselineGraph.numberOfNodes(), 'node')}, ${pluralize(baselineGraph.numberOfEdges(), 'edge')}`,
    `After: ${pluralize(currentGraph.numberOfNodes(), 'node')}, ${pluralize(currentGraph.numberOfEdges(), 'edge')}`,
  ]

  const sections = [
    ...formatNodeSection('New nodes', diff.new_nodes, currentGraph, limit),
    ...formatEdgeSection('New edges', diff.new_edges, currentGraph, limit),
    ...formatNodeSection('Removed nodes', diff.removed_nodes, baselineGraph, limit),
    ...formatEdgeSection('Removed edges', diff.removed_edges, baselineGraph, limit),
  ]

  if (sections.length === 0) {
    lines.push('No node or edge changes detected.')
    return lines.join('\n')
  }

  return `${lines.join('\n')}\n\n${sections.join('\n')}`
}
