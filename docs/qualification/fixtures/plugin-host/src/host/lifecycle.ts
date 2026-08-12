import { PluginFailure, type ExportBatch, type ExportPlugin, type ExportResult, type PluginContext } from '../contracts/plugin.js'

export interface LifecycleOptions {
  failFast: boolean
  contextFor(plugin: ExportPlugin): PluginContext
}

export interface LifecycleOutcome {
  results: ExportResult[]
  failures: PluginFailure[]
}

/**
 * Owns init -> export -> dispose ordering and failure isolation.
 *
 * With `failFast: false` a failing plugin is recorded and skipped; the remaining
 * plugins still run and every initialized plugin is still disposed.
 */
export function runExportLifecycle(
  plugins: ExportPlugin[],
  batch: ExportBatch,
  options: LifecycleOptions,
): LifecycleOutcome {
  const results: ExportResult[] = []
  const failures: PluginFailure[] = []
  const initialized: ExportPlugin[] = []

  for (const plugin of plugins) {
    try {
      plugin.init(options.contextFor(plugin))
      initialized.push(plugin)
    } catch (cause) {
      const failure = new PluginFailure(plugin.name, 'init', cause)
      if (options.failFast) {
        throw failure
      }
      failures.push(failure)
    }
  }

  for (const plugin of initialized) {
    try {
      results.push(plugin.export(batch))
    } catch (cause) {
      const failure = new PluginFailure(plugin.name, 'export', cause)
      if (options.failFast) {
        throw failure
      }
      failures.push(failure)
    }
  }

  for (const plugin of initialized) {
    try {
      plugin.dispose?.()
    } catch (cause) {
      failures.push(new PluginFailure(plugin.name, 'dispose', cause))
    }
  }

  return { results, failures }
}
