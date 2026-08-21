#!/usr/bin/env node
/**
 * Mutation verification for the #658 graph-integrity contracts.
 *
 * Each mutant breaks one invariant in production code and must turn its focused
 * suite RED. A mutant that leaves the suite green is UNCAUGHT: the test naming
 * that invariant is vacuous.
 *
 * This lives in the repository rather than a scratchpad because evidence that
 * cannot be reproduced from a clean checkout is not evidence. The independent
 * Stage 2 review made exactly that point.
 *
 * Scoring is deliberately strict. A mutant counts as caught only when the suite
 * actually ran and reported real test failures. Every other outcome -- a stale
 * anchor, a replacement that changed nothing, a missing test file, a worker
 * startup failure, any non-test crash -- is SKIPPED, never caught. An earlier
 * harness used `grep -F` to check anchors, which matches ANY SINGLE LINE of a
 * multi-line pattern; a stale anchor passed, the replacement silently failed,
 * the suite ran on unmutated source and was scored UNCAUGHT. The
 * did-the-file-actually-change check below exists because of that.
 *
 * Usage:  node scripts/verify-integrity-mutations.mjs [--filter <substring>]
 * Exit 0 only when caught > 0, uncaught === 0 and skipped === 0.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { auditEvidence } from './lib/evidence-audit.mjs'
import {
  baselineVerdict,
  classifyReportAvailability,
  planMutation,
  readSuiteResult,
  scoreMutant,
} from './lib/mutation-scoring.mjs'

const ROOT = process.cwd()
const CONTRACTS = 'src/contracts/graph-integrity.ts'
const SESSION = 'src/contracts/graph-integrity-session.ts'
const BUILD = 'src/pipeline/build.ts'
const GRAPH = 'src/contracts/graph.ts'
const SNAPSHOT_SRC = 'src/contracts/graph-integrity-snapshot.ts'
const VALIDATION = 'src/contracts/graph-integrity-validation.ts'
const JSON_GUARDS = 'src/contracts/graph-integrity-json.ts'
const GUARDS = 'scripts/lib/receipt-guards.mjs'
const REGISTRY_SRC = 'scripts/lib/resource-registry.mjs'
const CHILD_RUNNER = 'scripts/lib/child-runner.mjs'
const MUTATIONS_SELF = 'scripts/verify-integrity-mutations.mjs'
const SCORING_SRC = 'scripts/lib/mutation-scoring.mjs'

const SHARE_SAFETY = 'tests/unit/integrity-record-share-safety.test.ts'
const ACCOUNTING = 'tests/unit/normalized-candidate-accounting.test.ts'
const CONTRACT_TESTS = 'tests/unit/graph-integrity-contracts.test.ts'
const RECEIPT_TESTS = 'tests/unit/graph-integrity-receipt.test.ts'
const SNAPSHOT = 'tests/unit/integrity-snapshot.test.ts'
const TARGET_POLICY = 'tests/unit/verification-target-policy.test.ts'
const TAMPER = 'tests/unit/integrity-snapshot-tamper.test.ts'
const INVALIDATION = 'tests/unit/integrity-snapshot-invalidation.test.ts'
const IMMUTABILITY = 'tests/unit/integrity-snapshot-immutability.test.ts'
const TOTAL_VALIDATION = 'tests/unit/integrity-snapshot-total-validation.test.ts'
const RETENTION_SHAPE = 'tests/unit/detail-retention-shape.test.ts'
const QUALIFICATION = 'tests/unit/endpoint-qualification-invalidation.test.ts'
const CLOSED_SCHEMAS = 'tests/unit/integrity-closed-schemas.test.ts'
const JSON_SAFETY = 'tests/unit/integrity-json-safety.test.ts'
const RECORD_IDENTITY = 'tests/unit/integrity-record-identity.test.ts'
const RECEIPT_GUARDS = 'tests/unit/receipt-exact-ref-guards.test.ts'
const RECEIPT_CLEANUP = 'tests/unit/receipt-resource-cleanup.test.ts'
const SIGNAL_E2E = 'tests/unit/receipt-signal-responsiveness.test.ts'
const HARNESS_SELF = 'tests/unit/mutation-harness-self.test.ts'
const EVIDENCE_LIFECYCLE = 'tests/unit/mutation-evidence-lifecycle.test.ts'
const EVIDENCE_AUDIT_SRC = 'scripts/lib/evidence-audit.mjs'
const EVIDENCE_AUDIT = 'tests/unit/mutation-evidence-audit.test.ts'
const EVIDENCE_HELPER = 'tests/unit/helpers/evidence-matrix.ts'

/**
 * Every mutant names the file it breaks and the ONE focused suite expected to
 * catch it, so a green result cannot come from some unrelated suite.
 */
/**
 * Deliberately NOT mutated, because they are equivalent by construction and a
 * green result would be a false negative rather than evidence:
 *
 * - the narrowed catch in `sanitizedPathLike`. `normalizeIdentityRepositoryPath`
 *   throws only `SemanticIdentityInvariantError`, so narrowing is behaviourally
 *   identical today and is forward-looking defence against a future signature
 *   change. It is kept because the review asked for it, not because a test can
 *   currently distinguish it.
 * - the retained-draft memory bound, whose presence or absence produces the same
 *   record cap and the same exact distinct total.
 */
const EXECUTABLE_SECTION = '===== executable section; nothing below is mutant data ====='

