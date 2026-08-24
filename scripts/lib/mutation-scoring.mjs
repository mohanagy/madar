/**
 * Scoring decisions for the #658 mutation harness, kept separate from the
 * process that drives them so they can be tested directly.
 *
 * The review's finding was that "the suite went red" was being read as proof a
 * mutant was caught. It is not: a flaky neighbour, a broken fixture, or a host
 * problem turns a suite red without saying anything about the invariant. These
 * functions make the distinction explicit and testable.
 */

/** An expectation matches by substring, or by regex when one is given. */
export function matchesExpectation(name, expected) {
  return expected.some((pattern) => (
    pattern instanceof RegExp ? pattern.test(name) : name.includes(pattern)
  ))
}

/**
 * Decides whether a suite run can be used as evidence at all.
 *
 * A run that never executed a test says nothing about the mutant, so it must
 * never reach the caught/uncaught decision.
 */
export function readSuiteResult({ raw = '', report = null }) {
  if (/Failed to start forks worker|Timeout waiting for worker to respond/.test(raw)) {
    return { usable: false, why: 'worker startup failure' }
  }
  if (report === null) return { usable: false, why: 'no JSON report produced' }

  const assertions = (report.testResults ?? []).flatMap((suite) => suite.assertionResults ?? [])
  if (assertions.length === 0) {
    // A collection error or a crash before the first test: not a result.
    return { usable: false, why: 'suite did not execute any test' }
  }
  return {
    usable: true,
    total: assertions.length,
    failed: assertions.filter((a) => a.status === 'failed').map((a) => a.fullName),
  }
}

/**
 * Decides whether the mutation was actually applied.
 *
 * An earlier harness used `grep -F`, which matches any single line of a
 * multi-line pattern: a stale anchor passed the check, the replacement silently
 * did nothing, and the suite ran on unmutated source and scored UNCAUGHT. Both
 * the presence check and the did-anything-change check exist because of that.
 */
export function planMutation({ source, from, to, scopeAfter = null }) {
  // When the harness mutates its OWN source, every anchor necessarily appears
  // twice: once in the executable code and once inside the mutant definition
  // that names it. Scoping the search past the mutant table is what makes such
  // a mutant expressible at all -- without it the anchor is always ambiguous.
  let offset = 0
  if (scopeAfter !== null) {
    // Resolved from the END: the marker also appears in the mutant definitions
    // that reference it, and only the last occurrence is the real boundary.
    offset = source.lastIndexOf(scopeAfter)
    if (offset < 0) return { ok: false, why: `scope marker not found: ${scopeAfter}` }
  }
  const head = source.slice(0, offset)
  const body = source.slice(offset)

  const occurrences = body.split(from).length - 1
  if (occurrences === 0) return { ok: false, why: 'anchor not found' }
  if (occurrences > 1) return { ok: false, why: 'anchor is ambiguous' }
  const mutated = head + body.replace(from, to)
  if (mutated === source) return { ok: false, why: 'mutation changed nothing' }
  return { ok: true, mutated }
}

/**
 * Reason codes for an exact-set attribution failure, so a rejection names the
 * specific way the evidence disagreed rather than a generic mismatch.
 */
export const ATTRIBUTION_REASONS = Object.freeze({
  unexpectedFailedTest: 'unexpected_failed_test',
  missingExpectedFailedTest: 'missing_expected_failed_test',
  duplicateFailedTestIdentity: 'duplicate_failed_test_identity',
  duplicateDeclaredTestIdentity: 'duplicate_declared_test_identity',
  failureIdentitySetMismatch: 'failure_identity_set_mismatch',
  invalidExactDeclaration: 'invalid_exact_declaration',
})

/** Entries repeated in a list, each reported once. */
function duplicatesOf(values) {
  const seen = new Set()
  const repeated = new Set()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    seen.add(value)
  }
  return [...repeated].sort()
}

/**
 * Validates a declaration that claims to be an exact identity set.
 *
 * A pattern cannot express an exact set: it says which names are acceptable,
 * never which names must ALL be present and no others. So a regex here is not
 * a weaker declaration, it is a different kind of claim, and accepting one
 * would reintroduce the gap this mode exists to close.
 */
