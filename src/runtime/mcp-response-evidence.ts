import type {
  ContextPackCoverage,
  ContextPackExpandableRef,
  ContextPackExecutionPhase,
  ContextPackExecutionSlice,
  ContextPackRuntimeGenerationAnswerContract,
} from '../contracts/context-pack.js'
import type {
  ContextPackRecoveryPlan,
  MadarAnswerabilityAssessment,
  MadarCoverageAssessment,
  MadarEvidenceStrengthAssessment,
  MadarEvidenceStrengthLevel,
  MadarVerificationTarget,
} from '../contracts/context-recovery.js'
import { loadGraphArtifact } from '../adapters/filesystem/graph-artifact.js'
import {
  readBuildState,
  type IndexBuildState,
  type IndexingReasonCode,
} from '../domain/index/build-state.js'
import type { KnowledgeGraph } from '../domain/graph/directed-multigraph.js'
import { readGraphSourceRoot, resolveGraphSourceRoot } from '../shared/graph-source-root.js'
import {
  parseDiscoverySafetyMetadata,
  readDiscoverySafetyMetadata,
  reasonBuckets,
  relevantDiscoveryExclusions,
  relevantPathEntries,
  type DiscoveryExclusionReason,
  type DiscoverySafetyMetadata,
} from '../shared/discovery-safety.js'
import {
  buildRetrievalEvidencePlan,
  type RetrievalEvidencePlan,
} from './retrieve/pipeline.js'

export type MadarResponsePackConfidence = 'high' | 'medium' | 'low'
export type MadarResponseCoverage = 'complete' | 'partial' | 'unknown'
export type MadarResponseAgentDirective = 'answer_from_pack' | 'verify_one_targeted_file' | 'explore_with_caution'

export interface MadarResponseEvidence {
  /** Compatibility projection for consumers that have not migrated to the independent dimensions below. */
  pack_confidence: MadarResponsePackConfidence
  evidence_strength: MadarEvidenceStrengthAssessment
  coverage: MadarResponseCoverage
  coverage_detail: MadarCoverageAssessment
  answerability: MadarAnswerabilityAssessment
  recovery?: ContextPackRecoveryPlan
  missing_phases: ContextPackExecutionPhase[]
  covered_workflow_owners: string[]
  confidence_reasons: string[]
  agent_directive: MadarResponseAgentDirective
  /** Share-safe aggregate. Local exclusion paths remain only in graph.json and local CLI diagnostics. */
  discovery_exclusions?: {
    policy: 'artifact_path_only'
    total: number
    relevant: number
    reasons: Partial<Record<DiscoveryExclusionReason, number>>
    relevant_reasons: Partial<Record<DiscoveryExclusionReason, number>>
  }
  /** Share-safe aggregate. Exact supported-failure paths remain only in graph.json. */
  indexing_completeness?: {
    state: 'complete' | 'partial' | 'failed'
    total_uncertain: number
    relevant_uncertain: number
    reasons: Partial<Record<IndexingReasonCode, number>>
    relevant_reasons: Partial<Record<IndexingReasonCode, number>>
  }
}

const HIGH_CONFIDENCE_THRESHOLD = 0.85
const MEDIUM_CONFIDENCE_THRESHOLD = 0.5
const MEDIUM_CONFIDENCE_MAX = HIGH_CONFIDENCE_THRESHOLD - 0.01
const LOW_CONFIDENCE_MAX = MEDIUM_CONFIDENCE_THRESHOLD - 0.01
const GENERIC_SCOPE_SEGMENTS = new Set(['src', 'test', 'tests', 'docs', 'lib', 'libs', 'packages', 'apps'])
const GENERIC_SCOPE_WRAPPERS = new Set(['libs', 'packages', 'apps'])

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100
}

export function confidenceScoreFromCoverage(coverage: ContextPackCoverage): number {
  const requiredEntries = coverage.entries.filter((entry) => entry.required)
  const requiredCovered = requiredEntries.filter((entry) => entry.status === 'covered').length
  const semanticEntries = coverage.semantic_entries.filter((entry) => entry.required)
  const semanticCovered = semanticEntries.filter((entry) => entry.status === 'covered').length
  const requiredScore = requiredEntries.length > 0 ? requiredCovered / requiredEntries.length : 1
  const semanticScore = semanticEntries.length > 0 ? semanticCovered / semanticEntries.length : 1
  const relationshipScore = coverage.available_relationships > 0
    ? coverage.selected_relationships / coverage.available_relationships
    : 1

  let score = (requiredScore * 0.55) + (semanticScore * 0.3) + (relationshipScore * 0.15)
  score -= Math.min(0.15, coverage.missing_required.length * 0.03)
  score -= Math.min(0.1, coverage.missing_semantic.length * 0.02)
  return roundScore(score)
}

