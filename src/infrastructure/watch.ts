import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, watch as createFileSystemWatcher, writeFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

import { AUDIO_EXTENSIONS, CODE_EXTENSIONS, DOC_EXTENSIONS, IMAGE_EXTENSIONS, OFFICE_EXTENSIONS, PAPER_EXTENSIONS, VIDEO_EXTENSIONS } from '../pipeline/detect.js'
import { sidecarAwareFileFingerprint } from '../shared/binary-ingest-sidecar.js'
import { collectGitVisibleFiles } from '../shared/git.js'
import { resolveMadarOutputDirectory } from '../shared/workspace.js'
import { generateGraph, type GenerateGraphResult } from './generate.js'

export const WATCHED_EXTENSIONS = new Set([...CODE_EXTENSIONS, ...DOC_EXTENSIONS, ...PAPER_EXTENSIONS, ...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS, ...OFFICE_EXTENSIONS])
const MAX_SYMLINK_DEPTH = 40
const MAX_WATCHED_FILES = 10_000
const GIT_VISIBILITY_SNAPSHOT_KEY = '\0madar:git-visible-files'
const GIT_VISIBILITY_CACHE_DURATION_MS = 500
const REFRESH_LOCK_RETRY_MS = 50
const REFRESH_LOCK_TIMEOUT_MS = 30_000
const REFRESH_LOCK_STALE_MS = 60 * 60 * 1000

const WATCH_IGNORED_DIRECTORIES = new Set(['.git', 'out', 'node_modules', 'dist', 'build', 'target', 'venv', '.venv', 'env', '.env', '__pycache__'])
// These files can change the discovered corpus or the extraction environment
// even when no source file changes. Treat them as refresh triggers instead of
// waiting for an agent to remember a manual `madar generate --update`.
const WATCHED_CONTROL_FILENAMES = new Set([
  '.gitignore',
  '.madarignore',
  'package.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'jsconfig.json',
  'pyproject.toml',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
])

export interface WatchLogger {
  log(message?: string): void
  error(message?: string): void
}

export interface RebuildCodeOptions {
  followSymlinks?: boolean
  respectGitignore?: boolean
  noHtml?: boolean
  logger?: WatchLogger
}

export interface WatchOptions extends RebuildCodeOptions {
  signal?: AbortSignal
  pollIntervalMs?: number
  rebuildCode?: (watchPath: string, options?: RebuildCodeOptions) => boolean
  notifyOnly?: (watchPath: string, logger?: WatchLogger) => void
}

export interface GraphAutoRefreshController {
  /** Whether the initial incremental reconciliation produced a graph. */
  initialRebuilt: boolean
  /** Stops the watcher and releases its filesystem resources. */
  stop(): void
  /** Resolves once the watcher stops. */
  completed: Promise<void>
}

interface WatchLoopSignal {
  wait(signal?: AbortSignal): Promise<void>
  wake(): void
}

interface GitVisibilityCache {
  visibleFiles: string[] | null
  expiresAt: number
}

function defaultLogger(logger?: WatchLogger): WatchLogger {
  return logger ?? console
}

function resolveWatchPath(watchPath: string): string {
  return resolve(watchPath)
}

function createWatchLoopSignal(intervalMs: number): WatchLoopSignal {
  let wakePending = false
  let wakeResolver: (() => void) | null = null

  return {
    wait(signal?: AbortSignal): Promise<void> {
      return new Promise((resolvePromise) => {
        if (signal?.aborted) {
          resolvePromise()
          return
        }

        if (wakePending) {
          wakePending = false
          resolvePromise()
          return
        }
        let timer: ReturnType<typeof setTimeout> | undefined

        function onAbort(): void {
          finish()
        }

        function onWake(): void {
          wakePending = false
          finish()
        }

        function finish(): void {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          if (wakeResolver === onWake) {
            wakeResolver = null
          }
          resolvePromise()
        }

        wakeResolver = onWake
        signal?.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(finish, intervalMs)
      })
    },
    wake(): void {
      wakePending = true
      const resolver = wakeResolver
      wakeResolver = null
      resolver?.()
    },
  }
}

function startEventWatcher(watchPath: string, wake: () => void): { close(): void } | null {
  try {
    const watcher = createFileSystemWatcher(watchPath, { recursive: true, persistent: false }, () => {
      wake()
    })
    watcher.on('error', () => {
      wake()
    })
    return watcher
  } catch {
    return null
  }
}

function isWithinRoot(rootRealPath: string, candidateRealPath: string): boolean {
  const rootPrefix = rootRealPath.endsWith(sep) ? rootRealPath : `${rootRealPath}${sep}`
  return candidateRealPath === rootRealPath || candidateRealPath.startsWith(rootPrefix)
}

