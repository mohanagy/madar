import { KnowledgeGraph } from '../../contracts/graph.js'
import { nodeAnchorId, type OverviewCommunityPageMode } from './overview-bridges.js'

export interface OverviewTopNode {
  id: string
  label: string
  degree: number
  href: string
}

export interface OverviewSearchIndexEntry {
  label: string
  source_file: string
  community_name: string
  href: string
}

export interface OverviewSearchNode {
  id: string
  label: string
  source_file: string
  community_name: string
  community: number
}

function overviewNodeHref(communityPagesDirname: string, communityId: number, nodeId: string, pageMode: OverviewCommunityPageMode | undefined): string {
  return `${communityPagesDirname}/community-${communityId}.html#${pageMode === 'summary' ? nodeAnchorId(nodeId) : encodeURIComponent(nodeId)}`
}

/**
 * Display ordering: the overview navigation is HTML for a person to read, never
 * parsed back by Madar, so collation is the right order and `localeCompare`
 * stays in both label sorts in this file -- the top-node tie-break below and the
 * search-index sort in `buildOverviewSearchIndex`. Persisted collections order by
 * code point -- see `compareUnicodeCodePoints` in src/contracts/canonical-json.ts.
 */
export function buildOverviewTopNodes(
  graph: KnowledgeGraph,
  nodeIds: string[],
  communityId: number,
  pageMode: OverviewCommunityPageMode,
  communityPagesDirname: string,
): OverviewTopNode[] {
  return [...nodeIds]
    .map((nodeId) => ({
      id: nodeId,
      label: String(graph.nodeAttributes(nodeId).label ?? nodeId),
      degree: graph.uniqueNeighborDegree(nodeId),
      href: overviewNodeHref(communityPagesDirname, communityId, nodeId, pageMode),
    }))
    .sort((left, right) => right.degree - left.degree || left.label.localeCompare(right.label))
    .slice(0, 4)
}

export function buildOverviewSearchIndex(
  nodes: OverviewSearchNode[],
  communityPageModes: ReadonlyMap<number, OverviewCommunityPageMode>,
  communityPagesDirname: string,
): OverviewSearchIndexEntry[] {
  return nodes
    .map((node) => ({
      label: node.label,
      source_file: node.source_file,
      community_name: node.community_name,
      href: overviewNodeHref(communityPagesDirname, node.community, node.id, communityPageModes.get(node.community)),
    }))
    .sort((left, right) => left.label.localeCompare(right.label))
}
