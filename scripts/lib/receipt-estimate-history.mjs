import { existsSync, readFileSync } from 'node:fs'

/**
 * Carries a prior `superseded_estimate` across a regeneration.
 *
 * The corrected paired estimator replaced figures that had been published, and
 * every migrated receipt records what it superseded so the change is auditable
 * rather than silent. This runner produces the corrected fields but knows
 * nothing about that history, so regenerating a migrated receipt in place would
 * quietly delete it -- and `receipt-paired-estimator.test.ts` requires the field
 * on every tracked paired comparison, so the evidence contract would fail on
 * the next run rather than at the moment the history was lost.
 *
 * Matching is by corpus scope, which is what identifies a comparison within a
 * receipt. A scope the previous file did not contain simply carries nothing.
 */
export function carryForwardSupersededEstimates(renderedJson, outPath) {
  if (!existsSync(outPath)) return renderedJson
  let previous
  try {
    previous = JSON.parse(readFileSync(outPath, 'utf8'))
  } catch {
    // An unreadable previous receipt is not a reason to fail a fresh
    // measurement; it only means there is no history to carry.
    return renderedJson
  }
  const retained = new Map()
  for (const comparison of previous?.performance?.comparisons ?? []) {
    if (comparison?.superseded_estimate && comparison.corpus_scope) {
      retained.set(comparison.corpus_scope, comparison.superseded_estimate)
    }
  }
  if (retained.size === 0) return renderedJson

  const next = JSON.parse(renderedJson)
  for (const comparison of next?.performance?.comparisons ?? []) {
    const carried = retained.get(comparison.corpus_scope)
    if (carried !== undefined && comparison.superseded_estimate === undefined) {
      comparison.superseded_estimate = carried
    }
  }
  return JSON.stringify(next, null, 2)
}