function controlFileFingerprint(filePath: string, modifiedAt: number): string {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex')
  } catch {
    return String(Math.round(modifiedAt))
  }
}

function sameFilesystemPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return resolve(left) === resolve(right)
  }
}

function graphBelongsToWorkspace(graphPath: string, workspaceRoot: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(graphPath, 'utf8')) as { root_path?: unknown }
    return typeof parsed.root_path === 'string'
      && parsed.root_path.trim().length > 0
      && sameFilesystemPath(parsed.root_path, workspaceRoot)
  } catch {
    return false
  }
}

function graphUsesSpi(graphPath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(graphPath, 'utf8')) as { spi_mode?: unknown }
    return parsed.spi_mode === true
  } catch {
    return false
  }
}

function pauseForRefreshLock(milliseconds: number): void {
  // Rebuilds themselves are synchronous CPU/IO work. A short synchronous wait
  // keeps the public `rebuildCode()` API synchronous while serializing two MCP
  // servers that happen to attach to the same worktree.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function isRefreshLeaseOwnerAlive(lockPath: string): boolean {
  try {
    const [pidValue] = readFileSync(lockPath, 'utf8').trim().split(/\s+/, 1)
    const pid = Number(pidValue)
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return false
    }
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : null
    // EPERM means the process exists but belongs to another user.
    return code === 'EPERM'
  }
}

