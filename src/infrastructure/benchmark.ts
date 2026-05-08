import { QUERY_TOKEN_ESTIMATOR, loadGraph } from '../runtime/serve.js'
import { KnowledgeGraph } from '../contracts/graph.js'
import type { ContextSessionState } from '../contracts/context-session.js'
import { graphStructureMetrics, type GraphStructureMetrics } from '../pipeline/analyze.js'
import { formatTokenRatio, resolveCorpusBaseline, type CorpusBaselineSource } from './benchmark/corpus.js'
import {
  runBenchmarkPrompt,
  type BenchmarkPromptExecution,
  type BenchmarkPromptRunnerResult,
} from './benchmark/runner.js'
import {
  evaluateBenchmarkQuestion,
  querySubgraphTokens,
  type BenchmarkMissingExpectedLabels,
  type BenchmarkQuestionInput,
  type BenchmarkQuestionResult,
} from './benchmark/questions.js'
import {
  averageInputTokenLabel,
  averageReportedTotalTokens,
  promptTokenSourceSuffix,
  usageCaptureSummary,
  usageProviderLabel,
} from './benchmark/usage.js'

export { loadBenchmarkQuestions, querySubgraphTokens, type BenchmarkQuestionInput } from './benchmark/questions.js'

export const SAMPLE_QUESTIONS = [
  'how does authentication work',
  'what is the main entry point',
  'how are errors handled',
  'what connects the data layer to the api',
  'what are the core abstractions',
]

export interface BenchmarkSuccessResult {
  corpus_tokens: number
  corpus_words: number
  corpus_source: CorpusBaselineSource
  nodes: number
  edges: number
  structure_signals: GraphStructureMetrics | null
  question_count: number
  matched_question_count: number
  unmatched_questions: string[]
  expected_label_count: number
  matched_expected_label_count: number
  missing_expected_labels: BenchmarkMissingExpectedLabels[]
  avg_query_tokens: number
  avg_effective_query_tokens?: number
  avg_reused_context_tokens?: number
  avg_total_tokens?: number | null
  reduction_ratio: number
  effective_reduction_ratio?: number
  per_question: BenchmarkQuestionResult[]
}

export interface BenchmarkErrorResult {
  error: string
}

export type BenchmarkResult = BenchmarkSuccessResult | BenchmarkErrorResult

export interface BenchmarkRunOptions {
  execTemplate?: string
  outputDir?: string
  now?: Date
  retrievalBudget?: number
  runner?: (execution: BenchmarkPromptExecution) => Promise<BenchmarkPromptRunnerResult>
}

function loadBenchmarkGraph(graphPath: string): KnowledgeGraph {
  return loadGraph(graphPath)
}

function hasStructureSignalProvenance(graph: KnowledgeGraph): boolean {
  return graph.nodeEntries().every(([, attributes]) => String(attributes.source_file ?? '').length > 0)
}

function averageQueryTokens(perQuestion: readonly BenchmarkQuestionResult[]): number {
  return Math.floor(perQuestion.reduce((sum, entry) => sum + entry.query_tokens, 0) / perQuestion.length)
}

function averageEffectiveQueryTokens(perQuestion: readonly BenchmarkQuestionResult[]): number {
  return Math.floor(
    perQuestion.reduce((sum, entry) => sum + (entry.effective_query_tokens ?? entry.query_tokens), 0) / perQuestion.length,
  )
}

function averageReusedContextTokens(perQuestion: readonly BenchmarkQuestionResult[]): number {
  return Math.floor(perQuestion.reduce((sum, entry) => sum + (entry.reused_context_tokens ?? 0), 0) / perQuestion.length)
}

function finalizeBenchmarkResult(
  graph: KnowledgeGraph,
  structureSignals: GraphStructureMetrics | null,
  baseline: ReturnType<typeof resolveCorpusBaseline>,
  benchmarkQuestions: readonly BenchmarkQuestionInput[],
  unmatchedQuestions: string[],
  expectedLabelCount: number,
  matchedExpectedLabelCount: number,
  missingExpectedLabels: BenchmarkMissingExpectedLabels[],
  perQuestion: BenchmarkQuestionResult[],
): BenchmarkSuccessResult {
  const avgQueryTokens = averageQueryTokens(perQuestion)
  const avgEffectiveQueryTokens = averageEffectiveQueryTokens(perQuestion)
  return {
    corpus_tokens: baseline.tokens,
    corpus_words: baseline.words,
    corpus_source: baseline.source,
    nodes: graph.numberOfNodes(),
    edges: graph.numberOfEdges(),
    structure_signals: structureSignals,
    question_count: benchmarkQuestions.length,
    matched_question_count: perQuestion.length,
    unmatched_questions: unmatchedQuestions,
    expected_label_count: expectedLabelCount,
    matched_expected_label_count: matchedExpectedLabelCount,
    missing_expected_labels: missingExpectedLabels,
    avg_query_tokens: avgQueryTokens,
    avg_effective_query_tokens: avgEffectiveQueryTokens,
    avg_reused_context_tokens: averageReusedContextTokens(perQuestion),
    avg_total_tokens: averageReportedTotalTokens(perQuestion),
    reduction_ratio: avgQueryTokens > 0 ? Number((baseline.tokens / avgQueryTokens).toFixed(1)) : 0,
    effective_reduction_ratio: avgEffectiveQueryTokens > 0 ? Number((baseline.tokens / avgEffectiveQueryTokens).toFixed(1)) : 0,
    per_question: perQuestion,
  }
}

