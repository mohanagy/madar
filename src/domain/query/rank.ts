import { canonicalJsonString, compareCodeUnits } from '../graph/canonical-json.js'
import type { GraphAttributes } from '../graph/directed-multigraph.js'
import type { ReadyQueryIndex } from './index-status.js'
import {
  classifySourceDomain, isPollutedSourcePath, sourceDomainOf, type SourceDomain,
} from './source-domain.js'
import type {
  EvidenceBoundary, NormalizedRetrieveRequest, RankedQueryNode, RankQueryResult,
} from './types.js'
import { MAX_RETRIEVE_FILES, MAX_RETRIEVE_SNIPPETS } from './types.js'

const MAX_RANKED_ANCHORS = MAX_RETRIEVE_SNIPPETS
const MAX_UNSUPPORTED_BOUNDARIES = 4
const EVIDENCE_RELATIONS = ['calls', 'contains', 'enqueues_job', 'imports_from'] as const
const FIELD_WEIGHTS = {
  label: 12, qualifiedName: 12, sourceFile: 7,
  framework: 5, metadata: 5, nodeKind: 3,
} as const
const STOP_WORDS = new Set([
  'a', 'actual', 'an', 'and', 'any', 'applicabl', 'are', 'as', 'at', 'be', 'by',
  'bas', 'being', 'can', 'do', 'does', 'exist', 'final', 'for', 'from', 'handl',
  'how', 'in', 'initial', 'is', 'it', 'its', 'me', 'new', 'of', 'on', 'operat',
  'or', 'specific', 'tell', 'that', 'the', 'then', 'through', 'to', 'trace',
  'what', 'when', 'which', 'with', 'you',
])
const UNSUPPORTED_CODE_EXTENSIONS = new Set([
  'bash', 'c', 'cc', 'cljs', 'clj', 'cpp', 'cs', 'cxx', 'dart', 'elm', 'ex',
  'exs', 'fs', 'fsx', 'go', 'groovy', 'h', 'hpp', 'hs', 'java', 'jl', 'kt',
  'kts', 'lua', 'm', 'mm', 'php', 'ps1', 'py', 'r', 'rb', 'rs', 'scala', 'sh',
  'sol', 'sql', 'svelte', 'swift', 'vue', 'zig',
])
const SOURCE_DOMAIN_TERMS: Readonly<Record<Exclude<SourceDomain, 'production' | 'unknown'>, readonly string[]>> = {
  test: ['test', 'spec', 'e2e'], benchmark: ['benchmark', 'bench', 'performance'],
  fixture: ['fixture', 'mock'], generated: ['generated'],
  docs: ['doc', 'documentation', 'readme'], config: ['config', 'configuration', 'setting'],
  build_artifact: [],
}
interface RankField { compact: string; tokens: ReadonlySet<string>; weight: number }
interface RankCorpusNode {
  id: string; documentKey: string; attributes: GraphAttributes; fields: readonly RankField[]
  tokens: ReadonlySet<string>; pathTokens: ReadonlySet<string>; sourceFile: string
  sourceDomain: SourceDomain; nodeKind: string; selectable: boolean
  incomingIds: readonly string[]; outgoingIds: readonly string[]; outgoingDegree: number; lineSpan: number
}
interface RankCorpus {
  nodes: readonly RankCorpusNode[]; documentFrequency: ReadonlyMap<string, number>
  nodeById: ReadonlyMap<string, RankCorpusNode>; fileTermWeights: ReadonlyMap<string, ReadonlyMap<string, number>>
}
interface QueryObligation {
  terms: readonly string[]; localTerms: ReadonlySet<string>; coordinated: boolean
}
interface QueryVocabulary {
  question: string; terms: string[]; positions: ReadonlyMap<string, number>; scopes: ExplicitScope[]
  constraints: ExplicitScope[]; obligations: readonly QueryObligation[]
}
interface RankSelection { anchors: RankedQueryNode[]; branch: string; flow: boolean }
interface ExplicitScope { subject: string; tokens: string[]; compact: string; firstMatch: number; restrictsCandidates: boolean }
interface ScoredNode { node: RankCorpusNode; ranked: RankedQueryNode; representativeScore: number }
interface OwnerFit { candidate: ScoredNode; vector: readonly number[]; ownedTerms: ReadonlySet<string>; totalCovered: number }
interface UnsupportedCandidate { path: string; matchedTerms: string[]; termWeights: ReadonlyMap<string, number>; score: number; firstMatch: number }

const STEM_RULES = [
  [7, 'ization', 'ize'], [5, 'ies', 'y'], [6, 'ence', ''], [6, 'ance', ''],
  [8, 'ment', ''], [5, 'ions', ''], [4, 'ion', ''], [5, 'ing', ''],
  [4, 'ery', 'er'], [4, 'ed', ''], [4, 's', ''], [5, 'e', ''],
] as const

function stemToken(value: string): string {
  if (/^\d+$/.test(value)) return value
  let stem = value
  for (let pass = 0; pass < 2; pass += 1) {
    const rule = STEM_RULES.find(([minimum, suffix]) =>
      stem.length > minimum && stem.endsWith(suffix)
      && (suffix !== 's' || !stem.endsWith('ss')))
    if (!rule) break
    stem = `${stem.slice(0, -rule[1].length)}${rule[2]}`
  }
  return stem
}

