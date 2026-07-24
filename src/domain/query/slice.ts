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
}

function truncatedBoundary(): EvidenceBoundary {
  return { kind: 'truncated', subject: 'retrieve',
    detail: 'Some graph facts were omitted to satisfy the file, snippet, or token limit.' }
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

function deduplicateByIdentity<T>(
  values: readonly T[],
  identityOf: (value: T) => string,
  factName: string,
): T[] {
  const facts = new Map<string, { serialized: string; value: T }>()
  for (const value of values) {
    const identity = identityOf(value)
    const serialized = canonicalJsonString(value)
    const existing = facts.get(identity)
    if (existing && existing.serialized !== serialized) {
      throw new TypeError(`Conflicting ${factName} facts share identity ${JSON.stringify(identity)}`)
    }
    if (!existing) facts.set(identity, { serialized, value })
  }
  return [...facts.values()].map(({ value }) => value)
}

function deduplicateBoundaries(boundaries: readonly EvidenceBoundary[]): EvidenceBoundary[] {
  return deduplicateByIdentity(
    boundaries,
    (boundary) => canonicalJsonString(boundary),
    'boundary',
  ).sort(compareBoundaries)
}

function pruneStructuralOrphans(
  nodes: readonly EvidenceNode[], relationships: readonly EvidenceRelationship[],
): EvidenceNode[] {
  const related = new Set(relationships.flatMap((edge) => [edge.from_id, edge.to_id]))
  return nodes.filter((node) =>
    node.evidence_kind !== 'structural_file' || related.has(node.node_id))
}

function resultWithTokenCount(
  input: Pick<SliceEvidenceInput, 'outcome' | 'closurePasses'>,
  nodes: readonly EvidenceNode[],
  relationships: readonly EvidenceRelationship[],
  boundaries: readonly EvidenceBoundary[],
): RetrieveContextResult {
  const sortedRelationships = [...relationships].sort(compareRelationships)
  const sortedNodes = pruneStructuralOrphans(nodes, sortedRelationships)
  const sortedBoundaries = [...boundaries].sort(compareBoundaries)
  const files = new Set([
    ...sortedNodes.map((node) => node.source_file),
    ...sortedRelationships.flatMap((edge) => edge.source_file ? [edge.source_file] : []),
  ]).size
  const snippets = sortedNodes.filter((node) => node.snippet && node.snippet.length > 0).length
  const truncated = sortedBoundaries.some((boundary) => boundary.kind === 'truncated')
  const result = (serializedTokens: number): RetrieveContextResult => ({
    schema: RETRIEVE_RESULT_SCHEMA,
    version: RETRIEVE_RESULT_VERSION,
    outcome: sortedNodes.length === 0 && input.outcome === 'evidence' ? 'missing' : input.outcome,
    matched_nodes: sortedNodes,
    relationships: sortedRelationships,
    boundaries: sortedBoundaries,
    metrics: {
      selected_files: files,
      snippets,
      closure_passes: input.closurePasses,
      serialized_tokens: serializedTokens,
      truncated,
    },
  })

  let serializedTokens = 0
  for (let pass = 0; pass < 16; pass += 1) {
    const candidate = result(serializedTokens)
    const observed = countTokens(canonicalJsonString(candidate))
    if (observed === serializedTokens) return candidate
    serializedTokens = observed
  }

  for (let candidate = 0; candidate <= 10_000; candidate += 1) {
    const fixedPoint = result(candidate)
    if (countTokens(canonicalJsonString(fixedPoint)) === candidate) return fixedPoint
  }

  throw new Error('Unable to stabilize retrieve serialized token count')
}

function capGraphFacts(
  nodes: readonly EvidenceNode[],
  relationships: readonly EvidenceRelationship[],
  priorityNodeIds: readonly string[],
): { nodes: EvidenceNode[]; relationships: EvidenceRelationship[]; omitted: boolean } {
  const retainedNodes: EvidenceNode[] = []
  const files = new Set<string>()
  let snippets = 0
  let omitted = false
  const nodesById = new Map(nodes.map((node) => [node.node_id, node]))
  const priorityIds = new Set(priorityNodeIds)
  const prioritized = [
    ...[...priorityIds].flatMap((nodeId) => {
      const node = nodesById.get(nodeId)
      return node ? [node] : []
    }),
    ...nodes.filter((node) => !priorityIds.has(node.node_id)),
  ]

  for (const node of prioritized) {
    const addsFile = !files.has(node.source_file)
    const addsSnippet = node.snippet !== undefined && node.snippet.length > 0
    if ((addsFile && files.size >= MAX_RETRIEVE_FILES)
      || (addsSnippet && snippets >= MAX_RETRIEVE_SNIPPETS)) {
      omitted = true
      continue
    }
    retainedNodes.push(node)
    files.add(node.source_file)
    if (addsSnippet) snippets += 1
  }

  const retainedNodeIds = new Set(retainedNodes.map((node) => node.node_id))
  const retainedRelationships: EvidenceRelationship[] = []
  for (const relationship of relationships) {
    if (!retainedNodeIds.has(relationship.from_id) || !retainedNodeIds.has(relationship.to_id)) {
      omitted = true
      continue
    }
    const sourceFile = relationship.source_file
    if (sourceFile !== undefined && !files.has(sourceFile) && files.size >= MAX_RETRIEVE_FILES) {
      omitted = true
      continue
    }
    retainedRelationships.push(relationship)
    if (sourceFile !== undefined) files.add(sourceFile)
  }

  const prunedNodes = pruneStructuralOrphans(retainedNodes, retainedRelationships)
  return {
    nodes: prunedNodes,
    relationships: retainedRelationships,
    omitted: omitted || prunedNodes.length !== retainedNodes.length,
  }
}

/** Select whole evidence records; represent every omitted fact with an explicit boundary. */
export function sliceEvidence(input: SliceEvidenceInput): RetrieveContextResult {
  const nodes = deduplicateByIdentity(input.matchedNodes, (node) => node.node_id, 'node')
  const relationships = deduplicateByIdentity(
    input.relationships, (relationship) => relationship.id, 'relationship',
  ).sort(compareRelationships)
  const boundaries = deduplicateBoundaries(input.boundaries)
  const capped = capGraphFacts(nodes, relationships, input.priorityNodeIds)
  const cappedBoundaries = capped.omitted
    && !boundaries.some((boundary) => boundary.kind === 'truncated')
    ? deduplicateBoundaries([...boundaries, truncatedBoundary()])
    : boundaries
  const cappedResult = resultWithTokenCount(
    input,
    capped.nodes,
    capped.relationships,
    cappedBoundaries,
  )
  if (cappedResult.metrics.serialized_tokens <= input.request.budget) return cappedResult

  const retainedBoundaries: EvidenceBoundary[] = [truncatedBoundary()]
  const retainedNodes: EvidenceNode[] = []
  const retainedRelationships: EvidenceRelationship[] = []

  const nodesById = new Map(capped.nodes.map((node) => [node.node_id, node]))
  const retainedNodeIds = new Set<string>()
  const retainedRelationshipIds = new Set<string>()
  const fits = (
    nodes: readonly EvidenceNode[],
    relationships: readonly EvidenceRelationship[],
    boundaries: readonly EvidenceBoundary[] = retainedBoundaries,
  ): boolean =>
    resultWithTokenCount(input, nodes, relationships, boundaries).metrics.serialized_tokens
      <= input.request.budget
  const tryNode = (node: EvidenceNode): boolean => {
    if (!fits([...retainedNodes, node], retainedRelationships)) return false
    retainedNodes.push(node)
    retainedNodeIds.add(node.node_id)
    return true
  }
  const tryRelationship = (relationship: EvidenceRelationship, includeEndpoints: boolean): boolean => {
    const endpointIds = [...new Set([relationship.from_id, relationship.to_id])]
    if (!includeEndpoints && endpointIds.some((nodeId) => !retainedNodeIds.has(nodeId))) {
      return false
    }
    const missingNodes = includeEndpoints
      ? endpointIds
        .filter((nodeId) => !retainedNodeIds.has(nodeId))
        .map((nodeId) => nodesById.get(nodeId))
      : []
    if (missingNodes.some((node) => node === undefined)) return false
    const candidateNodes = [
      ...retainedNodes,
      ...missingNodes.filter((node): node is EvidenceNode => node !== undefined),
    ]
    if (!fits(candidateNodes, [...retainedRelationships, relationship])) return false
    for (const node of missingNodes) {
      if (node === undefined) continue
      retainedNodes.push(node)
      retainedNodeIds.add(node.node_id)
    }
    retainedRelationships.push(relationship)
    retainedRelationshipIds.add(relationship.id)
    return true
  }

  const priorityIds = new Set(input.priorityNodeIds)
  for (const nodeId of input.priorityNodeIds) {
    const node = nodesById.get(nodeId)
    if (!node || retainedNodeIds.has(nodeId)) continue
    tryNode(node)
  }

  for (const relationship of capped.relationships) tryRelationship(relationship, true)

  for (const node of capped.nodes) {
    if (retainedNodeIds.has(node.node_id) || priorityIds.has(node.node_id)) continue
    tryNode(node)
  }

  for (const relationship of capped.relationships) {
    if (!retainedRelationshipIds.has(relationship.id)) tryRelationship(relationship, false)
  }

  for (const boundary of boundaries.filter((candidate) => candidate.kind !== 'truncated')) {
    const candidateBoundaries = deduplicateBoundaries([...retainedBoundaries, boundary])
    if (fits(retainedNodes, retainedRelationships, candidateBoundaries)) {
      retainedBoundaries.splice(0, retainedBoundaries.length, ...candidateBoundaries)
    }
  }

  return resultWithTokenCount(
    input,
    retainedNodes,
    retainedRelationships,
    retainedBoundaries,
  )
}
