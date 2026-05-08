import { createHash } from 'node:crypto'

import type {
  CompiledContextPack,
  ContextPackClaim,
  ContextPackCommunityContext,
  ContextPackCoverage,
  ContextPackCoverageEntry,
  ContextPackEvidenceClass,
  ContextPackExpandableFollowUp,
  ContextPackExpandableLineRange,
  ContextPackExpandablePreview,
  ContextPackExpandableRef,
  ContextPackExpandableSourceRange,
  ContextPackGraphSignals,
  ContextPackNode,
  ContextPackRelationship,
  ContextPackSemanticCategory,
  ContextPackSemanticCoverageEntry,
  ContextPackTaskContract,
  ContextPackTaskKind,
} from '../contracts/context-pack.js'
import type { TaskIntentKind } from '../contracts/task-intent.js'
import { estimateQueryTokens } from './serve.js'
import { resolveTaskEvidenceRecipe } from './task-evidence-recipes.js'

export interface ClassifyTaskContractOptions {
  budget: number
  prompt?: string
  task_intent?: TaskIntentKind
  has_change_evidence?: boolean
}

export interface ContextPackNodeCandidate<TNode extends ContextPackNode = ContextPackNode> {
  label: string
  node_id?: string | undefined
  community?: number | null
  source_file?: string
  line_number?: number
  file_type?: string
  node_kind?: string
  snippet?: string | null
  evidence_class: ContextPackEvidenceClass
  expandable_ref?: ContextPackExpandablePreview
  estimate_tokens: () => number
  build_entry: () => TNode
}

export interface CompileContextPackInput<
  TNode extends ContextPackNode = ContextPackNode,
  TRelationship extends ContextPackRelationship = ContextPackRelationship,
  TCommunity extends ContextPackCommunityContext = ContextPackCommunityContext,
> {
  task_contract: ContextPackTaskContract
  nodes: readonly ContextPackNodeCandidate<TNode>[]
  relationships?: readonly TRelationship[]
  community_context?: readonly TCommunity[]
  graph_signals?: ContextPackGraphSignals
}

export type CompactContextPackMode =
  | {
    kind: 'retrieve'
    max_nodes?: number
    hoist_empty_shared_file_type?: boolean
  }
  | {
    kind: 'review'
    seed_node_ids?: readonly string[]
    seed_labels?: readonly string[]
    max_supporting_nodes?: number
  }

interface CoverageNodeCandidate {
  candidate: ContextPackNodeCandidate
  entry: Pick<ContextPackNode, 'label' | 'source_file' | 'file_type' | 'node_kind' | 'snippet'>
}

type CoverageEntry = CoverageNodeCandidate['entry']

const TEST_PATH_PATTERN = /(?:^|\/)(?:__tests__|tests?|fixtures?)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i
const CONFIG_PATH_PATTERN = /(?:^|\/)(?:config|configs?|settings|env)(?:\/|$)|(?:^|\/)\.env(?:\.[^/]+)?$|(?:^|\/)(?:package|tsconfig|vite|vitest|jest|eslint|prettier|rollup|webpack)\.(?:json|[cm]?js|ts|mjs|cjs)$/i
const CONTRACT_PATH_PATTERN = /(?:^|\/)(?:contracts?|schemas?|dto|types?|interfaces?|openapi|graphql)(?:\/|$)|(?:^|\/)[^/]*\.d\.ts$/i
const CONTRACT_NODE_KINDS = new Set(['interface', 'type', 'type_alias', 'typealias', 'enum', 'schema', 'contract'])
const ALL_SEMANTIC_CATEGORIES: readonly ContextPackSemanticCategory[] = [
  'implementation',
  'changes',
  'impact',
  'tests',
  'configuration',
  'contracts',
  'structure',
]

function includedNodeId(node: Pick<ContextPackNode, 'node_id'>): string | null {
  return typeof node.node_id === 'string' && node.node_id.length > 0 ? node.node_id : null
}

