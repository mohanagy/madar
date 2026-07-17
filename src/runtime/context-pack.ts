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
  ContextPackExplainAnswerReadySummary,
  ContextPackExecutionSlice,
  ContextPackGraphSignals,
  ContextPackNode,
  ContextPackRelationship,
  ContextPackSelectionDiagnostics,
  ContextPackSelectionRankingEntry,
  ContextPackSemanticCategory,
  ContextPackSemanticCoverageEntry,
  ContextPackTaskContract,
  ContextPackTaskKind,
} from '../contracts/context-pack.js'
import type { RetrievalGateDecision } from '../contracts/retrieval-gate.js'
import type { TaskIntentKind } from '../contracts/task-intent.js'
import { classifySourceDomain, type SourceDomain } from '../shared/source-discovery.js'
import { applyContextPackResolution } from './context-pack-resolution.js'
import { estimateQueryTokens } from './serve.js'
import { resolveTaskEvidenceRecipe } from './task-evidence-recipes.js'
import { selectByValuePerToken, type ValuePerTokenCandidate } from './value-per-token.js'

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
  framework?: string
  framework_role?: string
  framework_boost?: number
  source_domain?: SourceDomain
  match_score?: number
  exact_anchor_match?: boolean
  direct_symbol_match?: boolean
  source_path_match?: boolean
  graph_signal?: 'bridge' | 'god' | 'high-impact'
  graph_degree?: number
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
  /**
   * Retrieval-gate decision (#75). When supplied, the resulting
   * CompiledContextPack carries it through unchanged so consumers can
   * audit retrieval scope. The gate is *not* re-classified here — callers
   * compute it once and pass the result down.
   */
  retrieval_gate?: RetrievalGateDecision
  /**
   * v0.20 #131 — strategy for choosing candidates under budget:
   *   - 'evidence-order' (default): walk sortCandidatesByEvidence order,
   *     take until budget overflow. Same behaviour as v0.19 and earlier.
   *   - 'value-per-token': required-evidence-class candidates are
   *     placed first (must-include), then the remaining optional
   *     candidates are picked by density (score / token_cost) via
   *     selectByValuePerToken. Higher information density per token at
   *     the same budget.
   */
  selection_strategy?: ContextPackSelectionStrategy
}

export type ContextPackSelectionStrategy = 'evidence-order' | 'value-per-token'

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

interface CandidateScoringView extends CoverageEntry {
  match_score: number
  framework?: string
  framework_role?: string
  framework_boost: number
  source_domain: SourceDomain
  exact_anchor_match: boolean
  direct_symbol_match: boolean
  source_path_match: boolean
  graph_signal?: 'bridge' | 'god' | 'high-impact'
  graph_degree?: number
}

interface CandidateValueScore {
  score: number
  reasons: string[]
  penalties: string[]
}

interface RankedValueCandidate<TNode extends ContextPackNode> {
  id: string
  candidate: ContextPackNodeCandidate<TNode>
  score: number
  token_cost: number
  density: number
  reasons: string[]
  penalties: string[]
}

