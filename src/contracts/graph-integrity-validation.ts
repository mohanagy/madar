import {
  ENDPOINT_IDENTITY_REASONS,
  ENDPOINT_IDENTITY_STATUSES,
  type EndpointIdentityReason,
} from './endpoint-identity.js'
import {
  assertCandidateAccountingEquation,
  assertDetailRetention,
  assertClosedPlainDataObject,
  assertPlainJsonObject,
  conflictFingerprintSetDigest,
  conflictRecordIdentityPayload,
  contentAddressOf,
  rejectedRecordIdentityPayload,
  type ClosedObjectSchema,
  assertRecordRetention,
  DETAIL_RETENTION_KEYS,
  CANDIDATE_TERMINAL_STATES,
  GraphIntegrityInvariantError,
  isTerminalIntegrityReason,
  MAX_CONFLICT_FINGERPRINTS,
  MAX_RECORD_OCCURRENCES,
  MAX_VERIFICATION_TARGETS_PER_RECORD,
  normalizeVerificationTargetPath,
  safeEndpointIdentifier,
  type DurableCandidateRecord,
} from './graph-integrity.js'
import { safeCandidateString, safeScopeName } from './graph-integrity-session.js'
import { assertCanonicalJsonValue } from './graph-integrity-json.js'

/**
 * Total runtime validation for everything a serializer will be handed.
 *
 * The snapshot is trusted by Stage 3 the way a decoded artifact is trusted by a
 * loader: whatever reaches it is taken as true. So the boundary cannot assume
 * its input was produced by the session that normally produces it. A record may
 * have been hand-built, decoded from bytes, relabelled, or tampered with, and
 * every one of those arrives as an ordinary object with the right static type.
 *
 * Two rules make this validator worth having:
 *
 * 1. Every rejection is a `GraphIntegrityInvariantError`. A `TypeError` from a
 *    property read on `undefined` is indistinguishable from a bug in the
 *    validator itself, so it cannot be evidence that the data was bad.
 * 2. Share safety is decided by the same functions that decided it at
 *    construction. A second, snapshot-only notion of "safe" would drift from
 *    the first, and the drift would be invisible until something leaked.
 */


function assertArray(value: unknown, field: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new GraphIntegrityInvariantError(`${field} must be an array`)
  }
}

/** Rejects NaN, Infinity, fractions, negatives and anything past 2^53. */
export function assertSafeCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new GraphIntegrityInvariantError(`${field} must be a non-negative safe integer`)
  }
  return value
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new GraphIntegrityInvariantError(`${field} must be a string`)
  }
  return value
}

/**
 * A value is share-safe only if the canonical sanitizer returns it unchanged.
 *
 * Testing the fixpoint rather than re-sanitizing means the boundary cannot
 * quietly repair an unsafe value into a safe one: a record that would have been
 * altered is refused, because something upstream already failed to sanitize it.
 */
function assertShareSafe(
  value: unknown,
  field: string,
  sanitize: (input: string) => string | null | undefined,
): void {
  const raw = assertString(value, field)
  if (sanitize(raw) !== raw) {
    throw new GraphIntegrityInvariantError(`${field} is not share-safe: ${JSON.stringify(raw.slice(0, 80))}`)
  }
}


/**
 * Content-derived identities are a prefix plus a full lowercase SHA-256.
 *
 * Validating them as generic safe strings accepted a truncated hash, a wrong
 * prefix, or an id belonging to another record class -- all of which look like
 * ordinary safe strings and none of which name what they claim to.
 */
const ID_PREFIXES = {
  unresolved: 'uc_',
  rejected: 'rc_',
  conflicting: 'cc_',
} as const

const HASH_SUFFIX = /^[a-f0-9]{64}$/

function assertContentAddress(value: unknown, prefix: string, field: string): string {
  const id = assertString(value, field)
  if (!id.startsWith(prefix) || !HASH_SUFFIX.test(id.slice(prefix.length))) {
    throw new GraphIntegrityInvariantError(
      `${field} must be ${prefix} followed by a full lowercase SHA-256, got ${JSON.stringify(id.slice(0, 24))}`,
    )
  }
  return id
}

