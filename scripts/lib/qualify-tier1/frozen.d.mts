export declare const CONTRACT_DIR: 'docs/qualification'

export declare function sha256(buffer: Buffer | string): string

export declare function readJson(root: string, rel: string): unknown

export interface FrozenFileEntry {
  readonly path: string
  readonly sha256: string
}

export interface FrozenManifest {
  readonly contract_version: string
  readonly file_count: number
  readonly files: readonly FrozenFileEntry[]
  /** Every file reached by following references out of the contract documents. */
  readonly derived_references: readonly string[]
  readonly referenced_ids: {
    readonly target_ids: readonly string[]
    readonly task_ids: readonly string[]
    readonly tier1_cell_ids: readonly string[]
    readonly negative_probe_ids: readonly string[]
    readonly rubric_methods: readonly string[]
  }
  readonly cross_reference_valid: boolean
  readonly digest: string
}

export interface FrozenBuild {
  readonly manifest: FrozenManifest
  /** Non-empty means the frozen inputs are inconsistent; refuse to measure. */
  readonly problems: readonly string[]
  readonly corpus: Record<string, unknown>
  readonly tasks: Record<string, unknown>
  readonly rubrics: Record<string, unknown>
  readonly tier1: Record<string, unknown>
  readonly cells: readonly Record<string, unknown>[]
  readonly probes: readonly Record<string, unknown>[]
  readonly targetsById: Map<string, Record<string, unknown>>
  readonly tasksById: Map<string, Record<string, unknown>>
  readonly truthByTask: Map<string, { truth: Record<string, unknown>; path: string }>
}

export declare function buildFrozenManifest(root: string): FrozenBuild
