// Applies the frozen scoring procedures. This module never reads Madar output
// for truth, never relaxes a threshold, and never interprets English prose.
//
// Every frozen requirement whose wording is a sentence is decided by the typed
// predicate bound to that exact sentence in docs/qualification/tier1-adjudication.json.
// There is no prose fallback: no negation-marker search, no subject-mention
// search, and no acceptance of free-text channels such as claims[].text as a
// declaration of anything.

import { READY_STATES, answerabilityRank, normaliseSymbol, snippetSymbolSightings } from './artifact.mjs'
import { evaluateRelationship, extractTypedEdges, findTypedDeclaration, requirementPresent } from './adjudication.mjs'
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

/** The exact reason recorded when the adjudication contract does not match its sources. */
export const ADJUDICATION_MISMATCH = 'adjudication_contract_mismatch'

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
 * Apply one typed predicate.
 *
 * Returns { satisfied, detail, observed }. `satisfied` false means the frozen
 * requirement this predicate stands for was NOT met.
 */
function applyPredicate({ entry, artifact, evidence, answerability, targetDir, obligations, requirementsById, relationshipsById, adapters }) {
  const { kind, params } = entry.predicate
  const observedPaths = new Set(evidence.generous.paths)

  switch (kind) {
    case 'answerability_not_in': {
      const satisfied = !params.states.includes(answerability)
      return { satisfied, detail: satisfied ? null : `published answerability '${answerability}' is one of ${JSON.stringify(params.states)}`, observed: { answerability } }
    }

    case 'prohibited_reference_absent': {
      const badPaths = evidence.generous.paths.filter((path) => !pathExistsInTarget(targetDir, path)).sort()
      const badSymbols = params.scope === 'paths_and_symbols'
        ? evidence.generous.symbols.filter((symbol) => !symbolExistsInTarget(targetDir, symbol)).sort()
        : []
      const satisfied = badPaths.length === 0 && badSymbols.length === 0
      return {
        satisfied,
        detail: satisfied ? null : `references absent from the pinned target: paths ${JSON.stringify(badPaths)}, symbols ${JSON.stringify(badSymbols)}`,
        observed: { non_existent_cited_paths: badPaths, fabricated_symbols: badSymbols },
      }
    }

    case 'required_evidence_paths_present': {
      const missing = (obligations?.required_evidence_paths ?? []).filter((path) => !observedPaths.has(path)).sort()
      // This clause is a must_not_report_ready_when condition: it only bites
      // when the artifact is in a ready state.
      if (!READY_STATES.has(answerability)) {
        return { satisfied: true, detail: `answerability '${answerability}' is not a ready state; the clause is vacuously satisfied`, observed: { missing_required_paths: missing } }
      }
      return { satisfied: missing.length === 0, detail: missing.length === 0 ? null : `reported ready state '${answerability}' while required_evidence_paths ${JSON.stringify(missing)} were absent from the evidence set`, observed: { missing_required_paths: missing } }
    }

    case 'explicit_path_present': {
      const present = observedPaths.has(params.path)
      if (!READY_STATES.has(answerability)) {
        return { satisfied: true, detail: `answerability '${answerability}' is not a ready state; the clause is vacuously satisfied`, observed: { path: params.path, present } }
      }
      return { satisfied: present, detail: present ? null : `reported ready state '${answerability}' while ${params.path} was absent from the evidence set`, observed: { path: params.path, present } }
    }

    case 'required_typed_absence': {
      const declaration = findTypedDeclaration(artifact, params.accepted_channels, params.subject_id)
      const substitution = params.prohibited_substitutions
      let substitutionHit = null
      if (substitution && substitution.ready_states.includes(answerability)) {
        const symbols = new Set(evidence.generous.symbols.map(normaliseSymbol))
        const named = substitution.symbols.filter((symbol) => symbols.has(normaliseSymbol(symbol)))
        const namedPaths = substitution.paths.filter((path) => observedPaths.has(path))
        if (named.length > 0 || namedPaths.length > 0) substitutionHit = { symbols: named, paths: namedPaths }
      }
      const satisfied = declaration !== null && substitutionHit === null
      const reasons = []
      if (declaration === null) {
        reasons.push(`${MISSING_ABSENCE_DECLARATION}: no typed channel declares '${params.subject_id}' absent. Accepted channels: ${JSON.stringify(params.accepted_channels.map((c) => c.channel))}`)
      }
      if (substitutionHit) {
        reasons.push(`reported ready state '${answerability}' while surfacing prohibited substitution(s) ${JSON.stringify(substitutionHit)} for '${params.subject_id}'`)
      }
      return {
        satisfied,
        detail: reasons.join('; ') || null,
        observed: { subject_id: params.subject_id, typed_declaration: declaration, prohibited_substitution: substitutionHit, accepted_channels: params.accepted_channels.map((c) => c.channel) },
      }
    }

    case 'prohibited_substitution_absent': {
      if (!params.ready_states.includes(answerability)) {
        return { satisfied: true, detail: `answerability '${answerability}' is not a ready state; the substitution clause is vacuously satisfied`, observed: { subject_id: params.subject_id } }
      }
      const symbols = new Set(evidence.generous.symbols.map(normaliseSymbol))
      const named = params.prohibited_symbols.filter((symbol) => symbols.has(normaliseSymbol(symbol)))
      const namedPaths = params.prohibited_paths.filter((path) => observedPaths.has(path))
      const satisfied = named.length === 0 && namedPaths.length === 0
      return {
        satisfied,
        detail: satisfied ? null : `reported ready state '${answerability}' while presenting ${JSON.stringify({ symbols: named, paths: namedPaths })} as '${params.subject_id}'`,
        observed: { subject_id: params.subject_id, prohibited_symbols_present: named, prohibited_paths_present: namedPaths },
      }
    }

    case 'must_not_ready_when_requirements_missing': {
      const status = params.requirement_ids.map((id) => {
        const requirement = requirementsById.get(id)
        return { id, ...requirementPresent(requirement, evidence, normaliseSymbol) }
      })
      const missing = status.filter((entryStatus) => !entryStatus.present)
      const present = status.filter((entryStatus) => entryStatus.present)
      const triggered = params.match === 'partial_only'
        ? present.length > 0 && missing.length > 0
        : missing.length > 0

      if (!params.ready_states.includes(answerability)) {
        return { satisfied: true, detail: `answerability '${answerability}' is not a ready state; the clause is vacuously satisfied`, observed: { requirement_status: status, triggered } }
      }
      if (!triggered) return { satisfied: true, detail: null, observed: { requirement_status: status, triggered } }

      // Every missing requirement needs its own typed record naming it exactly.
      const uncovered = []
      const covered = []
      for (const entryStatus of missing) {
        const hit = params.unresolved ? findTypedDeclaration(artifact, params.unresolved.channels, entryStatus.id) : null
        if (hit) covered.push({ requirement_id: entryStatus.id, ...hit })
        else uncovered.push(entryStatus.id)
      }
      if (uncovered.length === 0) {
        return { satisfied: true, detail: `every missing requirement is carried by its own typed unresolved record`, observed: { requirement_status: status, triggered, unresolved: covered } }
      }
      return {
        satisfied: false,
        detail: `reported ready state '${answerability}' while frozen requirement(s) ${JSON.stringify(missing.map((m) => m.id))} were missing, and ${JSON.stringify(uncovered)} ${uncovered.length === 1 ? 'is' : 'are'} not covered by a typed unresolved record`,
        observed: { requirement_status: status, triggered, unresolved: covered, uncovered },
      }
    }

    case 'must_not_ready_when_relationships_missing': {
      const edges = extractTypedEdges(artifact, adapters)
      const outcomes = params.relationship_ids.map((id) => evaluateRelationship(relationshipsById.get(id), edges, normaliseSymbol))
      const missing = outcomes.filter((outcome) => !outcome.present)
      const observedBase = {
        required_relationship_ids: params.relationship_ids,
        present_relationship_ids: outcomes.filter((o) => o.present).map((o) => o.id),
        missing_relationship_ids: missing.map((o) => o.id),
        relationship_outcomes: outcomes,
        relationship_channels_consulted: adapters.map((a) => a.channel),
        typed_edges_observed: edges.length,
        group_match: params.group_match,
        unresolved_policy: params.unresolved_policy,
      }

      if (!params.ready_states.includes(answerability)) {
        return { satisfied: true, detail: `answerability '${answerability}' is not a ready state; the clause is vacuously satisfied`, observed: { ...observedBase, exactly_unresolved_relationship_ids: [], uncovered_relationship_ids: [] } }
      }
      // group_match is all_required: every declared relationship must hold.
      if (missing.length === 0) {
        return { satisfied: true, detail: null, observed: { ...observedBase, exactly_unresolved_relationship_ids: [], uncovered_relationship_ids: [] } }
      }

      const exactlyUnresolved = []
      const uncovered = []
      for (const outcome of missing) {
        const requirement = relationshipsById.get(outcome.id)
        const eligible = params.unresolved_policy === 'exact_per_relationship' && requirement.unresolved_subject_id !== null
        const hit = eligible ? findTypedDeclaration(artifact, params.unresolved_channels, requirement.unresolved_subject_id) : null
        if (hit) exactlyUnresolved.push({ relationship_id: outcome.id, ...hit })
        else uncovered.push(outcome.id)
      }
      const observed = { ...observedBase, exactly_unresolved_relationship_ids: exactlyUnresolved.map((e) => e.relationship_id), uncovered_relationship_ids: uncovered, unresolved_records: exactlyUnresolved }
      if (uncovered.length === 0) {
        return { satisfied: true, detail: `every missing relationship is carried by a typed unresolved record naming it exactly`, observed }
      }
      const rejected = missing.flatMap((o) => o.rejected.map((r) => `${o.id}: ${r.from} -${r.relation}-> ${r.to} rejected for ${r.rejected_for}`))
      return {
        satisfied: false,
        detail: `reported ready state '${answerability}' while relationship(s) ${JSON.stringify(uncovered)} were neither present in any declared relationship channel nor declared unresolved by an exact typed record`
          + (rejected.length > 0 ? `; edges rejected: ${JSON.stringify(rejected)}` : '')
          + ` (${edges.length} typed edge(s) observed, policy ${params.unresolved_policy})`,
        observed,
      }
    }

    case 'typed_unresolved_requirement_present': {
      const hit = findTypedDeclaration(artifact, params.channels, null)
      return { satisfied: hit !== null, detail: hit ? null : 'no typed unresolved record present', observed: { unresolved: hit } }
    }

    default:
      return { satisfied: false, detail: `${ADJUDICATION_MISMATCH}: unhandled predicate kind ${kind}`, observed: {} }
  }
}

