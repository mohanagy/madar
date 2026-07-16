import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, test, vi } from 'vitest'

import { WATCHED_EXTENSIONS, hasNonCode, notifyOnly, rebuildCode, startGraphAutoRefresh, watch, type WatchReconciliationMetrics } from '../../src/infrastructure/watch.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { parseGenerationPolicy } from '../../src/contracts/generation-policy.js'
import { readWatcherStateForGraph } from '../../src/infrastructure/watcher-state.js'
import { tryAcquireRefreshLease } from '../../src/infrastructure/refresh-lease.js'
import { resolveMadarWorkspace } from '../../src/shared/workspace.js'
import { binaryIngestSidecarPath } from '../../src/shared/binary-ingest-sidecar.js'

function withTempDir(callback: (tempDir: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-watch-'))
  try {
    callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('notifyOnly', () => {
  test('creates the needs_update flag', () => {
    withTempDir((tempDir) => {
      notifyOnly(tempDir)
      const flag = join(tempDir, 'out', 'needs_update')
      expect(existsSync(flag)).toBe(true)
      expect(readFileSync(flag, 'utf8')).toBe('1')
    })
  })
})

describe('WATCHED_EXTENSIONS', () => {
  test('includes supported candidates and known unsupported source languages', () => {
    expect(WATCHED_EXTENSIONS.has('.py')).toBe(true)
    expect(WATCHED_EXTENSIONS.has('.ts')).toBe(true)
    expect(WATCHED_EXTENSIONS.has('.md')).toBe(true)
    expect(WATCHED_EXTENSIONS.has('.pdf')).toBe(true)
    expect(WATCHED_EXTENSIONS.has('.png')).toBe(true)
    expect(WATCHED_EXTENSIONS.has('.jpg')).toBe(true)
    expect(WATCHED_EXTENSIONS.has('.mp3')).toBe(true)
    expect(WATCHED_EXTENSIONS.has('.mp4')).toBe(true)
    expect(WATCHED_EXTENSIONS.has('.docx')).toBe(true)
    expect(WATCHED_EXTENSIONS.has('.xlsx')).toBe(true)
    expect(WATCHED_EXTENSIONS.has('.vue')).toBe(true)
    expect(WATCHED_EXTENSIONS.has('.svelte')).toBe(true)
    expect(WATCHED_EXTENSIONS.has('.sql')).toBe(true)
  })

  test('excludes noise extensions', () => {
    expect(WATCHED_EXTENSIONS.has('.json')).toBe(false)
    expect(WATCHED_EXTENSIONS.has('.pyc')).toBe(false)
    expect(WATCHED_EXTENSIONS.has('.log')).toBe(false)
  })
})

describe('hasNonCode', () => {
  test('detects mixed batches correctly', () => {
    expect(hasNonCode(['src/main.ts', 'README.md'])).toBe(true)
    expect(hasNonCode(['src/main.ts', 'src/util.py'])).toBe(false)
  })
})

describe('rebuildCode', () => {
  test('rebuilds graph artifacts for code-only changes and clears the update flag', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.py'), 'def hello():\n    return 1\n', 'utf8')
      mkdirSync(join(tempDir, 'out'), { recursive: true })
      writeFileSync(join(tempDir, 'out', 'needs_update'), '1', 'utf8')

      expect(rebuildCode(tempDir)).toBe(true)
      expect(existsSync(join(tempDir, 'out', 'graph.json'))).toBe(true)
      expect(existsSync(join(tempDir, 'out', 'GRAPH_REPORT.md'))).toBe(true)
      expect(existsSync(join(tempDir, 'out', 'needs_update'))).toBe(false)
      expect(readFileSync(join(tempDir, 'out', 'GRAPH_REPORT.md'), 'utf8')).toContain('## God Nodes')
    })
  })

  test('uses incremental generation when a manifest already exists', async () => {
    await withTempDirAsync(async (tempDir) => {
      writeFileSync(join(tempDir, 'main.py'), 'def hello():\n    return 1\n', 'utf8')
      generateGraph(tempDir)

      vi.resetModules()
      const actualGenerateModule = await vi.importActual<typeof import('../../src/infrastructure/generate.js')>('../../src/infrastructure/generate.js')
      const generateGraphSpy = vi.fn(actualGenerateModule.generateGraph)
      vi.doMock('../../src/infrastructure/generate.js', () => ({
        ...actualGenerateModule,
        generateGraph: generateGraphSpy,
      }))

      try {
        const watchModule = await import('../../src/infrastructure/watch.js')

        expect(watchModule.rebuildCode(tempDir)).toBe(true)
        expect(generateGraphSpy).toHaveBeenCalledTimes(1)
        expect(generateGraphSpy.mock.calls[0]?.[1]).toMatchObject({ update: true })
      } finally {
        vi.doUnmock('../../src/infrastructure/generate.js')
        vi.resetModules()
      }
    })
  })

  test('rebuilds graph artifacts when only supported document files are present', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'README.md'), '# docs only\nSee [Guide](guide.md)\n', 'utf8')
      writeFileSync(join(tempDir, 'guide.md'), '# Guide\n', 'utf8')

      expect(rebuildCode(tempDir)).toBe(true)
      expect(existsSync(join(tempDir, 'out', 'graph.json'))).toBe(true)
    })
  })

  test('keeps the existing SPI build profile during an automatic refresh', () => {
    withTempDir((tempDir) => {
      const sourcePath = join(tempDir, 'main.ts')
      writeFileSync(sourcePath, 'export const original = true\n', 'utf8')
      generateGraph(tempDir, { useSpi: true, noHtml: true })

      writeFileSync(sourcePath, 'export const refreshed = true\n', 'utf8')
      expect(rebuildCode(tempDir, { noHtml: true })).toBe(true)

      const graph = JSON.parse(readFileSync(join(tempDir, 'out', 'graph.json'), 'utf8')) as { spi_mode?: unknown }
      expect(graph.spi_mode).toBe(true)
    })
  })

  test('reuses every stored corpus-affecting generation option during refresh', () => {
    withTempDir((tempDir) => {
      execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' })
      const sourcePath = join(tempDir, 'main.ts')
      writeFileSync(sourcePath, 'export const original = true\n', 'utf8')
      writeFileSync(join(tempDir, 'README.md'), '# excluded documents\n', 'utf8')
      const initial = generateGraph(tempDir, {
        directed: false,
        followSymlinks: true,
        respectGitignore: true,
        includeDocs: false,
        noHtml: true,
        indexingStrict: { maxFailed: 0, maxUnsupported: 0 },
      })
      const before = parseGenerationPolicy(
        (JSON.parse(readFileSync(initial.graphPath, 'utf8')) as { generation_policy?: unknown }).generation_policy,
      )

      writeFileSync(sourcePath, 'export const refreshed = true\n', 'utf8')
      expect(rebuildCode(tempDir, { noHtml: true })).toBe(true)

      const after = parseGenerationPolicy(
        (JSON.parse(readFileSync(initial.graphPath, 'utf8')) as { generation_policy?: unknown }).generation_policy,
      )
      expect(after).toEqual(before)
      expect(after?.settings).toMatchObject({
        directed: false,
        follow_symlinks: true,
        respect_gitignore: true,
        include_documents: false,
        indexing_strict: { max_failed: 0, max_unsupported: 0 },
      })
    })
  })

  test('recovers a young refresh lease left by a dead process', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export const refreshed = true\n', 'utf8')
      const outputDir = join(tempDir, 'out')
      mkdirSync(outputDir, { recursive: true })
      const lockPath = join(outputDir, '.madar-refresh.lock')
      writeFileSync(lockPath, `999999999 abandoned-lease ${new Date().toISOString()}\n`, 'utf8')

      expect(rebuildCode(tempDir, { noHtml: true })).toBe(true)
      expect(existsSync(lockPath)).toBe(false)
    })
  })
})

