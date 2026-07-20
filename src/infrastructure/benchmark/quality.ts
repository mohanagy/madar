import { KnowledgeGraph } from '../../domain/graph/directed-multigraph.js'
import { retrieveContext, type RetrieveResult } from '../../runtime/retrieve.js'
import { formatTokenRatio, resolveCorpusBaseline, type CorpusBaselineSource } from './corpus.js'
import { normalizeBenchmarkQuestion, normalizeExpectedLabel, type BenchmarkQuestionSpec } from './questions.js'
import { type PromptRunnerUsage } from '../prompt-runner.js'
import {
  retrieveBenchmarkContext,
  runBenchmarkPrompt,
  type BenchmarkPromptArtifacts,
  type BenchmarkPromptExecution,
  type BenchmarkPromptRunnerResult,
  type BenchmarkPromptTokenSource,
} from './runner.js'
import {
  averageInputTokenLabel,
  averageReportedTotalTokens,
  promptTokenSourceSuffix,
  usageCaptureSummary,
  usageProviderLabel,
} from './usage.js'
import { resolveWorkspaceGraphPath } from '../../shared/workspace.js'

export interface GoldQuestion {
  question: string
  expected_labels: string[]
}

export type QualityQuestionInput = GoldQuestion | BenchmarkQuestionSpec

export interface QualityResult {
  question: string
  bucket: string
  expected_labels: string[]
  returned_labels: string[]
  matched_labels: string[]
  missing_labels: string[]
  precision: number
  recall: number
  reciprocal_rank: number
  snippet_coverage: number
  grounded_match_rate: number
  tokens_used: number
  total_tokens: number | null
  prompt_tokens_estimated: number | null
  prompt_token_source: BenchmarkPromptTokenSource | null
  usage: PromptRunnerUsage | null
  answer_text: string | null
  elapsed_ms: number | null
  artifacts: BenchmarkPromptArtifacts | null
}

export interface QualityBucketSummary {
  bucket: string
  questions: number
  avg_recall: number
  mrr: number
  avg_snippet_coverage: number
  avg_grounded_match_rate: number
}

export interface QualityReport {
  questions: QualityResult[]
  skipped_questions: number
  avg_precision: number
  avg_recall: number
  mrr: number
  avg_snippet_coverage: number
  avg_grounded_match_rate: number
  questions_with_hits: number
  total_questions: number
  avg_tokens_used: number
  avg_total_tokens: number | null
  corpus_tokens: number
  corpus_source: CorpusBaselineSource
  compression_ratio: number
  bucket_summaries: QualityBucketSummary[]
}

export interface QualityOptions {
  graphPath?: string
  corpusWords?: number | null
  execTemplate?: string
  outputDir?: string
  now?: Date
  runner?: (execution: BenchmarkPromptExecution) => Promise<BenchmarkPromptRunnerResult>
}

/**
 * Gold-standard questions for madar itself.
 * Each expected_labels entry is compared after the same normalization used by
 * benchmark matching (lowercase, non-alphanumeric stripped).
 */
export const GOLD_QUESTIONS: GoldQuestion[] = [
  {
    question: 'how does louvain clustering work',
    expected_labels: ['cluster', 'louvainpass'],
  },
  {
    question: 'how does the retrieve MCP tool find relevant nodes',
    expected_labels: ['retrievecontext', 'scorenode'],
  },
  {
    question: 'retrieveContext',
    expected_labels: ['retrievecontext'],
  },
  {
    question: 'how does retrieveContext build community labels',
    expected_labels: ['retrievecontext', 'buildcommunitylabels'],
  },
  {
    question: 'scoreNode',
    expected_labels: ['scorenode'],
  },
  {
    question: 'how does javascript extraction work',
    expected_labels: ['extractjs', 'extractionnode'],
  },
  {
    question: 'how does the CLI parse command arguments',
    expected_labels: ['parsegenerateargs', 'parsequeryargs'],
  },
  {
    question: 'how does impact analysis compute blast radius',
    expected_labels: ['analyzeimpact', 'impactresult'],
  },
  {
    question: 'how does the claude install command configure hooks and MCP',
    expected_labels: ['claudeinstall', 'installmcpserver'],
  },
  {
    question: 'how does community naming assign labels to clusters',
    expected_labels: ['buildcommunitylabels'],
  },
  {
    question: 'how does incremental update detect changed files',
    expected_labels: ['detectincremental'],
  },
  {
    question: 'how does the graph report get generated',
    expected_labels: ['generate', 'reportts'],
  },
]