type CoverageEntry = CoverageNodeCandidate['entry']

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
  const selectedSourceFileCount = new Set(
    selectedNodes.map((node) => node.entry.source_file).filter((sourceFile) => sourceFile.length > 0),
  ).size
  const selectedDirectNodeCount = (selectedCounts.get('primary') ?? 0) + (selectedCounts.get('change') ?? 0)

  const entries: ContextPackCoverageEntry[] = evidenceClasses.map((evidence_class) => {
    const available_nodes = availableCounts.get(evidence_class) ?? 0
    const selected_nodes = selectedCounts.get(evidence_class) ?? 0
    const required = taskContract.required_evidence.includes(evidence_class)
    const relationshipBacked = taskContract.task_kind === 'explain'
      && available_nodes === 0
      && selectedNodes.length >= 2
      && relationshipCounts.selected > 0
      && (evidence_class === 'supporting' || evidence_class === 'structural')
    const crossFileDirectSupport = taskContract.task_kind === 'explain'
      && evidence_class === 'supporting'
      && selected_nodes === 0
      // Reserve this exception for genuinely broad, cross-layer traces. A
      // small local cluster can span three files (entrypoint, owner, helper)
      // while still needing the omitted supporting node that recovery would
      // add. Five distinct owners is the smallest boundary that separates the
      // multi-service flow case from those ordinary local explanations.
      && selectedDirectNodeCount >= 5
      && selectedSourceFileCount >= 5
      && relationshipCounts.selected > 0

    return {
      evidence_class,
      required,
      available_nodes,
      selected_nodes,
      // A coherent relationship between selected primary nodes is real
      // supporting/structural evidence. A diverse cross-file set of direct
      // workflow owners can also satisfy supporting evidence even when weaker
      // related candidates exist; forcing one of those candidates into the
      // pack would replace stronger obligation evidence merely to satisfy a
      // ranking label.
      status: relationshipBacked || crossFileDirectSupport
        ? 'covered'
        : classifyCoverageStatus(required, available_nodes, selected_nodes),
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
    const relationshipBacked = taskContract.task_kind === 'explain'
      && category === 'structure'
      && available_nodes === 0
      && selectedNodes.length >= 2
      && relationshipCounts.selected > 0

    return {
      category,
      label: semanticCoverageLabel(category),
      required,
      available_nodes,
      selected_nodes,
      status: relationshipBacked ? 'covered' : classifyCoverageStatus(required, available_nodes, selected_nodes),
    } satisfies ContextPackSemanticCoverageEntry
  })

  return {
    required_evidence: [...taskContract.required_evidence],
    semantic_required: [...taskContract.semantic_required],
    semantic_optional: [...taskContract.semantic_optional],
    entries,
    semantic_entries: semanticEntries,
    missing_required: entries.filter((entry) => entry.required && entry.status !== 'covered').map((entry) => entry.evidence_class),
    missing_semantic: semanticEntries.filter((entry) => entry.required && entry.status !== 'covered').map((entry) => entry.category),
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
  return classifySourceDomain(entry.source_file) === 'test'
}

function isConfigurationEntry(entry: CoverageEntry): boolean {
  if (classifySourceDomain(entry.source_file) === 'config') {
    return true
  }
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
  if (
    typeof candidate.source_file === 'string'
    && candidate.source_file.length > 0
    && !needsMaterializedCoverageEntry(candidate)
  ) {
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

function needsMaterializedCoverageEntry(candidate: ContextPackNodeCandidate): boolean {
  if (typeof candidate.source_file !== 'string' || candidate.source_file.length === 0) {
    return true
  }
  if (typeof candidate.snippet === 'string' && candidate.snippet.length > 0) {
    return false
  }

  const entry = {
    label: candidate.label,
    source_file: candidate.source_file,
    file_type: candidate.file_type,
    node_kind: candidate.node_kind,
    snippet: null,
  } satisfies CoverageEntry

  return candidate.file_type === 'code'
    && !isTestEntry(entry)
    && !isConfigurationEntry(entry)
    && !isContractEntry(entry)
}

function selectionCandidateId(candidate: ContextPackNodeCandidate): string {
  if (typeof candidate.node_id === 'string' && candidate.node_id.length > 0) {
    return candidate.node_id
  }

  return [
    candidate.label,
    candidate.source_file ?? '',
    candidate.line_number ?? 0,
  ].join(':')
}

function scoringViewForCandidate(candidate: ContextPackNodeCandidate): CandidateScoringView {
  const builtEntry = (): ContextPackNode => candidate.build_entry()
  const source_file = candidate.source_file ?? builtEntry().source_file
  const file_type = candidate.file_type ?? builtEntry().file_type
  const node_kind = candidate.node_kind ?? builtEntry().node_kind
  const snippet = candidate.snippet ?? builtEntry().snippet ?? null
  const framework = candidate.framework ?? builtEntry().framework
  const frameworkRole = candidate.framework_role ?? builtEntry().framework_role
  const sourceDomain = candidate.source_domain ?? builtEntry().source_domain ?? classifySourceDomain(source_file)

  return {
    label: candidate.label,
    source_file,
    file_type,
    node_kind,
    snippet,
    match_score: candidate.match_score
      ?? builtEntry().match_score
      ?? 0,
    framework_boost: candidate.framework_boost
      ?? builtEntry().framework_boost
      ?? 0,
    source_domain: sourceDomain,
    exact_anchor_match: candidate.exact_anchor_match ?? false,
    direct_symbol_match: candidate.direct_symbol_match ?? false,
    source_path_match: candidate.source_path_match ?? false,
    ...(typeof framework === 'string' && framework.length > 0 ? { framework } : {}),
    ...(typeof frameworkRole === 'string' && frameworkRole.length > 0 ? { framework_role: frameworkRole } : {}),
    ...(candidate.graph_signal ? { graph_signal: candidate.graph_signal } : {}),
    ...(typeof candidate.graph_degree === 'number' ? { graph_degree: candidate.graph_degree } : {}),
  }
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) {
    target.push(value)
  }
}

function looksLikeBarrelFile(sourceFile: string): boolean {
  return /(?:^|\/)index\.[^/]+$/i.test(sourceFile)
}

function looksGenerated(sourceFile: string, label: string, snippet: string | null): boolean {
  const normalizedSourceFile = sourceFile.replace(/\\/g, '/')
  if (/(?:^|\/)(?:__snapshots__|dist|build|coverage|out)(?:\/|$)/i.test(normalizedSourceFile) || /generated|\.min\./i.test(normalizedSourceFile)) {
    return true
  }

  return label.toLowerCase().includes('generated')
    || (typeof snippet === 'string' && /@generated|generated by/i.test(snippet))
}

function looksArtifact(sourceFile: string): boolean {
  return /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|dist\/|build\/|coverage\/|out\/)/i.test(sourceFile)
}

function looksScriptMigration(sourceFile: string, label: string): boolean {
  const normalizedSourceFile = sourceFile.replace(/\\/g, '/')
  return /(?:^|\/)(?:scripts?|migrations?|seeds?|backfills?)(?:\/|$)|\b(?:migrate|migration|backfill|seed)\b/i.test(normalizedSourceFile)
    || /\b(?:migrate|migration|backfill|seed)\b/i.test(label)
}

function promptAllowsScriptMigration(prompt: string | undefined): boolean {
  return /\b(?:scripts?|migrat(?:e|ed|es|ing|ion)|backfill|cli|one-off|repair|old pipeline|seed(?:ing|ers?)|seeds?\s+(?:data|db|database|scripts?|files?))\b/i.test(prompt ?? '')
}

function sourceDomainPenalty(view: CandidateScoringView, taskContract: ContextPackTaskContract): number {
  switch (view.source_domain) {
    case 'test':
      return taskContract.semantic_required.includes('tests') || taskContract.semantic_optional.includes('tests') ? 0 : 2
    case 'benchmark':
    case 'fixture':
      return 2
    case 'generated':
    case 'build_artifact':
      return 3
    case 'docs':
      return 1
    case 'config':
      return taskContract.semantic_required.includes('configuration') || taskContract.semantic_optional.includes('configuration') ? 0 : 0.5
    case 'production':
    case 'unknown':
      return 0
  }
}

function looksTypeOnly(view: CoverageEntry): boolean {
  const sourceFile = view.source_file.toLowerCase()
  const label = view.label.toLowerCase()
  const nodeKind = view.node_kind?.toLowerCase() ?? ''
  return sourceFile.includes('/types/')
    || sourceFile.includes('/dto/')
    || sourceFile.endsWith('.d.ts')
    || nodeKind === 'interface'
    || nodeKind === 'type'
    || nodeKind === 'type_alias'
    || label.endsWith('dto')
    || label.endsWith('types')
}

function exactCodeRequested(taskContract: ContextPackTaskContract): boolean {
  return taskContract.task_kind === 'explain'
    || taskContract.task_kind === 'impact'
    || taskContract.semantic_required.includes('implementation')
}

function frameworkRoleMatchesPrompt(prompt: string | undefined, frameworkRole: string | undefined): boolean {
  if (!prompt || !frameworkRole) {
    return false
  }

  const lowerPrompt = prompt.toLowerCase()
  const lowerRole = frameworkRole.toLowerCase()
  return (
    (lowerRole.includes('route') && /\b(route|routes|endpoint|endpoints|get|post|put|patch|delete)\b/i.test(lowerPrompt)) ||
    (lowerRole.includes('controller') && /\b(controller|controllers)\b/i.test(lowerPrompt)) ||
    (lowerRole.includes('service') && /\b(service|services)\b/i.test(lowerPrompt)) ||
    (lowerRole.includes('provider') && /\b(provider|providers|injectable|service|services)\b/i.test(lowerPrompt)) ||
    (lowerRole.includes('guard') && /\b(guard|guards|auth|authorization)\b/i.test(lowerPrompt)) ||
    (lowerRole.includes('middleware') && /\b(middleware|middlewares|auth)\b/i.test(lowerPrompt)) ||
    (lowerRole.includes('procedure') && /\b(procedure|procedures|query|queries|mutation|mutations|subscription)\b/i.test(lowerPrompt)) ||
    (lowerRole.includes('module') && /\b(module|modules)\b/i.test(lowerPrompt))
  )
}

function duplicatePenaltyKey(candidate: ContextPackNodeCandidate, view: CandidateScoringView): string {
  return [
    view.source_file.toLowerCase(),
    candidate.evidence_class,
    view.label.toLowerCase(),
  ].join('\u0000')
}

function computeContextCandidateValue(
  candidate: ContextPackNodeCandidate,
  taskContract: ContextPackTaskContract,
  duplicateCounts: ReadonlyMap<string, number>,
): CandidateValueScore {
  const view = scoringViewForCandidate(candidate)
  const reasons: string[] = []
  const penalties: string[] = []
  let score = 0

  if (view.match_score > 0) {
    score += Math.min(6, view.match_score)
    pushUnique(reasons, 'match score')
  }

  if (taskContract.required_evidence.includes(candidate.evidence_class)) {
    score += 4
    pushUnique(reasons, 'required evidence')
  } else if (taskContract.preferred_evidence.includes(candidate.evidence_class)) {
    score += 2
    pushUnique(reasons, 'preferred evidence')
  }

  for (const category of taskContract.semantic_required) {
    if (!semanticCategoryMatches(category, { candidate, entry: view })) {
      continue
    }
    score += 2.5
    pushUnique(reasons, `${category} evidence`)
  }

  for (const category of taskContract.semantic_optional) {
    if (!semanticCategoryMatches(category, { candidate, entry: view })) {
      continue
    }
    score += 1.25
    pushUnique(reasons, `${category} evidence`)
  }

  if (taskContract.task_kind === 'impact' || taskContract.task_kind === 'review') {
    if (candidate.evidence_class === 'impact' || candidate.evidence_class === 'change') {
      score += 2
      pushUnique(reasons, 'impact evidence')
    }
    if (view.graph_signal === 'bridge' || view.graph_signal === 'high-impact') {
      score += 1.5
      pushUnique(reasons, 'impact graph signal')
    }
    if (view.graph_signal === 'god') {
      score += 1
      pushUnique(reasons, 'impact graph signal')
    }
  }

  if ((taskContract.task_kind === 'explain' || taskContract.task_kind === 'review') && isImplementationEntry(view)) {
    score += 1
    pushUnique(reasons, 'implementation evidence')
  }

  if (view.framework_boost > 0) {
    score += view.framework_boost * 1.25
    pushUnique(reasons, 'framework role match')
  } else if (frameworkRoleMatchesPrompt(taskContract.prompt, view.framework_role)) {
    score += 1.5
    pushUnique(reasons, 'framework role match')
  }

  if (view.exact_anchor_match) {
    score += 2.5
    pushUnique(reasons, 'exact anchor match')
  }
  if (view.direct_symbol_match) {
    score += 2
    pushUnique(reasons, 'direct symbol match')
  }
  if (view.source_path_match) {
    score += 1.5
    pushUnique(reasons, 'source path match')
  }

  // Reward explicitly tagged non-production domains once they survive the
  // penalty gate above so score/reasons reflect why pushUnique records that
  // this candidate matched a permitted test/benchmark/config-style source.
  if (view.source_domain !== 'production' && view.source_domain !== 'unknown') {
    score += 0.25
    pushUnique(reasons, `${view.source_domain} domain`)
  }

  if (looksLikeBarrelFile(view.source_file) && !view.exact_anchor_match && !view.source_path_match) {
    score -= 2.5
    pushUnique(penalties, 'barrel export penalty')
  }

  if (looksGenerated(view.source_file, view.label, view.snippet)) {
    score -= 3
    pushUnique(penalties, 'generated file penalty')
  }

  if (looksArtifact(view.source_file)) {
    score -= 4
    pushUnique(penalties, 'build artifact penalty')
  }

  if (looksScriptMigration(view.source_file, view.label) && !promptAllowsScriptMigration(taskContract.prompt)) {
    score -= 3
    pushUnique(penalties, 'script/migration penalty')
  }

  if (looksTypeOnly(view) && !taskContract.semantic_required.includes('contracts') && !taskContract.semantic_optional.includes('contracts')) {
    score -= 1.5
    pushUnique(penalties, 'type-only penalty')
  }

  const duplicateCount = duplicateCounts.get(duplicatePenaltyKey(candidate, view)) ?? 0
  if (duplicateCount > 1) {
    score -= Math.min(1.5, (duplicateCount - 1) * 0.5)
    pushUnique(penalties, 'duplicate candidate penalty')
  }

  if (typeof view.graph_degree === 'number' && view.graph_degree >= 12 && !view.exact_anchor_match) {
    score -= 1.25
    pushUnique(penalties, 'hub node penalty')
  }

  const domainPenalty = sourceDomainPenalty(view, taskContract)
  if (domainPenalty > 0) {
    score -= domainPenalty
    pushUnique(penalties, `${view.source_domain.replace('_', ' ')} penalty`)
  }

  if (exactCodeRequested(taskContract) && (!view.source_file || typeof view.snippet !== 'string' || view.snippet.length === 0)) {
    score -= 1
    pushUnique(penalties, 'missing snippet penalty')
  }

  const normalized = Number(Math.max(0.05, score).toFixed(3))
  return {
    score: normalized,
    reasons,
    penalties,
  }
}

function buildValuePerTokenCandidates<TNode extends ContextPackNode>(
  taskContract: ContextPackTaskContract,
  candidates: readonly ContextPackNodeCandidate<TNode>[],
): RankedValueCandidate<TNode>[] {
  const duplicateCounts = new Map<string, number>()
  const views = new Map<ContextPackNodeCandidate<TNode>, CandidateScoringView>()
  for (const candidate of candidates) {
    const view = scoringViewForCandidate(candidate)
    views.set(candidate, view)
    const key = duplicatePenaltyKey(candidate, view)
    duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1)
  }

  return candidates.map((candidate) => {
    const tokenCost = candidate.estimate_tokens()
    const { score, reasons, penalties } = computeContextCandidateValue(candidate, taskContract, duplicateCounts)
    return {
      id: selectionCandidateId(candidate),
      candidate,
      score,
      token_cost: tokenCost,
      density: tokenCost === 0 ? Number.POSITIVE_INFINITY : score / tokenCost,
      reasons,
      penalties,
    }
  })
}

