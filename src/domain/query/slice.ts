import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base'

import { canonicalJsonString, compareCodeUnits } from '../graph/canonical-json.js'
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
  relationship?: EvidenceRelationship
  boundary?: EvidenceBoundary
  priority: readonly [number, number]
  order: number
  identity: string
}

const CAUSAL_RELATIONS = new Set(['calls', 'enqueues_job'])

function isCausalRelationship(relationship: EvidenceRelationship): boolean {
  return CAUSAL_RELATIONS.has(relationship.relation)
}

function truncatedBoundary(target?: EvidenceNode): EvidenceBoundary {
  if (!target) return { kind: 'truncated', subject: 'retrieve', detail: 'Omitted by limit.' }
  return {
    kind: 'truncated',
    subject: target.evidence_kind === 'symbol_declaration'
      ? `${target.source_file}:${target.source_location}`
      : target.source_file,
  }
}

function compareRelationships(left: EvidenceRelationship, right: EvidenceRelationship): number {
  return compareCodeUnits(left.from_id, right.from_id)
    || compareCodeUnits(left.relation, right.relation)
    || compareCodeUnits(left.to_id, right.to_id)
    || compareCodeUnits(left.id, right.id)
}

function compareBoundaries(left: EvidenceBoundary, right: EvidenceBoundary): number {
  return compareCodeUnits(left.kind, right.kind)
    || compareCodeUnits(left.subject, right.subject)
    || compareCodeUnits(left.detail ?? '', right.detail ?? '')
}

function deduplicate<T>(
  values: readonly T[],
  identityOf: (value: T) => string,
  name: string,
): T[] {
  const facts = new Map<string, { serialized: string; value: T }>()
  for (const value of values) {
    const identity = identityOf(value)
    const serialized = canonicalJsonString(value)
    const previous = facts.get(identity)
    if (previous && previous.serialized !== serialized) {
      throw new TypeError(`Conflicting ${name} facts share identity ${JSON.stringify(identity)}`)
    }
    if (!previous) facts.set(identity, { serialized, value })
  }
  return [...facts.values()].map(({ value }) => value)
}

function uniqueBoundaries(boundaries: readonly EvidenceBoundary[]): EvidenceBoundary[] {
  return deduplicate(boundaries, canonicalJsonString, 'boundary').sort(compareBoundaries)
}

function disconnectedEndpoints(boundary: EvidenceBoundary): readonly [string, string] | null {
  if (boundary.kind !== 'disconnected') return null
  const separator = ' -> '
  const at = boundary.subject.indexOf(separator)
  if (at <= 0 || boundary.subject.indexOf(separator, at + separator.length) >= 0) return null
  return [boundary.subject.slice(0, at), boundary.subject.slice(at + separator.length)]
}

function pruneStructuralOrphans(
  nodes: readonly EvidenceNode[],
  relationships: readonly EvidenceRelationship[],
): EvidenceNode[] {
  const related = new Set(relationships.flatMap(({ from_id, to_id }) => [from_id, to_id]))
  return nodes.filter((node) =>
    node.evidence_kind !== 'structural_file' || related.has(node.node_id))
}

