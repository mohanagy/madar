export type RetrievalFallbackReason =
  | 'weak_anchors'
  | 'low_workflow_coherence'
  | 'missing_required_evidence'
  | 'missing_semantic_evidence'
  | 'missing_query_obligations'

export type RepositoryVocabularySource =
  | 'path'
  | 'exported_symbol'
  | 'module_name'
  | 'graph_community'
  | 'document_heading'
  | 'framework_metadata'

export interface RetrievalQualitySnapshot {
  selected_nodes: number
  selected_files: number
  direct_matches: number
  explicit_anchors: number
  workflow_coherence: number
  missing_required_evidence: number
  missing_semantic_evidence: number
  token_count: number
}

export interface RetrievalFallbackAttempt {
  fallback: 'repository_vocabulary_v1'
  status: 'applied' | 'kept_initial' | 'no_candidates'
  reasons: RetrievalFallbackReason[]
  vocabulary_sources: RepositoryVocabularySource[]
  expansion_terms: string[]
  promoted_candidates: number
  /** Community ids represented by positively promoted candidates. */
  promoted_communities?: number[]
  changed_result: boolean
  added_selected_files: number
  removed_selected_files: number
}

export interface RetrievalQueryObligationCoverage {
  total: number
  initially_covered: number
  finally_covered: number
}

/**
 * Bounded, machine-readable account of conceptual-query recovery.
 *
 * The plan intentionally reports aggregate result changes instead of raw
 * absolute paths or source text. Selected paths remain available in the
 * normal context-pack nodes, under the existing serialization policy.
 */
export interface ContextPackRetrievalPlanDetail {
  version: 1
  status: 'not_needed' | 'recovered' | 'kept_initial' | 'no_candidates'
  reasons: RetrievalFallbackReason[]
  initial: RetrievalQualitySnapshot
  final: RetrievalQualitySnapshot
  attempts: RetrievalFallbackAttempt[]
  query_obligations?: RetrievalQueryObligationCoverage
  selected_fallback?: RetrievalFallbackAttempt['fallback']
}

export interface RetrievalFallbackAttemptSummary {
  fallback: RetrievalFallbackAttempt['fallback']
  status: RetrievalFallbackAttempt['status']
  changed_result: boolean
}

export interface ContextPackRetrievalPlanSummary {
  version: 1
  status: ContextPackRetrievalPlanDetail['status']
  reasons: RetrievalFallbackReason[]
  attempts: RetrievalFallbackAttemptSummary[]
  selected_fallback?: RetrievalFallbackAttempt['fallback']
}

export type ContextPackRetrievalPlan = ContextPackRetrievalPlanDetail | ContextPackRetrievalPlanSummary