function filterRelationships<TRelationship extends ContextPackRelationship>(
  relationships: readonly TRelationship[],
  nodes: readonly ContextPackNode[],
): TRelationship[] {
  const includedIds = new Set(nodes.map(includedNodeId).filter((nodeId): nodeId is string => nodeId !== null))
  const includedLabels = new Set(nodes.map((node) => node.label))

  return relationships.filter((relationship) => {
    if (includedIds.size > 0 && relationship.from_id && relationship.to_id) {
      return includedIds.has(relationship.from_id) && includedIds.has(relationship.to_id)
    }

    return includedLabels.has(relationship.from) && includedLabels.has(relationship.to)
  })
}

function sharedFileTypeForNodes(nodes: readonly ContextPackNode[]): string | undefined {
  return nodes.length > 0 && nodes.every((node) => node.file_type === nodes[0]?.file_type)
    ? nodes[0]?.file_type
    : undefined
}

function classifyCoverageStatus(required: boolean, availableNodes: number, selectedNodes: number): ContextPackCoverageEntry['status'] {
  if (selectedNodes > 0) {
    return 'covered'
  }

  if (required) {
    return 'missing'
  }

  return availableNodes > 0 ? 'available' : 'missing'
}

function coverageEntriesForCandidates(
  taskContract: ContextPackTaskContract,
  nodes: readonly CoverageNodeCandidate[],
  selectedNodes: readonly CoverageNodeCandidate[],
  selectedCounts: ReadonlyMap<ContextPackEvidenceClass, number>,
  relationshipCounts: { available: number; selected: number },
): ContextPackCoverage {
  const availableCounts = new Map<ContextPackEvidenceClass, number>()
  for (const node of nodes) {
    availableCounts.set(node.candidate.evidence_class, (availableCounts.get(node.candidate.evidence_class) ?? 0) + 1)
  }

  const evidenceClasses = orderedEvidence(taskContract, availableCounts.keys())

  const entries: ContextPackCoverageEntry[] = evidenceClasses.map((evidence_class) => {
    const available_nodes = availableCounts.get(evidence_class) ?? 0
    const selected_nodes = selectedCounts.get(evidence_class) ?? 0
    const required = taskContract.required_evidence.includes(evidence_class)

    return {
      evidence_class,
      required,
      available_nodes,
      selected_nodes,
      status: classifyCoverageStatus(required, available_nodes, selected_nodes),
    }
  })

  const semanticAvailableCounts = semanticCategoryCounts(nodes)
  const semanticSelectedCounts = semanticCategoryCounts(selectedNodes)
  const semanticEntries = orderedSemanticCategories(
    taskContract,
    new Set([...semanticAvailableCounts.keys(), ...semanticSelectedCounts.keys()]),
  ).map((category) => {
    const available_nodes = semanticAvailableCounts.get(category) ?? 0
    const selected_nodes = semanticSelectedCounts.get(category) ?? 0
    const required = taskContract.semantic_required.includes(category)

    return {
      category,
      label: semanticCoverageLabel(category),
      required,
      available_nodes,
      selected_nodes,
      status: classifyCoverageStatus(required, available_nodes, selected_nodes),
    } satisfies ContextPackSemanticCoverageEntry
  })

  return {
    required_evidence: [...taskContract.required_evidence],
    semantic_required: [...taskContract.semantic_required],
    semantic_optional: [...taskContract.semantic_optional],
    entries,
    semantic_entries: semanticEntries,
    missing_required: entries.filter((entry) => entry.required && entry.selected_nodes === 0).map((entry) => entry.evidence_class),
    missing_semantic: semanticEntries.filter((entry) => entry.required && entry.selected_nodes === 0).map((entry) => entry.category),
    available_relationships: relationshipCounts.available,
    selected_relationships: relationshipCounts.selected,
  }
}

function semanticCoverageLabel(category: ContextPackSemanticCategory): string {
  return category.replace(/_/g, ' ')
}

function orderedSemanticCategories(
  taskContract: ContextPackTaskContract,
  categories: Iterable<ContextPackSemanticCategory>,
): ContextPackSemanticCategory[] {
  const ordered: ContextPackSemanticCategory[] = []
  const seen = new Set<ContextPackSemanticCategory>()

  for (const category of [
    ...taskContract.semantic_required,
    ...taskContract.semantic_optional,
    ...categories,
  ]) {
    if (seen.has(category)) {
      continue
    }
    seen.add(category)
    ordered.push(category)
  }

  return ordered
}

