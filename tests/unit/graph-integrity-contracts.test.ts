import { describe, expect, it } from 'vitest'

import { ENDPOINT_IDENTITY_STATUSES, type EndpointIdentityStatus } from '../../src/contracts/endpoint-identity.js'
import {
  CANDIDATE_TERMINAL_STATES,
  CandidateRecordIdentityFactory,
  DurableRecordCollisionError,
  GRAPH_INTEGRITY_REASON_VOCABULARY_VERSION,
  GraphIntegrityInvariantError,
  MAX_DURABLE_RECORDS_PER_KIND,
  MAX_VERIFICATION_TARGETS_PER_RECORD,
  assertCandidateAccountingEquation,
  assertEndpointMatrixPartition,
  boundDurableRecords,
  deriveIntegrityStatus,
  emptyTerminalCounts,
  normalizeVerificationTargets,
  sortDurableRecords,
  type CandidateTerminalCounts,
  type EndpointIdentityFactMatrix,
  type IntegrityVerificationTarget,
} from '../../src/contracts/graph-integrity.js'

function counts(overrides: Partial<CandidateTerminalCounts> = {}): CandidateTerminalCounts {
  return { ...emptyTerminalCounts(), ...overrides }
}

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

const CLEAN_STATUS_INPUT = {
  counts: counts(),
  endpointReasonFactCounts: {},
  matrix: matrix(),
  recordsTruncated: false,
  legacyArtifact: false,
  retainedPartialDiscriminators: 0,
}

describe('candidate terminal states', () => {
  it('declares exactly the seven states the ADR names, in a frozen order', () => {
    expect([...CANDIDATE_TERMINAL_STATES]).toEqual([
      'retained_new_fact',
      'retained_additional_occurrence',
      'deliberately_merged_duplicate',
      'unresolved',
      'rejected',
      'conflicting',
      'invariant_failed',
    ])
    expect(Object.isFrozen(CANDIDATE_TERMINAL_STATES)).toBe(true)
  })

  it('starts every counter at an asserted zero rather than an absent field', () => {
    const empty = emptyTerminalCounts()
    for (const state of CANDIDATE_TERMINAL_STATES) {
      expect(empty[state], state).toBe(0)
    }
  })
})

describe('the candidate accounting equation is enforced, not reported', () => {
  it('accepts a balanced ledger across all seven states', () => {
    const balanced = counts({
      retained_new_fact: 10,
      retained_additional_occurrence: 4,
      deliberately_merged_duplicate: 3,
      unresolved: 2,
      rejected: 1,
      conflicting: 5,
      invariant_failed: 6,
    })
    expect(() => assertCandidateAccountingEquation(31, balanced)).not.toThrow()
  })

  it('throws when one candidate is unaccounted for', () => {
    expect(() => assertCandidateAccountingEquation(31, counts({ retained_new_fact: 30 })))
      .toThrow(/candidate accounting mismatch: emitted 31, terminal states sum to 30/)
  })

  it('throws when a candidate is counted twice', () => {
    expect(() => assertCandidateAccountingEquation(1, counts({ retained_new_fact: 1, unresolved: 1 })))
      .toThrow(/terminal states sum to 2/)
  })

  // Mutation control: an equation that only tolerated undercounting would pass
  // the previous test while letting double-counting through.
  it('rejects both directions of imbalance, not just one', () => {
    expect(() => assertCandidateAccountingEquation(5, counts({ retained_new_fact: 4 }))).toThrow()
    expect(() => assertCandidateAccountingEquation(5, counts({ retained_new_fact: 6 }))).toThrow()
  })

  it('refuses negative, fractional and unsafe counters', () => {
    expect(() => assertCandidateAccountingEquation(1, counts({ retained_new_fact: -1 })))
      .toThrow(/must be a non-negative safe integer/)
    expect(() => assertCandidateAccountingEquation(1, counts({ retained_new_fact: 1.5 })))
      .toThrow(/must be a non-negative safe integer/)
    expect(() => assertCandidateAccountingEquation(1, counts({ retained_new_fact: Number.MAX_SAFE_INTEGER + 10 })))
      .toThrow(/must be a non-negative safe integer/)
    expect(() => assertCandidateAccountingEquation(Number.NaN, counts()))
      .toThrow(/must be a non-negative safe integer/)
  })

  it('refuses a sum that would silently pass the safe-integer boundary', () => {
    const overflowing = counts({
      retained_new_fact: Number.MAX_SAFE_INTEGER,
      unresolved: Number.MAX_SAFE_INTEGER,
    })
    expect(() => assertCandidateAccountingEquation(Number.MAX_SAFE_INTEGER, overflowing))
      .toThrow(/exceeds the safe integer range/)
  })
})

