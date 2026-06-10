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

function runtimeProofCandidateIsFileLike(
  candidate: Pick<RuntimeProofCandidate, 'label'>,
): boolean {
  return /(?:^|\/)[^/]+\.[cm]?[jt]sx?$/i.test(candidate.label)
}

function normalizeRuntimeProofText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function runtimeProofCandidateText(candidate: Pick<RuntimeProofCandidate, 'label' | 'source_file' | 'node_kind' | 'framework_role'>): string {
  return normalizeRuntimeProofText(
    `${candidate.label} ${candidate.source_file} ${candidate.node_kind ?? ''} ${candidate.framework_role ?? ''}`,
  )
}

function runtimeProofCandidateRawText(candidate: Pick<RuntimeProofCandidate, 'label' | 'source_file' | 'node_kind' | 'framework_role'>): string {
  return `${candidate.label} ${candidate.source_file} ${candidate.node_kind ?? ''} ${candidate.framework_role ?? ''}`.toLowerCase()
}

function runtimeProofCandidateDirectText(
  candidate: Pick<RuntimeProofCandidate, 'label' | 'node_kind' | 'framework_role'>,
): string {
  return normalizeRuntimeProofText(
    `${candidate.label} ${candidate.node_kind ?? ''} ${candidate.framework_role ?? ''}`,
  )
}

function runtimeProofCandidateDirectRawText(
  candidate: Pick<RuntimeProofCandidate, 'label' | 'node_kind' | 'framework_role'>,
): string {
  return `${candidate.label} ${candidate.node_kind ?? ''} ${candidate.framework_role ?? ''}`.toLowerCase()
}

function runtimeProofPrefersLiteralTermMatch(term: string): boolean {
  return /[()[\]{}\/._:-]/.test(term)
}

function runtimeProofTextMatchesTerm(
  normalizedText: string,
  rawText: string,
  term: string,
): boolean {
  const trimmed = term.trim()
  if (trimmed.length === 0) {
    return false
  }
  if (runtimeProofPrefersLiteralTermMatch(trimmed)) {
    return rawText.includes(trimmed.toLowerCase())
  }
  const normalized = normalizeRuntimeProofText(trimmed)
  return normalized.length > 0 && normalizedText.includes(normalized)
}

function runtimeProofKindBonus(
  candidate: Pick<RuntimeProofCandidate, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
  obligation: RuntimeProofProfileObligation,
): number {
  const text = runtimeProofCandidateText(candidate)
  switch (obligation.kind) {
    case 'entrypoint':
      return /\b(?:route|controller|handler|resolver|endpoint|api|middleware)\b/.test(text) ? 4 : 0
    case 'handoff':
      return /\b(?:service|workspace|orchestr|dispatch|process|apply|pipeline)\b/.test(text) ? 3 : 0
    case 'terminal':
      return /\b(?:persist|save|repository|redirect|deliver|notification|analytics|track|event|send)\b/.test(text) ? 4 : 0
  }
}

function runtimeProofHasEntrypointSignal(
  candidate: Pick<RuntimeProofCandidate, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  return /\b(?:route|controller|resolver|endpoint|api|middleware)\b/.test(runtimeProofCandidateDirectText(candidate))
    || /(?:^|\/)(?:api|controllers?|routes?|middleware)(?:\/|$)|(?:^|\/)route\.[cm]?[jt]sx?$/i.test(candidate.source_file)
    || /\b(?:route_handler|controller_route|express_handler|express_middleware|express_error_middleware)\b/.test(String(candidate.framework_role ?? ''))
}

function runtimeProofMatchedTermCount(
  candidate: Pick<RuntimeProofCandidate, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
  obligation: RuntimeProofProfileObligation,
): number {
  return obligation.evidence_terms.filter((term) =>
    runtimeProofTextMatchesTerm(
      runtimeProofCandidateText(candidate),
      runtimeProofCandidateRawText(candidate),
      term,
    )
  ).length
}

export function runtimeProofObligationTermMatchCount(
  candidate: Pick<RuntimeProofCandidate, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
  obligation: RuntimeProofProfileObligation,
): number {
  return runtimeProofMatchedTermCount(candidate, obligation)
}

function runtimeProofMatchedDirectTermCount(
  candidate: Pick<RuntimeProofCandidate, 'label' | 'node_kind' | 'framework_role'>,
  obligation: RuntimeProofProfileObligation,
): number {
  return obligation.evidence_terms.filter((term) => {
    return runtimeProofTextMatchesTerm(
      runtimeProofCandidateDirectText(candidate),
      runtimeProofCandidateDirectRawText(candidate),
      term,
    )
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
  return /(?:^|[.#])(?:persist|save|write|store|record|track|emit|publish|send|deliver|redirect|notify|render|synth(?:esize|esis)|insert|upsert|create|execute)[A-Za-z_$\w]*\(?\)?$/i.test(candidate.label)
}

export function runtimeProofProvidesDirectEvidence(
  candidate: Pick<RuntimeProofCandidate, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
  obligation: RuntimeProofProfileObligation,
): boolean {
  if (runtimeProofCandidateIsFileLike(candidate)) {
    return false
  }
  const matchedTerms = runtimeProofMatchedTermCount(candidate, obligation)
  const matchedDirectTerms = runtimeProofMatchedDirectTermCount(candidate, obligation)
  if (matchedTerms === 0) {
    return false
  }
  switch (obligation.kind) {
    case 'entrypoint':
      if (matchedDirectTerms === 0) {
        return false
      }
      return runtimeProofHasEntrypointSignal(candidate)
    case 'handoff':
      if (matchedDirectTerms === 0) {
        return false
      }
      return runtimeProofObligationMatchScore(candidate, obligation) >= 4
    case 'terminal':
      return runtimeProofHasDirectTerminalSignal(candidate)
        && (matchedDirectTerms > 0 || runtimeProofObligationMatchScore(candidate, obligation) >= 4)
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
