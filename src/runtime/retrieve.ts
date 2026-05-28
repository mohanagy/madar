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
import type { TaskIntentKind } from '../contracts/task-intent.js'
import { KnowledgeGraph } from '../contracts/graph.js'
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
  type ContextPackSelectionStrategy,
  type ContextPackNodeCandidate,
} from './context-pack.js'
import type { RetrievalGateDecision, RetrievalLevel } from '../contracts/retrieval-gate.js'
import { classifyRetrievalLevel } from './retrieval-gate.js'
import { defaultContextKindForTaskIntent } from './task-intent.js'
import {
  expansionPolicyForLevel,
  predecessorAllowedForPolicy,
  relationAllowedForPolicy,
  relationIsPrimaryForPolicy,
} from './retrieve/expansion.js'
import { sliceCandidatesForRetrieve } from './retrieve/slicing.js'
import { communitiesFromGraph, estimateQueryTokens } from './serve.js'

const SNIPPET_HALF_WINDOW = 7
const DERIVED_SNIPPET_HALF_WINDOW = 1
const MAX_SNIPPET_LINE_LENGTH = 200
export const DEFAULT_RETRIEVE_SNIPPET_BUDGET = 3000
export const DEFAULT_RETRIEVE_TOP_N_WITH_SNIPPET = 8
const BM25_K1 = 1.2
const BM25_B = 0.6
const SEED_FUSION_SCORE_SCALE = 10

const STOP_WORDS = new Set([
  'how', 'does', 'the', 'is', 'a', 'an', 'in', 'to',
  'of', 'and', 'or', 'what', 'where', 'when', 'why',
  'which', 'this', 'that', 'with', 'for', 'from', 'are',
  'do', 'it', 'be', 'has', 'have', 'was', 'were', 'been',
  'can', 'could', 'would', 'should', 'will', 'may', 'might',
  'not', 'but', 'if', 'then', 'so', 'about', 'up', 'out',
  'on', 'at', 'by', 'into', 'all', 'my', 'its', 'no', 'i',
])

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
  /** #75 manual override for the retrieval gate. When set (0-5), the gate
   *  bypasses heuristic classification and emits a decision with reason
   *  'manual override' at the supplied level. Caller-side surface for the
   *  acceptance criterion that the gate be overridable via CLI/MCP. */
  retrievalLevel?: RetrievalLevel
  /** Internal additive override for benchmarks/tests. */
  selectionStrategy?: ContextPackSelectionStrategy
  retrievalStrategy?: ContextPackRetrievalStrategy
  snippetBudget?: number
  topNWithSnippet?: number
}

export interface RetrieveSnippetOptions {
  snippetBudget?: number
  topNWithSnippet?: number
}

function effectiveRetrieveTaskKind(options: RetrieveOptions): ContextPackTaskKind {
  if (options.taskKind) {
    return options.taskKind
  }
  if (options.taskIntent) {
    return defaultContextKindForTaskIntent(options.taskIntent)
  }
  return 'explain'
}

