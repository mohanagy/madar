import { compareCodeUnits as compare } from '../graph/canonical-json.js'
import type { GraphEdge } from '../graph/directed-multigraph.js'
import type { QueryGraph, ReadyQueryIndex } from './index-status.js'
import type {
  EvidenceBoundary, QueryPathEdge, QuerySlice, RankedQueryNode, RankQueryResult,
} from './types.js'
import { sourceDomainOf as domainOf } from './source-domain.js'

interface TraversalState { origin: number; nodeId: string }
interface PathPredecessor { nodeId: string; edge: QueryPathEdge }
function relationWords(value: string): string[] {
  const normalized = value.toLowerCase()
  return [normalized, ...normalized.split(/[^a-z0-9]+/u)]
    .filter((term, index, terms) => term.length > 0 && terms.indexOf(term) === index)
}
function mentions(relation: string, queryTerms: ReadonlySet<string>): boolean {
  const terms = relationWords(relation)
  return queryTerms.has(terms[0]!)
    || (terms.length > 1 && terms.slice(1).every((term) => queryTerms.has(term)))
}

function pathEdge(edge: GraphEdge): QueryPathEdge {
  const relation = edge.attributes.relation
  if (typeof relation !== 'string' || relation.length === 0) {
    throw new Error(`Graph edge ${edge.id} has no relation`)
  }
  return { id: edge.id, from: edge.source, to: edge.target, relation, attributes: edge.attributes }
}

