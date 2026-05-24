export const TASK_APPLICABILITY_REASONS = [
  'implement',
  'explain',
  'debug',
  'test',
  'review',
  'refactor',
  'external_url',
  'github_project',
  'package_registry',
  'auth_setup',
  'marketing_copy',
  'general_research',
] as const

export type TaskApplicabilityReason = (typeof TASK_APPLICABILITY_REASONS)[number]

export interface TaskApplicabilityClassification {
  version: 1
  prompt: string
  normalized_prompt: string
  needs_local_code_context: boolean
  reason: TaskApplicabilityReason
  matched_terms: string[]
}
