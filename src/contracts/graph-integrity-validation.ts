import { ENDPOINT_IDENTITY_STATUSES, type EndpointIdentityReason } from './endpoint-identity.js'
import {
  assertCandidateAccountingEquation,
  assertDetailRetention,
  assertRecordRetention,
  CANDIDATE_TERMINAL_STATES,
  GraphIntegrityInvariantError,
  isTerminalIntegrityReason,
  MAX_DURABLE_RECORDS_PER_KIND,
  normalizeVerificationTargetPath,
  safeEndpointIdentifier,
  type DurableCandidateRecord,
} from './graph-integrity.js'
import { safeCandidateString, safeScopeName } from './graph-integrity-session.js'

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

function assertPlainObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GraphIntegrityInvariantError(`${field} must be an object`)
  }
}

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

const RECORD_FIELDS = {
  unresolved: new Set([
    'kind', 'id', 'multiplicity', 'reasons', 'verificationTargets',
    'candidateFingerprint', 'source', 'target', 'relation',
    'occurrences', 'occurrenceRetention',
  ]),
  rejected: new Set([
    'kind', 'id', 'multiplicity', 'reasons', 'verificationTargets',
    'candidateFingerprint', 'sanitizedCandidate',
  ]),
  conflicting: new Set([
    'kind', 'id', 'multiplicity', 'reasons', 'verificationTargets',
    'candidateFingerprints', 'fingerprintRetention', 'fingerprintSetDigest',
  ]),
} as const

type RecordKind = keyof typeof RECORD_FIELDS

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
  for (const [index, target] of value.entries()) {
    const at = `${field}[${index}]`
    assertPlainObject(target, at)
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
  assertPlainObject(record, field)

  const kind = assertString(record['kind'], `${field}.kind`)
  if (!(kind in RECORD_FIELDS)) {
    throw new GraphIntegrityInvariantError(`${field}.kind is unknown: ${JSON.stringify(kind)}`)
  }
  if (kind !== expectedKind) {
    throw new GraphIntegrityInvariantError(`${field} is a ${kind} record in the ${expectedKind} array`)
  }

  const allowed = RECORD_FIELDS[kind]
  for (const present of Object.keys(record)) {
    if (!allowed.has(present)) {
      throw new GraphIntegrityInvariantError(`${field} carries ${JSON.stringify(present)}, which a ${kind} record has no schema for`)
    }
  }

  assertShareSafe(record['id'], `${field}.id`, (id) => safeCandidateString(id, `${field}.id`))
  const multiplicity = assertSafeCount(record['multiplicity'], `${field}.multiplicity`)
  if (multiplicity < 1) {
    throw new GraphIntegrityInvariantError(`${field}.multiplicity must be at least 1`)
  }
  assertReasons(record['reasons'], `${field}.reasons`)
  assertVerificationTargets(record['verificationTargets'], `${field}.verificationTargets`)

  if (kind === 'unresolved' || kind === 'rejected') {
    assertShareSafe(record['candidateFingerprint'], `${field}.candidateFingerprint`, (value) => (
      safeCandidateString(value, `${field}.candidateFingerprint`)
    ))
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
      const at = `${field}.occurrences[${index}]`
      assertPlainObject(occurrence, at)
      // Occurrence references are opaque here, so every string they carry is
      // held to the same share-safety rule as the rest of the record.
      for (const [key, value] of Object.entries(occurrence)) {
        if (typeof value !== 'string') continue
        assertShareSafe(value, `${at}.${key}`, (raw) => safeCandidateString(raw, `${at}.${key}`))
      }
    }
    assertDetailRetention(record['occurrenceRetention'] as never, `${field}.occurrenceRetention`)
  }

  if (kind === 'rejected') {
    assertPlainObject(record['sanitizedCandidate'], `${field}.sanitizedCandidate`)
    for (const [key, value] of Object.entries(record['sanitizedCandidate'])) {
      if (typeof value !== 'string') continue
      assertShareSafe(value, `${field}.sanitizedCandidate.${key}`, (raw) => (
        safeCandidateString(raw, `${field}.sanitizedCandidate.${key}`)
      ))
    }
  }

  if (kind === 'conflicting') {
    assertArray(record['candidateFingerprints'], `${field}.candidateFingerprints`)
    for (const [index, fingerprint] of record['candidateFingerprints'].entries()) {
      assertShareSafe(fingerprint, `${field}.candidateFingerprints[${index}]`, (raw) => (
        safeCandidateString(raw, `${field}.candidateFingerprints[${index}]`)
      ))
    }
    assertDetailRetention(record['fingerprintRetention'] as never, `${field}.fingerprintRetention`)
    assertShareSafe(record['fingerprintSetDigest'], `${field}.fingerprintSetDigest`, (raw) => (
      safeCandidateString(raw, `${field}.fingerprintSetDigest`)
    ))
  }

  // Retention/array agreement, which the record-level owner already knows how
  // to check for each kind.
  assertRecordRetention(record as unknown as DurableCandidateRecord, field)

  const retained = kind === 'unresolved'
    ? (record['occurrenceRetention'] as { retained: number }).retained
    : kind === 'conflicting'
      ? (record['fingerprintRetention'] as { retained: number }).retained
      : 0
  if (retained > MAX_DURABLE_RECORDS_PER_KIND) {
    throw new GraphIntegrityInvariantError(`${field} retains ${retained} entries, above the per-kind bound`)
  }
}