const MUTANTS = [
  {
    name: 'B1: stop refusing root-derived endpoints',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: '  if (isRootDerivedIdentifier(normalized, flattenedRoot)) return undefined',
    to: '',
    expect: [
      'B1 — a flattened checkout path never reaches a shared record omits a root-derived endpoint from the share-safe record',
      'B1 — a flattened checkout path never reaches a shared record never lets the username appear in a share-safe record',
    ],
  },
  {
    name: 'B1: match the root anywhere instead of at a segment boundary',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: '  return lower.startsWith(`${flattenedRoot}_`)',
    to: '  return lower.includes(flattenedRoot)',
    expect: [
      'B1 — a flattened checkout path never reaches a shared record matches the flattened root only at a segment boundary',
    ],
  },
  {
    name: 'B1: key identity on the redacted projection',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: '      ...(draft.source !== undefined ? { source: draft.source } : {}),',
    to: '      ...(source !== undefined ? { source } : {}),',
    expect: [
      'B1 — a flattened checkout path never reaches a shared record does not collapse two redacted endpoints onto one record',
    ],
  },
  {
    name: 'B2: accept percent-encoded separators in endpoints',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: '  if (PERCENT_ESCAPE.test(normalized)) return undefined',
    to: '',
    expect: [
      'B2 — endpoint identifiers refuse every path disguise refuses percent-encoded separator',
      'B2 — endpoint identifiers refuse every path disguise applies the same disguise rules to relation tokens',
    ],
  },
  {
    name: 'B2: accept Unicode separator look-alikes in endpoints',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: '  if (SEPARATOR_LOOKALIKES.test(normalized)) return undefined',
    to: '',
    expect: [
      'B2 — endpoint identifiers refuse every path disguise refuses U+2044 fraction slash',
      'B2 — endpoint identifiers refuse every path disguise refuses U+2215 division slash',
    ],
  },
  {
    name: 'B2: skip NFC normalization',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: "  const normalized = value.normalize('NFC')\n  if (normalized.length === 0 || normalized.length > MAX_ENDPOINT_ID_LENGTH) return undefined",
    to: '  const normalized = value\n  if (normalized.length === 0 || normalized.length > MAX_ENDPOINT_ID_LENGTH) return undefined',
    expect: [
      'B2 — endpoint identifiers refuse every path disguise treats NFC and NFD spellings as one identifier',
    ],
  },
  {
    name: 'B2: accept traversal-only endpoint values',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: '  if (TRAVERSAL_ONLY.test(normalized)) return undefined',
    to: '',
    expect: [
      'B2 — endpoint identifiers refuse every path disguise refuses dot-dot',
      'B2 — endpoint identifiers refuse every path disguise refuses single dot',
    ],
  },
  {
    // Renamed: this resets one retention object. It does NOT reconstruct from
    // the bounded array, which was the actual B3 defect -- the two mutants
    // below do that.
    name: 'B3: reset occurrence retention during multiplicity finalization',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: '  return Object.freeze({ ...record, multiplicity }) as unknown as T',
    to: '  return Object.freeze({ ...record, multiplicity, occurrenceRetention: detailRetention(0, 0) }) as unknown as T',
    expect: [
      'B3 — finalization preserves retention truth and record identity keeps the true occurrence total when detail is capped',
    ],
  },
  {
    // The real B3 shape: rebuild the record from its already-bounded detail, so
    // 50 occurrences capped to 16 report a total of 16 instead of 50.
    name: 'B3: rebuild occurrence retention from the bounded array',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: '  return Object.freeze({ ...record, multiplicity }) as unknown as T',
    to: `  return Object.freeze({
    ...record,
    multiplicity,
    ...('occurrences' in record
      ? { occurrenceRetention: detailRetention(record.occurrences.length, record.occurrences.length) }
      : {}),
  }) as unknown as T`,
    expect: [
      'B3 — finalization preserves retention truth and record identity keeps the true occurrence total when detail is capped',
    ],
  },
  {
    name: 'B3: digest only the retained fingerprint slice',
    file: CONTRACTS,
    test: SHARE_SAFETY,
    from: '    const fingerprintSetDigest = conflictFingerprintSetDigest(complete)',
    to: '    const fingerprintSetDigest = conflictFingerprintSetDigest(complete.slice(0, MAX_CONFLICT_FINGERPRINTS))',
    expect: [
      'B3 — finalization preserves retention truth and record identity changes identity when the complete set changes, even if the retained slice does not',
    ],
  },
  {
    name: 'R2: drop per-kind record retention',
    file: SESSION,
    test: SNAPSHOT,
    from: '        unresolved: detailRetention(unresolvedRecords.length, this.unresolvedRetained.distinctTotal),',
    to: '        unresolved: detailRetention(unresolvedRecords.length, unresolvedRecords.length),',
    expect: [
      'R2 — retention metadata is validated, never trusted carries the true total when records are capped',
    ],
  },
  {
    name: 'R2: accept an inconsistent omitted count',
    file: CONTRACTS,
    test: SNAPSHOT,
    from: '  if (retention.omitted !== retention.total - retention.retained) {',
    to: '  if (false) {',
    expect: [
      'R2 — retention metadata is validated, never trusted rejects omitted mismatch',
    ],
  },
  {
    name: 'R2: accept a false truncated flag',
    file: CONTRACTS,
    test: SNAPSHOT,
    from: '  if (retention.truncated !== retention.omitted > 0) {',
    to: '  if (false) {',
    expect: [
      'R2 — retention metadata is validated, never trusted rejects truncated false with omissions',
      'R2 — retention metadata is validated, never trusted rejects truncated true with none omitted',
    ],
  },
  {
    name: 'R3: never finalize the composite snapshot',
    file: GRAPH,
    test: SNAPSHOT,
    from: '    const snapshot = finalizeNormalizedIntegritySnapshot({',
    to: '    const snapshot = (null as never) && finalizeNormalizedIntegritySnapshot({',
    expect: [
      'R3 — production attaches one complete snapshot is attached by a real normalized build, not only by a helper',
      'R3 — production attaches one complete snapshot carries every field a serializer needs',
    ],
  },
  {
    name: 'R3: neuter the central invalidation seam',
    file: GRAPH,
    test: INVALIDATION,
    from: '  private invalidateIntegritySnapshot(): void {\n    this.integritySnapshot = null',
    to: '  private invalidateIntegritySnapshot(): void {\n    void 0',
    expect: [
      'R3-04 — every successful mutation invalidates the snapshot node insertion',
      'R3-04 — every successful mutation invalidates the snapshot node attribute change',
    ],
  },
  {
    name: 'R3: let a subgraph inherit the full-graph snapshot',
    file: GRAPH,
    test: SNAPSHOT,
    from: '    copied.integritySnapshot = isFullCopy ? this.integritySnapshot : null',
    to: '    copied.integritySnapshot = this.integritySnapshot',
    expect: [
      'R3 — copy, subgraph and compatibility loads stay truthful a subgraph gets no snapshot, because it describes fewer facts',
    ],
  },
  {
    name: 'R1: stop rejecting scheme forms in verification targets',
    file: CONTRACTS,
    test: TARGET_POLICY,
    from: '    if (SCHEME_PREFIX.test(separatorsNormalized)) return null',
    to: '',
    expect: [
      'R1 — unsafe verification targets never reach a record refuses file: without slashes through the production path',
      'R1 — unsafe verification targets never reach a record refuses mailto: through the production path',
    ],
  },
  {
    name: 'R1: use startsWith(..) instead of a segment test',
    file: CONTRACTS,
    test: TARGET_POLICY,
    from: '  return segments.includes(\'..\')',
    to: '  return segments.join(\'/\').startsWith(\'..\')',
    expect: [
      'R1 — unsafe verification targets never reach a record refuses interior traversal through the production path',
      'R1 — legitimate paths survive keeps a directory whose NAME begins with two dots',
    ],
  },
  {
    name: 'R1: stop bounding verification-target length',
    file: CONTRACTS,
    test: TARGET_POLICY,
    from: 'export const MAX_VERIFICATION_TARGET_LENGTH = 512 as const',
    to: 'export const MAX_VERIFICATION_TARGET_LENGTH = 1_000_000 as const',
    expect: [
      'R1 — unsafe verification targets never reach a record refuses a target longer than the bound',
    ],
  },
  {
    name: 'R1: accept control characters in verification targets',
    file: CONTRACTS,
    test: TARGET_POLICY,
    from: '  if (/[\\u0000-\\u001f\\u007f-\\u009f]/.test(normalized)) return null\n  if (/%[0-9A-Fa-f]{2}/.test(normalized)) return null',
    to: '  if (/%[0-9A-Fa-f]{2}/.test(normalized)) return null',
    expect: [
      'R1 — unsafe verification targets never reach a record refuses null byte through the production path',
      'R1 — unsafe verification targets never reach a record refuses newline through the production path',
    ],
  },
  {
    name: 'B4: count scope failures after sanitization',
    file: SESSION,
    test: SHARE_SAFETY,
    from: '    const submittedScopeFailures = this.scopeFailureSet.size',
    to: '    const submittedScopeFailures = [...this.scopeFailureSet].filter((s) => safeScopeName(s) !== null).length',
    expect: [
      'B4 — scope-failure totals count what was submitted counts unsanitizable submissions in the total',
      'B4 — scope-failure totals count what was submitted reports all-unsafe submissions as fully omitted',
    ],
  },
  {
    name: 'accounting: default buildFromJson to attached accounting',
    file: BUILD,
    test: ACCOUNTING,
    from: "  const session = options.accounting === 'normalized_extraction_boundary'",
    to: '  const session = options.accounting !== undefined || true',
    expect: [
      'normalized accounting is opt-in, so compatibility loads cannot claim it attaches no accounting when a v1 artifact is rehydrated',
      'normalized accounting is opt-in, so compatibility loads cannot claim it defaults an unannotated call to no accounting',
    ],
  },
  {
    name: 'accounting: never attach the finalized result',
    file: BUILD,
    test: ACCOUNTING,
    from: '  if (session !== null) graph.attachNormalizedAccounting(session.finalize())',
    to: '',
    expect: [
      'refuses to overwrite accounting',
    ],
  },
  {
    name: 'accounting: restore the silent missing-endpoint continue',
    file: BUILD,
    test: ACCOUNTING,
    from: '      session?.dispose(fingerprint, unresolvedEndpoint({',
    to: '      if (true) continue\n      session?.dispose(fingerprint, unresolvedEndpoint({',
    expect: [
      'retains a durable record per',
    ],
  },
  {
    name: 'equation: stop comparing the terminal totals',
    file: CONTRACTS,
    test: CONTRACT_TESTS,
    from: '  if (total !== emittedCandidates) {',
    to: '  if (false) {',
    expect: [
      'the candidate accounting equation is enforced, not reported throws when one candidate is unaccounted for',
      'the candidate accounting equation is enforced, not reported throws when a candidate is counted twice',
    ],
  },
  {
    name: 'equation: drop safe-integer validation',
    file: CONTRACTS,
    from: 'function assertCount(value: number, field: string): number {\n  if (!Number.isSafeInteger(value) || value < 0) {',
    test: CONTRACT_TESTS,
    to: 'function assertCount(value: number, field: string): number {\n  if (false) {',
    expect: [
      'the candidate accounting equation is enforced, not reported refuses negative, fractional and unsafe counters',
      'the endpoint matrix stays a partition over stored facts refuses negative and fractional cells',
    ],
  },
  {
    name: 'cap: retain the first K encountered instead of the smallest ids',
    file: SESSION,
    test: ACCOUNTING,
    from: '    if (largest === null || id >= largest) return',
    to: '    return',
    expect: [
      'record retention is bounded and independent of arrival order produces byte-identical output under reverse arrival order',
      'record retention is bounded and independent of arrival order produces byte-identical output under shuffle arrival order',
    ],
  },
  {
    name: 'cap: stop tracking distinct ids exactly',
    file: SESSION,
    test: ACCOUNTING,
    from: '    this.seenIds.add(id)',
    to: '',
    expect: [
      'keeps the distinct total exact',
    ],
  },
  {
    name: 'receipt: stop re-deriving status on load',
    file: 'src/contracts/graph-integrity-receipt.ts',
    test: RECEIPT_TESTS,
    from: '  if (derived.status !== receipt.status) {',
    to: '  if (false) {',
    expect: [
      'status is derived, never supplied re-derives the partial-discriminator warning on load',
      'validation re-derives status so the field cannot be forged rejects a status tampered to look better than its counters',
    ],
  },
  {
    name: 'graph: let a rebuilt graph launder accounting away',
    file: GRAPH,
    test: ACCOUNTING,
    from: '      this.normalizedAccounting = source.normalizedAccounting',
    to: '',
    expect: [
      'a copy helper that rebuilds a graph cannot launder degradation carries accounting and admission counters onto a rebuilt graph',
    ],
  },
  {
    name: 'R2: remove unresolved record retention',
    file: SESSION,
    test: TAMPER,
    from: '        unresolved: detailRetention(unresolvedRecords.length, this.unresolvedRetained.distinctTotal),',
    to: '',
    expect: [
      'a genuine snapshot still finalizes',
    ],
  },
  {
    name: 'R2: remove rejected record retention',
    file: SESSION,
    test: TAMPER,
    from: '        rejected: detailRetention(rejectedRecords.length, this.rejectedRetained.distinctTotal),',
    to: '',
    expect: [
      'a genuine snapshot still finalizes',
    ],
  },
  {
    name: 'R2: remove conflicting record retention',
    file: SESSION,
    test: TAMPER,
    from: '        conflicting: detailRetention(conflictRecords.length, this.conflictRetained.distinctTotal),',
    to: '',
    expect: [
      'a genuine snapshot still finalizes',
    ],
  },
  {
    name: 'R2: force omitted to zero',
    file: CONTRACTS,
    test: SNAPSHOT,
    from: '  return Object.freeze({ retained, total, omitted: total - retained, truncated: retained < total })',
    to: '  return Object.freeze({ retained, total, omitted: 0, truncated: retained < total })',
    expect: [
      'R2 — retention metadata is validated, never trusted carries the true total when records are capped',
    ],
  },
  {
    name: 'R2: force truncated to false',
    file: CONTRACTS,
    test: SNAPSHOT,
    from: '  return Object.freeze({ retained, total, omitted: total - retained, truncated: retained < total })',
    to: '  return Object.freeze({ retained, total, omitted: total - retained, truncated: false })',
    expect: [
      'R2 — retention metadata is validated, never trusted carries the true total when records are capped',
    ],
  },
  {
    name: 'R2: skip nested record retention validation',
    file: VALIDATION,
    test: SNAPSHOT,
    from: '  assertRecordRetention(record as unknown as DurableCandidateRecord, field)',
    to: '',
    expect: [
      'R2 — retention metadata is validated, never trusted refuses to finalize a snapshot carrying a record with tampered retention',
    ],
  },
  {
    name: 'R2-02: accept an unsafe snapshot record',
    file: VALIDATION,
    test: TAMPER,
    from: '  if (sanitize(raw) !== raw) {',
    to: '  if (false) {',
    expect: [
      'R1/R2-02 — an unsafe payload cannot be attached refuses a record carrying an absolute private path',
      'R1/R2-02 — an unsafe payload cannot be attached refuses an unsafe verification target even on an otherwise valid record',
    ],
  },
  {
    name: 'R3-04: stale snapshot after node mutation',
    file: GRAPH,
    test: INVALIDATION,
    from: '    if (!unchanged) this.invalidateIntegritySnapshot()',
    to: '    if (false) this.invalidateIntegritySnapshot()',
    expect: [
      'R3-04 — every successful mutation invalidates the snapshot node insertion',
      'R3-04 — every successful mutation invalidates the snapshot node attribute change',
    ],
  },
  {
    name: 'R3-04: stale snapshot after occurrence insertion',
    file: GRAPH,
    test: INVALIDATION,
    from: '    if (changed) this.invalidateIntegritySnapshot()',
    to: '    if (false) this.invalidateIntegritySnapshot()',
    expect: [
      'R3-04 — every successful mutation invalidates the snapshot occurrence insertion on a fact that already exists',
    ],
  },
  {
    name: 'R3-04: stale snapshot after hydration',
    file: GRAPH,
    test: INVALIDATION,
    from: '    factOccurrences.add(occurrence.id)\n    this.invalidateIntegritySnapshot()',
    to: '    factOccurrences.add(occurrence.id)',
    expect: [
      'R3-04 — every successful mutation invalidates the snapshot hydrated occurrence insertion on a fact that already exists',
    ],
  },
  {
    name: 'R3-04: stale snapshot after storage admission',
    file: GRAPH,
    test: INVALIDATION,
    from: '      this.invalidateIntegritySnapshot()\n      return Object.freeze({',
    to: '      return Object.freeze({',
    expect: [
      'R3-04 — every successful mutation invalidates the snapshot unregistered storage admission',
    ],
  },
  {
    name: 'R3-04: stale snapshot after degradation inheritance',
    file: GRAPH,
    test: INVALIDATION,
    from: '    this.invalidateIntegritySnapshot()\n  }\n\n  copy()',
    to: '  }\n\n  copy()',
    expect: [
      'R3-04 — every successful mutation invalidates the snapshot degradation inheritance',
    ],
  },
  {
    name: 'R3-05: leave endpoint-matrix rows mutable',
    file: GRAPH,
    test: IMMUTABILITY,
    from: '      Object.freeze(copy[source])',
    to: '',
    expect: [
      'R3-05 — the snapshot is immutable all the way down freezes the matrix handed out by the graph accessor too',
    ],
  },
  {
    name: 'R3-05: attach accounting before validation',
    file: GRAPH,
    test: IMMUTABILITY,
    from: '    const snapshot = finalizeNormalizedIntegritySnapshot({',
    to: '    this.normalizedAccounting = result\n    const snapshot = finalizeNormalizedIntegritySnapshot({',
    expect: [
      'R3-05 — attachment is all-or-nothing leaves both fields null when a first attachment is rejected',
      'R3-05 — attachment is all-or-nothing leaves both fields null when attachment is rejected for a broken candidate equation',
    ],
  },
  {
    name: 'R3-04: recompute the snapshot inside the read accessor',
    file: GRAPH,
    test: INVALIDATION,
    from: '  normalizedIntegritySnapshot(): FinalizedNormalizedIntegritySnapshot | null {\n    return this.integritySnapshot',
    to: '  normalizedIntegritySnapshot(): FinalizedNormalizedIntegritySnapshot | null {\n    void finalizeNormalizedIntegritySnapshot\n    return this.integritySnapshot',
    expect: [
      'R3-04 — invalidation is never silently skipped by a new mutator never recomputes the snapshot inside a read accessor',
    ],
  },
  {
    name: 'V1: skip terminalReasonCounts validation',
    file: VALIDATION,
    test: TOTAL_VALIDATION,
    from: '  assertTerminalReasonCounts(input.terminalReasonCounts)',
    to: '',
    expect: [
      'V1 — reason vocabularies are closed rejects an unknown terminal reason key',
    ],
  },
  {
    name: 'V1: accept an unknown reason-fact key',
    file: VALIDATION,
    test: TOTAL_VALIDATION,
    from: '      throw new GraphIntegrityInvariantError(`${field} has unknown endpoint reason ${JSON.stringify(reason)}`)',
    to: '',
    expect: [
      'V1 — reason vocabularies are closed rejects an unknown endpoint reason key',
    ],
  },
  {
    name: 'V1: skip canonical JSON validation',
    file: JSON_GUARDS,
    test: TOTAL_VALIDATION,
    from: '  if (depth > MAX_CANONICAL_DEPTH) {',
    to: '  if (depth >= 0) return\n  if (depth > MAX_CANONICAL_DEPTH) {',
    expect: [
      'non-JSON values cannot attach',
    ],
  },
  {
    name: 'V1: stop checking the record id format',
    file: VALIDATION,
    test: TOTAL_VALIDATION,
    from: '  assertContentAddress(record[\'id\'], ID_PREFIXES[kind], `${field}.id`)',
    to: '  assertString(record[\'id\'], `${field}.id`)',
    expect: [
      'V1 — identities must name what they claim to rejects a record id that is a truncated hash',
      'V1 — identities must name what they claim to rejects a record id that is a wrong prefix',
    ],
  },
  {
    name: 'V1: stop checking the candidate fingerprint format',
    file: VALIDATION,
    test: TOTAL_VALIDATION,
    from: '    assertContentAddress(record[\'candidateFingerprint\'], \'cf_\', `${field}.candidateFingerprint`)',
    to: '    assertString(record[\'candidateFingerprint\'], `${field}.candidateFingerprint`)',
    expect: [
      'V1 — identities must name what they claim to rejects a candidate fingerprint that has a wrong prefix',
      'V1 — identities must name what they claim to rejects a candidate fingerprint that has a truncated hash',
    ],
  },
  {
    name: 'V2: accept an extra DetailRetention field',
    file: CONTRACTS,
    test: RETENTION_SHAPE,
    from: '  assertExactObjectShape(retention, field, DETAIL_RETENTION_KEYS)',
    to: '  assertPlainJsonObject(retention, field)',
    expect: [
      'V2 — DetailRetention is an exact closed contract rejects a fifth field carrying a private path',
      'V2 — DetailRetention is an exact closed contract rejects any unknown field, harmless-looking or not',
    ],
  },
  {
    name: 'V3: ignore endpoint qualification in addNode sameness',
    file: GRAPH,
    test: QUALIFICATION,
    from: '      && canonical(this.nodeEndpointIdentityMap.get(id)) === canonical(qualification)',
    to: '',
    expect: [
      'V3 — a qualification change is a state change invalidates on stable to context_bound',
      'V3 — a qualification change is a state change invalidates on context_bound to unknown',
    ],
  },
  {
    name: 'V3: stop invalidating on node state change',
    file: GRAPH,
    test: QUALIFICATION,
    from: '    if (!unchanged) this.invalidateIntegritySnapshot()',
    to: '    if (false) this.invalidateIntegritySnapshot()',
    expect: [
      'a qualification change is a state change',
    ],
  },
  {
    name: 'M1: ignore an empty baseline ref',
    file: GUARDS,
    test: RECEIPT_GUARDS,
    from: '  if (typeof ref !== \'string\' || ref.trim().length === 0) {',
    to: '  if (false) {',
    expect: [
      'M1-05 — a baseline ref resolves to an exact commit or refuses refuses an empty ref rather than defaulting to HEAD',
    ],
  },
  {
    name: 'M1: resolve any baseline ref to HEAD',
    file: GUARDS,
    test: RECEIPT_GUARDS,
    from: '      cwd: repoRoot, encoding: \'utf8\',\n    }).trim()',
    to: '      cwd: repoRoot, encoding: \'utf8\',\n    }) && execFileSync(\'git\', [\'rev-parse\', \'HEAD\'], { cwd: repoRoot, encoding: \'utf8\' }).trim()',
    expect: [
      'M1-05 — a baseline ref resolves to an exact commit or refuses resolves a full sha',
      'M1-05 — a baseline ref resolves to an exact commit or refuses resolves a short sha to the full commit',
    ],
  },
  {
    name: 'M1: allow a dirty tree',
    file: GUARDS,
    test: RECEIPT_GUARDS,
    from: '  if (status.length > 0) {',
    to: '  if (false) {',
    expect: [
      'M1-05 — a dirty tree cannot be measured refuses an uncommitted change',
      'M1-05 — a dirty tree cannot be measured refuses an untracked file',
    ],
  },
  {
    name: 'M1: reuse a stale dist',
    file: GUARDS,
    test: RECEIPT_GUARDS,
    from: '  if (!existsSync(entry)) {',
    to: '  if (false) {',
    expect: [
      'M1-05 — an arm must carry its own build refuses a worktree with no dist rather than reusing another',
    ],
  },
  {
    name: 'M1: drop shared-input checksum equality',
    file: GUARDS,
    test: RECEIPT_GUARDS,
    from: '  return session.base.inputChecksum === session.head.inputChecksum',
    to: '  return true',
    expect: [
      'M1-05 — both arms must have received the same bytes rejects a session whose arms disagree',
      'M1-05 — both arms must have received the same bytes invalidates rather than silently dropping a mismatched session',
    ],
  },
  {
    name: 'M1: stop recording invalidated sessions',
    file: GUARDS,
    test: RECEIPT_GUARDS,
    from: '    else invalidated.push({ scope, order: session.order, reason: \'arms did not receive identical input\' })',
    to: '',
    expect: [
      'M1-05 — both arms must have received the same bytes invalidates rather than silently dropping a mismatched session',
      'M1-05 — both arms must have received the same bytes reports every mismatched session, not just the first',
    ],
  },
  {
    name: 'M1: allow both arms to be the same commit',
    file: GUARDS,
    test: RECEIPT_GUARDS,
    from: '  if (baselineSha === candidateSha) {',
    to: '  if (false) {',
    expect: [
      'M1-05 — the arms must be different commits refuses a baseline that resolved to the candidate head',
    ],
  },
  {
    name: 'E1: skip resource cleanup entirely',
    file: REGISTRY_SRC,
    test: RECEIPT_CLEANUP,
    from: '      for (const id of [...resources.keys()].reverse()) releaseOne(id)',
    to: '',
    expect: [
      'E1-04 — one registry cleans every resource removes a worktree registration and its directory on success',
      'E1-04 — one registry cleans every resource cleans an inner resource even when an outer one was registered first',
    ],
  },
  {
    name: 'E1: exit before cleanup completes on a signal',
    file: REGISTRY_SRC,
    test: RECEIPT_CLEANUP,
    from: '    registry.cleanupAll()\n    process.exitCode = code\n    exit(code)',
    to: '    exit(code)\n    registry.cleanupAll()\n    process.exitCode = code',
    expect: [
      'one signal coordinator, cleanup before exit',
    ],
  },
  {
    name: 'E1: stop cleaning after the first failure',
    file: REGISTRY_SRC,
    test: RECEIPT_CLEANUP,
    from: '      onWarning(`cleanup failed for ${entry.description}: ${error?.message ?? String(error)}`)\n      return false',
    to: '      throw error',
    expect: [
      'cleans remaining resources when one cleanup itself fails',
    ],
  },
  {
    name: 'V1-01: skip the prototype check',
    file: CONTRACTS,
    test: CLOSED_SCHEMAS,
    from: '  if (prototype !== Object.prototype && prototype !== null) {',
    to: '  if (false) {',
    expect: [
      'V1-01 — the unresolved record schema is closed rejects a custom prototype',
      'V1-01 — the unresolved record schema is closed rejects a record copied onto a custom prototype',
    ],
  },
  {
    name: 'V1-01: ignore symbol keys',
    file: CONTRACTS,
    test: CLOSED_SCHEMAS,
    from: '  if (Object.getOwnPropertySymbols(value).length > 0) {',
    to: '  if (false) {',
    expect: [
      'V1-01 — the unresolved record schema is closed rejects a symbol key',
      'V1-01 — the unresolved record schema is closed rejects a symbol-keyed record carrying a BigInt',
    ],
  },
  {
    name: 'V1-01: allow accessors',
    file: CONTRACTS,
    test: CLOSED_SCHEMAS,
    from: '    if (descriptor.get !== undefined || descriptor.set !== undefined) {',
    to: '    if (false) {',
    expect: [
      'V1-01 — the unresolved record schema is closed rejects a getter',
      'V1-01 — the unresolved record schema is closed rejects a setter',
    ],
  },
  {
    name: 'V1-01: allow an unknown key',
    file: CONTRACTS,
    test: CLOSED_SCHEMAS,
    from: '    if (!allowed.has(key)) {',
    to: '    if (false) {',
    expect: [
      'V1-01 — the unresolved record schema is closed rejects an unknown field',
      'V1-01 — the verification-target schema is closed rejects an unknown field',
    ],
  },
  {
    name: 'V1-01: allow a missing required key',
    file: CONTRACTS,
    test: CLOSED_SCHEMAS,
    from: '    if (!Object.prototype.hasOwnProperty.call(value, key)) {',
    to: '    if (false) {',
    expect: [
      'a missing required key is named',
    ],
  },
  {
    name: 'V1-02: permit a present undefined',
    file: CONTRACTS,
    test: JSON_SAFETY,
    from: '    if ((value as Record<string, unknown>)[key] === undefined) {',
    to: '    if (false) {',
    expect: [
      'a present undefined is not the same as an absent property',
    ],
  },
  {
    name: 'V1-03: stop rederiving the rejected record id',
    file: VALIDATION,
    test: RECORD_IDENTITY,
    from: '    if (rederived !== record[\'id\']) {',
    to: '    if (false) {',
    expect: [
      'V1-03 — a rejected record id is rederived from its own payload rejects a well-formed id belonging to a different record',
      'V1-03 — a rejected record id is rederived from its own payload rejects a payload edited without its id',
    ],
  },
  {
    name: 'V1-03: stop rederiving the conflict record id',
    file: VALIDATION,
    test: RECORD_IDENTITY,
    from: '    if (rederivedId !== record[\'id\']) {',
    to: '    if (false) {',
    expect: [
      'V1-03 — a conflict record id is rederived from its own payload rejects a well-formed id belonging to a different conflict group',
    ],
  },
  {
    name: 'V1-03: stop rederiving the complete-set digest',
    file: VALIDATION,
    test: RECORD_IDENTITY,
    from: '      if (rederivedDigest !== record[\'fingerprintSetDigest\']) {',
    to: '      if (false) {',
    expect: [
      'rejects a wrong digest even when the id was recomputed',
    ],
  },
  {
    name: 'V1-03: rederive the digest from a truncated subset',
    file: VALIDATION,
    test: RECORD_IDENTITY,
    from: '    if (!retention.truncated) {',
    to: '    if (true) {',
    expect: [
      'does not rederive the digest from a truncated subset',
    ],
  },
  {
    name: 'M1: share one report path across invocations',
    scopeAfter: EXECUTABLE_SECTION,
    file: MUTATIONS_SELF,
    test: HARNESS_SELF,
    from: "  const reportPath = resolve(artifactDir, 'vitest-report.json')",
    to: "  const reportPath = resolve(ROOT, 'node_modules/.cache/madar-mutation-report.json')",
    expect: [
      'gives every invocation its own report path',
    ],
  },
  {
    name: 'M1: parse the report before writing raw output',
    scopeAfter: EXECUTABLE_SECTION,
    file: MUTATIONS_SELF,
    test: HARNESS_SELF,
    from: "  writeFileSync(resolve(artifactDir, 'stdout.txt'), stdout)",
    to: "  void 0",
    expect: [
      'writes raw output before attempting to parse',
    ],
  },
  {
    name: 'M1: continue after a restoration failure',
    file: MUTATIONS_SELF,
    test: HARNESS_SELF,
    from: '    console.error(`\\nRESTORATION FAILED after ${mutant.name}: ${stillMutated.join(\', \')}`)',
    to: '    void 0',
    expect: [
      'stops the matrix immediately when restoration fails',
    ],
  },
  {
    name: 'E1: stop treating a missing report as infrastructure failure',
    file: SCORING_SRC,
    test: HARNESS_SELF,
    from: "    ? { report: null, source: 'no JSON report produced' }",
    to: "    ? { report: { testResults: [] }, source: 'no JSON report produced' }",
    expect: [
      'classifies a wholly missing report as infrastructure failure',
    ],
  },
  {
    name: 'E1-05R: untype the spawn-race shutdown rejection',
    file: CHILD_RUNNER,
    test: SIGNAL_E2E,
    // The target suite is gated: without this the baseline would be "green"
    // only because its tests never ran, and the mutant would score UNCAUGHT.
    env: { MADAR_RECEIPT_SIGNAL_E2E: '1' },
    from: '          reject(new ResourceRegistryShuttingDownError(`child \"${description}\" (shutdown began during spawn)`))',
    to: '          reject(new Error(`refusing to admit child \"${description}\": shutdown began during spawn`))',
    expect: [
      'terminates and reaps a child when shutdown wins the spawn race',
    ],
  },
  {
    name: 'M1-05D-A: read the mutated digest after restoration',
    scopeAfter: EXECUTABLE_SECTION,
    file: MUTATIONS_SELF,
    test: EVIDENCE_LIFECYCLE,
    from: '    // Captured before restore(), not re-read after it.\n    mutated_digests: { [mutant.file]: mutatedDigest },',
    to: '    mutated_digests: { [mutant.file]: digest(mutant.file) },',
    expect: [
      'records a mutated digest that differs from the pre-mutation digest',
    ],
  },
  {
    name: 'M1-05D-A: fabricate a mutation lifecycle for a baseline',
    scopeAfter: EXECUTABLE_SECTION,
    file: MUTATIONS_SELF,
    test: EVIDENCE_LIFECYCLE,
    from: "    mutation_lifecycle: 'not_applicable',",
    to: "    mutation_lifecycle: 'applied',",
    expect: [
      'gives a baseline an explicit not-applicable lifecycle rather than fabricated digests',
    ],
  },
  {
    name: 'M1-05D-A: drop the process outcome from scoring',
    scopeAfter: EXECUTABLE_SECTION,
    file: MUTATIONS_SELF,
    test: EVIDENCE_LIFECYCLE,
    from: '      process_outcome: result.outcome ?? null,',
    to: '      process_outcome: null,',
    expect: [
      'retains the child exit code for baseline and mutant alike',
      'retains the terminating signal when the child was killed rather than exiting',
      'writes scoring.json when the suite produced no report at all',
      'writes scoring.json when the suite timed out',
    ],
  },
  {
    name: 'M1-05D-A: abandon an invocation without scoring it',
    scopeAfter: EXECUTABLE_SECTION,
    file: MUTATIONS_SELF,
    test: EVIDENCE_LIFECYCLE,
    from: "    writeAtomic(resolve(artifactDir, 'scoring.json'), `${JSON.stringify({\n      invocation_id: invocationId,\n      mutant_id: mutant.name,\n      requested_suite: mutant.test,\n      reported_suites: [],",
    to: "    void (resolve(artifactDir, 'scoring.json'), `${JSON.stringify({\n      invocation_id: invocationId,\n      mutant_id: mutant.name,\n      requested_suite: mutant.test,\n      reported_suites: [],",
    expect: [
      'writes scoring.json for a failure that happens before any suite runs',
    ],
  },
  {
    name: 'M1-05D-A: exit on a restoration failure without scoring it',
    scopeAfter: EXECUTABLE_SECTION,
    file: MUTATIONS_SELF,
    test: EVIDENCE_LIFECYCLE,
    from: "    writeScoring('infrastructure_failure', 'restoration_failed', `left mutated: ${stillMutated.join(', ')}`)",
    to: '    void 0',
    expect: [
      'stops the matrix on a restoration failure and keeps the truthful digests',
    ],
  },
  {
    name: 'M1-05D-A: omit the invocation identity from the report sidecar',
    scopeAfter: EXECUTABLE_SECTION,
    file: MUTATIONS_SELF,
    test: EVIDENCE_LIFECYCLE,
    from: "  writeAtomic(resolve(artifactDir, 'report-identity.json'), `${JSON.stringify({\n    invocation_id: invocationId,",
    to: "  writeAtomic(resolve(artifactDir, 'report-identity.json'), `${JSON.stringify({\n    invocation_id: null,",
    expect: [
      'stamps one invocation identity into every artifact that can carry one',
    ],
  },
  {
    name: 'M1-05D-B: accept a report this invocation did not produce',
    file: EVIDENCE_AUDIT_SRC,
    test: EVIDENCE_AUDIT,
    from: '      if (reportIdentity.report_digest !== digest) {',
    to: '      if (false) {',
    expect: [
      '01 rejects a stale or unrelated Vitest report',
    ],
  },
  {
    name: 'M1-05D-B: accept a report naming an unrequested suite',
    file: EVIDENCE_AUDIT_SRC,
    test: EVIDENCE_AUDIT,
    from: '      if (attribution.unexpected.length > 0) {',
    to: '      if (false) {',
    expect: [
      '02 rejects a report naming a suite that was not requested',
    ],
  },
  {
    name: 'M1-05D-B: trust the stored suite identity',
    file: EVIDENCE_AUDIT_SRC,
    test: EVIDENCE_AUDIT,
    from: '      if (suiteIdentity.exactlyOne !== attribution.exactlyOne) {',
    to: '      if (false) {',
    expect: [
      '04 rejects a stored exactlyOne that the report does not support',
    ],
  },
  {
    name: 'M1-05D-B: trust the requested suite each artifact claims',
    file: EVIDENCE_AUDIT_SRC,
    test: EVIDENCE_AUDIT,
    from: '      if (claim !== undefined && claim !== requestedSuite) {',
    to: '      if (false) {',
    expect: [
      '03 rejects a suite identity that declares the wrong suite',
    ],
  },
  {
    name: 'M1-05D-B: stop recomputing the scoring classification',
    file: EVIDENCE_AUDIT_SRC,
    test: EVIDENCE_AUDIT,
    from: '    if (scoring.classification !== recomputed) {',
    to: '    if (false) {',
    expect: [
      '16 rejects "caught" when the expected named test did not fail',
      '17 rejects "baseline_passed" when the report is red',
    ],
  },
  {
    name: 'M1-05D-B: accept a mutated digest equal to the pre digest',
    file: EVIDENCE_AUDIT_SRC,
    test: EVIDENCE_AUDIT,
    from: '        } else if (pre === mutated) {',
    to: '        } else if (false) {',
    expect: [
      '14 rejects a mutated digest equal to the pre-mutation digest',
    ],
  },
  {
    name: 'M1-05D-B: accept a post digest that differs from pre',
    file: EVIDENCE_AUDIT_SRC,
    test: EVIDENCE_AUDIT,
    from: '        } else if (post !== pre) {',
    to: '        } else if (false) {',
    expect: [
      '15 rejects a post-restoration digest that differs from the pre-mutation digest',
    ],
  },
  {
    name: 'M1-05D-B: ignore artifacts written outside the invocation',
    file: EVIDENCE_AUDIT_SRC,
    test: EVIDENCE_AUDIT,
    from: '      if (tooOld || tooNew) {',
    to: '      if (false) {',
    expect: [
      '05 rejects a same-basename report carried in from elsewhere',
    ],
  },
  {
    name: 'M1-05D-B: stop cross-checking the process outcome',
    file: EVIDENCE_AUDIT_SRC,
    test: EVIDENCE_AUDIT,
    from: '    if (JSON.stringify(meta.outcome ?? null) !== JSON.stringify(outcome)) {',
    to: '    if (false) {',
    expect: [
      '13 rejects a scoring record that misstates the process outcome',
    ],
  },
  {
    name: 'M1-05D-B: allow two invocations to share one identity',
    file: EVIDENCE_AUDIT_SRC,
    test: EVIDENCE_AUDIT,
    from: '      if (seenIds.has(id)) add(\'duplicate_invocation_id\', name, `invocation_id also used by ${seenIds.get(id)}`)',
    to: '      void seenIds.has(id)',
    expect: [
      '20 rejects two invocations sharing one identity',
    ],
  },
  {
    name: 'M1-05D-B: ignore an unaccounted artifact',
    file: EVIDENCE_AUDIT_SRC,
    test: EVIDENCE_AUDIT,
    from: '      if (!REQUIRED_ARTIFACTS.includes(file) && !OPTIONAL_ARTIFACTS.includes(file)) {',
    to: '      if (false) {',
    expect: [
      '19 rejects an artifact directory carrying an unaccounted file',
    ],
  },
  {
    name: 'M1-05D-B: ignore a capture stamped before the invocation',
    file: EVIDENCE_AUDIT_SRC,
    test: EVIDENCE_AUDIT,
    from: '    if (startedMs !== null && capturedMs !== null && capturedMs + CLOCK_TOLERANCE_MS < startedMs) {',
    to: '    if (false) {',
    expect: [
      '18 rejects a report captured outside its own invocation window',
    ],
  },
  {
    name: 'M1-05D-A: strand the scratch project when the harness fails',
    file: EVIDENCE_HELPER,
    test: EVIDENCE_LIFECYCLE,
    from: '    discardMatrix(project)\n    throw error',
    to: '    void project\n    throw error',
    expect: [
      'removes its scratch project when the harness under test fails',
    ],
  },
  {
    name: 'M1-05D-A: adopt a mutation inherited from a killed run',
    scopeAfter: EXECUTABLE_SECTION,
    file: MUTATIONS_SELF,
    test: EVIDENCE_LIFECYCLE,
    from: "if (inherited.length > 0 && process.env['MADAR_MUTATION_ALLOW_DIRTY'] !== '1') {",
    to: 'if (false) {',
    expect: [
      'refuses to start when a mutation target no longer matches its commit',
    ],
  },
  {
    name: 'M1-05D-A: treat an uncommitted scratch project as mutated',
    scopeAfter: EXECUTABLE_SECTION,
    file: MUTATIONS_SELF,
    test: EVIDENCE_LIFECYCLE,
    from: '    if (committed.status !== 0) continue',
    to: "    if (committed.status !== 0) { dirty.push(file); continue }",
    expect: [
      'does not police a target that has no committed form',
    ],
  },
]

