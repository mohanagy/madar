import type {
  ContextPackCoverage,
  ContextPackExecutionPhase,
  ContextPackExecutionSlice,
  ContextPackExpandableRef,
  ContextPackRuntimeGenerationAnswerContract,
  ContextPackTaskContract,
  ContextPackTaskKind,
} from '../../contracts/context-pack.js'
import type { RetrievalGateDecision, RetrievalLevel } from '../../contracts/retrieval-gate.js'
import type { TaskIntentKind } from '../../contracts/task-intent.js'
import {
  runPipelineStage,
  startPipelineStage,
  type PipelineStageDiagnostic,
  type PipelineStageObserver,
} from '../../core/pipeline/stage.js'
import { classifyTaskContract } from '../context-pack.js'
import { classifyRetrievalLevel } from '../retrieval-gate.js'
import { defaultContextKindForTaskIntent } from '../task-intent.js'

export type RetrievalPipelineStage =
  | 'query_interpretation'
  | 'seed_generation'
  | 'structural_expansion'
  | 'candidate_ranking'
  | 'evidence_planning'
  | 'budgeted_packing'
  | 'recovery_answerability'

export type RetrievalStageDiagnostic = PipelineStageDiagnostic<RetrievalPipelineStage>
export type RetrievalStageObserver = PipelineStageObserver<RetrievalPipelineStage>

const STOP_WORDS = new Set([
  'how', 'does', 'the', 'is', 'a', 'an', 'in', 'to',
  'of', 'and', 'or', 'what', 'where', 'when', 'why',
  'which', 'this', 'that', 'with', 'for', 'from', 'are',
  'do', 'it', 'be', 'has', 'have', 'was', 'were', 'been',
  'can', 'could', 'would', 'should', 'will', 'may', 'might',
  'not', 'but', 'if', 'then', 'so', 'about', 'up', 'out',
  'on', 'at', 'by', 'into', 'all', 'my', 'its', 'no', 'i',
])

