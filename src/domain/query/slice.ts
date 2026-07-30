import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base'

import {
  canonicalJsonString as json, compareCodeUnits as compare,
} from '../graph/canonical-json.js'
import {
  MAX_RETRIEVE_FILES, MAX_RETRIEVE_SNIPPETS,
  RETRIEVE_RESULT_SCHEMA, RETRIEVE_RESULT_VERSION,
  type EvidenceBoundary, type EvidenceNode, type EvidenceRelationship,
  type NormalizedRetrieveRequest, type RetrieveContextResult, type RetrieveOutcome,
} from './types.js'

export interface SliceEvidenceInput {
  request: NormalizedRetrieveRequest; outcome: RetrieveOutcome
  matchedNodes: readonly EvidenceNode[]; relationships: readonly EvidenceRelationship[]
  boundaries: readonly EvidenceBoundary[]; priorityNodeIds: readonly string[]; closurePasses: 0 | 1
  structuralRequired?: boolean
  structuralCoverageComplete?: boolean
}

interface Bundle {
  nodes: readonly EvidenceNode[]
  edge?: EvidenceRelationship
  fact?: EvidenceBoundary
  rank: readonly [number, number]
  order: number
  key: string
}

const CAUSAL_RELATIONS = new Set(['calls', 'enqueues_job'])

function causal(edge: EvidenceRelationship): boolean {
  return CAUSAL_RELATIONS.has(edge.relation)
}

function truncation(target?: EvidenceNode): EvidenceBoundary {
  if (!target) return { kind: 'truncated', subject: 'retrieve', detail: 'Omitted by limit.' }
  return {
    kind: 'truncated',
    subject: target.evidence_kind === 'symbol_declaration'
      ? `${target.source_file}:${target.source_location}`
      : target.source_file,
  }
}

function edgeOrder(left: EvidenceRelationship, right: EvidenceRelationship): number {
  return compare(left.from_id, right.from_id)
    || compare(left.relation, right.relation)
    || compare(left.to_id, right.to_id)
    || compare(left.id, right.id)
}

function edgeSlot(
  edges: readonly EvidenceRelationship[],
  edge: EvidenceRelationship,
): { at: number; delta: number } {
  let low = 0
  let high = edges.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (edgeOrder(edges[middle]!, edge) < 0) low = middle + 1
    else high = middle
  }
  const before = [edges[low - 1], edges[low]]
    .filter((value): value is EvidenceRelationship => Boolean(value))
  const after = [edges[low - 1], edge, edges[low]]
    .filter((value): value is EvidenceRelationship => Boolean(value))
  return {
    at: low,
    delta: countTokens(json(after)) - countTokens(json(before)),
  }
}

function addEdgeTokens(current: number, delta: number): number {
  const body = current - countTokens(String(current)) + delta
  let tokens = body
  for (let pass = 0; pass < 16; pass += 1) {
    const observed = body + countTokens(String(tokens))
    if (observed === tokens) return tokens
    tokens = observed
  }
  throw new Error('Unable to stabilize retrieve serialized token count')
}

function factOrder(left: EvidenceBoundary, right: EvidenceBoundary): number {
  return compare(left.kind, right.kind)
    || compare(left.subject, right.subject)
    || compare(left.detail ?? '', right.detail ?? '')
}

function unique<T>(
  values: readonly T[],
  identityOf: (value: T) => string,
  name: string,
): T[] {
  const facts = new Map<string, { serialized: string; value: T }>()
  for (const value of values) {
    const identity = identityOf(value)
    const serialized = json(value)
    const previous = facts.get(identity)
    if (previous && previous.serialized !== serialized) {
      throw new TypeError(`Conflicting ${name} facts share identity ${JSON.stringify(identity)}`)
    }
    if (!previous) facts.set(identity, { serialized, value })
  }
  return [...facts.values()].map(({ value }) => value)
}

function uniqueFacts(facts: readonly EvidenceBoundary[]): EvidenceBoundary[] {
  return unique(facts, json, 'boundary').sort(factOrder)
}

function handoffEnds(fact: EvidenceBoundary): readonly [string, string] | null {
  if (fact.kind !== 'disconnected') return null
  const separator = ' -> '
  const at = fact.subject.indexOf(separator)
  if (at <= 0 || fact.subject.indexOf(separator, at + separator.length) >= 0) return null
  return [fact.subject.slice(0, at), fact.subject.slice(at + separator.length)]
}

function pruneFiles(
  nodes: readonly EvidenceNode[],
  relationships: readonly EvidenceRelationship[],
): EvidenceNode[] {
  const related = new Set(relationships.flatMap(({ from_id, to_id }) => [from_id, to_id]))
  return nodes.filter((node) =>
    node.evidence_kind !== 'structural_file' || related.has(node.node_id))
}

