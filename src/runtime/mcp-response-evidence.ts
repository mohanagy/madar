import type {
  ContextPackCoverage,
  ContextPackExecutionPhase,
  ContextPackExecutionSlice,
  ContextPackRuntimeGenerationAnswerContract,
} from '../contracts/context-pack.js'
import type { IndexingManifestV1, IndexingReasonCode } from '../contracts/indexing.js'
import {
  readIndexingManifestForGraph,
  relevantIndexingUncertainty,
} from '../infrastructure/indexing-manifest.js'
import { readGraphSourceRoot } from '../shared/graph-source-root.js'
import {
  readDiscoverySafetyMetadata,
  relevantDiscoveryExclusions,
  type DiscoveryExclusionReason,
  type DiscoverySafetyMetadata,
} from '../shared/discovery-safety.js'

export type MadarResponsePackConfidence = 'high' | 'medium' | 'low'
export type MadarResponseCoverage = 'complete' | 'partial' | 'unknown'
export type MadarResponseAgentDirective = 'answer_from_pack' | 'verify_one_targeted_file' | 'explore_with_caution'

export interface MadarResponseEvidence {
  pack_confidence: MadarResponsePackConfidence
  coverage: MadarResponseCoverage
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
  /** Share-safe aggregate. Local paths remain only in indexing-manifest.json. */
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

export function agentDirectiveForEvidence(
  packConfidence: MadarResponsePackConfidence,
  coverage: MadarResponseCoverage,
  answerContained: boolean | undefined = undefined,
): MadarResponseAgentDirective {
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
  const normalizedSourceRoot = normalizeSourcePath(readGraphSourceRoot(graphPath))
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
  answerContract?: ContextPackRuntimeGenerationAnswerContract | undefined
  coverage?: ContextPackCoverage | undefined
  coveredWorkflowOwners?: readonly string[] | undefined
  discoverySafety?: DiscoverySafetyMetadata | null | undefined
  executionSlice?: ContextPackExecutionSlice | undefined
  graphPath?: string | undefined
  indexingManifest?: IndexingManifestV1 | null | undefined
  missingPhases?: readonly ContextPackExecutionPhase[] | undefined
  question?: string | undefined
  score?: number | undefined
}): MadarResponseEvidenceAssessment {
  let coverage = coverageStatusFromCoverage(input.coverage)
  const baseScore = typeof input.score === 'number' && Number.isFinite(input.score)
    ? input.score
    : input.coverage
      ? confidenceScoreFromCoverage(input.coverage)
      : 0.3
  const coveredWorkflowOwners = [...new Set(
    (input.coveredWorkflowOwners ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  )].slice(0, 5)
  const missingPhases = [...new Set((input.missingPhases ?? []).filter((value): value is ContextPackExecutionPhase => typeof value === 'string'))]
  const runtimeGeneration =
    input.answerContract?.answer_focus === 'runtime_generation'
    || input.executionSlice !== undefined
    || missingPhases.length > 0

  let confidenceCap: MadarResponsePackConfidence = 'high'
  const confidenceReasons: string[] = []
  let answerContained: boolean | undefined

  if (runtimeGeneration) {
    const scopeQuality = scopeQualityAssessment(input.graphPath, coveredWorkflowOwners)
    confidenceCap = moreRestrictiveConfidence(confidenceCap, scopeQuality.confidenceCap)
    confidenceReasons.push(scopeQuality.reason)

    const workflowLocality = workflowLocalityAssessment(input.executionSlice)
    confidenceCap = moreRestrictiveConfidence(confidenceCap, workflowLocality.confidenceCap)
    confidenceReasons.push(workflowLocality.reason)

    const phaseCompleteness = phaseCompletenessAssessment(missingPhases)
    confidenceCap = moreRestrictiveConfidence(confidenceCap, phaseCompleteness.confidenceCap)
    confidenceReasons.push(phaseCompleteness.reason)

    const answerContainedness = answerContainednessAssessment(input.executionSlice, input.answerContract, missingPhases)
    answerContained = answerContainedness.answerContained
    confidenceCap = moreRestrictiveConfidence(confidenceCap, answerContainedness.confidenceCap)
    confidenceReasons.push(answerContainedness.reason)

    const runtimeConfidence = input.answerContract?.confidence ?? input.executionSlice?.confidence
    if (runtimeConfidence) {
      const previousConfidenceCap = confidenceCap
      const nextConfidenceCap = moreRestrictiveConfidence(confidenceCap, runtimeConfidence)
      if (nextConfidenceCap !== previousConfidenceCap) {
        const source = input.answerContract?.confidence ? 'answer contract' : 'execution slice'
        confidenceReasons.push(
          `runtime confidence: ${source} reported ${runtimeConfidence} confidence and lowered the cap from ${previousConfidenceCap} to ${nextConfidenceCap}`,
        )
      }
      confidenceCap = nextConfidenceCap
    }
  }

  const discoverySafety = input.discoverySafety !== undefined
    ? input.discoverySafety
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
    const reasonBuckets = Object.entries(discoveryExclusions.relevantReasons)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => `${reason}=${count}`)
      .join(', ')
    confidenceReasons.push(
      `discovery coverage: ${discoveryExclusions.relevant} relevant safety exclusion(s) (${reasonBuckets})`,
    )
  }

  const indexingManifest = input.indexingManifest !== undefined
    ? input.indexingManifest
    : input.graphPath
      ? readIndexingManifestForGraph(input.graphPath)
      : null
  const indexingUncertainty = indexingManifest
    ? relevantIndexingUncertainty(indexingManifest, {
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
    const reasonBuckets = Object.entries(indexingUncertainty.relevant_reasons)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => `${reason}=${count}`)
      .join(', ')
    confidenceReasons.push(
      `indexing completeness: ${indexingUncertainty.relevant} relevant uncertain outcome(s) (${reasonBuckets})`,
    )
  }

  const effectiveScore = roundScore(Math.min(baseScore, confidenceCapForScore(confidenceCap)))
  const packConfidence = packConfidenceFromScore(effectiveScore)

  return {
    score: effectiveScore,
    pack_confidence: packConfidence,
    coverage,
    missing_phases: missingPhases,
    covered_workflow_owners: coveredWorkflowOwners,
    confidence_reasons: confidenceReasons,
    agent_directive: agentDirectiveForEvidence(packConfidence, coverage, answerContained),
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
  answerContract?: ContextPackRuntimeGenerationAnswerContract | undefined
  coverage?: ContextPackCoverage | undefined
  missingPhases?: readonly ContextPackExecutionPhase[] | undefined
  coveredWorkflowOwners?: readonly string[] | undefined
  discoverySafety?: DiscoverySafetyMetadata | null | undefined
  executionSlice?: ContextPackExecutionSlice | undefined
  graphPath?: string | undefined
  indexingManifest?: IndexingManifestV1 | null | undefined
  question?: string | undefined
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
