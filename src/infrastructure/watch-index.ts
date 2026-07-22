import { randomUUID } from 'node:crypto'
import { watch as watchFilesystem, type FSWatcher } from 'node:fs'
import { resolve } from 'node:path'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { updateIndex, type UpdateIndexOptions } from '../application/update-index.js'
import type { GenerateIndexResult } from '../application/generate-index.js'
import { releaseIndexLeaseOwner } from '../adapters/filesystem/index-store.js'
import { resolveMadarOutputDirectory } from '../shared/workspace.js'
const LEASE_RETRY_BASE_MS = 50
const LEASE_RETRY_MAX_MS = 2_000
const LEASE_RETRY_LIMIT = 12
export interface WatchIndexLogger {
  log(message?: string): void; error(message?: string): void
}
export type WatchIndexState = 'starting' | 'idle' | 'pending' | 'reconciling' | 'failed' | 'stopped'
export interface WatchIndexOptions extends UpdateIndexOptions {
  signal?: AbortSignal; pollIntervalMs?: number; seed?: Pick<GenerateIndexResult, 'buildId'>; logger?: WatchIndexLogger
  eventSource?: (root: string, changed: () => void) => { close(): void }
  update?: (...args: Parameters<typeof updateIndex>) => GenerateIndexResult | Promise<GenerateIndexResult>
}
export interface GraphAutoRefreshController {
  startupComplete(): boolean; failureReason(): string | null; state(): WatchIndexState
  acceptedBuildId(): string | null; readonly startupSettled: Promise<void>
  stop(): void; readonly completed: Promise<void>
}
function defaultEventSource(root: string, changed: () => void): FSWatcher {
  try {
    const watcher = watchFilesystem(root, { recursive: true }, (_event, filename) => {
      if (/^(?:out|node_modules|\.git)(?:\/|$)/.test(filename?.toString().replaceAll('\\', '/') ?? '')) return
      changed()
    })
    watcher.on('error', () => { watcher.close(); changed() })
    return watcher
  } catch { return { close() {} } as FSWatcher }
}
export function updateIndexInWorker(rootPath = '.'): Promise<GenerateIndexResult> {
  const entry = new URL(import.meta.url)
  if (!entry.pathname.endsWith('.js')) return Promise.resolve().then(() => updateIndex(rootPath))
  const leaseOwnerToken = randomUUID()
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(entry, { workerData: { madar_update_root: resolve(rootPath), madar_lease_owner: leaseOwnerToken } })
    let answered = false
    const abandon = () => { try { releaseIndexLeaseOwner(resolveMadarOutputDirectory(rootPath), leaseOwnerToken) } catch {} }
    worker.once('message', (result) => { answered = true; resolvePromise(result as GenerateIndexResult) })
    worker.once('error', (error) => { abandon(); reject(error) })
    worker.once('exit', (code) => { if (!answered) { abandon(); reject(new Error(`Madar index worker exited before replying (${code})`)) } })
  })
}
if (!isMainThread && typeof workerData?.madar_update_root === 'string') {
  parentPort?.postMessage(updateIndex(workerData.madar_update_root, { leaseOwnerToken: workerData.madar_lease_owner }))
}
export function startWatchIndex(rootPath = '.', debounceSeconds = 1,
  options: WatchIndexOptions = {}): GraphAutoRefreshController {
  const root = resolve(rootPath)
  const logger = options.logger ?? console
  const update = options.update ?? updateIndex
  let currentState: WatchIndexState = 'starting'
  let failure: string | null = null
  let buildId: string | null = options.seed?.buildId ?? null
  let startupComplete = false
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let eventSource: { close(): void } | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let leaseRetryAttempts = 0
  let dirty = false
  let resolveStartup!: () => void, resolveCompleted!: () => void
  const startupSettled = new Promise<void>((resolvePromise) => { resolveStartup = resolvePromise })
  const completed = new Promise<void>((resolvePromise) => { resolveCompleted = resolvePromise })
  const settleStartup = (): void => { if (!startupComplete) { startupComplete = true; resolveStartup() } }
  const stopped = (): boolean => currentState === 'stopped'
  const schedule = (delay: number): void => {
    if (pendingTimer) clearTimeout(pendingTimer)
    const timer = setTimeout(() => {
      if (pendingTimer === timer) reconcile()
    }, delay)
    pendingTimer = timer
  }
  const reconcile = (): void => {
    if (currentState === 'stopped') return
    pendingTimer = null
    failure = null
    currentState = 'reconciling'
    queueMicrotask(async () => {
      if (stopped()) { settleStartup(); resolveCompleted(); return }
      try {
        const result = await update(root, options)
        buildId = result.buildId
        leaseRetryAttempts = 0
        logger.log(`[madar watch] ${result.updateReceipt?.mode ?? 'update'} accepted ${result.buildId.slice(0, 12)}`)
      } catch (error) {
        if (stopped()) return
        const leaseContention = error instanceof Error && error.name === 'IndexLeaseContentionError'
        if (leaseContention && leaseRetryAttempts < LEASE_RETRY_LIMIT) {
          const delay = Math.min(LEASE_RETRY_MAX_MS, LEASE_RETRY_BASE_MS * (2 ** leaseRetryAttempts++))
          schedule(delay)
          logger.log(`[madar watch] index lease busy; retrying (${leaseRetryAttempts}/${LEASE_RETRY_LIMIT})`)
        } else {
          failure = error instanceof Error ? error.message : String(error)
          logger.error(`[madar watch] ${failure}`)
          if (!leaseContention) leaseRetryAttempts = 0
          if (error instanceof Error && error.name === 'SourceChangedDuringBuildError') schedule(0)
        }
      } finally {
        settleStartup()
        if (stopped()) resolveCompleted()
        else if (dirty) { dirty = false; currentState = 'pending'; schedule(0) }
        else currentState = pendingTimer ? 'pending' : failure ? 'failed' : 'idle'
      }
    })
  }
  const changed = (): void => {
    if (currentState === 'stopped') return
    leaseRetryAttempts = 0
    if (currentState === 'reconciling') { dirty = true; return }
    currentState = 'pending'
    schedule(Math.max(0, Math.round(debounceSeconds * 1_000)))
  }
  const controller: GraphAutoRefreshController = {
    startupComplete: () => startupComplete,
    failureReason: () => failure,
    state: () => currentState,
    acceptedBuildId: () => buildId,
    startupSettled,
    stop() {
      if (currentState === 'stopped') return
      if (currentState !== 'reconciling') { settleStartup(); resolveCompleted() }
      currentState = 'stopped'
      eventSource?.close()
      if (pendingTimer) clearTimeout(pendingTimer)
      if (pollTimer) clearInterval(pollTimer)
    },
    completed,
  }
  if (options.signal?.aborted) controller.stop()
  else {
    eventSource = (options.eventSource ?? defaultEventSource)(root, changed)
    pollTimer = setInterval(changed, Math.max(50, options.pollIntervalMs ?? 5 * 60_000))
    options.signal?.addEventListener('abort', () => controller.stop(), { once: true })
    reconcile()
  }
  return controller
}
export function watchIndex(rootPath = '.', debounceSeconds = 1, options: WatchIndexOptions = {}): Promise<void> { return startWatchIndex(rootPath, debounceSeconds, options).completed }
