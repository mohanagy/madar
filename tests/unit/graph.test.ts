import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : []
  })
}

// relative() returns backslash-separated paths on Windows; the assertions below
// compare against forward-slash paths, so normalize before comparing.
function relativePosixPath(from: string, to: string): string {
  return relative(from, to).split(sep).join('/')
}

function makeDirectedGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })
  graph.addNode('alpha', { label: 'Alpha' })
  graph.addNode('beta', { label: 'Beta' })
  graph.addNode('gamma', { label: 'Gamma' })
  graph.addEdge('alpha', 'beta', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: 'src/alpha.ts',
    source_location: 'L12',
    extraction_strategy: 'ast',
    layer: 'structural',
    metadata: { reason: 'direct invocation' },
  })
  graph.addEdge('beta', 'alpha', {
    relation: 'returns_to',
    confidence: 'INFERRED',
    source_file: 'src/beta.ts',
  })
  return graph
}

describe('KnowledgeGraph plural semantic projections', () => {
  it('returns an empty read-only collection when no relationship exists', () => {
    const graph = makeDirectedGraph()

    const facts = graph.factsBetween('alpha', 'gamma')

    expect(facts).toEqual([])
    expect(Object.isFrozen(facts)).toBe(true)
  })

  it('returns one complete relationship view for the current one-per-pair store', () => {
    const graph = makeDirectedGraph()

    expect(graph.factsBetween('alpha', 'beta')).toEqual([
      {
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: 'src/alpha.ts',
        source_location: 'L12',
        extraction_strategy: 'ast',
        layer: 'structural',
        metadata: { reason: 'direct invocation' },
      },
    ])
  })

  it('filters relationships deterministically by relation', () => {
    const graph = makeDirectedGraph()

    expect(graph.factsBetween('alpha', 'beta', { relations: ['calls'] })).toHaveLength(1)
    expect(graph.factsBetween('alpha', 'beta', { relations: ['imports', 'calls'] })).toHaveLength(1)
    expect(graph.factsBetween('alpha', 'beta', { relations: ['imports'] })).toEqual([])
  })

  it('returns unique stable relation values', () => {
    const graph = makeDirectedGraph()

    expect(graph.relationsBetween('alpha', 'beta')).toEqual(['calls'])
    expect(graph.relationsBetween('alpha', 'beta')).toEqual(['calls'])
    expect(graph.relationsBetween('alpha', 'gamma')).toEqual([])
  })

  it('does not let returned collections or relationship views mutate graph state', () => {
    const graph = makeDirectedGraph()
    const facts = graph.factsBetween('alpha', 'beta')

    expect(() => (facts as Array<Record<string, unknown>>).push({ relation: 'imports' })).toThrow()
    expect(() => {
      ;(facts[0] as Record<string, unknown>).relation = 'imports'
    }).toThrow()
    expect(() => {
      ;(facts[0]?.metadata as Record<string, unknown>).reason = 'mutated'
    }).toThrow()
    expect(graph.relationsBetween('alpha', 'beta')).toEqual(['calls'])
    expect(graph.factsBetween('alpha', 'beta')[0]?.metadata).toEqual({ reason: 'direct invocation' })
  })

  it('refuses to project function-valued attributes by reference', () => {
    const graph = new KnowledgeGraph({ directed: true })
    const callback = () => 'live closure'
    graph.addEdge('alpha', 'beta', { relation: 'calls', callback })

    expect(() => graph.factsBetween('alpha', 'beta')).toThrow(
      'Cannot create an immutable graph projection for a function-valued attribute',
    )
    expect(graph.edgeAttributes('alpha', 'beta').callback).toBe(callback)
  })

  it('isolates SharedArrayBuffer-backed views from returned relationship values', () => {
    const graph = new KnowledgeGraph({ directed: true })
    const sharedView = new Uint8Array(new SharedArrayBuffer(3))
    sharedView.set([1, 2, 3])
    graph.addEdge('alpha', 'beta', { relation: 'calls', bytes: sharedView })

    const returnedView = graph.factsBetween('alpha', 'beta')[0]?.bytes as Uint8Array
    returnedView[0] = 99

    const freshView = graph.factsBetween('alpha', 'beta')[0]?.bytes as Uint8Array
    expect([...freshView]).toEqual([1, 2, 3])
    expect(freshView.buffer).toBeInstanceOf(ArrayBuffer)
  })
})