/** Exact key sets for every closed serializer-facing schema. */
const SCHEMA = {
  verificationTarget: { required: ['file', 'reason'], optional: ['range'] },
  sourceRange: { required: ['start', 'end'], optional: [] },
  sourcePosition: { required: ['line', 'column'], optional: [] },
  graphTotals: { required: ['facts', 'occurrences', 'endpointPairs'], optional: [] },
  storageAdmission: {
    required: ['unresolvedUnregisteredRelationCandidates', 'unregisteredRelationCounts'],
    optional: [],
  },
  occurrence: {
    required: ['id', 'factId', 'owner', 'provenance', 'confidenceObservations', 'metadata'],
    optional: ['sourceFile', 'sourceRange', 'targetFile', 'targetRange', 'siteKind', 'adapterEvidenceKey'],
  },
  occurrenceOwner: { required: ['adapterId', 'strategy'], optional: ['sourceFile', 'adapterVersion'] },
  recordRetention: { required: ['unresolved', 'rejected', 'conflicting'], optional: [] },
} as const

function assertSourcePosition(value: unknown, field: string): { line: number; column: number } {
  assertClosedPlainDataObject(value, SCHEMA.sourcePosition, field)
  return {
    line: assertSafeCount(value['line'], `${field}.line`),
    column: assertSafeCount(value['column'], `${field}.column`),
  }
}

function assertSourceRange(value: unknown, field: string): void {
  assertClosedPlainDataObject(value, SCHEMA.sourceRange, field)
  const start = assertSourcePosition(value['start'], `${field}.start`)
  const end = assertSourcePosition(value['end'], `${field}.end`)
  // A range that ends before it starts names no region, and a reader following
  // it would either read nothing or read backwards.
  if (end.line < start.line || (end.line === start.line && end.column < start.column)) {
    throw new GraphIntegrityInvariantError(
      `${field} ends at ${end.line}:${end.column} before it starts at ${start.line}:${start.column}`,
    )
  }
}

const RECORD_SCHEMA = {
  unresolved: {
    required: ['kind', 'id', 'multiplicity', 'reasons', 'verificationTargets',
      'candidateFingerprint', 'occurrences', 'occurrenceRetention'],
    optional: ['source', 'target', 'relation'],
  },
  rejected: {
    required: ['kind', 'id', 'multiplicity', 'reasons', 'verificationTargets',
      'candidateFingerprint', 'sanitizedCandidate'],
    optional: [],
  },
  conflicting: {
    required: ['kind', 'id', 'multiplicity', 'reasons', 'verificationTargets',
      'candidateFingerprints', 'fingerprintRetention', 'fingerprintSetDigest'],
    optional: [],
  },
} as const satisfies Record<string, ClosedObjectSchema>

type RecordKind = keyof typeof RECORD_SCHEMA

function assertReasons(value: unknown, field: string): void {
  assertArray(value, field)
  if (value.length === 0) {
    throw new GraphIntegrityInvariantError(`${field} must carry at least one reason`)
  }
  for (const [index, reason] of value.entries()) {
    const name = assertString(reason, `${field}[${index}]`)
    if (!isTerminalIntegrityReason(name)) {
      throw new GraphIntegrityInvariantError(`${field}[${index}] is not a terminal reason: ${JSON.stringify(name)}`)
    }
  }
}

