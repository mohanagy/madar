import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, test, vi } from 'vitest'

import { parseGenerationPolicy } from '../../src/contracts/generation-policy.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { readWatcherStateForGraph } from '../../src/infrastructure/watcher-state.js'
import {
  notifyOnly,
  rebuildCode,
  snapshotWatchedFiles,
  startGraphAutoRefresh,
  WATCHED_EXTENSIONS,
  watch,
} from '../../src/infrastructure/watch.js'
import { resolveMadarWorkspace } from '../../src/shared/workspace.js'
import { readCanonicalGraphFixture } from '../helpers/graph-artifact.js'

function withTempDir(callback: (tempDir: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-watch-'))
  try {
    callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

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
    if (condition()) return
    await delay(20)
  }
  throw new Error('condition was not met before timeout')
}

describe('canonical watch inputs', () => {
  test('watches supported sources and recognized unsupported candidates, but not noise', () => {
    expect(WATCHED_EXTENSIONS).toEqual(expect.objectContaining({}))
    expect(WATCHED_EXTENSIONS.has('.ts')).toBe(true)
    expect(WATCHED_EXTENSIONS.has('.tsx')).toBe(true)
    expect(WATCHED_EXTENSIONS.has('.js')).toBe(true)
    expect(WATCHED_EXTENSIONS.has('.jsx')).toBe(true)
    expect(WATCHED_EXTENSIONS.has('.vue')).toBe(true)
    expect(WATCHED_EXTENSIONS.has('.py')).toBe(true)
    expect(WATCHED_EXTENSIONS.has('.log')).toBe(false)
  })

  test('notifyOnly creates the needs_update flag', () => {
    withTempDir((tempDir) => {
      notifyOnly(tempDir)
      const flag = join(tempDir, 'out', 'needs_update')
      expect(existsSync(flag)).toBe(true)
      expect(readFileSync(flag, 'utf8')).toBe('1')
    })
  })

  test('watches every visible canonical compiler-control variant', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, '.madarignore'), 'ignored/**\n', 'utf8')
      writeFileSync(join(tempDir, 'package.json'), '{}\n', 'utf8')
      writeFileSync(join(tempDir, 'tsconfig.app.json'), '{}\n', 'utf8')
      writeFileSync(join(tempDir, 'jsconfig.web.json'), '{}\n', 'utf8')
      const ignoredDir = join(tempDir, 'ignored')
      mkdirSync(ignoredDir)
      writeFileSync(join(ignoredDir, 'tsconfig.hidden.json'), '{}\n', 'utf8')

      const paths = snapshotWatchedFiles(tempDir, false).fingerprints
      expect(paths.has(join(tempDir, 'package.json'))).toBe(true)
      expect(paths.has(join(tempDir, 'tsconfig.app.json'))).toBe(true)
      expect(paths.has(join(tempDir, 'jsconfig.web.json'))).toBe(true)
      expect(paths.has(join(ignoredDir, 'tsconfig.hidden.json'))).toBe(false)
    })
  })
})

describe('rebuildCode', () => {
  test('rebuilds canonical graph artifacts and clears the update flag', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export function hello(): number { return 1 }\n', 'utf8')
      notifyOnly(tempDir)

      expect(rebuildCode(tempDir)).toBe(true)
      expect(existsSync(join(tempDir, 'out', 'graph.json'))).toBe(true)
      expect(existsSync(join(tempDir, 'out', 'GRAPH_REPORT.md'))).toBe(true)
      expect(existsSync(join(tempDir, 'out', 'needs_update'))).toBe(false)
    })
  })

  test('uses update generation when a canonical manifest already exists', async () => {
    await withTempDirAsync(async (tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export const initial = true\n', 'utf8')
      generateGraph(tempDir)

      vi.resetModules()
      const actual = await vi.importActual<typeof import('../../src/infrastructure/generate.js')>(
        '../../src/infrastructure/generate.js',
      )
      const generateGraphSpy = vi.fn(actual.generateGraph)
      vi.doMock('../../src/infrastructure/generate.js', () => ({ ...actual, generateGraph: generateGraphSpy }))
      try {
        const watchModule = await import('../../src/infrastructure/watch.js')
        expect(watchModule.rebuildCode(tempDir)).toBe(true)
        expect(generateGraphSpy).toHaveBeenCalledOnce()
        expect(generateGraphSpy.mock.calls[0]?.[1]).toMatchObject({ update: true })
      } finally {
        vi.doUnmock('../../src/infrastructure/generate.js')
        vi.resetModules()
      }
    })
  })

  test('preserves every canonical corpus control from the stored policy', () => {
    withTempDir((tempDir) => {
      execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' })
      writeFileSync(join(tempDir, 'main.ts'), 'export const original = true\n', 'utf8')
      const initial = generateGraph(tempDir, {
        followSymlinks: true,
        respectGitignore: true,
        indexingStrict: { maxFailed: 0, maxUnsupported: 0 },
      })
      const before = parseGenerationPolicy(readCanonicalGraphFixture(initial.graphPath).generation_policy)

      writeFileSync(join(tempDir, 'main.ts'), 'export const refreshed = true\n', 'utf8')
      expect(rebuildCode(tempDir)).toBe(true)

      const after = parseGenerationPolicy(readCanonicalGraphFixture(initial.graphPath).generation_policy)
      expect(after).toEqual(before)
      expect(after?.settings).toMatchObject({
        follow_symlinks: true,
        respect_gitignore: true,
        indexing_strict: { max_failed: 0, max_unsupported: 0 },
      })
    })
  })
})