describe('KnowledgeGraph semantic entries', () => {
  it('preserves current edge entry attributes and insertion order', () => {
    const graph = makeDirectedGraph()

    expect(graph.factEntries()).toEqual(graph.edgeEntries())
    expect(graph.factEntries()).toEqual([
      ['alpha', 'beta', expect.objectContaining({ relation: 'calls', source_location: 'L12' })],
      ['beta', 'alpha', expect.objectContaining({ relation: 'returns_to', confidence: 'INFERRED' })],
    ])
  })
})

describe('KnowledgeGraph explicit topology', () => {
  it('preserves directed endpoint insertion order', () => {
    const graph = makeDirectedGraph()

    expect(graph.endpointEntries()).toEqual([
      { source: 'alpha', target: 'beta' },
      { source: 'beta', target: 'alpha' },
    ])
  })

  it('preserves the inserted orientation of an undirected endpoint pair', () => {
    const graph = new KnowledgeGraph()
    graph.addEdge('beta', 'alpha', { relation: 'calls' })

    expect(graph.endpointEntries()).toEqual([{ source: 'beta', target: 'alpha' }])
    expect(graph.hasEdge('alpha', 'beta')).toBe(true)
  })

  it('keeps successor, predecessor, and neighbor collections unique', () => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.addEdge('alpha', 'beta', { relation: 'calls' })
    graph.addEdge('alpha', 'beta', { relation: 'imports' })

    expect(graph.successors('alpha')).toEqual(['beta'])
    expect(graph.predecessors('beta')).toEqual(['alpha'])
    expect(graph.neighbors('alpha')).toEqual(['beta'])
  })

  it('reports the same unique-neighbor degree as the compatibility API', () => {
    const graph = makeDirectedGraph()

    for (const nodeId of graph.nodeIds()) {
      expect(graph.uniqueNeighborDegree(nodeId)).toBe(graph.degree(nodeId))
    }
  })
})

describe('KnowledgeGraph explicit counts', () => {
  it('truthfully separates current fact and endpoint-pair counts', () => {
    const graph = makeDirectedGraph()

    expect(graph.numberOfFacts()).toBe(graph.numberOfEdges())
    expect(graph.numberOfEndpointPairs()).toBe(graph.numberOfEdges())
    expect(graph.numberOfFacts()).toBe(2)
    expect(graph.numberOfEndpointPairs()).toBe(2)
    expect(graph.numberOfNodes()).toBe(3)
  })
})

describe('KnowledgeGraph compatibility surface', () => {
  it('preserves singular attributes, entries, counts, degree, and missing-edge behavior', () => {
    const graph = makeDirectedGraph()

    expect(graph.edgeAttributes('alpha', 'beta')).toEqual(expect.objectContaining({ relation: 'calls' }))
    expect(graph.edgeEntries()).toHaveLength(2)
    expect(graph.numberOfEdges()).toBe(2)
    expect(graph.degree('alpha')).toBe(1)
    expect(() => graph.edgeAttributes('alpha', 'gamma')).toThrow('Unknown edge: alpha -> gamma')
  })
})

describe('graph API architecture boundary', () => {
  it('keeps singular edge lookup inside the compatibility implementation', () => {
    const sourceRoot = join(process.cwd(), 'src')
    const usages = sourceFiles(sourceRoot).flatMap((path) => {
      const lines = readFileSync(path, 'utf8').split('\n')
      return lines.flatMap((line, index) => line.includes('edgeAttributes(')
        ? [`${relativePosixPath(process.cwd(), path)}:${index + 1}:${line.trim()}`]
        : [])
    })

    expect(usages).toEqual([
      expect.stringMatching(/^src\/contracts\/graph\.ts:\d+:edgeAttributes\(source: string, target: string\): GraphAttributes \{$/),
    ])
  })

  it('rejects arbitrary first- or last-item selection from plural relationship queries', () => {
    const violations = sourceFiles(join(process.cwd(), 'src')).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      const selectsByIndex = /factsBetween\s*\([^)]*\)\s*(?:\[\s*(?:0|-1)\s*\]|\.at\(\s*(?:0|-1)\s*\))/g
      const destructuresFirst = /(?:const|let|var)\s*\[\s*[^,\]]+\s*\]\s*=\s*[^;\n]*factsBetween\s*\(/g
      return [...source.matchAll(selectsByIndex), ...source.matchAll(destructuresFirst)]
        .map((match) => `${relativePosixPath(process.cwd(), path)}:${match[0]}`)
    })

    expect(violations).toEqual([])
  })
})
