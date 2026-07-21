import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildGraph, buildGraphFromExtraction } from '../../src/application/build-graph.js'
import { serializeGraphArtifact } from '../../src/domain/graph/artifact.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

function loadExtraction(): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'extraction.json'), 'utf8'))
}

describe('build', () => {
  it('always preserves opposite directions as separate edges', () => {
    const graph = buildGraphFromExtraction(
      {
        nodes: [
          { id: 'n1', label: 'A', file_type: 'code', source_file: 'a.py' },
          { id: 'n2', label: 'B', file_type: 'code', source_file: 'b.py' },
        ],
        edges: [
          { source: 'n1', target: 'n2', relation: 'calls', confidence: 'EXTRACTED', source_file: 'a.py' },
          { source: 'n2', target: 'n1', relation: 'returns_to', confidence: 'INFERRED', source_file: 'b.py' },
        ],
      },
    )

    expect(graph.isDirected()).toBe(true)
    expect(graph.numberOfEdges()).toBe(2)
    expect(graph.successors('n1')).toEqual(['n2'])
    expect(graph.successors('n2')).toEqual(['n1'])
    expect(graph.uniqueEdgeBetween('n1', 'n2').attributes.relation).toBe('calls')
    expect(graph.uniqueEdgeBetween('n2', 'n1').attributes.relation).toBe('returns_to')
  })

  it('builds the expected node count from extraction json', () => {
    const graph = buildGraphFromExtraction(loadExtraction())
    expect(graph.numberOfNodes()).toBe(4)
  })

  it('does not merge same-named declarations at different source locations', () => {
    const graph = buildGraphFromExtraction({
      nodes: [
        { id: 'alpha_worker', label: 'Worker', file_type: 'code', source_file: '/repo/worker.rs', source_location: 'L2' },
        { id: 'beta_worker', label: 'Worker', file_type: 'code', source_file: '/repo/worker.rs', source_location: 'L8' },
      ],
      edges: [],
    }, { rootPath: '/repo' })

    expect(graph.nodeIds()).toEqual(['alpha_worker', 'beta_worker'])
  })

  it('does not merge declarations at different columns on the same line', () => {
    const graph = buildGraphFromExtraction({
      nodes: [
        { id: 'left', label: 'Worker', file_type: 'code', source_file: '/repo/worker.ts', source_location: 'L1C1' },
        { id: 'right', label: 'Worker', file_type: 'code', source_file: '/repo/worker.ts', source_location: 'L1C20' },
      ],
      edges: [],
    }, { rootPath: '/repo' })
    expect(graph.nodeIds()).toEqual(['left', 'right'])
  })

  it('merges two extractor views of the same declaration without losing facts', () => {
    const graph = buildGraphFromExtraction({
      nodes: [
        {
          id: 'generic_handler',
          label: 'handler()',
          file_type: 'code',
          source_file: '/repo/src/handler.ts',
          source_location: 'L12-L20',
          framework: 'express',
        },
        {
          id: 'src_handler_handler',
          label: 'handler()',
          file_type: 'code',
          source_file: '/repo/src/handler.ts',
          source_location: 'L12',
          route_path: '/health',
        },
      ],
      edges: [],
    }, { rootPath: '/repo' })

    expect(graph.numberOfNodes()).toBe(1)
    expect(graph.nodeAttributes('src_handler_handler')).toMatchObject({
      framework: 'express',
      route_path: '/health',
    })
  })

  it('does not merge repeated extractor IDs at distinct declaration locations', () => {
    const graph = buildGraphFromExtraction({
      nodes: [
        { id: 'logout_action', label: 'logout', file_type: 'code', source_file: '/repo/slice.ts', source_location: 'L4', node_kind: 'function' },
        { id: 'logout_action', label: 'logout', file_type: 'code', source_file: '/repo/slice.ts', source_location: 'L8', node_kind: 'route' },
      ],
      edges: [],
    }, { rootPath: '/repo' })

    expect(graph.nodeIds()).toHaveLength(2)
    expect(graph.nodeIds().every((id) => id.startsWith('logout_action__'))).toBe(true)
  })

  it('keeps conflicting labels for one extractor ID ambiguous', () => {
    expect(() => buildGraphFromExtraction({
      nodes: [
        { id: 'shared', label: 'first', file_type: 'code', source_file: '/repo/a.ts', source_location: 'L1' },
        { id: 'shared', label: 'second', file_type: 'code', source_file: '/repo/a.ts', source_location: 'L2' },
        { id: 'caller', label: 'caller', file_type: 'code', source_file: '/repo/a.ts', source_location: 'L3' },
      ],
      edges: [{ source: 'caller', target: 'shared', relation: 'calls', confidence: 'EXTRACTED', source_file: '/repo/a.ts' }],
    }, { rootPath: '/repo' })).toThrow(/endpoint "shared" is ambiguous/)
  })

  it('rejects an ambiguous cross-file endpoint instead of guessing', () => {
    expect(() => buildGraphFromExtraction({
      nodes: [
        { id: 'caller', label: 'caller()', file_type: 'code', source_file: '/repo/caller.ts', source_location: 'L5' },
        { id: 'service', label: 'ImportedService', file_type: 'code', source_file: '/repo/caller.ts', source_location: 'L1' },
        { id: 'service', label: 'Service', file_type: 'code', source_file: '/repo/service.ts', source_location: 'L1' },
      ],
      edges: [{ source: 'caller', target: 'service', relation: 'calls', confidence: 'EXTRACTED', source_file: '/repo/caller.ts' }],
    }, { rootPath: '/repo' })).toThrow(/endpoint "service" is ambiguous/)
  })

  it('keeps ingestion provenance and bytes stable across fact order', () => {
    const nodes = [
      { id: 'a', label: 'A', file_type: 'document' as const, source_file: 'notes.md', source_location: 'L1', source_url: 'https://example.com/a.pdf' },
      { id: 'b', label: 'B', file_type: 'document' as const, source_file: 'notes.md', source_location: 'L2', source_url: 'https://example.com/b.pdf' },
    ]
    const edge = { source: 'a', target: 'b', relation: 'contains', confidence: 'EXTRACTED' as const, source_file: 'notes.md' }
    const forward = buildGraphFromExtraction({ nodes, edges: [edge] })
    const reverse = buildGraphFromExtraction({ nodes: [...nodes].reverse(), edges: [edge] })
    expect(serializeGraphArtifact(reverse)).toBe(serializeGraphArtifact(forward))
  })

  it('serializes hyperedge facts independently of extraction order', () => {
    const nodes = [
      { id: 'a', label: 'A', file_type: 'code' as const, source_file: 'a.ts' },
      { id: 'b', label: 'B', file_type: 'code' as const, source_file: 'b.ts' },
    ]
    const hyperedges = [
      { id: 'z', nodes: ['a'], label: 'Z' },
      { id: 'a', nodes: ['b'], label: 'A' },
    ]
    const forward = buildGraphFromExtraction({ nodes, edges: [], hyperedges })
    const reverse = buildGraphFromExtraction({ nodes, edges: [], hyperedges: [...hyperedges].reverse().concat(hyperedges[0]!) })
    expect(serializeGraphArtifact(reverse)).toBe(serializeGraphArtifact(forward))
    expect(reverse.graph.hyperedges).toHaveLength(2)
  })

  it('keeps collision IDs stable across Windows root casing', () => {
    const nodes = [
      { id: 'worker', label: 'A', file_type: 'code' as const, source_file: 'C:/Repo/a.ts', source_location: 'L1' },
      { id: 'worker', label: 'B', file_type: 'code' as const, source_file: 'C:/Repo/b.ts', source_location: 'L1' },
    ]
    expect(buildGraphFromExtraction({ nodes, edges: [] }, { rootPath: 'c:/repo' }).nodeIds())
      .toEqual(buildGraphFromExtraction({ nodes, edges: [] }, { rootPath: 'C:/Repo' }).nodeIds())
  })

  it('preserves ordered arrays and rejects ambiguous hyperedge members', () => {
    const graph = buildGraphFromExtraction({
      nodes: [{ id: 'fn', label: 'fn()', file_type: 'code', source_file: 'a.ts', parameter_names: ['z', 'a'] }],
      edges: [],
    })
    expect(graph.nodeAttributes('fn').parameter_names).toEqual(['z', 'a'])

    expect(() => buildGraphFromExtraction({
      nodes: [
        { id: 'x', label: 'A', file_type: 'code', source_file: 'a.ts', source_location: 'L1' },
        { id: 'x', label: 'B', file_type: 'code', source_file: 'b.ts', source_location: 'L1' },
      ],
      edges: [], hyperedges: [{ id: 'h', nodes: ['x'] }],
    })).toThrow(/endpoint "x" is ambiguous/)
  })

  it('records missing endpoint facts deterministically', () => {
    const graph = buildGraphFromExtraction({
      nodes: [{ id: 'a', label: 'A', file_type: 'code', source_file: 'a.ts' }],
      edges: [
        { source: 'missing', target: 'a', relation: 'calls', confidence: 'EXTRACTED', source_file: 'a.ts' },
        { source: 'a', target: 'missing', relation: 'calls', confidence: 'EXTRACTED', source_file: 'a.ts' },
      ],
    })
    expect(graph.numberOfEdges()).toBe(0)
    expect(graph.graph.build_diagnostics).toEqual([
      'Dropped edge "a" -> "missing": endpoint missing',
      'Dropped edge "missing" -> "a": endpoint missing',
    ])
  })

  it('builds the expected edge count from extraction json', () => {
    const graph = buildGraphFromExtraction(loadExtraction())
    expect(graph.numberOfEdges()).toBe(4)
  })

  it('preserves node labels', () => {
    const graph = buildGraphFromExtraction(loadExtraction())
    expect(graph.nodeAttributes('n_transformer').label).toBe('Transformer')
  })

  it('preserves inferred edge confidence', () => {
    const graph = buildGraphFromExtraction(loadExtraction())
    expect(graph.uniqueEdgeBetween('n_attention', 'n_concept_attn').attributes.confidence).toBe('INFERRED')
  })

  it('preserves ambiguous edge confidence', () => {
    const graph = buildGraphFromExtraction(loadExtraction())
    expect(graph.uniqueEdgeBetween('n_layernorm', 'n_concept_attn').attributes.confidence).toBe('AMBIGUOUS')
  })

  it('preserves schema version when merging multiple extractions', () => {
    const graph = buildGraph([
      {
        schema_version: 1,
        nodes: [{ id: 'n1', label: 'A', file_type: 'code', source_file: 'a.py' }],
        edges: [],
        hyperedges: [],
        input_tokens: 0,
        output_tokens: 0,
      },
      {
        schema_version: 2,
        nodes: [{ id: 'n2', label: 'B', file_type: 'document', source_file: 'b.md', layer: 'semantic' }],
        edges: [
          {
            source: 'n1',
            target: 'n2',
            relation: 'references',
            confidence: 'INFERRED',
            source_file: 'b.md',
            layer: 'semantic',
            provenance: [{ capability_id: 'test:merge-schema-version' }],
            weight: 1.0,
          },
        ],
        hyperedges: [],
        input_tokens: 0,
        output_tokens: 0,
      },
    ])

    expect(graph.graph.schema_version).toBe(2)
  })

  it('merges multiple extractions into one graph', () => {
    const graph = buildGraph([
      {
        nodes: [{ id: 'n1', label: 'A', file_type: 'code', source_file: 'a.py' }],
        edges: [],
        input_tokens: 0,
        output_tokens: 0,
      },
      {
        nodes: [{ id: 'n2', label: 'B', file_type: 'document', source_file: 'b.md' }],
        edges: [
          {
            source: 'n1',
            target: 'n2',
            relation: 'references',
            confidence: 'INFERRED',
            source_file: 'b.md',
            weight: 1.0,
          },
        ],
        input_tokens: 0,
        output_tokens: 0,
      },
    ])

    expect(graph.numberOfNodes()).toBe(2)
    expect(graph.numberOfEdges()).toBe(1)
  })

  it('merges multiple extractions without losing direction', () => {
    const graph = buildGraph(
      [
        {
          nodes: [
            { id: 'n1', label: 'A', file_type: 'code', source_file: 'a.py' },
            { id: 'n2', label: 'B', file_type: 'code', source_file: 'b.py' },
          ],
          edges: [{ source: 'n1', target: 'n2', relation: 'calls', confidence: 'EXTRACTED', source_file: 'a.py' }],
          input_tokens: 0,
          output_tokens: 0,
        },
        {
          nodes: [],
          edges: [{ source: 'n2', target: 'n1', relation: 'responds_to', confidence: 'INFERRED', source_file: 'b.py' }],
          input_tokens: 0,
          output_tokens: 0,
        },
      ],
    )

    expect(graph.isDirected()).toBe(true)
    expect(graph.numberOfEdges()).toBe(2)
    expect(graph.uniqueEdgeBetween('n1', 'n2').attributes.relation).toBe('calls')
    expect(graph.uniqueEdgeBetween('n2', 'n1').attributes.relation).toBe('responds_to')
  })

})