describe('integrity status has exactly one owner', () => {
  it('is valid only when every candidate terminated cleanly and no endpoint is qualified', () => {
    const derived = deriveIntegrityStatus({ ...CLEAN_STATUS_INPUT, counts: counts({ retained_new_fact: 3 }) })
    expect(derived.status).toBe('valid')
  })

  it('always discloses that raw adapter emission is not accounted for', () => {
    expect(deriveIntegrityStatus(CLEAN_STATUS_INPUT).reasons).toContain('full_emission_accounting_not_available')
  })

  it('is invalid when any candidate failed a systemic invariant', () => {
    const derived = deriveIntegrityStatus({ ...CLEAN_STATUS_INPUT, counts: counts({ invariant_failed: 1 }) })
    expect(derived.status).toBe('invalid')
  })

  it('lets invariant failure outrank every other degradation', () => {
    const derived = deriveIntegrityStatus({
      ...CLEAN_STATUS_INPUT,
      counts: counts({ retained_new_fact: 9, unresolved: 5, invariant_failed: 1 }),
      recordsTruncated: true,
      legacyArtifact: true,
    })
    expect(derived.status).toBe('invalid')
  })

  it.each(['unresolved', 'rejected', 'conflicting'] as const)('degrades on a %s candidate', (state) => {
    const derived = deriveIntegrityStatus({ ...CLEAN_STATUS_INPUT, counts: counts({ [state]: 1 }) })
    expect(derived.status).toBe('degraded')
  })

  it('does not degrade merely because candidates merged or added occurrences', () => {
    const derived = deriveIntegrityStatus({
      ...CLEAN_STATUS_INPUT,
      counts: counts({
        retained_new_fact: 4,
        retained_additional_occurrence: 3,
        deliberately_merged_duplicate: 2,
      }),
    })
    expect(derived.status).toBe('valid')
  })

  it('degrades and discloses when durable records were truncated', () => {
    const derived = deriveIntegrityStatus({ ...CLEAN_STATUS_INPUT, recordsTruncated: true })
    expect(derived.status).toBe('degraded')
    expect(derived.reasons).toContain('durable_records_truncated')
  })

  it('degrades and discloses for a legacy artifact', () => {
    const derived = deriveIntegrityStatus({ ...CLEAN_STATUS_INPUT, legacyArtifact: true })
    expect(derived.status).toBe('degraded')
    expect(derived.reasons).toContain('legacy_artifact')
  })

  it('caps at valid_with_warnings while any endpoint identity is still qualified', () => {
    const derived = deriveIntegrityStatus({
      ...CLEAN_STATUS_INPUT,
      counts: counts({ retained_new_fact: 2 }),
      matrix: matrix({ unknown: { unknown: 2 } }),
    })
    expect(derived.status).toBe('valid_with_warnings')
    expect(derived.reasons).toContain('unknown_endpoint_identity')
  })

  it.each([
    ['context_bound', 'context_bound_endpoint_identity'],
    ['unknown', 'unknown_endpoint_identity'],
    ['legacy', 'legacy_endpoint_identity'],
  ] as const)('reports %s endpoints as an explicit integrity reason', (status, reason) => {
    const derived = deriveIntegrityStatus({
      ...CLEAN_STATUS_INPUT,
      counts: counts({ retained_new_fact: 1 }),
      matrix: matrix({ [status]: { [status]: 1 } }),
    })
    expect(derived.reasons).toContain(reason)
    expect(derived.status).not.toBe('valid')
  })

  it('reads degradation from a reason counter the matrix alone would not surface', () => {
    const derived = deriveIntegrityStatus({
      ...CLEAN_STATUS_INPUT,
      counts: counts({ retained_new_fact: 1 }),
      matrix: matrix({ stable: { stable: 1 } }),
      endpointReasonFactCounts: { legacy_identity_policy: 1 },
    })
    expect(derived.reasons).toContain('legacy_endpoint_identity')
    expect(derived.status).toBe('valid_with_warnings')
  })

  // Completing candidate accounting must never repair an endpoint identity.
  it('never upgrades a qualified endpoint just because the ledger balances', () => {
    const qualified = matrix({ context_bound: { unknown: 7 } })
    const derived = deriveIntegrityStatus({
      ...CLEAN_STATUS_INPUT,
      counts: counts({ retained_new_fact: 7 }),
      matrix: qualified,
    })
    expect(derived.status).not.toBe('valid')
    expect(derived.reasons).toEqual(expect.arrayContaining([
      'context_bound_endpoint_identity',
      'unknown_endpoint_identity',
    ]))
  })

  it('emits reasons sorted and unique so two runs agree byte for byte', () => {
    const derived = deriveIntegrityStatus({
      ...CLEAN_STATUS_INPUT,
      matrix: matrix({ unknown: { unknown: 1 }, legacy: { legacy: 1 } }),
      counts: counts({ retained_new_fact: 2 }),
      recordsTruncated: true,
    })
    expect([...derived.reasons]).toEqual([...derived.reasons].sort())
    expect(new Set(derived.reasons).size).toBe(derived.reasons.length)
  })

  it('caps at valid_with_warnings when a retained candidate had a partial discriminator', () => {
    // partial_discriminator is the only reason that attaches to a candidate
    // which WAS retained, so the counters alone cannot reveal it.
    const derived = deriveIntegrityStatus({
      ...CLEAN_STATUS_INPUT,
      counts: counts({ retained_new_fact: 5 }),
      matrix: matrix({ stable: { stable: 5 } }),
      retainedPartialDiscriminators: 5,
    })
    expect(derived.status).toBe('valid_with_warnings')
    expect(derived.reasons).toContain('partial_discriminator_retained')
  })

  it('does not claim a partial discriminator when none was retained', () => {
    const derived = deriveIntegrityStatus({
      ...CLEAN_STATUS_INPUT,
      counts: counts({ retained_new_fact: 5 }),
      matrix: matrix({ stable: { stable: 5 } }),
    })
    expect(derived.status).toBe('valid')
    expect(derived.reasons).not.toContain('partial_discriminator_retained')
  })

  it('still degrades rather than warns when a candidate also failed to terminate cleanly', () => {
    const derived = deriveIntegrityStatus({
      ...CLEAN_STATUS_INPUT,
      counts: counts({ retained_new_fact: 4, unresolved: 1 }),
      matrix: matrix({ stable: { stable: 4 } }),
      retainedPartialDiscriminators: 4,
    })
    expect(derived.status).toBe('degraded')
    expect(derived.reasons).toContain('partial_discriminator_retained')
  })

  it('never derives incompatible, which only a loader may set', () => {
    for (const state of CANDIDATE_TERMINAL_STATES) {
      const derived = deriveIntegrityStatus({ ...CLEAN_STATUS_INPUT, counts: counts({ [state]: 1 }) })
      expect(derived.status, state).not.toBe('incompatible')
    }
  })
})

