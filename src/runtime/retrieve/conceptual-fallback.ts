import type { KnowledgeGraph } from '../../contracts/graph.js'
import type {
  ContextPackRetrievalPlanDetail,
  RepositoryVocabularySource,
  RetrievalFallbackAttempt,
  RetrievalFallbackReason,
  RetrievalQualitySnapshot,
} from '../../contracts/retrieval-plan.js'
import { classifySourceDomain, type SourceDomain } from '../../shared/source-discovery.js'

const MAX_QUERY_TERMS = 24
const MAX_QUERY_OBLIGATIONS = 6
const MAX_TERMS_PER_OBLIGATION = 6
const MAX_ANCHORS = 24
const MAX_PRIMARY_SOURCE_ANCHORS = 16
const MAX_ANCHORS_PER_SOURCE_FILE = 2
const MAX_PAIR_SEARCHES = 24
const MAX_PATH_DEPTH = 3
const MAX_BFS_VISITS = 240
const MAX_NEIGHBORS_PER_STEP = 32
const MAX_PROMOTED_CANDIDATES = 24
const MAX_EXPANSION_TERMS = 8
const MAX_OBLIGATION_CONNECTIVITY_CANDIDATES = 8
const ORIGINAL_SELECTION_RETENTION_BOOST = 1
export const CONCEPTUAL_WORKFLOW_RESERVATION_BOOST = 14
const CHANGE_LIFECYCLE_CONCEPT = '@change_lifecycle'
const DIVERGENCE_CONCEPT = '@divergence'
const COMPUTATION_CONCEPT = '@computation'
const DELIVERY_CONCEPT = '@delivery'
const FAILURE_CONCEPT = '@failure'
const TRANSITION_CONCEPT = '@transition'

