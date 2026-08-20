import { posix as pathPosix, win32 as pathWin32 } from 'node:path'
import { createHash } from 'node:crypto'

import { canonicalJsonBytes, orderedCanonicalArray, serializeCanonicalJson } from './canonical-json.js'
import { ENDPOINT_IDENTITY_STATUSES, type EndpointIdentityReason, type EndpointIdentityStatus } from './endpoint-identity.js'
import { SemanticIdentityInvariantError, normalizeIdentityRepositoryPath } from './semantic-identity.js'
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
  'partial_discriminator_retained',
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

/**
 * Bounds for the string fields a record carries into the artifact.
 *
 * Split by field because they carry different things. A node id is a semantic
 * identifier the graph contract already governs, so it is preserved as-is up to
 * a length bound and only refused when it is path-shaped or unprintable -- and
 * unlike a diagnostic hint it may legitimately carry non-ASCII, so an
 * ASCII-only rule applied uniformly would corrupt real identifiers. A relation
 * is a vocabulary token. Neither may smuggle a path.
 */
export const MAX_ENDPOINT_ID_LENGTH = 512 as const
export const MAX_RELATION_LENGTH = 128 as const

/** Occurrences carried on one unresolved record. */
export const MAX_RECORD_OCCURRENCES = 16 as const

/** Member fingerprints carried on one conflict record. */
export const MAX_CONFLICT_FINGERPRINTS = 32 as const

/** Scope failures carried in one accounting result. */
export const MAX_SCOPE_FAILURES = 256 as const

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
  /** Exact accounting for `occurrences`, which is capped. */
  readonly occurrenceRetention: DetailRetention
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
  /** Exact accounting for `candidateFingerprints`, which is capped. */
  readonly fingerprintRetention: DetailRetention
  /**
   * Digest over the COMPLETE canonical fingerprint set.
   *
   * Present whenever the retained list is partial, so a reader can still tell
   * two conflict groups apart and verify membership without the truncated list
   * pretending to be the whole group.
   */
  readonly fingerprintSetDigest: string
}

export type DurableCandidateRecord =
  | UnresolvedCandidateRecord
  | RejectedCandidateRecord
  | CandidateConflictRecord

/**
 * Exact accounting for a capped detail array.
 *
 * `omitted` is carried rather than left to be derived so a reader cannot
 * mistake a retained sample for the whole set, and `truncated` states the fact
 * outright instead of requiring a comparison.
 */
export interface DetailRetention {
  readonly retained: number
  readonly total: number
  readonly omitted: number
  readonly truncated: boolean
}

export function detailRetention(retained: number, total: number): DetailRetention {
  if (!Number.isSafeInteger(retained) || retained < 0 || !Number.isSafeInteger(total) || total < retained) {
    throw new GraphIntegrityInvariantError(`detail retention ${retained}/${total} is not a valid bound`)
  }
  return Object.freeze({ retained, total, omitted: total - retained, truncated: retained < total })
}

/**
 * Validates a retention object that arrived from somewhere else.
 *
 * `detailRetention` guarantees consistency for values it builds, but a
 * finalized snapshot can be handed a retention object that was tampered with or
 * assembled by hand. Every derived field is re-derived and compared rather than
 * trusted, because `omitted` and `truncated` are exactly the fields a caller
 * would edit to make omission look like completeness.
 */
/**
 * Rejects anything that is not a plain, JSON-shaped object.
 *
 * A snapshot is the trust boundary for future serialized bytes, and a static
 * TypeScript type is not evidence there: a decoded artifact, a hand-built
 * record, or a class instance all arrive as objects that satisfy the type.
 * Accessors are refused because a getter can return one value to the validator
 * and another to the serializer, and symbol keys because they vanish silently
 * through JSON while remaining visible to code that reads the object.
 */
