import { describe, expect, it } from 'vitest'

import { ENDPOINT_IDENTITY_STATUSES, type EndpointIdentityStatus } from '../../src/contracts/endpoint-identity.js'
import {
  GRAPH_INTEGRITY_REASON_VOCABULARY_VERSION,
  GRAPH_INTEGRITY_RECEIPT_VERSION,
  MAX_DURABLE_RECORDS_PER_KIND,
  NORMALIZED_ACCOUNTING_SCOPE,
  emptyTerminalCounts,
  type CandidateTerminalCounts,
  type EndpointIdentityFactMatrix,
  type GraphIntegrityReceiptV1,
} from '../../src/contracts/graph-integrity.js'
import {
  assertNormalizedIntegrityReceipt,
  assertStorageAdmissionProjection,
  assertStrictModeResultPolicy,
  buildNormalizedIntegrityReceipt,
  type NormalizedIntegrityReceiptInput,
} from '../../src/contracts/graph-integrity-receipt.js'

function matrix(cells: Partial<Record<EndpointIdentityStatus, Partial<Record<EndpointIdentityStatus, number>>>> = {}): EndpointIdentityFactMatrix {
  const built = {} as Record<EndpointIdentityStatus, Record<EndpointIdentityStatus, number>>
  for (const source of ENDPOINT_IDENTITY_STATUSES) {
    built[source] = {} as Record<EndpointIdentityStatus, number>
    for (const target of ENDPOINT_IDENTITY_STATUSES) {
      built[source][target] = cells[source]?.[target] ?? 0
    }
  }
  return built
}

function counts(overrides: Partial<CandidateTerminalCounts> = {}): CandidateTerminalCounts {
  return { ...emptyTerminalCounts(), ...overrides }
}

const NONE = Object.freeze({ retained: 0, total: 0 })

function input(overrides: Partial<NormalizedIntegrityReceiptInput> = {}): NormalizedIntegrityReceiptInput {
  return {
    emittedCandidates: 3,
    counts: counts({ retained_new_fact: 3 }),
    terminalReasonCounts: {},
    factsRetained: 3,
    occurrencesRetained: 3,
    uniqueEndpointPairs: 3,
    endpointFactPairCounts: matrix({ stable: { stable: 3 } }),
    endpointReasonFactCounts: {},
    unresolvedRetention: NONE,
    rejectedRetention: NONE,
    conflictingRetention: NONE,
    strictModeResult: 'not_run',
    ...overrides,
  }
}

function build(overrides: Partial<NormalizedIntegrityReceiptInput> = {}): GraphIntegrityReceiptV1 {
  return buildNormalizedIntegrityReceipt(input(overrides))
}

describe('the receipt declares its own versions and scope', () => {
  it('pins the receipt and vocabulary versions and the normalized scope', () => {
    const receipt = build()
    expect(receipt.receipt_version).toBe(GRAPH_INTEGRITY_RECEIPT_VERSION)
    expect(receipt.reason_vocabulary_version).toBe(GRAPH_INTEGRITY_REASON_VOCABULARY_VERSION)
    expect(receipt.accounting_scope).toBe(NORMALIZED_ACCOUNTING_SCOPE)
  })

  it('never claims the storage-only scope it replaces', () => {
    expect(build().accounting_scope).not.toBe('storage_only')
  })

  it('still discloses that raw adapter emission is unaccounted for', () => {
    expect(build().reasons).toContain('full_emission_accounting_not_available')
  })
})

describe('the receipt refuses to be built on numbers that disagree', () => {
  it('rejects an unbalanced candidate equation', () => {
    expect(() => build({ emittedCandidates: 4 })).toThrow(/candidate accounting mismatch/)
  })

  it('rejects a matrix that does not partition the retained facts', () => {
    expect(() => build({ endpointFactPairCounts: matrix({ stable: { stable: 2 } }) }))
      .toThrow(/partition sums to 2, expected 3/)
  })

  it('rejects negative graph totals', () => {
    expect(() => build({ occurrencesRetained: -1 })).toThrow(/occurrences_retained/)
    expect(() => build({ uniqueEndpointPairs: -1 })).toThrow(/unique_endpoint_pairs/)
  })

  it('rejects an unknown terminal reason', () => {
    expect(() => build({ terminalReasonCounts: { not_a_reason: 1 } as never }))
      .toThrow(/unknown reason/)
  })

  it('rejects retention that keeps more than it saw', () => {
    expect(() => build({ unresolvedRetention: { retained: 5, total: 2 } }))
      .toThrow(/retained 5 exceeds total 2/)
  })

  it('rejects retention above the declared per-kind bound', () => {
    const over = MAX_DURABLE_RECORDS_PER_KIND + 1
    expect(() => build({ rejectedRetention: { retained: over, total: over } }))
      .toThrow(/exceeds the per-kind bound/)
  })
})

