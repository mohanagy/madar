import type { GraphAttributes } from '../graph/directed-multigraph.js'

export const RETRIEVE_RESULT_SCHEMA = 'madar.retrieve' as const
export const RETRIEVE_RESULT_VERSION = 1 as const
export const DEFAULT_RETRIEVE_BUDGET = 4000
export const MIN_RETRIEVE_BUDGET = 256
export const MAX_RETRIEVE_BUDGET = 4000
export const MAX_RETRIEVE_FILES = 12
export const MAX_RETRIEVE_SNIPPETS = 25

export interface RetrieveContextRequest {
  question: string
  budget?: number
}

export interface NormalizedRetrieveRequest {
  question: string
  budget: number
}

export type EvidenceBoundaryKind =
  | 'missing'
  | 'disconnected'
  | 'unsupported'
  | 'stale'
  | 'unavailable'
  | 'corrupt'
  | 'truncated'

export interface EvidenceBoundary {
  kind: EvidenceBoundaryKind
  subject: string
  detail?: string
}

export interface RankedQueryNode {
  id: string
  attributes: GraphAttributes
  score: number
  matchedTerms: string[]
  firstMatch: number
}

export interface RankQueryResult {
  anchors: RankedQueryNode[]
  boundaries: EvidenceBoundary[]
  queryTerms: string[]
}

export interface QueryPathEdge {
  id: string
  from: string
  to: string
  relation: string
  attributes: GraphAttributes
}

export interface QuerySlice {
  nodeIds: string[]
  edges: QueryPathEdge[]
  boundaries: EvidenceBoundary[]
  closurePasses: 0 | 1
}

export interface EvidenceNode {
  node_id: string
  label: string
  node_kind: string
  source_file: string
  source_location: string
  line_number: number
  end_line_number: number
  source_domain: string
  provenance: unknown[]
  content_hash: string
  snippet?: string
}

export interface EvidenceRelationship {
  id: string
  from_id: string
  to_id: string
  relation: string
  source_file?: string
  source_location?: string
  provenance: unknown[]
}

export type RetrieveOutcome =
  | 'evidence'
  | 'missing'
  | 'unsupported'
  | 'stale'
  | 'unavailable'
  | 'corrupt'

export interface RetrieveContextResult {
  schema: typeof RETRIEVE_RESULT_SCHEMA
  version: typeof RETRIEVE_RESULT_VERSION
  outcome: RetrieveOutcome
  matched_nodes: EvidenceNode[]
  relationships: EvidenceRelationship[]
  boundaries: EvidenceBoundary[]
  metrics: {
    selected_files: number
    snippets: number
    closure_passes: 0 | 1
    serialized_tokens: number
    truncated: boolean
  }
}

export function normalizeRetrieveRequest(value: unknown): NormalizedRetrieveRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('retrieve input must be an object')
  }
  const request = value as Record<string, unknown>
  const keys = Object.keys(request).sort()
  if (keys.some((key) => key !== 'budget' && key !== 'question')) {
    throw new TypeError('retrieve accepts only question and optional budget')
  }
  if (typeof request.question !== 'string' || request.question.trim().length === 0) {
    throw new TypeError('retrieve question must be a non-empty string')
  }
  if (request.budget !== undefined
    && (typeof request.budget !== 'number' || !Number.isSafeInteger(request.budget)
      || request.budget <= 0)) {
    throw new TypeError('retrieve budget must be a positive integer')
  }
  return {
    question: request.question.trim(),
    budget: Math.max(
      MIN_RETRIEVE_BUDGET,
      Math.min(request.budget ?? DEFAULT_RETRIEVE_BUDGET, MAX_RETRIEVE_BUDGET),
    ),
  }
}
