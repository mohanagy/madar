import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EXTRACTOR_CACHE_VERSION } from '../../src/pipeline/extract.js'
import { compareRefs, loadOrBuildSnapshot, type CompareRefsDependencies, type SnapshotDependencies } from '../../src/infrastructure/time-travel.js'
import type { TimeTravelResult } from '../../src/runtime/time-travel.js'
import { resolveMadarWorkspace } from '../../src/shared/workspace.js'

const createdRoots = new Set<string>()

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createTestRoot(name: string): string {
  const root = resolve('.test-artifacts', `time-travel-infrastructure-${name}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`)
  mkdirSync(root, { recursive: true })
  createdRoots.add(root)
  return root
}

function writeGraphArtifacts(root: string, relativeDir: string, schemaVersion = 2): { graphPath: string; reportPath: string } {
  const outputDir = join(root, relativeDir, 'out')
  mkdirSync(outputDir, { recursive: true })
  const graphPath = join(outputDir, 'graph.json')
  const reportPath = join(outputDir, 'GRAPH_REPORT.md')
  writeFileSync(graphPath, JSON.stringify({
    schema_version: schemaVersion,
    extractor_version: EXTRACTOR_CACHE_VERSION,
    nodes: [],
    edges: [],
  }))
  writeFileSync(reportPath, '# report\n')
  return { graphPath, reportPath }
}

function writeCachedSnapshot(root: string, commitSha: string, schemaVersion = 2): void {
  const snapshotDir = join(root, 'out', 'time-travel', 'snapshots', commitSha)
  mkdirSync(snapshotDir, { recursive: true })
  writeFileSync(join(snapshotDir, 'graph.json'), JSON.stringify({
    schema_version: schemaVersion,
    extractor_version: EXTRACTOR_CACHE_VERSION,
    nodes: [],
    edges: [],
  }))
  writeFileSync(join(snapshotDir, 'GRAPH_REPORT.md'), '# cached report\n')
  writeFileSync(join(snapshotDir, 'metadata.json'), JSON.stringify({
    commitSha,
    extractorVersion: EXTRACTOR_CACHE_VERSION,
    schemaVersion,
  }))
}

function createSnapshotDependencies(rootDir: string): SnapshotDependencies & {
  git: {
    resolveRef: ReturnType<typeof vi.fn>
    createDetachedWorktree: ReturnType<typeof vi.fn>
    removeWorktree: ReturnType<typeof vi.fn>
  }
  generateGraph: ReturnType<typeof vi.fn>
  loadGraphExtractorVersion: ReturnType<typeof vi.fn>
} {
  const git = {
    resolveRef: vi.fn(async (ref: string) => {
      return ref === 'main' ? 'cached-sha' : 'generated-sha'
    }),
    createDetachedWorktree: vi.fn(async (worktreePath: string) => {
      writeGraphArtifacts(worktreePath, '.')
    }),
    removeWorktree: vi.fn(async () => {}),
  }

  const generateGraph = vi.fn((worktreePath: string) => {
    return {
      graphPath: join(worktreePath, 'out', 'graph.json'),
      reportPath: join(worktreePath, 'out', 'GRAPH_REPORT.md'),
    }
  })

  const loadGraphExtractorVersion = vi.fn(() => EXTRACTOR_CACHE_VERSION)

  return {
    rootDir,
    git,
    generateGraph,
    loadGraphExtractorVersion,
  }
}

afterEach(() => {
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true })
  }
  createdRoots.clear()
})

