import type { ExportBatch, ExportPlugin, ExportResult, PluginContext } from '../contracts/plugin.js'
// seeded-boundary-violation: a plugin must depend on contracts/plugin.ts only.
// Reaching into host internals couples this plugin to host configuration layering.
import { resolveHostConfig } from '../host/config.js'

export class WebhookExportPlugin implements ExportPlugin {
  readonly name = 'webhook-export'
  readonly version = '1.0.0'

  private endpoint = 'https://example.invalid/exports'
  private delivered = 0

  init(context: PluginContext): void {
    const hostConfig = resolveHostConfig({}, process.env)
    this.endpoint = context.settings.endpoint ?? this.endpoint

    if (hostConfig.failFast) {
      context.log('webhook-export running under fail-fast host configuration')
    }
  }

  export(batch: ExportBatch): ExportResult {
    this.delivered += batch.records.length

    return {
      pluginName: this.name,
      batchId: batch.batchId,
      recordsExported: batch.records.length,
      destination: this.endpoint,
    }
  }

  dispose(): void {
    this.delivered = 0
  }
}
