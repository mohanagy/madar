import { createHash } from 'node:crypto'

import { canonicalJsonBytes, orderedCanonicalArray, serializeCanonicalJson } from './canonical-json.js'
import { ENDPOINT_IDENTITY_STATUSES, type EndpointIdentityReason, type EndpointIdentityStatus } from './endpoint-identity.js'
import { normalizeIdentityRepositoryPath } from './semantic-identity.js'
import type { CanonicalJson } from './canonical-json.js'
import type { EvidenceOccurrence, SourceRange } from './semantic-graph.js'

/**
 * Normalized-boundary graph integrity: what happened to every candidate that
 * reached the declared normalized extraction boundary.
 *
 * The boundary is deliberately narrow and named. A candidate is one entry of
 * the `edges` array of the extraction payload presented to `buildFromJson`.
 * Everything an adapter discarded before that point is outside this scope and
 * is disclosed rather than counted -- that upstream collapse is #703, and
 * claiming it here would make the receipt a lie in the flattering direction.
 *
 * This module owns contracts only. It does not walk the pipeline (#658 Stage 2)
 * and does not serialize (#658 Stage 3).
 */

/** Bumped whenever a reason code is added, removed or has its meaning changed. */
export const GRAPH_INTEGRITY_REASON_VOCABULARY_VERSION = 1 as const

/** Bumped whenever the receipt's own shape changes. Independent of artifact version. */
export const GRAPH_INTEGRITY_RECEIPT_VERSION = 1 as const

export const NORMALIZED_ACCOUNTING_SCOPE = 'normalized_extraction_boundary' as const

/**
 * Every candidate reaching the boundary terminates as exactly one of these.
 * Not a status and not a severity -- a disposition. `retained_*` states mean
 * the candidate became or joined a stored fact; the rest mean it did not, and
 * each carries a durable record saying why.
 */
export const CANDIDATE_TERMINAL_STATES = Object.freeze([
  'retained_new_fact',
  'retained_additional_occurrence',
  'deliberately_merged_duplicate',
  'unresolved',
  'rejected',
  'conflicting',
  'invariant_failed',
] as const)

export type CandidateTerminalState = (typeof CANDIDATE_TERMINAL_STATES)[number]

/**
 * Machine-readable reasons, deliberately split into two families that must not
 * be collapsed into one another.
 *
 * Terminal reasons say why a *candidate* ended where it did. Endpoint-identity
 * reasons say what is known about a *retained fact's* endpoints, and are
 * inherited verbatim from #657 -- completing candidate accounting never repairs
 * an endpoint identity, so a receipt that merged the two families would imply a
 * repair that did not happen. Making an identity movement-stable is #704.
 */
export const TERMINAL_INTEGRITY_REASONS = Object.freeze([
  'adapter_exception_after_normalization',
  'candidate_accounting_mismatch',
  'conflicting_behavior_metadata',
  'hash_payload_invariant_failure',
  'malformed_candidate',
  'malformed_discriminator',
  'malformed_endpoint_identity',
  'missing_both_endpoints',
  'missing_source_endpoint',
  'missing_target_endpoint',
  'partial_discriminator',
  'unresolved_dependency_binding',
  'unresolved_dynamic_target',
  'unresolved_external_module_boundary',
  'unresolved_internal_target',
  'unsupported_relation',
] as const)

export type TerminalIntegrityReason = (typeof TERMINAL_INTEGRITY_REASONS)[number]

/**
 * Receipt-level reasons that describe the accounting run as a whole rather than
 * one candidate. `full_emission_accounting_not_available` is retained from
 * #657's storage-only receipt and still applies: this boundary is normalized
 * extraction, not raw adapter emission.
 */
export const SCOPE_INTEGRITY_REASONS = Object.freeze([
  'context_bound_endpoint_identity',
  'durable_records_truncated',
  'full_emission_accounting_not_available',
  'legacy_artifact',
  'legacy_endpoint_identity',
  'unknown_endpoint_identity',
] as const)

