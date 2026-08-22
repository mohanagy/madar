/**
 * Semantic audit of mutation-harness evidence.
 *
 * The previous audit checked that files existed and that a couple of IDs
 * matched. An independent reviewer copied a complete matrix, pointed one
 * invocation's Vitest report at an unrelated suite, set `exactlyOne: false` in
 * its suite identity, and the audit still printed `artifact audit OK` for all
 * 95 invocations. Presence is not meaning.
 *
 * So this module re-derives the conclusions instead of reading them: suite
 * attribution from the report, the scoring class from the raw results, and the
 * restoration verdict from the digests. Where a stored value and a recomputed
 * one disagree, the stored value loses.
 *
 * Every finding carries a machine-readable `code` so a control can assert the
 * exact classification it induced rather than matching prose.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { matchesExpectation } from './mutation-scoring.mjs'

/** Artifacts every invocation must have, whatever happened to it. */
export const REQUIRED_ARTIFACTS = Object.freeze([
  'meta.json', 'command.json', 'suite-identity.json', 'report-identity.json',
  'scoring.json', 'restoration.json', 'stdout.txt', 'stderr.txt', 'display.log',
])

/** Artifacts an invocation may have. Anything else is unaccounted for. */
export const OPTIONAL_ARTIFACTS = Object.freeze(['report-source.txt', 'vitest-report.json'])

const JSON_ARTIFACTS = Object.freeze([
  'meta.json', 'command.json', 'suite-identity.json', 'report-identity.json',
  'scoring.json', 'restoration.json',
])

export const WORKER_SIGNATURES = Object.freeze([
  'Failed to start forks worker',
  'Timeout waiting for worker to respond',
])

/**
 * Filesystem timestamps are coarse and clocks drift; this is the tolerance
 * applied to "was this artifact created during its own invocation".
 */
export const CLOCK_TOLERANCE_MS = 5_000

const has = (value) => value !== null && value !== undefined

/**
 * A process outcome reduced to its class, so two runs can be compared.
 *
 * `spawn_error` is tested FIRST. It used to be tested after
 * `child_started === false`, and the harness sets `child_started` from
 * `spawnError === null` -- so every spawn failure took the not-started branch
 * and `spawn_failed` was unreachable for the only shape that can produce it. A
 * runner that does not exist and a run that was never attempted are different
 * facts and must not share a classification.
 */
export function processOutcomeClass(outcome) {
  if (outcome === null || outcome === undefined) return 'absent'
  if (has(outcome.spawn_error)) return 'spawn_failed'
  if (outcome.timed_out === true) return 'timed_out'
  if (has(outcome.termination_signal)) return 'signalled'
  if (outcome.child_started === false) return 'not_started'
  if (outcome.exit_code === 0) return 'exited_zero'
  if (typeof outcome.exit_code === 'number') return 'exited_nonzero'
  return 'unknown'
}

/**
 * Combinations the harness contract cannot produce.
 *
 * Reported rather than normalised: silently repairing an impossible outcome
 * would let falsified evidence pass as merely untidy.
 */
export function validateOutcomeCoherence(outcome, { reportPresent }) {
  if (outcome === null || outcome === undefined) return []
  const problems = []
  const push = (code, detail) => problems.push({ code, detail })

  if (has(outcome.spawn_error) && outcome.child_started === true) {
    push('spawn_error_with_started_child', 'a spawn error cannot accompany a started child')
  }
  if (has(outcome.spawn_error) && typeof outcome.exit_code === 'number') {
    push('spawn_error_with_exit_code', `a child that never spawned cannot exit ${outcome.exit_code}`)
  }
  if (outcome.timed_out === true && outcome.exit_code === 0) {
    push('timeout_with_successful_exit', 'a timed-out child cannot also exit 0')
  }
  if (has(outcome.termination_signal) && typeof outcome.exit_code === 'number') {
    push('signal_with_exit_code', `a signalled child cannot also report exit ${outcome.exit_code}`)
  }
  if (outcome.child_started === false && reportPresent) {
    push('not_started_with_report', 'a child that never started cannot have produced a report')
  }
  if (outcome.child_started === false && has(outcome.started_at) && has(outcome.finished_at)) {
    push('not_started_with_timestamps', 'a child that never started carries start and finish timestamps')
  }
  return problems
}

