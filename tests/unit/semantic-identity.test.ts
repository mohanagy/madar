import { describe, expect, it } from 'vitest'

import type { EndpointIdentityQualification } from '../../src/contracts/endpoint-identity.js'
import {
  EVIDENCE_OCCURRENCE_IDENTITY_SCHEMA_VERSION,
  FatalIdentityCollisionError,
  SEMANTIC_FACT_IDENTITY_SCHEMA_VERSION,
  SemanticIdentityFactory,
  canonicalEndpointPair,
  createEvidenceOccurrenceId,
  createSemanticFact,
  createSemanticFactId,
} from '../../src/contracts/semantic-identity.js'
import {
  resolveRelationDiscriminator,
  type SemanticDiscriminator,
} from '../../src/contracts/relation-discriminator.js'

const STABLE_ENDPOINTS: EndpointIdentityQualification = {
  source: { status: 'stable', reasons: [] },
  target: { status: 'stable', reasons: [] },
}

function discriminator(relation: string): SemanticDiscriminator {
  const resolution = resolveRelationDiscriminator(relation)
  if (resolution.status !== 'registered') {
    throw new Error(`Fixture relation is not registered: ${relation}`)
  }
  return resolution.discriminator
}

const CONTAINS_DISCRIMINATOR = discriminator('contains')
const CALLS_DISCRIMINATOR = discriminator('calls')

function factInput(overrides: Record<string, unknown> = {}) {
  return {
    direction: 'directed' as const,
    source: 'node:alpha',
    target: 'node:beta',
    relation: 'contains' as const,
    discriminator: CONTAINS_DISCRIMINATOR,
    endpointIdentity: STABLE_ENDPOINTS,
    ...overrides,
  }
}

function occurrenceInput(factId: `sf_${string}`, overrides: Record<string, unknown> = {}) {
  return {
    factId,
    adapterId: 'typescript-semantic',
    strategy: 'ast',
    repositoryRelativeSourceFile: 'src/alpha.ts',
    sourceRange: {
      start: { line: 10, column: 2 },
      end: { line: 10, column: 15 },
    },
    repositoryRelativeTargetFile: 'src/beta.ts',
    targetRange: null,
    siteKind: 'call_expression',
    adapterEvidenceKey: null,
    ...overrides,
  }
}

describe('semantic fact identity', () => {
  it('publishes explicit identity schema versions', () => {
    expect(SEMANTIC_FACT_IDENTITY_SCHEMA_VERSION).toBe(1)
    expect(EVIDENCE_OCCURRENCE_IDENTITY_SCHEMA_VERSION).toBe(1)
  })

  it('preserves directed endpoint order', () => {
    const forward = createSemanticFactId(factInput())
    const reverse = createSemanticFactId(factInput({ source: 'node:beta', target: 'node:alpha' }))

    expect(forward).not.toBe(reverse)
  })

  it('uses the exact default lexical ordering from KnowledgeGraph.edgeKey for undirected endpoints', () => {
    const endpoints = ['\uE000', '\u{10000}'] as const
    expect(canonicalEndpointPair(...endpoints)).toEqual([...endpoints].sort())

    const forward = createSemanticFactId(factInput({
      direction: 'undirected',
      source: endpoints[0],
      target: endpoints[1],
    }))
    const reverse = createSemanticFactId(factInput({
      direction: 'undirected',
      source: endpoints[1],
      target: endpoints[0],
    }))

    expect(forward).toBe(reverse)
  })

  it('reproduces the full fact ID for an unchanged snapshot', () => {
    expect(createSemanticFactId(factInput())).toBe(
      'sf_9d8797f455ad3f414ccbb2cbdc5244a51a36a93bf1840ca9d80c40e936314435',
    )
  })

  it('excludes evidence ranges and mutable observations from fact identity', () => {
    const baseline = createSemanticFactId(factInput({
      sourceRange: { start: { line: 1, column: 0 }, end: { line: 1, column: 4 } },
      confidence: 'EXTRACTED',
      metadata: { score: 0.9 },
    }))
    const moved = createSemanticFactId(factInput({
      sourceRange: { start: { line: 99, column: 0 }, end: { line: 99, column: 4 } },
      confidence: 'INFERRED',
      metadata: { score: 0.1 },
    }))

    expect(moved).toBe(baseline)
  })

  it('fails fatally when different canonical fact payloads produce one hash', () => {
    const factory = new SemanticIdentityFactory(() => '0'.repeat(64))
    factory.createSemanticFactId(factInput())

    expect(() => factory.createSemanticFactId(factInput({ target: 'node:gamma' }))).toThrow(
      FatalIdentityCollisionError,
    )
  })
})

