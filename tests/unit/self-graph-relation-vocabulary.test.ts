import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { resolveRelationDiscriminator } from '../../src/contracts/relation-discriminator.js'
import { extract } from '../../src/pipeline/extract.js'
import { buildFromJson } from '../../src/pipeline/build.js'

// fileURLToPath, not .pathname: on Windows a file URL's pathname is
// "/D:/repo/src", and the leading slash makes join/readdir resolve it against
// the current drive as "D:\\D:\\repo\\src", which does not exist.
const SRC = fileURLToPath(new URL('../../src', import.meta.url))

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
  /**
   * Extracts every production source file under src/ -- 189 of them today.
   *
   * This previously said "400 real production files" and sliced to 400. src/
   * has never held that many, so the slice was inert and the number was simply
   * wrong wherever it was quoted. The corpus is the whole tree, and the count
   * is asserted below rather than described, because a corpus claim that
   * nothing checks is how the wrong number survived in the first place.
   *
   * Budget: this test could not run on Windows at all until the file-URL path
   * defect was fixed, so every earlier observation excluded the slowest
   * platform. Measured now: ~19-27 s macOS, ~24-41 s Linux, ~81-86 s Windows,
   * where TypeScript extraction over many small files is several times slower.
   * 90 s left Windows at 96% of its ceiling, so 180 s restores real headroom.
   * That is not the number being raised to hide a regression -- it is the first
   * budget set with Windows data in it. Runtime scales with the corpus, so a
   * substantially larger src/ means revisiting this rather than trimming files.
   *
   * `extract()` is synchronous, so this timeout is a post-hoc scheduling
   * allowance. It cannot interrupt a wedged extraction and is not a deadlock
   * guard.
   */
  it('admits every relation the real extractor emits, with zero refusals', () => {
    const started = Date.now()
    const files = sources(SRC)
    // The corpus is the control. A scan that collapsed to a handful of files --
    // a bad root, an excluded directory, a platform path quirk -- would still
    // emit relations and still pass every assertion below. A floor rather than
    // an exact count so adding a source file does not fail the build.
    expect(files.length, 'the self-graph corpus collapsed').toBeGreaterThan(150)
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

    // Recorded so a reviewer can see the real cost against the 180 s budget.
    console.log(`[self-graph audit] ${files.length} files, ${emitted.size} relations, ${Date.now() - started} ms`)
  }, 180_000)

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
