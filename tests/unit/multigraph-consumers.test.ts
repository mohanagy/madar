import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { toCypher, toSvg } from '../../src/pipeline/export.js'
import { _edgeWeight, _louvainTopologyMetrics, cluster } from '../../src/pipeline/cluster.js'

const COMMUNITIES = { 0: ['a', 'b'] } as never

function graphWith(relations: readonly string[]): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })
  graph.addNode('a', { label: 'Alpha', community: 0 })
  graph.addNode('b', { label: 'Beta', community: 0 })
  for (const relation of relations) graph.addEdge('a', 'b', { relation, confidence: 'EXTRACTED' })
  return graph
}

const one = (): KnowledgeGraph => graphWith(['calls'])
const many = (): KnowledgeGraph => graphWith(['calls', 'injects', 'depends_on'])

function svg(graph: KnowledgeGraph): string {
  const path = join(mkdtempSync(join(tmpdir(), 'madar-consumer-')), 'graph.svg')
  toSvg(graph, COMMUNITIES, path)
  return readFileSync(path, 'utf8')
}

function cypher(graph: KnowledgeGraph): string {
  const path = join(mkdtempSync(join(tmpdir(), 'madar-consumer-')), 'graph.cypher')
  toCypher(graph, path)
  return readFileSync(path, 'utf8')
}

describe('topology is multiplicity-invariant', () => {
  it('keeps one endpoint pair however many facts it carries', () => {
    expect(one().numberOfEndpointPairs()).toBe(1)
    expect(many().numberOfEndpointPairs()).toBe(1)
    expect(many().numberOfFacts()).toBe(3)
  })

  it('visits a neighbour once', () => {
    expect(many().successors('a')).toEqual(['b'])
    expect(many().predecessors('b')).toEqual(['a'])
    expect(many().neighbors('a')).toEqual(['b'])
    expect(many().incidentNeighbors('a')).toEqual(['b'])
  })

  it('does not inflate degree with parallel facts', () => {
    expect(many().uniqueNeighborDegree('a')).toBe(one().uniqueNeighborDegree('a'))
  })

  it('does not let parallel facts inflate Louvain weight', () => {
    // Louvain consumes endpoint entries and accumulates per entry, so a pair
    // appearing more than once would inflate total weight and node degree
    // silently while the suite stayed green at N=1.
    expect(_louvainTopologyMetrics(many())).toEqual(_louvainTopologyMetrics(one()))
    expect(_edgeWeight(many(), 'a', 'b')).toBe(_edgeWeight(one(), 'a', 'b'))
    expect(cluster(many())).toEqual(cluster(one()))
  })

  it('keeps occurrences out of topology entirely', () => {
    const graph = one()
    const before = graph.numberOfEndpointPairs()
    graph.addEdge('a', 'b', { relation: 'calls', confidence: 'EXTRACTED' }, {
      recordOccurrence: true,
      occurrence: {
        owner: { adapterId: 'test-adapter', strategy: 'probe' },
        sourceFile: 'a.ts',
        adapterEvidenceKey: 'second-site',
      },
    })

    expect(graph.numberOfOccurrences()).toBeGreaterThan(0)
    expect(graph.numberOfEndpointPairs()).toBe(before)
    expect(graph.uniqueNeighborDegree('a')).toBe(1)
  })
})

describe('relationsBetween is deterministic', () => {
  it('returns each relation once', () => {
    const graph = graphWith(['calls', 'calls', 'injects'])

    expect(graph.relationsBetween('a', 'b')).toEqual(['calls', 'injects'])
  })

  it('is independent of insertion order', () => {
    expect(graphWith(['injects', 'depends_on', 'calls']).relationsBetween('a', 'b'))
      .toEqual(graphWith(['calls', 'injects', 'depends_on']).relationsBetween('a', 'b'))
  })

  it('does not hide qualifying facts from the fact APIs', () => {
    const graph = graphWith(['calls', 'calls'])

    // One relation string, but both facts must remain reachable.
    expect(graph.relationsBetween('a', 'b')).toEqual(['calls'])
    expect(graph.factsBetween('a', 'b').length).toBe(graph.numberOfFacts())
  })
})

describe('SVG renders one geometry per endpoint pair', () => {
  it('draws a single line whatever the fact count', () => {
    expect((svg(one()).match(/<line /g) ?? [])).toHaveLength(1)
    expect((svg(many()).match(/<line /g) ?? [])).toHaveLength(1)
  })

  it('does not darken or thicken a pair as facts accumulate', () => {
    const single = svg(one())
    const parallel = svg(many())
    const stroke = (text: string): string[] => text.match(/stroke-opacity="[^"]*"|stroke-width="[^"]*"/g) ?? []

    // Additive rendering would read as edge weight, which the picture does not
    // mean: multiplicity is a semantic property, not connection strength.
    expect(stroke(parallel)).toEqual(stroke(single))
  })

  it('still represents every relation on the pair', () => {
    const rendered = svg(many())

    expect(rendered).toContain('<title>calls, depends_on, injects</title>')
  })

  it('is stable under reversed insertion', () => {
    expect(svg(graphWith(['depends_on', 'injects', 'calls']))).toBe(svg(many()))
  })
})

describe('Cypher export keys on semantic fact identity', () => {
  it('writes one relationship per fact', () => {
    expect((cypher(one()).match(/MERGE \(a\)-\[/g) ?? [])).toHaveLength(1)
    expect((cypher(many()).match(/MERGE \(a\)-\[/g) ?? [])).toHaveLength(3)
  })

  it('gives every relationship a distinct fact id in the MERGE pattern', () => {
    const text = cypher(many())
    const ids = text.match(/fact_id: '(sf_[0-9a-f]{64})'/g) ?? []

    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
  })

  it('does not collapse two relations between one pair', () => {
    const text = cypher(graphWith(['calls', 'injects']))

    expect(text).toContain(':CALLS')
    expect(text).toContain(':INJECTS')
  })

  it('keeps the same fact idempotent', () => {
    // The same fact admitted twice is one fact, so one relationship.
    expect((cypher(graphWith(['calls', 'calls'])).match(/MERGE \(a\)-\[/g) ?? [])).toHaveLength(1)
  })

  it('creates no relationship for an extra occurrence', () => {
    const graph = one()
    graph.addEdge('a', 'b', { relation: 'calls', confidence: 'EXTRACTED' }, {
      recordOccurrence: true,
      occurrence: {
        owner: { adapterId: 'test-adapter', strategy: 'probe' },
        sourceFile: 'a.ts',
        adapterEvidenceKey: 'extra-site',
      },
    })

    expect((cypher(graph).match(/MERGE \(a\)-\[/g) ?? [])).toHaveLength(1)
  })
})
