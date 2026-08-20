import { ENDPOINT_IDENTITY_STATUSES, type EndpointIdentityReason } from './endpoint-identity.js'
import {
  assertDetailRetention,
  assertEndpointMatrixPartition,
  assertRecordRetention,
  deriveIntegrityStatus,
  type CandidateConflictRecord,
  type CandidateTerminalCounts,
  type DetailRetention,
  type EndpointIdentityFactMatrix,
  type GraphIntegrityStatus,
  type IntegrityReason,
  type RejectedCandidateRecord,
  type TerminalIntegrityReason,
  type UnresolvedCandidateRecord,
} from './graph-integrity.js'
import { assertCandidateAccountingEquation, GraphIntegrityInvariantError, NORMALIZED_ACCOUNTING_SCOPE } from './graph-integrity.js'
import { assertSerializerFacingIntegrity } from './graph-integrity-validation.js'
import type { NormalizedAccountingResult } from './graph-integrity-session.js'
import type { StorageBoundaryAdmissionSummary } from './graph.js'

/**
 * Everything a serializer needs about normalized integrity, frozen at one
 * moment, derived once.
 *
 * Stage 3 must not re-derive status, re-walk facts to rebuild the endpoint
 * matrix, or reconstruct counters from graph totals. #705 already carries an
 * accepted load-performance exception and #706 owns broad optimization, so a
 * second full accumulation is not available to spend. This object exists so
 * serialization is a read plus a bounded sort.
 *
 * It is deliberately a *composite of already-owned parts* rather than a second
 * receipt authority: terminal accounting comes from the session, the endpoint
 * matrix and storage admission from the graph's existing #657 walk, and status
 * from the one central derivation.
 */
export interface FinalizedNormalizedIntegritySnapshot {
  readonly accountingScope: typeof NORMALIZED_ACCOUNTING_SCOPE

  readonly emittedCandidates: number
  readonly terminalCounts: CandidateTerminalCounts
  readonly terminalReasonCounts: Readonly<Partial<Record<TerminalIntegrityReason, number>>>

  readonly status: GraphIntegrityStatus
  readonly reasons: readonly IntegrityReason[]

  readonly graphTotals: {
    readonly facts: number
    readonly occurrences: number
    readonly endpointPairs: number
  }

  readonly endpointIdentityMatrix: EndpointIdentityFactMatrix
  readonly reasonFactCounts: Readonly<Partial<Record<EndpointIdentityReason, number>>>
  readonly storageAdmission: StorageBoundaryAdmissionSummary

  readonly unresolvedRecords: readonly UnresolvedCandidateRecord[]
  readonly rejectedRecords: readonly RejectedCandidateRecord[]
  readonly conflictRecords: readonly CandidateConflictRecord[]
  readonly recordRetention: {
    readonly unresolved: DetailRetention
    readonly rejected: DetailRetention
    readonly conflicting: DetailRetention
  }

  readonly scopeFailures: readonly string[]
  readonly scopeFailureRetention: DetailRetention
}

export interface SnapshotInput {
  readonly accountingResult: NormalizedAccountingResult
  readonly facts: number
  readonly occurrences: number
  readonly endpointPairs: number
  readonly endpointIdentityMatrix: EndpointIdentityFactMatrix
  readonly reasonFactCounts: Readonly<Partial<Record<EndpointIdentityReason, number>>>
  readonly storageAdmission: StorageBoundaryAdmissionSummary
  readonly legacyArtifact?: boolean
}

/**
 * Builds the snapshot, validating every invariant it will later be trusted for.
 *
 * Validation happens here rather than at serialization because a snapshot that
 * is wrong at construction is wrong for the rest of its life, and Stage 3 will
 * have no cheap way to notice.
 */
/**
 * Freezes a projection all the way down.
 *
 * `Object.freeze` is shallow, so a frozen snapshot whose matrix rows, record
 * arrays and retention objects were still writable was immutable only at the
 * top: a consumer handed the snapshot could rewrite a matrix cell, a retained
 * record, or a retention count through the object it was given, and the change
 * would serialize as though the producer had written it.
 *
 * Cycles are tracked because a projection that ever gains one must not turn a
 * freeze into a hang.
 */
function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return value
  seen.add(value)
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen)
  }
  return Object.freeze(value)
}

export function finalizeNormalizedIntegritySnapshot(
  input: SnapshotInput,
): FinalizedNormalizedIntegritySnapshot {
  const accounting = input.accountingResult

  // One total validation of every serializer-facing structure. Whatever reaches
  // this boundary is treated as untrusted -- it may have been hand-built,
  // decoded from bytes, relabelled, or tampered with -- so nothing downstream
  // has to re-check, and nothing invalid can become graph state.
  assertSerializerFacingIntegrity({
    emittedCandidates: accounting.emittedCandidates,
    counts: accounting.counts,
    terminalReasonCounts: accounting.terminalReasonCounts,
    facts: input.facts,
    occurrences: input.occurrences,
    endpointPairs: input.endpointPairs,
    endpointIdentityMatrix: input.endpointIdentityMatrix,
    reasonFactCounts: input.reasonFactCounts,
    storageAdmission: input.storageAdmission,
    unresolvedRecords: accounting.unresolvedRecords,
    rejectedRecords: accounting.rejectedRecords,
    conflictRecords: accounting.conflictRecords,
    recordRetention: accounting.recordRetention,
    scopeFailures: accounting.scopeFailures,
    scopeFailureRetention: accounting.scopeFailureRetention,
    flattenedRoot: accounting.flattenedRoot,
  })

  const derived = deriveIntegrityStatus({
    counts: accounting.counts,
    endpointReasonFactCounts: input.reasonFactCounts,
    matrix: input.endpointIdentityMatrix,
    recordsTruncated: accounting.recordRetention.unresolved.truncated
      || accounting.recordRetention.rejected.truncated
      || accounting.recordRetention.conflicting.truncated,
    legacyArtifact: input.legacyArtifact === true,
    // One authority: the terminal reason count IS the retained
    // partial-discriminator count. A second counter derived from the same loop
    // let the status reason be driven by either value alone, so the two could
    // disagree and the reason could appear or vanish depending on which was
    // believed.
    retainedPartialDiscriminators: accounting.terminalReasonCounts.partial_discriminator ?? 0,
  })

  if (
    input.endpointIdentityMatrix === undefined
    || ENDPOINT_IDENTITY_STATUSES.some((status) => input.endpointIdentityMatrix[status] === undefined)
  ) {
    throw new GraphIntegrityInvariantError('endpoint identity matrix is incomplete')
  }

  return deepFreeze({
    accountingScope: NORMALIZED_ACCOUNTING_SCOPE,

    emittedCandidates: accounting.emittedCandidates,
    terminalCounts: accounting.counts,
    terminalReasonCounts: accounting.terminalReasonCounts,

    status: derived.status,
    reasons: derived.reasons,

    graphTotals: Object.freeze({
      facts: input.facts,
      occurrences: input.occurrences,
      endpointPairs: input.endpointPairs,
    }),

    endpointIdentityMatrix: input.endpointIdentityMatrix,
    reasonFactCounts: input.reasonFactCounts,
    storageAdmission: input.storageAdmission,

    unresolvedRecords: accounting.unresolvedRecords,
    rejectedRecords: accounting.rejectedRecords,
    conflictRecords: accounting.conflictRecords,
    recordRetention: accounting.recordRetention,

    scopeFailures: accounting.scopeFailures,
    scopeFailureRetention: accounting.scopeFailureRetention,
  })
}
