import type { KnowledgeGraph } from '../../contracts/graph.js'
import type {
  ContextPackRetrievalPlanDetail,
  RepositoryVocabularySource,
  RetrievalFallbackAttempt,
  RetrievalFallbackReason,
  RetrievalQualitySnapshot,
} from '../../contracts/retrieval-plan.js'
import { classifySourceDomain, type SourceDomain } from '../../shared/source-discovery.js'

const MAX_QUERY_TERMS = 12
const MAX_ANCHORS = 24
const MAX_PRIMARY_SOURCE_ANCHORS = 16
const MAX_ANCHORS_PER_SOURCE_FILE = 2
const MAX_PAIR_SEARCHES = 24
const MAX_PATH_DEPTH = 3
const MAX_BFS_VISITS = 240
const MAX_NEIGHBORS_PER_STEP = 32
const MAX_PROMOTED_CANDIDATES = 24
const MAX_EXPANSION_TERMS = 8
const CHANGE_LIFECYCLE_CONCEPT = '@change_lifecycle'

const CHANGE_LIFECYCLE_TERMS = new Set([
  'change', 'changed', 'changes', 'changing',
  'current',
  'edit', 'edited', 'editing', 'edits',
  'fresh', 'freshness',
  'latest',
  'modify', 'modified', 'modifies', 'modification', 'modifications',
  'reconcile', 'reconciled', 'reconciliation',
  'refresh', 'refreshed', 'refreshing',
  'stale', 'staleness',
  'sync', 'synced', 'synchronize', 'synchronized',
  'update', 'updated', 'updates', 'updating',
  'watch', 'watched', 'watcher', 'watching',
])
const CHANGE_LIFECYCLE_PREFIXES = [
  'chang', 'current', 'edit', 'fresh', 'latest', 'modif', 'reconcil',
  'refresh', 'stale', 'sync', 'synchron', 'updat', 'watch',
] as const

const QUERY_STOP_WORDS = new Set([
  'a', 'about', 'after', 'again', 'agent', 'also', 'an', 'and', 'are', 'be',
  'been', 'before', 'being', 'can', 'code', 'did', 'do', 'does', 'during',
  'each', 'file', 'files', 'for', 'from', 'had', 'has', 'have', 'how', 'i',
  'in', 'into', 'is', 'it', 'its', 'kept', 'madar', 'most', 'my', 'not', 'of',
  'repo', 'repository', 'source', 'that', 'the', 'then', 'this', 'through',
  'to', 'use', 'used', 'using', 'what', 'when', 'where', 'which', 'while',
  'will', 'with', 'without', 'work', 'working',
])

const VOCABULARY_NOISE = new Set([
  'app', 'bin', 'build', 'code', 'common', 'core', 'dist', 'file', 'files',
  'index', 'js', 'json', 'lib', 'main', 'md', 'module', 'node', 'nodes',
  'package', 'project', 'shared', 'source', 'src', 'test', 'tests', 'ts', 'tsx',
  'type', 'types', 'util', 'utils',
])

const SOURCE_WEIGHTS: Record<RepositoryVocabularySource, number> = {
  path: 0.7,
  exported_symbol: 1.25,
  module_name: 1.1,
  graph_community: 1.15,
  document_heading: 1.25,
  framework_metadata: 1,
}

interface VocabularyNode {
  id: string
  sourceFile: string
  community: number | null
  fileType: string
  sourceDomain: SourceDomain
  fields: Map<RepositoryVocabularySource, Set<string>>
  allTerms: Set<string>
}

interface RepositoryVocabularyIndex {
  nodes: VocabularyNode[]
  byId: Map<string, VocabularyNode>
  documentFrequency: Map<string, number>
  communityLabels: Map<number, string>
}

interface AnchorCandidate {
  id: string
  sourceFile: string
  score: number
  matchedQueryTerms: Set<string>
  specificQueryTerms: Set<string>
  sources: Set<RepositoryVocabularySource>
}

export interface ConceptualFallbackSelectedNode {
  nodeId: string
  sourceFile: string
  relevanceBand: 'direct' | 'related' | 'peripheral'
  matchScore: number
}