export function validateExactDeclaration(declared) {
  if (!Array.isArray(declared) || declared.length === 0) {
    return { ok: false, reason: ATTRIBUTION_REASONS.invalidExactDeclaration, detail: 'exact declaration must be a non-empty array' }
  }
  const nonStrings = declared.filter((entry) => typeof entry !== 'string' || entry.trim().length === 0)
  if (nonStrings.length > 0) {
    return {
      ok: false,
      reason: ATTRIBUTION_REASONS.invalidExactDeclaration,
      detail: 'exact declaration accepts only non-empty exact strings; a pattern cannot express set equality',
    }
  }
  const duplicates = duplicatesOf(declared)
  if (duplicates.length > 0) {
    return {
      ok: false,
      reason: ATTRIBUTION_REASONS.duplicateDeclaredTestIdentity,
      detail: `declared identity repeated: ${duplicates[0]}`,
      duplicates,
    }
  }
  return { ok: true }
}

/**
 * Compares an observed failure set against a declared one, in both directions.
 *
 * Order-insensitive and identity-exact. Returned whole rather than as a
 * boolean, because the evidence has to record WHICH identity was unexpected or
 * missing -- a bare verdict cannot be audited independently later.
 */
export function compareFailureIdentitySets(declared, actual) {
  const declaredSet = new Set(declared)
  const actualSet = new Set(actual)
  return {
    declared: [...declared].sort(),
    actual: [...actual].sort(),
    unexpected: [...actual].filter((name) => !declaredSet.has(name)).sort(),
    missing: [...declared].filter((name) => !actualSet.has(name)).sort(),
    duplicateActual: duplicatesOf(actual),
    duplicateDeclared: duplicatesOf(declared),
  }
}

/**
 * The one derivation both the scorer and the standalone auditor run.
 *
 * Exported so the auditor can reach the same verdict from durable evidence
 * without reading the scorer's conclusion. Two computations of one equality is
 * the point; a second opinion that consults the first is not a second opinion.
 */
export function recomputeExactAttribution(declared, actual) {
  const comparison = compareFailureIdentitySets(declared, actual)
  return {
    ...comparison,
    equal: comparison.unexpected.length === 0
      && comparison.missing.length === 0
      && comparison.duplicateActual.length === 0
      && comparison.duplicateDeclared.length === 0
      && actual.length === declared.length,
  }
}

/**
 * Scores one mutant against the tests that were expected to catch it.
 *
 * Two modes, because two different claims are being made.
 *
 * The default is the original one: a mutant owns ONE test, and that named test
 * failing is what attributes it. Other failures in the same suite are the same
 * defect seen from another angle.
 *
 * `exactFailureSet` is for the bounded case where a mutant legitimately breaks
 * a known group -- a shared policy branch consumed by a whole matrix. There the
 * pattern form is not merely loose, it is unsound: matching says every observed
 * failure is acceptable, and says nothing about whether an undeclared failure
 * appeared or a declared one vanished. An independent review reproduced both:
 * 25 declared failures plus one undeclared scored `caught` as 26/26, and 24 of
 * the 25 scored `caught` as 24/24, each indistinguishable from the truthful
 * result. Exact set equality in both directions is the only check that
 * distinguishes them.
 */
export function scoreMutant({ expect: expected = [], result, exactFailureSet = false }) {
  if (!result.usable) return { kind: 'SKIPPED', detail: result.why }
  if (expected.length === 0) return { kind: 'SKIPPED', detail: 'no expected test declared' }

  if (exactFailureSet) return scoreExactFailureSet(expected, result)

  if (result.failed.length === 0) return { kind: 'UNCAUGHT', detail: 'suite stayed green' }
  const hit = result.failed.filter((name) => matchesExpectation(name, expected))
  if (hit.length === 0) {
    return {
      kind: 'SKIPPED',
      detail: `only unrelated tests failed: ${result.failed[0]?.slice(0, 60) ?? ''}`,
    }
  }
  return {
    kind: 'caught',
    detail: `${hit.length}/${result.failed.length} expected: ${hit[0].slice(0, 48)}`,
  }
}

/**
 * The exact-set path. Every rejection carries the identities that caused it, so
 * the standalone auditor can re-derive the same verdict from the artifact
 * without trusting this function's conclusion.
 */
