import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import type {
  ContextPackExecutionSlice,
  ContextPackRuntimeGenerationAnswerContract,
  ContextPackWorkflowCenter,
  ImplementationPackFileHint,
  ImplementationPackGuidance,
  ImplementationPackPhase,
  ImplementationPackRetrievalPipeline,
  ImplementationPackRiskBoundary,
  ImplementationPackSurfaceHint,
} from '../contracts/context-pack.js'
import type { KnowledgeGraph } from '../contracts/graph.js'
import type { TaskIntentKind } from '../contracts/task-intent.js'
import { shellEscapeIfNeeded } from '../shared/shell.js'
import { classifySourceDomain } from '../shared/source-discovery.js'
import { lineNumberFromSourceLocation } from '../shared/source-location.js'
import { relativizeSourceFile } from '../shared/source-path.js'
import { riskMap } from './risk-map.js'
import type { RetrieveMatchedNode, RetrieveResult } from './retrieve.js'

const CONTRACT_PATH_PATTERN = /(?:^|\/)(?:contracts?|schemas?|dto|types?|interfaces?|openapi|graphql)(?:\/|$)|(?:^|\/)[^/]*\.d\.ts$/i
const CONTRACT_NODE_KINDS = new Set(['interface', 'type', 'type_alias', 'typealias', 'enum', 'schema', 'contract'])
const PUBLIC_SURFACE_NODE_KINDS = new Set(['route', 'router', 'controller', 'page', 'layout', 'middleware'])
const PUBLIC_SURFACE_PATH_PATTERN = /(?:^|\/)(?:cli|stdio)(?:\/|$)|(?:^|\/)(?:http-server|definitions)\.ts$|(?:^|\/)(?:routes?|controllers?|interface\/http)(?:\/|$)/i
const WORKFLOW_OWNER_PATTERN = /(?:service|controller|handler|worker|queue|job|workflow|orchestrator|planner|command|route|router|processor|consumer|producer|pipeline)/i
const HELPER_PATTERN = /(?:helper|util|format|formatter|presenter|serializer|mapper|constant|type|schema|dto)/i
const SIDE_EFFECT_PATTERN = /(?:save|create|update|delete|persist|write|enqueue|publish|dispatch|emit|send|store|cache|repository|queue|session|database|db)/i
const RUNTIME_BOUNDARY_PATTERN = /(?:service|repository|repo|server(?:\s+action)?|actions?|worker|queue|job|processor|consumer|producer|persist|storage|database|db|prisma|session|cache)/i
const CLIENT_SURFACE_PATTERN = /(?:client|component|view|presentational)/i
const SHELL_SURFACE_PATH_PATTERN = /(?:^|\/)(?:app|main|root)\.[^/]+$|(?:^|\/)page\.[^/]+$|(?:^|\/)layout\.[^/]+$/i
const WORKFLOW_OWNER_FOCUS_PATTERN = /(?:prisma|repository|persist|storage|database|db|server(?:\s+action)?|runtime\s+boundary|before\s+calling|keep\s+the\s+client\s+component\s+presentational)/i
const EXPLICIT_CLIENT_TARGET_PATTERN = /(?:client(?:\s+component)?|presentational|ui|component)/i
const WORKFLOW_EDGE_RELATIONS = new Set(['calls', 'controller_route', 'depends_on', 'imports_from', 'enqueues_job'])
const SURFACE_ATTACHMENT_RELATIONS = new Set(['calls', 'controller_route', 'depends_on', 'imports_from'])
const TEST_EDIT_PATTERN = /\b(?:add|update|modify|change|fix|write|edit|refactor|rename|remove)\b.{0,24}\b(?:test|tests|spec|specs|e2e|integration)\b|\b(?:test|tests|spec|specs|e2e|integration)\b.{0,24}\b(?:add|update|modify|change|fix|write|edit|refactor|rename|remove)\b/i
const E2E_TEST_PATTERN = /(?:^|\/)(?:e2e|integration)(?:\/|$)|\.(?:e2e|integration)\.[^/]+$/i
const GENERIC_MODULE_TOKENS = new Set([
  'src', 'test', 'tests', 'unit', 'spec', 'specs', 'e2e', 'integration',
  'app', 'apps', 'lib', 'libs', 'packages', 'package', 'modules', 'module',
  'feature', 'features', 'http', 'api',
])
const IMPLEMENTATION_PIPELINE_PHASE_ORDER: ImplementationPackPhase[] = [
  'seed',
  'expand',
  'promote',
  'attach',
  'refine',
  'render',
]

type PackageScripts = Record<string, string>

interface BuildImplementationPackOptions {
  budget: number
  taskIntent: TaskIntentKind
  limit?: number
}

interface FileAggregate {
  path: string
  score: number
  direct_symbols: string[]
  related_symbols: string[]
}

interface RankedFileAccumulator {
  path: string
  score: number
  matched_symbols: string[]
  matchedSymbolSet: Set<string>
  reasons: string[]
  reasonSet: Set<string>
  phases: ImplementationPackPhase[]
  phaseSet: Set<ImplementationPackPhase>
}

interface IndexedTestFile {
  path: string
  labels: string[]
  labelSet: Set<string>
  name_tokens: string[]
  module_tokens: string[]
  entry_surface_like: boolean
}

interface WorkflowNodeCandidate {
  node_id: string
  label: string
  source_file: string
  node_kind?: string
  framework_role?: string
  match_score: number
  relevance_band: 'direct' | 'related'
  phases: ImplementationPackPhase[]
  phase_reasons: string[]
}

interface WorkflowScoreDetails {
  score: number
  reasons: string[]
  helperLike: boolean
}

interface WorkflowCenterAggregate {
  path: string
  label: string
  score: number
  direct_matches: number
  matched_symbols: string[]
  reasons: string[]
  reasonSet: Set<string>
  phase_reasons: string[]
  phaseReasonSet: Set<string>
  matchedSymbolSet: Set<string>
  phases: ImplementationPackPhase[]
  phaseSet: Set<ImplementationPackPhase>
  bestNodeScore: number
  bestNonHelperLabel?: string
  bestNonHelperScore: number
}

function rootPathFromGraph(graph: KnowledgeGraph): string | undefined {
  return typeof graph.graph.root_path === 'string' && graph.graph.root_path.trim().length > 0
    ? graph.graph.root_path.trim()
    : undefined
}

