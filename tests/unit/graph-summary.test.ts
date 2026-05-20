import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
// @ts-expect-error -- red test for runtime graph summary module prior to implementation.
import { buildGraphSummary } from '../../src/runtime/graph-summary.js'

const SUMMARY_ARRAY_CAP = 10

type GraphSummaryTopModule = {
  label: string
  degree: number
}

type GraphSummaryEntrypoint = {
  label: string
  source_file: string
}

type GraphSummaryRuntimePath = {
  from: string
  to: string
  hops: number
}

function padIndex(index: number): string {
  return index.toString().padStart(2, '0')
}

function makeRichGraph(options?: {
  graphVersion?: string
  generatedAt?: string
}): KnowledgeGraph {
  const graph = new KnowledgeGraph(true) // directed

  // Community 0: auth layer (production, express)
  graph.addNode('n1', { label: 'AuthService', source_file: 'src/auth/service.ts', source_location: 'L10', file_type: 'code', community: 0, source_domain: 'production', framework: 'express' })
  graph.addNode('n2', { label: 'TokenValidator', source_file: 'src/auth/token.ts', source_location: 'L5', file_type: 'code', community: 0, source_domain: 'production', framework: 'express' })
  graph.addNode('n3', { label: 'UserRepository', source_file: 'src/users/repo.ts', source_location: 'L1', file_type: 'code', community: 0, source_domain: 'production' })

  // Community 1: api layer (production, express)
  graph.addNode('n4', { label: 'ApiRouter', source_file: 'src/api/router.ts', source_location: 'L1', file_type: 'code', community: 1, source_domain: 'production', framework: 'express' })
  graph.addNode('n5', { label: 'RequestHandler', source_file: 'src/api/handler.ts', source_location: 'L1', file_type: 'code', community: 1, source_domain: 'production' })

  // Community 2: test layer
  graph.addNode('n6', { label: 'AuthServiceTest', source_file: 'tests/auth.test.ts', source_location: 'L1', file_type: 'code', community: 2, source_domain: 'test', framework: 'jest' })
  graph.addNode('n7', { label: 'ApiRouterTest', source_file: 'tests/api.test.ts', source_location: 'L1', file_type: 'code', community: 2, source_domain: 'test', framework: 'jest' })

  // Docs node (community 0)
  graph.addNode('n8', { label: 'README', source_file: 'README.md', source_location: 'L1', file_type: 'document', community: 0, source_domain: 'docs' })

  // Edges: n4 → n1 → n2, n4 → n5, n1 → n3, n6 → n1, n7 → n4
  graph.addEdge('n4', 'n1', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/api/router.ts' })
  graph.addEdge('n4', 'n5', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/api/router.ts' })
  graph.addEdge('n1', 'n2', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/auth/service.ts' })
  graph.addEdge('n1', 'n3', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/auth/service.ts' })
  graph.addEdge('n6', 'n1', { relation: 'imports', confidence: 'EXTRACTED', source_file: 'tests/auth.test.ts' })
  graph.addEdge('n7', 'n4', { relation: 'imports', confidence: 'EXTRACTED', source_file: 'tests/api.test.ts' })

  if (options?.graphVersion) {
    graph.graph.graph_version = options.graphVersion
  }
  if (options?.generatedAt) {
    graph.graph.generated_at = options.generatedAt
  }

  return graph
}

function makeManyEntrypointsGraph(count = SUMMARY_ARRAY_CAP + 2): KnowledgeGraph {
  const graph = new KnowledgeGraph(true)

  for (let index = count - 1; index >= 0; index--) {
    const suffix = padIndex(index)
    graph.addNode(`entry-${suffix}`, {
      label: `Entry${suffix}`,
      source_file: `src/entry-${suffix}.ts`,
      source_location: 'L1',
      file_type: 'code',
      community: 0,
      source_domain: 'production',
    })
  }

  return graph
}

function makeManyRuntimePathsGraph(count = SUMMARY_ARRAY_CAP + 2): KnowledgeGraph {
  const graph = new KnowledgeGraph(true)

  for (let index = count - 1; index >= 0; index--) {
    const suffix = padIndex(index)
    graph.addNode(`runtime-entry-${suffix}`, {
      label: `RuntimeEntry${suffix}`,
      source_file: `src/runtime/entry-${suffix}.ts`,
      source_location: 'L1',
      file_type: 'code',
      community: 0,
      source_domain: 'production',
    })
    graph.addNode(`runtime-handler-${suffix}`, {
      label: `RuntimeHandler${suffix}`,
      source_file: `src/runtime/handler-${suffix}.ts`,
      source_location: 'L1',
      file_type: 'code',
      community: 0,
      source_domain: 'production',
    })
    graph.addNode(`runtime-sink-${suffix}`, {
      label: `RuntimeSink${suffix}`,
      source_file: `src/runtime/sink-${suffix}.ts`,
      source_location: 'L1',
      file_type: 'code',
      community: 0,
      source_domain: 'production',
    })

    graph.addEdge(`runtime-entry-${suffix}`, `runtime-handler-${suffix}`, {
      relation: 'calls',
      confidence: 'EXTRACTED',
      source_file: `src/runtime/entry-${suffix}.ts`,
    })
    graph.addEdge(`runtime-handler-${suffix}`, `runtime-sink-${suffix}`, {
      relation: 'calls',
      confidence: 'EXTRACTED',
      source_file: `src/runtime/handler-${suffix}.ts`,
    })
  }

  return graph
}

describe('buildGraphSummary', () => {
  it('returns correct structural counts', () => {
    const graph = makeRichGraph()
    const summary = buildGraphSummary(graph)

    expect(summary.node_count).toBe(8)
    expect(summary.edge_count).toBe(6)
    expect(summary.file_count).toBe(8)
    expect(summary.community_count).toBe(3)
  })

  it('counts unique source files rather than raw nodes for file_count', () => {
    const graph = new KnowledgeGraph(true)
    graph.addNode('service', {
      label: 'AuthService',
      source_file: 'src/auth/service.ts',
      source_location: 'L1',
      file_type: 'code',
      community: 0,
      source_domain: 'production',
    })
    graph.addNode('validator', {
      label: 'TokenValidator',
      source_file: 'src/auth/service.ts',
      source_location: 'L20',
      file_type: 'code',
      community: 0,
      source_domain: 'production',
    })

    const summary = buildGraphSummary(graph)

    expect(summary.node_count).toBe(2)
    expect(summary.file_count).toBe(1)
  })

  it('breaks down source-domain counts', () => {
    const graph = makeRichGraph()
    const summary = buildGraphSummary(graph)

    expect(summary.source_domains).toMatchObject({
      production: 5,
      test: 2,
      docs: 1,
    })
    // No unknown or spurious domains
    expect(Object.keys(summary.source_domains).sort()).toEqual(['docs', 'production', 'test'])
  })

  it('returns top_modules ordered by degree descending', () => {
    const graph = makeRichGraph()
    const summary = buildGraphSummary(graph)

    expect(summary.top_modules).toBeInstanceOf(Array)
    expect(summary.top_modules.length).toBeGreaterThan(0)

    // Ordering: each entry's degree is >= the next entry's degree
    for (let index = 1; index < summary.top_modules.length; index++) {
      expect(summary.top_modules[index - 1]!.degree).toBeGreaterThanOrEqual(summary.top_modules[index]!.degree)
    }

    // AuthService (in-degree 2, out-degree 2 → degree 4) and ApiRouter (out-degree 2 → degree 3)
    // should appear in the top list
    const labels = summary.top_modules.map((module: GraphSummaryTopModule) => module.label)
    expect(labels).toContain('AuthService')
    expect(labels).toContain('ApiRouter')
  })

  it('collects detected frameworks without duplicates, in deterministic order', () => {
    const graph = makeRichGraph()
    const summary = buildGraphSummary(graph)

    expect(summary.frameworks).toBeInstanceOf(Array)
    expect(summary.frameworks).toContain('express')
    expect(summary.frameworks).toContain('jest')

    // No duplicates
    expect(new Set(summary.frameworks).size).toBe(summary.frameworks.length)

    // Deterministic: two calls return identical ordering
    const summary2 = buildGraphSummary(graph)
    expect(summary2.frameworks).toEqual(summary.frameworks)
  })

  it('identifies code entrypoints as code roots, not every in-degree-0 node', () => {
    const graph = makeRichGraph()
    const summary = buildGraphSummary(graph)

    expect(summary.entrypoints).toBeInstanceOf(Array)

    // Entrypoints are code roots in the directed graph. README also has in-degree 0,
    // but document nodes are not part of the entrypoint contract.
    const labels = summary.entrypoints.map((entrypoint: GraphSummaryEntrypoint) => entrypoint.label)
    expect(labels).toContain('AuthServiceTest')
    expect(labels).toContain('ApiRouterTest')
    expect(labels).not.toContain('ApiRouter')
    expect(labels).not.toContain('README')
  })

  it('surfaces graph_version and generated_at metadata when present on the graph', () => {
    const graph = makeRichGraph({
      graphVersion: 'graph-v2026-05-15',
      generatedAt: '2026-05-15T03:49:06.000Z',
    })
    const summary = buildGraphSummary(graph)

    expect(summary.graph_version).toBe('graph-v2026-05-15')
    expect(summary.generated_at).toBe('2026-05-15T03:49:06.000Z')
  })

  it('caps top_modules at 10 entries even when many nodes exist', () => {
    const graph = new KnowledgeGraph(true)
    for (let index = 0; index < 15; index++) {
      graph.addNode(`n${index}`, {
        label: `Module${index}`,
        source_file: `src/module${index}.ts`,
        source_location: 'L1',
        file_type: 'code',
        community: 0,
        source_domain: 'production',
      })
    }
    // All 14 nodes connect to n0 so n0 has degree 14
    for (let index = 1; index < 15; index++) {
      graph.addEdge('n0', `n${index}`, { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/module0.ts' })
    }

    const summary = buildGraphSummary(graph)
    expect(summary.top_modules.length).toBeLessThanOrEqual(SUMMARY_ARRAY_CAP)
  })

  it('caps entrypoints after deterministic label/source_file ordering, so the first 10 sorted items survive', () => {
    const graph = makeManyEntrypointsGraph()
    const summary = buildGraphSummary(graph)
    const expectedEntrypoints = Array.from({ length: SUMMARY_ARRAY_CAP }, (_, index) => {
      const suffix = padIndex(index)
      return {
        label: `Entry${suffix}`,
        source_file: `src/entry-${suffix}.ts`,
      }
    })

    // The helper inserts nodes in reverse order. Keeping Entry00-Entry09 documents that
    // truncation happens after deterministic label/source_file ordering, not insertion order.
    expect(summary.entrypoints).toHaveLength(SUMMARY_ARRAY_CAP)
    expect(summary.entrypoints.map(({ label, source_file }: GraphSummaryEntrypoint) => ({ label, source_file }))).toEqual(expectedEntrypoints)
    expect(summary.entrypoints.map(({ label }: GraphSummaryEntrypoint) => label)).not.toContain('Entry10')
    expect(summary.entrypoints.map(({ label }: GraphSummaryEntrypoint) => label)).not.toContain('Entry11')

    const repeatedSummary = buildGraphSummary(graph)
    expect(repeatedSummary.entrypoints).toEqual(summary.entrypoints)
  })

  it('caps runtime_paths after deterministic from/to ordering, so the first 10 sorted paths survive', () => {
    const graph = makeManyRuntimePathsGraph()
    const summary = buildGraphSummary(graph)
    const expectedRuntimePaths = Array.from({ length: SUMMARY_ARRAY_CAP }, (_, index) => {
      const suffix = padIndex(index)
      return {
        from: `RuntimeEntry${suffix}`,
        to: `RuntimeSink${suffix}`,
        hops: 2,
      }
    })

    expect(summary.runtime_paths).toBeInstanceOf(Array)
    expect(summary.runtime_paths).toHaveLength(SUMMARY_ARRAY_CAP)

    for (const path of summary.runtime_paths) {
      expect(typeof path.from).toBe('string')
      expect(typeof path.to).toBe('string')
      expect(typeof path.hops).toBe('number')
      expect(path.hops).toBeGreaterThanOrEqual(1)
    }

    // The helper inserts paths in reverse order. Keeping RuntimeEntry00-09 documents that
    // truncation happens after deterministic from/to ordering, not insertion order.
    expect(summary.runtime_paths).toEqual(expectedRuntimePaths)
    expect(summary.runtime_paths.map(({ from }: GraphSummaryRuntimePath) => from)).not.toContain('RuntimeEntry10')
    expect(summary.runtime_paths.map(({ from }: GraphSummaryRuntimePath) => from)).not.toContain('RuntimeEntry11')

    const repeatedSummary = buildGraphSummary(graph)
    expect(repeatedSummary.runtime_paths).toEqual(summary.runtime_paths)
  })

  it('produces deterministic output on repeated calls', () => {
    const graph = makeRichGraph()
    const s1 = buildGraphSummary(graph)
    const s2 = buildGraphSummary(graph)

    expect(s1).toEqual(s2)
  })
})
