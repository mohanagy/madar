import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { loadGraphArtifact } from '../../src/contracts/graph-artifact.js'
import { resolveRelationDiscriminator } from '../../src/contracts/relation-discriminator.js'
import {
  FatalIdentityCollisionError,
  SemanticIdentityFactory,
  createSemanticFactId,
  type SemanticFactIdentityInput,
} from '../../src/contracts/semantic-identity.js'

function discriminator(relation: string): never {
  const resolution = resolveRelationDiscriminator(relation as never)
  if (resolution.status !== 'registered') throw new Error(`${relation} is not registered`)
  return resolution.discriminator as never
}

const factInput = (source: string, target: string): SemanticFactIdentityInput => ({
  direction: 'directed',
  source,
  target,
  relation: 'calls',
  discriminator: discriminator('calls'),
})

/** Every payload hashes to one digest, so any second distinct payload collides. */
const alwaysCollide = (): string => 'a'.repeat(64)

describe('a collision inside one operation is fatal', () => {
  it('rejects a second distinct payload on the same factory', () => {
    const identity = new SemanticIdentityFactory(alwaysCollide)

    expect(identity.createSemanticFactId(factInput('a', 'b'))).toMatch(/^sf_a{64}$/)
    expect(() => identity.createSemanticFactId(factInput('c', 'd')))
      .toThrow(FatalIdentityCollisionError)
  })

  it('accepts the identical payload twice, because that is not a collision', () => {
    const identity = new SemanticIdentityFactory(alwaysCollide)

    const first = identity.createSemanticFactId(factInput('a', 'b'))
    const second = identity.createSemanticFactId(factInput('a', 'b'))

    expect(second).toBe(first)
    expect(identity.witnessCount).toBe(1)
  })
})

describe('witnesses do not outlive their operation', () => {
  it('starts every scope empty', () => {
    for (let index = 0; index < 50; index += 1) {
      const identity = new SemanticIdentityFactory()
      identity.createSemanticFactId(factInput(`a${index}`, `b${index}`))

      // A process-global map would make this climb to 50. It cannot, because
      // there is no longer a shared factory for it to climb in.
      expect(identity.witnessCount).toBe(1)
    }
  })

  it('keeps one operation blind to the witnesses of another', () => {
    const first = new SemanticIdentityFactory(alwaysCollide)
    const second = new SemanticIdentityFactory(alwaysCollide)

    first.createSemanticFactId(factInput('a', 'b'))

    // Under the old shared default this threw: an unrelated earlier operation
    // had already claimed the digest.
    expect(() => second.createSemanticFactId(factInput('c', 'd'))).not.toThrow()
  })

  it('gives each unscoped helper call its own single-call scope', () => {
    // Documented limitation: these detect nothing across calls. The guarantee
    // being pinned is only that they accumulate nothing either.
    const first = createSemanticFactId(factInput('a', 'b'))
    const second = createSemanticFactId(factInput('a', 'b'))

    expect(second).toBe(first)
  })
})

describe('graph and artifact operations each own one scope', () => {
  const build = (): KnowledgeGraph => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.addNode('a', {})
    graph.addNode('b', {})
    graph.addNode('c', {})
    graph.addEdge('a', 'b', { relation: 'calls', confidence: 'EXTRACTED' })
    graph.addEdge('b', 'c', { relation: 'imports', confidence: 'EXTRACTED' })
    return graph
  }

  it('derives identical ids in two independent graph scopes', () => {
    // Separate scopes must not see each other's witnesses, and must still
    // agree on content-derived identity.
    const left = build().factRecords().map(({ fact }) => fact.id).sort()
    const right = build().factRecords().map(({ fact }) => fact.id).sort()

    expect(right).toEqual(left)
    expect(left).toHaveLength(2)
  })

  it('repeats graph construction 50 times without cross-scope failure', () => {
    const first = build().factRecords().map(({ fact }) => fact.id).sort()

    for (let index = 0; index < 50; index += 1) {
      expect(build().factRecords().map(({ fact }) => fact.id).sort()).toEqual(first)
    }
  })

  it('verifies every id on artifact load and preserves them', () => {
    const artifact = JSON.stringify({
      schema_version: 1,
      directed: true,
      nodes: [
        { id: 'a', label: 'A', file_type: 'code', source_file: 'a.ts' },
        { id: 'b', label: 'B', file_type: 'code', source_file: 'b.ts' },
      ],
      links: [{ source: 'a', target: 'b', relation: 'calls', confidence: 'EXTRACTED' }],
    })

    const first = loadGraphArtifact(artifact).graph.factRecords().map(({ fact }) => fact.id)
    const second = loadGraphArtifact(artifact).graph.factRecords().map(({ fact }) => fact.id)

    // Two loads are two scopes; identity is content-derived so they agree, and
    // neither depends on witnesses left behind by the other.
    expect(second).toEqual(first)
  })

  it('preserves ids through copy and subgraph without shared witness state', () => {
    const graph = build()
    const before = graph.factRecords().map(({ fact }) => fact.id).sort()

    expect(graph.copy().factRecords().map(({ fact }) => fact.id).sort()).toEqual(before)
    expect(graph.subgraph(['a', 'b']).factRecords().map(({ fact }) => fact.id))
      .toEqual(before.filter((id) => graph.factRecords()
        .some(({ fact }) => fact.id === id && fact.source === 'a' && fact.target === 'b')))
  })
})
