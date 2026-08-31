import type { EvidenceSets } from './artifact.d.mts'

/** The highest answerability a negative-trust probe may report. */
export declare const PROBE_MAX_ANSWERABILITY: 'verify_targets'

export type CellState = 'pass' | 'fail' | 'invalid'

export interface ReadyClauseOutcome {
  readonly applicable: boolean
  readonly violated: readonly string[]
  readonly undetermined: readonly string[]
  readonly detail: string | null
}

export interface CellVerdict {
  readonly state: CellState
  readonly invalid_reason?: string
  readonly reasons: readonly string[]
  readonly undecided_clauses?: readonly string[]
  readonly metrics: Record<string, unknown>
  readonly expected: Record<string, unknown>
  readonly observed: Record<string, unknown>
  readonly ready_clauses?: ReadyClauseOutcome
  readonly measurement_limits?: readonly string[]
}

export declare function evaluateTaskCell(input: {
  cell: Record<string, unknown>
  task: Record<string, unknown>
  target: Record<string, unknown>
  truth: Record<string, unknown>
  preparation: Record<string, unknown>
  artifact: Record<string, unknown>
  evidence: EvidenceSets
  answerability: string
  targetDir: string
}): CellVerdict

export declare function evaluateProbe(input: {
  probe: Record<string, unknown>
  evidence: EvidenceSets
  answerability: string
  targetDir: string
  relabelCandidates?: readonly string[]
}): CellVerdict
