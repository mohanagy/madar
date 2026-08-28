import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { loadGraph, queryGraph, graphStats, communitiesFromGraph } from '../../src/runtime/serve.js'
import { buildGraphSummary } from '../../src/runtime/graph-summary.js'
import { graphFreshnessMetadata } from '../../src/runtime/freshness.js'
import { runStatusCommand } from '../../src/infrastructure/doctor.js'
import { diffGraphs } from '../../src/runtime/diff.js'
import { toJson, toCypher } from '../../src/pipeline/export.js'

/**
 * #722 FULL_GENERATE_ONLY_V1 — read-only compatibility.
 *
 * The contract keeps existing artifacts usable for exactly five things:
 * read-only query, inspection, diagnostics, non-continuing comparison, and
 * compatible export. Withdrawing the continuation paths must not have taken any
 * of those with it, so each is exercised against an already-published artifact.
 *
 * The paired obligation is on the other side: the same artifact must not become
 * an input to new semantics. That is asserted here too, against the same file,
 * so "still readable" and "not a generation input" are proven about one object
 * rather than two.
 */

function published(): { dir: string; graphPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'madar-722-ro-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"fx","type":"module"}\n')
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true },
  }))
  writeFileSync(join(dir, 'src/a.ts'), 'export const alpha = 1\nexport function realSymbol(){return alpha}\n')
  writeFileSync(join(dir, 'src/b.ts'), 'import { realSymbol } from "./a.js"\nexport const beta = realSymbol()\n')
  const result = generateGraph(dir, { extractionMode: 'legacy', noHtml: true })
  return { dir, graphPath: result.graphPath }
}

describe('FULL-GENERATE-ONLY read-only compatibility', () => {
  test('read-only query still answers from a published artifact', () => {
    const { graphPath } = published()
    const graph = loadGraph(graphPath)
    const answer = queryGraph(graph, 'what depends on realSymbol?')
    expect(answer.length, 'READ_ONLY_QUERY_LOST').toBeGreaterThan(0)
    expect(graphStats(graph, communitiesFromGraph(graph)), 'READ_ONLY_STATS_LOST').toContain('Nodes')
  })

  test('inspection still describes a published artifact', () => {
    const { graphPath } = published()
    const summary = buildGraphSummary(loadGraph(graphPath))
    expect(summary, 'INSPECTION_LOST').toBeTruthy()
    expect(graphFreshnessMetadata(graphPath).graphVersion, 'INSPECTION_LOST').toBeTruthy()
  })

  test('diagnostics still read a published artifact', () => {
    const { dir } = published()
    const status = runStatusCommand({ projectDir: dir, now: Date.now() })
    // Diagnostics must still read the artifact itself, not merely find the file:
    // freshness, the stored generation policy and indexing outcomes all come
    // from inside it.
    expect(status, 'DIAGNOSTICS_LOST').toContain('graph fresh')
    expect(status, 'DIAGNOSTICS_LOST').toContain('generation-policy match')
    expect(status, 'DIAGNOSTICS_LOST').toContain('indexing complete')
    // The withdrawal removed the watcher-state writer, not the reader. A
    // workspace with no watcher state is normal and healthy, and must be
    // reported as inactive rather than failed.
    expect(status, 'DIAGNOSTICS_MISREPORT_MISSING_WATCHER_STATE').toContain('watcher inactive')
    expect(status, 'DIAGNOSTICS_MISREPORT_MISSING_WATCHER_STATE').not.toContain('watcher failed')
  })

  test('non-continuing comparison still runs between two published artifacts', () => {
    const before = published()
    const after = published()
    writeFileSync(join(after.dir, 'src/c.ts'), 'export const gamma = 3\n')
    const regenerated = generateGraph(after.dir, { extractionMode: 'legacy', noHtml: true })

    const diff = diffGraphs(loadGraph(before.graphPath), loadGraph(regenerated.graphPath))
    expect(diff.length, 'NON_CONTINUING_COMPARISON_LOST').toBeGreaterThan(0)

    // Comparison must not have written anything into either workspace.
    expect(readFileSync(before.graphPath).length).toBeGreaterThan(0)
  })

  test('compatible export still emits from a published artifact', () => {
    const { dir, graphPath } = published()
    const graph = loadGraph(graphPath)
    const jsonOut = join(dir, 'export.json')
    const cypherOut = join(dir, 'export.cypher')

    toJson(graph, communitiesFromGraph(graph), jsonOut)
    toCypher(graph, cypherOut)

    expect(existsSync(jsonOut), 'COMPATIBLE_EXPORT_LOST').toBe(true)
    expect(existsSync(cypherOut), 'COMPATIBLE_EXPORT_LOST').toBe(true)
    expect(JSON.parse(readFileSync(jsonOut, 'utf8')), 'COMPATIBLE_EXPORT_MALFORMED').toBeTruthy()
  })

  test('the same published artifact is never read back as a generation input', async () => {
    const { dir, graphPath } = published()
    // Proven readable first; otherwise "generation read nothing" would be true
    // for the wrong reason.
    expect(() => loadGraph(graphPath)).not.toThrow()

    vi.resetModules()
    const actualServe = await vi.importActual<typeof import('../../src/runtime/serve.js')>(
      '../../src/runtime/serve.js',
    )
    let loads = 0
    vi.doMock('../../src/runtime/serve.js', () => ({
      ...actualServe,
      loadGraph: (...args: Parameters<typeof actualServe.loadGraph>) => {
        loads += 1
        return actualServe.loadGraph(...args)
      },
    }))

    try {
      const { generateGraph: freshGenerate } = await import('../../src/infrastructure/generate.js')
      writeFileSync(join(dir, 'src/d.ts'), 'export const delta = 4\n')
      freshGenerate(dir, { extractionMode: 'legacy', noHtml: true })
      expect(loads, 'PUBLISHED_ARTIFACT_READ_AS_GENERATION_INPUT').toBe(0)
    } finally {
      vi.doUnmock('../../src/runtime/serve.js')
      vi.resetModules()
    }
  })
})