export type ScopeIntegrityReason = (typeof SCOPE_INTEGRITY_REASONS)[number]

export type IntegrityReason = TerminalIntegrityReason | ScopeIntegrityReason

const TERMINAL_REASON_SET: ReadonlySet<string> = new Set(TERMINAL_INTEGRITY_REASONS)
const SCOPE_REASON_SET: ReadonlySet<string> = new Set(SCOPE_INTEGRITY_REASONS)

export function isTerminalIntegrityReason(value: string): value is TerminalIntegrityReason {
  return TERMINAL_REASON_SET.has(value)
}

export function isScopeIntegrityReason(value: string): value is ScopeIntegrityReason {
  return SCOPE_REASON_SET.has(value)
}

export class GraphIntegrityInvariantError extends Error {
  constructor(message: string) {
    super(`Graph integrity invariant failed: ${message}`)
    this.name = 'GraphIntegrityInvariantError'
  }
}

export class DurableRecordCollisionError extends GraphIntegrityInvariantError {
  readonly recordId: string

  constructor(recordId: string) {
    super(`durable record id ${recordId} was derived from two different canonical payloads`)
    this.name = 'DurableRecordCollisionError'
    this.recordId = recordId
  }
}

/**
 * Where a reader should look to resolve an unresolved or rejected candidate.
 *
 * Deliberately a graph-domain type rather than the answerability
 * `MadarVerificationTarget`: #659 owns projecting these into Pack/MCP, and
 * reaching into that domain here would be the propagation this issue is
 * explicitly forbidden to perform.
 */
export interface IntegrityVerificationTarget {
  readonly file: string
  readonly range?: SourceRange
  readonly reason: TerminalIntegrityReason
}

/**
 * Durable records are bounded so a pathological corpus cannot inflate the
 * artifact without limit. #705 accepted a canonical-artifact ratio of 1.799x
 * against a 2.00x gate, so the headroom for unbounded per-candidate records
 * does not exist. Truncation is never silent: it is disclosed by
 * `durable_records_truncated` plus an exact retained/total pair per kind.
 */
export const MAX_DURABLE_RECORDS_PER_KIND = 1000 as const

/** Bounded per record so one candidate cannot carry an unbounded target list. */
export const MAX_VERIFICATION_TARGETS_PER_RECORD = 8 as const

interface DurableRecordBase {
  readonly id: string
  readonly multiplicity: number
  readonly reasons: readonly TerminalIntegrityReason[]
  readonly verificationTargets: readonly IntegrityVerificationTarget[]
}

/**
 * A candidate with a valid normalized shape that could not become a safe
 * traversable fact. Retains sanitized endpoint hints so the gap is actionable,
 * and its occurrences where they were themselves valid.
 */
export interface UnresolvedCandidateRecord extends DurableRecordBase {
  readonly kind: 'unresolved'
  readonly candidateFingerprint: string
  readonly source?: string
  readonly target?: string
  readonly relation?: string
  readonly occurrences: readonly EvidenceOccurrence[]
}

/**
 * A candidate that could not safely retain even a coarse meaning. Only a
 * sanitized share-safe projection survives -- never the raw payload, which may
 * carry absolute paths or arbitrary adapter metadata.
 */
export interface RejectedCandidateRecord extends DurableRecordBase {
  readonly kind: 'rejected'
  readonly candidateFingerprint: string
  readonly sanitizedCandidate: Readonly<Record<string, CanonicalJson>>
}

/**
 * A group of candidates carrying incompatible behaviour-defining metadata that
 * the registered discriminator cannot separate into distinct valid facts.
 * Keyed on the sorted member fingerprints, never on arrival order, so no
 * candidate can win by being observed first.
 */
export interface CandidateConflictRecord extends DurableRecordBase {
  readonly kind: 'conflicting'
  readonly candidateFingerprints: readonly string[]
}

