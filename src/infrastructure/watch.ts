import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, watch as createFileSystemWatcher, writeFileSync } from 'node:fs'
import { basename, extname, join, relative, resolve, sep } from 'node:path'

import type { IndexingStrictThresholds } from '../contracts/indexing.js'
import type { WatcherEventMode, WatcherStateV1 } from '../contracts/watcher-state.js'
import {
  AUDIO_EXTENSIONS,
  CODE_EXTENSIONS,
  DOC_EXTENSIONS,
  IMAGE_EXTENSIONS,
  OFFICE_EXTENSIONS,
  PAPER_EXTENSIONS,
  UNSUPPORTED_SOURCE_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from '../pipeline/detect.js'
import { EXTRACTOR_CACHE_VERSION } from '../pipeline/extract.js'
import { analyzeGraphContextFreshness } from '../runtime/freshness.js'
import { readIndexingManifestForGraph } from './indexing-manifest.js'
import { sidecarAwareFileFingerprint } from '../shared/binary-ingest-sidecar.js'
import { collectGitVisibleFiles } from '../shared/git.js'
import { isDiscoveryPathIgnored, loadMadarignorePatterns } from '../shared/source-discovery.js'
import { resolveMadarOutputDirectory } from '../shared/workspace.js'
import { loadGraphArtifact } from '../adapters/filesystem/graph-artifact.js'
import { generateGraph, type GenerateGraphOptions, type GenerateGraphResult } from './generate.js'
import {
  buildGenerationPolicy,
  generationOptionsFromPolicy,
  readGraphGenerationPolicy,
  readStoredGenerationPolicy,
} from './generation-policy.js'
import { createWatcherState, writeWatcherState } from './watcher-state.js'
import {
  acquireRefreshLease,
  acquireRefreshLeaseWithoutBlocking,
  tryAcquireRefreshLease,
} from './refresh-lease.js'

export const WATCHED_EXTENSIONS = new Set([
  ...CODE_EXTENSIONS,
  ...DOC_EXTENSIONS,
  ...PAPER_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...OFFICE_EXTENSIONS,
  ...UNSUPPORTED_SOURCE_EXTENSIONS,
])
const MAX_SYMLINK_DEPTH = 40
const GIT_VISIBILITY_SNAPSHOT_KEY = '\0madar:git-visible-files'
const GIT_VISIBILITY_CACHE_DURATION_MS = 500
const DEFAULT_EVENT_RECONCILIATION_INTERVAL_MS = 30_000
const DEFAULT_EVENT_MAX_RECONCILIATION_INTERVAL_MS = 5 * 60_000
const DEFAULT_POLL_RECONCILIATION_INTERVAL_MS = 1_000
const DEFAULT_POLL_MAX_RECONCILIATION_INTERVAL_MS = 30_000
const DEFAULT_RECONCILIATION_TIMEOUT_MS = 2 * 60_000
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
// Madar writes these root-level instruction files when an agent integration is
// installed. They guide the agent, rather than describe the indexed codebase,
// so their creation or edits must not force the first MCP request to wait for
// a graph reconciliation.
const MANAGED_AGENT_INSTRUCTION_FILENAMES = new Set(['AGENTS.md', 'CLAUDE.md'])

function isRootManagedAgentInstructionFile(discoveryRoot: string, filePath: string): boolean {
  return MANAGED_AGENT_INSTRUCTION_FILENAMES.has(relative(discoveryRoot, filePath).replaceAll('\\', '/'))
}

export interface WatchLogger {
  log(message?: string): void
  error(message?: string): void
}

export interface RebuildCodeOptions {
  followSymlinks?: boolean
  respectGitignore?: boolean
  indexingStrict?: IndexingStrictThresholds
  logger?: WatchLogger
}

export interface WatchReconciliationMetrics {
  trigger: 'initial' | 'event' | 'periodic' | 'post-rebuild'
  durationMs: number
  fileCount: number
  directoryCount: number
  changedCount: number
  eventMode: WatcherEventMode
  nextIntervalMs: number
}

export interface WatchOptions extends RebuildCodeOptions {
  signal?: AbortSignal
  /** Initial authoritative reconciliation interval; retained for CLI/test compatibility. */
  pollIntervalMs?: number
  maxPollIntervalMs?: number
  reconciliationTimeoutMs?: number
  rebuildCode?: (watchPath: string, options?: RebuildCodeOptions) => boolean | null | Promise<boolean | null>
  notifyOnly?: (watchPath: string, logger?: WatchLogger) => void
  onReconciliation?: (metrics: WatchReconciliationMetrics) => void
  /** Internal auto-refresh handshake: listener + snapshot are active before this rebuild starts. */
  rebuildOnStart?: boolean
  onInitialRebuild?: (rebuilt: boolean) => void
}

export interface GraphAutoRefreshController {
  /** Whether the initial incremental reconciliation produced a graph. */
  initialRebuilt: boolean
  /** Background controllers remain false until their initial reconciliation has settled. */
  startupComplete?(): boolean
  /** Returns a background startup/runtime failure that could not be read from watcher-state.json. */
  failureReason?(): string | null
  /** Resolves after the initial reconciliation succeeds, fails, or is aborted. */
  startupSettled?: Promise<void>
  /** Stops the watcher and releases its filesystem resources. */
  stop(): void
  /** Resolves once the watcher stops. */
  completed: Promise<void>
}

interface WatchLoopSignal {
  wait(delayMs: number, signal?: AbortSignal): Promise<void>
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

function createWatchLoopSignal(): WatchLoopSignal {
  let wakePending = false
  let wakeResolver: (() => void) | null = null

  return {
    wait(delayMs: number, signal?: AbortSignal): Promise<void> {
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
        timer = setTimeout(finish, Math.max(0, delayMs))
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

function startEventWatcher(
  watchPath: string,
  onEvent: () => void,
  onError: () => void,
  ignoreEvent: (filename: string | Buffer | null) => boolean,
): { close(): void } | null {
  try {
    const watcher = createFileSystemWatcher(watchPath, { recursive: true, persistent: false }, (_eventType, filename) => {
      if (!ignoreEvent(filename)) {
        onEvent()
      }
    })
    watcher.on('error', () => {
      onError()
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
  const rootPath = loadGraphArtifact(graphPath).graph.root_path
  return typeof rootPath === 'string'
    && rootPath.trim().length > 0
    && sameFilesystemPath(rootPath, workspaceRoot)
}

function canReuseFreshGraphOnStart(
  workspaceRoot: string,
  outputDir: string,
  state: WatcherStateV1,
  currentSnapshot: WatchSnapshot,
): boolean {
  const graphPath = join(outputDir, 'graph.json')
  const manifestPath = join(outputDir, 'manifest.json')
  if (
    !existsSync(graphPath)
    || !existsSync(manifestPath)
    || existsSync(join(outputDir, 'needs_update'))
  ) {
    return false
  }
  if (!graphBelongsToWorkspace(graphPath, workspaceRoot)) {
    return false
  }
  if (state.policy_match !== true) {
    return false
  }

  try {
    const freshness = analyzeGraphContextFreshness(graphPath)
    if (freshness.status !== 'fresh' || freshness.generated_ms === null) {
      return false
    }

    const indexingManifest = readIndexingManifestForGraph(graphPath)
    if (!indexingManifest) {
      return false
    }
    const persistedCandidates = new Set(
      indexingManifest.outcomes
        .filter((outcome) => outcome.kind === 'file')
        .map((outcome) => outcome.path.replaceAll('\\', '/').replace(/^\.\//, '')),
    )
    const currentCandidates = new Set<string>()
    for (const filePath of currentSnapshot.fingerprints.keys()) {
      if (filePath === GIT_VISIBILITY_SNAPSHOT_KEY) {
        continue
      }
      if (isRootManagedAgentInstructionFile(workspaceRoot, filePath)) {
        continue
      }
      if (WATCHED_CONTROL_FILENAMES.has(basename(filePath))) {
        if (lstatSync(filePath).mtimeMs > freshness.generated_ms) {
          return false
        }
        continue
      }
      if (!WATCHED_EXTENSIONS.has(extname(filePath).toLowerCase())) {
        continue
      }
      const localPath = relative(workspaceRoot, filePath).replaceAll('\\', '/')
      if (localPath === '' || localPath === '..' || localPath.startsWith('../')) {
        return false
      }
      currentCandidates.add(localPath)
      if (!persistedCandidates.has(localPath)) {
        return false
      }
    }
    for (const outcome of indexingManifest.outcomes) {
      const localPath = outcome.path.replaceAll('\\', '/').replace(/^\.\//, '')
      if (
        outcome.kind === 'file'
        && outcome.status !== 'skipped_by_policy'
        && WATCHED_EXTENSIONS.has(extname(localPath).toLowerCase())
        && !MANAGED_AGENT_INSTRUCTION_FILENAMES.has(localPath)
        && !currentCandidates.has(localPath)
      ) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

class WatchCoverageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WatchCoverageError'
  }
}

interface SnapshotCollection {
  fingerprints: Map<string, number | string>
  directoryCount: number
  startedAt: number
  timeoutMs: number
}

export interface WatchSnapshot {
  fingerprints: Map<string, number | string>
  fileCount: number
  directoryCount: number
  durationMs: number
}

function assertReconciliationWithinDeadline(collection: SnapshotCollection): void {
  if (Date.now() - collection.startedAt > collection.timeoutMs) {
    throw new WatchCoverageError(
      `Authoritative watcher reconciliation exceeded ${collection.timeoutMs}ms; graph freshness cannot be guaranteed.`,
    )
  }
}

function collectWatchedFiles(
  directory: string,
  followSymlinks: boolean,
  discoveryRoot: string,
  discoveryIgnorePatterns: readonly string[],
  rootRealPath: string,
  ancestorRealPaths: string[],
  collection: SnapshotCollection,
  includedFiles?: ReadonlySet<string>,
  symlinkDepth = 0,
): void {
  assertReconciliationWithinDeadline(collection)
  if (symlinkDepth > MAX_SYMLINK_DEPTH) {
    throw new WatchCoverageError(
      `Watcher symlink traversal exceeded ${MAX_SYMLINK_DEPTH} levels at ${directory}; graph freshness cannot be guaranteed.`,
    )
  }

  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
    collection.directoryCount += 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new WatchCoverageError(`Unable to reconcile watched directory ${directory}: ${message}`)
  }

  for (const entry of entries) {
    assertReconciliationWithinDeadline(collection)
    const isControlFile = WATCHED_CONTROL_FILENAMES.has(entry.name)
    const entryPath = resolve(directory, entry.name)
    if (isRootManagedAgentInstructionFile(discoveryRoot, entryPath)) {
      continue
    }
    if (entry.name.startsWith('.') && !isControlFile) {
      continue
    }
    if (WATCH_IGNORED_DIRECTORIES.has(entry.name)) {
      continue
    }
    if (!isControlFile && isDiscoveryPathIgnored(entryPath, discoveryRoot, discoveryIgnorePatterns)) {
      continue
    }

    if (entry.isDirectory()) {
      collectWatchedFiles(
        entryPath,
        followSymlinks,
        discoveryRoot,
        discoveryIgnorePatterns,
        rootRealPath,
        ancestorRealPaths,
        collection,
        includedFiles,
        symlinkDepth,
      )
      continue
    }

    if (entry.isSymbolicLink()) {
      if (!followSymlinks) {
        continue
      }

      let realTarget: string
      try {
        realTarget = realpathSync(entryPath)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new WatchCoverageError(`Unable to resolve watched symlink ${entryPath}: ${message}`)
      }

      if (ancestorRealPaths.includes(realTarget) || !isWithinRoot(rootRealPath, realTarget)) {
        continue
      }

      let targetStats
      try {
        targetStats = statSync(realTarget)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new WatchCoverageError(`Unable to stat watched symlink target ${entryPath}: ${message}`)
      }

      if (targetStats.isDirectory()) {
        collectWatchedFiles(
          entryPath,
          followSymlinks,
          discoveryRoot,
          discoveryIgnorePatterns,
          rootRealPath,
          [...ancestorRealPaths, realTarget],
          collection,
          includedFiles,
          symlinkDepth + 1,
        )
        continue
      }

      if (!targetStats.isFile()) {
        continue
      }

      const extension = extname(entryPath).toLowerCase()
      if (WATCHED_EXTENSIONS.has(extension) && (!includedFiles || includedFiles.has(entryPath))) {
        collection.fingerprints.set(entryPath, sidecarAwareFileFingerprint(entryPath, targetStats.mtimeMs))
      }
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    const extension = extname(entryPath).toLowerCase()
    if ((WATCHED_EXTENSIONS.has(extension) || isControlFile) && (!includedFiles || includedFiles.has(entryPath) || isControlFile)) {
      let modifiedAt: number
      try {
        modifiedAt = lstatSync(entryPath).mtimeMs
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new WatchCoverageError(`Unable to stat watched file ${entryPath}: ${message}`)
      }
      collection.fingerprints.set(
        entryPath,
        isControlFile ? controlFileFingerprint(entryPath, modifiedAt) : sidecarAwareFileFingerprint(entryPath, modifiedAt),
      )
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

export function snapshotWatchedFiles(
  watchPath: string,
  followSymlinks: boolean,
  respectGitignore = false,
  gitVisibilityCache?: GitVisibilityCache,
  timeoutMs = DEFAULT_RECONCILIATION_TIMEOUT_MS,
): WatchSnapshot {
  const resolvedWatchPath = resolveWatchPath(watchPath)
  const startedAt = Date.now()
  const collection: SnapshotCollection = {
    fingerprints: new Map<string, number | string>(),
    directoryCount: 0,
    startedAt,
    timeoutMs: Math.max(1, timeoutMs),
  }

  let rootRealPath = resolvedWatchPath
  try {
    rootRealPath = realpathSync(resolvedWatchPath)
  } catch {
    rootRealPath = resolvedWatchPath
  }

  const visibleFiles = respectGitignore ? readGitVisibleFiles(resolvedWatchPath, gitVisibilityCache) : null
  const includedFiles = visibleFiles === null ? undefined : new Set(visibleFiles)
  const discoveryIgnorePatterns = loadMadarignorePatterns(resolvedWatchPath)
  collectWatchedFiles(
    resolvedWatchPath,
    followSymlinks,
    resolvedWatchPath,
    discoveryIgnorePatterns,
    rootRealPath,
    [rootRealPath],
    collection,
    includedFiles,
  )
  if (visibleFiles !== null) {
    const visibilityFingerprint = createHash('sha256').update([...visibleFiles].sort().join('\0')).digest('hex')
    collection.fingerprints.set(GIT_VISIBILITY_SNAPSHOT_KEY, visibilityFingerprint)
  }
  return {
    fingerprints: collection.fingerprints,
    fileCount: [...collection.fingerprints.keys()].filter((path) => path !== GIT_VISIBILITY_SNAPSHOT_KEY).length,
    directoryCount: collection.directoryCount,
    durationMs: Date.now() - startedAt,
  }
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

function rebuildCodeUnderLease(
  resolvedWatchPath: string,
  options: RebuildCodeOptions,
  releaseLease: () => void,
): boolean {
  const output = defaultLogger(options.logger)
  const graphOutputDir = resolveMadarOutputDirectory(resolvedWatchPath)
  const manifestPath = join(graphOutputDir, 'manifest.json')
  const graphPath = join(graphOutputDir, 'graph.json')

  try {
    const canUpdate = existsSync(manifestPath)
      && existsSync(graphPath)
      && graphBelongsToWorkspace(graphPath, resolvedWatchPath)
    const graphPolicy = canUpdate ? readGraphGenerationPolicy(graphPath) : null
    if (canUpdate && !graphPolicy) {
      throw new Error(
        'Existing graph has no valid generation-policy metadata. Run `madar generate . --update` once to migrate it before enabling auto-refresh.',
      )
    }
    const policyOptions: GenerateGraphOptions = graphPolicy
      ? generationOptionsFromPolicy(graphPolicy)
      : { extractionMode: 'auto' }
    const result: GenerateGraphResult = generateGraph(resolvedWatchPath, {
      ...policyOptions,
      ...(canUpdate ? { update: true } : {}),
      ...(options.followSymlinks !== undefined ? { followSymlinks: options.followSymlinks } : {}),
      ...(options.respectGitignore !== undefined ? { respectGitignore: options.respectGitignore } : {}),
      ...(options.indexingStrict ? { indexingStrict: options.indexingStrict } : {}),
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
  } finally {
    releaseLease()
  }
}

export function rebuildCode(watchPath: string, options: RebuildCodeOptions = {}): boolean {
  const resolvedWatchPath = resolveWatchPath(watchPath)
  const output = defaultLogger(options.logger)
  const graphOutputDir = resolveMadarOutputDirectory(resolvedWatchPath)
  try {
    return rebuildCodeUnderLease(resolvedWatchPath, options, acquireRefreshLease(graphOutputDir))
  } catch (error) {
    output.error(`[madar watch] Rebuild failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

function rebuildCodeWithRecoverableLease(
  watchPath: string,
  options: RebuildCodeOptions = {},
  signal?: AbortSignal,
): boolean | Promise<boolean | null> {
  const resolvedWatchPath = resolveWatchPath(watchPath)
  const output = defaultLogger(options.logger)
  const graphOutputDir = resolveMadarOutputDirectory(resolvedWatchPath)
  const immediateLease = tryAcquireRefreshLease(graphOutputDir)
  if (immediateLease) {
    return rebuildCodeUnderLease(resolvedWatchPath, options, immediateLease)
  }

  return acquireRefreshLeaseWithoutBlocking(graphOutputDir, {
    ...(signal ? { signal } : {}),
  })
    .then((releaseLease) => releaseLease
      ? rebuildCodeUnderLease(resolvedWatchPath, options, releaseLease)
      : null)
    .catch((error: unknown) => {
      output.error(`[madar watch] Rebuild failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    })
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
  let initialRebuilt = false
  let startupComplete = false
  let resolveStartupSettled!: () => void
  const startupSettled = new Promise<void>((resolvePromise) => {
    resolveStartupSettled = resolvePromise
  })
  function settleStartup(): void {
    if (startupComplete) {
      return
    }
    startupComplete = true
    resolveStartupSettled()
  }
  const completed = watch(watchPath, debounceSeconds, {
    ...options,
    signal: controller.signal,
    rebuildOnStart: true,
    onInitialRebuild: (rebuilt) => {
      initialRebuilt = rebuilt
      settleStartup()
      options.onInitialRebuild?.(rebuilt)
    },
  })
  void completed.then(settleStartup, settleStartup)

  return {
    get initialRebuilt() {
      return initialRebuilt
    },
    startupComplete: () => startupComplete,
    startupSettled,
    stop: () => controller.abort(),
    completed,
  }
}

function rebuildOptionsFromWatch(options: WatchOptions, logger: WatchLogger): RebuildCodeOptions {
  return {
    logger,
    ...(options.followSymlinks !== undefined ? { followSymlinks: options.followSymlinks } : {}),
    ...(options.respectGitignore !== undefined ? { respectGitignore: options.respectGitignore } : {}),
    ...(options.indexingStrict ? { indexingStrict: options.indexingStrict } : {}),
  }
}

function updateWatcherPolicyState(
  state: WatcherStateV1,
  watchPath: string,
  options: WatchOptions,
  gitVisibilityCache?: GitVisibilityCache,
): void {
  const outputDir = resolveMadarOutputDirectory(watchPath)
  const graphPath = join(outputDir, 'graph.json')
  const manifestPath = join(outputDir, 'manifest.json')
  const storedPolicy = readStoredGenerationPolicy(graphPath, manifestPath)
  const graphPolicy = readGraphGenerationPolicy(graphPath)
  const indexingManifest = readIndexingManifestForGraph(graphPath)
  state.stored_policy_fingerprint = graphPolicy?.fingerprint ?? null
  state.requested_extraction_mode = graphPolicy
    ? generationOptionsFromPolicy(graphPolicy).extractionMode
    : null
  state.extraction_strategy_buckets = indexingManifest?.summary.extraction_strategy_buckets ?? null

  if (!storedPolicy) {
    state.current_policy_fingerprint = null
    state.policy_match = existsSync(graphPath) ? false : null
    return
  }

  const storedOptions = generationOptionsFromPolicy(storedPolicy)
  const effectiveOptions = {
    ...storedOptions,
    ...(options.followSymlinks !== undefined ? { followSymlinks: options.followSymlinks } : {}),
    ...(options.respectGitignore !== undefined ? { respectGitignore: options.respectGitignore } : {}),
    ...(options.indexingStrict ? { indexingStrict: options.indexingStrict } : {}),
  }
  const gitVisibleFiles = effectiveOptions.respectGitignore
    ? readGitVisibleFiles(watchPath, gitVisibilityCache)
    : null
  const currentPolicy = buildGenerationPolicy(watchPath, effectiveOptions, EXTRACTOR_CACHE_VERSION, gitVisibleFiles)
  state.current_policy_fingerprint = currentPolicy.fingerprint
  state.policy_match = storedPolicy.fingerprint === currentPolicy.fingerprint
}

function recordSuccessfulReconciliation(
  state: WatcherStateV1,
  snapshot: WatchSnapshot,
  intervalMs: number,
  nextReconciliationAt: number,
): void {
  state.coverage = 'complete'
  state.reconciliation_count += 1
  state.last_reconciliation_at = new Date().toISOString()
  state.last_reconciliation_duration_ms = snapshot.durationMs
  state.last_reconciliation_file_count = snapshot.fileCount
  state.last_reconciliation_directory_count = snapshot.directoryCount
  state.current_interval_ms = intervalMs
  state.next_reconciliation_at = new Date(nextReconciliationAt).toISOString()
  state.failure_reason = null
}

export async function watch(watchPath: string, debounce = 3, options: WatchOptions = {}): Promise<void> {
  const resolvedWatchPath = resolveWatchPath(watchPath)
  const outputDir = resolveMadarOutputDirectory(resolvedWatchPath)
  const output = defaultLogger(options.logger)
  const debounceMs = Math.max(0, Math.round(debounce * 1000))
  const runInitialRebuild = options.rebuildCode
    ?? ((target: string, rebuildOptions?: RebuildCodeOptions) => rebuildCodeWithRecoverableLease(target, rebuildOptions, options.signal))
  const runWatchedRebuild = runInitialRebuild
  const runNotify = options.notifyOnly ?? notifyOnly
  const loopSignal = createWatchLoopSignal()
  const initialStoredPolicy = readStoredGenerationPolicy(
    join(outputDir, 'graph.json'),
    join(outputDir, 'manifest.json'),
  )
  let activeStoredPolicyFingerprint = initialStoredPolicy?.fingerprint ?? null
  let storedWatchOptions = initialStoredPolicy ? generationOptionsFromPolicy(initialStoredPolicy) : null
  let respectGitignore = options.respectGitignore ?? storedWatchOptions?.respectGitignore ?? false
  let followSymlinks = options.followSymlinks ?? storedWatchOptions?.followSymlinks ?? false
  let gitVisibilityCache: GitVisibilityCache | undefined = respectGitignore ? { visibleFiles: null, expiresAt: 0 } : undefined
  const reconciliationTimeoutMs = Math.max(1, options.reconciliationTimeoutMs ?? DEFAULT_RECONCILIATION_TIMEOUT_MS)
  let state: WatcherStateV1 | null = null
  let eventDirty = false
  let eventWatcher: { close(): void } | null = null
  let eventMode: WatcherEventMode = 'polling'
  let minimumIntervalMs = Math.max(10, options.pollIntervalMs ?? DEFAULT_POLL_RECONCILIATION_INTERVAL_MS)
  let maximumIntervalMs = Math.max(
    minimumIntervalMs,
    options.maxPollIntervalMs ?? (options.pollIntervalMs === undefined ? DEFAULT_POLL_MAX_RECONCILIATION_INTERVAL_MS : minimumIntervalMs * 16),
  )

  function persistState(): void {
    if (state) {
      writeWatcherState(outputDir, state)
    }
  }

  function refreshWatchDiscoveryPolicy(): void {
    const storedPolicy = readStoredGenerationPolicy(
      join(outputDir, 'graph.json'),
      join(outputDir, 'manifest.json'),
    )
    if (!storedPolicy || storedPolicy.fingerprint === activeStoredPolicyFingerprint) {
      return
    }
    storedWatchOptions = generationOptionsFromPolicy(storedPolicy)
    activeStoredPolicyFingerprint = storedPolicy.fingerprint
    const nextRespectGitignore = options.respectGitignore ?? storedWatchOptions.respectGitignore
    followSymlinks = options.followSymlinks ?? storedWatchOptions.followSymlinks
    if (nextRespectGitignore !== respectGitignore) {
      respectGitignore = nextRespectGitignore
      gitVisibilityCache = respectGitignore ? { visibleFiles: null, expiresAt: 0 } : undefined
    } else if (gitVisibilityCache) {
      gitVisibilityCache.expiresAt = 0
    }
  }

  function markPending(): void {
    if (gitVisibilityCache) {
      gitVisibilityCache.expiresAt = 0
    }
    eventDirty = true
    if (state && state.status !== 'failed') {
      state.status = 'pending'
      state.pending_since ??= new Date().toISOString()
      state.next_reconciliation_at = new Date().toISOString()
      persistState()
    }
    loopSignal.wake()
  }

  function fallBackToPolling(): void {
    try {
      eventWatcher?.close()
    } catch {
      // The watcher is already unusable.
    }
    eventWatcher = null
    eventMode = 'polling'
    minimumIntervalMs = Math.max(10, options.pollIntervalMs ?? DEFAULT_POLL_RECONCILIATION_INTERVAL_MS)
    maximumIntervalMs = Math.max(
      minimumIntervalMs,
      options.maxPollIntervalMs ?? (options.pollIntervalMs === undefined ? DEFAULT_POLL_MAX_RECONCILIATION_INTERVAL_MS : minimumIntervalMs * 16),
    )
    if (state) {
      state.event_mode = eventMode
      state.current_interval_ms = minimumIntervalMs
    }
    markPending()
  }

  const eventIgnoredDirectories = new Set([...WATCH_IGNORED_DIRECTORIES].filter((name) => name !== '.git'))
  eventWatcher = startEventWatcher(resolvedWatchPath, markPending, fallBackToPolling, (filename) => {
    if (filename === null) {
      return false
    }
    const normalized = filename.toString().replaceAll('\\', '/').replace(/^\.\//, '')
    if (MANAGED_AGENT_INSTRUCTION_FILENAMES.has(normalized)) {
      return true
    }
    const [topLevel] = normalized.split('/')
    return topLevel !== undefined && eventIgnoredDirectories.has(topLevel)
  })
  if (eventWatcher) {
    eventMode = 'recursive-events'
    minimumIntervalMs = Math.max(10, options.pollIntervalMs ?? DEFAULT_EVENT_RECONCILIATION_INTERVAL_MS)
    maximumIntervalMs = Math.max(
      minimumIntervalMs,
      options.maxPollIntervalMs ?? (options.pollIntervalMs === undefined ? DEFAULT_EVENT_MAX_RECONCILIATION_INTERVAL_MS : minimumIntervalMs * 16),
    )
  }
  state = createWatcherState(eventMode, minimumIntervalMs)
  persistState()

  try {
    let currentIntervalMs = minimumIntervalMs
    let previousSnapshot = snapshotWatchedFiles(
      resolvedWatchPath,
      followSymlinks,
      respectGitignore,
      gitVisibilityCache,
      reconciliationTimeoutMs,
    )
    let nextReconciliationAt = Date.now() + currentIntervalMs
    recordSuccessfulReconciliation(state, previousSnapshot, currentIntervalMs, nextReconciliationAt)
    updateWatcherPolicyState(state, resolvedWatchPath, options, gitVisibilityCache)
    state.status = eventDirty || state.policy_match === false ? 'pending' : 'idle'
    state.pending_since = eventDirty || state.policy_match === false ? new Date().toISOString() : null
    persistState()
    options.onReconciliation?.({
      trigger: 'initial',
      durationMs: previousSnapshot.durationMs,
      fileCount: previousSnapshot.fileCount,
      directoryCount: previousSnapshot.directoryCount,
      changedCount: 0,
      eventMode,
      nextIntervalMs: currentIntervalMs,
    })

    let pending = false
    let lastTriggerAt = 0
    const changed = new Set<string>()

    if (state.policy_match === false) {
      pending = true
      lastTriggerAt = Date.now()
      changed.add('\0madar:generation-policy')
    }

    output.log(`[madar watch] Watching ${resolvedWatchPath} - abort the process to stop`)
    output.log(
      '[madar watch] Supported candidates rebuild automatically, and known unsupported source formats refresh indexing completeness; manual refresh is only needed for unknown future formats.',
    )
    output.log(`[madar watch] Debounce: ${debounce}s; reconciliation: ${currentIntervalMs}ms adaptive`)
    if (eventWatcher) {
      output.log('[madar watch] Filesystem events enabled with authoritative adaptive reconciliation fallback.')
    } else {
      output.log('[madar watch] Recursive filesystem events unavailable; adaptive polling is authoritative.')
    }

    if (options.rebuildOnStart && canReuseFreshGraphOnStart(resolvedWatchPath, outputDir, state, previousSnapshot)) {
      options.onInitialRebuild?.(false)
    } else if (options.rebuildOnStart) {
      state.status = 'reconciling'
      persistState()
      const initialRebuild = runInitialRebuild(resolvedWatchPath, rebuildOptionsFromWatch(options, output))
      const rebuilt = typeof initialRebuild === 'boolean' || initialRebuild === null
        ? initialRebuild
        : await initialRebuild
      if (rebuilt === null) {
        if (!options.signal?.aborted) {
          throw new Error('Initial refresh lease wait ended without an abort signal.')
        }
        return
      }
      options.onInitialRebuild?.(rebuilt)
      if (!rebuilt) {
        state.status = 'failed'
        state.failure_reason = 'Initial graph reconciliation failed; inspect watcher logs and run `madar generate . --update`.'
        state.policy_match = state.stored_policy_fingerprint === null ? false : state.policy_match
        persistState()
        runNotify(resolvedWatchPath, output)
        return
      }
      refreshWatchDiscoveryPolicy()
      updateWatcherPolicyState(state, resolvedWatchPath, options, gitVisibilityCache)
      if (state.policy_match === false) {
        state.status = 'failed'
        state.failure_reason = 'Generation policy still mismatches after initial rebuild.'
        persistState()
        return
      }
      pending = false
      changed.clear()
      const postBuildSnapshot = snapshotWatchedFiles(
        resolvedWatchPath,
        followSymlinks,
        respectGitignore,
        gitVisibilityCache,
        reconciliationTimeoutMs,
      )
      const postBuildChanges = diffSnapshots(previousSnapshot.fingerprints, postBuildSnapshot.fingerprints)
      previousSnapshot = postBuildSnapshot
      currentIntervalMs = postBuildChanges.length > 0 ? minimumIntervalMs : currentIntervalMs
      nextReconciliationAt = Date.now() + currentIntervalMs
      recordSuccessfulReconciliation(state, postBuildSnapshot, currentIntervalMs, nextReconciliationAt)
      options.onReconciliation?.({
        trigger: 'post-rebuild',
        durationMs: postBuildSnapshot.durationMs,
        fileCount: postBuildSnapshot.fileCount,
        directoryCount: postBuildSnapshot.directoryCount,
        changedCount: postBuildChanges.length,
        eventMode,
        nextIntervalMs: currentIntervalMs,
      })
      if (postBuildChanges.length > 0) {
        pending = true
        lastTriggerAt = Date.now()
        for (const filePath of postBuildChanges) {
          changed.add(filePath)
        }
      }
      state.status = eventDirty || pending ? 'pending' : 'idle'
      state.pending_since = eventDirty || pending ? (state.pending_since ?? new Date().toISOString()) : null
      persistState()
    }

    while (!options.signal?.aborted) {
      const now = Date.now()
      const rebuildAt = pending ? lastTriggerAt + debounceMs : Number.POSITIVE_INFINITY
      const reconcileAt = eventDirty ? now : nextReconciliationAt
      const nextActionAt = Math.min(rebuildAt, reconcileAt)
      await loopSignal.wait(Number.isFinite(nextActionAt) ? Math.max(0, nextActionAt - now) : currentIntervalMs, options.signal)
      if (options.signal?.aborted) {
        break
      }

      const actionAt = Date.now()
      if (eventDirty || actionAt >= nextReconciliationAt) {
        const trigger: WatchReconciliationMetrics['trigger'] = eventDirty ? 'event' : 'periodic'
        eventDirty = false
        state.status = 'reconciling'
        persistState()
        refreshWatchDiscoveryPolicy()

        const nextSnapshot = snapshotWatchedFiles(
          resolvedWatchPath,
          followSymlinks,
          respectGitignore,
          gitVisibilityCache,
          reconciliationTimeoutMs,
        )
        const changedBatch = diffSnapshots(previousSnapshot.fingerprints, nextSnapshot.fingerprints)
        previousSnapshot = nextSnapshot
        currentIntervalMs = changedBatch.length > 0
          ? minimumIntervalMs
          : Math.min(maximumIntervalMs, Math.max(minimumIntervalMs, currentIntervalMs * 2))
        nextReconciliationAt = Date.now() + currentIntervalMs
        recordSuccessfulReconciliation(state, nextSnapshot, currentIntervalMs, nextReconciliationAt)
        updateWatcherPolicyState(state, resolvedWatchPath, options, gitVisibilityCache)

        if (changedBatch.length > 0 || state.policy_match === false) {
          pending = true
          lastTriggerAt = Date.now()
          for (const filePath of changedBatch) {
            changed.add(filePath)
          }
          if (state.policy_match === false) {
            changed.add('\0madar:generation-policy')
          }
          state.status = 'pending'
          state.pending_since ??= new Date().toISOString()
        } else if (pending) {
          state.status = 'pending'
        } else {
          state.status = 'idle'
          state.pending_since = null
        }
        persistState()
        options.onReconciliation?.({
          trigger,
          durationMs: nextSnapshot.durationMs,
          fileCount: nextSnapshot.fileCount,
          directoryCount: nextSnapshot.directoryCount,
          changedCount: changedBatch.length,
          eventMode,
          nextIntervalMs: currentIntervalMs,
        })
      }

      if (pending && Date.now() - lastTriggerAt >= debounceMs) {
        const batch = [...changed].sort()

        output.log(`\n[madar watch] ${batch.length} file(s) changed`)
        state.status = 'reconciling'
        persistState()
        const watchedRebuild = runWatchedRebuild(resolvedWatchPath, rebuildOptionsFromWatch(options, output))
        const rebuilt = typeof watchedRebuild === 'boolean' || watchedRebuild === null
          ? watchedRebuild
          : await watchedRebuild
        if (rebuilt === null && options.signal?.aborted) {
          break
        }
        if (!rebuilt) {
          state.status = 'failed'
          state.failure_reason = 'Automatic graph rebuild failed; the graph must not be treated as fresh.'
          persistState()
          runNotify(resolvedWatchPath, output)
          return
        }

        pending = false
        changed.clear()
        refreshWatchDiscoveryPolicy()
        updateWatcherPolicyState(state, resolvedWatchPath, options, gitVisibilityCache)
        if (state.policy_match === false) {
          state.status = 'failed'
          state.failure_reason = 'Generation policy still mismatches after automatic rebuild.'
          persistState()
          return
        }
        const postBuildSnapshot = snapshotWatchedFiles(
          resolvedWatchPath,
          followSymlinks,
          respectGitignore,
          gitVisibilityCache,
          reconciliationTimeoutMs,
        )
        const postBuildChanges = diffSnapshots(previousSnapshot.fingerprints, postBuildSnapshot.fingerprints)
        previousSnapshot = postBuildSnapshot
        currentIntervalMs = postBuildChanges.length > 0 ? minimumIntervalMs : currentIntervalMs
        nextReconciliationAt = Date.now() + currentIntervalMs
        recordSuccessfulReconciliation(state, postBuildSnapshot, currentIntervalMs, nextReconciliationAt)
        options.onReconciliation?.({
          trigger: 'post-rebuild',
          durationMs: postBuildSnapshot.durationMs,
          fileCount: postBuildSnapshot.fileCount,
          directoryCount: postBuildSnapshot.directoryCount,
          changedCount: postBuildChanges.length,
          eventMode,
          nextIntervalMs: currentIntervalMs,
        })
        if (postBuildChanges.length > 0) {
          pending = true
          lastTriggerAt = Date.now()
          for (const filePath of postBuildChanges) {
            changed.add(filePath)
          }
        }
        state.status = eventDirty || pending ? 'pending' : 'idle'
        state.pending_since = eventDirty || pending ? (state.pending_since ?? new Date().toISOString()) : null
        persistState()
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (state) {
      state.status = 'failed'
      state.coverage = 'failed'
      state.failure_reason = message
      state.next_reconciliation_at = null
      persistState()
    }
    output.error(`[madar watch] Watch stopped: ${message}`)
  } finally {
    try {
      eventWatcher?.close()
    } catch {
      // Ignore watcher cleanup errors during shutdown.
    }
    if (state && state.status !== 'failed') {
      state.status = 'stopped'
      state.next_reconciliation_at = null
      persistState()
    }
    if (options.signal?.aborted) {
      output.log('\n[madar watch] Stopped.')
    }
  }
}