function roundFileScore(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100
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

function finalizeReason(reason: string): string {
  const trimmed = reason.trim()
  if (trimmed.length === 0) {
    return 'Relevant file for this task.'
  }
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function pushUnique(values: string[], seen: Set<string>, value: string | undefined): void {
  if (!value || value.length === 0 || seen.has(value)) {
    return
  }
  seen.add(value)
  values.push(value)
}

function pushUniquePhase(
  values: ImplementationPackPhase[],
  seen: Set<ImplementationPackPhase>,
  value: ImplementationPackPhase | undefined,
): void {
  if (!value || seen.has(value)) {
    return
  }
  seen.add(value)
  values.push(value)
}

function orderedPhases(phases: readonly ImplementationPackPhase[]): ImplementationPackPhase[] {
  const seen = new Set<ImplementationPackPhase>()
  const ordered: ImplementationPackPhase[] = []
  for (const phase of IMPLEMENTATION_PIPELINE_PHASE_ORDER) {
    if (!phases.includes(phase) || seen.has(phase)) {
      continue
    }
    seen.add(phase)
    ordered.push(phase)
  }
  return ordered
}

function mergePhaseLists(
  values: ImplementationPackPhase[],
  seen: Set<ImplementationPackPhase>,
  phases: readonly ImplementationPackPhase[],
): void {
  for (const phase of phases) {
    pushUniquePhase(values, seen, phase)
  }
}

function createImplementationPackFileHint(
  path: string,
  score: number,
  reason: string,
  matchedSymbols: readonly string[],
  phases: readonly ImplementationPackPhase[] = [],
): ImplementationPackFileHint {
  const finalReason = finalizeReason(reason)
  return {
    path,
    score: roundFileScore(score),
    reason: finalReason,
    why: finalReason,
    matched_symbols: [...new Set(matchedSymbols)],
    ...(phases.length > 0 ? { phases: orderedPhases(phases) } : {}),
  }
}

function helperLikeFileContext(
  path: string,
  labelOrSymbols: readonly string[],
  reason?: string,
): boolean {
  return HELPER_PATTERN.test([path, ...labelOrSymbols, reason ?? ''].join(' '))
}

function fileContextText(
  path: string,
  labelOrSymbols: readonly string[],
  reason?: string,
): string {
  return [path, ...labelOrSymbols, reason ?? ''].join(' ')
}

function promptPrefersWorkflowOwner(question?: string): boolean {
  return typeof question === 'string' && WORKFLOW_OWNER_FOCUS_PATTERN.test(question)
}

function promptExplicitlyTargetsClientSurface(question?: string): boolean {
  return typeof question === 'string' && EXPLICIT_CLIENT_TARGET_PATTERN.test(question)
}

function runtimeBoundaryLikeFileContext(
  path: string,
  labelOrSymbols: readonly string[],
  _reason?: string,
): boolean {
  return RUNTIME_BOUNDARY_PATTERN.test(fileContextText(path, labelOrSymbols))
}

function shellLikeFileContext(
  path: string,
  labelOrSymbols: readonly string[],
  reason?: string,
): boolean {
  if (runtimeBoundaryLikeFileContext(path, labelOrSymbols, reason)) {
    return false
  }

  const joined = fileContextText(path, labelOrSymbols)
  return SHELL_SURFACE_PATH_PATTERN.test(path)
    || /\bcreateapp\b/i.test(joined)
    || /\bpage\b/i.test(joined)
    || /\blayout\b/i.test(joined)
}

function clientOnlyFileContext(
  path: string,
  labelOrSymbols: readonly string[],
  reason?: string,
): boolean {
  return !runtimeBoundaryLikeFileContext(path, labelOrSymbols, reason)
    && CLIENT_SURFACE_PATTERN.test(fileContextText(path, labelOrSymbols))
}

function supportingOnlyWorkflowContextReason(
  path: string,
  labelOrSymbols: readonly string[],
  question?: string,
  reason?: string,
): string | null {
  if (!promptPrefersWorkflowOwner(question)) {
    return null
  }

  if (explicitlyTargetsPathOrSymbol(question, path, labelOrSymbols)) {
    return null
  }

  if (clientOnlyFileContext(path, labelOrSymbols, reason) && !promptExplicitlyTargetsClientSurface(question)) {
    return `Treat ${path} as supporting context first, not the default edit path, unless the prompt explicitly targets that client surface.`
  }

  if (shellLikeFileContext(path, labelOrSymbols, reason)) {
    return `Treat ${path} as supporting context first, not the default edit path, unless the prompt explicitly targets that route or page shell.`
  }

  return null
}

function workflowIntentScoreAdjustment(
  path: string,
  labelOrSymbols: readonly string[],
  question?: string,
  reason?: string,
): { delta: number; reasons: string[] } {
  if (!promptPrefersWorkflowOwner(question)) {
    return { delta: 0, reasons: [] }
  }

  const reasons: string[] = []
  let delta = 0
  const supportingOnlyReason = supportingOnlyWorkflowContextReason(path, labelOrSymbols, question, reason)

  if (runtimeBoundaryLikeFileContext(path, labelOrSymbols, reason)) {
    delta += 5
    reasons.push('Task wording points toward the runtime/storage owner on the route/controller/service path.')
  }

  if (supportingOnlyReason) {
    delta -= clientOnlyFileContext(path, labelOrSymbols, reason) ? 6 : 5.5
    reasons.push(supportingOnlyReason)
  }

  return { delta, reasons }
}

function explicitlyTargetsPathOrSymbol(
  question: string | undefined,
  path: string,
  symbols: readonly string[],
): boolean {
  if (!question) {
    return false
  }

  const prompt = question.toLowerCase()
  const normalizedPath = path.toLowerCase()
  if (prompt.includes(normalizedPath) || prompt.includes(basename(normalizedPath))) {
    return true
  }

  return symbols.some((symbol) => symbol.length > 0 && prompt.includes(symbol.toLowerCase()))
}

function addRankedFileCandidate(
  target: Map<string, RankedFileAccumulator>,
  path: string,
  score: number,
  reason: string,
  matchedSymbols: readonly string[],
  phases: readonly ImplementationPackPhase[] = [],
): void {
  const entry = target.get(path) ?? {
    path,
    score: 0,
    matched_symbols: [],
    matchedSymbolSet: new Set<string>(),
    reasons: [],
    reasonSet: new Set<string>(),
    phases: [],
    phaseSet: new Set<ImplementationPackPhase>(),
  }
  entry.score += score
  pushUnique(entry.reasons, entry.reasonSet, finalizeReason(reason))
  for (const symbol of matchedSymbols) {
    pushUnique(entry.matched_symbols, entry.matchedSymbolSet, symbol)
  }
  mergePhaseLists(entry.phases, entry.phaseSet, phases)
  target.set(path, entry)
}

function rankedFileHints(
  entries: Iterable<RankedFileAccumulator>,
  limit: number,
  extraPhases: readonly ImplementationPackPhase[] = [],
): ImplementationPackFileHint[] {
  return [...entries]
    .sort((left, right) => right.score - left.score
      || right.reasons.length - left.reasons.length
      || compareStableText(left.path, right.path))
    .slice(0, limit)
    .map((entry) => createImplementationPackFileHint(
      entry.path,
      entry.score,
      entry.reasons[0] ?? 'Relevant file for this task.',
      entry.matched_symbols,
      [...entry.phases, ...extraPhases],
    ))
}

function tokenizePathValue(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_\\\-./,:;!?'"()[\]{}]+/)
    .filter((token) => token.length > 1)
}

function fileNameTokens(path: string): string[] {
  const fileName = basename(path)
    .replace(/\.(?:test|spec|e2e|integration)(?=\.[^.]+$)/i, '')
    .replace(/\.[^.]+$/, '')
  return tokenizePathValue(fileName)
}

function moduleTokens(path: string): string[] {
  return tokenizePathValue(dirname(path))
    .filter((token) => !GENERIC_MODULE_TOKENS.has(token))
}

function overlapCount(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0
  }
  const rightSet = new Set(right)
  let overlap = 0
  for (const token of new Set(left)) {
    if (rightSet.has(token)) {
      overlap += 1
    }
  }
  return overlap
}

function taskExplicitlyTargetsTests(question: string): boolean {
  return TEST_EDIT_PATTERN.test(question)
}

function isWorkflowEntryPoint(node: {
  label?: string
  source_file: string
  node_kind?: string
  framework_role?: string
}): boolean {
  const nodeKind = node.node_kind?.toLowerCase() ?? ''
  const frameworkRole = node.framework_role?.toLowerCase() ?? ''
  return PUBLIC_SURFACE_NODE_KINDS.has(nodeKind)
    || frameworkRole.includes('route')
    || frameworkRole.includes('controller')
    || frameworkRole.includes('page')
    || frameworkRole.includes('layout')
    || frameworkRole.includes('middleware')
    || frameworkRole.includes('handler')
    || PUBLIC_SURFACE_PATH_PATTERN.test(node.source_file)
    || /(?:^|\/)[^/]*(?:route|router|controller|handler)\.[^/]+$/i.test(node.source_file)
}

function graphNodeFile(graph: KnowledgeGraph, nodeId: string): string {
  return String(graph.nodeAttributes(nodeId).source_file ?? '')
}

function classifyWorkflowDomain(graph: KnowledgeGraph, nodeId: string, rootPath?: string): ReturnType<typeof classifySourceDomain> {
  return classifySourceDomain(graphNodeFile(graph, nodeId), rootPath)
}

function graphRelation(graph: KnowledgeGraph, sourceId: string, targetId: string): string {
  return String(graph.edgeAttributes(sourceId, targetId).relation ?? '')
}

function upsertWorkflowCandidate(
  target: Map<string, WorkflowNodeCandidate>,
  candidate: WorkflowNodeCandidate,
): void {
  const existing = target.get(candidate.node_id)
  if (!existing) {
    target.set(candidate.node_id, {
      ...candidate,
      phases: orderedPhases(candidate.phases),
      phase_reasons: [...new Set(candidate.phase_reasons)],
    })
    return
  }

  existing.match_score = Math.max(existing.match_score, candidate.match_score)
  if (candidate.relevance_band === 'direct') {
    existing.relevance_band = 'direct'
  }
  if (!existing.node_kind && candidate.node_kind) {
    existing.node_kind = candidate.node_kind
  }
  if (!existing.framework_role && candidate.framework_role) {
    existing.framework_role = candidate.framework_role
  }
  existing.phases = orderedPhases([...existing.phases, ...candidate.phases])
  existing.phase_reasons = [...new Set([...existing.phase_reasons, ...candidate.phase_reasons])]
}

function workflowCandidates(
  graph: KnowledgeGraph,
  retrieval: RetrieveResult,
  rootPath?: string,
): WorkflowNodeCandidate[] {
  const byNodeId = new Map<string, WorkflowNodeCandidate>()

  for (const node of retrieval.matched_nodes) {
    if (!node.node_id || node.relevance_band === 'peripheral') {
      continue
    }
    const sourceDomain = classifySourceDomain(node.source_file, rootPath)
    if (sourceDomain === 'test' || sourceDomain === 'docs' || sourceDomain === 'build_artifact') {
      continue
    }
    upsertWorkflowCandidate(byNodeId, {
      node_id: node.node_id,
      label: node.label,
      source_file: node.source_file,
      ...(node.node_kind ? { node_kind: node.node_kind } : {}),
      ...(node.framework_role ? { framework_role: node.framework_role } : {}),
      match_score: node.match_score,
      relevance_band: node.relevance_band === 'direct' ? 'direct' : 'related',
      phases: ['seed'],
      phase_reasons: ['Seed search matched this symbol directly from the task prompt.'],
    })
  }

  for (const node of retrieval.matched_nodes) {
    if (!node.node_id || node.relevance_band !== 'direct') {
      continue
    }

    for (const predecessorId of graph.predecessors(node.node_id)) {
      const relation = graphRelation(graph, predecessorId, node.node_id)
      if (!WORKFLOW_EDGE_RELATIONS.has(relation)) {
        continue
      }
      if (classifyWorkflowDomain(graph, predecessorId, rootPath) !== 'production') {
        continue
      }
      const attributes = graph.nodeAttributes(predecessorId)
      upsertWorkflowCandidate(byNodeId, {
        node_id: predecessorId,
        label: String(attributes.label ?? predecessorId),
        source_file: String(attributes.source_file ?? ''),
        ...(attributes.node_kind ? { node_kind: String(attributes.node_kind) } : {}),
        ...(attributes.framework_role ? { framework_role: String(attributes.framework_role) } : {}),
        match_score: Math.max(0.1, node.match_score * 0.35),
        relevance_band: 'related',
        phases: ['expand'],
        phase_reasons: [`Graph expansion followed ${relation} from ${node.label}.`],
      })
    }

    for (const successorId of graph.successors(node.node_id)) {
      const relation = graphRelation(graph, node.node_id, successorId)
      if (!WORKFLOW_EDGE_RELATIONS.has(relation)) {
        continue
      }
      if (classifyWorkflowDomain(graph, successorId, rootPath) !== 'production') {
        continue
      }
      const attributes = graph.nodeAttributes(successorId)
      upsertWorkflowCandidate(byNodeId, {
        node_id: successorId,
        label: String(attributes.label ?? successorId),
        source_file: String(attributes.source_file ?? ''),
        ...(attributes.node_kind ? { node_kind: String(attributes.node_kind) } : {}),
        ...(attributes.framework_role ? { framework_role: String(attributes.framework_role) } : {}),
        match_score: Math.max(0.1, node.match_score * 0.25),
        relevance_band: 'related',
        phases: ['expand'],
        phase_reasons: [`Graph expansion followed ${relation} from ${node.label}.`],
      })
    }
  }

  return [...byNodeId.values()]
}

function nearestEntryPointDistance(
  graph: KnowledgeGraph,
  nodeId: string,
  rootPath?: string,
  maxHops = 3,
): number | null {
  const queue = [{ nodeId, distance: 0 }]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || seen.has(current.nodeId)) {
      continue
    }
    seen.add(current.nodeId)

    const attributes = graph.nodeAttributes(current.nodeId)
    if (isWorkflowEntryPoint({
      label: String(attributes.label ?? current.nodeId),
      source_file: String(attributes.source_file ?? ''),
      ...(attributes.node_kind ? { node_kind: String(attributes.node_kind) } : {}),
      ...(attributes.framework_role ? { framework_role: String(attributes.framework_role) } : {}),
    })) {
      return current.distance
    }

    if (current.distance >= maxHops) {
      continue
    }

    for (const predecessorId of graph.predecessors(current.nodeId)) {
      const relation = graphRelation(graph, predecessorId, current.nodeId)
      if (!WORKFLOW_EDGE_RELATIONS.has(relation) || classifyWorkflowDomain(graph, predecessorId, rootPath) !== 'production') {
        continue
      }
      queue.push({ nodeId: predecessorId, distance: current.distance + 1 })
    }
  }

  return null
}