// ===== executable section; nothing below is mutant data =====

// Audit-only mode: verifies an existing artifact directory without running
// anything, so the audit can be proven to fail on a broken artifact rather than
// asserted about by reading source.
const AUDIT_ARG = process.argv.indexOf('--audit')
if (AUDIT_ARG >= 0) {
  const auditDir = resolve(ROOT, process.argv[AUDIT_ARG + 1])
  const expectMutants = Number(process.argv[process.argv.indexOf('--expect-mutants') + 1] ?? 0)
  const expectBaselines = Number(process.argv[process.argv.indexOf('--expect-baselines') + 1] ?? 0)
  const { problems, dirs, mutants, baselines: baseCount, semanticDigest } =
    auditInvocationArtifacts(expectMutants, expectBaselines, auditDir, null)
  if (problems.length > 0) {
    console.error(`ARTIFACT AUDIT FAILED (${problems.length} problem(s)):`)
    for (const problem of problems) console.error(`  ${problem}`)
    process.exit(1)
  }
  console.log(`artifact audit OK: ${dirs} invocations (${mutants} mutants, ${baseCount} baselines)`)
  console.log(`semantic audit digest  ${semanticDigest}`)
  process.exit(0)
}

/**
 * Audits the artifact directory before any tally is printed.
 *
 * A gate that passes while its own evidence is missing or corrupt proves
 * nothing. Every invocation must have every artifact, every artifact must name
 * the same invocation, and no stale directory from an earlier run may be
 * counted.
 */
