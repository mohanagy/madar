import type { ContextPackRecoveryPlan, MadarAnswerabilityState, MadarVerificationTarget } from '../contracts/context-recovery.js'
import type { KnowledgeGraph } from '../contracts/graph.js'
import { assessMadarResponseEvidence } from './mcp-response-evidence.js'
import { buildRetrievalEvidencePlanFromResult } from './retrieve/pipeline.js'
import type { RetrieveOptions, RetrieveResult } from './retrieve.js'

const DEFAULT_MAX_ATTEMPTS = 2 as const
const DEFAULT_MAX_CANDIDATE_NODES = 64
const DEFAULT_MAX_ELAPSED_MS = 750
const ORIGINAL_NODE_BOOST = 6
const FOCUS_NODE_BOOST = 4.5
const PREVIEW_NODE_BOOST = 3.5

interface RecoveryAssessment {
  state: MadarAnswerabilityState
  missingObligations: string[]
  verificationTargets: MadarVerificationTarget[]
  strength: 'strong' | 'moderate' | 'weak'
  selectedRelationships: number
}

export interface ContextPackRecoveryOptions {
  enabled?: boolean
  maxAttempts?: 1 | 2
  maxCandidateNodes?: number
  maxElapsedMs?: number
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const finiteValue = typeof value === 'number' && Number.isFinite(value)
    ? Math.floor(value)
    : fallback
  return Math.min(maximum, Math.max(1, finiteValue))
}

function assess(result: RetrieveResult, question: string): RecoveryAssessment {
  const assessment = assessMadarResponseEvidence({
    evidencePlan: buildRetrievalEvidencePlanFromResult(result),
    question,
  })
  return {
    state: assessment.answerability.state,
    missingObligations: assessment.answerability.missing_obligations,
    verificationTargets: assessment.answerability.verification_targets,
    strength: assessment.evidence_strength.level,
    selectedRelationships: assessment.evidence_strength.selected_relationships,
  }
}

function readinessRank(state: MadarAnswerabilityState): number {
  switch (state) {
    case 'ready': return 4
    case 'ready_with_caveat': return 3
    case 'verify_targets': return 2
    case 'insufficient': return 1
  }
}

function strengthRank(strength: RecoveryAssessment['strength']): number {
  switch (strength) {
    case 'strong': return 3
    case 'moderate': return 2
    case 'weak': return 1
  }
}

function assessmentImproved(before: RecoveryAssessment, after: RecoveryAssessment): boolean {
  const beforeReadiness = readinessRank(before.state)
  const afterReadiness = readinessRank(after.state)
  if (afterReadiness !== beforeReadiness) {
    return afterReadiness > beforeReadiness
  }
  if (after.missingObligations.length !== before.missingObligations.length) {
    return after.missingObligations.length < before.missingObligations.length
  }
  const beforeStrength = strengthRank(before.strength)
  const afterStrength = strengthRank(after.strength)
  if (afterStrength !== beforeStrength) {
    return afterStrength > beforeStrength
  }
  return after.selectedRelationships > before.selectedRelationships
}

function portablePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '')
}

function sourceMatchesFocus(sourceFile: string, focusFile: string): boolean {
  const source = portablePath(sourceFile)
  const focus = portablePath(focusFile)
  return source === focus || source.endsWith(`/${focus}`) || focus.endsWith(`/${source}`)
}

function targetKey(target: MadarVerificationTarget): string {
  return target.handle_id
    ?? `${target.evidence_class ?? ''}\u0000${target.reason}\u0000${target.focus_files.map(portablePath).sort().join('\u0000')}`
}

function selectedNodeIds(result: RetrieveResult): string[] {
  return [...new Set(result.matched_nodes.flatMap((node) => node.node_id ? [node.node_id] : []))]
}

function resultNodeSignature(result: RetrieveResult): string {
  return selectedNodeIds(result).sort().join('\u0000')
}

function addTargetCandidates(
  graph: KnowledgeGraph,
  result: RetrieveResult,
  target: MadarVerificationTarget,
  boosts: Map<string, number>,
  recoveryCandidateIds: Set<string>,
  maxCandidateNodes: number,
): number {
  const sizeBefore = recoveryCandidateIds.size
  const addCandidate = (nodeId: string, boost: number): void => {
    const existingBoost = boosts.get(nodeId)
    if (existingBoost !== undefined) {
      boosts.set(nodeId, Math.max(existingBoost, boost))
      return
    }
    if (recoveryCandidateIds.size >= maxCandidateNodes) {
      return
    }
    boosts.set(nodeId, boost)
    recoveryCandidateIds.add(nodeId)
  }
  const expandable = target.handle_id
    ? result.expandable?.find((entry) => entry.handle_id === target.handle_id)
    : undefined
  for (const preview of expandable?.preview ?? []) {
    if (recoveryCandidateIds.size >= maxCandidateNodes) break
    if (preview.node_id && graph.hasNode(preview.node_id)) {
      addCandidate(preview.node_id, PREVIEW_NODE_BOOST)
    }
  }

  const focusFiles = target.focus_files
  if (focusFiles.length > 0 && recoveryCandidateIds.size < maxCandidateNodes) {
    for (const [nodeId, attributes] of graph.nodeEntries()) {
      if (recoveryCandidateIds.size >= maxCandidateNodes) break
      const sourceFile = String(attributes.source_file ?? '').trim()
      if (sourceFile.length === 0 || !focusFiles.some((focusFile) => sourceMatchesFocus(sourceFile, focusFile))) {
        continue
      }
      addCandidate(nodeId, FOCUS_NODE_BOOST)
    }
  }
  return recoveryCandidateIds.size - sizeBefore
}

