export interface ExportRecord {
  id: string
  fields: Record<string, string>
}

export interface ExportBatch {
  batchId: string
  records: ExportRecord[]
}

export interface ExportResult {
  pluginName: string
  batchId: string
  recordsExported: number
  destination: string
}

export interface PluginContext {
  /** Plugin-scoped settings resolved by the host; plugins never read config themselves. */
  settings: Readonly<Record<string, string>>
  log(message: string): void
}

/**
 * The only stable extension surface. Anything under `plugins/` must depend on
 * this module and nothing else from this workspace.
 */
export interface ExportPlugin {
  readonly name: string
  readonly version: string
  init(context: PluginContext): void
  export(batch: ExportBatch): ExportResult
  dispose?(): void
}

export class PluginFailure extends Error {
  constructor(
    readonly pluginName: string,
    readonly phase: 'init' | 'export' | 'dispose',
    cause: unknown,
  ) {
    super(`plugin ${pluginName} failed during ${phase}: ${String(cause)}`)
    this.name = 'PluginFailure'
  }
}