function auditInvocationArtifacts(expectedMutants, expectedBaselines, rootOverride = null, runIdOverride) {
  // Both overrides short-circuit deliberately: audit-only mode runs before the
  // run-scoped constants are initialised, and evaluating them would throw in
  // the temporal dead zone rather than audit anything.
  const auditRoot = rootOverride ?? ARTIFACT_ROOT
  const runId = runIdOverride === undefined ? RUN_ID : runIdOverride
  const required = [
    'meta.json', 'command.json', 'suite-identity.json', 'report-identity.json',
    'scoring.json', 'restoration.json', 'stdout.txt', 'stderr.txt', 'display.log',
  ]
  const problems = []
  const dirs = existsSync(auditRoot)
    ? readdirSync(auditRoot).filter((name) => statSync(resolve(auditRoot, name)).isDirectory())
    : []

  let mutants = 0
  let baselines = 0
  for (const name of dirs) {
    const dir = resolve(auditRoot, name)
    for (const file of required) {
      if (!existsSync(resolve(dir, file))) problems.push(`${name}: missing ${file}`)
    }
    let scoring = null
    let restoration = null
    try {
      scoring = JSON.parse(readFileSync(resolve(dir, 'scoring.json'), 'utf8'))
    } catch (error) {
      problems.push(`${name}: scoring.json unreadable (${error.message})`)
    }
    try {
      restoration = JSON.parse(readFileSync(resolve(dir, 'restoration.json'), 'utf8'))
    } catch (error) {
      problems.push(`${name}: restoration.json unreadable (${error.message})`)
    }
    if (scoring !== null && restoration !== null) {
      if (scoring.invocation_id !== restoration.invocation_id) {
        problems.push(`${name}: scoring and restoration name different invocations`)
      }
      // Every directory belongs to THIS run; a stale one would otherwise pad
      // the count.
      if (runId !== null && !String(scoring.invocation_id ?? '').startsWith(runId)) {
        problems.push(`${name}: invocation_id does not belong to this run`)
      }
      if (scoring.mutant_id !== undefined) mutants += 1
      else if (scoring.baseline_identity !== undefined) baselines += 1
      else problems.push(`${name}: scoring.json identifies neither a mutant nor a baseline`)

      // The lifecycle is three readings of one file at three different states.
      // Checking it here is the whole point: a record where pre, mutated and
      // post are equal is a record of nothing happening, and that is precisely
      // what a post-restoration re-read silently produced.
      if (restoration.mutation_lifecycle === 'applied') {
        for (const path of restoration.source_paths ?? []) {
          const pre = restoration.pre_mutation_digests?.[path]
          const mutated = restoration.mutated_digests?.[path]
          const post = restoration.post_restoration_digests?.[path]
          if (pre === undefined || mutated === undefined || post === undefined) {
            problems.push(`${name}: mutation lifecycle incomplete for ${path}`)
          } else if (pre === mutated) {
            problems.push(`${name}: pre and mutated digests are equal for ${path} (no mutation was recorded)`)
          } else if (post !== pre) {
            problems.push(`${name}: post-restoration digest does not match pre-mutation digest for ${path}`)
          }
        }
      } else if (!['not_applicable', 'not_applied'].includes(restoration.mutation_lifecycle)) {
        problems.push(`${name}: restoration.json declares no mutation lifecycle`)
      }
    }
  }

  if (mutants !== expectedMutants) problems.push(`scored ${mutants} mutants, expected ${expectedMutants}`)
  if (baselines !== expectedBaselines) problems.push(`scored ${baselines} baselines, expected ${expectedBaselines}`)

  // Structural completeness is necessary and nowhere near sufficient. A
  // reviewer pointed one invocation's report at an unrelated suite, flipped its
  // stored `exactlyOne` to false, and this audit still said OK -- because it
  // only ever asked whether the files were there. The semantic pass re-derives
  // what the files MEAN and is unioned in here so no caller can get the weak
  // answer by accident.
  const semantic = auditEvidence({ root: auditRoot, sourceRoot: ROOT, runId })
  for (const problem of semantic.problems) {
    problems.push(`${problem.invocation ?? '(matrix)'}: [${problem.code}] ${problem.detail}`)
  }
  return { problems, dirs: dirs.length, mutants, baselines, semanticDigest: semantic.semanticDigest }
}



