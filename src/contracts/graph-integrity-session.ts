import { createHash } from 'node:crypto'

import { canonicalJsonBytes, serializeCanonicalJson } from './canonical-json.js'
import {
  CandidateRecordIdentityFactory,
  GraphIntegrityInvariantError,
  MAX_DURABLE_RECORDS_PER_KIND,
  emptyTerminalCounts,
  normalizeVerificationTargets,
  type CandidateConflictRecord,
  type CandidateTerminalCounts,
  type CandidateTerminalState,
  type DurableRecordRetention,
  type IntegrityVerificationTarget,
  type RejectedCandidateRecord,
  type TerminalIntegrityReason,
  type UnresolvedCandidateRecord,
} from './graph-integrity.js'
import { normalizeIdentityRepositoryPath } from './semantic-identity.js'
import type { CanonicalJson } from './canonical-json.js'
import type { EvidenceOccurrence } from './semantic-graph.js'

/**
 * The single owner of normalized candidate accounting for one generation.
 *
 * Exactly one of these exists per `buildFromJson` call. It owns admission,
 * disposition, record creation, counters, and finalization, so no other module
 * increments an overlapping counter -- the failure mode where `build.ts`,
 * `graph.ts`, `generate.ts` and `export.ts` each maintain a partial view and
 * none of them agrees.
 *
 * A candidate is disposed exactly once. Disposing twice, or finalizing twice,
 * is a typed invariant failure rather than a silently accepted double count.
 */

/** Attributes safe to keep on a rejected record: primitives only, no paths. */
const SANITIZED_CANDIDATE_KEYS = Object.freeze([
  'relation',
  'confidence',
  'layer',
  'kind',
  'phase',
  'binding_kind',
  'http_method',
] as const)

export interface CandidateIdentityInput {
  readonly index: number
  readonly source?: unknown
  readonly target?: unknown
  readonly relation?: unknown
}

export interface UnresolvedDisposition {
  readonly state: 'unresolved'
  readonly reasons: readonly TerminalIntegrityReason[]
  readonly source?: string
  readonly target?: string
  readonly relation?: string
  readonly occurrences?: readonly EvidenceOccurrence[]
  readonly verificationTargets?: readonly IntegrityVerificationTarget[]
}

export interface RejectedDisposition {
  readonly state: 'rejected'
  readonly reasons: readonly TerminalIntegrityReason[]
  readonly candidate?: unknown
  readonly verificationTargets?: readonly IntegrityVerificationTarget[]
}

export interface ConflictingDisposition {
  readonly state: 'conflicting'
  readonly reasons: readonly TerminalIntegrityReason[]
  readonly groupFingerprints: readonly string[]
  readonly verificationTargets?: readonly IntegrityVerificationTarget[]
}

export interface RetainedDisposition {
  readonly state: 'retained_new_fact' | 'retained_additional_occurrence' | 'deliberately_merged_duplicate'
  readonly reasons?: readonly TerminalIntegrityReason[]
}

export interface InvariantFailedDisposition {
  readonly state: 'invariant_failed'
  readonly reasons: readonly TerminalIntegrityReason[]
  readonly candidate?: unknown
}

export type CandidateDisposition =
  | RetainedDisposition
  | UnresolvedDisposition
  | RejectedDisposition
  | ConflictingDisposition
  | InvariantFailedDisposition

export interface NormalizedAccountingResult {
  readonly emittedCandidates: number
  readonly counts: CandidateTerminalCounts
  readonly terminalReasonCounts: Readonly<Partial<Record<TerminalIntegrityReason, number>>>
  readonly unresolvedRecords: readonly UnresolvedCandidateRecord[]
  readonly rejectedRecords: readonly RejectedCandidateRecord[]
  readonly conflictRecords: readonly CandidateConflictRecord[]
  readonly unresolvedRetention: DurableRecordRetention
  readonly rejectedRetention: DurableRecordRetention
  readonly conflictingRetention: DurableRecordRetention
  readonly retainedPartialDiscriminators: number
  /** File- or adapter-scope failures that emitted no candidate. Not in the equation. */
  readonly scopeFailures: readonly string[]
}

function sha256Hex(payload: Buffer): string {
  return createHash('sha256').update(payload).digest('hex')
}

/**
 * A candidate's identity for grouping purposes.
 *
 * Content-derived from the endpoints and relation as presented, plus the entry
 * index only when the triple is unusable -- two malformed entries that carry no
 * usable endpoints are genuinely different candidates and must not collapse
 * onto one record and be undercounted.
 */