export function coverageStatusFromCoverage(coverage?: ContextPackCoverage): MadarResponseCoverage {
  if (!coverage) {
    return 'unknown'
  }

  return coverage.missing_required.length === 0 && coverage.missing_semantic.length === 0
    ? 'complete'
    : 'partial'
}

export function packConfidenceFromScore(score: number): MadarResponsePackConfidence {
  if (score >= HIGH_CONFIDENCE_THRESHOLD) {
    return 'high'
  }
  if (score >= MEDIUM_CONFIDENCE_THRESHOLD) {
    return 'medium'
  }
  return 'low'
}

function evidenceStrengthFromCoverage(
  coverage: ContextPackCoverage | undefined,
  executionSlice: ContextPackExecutionSlice | undefined,
): MadarEvidenceStrengthAssessment {
  const coveredDirectNodes = coverage?.entries
    .filter((entry) => entry.evidence_class === 'primary' || entry.evidence_class === 'change')
    .reduce((total, entry) => total + entry.selected_nodes, 0) ?? 0
  const executionNodeCount = new Set(
    (executionSlice?.steps ?? []).map((step) => step.node_id ?? `${step.source_file}\u0000${step.label}`),
  ).size
  // Execution slices are built from selected graph nodes. Count them as direct
  // evidence when an older or externally constructed coverage payload omits
  // per-class entry counts.
  const directSelectedNodes = Math.max(coveredDirectNodes, executionNodeCount)
  const supportingSelectedNodes = coverage?.entries
    .filter((entry) => entry.evidence_class !== 'primary' && entry.evidence_class !== 'change')
    .reduce((total, entry) => total + entry.selected_nodes, 0) ?? 0
  const selectedRelationships = coverage?.selected_relationships ?? 0
  const availableRelationships = coverage?.available_relationships ?? 0
  const hasRuntimeSpine = (executionSlice?.steps.length ?? 0) >= 2
  const reasons: string[] = []

  let level: MadarEvidenceStrengthLevel
  if (directSelectedNodes > 0 && (selectedRelationships > 0 || hasRuntimeSpine)) {
    level = 'strong'
    reasons.push('direct_evidence_with_relationship_support')
  } else if (directSelectedNodes + supportingSelectedNodes > 0) {
    level = 'moderate'
    reasons.push('selected_evidence_without_complete_relationship_support')
  } else {
    level = 'weak'
    reasons.push('no_selected_evidence')
  }

  const runtimeConfidence = executionSlice?.confidence
  if (runtimeConfidence === 'low' && level !== 'weak') {
    level = 'weak'
    reasons.push('runtime_evidence_reported_low_strength')
  } else if (runtimeConfidence === 'medium' && level === 'strong') {
    level = 'moderate'
    reasons.push('runtime_evidence_reported_moderate_strength')
  }

  return {
    level,
    direct_selected_nodes: directSelectedNodes,
    supporting_selected_nodes: supportingSelectedNodes,
    selected_relationships: selectedRelationships,
    available_relationships: availableRelationships,
    reasons,
  }
}

function capEvidenceStrength(
  assessment: MadarEvidenceStrengthAssessment,
  cap: MadarEvidenceStrengthLevel,
  reason: string,
): MadarEvidenceStrengthAssessment {
  const rank: Record<MadarEvidenceStrengthLevel, number> = { weak: 0, moderate: 1, strong: 2 }
  if (rank[assessment.level] <= rank[cap]) {
    return assessment.reasons.includes(reason)
      ? assessment
      : { ...assessment, reasons: [...assessment.reasons, reason] }
  }
  return {
    ...assessment,
    level: cap,
    reasons: [...assessment.reasons, reason],
  }
}

