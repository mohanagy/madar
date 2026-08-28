import { UnsupportedGenerationModeError } from './generate.js'
import type { GraphAutoRefreshController, WatchLogger } from './watch.js'

/**
 * #722 FULL_GENERATE_ONLY_V1 — background automatic refresh is withdrawn.
 *
 * This refuses before a worker thread is spawned, before watcher state is
 * written and before any refresh is scheduled.
 */

export interface BackgroundAutoRefreshOptions {
  noHtml?: boolean
  logger?: WatchLogger
}

export interface BackgroundAutoRefreshDependencies {
  watchModuleUrl?: URL
}

export function startGraphAutoRefreshInBackground(
  watchPath: string,
  debounceSeconds = 1,
  options: BackgroundAutoRefreshOptions = {},
  dependencies: BackgroundAutoRefreshDependencies = {},
): GraphAutoRefreshController {
  void [watchPath, debounceSeconds, options, dependencies]
  throw new UnsupportedGenerationModeError('auto-refresh', 'run `madar generate` for a full regeneration')
}
