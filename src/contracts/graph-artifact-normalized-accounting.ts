/**
 * The wire projection of normalized-boundary accounting inside artifact v2.
 *
 * Stage 3 of #658 serializes the already-finalized snapshot; it does not
 * compute a second one. So this module owns exactly two things: the closed
 * shape the bytes carry, and the translation between that shape and the
 * structures the graph already validates. Status, reasons, the candidate
 * equation and record validity all stay with their existing owners --
 * `buildNormalizedIntegrityReceipt` derives the receipt and
 * `assertSerializerFacingIntegrity` decides whether a record may be serialized.
 * A second derivation here would be a second authority, and the two would
 * disagree the moment either changed.
 *
 * The block is additive and optional. Artifact identity does not move: same
 * `MADAR_GRAPH_ARTIFACT/2` magic, same `graph_artifact: 2`, same
 * `receipt_storage_schema: 1`, same `out/graph.madar` path. An older reader
 * that does not know this key ignores it and keeps reading the storage-only
 * receipt exactly as before, which is the whole point of putting the accounting
 * *inside* `integrity_receipt` rather than beside it as a new payload field.
 */

import {
  ENDPOINT_IDENTITY_REASONS,
  ENDPOINT_IDENTITY_STATUSES,
  type EndpointIdentityReason,
} from './endpoint-identity.js'
import {
  GraphIntegrityInvariantError,
  assertClosedPlainDataObject,
  assertDetailRetention,
  type CandidateConflictRecord,
  type CandidateTerminalCounts,
  type DetailRetention,
  type EndpointIdentityFactMatrix,
  type GraphIntegrityReceiptV1,
  type IntegrityReason,
  type RejectedCandidateRecord,
  type TerminalIntegrityReason,
  type UnresolvedCandidateRecord,
} from './graph-integrity.js'
import {
  assertNormalizedIntegrityReceipt,
  assertStorageAdmissionProjection,
  buildNormalizedIntegrityReceipt,
} from './graph-integrity-receipt.js'
import {
  assertSerializerFacingRecord,
  assertSafeCount,
} from './graph-integrity-validation.js'
import type { NormalizedAccountingResult } from './graph-integrity-session.js'
import type { FinalizedNormalizedIntegritySnapshot } from './graph-integrity-snapshot.js'
import {
  NORMALIZED_ACCOUNTING_ARTIFACT_KEY,
  NORMALIZED_ACCOUNTING_KEYS,
  NORMALIZED_RECEIPT_DURABLE_RECORD_KEYS,
  NORMALIZED_RECEIPT_ENDPOINT_IDENTITY_KEYS,
  NORMALIZED_RECEIPT_KEYS,
  normalizedAccountingStructureError,
} from './graph-artifact-payload.js'

export { NORMALIZED_ACCOUNTING_ARTIFACT_KEY }

/**
 * Generation never evaluates strict mode.
 *
 * Strict and qualification eligibility is decided on load, through the existing
 * `LoadGraphArtifactOptions.mode`, against the bytes as they stand. Recording a
 * verdict at write time would bake one reader's policy into the artifact and
 * make a later policy change require rewriting bytes that did not change.
 */
export const GENERATION_STRICT_MODE_RESULT = 'not_run' as const

/**
 * Normalized accounting as it appears on the wire.
 *
 * Deliberately a thin envelope around structures that already have owners: the
 * receipt is `GraphIntegrityReceiptV1` verbatim, and the record arrays carry
 * the same durable records the snapshot holds, in the same shape the one
 * serializer-facing validator already knows how to check. Renaming their fields
 * for the wire would fork every schema, every content address and every
 * share-safety rule into a second copy.
 */
export interface GraphArtifactNormalizedAccountingV1 {
  readonly receipt: GraphIntegrityReceiptV1

  readonly unresolved_records: readonly UnresolvedCandidateRecord[]
  readonly rejected_records: readonly RejectedCandidateRecord[]
  readonly conflict_records: readonly CandidateConflictRecord[]

  readonly scope_failures: readonly string[]
  readonly scope_failure_retention: DetailRetention

  readonly reserved: Readonly<Record<string, never>>
}

const RECORD_ARRAYS = [
  ['unresolved', 'unresolved_records'],
  ['rejected', 'rejected_records'],
  ['conflicting', 'conflict_records'],
] as const

/**
 * Strictly ascending code-unit order, which is also what proves uniqueness.
 *
 * The same comparator the accounting session bounds records with, so a
 * round trip cannot reorder anything: `localeCompare` is locale-sensitive and
 * would order some ids differently on a different host.
 */