function baseCoverageAssessment(
  coverage: ContextPackCoverage | undefined,
  status: MadarResponseCoverage,
  missingPhases: readonly ContextPackExecutionPhase[],
  queryEvidence: RetrievalEvidencePlan['query_evidence'],
): MadarCoverageAssessment {
  const requiredEvidence = coverage?.entries.filter((entry) => entry.required) ?? []
  const requiredSemantic = coverage?.semantic_entries.filter((entry) => entry.required) ?? []
  const requiredObligations = [
    ...requiredEvidence.map((entry) => `evidence:${entry.evidence_class}`),
    ...requiredSemantic.map((entry) => `semantic:${entry.category}`),
    ...missingPhases.map((phase) => `phase:${phase}`),
    ...(queryEvidence?.covered_obligations ?? []),
    ...(queryEvidence?.missing_obligations ?? []),
  ]
  const coveredObligations = [
    ...requiredEvidence.filter((entry) => entry.status === 'covered').map((entry) => `evidence:${entry.evidence_class}`),
    ...requiredSemantic.filter((entry) => entry.status === 'covered').map((entry) => `semantic:${entry.category}`),
    ...(queryEvidence?.covered_obligations ?? []),
  ]
  const missingObligations = [
    ...requiredEvidence.filter((entry) => entry.status !== 'covered').map((entry) => `evidence:${entry.evidence_class}`),
    ...requiredSemantic.filter((entry) => entry.status !== 'covered').map((entry) => `semantic:${entry.category}`),
    ...missingPhases.map((phase) => `phase:${phase}`),
    ...(queryEvidence?.missing_obligations ?? []),
  ]
  return {
    status: queryEvidence && queryEvidence.missing_obligations.length > 0 ? 'partial' : status,
    required_obligations: [...new Set(requiredObligations)],
    covered_obligations: [...new Set(coveredObligations)],
    missing_obligations: [...new Set(missingObligations)],
  }
}

function addMissingObligations(
  assessment: MadarCoverageAssessment,
  obligations: readonly string[],
): MadarCoverageAssessment {
  if (obligations.length === 0) {
    return assessment
  }
  return {
    ...assessment,
    status: 'partial',
    required_obligations: [...new Set([...assessment.required_obligations, ...obligations])],
    missing_obligations: [...new Set([...assessment.missing_obligations, ...obligations])],
  }
}

function verificationTargets(
  expandable: readonly ContextPackExpandableRef[],
  coveredWorkflowOwners: readonly string[],
  missingObligations: readonly string[],
): MadarVerificationTarget[] {
  const missingEvidence = new Set(
    missingObligations
      .filter((obligation) => obligation.startsWith('evidence:'))
      .map((obligation) => obligation.slice('evidence:'.length)),
  )
  const relevantExpandable = missingEvidence.size > 0
    ? expandable.filter((entry) => missingEvidence.has(entry.evidence_class))
    : expandable
  const ordered = [...relevantExpandable].sort((left, right) => (
    Number(missingEvidence.has(right.evidence_class)) - Number(missingEvidence.has(left.evidence_class))
    || left.handle_id.localeCompare(right.handle_id)
  ))
  const targets = ordered.slice(0, 4).map((entry): MadarVerificationTarget => ({
    handle_id: entry.handle_id,
    evidence_class: entry.evidence_class,
    focus_files: [...new Set(entry.follow_up.focus_files)].slice(0, 5),
    focus_ranges: entry.follow_up.focus_ranges.slice(0, 5),
    reason: missingEvidence.has(entry.evidence_class)
      ? `verify missing evidence:${entry.evidence_class}`
      : `verify evidence:${entry.evidence_class} for ${missingObligations[0] ?? 'unresolved coverage'}`,
  }))
  if (targets.length > 0 || coveredWorkflowOwners.length === 0 || missingObligations.length === 0) {
    return targets
  }
  return [{
    focus_files: coveredWorkflowOwners.slice(0, 3),
    focus_ranges: [],
    reason: `verify ${missingObligations[0]}`,
  }]
}

function answerabilityAssessment(input: {
  strength: MadarEvidenceStrengthAssessment
  coverage: MadarCoverageAssessment
  answerContained: boolean | undefined
  verificationTargets: MadarVerificationTarget[]
  sourceReliabilityFailed: boolean
  sourceVerificationBlocked: boolean
}): MadarAnswerabilityAssessment {
  const selectedEvidence = input.strength.direct_selected_nodes + input.strength.supporting_selected_nodes
  const complete = input.coverage.status === 'complete'
    && input.coverage.missing_obligations.length === 0
    && input.answerContained !== false

  if (input.sourceReliabilityFailed) {
    return {
      state: 'insufficient',
      answer_scope: 'none',
      caveats: ['source reliability is incomplete'],
      missing_obligations: input.coverage.missing_obligations,
      verification_targets: [],
      broad_search_fallback: input.sourceVerificationBlocked ? 'blocked' : 'allowed',
    }
  }

  if (complete && input.strength.level === 'strong') {
    return {
      state: 'ready',
      answer_scope: 'complete',
      caveats: [],
      missing_obligations: [],
      verification_targets: [],
      broad_search_fallback: 'not_needed',
    }
  }
  if (complete && input.strength.level === 'moderate') {
    return {
      state: 'ready_with_caveat',
      answer_scope: 'complete',
      caveats: [...input.strength.reasons],
      missing_obligations: [],
      verification_targets: [],
      broad_search_fallback: 'not_needed',
    }
  }
  if (input.verificationTargets.length > 0) {
    return {
      state: 'verify_targets',
      answer_scope: selectedEvidence > 0 ? 'partial' : 'none',
      caveats: selectedEvidence > 0 ? [] : ['no selected evidence; verify the exact target'],
      missing_obligations: input.coverage.missing_obligations,
      verification_targets: input.verificationTargets,
      broad_search_fallback: 'targeted_only',
    }
  }
  return {
    state: 'insufficient',
    answer_scope: 'none',
    caveats: ['no usable evidence or verification target'],
    missing_obligations: input.coverage.missing_obligations,
    verification_targets: [],
    broad_search_fallback: input.sourceVerificationBlocked ? 'blocked' : 'allowed',
  }
}

