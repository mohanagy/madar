import { compareCodeUnits } from '../graph/canonical-json.js'
import type { GraphEdge } from '../graph/directed-multigraph.js'
import type { QueryGraph, ReadyQueryIndex } from './index-status.js'
import type {
  EvidenceBoundary, QueryPathEdge, QuerySlice, RankedQueryNode, RankQueryResult,
} from './types.js'

interface TraversalState { sourceIndex: number; nodeId: string }
interface PathPredecessor { nodeId: string; edge: QueryPathEdge }

function normalizedRelationTerms(value: string): string[] {
  const normalized = value.toLowerCase()
  return [normalized, ...normalized.split(/[^a-z0-9]+/u)]
    .filter((term, index, terms) => term.length > 0 && terms.indexOf(term) === index)
}

function queryMentionsRelation(relation: string, queryTerms: ReadonlySet<string>): boolean {
  const terms = normalizedRelationTerms(relation)
  return queryTerms.has(terms[0]!)
    || (terms.length > 1 && terms.slice(1).every((term) => queryTerms.has(term)))
}

function asPathEdge(edge: GraphEdge): QueryPathEdge {
  const relation = edge.attributes.relation
  if (typeof relation !== 'string' || relation.length === 0) {
    throw new Error(`Graph edge ${edge.id} has no relation`)
  }
  return { id: edge.id, from: edge.source, to: edge.target, relation, attributes: edge.attributes }
}

function allowedEvidenceEdge(graph: QueryGraph, edge: QueryPathEdge): boolean {
  const from = graph.nodeAttributes(edge.from)
  const to = graph.nodeAttributes(edge.to)
  const fromFile = from.node_kind === 'file'
  const toFile = to.node_kind === 'file'
  if ((!fromFile && (!from.definition_range || !from.declaration_range))
    || (!toFile && (!to.definition_range || !to.declaration_range))) return false
  if (edge.relation === 'contains') {
    return fromFile && !toFile && from.source_file === to.source_file
  }
  if (fromFile || toFile) return edge.relation === 'imports_from' && fromFile && toFile
  return edge.relation === 'calls' || edge.relation === 'enqueues_job'
}

function outgoingEdges(
  graph: QueryGraph, nodeId: string, queryTerms: ReadonlySet<string>,
): QueryPathEdge[] {
  return graph.successors(nodeId)
    .flatMap((targetId) => graph.edgesBetween(nodeId, targetId))
    .map(asPathEdge)
    .filter((edge) => allowedEvidenceEdge(graph, edge))
    .sort((left, right) => {
      const leftMentioned = queryMentionsRelation(left.relation, queryTerms)
      const rightMentioned = queryMentionsRelation(right.relation, queryTerms)
      if (leftMentioned !== rightMentioned) return leftMentioned ? -1 : 1
      const line = (edge: QueryPathEdge): number =>
        Number(String(edge.attributes.source_location ?? '').match(/\d+/)?.[0] ?? Number.MAX_SAFE_INTEGER)
      return line(left) - line(right)
        || compareCodeUnits(left.to, right.to)
        || compareCodeUnits(left.relation, right.relation)
        || compareCodeUnits(left.id, right.id)
    })
}

function reconstructPath(
  sourceId: string, targetId: string, predecessors: ReadonlyMap<string, PathPredecessor>,
): QueryPathEdge[] {
  const reversed: QueryPathEdge[] = []
  let currentId = targetId
  while (currentId !== sourceId) {
    const predecessor = predecessors.get(currentId)
    if (!predecessor) {
      throw new Error(`Traversal predecessor missing for ${sourceId} -> ${targetId}`)
    }
    reversed.push(predecessor.edge)
    currentId = predecessor.nodeId
  }
  return reversed.reverse()
}

