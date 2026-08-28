import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { resolveMadarOutputDirectory } from '../../src/shared/workspace.js'

/**
 * #722 FULL_GENERATE_ONLY_V1 — watch/auto-refresh side-effect controls.
 *
 * The refusal wrappers must refuse *before* anything observable happens. Six
 * defect classes are named, one per mechanism the historical implementation
 * actually used:
 *
 *   WATCH_POLICY_READ_BEFORE_REFUSAL      readStoredGenerationPolicy / readGraphGenerationPolicy
 *   WATCHER_STARTED_BEFORE_REFUSAL        node:fs `watch` (createFileSystemWatcher)
 *   WATCH_WORKER_STARTED_BEFORE_REFUSAL   node:worker_threads `Worker`
 *   WATCH_TIMER_CREATED_BEFORE_REFUSAL    setTimeout / setInterval (debounce)
 *   WATCH_PUBLICATION_BEFORE_REFUSAL      any write into the madar output directory
 *   WATCH_SIDECAR_ACTIVATED_BEFORE_REFUSAL sidecarAwareFileFingerprint
 *
 * Every counter carries a live-poison precondition. A mock installed at the
 * wrong specifier reports zero for the same reason a correct implementation
 * does, so an unproven counter is not a control.
 */

interface Counters {
  policyReads: number
  watcherStarts: number
  workerStarts: number
  timers: number
  sidecarActivations: number
}

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'madar-722-sfx-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"fx","type":"module"}\n')
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true },
  }))
  writeFileSync(join(dir, 'src/a.ts'), 'export const alpha = 1\n')
  return dir
}

/** Recursive listing so a write *anywhere* under the output directory is caught. */
function treeOf(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    let entries: Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) { walk(join(dir, entry.name), rel); continue }
      out.push(`${rel}:${readFileSync(join(dir, entry.name)).length}`)
    }
  }
  walk(root, '')
  return out.sort()
}

async function withInstrumentedModules<T>(
  run: (counters: Counters, mocked: {
    fs: typeof import('node:fs')
    workers: typeof import('node:worker_threads')
    policy: typeof import('../../src/infrastructure/generation-policy.js')
    sidecar: typeof import('../../src/shared/binary-ingest-sidecar.js')
  }) => Promise<T>,
): Promise<T> {
  const counters: Counters = {
    policyReads: 0, watcherStarts: 0, workerStarts: 0, timers: 0, sidecarActivations: 0,
  }

  vi.resetModules()

  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.doMock('node:fs', () => ({
    ...actualFs,
    default: actualFs,
    watch: (...args: Parameters<typeof actualFs.watch>) => {
      counters.watcherStarts += 1
      return actualFs.watch(...args)
    },
  }))

  const actualWorkers = await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads')
  class CountingWorker extends actualWorkers.Worker {
    constructor(...args: ConstructorParameters<typeof actualWorkers.Worker>) {
      counters.workerStarts += 1
      super(...args)
    }
  }
  vi.doMock('node:worker_threads', () => ({
    ...actualWorkers, default: actualWorkers, Worker: CountingWorker,
  }))

  const actualPolicy = await vi.importActual<
    typeof import('../../src/infrastructure/generation-policy.js')
  >('../../src/infrastructure/generation-policy.js')
  vi.doMock('../../src/infrastructure/generation-policy.js', () => ({
    ...actualPolicy,
    readStoredGenerationPolicy: (...args: Parameters<typeof actualPolicy.readStoredGenerationPolicy>) => {
      counters.policyReads += 1
      return actualPolicy.readStoredGenerationPolicy(...args)
    },
    readGraphGenerationPolicy: (...args: Parameters<typeof actualPolicy.readGraphGenerationPolicy>) => {
      counters.policyReads += 1
      return actualPolicy.readGraphGenerationPolicy(...args)
    },
  }))

  const actualSidecar = await vi.importActual<
    typeof import('../../src/shared/binary-ingest-sidecar.js')
  >('../../src/shared/binary-ingest-sidecar.js')
  vi.doMock('../../src/shared/binary-ingest-sidecar.js', () => ({
    ...actualSidecar,
    sidecarAwareFileFingerprint: (...args: Parameters<typeof actualSidecar.sidecarAwareFileFingerprint>) => {
      counters.sidecarActivations += 1
      return actualSidecar.sidecarAwareFileFingerprint(...args)
    },
  }))

  const realSetTimeout = globalThis.setTimeout
  const realSetInterval = globalThis.setInterval
  globalThis.setTimeout = ((...args: Parameters<typeof realSetTimeout>) => {
    counters.timers += 1
    return realSetTimeout(...args)
  }) as typeof realSetTimeout
  globalThis.setInterval = ((...args: Parameters<typeof realSetInterval>) => {
    counters.timers += 1
    return realSetInterval(...args)
  }) as typeof realSetInterval

  try {
    const mocked = {
      fs: await import('node:fs'),
      workers: await import('node:worker_threads'),
      policy: await import('../../src/infrastructure/generation-policy.js'),
      sidecar: await import('../../src/shared/binary-ingest-sidecar.js'),
    }
    return await run(counters, mocked)
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.setInterval = realSetInterval
    vi.doUnmock('node:fs')
    vi.doUnmock('node:worker_threads')
    vi.doUnmock('../../src/infrastructure/generation-policy.js')
    vi.doUnmock('../../src/shared/binary-ingest-sidecar.js')
    vi.resetModules()
  }
}

