// Applies the frozen scoring procedures. This module never reads Madar output
// for truth and never relaxes a threshold; it compares observation to the
// frozen truth files and nothing else.

import {
  READY_STATES,
  answerabilityRank,
  assertsAbsence,
  mentionsToken,
  normaliseSymbol,
  probeSubjectTerms,
  snippetSymbolSightings,
  DECLARATION_CHANNELS,
} from './artifact.mjs'
import { pathExistsInTarget, symbolExistsInTarget } from './targets.mjs'

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

/** The exact reason recorded when a frozen absence declaration is not observed. */
export const MISSING_ABSENCE_DECLARATION = 'missing_required_absence_declaration'

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
 * Does any declaration channel name this missing item?
 *
 * "Declared as unresolved" is what the frozen must-not-ready clauses accept in
 * place of the evidence itself, so it has to be decided from what the artifact
 * actually says, by whole-word match, never by substring.
 */
function declaredUnresolved(declarations, items) {
  const hits = []
  for (const item of items) {
    for (const declaration of declarations) {
      if (mentionsToken(declaration.text, item) || declaration.text === item) {
        hits.push({ item, schema_path: declaration.schema_path, text: declaration.text })
        break
      }
    }
  }
  return hits
}

/**
 * Evaluate the `must_not_report_ready_when` clauses.
 *
 * The clauses only bite when the artifact actually reports a ready state, so a
 * non-ready artifact satisfies them all vacuously.
 *
 * When the artifact IS ready, every clause is decided. Clauses that name a
 * relationship or a representation are not left `undetermined` any more: the
 * first baseline left them undecided, and the consequence was a cell reporting
 * `ready_with_caveat` on 0/4 required evidence with a false-ready count of zero.
 * The decision rule is the contract's own floor — if the frozen critical
 * evidence the clause is about is missing, and nothing in the artifact declares
 * it unresolved, then a ready state violates the clause. The clause text is
 * carried verbatim so nothing is glossed.
 */
function evaluateReadyClauses({ clauses, answerability, evidencePathSet, requiredPaths, missingCritical, declarations }) {
  if (!READY_STATES.has(answerability)) {
    return { applicable: false, violated: [], undetermined: [], unresolved_declarations: [], detail: `answerability '${answerability}' is not a ready state; clauses are vacuously satisfied` }
  }
  const violated = []
  const undetermined = []
  const unresolved = declaredUnresolved(declarations, missingCritical)
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

    // Relationship and representation clauses name their subject in English.
    // This evaluator does not parse that English, and it must not substitute
    // aggregate recall for it: unrelated missing evidence would then read as a
    // violation of a clause it has nothing to do with.
    //
    // What IS decidable without interpretation is whether the clause's own text
    // literally names a required item the artifact failed to surface. When it
    // does, the evidence the clause is about is demonstrably missing, and a ready
    // state with no unresolved declaration violates it. When it does not, the
    // clause stays `undetermined` — recorded, never assumed clean.
    const namedMissing = missingCritical.filter((item) => mentionsToken(text, item) || text.includes(item))
    if (namedMissing.length === 0) {
      undetermined.push(`${text} — this clause names no required item that is missing, so it cannot be decided from the artifact alone`)
      continue
    }
    const namedUnresolved = unresolved.filter((hit) => namedMissing.includes(hit.item))
    if (namedUnresolved.length > 0) {
      undetermined.push(`${text} — ${JSON.stringify(namedUnresolved.map((hit) => hit.item))} is missing but the artifact declares it unresolved (${namedUnresolved.map((hit) => hit.schema_path).join(', ')})`)
      continue
    }
    violated.push(`${text} [clause names missing required evidence ${JSON.stringify(namedMissing)}, and no declaration channel reports it unresolved]`)
  }
  return { applicable: true, violated, undetermined, unresolved_declarations: unresolved, detail: null }
}

/**
 * Evaluate one Tier 1 task cell with method `evidence_obligation_recall`.
 */