describe('time travel infrastructure', () => {
  it('reuses an existing snapshot when cache metadata matches', async () => {
    const rootDir = createTestRoot('cache-hit')
    writeCachedSnapshot(rootDir, 'cached-sha')
    const deps = createSnapshotDependencies(rootDir)

    const result = await loadOrBuildSnapshot({ ref: 'main', refresh: false }, deps)

    expect(result.fromCache).toBe(true)
    expect(deps.generateGraph).not.toHaveBeenCalled()
    expect(deps.git.createDetachedWorktree).not.toHaveBeenCalled()
  })

  it('materializes a ref and builds a snapshot on cache miss', async () => {
    const rootDir = createTestRoot('cache-miss')
    const deps = createSnapshotDependencies(rootDir)
    deps.git.resolveRef.mockResolvedValue('commit-head-1')

    const result = await loadOrBuildSnapshot({ ref: 'HEAD~1', refresh: false }, deps)

    expect(deps.git.resolveRef).toHaveBeenCalledWith('HEAD~1')
    expect(deps.generateGraph).toHaveBeenCalled()
    expect(result.fromCache).toBe(false)
    expect(existsSync(join(rootDir, 'out', 'time-travel', 'snapshots', 'commit-head-1', 'graph.json'))).toBe(true)
    expect(deps.git.removeWorktree).toHaveBeenCalledTimes(1)
  })

  it('forces a rebuild when refresh is true', async () => {
    const rootDir = createTestRoot('refresh')
    writeCachedSnapshot(rootDir, 'tag-sha')
    const deps = createSnapshotDependencies(rootDir)
    deps.git.resolveRef.mockResolvedValue('tag-sha')

    const result = await loadOrBuildSnapshot({ ref: 'v0.8.3', refresh: true }, deps)

    expect(result.fromCache).toBe(false)
    expect(deps.generateGraph).toHaveBeenCalledTimes(1)
  })

  it('reuses an in-flight snapshot build for concurrent requests for the same commit', async () => {
    const rootDir = createTestRoot('in-flight')
    const deps = createSnapshotDependencies(rootDir)
    const resolveRefGate = createDeferred<void>()
    deps.git.resolveRef.mockImplementation(async () => {
      await resolveRefGate.promise
      return 'shared-sha'
    })

    const buildGate = createDeferred<void>()
    const buildStarted = createDeferred<void>()
    deps.generateGraph.mockImplementationOnce(async (worktreePath: string) => {
      buildStarted.resolve()
      await buildGate.promise
      return {
        graphPath: join(worktreePath, 'out', 'graph.json'),
        reportPath: join(worktreePath, 'out', 'GRAPH_REPORT.md'),
      }
    })

    const first = loadOrBuildSnapshot({ ref: 'main', refresh: false }, deps)
    const second = loadOrBuildSnapshot({ ref: 'origin/main', refresh: false }, deps)
    resolveRefGate.resolve()
    await buildStarted.promise
    buildGate.resolve()

    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(deps.generateGraph).toHaveBeenCalledTimes(1)
    expect(firstResult.fromCache).toBe(false)
    expect(secondResult.fromCache).toBe(true)
    expect(secondResult.graphPath).toBe(firstResult.graphPath)
  })

  it('starts a fresh build when refresh is requested during a non-refresh in-flight build', async () => {
    const rootDir = createTestRoot('refresh-in-flight')
    const deps = createSnapshotDependencies(rootDir)
    deps.git.resolveRef.mockResolvedValue('shared-sha')

    const firstBuildGate = createDeferred<void>()
    const firstBuildStarted = createDeferred<void>()
    deps.generateGraph
      .mockImplementationOnce(async (worktreePath: string) => {
        firstBuildStarted.resolve()
        await firstBuildGate.promise
        return {
          graphPath: join(worktreePath, 'out', 'graph.json'),
          reportPath: join(worktreePath, 'out', 'GRAPH_REPORT.md'),
        }
      })
      .mockImplementation(async (worktreePath: string) => ({
        graphPath: join(worktreePath, 'out', 'graph.json'),
        reportPath: join(worktreePath, 'out', 'GRAPH_REPORT.md'),
      }))

    const first = loadOrBuildSnapshot({ ref: 'main', refresh: false }, deps)
    await firstBuildStarted.promise
    const refreshed = loadOrBuildSnapshot({ ref: 'main', refresh: true }, deps)
    firstBuildGate.resolve()

    const [firstResult, refreshedResult] = await Promise.all([first, refreshed])

    expect(deps.generateGraph).toHaveBeenCalledTimes(2)
    expect(deps.git.createDetachedWorktree).toHaveBeenCalledTimes(2)
    expect(firstResult.fromCache).toBe(false)
    expect(refreshedResult.fromCache).toBe(false)
  })

  it('preserves the original failure when worktree cleanup also fails', async () => {
    const rootDir = createTestRoot('cleanup-failure')
    const deps = createSnapshotDependencies(rootDir)
    deps.git.resolveRef.mockResolvedValue('cleanup-sha')
    deps.generateGraph.mockImplementation(() => {
      throw new Error('build failed')
    })
    deps.git.removeWorktree.mockRejectedValue(new Error('cleanup failed'))

    await expect(loadOrBuildSnapshot({ ref: 'HEAD', refresh: false }, deps)).rejects.toThrow('build failed')
  })

  it('keeps linked-worktree snapshots isolated and removes the transient external artifact', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'madar-time-travel-worktree-'))
    const primary = join(tempDir, 'primary')
    const linked = join(tempDir, 'linked')
    try {
      execFileSync('git', ['init', primary], { stdio: 'pipe' })
      execFileSync('git', ['config', 'user.email', 'madar-tests@example.com'], { cwd: primary, stdio: 'pipe' })
      execFileSync('git', ['config', 'user.name', 'Madar Tests'], { cwd: primary, stdio: 'pipe' })
      writeFileSync(join(primary, 'main.ts'), 'export const snapshotValue = 1\n')
      execFileSync('git', ['add', '.'], { cwd: primary, stdio: 'pipe' })
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: primary, stdio: 'pipe' })
      execFileSync('git', ['worktree', 'add', '-b', 'feature/time-travel', linked], { cwd: primary, stdio: 'pipe' })

      const linkedWorkspace = resolveMadarWorkspace(linked)
      const result = await loadOrBuildSnapshot({ ref: 'HEAD' }, { rootDir: linked })
      const artifactContainer = join(linkedWorkspace.gitCommonDir ?? '', 'madar', 'worktrees')
      const cachedWorktrees = join(linkedWorkspace.outputDir, 'cache', 'time-travel', 'worktrees')

      expect(linkedWorkspace.isLinkedWorktree).toBe(true)
      expect(result.graphPath).toBe(join(linkedWorkspace.outputDir, 'time-travel', 'snapshots', result.commitSha, 'graph.json'))
      expect(existsSync(result.graphPath)).toBe(true)
      expect(existsSync(join(linked, 'out'))).toBe(false)
      expect(readdirSync(artifactContainer).sort()).toEqual([basename(linkedWorkspace.artifactRoot)])
      expect(readdirSync(cachedWorktrees)).toHaveLength(0)

      const worktreeList = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: linked, encoding: 'utf8', stdio: 'pipe' })
      expect(worktreeList).toContain(`worktree ${realpathSync(primary)}`)
      expect(worktreeList).toContain(`worktree ${realpathSync(linked)}`)
      expect(worktreeList).not.toContain('time-travel/worktrees')
    } finally {
      if (existsSync(primary)) {
        try {
          execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: primary, stdio: 'pipe' })
        } catch {
          // Temp directory cleanup below still handles partial setup failures.
        }
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 20_000)

  it('loads both snapshots and compares them through the runtime helper', async () => {
    const rootDir = createTestRoot('compare')
    writeCachedSnapshot(rootDir, 'from-sha')
    writeCachedSnapshot(rootDir, 'to-sha')
    const snapshotDeps = createSnapshotDependencies(rootDir)
    snapshotDeps.git.resolveRef
      .mockResolvedValueOnce('from-sha')
      .mockResolvedValueOnce('to-sha')

    const fromGraph = { id: 'from-graph' }
    const toGraph = { id: 'to-graph' }
    const expected: TimeTravelResult = {
      fromRef: 'main',
      toRef: 'HEAD',
      view: 'risk',
      summary: { headline: 'headline', whyItMatters: [] },
      changed: { nodesAdded: 0, nodesRemoved: 0, edgesAdded: 0, edgesRemoved: 0, communities: [] },
      risk: { topImpacts: [] },
      drift: { movedNodes: [] },
      timeline: { events: [] },
    }

    const deps: CompareRefsDependencies = {
      ...snapshotDeps,
      loadGraph: vi.fn((graphPath: string) => (graphPath.includes('from-sha') ? fromGraph : toGraph) as never),
      compareTimeTravelGraphs: vi.fn(() => expected),
    }

    const result = await compareRefs({ fromRef: 'main', toRef: 'HEAD', view: 'risk', limit: 3 }, deps)

    expect(result).toBe(expected)
    expect(deps.loadGraph).toHaveBeenCalledTimes(2)
    expect(deps.compareTimeTravelGraphs).toHaveBeenCalledWith(
      fromGraph,
      toGraph,
      expect.objectContaining({ fromRef: 'main', toRef: 'HEAD', view: 'risk', limit: 3 }),
    )
  })
})