/**
 * Recomputes suite attribution from the report rather than trusting the
 * precomputed identity file.
 */
export function recomputeAttribution({ report, requestedSuite, root }) {
  const requested = resolve(root, requestedSuite)
  const rows = Array.isArray(report?.testResults) ? report.testResults : []
  const reported = rows.map((row) => resolve(root, String(row?.name ?? '')))
  const unexpected = reported.filter((id) => id !== requested).map((id) => relative(root, id))
  const assertions = rows.flatMap((row) => (Array.isArray(row?.assertionResults) ? row.assertionResults : []))
  return {
    reported: reported.map((id) => relative(root, id)),
    unexpected,
    // Cardinality, not set membership: two rows naming the SAME requested
    // module satisfy set equality and still mean the module ran twice.
    exactlyOne: reported.length === 1 && unexpected.length === 0,
    total: assertions.length,
    failed: assertions.filter((a) => a?.status === 'failed').map((a) => String(a?.fullName ?? '')),
  }
}

/**
 * Derives what the Vitest report itself says, independently of any stored
 * classification.
 *
 * `unavailable` is a third state on purpose: a missing or partial report is an
 * infrastructure condition, and collapsing it into green or red would let an
 * absent report satisfy a concordance rule it never participated in.
 */
export const REPORT_FAILURE_FIELDS = Object.freeze([
  'success', 'numFailedTestSuites', 'numFailedTests',
  'testResults[].status', 'testResults[].message', 'testResults[].assertionResults[].status',
])

/**
 * Every authoritative failure indicator the installed reporter emits.
 *
 * Verified against vitest 4.1.10, whose JSON report carries top-level
 * `success`, `numFailedTestSuites`, `numFailedTests`, and per-file
 * `status` / `message` / `assertionResults[].status`.
 *
 * The previous derivation consulted assertion results ALONE. A reviewer set
 * `success:false`, `numFailedTestSuites:1`, the file row to `failed` and added
 * a file-level message, left all 54 assertions passing, and the audit derived
 * `green` and returned the unchanged checkpoint digest. A suite that dies
 * before its first assertion has no failed assertion to find, which is exactly
 * the shape this missed.
 */
function reportFailureIndicators(report) {
  const found = []
  if (report.success === false) found.push('success:false')
  if (typeof report.numFailedTestSuites === 'number' && report.numFailedTestSuites > 0) {
    found.push(`numFailedTestSuites:${report.numFailedTestSuites}`)
  }
  if (typeof report.numFailedTests === 'number' && report.numFailedTests > 0) {
    found.push(`numFailedTests:${report.numFailedTests}`)
  }
  for (const file of Array.isArray(report.testResults) ? report.testResults : []) {
    if (file?.status === 'failed') found.push(`file status:failed (${file?.name ?? 'unnamed'})`)
    if (typeof file?.message === 'string' && file.message.trim() !== '') {
      found.push(`file message: ${file.message.trim().slice(0, 60)}`)
    }
    for (const a of Array.isArray(file?.assertionResults) ? file.assertionResults : []) {
      if (a?.status === 'failed') found.push(`test failed: ${String(a?.fullName ?? '').slice(0, 60)}`)
    }
  }
  // Unhandled/report-level errors, when the reporter emits them.
  for (const key of ['errors', 'unhandledErrors']) {
    if (Array.isArray(report[key]) && report[key].length > 0) found.push(`${key}:${report[key].length}`)
  }
  return found
}

/**
 * Derives what the Vitest report itself says, independently of any stored
 * classification.
 *
 * `unavailable` is a deliberate third state, used both for a structurally
 * incomplete report and for one whose own fields contradict each other. The
 * favorable indicator is never silently preferred: a report claiming
 * `success:true` while also reporting failures is not evidence of anything.
 */
