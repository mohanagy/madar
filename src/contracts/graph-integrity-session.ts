import { createHash } from 'node:crypto'

import { canonicalJsonBytes, serializeCanonicalJson } from './canonical-json.js'
import {
  CandidateRecordIdentityFactory,
  GraphIntegrityInvariantError,
  boundDurableRecords,
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
      // Even an allowlisted string is refused if it looks like a path we cannot
      // make repository-relative.
      if (key === 'relation' || !value.includes('/')) {
        sanitized[key] = value
        continue
      }
      try {
        const relative = normalizeIdentityRepositoryPath(value, key)
        if (relative !== null) sanitized[key] = relative
      } catch {
        // Deliberately dropped: an unsafe path never enters a shared record.
      }
      continue
    }
    if (typeof value === 'number' && Number.isFinite(value)) sanitized[key] = value
    if (typeof value === 'boolean') sanitized[key] = value
  }
  return Object.freeze(sanitized)
}

export class NormalizedAccountingSession {
  private readonly counts: Record<CandidateTerminalState, number> = { ...emptyTerminalCounts() }
  private readonly reasonCounts = new Map<TerminalIntegrityReason, number>()
  private readonly identity = new CandidateRecordIdentityFactory()
  private readonly unresolvedDrafts = new Map<string, { draft: UnresolvedDisposition; fingerprint: string; multiplicity: number }>()
  private readonly rejectedDrafts = new Map<string, { draft: RejectedDisposition; fingerprint: string; multiplicity: number }>()
  private readonly conflictDrafts = new Map<string, { draft: ConflictingDisposition; multiplicity: number }>()
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

    switch (disposition.state) {
      case 'unresolved':
        this.accumulate(this.unresolvedDrafts, fingerprint, disposition)
        return
      case 'rejected':
        this.accumulate(this.rejectedDrafts, fingerprint, disposition)
        return
      case 'conflicting': {
        // Grouped by sorted member fingerprints so a group's identity never
        // depends on which member was observed first.
        const key = serializeCanonicalJson([...disposition.groupFingerprints].sort(), { arraySemantics: 'ordered' })
        const existing = this.conflictDrafts.get(key)
        if (existing === undefined) {
          this.conflictDrafts.set(key, { draft: disposition, multiplicity: 1 })
        } else {
          existing.multiplicity += 1
        }
        return
      }
      default:
        return
    }
  }

  private accumulate<T extends UnresolvedDisposition | RejectedDisposition>(
    drafts: Map<string, { draft: T; fingerprint: string; multiplicity: number }>,
    fingerprint: string,
    disposition: T,
  ): void {
    const key = `${fingerprint}|${[...disposition.reasons].sort().join(',')}`
    const existing = drafts.get(key)
    if (existing === undefined) {
      drafts.set(key, { draft: disposition, fingerprint, multiplicity: 1 })
      return
    }
    existing.multiplicity += 1
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

    const unresolvedRecords = [...this.unresolvedDrafts.values()].map(({ draft, fingerprint, multiplicity }) => (
      this.identity.createUnresolvedRecord({
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
    ))

    const rejectedRecords = [...this.rejectedDrafts.values()].map(({ draft, fingerprint, multiplicity }) => (
      this.identity.createRejectedRecord({
        candidateFingerprint: fingerprint,
        multiplicity,
        sanitizedCandidate: sanitizeCandidate(draft.candidate),
        reasons: draft.reasons,
        ...(draft.verificationTargets !== undefined
          ? { verificationTargets: normalizeVerificationTargets(draft.verificationTargets, 'rejected') }
          : {}),
      })
    ))

    const conflictRecords = [...this.conflictDrafts.values()].map(({ draft, multiplicity }) => (
      this.identity.createConflictRecord({
        candidateFingerprints: draft.groupFingerprints,
        multiplicity,
        reasons: draft.reasons,
        ...(draft.verificationTargets !== undefined
          ? { verificationTargets: normalizeVerificationTargets(draft.verificationTargets, 'conflict') }
          : {}),
      })
    ))

    const unresolved = boundDurableRecords(unresolvedRecords)
    const rejected = boundDurableRecords(rejectedRecords)
    const conflicting = boundDurableRecords(conflictRecords)

    return Object.freeze({
      emittedCandidates: this.emitted,
      counts: Object.freeze({ ...this.counts }),
      terminalReasonCounts: Object.freeze(Object.fromEntries(
        [...this.reasonCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
      )),
      unresolvedRecords: unresolved.records,
      rejectedRecords: rejected.records,
      conflictRecords: conflicting.records,
      unresolvedRetention: unresolved.retention,
      rejectedRetention: rejected.retention,
      conflictingRetention: conflicting.retention,
      retainedPartialDiscriminators: this.partialDiscriminators,
      scopeFailures: Object.freeze([...this.scopeFailureSet].sort()),
    })
  }
}