function nonTestDegrees(
  graph: KnowledgeGraph,
  nodeId: string,
  rootPath?: string,
): { incoming: number; outgoing: number; coveredByTests: number; sideEffectTargets: string[] } {
  let incoming = 0
  let outgoing = 0
  let coveredByTests = 0
  const sideEffectTargets: string[] = []
  const seenSideEffects = new Set<string>()

  for (const predecessorId of graph.predecessors(nodeId)) {
    const relation = graphRelation(graph, predecessorId, nodeId)
    if (relation === 'covered_by') {
      continue
    }
    if (classifyWorkflowDomain(graph, predecessorId, rootPath) !== 'production') {
      continue
    }
    incoming += 1
  }

  for (const successorId of graph.successors(nodeId)) {
    const relation = graphRelation(graph, nodeId, successorId)
    const successorAttributes = graph.nodeAttributes(successorId)
    const successorLabel = String(successorAttributes.label ?? successorId)
    const successorFile = String(successorAttributes.source_file ?? '')
    const successorDomain = classifySourceDomain(successorFile, rootPath)
    if (relation === 'covered_by') {
      if (successorDomain === 'test') {
        coveredByTests += 1
      }
      continue
    }
    if (successorDomain !== 'production') {
      continue
    }
    outgoing += 1
    if (
      SIDE_EFFECT_PATTERN.test(relation)
      || SIDE_EFFECT_PATTERN.test(successorLabel)
      || SIDE_EFFECT_PATTERN.test(successorFile)
    ) {
      pushUnique(sideEffectTargets, seenSideEffects, successorLabel)
    }
  }

  return { incoming, outgoing, coveredByTests, sideEffectTargets }
}

