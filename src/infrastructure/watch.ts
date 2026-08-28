import { UnsupportedGenerationModeError } from './generate.js'
import type { IndexingStrictThresholds } from '../contracts/indexing.js'

/**
 * #722 FULL_GENERATE_ONLY_V1 — automatic semantic refresh is withdrawn.
 *
 * Semantic generation may read repository inputs but may not read persisted
 * semantic results. Watch and auto-refresh existed to reconstruct generation
 * inputs from persisted state — a stored generation policy, a prior graph, a
 * watcher snapshot — so they cannot be expressed under that contract and are
 * not part of the stable profile.
 *
 * These entry points remain as refusal owners only. Each refuses before any
 * stored policy or prior graph is read, before a watcher, timer or worker is
 * created, and before any artifact is written. The historical implementation is
 * recoverable from Git history and the #722 evidence ledger; it is deliberately
 * not retained here under any name.
 */

export interface WatchLogger {
  log(message?: string): void
  error(message?: string): void
}

export interface RebuildCodeOptions {
  followSymlinks?: boolean
  respectGitignore?: boolean
  noHtml?: boolean
  indexingStrict?: IndexingStrictThresholds
  logger?: WatchLogger
}

export interface WatchOptions extends RebuildCodeOptions {
  signal?: AbortSignal
}

/** Retained because `serve --stdio` still types a controller it never receives. */
export interface GraphAutoRefreshController {
  initialRebuilt: boolean
  startupComplete?(): boolean
  failureReason?(): string | null
  startupSettled?: Promise<void>
  stop(): void
  completed: Promise<void>
}

const GUIDANCE = 'run `madar generate` for a full regeneration'

export function rebuildCode(watchPath: string, options: RebuildCodeOptions = {}): boolean {
  void [watchPath, options]
  throw new UnsupportedGenerationModeError('auto-refresh', GUIDANCE)
}

export function startGraphAutoRefresh(
  watchPath: string,
  debounceSeconds = 1,
  options: Omit<WatchOptions, 'signal'> = {},
): GraphAutoRefreshController {
  void [watchPath, debounceSeconds, options]
  throw new UnsupportedGenerationModeError('auto-refresh', GUIDANCE)
}

export async function watch(watchPath: string, debounce = 3, options: WatchOptions = {}): Promise<void> {
  void [watchPath, debounce, options]
  throw new UnsupportedGenerationModeError('watch', GUIDANCE)
}
