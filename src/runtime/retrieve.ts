import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'

import type {
  CompiledContextPack,
  ContextPackClaim,
  ContextPackCoverage,
  ContextPackEvidenceClass,
  ContextPackExpandableRef,
  ContextPackNode,
  ContextPackTaskContract,
} from '../contracts/context-pack.js'
import { KnowledgeGraph } from '../contracts/graph.js'
import { godNodes, workspaceBridges } from '../pipeline/analyze.js'
import { type Communities } from '../pipeline/cluster.js'
import { buildCommunityLabels } from '../pipeline/community-naming.js'
import { lineNumberFromSourceLocation } from '../shared/source-location.js'
import { relativizeSourceFile } from '../shared/source-path.js'
import {
  classifyTaskContract,
  compactContextPack,
  compileContextPack,
  estimateContextPackEntryTokens,
  type ContextPackNodeCandidate,
} from './context-pack.js'
import { communitiesFromGraph, estimateQueryTokens } from './serve.js'

const SNIPPET_HALF_WINDOW = 7
const DERIVED_SNIPPET_HALF_WINDOW = 1
const MAX_SNIPPET_LINE_LENGTH = 200
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
  community?: number
  fileType?: string
  semantic?: boolean
  semanticModel?: string
  rerank?: boolean
  rerankerModel?: string
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
  file_type: string
  snippet: string | null
  match_score: number
  relevance_band: 'direct' | 'related' | 'peripheral'
  community: number | null
  community_label: string | null
  evidence_class?: ContextPackEvidenceClass
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
}

export interface CompactRetrieveMatchedNode extends Omit<RetrieveMatchedNode, 'community_label' | 'file_type' | 'framework_boost'> {
  file_type?: string
}

export interface CompactRetrieveResult extends Omit<RetrieveResult, 'matched_nodes'> {
  matched_nodes: CompactRetrieveMatchedNode[]
  shared_file_type?: string
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
    .split(/[\s_\-./,:;!?'"()[\]{}]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
}

export function tokenizeLabel(label: string): string[] {
  return label
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_\-./,:;!?'"()[\]{}]+/)
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

function scoredNodeFromGraphEntry(
  id: string,
  attributes: Record<string, unknown>,
  frameworkProfile: FrameworkQuestionProfile,
): ScoredNode {
  const resolvedLine = resolvedLineNumber(attributes)
  const nodeKind = String(attributes.node_kind ?? '')
  const frameworkRole = String(attributes.framework_role ?? '')

  return {
    id,
    label: String(attributes.label ?? ''),
    sourceFile: String(attributes.source_file ?? ''),
    lineNumber: resolvedLine.lineNumber,
    lineNumberDerived: resolvedLine.derived,
    storedSnippet: storedSnippetFromAttributes(attributes),
    nodeKind,
    framework: typeof attributes.framework === 'string' ? attributes.framework : undefined,
    frameworkRole: frameworkRole || undefined,
    fileType: String(attributes.file_type ?? '').trim().toLowerCase(),
    fileNodeLike: isFileNodeLike(String(attributes.label ?? ''), String(attributes.source_file ?? '')),
    community: parseCommunityId(attributes.community),
    frameworkBoost: frameworkBoostForNode(frameworkProfile, nodeKind, frameworkRole),
    exactLabelMatch: false,
    sourcePathMatch: false,
    evidenceTier: 0,
    score: 0,
    relevanceBand: 'related',
  }
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
  lineNumber: number
  lineNumberDerived: boolean
  storedSnippet: string | null
  nodeKind: string
  framework?: string | undefined
  frameworkRole?: string | undefined
  fileType: string
  fileNodeLike: boolean
  community: number | null
  frameworkBoost: number
  seedScore: SeedScoreBreakdown
  exactLabelMatch: boolean
  sourcePathMatch: boolean
  evidenceTier: 0 | 1 | 2
  relevanceBand: 'direct' | 'related' | 'peripheral'
}

interface ScoredNode {
  id: string
  label: string
  sourceFile: string
  lineNumber: number
  lineNumberDerived: boolean
  storedSnippet: string | null
  nodeKind: string
  framework?: string | undefined
  frameworkRole?: string | undefined
  fileType: string
  fileNodeLike: boolean
  community: number | null
  frameworkBoost: number
  exactLabelMatch: boolean
  sourcePathMatch: boolean
  evidenceTier: 0 | 1 | 2
  score: number
  relevanceBand: 'direct' | 'related' | 'peripheral'
}

interface FrameworkQuestionProfile {
  frameworkShaped: boolean
  express: boolean
  redux: boolean
  reactRouter: boolean
  nest: boolean
  next: boolean
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
}

function activeFrameworksForProfile(profile: FrameworkQuestionProfile): ReadonlySet<string> {
  const frameworks = new Set<string>()
  if (profile.express) frameworks.add('express')
  if (profile.redux) frameworks.add('redux-toolkit')
  if (profile.reactRouter) frameworks.add('react-router')
  if (profile.nest) frameworks.add('nestjs')
  if (profile.next) frameworks.add('nextjs')
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
    graph.degree(right.id) - graph.degree(left.id)
  )
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
      graph.degree(right.id) - graph.degree(left.id)
    ))
    .map((candidate) => candidate.id)
}

