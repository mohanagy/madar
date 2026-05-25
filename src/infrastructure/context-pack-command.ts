import { buildCommunityLabels } from '../pipeline/community-naming.js'
import type {
  ContextPackClaim,
  ContextPackCoverage,
  ContextPackEvidenceClass,
  ContextPackExpandableRef,
  ContextPackFormat,
  ImplementationPackGuidance,
  ContextPackNode,
  ContextPackPublicContract,
  ContextPackRoutingDebug,
  ContextPackSchemaV1,
  ContextPackWorkflowCenter,
  ContextPackRecommendedFirstRead,
} from '../contracts/context-pack.js'
import type { KnowledgeGraph } from '../contracts/graph.js'
import type { TaskContextPlan } from '../contracts/task-context-plan.js'
import type { PackCliOptions } from '../cli/parser.js'
import { classifyTaskContract, compileContextPack, estimateContextPackEntryTokens, type ContextPackNodeCandidate } from '../runtime/context-pack.js'
import type { RetrievalGateDecision } from '../contracts/retrieval-gate.js'
import { classifyRetrievalLevel } from '../runtime/retrieval-gate.js'
import { pickImpactTarget } from '../runtime/context-pack-target.js'
import { analyzeImpact, compactImpactResult, type ImpactResult } from '../runtime/impact.js'
import { analyzePrImpact, compactPrImpactResult, type PrImpactResult } from '../runtime/pr-impact.js'
import { buildTaskContextPlan } from '../runtime/task-context-planner.js'
import { resolveTaskSelection } from '../runtime/task-intent.js'
import { compactRetrieveResult, retrieveContext, type RetrieveResult } from '../runtime/retrieve.js'
import { buildImplementationPackGuidance } from '../runtime/implementation-pack.js'
import { buildRoutingDebug } from '../runtime/routing-debug.js'
import { communitiesFromGraph, loadGraph } from '../runtime/serve.js'

const DEFAULT_IMPACT_DEPTH = 3

export interface ContextPackCommandDependencies {
  loadGraph: (graphPath: string) => KnowledgeGraph
  retrieveContext: (graph: KnowledgeGraph, options: Pick<import('../runtime/retrieve.js').RetrieveOptions, 'question' | 'budget' | 'taskKind' | 'taskIntent' | 'retrievalLevel' | 'retrievalStrategy'>) => RetrieveResult
  compactRetrieveResult: typeof compactRetrieveResult
  analyzePrImpact: (graph: KnowledgeGraph, projectDir?: string, options?: { baseBranch?: string; depth?: number; budget?: number; taskIntent?: TaskContextPlan['evidence']['recipe_id'] }) => PrImpactResult
  compactPrImpactResult: typeof compactPrImpactResult
  analyzeImpact: (graph: KnowledgeGraph, communityLabels: Record<number, string>, options: { label: string; depth?: number }) => ImpactResult
  compactImpactResult: typeof compactImpactResult
}

const DEFAULT_DEPENDENCIES: ContextPackCommandDependencies = {
  loadGraph,
  retrieveContext: (graph, options) => retrieveContext(graph, options),
  compactRetrieveResult,
  analyzePrImpact,
  compactPrImpactResult,
  analyzeImpact,
  compactImpactResult,
}

interface ContextPlaneMetadata {
  claims: ContextPackClaim[]
  expandable: ContextPackExpandableRef[]
  coverage: ContextPackCoverage
  missing_context: ContextPackEvidenceClass[]
  missing_semantic: ContextPackCoverage['missing_semantic']
  retrieval_gate?: RetrievalGateDecision
}

export interface ExplainPackPayload extends ContextPlaneMetadata {
  pack: ReturnType<typeof compactRetrieveResult>
  implementation?: ImplementationPackGuidance
  routing?: ContextPackRoutingDebug
}

type RetrievePackPayload = ReturnType<typeof compactRetrieveResult>
type ReviewPackPayload = ReturnType<typeof compactPrImpactResult>
type ImpactPackPayload = ReturnType<typeof compactImpactResult>
type PackPayload = RetrievePackPayload | ReviewPackPayload | ImpactPackPayload