const FLOW_BOUNDARY_PATTERN = /\b(becomes?|became|triggers?|triggered|affects?|affected|causes?|caused|leads?\s+to|result(?:s|ed)?\s+in|flows?\s+to|then)\b|\s+to\s+|[.;,]/gi
const READ_ONLY_CONSTRAINT_PATTERN = /\b(?:this\s+is\s+read[-\s]?only|read[-\s]?only(?=\s*:))[^.;]*(?:[.;]|$)/gi
const NO_WRITE_CONSTRAINT_PATTERN = /\b(?:do\s+not|don't|without)\s+(?:change|edit|modify|touch|write)(?:ing)?\b[^.;]*(?:[.;]|$)/gi
const CITATION_LIST_DIRECTIVE_PATTERN = /\bcite\b[^.;]*:\s*[^.;]*(?:[.;]|$)/gi
const REPEATED_FLOW_CHECKLIST_PATTERN = /\b(?:(?:cite|cover|follow|identify|list|show|trace)\b[^.;]{0,200}?(?::\s*|\bfrom\b)|include\b)[^.;]*(?:[.;]|$)/gi
const QUERY_DIRECTIVE_TERMS = new Set([
  'all', 'any', 'available', 'cannot', 'cite', 'clearly', 'compare', 'distinct', 'end',
  'evidence', 'every', 'exact', 'explain', 'identify', 'include', 'involved', 'prove',
  'note', 'relevant', 'remaining', 'path', 'paths', 'state', 'symbols', 'trace',
  'uncertainty',
])
const DIVERGENCE_SCOPE_NOISE = new Set(['across', 'logic', 'these'])

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
const DIVERGENCE_TERMS = new Set([
  'compare', 'compared', 'compares', 'comparing',
  'competing', 'conflict', 'conflicting',
  'discrepancy', 'distinct', 'diverge', 'divergent', 'divergence', 'inconsistent',
  'inconsistency', 'mismatch', 'mismatched',
])
const DIVERGENCE_PREFIXES = [
  'compet', 'conflict', 'discrep', 'diverg', 'inconsist', 'mismatch',
] as const
const COMPUTATION_TERMS = new Set([
  'calculate', 'calculated', 'calculates', 'calculating', 'calculation',
  'compute', 'computed', 'computes', 'computing', 'computation',
  'derive', 'derived', 'derives', 'deriving', 'derivation',
])
const COMPUTATION_PREFIXES = ['calculat', 'comput', 'deriv'] as const
const DELIVERY_TERMS = new Set([
  'deliver', 'delivered', 'delivering', 'delivers', 'delivery',
  'dispatch', 'dispatched', 'dispatches', 'dispatching',
  'emit', 'emits', 'emitted', 'emitting',
  'enqueue', 'enqueued', 'enqueues', 'enqueuing',
  'notify', 'notified', 'notifies', 'notifying',
  'publish', 'published', 'publishes', 'publishing',
  'send', 'sending', 'sends', 'sent',
  'trigger', 'triggered', 'triggering', 'triggers',
])
const DELIVERY_PREFIXES = [
  'deliver', 'dispatch', 'emit', 'enqueu', 'publish', 'send', 'trigger',
] as const
const FAILURE_TERMS = new Set([
  'down', 'error', 'errors', 'fail', 'failed', 'failing', 'fails', 'failure', 'failures',
])
const FAILURE_PREFIXES = ['fail'] as const
const TRANSITION_TERMS = new Set([
  'became', 'become', 'becomes',
  'create', 'created', 'creates', 'creating', 'creation',
  'insert', 'inserted', 'inserting', 'insertion',
  'open', 'opened', 'opening',
  'transition', 'transitioned', 'transitioning',
  'upsert', 'upserted', 'upserting',
])
const TRANSITION_PREFIXES = ['becom', 'creat', 'insert', 'open', 'transition', 'upsert'] as const

const PRESENTATION_QUERY_PATTERN = /\b(?:component|dashboard|frontend|render|screen|ui|visual|widget)\b/i
const PRESENTATION_PATH_PATTERN = /(?:\.(?:jsx|tsx)$|\/(?:components?|dashboard|views?|widgets?)\/)/i
const PRESENTATION_LABEL_PATTERN = /^(?:page\s+\/|.*(?:badge|card|component|screen|widget).*)$/i
const RUNTIME_PATH_PATTERN = /\/(?:api|checker|content|db|handlers?|persistence|routes?|schema|server|services?|workflows?)\//i
const CORE_BEHAVIOR_OWNER_PATH_PATTERN = /\/(?:api|checker|content|handlers?|services?|workflows?)\//i
const PERSISTENCE_PATH_PATTERN = /\/(?:db|persistence|repositories?|schema)(?:\/|\.)/i
const LOW_VALUE_OWNER_PATH_PATTERN = /(?:\.pb\.go$|(?:_pb|\.pb)\.ts$|\/(?:errors?|limits)\.[^/]+$|\/lib\/http\/etag\.[^/]+$|statusPage\.utils\.[^/]+$|\/content\/markdown\/)/i
const LOW_VALUE_OWNER_LABEL_PATTERN = /(?:Error\(\)?$|(?:create)?ErrorResponse\(\)?$|ErrorResponse$|Limits?\(\)?$|(?:assert|check)?\w*Quota\(\)?$|computeETag\(\)?$|validate\w*Access\(\)?$|(?:statusLabel|statusGlyph|generate\w*)\(\)?$)/i
const EXTERNAL_SCOPE_PATTERN = /(?:^|[\/_-])external(?:[\/_-]|$)/i
const FLOW_TEST_SOURCE_PATTERN = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:^|\/)(?:test|tests?[-_.][^/]*)\.[^/]+$|(?:\.test\.[^/]+$|\.spec\.[^/]+$|_test\.go$)/i
const FLOW_TYPE_SOURCE_PATTERN = /(?:^|\/)(?:types?|interfaces?)(?:\/|\.[^/]+$)|(?:^|\/)(?:types?|interfaces?)\.[^/]+$/i
const EXPLICIT_TEST_EVIDENCE_PATTERN = /\b(?:test|tests|testing|spec|specs|fixture|fixtures)\b/i
const EXPLICIT_TYPE_EVIDENCE_PATTERN = /\b(?:contract|contracts|interface|interfaces|schema|schemas|type|types)\b/i
const EXPLICIT_ERROR_DECLARATION_PATTERN = /\b(?:error\s+(?:class|constructor|handling)|exception|exceptions|throw|throws)\b/i
const QUERY_EVIDENCE_STATE_MUTATION_PATTERN = /(?:\b(?:create|insert|transition|upsert)\w*\s*\(|\.(?:create|insert|upsert)\s*\(|\bnew\s+\w+)/i
const QUERY_EVIDENCE_DELIVERY_OPERATION_PATTERN = /(?:\b(?:deliver|dispatch|emit|enqueue|publish|send)\w*\s*\(|\.(?:deliver|dispatch|emit|enqueue|publish|send)\w*\s*\()/i
const QUERY_EVIDENCE_COMPUTATION_OPERATION_PATTERN = /(?:\b(?:compute|derive|resolve)\w*\s*\(|\b\w*(?:indicator|result|state|status)\w*\s*=|\b\w*(?:indicator|status)\w*\s*\()/i
const EXPLICIT_ERROR_QUERY_PATTERN = /\b(?:error|exception|throw|throws|thrown)\b/i
const FLOW_OUTCOME_TERMS = new Set(['error', 'fail', 'failed', 'failure', 'result', 'response', 'status'])

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
  label: string
  sourceFile: string
  community: number | null
  fileType: string
  sourceDomain: SourceDomain
  fields: Map<RepositoryVocabularySource, Set<string>>
  allTerms: Set<string>
  structuralDegree: number
  nodeKind: string
  frameworkRole: string
}

interface RepositoryVocabularyIndex {
  nodes: VocabularyNode[]
  byId: Map<string, VocabularyNode>
  documentFrequency: Map<string, number>
  communityLabels: Map<number, string>
}

interface AnchorCandidate {
  id: string
  label: string
  sourceFile: string
  score: number
  matchedQueryTerms: Set<string>
  specificQueryTerms: Set<string>
  symbolQueryTerms: Set<string>
  pathQueryTerms: Set<string>
  sources: Set<RepositoryVocabularySource>
  obligationMatches: Map<number, number>
  structuralDegree: number
  presentationShaped: boolean
  transitionOwner: boolean
  persistenceShaped: boolean
  lowValueOwner: boolean
  behaviorOwner: boolean
  fileOwner: boolean
  publicBoundaryOwner: boolean
  runtimeScope: string
}

export interface QueryEvidenceObligation {
  index: number
  terms: string[]
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
  /** Internal prompt-obligation coverage used to decide whether recovery improved the result. */
  obligationMatches?: ReadonlyMap<string, ReadonlySet<number>>
  obligationCount?: number
  initialObligationCoverage?: number
  preferredObligationAnchors?: ReadonlyMap<number, string>
}

const vocabularyIndexCache = new WeakMap<KnowledgeGraph, RepositoryVocabularyIndex>()

function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1)
}

function normalizedQueryTerms(value: string): string[] {
  const lexical = [...new Set(
    tokenize(value)
      .filter((term) => !QUERY_STOP_WORDS.has(term))
      .map((term) => conceptualTerm(term)),
  )]
  const withoutDirectives = lexical.filter((term) => !QUERY_DIRECTIVE_TERMS.has(term))
  return withoutDirectives.slice(0, MAX_TERMS_PER_OBLIGATION)
}

function collapseOxfordEvidenceLists(value: string): string {
  return value.replace(
    /\b(for|across|between)\s+([^.;,]+),\s+([^.;,]+),\s+and\s+([^.;,]+?)(?=,\s+and\b|[.;]|$)/gi,
    (_match, preposition: string, first: string, second: string, third: string) => (
      `${preposition} ${first} ${second} and ${third}`
    ),
  )
}

function stripRepeatedFlowChecklists(value: string): string {
  return value.replace(REPEATED_FLOW_CHECKLIST_PATTERN, (match, offset: number) => {
    const prefix = value.slice(0, offset)
    const phaseSignals = prefix.match(/\b(?:becomes?|triggers?|affects?|causes?|leads?\s+to|flows?\s+to)\b/gi)?.length ?? 0
    if (phaseSignals < 2) {
      return match
    }

    const divergenceStart = match.search(/\b(?:compare|conflict|discrepancy|diverg(?:e|ent|ence)|inconsisten(?:t|cy)|mismatch)\b/i)
    return divergenceStart >= 0 ? ` ${match.slice(divergenceStart)}` : ' '
  })
}

export function queryEvidenceObligations(question: string): QueryEvidenceObligation[] {
  const evidenceQuestion = collapseOxfordEvidenceLists(stripRepeatedFlowChecklists(question
    .replace(READ_ONLY_CONSTRAINT_PATTERN, ' ')
    .replace(NO_WRITE_CONSTRAINT_PATTERN, ' ')
    .replace(CITATION_LIST_DIRECTIVE_PATTERN, ' ')))
  const groups: string[][] = []
  const seen = new Set<string>()
  let start = 0
  let boundaryTerms: string[] = []
  const append = (segment: string): void => {
    const terms = [...new Set([...boundaryTerms, ...normalizedQueryTerms(segment)])]
    const key = terms.join('\u0000')
    if (terms.length > 0 && !seen.has(key) && groups.length < MAX_QUERY_OBLIGATIONS) {
      seen.add(key)
      groups.push(terms.slice(0, MAX_TERMS_PER_OBLIGATION))
    }
    boundaryTerms = []
  }
  for (const match of evidenceQuestion.matchAll(FLOW_BOUNDARY_PATTERN)) {
    append(evidenceQuestion.slice(start, match.index))
    if (groups.length >= MAX_QUERY_OBLIGATIONS) {
      break
    }
    boundaryTerms = typeof match[1] === 'string' ? normalizedQueryTerms(match[1]) : []
    start = (match.index ?? start) + match[0].length
  }
  if (groups.length < MAX_QUERY_OBLIGATIONS) {
    append(evidenceQuestion.slice(start))
  }

  if (groups.length === 0) {
    const terms = normalizedQueryTerms(evidenceQuestion)
    if (terms.length > 0) {
      groups.push(terms)
    }
  }
  return groups.map((terms, index) => ({ index, terms }))
}

function queryTerms(obligations: readonly QueryEvidenceObligation[]): string[] {
  return [...new Set(obligations.flatMap((obligation) => obligation.terms))].slice(0, MAX_QUERY_TERMS)
}

function divergenceScopeTerms(obligation: QueryEvidenceObligation | undefined): string[] {
  if (!obligation) {
    return []
  }
  const literalTerms = obligation.terms.filter((term) => !term.startsWith('@'))
  const scopedTerms = literalTerms.filter((term) => !DIVERGENCE_SCOPE_NOISE.has(term))
  return scopedTerms.length > 0 ? scopedTerms : literalTerms
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

function divergenceTerm(term: string): boolean {
  return DIVERGENCE_TERMS.has(term)
    || DIVERGENCE_PREFIXES.some((prefix) => term.startsWith(prefix))
}

function computationTerm(term: string): boolean {
  return COMPUTATION_TERMS.has(term)
    || COMPUTATION_PREFIXES.some((prefix) => term.startsWith(prefix))
}

function deliveryTerm(term: string): boolean {
  return DELIVERY_TERMS.has(term)
    || DELIVERY_PREFIXES.some((prefix) => term.startsWith(prefix))
}

function failureTerm(term: string): boolean {
  return FAILURE_TERMS.has(term)
    || FAILURE_PREFIXES.some((prefix) => term.startsWith(prefix))
}

function transitionTerm(term: string): boolean {
  return TRANSITION_TERMS.has(term)
    || TRANSITION_PREFIXES.some((prefix) => term.startsWith(prefix))
}

function conceptualTerm(term: string): string {
  if (changeLifecycleTerm(term)) {
    return CHANGE_LIFECYCLE_CONCEPT
  }
  if (divergenceTerm(term)) {
    return DIVERGENCE_CONCEPT
  }
  if (computationTerm(term)) {
    return COMPUTATION_CONCEPT
  }
  if (deliveryTerm(term)) {
    return DELIVERY_CONCEPT
  }
  if (failureTerm(term)) {
    return FAILURE_CONCEPT
  }
  if (transitionTerm(term)) {
    return TRANSITION_CONCEPT
  }
  return term
}

export function queryEvidenceTermsMatch(left: string, right: string): boolean {
  if (left === CHANGE_LIFECYCLE_CONCEPT) {
    return changeLifecycleTerm(right)
  }
  if (right === CHANGE_LIFECYCLE_CONCEPT) {
    return changeLifecycleTerm(left)
  }
  if (left === DIVERGENCE_CONCEPT) {
    return divergenceTerm(right)
  }
  if (right === DIVERGENCE_CONCEPT) {
    return divergenceTerm(left)
  }
  if (left === COMPUTATION_CONCEPT) {
    return computationTerm(right)
  }
  if (right === COMPUTATION_CONCEPT) {
    return computationTerm(left)
  }
  if (left === DELIVERY_CONCEPT) {
    return deliveryTerm(right)
  }
  if (right === DELIVERY_CONCEPT) {
    return deliveryTerm(left)
  }
  if (left === FAILURE_CONCEPT) {
    return failureTerm(right)
  }
  if (right === FAILURE_CONCEPT) {
    return failureTerm(left)
  }
  if (left === TRANSITION_CONCEPT) {
    return transitionTerm(right)
  }
  if (right === TRANSITION_CONCEPT) {
    return transitionTerm(left)
  }
  return lexicalTermsMatch(left, right)
}

export interface QueryEvidenceNode {
  label: string
  source_file: string
  snippet?: string | null
}

export interface QueryEvidenceCoverage {
  total: number
  covered: number
  covered_obligations: string[]
  missing_obligations: string[]
}

export function flowQueryEvidenceCandidateAllowed(
  question: string,
  node: { label: string; sourceFile: string; nodeKind?: string },
): boolean {
  if (queryEvidenceObligations(question).length < 3) {
    return true
  }
  const normalizedKind = node.nodeKind?.trim().toLowerCase() ?? ''
  if (!EXPLICIT_TEST_EVIDENCE_PATTERN.test(question) && FLOW_TEST_SOURCE_PATTERN.test(node.sourceFile)) {
    return false
  }
  if (
    !EXPLICIT_TYPE_EVIDENCE_PATTERN.test(question)
    && (FLOW_TYPE_SOURCE_PATTERN.test(node.sourceFile) || /^(?:enum|interface|property|type)$/.test(normalizedKind))
  ) {
    return false
  }
  const normalizedLabel = node.label.replace(/\(\)$/, '').trim().toLowerCase()
  const explicitlyNamed = normalizedLabel.length >= 4 && question.toLowerCase().includes(normalizedLabel)
  if (
    !/\bexternal\b/i.test(question)
    && (EXTERNAL_SCOPE_PATTERN.test(node.sourceFile) || EXTERNAL_SCOPE_PATTERN.test(node.label))
  ) {
    return false
  }
  if (
    !explicitlyNamed
    && !EXPLICIT_ERROR_DECLARATION_PATTERN.test(question)
    && (LOW_VALUE_OWNER_PATH_PATTERN.test(node.sourceFile) || LOW_VALUE_OWNER_LABEL_PATTERN.test(node.label))
  ) {
    return false
  }
  return true
}

function queryEvidenceNodeTokens(node: QueryEvidenceNode): { identity: string[]; snippet: string[] } {
  return {
    identity: tokenize(`${node.label} ${node.source_file}`),
    snippet: tokenize(node.snippet ?? ''),
  }
}

function queryEvidenceDivergenceCovered(
  obligation: QueryEvidenceObligation,
  previous: QueryEvidenceObligation | undefined,
  nodes: readonly QueryEvidenceNode[],
): boolean {
  if (!previous) {
    return false
  }
  const subjectTerms = divergenceScopeTerms(previous)
  const requiredScopeMatches = Math.min(2, subjectTerms.length)
  if (requiredScopeMatches === 0) {
    return false
  }
  const owners = new Set<string>()
  const computationOwners = new Set<string>()
  for (const node of nodes) {
    const tokens = queryEvidenceNodeTokens(node)
    if (tokens.snippet.length === 0) {
      continue
    }
    const allTokens = [...tokens.identity, ...tokens.snippet]
    const scopeMatches = subjectTerms.filter((term) => (
      allTokens.some((token) => queryEvidenceTermsMatch(term, token))
    )).length
    const computationMatch = allTokens.some((token) => queryEvidenceTermsMatch(COMPUTATION_CONCEPT, token))
      || QUERY_EVIDENCE_COMPUTATION_OPERATION_PATTERN.test(node.snippet ?? '')
    const statusLikeMatch = obligation.terms
      .filter((term) => !term.startsWith('@'))
      .some((term) => allTokens.some((token) => queryEvidenceTermsMatch(term, token)))
    if (scopeMatches >= requiredScopeMatches && (computationMatch || statusLikeMatch)) {
      owners.add(node.source_file)
      if (computationMatch) computationOwners.add(node.source_file)
    }
  }
  return owners.size >= 2 && computationOwners.size >= 1
}

/** Measures whether selected snippets, rather than filenames alone, carry each prompt obligation. */
export function evaluateQueryEvidenceCoverage(
  question: string,
  nodes: readonly QueryEvidenceNode[],
): QueryEvidenceCoverage {
  const obligations = queryEvidenceObligations(question)
  const coveredObligations: string[] = []
  const missingObligations: string[] = []

  for (const obligation of obligations) {
    const key = `query:obligation:${obligation.index + 1}`
    if (obligation.terms.includes(DIVERGENCE_CONCEPT)) {
      const previous = obligations.find((candidate) => candidate.index === obligation.index - 1)
      if (queryEvidenceDivergenceCovered(obligation, previous, nodes)) {
        coveredObligations.push(key)
      } else {
        missingObligations.push(key)
      }
      continue
    }

    let coveredByOneEvidenceOwner = false
    for (const node of nodes) {
      const tokens = queryEvidenceNodeTokens(node)
      const snippet = node.snippet ?? ''
      const matchedTerms = new Set<string>()
      const snippetMatchedTerms = new Set<string>()
      for (const term of obligation.terms) {
        if ([...tokens.identity, ...tokens.snippet].some((token) => queryEvidenceTermsMatch(term, token))) {
          matchedTerms.add(term)
        }
        if (tokens.snippet.some((token) => queryEvidenceTermsMatch(term, token))) {
          snippetMatchedTerms.add(term)
        }
        if (term === COMPUTATION_CONCEPT && QUERY_EVIDENCE_COMPUTATION_OPERATION_PATTERN.test(snippet)) {
          matchedTerms.add(term)
          snippetMatchedTerms.add(term)
        }
      }
      const requiredMatches = Math.min(2, obligation.terms.length)
      const conceptualTerms = obligation.terms.filter((term) => term.startsWith('@'))
      const literalTerms = obligation.terms.filter((term) => !term.startsWith('@'))
      const conceptualSnippetGrounded = conceptualTerms.length === 0
        || conceptualTerms.some((term) => snippetMatchedTerms.has(term))
      const literalSnippetGrounded = literalTerms.length === 0
        || literalTerms.some((term) => snippetMatchedTerms.has(term))
      const transitionCooccursWithEntity = !conceptualTerms.includes(TRANSITION_CONCEPT)
        || (node.snippet ?? '').split(/\r?\n/).some((line) => {
          const lineTokens = tokenize(line)
          return lineTokens.some((token) => queryEvidenceTermsMatch(TRANSITION_CONCEPT, token))
            && literalTerms.some((term) => lineTokens.some((token) => queryEvidenceTermsMatch(term, token)))
            && QUERY_EVIDENCE_STATE_MUTATION_PATTERN.test(line)
        })
      const deliveryCooccursWithEntity = !conceptualTerms.includes(DELIVERY_CONCEPT)
        || snippet.split(/\r?\n/).some((line) => {
          const lineTokens = tokenize(line)
          return lineTokens.some((token) => queryEvidenceTermsMatch(DELIVERY_CONCEPT, token))
            && literalTerms.some((term) => lineTokens.some((token) => queryEvidenceTermsMatch(term, token)))
            && QUERY_EVIDENCE_DELIVERY_OPERATION_PATTERN.test(line)
        })
      const computationCooccursWithEntity = !conceptualTerms.includes(COMPUTATION_CONCEPT)
        || snippet.split(/\r?\n/).some((line) => {
          const lineTokens = tokenize(line)
          return QUERY_EVIDENCE_COMPUTATION_OPERATION_PATTERN.test(line)
            && literalTerms.some((term) => lineTokens.some((token) => queryEvidenceTermsMatch(term, token)))
        })
      if (
        matchedTerms.size >= requiredMatches
        && conceptualSnippetGrounded
        && literalSnippetGrounded
        && transitionCooccursWithEntity
        && deliveryCooccursWithEntity
        && computationCooccursWithEntity
      ) {
        coveredByOneEvidenceOwner = true
        break
      }
    }
    if (coveredByOneEvidenceOwner) {
      coveredObligations.push(key)
    } else {
      missingObligations.push(key)
    }
  }

  return {
    total: obligations.length,
    covered: coveredObligations.length,
    covered_obligations: coveredObligations,
    missing_obligations: missingObligations,
  }
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
      label,
      sourceFile,
      community,
      fileType,
      sourceDomain: classifySourceDomain(
        sourceFile,
        typeof graph.graph.root_path === 'string' ? graph.graph.root_path : undefined,
      ),
      fields,
      allTerms,
      structuralDegree: graph.incidentNeighbors(id, MAX_NEIGHBORS_PER_STEP).length,
      nodeKind: String(attributes.node_kind ?? '').trim().toLowerCase(),
      frameworkRole: String(attributes.framework_role ?? '').trim().toLowerCase(),
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

function runtimeAnchorAdjustment(node: VocabularyNode, question: string): number {
  let adjustment = 0
  const explicitlyRequestsPresentation = PRESENTATION_QUERY_PATTERN.test(question)
  if (!explicitlyRequestsPresentation) {
    let presentationSignals = 0
    if (PRESENTATION_PATH_PATTERN.test(node.sourceFile)) presentationSignals += 1
    if (PRESENTATION_LABEL_PATTERN.test(node.label)) presentationSignals += 1
    if (/^(?:component|page|screen|view|widget)$/.test(node.frameworkRole)) presentationSignals += 1
    adjustment -= Math.min(3.5, presentationSignals * 1.75)
  }
  if (RUNTIME_PATH_PATTERN.test(node.sourceFile)) {
    adjustment += 0.75
  }
  if (/\(\)$/.test(node.label) || /^(?:function|method|route)$/.test(node.nodeKind)) {
    adjustment += 0.5
  }
  if (node.nodeKind === 'method' && node.structuralDegree <= 1) {
    // Extractors model many nested/external calls as degree-one method nodes.
    // They can prove a detail, but they are poor workflow anchors compared with
    // the owning function or route around them.
    adjustment -= 2.5
  }
  if (LOW_VALUE_OWNER_PATH_PATTERN.test(node.sourceFile)) {
    adjustment -= 2
  }
  if (LOW_VALUE_OWNER_LABEL_PATTERN.test(node.label)) {
    adjustment -= EXPLICIT_ERROR_QUERY_PATTERN.test(question) ? 0.75 : 2
  }
  return adjustment
}

function presentationShapedNode(node: VocabularyNode): boolean {
  return PRESENTATION_PATH_PATTERN.test(node.sourceFile)
    || PRESENTATION_LABEL_PATTERN.test(node.label)
    || /^(?:component|page|screen|view|widget)$/.test(node.frameworkRole)
}

function runtimeScopeForSource(sourceFile: string): string {
  const normalized = sourceFile.replaceAll('\\', '/')
  const match = normalized.match(/\/(apps|packages)\/([^/]+)/i)
  if (match?.[1] && match[2]) {
    return `${match[1].toLowerCase()}/${match[2].toLowerCase()}`
  }
  const parts = normalized.split('/').filter(Boolean)
  return parts.slice(-3, -1).join('/') || normalized
}

function fileOwnerNode(node: Pick<VocabularyNode, 'label' | 'sourceFile' | 'nodeKind'>): boolean {
  const basename = node.sourceFile.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
  const normalizedLabel = node.label.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
  return normalizedLabel === basename
    || (node.nodeKind.trim().length === 0 && normalizedLabel.replace(/\.[^.]+$/, '') === basename.replace(/\.[^.]+$/, ''))
}

function publicBoundaryOwnerNode(node: Pick<VocabularyNode, 'label' | 'sourceFile' | 'frameworkRole'>): boolean {
  const normalizedSource = node.sourceFile.replaceAll('\\', '/')
  const routePath = /\/(?:app\/)?api\//i.test(normalizedSource)
    && /\/route\.[^/]+$/i.test(normalizedSource)
  const routeLabel = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(?:\(\)|\s|$)|^route\.[^.]+$/i.test(node.label)
  return (routePath && routeLabel) || /(?:route|request)_handler/i.test(node.frameworkRole)
}

function runtimeLanguageForSource(sourceFile: string): string {
  return sourceFile.replaceAll('\\', '/').split('.').at(-1)?.toLowerCase() ?? ''
}

function vocabularyDocumentFrequency(index: RepositoryVocabularyIndex, queryTerm: string): number {
  let count = 0
  for (const [term, frequency] of index.documentFrequency) {
    if (queryEvidenceTermsMatch(queryTerm, term)) {
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
  obligations: readonly QueryEvidenceObligation[],
  question: string,
): AnchorCandidate | null {
  const matchedQueryTerms = new Set<string>()
  const specificQueryTerms = new Set<string>()
  const symbolQueryTerms = new Set<string>()
  const pathQueryTerms = new Set<string>()
  const sources = new Set<RepositoryVocabularySource>()
  let score = 0

  for (const queryTerm of terms) {
    let bestWeight = 0
    for (const [source, vocabulary] of node.fields) {
      if ([...vocabulary].some((term) => queryEvidenceTermsMatch(queryTerm, term))) {
        sources.add(source)
        if (source !== 'graph_community' && source !== 'path') {
          specificQueryTerms.add(queryTerm)
        }
        if (source === 'exported_symbol' || source === 'document_heading') {
          symbolQueryTerms.add(queryTerm)
        }
        if (source === 'path' || source === 'module_name') {
          pathQueryTerms.add(queryTerm)
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
  const obligationMatches = new Map<number, number>()
  for (const obligation of obligations) {
    const matchedTerms = obligation.terms.filter((term) => matchedQueryTerms.has(term)).length
    const previous = obligations.find((candidate) => candidate.index === obligation.index - 1)
    const previousTerms = divergenceScopeTerms(previous)
    const scopedSubjectMatches = previousTerms.filter((term) => matchedQueryTerms.has(term)).length
    const requiredMatches = obligation.terms.includes(DIVERGENCE_CONCEPT) && scopedSubjectMatches >= 2
      ? 1
      : Math.min(2, obligation.terms.length)
    const lifecycleConcepts = obligation.terms.filter((term) => (
      term === COMPUTATION_CONCEPT
        || term === DELIVERY_CONCEPT
        || term === FAILURE_CONCEPT
        || term === TRANSITION_CONCEPT
    ))
    const lifecycleGrounded = lifecycleConcepts.every((term) => matchedQueryTerms.has(term))
    const divergenceGrounded = !obligation.terms.includes(DIVERGENCE_CONCEPT)
      || matchedQueryTerms.has(DIVERGENCE_CONCEPT)
      || scopedSubjectMatches >= 2
    if (matchedTerms >= requiredMatches && lifecycleGrounded && divergenceGrounded) {
      obligationMatches.set(obligation.index, matchedTerms)
    }
  }
  score += Math.max(0, sources.size - 1) * 0.35
  score += Math.max(0, matchedQueryTerms.size - 1) * 0.5
  score += symbolQueryTerms.size * 0.75
  score += obligationMatches.size * 0.75
  score += Math.min(4, Math.log2(node.structuralDegree + 1)) * 0.75
  score += runtimeAnchorAdjustment(node, question)
  return {
    id: node.id,
    label: node.label,
    sourceFile: node.sourceFile,
    score,
    matchedQueryTerms,
    specificQueryTerms,
    symbolQueryTerms,
    pathQueryTerms,
    sources,
    obligationMatches,
    structuralDegree: node.structuralDegree,
    presentationShaped: presentationShapedNode(node),
    transitionOwner: tokenize(node.label).some((term) => transitionTerm(term) || changeLifecycleTerm(term)),
    persistenceShaped: PERSISTENCE_PATH_PATTERN.test(node.sourceFile),
    lowValueOwner: LOW_VALUE_OWNER_PATH_PATTERN.test(node.sourceFile)
      || LOW_VALUE_OWNER_LABEL_PATTERN.test(node.label),
    behaviorOwner: CORE_BEHAVIOR_OWNER_PATH_PATTERN.test(node.sourceFile),
    fileOwner: fileOwnerNode(node),
    publicBoundaryOwner: publicBoundaryOwnerNode(node),
    runtimeScope: runtimeScopeForSource(node.sourceFile),
  }
}

/**
 * Removes same-vocabulary computations whose repository scope is weaker than
 * the best candidates for an explicit divergence request. Explicit symbol or
 * path anchors can still override this at the retrieval boundary.
 */
export function underScopedDivergenceNodeIds(
  graph: KnowledgeGraph,
  question: string,
): ReadonlySet<string> {
  const obligations = queryEvidenceObligations(question)
  const divergenceObligations = obligations.filter((obligation) => obligation.terms.includes(DIVERGENCE_CONCEPT))
  if (divergenceObligations.length === 0) {
    return new Set()
  }
  const terms = queryTerms(obligations)
  const index = buildVocabularyIndex(graph)
  const inverseFrequencyByTerm = new Map(
    terms.map((term) => [term, inverseFrequency(index, term)] as const),
  )
  const anchors = index.nodes.filter((node) => flowQueryEvidenceCandidateAllowed(question, node)).flatMap((node) => {
    const anchor = anchorForNode(node, terms, inverseFrequencyByTerm, obligations, question)
    return anchor ? [anchor] : []
  })
  const excluded = new Set<string>()
  for (const obligation of divergenceObligations) {
    const previous = obligations.find((candidate) => candidate.index === obligation.index - 1)
    const previousTerms = divergenceScopeTerms(previous)
    const scopeMatches = (anchor: AnchorCandidate): number => (
      previousTerms.filter((term) => anchor.matchedQueryTerms.has(term)).length
    )
    const candidates = anchors.filter((anchor) => (
      anchor.matchedQueryTerms.has(COMPUTATION_CONCEPT)
      && (
        anchor.obligationMatches.has(obligation.index)
        || (previous !== undefined && anchor.obligationMatches.has(previous.index))
      )
    ))
    const strongestScope = candidates.reduce(
      (maximum, anchor) => Math.max(maximum, scopeMatches(anchor)),
      0,
    )
    if (strongestScope < 2) {
      continue
    }
    for (const anchor of candidates) {
      if (scopeMatches(anchor) < 2) {
        excluded.add(anchor.id)
      }
    }
  }
  return excluded
}

function diversifyAnchors(
  graph: KnowledgeGraph,
  ranked: readonly AnchorCandidate[],
  obligations: readonly QueryEvidenceObligation[],
  preferRuntime: boolean,
): {
  anchors: AnchorCandidate[]
  preferredByObligation: Map<number, string>
  reservedByObligation: Set<string>
} {
  const selected: AnchorCandidate[] = []
  const selectedIds = new Set<string>()
  const countBySourceFile = new Map<string, number>()
  const preferredByObligation = new Map<number, string>()
  const reservedByObligation = new Set<string>()
  const hasSymbolGroundedAnchors = ranked.some((anchor) => anchor.symbolQueryTerms.size > 0)

  const obligationSymbolMatchCount = (anchor: AnchorCandidate, obligation: QueryEvidenceObligation): number => (
    obligation.terms.filter((term) => anchor.symbolQueryTerms.has(term)).length
  )
  const obligationSpecificMatchCount = (anchor: AnchorCandidate, obligation: QueryEvidenceObligation): number => (
    obligation.terms.filter((term) => anchor.specificQueryTerms.has(term)).length
  )
  const divergenceScopeMatchCount = (anchor: AnchorCandidate, obligation: QueryEvidenceObligation): number => {
    if (!obligation.terms.includes(DIVERGENCE_CONCEPT)) {
      return 0
    }
    const previousTerms = divergenceScopeTerms(
      obligations.find((candidate) => candidate.index === obligation.index - 1),
    )
    return previousTerms.filter((term) => anchor.matchedQueryTerms.has(term)).length
  }
  const crossObligationContextMatchCount = (
    anchor: AnchorCandidate,
    obligation: QueryEvidenceObligation,
  ): number => new Set(
    obligations
      .filter((candidate) => candidate.index !== obligation.index)
      .flatMap((candidate) => candidate.terms)
      .filter((term) => !term.startsWith('@') && anchor.matchedQueryTerms.has(term)),
  ).size

  const baseObligationOrder = (obligation: QueryEvidenceObligation) => (
    (left: AnchorCandidate, right: AnchorCandidate): number => (
      (obligation.terms.includes(DIVERGENCE_CONCEPT)
        ? divergenceScopeMatchCount(right, obligation) - divergenceScopeMatchCount(left, obligation)
        : 0)
      || (obligation.terms.includes(TRANSITION_CONCEPT)
        ? Number(right.transitionOwner) - Number(left.transitionOwner)
        : 0)
      || (obligation.terms.includes('public') && obligation.terms.includes('page')
        ? Number(right.fileOwner) - Number(left.fileOwner)
        : 0)
      || obligationSymbolMatchCount(right, obligation) - obligationSymbolMatchCount(left, obligation)
      || (right.obligationMatches.get(obligation.index) ?? 0) - (left.obligationMatches.get(obligation.index) ?? 0)
      || obligationSpecificMatchCount(right, obligation) - obligationSpecificMatchCount(left, obligation)
      || crossObligationContextMatchCount(right, obligation) - crossObligationContextMatchCount(left, obligation)
      || right.structuralDegree - left.structuralDegree
      || right.score - left.score
      || left.id.localeCompare(right.id)
    )
  )
  const candidatesByObligation = new Map<number, AnchorCandidate[]>()
  const underScopedDivergenceAnchors = new Set<string>()
  for (const divergenceObligation of obligations.filter((obligation) => obligation.terms.includes(DIVERGENCE_CONCEPT))) {
    const previous = obligations.find((candidate) => candidate.index === divergenceObligation.index - 1)
    const scopedCandidates = ranked.filter((anchor) => (
      anchor.matchedQueryTerms.has(COMPUTATION_CONCEPT)
      && (
        anchor.obligationMatches.has(divergenceObligation.index)
        || (previous !== undefined && anchor.obligationMatches.has(previous.index))
      )
    ))
    const strongestScope = scopedCandidates.reduce(
      (maximum, anchor) => Math.max(maximum, divergenceScopeMatchCount(anchor, divergenceObligation)),
      0,
    )
    if (strongestScope >= 2) {
      for (const anchor of scopedCandidates) {
        if (divergenceScopeMatchCount(anchor, divergenceObligation) < 2) {
          underScopedDivergenceAnchors.add(anchor.id)
        }
      }
    }
  }
  for (const obligation of obligations) {
    const candidates = ranked
      .filter((anchor) => (
        anchor.obligationMatches.has(obligation.index)
        && !underScopedDivergenceAnchors.has(anchor.id)
      ))
      .sort(baseObligationOrder(obligation))
    const runtimeCandidates = preferRuntime && candidates.some((anchor) => !anchor.presentationShaped)
      ? candidates.filter((anchor) => !anchor.presentationShaped)
      : candidates
    const structurallyGrounded = runtimeCandidates.some((anchor) => anchor.structuralDegree > 0)
      ? runtimeCandidates.filter((anchor) => anchor.structuralDegree > 0)
      : runtimeCandidates
    const ownerCandidates = structurallyGrounded.some((anchor) => !anchor.lowValueOwner)
      ? structurallyGrounded.filter((anchor) => !anchor.lowValueOwner)
      : structurallyGrounded
    const behaviorOwners = ownerCandidates.some((anchor) => anchor.behaviorOwner)
      ? ownerCandidates.filter((anchor) => anchor.behaviorOwner)
      : ownerCandidates
    const strongestScopedOwners = obligation.terms.includes(DIVERGENCE_CONCEPT)
      ? (() => {
          const strongestScope = behaviorOwners.reduce(
            (maximum, anchor) => Math.max(maximum, divergenceScopeMatchCount(anchor, obligation)),
            0,
          )
          const minimumScopedMatch = strongestScope >= 2 ? 2 : strongestScope
          return strongestScope > 0
            ? behaviorOwners.filter((anchor) => {
                const scoped = divergenceScopeMatchCount(anchor, obligation) >= minimumScopedMatch
                if (!scoped) underScopedDivergenceAnchors.add(anchor.id)
                return scoped
              })
            : behaviorOwners
        })()
      : behaviorOwners
    candidatesByObligation.set(
      obligation.index,
      strongestScopedOwners.slice(0, MAX_OBLIGATION_CONNECTIVITY_CANDIDATES),
    )
  }
  const pathCache = new Map<string, boolean>()
  const anchorsConnect = (left: AnchorCandidate, right: AnchorCandidate): boolean => {
    if (left.id === right.id) {
      return false
    }
    const key = [left.id, right.id].sort().join('\u0000')
    const cached = pathCache.get(key)
    if (cached !== undefined) {
      return cached
    }
    const connected = shortestIncidentPath(graph, left.id, right.id) !== null
    pathCache.set(key, connected)
    return connected
  }
  const connectedObligations = (candidate: AnchorCandidate): Set<number> => {
    const connected = new Set<number>()
    for (const obligation of obligations) {
      if (candidate.obligationMatches.has(obligation.index)) {
        continue
      }
      if ((candidatesByObligation.get(obligation.index) ?? []).some((other) => anchorsConnect(candidate, other))) {
        connected.add(obligation.index)
      }
    }
    return connected
  }

  const add = (anchor: AnchorCandidate): void => {
    const sourceKey = anchor.sourceFile || anchor.id
    selectedIds.add(anchor.id)
    countBySourceFile.set(sourceKey, (countBySourceFile.get(sourceKey) ?? 0) + 1)
    selected.push(anchor)
  }

  // Reserve one strong, source-diverse anchor for each prompt obligation
  // before globally ranked vocabulary can consume the bounded seed pool.
  for (const obligation of obligations) {
    const candidates = [...(candidatesByObligation.get(obligation.index) ?? [])]
      .sort((left, right) => {
        const scopedDivergenceOrder = obligation.terms.includes(DIVERGENCE_CONCEPT)
          ? divergenceScopeMatchCount(right, obligation) - divergenceScopeMatchCount(left, obligation)
          : 0
        if (scopedDivergenceOrder !== 0) {
          return scopedDivergenceOrder
        }
        const transitionOwnerOrder = obligation.terms.includes(TRANSITION_CONCEPT)
          ? Number(right.transitionOwner) - Number(left.transitionOwner)
          : 0
        if (transitionOwnerOrder !== 0) {
          return transitionOwnerOrder
        }
        const behaviorOrder = Number(right.behaviorOwner) - Number(left.behaviorOwner)
        if (behaviorOrder !== 0) {
          return behaviorOrder
        }
        const publicFileOwnerOrder = obligation.terms.includes('public') && obligation.terms.includes('page')
          ? Number(right.fileOwner) - Number(left.fileOwner)
          : 0
        if (publicFileOwnerOrder !== 0) {
          return publicFileOwnerOrder
        }
        const publicOwnerGrounding = obligation.terms.includes('public') && obligation.terms.includes('page')
          ? obligationSymbolMatchCount(right, obligation) - obligationSymbolMatchCount(left, obligation)
            || obligationSpecificMatchCount(right, obligation) - obligationSpecificMatchCount(left, obligation)
          : 0
        if (publicOwnerGrounding !== 0) {
          return publicOwnerGrounding
        }
        const workflowContextOrder = crossObligationContextMatchCount(right, obligation)
          - crossObligationContextMatchCount(left, obligation)
        if (workflowContextOrder !== 0) {
          return workflowContextOrder
        }
        const leftConnections = connectedObligations(left)
        const rightConnections = connectedObligations(right)
        const leftAdjacent = Number(leftConnections.has(obligation.index - 1))
          + Number(leftConnections.has(obligation.index + 1))
        const rightAdjacent = Number(rightConnections.has(obligation.index - 1))
          + Number(rightConnections.has(obligation.index + 1))
        return rightAdjacent - leftAdjacent
          || rightConnections.size - leftConnections.size
          || Number(!selectedIds.has(right.id)) - Number(!selectedIds.has(left.id))
          || Number(!countBySourceFile.has(right.sourceFile || right.id))
            - Number(!countBySourceFile.has(left.sourceFile || left.id))
          || baseObligationOrder(obligation)(left, right)
      })
    const candidate = candidates[0]
    if (candidate) {
      if (!selectedIds.has(candidate.id)) {
        add(candidate)
      }
      preferredByObligation.set(obligation.index, candidate.id)
      reservedByObligation.add(candidate.id)
    }
  }

  // A public status computation is incomplete without the HTTP boundary that
  // fetches and serializes it. Reserve that owner separately from the status
  // implementation so runtime provenance is explicit rather than inferred
  // from a shared output type.
  for (const obligation of obligations.filter((candidate) => (
    candidate.terms.includes('public') && candidate.terms.includes('page')
  ))) {
    const publicTerms = obligation.terms.filter((term) => !term.startsWith('@'))
    const boundary = ranked
      .filter((anchor) => (
        anchor.publicBoundaryOwner
        && publicTerms.filter((term) => anchor.matchedQueryTerms.has(term)).length >= 2
        && !anchor.lowValueOwner
      ))
      .sort((left, right) => (
        Number(/\(\)$/.test(right.label)) - Number(/\(\)$/.test(left.label))
        || obligationSymbolMatchCount(right, obligation) - obligationSymbolMatchCount(left, obligation)
        || obligationSpecificMatchCount(right, obligation) - obligationSpecificMatchCount(left, obligation)
        || right.structuralDegree - left.structuralDegree
        || right.score - left.score
        || left.id.localeCompare(right.id)
      ))[0]
    if (boundary) {
      if (!selectedIds.has(boundary.id)) add(boundary)
      reservedByObligation.add(boundary.id)
    }
  }

  // A divergence request requires at least two distinct implementations to
  // compare. Reserve a second scoped computation owner instead of hoping it
  // survives the global top-k.
  for (const obligation of obligations.filter((candidate) => candidate.terms.includes(DIVERGENCE_CONCEPT))) {
    const primaryId = preferredByObligation.get(obligation.index)
    const primarySource = primaryId ? ranked.find((anchor) => anchor.id === primaryId)?.sourceFile : undefined
    const candidates = [...(candidatesByObligation.get(obligation.index) ?? [])]
      .filter((anchor) => anchor.id !== primaryId && anchor.sourceFile !== primarySource && !anchor.lowValueOwner)
      .sort((left, right) => (
        obligationSymbolMatchCount(right, obligation) - obligationSymbolMatchCount(left, obligation)
        || divergenceScopeMatchCount(right, obligation) - divergenceScopeMatchCount(left, obligation)
        || right.structuralDegree - left.structuralDegree
        || right.score - left.score
        || left.id.localeCompare(right.id)
      ))
    const secondary = candidates[0]
    if (secondary) {
      if (!selectedIds.has(secondary.id)) add(secondary)
      reservedByObligation.add(secondary.id)
    }
  }

  // A transition into a named entity is incomplete without shared state when
  // the graph contains a schema/repository owner for that entity.
  for (const obligation of obligations.filter((candidate) => candidate.terms.includes(TRANSITION_CONCEPT))) {
    const entityTerms = obligation.terms.filter((term) => !term.startsWith('@'))
    const unmatchedEntityQualifiers = (anchor: AnchorCandidate): number => {
      const basenameTerms = tokenize(anchor.sourceFile.split('/').at(-1) ?? '')
        .filter((term) => !VOCABULARY_NOISE.has(term))
      return basenameTerms.filter((term) => !entityTerms.some((entity) => queryEvidenceTermsMatch(entity, term))).length
    }
    const stateOwner = ranked
      .filter((anchor) => (
        anchor.persistenceShaped
        && entityTerms.some((term) => anchor.matchedQueryTerms.has(term))
        && !anchor.lowValueOwner
      ))
      .sort((left, right) => (
        right.symbolQueryTerms.size - left.symbolQueryTerms.size
        || unmatchedEntityQualifiers(left) - unmatchedEntityQualifiers(right)
        || right.structuralDegree - left.structuralDegree
        || right.score - left.score
        || left.id.localeCompare(right.id)
      ))[0]
    if (stateOwner) {
      if (!selectedIds.has(stateOwner.id)) add(stateOwner)
      reservedByObligation.add(stateOwner.id)
    }
  }

  // Cross-language transports are often not linked statically. Keep one
  // lifecycle-shaped owner from a second runtime scope for the first stage so
  // the pack can expose that boundary and state the remaining uncertainty.
  const firstObligation = obligations[0]
  const firstPrimaryId = firstObligation ? preferredByObligation.get(firstObligation.index) : undefined
  const firstPrimaryScope = firstPrimaryId ? ranked.find((anchor) => anchor.id === firstPrimaryId)?.runtimeScope : undefined
  const firstPrimaryLanguage = firstPrimaryId
    ? runtimeLanguageForSource(ranked.find((anchor) => anchor.id === firstPrimaryId)?.sourceFile ?? '')
    : undefined
  if (firstObligation) {
    const headTerm = firstObligation.terms.at(-1)
    const outcomeLabel = (anchor: AnchorCandidate): boolean => (
      tokenize(anchor.label).some((term) => FLOW_OUTCOME_TERMS.has(term))
    )
    const boundaryOwner = ranked
      .filter((anchor) => (
        anchor.id !== firstPrimaryId
        && anchor.runtimeScope !== firstPrimaryScope
        && anchor.transitionOwner
        && !anchor.lowValueOwner
        && (anchor.symbolQueryTerms.size > 0 || anchor.pathQueryTerms.size > 0)
        && firstObligation.terms.some((term) => anchor.matchedQueryTerms.has(term))
      ))
      .sort((left, right) => (
        Number(
          firstPrimaryLanguage !== undefined
          && runtimeLanguageForSource(right.sourceFile) !== firstPrimaryLanguage,
        ) - Number(
          firstPrimaryLanguage !== undefined
          && runtimeLanguageForSource(left.sourceFile) !== firstPrimaryLanguage,
        )
        || Number(outcomeLabel(right)) - Number(outcomeLabel(left))
        || Number(headTerm !== undefined && right.pathQueryTerms.has(headTerm))
          - Number(headTerm !== undefined && left.pathQueryTerms.has(headTerm))
        || firstObligation.terms.filter((term) => right.matchedQueryTerms.has(term)).length
          - firstObligation.terms.filter((term) => left.matchedQueryTerms.has(term)).length
        || right.structuralDegree - left.structuralDegree
        || right.score - left.score
        || left.id.localeCompare(right.id)
      ))[0]
    if (boundaryOwner) {
      if (!selectedIds.has(boundaryOwner.id)) add(boundaryOwner)
      reservedByObligation.add(boundaryOwner.id)

      const rankedById = new Map(ranked.map((anchor) => [anchor.id, anchor]))
      const boundaryCaller = graph.predecessors(boundaryOwner.id)
        .flatMap((nodeId) => {
          const anchor = rankedById.get(nodeId)
          if (!anchor) return []
          const relation = String(graph.edgeAttributes(nodeId, boundaryOwner.id).relation ?? '')
          return /^(?:calls|dispatches|emits|enqueues|invokes|publishes|triggers)$/.test(relation)
            ? [anchor]
            : []
        })
        .filter((anchor) => (
          anchor.sourceFile !== boundaryOwner.sourceFile
          && anchor.behaviorOwner
          && !anchor.lowValueOwner
          && firstObligation.terms.some((term) => anchor.matchedQueryTerms.has(term))
        ))
        .sort((left, right) => (
          Number(right.obligationMatches.has(firstObligation.index))
            - Number(left.obligationMatches.has(firstObligation.index))
          || firstObligation.terms.filter((term) => right.symbolQueryTerms.has(term)).length
            - firstObligation.terms.filter((term) => left.symbolQueryTerms.has(term)).length
          || firstObligation.terms.filter((term) => right.matchedQueryTerms.has(term)).length
            - firstObligation.terms.filter((term) => left.matchedQueryTerms.has(term)).length
          || right.structuralDegree - left.structuralDegree
          || right.score - left.score
          || left.id.localeCompare(right.id)
        ))[0]
      if (boundaryCaller) {
        if (!selectedIds.has(boundaryCaller.id)) add(boundaryCaller)
        if (firstPrimaryId && preferredByObligation.get(firstObligation.index) === firstPrimaryId) {
          reservedByObligation.delete(firstPrimaryId)
        }
        preferredByObligation.set(firstObligation.index, boundaryCaller.id)
        reservedByObligation.add(boundaryCaller.id)
      }
    }
  }

  for (const anchor of ranked) {
    if (selectedIds.has(anchor.id)) {
      continue
    }
    if (underScopedDivergenceAnchors.has(anchor.id)) {
      continue
    }
    const sourceKey = anchor.sourceFile || anchor.id
    if (countBySourceFile.has(sourceKey)) {
      continue
    }
    if (preferRuntime && anchor.presentationShaped) {
      continue
    }
    if (hasSymbolGroundedAnchors && anchor.symbolQueryTerms.size === 0) {
      continue
    }
    add(anchor)
    if (selected.length >= MAX_PRIMARY_SOURCE_ANCHORS) {
      break
    }
  }

  for (const anchor of ranked) {
    if (selectedIds.has(anchor.id)) {
      continue
    }
    if (underScopedDivergenceAnchors.has(anchor.id)) {
      continue
    }
    const sourceKey = anchor.sourceFile || anchor.id
    const sourceCount = countBySourceFile.get(sourceKey) ?? 0
    if (sourceCount === 0 || sourceCount >= MAX_ANCHORS_PER_SOURCE_FILE) {
      continue
    }
    if (preferRuntime && anchor.presentationShaped) {
      continue
    }
    if (hasSymbolGroundedAnchors && anchor.symbolQueryTerms.size === 0) {
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
  return { anchors: selected, preferredByObligation, reservedByObligation }
}

function eligibleVocabularyNodes(index: RepositoryVocabularyIndex, input: ConceptualFallbackInput): VocabularyNode[] {
  const normalizedFileType = input.fileType?.trim().toLowerCase()
  const allowsNonProduction = /\b(?:benchmarks?|fixtures?|specs?|tests?|testing)\b/i.test(input.question)
  return index.nodes.filter((node) => (
    (input.community === undefined || node.community === input.community)
    && (normalizedFileType === undefined || node.fileType === normalizedFileType)
    && flowQueryEvidenceCandidateAllowed(input.question, node)
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

function proposalIsGrounded(
  anchors: readonly AnchorCandidate[],
  obligations: readonly QueryEvidenceObligation[],
): boolean {
  const coveredTerms = new Set(anchors.flatMap((anchor) => [...anchor.matchedQueryTerms]))
  const coveredObligations = new Set(anchors.flatMap((anchor) => [...anchor.obligationMatches.keys()]))
  const strongest = anchors[0]
  return coveredTerms.size >= 2
    && coveredObligations.size >= Math.min(2, obligations.length)
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
  const obligations = queryEvidenceObligations(input.question)
  const terms = queryTerms(obligations)
  const initialReasons = fallbackReasons(input.initialQuality)
  if (terms.length === 0) {
    const basePlan: ContextPackRetrievalPlanDetail = {
      version: 1,
      status: initialReasons.length > 0 ? 'no_candidates' : 'not_needed',
      reasons: initialReasons,
      initial: input.initialQuality,
      final: input.initialQuality,
      attempts: initialReasons.length > 0 ? [emptyAttempt(initialReasons)] : [],
    }
    return {
      plan: basePlan,
      nodeBoosts: new Map(),
    }
  }

  const index = buildVocabularyIndex(graph)
  const inverseFrequencyByTerm = new Map(
    terms.map((term) => [term, inverseFrequency(index, term)] as const),
  )
  const rankedAnchors = eligibleVocabularyNodes(index, input)
    .flatMap((node) => {
      const anchor = anchorForNode(node, terms, inverseFrequencyByTerm, obligations, input.question)
      return anchor ? [anchor] : []
    })
    .sort((left, right) => (
      right.obligationMatches.size - left.obligationMatches.size
      || Number(right.structuralDegree > 0) - Number(left.structuralDegree > 0)
      || right.matchedQueryTerms.size - left.matchedQueryTerms.size
      || right.symbolQueryTerms.size - left.symbolQueryTerms.size
      || right.specificQueryTerms.size - left.specificQueryTerms.size
      || right.sources.size - left.sources.size
      || right.score - left.score
      || left.id.localeCompare(right.id)
    ))
  const diversified = diversifyAnchors(
    graph,
    rankedAnchors,
    obligations,
    !PRESENTATION_QUERY_PATTERN.test(input.question),
  )
  const anchors = diversified.anchors
  const selectedIds = new Set(input.selectedNodes.map((node) => node.nodeId))
  const rankedAnchorsById = new Map(rankedAnchors.map((anchor) => [anchor.id, anchor]))
  const obligationMatches = new Map(rankedAnchors.map((anchor) => [
    anchor.id,
    new Set(anchor.obligationMatches.keys()),
  ]))
  const initialObligationCoverage = new Set(
    [...selectedIds].flatMap((nodeId) => [...(obligationMatches.get(nodeId) ?? [])]),
  ).size
  const obligationRecoveryNeeded = diversified.preferredByObligation.size >= 2
    && initialObligationCoverage < diversified.preferredByObligation.size
  const reasons: RetrievalFallbackReason[] = [
    ...initialReasons,
    ...(obligationRecoveryNeeded ? ['missing_query_obligations' as const] : []),
  ]
  const basePlan: ContextPackRetrievalPlanDetail = {
    version: 1,
    status: 'not_needed',
    reasons,
    initial: input.initialQuality,
    final: input.initialQuality,
    attempts: [],
    ...(diversified.preferredByObligation.size >= 2
      ? {
          query_obligations: {
            total: diversified.preferredByObligation.size,
            initially_covered: initialObligationCoverage,
            finally_covered: initialObligationCoverage,
          },
        }
      : {}),
  }
  if (reasons.length === 0 || (input.initialQuality.explicit_anchors > 0 && !obligationRecoveryNeeded)) {
    return {
      plan: input.initialQuality.explicit_anchors > 0 ? { ...basePlan, reasons: [] } : basePlan,
      nodeBoosts: new Map(),
    }
  }

  if (!proposalIsGrounded(anchors, obligations)) {
    return {
      plan: { ...basePlan, status: 'no_candidates', attempts: [emptyAttempt(reasons)] },
      nodeBoosts: new Map(),
    }
  }

  const boosts = new Map<string, number>()
  const bridgeParticipation = new Map<string, number>()
  const connectedAnchorIds = new Set<string>()
  const contributingSources = new Set<RepositoryVocabularySource>()
  for (const anchor of rankedAnchors) {
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
    const distinctObligationsA = new Set([...leftA.obligationMatches.keys(), ...rightA.obligationMatches.keys()]).size
    const distinctObligationsB = new Set([...leftB.obligationMatches.keys(), ...rightB.obligationMatches.keys()]).size
    const distinctEvidenceA = new Set([...leftA.matchedQueryTerms, ...rightA.matchedQueryTerms]).size
    const distinctEvidenceB = new Set([...leftB.matchedQueryTerms, ...rightB.matchedQueryTerms]).size
    return distinctObligationsB - distinctObligationsA
      || distinctEvidenceB - distinctEvidenceA
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
  const preferredObligationAnchorIds = new Set(diversified.reservedByObligation)
  for (const anchor of anchors) {
    const multipleConceptBonus = Math.max(0, anchor.matchedQueryTerms.size - 1) * 1.25
    const obligationBonus = anchor.obligationMatches.size * 1.25
    const anchorCap = anchor.matchedQueryTerms.size >= 2 ? 7 : 4
    const groundedBoost = Math.min(anchorCap, 0.6 + (anchor.score * 0.45) + multipleConceptBonus + obligationBonus)
    if (!coherentAlternativeFound || connectedAnchorIds.has(anchor.id) || preferredObligationAnchorIds.has(anchor.id)) {
      boosts.set(anchor.id, groundedBoost)
    } else if (!selectedIds.has(anchor.id)) {
      if (anchor.structuralDegree > 0 && anchor.matchedQueryTerms.size >= 2 && anchor.specificQueryTerms.size >= 2) {
        boosts.set(anchor.id, Math.min(6.5, groundedBoost))
      }
    }
  }

  for (const [nodeId, participation] of bridgeParticipation) {
    boosts.set(nodeId, (boosts.get(nodeId) ?? 0) + Math.min(3, 0.8 + (participation * 0.55)))
  }

  // One anchor per prompt stage is a hard recovery reservation. Without this,
  // a dense single-layer cluster can still consume every selected slot after
  // the proposal correctly found disconnected cross-service stages.
  for (const nodeId of preferredObligationAnchorIds) {
    boosts.set(nodeId, Math.max(boosts.get(nodeId) ?? 0, CONCEPTUAL_WORKFLOW_RESERVATION_BOOST))
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
    const anchorsById = new Map(anchors.map((anchor) => [anchor.id, anchor]))
    for (const nodeId of selectedIds) {
      const obligationGrounded = (anchorsById.get(nodeId)?.obligationMatches.size ?? 0) > 0
      if (!obligationGrounded && !connectedAnchorIds.has(nodeId) && !bridgeParticipation.has(nodeId) && !boosts.has(nodeId)) {
        boosts.set(nodeId, -1.5)
      }
    }
  }

  // Recovery should add missing obligations without discarding already useful
  // evidence. Keep grounded original selections in the conceptual seed pool;
  // explicit incoherent selections demoted above remain negative.
  for (const nodeId of selectedIds) {
    const currentBoost = boosts.get(nodeId)
    const originalAnchor = rankedAnchorsById.get(nodeId)
    const groundedOriginal = originalAnchor !== undefined
      && (originalAnchor.symbolQueryTerms.size > 0 || connectedAnchorIds.has(nodeId))
    if (groundedOriginal && (currentBoost === undefined || currentBoost >= 0)) {
      boosts.set(nodeId, Math.max(currentBoost ?? 0, ORIGINAL_SELECTION_RETENTION_BOOST))
    }
  }

  const orderedPositiveAdjustments = [...boosts]
    .filter(([nodeId, boost]) => index.byId.has(nodeId) && boost > 0)
    .sort((left, right) => (
      right[1] - left[1]
      || Number(!selectedIds.has(right[0])) - Number(!selectedIds.has(left[0]))
      || left[0].localeCompare(right[0])
    ))
  const reservedAnchorIds = new Set(diversified.reservedByObligation)
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
    promoted_communities: [...new Set(promoted.flatMap(([nodeId]) => {
      const community = index.byId.get(nodeId)?.community
      return community === null || community === undefined ? [] : [community]
    }))].sort((left, right) => left - right),
    changed_result: false,
    added_selected_files: 0,
    removed_selected_files: 0,
  }
  return {
    plan: { ...basePlan, status: 'kept_initial', attempts: [attempt] },
    nodeBoosts: boundedBoosts,
    obligationMatches,
    obligationCount: obligations.length,
    preferredObligationAnchors: diversified.preferredByObligation,
    initialObligationCoverage,
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
  recoveredNodeIds: ReadonlySet<string> = new Set(),
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
  const recoveredObligationCoverage = new Set(
    [...recoveredNodeIds].flatMap((nodeId) => [...(proposal.obligationMatches?.get(nodeId) ?? [])]),
  ).size
  const obligationCoverageImproved = recoveredObligationCoverage > (proposal.initialObligationCoverage ?? 0)
  const recoveryGoalMet = recoveredEmptyResult
    || (proposal.plan.reasons.includes('missing_required_evidence') && requiredEvidenceImproved)
    || (proposal.plan.reasons.includes('missing_semantic_evidence') && semanticEvidenceImproved)
    || (proposal.plan.reasons.includes('low_workflow_coherence') && coherenceImproved)
    || (proposal.plan.reasons.includes('weak_anchors') && weakAnchorImproved)
    || obligationCoverageImproved
  const obligationAdjustedQuality = qualityValue(recoveredQuality)
    // Cross-service and cross-language stages are often disconnected in a
    // static graph. Covering a previously missing prompt obligation must be
    // allowed to outweigh the resulting drop in local cluster coherence.
    + Math.max(0, recoveredObligationCoverage - (proposal.initialObligationCoverage ?? 0)) * 1.5
  const obligationAwareNonRegression = obligationAdjustedQuality >= qualityValue(proposal.plan.initial) - 0.05
  const useRecovered = resultChanged
    && recoveryGoalMet
    && (nonRegressingQuality || obligationAwareNonRegression)

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
      ...(proposal.plan.query_obligations
        ? {
            query_obligations: {
              ...proposal.plan.query_obligations,
              finally_covered: useRecovered
                ? recoveredObligationCoverage
                : proposal.plan.query_obligations.initially_covered,
            },
          }
        : {}),
      ...(useRecovered ? { selected_fallback: finalAttempt.fallback } : {}),
    },
  }
}