const DISCOVER = process.argv.includes('--discover')
const filterArg = process.argv.indexOf('--filter')
const filter = filterArg >= 0 ? process.argv[filterArg + 1] : null

/**
 * Test seam: an external mutant table.
 *
 * The evidence this harness writes is only trustworthy if its failure paths can
 * be DRIVEN rather than described. Asserting about them by reading this file's
 * source is precisely the kind of check that passes while checking nothing, so
 * the controls run the real harness against a small table of their own.
 */
const tableArg = process.argv.indexOf('--mutants')
const table = tableArg >= 0
  ? JSON.parse(readFileSync(resolve(ROOT, process.argv[tableArg + 1]), 'utf8'))
  : MUTANTS
const selected = filter === null ? table : table.filter((m) => m.name.includes(filter))

/** Test seam: the runner binary and its fixed argv prefix. */
const VITEST_ARGV = process.env['MADAR_MUTATION_VITEST_ARGV'] !== undefined
  ? JSON.parse(process.env['MADAR_MUTATION_VITEST_ARGV'])
  : ['npx', 'vitest']
const SUITE_TIMEOUT_MS = Number(process.env['MADAR_MUTATION_SUITE_TIMEOUT_MS'] ?? 300_000)

const digest = (path) => createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex')

let caught = 0
let uncaught = 0
let skipped = 0
const originals = new Map()

