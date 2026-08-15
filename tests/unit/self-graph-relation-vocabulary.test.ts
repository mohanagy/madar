import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { resolveRelationDiscriminator } from '../../src/contracts/relation-discriminator.js'
import { extract } from '../../src/pipeline/extract.js'
import { buildFromJson } from '../../src/pipeline/build.js'

const SRC = new URL('../../src', import.meta.url).pathname

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? sources(full) : full.endsWith('.ts') ? [full] : []
  })
}

describe('self-graph relation vocabulary', () => {
  /**
   * The empirical control. The static inventory is the completeness proof; this
   * asserts the shipped pipeline agrees with it, so a relation reaching storage
   * that no inventory predicted cannot pass silently.
   */
  it('admits every relation the real extractor emits, with zero refusals', () => {
    const files = sources(SRC).slice(0, 400)
    const extraction = extract(files) as unknown as {
      edges: readonly { relation?: unknown }[]
    }

    const emitted = new Set(
      extraction.edges
        .map((edge) => edge.relation)
        .filter((relation): relation is string => typeof relation === 'string'),
    )
    expect(emitted.size, 'extraction produced no relations; the control proves nothing').toBeGreaterThan(0)

    const unregistered = [...emitted].filter((relation) => (
      (resolveRelationDiscriminator(relation as never) as { status: string }).status === 'unregistered'
    )).sort()

    expect(unregistered, `self-graph emits unregistered relations: ${unregistered.join(', ')}`).toEqual([])

    const graph = buildFromJson(extraction)
    expect(graph.storageAdmissionSummary()).toEqual({
      unresolvedUnregisteredRelationCandidates: 0,
      unregisteredRelationCounts: {},
    })
    expect(graph.numberOfFacts()).toBeGreaterThan(0)
  })

  it('still degrades a deliberately injected unknown relation', () => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.addNode('a', {})
    graph.addNode('b', {})
    graph.addEdge('a', 'b', { relation: 'deliberately_unknown_probe' })

    // Mutation control: proves the zero above is an observed zero, not a
    // counter that never increments.
    expect(graph.storageAdmissionSummary().unresolvedUnregisteredRelationCandidates).toBe(1)
    expect(graph.numberOfFacts()).toBe(0)
  })
})
