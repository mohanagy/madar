import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  GraphIntegrityInvariantError,
  MAX_CONFLICT_FINGERPRINTS,
  MAX_DURABLE_RECORDS_PER_KIND,
  MAX_RECORD_OCCURRENCES,
  conflictFingerprintSetDigest,
  conflictRecordIdentityPayload,
  contentAddressOf,
} from '../../src/contracts/graph-integrity.js'
import { assertSerializerFacingRecord } from '../../src/contracts/graph-integrity-validation.js'

/**
 * Per-record detail caps, enforced on the untrusted path.
 *
 * Construction bounds each record's detail array with a kind-specific cap:
 * `MAX_RECORD_OCCURRENCES` (16) for an unresolved record's occurrences,
 * `MAX_CONFLICT_FINGERPRINTS` (32) for a conflict record's fingerprints. The
 * serializer-facing validator, which exists precisely to re-derive those
 * guarantees for data it did not construct, compared both against
 * `MAX_DURABLE_RECORDS_PER_KIND` (1000) instead.
 *
 * That is not a stricter-than-necessary check, it is a check of a different
 * thing: 1000 bounds how many RECORDS a kind may carry, not how much detail one
 * record may carry. A record claiming 900 retained occurrences passed, so the
 * documented per-record caps were enforced only where the data was already
 * trusted and not at all where it was not.
 *
 * The cap and cap+1 pairs matter together. Cap-only would pass a validator that
 * rejected everything; cap+1-only would pass one that rejected nothing near the
 * boundary. Only both together pin the boundary where the contract puts it.
 */

const hash = (input: string): string => createHash('sha256').update(input).digest('hex')

function occurrence(index: number): Record<string, unknown> {
  return {
    id: `eo_${hash(`occurrence-${index}`)}`,
    factId: `sf_${hash(`fact-${index}`)}`,
    owner: { adapterId: 'builtin:test', strategy: 'synthetic' },
    provenance: [],
    confidenceObservations: [],
    metadata: {},
  }
}

/** An unresolved record carrying exactly `count` occurrences, self-consistent. */
function unresolvedWith(count: number): Record<string, unknown> {
  const occurrences = Array.from({ length: count }, (_, index) => occurrence(index))
  return {
    kind: 'unresolved',
    // An unresolved id is NOT rederived by the validator -- it keys on the
    // original endpoints while the record carries their redacted projection --
    // so a well-formed id is all this fixture needs, and the cap check is
    // reached rather than pre-empted by an identity mismatch.
    id: `uc_${hash('unresolved-fixture')}`,
    candidateFingerprint: `cf_${hash('fingerprint-fixture')}`,
    multiplicity: 1,
    reasons: ['unresolved_internal_target'],
    verificationTargets: [],
    occurrences,
    // Claim and array agree, so `assertRecordRetention` passes and the cap
    // check is what decides the verdict.
    occurrenceRetention: { retained: count, total: count, omitted: 0, truncated: false },
  }
}

/** A conflict record carrying exactly `count` fingerprints, self-consistent. */
function conflictWith(count: number): Record<string, unknown> {
  const fingerprints = Array.from({ length: count }, (_, index) => `cf_${hash(`conflict-${index}`)}`)
  const reasons = ['conflicting_behavior_metadata']
  // Truncated, so the validator does not rederive the complete-set digest from
  // a list that is by definition a subset. The id still keys on the digest and
  // the reasons, both of which are carried, so it rederives exactly.
  const fingerprintSetDigest = conflictFingerprintSetDigest(fingerprints)
  return {
    kind: 'conflicting',
    id: contentAddressOf('cc_', conflictRecordIdentityPayload({
      fingerprintSetDigest,
      reasons: reasons as never,
    })),
    multiplicity: 1,
    reasons,
    verificationTargets: [],
    candidateFingerprints: fingerprints,
    fingerprintRetention: { retained: count, total: count + 1, omitted: 1, truncated: true },
    fingerprintSetDigest,
  }
}

const check = (record: Record<string, unknown>, kind: 'unresolved' | 'conflicting') =>
  () => assertSerializerFacingRecord(record, kind, 'record')