describe('the endpoint matrix stays a partition over stored facts', () => {
  it('accepts a matrix that sums exactly to the retained facts', () => {
    expect(() => assertEndpointMatrixPartition(matrix({ unknown: { unknown: 5 } }), 5)).not.toThrow()
  })

  it('refuses a matrix that omits a retained fact', () => {
    expect(() => assertEndpointMatrixPartition(matrix({ unknown: { unknown: 4 } }), 5))
      .toThrow(/partition sums to 4, expected 5/)
  })

  // The safety property: a candidate that never became a fact cannot be
  // smuggled into a cell to make a total look complete.
  it('refuses a non-fact candidate smuggled into a cell', () => {
    expect(() => assertEndpointMatrixPartition(matrix({ unknown: { unknown: 6 } }), 5))
      .toThrow(/partition sums to 6, expected 5/)
  })

  it('refuses a missing row rather than treating it as zero', () => {
    const incomplete = { ...matrix() } as Record<string, unknown>
    delete incomplete.legacy
    expect(() => assertEndpointMatrixPartition(incomplete as EndpointIdentityFactMatrix, 0))
      .toThrow(/missing row legacy/)
  })

  it('refuses negative and fractional cells', () => {
    expect(() => assertEndpointMatrixPartition(matrix({ stable: { stable: -1 } }), 0)).toThrow(/safe integer/)
    expect(() => assertEndpointMatrixPartition(matrix({ stable: { stable: 0.5 } }), 0.5)).toThrow(/safe integer/)
  })
})

