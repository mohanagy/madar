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

/** A process outcome reduced to its class, so two runs can be compared. */
export function processOutcomeClass(outcome) {
  if (outcome === null || outcome === undefined) return 'absent'
  if (outcome.child_started === false) return 'not_started'
  if (outcome.spawn_error !== null && outcome.spawn_error !== undefined) return 'spawn_failed'
  if (outcome.timed_out === true) return 'timed_out'
  if (outcome.termination_signal !== null && outcome.termination_signal !== undefined) return 'signalled'
  if (outcome.exit_code === 0) return 'exited_zero'
  if (typeof outcome.exit_code === 'number') return 'exited_nonzero'
  return 'unknown'
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
 * Re-derives the scoring class from the evidence.
 *
 * `caught` requires a named expected test to have failed. An unrelated failing
 * test is a harness problem, never proof the invariant is guarded.
 */
export function recomputeClassification({ kind, expected, attribution, outcome, signatures, reportUsable }) {
  if (signatures.length > 0) return 'infrastructure_failure'
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
    if (JSON.stringify(meta.outcome ?? null) !== JSON.stringify(outcome)) {
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

    // ---- the classification, re-derived -----------------------------------
    const recomputed = recomputeClassification({
      kind,
      expected,
      attribution,
      outcome,
      signatures,
      reportUsable: report !== null && attribution.total > 0,
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
      mutation_lifecycle: entry.mutation_lifecycle,
      lifecycle_truth: entry.lifecycle_truth,
    }))
    .sort((a, b) => `${a.kind} ${a.identity}`.localeCompare(`${b.kind} ${b.identity}`))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