/**
 * Evaluate one Tier 1 task cell with method `evidence_obligation_recall`.
 */
export function evaluateTaskCell({ cell, task, target, truth, truthFile, preparation, artifact, evidence, answerability, targetDir, adjudication }) {
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
  // nothing about symbols, so ungrounded symbols are REPORTED and never gate the
  // verdict. The negative probes gate on both, because their frozen
  // required_behaviour says "No fabricated path or symbol".
  const nonExistentPaths = evidence.generous.paths
    .filter((path) => !pathExistsInTarget(targetDir, path))
    .sort()
  const ungroundedSymbols = evidence.generous.symbols
    .filter((symbol) => !symbolExistsInTarget(targetDir, symbol))
    .sort()

  // ---- adjudicated must_not_report_ready_when clauses ---------------------
  const clauses = obligations.must_not_report_ready_when ?? []
  const adjudicated = []
  const contractProblems = []
  for (let index = 0; index < clauses.length; index += 1) {
    const key = `${truthFile}#/tier1_obligations/must_not_report_ready_when/${index}`
    const entry = adjudication.byClause.get(key)
    if (!entry) {
      contractProblems.push(`${ADJUDICATION_MISMATCH}: no adjudication entry for ${key}`)
      continue
    }
    const outcome = applyPredicate({ entry, artifact, evidence, answerability, targetDir, obligations, requirementsById: adjudication.requirementsById, relationshipsById: adjudication.relationshipsById, adapters: adjudication.adapters })
    adjudicated.push({ adjudication_id: entry.id, clause: clauses[index], clause_sha256: entry.source.clause_sha256, predicate: entry.predicate.kind, ...outcome })
  }

  const violated = adjudicated.filter((entry) => !entry.satisfied)

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
  for (const entry of violated) {
    reasons.push(`[${entry.adjudication_id} ${entry.predicate}] ${entry.detail}`)
  }

  // A contract that does not match its sources is a measurement failure, never
  // a product result.
  const state = contractProblems.length > 0 ? 'invalid' : (reasons.length > 0 ? 'fail' : 'pass')

  return {
    state,
    invalid_reason: state === 'invalid' ? ADJUDICATION_MISMATCH : undefined,
    reasons: state === 'invalid' ? contractProblems : reasons,
    metrics: {
      min_critical_fact_recall: threshold,
      critical_fact_recall: {
        paths: { ratio: pathRecall.ratio, matched: pathRecall.matched.length, required: pathRecall.required.length },
        symbols: { ratio: symbolRecall.ratio, matched: symbolRecall.matched.length, required: symbolRecall.required.length },
      },
      critical_fact_recall_lenient_symbols: {
        ratio: lenientSymbolRecall.ratio,
        matched: lenientSymbolRecall.matched.length,
        required: lenientSymbolRecall.required.length,
        would_change_verdict:
          lenientSymbolRecall.ratio >= threshold && symbolRecall.ratio < threshold && pathRecall.ratio >= threshold,
      },
      citation_evidence_failures: nonExistentPaths.length,
      unsupported_claims: nonExistentPaths.length,
      ungrounded_symbols: ungroundedSymbols.length,
      false_ready: violated.length > 0,
      false_ready_clauses: violated.length,
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
      ungrounded_symbols: ungroundedSymbols,
      // Reported only. Snippets are never mined for recall; this records what
      // mining them WOULD have found so the distinction stays visible.
      required_symbols_seen_only_in_snippets: snippetSymbolSightings(evidence, symbolRecall.missing),
      missing_verification_targets: (artifact.evidence?.answerability?.missing_obligations ?? []).slice().sort(),
      verification_targets: (artifact.evidence?.answerability?.verification_targets ?? [])
        .flatMap((entry) => entry.focus_files ?? []).sort(),
    },
    adjudication: {
      contract_digest: adjudication.digest,
      adjudication_version: adjudication.contract?.adjudication_version ?? null,
      clauses: adjudicated,
      contract_problems: contractProblems,
      relationships: summariseRelationships(adjudicated),
    },
  }
}

