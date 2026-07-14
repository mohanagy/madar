import type {
  ContextPackSliceAnchor,
  ContextPackSliceMetadata,
  ContextPackSlicePath,
} from '../../contracts/context-pack.js'
import type { KnowledgeGraph } from '../../contracts/graph.js'
import type {
  RetrievalGenerationIntent,
  RetrievalIntent,
  RetrievalTargetDomainHint,
} from '../../contracts/retrieval-gate.js'
import type { RuntimeProofProfile } from '../../contracts/runtime-proof.js'
import { classifySourceDomain, isPollutedSourcePath } from '../../shared/source-discovery.js'
import { relativizeSourceFile } from '../../shared/source-path.js'
import { requireDirectedGraph } from '../direction.js'
import {
  buildRuntimeProofAssessment,
  runtimeProofAnchorBonus,
  runtimeProofObligationMatchScore,
  runtimeProofProvidesDirectEvidence,
} from '../runtime-proof.js'

export interface SliceScoredNode {
  id: string
  label: string
  sourceFile: string
  nodeKind?: string | undefined
  frameworkRole?: string | undefined
  exactLabelMatch: boolean
  literalPathMatch?: boolean
  sourcePathMatch: boolean
  score: number
}

interface SliceOptions {
  prompt?: string | undefined
  generationIntent?: RetrievalGenerationIntent | undefined
  targetDomainHint?: RetrievalTargetDomainHint | undefined
  runtimeProofProfile?: RuntimeProofProfile | undefined
  mentionedSymbols?: readonly string[] | undefined
  excludedDomains?: readonly string[] | undefined
  excludedTerms?: readonly string[] | undefined
  excludedPathHints?: readonly string[] | undefined
  rootPath?: string | undefined
}

function sliceNodeFromGraph(graph: KnowledgeGraph, nodeId: string): SliceScoredNode {
  const attributes = graph.nodeAttributes(nodeId)
  return {
    id: nodeId,
    label: String(attributes.label ?? nodeId),
    sourceFile: String(attributes.source_file ?? ''),
    nodeKind: typeof attributes.node_kind === 'string' ? attributes.node_kind : undefined,
    frameworkRole: typeof attributes.framework_role === 'string' ? attributes.framework_role : undefined,
    exactLabelMatch: false,
    literalPathMatch: false,
    sourcePathMatch: false,
    score: 0.25,
  }
}

type SliceMode = ContextPackSliceMetadata['mode']

interface SlicePolicy {
  mode: SliceMode
  directions: Array<'forward' | 'backward'>
  backward_relations: ReadonlySet<string>
  forward_relations: ReadonlySet<string>
  backward_depth: number
  forward_depth: number
  helper_relations: ReadonlySet<string>
  runtime_flow_only?: boolean
}

const EXPLAIN_BACKWARD = new Set(['calls', 'enqueues_job', 'controller_route', 'route_handler'])
const EXPLAIN_FORWARD = new Set(['calls', 'enqueues_job', 'contains', 'method', 'route_handler', 'controller_route'])
const DEBUG_BACKWARD = new Set(['calls', 'enqueues_job', 'controller_route', 'route_handler'])
const DEBUG_FORWARD = new Set(['calls', 'enqueues_job', 'contains', 'method', 'route_handler', 'controller_route'])
const IMPACT_BACKWARD = new Set(['calls', 'enqueues_job', 'controller_route', 'route_handler'])
const IMPACT_FORWARD = new Set(['calls', 'enqueues_job', 'contains', 'method', 'route_handler', 'controller_route'])
const DEBUG_HELPERS = new Set(['uses_guard', 'guarded_by', 'reads_env', 'uses_config', 'depends_on', 'covered_by', 'injects'])
const EXPLAIN_HELPERS = new Set(['covered_by', 'reads_env', 'uses_config'])
const IMPACT_HELPERS = new Set(['covered_by', 'reads_env', 'uses_config', 'depends_on', 'exports'])
const RUNTIME_FLOW_RELATIONS = ['calls', 'enqueues_job'] as const
const STRICT_RUNTIME_PROOF_FLOW_RELATIONS = new Set([
  ...RUNTIME_FLOW_RELATIONS,
  'controller_route',
  'route_handler',
  'method',
]) as ReadonlySet<string>
const STRICT_RUNTIME_PROOF_EXCLUDED_DOMAINS = new Set([
  'test',
  'benchmark',
  'fixture',
  'docs',
  'config',
  'build_artifact',
]) as ReadonlySet<string>

function promptMentionsCronFlow(prompt: string | undefined): boolean {
  if (!prompt) {
    return false
  }

  return /\bcron\b/i.test(prompt)
}

function strictRuntimeProofOffPathCronNode(node: SliceScoredNode, options: SliceOptions): boolean {
  if (promptMentionsCronFlow(options.prompt)) {
    return false
  }

  const normalizedSourceFile = relativizeSourceFile(node.sourceFile, options.rootPath).replace(/\\/g, '/').toLowerCase()
  const normalizedLabel = node.label.toLowerCase()
  return /(?:^|\/)cron(?:\/|$)/.test(normalizedSourceFile)
    || /\bcron\b/.test(normalizedLabel)
}

function policyForIntent(intent: RetrievalIntent): SlicePolicy {
  switch (intent) {
    case 'debug':
      return {
        mode: 'debug',
        directions: ['backward', 'forward'],
        backward_relations: DEBUG_BACKWARD,
        forward_relations: DEBUG_FORWARD,
        backward_depth: 1,
        forward_depth: 1,
        helper_relations: DEBUG_HELPERS,
      }
    case 'impact':
      return {
        mode: 'impact',
        directions: ['backward', 'forward'],
        backward_relations: IMPACT_BACKWARD,
        forward_relations: IMPACT_FORWARD,
        backward_depth: 2,
        forward_depth: 1,
        helper_relations: IMPACT_HELPERS,
      }
    case 'review':
      return {
        mode: 'review',
        directions: ['backward', 'forward'],
        backward_relations: IMPACT_BACKWARD,
        forward_relations: IMPACT_FORWARD,
        backward_depth: 1,
        forward_depth: 1,
        helper_relations: IMPACT_HELPERS,
      }
    case 'explain':
    default:
      return {
        mode: 'explain',
        directions: ['backward', 'forward'],
        backward_relations: EXPLAIN_BACKWARD,
        forward_relations: EXPLAIN_FORWARD,
        backward_depth: 1,
        forward_depth: 1,
        helper_relations: EXPLAIN_HELPERS,
      }
  }
}