function assertVerificationTargets(value: unknown, field: string): void {
  assertArray(value, field)
  if (value.length > MAX_VERIFICATION_TARGETS_PER_RECORD) {
    throw new GraphIntegrityInvariantError(
      `${field} carries ${value.length} targets, above the per-record bound`,
    )
  }
  for (const [index, target] of value.entries()) {
    const at = `${field}[${index}]`
    // Exact shape: a target with an unknown field is a field nobody validated.
    assertClosedPlainDataObject(target, SCHEMA.verificationTarget, at)
    // A stored target is already repository-relative, so re-normalizing it with
    // no root must be a no-op. Anything absolute, encoded, disguised or
    // escaping fails here rather than reaching a reader.
    assertShareSafe(target['file'], `${at}.file`, (file) => (
      normalizeVerificationTargetPath(file, { field: at })
    ))
    const reason = assertString(target['reason'], `${at}.reason`)
    if (!isTerminalIntegrityReason(reason)) {
      throw new GraphIntegrityInvariantError(`${at}.reason is not a terminal reason: ${JSON.stringify(reason)}`)
    }
    if (target['range'] !== undefined) assertSourceRange(target['range'], `${at}.range`)
  }
}

/**
 * Validates one evidence occurrence against the shape Stage 3 will serialize.
 *
 * Accepting an arbitrary object whose string fields happen to be safe was the
 * gap: the fields nobody named were never looked at, and a BigInt or a nested
 * private path could ride through untouched.
 */
function assertEvidenceOccurrence(value: unknown, field: string): void {
  assertClosedPlainDataObject(value, SCHEMA.occurrence, field)
  assertContentAddress(value['id'], 'eo_', `${field}.id`)
  assertContentAddress(value['factId'], 'sf_', `${field}.factId`)

  const owner = value['owner']
  assertClosedPlainDataObject(owner, SCHEMA.occurrenceOwner, `${field}.owner`)
  for (const key of ['adapterId', 'strategy', 'sourceFile', 'adapterVersion']) {
    const entry = (owner as Record<string, unknown>)[key]
    if (entry === undefined) continue
    assertShareSafe(entry, `${field}.owner.${key}`, (raw) => safeCandidateString(raw, `${field}.owner.${key}`))
  }

  for (const key of ['sourceFile', 'targetFile', 'siteKind', 'adapterEvidenceKey']) {
    const entry = value[key]
    if (entry === undefined) continue
    assertShareSafe(entry, `${field}.${key}`, (raw) => safeCandidateString(raw, `${field}.${key}`))
  }
  for (const key of ['sourceRange', 'targetRange']) {
    if (value[key] === undefined) continue
    assertSourceRange(value[key], `${field}.${key}`)
  }

  // Provenance and confidence entries are intentionally extensible, so their
  // keys cannot be closed. Every key and nested value is still validated as
  // bounded canonical JSON, and every string is still held to share safety --
  // extensible is not the same as unchecked, and nothing is silently dropped.
  for (const key of ['provenance', 'confidenceObservations'] as const) {
    const entries = value[key]
    assertArray(entries, `${field}.${key}`)
    for (const [index, entry] of entries.entries()) {
      const at = `${field}.${key}[${index}]`
      assertPlainJsonObject(entry, at)
      assertCanonicalJsonValue(entry, at)
      assertShareSafeStringsDeep(entry, at)
    }
  }

  assertPlainJsonObject(value['metadata'], `${field}.metadata`)
  assertCanonicalJsonValue(value['metadata'], `${field}.metadata`)
  assertShareSafeStringsDeep(value['metadata'], `${field}.metadata`)
}

/** Every string anywhere inside an extensible payload is still share-safe. */
function assertShareSafeStringsDeep(value: unknown, field: string): void {
  if (typeof value === 'string') {
    assertShareSafe(value, field, (raw) => safeCandidateString(raw, field))
    return
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) assertShareSafeStringsDeep(entry, `${field}[${index}]`)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    assertShareSafe(key, `${field} key ${JSON.stringify(key)}`, (raw) => safeCandidateString(raw, field))
    assertShareSafeStringsDeep(entry, `${field}.${key}`)
  }
}

/**
 * Validates one record against the schema its own discriminant declares.
 *
 * Field agreement is checked in both directions. A record relabelled from
 * `unresolved` to `rejected` keeps `occurrences` and `occurrenceRetention`,
 * which the rejected schema does not allow, so the relabelling is caught even
 * though every individual field is still well-formed.
 */
