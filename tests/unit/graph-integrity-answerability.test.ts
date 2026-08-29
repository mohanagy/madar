import { describe, expect, it } from 'vitest'

import type {
  ContextPackRecoveryPlan,
  MadarAnswerabilityAssessment,
  MadarAnswerabilityState,
} from '../../src/contracts/context-recovery.js'
import { minByReadinessRank, readinessRank } from '../../src/contracts/context-recovery.js'
import { ENDPOINT_IDENTITY_STATUSES, type EndpointIdentityStatus } from '../../src/contracts/endpoint-identity.js'
import { buildGraphArtifactNormalizedAccounting } from '../../src/contracts/graph-artifact-normalized-accounting.js'
import { buildNormalizedIntegrityReceipt } from '../../src/contracts/graph-integrity-receipt.js'
import {
  detailRetention,
  emptyTerminalCounts,
  type CandidateTerminalCounts,
  type EndpointIdentityFactMatrix,
} from '../../src/contracts/graph-integrity.js'
import { buildFromJson } from '../../src/pipeline/build.js'
import {
  applyGraphIntegrityCap,
  capPublishedRecovery,
  graphIntegrityCap,
  graphIntegrityDiagnostic,
} from '../../src/shared/graph-integrity-answerability.js'

/**
 * Every receipt below is built from a real graph through the real accounting
 * builder, then decoded exactly the way a reader receives it. Nothing is a
 * hand-typed receipt literal: a literal would let a control pass against a
 * shape the producer never emits.
 */
const NODES = [
  { id: 'alpha', label: 'Alpha', file_type: 'code', source_file: 'src/alpha.ts' },
  { id: 'beta', label: 'Beta', file_type: 'code', source_file: 'src/beta.ts' },
  { id: 'gamma', label: 'Gamma', file_type: 'code', source_file: 'src/gamma.ts' },
]

function accountingFor(edges: Record<string, unknown>[]): Record<string, unknown> {
  const graph = buildFromJson(
    { schema_version: 1, directed: true, nodes: NODES, edges },
    { directed: true, accounting: 'normalized_extraction_boundary' },
  )
  const block = buildGraphArtifactNormalizedAccounting(graph.normalizedIntegritySnapshot()!)
  // A decoded artifact hands a reader a mutable clone, not the frozen original.
  return JSON.parse(JSON.stringify(block)) as Record<string, unknown>
}

