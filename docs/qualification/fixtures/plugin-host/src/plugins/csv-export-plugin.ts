import type { ExportBatch, ExportPlugin, ExportResult, PluginContext } from '../contracts/plugin.js'

/**
 * Reference implementation of the intended boundary: depends on
 * `contracts/plugin.ts` only and reads every setting from `PluginContext`.
 */
export class CsvExportPlugin implements ExportPlugin {
  readonly name = 'csv-export'
  readonly version = '1.0.0'

  private delimiter = ','
  private destination = 'file://exports'

  init(context: PluginContext): void {
    this.delimiter = context.settings.delimiter ?? this.delimiter
    this.destination = context.settings.destination ?? this.destination
    context.log(`csv-export writing to ${this.destination}`)
  }

  export(batch: ExportBatch): ExportResult {
    for (const record of batch.records) {
      Object.values(record.fields).join(this.delimiter)
    }

    return {
      pluginName: this.name,
      batchId: batch.batchId,
      recordsExported: batch.records.length,
      destination: this.destination,
    }
  }
}
