import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildGraphFromExtraction } from '../../src/application/build-graph.js'
import {
  GRAPH_ARTIFACT_REGENERATE_MESSAGE,
  deserializeGraphArtifact,
  serializeGraphArtifact,
} from '../../src/domain/graph/artifact.js'
import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'

const evidence = (sourceFile: string, sourceLocation: string) => ({
  confidence: 'EXTRACTED',
  relation: 'calls',
  source_file: sourceFile,
  source_location: sourceLocation,
  provenance: [
    {
      capability_id: 'builtin:extract:typescript',
      stage: 'extract',
      source_file: sourceFile,
      source_location: sourceLocation,
    },
  ],
})

function addNodes(graph: KnowledgeGraph): void {
  graph.addNode('caller', { label: 'caller()', source_file: 'src/caller.ts' })
  graph.addNode('callee', { label: 'callee()', source_file: 'src/callee.ts' })
}

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(path)
      } else if (entry.isFile() && path.endsWith('.ts')) {
        files.push(path)
      }
    }
  }
  visit(root)
  return files
}

describe('KnowledgeGraph', () => {
  it('keeps parallel relationship kinds, distinct evidence, and the reverse direction', () => {
    const graph = new KnowledgeGraph({ root_path: '/workspace/repo' })
    addNodes(graph)

    const callsId = graph.addEdge('caller', 'callee', evidence('/workspace/repo/src/caller.ts', 'L10'))
    const duplicateId = graph.addEdge('caller', 'callee', evidence('/workspace/repo/src/caller.ts', 'L10'))
    const importId = graph.addEdge('caller', 'callee', {
      ...evidence('/workspace/repo/src/caller.ts', 'L1'),
      relation: 'imports_from',
    })
    const secondCallId = graph.addEdge('caller', 'callee', evidence('/workspace/repo/src/caller.ts', 'L20'))
    const reverseId = graph.addEdge('callee', 'caller', {
      ...evidence('/workspace/repo/src/callee.ts', 'L30'),
      relation: 'returns_to',
    })

    expect(duplicateId).toBe(callsId)
    expect(new Set([callsId, importId, secondCallId, reverseId]).size).toBe(4)
    expect(graph.numberOfEdges()).toBe(4)
    expect(graph.edgesBetween('caller', 'callee').map((edge) => edge.attributes.relation)).toEqual([
      'calls',
      'calls',
      'imports_from',
    ])
    expect(graph.successors('caller')).toEqual(['callee'])
    expect(graph.predecessors('caller')).toEqual(['callee'])
    expect(graph.isDirected()).toBe(true)
  })

  it('keeps IDs stable across workspace roots and ignores timestamps in identity', () => {
    const first = new KnowledgeGraph({ root_path: '/Users/alice/work/repo' })
    const second = new KnowledgeGraph({ root_path: 'C:/Users/bob/work/repo' })
    addNodes(first)
    addNodes(second)

    const firstId = first.addEdge('caller', 'callee', {
      ...evidence('/Users/alice/work/repo/src/caller.ts', 'L10'),
      captured_at: '2026-07-20T00:00:00.000Z',
    })
    const secondId = second.addEdge('caller', 'callee', {
      ...evidence('C:/Users/bob/work/repo/src/caller.ts', 'L10'),
      captured_at: '2027-01-01T00:00:00.000Z',
    })

    expect(secondId).toBe(firstId)
  })

  it('normalizes lexical, UNC, nested-location, and duplicate provenance evidence', () => {
    const first = new KnowledgeGraph({ root_path: '//SERVER/Share/repo' })
    const second = new KnowledgeGraph({ root_path: '\\\\server\\share\\repo\\' })
    addNodes(first)
    addNodes(second)
    const firstId = first.addEdge('caller', 'callee', {
      relation: 'calls', source_file: '//SERVER/Share/repo/src/../src/caller.ts',
      provenance: [{ capability_id: 'ts', source_location: ' L10 ', captured_at: '2026' }],
    })
    const secondId = second.addEdge('caller', 'callee', {
      relation: 'calls', source_file: '\\\\server\\share\\repo\\src\\caller.ts',
      provenance: [
        { capability_id: 'ts', source_location: 'L10', captured_at: '2027' },
        { capability_id: 'ts', source_location: 'L10', captured_at: '2028' },
      ],
    })
    expect(secondId).toBe(firstId)

    const unrooted = new KnowledgeGraph()
    addNodes(unrooted)
    expect(() => unrooted.addEdge('caller', 'callee', evidence('/repo/src/caller.ts', 'L1')))
      .toThrow(/root_path is required/)

    const rooted = new KnowledgeGraph({ root_path: '/repo' })
    addNodes(rooted)
    const relativeId = rooted.addEdge('caller', 'callee', evidence('../repo/src/caller.ts', 'L4'))
    const absoluteId = rooted.addEdge('caller', 'callee', evidence('/repo/src/caller.ts', 'L4'))
    expect(relativeId).toBe(absoluteId)
    expect(() => rooted.addEdge('caller', 'callee', evidence('../outside/caller.ts', 'L5')))
      .toThrow(/outside root_path/)
  })

  it('reconciles equivalent normalized edge facts deterministically', () => {
    const later = new KnowledgeGraph({ root_path: '/repo' })
    const earlier = new KnowledgeGraph({ root_path: '/repo' })
    addNodes(later)
    addNodes(earlier)
    const first = {
      relation: 'calls', source_file: './src/caller.ts', captured_at: '2027-01-01',
      provenance: [{ capability_id: 'b', captured_at: '2027-01-01' }, { capability_id: 'a' }],
    }
    const second = {
      relation: 'calls', source_file: 'src/caller.ts', captured_at: '2026-01-01',
      provenance: [{ capability_id: 'a' }, { capability_id: 'b', captured_at: '2026-01-01' }],
    }

    const id = later.addEdge('caller', 'callee', first)
    expect(later.addEdge('caller', 'callee', second)).toBe(id)
    earlier.addEdge('caller', 'callee', second)
    earlier.addEdge('caller', 'callee', first)

    expect(later.numberOfEdges()).toBe(1)
    expect(serializeGraphArtifact(later)).toBe(serializeGraphArtifact(earlier))
  })

  it('protects identity metadata and counts multigraph degree', () => {
    const graph = new KnowledgeGraph({ root_path: '/repo', generation_policy: { mode: 'auto' } })
    addNodes(graph)
    graph.addEdge('caller', 'callee', evidence('/repo/src/caller.ts', 'L1'))
    graph.addEdge('caller', 'callee', evidence('/repo/src/caller.ts', 'L2'))
    graph.addEdge('callee', 'caller', evidence('/repo/src/callee.ts', 'L3'))

    expect(graph.degree('caller')).toBe(3)
    expect(() => { graph.graph.root_path = '/other' }).toThrow(/root_path cannot change/)
    expect(() => Object.defineProperty(graph.graph, 'root_path', { value: '/other' })).toThrow(/root_path cannot change/)
    expect(() => Object.setPrototypeOf(graph.graph, { root_path: '/other' })).toThrow()
    expect(() => { graph.graph.directed = false }).toThrow(/always directed/)
    expect(() => { graph.graph.invalid = () => undefined }).toThrow(/not JSON-safe/)
    expect(() => { (graph.graph.generation_policy as Record<string, unknown>).mode = 'spi' }).toThrow()
    expect(() => new KnowledgeGraph({ directed: 'false' })).toThrow(/always directed/)
    expect(() => graph.addEdge('caller', 'callee', { relation: ' calls ' })).toThrow(/trimmed/)
    expect(() => graph.addNode('bad\0id', {})).toThrow(/NUL/)
    expect(() => deserializeGraphArtifact(serializeGraphArtifact(graph))).not.toThrow()
  })

  it('keeps metadata as enumerable protected JSON data', () => {
    const graph = new KnowledgeGraph({ generation_policy: { mode: 'auto' } })
    Object.defineProperty(graph.graph, 'root_path', { value: '/repo' })
    ;(graph.graph as Record<string, unknown>).__proto__ = { marker: true }
    addNodes(graph)
    graph.addEdge('caller', 'callee', evidence('/repo/src/caller.ts', 'L1'))

    expect(Object.getPrototypeOf(graph.graph)).toBe(Object.prototype)
    expect(Object.getOwnPropertyDescriptor(graph.graph, 'root_path')?.enumerable).toBe(true)
    expect(Object.hasOwn(graph.graph, '__proto__')).toBe(true)
    expect(serializeGraphArtifact(deserializeGraphArtifact(serializeGraphArtifact(graph))))
      .toBe(serializeGraphArtifact(graph))
  })

  it('rejects accessors and hidden or symbolic graph data without invoking them', () => {
    let getterCalls = 0
    const accessor = { relation: 'calls' } as Record<string, unknown>
    Object.defineProperty(accessor, 'evidence', { enumerable: true, get: () => { getterCalls += 1; return 'random' } })
    const hidden = { relation: 'calls' }
    Object.defineProperty(hidden, 'evidence', { value: 'hidden' })
    const symbolic = { relation: 'calls', [Symbol('evidence')]: 'hidden' }
    const graph = new KnowledgeGraph()
    addNodes(graph)

    expect(() => graph.addEdge('caller', 'callee', accessor)).toThrow(/enumerable string data properties/)
    expect(() => graph.addEdge('caller', 'callee', hidden)).toThrow(/enumerable string data properties/)
    expect(() => graph.addEdge('caller', 'callee', symbolic)).toThrow(/enumerable string data properties/)
    expect(getterCalls).toBe(0)
  })

  it('serializes deterministically and round-trips IDs, metadata, confidence, and provenance', () => {
    const forward = new KnowledgeGraph({
      root_path: '/workspace/repo',
      generation_policy: { mode: 'auto', fingerprint: 'abc123' },
    })
    const reverse = new KnowledgeGraph({
      generation_policy: { fingerprint: 'abc123', mode: 'auto' },
      root_path: '/workspace/repo',
    })

    forward.addNode('caller', { source_file: 'src/caller.ts', label: 'caller()' })
    forward.addNode('callee', { label: 'callee()', source_file: 'src/callee.ts' })
    const edgeId = forward.addEdge('caller', 'callee', evidence('src/caller.ts', 'L10-L12'))
    forward.addEdge('caller', 'callee', {
      ...evidence('src/caller.ts', 'L1'),
      relation: 'imports_from',
    })
    forward.addEdge('callee', 'caller', {
      ...evidence('src/callee.ts', 'L30'),
      relation: 'returns_to',
    })

    reverse.addNode('callee', { source_file: 'src/callee.ts', label: 'callee()' })
    reverse.addNode('caller', { label: 'caller()', source_file: 'src/caller.ts' })
    reverse.addEdge('callee', 'caller', {
      ...evidence('src/callee.ts', 'L30'),
      relation: 'returns_to',
    })
    reverse.addEdge('caller', 'callee', {
      ...evidence('src/caller.ts', 'L1'),
      relation: 'imports_from',
    })
    reverse.addEdge('caller', 'callee', {
      source_location: 'L10-L12',
      source_file: 'src/caller.ts',
      relation: 'calls',
      provenance: [
        {
          source_location: 'L10-L12',
          source_file: 'src/caller.ts',
          stage: 'extract',
          capability_id: 'builtin:extract:typescript',
        },
      ],
      confidence: 'EXTRACTED',
    })

    const serialized = serializeGraphArtifact(forward)
    expect(serializeGraphArtifact(reverse)).toBe(serialized)

    const loaded = deserializeGraphArtifact(serialized)
    expect(serializeGraphArtifact(loaded)).toBe(serialized)
    expect(loaded.edgesBetween('caller', 'callee').find((edge) => edge.id === edgeId)?.attributes)
      .toEqual(evidence('src/caller.ts', 'L10-L12'))
    expect(loaded.relationKindsBetween('caller', 'callee')).toEqual(['calls', 'imports_from'])
    expect(loaded.relationKindsBetween('callee', 'caller')).toEqual(['returns_to'])
    expect(loaded.graph).toEqual(forward.graph)
  })

  it('keeps collision-safe node identities stable across roots and insertion order', () => {
    const extraction = (root: string, reversed: boolean) => {
      const nodes = [
        { id: 'worker', label: 'AlphaWorker', file_type: 'code', source_file: `${root}/src/alpha.ts`, source_location: 'L2' },
        { id: 'worker', label: 'BetaWorker', file_type: 'code', source_file: `${root}/src/beta.ts`, source_location: 'L8' },
      ]
      return { nodes: reversed ? nodes.reverse() : nodes, edges: [] }
    }

    const first = buildGraphFromExtraction(extraction('/Users/alice/repo', false), { rootPath: '/Users/alice/repo' })
    const second = buildGraphFromExtraction(extraction('C:/Users/bob/repo', true), { rootPath: 'C:/Users/bob/repo' })
    const binding = (graph: KnowledgeGraph) => Object.fromEntries(
      graph.nodeEntries().map(([id, attributes]) => [id, attributes.label]),
    )

    expect(binding(second)).toEqual(binding(first))
    expect(first.nodeIds()).toHaveLength(2)
    expect(first.nodeIds().every((id) => /^worker__[a-f0-9]{12}$/.test(id))).toBe(true)
  })

  it('builds all directed facts from the temporary extraction adapter', () => {
    const graph = buildGraphFromExtraction({
      schema_version: 2,
      root_path: '/workspace/repo',
      nodes: [
        { id: 'caller', label: 'caller()', file_type: 'code', source_file: '/workspace/repo/src/caller.ts' },
        { id: 'callee', label: 'callee()', file_type: 'code', source_file: '/workspace/repo/src/callee.ts' },
      ],
      edges: [
        { source: 'caller', target: 'callee', ...evidence('/workspace/repo/src/caller.ts', 'L10') },
        {
          source: 'caller',
          target: 'callee',
          ...evidence('/workspace/repo/src/caller.ts', 'L1'),
          relation: 'imports_from',
        },
        {
          source: 'callee',
          target: 'caller',
          ...evidence('/workspace/repo/src/callee.ts', 'L30'),
          relation: 'returns_to',
        },
      ],
    })

    const loaded = deserializeGraphArtifact(serializeGraphArtifact(graph))
    expect(loaded.numberOfEdges()).toBe(3)
    expect(loaded.edgesBetween('caller', 'callee').map((edge) => edge.attributes.relation).sort()).toEqual([
      'calls',
      'imports_from',
    ])
    expect(loaded.edgesBetween('callee', 'caller')[0]?.attributes.relation).toBe('returns_to')
  })

  it('rejects old artifacts with one actionable regeneration instruction', () => {
    expect(() => deserializeGraphArtifact(JSON.stringify({ schema_version: 2, nodes: [], links: [] }))).toThrow(
      GRAPH_ARTIFACT_REGENERATE_MESSAGE,
    )
  })

  it('strictly rejects duplicate and malformed canonical records with the regeneration instruction', () => {
    const graph = new KnowledgeGraph()
    graph.addNode('caller', {})
    const artifact = JSON.parse(serializeGraphArtifact(graph)) as {
      nodes: Array<{ id: string; attributes: Record<string, unknown> }>
    }
    artifact.nodes.push(structuredClone(artifact.nodes[0]!))
    expect(() => deserializeGraphArtifact(artifact)).toThrow(GRAPH_ARTIFACT_REGENERATE_MESSAGE)

    artifact.nodes = [{ id: '', attributes: {} }]
    expect(() => deserializeGraphArtifact(artifact)).toThrow(GRAPH_ARTIFACT_REGENERATE_MESSAGE)
  })

  it('round-trips metadata exactly without injecting graph flags', () => {
    const loaded = deserializeGraphArtifact({
      schema: 'madar.graph', version: 1, directed: true,
      metadata: { owner: 'core' }, nodes: [], edges: [],
    })
    expect(loaded.graph).toEqual({ owner: 'core' })
  })

  it('has no production imports of the five predecessor modules', () => {
    const sourceRoot = join(process.cwd(), 'src')
    const forbidden = [
      'contracts/graph',
      'pipeline/build',
      'pipeline/export',
      'core/schema/normalize',
      'runtime/direction',
    ]
    const violations = productionTypeScriptFiles(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return forbidden
        .filter((fragment) => source.includes(fragment))
        .map((fragment) => `${relative(process.cwd(), path)} -> ${fragment}`)
    })

    expect(violations).toEqual([])
  })
})