describe('evidence occurrence identity', () => {
  const factId = createSemanticFactId(factInput())

  it('includes evidence range while the corresponding fact ID excludes it', () => {
    const original = createEvidenceOccurrenceId(occurrenceInput(factId))
    const moved = createEvidenceOccurrenceId(occurrenceInput(factId, {
      sourceRange: {
        start: { line: 11, column: 2 },
        end: { line: 11, column: 15 },
      },
    }))

    expect(moved).not.toBe(original)
    expect(createSemanticFactId(factInput({ sourceRange: { line: 11 } }))).toBe(factId)
  })

  it('keeps observations from different adapters distinct', () => {
    expect(createEvidenceOccurrenceId(occurrenceInput(factId, { adapterId: 'legacy-tree-sitter' }))).not.toBe(
      createEvidenceOccurrenceId(occurrenceInput(factId)),
    )
  })

  it('keeps different evidence-site kinds distinct', () => {
    expect(createEvidenceOccurrenceId(occurrenceInput(factId, { siteKind: 'decorator' }))).not.toBe(
      createEvidenceOccurrenceId(occurrenceInput(factId, { siteKind: 'call_expression' })),
    )
  })

  it('reproduces one ID for the same adapter and site repeat', () => {
    expect(createEvidenceOccurrenceId(occurrenceInput(factId))).toBe(
      createEvidenceOccurrenceId(occurrenceInput(factId)),
    )
  })

  it('excludes confidence, timestamps, adapter version, absolute paths, and provenance order', () => {
    const original = createEvidenceOccurrenceId(occurrenceInput(factId, {
      confidence: 0.9,
      timestamp: '2026-08-14T00:00:00Z',
      adapterVersion: '1.0.0',
      absolutePath: '/checkout-a/src/alpha.ts',
      provenance: ['compiler', 'parser'],
    }))
    const changedObservations = createEvidenceOccurrenceId(occurrenceInput(factId, {
      confidence: 0.1,
      timestamp: '2026-08-15T00:00:00Z',
      adapterVersion: '2.0.0',
      absolutePath: '/checkout-b/src/alpha.ts',
      provenance: ['parser', 'compiler'],
    }))

    expect(changedObservations).toBe(original)
  })
})

describe('semantic fact model qualification', () => {
  it('proves the movement rule only for synthetic stable endpoints', () => {
    const callsInput = factInput({ relation: 'calls', discriminator: CALLS_DISCRIMINATOR })
    const callsFactId = createSemanticFactId(callsInput)
    const factAtLine10 = createSemanticFact({
      ...callsInput,
      occurrenceIds: [createEvidenceOccurrenceId(occurrenceInput(callsFactId, {
        sourceRange: { start: { line: 10, column: 0 }, end: { line: 10, column: 1 } },
      }))],
      annotations: {},
    })
    const factAtLine20 = createSemanticFact({
      ...callsInput,
      occurrenceIds: [createEvidenceOccurrenceId(occurrenceInput(callsFactId, {
        sourceRange: { start: { line: 20, column: 0 }, end: { line: 20, column: 1 } },
      }))],
      annotations: {},
    })

    expect(factAtLine20.id).toBe(factAtLine10.id)
    expect(factAtLine20.occurrenceIds).not.toEqual(factAtLine10.occurrenceIds)
    expect(factAtLine10.endpointIdentity).toEqual(STABLE_ENDPOINTS)
  })

  it('keeps undirected endpoint qualification aligned with canonical endpoint order', () => {
    const fact = createSemanticFact({
      ...factInput({
        direction: 'undirected',
        source: 'node:zeta',
        target: 'node:alpha',
        endpointIdentity: {
          source: { status: 'context_bound', reasons: ['source_ordinal_derived'] },
          target: { status: 'stable', reasons: [] },
        },
      }),
      occurrenceIds: [],
      annotations: {},
    })

    expect({ source: fact.source, target: fact.target, endpointIdentity: fact.endpointIdentity }).toEqual({
      source: 'node:alpha',
      target: 'node:zeta',
      endpointIdentity: {
        source: { status: 'stable', reasons: [] },
        target: { status: 'context_bound', reasons: ['source_ordinal_derived'] },
      },
    })
  })

  it('retains a context-bound fact with its known degradation reason', () => {
    const fact = createSemanticFact({
      ...factInput({
        endpointIdentity: {
          source: { status: 'context_bound', reasons: ['source_location_derived'] },
          target: { status: 'stable', reasons: [] },
        },
      }),
      occurrenceIds: [],
      annotations: {},
    })

    expect(fact.endpointIdentity.source).toEqual({
      status: 'context_bound',
      reasons: ['source_location_derived'],
    })
  })

  it('normalizes omitted qualification to explicit unknown and never stable', () => {
    const { endpointIdentity: _omitted, ...input } = factInput()
    const fact = createSemanticFact({ ...input, occurrenceIds: [], annotations: {} })

    expect(fact.endpointIdentity).toEqual({
      source: { status: 'unknown', reasons: ['identity_policy_not_declared'] },
      target: { status: 'unknown', reasons: ['identity_policy_not_declared'] },
    })
    expect(fact.endpointIdentity).not.toEqual(STABLE_ENDPOINTS)
  })

  it('retains legacy qualification as degradation', () => {
    const fact = createSemanticFact({
      ...factInput({
        endpointIdentity: {
          source: { status: 'legacy', reasons: ['legacy_identity_policy'] },
          target: { status: 'legacy', reasons: ['legacy_identity_policy'] },
        },
      }),
      occurrenceIds: [],
      annotations: {},
    })

    expect(fact.endpointIdentity.source.status).toBe('legacy')
    expect(fact.endpointIdentity.target.status).toBe('legacy')
  })

  it('rejects malformed qualification rather than normalizing it to unknown', () => {
    expect(() => createSemanticFact({
      ...factInput({
        endpointIdentity: {
          source: { status: 'stable', reasons: ['source_location_derived'] },
          target: { status: 'stable', reasons: [] },
        },
      }),
      occurrenceIds: [],
      annotations: {},
    })).toThrow('Endpoint identity invariant failed')
  })
})