type PackResponseBase = ReturnType<typeof baseResponse>

type PackSchemaEnvelope<TPack extends PackPayload = PackPayload> = ContextPackSchemaV1<TPack> & PackResponseBase & {
  implementation?: ImplementationPackGuidance
  target?: string
}

function emptyCoverage(): ContextPackCoverage {
  return {
    required_evidence: [],
    semantic_required: [],
    semantic_optional: [],
    entries: [],
    semantic_entries: [],
    missing_required: [],
    missing_semantic: [],
    available_relationships: 0,
    selected_relationships: 0,
  }
}

function contextMetadata(
  payload: Partial<{
    claims: ContextPackClaim[]
    expandable: ContextPackExpandableRef[]
    coverage: ContextPackCoverage
    retrieval_gate: RetrievalGateDecision
  }>,
): ContextPlaneMetadata {
  const coverage = payload.coverage ?? emptyCoverage()
  return {
    claims: payload.claims ?? [],
    expandable: payload.expandable ?? [],
    coverage,
    missing_context: coverage.missing_required,
    missing_semantic: coverage.missing_semantic,
    ...(payload.retrieval_gate ? { retrieval_gate: payload.retrieval_gate } : {}),
  }
}

export function buildExplainPackPayload(
  pack: ReturnType<typeof compactRetrieveResult>,
  retrieval: Partial<{
    claims: ContextPackClaim[]
    expandable: ContextPackExpandableRef[]
    coverage: ContextPackCoverage
    retrieval_gate: RetrievalGateDecision
  }>,
  implementation?: ImplementationPackGuidance,
): ExplainPackPayload {
  return {
    pack,
    ...(implementation ? { implementation } : {}),
    ...contextMetadata(retrieval),
  }
}

function createImpactCandidate(
  node: {
    label: string
    source_file: string
    file_type?: string
    community?: number | null
    community_label?: string | null
    node_kind?: string
    framework_role?: string | null
  },
  evidenceClass: ContextPackEvidenceClass,
): ContextPackNodeCandidate<ContextPackNode> {
  let builtEntry: ContextPackNode | undefined
  let tokenCost: number | undefined

  const buildEntry = (): ContextPackNode => {
    if (builtEntry) {
      return builtEntry
    }

    builtEntry = {
      label: node.label,
      source_file: node.source_file,
      line_number: 0,
      snippet: null,
      ...(node.file_type ? { file_type: node.file_type } : {}),
      ...(typeof node.community === 'number' ? { community: node.community } : {}),
      ...(node.community_label !== undefined ? { community_label: node.community_label } : {}),
      ...(node.node_kind ? { node_kind: node.node_kind } : {}),
      ...(node.framework_role ? { framework_role: node.framework_role } : {}),
      evidence_class: evidenceClass,
    }
    tokenCost = estimateContextPackEntryTokens(node.label, node.source_file, 0, null)
    return builtEntry
  }

  return {
    label: node.label,
    evidence_class: evidenceClass,
    ...(node.community !== undefined ? { community: node.community } : {}),
    estimate_tokens: () => {
      if (tokenCost !== undefined) {
        return tokenCost
      }

      buildEntry()
      return tokenCost ?? 0
    },
    build_entry: buildEntry,
  }
}

