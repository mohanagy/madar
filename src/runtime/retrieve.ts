import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { decode as decodeTokens, encode as encodeTokens } from 'gpt-tokenizer/encoding/cl100k_base'

import type {
  ContextPackExecutionPhase,
  ContextPackExecutionSlice,
  ContextPackExecutionSliceBoundary,
  ContextPackExecutionSliceBranch,
  ContextPackExecutionSliceOmittedBranch,
  ContextPackExecutionSliceStep,
  ContextPackRuntimeGenerationAnswerContract,
  CompiledContextPack,
  ContextPackClaim,
  ContextPackCoverage,
  ContextPackEvidenceClass,
  ContextPackExpandableLineRange,
  ContextPackExpandableRef,
  ContextPackNode,
  ContextRepresentationType,
  ContextPackRetrievalStrategy,
  ContextPackSelectionDiagnostics,
  ContextPackSliceMetadata,
  ContextPackTaskContract,
  ContextPackTaskKind,
} from '../contracts/context-pack.js'
import type { ContextPackRetrievalPlanDetail, RetrievalQualitySnapshot } from '../contracts/retrieval-plan.js'
import type { ContextPackRecoveryPlan } from '../contracts/context-recovery.js'
import type { TaskIntentKind } from '../contracts/task-intent.js'
import { KnowledgeGraph } from '../contracts/graph.js'
import { reportSkippedPipelineStage } from '../core/pipeline/stage.js'
import { godNodes, workspaceBridges } from '../pipeline/analyze.js'
import { type Communities } from '../pipeline/cluster.js'
import { buildCommunityLabels } from '../pipeline/community-naming.js'
import { lineNumberFromSourceLocation, lineRangeFromSourceLocation } from '../shared/source-location.js'
import {
  classifySourceDomain,
  isPollutedSourcePath,
  type SourceDomain,
} from '../shared/source-discovery.js'
import { relativizeSourceFile } from '../shared/source-path.js'
import {
  classifyTaskContract,
  compactContextPack,
  compileContextPack,
  estimateContextPackEntryTokens,
  renderCompiledContextPackNodes,
  type ContextPackNodeCandidate,
} from './context-pack.js'
import type { RetrievalGateDecision, RetrievalLevel } from '../contracts/retrieval-gate.js'
import { classifyRetrievalLevel } from './retrieval-gate.js'
import { requireDirectedGraph } from './direction.js'
import {
  expansionPolicyForLevel,
  predecessorAllowedForPolicy,
  relationAllowedForPolicy,
  relationIsPrimaryForPolicy,
} from './retrieve/expansion.js'
import { sliceCandidatesForRetrieve } from './retrieve/slicing.js'
import {
  finalizeConceptualFallbackPlan,
  planConceptualFallback,
} from './retrieve/conceptual-fallback.js'
import { recoverContextPackResult } from './context-pack-recovery.js'
import {
  interpretRetrievalQuery,
  runRetrievalCandidateStage,
  runRetrievalEvidencePlanningStage,
  runRetrievalPackingStage,
  runRetrievalQueryStage,
  startRetrievalRecoveryStage,
  tokenMatchCount,
  tokenizeLabel,
  tokenizeQuestion,
  type RetrievalPipelineStage,
  type RetrievalStageObserver,
} from './retrieve/pipeline.js'
import { communitiesFromGraph, estimateQueryTokens } from './serve.js'

export { tokenizeLabel, tokenizeQuestion } from './retrieve/pipeline.js'

const SNIPPET_HALF_WINDOW = 7
const DERIVED_SNIPPET_HALF_WINDOW = 1
const MAX_SNIPPET_LINE_LENGTH = 200
export const DEFAULT_RETRIEVE_SNIPPET_BUDGET = 3000
export const DEFAULT_RETRIEVE_TOP_N_WITH_SNIPPET = 8
export const DEFAULT_RETRIEVE_STDIO_OUTPUT_TOKENS = 4000
const BM25_K1 = 1.2
const BM25_B = 0.6
const SEED_FUSION_SCORE_SCALE = 10
const STDIO_RETRIEVE_MATCHED_NODE_CAP = 12
const STDIO_RETRIEVE_RELATIONSHIP_CAP = 12
const STDIO_RETRIEVE_COMMUNITY_CAP = 6
const STDIO_RETRIEVE_CLAIM_CAP = 4
const STDIO_RETRIEVE_EXPANDABLE_CAP = 3
const STDIO_RETRIEVE_EXPANDABLE_PREVIEW_CAP = 3
const STDIO_RETRIEVE_EXPANDABLE_FOCUS_FILE_CAP = 12
const STDIO_RETRIEVE_EXPANDABLE_FOCUS_RANGE_CAP = 12
const STDIO_RETRIEVE_SLICE_PATH_CAP = 12
const CONCEPTUAL_FALLBACK_SEED_LIMIT = 12
const CONCEPTUAL_FALLBACK_SEED_MIN_BOOST = 0.75

const tokenWeightCache = new WeakMap<KnowledgeGraph, Map<string, Map<string, number>>>()
const graphSignalCache = new WeakMap<KnowledgeGraph, RetrieveGraphSignals>()
const averageLabelLengthCache = new WeakMap<KnowledgeGraph, number>()

export interface RetrieveOptions {
  question: string
  budget: number
  taskKind?: ContextPackTaskKind
  taskIntent?: TaskIntentKind
  community?: number
  fileType?: string
  semantic?: boolean
  semanticModel?: string
  rerank?: boolean
  rerankerModel?: string
  /** Project root used to resolve the optional transformers package when the
   *  server itself runs from elsewhere (npx cache, global install). */
  projectRoot?: string
  /** #75 manual override for the retrieval gate. When set (0-5), the gate
   *  bypasses heuristic classification and emits a decision with reason
   *  'manual override' at the supplied level. Caller-side surface for the
   *  acceptance criterion that the gate be overridable via CLI/MCP. */
  retrievalLevel?: RetrievalLevel
  retrievalStrategy?: ContextPackRetrievalStrategy
  snippetBudget?: number
  topNWithSnippet?: number
  /** Source-safe stage timing/count observer; never receives prompts, paths, labels, or snippets. */
  onStageDiagnostic?: RetrievalStageObserver
}

export interface RetrieveSnippetOptions {
  snippetBudget?: number
  topNWithSnippet?: number
}

export interface RetrieveStdioOptions extends RetrieveSnippetOptions {
  maxOutputTokens?: number
}

function classifyRetrieveTaskContract(options: RetrieveOptions): ContextPackTaskContract {
  return interpretRetrievalQuery({
    question: options.question,
    budget: options.budget,
    ...(options.taskKind ? { taskKind: options.taskKind } : {}),
    ...(options.taskIntent ? { taskIntent: options.taskIntent } : {}),
    ...(options.retrievalLevel !== undefined ? { retrievalLevel: options.retrievalLevel } : {}),
  }).task_contract
}

export interface RetrieveMatchedNode {
  node_id?: string
  label: string
  source_file: string
  line_number: number
  node_kind?: string
  framework?: string | undefined
  framework_role?: string | undefined
  framework_boost?: number
  source_domain?: SourceDomain
  file_type: string
  snippet: string | null
  snippet_truncated?: boolean
  match_score: number
  relevance_band: 'direct' | 'related' | 'peripheral'
  community: number | null
  community_label: string | null
  evidence_class?: ContextPackEvidenceClass
  representation_type?: ContextRepresentationType
  representation_reason?: string
}

export interface RetrieveRelationship {
  from_id?: string
  from: string
  to_id?: string
  to: string
  relation: string
}

export interface RetrieveCommunityContext {
  id: number
  label: string
  node_count: number
}

export interface RetrieveResult {
  question: string
  token_count: number
  matched_nodes: RetrieveMatchedNode[]
  relationships: RetrieveRelationship[]
  community_context: RetrieveCommunityContext[]
  graph_signals: {
    god_nodes: string[]
    bridge_nodes: string[]
  }
  task_contract?: ContextPackTaskContract
  claims?: ContextPackClaim[]
  expandable?: ContextPackExpandableRef[]
  coverage?: ContextPackCoverage
  selection_diagnostics?: ContextPackSelectionDiagnostics
  retrieval_gate?: RetrievalGateDecision
  retrieval_strategy?: ContextPackRetrievalStrategy
  retrieval_plan?: ContextPackRetrievalPlanDetail
  recovery?: ContextPackRecoveryPlan
  snippet_budget_tokens_used?: number
  snippet_budget_tokens_remaining?: number
  slice?: ContextPackSliceMetadata
  execution_slice?: ContextPackExecutionSlice
  answer_contract?: ContextPackRuntimeGenerationAnswerContract
}

export interface CompactRetrieveMatchedNode extends Omit<RetrieveMatchedNode, 'community_label' | 'file_type' | 'framework_boost' | 'snippet_truncated'> {
  file_type?: string
  snippet_truncated: boolean
}

export interface CompactRetrieveResult extends Omit<RetrieveResult, 'matched_nodes' | 'snippet_budget_tokens_used' | 'snippet_budget_tokens_remaining'> {
  matched_nodes: CompactRetrieveMatchedNode[]
  shared_file_type?: string
  snippet_budget_tokens_used: number
  snippet_budget_tokens_remaining: number
}

export interface StdioRetrieveResult extends CompactRetrieveResult {
  claims?: ContextPackClaim[]
  expandable?: ContextPackExpandableRef[]
  coverage?: ContextPackCoverage
}

interface RetrieveGraphSignals {
  godNodeIds: ReadonlySet<string>
  godNodeLabels: ReadonlySet<string>
  bridgeNodeIds: ReadonlySet<string>
  bridgeNodeLabels: ReadonlySet<string>
}

function matchedNodeId(node: Pick<RetrieveMatchedNode, 'node_id'>): string | null {
  return typeof node.node_id === 'string' && node.node_id.length > 0 ? node.node_id : null
}

function stripRetrieveMatchedNodeIdentity<T extends RetrieveMatchedNode | CompactRetrieveMatchedNode>(node: T): Omit<T, 'node_id' | 'evidence_class'> {
  const { node_id: _nodeId, evidence_class: _evidenceClass, ...rest } = node
  return rest
}

function stripRetrieveRelationshipIdentity<T extends RetrieveRelationship>(relationship: T): Omit<T, 'from_id' | 'to_id'> {
  const { from_id: _fromId, to_id: _toId, ...rest } = relationship
  return rest
}

export function scoreNode(
  questionTokens: readonly string[],
  labelTokens: readonly string[],
  tokenWeights?: ReadonlyMap<string, number>,
  averageFieldLength: number = Math.max(labelTokens.length, 1),
): number {
  if (labelTokens.length === 0) {
    return 0
  }

  let score = 0
  const fieldLength = Math.max(labelTokens.length, 1)
  const normalizedAverageLength = averageFieldLength > 0 ? averageFieldLength : fieldLength
  for (const qt of questionTokens) {
    const weight = tokenWeights?.get(qt) ?? 1
    const termFrequency = tokenMatchCount(qt, labelTokens)
    if (termFrequency === 0) {
      continue
    }

    const denominator = termFrequency + BM25_K1 * (1 - BM25_B + BM25_B * (fieldLength / normalizedAverageLength))
    score += weight * ((termFrequency * (BM25_K1 + 1)) / denominator)
  }
  return score
}

function averageLabelLengthForGraph(graph: KnowledgeGraph): number {
  const cached = averageLabelLengthCache.get(graph)
  if (cached !== undefined) {
    return cached
  }

  const labels = graph.nodeEntries().map(([, attributes]) => tokenizeLabel(String(attributes.label ?? '')).length).filter((length) => length > 0)
  const averageLength = labels.length > 0 ? labels.reduce((total, length) => total + length, 0) / labels.length : 1
  averageLabelLengthCache.set(graph, averageLength)
  return averageLength
}

function normalizeAbsoluteGraphPath(sourceFile: string): string | undefined {
  const normalized = sourceFile.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    return normalized
  }
  return undefined
}

function inferredGraphRoot(graph: KnowledgeGraph): string | undefined {
  if (typeof graph.graph.root_path === 'string' && graph.graph.root_path.length > 0) {
    return graph.graph.root_path
  }

  const absoluteSourceDirs = graph
    .nodeEntries()
    .map(([, attributes]) => normalizeAbsoluteGraphPath(String(attributes.source_file ?? '')))
    .filter((sourceFile): sourceFile is string => sourceFile !== undefined)
    .map((sourceFile) => {
      const lastSlash = sourceFile.lastIndexOf('/')
      return lastSlash > 0 ? sourceFile.slice(0, lastSlash) : '/'
    })

  const first = absoluteSourceDirs[0]
  if (!first) {
    return undefined
  }

  const segments = first.split('/')
  let sharedLength = segments.length
  for (const dir of absoluteSourceDirs.slice(1)) {
    const parts = dir.split('/')
    let matchLength = 0
    while (matchLength < sharedLength && matchLength < parts.length && segments[matchLength] === parts[matchLength]) {
      matchLength += 1
    }
    sharedLength = matchLength
    if (sharedLength === 0) {
      break
    }
  }

  const shared = segments.slice(0, sharedLength).join('/')
  if (/^[A-Za-z]:$/.test(shared)) {
    return `${shared}/`
  }
  return shared.length > 0 ? shared : '/'
}

function buildTokenWeights(graph: KnowledgeGraph, questionTokens: readonly string[]): Map<string, number> {
  const totalNodes = graph.numberOfNodes()
  if (totalNodes === 0) return new Map()

  const matchCounts = new Map<string, number>()
  for (const qt of questionTokens) {
    matchCounts.set(qt, 0)
  }

  for (const [, attributes] of graph.nodeEntries()) {
    const labelTokens = tokenizeLabel(String(attributes.label ?? ''))
    for (const qt of questionTokens) {
      if (tokenMatchCount(qt, labelTokens) > 0) {
        matchCounts.set(qt, (matchCounts.get(qt) ?? 0) + 1)
      }
    }
  }

  const weights = new Map<string, number>()
  for (const [token, count] of matchCounts) {
    weights.set(token, count > 0 ? Math.max(0.1, Math.log(1 + ((totalNodes - count + 0.5) / (count + 0.5)))) : 1)
  }
  return weights
}

export function tokenWeightsForQuestion(graph: KnowledgeGraph, questionTokens: readonly string[]): Map<string, number> {
  const cacheKey = questionTokens.join('\u0000')
  let graphCache = tokenWeightCache.get(graph)
  if (!graphCache) {
    graphCache = new Map()
    tokenWeightCache.set(graph, graphCache)
  }

  const cached = graphCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const weights = buildTokenWeights(graph, questionTokens)
  graphCache.set(cacheKey, weights)
  return weights
}

function estimateTokens(text: string): number {
  return estimateQueryTokens(text)
}

function snippetTokenCount(snippet: string | null | undefined): number {
  return typeof snippet === 'string' && snippet.trim().length > 0
    ? estimateTokens(snippet)
    : 0
}

export function estimateRetrieveEntryTokens(label: string, sourceFile: string, lineNumber: number, snippet: string | null): number {
  return estimateContextPackEntryTokens(label, sourceFile, lineNumber, snippet)
}

function tokenCountForMatchedNodes(
  matchedNodes: readonly Pick<RetrieveMatchedNode, 'label' | 'source_file' | 'line_number' | 'snippet'>[],
): number {
  return matchedNodes.reduce(
    (total, node) => total + estimateRetrieveEntryTokens(node.label, node.source_file, node.line_number, node.snippet),
    0,
  )
}

function normalizedRetrieveSnippetOptions(options: RetrieveSnippetOptions = {}): { snippetBudget: number; topNWithSnippet: number } {
  const resolvedSnippetBudget =
    typeof options.snippetBudget === 'number' && Number.isFinite(options.snippetBudget)
      ? Math.max(0, Math.floor(options.snippetBudget))
      : DEFAULT_RETRIEVE_SNIPPET_BUDGET
  const resolvedTopNWithSnippet =
    typeof options.topNWithSnippet === 'number' && Number.isFinite(options.topNWithSnippet)
      ? Math.max(0, Math.floor(options.topNWithSnippet))
      : DEFAULT_RETRIEVE_TOP_N_WITH_SNIPPET
  return {
    snippetBudget: resolvedSnippetBudget,
    topNWithSnippet: resolvedTopNWithSnippet,
  }
}

function truncateTextToTokenBudget(text: string, remainingTokens: number): string | null {
  const trimmedText = text.trim()
  if (trimmedText.length === 0 || remainingTokens <= 0) {
    return null
  }

  const tokens = encodeTokens(trimmedText)
  if (tokens.length <= remainingTokens) {
    return trimmedText
  }

  for (let tokenLimit = Math.min(remainingTokens, tokens.length); tokenLimit > 0; tokenLimit -= 1) {
    const decoded = decodeTokens(tokens.slice(0, tokenLimit)).trim()
    if (decoded.length === 0) {
      continue
    }
    if (estimateTokens(decoded) <= remainingTokens) {
      return decoded
    }
  }

  return null
}

function truncateSnippetToTokenBudget(
  snippet: string,
  remainingTokens: number,
): { snippet: string | null; tokensUsed: number; truncated: boolean } {
  const trimmedSnippet = snippet.trim()
  if (trimmedSnippet.length === 0) {
    return { snippet: null, tokensUsed: 0, truncated: false }
  }
  if (remainingTokens <= 0) {
    return { snippet: null, tokensUsed: 0, truncated: true }
  }

  const fullTokens = estimateTokens(trimmedSnippet)
  if (fullTokens <= remainingTokens) {
    return { snippet: trimmedSnippet, tokensUsed: fullTokens, truncated: false }
  }

  const lines = trimmedSnippet.split('\n')
  const nonEmptyLineIndexes = lines
    .map((line, index) => (line.trim().length > 0 ? index : -1))
    .filter((index) => index >= 0)
  const focusIndex = nonEmptyLineIndexes.length > 0
    ? nonEmptyLineIndexes[Math.floor(nonEmptyLineIndexes.length / 2)]!
    : 0
  const focusLine = lines[focusIndex]?.trim() ?? ''

  if (focusLine.length > 0 && estimateTokens(focusLine) <= remainingTokens) {
    let start = focusIndex
    let end = focusIndex
    let bestSnippet = focusLine

    while (true) {
      let expanded = false

      if (start > 0) {
        const candidate = lines.slice(start - 1, end + 1).join('\n').trim()
        if (candidate.length > 0 && estimateTokens(candidate) <= remainingTokens) {
          start -= 1
          bestSnippet = candidate
          expanded = true
        }
      }

      if (end < lines.length - 1) {
        const candidate = lines.slice(start, end + 2).join('\n').trim()
        if (candidate.length > 0 && estimateTokens(candidate) <= remainingTokens) {
          end += 1
          bestSnippet = candidate
          expanded = true
        }
      }

      if (!expanded) {
        break
      }
    }

    return {
      snippet: bestSnippet,
      tokensUsed: estimateTokens(bestSnippet),
      truncated: true,
    }
  }

  const tokenBoundSnippet = truncateTextToTokenBudget(focusLine.length > 0 ? focusLine : trimmedSnippet, remainingTokens)
  if (tokenBoundSnippet === null) {
    return { snippet: null, tokensUsed: 0, truncated: true }
  }

  return {
    snippet: tokenBoundSnippet,
    tokensUsed: estimateTokens(tokenBoundSnippet),
    truncated: true,
  }
}

function applyRetrieveSnippetBudgetToNodes<TNode extends { snippet?: string | null }>(
  nodes: readonly TNode[],
  options: RetrieveSnippetOptions = {},
): {
  nodes: Array<TNode & { snippet: string | null; snippet_truncated: boolean }>
  usedTokens: number
  remainingTokens: number
} {
  const { snippetBudget, topNWithSnippet } = normalizedRetrieveSnippetOptions(options)
  let usedTokens = 0

  const shapedNodes = nodes.map((node, index) => {
    const originalSnippet = typeof node.snippet === 'string' && node.snippet.trim().length > 0
      ? node.snippet
      : null

    if (originalSnippet === null) {
      return {
        ...node,
        snippet: null,
        snippet_truncated: false,
      }
    }

    if (index >= topNWithSnippet) {
      return {
        ...node,
        snippet: null,
        snippet_truncated: false,
      }
    }

    const remainingSnippetBudget = Math.max(0, snippetBudget - usedTokens)
    const shapedSnippet = truncateSnippetToTokenBudget(originalSnippet, remainingSnippetBudget)
    const serializedSnippetTokens = snippetTokenCount(shapedSnippet.snippet)
    const boundedSnippet = serializedSnippetTokens <= remainingSnippetBudget
      ? shapedSnippet
      : truncateSnippetToTokenBudget(shapedSnippet.snippet ?? '', remainingSnippetBudget)
    usedTokens += snippetTokenCount(boundedSnippet.snippet)
    return {
      ...node,
      snippet: boundedSnippet.snippet,
      snippet_truncated: shapedSnippet.truncated || boundedSnippet.truncated,
    }
  })

  const serializedSnippetTokensUsed = shapedNodes.reduce(
    (total, node) => total + snippetTokenCount(node.snippet),
    0,
  )

  return {
    nodes: shapedNodes,
    usedTokens: serializedSnippetTokensUsed,
    remainingTokens: Math.max(0, snippetBudget - serializedSnippetTokensUsed),
  }
}

export function withRetrieveSnippetBudget(
  result: RetrieveResult,
  options: RetrieveSnippetOptions = {},
): RetrieveResult {
  const shapedNodes = applyRetrieveSnippetBudgetToNodes(result.matched_nodes, options)
  const baseNodeTokenCount = tokenCountForMatchedNodes(result.matched_nodes)
  const shapedNodeTokenCount = tokenCountForMatchedNodes(shapedNodes.nodes)
  return {
    ...result,
    token_count: Math.max(0, result.token_count - baseNodeTokenCount + shapedNodeTokenCount),
    matched_nodes: shapedNodes.nodes as RetrieveMatchedNode[],
    snippet_budget_tokens_used: shapedNodes.usedTokens,
    snippet_budget_tokens_remaining: shapedNodes.remainingTokens,
  }
}

function fileLinesForSnippet(sourceFile: string, fileCache?: Map<string, string[] | null>): string[] | null {
  const cached = fileCache?.get(sourceFile)
  if (cached !== undefined) {
    return cached
  }

  if (!existsSync(sourceFile)) {
    fileCache?.set(sourceFile, null)
    return null
  }

  const lines = readFileSync(sourceFile, 'utf8').split(/\r?\n/)
  fileCache?.set(sourceFile, lines)
  return lines
}

export function readSnippet(
  sourceFile: string,
  lineNumber: number,
  options: { derived?: boolean; fileCache?: Map<string, string[] | null> } = {},
): string | null {
  if (!sourceFile || lineNumber <= 0) {
    return null
  }

  try {
    const lines = fileLinesForSnippet(sourceFile, options.fileCache)
    if (!lines) {
      return null
    }

    const zeroIndex = lineNumber - 1
    const halfWindow = options.derived ? DERIVED_SNIPPET_HALF_WINDOW : SNIPPET_HALF_WINDOW
    const start = Math.max(0, zeroIndex - halfWindow)
    const end = Math.min(lines.length, zeroIndex + halfWindow + 1)

    return lines
      .slice(start, end)
      .map((line) => (line.length > MAX_SNIPPET_LINE_LENGTH ? `${line.slice(0, MAX_SNIPPET_LINE_LENGTH)}...` : line))
      .join('\n')
  } catch {
    return null
  }
}

function graphSignalsForRetrieve(
  graph: KnowledgeGraph,
  communities: Communities,
  communityLabels: Record<number, string>,
): RetrieveGraphSignals {
  const cached = graphSignalCache.get(graph)
  if (cached) {
    return cached
  }

  const topGodNodes = godNodes(graph, 20)
  const topBridgeNodes = workspaceBridges(graph, communities, communityLabels, 20)
  const signals: RetrieveGraphSignals = {
    godNodeIds: new Set(topGodNodes.map((node) => node.id)),
    godNodeLabels: new Set(topGodNodes.slice(0, 10).map((node) => node.label)),
    bridgeNodeIds: new Set(topBridgeNodes.map((node) => node.id)),
    bridgeNodeLabels: new Set(topBridgeNodes.slice(0, 10).map((node) => node.label)),
  }

  graphSignalCache.set(graph, signals)
  return signals
}

export function collectRelationships(graph: KnowledgeGraph, includedIds: ReadonlySet<string>): RetrieveRelationship[] {
  const relationships: RetrieveRelationship[] = []
  const seen = new Set<string>()

  for (const source of includedIds) {
    for (const target of graph.neighbors(source)) {
      if (!includedIds.has(target)) {
        continue
      }

      const key = graph.isDirected() ? `${source}\u0000${target}` : [source, target].sort().join('\u0000')
      if (seen.has(key)) {
        continue
      }
      seen.add(key)

      const attributes = graph.edgeAttributes(source, target)
      relationships.push({
        from_id: source,
        from: String(graph.nodeAttributes(source).label ?? source),
        to_id: target,
        to: String(graph.nodeAttributes(target).label ?? target),
        relation: String(attributes.relation ?? 'related_to'),
      })
    }
  }

  return relationships
}

function resolvedLineNumber(attributes: Record<string, unknown>): { lineNumber: number; derived: boolean } {
  if (typeof attributes.line_number === 'number' && attributes.line_number > 0) {
    return {
      lineNumber: attributes.line_number,
      derived: false,
    }
  }

  return {
    lineNumber: lineNumberFromSourceLocation(attributes.source_location),
    derived: true,
  }
}

