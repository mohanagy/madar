import type { ContextPackCoverage, ContextPackExecutionPhase } from '../contracts/context-pack.js'

export type MadarResponsePackConfidence = 'high' | 'medium' | 'low'
export type MadarResponseCoverage = 'complete' | 'partial' | 'unknown'
export type MadarResponseAgentDirective = 'answer_from_pack' | 'verify_one_targeted_file' | 'explore_with_caution'

export interface MadarResponseEvidence {
  pack_confidence: MadarResponsePackConfidence
  coverage: MadarResponseCoverage
  missing_phases: ContextPackExecutionPhase[]
  covered_workflow_owners: string[]
  agent_directive: MadarResponseAgentDirective
}

const HIGH_CONFIDENCE_THRESHOLD = 0.85
const MEDIUM_CONFIDENCE_THRESHOLD = 0.5

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
): MadarResponseAgentDirective {
  if (coverage === 'complete' && packConfidence === 'high') {
    return 'answer_from_pack'
  }
  if (coverage !== 'unknown' && packConfidence !== 'low') {
    return 'verify_one_targeted_file'
  }
  return 'explore_with_caution'
}

export function buildMadarResponseEvidence(input: {
  coverage?: ContextPackCoverage | undefined
  missingPhases?: readonly ContextPackExecutionPhase[] | undefined
  coveredWorkflowOwners?: readonly string[] | undefined
  score?: number | undefined
}): MadarResponseEvidence {
  const coverage = coverageStatusFromCoverage(input.coverage)
  const score = typeof input.score === 'number' && Number.isFinite(input.score)
    ? input.score
    : input.coverage
      ? confidenceScoreFromCoverage(input.coverage)
      : 0.3
  const packConfidence = packConfidenceFromScore(score)
  const coveredWorkflowOwners = [...new Set(
    (input.coveredWorkflowOwners ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  )].slice(0, 5)
  const missingPhases = [...new Set((input.missingPhases ?? []).filter((value) => typeof value === 'string'))]

  return {
    pack_confidence: packConfidence,
    coverage,
    missing_phases: missingPhases,
    covered_workflow_owners: coveredWorkflowOwners,
    agent_directive: agentDirectiveForEvidence(packConfidence, coverage),
  }
}
