import type { KnowledgeGraph } from '../contracts/graph.js'
import { graphDiff, type GraphDiffResult } from '../pipeline/analyze.js'
import { buildCommunityLabels } from '../pipeline/community-naming.js'
import { analyzeImpact, type ImpactTraversal } from './impact.js'
import { communitiesFromGraph } from './serve.js'

const DEFAULT_TIME_TRAVEL_LIMIT = 10
const timeTravelCommunityLabels = new WeakMap<TimeTravelResult, Record<number, string>>()

export type TimeTravelView = 'summary' | 'risk' | 'drift' | 'timeline'

export interface TimeTravelResult {
  fromRef: string
  toRef: string
  view: TimeTravelView
  summary: { headline: string; whyItMatters: string[] }
  changed: {
    nodesAdded: number
    nodesRemoved: number
    edgesAdded: number
    edgesRemoved: number
    communities: Array<{ community: number; changeCount: number }>
  }
  risk: { topImpacts: Array<{ label: string; node_id?: string; source_file?: string; graph_side?: 'before' | 'after'; transitiveDependents: number; traversal?: ImpactTraversal }> }
  drift: { movedNodes: Array<{ label: string; fromCommunity: number | null; toCommunity: number | null }> }
  timeline: { events: Array<{ kind: string; label: string; reason: string }> }
}

export interface CompareTimeTravelGraphsOptions {
  fromRef?: string
  toRef?: string
  view?: TimeTravelView
  limit?: number
  depth?: number
  edgeTypes?: string[]
}

function resolveLimit(limit?: number): number {
  return typeof limit === 'number' && Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_TIME_TRAVEL_LIMIT
}

function parseCommunityId(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw
  }
  if (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw))) {
    return Number(raw)
  }
  return null
}

function nodeLabel(graph: KnowledgeGraph, nodeId: string): string {
  return graph.hasNode(nodeId) ? String(graph.nodeAttributes(nodeId).label ?? nodeId) : nodeId
}

function nodeCommunity(graph: KnowledgeGraph, nodeId: string): number | null {
  if (!graph.hasNode(nodeId)) {
    return null
  }
  return parseCommunityId(graph.nodeAttributes(nodeId).community)
}

function storedCommunityLabelsFromGraph(graph: KnowledgeGraph): Record<number, string> {
  const rawLabels = graph.graph.community_labels
  if (!rawLabels || typeof rawLabels !== 'object' || Array.isArray(rawLabels)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(rawLabels as Record<string, unknown>)
      .map(([key, value]) => [Number(key), typeof value === 'string' ? value.trim() : ''] as const)
      .filter(([id, label]) => Number.isInteger(id) && id >= 0 && label.length > 0),
  )
}

function resolveCommunityLabels(graph: KnowledgeGraph): Record<number, string> {
  const communities = communitiesFromGraph(graph)
  return {
    ...buildCommunityLabels(graph, communities),
    ...storedCommunityLabelsFromGraph(graph),
  }
}

function communityName(labels: Record<number, string>, community: number | null): string {
  if (community === null) {
    return 'Unassigned'
  }
  return labels[community] ?? `Community ${community}`
}

type MovedNode = TimeTravelResult['drift']['movedNodes'][number] & { nodeId: string }

function movedNodes(beforeGraph: KnowledgeGraph, afterGraph: KnowledgeGraph): MovedNode[] {
  const moved: MovedNode[] = []

  for (const nodeId of beforeGraph.nodeIds()) {
    if (!afterGraph.hasNode(nodeId)) {
      continue
    }

    const fromCommunity = nodeCommunity(beforeGraph, nodeId)
    const toCommunity = nodeCommunity(afterGraph, nodeId)
    if (fromCommunity === toCommunity) {
      continue
    }

    moved.push({
      nodeId,
      label: nodeLabel(afterGraph, nodeId),
      fromCommunity,
      toCommunity,
    })
  }

  return moved.sort((left, right) => left.label.localeCompare(right.label))
}

function incrementCommunityChange(counts: Map<number, number>, community: number | null): void {
  if (community === null) {
    return
  }
  counts.set(community, (counts.get(community) ?? 0) + 1)
}

function summarizeChangedCommunities(
  diff: GraphDiffResult,
  beforeGraph: KnowledgeGraph,
  afterGraph: KnowledgeGraph,
  limit: number,
  moved: Array<{ label: string; fromCommunity: number | null; toCommunity: number | null }>,
): Array<{ community: number; changeCount: number }> {
  const counts = new Map<number, number>()

  for (const node of diff.new_nodes) {
    incrementCommunityChange(counts, nodeCommunity(afterGraph, node.id))
  }
  for (const node of diff.removed_nodes) {
    incrementCommunityChange(counts, nodeCommunity(beforeGraph, node.id))
  }
  for (const edge of diff.new_edges) {
    incrementCommunityChange(counts, nodeCommunity(afterGraph, edge.source))
    incrementCommunityChange(counts, nodeCommunity(afterGraph, edge.target))
  }
  for (const edge of diff.removed_edges) {
    incrementCommunityChange(counts, nodeCommunity(beforeGraph, edge.source))
    incrementCommunityChange(counts, nodeCommunity(beforeGraph, edge.target))
  }
  for (const node of moved) {
    incrementCommunityChange(counts, node.fromCommunity)
    incrementCommunityChange(counts, node.toCommunity)
  }

  return [...counts.entries()]
    .map(([community, changeCount]) => ({ community, changeCount }))
    .sort((left, right) => right.changeCount - left.changeCount || left.community - right.community)
    .slice(0, limit)
}

