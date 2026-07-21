import type { ExtractionProvenance } from '../../core/provenance/types.js'
import type { ExtractionStrategy } from '../../contracts/indexing.js'
import { isRecord } from '../../shared/guards.js'

export type { ExtractionProvenance } from '../../core/provenance/types.js'

export const EXTRACTION_LAYERS = ['base', 'semantic', 'media'] as const

export type ExtractionLayer = (typeof EXTRACTION_LAYERS)[number]

export const DEFAULT_EXTRACTION_LAYER: ExtractionLayer = 'base'

/**
 * `paper` covers both extracted paper files and virtual citation/reference nodes.
 * Use `semantic_kind` and `virtual` to distinguish semantic graph entities from
 * top-level source files when needed.
 */
export type FileType = 'code' | 'document' | 'paper' | 'image' | 'audio' | 'video' | 'rationale'

export type Confidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'

export type ExtractionSchemaVersion = 1 | 2

export interface ExtractionNode {
  id: string
  label: string
  file_type: FileType
  source_file: string
  source_location?: string
  snippet?: string
  /** The pipeline route that emitted this graph evidence. */
  extraction_strategy?: ExtractionStrategy
  layer?: ExtractionLayer
  provenance?: ExtractionProvenance[]
  semantic_kind?: 'citation' | 'reference'
  citation_kind?: 'doi' | 'arxiv' | 'citation_key'
  citation_value?: string
  reference_index?: number
  rationale_kind?: 'docstring' | 'comment'
  node_kind?: 'component' | 'function' | 'class' | 'controller' | 'method' | 'router' | 'route' | 'slice' | 'store'
  virtual?: boolean
  [key: string]: unknown
}

export interface ExtractionEdge {
  source: string
  target: string
  relation: string
  confidence: Confidence
  source_file: string
  source_location?: string
  /** The pipeline route that emitted this graph evidence. */
  extraction_strategy?: ExtractionStrategy
  layer?: ExtractionLayer
  provenance?: ExtractionProvenance[]
  weight?: number
  [key: string]: unknown
}

export interface Hyperedge {
  id?: string
  label?: string
  nodes: string[]
  relation?: string
  confidence?: Extract<Confidence, 'EXTRACTED' | 'INFERRED'>
  confidence_score?: number
  source_file?: string
  /** The pipeline route that emitted this graph evidence. */
  extraction_strategy?: ExtractionStrategy
  layer?: ExtractionLayer
  provenance?: ExtractionProvenance[]
  [key: string]: unknown
}

export interface ExtractionData {
  schema_version?: ExtractionSchemaVersion
  nodes: ExtractionNode[]
  edges: ExtractionEdge[]
  hyperedges?: Hyperedge[]
  input_tokens?: number
  output_tokens?: number
  [key: string]: unknown
}

const VALID_FILE_TYPES = new Set<FileType>(['code', 'document', 'paper', 'image', 'audio', 'video', 'rationale'])
const VALID_CONFIDENCES = new Set<Confidence>(['EXTRACTED', 'INFERRED', 'AMBIGUOUS'])
const VALID_HYPEREDGE_CONFIDENCES = new Set<Extract<Confidence, 'EXTRACTED' | 'INFERRED'>>(['EXTRACTED', 'INFERRED'])
const VALID_SCHEMA_VERSIONS = new Set<ExtractionSchemaVersion>([1, 2])
const VALID_LAYERS = new Set<ExtractionLayer>(EXTRACTION_LAYERS)
const REQUIRED_NODE_FIELDS = ['id', 'label', 'file_type', 'source_file'] as const
const REQUIRED_EDGE_FIELDS = ['source', 'target', 'relation', 'confidence', 'source_file'] as const
const REQUIRED_HYPEREDGE_FIELDS = ['nodes'] as const

function validateSchemaVersion(data: Record<string, unknown>, errors: string[]): void {
  if (!('schema_version' in data) || data.schema_version === undefined) {
    return
  }

  if (typeof data.schema_version !== 'number' || !VALID_SCHEMA_VERSIONS.has(data.schema_version as ExtractionSchemaVersion)) {
    errors.push(`Invalid schema_version '${String(data.schema_version)}' - must be one of ${JSON.stringify([...VALID_SCHEMA_VERSIONS].sort())}`)
  }
}

function validateLayer(value: unknown, label: string, errors: string[]): void {
  if (value === undefined) {
    return
  }

  if (typeof value !== 'string' || !VALID_LAYERS.has(value as ExtractionLayer)) {
    errors.push(`${label} has invalid layer '${String(value)}' - must be one of ${JSON.stringify([...VALID_LAYERS].sort())}`)
  }
}

function validateProvenance(value: unknown, label: string, errors: string[]): void {
  if (value === undefined) {
    return
  }

  if (!Array.isArray(value)) {
    errors.push(`${label} provenance must be a list`)
    return
  }

  for (const [index, record] of value.entries()) {
    if (!isRecord(record)) {
      errors.push(`${label} provenance ${index} must be an object`)
      continue
    }

    if (typeof record.capability_id !== 'string' || record.capability_id.trim().length === 0) {
      errors.push(`${label} provenance ${index} missing required field 'capability_id'`)
    }
  }
}

