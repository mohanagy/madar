import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { loadGraphArtifact } from '../../src/contracts/graph-artifact.js'
import { graphDiff, graphStructureMetrics } from '../../src/pipeline/analyze.js'
import { cluster } from '../../src/pipeline/cluster.js'
import { toSvg } from '../../src/pipeline/export.js'

/**
 * copy() and subgraph() re-admit every stored fact through addEdge. A fact
 * loaded from a v1 artifact carries a legacy discriminator, which addEdge
 * refuses unless the caller declares the v1 compatibility path -- so the copy
 * threw on every v1-loaded graph, which is every graph until #705 completes
 * the cutover. Four production call sites reach this: graph diffing, SVG
 * export, clustering, and incremental generation.
 */
const V1_ARTIFACT = JSON.stringify({
  schema_version: 1,
  directed: true,
  nodes: [
    { id: 'a', label: 'A', file_type: 'code', source_file: 'a.ts' },
    { id: 'b', label: 'B', file_type: 'code', source_file: 'b.ts' },
    { id: 'c', label: 'C', file_type: 'code', source_file: 'c.ts' },
  ],
  links: [
    { source: 'a', target: 'b', relation: 'calls', confidence: 'EXTRACTED' },
    { source: 'b', target: 'c', relation: 'imports', confidence: 'EXTRACTED' },
  ],
})

const loaded = (): ReturnType<typeof loadGraphArtifact>['graph'] => loadGraphArtifact(V1_ARTIFACT).graph

describe('copying a v1-loaded graph', () => {
  it('carries every fact into the copy', () => {
    const graph = loaded()
    expect(graph.numberOfFacts()).toBe(2)

    const copy = graph.copy()

    expect(copy.numberOfFacts()).toBe(2)
    expect(copy.nodeIds().sort()).toEqual(['a', 'b', 'c'])
  })

  it('preserves semantic fact identity through the copy', () => {
    const graph = loaded()
    const before = graph.factRecords().map(({ fact }) => fact.id).sort()

    const after = graph.copy().factRecords().map(({ fact }) => fact.id).sort()

    // Identity is content-derived, so an id change here would mean the copy
    // silently produced different facts rather than the same ones.
    expect(after).toEqual(before)
  })

  it('subgraphs a v1-loaded graph', () => {
    const graph = loaded()

    const sub = graph.subgraph(['a', 'b'])

    expect(sub.nodeIds().sort()).toEqual(['a', 'b'])
    expect(sub.numberOfFacts()).toBe(1)
  })

  it('still refuses a legacy discriminator arriving from outside the v1 path', () => {
    const graph = loaded()
    const record = graph.factRecords()[0]
    if (record === undefined) throw new Error('the v1 fixture produced no facts')
    const { fact } = record

    // The copy path carries the marker; it does not remove the restriction.
    // A caller fabricating a legacy discriminator is still refused.
    expect(() => graph.addEdge('a', 'c', { relation: 'calls', confidence: 'EXTRACTED' }, {
      discriminator: fact.discriminator,
    })).toThrow(/v1 artifact compatibility path/)
  })
})

/** Everything a copy must carry across unchanged. */
function shape(graph: ReturnType<typeof loaded>): Record<string, unknown> {
  return {
    factIds: graph.factRecords().map(({ fact }) => fact.id).sort(),
    occurrenceIds: graph.factRecords()
      .flatMap(({ fact }) => graph.occurrencesForFact(fact.id).map((occurrence) => occurrence.id))
      .sort(),
    endpointQualifications: graph.nodeIds().sort()
      .map((id) => [id, graph.nodeEndpointIdentity(id)] as const),
    topology: graph.endpointEntries()
      .map(({ source, target }) => `${source}->${target}`).sort(),
    counts: {
      nodes: graph.numberOfNodes(),
      facts: graph.numberOfFacts(),
      pairs: graph.numberOfEndpointPairs(),
      occurrences: graph.numberOfOccurrences(),
    },
    admission: graph.storageAdmissionSummary(),
  }
}

describe('a v1-loaded copy preserves the whole graph, not just its facts', () => {
  it('carries ids, qualifications, topology, counts and diagnostics across', () => {
    const graph = loaded()

    expect(shape(graph.copy())).toEqual(shape(graph))
  })

  it('keeps copied facts legacy rather than laundering them', () => {
    const copy = loaded().copy()

    // The copy passes the compatibility marker; it must not strip or invent
    // legacy status, or the artifact would no longer describe what it loaded.
    expect(copy.factRecords().every(({ fact }) => fact.discriminator.legacy === true)).toBe(true)
  })

  it('does not mark an ordinary graph legacy when copying it', () => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.addNode('a', {})
    graph.addNode('b', {})
    graph.addEdge('a', 'b', { relation: 'calls', confidence: 'EXTRACTED' })

    const copy = graph.copy()

    expect(copy.numberOfFacts()).toBe(1)
    expect(copy.factRecords().every(({ fact }) => fact.discriminator.legacy === undefined)).toBe(true)
  })
})

describe('the four production paths that copy or subgraph a loaded graph', () => {
  it('diffs a v1-loaded graph against its own copy as unchanged', () => {
    const graph = loaded()

    const diff = graphDiff(graph, graph.copy())

    expect(diff.new_edges).toEqual([])
    expect(diff.removed_edges).toEqual([])
    expect(diff.new_nodes).toEqual([])
    expect(diff.removed_nodes).toEqual([])
  })

  it('computes structure metrics, which subgraph the loaded graph', () => {
    expect(() => graphStructureMetrics(loaded())).not.toThrow()
    expect(graphStructureMetrics(loaded()).total_edges).toBeGreaterThan(0)
  })

  it('clusters a v1-loaded graph', () => {
    expect(() => cluster(loaded())).not.toThrow()
  })

  it('renders SVG from a v1-loaded graph', () => {
    const root = mkdtempSync(join(tmpdir(), 'v1-copy-svg-'))
    try {
      const output = join(root, 'graph.svg')
      const graph = loaded()

      expect(() => toSvg(graph, cluster(graph), output)).not.toThrow()
      expect(readFileSync(output, 'utf8')).toContain('<svg')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
