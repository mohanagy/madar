// Context-pack quality diagnostics contract (#78).
//
// Surfaces objective signals about a compiled context-pack so callers can
// detect "bad runs" — packs that are likely to underperform downstream —
// without having to re-implement the heuristics in every consumer.
//
// The diagnostics surface is INTENTIONALLY conservative: every warning is
// derived from a structural property of the pack (missing required
// evidence, zero claims, undersized retrieval, empty graph signals, etc.)
// rather than from a model judgement. That keeps the surface fully
// deterministic and CI-asseratable.

/** The categories of structural problems a context-pack can exhibit. Each
 *  enum value maps to one rule in computeContextPackDiagnostics. */
export type ContextPackDiagnosticKind =
  | 'missing_required_evidence'
  | 'missing_required_semantic'
  | 'zero_claims'
  | 'undersized_retrieval'
  | 'budget_underutilized'
  | 'missing_snippets'
  | 'low_avg_match_score'
  | 'orphan_nodes'
  | 'no_graph_signals'

export type ContextPackDiagnosticSeverity = 'info' | 'warn' | 'error'

export interface ContextPackDiagnosticWarning {
  kind: ContextPackDiagnosticKind
  severity: ContextPackDiagnosticSeverity
  message: string
  /** Optional structured detail — kind-specific. Consumers can read this
   *  for finer-grained UX (e.g., listing the missing evidence classes). */
  detail?: Record<string, unknown>
}

export interface ContextPackQualitySignals {
  /** Number of nodes in the pack. */
  node_count: number
  /** Number of relationships in the pack. */
  relationship_count: number
  /** Number of claims emitted by the pack. */
  claim_count: number
  /** Share of nodes carrying a non-empty snippet, 0..1. */
  snippet_coverage: number
  /** Average match_score across nodes that have one, 0..1 (NaN-safe). */
  avg_match_score: number
  /** token_count from the pack as a fraction of task_contract.budget.
   *  Capped at 1.0 for over-budget packs. */
  budget_utilization: number
}

export interface ContextPackDiagnostics {
  /** Overall quality score, 0..1. 1.0 means no warnings triggered;
   *  weighted-deductions reduce the score toward 0 for problem packs. */
  quality_score: number
  /** Triggered warnings, ordered by severity desc then kind asc. */
  warnings: ContextPackDiagnosticWarning[]
  /** Raw signals used to compute the score — useful for telemetry and
   *  for consumers that want to apply their own thresholds. */
  signals: ContextPackQualitySignals
}
