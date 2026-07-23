import { compareCodeUnits } from '../graph/canonical-json.js'
import type { GraphAttributes } from '../graph/directed-multigraph.js'
import type { ReadyQueryIndex } from './index-status.js'
import { classifySourceDomain, isPollutedSourcePath, type SourceDomain } from './source-domain.js'
import type {
  EvidenceBoundary,
  NormalizedRetrieveRequest,
  RankedQueryNode,
  RankQueryResult,
} from './types.js'
import { MAX_RETRIEVE_FILES, MAX_RETRIEVE_SNIPPETS } from './types.js'

const MAX_RANKED_ANCHORS = MAX_RETRIEVE_SNIPPETS
const MAX_UNSUPPORTED_BOUNDARIES = 4
const FIELD_WEIGHTS = {
  label: 12,
  qualifiedName: 12,
  sourceFile: 7,
  framework: 5,
  metadata: 5,
  nodeKind: 3,
} as const
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for', 'from',
  'how', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'the', 'then', 'through',
  'to', 'what', 'which', 'with',
])
const UNSUPPORTED_CODE_EXTENSIONS = new Set([
  'bash', 'c', 'cc', 'cljs', 'clj', 'cpp', 'cs', 'cxx', 'dart', 'elm', 'ex',
  'exs', 'fs', 'fsx', 'go', 'groovy', 'h', 'hpp', 'hs', 'java', 'jl', 'kt',
  'kts', 'lua', 'm', 'mm', 'php', 'ps1', 'py', 'r', 'rb', 'rs', 'scala', 'sh',
  'sol', 'sql', 'svelte', 'swift', 'vue', 'zig',
])
const SOURCE_DOMAIN_TERMS: Readonly<Record<Exclude<SourceDomain, 'production' | 'unknown'>, readonly string[]>> = {
  test: ['test', 'spec', 'e2e'],
  benchmark: ['benchmark', 'bench', 'performance'],
  fixture: ['fixture', 'mock'],
  generated: ['generated'],
  docs: ['doc', 'documentation', 'readme'],
  config: ['config', 'configuration', 'setting'],
  build_artifact: [],
}
const SOURCE_DOMAINS = new Set<SourceDomain>([
  'production', 'test', 'benchmark', 'fixture', 'generated', 'docs', 'config',
  'build_artifact', 'unknown',
])
interface RankField {
  compact: string
  tokens: ReadonlySet<string>
  weight: number
}

interface RankCorpusNode {
  id: string
  documentKey: string
  attributes: GraphAttributes
  fields: readonly RankField[]
  tokens: ReadonlySet<string>
  pathTokens: ReadonlySet<string>
  sourceFile: string
  sourceDomain: SourceDomain
  nodeKind: string
  selectable: boolean
  outgoingDegree: number
  lineSpan: number
}

interface RankCorpus {
  nodes: readonly RankCorpusNode[]
  documentFrequency: ReadonlyMap<string, number>
  documentCount: number
  fileTermWeights: ReadonlyMap<string, ReadonlyMap<string, number>>
  relationKinds: readonly string[]
}

interface QueryVocabulary {
  terms: string[]
  positions: ReadonlyMap<string, number>
  scopes: ExplicitScope[]
}

interface ExplicitScope {
  subject: string
  tokens: string[]
  compact: string
  firstMatch: number
  restrictsCandidates: boolean
}

interface ScoredNode {
  node: RankCorpusNode
  ranked: RankedQueryNode
  representativeScore: number
}

interface UnsupportedCandidate {
  path: string
  matchedTerms: string[]
  termWeights: ReadonlyMap<string, number>
  score: number
  firstMatch: number
}