function classifyRetrieveTaskContract(options: RetrieveOptions): ContextPackTaskContract {
  return classifyTaskContract(effectiveRetrieveTaskKind(options), {
    budget: options.budget,
    prompt: options.question,
    ...(options.taskIntent ? { task_intent: options.taskIntent } : {}),
  })
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

export function tokenizeQuestion(question: string): string[] {
  return question
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_\\\-./,:;!?'"()[\]{}]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
}

export function tokenizeLabel(label: string): string[] {
  return label
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_\\\-./,:;!?'"()[\]{}]+/)
    .filter((token) => token.length > 1)
}

function tokenMatchCount(questionToken: string, labelTokens: readonly string[]): number {
  let matches = 0
  for (const labelToken of labelTokens) {
    if (labelToken.startsWith(questionToken) || questionToken.startsWith(labelToken)) {
      matches += 1
    }
  }
  return matches
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

  for (const key of ['route_path', 'http_method', 'mount_path', 'slice_name', 'procedure_name', 'router_name', 'storage_operation'] as const) {
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
  labelTokenScore: number
  sourcePathScore: number
  communityScore: number
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

function activeFrameworksForProfile(profile: FrameworkQuestionProfile): ReadonlySet<string> {
  const frameworks = new Set<string>()
  if (profile.express) frameworks.add('express')
  if (profile.routingControllers) frameworks.add('routing-controllers')
  if (profile.redux) frameworks.add('redux-toolkit')
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

function evidenceTierForSeedScore(score: SeedScoreBreakdown): 0 | 1 | 2 {
  if (score.labelExactScore > 0 || score.labelTokenScore > 0) {
    return 2
  }
  if (score.sourcePathScore > 0 || score.communityScore > 0) {
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
  tokenWeights: ReadonlyMap<string, number>,
  averageLabelLength: number,
  options: { fileNodeLike: boolean; fileOrientedQuestion: boolean },
): SeedScoreBreakdown {
  const labelExactScore = normalizeSeedText(question) !== '' && normalizeSeedText(question) === normalizeSeedText(label) ? 2 : 0
  const fileNodePenaltyApplies = options.fileNodeLike && !options.fileOrientedQuestion && labelExactScore === 0
  const labelTokenScore = fileNodePenaltyApplies ? 0 : scoreNode(questionTokens, tokenizeLabel(label), tokenWeights, averageLabelLength)
  const sourcePathScore = fileNodePenaltyApplies ? 0 : scoreNode(questionTokens, tokenizeLabel(sourceFile), tokenWeights) * 0.25
  const communityScore = fileNodePenaltyApplies
    ? 0
    : communityLabel
    ? Math.min(scoreNode(questionTokens, tokenizeLabel(communityLabel)) * 0.1, 0.2)
    : 0

  return {
    labelExactScore,
    labelTokenScore,
    sourcePathScore,
    communityScore,
    total: labelExactScore + labelTokenScore + sourcePathScore + communityScore,
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
      addPromoted(step.node_id)
      addPromotedByLabel(step.label)
    }
    for (const step of result.execution_slice?.primary_path?.steps ?? []) {
      executionStepLabels.add(step.label)
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
    addPromotedLabel(step.label, typeof step.node_id === 'string' ? matchedById.get(step.node_id) : undefined)
    }
    for (const step of result.execution_slice?.primary_path?.steps ?? []) {
    executionStepLabels.add(step.label)
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
  const lower = `${node.label} ${node.source_file} ${node.node_kind ?? ''} ${node.framework_role ?? ''}`.toLowerCase()
  return /\b(?:route|controller|handler|endpoint)\b/.test(lower)
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
  return /\b(?:notify|notification|webhook|publish|emit|event|broadcast)\b/.test(lower)
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
  if (promptExplicitlyWantsRuntimeHandoff(question) || (!promptWantsDetailedReportGenerationPhases(question) && promptWantsRuntimePipeline(question))) {
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
  const seenEdges = new Set<string>()
  const record = (edge: ExecutionFlowEdge): void => {
    const edgeKey = `${edge.fromId}:${edge.relation}:${edge.toId}`
    if (seenEdges.has(edgeKey)) {
      return
    }
    seenEdges.add(edgeKey)
    const current = adjacency.get(edge.fromId) ?? []
    current.push(edge)
    adjacency.set(edge.fromId, current)
  }

  for (const path of sliceMetadata.selected_paths) {
    if (path.direction !== 'forward' || !executionSliceFlowRelation(path.relation)) {
      continue
    }
    const fromId = resolveNodeId(path.from_id, path.from)
    const toId = resolveNodeId(path.to_id, path.to)
    if (!fromId || !toId || !idSet.has(fromId) || !idSet.has(toId)) {
      continue
    }
    record({ fromId, toId, relation: path.relation })
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
      record({ fromId, toId, relation })
    }
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

  for (const nodeId of primaryPath.nodeIds) {
    for (const edge of adjacency.get(nodeId) ?? []) {
      const edgeKey = `${edge.fromId}:${edge.relation}:${edge.toId}`
      if (primaryEdgeKeys.has(edgeKey) || branchStartSeen.has(edgeKey)) {
        continue
      }
      branchStartSeen.add(edgeKey)

      const branchCandidates = enumerateExecutionPaths(adjacency, edge.toId, primaryNodeIds, 4)
      const branchPath = branchCandidates.sort((left, right) =>
        executionPathScore(right, nodeById, question) - executionPathScore(left, nodeById, question)
      )[0] ?? { nodeIds: [edge.toId], edges: [] }
      const branchSteps = branchPath.nodeIds
        .map((id) => nodeById.get(id))
        .filter((step): step is ContextPackExecutionSliceStep => step !== undefined)
        .slice(0, 3)
      const branchKind = classifyExecutionBranch(branchSteps, question)
      const branchReason = branchBoundaryReason(branchSteps, branchKind, question)

      if (branchKind === 'side_effect' && sideEffects.length < 3) {
        sideEffects.push({
          steps: branchSteps,
          ...(branchReason ? { boundary_reason: branchReason } : {}),
        })
        continue
      }

      if (branchKind === 'terminal' && terminalBoundaries.length < 3) {
        terminalBoundaries.push({
          steps: branchSteps,
          ...(branchReason ? { boundary_reason: branchReason } : {}),
        })
        continue
      }

      if (omittedBranches.length < 6) {
        omittedEvidenceSteps.push(...branchSteps)
        const from = nodeById.get(edge.fromId)?.label
        const to = nodeById.get(edge.toId)?.label
        omittedBranches.push({
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          relation: edge.relation,
          ...(branchReason ? { reason: branchReason } : {}),
        })
      }
    }
  }

  return { sideEffects, terminalBoundaries, omittedBranches, omittedEvidenceSteps }
}

function pickExecutionSliceStart(
  graph: KnowledgeGraph,
  anchorIds: readonly string[],
  orderedIds: readonly string[],
  idSet: ReadonlySet<string>,
  nodeById: ReadonlyMap<string, ContextPackExecutionSliceStep>,
  question: string,
): string | undefined {
  const anchoredStart = anchorIds.find((nodeId) => idSet.has(nodeId))
  if (anchoredStart) {
    return anchoredStart
  }

  const roots = orderedIds.filter((nodeId) =>
    [...graph.predecessors(nodeId)].every((predecessorId) =>
      !idSet.has(predecessorId)
      || !executionSliceFlowRelation(String(graph.edgeAttributes(predecessorId, nodeId).relation ?? 'related_to')),
    ),
  )
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
  const lowValuePrimaryPath = primaryPathSteps.length > 0
    && primaryPathSteps.filter((step) => lowValueExecutionStepForQuestion(step, question)).length >= Math.ceil(primaryPathSteps.length / 2)

  if (explicitAnchor && runtimeHandoff && executionSlice.status === 'complete' && expectedPhasesCovered) {
    return {
      confidence: 'high',
      confidence_reasons: [
        'explicit_anchor',
        'runtime_handoff_evidence',
        'expected_phases_covered',
      ],
    }
  }

  if (runtimeHandoff && missingPhases.length === 1) {
    return {
      confidence: 'medium',
      confidence_reasons: [
        'runtime_handoff_evidence',
        `missing_phase:${missingPhases[0]}`,
      ],
    }
  }

  const lowConfidenceReasons = [
    ...(!runtimeHandoff ? ['no_runtime_handoff'] : []),
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
      'mention missing or uncertain phases when the execution slice is partial',
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
  const { orderedIds, idSet } = collectExecutionSliceScope(graph, sliceMetadata, anchorIds, question, resolveNodeId)
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
  const startId = pickExecutionSliceStart(graph, anchorIds, orderedIds, idSet, nodeById, question)
  if (!startId) {
    return {
      status: 'partial',
      confidence: 'low',
      confidence_reasons: ['slice_missing_runtime_path', 'no_runtime_handoff'],
      boundary_reason: 'slice missing runtime path',
      steps: [],
    }
  }

  const adjacency = executionFlowAdjacency(graph, sliceMetadata, idSet, question, resolveNodeId)
  const pathCandidates = enumerateExecutionPaths(adjacency, startId)
  const primaryPathCandidates = pathCandidates.length > 0 ? pathCandidates : [{
    nodeIds: walkExecutionSlice(graph, startId, idSet, nodeById, question),
    edges: [] as ExecutionFlowEdge[],
  }]
  const primaryPath = primaryPathCandidates.sort((left, right) =>
    executionPathScore(right, nodeById, question) - executionPathScore(left, nodeById, question)
  )[0]!

  const steps = primaryPath.nodeIds
    .map((nodeId) => nodeById.get(nodeId))
    .filter((step): step is ContextPackExecutionSliceStep => step !== undefined)
  const boundaries = primaryPathBoundaries(primaryPath, nodeById)
  const scopeSteps = orderedIds
    .map((nodeId) => nodeById.get(nodeId))
    .filter((step): step is ContextPackExecutionSliceStep => step !== undefined)
  const branches = collectExecutionBranches(adjacency, primaryPath, nodeById, question)
  const tracedSteps = [
    ...steps,
    ...branches.sideEffects.flatMap((branch) => branch.steps),
    ...branches.terminalBoundaries.flatMap((branch) => branch.steps),
    ...branches.omittedEvidenceSteps,
  ]
  const phaseCoverage = phaseCoverageForPath(steps, boundaries, question, scopeSteps, tracedSteps)
  const missingPhase = phaseCoverage.missing[0]
  const boundaryReason = missingPhase ? missingExecutionPhaseBoundaryReason(missingPhase) : undefined
  const executionSlice: ContextPackExecutionSlice = {
    status: missingPhase ? 'partial' : 'complete',
    ...(boundaryReason ? { boundary_reason: boundaryReason } : {}),
    steps,
    primary_path: {
      steps,
      ...(boundaries.length > 0 ? { boundaries } : {}),
      ...(boundaryReason ? { boundary_reason: boundaryReason } : {}),
    },
    ...(branches.sideEffects.length > 0 ? { side_effects: branches.sideEffects } : {}),
    ...(branches.terminalBoundaries.length > 0 ? { terminal_boundaries: branches.terminalBoundaries } : {}),
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
  const trpc = explicitTrpc || procedureIntent || queryIntent || mutationIntent || subscriptionIntent
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
  const nest = explicitNest || controllerIntent || moduleIntent || guardIntent || interceptorIntent || pipeIntent
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
}

function frameworkBoostForNode(
  profile: FrameworkQuestionProfile,
  nodeKind: string,
  frameworkRole: string,
  metadata: FrameworkNodeMetadata = {},
  questionLower = '',
): number {
  if (!profile.frameworkShaped) {
    return 0
  }

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
      boost += 1.75
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
  const executionSlice = buildExecutionSlice(graph, taskContract, retrievalGate, options.question, sliceMetadata, rootPath)
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

  const pack = compileContextPack<ContextPackNode, RetrieveRelationship, RetrieveCommunityContext>({
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
    selection_strategy: options.selectionStrategy ?? 'value-per-token',
    retrieval_gate: retrievalGate,
  })
  const matchedNodes = pack.nodes as RetrieveMatchedNode[]
  const answerContract = buildRuntimeGenerationAnswerContract(
    taskContract,
    retrievalGate,
    options.question,
    matchedNodes,
    executionSlice,
    sliceMetadata,
  )

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

export function retrieveContext(graph: KnowledgeGraph, options: RetrieveOptions): RetrieveResult {
  const { question, budget } = options
  const questionTokens = tokenizeQuestion(question)
  const graphRootPath = typeof graph.graph.root_path === 'string' && graph.graph.root_path.length > 0
    ? graph.graph.root_path
    : undefined
  const classificationRootPath = inferredGraphRoot(graph)
  const retrievalGate = classifyRetrievalLevel({
    prompt: question,
    ...(options.retrievalLevel !== undefined ? { manualOverride: options.retrievalLevel } : {}),
  })
  const effectiveRetrievalLevel: RetrievalLevel = options.retrievalLevel !== undefined
    ? retrievalGate.level
    : retrievalGate.level === 0
      ? 0
      : (Math.max(retrievalGate.level, 3) as RetrievalLevel)

  if (questionTokens.length === 0) {
    const emptyPack = compileContextPack({
      task_contract: classifyRetrieveTaskContract(options),
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
    const emptyPack = compileContextPack({
      task_contract: classifyRetrieveTaskContract(options),
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
    const metadataBoost = frameworkBoostForNode(
      frameworkProfile,
      nodeKind,
      frameworkRole,
      frameworkMetadataFromAttributes(attributes),
      questionLower,
    )
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
    const domainIntentPenalty = runtimeGenerationSourceDomainPenalty(retrievalGate, sourceDomain, explicitlyAnchored)
    const scriptMigrationPenalty = scriptMigrationPathPenalty(retrievalGate, sourceFile, label, question, explicitlyAnchored)
    const totalSeedScore = effectiveScore.total + anchorScore + metadataBoost + domainAdjustment - sourceDomainPenalty - domainIntentPenalty - scriptMigrationPenalty
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
          total: totalSeedScore,
        },
        exactLabelMatch: effectiveScore.labelExactScore > 0 || exactAnchorMatch,
        literalPathMatch: mentionedPathMatch,
        sourcePathMatch: effectiveScore.sourcePathScore > 0 || mentionedPathMatch,
        // When the seed only made it in via metadata boost, give it at
        // least evidence tier 1 so it's not at the bottom of the heap.
        evidenceTier: metadataBoost > 0 || domainAdjustment > 0
          ? (Math.max(evidenceTierForSeedScore(effectiveScore), 1) as 0 | 1 | 2)
          : (exactAnchorMatch || mentionedPathMatch ? 2 : evidenceTierForSeedScore(effectiveScore)),
        relevanceBand: effectiveScore.labelExactScore > 0 || exactAnchorMatch || effectiveScore.labelTokenScore > 0 ? 'direct' : 'related',
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
    rankedSeedCandidateIds(graph, filteredSeedCandidates, (candidate) => candidate.seedScore.labelTokenScore),
    rankedSeedCandidateIds(graph, filteredSeedCandidates, (candidate) => candidate.seedScore.sourcePathScore),
    rankedSeedCandidateIds(graph, filteredSeedCandidates, (candidate) => candidate.seedScore.communityScore),
  ], {
    weights: [2, 1.5, 0.5, 0.25],
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
  const seedPool = effectiveRetrievalLevel <= 2 && anchoredSeedPool.length > 0 ? anchoredSeedPool : scored

  // Step 3: Multi-hop expansion — take top seeds, expand 2 hops with decaying scores
  const hasExactSeedMatch = seedPool.some((node) => node.exactLabelMatch)
  const seedCount = effectiveRetrievalLevel === 1 && hasExactSeedMatch
    ? Math.min(seedPool.length, 1)
    : Math.min(seedPool.length, expansionPolicy.seed_limit)
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
          const predecessorCommunity = parseCommunityId(graph.nodeAttributes(predecessorId).community)
          if (!predecessorAllowedForPolicy(expansionPolicy.predecessor_mode, seedCommunity, predecessorCommunity)) {
            continue
          }
          const relation = String(graph.edgeAttributes(predecessorId, seed.id).relation ?? 'related_to')
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
          const predecessorCommunity = parseCommunityId(graph.nodeAttributes(predecessorId).community)
          if (!predecessorAllowedForPolicy(expansionPolicy.predecessor_mode, seedCommunity, predecessorCommunity)) {
            continue
          }
          const relation = String(graph.edgeAttributes(predecessorId, hop1Id).relation ?? 'related_to')
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

  // Re-sort: seeds first by score, then neighbors by degree
  scored.sort((a, b) => compareScoredNodes(graph, a, b))

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

  if (options.retrievalStrategy === 'slice-v1') {
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
      const orderedSliceIds = augmentSliceCandidateIdsForDebug(graph, runtimeExpandedSliceIds, sliced.metadata)
      const sliceCandidates = orderedSliceIds.map((nodeId, index) => (
        scoredById.get(nodeId) ?? scoredNodeFromGraph(graph, nodeId, Math.max(0.25, 2 - (index * 0.1)), classificationRootPath)
      ))

      return buildRetrieveResultFromOrderedCandidates(
        graph,
        options,
        sliceCandidates,
        communities,
        communityLabels,
        retrieveGraphSignals,
        retrievalGate,
        graphRootPath,
        sliced.metadata,
      )
    }
  }

  return buildRetrieveResultFromOrderedCandidates(
    graph,
    options,
    inclusionOrder,
    communities,
    communityLabels,
    retrieveGraphSignals,
    retrievalGate,
    graphRootPath,
  )
}

export async function retrieveContextAsync(graph: KnowledgeGraph, options: RetrieveOptions): Promise<RetrieveResult> {
  const lexicalResult = retrieveContext(graph, options)
  if (options.semantic !== true && options.rerank !== true) {
    return lexicalResult
  }

  const questionTokens = tokenizeQuestion(options.question)
  if (questionTokens.length === 0) {
    return lexicalResult
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
    return lexicalResult
  }

  let semanticScores = new Map<string, number>()
  let rerankScores = new Map<string, number>()
  if (options.semantic === true) {
    const { rankCandidatesBySemanticSimilarity } = await import('./semantic.js')
    semanticScores = await rankCandidatesBySemanticSimilarity(
      options.question,
      [...candidatesById.values()].map((node) => ({ id: node.id, text: semanticTextForNode(node) })),
      options.semanticModel ? { model: options.semanticModel } : {},
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
    return lexicalResult
  }

  const candidatePool = [...candidateIds]
    .map((candidateId) => candidatesById.get(candidateId))
    .filter((candidate): candidate is ScoredNode => candidate !== undefined)

  if (options.rerank === true && candidatePool.length > 0) {
    const { rerankCandidatesWithCrossEncoder } = await import('./semantic.js')
    rerankScores = await rerankCandidatesWithCrossEncoder(
      options.question,
      candidatePool.map((node) => ({ id: node.id, text: semanticTextForNode(node) })),
      options.rerankerModel ? { model: options.rerankerModel } : {},
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

  return buildRetrieveResultFromOrderedCandidates(
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
    snippet_budget_tokens_used: shapedNodes.usedTokens,
    snippet_budget_tokens_remaining: shapedNodes.remainingTokens,
    ...(result.slice ? { slice: result.slice } : {}),
    ...(executionSlice ? { execution_slice: executionSlice } : {}),
    ...(result.answer_contract ? { answer_contract: result.answer_contract } : {}),
    ...(result.retrieval_gate ? { retrieval_gate: result.retrieval_gate } : {}),
  }
}

export function compactRetrieveResultForStdio(result: RetrieveResult, options: RetrieveSnippetOptions = {}): RetrieveResult {
  const compactResult = compactRetrieveResult(result, options)
  const originalNodesById = new Map(
    result.matched_nodes
      .map((node) => [matchedNodeId(node), node] as const)
      .filter(([nodeId]) => nodeId !== null) as Array<[string, RetrieveMatchedNode]>,
  )

  const matchedNodes: RetrieveResult['matched_nodes'] = compactResult.matched_nodes.map((node): RetrieveMatchedNode => {
    const original = matchedNodeId(node) !== null ? originalNodesById.get(matchedNodeId(node)!) : undefined
    if (original) {
      return {
        ...stripRetrieveMatchedNodeIdentity(original),
        snippet: node.snippet,
        snippet_truncated: node.snippet_truncated,
      }
    }

    return {
      label: node.label,
      source_file: node.source_file,
      line_number: node.line_number,
      framework_boost: 0,
      file_type: node.file_type ?? compactResult.shared_file_type ?? '',
      snippet: node.snippet,
      snippet_truncated: node.snippet_truncated,
      match_score: node.match_score,
      relevance_band: node.relevance_band,
      community: node.community,
      community_label: null,
      ...(node.node_kind ? { node_kind: node.node_kind } : {}),
    }
  })

  return {
    question: result.question,
    token_count: compactResult.token_count,
    matched_nodes: matchedNodes,
    relationships: compactResult.relationships.map(stripRetrieveRelationshipIdentity),
    community_context: compactResult.community_context,
    graph_signals: compactResult.graph_signals,
    ...(result.task_contract ? { task_contract: result.task_contract } : {}),
    ...(result.claims ? { claims: result.claims } : {}),
    ...(result.expandable ? { expandable: result.expandable } : {}),
    ...(result.coverage ? { coverage: result.coverage } : {}),
    ...(result.selection_diagnostics ? { selection_diagnostics: result.selection_diagnostics } : {}),
    retrieval_strategy: result.retrieval_strategy ?? 'default',
    snippet_budget_tokens_used: compactResult.snippet_budget_tokens_used,
    snippet_budget_tokens_remaining: compactResult.snippet_budget_tokens_remaining,
    ...(result.slice ? { slice: result.slice } : {}),
    ...(compactResult.execution_slice ? { execution_slice: compactResult.execution_slice } : {}),
    ...(result.answer_contract ? { answer_contract: result.answer_contract } : {}),
    ...(result.retrieval_gate ? { retrieval_gate: result.retrieval_gate } : {}),
  }
}
