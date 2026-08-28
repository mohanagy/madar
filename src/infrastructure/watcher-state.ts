import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  parseWatcherState,
  WATCHER_STATE_VERSION,
  type WatcherEventMode,
  type WatcherStateV1,
} from '../contracts/watcher-state.js'

export const WATCHER_STATE_FILENAME = 'watcher-state.json'

export function watcherStatePathForGraph(graphPath: string): string {
  return join(dirname(resolve(graphPath)), WATCHER_STATE_FILENAME)
}

export function readWatcherState(path: string): WatcherStateV1 | null {
  try {
    return parseWatcherState(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

export function readWatcherStateForGraph(graphPath: string): WatcherStateV1 | null {
  return readWatcherState(watcherStatePathForGraph(graphPath))
}