function assertStrictlyAscending(values: readonly string[], field: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1] as string
    const current = values[index] as string
    if (previous === current) {
      throw new GraphIntegrityInvariantError(`${field} contains a duplicate entry ${JSON.stringify(current)}`)
    }
    if (previous > current) {
      throw new GraphIntegrityInvariantError(
        `${field} is not in canonical order at index ${index}: ${JSON.stringify(current)} follows ${JSON.stringify(previous)}`,
      )
    }
  }
}

function assertArray(value: unknown, field: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new GraphIntegrityInvariantError(`${field} must be an array`)
  }
}

/**
 * Closes the receipt's own key set before any of its values is trusted.
 *
 * `assertNormalizedIntegrityReceipt` is the authority on what the receipt's
 * numbers mean, but it reads named fields and says nothing about a field nobody
 * declared. On the wire an undeclared field is a field nobody validated, so the
 * shape is closed first and the meaning is checked second.
 */
function assertClosedReceiptShape(value: unknown, field: string): asserts value is GraphIntegrityReceiptV1 {
  assertClosedPlainDataObject(value, { required: NORMALIZED_RECEIPT_KEYS }, field)
  const receipt = value as unknown as GraphIntegrityReceiptV1
  assertClosedPlainDataObject(
    receipt.endpoint_identity,
    { required: NORMALIZED_RECEIPT_ENDPOINT_IDENTITY_KEYS },
    `${field}.endpoint_identity`,
  )
  assertClosedPlainDataObject(
    receipt.durable_records,
    { required: NORMALIZED_RECEIPT_DURABLE_RECORD_KEYS },
    `${field}.durable_records`,
  )
}

/**
 * Full validation of one normalized accounting block, run on write and again on
 * load.
 *
 * Everything reachable from here is treated as untrusted. On write that guards
 * against a snapshot that was tampered with in memory; on load it is the only
 * thing standing between arbitrary bytes and graph state. The two callers share
 * one implementation so a reader can never accept something a writer would have
 * refused.
 */
export function assertGraphArtifactNormalizedAccounting(
  value: unknown,
  field: string,
): asserts value is GraphArtifactNormalizedAccountingV1 {
  assertClosedPlainDataObject(value, { required: NORMALIZED_ACCOUNTING_KEYS }, field)
  const block = value as unknown as GraphArtifactNormalizedAccountingV1

  assertClosedReceiptShape(block.receipt, `${field}.receipt`)
  // The one receipt authority. It re-derives status and reasons from the
  // receipt's own counters and compares, so a forged `valid` no longer agrees
  // with the numbers beside it.
  assertNormalizedIntegrityReceipt(block.receipt)

  assertClosedPlainDataObject(block.reserved, { required: [] }, `${field}.reserved`)

  for (const [kind, key] of RECORD_ARRAYS) {
    const records = block[key]
    assertArray(records, `${field}.${key}`)
    const ids: string[] = []
    for (const [index, record] of records.entries()) {
      // Records carry no `flattenedRoot` on the wire, and a reader has no way
      // to learn the checkout they were produced under. The root-independent
      // share-safety rules are still applied in full; the root-derived rule was
      // already applied at construction, when the root was known.
      assertSerializerFacingRecord(record, kind, `${field}.${key}[${index}]`, null)
      ids.push((record as { readonly id: string }).id)
    }
    // Refused, never repaired. Deterministic bytes are a wire contract, so
    // sorting an unsorted array on read would hide the very divergence the
    // contract exists to make visible.
    assertStrictlyAscending(ids, `${field}.${key}`)

    const retention = block.receipt.durable_records[kind]
    if (records.length !== retention.retained) {
      throw new GraphIntegrityInvariantError(
        `${field}.${key} carries ${records.length} records but the receipt claims ${retention.retained} retained`,
      )
    }
  }

  assertArray(block.scope_failures, `${field}.scope_failures`)
  for (const [index, failure] of block.scope_failures.entries()) {
    if (typeof failure !== 'string') {
      throw new GraphIntegrityInvariantError(`${field}.scope_failures[${index}] must be a string`)
    }
  }
  assertStrictlyAscending(block.scope_failures, `${field}.scope_failures`)
  assertDetailRetention(block.scope_failure_retention, `${field}.scope_failure_retention`)
  if (block.scope_failures.length !== block.scope_failure_retention.retained) {
    throw new GraphIntegrityInvariantError(
      `${field}.scope_failures carries ${block.scope_failures.length} entries `
      + `but claims ${block.scope_failure_retention.retained} retained`,
    )
  }
}