function acquireRefreshLease(outputDir: string): () => void {
  mkdirSync(outputDir, { recursive: true })
  const lockPath = join(outputDir, '.madar-refresh.lock')
  const startedAt = Date.now()

  while (true) {
    try {
      const descriptor = openSync(lockPath, 'wx')
      const leaseId = randomUUID()
      try {
        writeFileSync(descriptor, `${process.pid} ${leaseId} ${new Date().toISOString()}\n`, 'utf8')
      } finally {
        closeSync(descriptor)
      }
      return () => {
        try {
          const contents = readFileSync(lockPath, 'utf8')
          if (contents.split(/\s+/, 3)[1] === leaseId) {
            rmSync(lockPath, { force: true })
          }
        } catch {
          // The lease may have been recovered after a process crash.
        }
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : null
      if (code !== 'EEXIST') {
        throw error
      }
    }

    try {
      if (Date.now() - statSync(lockPath).mtimeMs > REFRESH_LOCK_STALE_MS && !isRefreshLeaseOwnerAlive(lockPath)) {
        rmSync(lockPath, { force: true })
        continue
      }
    } catch {
      // Another process released the lease between the failed open and stat.
      continue
    }

    const remaining = REFRESH_LOCK_TIMEOUT_MS - (Date.now() - startedAt)
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for another Madar refresh in ${outputDir}`)
    }
    pauseForRefreshLock(Math.min(REFRESH_LOCK_RETRY_MS, remaining))
  }
}

function collectWatchedFiles(
  directory: string,
  followSymlinks: boolean,
  rootRealPath: string,
  ancestorRealPaths: string[],
  snapshots: Map<string, number | string>,
  includedFiles?: ReadonlySet<string>,
  depth = 0,
): void {
  if (depth > MAX_SYMLINK_DEPTH || snapshots.size >= MAX_WATCHED_FILES) {
    return
  }

  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return
  }

  for (const entry of entries) {
    const isControlFile = WATCHED_CONTROL_FILENAMES.has(entry)
    if (entry.startsWith('.') && !isControlFile) {
      continue
    }
    if (WATCH_IGNORED_DIRECTORIES.has(entry)) {
      continue
    }

    const entryPath = resolve(directory, entry)
    let stats
    try {
      stats = lstatSync(entryPath)
    } catch {
      continue
    }

    if (stats.isDirectory()) {
      collectWatchedFiles(entryPath, followSymlinks, rootRealPath, ancestorRealPaths, snapshots, includedFiles, depth + 1)
      continue
    }

    if (isControlFile && stats.isFile()) {
      snapshots.set(entryPath, controlFileFingerprint(entryPath, stats.mtimeMs))
      continue
    }

    if (stats.isSymbolicLink()) {
      if (!followSymlinks) {
        continue
      }

      let realTarget: string
      try {
        realTarget = realpathSync(entryPath)
      } catch {
        continue
      }

      if (ancestorRealPaths.includes(realTarget) || !isWithinRoot(rootRealPath, realTarget)) {
        continue
      }

      let targetStats
      try {
        targetStats = statSync(realTarget)
      } catch {
        continue
      }

      if (targetStats.isDirectory()) {
        collectWatchedFiles(entryPath, followSymlinks, rootRealPath, [...ancestorRealPaths, realTarget], snapshots, includedFiles, depth + 1)
        continue
      }

      if (!targetStats.isFile()) {
        continue
      }

      const extension = extname(entryPath).toLowerCase()
      if (WATCHED_EXTENSIONS.has(extension) && (!includedFiles || includedFiles.has(entryPath))) {
        snapshots.set(entryPath, sidecarAwareFileFingerprint(entryPath, targetStats.mtimeMs))
      }
      continue
    }

    if (!stats.isFile()) {
      continue
    }

    const extension = extname(entryPath).toLowerCase()
    if ((WATCHED_EXTENSIONS.has(extension) || isControlFile) && (!includedFiles || includedFiles.has(entryPath) || isControlFile)) {
      snapshots.set(entryPath, sidecarAwareFileFingerprint(entryPath, stats.mtimeMs))
    }
  }
}

function readGitVisibleFiles(watchPath: string, cache?: GitVisibilityCache): string[] | null {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.visibleFiles
  }

  const visibleFiles = collectGitVisibleFiles(watchPath)
  if (cache) {
    cache.visibleFiles = visibleFiles
    cache.expiresAt = Date.now() + GIT_VISIBILITY_CACHE_DURATION_MS
  }
  return visibleFiles
}

function snapshotWatchedFiles(
  watchPath: string,
  followSymlinks: boolean,
  respectGitignore = false,
  gitVisibilityCache?: GitVisibilityCache,
): Map<string, number | string> {
  const resolvedWatchPath = resolveWatchPath(watchPath)
  const snapshots = new Map<string, number | string>()

  let rootRealPath = resolvedWatchPath
  try {
    rootRealPath = realpathSync(resolvedWatchPath)
  } catch {
    rootRealPath = resolvedWatchPath
  }

  const visibleFiles = respectGitignore ? readGitVisibleFiles(resolvedWatchPath, gitVisibilityCache) : null
  const includedFiles = visibleFiles === null ? undefined : new Set(visibleFiles)
  collectWatchedFiles(resolvedWatchPath, followSymlinks, rootRealPath, [rootRealPath], snapshots, includedFiles)
  if (visibleFiles !== null) {
    const visibilityFingerprint = createHash('sha256').update([...visibleFiles].sort().join('\0')).digest('hex')
    snapshots.set(GIT_VISIBILITY_SNAPSHOT_KEY, visibilityFingerprint)
  }
  return snapshots
}

function diffSnapshots(previous: Map<string, number | string>, next: Map<string, number | string>): string[] {
  const changed = new Set<string>()

  for (const [filePath, modifiedAt] of next.entries()) {
    if (previous.get(filePath) !== modifiedAt) {
      changed.add(filePath)
    }
  }

  for (const filePath of previous.keys()) {
    if (!next.has(filePath)) {
      changed.add(filePath)
    }
  }

  return [...changed].sort()
}

export function notifyOnly(watchPath: string, logger?: WatchLogger): void {
  const resolvedWatchPath = resolveWatchPath(watchPath)
  const outputDir = resolveMadarOutputDirectory(resolvedWatchPath)
  const flagPath = join(outputDir, 'needs_update')
  const output = defaultLogger(logger)
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(flagPath, '1', 'utf8')
  output.log(`\n[madar watch] New or changed files detected in ${resolvedWatchPath}`)
  output.log('[madar watch] A manual refresh is still required for changes the watcher cannot rebuild automatically.')
  output.log('[madar watch] Run madar generate --update to refresh the graph.')
  output.log(`[madar watch] Flag written to ${flagPath}`)
}

export function hasNonCode(changedPaths: string[]): boolean {
  return changedPaths.some((filePath) => !CODE_EXTENSIONS.has(extname(filePath).toLowerCase()))
}

export function rebuildCode(watchPath: string, options: RebuildCodeOptions = {}): boolean {
  const resolvedWatchPath = resolveWatchPath(watchPath)
  const output = defaultLogger(options.logger)
  const graphOutputDir = resolveMadarOutputDirectory(resolvedWatchPath)
  const manifestPath = join(graphOutputDir, 'manifest.json')
  const graphPath = join(graphOutputDir, 'graph.json')

  try {
    const releaseLease = acquireRefreshLease(graphOutputDir)
    let result: GenerateGraphResult
    try {
      result = generateGraph(resolvedWatchPath, {
        ...(existsSync(manifestPath) && existsSync(graphPath) && graphBelongsToWorkspace(graphPath, resolvedWatchPath) ? { update: true } : {}),
        ...(graphUsesSpi(graphPath) ? { useSpi: true } : {}),
        ...(options.followSymlinks !== undefined ? { followSymlinks: options.followSymlinks } : {}),
        ...(options.respectGitignore !== undefined ? { respectGitignore: options.respectGitignore } : {}),
        ...(options.noHtml !== undefined ? { noHtml: options.noHtml } : {}),
      })
    } finally {
      releaseLease()
    }

    const staleFlag = join(result.outputDir, 'needs_update')
    if (existsSync(staleFlag)) {
      unlinkSync(staleFlag)
    }

    output.log(`[madar watch] Rebuilt: ${result.nodeCount} nodes, ${result.edgeCount} edges, ${result.communityCount} communities`)
    output.log(`[madar watch] Outputs updated in ${result.outputDir}`)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('No supported files were found')) {
      output.log('[madar watch] No supported files found - nothing to rebuild.')
      return false
    }

    output.error(`[madar watch] Rebuild failed: ${message}`)
    return false
  }
}

/**
 * Starts a watcher before reconciling the graph. The ordering is intentional:
 * a source edit made while the first generation is running is queued for a
 * follow-up incremental rebuild instead of being published as silently fresh.
 */
export function startGraphAutoRefresh(
  watchPath: string,
  debounceSeconds = 1,
  options: Omit<WatchOptions, 'signal'> = {},
): GraphAutoRefreshController {
  const controller = new AbortController()
  const completed = watch(watchPath, debounceSeconds, {
    ...options,
    signal: controller.signal,
  })
  const initialRebuilt = rebuildCode(watchPath, {
    ...(options.followSymlinks !== undefined ? { followSymlinks: options.followSymlinks } : {}),
    ...(options.respectGitignore !== undefined ? { respectGitignore: options.respectGitignore } : {}),
    ...(options.noHtml !== undefined ? { noHtml: options.noHtml } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  })

  return {
    initialRebuilt,
    stop: () => controller.abort(),
    completed,
  }
}

export async function watch(watchPath: string, debounce = 3, options: WatchOptions = {}): Promise<void> {
  const resolvedWatchPath = resolveWatchPath(watchPath)
  const output = defaultLogger(options.logger)
  const debounceMs = Math.max(0, Math.round(debounce * 1000))
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 250)
  const runRebuild = options.rebuildCode ?? rebuildCode
  const runNotify = options.notifyOnly ?? notifyOnly
  const loopSignal = createWatchLoopSignal(pollIntervalMs)
  const respectGitignore = options.respectGitignore ?? false
  const gitVisibilityCache = respectGitignore ? { visibleFiles: null, expiresAt: 0 } : undefined
  const eventWatcher = startEventWatcher(resolvedWatchPath, () => {
    if (gitVisibilityCache) {
      gitVisibilityCache.expiresAt = 0
    }
    loopSignal.wake()
  })

  try {
    let previousSnapshot = snapshotWatchedFiles(resolvedWatchPath, options.followSymlinks ?? false, respectGitignore, gitVisibilityCache)
    let pending = false
    let lastTriggerAt = 0
    const changed = new Set<string>()

    output.log(`[madar watch] Watching ${resolvedWatchPath} - abort the process to stop`)
    output.log(
      '[madar watch] Supported code, docs, papers, images, local audio/video, and office documents rebuild automatically; manual refresh is only needed for unsupported future formats.',
    )
    output.log(`[madar watch] Debounce: ${debounce}s`)
    if (eventWatcher) {
      output.log('[madar watch] Filesystem events enabled with polling fallback.')
    }

    while (!options.signal?.aborted) {
      await loopSignal.wait(options.signal)
      if (options.signal?.aborted) {
        break
      }

      const nextSnapshot = snapshotWatchedFiles(resolvedWatchPath, options.followSymlinks ?? false, respectGitignore, gitVisibilityCache)
      const changedBatch = diffSnapshots(previousSnapshot, nextSnapshot)
      previousSnapshot = nextSnapshot

      if (changedBatch.length > 0) {
        pending = true
        lastTriggerAt = Date.now()
        for (const filePath of changedBatch) {
          changed.add(filePath)
        }
      }

      if (pending && Date.now() - lastTriggerAt >= debounceMs) {
        pending = false
        const batch = [...changed].sort()
        changed.clear()

        output.log(`\n[madar watch] ${batch.length} file(s) changed`)
        const rebuildOptions: RebuildCodeOptions = {
          logger: output,
          ...(options.followSymlinks !== undefined ? { followSymlinks: options.followSymlinks } : {}),
          ...(options.respectGitignore !== undefined ? { respectGitignore: options.respectGitignore } : {}),
          ...(options.noHtml !== undefined ? { noHtml: options.noHtml } : {}),
        }
        const rebuilt = runRebuild(resolvedWatchPath, rebuildOptions)
        if (!rebuilt) {
          runNotify(resolvedWatchPath, output)
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    output.error(`[madar watch] Watch stopped: ${message}`)
  } finally {
    try {
      eventWatcher?.close()
    } catch {
      // Ignore watcher cleanup errors during shutdown.
    }
    if (options.signal?.aborted) {
      output.log('\n[madar watch] Stopped.')
    }
  }
}