export function validateExtraction(data: unknown): string[] {
  if (!isRecord(data)) {
    return ['Extraction must be a JSON object']
  }

  const errors: string[] = []
  validateSchemaVersion(data, errors)
  const nodeIds = new Set<string>()

  const nodesValue = data.nodes
  if (nodesValue === undefined) {
    errors.push("Missing required key 'nodes'")
  } else if (!Array.isArray(nodesValue)) {
    errors.push("'nodes' must be a list")
  } else {
    for (const [index, node] of nodesValue.entries()) {
      if (!isRecord(node)) {
        errors.push(`Node ${index} must be an object`)
        continue
      }

      for (const field of REQUIRED_NODE_FIELDS) {
        if (!(field in node)) {
          errors.push(`Node ${index} (id=${JSON.stringify(node.id ?? '?')}) missing required field '${field}'`)
        }
      }

      if (typeof node.id === 'string') {
        nodeIds.add(node.id)
      }

      if ('file_type' in node && typeof node.file_type === 'string' && !VALID_FILE_TYPES.has(node.file_type as FileType)) {
        errors.push(
          `Node ${index} (id=${JSON.stringify(node.id ?? '?')}) has invalid file_type '${String(node.file_type)}' - must be one of ${JSON.stringify([...VALID_FILE_TYPES].sort())}`,
        )
      }

      validateLayer(node.layer, `Node ${index} (id=${JSON.stringify(node.id ?? '?')})`, errors)
      validateProvenance(node.provenance, `Node ${index} (id=${JSON.stringify(node.id ?? '?')})`, errors)
    }
  }

  const edgesValue = data.edges
  if (edgesValue === undefined) {
    errors.push("Missing required key 'edges'")
  } else if (!Array.isArray(edgesValue)) {
    errors.push("'edges' must be a list")
  } else {
    for (const [index, edge] of edgesValue.entries()) {
      if (!isRecord(edge)) {
        errors.push(`Edge ${index} must be an object`)
        continue
      }

      for (const field of REQUIRED_EDGE_FIELDS) {
        if (!(field in edge)) {
          errors.push(`Edge ${index} missing required field '${field}'`)
        }
      }

      if ('confidence' in edge && typeof edge.confidence === 'string' && !VALID_CONFIDENCES.has(edge.confidence as Confidence)) {
        errors.push(`Edge ${index} has invalid confidence '${String(edge.confidence)}' - must be one of ${JSON.stringify([...VALID_CONFIDENCES].sort())}`)
      }

      validateLayer(edge.layer, `Edge ${index}`, errors)
      validateProvenance(edge.provenance, `Edge ${index}`, errors)

      if (typeof edge.source === 'string' && nodeIds.size > 0 && !nodeIds.has(edge.source)) {
        errors.push(`Edge ${index} source '${edge.source}' does not match any node id`)
      }

      if (typeof edge.target === 'string' && nodeIds.size > 0 && !nodeIds.has(edge.target)) {
        errors.push(`Edge ${index} target '${edge.target}' does not match any node id`)
      }
    }
  }

  const hyperedgesValue = data.hyperedges
  if (hyperedgesValue !== undefined) {
    if (!Array.isArray(hyperedgesValue)) {
      errors.push("'hyperedges' must be a list")
    } else {
      for (const [index, hyperedge] of hyperedgesValue.entries()) {
        if (!isRecord(hyperedge)) {
          errors.push(`Hyperedge ${index} must be an object`)
          continue
        }

        for (const field of REQUIRED_HYPEREDGE_FIELDS) {
          if (!(field in hyperedge)) {
            errors.push(`Hyperedge ${index} missing required field '${field}'`)
          }
        }

        if ('nodes' in hyperedge) {
          if (!Array.isArray(hyperedge.nodes)) {
            errors.push(`Hyperedge ${index} 'nodes' must be a list`)
          } else {
            for (const [nodeIndex, nodeId] of hyperedge.nodes.entries()) {
              if (typeof nodeId !== 'string') {
                errors.push(`Hyperedge ${index} node ${nodeIndex} must be a string id`)
                continue
              }

              if (nodeIds.size > 0 && !nodeIds.has(nodeId)) {
                errors.push(`Hyperedge ${index} node '${nodeId}' does not match any node id`)
              }
            }
          }
        }

        if (
          'confidence' in hyperedge &&
          typeof hyperedge.confidence === 'string' &&
          !VALID_HYPEREDGE_CONFIDENCES.has(hyperedge.confidence as Extract<Confidence, 'EXTRACTED' | 'INFERRED'>)
        ) {
          errors.push(
            `Hyperedge ${index} has invalid confidence '${String(hyperedge.confidence)}' - must be one of ${JSON.stringify([...VALID_HYPEREDGE_CONFIDENCES].sort())}`,
          )
        }

        validateLayer(hyperedge.layer, `Hyperedge ${index}`, errors)
        validateProvenance(hyperedge.provenance, `Hyperedge ${index}`, errors)
      }
    }
  }

  return errors
}

export function assertValid(data: unknown): asserts data is ExtractionData {
  const errors = validateExtraction(data)
  if (errors.length > 0) {
    const message = `Extraction JSON has ${errors.length} error(s):\n${errors.map((error) => `  • ${error}`).join('\n')}`
    throw new Error(message)
  }
}