function impactMetadata(
  result: ImpactResult,
  budget: number,
  prompt: string,
  taskIntent: TaskContextPlan['evidence']['recipe_id'],
  retrievalLevelOverride?: PackCliOptions['retrievalLevel'],
): ContextPlaneMetadata {
  const candidates: ContextPackNodeCandidate<ContextPackNode>[] = []

  if (result.target_file.trim().length > 0) {
    candidates.push(createImpactCandidate({
      label: result.target,
      source_file: result.target_file,
      ...(result.target_file_type ? { file_type: result.target_file_type } : {}),
    }, 'primary'))
  }

  candidates.push(
    ...result.direct_dependents.map((node) => createImpactCandidate(node, 'impact')),
    ...result.transitive_dependents.map((node) => createImpactCandidate(node, 'structural')),
  )

  const pack = compileContextPack({
    task_contract: classifyTaskContract('impact', { budget, prompt, task_intent: taskIntent }),
    nodes: candidates,
    community_context: result.affected_communities,
    retrieval_gate: classifyRetrievalLevel({
      prompt,
      ...(retrievalLevelOverride !== undefined ? { manualOverride: retrievalLevelOverride } : {}),
    }),
  })

  return contextMetadata(pack)
}

function baseResponse(
  options: PackCliOptions,
  plan: TaskContextPlan,
  budget: number,
  task: TaskContextPlan['task_kind'],
) {
  return {
    task,
    task_intent: plan.evidence.recipe_id,
    prompt: options.prompt,
    budget,
    graph_path: options.graphPath,
    plan,
  }
}

function defaultPackRetrievalStrategy(
  prompt: string,
): PackCliOptions['retrievalStrategy'] | undefined {
  const gate = classifyRetrievalLevel({
    prompt,
  })

  return gate.signals.generation_intent === 'runtime_generation'
    ? 'slice-v1'
    : undefined
}

function workflowCenters(
  task: TaskContextPlan['task_kind'],
  pack: PackPayload,
  plan: TaskContextPlan,
  implementation?: ImplementationPackGuidance,
): ContextPackWorkflowCenter[] {
  const fromCommunityContext = (
    entries: Array<{ label: string; node_count?: number }>,
    reason: string,
  ): ContextPackWorkflowCenter[] => entries.slice(0, 4).map((entry) => ({
    label: entry.label,
    ...(typeof entry.node_count === 'number' ? { node_count: entry.node_count } : {}),
    reason,
  }))

  if (task === 'implement' && implementation?.workflow_centers.length) {
    return implementation.workflow_centers.slice(0, 4)
  }

  if (
    (task === 'review' || task === 'impact')
    && 'affected_communities' in pack
    && Array.isArray(pack.affected_communities)
    && pack.affected_communities.length > 0
  ) {
    return fromCommunityContext(pack.affected_communities, task === 'review'
      ? 'Changed files and their nearby impact evidence converge here.'
      : 'Impact traversal reaches this community from the selected target.')
  }

  if ('community_context' in pack && Array.isArray(pack.community_context) && pack.community_context.length > 0) {
    return fromCommunityContext(pack.community_context, 'Selected pack evidence clusters here.')
  }

  if ('review_bundle' in pack && pack.review_bundle && Array.isArray(pack.review_bundle.community_context) && pack.review_bundle.community_context.length > 0) {
    return fromCommunityContext(pack.review_bundle.community_context, 'Review bundle evidence clusters here.')
  }

  return plan.steps.slice(0, 3).map((step) => ({
    label: step.title,
    reason: `Planner step scoped as ${step.scope_mode}.`,
  }))
}

