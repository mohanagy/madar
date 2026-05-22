import { KnowledgeGraph } from '../contracts/graph.js'
import type { ExtractionData, ExtractionSchemaVersion } from '../contracts/types.js'
import { validateExtraction } from '../contracts/extraction.js'
import { normalizeExtractionData } from '../core/schema/normalize.js'
import { isRecord } from '../shared/guards.js'

type CombinedExtraction = {
  schema_version: ExtractionSchemaVersion
  nodes: ExtractionData['nodes']
  edges: ExtractionData['edges']
  hyperedges: NonNullable<ExtractionData['hyperedges']>
  input_tokens: number
  output_tokens: number
}

function mergeSchemaVersion(current: ExtractionData['schema_version'], next: ExtractionData['schema_version']): ExtractionSchemaVersion {
  if (current === 2 || next === 2) {
    return 2
  }

  return 1
}

export interface BuildGraphOptions {
  directed?: boolean
  validateExtraction?: boolean
}

type BuildableExtraction = {
  nodes: ExtractionData['nodes']
  edges: ExtractionData['edges']
  schema_version?: ExtractionData['schema_version']
  hyperedges?: ExtractionData['hyperedges']
  input_tokens?: number
  output_tokens?: number
}

function derivedEdgeConfidenceScore(attributes: Record<string, unknown>): number | undefined {
  if (typeof attributes.confidence_score === 'number' && Number.isFinite(attributes.confidence_score)) {
    return attributes.confidence_score
  }

  const confidence = typeof attributes.confidence === 'string' ? attributes.confidence : undefined
  switch (confidence) {
    case 'AMBIGUOUS':
      return 0.2
    case 'INFERRED':
      return 0.5
    case 'EXTRACTED':
      return 1
    default:
      return undefined
  }
}

export function buildFromJson(extraction: unknown, options: BuildGraphOptions = {}): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: options.directed === true })
  if (!isRecord(extraction)) {
    return graph
  }

  const normalized = normalizeExtractionData(extraction)
  if (options.validateExtraction !== false) {
    const errors = validateExtraction(extraction)
    const nonDanglingErrors = errors.filter((error) => !error.includes('does not match any node id'))

    if (nonDanglingErrors.length > 0) {
      console.warn(`[madar] Extraction warning (${nonDanglingErrors.length} issues): ${nonDanglingErrors[0]}`)
    }

    const normalizedErrors = validateExtraction(normalized)
    const postNormalizationErrors = normalizedErrors
      .filter((error) => !errors.includes(error))
      .filter((error) => !error.includes('does not match any node id'))

    if (postNormalizationErrors.length > 0) {
      console.warn(`[madar] Normalization warning (${postNormalizationErrors.length} issues): ${postNormalizationErrors[0]}`)
    }
  }

  const nodes = normalized.nodes
  for (const node of nodes) {
    const { id, ...attributes } = node
    if (typeof id === 'string') {
      graph.addNode(id, attributes)
    }
  }

  const nodeIds = new Set(graph.nodeIds())
  const edges = normalized.edges
  for (const edge of edges) {
    const source = typeof edge.source === 'string' ? edge.source : null
    const target = typeof edge.target === 'string' ? edge.target : null
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) {
      continue
    }

    const { source: _source, target: _target, ...attributes } = edge
    const confidenceScore = derivedEdgeConfidenceScore(attributes)
    graph.addEdge(source, target, {
      ...attributes,
      ...(confidenceScore !== undefined ? { confidence_score: confidenceScore } : {}),
      _src: source,
      _tgt: target,
    })
  }

  const hyperedges = normalized.hyperedges
  if (hyperedges.length > 0) {
    graph.graph.hyperedges = hyperedges
  }
  graph.graph.schema_version = normalized.schema_version
  graph.graph.directed = graph.isDirected()
  if (typeof extraction.root_path === 'string' && extraction.root_path.trim().length > 0) {
    graph.graph.root_path = extraction.root_path
  }

  return graph
}

export function build(extractions: BuildableExtraction[], options: BuildGraphOptions = {}): KnowledgeGraph {
  const combined: CombinedExtraction = {
    schema_version: 1,
    nodes: [],
    edges: [],
    hyperedges: [],
    input_tokens: 0,
    output_tokens: 0,
  }

  for (const extraction of extractions) {
    combined.schema_version = mergeSchemaVersion(combined.schema_version, extraction.schema_version)
    combined.nodes.push(...extraction.nodes)
    combined.edges.push(...extraction.edges)
    combined.hyperedges.push(...(extraction.hyperedges ?? []))
    combined.input_tokens += typeof extraction.input_tokens === 'number' ? extraction.input_tokens : 0
    combined.output_tokens += typeof extraction.output_tokens === 'number' ? extraction.output_tokens : 0
  }

  return buildFromJson(combined, options)
}