function scoreWorkflowCandidate(
  graph: KnowledgeGraph,
  candidate: WorkflowNodeCandidate,
  rootPath?: string,
): WorkflowScoreDetails {
  const reasons: string[] = []
  let score = candidate.match_score * 0.75

  if (candidate.relevance_band === 'direct') {
    score += 0.75
    reasons.push('Direct task evidence anchors this file in the implementation brief.')
  }

  const entryPointDistance = nearestEntryPointDistance(graph, candidate.node_id, rootPath)
  if (entryPointDistance === 0) {
    score += 6
    reasons.push('Owns the route/controller entry point for the workflow.')
  } else if (entryPointDistance === 1) {
    score += 5
    reasons.push('One hop from the route/controller entry point.')
  } else if (entryPointDistance === 2) {
    score += 3.5
    reasons.push('Sits close to the route/controller chain that starts the flow.')
  } else if (entryPointDistance === 3) {
    score += 2
    reasons.push('Still structurally close to the main workflow entry path.')
  }

  const workflowOwnerLabel = `${candidate.label} ${candidate.source_file} ${candidate.node_kind ?? ''} ${candidate.framework_role ?? ''}`
  if (WORKFLOW_OWNER_PATTERN.test(workflowOwnerLabel)) {
    score += 2.5
    reasons.push('Looks like a workflow-owning surface such as a service, controller, worker, queue, or command.')
  }

  const degrees = nonTestDegrees(graph, candidate.node_id, rootPath)
  if (degrees.incoming > 0 || degrees.outgoing > 0) {
    score += Math.min(4, (degrees.incoming * 0.8) + (degrees.outgoing * 1.1))
    if (degrees.incoming > 0 && degrees.outgoing > 0) {
      reasons.push(`Call-graph centrality shows fan-in ${degrees.incoming} and fan-out ${degrees.outgoing}.`)
    } else if (degrees.outgoing > 0) {
      reasons.push(`Fan-out ${degrees.outgoing} suggests this node orchestrates downstream work.`)
    } else {
      reasons.push(`Fan-in ${degrees.incoming} shows multiple upstream callers converge here.`)
    }
  }

  if (degrees.sideEffectTargets.length > 0) {
    score += 2.5
    reasons.push(`Touches side-effect boundaries via ${degrees.sideEffectTargets.slice(0, 2).join(' and ')}.`)
  }

  if (degrees.coveredByTests > 0) {
    score += 1
    reasons.push('Covered by nearby tests, which makes it a strong edit-and-validate anchor.')
  }

  const helperLike = HELPER_PATTERN.test(workflowOwnerLabel)
  if (helperLike && entryPointDistance === null && degrees.outgoing <= 1 && degrees.sideEffectTargets.length === 0) {
    score -= 3.5
    reasons.push('Mostly looks like a leaf helper rather than the owning workflow surface.')
  }

  return { score, reasons, helperLike }
}

function workflowCenters(
  graph: KnowledgeGraph,
  retrieval: RetrieveResult,
  rootPath: string | undefined,
  limit: number,
): ContextPackWorkflowCenter[] {
  const centers = new Map<string, WorkflowCenterAggregate>()

  for (const candidate of workflowCandidates(graph, retrieval, rootPath)) {
    const path = relativizeSourceFile(candidate.source_file, rootPath)
    const scoreDetails = scoreWorkflowCandidate(graph, candidate, rootPath)
    const current = centers.get(path) ?? {
      path,
      label: candidate.label,
      score: 0,
      direct_matches: 0,
      matched_symbols: [],
      reasons: [],
      reasonSet: new Set<string>(),
      phase_reasons: [],
      phaseReasonSet: new Set<string>(),
      matchedSymbolSet: new Set<string>(),
      phases: [],
      phaseSet: new Set<ImplementationPackPhase>(),
      bestNodeScore: Number.NEGATIVE_INFINITY,
      bestNonHelperScore: Number.NEGATIVE_INFINITY,
    }

    current.score += scoreDetails.score
    if (candidate.relevance_band === 'direct') {
      current.direct_matches += 1
    }
    pushUnique(current.matched_symbols, current.matchedSymbolSet, candidate.label)
    for (const reason of candidate.phase_reasons) {
      pushUnique(current.phase_reasons, current.phaseReasonSet, reason)
    }
    for (const reason of scoreDetails.reasons) {
      pushUnique(current.reasons, current.reasonSet, reason)
    }
    mergePhaseLists(current.phases, current.phaseSet, candidate.phases)
    const scoreDelta = scoreDetails.score - current.bestNodeScore
    if (scoreDelta > 1e-9 || (Math.abs(scoreDelta) <= 1e-9 && !scoreDetails.helperLike)) {
      current.bestNodeScore = scoreDetails.score
      current.label = candidate.label
    }
    if (!scoreDetails.helperLike && scoreDetails.score > current.bestNonHelperScore) {
      current.bestNonHelperScore = scoreDetails.score
      current.bestNonHelperLabel = candidate.label
    }
    centers.set(path, current)
  }

  return [...centers.values()]
    .map((entry) => {
      const reasons = [...entry.reasons]
      if (entry.direct_matches > 1) {
        entry.score += 0.5
        reasons.push(`Multiple direct matches converge in ${entry.path}.`)
      }
      const intentAdjustment = workflowIntentScoreAdjustment(
        entry.path,
        [entry.label, ...entry.matched_symbols],
        retrieval.question,
        reasons[0],
      )
      entry.score += intentAdjustment.delta
      for (const reason of intentAdjustment.reasons) {
        pushUnique(reasons, entry.reasonSet, reason)
      }
      const reason = [
        ...entry.phase_reasons,
        'Workflow-center promotion preferred this file as the owning workflow surface.',
        ...reasons,
      ].slice(0, 3).join(' ')
      return {
        label: entry.bestNonHelperLabel ?? entry.label,
        path: entry.path,
        score: Math.round(entry.score * 100) / 100,
        reasons: reasons.slice(0, 4),
        matched_symbols: entry.matched_symbols,
        reason: reason.length > 0 ? reason : 'Structural and lexical signals both point to this file.',
        phases: orderedPhases([...entry.phases, 'promote']),
      } satisfies ContextPackWorkflowCenter
    })
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0)
      || (right.reasons?.length ?? 0) - (left.reasons?.length ?? 0)
      || compareStableText(left.path ?? '', right.path ?? ''))
    .slice(0, limit)
}