/**
 * Puts every mutated file back and PROVES it went back.
 *
 * A run killed while blocked in a synchronous child can leave a mutation on
 * disk: the signal handler is queued behind the blocking call, and if the whole
 * process group dies it never runs at all. That happened, and the surviving
 * mutation was invisible to a `git status` check because the file was untracked
 * -- it showed as a new file, which is exactly what it was supposed to be.
 *
 * So restoration is verified by digest rather than assumed, and a file that
 * cannot be restored is reported loudly instead of left for a later run to
 * discover as a mysteriously red baseline.
 */
function restore() {
  const unrestored = []
  for (const [path, text] of originals) {
    const absolute = resolve(ROOT, path)
    try {
      writeFileSync(absolute, text)
      if (readFileSync(absolute, 'utf8') !== text) unrestored.push(path)
    } catch (error) {
      unrestored.push(`${path} (${error?.message ?? String(error)})`)
    }
  }
  if (unrestored.length > 0) {
    console.error(`\nFAILED TO RESTORE: ${unrestored.join(', ')}`)
    console.error('These files may still carry a mutation. Restore them before trusting any result.')
  }
  return unrestored
}

/** Every tracked and untracked source file this harness may have touched. */
function assertNoResidualMutation() {
  const residual = []
  for (const [path, text] of originals) {
    if (readFileSync(resolve(ROOT, path), 'utf8') !== text) residual.push(path)
  }
  return residual
}
process.on('exit', restore)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { restore(); process.exit(130) })
}

function report(kind, name, detail) {
  const label = kind.padEnd(8)
  console.log(`  ${label} ${name.padEnd(58)} ${detail}`)
  if (kind === 'caught') caught += 1
  else if (kind === 'UNCAUGHT') uncaught += 1
  else skipped += 1
}

/**
 * Every invocation gets its own artifact directory.
 *
 * A single shared report path was the defect: `--outputFile` pointed at one
 * file for all 73 mutants, the file was deleted after each read, and vitest
 * flushes its JSON reporter to disk as the process exits. Under load that flush
 * could lose the race, producing "no JSON report produced" for whichever mutant
 * happened to be running -- an infrastructure failure indistinguishable from a
 * real one, and unreproducible when the same mutant was run alone.
 *
 * Unique directories remove the sharing and the staleness. Raw stdout, stderr
 * and process metadata are written BEFORE any parsing is attempted, so a mutant
 * whose report never materialises still leaves its identity, its command and
 * its exit status on disk.
 */
const RUN_ID = `${Date.now().toString(36)}-${process.pid.toString(36)}`
const ARTIFACT_ROOT = resolve(ROOT, 'node_modules/.cache/madar-mutations', RUN_ID)

/**
 * Atomic write: temp file plus rename.
 *
 * A killed process must not leave a syntactically valid but partial artifact --
 * that is worse than no artifact, because an audit would accept it.
 */
function writeAtomic(path, contents) {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, contents)
  renameSync(temporary, path)
}

const slug = (value) => value.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

/**
 * Allocates the identity and the directory for one invocation, together.
 *
 * A single monotonic sequence across baselines and mutants: two invocations in
 * one run cannot share an ordinal, and RUN_ID separates runs, so an
 * `invocation_id` names exactly one invocation of exactly one run. Previously
 * baselines and mutants counted independently and the directory name was the
 * only thing keeping `001-` from meaning two different invocations.
 */
let invocationSequence = 0
function allocateInvocation(kind, name) {
  const ordinal = String(invocationSequence += 1).padStart(3, '0')
  const dir = resolve(ARTIFACT_ROOT, `${ordinal}-${slug(name)}`)
  if (existsSync(dir)) throw new Error(`invocation directory collision: ${dir}`)
  mkdirSync(dir, { recursive: true })
  return { id: `${RUN_ID}-${kind}${ordinal}`, ordinal, dir }
}