export function assertPlainJsonObject(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GraphIntegrityInvariantError(`${field} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new GraphIntegrityInvariantError(`${field} must be a plain object, not a class instance`)
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new GraphIntegrityInvariantError(`${field} must not carry symbol keys`)
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      throw new GraphIntegrityInvariantError(`${field}.${key} must be a data property, not an accessor`)
    }
  }
}

/**
 * Requires an object to carry exactly the keys its schema declares.
 *
 * Closed rather than open because an unknown field is not harmless: the review
 * attached a five-field retention object whose extra field carried a private
 * path. Every value that reaches a serializer must have been validated, and a
 * field nobody declared is a field nobody validated.
 */
export function assertExactObjectShape(
  value: unknown,
  field: string,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  assertPlainJsonObject(value, field)
  const allowed = new Set([...required, ...optional])
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) {
      throw new GraphIntegrityInvariantError(`${field} carries unknown field ${JSON.stringify(key)}`)
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new GraphIntegrityInvariantError(`${field} is missing required field ${JSON.stringify(key)}`)
    }
  }
}

export const DETAIL_RETENTION_KEYS = ['retained', 'total', 'omitted', 'truncated'] as const

export function assertDetailRetention(retention: DetailRetention, field: string): void {
  // Exactly four fields, no more. A missing or non-object retention fails as a
  // typed graph invariant rather than as a TypeError from the first property
  // read, and a fifth field is refused outright rather than quietly dropped --
  // copying only the four known fields out of a five-field input would let the
  // fifth reach whatever built it while the snapshot claimed it was validated.
  assertExactObjectShape(retention, field, DETAIL_RETENTION_KEYS)
  if (typeof retention.truncated !== 'boolean') {
    throw new GraphIntegrityInvariantError(`${field}.truncated must be a boolean`)
  }
  for (const [name, value] of [
    ['retained', retention.retained],
    ['total', retention.total],
    ['omitted', retention.omitted],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new GraphIntegrityInvariantError(`${field}.${name} must be a non-negative safe integer`)
    }
  }
  if (retention.retained > retention.total) {
    throw new GraphIntegrityInvariantError(
      `${field} retained ${retention.retained} exceeds total ${retention.total}`,
    )
  }
  if (retention.omitted !== retention.total - retention.retained) {
    throw new GraphIntegrityInvariantError(
      `${field}.omitted is ${retention.omitted} but total - retained is ${retention.total - retention.retained}`,
    )
  }
  if (retention.truncated !== retention.omitted > 0) {
    throw new GraphIntegrityInvariantError(
      `${field}.truncated is ${String(retention.truncated)} with ${retention.omitted} omitted`,
    )
  }
}

/**
 * Validates every retention object a durable record carries, plus agreement
 * between the carried array length and its own retained count.
 */
export function assertRecordRetention(record: DurableCandidateRecord, field: string): void {
  if (record.kind === 'unresolved') {
    assertDetailRetention(record.occurrenceRetention, `${field}.occurrenceRetention`)
    if (record.occurrences.length !== record.occurrenceRetention.retained) {
      throw new GraphIntegrityInvariantError(
        `${field} carries ${record.occurrences.length} occurrences but claims ${record.occurrenceRetention.retained}`,
      )
    }
  }
  if (record.kind === 'conflicting') {
    assertDetailRetention(record.fingerprintRetention, `${field}.fingerprintRetention`)
    if (record.candidateFingerprints.length !== record.fingerprintRetention.retained) {
      throw new GraphIntegrityInvariantError(
        `${field} carries ${record.candidateFingerprints.length} fingerprints but claims ${record.fingerprintRetention.retained}`,
      )
    }
  }
}

/**
 * Bounds a detail array deterministically and reports what it dropped.
 *
 * Selection is by canonical key order, never arrival, for the same reason the
 * record cap is: a retained sample that changes with input order cannot be
 * serialized as a stable contract.
 */
export function boundDetail<T>(
  values: readonly T[],
  limit: number,
  key: (value: T) => string,
): { readonly values: readonly T[]; readonly retention: DetailRetention } {
  const unique = new Map<string, T>()
  for (const value of values) unique.set(key(value), value)
  const ordered = [...unique.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, value]) => value)
  const retained = ordered.slice(0, limit)
  return Object.freeze({
    values: Object.freeze(retained),
    retention: detailRetention(retained.length, ordered.length),
  })
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
    readonly unresolved: DetailRetention
    readonly rejected: DetailRetention
    readonly conflicting: DetailRetention
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
  /**
   * Candidates retained despite an incomplete discriminator.
   *
   * `partial_discriminator` is the only terminal reason that attaches to a
   * candidate which *was* retained -- every other reason implies unresolved,
   * rejected, conflicting or invariant_failed, and is therefore already visible
   * through the counters. Without this input a run could retain every candidate
   * on partial discriminators and still derive `valid`, which is exactly the
   * kind of flattering silence this receipt exists to prevent.
   */
  readonly retainedPartialDiscriminators: number
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
  if (input.retainedPartialDiscriminators > 0) reasons.add('partial_discriminator_retained')

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

  if (endpointDegradation.length > 0 || input.retainedPartialDiscriminators > 0) {
    // Every candidate terminated cleanly, but something about the retained
    // facts is still qualified -- an unaudited endpoint identity, or a
    // discriminator the registry could only fill in partially.
    // `valid_with_warnings` is the honest ceiling until #704 and a registry
    // that can reach `full`.
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

/**
 * Share-safety context for one accounting run.
 *
 * Only a build that genuinely knows the checkout root may supply one.
 * Compatibility loading, copy/subgraph, federation without a truthful root and
 * direct construction must not invent one -- a wrong root would either redact
 * legitimate identifiers or, worse, fail to redact real ones.
 */
export interface ShareSafetyContext {
  readonly repositoryRoot?: string
}

/**
 * The repository root as an extractor flattens it into an identifier.
 *
 * Some producers build a node id from a whole absolute path rather than a
 * basename, so `/Users/someone/Desktop/proj` arrives as
 * `users_someone_desktop_proj`. That form carries a home directory and a
 * username but contains no slash, drive prefix, scheme, tilde or control
 * character, so every ordinary path check passes it. It is only detectable by
 * comparing against the actual root.
 */
export function flattenedRootPrefix(repositoryRoot: string): string | null {
  const trimmed = repositoryRoot.trim()
  if (trimmed.length === 0) return null
  const flattened = trimmed
    .replace(/^[A-Za-z]:/, (drive) => drive.slice(0, 1))
    .replace(/^[/\\]+/, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  return flattened.length === 0 ? null : flattened
}

/**
 * True when a value is the flattened root, or begins with it at a segment
 * boundary.
 *
 * Anchored at a boundary rather than a bare `includes` so an unrelated
 * identifier that merely shares a leading substring is not redacted. Compared
 * case-insensitively because a Windows checkout can differ only in case.
 */
export function isRootDerivedIdentifier(value: string, flattenedRoot: string | null): boolean {
  if (flattenedRoot === null || flattenedRoot.length === 0) return false
  const lower = value.toLowerCase()
  if (lower === flattenedRoot) return true
  return lower.startsWith(`${flattenedRoot}_`)
}

/**
 * A semantic node identifier, bounded and refused when path-shaped.
 *
 * Node ids may legitimately contain non-ASCII, so unlike a diagnostic hint they
 * are not held to an ASCII-only rule -- doing so would corrupt real
 * identifiers. Control characters and path shapes are still refused, because
 * neither can be a legitimate identifier and both are how a checkout path would
 * reach a shared artifact.
 */
/**
 * Unicode characters that render as a path separator without being one.
 *
 * An explicit reviewed set rather than NFKC folding: NFKC would rewrite the
 * identifier into a different identifier, and a semantic node id must survive
 * sanitization unchanged or not at all. Each of these has been used to disguise
 * a path from a check that only knows `/` and `\`.
 */
const SEPARATOR_LOOKALIKES = /[\u2044\u2215\u29f8\uff0f\uff3c\ufe68\u2216\u01c0\u2571\u2572]/

/** Percent-encoded byte escapes, which can hide a separator. */
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/

/** Traversal-only values, which name a directory rather than an entity. */
const TRAVERSAL_ONLY = /^\.{1,2}$/

export function safeEndpointIdentifier(
  value: string | undefined,
  field: string,
  flattenedRoot: string | null = null,
): string | undefined {
  if (value === undefined) return undefined
  // NFC first so length and every predicate below judge one canonical form.
  // Canonical JSON already normalizes identity this way, so this keeps the
  // projection and the identity payload agreeing.
  const normalized = value.normalize('NFC')
  if (normalized.length === 0 || normalized.length > MAX_ENDPOINT_ID_LENGTH) return undefined
  // A flattened checkout path is a real identifier to the graph and a privacy
  // leak in a shared artifact, so it is omitted from the diagnostic projection
  // while remaining part of record identity.
  if (isRootDerivedIdentifier(normalized, flattenedRoot)) return undefined
  // C0 and C1 controls, including NUL.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(normalized)) return undefined
  if (PERCENT_ESCAPE.test(normalized)) return undefined
  if (SEPARATOR_LOOKALIKES.test(normalized)) return undefined
  if (TRAVERSAL_ONLY.test(normalized)) return undefined
  if (/[/\\]|^[A-Za-z]:|^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalized)) return undefined
  if (normalized.startsWith('~')) return undefined
  void field
  return normalized
}

/** A relation vocabulary token: shorter bound, same refusals. */
export function safeRelationToken(
  value: string | undefined,
  field: string,
  flattenedRoot: string | null = null,
): string | undefined {
  if (value === undefined) return undefined
  if (value.length === 0 || value.length > MAX_RELATION_LENGTH) return undefined
  return safeEndpointIdentifier(value, field, flattenedRoot)
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

/** Longest verification target retained. Reviewed limit; no repo-wide one exists. */
export const MAX_VERIFICATION_TARGET_LENGTH = 512 as const

/**
 * Scheme-like prefixes, including the forms without `//`.
 *
 * `file:relative-looking` and `mailto:user@example.com` are not paths and were
 * previously accepted because the check only looked for `scheme://`.
 */
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/

/**
 * True parent traversal, tested per segment.
 *
 * A `startsWith('..')` test conflates traversal with an ordinary directory whose
 * name merely begins with two dots: `..fixtures/a.ts` is a legitimate in-root
 * path and was being discarded as an escape.
 */
function hasParentSegment(segments: readonly string[]): boolean {
  return segments.includes('..')
}

/**
 * The one owner of verification-target safety.
 *
 * Deliberately separate from the candidate-hint and endpoint sanitizers: a
 * target is a repository-relative PATH that a reader will open, so it needs
 * path semantics, its own length bound, and rejection of scheme forms that are
 * meaningless as paths. Reusing a hint sanitizer here is what let thirteen
 * unsafe shapes through -- the identity path-normalizer was never a
 * share-safety policy.
 *
 * Returns null rather than throwing: a missing hint is recoverable, and a
 * target is never load-bearing for accounting.
 */
export function normalizeVerificationTargetPath(
  value: string,
  context: { readonly repositoryRoot?: string; readonly field: string },
): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFC')
  if (normalized.length === 0 || normalized.length > MAX_VERIFICATION_TARGET_LENGTH) return null
  // C0 and C1 controls, including NUL, newline and tab.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(normalized)) return null
  if (/%[0-9A-Fa-f]{2}/.test(normalized)) return null
  if (SEPARATOR_LOOKALIKES.test(normalized)) return null
  if (normalized.startsWith('~')) return null

  // Flavour is decided before separators are folded, because folding `\\` to `/`
  // turns a UNC path into something indistinguishable from a POSIX one.
  let candidate: string
  if (isAbsoluteLikePath(normalized)) {
    // Absolute, drive and UNC forms are only acceptable after conversion against
    // a truthful root; without one they are refused rather than guessed at.
    const relative = repositoryRelativeUnder(normalized, context.repositoryRoot)
    if (relative === null) return null
    candidate = relative
  } else {
    const separatorsNormalized = normalized.replaceAll('\\', '/')
    // A scheme form that is not an absolute path is not a repository path.
    // `C:relative\path` is drive-relative and lands here too, which is correct:
    // it names no root we can prove containment against.
    if (SCHEME_PREFIX.test(separatorsNormalized)) return null
    candidate = separatorsNormalized
  }

  const segments = candidate.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.length === 0) return null
  if (hasParentSegment(segments)) return null
  const joined = segments.join('/')
  if (joined.length === 0 || joined.length > MAX_VERIFICATION_TARGET_LENGTH) return null
  void context.field
  return joined
}