function mergeLikelyEditFiles(
  workflowCentersValue: readonly ContextPackWorkflowCenter[],
  starterFiles: readonly ImplementationPackFileHint[],
  rootPath: string | undefined,
  allowTestFiles: boolean,
  limit: number,
  question?: string,
): ImplementationPackFileHint[] {
  const results: ImplementationPackFileHint[] = []
  const seen = new Set<string>()
  const hasPrimaryWorkflowCenter = workflowCentersValue.some((center) => center.path
    && !helperLikeFileContext(center.path, [center.label, ...(center.matched_symbols ?? [])], center.reason)
    && !supportingOnlyWorkflowContextReason(
      center.path,
      [center.label, ...(center.matched_symbols ?? [])],
      question,
      center.reason,
    ))
  const starterByPath = new Map(
    starterFiles
      .filter((entry) => allowTestFiles || classifySourceDomain(entry.path, rootPath) !== 'test')
      .map((entry) => [entry.path, entry] as const),
  )

  for (const center of workflowCentersValue) {
    if (
      !center.path
      || seen.has(center.path)
      || (!allowTestFiles && classifySourceDomain(center.path, rootPath) === 'test')
      || (hasPrimaryWorkflowCenter
        && helperLikeFileContext(center.path, [center.label, ...(center.matched_symbols ?? [])], center.reason)
        && !explicitlyTargetsPathOrSymbol(question, center.path, [center.label, ...(center.matched_symbols ?? [])]))
      || (hasPrimaryWorkflowCenter
        && supportingOnlyWorkflowContextReason(
          center.path,
          [center.label, ...(center.matched_symbols ?? [])],
          question,
          center.reason,
        ))
    ) {
      continue
    }
    const existing = starterByPath.get(center.path)
    const matchedSymbols = [...new Set([
      ...(center.matched_symbols ?? []),
      ...(existing?.matched_symbols ?? []),
    ])]
    results.push({
      path: center.path,
      score: roundFileScore((center.score ?? 0) + ((existing?.score ?? 0) * 0.25)),
      reason: center.reason,
      why: center.reason,
      matched_symbols: matchedSymbols.length > 0 ? matchedSymbols : [center.label],
      phases: orderedPhases([...(center.phases ?? []), ...(existing?.phases ?? []), 'attach', 'refine']),
    })
    seen.add(center.path)
    if (results.length >= limit) {
      return results
    }
  }

  for (const entry of starterFiles) {
    if (
      seen.has(entry.path)
      || (!allowTestFiles && classifySourceDomain(entry.path, rootPath) === 'test')
      || (hasPrimaryWorkflowCenter
        && helperLikeFileContext(entry.path, entry.matched_symbols, entry.reason)
        && !explicitlyTargetsPathOrSymbol(question, entry.path, entry.matched_symbols))
      || (hasPrimaryWorkflowCenter
        && supportingOnlyWorkflowContextReason(entry.path, entry.matched_symbols, question, entry.reason))
    ) {
      continue
    }
    results.push({
      ...entry,
      ...(entry.phases?.length
        ? { phases: orderedPhases([...entry.phases, 'attach', 'refine']) }
        : { phases: ['attach', 'refine'] as ImplementationPackPhase[] }),
    })
    seen.add(entry.path)
    if (results.length >= limit) {
      break
    }
  }

  return results
}

function groupFiles(
  nodes: readonly RetrieveMatchedNode[],
  rootPath?: string,
  phases: readonly ImplementationPackPhase[] = [],
): ImplementationPackFileHint[] {
  const byPath = new Map<string, FileAggregate>()

  for (const node of nodes) {
    if (node.source_file.length === 0 || node.relevance_band === 'peripheral') {
      continue
    }

    const path = relativizeSourceFile(node.source_file, rootPath)
    const existing = byPath.get(path) ?? {
      path,
      score: 0,
      direct_symbols: [],
      related_symbols: [],
    }
    if (node.relevance_band === 'direct') {
      existing.score += (node.match_score * 4) + 1
      if (!existing.direct_symbols.includes(node.label)) {
        existing.direct_symbols.push(node.label)
      }
    } else if (!existing.related_symbols.includes(node.label)) {
      existing.score += (node.match_score * 2) + 0.5
      existing.related_symbols.push(node.label)
    }
    byPath.set(path, existing)
  }

  return [...byPath.values()].map((entry) => {
    const reason = entry.direct_symbols.length > 0
      ? `Direct test evidence via ${entry.direct_symbols.slice(0, 3).join(', ')}`
      : `Supporting test context via ${entry.related_symbols.slice(0, 2).join(', ')}`
    return createImplementationPackFileHint(
      entry.path,
      entry.score,
      reason,
      [...entry.direct_symbols, ...entry.related_symbols],
      phases,
    )
  })
}

function indexTestFiles(graph: KnowledgeGraph, rootPath?: string): IndexedTestFile[] {
  const byPath = new Map<string, IndexedTestFile>()

  for (const [, attributes] of graph.nodeEntries()) {
    const sourceFile = String(attributes.source_file ?? '')
    if (sourceFile.length === 0 || classifySourceDomain(sourceFile, rootPath) !== 'test') {
      continue
    }

    const path = relativizeSourceFile(sourceFile, rootPath)
    const existing = byPath.get(path) ?? {
      path,
      labels: [],
      labelSet: new Set<string>(),
      name_tokens: fileNameTokens(path),
      module_tokens: moduleTokens(path),
      entry_surface_like: E2E_TEST_PATTERN.test(path),
    }
    pushUnique(existing.labels, existing.labelSet, String(attributes.label ?? ''))
    byPath.set(path, existing)
  }

  return [...byPath.values()]
}

