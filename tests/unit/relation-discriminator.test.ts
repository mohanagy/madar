import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  isRegisteredRelation,
  RELATION_DISCRIMINATOR_REGISTRY_ID,
  RELATION_DISCRIMINATOR_REGISTRY_V1,
  REGISTERED_RELATIONS,
  RelationDiscriminatorInvariantError,
  resolveRelationDiscriminator,
} from '../../src/contracts/relation-discriminator.js'

// Relations recovered by the authoritative producer inventory are listed
// individually alongside the originals: the guard stays exhaustive per relation
// rather than collapsing into a count that any future omission could satisfy.
const RECOVERED_ENDPOINT_ONLY = [
  'covered_by',
  'guards',
  'intercepts',
  'module_exports',
  'module_imports',
  'module_provides',
  'pipes',
  'related_to',
  'return_type',
] as const

// Relations no producer emits but production consumers dispatch on by name.
const CONSUMED_ENDPOINT_ONLY = [
  'guarded_by',
  'reads_env',
  'uses_config',
] as const

const RECOVERED_PARTIAL = [
  'changed_in',
  'controller_route',
  'exports',
  'param_type',
  'route_handler',
] as const

const ENDPOINT_ONLY = [
  'cites',
  'contains',
  'declares',
  'declares_controller',
  'defines_action',
  'defines_selector',
  'extends',
  'implements',
  'inherits',
  'loads_route',
  'method',
  'provides',
  'rationale_for',
  'references',
  'registers_controller',
  'renders',
  'shared_across_repos',
  'submits_route',
] as const

const PARTIAL = [
  'calls',
  'depends_on',
  'enqueues_job',
  'handles_route',
  'imports',
  'imports_from',
  'injects',
  'middleware',
  'mounts_router',
  'registered_in_store',
  'registers_route',
  'updates_slice',
  'uses',
  'uses_guard',
  'uses_interceptor',
  'uses_pipe',
] as const

describe('relation discriminator registry v1', () => {
  it('registers exactly the 51 producer and consumer relations under the required identifier', () => {
    // The identifier stays /1: artifact v2 has not shipped, and no previously
    // registered relation changed policy, so no stored fact identity moves.
    expect(RELATION_DISCRIMINATOR_REGISTRY_ID).toBe('madar.relation-discriminator-registry/1')
    expect([...REGISTERED_RELATIONS].sort()).toEqual(
      [...ENDPOINT_ONLY, ...PARTIAL, ...RECOVERED_ENDPOINT_ONLY, ...RECOVERED_PARTIAL, ...CONSUMED_ENDPOINT_ONLY].sort(),
    )
    expect(Object.keys(RELATION_DISCRIMINATOR_REGISTRY_V1).sort()).toEqual([...REGISTERED_RELATIONS].sort())
    expect(REGISTERED_RELATIONS).toHaveLength(51)
  })

  it('gives every recovered relation the completeness its producer supports', () => {
    for (const relation of [...RECOVERED_ENDPOINT_ONLY, ...CONSUMED_ENDPOINT_ONLY]) {
      expect(RELATION_DISCRIMINATOR_REGISTRY_V1[relation].completeness).toBe('endpoint_only')
    }
    for (const relation of RECOVERED_PARTIAL) {
      expect(RELATION_DISCRIMINATOR_REGISTRY_V1[relation].completeness).toBe('partial')
      expect(RELATION_DISCRIMINATOR_REGISTRY_V1[relation].reasons.length).toBeGreaterThan(0)
    }
  })

  it('marks the 18 structural relations as explicit endpoint-only policies', () => {
    for (const relation of ENDPOINT_ONLY) {
      expect(RELATION_DISCRIMINATOR_REGISTRY_V1[relation]).toEqual({
        relation,
        policyVersion: 1,
        completeness: 'endpoint_only',
        canonicalValue: null,
        reasons: [],
      })
    }
  })

  it('marks all 16 behavior relations partial with specific missing-datum reasons', () => {
    for (const relation of PARTIAL) {
      const policy = RELATION_DISCRIMINATOR_REGISTRY_V1[relation]
      expect(policy.completeness).toBe('partial')
      expect(policy.canonicalValue).toBe(null)
      expect(policy.reasons.length).toBeGreaterThan(0)
      expect(policy.reasons.every((reason) => reason.endsWith('_missing'))).toBe(true)
    }
  })

  it('has zero full discriminator policies today', () => {
    expect(Object.values(RELATION_DISCRIMINATOR_REGISTRY_V1).filter((entry) => (
      entry.completeness === 'full'
    ))).toEqual([])
  })

  it('resolves registered relations without inventing discriminator data', () => {
    expect(resolveRelationDiscriminator('calls')).toEqual({
      status: 'registered',
      storageDisposition: 'retain_degraded',
      factIdentityEligible: true,
      discriminator: {
        registryId: 'madar.relation-discriminator-registry/1',
        policyVersion: 1,
        completeness: 'partial',
        canonicalValue: null,
        reasons: RELATION_DISCRIMINATOR_REGISTRY_V1.calls.reasons,
      },
    })
  })

  it('accepts explicit partial discriminator data but rejects it for endpoint-only identity', () => {
    const calls = resolveRelationDiscriminator('calls', { invocation_kind: 'construct' })
    expect(calls.status).toBe('registered')
    if (calls.status !== 'registered') throw new Error('calls must be registered')
    expect(calls.discriminator.canonicalValue).toEqual({ invocation_kind: 'construct' })

    expect(() => resolveRelationDiscriminator('contains', { role: 'member' })).toThrow(
      RelationDiscriminatorInvariantError,
    )
  })

  it('has no implicit endpoint-only fallback for an unregistered relation', () => {
    expect(resolveRelationDiscriminator('unregistered_relation')).toEqual({
      status: 'unregistered',
      storageDisposition: 'unresolved_degraded',
      factIdentityEligible: false,
      relation: 'unregistered_relation',
      reasons: ['relation_not_registered'],
    })
  })
})

