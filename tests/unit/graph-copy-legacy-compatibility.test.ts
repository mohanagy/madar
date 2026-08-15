import { describe, expect, it } from 'vitest'

import { loadGraphArtifact } from '../../src/contracts/graph-artifact.js'

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