/**
 * Projects a finalized snapshot into wire form.
 *
 * O(1) access to the snapshot plus a bounded sort. Nothing here walks facts,
 * occurrences or candidates, and nothing re-derives status: the snapshot was
 * finalized once, at the end of the build that produced it, and this reads it.
 *
 * Sorting happens on detached copies. The snapshot is deep-frozen and is graph
 * state; a serializer that reordered it in place would change what every later
 * reader of the same graph sees.
 */
export function buildGraphArtifactNormalizedAccounting(
  snapshot: FinalizedNormalizedIntegritySnapshot,
): GraphArtifactNormalizedAccountingV1 {
  const receipt = buildNormalizedIntegrityReceipt({
    emittedCandidates: snapshot.emittedCandidates,
    counts: snapshot.terminalCounts,
    terminalReasonCounts: snapshot.terminalReasonCounts,
    factsRetained: snapshot.graphTotals.facts,
    occurrencesRetained: snapshot.graphTotals.occurrences,
    uniqueEndpointPairs: snapshot.graphTotals.endpointPairs,
    endpointFactPairCounts: snapshot.endpointIdentityMatrix,
    endpointReasonFactCounts: snapshot.reasonFactCounts,
    unresolvedRetention: snapshot.recordRetention.unresolved,
    rejectedRetention: snapshot.recordRetention.rejected,
    conflictingRetention: snapshot.recordRetention.conflicting,
    strictModeResult: GENERATION_STRICT_MODE_RESULT,
  })

  // The receipt and the snapshot run the same derivation over the same
  // counters, so they agree by construction -- unless the snapshot's stored
  // verdict was edited after it was finalized, which is exactly what this
  // catches.
  assertDerivedVerdictAgrees(receipt, snapshot)
  assertStorageAdmissionProjection(
    snapshot.storageAdmission.unresolvedUnregisteredRelationCandidates,
    receipt,
  )

  const block: GraphArtifactNormalizedAccountingV1 = {
    receipt,
    unresolved_records: sortedById(snapshot.unresolvedRecords),
    rejected_records: sortedById(snapshot.rejectedRecords),
    conflict_records: sortedById(snapshot.conflictRecords),
    scope_failures: Object.freeze([...snapshot.scopeFailures]),
    scope_failure_retention: snapshot.scopeFailureRetention,
    reserved: Object.freeze({}),
  }

  // Validated before it can become bytes, by the same function that will
  // validate it again when those bytes are read back.
  assertGraphArtifactNormalizedAccounting(block, NORMALIZED_ACCOUNTING_ARTIFACT_KEY)
  return Object.freeze(block)
}

function sortedById<T extends { readonly id: string }>(records: readonly T[]): readonly T[] {
  return Object.freeze([...records].sort((left, right) => (
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  )))
}

/**
 * The snapshot's verdict and the receipt's verdict must be the same verdict.
 *
 * Both come from `deriveIntegrityStatus` over the same counters, so a
 * disagreement means one of the two was changed after it was derived.
 */
function assertDerivedVerdictAgrees(
  receipt: GraphIntegrityReceiptV1,
  snapshot: FinalizedNormalizedIntegritySnapshot,
): void {
  if (receipt.status !== snapshot.status) {
    throw new GraphIntegrityInvariantError(
      `normalized receipt status ${receipt.status} disagrees with the snapshot status ${snapshot.status}`,
    )
  }
  const snapshotReasons: readonly IntegrityReason[] = snapshot.reasons
  if (
    receipt.reasons.length !== snapshotReasons.length
    || receipt.reasons.some((reason, index) => reason !== snapshotReasons[index])
  ) {
    throw new GraphIntegrityInvariantError('normalized receipt reasons disagree with the snapshot they describe')
  }
}

/**
 * Rebuilds the accounting result a loaded block describes.
 *
 * The loader does not run the normalized extraction boundary and must not
 * fabricate accounting, so everything here is read from the validated block and
 * nothing is invented. `flattenedRoot` is genuinely absent: it is a property of
 * the machine that produced the artifact, the records were already redacted
 * against it, and inventing one would claim a checkout this reader never saw.
 */