describe('background auto-refresh', () => {
  test('settles startup without rebuilding an unchanged valid graph', async () => {
    await withTempDirAsync(async (tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export const value = 1\n', 'utf8')
      const generated = generateGraph(tempDir)
      const rebuild = vi.fn(() => true)
      const refresh = startGraphAutoRefresh(tempDir, 0.02, {
        pollIntervalMs: 20,
        rebuildCode: rebuild,
        logger: { log() {}, error() {} },
      })
      try {
        await refresh.startupSettled
        expect(refresh.startupComplete?.()).toBe(true)
        expect(refresh.initialRebuilt).toBe(false)
        expect(rebuild).not.toHaveBeenCalled()
        expect(readWatcherStateForGraph(generated.graphPath)).toMatchObject({
          status: 'idle',
          coverage: 'complete',
          policy_match: true,
        })
      } finally {
        refresh.stop()
        await refresh.completed
      }
    })
  })

  test('rebuilds when an indexed source changes', async () => {
    await withTempDirAsync(async (tempDir) => {
      const source = join(tempDir, 'main.ts')
      writeFileSync(source, 'export const value = 1\n', 'utf8')
      generateGraph(tempDir)
      writeFileSync(source, 'export const value = 2\n', 'utf8')
      const rebuild = vi.fn(() => true)
      const refresh = startGraphAutoRefresh(tempDir, 0.02, {
        pollIntervalMs: 20,
        rebuildCode: rebuild,
        logger: { log() {}, error() {} },
      })
      try {
        await refresh.startupSettled
        expect(refresh.initialRebuilt).toBe(true)
        expect(rebuild).toHaveBeenCalledOnce()
      } finally {
        refresh.stop()
        await refresh.completed
      }
    })
  })

  test('refreshes completeness when a recognized unsupported candidate is added', async () => {
    await withTempDirAsync(async (tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export const initial = true\n', 'utf8')
      const refresh = startGraphAutoRefresh(tempDir, 0.02, {
        pollIntervalMs: 10,
        logger: { log() {}, error() {} },
      })
      try {
        await refresh.startupSettled
        const manifestPath = join(tempDir, 'out', 'indexing-manifest.json')
        writeFileSync(join(tempDir, 'legacy.vue'), '<template />\n', 'utf8')
        await waitFor(() => {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
            outcomes?: Array<{ path?: string; status?: string; reason?: string }>
          }
          return manifest.outcomes?.some((outcome) => outcome.path === 'legacy.vue'
            && outcome.status === 'unsupported'
            && outcome.reason === 'unsupported_file_type') === true
        })
      } finally {
        refresh.stop()
        await refresh.completed
      }
    })
  }, 10_000)

  test('keeps generated artifacts outside a linked worktree', async () => {
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
        logger: { log() {}, error() {} },
      })
      try {
        await refresh.startupSettled
        expect(workspace.isLinkedWorktree).toBe(true)
        expect(existsSync(workspace.graphPath)).toBe(true)
        expect(existsSync(join(linked, 'out'))).toBe(false)
      } finally {
        refresh.stop()
        await refresh.completed
      }
    })
  }, 15_000)

  test('stops cleanly after an idle polling reconciliation', async () => {
    await withTempDirAsync(async (tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export const idle = true\n', 'utf8')
      const controller = new AbortController()
      const watcher = watch(tempDir, 0.02, {
        signal: controller.signal,
        pollIntervalMs: 20,
        logger: { log() {}, error() {} },
      })
      await delay(80)
      controller.abort()
      await watcher
      expect(readWatcherStateForGraph(join(tempDir, 'out', 'graph.json'))?.status).toBe('stopped')
    })
  })
})