describe('B-01 — the caps are distinct constants, not one shared bound', () => {
  it('keeps the per-record caps far below the per-kind bound', () => {
    // If these ever coincided, every assertion below would still pass while
    // proving nothing about which constant the validator consulted.
    expect(MAX_RECORD_OCCURRENCES).toBe(16)
    expect(MAX_CONFLICT_FINGERPRINTS).toBe(32)
    expect(MAX_DURABLE_RECORDS_PER_KIND).toBe(1000)
    expect(MAX_RECORD_OCCURRENCES).toBeLessThan(MAX_DURABLE_RECORDS_PER_KIND)
    expect(MAX_CONFLICT_FINGERPRINTS).toBeLessThan(MAX_DURABLE_RECORDS_PER_KIND)
    expect(MAX_RECORD_OCCURRENCES).not.toBe(MAX_CONFLICT_FINGERPRINTS)
  })
})

describe('B-01 — an unresolved record is bounded by the occurrence cap', () => {
  it(`accepts exactly ${MAX_RECORD_OCCURRENCES} occurrences`, () => {
    expect(check(unresolvedWith(MAX_RECORD_OCCURRENCES), 'unresolved')).not.toThrow()
  })

  it(`refuses ${MAX_RECORD_OCCURRENCES + 1} occurrences`, () => {
    expect(check(unresolvedWith(MAX_RECORD_OCCURRENCES + 1), 'unresolved'))
      .toThrow(GraphIntegrityInvariantError)
  })

  it('names the per-record bound rather than the per-kind one', () => {
    expect(check(unresolvedWith(MAX_RECORD_OCCURRENCES + 1), 'unresolved'))
      .toThrow(/per-record bound of 16/)
  })

  it('refuses the count the old per-kind bound would have accepted', () => {
    // The reviewer's reproduction, stated exactly: 900 is comfortably under
    // 1000 and was accepted, and is 56x the documented per-record cap.
    expect(check(unresolvedWith(900), 'unresolved')).toThrow(GraphIntegrityInvariantError)
  })
})

describe('B-01 — a conflict record is bounded by the fingerprint cap', () => {
  it(`accepts exactly ${MAX_CONFLICT_FINGERPRINTS} fingerprints`, () => {
    expect(check(conflictWith(MAX_CONFLICT_FINGERPRINTS), 'conflicting')).not.toThrow()
  })

  it(`refuses ${MAX_CONFLICT_FINGERPRINTS + 1} fingerprints`, () => {
    expect(check(conflictWith(MAX_CONFLICT_FINGERPRINTS + 1), 'conflicting'))
      .toThrow(GraphIntegrityInvariantError)
  })

  it('names the per-record bound rather than the per-kind one', () => {
    expect(check(conflictWith(MAX_CONFLICT_FINGERPRINTS + 1), 'conflicting'))
      .toThrow(/per-record bound of 32/)
  })

  it('does not borrow the occurrence cap', () => {
    // A conflict record with 20 fingerprints is legal and would be refused if
    // the two kinds shared the smaller constant.
    expect(check(conflictWith(MAX_RECORD_OCCURRENCES + 4), 'conflicting')).not.toThrow()
  })
})

describe('B-01 — the claim and the array are both bounded', () => {
  it('refuses a record whose claimed retention exceeds the cap', () => {
    // Array within the cap, claim above it. `assertRecordRetention` catches the
    // disagreement first, which is correct; this states that the record is
    // refused rather than silently reconciled.
    const record = unresolvedWith(MAX_RECORD_OCCURRENCES)
    record['occurrenceRetention'] = {
      retained: MAX_RECORD_OCCURRENCES + 5, total: MAX_RECORD_OCCURRENCES + 5, omitted: 0, truncated: false,
    }
    expect(check(record, 'unresolved')).toThrow(GraphIntegrityInvariantError)
  })

  it('refuses a conflict record whose claimed retention exceeds the cap', () => {
    const record = conflictWith(MAX_CONFLICT_FINGERPRINTS)
    record['fingerprintRetention'] = {
      retained: MAX_CONFLICT_FINGERPRINTS + 5, total: MAX_CONFLICT_FINGERPRINTS + 6, omitted: 1, truncated: true,
    }
    expect(check(record, 'conflicting')).toThrow(GraphIntegrityInvariantError)
  })
})