export interface ConceptualFallbackInput {
  question: string
  initialQuality: RetrievalQualitySnapshot
  selectedNodes: readonly ConceptualFallbackSelectedNode[]
  community?: number
  fileType?: string
}

export interface ConceptualFallbackProposal {
  plan: ContextPackRetrievalPlanDetail
  nodeBoosts: ReadonlyMap<string, number>
}

const vocabularyIndexCache = new WeakMap<KnowledgeGraph, RepositoryVocabularyIndex>()

function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1)
}

function queryTerms(question: string): string[] {
  return [...new Set(
    tokenize(question)
      .filter((term) => !QUERY_STOP_WORDS.has(term))
      .map((term) => changeLifecycleTerm(term) ? CHANGE_LIFECYCLE_CONCEPT : term),
  )].slice(0, MAX_QUERY_TERMS)
}

function lexicalTermsMatch(left: string, right: string): boolean {
  if (left === right) {
    return true
  }
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  return shorter.length >= 4 && longer.startsWith(shorter)
}

function changeLifecycleTerm(term: string): boolean {
  return CHANGE_LIFECYCLE_TERMS.has(term)
    || CHANGE_LIFECYCLE_PREFIXES.some((prefix) => term.startsWith(prefix))
}

function termsMatch(left: string, right: string): boolean {
  if (left === CHANGE_LIFECYCLE_CONCEPT) {
    return changeLifecycleTerm(right)
  }
  if (right === CHANGE_LIFECYCLE_CONCEPT) {
    return changeLifecycleTerm(left)
  }
  return lexicalTermsMatch(left, right)
}

function stringValues(value: unknown, depth = 0): string[] {
  if (depth > 2) {
    return []
  }
  if (typeof value === 'string') {
    return [value]
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).flatMap((entry) => stringValues(entry, depth + 1))
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .slice(0, 20)
      .flatMap(([key, entry]) => [key, ...stringValues(entry, depth + 1)])
  }
  return []
}

function sourcePathParts(sourceFile: string): { path: string[]; module: string[] } {
  const normalized = sourceFile.replaceAll('\\', '/')
  const parts = normalized.split('/').filter(Boolean)
  const basename = parts.at(-1) ?? ''
  const moduleName = basename.replace(/(?:\.[^.]+)+$/, '')
  return {
    path: tokenize(parts.slice(0, -1).join(' ')),
    module: tokenize(moduleName),
  }
}

function addTerms(
  fields: Map<RepositoryVocabularySource, Set<string>>,
  source: RepositoryVocabularySource,
  values: readonly string[],
): void {
  const target = fields.get(source) ?? new Set<string>()
  for (const value of values) {
    for (const term of tokenize(value)) {
      target.add(term)
    }
  }
  if (target.size > 0) {
    fields.set(source, target)
  }
}

function parseCommunity(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

function storedCommunityLabels(graph: KnowledgeGraph): Map<number, string> {
  const raw = graph.graph.community_labels
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return new Map()
  }
  return new Map(
    Object.entries(raw as Record<string, unknown>)
      .flatMap(([key, value]) => {
        const id = Number(key)
        return Number.isInteger(id) && typeof value === 'string' && value.trim().length > 0
          ? [[id, value.trim()] as const]
          : []
      }),
  )
}