/**
 * The relationship picture for one cell, flattened so a reader does not have to
 * reassemble it from predicate internals.
 */
function summariseRelationships(adjudicated) {
  const relationshipClauses = adjudicated.filter((entry) => entry.predicate === 'must_not_ready_when_relationships_missing')
  if (relationshipClauses.length === 0) return null
  const merge = (key) => [...new Set(relationshipClauses.flatMap((entry) => entry.observed[key] ?? []))].sort()
  return {
    required_relationship_ids: merge('required_relationship_ids'),
    present_relationship_ids: merge('present_relationship_ids'),
    missing_relationship_ids: merge('missing_relationship_ids'),
    exactly_unresolved_relationship_ids: merge('exactly_unresolved_relationship_ids'),
    uncovered_relationship_ids: merge('uncovered_relationship_ids'),
    channels_consulted: merge('relationship_channels_consulted'),
    directions_evaluated: [...new Set(relationshipClauses.flatMap((entry) => (entry.observed.relationship_outcomes ?? []).map((o) => o.direction)))].sort(),
    relation_kinds_evaluated: [...new Set(relationshipClauses.flatMap((entry) => (entry.observed.relationship_outcomes ?? []).flatMap((o) => o.relation_kinds)))].sort(),
    typed_edges_observed: Math.max(0, ...relationshipClauses.map((entry) => entry.observed.typed_edges_observed ?? 0)),
    false_ready_decision: relationshipClauses.some((entry) => !entry.satisfied),
  }
}

