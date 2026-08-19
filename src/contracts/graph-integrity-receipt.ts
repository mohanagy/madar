import { ENDPOINT_IDENTITY_STATUSES, type EndpointIdentityReason } from './endpoint-identity.js'
import {
  CANDIDATE_TERMINAL_STATES,
  GRAPH_INTEGRITY_REASON_VOCABULARY_VERSION,
  GRAPH_INTEGRITY_RECEIPT_VERSION,
  GraphIntegrityInvariantError,
  MAX_DURABLE_RECORDS_PER_KIND,
  NORMALIZED_ACCOUNTING_SCOPE,
  TERMINAL_INTEGRITY_REASONS,
  assertCandidateAccountingEquation,
  assertEndpointMatrixPartition,
  deriveIntegrityStatus,
  isScopeIntegrityReason,
  isTerminalIntegrityReason,
  type CandidateTerminalCounts,
  assertDetailRetention,
  type DetailRetention,
  type EndpointIdentityFactMatrix,
  type GraphIntegrityReceiptV1,
  type IntegrityReason,
  type StrictModeResult,
  type TerminalIntegrityReason,
} from './graph-integrity.js'

/**
 * Construction and validation of the normalized-boundary receipt.
 *
 * Kept apart from the vocabulary module so the thing that *defines* a terminal
 * state does not also decide whether a whole run was valid. Everything here is
 * pure: it takes counts and returns or checks a receipt, and knows nothing
 * about graphs, files or pipelines.
 */

/**
 * Counts of candidates carrying each terminal reason.
 *
 * Overlapping diagnostics, deliberately **not** a partition: one candidate with
 * both a missing endpoint and an unsupported relation contributes to both
 * counters, so these need not sum to `emitted_candidates`. #657 documented the
 * same property for `reason_fact_counts` and it is restated here rather than
 * left for a reader to infer from a surprising total.
 */
export type TerminalReasonCounts = Readonly<Partial<Record<TerminalIntegrityReason, number>>>

export interface NormalizedIntegrityReceiptInput {
  readonly emittedCandidates: number
  readonly counts: CandidateTerminalCounts
  readonly terminalReasonCounts: TerminalReasonCounts
  readonly factsRetained: number
  readonly occurrencesRetained: number
  readonly uniqueEndpointPairs: number
  readonly endpointFactPairCounts: EndpointIdentityFactMatrix
  readonly endpointReasonFactCounts: Readonly<Partial<Record<EndpointIdentityReason, number>>>
  readonly unresolvedRetention: DetailRetention
  readonly rejectedRetention: DetailRetention
  readonly conflictingRetention: DetailRetention
  readonly strictModeResult: StrictModeResult
  readonly legacyArtifact?: boolean
}

function assertCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GraphIntegrityInvariantError(`${field} must be a non-negative safe integer`)
  }
  return value
}

/**
 * A normalized-boundary receipt carries exactly one retention contract.
 *
 * All four fields are required, and `omitted` and `truncated` are re-derived and
 * compared rather than accepted -- a receipt that arrives with only
 * `{retained, total}` is refused, not silently upgraded. Deriving the missing
 * fields would manufacture agreement between a producer and a reader who never
 * actually agreed, which is the failure this contract exists to prevent.
 */
function assertRetention(retention: DetailRetention, field: string): DetailRetention {
  assertDetailRetention(retention, field)
  if (retention.retained > MAX_DURABLE_RECORDS_PER_KIND) {
    throw new GraphIntegrityInvariantError(`${field} retained ${retention.retained} exceeds the per-kind bound`)
  }
  return Object.freeze({
    retained: retention.retained,
    total: retention.total,
    omitted: retention.omitted,
    truncated: retention.truncated,
  })
}

function normalizeTerminalReasonCounts(counts: TerminalReasonCounts): TerminalReasonCounts {
  const entries: Array<[TerminalIntegrityReason, number]> = []
  for (const [reason, count] of Object.entries(counts)) {
    if (!isTerminalIntegrityReason(reason)) {
      throw new GraphIntegrityInvariantError(`terminal_reason_counts has unknown reason ${JSON.stringify(reason)}`)
    }
    if (count === undefined) continue
    assertCount(count, `terminal_reason_counts.${reason}`)
    // A zero here would be indistinguishable from absence and would let two
    // equivalent runs serialize differently, so zeros are simply not carried.
    if (count === 0) continue
    entries.push([reason, count])
  }
  return Object.freeze(Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))))
}

