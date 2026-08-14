import { describe, expect, it } from 'vitest'

import {
  AmbiguousEdgeError,
  InvalidGraphEndpointQualificationError,
  KnowledgeGraph,
  MissingGraphEndpointError,
} from '../../src/contracts/graph.js'
import { EndpointIdentityInvariantError } from '../../src/contracts/endpoint-identity.js'
import { resolveRelationDiscriminator } from '../../src/contracts/relation-discriminator.js'
import { buildFromJson } from '../../src/pipeline/build.js'

function registeredDiscriminator(relation: 'calls', value: Record<string, string>) {
  const resolution = resolveRelationDiscriminator(relation, value)
  if (resolution.status !== 'registered') throw new Error('fixture relation must be registered')
  return resolution.discriminator
}

describe('KnowledgeGraph endpoint admission', () => {
  it('normalizes omitted node qualification to explicit unknown', () => {
    const graph = new KnowledgeGraph({ directed: true })

    graph.addNode('source', { label: 'Source' })

    expect(graph.nodeEndpointIdentity('source')).toEqual({
      status: 'unknown',
      reasons: ['identity_policy_not_declared'],
    })
  })

  it('rejects a missing endpoint without inserting a fact or creating a node', () => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.addNode('source', {})

    expect(() => graph.addEdge('source', 'missing', { relation: 'calls' })).toThrow(
      MissingGraphEndpointError,
    )
    expect(graph.hasNode('missing')).toBe(false)
    expect(graph.numberOfFacts()).toBe(0)
    expect(graph.numberOfEndpointPairs()).toBe(0)
  })

  it('rejects malformed node qualification instead of normalizing it', () => {
    const graph = new KnowledgeGraph({ directed: true })

    expect(() => graph.addNode('malformed', {
      endpointIdentity: { status: 'stable', reasons: ['source_location_derived'] },
    })).toThrow(EndpointIdentityInvariantError)
    expect(graph.hasNode('malformed')).toBe(false)
  })

  it('rejects a malformed qualification found in the stored endpoint index at addEdge', () => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.addNode('source', {})
    graph.addNode('target', {})
    const internal = graph as unknown as {
      nodeEndpointIdentityMap: Map<string, unknown>
    }
    internal.nodeEndpointIdentityMap.set('target', {
      status: 'stable',
      reasons: ['source_location_derived'],
    })

    expect(() => graph.addEdge('source', 'target', { relation: 'calls' })).toThrow(
      InvalidGraphEndpointQualificationError,
    )
    expect(graph.numberOfFacts()).toBe(0)
    expect(graph.numberOfEndpointPairs()).toBe(0)
  })

  it('marks every node and fact arriving through a v1 load path as legacy', () => {
    const graph = buildFromJson({
      schema_version: 1,
      nodes: [{ id: 'source' }, { id: 'target' }],
      edges: [{ source: 'source', target: 'target', relation: 'calls' }],
    }, { directed: true, validateExtraction: false })

    expect(graph.nodeEndpointIdentity('source')).toEqual({
      status: 'legacy',
      reasons: ['legacy_identity_policy'],
    })
    expect(graph.factRecords()[0]?.fact.endpointIdentity).toEqual({
      source: { status: 'legacy', reasons: ['legacy_identity_policy'] },
      target: { status: 'legacy', reasons: ['legacy_identity_policy'] },
    })
  })
})