function buildVocabularyIndex(graph: KnowledgeGraph): RepositoryVocabularyIndex {
  const cached = vocabularyIndexCache.get(graph)
  if (cached) {
    return cached
  }

  const communityLabels = storedCommunityLabels(graph)
  const nodes: VocabularyNode[] = []
  const documentFrequency = new Map<string, number>()

  for (const [id, attributes] of graph.nodeEntries()) {
    const sourceFile = String(attributes.source_file ?? '')
    const fileType = String(attributes.file_type ?? '').trim().toLowerCase()
    const community = parseCommunity(attributes.community)
    const fields = new Map<RepositoryVocabularySource, Set<string>>()
    const pathParts = sourcePathParts(sourceFile)
    addTerms(fields, 'path', pathParts.path)
    addTerms(fields, 'module_name', pathParts.module)

    const label = String(attributes.label ?? '')
    addTerms(fields, fileType === 'document' || fileType === 'paper' ? 'document_heading' : 'exported_symbol', [label])

    if (community !== null) {
      addTerms(fields, 'graph_community', [communityLabels.get(community) ?? ''])
    }

    addTerms(fields, 'framework_metadata', [
      String(attributes.framework ?? ''),
      String(attributes.framework_role ?? ''),
      ...stringValues(attributes.framework_metadata),
    ])

    const allTerms = new Set([...fields.values()].flatMap((terms) => [...terms]))
    for (const term of allTerms) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }
    nodes.push({
      id,
      sourceFile,
      community,
      fileType,
      sourceDomain: classifySourceDomain(
        sourceFile,
        typeof graph.graph.root_path === 'string' ? graph.graph.root_path : undefined,
      ),
      fields,
      allTerms,
    })
  }

  const index: RepositoryVocabularyIndex = {
    nodes,
    byId: new Map(nodes.map((node) => [node.id, node])),
    documentFrequency,
    communityLabels,
  }
  vocabularyIndexCache.set(graph, index)
  return index
}

function vocabularyDocumentFrequency(index: RepositoryVocabularyIndex, queryTerm: string): number {
  let count = 0
  for (const [term, frequency] of index.documentFrequency) {
    if (termsMatch(queryTerm, term)) {
      count += frequency
    }
  }
  return Math.min(count, index.nodes.length)
}

function inverseFrequency(index: RepositoryVocabularyIndex, queryTerm: string): number {
  const frequency = vocabularyDocumentFrequency(index, queryTerm)
  return Math.log((index.nodes.length + 1) / (frequency + 1)) + 1
}

function anchorForNode(
  node: VocabularyNode,
  terms: readonly string[],
  inverseFrequencyByTerm: ReadonlyMap<string, number>,
): AnchorCandidate | null {
  const matchedQueryTerms = new Set<string>()
  const specificQueryTerms = new Set<string>()
  const sources = new Set<RepositoryVocabularySource>()
  let score = 0

  for (const queryTerm of terms) {
    let bestWeight = 0
    for (const [source, vocabulary] of node.fields) {
      if ([...vocabulary].some((term) => termsMatch(queryTerm, term))) {
        sources.add(source)
        if (source !== 'graph_community' && source !== 'path') {
          specificQueryTerms.add(queryTerm)
        }
        bestWeight = Math.max(bestWeight, SOURCE_WEIGHTS[source])
      }
    }
    if (bestWeight > 0) {
      matchedQueryTerms.add(queryTerm)
      score += bestWeight * (inverseFrequencyByTerm.get(queryTerm) ?? 1)
    }
  }

  if (matchedQueryTerms.size === 0) {
    return null
  }
  score += Math.max(0, sources.size - 1) * 0.35
  score += Math.max(0, matchedQueryTerms.size - 1) * 0.5
  return { id: node.id, sourceFile: node.sourceFile, score, matchedQueryTerms, specificQueryTerms, sources }
}

function diversifyAnchors(ranked: readonly AnchorCandidate[]): AnchorCandidate[] {
  const selected: AnchorCandidate[] = []
  const selectedIds = new Set<string>()
  const countBySourceFile = new Map<string, number>()

  for (const anchor of ranked) {
    const sourceKey = anchor.sourceFile || anchor.id
    if (countBySourceFile.has(sourceKey)) {
      continue
    }
    countBySourceFile.set(sourceKey, 1)
    selectedIds.add(anchor.id)
    selected.push(anchor)
    if (selected.length >= MAX_PRIMARY_SOURCE_ANCHORS) {
      break
    }
  }

  for (const anchor of ranked) {
    if (selectedIds.has(anchor.id)) {
      continue
    }
    const sourceKey = anchor.sourceFile || anchor.id
    const sourceCount = countBySourceFile.get(sourceKey) ?? 0
    if (sourceCount === 0 || sourceCount >= MAX_ANCHORS_PER_SOURCE_FILE) {
      continue
    }
    // Path and module-name evidence applies to every symbol in a file. Only
    // admit a second symbol from that file when its own label, documentation,
    // or framework metadata contributes evidence; otherwise helpers become
    // duplicate anchors for the same repository concept.
    if (
      !anchor.sources.has('exported_symbol')
      && !anchor.sources.has('document_heading')
      && !anchor.sources.has('framework_metadata')
    ) {
      continue
    }
    countBySourceFile.set(sourceKey, sourceCount + 1)
    selected.push(anchor)
    if (selected.length >= MAX_ANCHORS) {
      break
    }
  }
  return selected
}

