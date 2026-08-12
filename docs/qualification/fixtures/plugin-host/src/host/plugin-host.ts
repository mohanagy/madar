import type { ExportBatch, ExportPlugin, PluginContext } from '../contracts/plugin.js'
import { CsvExportPlugin } from '../plugins/csv-export-plugin.js'
import { WebhookExportPlugin } from '../plugins/webhook-export-plugin.js'
import { resolveHostConfig, settingsFor, type HostConfig } from './config.js'
import { runExportLifecycle, type LifecycleOutcome } from './lifecycle.js'
import { PluginRegistry } from './registry.js'

export interface PluginHostOptions {
  fileConfig?: Partial<HostConfig>
  env?: Record<string, string | undefined>
  log?: (message: string) => void
}

/**
 * Composition root. This is the only module that knows about both `plugins/*`
 * and `host/*`; adding a built-in plugin should require a change here and
 * nowhere else in `host/`.
 */
export class PluginHost {
  private readonly config: HostConfig
  private readonly registry = new PluginRegistry()
  private readonly log: (message: string) => void

  constructor(options: PluginHostOptions = {}) {
    this.config = resolveHostConfig(options.fileConfig ?? {}, options.env ?? {})
    this.log = options.log ?? (() => {})

    for (const plugin of builtInPlugins()) {
      this.registry.register(plugin)
    }
  }

  registerPlugin(plugin: ExportPlugin): void {
    this.registry.register(plugin)
  }

  runExport(batch: ExportBatch): LifecycleOutcome {
    const plugins = this.registry.resolveAll(this.config.enabledPlugins)

    return runExportLifecycle(plugins, batch, {
      failFast: this.config.failFast,
      contextFor: (plugin) => this.contextFor(plugin),
    })
  }

  private contextFor(plugin: ExportPlugin): PluginContext {
    return {
      settings: Object.freeze({ ...settingsFor(this.config, plugin.name) }),
      log: (message: string) => this.log(`[${plugin.name}] ${message}`),
    }
  }
}

function builtInPlugins(): ExportPlugin[] {
  return [new CsvExportPlugin(), new WebhookExportPlugin()]
}