function recommendedFirstRead(
  task: TaskContextPlan['task_kind'],
  pack: PackPayload,
  implementation?: ImplementationPackGuidance,
): ContextPackRecommendedFirstRead[] {
  if (task === 'implement' && implementation) {
    const reads: ContextPackRecommendedFirstRead[] = []
    const seen = new Set<string>()
    const pushRead = (path: string, reason: string, label?: string) => {
      if (seen.has(path) || reads.length >= 3) {
        return
      }
      seen.add(path)
      reads.push({
        path,
        ...(label ? { label } : {}),
        reason,
      })
    }

    for (const entry of implementation.contracts_and_public_surfaces.filter((item) => item.kind === 'public_surface')) {
      pushRead(entry.source_file, entry.why, entry.label)
    }
    for (const entry of implementation.contracts_and_public_surfaces.filter((item) => item.kind === 'contract')) {
      pushRead(entry.source_file, entry.why, entry.label)
    }
    for (const entry of implementation.existing_patterns) {
      pushRead(entry.source_file, entry.why, entry.label)
    }
    for (const entry of implementation.likely_edit_files) {
      pushRead(entry.path, entry.reason, entry.matched_symbols[0])
    }

    if (reads.length > 0) {
      return reads
    }
  }

  if (implementation?.likely_edit_files.length) {
    return implementation.likely_edit_files.slice(0, 3).map((entry) => ({
      path: entry.path,
      ...(entry.matched_symbols[0] ? { label: entry.matched_symbols[0] } : {}),
      reason: entry.reason,
    }))
  }

  if (task === 'review' && 'changed_files' in pack && Array.isArray(pack.changed_files) && pack.changed_files.length > 0) {
    return pack.changed_files.slice(0, 3).map((path) => ({
      path,
      reason: 'Changed file in the current diff.',
    }))
  }

  if (task === 'impact' && 'target_file' in pack && typeof pack.target_file === 'string' && pack.target_file.length > 0) {
    const reads: ContextPackRecommendedFirstRead[] = [{
      path: pack.target_file,
      ...(typeof pack.target === 'string' ? { label: pack.target } : {}),
      reason: 'Impact traversal starts from this target.',
    }]
    if (Array.isArray(pack.affected_files)) {
      for (const path of pack.affected_files) {
        if (reads.some((entry) => entry.path === path)) {
          continue
        }
        reads.push({
          path,
          reason: 'Affected file reached by the dependency traversal.',
        })
        if (reads.length >= 3) {
          break
        }
      }
    }
    return reads
  }

  if ('matched_nodes' in pack && Array.isArray(pack.matched_nodes)) {
    const reads: ContextPackRecommendedFirstRead[] = []
    const seen = new Set<string>()
    for (const node of pack.matched_nodes) {
      if (seen.has(node.source_file)) {
        continue
      }
      seen.add(node.source_file)
      reads.push({
        path: node.source_file,
        label: node.label,
        reason: `Direct pack evidence via ${node.label}.`,
      })
      if (reads.length >= 3) {
        break
      }
    }
    return reads
  }

  if ('review_bundle' in pack && pack.review_bundle && Array.isArray(pack.review_bundle.nodes)) {
    const reads: ContextPackRecommendedFirstRead[] = []
    const seen = new Set<string>()
    for (const node of pack.review_bundle.nodes) {
      if (seen.has(node.source_file)) {
        continue
      }
      seen.add(node.source_file)
      reads.push({
        path: node.source_file,
        label: node.label,
        reason: `Review bundle evidence via ${node.label}.`,
      })
      if (reads.length >= 3) {
        break
      }
    }
    return reads
  }

  return []
}

function publicContracts(
  implementation?: ImplementationPackGuidance,
): ContextPackPublicContract[] {
  return implementation?.contracts_and_public_surfaces
    .filter((entry): entry is typeof entry & { kind: 'contract' | 'public_surface' } => entry.kind === 'contract' || entry.kind === 'public_surface')
    .slice(0, 6)
    .map((entry) => ({
      label: entry.label,
      source_file: entry.source_file,
      line_number: entry.line_number,
      kind: entry.kind,
      why: entry.why,
    })) ?? []
}

function negativeGuidance(
  coverage: ContextPackCoverage,
  pack: PackPayload,
  implementation?: ImplementationPackGuidance,
): string[] {
  const guidance = [...(implementation?.cautions ?? [])]

  if (coverage.missing_required.length > 0) {
    guidance.push(`Do not assume missing required evidence is covered: ${coverage.missing_required.join(', ')}.`)
  }
  if (coverage.missing_semantic.length > 0) {
    guidance.push(`Do not assume missing semantic categories are covered: ${coverage.missing_semantic.join(', ')}.`)
  }
  if ('answer_contract' in pack && pack.answer_contract?.do_not_claim) {
    for (const item of pack.answer_contract.do_not_claim) {
      guidance.push(`Do not claim: ${item}.`)
    }
  }
  if ('uncovered_hotspots' in pack && Array.isArray(pack.uncovered_hotspots) && pack.uncovered_hotspots.length > 0) {
    guidance.push(`Do not treat the compact review bundle as complete for uncovered hotspots: ${pack.uncovered_hotspots.slice(0, 3).map((entry) => entry.label).join(', ')}.`)
  }

  return [...new Set(guidance)]
}

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100
}