describe('watch', () => {
  test('keeps startup unsettled during live lease contention and recovers after release', async () => {
    await withTempDirAsync(async (tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export const value = 1\n', 'utf8')
      const generated = generateGraph(tempDir, { noHtml: true })
      const releaseOwner = tryAcquireRefreshLease(generated.outputDir)
      expect(releaseOwner).toBeTypeOf('function')

      const refresh = startGraphAutoRefresh(tempDir, 0.02, {
        pollIntervalMs: 20,
        noHtml: true,
        logger: { log() {}, error() {} },
      })
      try {
        expect(refresh.initialRebuilt).toBe(false)
        expect(refresh.startupComplete?.()).toBe(false)
        await waitFor(() => readWatcherStateForGraph(generated.graphPath)?.status === 'reconciling')

        releaseOwner?.()
        await refresh.startupSettled
        expect(refresh.startupComplete?.()).toBe(true)
        expect(refresh.initialRebuilt).toBe(true)
        expect(readWatcherStateForGraph(generated.graphPath)?.status).toBe('idle')
      } finally {
        releaseOwner?.()
        refresh.stop()
        await refresh.completed
      }
    })
  })

  test('keeps auto-refresh graph and watcher state outside a linked worktree', async () => {
    await withTempDirAsync(async (tempDir) => {
      const primary = join(tempDir, 'primary')
      const linked = join(tempDir, 'linked')
      execFileSync('git', ['init', primary], { stdio: 'pipe' })
      execFileSync('git', ['config', 'user.email', 'madar-tests@example.com'], { cwd: primary, stdio: 'pipe' })
      execFileSync('git', ['config', 'user.name', 'Madar Tests'], { cwd: primary, stdio: 'pipe' })
      writeFileSync(join(primary, 'main.ts'), 'export const primaryValue = 1\n', 'utf8')
      execFileSync('git', ['add', '.'], { cwd: primary, stdio: 'pipe' })
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: primary, stdio: 'pipe' })
      execFileSync('git', ['worktree', 'add', '-b', 'feature/auto-refresh-test', linked], { cwd: primary, stdio: 'pipe' })

      const workspace = resolveMadarWorkspace(linked)
      const refresh = startGraphAutoRefresh(linked, 0.02, {
        pollIntervalMs: 20,
        noHtml: true,
        logger: { log() {}, error() {} },
      })
      try {
        expect(refresh.initialRebuilt).toBe(true)
        expect(workspace.isLinkedWorktree).toBe(true)
        expect(existsSync(workspace.graphPath)).toBe(true)
        expect(existsSync(join(workspace.outputDir, 'watcher-state.json'))).toBe(true)
        expect(existsSync(join(linked, 'out'))).toBe(false)
        expect(readWatcherStateForGraph(workspace.graphPath)?.status).toBe('idle')

        writeFileSync(join(linked, 'added.ts'), 'export const linkedValue = 2\n', 'utf8')
        await waitFor(() => {
          const graph = JSON.parse(readFileSync(workspace.graphPath, 'utf8')) as { nodes?: Array<{ source_file?: string }> }
          return graph.nodes?.some((node) => node.source_file?.endsWith('added.ts')) === true
        })
      } finally {
        refresh.stop()
        await refresh.completed
      }
    })
  }, 15_000)

  test('covers more than 10,000 files and detects a change beyond the former cap', async () => {
    await withTempDirAsync(async (tempDir) => {
      const totalFiles = 10_050
      for (let index = 0; index < totalFiles; index += 1) {
        writeFileSync(join(tempDir, `source-${String(index).padStart(5, '0')}.ts`), '', 'utf8')
      }

      await watch(tempDir, 0, {
        reconciliationTimeoutMs: 1,
        logger: { log() {}, error() {} },
      })
      expect(readWatcherStateForGraph(join(tempDir, 'out', 'graph.json'))).toMatchObject({
        status: 'failed',
        coverage: 'failed',
      })

      const controller = new AbortController()
      const reconciliations: WatchReconciliationMetrics[] = []
      const rebuild = vi.fn(() => {
        controller.abort()
        return true
      })
      const watcher = watch(tempDir, 0, {
        signal: controller.signal,
        pollIntervalMs: 20,
        maxPollIntervalMs: 100,
        rebuildCode: rebuild,
        onReconciliation: (metrics) => reconciliations.push(metrics),
        logger: { log() {}, error() {} },
      })
      const timeout = setTimeout(() => controller.abort(), 15_000)

      writeFileSync(join(tempDir, 'source-10049.ts'), 'export const beyondFormerCap = true\n', 'utf8')
      await watcher
      clearTimeout(timeout)

      expect(reconciliations[0]?.fileCount).toBe(totalFiles)
      expect(reconciliations.some((metrics) => metrics.changedCount > 0 && metrics.fileCount === totalFiles)).toBe(true)
      expect(rebuild).toHaveBeenCalledTimes(1)
    })
  }, 90_000)

  test('backs off authoritative reconciliation while idle and reports resource measurements', async () => {
    await withTempDirAsync(async (tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export const idle = true\n', 'utf8')
      const controller = new AbortController()
      const reconciliations: WatchReconciliationMetrics[] = []
      const watcher = watch(tempDir, 0.02, {
        signal: controller.signal,
        pollIntervalMs: 20,
        maxPollIntervalMs: 80,
        onReconciliation: (metrics) => reconciliations.push(metrics),
        logger: { log() {}, error() {} },
      })

      await delay(190)
      controller.abort()
      await watcher

      expect(reconciliations[0]).toMatchObject({ trigger: 'initial', fileCount: 1, nextIntervalMs: 20 })
      expect(reconciliations.some((metrics) => metrics.nextIntervalMs === 40)).toBe(true)
      expect(reconciliations.some((metrics) => metrics.nextIntervalMs === 80)).toBe(true)
      expect(reconciliations.length).toBeLessThanOrEqual(5)
      expect(reconciliations.every((metrics) => metrics.durationMs >= 0 && metrics.directoryCount >= 1)).toBe(true)
    })
  })

  test('persists pending and stopped watcher health without answering silently stale', async () => {
    await withTempDirAsync(async (tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export const initial = true\n', 'utf8')
      generateGraph(tempDir, { noHtml: true })
      const graphPath = join(tempDir, 'out', 'graph.json')
      const controller = new AbortController()
      const watcher = watch(tempDir, 1, {
        signal: controller.signal,
        pollIntervalMs: 20,
        logger: { log() {}, error() {} },
      })

      writeFileSync(join(tempDir, 'main.ts'), 'export const changed = true\n', 'utf8')
      await waitFor(() => readWatcherStateForGraph(graphPath)?.status === 'pending')
      const pending = readWatcherStateForGraph(graphPath)
      expect(pending).toMatchObject({ coverage: 'complete', policy_match: true })
      expect(pending?.pending_since).toMatch(/^\d{4}-/)

      controller.abort()
      await watcher
      expect(readWatcherStateForGraph(graphPath)?.status).toBe('stopped')
    })
  })

  test('detects and repairs graph/source-manifest policy disagreement', async () => {
    await withTempDirAsync(async (tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export const value = 1\n', 'utf8')
      const generated = generateGraph(tempDir, { noHtml: true })
      const manifestPath = join(generated.outputDir, 'manifest.json')
      const graphPolicy = parseGenerationPolicy(
        (JSON.parse(readFileSync(generated.graphPath, 'utf8')) as { generation_policy?: unknown }).generation_policy,
      )
      const controller = new AbortController()
      const watcher = watch(tempDir, 0, {
        signal: controller.signal,
        pollIntervalMs: 20,
        maxPollIntervalMs: 40,
        noHtml: true,
        logger: { log() {}, error() {} },
      })

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { __madar_meta__?: { generation_policy?: unknown } }
      if (manifest.__madar_meta__) {
        delete manifest.__madar_meta__.generation_policy
      }
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

      await waitFor(() => {
        const repaired = JSON.parse(readFileSync(manifestPath, 'utf8')) as { __madar_meta__?: { generation_policy?: unknown } }
        const repairedPolicy = parseGenerationPolicy(repaired.__madar_meta__?.generation_policy)
        return repairedPolicy?.fingerprint === graphPolicy?.fingerprint
          && readWatcherStateForGraph(generated.graphPath)?.status === 'idle'
      })
      controller.abort()
      await watcher

      expect(graphPolicy).not.toBeNull()
    })
  })

  test('reconciles an edit made during rebuild before returning to idle', async () => {
    await withTempDirAsync(async (tempDir) => {
      const sourcePath = join(tempDir, 'main.ts')
      writeFileSync(sourcePath, 'export const value = 1\n', 'utf8')
      const controller = new AbortController()
      let rebuildCount = 0
      const rebuild = vi.fn(() => {
        rebuildCount += 1
        if (rebuildCount === 1) {
          writeFileSync(sourcePath, 'export const value = 3\n', 'utf8')
        } else {
          controller.abort()
        }
        return true
      })
      const watcher = watch(tempDir, 0, {
        signal: controller.signal,
        pollIntervalMs: 20,
        rebuildCode: rebuild,
        logger: { log() {}, error() {} },
      })
      const timeout = setTimeout(() => controller.abort(), 5_000)

      writeFileSync(sourcePath, 'export const value = 2\n', 'utf8')
      await watcher
      clearTimeout(timeout)

      expect(rebuild).toHaveBeenCalledTimes(2)
    })
  })

  test('reconciles at MCP startup and refreshes a later agent edit', async () => {
    await withTempDirAsync(async (tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export const initialValue = 1\n', 'utf8')
      const refresh = startGraphAutoRefresh(tempDir, 0.02, {
        pollIntervalMs: 10,
        noHtml: true,
        logger: { log() {}, error() {} },
      })

      try {
        const graphPath = join(tempDir, 'out', 'graph.json')
        expect(refresh.initialRebuilt).toBe(true)
        expect(existsSync(graphPath)).toBe(true)

        writeFileSync(join(tempDir, 'added.ts'), 'export function addedDuringSession() { return 2 }\n', 'utf8')
        await waitFor(() => {
          const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as { nodes?: Array<{ source_file?: string }> }
          return graph.nodes?.some((node) => node.source_file?.endsWith('added.ts')) === true
        })
      } finally {
        refresh.stop()
        await refresh.completed
      }
    })
  }, 10_000)

  test('refreshes completeness when an unsupported source candidate is added', async () => {
    await withTempDirAsync(async (tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export const initialValue = 1\n', 'utf8')
      const refresh = startGraphAutoRefresh(tempDir, 0.02, {
        pollIntervalMs: 10,
        noHtml: true,
        logger: { log() {}, error() {} },
      })

      try {
        const manifestPath = join(tempDir, 'out', 'indexing-manifest.json')
        expect(refresh.initialRebuilt).toBe(true)
        writeFileSync(join(tempDir, 'legacy.vue'), '<template />\n', 'utf8')

        await waitFor(() => {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
            outcomes?: Array<{ path?: string; status?: string; reason?: string }>
          }
          return manifest.outcomes?.some((outcome) =>
            outcome.path === 'legacy.vue'
            && outcome.status === 'unsupported'
            && outcome.reason === 'unsupported_file_type') === true
        })
      } finally {
        refresh.stop()
        await refresh.completed
      }
    })
  }, 10_000)

  test('triggers a Git-visible rebuild when .gitignore changes', async () => {
    await withTempDirAsync(async (tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export const visible = true\n', 'utf8')
      execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' })

      const controller = new AbortController()
      const rebuild = vi.fn((_watchPath: string, _options?: unknown) => {
        controller.abort()
        return true
      })
      const watcher = watch(tempDir, 0.02, {
        signal: controller.signal,
        pollIntervalMs: 10,
        respectGitignore: true,
        rebuildCode: rebuild,
        logger: { log() {}, error() {} },
      })
      const timeout = setTimeout(() => controller.abort(), 5_000)

      await delay(100)
      writeFileSync(join(tempDir, '.gitignore'), 'main.ts\n', 'utf8')

      await watcher
      clearTimeout(timeout)

      expect(rebuild).toHaveBeenCalledTimes(1)
      expect(rebuild.mock.calls[0]?.[1]).toMatchObject({ respectGitignore: true })
    })
  }, 10_000)

  test('ignores changes to Git-ignored source files when respectGitignore is enabled', async () => {
    await withTempDirAsync(async (tempDir) => {
      writeFileSync(join(tempDir, '.gitignore'), 'ignored.ts\n', 'utf8')
      writeFileSync(join(tempDir, 'main.ts'), 'export const visible = true\n', 'utf8')
      writeFileSync(join(tempDir, 'ignored.ts'), 'export const ignored = true\n', 'utf8')
      execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' })

      const controller = new AbortController()
      const rebuild = vi.fn(() => true)
      const watcher = watch(tempDir, 0.02, {
        signal: controller.signal,
        pollIntervalMs: 10,
        respectGitignore: true,
        rebuildCode: rebuild,
        logger: { log() {}, error() {} },
      })

      await delay(100)
      writeFileSync(join(tempDir, 'ignored.ts'), 'export const ignored = false\n', 'utf8')
      await delay(250)
      controller.abort()
      await watcher

      expect(rebuild).not.toHaveBeenCalled()
    })
  }, 10_000)

  test.runIf(process.platform !== 'win32')('triggers a rebuild when Git excludes a followed symlink alias', async () => {
    await withTempDirAsync(async (tempDir) => {
      writeFileSync(join(tempDir, 'target.ts'), 'export const target = true\n', 'utf8')
      symlinkSync(join(tempDir, 'target.ts'), join(tempDir, 'alias.ts'))
      execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' })

      const controller = new AbortController()
      const rebuild = vi.fn((_watchPath: string, _options?: unknown) => {
        controller.abort()
        return true
      })
      const watcher = watch(tempDir, 0.02, {
        signal: controller.signal,
        pollIntervalMs: 10,
        followSymlinks: true,
        respectGitignore: true,
        rebuildCode: rebuild,
        logger: { log() {}, error() {} },
      })
      const timeout = setTimeout(() => controller.abort(), 5_000)

      await delay(100)
      writeFileSync(join(tempDir, '.git', 'info', 'exclude'), 'alias.ts\n', 'utf8')

      await watcher
      clearTimeout(timeout)

      expect(rebuild).toHaveBeenCalledTimes(1)
      expect(rebuild.mock.calls[0]?.[1]).toMatchObject({ followSymlinks: true, respectGitignore: true })
    })
  }, 10_000)

  test('caches Git visibility between watch polls', async () => {
    await withTempDirAsync(async (tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export const visible = true\n', 'utf8')
      const collectGitVisibleFiles = vi.fn(() => [join(tempDir, 'main.ts')])

      vi.resetModules()
      const actualGitModule = await vi.importActual<typeof import('../../src/shared/git.js')>('../../src/shared/git.js')
      vi.doMock('../../src/shared/git.js', () => ({ ...actualGitModule, collectGitVisibleFiles }))

      try {
        const { watch: watchWithMockedGit } = await import('../../src/infrastructure/watch.js')
        const controller = new AbortController()
        const watcher = watchWithMockedGit(tempDir, 0.02, {
          signal: controller.signal,
          pollIntervalMs: 10,
          respectGitignore: true,
          logger: { log() {}, error() {} },
        })

        await delay(100)
        controller.abort()
        await watcher

        expect(collectGitVisibleFiles).toHaveBeenCalledTimes(1)
      } finally {
        vi.doUnmock('../../src/shared/git.js')
        vi.resetModules()
      }
    })
  })

  test('stops cleanly when the initial Git visibility snapshot fails', async () => {
    await withTempDirAsync(async (tempDir) => {
      const collectGitVisibleFiles = vi.fn(() => {
        throw new Error('Git inspection failed')
      })

      vi.resetModules()
      const actualGitModule = await vi.importActual<typeof import('../../src/shared/git.js')>('../../src/shared/git.js')
      vi.doMock('../../src/shared/git.js', () => ({ ...actualGitModule, collectGitVisibleFiles }))

      try {
        const { watch: watchWithMockedGit } = await import('../../src/infrastructure/watch.js')
        const logger = { log: vi.fn(), error: vi.fn() }

        await expect(
          watchWithMockedGit(tempDir, 0.02, {
            respectGitignore: true,
            logger,
          }),
        ).resolves.toBeUndefined()

        expect(collectGitVisibleFiles).toHaveBeenCalledTimes(1)
        expect(logger.error).toHaveBeenCalledWith('[madar watch] Watch stopped: Git inspection failed')
      } finally {
        vi.doUnmock('../../src/shared/git.js')
        vi.resetModules()
      }
    })
  })

  test('stops cleanly when a later Git visibility snapshot fails', async () => {
    await withTempDirAsync(async (tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export const visible = true\n', 'utf8')
      let calls = 0
      const collectGitVisibleFiles = vi.fn(() => {
        calls += 1
        if (calls > 1) {
          throw new Error('Git inspection failed after startup')
        }
        return [join(tempDir, 'main.ts')]
      })

      vi.resetModules()
      const actualGitModule = await vi.importActual<typeof import('../../src/shared/git.js')>('../../src/shared/git.js')
      vi.doMock('../../src/shared/git.js', () => ({ ...actualGitModule, collectGitVisibleFiles }))

      try {
        const { watch: watchWithMockedGit } = await import('../../src/infrastructure/watch.js')
        const controller = new AbortController()
        const logger = { log: vi.fn(), error: vi.fn() }
        const watcher = watchWithMockedGit(tempDir, 0.02, {
          signal: controller.signal,
          pollIntervalMs: 10,
          respectGitignore: true,
          logger,
        })
        const timeout = setTimeout(() => controller.abort(), 2_000)

        await watcher
        clearTimeout(timeout)

        expect(collectGitVisibleFiles).toHaveBeenCalledTimes(2)
        expect(logger.error).toHaveBeenCalledWith('[madar watch] Watch stopped: Git inspection failed after startup')
      } finally {
        vi.doUnmock('../../src/shared/git.js')
        vi.resetModules()
      }
    })
  }, 5_000)

  test('triggers rebuild for code-only changes', async () => {
    await withTempDirAsync(async (tempDir) => {
      const controller = new AbortController()
      const rebuild = vi.fn(() => {
        controller.abort()
        return true
      })
      const notify = vi.fn()

      writeFileSync(join(tempDir, 'main.py'), 'def hello():\n    return 1\n', 'utf8')
      const watcher = watch(tempDir, 0.02, {
        signal: controller.signal,
        pollIntervalMs: 10,
        rebuildCode: rebuild,
        notifyOnly: notify,
        logger: { log() {}, error() {} },
      })

      await delay(30)
      writeFileSync(join(tempDir, 'main.py'), 'def hello():\n    return 2\n', 'utf8')

      await watcher

      expect(rebuild).toHaveBeenCalledTimes(1)
      expect(notify).not.toHaveBeenCalled()
    })
  })

  test('triggers rebuild for supported non-code changes', async () => {
    await withTempDirAsync(async (tempDir) => {
      const controller = new AbortController()
      const rebuild = vi.fn(() => {
        controller.abort()
        return true
      })
      const notify = vi.fn(() => {
        controller.abort()
      })

      writeFileSync(join(tempDir, 'main.py'), 'def hello():\n    return 1\n', 'utf8')
      const watcher = watch(tempDir, 0.02, {
        signal: controller.signal,
        pollIntervalMs: 10,
        rebuildCode: rebuild,
        notifyOnly: notify,
        logger: { log() {}, error() {} },
      })

      await delay(30)
      writeFileSync(join(tempDir, 'README.md'), '# docs\n', 'utf8')

      await watcher

      expect(rebuild).toHaveBeenCalledTimes(1)
      expect(notify).not.toHaveBeenCalled()
    })
  })

  test('triggers rebuild when a local media sidecar changes without an mtime change', async () => {
    await withTempDirAsync(async (tempDir) => {
      const controller = new AbortController()
      const rebuild = vi.fn(() => {
        controller.abort()
        return true
      })
      const notify = vi.fn(() => {
        controller.abort()
      })
      const reconciliations: WatchReconciliationMetrics[] = []
      const audioPath = join(tempDir, 'episode.mp3')
      const sidecarPath = binaryIngestSidecarPath(audioPath)
      const sidecarTimestamp = new Date('2026-04-14T03:00:00Z')
      writeFileSync(audioPath, Buffer.from('ID3'))
      writeFileSync(
        sidecarPath,
        JSON.stringify(
          {
            source_url: 'https://example.com/podcast/episodes/1',
            captured_at: '2026-04-14T03:00:00Z',
            contributor: 'madar',
          },
          null,
          2,
        ),
        'utf8',
      )
      utimesSync(sidecarPath, sidecarTimestamp, sidecarTimestamp)

      const watcher = watch(tempDir, 0.02, {
        signal: controller.signal,
        pollIntervalMs: 10,
        rebuildCode: rebuild,
        notifyOnly: notify,
        onReconciliation: (metrics) => reconciliations.push(metrics),
        logger: { log() {}, error() {} },
      })

      await waitFor(() => reconciliations.some((metrics) => metrics.trigger === 'initial'))
      const timeout = setTimeout(() => controller.abort(), 5_000)
      writeFileSync(
        sidecarPath,
        JSON.stringify(
          {
            source_url: 'https://example.com/podcast/episodes/2',
            captured_at: '2026-04-14T03:05:00Z',
            contributor: 'madar',
          },
          null,
          2,
        ),
        'utf8',
      )
      utimesSync(sidecarPath, sidecarTimestamp, sidecarTimestamp)

      await watcher
      clearTimeout(timeout)

      expect(rebuild).toHaveBeenCalledTimes(1)
      expect(notify).not.toHaveBeenCalled()
    })
  }, 15_000)

  test.runIf(process.platform !== 'win32')('triggers rebuild when a followed symlink media sidecar changes', async () => {
    await withTempDirAsync(async (tempDir) => {
      const controller = new AbortController()
      const rebuild = vi.fn(() => {
        controller.abort()
        return true
      })
      const notify = vi.fn(() => {
        controller.abort()
      })
      const mediaDir = join(tempDir, 'media')
      const targetPath = join(mediaDir, 'episode.mp3')
      const linkPath = join(tempDir, 'episode-link.mp3')
      const sidecarPath = binaryIngestSidecarPath(linkPath)
      mkdirSync(mediaDir, { recursive: true })
      writeFileSync(targetPath, Buffer.from('ID3'))
      symlinkSync(targetPath, linkPath)
      writeFileSync(
        sidecarPath,
        JSON.stringify(
          {
            source_url: 'https://example.com/podcast/episodes/1',
            captured_at: '2026-04-14T03:10:00Z',
            contributor: 'madar',
          },
          null,
          2,
        ),
        'utf8',
      )

      const watcher = watch(tempDir, 0.02, {
        signal: controller.signal,
        pollIntervalMs: 10,
        followSymlinks: true,
        rebuildCode: rebuild,
        notifyOnly: notify,
        logger: { log() {}, error() {} },
      })
      const timeout = setTimeout(() => controller.abort(), 200)

      await delay(30)
      writeFileSync(
        sidecarPath,
        JSON.stringify(
          {
            source_url: 'https://example.com/podcast/episodes/2',
            captured_at: '2026-04-14T03:15:00Z',
            contributor: 'madar',
          },
          null,
          2,
        ),
        'utf8',
      )

      await watcher
      clearTimeout(timeout)

      expect(rebuild).toHaveBeenCalledTimes(1)
      expect(notify).not.toHaveBeenCalled()
    })
  })

  test('triggers rebuild for mixed code and non-code changes in one batch', async () => {
    await withTempDirAsync(async (tempDir) => {
      const controller = new AbortController()
      const rebuild = vi.fn(() => {
        controller.abort()
        return true
      })
      const notify = vi.fn(() => {
        controller.abort()
      })

      writeFileSync(join(tempDir, 'main.py'), 'def hello():\n    return 1\n', 'utf8')
      const watcher = watch(tempDir, 0.02, {
        signal: controller.signal,
        pollIntervalMs: 10,
        rebuildCode: rebuild,
        notifyOnly: notify,
        logger: { log() {}, error() {} },
      })

      await delay(30)
      writeFileSync(join(tempDir, 'main.py'), 'def hello():\n    return 2\n', 'utf8')
      writeFileSync(join(tempDir, 'README.md'), '# docs\n', 'utf8')

      await watcher

      expect(rebuild).toHaveBeenCalledTimes(1)
      expect(notify).not.toHaveBeenCalled()
    })
  })

  test.runIf(process.platform !== 'win32')('ignores symlink targets outside the watch root', async () => {
    await withTempDirAsync(async (tempDir) => {
      await withTempDirAsync(async (externalDir) => {
        const controller = new AbortController()
        const rebuild = vi.fn(() => true)
        const notify = vi.fn()

        writeFileSync(join(externalDir, 'main.py'), 'def hello():\n    return 1\n', 'utf8')
        symlinkSync(externalDir, join(tempDir, 'linked-outside'))

        const watcher = watch(tempDir, 0.02, {
          signal: controller.signal,
          pollIntervalMs: 10,
          followSymlinks: true,
          rebuildCode: rebuild,
          notifyOnly: notify,
          logger: { log() {}, error() {} },
        })

        await delay(30)
        writeFileSync(join(externalDir, 'main.py'), 'def hello():\n    return 2\n', 'utf8')
        await delay(80)
        controller.abort()

        await watcher

        expect(rebuild).not.toHaveBeenCalled()
        expect(notify).not.toHaveBeenCalled()
      })
    })
  })

  test.runIf(process.platform !== 'win32')('handles symlink cycles safely when followSymlinks is enabled', async () => {
    await withTempDirAsync(async (tempDir) => {
      const controller = new AbortController()
      const rebuild = vi.fn(() => {
        controller.abort()
        return true
      })
      const notify = vi.fn()

      mkdirSync(join(tempDir, 'src'), { recursive: true })
      writeFileSync(join(tempDir, 'src', 'main.py'), 'def hello():\n    return 1\n', 'utf8')
      symlinkSync(join(tempDir, 'src'), join(tempDir, 'src', 'loop'))

      const watcher = watch(tempDir, 0.02, {
        signal: controller.signal,
        pollIntervalMs: 10,
        followSymlinks: true,
        rebuildCode: rebuild,
        notifyOnly: notify,
        logger: { log() {}, error() {} },
      })

      await delay(30)
      writeFileSync(join(tempDir, 'src', 'main.py'), 'def hello():\n    return 2\n', 'utf8')

      await watcher

      expect(rebuild).toHaveBeenCalledTimes(1)
      expect(notify).not.toHaveBeenCalled()
    })
  })
})

async function withTempDirAsync(callback: (tempDir: string) => Promise<void>): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-watch-'))
  try {
    await callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) {
      return
    }
    await delay(25)
  }
  throw new Error('Timed out waiting for graph refresh')
}
