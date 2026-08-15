import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import {
  GRAPH_ARTIFACT_V2_HEADER,
  graphArtifactDigest,
  serializeGraphArtifactV2,
  type GraphArtifactStorageReceipt,
} from '../../src/contracts/graph-artifact.js'
import {
  ENDPOINT_IDENTITY_STATUSES,
  type EndpointIdentityEndpointQualification,
  type EndpointIdentityStatus,
} from '../../src/contracts/endpoint-identity.js'

const FIXED_TIME = '2026-08-15T00:00:00.000Z'
const REVISION = 'cbfb076bd3d3f0c091b233abe5feae7058032426'

function qualification(status: EndpointIdentityStatus): EndpointIdentityEndpointQualification {
  switch (status) {
    case 'stable':
      return { status, reasons: [] }
    case 'context_bound':
      return { status, reasons: ['source_location_derived'] }
    case 'unknown':
      return { status, reasons: ['identity_policy_not_audited'] }
    case 'legacy':
      return { status, reasons: ['legacy_identity_policy'] }
  }
}

function serialize(graph: KnowledgeGraph, integrityReceipt?: GraphArtifactStorageReceipt): Buffer {
  return serializeGraphArtifactV2({
    graph,
    repositoryRevision: REVISION,
    generationMode: 'full',
    generatedAt: FIXED_TIME,
    ...(integrityReceipt !== undefined ? { integrityReceipt } : {}),
  })
}

function payload(bytes: Buffer): Record<string, unknown> {
  return JSON.parse(bytes.subarray(Buffer.byteLength(GRAPH_ARTIFACT_V2_HEADER)).toString('utf8')) as Record<string, unknown>
}