export function assertSerializerFacingRecord(
  record: unknown,
  expectedKind: RecordKind,
  field: string,
  flattenedRoot: string | null = null,
): void {
  assertPlainJsonObject(record, field)

  const kind = assertString(record['kind'], `${field}.kind`)
  if (!(kind in RECORD_SCHEMA)) {
    throw new GraphIntegrityInvariantError(`${field}.kind is unknown: ${JSON.stringify(kind)}`)
  }
  if (kind !== expectedKind) {
    throw new GraphIntegrityInvariantError(`${field} is a ${kind} record in the ${expectedKind} array`)
  }

  // Exact key set for this kind. The plain-object gate above already refused a
  // custom prototype, symbol keys, accessors and non-enumerable properties, so
  // reading `kind` could not run caller code.
  assertClosedPlainDataObject(record, RECORD_SCHEMA[kind], field)

  // Format for every kind. Rejected and conflict records additionally have
  // their ids rederived below, because they retain their complete identity
  // payloads. An unresolved record does not: its id keys on the ORIGINAL
  // endpoints while the record carries their redacted display projection, so
  // rederiving from what it carries would only agree on corpora where nothing
  // needed redacting. That limit is stated rather than papered over.
  assertContentAddress(record['id'], ID_PREFIXES[kind], `${field}.id`)
  const multiplicity = assertSafeCount(record['multiplicity'], `${field}.multiplicity`)
  if (multiplicity < 1) {
    throw new GraphIntegrityInvariantError(`${field}.multiplicity must be at least 1`)
  }
  assertReasons(record['reasons'], `${field}.reasons`)
  assertVerificationTargets(record['verificationTargets'], `${field}.verificationTargets`)

  if (kind === 'unresolved' || kind === 'rejected') {
    // Format only, deliberately. The fingerprint keys on the ORIGINAL endpoints
    // while the record carries their redacted display projection -- that split
    // is the B1 fix, and it is what keeps omitting an unsafe hint from
    // collapsing two distinct candidates onto one record. The record therefore
    // does not contain the fingerprint's inputs, so rederiving it here is not
    // possible, and a check that appeared to do so would only be testing
    // corpora where nothing needed redacting.
    assertContentAddress(record['candidateFingerprint'], 'cf_', `${field}.candidateFingerprint`)
  }

  if (kind === 'unresolved') {
    for (const endpoint of ['source', 'target', 'relation'] as const) {
      const value = record[endpoint]
      if (value === undefined) continue
      assertShareSafe(value, `${field}.${endpoint}`, (raw) => (
        safeEndpointIdentifier(raw, `${field}.${endpoint}`, flattenedRoot)
      ))
    }
    assertArray(record['occurrences'], `${field}.occurrences`)
    for (const [index, occurrence] of record['occurrences'].entries()) {
      assertEvidenceOccurrence(occurrence, `${field}.occurrences[${index}]`)
    }
    assertDetailRetention(record['occurrenceRetention'] as never, `${field}.occurrenceRetention`)

  }

  if (kind === 'rejected') {
    // Intentionally free-form, so its keys cannot be closed -- but every key and
    // every nested value at every depth is still bounded canonical JSON and
    // still share-safe. Checking only top-level strings let a private path or a
    // BigInt sit one level down and pass.
    const projection = record['sanitizedCandidate']
    assertPlainJsonObject(projection, `${field}.sanitizedCandidate`)
    assertCanonicalJsonValue(projection, `${field}.sanitizedCandidate`)
    assertShareSafeStringsDeep(projection, `${field}.sanitizedCandidate`)

    // A rejected record retains its entire identity payload -- fingerprint,
    // sanitized candidate and reasons -- so its id is rederivable and is
    // rederived. A well-formed id belonging to a different record is caught
    // here; format alone would have accepted it.
    const rederived = contentAddressOf('rc_', rejectedRecordIdentityPayload({
      candidateFingerprint: record['candidateFingerprint'] as string,
      sanitizedCandidate: projection,
      reasons: record['reasons'] as never,
    }))
    if (rederived !== record['id']) {
      throw new GraphIntegrityInvariantError(
        `${field}.id does not match the record's own identity payload`,
      )
    }
  }

  if (kind === 'conflicting') {
    assertArray(record['candidateFingerprints'], `${field}.candidateFingerprints`)
    for (const [index, fingerprint] of record['candidateFingerprints'].entries()) {
      assertContentAddress(fingerprint, 'cf_', `${field}.candidateFingerprints[${index}]`)
    }
    assertDetailRetention(record['fingerprintRetention'] as never, `${field}.fingerprintRetention`)
    assertContentAddress(record['fingerprintSetDigest'], 'cs_', `${field}.fingerprintSetDigest`)

    const retention = record['fingerprintRetention'] as { truncated: boolean }
    if (!retention.truncated) {
      // Untruncated means the carried array IS the complete set, so the
      // complete-set digest is rederivable and is rederived. When truncated it
      // is not, and claiming otherwise would rederive from a subset and call
      // the disagreement a tamper.
      const rederivedDigest = conflictFingerprintSetDigest(record['candidateFingerprints'] as readonly string[])
      if (rederivedDigest !== record['fingerprintSetDigest']) {
        throw new GraphIntegrityInvariantError(
          `${field}.fingerprintSetDigest does not match its own complete fingerprint set`,
        )
      }
    }

    // The conflict id keys on the digest and the reasons, both of which the
    // record retains whether or not the fingerprint list was capped.
    const rederivedId = contentAddressOf('cc_', conflictRecordIdentityPayload({
      fingerprintSetDigest: record['fingerprintSetDigest'] as string,
      reasons: record['reasons'] as never,
    }))
    if (rederivedId !== record['id']) {
      throw new GraphIntegrityInvariantError(
        `${field}.id does not match the record's own identity payload`,
      )
    }
  }

  // Retention/array agreement, which the record-level owner already knows how
  // to check for each kind.
  assertRecordRetention(record as unknown as DurableCandidateRecord, field)

  // Per-RECORD detail caps, which are kind-specific and far smaller than the
  // per-KIND bound.
  //
  // `MAX_DURABLE_RECORDS_PER_KIND` (1000) bounds how many RECORDS a kind may
  // carry, and stays where it belongs, in the receipt's per-kind retention
  // check. It says nothing about how much detail ONE record may carry, and
  // construction bounds that detail with `MAX_RECORD_OCCURRENCES` (16) and
  // `MAX_CONFLICT_FINGERPRINTS` (32). Checking the outer constant here meant a
  // record claiming 900 retained occurrences passed the boundary this validator
  // exists to guard -- the caps were enforced only on the trusted construction
  // path and not at all on the untrusted one.
  //
  // `rejected` carries no per-record detail array, so it has no detail cap; its
  // population is bounded by the per-kind array check alone.
  const detail = kind === 'unresolved'
    ? {
      cap: MAX_RECORD_OCCURRENCES,
      retained: (record['occurrenceRetention'] as { retained: number }).retained,
      carried: (record['occurrences'] as readonly unknown[]).length,
      noun: 'occurrences',
    }
    : kind === 'conflicting'
      ? {
        cap: MAX_CONFLICT_FINGERPRINTS,
        retained: (record['fingerprintRetention'] as { retained: number }).retained,
        carried: (record['candidateFingerprints'] as readonly string[]).length,
        noun: 'fingerprints',
      }
      : null

  if (detail !== null) {
    // Both halves are checked. `assertRecordRetention` above already requires
    // the claim and the array to agree, so either alone would be sufficient
    // today -- and stating only one would make this validator depend on that
    // ordering holding forever.
    if (detail.retained > detail.cap) {
      throw new GraphIntegrityInvariantError(
        `${field} claims ${detail.retained} retained ${detail.noun}, above the per-record bound of ${detail.cap}`,
      )
    }
    if (detail.carried > detail.cap) {
      throw new GraphIntegrityInvariantError(
        `${field} carries ${detail.carried} ${detail.noun}, above the per-record bound of ${detail.cap}`,
      )
    }
  }
}

