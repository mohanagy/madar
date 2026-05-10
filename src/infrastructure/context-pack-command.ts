import { buildCommunityLabels } from '../pipeline/community-naming.js'
import type { ContextPackClaim, ContextPackCoverage, ContextPackEvidenceClass, ContextPackExpandableRef, ContextPackNode } from '../contracts/context-pack.js'
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
import { compactRetrieveResult, retrieveContext, type RetrieveResult } from '../runtime/retrieve.js'
import { communitiesFromGraph, loadGraph } from '../runtime/serve.js'

const DEFAULT_IMPACT_DEPTH = 3

export interface ContextPackCommandDependencies {
  loadGraph: (graphPath: string) => KnowledgeGraph
  retrieveContext: (graph: KnowledgeGraph, options: Pick<import('../runtime/retrieve.js').RetrieveOptions, 'question' | 'budget' | 'taskIntent' | 'retrievalLevel'>) => RetrieveResult
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

function baseResponse(options: PackCliOptions, plan: TaskContextPlan, budget: number) {
  return {
    task: options.task,
    task_intent: plan.evidence.recipe_id,
    prompt: options.prompt,
    budget,
    graph_path: options.graphPath,
    plan,
  }
}

export async function runContextPackCommand(
  options: PackCliOptions,
  dependencies: ContextPackCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  const graph = dependencies.loadGraph(options.graphPath)
  const plannerBudget = Math.max(options.budget, 3)
  const initialPlan = buildTaskContextPlan({
    task_kind: options.task,
    prompt: options.prompt,
    budget: plannerBudget,
  })

  if (options.task === 'review') {
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

    return JSON.stringify({
      ...baseResponse(options, plan, plannerBudget),
      pack: reviewPack,
      ...contextMetadata(reviewResult.review_bundle ?? {}),
    })
  }

  if (options.task === 'impact') {
    const retrieval = dependencies.retrieveContext(graph, {
      question: options.prompt,
      budget: plannerBudget,
      taskIntent: initialPlan.evidence.recipe_id,
      ...(options.retrievalLevel !== undefined ? { retrievalLevel: options.retrievalLevel } : {}),
    })
    const impactTarget = pickImpactTarget(retrieval)
    const communityLabels = buildCommunityLabels(graph, communitiesFromGraph(graph))
    const impactResult = dependencies.analyzeImpact(graph, communityLabels, {
      label: impactTarget,
      depth: DEFAULT_IMPACT_DEPTH,
    })
    const impactPack = dependencies.compactImpactResult(impactResult)

    return JSON.stringify({
      ...baseResponse(options, initialPlan, plannerBudget),
      target: impactTarget,
      pack: impactPack,
      ...impactMetadata(impactResult, plannerBudget, options.prompt, initialPlan.evidence.recipe_id, options.retrievalLevel),
    })
  }

  const retrieval = dependencies.retrieveContext(graph, {
    question: options.prompt,
    budget: plannerBudget,
    taskIntent: initialPlan.evidence.recipe_id,
    ...(options.retrievalLevel !== undefined ? { retrievalLevel: options.retrievalLevel } : {}),
  })
  const explainPack = dependencies.compactRetrieveResult(retrieval)

  return JSON.stringify({
    ...baseResponse(options, initialPlan, plannerBudget),
    pack: explainPack,
    ...contextMetadata(retrieval),
  })
}