function resultWithTokenCount(
  input: Pick<
    SliceEvidenceInput,
    'request' | 'outcome' | 'closurePasses' | 'structuralRequired'
      | 'structuralCoverageComplete'
  >,
  nodes: readonly EvidenceNode[],
  relationships: readonly EvidenceRelationship[],
  boundaries: readonly EvidenceBoundary[],
): RetrieveContextResult {
  const sortedRelationships = [...relationships].sort(compareRelationships)
  const sortedNodes = pruneStructuralOrphans(nodes, sortedRelationships)
  const nodeIds = new Set(sortedNodes.map(({ node_id }) => node_id))
  const hasHandoff = boundaries.some((boundary) => {
    const endpoints = disconnectedEndpoints(boundary)
    return endpoints !== null && endpoints.every((endpoint) => nodeIds.has(endpoint))
  })
  const hasCausalRelationship = sortedRelationships.some(isCausalRelationship)
  const structurallyReady = !input.structuralRequired
    || (input.structuralCoverageComplete !== false
      && (hasCausalRelationship || hasHandoff))
  const sortedBoundaries = uniqueBoundaries([
    ...boundaries,
    ...structurallyReady ? [] : [{
      kind: 'missing' as const,
      subject: `structural coverage for ${input.request.question}`,
    }],
  ])
  const files = new Set([
    ...sortedNodes.map(({ source_file }) => source_file),
    ...sortedRelationships.flatMap(({ source_file }) => source_file ? [source_file] : []),
  ]).size
  const snippets = sortedNodes.filter(({ snippet }) => Boolean(snippet)).length
  const result = (serializedTokens: number): RetrieveContextResult => ({
    schema: RETRIEVE_RESULT_SCHEMA,
    version: RETRIEVE_RESULT_VERSION,
    outcome: !structurallyReady
      || (sortedNodes.length === 0 && input.outcome === 'evidence')
      ? 'missing'
      : input.outcome,
    matched_nodes: sortedNodes,
    relationships: sortedRelationships,
    boundaries: sortedBoundaries,
    metrics: {
      selected_files: files,
      snippets,
      closure_passes: input.closurePasses,
      serialized_tokens: serializedTokens,
      truncated: sortedBoundaries.some(({ kind }) => kind === 'truncated'),
    },
  })

  let tokens = 0
  for (let pass = 0; pass < 16; pass += 1) {
    const candidate = result(tokens)
    const observed = countTokens(canonicalJsonString(candidate))
    if (observed === tokens) return candidate
    tokens = observed
  }
  for (tokens = 0; tokens <= 10_000; tokens += 1) {
    const candidate = result(tokens)
    if (countTokens(canonicalJsonString(candidate)) === tokens) return candidate
  }
  throw new Error('Unable to stabilize retrieve serialized token count')
}