function confidenceScore(
  coverage: ContextPackCoverage,
  pack: PackPayload,
  implementation?: ImplementationPackGuidance,
): number {
  const requiredEntries = coverage.entries.filter((entry) => entry.required)
  const requiredCovered = requiredEntries.filter((entry) => entry.status === 'covered').length
  const semanticEntries = coverage.semantic_entries.filter((entry) => entry.required)
  const semanticCovered = semanticEntries.filter((entry) => entry.status === 'covered').length
  const requiredScore = requiredEntries.length > 0 ? requiredCovered / requiredEntries.length : 1
  const semanticScore = semanticEntries.length > 0 ? semanticCovered / semanticEntries.length : 1
  const relationshipScore = coverage.available_relationships > 0
    ? coverage.selected_relationships / coverage.available_relationships
    : 1

  let score = (requiredScore * 0.55) + (semanticScore * 0.3) + (relationshipScore * 0.15)

  if (implementation && implementation.likely_edit_files.length === 0) {
    score -= 0.05
  }
  score -= Math.min(0.15, coverage.missing_required.length * 0.03)
  score -= Math.min(0.1, coverage.missing_semantic.length * 0.02)

  if ('coverage_score_weighted' in pack && typeof pack.coverage_score_weighted === 'number') {
    score = (score + pack.coverage_score_weighted) / 2
  }

  return roundScore(score)
}

function whyExplanation(
  plan: TaskContextPlan,
  workflowCentersValue: readonly ContextPackWorkflowCenter[],
  firstRead: readonly ContextPackRecommendedFirstRead[],
  coverage: ContextPackCoverage,
  score: number,
  implementation?: ImplementationPackGuidance,
): string[] {
  const requiredEntries = coverage.entries.filter((entry) => entry.required)
  const requiredCovered = requiredEntries.filter((entry) => entry.status === 'covered').length
  const semanticEntries = coverage.semantic_entries.filter((entry) => entry.required)
  const semanticCovered = semanticEntries.filter((entry) => entry.status === 'covered').length

  const explanations = [
    ...(implementation?.summary ? [implementation.summary] : []),
    `Planner flow: ${plan.steps.map((step) => step.title).join(' -> ')}.`,
    workflowCentersValue.length > 0
      ? `Workflow centers emphasize ${workflowCentersValue.slice(0, 3).map((entry) => entry.label).join(', ')}.`
      : 'Workflow centers fall back to the task planner because graph clustering evidence was sparse.',
    firstRead[0]
      ? `Start with ${firstRead[0].path} because ${firstRead[0].reason.toLowerCase()}`
      : 'No first-read anchor was available, so the brief leaves that section intentionally empty.',
    ...(implementation && implementation.likely_test_files.length === 0
      ? ['No related tests were identified, so the brief keeps a manual validation caution visible.']
      : []),
    `Confidence ${score.toFixed(2)} from ${requiredCovered}/${requiredEntries.length || 0} required evidence classes and ${semanticCovered}/${semanticEntries.length || 0} required semantic categories covered.`,
  ]

  return explanations
}