function truncated(input: NormalizedIntegrityReceiptInput): boolean {
  // Read the disclosed flag rather than re-deriving it: the retention contract
  // has already been validated, so the flag and the arithmetic agree by
  // construction.
  return input.unresolvedRetention.truncated
    || input.rejectedRetention.truncated
    || input.conflictingRetention.truncated
}

/**
 * Builds a receipt whose status is *derived*, never supplied.
 *
 * A caller-supplied status is the one field a buggy or hostile producer would
 * most want to set, so it is not an input at all: it comes from
 * `deriveIntegrityStatus` and is re-derived and compared on validation.
 */
export function buildNormalizedIntegrityReceipt(
  input: NormalizedIntegrityReceiptInput,
): GraphIntegrityReceiptV1 {
  assertCandidateAccountingEquation(input.emittedCandidates, input.counts)
  assertEndpointMatrixPartition(input.endpointFactPairCounts, input.factsRetained)
  assertCount(input.occurrencesRetained, 'occurrences_retained')
  assertCount(input.uniqueEndpointPairs, 'unique_endpoint_pairs')

  const terminalReasonCounts = normalizeTerminalReasonCounts(input.terminalReasonCounts)
  const unresolved = assertRetention(input.unresolvedRetention, 'durable_records.unresolved')
  const rejected = assertRetention(input.rejectedRetention, 'durable_records.rejected')
  const conflicting = assertRetention(input.conflictingRetention, 'durable_records.conflicting')

  const derived = deriveIntegrityStatus({
    counts: input.counts,
    endpointReasonFactCounts: input.endpointReasonFactCounts,
    matrix: input.endpointFactPairCounts,
    recordsTruncated: truncated(input),
    legacyArtifact: input.legacyArtifact === true,
    retainedPartialDiscriminators: terminalReasonCounts.partial_discriminator ?? 0,
  })

  assertStrictModeResultPolicy(input.strictModeResult, derived.status)

  return Object.freeze({
    receipt_version: GRAPH_INTEGRITY_RECEIPT_VERSION,
    reason_vocabulary_version: GRAPH_INTEGRITY_REASON_VOCABULARY_VERSION,
    accounting_scope: NORMALIZED_ACCOUNTING_SCOPE,

    emitted_candidates: input.emittedCandidates,
    terminal_counts: Object.freeze({ ...input.counts }),

    facts_retained: input.factsRetained,
    occurrences_retained: input.occurrencesRetained,
    unique_endpoint_pairs: input.uniqueEndpointPairs,

    terminal_reason_counts: terminalReasonCounts,

    missing_source_endpoints: terminalReasonCounts.missing_source_endpoint ?? 0,
    missing_target_endpoints: terminalReasonCounts.missing_target_endpoint ?? 0,
    malformed_candidates: terminalReasonCounts.malformed_candidate ?? 0,
    unsupported_relations: terminalReasonCounts.unsupported_relation ?? 0,

    endpoint_identity: Object.freeze({
      statuses: ENDPOINT_IDENTITY_STATUSES,
      fact_pair_counts: input.endpointFactPairCounts,
      reason_fact_counts: Object.freeze({ ...input.endpointReasonFactCounts }),
    }),

    durable_records: Object.freeze({
      unresolved,
      rejected,
      conflicting,
      max_records_per_kind: MAX_DURABLE_RECORDS_PER_KIND,
    }),

    status: derived.status,
    reasons: derived.reasons,
    strict_mode_result: input.strictModeResult,
  }) as GraphIntegrityReceiptV1
}

/**
 * Strict mode may only report `pass` for a run that actually qualified.
 *
 * Without this, a producer could record `strict_mode_result: 'pass'` beside a
 * degraded status and every downstream reader that trusts one field over the
 * other would disagree about the same artifact.
 */
export function assertStrictModeResultPolicy(
  result: StrictModeResult,
  status: GraphIntegrityReceiptV1['status'],
): void {
  if (result !== 'pass' && result !== 'fail' && result !== 'not_run') {
    throw new GraphIntegrityInvariantError(`strict_mode_result ${JSON.stringify(result)} is not a declared result`)
  }
  if (result === 'pass' && status !== 'valid' && status !== 'valid_with_warnings') {
    throw new GraphIntegrityInvariantError(`strict_mode_result cannot be pass while integrity status is ${status}`)
  }
}