export type DurableCandidateRecord =
  | UnresolvedCandidateRecord
  | RejectedCandidateRecord
  | CandidateConflictRecord

/**
 * Per-kind retention accounting. `total` is what actually occurred; `retained`
 * is what the artifact carries. They differ only under the bound above, and
 * the difference is always disclosed rather than inferred.
 */
export interface DurableRecordRetention {
  readonly retained: number
  readonly total: number
}

export type CandidateTerminalCounts = Readonly<Record<CandidateTerminalState, number>>

export type EndpointIdentityFactMatrix =
  Readonly<Record<EndpointIdentityStatus, Readonly<Record<EndpointIdentityStatus, number>>>>

export type GraphIntegrityStatus =
  | 'valid'
  | 'valid_with_warnings'
  | 'degraded'
  | 'incompatible'
  | 'invalid'

export type StrictModeResult = 'pass' | 'fail' | 'not_run'

export interface GraphIntegrityReceiptV1 {
  readonly receipt_version: typeof GRAPH_INTEGRITY_RECEIPT_VERSION
  readonly reason_vocabulary_version: typeof GRAPH_INTEGRITY_REASON_VOCABULARY_VERSION
  readonly accounting_scope: typeof NORMALIZED_ACCOUNTING_SCOPE

  /** Candidates presented at the boundary. Equals the sum of `terminal_counts`. */
  readonly emitted_candidates: number
  readonly terminal_counts: CandidateTerminalCounts

  /**
   * Graph totals, reported beside the candidate equation and never as part of
   * it. A fact count is not a candidate count: one candidate can add an
   * occurrence to an existing fact, and several candidates can merge into one.
   */
  readonly facts_retained: number
  readonly occurrences_retained: number
  readonly unique_endpoint_pairs: number

  /**
   * Candidates carrying each terminal reason. Overlapping diagnostics,
   * deliberately **not** a partition: one candidate with both a missing
   * endpoint and an unsupported relation contributes to both counters, so
   * these need not sum to `emitted_candidates`. Zero-valued reasons are
   * omitted rather than carried, so two equivalent runs serialize identically.
   */
  readonly terminal_reason_counts: Readonly<Partial<Record<TerminalIntegrityReason, number>>>

  /** The four named counters above, mirrored out of `terminal_reason_counts`. */
  readonly missing_source_endpoints: number
  readonly missing_target_endpoints: number
  readonly malformed_candidates: number
  readonly unsupported_relations: number

  /**
   * Inherited verbatim from #657 and never upgraded here. The matrix is a
   * partition over *stored facts*, so it sums to `facts_retained` -- candidates
   * that never became facts have no cell, which is what keeps terminal
   * accounting and endpoint identity from contaminating each other.
   */
  readonly endpoint_identity: {
    readonly statuses: typeof ENDPOINT_IDENTITY_STATUSES
    readonly fact_pair_counts: EndpointIdentityFactMatrix
    readonly reason_fact_counts: Readonly<Partial<Record<EndpointIdentityReason, number>>>
  }

  readonly durable_records: {
    readonly unresolved: DurableRecordRetention
    readonly rejected: DurableRecordRetention
    readonly conflicting: DurableRecordRetention
    readonly max_records_per_kind: typeof MAX_DURABLE_RECORDS_PER_KIND
  }

  readonly status: GraphIntegrityStatus
  readonly reasons: readonly IntegrityReason[]
  readonly strict_mode_result: StrictModeResult
}

function assertCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GraphIntegrityInvariantError(`${field} must be a non-negative safe integer`)
  }
  return value
}

/**
 * Sums with overflow protection. Seven counters cannot realistically exceed the
 * safe-integer range, but a corrupted or hostile receipt can claim they do, and
 * silently wrapping past 2^53 would make the equation balance on nonsense.
 */
function sumCounts(values: readonly number[], field: string): number {
  let total = 0
  for (const value of values) {
    total += value
    if (!Number.isSafeInteger(total)) {
      throw new GraphIntegrityInvariantError(`${field} exceeds the safe integer range`)
    }
  }
  return total
}