function runSuite(testFile, artifactDir, context = {}, extraEnv = {}) {
  const reportPath = resolve(artifactDir, 'vitest-report.json')
  const command = [...VITEST_ARGV, 'run', testFile, '--reporter=json', `--outputFile=${reportPath}`]
  const invocationId = context.invocation_id
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  let stdout = ''
  let stderr = ''
  let status = null
  let signal = null
  let timedOut = false
  let spawnError = null

  try {
    stdout = execFileSync(command[0], command.slice(1), {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: SUITE_TIMEOUT_MS,
      env: { ...process.env, ...extraEnv },
    })
    status = 0
  } catch (error) {
    stdout = error.stdout ?? ''
    stderr = error.stderr ?? ''
    // execFileSync reports a timeout as a signal kill; both are recorded rather
    // than collapsed, and a status of null now means "no child ran" instead of
    // "we did not look".
    status = error.status ?? null
    signal = error.signal ?? null
    timedOut = error.code === 'ETIMEDOUT'
    if (error.code === 'ENOENT' || error.code === 'EACCES') spawnError = `${error.code}: ${error.message}`
  }
  const finishedAt = new Date().toISOString()
  const outcome = {
    exit_code: status,
    termination_signal: signal,
    timed_out: timedOut,
    spawn_error: spawnError,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Date.now() - startedMs,
    child_started: spawnError === null,
  }

  // Durable BEFORE parsing: whatever happens next, the evidence exists.
  writeFileSync(resolve(artifactDir, 'stdout.txt'), stdout)
  writeFileSync(resolve(artifactDir, 'stderr.txt'), stderr)
  writeFileSync(resolve(artifactDir, 'display.log'), `${stdout}\n--- STDERR ---\n${stderr}`.replaceAll('\r', '\n'))
  writeAtomic(resolve(artifactDir, 'meta.json'), `${JSON.stringify({
    invocation_id: invocationId,
    ...context,
    testFile,
    reportPath: relative(ROOT, reportPath),
    outcome,
  }, null, 2)}\n`)
  // Command recorded separately so the audit can cross-check argv against what
  // every other artifact claims was run.
  writeAtomic(resolve(artifactDir, 'command.json'), `${JSON.stringify({
    invocation_id: invocationId,
    requested_suite: testFile,
    argv: command,
    env_overrides: Object.keys(extraEnv),
  }, null, 2)}\n`)

  // No early return here. The worker-signature refusal lives below, AFTER
  // report-source.txt and suite-identity.json are on disk: returning first left
  // an invocation with two of its nine artifacts missing, and "missing" is
  // exactly what an audit cannot distinguish from "never written".
  const fileExists = existsSync(reportPath)
  const availability = classifyReportAvailability({
    fileExists,
    fileText: fileExists ? readFileSync(reportPath, 'utf8') : undefined,
    stdout,
  })
  writeFileSync(resolve(artifactDir, 'report-source.txt'), `${availability.source}\n`)
  // The native Vitest report cannot carry an invocation identity, so it gets a
  // sidecar that can. Digest and bounds together are what let an audit reject a
  // report copied in from another invocation whose basename happens to match.
  const reportBytes = fileExists ? readFileSync(reportPath) : null
  writeAtomic(resolve(artifactDir, 'report-identity.json'), `${JSON.stringify({
    invocation_id: invocationId,
    requested_suite: testFile,
    report_path: relative(ROOT, reportPath),
    report_present: fileExists,
    report_status: availability.source,
    report_bytes: reportBytes === null ? 0 : reportBytes.byteLength,
    report_digest: reportBytes === null ? null : createHash('sha256').update(reportBytes).digest('hex'),
    invocation_started_at: startedAt,
    invocation_finished_at: finishedAt,
    captured_at: new Date().toISOString(),
  }, null, 2)}\n`)

  // Suite identity, proven rather than assumed. One suite was requested; the
  // report must name exactly that suite and no other. Without this a mutant
  // could be scored against a report describing a different file entirely.
  const combined = `${stdout}${stderr}`
  const signatures = ['Failed to start forks worker', 'Timeout waiting for worker to respond']
    .map((signature) => ({ signature, count: combined.split(signature).length - 1 }))
    .filter((hit) => hit.count > 0)

  const requestedModule = resolve(ROOT, testFile)
  const reportedModules = (availability.report?.testResults ?? []).map((entry) => resolve(ROOT, entry.name))
  const unexpectedModules = reportedModules.filter((id) => id !== requestedModule).map((id) => relative(ROOT, id))
  const identity = {
    requested: testFile,
    reported: reportedModules.map((id) => relative(ROOT, id)),
    unexpected: unexpectedModules,
    exactlyOne: reportedModules.length === 1 && unexpectedModules.length === 0,
    workerSignatures: signatures,
  }
  writeAtomic(resolve(artifactDir, 'suite-identity.json'), `${JSON.stringify({ invocation_id: invocationId, ...identity }, null, 2)}\n`)

  if (signatures.length > 0) {
    return { usable: false, why: `worker signature: ${signatures[0].signature}`, artifactDir, identity, outcome }
  }
  if (availability.report !== null && !identity.exactlyOne) {
    return {
      usable: false,
      why: `report names ${reportedModules.length} module(s), expected exactly ${testFile}`,
      artifactDir,
      identity,
      outcome,
    }
  }

  const result = readSuiteResult({ raw: combined, report: availability.report })
  return { ...result, artifactDir, reportSource: availability.source, identity, outcome }
}

/**
 * Refuses to start on a tree that already carries a mutation.
 *
 * Restoration is hooked to `exit`, SIGINT and SIGTERM, and a process-group kill
 * bypasses all three. That happened: a killed matrix left
 * `assertDistinctArms` reading `if (false)`. Nothing noticed, because
 * `assertNoResidualMutation` compares against originals captured DURING a run
 * and so knows nothing at startup -- the stale mutation would simply have been
 * adopted as the next run's pristine baseline.
 *
 * Only files this table targets are examined, so ordinary uncommitted work
 * elsewhere in the tree is none of this harness's business.
 */
function assertNoInheritedMutation() {
  // The controls run this harness inside throwaway projects that are not git
  // repositories at all. Treating "no committed copy" as "mutated" refused to
  // start there and broke every control -- so absence of a baseline is skipped,
  // and a tracked file that disagrees with HEAD is the only signal.
  const insideRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: ROOT, encoding: 'utf8',
  })
  if (insideRepo.status !== 0 || insideRepo.stdout.trim() !== 'true') return []

  const targets = [...new Set(selected.map((mutant) => mutant.file))]
  const dirty = []
  for (const file of targets) {
    if (!existsSync(resolve(ROOT, file))) continue
    const committed = spawnSync('git', ['show', `HEAD:${file}`], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    })
    // Untracked targets have no committed baseline to compare against; residue
    // in those is caught during the run by digest instead.
    if (committed.status !== 0) continue
    if (committed.stdout !== readFileSync(resolve(ROOT, file), 'utf8')) dirty.push(file)
  }
  return dirty
}

const inherited = assertNoInheritedMutation()
if (inherited.length > 0 && process.env['MADAR_MUTATION_ALLOW_DIRTY'] !== '1') {
  console.error('REFUSING TO START: mutation target(s) differ from HEAD:')
  for (const file of inherited) console.error(`  ${file}`)
  console.error('A killed run can leave a mutation on disk. Restore these before measuring,')
  console.error('or set MADAR_MUTATION_ALLOW_DIRTY=1 if the difference is deliberate.')
  process.exit(1)
}

console.log(`#658 integrity mutation controls (${selected.length} mutants)\n`)

// One green baseline per suite before any mutation. A suite that is already red
// cannot attribute anything, and every mutant pointed at it would score on a
// failure that was there first.
const baselines = new Map()
for (const testFile of new Set(selected.map((m) => m.test))) {
  const { id: baselineInvocationId, dir } = allocateInvocation('b', `baseline-${testFile}`)
  const baselineEnv = MUTANTS.find((mutant) => mutant.test === testFile && mutant.env !== undefined)?.env ?? {}
  const baselineResult = runSuite(testFile, dir, {
    invocation_id: baselineInvocationId, phase: 'baseline', testFile,
  }, baselineEnv)
  const verdict = baselineVerdict(baselineResult)
  baselines.set(testFile, verdict)
  writeAtomic(resolve(dir, 'scoring.json'), `${JSON.stringify({
    invocation_id: baselineInvocationId,
    baseline_identity: testFile,
    requested_suite: testFile,
    reported_suites: baselineResult.identity?.reported ?? [],
    expected_test_identities: [],
    observed_failed_test_identities: baselineResult.failed ?? [],
    baseline_green: verdict === null,
    worker_start_signatures: (baselineResult.identity?.workerSignatures ?? []),
    handshake_signatures: [],
    process_outcome: baselineResult.outcome ?? null,
    report_status: baselineResult.usable === true ? 'readable' : (baselineResult.why ?? 'unavailable'),
    classification: verdict === null ? 'baseline_passed' : 'infrastructure_failure',
    reason_code: verdict === null ? 'baseline_passed' : 'baseline_not_green',
    reason_detail: verdict ?? 'baseline green',
    scored_at: new Date().toISOString(),
  }, null, 2)}\n`)
  // Explicit rather than omitted: an absent file is indistinguishable from one
  // an audit failed to write.
  writeAtomic(resolve(dir, 'restoration.json'), `${JSON.stringify({
    invocation_id: baselineInvocationId,
    source_paths: [],
    // Present and empty, with a stated reason. An absent lifecycle is
    // indistinguishable from one an audit forgot to write, and "no digests"
    // must be a claim the audit can check rather than a gap it must excuse.
    mutation_lifecycle: 'not_applicable',
    pre_mutation_digests: {},
    mutated_digests: {},
    post_restoration_digests: {},
    restoration_attempted: false,
    restoration_succeeded: null,
    tree_clean_after: true,
    leftover_paths: [],
    reason_code: 'not_applicable_baseline',
    reason_detail: 'baseline invocations mutate nothing',
    verified_at: new Date().toISOString(),
  }, null, 2)}\n`)
}

const discovered = {}