interface ChangedImpactTarget {
  nodeId: string
  side: 'before' | 'after'
}

function changedImpactTargets(
  diff: GraphDiffResult,
  moved: readonly MovedNode[],
): ChangedImpactTarget[] {
  const targets = new Map<string, ChangedImpactTarget>()
  const add = (nodeId: string, side: ChangedImpactTarget['side']): void => {
    targets.set(`${side}\0${nodeId}`, { nodeId, side })
  }

  for (const node of diff.new_nodes) {
    add(node.id, 'after')
  }
  for (const node of diff.removed_nodes) {
    add(node.id, 'before')
  }
  for (const node of moved) {
    add(node.nodeId, 'after')
  }
  for (const edge of diff.new_edges) {
    add(edge.source, 'after')
    add(edge.target, 'after')
  }
  for (const edge of diff.removed_edges) {
    add(edge.source, 'before')
    add(edge.target, 'before')
  }

  return [...targets.values()]
}

function riskView(
  beforeGraph: KnowledgeGraph,
  afterGraph: KnowledgeGraph,
  beforeCommunityLabels: Record<number, string>,
  afterCommunityLabels: Record<number, string>,
  targets: readonly ChangedImpactTarget[],
  options: CompareTimeTravelGraphsOptions,
  limit: number,
): TimeTravelResult['risk']['topImpacts'] {
  return targets
    .map(({ nodeId, side }) => {
      // A removed edge belongs to the old snapshot even when its owner survives.
      // Labels can be repeated in either snapshot and never choose an identity.
      const useAfterGraph = side === 'after'
      const impact = analyzeImpact(useAfterGraph ? afterGraph : beforeGraph, useAfterGraph ? afterCommunityLabels : beforeCommunityLabels, {
        nodeId,
        ...(options.depth !== undefined ? { depth: options.depth } : {}),
        ...(options.edgeTypes !== undefined ? { edgeTypes: options.edgeTypes } : {}),
      })

      return {
        label: impact.target,
        node_id: nodeId,
        source_file: impact.target_file,
        graph_side: side,
        transitiveDependents: impact.transitive_dependents.length,
        ...(impact.traversal && impact.traversal.status !== 'complete' ? { traversal: impact.traversal } : {}),
      }
    })
    .sort((left, right) => right.transitiveDependents - left.transitiveDependents || left.label.localeCompare(right.label)
      || left.node_id.localeCompare(right.node_id) || left.graph_side.localeCompare(right.graph_side))
    .slice(0, limit)
}

function timelineView(
  diff: GraphDiffResult,
  beforeGraph: KnowledgeGraph,
  afterGraph: KnowledgeGraph,
  moved: Array<{ label: string; fromCommunity: number | null; toCommunity: number | null }>,
  communityLabels: Record<number, string>,
  limit: number,
): Array<{ kind: string; label: string; reason: string }> {
  const events: Array<{ kind: string; label: string; reason: string }> = []

  for (const node of moved) {
    events.push({
      kind: 'community_moved',
      label: node.label,
      reason: `${communityName(communityLabels, node.fromCommunity)} → ${communityName(communityLabels, node.toCommunity)}`,
    })
  }
  for (const node of diff.new_nodes) {
    events.push({
      kind: 'node_added',
      label: node.label,
      reason: `added in ${communityName(communityLabels, nodeCommunity(afterGraph, node.id))}`,
    })
  }
  for (const node of diff.removed_nodes) {
    events.push({
      kind: 'node_removed',
      label: node.label,
      reason: `removed from ${communityName(communityLabels, nodeCommunity(beforeGraph, node.id))}`,
    })
  }
  for (const edge of diff.new_edges) {
    events.push({
      kind: 'edge_added',
      label: `${nodeLabel(afterGraph, edge.source)} → ${nodeLabel(afterGraph, edge.target)}`,
      reason: `${edge.relation || 'related_to'} relation added`,
    })
  }
  for (const edge of diff.removed_edges) {
    events.push({
      kind: 'edge_removed',
      label: `${nodeLabel(beforeGraph, edge.source)} → ${nodeLabel(beforeGraph, edge.target)}`,
      reason: `${edge.relation || 'related_to'} relation removed`,
    })
  }

  return events.slice(0, limit)
}

