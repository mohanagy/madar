import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { loadGraphArtifact } from '../adapters/filesystem/graph-artifact.js'
import { generateIndex, type GenerateIndexOptions, type GenerateIndexResult } from '../application/generate-index.js'
import { CANONICAL_INDEX_FORMAT_VERSION } from '../domain/index/build-state.js'
import type { KnowledgeGraph } from '../domain/graph/directed-multigraph.js'
import { compareTimeTravelGraphs, type CompareTimeTravelGraphsOptions, type TimeTravelResult } from '../runtime/time-travel.js'
import { validateGraphOutputPath } from '../shared/security.js'
import { resolveMadarOutputDirectory, resolveMadarWorkspace } from '../shared/workspace.js'

type MaybePromise<T> = T | Promise<T>

const inflightSnapshotBuilds = new Map<string, Promise<TimeTravelSnapshot>>()

interface SnapshotMetadata {
  commitSha: string
  indexFormatVersion: number | null
  schemaVersion: number | null
}

export interface SnapshotRequest {
  ref: string
  refresh?: boolean
}

export interface TimeTravelSnapshot {
  ref: string
  commitSha: string
  graphPath: string
  reportPath: string | null
  fromCache: boolean
}

export interface SnapshotGitDependencies {
  resolveRef?: (ref: string) => MaybePromise<string>
  createDetachedWorktree?: (worktreePath: string, commitSha: string) => MaybePromise<void>
  removeWorktree?: (worktreePath: string) => MaybePromise<void>
}

export interface SnapshotDependencies {
  rootDir?: string
  git?: SnapshotGitDependencies
  generateGraph?: (rootPath: string, options: GenerateIndexOptions) => MaybePromise<GenerateIndexResult | Pick<GenerateIndexResult, 'graphPath' | 'reportPath'>>
}

export interface CompareRefsInput extends Omit<CompareTimeTravelGraphsOptions, 'fromRef' | 'toRef'> {
  fromRef: string
  toRef: string
  refresh?: boolean
}

export interface CompareRefsDependencies extends SnapshotDependencies {
  loadGraph?: (graphPath: string) => KnowledgeGraph
  compareTimeTravelGraphs?: (
    beforeGraph: KnowledgeGraph,
    afterGraph: KnowledgeGraph,
    options?: CompareTimeTravelGraphsOptions,
  ) => TimeTravelResult
}

