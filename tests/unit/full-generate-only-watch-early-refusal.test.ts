import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { executeCli } from '../../src/cli/main.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { resolveMadarOutputDirectory } from '../../src/shared/workspace.js'

/**
 * #722 FULL_GENERATE_ONLY_V1 — watch must refuse before generating.
 *
 * PREQUAL occurrence 1: both `madar generate --watch` and `madar watch` ran a
 * full generation and published a graph, and only then reached the watch
 * refusal. An unsupported operation must not have side effects, so the refusal
 * belongs at dispatch.
 */

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'madar-722-watch-cli-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"fx","type":"module"}\n')
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true },
  }))
  writeFileSync(join(dir, 'src/a.ts'), 'export const alpha = 1\n')
  return dir
}

function io() {
  const logs: string[] = []
  const errors: string[] = []
  return { logs, errors, io: {
    log(m?: string) { logs.push(String(m ?? '')) },
    error(m?: string) { errors.push(String(m ?? '')) },
  } }
}

/** Counts every side effect an unsupported command must not have. */
function countingDependencies() {
  const calls = { generate: 0, watch: 0 }
  return {
    calls,
    deps: {
      generateGraph: (..._a: unknown[]) => { calls.generate += 1; throw new Error('generation must not be reached') },
      watchGraph: async (..._a: unknown[]) => { calls.watch += 1 },
    } as never,
  }
}

function treeOf(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) { walk(join(dir, entry.name), rel); continue }
      out.push(`${rel}:${readFileSync(join(dir, entry.name)).length}`)
    }
  }
  walk(root, '')
  return out.sort()
}

const WATCH_INVOCATIONS: string[][] = [
  ['generate', '.', '--watch'],
  ['generate', '--watch', '.'],
  ['generate', '.', '--watch', '--no-html'],
  ['generate', '.', '--legacy', '--watch', '--respect-gitignore'],
  ['generate', '.', '--watch', '--debounce', '1'],
  ['watch', '.'],
  ['watch', '.', '--no-html'],
]

describe('FULL-GENERATE-ONLY watch refuses before generating', () => {
  test.each(WATCH_INVOCATIONS)('refuses %s before the generation owner is called', async (...argv: string[]) => {
    const dir = fixture()
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      const { io: sink, errors } = io()
      const { calls, deps } = countingDependencies()

      const exitCode = await executeCli(argv, sink, deps)

      expect(calls.generate, 'WATCH_REFUSED_AFTER_GENERATION_STARTED').toBe(0)
      expect(calls.watch, 'WATCH_STARTED_DESPITE_REFUSAL').toBe(0)
      expect(exitCode, 'REFUSAL_DID_NOT_FAIL').not.toBe(0)
      expect(errors.join('\n')).toMatch(/watch is not supported/i)
    } finally {
      process.chdir(cwd)
    }
  })

  test('a prior artifact survives a refused watch byte-identically', async () => {
    const dir = fixture()
    const prior = generateGraph(dir, { extractionMode: 'legacy', noHtml: true })
    const priorBytes = readFileSync(prior.graphPath)
    const outputDir = resolveMadarOutputDirectory(dir)
    const treeBefore = treeOf(outputDir)

    const cwd = process.cwd()
    process.chdir(dir)
    try {
      const { io: sink } = io()
      const { calls, deps } = countingDependencies()
      await executeCli(['generate', '.', '--watch'], sink, deps)
      expect(calls.generate, 'WATCH_REFUSED_AFTER_GENERATION_STARTED').toBe(0)
    } finally {
      process.chdir(cwd)
    }

    expect(readFileSync(prior.graphPath).equals(priorBytes), 'PRIOR_ARTIFACT_MODIFIED_BY_REFUSED_WATCH').toBe(true)
    expect(treeOf(outputDir), 'REFUSED_WATCH_PUBLISHED_OR_LEFT_RESIDUE').toStrictEqual(treeBefore)
  })

  test('the real generation owner is never entered on a refused watch', async () => {
    const dir = fixture()
    vi.resetModules()
    const counts = { detect: 0 }
    const det = await vi.importActual<typeof import('../../src/pipeline/detect.js')>('../../src/pipeline/detect.js')
    vi.doMock('../../src/pipeline/detect.js', () => ({
      ...det,
      detect: (...a: Parameters<typeof det.detect>) => { counts.detect += 1; return det.detect(...a) },
    }))
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      const { executeCli: freshCli } = await import('../../src/cli/main.js')
      const { io: sink } = io()
      // Real dependencies: nothing stubbed, so a leaked generation would scan.
      await freshCli(['generate', '.', '--watch'], sink)
      expect(counts.detect, 'REPOSITORY_DISCOVERY_RAN_ON_REFUSED_WATCH').toBe(0)
    } finally {
      process.chdir(cwd)
      vi.doUnmock('../../src/pipeline/detect.js')
      vi.resetModules()
    }
  })
})