function lexicalTokens(value: string): string[] {
  const separated = value
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
  const tokens = separated.match(/[a-z][a-z0-9]*|\d+/g) ?? []
  return tokens.flatMap((token) => {
    const parts = token.match(/[a-z]+|\d+/g) ?? []
    return parts.length >= 3 ? parts : [token]
  }).map(stemToken)
    .filter((token) => token.length > 1 || /^\d+$/.test(token))
}

function meaningfulTokens(value: string): string[] {
  return lexicalTokens(value).filter((token) => !STOP_WORDS.has(token))
}

function compactTokens(value: string): string {
  return lexicalTokens(value).join('')
}

function termsMatch(left: string, right: string): boolean {
  if (left === right) return true
  if (left.length < 3 || right.length < 3) return false
  const forms = (term: string): string[] => [
    term,
    `${term}e`,
    ...(term.length >= 4 && term.endsWith('s') && !term.endsWith('ss')
      ? [term.slice(0, -1)] : []),
  ]
  return forms(left).some((leftForm) => forms(right).some((rightForm) =>
    leftForm === rightForm
    || ['en', 're', 'un'].some((prefix) =>
      leftForm === `${prefix}${rightForm}` || rightForm === `${prefix}${leftForm}`)))
}

function tokenSetMatches(tokens: ReadonlySet<string>, term: string): boolean {
  for (const token of tokens) if (termsMatch(token, term)) return true
  return false
}

function scalarMetadataValues(value: unknown, depth = 0): string[] {
  if (depth > 2 || value === null || value === undefined) return []
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)]
  }
  if (Array.isArray(value)) return value.flatMap((entry) => scalarMetadataValues(entry, depth + 1))
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
  return tokens.length === 0 ? null : {
    compact: tokens.join(''),
    tokens: new Set(tokens),
    weight,
  }
}
function selectableGraphNode(
  attributes: GraphAttributes, sourceFile: string, index: ReadyQueryIndex,
): boolean {
  if (attributes.framework_metadata && typeof attributes.framework_metadata === 'object'
    && 'external_call' in attributes.framework_metadata
    && attributes.framework_metadata.external_call === true) return false
  if (stringAttribute(attributes, 'node_kind') !== 'file') {
    return !!attributes.definition_range && !!attributes.declaration_range
  }
  return sourceFile.length > 0
    && Array.isArray(attributes.provenance)
    && attributes.provenance.length > 0
    && index.file_hashes.has(sourceFile)
}