function compatibilityConfidence(
  answerability: MadarAnswerabilityAssessment,
  strength: MadarEvidenceStrengthAssessment,
  sourceReliabilityFailed: boolean,
): MadarResponsePackConfidence {
  if (answerability.state === 'insufficient' || sourceReliabilityFailed) {
    return 'low'
  }
  if (answerability.state === 'ready' && strength.level === 'strong') {
    return 'high'
  }
  return 'medium'
}

export function agentDirectiveForEvidence(
  packConfidence: MadarResponsePackConfidence,
  coverage: MadarResponseCoverage,
  answerContained: boolean | undefined = undefined,
  answerability?: MadarAnswerabilityAssessment,
): MadarResponseAgentDirective {
  if (answerability) {
    if (answerability.state === 'ready' || answerability.state === 'ready_with_caveat') {
      return 'answer_from_pack'
    }
    if (answerability.state === 'verify_targets') {
      return 'verify_one_targeted_file'
    }
    return 'explore_with_caution'
  }
  if ((answerContained ?? true) && coverage === 'complete' && packConfidence === 'high') {
    return 'answer_from_pack'
  }
  if (coverage !== 'unknown' && packConfidence !== 'low') {
    return 'verify_one_targeted_file'
  }
  return 'explore_with_caution'
}

export interface MadarResponseEvidenceAssessment extends MadarResponseEvidence {
  score: number
}

function normalizeSourcePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.?\//, '')
}

function readIndexBuildStateForGraph(graphPath: string): IndexBuildState | null {
  try {
    return readBuildState(loadGraphArtifact(graphPath))
  } catch {
    return null
  }
}

function relevantSupportedIndexingUncertainty(
  state: IndexBuildState,
  input: { question?: string; coveredWorkflowOwners?: readonly string[] } = {},
) {
  const failures = state.completeness.supported_failures
  const relevant = relevantPathEntries(failures, input)
  return {
    total: failures.length,
    relevant: relevant.length,
    state: state.completeness.summary.state,
    reasons: reasonBuckets(failures),
    relevant_reasons: reasonBuckets(relevant),
    has_relevant_failures: relevant.length > 0,
  }
}

function confidenceCapForScore(confidence: MadarResponsePackConfidence): number {
  switch (confidence) {
    case 'high':
      return 1
    case 'medium':
      return MEDIUM_CONFIDENCE_MAX
    case 'low':
      return LOW_CONFIDENCE_MAX
  }
}

function moreRestrictiveConfidence(
  current: MadarResponsePackConfidence,
  next: MadarResponsePackConfidence,
): MadarResponsePackConfidence {
  const rank: Record<MadarResponsePackConfidence, number> = {
    high: 2,
    medium: 1,
    low: 0,
  }
  return rank[next] < rank[current] ? next : current
}

