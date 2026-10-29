import type { RetrieveResult } from './retrieve.js'

export function pickImpactTargetIdentity(result: RetrieveResult): { label: string; nodeId?: string } {
  const directMatch = result.matched_nodes.find((node) => node.relevance_band === 'direct' && node.label.trim().length > 0)
  const bestMatch = directMatch ?? [...result.matched_nodes]
    .sort((left, right) => (right.match_score ?? 0) - (left.match_score ?? 0))
    .find((node) => node.label.trim().length > 0)

  return {
    label: bestMatch?.label.trim() ?? result.question,
    ...(bestMatch?.node_id ? { nodeId: bestMatch.node_id } : {}),
  }
}

export function pickImpactTarget(result: RetrieveResult): string {
  return pickImpactTargetIdentity(result).label
}
