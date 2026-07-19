import { readFileSync } from 'node:fs'

import { KnowledgeGraph } from '../../contracts/graph.js'
import type { ContextSessionDiagnostics } from '../../contracts/context-session.js'
import { bfs, estimateQueryTokens, queryGraph, scoreNodes } from '../../runtime/serve.js'

import { type PromptRunnerUsage } from '../prompt-runner.js'
import { type BenchmarkPromptArtifacts, type BenchmarkPromptTokenSource } from './runner.js'

export interface BenchmarkQuestionResult {
  id?: string
  description?: string
  question: string
  query_tokens: number
  effective_query_tokens?: number
  reused_context_tokens?: number
  session_diagnostics?: ContextSessionDiagnostics
  reduction: number
  expected_labels: string[]
  matched_expected_labels: string[]
  missing_expected_labels: string[]
  total_tokens?: number | null
  prompt_tokens_estimated?: number
  prompt_token_source?: BenchmarkPromptTokenSource
  usage?: PromptRunnerUsage | null
  answer_text?: string | null
  elapsed_ms?: number
  artifacts?: BenchmarkPromptArtifacts
}

export interface BenchmarkQuestionSpec {
  id?: string
  description?: string
  question: string
  expected_labels?: string[]
}

export type BenchmarkQuestionInput = string | BenchmarkQuestionSpec

export interface BenchmarkMissingExpectedLabels {
  question: string
  labels: string[]
}

export interface BenchmarkQuestionEvaluation {
  question: string
  result: BenchmarkQuestionResult | null
  expected_label_count: number
  matched_expected_label_count: number
  missing_expected_labels: BenchmarkMissingExpectedLabels | null
}

export function normalizeExpectedLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function normalizeBenchmarkQuestion(question: BenchmarkQuestionInput): BenchmarkQuestionSpec {
  if (typeof question === 'string') {
    return { question, expected_labels: [] }
  }
  return {
    ...(typeof question.id === 'string' && question.id.trim().length > 0 ? { id: question.id.trim() } : {}),
    ...(typeof question.description === 'string' && question.description.trim().length > 0
      ? { description: question.description.trim() }
      : {}),
    question: question.question.trim(),
    expected_labels: Array.isArray(question.expected_labels) ? question.expected_labels.filter((label) => label.trim().length > 0) : [],
  }
}

export function loadBenchmarkQuestions(questionsPath: string): BenchmarkQuestionSpec[] {
  const parsed = JSON.parse(readFileSync(questionsPath, 'utf8')) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error(`Question file must contain an array of question objects: ${questionsPath}`)
  }

  return parsed.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Question file entry ${index + 1} must be an object with question and expected_labels`)
    }

    const question = 'question' in entry ? entry.question : undefined
    if (typeof question !== 'string' || question.trim().length === 0) {
      throw new Error(`Question file entry ${index + 1} must include a non-empty question string`)
    }

    const id = 'id' in entry ? entry.id : undefined
    if (id !== undefined && (typeof id !== 'string' || id.trim().length === 0)) {
      throw new Error(`Question file entry ${index + 1} id must be a non-empty string when provided`)
    }

    const description = 'description' in entry ? entry.description : undefined
    if (description !== undefined && (typeof description !== 'string' || description.trim().length === 0)) {
      throw new Error(`Question file entry ${index + 1} description must be a non-empty string when provided`)
    }

    const expectedLabels = 'expected_labels' in entry ? entry.expected_labels : undefined
    if (expectedLabels !== undefined && (!Array.isArray(expectedLabels) || expectedLabels.some((label) => typeof label !== 'string'))) {
      throw new Error(`Question file entry ${index + 1} expected_labels must be an array of strings`)
    }

    return normalizeBenchmarkQuestion({
      ...(id !== undefined ? { id: id as string } : {}),
      ...(description !== undefined ? { description: description as string } : {}),
      question,
      ...(expectedLabels !== undefined ? { expected_labels: expectedLabels as string[] } : {}),
    })
  })
}

function querySubgraphMatch(graph: KnowledgeGraph, question: string, depth = 2): { queryTokens: number; labels: Set<string> } | null {
  const terms = question
    .split(/\s+/)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 2)
  const startNodes = scoreNodes(graph, terms).slice(0, 5).map(([, nodeId]) => nodeId)
  if (startNodes.length === 0) {
    return null
  }

  const output = queryGraph(graph, question, { depth })
  if (output.startsWith('No matching nodes found')) {
    return null
  }

  const traversal = bfs(graph, startNodes, depth, undefined, 'incident')
  const labels = new Set(
    [...traversal.visited]
      .filter((nodeId) => graph.hasNode(nodeId))
      .map((nodeId) => normalizeExpectedLabel(String(graph.nodeAttributes(nodeId).label ?? nodeId))),
  )

  return { queryTokens: estimateQueryTokens(output), labels }
}

export function querySubgraphTokens(graph: KnowledgeGraph, question: string, depth = 2): number {
  return querySubgraphMatch(graph, question, depth)?.queryTokens ?? 0
}

export function evaluateBenchmarkQuestion(graph: KnowledgeGraph, question: BenchmarkQuestionInput, corpusTokens: number, depth = 2): BenchmarkQuestionEvaluation {
  const questionSpec = normalizeBenchmarkQuestion(question)
  const expectedLabels = questionSpec.expected_labels ?? []
  const match = querySubgraphMatch(graph, questionSpec.question, depth)
  if (!match) {
    return {
      question: questionSpec.question,
      result: null,
      expected_label_count: expectedLabels.length,
      matched_expected_label_count: 0,
      missing_expected_labels: expectedLabels.length > 0 ? { question: questionSpec.question, labels: expectedLabels } : null,
    }
  }

  const matchedExpectedLabels = expectedLabels.filter((label) => match.labels.has(normalizeExpectedLabel(label)))
  const missingLabels = expectedLabels.filter((label) => !match.labels.has(normalizeExpectedLabel(label)))
  return {
    question: questionSpec.question,
    result: {
      ...(questionSpec.id ? { id: questionSpec.id } : {}),
      ...(questionSpec.description ? { description: questionSpec.description } : {}),
      question: questionSpec.question,
      query_tokens: match.queryTokens,
      reduction: Number((corpusTokens / match.queryTokens).toFixed(1)),
      expected_labels: expectedLabels,
      matched_expected_labels: matchedExpectedLabels,
      missing_expected_labels: missingLabels,
    },
    expected_label_count: expectedLabels.length,
    matched_expected_label_count: matchedExpectedLabels.length,
    missing_expected_labels: missingLabels.length > 0 ? { question: questionSpec.question, labels: missingLabels } : null,
  }
}
