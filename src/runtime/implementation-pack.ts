import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  ContextPackExecutionSlice,
  ContextPackRuntimeGenerationAnswerContract,
  ContextPackWorkflowCenter,
  ImplementationPackFileHint,
  ImplementationPackGuidance,
  ImplementationPackRiskBoundary,
  ImplementationPackSurfaceHint,
} from '../contracts/context-pack.js'
import type { KnowledgeGraph } from '../contracts/graph.js'
import type { TaskIntentKind } from '../contracts/task-intent.js'
import { classifySourceDomain } from '../shared/source-discovery.js'
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
const WORKFLOW_EDGE_RELATIONS = new Set(['calls', 'controller_route', 'depends_on', 'imports_from', 'enqueues_job'])

type PackageScripts = Record<string, string>

interface BuildImplementationPackOptions {
  budget: number
  taskIntent: TaskIntentKind
  limit?: number
}

interface FileAggregate {
  path: string
  direct_symbols: string[]
  related_symbols: string[]
}

interface WorkflowNodeCandidate {
  node_id: string
  label: string
  source_file: string
  node_kind?: string
  framework_role?: string
  match_score: number
  relevance_band: 'direct' | 'related'
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
  matchedSymbolSet: Set<string>
  bestNodeScore: number
  bestNonHelperLabel?: string
  bestNonHelperScore: number
}

function rootPathFromGraph(graph: KnowledgeGraph): string | undefined {
  return typeof graph.graph.root_path === 'string' && graph.graph.root_path.trim().length > 0
    ? graph.graph.root_path.trim()
    : undefined
}

function pushUnique(values: string[], seen: Set<string>, value: string | undefined): void {
  if (!value || value.length === 0 || seen.has(value)) {
    return
  }
  seen.add(value)
  values.push(value)
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
    byNodeId.set(node.node_id, {
      node_id: node.node_id,
      label: node.label,
      source_file: node.source_file,
      ...(node.node_kind ? { node_kind: node.node_kind } : {}),
      ...(node.framework_role ? { framework_role: node.framework_role } : {}),
      match_score: node.match_score,
      relevance_band: node.relevance_band === 'direct' ? 'direct' : 'related',
    })
  }

  for (const node of retrieval.matched_nodes) {
    if (!node.node_id || node.relevance_band !== 'direct') {
      continue
    }

    for (const predecessorId of graph.predecessors(node.node_id)) {
      const relation = graphRelation(graph, predecessorId, node.node_id)
      if (!WORKFLOW_EDGE_RELATIONS.has(relation) || byNodeId.has(predecessorId)) {
        continue
      }
      if (classifyWorkflowDomain(graph, predecessorId, rootPath) !== 'production') {
        continue
      }
      const attributes = graph.nodeAttributes(predecessorId)
      byNodeId.set(predecessorId, {
        node_id: predecessorId,
        label: String(attributes.label ?? predecessorId),
        source_file: String(attributes.source_file ?? ''),
        ...(attributes.node_kind ? { node_kind: String(attributes.node_kind) } : {}),
        ...(attributes.framework_role ? { framework_role: String(attributes.framework_role) } : {}),
        match_score: Math.max(0.1, node.match_score * 0.35),
        relevance_band: 'related',
      })
    }

    for (const successorId of graph.successors(node.node_id)) {
      const relation = graphRelation(graph, node.node_id, successorId)
      if (!WORKFLOW_EDGE_RELATIONS.has(relation) || byNodeId.has(successorId)) {
        continue
      }
      if (classifyWorkflowDomain(graph, successorId, rootPath) !== 'production') {
        continue
      }
      const attributes = graph.nodeAttributes(successorId)
      byNodeId.set(successorId, {
        node_id: successorId,
        label: String(attributes.label ?? successorId),
        source_file: String(attributes.source_file ?? ''),
        ...(attributes.node_kind ? { node_kind: String(attributes.node_kind) } : {}),
        ...(attributes.framework_role ? { framework_role: String(attributes.framework_role) } : {}),
        match_score: Math.max(0.1, node.match_score * 0.25),
        relevance_band: 'related',
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
      matchedSymbolSet: new Set<string>(),
      bestNodeScore: Number.NEGATIVE_INFINITY,
      bestNonHelperScore: Number.NEGATIVE_INFINITY,
    }

    current.score += scoreDetails.score
    if (candidate.relevance_band === 'direct') {
      current.direct_matches += 1
    }
    pushUnique(current.matched_symbols, current.matchedSymbolSet, candidate.label)
    for (const reason of scoreDetails.reasons) {
      pushUnique(current.reasons, current.reasonSet, reason)
    }
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
      if (entry.direct_matches > 1) {
        entry.score += 0.5
        pushUnique(entry.reasons, entry.reasonSet, `Multiple direct matches converge in ${entry.path}.`)
      }
      const reason = entry.reasons.slice(0, 3).join(' ')
      return {
        label: entry.bestNonHelperLabel ?? entry.label,
        path: entry.path,
        score: Math.round(entry.score * 100) / 100,
        reasons: entry.reasons.slice(0, 4),
        matched_symbols: entry.matched_symbols,
        reason: reason.length > 0 ? reason : 'Structural and lexical signals both point to this file.',
      } satisfies ContextPackWorkflowCenter
    })
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0)
      || (right.reasons?.length ?? 0) - (left.reasons?.length ?? 0)
      || left.path!.localeCompare(right.path!))
    .slice(0, limit)
}