function finalize(
  input: Pick<
    SliceEvidenceInput,
    'request' | 'outcome' | 'closurePasses' | 'structuralRequired'
      | 'structuralCoverageComplete'
  >,
  nodes: readonly EvidenceNode[],
  edges: readonly EvidenceRelationship[],
  facts: readonly EvidenceBoundary[],
): RetrieveContextResult {
  const sortedEdges = [...edges].sort(edgeOrder)
  const kept = pruneFiles(nodes, sortedEdges)
  const ids = new Set(kept.map(({ node_id }) => node_id))
  const handoff = facts.some((fact) => {
    const ends = handoffEnds(fact)
    return ends !== null && ends.every((id) => ids.has(id))
  })
  const hasEdge = sortedEdges.some(causal)
  const ready = !input.structuralRequired
    || (input.structuralCoverageComplete !== false
      && (hasEdge || handoff))
  const missing = input.outcome === 'evidence' && !ready
  const outputFacts = uniqueFacts([
    ...facts,
    ...missing ? [{
      kind: 'missing' as const,
      subject: 'structural coverage',
    }] : [],
  ])
  const files = new Set([
    ...kept.map(({ source_file }) => source_file),
    ...sortedEdges.flatMap(({ source_file }) => source_file ? [source_file] : []),
  ]).size
  const snippets = kept.filter(({ snippet }) => Boolean(snippet)).length
  const result = (tokenCount: number): RetrieveContextResult => ({
    schema: RETRIEVE_RESULT_SCHEMA,
    version: RETRIEVE_RESULT_VERSION,
    outcome: missing
      || (kept.length === 0 && input.outcome === 'evidence')
      ? 'missing'
      : input.outcome,
    matched_nodes: kept,
    relationships: sortedEdges,
    boundaries: outputFacts,
    metrics: {
      selected_files: files,
      snippets,
      closure_passes: input.closurePasses,
      serialized_tokens: tokenCount,
      truncated: outputFacts.some(({ kind }) => kind === 'truncated'),
    },
  })

  let tokens = 0
  for (let pass = 0; pass < 16; pass += 1) {
    const value = result(tokens)
    const seen = countTokens(json(value))
    if (seen === tokens) return value
    tokens = seen
  }
  for (tokens = 0; tokens <= 10_000; tokens += 1) {
    const value = result(tokens)
    if (countTokens(json(value)) === tokens) return value
  }
  throw new Error('Unable to stabilize retrieve serialized token count')
}

