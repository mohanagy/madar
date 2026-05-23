// Retrieval gate (#75) — contract types.
//
// These types describe the *output* of the retrieval gate: the classification
// surface that callers and downstream consumers (e.g., context-pack output)
// rely on. The gate's runtime function plus its `RetrievalGateInput` shape
// live in src/runtime/retrieval-gate.ts; only the types that cross the
// runtime↔contract boundary belong here.

export type RetrievalLevel = 0 | 1 | 2 | 3 | 4 | 5

export type RetrievalIntent =
  | 'rename'
  | 'explain'
  | 'debug'
  | 'refactor'
  | 'test'
  | 'review'
  | 'impact'
  | 'chitchat'
  | 'unknown'

export type RetrievalExcludedDomain =
  | 'test'
  | 'benchmark'
  | 'fixture'
  | 'generated'
  | 'docs'
  | 'config'
  | 'build_artifact'

export type RetrievalGenerationIntent =
  | 'runtime_generation'
  | 'display_rendering'
  | 'unknown'

export type RetrievalTargetDomainHint =
  | 'backend_runtime'
  | 'frontend_display'
  | 'unknown'

export interface RetrievalGenerationDebugSignals {
  display_shaped: boolean
  generic_generation_shaped: boolean
  backend_runtime_shaped: boolean
  report_generation_shaped: boolean
  build_static_shaped: boolean
  explanation_shaped: boolean
}

export interface RetrievalGateSignals {
  has_pr_diff: boolean
  has_stack_trace: boolean
  mentioned_paths: ReadonlyArray<string>
  mentioned_symbols: ReadonlyArray<string>
  generation_intent?: RetrievalGenerationIntent
  target_domain_hint?: RetrievalTargetDomainHint
  generation_debug?: RetrievalGenerationDebugSignals
  excluded_domains?: ReadonlyArray<RetrievalExcludedDomain>
  excluded_terms?: ReadonlyArray<string>
  excluded_path_hints?: ReadonlyArray<string>
}

export interface RetrievalGateDecision {
  level: RetrievalLevel
  /** True iff level === 0 — caller can short-circuit retrieval entirely. */
  skipped_retrieval: boolean
  /** Human-readable explanation of why this level was selected. */
  reason: string
  /** Intent the gate inferred (or that the caller supplied). */
  intent: RetrievalIntent
  /** Signals the gate detected from the prompt + caller hints. */
  signals: RetrievalGateSignals
}
