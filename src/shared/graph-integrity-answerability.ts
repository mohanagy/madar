import { statSync } from 'node:fs'

import type {
  ContextPackRecoveryPlan,
  MadarAnswerabilityAssessment,
  MadarAnswerabilityState,
  MadarVerificationTarget,
} from '../contracts/context-recovery.js'
import { isMadarAnswerabilityState, minByReadinessRank } from '../contracts/context-recovery.js'
import {
  NORMALIZED_ACCOUNTING_ARTIFACT_KEY,
  parseGraphArtifactNormalizedAccounting,
  type GraphArtifactNormalizedAccountingV1,
} from '../contracts/graph-artifact-normalized-accounting.js'
import { readGraphArtifactMetadata } from '../contracts/graph-artifact.js'
import { assertNormalizedIntegrityReceipt } from '../contracts/graph-integrity-receipt.js'
import type { GraphIntegrityStatus, IntegrityVerificationTarget } from '../contracts/graph-integrity.js'
import { MAX_GRAPH_ARTIFACT_BYTES } from './discovery-safety.js'

/**
 * The single owner of "what does graph integrity permit an answer to claim".
 *
 * #659 consumes the #658 receipt; it never recomputes integrity. `status` is
 * derived by `deriveIntegrityStatus` inside the graph contracts and read here
 * verbatim, and the bounded/unbounded split is read out of the receipt's own
 * `durable_records` retention rather than parsed out of reason text.
 */

/** How the integrity state of an artifact was resolved. */
export type GraphIntegrityResolution =
  /** No receipt at all: a legacy v1 artifact, or no artifact. */
  | { readonly kind: 'absent' }
  /**
   * A receipt is present but cannot be trusted: it failed the #658 validator,
   * or its own counters contradict the status it claims. Never treated as
   * absent, because an artifact that claims graph-backed evidence and then
   * presents an unreadable receipt is the case this issue exists to catch.
   */
  | { readonly kind: 'unreadable', readonly reason: string }
  | {
      readonly kind: 'present'
      readonly block: GraphArtifactNormalizedAccountingV1
    }

/** `null` means "no graph-integrity constraint", never "ready". */
export type GraphIntegrityCeiling = MadarAnswerabilityState | null

export interface GraphIntegrityCap {
  readonly ceiling: GraphIntegrityCeiling
  /** Machine-readable, appended to caveats when the cap actually binds. */
  readonly reason: string | null
  /** Deterministic, deduplicated, share-safe. Empty unless degraded with targets. */
  readonly targets: readonly MadarVerificationTarget[]
  /**
   * What the receipt said, for the share-safe diagnostic.
   *
   * `null` when no receipt was present. Never synthesised: absence stays
   * absence so the projection cannot claim an integrity status that was never
   * recorded.
   */
  readonly status: GraphIntegrityStatus | null
  readonly reasons: readonly string[]
}

/** The share-safe projection handed to Pack, CLI and MCP alike. */
export interface GraphIntegrityDiagnostic {
  readonly status: GraphIntegrityStatus
  readonly reasons: readonly string[]
  readonly max_answerability: MadarAnswerabilityState | null
  readonly verification_targets: readonly string[]
}

/**
 * The diagnostic for a cap, or `undefined` when no receipt existed.
 *
 * Absence emits nothing at all rather than an "unknown" status, so a legacy
 * artifact never appears to have been checked and found fine.
 */
export function graphIntegrityDiagnostic(cap: GraphIntegrityCap): GraphIntegrityDiagnostic | undefined {
  if (cap.status === null) return undefined
  return {
    status: cap.status,
    reasons: cap.reasons,
    max_answerability: cap.ceiling,
    verification_targets: cap.targets.flatMap((target) => target.focus_files),
  }
}

export const NO_GRAPH_INTEGRITY_CAP: GraphIntegrityCap = Object.freeze({
  ceiling: null,
  reason: null,
  targets: Object.freeze([]),
  status: null,
  reasons: Object.freeze([]),
})