async function runRunnerBackedBenchmark(
  graph: KnowledgeGraph,
  graphPath: string,
  baseline: ReturnType<typeof resolveCorpusBaseline>,
  evaluations: readonly BenchmarkQuestionResult[],
  options: BenchmarkRunOptions,
): Promise<BenchmarkQuestionResult[]> {
  const execTemplate = options.execTemplate
  if (!execTemplate) {
    return [...evaluations]
  }

  const perQuestion: BenchmarkQuestionResult[] = []
  let sessionState: ContextSessionState | undefined
  for (const evaluation of evaluations) {
    const run = await runBenchmarkPrompt({
      graphPath,
      graph,
      question: evaluation.question,
      execTemplate,
      ...(options.outputDir !== undefined ? { outputDir: options.outputDir } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.retrievalBudget !== undefined ? { retrievalBudget: options.retrievalBudget } : {}),
      ...(sessionState ? { session: sessionState } : {}),
      ...(options.runner !== undefined ? { runner: options.runner } : {}),
    })
    sessionState = run.session_state
    perQuestion.push({
      ...evaluation,
      query_tokens: run.query_tokens,
      effective_query_tokens: run.effective_query_tokens,
      reused_context_tokens: run.reused_context_tokens,
      total_tokens: run.total_tokens,
      prompt_tokens_estimated: run.prompt_tokens_estimated,
      prompt_token_source: run.prompt_token_source,
      usage: run.usage,
      answer_text: run.answer_text,
      elapsed_ms: run.elapsed_ms,
      artifacts: run.artifacts,
      reduction: run.query_tokens > 0 ? Number((baseline.tokens / run.query_tokens).toFixed(1)) : 0,
    })
  }
  return perQuestion
}

function totalTokenLabel(result: BenchmarkSuccessResult): string | null {
  if (result.avg_total_tokens === null || result.avg_total_tokens === undefined) {
    return null
  }

  return `  Avg total tokens (${usageProviderLabel(result.per_question)} reported): ~${result.avg_total_tokens.toLocaleString()}`
}

export function runBenchmark(
  graphPath = 'graphify-out/graph.json',
  corpusWords?: number | null,
  questions?: BenchmarkQuestionInput[],
  options: BenchmarkRunOptions = {},
): BenchmarkResult | Promise<BenchmarkResult> {
  const graph = loadBenchmarkGraph(graphPath)
  const structureSignals = hasStructureSignalProvenance(graph) ? graphStructureMetrics(graph) : null
  const baseline = resolveCorpusBaseline(graph.numberOfNodes(), { graphPath, corpusWords })
  const benchmarkQuestions = questions ?? SAMPLE_QUESTIONS
  const usesSampleQuestions = questions === undefined
  const evaluatedQuestions: BenchmarkQuestionResult[] = []
  const unmatchedQuestions: string[] = []
  const missingExpectedLabels: BenchmarkMissingExpectedLabels[] = []
  if (benchmarkQuestions.length === 0) {
    return {
      error: usesSampleQuestions
        ? 'No sample questions are available for this benchmark run.'
        : 'Question file did not include any benchmark questions. Add at least one question or omit --questions to use the sample set.',
    }
  }

  let expectedLabelCount = 0
  let matchedExpectedLabelCount = 0
  for (const question of benchmarkQuestions) {
    const evaluation = evaluateBenchmarkQuestion(graph, question, baseline.tokens)
    expectedLabelCount += evaluation.expected_label_count
    matchedExpectedLabelCount += evaluation.matched_expected_label_count
    if (evaluation.missing_expected_labels) {
      missingExpectedLabels.push(evaluation.missing_expected_labels)
    }
    if (!evaluation.result) {
      unmatchedQuestions.push(evaluation.question)
      continue
    }
    evaluatedQuestions.push(evaluation.result)
  }

  if (evaluatedQuestions.length === 0) {
    return {
      error: usesSampleQuestions
        ? 'No matching nodes found for sample questions. Build the graph first.'
        : 'No matching nodes found for the supplied questions. Check the graph path or question file.',
    }
  }

  if (!options.execTemplate) {
    return finalizeBenchmarkResult(
      graph,
      structureSignals,
      baseline,
      benchmarkQuestions,
      unmatchedQuestions,
      expectedLabelCount,
      matchedExpectedLabelCount,
      missingExpectedLabels,
      evaluatedQuestions,
    )
  }

  return runRunnerBackedBenchmark(graph, graphPath, baseline, evaluatedQuestions, options)
    .then((perQuestion) =>
      finalizeBenchmarkResult(
        graph,
        structureSignals,
        baseline,
        benchmarkQuestions,
        unmatchedQuestions,
        expectedLabelCount,
        matchedExpectedLabelCount,
        missingExpectedLabels,
        perQuestion,
      ),
    )
    .catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }))
}

