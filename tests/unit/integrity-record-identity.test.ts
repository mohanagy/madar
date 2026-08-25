import { describe, expect, it } from 'vitest'

import {
  CandidateRecordIdentityFactory,
  conflictFingerprintSetDigest,
  conflictRecordIdentityPayload,
  contentAddressOf,
  GraphIntegrityInvariantError,
  MAX_CONFLICT_FINGERPRINTS,
} from '../../src/contracts/graph-integrity.js'
import { assertSerializerFacingRecord } from '../../src/contracts/graph-integrity-validation.js'

function expectTyped(run: () => unknown): void {
  let thrown: unknown
  try {
    run()
  } catch (error) {
    thrown = error
  }
  expect(thrown, 'expected a rejection').toBeDefined()
  expect(thrown).toBeInstanceOf(GraphIntegrityInvariantError)
  expect(thrown).not.toBeInstanceOf(TypeError)
}

const factory = (): CandidateRecordIdentityFactory => new CandidateRecordIdentityFactory()
const fingerprint = (seed: string): string => `cf_${seed.repeat(64).slice(0, 64)}`

/** A genuinely constructed rejected record, so its id is the real one. */
function rejected(): Record<string, unknown> {
  return { ...factory().createRejectedRecord({
    candidateFingerprint: fingerprint('a'),
    sanitizedCandidate: { source: 'src/alpha.ts' },
    multiplicity: 1,
    reasons: ['malformed_candidate'],
  }) } as unknown as Record<string, unknown>
}

function conflicting(members: readonly string[]): Record<string, unknown> {
  return { ...factory().createConflictRecord({
    candidateFingerprints: members,
    multiplicity: 1,
    reasons: ['conflicting_behavior_metadata'],
  }) } as unknown as Record<string, unknown>
}

const validate = (record: Record<string, unknown>, kind: 'rejected' | 'conflicting') =>
  () => assertSerializerFacingRecord(record, kind, 'record')

describe('V1-03 — a rejected record id is rederived from its own payload', () => {
  it('accepts a genuinely constructed record', () => {
    expect(validate(rejected(), 'rejected')).not.toThrow()
  })

  it('rejects a well-formed id belonging to a different record', () => {
    // The reviewer case: format-only validation accepted any rc_ plus 64 hex.
    const other = factory().createRejectedRecord({
      candidateFingerprint: fingerprint('b'),
      sanitizedCandidate: { source: 'src/beta.ts' },
      multiplicity: 1,
      reasons: ['malformed_candidate'],
    })
    expectTyped(validate({ ...rejected(), id: other.id }, 'rejected'))
  })

  it('rejects a payload edited without its id', () => {
    expectTyped(validate({ ...rejected(), sanitizedCandidate: { source: 'src/other.ts' } }, 'rejected'))
  })

  it('rejects a fingerprint swapped without its id', () => {
    expectTyped(validate({ ...rejected(), candidateFingerprint: fingerprint('c') }, 'rejected'))
  })

  it('rejects reasons edited without the id', () => {
    expectTyped(validate({ ...rejected(), reasons: ['unsupported_relation'] }, 'rejected'))
  })
})

describe('V1-03 — a conflict record id is rederived from its own payload', () => {
  const members = [fingerprint('a'), fingerprint('b'), fingerprint('c')]

  it('accepts a genuinely constructed record', () => {
    expect(validate(conflicting(members), 'conflicting')).not.toThrow()
  })

  it('rejects a well-formed id belonging to a different conflict group', () => {
    const other = conflicting([fingerprint('d'), fingerprint('e')])
    expectTyped(validate({ ...conflicting(members), id: other['id'] }, 'conflicting'))
  })

  it('rejects a digest swapped without the id', () => {
    const other = conflicting([fingerprint('d'), fingerprint('e')])
    expectTyped(validate({ ...conflicting(members), fingerprintSetDigest: other['fingerprintSetDigest'] }, 'conflicting'))
  })
})

describe('V1-03 — the complete-set digest is rederived only when it is complete', () => {
  const members = [fingerprint('a'), fingerprint('b'), fingerprint('c')]

  it('rederives the digest when the carried list is the whole set', () => {
    const record = conflicting(members)
    expect((record['fingerprintRetention'] as { truncated: boolean }).truncated).toBe(false)
    expect(record['fingerprintSetDigest'])
      .toBe(conflictFingerprintSetDigest([...members].sort()))
    expect(validate(record, 'conflicting')).not.toThrow()
  })

  it('rejects a wrong digest even when the id was recomputed to match it', () => {
    // Swapping the digest alone also breaks the id, so the id check would
    // catch it and the digest check would never be exercised. A tamperer would
    // recompute the id from the forged digest -- this does exactly that, so
    // only the complete-set comparison can catch it.
    const record = conflicting(members)
    const forged = conflictFingerprintSetDigest([fingerprint('z'), fingerprint('y')])
    const consistentId = contentAddressOf('cc_', conflictRecordIdentityPayload({
      fingerprintSetDigest: forged,
      reasons: record['reasons'] as never,
    }))
    expectTyped(validate({
      ...record,
      fingerprintSetDigest: forged,
      id: consistentId,
    }, 'conflicting'))
  })

  it('does not rederive the digest from a truncated subset', () => {
    // Capped: the carried list is a sample, so rederiving from it would compare
    // a subset digest against a complete-set digest and call the mismatch a
    // tamper on every legitimate capped record.
    const many = Array.from({ length: MAX_CONFLICT_FINGERPRINTS + 5 }, (_, index) => (
      `cf_${String(index).padStart(64, '0')}`
    ))
    const record = conflicting(many)
    expect((record['fingerprintRetention'] as { truncated: boolean }).truncated).toBe(true)
    expect(validate(record, 'conflicting')).not.toThrow()
  })

  it('still requires the digest format on a truncated record', () => {
    const many = Array.from({ length: MAX_CONFLICT_FINGERPRINTS + 5 }, (_, index) => (
      `cf_${String(index).padStart(64, '0')}`
    ))
    expectTyped(validate({ ...conflicting(many), fingerprintSetDigest: 'cs_short' }, 'conflicting'))
  })
})

describe('V1-03 — the unresolved fingerprint limit is stated, not faked', () => {
  it('validates the candidate fingerprint by format only', () => {
    // The fingerprint keys on the ORIGINAL endpoints while the record carries
    // their redacted projection, so a well-formed fingerprint belonging to
    // another candidate is not detectable. Claiming otherwise would only hold
    // on corpora where nothing needed redacting -- which is exactly how an
    // earlier false rederivation passed every fixture and failed the corpus.
    const source = readFileSyncSafe('src/contracts/graph-integrity-validation.ts')
    expect(source).toContain('rederiving from what it carries would only agree on corpora')
    expect(source).toContain("assertContentAddress(record['candidateFingerprint'], 'cf_'")
  })
})

function readFileSyncSafe(relative: string): string {
  // Imported lazily so the policy assertion above reads the shipped source
  // rather than a rebuilt copy.
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  return readFileSync(join(process.cwd(), relative), 'utf8')
}
