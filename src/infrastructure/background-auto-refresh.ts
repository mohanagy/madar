import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import { resolveMadarOutputDirectory } from '../shared/workspace.js'
import {
  createWatcherState,
  readWatcherState,
  watcherStatePath,
  writeWatcherState,
} from './watcher-state.js'
import {
  startGraphAutoRefresh,
  type GraphAutoRefreshController,
  type WatchLogger,
} from './watch.js'

// Keep the bootstrap static and pass every path through workerData. This avoids
// shell interpolation and lets Windows workspaces contain spaces safely.
const AUTO_REFRESH_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads')

if (!parentPort) {
  throw new Error('Madar auto-refresh worker has no parent port')
}

let controller = null
let stopRequested = false

parentPort.on('message', (message) => {
  if (!message || message.type !== 'stop') {
    return
  }
  stopRequested = true
  controller?.stop()
})

const logger = {
  log() {},
  error(message) {
    parentPort.postMessage({ type: 'watch-error', message: String(message ?? 'Auto-refresh failed') })
  },
}

void (async () => {
  const watchModule = await import(workerData.watchModuleUrl)
  controller = watchModule.startGraphAutoRefresh(
    workerData.watchPath,
    workerData.debounceSeconds,
    {
      logger,
    },
  )
  if (stopRequested) {
    controller.stop()
  }
  if (controller.startupSettled) {
    await controller.startupSettled
  }
  parentPort.postMessage({ type: 'started', initialRebuilt: controller.initialRebuilt })
  if (stopRequested) {
    controller.stop()
  }
  await controller.completed
  parentPort.postMessage({ type: 'completed' })
  parentPort.close()
})().catch((error) => {
  parentPort.postMessage({
    type: 'worker-error',
    message: error instanceof Error ? error.message : String(error),
  })
  parentPort.close()
})
`

export interface BackgroundAutoRefreshOptions {
  logger?: WatchLogger
}

export interface BackgroundAutoRefreshDependencies {
  /** Internal test seam; production resolves the compiled sibling watch.js. */
  watchModuleUrl?: URL
}

interface WorkerMessage {
  type?: unknown
  message?: unknown
  initialRebuilt?: unknown
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function markStarting(outputDir: string): void {
  writeWatcherState(outputDir, createWatcherState('polling', 0))
}

function markFailed(outputDir: string, message: string): void {
  try {
    const current = readWatcherState(watcherStatePath(outputDir))
    if (current && current.pid !== process.pid) {
      return
    }
    const state = current ?? createWatcherState('polling', 0)
    writeWatcherState(outputDir, {
      ...state,
      status: 'failed',
      coverage: 'failed',
      failure_reason: message,
      next_reconciliation_at: null,
    })
  } catch {
    // Controller state and stderr remain available when persistence is not.
  }
}

function completedFailureController(message: string): GraphAutoRefreshController {
  return {
    initialRebuilt: false,
    startupComplete: () => true,
    failureReason: () => message,
    stop() {},
    completed: Promise.resolve(),
  }
}

/**
 * Runs the synchronous graph reconciliation/watch loop away from the MCP
 * transport thread. The stdio server can therefore finish initialization and
 * answer control requests while watcher-state.json keeps graph reads fail-closed.
 */
export function startGraphAutoRefreshInBackground(
  watchPath: string,
  debounceSeconds = 1,
  options: BackgroundAutoRefreshOptions = {},
  dependencies: BackgroundAutoRefreshDependencies = {},
): GraphAutoRefreshController {
  const outputDir = resolveMadarOutputDirectory(watchPath)
  try {
    markStarting(outputDir)
  } catch (error) {
    const message = `Unable to mark auto-refresh as starting: ${errorMessage(error)}`
    options.logger?.error(message)
    return completedFailureController(message)
  }

  const watchModuleUrl = dependencies.watchModuleUrl ?? new URL('./watch.js', import.meta.url)
  let watchModuleExists = false
  try {
    watchModuleExists = existsSync(fileURLToPath(watchModuleUrl))
  } catch {
    watchModuleExists = false
  }

  // Vitest and source-level TypeScript runners do not have a sibling watch.js.
  // Keep their existing in-process behavior; published builds always do.
  if (!watchModuleExists) {
    return startGraphAutoRefresh(watchPath, debounceSeconds, options)
  }

  let worker: Worker
  try {
    worker = new Worker(AUTO_REFRESH_WORKER_SOURCE, {
      eval: true,
      workerData: {
        watchModuleUrl: watchModuleUrl.href,
        watchPath,
        debounceSeconds,
      },
    })
  } catch (error) {
    const message = `Unable to start auto-refresh worker: ${errorMessage(error)}`
    markFailed(outputDir, message)
    options.logger?.error(message)
    return completedFailureController(message)
  }

  let startupComplete = false
  let initialRebuilt = false
  let failureReason: string | null = null
  let stopRequested = false
  let settled = false
  let resolveCompleted!: () => void
  const completed = new Promise<void>((resolvePromise) => {
    resolveCompleted = resolvePromise
  })

  function settle(): void {
    if (settled) {
      return
    }
    settled = true
    resolveCompleted()
  }

  function fail(message: string): void {
    failureReason = message
    startupComplete = true
    markFailed(outputDir, message)
    options.logger?.error(message)
  }

  worker.on('message', (rawMessage: unknown) => {
    const message = rawMessage as WorkerMessage
    if (message.type === 'started') {
      startupComplete = true
      initialRebuilt = message.initialRebuilt === true
      return
    }
    if (message.type === 'watch-error' || message.type === 'worker-error') {
      fail(typeof message.message === 'string' ? message.message : 'Madar auto-refresh worker failed')
      return
    }
    if (message.type === 'completed') {
      settle()
    }
  })
  worker.once('error', (error) => {
    if (!stopRequested) {
      fail(`Madar auto-refresh worker crashed: ${errorMessage(error)}`)
    }
    settle()
  })
  worker.once('exit', (code) => {
    if (!stopRequested && code !== 0) {
      fail(`Madar auto-refresh worker exited with code ${code}`)
    }
    settle()
  })

  return {
    get initialRebuilt() {
      return initialRebuilt
    },
    startupComplete: () => startupComplete,
    failureReason: () => failureReason,
    stop() {
      if (stopRequested || settled) {
        return
      }
      stopRequested = true
      worker.postMessage({ type: 'stop' })
    },
    completed,
  }
}
