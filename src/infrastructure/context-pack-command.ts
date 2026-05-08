import { buildCommunityLabels } from '../pipeline/community-naming.js'
import type { KnowledgeGraph } from '../contracts/graph.js'
import type { PackCliOptions } from '../cli/parser.js'
import { analyzeImpact, compactImpactResult, type ImpactResult } from '../runtime/impact.js'
import { analyzePrImpact, compactPrImpactResult, type PrImpactResult } from '../runtime/pr-impact.js'
import { compactRetrieveResult, retrieveContext, type RetrieveResult } from '../runtime/retrieve.js'
import { communitiesFromGraph, loadGraph } from '../runtime/serve.js'

const DEFAULT_IMPACT_DEPTH = 3

export interface ContextPackCommandDependencies {
  loadGraph: (graphPath: string) => KnowledgeGraph
  retrieveContext: (graph: KnowledgeGraph, options: { question: string; budget: number }) => RetrieveResult
  compactRetrieveResult: typeof compactRetrieveResult
  analyzePrImpact: (graph: KnowledgeGraph, projectDir?: string, options?: { baseBranch?: string; depth?: number; budget?: number }) => PrImpactResult
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

function pickImpactTarget(result: RetrieveResult): string {
  const directMatch = result.matched_nodes.find((node) => node.relevance_band === 'direct')
  if (directMatch?.label) {
    return directMatch.label
  }

  const bestMatch = [...result.matched_nodes]
    .sort((left, right) => (right.match_score ?? 0) - (left.match_score ?? 0))
    .find((node) => node.label.trim().length > 0)

  return bestMatch?.label ?? result.question
}

export async function runContextPackCommand(
  options: PackCliOptions,
  dependencies: ContextPackCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  const graph = dependencies.loadGraph(options.graphPath)

  if (options.task === 'review') {
    const reviewPack = dependencies.compactPrImpactResult(
      dependencies.analyzePrImpact(graph, '.', { budget: options.budget }),
    )

    return JSON.stringify({
      task: options.task,
      prompt: options.prompt,
      budget: options.budget,
      graph_path: options.graphPath,
      pack: reviewPack,
    })
  }

  if (options.task === 'impact') {
    const retrieval = dependencies.retrieveContext(graph, {
      question: options.prompt,
      budget: options.budget,
    })
    const impactTarget = pickImpactTarget(retrieval)
    const communityLabels = buildCommunityLabels(graph, communitiesFromGraph(graph))
    const impactPack = dependencies.compactImpactResult(
      dependencies.analyzeImpact(graph, communityLabels, {
        label: impactTarget,
        depth: DEFAULT_IMPACT_DEPTH,
      }),
    )

    return JSON.stringify({
      task: options.task,
      prompt: options.prompt,
      budget: options.budget,
      graph_path: options.graphPath,
      target: impactTarget,
      pack: impactPack,
    })
  }

  const retrieval = dependencies.retrieveContext(graph, {
    question: options.prompt,
    budget: options.budget,
  })
  const explainPack = dependencies.compactRetrieveResult(retrieval)

  return JSON.stringify({
    task: options.task,
    prompt: options.prompt,
    budget: options.budget,
    graph_path: options.graphPath,
    pack: explainPack,
  })
}
