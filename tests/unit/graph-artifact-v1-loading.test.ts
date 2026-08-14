import { describe, expect, it } from 'vitest'

import {
  GRAPH_ARTIFACT_V2_HEADER,
  loadGraphArtifact,
  serializeGraphArtifactV2,
} from '../../src/contracts/graph-artifact.js'
import { GraphAdmissionError, KnowledgeGraph } from '../../src/contracts/graph.js'
import { createLegacyRelationDiscriminator } from '../../src/contracts/relation-discriminator.js'

function legacyArtifact(links: readonly Record<string, unknown>[]): Buffer {
  return Buffer.from(JSON.stringify({
    schema_version: 1,
    directed: true,
    nodes: [
      { id: 'source', label: 'Source' },
      { id: 'target', label: 'Target' },
    ],
    links,
    hyperedges: [],
    community_labels: { 0: 'Legacy' },
  }), 'utf8')
}

const parallelLinks = [
  { source: 'source', target: 'target', relation: 'calls', confidence: 'EXTRACTED' },
  { source: 'source', target: 'target', relation: 'calls', confidence: 'EXTRACTED' },
] as const

describe('graph artifact v1 degraded loading', () => {
  it('converts every parallel legacy link to a distinct fact and occurrence', () => {
    const loaded = loadGraphArtifact(legacyArtifact(parallelLinks))

    expect(loaded.format).toBe('v1')
    expect(loaded.graph.numberOfFacts()).toBe(2)
    expect(loaded.graph.numberOfOccurrences()).toBe(2)
    expect(loaded.graph.numberOfEndpointPairs()).toBe(1)
    expect(new Set(loaded.graph.factRecords().map(({ fact }) => fact.id))).toHaveLength(2)
    expect(new Set(loaded.graph.occurrenceEntries().map(({ id }) => id))).toHaveLength(2)
    for (const { fact } of loaded.graph.factRecords()) {
      expect(fact.discriminator).toMatchObject({
        legacy: true,
        completeness: 'partial',
        reasons: ['legacy_parallel_facts_unrecoverable'],
      })
      expect(fact.occurrenceIds).toHaveLength(1)
    }
  })

  it('classifies both endpoints as legacy and places facts in the legacy/legacy cell', () => {
    const loaded = loadGraphArtifact(legacyArtifact(parallelLinks))

    expect(loaded.graph.nodeEndpointIdentity('source')).toEqual({
      status: 'legacy',
      reasons: ['legacy_identity_policy'],
    })
    expect(loaded.graph.nodeEndpointIdentity('target')).toEqual({
      status: 'legacy',
      reasons: ['legacy_identity_policy'],
    })
    expect(loaded.receipt.status).toBe('degraded')
    expect(loaded.receipt.accounting_scope).toBe('storage_only')
    expect(loaded.receipt.endpoint_identity.fact_pair_counts.legacy.legacy).toBe(2)
    expect(loaded.receipt.endpoint_identity.reason_fact_counts).toEqual({ legacy_identity_policy: 2 })
    expect(loaded.diagnostics).toContain('legacy_parallel_facts_unrecoverable')
    expect(loaded.recommendation).toMatch(/regenerat/i)
    expect(loaded.receipt.reasons).toEqual([
      'full_emission_accounting_not_available',
      'legacy_identity_policy',
      'legacy_parallel_facts_unrecoverable',
      'regeneration_recommended',
    ])
  })

  it('allows bounded normal-mode use but rejects strict and qualification modes', () => {
    expect(loadGraphArtifact(legacyArtifact(parallelLinks), { mode: 'normal' }).format).toBe('v1')
    expect(() => loadGraphArtifact(legacyArtifact(parallelLinks), { mode: 'strict' })).toThrow(/legacy.*strict|strict.*legacy/i)
    expect(() => loadGraphArtifact(legacyArtifact(parallelLinks), { mode: 'qualification' })).toThrow(/legacy.*qualification|qualification.*legacy/i)
  })

  it('does not allow a legacy discriminator through the normal graph admission API', () => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.addNode('source', {})
    graph.addNode('target', {})
    const discriminator = createLegacyRelationDiscriminator('0'.repeat(64), 0)

    expect(() => graph.addEdge('source', 'target', { relation: 'calls' }, { discriminator })).toThrow(
      GraphAdmissionError,
    )
  })

  it('is deterministic for the same pure legacy JSON and never claims multiplicity recovery', () => {
    const first = loadGraphArtifact(legacyArtifact(parallelLinks))
    const second = loadGraphArtifact(legacyArtifact(parallelLinks))

    expect(first.graph.factRecords().map(({ fact }) => fact.id)).toEqual(
      second.graph.factRecords().map(({ fact }) => fact.id),
    )
    expect(first.graph.occurrenceEntries().map(({ id }) => id)).toEqual(
      second.graph.occurrenceEntries().map(({ id }) => id),
    )
    expect(first.diagnostics).not.toContain('legacy_multiplicity_recovered')
    expect(first.receipt.status).not.toBe('valid')
  })

  it('skips missing-endpoint links without putting them in the receipt matrix', () => {
    const loaded = loadGraphArtifact(legacyArtifact([
      parallelLinks[0],
      { source: 'source', target: 'missing', relation: 'calls' },
    ]))

    expect(loaded.graph.numberOfFacts()).toBe(1)
    expect(loaded.receipt.endpoint_identity.fact_pair_counts.legacy.legacy).toBe(1)
    expect(Object.values(loaded.receipt.endpoint_identity.fact_pair_counts)
      .flatMap(Object.values)
      .reduce((sum, count) => sum + count, 0)).toBe(1)
  })

  it('retains a surviving legacy link even when its historical relation is not in registry v1', () => {
    const loaded = loadGraphArtifact(legacyArtifact([
      { source: 'source', target: 'target', relation: 'historical_custom_relation' },
    ]))

    expect(loaded.graph.numberOfFacts()).toBe(1)
    expect(loaded.graph.factRecords()[0]?.fact.relation).toBe('historical_custom_relation')
    expect(loaded.graph.factRecords()[0]?.fact.discriminator.legacy).toBe(true)
  })

  it('round-trips converted legacy IDs and qualifications through v2', () => {
    const legacy = loadGraphArtifact(legacyArtifact(parallelLinks))
    const v2 = serializeGraphArtifactV2({
      graph: legacy.graph,
      repositoryRevision: 'legacy-unavailable',
      generationMode: 'legacy_v1_compatibility',
      generatedAt: 'legacy-unavailable',
      integrityReceipt: legacy.receipt,
    })
    const reloaded = loadGraphArtifact(v2)

    expect(v2.toString('utf8').startsWith(GRAPH_ARTIFACT_V2_HEADER)).toBe(true)
    expect(reloaded.graph.factRecords().map(({ fact }) => fact.id)).toEqual(
      legacy.graph.factRecords().map(({ fact }) => fact.id),
    )
    expect(reloaded.graph.occurrenceEntries().map(({ id }) => id)).toEqual(
      legacy.graph.occurrenceEntries().map(({ id }) => id),
    )
    expect(reloaded.graph.nodeEndpointIdentity('source')).toEqual(legacy.graph.nodeEndpointIdentity('source'))
  })

  it('does not down-classify a headerless v2 JSON payload as legacy', () => {
    const legacy = loadGraphArtifact(legacyArtifact([parallelLinks[0]]))
    const v2 = serializeGraphArtifactV2({
      graph: legacy.graph,
      repositoryRevision: 'legacy-unavailable',
      generationMode: 'legacy_v1_compatibility',
      generatedAt: 'legacy-unavailable',
      integrityReceipt: legacy.receipt,
    })
    const headerless = v2.subarray(Buffer.byteLength(GRAPH_ARTIFACT_V2_HEADER))

    expect(() => loadGraphArtifact(headerless)).toThrow(/header/i)
  })
})
