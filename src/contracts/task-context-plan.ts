import type { ContextPackEvidenceClass, ContextPackTaskKind } from './context-pack.js'

export const TASK_CONTEXT_PLAN_VERSION = 1

export type TaskContextPlanScopeMode = 'global' | 'focused' | 'changed'

export type TaskContextPlanStepId = 'seed' | 'expand' | 'assemble'

export type TaskContextPlanStepKind = 'retrieve' | 'synthesize'

export interface TaskContextPlanInput {
  task_kind: ContextPackTaskKind
  prompt: string
  budget: number
  focus_paths?: readonly string[]
  changed_paths?: readonly string[]
}

export interface TaskContextPlanScope {
  seed_mode: TaskContextPlanScopeMode
  focus_paths: string[]
  changed_paths: string[]
}

export interface TaskContextPlanEvidence {
  required: ContextPackEvidenceClass[]
  preferred: ContextPackEvidenceClass[]
}

export interface TaskContextPlanStep {
  id: TaskContextPlanStepId
  kind: TaskContextPlanStepKind
  title: string
  budget: number
  evidence: ContextPackEvidenceClass[]
  scope_mode: TaskContextPlanScopeMode
  scope_paths: string[]
}

export interface TaskContextPlan {
  version: typeof TASK_CONTEXT_PLAN_VERSION
  task_kind: ContextPackTaskKind
  prompt: string
  total_budget: number
  scope: TaskContextPlanScope
  evidence: TaskContextPlanEvidence
  steps: TaskContextPlanStep[]
}