describe('registry completeness against real producers', () => {
  it('registers every relation the SPI projector can emit', async () => {
    // Regression: the Stage 0 enumeration grepped createEdge/relation: literals and missed
    // the projector's mapping table, where relations are object-literal VALUES. That left
    // extends, implements and registers_controller unregistered — and an unregistered
    // relation is not fact-identity eligible, so real SPI facts would have been degraded.
    const source = readFileSync(
      resolve(import.meta.dirname, '../../src/pipeline/spi/projector.ts'),
      'utf8',
    )
    const table = /const SPI_TO_EXTRACTION_RELATION[^=]*=\s*\{([\s\S]*?)\}/.exec(source)
    expect(table, 'SPI_TO_EXTRACTION_RELATION table not found').not.toBeNull()

    const emitted = [...table![1]!.matchAll(/:\s*'([a-z_]+)'/g)].map((match) => match[1]!)
    expect(emitted.length).toBeGreaterThan(0)

    const unregistered = emitted.filter((relation) => !isRegisteredRelation(relation))
    expect(unregistered, `unregistered SPI relations: ${unregistered.join(', ')}`).toEqual([])
  })
})

describe('registry completeness against non-SPI producers', () => {
  it('registers every relation present in the committed extraction fixture', () => {
    // The SPI mapping guard above only covers the projector. Legacy and framework
    // extractors emit relations through createEdge literals, which no single table
    // lists — so pin them against real committed extraction output instead of a grep.
    const fixture = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../fixtures/extraction.json'), 'utf8'),
    ) as { edges?: Array<{ relation?: unknown }> }

    const emitted = [...new Set((fixture.edges ?? [])
      .map((edge) => edge.relation)
      .filter((relation): relation is string => typeof relation === 'string'))]
    expect(emitted.length).toBeGreaterThan(0)

    const unregistered = emitted.filter((relation) => !isRegisteredRelation(relation))
    expect(unregistered, `unregistered fixture relations: ${unregistered.join(', ')}`).toEqual([])
  })
})