export function normalizedAccountingResultFromArtifact(
  block: GraphArtifactNormalizedAccountingV1,
): NormalizedAccountingResult {
  const receipt = block.receipt
  return Object.freeze({
    flattenedRoot: null,
    emittedCandidates: receipt.emitted_candidates,
    counts: Object.freeze({ ...receipt.terminal_counts }) as CandidateTerminalCounts,
    terminalReasonCounts: Object.freeze(
      { ...receipt.terminal_reason_counts },
    ) as Readonly<Partial<Record<TerminalIntegrityReason, number>>>,
    unresolvedRecords: block.unresolved_records,
    rejectedRecords: block.rejected_records,
    conflictRecords: block.conflict_records,
    recordRetention: Object.freeze({
      unresolved: receipt.durable_records.unresolved,
      rejected: receipt.durable_records.rejected,
      conflicting: receipt.durable_records.conflicting,
    }),
    scopeFailures: block.scope_failures,
    scopeFailureRetention: block.scope_failure_retention,
  })
}

/**
 * Parses a decoded `normalized_accounting` value into validated, detached data.
 *
 * The structural gate runs first and is the same one the workspace classifier
 * uses, so a block the classifier called healthy cannot fail its first shape
 * check here. Everything after it is the full semantic contract.
 */
export function parseGraphArtifactNormalizedAccounting(
  value: unknown,
  field: string,
): GraphArtifactNormalizedAccountingV1 {
  const structureError = normalizedAccountingStructureError(value, field)
  if (structureError !== null) throw new GraphIntegrityInvariantError(structureError)
  assertGraphArtifactNormalizedAccounting(value, field)
  return value
}

/**
 * Cross-boundary reconciliation between the normalized receipt and the graph
 * the artifact actually carries.
 *
 * Run on write against the graph being serialized and on load against the graph
 * just hydrated. Both directions matter: a receipt whose totals drift from its
 * own graph describes a different build, and a reader that accepted it would
 * report accounting for facts it does not hold.
 */
export function assertNormalizedReceiptMatchesGraphTotals(
  receipt: GraphIntegrityReceiptV1,
  totals: { readonly facts: number; readonly occurrences: number; readonly endpointPairs: number },
): void {
  const declared = [
    ['facts_retained', receipt.facts_retained, totals.facts],
    ['occurrences_retained', receipt.occurrences_retained, totals.occurrences],
    ['unique_endpoint_pairs', receipt.unique_endpoint_pairs, totals.endpointPairs],
  ] as const
  for (const [name, stated, actual] of declared) {
    assertSafeCount(actual, `graph ${name}`)
    if (stated !== actual) {
      throw new GraphIntegrityInvariantError(
        `normalized receipt ${name} is ${stated} but the graph holds ${actual}`,
      )
    }
  }
}

/**
 * Endpoint identity is inherited from #657 and never upgraded here.
 *
 * The normalized receipt's matrix comes from the counters the graph maintains
 * on insertion; the storage receipt's comes from walking the retained facts.
 * They are two independent derivations of one truth, so comparing them is
 * evidence rather than ceremony -- and a candidate that never became a fact
 * cannot appear in either without the disagreement showing here.
 */
export function assertNormalizedEndpointIdentityMatchesStorage(
  receipt: GraphIntegrityReceiptV1,
  storage: StorageEndpointIdentityProjection,
): void {
  // Every declared cell, always. Iterating the vocabulary rather than whichever
  // keys happen to be present means a missing row is a disagreement instead of
  // a comparison that quietly never happened.
  for (const sourceStatus of ENDPOINT_IDENTITY_STATUSES) {
    for (const targetStatus of ENDPOINT_IDENTITY_STATUSES) {
      const normalized = receipt.endpoint_identity.fact_pair_counts[sourceStatus]?.[targetStatus]
      const stored = storage.fact_pair_counts[sourceStatus]?.[targetStatus]
      if (normalized !== stored) {
        throw new GraphIntegrityInvariantError(
          `normalized endpoint matrix disagrees with the storage receipt at ${sourceStatus}/${targetStatus}: `
          + `${String(normalized)} against ${String(stored)}`,
        )
      }
    }
  }

  for (const reason of ENDPOINT_IDENTITY_REASONS) {
    const normalized = receipt.endpoint_identity.reason_fact_counts[reason]
    const stored = storage.reason_fact_counts[reason]
    if (normalized !== stored) {
      throw new GraphIntegrityInvariantError(
        `normalized endpoint reason count for ${JSON.stringify(reason)} is ${String(normalized)} `
        + `but the storage receipt counted ${String(stored)}`,
      )
    }
  }
}

/** The endpoint-identity half of #657's storage-only receipt. */
export interface StorageEndpointIdentityProjection {
  readonly fact_pair_counts: EndpointIdentityFactMatrix
  readonly reason_fact_counts: Readonly<Partial<Record<EndpointIdentityReason, number>>>
}