describe('durable record identity is deterministic and content-derived', () => {
  const draft = {
    candidateFingerprint: 'cf_alpha',
    multiplicity: 1,
    source: 'a',
    target: 'b',
    relation: 'imports_from',
    reasons: ['missing_target_endpoint'] as const,
  }

  it('derives a full untruncated sha-256 id with a kind prefix', () => {
    const record = new CandidateRecordIdentityFactory().createUnresolvedRecord(draft)
    expect(record.id).toMatch(/^uc_[a-f0-9]{64}$/)
  })

  it('gives each record kind its own prefix', () => {
    const factory = new CandidateRecordIdentityFactory()
    expect(factory.createUnresolvedRecord(draft).id).toMatch(/^uc_/)
    expect(factory.createRejectedRecord({
      candidateFingerprint: 'cf_alpha',
      multiplicity: 1,
      sanitizedCandidate: { relation: 'nope' },
      reasons: ['unsupported_relation'],
    }).id).toMatch(/^rc_/)
    expect(factory.createConflictRecord({
      candidateFingerprints: ['cf_a', 'cf_b'],
      multiplicity: 2,
      reasons: ['conflicting_behavior_metadata'],
    }).id).toMatch(/^cc_/)
  })

  it('reproduces the same id across independent factories', () => {
    const first = new CandidateRecordIdentityFactory().createUnresolvedRecord(draft)
    const second = new CandidateRecordIdentityFactory().createUnresolvedRecord(draft)
    expect(first.id).toBe(second.id)
  })

  it('does not fold multiplicity into identity, so repeats collapse onto one id', () => {
    const factory = new CandidateRecordIdentityFactory()
    const once = factory.createUnresolvedRecord({ ...draft, multiplicity: 1 })
    const many = factory.createUnresolvedRecord({ ...draft, multiplicity: 9 })
    expect(many.id).toBe(once.id)
    expect(many.multiplicity).toBe(9)
  })

  it('separates records that differ in any identity-bearing field', () => {
    const factory = new CandidateRecordIdentityFactory()
    const base = factory.createUnresolvedRecord(draft)
    expect(factory.createUnresolvedRecord({ ...draft, target: 'c' }).id).not.toBe(base.id)
    expect(factory.createUnresolvedRecord({ ...draft, relation: 'calls' }).id).not.toBe(base.id)
    expect(factory.createUnresolvedRecord({ ...draft, candidateFingerprint: 'cf_beta' }).id).not.toBe(base.id)
    expect(factory.createUnresolvedRecord({ ...draft, reasons: ['missing_source_endpoint'] }).id).not.toBe(base.id)
  })

  it('is a fatal error when one id is derived from two different payloads', () => {
    const collidingHash = (): string => 'a'.repeat(64)
    const factory = new CandidateRecordIdentityFactory(collidingHash)
    factory.createUnresolvedRecord(draft)
    expect(() => factory.createUnresolvedRecord({ ...draft, target: 'different' }))
      .toThrow(DurableRecordCollisionError)
  })

  it('refuses a hash that is not full lowercase sha-256 hex', () => {
    const truncating = (): string => 'abc123'
    expect(() => new CandidateRecordIdentityFactory(truncating).createUnresolvedRecord(draft))
      .toThrow(/full lowercase SHA-256 hex/)
  })

  it('scopes collision witnesses to the factory so they die with the operation', () => {
    const factory = new CandidateRecordIdentityFactory()
    expect(factory.witnessCount).toBe(0)
    factory.createUnresolvedRecord(draft)
    expect(factory.witnessCount).toBe(1)
    expect(new CandidateRecordIdentityFactory().witnessCount).toBe(0)
  })

  it('pins the reason vocabulary version into record identity', () => {
    // A silent vocabulary change must not leave stale ids looking current.
    expect(GRAPH_INTEGRITY_REASON_VOCABULARY_VERSION).toBe(1)
  })

  it('sorts and de-duplicates reasons so ordering cannot change an id', () => {
    const factory = new CandidateRecordIdentityFactory()
    const forward = factory.createUnresolvedRecord({
      ...draft,
      reasons: ['missing_target_endpoint', 'unresolved_internal_target'],
    })
    const reversed = factory.createUnresolvedRecord({
      ...draft,
      reasons: ['unresolved_internal_target', 'missing_target_endpoint', 'missing_target_endpoint'],
    })
    expect(reversed.id).toBe(forward.id)
    expect([...forward.reasons]).toEqual(['missing_target_endpoint', 'unresolved_internal_target'])
  })

  it('refuses a record that names no reason', () => {
    expect(() => new CandidateRecordIdentityFactory().createUnresolvedRecord({ ...draft, reasons: [] }))
      .toThrow(/must name at least one reason/)
  })

  it('refuses an unknown reason rather than passing it through', () => {
    expect(() => new CandidateRecordIdentityFactory().createUnresolvedRecord({
      ...draft,
      reasons: ['not_a_real_reason' as never],
    })).toThrow(/unknown reason/)
  })

  it('refuses a non-positive multiplicity', () => {
    const factory = new CandidateRecordIdentityFactory()
    expect(() => factory.createUnresolvedRecord({ ...draft, multiplicity: 0 })).toThrow(/positive safe integer/)
    expect(() => factory.createUnresolvedRecord({ ...draft, multiplicity: 2.5 })).toThrow(/positive safe integer/)
  })

  it('keeps a conflict group order-independent so nobody wins by arriving first', () => {
    const factory = new CandidateRecordIdentityFactory()
    const forward = factory.createConflictRecord({
      candidateFingerprints: ['cf_b', 'cf_a'],
      multiplicity: 2,
      reasons: ['conflicting_behavior_metadata'],
    })
    const reversed = factory.createConflictRecord({
      candidateFingerprints: ['cf_a', 'cf_b'],
      multiplicity: 2,
      reasons: ['conflicting_behavior_metadata'],
    })
    expect(reversed.id).toBe(forward.id)
    expect([...forward.candidateFingerprints]).toEqual(['cf_a', 'cf_b'])
  })

  it('refuses a conflict group with fewer than two members', () => {
    expect(() => new CandidateRecordIdentityFactory().createConflictRecord({
      candidateFingerprints: ['cf_only'],
      multiplicity: 1,
      reasons: ['conflicting_behavior_metadata'],
    })).toThrow(/at least two candidates/)
  })

  it('orders a record\'s occurrences deterministically', () => {
    const occurrence = (id: string): never => ({ id, factId: 'sf_x' }) as never
    const record = new CandidateRecordIdentityFactory().createUnresolvedRecord({
      ...draft,
      occurrences: [occurrence('eo_c'), occurrence('eo_a'), occurrence('eo_b')],
    })
    expect(record.occurrences.map((entry) => entry.id)).toEqual(['eo_a', 'eo_b', 'eo_c'])
  })
})