function rankingEntryForValueCandidate<TNode extends ContextPackNode>(
  candidate: RankedValueCandidate<TNode>,
  included: boolean,
): ContextPackSelectionRankingEntry {
  return {
    id: candidate.id,
    label: candidate.candidate.label,
    evidence_class: candidate.candidate.evidence_class,
    score: candidate.score,
    token_cost: candidate.token_cost,
    density: candidate.density,
    included,
    reasons: [...candidate.reasons],
    penalties: [...candidate.penalties],
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

function tokenCountForRenderedNodes(nodes: readonly Pick<ContextPackNode, 'label' | 'source_file' | 'line_number' | 'snippet'>[]): number {
  return nodes.reduce(
    (total, node) => total + estimateContextPackEntryTokens(node.label, node.source_file, node.line_number, node.snippet),
    0,
  )
}

function resolutionForTaskBudget(
  taskContract: ContextPackTaskContract,
  nodes: readonly ContextPackNode[],
): 'summary' | 'signature' | 'sketch' {
  const budgetPerNode = taskContract.budget / Math.max(1, nodes.length)
  if (budgetPerNode < 18) {
    return 'summary'
  }
  if (budgetPerNode < 28) {
    return 'signature'
  }
  return 'sketch'
}

function canPreserveExplainDetail(
  taskContract: ContextPackTaskContract,
  nodes: readonly ContextPackNode[],
): boolean {
  return taskContract.task_kind === 'explain'
    && resolutionForTaskBudget(taskContract, nodes) === 'sketch'
}

export function renderCompiledContextPackNodes<
  TNode extends ContextPackNode = ContextPackNode,
  TRelationship extends ContextPackRelationship = ContextPackRelationship,
>(
  taskContract: ContextPackTaskContract,
  nodes: readonly TNode[],
  relationships: readonly TRelationship[],
): {
  nodes: TNode[]
  token_count: number
} {
  if (nodes.length === 0) {
    return {
      nodes: [],
      token_count: 0,
    }
  }

  const renderedNodes = nodes.some((node) => typeof node.representation_type === 'string')
    ? [...nodes]
    : applyContextPackResolution(nodes, {
        resolution: resolutionForTaskBudget(taskContract, nodes),
        relationships,
        task_kind: taskContract.task_kind,
      }).nodes.map((node, index) => {
        const originalNode = nodes[index]!
        const originalCost = estimateContextPackEntryTokens(
          originalNode.label,
          originalNode.source_file,
          originalNode.line_number,
          originalNode.snippet ?? null,
        )
        const renderedCost = estimateContextPackEntryTokens(
          node.label,
          node.source_file,
          node.line_number,
          node.snippet ?? null,
        )
        const hasOriginalSnippet = typeof originalNode.snippet === 'string'
          && originalNode.snippet.length > 0
        if (canPreserveExplainDetail(taskContract, nodes) && hasOriginalSnippet) {
          return {
            ...node,
            representation_type: 'detail',
            representation_reason: 'explain detail preserved',
            snippet: originalNode.snippet,
          } as TNode
        }

        return renderedCost <= originalCost ? node : originalNode
      }) as TNode[]

  return {
    nodes: renderedNodes,
    token_count: tokenCountForRenderedNodes(renderedNodes),
  }
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
  // CodeRabbit fix: track placed candidate objects directly. Earlier
  // version derived omittedNodes from materialized label:source_file:line
  // triples, which can mis-attribute when build_entry fills in missing
  // source metadata or when two distinct candidates share the same triple.
  const placedCandidates = new Set<ContextPackNodeCandidate<TNode>>()
  let tokenCount = 0
  let breakIndex = orderedNodes.length
  let selectionDiagnostics: ContextPackSelectionDiagnostics | undefined

  const placeCandidate = (candidate: ContextPackNodeCandidate<TNode>, candidateTokens: number): void => {
    placedCandidates.add(candidate)
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

  if (input.selection_strategy === 'value-per-token') {
    // v0.20 #131 — density-greedy selection.
    //
    // 1. Place required-evidence-class candidates greedily (must-include).
    //    These can't be dropped via density even if they're expensive, so
    //    the budget for the remainder is what's left after their cost.
    // 2. The remainder pool (optional candidates) goes through
    //    selectByValuePerToken with the residual budget. Density
    //    (score / token_cost) drives which optional nodes survive.
    const requiredClasses = new Set(input.task_contract.required_evidence)
    const requiredCandidates: ContextPackNodeCandidate<TNode>[] = []
    const optionalCandidates: ContextPackNodeCandidate<TNode>[] = []
    let requiredOverflow = false
    for (const candidate of orderedNodes) {
      if (requiredClasses.has(candidate.evidence_class)) {
        requiredCandidates.push(candidate)
      } else {
        optionalCandidates.push(candidate)
      }
    }
    // CodeRabbit fix: skip individual oversize required candidates with
    // `continue` instead of `break`, so one fat required entry doesn't
    // kill subsequent smaller required ones. The break-on-first-overflow
    // mirrored the evidence-order loop but is wrong here — required
    // candidates each have an independent must-include semantic.
    for (const candidate of requiredCandidates) {
      const candidateTokens = candidate.estimate_tokens()
      if (tokenCount + candidateTokens > input.task_contract.budget && selectedNodes.length > 0) {
        requiredOverflow = true
        continue
      }
      placeCandidate(candidate, candidateTokens)
    }
    const remainingBudget = Math.max(0, input.task_contract.budget - tokenCount)
    const rankedOptionalCandidates = buildValuePerTokenCandidates(input.task_contract, optionalCandidates)
    const valueCandidates: Array<ValuePerTokenCandidate<ContextPackNodeCandidate<TNode>>> = rankedOptionalCandidates.map((candidate) => ({
      id: candidate.id,
      payload: candidate.candidate,
      score: candidate.score,
      token_cost: candidate.token_cost,
    }))
    const valueResult = selectByValuePerToken(valueCandidates, { budget: remainingBudget })
    for (const sel of valueResult.selected) {
      placeCandidate(sel.payload, sel.token_cost)
    }
    const includedOptionalIds = new Set(valueResult.selected.map((candidate) => candidate.id))
    const requiredRanking = buildValuePerTokenCandidates(input.task_contract, requiredCandidates)
      .map((candidate) => rankingEntryForValueCandidate(candidate, placedCandidates.has(candidate.candidate)))
    const optionalRanking = rankedOptionalCandidates
      .map((candidate) => ({
        candidate,
        included: includedOptionalIds.has(candidate.id),
      }))
      .sort((left, right) => {
        if (left.candidate.density !== right.candidate.density) {
          return right.candidate.density - left.candidate.density
        }
        if (left.candidate.score !== right.candidate.score) {
          return right.candidate.score - left.candidate.score
        }
        if (left.candidate.token_cost !== right.candidate.token_cost) {
          return left.candidate.token_cost - right.candidate.token_cost
        }
        return left.candidate.id.localeCompare(right.candidate.id)
      })
      .map(({ candidate, included }) => rankingEntryForValueCandidate(candidate, included))
    selectionDiagnostics = {
      selection_strategy: 'value-per-token',
      budget: input.task_contract.budget,
      used_tokens: tokenCount,
      required_overflow: requiredOverflow,
      ranking: [...requiredRanking, ...optionalRanking],
    }
    void breakIndex
  } else {
    for (const [index, candidate] of orderedNodes.entries()) {
      const candidateTokens = candidate.estimate_tokens()
      if (tokenCount + candidateTokens > input.task_contract.budget && selectedNodes.length > 0) {
        breakIndex = index
        break
      }
      placeCandidate(candidate, candidateTokens)
    }
  }

  // omittedNodes is what we couldn't fit. For evidence-order it's the
  // tail after the break; for value-per-token it's the set difference
  // between orderedNodes and what placeCandidate accepted (CodeRabbit
  // fix: use the candidate-identity Set instead of materialized triples).
  const omittedNodes = input.selection_strategy === 'value-per-token'
    ? orderedNodes.filter((c) => !placedCandidates.has(c))
    : orderedNodes.slice(breakIndex)
  const relationships = filterRelationships(input.relationships ?? [], selectedNodes)
  const renderedNodes = renderCompiledContextPackNodes(input.task_contract, selectedNodes, relationships)
  const includedLabels = new Set(renderedNodes.nodes.map((node) => node.label))

  return {
    task_contract: input.task_contract,
    token_count: renderedNodes.token_count,
    nodes: renderedNodes.nodes,
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
    ...(selectionDiagnostics ? { selection_diagnostics: selectionDiagnostics } : {}),
    ...(input.retrieval_gate ? { retrieval_gate: input.retrieval_gate } : {}),
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
      token_count: compactNodesWithoutSharedFileType.reduce(
        (total, node) => total + estimateContextPackEntryTokens(node.label, node.source_file, node.line_number, node.snippet ?? null),
        0,
      ),
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

export function generateAnswerReadyFromExecutionSlice(
  executionSlice: ContextPackExecutionSlice | undefined,
  taskKind: ContextPackTaskKind,
): ContextPackExplainAnswerReadySummary | undefined {
  const partialExplainBarrier = executionSlice?.status === 'partial' && executionSlice.confidence === 'medium'

  if (
    taskKind !== 'explain'
    || !executionSlice
    || (executionSlice.confidence !== 'high' && !partialExplainBarrier)
  ) {
    return undefined
  }

  // Generate answer_outline from primary_path steps or all steps, preferring primary_path if it has content
  const primaryPathSteps = executionSlice.primary_path?.steps
  const pathSteps = (primaryPathSteps && primaryPathSteps.length > 0) ? primaryPathSteps : executionSlice.steps
  const answer_outline = pathSteps.map((step) => `${step.label} (${step.source_file}:${step.line_number})`).slice(0, 10)

  // Generate must_cite from primary path steps, prioritizing first and last
  const must_cite = []
  if (pathSteps.length > 0) {
    const first = pathSteps[0]
    if (first) {
      must_cite.push({
        source_file: first.source_file,
        line_number: first.line_number,
        label: first.label,
      })
    }
    if (pathSteps.length > 1) {
      const last = pathSteps[pathSteps.length - 1]
      if (last && first && (last.source_file !== first.source_file || last.line_number !== first.line_number)) {
        must_cite.push({
          source_file: last.source_file,
          line_number: last.line_number,
          label: last.label,
        })
      }
    }
  }

  const missingPhases = executionSlice.phase_coverage?.missing ?? []
  const stop_condition = partialExplainBarrier
    ? (
        missingPhases.length > 0
          ? `answer from observed steps only; if the full flow is requested, answer: not enough evidence; missing ${missingPhases.join(', ')}; do not raw-search unless missing_context is non-empty`
          : 'answer from observed steps only; if the full flow is requested, answer: not enough evidence; do not raw-search unless missing_context is non-empty'
      )
    : 'answer now; do not raw-search unless missing_context is non-empty'
  const allowed_followups = [
    ...(partialExplainBarrier && missingPhases.length > 0
      ? [`Use at most one focused follow-up to surface missing phases: ${missingPhases.join(', ')}`]
      : []),
    ...(executionSlice.confidence_reasons
      ? [`Review confidence reasons: ${executionSlice.confidence_reasons.join(', ')}`]
      : []),
  ]

  return {
    answer_outline: answer_outline.length > 0 ? answer_outline : ['Flow execution traced'],
    must_cite,
    stop_condition,
    allowed_followups,
  }
}
