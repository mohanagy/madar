import type { ContextPackEvidenceClass, ContextPackSemanticCategory, ContextPackTaskKind } from '../contracts/context-pack.js'
import type { TaskIntentKind } from '../contracts/task-intent.js'

export interface TaskEvidenceRecipe {
  id: TaskIntentKind
  task_kind: ContextPackTaskKind
  required_evidence: readonly ContextPackEvidenceClass[]
  preferred_evidence: readonly ContextPackEvidenceClass[]
  semantic_required: readonly ContextPackSemanticCategory[]
  semantic_optional: readonly ContextPackSemanticCategory[]
  step_evidence: readonly [
    readonly ContextPackEvidenceClass[],
    readonly ContextPackEvidenceClass[],
    readonly ContextPackEvidenceClass[],
  ]
}

interface ResolveTaskEvidenceRecipeOptions {
  task_intent?: TaskIntentKind
  has_change_evidence?: boolean
}

const TASK_EVIDENCE_RECIPES: Record<TaskIntentKind, TaskEvidenceRecipe> = {
  explain: {
    id: 'explain',
    task_kind: 'explain',
    required_evidence: ['primary', 'supporting', 'structural'],
    preferred_evidence: ['primary', 'supporting', 'structural'],
    semantic_required: ['implementation', 'structure'],
    semantic_optional: ['contracts', 'configuration', 'tests'],
    step_evidence: [
      ['primary'],
      ['supporting', 'structural'],
      ['primary', 'supporting', 'structural'],
    ],
  },
  implement: {
    id: 'implement',
    task_kind: 'implement',
    required_evidence: ['primary', 'supporting', 'structural'],
    preferred_evidence: ['primary', 'supporting', 'structural', 'impact', 'change'],
    semantic_required: ['implementation', 'structure'],
    semantic_optional: ['contracts', 'configuration', 'tests', 'impact'],
    step_evidence: [
      ['primary'],
      ['supporting', 'structural', 'change'],
      ['primary', 'supporting', 'structural'],
    ],
  },
  review: {
    id: 'review',
    task_kind: 'review',
    required_evidence: ['change', 'supporting', 'impact'],
    preferred_evidence: ['change', 'supporting', 'impact', 'structural', 'primary'],
    semantic_required: ['changes', 'impact'],
    semantic_optional: ['tests', 'configuration', 'contracts'],
    step_evidence: [
      ['change'],
      ['supporting', 'impact', 'structural'],
      ['change', 'supporting', 'impact'],
    ],
  },
  impact: {
    id: 'impact',
    task_kind: 'impact',
    required_evidence: ['primary', 'impact', 'structural'],
    preferred_evidence: ['primary', 'impact', 'structural', 'supporting', 'change'],
    semantic_required: ['implementation', 'impact', 'structure'],
    semantic_optional: ['configuration', 'contracts', 'tests'],
    step_evidence: [
      ['primary'],
      ['impact', 'structural', 'supporting'],
      ['primary', 'impact', 'structural'],
    ],
  },
  'debug-flow': {
    id: 'debug-flow',
    task_kind: 'impact',
    required_evidence: ['primary', 'impact', 'supporting'],
    preferred_evidence: ['primary', 'impact', 'supporting', 'structural', 'change'],
    semantic_required: ['implementation', 'impact', 'configuration'],
    semantic_optional: ['tests', 'contracts'],
    step_evidence: [
      ['primary', 'impact'],
      ['impact', 'supporting', 'structural'],
      ['primary', 'impact', 'supporting'],
    ],
  },
  'pr-review-risk': {
    id: 'pr-review-risk',
    task_kind: 'review',
    required_evidence: ['change', 'impact', 'supporting'],
    preferred_evidence: ['change', 'impact', 'supporting', 'structural', 'primary'],
    semantic_required: ['changes', 'impact', 'tests'],
    semantic_optional: ['configuration', 'contracts'],
    step_evidence: [
      ['change', 'impact'],
      ['impact', 'supporting', 'structural'],
      ['change', 'impact', 'supporting'],
    ],
  },
  'test-generation': {
    id: 'test-generation',
    task_kind: 'implement',
    required_evidence: ['primary', 'supporting', 'structural'],
    preferred_evidence: ['primary', 'structural', 'supporting', 'change', 'impact'],
    semantic_required: ['implementation', 'tests', 'structure'],
    semantic_optional: ['contracts', 'configuration'],
    step_evidence: [
      ['primary', 'structural'],
      ['supporting', 'structural', 'change'],
      ['primary', 'supporting', 'structural'],
    ],
  },
  'refactor-module': {
    id: 'refactor-module',
    task_kind: 'implement',
    required_evidence: ['primary', 'structural', 'impact'],
    preferred_evidence: ['primary', 'structural', 'impact', 'supporting', 'change'],
    semantic_required: ['implementation', 'structure', 'contracts'],
    semantic_optional: ['impact', 'tests'],
    step_evidence: [
      ['primary', 'structural'],
      ['structural', 'impact', 'supporting'],
      ['primary', 'structural', 'impact'],
    ],
  },
  'dead-code': {
    id: 'dead-code',
    task_kind: 'implement',
    required_evidence: ['impact', 'primary', 'structural'],
    preferred_evidence: ['impact', 'primary', 'structural', 'supporting', 'change'],
    semantic_required: ['impact', 'implementation', 'structure'],
    semantic_optional: ['tests', 'contracts'],
    step_evidence: [
      ['impact', 'primary'],
      ['impact', 'structural', 'supporting'],
      ['impact', 'primary', 'structural'],
    ],
  },
  'security-review': {
    id: 'security-review',
    task_kind: 'review',
    required_evidence: ['change', 'impact', 'supporting'],
    preferred_evidence: ['change', 'impact', 'supporting', 'primary', 'structural'],
    semantic_required: ['changes', 'impact', 'configuration'],
    semantic_optional: ['tests', 'contracts'],
    step_evidence: [
      ['change', 'impact'],
      ['impact', 'supporting', 'primary'],
      ['change', 'impact', 'supporting'],
    ],
  },
  'performance-review': {
    id: 'performance-review',
    task_kind: 'impact',
    required_evidence: ['impact', 'structural', 'primary'],
    preferred_evidence: ['impact', 'structural', 'primary', 'supporting', 'change'],
    semantic_required: ['impact', 'structure', 'configuration'],
    semantic_optional: ['implementation', 'tests'],
    step_evidence: [
      ['impact', 'primary'],
      ['impact', 'structural', 'supporting'],
      ['impact', 'structural', 'primary'],
    ],
  },
  migrate: {
    id: 'migrate',
    task_kind: 'implement',
    required_evidence: ['primary', 'supporting', 'structural'],
    preferred_evidence: ['primary', 'supporting', 'structural', 'change', 'impact'],
    semantic_required: ['implementation', 'contracts', 'structure'],
    semantic_optional: ['configuration', 'tests', 'impact'],
    step_evidence: [
      ['primary', 'structural'],
      ['supporting', 'structural', 'change'],
      ['primary', 'supporting', 'structural'],
    ],
  },
  document: {
    id: 'document',
    task_kind: 'implement',
    required_evidence: ['primary', 'supporting', 'structural'],
    preferred_evidence: ['primary', 'supporting', 'structural', 'impact'],
    semantic_required: ['implementation', 'structure'],
    semantic_optional: ['contracts', 'configuration', 'tests'],
    step_evidence: [
      ['primary'],
      ['supporting', 'structural'],
      ['primary', 'supporting', 'structural'],
    ],
  },
}