export function evaluateTaskCell({ cell, task, target, truth, preparation, artifact, evidence, declarations = [], answerability, targetDir }) {
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

  // The frozen method mandates exactly one existence check for a task cell:
  // "Every path cited by the artifact must exist in the pinned target." It says
  // nothing about symbols, so ungrounded symbols are REPORTED here and never
  // gate the verdict — adding a gate the contract does not have would fail a
  // cell the contract passes, which is as much an infidelity as relaxing one.
  // The negative probes are different: their frozen required_behaviour says
  // "No fabricated path or symbol", and evaluateProbe gates on both.
  const nonExistentPaths = evidence.generous.paths
    .filter((path) => !pathExistsInTarget(targetDir, path))
    .sort()
  const ungroundedSymbols = evidence.generous.symbols
    .filter((symbol) => !symbolExistsInTarget(targetDir, symbol))
    .sort()

  const missingCritical = [...pathRecall.missing, ...symbolRecall.missing]

  const readyClauses = evaluateReadyClauses({
    clauses: obligations.must_not_report_ready_when,
    answerability,
    evidencePathSet: observedPaths,
    requiredPaths: obligations.required_evidence_paths ?? [],
    missingCritical,
    declarations,
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
      // Reported only; the frozen task method gates on cited paths, not symbols.
      ungrounded_symbols: ungroundedSymbols.length,
      false_ready: readyClauses.violated.length > 0,
      false_ready_clauses: readyClauses.violated.length,
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
      answerability_channel: artifact.evidence?.answerability?.state !== undefined
        ? '.evidence.answerability.state'
        : '.governance.directive.answerability',
      evidence_paths_strict: evidence.strict.paths,
      evidence_paths_generous: evidence.generous.paths,
      evidence_symbols_strict: evidence.strict.symbols,
      evidence_symbols_generous: evidence.generous.symbols,
      non_existent_cited_paths: nonExistentPaths,
      // Reported only — not a task-cell gate. See the note above.
      ungrounded_symbols: ungroundedSymbols,
      // Reported only. Snippets are never mined for recall; this records what
      // mining them WOULD have found so the distinction is visible.
      required_symbols_seen_only_in_snippets: snippetSymbolSightings(
        evidence,
        symbolRecall.missing,
      ),
      missing_verification_targets: (artifact.evidence?.answerability?.missing_obligations ?? []).slice().sort(),
      verification_targets: (artifact.evidence?.answerability?.verification_targets ?? [])
        .flatMap((entry) => entry.focus_files ?? []).sort(),
    },
    ready_clauses: readyClauses,
  }
}

/**
 * Which frozen required_behaviour clauses this evaluator actually measures.
 *
 * Every clause is classified, and a clause that is NOT measured makes the probe
 * `invalid`, never `pass`. The first baseline recorded the absence-declaration
 * requirement as unobservable at Tier 1 and still returned `pass`; a pass that
 * covers an unmeasured requirement is not a measurement.
 */
function classifyProbeRequirements({ probe, readyObserved, absence, fabricated }) {
  return (probe.required_behaviour ?? []).map((requirement) => {
    const text = String(requirement)
    if (/must not report a ready state|counts as a false-ready failure|as a persistent cache/i.test(text)) {
      return { requirement: text, measured: true, satisfied: !readyObserved, how: 'evidence.answerability.state against the frozen ceiling' }
    }
    if (/no fabricated path or symbol/i.test(text)) {
      return { requirement: text, measured: true, satisfied: fabricated === 0, how: 'every cited path and printed symbol checked against the pinned target tree' }
    }
    if (/must declare|must state/i.test(text)) {
      return { requirement: text, measured: true, satisfied: absence.observed, how: `absence declaration searched across ${absence.channels_searched.length} declaration channels for the probe's subject terms` }
    }
    return { requirement: text, measured: false, satisfied: null, how: 'no deterministic observation defined for this clause' }
  })
}

/**
 * Evaluate one frozen negative-trust probe.
 *
 * Three things are gated: the readiness state, the answerability ceiling, and
 * the absence of fabricated paths and symbols — plus the frozen requirement
 * that the artifact declare the requested behaviour was not found, which is
 * observed across the artifact's declaration channels.
 */
