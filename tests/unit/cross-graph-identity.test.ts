import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { GraphFactIdentityConflictError, graphDiff } from '../../src/pipeline/analyze.js'
import { resolveRelationDiscriminator } from '../../src/contracts/relation-discriminator.js'

function discriminator(relation: string): unknown {
  const resolution = resolveRelationDiscriminator(relation as never)
  if (resolution.status !== 'registered') throw new Error(`${relation} is not registered`)
  return resolution.discriminator
}

/**
 * A graph whose facts are supplied directly.
 *
 * Two real graphs cannot disagree about what one fact id means without an
 * actual SHA-256 collision, so the invariant is unreachable through the public
 * API. That is precisely why it needs a stub: a defensive check nothing can
 * exercise is a check nobody can trust. Only the surface graphDiff consumes is
 * modelled here.
 */
function graphWithFacts(facts: readonly unknown[]): KnowledgeGraph {
  const real = new KnowledgeGraph({ directed: true })
  real.addNode('a', { label: 'A' })
  real.addNode('b', { label: 'B' })
  return Object.assign(Object.create(Object.getPrototypeOf(real) as object) as KnowledgeGraph, real, {
    factRecords: () => facts.map((fact) => ({ fact, attributes: { confidence: 'EXTRACTED' } })),
  }) as KnowledgeGraph
}

const fact = (id: string, source: string, target: string): unknown => ({
  id,
  direction: 'directed',
  source,
  target,
  relation: 'calls',
  discriminator: discriminator('calls'),
})

const SHARED_ID = 'sf_' + 'a'.repeat(64)

describe('one fact id must mean one fact across graphs', () => {
  it('refuses a diff where a shared id describes different content', () => {
    const before = graphWithFacts([fact(SHARED_ID, 'a', 'b')])
    const after = graphWithFacts([fact(SHARED_ID, 'b', 'a')])

    expect(() => graphDiff(before, after)).toThrow(GraphFactIdentityConflictError)
  })

  it('names the offending fact id', () => {
    const before = graphWithFacts([fact(SHARED_ID, 'a', 'b')])
    const after = graphWithFacts([fact(SHARED_ID, 'b', 'a')])

    try {
      graphDiff(before, after)
      throw new Error('expected a conflict')
    } catch (error) {
      expect((error as GraphFactIdentityConflictError).factId).toBe(SHARED_ID)
    }
  })

  it('accepts a shared id that describes the same fact', () => {
    const before = graphWithFacts([fact(SHARED_ID, 'a', 'b')])
    const after = graphWithFacts([fact(SHARED_ID, 'a', 'b')])

    expect(() => graphDiff(before, after)).not.toThrow()
  })

  it('does not false-positive on two ordinary graphs', () => {
    const build = (): KnowledgeGraph => {
      const graph = new KnowledgeGraph({ directed: true })
      graph.addNode('a', {})
      graph.addNode('b', {})
      graph.addEdge('a', 'b', { relation: 'calls', confidence: 'EXTRACTED' })
      return graph
    }

    expect(() => graphDiff(build(), build())).not.toThrow()
  })
})
