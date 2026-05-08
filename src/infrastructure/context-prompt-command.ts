import type { PromptCliOptions } from '../cli/parser.js'
import type { KnowledgeGraph } from '../contracts/graph.js'
import { buildGraphifyPromptPack, type ComparePromptPack } from './compare.js'
import { retrieveContext, type RetrieveResult } from '../runtime/retrieve.js'
import { loadGraph } from '../runtime/serve.js'

const DEFAULT_PROMPT_BUDGET = 3_000

export interface ContextPromptCommandDependencies {
  loadGraph: (graphPath: string) => KnowledgeGraph
  retrieveContext: (graph: KnowledgeGraph, options: { question: string; budget: number }) => RetrieveResult
  buildGraphifyPromptPack: (input: { question: string; retrieval: RetrieveResult }) => ComparePromptPack
}

const DEFAULT_DEPENDENCIES: ContextPromptCommandDependencies = {
  loadGraph,
  retrieveContext: (graph, options) => retrieveContext(graph, options),
  buildGraphifyPromptPack: (input) => buildGraphifyPromptPack(input),
}

export async function runContextPromptCommand(
  options: PromptCliOptions,
  dependencies: ContextPromptCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  const graph = dependencies.loadGraph(options.graphPath)
  const retrieval = dependencies.retrieveContext(graph, {
    question: options.prompt,
    budget: DEFAULT_PROMPT_BUDGET,
  })
  const compiled = dependencies.buildGraphifyPromptPack({
    question: options.prompt,
    retrieval,
  })

  return JSON.stringify({
    provider: options.provider,
    task: 'explain',
    prompt: options.prompt,
    graph_path: options.graphPath,
    compiled,
  })
}
