import type { DeclarationSighting, EvidenceSets } from './artifact.d.mts'

/** The highest answerability a negative-trust probe may report. */
export declare const PROBE_MAX_ANSWERABILITY: 'verify_targets'

/** The exact reason recorded when a frozen absence declaration is not observed. */
export declare const MISSING_ABSENCE_DECLARATION: 'missing_required_absence_declaration'

export type CellState = 'pass' | 'fail' | 'invalid'

export interface ReadyClauseOutcome {
  readonly applicable: boolean
  readonly violated: readonly string[]
  readonly undetermined: readonly string[]
  readonly unresolved_declarations: readonly { item: string; schema_path: string; text: string }[]
  readonly detail: string | null
}

/** How each frozen `required_behaviour` clause was, or was not, measured. */
export interface RequirementCoverage {
  readonly requirement: string
  readonly measured: boolean
  readonly satisfied: boolean | null
  readonly how: string
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
  /** Present on negative probes; an unmeasured clause forbids `pass`. */
  readonly requirement_coverage?: readonly RequirementCoverage[]
}

export declare function evaluateTaskCell(input: {
  cell: Record<string, unknown>
  task: Record<string, unknown>
  target: Record<string, unknown>
  truth: Record<string, unknown>
  preparation: Record<string, unknown>
  artifact: Record<string, unknown>
  evidence: EvidenceSets
  declarations?: readonly DeclarationSighting[]
  answerability: string
  targetDir: string
}): CellVerdict

export declare function evaluateProbe(input: {
  probe: Record<string, unknown>
  evidence: EvidenceSets
  declarations?: readonly DeclarationSighting[]
  answerability: string
  targetDir: string
  relabelCandidates?: readonly string[]
}): CellVerdict