describe('status is derived, never supplied', () => {
  it('is not an input to the builder', () => {
    expect(Object.keys(input())).not.toContain('status')
  })

  it('derives valid for a clean run with stable endpoints', () => {
    expect(build().status).toBe('valid')
  })

  it('derives degraded from unresolved candidates', () => {
    const receipt = build({
      emittedCandidates: 4,
      counts: counts({ retained_new_fact: 3, unresolved: 1 }),
      terminalReasonCounts: { missing_target_endpoint: 1 },
      unresolvedRetention: { retained: 1, total: 1 },
    })
    expect(receipt.status).toBe('degraded')
    expect(receipt.missing_target_endpoints).toBe(1)
  })

  it('derives invalid from an invariant failure', () => {
    const receipt = build({
      emittedCandidates: 4,
      counts: counts({ retained_new_fact: 3, invariant_failed: 1 }),
    })
    expect(receipt.status).toBe('invalid')
  })

  it('caps at valid_with_warnings while endpoints remain qualified', () => {
    expect(build({ endpointFactPairCounts: matrix({ unknown: { unknown: 3 } }) }).status)
      .toBe('valid_with_warnings')
  })

  it('caps at valid_with_warnings when the run retained a partial discriminator', () => {
    const receipt = build({ terminalReasonCounts: { partial_discriminator: 3 } })
    expect(receipt.status).toBe('valid_with_warnings')
    expect(receipt.reasons).toContain('partial_discriminator_retained')
  })

  it('re-derives the partial-discriminator warning on load', () => {
    const receipt = build({ terminalReasonCounts: { partial_discriminator: 3 } })
    expect(() => assertNormalizedIntegrityReceipt(receipt)).not.toThrow()
    const forged = { ...receipt, status: 'valid' as const }
    expect(() => assertNormalizedIntegrityReceipt(forged))
      .toThrow(/disagrees with its own counters/)
  })
})

describe('named counters are derived from the reason breakdown', () => {
  it('mirrors the four named counters out of terminal_reason_counts', () => {
    const receipt = build({
      emittedCandidates: 7,
      counts: counts({ retained_new_fact: 3, unresolved: 2, rejected: 2 }),
      terminalReasonCounts: {
        missing_source_endpoint: 1,
        missing_target_endpoint: 1,
        malformed_candidate: 1,
        unsupported_relation: 1,
      },
      unresolvedRetention: { retained: 2, total: 2 },
      rejectedRetention: { retained: 2, total: 2 },
    })
    expect(receipt.missing_source_endpoints).toBe(1)
    expect(receipt.missing_target_endpoints).toBe(1)
    expect(receipt.malformed_candidates).toBe(1)
    expect(receipt.unsupported_relations).toBe(1)
  })

  it('reports an asserted zero rather than omitting an absent reason', () => {
    const receipt = build()
    expect(receipt.missing_source_endpoints).toBe(0)
    expect(receipt.unsupported_relations).toBe(0)
  })
})

describe('truncation is disclosed, never silent', () => {
  it('adds the truncation reason exactly when a kind was truncated', () => {
    const receipt = build({
      emittedCandidates: 13,
      counts: counts({ retained_new_fact: 3, unresolved: 10 }),
      unresolvedRetention: { retained: 4, total: 10 },
    })
    expect(receipt.reasons).toContain('durable_records_truncated')
    expect(receipt.durable_records.unresolved).toEqual({ retained: 4, total: 10 })
  })

  it('omits the truncation reason when nothing was dropped', () => {
    expect(build().reasons).not.toContain('durable_records_truncated')
  })

  it('publishes the bound so a reader can see what the cap was', () => {
    expect(build().durable_records.max_records_per_kind).toBe(MAX_DURABLE_RECORDS_PER_KIND)
  })
})