export function emptyTerminalCounts(): CandidateTerminalCounts {
  return Object.freeze({
    retained_new_fact: 0,
    retained_additional_occurrence: 0,
    deliberately_merged_duplicate: 0,
    unresolved: 0,
    rejected: 0,
    conflicting: 0,
    invariant_failed: 0,
  })
}

/**
 * The candidate accounting invariant, enforced rather than reported.
 *
 * Reporting it would let a caller publish a receipt whose own numbers disagree;
 * every write and every load runs this, so an imbalance is a thrown error at
 * the boundary that produced it rather than a field a reader has to re-derive.
 */
export function assertCandidateAccountingEquation(
  emittedCandidates: number,
  counts: CandidateTerminalCounts,
): void {
  assertCount(emittedCandidates, 'emitted_candidates')
  const ordered = CANDIDATE_TERMINAL_STATES.map((state) => assertCount(counts[state], `terminal_counts.${state}`))
  const total = sumCounts(ordered, 'terminal_counts')
  if (total !== emittedCandidates) {
    throw new GraphIntegrityInvariantError(
      `candidate accounting mismatch: emitted ${emittedCandidates}, terminal states sum to ${total}`,
    )
  }
}

export interface IntegrityStatusInput {
  readonly counts: CandidateTerminalCounts
  readonly endpointReasonFactCounts: Readonly<Partial<Record<EndpointIdentityReason, number>>>
  readonly matrix: EndpointIdentityFactMatrix
  readonly recordsTruncated: boolean
  readonly legacyArtifact: boolean
}

export interface DerivedIntegrityStatus {
  readonly status: GraphIntegrityStatus
  readonly reasons: readonly ScopeIntegrityReason[]
}

/**
 * One owner for status. Deriving it ad hoc in several modules is how a graph
 * ends up simultaneously `valid` in a summary and `degraded` in its artifact,
 * and the issue's diagnostics contract forbids contradictory status sources.
 *
 * `incompatible` is intentionally not derivable here: it describes an artifact
 * a loader refused, not an accounting outcome, so only the loader may set it.
 */
export function deriveIntegrityStatus(input: IntegrityStatusInput): DerivedIntegrityStatus {
  const reasons = new Set<ScopeIntegrityReason>(['full_emission_accounting_not_available'])

  if (input.recordsTruncated) reasons.add('durable_records_truncated')
  if (input.legacyArtifact) reasons.add('legacy_artifact')

  // Endpoint degradation is inherited, not caused here, but it still bars
  // `valid`: a graph whose endpoint identities are unaudited is not fully
  // trustworthy merely because every candidate was accounted for.
  const endpointDegradation = endpointDegradationReasons(input.matrix, input.endpointReasonFactCounts)
  for (const reason of endpointDegradation) reasons.add(reason)

  const sorted = Object.freeze([...reasons].sort())

  if (input.counts.invariant_failed > 0) {
    return Object.freeze({ status: 'invalid' as const, reasons: sorted })
  }

  const degrading = input.counts.unresolved
    + input.counts.rejected
    + input.counts.conflicting
  if (degrading > 0 || input.recordsTruncated || input.legacyArtifact) {
    return Object.freeze({ status: 'degraded' as const, reasons: sorted })
  }

  if (endpointDegradation.length > 0) {
    // Every candidate terminated cleanly, but endpoint identity is still
    // qualified. `valid_with_warnings` is the honest ceiling until #704.
    return Object.freeze({ status: 'valid_with_warnings' as const, reasons: sorted })
  }

  return Object.freeze({ status: 'valid' as const, reasons: sorted })
}

