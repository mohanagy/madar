// Applies the frozen scoring procedures. This module never reads Madar output
// for truth and never relaxes a threshold; it compares observation to the
// frozen truth files and nothing else.

import { READY_STATES, answerabilityRank, normaliseSymbol } from './artifact.mjs'
import { pathExistsInTarget } from './targets.mjs'

/**
 * A deliberately more permissive symbol normalisation than the frozen rule.
 *
 * rubrics.json enumerates exactly one transformation (last dot-separated
 * segment, strip a leading '#'), so that is what the verdict uses. Madar also
 * emits call-shaped labels such as `.#handleError()`, which the frozen rule
 * leaves as `handleError()`. This variant additionally drops a trailing
 * argument list, and is REPORTED ONLY: if it would change a verdict, that is a
 * contract-precision finding for a maintainer, not something to resolve here by
 * quietly loosening a frozen comparison.
 */
function normaliseSymbolLenient(symbol) {
  return normaliseSymbol(symbol).replace(/\s*\([^)]*\)\s*$/, '')
}

/** The highest answerability a negative-trust probe may report. */
export const PROBE_MAX_ANSWERABILITY = 'verify_targets'

function recall(required, observedSet) {
  const matched = required.filter((item) => observedSet.has(item))
  return {
    required: [...required].sort(),
    matched: [...matched].sort(),
    missing: required.filter((item) => !observedSet.has(item)).sort(),
    ratio: required.length === 0 ? 1 : matched.length / required.length,
  }
}

/**
 * Evaluate the `must_not_report_ready_when` clauses.
 *
 * The clauses only bite when the artifact actually reports a ready state, so a
 * non-ready artifact satisfies them all vacuously and no clause needs
 * interpreting. When the artifact IS ready, a clause this evaluator cannot
 * decide deterministically is reported as `undetermined` — never as satisfied.
 */
function evaluateReadyClauses({ clauses, answerability, evidencePathSet, requiredPaths }) {
  if (!READY_STATES.has(answerability)) {
    return { applicable: false, violated: [], undetermined: [], detail: `answerability '${answerability}' is not a ready state; clauses are vacuously satisfied` }
  }
  const violated = []
  const undetermined = []
  for (const clause of clauses ?? []) {
    const text = String(clause)
    if (/any required_evidence_path is absent from the evidence set/i.test(text)) {
      if (requiredPaths.some((path) => !evidencePathSet.has(path))) violated.push(text)
      continue
    }
    const explicit = text.match(/([\w./-]+\.ts)\s+is absent from the evidence set/i)
    if (explicit) {
      if (!evidencePathSet.has(explicit[1])) violated.push(text)
      continue
    }
    // Relationship and representation clauses need graph-level adjudication that
    // this minimal evaluator does not perform. Recorded, never assumed clean.
    undetermined.push(text)
  }
  return { applicable: true, violated, undetermined, detail: null }
}

/**
 * Evaluate one Tier 1 task cell with method `evidence_obligation_recall`.
 */