/**
 * Evaluate one frozen negative-trust probe.
 *
 * Every clause of `required_behaviour` is decided by its bound typed predicate.
 * A clause with no binding makes the probe `invalid`; it can never make it pass.
 */
export function evaluateProbe({ probe, probeIndex, evidence, artifact, answerability, targetDir, adjudication }) {
  const requirements = probe.required_behaviour ?? []
  const adjudicated = []
  const contractProblems = []
  for (let index = 0; index < requirements.length; index += 1) {
    const key = `docs/qualification/tier1.json#/negative_trust_probes/${probeIndex}/required_behaviour/${index}`
    const entry = adjudication.byClause.get(key)
    if (!entry) {
      contractProblems.push(`${ADJUDICATION_MISMATCH}: no adjudication entry for ${key}`)
      continue
    }
    const outcome = applyPredicate({ entry, artifact, evidence, answerability, targetDir, obligations: null, requirementsById: adjudication.requirementsById, relationshipsById: adjudication.relationshipsById, adapters: adjudication.adapters })
    adjudicated.push({ adjudication_id: entry.id, requirement: requirements[index], clause_sha256: entry.source.clause_sha256, predicate: entry.predicate.kind, ...outcome })
  }

  const unmet = adjudicated.filter((entry) => !entry.satisfied)
  const reasons = unmet.map((entry) => `[${entry.adjudication_id} ${entry.predicate}] ${entry.detail}`)

  // The frozen answerability ceiling is a property of the probe kind, not of a
  // single clause, so it is checked alongside the adjudicated requirements.
  if (Number.isNaN(answerabilityRank(answerability))) {
    reasons.push(`unrecognised answerability state '${answerability}'`)
  } else if (answerabilityRank(answerability) > answerabilityRank(PROBE_MAX_ANSWERABILITY)) {
    reasons.push(`answerability '${answerability}' exceeds the frozen maximum '${PROBE_MAX_ANSWERABILITY}'`)
  }

  const state = contractProblems.length > 0 ? 'invalid' : (reasons.length > 0 ? 'fail' : 'pass')

  return {
    state,
    invalid_reason: state === 'invalid' ? ADJUDICATION_MISMATCH : undefined,
    reasons: state === 'invalid' ? contractProblems : reasons,
    metrics: {
      false_ready: READY_STATES.has(answerability),
      citation_evidence_failures: (adjudicated.find((entry) => entry.predicate === 'prohibited_reference_absent')?.observed?.non_existent_cited_paths ?? []).length,
      unsupported_claims: (adjudicated.find((entry) => entry.predicate === 'prohibited_reference_absent')?.observed?.non_existent_cited_paths ?? []).length
        + (adjudicated.find((entry) => entry.predicate === 'prohibited_reference_absent')?.observed?.fabricated_symbols ?? []).length,
      answerability_ceiling: PROBE_MAX_ANSWERABILITY,
      absence_declaration_observed: Boolean(adjudicated.find((entry) => entry.predicate === 'required_typed_absence')?.observed?.typed_declaration),
      requirements_adjudicated: adjudicated.length,
      requirements_total: requirements.length,
    },
    expected: { max_answerability: PROBE_MAX_ANSWERABILITY, ready_allowed: false },
    observed: {
      answerability,
      evidence_paths_strict: evidence.strict.paths,
      evidence_paths_generous: evidence.generous.paths,
      evidence_symbols_strict: evidence.strict.symbols,
      evidence_symbols_generous: evidence.generous.symbols,
      non_existent_cited_paths: adjudicated.find((entry) => entry.predicate === 'prohibited_reference_absent')?.observed?.non_existent_cited_paths ?? [],
      fabricated_symbols: adjudicated.find((entry) => entry.predicate === 'prohibited_reference_absent')?.observed?.fabricated_symbols ?? [],
    },
    adjudication: {
      contract_digest: adjudication.digest,
      clauses: adjudicated,
      contract_problems: contractProblems,
    },
  }
}