function endpointDegradationReasons(
  matrix: EndpointIdentityFactMatrix,
  reasonFactCounts: Readonly<Partial<Record<EndpointIdentityReason, number>>>,
): readonly ScopeIntegrityReason[] {
  const present = new Set<ScopeIntegrityReason>()
  for (const sourceStatus of ENDPOINT_IDENTITY_STATUSES) {
    for (const targetStatus of ENDPOINT_IDENTITY_STATUSES) {
      const count = matrix[sourceStatus][targetStatus]
      if (count === 0) continue
      for (const status of [sourceStatus, targetStatus]) {
        if (status === 'context_bound') present.add('context_bound_endpoint_identity')
        if (status === 'unknown') present.add('unknown_endpoint_identity')
        if (status === 'legacy') present.add('legacy_endpoint_identity')
      }
    }
  }
  // A reason counter can carry degradation the matrix alone would not surface,
  // so both are consulted rather than trusting one.
  if ((reasonFactCounts.legacy_identity_policy ?? 0) > 0) present.add('legacy_endpoint_identity')
  return Object.freeze([...present].sort())
}

/**
 * The matrix is a partition over stored facts. Enforcing the sum here as well
 * as in the artifact layer means a candidate that never became a fact cannot be
 * smuggled into a cell to make a total look complete -- the sum would stop
 * matching immediately.
 */
export function assertEndpointMatrixPartition(
  matrix: EndpointIdentityFactMatrix,
  factsRetained: number,
): void {
  assertCount(factsRetained, 'facts_retained')
  const cells: number[] = []
  for (const sourceStatus of ENDPOINT_IDENTITY_STATUSES) {
    const row = matrix[sourceStatus]
    if (row === undefined) {
      throw new GraphIntegrityInvariantError(`endpoint matrix is missing row ${sourceStatus}`)
    }
    for (const targetStatus of ENDPOINT_IDENTITY_STATUSES) {
      cells.push(assertCount(row[targetStatus], `endpoint matrix cell ${sourceStatus}/${targetStatus}`))
    }
  }
  const total = sumCounts(cells, 'endpoint matrix')
  if (total !== factsRetained) {
    throw new GraphIntegrityInvariantError(
      `endpoint matrix partition sums to ${total}, expected ${factsRetained}`,
    )
  }
}

function sortedUniqueReasons(reasons: readonly TerminalIntegrityReason[], field: string): readonly TerminalIntegrityReason[] {
  for (const reason of reasons) {
    if (!isTerminalIntegrityReason(reason)) {
      throw new GraphIntegrityInvariantError(`${field} carries unknown reason ${JSON.stringify(reason)}`)
    }
  }
  if (reasons.length === 0) {
    throw new GraphIntegrityInvariantError(`${field} must name at least one reason`)
  }
  return Object.freeze([...new Set(reasons)].sort())
}

/**
 * Targets are sanitized through the same path rule that governs occurrence
 * identity, so a record can never carry an absolute path or a `..` escape into
 * a shared artifact. A target whose file cannot be made repository-relative is
 * dropped rather than emitted unsafely -- a missing hint is recoverable, a
 * leaked checkout path is not.
 */
