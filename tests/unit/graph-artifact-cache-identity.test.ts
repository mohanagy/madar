import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import {
  graphArtifactCacheIdentity,
  graphArtifactCacheCompatibility,
  loadGraphArtifact,
  serializeGraphArtifactV2,
  type GraphArtifactCacheIdentity,
} from '../../src/contracts/graph-artifact.js'

function loadedV2(repositoryRevision = 'revision-a') {
  return loadGraphArtifact(serializeGraphArtifactV2({
    graph: new KnowledgeGraph({ directed: true }),
    repositoryRevision,
    generationMode: 'full',
    generatedAt: '2026-08-15T00:00:00.000Z',
  }))
}

function loadedV1() {
  return loadGraphArtifact(JSON.stringify({
    schema_version: 1,
    directed: true,
    nodes: [],
    links: [],
    hyperedges: [],
    community_labels: {},
  }))
}

describe('graph artifact cache identity', () => {
  it('records every compatibility dimension and reuses an unchanged identity', () => {
    const identity = graphArtifactCacheIdentity(loadedV2())

    expect(identity).toEqual({
      graph_artifact_version: 2,
      semantic_fact_identity_version: 1,
      evidence_occurrence_identity_version: 1,
      relation_discriminator_registry_version: 'madar.relation-discriminator-registry/1',
      endpoint_identity_policy_version: 'madar.endpoint-identity-classification-policy/1',
      repository_revision: 'revision-a',
      qualification: 'native_v2',
    })
    expect(graphArtifactCacheCompatibility(identity, identity)).toEqual({
      status: 'reusable',
      reasons: [],
    })
  })

  it.each([
    ['graph_artifact_version', 3, 'unsupported_cache_identity:graph_artifact_version'],
    ['semantic_fact_identity_version', 2, 'unsupported_cache_identity:semantic_fact_identity_version'],
    ['evidence_occurrence_identity_version', 2, 'unsupported_cache_identity:evidence_occurrence_identity_version'],
    ['relation_discriminator_registry_version', 'madar.relation-discriminator-registry/2', 'unsupported_cache_identity:relation_discriminator_registry_version'],
    ['endpoint_identity_policy_version', 'madar.endpoint-identity-classification-policy/2', 'unsupported_cache_identity:endpoint_identity_policy_version'],
    ['repository_revision', 'revision-b', 'cache_identity_mismatch:repository_revision'],
  ] as const)('invalidates when %s changes', (field, replacement, expectedReason) => {
    const expected = graphArtifactCacheIdentity(loadedV2())
    const cached = { ...expected, [field]: replacement } as GraphArtifactCacheIdentity

    expect(graphArtifactCacheCompatibility(cached, expected)).toEqual({
      status: 'incompatible',
      reasons: [expectedReason],
    })
  })

  it('does not let a degraded v1 graph masquerade as a native v2 cache', () => {
    const expected = graphArtifactCacheIdentity(loadedV2('legacy-unavailable'))
    const legacy = graphArtifactCacheIdentity(loadedV1())

    expect(legacy.graph_artifact_version).toBe(1)
    expect(legacy.qualification).toBe('legacy_v1_degraded')
    expect(graphArtifactCacheCompatibility(legacy, expected)).toEqual({
      status: 'incompatible',
      reasons: [
        'cache_identity_mismatch:graph_artifact_version',
        'cache_identity_mismatch:qualification',
      ],
    })
  })

  it('fails unsupported future versions as incompatible instead of ignoring them', () => {
    const expected = graphArtifactCacheIdentity(loadedV2())
    const future = {
      ...expected,
      graph_artifact_version: 99,
      semantic_fact_identity_version: 99,
    }

    expect(graphArtifactCacheCompatibility(future, expected)).toEqual({
      status: 'incompatible',
      reasons: [
        'unsupported_cache_identity:graph_artifact_version',
        'unsupported_cache_identity:semantic_fact_identity_version',
      ],
    })
  })

  it('fails missing and malformed cache identity records closed', () => {
    const expected = graphArtifactCacheIdentity(loadedV2())

    expect(graphArtifactCacheCompatibility({}, expected)).toEqual({
      status: 'incompatible',
      reasons: ['malformed_cache_identity'],
    })
    expect(graphArtifactCacheCompatibility(null, expected)).toEqual({
      status: 'incompatible',
      reasons: ['malformed_cache_identity'],
    })
  })
})