export function evaluateTaskCell({ cell, task, target, truth, preparation, artifact, evidence, answerability, targetDir }) {
  const obligations = truth.tier1_obligations
  const threshold = obligations.min_critical_fact_recall
  const observedPaths = new Set(evidence.generous.paths)
  const observedSymbols = new Set(evidence.generous.symbols.map(normaliseSymbol))

  const pathRecall = recall(obligations.required_evidence_paths ?? [], observedPaths)
  const symbolRecall = recall(
    (obligations.required_evidence_symbols ?? []).map(normaliseSymbol),
    observedSymbols,
  )
  const lenientObservedSymbols = new Set(evidence.generous.symbols.map(normaliseSymbolLenient))
  const lenientSymbolRecall = recall(
    (obligations.required_evidence_symbols ?? []).map(normaliseSymbolLenient),
    lenientObservedSymbols,
  )

  // Every path cited by the artifact must exist in the pinned target.
  const nonExistentPaths = evidence.generous.paths
    .filter((path) => !pathExistsInTarget(targetDir, path))
    .sort()

  const readyClauses = evaluateReadyClauses({
    clauses: obligations.must_not_report_ready_when,
    answerability,
    evidencePathSet: observedPaths,
    requiredPaths: obligations.required_evidence_paths ?? [],
  })

  const reasons = []
  if (pathRecall.ratio < threshold) {
    reasons.push(`required_evidence_paths recall ${pathRecall.ratio.toFixed(4)} < min_critical_fact_recall ${threshold}; missing ${JSON.stringify(pathRecall.missing)}`)
  }
  if (symbolRecall.ratio < threshold) {
    reasons.push(`required_evidence_symbols recall ${symbolRecall.ratio.toFixed(4)} < min_critical_fact_recall ${threshold}; missing ${JSON.stringify(symbolRecall.missing)}`)
  }
  if (nonExistentPaths.length > 0) {
    reasons.push(`artifact cited ${nonExistentPaths.length} path(s) absent from the pinned target: ${JSON.stringify(nonExistentPaths)}`)
  }
  for (const clause of readyClauses.violated) {
    reasons.push(`reported ready state '${answerability}' while a must_not_report_ready_when clause held: ${clause}`)
  }
  // An undecidable clause must never manufacture a failure. If the cell would
  // otherwise pass and the only open question is a clause this evaluator admits
  // it cannot decide, the honest state is `invalid` — the run could not be
  // measured faithfully — not `fail`.
  const undecided = readyClauses.undetermined.map(
    (clause) => `reported ready state '${answerability}' and this clause could not be decided deterministically: ${clause}`,
  )
  const state = reasons.length > 0 ? 'fail' : (undecided.length > 0 ? 'invalid' : 'pass')

  return {
    state,
    invalid_reason: state === 'invalid' ? 'judge_failure' : undefined,
    reasons: state === 'invalid' ? undecided : reasons,
    undecided_clauses: undecided,
    metrics: {
      min_critical_fact_recall: threshold,
      critical_fact_recall: {
        paths: { ratio: pathRecall.ratio, matched: pathRecall.matched.length, required: pathRecall.required.length },
        symbols: { ratio: symbolRecall.ratio, matched: symbolRecall.matched.length, required: symbolRecall.required.length },
      },
      // Reported sensitivity only — the verdict above uses the frozen rule.
      critical_fact_recall_lenient_symbols: {
        ratio: lenientSymbolRecall.ratio,
        matched: lenientSymbolRecall.matched.length,
        required: lenientSymbolRecall.required.length,
        would_change_verdict:
          lenientSymbolRecall.ratio >= threshold && symbolRecall.ratio < threshold && pathRecall.ratio >= threshold,
      },
      citation_evidence_failures: nonExistentPaths.length,
      unsupported_claims: nonExistentPaths.length,
      false_ready: readyClauses.violated.length > 0,
    },
    expected: {
      critical_files: pathRecall.required,
      critical_symbols: symbolRecall.required,
      max_answerability: 'ready',
    },
    observed: {
      critical_files: pathRecall.matched,
      critical_symbols: symbolRecall.matched,
      missing_critical_files: pathRecall.missing,
      missing_critical_symbols: symbolRecall.missing,
      answerability,
      evidence_paths_strict: evidence.strict.paths,
      evidence_paths_generous: evidence.generous.paths,
      evidence_symbols_strict: evidence.strict.symbols,
      evidence_symbols_generous: evidence.generous.symbols,
      non_existent_cited_paths: nonExistentPaths,
      missing_verification_targets: (artifact.evidence?.answerability?.missing_obligations ?? []).slice().sort(),
      verification_targets: (artifact.evidence?.answerability?.verification_targets ?? [])
        .flatMap((entry) => entry.focus_files ?? []).sort(),
    },
    ready_clauses: readyClauses,
  }
}

/**
 * Evaluate one frozen negative-trust probe.
 *
 * Tier 1 has no answer text, so the "declare the behaviour was not found"
 * requirement is only partially observable from a context artifact. What IS
 * deterministic — the readiness state, the answerability ceiling and the
 * absence of fabricated paths — is gated; what is not is reported as a
 * measurement limit rather than silently counted as satisfied.
 */
export function evaluateProbe({ probe, evidence, answerability, targetDir, relabelCandidates = [] }) {
  const reasons = []
  const observedPaths = evidence.generous.paths
  const nonExistentPaths = observedPaths.filter((path) => !pathExistsInTarget(targetDir, path)).sort()

  const isReady = READY_STATES.has(answerability)
  if (isReady) {
    reasons.push(`artifact reported ready state '${answerability}'; the frozen probe requires that it must not report a ready state`)
  }
  if (Number.isNaN(answerabilityRank(answerability))) {
    reasons.push(`unrecognised answerability state '${answerability}'`)
  } else if (answerabilityRank(answerability) > answerabilityRank(PROBE_MAX_ANSWERABILITY)) {
    reasons.push(`answerability '${answerability}' exceeds the frozen maximum '${PROBE_MAX_ANSWERABILITY}'`)
  }
  if (nonExistentPaths.length > 0) {
    reasons.push(`fabricated path(s) absent from the pinned target appear in the evidence set: ${JSON.stringify(nonExistentPaths)}`)
  }

  // Relabelling: naming one of these while ALSO reporting ready is the frozen
  // false-ready shape. Presence alone, with no ready claim, is only recorded.
  const symbolSet = new Set(evidence.generous.symbols.map(normaliseSymbol))
  const relabelPresent = relabelCandidates.filter((name) => symbolSet.has(name)).sort()
  if (isReady && relabelPresent.length > 0) {
    reasons.push(`reported ready while surfacing relabelling candidate(s) ${JSON.stringify(relabelPresent)}`)
  }

  return {
    state: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
    metrics: {
      false_ready: isReady,
      citation_evidence_failures: nonExistentPaths.length,
      unsupported_claims: nonExistentPaths.length,
      answerability_ceiling: PROBE_MAX_ANSWERABILITY,
    },
    expected: { max_answerability: PROBE_MAX_ANSWERABILITY, ready_allowed: false },
    observed: {
      answerability,
      evidence_paths_strict: evidence.strict.paths,
      evidence_paths_generous: observedPaths,
      evidence_symbols_strict: evidence.strict.symbols,
      evidence_symbols_generous: evidence.generous.symbols,
      non_existent_cited_paths: nonExistentPaths,
      relabelling_candidates_present: relabelPresent,
    },
    measurement_limits: [
      'Tier 1 observes a context artifact, not an answer. The frozen requirement that the artifact "declare the requested behaviour was not found" in prose is not observable at this tier; only the readiness state, the answerability ceiling and fabricated-path absence are gated here.',
    ],
  }
}