function relationWeight(relation: string): number {
  switch (relation) {
    case 'calls':
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

function relationBetweenNodes(graph: KnowledgeGraph, source: string, target: string): string {
  try {
    return String(graph.edgeAttributes(source, target).relation ?? 'related_to')
  } catch {
    try {
      return String(graph.edgeAttributes(target, source).relation ?? 'related_to')
    } catch {
      return 'related_to'
    }
  }
}

function isPrimaryExpansionRelation(relation: string): boolean {
  return (
    relation === 'calls' ||
    relation === 'imports_from' ||
    relation === 'defines' ||
    relation === 'defines_action' ||
    relation === 'defines_selector' ||
    relation === 'contains' ||
    relation === 'renders' ||
    relation === 'loads_route' ||
    relation === 'submits_route' ||
    relation === 'registered_in_store' ||
    relation === 'updates_slice'
  )
}

function includesAnyToken(tokens: readonly string[], candidates: readonly string[]): boolean {
  return candidates.some((candidate) => tokens.includes(candidate))
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

function buildFrameworkQuestionProfile(question: string, questionTokens: readonly string[]): FrameworkQuestionProfile {
  const hasRoutePath = containsUrlLikeRoutePath(question)
  const hasRouteKeyword = includesAnyToken(questionTokens, ['route', 'routes', 'router', 'endpoint', 'endpoints'])
  const hasHttpVerb = hasHttpVerbIntent(question, questionTokens, hasRoutePath, hasRouteKeyword)
  const routeIntent = hasHttpVerb || hasRoutePath || hasRouteKeyword
  const explicitExpress = includesAnyToken(questionTokens, ['express'])
  const explicitRedux = includesAnyToken(questionTokens, ['redux', 'toolkit'])
  const explicitNest = includesAnyToken(questionTokens, ['nest', 'nestjs'])
  const explicitNext = includesAnyToken(questionTokens, ['next', 'nextjs'])
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
  const express = explicitExpress || hasHttpVerb || middlewareIntent || handlerIntent
  const redux = explicitRedux || selectorIntent || sliceIntent || storeIntent
  const reactRouter =
    routeIntent &&
    !express &&
    (explicitReactRouter || mentionsReact || loaderIntent || actionIntent || (renderIntent && !nextSpecificIntent))
  const nest = explicitNest || controllerIntent || moduleIntent || guardIntent || interceptorIntent || pipeIntent
  const next =
    nextSpecificIntent &&
    (explicitNext ||
      explicitNextText ||
      explicitNextPagesArtifact ||
      includesAnyToken(questionTokens, ['route', 'routes', 'middleware', 'action', 'actions', 'page', 'pages']))

  return {
    frameworkShaped: express || redux || reactRouter || nest || next,
    express,
    redux,
    reactRouter,
    nest,
    next,
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
  }
}

function frameworkBoostForNode(
  profile: FrameworkQuestionProfile,
  nodeKind: string,
  frameworkRole: string,
): number {
  if (!profile.frameworkShaped) {
    return 0
  }

  let boost = 0

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
    entries: [],
    missing_required: [],
    available_relationships: result.relationships.length,
    selected_relationships: result.relationships.length,
  }
}

function contextPackFromRetrieveResult(
  result: RetrieveResult,
): CompiledContextPack<ContextPackNode, RetrieveRelationship, RetrieveCommunityContext> {
  return {
    task_contract: result.task_contract ?? classifyTaskContract('explain', {
      budget: result.token_count,
      prompt: result.question,
    }),
    token_count: result.token_count,
    nodes: result.matched_nodes.map((node) => ({
      ...node,
      evidence_class: node.evidence_class ?? retrieveEvidenceClassForBand(node.relevance_band),
    })),
    relationships: result.relationships,
    community_context: result.community_context,
    graph_signals: result.graph_signals,
    claims: result.claims ?? [],
    expandable: result.expandable ?? [],
    coverage: result.coverage ?? fallbackRetrieveCoverage(result),
  }
}

function buildRetrieveResultFromOrderedCandidates(
  graph: KnowledgeGraph,
  options: RetrieveOptions,
  orderedCandidates: readonly ScoredNode[],
  communities: Communities,
  communityLabels: Record<number, string>,
  retrieveGraphSignals: RetrieveGraphSignals,
  rootPath?: string,
): RetrieveResult {
  const snippetFileCache = new Map<string, string[] | null>()
  const taskContract = classifyTaskContract('explain', {
    budget: options.budget,
    prompt: options.question,
  })
  const orderedCandidateIds = new Set(orderedCandidates.map((node) => node.id))
  const orderedCommunities = new Set<number>(orderedCandidates.flatMap((node) => (node.community === null ? [] : [node.community])))
  const graphSignalLabels = {
    god_nodes: [...new Set(orderedCandidates.map((node) => node.label).filter((label) => retrieveGraphSignals.godNodeLabels.has(label)))],
    bridge_nodes: [...new Set(orderedCandidates.map((node) => node.label).filter((label) => retrieveGraphSignals.bridgeNodeLabels.has(label)))],
  }
  const nodeCandidates: Array<ContextPackNodeCandidate<ContextPackNode>> = orderedCandidates.map((node) => {
    let builtEntry: RetrieveMatchedNode | undefined
    let tokenCost: number | undefined
    const evidenceClass = retrieveEvidenceClassForBand(node.relevanceBand)

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
        framework: node.framework,
        framework_role: node.frameworkRole,
        framework_boost: node.frameworkBoost,
        file_type: node.fileType,
        snippet,
        match_score: node.score,
        relevance_band: node.relevanceBand,
        community: node.community,
        community_label: node.community !== null ? (communityLabels[node.community] ?? null) : null,
        evidence_class: evidenceClass,
        ...(node.nodeKind.trim().length > 0 ? { node_kind: node.nodeKind } : {}),
      }
      tokenCost = estimateRetrieveEntryTokens(node.label, serializedSourceFile, node.lineNumber, snippet)
      return builtEntry
    }

    return {
      label: node.label,
      node_id: node.id,
      community: node.community,
      evidence_class: evidenceClass,
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
  })

  return {
    question: options.question,
    token_count: pack.token_count,
    matched_nodes: pack.nodes as RetrieveMatchedNode[],
    relationships: pack.relationships,
    community_context: pack.community_context,
    graph_signals: pack.graph_signals ?? { god_nodes: [], bridge_nodes: [] },
    task_contract: pack.task_contract,
    claims: pack.claims,
    expandable: pack.expandable,
    coverage: pack.coverage,
  }
}

export function retrieveContext(graph: KnowledgeGraph, options: RetrieveOptions): RetrieveResult {
  const { question, budget } = options
  const questionTokens = tokenizeQuestion(question)
  const rootPath = typeof graph.graph.root_path === 'string' ? graph.graph.root_path : undefined

  if (questionTokens.length === 0) {
    const emptyPack = compileContextPack({
      task_contract: classifyTaskContract('explain', { budget, prompt: question }),
      nodes: [],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
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
    }
  }

  // Pre-compute community labels so seed scoring can treat them as secondary evidence.
  const communities = communitiesFromGraph(graph)
  const frameworkProfile = buildFrameworkQuestionProfile(question, questionTokens)
  const fileOrientedQuestion = questionLooksFileOriented(question, questionTokens)
  const activeFrameworks = activeFrameworksForProfile(frameworkProfile)
  const communityLabels: Record<number, string> = {
    ...buildCommunityLabels(graph, communities),
    ...storedCommunityLabelsFromGraph(graph),
  }

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
    const fileNodeLike = isFileNodeLike(label, sourceFile)
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

    if (score.total > 0) {
      const resolvedLine = resolvedLineNumber(attributes)
      seedCandidates.push({
        id,
        label,
        sourceFile,
        lineNumber: resolvedLine.lineNumber,
        lineNumberDerived: resolvedLine.derived,
        storedSnippet: storedSnippetFromAttributes(attributes),
        nodeKind,
        framework,
        frameworkRole: frameworkRole || undefined,
        fileType,
        fileNodeLike,
        community,
        frameworkBoost: frameworkBoostForNode(frameworkProfile, nodeKind, frameworkRole),
        seedScore: score,
        exactLabelMatch: score.labelExactScore > 0,
        sourcePathMatch: score.sourcePathScore > 0,
        evidenceTier: evidenceTierForSeedScore(score),
        relevanceBand: score.labelExactScore > 0 || score.labelTokenScore > 0 ? 'direct' : 'related',
      })
    }
  }

  const fusedSeedScores = reciprocalRankFuse([
    rankedSeedCandidateIds(graph, seedCandidates, (candidate) => candidate.seedScore.labelExactScore),
    rankedSeedCandidateIds(graph, seedCandidates, (candidate) => candidate.seedScore.labelTokenScore),
    rankedSeedCandidateIds(graph, seedCandidates, (candidate) => candidate.seedScore.sourcePathScore),
    rankedSeedCandidateIds(graph, seedCandidates, (candidate) => candidate.seedScore.communityScore),
  ], {
    weights: [2, 1.5, 0.5, 0.25],
  })
  const scored: ScoredNode[] = seedCandidates.map((candidate) => ({
    id: candidate.id,
    label: candidate.label,
    sourceFile: candidate.sourceFile,
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
    sourcePathMatch: candidate.sourcePathMatch,
    evidenceTier: candidate.evidenceTier,
    score: ((fusedSeedScores.get(candidate.id) ?? 0) * SEED_FUSION_SCORE_SCALE) + candidate.frameworkBoost,
    relevanceBand: candidate.relevanceBand,
  }))

  scored.sort((a, b) => compareScoredNodes(graph, a, b))

  // Step 3: Multi-hop expansion — take top seeds, expand 2 hops with decaying scores
  const seedCount = Math.min(scored.length, 10)
  const hasExactSeedMatch = scored.some((node) => node.exactLabelMatch)
  const seedIds = new Set(scored.slice(0, seedCount).map((node) => node.id))
  const directSeeds = scored
    .filter((node) => node.relevanceBand === 'direct')
    .slice(0, 4)
  const expansionSeedIds = new Set((directSeeds.length > 0 ? directSeeds : scored.slice(0, seedCount)).map((node) => node.id))
  const hopScores = new Map<string, number>()
  const hopDistances = new Map<string, 1 | 2>()
  const hopEvidenceTiers = new Map<string, 0 | 1>()
  const hop1Ids = new Set<string>()

  // Hop 1: direct neighbors inherit a relation-weighted slice of each strong seed's score.
  for (const seed of directSeeds.length > 0 ? directSeeds : scored.slice(0, seedCount)) {
    for (const neighborId of graph.incidentNeighbors(seed.id)) {
      if (!expansionSeedIds.has(neighborId)) {
        const relation = relationBetweenNodes(graph, seed.id, neighborId)
        const hopScore = seed.score * 0.5 * relationWeight(relation)
        const hopEvidenceTier = isPrimaryExpansionRelation(relation) ? 1 : 0
        const existingHopScore = hopScores.get(neighborId) ?? 0
        const existingHopEvidenceTier = hopEvidenceTiers.get(neighborId) ?? 0
        if (hopScore > existingHopScore || (hopScore === existingHopScore && hopEvidenceTier > existingHopEvidenceTier)) {
          hopScores.set(neighborId, hopScore)
          hopDistances.set(neighborId, 1)
          hopEvidenceTiers.set(neighborId, hopEvidenceTier)
        }
        hop1Ids.add(neighborId)
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
  if (budget >= 2000 && !hasExactSeedMatch) {
    const hop2Scores = new Map<string, number>()
    for (const hop1Id of hop1Ids) {
      const hop1Score = hopScores.get(hop1Id) ?? 0
      if (hop1Score <= 0) continue
      for (const hop2Id of graph.incidentNeighbors(hop1Id)) {
        if (!seedIds.has(hop2Id) && !hop1Ids.has(hop2Id)) {
          const relation = relationBetweenNodes(graph, hop1Id, hop2Id)
          const hop2Score = hop1Score * 0.5 * relationWeight(relation)
          if (hop2Score > (hop2Scores.get(hop2Id) ?? 0)) {
            hop2Scores.set(hop2Id, hop2Score)
          }
        }
      }
    }

    const maxSecondHopAdds = budget >= 5000 ? 6 : 3
    for (const [hop2Id, hop2Score] of [...hop2Scores.entries()]
      .sort(([leftId, leftScore], [rightId, rightScore]) => rightScore - leftScore || graph.degree(rightId) - graph.degree(leftId))
      .slice(0, maxSecondHopAdds)) {
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

    const resolvedLine = resolvedLineNumber(attributes)
    scored.push({
      id: nodeId,
      label: String(attributes.label ?? ''),
      sourceFile: String(attributes.source_file ?? ''),
      lineNumber: resolvedLine.lineNumber,
      lineNumberDerived: resolvedLine.derived,
      storedSnippet: storedSnippetFromAttributes(attributes),
      nodeKind: String(attributes.node_kind ?? ''),
      framework: typeof attributes.framework === 'string' ? attributes.framework : undefined,
      frameworkRole: typeof attributes.framework_role === 'string' ? attributes.framework_role : undefined,
      fileType,
      fileNodeLike: isFileNodeLike(String(attributes.label ?? ''), String(attributes.source_file ?? '')),
      community,
      frameworkBoost: 0,
      exactLabelMatch: false,
      sourcePathMatch: false,
      evidenceTier: hopDistances.get(nodeId) === 1 ? (hopEvidenceTiers.get(nodeId) ?? 0) : 0,
      score: hopScore,
      relevanceBand: hopDistances.get(nodeId) === 1 ? 'related' : 'peripheral',
    })
  }

  // Apply structural signal boosts before final sort
  const retrieveGraphSignals = graphSignalsForRetrieve(graph, communities, communityLabels)
  const topSeed = scored.length > 0 ? scored[0] : undefined
  const seedCommunity = topSeed?.community

  for (const node of scored) {
    if (node.score === 0) continue
    if (retrieveGraphSignals.bridgeNodeIds.has(node.id)) node.score += 0.3
    if (retrieveGraphSignals.godNodeIds.has(node.id)) node.score -= 0.2
    if (seedCommunity !== undefined && node.community === seedCommunity && node.community !== -1) node.score += 0.1
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
  const inclusionOrder = frameworkProfile.frameworkShaped
    ? [
        ...prioritizedFrameworkCandidates.slice(0, prioritizedFrameworkHeadCount),
        ...secondaryCandidates.slice(0, reservedSupportingSlots),
        ...prioritizedFrameworkCandidates.slice(prioritizedFrameworkHeadCount),
        ...secondaryCandidates.slice(reservedSupportingSlots),
        ...peripheralCandidates,
        ...fallbackInclusionOrder,
      ]
    : [...secondaryCandidates, ...peripheralCandidates]

  return buildRetrieveResultFromOrderedCandidates(
    graph,
    options,
    inclusionOrder,
    communities,
    communityLabels,
    retrieveGraphSignals,
    rootPath,
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
  const rootPath = typeof graph.graph.root_path === 'string' ? graph.graph.root_path : undefined
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

  const candidatesById = new Map(
    eligibleNodeEntries(graph, options)
      .map(([id, attributes]) => [id, scoredNodeFromGraphEntry(id, attributes, frameworkProfile)] as const),
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
    candidate.score = lexicalScore + candidate.frameworkBoost + (semanticScore * 3) + (rerankScore * 4)
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
    rootPath,
  )
}

export function compactRetrieveResult(result: RetrieveResult): CompactRetrieveResult {
  const frameworkProfile = buildFrameworkQuestionProfile(result.question, tokenizeQuestion(result.question))
  const compactFrameworkLimit =
    frameworkProfile.frameworkShaped && result.matched_nodes.some((node) => (node.framework_boost ?? 0) > 0) ? 5 : Number.POSITIVE_INFINITY
  const compactPack = compactContextPack(contextPackFromRetrieveResult(result), {
    kind: 'retrieve',
    ...(Number.isFinite(compactFrameworkLimit) ? { max_nodes: compactFrameworkLimit } : {}),
  })

  return {
    question: result.question,
    token_count: compactPack.nodes.reduce(
      (total, node) => total + estimateRetrieveEntryTokens(node.label, node.source_file, node.line_number, node.snippet ?? null),
      0,
    ),
    matched_nodes: compactPack.nodes.map(({ evidence_class: _evidenceClass, ...node }) => node as CompactRetrieveMatchedNode),
    relationships: compactPack.relationships,
    community_context: compactPack.community_context,
    graph_signals: compactPack.graph_signals ?? { god_nodes: [], bridge_nodes: [] },
    ...(compactPack.shared_file_type ? { shared_file_type: compactPack.shared_file_type } : {}),
  }
}

export function compactRetrieveResultForStdio(result: RetrieveResult): RetrieveResult {
  const compactResult = compactRetrieveResult(result)
  const originalNodesById = new Map(
    result.matched_nodes
      .map((node) => [matchedNodeId(node), node] as const)
      .filter(([nodeId]) => nodeId !== null) as Array<[string, RetrieveMatchedNode]>,
  )

  const matchedNodes: RetrieveResult['matched_nodes'] = compactResult.matched_nodes.map((node): RetrieveMatchedNode => {
    const original = matchedNodeId(node) !== null ? originalNodesById.get(matchedNodeId(node)!) : undefined
    if (original) {
      return stripRetrieveMatchedNodeIdentity(original)
    }

    return {
      label: node.label,
      source_file: node.source_file,
      line_number: node.line_number,
      framework_boost: 0,
      file_type: node.file_type ?? compactResult.shared_file_type ?? '',
      snippet: node.snippet,
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
  }
}