/**
 * Full receipt validation, run on write and again on load.
 *
 * Re-derives status from the receipt's own numbers and compares. That is the
 * invariant that makes the status field unforgeable: a tampered `valid` no
 * longer agrees with the counters it sits beside, and the mismatch is a thrown
 * error rather than a value a reader has to second-guess.
 */
export function assertNormalizedIntegrityReceipt(receipt: GraphIntegrityReceiptV1): void {
  if (receipt.receipt_version !== GRAPH_INTEGRITY_RECEIPT_VERSION) {
    throw new GraphIntegrityInvariantError(`unsupported receipt_version ${String(receipt.receipt_version)}`)
  }
  if (receipt.reason_vocabulary_version !== GRAPH_INTEGRITY_REASON_VOCABULARY_VERSION) {
    throw new GraphIntegrityInvariantError(
      `unsupported reason_vocabulary_version ${String(receipt.reason_vocabulary_version)}`,
    )
  }
  if (receipt.accounting_scope !== NORMALIZED_ACCOUNTING_SCOPE) {
    throw new GraphIntegrityInvariantError(
      `accounting_scope must be ${NORMALIZED_ACCOUNTING_SCOPE}, not ${String(receipt.accounting_scope)}`,
    )
  }

  assertCandidateAccountingEquation(receipt.emitted_candidates, receipt.terminal_counts)
  assertEndpointMatrixPartition(receipt.endpoint_identity.fact_pair_counts, receipt.facts_retained)
  assertCount(receipt.occurrences_retained, 'occurrences_retained')
  assertCount(receipt.unique_endpoint_pairs, 'unique_endpoint_pairs')

  for (const field of ['missing_source_endpoints', 'missing_target_endpoints', 'malformed_candidates', 'unsupported_relations'] as const) {
    assertCount(receipt[field], field)
  }

  assertTerminalReasonCounts(receipt.terminal_reason_counts)

  // The named counters are a projection of the breakdown, so a receipt cannot
  // report one number in the summary and a different one in the detail.
  const mirrored = [
    ['missing_source_endpoints', 'missing_source_endpoint'],
    ['missing_target_endpoints', 'missing_target_endpoint'],
    ['malformed_candidates', 'malformed_candidate'],
    ['unsupported_relations', 'unsupported_relation'],
  ] as const
  for (const [named, reason] of mirrored) {
    const expected = receipt.terminal_reason_counts[reason] ?? 0
    if (receipt[named] !== expected) {
      throw new GraphIntegrityInvariantError(
        `${named} is ${receipt[named]} but terminal_reason_counts.${reason} is ${expected}`,
      )
    }
  }

  // Named counters describe unresolved and rejected candidates, so neither can
  // exceed the candidates that actually ended there.
  const unresolvedOrRejected = receipt.terminal_counts.unresolved + receipt.terminal_counts.rejected
  for (const field of ['missing_source_endpoints', 'missing_target_endpoints', 'malformed_candidates', 'unsupported_relations'] as const) {
    if (receipt[field] > unresolvedOrRejected) {
      throw new GraphIntegrityInvariantError(
        `${field} is ${receipt[field]} but only ${unresolvedOrRejected} candidates were unresolved or rejected`,
      )
    }
  }

  if (
    receipt.endpoint_identity.statuses.length !== ENDPOINT_IDENTITY_STATUSES.length
    || receipt.endpoint_identity.statuses.some((status, index) => status !== ENDPOINT_IDENTITY_STATUSES[index])
  ) {
    throw new GraphIntegrityInvariantError('endpoint identity statuses must keep their declared order')
  }

  assertRetention(receipt.durable_records.unresolved, 'durable_records.unresolved')
  assertRetention(receipt.durable_records.rejected, 'durable_records.rejected')
  assertRetention(receipt.durable_records.conflicting, 'durable_records.conflicting')
  if (receipt.durable_records.max_records_per_kind !== MAX_DURABLE_RECORDS_PER_KIND) {
    throw new GraphIntegrityInvariantError('durable_records.max_records_per_kind does not match the declared bound')
  }

  assertReasonVocabulary(receipt.reasons)

  const recordsTruncated = receipt.durable_records.unresolved.retained < receipt.durable_records.unresolved.total
    || receipt.durable_records.rejected.retained < receipt.durable_records.rejected.total
    || receipt.durable_records.conflicting.retained < receipt.durable_records.conflicting.total

  if (recordsTruncated !== receipt.reasons.includes('durable_records_truncated')) {
    throw new GraphIntegrityInvariantError(
      'durable_records_truncated must be disclosed exactly when a record kind was truncated',
    )
  }

  const derived = deriveIntegrityStatus({
    counts: receipt.terminal_counts,
    endpointReasonFactCounts: receipt.endpoint_identity.reason_fact_counts,
    matrix: receipt.endpoint_identity.fact_pair_counts,
    recordsTruncated,
    legacyArtifact: receipt.reasons.includes('legacy_artifact'),
    retainedPartialDiscriminators: receipt.terminal_reason_counts.partial_discriminator ?? 0,
  })

  if (derived.status !== receipt.status) {
    throw new GraphIntegrityInvariantError(
      `integrity status ${receipt.status} disagrees with its own counters, which derive ${derived.status}`,
    )
  }
  if (derived.reasons.length !== receipt.reasons.length
    || derived.reasons.some((reason, index) => reason !== receipt.reasons[index])) {
    throw new GraphIntegrityInvariantError('integrity reasons disagree with the receipt they describe')
  }

  assertStrictModeResultPolicy(receipt.strict_mode_result, receipt.status)
}