export function candidateFingerprint(input: CandidateIdentityInput): string {
  const source = typeof input.source === 'string' ? input.source : null
  const target = typeof input.target === 'string' ? input.target : null
  const relation = typeof input.relation === 'string' ? input.relation : null
  const identifiable = source !== null || target !== null || relation !== null
  const payload = {
    source,
    target,
    relation,
    ...(identifiable ? {} : { unidentifiable_entry_index: input.index }),
  }
  return `cf_${sha256Hex(canonicalJsonBytes(payload))}`
}

/**
 * Reduces a candidate to a share-safe projection.
 *
 * Allowlisted primitive keys only. A rejected candidate is the one record class
 * built from input we have already judged malformed, so copying it wholesale
 * would be the most direct route for an absolute path or arbitrary adapter
 * metadata to reach a shared artifact.
 */
export function sanitizeCandidate(candidate: unknown): Readonly<Record<string, CanonicalJson>> {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return Object.freeze({})
  }
  const record = candidate as Record<string, unknown>
  const sanitized: Record<string, CanonicalJson> = {}
  for (const key of SANITIZED_CANDIDATE_KEYS) {
    const value = record[key]
    if (typeof value === 'string') {
      const safe = safeCandidateString(value, key)
      if (safe !== null) sanitized[key] = safe
      continue
    }
    if (typeof value === 'number' && Number.isFinite(value)) sanitized[key] = value
    if (typeof value === 'boolean') sanitized[key] = value
  }
  return Object.freeze(sanitized)
}

/**
 * Anything path-shaped on any platform. A previous version tested only for a
 * forward slash, which let a Windows absolute path (`C:\\Users\\me\\x.ts`) and a
 * UNC path (`\\\\server\\share`) past the check entirely and into a shared record.
 * The path normalizer itself handles both correctly; the shortcut was what
 * bypassed it.
 */
const PATH_SHAPED = /[/\\]|^[A-Za-z]:|^[A-Za-z][A-Za-z0-9+.-]*:/

/**
 * Longest string kept on a rejected record.
 *
 * Rejected candidates are built from input already judged malformed, so an
 * adapter is free to have put something enormous in an allowlisted field.
 * #705 accepted a canonical-artifact ratio of 1.799x against a 2.00x gate, so
 * there is no headroom for unbounded strings; an over-long value is dropped
 * rather than truncated, because a half a path is neither safe nor useful.
 */
const MAX_SANITIZED_STRING_LENGTH = 200

/**
 * Printable ASCII only, and nothing that disguises a path.
 *
 * These fields are diagnostic hints -- relation names, HTTP methods, binding
 * kinds -- so ASCII is the norm and dropping an exotic value costs a hint, never
 * a count. Refusing the whole class is what keeps a control character out of a
 * shared artifact and a unicode separator look-alike (U+2215 and friends) from
 * slipping past a path check that only knows `/` and `\\`.
 */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/

/** Percent-encoding can hide a separator, so `%2F`-style escapes are refused. */
const PERCENT_ENCODED = /%[0-9A-Fa-f]{2}/

function safeCandidateString(value: string, field: string): string | null {
  if (value.length === 0 || value.length > MAX_SANITIZED_STRING_LENGTH) return null
  // Ordered deliberately: reject the disguises before asking whether it looks
  // like a path, because each of these can make a path fail to look like one.
  if (!PRINTABLE_ASCII.test(value)) return null
  if (PERCENT_ENCODED.test(value)) return null
  if (value.startsWith('~')) return null
  if (!PATH_SHAPED.test(value)) return value
  try {
    // Path-shaped on any platform, so it only survives as a repository-relative
    // form. `normalizeIdentityRepositoryPath` refuses absolute POSIX paths,
    // Windows drive paths, UNC paths, URL schemes and `..` escapes.
    return normalizeIdentityRepositoryPath(value, field)
  } catch {
    // Deliberately dropped: an unsafe path never enters a shared record.
    return null
  }
}

/**
 * Bounded retention of durable records, selected by canonical record identity.
 *
 * Retains the K lexicographically smallest record ids seen. That makes the
 * retained subset a function of the candidate multiset alone, so the same
 * candidates in any order -- reversed, shuffled, chunked, or produced by a
 * different adapter traversal -- yield byte-identical output. Keeping "the first
 * K encountered" instead would have made the artifact depend on arrival order,
 * which cannot be a deterministic contract.
 *
 * Eviction is monotone: an id is dropped only when K smaller ids already exist,
 * and the K-th smallest can only decrease as more arrive, so an evicted id can
 * never re-enter. Multiplicity for retained ids stays exact; evicted groups
 * still contribute to the terminal counters and to the exact distinct total,
 * because only the *detail* is capped, never the accounting.
 */