export function assertEndpointIdentityMatrixShape(
  matrix: unknown,
  facts: number,
  field = 'endpointIdentityMatrix',
): void {
  assertPlainJsonObject(matrix, field)
  const statuses = new Set<string>(ENDPOINT_IDENTITY_STATUSES)
  for (const key of Object.keys(matrix)) {
    if (!statuses.has(key)) {
      throw new GraphIntegrityInvariantError(`${field} has unknown status row ${JSON.stringify(key)}`)
    }
  }
  let sum = 0
  for (const source of ENDPOINT_IDENTITY_STATUSES) {
    const row = matrix[source]
    assertPlainJsonObject(row, `${field}.${source}`)
    for (const key of Object.keys(row)) {
      if (!statuses.has(key)) {
        throw new GraphIntegrityInvariantError(`${field}.${source} has unknown status ${JSON.stringify(key)}`)
      }
    }
    for (const target of ENDPOINT_IDENTITY_STATUSES) {
      sum += assertSafeCount(row[target], `${field}.${source}.${target}`)
    }
  }
  // The matrix partitions stored facts. A sum that disagrees means either the
  // matrix or the fact count is wrong, and a reader cannot tell which.
  if (sum !== facts) {
    throw new GraphIntegrityInvariantError(`${field} sums to ${sum} but the graph retains ${facts} facts`)
  }
}

