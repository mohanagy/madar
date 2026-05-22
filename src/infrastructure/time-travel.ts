import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { KnowledgeGraph } from '../contracts/graph.js'
import { EXTRACTOR_CACHE_VERSION } from '../pipeline/extract.js'
import { loadGraph } from '../runtime/serve.js'
import { compareTimeTravelGraphs, type CompareTimeTravelGraphsOptions, type TimeTravelResult } from '../runtime/time-travel.js'
import { validateGraphOutputPath } from '../shared/security.js'
import { cacheDir } from './cache.js'
import { generateGraph, loadGraphExtractorVersion, type GenerateGraphOptions, type GenerateGraphResult } from './generate.js'

type MaybePromise<T> = T | Promise<T>

const inflightSnapshotBuilds = new Map<string, Promise<TimeTravelSnapshot>>()

interface SnapshotMetadata {
  commitSha: string
  extractorVersion: number | null
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
  generateGraph?: (rootPath: string, options: GenerateGraphOptions) => MaybePromise<GenerateGraphResult | Pick<GenerateGraphResult, 'graphPath' | 'reportPath'>>
  loadGraphExtractorVersion?: (graphPath: string) => number | null
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
  const outDir = join(rootDir, 'out')
  return validateGraphOutputPath(join(outDir, 'time-travel', 'snapshots'), outDir)
}

function snapshotDir(rootDir: string, commitSha: string): string {
  return validateGraphOutputPath(join(snapshotBaseDir(rootDir), commitSha), join(rootDir, 'out'))
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

function worktreeRootDir(rootDir: string): string {
  return cacheDir(rootDir, 'time-travel', 'worktrees')
}

function worktreePath(rootDir: string, commitSha: string): string {
  return join(worktreeRootDir(rootDir), `${commitSha}-${process.pid}-${Date.now()}`)
}

function snapshotBuildKey(rootDir: string, commitSha: string, refresh: boolean): string {
  return `${rootDir}:${commitSha}:${refresh ? 'refresh' : 'reuse'}`
}

function snapshotTempDir(rootDir: string, commitSha: string): string {
  return validateGraphOutputPath(
    join(snapshotBaseDir(rootDir), `${commitSha}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    join(rootDir, 'out'),
  )
}

function readGraphSchemaVersion(graphPath: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(graphPath, 'utf8')) as { schema_version?: unknown }
    return typeof parsed.schema_version === 'number' && Number.isFinite(parsed.schema_version) ? parsed.schema_version : null
  } catch {
    return null
  }
}

function readSnapshotMetadata(rootDir: string, commitSha: string): SnapshotMetadata | null {
  try {
    const parsed = JSON.parse(readFileSync(snapshotMetadataPath(rootDir, commitSha), 'utf8')) as Partial<SnapshotMetadata>
    return {
      commitSha: typeof parsed.commitSha === 'string' ? parsed.commitSha : '',
      extractorVersion: typeof parsed.extractorVersion === 'number' && Number.isFinite(parsed.extractorVersion) ? parsed.extractorVersion : null,
      schemaVersion: typeof parsed.schemaVersion === 'number' && Number.isFinite(parsed.schemaVersion) ? parsed.schemaVersion : null,
    }
  } catch {
    return null
  }
}

function canReuseSnapshot(rootDir: string, commitSha: string): boolean {
  const metadata = readSnapshotMetadata(rootDir, commitSha)
  const graphPath = snapshotGraphPath(rootDir, commitSha)
  if (!metadata || !existsSync(graphPath)) {
    return false
  }

  return (
    metadata.commitSha === commitSha
    && metadata.extractorVersion === EXTRACTOR_CACHE_VERSION
    && metadata.schemaVersion !== null
    && metadata.schemaVersion === readGraphSchemaVersion(graphPath)
  )
}

function persistSnapshot(rootDir: string, ref: string, commitSha: string, generated: Pick<GenerateGraphResult, 'graphPath' | 'reportPath'>, extractorVersion: number | null): TimeTravelSnapshot {
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
      extractorVersion,
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
    generateGraph: dependencies.generateGraph ?? generateGraph,
    loadGraphExtractorVersion: dependencies.loadGraphExtractorVersion ?? loadGraphExtractorVersion,
  }
}

function resolvedCompareDependencies(dependencies: CompareRefsDependencies): Required<CompareRefsDependencies> & { git: Required<SnapshotGitDependencies> } {
  const snapshotDependencies = resolvedSnapshotDependencies(dependencies)
  return {
    ...snapshotDependencies,
    loadGraph: dependencies.loadGraph ?? loadGraph,
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
    const materializedWorktree = worktreePath(deps.rootDir, commitSha)
    let worktreeCreated = false
    let buildError: unknown = null

    try {
      await deps.git.createDetachedWorktree(materializedWorktree, commitSha)
      worktreeCreated = true

      const generated = await deps.generateGraph(materializedWorktree, { noHtml: true })
      const extractorVersion = deps.loadGraphExtractorVersion(generated.graphPath)
      return persistSnapshot(deps.rootDir, input.ref, commitSha, generated, extractorVersion)
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