class RetainedRecords<T extends { readonly id: string }> {
  private readonly byId = new Map<string, { record: T; multiplicity: number }>()
  /**
   * Ids seen, retained or evicted.
   *
   * Needed because the distinct total must stay *exact*: without it, an evicted
   * group observed again would be counted as newly distinct every time and the
   * disclosed total would drift upward. Ids only, never records -- roughly 67
   * bytes per distinct group against ~500 for a full record, so the dominant
   * memory term is still the one the cap bounds.
   */
  private readonly seenIds = new Set<string>()

  constructor(private readonly capacity: number = MAX_DURABLE_RECORDS_PER_KIND) {}

  /** Distinct groups seen, retained or not. Exact, never capped. */
  get distinctTotal(): number {
    return this.seenIds.size
  }

  get retainedCount(): number {
    return this.byId.size
  }

  /**
   * @param id canonical record id, already content-derived
   * @param build produces the record; called only when the id is newly retained
   */
  observe(id: string, build: () => T): void {
    const existing = this.byId.get(id)
    if (existing !== undefined) {
      existing.multiplicity += 1
      return
    }
    // An id already seen but not retained was evicted. Eviction is monotone --
    // the K-th smallest id only decreases -- so it cannot sort back in, and it
    // must not be counted as newly distinct either.
    if (this.seenIds.has(id)) return
    this.seenIds.add(id)

    if (this.byId.size < this.capacity) {
      this.byId.set(id, { record: build(), multiplicity: 1 })
      return
    }
    // At capacity: this id displaces the current largest only if it sorts below
    // it. Ids that do not are dropped and, by monotonicity, stay dropped.
    let largest: string | null = null
    for (const key of this.byId.keys()) {
      if (largest === null || key > largest) largest = key
    }
    if (largest === null || id >= largest) return
    this.byId.delete(largest)
    this.byId.set(id, { record: build(), multiplicity: 1 })
  }

  /** Retained entries in canonical id order, with their exact multiplicities. */
  entries(): readonly { readonly record: T; readonly multiplicity: number }[] {
    return [...this.byId.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, value]) => value)
  }
}

export class NormalizedAccountingSession {
  private readonly counts: Record<CandidateTerminalState, number> = { ...emptyTerminalCounts() }
  private readonly reasonCounts = new Map<TerminalIntegrityReason, number>()
  private readonly identity = new CandidateRecordIdentityFactory()
  private readonly unresolvedRetained = new RetainedRecords<UnresolvedCandidateRecord>()
  private readonly rejectedRetained = new RetainedRecords<RejectedCandidateRecord>()
  private readonly conflictRetained = new RetainedRecords<CandidateConflictRecord>()
  private readonly disposedFingerprints = new Set<string>()
  private readonly scopeFailureSet = new Set<string>()
  private emitted = 0
  private partialDiscriminators = 0
  private finalized = false

  /**
   * Records one candidate's terminal disposition.
   *
   * `fingerprint` identifies the candidate; passing the same fingerprint twice
   * is how a repeated identical candidate raises multiplicity, and passing the
   * same *entry* twice is prevented by the caller counting entries once.
   */
  dispose(fingerprint: string, disposition: CandidateDisposition): void {
    this.assertOpen()
    this.emitted += 1
    this.counts[disposition.state] += 1
    for (const reason of disposition.reasons ?? []) {
      this.reasonCounts.set(reason, (this.reasonCounts.get(reason) ?? 0) + 1)
      if (reason === 'partial_discriminator') this.partialDiscriminators += 1
    }
    this.disposedFingerprints.add(fingerprint)

    // The record is built here rather than at finalize so its canonical id is
    // available to the retention bound. Multiplicity is not part of record
    // identity, so building at multiplicity 1 yields the same id the final
    // record carries -- asserted at finalize rather than assumed.
    switch (disposition.state) {
      case 'unresolved': {
        const record = this.buildUnresolved(fingerprint, disposition, 1)
        this.unresolvedRetained.observe(record.id, () => record)
        return
      }
      case 'rejected': {
        const record = this.buildRejected(fingerprint, disposition, 1)
        this.rejectedRetained.observe(record.id, () => record)
        return
      }
      case 'conflicting': {
        const record = this.buildConflict(disposition, 1)
        this.conflictRetained.observe(record.id, () => record)
        return
      }
      default:
        return
    }
  }

  private buildUnresolved(
    fingerprint: string,
    draft: UnresolvedDisposition,
    multiplicity: number,
  ): UnresolvedCandidateRecord {
    return this.identity.createUnresolvedRecord({
      candidateFingerprint: fingerprint,
      multiplicity,
      ...(draft.source !== undefined ? { source: draft.source } : {}),
      ...(draft.target !== undefined ? { target: draft.target } : {}),
      ...(draft.relation !== undefined ? { relation: draft.relation } : {}),
      ...(draft.occurrences !== undefined ? { occurrences: draft.occurrences } : {}),
      reasons: draft.reasons,
      ...(draft.verificationTargets !== undefined
        ? { verificationTargets: normalizeVerificationTargets(draft.verificationTargets, 'unresolved') }
        : {}),
    })
  }

