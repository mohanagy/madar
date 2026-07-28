import { canonicalJsonString, canonicalJsonValue } from './canonical-json.js'
import { KnowledgeGraph, type GraphAttributes } from './directed-multigraph.js'
export const GRAPH_ARTIFACT_SCHEMA = 'madar.graph' as const
export const GRAPH_ARTIFACT_VERSION = 2 as const
export const GRAPH_ARTIFACT_REGENERATE_MESSAGE = 'Unsupported Madar graph artifact. Run `madar generate . --update` to regenerate it.'
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function invalidArtifact(detail?: string): never { throw new Error(detail ? `${detail}. ${GRAPH_ARTIFACT_REGENERATE_MESSAGE}` : GRAPH_ARTIFACT_REGENERATE_MESSAGE) }
const hasOnlyKeys = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
export function graphArtifact(graph: KnowledgeGraph) {
  return {
    schema: GRAPH_ARTIFACT_SCHEMA,
    version: GRAPH_ARTIFACT_VERSION,
    directed: true as const,
    metadata: canonicalJsonValue(graph.graph, 'graph.metadata') as GraphAttributes,
    nodes: graph.nodeEntries().map(([id, attributes]) => ({ id, attributes })),
    edges: graph.edgeEntries().map(([source, target, attributes, id]) => ({ id, source, target, attributes })),
  }
}
export type GraphArtifact = ReturnType<typeof graphArtifact>
export const serializeGraphArtifact = (graph: KnowledgeGraph): string => `${canonicalJsonString(graphArtifact(graph), true)}\n`
export function deserializeGraphArtifact(input: string | unknown): KnowledgeGraph {
  let parsed: unknown = input
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input) }
    catch (error) { invalidArtifact(`Madar graph artifact is corrupted${error instanceof Error ? ` (${error.message})` : ''}`) }
  }
  if (!isRecord(parsed)
    || !hasOnlyKeys(parsed, ['schema', 'version', 'directed', 'metadata', 'nodes', 'edges']) || parsed.schema !== GRAPH_ARTIFACT_SCHEMA
    || parsed.version !== GRAPH_ARTIFACT_VERSION || parsed.directed !== true || !isRecord(parsed.metadata)
    || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) invalidArtifact()
  try {
    const graph = new KnowledgeGraph(parsed.metadata)
    const nodeIds = new Set<string>()
    for (const value of parsed.nodes) {
      if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'attributes']) || typeof value.id !== 'string'
        || !isRecord(value.attributes) || nodeIds.has(value.id)) {
        invalidArtifact('Madar graph artifact contains an invalid or duplicate node record')
      }
      nodeIds.add(value.id)
      graph.addNode(value.id, value.attributes)
    }
    const edgeIds = new Set<string>()
    for (const value of parsed.edges) {
      if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'source', 'target', 'attributes']) || typeof value.id !== 'string'
        || typeof value.source !== 'string' || typeof value.target !== 'string' || !isRecord(value.attributes) || edgeIds.has(value.id)) {
        invalidArtifact('Madar graph artifact contains an invalid or duplicate edge record')
      }
      edgeIds.add(value.id)
      const actualId = graph.addEdge(value.source, value.target, value.attributes)
      if (actualId !== value.id) invalidArtifact(`Graph edge identity mismatch for ${JSON.stringify(value.id)}`)
    }
    return graph
  } catch (error) {
    if (error instanceof Error && error.message.includes(GRAPH_ARTIFACT_REGENERATE_MESSAGE)) throw error
    invalidArtifact(error instanceof Error ? error.message : 'Madar graph artifact is invalid')
  }
}
