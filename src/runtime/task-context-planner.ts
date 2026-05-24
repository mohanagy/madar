import type { ContextPackEvidenceClass, ContextPackTaskKind } from '../contracts/context-pack.js'
import {
  TASK_CONTEXT_PLAN_VERSION,
  type TaskContextPlan,
  type TaskContextPlanInput,
  type TaskContextPlanScopeMode,
  type TaskContextPlanStep,
} from '../contracts/task-context-plan.js'
import { classifyTaskIntent } from './task-intent.js'
import { classifyTaskContract } from './context-pack.js'
import { resolveTaskEvidenceRecipe } from './task-evidence-recipes.js'

interface ScopeSelection {
  mode: TaskContextPlanScopeMode
  paths: string[]
}

interface TaskPlannerShape {
  budget_shares: readonly [number, number, number]
  titles: readonly [string, string, string]
}

const TASK_PLANNER_SHAPES: Record<ContextPackTaskKind, TaskPlannerShape> = {
  explain: {
    budget_shares: [35, 40, 25],
    titles: ['Collect primary evidence', 'Expand supporting context', 'Assemble final context'],
  },
  implement: {
    budget_shares: [35, 40, 25],
    titles: ['Collect implementation anchors', 'Expand implementation context', 'Assemble implementation context'],
  },
  review: {
    budget_shares: [50, 30, 20],
    titles: ['Collect changed evidence', 'Expand review context', 'Assemble review context'],
  },
  impact: {
    budget_shares: [30, 45, 25],
    titles: ['Collect impact seeds', 'Expand dependency context', 'Assemble impact context'],
  },
}

function plannerShape(taskKind: ContextPackTaskKind, changedPaths: readonly string[]): TaskPlannerShape {
  if (taskKind !== 'review' || changedPaths.length > 0) {
    return TASK_PLANNER_SHAPES[taskKind]
  }

  return {
    budget_shares: TASK_PLANNER_SHAPES.review.budget_shares,
    titles: ['Collect primary review evidence', 'Expand review context', 'Assemble review context'],
  }
}

function normalizePrompt(prompt: string): string {
  const normalized = prompt.trim()
  if (normalized.length === 0) {
    throw new Error('Task context planning prompt is required')
  }

  return normalized
}

function normalizeBudget(budget: number): number {
  if (!Number.isFinite(budget)) {
    throw new Error('Task context planning budget must be a finite number')
  }

  const normalized = Math.trunc(budget)
  if (normalized < 3) {
    throw new Error('Task context planning budget must be at least 3')
  }

  return normalized
}

function normalizePaths(paths?: readonly string[]): string[] {
  if (!paths) {
    return []
  }

  return [...new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0))].sort((left, right) => left.localeCompare(right))
}

function mergePaths(...pathSets: ReadonlyArray<readonly string[]>): string[] {
  const merged = new Set<string>()
  for (const pathSet of pathSets) {
    for (const path of pathSet) {
      merged.add(path)
    }
  }

  return [...merged].sort((left, right) => left.localeCompare(right))
}

function allocateBudget(totalBudget: number, shares: readonly [number, number, number]): [number, number, number] {
  const first = Math.floor((totalBudget * shares[0]) / 100)
  const second = Math.floor((totalBudget * shares[1]) / 100)
  const third = totalBudget - first - second
  const allocations: [number, number, number] = [first, second, third]

  for (const index of [0, 1, 2] as const) {
    if (allocations[index] > 0) {
      continue
    }

    const donorIndex = ([0, 1, 2] as const).find((candidate) => allocations[candidate] > 1)
    if (donorIndex === undefined) {
      continue
    }

    allocations[donorIndex] -= 1
    allocations[index] += 1
  }

  return allocations
}

function explicitScope(focusPaths: readonly string[], changedPaths: readonly string[]): ScopeSelection {
  const paths = mergePaths(focusPaths, changedPaths)
  return paths.length > 0
    ? { mode: 'focused', paths }
    : { mode: 'global', paths: [] }
}

function reviewExpansionScope(focusPaths: readonly string[], changedPaths: readonly string[]): ScopeSelection {
  if (focusPaths.length > 0) {
    return { mode: 'focused', paths: mergePaths(focusPaths, changedPaths) }
  }

  if (changedPaths.length > 0) {
    return { mode: 'changed', paths: [...changedPaths] }
  }

  return { mode: 'global', paths: [] }
}

function planStep(
  id: TaskContextPlanStep['id'],
  kind: TaskContextPlanStep['kind'],
  title: string,
  budget: number,
  evidence: readonly ContextPackEvidenceClass[],
  scope: ScopeSelection,
): TaskContextPlanStep {
  return {
    id,
    kind,
    title,
    budget,
    evidence: [...evidence],
    scope_mode: scope.mode,
    scope_paths: [...scope.paths],
  }
}

export function buildTaskContextPlan(input: TaskContextPlanInput): TaskContextPlan {
  const prompt = normalizePrompt(input.prompt)
  const totalBudget = normalizeBudget(input.budget)
  const focusPaths = normalizePaths(input.focus_paths)
  const changedPaths = normalizePaths(input.changed_paths)
  const hasReviewChanges = input.task_kind === 'review' && changedPaths.length > 0
  const explicit = explicitScope(focusPaths, changedPaths)
  const reviewExpand = reviewExpansionScope(focusPaths, changedPaths)
  const seedScope = hasReviewChanges
    ? { mode: 'changed' as const, paths: [...changedPaths] }
    : explicit
  const shape = plannerShape(input.task_kind, changedPaths)
  const taskIntent = input.task_intent ?? classifyTaskIntent(prompt).kind
  const taskContract = classifyTaskContract(input.task_kind, {
    budget: totalBudget,
    prompt,
    task_intent: taskIntent,
    has_change_evidence: changedPaths.length > 0,
  })
  const recipe = resolveTaskEvidenceRecipe(input.task_kind, {
    task_intent: taskIntent,
    has_change_evidence: changedPaths.length > 0,
  })
  const [seedBudget, expandBudget, assembleBudget] = allocateBudget(totalBudget, shape.budget_shares)
  const retrieveScope = input.task_kind === 'review' ? reviewExpand : explicit

  return {
    version: TASK_CONTEXT_PLAN_VERSION,
    task_kind: input.task_kind,
    prompt,
    total_budget: totalBudget,
    scope: {
      seed_mode: seedScope.mode,
      focus_paths: [...focusPaths],
      changed_paths: [...changedPaths],
    },
    evidence: {
      recipe_id: taskContract.evidence_recipe_id,
      required: [...taskContract.required_evidence],
      preferred: [...taskContract.preferred_evidence],
      semantic_required: [...taskContract.semantic_required],
      semantic_optional: [...taskContract.semantic_optional],
    },
    steps: [
      planStep('seed', 'retrieve', shape.titles[0], seedBudget, recipe.step_evidence[0], seedScope),
      planStep('expand', 'retrieve', shape.titles[1], expandBudget, recipe.step_evidence[1], retrieveScope),
      planStep('assemble', 'synthesize', shape.titles[2], assembleBudget, recipe.step_evidence[2], retrieveScope),
    ],
  }
}