function eligibleVocabularyNodes(index: RepositoryVocabularyIndex, input: ConceptualFallbackInput): VocabularyNode[] {
  const normalizedFileType = input.fileType?.trim().toLowerCase()
  const allowsNonProduction = /\b(?:benchmarks?|fixtures?|specs?|tests?|testing)\b/i.test(input.question)
  return index.nodes.filter((node) => (
    (input.community === undefined || node.community === input.community)
    && (normalizedFileType === undefined || node.fileType === normalizedFileType)
    && (
      allowsNonProduction
      || !['test', 'benchmark', 'fixture', 'generated', 'build_artifact'].includes(node.sourceDomain)
    )
  ))
}

function fallbackReasons(quality: RetrievalQualitySnapshot): RetrievalFallbackReason[] {
  const reasons: RetrievalFallbackReason[] = []
  if (quality.explicit_anchors === 0 && (quality.direct_matches === 0 || quality.selected_nodes <= 1)) {
    reasons.push('weak_anchors')
  }
  if (quality.selected_nodes >= 3 && quality.workflow_coherence < 0.5) {
    reasons.push('low_workflow_coherence')
  }
  if (quality.missing_required_evidence > 0) {
    reasons.push('missing_required_evidence')
  }
  if (quality.missing_semantic_evidence > 0) {
    reasons.push('missing_semantic_evidence')
  }
  return reasons
}

function orderedIncidentNeighbors(graph: KnowledgeGraph, nodeId: string): string[] {
  // Ordering is intentionally applied only to the already-capped, balanced
  // insertion-order sample; globally sorting a god node would defeat the cap.
  return graph.incidentNeighbors(nodeId, MAX_NEIGHBORS_PER_STEP)
    .sort((left, right) => left.localeCompare(right))
}

function shortestIncidentPath(
  graph: KnowledgeGraph,
  start: string,
  target: string,
): string[] | null {
  const queue: Array<{ id: string; path: string[] }> = [{ id: start, path: [start] }]
  const seen = new Set([start])
  let visits = 0

  while (queue.length > 0 && visits < MAX_BFS_VISITS) {
    const current = queue.shift()
    if (!current) {
      break
    }
    visits += 1
    if (current.path.length - 1 >= MAX_PATH_DEPTH) {
      continue
    }
    for (const neighbor of orderedIncidentNeighbors(graph, current.id)) {
      if (seen.has(neighbor)) {
        continue
      }
      const path = [...current.path, neighbor]
      if (neighbor === target) {
        return path
      }
      seen.add(neighbor)
      queue.push({ id: neighbor, path })
    }
  }
  return null
}

function proposalIsGrounded(anchors: readonly AnchorCandidate[]): boolean {
  const coveredTerms = new Set(anchors.flatMap((anchor) => [...anchor.matchedQueryTerms]))
  const strongest = anchors[0]
  return coveredTerms.size >= 2
    && (anchors.length >= 2 || (strongest?.matchedQueryTerms.size ?? 0) >= 2)
}

function expansionTerms(
  promoted: readonly [string, number][],
  index: RepositoryVocabularyIndex,
  originalQueryTerms: readonly string[],
): string[] {
  const scored = new Map<string, number>()
  for (const [nodeId, boost] of promoted.slice(0, 12)) {
    const node = index.byId.get(nodeId)
    if (!node) {
      continue
    }
    for (const term of node.allTerms) {
      if (
        term.length < 3
        || VOCABULARY_NOISE.has(term)
        || QUERY_STOP_WORDS.has(term)
        || originalQueryTerms.some((queryTerm) => lexicalTermsMatch(queryTerm, term))
      ) {
        continue
      }
      const frequency = index.documentFrequency.get(term) ?? index.nodes.length
      if (index.nodes.length >= 20 && frequency / index.nodes.length > 0.2) {
        continue
      }
      const value = boost * (Math.log((index.nodes.length + 1) / (frequency + 1)) + 1)
      scored.set(term, Math.max(scored.get(term) ?? 0, value))
    }
  }
  return [...scored]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_EXPANSION_TERMS)
    .map(([term]) => term)
}

