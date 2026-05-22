import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, test, vi } from 'vitest'

import { WATCHED_EXTENSIONS, hasNonCode, notifyOnly, rebuildCode, watch } from '../../src/infrastructure/watch.js'
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
  test('includes code, docs, papers, images, local media, and office documents', () => {
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
})

describe('watch', () => {
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