function dedupeBoundaries(boundaries: readonly EvidenceBoundary[]): EvidenceBoundary[] {
  const seen = new Set<string>()
  return boundaries.filter((boundary) => {
    const key = `${boundary.kind}\u0000${boundary.subject}\u0000${boundary.detail ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function validAnchors(
  graph: QueryGraph, ranking: RankQueryResult, boundaries: EvidenceBoundary[],
): RankedQueryNode[] {
  const seen = new Set<string>()
  return ranking.anchors.filter((anchor) => {
    if (!graph.hasNode(anchor.id)) {
      boundaries.push({
        kind: 'corrupt',
        subject: anchor.id,
        detail: 'ranked anchor is absent from the authoritative graph',
      })
      return false
    }
    if (seen.has(anchor.id)) return false
    seen.add(anchor.id)
    return true
  })
}

export function traverseEvidencePaths(
  index: ReadyQueryIndex, ranking: RankQueryResult,
): QuerySlice {
  const boundaries = [...ranking.boundaries]
  const anchors = validAnchors(index.graph, ranking, boundaries)
  if (anchors.length <= 1) {
    return {
      nodeIds: anchors.map((anchor) => anchor.id),
      edges: [],
      boundaries: dedupeBoundaries(boundaries),
      closurePasses: 0,
    }
  }

  const sources = anchors.slice(0, -1).map((source, sourceIndex) => ({
    source,
    targets: anchors.slice(sourceIndex + 1),
  }))
  const visited = sources.map(({ source }) => new Set([source.id]))
  const predecessors = sources.map(() => new Map<string, PathPredecessor>())
  const paths = sources.map(() => new Map<string, QueryPathEdge[]>())
  const queue: TraversalState[] = sources.map(({ source }, sourceIndex) => ({
    sourceIndex,
    nodeId: source.id,
  }))
  const queryTerms = new Set(ranking.queryTerms.map((term) => term.toLowerCase()))

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const state = queue[cursor]!
    const search = sources[state.sourceIndex]!
    const found = paths[state.sourceIndex]!
    if (found.size === search.targets.length) continue
    const sourceVisited = visited[state.sourceIndex]!
    const outgoing = outgoingEdges(index.graph, state.nodeId, queryTerms)
    const sourcePredecessors = predecessors[state.sourceIndex]!

    for (const edge of outgoing) {
      if (sourceVisited.has(edge.to)) continue
      sourceVisited.add(edge.to)
      sourcePredecessors.set(edge.to, { nodeId: state.nodeId, edge })
      if (search.targets.some((target) => target.id === edge.to)) {
        found.set(edge.to, reconstructPath(search.source.id, edge.to, sourcePredecessors))
      }
      queue.push({ sourceIndex: state.sourceIndex, nodeId: edge.to })
    }
  }

  const nodeIds: string[] = []
  const edges: QueryPathEdge[] = []
  const seenNodes = new Set<string>()
  const seenEdges = new Set<string>()
  const includeNode = (nodeId: string): void => {
    if (seenNodes.has(nodeId)) return
    seenNodes.add(nodeId)
    nodeIds.push(nodeId)
  }
  for (const anchor of anchors) includeNode(anchor.id)

  for (const [sourceIndex, search] of sources.entries()) {
    for (const [targetIndex, target] of search.targets.entries()) {
      const path = paths[sourceIndex]!.get(target.id)
      const coveredByAdjacentPaths = targetIndex > 0
        && anchors.slice(sourceIndex, sourceIndex + targetIndex + 1).every((_, offset) =>
          paths[sourceIndex + offset]!.has(anchors[sourceIndex + offset + 1]!.id))
      if (coveredByAdjacentPaths) continue
      if (!path && targetIndex === 0) {
        boundaries.push({
          kind: 'disconnected',
          subject: `${search.source.id} -> ${target.id}`,
          detail: 'no directed evidence path connects these query anchors',
        })
      }
      for (const edge of path ?? []) {
        includeNode(edge.from)
        includeNode(edge.to)
        if (seenEdges.has(edge.id)) continue
        seenEdges.add(edge.id)
        edges.push(edge)
      }
    }
  }

  return { nodeIds, edges, boundaries: dedupeBoundaries(boundaries), closurePasses: 1 }
}