function emptyAttempt(reasons: RetrievalFallbackReason[]): RetrievalFallbackAttempt {
  return {
    fallback: 'repository_vocabulary_v1',
    status: 'no_candidates',
    reasons,
    vocabulary_sources: [],
    expansion_terms: [],
    promoted_candidates: 0,
    changed_result: false,
    added_selected_files: 0,
    removed_selected_files: 0,
  }
}

export function planConceptualFallback(
  graph: KnowledgeGraph,
  input: ConceptualFallbackInput,
): ConceptualFallbackProposal {
  const reasons = fallbackReasons(input.initialQuality)
  const basePlan: ContextPackRetrievalPlanDetail = {
    version: 1,
    status: 'not_needed',
    reasons,
    initial: input.initialQuality,
    final: input.initialQuality,
    attempts: [],
  }
  if (reasons.length === 0 || input.initialQuality.explicit_anchors > 0) {
    return {
      plan: input.initialQuality.explicit_anchors > 0 ? { ...basePlan, reasons: [] } : basePlan,
      nodeBoosts: new Map(),
    }
  }

  const terms = queryTerms(input.question)
  if (terms.length === 0) {
    return {
      plan: { ...basePlan, status: 'no_candidates', attempts: [emptyAttempt(reasons)] },
      nodeBoosts: new Map(),
    }
  }

  const index = buildVocabularyIndex(graph)
  const inverseFrequencyByTerm = new Map(
    terms.map((term) => [term, inverseFrequency(index, term)] as const),
  )
  const rankedAnchors = eligibleVocabularyNodes(index, input)
    .flatMap((node) => {
      const anchor = anchorForNode(node, terms, inverseFrequencyByTerm)
      return anchor ? [anchor] : []
    })
    .sort((left, right) => (
      right.matchedQueryTerms.size - left.matchedQueryTerms.size
      || right.specificQueryTerms.size - left.specificQueryTerms.size
      || right.sources.size - left.sources.size
      || right.score - left.score
      || left.id.localeCompare(right.id)
    ))
  const anchors = diversifyAnchors(rankedAnchors)

  if (!proposalIsGrounded(anchors)) {
    return {
      plan: { ...basePlan, status: 'no_candidates', attempts: [emptyAttempt(reasons)] },
      nodeBoosts: new Map(),
    }
  }

  const boosts = new Map<string, number>()
  const bridgeParticipation = new Map<string, number>()
  const connectedAnchorIds = new Set<string>()
  const selectedIds = new Set(input.selectedNodes.map((node) => node.nodeId))
  const contributingSources = new Set<RepositoryVocabularySource>()
  for (const anchor of anchors) {
    for (const source of anchor.sources) {
      contributingSources.add(source)
    }
  }

  const pairCandidates: Array<[AnchorCandidate, AnchorCandidate]> = []
  const pairKeys = new Set<string>()
  const pushPair = (left: AnchorCandidate, right: AnchorCandidate): void => {
    const key = [left.id, right.id].sort().join('\u0000')
    if (pairKeys.has(key)) {
      return
    }
    pairKeys.add(key)
    pairCandidates.push([left, right])
  }
  const anchorsBySource = new Map<string, AnchorCandidate[]>()
  for (const anchor of anchors) {
    const grouped = anchorsBySource.get(anchor.sourceFile) ?? []
    grouped.push(anchor)
    anchorsBySource.set(anchor.sourceFile, grouped)
  }
  for (const grouped of anchorsBySource.values()) {
    const first = grouped[0]
    const second = grouped[1]
    if (first && second) {
      pushPair(first, second)
    }
  }
  const crossPairs: Array<[AnchorCandidate, AnchorCandidate]> = []
  for (let leftIndex = 0; leftIndex < anchors.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < anchors.length; rightIndex += 1) {
      const left = anchors[leftIndex]
      const right = anchors[rightIndex]
      if (left && right && left.sourceFile !== right.sourceFile) {
        crossPairs.push([left, right])
      }
    }
  }
  crossPairs.sort(([leftA, rightA], [leftB, rightB]) => {
    const distinctEvidenceA = new Set([...leftA.matchedQueryTerms, ...rightA.matchedQueryTerms]).size
    const distinctEvidenceB = new Set([...leftB.matchedQueryTerms, ...rightB.matchedQueryTerms]).size
    return distinctEvidenceB - distinctEvidenceA
      || (leftB.score + rightB.score) - (leftA.score + rightA.score)
      || leftA.id.localeCompare(leftB.id)
      || rightA.id.localeCompare(rightB.id)
  })
  for (const [left, right] of crossPairs) {
    pushPair(left, right)
  }

  for (const [left, right] of pairCandidates.slice(0, MAX_PAIR_SEARCHES)) {
    const pairQueryTerms = new Set([...left.matchedQueryTerms, ...right.matchedQueryTerms])
    if (pairQueryTerms.size < 2) {
      continue
    }
    const path = shortestIncidentPath(graph, left.id, right.id)
    if (!path || path.length < 2) {
      continue
    }
    connectedAnchorIds.add(left.id)
    connectedAnchorIds.add(right.id)
    for (const nodeId of path.slice(1, -1)) {
      bridgeParticipation.set(nodeId, (bridgeParticipation.get(nodeId) ?? 0) + 1)
    }
  }

  const coherentAlternativeFound = connectedAnchorIds.size >= 2
  for (const anchor of anchors) {
    const multipleConceptBonus = Math.max(0, anchor.matchedQueryTerms.size - 1) * 1.25
    const anchorCap = anchor.matchedQueryTerms.size >= 2 ? 7 : 4
    const groundedBoost = Math.min(anchorCap, 0.6 + (anchor.score * 0.45) + multipleConceptBonus)
    if (!coherentAlternativeFound || connectedAnchorIds.has(anchor.id)) {
      boosts.set(anchor.id, groundedBoost)
    } else if (!selectedIds.has(anchor.id)) {
      if (anchor.matchedQueryTerms.size >= 2 && anchor.specificQueryTerms.size >= 2) {
        boosts.set(anchor.id, Math.min(6.5, groundedBoost))
      }
    }
  }

  for (const [nodeId, participation] of bridgeParticipation) {
    boosts.set(nodeId, (boosts.get(nodeId) ?? 0) + Math.min(3, 0.8 + (participation * 0.55)))
  }

  for (const anchor of anchors
    .filter((candidate) => (
      (!coherentAlternativeFound || connectedAnchorIds.has(candidate.id))
      && (candidate.matchedQueryTerms.size >= 2 || candidate.sources.size >= 2)
    ))
    .slice(0, 6)) {
    for (const neighborId of orderedIncidentNeighbors(graph, anchor.id).slice(0, 8)) {
      boosts.set(neighborId, (boosts.get(neighborId) ?? 0) + 0.35)
    }
  }

  if (coherentAlternativeFound) {
    for (const nodeId of selectedIds) {
      if (!connectedAnchorIds.has(nodeId) && !bridgeParticipation.has(nodeId) && !boosts.has(nodeId)) {
        boosts.set(nodeId, -1.5)
      }
    }
  }

  const orderedPositiveAdjustments = [...boosts]
    .filter(([nodeId, boost]) => index.byId.has(nodeId) && boost > 0)
    .sort((left, right) => (
      right[1] - left[1]
      || Number(!selectedIds.has(right[0])) - Number(!selectedIds.has(left[0]))
      || left[0].localeCompare(right[0])
    ))
  const reservedAnchorIds = new Set(anchors.slice(0, 12).map((anchor) => anchor.id))
  const reservedAnchors = orderedPositiveAdjustments.filter(([nodeId]) => reservedAnchorIds.has(nodeId))
  const promoted = [
    ...reservedAnchors,
    ...orderedPositiveAdjustments.filter(([nodeId]) => !reservedAnchorIds.has(nodeId)),
  ].slice(0, MAX_PROMOTED_CANDIDATES)

  const boundedBoosts = new Map(promoted)
  for (const [nodeId, adjustment] of boosts) {
    if (adjustment < 0 && index.byId.has(nodeId)) {
      boundedBoosts.set(nodeId, adjustment)
    }
  }
  if (promoted.length === 0) {
    return {
      plan: { ...basePlan, status: 'no_candidates', attempts: [emptyAttempt(reasons)] },
      nodeBoosts: boundedBoosts,
    }
  }

  const attempt: RetrievalFallbackAttempt = {
    fallback: 'repository_vocabulary_v1',
    status: 'kept_initial',
    reasons,
    vocabulary_sources: [...contributingSources].sort(),
    expansion_terms: expansionTerms(promoted, index, terms),
    promoted_candidates: promoted.length,
    changed_result: false,
    added_selected_files: 0,
    removed_selected_files: 0,
  }
  return {
    plan: { ...basePlan, status: 'kept_initial', attempts: [attempt] },
    nodeBoosts: boundedBoosts,
  }
}

