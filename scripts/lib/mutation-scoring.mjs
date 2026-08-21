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
 * Scores one mutant against the tests that were expected to catch it.
 *
 * Only a named expected test failing counts as caught. A suite that went red
 * for some other reason is a harness failure, never evidence -- recording it as
 * caught is exactly the misattribution this scoring exists to prevent.
 */
export function scoreMutant({ expect: expected = [], result }) {
  if (!result.usable) return { kind: 'SKIPPED', detail: result.why }
  if (expected.length === 0) return { kind: 'SKIPPED', detail: 'no expected test declared' }
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