function pack(
  input: SliceEvidenceInput,
  nodes: readonly EvidenceNode[],
  edges: readonly EvidenceRelationship[],
  facts: readonly EvidenceBoundary[],
  budget?: number,
): {
  nodes: EvidenceNode[]
  relationships: EvidenceRelationship[]
  boundaries: EvidenceBoundary[]
  omitted: boolean
} {
  const byId = new Map(nodes.map((node) => [node.node_id, node]))
  const priorityIds = [...new Set(input.priorityNodeIds)]
  const prioritySet = new Set(priorityIds)
  const ordered = [
    ...priorityIds.flatMap((id) => {
      const node = byId.get(id)
      return node ? [node] : []
    }),
    ...nodes.filter(({ node_id }) => !prioritySet.has(node_id)),
  ]
  const ordinals = new Map(priorityIds.map((id, index) => [id, index]))
  const priority = (ids: readonly string[]): readonly [number, number] => {
    const ranks = ids.map((id) => ordinals.get(id) ?? Number.POSITIVE_INFINITY)
    return [Math.max(...ranks), Math.min(...ranks)]
  }
  const queue: Bundle[] = []
  const loose: EvidenceBoundary[] = []
  let omitted = false

  for (const edge of edges) {
    const ids = [...new Set([edge.from_id, edge.to_id])]
    const ends = ids.map((id) => byId.get(id))
    if (ends.some((node) => !node)) {
      omitted = true
      continue
    }
    queue.push({
      nodes: ends as EvidenceNode[],
      edge,
      rank: priority(ids),
      order: causal(edge) ? 0 : 2,
      key: json(edge),
    })
  }
  for (const fact of facts) {
    if (fact.kind !== 'disconnected') {
      if (budget === undefined || fact.kind !== 'truncated') {
        loose.push(fact)
      }
      continue
    }
    const ids = handoffEnds(fact)
    const ends = ids?.map((id) => byId.get(id))
    if (!ids || !ends || ends.some((node) => !node)) {
      omitted = true
      continue
    }
    queue.push({
      nodes: ends as EvidenceNode[],
      fact,
      rank: priority(ids),
      order: 1,
      key: json(fact),
    })
  }
  const rank = (left: number, right: number): number =>
    left === right ? 0 : left < right ? -1 : 1
  queue.sort((left, right) =>
    Number(Number.isFinite(right.rank[0]))
      - Number(Number.isFinite(left.rank[0]))
    || left.order - right.order
    || rank(left.rank[0], right.rank[0])
    || rank(left.rank[1], right.rank[1])
    || compare(left.key, right.key))

  const chosen = new Set<string>()
  const keptEdges: EvidenceRelationship[] = []
  let keptFacts = budget === undefined ? [] : [truncation()]
  const files = new Set<string>()
  const blocked = new Set<string>()
  let snippets = 0
  let tokenCount: number | undefined
  const selectedNodes = (ids: ReadonlySet<string> = chosen): EvidenceNode[] =>
    ordered.filter(({ node_id }) => ids.has(node_id))
  const tryAdd = (item: Pick<Bundle, 'nodes' | 'edge' | 'fact'>): boolean => {
    const missing = item.nodes.filter(({ node_id }) => !chosen.has(node_id))
    const addedFiles = new Set(
      missing.map(({ source_file }) => source_file).filter((file) => !files.has(file)),
    )
    const edgeFile = item.edge?.source_file
    if (edgeFile && !files.has(edgeFile)) addedFiles.add(edgeFile)
    const addedSnippets = missing.filter(({ snippet }) => Boolean(snippet)).length
    if (files.size + addedFiles.size > MAX_RETRIEVE_FILES
      || snippets + addedSnippets > MAX_RETRIEVE_SNIPPETS) return false

    const candidateIds = new Set(chosen)
    for (const { node_id } of missing) candidateIds.add(node_id)
    const candidateEdges = item.edge
      ? [...keptEdges, item.edge]
      : keptEdges
    const candidateFacts = item.fact
      ? uniqueFacts([...keptFacts, item.fact])
      : keptFacts
    let insertion: { at: number; delta: number } | undefined
    let nextTokens: number | undefined
    const edge = item.edge
    const stableStructure = !input.structuralRequired
      || !edge || !causal(edge)
      || keptEdges.some(causal)
    if (budget !== undefined) {
      if (tokenCount !== undefined && edge && !item.fact
        && missing.length === 0 && addedFiles.size === 0 && stableStructure) {
        insertion = edgeSlot(keptEdges, edge)
        nextTokens = addEdgeTokens(tokenCount, insertion.delta)
      } else {
        nextTokens = finalize(
          input,
          selectedNodes(candidateIds),
          candidateEdges,
          candidateFacts,
        ).metrics.serialized_tokens
      }
      if (nextTokens > budget) return false
    }

    for (const node of missing) chosen.add(node.node_id)
    for (const file of addedFiles) files.add(file)
    snippets += addedSnippets
    if (edge) {
      const at = insertion?.at
        ?? edgeSlot(keptEdges, edge).at
      keptEdges.splice(at, 0, edge)
    }
    if (item.fact) keptFacts = candidateFacts
    tokenCount = nextTokens
    return true
  }

  for (const item of queue) {
    if (tryAdd(item)) continue
    omitted = true
    if (item.fact) {
      for (const { node_id } of item.nodes) {
        if (!chosen.has(node_id)) blocked.add(node_id)
      }
    }
  }
  for (const node of ordered) {
    if (chosen.has(node.node_id) || blocked.has(node.node_id)) continue
    if (node.evidence_kind === 'structural_file' || !tryAdd({ nodes: [node] })) {
      omitted = true
    }
  }
  for (const fact of loose.sort(factOrder)) {
    if (!tryAdd({ nodes: [], fact })) omitted = true
  }

  return {
    nodes: selectedNodes(),
    relationships: keptEdges,
    boundaries: keptFacts,
    omitted,
  }
}

export function sliceEvidence(input: SliceEvidenceInput): RetrieveContextResult {
  const nodes = unique(input.matchedNodes, ({ node_id }) => node_id, 'node')
  const relationships = unique(
    input.relationships, ({ id }) => id, 'relationship',
  ).sort(edgeOrder)
  const boundaries = uniqueFacts(input.boundaries)
  const capped = pack(input, nodes, relationships, boundaries)
  if (capped.omitted && !capped.boundaries.some(({ kind }) => kind === 'truncated')) {
    capped.boundaries = uniqueFacts([...capped.boundaries, truncation()])
  }
  const cappedResult = finalize(
    input, capped.nodes, capped.relationships, capped.boundaries,
  )
  if (cappedResult.metrics.serialized_tokens <= input.request.budget) return cappedResult

  const retained = pack(
    input, capped.nodes, capped.relationships, capped.boundaries, input.request.budget,
  )
  const omittedTarget = capped.nodes.find(({ node_id }) =>
    !retained.nodes.some((node) => node.node_id === node_id))
  if (omittedTarget) {
    const targeted = retained.boundaries.map((boundary) =>
      boundary.kind === 'truncated' ? truncation(omittedTarget) : boundary)
    if (finalize(
      input, retained.nodes, retained.relationships, targeted,
    ).metrics.serialized_tokens <= input.request.budget) retained.boundaries = targeted
  }
  return finalize(
    input, retained.nodes, retained.relationships, retained.boundaries,
  )
}
