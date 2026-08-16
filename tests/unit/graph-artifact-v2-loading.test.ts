import { describe, expect, it } from 'vitest'

import {
  GraphArtifactInvariantError,
  GRAPH_ARTIFACT_V2_HEADER,
  loadGraphArtifact,
  parseGraphArtifactV2,
  serializeGraphArtifactV2,
} from '../../src/contracts/graph-artifact.js'
import { KnowledgeGraph } from '../../src/contracts/graph.js'

const FIXED_TIME = '2026-08-15T00:00:00.000Z'
const REVISION = 'cbfb076bd3d3f0c091b233abe5feae7058032426'

function fixtureGraph(directed = true): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed })
  graph.addNode('source', {
    label: 'Source',
    endpointIdentity: { status: 'unknown', reasons: ['identity_policy_not_audited'] },
  })
  graph.addNode('target', {
    label: 'Target',
    endpointIdentity: { status: 'context_bound', reasons: ['source_location_derived'] },
  })
  graph.addEdge('source', 'target', { relation: 'calls', confidence: 'EXTRACTED' }, {
    occurrence: {
      owner: { adapterId: 'typescript', strategy: 'compiler' },
      sourceFile: 'src/source.ts',
      adapterEvidenceKey: 'call:1',
      provenance: [{ capability_id: 'typescript:calls' }],
      confidenceObservations: [{ confidence: 'EXTRACTED', score: 1 }],
      metadata: { syntax: 'call_expression' },
    },
  })
  graph.addEdge('source', 'target', { relation: 'injects', confidence: 'INFERRED' }, {
    occurrence: {
      owner: { adapterId: 'nestjs', strategy: 'decorator' },
      sourceFile: 'src/source.ts',
      adapterEvidenceKey: 'inject:1',
      provenance: [{ capability_id: 'nestjs:injects' }],
      confidenceObservations: [{ confidence: 'INFERRED', score: 0.5 }],
      metadata: {},
    },
  })
  graph.graph.hyperedges = [{ id: 'h2', nodes: ['target', 'source'] }, { id: 'h1', nodes: ['source'] }]
  return graph
}

function artifact(graph = fixtureGraph()): Buffer {
  return serializeGraphArtifactV2({
    graph,
    repositoryRevision: REVISION,
    generationMode: 'incremental',
    generatedAt: FIXED_TIME,
    communityLabels: { 2: 'Services', 1: 'Entry points' },
  })
}

function rawPayload(bytes = artifact()): Record<string, any> {
  return JSON.parse(bytes.subarray(Buffer.byteLength(GRAPH_ARTIFACT_V2_HEADER)).toString('utf8')) as Record<string, any>
}

function reframe(payload: unknown, suffix = '\n'): Buffer {
  return Buffer.from(`${GRAPH_ARTIFACT_V2_HEADER}${JSON.stringify(payload)}${suffix}`, 'utf8')
}

