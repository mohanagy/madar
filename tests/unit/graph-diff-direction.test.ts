import { describe, expect, it } from 'vitest'

import { GraphDirectionMismatchError, graphDiff } from '../../src/pipeline/analyze.js'
import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { diffGraphs } from '../../src/runtime/diff.js'
import { buildFromJson } from '../../src/pipeline/build.js'

function pair(directed: boolean, relations: readonly string[] = ['calls']): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed })
  graph.addNode('a', { label: 'Alpha' })
  graph.addNode('b', { label: 'Beta' })
  for (const relation of relations) graph.addEdge('a', 'b', { relation, confidence: 'EXTRACTED' })
  return graph
}

describe('graphDiff direction contract', () => {
  it('reports no change between two identical directed graphs', () => {
    const diff = graphDiff(pair(true), pair(true))

    expect(diff.new_edges).toEqual([])
    expect(diff.removed_edges).toEqual([])
    expect(diff.new_nodes).toEqual([])
  })

  it('reports no change between two identical undirected graphs', () => {
    const diff = graphDiff(pair(false), pair(false))

    expect(diff.new_edges).toEqual([])
    expect(diff.removed_edges).toEqual([])
  })

  it('fails closed when comparing a directed graph to an undirected one', () => {
    expect(() => graphDiff(pair(false), pair(true))).toThrow(GraphDirectionMismatchError)
  })

  it('names both modes and the remedy in the error', () => {
    try {
      graphDiff(pair(false), pair(true))
      expect.unreachable('expected a direction mismatch')
    } catch (error) {
      expect(error).toBeInstanceOf(GraphDirectionMismatchError)
      const mismatch = error as GraphDirectionMismatchError
      expect(mismatch.beforeDirected).toBe(false)
      expect(mismatch.afterDirected).toBe(true)
      expect(mismatch.message).toContain('before=undirected')
      expect(mismatch.message).toContain('after=directed')
      expect(mismatch.message).toContain('same graph-direction contract')
    }
  })

  it('never emits ordinary added/removed rows for a mismatch', () => {
    // The failure mode this replaces: every fact appearing as both removed and
    // added, which reads as real churn rather than an incomparable pair.
    let rows: unknown = 'not reached'
    try {
      rows = graphDiff(pair(false), pair(true))
    } catch {
      rows = 'threw'
    }

    expect(rows).toBe('threw')
  })

  it('catches a fixture that forgot directed: true', () => {
    // buildFromJson defaults to undirected, which is exactly how the stdio
    // baseline fixture silently became incomparable.
    const fixture = buildFromJson({
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [{ source: 'a', target: 'b', relation: 'calls' }],
    })

    expect(fixture.isDirected()).toBe(false)
    expect(() => graphDiff(fixture, pair(true))).toThrow(GraphDirectionMismatchError)
  })
})

describe('graphDiff fact identity', () => {
  it('treats a second relation on one pair as an independent added fact', () => {
    const diff = graphDiff(pair(true, ['calls']), pair(true, ['calls', 'injects']))

    expect(diff.new_edges).toHaveLength(1)
    expect(diff.new_edges[0]?.relation).toBe('injects')
    expect(diff.removed_edges).toEqual([])
  })

  it('gives every row a machine-distinguishable fact id', () => {
    const diff = graphDiff(pair(true, []), pair(true, ['calls', 'injects']))

    expect(diff.new_edges).toHaveLength(2)
    const ids = diff.new_edges.map((edge) => edge.fact_id)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id.startsWith('sf_')).toBe(true)
  })

  it('keeps the historically required row fields', () => {
    const diff = graphDiff(pair(true, []), pair(true, ['calls']))

    expect(diff.new_edges[0]).toMatchObject({
      source: 'a',
      target: 'b',
      relation: 'calls',
      confidence: 'EXTRACTED',
    })
  })

  it('is insensitive to insertion order', () => {
    const forward = graphDiff(pair(true, []), pair(true, ['calls', 'injects']))
    const reversed = graphDiff(pair(true, []), pair(true, ['injects', 'calls']))

    expect(forward.new_edges.map((edge) => edge.fact_id).sort())
      .toEqual(reversed.new_edges.map((edge) => edge.fact_id).sort())
    expect(forward.summary).toBe(reversed.summary)
  })

  it('does not report an occurrence-only change as a fact change', () => {
    const before = pair(true, ['calls'])

    const after = new KnowledgeGraph({ directed: true })
    after.addNode('a', { label: 'Alpha' })
    after.addNode('b', { label: 'Beta' })
    // Two distinct observation sites for the SAME semantic fact.
    for (const site of ['probe-site-one', 'probe-site-two']) {
      after.addEdge('a', 'b', { relation: 'calls', confidence: 'EXTRACTED' }, {
        recordOccurrence: true,
        occurrence: {
          owner: { adapterId: 'test-adapter', strategy: 'probe' },
          sourceFile: 'a.ts',
          siteKind: 'call',
          adapterEvidenceKey: site,
        },
      })
    }

    expect(after.numberOfFacts()).toBe(before.numberOfFacts())

    // Occurrences are evidence, not topology: adding one must not read as a
    // relationship appearing or disappearing.
    expect(after.numberOfOccurrences()).toBeGreaterThan(before.numberOfOccurrences())

    const diff = graphDiff(before, after)

    expect(diff.new_edges).toEqual([])
    expect(diff.removed_edges).toEqual([])
  })

  it('keeps simple N=1 graphs compatible', () => {
    const diff = graphDiff(pair(true, ['calls']), pair(true, ['calls']))

    expect(diff.summary).not.toContain('new edge')
    expect(diff.summary).not.toContain('edge removed')
  })
})

describe('graphDiff callers surface the mismatch', () => {
  it('diffGraphs propagates an actionable message', () => {
    expect(() => diffGraphs(pair(false), pair(true))).toThrow(/different direction modes/)
  })

  it('diffGraphs does not return an empty diff instead', () => {
    let output = ''
    try {
      output = diffGraphs(pair(false), pair(true))
    } catch (error) {
      output = `threw: ${(error as Error).message}`
    }

    expect(output).toContain('threw:')
    expect(output).not.toContain('Graph diff:')
  })
})