function stemToken(value: string): string {
  if (/^\d+$/.test(value)) return value
  let stem = value
  for (let pass = 0; pass < 2; pass += 1) {
    const next = stem.length > 7 && stem.endsWith('ization')
      ? `${stem.slice(0, -7)}ize`
      : stem.length > 5 && stem.endsWith('ies')
        ? `${stem.slice(0, -3)}y`
        : stem.length > 6 && (stem.endsWith('ence') || stem.endsWith('ance'))
          ? stem.slice(0, -4)
          : stem.length > 8 && stem.endsWith('ment')
            ? stem.slice(0, -4)
            : stem.length > 5 && stem.endsWith('ions')
              ? stem.slice(0, -4)
              : stem.length > 4 && stem.endsWith('ion')
                ? stem.slice(0, -3)
                : stem.length > 5 && stem.endsWith('ing')
                  ? stem.slice(0, -3)
                  : stem.length > 4 && stem.endsWith('ery')
                    ? `${stem.slice(0, -3)}er`
                    : stem.length > 4 && stem.endsWith('ed')
                      ? stem.slice(0, -2)
                      : stem.length > 4 && stem.endsWith('s') && !stem.endsWith('ss')
                        ? stem.slice(0, -1)
                        : stem.length > 5 && stem.endsWith('e')
                          ? stem.slice(0, -1)
                          : stem
    if (next === stem) break
    stem = next
  }
  return stem
}

function lexicalTokens(value: string): string[] {
  const separated = value
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
  return (separated.match(/[a-z]+|\d+/g) ?? []).map(stemToken)
}

function meaningfulTokens(value: string): string[] {
  return lexicalTokens(value).filter((token) => !STOP_WORDS.has(token))
}

function compactTokens(value: string): string {
  return lexicalTokens(value).join('')
}

function scalarMetadataValues(value: unknown, depth = 0): string[] {
  if (depth > 2 || value === null || value === undefined) return []
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)]
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => scalarMetadataValues(entry, depth + 1))
  }
  if (typeof value !== 'object') return []
  return Object.entries(value)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .flatMap(([key, entry]) => [key, ...scalarMetadataValues(entry, depth + 1)])
}

function stringAttribute(attributes: GraphAttributes, key: string): string {
  const value = attributes[key]
  return typeof value === 'string' ? value : ''
}

function field(value: string, weight: number): RankField | null {
  const tokens = lexicalTokens(value)
  if (tokens.length === 0) return null
  return {
    compact: tokens.join(''),
    tokens: new Set(tokens),
    weight,
  }
}

function sourceDomainOf(attributes: GraphAttributes, sourceFile: string, rootPath: string): SourceDomain {
  const stored = attributes.source_domain
  return typeof stored === 'string' && SOURCE_DOMAINS.has(stored as SourceDomain)
    ? stored as SourceDomain
    : classifySourceDomain(sourceFile, rootPath)
}

function selectableGraphNode(
  attributes: GraphAttributes,
  sourceFile: string,
  index: ReadyQueryIndex,
): boolean {
  if (stringAttribute(attributes, 'node_kind') !== 'file') return true
  return sourceFile.length > 0
    && typeof attributes.line_number === 'number'
    && Number.isSafeInteger(attributes.line_number)
    && attributes.line_number > 0
    && typeof attributes.end_line_number === 'number'
    && Number.isSafeInteger(attributes.end_line_number)
    && attributes.end_line_number >= attributes.line_number
    && Array.isArray(attributes.provenance)
    && attributes.provenance.length > 0
    && index.file_hashes.has(sourceFile)
}