  private buildRejected(
    fingerprint: string,
    draft: RejectedDisposition,
    multiplicity: number,
  ): RejectedCandidateRecord {
    return this.identity.createRejectedRecord({
      candidateFingerprint: fingerprint,
      multiplicity,
      sanitizedCandidate: sanitizeCandidate(draft.candidate),
      reasons: draft.reasons,
      ...(draft.verificationTargets !== undefined
        ? { verificationTargets: normalizeVerificationTargets(draft.verificationTargets, 'rejected') }
        : {}),
    })
  }

  private buildConflict(draft: ConflictingDisposition, multiplicity: number): CandidateConflictRecord {
    return this.identity.createConflictRecord({
      candidateFingerprints: draft.groupFingerprints,
      multiplicity,
      reasons: draft.reasons,
      ...(draft.verificationTargets !== undefined
        ? { verificationTargets: normalizeVerificationTargets(draft.verificationTargets, 'conflict') }
        : {}),
    })
  }

  /**
   * Records a file- or adapter-scope failure that produced no candidate.
   *
   * Kept out of the candidate equation on purpose: inventing an
   * `emittedCandidates` entry for a candidate that never existed would make the
   * ledger describe a hypothetical.
   */
  recordScopeFailure(scope: string): void {
    this.assertOpen()
    this.scopeFailureSet.add(scope)
  }

  private assertOpen(): void {
    if (this.finalized) {
      throw new GraphIntegrityInvariantError('normalized accounting session is already finalized')
    }
  }

  get candidateCount(): number {
    return this.emitted
  }

  finalize(): NormalizedAccountingResult {
    this.assertOpen()
    this.finalized = true

    // Rebuilt at the exact multiplicity. Multiplicity is excluded from record
    // identity, so the id must not move; asserting that is what makes the
    // retention bound's ordering trustworthy rather than merely intended.
    const rebuild = <T extends { readonly id: string }>(
      entries: readonly { readonly record: T; readonly multiplicity: number }[],
      make: (record: T, multiplicity: number) => T,
    ): readonly T[] => Object.freeze(entries.map(({ record, multiplicity }) => {
      const rebuilt = make(record, multiplicity)
      if (rebuilt.id !== record.id) {
        throw new GraphIntegrityInvariantError(
          `record id moved when multiplicity was applied: ${record.id} became ${rebuilt.id}`,
        )
      }
      return rebuilt
    }))

    const unresolvedRecords = rebuild(this.unresolvedRetained.entries(), (record, multiplicity) => (
      this.identity.createUnresolvedRecord({
        candidateFingerprint: record.candidateFingerprint,
        multiplicity,
        ...(record.source !== undefined ? { source: record.source } : {}),
        ...(record.target !== undefined ? { target: record.target } : {}),
        ...(record.relation !== undefined ? { relation: record.relation } : {}),
        occurrences: record.occurrences,
        reasons: record.reasons,
        verificationTargets: record.verificationTargets,
      })
    ))

    const rejectedRecords = rebuild(this.rejectedRetained.entries(), (record, multiplicity) => (
      this.identity.createRejectedRecord({
        candidateFingerprint: record.candidateFingerprint,
        multiplicity,
        sanitizedCandidate: record.sanitizedCandidate,
        reasons: record.reasons,
        verificationTargets: record.verificationTargets,
      })
    ))

    const conflictRecords = rebuild(this.conflictRetained.entries(), (record, multiplicity) => (
      this.identity.createConflictRecord({
        candidateFingerprints: record.candidateFingerprints,
        multiplicity,
        reasons: record.reasons,
        verificationTargets: record.verificationTargets,
      })
    ))

    const retention = (
      retained: number,
      total: number,
    ): DurableRecordRetention => Object.freeze({ retained, total })

    return Object.freeze({
      emittedCandidates: this.emitted,
      counts: Object.freeze({ ...this.counts }),
      terminalReasonCounts: Object.freeze(Object.fromEntries(
        [...this.reasonCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
      )),
      unresolvedRecords,
      rejectedRecords,
      conflictRecords,
      unresolvedRetention: retention(unresolvedRecords.length, this.unresolvedRetained.distinctTotal),
      rejectedRetention: retention(rejectedRecords.length, this.rejectedRetained.distinctTotal),
      conflictingRetention: retention(conflictRecords.length, this.conflictRetained.distinctTotal),
      retainedPartialDiscriminators: this.partialDiscriminators,
      scopeFailures: Object.freeze([...this.scopeFailureSet].sort()),
    })
  }
}