function likelyTestFiles(
  graph: KnowledgeGraph,
  retrieval: RetrieveResult,
  likelyEditFiles: readonly ImplementationPackFileHint[],
  rootPath: string | undefined,
  limit: number,
): ImplementationPackFileHint[] {
  const ranked = new Map<string, RankedFileAccumulator>()
  const directAndCovered = groupFiles(
    [
      ...retrieval.matched_nodes.filter((node) => classifySourceDomain(node.source_file, rootPath) === 'test'),
      ...coveredTestNodes(graph, retrieval, rootPath),
    ],
    rootPath,
    ['attach'],
  )

  for (const entry of directAndCovered) {
    addRankedFileCandidate(ranked, entry.path, entry.score, entry.reason, entry.matched_symbols, entry.phases ?? ['attach'])
  }

  const indexedTests = indexTestFiles(graph, rootPath)
  const publicSurfacePaths = retrieval.matched_nodes
    .filter((node) => classifySourceDomain(node.source_file, rootPath) !== 'test')
    .filter((node) => isPublicSurfaceNode(node))
    .map((node) => relativizeSourceFile(node.source_file, rootPath))
  const publicNameTokens = [...new Set(publicSurfacePaths.flatMap((path) => fileNameTokens(path)))]
  const publicModuleTokens = [...new Set(publicSurfacePaths.flatMap((path) => moduleTokens(path)))]

  for (const editFile of likelyEditFiles) {
    const editNameTokens = fileNameTokens(editFile.path)
    const editModuleTokens = moduleTokens(editFile.path)

    for (const testFile of indexedTests) {
      const nameOverlap = overlapCount(editNameTokens, testFile.name_tokens)
      const moduleOverlap = overlapCount(editModuleTokens, testFile.module_tokens)
      let score = 0
      const reasons: string[] = []

      if (nameOverlap > 0) {
        score += 1.5 + (nameOverlap * 0.9)
        reasons.push(`Naming overlaps with ${editFile.path}`)
      }
      if (moduleOverlap > 0) {
        score += 1 + (moduleOverlap * 0.75)
        reasons.push(`Lives in the same module area as ${editFile.path}`)
      }
      if (testFile.entry_surface_like) {
        const publicOverlap = overlapCount(publicNameTokens, testFile.name_tokens) + overlapCount(publicModuleTokens, testFile.module_tokens)
        if (publicOverlap > 0) {
          score += 2.5
          reasons.push('E2E/integration coverage sits near the public entry surface for this workflow')
        }
      }

      if (score <= 0) {
        continue
      }

      addRankedFileCandidate(
        ranked,
        testFile.path,
        score,
        reasons.join('. '),
        [
          ...(testFile.labels.length > 0 ? [testFile.labels[0]!] : []),
          ...editFile.matched_symbols,
        ],
        ['attach'],
      )
    }
  }

  return rankedFileHints(ranked.values(), limit, ['refine'])
}

function coveredTestNodes(
  graph: KnowledgeGraph,
  retrieval: RetrieveResult,
  rootPath?: string,
): RetrieveMatchedNode[] {
  const derived = new Map<string, RetrieveMatchedNode>()

  for (const node of retrieval.matched_nodes) {
    if (!node.node_id || node.relevance_band === 'peripheral') {
      continue
    }
    if (classifySourceDomain(node.source_file, rootPath) === 'test') {
      continue
    }

    for (const successorId of graph.successors(node.node_id)) {
      const edge = graph.edgeAttributes(node.node_id, successorId)
      if (String(edge.relation ?? '') !== 'covered_by') {
        continue
      }

      const attributes = graph.nodeAttributes(successorId)
      const sourceFile = String(attributes.source_file ?? '')
      if (classifySourceDomain(sourceFile, rootPath) !== 'test') {
        continue
      }

      const label = String(attributes.label ?? successorId)
      const key = `${sourceFile}:${label}`
      if (derived.has(key)) {
        continue
      }

      derived.set(key, {
        node_id: successorId,
        label,
        source_file: sourceFile,
        line_number: 0,
        node_kind: String(attributes.node_kind ?? ''),
        file_type: String(attributes.file_type ?? 'code'),
        snippet: null,
        match_score: Math.max(0.1, node.match_score - 0.1),
        relevance_band: 'related',
        community: typeof attributes.community === 'number' ? attributes.community : null,
        community_label: null,
      })
    }
  }

  return [...derived.values()]
}

function isContractNode(node: RetrieveMatchedNode): boolean {
  return CONTRACT_PATH_PATTERN.test(node.source_file)
    || (typeof node.node_kind === 'string' && CONTRACT_NODE_KINDS.has(node.node_kind.toLowerCase()))
}

function isPublicSurfaceNode(node: RetrieveMatchedNode): boolean {
  const nodeKind = node.node_kind?.toLowerCase() ?? ''
  const frameworkRole = node.framework_role?.toLowerCase() ?? ''
  return PUBLIC_SURFACE_NODE_KINDS.has(nodeKind)
    || frameworkRole.includes('route')
    || frameworkRole.includes('controller')
    || frameworkRole.includes('page')
    || frameworkRole.includes('layout')
    || frameworkRole.includes('middleware')
    || PUBLIC_SURFACE_PATH_PATTERN.test(node.source_file)
}

function pushSurfaceHint(
  seen: Set<string>,
  target: ImplementationPackSurfaceHint[],
  node: RetrieveMatchedNode,
  kind: ImplementationPackSurfaceHint['kind'],
  why: string,
  rootPath?: string,
  phases: readonly ImplementationPackPhase[] = [],
): void {
  const sourceFile = relativizeSourceFile(node.source_file, rootPath)
  const key = `${kind}:${sourceFile}:${node.label}:${node.line_number}`
  if (seen.has(key)) {
    return
  }
  seen.add(key)
  target.push({
    label: node.label,
    source_file: sourceFile,
    line_number: node.line_number,
    kind,
    why,
    ...(phases.length > 0 ? { phases: orderedPhases(phases) } : {}),
  })
}

function graphNodesForPath(
  graph: KnowledgeGraph,
  path: string,
  rootPath?: string,
): string[] {
  return graph
    .nodeEntries()
    .filter(([, attributes]) => relativizeSourceFile(String(attributes.source_file ?? ''), rootPath) === path)
    .map(([nodeId]) => nodeId)
}

function retrieveMatchedNodeFromGraph(
  graph: KnowledgeGraph,
  nodeId: string,
): RetrieveMatchedNode {
  const attributes = graph.nodeAttributes(nodeId)
  return {
    node_id: nodeId,
    label: String(attributes.label ?? nodeId),
    source_file: String(attributes.source_file ?? ''),
    line_number:
      typeof attributes.line_number === 'number' && Number.isFinite(attributes.line_number)
        ? attributes.line_number
        : lineNumberFromSourceLocation(String(attributes.source_location ?? '')),
    node_kind: String(attributes.node_kind ?? ''),
    framework_role: typeof attributes.framework_role === 'string' ? attributes.framework_role : undefined,
    file_type: String(attributes.file_type ?? 'code'),
    snippet: null,
    match_score: 0,
    relevance_band: 'related',
    community: typeof attributes.community === 'number' ? attributes.community : null,
    community_label: null,
  }
}