function scopeQualityAssessment(
  graphPath: string | undefined,
  coveredWorkflowOwners: readonly string[],
  graph?: KnowledgeGraph,
): {
  confidenceCap: MadarResponsePackConfidence
  reason: string
} {
  if (!graphPath) {
    return {
      confidenceCap: 'high',
      reason: 'scope quality: graph scope was not provided, so scope alignment could not be checked',
    }
  }

  const normalizedGraphPath = normalizeSourcePath(graphPath)
  const candidateScopes = [...new Set(
    coveredWorkflowOwners
      .map(normalizeSourcePath)
      .map((value) => {
        const segments = value
          .split('/')
          .filter((segment) => segment.length > 0)
        if (segments.length === 0) {
          return ''
        }
        const genericIndex = segments.findIndex((segment) => GENERIC_SCOPE_SEGMENTS.has(segment.toLowerCase()))
        if (genericIndex > 0) {
          const candidate = segments[genericIndex - 1]
          if (candidate && !/^[A-Za-z]:$/.test(candidate)) {
            return candidate
          }
        }
        const [firstSegment, secondSegment] = segments
        if (segments.length > 1 && firstSegment && secondSegment && GENERIC_SCOPE_WRAPPERS.has(firstSegment.toLowerCase())) {
          return secondSegment
        }
        return /^[A-Za-z]:$/.test(firstSegment ?? '') ? (secondSegment ?? '') : (firstSegment ?? '')
      })
      .filter((value): value is string => value.length > 0 && !GENERIC_SCOPE_SEGMENTS.has(value.toLowerCase())),
  )]
  if (candidateScopes.length !== 1) {
    return {
      confidenceCap: 'high',
      reason: 'scope quality: retrieved workflow owners do not point to one narrower subproject scope',
    }
  }

  const expectedGraphPath = `${candidateScopes[0]}/out/graph.json`
  const normalizedSourceRoot = normalizeSourcePath(
    graph ? resolveGraphSourceRoot(graphPath, graph) : readGraphSourceRoot(graphPath),
  )
  const sourceRootMatchesScope = normalizedSourceRoot === candidateScopes[0]
    || normalizedSourceRoot.endsWith(`/${candidateScopes[0]}`)
  if (normalizedGraphPath === expectedGraphPath || normalizedGraphPath.endsWith(`/${expectedGraphPath}`) || sourceRootMatchesScope) {
    return {
      confidenceCap: 'high',
      reason: `scope quality: graph scope is aligned with the ${candidateScopes[0]} runtime evidence`,
    }
  }

  return {
    confidenceCap: 'medium',
    reason: `scope quality: runtime evidence is concentrated under ${candidateScopes[0]}/ while the graph is rooted at ${normalizedGraphPath}`,
  }
}

function workflowLocalityAssessment(
  executionSlice: ContextPackExecutionSlice | undefined,
): {
  confidenceCap: MadarResponsePackConfidence
  reason: string
} {
  if (!executionSlice) {
    return {
      confidenceCap: 'medium',
      reason: 'workflow locality: no execution spine was captured for this answer',
    }
  }

  if (executionSlice.steps.length >= 2) {
    return {
      confidenceCap: 'high',
      reason: 'workflow locality: runtime evidence stays on one coherent workflow spine',
    }
  }

  return {
    confidenceCap: 'medium',
    reason: 'workflow locality: runtime evidence is too shallow to prove one coherent workflow spine',
  }
}

function phaseCompletenessAssessment(
  missingPhases: readonly ContextPackExecutionPhase[],
): {
  confidenceCap: MadarResponsePackConfidence
  reason: string
} {
  if (missingPhases.length === 0) {
    return {
      confidenceCap: 'high',
      reason: 'phase completeness: critical runtime phases are present in the pack',
    }
  }

  return {
    confidenceCap: missingPhases.length >= 3 ? 'low' : 'medium',
    reason: `phase completeness: missing ${missingPhases.join(', ')}`,
  }
}

function answerContainednessAssessment(
  executionSlice: ContextPackExecutionSlice | undefined,
  answerContract: ContextPackRuntimeGenerationAnswerContract | undefined,
  missingPhases: readonly ContextPackExecutionPhase[],
): {
  answerContained: boolean | undefined
  confidenceCap: MadarResponsePackConfidence
  reason: string
} {
  const runtimeGeneration =
    answerContract?.answer_focus === 'runtime_generation'
    || executionSlice !== undefined
    || missingPhases.length > 0
  if (!runtimeGeneration) {
    return {
      answerContained: undefined,
      confidenceCap: 'high',
      reason: 'answer containedness: no runtime-generation containment check was needed',
    }
  }

  const confidence = answerContract?.confidence ?? executionSlice?.confidence
  const contained =
    executionSlice !== undefined
    && missingPhases.length === 0
    && executionSlice.status !== 'partial'
    && confidence !== 'low'
  if (contained) {
    return {
      answerContained: true,
      confidenceCap: 'high',
      reason: 'answer containedness: the pack contains a complete runtime answer without raw reads',
    }
  }

  return {
    answerContained: false,
    confidenceCap: missingPhases.length >= 3 || confidence === 'low' ? 'low' : 'medium',
    reason: 'answer containedness: the pack does not contain a complete runtime answer without raw reads',
  }
}