function promptWantsRuntimePipeline(prompt: string | undefined): boolean {
  if (!prompt) {
    return false
  }

  return /\b(runtime|pipeline|service|orchestrator|job|agent|scoring|report(?: builder)?|persistence|repository|generat(?:e|ed|es|ing|ion)|create|created)\b/i.test(prompt)
}

function promptWantsReportGenerationCore(prompt: string | undefined): boolean {
  if (!prompt) {
    return false
  }

  return /\b(?:report(?:\s+generation)?|generated\s+report|validation\s+report|final\s+report|assembly|assemble|synthesis|renderer|render|planner|research|metrics?|scor(?:e|ing)|quality(?:\s|-)?gate)\b/i.test(prompt)
}

function promptMentionsHttpRoute(prompt: string | undefined): boolean {
  if (!prompt) {
    return false
  }

  return /\b(?:get|post|put|patch|delete|head|options)\b\s+\/[^\s`'")]+/i.test(prompt)
}

function methodLikeNode(node: SliceScoredNode): boolean {
  return node.nodeKind?.toLowerCase() === 'method'
    || /(?:[.#:]|^\.)[A-Za-z_$][\w$]*\(?\)?$/u.test(node.label)
    || /^[A-Za-z_$][\w$]*\(\)$/u.test(node.label)
}

function methodNameFromLabel(label: string): string | undefined {
  const trimmed = label.trim().replace(/`/g, '').replace(/\(\)$/, '')
  const qualified = trimmed.match(/(?:\.|#|::)([A-Za-z_$][\w$]*)$/)
  if (qualified?.[1]) {
    return qualified[1].toLowerCase()
  }
  const dotted = trimmed.match(/^\.([A-Za-z_$][\w$]*)$/)
  if (dotted?.[1]) {
    return dotted[1].toLowerCase()
  }
  return undefined
}

function effectivePolicy(
  intent: RetrievalIntent,
  anchors: readonly ContextPackSliceAnchor[],
  anchorNodes: readonly SliceScoredNode[],
  options: SliceOptions,
): SlicePolicy {
  const base = policyForIntent(intent)
  const hasMethodAnchor = anchorNodes.some((anchor) => methodLikeNode(anchor))
  const hasExactMethodAnchor = anchors.some((anchor, index) => {
    const node = anchorNodes[index]
    return node !== undefined
      && methodLikeNode(node)
      && (anchor.reason === 'symbol mention' || anchor.reason === 'path mention')
  })
  const pipelinePrompt = promptWantsRuntimePipeline(options.prompt)
  const broadRuntimeGeneration = options.generationIntent === 'runtime_generation'
    && options.targetDomainHint === 'backend_runtime'
    && !hasExactMethodAnchor
  const hasGenerationCoreAnchor = anchors.some((anchor) => anchor.reason === 'generation core heuristic')

  if (!hasMethodAnchor && !pipelinePrompt) {
    return base
  }

  if (broadRuntimeGeneration && pipelinePrompt && hasGenerationCoreAnchor && promptWantsReportGenerationCore(options.prompt)) {
    return {
      ...base,
      directions: ['backward', 'forward'],
      backward_relations: new Set(['calls', 'enqueues_job', 'controller_route', 'route_handler', 'method']),
      forward_relations: new Set(RUNTIME_FLOW_RELATIONS),
      helper_relations: new Set(['injects', 'depends_on', 'module_provides']),
      backward_depth: Math.max(base.backward_depth, 3),
      forward_depth: Math.max(base.forward_depth, 4),
      runtime_flow_only: true,
    }
  }

  if (broadRuntimeGeneration && hasMethodAnchor && pipelinePrompt) {
    return {
      ...base,
      directions: ['backward', 'forward'],
      backward_relations: new Set(['controller_route', 'route_handler', 'method']),
      forward_relations: new Set(RUNTIME_FLOW_RELATIONS),
      helper_relations: new Set(['injects', 'depends_on', 'module_provides']),
      backward_depth: 1,
      forward_depth: Math.max(base.forward_depth, 4),
      runtime_flow_only: true,
    }
  }

  if (broadRuntimeGeneration && pipelinePrompt) {
    return {
      ...base,
      backward_relations: new Set(['controller_route', 'route_handler', 'method']),
      forward_relations: new Set([...base.forward_relations, ...RUNTIME_FLOW_RELATIONS]),
      helper_relations: new Set([
        ...base.helper_relations,
        'injects',
        'depends_on',
        'module_provides',
      ]),
      backward_depth: 1,
      forward_depth: Math.max(base.forward_depth, 5),
    }
  }

  if (hasExactMethodAnchor && pipelinePrompt) {
    return {
      ...base,
      backward_relations: new Set(['controller_route', 'route_handler', 'method']),
      forward_relations: new Set(RUNTIME_FLOW_RELATIONS),
      helper_relations: new Set([
        ...base.helper_relations,
        'injects',
        'depends_on',
        'module_provides',
      ]),
      backward_depth: 1,
      forward_depth: Math.max(base.forward_depth, 4),
      runtime_flow_only: true,
    }
  }

  const forwardRelations = new Set(base.forward_relations)
  if (hasMethodAnchor) {
    forwardRelations.delete('contains')
    forwardRelations.delete('method')
  }

  const helperRelations = new Set(base.helper_relations)
  if (pipelinePrompt) {
    helperRelations.add('injects')
    helperRelations.add('depends_on')
    helperRelations.add('module_provides')
  }

  return {
    ...base,
    forward_relations: forwardRelations,
    helper_relations: helperRelations,
    backward_depth: pipelinePrompt ? Math.max(base.backward_depth, 3) : base.backward_depth,
    forward_depth: pipelinePrompt ? Math.max(base.forward_depth, 3) : base.forward_depth,
  }
}

function isBarrelLike(label: string, sourceFile: string): boolean {
  return label.trim().toLowerCase() === 'index.ts' || /(?:^|\/)index\.ts$/i.test(sourceFile.replace(/\\/g, '/'))
}

function broadRuntimeGenerationPrompt(options: SliceOptions): boolean {
  return options.generationIntent === 'runtime_generation'
    && options.targetDomainHint === 'backend_runtime'
    && promptWantsRuntimePipeline(options.prompt)
}

function promptAllowsScriptMigration(options: SliceOptions): boolean {
  const prompt = options.prompt ?? ''
  return /\b(?:scripts?|migrat(?:e|ed|es|ing|ion)|backfill|cli|one-off|repair|old pipeline|seed(?:ing|ers?)|seeds?\s+(?:data|db|database|scripts?|files?))\b/i.test(prompt)
}

function scriptMigrationLikeNode(node: SliceScoredNode, rootPath?: string): boolean {
  const normalizedSourceFile = relativizeSourceFile(node.sourceFile, rootPath).replace(/\\/g, '/')
  return /(?:^|\/)(?:scripts?|migrations?|seeds?|backfills?)(?:\/|$)|\b(?:migrate|migration|backfill|seed)\b/i.test(normalizedSourceFile)
    || /\b(?:migrate|migration|backfill|seed)\b/i.test(node.label)
}

function routeOrControllerLikeNode(node: SliceScoredNode): boolean {
  const lower = `${node.label} ${node.nodeKind ?? ''} ${node.frameworkRole ?? ''} ${node.sourceFile.replace(/\\/g, '/')}`.toLowerCase()
  return /\b(?:route|controller|nest_route|nest_controller)\b/.test(lower)
    || /(?:^|\/)(?:controllers?|interface\/http)(?:\/|$)/.test(lower)
}

function routeLikeNode(node: SliceScoredNode): boolean {
  const lower = `${node.label} ${node.nodeKind ?? ''} ${node.frameworkRole ?? ''}`.toLowerCase()
  return /\b(?:route|nest_route|express_route|route_handler)\b/.test(lower)
    || /^(?:get|post|put|patch|delete|head|options)\s+\//i.test(node.label)
}

function frontendDisplayLikeNode(node: SliceScoredNode): boolean {
  const lower = `${node.label} ${node.nodeKind ?? ''} ${node.frameworkRole ?? ''} ${node.sourceFile}`.toLowerCase()
  return /\.(?:tsx|jsx)\b/.test(lower)
    || /\b(?:platform|frontend|front-end|client|ui|components?|pages?|views?|display|render|footer|header|label|date|timestamp)\b/.test(lower)
}

function runtimeGenerationAnchorValue(node: SliceScoredNode): number {
  const lower = `${node.label} ${node.nodeKind ?? ''} ${node.frameworkRole ?? ''} ${node.sourceFile}`.toLowerCase()
  let value = 0

  if (/\b(?:constructor|logger|log)\b|\.log\(/.test(lower)) {
    return -10
  }
  if (methodLikeNode(node)) value += 1
  if (/\b(?:nest_route|route|controller)\b/.test(lower)) value += 5
  if (/\b(?:src|server|backend|api|modules)\b/.test(lower)) value += 1
  if (/\b(?:generate|generation|create|start|pipeline|queue|process|orchestrator|worker|job|repository|save|report|scoring|research|agent)\b/.test(lower)) value += 2
  if (/(?:^|[.#])(?:generate|create|start|process|save|score|search|update|claim|cancel)[A-Za-z_$\w]*\(?\)?$/i.test(node.label)) value += 3
  if (/\b(?:service|provider|repository|queue|worker|orchestrator)\b/.test(lower)) value += 1
  if (frontendDisplayLikeNode(node)) value -= 6

  return value
}

function strictRuntimeProofAnchorExcluded(node: SliceScoredNode, options: SliceOptions): boolean {
  const sourceDomain = classifySourceDomain(node.sourceFile, options.rootPath)
  if (STRICT_RUNTIME_PROOF_EXCLUDED_DOMAINS.has(sourceDomain)) {
    return true
  }
  if (strictRuntimeProofOffPathCronNode(node, options)) {
    return true
  }
  if (isPollutedSourcePath(node.sourceFile, options.rootPath)) {
    return true
  }
  const normalizedSourceFile = relativizeSourceFile(node.sourceFile, options.rootPath).replace(/\\/g, '/').toLowerCase()
  return /(?:^|\/)(?:examples?|samples?|demos?|playground)(?:\/|$)|\.(?:png|jpe?g|gif|webp|svg)$/i.test(normalizedSourceFile)
}

function runtimeProofCandidateFromSliceNode(node: SliceScoredNode): {
  label: string
  source_file: string
  line_number: number
  node_kind?: string | undefined
  framework_role?: string | undefined
} {
  return {
    label: node.label,
    source_file: node.sourceFile,
    line_number: 0,
    ...(node.nodeKind ? { node_kind: node.nodeKind } : {}),
    ...(node.frameworkRole ? { framework_role: node.frameworkRole } : {}),
  }
}

function runtimeProofCandidateFromGraphNode(graph: KnowledgeGraph, nodeId: string): {
  label: string
  source_file: string
  line_number: number
  node_kind?: string | undefined
  framework_role?: string | undefined
} {
  const attributes = graph.nodeAttributes(nodeId)
  return {
    label: String(attributes.label ?? nodeId),
    source_file: String(attributes.source_file ?? ''),
    line_number: 0,
    ...(typeof attributes.node_kind === 'string' ? { node_kind: attributes.node_kind } : {}),
    ...(typeof attributes.framework_role === 'string' ? { framework_role: attributes.framework_role } : {}),
  }
}

function strictRuntimeProofAnchorBaseScore(node: SliceScoredNode, profile: RuntimeProofProfile): number {
  const candidate = runtimeProofCandidateFromSliceNode(node)
  const entrypointBonus = Math.max(0, ...profile.obligations
    .filter((obligation) => obligation.kind === 'entrypoint')
    .map((obligation) => runtimeProofObligationMatchScore(candidate, obligation)))
  return runtimeProofAnchorBonus(candidate, profile)
    + runtimeGenerationAnchorValue(node)
    + (entrypointBonus * 4)
    + (routeOrControllerLikeNode(node) ? 18 : 0)
    + (routeLikeNode(node) ? 10 : 0)
}

function strictRuntimeProofNeighborhood(
  graph: KnowledgeGraph,
  startId: string,
  maxDepth: number = 6,
): Array<{ nodeId: string; depth: number }> {
  const orderedNodes: Array<{ nodeId: string; depth: number }> = []
  const queue = [{ nodeId: startId, depth: 0 }]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const current = queue.shift()!
    if (seen.has(current.nodeId)) {
      continue
    }
    seen.add(current.nodeId)
    orderedNodes.push(current)
    if (current.depth >= maxDepth) {
      continue
    }

    const neighbors = [
      ...graph.predecessors(current.nodeId).map((nodeId) => ({
        nodeId,
        relation: String(graph.edgeAttributes(nodeId, current.nodeId).relation ?? 'related_to'),
      })),
      ...graph.successors(current.nodeId).map((nodeId) => ({
        nodeId,
        relation: String(graph.edgeAttributes(current.nodeId, nodeId).relation ?? 'related_to'),
      })),
    ]
      .filter((neighbor) => STRICT_RUNTIME_PROOF_FLOW_RELATIONS.has(neighbor.relation))

    for (const neighbor of neighbors) {
      if (!seen.has(neighbor.nodeId)) {
        queue.push({ nodeId: neighbor.nodeId, depth: current.depth + 1 })
      }
    }
  }

  return orderedNodes
}

function strictRuntimeProofCoverageScore(
  graph: KnowledgeGraph,
  node: SliceScoredNode,
  profile: RuntimeProofProfile,
): number {
  const neighborhood = strictRuntimeProofNeighborhood(graph, node.id)
  const assessment = buildRuntimeProofAssessment(
    profile,
    neighborhood.map(({ nodeId }) => runtimeProofCandidateFromGraphNode(graph, nodeId)),
  )
  if (!assessment) {
    return Number.NEGATIVE_INFINITY
  }

  const obligationsById = new Map(profile.obligations.map((obligation) => [obligation.id, obligation] as const))
  const closestEvidenceDepthByObligation = new Map<string, number>()
  for (const { nodeId, depth } of neighborhood) {
    const candidate = runtimeProofCandidateFromGraphNode(graph, nodeId)
    for (const obligation of profile.obligations) {
      if (!runtimeProofProvidesDirectEvidence(candidate, obligation)) {
        continue
      }
      const currentDepth = closestEvidenceDepthByObligation.get(obligation.id)
      if (currentDepth === undefined || depth < currentDepth) {
        closestEvidenceDepthByObligation.set(obligation.id, depth)
      }
    }
  }
  const coveredCount = assessment.obligations.length - assessment.missing_obligations.length
  const missingEntryCount = assessment.missing_obligations.filter((obligationId) => obligationsById.get(obligationId)?.kind === 'entrypoint').length
  const missingTerminalCount = assessment.missing_obligations.filter((obligationId) => obligationsById.get(obligationId)?.kind === 'terminal').length
  const evidenceDepthPenalty = [...closestEvidenceDepthByObligation.values()].reduce((total, depth) => total + depth, 0)

  let score = coveredCount * 180
  score -= assessment.missing_obligations.length * 260
  score -= missingEntryCount * 140
  score -= missingTerminalCount * 120
  score -= evidenceDepthPenalty * 35
  if (missingEntryCount === 0) score += 90
  if (missingTerminalCount === 0) score += 70
  if (coveredCount > 0 && evidenceDepthPenalty <= coveredCount * 2) score += 80
  if (routeOrControllerLikeNode(node)) score += 25

  return score
}

function semanticGenerationCoreAnchorValue(node: SliceScoredNode, prompt: string | undefined): number {
  const lower = `${node.label} ${node.nodeKind ?? ''} ${node.frameworkRole ?? ''} ${node.sourceFile}`.toLowerCase()
  let value = runtimeGenerationAnchorValue(node)

  if (!promptWantsReportGenerationCore(prompt)) {
    return value
  }

  if (routeOrControllerLikeNode(node)) value -= 7
  if (/\b(?:title|status|guard|auth|interceptor|refund|suggest|list|health|planenforcement)\b/.test(lower)) value -= 4
  if (/\b(?:planner|plan\b)\b/.test(lower)) value += 11
  if (/\b(?:assembly|assemble|quality(?:-| )gate|renderer|render|synthesis|final(?:-| )report)\b/.test(lower)) value += 10
  if (/\b(?:research|extract|metrics?|scor(?:e|ing))\b/.test(lower)) value += 7
  if (/\b(?:orchestrator|pipeline)\b/.test(lower)) value += 4
  if (/\b(?:worker|section)\b/.test(lower)) value += 2
  if (/\b(?:persist|repository|db(?:-| )sync|save)\b/.test(lower)) value += 3
  if (/\b(?:index\.json|state)\b/.test(lower)) value += 2

  return value
}

function runtimeFlowRelationPriority(
  relation: string,
  node: SliceScoredNode,
  runtimeFlowOnly: boolean,
): number {
  if (!runtimeFlowOnly) {
    return 0
  }

  let value = relation === 'enqueues_job' ? 3 : relation === 'calls' ? 2 : 0
  if (highValueRuntimeExpansionNode(node)) value += 2
  else if (pipelineBridgeLikeNode(node)) value += 1
  return value
}

function displayRenderingAnchorValue(node: SliceScoredNode): number {
  const lower = `${node.label} ${node.nodeKind ?? ''} ${node.frameworkRole ?? ''} ${node.sourceFile}`.toLowerCase()
  let value = 0

  if (frontendDisplayLikeNode(node)) value += 3
  if (methodLikeNode(node)) value += 1
  if (/\b(?:generated|date|display|render|footer|label|component)\b/.test(lower)) value += 2
  if ((node.nodeKind ?? '').toLowerCase() === 'interface') value -= 2

  return value
}

function shouldSuppressNode(
  graph: KnowledgeGraph,
  node: SliceScoredNode,
  anchoredIds: ReadonlySet<string>,
  options: SliceOptions,
): boolean {
  if (anchoredIds.has(node.id)) {
    return false
  }

  const sourceDomain = classifySourceDomain(node.sourceFile, options.rootPath)
  if (options.runtimeProofProfile?.strict_runtime_proof && STRICT_RUNTIME_PROOF_EXCLUDED_DOMAINS.has(sourceDomain)) {
    return true
  }
  if (options.runtimeProofProfile?.strict_runtime_proof && strictRuntimeProofOffPathCronNode(node, options)) {
    return true
  }
  if ((options.excludedDomains ?? []).includes(sourceDomain)) {
    return true
  }
  if (isPollutedSourcePath(node.sourceFile, options.rootPath)) {
    return true
  }
  const comparableSourceFile = relativizeSourceFile(node.sourceFile, options.rootPath).toLowerCase()
  const excludedTerms = [...(options.excludedTerms ?? []), ...(options.excludedPathHints ?? [])].map((term) => term.toLowerCase())
  if (excludedTerms.some((term) => node.label.toLowerCase().includes(term) || comparableSourceFile.includes(term))) {
    return true
  }

  if (isBarrelLike(node.label, node.sourceFile)) {
    return true
  }
  if (broadRuntimeGenerationPrompt(options) && !promptAllowsScriptMigration(options) && scriptMigrationLikeNode(node, options.rootPath)) {
    return true
  }

  return graph.degree(node.id) >= 40
}

function buildAnchors(graph: KnowledgeGraph, scored: readonly SliceScoredNode[], options: SliceOptions): ContextPackSliceAnchor[] {
  const anchors: ContextPackSliceAnchor[] = []
  const seen = new Set<string>()
  const matchedAnchors = scored.filter((node) => node.exactLabelMatch || node.sourcePathMatch)
  const exactMethodAnchors = matchedAnchors.filter((node) => node.exactLabelMatch && methodLikeNode(node))
  const nonBarrelMatchedAnchors = matchedAnchors.filter((node) => !isBarrelLike(node.label, node.sourceFile))
  const broadRuntimeGeneration = broadRuntimeGenerationPrompt(options)
  const reportGenerationPrompt = promptWantsReportGenerationCore(options.prompt)
  const explicitPathAnchor = matchedAnchors.find((node) => node.literalPathMatch)
  const routePromptAnchors = broadRuntimeGeneration && promptMentionsHttpRoute(options.prompt)
    ? scored
      .filter((node) => routeOrControllerLikeNode(node) && !isBarrelLike(node.label, node.sourceFile) && !frontendDisplayLikeNode(node))
      .sort((left, right) => {
        const leftPriority = (routeLikeNode(left) ? 4 : 0)
          + (left.exactLabelMatch || left.literalPathMatch ? 2 : 0)
          + (left.sourcePathMatch ? 1 : 0)
        const rightPriority = (routeLikeNode(right) ? 4 : 0)
          + (right.exactLabelMatch || right.literalPathMatch ? 2 : 0)
          + (right.sourcePathMatch ? 1 : 0)
        return rightPriority - leftPriority || right.score - left.score
      })
    : []
  const semanticCoreAnchors = broadRuntimeGeneration && reportGenerationPrompt
    ? scored
      .filter((node) =>
        methodLikeNode(node)
        && !routeOrControllerLikeNode(node)
        && !isBarrelLike(node.label, node.sourceFile)
        && !frontendDisplayLikeNode(node)
        && node.score > 0,
      )
      .map((node) => ({ node, value: semanticGenerationCoreAnchorValue(node, options.prompt) }))
      .filter((entry) => entry.value > 0)
      .sort((left, right) => right.value - left.value || right.node.score - left.node.score)
      .map((entry) => entry.node)
    : []
  const runtimeProofAnchors = options.runtimeProofProfile?.strict_runtime_proof
    ? (() => {
      const anchorableNodes = scored.filter((node) => !isBarrelLike(node.label, node.sourceFile) && !frontendDisplayLikeNode(node))
      const preferredNodes = anchorableNodes.filter((node) => !strictRuntimeProofAnchorExcluded(node, options))
      const candidateNodes = preferredNodes.length > 0 ? preferredNodes : anchorableNodes
      const baseEntries = candidateNodes
        .map((node) => ({
          node,
          baseValue: strictRuntimeProofAnchorBaseScore(node, options.runtimeProofProfile!),
        }))
        .filter((entry) => entry.baseValue > 0)
      const baseSeedWindow = options.runtimeProofProfile!.strict_runtime_proof ? 64 : 24
      const seedEntriesById = new Map<string, { node: SliceScoredNode; baseValue: number }>()
      for (const entry of [...baseEntries]
        .sort((left, right) => right.baseValue - left.baseValue || right.node.score - left.node.score)
        .slice(0, baseSeedWindow)) {
        seedEntriesById.set(entry.node.id, entry)
      }

      const obligationSeedWindow = options.runtimeProofProfile!.strict_runtime_proof ? 16 : 8
      for (const obligation of options.runtimeProofProfile!.obligations) {
        for (const entry of [...baseEntries]
          .map((baseEntry) => {
            const candidate = runtimeProofCandidateFromSliceNode(baseEntry.node)
            return {
              ...baseEntry,
              directEvidenceScore: runtimeProofProvidesDirectEvidence(candidate, obligation)
                ? runtimeProofObligationMatchScore(candidate, obligation)
                : 0,
            }
          })
          .filter((entry) => entry.directEvidenceScore > 0)
          .sort((left, right) =>
            right.directEvidenceScore - left.directEvidenceScore
            || right.baseValue - left.baseValue
            || right.node.score - left.node.score
          )
          .slice(0, obligationSeedWindow)) {
          seedEntriesById.set(entry.node.id, {
            node: entry.node,
            baseValue: entry.baseValue,
          })
        }
      }

      return [...seedEntriesById.values()]
        .map((entry) => ({
          ...entry,
          coverageValue: strictRuntimeProofCoverageScore(graph, entry.node, options.runtimeProofProfile!),
        }))
        .sort((left, right) =>
          right.coverageValue - left.coverageValue
          || right.baseValue - left.baseValue
          || right.node.score - left.node.score
        )
        .map((entry) => entry.node)
    })()
    : []
  const runtimeProofEntrypointAnchors = options.runtimeProofProfile?.strict_runtime_proof
    ? runtimeProofAnchors.filter((node) => {
      const candidate = runtimeProofCandidateFromSliceNode(node)
      return options.runtimeProofProfile!.obligations.some((obligation) =>
        obligation.kind === 'entrypoint' && runtimeProofProvidesDirectEvidence(candidate, obligation)
      )
    })
    : []
  const runtimeProofFlowAnchors = options.runtimeProofProfile?.strict_runtime_proof
    ? (() => {
      const candidatesById = new Map<string, { node: SliceScoredNode; coverageValue: number; baseValue: number; upstreamValue: number; sameSourceValue: number }>()
      for (const anchorNode of runtimeProofAnchors.slice(0, 8)) {
        const predecessorIds = new Set(graph.predecessors(anchorNode.id))
        const successorIds = new Set(graph.successors(anchorNode.id))
        for (const neighborId of new Set([...predecessorIds, ...successorIds])) {
          const relation = predecessorIds.has(neighborId)
            ? String(graph.edgeAttributes(neighborId, anchorNode.id).relation ?? 'related_to')
            : successorIds.has(neighborId)
              ? String(graph.edgeAttributes(anchorNode.id, neighborId).relation ?? 'related_to')
              : 'related_to'
          if (!STRICT_RUNTIME_PROOF_FLOW_RELATIONS.has(relation)) {
            continue
          }
          const neighbor = scored.find((node) => node.id === neighborId) ?? sliceNodeFromGraph(graph, neighborId)
          if (
            !methodLikeNode(neighbor)
            || isBarrelLike(neighbor.label, neighbor.sourceFile)
            || frontendDisplayLikeNode(neighbor)
            || strictRuntimeProofAnchorExcluded(neighbor, options)
          ) {
            continue
          }
          const baseValue = strictRuntimeProofAnchorBaseScore(neighbor, options.runtimeProofProfile!)
          if (baseValue <= 0) {
            continue
          }
          const coverageValue = strictRuntimeProofCoverageScore(graph, neighbor, options.runtimeProofProfile!)
          const upstreamValue = predecessorIds.has(neighborId) ? 40 : 0
          const sameSourceValue = relativizeSourceFile(neighbor.sourceFile, options.rootPath)
            === relativizeSourceFile(anchorNode.sourceFile, options.rootPath)
            ? 80
            : 0
          const current = candidatesById.get(neighbor.id)
          if (
            !current
            || sameSourceValue + upstreamValue > current.sameSourceValue + current.upstreamValue
            || (
              sameSourceValue + upstreamValue === current.sameSourceValue + current.upstreamValue
              && (
                coverageValue > current.coverageValue
                || (coverageValue === current.coverageValue && baseValue > current.baseValue)
              )
            )
          ) {
            candidatesById.set(neighbor.id, { node: neighbor, coverageValue, baseValue, upstreamValue, sameSourceValue })
          }
        }
      }
      return [...candidatesById.values()]
        .sort((left, right) =>
          (right.sameSourceValue + right.upstreamValue) - (left.sameSourceValue + left.upstreamValue)
          || right.coverageValue - left.coverageValue
          || right.baseValue - left.baseValue
          || right.node.score - left.node.score
        )
        .map((entry) => entry.node)
    })()
    : []
  const intentAnchors = (() => {
    if (options.generationIntent === 'runtime_generation' && options.targetDomainHint === 'backend_runtime') {
      return matchedAnchors
        .filter((node) => methodLikeNode(node) && !isBarrelLike(node.label, node.sourceFile) && !frontendDisplayLikeNode(node))
        .map((node) => ({ node, value: runtimeGenerationAnchorValue(node) }))
        .filter((entry) => entry.value > 0)
        .sort((left, right) => right.value - left.value || right.node.score - left.node.score)
        .map((entry) => entry.node)
    }

    if (options.generationIntent === 'display_rendering' && options.targetDomainHint === 'frontend_display') {
      return matchedAnchors
        .filter((node) => !isBarrelLike(node.label, node.sourceFile) && frontendDisplayLikeNode(node))
        .map((node) => ({ node, value: displayRenderingAnchorValue(node) }))
        .filter((entry) => entry.value > 0)
        .sort((left, right) => right.value - left.value || right.node.score - left.node.score)
        .map((entry) => entry.node)
    }

    return []
  })()
  const generationCoreAnchorIds = new Set<string>()
  let anchorPool: SliceScoredNode[]
  if (exactMethodAnchors.length > 0) {
    anchorPool = exactMethodAnchors.slice(0, 1)
  } else if (explicitPathAnchor) {
    anchorPool = [explicitPathAnchor]
  } else if (runtimeProofAnchors.length > 0) {
    const runtimeProofAnchorLimit = options.runtimeProofProfile?.strict_runtime_proof
      ? Math.max(2, Math.min(3, options.runtimeProofProfile.obligations.length))
      : broadRuntimeGeneration ? 2 : 1
    const prioritizedRuntimeProofAnchors: SliceScoredNode[] = []
    const seenRuntimeProofAnchors = new Set<string>()
    const addRuntimeProofAnchor = (node: SliceScoredNode | undefined): void => {
      if (!node || seenRuntimeProofAnchors.has(node.id)) {
        return
      }
      seenRuntimeProofAnchors.add(node.id)
      prioritizedRuntimeProofAnchors.push(node)
    }
    addRuntimeProofAnchor(runtimeProofFlowAnchors[0])
    addRuntimeProofAnchor(runtimeProofEntrypointAnchors[0])
    for (const node of runtimeProofAnchors) {
      addRuntimeProofAnchor(node)
      if (prioritizedRuntimeProofAnchors.length >= runtimeProofAnchorLimit) {
        break
      }
    }
    anchorPool = prioritizedRuntimeProofAnchors
  } else if (broadRuntimeGeneration && reportGenerationPrompt && semanticCoreAnchors.length > 0) {
    const primaryRuntimeAnchor = routePromptAnchors[0]
      ?? intentAnchors[0]
      ?? nonBarrelMatchedAnchors[0]
      ?? matchedAnchors[0]
    const selected = [
      ...(primaryRuntimeAnchor ? [primaryRuntimeAnchor] : []),
      ...semanticCoreAnchors.filter((node) => node.id !== primaryRuntimeAnchor?.id).slice(0, 2),
    ]
    anchorPool = selected
    for (const node of selected) {
      if (primaryRuntimeAnchor && node.id === primaryRuntimeAnchor.id) {
        continue
      }
      generationCoreAnchorIds.add(node.id)
    }
  } else if (routePromptAnchors.length > 0) {
    anchorPool = routePromptAnchors.slice(0, 1)
  } else if (intentAnchors.length > 0) {
    anchorPool = intentAnchors.slice(0, broadRuntimeGeneration ? 1 : 2)
  } else if (matchedAnchors.length > 0) {
    anchorPool = nonBarrelMatchedAnchors.length > 0 ? nonBarrelMatchedAnchors : matchedAnchors
  } else {
    anchorPool = scored.filter((node) => !isBarrelLike(node.label, node.sourceFile)).slice(0, 1)
  }

  for (const node of anchorPool) {
    const reason = generationCoreAnchorIds.has(node.id)
      ? 'generation core heuristic'
      : node.exactLabelMatch
      ? 'symbol mention'
      : node.literalPathMatch
        ? 'path mention'
        : node.sourcePathMatch
          ? 'source path token match'
        : 'top lexical match'
    if (!reason || seen.has(node.id)) {
      continue
    }
    anchors.push({
      node_id: node.id,
      label: node.label,
      reason,
    })
    seen.add(node.id)
    const maxAnchors = options.runtimeProofProfile?.strict_runtime_proof
      ? Math.max(2, Math.min(3, options.runtimeProofProfile.obligations.length))
      : broadRuntimeGeneration && reportGenerationPrompt ? 3 : 2
    if (anchors.length >= maxAnchors) {
      break
    }
  }

  return anchors
}

function recordPath(
  paths: ContextPackSlicePath[],
  seen: Set<string>,
  path: ContextPackSlicePath,
): void {
  const key = `${path.direction}:${path.from_id ?? path.from}:${path.relation}:${path.to_id ?? path.to}`
  if (seen.has(key)) {
    return
  }
  seen.add(key)
  paths.push(path)
}

function traverseDirection(
  graph: KnowledgeGraph,
  scoredById: Map<string, SliceScoredNode>,
  anchorIds: readonly string[],
  selectedIds: Set<string>,
  orderedIds: string[],
  pathSeen: Set<string>,
  selectedPaths: ContextPackSlicePath[],
  anchoredIds: ReadonlySet<string>,
  options: SliceOptions,
  direction: 'forward' | 'backward',
  relations: ReadonlySet<string>,
  maxDepth: number,
  runtimeFlowOnly: boolean = false,
  anchorMethodNames: ReadonlySet<string> = new Set(),
): void {
  const queue = anchorIds.map((id) => ({ id, depth: 0 }))
  const seen = new Set<string>(anchorIds)
  const depths = new Map<string, number>(anchorIds.map((id) => [id, 0]))

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.depth >= maxDepth) {
      continue
    }

    const currentNode = scoredById.get(current.id) ?? sliceNodeFromGraph(graph, current.id)
    scoredById.set(current.id, currentNode)
    if (
      direction === 'forward'
      && runtimeFlowOnly
      && current.depth > 0
      && !shouldExpandRuntimePathNode(graph, currentNode, anchorMethodNames)
    ) {
      continue
    }

    const neighbors = direction === 'forward' ? graph.successors(current.id) : graph.predecessors(current.id)
    const orderedNeighbors = [...neighbors].sort((leftId, rightId) => {
      const leftSourceId = direction === 'forward' ? current.id : leftId
      const leftTargetId = direction === 'forward' ? leftId : current.id
      const leftRelation = String(graph.edgeAttributes(leftSourceId, leftTargetId).relation ?? 'related_to')
      const leftNode = scoredById.get(leftId) ?? sliceNodeFromGraph(graph, leftId)
      scoredById.set(leftId, leftNode)

      const rightSourceId = direction === 'forward' ? current.id : rightId
      const rightTargetId = direction === 'forward' ? rightId : current.id
      const rightRelation = String(graph.edgeAttributes(rightSourceId, rightTargetId).relation ?? 'related_to')
      const rightNode = scoredById.get(rightId) ?? sliceNodeFromGraph(graph, rightId)
      scoredById.set(rightId, rightNode)

      return runtimeFlowRelationPriority(rightRelation, rightNode, runtimeFlowOnly)
        - runtimeFlowRelationPriority(leftRelation, leftNode, runtimeFlowOnly)
        || rightNode.score - leftNode.score
        || graph.degree(rightId) - graph.degree(leftId)
    })

    for (const neighborId of orderedNeighbors) {
      const sourceId = direction === 'forward' ? current.id : neighborId
      const targetId = direction === 'forward' ? neighborId : current.id
      const relation = String(graph.edgeAttributes(sourceId, targetId).relation ?? 'related_to')
      if (!relations.has(relation)) {
        continue
      }

      const neighborDepth = depths.get(neighborId)
      if (neighborDepth !== undefined && neighborDepth <= current.depth) {
        continue
      }

      const neighbor = scoredById.get(neighborId) ?? sliceNodeFromGraph(graph, neighborId)
      scoredById.set(neighborId, neighbor)
      if (
        direction === 'forward'
        && runtimeFlowOnly
        && broadRuntimeGenerationPrompt(options)
        && routeOrControllerLikeNode(neighbor)
        && !anchoredIds.has(neighborId)
      ) {
        continue
      }
      if (shouldSuppressNode(graph, neighbor, anchoredIds, options)) {
        continue
      }

      if (!selectedIds.has(neighborId)) {
        selectedIds.add(neighborId)
        orderedIds.push(neighborId)
      }

      recordPath(selectedPaths, pathSeen, {
        from_id: sourceId,
        from: direction === 'forward' ? currentNode?.label ?? sourceId : neighbor.label,
        to_id: targetId,
        to: direction === 'forward' ? neighbor.label : currentNode?.label ?? targetId,
        relation,
        direction,
      })

      if (!seen.has(neighborId)) {
        seen.add(neighborId)
        depths.set(neighborId, current.depth + 1)
        queue.push({ id: neighborId, depth: current.depth + 1 })
      }
    }
  }
}

function pipelineBridgeLikeNode(node: SliceScoredNode): boolean {
  const lower = `${node.label} ${node.frameworkRole ?? ''} ${node.sourceFile}`.toLowerCase()
  return /\bpipeline|trigger|queue|job|worker|orchestrator|planner|research|agent|scoring|report|repository|persistence|save|process|search|score|addjob\b/.test(lower)
}

function highValueRuntimeExpansionNode(node: SliceScoredNode): boolean {
  const lower = `${node.label} ${node.frameworkRole ?? ''} ${node.sourceFile}`.toLowerCase()
  return /\bpipeline|trigger|queue|job|worker|orchestrator|planner|research|agent|scoring|report|repository|persistence|save|process|search|score|dispatch|assemble|persist|builder|addjob\b/.test(lower)
}

function sharedHubLikeNode(graph: KnowledgeGraph, node: SliceScoredNode): boolean {
  const lower = `${node.label} ${node.frameworkRole ?? ''}`.toLowerCase()
  return graph.degree(node.id) >= 12
    || /requireideasuserid|addjob|callllm|resolve|logger|\.info\(\)|\.error\(\)|\.warn\(\)|planenforcement/.test(lower)
}

function shouldExpandRuntimePathNode(
  graph: KnowledgeGraph,
  node: SliceScoredNode,
  anchorMethodNames: ReadonlySet<string>,
): boolean {
  if (sharedHubLikeNode(graph, node) && !highValueRuntimeExpansionNode(node)) {
    return false
  }

  if (highValueRuntimeExpansionNode(node)) {
    return true
  }

  const methodName = methodNameFromLabel(node.label)
  if (methodName && anchorMethodNames.has(methodName)) {
    return true
  }

  const role = (node.frameworkRole ?? '').toLowerCase()
  const kind = (node.nodeKind ?? '').toLowerCase()
  if (role.includes('controller') || role.includes('route') || kind === 'class') {
    return false
  }

  return false
}

function addHelperNeighbors(
  graph: KnowledgeGraph,
  scoredById: Map<string, SliceScoredNode>,
  helperRelations: ReadonlySet<string>,
  selectedIds: Set<string>,
  orderedIds: string[],
  pathSeen: Set<string>,
  selectedPaths: ContextPackSlicePath[],
  anchoredIds: ReadonlySet<string>,
  options: SliceOptions,
): void {
  for (const currentId of [...orderedIds]) {
    const currentNode = scoredById.get(currentId)
    if (!currentNode) {
      continue
    }

    for (const neighborId of graph.successors(currentId)) {
      const relation = String(graph.edgeAttributes(currentId, neighborId).relation ?? 'related_to')
      if (!helperRelations.has(relation)) {
        continue
      }

      const neighbor = scoredById.get(neighborId) ?? sliceNodeFromGraph(graph, neighborId)
      scoredById.set(neighborId, neighbor)
      if (shouldSuppressNode(graph, neighbor, anchoredIds, options)) {
        continue
      }

      if (!selectedIds.has(neighborId)) {
        selectedIds.add(neighborId)
        orderedIds.push(neighborId)
      }

      recordPath(selectedPaths, pathSeen, {
        from_id: currentId,
        from: currentNode.label,
        to_id: neighborId,
        to: neighbor.label,
        relation,
        direction: 'forward',
      })
    }
  }
}

function addAnchorPredecessors(
  graph: KnowledgeGraph,
  scoredById: Map<string, SliceScoredNode>,
  anchorIds: readonly string[],
  selectedIds: Set<string>,
  orderedIds: string[],
  pathSeen: Set<string>,
  selectedPaths: ContextPackSlicePath[],
  anchoredIds: ReadonlySet<string>,
  options: SliceOptions,
  relations: ReadonlySet<string>,
): void {
  for (const anchorId of anchorIds) {
    const anchorNode = scoredById.get(anchorId) ?? sliceNodeFromGraph(graph, anchorId)
    scoredById.set(anchorId, anchorNode)

    for (const predecessorId of graph.predecessors(anchorId)) {
      const relation = String(graph.edgeAttributes(predecessorId, anchorId).relation ?? 'related_to')
      if (!relations.has(relation)) {
        continue
      }

      const predecessor = scoredById.get(predecessorId) ?? sliceNodeFromGraph(graph, predecessorId)
      scoredById.set(predecessorId, predecessor)
      if (
        broadRuntimeGenerationPrompt(options)
        && promptWantsReportGenerationCore(options.prompt)
        && routeOrControllerLikeNode(predecessor)
        && !anchoredIds.has(predecessorId)
      ) {
        continue
      }
      if (shouldSuppressNode(graph, predecessor, anchoredIds, options)) {
        continue
      }

      if (!selectedIds.has(predecessorId)) {
        selectedIds.add(predecessorId)
        orderedIds.push(predecessorId)
      }

      recordPath(selectedPaths, pathSeen, {
        from_id: predecessorId,
        from: predecessor.label,
        to_id: anchorId,
        to: anchorNode.label,
        relation,
        direction: 'backward',
      })
    }
  }
}

export function sliceCandidatesForRetrieve(
  graph: KnowledgeGraph,
  scoredCandidates: readonly SliceScoredNode[],
  intent: RetrievalIntent,
  options: SliceOptions = {},
): { ordered_ids: string[]; metadata: ContextPackSliceMetadata } | null {
  requireDirectedGraph(graph, 'Directional retrieval')

  if (scoredCandidates.length === 0) {
    return null
  }

  const anchors = buildAnchors(graph, scoredCandidates, options)
  if (anchors.length === 0) {
    return null
  }

  const anchorNodes = anchors
    .map((anchor) => scoredCandidates.find((candidate) => candidate.id === anchor.node_id))
    .filter((candidate): candidate is SliceScoredNode => candidate !== undefined)
  const policy = effectivePolicy(intent, anchors, anchorNodes, options)
  const anchorIds = anchors.map((anchor) => anchor.node_id).filter((id): id is string => typeof id === 'string')
  const orderedIds = [...anchorIds]
  const selectedIds = new Set(anchorIds)
  const anchoredIds = new Set(anchorIds)
  const scoredById = new Map(scoredCandidates.map((candidate) => [candidate.id, candidate]))
  const selectedPaths: ContextPackSlicePath[] = []
  const pathSeen = new Set<string>()
  const anchorMethodNames = new Set(
    anchors
      .map((anchor) => methodNameFromLabel(anchor.label))
      .filter((methodName): methodName is string => typeof methodName === 'string' && methodName.length > 0),
  )

  if (policy.directions.includes('backward')) {
    traverseDirection(
      graph,
      scoredById,
      anchorIds,
      selectedIds,
      orderedIds,
      pathSeen,
      selectedPaths,
      anchoredIds,
      options,
      'backward',
      policy.backward_relations,
      policy.backward_depth,
      false,
      anchorMethodNames,
    )

    addAnchorPredecessors(
      graph,
      scoredById,
      anchorIds,
      selectedIds,
      orderedIds,
      pathSeen,
      selectedPaths,
      anchoredIds,
      options,
      policy.backward_relations,
    )
  }

  if (policy.directions.includes('forward')) {
    traverseDirection(
      graph,
      scoredById,
      anchorIds,
      selectedIds,
      orderedIds,
      pathSeen,
      selectedPaths,
      anchoredIds,
      options,
      'forward',
      policy.forward_relations,
      policy.forward_depth,
      policy.runtime_flow_only === true,
      anchorMethodNames,
    )
  }

  addHelperNeighbors(
    graph,
    scoredById,
    policy.helper_relations,
    selectedIds,
    orderedIds,
    pathSeen,
    selectedPaths,
    anchoredIds,
    options,
  )

  return {
    ordered_ids: orderedIds,
    metadata: {
      mode: policy.mode,
      anchors,
      directions: policy.directions,
      selected_paths: selectedPaths,
    },
  }
}
