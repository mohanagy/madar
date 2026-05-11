// Context-pack quality diagnostics — pure scorer (#78).
//
// Takes a compiled context-pack and returns a deterministic diagnostics
// payload that downstream tools (the MCP `context_pack` response, CI
// regression tests, telemetry) can surface to humans or agents.
//
// Rules:
//   1. missing_required_evidence  — coverage flags any required class as
//      missing (severity: error). The model has no chance of producing
//      a correct answer without the requested evidence class.
//   2. missing_required_semantic  — same for semantic-required categories
//      (severity: warn — semantic_required is softer than evidence_required).
//   3. zero_claims                — the claims array is empty. Either the
//      retrieval missed everything or the claim extractor under-produced.
//   4. undersized_retrieval       — nodes.length < 3 with a non-trivial
//      budget. Most non-trivial questions need more than two nodes.
//   5. budget_underutilized       — token_count < 25% of the requested
//      budget. Likely an under-confident retrieval.
//   6. missing_snippets           — share of nodes without a snippet
//      exceeds 50%. The agent can't ground answers without source text.
//   7. low_avg_match_score        — mean match_score across scored nodes
//      < 0.30. Indicates weak retrieval.
//   8. orphan_nodes               — nodes.length > 1 and
//      relationships.length === 0. The pack contains entities but no
//      structural relationships between them.
//   9. no_graph_signals           — both god_nodes and bridge_nodes are
//      empty. Architectural context is absent.
//
// The score is computed as 1 - sum(weight * triggered) / sum(weight) where
// every rule has a weight ∈ {1, 2}. Errors weight 2, warns and infos weight 1.

import type { CompiledContextPack } from '../contracts/context-pack.js'
import type {
  ContextPackDiagnosticKind,
  ContextPackDiagnosticSeverity,
  ContextPackDiagnosticWarning,
  ContextPackDiagnostics,
  ContextPackQualitySignals,
} from '../contracts/context-pack-diagnostics.js'

const RULE_WEIGHTS: ReadonlyMap<ContextPackDiagnosticKind, number> = new Map([
  ['missing_required_evidence', 2],
  ['missing_required_semantic', 1],
  ['zero_claims', 1],
  ['undersized_retrieval', 1],
  ['budget_underutilized', 1],
  ['missing_snippets', 1],
  ['low_avg_match_score', 1],
  ['orphan_nodes', 1],
  ['no_graph_signals', 1],
])

const SEVERITY_ORDER: Record<ContextPackDiagnosticSeverity, number> = {
  error: 0,
  warn: 1,
  info: 2,
}

const UNDERSIZED_RETRIEVAL_THRESHOLD = 3
const BUDGET_UNDERUTILIZED_FRACTION = 0.25
const MIN_BUDGET_FOR_UNDERUTILIZATION = 500
const MISSING_SNIPPETS_FRACTION = 0.5
const LOW_AVG_MATCH_SCORE = 0.30

export interface ComputeContextPackDiagnosticsOptions {
  /** Skip the budget-underutilized rule. Useful for callers that already
   *  know the pack is small-by-design (e.g., delta packs after dedup). */
  skipBudgetUnderutilization?: boolean
}

/**
 * Compute structural quality diagnostics for a compiled context-pack.
 * Pure, deterministic, no I/O.
 */