describe('strict mode cannot claim a pass it did not earn', () => {
  it('allows pass on a valid run', () => {
    expect(build({ strictModeResult: 'pass' }).strict_mode_result).toBe('pass')
  })

  it('allows pass on valid_with_warnings', () => {
    expect(() => build({
      strictModeResult: 'pass',
      endpointFactPairCounts: matrix({ unknown: { unknown: 3 } }),
    })).not.toThrow()
  })

  it.each(['degraded', 'invalid'] as const)('refuses pass while status is %s', (status) => {
    expect(() => assertStrictModeResultPolicy('pass', status))
      .toThrow(/cannot be pass while integrity status is/)
  })

  it('refuses a result outside the declared set', () => {
    expect(() => assertStrictModeResultPolicy('maybe' as never, 'valid'))
      .toThrow(/is not a declared result/)
  })

  it('allows fail and not_run at any status', () => {
    expect(() => assertStrictModeResultPolicy('fail', 'invalid')).not.toThrow()
    expect(() => assertStrictModeResultPolicy('not_run', 'degraded')).not.toThrow()
  })
})

describe('the breakdown is deterministic and mirrors the named counters', () => {
  it('emits terminal_reason_counts with sorted keys', () => {
    const receipt = build({
      emittedCandidates: 7,
      counts: counts({ retained_new_fact: 3, unresolved: 2, rejected: 2 }),
      terminalReasonCounts: {
        unsupported_relation: 2,
        missing_target_endpoint: 1,
        malformed_candidate: 1,
      },
      unresolvedRetention: { retained: 2, total: 2 },
      rejectedRetention: { retained: 2, total: 2 },
    })
    const keys = Object.keys(receipt.terminal_reason_counts)
    expect(keys).toEqual([...keys].sort())
    expect(keys).toEqual(['malformed_candidate', 'missing_target_endpoint', 'unsupported_relation'])
  })

  it('is insertion-order independent, so two equivalent runs agree', () => {
    const shared = {
      emittedCandidates: 7,
      counts: counts({ retained_new_fact: 3, unresolved: 2, rejected: 2 }),
      unresolvedRetention: { retained: 2, total: 2 },
      rejectedRetention: { retained: 2, total: 2 },
    }
    const forward = build({
      ...shared,
      terminalReasonCounts: { malformed_candidate: 1, unsupported_relation: 2 },
    })
    const reversed = build({
      ...shared,
      terminalReasonCounts: { unsupported_relation: 2, malformed_candidate: 1 },
    })
    expect(Object.keys(reversed.terminal_reason_counts))
      .toEqual(Object.keys(forward.terminal_reason_counts))
  })

  it('omits a zero-valued reason rather than carrying it', () => {
    const receipt = build({
      emittedCandidates: 4,
      counts: counts({ retained_new_fact: 3, rejected: 1 }),
      terminalReasonCounts: { unsupported_relation: 1, malformed_candidate: 0 },
      rejectedRetention: { retained: 1, total: 1 },
    })
    expect(receipt.terminal_reason_counts).toEqual({ unsupported_relation: 1 })
    expect(receipt.terminal_reason_counts).not.toHaveProperty('malformed_candidate')
    expect(receipt.malformed_candidates).toBe(0)
  })

  it('rejects a zero smuggled into the breakdown on load', () => {
    const receipt = build()
    const tampered = { ...receipt, terminal_reason_counts: { malformed_candidate: 0 } }
    expect(() => assertNormalizedIntegrityReceipt(tampered))
      .toThrow(/must be omitted rather than zero/)
  })

  it('rejects an unsorted breakdown on load', () => {
    const receipt = build()
    const tampered = {
      ...receipt,
      terminal_reason_counts: { unsupported_relation: 1, malformed_candidate: 1 },
      unsupported_relations: 1,
      malformed_candidates: 1,
      terminal_counts: counts({ retained_new_fact: 1, rejected: 2 }),
      emitted_candidates: 3,
      rejectedRetention: undefined,
    } as unknown as GraphIntegrityReceiptV1
    expect(() => assertNormalizedIntegrityReceipt(tampered)).toThrow(/keys must be sorted/)
  })

  it('rejects a named counter that disagrees with its own breakdown', () => {
    const receipt = build({
      emittedCandidates: 4,
      counts: counts({ retained_new_fact: 3, rejected: 1 }),
      terminalReasonCounts: { unsupported_relation: 1 },
      rejectedRetention: { retained: 1, total: 1 },
    })
    const tampered = { ...receipt, unsupported_relations: 0 }
    expect(() => assertNormalizedIntegrityReceipt(tampered))
      .toThrow(/unsupported_relations is 0 but terminal_reason_counts.unsupported_relation is 1/)
  })
})