/**
 * Reason maps are closed vocabularies.
 *
 * An unknown key is not a harmless extra diagnostic: it is a reason no reader
 * can interpret, carried as though the producer and the reader agreed on it.
 *
 * Their values are overlapping diagnostics and deliberately are NOT required to
 * sum to any candidate or fact total -- one fact can carry several reasons.
 */
export function assertReasonFactCounts(counts: unknown, field = 'reasonFactCounts'): void {
  assertPlainJsonObject(counts, field)
  const known = new Set<string>(ENDPOINT_IDENTITY_REASONS)
  for (const reason of Object.getOwnPropertyNames(counts)) {
    if (!known.has(reason)) {
      throw new GraphIntegrityInvariantError(`${field} has unknown endpoint reason ${JSON.stringify(reason)}`)
    }
    // Present-with-undefined is refused rather than skipped: it survives every
    // numeric check by never reaching one, and then breaks serialization.
    assertSafeCount(counts[reason], `${field}.${reason}`)
  }
}

export function assertTerminalReasonCounts(counts: unknown, field = 'terminalReasonCounts'): void {
  assertPlainJsonObject(counts, field)
  for (const reason of Object.getOwnPropertyNames(counts)) {
    if (!isTerminalIntegrityReason(reason)) {
      throw new GraphIntegrityInvariantError(`${field} has unknown terminal reason ${JSON.stringify(reason)}`)
    }
    assertSafeCount(counts[reason], `${field}.${reason}`)
  }
}

export function assertStorageAdmissionShape(
  admission: unknown,
  field = 'storageAdmission',
): void {
  assertClosedPlainDataObject(admission, SCHEMA.storageAdmission, field)
  const total = assertSafeCount(
    admission['unresolvedUnregisteredRelationCandidates'],
    `${field}.unresolvedUnregisteredRelationCandidates`,
  )
  const counts = admission['unregisteredRelationCounts']
  assertPlainJsonObject(counts, `${field}.unregisteredRelationCounts`)
  let componentSum = 0
  for (const [relation, count] of Object.entries(counts)) {
    assertShareSafe(relation, `${field}.unregisteredRelationCounts key`, (raw) => safeScopeName(raw))
    componentSum += assertSafeCount(count, `${field}.unregisteredRelationCounts.${relation}`)
  }
  // The headline number must be the sum of its parts, or the summary and its
  // breakdown describe different runs.
  if (componentSum !== total) {
    throw new GraphIntegrityInvariantError(
      `${field} totals ${total} but its per-relation counts sum to ${componentSum}`,
    )
  }
}

function assertTerminalCounts(counts: unknown, field = 'terminalCounts'): void {
  assertClosedPlainDataObject(counts, { required: CANDIDATE_TERMINAL_STATES }, field)
  for (const state of CANDIDATE_TERMINAL_STATES) {
    assertSafeCount(counts[state], `${field}.${state}`)
  }
}