export function computeContextPackDiagnostics(
  pack: CompiledContextPack,
  options: ComputeContextPackDiagnosticsOptions = {},
): ContextPackDiagnostics {
  const signals = computeSignals(pack)
  const warnings: ContextPackDiagnosticWarning[] = []

  const missingRequired = pack.coverage.missing_required
  if (missingRequired.length > 0) {
    warnings.push({
      kind: 'missing_required_evidence',
      severity: 'error',
      message: `Pack is missing required evidence classes: ${missingRequired.join(', ')}.`,
      detail: { classes: missingRequired },
    })
  }

  const missingSemantic = pack.coverage.missing_semantic
  if (missingSemantic.length > 0) {
    warnings.push({
      kind: 'missing_required_semantic',
      severity: 'warn',
      message: `Pack is missing required semantic categories: ${missingSemantic.join(', ')}.`,
      detail: { categories: missingSemantic },
    })
  }

  if (signals.claim_count === 0) {
    warnings.push({
      kind: 'zero_claims',
      severity: 'warn',
      message: 'Pack contains no claims — retrieval likely under-grounded the answer.',
    })
  }

  if (signals.node_count > 0 && signals.node_count < UNDERSIZED_RETRIEVAL_THRESHOLD) {
    warnings.push({
      kind: 'undersized_retrieval',
      severity: 'warn',
      message: `Pack contains only ${signals.node_count} node(s); expected at least ${UNDERSIZED_RETRIEVAL_THRESHOLD} for a non-trivial query.`,
      detail: { node_count: signals.node_count, threshold: UNDERSIZED_RETRIEVAL_THRESHOLD },
    })
  }

  if (
    !options.skipBudgetUnderutilization &&
    pack.task_contract.budget >= MIN_BUDGET_FOR_UNDERUTILIZATION &&
    signals.budget_utilization < BUDGET_UNDERUTILIZED_FRACTION
  ) {
    warnings.push({
      kind: 'budget_underutilized',
      severity: 'info',
      message: `Pack used only ${Math.round(signals.budget_utilization * 100)}% of the ${pack.task_contract.budget}-token budget.`,
      detail: { utilization: signals.budget_utilization, budget: pack.task_contract.budget },
    })
  }

  if (signals.node_count > 0 && signals.snippet_coverage < (1 - MISSING_SNIPPETS_FRACTION)) {
    warnings.push({
      kind: 'missing_snippets',
      severity: 'warn',
      message: `${Math.round((1 - signals.snippet_coverage) * 100)}% of nodes lack a source snippet — agent cannot ground answers.`,
      detail: { snippet_coverage: signals.snippet_coverage },
    })
  }

  if (
    signals.node_count >= UNDERSIZED_RETRIEVAL_THRESHOLD &&
    !Number.isNaN(signals.avg_match_score) &&
    signals.avg_match_score < LOW_AVG_MATCH_SCORE
  ) {
    // CodeRabbit fix: do NOT exclude avg_match_score === 0. That is the
    // worst-possible retrieval and must fire the warning. The NaN guard
    // above already prevents firing on packs with no scored nodes.
    warnings.push({
      kind: 'low_avg_match_score',
      severity: 'warn',
      message: `Average match_score is ${signals.avg_match_score.toFixed(2)} (< ${LOW_AVG_MATCH_SCORE}). Retrieval is weak.`,
      detail: { avg_match_score: signals.avg_match_score, threshold: LOW_AVG_MATCH_SCORE },
    })
  }

  if (signals.node_count > 1 && signals.relationship_count === 0) {
    warnings.push({
      kind: 'orphan_nodes',
      severity: 'warn',
      message: `Pack has ${signals.node_count} nodes but no relationships — entities are not structurally connected.`,
      detail: { node_count: signals.node_count },
    })
  }

  const graphSignals = pack.graph_signals
  const hasArchSignals = !!graphSignals && (
    (graphSignals.god_nodes?.length ?? 0) > 0 ||
    (graphSignals.bridge_nodes?.length ?? 0) > 0
  )
  if (!hasArchSignals && signals.node_count >= UNDERSIZED_RETRIEVAL_THRESHOLD) {
    warnings.push({
      kind: 'no_graph_signals',
      severity: 'info',
      message: 'Pack lacks architectural signals (god_nodes / bridge_nodes).',
    })
  }

  warnings.sort((a, b) => {
    const sevDelta = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (sevDelta !== 0) return sevDelta
    return a.kind.localeCompare(b.kind)
  })

  const qualityScore = computeQualityScore(warnings)

  return {
    quality_score: qualityScore,
    warnings,
    signals,
  }
}

function computeSignals(pack: CompiledContextPack): ContextPackQualitySignals {
  const nodeCount = pack.nodes.length
  const relationshipCount = pack.relationships.length
  const claimCount = pack.claims.length

  let snippetNodes = 0
  let scoreSum = 0
  let scoreCount = 0
  for (const node of pack.nodes) {
    if (typeof node.snippet === 'string' && node.snippet.length > 0) snippetNodes += 1
    if (typeof node.match_score === 'number' && Number.isFinite(node.match_score)) {
      scoreSum += node.match_score
      scoreCount += 1
    }
  }

  const snippetCoverage = nodeCount === 0 ? 0 : snippetNodes / nodeCount
  const avgMatchScore = scoreCount === 0 ? Number.NaN : scoreSum / scoreCount
  const budget = pack.task_contract.budget
  const budgetUtilization = budget > 0 ? Math.min(1, pack.token_count / budget) : 0

  return {
    node_count: nodeCount,
    relationship_count: relationshipCount,
    claim_count: claimCount,
    snippet_coverage: snippetCoverage,
    avg_match_score: avgMatchScore,
    budget_utilization: budgetUtilization,
  }
}

function computeQualityScore(warnings: ContextPackDiagnosticWarning[]): number {
  let totalWeight = 0
  for (const weight of RULE_WEIGHTS.values()) totalWeight += weight
  if (totalWeight === 0) return 1
  let triggeredWeight = 0
  for (const warning of warnings) {
    triggeredWeight += RULE_WEIGHTS.get(warning.kind) ?? 1
  }
  const score = 1 - (triggeredWeight / totalWeight)
  return Math.max(0, Math.min(1, Number(score.toFixed(3))))
}