describe('the builder enforces the strict-mode policy itself', () => {
  // Asserting the policy function directly is not enough: the builder could
  // stop calling it and every direct-policy test would still pass.
  it('refuses to build a receipt claiming a strict pass on a degraded run', () => {
    expect(() => build({
      strictModeResult: 'pass',
      emittedCandidates: 4,
      counts: counts({ retained_new_fact: 3, unresolved: 1 }),
      unresolvedRetention: { retained: 1, total: 1 },
    })).toThrow(/cannot be pass while integrity status is degraded/)
  })

  it('refuses to build a receipt claiming a strict pass on an invalid run', () => {
    expect(() => build({
      strictModeResult: 'pass',
      emittedCandidates: 4,
      counts: counts({ retained_new_fact: 3, invariant_failed: 1 }),
    })).toThrow(/cannot be pass while integrity status is invalid/)
  })
})

describe('validation re-derives status so the field cannot be forged', () => {
  it('accepts a receipt the builder produced', () => {
    expect(() => assertNormalizedIntegrityReceipt(build())).not.toThrow()
  })

  it('rejects a status tampered to look better than its counters', () => {
    const forged = { ...build({
      emittedCandidates: 4,
      counts: counts({ retained_new_fact: 3, unresolved: 1 }),
      unresolvedRetention: { retained: 1, total: 1 },
    }), status: 'valid' as const }
    expect(() => assertNormalizedIntegrityReceipt(forged))
      .toThrow(/disagrees with its own counters/)
  })

  it('rejects tampered terminal counts', () => {
    const tampered = { ...build(), terminal_counts: counts({ retained_new_fact: 2 }) }
    expect(() => assertNormalizedIntegrityReceipt(tampered)).toThrow(/candidate accounting mismatch/)
  })

  it('rejects a tampered fact total that breaks the matrix partition', () => {
    const tampered = { ...build(), facts_retained: 4 }
    expect(() => assertNormalizedIntegrityReceipt(tampered)).toThrow(/partition sums to 3, expected 4/)
  })

  it('rejects a foreign accounting scope', () => {
    const tampered = { ...build(), accounting_scope: 'storage_only' as never }
    expect(() => assertNormalizedIntegrityReceipt(tampered)).toThrow(/accounting_scope must be/)
  })

  it('rejects an unsupported receipt or vocabulary version', () => {
    expect(() => assertNormalizedIntegrityReceipt({ ...build(), receipt_version: 2 as never }))
      .toThrow(/unsupported receipt_version/)
    expect(() => assertNormalizedIntegrityReceipt({ ...build(), reason_vocabulary_version: 2 as never }))
      .toThrow(/unsupported reason_vocabulary_version/)
  })

  it('rejects reasons that are unsorted, duplicated or unknown', () => {
    const receipt = build({ endpointFactPairCounts: matrix({ unknown: { unknown: 3 } }) })
    expect(() => assertNormalizedIntegrityReceipt({ ...receipt, reasons: [...receipt.reasons].reverse() }))
      .toThrow(/must be sorted/)
    expect(() => assertNormalizedIntegrityReceipt({
      ...receipt,
      reasons: [...receipt.reasons, receipt.reasons[0]!].sort(),
    })).toThrow(/must be unique/)
    expect(() => assertNormalizedIntegrityReceipt({ ...receipt, reasons: ['invented' as never] }))
      .toThrow(/unknown reason/)
  })

  it('rejects a truncation that was not disclosed', () => {
    const receipt = build({
      emittedCandidates: 13,
      counts: counts({ retained_new_fact: 3, unresolved: 10 }),
      unresolvedRetention: { retained: 4, total: 10 },
    })
    const hidden = { ...receipt, reasons: receipt.reasons.filter((reason) => reason !== 'durable_records_truncated') }
    expect(() => assertNormalizedIntegrityReceipt(hidden))
      .toThrow(/must be disclosed exactly when a record kind was truncated/)
  })

  it('rejects a disclosure with nothing actually truncated', () => {
    const receipt = build()
    const overclaimed = { ...receipt, reasons: [...receipt.reasons, 'durable_records_truncated' as const].sort() }
    expect(() => assertNormalizedIntegrityReceipt(overclaimed))
      .toThrow(/must be disclosed exactly when a record kind was truncated/)
  })

  it('rejects endpoint statuses reordered away from their declared order', () => {
    const receipt = build()
    const reordered = {
      ...receipt,
      endpoint_identity: {
        ...receipt.endpoint_identity,
        statuses: [...ENDPOINT_IDENTITY_STATUSES].reverse() as never,
      },
    }
    expect(() => assertNormalizedIntegrityReceipt(reordered)).toThrow(/declared order/)
  })

  it('rejects a named counter larger than the candidates that could carry it', () => {
    // Breakdown and named counter agree, so this can only be caught by the
    // bound against the candidates that actually ended unresolved or rejected.
    const tampered = {
      ...build(),
      missing_target_endpoints: 2,
      terminal_reason_counts: { missing_target_endpoint: 2 },
    }
    expect(() => assertNormalizedIntegrityReceipt(tampered))
      .toThrow(/but only 0 candidates were unresolved or rejected/)
  })

  it('rejects reasons that are well-formed but not what the counters imply', () => {
    // Sorted, unique, known, and truncation-consistent -- so this can only be
    // caught by comparing against the reasons the receipt's own numbers derive.
    const receipt = build({ endpointFactPairCounts: matrix({ unknown: { unknown: 3 } }) })
    expect(receipt.reasons).toContain('unknown_endpoint_identity')
    const stripped = {
      ...receipt,
      reasons: receipt.reasons.filter((reason) => reason !== 'unknown_endpoint_identity'),
    }
    expect(() => assertNormalizedIntegrityReceipt(stripped))
      .toThrow(/reasons disagree with the receipt they describe/)
  })

  it('rejects an extra well-formed reason the counters do not support', () => {
    const receipt = build({ endpointFactPairCounts: matrix({ unknown: { unknown: 3 } }) })
    const inflated = {
      ...receipt,
      reasons: [...receipt.reasons, 'context_bound_endpoint_identity' as const].sort(),
    }
    expect(() => assertNormalizedIntegrityReceipt(inflated))
      .toThrow(/reasons disagree with the receipt they describe/)
  })

  it('rejects a strict pass beside a degraded status', () => {
    const receipt = build({
      emittedCandidates: 4,
      counts: counts({ retained_new_fact: 3, unresolved: 1 }),
      unresolvedRetention: { retained: 1, total: 1 },
    })
    expect(() => assertNormalizedIntegrityReceipt({ ...receipt, strict_mode_result: 'pass' }))
      .toThrow(/cannot be pass while integrity status is degraded/)
  })
})