function uniqueEvidence(values: readonly ContextPackEvidenceClass[]): ContextPackEvidenceClass[] {
  const seen = new Set<ContextPackEvidenceClass>()
  const unique: ContextPackEvidenceClass[] = []
  for (const value of values) {
    if (seen.has(value)) {
      continue
    }
    seen.add(value)
    unique.push(value)
  }
  return unique
}

function uniqueSemanticCategories(values: readonly ContextPackSemanticCategory[]): ContextPackSemanticCategory[] {
  const seen = new Set<ContextPackSemanticCategory>()
  const unique: ContextPackSemanticCategory[] = []
  for (const value of values) {
    if (seen.has(value)) {
      continue
    }
    seen.add(value)
    unique.push(value)
  }
  return unique
}

function cloneRecipe(recipe: TaskEvidenceRecipe): TaskEvidenceRecipe {
  return {
    ...recipe,
    required_evidence: [...recipe.required_evidence],
    preferred_evidence: [...recipe.preferred_evidence],
    semantic_required: [...recipe.semantic_required],
    semantic_optional: [...recipe.semantic_optional],
    step_evidence: cloneStepEvidence(recipe.step_evidence),
  }
}

function reviewFallbackEvidence(values: readonly ContextPackEvidenceClass[]): ContextPackEvidenceClass[] {
  return uniqueEvidence(values.map((value) => (value === 'change' ? 'primary' : value)))
}

function reviewFallbackRecipe(recipe: TaskEvidenceRecipe): TaskEvidenceRecipe {
  const semanticRequired = uniqueSemanticCategories(recipe.semantic_required.map((value) => (value === 'changes' ? 'implementation' : value)))
  const semanticOptional = uniqueSemanticCategories(
    recipe.semantic_optional
      .map((value) => (value === 'changes' ? 'implementation' : value))
      .filter((value) => !semanticRequired.includes(value)),
  )

  return {
    ...cloneRecipe(recipe),
    required_evidence: reviewFallbackEvidence(recipe.required_evidence),
    preferred_evidence: reviewFallbackEvidence(recipe.preferred_evidence),
    semantic_required: semanticRequired,
    semantic_optional: semanticOptional,
    step_evidence: [
      reviewFallbackEvidence(recipe.step_evidence[0]),
      reviewFallbackEvidence(recipe.step_evidence[1]),
      reviewFallbackEvidence(recipe.step_evidence[2]),
    ],
  }
}

function cloneStepEvidence(stepEvidence: TaskEvidenceRecipe['step_evidence']): TaskEvidenceRecipe['step_evidence'] {
  return [
    [...stepEvidence[0]],
    [...stepEvidence[1]],
    [...stepEvidence[2]],
  ]
}

export function resolveTaskEvidenceRecipe(
  taskKind: ContextPackTaskKind,
  options: ResolveTaskEvidenceRecipeOptions = {},
): TaskEvidenceRecipe {
  const requestedRecipe = options.task_intent ? TASK_EVIDENCE_RECIPES[options.task_intent] : undefined
  const compatibleRecipe = requestedRecipe?.task_kind === taskKind ? requestedRecipe : TASK_EVIDENCE_RECIPES[taskKind]

  if (taskKind === 'review' && options.has_change_evidence === false) {
    return reviewFallbackRecipe(compatibleRecipe)
  }

  return cloneRecipe(compatibleRecipe)
}
