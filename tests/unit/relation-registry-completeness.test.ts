import { describe, expect, it } from 'vitest'

import {
  REGISTERED_RELATIONS,
  RELATION_DISCRIMINATOR_REGISTRY_V1,
  resolveRelationDiscriminator,
} from '../../src/contracts/relation-discriminator.js'
import { SPI_EDGE_KINDS } from '../../src/pipeline/spi/types.js'
import { SPI_TO_EXTRACTION_RELATION } from '../../src/pipeline/spi/projector.js'

/**
 * The five relations whose absence silently deleted graph facts, plus the nine
 * the same inventory found alongside them. Named individually so deleting any
 * one policy fails loudly rather than shrinking a count assertion.
 */
const RECOVERED_RELATIONS = [
  'changed_in',
  'controller_route',
  'covered_by',
  'exports',
  'guards',
  'intercepts',
  'module_exports',
  'module_imports',
  'module_provides',
  'param_type',
  'pipes',
  'related_to',
  'return_type',
  'route_handler',
] as const

/**
 * Relations no in-repository producer emits, but that production consumers
 * dispatch on by name. The producer inventory could not find these; only
 * reading the consumer allowlists did.
 */
const CONSUMED_RELATIONS = [
  'guarded_by',
  'reads_env',
  'uses_config',
] as const

const registered = (relation: string): boolean =>
  (resolveRelationDiscriminator(relation as never) as { status: string }).status === 'registered'

describe('relation registry completeness', () => {
  it('registers every SPI edge kind', () => {
    const missing = SPI_EDGE_KINDS.filter((kind) => !registered(kind))

    expect(missing, `unregistered SPI kinds: ${missing.join(', ')}`).toEqual([])
  })

  it('registers every projector mapping value', () => {
    const missing = Object.values(SPI_TO_EXTRACTION_RELATION)
      .filter((relation): relation is string => typeof relation === 'string')
      .filter((relation) => !registered(relation))

    expect(missing, `unregistered projector relations: ${missing.join(', ')}`).toEqual([])
  })

  it('keeps the SPI union and the runtime kind list identical', () => {
    // SpiEdgeKind is derived from SPI_EDGE_KINDS, so this pins that the
    // projector cannot map a kind the vocabulary does not declare.
    const declared = new Set<string>(SPI_EDGE_KINDS)
    const mapped = Object.keys(SPI_TO_EXTRACTION_RELATION).filter((kind) => !declared.has(kind))

    expect(mapped, `projector maps undeclared kinds: ${mapped.join(', ')}`).toEqual([])
  })

  it('registers every relation recovered by the authoritative inventory', () => {
    for (const relation of RECOVERED_RELATIONS) {
      expect(registered(relation), `${relation} must be registered`).toBe(true)
    }
  })

  it('gives each recovered relation an explicit policy, not a default', () => {
    for (const relation of RECOVERED_RELATIONS) {
      const policy = RELATION_DISCRIMINATOR_REGISTRY_V1[relation]
      expect(policy, `${relation} has no policy entry`).toBeDefined()
      expect(policy.relation).toBe(relation)
      expect(policy.policyVersion).toBe(1)
      expect(['endpoint_only', 'partial', 'full']).toContain(policy.completeness)
      if (policy.completeness === 'partial') {
        expect(policy.reasons.length, `${relation} partial policy must name its gaps`).toBeGreaterThan(0)
      }
    }
  })

  it('names the route and export gaps rather than inventing discriminator data', () => {
    expect(RELATION_DISCRIMINATOR_REGISTRY_V1.controller_route.reasons).toContain('http_method_missing')
    expect(RELATION_DISCRIMINATOR_REGISTRY_V1.route_handler.reasons).toContain('normalized_route_path_missing')
    expect(RELATION_DISCRIMINATOR_REGISTRY_V1.exports.reasons).toContain('exported_binding_missing')
    expect(RELATION_DISCRIMINATOR_REGISTRY_V1.param_type.reasons).toContain('parameter_position_missing')
    expect(RELATION_DISCRIMINATOR_REGISTRY_V1.changed_in.reasons).toContain('revision_identity_missing')
    // Structural links carry no behaviour data, so they stay endpoint-only
    // instead of gaining fabricated missing-field reasons.
    expect(RELATION_DISCRIMINATOR_REGISTRY_V1.covered_by.completeness).toBe('endpoint_only')
    expect(RELATION_DISCRIMINATOR_REGISTRY_V1.related_to.completeness).toBe('endpoint_only')
  })

  it('keeps every registry entry keyed by its own relation', () => {
    for (const relation of REGISTERED_RELATIONS) {
      expect(RELATION_DISCRIMINATOR_REGISTRY_V1[relation].relation).toBe(relation)
    }
    expect(Object.keys(RELATION_DISCRIMINATOR_REGISTRY_V1).length).toBe(REGISTERED_RELATIONS.length)
  })

  it('registers every relation a production consumer dispatches on', () => {
    // Pack config/env resolution, the retrieval helper-relation set and the
    // structural relationship diagnostic all match these by name. Refusing
    // them at admission would make those features permanently dead.
    for (const relation of CONSUMED_RELATIONS) {
      expect(registered(relation), `${relation} must be registered`).toBe(true)
    }
  })

  it('keeps the consumer allowlists inside the registry', () => {
    // Guards against a consumer gaining a relation the registry never learns
    // about, which is exactly how uses_config and reads_env were missed.
    const helperRelations = ['uses_guard', 'guarded_by', 'reads_env', 'uses_config', 'depends_on', 'covered_by', 'injects']
    const structuralRelations = ['calls', 'injects', 'depends_on', 'reads_env', 'uses_config']
    const missing = [...new Set([...helperRelations, ...structuralRelations])].filter((r) => !registered(r))

    expect(missing, `consumer relations missing from the registry: ${missing.join(', ')}`).toEqual([])
  })

  it('still refuses a relation nobody registered', () => {
    const resolution = resolveRelationDiscriminator('future_relation_not_registered' as never) as {
      status: string
      storageDisposition: string
      factIdentityEligible: boolean
    }

    expect(resolution.status).toBe('unregistered')
    expect(resolution.storageDisposition).toBe('unresolved_degraded')
    expect(resolution.factIdentityEligible).toBe(false)
  })
})