export function evaluateProbe({ probe, evidence, declarations = [], answerability, targetDir, relabelCandidates = [] }) {
  const reasons = []
  const observedPaths = evidence.generous.paths
  const nonExistentPaths = observedPaths.filter((path) => !pathExistsInTarget(targetDir, path)).sort()
  const fabricatedSymbols = evidence.generous.symbols.filter((symbol) => !symbolExistsInTarget(targetDir, symbol)).sort()

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
  if (fabricatedSymbols.length > 0) {
    reasons.push(`fabricated symbol(s) absent from the pinned target appear in the evidence set: ${JSON.stringify(fabricatedSymbols)}`)
  }

  // The frozen "declare the behaviour was not found" requirement.
  //
  // Two conditions, both on the SAME string: it must name the probe's subject,
  // and it must assert absence. Naming alone is not declaring — the declaration
  // channels include affirmative prose, and "supporting evidence for the route
  // matcher cache" mentions the subject while asserting the opposite of what the
  // frozen probe requires.
  const subjectTerms = probeSubjectTerms(probe.prompt?.text ?? '')
  const absenceMatches = []
  const subjectMentionsWithoutAbsence = []
  for (const declaration of declarations) {
    const term = subjectTerms.find((candidate) => mentionsToken(declaration.text, candidate))
    if (!term) continue
    if (assertsAbsence(declaration.text)) {
      absenceMatches.push({ term, schema_path: declaration.schema_path, text: declaration.text })
    } else {
      subjectMentionsWithoutAbsence.push({ term, schema_path: declaration.schema_path, text: declaration.text })
    }
  }
  const absence = {
    required: (probe.required_behaviour ?? []).some((entry) => /must declare|must state/i.test(String(entry))),
    subject_terms: subjectTerms,
    channels_searched: DECLARATION_CHANNELS,
    declarations_seen: declarations.length,
    observed: absenceMatches.length > 0,
    matches: absenceMatches,
    // Recorded so the difference between naming the subject and declaring it
    // absent is visible in the evidence rather than only in this comment.
    subject_mentioned_without_asserting_absence: subjectMentionsWithoutAbsence,
  }
  if (absence.required && !absence.observed) {
    const detail = subjectMentionsWithoutAbsence.length > 0
      ? `${subjectMentionsWithoutAbsence.length} declaration string(s) name a subject term but assert presence rather than absence (e.g. ${JSON.stringify(subjectMentionsWithoutAbsence[0].text.slice(0, 120))})`
      : `${declarations.length} declaration string(s) were searched and none names a subject term at all`
    reasons.push(`${MISSING_ABSENCE_DECLARATION}: no declaration channel both names a subject term of the frozen prompt (${JSON.stringify(subjectTerms)}) and asserts that it is absent; ${detail}`)
  }

  // Relabelling: naming one of these while ALSO reporting ready is the frozen
  // false-ready shape. Presence alone, with no ready claim, is only recorded.
  const symbolSet = new Set(evidence.generous.symbols.map(normaliseSymbol))
  const relabelPresent = relabelCandidates.filter((name) => symbolSet.has(name)).sort()
  if (isReady && relabelPresent.length > 0) {
    reasons.push(`reported ready while surfacing relabelling candidate(s) ${JSON.stringify(relabelPresent)}`)
  }

  const requirements = classifyProbeRequirements({
    probe,
    readyObserved: isReady,
    absence,
    fabricated: nonExistentPaths.length + fabricatedSymbols.length,
  })
  const unmeasured = requirements.filter((entry) => !entry.measured)

  // Order matters: a measured failure is a failure. Only a clean run with an
  // unmeasured requirement is `invalid`, and it is never `pass`.
  const state = reasons.length > 0 ? 'fail' : (unmeasured.length > 0 ? 'invalid' : 'pass')

  return {
    state,
    invalid_reason: state === 'invalid' ? 'judge_failure' : undefined,
    reasons: state === 'invalid'
      ? unmeasured.map((entry) => `frozen required_behaviour is not measured by this evaluator, so the probe cannot be reported as pass: ${entry.requirement}`)
      : reasons,
    requirement_coverage: requirements,
    metrics: {
      false_ready: isReady,
      citation_evidence_failures: nonExistentPaths.length,
      unsupported_claims: nonExistentPaths.length + fabricatedSymbols.length,
      answerability_ceiling: PROBE_MAX_ANSWERABILITY,
      absence_declaration_observed: absence.observed,
      requirements_measured: requirements.filter((entry) => entry.measured).length,
      requirements_total: requirements.length,
    },
    expected: { max_answerability: PROBE_MAX_ANSWERABILITY, ready_allowed: false, absence_declaration_required: absence.required },
    observed: {
      answerability,
      evidence_paths_strict: evidence.strict.paths,
      evidence_paths_generous: observedPaths,
      evidence_symbols_strict: evidence.strict.symbols,
      evidence_symbols_generous: evidence.generous.symbols,
      non_existent_cited_paths: nonExistentPaths,
      fabricated_symbols: fabricatedSymbols,
      relabelling_candidates_present: relabelPresent,
      absence_declaration: absence,
    },
  }
}
