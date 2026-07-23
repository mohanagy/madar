import type { GraphEdge } from '../graph/directed-multigraph.js'
import type { QueryGraph, ReadyQueryIndex } from './index-status.js'
import type {
  EvidenceBoundary,
  QueryPathEdge,
  QuerySlice,
  RankedQueryNode,
  RankQueryResult,
} from './types.js'

const MAX_TRAVERSAL_HOPS = 8
const MAX_VISITED_NODES_PER_PAIR = 5_000

interface AnchorPair {
  source: RankedQueryNode
  target: RankedQueryNode
}

interface TraversalState {
  pairIndex: number
  nodeId: string
  depth: number
}

interface PathPredecessor {
  nodeId: string
  edge: QueryPathEdge
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

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
  return {
    id: edge.id,
    from: edge.source,
    to: edge.target,
    relation,
    attributes: edge.attributes,
  }
}

function outgoingEdges(
  graph: QueryGraph,
  nodeId: string,
  queryTerms: ReadonlySet<string>,
): QueryPathEdge[] {
  return graph.successors(nodeId)
    .flatMap((targetId) => graph.edgesBetween(nodeId, targetId))
    .map(asPathEdge)
    .sort((left, right) => {
      const leftMentioned = queryMentionsRelation(left.relation, queryTerms)
      const rightMentioned = queryMentionsRelation(right.relation, queryTerms)
      if (leftMentioned !== rightMentioned) return leftMentioned ? -1 : 1
      return compareText(left.to, right.to)
        || compareText(left.relation, right.relation)
        || compareText(left.id, right.id)
    })
}

function reconstructPath(
  sourceId: string,
  targetId: string,
  predecessors: ReadonlyMap<string, PathPredecessor>,
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

function boundaryKey(boundary: EvidenceBoundary): string {
  return `${boundary.kind}\u0000${boundary.subject}\u0000${boundary.detail ?? ''}`
}

function dedupeBoundaries(boundaries: readonly EvidenceBoundary[]): EvidenceBoundary[] {
  const seen = new Set<string>()
  return boundaries.filter((boundary) => {
    const key = boundaryKey(boundary)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function validAnchors(
  graph: QueryGraph,
  ranking: RankQueryResult,
  boundaries: EvidenceBoundary[],
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

/**
 * Connects query-ordered anchors through stored outgoing graph edges.
 *
 * All adjacent anchor pairs share one BFS queue. This is the query pipeline's
 * only closure pass; it neither reverses edges nor synthesizes handoffs.
 */
export function traverseEvidencePaths(
  index: ReadyQueryIndex,
  ranking: RankQueryResult,
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

  const pairs: AnchorPair[] = anchors.slice(0, -1).map((source, pairIndex) => ({
    source,
    target: anchors[pairIndex + 1]!,
  }))
  const visited = pairs.map((pair) => new Set([pair.source.id]))
  const predecessors = pairs.map(() => new Map<string, PathPredecessor>())
  const paths: Array<QueryPathEdge[] | undefined> = Array.from({ length: pairs.length })
  const searchTruncated = pairs.map(() => false)
  const queue: TraversalState[] = pairs.map((pair, pairIndex) => ({
    pairIndex,
    nodeId: pair.source.id,
    depth: 0,
  }))
  const queryTerms = new Set(ranking.queryTerms.map((term) => term.toLowerCase()))
  let unresolved = pairs.length

  for (let cursor = 0; cursor < queue.length && unresolved > 0; cursor += 1) {
    const state = queue[cursor]!
    if (paths[state.pairIndex] !== undefined) continue
    const pair = pairs[state.pairIndex]!
    const pairVisited = visited[state.pairIndex]!
    const outgoing = outgoingEdges(index.graph, state.nodeId, queryTerms)
    if (state.depth >= MAX_TRAVERSAL_HOPS) {
      if (outgoing.some((edge) => !pairVisited.has(edge.to))) {
        searchTruncated[state.pairIndex] = true
      }
      continue
    }
    if (pairVisited.size >= MAX_VISITED_NODES_PER_PAIR) {
      if (outgoing.some((edge) => !pairVisited.has(edge.to))) {
        searchTruncated[state.pairIndex] = true
      }
      continue
    }
    const pairPredecessors = predecessors[state.pairIndex]!

    for (const edge of outgoing) {
      if (pairVisited.has(edge.to)) continue
      if (pairVisited.size >= MAX_VISITED_NODES_PER_PAIR) {
        searchTruncated[state.pairIndex] = true
        break
      }
      pairVisited.add(edge.to)
      pairPredecessors.set(edge.to, { nodeId: state.nodeId, edge })
      if (edge.to === pair.target.id) {
        paths[state.pairIndex] = reconstructPath(
          pair.source.id,
          pair.target.id,
          pairPredecessors,
        )
        unresolved -= 1
        break
      }
      queue.push({
        pairIndex: state.pairIndex,
        nodeId: edge.to,
        depth: state.depth + 1,
      })
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

  for (const [pairIndex, pair] of pairs.entries()) {
    includeNode(pair.source.id)
    const path = paths[pairIndex]
    if (!path) {
      includeNode(pair.target.id)
      boundaries.push({
        kind: searchTruncated[pairIndex] ? 'truncated' : 'disconnected',
        subject: `${pair.source.id} -> ${pair.target.id}`,
        detail: searchTruncated[pairIndex]
          ? 'directed evidence search reached its traversal limit'
          : 'no directed evidence path connects these query anchors',
      })
      continue
    }
    for (const edge of path) {
      includeNode(edge.from)
      includeNode(edge.to)
      if (seenEdges.has(edge.id)) continue
      seenEdges.add(edge.id)
      edges.push(edge)
    }
  }
  for (const anchor of anchors) includeNode(anchor.id)

  return {
    nodeIds,
    edges,
    boundaries: dedupeBoundaries(boundaries),
    closurePasses: 1,
  }
}