/**
 * Repository-relative form of an absolute path, or null when it is outside the
 * root or no truthful root exists.
 *
 * Compared on normalized separators and segment boundaries so a sibling
 * directory sharing a name prefix is not treated as inside the repository.
 */
type AbsolutePathFlavour = 'win32' | 'posix'

/**
 * Containment is a filesystem question, not a string question.
 *
 * `C:\\repo2` shares a textual prefix with `C:\\repo` but is not inside it, and
 * `c:\\REPO` is the same directory as `C:\\repo` on a Windows volume. Prefix
 * matching gets both wrong in opposite directions, so each root is matched with
 * the semantics of its own platform.
 */
function pathFlavour(value: string): AbsolutePathFlavour {
  if (/^[A-Za-z]:[\\/]/.test(value)) return 'win32'
  // Two leading separators followed by a host: a UNC share.
  if (/^[\\/]{2}[^\\/]/.test(value)) return 'win32'
  return 'posix'
}

function isAbsoluteLikePath(value: string): boolean {
  return value.startsWith('/')
    || value.startsWith('\\')
    || /^[A-Za-z]:[\\/]/.test(value)
}

/**
 * Converts an absolute path into a repository-relative target, or refuses.
 *
 * An absolute path is only ever converted against a truthful matching root:
 * a different drive or share, a path outside the root, and a root-prefix
 * look-alike all refuse rather than convert. Refusing every absolute Windows
 * and UNC input instead would leave legitimate Windows repositories with no
 * verification targets at all, so containment is proven rather than assumed.
 *
 * Case: Windows and UNC volumes are case-insensitive, so containment is matched
 * case-insensitively there and case-sensitively under POSIX. The emitted target
 * keeps the source's own casing rather than the root's.
 */