export function compareTimeTravelGraphs(
  beforeGraph: KnowledgeGraph,
  afterGraph: KnowledgeGraph,
  options: CompareTimeTravelGraphsOptions = {},
): TimeTravelResult {
  const limit = resolveLimit(options.limit)
  const fromRef = options.fromRef?.trim() || 'before'
  const toRef = options.toRef?.trim() || 'after'
  const view = options.view ?? 'summary'
  const diff = graphDiff(beforeGraph, afterGraph)
  const drift = movedNodes(beforeGraph, afterGraph)
  const beforeCommunityLabels = resolveCommunityLabels(beforeGraph)
  const afterCommunityLabels = resolveCommunityLabels(afterGraph)
  const communityLabels = {
    ...beforeCommunityLabels,
    ...afterCommunityLabels,
  }
  const changedCommunities = summarizeChangedCommunities(diff, beforeGraph, afterGraph, limit, drift)
  const targets = changedImpactTargets(diff, drift)
  const topImpacts = riskView(beforeGraph, afterGraph, beforeCommunityLabels, afterCommunityLabels, targets, options, limit)

  const result: TimeTravelResult = {
    fromRef,
    toRef,
    view,
    summary: {
      headline: `Graph changed from ${fromRef} to ${toRef}: ${diff.summary}`,
      whyItMatters: [
        `Before: ${beforeGraph.numberOfNodes()} nodes / ${beforeGraph.numberOfEdges()} edges; after: ${afterGraph.numberOfNodes()} nodes / ${afterGraph.numberOfEdges()} edges.`,
        changedCommunities.length > 0
          ? `Changed communities: ${changedCommunities.map((community) => communityName(communityLabels, community.community)).join(', ')}.`
          : 'No community-level drift detected.',
        topImpacts.length > 0
          ? `Top risk: ${topImpacts[0]!.label} reaches ${topImpacts[0]!.traversal ? 'at least ' : ''}${topImpacts[0]!.transitiveDependents} transitive dependents.`
          : 'No risky changed labels detected.',
      ],
    },
    changed: {
      nodesAdded: diff.new_nodes.length,
      nodesRemoved: diff.removed_nodes.length,
      edgesAdded: diff.new_edges.length,
      edgesRemoved: diff.removed_edges.length,
      communities: changedCommunities,
    },
    risk: {
      topImpacts,
    },
    drift: {
      movedNodes: drift.slice(0, limit).map(({ nodeId: _nodeId, ...node }) => node),
    },
    timeline: {
      events: timelineView(diff, beforeGraph, afterGraph, drift, communityLabels, limit),
    },
  }

  timeTravelCommunityLabels.set(result, communityLabels)
  return result
}

function formatChangedCommunities(
  communities: Array<{ community: number; changeCount: number }>,
  labels: Record<number, string>,
): string[] {
  if (communities.length === 0) {
    return ['Changed communities: none']
  }

  return ['Changed communities:', ...communities.map((community) => `  - ${communityName(labels, community.community)} (${community.changeCount})`)]
}

export function formatTimeTravelResult(result: TimeTravelResult): string {
  const header = `Time travel ${result.fromRef} → ${result.toRef}`
  const communityLabels = timeTravelCommunityLabels.get(result) ?? {}

  switch (result.view) {
    case 'risk':
      return [
        header,
        'Top impact risks:',
        ...(result.risk.topImpacts.length > 0
          ? result.risk.topImpacts.map((impact) => `  - ${impact.label}: ${impact.traversal && impact.traversal.status !== 'complete' ? 'at least ' : ''}${impact.transitiveDependents} transitive dependents${impact.traversal && impact.traversal.status !== 'complete' ? ` (${impact.traversal.status})` : ''}`)
          : ['  - none']),
      ].join('\n')
    case 'drift':
      return [
        header,
        'Community drift:',
        ...(result.drift.movedNodes.length > 0
          ? result.drift.movedNodes.map((node) => `  - ${node.label}: ${communityName(communityLabels, node.fromCommunity)} → ${communityName(communityLabels, node.toCommunity)}`)
          : ['  - none']),
      ].join('\n')
    case 'timeline':
      return [
        header,
        'Timeline events:',
        ...(result.timeline.events.length > 0 ? result.timeline.events.map((event) => `  - [${event.kind}] ${event.label}: ${event.reason}`) : ['  - none']),
      ].join('\n')
    case 'summary':
    default:
      return [
        header,
        result.summary.headline,
        ...result.summary.whyItMatters.map((line) => `- ${line}`),
        `Nodes: +${result.changed.nodesAdded} / -${result.changed.nodesRemoved}`,
        `Edges: +${result.changed.edgesAdded} / -${result.changed.edgesRemoved}`,
        ...formatChangedCommunities(result.changed.communities, communityLabels),
      ].join('\n')
  }
}
