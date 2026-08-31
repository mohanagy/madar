export interface InheritedSignalObservation {
  readonly name: string
  readonly file: string | null
  /** FACT: is the named symbol present in the named file at this revision? */
  readonly source_presence: { file_present: boolean; matches: readonly string[] } | null
  /** FACT: cells on which a co-occurring classification flag fired. */
  readonly co_occurring_flag_cells: readonly { cell_id: string; flags: readonly string[]; cell_state: string }[]
  /** ATTRIBUTION: never inferred from the two facts above. */
  readonly cell_state_attributable: false
  readonly attribution_status: 'not_established_in_phase_1'
  readonly attribution_note: string
  readonly measurably_changed_a_cell: boolean
}

export declare function observeInheritedSignals(input: {
  root: string
  cells: readonly Record<string, unknown>[]
}): { summary: string; signals: readonly InheritedSignalObservation[] }