describe('graph artifact v2 parsing', () => {
  it('requires the exact header and a non-empty JSON body', () => {
    const bytes = artifact()
    const jsonOnly = bytes.subarray(Buffer.byteLength(GRAPH_ARTIFACT_V2_HEADER))

    expect(() => parseGraphArtifactV2(jsonOnly)).toThrow(/header/i)
    expect(() => parseGraphArtifactV2(Buffer.from(bytes.toString('utf8').replace('/2\n', '/3\n')))).toThrow(/header/i)
    expect(() => parseGraphArtifactV2(Buffer.from(GRAPH_ARTIFACT_V2_HEADER))).toThrow(/empty/i)
    expect(() => parseGraphArtifactV2(Buffer.from(`${GRAPH_ARTIFACT_V2_HEADER}   \n`))).toThrow(/empty/i)
  })

  it('rejects invalid UTF-8, invalid JSON, and trailing non-whitespace', () => {
    const invalidUtf8 = Buffer.concat([
      Buffer.from(GRAPH_ARTIFACT_V2_HEADER, 'utf8'),
      Buffer.from([0xc3, 0x28]),
    ])

    expect(() => parseGraphArtifactV2(invalidUtf8)).toThrow(/UTF-8/i)
    expect(() => parseGraphArtifactV2(Buffer.from(`${GRAPH_ARTIFACT_V2_HEADER}{`))).toThrow(/JSON/i)
    expect(() => parseGraphArtifactV2(Buffer.concat([artifact(), Buffer.from('garbage')]))).toThrow(/trailing|JSON/i)
    expect(() => parseGraphArtifactV2(Buffer.concat([artifact(), Buffer.from(' \n\t')]))).not.toThrow()
  })

  it('fails closed for every unsupported version dimension', () => {
    const mutations: Array<[string, unknown]> = [
      ['graph_artifact', 3],
      ['semantic_fact_identity', 2],
      ['evidence_occurrence_identity', 2],
      ['relation_discriminator_registry', 'madar.relation-discriminator-registry/2'],
      ['endpoint_identity_qualification_policy', 'madar.endpoint-identity-classification-policy/2'],
      ['receipt_storage_schema', 2],
    ]

    for (const [key, value] of mutations) {
      const payload = rawPayload()
      payload.versions[key] = value
      expect(() => parseGraphArtifactV2(reframe(payload)), key).toThrow(/unsupported.*version/i)
    }
  })
})