function isTestEntry(entry: CoverageEntry): boolean {
  return TEST_PATH_PATTERN.test(entry.source_file)
}

function isConfigurationEntry(entry: CoverageEntry): boolean {
  if (CONFIG_PATH_PATTERN.test(entry.source_file)) {
    return true
  }

  const text = `${entry.label} ${entry.snippet ?? ''}`.toLowerCase()
  return text.includes('process.env') || text.includes('import.meta.env')
}

function isContractEntry(entry: CoverageEntry): boolean {
  return CONTRACT_PATH_PATTERN.test(entry.source_file)
    || (typeof entry.node_kind === 'string' && CONTRACT_NODE_KINDS.has(entry.node_kind.toLowerCase()))
}

function isImplementationEntry(entry: CoverageEntry): boolean {
  return entry.file_type === 'code'
    && !isTestEntry(entry)
    && !isConfigurationEntry(entry)
    && !isContractEntry(entry)
}

function semanticCategoryMatches(category: ContextPackSemanticCategory, node: CoverageNodeCandidate): boolean {
  switch (category) {
    case 'implementation':
      return isImplementationEntry(node.entry)
    case 'changes':
      return node.candidate.evidence_class === 'change'
    case 'impact':
      return node.candidate.evidence_class === 'impact'
    case 'tests':
      return isTestEntry(node.entry)
    case 'configuration':
      return isConfigurationEntry(node.entry)
    case 'contracts':
      return isContractEntry(node.entry)
    case 'structure':
      return node.candidate.evidence_class === 'structural'
  }
}

function semanticCategoryCounts(
  nodes: readonly CoverageNodeCandidate[],
): ReadonlyMap<ContextPackSemanticCategory, number> {
  const counts = new Map<ContextPackSemanticCategory, number>()

  for (const node of nodes) {
    for (const category of ALL_SEMANTIC_CATEGORIES) {
      if (!semanticCategoryMatches(category, node)) {
        continue
      }

      counts.set(category, (counts.get(category) ?? 0) + 1)
    }
  }

  return counts
}

function claimLabel(className: ContextPackEvidenceClass): string {
  return className.replace(/_/g, ' ')
}

function buildClaims(
  taskContract: ContextPackTaskContract,
  labelsByEvidence: ReadonlyMap<ContextPackEvidenceClass, string[]>,
): ContextPackClaim[] {
  const evidenceOrder = orderedEvidence(taskContract, labelsByEvidence.keys())

  return evidenceOrder.flatMap((evidence_class) => {
    const nodeLabels = labelsByEvidence.get(evidence_class) ?? []
    if (nodeLabels.length === 0) {
      return []
    }

    return [{
      evidence_class,
      text: `${claimLabel(evidence_class)} evidence: ${nodeLabels.slice(0, 3).join(', ')}`,
      node_labels: nodeLabels.slice(0, 3),
    }]
  })
}

function buildExpandableRefs(
  taskContract: ContextPackTaskContract,
  omittedNodes: readonly ContextPackNodeCandidate[],
): ContextPackExpandableRef[] {
  const omittedByEvidence = new Map<ContextPackEvidenceClass, ContextPackExpandablePreview[]>()
  for (const node of omittedNodes) {
    const previews = omittedByEvidence.get(node.evidence_class) ?? []
    previews.push(expandablePreviewForCandidate(node))
    omittedByEvidence.set(node.evidence_class, previews)
  }

  const evidenceOrder = orderedEvidence(taskContract, omittedByEvidence.keys())

  return evidenceOrder.flatMap((evidence_class) => {
    const previews = omittedByEvidence.get(evidence_class) ?? []
    if (previews.length === 0) {
      return []
    }

    const handleId = stableExpandableHandleId(taskContract, evidence_class, previews)
    return [{
      kind: 'nodes',
      handle_id: handleId,
      evidence_class,
      count: previews.length,
      preview: previews.slice(0, 3),
      follow_up: expandableFollowUp(taskContract, evidence_class, previews),
    }]
  })
}