describe('verification targets are share-safe', () => {
  const target = (file: string): IntegrityVerificationTarget => ({
    file,
    reason: 'unresolved_internal_target',
  })

  it('keeps repository-relative targets', () => {
    expect(normalizeVerificationTargets([target('src/pipeline/build.ts')], 'test'))
      .toEqual([{ file: 'src/pipeline/build.ts', reason: 'unresolved_internal_target' }])
  })

  it('drops an absolute path rather than leaking a checkout root', () => {
    expect(normalizeVerificationTargets([target('/Users/someone/madar/src/a.ts')], 'test')).toEqual([])
  })

  it('drops a windows drive path and a url', () => {
    expect(normalizeVerificationTargets([target('C:/madar/src/a.ts')], 'test')).toEqual([])
    expect(normalizeVerificationTargets([target('https://example.com/a.ts')], 'test')).toEqual([])
  })

  it('drops a path that escapes the repository', () => {
    expect(normalizeVerificationTargets([target('../../etc/passwd')], 'test')).toEqual([])
  })

  it('normalizes separators and redundant segments', () => {
    expect(normalizeVerificationTargets([target('src\\pipeline\\.\\build.ts')], 'test'))
      .toEqual([{ file: 'src/pipeline/build.ts', reason: 'unresolved_internal_target' }])
  })

  it('de-duplicates and orders targets deterministically', () => {
    const normalized = normalizeVerificationTargets(
      [target('src/c.ts'), target('src/a.ts'), target('src/c.ts'), target('src/b.ts')],
      'test',
    )
    expect(normalized.map((entry) => entry.file)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
  })

  it('bounds the target list so one candidate cannot carry an unbounded set', () => {
    const many = Array.from({ length: 40 }, (_, index) => target(`src/f${String(index).padStart(3, '0')}.ts`))
    expect(normalizeVerificationTargets(many, 'test')).toHaveLength(MAX_VERIFICATION_TARGETS_PER_RECORD)
  })

  it('refuses a target carrying an unknown reason', () => {
    expect(() => normalizeVerificationTargets([{ file: 'src/a.ts', reason: 'invented' as never }], 'test'))
      .toThrow(/unknown reason/)
  })

  it('never fabricates a target from an empty input', () => {
    expect(normalizeVerificationTargets([], 'test')).toEqual([])
  })

  it('rethrows an unexpected error instead of silently dropping the target', () => {
    // A bare catch would swallow a programming error and emit fewer hints while
    // looking healthy -- the failure mode this receipt exists to prevent.
    const hostile = {
      reason: 'unresolved_internal_target' as const,
      get file(): string { throw new TypeError('not a path lookup failure') },
    }
    expect(() => normalizeVerificationTargets([hostile], 'test')).toThrow(TypeError)
  })
})

describe('durable records are bounded and deterministically ordered', () => {
  const factory = new CandidateRecordIdentityFactory()
  const record = (fingerprint: string): ReturnType<typeof factory.createUnresolvedRecord> =>
    factory.createUnresolvedRecord({
      candidateFingerprint: fingerprint,
      multiplicity: 1,
      reasons: ['missing_target_endpoint'],
    })

  it('sorts by id, not by insertion order', () => {
    const records = [record('cf_c'), record('cf_a'), record('cf_b')]
    const forward = sortDurableRecords(records).map((entry) => entry.id)
    const reversed = sortDurableRecords([...records].reverse()).map((entry) => entry.id)
    expect(reversed).toEqual(forward)
    expect(forward).toEqual([...forward].sort())
  })

  it('reports retained and total identically when nothing is truncated', () => {
    const { records, retention } = boundDurableRecords([record('cf_a'), record('cf_b')])
    expect(records).toHaveLength(2)
    expect(retention).toEqual({ retained: 2, total: 2 })
  })

  it('discloses truncation with an exact retained and total pair', () => {
    const many = Array.from({ length: 12 }, (_, index) => record(`cf_${String(index).padStart(3, '0')}`))
    const { records, retention } = boundDurableRecords(many, 5)
    expect(records).toHaveLength(5)
    expect(retention).toEqual({ retained: 5, total: 12 })
  })

  it('truncates deterministically rather than keeping whichever arrived first', () => {
    const many = Array.from({ length: 12 }, (_, index) => record(`cf_${String(index).padStart(3, '0')}`))
    const forward = boundDurableRecords(many, 5).records.map((entry) => entry.id)
    const reversed = boundDurableRecords([...many].reverse(), 5).records.map((entry) => entry.id)
    expect(reversed).toEqual(forward)
  })

  it('defaults to the declared per-kind bound', () => {
    expect(MAX_DURABLE_RECORDS_PER_KIND).toBe(1000)
    const { retention } = boundDurableRecords([record('cf_a')])
    expect(retention.total).toBe(1)
  })
})

describe('the storage-only receipt from PR B cannot become valid here', () => {
  it('keeps full_emission_accounting_not_available on every derived status', () => {
    for (const state of CANDIDATE_TERMINAL_STATES) {
      const derived = deriveIntegrityStatus({ ...CLEAN_STATUS_INPUT, counts: counts({ [state]: 1 }) })
      expect(derived.reasons, state).toContain('full_emission_accounting_not_available')
    }
  })

  it('cannot reach valid while a legacy artifact is in play', () => {
    expect(deriveIntegrityStatus({ ...CLEAN_STATUS_INPUT, legacyArtifact: true }).status).toBe('degraded')
  })
})

describe('graph integrity errors are typed', () => {
  it('names itself so callers can distinguish it from an ordinary failure', () => {
    try {
      assertCandidateAccountingEquation(1, counts())
      expect.unreachable('expected an accounting mismatch')
    } catch (error) {
      expect(error).toBeInstanceOf(GraphIntegrityInvariantError)
      expect((error as Error).name).toBe('GraphIntegrityInvariantError')
    }
  })
})