/**
 * The breakdown must be deterministic on the wire: known reasons only, keys in
 * a stable order, and no zero-valued entry -- a zero is indistinguishable from
 * absence and would let two equivalent runs serialize differently.
 */
function assertTerminalReasonCounts(counts: TerminalReasonCounts): void {
  const keys = Object.keys(counts)
  for (const [reason, count] of Object.entries(counts)) {
    if (!isTerminalIntegrityReason(reason)) {
      throw new GraphIntegrityInvariantError(`terminal_reason_counts has unknown reason ${JSON.stringify(reason)}`)
    }
    assertCount(count as number, `terminal_reason_counts.${reason}`)
    if (count === 0) {
      throw new GraphIntegrityInvariantError(`terminal_reason_counts.${reason} must be omitted rather than zero`)
    }
  }
  const sorted = [...keys].sort((left, right) => left.localeCompare(right))
  if (keys.some((key, index) => key !== sorted[index])) {
    throw new GraphIntegrityInvariantError('terminal_reason_counts keys must be sorted')
  }
}

function assertReasonVocabulary(reasons: readonly IntegrityReason[]): void {
  for (const reason of reasons) {
    if (!isScopeIntegrityReason(reason) && !isTerminalIntegrityReason(reason)) {
      throw new GraphIntegrityInvariantError(`receipt carries unknown reason ${JSON.stringify(reason)}`)
    }
  }
  const sorted = [...reasons].sort()
  if (reasons.some((reason, index) => reason !== sorted[index])) {
    throw new GraphIntegrityInvariantError('receipt reasons must be sorted')
  }
  if (new Set(reasons).size !== reasons.length) {
    throw new GraphIntegrityInvariantError('receipt reasons must be unique')
  }
}

/**
 * The reconciliation rule between this receipt and #657's storage-only
 * `storage_admission` diagnostic.
 *
 * They describe the same event at two depths: an unregistered relation is
 * refused inside `addEdge` (storage) and classified as a rejected candidate
 * (normalized). `storage_admission` is therefore a **projection, never an
 * addend** -- adding it to the terminal counters would count one event twice.
 *
 * Checked as an equality rather than documented as a convention, because a
 * convention cannot fail a build.
 *
 * The equality holds only while every unsupported-relation determination is
 * made *by* `addEdge`. Stage 2 must therefore not pre-check the registry and
 * skip the call as an optimization: that would count a rejection at the
 * normalized boundary that the storage boundary never saw, and this assertion
 * would fail -- which is the intended alarm, not a false positive.
 */
export function assertStorageAdmissionProjection(
  unregisteredAtStorageBoundary: number,
  receipt: GraphIntegrityReceiptV1,
): void {
  assertCount(unregisteredAtStorageBoundary, 'storage_admission.unresolved_unregistered_relation_candidates')
  if (unregisteredAtStorageBoundary !== receipt.unsupported_relations) {
    throw new GraphIntegrityInvariantError(
      `storage admission counted ${unregisteredAtStorageBoundary} unregistered relations `
      + `but the normalized receipt counted ${receipt.unsupported_relations}`,
    )
  }
}

/** Every declared terminal reason, for callers building a full breakdown. */
export const ALL_TERMINAL_REASONS = TERMINAL_INTEGRITY_REASONS

/** Every declared terminal state, re-exported so callers need one import. */
export const ALL_TERMINAL_STATES = CANDIDATE_TERMINAL_STATES