function normalizeExpandableLineRange(range: ContextPackExpandableLineRange | undefined): ContextPackExpandableLineRange | undefined {
  if (!range) {
    return undefined
  }

  const start = range.start_line
  const end = range.end_line
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < 1) {
    return undefined
  }

  return {
    start_line: Math.min(start, end),
    end_line: Math.max(start, end),
  }
}

function expandablePreviewForCandidate(candidate: ContextPackNodeCandidate): ContextPackExpandablePreview {
  let fallback: ContextPackNode | undefined
  const fallbackEntry = (): ContextPackNode => {
    fallback ??= candidate.build_entry()
    return fallback
  }
  const providedLineRange = normalizeExpandableLineRange(candidate.expandable_ref?.line_range)
  const lineRange = providedLineRange ?? (() => {
    const lineNumber = typeof candidate.line_number === 'number' ? candidate.line_number : fallbackEntry().line_number
    return Number.isFinite(lineNumber) && Number.isInteger(lineNumber) && lineNumber > 0
      ? {
          start_line: lineNumber,
          end_line: lineNumber,
        }
      : undefined
  })()
  const fallbackNodeId = typeof candidate.node_id === 'string'
    ? candidate.node_id
    : typeof fallback?.node_id === 'string'
      ? fallback.node_id
      : undefined
  const sourceFile = candidate.expandable_ref?.source_file
    ?? candidate.source_file
    ?? fallback?.source_file
    ?? fallbackEntry().source_file

  return {
    ...(typeof candidate.expandable_ref?.node_id === 'string'
      ? { node_id: candidate.expandable_ref.node_id }
      : typeof fallbackNodeId === 'string'
        ? { node_id: fallbackNodeId }
      : {}),
    label: candidate.expandable_ref?.label ?? candidate.label,
    source_file: sourceFile,
    ...(lineRange ? { line_range: lineRange } : {}),
  }
}

function expandablePreviewSignature(preview: ContextPackExpandablePreview): string {
  const range = preview.line_range
    ? `${preview.line_range.start_line}-${preview.line_range.end_line}`
    : ''
  return [
    preview.node_id ?? '',
    preview.label,
    preview.source_file,
    range,
  ].join('\u0000')
}

function stableExpandableHandleId(
  taskContract: ContextPackTaskContract,
  evidenceClass: ContextPackEvidenceClass,
  previews: readonly ContextPackExpandablePreview[],
): string {
  const digest = createHash('sha1')
    .update(previews.map(expandablePreviewSignature).sort().join('\u0001'))
    .digest('hex')
    .slice(0, 12)
  return `expand:${taskContract.task_kind}:${evidenceClass}:${digest}`
}

function sourceRangeSignature(range: ContextPackExpandableSourceRange): string {
  return `${range.source_file}\u0000${range.start_line}\u0000${range.end_line}`
}

function expandableFollowUp(
  taskContract: ContextPackTaskContract,
  evidenceClass: ContextPackEvidenceClass,
  previews: readonly ContextPackExpandablePreview[],
): ContextPackExpandableFollowUp {
  const focus_files = [...new Set(previews.map((preview) => preview.source_file).filter((sourceFile) => sourceFile.length > 0))]
    .sort((left, right) => left.localeCompare(right))
  const seenRanges = new Set<string>()
  const focus_ranges: ContextPackExpandableSourceRange[] = []

  for (const preview of previews) {
    if (!preview.line_range) {
      continue
    }

    const range = {
      source_file: preview.source_file,
      start_line: preview.line_range.start_line,
      end_line: preview.line_range.end_line,
    }
    const signature = sourceRangeSignature(range)
    if (seenRanges.has(signature)) {
      continue
    }

    seenRanges.add(signature)
    focus_ranges.push(range)
  }

  focus_ranges.sort((left, right) => {
    return left.source_file.localeCompare(right.source_file)
      || left.start_line - right.start_line
      || left.end_line - right.end_line
  })

  return {
    kind: 'context_pack',
    task_kind: taskContract.task_kind,
    evidence_class: evidenceClass,
    focus_files,
    focus_ranges,
  }
}

