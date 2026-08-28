import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

/**
 * #722 FULL_GENERATE_ONLY_V1 — federation withdrawal.
 *
 * Federation derived a new semantic artifact from persisted semantic artifacts.
 * The refusal must happen before any graph is loaded and before any output
 * directory or artifact is created.
 */

function twoGraphFixture(): { dir: string; graphs: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'madar-722-fed-'))
  const graphs: string[] = []
  for (const repo of ['frontend', 'backend']) {
    const outDir = join(dir, repo, 'out')
    mkdirSync(outDir, { recursive: true })
    const graphPath = join(outDir, 'graph.json')
    writeFileSync(graphPath, JSON.stringify({
      schema_version: 2, directed: true, nodes: [], links: [],
      graph: { root_path: join(dir, repo) },
    }))
    graphs.push(graphPath)
  }
  return { dir, graphs }
}

const expectUnsupportedMode = (error: unknown, mode: string): void => {
  const typed = error as { code?: string, mode?: string }
  expect(typed.code).toBe('UNSUPPORTED_GENERATION_MODE')
  expect(typed.mode).toBe(mode)
}

describe('FULL-GENERATE-ONLY federation withdrawal', () => {
  test('precondition: the fixture graphs are genuinely loadable by the real loader', async () => {
    const { graphs } = twoGraphFixture()
    const { loadGraph } = await import('../../src/runtime/serve.js')
    // If these were unreadable, "federate loaded nothing" would be true for the
    // wrong reason and the control below would be vacuous.
    for (const graphPath of graphs) {
      expect(() => loadGraph(graphPath)).not.toThrow()
    }
  })

  test('federate refuses before loading any persisted graph', async () => {
    const { graphs } = twoGraphFixture()

    vi.resetModules()
    const actualServe = await vi.importActual<typeof import('../../src/runtime/serve.js')>(
      '../../src/runtime/serve.js',
    )
    let graphLoads = 0
    vi.doMock('../../src/runtime/serve.js', () => ({
      ...actualServe,
      loadGraph: (...args: Parameters<typeof actualServe.loadGraph>) => {
        graphLoads += 1
        return actualServe.loadGraph(...args)
      },
    }))

    try {
      const { federate } = await import('../../src/pipeline/federate.js')
      try { federate(graphs); throw new Error('expected a refusal') }
      catch (error) { expectUnsupportedMode(error, 'federate') }

      expect(graphLoads, 'FEDERATION_PERSISTED_GRAPH_READ_BEFORE_REFUSAL').toBe(0)
    } finally {
      vi.doUnmock('../../src/runtime/serve.js')
      vi.resetModules()
    }
  })

  test('federate refuses before creating an output directory or publishing anything', async () => {
    const { dir, graphs } = twoGraphFixture()
    const outputDir = join(dir, 'out-federated')
    const before = readdirSync(dir).sort()

    const { federate } = await import('../../src/pipeline/federate.js')
    try { federate(graphs, { outputDir }); throw new Error('expected a refusal') }
    catch (error) { expectUnsupportedMode(error, 'federate') }

    expect(existsSync(outputDir), 'FEDERATION_PUBLICATION_BEFORE_REFUSAL').toBe(false)
    expect(readdirSync(dir).sort()).toStrictEqual(before)
  })

  test('federate refuses on empty input too, rather than reporting a usage error', async () => {
    // The old empty-input guard lived inside the deleted body. An empty call
    // must reach the same withdrawal, not a message about argument counts.
    const { federate } = await import('../../src/pipeline/federate.js')
    try { federate([]); throw new Error('expected a refusal') }
    catch (error) { expectUnsupportedMode(error, 'federate') }
  })
})