function buildCorpus(index: ReadyQueryIndex): RankCorpus {
  const nodes: RankCorpusNode[] = []
  for (const [id, attributes] of index.graph.nodeEntries()) {
    const sourceFile = stringAttribute(attributes, 'source_file')
    const polluted = sourceFile.length > 0 && isPollutedSourcePath(sourceFile, index.root_path)
    const nodeKind = stringAttribute(attributes, 'node_kind')

    const metadata = scalarMetadataValues(attributes.framework_metadata).join(' ')
    const ownFields = [
      field(stringAttribute(attributes, 'label'), FIELD_WEIGHTS.label),
      field(stringAttribute(attributes, 'qualified_name'), FIELD_WEIGHTS.qualifiedName),
      field([
        stringAttribute(attributes, 'framework'),
        stringAttribute(attributes, 'framework_role'),
      ].join(' '), FIELD_WEIGHTS.framework),
      field(metadata, FIELD_WEIGHTS.metadata),
      field(stringAttribute(attributes, 'node_kind'), FIELD_WEIGHTS.nodeKind),
    ].filter((entry): entry is RankField => entry !== null)
    const rankFields = [
      ...ownFields,
      field(sourceFile, FIELD_WEIGHTS.sourceFile),
    ].filter((entry): entry is RankField => entry !== null)
    const tokens = new Set(rankFields.flatMap((entry) => [...entry.tokens]))
    const successors = index.graph.successors(id)
    const outgoingIds = nodeKind === 'file' ? [] : successors.filter((targetId) =>
      index.graph.edgesBetween(id, targetId).some(({ attributes: edge }) =>
        edge.relation === 'calls' || edge.relation === 'enqueues_job'))
    const incomingIds = nodeKind === 'file' ? [] : index.graph.predecessors(id).filter((sourceId) =>
      index.graph.edgesBetween(sourceId, id).some(({ attributes: edge }) =>
        edge.relation === 'calls' || edge.relation === 'enqueues_job'))
    nodes.push({
      id,
      documentKey: sourceFile || id,
      attributes,
      fields: rankFields,
      tokens,
      pathTokens: new Set(lexicalTokens(sourceFile)),
      sourceFile,
      sourceDomain: sourceDomainOf(attributes.source_domain, sourceFile, index.root_path),
      nodeKind,
      incomingIds,
      outgoingIds,
      outgoingDegree: successors.length,
      lineSpan: typeof attributes.line_number === 'number' && typeof attributes.end_line_number === 'number'
        ? Math.max(1, attributes.end_line_number - attributes.line_number + 1)
        : Number.MAX_SAFE_INTEGER,
      selectable: !polluted && selectableGraphNode(attributes, sourceFile, index),
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
  return { nodes, nodeById: new Map(nodes.map((node) => [node.id, node])),
    documentFrequency, fileTermWeights }
}

function explicitScopes(question: string): ExplicitScope[] {
  const scopes: ExplicitScope[] = []
  const seen = new Set<string>()
  const patterns = [
    [/`([A-Za-z_$][A-Za-z0-9_$.:]*)`/g, false],
    [/\b(?:[A-Za-z0-9_$.[\]-]+\/)+[A-Za-z0-9_$.[\]-]+\.(?:[cm]?[jt]sx?)\b/g, true],
    [/\b(?=[a-z0-9-]*\d)[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g, true],
  ] as const
  for (const [pattern, restrictsCandidates] of patterns) {
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
  const task = question.replace(/\.\s+(?:cite|use|report)\b[\s\S]*$/iu, '')
  const rawTokens = lexicalTokens(task)
  const terms: string[] = []
  const positions = new Map<string, number>()
  for (const [index, token] of rawTokens.entries()) {
    if (STOP_WORDS.has(token)) continue
    if (!positions.has(token)) {
      positions.set(token, index)
      terms.push(token)
    }
  }
  const relations = relationTerms(task, relationKinds)
  for (const { term, position } of relations) {
    if (!positions.has(term)) {
      positions.set(term, position)
      terms.push(term)
    }
  }
  const scopes = explicitScopes(task)
  const firstDelimiter = task.match(/[,;:]/u)?.[0]
  const segments = task.split(/[,;:]+/u).map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  const topic = meaningfulTokens(segments[0] ?? '')
  const obligationSegments = relations.length > 0 ? [task]
    : firstDelimiter === ',' ? segments.slice(1) : segments
  const obligations = obligationSegments.map((text): QueryObligation => {
    const segment = meaningfulTokens(text)
    const action = text.replace(/^(?:and\s+then|and)\s+/iu, '')
    return {
    terms: [...new Set([...segment, ...topic])],
    localTerms: new Set(segment),
      coordinated: /\band\b/iu.test(action),
    }
  })
  return {
    question: task, terms, positions, scopes, obligations,
    constraints: scopes.filter((scope) => scope.restrictsCandidates),
  }
}
function rarityWeight(corpus: RankCorpus, token: string): number {
  const documents = Math.max(1, corpus.fileTermWeights.size)
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
  corpus: RankCorpus, node: RankCorpusNode, vocabulary: QueryVocabulary,
): RankedQueryNode | null {
  const scoringTerms = vocabulary.terms.filter((token) =>
    !token.includes('_') && !token.includes('-') && tokenSetMatches(node.tokens, token))
  const contextualTerms = vocabulary.terms.filter((token) => !scoringTerms.includes(token)
    && [...node.incomingIds, ...node.outgoingIds].some((id) => {
      const neighbor = corpus.nodeById.get(id)
      return !!neighbor?.selectable && neighbor.nodeKind !== 'file'
        && tokenSetMatches(neighbor.tokens, token)
    })).sort((left, right) => rarityWeight(corpus, right) - rarityWeight(corpus, left)
      || compareCodeUnits(left, right))
  if (scoringTerms.length === 0 && contextualTerms.length === 0
    && !vocabulary.scopes.some((scope) => matchesScope(node, scope))) return null
  let score = domainAdjustment(node.sourceDomain)
  for (const token of scoringTerms) {
    const termScore = rarityWeight(corpus, token) * node.fields.reduce((weight, candidate) =>
      tokenSetMatches(candidate.tokens, token) ? Math.max(weight, candidate.weight) : weight, 0)
    score += termScore
    if (tokenSetMatches(node.pathTokens, token)) {
      score += rarityWeight(corpus, token) * FIELD_WEIGHTS.sourceFile
    }
  }
  const matchedTerms = [...scoringTerms, ...contextualTerms]
  for (const token of contextualTerms) {
    score += rarityWeight(corpus, token) * FIELD_WEIGHTS.framework
  }
  for (const scope of vocabulary.scopes) {
    if (!scope.restrictsCandidates) {
      if (node.fields.some((candidate) => candidate.compact === scope.compact)) score += 2_000_000
      else if (matchesScope(node, scope)) score += 1_000_000
    }
  }
  if (exactLabelMatch(node, vocabulary)) score += 2_000_000
  if (['interface', 'type-alias'].includes(node.nodeKind)
    && vocabulary.terms.some((term) => term === 'defin' || term === 'declar')) score += 1_000_000
  const localContext = contextualTerms.filter((token) => node.outgoingIds.some((id) => {
    const neighbor = corpus.nodeById.get(id)
    return neighbor?.sourceFile === node.sourceFile && tokenSetMatches(neighbor.tokens, token)
  }))
  const firstMatch = [...scoringTerms, ...localContext].reduce((last, token) =>
    Math.max(last, vocabulary.positions.get(token) ?? 0), 0)
  return { id: node.id, attributes: node.attributes, score, matchedTerms, firstMatch }
}
function scoreRepresentative(
  corpus: RankCorpus, node: RankCorpusNode, ranked: RankedQueryNode,
): number {
  let score = ranked.matchedTerms.reduce((total, token) =>
    total + rarityWeight(corpus, token) * node.fields.reduce((highest, candidate) =>
      tokenSetMatches(candidate.tokens, token) ? Math.max(highest, candidate.weight) : highest, 0), 0)
  if (stringAttribute(node.attributes, 'framework_role')) score += FIELD_WEIGHTS.framework * 64
  if (node.attributes.exported === true) score += FIELD_WEIGHTS.label * 64
  return score + node.outgoingDegree * FIELD_WEIGHTS.sourceFile * 64
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
function exactLabelMatch(node: RankCorpusNode, vocabulary: QueryVocabulary): boolean {
  const label = stringAttribute(node.attributes, 'label')
  return meaningfulTokens(label).length > 0 && vocabulary.question.includes(label)
}
function isFlowQuestion(question: string): boolean { return /\bflow\b|(?=[^]*report)(?=[^]*generat)/iu.test(question) }
function hasStageRange(question: string): boolean { return /\bbetween\b|\bfrom\b[^]*\b(?:to|through)\b|\b(?:pipeline|queue|stage)\s+flow\b/iu.test(question) }

function scoredNodes(corpus: RankCorpus, vocabulary: QueryVocabulary): ScoredNode[] {
  const requestedDomains = new Set(
    Object.entries(SOURCE_DOMAIN_TERMS).flatMap(([domain, terms]) =>
      terms.some((term) => vocabulary.terms.includes(term)) ? [domain as SourceDomain] : []),
  )
  const structural = vocabulary.terms.includes('imports_from')
  const candidates = corpus.nodes.flatMap((node) => {
    if (!node.selectable) return []
    if (vocabulary.constraints.length > 0
      && !vocabulary.constraints.some((scope) => matchesScope(node, scope))) return []
    if (node.nodeKind === 'file' && !structural
      && !vocabulary.constraints.some((scope) =>
        scope.subject.includes('/') && matchesScope(node, scope))) return []
    const declarationPrefix = node.attributes.definition_range && node.attributes.declaration_range
      && canonicalJsonString(node.attributes.definition_range) !== canonicalJsonString(node.attributes.declaration_range)
    const implementation = node.nodeKind === 'file' || declarationPrefix
    const kindTokens = new Set(lexicalTokens(node.nodeKind))
    const requestedKind = vocabulary.terms.some((term) => kindTokens.has(term))
    if ((!implementation || ['interface', 'type-alias'].includes(node.nodeKind)) && !requestedKind && !(
      ['interface', 'type-alias'].includes(node.nodeKind) && vocabulary.terms.some((term) => term === 'defin' || term === 'declar'))
      && !vocabulary.scopes.some((scope) => matchesScope(node, scope))
      && !exactLabelMatch(node, vocabulary)) return []
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
  ).sort(compareScoredNodes)
  if (vocabulary.obligations.length > 1) return candidates
  const representatives = new Map<string, ScoredNode[]>()
  for (const candidate of candidates) {
    const key = vocabulary.scopes.some((scope) => matchesScope(candidate.node, scope))
      ? candidate.node.id : candidate.node.documentKey
    const current = representatives.get(key) ?? []
    current.push(candidate)
    representatives.set(key, current)
  }
  return [...representatives.entries()].flatMap(([key, current]) => {
    const ids = new Set(current.map(({ node }) => node.id))
    current.sort((left, right) =>
      right.node.outgoingIds.filter((id) => ids.has(id)).length
      - left.node.outgoingIds.filter((id) => ids.has(id)).length
      || right.representativeScore - left.representativeScore
      || compareScoredNodes(left, right))
    return current.slice(0, ids.has(key) ? 1 : 2)
  }).sort(compareScoredNodes)
}

function unsupportedCandidates(
  index: ReadyQueryIndex, vocabulary: QueryVocabulary,
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
  const newCoverage = (candidate: UnsupportedCandidate): number =>
    candidate.matchedTerms
      .filter((term) => !covered.has(term))
      .reduce((total, term) =>
        total + term.length ** 2 * (candidate.termWeights.get(term) ?? 1), 0)
  while (remaining.length > 0 && selected.length < MAX_UNSUPPORTED_BOUNDARIES) {
    remaining.sort((left, right) => {
      return newCoverage(right) - newCoverage(left)
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
  corpus: RankCorpus, vocabulary: QueryVocabulary, unsupported: readonly UnsupportedCandidate[],
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

function ownerFit(
  corpus: RankCorpus, candidate: ScoredNode, obligation: QueryObligation,
  selectedIds: ReadonlySet<string>,
): OwnerFit {
  const ownFields = candidate.node.fields.filter(({ weight }) =>
    weight !== FIELD_WEIGHTS.sourceFile)
  const supporters = candidate.node.outgoingIds
    .map((id) => corpus.nodeById.get(id))
    .filter((node): node is RankCorpusNode =>
      !!node?.selectable && node.sourceFile === candidate.node.sourceFile)
  const ownWeight = (term: string): number => ownFields.reduce((highest, field) =>
    tokenSetMatches(field.tokens, term) ? Math.max(highest, field.weight) : highest, 0)
  const supportMatch = (term: string): boolean => supporters.some((node) =>
    node.fields.some((field) =>
      field.weight !== FIELD_WEIGHTS.sourceFile && tokenSetMatches(field.tokens, term)))
  const ownedTerms = new Set<string>()
  const localCoveredTerms = new Set<string>()
  const coordinatedSupport = new Set<string>()
  let weighted = 0
  let ownCovered = 0
  let ownLocalCovered = 0
  for (const term of obligation.terms) {
    const own = ownWeight(term)
    const support = supportMatch(term)
    const path = tokenSetMatches(candidate.node.pathTokens, term)
    if (own === 0 && !support && !path) continue
    if (own > 0 || support) ownedTerms.add(term)
    if (obligation.localTerms.has(term)) {
      localCoveredTerms.add(term)
      ownLocalCovered += Number(own > 0)
      if (support) coordinatedSupport.add(term)
    }
    ownCovered += Number(own > 0)
    weighted += rarityWeight(corpus, term)
      * (own || (support ? FIELD_WEIGHTS.framework : 2))
  }
  const lead = [...obligation.localTerms][0]
  const bridgeLead = !!lead
    && localCoveredTerms.size === 0
    && candidate.node.incomingIds.some((id) => selectedIds.has(id))
    && candidate.node.outgoingIds.some((id) => {
      const neighbor = corpus.nodeById.get(id)
      return !!neighbor?.selectable && tokenSetMatches(neighbor.tokens, lead)
    })
  const sameFileOutgoing = candidate.node.outgoingIds.filter((id) =>
    corpus.nodeById.get(id)?.sourceFile === candidate.node.sourceFile).length
  const ownerClass = Number(candidate.node.attributes.exported === true
    || candidate.node.nodeKind.includes('route')
    || stringAttribute(candidate.node.attributes, 'framework_role').includes('route'))
  const totalCovered = obligation.terms.filter((term) =>
    ownedTerms.has(term) || tokenSetMatches(candidate.node.pathTokens, term)).length
  const ownedTopic = obligation.terms.filter((term) =>
    !obligation.localTerms.has(term) && ownedTerms.has(term)).length
  const coherentTopic = ownLocalCovered > 0 ? ownedTopic : 0
  const labelTokens = candidate.node.fields[0]?.tokens ?? new Set<string>()
  const labelMatches = obligation.terms.filter((term) =>
    tokenSetMatches(labelTokens, term)).length
  const exactLabelMatches = obligation.terms.filter((term) =>
    labelTokens.has(term)).length
  const labelPrecision = Math.round(labelMatches * 1_000 / Math.max(1, labelTokens.size))
  return {
    candidate, ownedTerms, totalCovered,
    vector: [
      Number(bridgeLead),
      obligation.coordinated ? coordinatedSupport.size : 0,
      localCoveredTerms.size + coherentTopic,
      ownLocalCovered, localCoveredTerms.size, ownedTopic,
      ownCovered,
      ownedTopic > 0 ? labelPrecision : 0,
      ownedTopic > 0 ? exactLabelMatches : 0,
      weighted, labelPrecision, exactLabelMatches,
      ownerClass, sameFileOutgoing, candidate.representativeScore,
    ],
  }
}

function compareOwnerFits(left: OwnerFit, right: OwnerFit): number {
  for (let index = 0; index < left.vector.length; index += 1) {
    const difference = (right.vector[index] ?? 0) - (left.vector[index] ?? 0)
    if (difference !== 0) return difference
  }
  return compareScoredNodes(left.candidate, right.candidate)
}
function hasEvidenceEdge(index: ReadyQueryIndex, from: string, to: string): boolean {
  return index.graph.edgesBetween(from, to).some(({ attributes }) =>
    EVIDENCE_RELATIONS.some((relation) => attributes.relation === relation))
}

function rankDiverseAnchors(
  index: ReadyQueryIndex, corpus: RankCorpus,
  scored: readonly ScoredNode[], vocabulary: QueryVocabulary,
): RankSelection {
  const unscoped = vocabulary.scopes.length === 0
  const stageIntent = unscoped && hasStageRange(vocabulary.question)
    && (isFlowQuestion(vocabulary.question)
      || /\b(?:pipeline|queues?|stages?)\b/iu.test(vocabulary.question))
  if (vocabulary.obligations.length > 1 && !stageIntent) {
    const selected: ScoredNode[] = []
    const selectedIds = new Set<string>()
    const selectedFiles = new Set<string>()
    for (const obligation of vocabulary.obligations) {
      const previous = selected.at(-1)
      const pivotal = [...obligation.localTerms][0]
      if (previous && pivotal
        && ownerFit(corpus, previous, obligation, selectedIds).ownedTerms.has(pivotal)) continue
      const bestByFile = new Map<string, OwnerFit>()
      for (const candidate of scored) {
        if (selectedFiles.has(candidate.node.sourceFile)) continue
        const fit = ownerFit(corpus, candidate, obligation, selectedIds)
        const current = bestByFile.get(candidate.node.sourceFile)
        if (!current || compareOwnerFits(fit, current) < 0) {
          bestByFile.set(candidate.node.sourceFile, fit)
        }
      }
      const next = [...bestByFile.values()]
        .filter((fit) => fit.totalCovered > 0 || fit.vector[0] === 1)
        .sort(compareOwnerFits)[0]
      if (!next) continue
      const candidate = next.candidate
      selected.push(candidate)
      selectedIds.add(candidate.node.id)
      selectedFiles.add(candidate.node.sourceFile)
    }
    return { anchors: selected.map(({ ranked }) => ranked), branch: '', flow: false }
  }
  const selected: ScoredNode[] = []
  const selectedIds = new Set<string>()
  const selectedFiles = new Set<string>()
  const coveredTerms = new Set<string>()
  let branch = ''
  const scoreFloor = Math.max(1, (scored[0]?.representativeScore ?? 0) / 4)
  const entry = (candidate: ScoredNode): number =>
    candidate.node.nodeKind.includes('route')
    || stringAttribute(candidate.node.attributes, 'framework_role').includes('route') ? 1 : 0
  const add = (candidate: ScoredNode): void => {
    selected.push(candidate); selectedIds.add(candidate.node.id); selectedFiles.add(candidate.node.sourceFile)
    for (const term of candidate.ranked.matchedTerms) {
      if (tokenSetMatches(candidate.node.tokens, term)) coveredTerms.add(term)
    }
  }
  const connected = (candidate: ScoredNode): number => selected.some(({ node }) => hasEvidenceEdge(index, node.id, candidate.node.id)) ? 1 : 0
  const coverage = (candidate: ScoredNode): number => candidate.ranked.matchedTerms
    .filter((term) => tokenSetMatches(candidate.node.tokens, term) && !coveredTerms.has(term))
    .reduce((total, term) => total + rarityWeight(corpus, term), 0)
  const successorContext = (node: RankCorpusNode): number => vocabulary.terms
    .filter((term) => tokenSetMatches(node.tokens, term) || node.outgoingIds.some((id) => {
      const target = corpus.nodeById.get(id)
      return !!target && tokenSetMatches(target.tokens, term)
    }))
    .reduce((total, term) => total + rarityWeight(corpus, term), 0)
  const flowIntent = unscoped && (stageIntent || isFlowQuestion(vocabulary.question))
  const locator = unscoped && !flowIntent && vocabulary.terms[0] === 'where'
  const flowTerms = vocabulary.terms.filter((term) => ['flow', 'pipelin', 'queue', 'stag', 'worker', 'process'].includes(term))
  const flowCoverage = (node?: RankCorpusNode): number => node ? flowTerms.filter((term) => tokenSetMatches(node.tokens, term)).length : 0
  let anchorLimit = MAX_RANKED_ANCHORS

  if (vocabulary.constraints.length === 0) {
    const route = scored.filter((candidate) => entry(candidate)).sort(compareScoredNodes)[0]
    const upstream = flowIntent ? scored.find((candidate) =>
      candidate.ranked.score * 4 >= (scored[0]?.ranked.score ?? 0) * 3
      && candidate.node.incomingIds.length === 0) : undefined
    const topicTerms = vocabulary.terms.filter((term) => !flowTerms.includes(term))
    const topicRank = (node: RankCorpusNode): number => topicTerms
      .filter((term) => tokenSetMatches(node.tokens, term))
      .reduce((score, term) => score + 1_000
        - (vocabulary.positions.get(term) ?? 0), 0)
    const stageEntry = stageIntent ? scored.filter(({ node }) =>
      node.incomingIds.length === 0 && node.outgoingIds.some((id) =>
        flowCoverage(corpus.nodeById.get(id))))
      .sort((left, right) => topicRank(right.node) - topicRank(left.node)
        || compareScoredNodes(left, right))[0] : undefined
    const seed = flowIntent ? route ?? stageEntry ?? upstream ?? scored[0] : scored[0]
    if (seed) {
      add(seed)
      const targets = seed.node.outgoingIds.map((id) => corpus.nodeById.get(id))
        .filter((node): node is RankCorpusNode =>
          !!node?.selectable && node.sourceFile !== seed.node.sourceFile)
        .sort((left, right) =>
          successorContext(right) - successorContext(left)
          || right.outgoingDegree - left.outgoingDegree
          || compareCodeUnits(left.id, right.id))
      const relevantTargets = targets.filter((target) => successorContext(target) > 0)
      const registrationFor = (node: RankCorpusNode): RankCorpusNode | undefined =>
        corpus.nodes.find((candidate) =>
          candidate.selectable && candidate.id !== node.id
          && candidate.sourceFile === node.sourceFile && candidate.incomingIds.length > 1
          && tokenSetMatches(candidate.tokens, 'register')
          && tokenSetMatches(candidate.tokens, 'worker'))
      const nextStep = (node: RankCorpusNode): RankCorpusNode | undefined => {
        const candidates = node.outgoingIds.map((id) => corpus.nodeById.get(id))
          .filter((next): next is RankCorpusNode => !!next?.selectable)
        if (!stageIntent) return candidates[0]
        return candidates.sort((left, right) =>
          flowCoverage(right) - flowCoverage(left)
          || Number(!!registrationFor(right)) - Number(!!registrationFor(left))
          || right.incomingIds.length - left.incomingIds.length
          || compareCodeUnits(left.id, right.id))[0]
      }
      const bridgePairs = targets.flatMap((target) => {
        const next = nextStep(target)
        return next ? [[target, next] as const] : []
      })
      const bridgePair = flowIntent
        ? stageIntent
          ? [...bridgePairs].sort((left, right) =>
            flowCoverage(right[0]) + flowCoverage(right[1])
              - flowCoverage(left[0]) - flowCoverage(left[1])
              || Number(!!registrationFor(right[1])) - Number(!!registrationFor(left[1]))
              || right[1].incomingIds.length - left[1].incomingIds.length
              || successorContext(left[0]) - successorContext(right[0])
              || compareCodeUnits(left[0].id, right[0].id))[0]
          : bridgePairs.find(([target]) => successorContext(target) === 0)
        : undefined
      const bridge = bridgePair?.[0]
      if (bridge) anchorLimit = 4
      const handoff = bridgePair?.[1]
      const queued = handoff
        ? corpus.nodeById.get(handoff.outgoingIds.find((id) =>
          index.graph.edgesBetween(handoff.id, id)
            .some(({ attributes }) => attributes.relation === 'enqueues_job')) ?? '')
        : undefined
      const reaches = (source: RankCorpusNode, target: RankCorpusNode): boolean => {
        const seen = new Map([[source.id, 4]])
        const visit = (current: RankCorpusNode, depth: number): boolean =>
          depth > 0 && current.outgoingIds.some((id) => {
            if (id === target.id) return true
            const next = corpus.nodeById.get(id)
            const remaining = depth - 1
            if (!next?.selectable || (seen.get(id) ?? -1) >= remaining) return false
            seen.set(id, remaining)
            return visit(next, remaining)
          })
        return visit(source, 4)
      }
      const registration = stageIntent && handoff
        ? registrationFor(handoff) : undefined
      const consumers = registration
        ? registration.incomingIds.flatMap((id) => {
          const caller = corpus.nodeById.get(id)
          return caller?.outgoingIds.map((targetId) => corpus.nodeById.get(targetId))
            .filter((target): target is RankCorpusNode =>
              !!target?.selectable && target.sourceFile === caller.sourceFile) ?? []
        }) : []
      const degree = (node: RankCorpusNode): number => Math.max(0, ...node.outgoingIds
        .map((id) => corpus.nodeById.get(id)?.outgoingDegree ?? 0))
      const cycle = handoff
        ? consumers.filter((consumer) => reaches(consumer, handoff))
          .sort((left, right) =>
            Number(right.id === queued?.id) - Number(left.id === queued?.id)
            || degree(left) - degree(right)
            || compareCodeUnits(left.id, right.id))
        : []
      const terminal = handoff
        && !/\bbetween\b/iu.test(vocabulary.question)
        ? consumers.filter((consumer) => !reaches(consumer, handoff))
          .sort((left, right) => successorContext(right) - successorContext(left)
            || compareCodeUnits(left.id, right.id))[0]
        : undefined
      const stages = cycle.flatMap((consumer) => {
        const service = consumer.outgoingIds.map((id) => corpus.nodeById.get(id))
          .filter((candidate): candidate is RankCorpusNode =>
            !!candidate?.selectable && candidate.sourceFile !== consumer.sourceFile)
          .sort((left, right) => successorContext(right) - successorContext(left)
            || right.outgoingDegree - left.outgoingDegree
            || compareCodeUnits(left.id, right.id))[0]
        return [consumer, ...(service ? [service] : [])]
      })
      const ownerCompact = compactTokens(stageIntent
        ? vocabulary.question.match(
          /\b[A-Z][A-Za-z0-9]*(?:Agent|Service|Worker|Controller)\b/u,
        )?.[0] ?? '' : '')
      const queryOwner = ownerCompact
        ? scored.find(({ node }) => node.nodeKind !== 'class'
          && node.outgoingDegree > 0
          && node.fields.some(({ compact }) => compact.includes(ownerCompact)))?.node
        : undefined
      const ownerBranch = queryOwner
        && !stages.some(({ id }) => id === queryOwner.id) ? queryOwner : undefined
      if (ownerBranch) branch = ownerBranch.id
      const recovered = stages.flatMap((stage) =>
        ownerBranch && stage.outgoingIds.includes(ownerBranch.id)
          ? [stage, ownerBranch] : [stage])
      const selectedTargets = bridge
        ? (cycle.length ? [
          bridge,
          handoff!,
          ...recovered,
          ...(terminal ? [terminal] : []),
          ...(ownerBranch && !recovered.includes(ownerBranch) ? [ownerBranch] : []),
        ] : [
          bridge,
          handoff!,
          ...(queued?.selectable ? [queued] : []),
        ])
        : relevantTargets.length > 0 ? relevantTargets.slice(0, 1) : targets.slice(0, 1)
      const unique = [...new Map(selectedTargets.map((node) => [node.id, node])).values()]
      if (cycle.length) {
        anchorLimit = Math.min(MAX_RANKED_ANCHORS, selected.length + unique.length)
      }
      for (const target of unique) {
        if (selected.length >= anchorLimit
          || (!selectedFiles.has(target.sourceFile) && selectedFiles.size >= MAX_RETRIEVE_FILES)) break
        add(scored.find(({ node }) => node.id === target.id) ?? {
          node: target, representativeScore: successorContext(target), ranked: {
            id: target.id, attributes: target.attributes, score: 0,
            matchedTerms: vocabulary.terms.filter((term) => tokenSetMatches(target.tokens, term)),
            firstMatch: seed.ranked.firstMatch,
          },
        })
      }
      if (cycle.length) {
        return { anchors: selected.map(({ ranked }) => ranked), branch, flow: true }
      }
    }
  }
  while (selected.length < anchorLimit) {
    const eligible = scored.filter(({ node }) => !selectedIds.has(node.id)
      && (selectedFiles.has(node.sourceFile) || selectedFiles.size < MAX_RETRIEVE_FILES))
    if (eligible.length === 0) break
    const priority = (candidate: ScoredNode): number => candidate.ranked.score
      + coverage(candidate) * FIELD_WEIGHTS.label
      + candidate.node.outgoingDegree * FIELD_WEIGHTS.sourceFile * 64
    eligible.sort((left, right) => {
      return coverage(right) - coverage(left)
        || (unscoped
          ? connected(right) - connected(left)
            || right.node.outgoingDegree - left.node.outgoingDegree
          : 0)
        || (vocabulary.constraints.length > 0
        ? priority(right) - priority(left)
        : right.representativeScore - left.representativeScore)
        || connected(right) - connected(left)
        || compareScoredNodes(left, right)
    })
    const next = eligible[0]!
    if (locator && selected.length && (connected(next) === 0 || coverage(next) === 0)) break
    if (vocabulary.constraints.length === 0 && coverage(next) === 0 && connected(next) === 0) break
    if (vocabulary.constraints.length > 0 && selected.length > 0
      && !selectedFiles.has(next.node.sourceFile) && coverage(next) === 0) break
    if (next.representativeScore < scoreFloor && anchorLimit === MAX_RANKED_ANCHORS) break
    add(next)
  }
  const rootsOf = (candidates: readonly ScoredNode[]): ScoredNode[] => candidates
    .filter((candidate) => !candidates.some((other) =>
      other !== candidate && hasEvidenceEdge(index, other.node.id, candidate.node.id)))
  const ordered: ScoredNode[] = []
  const remaining = [...selected]
  while (remaining.length > 0) {
    const roots = rootsOf(remaining)
    const next = [...(roots.length > 0 ? roots : remaining)].sort((left, right) => {
      const leads = (candidate: ScoredNode): number =>
        remaining.some((other) => other !== candidate
          && hasEvidenceEdge(index, candidate.node.id, other.node.id)) ? 1 : 0
      return entry(right) - entry(left) || left.ranked.firstMatch - right.ranked.firstMatch
        || leads(right) - leads(left)
        || compareScoredNodes(left, right)
    })[0]!
    ordered.push(next)
    remaining.splice(remaining.indexOf(next), 1)
  }
  return { anchors: ordered.map(({ ranked }) => ranked), branch, flow: false }
}
function uniqueBoundaries(boundaries: readonly EvidenceBoundary[]): EvidenceBoundary[] {
  const byIdentity = new Map(boundaries.map((boundary) => [
    `${boundary.kind}\u0000${boundary.subject}`,
    boundary,
  ]))
  return [...byIdentity.values()].sort((left, right) =>
    compareCodeUnits(left.kind, right.kind) || compareCodeUnits(left.subject, right.subject))
}

export function rankQueryAnchors(
  index: ReadyQueryIndex, request: NormalizedRetrieveRequest,
): RankQueryResult {
  const corpus = buildCorpus(index)
  const vocabulary = queryVocabulary(request.question, EVIDENCE_RELATIONS)
  const activeScope = (scope: ExplicitScope): boolean => !scope.restrictsCandidates
    || scope.subject.includes('/') || corpus.nodes.some((node) => {
      const prefix = scope.tokens.filter((token) => !/^\d+$/.test(token))
      return prefix.every((token) => node.tokens.has(token))
        && [...node.tokens].some((token) => /^\d+$/.test(token))
    })
  for (const scope of vocabulary.scopes.filter((candidate) => !activeScope(candidate))) {
    const outside = new Set(lexicalTokens(request.question.replaceAll(scope.subject, '')))
    vocabulary.terms = vocabulary.terms.filter((term) =>
      !/^\d+$/.test(term) || !scope.tokens.includes(term) || outside.has(term))
  }
  vocabulary.scopes = vocabulary.scopes.filter(activeScope)
  vocabulary.constraints = vocabulary.scopes.filter((scope) => scope.restrictsCandidates)
  const unsupported = unsupportedCandidates(index, vocabulary)
  const unsupportedBoundaries = selectUnsupportedBoundaries(unsupported)
  const missingScopes = missingScopeBoundaries(corpus, vocabulary, unsupported)

  const scored = scoredNodes(corpus, vocabulary)
  const scopes = vocabulary.scopes.filter((scope) =>
    corpus.nodes.some((node) => node.selectable && matchesScope(node, scope)))
  const constraints = vocabulary.constraints.filter((scope) => scopes.includes(scope))
  const scopedTerms = new Set(scopes.flatMap((scope) => scope.tokens))
  const candidatePool = vocabulary.constraints.length > 0
    ? constraints.length === 0 ? [] : scored.filter(({ node }) =>
      constraints.some((scope) => matchesScope(node, scope)))
    : scopes.length === 0
    ? missingScopes.some((boundary) => boundary.kind === 'unavailable') ? [] : scored
    : scored.filter(({ node, ranked }) =>
      scopes.some((scope) => matchesScope(node, scope))
      || (scopes.length > 0
        && ranked.matchedTerms.some((term) => !scopedTerms.has(term))))
  const selection = rankDiverseAnchors(index, corpus, candidatePool, vocabulary)
  const { anchors } = selection
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
    anchors, boundaries: uniqueBoundaries(boundaries),
    queryTerms: vocabulary.terms, flow: selection.flow, branch: selection.branch,
  }
}