export function assertEndpointIdentityMatrixShape(
  matrix: unknown,
  facts: number,
  field = 'endpointIdentityMatrix',
): void {
  assertPlainObject(matrix, field)
  const statuses = new Set<string>(ENDPOINT_IDENTITY_STATUSES)
  for (const key of Object.keys(matrix)) {
    if (!statuses.has(key)) {
      throw new GraphIntegrityInvariantError(`${field} has unknown status row ${JSON.stringify(key)}`)
    }
  }
  let sum = 0
  for (const source of ENDPOINT_IDENTITY_STATUSES) {
    const row = matrix[source]
    assertPlainObject(row, `${field}.${source}`)
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

export function assertReasonFactCounts(counts: unknown, field = 'reasonFactCounts'): void {
  assertPlainObject(counts, field)
  for (const [reason, count] of Object.entries(counts)) {
    if (count === undefined) continue
    assertSafeCount(count, `${field}.${reason}`)
  }
}

export function assertStorageAdmissionShape(
  admission: unknown,
  field = 'storageAdmission',
): void {
  assertPlainObject(admission, field)
  const total = assertSafeCount(
    admission['unresolvedUnregisteredRelationCandidates'],
    `${field}.unresolvedUnregisteredRelationCandidates`,
  )
  const counts = admission['unregisteredRelationCounts']
  assertPlainObject(counts, `${field}.unregisteredRelationCounts`)
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
  assertPlainObject(counts, field)
  for (const key of Object.keys(counts)) {
    if (!(CANDIDATE_TERMINAL_STATES as readonly string[]).includes(key)) {
      throw new GraphIntegrityInvariantError(`${field} has unknown terminal state ${JSON.stringify(key)}`)
    }
  }
  for (const state of CANDIDATE_TERMINAL_STATES) {
    assertSafeCount(counts[state], `${field}.${state}`)
  }
}

export interface SerializerFacingIntegrityInput {
  readonly emittedCandidates: number
  readonly counts: unknown
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

  assertPlainObject(input.recordRetention, 'recordRetention')
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
  for (const key of Object.keys(input.recordRetention)) {
    if (!['unresolved', 'rejected', 'conflicting'].includes(key)) {
      throw new GraphIntegrityInvariantError(`recordRetention has unknown kind ${JSON.stringify(key)}`)
    }
  }

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
