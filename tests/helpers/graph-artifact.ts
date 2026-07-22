import { readFileSync, writeFileSync } from 'node:fs'

import {
  deserializeGraphArtifact,
  GRAPH_ARTIFACT_VERSION,
  serializeGraphArtifact,
} from '../../src/domain/graph/artifact.js'
import { KnowledgeGraph, type GraphAttributes } from '../../src/domain/graph/directed-multigraph.js'

export interface GraphFixtureData extends GraphAttributes {
  directed?: never
  nodes?: Array<{ id: string } & GraphAttributes>
  edges?: Array<{ source: string; target: string } & GraphAttributes>
}

export interface CanonicalGraphFixtureView extends GraphAttributes {
  schema: 'madar.graph'
  version: typeof GRAPH_ARTIFACT_VERSION
  directed: true
  nodes: Array<{
    id: string
    label: string
    source_file: string
    file_type: string
  } & GraphAttributes>
  edges: Array<{
    id: string
    source: string
    target: string
    relation: string
    confidence: string
  } & GraphAttributes>
}

/**
 * Flatten the canonical artifact for extraction-behavior assertions only.
 * Artifact contract tests must inspect the real nested document instead.
 */
export function readCanonicalGraphFixture(graphPath: string): CanonicalGraphFixtureView {
  const graph = deserializeGraphArtifact(readFileSync(graphPath, 'utf8'))
  const edges: CanonicalGraphFixtureView['edges'] = graph.edgeEntries().map(([source, target, attributes, id]) => ({
    id,
    source,
    target,
    ...attributes,
    relation: String(attributes.relation),
    confidence: String(attributes.confidence ?? 'EXTRACTED'),
  }))
  return {
    ...graph.graph,
    schema: 'madar.graph',
    version: GRAPH_ARTIFACT_VERSION,
    directed: true,
    nodes: graph.nodeEntries().map(([id, attributes]) => ({
      id,
      ...attributes,
      label: String(attributes.label ?? id),
      source_file: String(attributes.source_file ?? ''),
      file_type: String(attributes.file_type ?? 'code'),
    })),
    edges,
  }
}

export function serializeCanonicalGraphFixture(data: GraphFixtureData): string {
  const {
    nodes = [],
    edges = [],
    ...metadata
  } = data
  const graph = new KnowledgeGraph(metadata)
  for (const node of nodes) {
    const { id, ...attributes } = node
    graph.addNode(id, attributes)
  }
  for (const edge of edges) {
    const { source, target, ...attributes } = edge
    graph.addEdge(source, target, attributes)
  }
  return serializeGraphArtifact(graph)
}

export function writeCanonicalGraphFixture(graphPath: string, data: GraphFixtureData): void {
  writeFileSync(graphPath, serializeCanonicalGraphFixture(data), 'utf8')
}

export function writeCanonicalGraphFixtureFromGraph(
  source: KnowledgeGraph,
  communities: Record<number, string[]>,
  graphPath: string,
  communityLabels?: Record<number, string>,
  semanticAnomalies?: unknown[],
): void {
  const communityByNode = new Map<string, number>()
  for (const [community, nodeIds] of Object.entries(communities)) {
    for (const nodeId of nodeIds) {
      communityByNode.set(nodeId, Number(community))
    }
  }

  const graph = new KnowledgeGraph({
    ...source.graph,
    ...(communityLabels ? { community_labels: communityLabels } : {}),
    ...(semanticAnomalies ? { semantic_anomalies: semanticAnomalies } : {}),
  })
  for (const [id, attributes] of source.nodeEntries()) {
    const community = communityByNode.get(id)
    graph.addNode(id, {
      ...attributes,
      ...(community === undefined ? {} : { community }),
    })
  }
  for (const [sourceId, targetId, attributes] of source.edgeEntries()) {
    graph.addEdge(sourceId, targetId, attributes)
  }
  writeFileSync(graphPath, serializeGraphArtifact(graph), 'utf8')
}

export function appendCanonicalGraphNode(
  graphPath: string,
  id: string,
  attributes: GraphAttributes,
): void {
  const graph = deserializeGraphArtifact(readFileSync(graphPath, 'utf8'))
  graph.addNode(id, attributes)
  writeFileSync(graphPath, serializeGraphArtifact(graph), 'utf8')
}

export function rewriteCanonicalGraphFixture(
  graphPath: string,
  options: {
    mapMetadata?: (metadata: GraphAttributes) => GraphAttributes
    filterNode?: (id: string, attributes: GraphAttributes) => boolean
    mapNode?: (id: string, attributes: GraphAttributes) => GraphAttributes
    filterEdge?: (source: string, target: string, attributes: GraphAttributes) => boolean
    mapEdge?: (source: string, target: string, attributes: GraphAttributes) => GraphAttributes
  },
): void {
  const original = deserializeGraphArtifact(readFileSync(graphPath, 'utf8'))
  const rewritten = new KnowledgeGraph(options.mapMetadata?.(original.graph) ?? original.graph)
  for (const [id, attributes] of original.nodeEntries()) {
    if (options.filterNode && !options.filterNode(id, attributes)) continue
    rewritten.addNode(id, options.mapNode?.(id, attributes) ?? attributes)
  }
  for (const [source, target, attributes] of original.edgeEntries()) {
    if (!rewritten.hasNode(source) || !rewritten.hasNode(target)) continue
    if (options.filterEdge && !options.filterEdge(source, target, attributes)) continue
    rewritten.addEdge(source, target, options.mapEdge?.(source, target, attributes) ?? attributes)
  }
  writeFileSync(graphPath, serializeGraphArtifact(rewritten), 'utf8')
}