function pack(
  input: SliceEvidenceInput,
  nodes: readonly EvidenceNode[],
  relationships: readonly EvidenceRelationship[],
  boundaries: readonly EvidenceBoundary[],
  budget?: number,
): {
  nodes: EvidenceNode[]
  relationships: EvidenceRelationship[]
  boundaries: EvidenceBoundary[]
  omitted: boolean
} {
  const nodesById = new Map(nodes.map((node) => [node.node_id, node]))
  const uniquePriorityIds = [...new Set(input.priorityNodeIds)]
  const priorityIds = new Set(uniquePriorityIds)
  const orderedNodes = [
    ...uniquePriorityIds.flatMap((id) => {
      const node = nodesById.get(id)
      return node ? [node] : []
    }),
    ...nodes.filter(({ node_id }) => !priorityIds.has(node_id)),
  ]
  const priorityOrder = new Map(uniquePriorityIds.map((nodeId, index) => [nodeId, index]))
  const priority = (ids: readonly string[]): readonly [number, number] => {
    const ranks = ids.map((id) => priorityOrder.get(id) ?? Number.POSITIVE_INFINITY)
    return [Math.max(...ranks), Math.min(...ranks)]
  }
  const bundles: Bundle[] = []
  const remainingBoundaries: EvidenceBoundary[] = []
  let omitted = false

  for (const relationship of relationships) {
    const ids = [...new Set([relationship.from_id, relationship.to_id])]
    const endpoints = ids.map((id) => nodesById.get(id))
    if (endpoints.some((node) => !node)) {
      omitted = true
      continue
    }
    bundles.push({
      nodes: endpoints as EvidenceNode[],
      relationship,
      priority: priority(ids),
      order: isCausalRelationship(relationship) ? 0 : 2,
      identity: canonicalJsonString(relationship),
    })
  }
  for (const boundary of boundaries) {
    if (boundary.kind !== 'disconnected') {
      if (budget === undefined || boundary.kind !== 'truncated') {
        remainingBoundaries.push(boundary)
      }
      continue
    }
    const ids = disconnectedEndpoints(boundary)
    const endpoints = ids?.map((id) => nodesById.get(id))
    if (!ids || !endpoints || endpoints.some((node) => !node)) {
      omitted = true
      continue
    }
    bundles.push({
      nodes: endpoints as EvidenceNode[],
      boundary,
      priority: priority(ids),
      order: 1,
      identity: canonicalJsonString(boundary),
    })
  }
  const compareRank = (left: number, right: number): number =>
    left === right ? 0 : left < right ? -1 : 1
  bundles.sort((left, right) =>
    left.order - right.order
    || compareRank(left.priority[0], right.priority[0])
    || compareRank(left.priority[1], right.priority[1])
    || compareCodeUnits(left.identity, right.identity))

  const selectedIds = new Set<string>()
  const selectedRelationships: EvidenceRelationship[] = []
  let selectedBoundaries = budget === undefined ? [] : [truncatedBoundary()]
  const files = new Set<string>()
  const blockedStandalone = new Set<string>()
  let snippets = 0
  const selectedNodes = (candidateIds: ReadonlySet<string> = selectedIds): EvidenceNode[] =>
    orderedNodes.filter(({ node_id }) => candidateIds.has(node_id))
  const tryAdd = (bundle: Pick<Bundle, 'nodes' | 'relationship' | 'boundary'>): boolean => {
    const missing = bundle.nodes.filter(({ node_id }) => !selectedIds.has(node_id))
    const addedFiles = new Set(
      missing.map(({ source_file }) => source_file).filter((file) => !files.has(file)),
    )
    const relationshipFile = bundle.relationship?.source_file
    if (relationshipFile && !files.has(relationshipFile)) addedFiles.add(relationshipFile)
    const addedSnippets = missing.filter(({ snippet }) => Boolean(snippet)).length
    if (files.size + addedFiles.size > MAX_RETRIEVE_FILES
      || snippets + addedSnippets > MAX_RETRIEVE_SNIPPETS) return false

    const candidateIds = new Set(selectedIds)
    for (const { node_id } of missing) candidateIds.add(node_id)
    const candidateRelationships = bundle.relationship
      ? [...selectedRelationships, bundle.relationship]
      : selectedRelationships
    const candidateBoundaries = bundle.boundary
      ? uniqueBoundaries([...selectedBoundaries, bundle.boundary])
      : selectedBoundaries
    if (budget !== undefined && resultWithTokenCount(
      input,
      selectedNodes(candidateIds),
      candidateRelationships,
      candidateBoundaries,
    ).metrics.serialized_tokens > budget) return false

    for (const node of missing) selectedIds.add(node.node_id)
    for (const file of addedFiles) files.add(file)
    snippets += addedSnippets
    if (bundle.relationship) selectedRelationships.push(bundle.relationship)
    if (bundle.boundary) selectedBoundaries = candidateBoundaries
    return true
  }

  for (const bundle of bundles) {
    if (tryAdd(bundle)) continue
    omitted = true
    if (bundle.boundary) {
      for (const { node_id } of bundle.nodes) {
        if (!selectedIds.has(node_id)) blockedStandalone.add(node_id)
      }
    }
  }
  for (const node of orderedNodes) {
    if (selectedIds.has(node.node_id) || blockedStandalone.has(node.node_id)) continue
    if (node.evidence_kind === 'structural_file' || !tryAdd({ nodes: [node] })) {
      omitted = true
    }
  }
  for (const boundary of remainingBoundaries.sort(compareBoundaries)) {
    if (!tryAdd({ nodes: [], boundary })) omitted = true
  }

  return {
    nodes: selectedNodes(),
    relationships: selectedRelationships,
    boundaries: selectedBoundaries,
    omitted,
  }
}

export function sliceEvidence(input: SliceEvidenceInput): RetrieveContextResult {
  const nodes = deduplicate(input.matchedNodes, ({ node_id }) => node_id, 'node')
  const relationships = deduplicate(
    input.relationships, ({ id }) => id, 'relationship',
  ).sort(compareRelationships)
  const boundaries = uniqueBoundaries(input.boundaries)
  const capped = pack(input, nodes, relationships, boundaries)
  if (capped.omitted && !capped.boundaries.some(({ kind }) => kind === 'truncated')) {
    capped.boundaries = uniqueBoundaries([...capped.boundaries, truncatedBoundary()])
  }
  const cappedResult = resultWithTokenCount(
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
      boundary.kind === 'truncated' ? truncatedBoundary(omittedTarget) : boundary)
    if (resultWithTokenCount(
      input, retained.nodes, retained.relationships, targeted,
    ).metrics.serialized_tokens <= input.request.budget) retained.boundaries = targeted
  }
  return resultWithTokenCount(
    input, retained.nodes, retained.relationships, retained.boundaries,
  )
}