export function normalizeVerificationTargets(
  targets: readonly IntegrityVerificationTarget[],
  field: string,
): readonly IntegrityVerificationTarget[] {
  const normalized: IntegrityVerificationTarget[] = []
  for (const target of targets) {
    if (!isTerminalIntegrityReason(target.reason)) {
      throw new GraphIntegrityInvariantError(`${field} target carries unknown reason ${JSON.stringify(target.reason)}`)
    }
    let file: string | null
    try {
      file = normalizeIdentityRepositoryPath(target.file, `${field}.file`)
    } catch {
      continue
    }
    if (file === null || file.length === 0) continue
    normalized.push(Object.freeze({
      file,
      ...(target.range !== undefined ? { range: target.range } : {}),
      reason: target.reason,
    }))
  }

  const byKey = new Map<string, IntegrityVerificationTarget>()
  for (const target of normalized) {
    byKey.set(serializeCanonicalJson(target as unknown as CanonicalJson, { arraySemantics: 'ordered' }), target)
  }
  return Object.freeze(
    [...byKey.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .slice(0, MAX_VERIFICATION_TARGETS_PER_RECORD)
      .map(([, target]) => target),
  )
}

export interface UnresolvedRecordDraft {
  readonly candidateFingerprint: string
  readonly multiplicity: number
  readonly source?: string
  readonly target?: string
  readonly relation?: string
  readonly occurrences?: readonly EvidenceOccurrence[]
  readonly reasons: readonly TerminalIntegrityReason[]
  readonly verificationTargets?: readonly IntegrityVerificationTarget[]
}

export interface RejectedRecordDraft {
  readonly candidateFingerprint: string
  readonly multiplicity: number
  readonly sanitizedCandidate: Readonly<Record<string, CanonicalJson>>
  readonly reasons: readonly TerminalIntegrityReason[]
  readonly verificationTargets?: readonly IntegrityVerificationTarget[]
}

export interface ConflictRecordDraft {
  readonly candidateFingerprints: readonly string[]
  readonly multiplicity: number
  readonly reasons: readonly TerminalIntegrityReason[]
  readonly verificationTargets?: readonly IntegrityVerificationTarget[]
}

function assertMultiplicity(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GraphIntegrityInvariantError(`${field} must be a positive safe integer`)
  }
  return value
}

/**
 * Record identity is content-derived and operation-scoped, mirroring
 * `SemanticIdentityFactory`.
 *
 * Operation-scoped rather than module-global for the reason #657 already
 * learned the hard way: a process-global witness map retained a payload copy
 * for every record ever derived, and under `serve` and `watch` that grew
 * without bound.
 *
 * Identical repeated candidates collapse onto one id and raise `multiplicity`.
 * They deliberately do not receive sequence ids -- a nondeterministic
 * discriminator would make two identical runs produce different artifacts,
 * which is exactly the determinism the receipt exists to support.
 */
export class CandidateRecordIdentityFactory {
  private readonly payloadByDigest = new Map<string, Buffer>()

  constructor(private readonly hash: (payload: Buffer) => string = sha256) {}

  /** Distinct payloads witnessed by this scope. A fresh operation starts at zero. */
  get witnessCount(): number {
    return this.payloadByDigest.size
  }