export function deriveReportStatus({ report, attribution }) {
  if (report === null || report === undefined) return 'unavailable'
  if (attribution.total === 0) return 'unavailable'
  if (!attribution.exactlyOne) return 'unavailable'

  const failures = reportFailureIndicators(report)
  if (failures.length > 0) {
    // A report asserting success while carrying failure indicators is
    // internally inconsistent; refusing it is the only safe reading.
    return report.success === true ? 'unavailable' : 'red'
  }
  // Green requires every applicable indicator to agree, not merely the absence
  // of a failed assertion.
  if (report.success !== undefined && report.success !== true) return 'unavailable'
  return 'green'
}

/** The exact indicators that made a report red, for the audit's detail line. */
export function reportFailureReasons(report) {
  return report === null || report === undefined ? [] : reportFailureIndicators(report)
}

/**
 * Derives what the process did, from the agreed persisted outcome.
 *
 * Ordinary completion is separated from every infrastructure ending because
 * only ordinary completion carries a meaningful relationship to the report: a
 * signalled or timed-out child says nothing about whether tests passed.
 */
export function deriveProcessStatus(outcome) {
  switch (processOutcomeClass(outcome)) {
    case 'spawn_failed': return 'spawn_failed'
    case 'timed_out': return 'timed_out'
    case 'signalled': return 'signalled'
    case 'not_started': return 'not_started'
    case 'exited_zero': return 'ordinary_zero'
    case 'exited_nonzero': return 'ordinary_nonzero'
    default: return 'indeterminate'
  }
}

/**
 * The concordance invariant: for an ordinary completed child with a complete,
 * usable report, `exit_code === 0` if and only if the report is green.
 *
 * An independent reviewer falsified BOTH persisted status artifacts to zero and
 * left a red report in place. Every existing check passed: the two artifacts
 * agreed with each other, so the cross-artifact rule saw nothing, and no rule
 * compared either of them against the report. The audit reported OK and even
 * produced a different-but-accepted digest.
 *
 * Deliberately NOT applied to signal, timeout, spawn failure, worker-start or
 * handshake failure, or a missing/partial report. Those endings are governed by
 * their own explicit infrastructure classifications, and forcing this rule onto
 * them would reclassify real infrastructure failures as tampering.
 */
export function checkStatusConcordance({ reportStatus, processStatus, signatures = [] }) {
  if (signatures.length > 0) return null
  if (reportStatus === 'unavailable') return null
  if (processStatus !== 'ordinary_zero' && processStatus !== 'ordinary_nonzero') return null

  if (processStatus === 'ordinary_zero' && reportStatus === 'red') {
    return {
      code: 'red_report_zero_exit',
      detail: 'report contains failing tests but the process is recorded as exiting 0',
    }
  }
  if (processStatus === 'ordinary_nonzero' && reportStatus === 'green') {
    return {
      code: 'green_report_nonzero_exit',
      detail: 'report contains no failing test but the process is recorded as exiting non-zero',
    }
  }
  return null
}

/**
 * Re-derives the scoring class from the evidence.
 *
 * `caught` requires a named expected test to have failed. An unrelated failing
 * test is a harness problem, never proof the invariant is guarded.
 */
export function recomputeClassification({
  kind, expected, attribution, outcome, signatures, reportUsable, concordant = true,
}) {
  if (signatures.length > 0) return 'infrastructure_failure'
  // Attribution is not reached while the evidence contradicts itself. A red
  // report with a persisted zero exit must fail the audit BEFORE the failing
  // tests it names can be read as proof a mutant was caught.
  if (!concordant) return 'unverifiable'
  if (!reportUsable) return 'infrastructure_failure'
  const outcomeClass = processOutcomeClass(outcome)
  if (['not_started', 'spawn_failed', 'timed_out', 'signalled', 'absent'].includes(outcomeClass)) {
    return 'infrastructure_failure'
  }
  if (attribution.total === 0) return 'infrastructure_failure'
  if (kind === 'baseline') return attribution.failed.length === 0 ? 'baseline_passed' : 'infrastructure_failure'
  if (expected.length === 0) return 'skipped'
  if (attribution.failed.length === 0) return 'uncaught'
  const hit = attribution.failed.filter((name) => matchesExpectation(name, expected))
  return hit.length === 0 ? 'skipped' : 'caught'
}