function recoveryStatus(input: {
  attempted: boolean
  improved: boolean
  finalState: MadarAnswerabilityState
  noTargets: boolean
  budgetExhausted: boolean
}): ContextPackRecoveryPlan['status'] {
  if (!input.attempted && input.noTargets) return 'no_targets'
  if (!input.attempted) return 'not_needed'
  if (input.improved && (input.finalState === 'ready' || input.finalState === 'ready_with_caveat')) return 'improved'
  if (input.improved) return 'partial'
  if (input.budgetExhausted) return 'budget_exhausted'
  return 'exhausted'
}

export function recoverContextPackResult(
  graph: KnowledgeGraph,
  initial: RetrieveResult,
  options: RetrieveOptions,
  runPass: (nodeBoosts: ReadonlyMap<string, number>) => RetrieveResult,
  recoveryOptions: ContextPackRecoveryOptions = {},
): RetrieveResult {
  const maxAttempts = boundedPositiveInteger(
    recoveryOptions.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
    2,
  ) as 1 | 2
  const maxCandidateNodes = boundedPositiveInteger(
    recoveryOptions.maxCandidateNodes,
    DEFAULT_MAX_CANDIDATE_NODES,
  )
  const maxElapsedMs = boundedPositiveInteger(
    recoveryOptions.maxElapsedMs,
    DEFAULT_MAX_ELAPSED_MS,
  )
  const outputTokenBudget = boundedPositiveInteger(options.budget, 1)
  const budget = {
    max_attempts: maxAttempts,
    max_candidate_nodes: maxCandidateNodes,
    max_elapsed_ms: maxElapsedMs,
    output_token_budget: outputTokenBudget,
  } as const
  const initialAssessment = assess(initial, options.question)
  const recoveryAllowed = recoveryOptions.enabled !== false
    && options.taskKind !== 'implement'
    && initial.retrieval_gate?.level !== 0
  if (!recoveryAllowed || initialAssessment.state === 'ready' || initialAssessment.state === 'ready_with_caveat') {
    return {
      ...initial,
      recovery: {
        version: 1,
        status: 'not_needed',
        budget,
        initial_state: initialAssessment.state,
        final_state: initialAssessment.state,
        attempts: [],
        improved: false,
      },
    }
  }

  let current = initial
  let currentAssessment = initialAssessment
  const attempts: ContextPackRecoveryPlan['attempts'] = []
  const attemptedTargets = new Set<string>()
  const boosts = new Map<string, number>()
  const recoveryCandidateIds = new Set<string>()
  for (const nodeId of selectedNodeIds(initial)) {
    boosts.set(nodeId, ORIGINAL_NODE_BOOST)
  }
  const recoveryStarted = performance.now()
  let improved = false
  let noTargets = false
  let budgetExhausted = false

  for (let index = 0; index < maxAttempts; index += 1) {
    if (performance.now() - recoveryStarted >= maxElapsedMs) {
      budgetExhausted = true
      break
    }
    const target = currentAssessment.verificationTargets.find((candidate) => !attemptedTargets.has(targetKey(candidate)))
    if (!target) {
      noTargets = attempts.length === 0
      break
    }
    attemptedTargets.add(targetKey(target))
    const selectedBefore = current.matched_nodes.length
    const missingBefore = currentAssessment.missingObligations.length
    const candidateNodes = addTargetCandidates(
      graph,
      current,
      target,
      boosts,
      recoveryCandidateIds,
      maxCandidateNodes,
    )
    if (candidateNodes === 0) {
      attempts.push({
        attempt: (index + 1) as 1 | 2,
        status: 'no_candidates',
        target_count: 1,
        candidate_nodes: 0,
        selected_nodes_before: selectedBefore,
        selected_nodes_after: selectedBefore,
        missing_obligations_before: missingBefore,
        missing_obligations_after: missingBefore,
        elapsed_ms: 0,
        changed_result: false,
      })
      continue
    }

    const attemptStarted = performance.now()
    const candidate = runPass(boosts)
    const candidateAssessment = assess(candidate, options.question)
    const outputBudgetExceeded = candidate.token_count > budget.output_token_budget
    const accepted = !outputBudgetExceeded && assessmentImproved(currentAssessment, candidateAssessment)
    const elapsedMs = Math.round(performance.now() - attemptStarted)
    const changedResult = resultNodeSignature(current) !== resultNodeSignature(candidate)
    attempts.push({
      attempt: (index + 1) as 1 | 2,
      status: outputBudgetExceeded ? 'budget_exhausted' : accepted ? 'improved' : 'kept_prior',
      target_count: 1,
      candidate_nodes: candidateNodes,
      selected_nodes_before: selectedBefore,
      selected_nodes_after: accepted ? candidate.matched_nodes.length : selectedBefore,
      missing_obligations_before: missingBefore,
      missing_obligations_after: accepted ? candidateAssessment.missingObligations.length : missingBefore,
      elapsed_ms: elapsedMs,
      changed_result: accepted && changedResult,
    })
    if (outputBudgetExceeded) {
      budgetExhausted = true
      break
    }
    if (accepted) {
      current = candidate
      currentAssessment = candidateAssessment
      improved = true
    }
    if (currentAssessment.state === 'ready' || currentAssessment.state === 'ready_with_caveat') {
      break
    }
  }

  return {
    ...current,
    ...(initial.retrieval_plan ? { retrieval_plan: initial.retrieval_plan } : {}),
    recovery: {
      version: 1,
      status: recoveryStatus({
        attempted: attempts.length > 0,
        improved,
        finalState: currentAssessment.state,
        noTargets,
        budgetExhausted,
      }),
      budget,
      initial_state: initialAssessment.state,
      final_state: currentAssessment.state,
      attempts,
      improved,
    },
  }
}
