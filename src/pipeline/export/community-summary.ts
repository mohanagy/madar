import { nodeAnchorId } from './overview-bridges.js'

export interface CommunitySummarySourceNode {
  id: string
  label: string
  source_file: string
  source_location: string
  safe_source_url: string
  file_type: string
  degree: number
  global_degree?: number
  connected_communities?: string[]
  confidence: string
}

export interface CommunitySummaryNode {
  id: string
  anchor_id: string
  label: string
  source_file: string
  source_location: string
  safe_source_url: string
  file_type: string
  degree: number
  global_degree?: number
  connected_communities?: string[]
  confidence: string
  search_text: string
}

export interface CommunitySummaryData {
  summaryNodes: CommunitySummaryNode[]
  topNodes: CommunitySummaryNode[]
  topFiles: Array<[string, number]>
}

/**
 * Display ordering: these tie-breaks shape the generated community pages, which
 * are written for a person to read and are never parsed back by Madar. Collation
 * is the right order there, so `localeCompare` stays. Persisted collections order
 * by code point -- see `compareUnicodeCodePoints` in src/contracts/canonical-json.ts.
 */
export function buildCommunitySummaryData(nodes: CommunitySummarySourceNode[]): CommunitySummaryData {
  const sortedNodes = [...nodes].sort((left, right) => right.degree - left.degree || left.label.localeCompare(right.label))
  const summaryNodes = sortedNodes.map((node) => ({
    id: node.id,
    anchor_id: nodeAnchorId(node.id),
    label: node.label,
    source_file: node.source_file,
    source_location: node.source_location,
    safe_source_url: node.safe_source_url,
    file_type: node.file_type,
    degree: node.degree,
    ...(typeof node.global_degree === 'number' ? { global_degree: node.global_degree } : {}),
    ...(Array.isArray(node.connected_communities) && node.connected_communities.length > 0
      ? { connected_communities: [...node.connected_communities] }
      : {}),
    confidence: node.confidence,
    search_text: `${node.label} ${node.source_file} ${node.source_location} ${node.file_type}`.toLowerCase(),
  }))
  const topNodes = summaryNodes.slice(0, 12)
  const topFiles = [...sortedNodes.reduce((counts, node) => {
    const sourceFile = node.source_file || '(unknown source)'
    counts.set(sourceFile, (counts.get(sourceFile) ?? 0) + 1)
    return counts
  }, new Map<string, number>()).entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 12)

  return { summaryNodes, topNodes, topFiles }
}