/**
 * Resolves the raw `integrity_receipt` wire value into one of three states.
 *
 * `undefined` and `null` are absence, which is not a defect: a v1 artifact
 * predates the receipt entirely. Anything else must parse and validate, and a
 * value that does not is `unreadable`, deliberately distinct from absent.
 */
export function resolveGraphIntegrity(raw: unknown): GraphIntegrityResolution {
  if (raw === undefined || raw === null) {
    return { kind: 'absent' }
  }
  // `integrity_receipt` is the storage receipt, and the #658 normalized
  // accounting rides on it under a dedicated key. Unwrapping here rather than
  // handing the whole receipt to the block parser is the difference between
  // reading the accounting and refusing every real artifact as malformed.
  const carrier = typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)[NORMALIZED_ACCOUNTING_ARTIFACT_KEY]
    : undefined
  if (carrier === undefined) {
    // Either a storage-only receipt from before normalized accounting existed,
    // or something that is not a receipt at all. Neither can establish
    // integrity, and neither is allowed to assert it: the caller gets no cap
    // and, critically, no diagnostic claiming the graph was found valid.
    return { kind: 'absent' }
  }
  let block: GraphArtifactNormalizedAccountingV1
  try {
    block = parseGraphArtifactNormalizedAccounting(carrier, 'integrity_receipt.normalized_accounting')
    assertNormalizedIntegrityReceipt(block.receipt)
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.name : 'unparseable_receipt' }
  }
  // No second consistency check here on purpose.
  //
  // `assertNormalizedIntegrityReceipt` is the one receipt authority and it
  // re-derives status and reasons from the receipt's own counters before
  // comparing, so a forged `valid` beside an invariant failure is already
  // refused above and arrives as `unreadable`. Re-deriving any part of that
  // judgement here would create a second integrity policy owner that could
  // drift from the first, which is the failure this issue is meant to avoid.
  return { kind: 'present', block }
}

/**
 * Whether a degraded receipt can tell a consumer what to check.
 *
 * Truncation anywhere means the retained records are not the whole set, so the
 * consumer would be handed a partial list presented as complete. The issue is
 * explicit that a degraded state without a bounded target set is
 * `insufficient`, not a vague `verify_targets`.
 */
function boundedIntegrityTargets(
  block: GraphArtifactNormalizedAccountingV1,
): readonly MadarVerificationTarget[] {
  const records = block.receipt.durable_records
  if (block.receipt.reasons.includes('durable_records_truncated')) return []
  if (records.unresolved.truncated || records.rejected.truncated || records.conflicting.truncated) return []

  const collected: IntegrityVerificationTarget[] = [
    ...block.unresolved_records.flatMap((record) => [...record.verificationTargets]),
    ...block.rejected_records.flatMap((record) => [...record.verificationTargets]),
    ...block.conflict_records.flatMap((record) => [...record.verificationTargets]),
  ]

  // Keyed on file plus reason and sorted in code-unit order, so two runs that
  // retained the same records in a different arrival order project the same
  // target list. `localeCompare` is locale-sensitive and would not.
  const byKey = new Map<string, IntegrityVerificationTarget>()
  for (const target of collected) {
    const key = `${target.file}\u0000${target.reason}`
    if (!byKey.has(key)) byKey.set(key, target)
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, target]): MadarVerificationTarget => ({
      focus_files: [target.file],
      focus_ranges: [],
      reason: `verify graph integrity: ${target.reason}`,
    }))
}

/**
 * The receipt-to-ceiling mapping. Exactly the policy table in the issue.
 *
 * `valid` and absence both return `null` rather than `'ready'`: integrity never
 * grants readiness, it only withholds it. Every existing evidence, coverage and
 * answer-contract gate still applies on top.
 */