function scoreExactFailureSet(declared, result) {
  const declarationCheck = validateExactDeclaration(declared)
  if (!declarationCheck.ok) {
    return {
      kind: 'SKIPPED',
      reason: declarationCheck.reason,
      detail: declarationCheck.detail,
      attribution: {
        mode: 'exact_failure_set',
        declared: Array.isArray(declared) ? [...declared].map(String).sort() : [],
        actual: [...result.failed].sort(),
        unexpected: [],
        missing: [],
        duplicateActual: duplicatesOf(result.failed),
        duplicateDeclared: Array.isArray(declared) ? duplicatesOf(declared.map(String)) : [],
        equal: false,
      },
    }
  }

  const comparison = compareFailureIdentitySets(declared, result.failed)
  const equal = comparison.unexpected.length === 0
    && comparison.missing.length === 0
    && comparison.duplicateActual.length === 0
    && comparison.duplicateDeclared.length === 0
    && result.failed.length === declared.length
  const attribution = { mode: 'exact_failure_set', ...comparison, equal }

  if (result.failed.length === 0) {
    return {
      kind: 'UNCAUGHT',
      reason: ATTRIBUTION_REASONS.missingExpectedFailedTest,
      detail: `suite stayed green; ${comparison.missing.length} declared failures never occurred`,
      attribution,
    }
  }
  if (comparison.duplicateActual.length > 0) {
    return {
      kind: 'SKIPPED',
      reason: ATTRIBUTION_REASONS.duplicateFailedTestIdentity,
      detail: `failed identity reported twice: ${comparison.duplicateActual[0]}`,
      attribution,
    }
  }
  if (comparison.unexpected.length > 0) {
    return {
      kind: 'SKIPPED',
      reason: ATTRIBUTION_REASONS.unexpectedFailedTest,
      detail: `${comparison.unexpected.length} undeclared failure(s), first: ${comparison.unexpected[0].slice(0, 60)}`,
      attribution,
    }
  }
  if (comparison.missing.length > 0) {
    return {
      kind: 'SKIPPED',
      reason: ATTRIBUTION_REASONS.missingExpectedFailedTest,
      detail: `${comparison.missing.length} declared failure(s) absent, first: ${comparison.missing[0].slice(0, 60)}`,
      attribution,
    }
  }
  if (!equal) {
    return {
      kind: 'SKIPPED',
      reason: ATTRIBUTION_REASONS.failureIdentitySetMismatch,
      detail: `declared ${declared.length} identities, observed ${result.failed.length}`,
      attribution,
    }
  }
  return {
    kind: 'caught',
    detail: `exact set ${result.failed.length}/${declared.length}, 0 unexpected, 0 missing`,
    attribution,
  }
}

/** A suite that is red before any mutation cannot attribute anything. */
export function baselineVerdict(result) {
  if (!result.usable) return `baseline unusable: ${result.why}`
  if (result.failed.length > 0) return `baseline already red (${result.failed.length} failing)`
  return null
}

/**
 * Recovers a Vitest JSON report from captured text.
 *
 * The reporter flushes to disk as the process exits, and under load that flush
 * can lose the race — leaving no file for a run that otherwise completed
 * normally. The same JSON is usually still present in captured stdout, so
 * reading it here recovers evidence the run already produced. This is not a
 * retry: nothing is re-executed, and a run that produced no report at all still
 * fails as an infrastructure failure.
 */
export function parseReportFromText(text) {
  if (typeof text !== 'string') return null
  const start = text.indexOf('{"numTotalTestSuites"')
  if (start < 0) return null
  try {
    return JSON.parse(text.slice(start))
  } catch {
    // Truncated mid-write: a partial report is not a report.
    return null
  }
}

/** A missing or unparseable report is infrastructure failure, never `caught`. */
export function classifyReportAvailability({ fileExists, fileText, stdout }) {
  if (fileExists === true) {
    try {
      return { report: JSON.parse(fileText), source: 'file' }
    } catch {
      const recovered = parseReportFromText(stdout)
      return recovered === null
        ? { report: null, source: 'unparseable file, no stdout fallback' }
        : { report: recovered, source: 'stdout (file was unparseable)' }
    }
  }
  const recovered = parseReportFromText(stdout)
  return recovered === null
    ? { report: null, source: 'no JSON report produced' }
    : { report: recovered, source: 'stdout (file missing)' }
}
