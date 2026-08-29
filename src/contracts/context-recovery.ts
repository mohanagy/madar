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

/**
 * The one ordering over answerability.
 *
 * It lived privately inside the recovery planner, which was fine while
 * recovery was the only thing that had to compare two states. #659 introduces a
 * second comparison -- the graph-integrity cap -- and two orderings that could
 * ever disagree would be a defect class of its own, so the rank moved here,
 * beside the union it ranks, and every consumer imports it.
 */
export const MADAR_ANSWERABILITY_STATES = Object.freeze([
  'ready',
  'ready_with_caveat',
  'verify_targets',
  'insufficient',
] as const)

/**
 * Narrows an untyped value to the union.
 *
 * Needed where a published payload is handled as plain JSON rather than as the
 * typed assessment -- the Pack projections travel as records, and a cap applied
 * there still has to know it is looking at an answerability state.
 */
export function isMadarAnswerabilityState(value: unknown): value is MadarAnswerabilityState {
  return typeof value === 'string'
    && (MADAR_ANSWERABILITY_STATES as readonly string[]).includes(value)
}

export function readinessRank(state: MadarAnswerabilityState): number {
  switch (state) {
    case 'ready': return 4
    case 'ready_with_caveat': return 3
    case 'verify_targets': return 2
    case 'insufficient': return 1
  }
}

/**
 * The more restrictive of two answerability states.
 *
 * Total, pure and idempotent: `min(min(a, b), b) === min(a, b)`. Every cap in
 * the product is expressed through this one helper rather than by re-deriving
 * a comparison, so "may only lower, never raise" is a property of the helper
 * instead of a rule each call site is trusted to re-implement.
 */
export function minByReadinessRank(
  left: MadarAnswerabilityState,
  right: MadarAnswerabilityState,
): MadarAnswerabilityState {
  return readinessRank(right) < readinessRank(left) ? right : left
}