function isExactMatch(returned: string, expected: string): boolean {
  return returned === expected
}

function normalizeGoldQuestion(question: QualityQuestionInput): GoldQuestion | null {
  const normalized = normalizeBenchmarkQuestion(question)
  const expectedLabels = normalized.expected_labels ?? []
  if (expectedLabels.length === 0) {
    return null
  }

  return {
    question: normalized.question,
    expected_labels: expectedLabels,
  }
}

interface QualityQuestionRunMetadata {
  tokens_used: number
  total_tokens: number | null
  prompt_tokens_estimated: number | null
  prompt_token_source: BenchmarkPromptTokenSource | null
  usage: PromptRunnerUsage | null
  answer_text: string | null
  elapsed_ms: number | null
  artifacts: BenchmarkPromptArtifacts | null
}

function qualityRetrieveContext(graph: KnowledgeGraph, question: string, budget: number, graphPath?: string): RetrieveResult {
  return graphPath ? retrieveBenchmarkContext(graph, graphPath, question, budget) : retrieveContext(graph, { question, budget })
}

function questionBucket(question: string): string {
  const normalized = question.toLowerCase()
  if (/\b(route|routes|router|endpoint|endpoints|middleware|path)\b/.test(normalized) || /\/[a-z0-9[_\]:/-]+/i.test(question)) {
    return 'routing'
  }
  if (/\b(slice|slices|selector|selectors|store|stores|state|reducer|reducers)\b/.test(normalized)) {
    return 'state'
  }
  if (/\b(controller|controllers|service|services|module|modules|provider|providers|guard|guards|interceptor|interceptors|pipe|pipes)\b/.test(normalized)) {
    return 'backend'
  }
  if (/\b(page|pages|layout|layouts|component|components|client|server|template|templates|loading|error|screen|screens)\b/.test(normalized)) {
    return 'ui'
  }
  return 'general'
}

function buildQualityResult(gold: GoldQuestion, result: RetrieveResult, metadata: QualityQuestionRunMetadata): QualityResult {
  const expectedLabels = gold.expected_labels
  const normalizedExpectedLabels = expectedLabels.map((label) => normalizeExpectedLabel(label))
  const returnedLabels = result.matched_nodes.map((node) => normalizeExpectedLabel(node.label))

  const matchedLabels = expectedLabels.filter((expected) =>
    returnedLabels.some((returned) => isExactMatch(returned, normalizeExpectedLabel(expected))),
  )
  const missingLabels = expectedLabels.filter(
    (expected) => !returnedLabels.some((returned) => isExactMatch(returned, normalizeExpectedLabel(expected))),
  )

  // Reciprocal rank: position of first expected label in results (1-indexed)
  let reciprocalRank = 0
  for (let i = 0; i < returnedLabels.length; i++) {
    const returned = returnedLabels[i]
    if (returned === undefined) continue
    if (expectedLabels.some((expected) => isExactMatch(returned, normalizeExpectedLabel(expected)))) {
      reciprocalRank = 1 / (i + 1)
      break
    }
  }

  const precision = returnedLabels.length > 0 ? matchedLabels.length / returnedLabels.length : 0
  const recall = expectedLabels.length > 0 ? matchedLabels.length / expectedLabels.length : 0
  const snippetCoverage =
    result.matched_nodes.length > 0
      ? result.matched_nodes.filter((node) => typeof node.snippet === 'string' && node.snippet.trim().length > 0).length / result.matched_nodes.length
      : 0
  const groundedMatches = result.matched_nodes.filter((node) => (
    normalizedExpectedLabels.includes(normalizeExpectedLabel(node.label)) &&
    typeof node.snippet === 'string' &&
    node.snippet.trim().length > 0
  )).length
  const groundedMatchRate = expectedLabels.length > 0 ? groundedMatches / expectedLabels.length : 0

  return {
    question: gold.question,
    bucket: questionBucket(gold.question),
    expected_labels: expectedLabels,
    returned_labels: result.matched_nodes.map((node) => node.label),
    matched_labels: matchedLabels,
    missing_labels: missingLabels,
    precision,
    recall,
    reciprocal_rank: reciprocalRank,
    snippet_coverage: snippetCoverage,
    grounded_match_rate: groundedMatchRate,
    tokens_used: metadata.tokens_used,
    total_tokens: metadata.total_tokens,
    prompt_tokens_estimated: metadata.prompt_tokens_estimated,
    prompt_token_source: metadata.prompt_token_source,
    usage: metadata.usage,
    answer_text: metadata.answer_text,
    elapsed_ms: metadata.elapsed_ms,
    artifacts: metadata.artifacts,
  }
}