function buildSurfaceHints(
  graph: KnowledgeGraph,
  retrieval: RetrieveResult,
  editPaths: ReadonlySet<string>,
  workflowCentersValue: readonly ContextPackWorkflowCenter[],
  rootPath?: string,
): {
  contracts_and_public_surfaces: ImplementationPackSurfaceHint[]
  existing_patterns: ImplementationPackSurfaceHint[]
} {
  const contracts_and_public_surfaces: ImplementationPackSurfaceHint[] = []
  const existing_patterns: ImplementationPackSurfaceHint[] = []
  const surfaceSeen = new Set<string>()
  const patternSeen = new Set<string>()

  for (const node of retrieval.matched_nodes) {
    if (node.relevance_band === 'peripheral') {
      continue
    }

    const sourceFile = relativizeSourceFile(node.source_file, rootPath)
    const sourceDomain = classifySourceDomain(node.source_file, rootPath)
    if (sourceDomain === 'test' || sourceDomain === 'docs' || sourceDomain === 'build_artifact') {
      continue
    }

    if (isContractNode(node)) {
      pushSurfaceHint(surfaceSeen, contracts_and_public_surfaces, node, 'contract', 'Changing this contract can affect implementation callers.', rootPath, ['seed', 'attach'])
      continue
    }

    if (isPublicSurfaceNode(node)) {
      pushSurfaceHint(surfaceSeen, contracts_and_public_surfaces, node, 'public_surface', 'This is part of the public entry surface touched by the task.', rootPath, ['seed', 'attach'])
      continue
    }

    if (!editPaths.has(sourceFile)) {
      pushSurfaceHint(patternSeen, existing_patterns, node, 'pattern', 'Existing implementation context worth checking before editing.', rootPath)
    }
  }

  for (const center of workflowCentersValue) {
    if (!center.path) {
      continue
    }

    for (const nodeId of graphNodesForPath(graph, center.path, rootPath)) {
      for (const predecessorId of graph.predecessors(nodeId)) {
        const relation = graphRelation(graph, predecessorId, nodeId)
        if (!SURFACE_ATTACHMENT_RELATIONS.has(relation)) {
          continue
        }
        const neighbor = retrieveMatchedNodeFromGraph(graph, predecessorId)
        if (classifySourceDomain(neighbor.source_file, rootPath) !== 'production') {
          continue
        }
        if (isContractNode(neighbor)) {
          pushSurfaceHint(surfaceSeen, contracts_and_public_surfaces, neighbor, 'contract', `Attachment stage pulled this nearby contract in from ${center.label} via ${relation}.`, rootPath, ['attach'])
        } else if (isPublicSurfaceNode(neighbor)) {
          pushSurfaceHint(surfaceSeen, contracts_and_public_surfaces, neighbor, 'public_surface', `Attachment stage pulled this nearby public surface in from ${center.label} via ${relation}.`, rootPath, ['attach'])
        }
      }

      for (const successorId of graph.successors(nodeId)) {
        const relation = graphRelation(graph, nodeId, successorId)
        if (!SURFACE_ATTACHMENT_RELATIONS.has(relation)) {
          continue
        }
        const neighbor = retrieveMatchedNodeFromGraph(graph, successorId)
        if (classifySourceDomain(neighbor.source_file, rootPath) !== 'production') {
          continue
        }
        if (isContractNode(neighbor)) {
          pushSurfaceHint(surfaceSeen, contracts_and_public_surfaces, neighbor, 'contract', `Attachment stage pulled this nearby contract in from ${center.label} via ${relation}.`, rootPath, ['attach'])
        } else if (isPublicSurfaceNode(neighbor)) {
          pushSurfaceHint(surfaceSeen, contracts_and_public_surfaces, neighbor, 'public_surface', `Attachment stage pulled this nearby public surface in from ${center.label} via ${relation}.`, rootPath, ['attach'])
        }
      }
    }
  }

  return {
    contracts_and_public_surfaces: contracts_and_public_surfaces.slice(0, 6),
    existing_patterns: existing_patterns.slice(0, 5),
  }
}

function retrievalPipeline(
  retrieval: RetrieveResult,
  workflowCentersValue: readonly ContextPackWorkflowCenter[],
  likelyEditFiles: readonly ImplementationPackFileHint[],
  likelyTestFiles: readonly ImplementationPackFileHint[],
  contractsAndPublicSurfaces: readonly ImplementationPackSurfaceHint[],
  existingPatterns: readonly ImplementationPackSurfaceHint[],
  rootPath?: string,
): ImplementationPackRetrievalPipeline {
  const productionSeedCount = retrieval.matched_nodes.filter((node) => {
    if (node.relevance_band === 'peripheral') {
      return false
    }
    const sourceDomain = classifySourceDomain(node.source_file, rootPath)
    return sourceDomain !== 'test' && sourceDomain !== 'docs' && sourceDomain !== 'build_artifact'
  }).length
  const expandedCenterCount = workflowCentersValue.filter((entry) => entry.phases?.includes('expand')).length

  return {
    phases: [
      {
        phase: 'seed',
        summary: `Seed search matched ${productionSeedCount} production retrieval node${productionSeedCount === 1 ? '' : 's'}.`,
      },
      {
        phase: 'expand',
        summary: `Graph expansion added ${expandedCenterCount} promoted workflow candidate${expandedCenterCount === 1 ? '' : 's'} from structural neighbors.`,
      },
      {
        phase: 'promote',
        summary: `Workflow-center promotion ranked ${workflowCentersValue.length} owning file${workflowCentersValue.length === 1 ? '' : 's'} for the brief.`,
      },
      {
        phase: 'attach',
        summary: `Attachment linked ${likelyTestFiles.length} test file${likelyTestFiles.length === 1 ? '' : 's'} and ${contractsAndPublicSurfaces.length} contract/public surface file${contractsAndPublicSurfaces.length === 1 ? '' : 's'}.`,
      },
      {
        phase: 'refine',
        summary: `Refinement kept ${likelyEditFiles.length} edit file${likelyEditFiles.length === 1 ? '' : 's'}, ${likelyTestFiles.length} test file${likelyTestFiles.length === 1 ? '' : 's'}, and ${existingPatterns.length} supporting pattern${existingPatterns.length === 1 ? '' : 's'}.`,
      },
      {
        phase: 'render',
        summary: 'Pack Schema v1 renders the refined implementation guidance for downstream agents.',
      },
    ],
  }
}

function readWorkspacePackageScripts(rootPath?: string): { scripts: PackageScripts; warnings: string[] } {
  if (!rootPath) {
    return { scripts: {}, warnings: ['No workspace root was recorded, so validation commands could not inspect package.json.'] }
  }

  const packageJsonPath = join(rootPath, 'package.json')
  if (!existsSync(packageJsonPath)) {
    return { scripts: {}, warnings: ['No package.json was found in the analyzed workspace root.'] }
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: unknown }
    if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) {
      return { scripts: {}, warnings: ['The analyzed workspace package.json does not define scripts for validation commands.'] }
    }

    const scripts = Object.fromEntries(
      Object.entries(parsed.scripts)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0),
    )
    return { scripts, warnings: [] }
  } catch {
    return { scripts: {}, warnings: ['Could not parse the analyzed workspace package.json to derive validation commands.'] }
  }
}

function testCommandForScripts(scripts: PackageScripts, testFiles: readonly string[]): string[] {
  const commands: string[] = []
  if (testFiles.length > 0 && Object.hasOwn(scripts, 'test:run')) {
    commands.push(`npm run test:run -- ${testFiles.slice(0, 5).map((path) => shellEscapeIfNeeded(prefixTestPathFlagLikeArg(path))).join(' ')}`)
  }
  if (Object.hasOwn(scripts, 'test:run')) {
    commands.push('npm run test:run')
  } else if (Object.hasOwn(scripts, 'test')) {
    commands.push('npm run test')
  }
  return commands
}