for (const mutant of selected) {
  const filePath = resolve(ROOT, mutant.file)
  const testPath = resolve(ROOT, mutant.test)

  // Allocated up front so an invocation that never runs still has a directory,
  // an identity, and a durable scoring record explaining why.
  const { id: invocationId, dir: artifactDir } = allocateInvocation('m', mutant.name)

  /**
   * Records an invocation that could not be scored normally.
   *
   * Written BEFORE the continuation, not after: an early return that skipped
   * this is exactly how a skip's identity and reason were lost.
   */
  const abandon = (reasonCode, detail, lifecycle = null) => {
    // The same outcome object both artifacts carry, so a cross-artifact audit
    // sees agreement rather than one file's silence.
    const notStarted = { exit_code: null, termination_signal: null, timed_out: false, spawn_error: null, started_at: null, finished_at: null, duration_ms: 0, child_started: false }
    writeAtomic(resolve(artifactDir, 'meta.json'), `${JSON.stringify({
      invocation_id: invocationId,
      phase: 'mutant',
      mutant: mutant.name,
      file: mutant.file,
      expected: mutant.expect ?? [],
      testFile: mutant.test,
      abandoned: reasonCode,
      outcome: notStarted,
    }, null, 2)}\n`)
    writeAtomic(resolve(artifactDir, 'scoring.json'), `${JSON.stringify({
      invocation_id: invocationId,
      mutant_id: mutant.name,
      requested_suite: mutant.test,
      reported_suites: [],
      expected_test_identities: mutant.expect ?? [],
      observed_failed_test_identities: [],
      baseline_green: baselines.get(mutant.test) === null,
      worker_start_signatures: [],
      handshake_signatures: [],
      process_outcome: notStarted,
      report_status: 'not_produced',
      classification: 'infrastructure_failure',
      reason_code: reasonCode,
      reason_detail: detail,
      scored_at: new Date().toISOString(),
    }, null, 2)}\n`)
    writeAtomic(resolve(artifactDir, 'restoration.json'), `${JSON.stringify({
      invocation_id: invocationId,
      source_paths: [mutant.file],
      mutation_lifecycle: lifecycle === null ? 'not_applicable' : 'not_applied',
      ...(lifecycle ?? {
        pre_mutation_digests: {},
        mutated_digests: {},
        post_restoration_digests: {},
      }),
      restoration_attempted: lifecycle !== null,
      restoration_succeeded: lifecycle === null ? null : true,
      tree_clean_after: assertNoResidualMutation().length === 0,
      leftover_paths: assertNoResidualMutation(),
      reason_code: lifecycle === null ? 'not_mutated' : 'restored',
      verified_at: new Date().toISOString(),
    }, null, 2)}\n`)
    for (const file of [
      'command.json', 'suite-identity.json', 'report-identity.json',
      'report-source.txt', 'stdout.txt', 'stderr.txt', 'display.log',
    ]) {
      const path = resolve(artifactDir, file)
      if (!existsSync(path)) {
        writeAtomic(path, file.endsWith('.json')
          ? `${JSON.stringify({
            invocation_id: invocationId,
            requested_suite: mutant.test,
            abandoned: reasonCode,
            ...(file === 'report-identity.json'
              ? { report_present: false, report_status: 'not_produced', report_digest: null }
              : {}),
          }, null, 2)}\n`
          : file === 'report-source.txt'
            ? 'not_produced\n'
            : `invocation abandoned before execution: ${reasonCode}\n`)
      }
    }
    report('SKIPPED', mutant.name, detail)
  }

  if (!existsSync(filePath)) { abandon('missing_source', `missing source ${mutant.file}`); continue }
  if (!existsSync(testPath)) { abandon('missing_test', `missing test ${mutant.test}`); continue }
  const baseline = baselines.get(mutant.test)
  if (baseline !== null) { abandon('baseline_not_green', baseline); continue }
  if (!DISCOVER && (mutant.expect ?? []).length === 0) {
    abandon('no_expected_test', 'no expected test declared'); continue
  }

  if (!originals.has(mutant.file)) originals.set(mutant.file, readFileSync(filePath, 'utf8'))
  restore()

  // Read BEFORE the mutation is applied.
  const preMutationDigest = digest(mutant.file)
  const plan = planMutation({
    source: readFileSync(filePath, 'utf8'),
    from: mutant.from,
    to: mutant.to,
    scopeAfter: mutant.scopeAfter ?? null,
  })
  if (!plan.ok) { abandon('mutation_not_applied', plan.why); continue }
  writeFileSync(filePath, plan.mutated)

  // Read while the mutation is ON DISK. The previous version computed this
  // after restore(), so every record showed pre == mutated == post: three
  // readings of the same restored file, presented as a lifecycle.
  const mutatedDigest = digest(mutant.file)
  if (mutatedDigest === preMutationDigest) {
    abandon('mutation_changed_nothing', 'mutation changed nothing', {
      pre_mutation_digests: { [mutant.file]: preMutationDigest },
      mutated_digests: { [mutant.file]: mutatedDigest },
      post_restoration_digests: { [mutant.file]: digest(mutant.file) },
    })
    continue
  }

  let result
  try {
    result = runSuite(mutant.test, artifactDir, {
      invocation_id: invocationId,
      phase: 'mutant',
      mutant: mutant.name,
      file: mutant.file,
      expected: mutant.expect ?? [],
      pre_mutation_digest: preMutationDigest,
      mutated_digest: mutatedDigest,
    }, mutant.env ?? {})
  } finally {
    restore()
  }

  // Written for every invocation, including ones that could not be scored, and
  // written BEFORE any continuation. The conclusion previously existed only in
  // terminal output for the unusable and discovery paths -- the same place the
  // first unexplained skip was lost.
  const writeScoring = (classification, reasonCode, reasonDetail, score = null) => {
    writeAtomic(resolve(artifactDir, 'scoring.json'), `${JSON.stringify({
      invocation_id: invocationId,
      mutant_id: mutant.name,
      requested_suite: mutant.test,
      reported_suites: result.identity?.reported ?? [],
      expected_test_identities: mutant.expect ?? [],
      observed_failed_test_identities: result.failed ?? [],
      baseline_green: baselines.get(mutant.test) === null,
      worker_start_signatures: (result.identity?.workerSignatures ?? [])
        .filter((hit) => hit.signature.includes('start forks')),
      handshake_signatures: (result.identity?.workerSignatures ?? [])
        .filter((hit) => hit.signature.includes('respond')),
      process_outcome: result.outcome ?? null,
      report_status: result.usable === true ? 'readable' : (result.why ?? 'unavailable'),
      classification,
      reason_code: reasonCode,
      reason_detail: reasonDetail,
      ...(score === null ? {} : { score_kind: score.kind }),
      scored_at: new Date().toISOString(),
    }, null, 2)}\n`)
  }

  // Verified by re-reading bytes, not by trusting the write and not by `git
  // status` -- an untracked file shows as new whether or not it is mutated.
  const stillMutated = assertNoResidualMutation()
  writeAtomic(resolve(artifactDir, 'restoration.json'), `${JSON.stringify({
    invocation_id: invocationId,
    source_paths: [mutant.file],
    mutation_lifecycle: 'applied',
    pre_mutation_digests: { [mutant.file]: preMutationDigest },
    // Captured before restore(), not re-read after it.
    mutated_digests: { [mutant.file]: mutatedDigest },
    post_restoration_digests: Object.fromEntries(
      [...originals.keys()].map((path) => [path, digest(path)]),
    ),
    restoration_attempted: true,
    restoration_succeeded: stillMutated.length === 0,
    tree_clean_after: stillMutated.length === 0,
    leftover_paths: stillMutated,
    reason_code: stillMutated.length === 0 ? 'restored' : 'restoration_failed',
    verified_at: new Date().toISOString(),
  }, null, 2)}\n`)
  if (stillMutated.length > 0) {
    // §2.4 covers restoration failure too: the matrix stops here, and an
    // invocation without a scoring record is exactly the gap that let an
    // unexplained skip disappear.
    writeScoring('infrastructure_failure', 'restoration_failed', `left mutated: ${stillMutated.join(', ')}`)
    console.error(`\nRESTORATION FAILED after ${mutant.name}: ${stillMutated.join(', ')}`)
    console.error(`Evidence retained in ${relative(ROOT, artifactDir)}`)
    console.error('Stopping the matrix: no tally can be trusted from a mutated tree.')
    process.exit(1)
  }

  if (!result.usable) {
    // Identity and reason survive regardless of what the suite did, and the raw
    // output is on disk rather than only in a scrolled terminal.
    writeScoring('infrastructure_failure', 'suite_unusable', result.why ?? 'unusable')
    report('SKIPPED', mutant.name, `${result.why} [${relative(ROOT, result.artifactDir ?? artifactDir)}]`)
    continue
  }

  if (DISCOVER) {
    discovered[mutant.name] = result.failed
    const caught = result.failed.length > 0
    writeScoring(caught ? 'caught' : 'uncaught', 'discovery', `${result.failed.length} failed`)
    report(caught ? 'caught' : 'UNCAUGHT', mutant.name, `${result.failed.length} failed`)
    continue
  }

  const score = scoreMutant({ expect: mutant.expect ?? [], result })
  writeScoring(
    score.kind === 'caught' ? 'caught'
      : score.kind === 'UNCAUGHT' ? 'uncaught' : 'skipped',
    score.kind,
    score.detail,
    score,
  )

  report(score.kind, mutant.name, score.detail)
}

restore()

if (DISCOVER) {
  writeFileSync(resolve(ROOT, 'node_modules/.cache/madar-mutation-discovery.json'), JSON.stringify(discovered, null, 2))
  console.log('\ndiscovery written')
  process.exit(0)
}

// Checked before any number is printed: a tree that still carries a mutation
// cannot produce a trustworthy result, and reporting one anyway is how a
// corrupted file became a mysteriously red baseline in a later run.
const residual = assertNoResidualMutation()
if (residual.length > 0) {
  console.error(`\nRESIDUAL MUTATION IN: ${residual.join(', ')}`)
  console.error('Refusing to report a result from a tree that still carries a mutation.')
  process.exit(1)
}

const audit = auditInvocationArtifacts(selected.length, baselines.size)
if (audit.problems.length > 0) {
  console.error(`\nARTIFACT AUDIT FAILED (${audit.problems.length} problem(s)):`)
  for (const problem of audit.problems) console.error(`  ${problem}`)
  console.error('Refusing to report a result whose own evidence is incomplete.')
  process.exit(1)
}
console.log(`\nartifact audit      ${audit.dirs} invocations (${audit.mutants} mutants, ${audit.baselines} baselines) complete`)
console.log(`semantic digest     ${audit.semanticDigest}`)
console.log(`\ncaught=${caught} uncaught=${uncaught} skipped=${skipped}`)
const ok = caught > 0 && uncaught === 0 && skipped === 0
console.log(ok ? 'MUTATION CONTROLS PASS' : 'MUTATION CONTROLS FAIL')
process.exit(ok ? 0 : 1)