export function printBenchmark(result: BenchmarkResult): void {
  if ('error' in result) {
    console.log(`Benchmark error: ${result.error}`)
    return
  }

  console.log('\ngraphify runner-backed benchmark')
  console.log(`${'─'.repeat(50)}`)
  const corpusNote = result.corpus_source === 'estimated' ? ' (estimated from graph size)' : ''
  console.log(`  Corpus baseline: ${result.corpus_words.toLocaleString()} words → ~${result.corpus_tokens.toLocaleString()} tokens${corpusNote}`)
  console.log(`  Graph:           ${result.nodes.toLocaleString()} nodes, ${result.edges.toLocaleString()} edges`)
  console.log(`  Question coverage: ${result.matched_question_count}/${result.question_count} matched`)
  if (result.unmatched_questions.length > 0) {
    console.log(`    Unmatched: ${result.unmatched_questions.join(', ')}`)
  }
  if (result.expected_label_count > 0) {
    console.log(`  Expected evidence: ${result.matched_expected_label_count}/${result.expected_label_count} labels found`)
    for (const missing of result.missing_expected_labels) {
      console.log(`    Missing evidence for ${missing.question}: ${missing.labels.join(', ')}`)
    }
  }
  if (result.structure_signals) {
    console.log('  Structure signals:')
    console.log(
      `    entity basis: ${result.structure_signals.total_nodes.toLocaleString()} nodes, ${result.structure_signals.total_edges.toLocaleString()} edges`,
    )
    console.log(
      `    components: ${result.structure_signals.weakly_connected_components.toLocaleString()} weakly connected, ${result.structure_signals.singleton_components.toLocaleString()} singleton, ${result.structure_signals.isolated_nodes.toLocaleString()} isolated`,
    )
    console.log(
      `    largest component: ${result.structure_signals.largest_component_nodes.toLocaleString()} nodes (${Math.round(result.structure_signals.largest_component_ratio * 100)}% of entity graph)`,
    )
    console.log(
      result.structure_signals.low_cohesion_communities > 0
        ? `    low cohesion: ${result.structure_signals.low_cohesion_communities.toLocaleString()} communities, largest ${result.structure_signals.largest_low_cohesion_community_nodes.toLocaleString()} nodes (cohesion ${result.structure_signals.largest_low_cohesion_community_score})`
        : '    low cohesion: 0 communities, none on the entity basis',
    )
  } else {
    console.log('  Structure signals: unavailable for graph artifacts without source_file provenance')
  }
  console.log(`  ${averageInputTokenLabel(result.per_question)}: ~${result.avg_query_tokens.toLocaleString()}`)
  if (
    typeof result.avg_effective_query_tokens === 'number' &&
    (result.avg_effective_query_tokens !== result.avg_query_tokens || (result.avg_reused_context_tokens ?? 0) > 0)
  ) {
    console.log(`  Avg effective input tokens (cache-adjusted): ~${result.avg_effective_query_tokens.toLocaleString()}`)
  }
  const totalTokensLine = totalTokenLabel(result)
  if (totalTokensLine) {
    console.log(totalTokensLine)
  }
  const usageSummary = usageCaptureSummary(result.per_question, 'matched questions')
  const usageLine = usageSummary ? `  Usage capture: ${usageSummary}` : null
  if (usageLine) {
    console.log(usageLine)
  }
  console.log(`  Corpus compression: ${formatTokenRatio(result.corpus_tokens, result.avg_query_tokens)} per matched question`)
  console.log('\n  Per question:')
  for (const entry of result.per_question) {
    console.log(
      `    [${formatTokenRatio(result.corpus_tokens, entry.query_tokens)}] ${entry.question.slice(0, 55)}${promptTokenSourceSuffix(entry.prompt_token_source)}`,
    )
  }
  console.log('')
}