function repositoryRelativeUnder(absolutePath: string, repositoryRoot?: string): string | null {
  if (repositoryRoot === undefined || repositoryRoot.trim().length === 0) return null
  const root = repositoryRoot.trim()
  const flavour = pathFlavour(root)
  // A Windows path under a POSIX root -- or the reverse -- is not containment.
  if (pathFlavour(absolutePath) !== flavour) return null

  const platform = flavour === 'win32' ? pathWin32 : pathPosix
  if (!platform.isAbsolute(root) || !platform.isAbsolute(absolutePath)) return null

  const relative = platform.relative(root, absolutePath)
  // Empty means the path IS the root; absolute means a different drive or
  // share; a `..` segment means it escapes the root.
  if (relative.length === 0) return null
  if (platform.isAbsolute(relative)) return null
  const segments = relative.split(/[\\/]/)
  if (segments.includes('..')) return null

  const joined = segments.filter((segment) => segment.length > 0 && segment !== '.').join('/')
  return joined.length === 0 ? null : joined
}

/**
 * Normalizes, bounds, de-duplicates and orders a record's verification targets.
 *
 * Every production target flows through here, so a caller cannot push a raw
 * string and rely on serialization to clean it later.
 */
export function normalizeVerificationTargets(
  targets: readonly IntegrityVerificationTarget[],
  field: string,
  context: { readonly repositoryRoot?: string } = {},
): readonly IntegrityVerificationTarget[] {
  const byKey = new Map<string, IntegrityVerificationTarget>()
  for (const target of targets) {
    if (!isTerminalIntegrityReason(target.reason)) {
      throw new GraphIntegrityInvariantError(`${field} target carries unknown reason ${JSON.stringify(target.reason)}`)
    }
    const file = normalizeVerificationTargetPath(target.file, {
      ...(context.repositoryRoot !== undefined ? { repositoryRoot: context.repositoryRoot } : {}),
      field,
    })
    if (file === null) continue
    const safe: IntegrityVerificationTarget = Object.freeze({
      file,
      ...(target.range !== undefined ? { range: target.range } : {}),
      reason: target.reason,
    })
    byKey.set(serializeCanonicalJson(safe as unknown as CanonicalJson, { arraySemantics: 'ordered' }), safe)
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
  private readonly flattenedRoot: string | null
  private readonly repositoryRoot: string | undefined

  constructor(
    private readonly hash: (payload: Buffer) => string = sha256,
    shareSafety: ShareSafetyContext = {},
  ) {
    this.repositoryRoot = shareSafety.repositoryRoot
    this.flattenedRoot = shareSafety.repositoryRoot === undefined
      ? null
      : flattenedRootPrefix(shareSafety.repositoryRoot)
  }

  /**
   * The flattened checkout prefix, so a later boundary can apply the same
   * root-derived check this factory applied at construction rather than
   * inventing a second notion of what counts as root-derived.
   */
  get shareSafeFlattenedRoot(): string | null {
    return this.flattenedRoot
  }

  /** Root context for the verification-target policy, or none when untruthful. */
  private get targetContext(): { readonly repositoryRoot?: string } {
    return this.repositoryRoot === undefined ? {} : { repositoryRoot: this.repositoryRoot }
  }

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
    const targets = normalizeVerificationTargets(draft.verificationTargets ?? [], 'unresolved record', this.targetContext)
    const bounded = boundDetail(draft.occurrences ?? [], MAX_RECORD_OCCURRENCES, (occurrence) => occurrence.id)
    const occurrences = bounded.values
    // Redaction applies to the DISPLAYED hint only. Identity below still keys on
    // the original endpoints, so omitting an unsafe hint cannot collapse two
    // distinct candidates onto one record.
    const source = safeEndpointIdentifier(draft.source, 'unresolved record source', this.flattenedRoot)
    const target = safeEndpointIdentifier(draft.target, 'unresolved record target', this.flattenedRoot)
    const relation = safeRelationToken(draft.relation, 'unresolved record relation', this.flattenedRoot)
    const identityPayload = {
      record_kind: 'unresolved',
      reason_vocabulary_version: GRAPH_INTEGRITY_REASON_VOCABULARY_VERSION,
      candidate_fingerprint: draft.candidateFingerprint,
      // The original values, not the redacted projection: two candidates that
      // differ only in a redacted endpoint must still get distinct ids.
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
      ...(source !== undefined ? { source } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(relation !== undefined ? { relation } : {}),
      occurrences,
      occurrenceRetention: bounded.retention,
      reasons,
      verificationTargets: targets,
    })
  }

  createRejectedRecord(draft: RejectedRecordDraft): RejectedCandidateRecord {
    const reasons = sortedUniqueReasons(draft.reasons, 'rejected record reasons')
    const targets = normalizeVerificationTargets(draft.verificationTargets ?? [], 'rejected record', this.targetContext)
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
    const targets = normalizeVerificationTargets(draft.verificationTargets ?? [], 'conflict record', this.targetContext)
    // Sorted, so the group's identity cannot depend on which member arrived
    // first. Order-dependence here would be last-write-wins wearing a record.
    const complete = Object.freeze([...new Set(draft.candidateFingerprints)].sort())
    // The digest covers the COMPLETE set, so identity and membership survive
    // even when the carried list is capped.
    const fingerprintSetDigest = `cs_${sha256(canonicalJsonBytes({
      candidate_fingerprints: orderedCanonicalArray(complete),
    }))}`
    const bounded = boundDetail(complete, MAX_CONFLICT_FINGERPRINTS, (value) => value)
    const identityPayload = {
      record_kind: 'conflicting',
      reason_vocabulary_version: GRAPH_INTEGRITY_REASON_VOCABULARY_VERSION,
      // Identity keys on the digest of the whole set rather than the retained
      // slice, so capping cannot merge two distinct conflict groups.
      candidate_fingerprint_set: fingerprintSetDigest,
      reasons: orderedCanonicalArray(reasons),
    }
    const id = this.contentAddress('cc_', canonicalJsonBytes(identityPayload))
    return Object.freeze({
      kind: 'conflicting' as const,
      id,
      candidateFingerprints: bounded.values,
      fingerprintRetention: bounded.retention,
      fingerprintSetDigest,
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
 * Applies a final multiplicity without touching anything identity-bearing.
 *
 * Finalization previously rebuilt records through the factory, which assumes it
 * is given the COMPLETE raw detail. Feeding it an already-bounded record made it
 * re-bound the bound -- occurrence retention came back as 16 of 16 instead of 16
 * of 50 -- and recompute the conflict full-set digest from the retained 32
 * fingerprints instead of the real 40, which moved the record id and threw.
 *
 * Multiplicity is not part of record identity, so it can simply be replaced.
 */
export function withMultiplicityPreservingIdentity<T extends DurableCandidateRecord>(
  record: T,
  multiplicity: number,
): T {
  if (!Number.isSafeInteger(multiplicity) || multiplicity < 1) {
    throw new GraphIntegrityInvariantError(`multiplicity ${multiplicity} must be a positive safe integer`)
  }
  return Object.freeze({ ...record, multiplicity }) as unknown as T
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
): { readonly records: readonly T[]; readonly retention: DetailRetention } {
  const sorted = sortDurableRecords(records)
  const retained = sorted.slice(0, maxRecords)
  return Object.freeze({
    records: Object.freeze(retained) as readonly T[],
    retention: detailRetention(retained.length, sorted.length),
  })
}
