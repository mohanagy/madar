// Value-per-token budget selector (#74).
//
// Pure helper that ranks a candidate set by score / token_cost ratio (the
// classical density heuristic used in the bounded-knapsack approximation)
// and picks the prefix that fits within a token budget.
//
// Why density rather than raw relevance: the budgeted context-pack
// surface (#74) is "how much information per token of context can we
// afford?" — a 2x-relevance node that costs 4x the tokens is worse than
// two ~1x-relevance nodes that fit in the same budget.
//
// This module is intentionally generic so the retrieve.ts surface can
// adopt it incrementally without coupling to a concrete node shape: the
// caller provides any T plus a relevance scorer and a token-cost
// estimator; the helper returns the selected subset, the budget remaining,
// and per-item debug info (rank, density, included).
//
// Out of scope for this slice:
//   * Per-evidence-class quotas — already enforced upstream in
//     compileContextPack via the task contract's required_evidence list.
//     The value-per-token selector runs WITHIN the candidate pool a
//     given recipe class has already been narrowed to.
//   * Submodular selection (diversity bonuses for non-redundant
//     candidates). The current scorer treats each candidate as a single
//     independent item; submodular variants land later when measurement
//     shows a regression on real corpora.

export interface ValuePerTokenCandidate<T> {
  /** Stable identity for dedup + reporting. */
  id: string
  /** The underlying payload returned to the caller in `selected`. */
  payload: T
  /** Caller-computed relevance score; the only constraint is that higher
   *  values mean MORE relevant. Normalized internally. */
  score: number
  /** Estimated token cost of including the payload in the final pack.
   *  Must be > 0; zero-cost items are pinned (always included). */
  token_cost: number
}

export interface ValuePerTokenResult<T> {
  /** Selected candidates in selection order (density-descending). */
  selected: ValuePerTokenCandidate<T>[]
  /** Token cost of the selected set. */
  total_cost: number
  /** Token cost remaining under the budget. */
  remaining_budget: number
  /** Per-candidate breakdown — useful for diagnostics and replay. */
  ranking: Array<{
    id: string
    score: number
    token_cost: number
    density: number
    rank: number
    included: boolean
  }>
}

export interface ValuePerTokenOptions {
  /** Maximum total token cost the selection may consume. Items already
   *  costing more than the budget on their own are skipped — they
   *  cannot fit by definition. */
  budget: number
  /** When true, items with `token_cost === 0` are unconditionally
   *  included regardless of budget. Useful for cost-free metadata that
   *  carries information density bonuses (anchors, claims). Default true. */
  pinZeroCost?: boolean
}

/** Select a subset of candidates that maximises Σ score subject to
 *  Σ token_cost ≤ budget, using the greedy density heuristic. Returns
 *  selection plus per-candidate rank info. Deterministic — ties resolved
 *  by score desc, then token_cost asc, then id asc. */
export function selectByValuePerToken<T>(
  candidates: ReadonlyArray<ValuePerTokenCandidate<T>>,
  options: ValuePerTokenOptions,
): ValuePerTokenResult<T> {
  const pinZeroCost = options.pinZeroCost ?? true
  const budget = Math.max(0, options.budget)

  // Annotate with density and sort descending. Skip items that can never
  // fit (cost > budget AND not pinnable). Skip non-finite scores/costs.
  const annotated = candidates
    .filter((c) => Number.isFinite(c.score) && Number.isFinite(c.token_cost) && c.token_cost >= 0)
    .map((c) => ({
      candidate: c,
      density: c.token_cost === 0 ? Number.POSITIVE_INFINITY : c.score / c.token_cost,
    }))
    .sort((a, b) => {
      if (a.density !== b.density) return b.density - a.density
      if (a.candidate.score !== b.candidate.score) return b.candidate.score - a.candidate.score
      if (a.candidate.token_cost !== b.candidate.token_cost) {
        return a.candidate.token_cost - b.candidate.token_cost
      }
      return a.candidate.id.localeCompare(b.candidate.id)
    })

  const selected: ValuePerTokenCandidate<T>[] = []
  const ranking: ValuePerTokenResult<T>['ranking'] = []
  let consumed = 0

  annotated.forEach(({ candidate, density }, index) => {
    let included = false
    if (candidate.token_cost === 0) {
      // Zero-cost candidates are gated on pinZeroCost. The default
      // (pinZeroCost=true) ALWAYS includes them; turning it off lets
      // callers exclude free items they don't actually want.
      if (pinZeroCost) {
        selected.push(candidate)
        included = true
      }
    } else if (consumed + candidate.token_cost <= budget) {
      selected.push(candidate)
      consumed += candidate.token_cost
      included = true
    }
    ranking.push({
      id: candidate.id,
      score: candidate.score,
      token_cost: candidate.token_cost,
      density,
      rank: index + 1,
      included,
    })
  })

  return {
    selected,
    total_cost: consumed,
    remaining_budget: Math.max(0, budget - consumed),
    ranking,
  }
}