export function assessMadarResponseEvidence(input: {
  evidencePlan?: RetrievalEvidencePlan | undefined
  answerContract?: ContextPackRuntimeGenerationAnswerContract | undefined
  coverage?: ContextPackCoverage | undefined
  coveredWorkflowOwners?: readonly string[] | undefined
  discoverySafety?: DiscoverySafetyMetadata | null | undefined
  expandable?: readonly ContextPackExpandableRef[] | undefined
  executionSlice?: ContextPackExecutionSlice | undefined
  graphPath?: string | undefined
  graph?: KnowledgeGraph | undefined
  indexBuildState?: IndexBuildState | null | undefined
  /** @deprecated Derived manifests are deliberately ignored as evidence authority. */
  indexingManifest?: unknown
  missingPhases?: readonly ContextPackExecutionPhase[] | undefined
  question?: string | undefined
  recovery?: ContextPackRecoveryPlan | undefined
  score?: number | undefined
}): MadarResponseEvidenceAssessment {
  const evidencePlan = input.evidencePlan ?? buildRetrievalEvidencePlan({
    ...(input.coverage ? { coverage: input.coverage } : {}),
    ...(input.expandable ? { expandable: input.expandable } : {}),
    ...(input.executionSlice ? { executionSlice: input.executionSlice } : {}),
    ...(input.answerContract ? { answerContract: input.answerContract } : {}),
    ...(input.missingPhases ? { missingPhases: input.missingPhases } : {}),
    ...(input.coveredWorkflowOwners ? { coveredWorkflowOwners: input.coveredWorkflowOwners } : {}),
    selectedNodeCount: input.coverage?.entries.reduce((total, entry) => total + entry.selected_nodes, 0) ?? 0,
    selectedRelationshipCount: input.coverage?.selected_relationships ?? 0,
  })
  const plannedCoverage = evidencePlan.coverage
  const plannedExecutionSlice = evidencePlan.execution_slice
  const plannedAnswerContract = evidencePlan.answer_contract
  let coverage = coverageStatusFromCoverage(plannedCoverage)
  if ((evidencePlan.query_evidence?.missing_obligations.length ?? 0) > 0) {
    coverage = 'partial'
  }
  const baseScore = typeof input.score === 'number' && Number.isFinite(input.score)
    ? input.score
    : plannedCoverage
      ? confidenceScoreFromCoverage(plannedCoverage)
      : 0.3
  const coveredWorkflowOwners = [...new Set(
    evidencePlan.covered_workflow_owners
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  )].slice(0, 5)
  const missingPhases = [...new Set(evidencePlan.missing_phases.filter((value): value is ContextPackExecutionPhase => typeof value === 'string'))]
  const runtimeGeneration =
    plannedAnswerContract?.answer_focus === 'runtime_generation'
    || plannedExecutionSlice !== undefined
    || missingPhases.length > 0

  let confidenceCap: MadarResponsePackConfidence = 'high'
  const confidenceReasons: string[] = []
  let answerContained: boolean | undefined
  let evidenceStrength = evidenceStrengthFromCoverage(plannedCoverage, plannedExecutionSlice)
  let coverageDetail = baseCoverageAssessment(
    plannedCoverage,
    coverage,
    missingPhases,
    evidencePlan.query_evidence,
  )
  let sourceReliabilityFailed = false
  let sourceVerificationBlocked = false

  if (runtimeGeneration) {
    const scopeQuality = scopeQualityAssessment(input.graphPath, coveredWorkflowOwners, input.graph)
    confidenceCap = moreRestrictiveConfidence(confidenceCap, scopeQuality.confidenceCap)
    confidenceReasons.push(scopeQuality.reason)
    if (scopeQuality.confidenceCap !== 'high') {
      evidenceStrength = capEvidenceStrength(
        evidenceStrength,
        'moderate',
        'graph_scope_alignment_unverified',
      )
    }

    const workflowLocality = workflowLocalityAssessment(plannedExecutionSlice)
    confidenceCap = moreRestrictiveConfidence(confidenceCap, workflowLocality.confidenceCap)
    confidenceReasons.push(workflowLocality.reason)
    if (workflowLocality.confidenceCap !== 'high') {
      evidenceStrength = capEvidenceStrength(
        evidenceStrength,
        'moderate',
        'runtime_workflow_locality_shallow',
      )
    }

    const phaseCompleteness = phaseCompletenessAssessment(missingPhases)
    confidenceCap = moreRestrictiveConfidence(confidenceCap, phaseCompleteness.confidenceCap)
    confidenceReasons.push(phaseCompleteness.reason)

    const answerContainedness = answerContainednessAssessment(plannedExecutionSlice, plannedAnswerContract, missingPhases)
    answerContained = answerContainedness.answerContained
    confidenceCap = moreRestrictiveConfidence(confidenceCap, answerContainedness.confidenceCap)
    confidenceReasons.push(answerContainedness.reason)

    const runtimeConfidence = plannedAnswerContract?.confidence ?? plannedExecutionSlice?.confidence
    if (runtimeConfidence) {
      const previousConfidenceCap = confidenceCap
      const nextConfidenceCap = moreRestrictiveConfidence(confidenceCap, runtimeConfidence)
      if (nextConfidenceCap !== previousConfidenceCap) {
        const source = plannedAnswerContract?.confidence ? 'answer contract' : 'execution slice'
        confidenceReasons.push(
          `runtime confidence: ${source} reported ${runtimeConfidence} confidence and lowered the cap from ${previousConfidenceCap} to ${nextConfidenceCap}`,
        )
      }
      confidenceCap = nextConfidenceCap
      if (runtimeConfidence !== 'high') {
        evidenceStrength = capEvidenceStrength(
          evidenceStrength,
          runtimeConfidence === 'low' ? 'weak' : 'moderate',
          `runtime_answer_contract_reported_${runtimeConfidence}_strength`,
        )
      }
    }
  }

  if ((evidencePlan.query_evidence?.missing_obligations.length ?? 0) > 0) {
    evidenceStrength = capEvidenceStrength(
      evidenceStrength,
      'moderate',
      'selected_snippets_do_not_cover_all_query_obligations',
    )
    confidenceCap = moreRestrictiveConfidence(confidenceCap, 'medium')
    confidenceReasons.push(
      `query evidence: ${evidencePlan.query_evidence?.covered ?? 0}/${evidencePlan.query_evidence?.total ?? 0} prompt obligations have snippet-bearing evidence`,
    )
  }

  if (answerContained === false) {
    if (coverage === 'complete') {
      coverage = 'partial'
    }
    coverageDetail = addMissingObligations(coverageDetail, ['runtime:answer_containedness'])
  }

  const discoverySafety = input.discoverySafety !== undefined
    ? input.discoverySafety
    : input.graph
      ? parseDiscoverySafetyMetadata(input.graph.graph.discovery_safety)
    : input.graphPath
      ? readDiscoverySafetyMetadata(input.graphPath)
      : null
  const discoveryExclusions = discoverySafety
    ? relevantDiscoveryExclusions(discoverySafety, {
        ...(input.question ? { question: input.question } : {}),
        coveredWorkflowOwners,
      })
    : null
  if (discoveryExclusions && discoveryExclusions.relevant > 0) {
    const exclusionCap: MadarResponsePackConfidence = discoveryExclusions.hasUnreadable ? 'low' : 'medium'
    confidenceCap = moreRestrictiveConfidence(confidenceCap, exclusionCap)
    if (coverage === 'complete') {
      coverage = 'partial'
    }
    evidenceStrength = capEvidenceStrength(
      evidenceStrength,
      discoveryExclusions.hasUnreadable ? 'weak' : 'moderate',
      discoveryExclusions.hasUnreadable ? 'relevant_unreadable_source' : 'relevant_policy_exclusion',
    )
    sourceReliabilityFailed ||= discoveryExclusions.hasUnreadable
    sourceVerificationBlocked = true
    coverageDetail = addMissingObligations(
      coverageDetail,
      Object.keys(discoveryExclusions.relevantReasons).sort().map((reason) => `discovery:${reason}`),
    )
    const reasonBuckets = Object.entries(discoveryExclusions.relevantReasons)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => `${reason}=${count}`)
      .join(', ')
    confidenceReasons.push(
      `discovery coverage: ${discoveryExclusions.relevant} relevant safety exclusion(s) (${reasonBuckets})`,
    )
  }

  const indexBuildState = input.indexBuildState !== undefined
    ? input.indexBuildState
    : input.graph
      ? readBuildState(input.graph)
    : input.graphPath
      ? readIndexBuildStateForGraph(input.graphPath)
      : null
  const indexingUncertainty = indexBuildState
    ? relevantSupportedIndexingUncertainty(indexBuildState, {
        ...(input.question ? { question: input.question } : {}),
        coveredWorkflowOwners,
      })
    : null
  if (indexingUncertainty && indexingUncertainty.relevant > 0) {
    confidenceCap = moreRestrictiveConfidence(
      confidenceCap,
      indexingUncertainty.has_relevant_failures ? 'low' : 'medium',
    )
    if (coverage === 'complete') {
      coverage = 'partial'
    }
    evidenceStrength = capEvidenceStrength(
      evidenceStrength,
      indexingUncertainty.has_relevant_failures ? 'weak' : 'moderate',
      indexingUncertainty.has_relevant_failures ? 'relevant_indexing_failure' : 'relevant_indexing_uncertainty',
    )
    sourceReliabilityFailed ||= indexingUncertainty.has_relevant_failures
    coverageDetail = addMissingObligations(
      coverageDetail,
      Object.keys(indexingUncertainty.relevant_reasons).sort().map((reason) => `indexing:${reason}`),
    )
    const reasonBuckets = Object.entries(indexingUncertainty.relevant_reasons)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => `${reason}=${count}`)
      .join(', ')
    confidenceReasons.push(
      `indexing completeness: ${indexingUncertainty.relevant} relevant uncertain outcome(s) (${reasonBuckets})`,
    )
  }

  const effectiveScore = roundScore(Math.min(baseScore, confidenceCapForScore(confidenceCap)))
  coverageDetail = { ...coverageDetail, status: coverage }
  const targets = verificationTargets(
    evidencePlan.expandable,
    coveredWorkflowOwners,
    coverageDetail.missing_obligations,
  )
  const answerability = answerabilityAssessment({
    strength: evidenceStrength,
    coverage: coverageDetail,
    answerContained,
    verificationTargets: targets,
    sourceReliabilityFailed,
    sourceVerificationBlocked,
  })
  const packConfidence = compatibilityConfidence(answerability, evidenceStrength, sourceReliabilityFailed)

  return {
    score: effectiveScore,
    pack_confidence: packConfidence,
    evidence_strength: evidenceStrength,
    coverage,
    coverage_detail: coverageDetail,
    answerability,
    ...(input.recovery ? { recovery: input.recovery } : {}),
    missing_phases: missingPhases,
    covered_workflow_owners: coveredWorkflowOwners,
    confidence_reasons: confidenceReasons,
    agent_directive: agentDirectiveForEvidence(packConfidence, coverage, answerContained, answerability),
    ...(discoveryExclusions && discoveryExclusions.total > 0
      ? {
          discovery_exclusions: {
            policy: 'artifact_path_only' as const,
            total: discoveryExclusions.total,
            relevant: discoveryExclusions.relevant,
            reasons: discoveryExclusions.reasons,
            relevant_reasons: discoveryExclusions.relevantReasons,
          },
        }
      : {}),
    ...(indexingUncertainty && indexingUncertainty.total > 0
      ? {
          indexing_completeness: {
            state: indexingUncertainty.state,
            total_uncertain: indexingUncertainty.total,
            relevant_uncertain: indexingUncertainty.relevant,
            reasons: indexingUncertainty.reasons,
            relevant_reasons: indexingUncertainty.relevant_reasons,
          },
        }
      : {}),
  }
}

