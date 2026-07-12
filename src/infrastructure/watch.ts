import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, watch as createFileSystemWatcher, writeFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

import { AUDIO_EXTENSIONS, CODE_EXTENSIONS, DOC_EXTENSIONS, IMAGE_EXTENSIONS, OFFICE_EXTENSIONS, PAPER_EXTENSIONS, VIDEO_EXTENSIONS } from '../pipeline/detect.js'
import { sidecarAwareFileFingerprint } from '../shared/binary-ingest-sidecar.js'
import { collectGitVisibleFiles } from '../shared/git.js'
import { generateGraph } from './generate.js'

export const WATCHED_EXTENSIONS = new Set([...CODE_EXTENSIONS, ...DOC_EXTENSIONS, ...PAPER_EXTENSIONS, ...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS, ...OFFICE_EXTENSIONS])
const MAX_SYMLINK_DEPTH = 40
const MAX_WATCHED_FILES = 10_000
const GIT_VISIBILITY_SNAPSHOT_KEY = '\0madar:git-visible-files'
const GIT_VISIBILITY_CACHE_DURATION_MS = 500

const WATCH_IGNORED_DIRECTORIES = new Set(['.git', 'out', 'node_modules', 'dist', 'build', 'target', 'venv', '.venv', 'env', '.env', '__pycache__'])

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

function gitignoreFingerprint(filePath: string, modifiedAt: number): string {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex')
  } catch {
    return String(Math.round(modifiedAt))
  }
}

function collectWatchedFiles(
  directory: string,
  followSymlinks: boolean,
  rootRealPath: string,
  ancestorRealPaths: string[],
  snapshots: Map<string, number | string>,
  includedFiles?: ReadonlySet<string>,
  watchGitignore = false,
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
    const isGitignore = watchGitignore && entry === '.gitignore'
    if (entry.startsWith('.') && !isGitignore) {
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
      collectWatchedFiles(entryPath, followSymlinks, rootRealPath, ancestorRealPaths, snapshots, includedFiles, watchGitignore, depth + 1)
      continue
    }

    if (isGitignore && stats.isFile()) {
      snapshots.set(entryPath, gitignoreFingerprint(entryPath, stats.mtimeMs))
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
        collectWatchedFiles(entryPath, followSymlinks, rootRealPath, [...ancestorRealPaths, realTarget], snapshots, includedFiles, watchGitignore, depth + 1)
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
    if (WATCHED_EXTENSIONS.has(extension) && (!includedFiles || includedFiles.has(entryPath))) {
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
  collectWatchedFiles(resolvedWatchPath, followSymlinks, rootRealPath, [rootRealPath], snapshots, includedFiles, visibleFiles !== null)
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
  const flagPath = join(resolvedWatchPath, 'out', 'needs_update')
  const output = defaultLogger(logger)
  mkdirSync(join(resolvedWatchPath, 'out'), { recursive: true })
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
  const graphOutputDir = join(resolvedWatchPath, 'out')
  const manifestPath = join(graphOutputDir, 'manifest.json')
  const graphPath = join(graphOutputDir, 'graph.json')

  try {
    const result = generateGraph(resolvedWatchPath, {
      ...(existsSync(manifestPath) && existsSync(graphPath) ? { update: true } : {}),
      ...(options.followSymlinks !== undefined ? { followSymlinks: options.followSymlinks } : {}),
      ...(options.respectGitignore !== undefined ? { respectGitignore: options.respectGitignore } : {}),
      ...(options.noHtml !== undefined ? { noHtml: options.noHtml } : {}),
    })

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