function gitOutput(rootDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function defaultGitDependencies(rootDir: string): Required<SnapshotGitDependencies> {
  return {
    resolveRef(ref: string): string {
      return gitOutput(rootDir, ['rev-parse', '--verify', `${ref}^{commit}`])
    },
    createDetachedWorktree(worktreePath: string, commitSha: string): void {
      gitOutput(rootDir, ['worktree', 'add', '--detach', worktreePath, commitSha])
    },
    removeWorktree(worktreePath: string): void {
      gitOutput(rootDir, ['worktree', 'remove', '--force', worktreePath])
    },
  }
}

function snapshotBaseDir(rootDir: string): string {
  const outDir = resolveMadarOutputDirectory(rootDir)
  return validateGraphOutputPath(join(outDir, 'time-travel', 'snapshots'), outDir)
}

function snapshotDir(rootDir: string, commitSha: string): string {
  return validateGraphOutputPath(join(snapshotBaseDir(rootDir), commitSha), resolveMadarOutputDirectory(rootDir))
}

function snapshotGraphPath(rootDir: string, commitSha: string): string {
  return join(snapshotDir(rootDir, commitSha), 'graph.json')
}

function snapshotReportPath(rootDir: string, commitSha: string): string {
  return join(snapshotDir(rootDir, commitSha), 'GRAPH_REPORT.md')
}

function snapshotMetadataPath(rootDir: string, commitSha: string): string {
  return join(snapshotDir(rootDir, commitSha), 'metadata.json')
}

function worktreeRootDir(): string {
  // Linked-worktree artifacts live below the shared Git directory. Git cannot
  // create a worktree inside that directory (notably on Windows), so transient
  // source checkouts must use an OS-temporary location instead.
  const directory = join(tmpdir(), 'madar-time-travel-worktrees')
  mkdirSync(directory, { recursive: true })
  return directory
}

function worktreePath(commitSha: string): string {
  return join(worktreeRootDir(), `${commitSha}-${process.pid}-${Date.now()}`)
}

function snapshotBuildKey(rootDir: string, commitSha: string, refresh: boolean): string {
  return `${rootDir}:${commitSha}:${refresh ? 'refresh' : 'reuse'}`
}

function snapshotTempDir(rootDir: string, commitSha: string): string {
  return validateGraphOutputPath(
    join(snapshotBaseDir(rootDir), `${commitSha}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    resolveMadarOutputDirectory(rootDir),
  )
}

function readGraphSchemaVersion(graphPath: string): number | null {
  const schemaVersion = loadGraphArtifact(graphPath).graph.schema_version
  return typeof schemaVersion === 'number' && Number.isFinite(schemaVersion) ? schemaVersion : null
}

function readSnapshotMetadata(rootDir: string, commitSha: string): SnapshotMetadata | null {
  try {
    const parsed = JSON.parse(readFileSync(snapshotMetadataPath(rootDir, commitSha), 'utf8')) as Partial<SnapshotMetadata>
    return {
      commitSha: typeof parsed.commitSha === 'string' ? parsed.commitSha : '',
      indexFormatVersion: typeof parsed.indexFormatVersion === 'number' && Number.isFinite(parsed.indexFormatVersion) ? parsed.indexFormatVersion : null,
      schemaVersion: typeof parsed.schemaVersion === 'number' && Number.isFinite(parsed.schemaVersion) ? parsed.schemaVersion : null,
    }
  } catch {
    return null
  }
}

function canReuseSnapshot(rootDir: string, commitSha: string): boolean {
  const graphPath = snapshotGraphPath(rootDir, commitSha)
  if (!existsSync(graphPath)) {
    return false
  }
  const graphSchemaVersion = readGraphSchemaVersion(graphPath)
  const metadata = readSnapshotMetadata(rootDir, commitSha)
  if (!metadata) {
    return false
  }

  return (
    metadata.commitSha === commitSha
    && metadata.indexFormatVersion === CANONICAL_INDEX_FORMAT_VERSION
    && metadata.schemaVersion !== null
    && metadata.schemaVersion === graphSchemaVersion
  )
}

function persistSnapshot(rootDir: string, ref: string, commitSha: string, generated: Pick<GenerateIndexResult, 'graphPath' | 'reportPath'>): TimeTravelSnapshot {
  const destinationDir = snapshotDir(rootDir, commitSha)
  const tempDir = snapshotTempDir(rootDir, commitSha)
  mkdirSync(tempDir, { recursive: true })

  const tempGraphPath = join(tempDir, 'graph.json')
  const tempReportPath = join(tempDir, 'GRAPH_REPORT.md')
  const tempMetadataPath = join(tempDir, 'metadata.json')
  const graphPath = join(destinationDir, 'graph.json')
  const reportPath = join(destinationDir, 'GRAPH_REPORT.md')

  try {
    copyFileSync(generated.graphPath, tempGraphPath)

    if (generated.reportPath && existsSync(generated.reportPath)) {
      copyFileSync(generated.reportPath, tempReportPath)
    } else {
      rmSync(tempReportPath, { force: true })
    }

    writeFileSync(tempMetadataPath, JSON.stringify({
      commitSha,
      indexFormatVersion: CANONICAL_INDEX_FORMAT_VERSION,
      schemaVersion: readGraphSchemaVersion(tempGraphPath),
    }))

    rmSync(destinationDir, { recursive: true, force: true })
    renameSync(tempDir, destinationDir)
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true })
    throw error
  }

  return {
    ref,
    commitSha,
    graphPath,
    reportPath: existsSync(reportPath) ? reportPath : null,
    fromCache: false,
  }
}

function cachedSnapshot(rootDir: string, ref: string, commitSha: string): TimeTravelSnapshot {
  const reportPath = snapshotReportPath(rootDir, commitSha)
  return {
    ref,
    commitSha,
    graphPath: snapshotGraphPath(rootDir, commitSha),
    reportPath: existsSync(reportPath) ? reportPath : null,
    fromCache: true,
  }
}

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

async function snapshotFromInflightBuild(input: SnapshotRequest, rootDir: string, commitSha: string, inflightBuild: Promise<TimeTravelSnapshot>): Promise<TimeTravelSnapshot> {
  const snapshot = await inflightBuild
  if (!input.refresh && canReuseSnapshot(rootDir, commitSha)) {
    return cachedSnapshot(rootDir, input.ref, commitSha)
  }
  return {
    ...snapshot,
    ref: input.ref,
    fromCache: false,
  }
}

function getOrCreateInflightSnapshotBuild(buildKey: string, createBuild: () => Promise<TimeTravelSnapshot>): {
  promise: Promise<TimeTravelSnapshot>
  created: boolean
} {
  const existingBuild = inflightSnapshotBuilds.get(buildKey)
  if (existingBuild) {
    return {
      promise: existingBuild,
      created: false,
    }
  }

  const deferredBuild = createDeferred<TimeTravelSnapshot>()
  inflightSnapshotBuilds.set(buildKey, deferredBuild.promise)

  void (async () => {
    try {
      deferredBuild.resolve(await createBuild())
    } catch (error) {
      deferredBuild.reject(error)
    } finally {
      if (inflightSnapshotBuilds.get(buildKey) === deferredBuild.promise) {
        inflightSnapshotBuilds.delete(buildKey)
      }
    }
  })()

  return {
    promise: deferredBuild.promise,
    created: true,
  }
}

function resolvedSnapshotDependencies(dependencies: SnapshotDependencies): Required<SnapshotDependencies> & { git: Required<SnapshotGitDependencies> } {
  const rootDir = resolve(dependencies.rootDir ?? '.')
  return {
    rootDir,
    git: {
      ...defaultGitDependencies(rootDir),
      ...(dependencies.git ?? {}),
    },
    generateGraph: dependencies.generateGraph ?? generateIndex,
  }
}

function resolvedCompareDependencies(dependencies: CompareRefsDependencies): Required<CompareRefsDependencies> & { git: Required<SnapshotGitDependencies> } {
  const snapshotDependencies = resolvedSnapshotDependencies(dependencies)
  return {
    ...snapshotDependencies,
    loadGraph: dependencies.loadGraph ?? loadGraphArtifact,
    compareTimeTravelGraphs: dependencies.compareTimeTravelGraphs ?? compareTimeTravelGraphs,
  }
}

export async function loadOrBuildSnapshot(input: SnapshotRequest, dependencies: SnapshotDependencies = {}): Promise<TimeTravelSnapshot> {
  const deps = resolvedSnapshotDependencies(dependencies)
  const commitSha = await deps.git.resolveRef(input.ref)
  const refresh = input.refresh === true

  if (!refresh && canReuseSnapshot(deps.rootDir, commitSha)) {
    return cachedSnapshot(deps.rootDir, input.ref, commitSha)
  }

  if (!refresh) {
    const inflightRefreshBuild = inflightSnapshotBuilds.get(snapshotBuildKey(deps.rootDir, commitSha, true))
    if (inflightRefreshBuild) {
      return snapshotFromInflightBuild(input, deps.rootDir, commitSha, inflightRefreshBuild)
    }
  }

  const buildKey = snapshotBuildKey(deps.rootDir, commitSha, refresh)
  const { promise: buildPromise, created } = getOrCreateInflightSnapshotBuild(buildKey, async (): Promise<TimeTravelSnapshot> => {
    const materializedWorktree = worktreePath(commitSha)
    let worktreeCreated = false
    let buildError: unknown = null
    let transientArtifactRoot: string | null = null

    try {
      await deps.git.createDetachedWorktree(materializedWorktree, commitSha)
      worktreeCreated = true
      const transientWorkspace = resolveMadarWorkspace(materializedWorktree)
      transientArtifactRoot = transientWorkspace.isLinkedWorktree ? transientWorkspace.artifactRoot : null

      const generated = await deps.generateGraph(materializedWorktree, {})
      return persistSnapshot(deps.rootDir, input.ref, commitSha, generated)
    } catch (error) {
      buildError = error
      throw error
    } finally {
      if (worktreeCreated) {
        try {
          await deps.git.removeWorktree(materializedWorktree)
        } catch (cleanupError) {
          if (buildError == null) {
            throw cleanupError
          }
        } finally {
          if (transientArtifactRoot) {
            try {
              rmSync(transientArtifactRoot, { recursive: true, force: true })
            } catch {
              // Snapshot publication succeeded; an orphaned scratch artifact is
              // safe to leave behind and must not turn a completed comparison
              // into a failure.
            }
          }
        }
      }
    }
  })

  if (!created) {
    return snapshotFromInflightBuild(input, deps.rootDir, commitSha, buildPromise)
  }

  return buildPromise
}

export async function compareRefs(input: CompareRefsInput, dependencies: CompareRefsDependencies = {}): Promise<TimeTravelResult> {
  const deps = resolvedCompareDependencies(dependencies)
  const fromSnapshot = await loadOrBuildSnapshot({
    ref: input.fromRef,
    ...(input.refresh !== undefined ? { refresh: input.refresh } : {}),
  }, deps)
  const toSnapshot = await loadOrBuildSnapshot({
    ref: input.toRef,
    ...(input.refresh !== undefined ? { refresh: input.refresh } : {}),
  }, deps)
  const fromGraph = deps.loadGraph(fromSnapshot.graphPath)
  const toGraph = deps.loadGraph(toSnapshot.graphPath)

  return deps.compareTimeTravelGraphs(fromGraph, toGraph, {
    fromRef: input.fromRef,
    toRef: input.toRef,
    ...(input.view !== undefined ? { view: input.view } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.depth !== undefined ? { depth: input.depth } : {}),
    ...(input.edgeTypes !== undefined ? { edgeTypes: input.edgeTypes } : {}),
  })
}
