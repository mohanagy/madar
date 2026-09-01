import type { EvidenceSets } from './artifact.d.mts'
import type { LoadedAdjudication } from './adjudication.d.mts'

/** The highest answerability a negative-trust probe may report. */
export declare const PROBE_MAX_ANSWERABILITY: 'verify_targets'

/** The exact reason recorded when a frozen absence declaration is not observed. */
export declare const MISSING_ABSENCE_DECLARATION: 'missing_required_absence_declaration'

/** The exact reason recorded when the adjudication contract does not match its sources. */
export declare const ADJUDICATION_MISMATCH: 'adjudication_contract_mismatch'

export type CellState = 'pass' | 'fail' | 'invalid'

/** The outcome of one frozen clause, decided by its bound typed predicate. */
export interface AdjudicatedClause {
  readonly adjudication_id: string
  readonly clause?: string
  readonly requirement?: string
  readonly clause_sha256: string
  readonly predicate: string
  readonly satisfied: boolean
  readonly detail: string | null
  readonly observed: Record<string, unknown>
}

/** The relationship picture for one cell, flattened for the reader. */
export interface RelationshipSummary {
  readonly required_relationship_ids: readonly string[]
  readonly present_relationship_ids: readonly string[]
  readonly missing_relationship_ids: readonly string[]
  readonly exactly_unresolved_relationship_ids: readonly string[]
  readonly uncovered_relationship_ids: readonly string[]
  readonly channels_consulted: readonly string[]
  readonly directions_evaluated: readonly string[]
  readonly relation_kinds_evaluated: readonly string[]
  readonly typed_edges_observed: number
  readonly false_ready_decision: boolean
}

export interface AdjudicationOutcome {
  readonly contract_digest: string | null
  readonly adjudication_version?: number | null
  readonly clauses: readonly AdjudicatedClause[]
  readonly contract_problems: readonly string[]
  /** Null on cells whose frozen clauses name no relationship. */
  readonly relationships?: RelationshipSummary | null
}

export interface CellVerdict {
  readonly state: CellState
  readonly invalid_reason?: string
  readonly reasons: readonly string[]
  readonly undecided_clauses?: readonly string[]
  readonly metrics: Record<string, unknown>
  readonly expected: Record<string, unknown>
  readonly observed: Record<string, unknown>
  /** Every frozen prose clause and the typed predicate that decided it. */
  readonly adjudication: AdjudicationOutcome
}

export declare function evaluateTaskCell(input: {
  cell: Record<string, unknown>
  task: Record<string, unknown>
  target: Record<string, unknown>
  truth: Record<string, unknown>
  preparation: Record<string, unknown>
  artifact: Record<string, unknown>
  truthFile: string
  evidence: EvidenceSets
  answerability: string
  targetDir: string
  adjudication: LoadedAdjudication
}): CellVerdict

export declare function evaluateProbe(input: {
  probe: Record<string, unknown>
  probeIndex: number
  evidence: EvidenceSets
  artifact: Record<string, unknown>
  answerability: string
  targetDir: string
  adjudication: LoadedAdjudication
}): CellVerdict