function buildCorpus(index: ReadyQueryIndex): RankCorpus {
  const nodes: RankCorpusNode[] = []
  for (const [id, attributes] of index.graph.nodeEntries()) {
    const sourceFile = stringAttribute(attributes, 'source_file')
    if (sourceFile && isPollutedSourcePath(sourceFile, index.root_path)) continue

    const metadata = scalarMetadataValues(attributes.framework_metadata).join(' ')
    const rankFields = [
      field(stringAttribute(attributes, 'label'), FIELD_WEIGHTS.label),
      field(stringAttribute(attributes, 'qualified_name'), FIELD_WEIGHTS.qualifiedName),
      field(sourceFile, FIELD_WEIGHTS.sourceFile),
      field([
        stringAttribute(attributes, 'framework'),
        stringAttribute(attributes, 'framework_role'),
      ].join(' '), FIELD_WEIGHTS.framework),
      field(metadata, FIELD_WEIGHTS.metadata),
      field(stringAttribute(attributes, 'node_kind'), FIELD_WEIGHTS.nodeKind),
    ].filter((entry): entry is RankField => entry !== null)
    const tokens = new Set(rankFields.flatMap((entry) => [...entry.tokens]))
    nodes.push({
      id,
      documentKey: sourceFile || id,
      attributes,
      fields: rankFields,
      tokens,
      pathTokens: new Set(lexicalTokens(sourceFile)),
      sourceFile,
      sourceDomain: sourceDomainOf(attributes, sourceFile, index.root_path),
      nodeKind: stringAttribute(attributes, 'node_kind'),
      outgoingDegree: index.graph.successors(id).length,
      lineSpan: typeof attributes.line_number === 'number' && typeof attributes.end_line_number === 'number'
        ? Math.max(1, attributes.end_line_number - attributes.line_number + 1)
        : Number.MAX_SAFE_INTEGER,
      selectable: selectableGraphNode(attributes, sourceFile, index),
    })
  }

  const fileTermWeights = new Map<string, Map<string, number>>()
  for (const node of nodes) {
    const terms = fileTermWeights.get(node.documentKey) ?? new Map<string, number>()
    for (const candidate of node.fields) {
      for (const token of candidate.tokens) {
        terms.set(token, Math.max(terms.get(token) ?? 0, candidate.weight))
      }
    }
    fileTermWeights.set(node.documentKey, terms)
  }
  const documentFrequency = new Map<string, number>()
  for (const terms of fileTermWeights.values()) {
    for (const token of terms.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }
  }
  const relationKinds = [...new Set(index.graph.edgeEntries()
    .map(([, , attributes]) => attributes.relation)
    .filter((relation): relation is string => typeof relation === 'string' && relation.length > 0))]
    .sort(compareCodeUnits)
  return {
    nodes,
    documentFrequency,
    documentCount: fileTermWeights.size,
    fileTermWeights,
    relationKinds,
  }
}