function storedSnippetFromAttributes(attributes: Record<string, unknown>): string | null {
  if (typeof attributes.snippet !== 'string') {
    return null
  }

  const snippet = attributes.snippet.trim()
  return snippet.length > 0 ? snippet : null
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

function eligibleNodeEntries(graph: KnowledgeGraph, options: Pick<RetrieveOptions, 'community' | 'fileType'>): Array<[string, Record<string, unknown>]> {
  return graph.nodeEntries().filter(([, attributes]) => {
    const community = parseCommunityId(attributes.community)
    if (options.community !== undefined && community !== options.community) {
      return false
    }

    const fileType = String(attributes.file_type ?? '').trim().toLowerCase()
    if (options.fileType && fileType !== options.fileType.trim().toLowerCase()) {
      return false
    }

    return true
  })
}

function frameworkMetadataFromAttributes(attributes: Record<string, unknown>): FrameworkNodeMetadata {
  const out: FrameworkNodeMetadata = {}
  const metadataBag = attributes.framework_metadata
  const metadata = metadataBag && typeof metadataBag === 'object' && !Array.isArray(metadataBag)
    ? metadataBag as Record<string, unknown>
    : null

  for (const key of ['route_path', 'http_method', 'mount_path', 'slice_name', 'procedure_name', 'router_name', 'storage_operation', 'runtime_boundary'] as const) {
    const value = attributes[key] ?? metadata?.[key]
    if (typeof value === 'string' && value.length > 0) out[key] = value
  }
  return out
}

function scoredNodeFromGraphEntry(
  id: string,
  attributes: Record<string, unknown>,
  frameworkProfile: FrameworkQuestionProfile,
  questionLower = '',
  rootPath?: string,
): ScoredNode {
  const resolvedLine = resolvedLineNumber(attributes)
  const nodeKind = String(attributes.node_kind ?? '')
  const frameworkRole = String(attributes.framework_role ?? '')
  const sourceLocation = typeof attributes.source_location === 'string' && attributes.source_location.length > 0
    ? attributes.source_location
    : null

  return {
    id,
    label: String(attributes.label ?? ''),
    sourceFile: String(attributes.source_file ?? ''),
    sourceLocation,
    lineNumber: resolvedLine.lineNumber,
    lineNumberDerived: resolvedLine.derived,
    storedSnippet: storedSnippetFromAttributes(attributes),
    nodeKind,
    framework: typeof attributes.framework === 'string' ? attributes.framework : undefined,
    frameworkRole: frameworkRole || undefined,
    sourceDomain: classifySourceDomain(String(attributes.source_file ?? ''), rootPath),
    fileType: String(attributes.file_type ?? '').trim().toLowerCase(),
    fileNodeLike: isFileNodeLike(String(attributes.label ?? ''), String(attributes.source_file ?? '')),
    community: parseCommunityId(attributes.community),
    frameworkBoost: frameworkBoostForNode(frameworkProfile, nodeKind, frameworkRole, frameworkMetadataFromAttributes(attributes), questionLower),
    exactLabelMatch: false,
    literalPathMatch: false,
    sourcePathMatch: false,
    evidenceTier: 0,
    score: 0,
    relevanceBand: 'related',
  }
}

function expandableLineRange(node: Pick<ScoredNode, 'lineNumber' | 'sourceLocation'>): ContextPackExpandableLineRange | undefined {
  const sourceRange = lineRangeFromSourceLocation(node.sourceLocation)
  if (sourceRange) {
    return {
      start_line: sourceRange.start,
      end_line: sourceRange.end,
    }
  }

  if (Number.isFinite(node.lineNumber) && Number.isInteger(node.lineNumber) && node.lineNumber > 0) {
    return {
      start_line: node.lineNumber,
      end_line: node.lineNumber,
    }
  }

  return undefined
}

function semanticTextForNode(node: Pick<ScoredNode, 'label' | 'nodeKind' | 'frameworkRole' | 'sourceFile' | 'storedSnippet'>): string {
  return [
    node.label,
    node.nodeKind,
    node.frameworkRole,
    node.sourceFile,
    node.storedSnippet ?? '',
  ]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
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

interface SeedScoreBreakdown {
  labelExactScore: number
  labelPhraseScore: number
  labelTokenScore: number
  sourcePathScore: number
  promptIdentifierScore: number
  communityScore: number
  conceptualFallbackScore: number
  total: number
}

interface SeedCandidate {
  id: string
  label: string
  sourceFile: string
  sourceLocation: string | null
  lineNumber: number
  lineNumberDerived: boolean
  storedSnippet: string | null
  nodeKind: string
  framework?: string | undefined
  frameworkRole?: string | undefined
  sourceDomain: SourceDomain
  fileType: string
  fileNodeLike: boolean
  community: number | null
  frameworkBoost: number
  seedScore: SeedScoreBreakdown
  exactLabelMatch: boolean
  literalPathMatch: boolean
  sourcePathMatch: boolean
  evidenceTier: 0 | 1 | 2
  relevanceBand: 'direct' | 'related' | 'peripheral'
}

interface ScoredNode {
  id: string
  label: string
  sourceFile: string
  sourceLocation: string | null
  lineNumber: number
  lineNumberDerived: boolean
  storedSnippet: string | null
  nodeKind: string
  framework?: string | undefined
  frameworkRole?: string | undefined
  sourceDomain: SourceDomain
  fileType: string
  fileNodeLike: boolean
  community: number | null
  frameworkBoost: number
  exactLabelMatch: boolean
  literalPathMatch: boolean
  sourcePathMatch: boolean
  evidenceTier: 0 | 1 | 2
  score: number
  relevanceBand: 'direct' | 'related' | 'peripheral'
}

function scoredNodeFromGraph(graph: KnowledgeGraph, nodeId: string, score: number, rootPath?: string): ScoredNode {
  const attributes = graph.nodeAttributes(nodeId)
  const resolvedLine = resolvedLineNumber(attributes)
  return {
    id: nodeId,
    label: String(attributes.label ?? ''),
    sourceFile: String(attributes.source_file ?? ''),
    sourceLocation: typeof attributes.source_location === 'string' && attributes.source_location.length > 0
      ? attributes.source_location
      : null,
    lineNumber: resolvedLine.lineNumber,
    lineNumberDerived: resolvedLine.derived,
    storedSnippet: storedSnippetFromAttributes(attributes),
    nodeKind: String(attributes.node_kind ?? ''),
    framework: typeof attributes.framework === 'string' ? attributes.framework : undefined,
    frameworkRole: typeof attributes.framework_role === 'string' ? attributes.framework_role : undefined,
    sourceDomain: classifySourceDomain(String(attributes.source_file ?? ''), rootPath),
    fileType: String(attributes.file_type ?? '').trim().toLowerCase(),
    fileNodeLike: isFileNodeLike(String(attributes.label ?? ''), String(attributes.source_file ?? '')),
    community: parseCommunityId(attributes.community),
    frameworkBoost: 0,
    exactLabelMatch: false,
    literalPathMatch: false,
    sourcePathMatch: false,
    evidenceTier: 0,
    score,
    relevanceBand: 'related',
  }
}

interface FrameworkQuestionProfile {
  frameworkShaped: boolean
  express: boolean
  routingControllers: boolean
  redux: boolean
  reactRouter: boolean
  nest: boolean
  next: boolean
  repository: boolean
  // v0.19 — v0.17 framework slots added to the boost surface so
  // questions about Hono / Fastify / tRPC / Prisma actually route to
  // the right substrate nodes.
  hono: boolean
  fastify: boolean
  trpc: boolean
  prisma: boolean
  routeIntent: boolean
  middlewareIntent: boolean
  handlerIntent: boolean
  controllerIntent: boolean
  pageIntent: boolean
  layoutIntent: boolean
  clientIntent: boolean
  serverIntent: boolean
  apiIntent: boolean
  selectorIntent: boolean
  sliceIntent: boolean
  storeIntent: boolean
  renderIntent: boolean
  loaderIntent: boolean
  actionIntent: boolean
  moduleIntent: boolean
  providerIntent: boolean
  guardIntent: boolean
  interceptorIntent: boolean
  pipeIntent: boolean
  // v0.19 — new intents for the new substrates.
  pluginIntent: boolean
  procedureIntent: boolean
  queryIntent: boolean
  mutationIntent: boolean
  subscriptionIntent: boolean
  modelIntent: boolean
  persistenceIntent: boolean
  storageEndpointIntent: boolean
  storageReadIntent: boolean
  storageWriteIntent: boolean
}

interface SymbolReference {
  raw: string
  bareName: string
  className?: string
  methodName?: string
}

interface PromptIdentifierSignal {
  normalized: string
  tokenCount: number
}

function activeFrameworksForProfile(profile: FrameworkQuestionProfile): ReadonlySet<string> {
  const frameworks = new Set<string>()
  if (profile.express) frameworks.add('express')
  if (profile.routingControllers) frameworks.add('routing-controllers')
  if (profile.redux) {
    frameworks.add('redux')
    frameworks.add('redux-toolkit')
  }
  if (profile.reactRouter) frameworks.add('react-router')
  if (profile.nest) frameworks.add('nestjs')
  if (profile.next) frameworks.add('nextjs')
  if (profile.repository) frameworks.add('repository')
  if (profile.hono) frameworks.add('hono')
  if (profile.fastify) frameworks.add('fastify')
  if (profile.trpc) frameworks.add('trpc')
  if (profile.prisma) frameworks.add('prisma')
  return frameworks
}

function isFrameworkCompatible(activeFrameworks: ReadonlySet<string>, framework: string | undefined): boolean {
  if (activeFrameworks.size === 0 || !framework) {
    return true
  }

  return activeFrameworks.has(framework)
}

function normalizeSeedText(value: string): string {
  return tokenizeLabel(value).join('')
}

function normalizeIdentifier(value: string): string {
  return normalizeSeedText(value.replace(/\(\)$/, ''))
}

function normalizedPromptIdentifier(value: string): string {
  return tokenizeLabel(
    value
      .replace(/^[`'"]+|[`'"]+$/g, '')
      .replace(/\(\)$/, '')
      .replace(/\.[A-Za-z0-9]{1,6}$/, ''),
  ).join('')
}

function compareStableText(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

function parseSymbolReference(value: string): SymbolReference {
  const trimmed = value.trim().replace(/`/g, '')
  const withoutCall = trimmed.replace(/\(\)$/, '')
  const separatorMatch = withoutCall.match(/^([A-Za-z_$][\w$]*)(?:\.|#|::)([A-Za-z_$][\w$]*)$/)
  if (separatorMatch?.[1] && separatorMatch[2]) {
    return {
      raw: trimmed,
      bareName: separatorMatch[2],
      className: separatorMatch[1],
      methodName: separatorMatch[2],
    }
  }

  return {
    raw: trimmed,
    bareName: withoutCall,
    ...(trimmed.endsWith('()') ? { methodName: withoutCall } : {}),
  }
}

function labelSymbolParts(label: string): { className?: string; methodName?: string; normalized: string } {
  const trimmed = label.trim().replace(/`/g, '')
  const normalized = normalizeIdentifier(trimmed)
  const dotted = trimmed.replace(/\(\)$/, '')
  const separatorMatch = dotted.match(/^([A-Za-z_$][\w$]*)(?:\.|#|::)([A-Za-z_$][\w$]*)$/)
  if (separatorMatch?.[1] && separatorMatch[2]) {
    return {
      className: separatorMatch[1],
      methodName: separatorMatch[2],
      normalized,
    }
  }

  const methodOnlyMatch = dotted.match(/^\.?([A-Za-z_$][\w$]*)$/)
  return {
    ...(methodOnlyMatch?.[1] ? { methodName: methodOnlyMatch[1] } : {}),
    normalized,
  }
}

function explicitPromptIdentifierSet(
  mentionedSymbolRefs: readonly SymbolReference[],
  mentionedPaths: readonly string[],
): ReadonlySet<string> {
  const explicit = new Set<string>()

  for (const reference of mentionedSymbolRefs) {
    for (const value of [reference.raw, reference.bareName, reference.className, reference.methodName]) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        continue
      }
      const normalized = normalizedPromptIdentifier(value)
      if (normalized.length > 0) {
        explicit.add(normalized)
      }
    }
  }

  for (const path of mentionedPaths) {
    const normalizedPath = normalizedPromptIdentifier(path)
    if (normalizedPath.length > 0) {
      explicit.add(normalizedPath)
    }
    const normalizedBase = normalizedPromptIdentifier(basename(path))
    if (normalizedBase.length > 0) {
      explicit.add(normalizedBase)
    }
  }

  return explicit
}

function extractPromptIdentifierSignals(
  question: string,
  mentionedSymbolRefs: readonly SymbolReference[],
  mentionedPaths: readonly string[],
): PromptIdentifierSignal[] {
  const explicit = explicitPromptIdentifierSet(mentionedSymbolRefs, mentionedPaths)
  const seen = new Set<string>()
  const signals: PromptIdentifierSignal[] = []
  const candidates = question.match(/[A-Za-z0-9_./-]+/g) ?? []

  for (const candidate of candidates) {
    if (!/[A-Za-z]/.test(candidate)) {
      continue
    }
    if (!(/[_./-]/.test(candidate) || /[a-z][A-Z]/.test(candidate) || /[A-Z][a-z]+[A-Z]/.test(candidate))) {
      continue
    }

    const tokens = tokenizeLabel(candidate)
    if (tokens.length < 2) {
      continue
    }

    const normalized = normalizedPromptIdentifier(candidate)
    if (normalized.length < 6 || explicit.has(normalized) || seen.has(normalized)) {
      continue
    }

    seen.add(normalized)
    signals.push({
      normalized,
      tokenCount: tokens.length,
    })
  }

  return signals
}

function promptIdentifierMatchScore(
  label: string,
  sourceFile: string,
  identifiers: readonly PromptIdentifierSignal[],
): number {
  if (identifiers.length === 0) {
    return 0
  }

  const normalizedLabel = normalizeIdentifier(label)
  const normalizedSource = normalizeSeedText(sourceFile)
  let best = 0

  for (const identifier of identifiers) {
    const labelContains = normalizedLabel.includes(identifier.normalized)
    const sourceContains = normalizedSource.includes(identifier.normalized)
    if (!labelContains && !sourceContains) {
      continue
    }

    const specificityBonus = Math.min(0.35, Math.max(0, identifier.tokenCount - 2) * 0.15)
    let score = labelContains ? 1.1 : 0.8
    if (sourceContains) {
      score += labelContains ? 0.35 : 0.25
    }
    if (normalizedLabel === identifier.normalized) {
      score += 0.2
    }

    best = Math.max(best, Math.min(1.75, score + specificityBonus))
  }

  return best
}

/**
 * Scores explicit symbol-reference strength on a 0-4 scale.
 * 4 = exact qualified match, 3.5 = method match with qualifier context in the
 * source path, 3 = strong qualified/method context match, 2.5 = bare-name
 * match, 0 = no symbol evidence. Callers use >= 3 as the "strong anchor"
 * threshold when deciding whether a match should be treated as exact.
 */
function symbolReferenceMatchScore(
  label: string,
  sourceFile: string,
  references: readonly SymbolReference[],
): number {
  const parts = labelSymbolParts(label)
  const normalizedSource = normalizeSeedText(sourceFile)
  let best = 0

  for (const reference of references) {
    const normalizedRaw = normalizeIdentifier(reference.raw)
    if (parts.normalized === normalizedRaw) {
      best = Math.max(best, 4)
      continue
    }

    const normalizedBare = normalizeIdentifier(reference.bareName)
    if (reference.className && reference.methodName) {
      const classMatches = normalizeIdentifier(parts.className ?? '') === normalizeIdentifier(reference.className)
      const methodMatches = normalizeIdentifier(parts.methodName ?? '') === normalizeIdentifier(reference.methodName)
      if (classMatches && methodMatches) {
        best = Math.max(best, 4)
        continue
      }
      if (methodMatches && normalizedSource.includes(normalizeIdentifier(reference.className))) {
        best = Math.max(best, 3.5)
        continue
      }
    }

    if (normalizeIdentifier(parts.methodName ?? '') === normalizedBare) {
      best = Math.max(best, reference.methodName ? 3 : 2.5)
      continue
    }
    if (parts.normalized === normalizedBare) {
      best = Math.max(best, 2.5)
    }
  }

  return best
}

function sourceFileMatchesMentionedPath(sourceFile: string, mentionedPaths: readonly string[]): boolean {
  if (sourceFile.length === 0) {
    return false
  }

  const normalizedSourceFile = sourceFile.replace(/\\/g, '/')
  return mentionedPaths.some((path) => {
    const normalizedPath = path.replace(/\\/g, '/')
    return normalizedSourceFile === normalizedPath || normalizedSourceFile.endsWith(`/${normalizedPath}`)
  })
}

function exclusionTokens(value: string): Set<string> {
  return new Set(tokenizeLabel(value))
}

function excludedTermMatches(value: string, excludedTerms: readonly string[], excludedPathHints: readonly string[]): boolean {
  const valueTokens = exclusionTokens(value)
  if (valueTokens.size === 0) {
    return false
  }

  return [...excludedTerms, ...excludedPathHints]
    .flatMap((term) => tokenizeLabel(term))
    .some((termToken) => valueTokens.has(termToken))
}

function promptAllowsSourceDomain(domain: SourceDomain, intent: string, prompt: string, questionTokens: readonly string[]): boolean {
  const lowerPrompt = prompt.toLowerCase()
  switch (domain) {
    case 'test':
      return intent === 'test' || includesAnyToken(questionTokens, ['test', 'tests', 'spec', 'coverage', 'e2e'])
    case 'benchmark':
      return includesAnyToken(questionTokens, ['bench', 'benchmark', 'benchmarks', 'perf', 'performance'])
        || /\b(html reporter|reporter utilities?)\b/i.test(lowerPrompt)
    case 'fixture':
      return includesAnyToken(questionTokens, ['fixture', 'fixtures', 'mock', 'mocks'])
    case 'generated':
      return includesAnyToken(questionTokens, ['generated', 'codegen'])
    case 'docs':
      return includesAnyToken(questionTokens, ['doc', 'docs', 'readme', 'changelog'])
    case 'config':
      return includesAnyToken(questionTokens, ['config', 'configs', 'env', 'docker', 'compose', 'settings'])
    case 'build_artifact':
      return includesAnyToken(questionTokens, ['dist', 'build', 'artifact', 'artifacts'])
    case 'production':
    case 'unknown':
      return true
  }
}

function defaultSourceDomainPenalty(
  domain: SourceDomain,
  intent: string,
  prompt: string,
  questionTokens: readonly string[],
): number {
  if (promptAllowsSourceDomain(domain, intent, prompt, questionTokens)) {
    return 0
  }

  switch (domain) {
    case 'test':
    case 'benchmark':
      return 3
    case 'fixture':
      return 2.5
    case 'generated':
    case 'build_artifact':
      return 3.5
    case 'docs':
      return 1.25
    case 'config':
      return 0.75
    case 'production':
    case 'unknown':
      return 0
  }
}

function isFileNodeLike(label: string, sourceFile: string): boolean {
  if (!label || !sourceFile) {
    return false
  }

  return label.trim().toLowerCase() === basename(sourceFile).trim().toLowerCase()
}

function questionLooksFileOriented(question: string, questionTokens: readonly string[]): boolean {
  if (/\.[a-z0-9]{1,6}\b/i.test(question)) {
    return true
  }

  return includesAnyToken(questionTokens, ['file', 'files', 'filepath', 'path', 'paths', 'directory', 'directories', 'folder', 'folders'])
}

function questionLooksLikeDefinitionLookup(question: string): boolean {
  return /\b(?:defined|declared|located|location|definition|declaration)\b/i.test(question)
    || /\bwhere\s+(?:is|are)\b/i.test(question)
}

function containsTokenSequence(tokens: readonly string[], sequence: readonly string[]): boolean {
  if (sequence.length === 0 || sequence.length > tokens.length) {
    return false
  }

  for (let startIndex = 0; startIndex <= tokens.length - sequence.length; startIndex += 1) {
    if (sequence.every((token, offset) => tokens[startIndex + offset] === token)) {
      return true
    }
  }
  return false
}

function evidenceTierForSeedScore(score: SeedScoreBreakdown): 0 | 1 | 2 {
  if (score.labelExactScore > 0 || score.labelPhraseScore > 0 || score.labelTokenScore > 0 || score.conceptualFallbackScore >= 0.75) {
    return 2
  }
  if (score.sourcePathScore > 0 || score.promptIdentifierScore > 0 || score.communityScore > 0 || score.conceptualFallbackScore > 0) {
    return 1
  }
  return 0
}

function compareScoredNodes(graph: KnowledgeGraph, left: ScoredNode, right: ScoredNode): number {
  return (
    right.evidenceTier - left.evidenceTier ||
    right.frameworkBoost - left.frameworkBoost ||
    right.score - left.score ||
    Number(left.fileNodeLike) - Number(right.fileNodeLike) ||
    graph.degree(right.id) - graph.degree(left.id) ||
    compareStableText(left.label, right.label) ||
    compareStableText(left.sourceFile, right.sourceFile) ||
    compareStableText(left.id, right.id)
  )
}

function runtimeGenerationNodeValue(
  node: {
    label: string
    sourceFile: string
    nodeKind: string
    frameworkRole?: string | undefined
  },
): number {
  const lower = `${node.label} ${node.nodeKind} ${node.frameworkRole ?? ''} ${node.sourceFile}`.toLowerCase()
  let value = 0

  if (/\b(?:src|server|backend|api|modules|services?|repositories?|controllers?|workers?|orchestrators?)\b/.test(lower)) {
    value += 1.25
  }
  if (/\b(?:nest_route|nest_controller|nest_provider|controller|service|repository|worker|orchestrator)\b/.test(lower)) {
    value += 1.75
  }
  if (/\b(?:generate|generation|create|start|process|pipeline|queue|job|research|agent|scoring|score|report|repository|persist|save|builder)\b/.test(lower)) {
    value += 1.5
  }
  if (/(?:^|[.#])(?:generate|create|start|process|save|score|search|update|claim|cancel)[A-Za-z_$\w]*\(?\)?$/i.test(node.label)) {
    value += 1
  }

  return value
}

function frontendDisplayNodePenalty(
  node: {
    label: string
    sourceFile: string
    nodeKind: string
    frameworkRole?: string | undefined
  },
): number {
  const lower = `${node.label} ${node.nodeKind} ${node.frameworkRole ?? ''} ${node.sourceFile}`.toLowerCase()
  let penalty = 0

  if (/\b(?:platform|frontend|front-end|client|ui|components?|pages?|views?)\b/.test(lower) || /\.(?:tsx|jsx)\b/.test(lower)) {
    penalty += 2
  }
  if (/\b(?:display|render|shown?|visible|footer|header|label|date|timestamp|component)\b/.test(lower)) {
    penalty += 1.5
  }
  if (/^pick[A-Z]/.test(node.label)) {
    penalty += 1.25
  }

  return penalty
}

function retrievalDomainAdjustment(
  retrievalGate: RetrievalGateDecision,
  node: {
    label: string
    sourceFile: string
    nodeKind: string
    frameworkRole?: string | undefined
  },
): number {
  if (
    retrievalGate.signals.generation_intent === 'runtime_generation'
    && retrievalGate.signals.target_domain_hint === 'backend_runtime'
  ) {
    return runtimeGenerationNodeValue(node) - frontendDisplayNodePenalty(node)
  }

  if (
    retrievalGate.signals.generation_intent === 'display_rendering'
    && retrievalGate.signals.target_domain_hint === 'frontend_display'
  ) {
    const displayValue = frontendDisplayNodePenalty(node)
    return displayValue > 0 ? displayValue * 0.7 : 0
  }

  return 0
}

function runtimeGenerationSourceDomainPenalty(
  retrievalGate: RetrievalGateDecision,
  sourceDomain: SourceDomain,
  explicitlyAnchored: boolean,
): number {
  if (
    explicitlyAnchored
    || retrievalGate.signals.generation_intent !== 'runtime_generation'
    || retrievalGate.signals.target_domain_hint !== 'backend_runtime'
  ) {
    return 0
  }

  switch (sourceDomain) {
    case 'test':
    case 'benchmark':
    case 'fixture':
    case 'generated':
    case 'docs':
    case 'build_artifact':
      return 6
    case 'config':
    case 'production':
    case 'unknown':
      return 0
  }
}

function promptAllowsScriptMigration(question: string): boolean {
  return /\b(?:scripts?|migrat(?:e|ed|es|ing|ion)|backfill|cli|one-off|repair|old pipeline|seed(?:ing|ers?)|seeds?\s+(?:data|db|database|scripts?|files?))\b/i.test(question)
}

function scriptMigrationPathPenalty(
  retrievalGate: RetrievalGateDecision,
  sourceFile: string,
  label: string,
  question: string,
  explicitlyAnchored: boolean,
): number {
  if (
    explicitlyAnchored
    || retrievalGate.signals.generation_intent !== 'runtime_generation'
    || retrievalGate.signals.target_domain_hint !== 'backend_runtime'
    || promptAllowsScriptMigration(question)
  ) {
    return 0
  }

  const normalizedSourceFile = sourceFile.replace(/\\/g, '/')
  return /(?:^|\/)(?:scripts?|migrations?|seeds?|backfills?)(?:\/|$)|\b(?:migrate|migration|backfill|seed)\b/i.test(normalizedSourceFile)
    || /\b(?:migrate|migration|backfill|seed)\b/i.test(label)
    ? 6
    : 0
}

function shouldDemoteSourcePathMatchForIntent(
  retrievalGate: RetrievalGateDecision,
  node: {
    label: string
    sourceFile: string
    nodeKind: string
    frameworkRole?: string | undefined
  },
): boolean {
  return retrievalGate.signals.generation_intent === 'runtime_generation'
    && retrievalGate.signals.target_domain_hint === 'backend_runtime'
    && frontendDisplayNodePenalty(node) > runtimeGenerationNodeValue(node)
}

export function reciprocalRankFuse(
  rankings: ReadonlyArray<readonly string[]>,
  options: { rankConstant?: number; weights?: readonly number[] } = {},
): Map<string, number> {
  const rankConstant = options.rankConstant ?? 10
  const weights = options.weights ?? []
  const fused = new Map<string, number>()

  rankings.forEach((ranking, rankingIndex) => {
    const rankingWeight = weights[rankingIndex] ?? 1
    ranking.forEach((candidateId, index) => {
      fused.set(candidateId, (fused.get(candidateId) ?? 0) + (rankingWeight / (rankConstant + index + 1)))
    })
  })

  return fused
}

function scoreSeedCandidate(
  question: string,
  questionTokens: readonly string[],
  label: string,
  sourceFile: string,
  communityLabel: string | null,
  promptIdentifiers: readonly PromptIdentifierSignal[],
  tokenWeights: ReadonlyMap<string, number>,
  averageLabelLength: number,
  options: { fileNodeLike: boolean; fileOrientedQuestion: boolean },
): SeedScoreBreakdown {
  const labelTokens = tokenizeLabel(label)
  const labelExactScore = normalizeSeedText(question) !== '' && normalizeSeedText(question) === normalizeSeedText(label) ? 2 : 0
  // Definition lookups should keep an explicitly named multi-token concept ahead of
  // source-path-only structural neighbors. Runtime-flow questions intentionally skip
  // this signal so executable steps retain their established ordering.
  const labelPhraseScore = questionLooksLikeDefinitionLookup(question)
    && labelTokens.length >= 2
    && containsTokenSequence(questionTokens, labelTokens)
    ? 1
    : 0
  const fileNodePenaltyApplies = options.fileNodeLike && !options.fileOrientedQuestion && labelExactScore === 0
  const labelTokenScore = fileNodePenaltyApplies ? 0 : scoreNode(questionTokens, labelTokens, tokenWeights, averageLabelLength)
  const sourcePathScore = fileNodePenaltyApplies ? 0 : scoreNode(questionTokens, tokenizeLabel(sourceFile), tokenWeights) * 0.25
  const promptIdentifierScore = fileNodePenaltyApplies ? 0 : promptIdentifierMatchScore(label, sourceFile, promptIdentifiers)
  const communityScore = fileNodePenaltyApplies
    ? 0
    : communityLabel
    ? Math.min(scoreNode(questionTokens, tokenizeLabel(communityLabel)) * 0.1, 0.2)
    : 0

  return {
    labelExactScore,
    labelPhraseScore,
    labelTokenScore,
    sourcePathScore,
    promptIdentifierScore,
    communityScore,
    conceptualFallbackScore: 0,
    total: labelExactScore + labelPhraseScore + labelTokenScore + sourcePathScore + promptIdentifierScore + communityScore,
  }
}

function rankedSeedCandidateIds(
  graph: KnowledgeGraph,
  candidates: readonly SeedCandidate[],
  scoreForCandidate: (candidate: SeedCandidate) => number,
): string[] {
  return candidates
    .filter((candidate) => scoreForCandidate(candidate) > 0)
    .sort((left, right) => (
      scoreForCandidate(right) - scoreForCandidate(left) ||
      right.seedScore.total - left.seedScore.total ||
      graph.degree(right.id) - graph.degree(left.id) ||
      compareStableText(left.label, right.label) ||
      compareStableText(left.sourceFile, right.sourceFile) ||
      compareStableText(left.id, right.id)
    ))
    .map((candidate) => candidate.id)
}

function relationWeight(relation: string): number {
  switch (relation) {
    case 'calls':
    case 'enqueues_job':
    case 'imports_from':
    case 'defines':
    case 'defines_action':
    case 'defines_selector':
      return 1
    case 'contains':
    case 'renders':
      return 1.2
    case 'loads_route':
    case 'submits_route':
    case 'registered_in_store':
    case 'updates_slice':
      return 1
    case 'uses':
    case 'depends_on':
      return 0.7
    default:
      return 0.35
  }
}

function includesAnyToken(tokens: readonly string[], candidates: readonly string[]): boolean {
  return candidates.some((candidate) => tokens.includes(candidate))
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function containsWholeQuestionToken(questionLower: string, value: string): boolean {
  const normalizedValue = value.toLowerCase()
  return normalizedValue.length > 0 && new RegExp(`(^|[^a-z0-9])${escapeRegexLiteral(normalizedValue)}(?=$|[^a-z0-9])`).test(questionLower)
}

function containsUrlLikeRoutePath(question: string): boolean {
  return (
    /(^|[\s"'`([{])(\/(?:[A-Za-z0-9:_-]+(?:\/[A-Za-z0-9:_-]+)*)?\/?)(?=$|[\s"'`)\]}?!,:;])/.test(question) ||
    /(^|[\s"'`([{])(\/(?:[A-Za-z0-9:_-]+(?:\/[A-Za-z0-9:_-]+)*)?\/?)\.(?=$|[\s"'`)\]}?!,:;])/.test(question)
  )
}

function hasHttpVerbIntent(question: string, questionTokens: readonly string[], hasRoutePath: boolean, hasRouteKeyword: boolean): boolean {
  const uppercaseQuestion = question.toUpperCase()
  const hasUnambiguousHttpVerb = /\b(GET|POST|PUT|PATCH|DELETE|OPTIONS)\b/.test(uppercaseQuestion)
  if (hasUnambiguousHttpVerb) {
    return true
  }

  const hasHeadVerb = /\bHEAD\b/.test(uppercaseQuestion)
  const hasUseVerb = /\bUSE\b/.test(uppercaseQuestion)
  const hasAllVerb = /\bALL\b/.test(uppercaseQuestion)
  if (!hasHeadVerb && !hasUseVerb && !hasAllVerb) {
    return false
  }

  const hasHttpContext = includesAnyToken(questionTokens, ['express', 'http', 'https', 'method', 'methods', 'verb', 'verbs'])
  if (hasRoutePath || hasRouteKeyword || hasHttpContext) {
    return true
  }

  return hasHeadVerb && includesAnyToken(questionTokens, ['request', 'requests'])
}

function promptWantsControllerStep(question: string): boolean {
  const questionTokens = tokenizeQuestion(question)
  const hasRoutePath = containsUrlLikeRoutePath(question)
  const hasRouteKeyword = includesAnyToken(questionTokens, [
    'route', 'routes', 'router', 'controller', 'controllers', 'handler', 'handlers', 'endpoint', 'endpoints',
  ])

  return hasRoutePath || hasHttpVerbIntent(question, questionTokens, hasRoutePath, hasRouteKeyword) || hasRouteKeyword
}

function promptWantsServiceStep(question: string): boolean {
  const questionTokens = tokenizeQuestion(question)
  return includesAnyToken(questionTokens, ['service', 'services', 'provider', 'providers', 'usecase', 'usecases', 'application', 'applications'])
    || /\b(?:use-case|orchestrator)\b/i.test(question)
}

function promptWantsRuntimePipeline(question: string): boolean {
  return /\b(runtime|pipeline|service|orchestrator|job|agent|scoring|report(?: builder)?|persistence|repository|queue|worker)\b/i.test(question)
}

function promptWantsReportGenerationCore(question: string): boolean {
  return /\b(?:report(?:\s+generation)?|generated\s+report|validation\s+report|final\s+report|assembly|assemble|synthesis|renderer|render|planner|research|metrics?|scor(?:e|ing)|quality(?:\s|-)?gate)\b/i.test(question)
}

function promptHasExplicitExecutionAnchor(question: string): boolean {
  return containsUrlLikeRoutePath(question)
    || /`[^`]+`/.test(question)
    || /\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\b/.test(question)
}

function promptWantsDetailedReportGenerationPhases(question: string): boolean {
  return promptWantsReportGenerationCore(question) && !promptHasExplicitExecutionAnchor(question)
}

function promptWantsAuthGuardPhase(question: string): boolean {
  return /\b(?:auth|guard|guards|authorize|authorized|authorization|permissions?|roles?|plan enforcement)\b/i.test(question)
}

function promptWantsValidationPhase(question: string): boolean {
  return /\b(?:validate|validator|validators|schema|schemas|dto|dtos|pipe|pipes)\b/i.test(question)
    || (
      /\bvalidation\b/i.test(question)
      && !/\bvalidation\s+report\b/i.test(question)
    )
}

function promptWantsNotificationOrEventPhase(question: string): boolean {
  return /\b(?:notify|notification|notifications|event|events|emit|emits|broadcast|webhook|publish)\b/i.test(question)
}

function promptWantsFailureHandling(question: string): boolean {
  return /\b(?:fail(?:s|ed|ure|ures|ing)?|error|errors|exception|exceptions|quality(?:\s|-)?gate|fallback|dead(?:\s|-)?letter)\b/i.test(question)
}

function promptExplicitlyWantsRuntimeHandoff(question: string): boolean {
  return /\b(?:runtime|pipeline|job|jobs|queue|worker|workers|enqueue|enqueues|enqueued|processed|processing|orchestrator)\b/i.test(question)
}

function promptUsesExpandedExecutionTaxonomy(question: string): boolean {
  return promptWantsDetailedReportGenerationPhases(question)
    || promptWantsAuthGuardPhase(question)
    || promptWantsValidationPhase(question)
    || promptWantsNotificationOrEventPhase(question)
}

function methodLikeLabel(label: string): boolean {
  return /(?:[.#:]|^\.)[A-Za-z_$][\w$]*\(?\)?$/u.test(label)
}

function fileLikeNodeLabel(label: string): boolean {
  return /(?:^|\/)[^/]+\.[cm]?[jt]sx?$/i.test(label)
}

function fileLikeExecutionStep(
  node: Pick<ContextPackExecutionSliceStep, 'label'>,
): boolean {
  return fileLikeNodeLabel(node.label)
}

function pipelineBridgeText(
  label: string,
  frameworkRole: string | undefined,
  sourceFile: string,
  nodeKind?: string,
): boolean {
  const lower = `${label} ${frameworkRole ?? ''} ${sourceFile} ${nodeKind ?? ''}`.toLowerCase()
  return /\bpipeline|trigger|queue|job|worker|orchestrator|planner|research|agent|scoring|report|repository|persistence|save|process|search|score|addjob\b/.test(lower)
}

function supportingPolicyOrLoggerNode(
  node: Pick<RetrieveMatchedNode, 'label' | 'framework_role' | 'source_file'>,
): boolean {
  const lower = `${node.label} ${node.framework_role ?? ''} ${node.source_file}`.toLowerCase()
  return /planenforcement|guard|interceptor|swagger|apioperation|apiresponse|apitags|logger|\.info\(\)|\.error\(\)|\.warn\(\)|\.debug\(\)/.test(lower)
}

function pipelineBridgeNode(
  node: Pick<RetrieveMatchedNode, 'label' | 'framework_role' | 'source_file' | 'node_kind'>,
): boolean {
  return pipelineBridgeText(node.label, node.framework_role, node.source_file, node.node_kind)
}

function runtimeFlowRelation(relation: string): boolean {
  return relation === 'calls' || relation === 'enqueues_job'
}

function lowValueReportGenerationCompactNode(
  node: {
    label: string
    source_file: string
    node_kind?: string | undefined
    framework_role?: string | undefined
  },
): boolean {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return lowValueExecutionStep({
    label: node.label,
    source_file: node.source_file,
    ...(node.node_kind !== undefined ? { node_kind: node.node_kind } : {}),
    ...(node.framework_role !== undefined ? { framework_role: node.framework_role } : {}),
  })
    || /\b(?:title|status|suggest|guard|auth|interceptor|refund|claim|cancel|signedurl|buildperspective|letsbuild|publish|delete)\b/.test(lower)
    || /(?:^|[.#])(?:generatefallbacktitle|generatetitle|getstatusmessage|claimqueuedpipelinerun|releasequeuedpipelineclaim|releaseunusedcreditreservation|generatebuildperspective|generatesignedurl|generateletsbuild|publishidea|getidea|listideas|deleteidea|suggestimprovements)[A-Za-z_$\w]*\(?\)?$/i.test(node.label)
}

function reportGenerationCompactApplies(result: RetrieveResult): boolean {
  if (
    result.retrieval_strategy !== 'slice-v1'
    || !promptWantsRuntimePipeline(result.question)
    || !promptWantsReportGenerationCore(result.question)
    || !result.slice
    || promptExpectsPersistenceStep(result.question)
  ) {
    return false
  }

  if (result.slice.anchors.some((anchor) => anchor.reason === 'symbol mention' || anchor.reason === 'path mention')) {
    return false
  }

  return result.slice.anchors.some((anchor) => anchor.reason === 'generation core heuristic')
    || (result.execution_slice?.steps.length ?? 0) >= 3
}

function reportGenerationCompactPriority(
  node: Pick<RetrieveMatchedNode, 'label' | 'source_file' | 'node_kind' | 'framework_role' | 'relevance_band'>,
  executionStepLabels: ReadonlySet<string>,
): number {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  let value = 0

  if (executionStepLabels.has(node.label)) value += 80
  if (/\b(?:planner|plan\b|research|assembly|assemble|renderer|render|synth|quality(?:-| )gate|dispatchwave|dispatchdbsync|broadcastrunstarted|broadcastrunfailed|queue|job|worker|orchestrator|process|persist|save)\b/.test(lower)) value += 40
  if (/\bscoremetrics\b/.test(lower)) value += 35
  if (pipelineBridgeNode(node)) value += 20
  if (node.relevance_band === 'direct') value += 5

  if (
    /(?:^|[.#])(?:generatescoringledger|generatesensitivityanalysis|generatesuggestednextsteps|scoremetricbatch|deduplicateevidencerefs|mapcompositetorecommendation|normalizemetric|parsejson)\(?\)?$/i.test(node.label)
    || /\b(?:metrichumanprompt|fallbackmetric)\b/.test(lower)
  ) {
    value -= 35
  }
  if (lowValueReportGenerationCompactNode(node)) value -= 100

  return value
}

function compactSlicePromotionApplies(result: RetrieveResult): boolean {
  if (result.retrieval_strategy !== 'slice-v1' || !promptWantsRuntimePipeline(result.question)) {
    return false
  }

  if (reportGenerationCompactApplies(result)) {
    return true
  }

  return (result.slice?.anchors ?? []).some((anchor) =>
    anchor.reason === 'symbol mention' && methodLikeLabel(anchor.label),
  )
}

function structuralSlicePromotionApplies(
  sliceMetadata: ContextPackSliceMetadata | undefined,
  question: string,
): boolean {
  if (!sliceMetadata || !promptWantsRuntimePipeline(question)) {
    return false
  }

  return sliceMetadata.anchors.some((anchor) => methodLikeLabel(anchor.label))
}

function promotedSliceCompactNodeIds(result: RetrieveResult): string[] {
  if (!compactSlicePromotionApplies(result) || !result.slice) {
    return []
  }

  if (reportGenerationCompactApplies(result)) {
    const matchedById = new Map(
      result.matched_nodes
        .map((node) => (typeof node.node_id === 'string' && node.node_id.length > 0 ? [node.node_id, node] as const : null))
        .filter((entry): entry is readonly [string, RetrieveMatchedNode] => entry !== null),
    )
    const executionStepLabels = new Set<string>()
    const executionStepFiles = new Set<string>()
    const promoted = new Set<string>()
    const addPromoted = (nodeId: string | undefined): void => {
      if (typeof nodeId !== 'string' || nodeId.length === 0) {
        return
      }
      const node = matchedById.get(nodeId)
      if (!node || supportingPolicyOrLoggerNode(node) || lowValueReportGenerationCompactNode(node)) {
        return
      }
      promoted.add(nodeId)
    }
    const addPromotedByLabel = (label: string): void => {
      for (const node of result.matched_nodes) {
        if (node.label !== label) {
          continue
        }
        addPromoted(node.node_id)
      }
    }

    for (const anchor of result.slice.anchors) {
      addPromoted(anchor.node_id)
    }

    for (const step of result.execution_slice?.steps ?? []) {
      executionStepLabels.add(step.label)
      executionStepFiles.add(step.source_file)
      addPromoted(step.node_id)
      addPromotedByLabel(step.label)
    }
    for (const step of result.execution_slice?.primary_path?.steps ?? []) {
      executionStepLabels.add(step.label)
      executionStepFiles.add(step.source_file)
      addPromoted(step.node_id)
      addPromotedByLabel(step.label)
    }

    for (const path of result.slice.selected_paths) {
      if (!runtimeFlowRelation(path.relation)) {
        continue
      }

      const fromNode = typeof path.from_id === 'string' ? matchedById.get(path.from_id) : undefined
      const toNode = typeof path.to_id === 'string' ? matchedById.get(path.to_id) : undefined
      if (fromNode && pipelineBridgeNode(fromNode)) {
        addPromoted(path.from_id)
      }
      if (toNode && pipelineBridgeNode(toNode)) {
        addPromoted(path.to_id)
      }
      if (fromNode && toNode && fromNode.source_file === toNode.source_file) {
        if (executionStepFiles.has(fromNode.source_file)) {
          addPromoted(path.from_id)
          addPromoted(path.to_id)
        }
      }
    }

    return result.matched_nodes
      .filter((node) => typeof node.node_id === 'string' && promoted.has(node.node_id))
      .sort((left, right) => {
        const priorityDelta = reportGenerationCompactPriority(right, executionStepLabels)
          - reportGenerationCompactPriority(left, executionStepLabels)
        if (priorityDelta !== 0) {
          return priorityDelta
        }
        const leftPipeline = pipelineBridgeNode(left) ? 1 : 0
        const rightPipeline = pipelineBridgeNode(right) ? 1 : 0
        if (leftPipeline !== rightPipeline) {
          return rightPipeline - leftPipeline
        }
        return right.match_score - left.match_score
      })
      .flatMap((node) => (typeof node.node_id === 'string' ? [node.node_id] : []))
      .slice(0, 24)
  }

  const promoted = new Set<string>(
    result.slice.anchors
      .map((anchor) => anchor.node_id)
      .filter((anchorId): anchorId is string => typeof anchorId === 'string' && anchorId.length > 0),
  )

  for (const path of result.slice.selected_paths) {
    if (path.direction !== 'forward' || !runtimeFlowRelation(path.relation) || typeof path.to_id !== 'string') {
      continue
    }
    const target = result.matched_nodes.find((node) => node.node_id === path.to_id)
    if (!target || supportingPolicyOrLoggerNode(target)) {
      continue
    }
    promoted.add(path.to_id)
  }

  for (const node of result.matched_nodes) {
    if (typeof node.node_id !== 'string' || node.node_id.length === 0) {
      continue
    }
    if (supportingPolicyOrLoggerNode(node)) {
      continue
    }
    if (fileLikeNodeLabel(node.label) || node.node_kind === 'class') {
      continue
    }
    if (node.relevance_band === 'direct' || pipelineBridgeNode(node)) {
      promoted.add(node.node_id)
    }
  }

  return result.matched_nodes
    .flatMap((node) => (typeof node.node_id === 'string' && promoted.has(node.node_id) ? [node.node_id] : []))
    .slice(0, 24)
}

function promotedSliceCompactLabels(result: RetrieveResult): string[] {
  if (!compactSlicePromotionApplies(result) || !result.slice) {
    return []
  }

  if (reportGenerationCompactApplies(result)) {
    const matchedById = new Map(
    result.matched_nodes
      .map((node) => (typeof node.node_id === 'string' && node.node_id.length > 0 ? [node.node_id, node] as const : null))
      .filter((entry): entry is readonly [string, RetrieveMatchedNode] => entry !== null),
    )
    const representativeByLabel = new Map<string, RetrieveMatchedNode>()
    for (const node of result.matched_nodes) {
    if (!representativeByLabel.has(node.label)) {
      representativeByLabel.set(node.label, node)
    }
    }

    const executionStepLabels = new Set<string>()
    const executionStepFiles = new Set<string>()
    const promotedLabels = new Set<string>()
    const addPromotedLabel = (label: string | undefined, node?: RetrieveMatchedNode): void => {
    if (typeof label !== 'string' || label.length === 0) {
      return
    }
    const candidate = node ?? representativeByLabel.get(label)
    if (!candidate || supportingPolicyOrLoggerNode(candidate) || lowValueReportGenerationCompactNode(candidate)) {
      return
    }
    promotedLabels.add(label)
    }

    for (const anchor of result.slice.anchors) {
    addPromotedLabel(anchor.label, typeof anchor.node_id === 'string' ? matchedById.get(anchor.node_id) : undefined)
    }

    for (const step of result.execution_slice?.steps ?? []) {
    executionStepLabels.add(step.label)
    executionStepFiles.add(step.source_file)
    addPromotedLabel(step.label, typeof step.node_id === 'string' ? matchedById.get(step.node_id) : undefined)
    }
    for (const step of result.execution_slice?.primary_path?.steps ?? []) {
    executionStepLabels.add(step.label)
    executionStepFiles.add(step.source_file)
    addPromotedLabel(step.label, typeof step.node_id === 'string' ? matchedById.get(step.node_id) : undefined)
    }

    for (const path of result.slice.selected_paths) {
    if (!runtimeFlowRelation(path.relation)) {
      continue
    }

    const fromNode = typeof path.from_id === 'string' ? matchedById.get(path.from_id) : representativeByLabel.get(path.from)
    const toNode = typeof path.to_id === 'string' ? matchedById.get(path.to_id) : representativeByLabel.get(path.to)
    if (fromNode && pipelineBridgeNode(fromNode)) {
      addPromotedLabel(fromNode.label, fromNode)
    }
    if (toNode && pipelineBridgeNode(toNode)) {
      addPromotedLabel(toNode.label, toNode)
    }
    if (fromNode && toNode && fromNode.source_file === toNode.source_file) {
      if (executionStepFiles.has(fromNode.source_file)) {
        addPromotedLabel(fromNode.label, fromNode)
        addPromotedLabel(toNode.label, toNode)
      }
    }
    }

    return [...promotedLabels]
    .sort((left, right) => {
      const leftNode = representativeByLabel.get(left)
      const rightNode = representativeByLabel.get(right)
      const priorityDelta = (rightNode ? reportGenerationCompactPriority(rightNode, executionStepLabels) : 0)
        - (leftNode ? reportGenerationCompactPriority(leftNode, executionStepLabels) : 0)
      if (priorityDelta !== 0) {
        return priorityDelta
      }
      return left.localeCompare(right)
    })
    .slice(0, 24)
  }

  return result.slice.anchors.map((anchor) => anchor.label)
}

function structuralSliceNodeIds(
  sliceMetadata: ContextPackSliceMetadata | undefined,
  orderedCandidates: readonly ScoredNode[],
  question: string,
): ReadonlySet<string> {
  if (!sliceMetadata || !structuralSlicePromotionApplies(sliceMetadata, question)) {
    return new Set()
  }

  const nodesById = new Map(orderedCandidates.map((node) => [node.id, node]))
  const runtimeFlowNeighbors = new Map<string, string[]>()
  const addRuntimeFlowNeighbor = (fromId: string, toId: string): void => {
    const current = runtimeFlowNeighbors.get(fromId) ?? []
    if (!current.includes(toId)) {
      current.push(toId)
      runtimeFlowNeighbors.set(fromId, current)
    }
  }
  for (const path of sliceMetadata.selected_paths) {
    if (!runtimeFlowRelation(path.relation) || typeof path.from_id !== 'string' || typeof path.to_id !== 'string') {
      continue
    }
    addRuntimeFlowNeighbor(path.from_id, path.to_id)
    addRuntimeFlowNeighbor(path.to_id, path.from_id)
  }

  const structural = new Set<string>()
  const seen = new Set<string>()
  const queue = sliceMetadata.anchors
    .map((anchor) => anchor.node_id)
    .filter((anchorId): anchorId is string => typeof anchorId === 'string' && anchorId.length > 0)
    .map((id) => ({ id, depth: 0 }))

  for (const { id } of queue) {
    seen.add(id)
  }

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.depth >= 4) {
      continue
    }

    for (const neighborId of runtimeFlowNeighbors.get(current.id) ?? []) {
      const target = nodesById.get(neighborId)
      if (!target) {
        continue
      }

      const nextDepth = current.depth + 1
      if (nextDepth >= 2 || pipelineBridgeText(target.label, target.frameworkRole, target.sourceFile, target.nodeKind)) {
        structural.add(target.id)
      }

      if (!seen.has(neighborId)) {
        seen.add(neighborId)
        queue.push({ id: neighborId, depth: nextDepth })
      }
    }
  }

  return structural
}

function augmentSliceCandidateIdsForDebug(
  graph: KnowledgeGraph,
  orderedIds: readonly string[],
  metadata: ContextPackSliceMetadata,
): string[] {
  if (metadata.mode !== 'debug') {
    return [...orderedIds]
  }

  const expanded = [...orderedIds]
  const seen = new Set(expanded)
  const helperRelations = new Set(['uses_guard', 'guarded_by', 'reads_env', 'uses_config', 'depends_on', 'covered_by', 'injects'])

  for (const anchor of metadata.anchors) {
    if (typeof anchor.node_id !== 'string' || anchor.node_id.length === 0) {
      continue
    }
    const anchorCommunity = parseCommunityId(graph.nodeAttributes(anchor.node_id).community)

    for (const predecessorId of graph.predecessors(anchor.node_id)) {
      const relation = String(graph.edgeAttributes(predecessorId, anchor.node_id).relation ?? 'related_to')
      if (!['calls', 'controller_route', 'route_handler'].includes(relation)) {
        continue
      }

      const predecessorAttributes = graph.nodeAttributes(predecessorId)
      const predecessorRole = String(predecessorAttributes.framework_role ?? '').toLowerCase()
      const predecessorCommunity = parseCommunityId(predecessorAttributes.community)
      if (
        anchorCommunity !== null
        && predecessorCommunity !== anchorCommunity
        && !predecessorRole.includes('controller')
        && !predecessorRole.includes('route')
      ) {
        continue
      }

      if (!seen.has(predecessorId)) {
        seen.add(predecessorId)
        expanded.push(predecessorId)
      }

      for (const helperId of graph.successors(predecessorId)) {
        const helperRelation = String(graph.edgeAttributes(predecessorId, helperId).relation ?? 'related_to')
        if (!helperRelations.has(helperRelation) || seen.has(helperId)) {
          continue
        }
        seen.add(helperId)
        expanded.push(helperId)
      }
    }
  }

  return expanded
}

function runtimeGenerationSliceCandidatePromotionApplies(
  retrievalGate: RetrievalGateDecision,
  sliceMetadata: ContextPackSliceMetadata,
): boolean {
  return sliceMetadata.mode === 'explain'
    && retrievalGate.intent === 'explain'
    && retrievalGate.signals.generation_intent === 'runtime_generation'
    && retrievalGate.signals.target_domain_hint === 'backend_runtime'
}

function augmentSliceCandidateIdsForRuntimeExplain(
  graph: KnowledgeGraph,
  orderedIds: readonly string[],
  metadata: ContextPackSliceMetadata,
  retrievalGate: RetrievalGateDecision,
  question: string,
): string[] {
  if (!runtimeGenerationSliceCandidatePromotionApplies(retrievalGate, metadata)) {
    return [...orderedIds]
  }

  const expanded = [...orderedIds]
  const seen = new Set(expanded)
  const nodeIdByLabel = new Map<string, string>()
  for (const [nodeId, attributes] of graph.nodeEntries()) {
    const label = String(attributes.label ?? nodeId)
    if (!nodeIdByLabel.has(label)) {
      nodeIdByLabel.set(label, nodeId)
    }
  }

  const resolveNodeId = (nodeId: string | undefined, label: string): string | undefined => {
    if (nodeId && graph.hasNode(nodeId)) {
      return nodeId
    }
    return nodeIdByLabel.get(label)
  }

  const anchorIds = metadata.anchors
    .map((anchor) => resolveNodeId(anchor.node_id, anchor.label))
    .filter((nodeId): nodeId is string => typeof nodeId === 'string')
  const executionScope = collectExecutionSliceScope(graph, metadata, anchorIds, question, resolveNodeId)

  for (const nodeId of executionScope.orderedIds) {
    if (!seen.has(nodeId)) {
      seen.add(nodeId)
      expanded.push(nodeId)
    }
  }

  return expanded
}

function runtimeGenerationExecutionSliceApplies(
  taskContract: ContextPackTaskContract,
  retrievalGate: RetrievalGateDecision,
  sliceMetadata: ContextPackSliceMetadata | undefined,
): boolean {
  return retrievalGate.signals.generation_intent === 'runtime_generation'
    && retrievalGate.signals.target_domain_hint === 'backend_runtime'
    && taskContract.task_kind === 'explain'
    && sliceMetadata !== undefined
}

function executionSliceFlowRelation(relation: string): boolean {
  return runtimeFlowRelation(relation)
    || relation === 'controller_route'
    || relation === 'route_handler'
    || relation === 'method'
    || relation === 'uses_guard'
    || relation === 'guarded_by'
}

function executionSliceEdgePriority(relation: string): number {
  if (relation === 'enqueues_job') {
    return 3
  }
  if (relation === 'calls') {
    return 2
  }
  if (relation === 'controller_route' || relation === 'route_handler' || relation === 'method') {
    return 1
  }
  return 0
}

function promptExpectsPersistenceStep(question: string): boolean {
  return /\b(?:persist(?:ence|ent)?|repository|database|db|store|storage)\b/i.test(question)
}

function persistenceLikeExecutionStep(
  node: Pick<RetrieveMatchedNode, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /\b(?:persist|repository|database|db|storage|store|sessionstore|createsession|insert|write|save)\b/.test(lower)
}

function executionSliceStepPriority(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
  question: string,
): number {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  const label = node.label
  let value = 0

  if (fileLikeNodeLabel(label)) {
    value -= 40
  }
  if (promptExpectsPersistenceStep(question) && persistenceLikeExecutionStep(node)) {
    value += 100
  }
  if (promptWantsRuntimePipeline(question) && /\b(?:queue|job|worker|pipeline|orchestrator)\b/.test(lower)) {
    value += 25
  }
  if (promptWantsRuntimePipeline(question) && (
    /(?:^|[.#])(?:start|enqueue|process|search|score|save|create|generate|dispatch|persist|add)[A-Za-z_$\w]*\(?\)?$/i.test(label)
    || /\baddjob\b/i.test(label)
  )) {
    value += 15
  }
  if (promptWantsFailureHandling(question) && (failureHandlingLikeExecutionStep(node) || qualityGateLikeExecutionStep(node))) {
    value += 140
  }
  if (/\b(?:route|controller|service|queue|worker|job|pipeline|orchestrator|repository|store)\b/.test(lower)) {
    value += 10
  }
  if (/\b(?:validate|validator|schema|dto|spec|test|guard|config|env)\b/.test(lower)) {
    value -= 5
  }
  if (promptWantsRuntimePipeline(question) && (
    /(?:^|[.#])(?:cancel|claim|status|get|list|retry|suggest|validate|update)[A-Za-z_$\w]*\(?\)?$/i.test(label)
    || /\b(?:cancel|claim|status|suggest)\b/.test(lower)
  )) {
    value -= 20
  }
  if (!promptWantsFailureHandling(question) && failureHandlingLikeExecutionStep(node)) {
    value -= 90
  }

  return value
}

function executionSliceStepFromGraph(
  graph: KnowledgeGraph,
  nodeId: string,
  rootPath?: string,
): ContextPackExecutionSliceStep {
  const attributes = graph.nodeAttributes(nodeId)
  return {
    node_id: nodeId,
    label: String(attributes.label ?? nodeId),
    source_file: relativizeSourceFile(String(attributes.source_file ?? ''), rootPath),
    line_number: lineNumberFromSourceLocation(String(attributes.source_location ?? '')) ?? 0,
    ...(typeof attributes.node_kind === 'string' ? { node_kind: attributes.node_kind } : {}),
    ...(typeof attributes.framework_role === 'string' ? { framework_role: attributes.framework_role } : {}),
  }
}

type ExecutionPhase = ContextPackExecutionPhase

interface ExecutionFlowEdge {
  fromId: string
  toId: string
  relation: string
}

interface ExecutionPathCandidate {
  nodeIds: string[]
  edges: ExecutionFlowEdge[]
}

function collectExecutionSliceScope(
  graph: KnowledgeGraph,
  sliceMetadata: ContextPackSliceMetadata,
  anchorIds: readonly string[],
  question: string,
  resolveNodeId: (nodeId: string | undefined, label: string) => string | undefined,
): { orderedIds: string[]; idSet: ReadonlySet<string> } {
  const orderedIds: string[] = []
  const idSet = new Set<string>()
  let addedSelectedFlowPath = false
  const addNodeId = (nodeId: string | undefined): void => {
    if (!nodeId || idSet.has(nodeId) || !graph.hasNode(nodeId)) {
      return
    }
    idSet.add(nodeId)
    orderedIds.push(nodeId)
  }

  for (const anchorId of anchorIds) {
    addNodeId(anchorId)
  }

  for (const path of sliceMetadata.selected_paths) {
    if (!executionSliceFlowRelation(path.relation)) {
      continue
    }
    const beforeSize = idSet.size
    addNodeId(resolveNodeId(path.from_id, path.from))
    addNodeId(resolveNodeId(path.to_id, path.to))
    if (idSet.size > beforeSize) {
      addedSelectedFlowPath = true
    }
  }

  if (promptWantsAuthGuardPhase(question) || promptWantsValidationPhase(question)) {
    const helperRelations = new Set(['uses_guard', 'guarded_by', 'calls'])
    const wantsRequestedHelper = (nodeId: string): boolean => {
      const attributes = graph.nodeAttributes(nodeId)
      const step = {
        label: String(attributes.label ?? nodeId),
        source_file: String(attributes.source_file ?? ''),
        ...(typeof attributes.node_kind === 'string' ? { node_kind: attributes.node_kind } : {}),
        ...(typeof attributes.framework_role === 'string' ? { framework_role: attributes.framework_role } : {}),
      }
      return (promptWantsAuthGuardPhase(question) && authGuardLikeExecutionStep(step))
        || (promptWantsValidationPhase(question) && validationLikeExecutionStep(step))
    }

    for (const nodeId of [...orderedIds]) {
      for (const successorId of graph.successors(nodeId)) {
        const relation = String(graph.edgeAttributes(nodeId, successorId).relation ?? 'related_to')
        if (helperRelations.has(relation) && wantsRequestedHelper(successorId)) {
          addNodeId(successorId)
        }
      }
      for (const predecessorId of graph.predecessors(nodeId)) {
        const relation = String(graph.edgeAttributes(predecessorId, nodeId).relation ?? 'related_to')
        if (helperRelations.has(relation) && wantsRequestedHelper(predecessorId)) {
          addNodeId(predecessorId)
        }
      }
    }
  }

  if (addedSelectedFlowPath) {
    return { orderedIds, idSet }
  }

  const queue = anchorIds.map((nodeId) => ({ nodeId, depth: 0 }))
  const bestDepthByNode = new Map(anchorIds.map((nodeId) => [nodeId, 0]))
  const enqueueNeighbor = (nodeId: string, depth: number): void => {
    const bestDepth = bestDepthByNode.get(nodeId)
    if (bestDepth !== undefined && bestDepth <= depth) {
      return
    }
    bestDepthByNode.set(nodeId, depth)
    queue.push({ nodeId, depth })
  }

  while (queue.length > 0) {
    const { nodeId, depth } = queue.shift()!
    addNodeId(nodeId)
    if (depth >= 6) {
      continue
    }
    for (const predecessorId of graph.predecessors(nodeId)) {
      if (executionSliceFlowRelation(String(graph.edgeAttributes(predecessorId, nodeId).relation ?? 'related_to'))) {
        enqueueNeighbor(predecessorId, depth + 1)
      }
    }
    for (const successorId of graph.successors(nodeId)) {
      if (executionSliceFlowRelation(String(graph.edgeAttributes(nodeId, successorId).relation ?? 'related_to'))) {
        enqueueNeighbor(successorId, depth + 1)
      }
    }
  }

  return { orderedIds, idSet }
}

function controllerLikeExecutionStep(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  if (fileLikeExecutionStep(node)) {
    return false
  }
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /\b(?:route|controller|handler|endpoint|middleware)\b/.test(lower)
}

function serviceLikeExecutionStep(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /\b(?:service|provider|application|usecase|use-case|trigger|orchestrator)\b/.test(lower)
}

function authGuardLikeExecutionStep(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  const lower = `${node.label} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /\b(?:guard|permission|role|rbac|acl|authorize|authorization|plan enforcement)\b/.test(lower)
    || /\bauth(?:[\s_-]?guard)\b/.test(lower)
}

function validationLikeExecutionStep(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /\b(?:validation|validate|validator|schema|dto|pipe)\b/.test(lower)
    && !qualityGateLikeExecutionStep(node)
}

function orchestratorLikeExecutionStep(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /\b(?:orchestrator|workflow|coordinator)\b/.test(lower)
}

function plannerLikeExecutionStep(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /\b(?:planner|planning)\b/.test(lower)
    || /(?:^|[.#])plan[A-Za-z_$\w]*\(?\)?$/i.test(node.label)
}

function queueLikeExecutionStep(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /\b(?:queue|enqueue|job|addjob|pipeline)\b/.test(lower)
}

function workerLikeExecutionStep(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /\b(?:worker|processor|process(?:[-_/]\w+))\b/.test(lower)
}

function externalResearchOrApiLikeExecutionStep(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /\b(?:research|search|fetch|crawler|crawl|scrape|api|client)\b/.test(lower)
}

function reportBuilderLikeExecutionStep(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /\b(?:assembly|assemble|report builder|reportbuilder|extractor|extract)\b/.test(lower)
}

function scoringLikeExecutionStep(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /\b(?:score|scoring|metric|metrics)\b/.test(lower)
}

function qualityGateLikeExecutionStep(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /\b(?:quality(?:\s|-)?gate|guardrail|validate(?:report|output))\b/.test(lower)
}

function failureHandlingLikeExecutionStep(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /\b(?:fail(?:s|ed|ure|ures|ing)?|error|exception|fallback|dead(?:\s|-)?letter|write(?:raw|failure)|rawfailure)\b/.test(lower)
    || /(?:^|[.#])(?:handle|write|store|record)[A-Za-z_$\w]*(?:fail|failure|error|exception|raw)[A-Za-z_$\w]*\(?\)?$/i.test(node.label)
}

function rendererOrSynthesisLikeExecutionStep(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /\b(?:renderer|render|synthesis|synthesizer)\b/.test(lower)
}

function notificationOrEventLikeExecutionStep(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /\b(?:notify|notification|webhook|publish|emit|event|broadcast|deliver|delivery|channel|email|sms|push|analytics)\b/.test(lower)
    || /(?:^|[.#])(?:send|deliver|dispatch|publish|emit|broadcast|notify|track)[A-Za-z_$\w]*\(?\)?$/i.test(node.label)
}

function lowValueExecutionStep(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /\b(?:logger|log|status|getstatus|get|list|health|validate|validator|suggest|guard|interceptor|swagger|spec|test|env|config)\b/.test(lower)
    || /(?:^|[.#])(?:get|list|status|validate|suggest)[A-Za-z_$\w]*\(?\)?$/i.test(node.label)
    || /^process\(\)$/i.test(node.label)
    || /^\.add\(\)$/i.test(node.label)
}

function lowValueExecutionStepForQuestion(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
  question: string,
): boolean {
  if (promptWantsAuthGuardPhase(question) && authGuardLikeExecutionStep(node)) {
    return false
  }
  if (promptWantsValidationPhase(question) && validationLikeExecutionStep(node)) {
    return false
  }
  return lowValueExecutionStep(node)
}

function terminalBoundaryExecutionStep(
  node: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): boolean {
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /(?:^|[.#])(?:cancel|claim|status|get|list|retry)[A-Za-z_$\w]*\(?\)?$/i.test(node.label)
    || /\b(?:cancel|claim|status)\b/.test(lower)
    || /(?:^|[.#])(?:redirect|rewrite|respond)[A-Za-z_$\w]*\(?\)?$/i.test(node.label)
    || /\b(?:redirect|rewrite|response)\b/.test(lower)
}

function executionPhasesForStep(step: ContextPackExecutionSliceStep): Set<ExecutionPhase> {
  const phases = new Set<ExecutionPhase>()
  if (controllerLikeExecutionStep(step)) phases.add('controller')
  if (authGuardLikeExecutionStep(step)) phases.add('auth_guard')
  if (validationLikeExecutionStep(step)) phases.add('validation')
  if (serviceLikeExecutionStep(step)) phases.add('service')
  if (orchestratorLikeExecutionStep(step)) phases.add('orchestrator')
  if (plannerLikeExecutionStep(step)) phases.add('planner')
  if (queueLikeExecutionStep(step)) phases.add('queue')
  if (workerLikeExecutionStep(step)) phases.add('worker')
  if (externalResearchOrApiLikeExecutionStep(step)) phases.add('external_research_or_api')
  if (reportBuilderLikeExecutionStep(step)) phases.add('report_builder')
  if (scoringLikeExecutionStep(step)) phases.add('scoring')
  if (qualityGateLikeExecutionStep(step)) phases.add('quality_gate')
  if (rendererOrSynthesisLikeExecutionStep(step)) phases.add('renderer_or_synthesis')
  if (persistenceLikeExecutionStep(step)) phases.add('persistence')
  if (notificationOrEventLikeExecutionStep(step)) phases.add('notification_or_event')
  return phases
}

function executionPhaseOrder(question: string): ExecutionPhase[] {
  const enabled = new Set<ExecutionPhase>(['controller', 'service', 'queue', 'worker', 'persistence'])
  if (promptWantsAuthGuardPhase(question)) enabled.add('auth_guard')
  if (promptWantsValidationPhase(question)) enabled.add('validation')
  if (promptWantsDetailedReportGenerationPhases(question)) {
    enabled.add('orchestrator')
    enabled.add('planner')
    enabled.add('external_research_or_api')
    enabled.add('report_builder')
    enabled.add('scoring')
    enabled.add('quality_gate')
    enabled.add('renderer_or_synthesis')
  }
  if (promptWantsNotificationOrEventPhase(question)) enabled.add('notification_or_event')

  const phaseOrder: ExecutionPhase[] = [
    'controller',
    'auth_guard',
    'validation',
    'service',
    'orchestrator',
    'planner',
    'queue',
    'worker',
    'external_research_or_api',
    'report_builder',
    'scoring',
    'quality_gate',
    'renderer_or_synthesis',
    'persistence',
    'notification_or_event',
  ]
  return phaseOrder.filter((phase) => enabled.has(phase))
}

function scopeHasExecutionPhase(
  steps: readonly ContextPackExecutionSliceStep[],
  phase: ExecutionPhase,
): boolean {
  return steps.some((step) => executionPhasesForStep(step).has(phase))
}

function expectedExecutionPhases(
  question: string,
  scopeSteps: readonly ContextPackExecutionSliceStep[] = [],
): ExecutionPhase[] {
  const phases: ExecutionPhase[] = []
  if (promptWantsControllerStep(question)) {
    phases.push('controller')
  }
  if (promptWantsAuthGuardPhase(question)) {
    phases.push('auth_guard')
  }
  if (promptWantsValidationPhase(question)) {
    phases.push('validation')
  }
  if (promptWantsServiceStep(question)) {
    phases.push('service')
  }
  if (promptWantsDetailedReportGenerationPhases(question)) {
    if (scopeHasExecutionPhase(scopeSteps, 'orchestrator')) phases.push('orchestrator')
    if (scopeHasExecutionPhase(scopeSteps, 'planner')) phases.push('planner')
    if (scopeHasExecutionPhase(scopeSteps, 'external_research_or_api')) phases.push('external_research_or_api')
    if (scopeHasExecutionPhase(scopeSteps, 'report_builder')) phases.push('report_builder')
    if (scopeHasExecutionPhase(scopeSteps, 'scoring')) phases.push('scoring')
    if (scopeHasExecutionPhase(scopeSteps, 'quality_gate')) phases.push('quality_gate')
    if (scopeHasExecutionPhase(scopeSteps, 'renderer_or_synthesis')) phases.push('renderer_or_synthesis')
    if (scopeHasExecutionPhase(scopeSteps, 'persistence')) phases.push('persistence')
  }
  const scopeHasRuntimeHandoff = scopeHasExecutionPhase(scopeSteps, 'queue') || scopeHasExecutionPhase(scopeSteps, 'worker')
  if (
    promptExplicitlyWantsRuntimeHandoff(question)
    || (!promptWantsDetailedReportGenerationPhases(question) && promptWantsRuntimePipeline(question) && scopeHasRuntimeHandoff)
  ) {
    phases.push('queue', 'worker')
  }
  if (promptExpectsPersistenceStep(question)) {
    phases.push('persistence')
  }
  if (promptWantsNotificationOrEventPhase(question)) {
    phases.push('notification_or_event')
  }
  return [...new Set(phases)]
}

function missingExecutionPhaseBoundaryReason(phase: ExecutionPhase): string {
  switch (phase) {
    case 'auth_guard':
      return 'missing expected auth guard phase'
    case 'validation':
      return 'missing expected validation phase'
    case 'orchestrator':
      return 'missing expected orchestrator phase'
    case 'planner':
      return 'missing expected planner phase'
    case 'worker':
      return 'missing expected worker phase'
    case 'external_research_or_api':
      return 'missing expected external research or API phase'
    case 'report_builder':
      return 'missing expected report builder phase'
    case 'scoring':
      return 'missing expected scoring phase'
    case 'quality_gate':
      return 'missing expected quality gate phase'
    case 'renderer_or_synthesis':
      return 'missing expected renderer or synthesis phase'
    case 'persistence':
      return 'missing expected persistence phase'
    case 'notification_or_event':
      return 'missing expected notification or event phase'
    case 'queue':
      return 'missing expected queue phase'
    case 'service':
      return 'missing expected service phase'
    case 'controller':
    default:
      return 'missing expected controller phase'
  }
}

function executionFlowAdjacency(
  graph: KnowledgeGraph,
  sliceMetadata: ContextPackSliceMetadata,
  idSet: ReadonlySet<string>,
  question: string,
  resolveNodeId: (nodeId: string | undefined, label: string) => string | undefined,
): Map<string, ExecutionFlowEdge[]> {
  const adjacency = new Map<string, ExecutionFlowEdge[]>()
  const normalizedEdges = new Map<string, ExecutionFlowEdge>()
  const selectedFlowEdges = new Set<string>()
  const stepCache = new Map<string, ContextPackExecutionSliceStep>()
  const stepFor = (nodeId: string): ContextPackExecutionSliceStep => {
    const cached = stepCache.get(nodeId)
    if (cached) {
      return cached
    }
    const step = executionSliceStepFromGraph(graph, nodeId)
    stepCache.set(nodeId, step)
    return step
  }
  const orientationScore = (edge: ExecutionFlowEdge): number => {
    const fromStep = stepFor(edge.fromId)
    const toStep = stepFor(edge.toId)
    const fromTerminal = terminalBoundaryExecutionStep(fromStep)
    const toTerminal = terminalBoundaryExecutionStep(toStep)
    const phaseRankFor = (step: ContextPackExecutionSliceStep): number => {
      if (controllerLikeExecutionStep(step)) return 0
      if (authGuardLikeExecutionStep(step)) return 1
      if (validationLikeExecutionStep(step)) return 2
      if (orchestratorLikeExecutionStep(step)) return 4
      if (plannerLikeExecutionStep(step)) return 5
      if (queueLikeExecutionStep(step)) return 6
      if (workerLikeExecutionStep(step)) return 7
      if (externalResearchOrApiLikeExecutionStep(step)) return 8
      if (reportBuilderLikeExecutionStep(step)) return 9
      if (scoringLikeExecutionStep(step)) return 10
      if (qualityGateLikeExecutionStep(step) || failureHandlingLikeExecutionStep(step)) return 11
      if (rendererOrSynthesisLikeExecutionStep(step)) return 12
      if (persistenceLikeExecutionStep(step)) return 13
      if (notificationOrEventLikeExecutionStep(step)) return 14
      if (serviceLikeExecutionStep(step)) return 3
      return 15
    }
    const fromPhaseRank = phaseRankFor(fromStep)
    const toPhaseRank = phaseRankFor(toStep)
    const phaseProgressionWeight = edge.relation === 'calls'
      ? 420
      : edge.relation === 'controller_route' || edge.relation === 'route_handler'
      ? 220
      : 0
    const phaseProgressionBias = phaseProgressionWeight > 0
      ? (fromPhaseRank < toPhaseRank ? phaseProgressionWeight : fromPhaseRank > toPhaseRank ? -phaseProgressionWeight : 0)
      : 0
    const enqueueForwardBias = edge.relation === 'enqueues_job'
      ? (workerLikeExecutionStep(toStep) ? 220 : 0)
        - (workerLikeExecutionStep(fromStep) ? 220 : 0)
        + ((queueLikeExecutionStep(fromStep) || serviceLikeExecutionStep(fromStep) || controllerLikeExecutionStep(fromStep)) ? 90 : 0)
        - ((queueLikeExecutionStep(toStep) || serviceLikeExecutionStep(toStep) || controllerLikeExecutionStep(toStep)) ? 45 : 0)
      : 0
    return executionSliceStepPriority(fromStep, question)
      - executionSliceStepPriority(toStep, question)
      + (controllerLikeExecutionStep(fromStep) ? 18 : 0)
      - (controllerLikeExecutionStep(toStep) ? 8 : 0)
      + (toTerminal && !fromTerminal ? 160 : 0)
      - (fromTerminal && !toTerminal ? 160 : 0)
      - (fromTerminal ? 10 : 0)
      + (toTerminal ? 14 : 0)
      + phaseProgressionBias
      + enqueueForwardBias
  }
  const record = (edge: ExecutionFlowEdge): void => {
    const pairKey = edge.fromId < edge.toId
      ? `${edge.fromId}:${edge.relation}:${edge.toId}`
      : `${edge.toId}:${edge.relation}:${edge.fromId}`
    const existing = normalizedEdges.get(pairKey)
    if (!existing) {
      normalizedEdges.set(pairKey, edge)
      return
    }
    if (existing.fromId === edge.fromId && existing.toId === edge.toId) {
      return
    }
    const edgeScore = orientationScore(edge)
    const existingScore = orientationScore(existing)
    if (
      edgeScore > existingScore
      || (edgeScore === existingScore
        && compareStableText(`${edge.fromId}:${edge.toId}`, `${existing.fromId}:${existing.toId}`) < 0)
    ) {
      normalizedEdges.set(pairKey, edge)
    }
  }

  for (const path of sliceMetadata.selected_paths) {
    if (!executionSliceFlowRelation(path.relation)) {
      continue
    }
    const fromId = resolveNodeId(path.from_id, path.from)
    const toId = resolveNodeId(path.to_id, path.to)
    if (!fromId || !toId || !idSet.has(fromId) || !idSet.has(toId)) {
      continue
    }
    const forwardExists = graph.successors(fromId).includes(toId)
    const reverseExists = graph.successors(toId).includes(fromId)
    const normalizedFromId = !forwardExists && reverseExists ? toId : fromId
    const normalizedToId = !forwardExists && reverseExists ? fromId : toId
    const relation = String(
      (graph.successors(normalizedFromId).includes(normalizedToId)
        ? graph.edgeAttributes(normalizedFromId, normalizedToId).relation
        : undefined)
      ?? path.relation,
    )
    record({ fromId: normalizedFromId, toId: normalizedToId, relation })
    selectedFlowEdges.add(`${normalizedFromId}:${relation}:${normalizedToId}`)
  }

  if (promptWantsAuthGuardPhase(question) || promptWantsValidationPhase(question)) {
    const helperRelations = new Set(['uses_guard', 'guarded_by', 'calls'])
    const wantsRequestedHelper = (nodeId: string): boolean => {
      const attributes = graph.nodeAttributes(nodeId)
      const step = {
        label: String(attributes.label ?? nodeId),
        source_file: String(attributes.source_file ?? ''),
        ...(typeof attributes.node_kind === 'string' ? { node_kind: attributes.node_kind } : {}),
        ...(typeof attributes.framework_role === 'string' ? { framework_role: attributes.framework_role } : {}),
      }
      return (promptWantsAuthGuardPhase(question) && authGuardLikeExecutionStep(step))
        || (promptWantsValidationPhase(question) && validationLikeExecutionStep(step))
    }

    for (const fromId of idSet) {
      for (const toId of graph.successors(fromId)) {
        if (!idSet.has(toId)) {
          continue
        }
        const relation = String(graph.edgeAttributes(fromId, toId).relation ?? 'related_to')
        if (helperRelations.has(relation) && wantsRequestedHelper(toId)) {
          record({ fromId, toId, relation })
        }
      }
    }
  }

  for (const fromId of idSet) {
    for (const toId of graph.successors(fromId)) {
      if (!idSet.has(toId)) {
        continue
      }
      const relation = String(graph.edgeAttributes(fromId, toId).relation ?? 'related_to')
      if (!executionSliceFlowRelation(relation)) {
        continue
      }
      if (
        selectedFlowEdges.has(`${fromId}:${relation}:${toId}`)
        || selectedFlowEdges.has(`${toId}:${relation}:${fromId}`)
      ) {
        continue
      }
      record({ fromId, toId, relation })
    }
  }

  for (const edge of normalizedEdges.values()) {
    const current = adjacency.get(edge.fromId) ?? []
    current.push(edge)
    adjacency.set(edge.fromId, current)
  }

  for (const edges of adjacency.values()) {
    edges.sort((left, right) =>
      orientationScore(right) - orientationScore(left)
      || compareStableText(`${left.fromId}:${left.toId}`, `${right.fromId}:${right.toId}`)
    )
  }

  return adjacency
}

function enumerateExecutionPaths(
  adjacency: ReadonlyMap<string, ExecutionFlowEdge[]>,
  startId: string,
  blockedIds: ReadonlySet<string> = new Set(),
  maxDepth: number = 8,
): ExecutionPathCandidate[] {
  const visit = (
    currentId: string,
    visited: Set<string>,
    nodeIds: string[],
    edges: ExecutionFlowEdge[],
  ): ExecutionPathCandidate[] => {
    const partial = [{ nodeIds, edges }]
    if (edges.length >= maxDepth) {
      return partial
    }

    const candidates = (adjacency.get(currentId) ?? [])
      .filter((edge) => !visited.has(edge.toId) && !blockedIds.has(edge.toId))
    if (candidates.length === 0) {
      return partial
    }

    return [
      ...partial,
      ...candidates.flatMap((edge) => {
      const nextVisited = new Set(visited)
      nextVisited.add(edge.toId)
      return visit(edge.toId, nextVisited, [...nodeIds, edge.toId], [...edges, edge])
      }),
    ]
  }

  return visit(startId, new Set([startId]), [startId], [])
}

function executionPathScore(
  path: ExecutionPathCandidate,
  nodeById: ReadonlyMap<string, ContextPackExecutionSliceStep>,
  question: string,
): number {
  const steps = path.nodeIds
    .map((nodeId) => nodeById.get(nodeId))
    .filter((step): step is ContextPackExecutionSliceStep => step !== undefined)
  const observedPhases = new Set<ExecutionPhase>()
  for (const step of steps) {
    for (const phase of executionPhasesForStep(step)) {
      observedPhases.add(phase)
    }
  }

  let score = steps.reduce((total, step) => total + executionSliceStepPriority(step, question), 0)
  if (observedPhases.has('controller')) score += 10
  if (observedPhases.has('service')) score += 20
  if (observedPhases.has('queue')) score += 35
  if (observedPhases.has('worker')) score += 45
  if (observedPhases.has('persistence')) score += 90
  if (path.edges.some((edge) => edge.relation === 'enqueues_job')) score += 30

  if (promptExpectsPersistenceStep(question) && !observedPhases.has('persistence')) {
    score -= 120
  }
  if (promptWantsRuntimePipeline(question) && observedPhases.has('queue') && !observedPhases.has('worker')) {
    score -= 60
  }

  const lastStep = steps.at(-1)
  const lastStepPhases = lastStep ? executionPhasesForStep(lastStep) : new Set<ExecutionPhase>()
  if (
    promptExpectsPersistenceStep(question)
    && observedPhases.has('worker')
    && !observedPhases.has('persistence')
    && lastStep
    && !lastStepPhases.has('worker')
    && !lastStepPhases.has('persistence')
  ) {
    score -= 35
  }
  if (lastStep && terminalBoundaryExecutionStep(lastStep)) {
    score -= 15
  }
  if (lastStep && lowValueExecutionStepForQuestion(lastStep, question)) {
    score -= 40
  }

  return score + path.edges.length
}

function primaryPathBoundaries(
  path: ExecutionPathCandidate,
  nodeById: ReadonlyMap<string, ContextPackExecutionSliceStep>,
): ContextPackExecutionSliceBoundary[] {
  return path.edges
    .filter((edge) => edge.relation === 'enqueues_job')
    .map((edge) => {
      const from = nodeById.get(edge.fromId)?.label
      const to = nodeById.get(edge.toId)?.label
      return {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        relation: edge.relation,
      }
    })
}

function phaseCoverageForPath(
  steps: readonly ContextPackExecutionSliceStep[],
  boundaries: readonly ContextPackExecutionSliceBoundary[],
  question: string,
  scopeSteps: readonly ContextPackExecutionSliceStep[] = steps,
  tracedSteps: readonly ContextPackExecutionSliceStep[] = steps,
): { expected: ExecutionPhase[]; observed: ExecutionPhase[]; missing: ExecutionPhase[] } {
  const phaseOrder = executionPhaseOrder(question)
  const expandedTaxonomy = promptUsesExpandedExecutionTaxonomy(question)
  const expectedSourceSteps = expandedTaxonomy ? scopeSteps : steps
  const observedSourceSteps = expandedTaxonomy ? tracedSteps : steps
  const expected = expectedExecutionPhases(question, expectedSourceSteps)
  const observed = new Set<ExecutionPhase>()
  for (const step of observedSourceSteps) {
    for (const phase of executionPhasesForStep(step)) {
      if (phaseOrder.includes(phase)) {
        observed.add(phase)
      }
    }
  }
  if (boundaries.some((boundary) => boundary.relation === 'enqueues_job')) {
    observed.add('queue')
    if (observedSourceSteps.some((step) => workerLikeExecutionStep(step))) {
      observed.add('worker')
    }
  }
  const orderedObserved = phaseOrder.filter((phase) => observed.has(phase))
  const missing = expected.filter((phase) => !observed.has(phase))
  return { expected, observed: orderedObserved, missing }
}

function branchBoundaryReason(
  branchSteps: readonly ContextPackExecutionSliceStep[],
  kind: 'side_effect' | 'terminal' | 'omitted',
  question: string,
): string | undefined {
  if (kind === 'terminal') {
    return 'branch terminates before rejoining the primary runtime path'
  }
  if (kind === 'omitted') {
    return 'low-value branch omitted from compact execution slice'
  }
  if (branchSteps.some((step) => lowValueExecutionStepForQuestion(step, question))) {
    return 'secondary branch summarized to preserve compact output'
  }
  return undefined
}

function classifyExecutionBranch(
  branchSteps: readonly ContextPackExecutionSliceStep[],
  question: string,
): 'side_effect' | 'terminal' | 'omitted' {
  if (branchSteps.length === 0 || branchSteps.every((step) => lowValueExecutionStepForQuestion(step, question))) {
    return 'omitted'
  }
  if (terminalBoundaryExecutionStep(branchSteps.at(-1) ?? branchSteps[0]!)) {
    return 'terminal'
  }
  return 'side_effect'
}

function collectExecutionBranches(
  adjacency: ReadonlyMap<string, ExecutionFlowEdge[]>,
  primaryPath: ExecutionPathCandidate,
  nodeById: ReadonlyMap<string, ContextPackExecutionSliceStep>,
  question: string,
): {
  sideEffects: ContextPackExecutionSliceBranch[]
  terminalBoundaries: ContextPackExecutionSliceBranch[]
  omittedBranches: ContextPackExecutionSliceOmittedBranch[]
  omittedEvidenceSteps: ContextPackExecutionSliceStep[]
} {
  const primaryEdgeKeys = new Set(primaryPath.edges.map((edge) => `${edge.fromId}:${edge.relation}:${edge.toId}`))
  const primaryNodeIds = new Set(primaryPath.nodeIds)
  const branchStartSeen = new Set<string>()
  const sideEffects: ContextPackExecutionSliceBranch[] = []
  const terminalBoundaries: ContextPackExecutionSliceBranch[] = []
  const omittedBranches: ContextPackExecutionSliceOmittedBranch[] = []
  const omittedEvidenceSteps: ContextPackExecutionSliceStep[] = []
  const branchScoreCache = new Map<ExecutionPathCandidate, number>()
  const branchScoreFor = (path: ExecutionPathCandidate): number => {
    const cached = branchScoreCache.get(path)
    if (cached !== undefined) {
      return cached
    }
    const score = executionPathScore(path, nodeById, question)
    branchScoreCache.set(path, score)
    return score
  }
  interface RankedExecutionBranch {
    edge: ExecutionFlowEdge
    steps: ContextPackExecutionSliceStep[]
    kind: 'side_effect' | 'terminal' | 'omitted'
    reason?: string
  }
  const rankedBranches: RankedExecutionBranch[] = []

  for (const nodeId of primaryPath.nodeIds) {
    for (const edge of adjacency.get(nodeId) ?? []) {
      const edgeKey = `${edge.fromId}:${edge.relation}:${edge.toId}`
      if (primaryEdgeKeys.has(edgeKey) || branchStartSeen.has(edgeKey)) {
        continue
      }
      branchStartSeen.add(edgeKey)

      const branchCandidates = enumerateExecutionPaths(adjacency, edge.toId, primaryNodeIds, 4)
      const branchPath = branchCandidates.sort((left, right) => {
        return branchScoreFor(right) - branchScoreFor(left)
          || compareStableText(left.nodeIds.join('>'), right.nodeIds.join('>'))
      })[0] ?? { nodeIds: [edge.toId], edges: [] }
      const branchSteps = branchPath.nodeIds
        .map((id) => nodeById.get(id))
        .filter((step): step is ContextPackExecutionSliceStep => step !== undefined)
        .slice(0, 3)
      const branchKind = classifyExecutionBranch(branchSteps, question)
      const branchReason = branchBoundaryReason(branchSteps, branchKind, question)
      rankedBranches.push({
        edge,
        steps: branchSteps,
        kind: branchKind,
        ...(branchReason ? { reason: branchReason } : {}),
      })
    }
  }

  const sideEffectBranches = rankedBranches
    .filter((branch) => branch.kind === 'side_effect')
  const terminalBranches = rankedBranches
    .filter((branch) => branch.kind === 'terminal')

  for (const branch of sideEffectBranches.slice(0, 3)) {
    sideEffects.push({
      steps: branch.steps,
      ...(branch.reason ? { boundary_reason: branch.reason } : {}),
    })
  }
  for (const branch of terminalBranches.slice(0, 3)) {
    terminalBoundaries.push({
      steps: branch.steps,
      ...(branch.reason ? { boundary_reason: branch.reason } : {}),
    })
  }

  const omittedCandidates = [
    ...sideEffectBranches.slice(3),
    ...terminalBranches.slice(3),
    ...rankedBranches.filter((branch) => branch.kind === 'omitted'),
  ]
  for (const branch of omittedCandidates.slice(0, 6)) {
    omittedEvidenceSteps.push(...branch.steps)
    const from = nodeById.get(branch.edge.fromId)?.label
    const to = nodeById.get(branch.edge.toId)?.label
    omittedBranches.push({
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      relation: branch.edge.relation,
      ...(branch.reason ? { reason: branch.reason } : {}),
    })
  }

  return { sideEffects, terminalBoundaries, omittedBranches, omittedEvidenceSteps }
}

function pickExecutionSliceStart(
  adjacency: ReadonlyMap<string, readonly ExecutionFlowEdge[]>,
  anchorIds: readonly string[],
  orderedIds: readonly string[],
  idSet: ReadonlySet<string>,
  nodeById: ReadonlyMap<string, ContextPackExecutionSliceStep>,
  question: string,
): string | undefined {
  const incomingEdgeCounts = new Map<string, number>()
  for (const edges of adjacency.values()) {
    for (const edge of edges) {
      if (!idSet.has(edge.toId)) {
        continue
      }
      incomingEdgeCounts.set(edge.toId, (incomingEdgeCounts.get(edge.toId) ?? 0) + 1)
    }
  }

  const anchoredStart = anchorIds.find((nodeId) => idSet.has(nodeId))
  if (anchoredStart) {
    return anchoredStart
  }

  const roots = orderedIds.filter((nodeId) => (incomingEdgeCounts.get(nodeId) ?? 0) === 0)
  const candidates = roots.length > 0 ? roots : orderedIds

  return [...candidates].sort((left, right) => {
    const leftStep = nodeById.get(left)
    const rightStep = nodeById.get(right)
    return (rightStep ? executionSliceStepPriority(rightStep, question) : 0)
      - (leftStep ? executionSliceStepPriority(leftStep, question) : 0)
  })[0]
}

function walkExecutionSlice(
  graph: KnowledgeGraph,
  startId: string,
  idSet: ReadonlySet<string>,
  nodeById: ReadonlyMap<string, ContextPackExecutionSliceStep>,
  question: string,
): string[] {
  const orderedPathIds: string[] = []
  const seen = new Set<string>()
  let currentId: string | undefined = startId

  while (currentId && !seen.has(currentId)) {
    orderedPathIds.push(currentId)
    seen.add(currentId)

    const nextId: string | undefined = [...graph.successors(currentId)]
      .filter((candidateId) =>
        idSet.has(candidateId)
        && !seen.has(candidateId)
        && executionSliceFlowRelation(String(graph.edgeAttributes(currentId!, candidateId).relation ?? 'related_to')),
      )
      .sort((left, right) => {
        const leftRelation = String(graph.edgeAttributes(currentId!, left).relation ?? 'related_to')
        const rightRelation = String(graph.edgeAttributes(currentId!, right).relation ?? 'related_to')
        const leftStep = nodeById.get(left)
        const rightStep = nodeById.get(right)
        return executionSliceEdgePriority(rightRelation) - executionSliceEdgePriority(leftRelation)
          || (rightStep ? executionSliceStepPriority(rightStep, question) : 0)
          - (leftStep ? executionSliceStepPriority(leftStep, question) : 0)
      })[0]

    currentId = nextId
  }

  return orderedPathIds
}

function runtimeGenerationAnswerContractWantsReportGenerationCore(question: string): boolean {
  return /\b(?:report(?:\s+generation)?|generated\s+report|validation\s+report|final\s+report|assembly|assemble|synthesis|renderer|render|planner|research|metrics?|scor(?:e|ing)|quality(?:\s|-)?gate)\b/i.test(question)
}

function runtimeGenerationStepText(
  value: Pick<ContextPackExecutionSliceStep, 'label' | 'source_file' | 'node_kind' | 'framework_role'>,
): string {
  return `${value.label} ${value.source_file} ${value.node_kind ?? ''} ${value.framework_role ?? ''}`.toLowerCase()
}

function runtimeGenerationContractPhaseElements(
  question: string,
  matchedNodes: readonly Pick<RetrieveMatchedNode, 'label' | 'source_file' | 'node_kind' | 'framework_role'>[],
  executionSlice: ContextPackExecutionSlice,
): string[] {
  const elements = new Set<string>(['main_pipeline_phases'])
  const evidenceText = [
    ...matchedNodes.map((node) =>
      `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase(),
    ),
    ...executionSlice.steps.map(runtimeGenerationStepText),
  ].join('\n')

  if (
    executionSlice.primary_path?.boundaries?.some((boundary) => boundary.relation === 'enqueues_job')
  ) {
    elements.add('queue_worker_handoff')
  }

  if (
    executionSlice.phase_coverage?.observed.includes('persistence')
    || executionSlice.phase_coverage?.missing.includes('persistence')
    || /\b(?:persist|repository|database|db|storage|store|save|write|artifact)\b/i.test(evidenceText)
  ) {
    elements.add('persistence_or_artifact_storage')
  }

  if (executionSlice.status === 'partial') {
    elements.add('missing_or_uncertain_phases')
  }

  if (runtimeGenerationAnswerContractWantsReportGenerationCore(question)) {
    if (/\b(?:planner|\.plan\(|plan\(\)|planning)\b/i.test(evidenceText)) {
      elements.add('planner_phase')
    }
    if (/\b(?:research|search\(\)|processsection|processsection\(\)|section[-_\s]?research)\b/i.test(evidenceText)) {
      elements.add('research_phase')
    }
    if (/\b(?:assembly|assemble|synthesis)\b/i.test(evidenceText)) {
      elements.add('assembly_phase')
    }
    if (/\b(?:score|scoring|metrics?)\b/i.test(evidenceText)) {
      elements.add('scoring_phase')
    }
    if (/\b(?:render|renderer|report builder|reportbuilder|final report)\b/i.test(evidenceText)) {
      elements.add('report_builder_phase')
    }
  }

  return [...elements]
}

function buildExecutionSliceConfidence(
  sliceMetadata: ContextPackSliceMetadata,
  question: string,
  executionSlice: Pick<ContextPackExecutionSlice, 'status' | 'phase_coverage' | 'primary_path' | 'steps' | 'omitted_branches'>,
): Pick<ContextPackExecutionSlice, 'confidence' | 'confidence_reasons'> | undefined {
  const explicitAnchor = sliceMetadata.anchors.some((anchor) =>
    anchor.reason === 'symbol mention'
    || anchor.reason === 'path mention'
    || methodLikeLabel(anchor.label)
    || containsUrlLikeRoutePath(anchor.label)
    || /\b(?:controller|route|handler|endpoint)\b/i.test(anchor.label),
  )
  const runtimeHandoff = executionSlice.primary_path?.boundaries?.some((boundary) => boundary.relation === 'enqueues_job')
  const missingPhases = executionSlice.phase_coverage?.missing ?? []
  const expectedPhasesCovered = missingPhases.length === 0
  const primaryPathSteps = executionSlice.primary_path?.steps ?? executionSlice.steps
  const observedPhases = new Set(executionSlice.phase_coverage?.observed ?? [])
  const hasEntrypoint =
    observedPhases.has('controller')
    || primaryPathSteps.some((step) => /\b(?:route|controller|handler|endpoint)\b/i.test(`${step.label} ${step.framework_role ?? ''} ${step.node_kind ?? ''}`))
  const hasOrchestration =
    runtimeHandoff
    || observedPhases.has('service')
    || observedPhases.has('orchestrator')
    || observedPhases.has('planner')
    || observedPhases.has('queue')
    || observedPhases.has('worker')
  const hasTerminalEffect =
    observedPhases.has('persistence')
    || observedPhases.has('notification_or_event')
    || observedPhases.has('renderer_or_synthesis')
    || observedPhases.has('report_builder')
    || observedPhases.has('quality_gate')
    || observedPhases.has('scoring')
  const missingRuntimeHandoffForPipeline =
    !runtimeHandoff
    && promptWantsRuntimePipeline(question)
    && !hasTerminalEffect
  const lowValuePrimaryPath = primaryPathSteps.length > 0
    && primaryPathSteps.filter((step) => lowValueExecutionStepForQuestion(step, question)).length >= Math.ceil(primaryPathSteps.length / 2)

  if (
    explicitAnchor
    && hasEntrypoint
    && hasOrchestration
    && hasTerminalEffect
    && executionSlice.status === 'complete'
    && expectedPhasesCovered
  ) {
    return {
      confidence: 'high',
      confidence_reasons: [
        'explicit_anchor',
        ...(runtimeHandoff ? ['runtime_handoff_evidence'] : ['orchestration_evidence']),
        'expected_phases_covered',
        'terminal_effect_evidence',
      ],
    }
  }

  if (hasOrchestration && missingPhases.length === 1) {
    return {
      confidence: 'medium',
      confidence_reasons: [
        ...(runtimeHandoff ? ['runtime_handoff_evidence'] : ['orchestration_evidence']),
        `missing_phase:${missingPhases[0]}`,
      ],
    }
  }

  const lowConfidenceReasons = [
    ...(!hasOrchestration ? ['missing_orchestration'] : []),
    ...(missingRuntimeHandoffForPipeline || (!runtimeHandoff && promptExplicitlyWantsRuntimeHandoff(question)) ? ['no_runtime_handoff'] : []),
    ...missingPhases.map((phase) => `missing_phase:${phase}`),
    ...((executionSlice.omitted_branches?.length ?? 0) >= 2 ? ['multiple_omitted_branches'] : []),
    ...(lowValuePrimaryPath ? ['low_value_primary_path'] : []),
  ]
  if (lowConfidenceReasons.length > 0) {
    return {
      confidence: 'low',
      confidence_reasons: lowConfidenceReasons,
    }
  }

  return {
    confidence: 'medium',
    confidence_reasons: ['partial_runtime_path'],
  }
}

function executionSliceAnswerContractConfidence(
  executionSlice: ContextPackExecutionSlice,
): ContextPackRuntimeGenerationAnswerContract['confidence'] | undefined {
  const value = (executionSlice as { confidence?: unknown }).confidence
  return value === 'high' || value === 'medium' || value === 'low' ? value : undefined
}

function buildRuntimeGenerationAnswerContract(
  taskContract: ContextPackTaskContract,
  retrievalGate: RetrievalGateDecision,
  question: string,
  matchedNodes: readonly Pick<RetrieveMatchedNode, 'label' | 'source_file' | 'node_kind' | 'framework_role'>[],
  executionSlice: ContextPackExecutionSlice | undefined,
  sliceMetadata: ContextPackSliceMetadata | undefined,
): ContextPackRuntimeGenerationAnswerContract | undefined {
  if (!runtimeGenerationExecutionSliceApplies(taskContract, retrievalGate, sliceMetadata) || !executionSlice) {
    return undefined
  }

  const doNotClaim = new Set<string>([
    'direct_producer_to_worker_calls_without_enqueues_boundary',
    'irrelevant_model_or_provider_details',
  ])
  const missingPhases = [...(executionSlice.phase_coverage?.missing ?? [])]
  if (executionSlice.status === 'partial') {
    doNotClaim.add('full_runtime_certainty_when_slice_is_partial')
  }

  const answerContract: ContextPackRuntimeGenerationAnswerContract = {
    version: 1,
    answer_focus: 'runtime_generation',
    entrypoint_scope: 'setup_context',
    required_elements: runtimeGenerationContractPhaseElements(question, matchedNodes, executionSlice),
    do_not_claim: [...doNotClaim],
    observed_phases: [...(executionSlice.phase_coverage?.observed ?? [])],
    missing_phases: missingPhases,
  }

  if (executionSlice.status === 'partial' || missingPhases.length > 0) {
    answerContract.uncertainty_notes = [
      missingPhases.length > 0
        ? `Do not infer unobserved runtime phases; if the full flow is requested, answer: not enough evidence; missing ${missingPhases.join(', ')}`
        : 'Do not infer unobserved runtime phases; if the full flow is requested, answer: not enough evidence.',
    ]
  }

  const confidence = executionSliceAnswerContractConfidence(executionSlice)
  if (confidence) {
    answerContract.confidence = confidence
  }

  return answerContract
}

function buildExecutionSlice(
  graph: KnowledgeGraph,
  taskContract: ContextPackTaskContract,
  retrievalGate: RetrievalGateDecision,
  question: string,
  sliceMetadata: ContextPackSliceMetadata | undefined,
  rootPath?: string,
): ContextPackExecutionSlice | undefined {
  if (!runtimeGenerationExecutionSliceApplies(taskContract, retrievalGate, sliceMetadata) || !sliceMetadata) {
    return undefined
  }

  const executionSliceDebug = process.env.MADAR_DEBUG_EXECUTION_SLICE === '1'
  const logExecutionSliceDebug = (stage: string, payload: Record<string, unknown>): void => {
    if (!executionSliceDebug) {
      return
    }
    console.error(`[madar execution-slice] ${stage} ${JSON.stringify(payload)}`)
  }

  const nodeIdByLabel = new Map<string, string>()
  for (const [nodeId, attributes] of graph.nodeEntries()) {
    const label = String(attributes.label ?? nodeId)
    if (!nodeIdByLabel.has(label)) {
      nodeIdByLabel.set(label, nodeId)
    }
  }

  const resolveNodeId = (nodeId: string | undefined, label: string): string | undefined => {
    if (nodeId && graph.hasNode(nodeId)) {
      return nodeId
    }
    return nodeIdByLabel.get(label)
  }

  const anchorIds = sliceMetadata.anchors
    .map((anchor) => resolveNodeId(anchor.node_id, anchor.label))
    .filter((nodeId): nodeId is string => typeof nodeId === 'string')
  const scopeStart = Date.now()
  const { orderedIds, idSet } = collectExecutionSliceScope(graph, sliceMetadata, anchorIds, question, resolveNodeId)
  logExecutionSliceDebug('scope', {
    ms: Date.now() - scopeStart,
    anchors: anchorIds.length,
    ordered_ids: orderedIds.length,
    id_set: idSet.size,
  })
  if (orderedIds.length === 0) {
    return {
      status: 'partial',
      confidence: 'low',
      confidence_reasons: ['slice_missing_runtime_path', 'no_runtime_handoff'],
      boundary_reason: 'slice missing runtime path',
      steps: [],
    }
  }

  const nodeById = new Map(
    orderedIds
      .map((nodeId) => [nodeId, executionSliceStepFromGraph(graph, nodeId, rootPath)] as const),
  )
  const adjacencyStart = Date.now()
  const adjacency = executionFlowAdjacency(graph, sliceMetadata, idSet, question, resolveNodeId)
  logExecutionSliceDebug('adjacency', {
    ms: Date.now() - adjacencyStart,
    nodes: adjacency.size,
    edges: [...adjacency.values()].reduce((total, edges) => total + edges.length, 0),
  })
  const startPickStart = Date.now()
  const startId = pickExecutionSliceStart(adjacency, anchorIds, orderedIds, idSet, nodeById, question)
  logExecutionSliceDebug('start', {
    ms: Date.now() - startPickStart,
    start_id: startId ?? null,
  })
  if (!startId) {
    return {
      status: 'partial',
      confidence: 'low',
      confidence_reasons: ['slice_missing_runtime_path', 'no_runtime_handoff'],
      boundary_reason: 'slice missing runtime path',
      steps: [],
    }
  }

  const pathStart = Date.now()
  const pathCandidates = enumerateExecutionPaths(adjacency, startId)
  logExecutionSliceDebug('paths', {
    ms: Date.now() - pathStart,
    count: pathCandidates.length,
  })
  const primaryPathScoreCache = new Map<ExecutionPathCandidate, number>()
  const primaryPathScoreFor = (path: ExecutionPathCandidate): number => {
    const cached = primaryPathScoreCache.get(path)
    if (cached !== undefined) {
      return cached
    }
    const score = executionPathScore(path, nodeById, question)
    primaryPathScoreCache.set(path, score)
    return score
  }
  const primaryPathCandidates = pathCandidates.length > 0 ? pathCandidates : [{
    nodeIds: walkExecutionSlice(graph, startId, idSet, nodeById, question),
    edges: [] as ExecutionFlowEdge[],
  }]
  const primaryPath = primaryPathCandidates.sort((left, right) =>
    primaryPathScoreFor(right) - primaryPathScoreFor(left)
    || compareStableText(left.nodeIds.join('>'), right.nodeIds.join('>'))
  )[0]!

  const steps = primaryPath.nodeIds
    .map((nodeId) => nodeById.get(nodeId))
    .filter((step): step is ContextPackExecutionSliceStep => step !== undefined)
  const boundaries = primaryPathBoundaries(primaryPath, nodeById)
  const scopeSteps = orderedIds
    .map((nodeId) => nodeById.get(nodeId))
    .filter((step): step is ContextPackExecutionSliceStep => step !== undefined)
  const branchStart = Date.now()
  const branches = collectExecutionBranches(adjacency, primaryPath, nodeById, question)
  logExecutionSliceDebug('branches', {
    ms: Date.now() - branchStart,
    side_effects: branches.sideEffects.length,
    terminal_boundaries: branches.terminalBoundaries.length,
    omitted_branches: branches.omittedBranches.length,
  })
  const sideEffects = branches.sideEffects
  const terminalBoundaries = branches.terminalBoundaries
  const tracedSteps = [
    ...steps,
    ...sideEffects.flatMap((branch) => branch.steps),
    ...terminalBoundaries.flatMap((branch) => branch.steps),
    ...branches.omittedEvidenceSteps,
  ]
  const phaseCoverage = phaseCoverageForPath(steps, boundaries, question, scopeSteps, tracedSteps)
  const missingPhase = phaseCoverage.missing[0]
  const boundaryReason = missingPhase
    ? missingExecutionPhaseBoundaryReason(missingPhase)
    : undefined
  const executionSlice: ContextPackExecutionSlice = {
    status: missingPhase ? 'partial' : 'complete',
    ...(boundaryReason ? { boundary_reason: boundaryReason } : {}),
    steps,
    primary_path: {
      steps,
      ...(boundaries.length > 0 ? { boundaries } : {}),
      ...(boundaryReason ? { boundary_reason: boundaryReason } : {}),
    },
    ...(sideEffects.length > 0 ? { side_effects: sideEffects } : {}),
    ...(terminalBoundaries.length > 0 ? { terminal_boundaries: terminalBoundaries } : {}),
    ...(branches.omittedBranches.length > 0 ? { omitted_branches: branches.omittedBranches } : {}),
    phase_coverage: phaseCoverage,
  }

  return {
    ...executionSlice,
    ...(buildExecutionSliceConfidence(sliceMetadata, question, executionSlice) ?? {}),
  }
}

function compactExecutionSliceStep(step: ContextPackExecutionSliceStep): ContextPackExecutionSliceStep {
  return {
    label: step.label,
    source_file: basename(step.source_file),
    line_number: step.line_number,
  }
}

function compactExecutionSliceBranch(branch: ContextPackExecutionSliceBranch): ContextPackExecutionSliceBranch {
  return {
    steps: branch.steps.map(compactExecutionSliceStep),
    ...(branch.boundary_reason ? { boundary_reason: branch.boundary_reason } : {}),
  }
}

function compactExecutionSlice(executionSlice: ContextPackExecutionSlice | undefined): ContextPackExecutionSlice | undefined {
  if (!executionSlice) {
    return undefined
  }

  return {
    status: executionSlice.status,
    ...(executionSlice.confidence ? { confidence: executionSlice.confidence } : {}),
    ...(executionSlice.confidence_reasons ? { confidence_reasons: executionSlice.confidence_reasons } : {}),
    ...(executionSlice.boundary_reason ? { boundary_reason: executionSlice.boundary_reason } : {}),
    steps: executionSlice.steps.map(compactExecutionSliceStep),
    ...(executionSlice.primary_path
      ? {
          primary_path: {
            steps: executionSlice.primary_path.steps.map(compactExecutionSliceStep),
            ...(executionSlice.primary_path.boundaries ? { boundaries: executionSlice.primary_path.boundaries } : {}),
            ...(executionSlice.primary_path.boundary_reason ? { boundary_reason: executionSlice.primary_path.boundary_reason } : {}),
          },
        }
      : {}),
    ...(executionSlice.side_effects ? { side_effects: executionSlice.side_effects.map(compactExecutionSliceBranch) } : {}),
    ...(executionSlice.terminal_boundaries ? { terminal_boundaries: executionSlice.terminal_boundaries.map(compactExecutionSliceBranch) } : {}),
    ...(executionSlice.omitted_branches ? { omitted_branches: executionSlice.omitted_branches } : {}),
    ...(executionSlice.phase_coverage ? { phase_coverage: executionSlice.phase_coverage } : {}),
  }
}

function buildFrameworkQuestionProfile(question: string, questionTokens: readonly string[]): FrameworkQuestionProfile {
  const hasRoutePath = containsUrlLikeRoutePath(question)
  const hasRouteKeyword = includesAnyToken(questionTokens, ['route', 'routes', 'router', 'endpoint', 'endpoints'])
  const hasHttpVerb = hasHttpVerbIntent(question, questionTokens, hasRoutePath, hasRouteKeyword)
  const routeIntent = hasHttpVerb || hasRoutePath || hasRouteKeyword
  const explicitExpress = includesAnyToken(questionTokens, ['express'])
  const explicitRedux = includesAnyToken(questionTokens, ['redux', 'toolkit'])
  const explicitNest = includesAnyToken(questionTokens, ['nest', 'nestjs'])
  const explicitNext = includesAnyToken(questionTokens, ['next', 'nextjs'])
  const explicitRoutingControllers = /\brouting(?:\s|-)?controllers\b/i.test(question)
    || includesAnyToken(questionTokens, ['routingcontrollers'])
  // v0.19 — explicit mentions of the v0.17 substrates.
  const explicitHono = includesAnyToken(questionTokens, ['hono'])
  const explicitFastify = includesAnyToken(questionTokens, ['fastify'])
  const explicitTrpc = includesAnyToken(questionTokens, ['trpc', 'procedure', 'procedures'])
  const explicitPrisma = includesAnyToken(questionTokens, ['prisma'])
  const routerIntent = includesAnyToken(questionTokens, ['router', 'routers'])
  const resolverIntent = includesAnyToken(questionTokens, ['resolver', 'resolvers', 'graphql'])
  const pluginIntent = includesAnyToken(questionTokens, ['plugin', 'plugins'])
  const procedureIntent = includesAnyToken(questionTokens, ['procedure', 'procedures', 'rpc'])
  const queryIntent = includesAnyToken(questionTokens, ['query', 'queries'])
  const mutationIntent = includesAnyToken(questionTokens, ['mutation', 'mutations'])
  const subscriptionIntent = includesAnyToken(questionTokens, ['subscription', 'subscriptions', 'subscribe'])
  const modelIntent = includesAnyToken(questionTokens, ['model', 'models', 'schema', 'orm', 'database', 'db'])
  const persistenceIntent = /\bpersistence\s+boundar(?:y|ies)\b/i.test(question)
    || includesAnyToken(questionTokens, ['persistence', 'storage', 'persist', 'persisted', 'persisting'])
  const repositoryIntent = includesAnyToken(questionTokens, ['repository', 'repositories'])
  const storageReadIntent = queryIntent || includesAnyToken(questionTokens, ['read', 'reads'])
  const storageWriteIntent = mutationIntent || includesAnyToken(questionTokens, [
    'write',
    'writes',
    'save',
    'saves',
    'saved',
    'update',
    'updates',
    'updated',
    'upsert',
    'upserts',
    'persist',
    'persists',
    'persisted',
    'stored',
    'storing',
  ])
  const repositoryBoundaryIntent = repositoryIntent && (
    modelIntent
    || persistenceIntent
    || storageReadIntent
    || storageWriteIntent
  )
  const storageEndpointIntent =
    persistenceIntent
    || repositoryBoundaryIntent
    || (
      (storageReadIntent || storageWriteIntent)
      && (modelIntent || explicitPrisma || persistenceIntent || repositoryIntent)
    )
  const explicitNextText = /\bnext(?:\.js)?\b/i.test(question)
  const explicitNextPagesArtifact = /\b(_app|_document|not-found)\b/i.test(question)
  const mentionsReact = includesAnyToken(questionTokens, ['react'])
  const explicitReactRouter = /\breact(?:\s|-)?router\b/i.test(question)
  const middlewareIntent = includesAnyToken(questionTokens, ['middleware', 'guard'])
  const handlerIntent = includesAnyToken(questionTokens, ['handler', 'handlers'])
  const controllerIntent = includesAnyToken(questionTokens, ['controller', 'controllers'])
  const pageIntent = includesAnyToken(questionTokens, ['page', 'pages'])
  const layoutIntent = includesAnyToken(questionTokens, ['layout', 'layouts', 'template', 'templates', 'loading', 'error', 'document', 'default'])
  const clientIntent = includesAnyToken(questionTokens, ['client', 'browser'])
  const serverIntent = includesAnyToken(questionTokens, ['server', 'servers'])
  const apiIntent = includesAnyToken(questionTokens, ['api'])
  const selectorIntent = includesAnyToken(questionTokens, ['selector', 'selectors'])
  const sliceIntent = includesAnyToken(questionTokens, ['slice', 'slices', 'state'])
  const storeIntent = includesAnyToken(questionTokens, ['store', 'stores', 'reducer', 'reducers'])
  const renderIntent = includesAnyToken(questionTokens, ['render', 'renders', 'page', 'pages', 'component', 'components'])
  const loaderIntent = includesAnyToken(questionTokens, ['loader', 'loaders', 'load'])
  const actionIntent = includesAnyToken(questionTokens, ['action', 'actions', 'submit', 'submits', 'dispatch'])
  const moduleIntent = includesAnyToken(questionTokens, ['module', 'modules'])
  const providerIntent = includesAnyToken(questionTokens, ['provider', 'providers', 'service', 'services', 'injectable', 'injectables'])
  const guardIntent = includesAnyToken(questionTokens, ['guard', 'guards'])
  const interceptorIntent = includesAnyToken(questionTokens, ['interceptor', 'interceptors'])
  const pipeIntent = includesAnyToken(questionTokens, ['pipe', 'pipes'])
  const nextSpecificIntent =
    explicitNext ||
    explicitNextText ||
    explicitNextPagesArtifact ||
    layoutIntent ||
    clientIntent ||
    serverIntent ||
    apiIntent
  const hono = explicitHono
  const fastify = explicitFastify || pluginIntent
  const trpc =
    explicitTrpc
    || procedureIntent
    || (routerIntent && (queryIntent || mutationIntent || subscriptionIntent))
  const repository = storageEndpointIntent
  const prisma = explicitPrisma || modelIntent || persistenceIntent || (
    (storageReadIntent || storageWriteIntent)
    && (modelIntent || explicitPrisma || persistenceIntent)
  )
  // Express still wins on bare http-verb/middleware/handler intent unless
  // a more specific framework is named.
  const express = (explicitExpress || hasHttpVerb || middlewareIntent || handlerIntent) && !hono && !fastify
  const redux = explicitRedux || selectorIntent || sliceIntent || storeIntent
  const reactRouter =
    routeIntent &&
    !express &&
    (explicitReactRouter || mentionsReact || loaderIntent || actionIntent || (renderIntent && !nextSpecificIntent))
  const nest =
    explicitNest
    || controllerIntent
    || moduleIntent
    || guardIntent
    || interceptorIntent
    || pipeIntent
    || resolverIntent
    || (providerIntent && (apiIntent || mutationIntent || queryIntent || subscriptionIntent))
  const inferredRoutingControllers =
    !explicitExpress &&
    !explicitNest &&
    !explicitReactRouter &&
    !explicitNext &&
    !explicitHono &&
    !explicitFastify &&
    (hasHttpVerb || controllerIntent)
  const routingControllers = explicitRoutingControllers || inferredRoutingControllers
  const next =
    nextSpecificIntent &&
    (explicitNext ||
      explicitNextText ||
      explicitNextPagesArtifact ||
      includesAnyToken(questionTokens, ['route', 'routes', 'middleware', 'action', 'actions', 'page', 'pages']))

  return {
    frameworkShaped: express || routingControllers || redux || reactRouter || nest || next || repository || hono || fastify || trpc || prisma,
    express,
    routingControllers,
    redux,
    reactRouter,
    nest,
    next,
    repository,
    hono,
    fastify,
    trpc,
    prisma,
    routeIntent,
    middlewareIntent,
    handlerIntent,
    controllerIntent,
    pageIntent,
    layoutIntent,
    clientIntent,
    serverIntent,
    apiIntent,
    selectorIntent,
    sliceIntent,
    storeIntent,
    renderIntent,
    loaderIntent,
    actionIntent,
    moduleIntent,
    providerIntent,
    guardIntent,
    interceptorIntent,
    pipeIntent,
    pluginIntent,
    procedureIntent,
    queryIntent,
    mutationIntent,
    subscriptionIntent,
    modelIntent,
    persistenceIntent,
    storageEndpointIntent,
    storageReadIntent,
    storageWriteIntent,
  }
}

/** Metadata available on a node for framework-aware boost matching. All
 *  fields are optional because not every node carries every field — only
 *  framework-tagged nodes do, and even then the SPI projector only emits
 *  the ones each substrate populates. */
interface FrameworkNodeMetadata {
  /** Express / Hono / Fastify / Next.js — the URL path string. */
  route_path?: string
  /** Express / Hono / Fastify / Next.js route-handler — the HTTP method. */
  http_method?: string
  /** Express / Fastify middleware mount prefix, or Fastify plugin prefix. */
  mount_path?: string
  /** Redux createSlice name. */
  slice_name?: string
  /** tRPC procedure name (e.g. 'getUser', 'createOrder'). */
  procedure_name?: string
  /** tRPC router-name prefix on synthesized procedures. */
  router_name?: string
  /** Storage endpoint operation (e.g. 'save', 'update', 'findMany'). */
  storage_operation?: string
  /** Runtime boundary marker (e.g. 'client', 'server'). */
  runtime_boundary?: string
}

function frameworkBoostForNode(
  profile: FrameworkQuestionProfile,
  nodeKind: string,
  frameworkRole: string,
  metadata: FrameworkNodeMetadata = {},
  questionLower = '',
  options: {
    allowRuntimeBoundaryBoost?: boolean
  } = {},
): number {
  if (!profile.frameworkShaped) {
    return 0
  }

  const allowRuntimeBoundaryBoost = options.allowRuntimeBoundaryBoost ?? true
  let boost = 0

  // #133 — metadata-aware boost. When the question contains a substring
  // that matches the node's structural metadata (route_path, http_method,
  // mount_path, slice_name, procedure_name), add a big targeted boost so
  // the structurally-correct node beats accidental label matches.
  if (metadata.route_path && questionLower) {
    const rp = metadata.route_path.toLowerCase()
    // Exact substring match between question and the route path string.
    // Conservative: require at least 3 chars so '/' alone doesn't fire.
    if (rp.length >= 3 && questionLower.includes(rp)) {
      boost += 3
    }
  }
  if (metadata.http_method && questionLower) {
    // CodeRabbit fix: word-boundary check so http_method 'GET' doesn't
    // match 'budget' / 'forget' / 'target' / etc. Verb is lowercased to
    // match questionLower which is already lowercased upstream.
    // CodeRabbit follow-up: escape regex metacharacters so an unexpected
    // verb (e.g. user-supplied data leaking in via SPI metadata) can't
    // break the RegExp constructor or match unintended substrings.
    const verb = metadata.http_method.toLowerCase()
    if (verb && new RegExp(`\\b${escapeRegexLiteral(verb)}\\b`).test(questionLower)) {
      boost += 1.5
    }
  }
  if (metadata.mount_path && questionLower) {
    const mp = metadata.mount_path.toLowerCase()
    if (mp.length >= 3 && questionLower.includes(mp)) {
      boost += 1.5
    }
  }
  if (metadata.slice_name && questionLower) {
    const sn = metadata.slice_name.toLowerCase()
    if (sn.length >= 2 && questionLower.includes(sn)) {
      boost += 2
    }
  }
  if (metadata.procedure_name && questionLower) {
    const pn = metadata.procedure_name.toLowerCase()
    if (pn.length >= 2 && questionLower.includes(pn)) {
      boost += 2
    }
  }
  if (metadata.router_name && questionLower) {
    const rn = metadata.router_name.toLowerCase()
    if (rn.length >= 2 && questionLower.includes(rn)) {
      boost += 1
    }
  }
  if (metadata.storage_operation && questionLower) {
    const storageOperation = metadata.storage_operation.toLowerCase()
    if (storageOperation.length >= 2 && containsWholeQuestionToken(questionLower, storageOperation)) {
      const requestFlowCue = profile.routeIntent
      const storageCue = profile.storageEndpointIntent || profile.storageReadIntent || profile.storageWriteIntent
      boost += storageCue ? 2.75 : profile.prisma && requestFlowCue ? 4.75 : 1.75
    }
  }
  if (allowRuntimeBoundaryBoost && metadata.runtime_boundary && questionLower) {
    const runtimeBoundary = metadata.runtime_boundary.toLowerCase()
    const boundaryIntent =
      (runtimeBoundary === 'server' && profile.serverIntent)
      || (runtimeBoundary === 'client' && profile.clientIntent)
      || (runtimeBoundary !== 'server' && runtimeBoundary !== 'client' && containsWholeQuestionToken(questionLower, runtimeBoundary))
    if (runtimeBoundary.length >= 2 && boundaryIntent && containsWholeQuestionToken(questionLower, runtimeBoundary)) {
      boost += 1.5
    }
  }

  if (profile.express) {
    if (frameworkRole === 'express_route') {
      boost += profile.routeIntent ? 4 : 0
    }
    if (frameworkRole === 'express_middleware') {
      boost += profile.middlewareIntent ? 2.5 : 1
    }
    if (frameworkRole === 'express_handler') {
      boost += profile.handlerIntent ? 2.5 : 1.25
    }
    if (frameworkRole === 'express_router' || frameworkRole === 'express_app') {
      boost += profile.routeIntent ? 1.5 : 0.5
    }
  }

  if (profile.routingControllers) {
    if (frameworkRole === 'routing_controllers_route') {
      boost += profile.routeIntent ? 3.75 : 1.5
    }
    if (frameworkRole === 'routing_controllers_controller') {
      boost += profile.controllerIntent || profile.routeIntent ? 3.5 : 1.5
    }
  }

  if (profile.redux) {
    if (nodeKind === 'slice' || frameworkRole === 'redux_slice') {
      boost += profile.sliceIntent || profile.selectorIntent ? 3.5 : 2.5
    }
    if (frameworkRole === 'redux_selector') {
      boost += profile.selectorIntent ? 3.5 : profile.sliceIntent || profile.storeIntent ? 0.75 : 0
    }
    if (nodeKind === 'store' || frameworkRole === 'redux_store') {
      boost += profile.storeIntent || profile.sliceIntent ? 2.25 : 1.5
    }
    if (frameworkRole === 'redux_action' || frameworkRole === 'redux_thunk') {
      boost += profile.actionIntent ? 2 : 0
    }
  }

  if (profile.reactRouter) {
    if (frameworkRole === 'react_router_route' || frameworkRole === 'react_router_layout') {
      boost += profile.routeIntent || profile.renderIntent || profile.loaderIntent || profile.actionIntent ? 3.5 : 2
    }
    if (frameworkRole === 'react_router_component') {
      boost += profile.renderIntent ? 2.5 : 1
    }
    if (frameworkRole === 'react_router_loader') {
      boost += profile.loaderIntent ? 2.5 : 1
    }
    if (frameworkRole === 'react_router_action') {
      boost += profile.actionIntent ? 2.5 : 1
    }
    if (frameworkRole === 'react_router') {
      boost += profile.routeIntent ? 1.5 : 0.5
    }
  }

  if (profile.nest) {
    if (frameworkRole === 'nest_route') {
      boost += profile.routeIntent ? 3.5 : 1.25
    }
    if (frameworkRole === 'nest_controller') {
      boost += profile.controllerIntent || profile.routeIntent ? 3.5 : 1.75
    }
    if (frameworkRole === 'nest_module') {
      boost += profile.moduleIntent ? 2.5 : 1
    }
    if (frameworkRole === 'nest_provider') {
      boost += profile.providerIntent || profile.controllerIntent ? 2.25 : 1
    }
    if (frameworkRole === 'nest_guard') {
      boost += profile.guardIntent || profile.middlewareIntent ? 2.5 : 0.75
    }
    if (frameworkRole === 'nest_interceptor') {
      boost += profile.interceptorIntent ? 2.5 : 0.75
    }
    if (frameworkRole === 'nest_pipe') {
      boost += profile.pipeIntent ? 2.5 : 0.75
    }
  }

  if (profile.next) {
    if (frameworkRole === 'next_route') {
      boost += profile.routeIntent || profile.pageIntent ? 3.75 : 1.5
    }
    if (frameworkRole === 'next_route_handler') {
      boost += profile.apiIntent ? 3.75 : profile.routeIntent ? 1.25 : 0.5
    }
    if (frameworkRole === 'next_page') {
      boost += profile.pageIntent || profile.routeIntent ? 3.25 : 1.5
    }
    if (
      frameworkRole === 'next_layout' ||
      frameworkRole === 'next_template' ||
      frameworkRole === 'next_loading' ||
      frameworkRole === 'next_error' ||
      frameworkRole === 'next_not_found' ||
      frameworkRole === 'next_default' ||
      frameworkRole === 'next_pages_app' ||
      frameworkRole === 'next_pages_document' ||
      frameworkRole === 'next_pages_error'
    ) {
      boost += profile.layoutIntent || profile.pageIntent || profile.routeIntent ? 2.5 : 1
    }
    if (frameworkRole === 'next_middleware') {
      boost += profile.middlewareIntent ? 3 : 1.25
    }
    if (frameworkRole === 'next_server_action') {
      boost += profile.actionIntent || profile.serverIntent ? 3.25 : 1.25
    }
    if (frameworkRole === 'next_client_component') {
      boost += profile.clientIntent || profile.renderIntent ? 3.25 : 1.25
    }
  }

  if (profile.repository) {
    if (frameworkRole === 'repository_reader') {
      boost += profile.storageReadIntent ? 4 : profile.storageEndpointIntent ? 2.5 : 0
    }
    if (frameworkRole === 'repository_writer') {
      boost += profile.storageWriteIntent ? 4 : profile.storageEndpointIntent ? 2.5 : 0
    }
  }

  // v0.19 — Hono / Fastify / tRPC / Prisma boost rules. Mirrors the
  // weights used for Express/NestJS/etc. so questions about these
  // substrates route to the right nodes.
  if (profile.hono) {
    if (frameworkRole === 'hono_route') {
      boost += profile.routeIntent ? 4 : 1.5
    }
    if (frameworkRole === 'hono_middleware') {
      boost += profile.middlewareIntent ? 2.5 : 1
    }
    if (frameworkRole === 'hono_app') {
      boost += profile.routeIntent ? 1.5 : 0.5
    }
  }

  if (profile.fastify) {
    if (frameworkRole === 'fastify_route') {
      boost += profile.routeIntent ? 4 : 1.5
    }
    if (frameworkRole === 'fastify_plugin') {
      boost += profile.pluginIntent || profile.middlewareIntent ? 2.5 : 1
    }
    if (frameworkRole === 'fastify_app') {
      boost += profile.routeIntent ? 1.5 : 0.5
    }
  }

  if (profile.trpc) {
    if (frameworkRole === 'trpc_procedure_query') {
      boost += profile.queryIntent || profile.procedureIntent ? 3.5 : 1.5
    }
    if (frameworkRole === 'trpc_procedure_mutation') {
      boost += profile.mutationIntent || profile.procedureIntent ? 3.5 : 1.5
    }
    if (frameworkRole === 'trpc_procedure_subscription') {
      boost += profile.subscriptionIntent || profile.procedureIntent ? 3.5 : 1.5
    }
    if (frameworkRole === 'trpc_router') {
      boost += profile.routeIntent || profile.procedureIntent ? 2 : 0.75
    }
  }

  if (profile.prisma) {
    if (frameworkRole === 'prisma_client') {
      boost += profile.modelIntent
        ? 3
        : profile.storageEndpointIntent
          ? 1
          : 1.5
    }
    if (frameworkRole === 'prisma_model_access') {
      boost += profile.modelIntent
        ? 3
        : profile.storageEndpointIntent
          ? 2.25
          : 1
    }
    if (frameworkRole === 'prisma_model_reader') {
      boost += profile.storageReadIntent
        ? 4
        : profile.storageEndpointIntent
          ? 2.5
          : profile.modelIntent
            ? 2
            : 0.75
    }
    if (frameworkRole === 'prisma_model_writer') {
      boost += profile.storageWriteIntent
        ? 4
        : profile.storageEndpointIntent
          ? 2.5
          : profile.modelIntent
            ? 2
            : 0.75
    }
  }

  if (profile.frameworkShaped && boost === 0 && ['function', 'class', 'variable'].includes(nodeKind)) {
    boost -= 0.5
  }

  return boost
}

function retrieveEvidenceClassForBand(relevanceBand: RetrieveMatchedNode['relevance_band']): ContextPackEvidenceClass {
  if (relevanceBand === 'direct') {
    return 'primary'
  }

  return relevanceBand === 'related' ? 'supporting' : 'structural'
}

function fallbackRetrieveCoverage(result: RetrieveResult): ContextPackCoverage {
  const taskContract = classifyTaskContract('explain', {
    budget: result.token_count,
    prompt: result.question,
  })

  return {
    required_evidence: taskContract.required_evidence,
    semantic_required: taskContract.semantic_required,
    semantic_optional: taskContract.semantic_optional,
    entries: [],
    semantic_entries: [],
    missing_required: [],
    missing_semantic: [],
    available_relationships: result.relationships.length,
    selected_relationships: result.relationships.length,
  }
}

/**
 * Build the full CompiledContextPack representation of a RetrieveResult.
 * Exported in v0.15 so the context-pack diagnostics scorer (#78) can
 * compute structural quality signals against the same shape the compact
 * stdio response is derived from.
 */
export function contextPackFromRetrieveResult(
  result: RetrieveResult,
): CompiledContextPack<ContextPackNode, RetrieveRelationship, RetrieveCommunityContext> {
  const taskContract = result.task_contract ?? classifyTaskContract('explain', {
    budget: result.token_count,
    prompt: result.question,
  })
  const renderedNodes = renderCompiledContextPackNodes(
    taskContract,
    result.matched_nodes.map((node) => ({
      ...node,
      evidence_class: node.evidence_class ?? retrieveEvidenceClassForBand(node.relevance_band),
    })),
    result.relationships,
  )

  return {
    task_contract: taskContract,
    token_count: renderedNodes.token_count,
    nodes: renderedNodes.nodes,
    relationships: result.relationships,
    community_context: result.community_context,
    graph_signals: result.graph_signals,
    claims: result.claims ?? [],
    expandable: result.expandable ?? [],
    coverage: result.coverage ?? fallbackRetrieveCoverage(result),
    ...(result.selection_diagnostics ? { selection_diagnostics: result.selection_diagnostics } : {}),
    ...(result.retrieval_strategy ? { retrieval_strategy: result.retrieval_strategy } : {}),
    ...(result.retrieval_plan ? { retrieval_plan: result.retrieval_plan } : {}),
    ...(result.recovery ? { recovery: result.recovery } : {}),
    ...(result.slice ? { slice: result.slice } : {}),
    ...(result.execution_slice ? { execution_slice: result.execution_slice } : {}),
    ...(result.answer_contract ? { answer_contract: result.answer_contract } : {}),
    ...(result.retrieval_gate ? { retrieval_gate: result.retrieval_gate } : {}),
  }
}

function buildRetrieveResultFromOrderedCandidates(
  graph: KnowledgeGraph,
  options: RetrieveOptions,
  orderedCandidates: readonly ScoredNode[],
  communities: Communities,
  communityLabels: Record<number, string>,
  retrieveGraphSignals: RetrieveGraphSignals,
  retrievalGate: RetrievalGateDecision,
  rootPath?: string,
  sliceMetadata?: ContextPackSliceMetadata,
): RetrieveResult {
  const snippetFileCache = new Map<string, string[] | null>()
  const taskContract = classifyRetrieveTaskContract(options)
  const orderedCandidateIds = new Set(orderedCandidates.map((node) => node.id))
  const orderedCommunities = new Set<number>(orderedCandidates.flatMap((node) => (node.community === null ? [] : [node.community])))
  const graphSignalLabels = {
    god_nodes: [...new Set(orderedCandidates.map((node) => node.label).filter((label) => retrieveGraphSignals.godNodeLabels.has(label)))],
    bridge_nodes: [...new Set(orderedCandidates.map((node) => node.label).filter((label) => retrieveGraphSignals.bridgeNodeLabels.has(label)))],
  }
  const structuralIds = structuralSliceNodeIds(sliceMetadata, orderedCandidates, options.question)
  const executionSlice = buildExecutionSlice(
    graph,
    taskContract,
    retrievalGate,
    options.question,
    sliceMetadata,
    rootPath,
  )
  const nodeCandidates: Array<ContextPackNodeCandidate<ContextPackNode>> = orderedCandidates.map((node) => {
    let builtEntry: RetrieveMatchedNode | undefined
    let tokenCost: number | undefined
    const baseEvidenceClass = retrieveEvidenceClassForBand(node.relevanceBand)
    const evidenceClass = structuralIds.has(node.id) && !(promptExpectsPersistenceStep(options.question) && node.relevanceBand === 'direct')
      ? 'structural'
      : baseEvidenceClass
    const graphSignal = retrieveGraphSignals.bridgeNodeIds.has(node.id)
      ? 'bridge'
      : retrieveGraphSignals.godNodeIds.has(node.id)
        ? 'god'
        : undefined

    const buildEntry = (): RetrieveMatchedNode => {
      if (builtEntry) {
        return builtEntry
      }

      const snippet = node.storedSnippet ?? readSnippet(node.sourceFile, node.lineNumber, {
        derived: node.lineNumberDerived,
        fileCache: snippetFileCache,
      })
      const serializedSourceFile = relativizeSourceFile(node.sourceFile, rootPath)
      builtEntry = {
        node_id: node.id,
        label: node.label,
        source_file: serializedSourceFile,
        line_number: node.lineNumber,
        framework_boost: node.frameworkBoost,
        source_domain: node.sourceDomain,
        file_type: node.fileType,
        snippet,
        match_score: node.score,
        relevance_band: node.relevanceBand,
        community: node.community,
        community_label: node.community !== null ? (communityLabels[node.community] ?? null) : null,
        evidence_class: evidenceClass,
        ...(node.framework ? { framework: node.framework } : {}),
        ...(node.frameworkRole ? { framework_role: node.frameworkRole } : {}),
        ...(node.nodeKind.trim().length > 0 ? { node_kind: node.nodeKind } : {}),
      }
      tokenCost = estimateRetrieveEntryTokens(node.label, serializedSourceFile, node.lineNumber, snippet)
      return builtEntry
    }

    return {
      label: node.label,
      node_id: node.id,
      community: node.community,
      source_file: relativizeSourceFile(node.sourceFile, rootPath),
      line_number: node.lineNumber,
      file_type: node.fileType,
      ...(node.nodeKind.trim().length > 0 ? { node_kind: node.nodeKind } : {}),
      framework_boost: node.frameworkBoost,
      source_domain: node.sourceDomain,
      match_score: node.score,
      exact_anchor_match: node.exactLabelMatch,
      direct_symbol_match: node.exactLabelMatch,
      source_path_match: node.sourcePathMatch,
      ...(node.framework ? { framework: node.framework } : {}),
      ...(node.frameworkRole ? { framework_role: node.frameworkRole } : {}),
      ...(graphSignal ? { graph_signal: graphSignal } : {}),
      graph_degree: graph.degree(node.id),
      ...(node.storedSnippet !== null ? { snippet: node.storedSnippet } : {}),
      evidence_class: evidenceClass,
      expandable_ref: {
        node_id: node.id,
        label: node.label,
        source_file: relativizeSourceFile(node.sourceFile, rootPath),
        ...(() => {
          const lineRange = expandableLineRange(node)
          return lineRange ? { line_range: lineRange } : {}
        })(),
      },
      estimate_tokens: () => {
        if (tokenCost !== undefined) {
          return tokenCost
        }

        buildEntry()
        return tokenCost ?? 0
      },
      build_entry: buildEntry,
    }
  })

  const pack = runRetrievalPackingStage({
    candidate_count: nodeCandidates.length,
  }, () => compileContextPack<ContextPackNode, RetrieveRelationship, RetrieveCommunityContext>({
    task_contract: taskContract,
    nodes: nodeCandidates,
    relationships: collectRelationships(graph, orderedCandidateIds),
    community_context: [...orderedCommunities]
      .map((communityId) => ({
        id: communityId,
        label: communityLabels[communityId] ?? `Community ${communityId}`,
        node_count: (communities[communityId] ?? []).length,
      }))
      .sort((left, right) => right.node_count - left.node_count),
    graph_signals: graphSignalLabels,
    selection_strategy: 'value-per-token',
    retrieval_gate: retrievalGate,
  }), options.onStageDiagnostic)
  const matchedNodes = pack.nodes as RetrieveMatchedNode[]
  const answerContract = buildRuntimeGenerationAnswerContract(
    taskContract,
    retrievalGate,
    options.question,
    matchedNodes,
    executionSlice,
    sliceMetadata,
  )
  runRetrievalEvidencePlanningStage({
    taskContract: pack.task_contract,
    coverage: pack.coverage,
    expandable: pack.expandable,
    ...(executionSlice ? { executionSlice } : {}),
    ...(answerContract ? { answerContract } : {}),
    missingPhases: answerContract?.missing_phases ?? executionSlice?.phase_coverage?.missing ?? [],
    coveredWorkflowOwners: matchedNodes.map((node) => node.source_file),
    selectedNodeCount: matchedNodes.length,
    selectedRelationshipCount: pack.relationships.length,
  }, options.onStageDiagnostic)

  return {
    question: options.question,
    token_count: pack.token_count,
    matched_nodes: matchedNodes,
    relationships: pack.relationships,
    community_context: pack.community_context,
    graph_signals: pack.graph_signals ?? { god_nodes: [], bridge_nodes: [] },
    task_contract: pack.task_contract,
    claims: pack.claims,
    expandable: pack.expandable,
    coverage: pack.coverage,
    ...(pack.selection_diagnostics ? { selection_diagnostics: pack.selection_diagnostics } : {}),
    ...(pack.retrieval_gate ? { retrieval_gate: pack.retrieval_gate } : {}),
    retrieval_strategy: options.retrievalStrategy ?? 'default',
    ...(sliceMetadata ? { slice: sliceMetadata } : {}),
    ...(executionSlice ? { execution_slice: executionSlice } : {}),
    ...(answerContract ? { answer_contract: answerContract } : {}),
  }
}

const RETRIEVAL_PASS_STAGES_AFTER_INTERPRETATION: readonly RetrievalPipelineStage[] = [
  'seed_generation',
  'structural_expansion',
  'candidate_ranking',
  'budgeted_packing',
  'evidence_planning',
]

const reportSkippedRetrievalPassStages = (options: RetrieveOptions, inputCount: number): void => {
  for (const stage of RETRIEVAL_PASS_STAGES_AFTER_INTERPRETATION) {
    reportSkippedPipelineStage({
      pipeline: 'retrieval',
      stage,
      inputCount,
      ...(options.onStageDiagnostic ? { observer: options.onStageDiagnostic } : {}),
    })
  }
}

function retrieveContextPass(
  graph: KnowledgeGraph,
  options: RetrieveOptions,
  conceptualNodeBoosts: ReadonlyMap<string, number> = new Map(),
  preserveConceptualObligationOrder = false,
): RetrieveResult {
  // Guard before candidate expansion, which also reads directional adjacency.
  // sliceCandidatesForRetrieve repeats the guard to protect its direct callers.
  if (options.retrievalStrategy === 'slice-v1') {
    requireDirectedGraph(graph, 'Directional retrieval')
  }

  const { question, budget } = options
  const queryStage = runRetrievalQueryStage({
    question,
    budget,
    ...(options.taskKind ? { taskKind: options.taskKind } : {}),
    ...(options.taskIntent ? { taskIntent: options.taskIntent } : {}),
    ...(options.retrievalLevel !== undefined ? { retrievalLevel: options.retrievalLevel } : {}),
  }, options.onStageDiagnostic)
  const questionTokens = queryStage.question_tokens
  const graphRootPath = typeof graph.graph.root_path === 'string' && graph.graph.root_path.length > 0
    ? graph.graph.root_path
    : undefined
  const classificationRootPath = inferredGraphRoot(graph)
  const retrievalGate = queryStage.retrieval_gate
  const effectiveRetrievalLevel = queryStage.effective_retrieval_level

  if (questionTokens.length === 0) {
    reportSkippedRetrievalPassStages(options, graph.numberOfNodes())
    const emptyPack = compileContextPack({
      task_contract: queryStage.task_contract,
      nodes: [],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      retrieval_gate: retrievalGate,
    })

    return {
      question,
      token_count: 0,
      matched_nodes: [],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      task_contract: emptyPack.task_contract,
      claims: emptyPack.claims,
      expandable: emptyPack.expandable,
      coverage: emptyPack.coverage,
      ...(emptyPack.retrieval_gate ? { retrieval_gate: emptyPack.retrieval_gate } : {}),
      retrieval_strategy: options.retrievalStrategy ?? 'default',
    }
  }

  if (effectiveRetrievalLevel === 0) {
    reportSkippedRetrievalPassStages(options, graph.numberOfNodes())
    const emptyPack = compileContextPack({
      task_contract: queryStage.task_contract,
      nodes: [],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      retrieval_gate: retrievalGate,
    })

    return {
      question,
      token_count: 0,
      matched_nodes: [],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      task_contract: emptyPack.task_contract,
      claims: emptyPack.claims,
      expandable: emptyPack.expandable,
      coverage: emptyPack.coverage,
      ...(emptyPack.retrieval_gate ? { retrieval_gate: emptyPack.retrieval_gate } : {}),
      retrieval_strategy: options.retrievalStrategy ?? 'default',
    }
  }

  const seedOutput = runRetrievalCandidateStage(
    'seed_generation',
    { candidate_count: graph.numberOfNodes() },
    () => {
  // Pre-compute community labels so seed scoring can treat them as secondary evidence.
  const communities = communitiesFromGraph(graph)
  const frameworkProfile = buildFrameworkQuestionProfile(question, questionTokens)
  // #133 — lowercase question for metadata substring matching (route_path,
  // http_method, slice_name, procedure_name, mount_path).
  const questionLower = question.toLowerCase()
  const fileOrientedQuestion = questionLooksFileOriented(question, questionTokens)
  const activeFrameworks = activeFrameworksForProfile(frameworkProfile)
  const communityLabels: Record<number, string> = {
    ...buildCommunityLabels(graph, communities),
    ...storedCommunityLabelsFromGraph(graph),
  }
  const mentionedSymbolRefs = retrievalGate.signals.mentioned_symbols.map(parseSymbolReference)
  const mentionedPaths = retrievalGate.signals.mentioned_paths
  const promptIdentifiers = extractPromptIdentifierSignals(question, mentionedSymbolRefs, mentionedPaths)
  const excludedDomains = retrievalGate.signals.excluded_domains ?? []
  const excludedTerms = retrievalGate.signals.excluded_terms ?? []
  const excludedPathHints = retrievalGate.signals.excluded_path_hints ?? []

  // Step 1+2: Score all nodes with explicit seed evidence weights.
  const tokenWeights = tokenWeightsForQuestion(graph, questionTokens)
  const averageLabelLength = averageLabelLengthForGraph(graph)
  const seedCandidates: SeedCandidate[] = []
  for (const [id, attributes] of graph.nodeEntries()) {
    const community = parseCommunityId(attributes.community)
    if (options.community !== undefined && community !== options.community) {
      continue
    }

    const fileType = String(attributes.file_type ?? '').trim().toLowerCase()
    if (options.fileType && fileType !== options.fileType.trim().toLowerCase()) {
      continue
    }

    const label = String(attributes.label ?? '')
    const sourceFile = String(attributes.source_file ?? '')
    const nodeKind = String(attributes.node_kind ?? '')
    const sourceDomain = classifySourceDomain(sourceFile, classificationRootPath)
    const fileNodeLike = isFileNodeLike(label, sourceFile)
    const symbolMatch = symbolReferenceMatchScore(label, sourceFile, mentionedSymbolRefs)
    const exactAnchorMatch = symbolMatch >= 3
    const mentionedPathMatch = sourceFileMatchesMentionedPath(sourceFile, mentionedPaths)
    const framework = typeof attributes.framework === 'string' ? attributes.framework : undefined
    const frameworkRole = String(attributes.framework_role ?? '')
    const score = scoreSeedCandidate(
      question,
      questionTokens,
      label,
      sourceFile,
      community !== null ? (communityLabels[community] ?? null) : null,
      promptIdentifiers,
      tokenWeights,
      averageLabelLength,
      { fileNodeLike, fileOrientedQuestion },
    )
    const anchorScore = symbolMatch
    const exclusionMatches = excludedDomains.includes(sourceDomain as never)
      || excludedTermMatches(label, excludedTerms, excludedPathHints)
      || excludedTermMatches(sourceFile, excludedTerms, excludedPathHints)
    if ((isPollutedSourcePath(sourceFile, classificationRootPath) || exclusionMatches) && !exactAnchorMatch && !mentionedPathMatch) {
      continue
    }
    const sourceDomainPenalty = defaultSourceDomainPenalty(sourceDomain, retrievalGate.intent, question, questionTokens)

    // CodeRabbit fix: compute framework boost BEFORE the seed gate so
    // metadata-only matches (e.g. a `handler()` node tagged with
    // route_path that the question names verbatim) can become a seed
    // even when the label has no token overlap.
    const domainAdjustment = retrievalDomainAdjustment(retrievalGate, {
      label,
      sourceFile,
      nodeKind,
      frameworkRole: frameworkRole || undefined,
    })
    const sourcePathDemoted = !exactAnchorMatch
      && !mentionedPathMatch
      && shouldDemoteSourcePathMatchForIntent(retrievalGate, {
        label,
        sourceFile,
        nodeKind,
        frameworkRole: frameworkRole || undefined,
      })
    const effectiveScore = sourcePathDemoted
      ? {
          ...score,
          sourcePathScore: 0,
          total: score.total - score.sourcePathScore,
        }
      : score
    const explicitlyAnchored = exactAnchorMatch || mentionedPathMatch
    const metadataBoost = frameworkBoostForNode(
      frameworkProfile,
      nodeKind,
      frameworkRole,
      frameworkMetadataFromAttributes(attributes),
      questionLower,
      {
        allowRuntimeBoundaryBoost: effectiveScore.total + anchorScore > 0 || explicitlyAnchored,
      },
    )

    const domainIntentPenalty = runtimeGenerationSourceDomainPenalty(retrievalGate, sourceDomain, explicitlyAnchored)
    const scriptMigrationPenalty = scriptMigrationPathPenalty(retrievalGate, sourceFile, label, question, explicitlyAnchored)
    const conceptualFallbackScore = conceptualNodeBoosts.get(id) ?? 0
    const totalSeedScore = effectiveScore.total + anchorScore + metadataBoost + domainAdjustment + conceptualFallbackScore
      - sourceDomainPenalty - domainIntentPenalty - scriptMigrationPenalty
    const hasPositiveSeedEvidence = totalSeedScore > 0 || exactAnchorMatch || mentionedPathMatch
    if (hasPositiveSeedEvidence) {
      const resolvedLine = resolvedLineNumber(attributes)
      seedCandidates.push({
        id,
        label,
        sourceFile,
        sourceLocation: typeof attributes.source_location === 'string' && attributes.source_location.length > 0
          ? attributes.source_location
          : null,
        lineNumber: resolvedLine.lineNumber,
        lineNumberDerived: resolvedLine.derived,
        storedSnippet: storedSnippetFromAttributes(attributes),
        nodeKind,
        framework,
        frameworkRole: frameworkRole || undefined,
        sourceDomain,
        fileType,
        fileNodeLike,
        community,
        frameworkBoost: metadataBoost,
        seedScore: {
          ...effectiveScore,
          labelExactScore: effectiveScore.labelExactScore + anchorScore,
          conceptualFallbackScore,
          total: totalSeedScore,
        },
        exactLabelMatch: effectiveScore.labelExactScore > 0 || exactAnchorMatch,
        literalPathMatch: mentionedPathMatch,
        sourcePathMatch: effectiveScore.sourcePathScore > 0 || mentionedPathMatch,
        // When the seed only made it in via metadata boost, give it at
        // least evidence tier 1 so it's not at the bottom of the heap.
        evidenceTier: Math.max(
          metadataBoost > 0 || domainAdjustment > 0 ? 1 : 0,
          exactAnchorMatch || mentionedPathMatch ? 2 : evidenceTierForSeedScore(effectiveScore),
          conceptualFallbackScore >= 0.75 ? 2 : conceptualFallbackScore > 0 ? 1 : 0,
        ) as 0 | 1 | 2,
        relevanceBand: effectiveScore.labelExactScore > 0 || effectiveScore.labelPhraseScore > 0 || exactAnchorMatch || effectiveScore.labelTokenScore > 0
          ? 'direct'
          : 'related',
      })
    }
  }

  const cleanExactLabels = new Set(
    seedCandidates
      .filter((candidate) => !isPollutedSourcePath(candidate.sourceFile, classificationRootPath))
      .map((candidate) => normalizeSeedText(candidate.label)),
  )
  const filteredSeedCandidates = seedCandidates.filter((candidate) => (
    !isPollutedSourcePath(candidate.sourceFile, classificationRootPath)
      || candidate.literalPathMatch
      || !cleanExactLabels.has(normalizeSeedText(candidate.label))
  ))

  const fusedSeedScores = reciprocalRankFuse([
    rankedSeedCandidateIds(graph, filteredSeedCandidates, (candidate) => candidate.seedScore.labelExactScore),
    rankedSeedCandidateIds(graph, filteredSeedCandidates, (candidate) => candidate.seedScore.labelPhraseScore),
    rankedSeedCandidateIds(graph, filteredSeedCandidates, (candidate) => candidate.seedScore.labelTokenScore),
    rankedSeedCandidateIds(graph, filteredSeedCandidates, (candidate) => candidate.seedScore.promptIdentifierScore),
    rankedSeedCandidateIds(graph, filteredSeedCandidates, (candidate) => candidate.seedScore.sourcePathScore),
    rankedSeedCandidateIds(graph, filteredSeedCandidates, (candidate) => candidate.seedScore.communityScore),
    rankedSeedCandidateIds(graph, filteredSeedCandidates, (candidate) => candidate.seedScore.conceptualFallbackScore),
  ], {
    weights: [2, 1.5, 1.5, 0.5, 0.25, 0.25, 1.75],
  })
  const scored: ScoredNode[] = filteredSeedCandidates.map((candidate) => ({
    id: candidate.id,
    label: candidate.label,
    sourceFile: candidate.sourceFile,
    sourceLocation: candidate.sourceLocation,
    lineNumber: candidate.lineNumber,
    lineNumberDerived: candidate.lineNumberDerived,
    storedSnippet: candidate.storedSnippet,
    nodeKind: candidate.nodeKind,
    framework: candidate.framework,
    frameworkRole: candidate.frameworkRole,
    fileType: candidate.fileType,
    fileNodeLike: candidate.fileNodeLike,
    community: candidate.community,
    frameworkBoost: candidate.frameworkBoost,
    exactLabelMatch: candidate.exactLabelMatch,
    literalPathMatch: candidate.literalPathMatch,
    sourcePathMatch: candidate.sourcePathMatch,
    evidenceTier: candidate.evidenceTier,
    score: Math.max(
      0.05,
      ((fusedSeedScores.get(candidate.id) ?? 0) * SEED_FUSION_SCORE_SCALE)
        + candidate.seedScore.conceptualFallbackScore
        + candidate.frameworkBoost
        + retrievalDomainAdjustment(retrievalGate, candidate)
        - defaultSourceDomainPenalty(candidate.sourceDomain, retrievalGate.intent, question, questionTokens)
        - runtimeGenerationSourceDomainPenalty(retrievalGate, candidate.sourceDomain, candidate.exactLabelMatch || candidate.literalPathMatch)
        - scriptMigrationPathPenalty(retrievalGate, candidate.sourceFile, candidate.label, question, candidate.exactLabelMatch || candidate.literalPathMatch),
    ),
    relevanceBand: candidate.relevanceBand,
    sourceDomain: candidate.sourceDomain,
  }))

  scored.sort((a, b) => compareScoredNodes(graph, a, b))
  const expansionPolicy = expansionPolicyForLevel(effectiveRetrievalLevel, budget)
  const anchoredSeedPool = (mentionedSymbolRefs.length > 0 || mentionedPaths.length > 0)
    ? scored.filter((node) => symbolReferenceMatchScore(node.label, node.sourceFile, mentionedSymbolRefs) > 0 || sourceFileMatchesMentionedPath(node.sourceFile, mentionedPaths))
    : []
  const conceptualSeedPool = conceptualNodeBoosts.size > 0
    ? scored
        .filter((node) => (conceptualNodeBoosts.get(node.id) ?? 0) >= CONCEPTUAL_FALLBACK_SEED_MIN_BOOST)
        .sort((left, right) => (
          (conceptualNodeBoosts.get(right.id) ?? 0) - (conceptualNodeBoosts.get(left.id) ?? 0)
          || compareScoredNodes(graph, left, right)
        ))
    : []
  const seedPool = conceptualSeedPool.length > 0
    ? conceptualSeedPool
    : effectiveRetrievalLevel <= 2 && anchoredSeedPool.length > 0 ? anchoredSeedPool : scored
      return {
        candidate_count: seedPool.length,
        communities,
        frameworkProfile,
        activeFrameworks,
        communityLabels,
        mentionedSymbolRefs,
        mentionedPaths,
        excludedDomains,
        excludedTerms,
        excludedPathHints,
        scored,
        expansionPolicy,
        seedPool,
      }
    },
    options.onStageDiagnostic,
  )
  const {
    communities,
    frameworkProfile,
    activeFrameworks,
    communityLabels,
    mentionedSymbolRefs,
    mentionedPaths,
    excludedDomains,
    excludedTerms,
    excludedPathHints,
    scored,
    expansionPolicy,
    seedPool,
  } = seedOutput

  // Step 3: Multi-hop expansion — take top seeds, expand 2 hops with decaying scores
  const expansionOutput = runRetrievalCandidateStage(
    'structural_expansion',
    { candidate_count: seedPool.length },
    () => {
  const hasExactSeedMatch = seedPool.some((node) => node.exactLabelMatch)
  const seedCount = effectiveRetrievalLevel === 1 && hasExactSeedMatch
    ? Math.min(seedPool.length, 1)
    : Math.min(
        seedPool.length,
        conceptualNodeBoosts.size > 0
          ? Math.max(expansionPolicy.seed_limit, CONCEPTUAL_FALLBACK_SEED_LIMIT)
          : expansionPolicy.seed_limit,
      )
  const seedIds = new Set(seedPool.slice(0, seedCount).map((node) => node.id))
  const directSeeds = seedPool
    .filter((node) => node.relevanceBand === 'direct')
    .slice(0, seedCount)
  const expansionSeedIds = new Set((directSeeds.length > 0 ? directSeeds : seedPool.slice(0, seedCount)).map((node) => node.id))
  const hopScores = new Map<string, number>()
  const hopDistances = new Map<string, 1 | 2>()
  const hopEvidenceTiers = new Map<string, 0 | 1>()
  const hop1Ids = new Set<string>()
  const seedCommunity = seedPool[0]?.community ?? null

  const recordHop = (neighborId: string, relation: string, sourceScore: number, hopDistance: 1 | 2): void => {
    const hopScore = sourceScore * 0.5 * relationWeight(relation)
    const hopEvidenceTier = relationIsPrimaryForPolicy(effectiveRetrievalLevel, relation) ? 1 : 0
    const existingHopScore = hopScores.get(neighborId) ?? 0
    const existingHopEvidenceTier = hopEvidenceTiers.get(neighborId) ?? 0
    if (hopScore > existingHopScore || (hopScore === existingHopScore && hopEvidenceTier > existingHopEvidenceTier)) {
      hopScores.set(neighborId, hopScore)
      hopDistances.set(neighborId, hopDistance)
      hopEvidenceTiers.set(neighborId, hopEvidenceTier)
    }
    if (hopDistance === 1) {
      hop1Ids.add(neighborId)
    }
  }

  // Hop 1: direct neighbors inherit a relation-weighted slice of each strong seed's score.
  if (expansionPolicy.hop1_relations) {
    for (const seed of directSeeds.length > 0 ? directSeeds : seedPool.slice(0, seedCount)) {
      for (const neighborId of graph.successors(seed.id)) {
        if (expansionSeedIds.has(neighborId)) {
          continue
        }
        const relation = String(graph.edgeAttributes(seed.id, neighborId).relation ?? 'related_to')
        if (!relationAllowedForPolicy(expansionPolicy.hop1_relations, relation)) {
          continue
        }
        recordHop(neighborId, relation, seed.score, 1)
      }

      if (expansionPolicy.predecessor_mode !== 'none') {
        for (const predecessorId of graph.predecessors(seed.id)) {
          if (expansionSeedIds.has(predecessorId)) {
            continue
          }
          const relation = String(graph.edgeAttributes(predecessorId, seed.id).relation ?? 'related_to')
          const predecessorCommunity = parseCommunityId(graph.nodeAttributes(predecessorId).community)
          // File/container ownership is exact extractor evidence, so it must
          // not disappear merely because community detection placed the file
          // node and its symbol in adjacent clusters. Keeping this owner hop
          // also lets hop two reach the symbol's imported collaborators.
          if (
            relation !== 'contains'
            && !predecessorAllowedForPolicy(expansionPolicy.predecessor_mode, seedCommunity, predecessorCommunity)
          ) {
            continue
          }
          if (!relationAllowedForPolicy(expansionPolicy.hop1_relations, relation)) {
            continue
          }
          recordHop(predecessorId, relation, seed.score, 1)
        }
      }
    }
  }

  for (const node of scored) {
    const hopScore = hopScores.get(node.id)
    if (!hopScore) {
      continue
    }

    node.score += hopScore
    const hopEvidenceTier = hopEvidenceTiers.get(node.id) ?? 0
    if (node.sourcePathMatch && hopEvidenceTier > 0) {
      node.evidenceTier = 2
      node.relevanceBand = 'direct'
      node.score += 0.5
      continue
    }

    if (hopEvidenceTier > node.evidenceTier) {
      node.evidenceTier = hopEvidenceTier
      if (node.relevanceBand === 'peripheral') {
        node.relevanceBand = 'related'
      }
    }
  }

  // Hop 2: neighbors-of-neighbors decay again, but keep this pool small and relation-aware.
  if (expansionPolicy.hop2_relations && (effectiveRetrievalLevel >= 4 || !hasExactSeedMatch)) {
    const hop2Scores = new Map<string, number>()
    for (const hop1Id of hop1Ids) {
      const hop1Score = hopScores.get(hop1Id) ?? 0
      if (hop1Score <= 0) continue
      for (const hop2Id of graph.successors(hop1Id)) {
        if (seedIds.has(hop2Id) || hop1Ids.has(hop2Id)) {
          continue
        }
        const relation = String(graph.edgeAttributes(hop1Id, hop2Id).relation ?? 'related_to')
        if (!relationAllowedForPolicy(expansionPolicy.hop2_relations, relation)) {
          continue
        }
        const hop2Score = hop1Score * 0.5 * relationWeight(relation)
        if (hop2Score > (hop2Scores.get(hop2Id) ?? 0)) {
          hop2Scores.set(hop2Id, hop2Score)
        }
      }

      if (expansionPolicy.predecessor_mode !== 'none') {
        for (const predecessorId of graph.predecessors(hop1Id)) {
          if (seedIds.has(predecessorId) || hop1Ids.has(predecessorId)) {
            continue
          }
          const relation = String(graph.edgeAttributes(predecessorId, hop1Id).relation ?? 'related_to')
          const predecessorCommunity = parseCommunityId(graph.nodeAttributes(predecessorId).community)
          if (
            relation !== 'contains'
            && !predecessorAllowedForPolicy(expansionPolicy.predecessor_mode, seedCommunity, predecessorCommunity)
          ) {
            continue
          }
          if (!relationAllowedForPolicy(expansionPolicy.hop2_relations, relation)) {
            continue
          }
          const hop2Score = hop1Score * 0.5 * relationWeight(relation)
          if (hop2Score > (hop2Scores.get(predecessorId) ?? 0)) {
            hop2Scores.set(predecessorId, hop2Score)
          }
        }
      }
    }

    for (const [hop2Id, hop2Score] of [...hop2Scores.entries()]
      .sort(([leftId, leftScore], [rightId, rightScore]) => rightScore - leftScore || graph.degree(rightId) - graph.degree(leftId))
      .slice(0, expansionPolicy.max_second_hop_adds)) {
      hopScores.set(hop2Id, Math.max(hopScores.get(hop2Id) ?? 0, hop2Score))
      hopDistances.set(hop2Id, 2)
    }
  }

  // Add expanded nodes not already scored
  for (const [nodeId, hopScore] of hopScores) {
    if (scored.some((s) => s.id === nodeId)) {
      continue
    }

    const attributes = graph.nodeAttributes(nodeId)
    const community = parseCommunityId(attributes.community)
    if (options.community !== undefined && community !== options.community) {
      continue
    }

    const fileType = String(attributes.file_type ?? '').trim().toLowerCase()
    if (options.fileType && fileType !== options.fileType.trim().toLowerCase()) {
      continue
    }
    const label = String(attributes.label ?? '')
    const sourceFile = String(attributes.source_file ?? '')
    const sourceDomain = classifySourceDomain(sourceFile, classificationRootPath)
    const symbolMatch = symbolReferenceMatchScore(label, sourceFile, mentionedSymbolRefs)
    const pathMatch = sourceFileMatchesMentionedPath(sourceFile, mentionedPaths)
    const exclusionMatches = excludedDomains.includes(sourceDomain as never)
      || excludedTermMatches(label, excludedTerms, excludedPathHints)
      || excludedTermMatches(sourceFile, excludedTerms, excludedPathHints)
    if ((isPollutedSourcePath(sourceFile, classificationRootPath) || exclusionMatches) && symbolMatch <= 0 && !pathMatch) {
      continue
    }
    const sourceDomainPenalty = defaultSourceDomainPenalty(sourceDomain, retrievalGate.intent, question, questionTokens)
    const explicitlyAnchored = symbolMatch > 0 || pathMatch
    const domainIntentPenalty = runtimeGenerationSourceDomainPenalty(retrievalGate, sourceDomain, explicitlyAnchored)
    const scriptMigrationPenalty = scriptMigrationPathPenalty(retrievalGate, sourceFile, label, question, explicitlyAnchored)
    const domainAdjustment = retrievalDomainAdjustment(retrievalGate, {
      label,
      sourceFile,
      nodeKind: String(attributes.node_kind ?? ''),
      frameworkRole: typeof attributes.framework_role === 'string' ? attributes.framework_role : undefined,
    })

    const resolvedLine = resolvedLineNumber(attributes)
    scored.push({
      id: nodeId,
      label,
      sourceFile,
      sourceLocation: typeof attributes.source_location === 'string' && attributes.source_location.length > 0
        ? attributes.source_location
        : null,
      lineNumber: resolvedLine.lineNumber,
      lineNumberDerived: resolvedLine.derived,
      storedSnippet: storedSnippetFromAttributes(attributes),
      nodeKind: String(attributes.node_kind ?? ''),
      framework: typeof attributes.framework === 'string' ? attributes.framework : undefined,
      frameworkRole: typeof attributes.framework_role === 'string' ? attributes.framework_role : undefined,
      sourceDomain,
      fileType,
      fileNodeLike: isFileNodeLike(label, sourceFile),
      community,
      frameworkBoost: 0,
      exactLabelMatch: symbolMatch >= 3,
      literalPathMatch: pathMatch,
      sourcePathMatch: pathMatch,
      evidenceTier: hopDistances.get(nodeId) === 1 ? (hopEvidenceTiers.get(nodeId) ?? 0) : 0,
      score: Math.max(0.05, hopScore + domainAdjustment - sourceDomainPenalty - domainIntentPenalty - scriptMigrationPenalty),
      relevanceBand: hopDistances.get(nodeId) === 1 ? 'related' : 'peripheral',
    })
  }

      return {
        candidate_count: scored.length,
        seedIds,
        hopScores,
      }
    },
    options.onStageDiagnostic,
  )
  const { seedIds, hopScores } = expansionOutput
  const rankingOutput = runRetrievalCandidateStage(
    'candidate_ranking',
    { candidate_count: scored.length },
    () => {
  // Apply structural signal boosts before final sort
  const retrieveGraphSignals = graphSignalsForRetrieve(graph, communities, communityLabels)
  const topSeed = seedPool.length > 0 ? seedPool[0] : scored[0]
  const boostedSeedCommunity = topSeed?.community

  for (const node of scored) {
    if (node.score === 0) continue
    if (retrieveGraphSignals.bridgeNodeIds.has(node.id)) node.score += 0.3
    if (retrieveGraphSignals.godNodeIds.has(node.id)) node.score -= 0.2
    if (boostedSeedCommunity !== undefined && node.community === boostedSeedCommunity && node.community !== -1) node.score += 0.1
  }

  // Conceptual recovery already paid the cost of finding a bounded set of
  // obligation-grounded workflow owners. Keep those seeds ahead of expanded
  // helper calls; otherwise dense call trees can replace the cross-layer
  // spine with cheap leaves such as parser and retry helpers.
  scored.sort((a, b) => (
    conceptualNodeBoosts.size > 0
      ? Number(seedIds.has(b.id)) - Number(seedIds.has(a.id))
      : 0
  ) || (
    conceptualNodeBoosts.size > 0 && seedIds.has(a.id) && seedIds.has(b.id)
      ? (conceptualNodeBoosts.get(b.id) ?? 0) - (conceptualNodeBoosts.get(a.id) ?? 0)
      : 0
  ) || compareScoredNodes(graph, a, b))

  const frameworkCompatibleCandidates = frameworkProfile.frameworkShaped
    ? scored.filter((node) => isFrameworkCompatible(activeFrameworks, node.framework))
    : scored
  const frameworkIncompatibleCandidates = frameworkProfile.frameworkShaped
    ? scored.filter((node) => !isFrameworkCompatible(activeFrameworks, node.framework))
    : []
  const primaryCandidates = frameworkCompatibleCandidates.filter((node) => (seedIds.has(node.id) || hopScores.has(node.id)) && node.relevanceBand !== 'peripheral')
  const peripheralCandidates = frameworkCompatibleCandidates.filter((node) => (seedIds.has(node.id) || hopScores.has(node.id)) && node.relevanceBand === 'peripheral')
  const fallbackPrimaryCandidates = frameworkIncompatibleCandidates.filter((node) => (seedIds.has(node.id) || hopScores.has(node.id)) && node.relevanceBand !== 'peripheral')
  const fallbackPeripheralCandidates = frameworkIncompatibleCandidates.filter((node) => (seedIds.has(node.id) || hopScores.has(node.id)) && node.relevanceBand === 'peripheral')
  const prioritizedFrameworkCandidates = frameworkProfile.frameworkShaped
    ? primaryCandidates.filter((node) => node.frameworkBoost > 0)
    : []
  const secondaryCandidates = frameworkProfile.frameworkShaped
    ? primaryCandidates.filter((node) => node.frameworkBoost <= 0)
    : primaryCandidates
  const compactFrameworkLimit = frameworkProfile.frameworkShaped && prioritizedFrameworkCandidates.length > 0 ? 5 : Number.POSITIVE_INFINITY
  const reservedSupportingSlots =
    Number.isFinite(compactFrameworkLimit) && secondaryCandidates.length > 0
      ? Math.min(2, secondaryCandidates.length, compactFrameworkLimit - 1)
      : 0
  const prioritizedFrameworkHeadCount = Number.isFinite(compactFrameworkLimit)
    ? Math.max(1, compactFrameworkLimit - reservedSupportingSlots)
    : prioritizedFrameworkCandidates.length
  const compatibleCandidateCount = primaryCandidates.length + peripheralCandidates.length
  const fallbackInclusionOrder = compatibleCandidateCount < 4
    ? [...fallbackPrimaryCandidates, ...fallbackPeripheralCandidates]
    : []
  const frameworkOrderedCandidates = frameworkProfile.frameworkShaped
    ? [
        ...prioritizedFrameworkCandidates.slice(0, prioritizedFrameworkHeadCount),
        ...secondaryCandidates.slice(0, reservedSupportingSlots),
        ...prioritizedFrameworkCandidates.slice(prioritizedFrameworkHeadCount),
        ...secondaryCandidates.slice(reservedSupportingSlots),
        ...peripheralCandidates,
        ...fallbackInclusionOrder,
      ]
    : [...secondaryCandidates, ...peripheralCandidates]
  const inclusionOrder = expansionPolicy.include_peripheral
    ? frameworkOrderedCandidates
    : frameworkOrderedCandidates.filter((node) => node.relevanceBand !== 'peripheral')
      let orderedCandidates = inclusionOrder
      let sliceMetadata: ContextPackSliceMetadata | undefined
      // A multi-obligation conceptual fallback can deliberately assemble
      // cross-service and cross-language owners that do not form one local
      // slice. Only that explicitly selected recovery mode bypasses slice-v1;
      // ordinary conceptual reranking and symbol/path-anchored questions keep
      // the established slice contract.
      if (options.retrievalStrategy === 'slice-v1' && !preserveConceptualObligationOrder) {
        const sliced = sliceCandidatesForRetrieve(
          graph,
          scored.map((node) => ({
            id: node.id,
            label: node.label,
            sourceFile: node.sourceFile,
            exactLabelMatch: node.exactLabelMatch,
            sourcePathMatch: node.sourcePathMatch,
            literalPathMatch: node.literalPathMatch,
            score: node.score,
            nodeKind: node.nodeKind,
            frameworkRole: node.frameworkRole,
          })),
          retrievalGate.intent,
          {
            prompt: question,
            generationIntent: retrievalGate.signals.generation_intent,
            targetDomainHint: retrievalGate.signals.target_domain_hint,
            mentionedSymbols: retrievalGate.signals.mentioned_symbols,
            excludedDomains: retrievalGate.signals.excluded_domains,
            excludedTerms: retrievalGate.signals.excluded_terms,
            excludedPathHints: retrievalGate.signals.excluded_path_hints,
            rootPath: classificationRootPath,
          },
        )

        if (sliced) {
          const scoredById = new Map(scored.map((node) => [node.id, node]))
          const runtimeExpandedSliceIds = augmentSliceCandidateIdsForRuntimeExplain(
            graph,
            sliced.ordered_ids,
            sliced.metadata,
            retrievalGate,
            options.question,
          )
          const orderedSliceIds = augmentSliceCandidateIdsForDebug(
            graph,
            runtimeExpandedSliceIds,
            sliced.metadata,
          )
          orderedCandidates = orderedSliceIds.map((nodeId, index) => (
            scoredById.get(nodeId)
              ?? scoredNodeFromGraph(
                graph,
                nodeId,
                Math.max(0.25, 2 - (index * 0.1)),
                classificationRootPath,
              )
          ))
          sliceMetadata = sliced.metadata
        }
      }
      return {
        candidate_count: orderedCandidates.length,
        orderedCandidates,
        retrieveGraphSignals,
        sliceMetadata,
      }
    },
    options.onStageDiagnostic,
  )
  const { orderedCandidates, retrieveGraphSignals, sliceMetadata } = rankingOutput

  return buildRetrieveResultFromOrderedCandidates(
    graph,
    options,
    orderedCandidates,
    communities,
    communityLabels,
    retrieveGraphSignals,
    retrievalGate,
    graphRootPath,
    sliceMetadata,
  )
}

function selectedNodeIds(result: RetrieveResult): string[] {
  return [...new Set(
    result.matched_nodes
      .map((node) => matchedNodeId(node))
      .filter((nodeId): nodeId is string => nodeId !== null),
  )]
}

function selectedSourceFiles(result: RetrieveResult): Set<string> {
  return new Set(
    result.matched_nodes
      .map((node) => node.source_file.trim())
      .filter((sourceFile) => sourceFile.length > 0),
  )
}

function selectedWorkflowCoherence(graph: KnowledgeGraph, nodeIds: readonly string[]): number {
  if (nodeIds.length === 0) {
    return 0
  }
  if (nodeIds.length === 1) {
    return 1
  }

  const visited = new Set<string>()
  let largestComponent = 0
  for (const start of nodeIds) {
    if (visited.has(start) || !graph.hasNode(start)) {
      continue
    }
    const queue = [start]
    visited.add(start)
    let componentSize = 0
    while (queue.length > 0) {
      const current = queue.shift()
      if (!current) {
        break
      }
      componentSize += 1
      // The delivered set is small and budget-bounded. Checking only pairs in
      // that set is exact and avoids materializing every neighbor of a selected
      // god node merely to discard nodes that were not delivered.
      for (const candidate of nodeIds) {
        if (
          candidate !== current
          && !visited.has(candidate)
          && (graph.hasEdge(current, candidate) || graph.hasEdge(candidate, current))
        ) {
          visited.add(candidate)
          queue.push(candidate)
        }
      }
    }
    largestComponent = Math.max(largestComponent, componentSize)
  }
  return Number((largestComponent / nodeIds.length).toFixed(3))
}

function retrievalQualitySnapshot(graph: KnowledgeGraph, result: RetrieveResult): RetrievalQualitySnapshot {
  const nodeIds = selectedNodeIds(result)
  const explicitSliceAnchors = result.slice?.anchors.filter((anchor) => (
    anchor.reason === 'symbol mention' || anchor.reason === 'path mention'
  )).length ?? 0
  const explicitGateAnchors = (result.retrieval_gate?.signals.mentioned_symbols.length ?? 0)
    + (result.retrieval_gate?.signals.mentioned_paths.length ?? 0)
  return {
    selected_nodes: nodeIds.length,
    selected_files: selectedSourceFiles(result).size,
    direct_matches: result.matched_nodes.filter((node) => node.relevance_band === 'direct').length,
    explicit_anchors: Math.max(explicitSliceAnchors, explicitGateAnchors),
    workflow_coherence: selectedWorkflowCoherence(graph, nodeIds),
    missing_required_evidence: result.coverage?.missing_required.length ?? 0,
    missing_semantic_evidence: result.coverage?.missing_semantic.length ?? 0,
    token_count: result.token_count,
  }
}

function notNeededRetrievalPlan(quality: RetrievalQualitySnapshot): ContextPackRetrievalPlanDetail {
  return {
    version: 1,
    status: 'not_needed',
    reasons: [],
    initial: quality,
    final: quality,
    attempts: [],
  }
}

function retrieveContextWithConceptualFallback(graph: KnowledgeGraph, options: RetrieveOptions): RetrieveResult {
  const initial = retrieveContextPass(graph, options)
  const initialQuality = retrievalQualitySnapshot(graph, initial)
  if (
    tokenizeQuestion(options.question).length === 0
    || initial.retrieval_gate?.level === 0
    // Implementation packs already run the dedicated task-context planner over
    // this result. Re-ranking their seed set here makes that planner less
    // stable without improving conceptual answerability.
    || options.taskKind === 'implement'
  ) {
    return { ...initial, retrieval_plan: notNeededRetrievalPlan(initialQuality) }
  }

  const proposal = planConceptualFallback(graph, {
    question: options.question,
    initialQuality,
    selectedNodes: initial.matched_nodes.flatMap((node) => {
      const nodeId = matchedNodeId(node)
      return nodeId
        ? [{
            nodeId,
            sourceFile: node.source_file,
            relevanceBand: node.relevance_band,
            matchScore: node.match_score,
          }]
        : []
    }),
    ...(options.community !== undefined ? { community: options.community } : {}),
    ...(options.fileType !== undefined ? { fileType: options.fileType } : {}),
  })
  if (proposal.nodeBoosts.size === 0) {
    return { ...initial, retrieval_plan: proposal.plan }
  }

  const preserveConceptualObligationOrder = initialQuality.explicit_anchors === 0
    && (proposal.plan.query_obligations?.total ?? 0) >= 4
  const recovered = retrieveContextPass(
    graph,
    options,
    proposal.nodeBoosts,
    preserveConceptualObligationOrder,
  )
  const finalized = finalizeConceptualFallbackPlan(
    proposal,
    retrievalQualitySnapshot(graph, recovered),
    selectedSourceFiles(initial),
    selectedSourceFiles(recovered),
    new Set(selectedNodeIds(recovered)),
  )
  return {
    ...(finalized.useRecovered ? recovered : initial),
    retrieval_plan: finalized.plan,
  }
}

const recoverContextPackWithStage = (
  graph: KnowledgeGraph,
  initial: RetrieveResult,
  options: RetrieveOptions,
  runPass: (nodeBoosts: ReadonlyMap<string, number>) => RetrieveResult,
): RetrieveResult => {
  const recoveryStage = startRetrievalRecoveryStage({
    selected_node_count: initial.matched_nodes.length,
  }, options.onStageDiagnostic)
  try {
    const result = recoverContextPackResult(graph, initial, options, runPass)
    recoveryStage.complete({
      selected_node_count: result.matched_nodes.length,
      insufficient: result.recovery?.final_state === 'insufficient',
    })
    return result
  } catch (error) {
    recoveryStage.fail()
    throw error
  }
}

export function retrieveContext(graph: KnowledgeGraph, options: RetrieveOptions): RetrieveResult {
  const initial = retrieveContextWithConceptualFallback(graph, options)
  return recoverContextPackWithStage(
    graph,
    initial,
    options,
    (nodeBoosts) => retrieveContextPass(graph, options, nodeBoosts),
  )
}

export async function retrieveContextAsync(graph: KnowledgeGraph, options: RetrieveOptions): Promise<RetrieveResult> {
  const lexicalResult = retrieveContextWithConceptualFallback(graph, options)
  if (options.semantic !== true && options.rerank !== true) {
    return recoverContextPackWithStage(
      graph,
      lexicalResult,
      options,
      (nodeBoosts) => retrieveContextPass(graph, options, nodeBoosts),
    )
  }

  const questionTokens = tokenizeQuestion(options.question)
  if (questionTokens.length === 0) {
    return recoverContextPackWithStage(
      graph,
      lexicalResult,
      options,
      (nodeBoosts) => retrieveContextPass(graph, options, nodeBoosts),
    )
  }

  const frameworkProfile = buildFrameworkQuestionProfile(options.question, questionTokens)
  const activeFrameworks = activeFrameworksForProfile(frameworkProfile)
  const graphRootPath = typeof graph.graph.root_path === 'string' && graph.graph.root_path.length > 0
    ? graph.graph.root_path
    : undefined
  const classificationRootPath = inferredGraphRoot(graph)
  const communities = communitiesFromGraph(graph)
  const communityLabels: Record<number, string> = {
    ...buildCommunityLabels(graph, communities),
    ...storedCommunityLabelsFromGraph(graph),
  }
  const retrieveGraphSignals = graphSignalsForRetrieve(graph, communities, communityLabels)

  const lexicalScoresById = new Map(
    lexicalResult.matched_nodes.flatMap((node) => {
      const nodeId = matchedNodeId(node)
      return nodeId ? [[nodeId, node.match_score] as const] : []
    }),
  )
  const lexicalBandsById = new Map(
    lexicalResult.matched_nodes.flatMap((node) => {
      const nodeId = matchedNodeId(node)
      return nodeId ? [[nodeId, node.relevance_band] as const] : []
    }),
  )
  const lexicalSliceIds = options.retrievalStrategy === 'slice-v1'
    ? new Set(
        lexicalResult.matched_nodes
          .map((node) => matchedNodeId(node))
          .filter((nodeId): nodeId is string => nodeId !== null),
      )
    : null

  const questionLower = options.question.toLowerCase()
  const candidatesById = new Map(
    eligibleNodeEntries(graph, options)
      .map(([id, attributes]) => [id, scoredNodeFromGraphEntry(id, attributes, frameworkProfile, questionLower, classificationRootPath)] as const),
  )
  if (candidatesById.size === 0) {
    return recoverContextPackWithStage(
      graph,
      lexicalResult,
      options,
      (nodeBoosts) => retrieveContextPass(graph, options, nodeBoosts),
    )
  }

  let semanticScores = new Map<string, number>()
  let rerankScores = new Map<string, number>()
  if (options.semantic === true) {
    const { rankCandidatesBySemanticSimilarity } = await import('./semantic.js')
    semanticScores = await rankCandidatesBySemanticSimilarity(
      options.question,
      [...candidatesById.values()].map((node) => ({ id: node.id, text: semanticTextForNode(node) })),
      {
        ...(options.semanticModel ? { model: options.semanticModel } : {}),
        ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      },
    )
  }

  const candidateIds = new Set<string>(lexicalScoresById.keys())
  if (semanticScores.size > 0) {
    for (const [candidateId] of [...semanticScores.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)) {
      if (lexicalSliceIds !== null && !lexicalSliceIds.has(candidateId)) {
        continue
      }
      candidateIds.add(candidateId)
    }
  }

  if (candidateIds.size === 0) {
    return recoverContextPackWithStage(
      graph,
      lexicalResult,
      options,
      (nodeBoosts) => retrieveContextPass(graph, options, nodeBoosts),
    )
  }

  const candidatePool = [...candidateIds]
    .map((candidateId) => candidatesById.get(candidateId))
    .filter((candidate): candidate is ScoredNode => candidate !== undefined)

  if (options.rerank === true && candidatePool.length > 0) {
    const { rerankCandidatesWithCrossEncoder } = await import('./semantic.js')
    rerankScores = await rerankCandidatesWithCrossEncoder(
      options.question,
      candidatePool.map((node) => ({ id: node.id, text: semanticTextForNode(node) })),
      {
        ...(options.rerankerModel ? { model: options.rerankerModel } : {}),
        ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      },
    )
  }

  for (const candidate of candidatePool) {
    const lexicalScore = lexicalScoresById.get(candidate.id) ?? 0
    const semanticScore = semanticScores.get(candidate.id) ?? 0
    const rerankScore = rerankScores.get(candidate.id) ?? 0
    // CodeRabbit fix: when this candidate already won lexical retrieval
    // (lexicalScore > 0), frameworkBoost is ALREADY baked into
    // match_score by retrieveContext upstream — adding it here would
    // double-count. Only add it for semantic-only candidates where the
    // lexical pass missed but the metadata signal is real.
    const additionalFrameworkBoost = lexicalScore > 0 ? 0 : candidate.frameworkBoost
    candidate.score = lexicalScore + additionalFrameworkBoost + (semanticScore * 3) + (rerankScore * 4)
    candidate.evidenceTier = lexicalScore > 0 ? 2 : semanticScore > 0 || rerankScore > 0 ? 1 : 0
    candidate.relevanceBand = lexicalBandsById.get(candidate.id) ?? (semanticScore >= 0.75 || rerankScore >= 0.75 ? 'direct' : 'related')
    candidate.exactLabelMatch = lexicalScore > 0
  }

  candidatePool.sort((left, right) => compareScoredNodes(graph, left, right))

  const orderedCandidates = frameworkProfile.frameworkShaped
    ? [
        ...candidatePool.filter((node) => isFrameworkCompatible(activeFrameworks, node.framework)),
        ...candidatePool.filter((node) => !isFrameworkCompatible(activeFrameworks, node.framework)),
      ]
    : candidatePool

  const semanticResult = buildRetrieveResultFromOrderedCandidates(
    graph,
    options,
    orderedCandidates,
    communities,
    communityLabels,
    retrieveGraphSignals,
    lexicalResult.retrieval_gate ?? classifyRetrievalLevel({
      prompt: options.question,
      ...(options.retrievalLevel !== undefined ? { manualOverride: options.retrievalLevel } : {}),
    }),
    graphRootPath,
    lexicalResult.slice,
  )
  const semanticWithPlan = {
    ...semanticResult,
    ...(lexicalResult.retrieval_plan ? { retrieval_plan: lexicalResult.retrieval_plan } : {}),
  }
  return recoverContextPackWithStage(
    graph,
    semanticWithPlan,
    options,
    (nodeBoosts) => retrieveContextPass(graph, options, nodeBoosts),
  )
}

export function compactRetrieveResult(result: RetrieveResult, options: RetrieveSnippetOptions = {}): CompactRetrieveResult {
  const frameworkProfile = buildFrameworkQuestionProfile(result.question, tokenizeQuestion(result.question))
  const compactFrameworkLimit =
    frameworkProfile.frameworkShaped && result.matched_nodes.some((node) => (node.framework_boost ?? 0) > 0) ? 5 : Number.POSITIVE_INFINITY
  const fullPack = contextPackFromRetrieveResult(result)
  const executionSlice = compactExecutionSlice(result.execution_slice)
  const promotedSliceNodeIds = promotedSliceCompactNodeIds(result)
  const promotedSliceLabels = promotedSliceCompactLabels(result)
  const compactPack = promotedSliceNodeIds.length > 0 || promotedSliceLabels.length > 0
    ? compactContextPack(fullPack, {
        kind: 'review',
        seed_node_ids: promotedSliceNodeIds,
        seed_labels: promotedSliceLabels,
        max_supporting_nodes: 0,
      })
    : compactContextPack(fullPack, {
        kind: 'retrieve',
        ...(Number.isFinite(compactFrameworkLimit) ? { max_nodes: compactFrameworkLimit } : {}),
      })
  const shapedNodes = applyRetrieveSnippetBudgetToNodes(compactPack.nodes, options)
  const compactPackNodeTokenCount = compactPack.nodes.reduce(
    (total, node) => total + estimateRetrieveEntryTokens(node.label, node.source_file, node.line_number, node.snippet ?? null),
    0,
  )
  const shapedNodeTokenCount = shapedNodes.nodes.reduce(
    (total, node) => total + estimateRetrieveEntryTokens(node.label, node.source_file, node.line_number, node.snippet ?? null),
    0,
  )

  return {
    question: result.question,
    token_count: Math.max(0, compactPack.token_count - compactPackNodeTokenCount + shapedNodeTokenCount),
    matched_nodes: shapedNodes.nodes.map(({ evidence_class: _evidenceClass, ...node }) => node as CompactRetrieveMatchedNode),
    relationships: compactPack.relationships,
    community_context: compactPack.community_context,
    graph_signals: compactPack.graph_signals ?? { god_nodes: [], bridge_nodes: [] },
    ...(compactPack.shared_file_type ? { shared_file_type: compactPack.shared_file_type } : {}),
    retrieval_strategy: result.retrieval_strategy ?? 'default',
    ...(result.retrieval_plan ? { retrieval_plan: result.retrieval_plan } : {}),
    ...(result.recovery ? { recovery: result.recovery } : {}),
    snippet_budget_tokens_used: shapedNodes.usedTokens,
    snippet_budget_tokens_remaining: shapedNodes.remainingTokens,
    ...(result.slice ? { slice: result.slice } : {}),
    ...(executionSlice ? { execution_slice: executionSlice } : {}),
    ...(result.answer_contract ? { answer_contract: result.answer_contract } : {}),
    ...(result.retrieval_gate ? { retrieval_gate: result.retrieval_gate } : {}),
  }
}

interface RetrieveStdioCompactionProfile {
  matchedNodeCap: number
  relationshipCap: number
  communityCap: number
  claimCap: number
  expandableCap: number
  expandablePreviewCap: number
  expandableFocusFileCap: number
  expandableFocusRangeCap: number
  slicePathCap: number
}

const STDIO_RETRIEVE_COMPACTION_PROFILES: readonly RetrieveStdioCompactionProfile[] = [
  {
    matchedNodeCap: STDIO_RETRIEVE_MATCHED_NODE_CAP,
    relationshipCap: STDIO_RETRIEVE_RELATIONSHIP_CAP,
    communityCap: STDIO_RETRIEVE_COMMUNITY_CAP,
    claimCap: STDIO_RETRIEVE_CLAIM_CAP,
    expandableCap: STDIO_RETRIEVE_EXPANDABLE_CAP,
    expandablePreviewCap: STDIO_RETRIEVE_EXPANDABLE_PREVIEW_CAP,
    expandableFocusFileCap: STDIO_RETRIEVE_EXPANDABLE_FOCUS_FILE_CAP,
    expandableFocusRangeCap: STDIO_RETRIEVE_EXPANDABLE_FOCUS_RANGE_CAP,
    slicePathCap: STDIO_RETRIEVE_SLICE_PATH_CAP,
  },
  {
    matchedNodeCap: 8,
    relationshipCap: 8,
    communityCap: 4,
    claimCap: 3,
    expandableCap: 2,
    expandablePreviewCap: 2,
    expandableFocusFileCap: 8,
    expandableFocusRangeCap: 8,
    slicePathCap: 8,
  },
  {
    matchedNodeCap: 4,
    relationshipCap: 4,
    communityCap: 3,
    claimCap: 2,
    expandableCap: 1,
    expandablePreviewCap: 2,
    expandableFocusFileCap: 4,
    expandableFocusRangeCap: 4,
    slicePathCap: 4,
  },
] as const

function estimateRetrievePayloadTokens(payload: object): number {
  return estimateQueryTokens(JSON.stringify(payload))
}

function compactExpandableRefsForStdio(
  expandable: readonly ContextPackExpandableRef[],
  profile: RetrieveStdioCompactionProfile,
): ContextPackExpandableRef[] {
  return expandable.slice(0, profile.expandableCap).map((entry) => ({
    kind: entry.kind,
    handle_id: entry.handle_id,
    evidence_class: entry.evidence_class,
    count: entry.count,
    preview: entry.preview.slice(0, profile.expandablePreviewCap).map((preview) => ({
      ...(typeof preview.node_id === 'string' ? { node_id: preview.node_id } : {}),
      label: preview.label,
      source_file: preview.source_file,
      ...(preview.line_range
        ? {
            line_range: {
              start_line: preview.line_range.start_line,
              end_line: preview.line_range.end_line,
            },
          }
        : {}),
    })),
    follow_up: {
      kind: entry.follow_up.kind,
      task_kind: entry.follow_up.task_kind,
      evidence_class: entry.follow_up.evidence_class,
      focus_files: entry.follow_up.focus_files.slice(0, profile.expandableFocusFileCap),
      focus_ranges: entry.follow_up.focus_ranges.slice(0, profile.expandableFocusRangeCap).map((range) => ({
        source_file: range.source_file,
        start_line: range.start_line,
        end_line: range.end_line,
      })),
    },
  }))
}

function compactSliceForStdio(
  slice: ContextPackSliceMetadata,
  profile: RetrieveStdioCompactionProfile,
): ContextPackSliceMetadata {
  return {
    mode: slice.mode,
    anchors: slice.anchors.map((anchor) => ({
      ...(typeof anchor.node_id === 'string' ? { node_id: anchor.node_id } : {}),
      label: anchor.label,
      reason: anchor.reason,
    })),
    directions: [...slice.directions],
    selected_paths: slice.selected_paths.slice(0, profile.slicePathCap).map((path) => ({
      ...(typeof path.from_id === 'string' ? { from_id: path.from_id } : {}),
      from: path.from,
      ...(typeof path.to_id === 'string' ? { to_id: path.to_id } : {}),
      to: path.to,
      relation: path.relation,
      direction: path.direction,
    })),
    ...(typeof slice.selected_path_count === 'number' ? { selected_path_count: slice.selected_path_count } : {}),
  }
}

function compactRetrievePayloadForStdioProfile(
  payload: StdioRetrieveResult,
  profile: RetrieveStdioCompactionProfile,
): StdioRetrieveResult {
  const matchedNodes = payload.matched_nodes.slice(0, profile.matchedNodeCap)
  const retainedNodeIds = new Set(
    matchedNodes
      .map((node) => node.node_id)
      .filter((nodeId): nodeId is string => typeof nodeId === 'string'),
  )
  const retainsRelationshipEndpoints = (relationship: RetrieveRelationship): boolean =>
    (typeof relationship.from_id !== 'string' || retainedNodeIds.has(relationship.from_id))
    && (typeof relationship.to_id !== 'string' || retainedNodeIds.has(relationship.to_id))
  return {
    ...payload,
    matched_nodes: matchedNodes,
    relationships: payload.relationships
      .filter((relationship) => retainsRelationshipEndpoints(relationship))
      .slice(0, profile.relationshipCap),
    community_context: payload.community_context.slice(0, profile.communityCap),
    ...(payload.claims ? { claims: payload.claims.slice(0, profile.claimCap) } : {}),
    ...(payload.expandable ? { expandable: compactExpandableRefsForStdio(payload.expandable, profile) } : {}),
    ...(payload.slice ? { slice: compactSliceForStdio(payload.slice, profile) } : {}),
  }
}

export function compactRetrieveResultForStdio(result: RetrieveResult, options: RetrieveStdioOptions = {}): StdioRetrieveResult {
  const compactResult = compactRetrieveResult(result, options)
  let payload: StdioRetrieveResult = {
    question: result.question,
    token_count: compactResult.token_count,
    matched_nodes: compactResult.matched_nodes,
    relationships: compactResult.relationships,
    community_context: compactResult.community_context,
    graph_signals: compactResult.graph_signals,
    ...(compactResult.shared_file_type ? { shared_file_type: compactResult.shared_file_type } : {}),
    ...(result.claims ? { claims: result.claims } : {}),
    ...(result.expandable ? { expandable: result.expandable } : {}),
    ...(result.coverage ? { coverage: result.coverage } : {}),
    retrieval_strategy: result.retrieval_strategy ?? 'default',
    ...(result.retrieval_plan ? { retrieval_plan: result.retrieval_plan } : {}),
    ...(result.recovery ? { recovery: result.recovery } : {}),
    snippet_budget_tokens_used: compactResult.snippet_budget_tokens_used,
    snippet_budget_tokens_remaining: compactResult.snippet_budget_tokens_remaining,
    ...(result.slice ? { slice: result.slice } : {}),
    ...(compactResult.execution_slice ? { execution_slice: compactResult.execution_slice } : {}),
    ...(result.answer_contract ? { answer_contract: result.answer_contract } : {}),
    ...(result.retrieval_gate ? { retrieval_gate: result.retrieval_gate } : {}),
  }

  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_RETRIEVE_STDIO_OUTPUT_TOKENS
  if (estimateRetrievePayloadTokens(payload) <= maxOutputTokens) {
    return payload
  }

  for (const profile of STDIO_RETRIEVE_COMPACTION_PROFILES) {
    payload = compactRetrievePayloadForStdioProfile(payload, profile)
    if (estimateRetrievePayloadTokens(payload) <= maxOutputTokens) {
      return payload
    }
  }

  return payload
}