export interface SerializerFacingIntegrityInput {
  readonly emittedCandidates: number
  readonly counts: unknown
  /**
   * Passed explicitly rather than merely deep frozen. Freezing an object stops
   * it changing; it says nothing about whether its keys are a vocabulary any
   * reader can interpret.
   */
  readonly terminalReasonCounts: unknown
  readonly facts: number
  readonly occurrences: number
  readonly endpointPairs: number
  readonly endpointIdentityMatrix: unknown
  readonly reasonFactCounts: unknown
  readonly storageAdmission: unknown
  readonly unresolvedRecords: unknown
  readonly rejectedRecords: unknown
  readonly conflictRecords: unknown
  readonly recordRetention: unknown
  readonly scopeFailures: unknown
  readonly scopeFailureRetention: unknown
  readonly flattenedRoot?: string | null
}

/**
 * One entry point that validates every serializer-facing structure.
 *
 * Called before a snapshot is constructed or attached, so an invalid payload
 * can never become graph state and can never be serialized.
 */
export function assertSerializerFacingIntegrity(input: SerializerFacingIntegrityInput): void {
  const facts = assertSafeCount(input.facts, 'graphTotals.facts')
  assertSafeCount(input.occurrences, 'graphTotals.occurrences')
  assertSafeCount(input.endpointPairs, 'graphTotals.endpointPairs')
  assertSafeCount(input.emittedCandidates, 'emittedCandidates')

  assertTerminalCounts(input.counts)
  assertTerminalReasonCounts(input.terminalReasonCounts)
  assertCandidateAccountingEquation(input.emittedCandidates, input.counts as never)

  assertEndpointIdentityMatrixShape(input.endpointIdentityMatrix, facts)
  assertReasonFactCounts(input.reasonFactCounts)
  assertStorageAdmissionShape(input.storageAdmission)

  const flattenedRoot = input.flattenedRoot ?? null
  const kinds = [
    ['unresolved', input.unresolvedRecords],
    ['rejected', input.rejectedRecords],
    ['conflicting', input.conflictRecords],
  ] as const

  assertClosedPlainDataObject(input.recordRetention, SCHEMA.recordRetention, 'recordRetention')
  for (const [kind, records] of kinds) {
    assertArray(records, `${kind}Records`)
    const seen = new Set<string>()
    for (const [index, record] of records.entries()) {
      const field = `${kind}Records[${index}]`
      assertSerializerFacingRecord(record, kind, field, flattenedRoot)
      const id = (record as { id: string }).id
      // Two records sharing an id with different payloads would make the
      // artifact ambiguous about which one the id names.
      if (seen.has(id)) {
        throw new GraphIntegrityInvariantError(`${kind}Records contains a duplicate id ${JSON.stringify(id)}`)
      }
      seen.add(id)
    }

    const retention = input.recordRetention[kind]
    assertDetailRetention(retention as never, `recordRetention.${kind}`)
    const claimed = (retention as { retained: number }).retained
    if (records.length !== claimed) {
      throw new GraphIntegrityInvariantError(
        `${kind}Records carries ${records.length} entries but claims ${claimed} retained`,
      )
    }
  }
  void DETAIL_RETENTION_KEYS
  assertArray(input.scopeFailures, 'scopeFailures')
  for (const [index, failure] of input.scopeFailures.entries()) {
    assertShareSafe(failure, `scopeFailures[${index}]`, (raw) => safeScopeName(raw))
  }
  assertDetailRetention(input.scopeFailureRetention as never, 'scopeFailureRetention')
  const scopeRetained = (input.scopeFailureRetention as { retained: number }).retained
  if (input.scopeFailures.length !== scopeRetained) {
    throw new GraphIntegrityInvariantError(
      `scopeFailures carries ${input.scopeFailures.length} entries but claims ${scopeRetained} retained`,
    )
  }
}

export type { EndpointIdentityReason }