function allowed(graph: QueryGraph, edge: QueryPathEdge): boolean {
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

function outgoing(
  graph: QueryGraph, nodeId: string, terms: ReadonlySet<string>,
): QueryPathEdge[] {
  return graph.successors(nodeId)
    .flatMap((targetId) => graph.edgesBetween(nodeId, targetId))
    .map(pathEdge)
    .filter((edge) => allowed(graph, edge))
    .sort((left, right) => {
      const leftMentioned = mentions(left.relation, terms)
      const rightMentioned = mentions(right.relation, terms)
      if (leftMentioned !== rightMentioned) return leftMentioned ? -1 : 1
      const line = (edge: QueryPathEdge): number =>
        Number(String(edge.attributes.source_location ?? '').match(/\d+/)?.[0] ?? Number.MAX_SAFE_INTEGER)
      return line(left) - line(right)
        || compare(left.to, right.to)
        || compare(left.relation, right.relation)
        || compare(left.id, right.id)
    })
}

function direct(
  graph: QueryGraph,
  from: string,
  to: string,
): boolean {
  return graph.edgesBetween(from, to)
    .map(pathEdge)
    .some((edge) => allowed(graph, edge))
}

function rebuild(
  sourceId: string, targetId: string, parents: ReadonlyMap<string, PathPredecessor>,
): QueryPathEdge[] {
  const reversed: QueryPathEdge[] = []
  let currentId = targetId
  while (currentId !== sourceId) {
    const predecessor = parents.get(currentId)
    if (!predecessor) {
      throw new Error(`Traversal predecessor missing for ${sourceId} -> ${targetId}`)
    }
    reversed.push(predecessor.edge)
    currentId = predecessor.nodeId
  }
  return reversed.reverse()
}

function unique(boundaries: readonly EvidenceBoundary[]): EvidenceBoundary[] {
  const seen = new Set<string>()
  return boundaries.filter((boundary) => {
    const key = `${boundary.kind}\u0000${boundary.subject}\u0000${boundary.detail ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function verify(graph: QueryGraph, nodeId: string): string {
  const attributes = graph.nodeAttributes(nodeId)
  return [attributes.source_file, attributes.source_location]
    .filter((value): value is string =>
      typeof value === 'string' && value.length > 0)
    .join(':') || nodeId
}

function valid(
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
  const facts = [...ranking.boundaries]
  const anchors = valid(index.graph, ranking, facts)
  if (anchors.length <= 1) {
    return {
      nodeIds: anchors.map((anchor) => anchor.id),
      edges: [],
      boundaries: unique(facts),
      closurePasses: 0,
    }
  }

  const branches = new Set(ranking.branch)
  const chain = anchors.filter(({ id }) => !branches.has(id))
  const sources = chain.slice(0, -1).map((source, origin) => ({
    source,
    targets: ranking.flow
      ? [
        chain[origin + 1]!,
        ...anchors.slice(
          anchors.indexOf(source) + 1,
          anchors.indexOf(chain[origin + 1]!),
        ).filter(({ id }) => branches.has(id)),
      ]
      : anchors.slice(anchors.indexOf(source) + 1),
  }))
  const visited = sources.map(({ source }) => new Set([source.id]))
  const parents = sources.map(() => new Map<string, PathPredecessor>())
  const paths = sources.map(() => new Map<string, QueryPathEdge[]>())
  const queue: TraversalState[] = sources.map(({ source }, origin) => ({
    origin,
    nodeId: source.id,
  }))
  const terms = new Set(ranking.queryTerms.map((term) => term.toLowerCase()))
  const forest = !ranking.sequential
  const domain = (id: string) => {
    const a = index.graph.nodeAttributes(id)
    return domainOf(a.source_domain, String(a.source_file ?? ''), index.root_path)
  }
  const domains = new Set([
    'production', 'unknown', ...anchors.map(({ id }) => domain(id)),
  ])

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const state = queue[cursor]!
    const search = sources[state.origin]!
    const found = paths[state.origin]!
    if (found.size === search.targets.length) continue
    const seen = visited[state.origin]!
    const nextEdges = outgoing(index.graph, state.nodeId, terms)
      .filter(({ to }) => domains.has(domain(to)))
    const previous = parents[state.origin]!

    for (const edge of nextEdges) {
      if (seen.has(edge.to)) continue
      seen.add(edge.to)
      previous.set(edge.to, { nodeId: state.nodeId, edge })
      if (search.targets.some((target) => target.id === edge.to)) {
        found.set(edge.to, rebuild(search.source.id, edge.to, previous))
      }
      queue.push({ origin: state.origin, nodeId: edge.to })
    }
  }

  const nodeIds: string[] = []
  const edges: QueryPathEdge[] = []
  const nodes = new Set<string>()
  const edgeIds = new Set<string>()
  const include = (nodeId: string): void => {
    if (nodes.has(nodeId)) return
    nodes.add(nodeId)
    nodeIds.push(nodeId)
  }
  for (const anchor of anchors) include(anchor.id)

  for (const [origin, search] of sources.entries()) {
    for (const [targetIndex, target] of search.targets.entries()) {
      const path = paths[origin]!.get(target.id)
      const adjacent = !ranking.flow && targetIndex > 0
        && anchors.slice(origin, origin + targetIndex + 1).every((_, offset) =>
          paths[origin + offset]!.has(anchors[origin + offset + 1]!.id))
      const commonParent = forest
        && sources.slice(0, origin).some((_, earlier) =>
        paths[earlier]!.has(search.source.id) && paths[earlier]!.has(target.id))
      const fanOut = forest && anchors.some((anchor) =>
        anchor.id !== search.source.id
        && anchor.id !== target.id
        && direct(index.graph, anchor.id, search.source.id)
        && direct(index.graph, anchor.id, target.id))
      const targetSource = sources.findIndex(({ source }) => source.id === target.id)
      const fanIn = forest && targetSource >= 0
        && anchors.some((anchor) =>
          anchor.id !== search.source.id
          && anchor.id !== target.id
          && visited[origin]!.has(anchor.id)
          && visited[targetSource]!.has(anchor.id))
      if (adjacent) continue
      if (!path && targetIndex === 0
        && !commonParent && !fanOut && !fanIn) {
        facts.push({
          kind: 'disconnected',
          subject: `${search.source.id} -> ${target.id}`,
          detail: `${verify(index.graph, search.source.id)} -> ${verify(index.graph, target.id)}`,
        })
      }
      for (const edge of path ?? []) {
        include(edge.from)
        include(edge.to)
        if (edgeIds.has(edge.id)) continue
        edgeIds.add(edge.id)
        edges.push(edge)
      }
    }
  }

  // A selected evidence skeleton can be a forest, fan-in, or cycle rather than
  // one linear path. Preserve every authenticated direct evidence edge between
  // retained nodes so traversal ordering cannot silently discard a branch or
  // back-edge.
  for (const from of nodeIds) {
    for (const to of index.graph.successors(from)) {
      if (!nodes.has(to)) continue
      for (const graphEdge of index.graph.edgesBetween(from, to)) {
        const edge = pathEdge(graphEdge)
        if (!allowed(index.graph, edge) || edgeIds.has(edge.id)) continue
        edgeIds.add(edge.id)
        edges.push(edge)
      }
    }
  }

  return { nodeIds, edges, boundaries: unique(facts), closurePasses: 1 }
}
