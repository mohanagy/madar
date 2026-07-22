import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  parseWatcherState,
  WATCHER_STATE_VERSION,
  type WatcherEventMode,
  type WatcherState,
} from '../contracts/watcher-state.js'

export const WATCHER_STATE_FILENAME = 'watcher-state.json'

export function watcherStatePath(outputDir: string): string {
  return join(resolve(outputDir), WATCHER_STATE_FILENAME)
}

export function watcherStatePathForGraph(graphPath: string): string {
  return join(dirname(resolve(graphPath)), WATCHER_STATE_FILENAME)
}

export function createWatcherState(eventMode: WatcherEventMode, intervalMs: number): WatcherState {
  const now = new Date().toISOString()
  return {
    version: WATCHER_STATE_VERSION,
    pid: process.pid,
    started_at: now,
    updated_at: now,
    status: 'starting',
    coverage: 'unknown',
    event_mode: eventMode,
    reconciliation_count: 0,
    last_reconciliation_at: null,
    last_reconciliation_duration_ms: null,
    last_reconciliation_file_count: null,
    last_reconciliation_directory_count: null,
    current_interval_ms: intervalMs,
    next_reconciliation_at: null,
    pending_since: null,
    failure_reason: null,
    stored_policy_fingerprint: null,
    current_policy_fingerprint: null,
    policy_match: null,
  }
}

export function writeWatcherState(outputDir: string, state: WatcherState): void {
  const targetPath = watcherStatePath(outputDir)
  mkdirSync(dirname(targetPath), { recursive: true })
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2)}\n`, 'utf8')
    renameSync(temporaryPath, targetPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

export function readWatcherState(path: string): WatcherState | null {
  try {
    return parseWatcherState(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

export function readWatcherStateForGraph(graphPath: string): WatcherState | null {
  return readWatcherState(watcherStatePathForGraph(graphPath))
}
