import { hasExactKeys, isRecord } from '../shared/guards.js'

export const WATCHER_STATE_VERSION = 2 as const

export type WatcherStatus = 'starting' | 'idle' | 'pending' | 'reconciling' | 'failed' | 'stopped'
export type WatcherCoverage = 'unknown' | 'complete' | 'failed'
export type WatcherEventMode = 'recursive-events' | 'polling'

export interface WatcherState {
  version: typeof WATCHER_STATE_VERSION
  pid: number
  started_at: string
  updated_at: string
  status: WatcherStatus
  coverage: WatcherCoverage
  event_mode: WatcherEventMode
  reconciliation_count: number
  last_reconciliation_at: string | null
  last_reconciliation_duration_ms: number | null
  last_reconciliation_file_count: number | null
  last_reconciliation_directory_count: number | null
  current_interval_ms: number
  next_reconciliation_at: string | null
  pending_since: string | null
  failure_reason: string | null
  stored_policy_fingerprint: string | null
  current_policy_fingerprint: string | null
  policy_match: boolean | null
}

const WATCHER_STATE_KEYS = [
  'version', 'pid', 'started_at', 'updated_at', 'status', 'coverage', 'event_mode', 'reconciliation_count',
  'last_reconciliation_at', 'last_reconciliation_duration_ms', 'last_reconciliation_file_count',
  'last_reconciliation_directory_count', 'current_interval_ms', 'next_reconciliation_at', 'pending_since',
  'failure_reason', 'stored_policy_fingerprint', 'current_policy_fingerprint', 'policy_match',
] as const

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNullableNonNegativeNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

export function parseWatcherState(value: unknown): WatcherState | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, WATCHER_STATE_KEYS)
    || value.version !== WATCHER_STATE_VERSION
  ) {
    return null
  }
  const statuses: WatcherStatus[] = ['starting', 'idle', 'pending', 'reconciling', 'failed', 'stopped']
  const coverages: WatcherCoverage[] = ['unknown', 'complete', 'failed']
  const eventModes: WatcherEventMode[] = ['recursive-events', 'polling']
  if (
    typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.started_at !== 'string'
    || typeof value.updated_at !== 'string'
    || !statuses.includes(value.status as WatcherStatus)
    || !coverages.includes(value.coverage as WatcherCoverage)
    || !eventModes.includes(value.event_mode as WatcherEventMode)
    || typeof value.reconciliation_count !== 'number' || !Number.isSafeInteger(value.reconciliation_count) || value.reconciliation_count < 0
    || !isNullableString(value.last_reconciliation_at)
    || !isNullableNonNegativeNumber(value.last_reconciliation_duration_ms)
    || !isNullableNonNegativeNumber(value.last_reconciliation_file_count)
    || !isNullableNonNegativeNumber(value.last_reconciliation_directory_count)
    || typeof value.current_interval_ms !== 'number' || !Number.isFinite(value.current_interval_ms) || value.current_interval_ms < 0
    || !isNullableString(value.next_reconciliation_at)
    || !isNullableString(value.pending_since)
    || !isNullableString(value.failure_reason)
    || !isNullableString(value.stored_policy_fingerprint)
    || !isNullableString(value.current_policy_fingerprint)
    || (value.policy_match !== null && typeof value.policy_match !== 'boolean')
  ) {
    return null
  }

  return value as unknown as WatcherState
}

export function watcherStateBlocksGraphReads(state: WatcherState): boolean {
  return state.status === 'starting'
    || state.status === 'pending'
    || state.status === 'reconciling'
    || state.status === 'failed'
    || state.coverage !== 'complete'
    || state.policy_match === false
}
