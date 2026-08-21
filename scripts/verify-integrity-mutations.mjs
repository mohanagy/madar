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
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
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
const HARNESS_SELF = 'tests/unit/mutation-harness-self.test.ts'

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
]

// ===== executable section; nothing below is mutant data =====

const DISCOVER = process.argv.includes('--discover')
const filterArg = process.argv.indexOf('--filter')
const filter = filterArg >= 0 ? process.argv[filterArg + 1] : null
const selected = filter === null ? MUTANTS : MUTANTS.filter((m) => m.name.includes(filter))

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

const slug = (value) => value.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

function invocationDirectory(index, name) {
  const dir = resolve(ARTIFACT_ROOT, `${String(index).padStart(3, '0')}-${slug(name)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}


function runSuite(testFile, artifactDir, context = {}) {
  const reportPath = resolve(artifactDir, 'vitest-report.json')
  const command = ['npx', 'vitest', 'run', testFile, '--reporter=json', `--outputFile=${reportPath}`]
  const started = new Date().toISOString()
  let stdout = ''
  let stderr = ''
  let status = null
  let signal = null

  try {
    stdout = execFileSync(command[0], command.slice(1), {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000,
    })
    status = 0
  } catch (error) {
    stdout = error.stdout ?? ''
    stderr = error.stderr ?? ''
    status = error.status ?? null
    signal = error.signal ?? null
  }

  // Durable BEFORE parsing: whatever happens next, the evidence exists.
  writeFileSync(resolve(artifactDir, 'stdout.txt'), stdout)
  writeFileSync(resolve(artifactDir, 'stderr.txt'), stderr)
  writeFileSync(resolve(artifactDir, 'display.log'), `${stdout}\n--- STDERR ---\n${stderr}`.replaceAll('\r', '\n'))
  writeFileSync(resolve(artifactDir, 'meta.json'), `${JSON.stringify({
    ...context,
    testFile,
    command: command.join(' '),
    startedAt: started,
    endedAt: new Date().toISOString(),
    exitStatus: status,
    signal,
    reportPath,
  }, null, 2)}\n`)

  if (/Failed to start forks worker|Timeout waiting for worker to respond/.test(`${stdout}${stderr}`)) {
    return { usable: false, why: 'worker startup failure', artifactDir }
  }

  const fileExists = existsSync(reportPath)
  const availability = classifyReportAvailability({
    fileExists,
    fileText: fileExists ? readFileSync(reportPath, 'utf8') : undefined,
    stdout,
  })
  writeFileSync(resolve(artifactDir, 'report-source.txt'), `${availability.source}\n`)

  const result = readSuiteResult({ raw: `${stdout}${stderr}`, report: availability.report })
  return { ...result, artifactDir, reportSource: availability.source }
}

console.log(`#658 integrity mutation controls (${selected.length} mutants)\n`)

// One green baseline per suite before any mutation. A suite that is already red
// cannot attribute anything, and every mutant pointed at it would score on a
// failure that was there first.
const baselines = new Map()
let baselineIndex = 0
for (const testFile of new Set(selected.map((m) => m.test))) {
  const dir = invocationDirectory(baselineIndex += 1, `baseline-${testFile}`)
  baselines.set(testFile, baselineVerdict(runSuite(testFile, dir, { phase: 'baseline', testFile })))
}

const discovered = {}
let mutantIndex = 0

for (const mutant of selected) {
  const filePath = resolve(ROOT, mutant.file)
  const testPath = resolve(ROOT, mutant.test)

  if (!existsSync(filePath)) { report('SKIPPED', mutant.name, `missing source ${mutant.file}`); continue }
  if (!existsSync(testPath)) { report('SKIPPED', mutant.name, `missing test ${mutant.test}`); continue }
  const baseline = baselines.get(mutant.test)
  if (baseline !== null) { report('SKIPPED', mutant.name, baseline); continue }
  if (!DISCOVER && (mutant.expect ?? []).length === 0) {
    report('SKIPPED', mutant.name, 'no expected test declared'); continue
  }

  if (!originals.has(mutant.file)) originals.set(mutant.file, readFileSync(filePath, 'utf8'))
  restore()

  const artifactDir = invocationDirectory(mutantIndex += 1, mutant.name)
  const before = digest(mutant.file)
  const plan = planMutation({
    source: readFileSync(filePath, 'utf8'),
    from: mutant.from,
    to: mutant.to,
    scopeAfter: mutant.scopeAfter ?? null,
  })
  if (!plan.ok) { report('SKIPPED', mutant.name, plan.why); continue }
  writeFileSync(filePath, plan.mutated)
  // Belt and braces: the plan says it changed the text, the disk must agree.
  if (digest(mutant.file) === before) { report('SKIPPED', mutant.name, 'mutation changed nothing'); continue }

  let result
  try {
    result = runSuite(mutant.test, artifactDir, {
      phase: 'mutant',
      mutant: mutant.name,
      file: mutant.file,
      expected: mutant.expect ?? [],
      digestBefore: before,
      digestAfter: digest(mutant.file),
    })
  } finally {
    restore()
  }

  // Verified by re-reading bytes, not by trusting the write and not by `git
  // status` -- an untracked file shows as new whether or not it is mutated.
  const stillMutated = assertNoResidualMutation()
  if (stillMutated.length > 0) {
    console.error(`\nRESTORATION FAILED after ${mutant.name}: ${stillMutated.join(', ')}`)
    console.error(`Evidence retained in ${relative(ROOT, artifactDir)}`)
    console.error('Stopping the matrix: no tally can be trusted from a mutated tree.')
    process.exit(1)
  }

  if (!result.usable) {
    // Identity and reason survive regardless of what the suite did, and the raw
    // output is on disk rather than only in a scrolled terminal.
    report('SKIPPED', mutant.name, `${result.why} [${relative(ROOT, result.artifactDir ?? artifactDir)}]`)
    continue
  }

  if (DISCOVER) {
    discovered[mutant.name] = result.failed
    report(result.failed.length > 0 ? 'caught' : 'UNCAUGHT', mutant.name, `${result.failed.length} failed`)
    continue
  }

  const score = scoreMutant({ expect: mutant.expect ?? [], result })
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

console.log(`\ncaught=${caught} uncaught=${uncaught} skipped=${skipped}`)
const ok = caught > 0 && uncaught === 0 && skipped === 0
console.log(ok ? 'MUTATION CONTROLS PASS' : 'MUTATION CONTROLS FAIL')
process.exit(ok ? 0 : 1)