export function classifyTaskContract(
  taskKind: ContextPackTaskKind,
  options: ClassifyTaskContractOptions,
): ContextPackTaskContract {
  const recipe = resolveTaskEvidenceRecipe(taskKind, {
    ...(options.task_intent ? { task_intent: options.task_intent } : {}),
    ...(options.has_change_evidence !== undefined ? { has_change_evidence: options.has_change_evidence } : {}),
  })

  return {
    version: 1,
    task_kind: taskKind,
    ...(options.task_intent ? { task_intent: recipe.id } : {}),
    evidence_recipe_id: recipe.id,
    budget: options.budget,
    ...(options.prompt ? { prompt: options.prompt } : {}),
    required_evidence: [...recipe.required_evidence],
    preferred_evidence: [...recipe.preferred_evidence],
    semantic_required: [...recipe.semantic_required],
    semantic_optional: [...recipe.semantic_optional],
  }
}

function orderedEvidence(
  taskContract: ContextPackTaskContract,
  evidence: Iterable<ContextPackEvidenceClass>,
): ContextPackEvidenceClass[] {
  const ordered: ContextPackEvidenceClass[] = []
  const seen = new Set<ContextPackEvidenceClass>()

  for (const evidenceClass of [
    ...taskContract.preferred_evidence,
    ...taskContract.required_evidence,
    ...evidence,
  ]) {
    if (seen.has(evidenceClass)) {
      continue
    }
    seen.add(evidenceClass)
    ordered.push(evidenceClass)
  }

  return ordered
}

function sortCandidatesByEvidence<TNode extends ContextPackNode>(
  taskContract: ContextPackTaskContract,
  nodes: readonly ContextPackNodeCandidate<TNode>[],
): ContextPackNodeCandidate<TNode>[] {
  const evidenceOrder = orderedEvidence(taskContract, nodes.map((node) => node.evidence_class))
  const evidenceRanks = new Map(evidenceOrder.map((evidenceClass, index) => [evidenceClass, index]))

  return nodes
    .map((node, index) => ({ node, index }))
    .sort((left, right) => {
      const leftRank = evidenceRanks.get(left.node.evidence_class) ?? evidenceOrder.length
      const rightRank = evidenceRanks.get(right.node.evidence_class) ?? evidenceOrder.length
      if (leftRank !== rightRank) {
        return leftRank - rightRank
      }
      return left.index - right.index
    })
    .map((entry) => entry.node)
}

function coverageEntryForCandidate(candidate: ContextPackNodeCandidate): CoverageNodeCandidate {
  if (typeof candidate.source_file === 'string' && candidate.source_file.length > 0) {
    return {
      candidate,
      entry: {
        label: candidate.label,
        source_file: candidate.source_file,
        file_type: candidate.file_type,
        node_kind: candidate.node_kind,
        snippet: candidate.snippet ?? null,
      },
    }
  }

  const entry = candidate.build_entry()
  return {
    candidate,
    entry: {
      label: entry.label,
      source_file: entry.source_file,
      file_type: entry.file_type,
      node_kind: entry.node_kind,
      snippet: entry.snippet ?? null,
    },
  }
}

export function estimateContextPackEntryTokens(
  label: string,
  sourceFile: string,
  lineNumber: number,
  snippet: string | null,
): number {
  return estimateQueryTokens(`${label} ${sourceFile}:${lineNumber} ${snippet ?? ''}`)
}

export function compileContextPack<
  TNode extends ContextPackNode = ContextPackNode,
  TRelationship extends ContextPackRelationship = ContextPackRelationship,
  TCommunity extends ContextPackCommunityContext = ContextPackCommunityContext,