const tokenize = (value: string): string[] => value
  .replace(/([a-z])([A-Z])/g, '$1 $2')
  .toLowerCase()
  .split(/[\s_\\\-./,:;!?'"()[\]{}]+/)
  .filter((token) => token.length > 1)

export const tokenizeQuestion = (question: string): string[] => tokenize(question)
  .filter((token) => !STOP_WORDS.has(token))

export const tokenizeLabel = (label: string): string[] => tokenize(label)

export const tokenMatchCount = (questionToken: string, labelTokens: readonly string[]): number => {
  let matches = 0
  for (const labelToken of labelTokens) {
    if (labelToken.startsWith(questionToken) || questionToken.startsWith(labelToken)) {
      matches += 1
    }
  }
  return matches
}

export interface RetrievalQueryStageInput {
  question: string
  budget: number
  taskKind?: ContextPackTaskKind
  taskIntent?: TaskIntentKind
  retrievalLevel?: RetrievalLevel
}

export interface RetrievalQueryStageOutput {
  question_tokens: string[]
  retrieval_gate: RetrievalGateDecision
  effective_retrieval_level: RetrievalLevel
  task_contract: ContextPackTaskContract
}

const effectiveTaskKind = (input: RetrievalQueryStageInput): ContextPackTaskKind => {
  if (input.taskKind) {
    return input.taskKind
  }
  if (input.taskIntent) {
    return defaultContextKindForTaskIntent(input.taskIntent)
  }
  return 'explain'
}

export const interpretRetrievalQuery = (input: RetrievalQueryStageInput): RetrievalQueryStageOutput => {
  const retrievalGate = classifyRetrievalLevel({
    prompt: input.question,
    ...(input.retrievalLevel !== undefined ? { manualOverride: input.retrievalLevel } : {}),
  })
  const effectiveRetrievalLevel: RetrievalLevel = input.retrievalLevel !== undefined
    ? retrievalGate.level
    : retrievalGate.level === 0
      ? 0
      : (Math.max(retrievalGate.level, 3) as RetrievalLevel)
  const taskContract = classifyTaskContract(effectiveTaskKind(input), {
    budget: input.budget,
    prompt: input.question,
    ...(input.taskIntent ? { task_intent: input.taskIntent } : {}),
  })

  return {
    question_tokens: tokenizeQuestion(input.question),
    retrieval_gate: retrievalGate,
    effective_retrieval_level: effectiveRetrievalLevel,
    task_contract: taskContract,
  }
}

export const runRetrievalQueryStage = (
  input: RetrievalQueryStageInput,
  observer?: RetrievalStageObserver,
): RetrievalQueryStageOutput => runPipelineStage({
  pipeline: 'retrieval',
  stage: 'query_interpretation',
  inputCount: 1,
  outputCount: (output) => output.question_tokens.length,
  ...(observer ? { observer } : {}),
}, () => interpretRetrievalQuery(input))

export interface RetrievalEvidencePlanInput {
  taskContract?: ContextPackTaskContract
  coverage?: ContextPackCoverage
  expandable?: readonly ContextPackExpandableRef[]
  executionSlice?: ContextPackExecutionSlice
  answerContract?: ContextPackRuntimeGenerationAnswerContract
  missingPhases?: readonly ContextPackExecutionPhase[]
  coveredWorkflowOwners?: readonly string[]
  selectedNodeCount?: number
  selectedRelationshipCount?: number
}

/** Explicit boundary consumed by answerability; it contains evidence facts, never ranking scores. */
export interface RetrievalEvidencePlan {
  version: 1
  task_contract?: ContextPackTaskContract
  coverage?: ContextPackCoverage
  expandable: ContextPackExpandableRef[]
  execution_slice?: ContextPackExecutionSlice
  answer_contract?: ContextPackRuntimeGenerationAnswerContract
  missing_phases: ContextPackExecutionPhase[]
  covered_workflow_owners: string[]
  selected_node_count: number
  selected_relationship_count: number
}

const finiteCount = (value: number | undefined): number => (
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
)

export type RetrievalCandidateStage =
  | 'seed_generation'
  | 'structural_expansion'
  | 'candidate_ranking'

export interface RetrievalCandidateStageInput {
  candidate_count: number
}

export interface RetrievalCandidateStageOutput {
  candidate_count: number
  warning_count?: number
}

export interface RetrievalCandidateStageBoundary {
  complete(output: RetrievalCandidateStageOutput): void
  fail(warningCount?: number): void
}

export const runRetrievalCandidateStage = <TOutput extends RetrievalCandidateStageOutput>(
  stage: RetrievalCandidateStage,
  input: RetrievalCandidateStageInput,
  execute: () => TOutput,
  observer?: RetrievalStageObserver,
): TOutput => runPipelineStage({
  pipeline: 'retrieval',
  stage,
  inputCount: finiteCount(input.candidate_count),
  outputCount: (output) => finiteCount(output.candidate_count),
  warningCount: (output) => finiteCount(output.warning_count),
  ...(observer ? { observer } : {}),
}, execute)

export const startRetrievalCandidateStage = (
  stage: RetrievalCandidateStage,
  input: RetrievalCandidateStageInput,
  observer?: RetrievalStageObserver,
): RetrievalCandidateStageBoundary => {
  const timer = startPipelineStage({
    pipeline: 'retrieval',
    stage,
    inputCount: finiteCount(input.candidate_count),
    ...(observer ? { observer } : {}),
  })
  return {
    complete: (output) => timer.complete(
      finiteCount(output.candidate_count),
      finiteCount(output.warning_count),
    ),
    fail: (warningCount = 1) => timer.fail(finiteCount(warningCount)),
  }
}

export interface RetrievalPackingStageInput {
  candidate_count: number
}

export interface RetrievalPackingStageOutput {
  nodes: readonly unknown[]
}

export const runRetrievalPackingStage = <TOutput extends RetrievalPackingStageOutput>(
  input: RetrievalPackingStageInput,
  execute: () => TOutput,
  observer?: RetrievalStageObserver,
): TOutput => runPipelineStage({
  pipeline: 'retrieval',
  stage: 'budgeted_packing',
  inputCount: finiteCount(input.candidate_count),
  outputCount: (output) => output.nodes.length,
  ...(observer ? { observer } : {}),
}, execute)

export interface RetrievalRecoveryStageInput {
  selected_node_count: number
}

export interface RetrievalRecoveryStageOutput {
  selected_node_count: number
  insufficient: boolean
}

export interface RetrievalRecoveryStageBoundary {
  complete(output: RetrievalRecoveryStageOutput): void
  fail(): void
}

export const startRetrievalRecoveryStage = (
  input: RetrievalRecoveryStageInput,
  observer?: RetrievalStageObserver,
): RetrievalRecoveryStageBoundary => {
  const timer = startPipelineStage({
    pipeline: 'retrieval',
    stage: 'recovery_answerability',
    inputCount: finiteCount(input.selected_node_count),
    ...(observer ? { observer } : {}),
  })
  return {
    complete: (output) => timer.complete(
      finiteCount(output.selected_node_count),
      output.insufficient ? 1 : 0,
    ),
    fail: () => timer.fail(),
  }
}

export const buildRetrievalEvidencePlan = (input: RetrievalEvidencePlanInput): RetrievalEvidencePlan => ({
  version: 1,
  ...(input.taskContract ? { task_contract: input.taskContract } : {}),
  ...(input.coverage ? { coverage: input.coverage } : {}),
  expandable: [...(input.expandable ?? [])],
  ...(input.executionSlice ? { execution_slice: input.executionSlice } : {}),
  ...(input.answerContract ? { answer_contract: input.answerContract } : {}),
  missing_phases: [...new Set(input.missingPhases ?? [])],
  covered_workflow_owners: [...new Set(input.coveredWorkflowOwners ?? [])],
  selected_node_count: finiteCount(input.selectedNodeCount),
  selected_relationship_count: finiteCount(input.selectedRelationshipCount),
})

export interface RetrievalEvidenceResultLike {
  task_contract?: ContextPackTaskContract
  coverage?: ContextPackCoverage
  expandable?: readonly ContextPackExpandableRef[]
  execution_slice?: ContextPackExecutionSlice
  answer_contract?: ContextPackRuntimeGenerationAnswerContract
  matched_nodes: ReadonlyArray<{ source_file: string }>
  relationships: readonly unknown[]
}

export const buildRetrievalEvidencePlanFromResult = (
  result: RetrievalEvidenceResultLike,
): RetrievalEvidencePlan => buildRetrievalEvidencePlan({
  ...(result.task_contract ? { taskContract: result.task_contract } : {}),
  ...(result.coverage ? { coverage: result.coverage } : {}),
  ...(result.expandable ? { expandable: result.expandable } : {}),
  ...(result.execution_slice ? { executionSlice: result.execution_slice } : {}),
  ...(result.answer_contract ? { answerContract: result.answer_contract } : {}),
  missingPhases: [
    ...(result.answer_contract?.missing_phases ?? []),
    ...(result.execution_slice?.phase_coverage?.missing ?? []),
  ],
  coveredWorkflowOwners: result.matched_nodes.map((node) => node.source_file),
  selectedNodeCount: result.matched_nodes.length,
  selectedRelationshipCount: result.relationships.length,
})

export const runRetrievalEvidencePlanningStage = (
  input: RetrievalEvidencePlanInput,
  observer?: RetrievalStageObserver,
): RetrievalEvidencePlan => runPipelineStage({
  pipeline: 'retrieval',
  stage: 'evidence_planning',
  inputCount: finiteCount(input.selectedNodeCount),
  outputCount: (output) => output.selected_node_count + output.selected_relationship_count,
  ...(observer ? { observer } : {}),
}, () => buildRetrievalEvidencePlan(input))