  private contentAddress(prefix: 'uc_' | 'rc_' | 'cc_', payload: Buffer): string {
    const digest = this.hash(payload)
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new GraphIntegrityInvariantError('hash function must return full lowercase SHA-256 hex')
    }
    const identity = `${prefix}${digest}`
    const existing = this.payloadByDigest.get(digest)
    if (existing !== undefined && !existing.equals(payload)) {
      throw new DurableRecordCollisionError(identity)
    }
    if (existing === undefined) {
      this.payloadByDigest.set(digest, Buffer.from(payload))
    }
    return identity
  }

  createUnresolvedRecord(draft: UnresolvedRecordDraft): UnresolvedCandidateRecord {
    const reasons = sortedUniqueReasons(draft.reasons, 'unresolved record reasons')
    const targets = normalizeVerificationTargets(draft.verificationTargets ?? [], 'unresolved record')
    const occurrences = Object.freeze(
      [...(draft.occurrences ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
    )
    const identityPayload = {
      record_kind: 'unresolved',
      reason_vocabulary_version: GRAPH_INTEGRITY_REASON_VOCABULARY_VERSION,
      candidate_fingerprint: draft.candidateFingerprint,
      ...(draft.source !== undefined ? { source: draft.source } : {}),
      ...(draft.target !== undefined ? { target: draft.target } : {}),
      ...(draft.relation !== undefined ? { relation: draft.relation } : {}),
      reasons: orderedCanonicalArray(reasons),
    }
    const id = this.contentAddress('uc_', canonicalJsonBytes(identityPayload))
    return Object.freeze({
      kind: 'unresolved' as const,
      id,
      candidateFingerprint: draft.candidateFingerprint,
      multiplicity: assertMultiplicity(draft.multiplicity, 'unresolved record multiplicity'),
      ...(draft.source !== undefined ? { source: draft.source } : {}),
      ...(draft.target !== undefined ? { target: draft.target } : {}),
      ...(draft.relation !== undefined ? { relation: draft.relation } : {}),
      occurrences,
      reasons,
      verificationTargets: targets,
    })
  }

  createRejectedRecord(draft: RejectedRecordDraft): RejectedCandidateRecord {
    const reasons = sortedUniqueReasons(draft.reasons, 'rejected record reasons')
    const targets = normalizeVerificationTargets(draft.verificationTargets ?? [], 'rejected record')
    const identityPayload = {
      record_kind: 'rejected',
      reason_vocabulary_version: GRAPH_INTEGRITY_REASON_VOCABULARY_VERSION,
      candidate_fingerprint: draft.candidateFingerprint,
      sanitized_candidate: draft.sanitizedCandidate,
      reasons: orderedCanonicalArray(reasons),
    }
    const id = this.contentAddress('rc_', canonicalJsonBytes(identityPayload))
    return Object.freeze({
      kind: 'rejected' as const,
      id,
      candidateFingerprint: draft.candidateFingerprint,
      multiplicity: assertMultiplicity(draft.multiplicity, 'rejected record multiplicity'),
      sanitizedCandidate: draft.sanitizedCandidate,
      reasons,
      verificationTargets: targets,
    })
  }

  createConflictRecord(draft: ConflictRecordDraft): CandidateConflictRecord {
    if (draft.candidateFingerprints.length < 2) {
      throw new GraphIntegrityInvariantError('a conflict record must name at least two candidates')
    }
    const reasons = sortedUniqueReasons(draft.reasons, 'conflict record reasons')
    const targets = normalizeVerificationTargets(draft.verificationTargets ?? [], 'conflict record')
    // Sorted, so the group's identity cannot depend on which member arrived
    // first. Order-dependence here would be last-write-wins wearing a record.
    const fingerprints = Object.freeze([...new Set(draft.candidateFingerprints)].sort())
    const identityPayload = {
      record_kind: 'conflicting',
      reason_vocabulary_version: GRAPH_INTEGRITY_REASON_VOCABULARY_VERSION,
      candidate_fingerprints: orderedCanonicalArray(fingerprints),
      reasons: orderedCanonicalArray(reasons),
    }
    const id = this.contentAddress('cc_', canonicalJsonBytes(identityPayload))
    return Object.freeze({
      kind: 'conflicting' as const,
      id,
      candidateFingerprints: fingerprints,
      multiplicity: assertMultiplicity(draft.multiplicity, 'conflict record multiplicity'),
      reasons,
      verificationTargets: targets,
    })
  }
}

function sha256(payload: Buffer): string {
  return createHash('sha256').update(payload).digest('hex')
}

/**
 * Deterministic record ordering, applied at every boundary that emits records.
 * Sorting by id rather than by insertion means two runs over the same input
 * serialize identically even if the pipeline visits candidates in a different
 * order.
 */
export function sortDurableRecords<T extends DurableCandidateRecord>(records: readonly T[]): readonly T[] {
  return Object.freeze([...records].sort((left, right) => left.id.localeCompare(right.id)))
}

/**
 * Applies the retention bound and reports exactly what was kept. Truncation
 * takes the lowest ids so the retained set is deterministic rather than
 * whichever records happened to be produced first.
 */
export function boundDurableRecords<T extends DurableCandidateRecord>(
  records: readonly T[],
  maxRecords: number = MAX_DURABLE_RECORDS_PER_KIND,
): { readonly records: readonly T[]; readonly retention: DurableRecordRetention } {
  const sorted = sortDurableRecords(records)
  const retained = sorted.slice(0, maxRecords)
  return Object.freeze({
    records: Object.freeze(retained) as readonly T[],
    retention: Object.freeze({ retained: retained.length, total: sorted.length }),
  })
}