const RESOLVED_EDGES = [
  { source: 'alpha', target: 'beta', relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
  { source: 'beta', target: 'gamma', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'src/beta.ts' },
]

const DEGRADING_EDGES = [
  ...RESOLVED_EDGES,
  { source: 'alpha', target: 'nowhere', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
  { source: 'beta', target: 'gamma', relation: 'totally_unregistered', confidence: 'EXTRACTED', source_file: 'src/beta.ts' },
]

function receiptOf(block: Record<string, unknown>): Record<string, unknown> {
  return block.receipt as Record<string, unknown>
}

/**
 * The exact wire shape a reader receives.
 *
 * The normalized accounting rides on the storage receipt under its own key, so
 * a control that handed the bare block to the mapping would be testing a shape
 * no artifact ever carries.
 */
function wire(block: Record<string, unknown>): Record<string, unknown> {
  return {
    accounting_scope: 'normalized_extraction_boundary',
    status: (block.receipt as Record<string, unknown>).status,
    reasons: [],
    endpoint_identity: {},
    storage_admission: {},
    reserved: {},
    normalized_accounting: block,
  }
}

function identityMatrix(cells: Partial<Record<EndpointIdentityStatus, Partial<Record<EndpointIdentityStatus, number>>>>): EndpointIdentityFactMatrix {
  const built = {} as Record<EndpointIdentityStatus, Record<EndpointIdentityStatus, number>>
  for (const source of ENDPOINT_IDENTITY_STATUSES) {
    built[source] = {} as Record<EndpointIdentityStatus, number>
    for (const target of ENDPOINT_IDENTITY_STATUSES) {
      built[source][target] = cells[source]?.[target] ?? 0
    }
  }
  return built
}

function terminalCounts(overrides: Partial<CandidateTerminalCounts>): CandidateTerminalCounts {
  return { ...emptyTerminalCounts(), ...overrides }
}

/**
 * A block around a receipt built by the real producer.
 *
 * `status` is derived by the producer from the counters, never supplied, and
 * the block validator re-derives it again on read. That is why the fixtures
 * below vary *counters* to reach a status rather than writing one down: a
 * receipt with a hand-set status is refused by the receipt authority, so a
 * control built on one would prove nothing about the mapping.
 */
function blockAround(counts: Partial<CandidateTerminalCounts>): Record<string, unknown> {
  const receipt = buildNormalizedIntegrityReceipt({
    emittedCandidates: 3,
    counts: terminalCounts({ retained_new_fact: 3, ...counts }),
    terminalReasonCounts: {},
    factsRetained: 3,
    occurrencesRetained: 3,
    uniqueEndpointPairs: 3,
    endpointFactPairCounts: identityMatrix({ stable: { stable: 3 } }),
    endpointReasonFactCounts: {},
    unresolvedRetention: detailRetention(0, 0),
    rejectedRetention: detailRetention(0, 0),
    conflictingRetention: detailRetention(0, 0),
    strictModeResult: 'not_run',
  })
  return JSON.parse(JSON.stringify({
    receipt,
    unresolved_records: [],
    rejected_records: [],
    conflict_records: [],
    scope_failures: [],
    scope_failure_retention: detailRetention(0, 0),
    reserved: {},
  })) as Record<string, unknown>
}

/**
 * A receipt whose retained records are a truncated sample of the real set.
 *
 * Built through the producer so `durable_records_truncated` and `degraded` are
 * derived rather than written down. A hand-edited retention flag would make the
 * re-derived reasons disagree with the array beside them and the block would be
 * refused before the discriminator ever ran.
 */
function blockWithTruncatedRecords(): Record<string, unknown> {
  const sample = (accountingFor(DEGRADING_EDGES).unresolved_records as Record<string, unknown>[])[0]!
  const receipt = buildNormalizedIntegrityReceipt({
    emittedCandidates: 3,
    counts: terminalCounts({ retained_new_fact: 2, unresolved: 1 }),
    terminalReasonCounts: { missing_target_endpoint: 1 },
    factsRetained: 2,
    occurrencesRetained: 2,
    uniqueEndpointPairs: 2,
    endpointFactPairCounts: identityMatrix({ stable: { stable: 2 } }),
    endpointReasonFactCounts: {},
    unresolvedRetention: detailRetention(1, 5),
    rejectedRetention: detailRetention(0, 0),
    conflictingRetention: detailRetention(0, 0),
    strictModeResult: 'not_run',
  })
  return JSON.parse(JSON.stringify({
    receipt,
    unresolved_records: [sample],
    rejected_records: [],
    conflict_records: [],
    scope_failures: [],
    scope_failure_retention: detailRetention(0, 0),
    reserved: {},
  })) as Record<string, unknown>
}

const degradedBlock = accountingFor(DEGRADING_EDGES)
const warningBlock = accountingFor(RESOLVED_EDGES)
/** A clean run with stable endpoints: the producer derives `valid`. */
const validBlock = blockAround({})
/** One candidate failed an invariant: the producer derives `invalid`. */
const invalidBlock = blockAround({ retained_new_fact: 2, invariant_failed: 1 })

const STATES: MadarAnswerabilityState[] = ['ready', 'ready_with_caveat', 'verify_targets', 'insufficient']

function assessment(
  state: MadarAnswerabilityState,
  overrides: Partial<MadarAnswerabilityAssessment> = {},
): MadarAnswerabilityAssessment {
  const base: MadarAnswerabilityAssessment = {
    state,
    answer_scope: state === 'ready' || state === 'ready_with_caveat' ? 'complete' : state === 'verify_targets' ? 'partial' : 'none',
    caveats: [],
    missing_obligations: [],
    // Deliberately populated for every state so a cap that lowers the state
    // without clearing targets is observable.
    verification_targets: [{ focus_files: ['src/pre-existing.ts'], focus_ranges: [], reason: 'pre-existing target' }],
    broad_search_fallback: state === 'verify_targets' ? 'targeted_only' : 'not_needed',
  }
  return { ...base, ...overrides }
}

function recoveryPlan(initial: MadarAnswerabilityState, final: MadarAnswerabilityState): ContextPackRecoveryPlan {
  return {
    version: 1,
    status: 'not_needed',
    budget: { max_attempts: 2, max_candidate_nodes: 64, max_elapsed_ms: 750, output_token_budget: 1_800 },
    initial_state: initial,
    final_state: final,
    attempts: [],
    improved: false,
  }
}

describe('659 control 1 / I1-I8 — the receipt-to-ceiling mapping', () => {
  it('I1 applies no cap and emits no diagnostic when no receipt exists', () => {
    for (const absent of [undefined, null]) {
      const cap = graphIntegrityCap(absent)
      expect(cap.ceiling).toBeNull()
      expect(cap.status).toBeNull()
      // Control 15: absence must never be described as a checked, valid graph.
      expect(graphIntegrityDiagnostic(cap)).toBeUndefined()
    }
  })

  it('I2 caps a present but malformed normalized accounting block to insufficient', () => {
    for (const broken of [{}, { receipt: {} }, 'not-an-object', 42, [], { receipt: { status: 'valid' } }]) {
      const cap = graphIntegrityCap({ normalized_accounting: broken })
      expect(cap.ceiling).toBe('insufficient')
      // Present-but-broken still reports, unlike a genuine absence.
      expect(graphIntegrityDiagnostic(cap)).toBeDefined()
    }
  })

  it('treats a storage-only receipt as carrying no normalized accounting, and never as valid', () => {
    // A #657-era receipt predates normalized accounting. It cannot establish
    // integrity, so it earns no cap; the point that matters for false readiness
    // is that it is never reported as a graph that was checked and found valid.
    const storageOnly = {
      accounting_scope: 'storage_only',
      status: 'valid',
      reasons: [],
      endpoint_identity: {},
      storage_admission: {},
      reserved: {},
    }
    const cap = graphIntegrityCap(storageOnly)
    expect(cap.ceiling).toBeNull()
    expect(cap.status).toBeNull()
    expect(graphIntegrityDiagnostic(cap)).toBeUndefined()
  })

  it('I2 refuses a receipt whose status was forged to disagree with its counters', () => {
    // `assertNormalizedIntegrityReceipt` re-derives status and reasons from the
    // receipt's own counters, so a forged `valid` beside an invariant failure
    // never reaches the mapping: it arrives as unreadable and still caps.
    const forged = JSON.parse(JSON.stringify(invalidBlock)) as Record<string, unknown>
    expect(receiptOf(forged).status).toBe('invalid')
    receiptOf(forged).status = 'valid'

    const cap = graphIntegrityCap(wire(forged))
    expect(cap.ceiling).toBe('insufficient')
    // Critically, not `null`: a forged valid must never buy "no cap".
    expect(cap.ceiling).not.toBeNull()
  })

  it('I3 caps a genuinely invalid receipt to insufficient', () => {
    // Derived, not asserted: one candidate failed an invariant, and
    // `deriveIntegrityStatus` turns that into `invalid`.
    expect(receiptOf(invalidBlock).status).toBe('invalid')
    expect((receiptOf(invalidBlock).terminal_counts as Record<string, number>).invariant_failed).toBe(1)
    const cap = graphIntegrityCap(wire(invalidBlock))
    expect(cap.ceiling).toBe('insufficient')
    expect(cap.reason).toBe('graph_integrity_invalid')
  })

  it('I4 caps an incompatible claim to insufficient, whichever way it arrives', () => {
    // `deriveIntegrityStatus` never derives `incompatible`: it describes an
    // artifact a loader refused, not an accounting outcome. A block claiming it
    // therefore disagrees with its own counters and is refused by the receipt
    // authority. Either way the answer is the same, which is what matters for
    // false-ready prevention.
    const claimed = JSON.parse(JSON.stringify(validBlock)) as Record<string, unknown>
    receiptOf(claimed).status = 'incompatible'
    const cap = graphIntegrityCap(wire(claimed))
    expect(cap.ceiling).toBe('insufficient')
    expect(cap.reason).toMatch(/^graph_integrity_(incompatible|unreadable)/)
  })

  it('I5 caps degraded with bounded actionable targets to verify_targets', () => {
    const cap = graphIntegrityCap(wire(degradedBlock))
    expect(receiptOf(degradedBlock).status).toBe('degraded')
    expect(cap.ceiling).toBe('verify_targets')
    expect(cap.reason).toBe('graph_integrity_degraded_with_targets')
    expect(cap.targets.length).toBeGreaterThan(0)
    // Repository-relative, sourced from the record, never invented from text.
    expect(cap.targets.flatMap((target) => target.focus_files)).toContain('src/alpha.ts')
  })

  it('I6 caps degraded to insufficient when the record set is truncated', () => {
    const truncatedBlock = blockWithTruncatedRecords()
    expect(receiptOf(truncatedBlock).status).toBe('degraded')
    expect(receiptOf(truncatedBlock).reasons).toContain('durable_records_truncated')
    const truncatedCap = graphIntegrityCap(wire(truncatedBlock))
    expect(truncatedCap.ceiling).toBe('insufficient')
    expect(truncatedCap.reason).toBe('graph_integrity_degraded_without_bounded_targets')
    expect(truncatedCap.targets).toHaveLength(0)

    const truncated = JSON.parse(JSON.stringify(degradedBlock)) as Record<string, unknown>
    const records = receiptOf(truncated).durable_records as Record<string, Record<string, unknown>>
    const unresolved = records.unresolved as Record<string, unknown>
    unresolved.total = (unresolved.retained as number) + 5
    unresolved.omitted = 5
    unresolved.truncated = true

    const cap = graphIntegrityCap(wire(truncated))
    expect(cap.ceiling).toBe('insufficient')
    expect(cap.targets).toHaveLength(0)
  })

  it('I6 caps degraded to insufficient when no record carries an actionable target', () => {
    const targetless = JSON.parse(JSON.stringify(degradedBlock)) as Record<string, unknown>
    for (const key of ['unresolved_records', 'rejected_records', 'conflict_records'] as const) {
      for (const record of targetless[key] as Record<string, unknown>[]) {
        record.verificationTargets = []
      }
    }
    const cap = graphIntegrityCap(wire(targetless))
    expect(cap.ceiling).toBe('insufficient')
    expect(cap.reason).toBe('graph_integrity_degraded_without_bounded_targets')
  })

  it('I7 caps valid_with_warnings to ready_with_caveat', () => {
    expect(receiptOf(warningBlock).status).toBe('valid_with_warnings')
    expect(graphIntegrityCap(wire(warningBlock)).ceiling).toBe('ready_with_caveat')
  })

  it('I8 applies no cap for valid, and valid alone never grants readiness', () => {
    const cap = graphIntegrityCap(wire(validBlock))
    expect(cap.ceiling).toBeNull()
    // Control 12: a lower prior state stays exactly where it was.
    for (const state of STATES) {
      expect(applyGraphIntegrityCap(assessment(state), cap).state).toBe(state)
    }
  })
})

describe('659 controls 2/3/4 — the cap matrix, monotonicity and idempotence', () => {
  const ceilings = [
    { label: 'none', block: validBlock },
    { label: 'ready_with_caveat', block: warningBlock },
    { label: 'verify_targets', block: degradedBlock },
    { label: 'insufficient', block: invalidBlock },
  ] as const

  it('control 2 — every existing state under every ceiling equals the lower rank', () => {
    for (const { block } of ceilings) {
      const cap = graphIntegrityCap(wire(block))
      for (const state of STATES) {
        const result = applyGraphIntegrityCap(assessment(state), cap)
        const expected = cap.ceiling === null ? state : minByReadinessRank(state, cap.ceiling)
        expect(result.state).toBe(expected)
      }
    }
  })

  it('control 3 — the cap never raises answerability', () => {
    for (const { block } of ceilings) {
      const cap = graphIntegrityCap(wire(block))
      for (const state of STATES) {
        const result = applyGraphIntegrityCap(assessment(state), cap)
        expect(readinessRank(result.state)).toBeLessThanOrEqual(readinessRank(state))
      }
    }
  })

  it('control 4 — applying the cap twice is idempotent', () => {
    for (const { block } of ceilings) {
      const cap = graphIntegrityCap(wire(block))
      for (const state of STATES) {
        const once = applyGraphIntegrityCap(assessment(state), cap)
        const twice = applyGraphIntegrityCap(once, cap)
        expect(twice).toEqual(once)
      }
    }
  })

  it('control 16 — a capped insufficient always clears its verification targets', () => {
    // The compact CLI serializer decides whether it may still offer a target by
    // testing `verification_targets.length`. A capped `insufficient` that left
    // targets populated would be silently promoted back to `verify_targets`
    // downstream, which is the readiness-raising path this control closes.
    const cap = graphIntegrityCap(wire(invalidBlock))
    for (const state of STATES) {
      const before = assessment(state)
      const result = applyGraphIntegrityCap(before, cap)
      if (result.state === 'insufficient' && result.state !== before.state) {
        expect(result.verification_targets).toHaveLength(0)
        expect(result.answer_scope).toBe('none')
      }
    }
  })

  it('control 16 — a capped verify_targets always carries at least one actionable target', () => {
    const cap = graphIntegrityCap(wire(degradedBlock))
    for (const state of ['ready', 'ready_with_caveat'] as MadarAnswerabilityState[]) {
      const result = applyGraphIntegrityCap(assessment(state), cap)
      expect(result.state).toBe('verify_targets')
      expect(result.verification_targets.length).toBeGreaterThan(0)
      expect(result.verification_targets.every((target) => target.focus_files.length > 0)).toBe(true)
    }
  })

  it('preserves a blocked broad-search fallback rather than loosening it', () => {
    const cap = graphIntegrityCap(wire(invalidBlock))
    const blocked = assessment('ready', { broad_search_fallback: 'blocked' })
    expect(applyGraphIntegrityCap(blocked, cap).broad_search_fallback).toBe('blocked')
  })
})

describe('659 controls 5/6 — determinism', () => {
  it('control 5 — reason order cannot reach the mapping at all', () => {
    // Stronger than "order does not change the answer": the receipt authority
    // re-derives `reasons` and refuses a permuted array outright, so a
    // reordered receipt is never mapped in the first place. The ceiling is
    // computed from `status` and the retention counters, and reasons are only
    // ever membership-tested.
    const permuted = JSON.parse(JSON.stringify(degradedBlock)) as Record<string, unknown>
    const reasons = receiptOf(degradedBlock).reasons as string[]
    expect(reasons.length).toBeGreaterThan(1)
    receiptOf(permuted).reasons = [...reasons].reverse()
    expect(graphIntegrityCap(wire(permuted)).ceiling).toBe('insufficient')
  })

  it('control 6 — record order cannot reach the mapping, and the projection is stable', () => {
    // Record arrays are a strictly ascending wire contract, so a reordered
    // array is refused rather than silently re-sorted.
    const reordered = JSON.parse(JSON.stringify(degradedBlock)) as Record<string, unknown>
    reordered.unresolved_records = [...(reordered.unresolved_records as unknown[])].reverse()
    reordered.rejected_records = [...(reordered.rejected_records as unknown[])].reverse()
    const records = reordered.unresolved_records as unknown[]
    if (records.length > 1) {
      expect(graphIntegrityCap(wire(reordered)).ceiling).toBe('insufficient')
    }

    // And two independent builds of the same graph project an identical list.
    expect(graphIntegrityCap(wire(accountingFor(DEGRADING_EDGES))).targets)
      .toEqual(graphIntegrityCap(wire(accountingFor(DEGRADING_EDGES))).targets)
  })

  it('projects each file and reason pair exactly once, in a stable order', () => {
    const cap = graphIntegrityCap(wire(degradedBlock))
    const keys = cap.targets.map((target) => `${target.focus_files.join(',')}|${target.reason}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect([...keys].sort()).toEqual(keys)
  })
})

describe('659 control 18 — published recovery is bounded by the FINAL top-level answerability', () => {
  it('equals the lower-ranked input in every cell of the pairwise matrix', () => {
    for (const recoveryState of STATES) {
      for (const topLevel of STATES) {
        const capped = capPublishedRecovery(recoveryPlan(recoveryState, recoveryState), topLevel)
        const expected = minByReadinessRank(recoveryState, topLevel)
        expect(capped.final_state).toBe(expected)
        expect(capped.initial_state).toBe(expected)
        expect(readinessRank(capped.final_state)).toBeLessThanOrEqual(readinessRank(recoveryState))
      }
    }
  })

  it('covers the maintainer-named cases explicitly', () => {
    expect(capPublishedRecovery(recoveryPlan('ready', 'ready'), 'insufficient').final_state).toBe('insufficient')
    expect(capPublishedRecovery(recoveryPlan('ready_with_caveat', 'ready_with_caveat'), 'verify_targets').final_state).toBe('verify_targets')
    expect(capPublishedRecovery(recoveryPlan('verify_targets', 'verify_targets'), 'ready_with_caveat').final_state).toBe('verify_targets')
    expect(capPublishedRecovery(recoveryPlan('insufficient', 'insufficient'), 'ready').final_state).toBe('insufficient')
    const equal = recoveryPlan('verify_targets', 'verify_targets')
    expect(capPublishedRecovery(equal, 'verify_targets')).toEqual(equal)
  })

  it('is idempotent', () => {
    for (const recoveryState of STATES) {
      for (const topLevel of STATES) {
        const once = capPublishedRecovery(recoveryPlan(recoveryState, recoveryState), topLevel)
        expect(capPublishedRecovery(once, topLevel)).toEqual(once)
      }
    }
  })

  it('bounds by the final answerability, not by the integrity ceiling alone', () => {
    // Finding D. The ceiling permits `ready_with_caveat`, but other factors
    // lowered the published answer to `verify_targets`; a recovery plan bounded
    // only by the ceiling would still publish the more optimistic state.
    const ceiling = graphIntegrityCap(wire(warningBlock)).ceiling
    expect(ceiling).toBe('ready_with_caveat')
    const published = capPublishedRecovery(recoveryPlan('ready', 'ready'), 'verify_targets')
    expect(published.final_state).toBe('verify_targets')
    expect(published.final_state).not.toBe(ceiling)
  })
})
