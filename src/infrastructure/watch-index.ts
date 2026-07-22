import { watch as watchFilesystem, type FSWatcher } from 'node:fs'
import { resolve } from 'node:path'

import { updateIndex, type UpdateIndexOptions } from '../application/update-index.js'
import type { GenerateIndexResult } from '../application/generate-index.js'
import { IndexLeaseContentionError } from '../domain/index/build-state.js'

const LEASE_RETRY_BASE_MS = 50
const LEASE_RETRY_MAX_MS = 2_000
const LEASE_RETRY_LIMIT = 12

export interface WatchIndexLogger {
  log(message?: string): void
  error(message?: string): void
}

export type WatchIndexState = 'starting' | 'idle' | 'pending' | 'reconciling' | 'failed' | 'stopped'

export interface WatchIndexOptions extends UpdateIndexOptions {
  signal?: AbortSignal
  pollIntervalMs?: number
  seed?: Pick<GenerateIndexResult, 'buildId'>
  logger?: WatchIndexLogger
  /** Hermetic event-source seam; production uses fs.watch. */
  eventSource?: (root: string, changed: () => void) => { close(): void }
  /** Hermetic reconciliation seam; production uses the one-shot application use case. */
  update?: typeof updateIndex
}

export interface GraphAutoRefreshController {
  startupComplete(): boolean
  failureReason(): string | null
  state(): WatchIndexState
  acceptedBuildId(): string | null
  readonly startupSettled: Promise<void>
  stop(): void
  readonly completed: Promise<void>
}

function defaultEventSource(root: string, changed: () => void): FSWatcher {
  try {
    return watchFilesystem(root, { recursive: true }, (_event, filename) => {
      const path = filename?.toString().replaceAll('\\', '/') ?? ''
      if (/^(?:out|node_modules|\.git)(?:\/|$)/.test(path)) return
      changed()
    })
  } catch {
    return { close() {} } as FSWatcher
  }
}

export function startWatchIndex(
  rootPath = '.',
  debounceSeconds = 1,
  options: WatchIndexOptions = {},
): GraphAutoRefreshController {
  const root = resolve(rootPath)
  const logger = options.logger ?? console
  const update = options.update ?? updateIndex
  const debounceMs = Math.max(0, Math.round(debounceSeconds * 1_000))
  const pollMs = Math.max(50, options.pollIntervalMs ?? 5 * 60_000)
  let currentState: WatchIndexState = 'starting'
  let failure: string | null = null
  let buildId: string | null = options.seed?.buildId ?? null
  let startupComplete = false
  let stopped = false
  let dirty = true
  let building = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let leaseRetryTimer: ReturnType<typeof setTimeout> | null = null
  let leaseRetryAttempts = 0
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let resolveStartup!: () => void
  let resolveCompleted!: () => void
  const startupSettled = new Promise<void>((resolvePromise) => { resolveStartup = resolvePromise })
  const completed = new Promise<void>((resolvePromise) => { resolveCompleted = resolvePromise })

  const settleStartup = (): void => {
    if (startupComplete) return
    startupComplete = true
    resolveStartup()
  }

  const finish = (): void => {
    if (!stopped || building) return
    currentState = 'stopped'
    settleStartup()
    resolveCompleted()
  }

  const clearLeaseRetry = (): void => {
    if (leaseRetryTimer) clearTimeout(leaseRetryTimer)
    leaseRetryTimer = null
  }

  const scheduleLeaseRetry = (): boolean => {
    if (leaseRetryAttempts >= LEASE_RETRY_LIMIT) return false
    const delay = Math.min(LEASE_RETRY_MAX_MS, LEASE_RETRY_BASE_MS * (2 ** leaseRetryAttempts))
    leaseRetryAttempts += 1
    dirty = true
    failure = null
    currentState = 'pending'
    clearLeaseRetry()
    leaseRetryTimer = setTimeout(() => {
      leaseRetryTimer = null
      reconcile()
    }, delay)
    return true
  }

  const reconcile = (): void => {
    if (stopped || building || !dirty) return
    building = true
    currentState = 'reconciling'
    dirty = false
    queueMicrotask(() => {
      try {
        const result = update(root, options)
        buildId = result.buildId
        failure = null
        leaseRetryAttempts = 0
        logger.log(`[madar watch] ${result.updateReceipt?.mode ?? 'update'} accepted ${result.buildId.slice(0, 12)}`)
      } catch (error) {
        if (error instanceof IndexLeaseContentionError && scheduleLeaseRetry()) {
          logger.log(`[madar watch] index lease busy; retrying (${leaseRetryAttempts}/${LEASE_RETRY_LIMIT})`)
        } else {
          failure = error instanceof Error ? error.message : String(error)
          currentState = 'failed'
          logger.error(`[madar watch] ${failure}`)
          if (error instanceof Error && error.name === 'SourceChangedDuringBuildError') {
            leaseRetryAttempts = 0
            dirty = true
          }
        }
      } finally {
        building = false
        settleStartup()
        if (stopped) finish()
        else if (dirty && leaseRetryTimer === null) reconcile()
        else if (leaseRetryTimer !== null) currentState = 'pending'
        else currentState = failure ? 'failed' : 'idle'
      }
    })
  }

  const changed = (): void => {
    if (stopped) return
    clearLeaseRetry()
    leaseRetryAttempts = 0
    dirty = true
    if (!building) currentState = 'pending'
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(reconcile, debounceMs)
  }

  const eventSource = (options.eventSource ?? defaultEventSource)(root, changed)
  pollTimer = setInterval(changed, pollMs)
  options.signal?.addEventListener('abort', () => controller.stop(), { once: true })
  reconcile()

  const controller: GraphAutoRefreshController = {
    startupComplete: () => startupComplete,
    failureReason: () => failure,
    state: () => currentState,
    acceptedBuildId: () => buildId,
    startupSettled,
    stop() {
      if (stopped) return
      stopped = true
      eventSource.close()
      if (debounceTimer) clearTimeout(debounceTimer)
      clearLeaseRetry()
      if (pollTimer) clearInterval(pollTimer)
      finish()
    },
    completed,
  }
  return controller
}

export async function watchIndex(rootPath = '.', debounceSeconds = 1, options: WatchIndexOptions = {}): Promise<void> {
  const controller = startWatchIndex(rootPath, debounceSeconds, options)
  await controller.completed
}