export function buildMadarResponseEvidence(input: {
  evidencePlan?: RetrievalEvidencePlan | undefined
  answerContract?: ContextPackRuntimeGenerationAnswerContract | undefined
  coverage?: ContextPackCoverage | undefined
  missingPhases?: readonly ContextPackExecutionPhase[] | undefined
  coveredWorkflowOwners?: readonly string[] | undefined
  discoverySafety?: DiscoverySafetyMetadata | null | undefined
  expandable?: readonly ContextPackExpandableRef[] | undefined
  executionSlice?: ContextPackExecutionSlice | undefined
  graphPath?: string | undefined
  graph?: KnowledgeGraph | undefined
  indexBuildState?: IndexBuildState | null | undefined
  /** @deprecated Derived manifests are deliberately ignored as evidence authority. */
  indexingManifest?: unknown
  question?: string | undefined
  recovery?: ContextPackRecoveryPlan | undefined
  score?: number | undefined
}): MadarResponseEvidence {
  const { score: _score, ...evidence } = assessMadarResponseEvidence(input)
  return evidence
}

export function collectWorkflowOwners(...groups: Array<readonly (string | null | undefined)[]>): string[] {
  const seen = new Set<string>()
  const owners: string[] = []

  for (const group of groups) {
    for (const value of group) {
      const normalized = typeof value === 'string' ? value.trim() : ''
      if (normalized.length === 0 || seen.has(normalized)) {
        continue
      }
      seen.add(normalized)
      owners.push(normalized)
      if (owners.length >= 5) {
        return owners
      }
    }
  }

  return owners
}

export function missingPhasesFromPayload(
  payload: Partial<{
    answer_contract: { missing_phases?: readonly unknown[] }
    execution_slice: { phase_coverage?: { missing?: readonly unknown[] } }
  }>,
): ContextPackExecutionPhase[] {
  const fromAnswer = Array.isArray(payload.answer_contract?.missing_phases)
    ? payload.answer_contract.missing_phases.filter((value): value is ContextPackExecutionPhase => typeof value === 'string')
    : []
  const fromSlice = Array.isArray(payload.execution_slice?.phase_coverage?.missing)
    ? payload.execution_slice.phase_coverage.missing.filter((value): value is ContextPackExecutionPhase => typeof value === 'string')
    : []
  return [...new Set([...fromAnswer, ...fromSlice])]
}
