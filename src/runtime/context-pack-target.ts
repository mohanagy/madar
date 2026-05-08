import type { RetrieveResult } from './retrieve.js'

export function pickImpactTarget(result: RetrieveResult): string {
  const directMatch = result.matched_nodes.find((node) => node.relevance_band === 'direct' && node.label.trim().length > 0)
  if (directMatch) {
    return directMatch.label
  }

  const bestMatch = [...result.matched_nodes]
    .sort((left, right) => (right.match_score ?? 0) - (left.match_score ?? 0))
    .find((node) => node.label.trim().length > 0)

  return bestMatch?.label ?? result.question
}