describe('KnowledgeGraph semantic multigraph storage', () => {
  it('retains calls and injects facts on one endpoint pair without multiplying topology', () => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.addNode('source', {})
    graph.addNode('target', {})

    graph.addEdge('source', 'target', { relation: 'injects' })
    graph.addEdge('source', 'target', { relation: 'calls' })

    expect(graph.numberOfFacts()).toBe(2)
    expect(graph.numberOfEdges()).toBe(2)
    expect(graph.numberOfEndpointPairs()).toBe(1)
    expect(graph.numberOfOccurrences()).toBe(2)
    expect(graph.factEntries().map(([, , attributes]) => attributes.relation)).toEqual(['calls', 'injects'])
    expect(graph.endpointEntries()).toEqual([{ source: 'source', target: 'target' }])
    expect(graph.relationsBetween('source', 'target')).toEqual(['calls', 'injects'])
    expect(() => graph.edgeAttributes('source', 'target')).toThrow(AmbiguousEdgeError)
  })

  it('retains the same relation with different canonical discriminators as separate facts', () => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.addNode('source', {})
    graph.addNode('target', {})

    graph.addEdge('source', 'target', { relation: 'calls' }, {
      discriminator: registeredDiscriminator('calls', { invocation_kind: 'call' }),
    })
    graph.addEdge('source', 'target', { relation: 'calls' }, {
      discriminator: registeredDiscriminator('calls', { invocation_kind: 'construct' }),
    })

    expect(graph.numberOfFacts()).toBe(2)
    expect(graph.numberOfEndpointPairs()).toBe(1)
    expect(graph.relationsBetween('source', 'target')).toEqual(['calls'])
    expect(graph.factRecords().map(({ fact }) => (
      (fact.discriminator.canonicalValue as { invocation_kind: string }).invocation_kind
    )).sort()).toEqual(['call', 'construct'])
  })

  it('keeps an unregistered relation unresolved and out of fact and topology indexes', () => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.addNode('source', {})
    graph.addNode('target', {})

    expect(graph.addEdge('source', 'target', { relation: 'embeds' })).toEqual({
      status: 'unresolved_degraded',
      relation: 'embeds',
      reasons: ['relation_not_registered'],
    })
    expect(graph.numberOfFacts()).toBe(0)
    expect(graph.numberOfEndpointPairs()).toBe(0)
  })

  it('stores distinct sites and adapters as occurrences while exact repeats merge', () => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.addNode('source', {})
    graph.addNode('target', {})

    const first = graph.addEdge('source', 'target', { relation: 'calls' }, {
      occurrence: {
        owner: { adapterId: 'typescript-semantic', strategy: 'compiler' },
        sourceFile: 'src/source.ts',
        sourceRange: { start: { line: 10, column: 1 }, end: { line: 10, column: 8 } },
        siteKind: 'call_expression',
        provenance: [{ capability_id: 'compiler:calls', stage: 'extract' }],
        confidenceObservations: [{ confidence: 'EXTRACTED', score: 1 }],
        metadata: {},
      },
    })
    const repeatWithDisagreement = graph.addEdge('source', 'target', { relation: 'calls' }, {
      occurrence: {
        owner: { adapterId: 'typescript-semantic', strategy: 'compiler', adapterVersion: '2.0.0' },
        sourceFile: 'src/source.ts',
        sourceRange: { start: { line: 10, column: 1 }, end: { line: 10, column: 8 } },
        siteKind: 'call_expression',
        provenance: [{ capability_id: 'heuristic:corroboration', stage: 'extract' }],
        confidenceObservations: [{ confidence: 'INFERRED', score: 0.5 }],
        metadata: {},
      },
    })
    const secondSite = graph.addEdge('source', 'target', { relation: 'calls' }, {
      occurrence: {
        owner: { adapterId: 'typescript-semantic', strategy: 'compiler' },
        sourceFile: 'src/source.ts',
        sourceRange: { start: { line: 20, column: 1 }, end: { line: 20, column: 8 } },
        siteKind: 'call_expression',
        provenance: [],
        confidenceObservations: [],
        metadata: {},
      },
    })
    const secondAdapter = graph.addEdge('source', 'target', { relation: 'calls' }, {
      occurrence: {
        owner: { adapterId: 'tree-sitter', strategy: 'heuristic' },
        sourceFile: 'src/source.ts',
        sourceRange: { start: { line: 10, column: 1 }, end: { line: 10, column: 8 } },
        siteKind: 'call_expression',
        provenance: [],
        confidenceObservations: [],
        metadata: {},
      },
    })

    expect(first.status).toBe('stored')
    expect(repeatWithDisagreement.status).toBe('stored')
    expect(secondSite.status).toBe('stored')
    expect(secondAdapter.status).toBe('stored')
    if (
      first.status !== 'stored'
      || repeatWithDisagreement.status !== 'stored'
      || secondSite.status !== 'stored'
      || secondAdapter.status !== 'stored'
    ) throw new Error('registered fixtures must be stored')

    expect(first.duplicate).toBe(false)
    expect(repeatWithDisagreement.duplicate).toBe(true)
    expect(repeatWithDisagreement.occurrenceId).toBe(first.occurrenceId)
    expect(secondSite.occurrenceId).not.toBe(first.occurrenceId)
    expect(secondAdapter.occurrenceId).not.toBe(first.occurrenceId)
    expect(graph.numberOfFacts()).toBe(1)
    expect(graph.numberOfOccurrences()).toBe(3)

    const occurrences = graph.occurrencesForFact(first.factId)
    const merged = occurrences.find((occurrence) => occurrence.id === first.occurrenceId)!
    expect(merged.confidenceObservations).toEqual([
      { confidence: 'EXTRACTED', score: 1 },
      { confidence: 'INFERRED', score: 0.5 },
    ])
    expect(merged.provenance).toEqual([
      { capability_id: 'compiler:calls', stage: 'extract' },
      { capability_id: 'heuristic:corroboration', stage: 'extract' },
    ])
    expect(graph.factRecords()[0]?.fact.occurrenceIds).toEqual(
      occurrences.map((occurrence) => occurrence.id),
    )
  })

  it('merges an exact occurrence identity deterministically in either observation order', () => {
    const observations = [
      {
        owner: { adapterId: 'typescript-semantic', strategy: 'compiler', adapterVersion: '2.0.0' },
        provenance: [{ capability_id: 'heuristic:corroboration', stage: 'extract' }],
        confidenceObservations: [{ confidence: 'INFERRED', score: 0.5 }],
      },
      {
        owner: { adapterId: 'typescript-semantic', strategy: 'compiler', adapterVersion: '1.0.0' },
        provenance: [{ capability_id: 'compiler:calls', stage: 'extract' }],
        confidenceObservations: [{ confidence: 'EXTRACTED', score: 1 }],
      },
    ] as const
    const store = (ordered: typeof observations | readonly [typeof observations[1], typeof observations[0]]) => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('source', {})
      graph.addNode('target', {})
      for (const observation of ordered) {
        graph.addEdge('source', 'target', { relation: 'calls' }, {
          occurrence: {
            ...observation,
            sourceFile: 'src/source.ts',
            sourceRange: { start: { line: 10, column: 1 }, end: { line: 10, column: 8 } },
            siteKind: 'call_expression',
            metadata: {},
          },
        })
      }
      return graph.occurrenceEntries()
    }

    expect(store(observations)).toEqual(store([observations[1], observations[0]]))
  })

  it('serves deterministic source, target, relation, pair, and fact-occurrence indexes', () => {
    const graph = new KnowledgeGraph({ directed: true })
    for (const id of ['alpha', 'beta', 'gamma']) graph.addNode(id, {})
    graph.addEdge('alpha', 'beta', { relation: 'injects' })
    graph.addEdge('alpha', 'beta', { relation: 'calls' })
    graph.addEdge('gamma', 'beta', { relation: 'calls' })

    const fromAlpha = graph.factsFrom('alpha')
    const toBeta = graph.factsTo('beta')
    const calls = graph.factsByRelation('calls')

    expect(fromAlpha).toHaveLength(2)
    expect(toBeta).toHaveLength(3)
    expect(calls).toHaveLength(2)
    expect(fromAlpha.map((fact) => fact.id)).toEqual([...fromAlpha.map((fact) => fact.id)].sort())
    expect(toBeta.map((fact) => fact.id)).toEqual([...toBeta.map((fact) => fact.id)].sort())
    expect(calls.map((fact) => fact.id)).toEqual([...calls.map((fact) => fact.id)].sort())
    expect(graph.factsBetween('alpha', 'beta')).toHaveLength(2)
    for (const fact of graph.factRecords().map((record) => record.fact)) {
      expect(graph.occurrencesForFact(fact.id).map((occurrence) => occurrence.id)).toEqual(fact.occurrenceIds)
    }
  })

  it('copy and subgraph preserve fact IDs, occurrence IDs, and endpoint qualification', () => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.addNode('source', {
      endpointIdentity: { status: 'context_bound', reasons: ['source_location_derived'] },
    })
    graph.addNode('target', {
      endpointIdentity: { status: 'unknown', reasons: ['identity_policy_not_audited'] },
    })
    graph.addNode('outside', {})
    graph.addEdge('source', 'target', { relation: 'calls' }, {
      occurrence: {
        owner: { adapterId: 'typescript-semantic', strategy: 'compiler' },
        sourceFile: 'src/source.ts',
        sourceRange: { start: { line: 4, column: 1 }, end: { line: 4, column: 6 } },
        provenance: [],
        confidenceObservations: [],
        metadata: {},
      },
    })

    const copied = graph.copy()
    const subgraph = graph.subgraph(['source', 'target'])
    const expectedFactIds = graph.factRecords().map(({ fact }) => fact.id)
    const expectedOccurrenceIds = graph.occurrenceEntries().map((occurrence) => occurrence.id)

    for (const candidate of [copied, subgraph]) {
      expect(candidate.factRecords().map(({ fact }) => fact.id)).toEqual(expectedFactIds)
      expect(candidate.occurrenceEntries().map((occurrence) => occurrence.id)).toEqual(expectedOccurrenceIds)
      expect(candidate.nodeEndpointIdentity('source')).toEqual({
        status: 'context_bound',
        reasons: ['source_location_derived'],
      })
      expect(candidate.nodeEndpointIdentity('target')).toEqual({
        status: 'unknown',
        reasons: ['identity_policy_not_audited'],
      })
    }
    expect(subgraph.hasNode('outside')).toBe(false)
  })
})