function explicitScopes(question: string): ExplicitScope[] {
  const scopes: ExplicitScope[] = []
  const seen = new Set<string>()
  const patterns = [
    {
      pattern: /`([A-Za-z_$][A-Za-z0-9_$.:]*)`/g,
      restrictsCandidates: false,
    },
    {
      pattern: /\b(?:[A-Za-z0-9_$.[\]-]+\/)+[A-Za-z0-9_$.[\]-]+\.(?:[cm]?[jt]sx?)\b/g,
      restrictsCandidates: true,
    },
    {
      pattern: /\b(?=[a-z0-9-]*\d)[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g,
      restrictsCandidates: true,
    },
  ]
  for (const { pattern, restrictsCandidates } of patterns) {
    for (const match of question.matchAll(pattern)) {
      const subject = (match[1] ?? match[0]).trim()
      const tokens = lexicalTokens(subject)
      const compact = tokens.join('')
      if (!compact || seen.has(compact)) continue
      seen.add(compact)
      scopes.push({
        subject,
        tokens,
        compact,
        firstMatch: match.index ?? Number.MAX_SAFE_INTEGER,
        restrictsCandidates,
      })
    }
  }
  return scopes.sort((left, right) =>
    left.firstMatch - right.firstMatch || compareCodeUnits(left.subject, right.subject))
}

function activeScopes(corpus: RankCorpus, vocabulary: QueryVocabulary): ExplicitScope[] {
  return vocabulary.scopes.filter((scope) =>
    corpus.nodes.some((node) => node.selectable && matchesScope(node, scope)))
}

function constrainingScopes(vocabulary: QueryVocabulary): ExplicitScope[] {
  return vocabulary.scopes.filter((scope) => scope.restrictsCandidates)
}

function relationTerms(question: string, relationKinds: readonly string[]): Array<{ term: string; position: number }> {
  const lowerQuestion = question.toLowerCase()
  return relationKinds.flatMap((relation) => {
    const variants = [
      relation.toLowerCase(),
      relation.toLowerCase().replaceAll('_', ' '),
      relation.toLowerCase().replaceAll('-', ' '),
    ]
    const positions = variants.map((variant) => lowerQuestion.indexOf(variant)).filter((position) => position >= 0)
    return positions.length === 0 ? [] : [{ term: relation, position: Math.min(...positions) }]
  }).sort((left, right) => left.position - right.position || compareCodeUnits(left.term, right.term))
}

function queryVocabulary(question: string, relationKinds: readonly string[]): QueryVocabulary {
  const rawTokens = lexicalTokens(question)
  const terms: string[] = []
  const positions = new Map<string, number>()
  for (const [index, token] of rawTokens.entries()) {
    if (STOP_WORDS.has(token)) continue
    if (!positions.has(token)) {
      positions.set(token, index)
      terms.push(token)
    }
  }
  for (const { term, position } of relationTerms(question, relationKinds)) {
    if (!positions.has(term)) {
      positions.set(term, position)
      terms.push(term)
    }
  }
  return {
    terms,
    positions,
    scopes: explicitScopes(question),
  }
}

function fieldWeightForToken(corpus: RankCorpus, node: RankCorpusNode, token: string): number {
  return corpus.fileTermWeights.get(node.documentKey)?.get(token) ?? 0
}

function rarityWeight(corpus: RankCorpus, token: string): number {
  const documents = Math.max(1, corpus.documentCount)
  const frequency = corpus.documentFrequency.get(token) ?? 0
  return Math.max(1, Math.round((1 + Math.log2((documents + 1) / (frequency + 1))) * 64))
}

function matchesScope(node: RankCorpusNode, scope: ExplicitScope): boolean {
  return scope.tokens.every((token) => node.tokens.has(token))
    && node.fields.some((candidate) => candidate.compact.includes(scope.compact))
}

function domainAdjustment(domain: SourceDomain): number {
  if (domain === 'production') return 500
  if (domain === 'unknown') return 0
  if (domain === 'test') return -250
  return -500
}

function scoreNode(
  corpus: RankCorpus,
  node: RankCorpusNode,
  vocabulary: QueryVocabulary,
): RankedQueryNode | null {
  const fileTerms = corpus.fileTermWeights.get(node.documentKey)
  const scoringTerms = vocabulary.terms.filter((token) =>
    !token.includes('_') && !token.includes('-') && fileTerms?.has(token))
  if (scoringTerms.length === 0) return null
  const matchedTerms = scoringTerms.filter((token) => node.tokens.has(token))

  let score = domainAdjustment(node.sourceDomain)
  for (const token of scoringTerms) {
    const position = vocabulary.positions.get(token) ?? vocabulary.terms.length
    const positionWeight = Math.max(1, 24 - Math.min(23, position))
    const termScore = rarityWeight(corpus, token) * fieldWeightForToken(corpus, node, token)
    score += termScore * positionWeight
    if (node.pathTokens.has(token)) {
      score += rarityWeight(corpus, token) * FIELD_WEIGHTS.sourceFile * positionWeight
    }
  }
  score = Math.round(score * (1 + Math.log2(scoringTerms.length)))
  for (const scope of vocabulary.scopes) {
    if (matchesScope(node, scope)) score += 1_000_000
  }

  const scopedTerms = new Set(vocabulary.scopes.flatMap((scope) => scope.tokens))
  const orderingTerms = matchedTerms.filter((term) => !scopedTerms.has(term))
  const firstMatch = (orderingTerms.length > 0 ? orderingTerms : matchedTerms).reduce((first, token) =>
    Math.min(first, vocabulary.positions.get(token) ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
  return {
    id: node.id,
    attributes: node.attributes,
    score,
    matchedTerms,
    firstMatch,
  }
}

function scoreRepresentative(
  corpus: RankCorpus,
  node: RankCorpusNode,
  ranked: RankedQueryNode,
): number {
  let score = ranked.matchedTerms.reduce((total, token) =>
    total + rarityWeight(corpus, token) * node.fields.reduce((highest, candidate) =>
      candidate.tokens.has(token) ? Math.max(highest, candidate.weight) : highest, 0), 0)
  score = Math.round(score * (1 + Math.log2(Math.max(1, ranked.matchedTerms.length))))
  if (stringAttribute(node.attributes, 'framework_role')) score += 100_000
  const metadata = node.attributes.framework_metadata
  if (metadata && typeof metadata === 'object' && 'external_call' in metadata) score -= 100_000
  if (node.nodeKind === 'file') score -= 100_000
  return score + node.outgoingDegree * 64 - Math.min(node.lineSpan, 500) * 64
}

function compareScoredNodes(left: ScoredNode, right: ScoredNode): number {
  return right.ranked.score - left.ranked.score
    || right.representativeScore - left.representativeScore
    || left.ranked.firstMatch - right.ranked.firstMatch
    || right.node.outgoingDegree - left.node.outgoingDegree
    || left.node.lineSpan - right.node.lineSpan
    || compareCodeUnits(left.node.sourceFile, right.node.sourceFile)
    || compareCodeUnits(left.node.id, right.node.id)
}

function scoredNodes(corpus: RankCorpus, vocabulary: QueryVocabulary): ScoredNode[] {
  const requestedDomains = new Set(
    Object.entries(SOURCE_DOMAIN_TERMS).flatMap(([domain, terms]) =>
      terms.some((term) => vocabulary.terms.includes(term)) ? [domain as SourceDomain] : []),
  )
  const candidates = corpus.nodes.flatMap((node) => {
    if (!node.selectable) return []
    const ranked = scoreNode(corpus, node, vocabulary)
    return ranked ? [{
      node,
      ranked,
      representativeScore: scoreRepresentative(corpus, node, ranked),
    }] : []
  }).filter(({ node }) =>
    (requestedDomains.size > 0
      ? requestedDomains.has(node.sourceDomain)
      : node.sourceDomain === 'production' || node.sourceDomain === 'unknown')
    || vocabulary.scopes.some((scope) => matchesScope(node, scope))
  )
    .sort(compareScoredNodes)
  if (constrainingScopes(vocabulary).length > 0) return candidates
  const selectedFiles = new Set<string>()
  return candidates.filter(({ node }) => {
    if (selectedFiles.has(node.documentKey)) return false
    selectedFiles.add(node.documentKey)
    return true
  })
}

function unsupportedCandidates(
  index: ReadyQueryIndex,
  vocabulary: QueryVocabulary,
): UnsupportedCandidate[] {
  const candidates = index.unsupported_sources.flatMap((source): UnsupportedCandidate[] => {
    const extension = source.path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
    if (!UNSUPPORTED_CODE_EXTENSIONS.has(extension)) return []
    const domain = classifySourceDomain(source.path, index.root_path)
    if (isPollutedSourcePath(source.path, index.root_path)
      || (domain !== 'production' && domain !== 'unknown')) return []
    const pathTokens = new Set(meaningfulTokens(source.path))
    const basenameTokens = new Set(meaningfulTokens(source.path.split('/').at(-1) ?? source.path))
    const matchedTerms = vocabulary.terms.filter((term) =>
      !term.includes('_') && !term.includes('-') && pathTokens.has(term))
    const termWeights = new Map(matchedTerms.map((term) => [
      term,
      basenameTokens.has(term) ? 4 : 1,
    ]))
    const scopeMatch = vocabulary.scopes.some((scope) =>
      scope.tokens.every((token) => pathTokens.has(token))
      && compactTokens(source.path).includes(scope.compact))
    if (!scopeMatch
      && (matchedTerms.length === 0 || matchedTerms.every((term) => term.length < 4))) return []
    const firstMatch = matchedTerms.reduce((first, term) =>
      Math.min(first, vocabulary.positions.get(term) ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
    const score = matchedTerms.reduce((total, term) =>
      total + Math.max(1, term.length ** 2) * (termWeights.get(term) ?? 1) * 100, scopeMatch ? 1_000_000 : 0)
    return [{ path: source.path, matchedTerms, termWeights, score, firstMatch }]
  })
  return candidates.sort((left, right) =>
    right.score - left.score
    || left.firstMatch - right.firstMatch
    || compareCodeUnits(left.path, right.path))
}

function selectUnsupportedBoundaries(candidates: readonly UnsupportedCandidate[]): EvidenceBoundary[] {
  const selected: UnsupportedCandidate[] = []
  const covered = new Set<string>()
  const remaining = [...candidates]
  const bestScore = Math.max(1, remaining[0]?.score ?? 1)
  while (remaining.length > 0 && selected.length < MAX_UNSUPPORTED_BOUNDARIES) {
    remaining.sort((left, right) => {
      const leftNew = left.matchedTerms
        .filter((term) => !covered.has(term))
        .reduce((total, term) => total + term.length ** 2 * (left.termWeights.get(term) ?? 1), 0)
      const rightNew = right.matchedTerms
        .filter((term) => !covered.has(term))
        .reduce((total, term) => total + term.length ** 2 * (right.termWeights.get(term) ?? 1), 0)
      return rightNew - leftNew
        || right.score - left.score
        || left.firstMatch - right.firstMatch
        || compareCodeUnits(left.path, right.path)
    })
    const next = remaining.shift()
    if (!next) break
    const addsCoverage = next.matchedTerms.some((term) => !covered.has(term))
    if (!addsCoverage && next.score * 3 < bestScore) break
    selected.push(next)
    for (const term of next.matchedTerms) covered.add(term)
  }
  const boundaries = selected
    .map((candidate): EvidenceBoundary => ({ kind: 'unsupported', subject: candidate.path }))
    .sort((left, right) => compareCodeUnits(left.subject, right.subject))
  return selected.length >= MAX_UNSUPPORTED_BOUNDARIES && remaining.length > 0
    ? [...boundaries, { kind: 'truncated', subject: 'unsupported sources' }]
    : boundaries
}

function missingScopeBoundaries(
  corpus: RankCorpus,
  vocabulary: QueryVocabulary,
  unsupported: readonly UnsupportedCandidate[],
): EvidenceBoundary[] {
  return vocabulary.scopes.flatMap((scope): EvidenceBoundary[] => {
    const graphMatches = corpus.nodes.filter((node) => matchesScope(node, scope))
    const graphMatch = graphMatches.some((node) => node.selectable)
    const unsupportedMatch = unsupported.some((candidate) =>
      compactTokens(candidate.path).includes(scope.compact))
    if (graphMatch || unsupportedMatch) return []
    return [{
      kind: graphMatches.length > 0 ? 'unavailable' : 'missing',
      subject: scope.subject,
    }]
  })
}

function rankDiverseAnchors(
  index: ReadyQueryIndex,
  corpus: RankCorpus,
  scored: readonly ScoredNode[],
  vocabulary: QueryVocabulary,
): RankedQueryNode[] {
  const selected: ScoredNode[] = []
  const covered = new Set<string>()
  const selectedFiles = new Set<string>()
  const remaining = [...scored]
  const bestScore = Math.max(0, scored[0]?.ranked.score ?? 0)
  const useScoreFloor = vocabulary.scopes.length === 0
  while (remaining.length > 0 && selected.length < MAX_RANKED_ANCHORS) {
    remaining.sort((left, right) => {
      const leftScoped = vocabulary.scopes.some((scope) => matchesScope(left.node, scope))
      const rightScoped = vocabulary.scopes.some((scope) => matchesScope(right.node, scope))
      return Number(rightScoped) - Number(leftScoped)
        || compareScoredNodes(left, right)
    })
    const next = remaining.shift()
    if (!next) break
    if (useScoreFloor && selected.length > 0 && next.ranked.score * 3 < bestScore) break
    const requiresNewTerm = constrainingScopes(vocabulary).length > 0
    if (requiresNewTerm && next.ranked.matchedTerms.every((term) => covered.has(term))) continue
    const addsFile = !selectedFiles.has(next.node.sourceFile)
    if (addsFile && selectedFiles.size >= MAX_RETRIEVE_FILES) continue
    if (!addsFile && !constrainingScopes(vocabulary).some((scope) => matchesScope(next.node, scope))) {
      continue
    }
    selected.push(next)
    selectedFiles.add(next.node.sourceFile)
    for (const term of next.ranked.matchedTerms) covered.add(term)
  }

  const ordered: ScoredNode[] = []
  const unordered = [...selected]
  while (unordered.length > 0) {
    const firstMatch = Math.min(...unordered.map(({ ranked }) => ranked.firstMatch))
    const samePosition = unordered.filter(({ ranked }) => ranked.firstMatch === firstMatch)
    const roots = samePosition.filter((candidate) => !samePosition.some((other) =>
      other.node.id !== candidate.node.id
      && index.graph.hasEdge(other.node.id, candidate.node.id)))
    const candidates = roots.length > 0 ? roots : samePosition
    candidates.sort((left, right) =>
      right.node.outgoingDegree - left.node.outgoingDegree
      || compareScoredNodes(left, right))
    const next = candidates[0]!
    ordered.push(next)
    unordered.splice(unordered.findIndex(({ node }) => node.id === next.node.id), 1)
  }
  return ordered.map(({ ranked }) => ranked)
}

function uniqueBoundaries(boundaries: readonly EvidenceBoundary[]): EvidenceBoundary[] {
  const byIdentity = new Map<string, EvidenceBoundary>()
  for (const boundary of boundaries) {
    byIdentity.set(`${boundary.kind}\u0000${boundary.subject}`, boundary)
  }
  return [...byIdentity.values()].sort((left, right) =>
    compareCodeUnits(left.kind, right.kind) || compareCodeUnits(left.subject, right.subject))
}

export function rankQueryAnchors(
  index: ReadyQueryIndex,
  request: NormalizedRetrieveRequest,
): RankQueryResult {
  const corpus = buildCorpus(index)
  const vocabulary = queryVocabulary(request.question, corpus.relationKinds)
  const unsupported = unsupportedCandidates(index, vocabulary)
  const unsupportedBoundaries = selectUnsupportedBoundaries(unsupported)
  const missingScopes = missingScopeBoundaries(corpus, vocabulary, unsupported)

  const scored = scoredNodes(corpus, vocabulary)
  const constraints = constrainingScopes(vocabulary)
  const scopes = activeScopes(corpus, vocabulary)
  const scopedTerms = new Set(constraints.flatMap((scope) => scope.tokens))
  const candidatePool = constraints.length === 0
    ? scored
    : scored.filter(({ node, ranked }) =>
      scopes.some((scope) => matchesScope(node, scope))
      || (scopes.length > 0
        && ranked.matchedTerms.some((term) => !scopedTerms.has(term))))
  const anchors = rankDiverseAnchors(
    index,
    corpus,
    candidatePool,
    vocabulary,
  )
  const selectedIds = new Set(anchors.map((anchor) => anchor.id))
  const selectedFiles = new Set(anchors.map((anchor) =>
    stringAttribute(anchor.attributes, 'source_file')))
  const anchorTruncated = candidatePool.some(({ node }) => !selectedIds.has(node.id))
    && (anchors.length >= MAX_RANKED_ANCHORS || selectedFiles.size >= MAX_RETRIEVE_FILES)
    ? [{ kind: 'truncated', subject: 'query anchors' } satisfies EvidenceBoundary]
    : []
  const boundaries = anchors.length === 0
    && unsupportedBoundaries.length === 0
    && missingScopes.length === 0
    ? [{ kind: 'missing', subject: request.question } satisfies EvidenceBoundary]
    : [...unsupportedBoundaries, ...missingScopes, ...anchorTruncated]
  return {
    anchors,
    boundaries: uniqueBoundaries(boundaries),
    queryTerms: vocabulary.terms,
  }
}