>(
  input: CompileContextPackInput<TNode, TRelationship, TCommunity>,
): CompiledContextPack<TNode, TRelationship, TCommunity> {
  const orderedNodes = sortCandidatesByEvidence(input.task_contract, input.nodes)
  const coverageNodes = orderedNodes.map((candidate) => coverageEntryForCandidate(candidate))
  const selectedNodes: TNode[] = []
  const selectedCoverage: CoverageNodeCandidate[] = []
  const selectedCounts = new Map<ContextPackEvidenceClass, number>()
  const selectedLabelsByEvidence = new Map<ContextPackEvidenceClass, string[]>()
  const selectedCommunities = new Set<number>()
  let tokenCount = 0
  let breakIndex = orderedNodes.length

  for (const [index, candidate] of orderedNodes.entries()) {
    const candidateTokens = candidate.estimate_tokens()
    if (tokenCount + candidateTokens > input.task_contract.budget && selectedNodes.length > 0) {
      breakIndex = index
      break
    }

    const entry = candidate.build_entry()
    selectedNodes.push(entry)
    selectedCoverage.push({
      candidate,
      entry: {
        label: entry.label,
        source_file: entry.source_file,
        file_type: entry.file_type,
        node_kind: entry.node_kind,
        snippet: entry.snippet ?? null,
      },
    })
    tokenCount += candidateTokens
    selectedCounts.set(candidate.evidence_class, (selectedCounts.get(candidate.evidence_class) ?? 0) + 1)

    const selectedLabels = selectedLabelsByEvidence.get(candidate.evidence_class) ?? []
    if (!selectedLabels.includes(candidate.label)) {
      selectedLabels.push(candidate.label)
    }
    selectedLabelsByEvidence.set(candidate.evidence_class, selectedLabels)

    if (typeof candidate.community === 'number') {
      selectedCommunities.add(candidate.community)
    }
  }

  const omittedNodes = orderedNodes.slice(breakIndex)
  const relationships = filterRelationships(input.relationships ?? [], selectedNodes)
  const includedLabels = new Set(selectedNodes.map((node) => node.label))

  return {
    task_contract: input.task_contract,
    token_count: tokenCount,
    nodes: selectedNodes,
    relationships,
    community_context: (input.community_context ?? []).filter((community) => selectedCommunities.has(community.id)),
    claims: buildClaims(input.task_contract, selectedLabelsByEvidence),
    expandable: buildExpandableRefs(input.task_contract, omittedNodes),
    coverage: coverageEntriesForCandidates(
      input.task_contract,
      coverageNodes,
      selectedCoverage,
      selectedCounts,
      {
        available: input.relationships?.length ?? 0,
        selected: relationships.length,
      },
    ),
    ...(input.graph_signals
      ? {
          graph_signals: {
            god_nodes: input.graph_signals.god_nodes.filter((label) => includedLabels.has(label)),
            bridge_nodes: input.graph_signals.bridge_nodes.filter((label) => includedLabels.has(label)),
          },
        }
      : {}),
  }
}

export function compactContextPack<
  TRelationship extends ContextPackRelationship = ContextPackRelationship,
  TCommunity extends ContextPackCommunityContext = ContextPackCommunityContext,