function buildPackSchemaV1<TPack extends PackPayload>(
  response: PackResponseBase & ContextPlaneMetadata & {
    pack: TPack
    implementation?: ImplementationPackGuidance
    routing?: ContextPackRoutingDebug
    target?: string
  },
): PackSchemaEnvelope<TPack> {
  const centers = workflowCenters(response.task, response.pack, response.plan, response.implementation)
  const firstRead = recommendedFirstRead(response.task, response.pack, response.implementation)
  const contracts = publicContracts(response.implementation)
  const guidance = negativeGuidance(response.coverage, response.pack, response.implementation)
  const score = confidenceScore(response.coverage, response.pack, response.implementation)

  return {
    schema_version: 1,
    ...response,
    workflow_centers: centers,
    recommended_first_read: firstRead,
    likely_edit_files: response.implementation?.likely_edit_files ?? [],
    likely_test_files: response.implementation?.likely_test_files ?? [],
    public_contracts: contracts,
    risk_boundaries: response.implementation?.risk_boundaries ?? [],
    validation_commands: response.implementation?.validation_commands ?? [],
    negative_guidance: guidance,
    confidence_score: score,
    why_explanation: whyExplanation(
      response.plan,
      centers,
      firstRead,
      response.coverage,
      score,
      response.implementation,
    ),
  }
}

function renderTextSection(title: string, lines: string[]): string[] {
  return [
    title,
    ...(lines.length > 0 ? lines : ['- none identified for this task.']),
    '',
  ]
}

function formatFileHint(path: string, reason: string, label?: string): string {
  return `- ${path}${label ? ` (${label})` : ''}: ${reason}`
}

function formatScoredFileHint(entry: { path: string; score: number; reason: string; matched_symbols: string[] }): string {
  return `- ${entry.path} [${entry.score.toFixed(2)}]${entry.matched_symbols[0] ? ` (${entry.matched_symbols[0]})` : ''}: ${entry.reason}`
}

function renderPackSchemaText(schema: PackSchemaEnvelope): string {
  const lines = [
    'Pack Schema v1',
    `Task: ${schema.task}`,
    `Task intent: ${schema.task_intent}`,
    `Prompt: ${schema.prompt}`,
    `Budget: ${schema.budget}`,
    `Graph path: ${schema.graph_path}`,
    `Confidence score: ${schema.confidence_score.toFixed(2)}`,
    '',
    ...renderTextSection('Workflow centers', schema.workflow_centers.map((entry) => {
      const location = entry.path
        ? `${entry.path}${typeof entry.score === 'number' ? ` [${entry.score.toFixed(2)}]` : ''}`
        : entry.label
      const label = entry.path && entry.label !== entry.path ? ` (${entry.label})` : ''
      return `- ${location}${label}: ${entry.reason}`
    })),
    ...renderTextSection('Recommended first read', schema.recommended_first_read.map((entry) => formatFileHint(entry.path, entry.reason, entry.label))),
    ...renderTextSection('Likely edit files', schema.likely_edit_files.map((entry) => formatScoredFileHint(entry))),
    ...renderTextSection('Likely test files', schema.likely_test_files.map((entry) => formatScoredFileHint(entry))),
    ...renderTextSection('Public contracts', schema.public_contracts.map((entry) => `- ${entry.source_file}:${entry.line_number} (${entry.kind}) ${entry.label} — ${entry.why}`)),
    ...renderTextSection('Risk boundaries', schema.risk_boundaries.map((entry) => `- ${entry.label} [${entry.severity}]: ${entry.reason}`)),
    ...renderTextSection('Validation commands', schema.validation_commands.map((entry) => `- ${entry}`)),
    ...renderTextSection('Negative guidance', schema.negative_guidance.map((entry) => `- ${entry}`)),
    ...renderTextSection('Why this pack', schema.why_explanation.map((entry) => `- ${entry}`)),
  ]

  return lines.join('\n').trimEnd()
}

function renderContextPackOutput(
  format: ContextPackFormat | undefined,
  schema: PackSchemaEnvelope,
): string {
  return format === 'text'
    ? renderPackSchemaText(schema)
    : JSON.stringify(schema)
}