function qualityValue(snapshot: RetrievalQualitySnapshot): number {
  return (
    snapshot.workflow_coherence * 3
    + Math.min(snapshot.direct_matches, 4) * 0.2
    + Math.min(snapshot.selected_files, 6) * 0.05
    - snapshot.missing_required_evidence * 2.5
    - snapshot.missing_semantic_evidence * 1.25
  )
}

export function finalizeConceptualFallbackPlan(
  proposal: ConceptualFallbackProposal,
  recoveredQuality: RetrievalQualitySnapshot,
  initialFiles: ReadonlySet<string>,
  recoveredFiles: ReadonlySet<string>,
): { plan: ContextPackRetrievalPlanDetail; useRecovered: boolean } {
  const attempt = proposal.plan.attempts[0]
  if (!attempt || proposal.nodeBoosts.size === 0) {
    return { plan: proposal.plan, useRecovered: false }
  }

  const added = [...recoveredFiles].filter((file) => !initialFiles.has(file)).length
  const removed = [...initialFiles].filter((file) => !recoveredFiles.has(file)).length
  const resultChanged = added > 0 || removed > 0
  const requiredEvidenceImproved = recoveredQuality.missing_required_evidence < proposal.plan.initial.missing_required_evidence
  const semanticEvidenceImproved = recoveredQuality.missing_semantic_evidence < proposal.plan.initial.missing_semantic_evidence
  const coherenceImproved = recoveredQuality.workflow_coherence >= proposal.plan.initial.workflow_coherence + 0.05
  const weakAnchorImproved = recoveredQuality.selected_nodes > proposal.plan.initial.selected_nodes
    || recoveredQuality.direct_matches > proposal.plan.initial.direct_matches
    || coherenceImproved
  const nonRegressingQuality = qualityValue(recoveredQuality) >= qualityValue(proposal.plan.initial) - 0.05
  const recoveredEmptyResult = proposal.plan.initial.selected_nodes === 0 && recoveredQuality.selected_nodes > 0
  const recoveryGoalMet = recoveredEmptyResult
    || (proposal.plan.reasons.includes('missing_required_evidence') && requiredEvidenceImproved)
    || (proposal.plan.reasons.includes('missing_semantic_evidence') && semanticEvidenceImproved)
    || (proposal.plan.reasons.includes('low_workflow_coherence') && coherenceImproved)
    || (proposal.plan.reasons.includes('weak_anchors') && weakAnchorImproved)
  const useRecovered = resultChanged
    && recoveryGoalMet
    && nonRegressingQuality

  const finalAttempt: RetrievalFallbackAttempt = {
    ...attempt,
    status: useRecovered ? 'applied' : 'kept_initial',
    changed_result: useRecovered,
    added_selected_files: useRecovered ? added : 0,
    removed_selected_files: useRecovered ? removed : 0,
  }
  return {
    useRecovered,
    plan: {
      ...proposal.plan,
      status: useRecovered ? 'recovered' : 'kept_initial',
      final: useRecovered ? recoveredQuality : proposal.plan.initial,
      attempts: [finalAttempt],
      ...(useRecovered ? { selected_fallback: finalAttempt.fallback } : {}),
    },
  }
}