>(
  pack: CompiledContextPack<ContextPackNode, TRelationship, TCommunity>,
  mode: CompactContextPackMode,
): CompiledContextPack<ContextPackNode, ContextPackRelationship, TCommunity> {
  if (mode.kind === 'review') {
    const seedIds = new Set(mode.seed_node_ids ?? [])
    const seedLabels = new Set(mode.seed_labels ?? [])
    const compactNodes: ContextPackNode[] = []
    const includedRelationshipIds = new Set<string>()
    let supportNodes = 0

    for (const node of pack.nodes) {
      const isSeed = (typeof node.node_id === 'string' && seedIds.has(node.node_id)) || seedLabels.has(node.label)
      if (!isSeed && supportNodes >= (mode.max_supporting_nodes ?? Number.POSITIVE_INFINITY)) {
        continue
      }

      const {
        community_label: _communityLabel,
        framework_boost: _frameworkBoost,
        file_type: fileType,
        node_id: nodeId,
        match_score: matchScore,
        node_kind: nodeKind,
        ...rest
      } = node

      if (typeof node.node_id === 'string' && node.node_id.length > 0) {
        includedRelationshipIds.add(node.node_id)
      }

      compactNodes.push({
        ...rest,
        ...(typeof nodeKind === 'string' && nodeKind.trim().length > 0 ? { node_kind: nodeKind } : {}),
        ...(isSeed && typeof nodeId === 'string' && nodeId.length > 0 ? { node_id: nodeId } : {}),
        ...(isSeed ? { match_score: matchScore } : {}),
        ...(isSeed ? { snippet: node.snippet } : { snippet: null }),
        ...(fileType !== undefined ? { file_type: fileType } : {}),
      } as ContextPackNode)

      if (!isSeed) {
        supportNodes += 1
      }
    }

    const sharedFileType = sharedFileTypeForNodes(compactNodes)
    const compactNodesWithoutSharedFileType = sharedFileType !== undefined
      ? compactNodes.map(({ file_type: _fileType, ...node }) => node)
      : compactNodes
    const compactNodePayload = sharedFileType !== undefined
      ? { shared_file_type: sharedFileType, nodes: compactNodesWithoutSharedFileType }
      : compactNodesWithoutSharedFileType
    const includedLabels = new Set(compactNodesWithoutSharedFileType.map((node) => node.label))
    const relationships = pack.relationships.filter((relationship) => {
      if (includedRelationshipIds.size > 0 && relationship.from_id && relationship.to_id) {
        return includedRelationshipIds.has(relationship.from_id) && includedRelationshipIds.has(relationship.to_id)
      }

      return includedLabels.has(relationship.from) && includedLabels.has(relationship.to)
    }).map((relationship) => {
      const { from_id: _fromId, to_id: _toId, ...rest } = relationship
      return rest
    })
    const includedCommunities = new Set(compactNodesWithoutSharedFileType.flatMap((node) => (typeof node.community === 'number' ? [node.community] : [])))

    return {
      ...pack,
      token_count: compactNodesWithoutSharedFileType.length === 0 ? 0 : estimateQueryTokens(JSON.stringify(compactNodePayload)),
      nodes: compactNodesWithoutSharedFileType,
      relationships,
      community_context: pack.community_context.filter((community) => includedCommunities.has(community.id)),
      ...(sharedFileType !== undefined ? { shared_file_type: sharedFileType as string } : {}),
    }
  }

  const limitedNodes = pack.nodes.slice(0, mode.max_nodes ?? pack.nodes.length)
  const sharedFileType = sharedFileTypeForNodes(limitedNodes)
  const shouldHoistSharedFileType = mode.hoist_empty_shared_file_type === true
    ? sharedFileType !== undefined
    : Boolean(sharedFileType)

  const nodes = limitedNodes.map(({ community_label: _communityLabel, framework_boost: _frameworkBoost, file_type: fileType, node_kind: nodeKind, ...node }) => ({
    ...node,
    ...(typeof nodeKind === 'string' && nodeKind.trim().length > 0 ? { node_kind: nodeKind } : {}),
    ...(shouldHoistSharedFileType ? {} : { file_type: fileType }),
  }) as ContextPackNode)
  const relationships = filterRelationships(pack.relationships, nodes)
  const includedCommunities = new Set(nodes.flatMap((node) => (typeof node.community === 'number' ? [node.community] : [])))
  const includedLabels = new Set(nodes.map((node) => node.label))

  return {
    ...pack,
    token_count: nodes.reduce(
      (total, node) => total + estimateContextPackEntryTokens(node.label, node.source_file, node.line_number, node.snippet ?? null),
      0,
    ),
    nodes,
    relationships,
    community_context: pack.community_context.filter((community) => includedCommunities.has(community.id)),
    ...(pack.graph_signals
      ? {
          graph_signals: {
            god_nodes: pack.graph_signals.god_nodes.filter((label) => includedLabels.has(label)),
            bridge_nodes: pack.graph_signals.bridge_nodes.filter((label) => includedLabels.has(label)),
          },
        }
      : {}),
    ...(shouldHoistSharedFileType ? { shared_file_type: sharedFileType as string } : {}),
  }
}
