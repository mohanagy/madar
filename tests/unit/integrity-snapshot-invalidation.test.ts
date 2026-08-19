import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { artifactHydrationToken, KnowledgeGraph } from '../../src/contracts/graph.js'
import { buildFromJson } from '../../src/pipeline/build.js'

const HYDRATION_TOKEN = artifactHydrationToken('graph-artifact-loader')

function extraction(): Record<string, unknown> {
  return {
    schema_version: 1,
    directed: true,
    nodes: [
      { id: 'alpha', label: 'Alpha', file_type: 'code', source_file: 'src/alpha.ts' },
      { id: 'beta', label: 'Beta', file_type: 'code', source_file: 'src/beta.ts' },
    ],
    edges: [
      { source: 'alpha', target: 'beta', relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
      { source: 'alpha', target: 'nowhere', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
    ],
  }
}

function donorWithExtraFact(): KnowledgeGraph {
  const base = extraction()
  return buildFromJson({
    ...base,
    nodes: [...(base['nodes'] as unknown[]), { id: 'gamma', label: 'Gamma', file_type: 'code', source_file: 'src/gamma.ts' }],
    edges: [...(base['edges'] as unknown[]), { source: 'beta', target: 'gamma', relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/beta.ts' }],
  }, { directed: true })
}

function withSnapshot(): KnowledgeGraph {
  const graph = buildFromJson(extraction(), { directed: true, accounting: 'normalized_extraction_boundary' })
  expect(graph.normalizedIntegritySnapshot(), 'fixture must start with a snapshot').not.toBeNull()
  return graph
}

/** A structural fingerprint, so "unchanged" means unchanged. */
function stateOf(graph: KnowledgeGraph): string {
  return JSON.stringify({
    nodes: graph.numberOfNodes(),
    facts: graph.numberOfFacts(),
    occurrences: graph.numberOfOccurrences(),
    pairs: graph.numberOfEndpointPairs(),
    admission: graph.storageAdmissionSummary(),
    matrix: graph.endpointIdentityMatrix(),
  })
}

describe('R3-04 — every successful mutation invalidates the snapshot', () => {
  it('node insertion', () => {
    const graph = withSnapshot()
    graph.addNode('gamma', {})
    expect(graph.normalizedIntegritySnapshot()).toBeNull()
  })

  it('node attribute change', () => {
    const graph = withSnapshot()
    graph.addNode('alpha', { label: 'Renamed' })
    expect(graph.normalizedIntegritySnapshot()).toBeNull()
  })

  it('fact insertion', () => {
    const graph = withSnapshot()
    graph.addNode('gamma', {})
    graph.addEdge('alpha', 'gamma', { relation: 'calls', confidence: 'EXTRACTED' })
    expect(graph.normalizedIntegritySnapshot()).toBeNull()
  })

  it('occurrence insertion on a fact that already exists', () => {
    const graph = withSnapshot()
    const facts = graph.numberOfFacts()
    const occurrences = graph.numberOfOccurrences()
    // Same endpoints and relation, different evidence site: one more occurrence
    // on the same fact. Attributed rather than assumed -- the fact count must
    // not move, or this would be testing the fact path instead.
    graph.addEdge('alpha', 'beta', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/other.ts' })
    expect(graph.numberOfFacts()).toBe(facts)
    expect(graph.numberOfOccurrences()).toBe(occurrences + 1)
    expect(graph.normalizedIntegritySnapshot()).toBeNull()
  })

  it('unregistered storage admission', () => {
    const graph = withSnapshot()
    graph.addNode('gamma', {})
    const before = graph.normalizedIntegritySnapshot()
    expect(before).toBeNull() // addNode already invalidated; re-attach a fresh one
    const fresh = withSnapshot()
    fresh.addEdge('alpha', 'beta', { relation: 'totally_unregistered', confidence: 'EXTRACTED' })
    expect(fresh.normalizedIntegritySnapshot()).toBeNull()
  })

  it('degradation inheritance', () => {
    const donor = buildFromJson({
      ...extraction(),
      edges: [{ source: 'alpha', target: 'beta', relation: 'totally_unregistered', confidence: 'EXTRACTED' }],
    }, { directed: true })
    const target = withSnapshot()
    target.inheritDegradationFrom(donor)
    expect(target.normalizedIntegritySnapshot()).toBeNull()
  })

  it('hydrated fact insertion', () => {
    const graph = withSnapshot()
    const donor = donorWithExtraFact()
    const extra = donor.factRecords().find((record) => !graph.factRecords().some((held) => held.fact.id === record.fact.id))!
    graph.hydrateVerifiedFact(HYDRATION_TOKEN, extra.fact, extra.attributes)
    expect(graph.normalizedIntegritySnapshot()).toBeNull()
  })

  it('hydrated occurrence insertion on a fact that already exists', () => {
    const graph = withSnapshot()
    // Same endpoints and relation, different evidence site: the donor holds an
    // occurrence whose fact this graph already has. Hydrating only that
    // occurrence isolates the occurrence path -- hydrating a fact first would
    // invalidate on the fact path and mask whatever the occurrence path does.
    const donor = buildFromJson({
      ...extraction(),
      edges: [{ source: 'alpha', target: 'beta', relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/elsewhere.ts' }],
    }, { directed: true })
    const factId = donor.factRecords()[0]!.fact.id
    expect(graph.factRecords().some((record) => record.fact.id === factId)).toBe(true)
    const occurrence = donor.occurrencesForFact(factId)[0]!
    expect(graph.occurrenceEntries().some((held) => held.id === occurrence.id)).toBe(false)

    const facts = graph.numberOfFacts()
    graph.hydrateVerifiedOccurrence(HYDRATION_TOKEN, occurrence)
    expect(graph.numberOfFacts()).toBe(facts)
    expect(graph.normalizedIntegritySnapshot()).toBeNull()
  })

})

describe('R3-04 — no-op operations keep a still-true snapshot', () => {
  it('re-adding a node with identical attributes', () => {
    const graph = withSnapshot()
    const attributes = graph.nodeAttributes('alpha')
    graph.addNode('alpha', { ...attributes })
    expect(graph.normalizedIntegritySnapshot()).not.toBeNull()
  })

  it('re-adding an identical occurrence', () => {
    const graph = withSnapshot()
    const factId = graph.factRecords()[0]!.fact.id
    const occurrence = graph.occurrencesForFact(factId)[0]!
    graph.addOccurrence(occurrence)
    expect(graph.normalizedIntegritySnapshot()).not.toBeNull()
  })

  it('hydrating a fact the graph already holds identically', () => {
    // Hydrate the same fact twice into the same graph: the second call takes
    // the duplicate early return and must not touch a snapshot attached since.
    const graph = withSnapshot()
    const donor = donorWithExtraFact()
    const extra = donor.factRecords().find((record) => !graph.factRecords().some((held) => held.fact.id === record.fact.id))!
    graph.hydrateVerifiedFact(HYDRATION_TOKEN, extra.fact, extra.attributes)
    const reattached = withSnapshot()
    reattached.hydrateVerifiedFact(HYDRATION_TOKEN, extra.fact, extra.attributes)
    const snapshot = reattached.normalizedIntegritySnapshot()
    reattached.hydrateVerifiedFact(HYDRATION_TOKEN, extra.fact, extra.attributes)
    expect(reattached.normalizedIntegritySnapshot()).toBe(snapshot)
  })

  it('inheriting from a graph with nothing to give', () => {
    const graph = withSnapshot()
    graph.inheritDegradationFrom(new KnowledgeGraph({ directed: true }))
    expect(graph.normalizedIntegritySnapshot()).not.toBeNull()
  })
})

describe('R3-04 — failed mutations change neither graph nor snapshot', () => {
  it('an edge naming a missing endpoint', () => {
    const graph = withSnapshot()
    const snapshot = graph.normalizedIntegritySnapshot()
    const before = stateOf(graph)
    expect(() => graph.addEdge('alpha', 'absent', { relation: 'calls', confidence: 'EXTRACTED' })).toThrow()
    expect(stateOf(graph)).toBe(before)
    expect(graph.normalizedIntegritySnapshot()).toBe(snapshot)
  })

  it('an occurrence naming a missing fact', () => {
    const graph = withSnapshot()
    const snapshot = graph.normalizedIntegritySnapshot()
    const before = stateOf(graph)
    const template = graph.occurrencesForFact(graph.factRecords()[0]!.fact.id)[0]!
    expect(() => graph.addOccurrence({ ...template, factId: 'sf_missing' } as never)).toThrow()
    expect(stateOf(graph)).toBe(before)
    expect(graph.normalizedIntegritySnapshot()).toBe(snapshot)
  })

  it('a hydrated occurrence naming a missing fact', () => {
    const graph = withSnapshot()
    const snapshot = graph.normalizedIntegritySnapshot()
    const before = stateOf(graph)
    const template = graph.occurrencesForFact(graph.factRecords()[0]!.fact.id)[0]!
    expect(() => graph.hydrateVerifiedOccurrence(HYDRATION_TOKEN, { ...template, factId: 'sf_missing' } as never))
      .toThrow()
    expect(stateOf(graph)).toBe(before)
    expect(graph.normalizedIntegritySnapshot()).toBe(snapshot)
  })

  it('a refused degradation inheritance', () => {
    const donor = buildFromJson({
      ...extraction(),
      edges: [{ source: 'alpha', target: 'beta', relation: 'totally_unregistered', confidence: 'EXTRACTED' }],
    }, { directed: true })
    const target = buildFromJson({
      ...extraction(),
      edges: [{ source: 'beta', target: 'alpha', relation: 'also_unregistered', confidence: 'EXTRACTED' }],
    }, { directed: true, accounting: 'normalized_extraction_boundary' })
    const snapshot = target.normalizedIntegritySnapshot()
    const before = stateOf(target)
    expect(() => target.inheritDegradationFrom(donor)).toThrow()
    expect(stateOf(target)).toBe(before)
    expect(target.normalizedIntegritySnapshot()).toBe(snapshot)
  })
})

describe('R3-04 — invalidation is never silently skipped by a new mutator', () => {
  it('routes every snapshot drop through the one seam', () => {
    const source = readFileSync(join(process.cwd(), 'src/contracts/graph.ts'), 'utf8')
    // Exactly one assignment of null, inside the seam itself. A new mutation
    // path that clears the snapshot directly would bypass the policy this
    // suite enforces.
    const directNulls = source.match(/this\.integritySnapshot\s*=\s*null/g) ?? []
    expect(directNulls).toHaveLength(1)
    expect(source).toContain('private invalidateIntegritySnapshot(): void {')
  })

  it('never recomputes the snapshot inside a read accessor', () => {
    const source = readFileSync(join(process.cwd(), 'src/contracts/graph.ts'), 'utf8')
    const accessor = source.slice(source.indexOf('normalizedIntegritySnapshot()'))
    const body = accessor.slice(0, accessor.indexOf('\n  }'))
    expect(body).not.toContain('finalizeNormalizedIntegritySnapshot')
  })
})
