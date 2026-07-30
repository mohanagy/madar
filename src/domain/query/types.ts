import type { GraphAttributes } from '../graph/directed-multigraph.js'
import type { IndexRange } from '../index/model.js'
export const RETRIEVE_RESULT_SCHEMA = 'madar.retrieve' as const
export const RETRIEVE_RESULT_VERSION = 1 as const
export const DEFAULT_RETRIEVE_BUDGET = 4000
export const MIN_RETRIEVE_BUDGET = 256
export const MAX_RETRIEVE_BUDGET = 4000
export const MAX_RETRIEVE_QUESTION_LENGTH = 512
export const MAX_RETRIEVE_FILES = 12
export const MAX_RETRIEVE_SNIPPETS = 25
export interface NormalizedRetrieveRequest { question: string; budget: number }
export type EvidenceBoundaryKind =
  | 'missing' | 'disconnected' | 'unsupported' | 'stale'
  | 'unavailable' | 'corrupt' | 'truncated'
export interface EvidenceBoundary { kind: EvidenceBoundaryKind; subject: string; detail?: string }
export interface RankedQueryNode {
  id: string; attributes: GraphAttributes; score: number
  matchedTerms: string[]; firstMatch: number
}
export interface RankQueryResult {
  anchors: RankedQueryNode[]; boundaries: EvidenceBoundary[]; queryTerms: string[]
  flow: boolean; branch: string
  priorityAnchorIds?: readonly string[]
  coveredTerms?: readonly string[]
  structuralRequired?: boolean
  structuralCoverageComplete?: boolean
}
export interface QueryPathEdge {
  id: string; from: string; to: string; relation: string; attributes: GraphAttributes
}
export interface QuerySlice {
  nodeIds: string[]; edges: QueryPathEdge[]
  boundaries: EvidenceBoundary[]; closurePasses: 0 | 1
}

interface EvidenceNodeBase {
  node_id: string; label: string; source_file: string; source_domain?: string
  provenance: unknown[]; content_hash: string
}
export type EvidenceNode = EvidenceNodeBase & ({
  evidence_kind: 'structural_file'; node_kind: 'file'; snippet?: undefined
  definition_range?: undefined; declaration_range?: undefined
} | {
  evidence_kind: 'symbol_declaration'; node_kind: string; source_location: string
  line_number: number; end_line_number: number; definition_range: IndexRange
  declaration_range: IndexRange; snippet: string
})

export interface EvidenceRelationship {
  id: string; from_id: string; to_id: string; relation: string
  source_file?: string; source_location?: string; provenance: unknown[]
}

export type RetrieveOutcome =
  | 'evidence' | 'missing' | 'unsupported' | 'stale' | 'unavailable' | 'corrupt'

export interface RetrieveContextResult {
  schema: typeof RETRIEVE_RESULT_SCHEMA; version: typeof RETRIEVE_RESULT_VERSION
  outcome: RetrieveOutcome; matched_nodes: EvidenceNode[]
  relationships: EvidenceRelationship[]; boundaries: EvidenceBoundary[]
  metrics: {
    selected_files: number; snippets: number; closure_passes: 0 | 1
    serialized_tokens: number; truncated: boolean
  }
}

export function normalizeRetrieveRequest(value: unknown): NormalizedRetrieveRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('retrieve input must be an object')
  }
  const request = value as Record<string, unknown>
  if (Object.keys(request).some((key) => key !== 'budget' && key !== 'question')) {
    throw new TypeError('retrieve accepts only question and optional budget')
  }
  const question = typeof request.question === 'string' ? request.question.trim() : ''
  if (question.length === 0 || question.length > MAX_RETRIEVE_QUESTION_LENGTH) {
    throw new TypeError(`retrieve question must be between 1 and ${MAX_RETRIEVE_QUESTION_LENGTH} characters`)
  }
  const budget = request.budget
  if (budget !== undefined && (typeof budget !== 'number'
    || !Number.isSafeInteger(budget) || budget <= 0)) {
    throw new TypeError('retrieve budget must be a positive integer')
  }
  return { question, budget: Math.max(
    MIN_RETRIEVE_BUDGET,
    Math.min(budget ?? DEFAULT_RETRIEVE_BUDGET, MAX_RETRIEVE_BUDGET),
  ) }
}