export async function runContextPackCommand(
  options: PackCliOptions,
  dependencies: ContextPackCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  const graph = dependencies.loadGraph(options.graphPath)
  const plannerBudget = Math.max(options.budget, 3)
  const resolvedTask = resolveTaskSelection(
    options.prompt,
    options.task,
    options.taskExplicit !== undefined ? { explicit: options.taskExplicit } : {},
  )
  const initialPlan = buildTaskContextPlan({
    task_kind: resolvedTask.task_kind,
    prompt: options.prompt,
    budget: plannerBudget,
    task_intent: resolvedTask.task_intent,
  })

  if (resolvedTask.task_kind === 'review') {
    if (options.retrievalStrategy !== undefined) {
      throw new Error('retrievalStrategy is not supported for task=review')
    }
    const reviewResult = dependencies.analyzePrImpact(graph, '.', {
      budget: plannerBudget,
      taskIntent: initialPlan.evidence.recipe_id,
    })
    const reviewPack = dependencies.compactPrImpactResult(reviewResult)
    const plan = buildTaskContextPlan({
      task_kind: 'review',
      prompt: options.prompt,
      budget: plannerBudget,
      task_intent: initialPlan.evidence.recipe_id,
      changed_paths: reviewResult.changed_files ?? [],
      focus_paths: [
        ...(reviewResult.review_context?.supporting_paths ?? []),
        ...(reviewResult.review_context?.test_paths ?? []),
      ],
    })

    return renderContextPackOutput(options.format, buildPackSchemaV1({
      ...baseResponse(options, plan, plannerBudget, resolvedTask.task_kind),
      pack: reviewPack,
      ...contextMetadata(reviewResult.review_bundle ?? {}),
    }))
  }

  if (resolvedTask.task_kind === 'impact') {
    const retrieval = dependencies.retrieveContext(graph, {
      question: options.prompt,
      budget: plannerBudget,
      taskKind: resolvedTask.task_kind,
      taskIntent: initialPlan.evidence.recipe_id,
      ...(options.retrievalLevel !== undefined ? { retrievalLevel: options.retrievalLevel } : {}),
      ...(options.retrievalStrategy !== undefined ? { retrievalStrategy: options.retrievalStrategy } : {}),
    })
    const impactTarget = pickImpactTarget(retrieval)
    const communityLabels = buildCommunityLabels(graph, communitiesFromGraph(graph))
    const impactResult = dependencies.analyzeImpact(graph, communityLabels, {
      label: impactTarget,
      depth: DEFAULT_IMPACT_DEPTH,
    })
    const impactPack = dependencies.compactImpactResult(impactResult)

    return renderContextPackOutput(options.format, buildPackSchemaV1({
      ...baseResponse(options, initialPlan, plannerBudget, resolvedTask.task_kind),
      target: impactTarget,
      pack: impactPack,
      ...impactMetadata(impactResult, plannerBudget, options.prompt, initialPlan.evidence.recipe_id, options.retrievalLevel),
      ...(options.why ? { routing: buildRoutingDebug(retrieval) } : {}),
    }))
  }

  const effectivePackRetrievalStrategy =
    options.retrievalStrategy ?? defaultPackRetrievalStrategy(options.prompt)

  const retrieval = dependencies.retrieveContext(graph, {
    question: options.prompt,
    budget: plannerBudget,
    taskKind: resolvedTask.task_kind,
    taskIntent: initialPlan.evidence.recipe_id,
    ...(options.retrievalLevel !== undefined ? { retrievalLevel: options.retrievalLevel } : {}),
    ...(effectivePackRetrievalStrategy !== undefined
      ? { retrievalStrategy: effectivePackRetrievalStrategy }
      : {}),
  })
  const implementation = resolvedTask.task_kind === 'implement'
    ? buildImplementationPackGuidance(graph, retrieval, {
        budget: plannerBudget,
        taskIntent: initialPlan.evidence.recipe_id,
      })
    : undefined
  return renderContextPackOutput(options.format, buildPackSchemaV1({
    ...baseResponse(options, initialPlan, plannerBudget, resolvedTask.task_kind),
    ...buildExplainPackPayload(dependencies.compactRetrieveResult(retrieval), retrieval, implementation),
    ...(options.why ? { routing: buildRoutingDebug(retrieval) } : {}),
  }))
}