describe('graph artifact v2 serialization', () => {
  it('emits the exact magic header and one trailing newline deterministically', () => {
    const graph = new KnowledgeGraph({ directed: true })
    const input = {
      graph,
      repositoryRevision: REVISION,
      generationMode: 'full',
      generatedAt: FIXED_TIME,
    } as const

    const first = serializeGraphArtifactV2(input)
    const second = serializeGraphArtifactV2(input)

    expect(first.equals(second)).toBe(true)
    expect(first.subarray(0, Buffer.byteLength(GRAPH_ARTIFACT_V2_HEADER)).toString('utf8')).toBe(
      GRAPH_ARTIFACT_V2_HEADER,
    )
    expect(first.toString('utf8')).toMatch(/[^\n]\n$/)
    expect(first.toString('utf8')).not.toMatch(/\n\n$/)
  })

  it('matches the exact fixed-timestamp fixture bytes', () => {
    const graph = new KnowledgeGraph({ directed: true })

    expect(serialize(graph)).toEqual(
      readFileSync(new URL('../fixtures/graph-artifact-v2-empty.madar', import.meta.url)),
    )
  })

  it('is byte-identical across node, fact, and occurrence insertion order', () => {
    const build = (reverse: boolean): KnowledgeGraph => {
      const graph = new KnowledgeGraph({ directed: true })
      const nodes = [
        ['zeta', { label: 'Zeta', endpointIdentity: qualification('unknown') }],
        ['alpha', { label: 'Alpha', endpointIdentity: qualification('context_bound') }],
        ['middle', { label: 'Middle', endpointIdentity: qualification('stable') }],
      ] as const
      for (const [id, attributes] of reverse ? [...nodes].reverse() : nodes) graph.addNode(id, attributes)

      const edges = [
        ['zeta', 'alpha', 'site-zeta'],
        ['alpha', 'middle', 'site-alpha'],
      ] as const
      for (const [source, target, evidenceKey] of reverse ? [...edges].reverse() : edges) {
        graph.addEdge(source, target, { relation: 'calls' }, {
          occurrence: {
            owner: { adapterId: 'fixture', strategy: 'test' },
            adapterEvidenceKey: evidenceKey,
            provenance: [],
            confidenceObservations: [],
            metadata: {},
          },
        })
      }
      return graph
    }

    expect(serialize(build(false))).toEqual(serialize(build(true)))
  })

  it('is byte-identical when occurrences of one fact are inserted in reverse', () => {
    const build = (keys: readonly string[]): KnowledgeGraph => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('source', { endpointIdentity: qualification('stable') })
      graph.addNode('target', { endpointIdentity: qualification('stable') })
      for (const key of keys) {
        graph.addEdge('source', 'target', { relation: 'calls' }, {
          occurrence: {
            owner: { adapterId: 'fixture', strategy: 'test' },
            adapterEvidenceKey: key,
            provenance: [],
            confidenceObservations: [],
            metadata: {},
          },
        })
      }
      return graph
    }

    expect(serialize(build(['a', 'b']))).toEqual(serialize(build(['b', 'a'])))
  })

  it('canonicalizes hyperedges and community labels independently of insertion order', () => {
    const graph = new KnowledgeGraph({ directed: true })
    const common = {
      graph,
      repositoryRevision: REVISION,
      generationMode: 'full',
      generatedAt: FIXED_TIME,
    } as const
    const first = serializeGraphArtifactV2({
      ...common,
      hyperedges: [
        { id: 'b', nodes: ['zeta', 'alpha'], relation: 'calls' },
        { id: 'a', nodes: ['middle'] },
      ],
      communityLabels: { 2: 'Second', 1: 'First' },
    })
    const second = serializeGraphArtifactV2({
      ...common,
      hyperedges: [
        { id: 'a', nodes: ['middle'] },
        { relation: 'calls', nodes: ['alpha', 'zeta'], id: 'b' },
      ],
      communityLabels: { 1: 'First', 2: 'Second' },
    })

    expect(first).toEqual(second)
  })

  it('writes all sixteen endpoint-status cells in declared order as an exact partition', () => {
    const graph = new KnowledgeGraph({ directed: true })
    for (const sourceStatus of ENDPOINT_IDENTITY_STATUSES) {
      for (const targetStatus of ENDPOINT_IDENTITY_STATUSES) {
        const source = `source:${sourceStatus}:${targetStatus}`
        const target = `target:${sourceStatus}:${targetStatus}`
        graph.addNode(source, { endpointIdentity: qualification(sourceStatus) })
        graph.addNode(target, { endpointIdentity: qualification(targetStatus) })
        graph.addEdge(source, target, { relation: 'calls' })
      }
    }

    const text = serialize(graph).toString('utf8')
    const parsed = payload(Buffer.from(text, 'utf8'))
    const receipt = parsed.integrity_receipt as {
      status: string
      endpoint_identity: {
        fact_pair_counts: Record<string, Record<string, number>>
        reason_fact_counts: Record<string, number>
      }
    }
    const matrix = receipt.endpoint_identity.fact_pair_counts

    expect(receipt.status).toBe('degraded')
    expect(Object.keys(matrix)).toEqual(ENDPOINT_IDENTITY_STATUSES)
    for (const status of ENDPOINT_IDENTITY_STATUSES) {
      expect(Object.keys(matrix[status]!)).toEqual(ENDPOINT_IDENTITY_STATUSES)
      expect(Object.values(matrix[status]!).reduce((sum, count) => sum + count, 0)).toBe(4)
    }
    expect(Object.values(matrix).flatMap(Object.values).reduce((sum, count) => sum + count, 0)).toBe(16)
    expect(receipt.endpoint_identity.reason_fact_counts).toEqual({
      identity_policy_not_audited: 7,
      legacy_identity_policy: 7,
      source_location_derived: 7,
    })
    expect(text).toContain('"fact_pair_counts":{"stable":{"stable":1,"context_bound":1,"unknown":1,"legacy":1}')
  })

  it('keeps unknown separate from context-bound and emits applicable degradation reasons', () => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.addNode('unknown', { endpointIdentity: qualification('unknown') })
    graph.addNode('context', { endpointIdentity: qualification('context_bound') })
    graph.addEdge('unknown', 'context', { relation: 'calls' })

    const receipt = payload(serialize(graph)).integrity_receipt as {
      reasons: string[]
      endpoint_identity: { fact_pair_counts: Record<string, Record<string, number>> }
    }

    expect(receipt.endpoint_identity.fact_pair_counts.unknown?.context_bound).toBe(1)
    expect(receipt.endpoint_identity.fact_pair_counts.context_bound?.unknown).toBe(0)
    expect(receipt.reasons).toEqual([
      'full_emission_accounting_not_available',
      'identity_policy_not_audited',
      'source_location_derived',
    ])
  })

  it('uses canonical endpoint orientation for undirected receipt cells', () => {
    const graph = new KnowledgeGraph({ directed: false })
    graph.addNode('zeta', { endpointIdentity: qualification('context_bound') })
    graph.addNode('alpha', { endpointIdentity: qualification('stable') })
    graph.addEdge('zeta', 'alpha', { relation: 'calls' })

    const receipt = payload(serialize(graph)).integrity_receipt as {
      endpoint_identity: { fact_pair_counts: Record<string, Record<string, number>> }
    }

    expect(receipt.endpoint_identity.fact_pair_counts.stable?.context_bound).toBe(1)
    expect(receipt.endpoint_identity.fact_pair_counts.context_bound?.stable).toBe(0)
  })

  it('does not put a failed missing-endpoint candidate into the matrix', () => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.addNode('source', { endpointIdentity: qualification('stable') })
    expect(() => graph.addEdge('source', 'missing', { relation: 'calls' })).toThrow()

    const receipt = payload(serialize(graph)).integrity_receipt as {
      endpoint_identity: { fact_pair_counts: Record<string, Record<string, number>> }
    }
    expect(Object.values(receipt.endpoint_identity.fact_pair_counts)
      .flatMap(Object.values)
      .reduce((sum, count) => sum + count, 0)).toBe(0)
  })

  it('rejects a supplied receipt whose matrix does not partition the retained facts', () => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.addNode('source', { endpointIdentity: qualification('stable') })
    graph.addNode('target', { endpointIdentity: qualification('stable') })
    graph.addEdge('source', 'target', { relation: 'calls' })
    const wrongReceipt = payload(serialize(new KnowledgeGraph({ directed: true }))).integrity_receipt as unknown as GraphArtifactStorageReceipt

    expect(() => serialize(graph, wrongReceipt)).toThrow(/partition/i)
  })

  it('keeps the artifact digest stable for unchanged input', () => {
    const fixture = readFileSync(new URL('../fixtures/graph-artifact-v2-empty.madar', import.meta.url))

    expect(graphArtifactDigest(fixture)).toBe('1e8e0a73703c2e1a4f1e905057876f49eb56085b179bdaae15af76d8af2052c0')
  })
})
