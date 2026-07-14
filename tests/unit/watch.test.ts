import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, test, vi } from 'vitest'

import { WATCHED_EXTENSIONS, hasNonCode, notifyOnly, rebuildCode, startGraphAutoRefresh, watch } from '../../src/infrastructure/watch.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
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

  test('recovers a stale refresh lease left by a dead process', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export const refreshed = true\n', 'utf8')
      const outputDir = join(tempDir, 'out')
      mkdirSync(outputDir, { recursive: true })
      const lockPath = join(outputDir, '.madar-refresh.lock')
      writeFileSync(lockPath, '999999999 stale-lease 1970-01-01T00:00:00.000Z\n', 'utf8')
      const staleAt = new Date(Date.now() - (2 * 60 * 60 * 1000))
      utimesSync(lockPath, staleAt, staleAt)

      expect(rebuildCode(tempDir, { noHtml: true })).toBe(true)
      expect(existsSync(lockPath)).toBe(false)
    })
  })
})

describe('watch', () => {
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

  test('triggers rebuild when a local media sidecar changes', async () => {
    await withTempDirAsync(async (tempDir) => {
      const controller = new AbortController()
      const rebuild = vi.fn(() => {
        controller.abort()
        return true
      })
      const notify = vi.fn(() => {
        controller.abort()
      })
      const audioPath = join(tempDir, 'episode.mp3')
      const sidecarPath = binaryIngestSidecarPath(audioPath)
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

      const watcher = watch(tempDir, 0.02, {
        signal: controller.signal,
        pollIntervalMs: 10,
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
            captured_at: '2026-04-14T03:05:00Z',
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