describe('storage_admission is a projection, never an addend', () => {
  const receipt = (): GraphIntegrityReceiptV1 => build({
    emittedCandidates: 5,
    counts: counts({ retained_new_fact: 3, rejected: 2 }),
    terminalReasonCounts: { unsupported_relation: 2 },
    rejectedRetention: { retained: 2, total: 2 },
  })

  it('accepts a storage count that matches the normalized sub-bucket', () => {
    expect(() => assertStorageAdmissionProjection(2, receipt())).not.toThrow()
  })

  it('rejects a storage count that drifted from the normalized sub-bucket', () => {
    expect(() => assertStorageAdmissionProjection(3, receipt()))
      .toThrow(/storage admission counted 3 unregistered relations but the normalized receipt counted 2/)
  })

  // The double-count this rule exists to prevent: the same refusal added once
  // at storage depth and again at the normalized boundary.
  it('does not add the storage count into the candidate equation', () => {
    const built = receipt()
    const terminalSum = Object.values(built.terminal_counts).reduce((total, count) => total + count, 0)
    expect(terminalSum).toBe(built.emitted_candidates)
    expect(built.emitted_candidates).toBe(5)
  })

  it('refuses a negative storage count', () => {
    expect(() => assertStorageAdmissionProjection(-1, receipt())).toThrow(/non-negative safe integer/)
  })
})

describe('graph totals are reported beside the equation, never inside it', () => {
  it('lets facts, occurrences and pairs differ from the candidate count', () => {
    const receipt = build({
      emittedCandidates: 6,
      counts: counts({
        retained_new_fact: 2,
        retained_additional_occurrence: 2,
        deliberately_merged_duplicate: 2,
      }),
      factsRetained: 2,
      occurrencesRetained: 4,
      uniqueEndpointPairs: 1,
      endpointFactPairCounts: matrix({ stable: { stable: 2 } }),
    })
    expect(receipt.emitted_candidates).toBe(6)
    expect(receipt.facts_retained).toBe(2)
    expect(receipt.occurrences_retained).toBe(4)
    expect(receipt.unique_endpoint_pairs).toBe(1)
    expect(() => assertNormalizedIntegrityReceipt(receipt)).not.toThrow()
  })
})
