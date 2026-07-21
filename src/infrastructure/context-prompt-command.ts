import type { PromptCliOptions, PromptCliProvider } from '../cli/parser.js'
import type { KnowledgeGraph } from '../domain/graph/directed-multigraph.js'
import { buildMadarPromptPack, type ComparePromptPack } from './compare.js'
import {
  analyzeGraphContextFreshness,
  requireFreshGraph,
  requireFreshSelectedContext,
  selectedContextSourceFilesFromRetrieveResult,
} from '../runtime/freshness.js'
import { retrieveContext, type RetrieveResult } from '../runtime/retrieve.js'
import { loadGraph } from '../runtime/serve.js'

const DEFAULT_PROMPT_BUDGET = 3_000

export interface ContextPromptCommandDependencies {
  loadGraph: (graphPath: string) => KnowledgeGraph
  retrieveContext: (graph: KnowledgeGraph, options: { question: string; budget: number }) => RetrieveResult
  buildMadarPromptPack: (input: { graphPath?: string; question: string; retrieval: RetrieveResult }) => ComparePromptPack
}

const DEFAULT_DEPENDENCIES: ContextPromptCommandDependencies = {
  loadGraph,
  retrieveContext: (graph, options) => retrieveContext(graph, options),
  buildMadarPromptPack: (input) => buildMadarPromptPack(input),
}

type CompiledProviderPrompt =
  | {
      provider: 'claude'
      format: 'session_payload'
      prompt: string
      token_count: number
      session_payload_token_count: number
      effective_token_count: number
      reused_context_tokens: number
      session_diagnostics: ComparePromptPack['session_diagnostics']
      session_state: ComparePromptPack['session_state']
    }
  | {
      provider: 'gemini'
      format: 'prompt'
      prompt: string
      token_count: number
    }

function compilePromptForProvider(provider: PromptCliProvider, promptPack: ComparePromptPack): CompiledProviderPrompt {
  if (provider === 'claude') {
    return {
      provider,
      format: 'session_payload',
      prompt: promptPack.session_payload,
      token_count: promptPack.token_count,
      session_payload_token_count: promptPack.session_payload_token_count,
      effective_token_count: promptPack.effective_token_count,
      reused_context_tokens: promptPack.reused_context_tokens,
      session_diagnostics: promptPack.session_diagnostics,
      session_state: promptPack.session_state,
    }
  }

  return {
    provider,
    format: 'prompt',
    prompt: promptPack.prompt,
    token_count: promptPack.token_count,
  }
}

export async function runContextPromptCommand(
  options: PromptCliOptions,
  dependencies: ContextPromptCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  const graph = dependencies.loadGraph(options.graphPath)
  const initialGraphFreshness = analyzeGraphContextFreshness(options.graphPath, graph)
  if (options.requireFreshGraph === true) {
    requireFreshGraph(initialGraphFreshness)
  }
  const retrieval = dependencies.retrieveContext(graph, {
    question: options.prompt,
    budget: DEFAULT_PROMPT_BUDGET,
  })
  const graphFreshness = analyzeGraphContextFreshness(options.graphPath, graph, {
    selected_source_files: selectedContextSourceFilesFromRetrieveResult(retrieval),
  })
  if (options.requireFreshContext === true) {
    requireFreshSelectedContext(graphFreshness)
  }
  const compiled = dependencies.buildMadarPromptPack({
    graphPath: options.graphPath,
    question: options.prompt,
    retrieval,
  })
  const providerCompiled = compilePromptForProvider(options.provider, compiled)

  return JSON.stringify({
    provider: options.provider,
    prompt: options.prompt,
    graph_path: options.graphPath,
    graph_freshness: graphFreshness,
    compiled: providerCompiled,
  })
}