function evaluateQuestion(graph: KnowledgeGraph, gold: GoldQuestion, budget: number, graphPath?: string): QualityResult {
  const result = qualityRetrieveContext(graph, gold.question, budget, graphPath)
  return buildQualityResult(gold, result, {
    tokens_used: result.token_count,
    total_tokens: null,
    prompt_tokens_estimated: null,
    prompt_token_source: null,
    usage: null,
    answer_text: null,
    elapsed_ms: null,
    artifacts: null,
  })
}

async function evaluateRunnerBackedQuestion(
  graph: KnowledgeGraph,
  gold: GoldQuestion,
  budget: number,
  options: QualityOptions & { execTemplate: string },
): Promise<QualityResult> {
  const graphPath = resolveWorkspaceGraphPath(options.graphPath ?? 'out/graph.json')
  const retrieval = qualityRetrieveContext(graph, gold.question, budget, graphPath)
  const run = await runBenchmarkPrompt({
    graphPath,
    graph,
    question: gold.question,
    execTemplate: options.execTemplate,
    retrieval,
    retrievalBudget: budget,
    ...(options.outputDir !== undefined ? { outputDir: options.outputDir } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.runner !== undefined ? { runner: options.runner } : {}),
  })

  return buildQualityResult(gold, retrieval, {
    tokens_used: run.query_tokens,
    total_tokens: run.total_tokens,
    prompt_tokens_estimated: run.prompt_tokens_estimated,
    prompt_token_source: run.prompt_token_source,
    usage: run.usage,
    answer_text: run.answer_text,
    elapsed_ms: run.elapsed_ms,
    artifacts: run.artifacts,
  })
}

function buildQualityReport(
  graph: KnowledgeGraph,
  results: QualityResult[],
  skippedQuestions: number,
  options: QualityOptions,
): QualityReport {
  const withHits = results.filter((r) => r.matched_labels.length > 0)
  const avgTokens = results.length > 0 ? Math.floor(results.reduce((sum, r) => sum + r.tokens_used, 0) / results.length) : 0
  const baseline = resolveCorpusBaseline(graph.numberOfNodes(), options)
  const bucketSummaries = [...new Set(results.map((result) => result.bucket))]
    .map((bucket) => {
      const bucketResults = results.filter((result) => result.bucket === bucket)
      return {
        bucket,
        questions: bucketResults.length,
        avg_recall: bucketResults.reduce((sum, result) => sum + result.recall, 0) / bucketResults.length,
        mrr: bucketResults.reduce((sum, result) => sum + result.reciprocal_rank, 0) / bucketResults.length,
        avg_snippet_coverage: bucketResults.reduce((sum, result) => sum + result.snippet_coverage, 0) / bucketResults.length,
        avg_grounded_match_rate: bucketResults.reduce((sum, result) => sum + result.grounded_match_rate, 0) / bucketResults.length,
      } satisfies QualityBucketSummary
    })
    .sort((left, right) => left.bucket.localeCompare(right.bucket))

  return {
    questions: results,
    skipped_questions: skippedQuestions,
    avg_precision: results.length > 0 ? results.reduce((sum, r) => sum + r.precision, 0) / results.length : 0,
    avg_recall: results.length > 0 ? results.reduce((sum, r) => sum + r.recall, 0) / results.length : 0,
    mrr: results.length > 0 ? results.reduce((sum, r) => sum + r.reciprocal_rank, 0) / results.length : 0,
    avg_snippet_coverage: results.length > 0 ? results.reduce((sum, r) => sum + r.snippet_coverage, 0) / results.length : 0,
    avg_grounded_match_rate: results.length > 0 ? results.reduce((sum, r) => sum + r.grounded_match_rate, 0) / results.length : 0,
    questions_with_hits: withHits.length,
    total_questions: results.length,
    avg_tokens_used: avgTokens,
    avg_total_tokens: averageReportedTotalTokens(results),
    corpus_tokens: baseline.tokens,
    corpus_source: baseline.source,
    compression_ratio: avgTokens > 0 ? Number((baseline.tokens / avgTokens).toFixed(1)) : 0,
    bucket_summaries: bucketSummaries,
  }
}

