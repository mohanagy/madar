import type {
  ContextPackEvidenceClass,
  ContextPackExpandableSourceRange,
} from './context-pack.js'

export type MadarEvidenceStrengthLevel = 'strong' | 'moderate' | 'weak'
export type MadarAnswerabilityState =
  | 'ready'
  | 'ready_with_caveat'
  | 'verify_targets'
  | 'insufficient'

export interface MadarEvidenceStrengthAssessment {
  level: MadarEvidenceStrengthLevel
  direct_selected_nodes: number
  supporting_selected_nodes: number
  selected_relationships: number
  available_relationships: number
  reasons: string[]
}

export interface MadarCoverageAssessment {
  status: 'complete' | 'partial' | 'unknown'
  required_obligations: string[]
  covered_obligations: string[]
  missing_obligations: string[]
}

export interface MadarVerificationTarget {
  handle_id?: string
  evidence_class?: ContextPackEvidenceClass
  focus_files: string[]
  focus_ranges: ContextPackExpandableSourceRange[]
  reason: string
}

export interface MadarAnswerabilityAssessment {
  state: MadarAnswerabilityState
  answer_scope: 'complete' | 'partial' | 'none'
  caveats: string[]
  missing_obligations: string[]
  verification_targets: MadarVerificationTarget[]
  broad_search_fallback: 'not_needed' | 'targeted_only' | 'allowed' | 'blocked'
}

export interface ContextPackRecoveryBudget {
  max_attempts: 1 | 2
  /** Maximum expansion candidates added across all attempts. Original nodes are retained separately. */
  max_candidate_nodes: number
  max_elapsed_ms: number
  output_token_budget: number
}

export interface ContextPackRecoveryAttempt {
  attempt: 1 | 2
  status: 'improved' | 'kept_prior' | 'no_candidates' | 'budget_exhausted'
  target_count: number
  /** New expansion candidates introduced by this attempt. */
  candidate_nodes: number
  selected_nodes_before: number
  selected_nodes_after: number
  missing_obligations_before: number
  missing_obligations_after: number
  elapsed_ms: number
  changed_result: boolean
}

export interface ContextPackRecoveryPlan {
  version: 1
  status: 'not_needed' | 'improved' | 'partial' | 'exhausted' | 'no_targets' | 'budget_exhausted'
  budget: ContextPackRecoveryBudget
  initial_state: MadarAnswerabilityState
  final_state: MadarAnswerabilityState
  attempts: ContextPackRecoveryAttempt[]
  improved: boolean
}