export function graphIntegrityCap(raw: unknown): GraphIntegrityCap {
  const resolution = resolveGraphIntegrity(raw)

  if (resolution.kind === 'absent') {
    return NO_GRAPH_INTEGRITY_CAP
  }
  if (resolution.kind === 'unreadable') {
    return {
      ceiling: 'insufficient',
      reason: `graph_integrity_unreadable:${resolution.reason}`,
      targets: [],
      // A receipt that failed validation has no status worth quoting, but it is
      // emphatically present, so the diagnostic reports `invalid` rather than
      // vanishing the way a genuine absence does.
      status: 'invalid',
      reasons: [resolution.reason],
    }
  }

  const { block } = resolution
  const status = block.receipt.status

  const reasons = [...block.receipt.reasons]
  if (status === 'valid') {
    return { ceiling: null, reason: null, targets: [], status, reasons }
  }
  if (status === 'invalid' || status === 'incompatible') {
    return { ceiling: 'insufficient', reason: `graph_integrity_${status}`, targets: [], status, reasons }
  }
  if (status === 'valid_with_warnings') {
    // Uniform, per the design ruling. Discriminating a "permitted" boundary
    // warning from any other would need the declared-exception authority #658
    // states this contract does not have, and inferring permission from a
    // warning that merely looks benign is exactly what it forbids.
    return { ceiling: 'ready_with_caveat', reason: 'graph_integrity_valid_with_warnings', targets: [], status, reasons }
  }

  const targets = boundedIntegrityTargets(block)
  return targets.length > 0
    ? { ceiling: 'verify_targets', reason: 'graph_integrity_degraded_with_targets', targets, status, reasons }
    : { ceiling: 'insufficient', reason: 'graph_integrity_degraded_without_bounded_targets', targets: [], status, reasons }
}

function withCaveat(caveats: readonly string[], reason: string | null): string[] {
  if (reason === null || caveats.includes(reason)) return [...caveats]
  return [...caveats, reason]
}

/**
 * Applies the ceiling to a computed answerability assessment.
 *
 * The result satisfies every structural invariant the uncapped assessment
 * satisfies, because consumers read those invariants rather than the state
 * alone. The compact CLI serializer decides whether it may still offer a target
 * by testing `verification_targets.length`, so a capped `insufficient` that
 * left targets in place would be silently promoted back to `verify_targets`
 * downstream. Lowering the state is therefore never enough on its own.
 *
 * Idempotent: once the state equals the ceiling the assessment is returned
 * unchanged, so applying the cap twice cannot append a second caveat.
 */
export function applyGraphIntegrityCap(
  assessment: MadarAnswerabilityAssessment,
  cap: GraphIntegrityCap,
): MadarAnswerabilityAssessment {
  if (cap.ceiling === null) return assessment
  const next = minByReadinessRank(assessment.state, cap.ceiling)
  if (next === assessment.state) return assessment

  if (next === 'insufficient') {
    return {
      ...assessment,
      state: 'insufficient',
      answer_scope: 'none',
      caveats: withCaveat(assessment.caveats, cap.reason),
      verification_targets: [],
      broad_search_fallback: assessment.broad_search_fallback === 'blocked' ? 'blocked' : 'allowed',
    }
  }
  if (next === 'verify_targets') {
    // The ceiling is only ever `verify_targets` when the receipt produced a
    // bounded, non-empty target set, so this cannot emit an unactionable
    // `verify_targets`.
    return {
      ...assessment,
      state: 'verify_targets',
      answer_scope: 'partial',
      caveats: withCaveat(assessment.caveats, cap.reason),
      verification_targets: [...cap.targets],
      broad_search_fallback: assessment.broad_search_fallback === 'blocked' ? 'blocked' : 'targeted_only',
    }
  }
  return {
    ...assessment,
    state: 'ready_with_caveat',
    caveats: withCaveat(assessment.caveats, cap.reason),
  }
}

/**
 * Bounds a published recovery plan by the FINAL top-level answerability.
 *
 * Not by the integrity ceiling. The top-level result may already have been
 * lowered by evidence strength, coverage or an answer contract, and a recovery
 * plan bounded only by the ceiling could still publish `ready_with_caveat`
 * beside a top-level `verify_targets`. The bound is the published answer, so
 * that no published channel can be more optimistic than it.
 */