const expectUnsupportedMode = (error: unknown, mode: string): void => {
  const typed = error as { code?: string, mode?: string }
  expect(typed.code).toBe('UNSUPPORTED_GENERATION_MODE')
  expect(typed.mode).toBe(mode)
}

describe('FULL-GENERATE-ONLY watch side-effect controls', () => {
  afterEach(() => { vi.resetModules() })

  test('precondition: every counter is live (an unproven counter is not a control)', async () => {
    const dir = fixture()
    await withInstrumentedModules(async (counters, mocked) => {
      // WATCHER: a real watcher registration must be observed.
      const watcher = mocked.fs.watch(dir, () => {})
      watcher.close()
      expect(counters.watcherStarts, 'WATCHER counter is not wired to node:fs watch').toBe(1)

      // WORKER: a real worker construction must be observed.
      const worker = new mocked.workers.Worker('', { eval: true })
      await worker.terminate()
      expect(counters.workerStarts, 'WORKER counter is not wired to node:worker_threads').toBe(1)

      // TIMER: a real timer creation must be observed.
      clearTimeout(setTimeout(() => {}, 0))
      expect(counters.timers, 'TIMER counter is not wired to the global timers').toBeGreaterThan(0)

      // POLICY: a real read must be observed, even when it returns null.
      mocked.policy.readStoredGenerationPolicy(join(dir, 'graph.json'), join(dir, 'manifest.json'))
      expect(counters.policyReads, 'POLICY counter is not wired to generation-policy').toBe(1)

      // SIDECAR: a real fingerprint call must be observed.
      mocked.sidecar.sidecarAwareFileFingerprint(join(dir, 'src/a.ts'))
      expect(counters.sidecarActivations, 'SIDECAR counter is not wired to the sidecar module').toBe(1)
    })
  })

  test('precondition: the publication control sees a write into the output directory', () => {
    const dir = fixture()
    const outputDir = resolveMadarOutputDirectory(dir)
    mkdirSync(outputDir, { recursive: true })
    const before = treeOf(outputDir)
    writeFileSync(join(outputDir, 'poison.json'), '{"poison":true}')
    expect(treeOf(outputDir), 'PUBLICATION control cannot see a write it should catch')
      .not.toStrictEqual(before)
  })

  test('all four refusal entry points refuse before any of the six side effects', async () => {
    const dir = fixture()
    const outputDir = resolveMadarOutputDirectory(dir)
    mkdirSync(outputDir, { recursive: true })
    const treeBefore = treeOf(outputDir)

    await withInstrumentedModules(async (counters) => {
      const watchModule = await import('../../src/infrastructure/watch.js')
      const background = await import('../../src/infrastructure/background-auto-refresh.js')

      await watchModule.watch(dir, 0, {}).then(
        () => { throw new Error('expected a refusal') },
        (error: unknown) => expectUnsupportedMode(error, 'watch'),
      )
      try { watchModule.startGraphAutoRefresh(dir, 0, {}); throw new Error('expected a refusal') }
      catch (error) { expectUnsupportedMode(error, 'auto-refresh') }
      try { watchModule.rebuildCode(dir, {}); throw new Error('expected a refusal') }
      catch (error) { expectUnsupportedMode(error, 'auto-refresh') }
      try { background.startGraphAutoRefreshInBackground(dir, 0, {}); throw new Error('expected a refusal') }
      catch (error) { expectUnsupportedMode(error, 'auto-refresh') }

      expect(counters.policyReads, 'WATCH_POLICY_READ_BEFORE_REFUSAL').toBe(0)
      expect(counters.watcherStarts, 'WATCHER_STARTED_BEFORE_REFUSAL').toBe(0)
      expect(counters.workerStarts, 'WATCH_WORKER_STARTED_BEFORE_REFUSAL').toBe(0)
      expect(counters.timers, 'WATCH_TIMER_CREATED_BEFORE_REFUSAL').toBe(0)
      expect(counters.sidecarActivations, 'WATCH_SIDECAR_ACTIVATED_BEFORE_REFUSAL').toBe(0)
    })

    expect(treeOf(outputDir), 'WATCH_PUBLICATION_BEFORE_REFUSAL').toStrictEqual(treeBefore)
  })
})