function prefixTestPathFlagLikeArg(path: string): string {
  return path.startsWith('-') ? `./${path}` : path
}

function validationCommands(rootPath: string | undefined, testFiles: readonly ImplementationPackFileHint[]): {
  commands: string[]
  warnings: string[]
} {
  const { scripts, warnings } = readWorkspacePackageScripts(rootPath)
  const commands = [
    ...(Object.hasOwn(scripts, 'typecheck') ? ['npm run typecheck'] : []),
    ...(Object.hasOwn(scripts, 'build') ? ['npm run build'] : []),
    ...testCommandForScripts(scripts, testFiles.map((entry) => entry.path)),
  ]

  return {
    commands: [...new Set(commands)],
    warnings,
  }
}

function acceptanceCriteriaSummary(
  prompt: string,
  editFiles: readonly { path: string }[],
  testFiles: readonly ImplementationPackFileHint[],
  riskBoundaries: readonly ImplementationPackRiskBoundary[],
  contractsAndPublicSurfaces: readonly ImplementationPackSurfaceHint[],
): string[] {
  const requestedChange = prompt.includes(':') ? prompt.split(':').slice(1).join(':').trim() : prompt.trim()
  const summary = [`Implement the requested change: ${requestedChange}.`]

  if (editFiles.length > 0) {
    summary.push(`Update the likely edit surface starting with ${editFiles[0]!.path}.`)
  }
  if (testFiles.length > 0) {
    summary.push(`Keep related tests aligned, including ${testFiles.slice(0, 2).map((entry) => entry.path).join(' and ')}.`)
  }
  if (contractsAndPublicSurfaces.length > 0) {
    summary.push('Keep contracts and public surfaces aligned with the implementation change.')
  }
  if (riskBoundaries.length > 0) {
    summary.push(`Avoid regressions around ${riskBoundaries[0]!.label}.`)
  }

  return summary
}

function cautionMessages(
  retrieval: RetrieveResult,
  riskBoundaries: readonly ImplementationPackRiskBoundary[],
  validationWarnings: readonly string[],
  testFiles: readonly ImplementationPackFileHint[],
  workflowCentersValue: readonly ContextPackWorkflowCenter[],
  likelyEditFiles: readonly ImplementationPackFileHint[],
): string[] {
  const cautions: string[] = []

  if ((retrieval.coverage?.missing_required.length ?? 0) > 0) {
    cautions.push(`Missing required context: ${retrieval.coverage!.missing_required.join(', ')}.`)
  }
  if ((retrieval.coverage?.missing_semantic.length ?? 0) > 0) {
    cautions.push(`Missing semantic coverage: ${retrieval.coverage!.missing_semantic.join(', ')}.`)
  }
  for (const risk of riskBoundaries.filter((entry) => entry.severity === 'high').slice(0, 2)) {
    cautions.push(`High-risk shared boundary: ${risk.label} affects ${risk.affected_files.length} files.`)
  }
  if (testFiles.length === 0) {
    cautions.push('No related tests were retrieved; validate regression coverage manually.')
  }
  const editPaths = new Set(likelyEditFiles.map((entry) => entry.path))
  for (const center of workflowCentersValue) {
    if (!center.path || editPaths.has(center.path)) {
      continue
    }
    const supportingOnlyReason = supportingOnlyWorkflowContextReason(
      center.path,
      [center.label, ...(center.matched_symbols ?? [])],
      retrieval.question,
      center.reason,
    )
    if (supportingOnlyReason) {
      cautions.push(supportingOnlyReason)
    }
  }

  return [...new Set([...cautions, ...validationWarnings])]
}

function runtimeContext(
  executionSlice: ContextPackExecutionSlice | undefined,
  answerContract: ContextPackRuntimeGenerationAnswerContract | undefined,
): ImplementationPackGuidance['runtime_context_if_relevant'] | undefined {
  if (!executionSlice && !answerContract) {
    return undefined
  }

  return {
    summary: 'Runtime flow context was included because the retrieved implementation surface contains execution-path evidence.',
    ...(executionSlice ? { execution_slice: executionSlice } : {}),
    ...(answerContract ? { answer_contract: answerContract } : {}),
  }
}

export function buildImplementationPackGuidance(
  graph: KnowledgeGraph,
  retrieval: RetrieveResult,
  options: BuildImplementationPackOptions,
): ImplementationPackGuidance {
  const rootPath = rootPathFromGraph(graph)
  const limit = options.limit ?? 5
  const allowTestFilesInEditSet = taskExplicitlyTargetsTests(retrieval.question)
  const risk = riskMap(graph, {
    question: retrieval.question,
    budget: options.budget,
    limit,
    fileType: 'code',
    taskKind: 'implement',
    taskIntent: options.taskIntent,
  })
  const workflow_centers = workflowCenters(graph, retrieval, rootPath, limit)
  const starterFiles = risk.starter_files.map((entry) => createImplementationPackFileHint(
    entry.path,
    entry.score,
    entry.why,
    entry.matched_symbols,
    ['seed'],
  ))
  const likely_edit_files = mergeLikelyEditFiles(
    workflow_centers,
    starterFiles,
    rootPath,
    allowTestFilesInEditSet,
    limit,
    retrieval.question,
  )
  const likely_test_files = likelyTestFiles(graph, retrieval, likely_edit_files, rootPath, limit)
  const editPaths = new Set(likely_edit_files.map((entry) => entry.path))
  const { contracts_and_public_surfaces, existing_patterns } = buildSurfaceHints(
    graph,
    retrieval,
    editPaths,
    workflow_centers,
    rootPath,
  )
  const validation = validationCommands(rootPath, likely_test_files)
  const risk_boundaries: ImplementationPackRiskBoundary[] = risk.top_risks
  const retrieval_pipeline = retrievalPipeline(
    retrieval,
    workflow_centers,
    likely_edit_files,
    likely_test_files,
    contracts_and_public_surfaces,
    existing_patterns,
    rootPath,
  )
  const summary = likely_edit_files[0]
    ? `Start with ${likely_edit_files[0].path}, then validate the highest-risk shared boundaries before finishing.`
    : risk.summary
  const runtimeContextIfRelevant = runtimeContext(retrieval.execution_slice, retrieval.answer_contract)

  return {
    summary,
    retrieval_pipeline,
    workflow_centers,
    likely_edit_files,
    likely_test_files,
    contracts_and_public_surfaces,
    existing_patterns,
    risk_boundaries,
    validation_commands: validation.commands,
    acceptance_criteria_summary: acceptanceCriteriaSummary(
      retrieval.question,
      likely_edit_files,
      likely_test_files,
      risk_boundaries,
      contracts_and_public_surfaces,
    ),
    cautions: cautionMessages(
      retrieval,
      risk_boundaries,
      validation.warnings,
      likely_test_files,
      workflow_centers,
      likely_edit_files,
    ),
    ...(runtimeContextIfRelevant ? { runtime_context_if_relevant: runtimeContextIfRelevant } : {}),
  }
}