const parseTime = (value) => {
  const ms = Date.parse(String(value ?? ''))
  return Number.isNaN(ms) ? null : ms
}

/**
 * Audits one artifact root.
 *
 * `now` is injected so a control can prove the freshness rule fires rather than
 * waiting for a clock.
 */
export function auditEvidence({
  root,
  sourceRoot = root,
  expectedMutants = null,
  expectedBaselines = null,
  runId = null,
  now = Date.now(),
}) {
  const problems = []
  const add = (code, invocation, detail) => problems.push({ code, invocation, detail })

  if (!existsSync(root)) {
    add('artifact_root_missing', null, `no artifact root at ${root}`)
    return { problems, invocations: [], mutants: 0, baselines: 0, semanticDigest: null }
  }

  const names = readdirSync(root)
    .filter((name) => statSync(resolve(root, name)).isDirectory())
    .sort()

  const invocations = []
  const seenIds = new Map()

  for (const name of names) {
    const dir = resolve(root, name)
    const present = new Set(readdirSync(dir))

    for (const file of REQUIRED_ARTIFACTS) {
      if (!present.has(file)) add('missing_artifact', name, `missing ${file}`)
    }
    for (const file of present) {
      if (!REQUIRED_ARTIFACTS.includes(file) && !OPTIONAL_ARTIFACTS.includes(file)) {
        add('unexpected_artifact', name, `unaccounted artifact ${file}`)
      }
    }

    const json = {}
    let readable = true
    for (const file of JSON_ARTIFACTS) {
      if (!present.has(file)) { readable = false; continue }
      try {
        json[file] = JSON.parse(readFileSync(resolve(dir, file), 'utf8'))
      } catch (error) {
        add('artifact_unreadable', name, `${file} unreadable (${error.message})`)
        readable = false
      }
    }
    if (!readable) continue

    const meta = json['meta.json']
    const command = json['command.json']
    const suiteIdentity = json['suite-identity.json']
    const reportIdentity = json['report-identity.json']
    const scoring = json['scoring.json']
    const restoration = json['restoration.json']

    // ---- identity ---------------------------------------------------------
    const ids = new Set(JSON_ARTIFACTS.map((file) => json[file]?.invocation_id))
    const id = scoring.invocation_id
    if (ids.size !== 1) {
      add('invocation_id_mismatch', name, `artifacts name ${ids.size} different invocations`)
    }
    if (typeof id !== 'string' || id.length === 0) {
      add('invocation_id_missing', name, 'scoring.json carries no invocation identity')
    } else {
      if (seenIds.has(id)) add('duplicate_invocation_id', name, `invocation_id also used by ${seenIds.get(id)}`)
      seenIds.set(id, name)
      if (runId !== null && !id.startsWith(runId)) {
        add('foreign_invocation', name, 'invocation_id does not belong to this run')
      }
    }

    const kind = scoring.mutant_id !== undefined ? 'mutant'
      : scoring.baseline_identity !== undefined ? 'baseline' : null
    if (kind === null) {
      add('unclassified_invocation', name, 'scoring.json identifies neither a mutant nor a baseline')
      continue
    }

    // ---- requested suite, agreed by every artifact that names one ---------
    const requestedSuite = scoring.requested_suite
    const claims = {
      'meta.json': meta.testFile,
      'command.json': command.requested_suite,
      'suite-identity.json': suiteIdentity.requested,
      'report-identity.json': reportIdentity.requested_suite,
    }
    for (const [file, claim] of Object.entries(claims)) {
      if (claim !== undefined && claim !== requestedSuite) {
        add('requested_suite_mismatch', name, `${file} requests ${claim}, scoring requests ${requestedSuite}`)
      }
    }
    if (Array.isArray(command.argv) && !command.argv.includes(requestedSuite)) {
      add('command_suite_mismatch', name, 'recorded argv does not name the requested suite')
    }
    if (kind === 'mutant' && meta.mutant !== undefined && meta.mutant !== scoring.mutant_id) {
      add('mutant_identity_mismatch', name, `meta names ${meta.mutant}, scoring names ${scoring.mutant_id}`)
    }

    const expected = scoring.expected_test_identities ?? []
    if (meta.expected !== undefined && JSON.stringify(meta.expected) !== JSON.stringify(expected)) {
      add('expectation_mismatch', name, 'meta and scoring disagree about the expected tests')
    }

    // ---- process outcome, agreed by meta and scoring ----------------------
    const outcome = scoring.process_outcome ?? null
    // Agreement is a PRECONDITION for deriving a process status, not merely
    // another finding. While the two artifacts disagree there is no established
    // process outcome to compare the report against, so the concordance rule
    // below is not applied and the cross-artifact code stands alone.
    const outcomeAgrees = JSON.stringify(meta.outcome ?? null) === JSON.stringify(outcome)
    if (!outcomeAgrees) {
      add('process_outcome_mismatch', name, 'meta and scoring disagree about the process outcome')
    }
    const outcomeClass = processOutcomeClass(outcome)
    if (outcomeClass === 'unknown') {
      add('process_outcome_incomplete', name, 'exit code is null for a child that was neither signalled nor timed out')
    }

    // ---- the report itself ------------------------------------------------
    const reportPath = resolve(dir, 'vitest-report.json')
    const reportOnDisk = existsSync(reportPath)
    let report = null
    if (reportOnDisk) {
      const bytes = readFileSync(reportPath)
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (reportIdentity.report_digest !== digest) {
        // The sidecar is stamped while the report is being captured; a report
        // swapped in afterwards cannot reproduce that digest.
        add('report_digest_mismatch', name, 'report on disk is not the report this invocation produced')
      }
      if (reportIdentity.report_bytes !== bytes.byteLength) {
        add('report_size_mismatch', name, 'recorded report size does not match the file')
      }
      try {
        report = JSON.parse(bytes.toString('utf8'))
      } catch (error) {
        add('report_unreadable', name, `vitest-report.json unreadable (${error.message})`)
      }
    } else if (reportIdentity.report_present === true) {
      add('report_missing', name, 'sidecar claims a report that is not on disk')
    }

    const stdout = present.has('stdout.txt') ? readFileSync(resolve(dir, 'stdout.txt'), 'utf8') : ''
    const stderr = present.has('stderr.txt') ? readFileSync(resolve(dir, 'stderr.txt'), 'utf8') : ''
    const signatures = WORKER_SIGNATURES.filter((signature) => `${stdout}${stderr}`.includes(signature))
    const storedSignatures = [
      ...(scoring.worker_start_signatures ?? []),
      ...(scoring.handshake_signatures ?? []),
    ].map((hit) => hit.signature)
    for (const signature of signatures) {
      if (!storedSignatures.includes(signature)) {
        add('signature_not_recorded', name, `raw output contains "${signature}" but scoring does not record it`)
      }
    }

    const attribution = report === null
      ? { reported: [], unexpected: [], exactlyOne: false, total: 0, failed: [] }
      : recomputeAttribution({ report, requestedSuite, root: sourceRoot })

    if (report !== null) {
      if (attribution.reported.length === 0) {
        add('report_empty', name, 'report names no suite at all')
      }
      if (attribution.unexpected.length > 0) {
        add('report_suite_mismatch', name, `report names unrequested suite(s): ${attribution.unexpected.join(', ')}`)
      }
      if (!attribution.exactlyOne) {
        add('report_cardinality', name, `report names ${attribution.reported.length} suite(s), expected exactly one`)
      }
      if (suiteIdentity.exactlyOne !== attribution.exactlyOne) {
        add('suite_identity_disagrees', name, 'stored suite identity disagrees with the report')
      }
      if (JSON.stringify(suiteIdentity.reported ?? []) !== JSON.stringify(attribution.reported)) {
        add('suite_identity_reported_mismatch', name, 'stored reported suites disagree with the report')
      }
      if (JSON.stringify(scoring.observed_failed_test_identities ?? []) !== JSON.stringify(attribution.failed)) {
        add('observed_failures_mismatch', name, 'stored failed tests disagree with the report')
      }
    }

    // ---- process / report status concordance ------------------------------
    // Derived from the artifacts themselves, never from a stored verdict.
    const reportStatus = deriveReportStatus({ report, attribution })
    const processStatus = outcomeAgrees ? deriveProcessStatus(outcome) : 'unestablished'
    const discord = outcomeAgrees
      ? checkStatusConcordance({ reportStatus, processStatus, signatures })
      : null
    for (const problem of validateOutcomeCoherence(outcome, { reportPresent: report !== null })) {
      add(problem.code, name, problem.detail)
    }
    if (discord !== null) {
      add(discord.code, name, `${discord.detail} (report ${reportStatus}, process ${processStatus})`)
    }

    // ---- the classification, re-derived -----------------------------------
    const recomputed = recomputeClassification({
      kind,
      expected,
      attribution,
      outcome,
      signatures,
      reportUsable: report !== null && attribution.total > 0,
      concordant: outcomeAgrees && discord === null
        && validateOutcomeCoherence(outcome, { reportPresent: report !== null }).length === 0,
    })
    if (scoring.classification !== recomputed) {
      add('classification_unsupported', name,
        `scoring says ${scoring.classification}, evidence supports ${recomputed}`)
    }

    // ---- restoration ------------------------------------------------------
    const lifecycle = restoration.mutation_lifecycle
    if (lifecycle === 'applied') {
      for (const path of restoration.source_paths ?? []) {
        const pre = restoration.pre_mutation_digests?.[path]
        const mutated = restoration.mutated_digests?.[path]
        const post = restoration.post_restoration_digests?.[path]
        if (pre === undefined || mutated === undefined || post === undefined) {
          add('mutation_lifecycle_incomplete', name, `lifecycle incomplete for ${path}`)
        } else if (pre === mutated) {
          // Three readings of one restored file, presented as a lifecycle.
          add('mutation_lifecycle_not_applied', name, `pre and mutated digests are equal for ${path}`)
        } else if (post !== pre) {
          add('restoration_not_verified', name, `post-restoration digest differs from pre-mutation digest for ${path}`)
        }
      }
      if (restoration.restoration_succeeded !== true || restoration.tree_clean_after !== true) {
        add('restoration_failed', name, `restoration left: ${(restoration.leftover_paths ?? []).join(', ') || 'unknown'}`)
      }
      if ((restoration.leftover_paths ?? []).length > 0) {
        add('restoration_leftovers', name, `leftover paths: ${restoration.leftover_paths.join(', ')}`)
      }
    } else if (lifecycle === 'not_applied') {
      // Attempted and changed nothing: pre and mutated MUST be equal here, and
      // the invocation must not have been scored as evidence of anything.
      for (const path of restoration.source_paths ?? []) {
        if (restoration.pre_mutation_digests?.[path] !== restoration.mutated_digests?.[path]) {
          add('mutation_lifecycle_incomplete', name, `${path} changed but is recorded as unmutated`)
        }
      }
      if (scoring.classification !== 'infrastructure_failure') {
        add('classification_unsupported', name, 'an unapplied mutation was scored as evidence')
      }
    } else if (lifecycle === 'not_applicable') {
      const digests = [
        restoration.pre_mutation_digests, restoration.mutated_digests, restoration.post_restoration_digests,
      ]
      if (digests.some((entry) => Object.keys(entry ?? {}).length > 0)) {
        add('fabricated_lifecycle', name, 'a not-applicable lifecycle carries mutation digests')
      }
      if (restoration.restoration_attempted !== false) {
        add('fabricated_lifecycle', name, 'a not-applicable lifecycle claims a restoration attempt')
      }
    } else {
      add('mutation_lifecycle_missing', name, 'restoration.json declares no mutation lifecycle')
    }

    // ---- freshness --------------------------------------------------------
    const startedMs = parseTime(reportIdentity.invocation_started_at ?? meta.outcome?.started_at)
    const finishedMs = parseTime(reportIdentity.invocation_finished_at ?? meta.outcome?.finished_at)
    const capturedMs = parseTime(reportIdentity.captured_at)
    if (startedMs !== null && capturedMs !== null && capturedMs + CLOCK_TOLERANCE_MS < startedMs) {
      add('report_freshness_violation', name, 'report was captured before the invocation started')
    }
    if (capturedMs !== null && capturedMs > now + CLOCK_TOLERANCE_MS) {
      add('report_freshness_violation', name, 'report claims to have been captured in the future')
    }
    if (startedMs !== null && finishedMs !== null && finishedMs < startedMs) {
      add('report_freshness_violation', name, 'invocation finished before it started')
    }
    if (reportOnDisk && startedMs !== null) {
      const modified = statSync(reportPath).mtimeMs
      // A report carried over from another invocation keeps its own mtime, and
      // a same-basename copy is otherwise indistinguishable.
      const tooOld = modified + CLOCK_TOLERANCE_MS < startedMs
      const tooNew = finishedMs !== null && modified > finishedMs + CLOCK_TOLERANCE_MS
      if (tooOld || tooNew) {
        add('artifact_outside_invocation_bounds', name, 'report file was not written during this invocation')
      }
    }

    invocations.push({
      directory: name,
      invocation_id: id,
      kind,
      identity: kind === 'mutant' ? scoring.mutant_id : scoring.baseline_identity,
      requested_suite: requestedSuite,
      expected_test_identities: [...expected].sort(),
      observed_failed_test_identities: [...attribution.failed].sort(),
      classification: scoring.classification,
      recomputed_classification: recomputed,
      process_outcome_class: outcomeClass,
      report_status: reportStatus,
      process_status: processStatus,
      mutation_lifecycle: lifecycle ?? 'missing',
      lifecycle_truth: (restoration.source_paths ?? []).map((path) => ({
        path,
        mutated_differs_from_pre: restoration.pre_mutation_digests?.[path] !== restoration.mutated_digests?.[path],
        post_equals_pre: restoration.post_restoration_digests?.[path] === restoration.pre_mutation_digests?.[path],
      })),
    })
  }

  const mutants = invocations.filter((entry) => entry.kind === 'mutant').length
  const baselines = invocations.filter((entry) => entry.kind === 'baseline').length
  if (expectedMutants !== null && mutants !== expectedMutants) {
    add('mutant_count', null, `audited ${mutants} mutants, expected ${expectedMutants}`)
  }
  if (expectedBaselines !== null && baselines !== expectedBaselines) {
    add('baseline_count', null, `audited ${baselines} baselines, expected ${expectedBaselines}`)
  }

  return { problems, invocations, mutants, baselines, semanticDigest: semanticAuditDigest(invocations) }
}

/**
 * A digest of what the matrix MEANS.
 *
 * Deliberately excludes run identity, paths, timestamps and durations, and
 * deliberately includes the truth of the digest lifecycle rather than the
 * digests themselves. Two equivalent matrices agree here; two matrices that
 * disagree about a single classification do not.
 */
export function semanticAuditDigest(invocations) {
  const canonical = invocations
    .map((entry) => ({
      kind: entry.kind,
      identity: entry.identity,
      requested_suite: entry.requested_suite,
      expected_test_identities: entry.expected_test_identities,
      classification: entry.classification,
      recomputed_classification: entry.recomputed_classification,
      process_outcome_class: entry.process_outcome_class,
      // Independently derived, so a matrix whose stored status was falsified
      // cannot produce the digest of a truthful one.
      report_status: entry.report_status,
      process_status: entry.process_status,
      mutation_lifecycle: entry.mutation_lifecycle,
      lifecycle_truth: entry.lifecycle_truth,
    }))
    .sort((a, b) => `${a.kind} ${a.identity}`.localeCompare(`${b.kind} ${b.identity}`))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