function mergeLikelyEditFiles(
  workflowCentersValue: readonly ContextPackWorkflowCenter[],
  starterFiles: readonly ImplementationPackFileHint[],
  limit: number,
): ImplementationPackFileHint[] {
  const results: ImplementationPackFileHint[] = []
  const seen = new Set<string>()
  const starterByPath = new Map(starterFiles.map((entry) => [entry.path, entry] as const))

  for (const center of workflowCentersValue) {
    if (!center.path || seen.has(center.path)) {
      continue
    }
    const existing = starterByPath.get(center.path)
    const matchedSymbols = [...new Set([
      ...(center.matched_symbols ?? []),
      ...(existing?.matched_symbols ?? []),
    ])]
    results.push({
      path: center.path,
      why: center.reason,
      matched_symbols: matchedSymbols.length > 0 ? matchedSymbols : [center.label],
    })
    seen.add(center.path)
    if (results.length >= limit) {
      return results
    }
  }

  for (const entry of starterFiles) {
    if (seen.has(entry.path)) {
      continue
    }
    results.push(entry)
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
): ImplementationPackFileHint[] {
  const byPath = new Map<string, FileAggregate>()

  for (const node of nodes) {
    if (node.source_file.length === 0 || node.relevance_band === 'peripheral') {
      continue
    }

    const path = relativizeSourceFile(node.source_file, rootPath)
    const existing = byPath.get(path) ?? {
      path,
      direct_symbols: [],
      related_symbols: [],
    }
    if (node.relevance_band === 'direct') {
      if (!existing.direct_symbols.includes(node.label)) {
        existing.direct_symbols.push(node.label)
      }
    } else if (!existing.related_symbols.includes(node.label)) {
      existing.related_symbols.push(node.label)
    }
    byPath.set(path, existing)
  }

  return [...byPath.values()].map((entry) => ({
    path: entry.path,
    why: entry.direct_symbols.length > 0
      ? `Direct evidence via ${entry.direct_symbols.slice(0, 3).join(', ')}.`
      : `Supporting context via ${entry.related_symbols.slice(0, 2).join(', ')}.`,
    matched_symbols: [...entry.direct_symbols, ...entry.related_symbols],
  }))
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
  })
}

function buildSurfaceHints(
  retrieval: RetrieveResult,
  editPaths: ReadonlySet<string>,
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
      pushSurfaceHint(surfaceSeen, contracts_and_public_surfaces, node, 'contract', 'Changing this contract can affect implementation callers.', rootPath)
      continue
    }

    if (isPublicSurfaceNode(node)) {
      pushSurfaceHint(surfaceSeen, contracts_and_public_surfaces, node, 'public_surface', 'This is part of the public entry surface touched by the task.', rootPath)
      continue
    }

    if (!editPaths.has(sourceFile)) {
      pushSurfaceHint(patternSeen, existing_patterns, node, 'pattern', 'Existing implementation context worth checking before editing.', rootPath)
    }
  }

  return {
    contracts_and_public_surfaces: contracts_and_public_surfaces.slice(0, 6),
    existing_patterns: existing_patterns.slice(0, 5),
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
    commands.push(`npm run test:run -- ${testFiles.slice(0, 5).join(' ')}`)
  }
  if (Object.hasOwn(scripts, 'test:run')) {
    commands.push('npm run test:run')
  } else if (Object.hasOwn(scripts, 'test')) {
    commands.push('npm run test')
  }
  return commands
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
  const risk = riskMap(graph, {
    question: retrieval.question,
    budget: options.budget,
    limit,
    fileType: 'code',
    taskKind: 'implement',
    taskIntent: options.taskIntent,
  })
  const workflow_centers = workflowCenters(graph, retrieval, rootPath, limit)
  const likely_edit_files = mergeLikelyEditFiles(
    workflow_centers,
    risk.starter_files.map((entry) => ({
      path: entry.path,
      why: entry.why,
      matched_symbols: entry.matched_symbols,
    })),
    limit,
  )
  const relatedTestNodes = coveredTestNodes(graph, retrieval, rootPath)
  const likely_test_files = groupFiles(
    [
      ...retrieval.matched_nodes.filter((node) => classifySourceDomain(node.source_file, rootPath) === 'test'),
      ...relatedTestNodes,
    ],
    rootPath,
  ).slice(0, limit)
  const editPaths = new Set(likely_edit_files.map((entry) => entry.path))
  const { contracts_and_public_surfaces, existing_patterns } = buildSurfaceHints(retrieval, editPaths, rootPath)
  const validation = validationCommands(rootPath, likely_test_files)
  const risk_boundaries: ImplementationPackRiskBoundary[] = risk.top_risks
  const summary = likely_edit_files[0]
    ? `Start with ${likely_edit_files[0].path}, then validate the highest-risk shared boundaries before finishing.`
    : risk.summary
  const runtimeContextIfRelevant = runtimeContext(retrieval.execution_slice, retrieval.answer_contract)

  return {
    summary,
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
    cautions: cautionMessages(retrieval, risk_boundaries, validation.warnings, likely_test_files),
    ...(runtimeContextIfRelevant ? { runtime_context_if_relevant: runtimeContextIfRelevant } : {}),
  }
}
