import { describe, expect, it } from 'vitest'

import {
  ENDPOINT_CONSTRUCTOR_IDENTITY_INVENTORY,
  classifyEndpointConstructor,
  classifyEndpointIdentityPair,
  classifyLegacyEndpoint,
  isEndpointIdentityDegraded,
  normalizeEndpointIdentityQualification,
  validateEndpointIdentityQualification,
} from '../../src/contracts/endpoint-identity.js'

describe('endpoint identity qualification', () => {
  it('accepts stable endpoints only when they carry no degradation reason', () => {
    const qualification = validateEndpointIdentityQualification({
      source: { status: 'stable', reasons: [] },
      target: { status: 'stable', reasons: [] },
    })

    expect(qualification).toEqual({
      source: { status: 'stable', reasons: [] },
      target: { status: 'stable', reasons: [] },
    })
    expect(isEndpointIdentityDegraded(qualification)).toBe(false)
  })

  it('retains context-bound endpoints as visible degradation with the audited reason', () => {
    const qualification = validateEndpointIdentityQualification({
      source: { status: 'context_bound', reasons: ['source_location_derived'] },
      target: { status: 'stable', reasons: [] },
    })

    expect(qualification.source).toEqual({
      status: 'context_bound',
      reasons: ['source_location_derived'],
    })
    expect(isEndpointIdentityDegraded(qualification)).toBe(true)
  })

  it('retains unknown endpoints as declared degradation and never equates them with stable', () => {
    const qualification = validateEndpointIdentityQualification({
      source: { status: 'unknown', reasons: ['identity_policy_not_declared'] },
      target: { status: 'stable', reasons: [] },
    })

    expect(qualification.source).not.toEqual({ status: 'stable', reasons: [] })
    expect(qualification.source.reasons).toEqual(['identity_policy_not_declared'])
    expect(isEndpointIdentityDegraded(qualification)).toBe(true)
  })

  it('retains legacy identity only with its legacy policy reason', () => {
    const legacy = classifyLegacyEndpoint()

    expect(legacy).toEqual({ status: 'legacy', reasons: ['legacy_identity_policy'] })
    expect(isEndpointIdentityDegraded({ source: legacy, target: legacy })).toBe(true)
  })

  it('fails malformed status/reason combinations instead of normalizing them to unknown', () => {
    const malformed = [
      { source: { status: 'stable', reasons: ['source_location_derived'] }, target: { status: 'stable', reasons: [] } },
      { source: { status: 'context_bound', reasons: [] }, target: { status: 'stable', reasons: [] } },
      { source: { status: 'unknown', reasons: ['source_location_derived'] }, target: { status: 'stable', reasons: [] } },
      { source: { status: 'legacy', reasons: ['identity_policy_not_declared'] }, target: { status: 'stable', reasons: [] } },
    ]

    for (const value of malformed) {
      expect(() => validateEndpointIdentityQualification(value)).toThrow('Endpoint identity invariant failed')
    }
  })

  it('normalizes an omitted compatibility qualification explicitly to unknown, never stable', () => {
    expect(normalizeEndpointIdentityQualification({ id: 'compatibility-node' })).toEqual({
      source: { status: 'unknown', reasons: ['identity_policy_not_declared'] },
      target: { status: 'unknown', reasons: ['identity_policy_not_declared'] },
    })
  })

  it('distinguishes an absent property from a present but invalid qualification', () => {
    expect(() => normalizeEndpointIdentityQualification({ endpointIdentity: undefined })).toThrow(
      'Endpoint identity qualification must be an object',
    )
  })
})

describe('audited endpoint constructor policy', () => {
  it('classifies every audited constructor site from static inventory data', () => {
    const expectations = new Map<string, string>([
      ['src/pipeline/extract/frameworks/express.ts:86', 'source_location_derived'],
      ['src/pipeline/extract/frameworks/nest.ts:326', 'source_location_derived'],
      ['src/pipeline/extract/frameworks/react-router.ts:627', 'source_location_derived'],
      ['src/pipeline/extract/go-cross-file.ts:654', 'source_location_derived'],
      ['src/pipeline/extract/go-cross-file.ts:702', 'source_location_derived'],
      ['src/pipeline/extract/go-cross-file.ts:596', 'source_location_derived'],
      ['src/pipeline/extract/frameworks/express.ts:541', 'source_location_derived'],
      ['src/pipeline/extract/frameworks/express.ts:1167', 'source_location_derived'],
      ['src/pipeline/extract.ts:269', 'source_location_derived'],
      ['src/pipeline/extract/non-code.ts:2595', 'source_location_derived'],
      ['src/pipeline/extract/python-rationale.ts:117', 'source_location_derived'],
      ['src/pipeline/extract/frameworks/next.ts:90', 'absolute_workspace_path_derived'],
      ['src/pipeline/extract/frameworks/next.ts:95', 'absolute_workspace_path_derived'],
      ['src/pipeline/extract/frameworks/next.ts:99', 'absolute_workspace_path_derived'],
      ['src/pipeline/extract.ts:706', 'source_ordinal_derived'],
      ['src/pipeline/extract/non-code.ts:3080', 'source_ordinal_derived'],
      ['src/pipeline/extract/core.ts:68->114', 'collision_suffix_derived'],
      ['src/pipeline/spi/framework-express.ts:421', 'adapter_local_synthetic_identity'],
      ['src/pipeline/spi/framework-prisma.ts:239', 'adapter_local_synthetic_identity'],
      ['src/pipeline/spi/framework-prisma.ts:246', 'adapter_local_synthetic_identity'],
    ])

    expect(ENDPOINT_CONSTRUCTOR_IDENTITY_INVENTORY).toHaveLength(expectations.size)
    for (const entry of ENDPOINT_CONSTRUCTOR_IDENTITY_INVENTORY) {
      expect(entry.sites).toHaveLength(1)
      const reason = expectations.get(entry.sites[0]!)
      expect(reason).toBeDefined()
      expect(classifyEndpointConstructor(entry.id)).toEqual({
        status: 'context_bound',
        reasons: [reason],
      })
    }
  })

  it('classifies unaudited current constructors as unknown instead of inferring stability', () => {
    expect(classifyEndpointConstructor('current.constructor.not-in-stage-0-inventory')).toEqual({
      status: 'unknown',
      reasons: ['identity_policy_not_audited'],
    })
  })

  it('qualifies source and target independently', () => {
    const source = ENDPOINT_CONSTRUCTOR_IDENTITY_INVENTORY.find((entry) => (
      entry.reason === 'absolute_workspace_path_derived'
    ))!
    const target = ENDPOINT_CONSTRUCTOR_IDENTITY_INVENTORY.find((entry) => (
      entry.reason === 'source_ordinal_derived'
    ))!

    expect(classifyEndpointIdentityPair({ source: source.id, target: target.id })).toEqual({
      source: { status: 'context_bound', reasons: ['absolute_workspace_path_derived'] },
      target: { status: 'context_bound', reasons: ['source_ordinal_derived'] },
    })
  })
})
