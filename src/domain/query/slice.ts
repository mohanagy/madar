import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base'

import { canonicalJsonString, compareCodeUnits } from '../graph/canonical-json.js'
import {
  MAX_RETRIEVE_FILES,
  MAX_RETRIEVE_SNIPPETS,
  RETRIEVE_RESULT_SCHEMA,
  RETRIEVE_RESULT_VERSION,
  type EvidenceBoundary,
  type EvidenceNode,
  type EvidenceRelationship,
  type NormalizedRetrieveRequest,
  type RetrieveContextResult,
  type RetrieveOutcome,
} from './types.js'

export interface SliceEvidenceInput {
  request: NormalizedRetrieveRequest
  outcome: RetrieveOutcome
  matchedNodes: readonly EvidenceNode[]
  relationships: readonly EvidenceRelationship[]
  boundaries: readonly EvidenceBoundary[]
  priorityNodeIds: readonly string[]
  closurePasses: 0 | 1
}

function truncatedBoundary(): EvidenceBoundary {
  return {
    kind: 'truncated',
    subject: 'retrieve',
    detail: 'Some graph facts were omitted to satisfy the file, snippet, or token limit.',
  }
}

function compareNodes(left: EvidenceNode, right: EvidenceNode): number {
  return compareCodeUnits(left.source_file, right.source_file)
    || left.line_number - right.line_number
    || left.end_line_number - right.end_line_number
    || compareCodeUnits(left.node_id, right.node_id)
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

function deduplicateNodes(nodes: readonly EvidenceNode[]): EvidenceNode[] {
  return deduplicateByIdentity(nodes, (node) => node.node_id, 'node').sort(compareNodes)
}

function deduplicateRelationships(relationships: readonly EvidenceRelationship[]): EvidenceRelationship[] {
  return deduplicateByIdentity(relationships, (relationship) => relationship.id, 'relationship')
    .sort(compareRelationships)
}

function deduplicateBoundaries(boundaries: readonly EvidenceBoundary[]): EvidenceBoundary[] {
  return deduplicateByIdentity(
    boundaries,
    (boundary) => canonicalJsonString(boundary),
    'boundary',
  ).sort(compareBoundaries)
}

function selectedFiles(
  nodes: readonly EvidenceNode[],
  relationships: readonly EvidenceRelationship[],
): Set<string> {
  const files = new Set(nodes.map((node) => node.source_file))
  for (const relationship of relationships) {
    if (relationship.source_file !== undefined) files.add(relationship.source_file)
  }
  return files
}

function snippetCount(nodes: readonly EvidenceNode[]): number {
  return nodes.reduce(
    (count, node) => count + (node.snippet !== undefined && node.snippet.length > 0 ? 1 : 0),
    0,
  )
}

function resultWithTokenCount(
  input: Pick<SliceEvidenceInput, 'outcome' | 'closurePasses'>,
  nodes: readonly EvidenceNode[],
  relationships: readonly EvidenceRelationship[],
  boundaries: readonly EvidenceBoundary[],
): RetrieveContextResult {
  const sortedNodes = [...nodes].sort(compareNodes)
  const sortedRelationships = [...relationships].sort(compareRelationships)
  const sortedBoundaries = [...boundaries].sort(compareBoundaries)
  const files = selectedFiles(sortedNodes, sortedRelationships).size
  const snippets = snippetCount(sortedNodes)
  const truncated = sortedBoundaries.some((boundary) => boundary.kind === 'truncated')

  let serializedTokens = 0
  let result: RetrieveContextResult
  for (let pass = 0; pass < 16; pass += 1) {
    result = {
      schema: RETRIEVE_RESULT_SCHEMA,
      version: RETRIEVE_RESULT_VERSION,
      outcome: input.outcome,
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
    }
    const observed = countTokens(canonicalJsonString(result))
    if (observed === serializedTokens) return result
    serializedTokens = observed
  }

  // Tokenizing the decimal metric normally converges in two passes. Searching
  // the small valid result range makes the fixed point explicit and stable
  // across tokenizer updates instead of returning an approximate count.
  for (let candidate = 0; candidate <= 10_000; candidate += 1) {
    result = {
      schema: RETRIEVE_RESULT_SCHEMA,
      version: RETRIEVE_RESULT_VERSION,
      outcome: input.outcome,
      matched_nodes: sortedNodes,
      relationships: sortedRelationships,
      boundaries: sortedBoundaries,
      metrics: {
        selected_files: files,
        snippets,
        closure_passes: input.closurePasses,
        serialized_tokens: candidate,
        truncated,
      },
    }
    if (countTokens(canonicalJsonString(result)) === candidate) return result
  }

  throw new Error('Unable to stabilize retrieve serialized token count')
}

function withTruncatedBoundary(boundaries: readonly EvidenceBoundary[]): EvidenceBoundary[] {
  return boundaries.some((boundary) => boundary.kind === 'truncated')
    ? [...boundaries]
    : deduplicateBoundaries([...boundaries, truncatedBoundary()])
}

function withinBudget(result: RetrieveContextResult, budget: number): boolean {
  return result.metrics.serialized_tokens <= budget
}

function capGraphFacts(
  nodes: readonly EvidenceNode[],
  relationships: readonly EvidenceRelationship[],
  priorityNodeIds: readonly string[],
): {
  nodes: EvidenceNode[]
  relationships: EvidenceRelationship[]
  omitted: boolean
} {
  const retainedNodes: EvidenceNode[] = []
  const files = new Set<string>()
  let snippets = 0
  let omitted = false
  const nodesById = new Map(nodes.map((node) => [node.node_id, node]))
  const priorityIds = [...new Set(priorityNodeIds)]
  const prioritized = [
    ...priorityIds.flatMap((nodeId) => {
      const node = nodesById.get(nodeId)
      return node ? [node] : []
    }),
    ...nodes.filter((node) => !priorityIds.includes(node.node_id)),
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

  return {
    nodes: retainedNodes,
    relationships: retainedRelationships,
    omitted,
  }
}

/**
 * Select whole evidence records under the public output limits. Snippets,
 * nodes, relationships, and boundaries are never text-truncated or partially
 * serialized; an omitted fact is represented by one explicit boundary.
 */
export function sliceEvidence(input: SliceEvidenceInput): RetrieveContextResult {
  const nodes = deduplicateNodes(input.matchedNodes)
  const relationships = deduplicateRelationships(input.relationships)
  const boundaries = deduplicateBoundaries(input.boundaries)
  const capped = capGraphFacts(nodes, relationships, input.priorityNodeIds)
  const cappedBoundaries = capped.omitted ? withTruncatedBoundary(boundaries) : boundaries
  const cappedResult = resultWithTokenCount(
    input,
    capped.nodes,
    capped.relationships,
    cappedBoundaries,
  )
  if (withinBudget(cappedResult, input.request.budget)) return cappedResult

  const retainedBoundaries: EvidenceBoundary[] = [truncatedBoundary()]
  const retainedNodes: EvidenceNode[] = []
  const retainedRelationships: EvidenceRelationship[] = []

  const nodesById = new Map(capped.nodes.map((node) => [node.node_id, node]))
  const retainedNodeIds = new Set<string>()
  const retainedRelationshipIds = new Set<string>()
  const tryRelationship = (relationship: EvidenceRelationship, includeEndpoints: boolean): boolean => {
    const endpointIds = [...new Set([relationship.from_id, relationship.to_id])]
    const missingNodes = includeEndpoints
      ? endpointIds
        .filter((nodeId) => !retainedNodeIds.has(nodeId))
        .map((nodeId) => nodesById.get(nodeId))
      : []
    if (missingNodes.some((node) => node === undefined)) return false
    if (endpointIds.some((nodeId) =>
      !retainedNodeIds.has(nodeId) && !missingNodes.some((node) => node?.node_id === nodeId))) {
      return false
    }
    const candidateNodes = [
      ...retainedNodes,
      ...missingNodes.filter((node): node is EvidenceNode => node !== undefined),
    ]
    const candidateRelationships = [...retainedRelationships, relationship]
    const candidate = resultWithTokenCount(
      input,
      candidateNodes,
      candidateRelationships,
      retainedBoundaries,
    )
    if (!withinBudget(candidate, input.request.budget)) return false
    for (const node of missingNodes) {
      if (node === undefined) continue
      retainedNodes.push(node)
      retainedNodeIds.add(node.node_id)
    }
    retainedRelationships.push(relationship)
    retainedRelationshipIds.add(relationship.id)
    return true
  }

  // Preserve directly ranked query phases before intermediates. A file or
  // token cap may truncate the connecting path, but must not silently replace
  // an explicit phase with a lexicographically earlier intermediate.
  const priorityIds = new Set(input.priorityNodeIds)
  for (const nodeId of input.priorityNodeIds) {
    const node = nodesById.get(nodeId)
    if (!node || retainedNodeIds.has(nodeId)) continue
    const candidate = resultWithTokenCount(
      input,
      [...retainedNodes, node],
      retainedRelationships,
      retainedBoundaries,
    )
    if (withinBudget(candidate, input.request.budget)) {
      retainedNodes.push(node)
      retainedNodeIds.add(node.node_id)
    }
  }

  // Prefer complete causal facts next: an edge enters the result together with
  // any endpoints it still needs, before unrelated standalone nodes consume
  // space.
  for (const relationship of capped.relationships) tryRelationship(relationship, true)

  for (const node of capped.nodes) {
    if (retainedNodeIds.has(node.node_id) || priorityIds.has(node.node_id)) continue
    const candidateNodes = [...retainedNodes, node]
    const candidate = resultWithTokenCount(
      input,
      candidateNodes,
      retainedRelationships,
      retainedBoundaries,
    )
    if (withinBudget(candidate, input.request.budget)) {
      retainedNodes.push(node)
      retainedNodeIds.add(node.node_id)
    }
  }

  // A relationship whose full bundle did not fit may fit after another causal
  // bundle or standalone selection retained both of its endpoints.
  for (const relationship of capped.relationships) {
    if (!retainedRelationshipIds.has(relationship.id)) tryRelationship(relationship, false)
  }

  // Diagnostics explain omissions, but they must not evict the authenticated
  // phase evidence the query was asked to return. Add as many complete
  // boundaries as the remaining budget permits after causal facts.
  for (const boundary of boundaries.filter((candidate) => candidate.kind !== 'truncated')) {
    const candidateBoundaries = deduplicateBoundaries([...retainedBoundaries, boundary])
    const candidate = resultWithTokenCount(
      input,
      retainedNodes,
      retainedRelationships,
      candidateBoundaries,
    )
    if (withinBudget(candidate, input.request.budget)) {
      retainedBoundaries.splice(0, retainedBoundaries.length, ...candidateBoundaries)
    }
  }

  const finalInput = retainedNodes.length === 0 && input.outcome === 'evidence'
    ? { outcome: 'missing' as const, closurePasses: input.closurePasses }
    : input

  return resultWithTokenCount(
    finalInput,
    retainedNodes,
    retainedRelationships,
    retainedBoundaries,
  )
}