export function evaluateRetrievalQuality(
  graph: KnowledgeGraph,
  questions: ReadonlyArray<QualityQuestionInput> | undefined,
  budget: number | undefined,
  options: QualityOptions & { execTemplate: string },
): Promise<QualityReport>
export function evaluateRetrievalQuality(
  graph: KnowledgeGraph,
  questions?: ReadonlyArray<QualityQuestionInput>,
  budget?: number,
  options?: QualityOptions,
): QualityReport
export function evaluateRetrievalQuality(
  graph: KnowledgeGraph,
  questions: ReadonlyArray<QualityQuestionInput> = GOLD_QUESTIONS,
  budget = 3000,
  options: QualityOptions = {},
): QualityReport | Promise<QualityReport> {
  const effectiveOptions = options.graphPath
    ? { ...options, graphPath: resolveWorkspaceGraphPath(options.graphPath) }
    : options
  const normalizedQuestions = questions.map((question) => normalizeGoldQuestion(question))
  const skippedQuestions = normalizedQuestions.filter((question) => question === null).length
  const labeledQuestions = normalizedQuestions.filter((question): question is GoldQuestion => question !== null)
  if (!options.execTemplate) {
    const results = labeledQuestions.map((question) => evaluateQuestion(graph, question, budget, effectiveOptions.graphPath))
    return buildQualityReport(graph, results, skippedQuestions, effectiveOptions)
  }

  return (async () => {
    const results: QualityResult[] = []
    for (const question of labeledQuestions) {
      results.push(await evaluateRunnerBackedQuestion(graph, question, budget, effectiveOptions as QualityOptions & { execTemplate: string }))
    }
    return buildQualityReport(graph, results, skippedQuestions, effectiveOptions)
  })()
}

export function formatQualityReport(report: QualityReport): string {
  const corpusNote = report.corpus_source === 'estimated' ? ' estimated' : ''
  const lines = [
    '',
    'madar retrieval quality benchmark',
    '─'.repeat(50),
    `  Questions:    ${report.questions_with_hits}/${report.total_questions} found expected nodes`,
    ...(report.skipped_questions > 0 ? [`  Skipped:      ${report.skipped_questions} unlabeled question(s) missing expected_labels`] : []),
    `  Recall:       ${(report.avg_recall * 100).toFixed(1)}%`,
    `  MRR:          ${report.mrr.toFixed(3)}`,
    `  Snippet coverage: ${(report.avg_snippet_coverage * 100).toFixed(1)}%`,
    `  Grounded match rate: ${(report.avg_grounded_match_rate * 100).toFixed(1)}%`,
  ]

  if (report.avg_tokens_used > 0) {
    const compressionSummary =
      report.corpus_tokens >= report.avg_tokens_used
        ? `${formatTokenRatio(report.corpus_tokens, report.avg_tokens_used)} tokens with ${(report.avg_recall * 100).toFixed(0)}% recall`
        : `not achieved (${formatTokenRatio(report.corpus_tokens, report.avg_tokens_used)} tokens with ${(report.avg_recall * 100).toFixed(0)}% recall)`
    lines.push(`  ${averageInputTokenLabel(report.questions)}: ~${report.avg_tokens_used.toLocaleString()} per query (vs ~${report.corpus_tokens.toLocaleString()}${corpusNote} naive corpus)`)
    if (report.avg_total_tokens !== null) {
      lines.push(`  Avg total tokens (${usageProviderLabel(report.questions)} reported): ~${report.avg_total_tokens.toLocaleString()}`)
    }
    const usageSummary = usageCaptureSummary(report.questions, 'evaluated questions')
    if (usageSummary) {
      lines.push(`  Usage capture: ${usageSummary}`)
    }
    lines.push(`  Compression:  ${compressionSummary}`)
  }

  if (report.bucket_summaries.length > 0) {
    lines.push('  Query buckets:')
    for (const bucket of report.bucket_summaries) {
      lines.push(
        `    - ${bucket.bucket}: recall ${(bucket.avg_recall * 100).toFixed(0)}%, MRR ${bucket.mrr.toFixed(3)}, snippets ${(bucket.avg_snippet_coverage * 100).toFixed(0)}%, grounded ${(bucket.avg_grounded_match_rate * 100).toFixed(0)}%`,
      )
    }
  }

  lines.push('')
  lines.push('  Per question:')
  for (const r of report.questions) {
    const status = r.recall === 1 ? '+' : r.recall > 0 ? '~' : 'x'
    const recallPct = (r.recall * 100).toFixed(0)
    lines.push(`    ${status} [recall ${recallPct}%] ${r.question}${promptTokenSourceSuffix(r.prompt_token_source)}`)
    if (r.missing_labels.length > 0) {
      lines.push(`      missing: ${r.missing_labels.join(', ')}`)
    }
  }
  lines.push('')

  return lines.join('\n')
}
