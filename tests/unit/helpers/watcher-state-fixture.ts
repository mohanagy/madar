import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { WATCHER_STATE_FILENAME } from '../../../src/infrastructure/watcher-state.js'
import type { WatcherStateV1 } from '../../../src/contracts/watcher-state.js'

/**
 * #722 FULL_GENERATE_ONLY_V1 — test-only watcher-state fixture writer.
 *
 * The production writer was removed with the withdrawn watch subsystem, and a
 * writer must not be kept alive in production merely to seed a test. This helper
 * writes the supported legacy watcher-state JSON shape directly, which also
 * makes the diagnostic tests stronger: they now read state that no current
 * production code produced.
 */
export function seedWatcherState(outputDir: string, state: Partial<WatcherStateV1> = {}): string {
  const now = '2026-01-01T00:00:00.000Z'
  const full: WatcherStateV1 = {
    version: 1,
    pid: 4242,
    started_at: now,
    updated_at: now,
    status: 'idle',
    coverage: 'complete',
    event_mode: 'recursive-events',
    reconciliation_count: 0,
    last_reconciliation_at: null,
    last_reconciliation_duration_ms: null,
    last_reconciliation_file_count: null,
    last_reconciliation_directory_count: null,
    current_interval_ms: 30_000,
    next_reconciliation_at: null,
    pending_since: null,
    failure_reason: null,
    stored_policy_fingerprint: null,
    current_policy_fingerprint: null,
    policy_match: null,
    ...state,
  } as WatcherStateV1
  const target = join(outputDir, WATCHER_STATE_FILENAME)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(full, null, 2)}\n`, 'utf8')
  return target
}

/** Writes a deliberately malformed file to exercise the diagnostic error contract. */
export function seedMalformedWatcherState(outputDir: string): string {
  const target = join(outputDir, WATCHER_STATE_FILENAME)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, '{ this is not valid watcher state', 'utf8')
  return target
}