describe('graph artifact v2 loading', () => {
  it('preserves IDs and endpoint qualification while rebuilding deterministic indexes', () => {
    const original = fixtureGraph()
    const loaded = loadGraphArtifact(artifact(original))

    expect(loaded.format).toBe('v2')
    expect(loaded.repositoryRevision).toBe(REVISION)
    expect(loaded.generationMode).toBe('incremental')
    expect(loaded.generatedAt).toBe(FIXED_TIME)
    expect(loaded.receipt.status).toBe('degraded')
    expect(loaded.graph.factRecords().map(({ fact }) => fact.id)).toEqual(
      original.factRecords().map(({ fact }) => fact.id),
    )
    expect(loaded.graph.occurrenceEntries().map(({ id }) => id)).toEqual(
      original.occurrenceEntries().map(({ id }) => id),
    )
    expect(loaded.graph.nodeEndpointIdentity('source')).toEqual({
      status: 'unknown',
      reasons: ['identity_policy_not_audited'],
    })
    expect(loaded.graph.nodeEndpointIdentity('target')).toEqual({
      status: 'context_bound',
      reasons: ['source_location_derived'],
    })
    expect(loaded.graph.factsFrom('source')).toHaveLength(2)
    expect(loaded.graph.factsTo('target')).toHaveLength(2)
    expect(loaded.graph.factsByRelation('calls')).toHaveLength(1)
    expect(loaded.graph.endpointEntries()).toEqual([{ source: 'source', target: 'target' }])
    expect(loaded.graph.occurrencesForFact(loaded.graph.factsByRelation('calls')[0]!.id)).toHaveLength(1)
  })

  it('rejects missing fact/occurrence cross-references in either direction', () => {
    const missingOccurrence = rawPayload()
    missingOccurrence.occurrences = missingOccurrence.occurrences.slice(1)
    expect(() => loadGraphArtifact(reframe(missingOccurrence))).toThrow(/occurrence.*does not exist/i)

    const missingFact = rawPayload()
    missingFact.occurrences[0].fact_id = `sf_${'0'.repeat(64)}`
    expect(() => loadGraphArtifact(reframe(missingFact))).toThrow(/unknown fact|references fact/i)

    const unlistedOccurrence = rawPayload()
    unlistedOccurrence.facts[0].occurrence_ids = []
    expect(() => loadGraphArtifact(reframe(unlistedOccurrence))).toThrow(/not listed|cross-reference/i)
  })

  it('rejects missing endpoints and endpoint qualifications that disagree with nodes', () => {
    const missingEndpoint = rawPayload()
    missingEndpoint.nodes = missingEndpoint.nodes.filter((node: { id: string }) => node.id !== 'target')
    expect(() => loadGraphArtifact(reframe(missingEndpoint))).toThrow(/endpoint/i)

    const qualificationMismatch = rawPayload()
    qualificationMismatch.facts[0].endpoint_identity.source = { status: 'stable', reasons: [] }
    expect(() => loadGraphArtifact(reframe(qualificationMismatch))).toThrow(/qualification.*disagree/i)
  })

  it('rejects a receipt matrix sum or cell assignment that disagrees with facts', () => {
    const sumMismatch = rawPayload()
    sumMismatch.integrity_receipt.endpoint_identity.fact_pair_counts.unknown.context_bound = 1
    expect(() => loadGraphArtifact(reframe(sumMismatch))).toThrow(/partition|matrix/i)

    const cellMismatch = rawPayload()
    cellMismatch.integrity_receipt.endpoint_identity.fact_pair_counts.unknown.context_bound = 1
    cellMismatch.integrity_receipt.endpoint_identity.fact_pair_counts.context_bound.unknown = 1
    expect(() => loadGraphArtifact(reframe(cellMismatch))).toThrow(/partition|disagree/i)
  })

  it('rejects duplicate IDs with different payloads', () => {
    const cases: Array<[string, (payload: Record<string, any>) => void]> = [
      ['node', (payload) => payload.nodes.push({ ...payload.nodes[0], attributes: { label: 'Different' } })],
      ['fact', (payload) => payload.facts.push({ ...payload.facts[0], annotations: { different: true } })],
      ['occurrence', (payload) => payload.occurrences.push({ ...payload.occurrences[0], metadata: { different: true } })],
    ]

    for (const [kind, mutate] of cases) {
      const payload = rawPayload()
      mutate(payload)
      expect(() => loadGraphArtifact(reframe(payload)), kind).toThrow(/duplicate.*different payload/i)
    }
  })

  it('rejects semantic fact and occurrence hash/payload mismatches', () => {
    const factMismatch = rawPayload()
    factMismatch.facts[0].source = 'target'
    expect(() => loadGraphArtifact(reframe(factMismatch))).toThrow(/hash|canonical payload|identity/i)

    const occurrenceMismatch = rawPayload()
    occurrenceMismatch.occurrences[0].adapter_evidence_key = 'changed'
    expect(() => loadGraphArtifact(reframe(occurrenceMismatch))).toThrow(/hash|canonical payload|identity/i)
  })

  it('rejects malformed endpoint statuses and reasons', () => {
    const badStatus = rawPayload()
    badStatus.nodes[0].endpoint_identity.status = 'missing'
    expect(() => loadGraphArtifact(reframe(badStatus))).toThrow(/invalid status/i)

    const badReason = rawPayload()
    badReason.nodes[0].endpoint_identity.reasons = ['made_up_reason']
    expect(() => loadGraphArtifact(reframe(badReason))).toThrow(/invalid reason/i)

    const impossibleCombination = rawPayload()
    impossibleCombination.nodes[0].endpoint_identity = {
      status: 'stable',
      reasons: ['source_location_derived'],
    }
    expect(() => loadGraphArtifact(reframe(impossibleCombination))).toThrow(/stable.*reason/i)

    const unsortedReasons = rawPayload()
    unsortedReasons.nodes[0].endpoint_identity = {
      status: 'context_bound',
      reasons: ['source_ordinal_derived', 'source_location_derived'],
    }
    expect(() => loadGraphArtifact(reframe(unsortedReasons))).toThrow(/stable-sorted/i)
  })

  it('rejects non-canonical undirected endpoint orientation', () => {
    const graph = fixtureGraph(false)
    const payload = rawPayload(artifact(graph))
    const fact = payload.facts[0]
    ;[fact.source, fact.target] = [fact.target, fact.source]

    expect(() => loadGraphArtifact(reframe(payload))).toThrow(GraphArtifactInvariantError)
  })
})
