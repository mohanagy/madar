import type {
  RuntimeProofAssessment,
  RuntimeProofObligationAssessment,
  RuntimeProofProfile,
  RuntimeProofProfileObligation,
} from '../contracts/runtime-proof.js'

export interface RuntimeProofCandidate {
  label: string
  source_file: string
  line_number: number
  node_kind?: string | undefined
  framework_role?: string | undefined
}

function normalizeRuntimeProofText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function runtimeProofCandidateText(candidate: Pick<RuntimeProofCandidate, 'label' | 'source_file' | 'node_kind' | 'framework_role'>): string {
  return normalizeRuntimeProofText(
    `${candidate.label} ${candidate.source_file} ${candidate.node_kind ?? ''} ${candidate.framework_role ?? ''}`,
  )
}

function runtimeProofKindBonus(
  candidate: Pick<RuntimeProofCandidate, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
  obligation: RuntimeProofProfileObligation,
): number {
  const text = runtimeProofCandidateText(candidate)
  switch (obligation.kind) {
    case 'entrypoint':
      return /\b(?:route|controller|handler|resolver|endpoint|api)\b/.test(text) ? 4 : 0
    case 'handoff':
      return /\b(?:service|workspace|orchestr|dispatch|process|apply|pipeline)\b/.test(text) ? 3 : 0
    case 'terminal':
      return /\b(?:persist|save|repository|redirect|deliver|notification|analytics|track|event|send)\b/.test(text) ? 4 : 0
  }
}

function runtimeProofMatchedTermCount(
  candidate: Pick<RuntimeProofCandidate, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
  obligation: RuntimeProofProfileObligation,
): number {
  const text = runtimeProofCandidateText(candidate)
  return obligation.evidence_terms.filter((term) => {
    const normalized = normalizeRuntimeProofText(term)
    return normalized.length > 0 && text.includes(normalized)
  }).length
}

export function runtimeProofObligationMatchScore(
  candidate: Pick<RuntimeProofCandidate, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
  obligation: RuntimeProofProfileObligation,
): number {
  return (runtimeProofMatchedTermCount(candidate, obligation) * 3) + runtimeProofKindBonus(candidate, obligation)
}

function runtimeProofHasDirectTerminalSignal(
  candidate: Pick<RuntimeProofCandidate, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  const text = runtimeProofCandidateText(candidate)
  return /\b(?:persist|save|write|store|record|track|emit|event|publish|send|deliver|redirect|notification|webhook|repository|database|render|synthesis)\b/.test(text)
}

export function runtimeProofProvidesDirectEvidence(
  candidate: Pick<RuntimeProofCandidate, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
  obligation: RuntimeProofProfileObligation,
): boolean {
  const matchedTerms = runtimeProofMatchedTermCount(candidate, obligation)
  if (matchedTerms === 0) {
    return false
  }
  switch (obligation.kind) {
    case 'entrypoint':
      return matchedTerms >= 1
    case 'handoff':
      return matchedTerms >= 1 && runtimeProofObligationMatchScore(candidate, obligation) >= 4
    case 'terminal':
      return matchedTerms >= 2 && runtimeProofHasDirectTerminalSignal(candidate)
  }
}

export function runtimeProofAnchorBonus(
  candidate: Pick<RuntimeProofCandidate, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
  profile: RuntimeProofProfile | undefined,
): number {
  if (!profile) {
    return 0
  }
  return Math.max(0, ...profile.obligations.map((obligation) => runtimeProofObligationMatchScore(candidate, obligation)))
}

function dedupeRuntimeProofEvidence(
  evidence: RuntimeProofCandidate[],
): RuntimeProofObligationAssessment['evidence'] {
  const seen = new Set<string>()
  const deduped: RuntimeProofObligationAssessment['evidence'] = []
  for (const entry of evidence) {
    const key = `${entry.source_file}:${entry.line_number}:${entry.label}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push({
      label: entry.label,
      source_file: entry.source_file,
      line_number: entry.line_number,
    })
  }
  return deduped
}

export function buildRuntimeProofAssessment(
  profile: RuntimeProofProfile | undefined,
  candidates: readonly RuntimeProofCandidate[],
): RuntimeProofAssessment | undefined {
  if (!profile) {
    return undefined
  }
  const obligations = profile.obligations.map<RuntimeProofObligationAssessment>((obligation) => {
    const evidence = dedupeRuntimeProofEvidence(
      candidates.filter((candidate) => runtimeProofProvidesDirectEvidence(candidate, obligation)),
    )
    return {
      id: obligation.id,
      label: obligation.label,
      kind: obligation.kind,
      required: true,
      evidence,
    }
  })
  return {
    obligations,
    missing_obligations: obligations.filter((obligation) => obligation.evidence.length === 0).map((obligation) => obligation.id),
  }
}