export function capPublishedRecovery(
  plan: ContextPackRecoveryPlan,
  finalTopLevel: MadarAnswerabilityState,
): ContextPackRecoveryPlan {
  const initial = minByReadinessRank(plan.initial_state, finalTopLevel)
  const final = minByReadinessRank(plan.final_state, finalTopLevel)
  if (initial === plan.initial_state && final === plan.final_state) return plan
  return { ...plan, initial_state: initial, final_state: final }
}

const MAX_INTEGRITY_CACHE_ENTRIES = 16

interface CachedIntegrityCap {
  readonly resolvedPath: string
  readonly mtimeMs: number
  readonly size: number
  readonly value: GraphIntegrityCap
}

const integrityCapCache = new Map<string, CachedIntegrityCap>()

function freshAgainst(path: string, mtimeMs: number, size: number): boolean {
  try {
    const stats = statSync(path)
    return stats.mtimeMs === mtimeMs && stats.size === size
  } catch {
    // The artifact moved or vanished; the cached value describes nothing.
    return false
  }
}

/**
 * Reads the cap for a graph path, bounded and cached.
 *
 * Deliberately the same shape as `readDiscoverySafetyMetadata`: one bounded
 * `readGraphArtifactMetadata` under the shared byte ceiling, keyed on the
 * artifact actually resolved and invalidated by mtime and size. An assessment
 * runs this once per request, so an unbounded or uncached read here would be a
 * new hot path rather than a projection.
 *
 * Never throws. A read failure yields no cap rather than a fabricated one:
 * refusing to answer because an artifact could not be stat-ed is not this
 * function's decision to make, and `format` already distinguishes unreadable
 * from absent for callers that care.
 */
export function readGraphIntegrityCap(graphPath: string): GraphIntegrityCap {
  try {
    const cacheKey = graphPath
    const cached = integrityCapCache.get(cacheKey)
    if (cached !== undefined && freshAgainst(cached.resolvedPath, cached.mtimeMs, cached.size)) {
      return cached.value
    }
    const metadata = readGraphArtifactMetadata(graphPath, { maxBytes: MAX_GRAPH_ARTIFACT_BYTES })
    const value = graphIntegrityCap(metadata.integrityReceipt)
    const resolvedPath = metadata.resolvedPath ?? graphPath
    const stats = statSync(resolvedPath)
    integrityCapCache.set(cacheKey, { resolvedPath, mtimeMs: stats.mtimeMs, size: stats.size, value })
    while (integrityCapCache.size > MAX_INTEGRITY_CACHE_ENTRIES) {
      const oldestKey = integrityCapCache.keys().next().value as string | undefined
      if (!oldestKey) break
      integrityCapCache.delete(oldestKey)
    }
    return value
  } catch {
    return NO_GRAPH_INTEGRITY_CAP
  }
}

/**
 * Bounds a published recovery projection by the final top-level answerability.
 *
 * The one helper both publication seams use. `pack.recovery` and
 * `evidence.recovery` are separate serialisations of the same plan, and the
 * pack is built before the answer is assessed, so the pack copy has to be
 * bounded where the final answerability actually exists rather than where the
 * pack is assembled.
 *
 * Only the two state fields move. Attempt counts, budgets, improvement flags
 * and every other field are recovery-execution metadata that this cap has no
 * business rewriting, and an absent plan stays absent rather than being
 * fabricated into an empty one.
 *
 * Returns the original reference when nothing changed, which is what makes a
 * second application a provable no-op.
 */
export function capPublishedRecoveryByFinalAnswerability<T>(
  recovery: T,
  finalAnswerability: MadarAnswerabilityState,
): T {
  if (recovery === null || typeof recovery !== 'object' || Array.isArray(recovery)) {
    return recovery
  }
  const plan = recovery as Record<string, unknown>
  const initial = plan.initial_state
  const final = plan.final_state
  const nextInitial = isMadarAnswerabilityState(initial)
    ? minByReadinessRank(initial, finalAnswerability)
    : initial
  const nextFinal = isMadarAnswerabilityState(final)
    ? minByReadinessRank(final, finalAnswerability)
    : final
  if (nextInitial === initial && nextFinal === final) {
    return recovery
  }
  return { ...plan, initial_state: nextInitial, final_state: nextFinal } as T
}
