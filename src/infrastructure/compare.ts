import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { KnowledgeGraph } from '../contracts/graph.js'
import type { ContextSessionState } from '../contracts/context-session.js'
import { buildContextPrompt, type ContextPromptStableSection } from './context-prompt.js'
import { CODE_EXTENSIONS, DOC_EXTENSIONS, MANIFEST_METADATA_KEY, OFFICE_EXTENSIONS, PAPER_EXTENSIONS } from '../pipeline/detect.js'
import { extractCompareBaselineNonCodeText } from '../pipeline/extract/non-code.js'
import { loadBenchmarkQuestions } from './benchmark/questions.js'
import { parsePromptRunnerOutput, type PromptRunnerUsage } from './prompt-runner.js'
import { retrieveContext, tokenizeLabel, type RetrieveResult } from '../runtime/retrieve.js'
import { QUERY_TOKEN_ESTIMATOR, estimateQueryTokens, loadGraph } from '../runtime/serve.js'
import { sidecarAwareFileFingerprint } from '../shared/binary-ingest-sidecar.js'
import { MAX_TEXT_BYTES, validateGraphOutputPath, validateGraphPath } from '../shared/security.js'

export type CompareBaselineMode = 'full' | 'bounded' | 'native_agent'
export type CompareRunMode = 'baseline' | 'graphify'
export type CompareRunStatus = 'not_run' | 'succeeded' | 'failed' | 'context_overflow'
export type CompareFailureReason = 'prompt_too_long' | 'runner_error' | 'exec_error'
export type ComparePromptTokenSource = 'estimated_cl100k_base' | 'claude_reported_input' | 'gemini_reported_input'

export interface ComparePromptProviderProofEntry {
  provider: 'claude' | 'gemini' | null
  input_tokens_source: ComparePromptTokenSource
  effective_tokens_source: 'provider_cache_read_tokens' | 'provider_input_minus_zero_cache' | 'session_reuse_estimate'
  total_tokens_source: 'provider_reported_total' | 'not_available'
}

export interface ComparePromptProviderProof {
  baseline: ComparePromptProviderProofEntry
  graphify: ComparePromptProviderProofEntry
  reduction_basis: 'provider_reported' | 'mixed' | 'estimated'
}

export interface ComparePromptPack {
  kind: 'baseline' | 'graphify'
  question: string
  prompt: string
  session_payload: string
  token_count: number
  session_payload_token_count: number
  effective_token_count: number
  reused_context_tokens: number
  session_state: ContextSessionState
}

export interface BuildBaselinePromptPackInput {
  question: string
  graph: KnowledgeGraph
  corpusText: string
  mode: CompareBaselineMode
  maxTokens?: number
  session?: ContextSessionState
}

export interface BuildGraphifyPromptPackInput {
  question: string
  retrieval: RetrieveResult
  session?: ContextSessionState
}

export interface ComparePromptArtifactPaths {
  output_dir: string
  baseline_prompt: string
  graphify_prompt: string
  report: string
}

export interface CompareAnswerArtifactPaths {
  baseline: string
  graphify: string
}

export interface CompareExecCommandSummary {
  command: string | null
  placeholders: string[]
  redacted: true
}

export interface ComparePromptTokenEstimator {
  source: string
  model: string
  exact: boolean
}

export type ComparePromptUsage = PromptRunnerUsage

export interface ComparePromptReport {
  question: string
  graph_path: string
  exec_command: CompareExecCommandSummary
  baseline_mode: CompareBaselineMode
  baseline_prompt_tokens: number
  graphify_prompt_tokens: number
  reduction_ratio: number
  baseline_effective_prompt_tokens: number
  graphify_effective_prompt_tokens: number
  effective_reduction_ratio: number
  baseline_reused_context_tokens: number
  graphify_reused_context_tokens: number
  baseline_total_tokens: number | null
  graphify_total_tokens: number | null
  total_reduction_ratio: number | null
  baseline_prompt_tokens_estimated: number
  graphify_prompt_tokens_estimated: number
  reduction_ratio_estimated: number
  prompt_token_estimator: ComparePromptTokenEstimator
  prompt_token_source: {
    baseline: ComparePromptTokenSource
    graphify: ComparePromptTokenSource
  }
  usage: {
    baseline: ComparePromptUsage | null
    graphify: ComparePromptUsage | null
  }
  started_at: string
  completed_at: string
  elapsed_ms: {
    baseline: number
    graphify: number
  }
  status: {
    baseline: CompareRunStatus
    graphify: CompareRunStatus
  }
  answer_paths: CompareAnswerArtifactPaths
  exit_code: {
    baseline: number | null
    graphify: number | null
  }
  stderr: {
    baseline: string | null
    graphify: string | null
  }
  failure_reason: {
    baseline: CompareFailureReason | null
    graphify: CompareFailureReason | null
  }
  evidence: {
    baseline: string | null
    graphify: string | null
  }
  provider_proof?: ComparePromptProviderProof
  paths: ComparePromptArtifactPaths
}

export interface GenerateCompareArtifactsInput {
  graphPath: string
  question?: string | null
  questionsPath?: string | null
  outputDir: string
  execTemplate: string
  baselineMode: CompareBaselineMode
  corpusText?: string
  limit?: number | null
  retrievalBudget?: number
  baselineMaxTokens?: number
  now?: Date
}

export interface GenerateCompareArtifactsResult {
  graph_path: string
  output_root: string
  reports: ComparePromptReport[]
}

export interface CompareExecTemplateValues {
  promptFile: string
  question: string
  mode: CompareRunMode
  outputFile: string
}

export interface ComparePromptExecution {
  mode: CompareRunMode
  question: string
  promptFile: string
  outputFile: string
  command: string
}

export interface ComparePromptRunnerResult {
  exitCode: number
  stdout: string
  stderr: string
  elapsedMs: number
}

export interface ExecuteCompareRunsDependencies {
  runner?: (execution: ComparePromptExecution) => Promise<ComparePromptRunnerResult>
  now?: () => Date
}

const DEFAULT_RETRIEVAL_BUDGET = 3_000
const DEFAULT_BOUNDED_BASELINE_TOKENS = 4_000
const EXEC_TEMPLATE_PLACEHOLDER_PATTERN = /\{[a-z_][a-z0-9_]*\}/gi
const COMPARE_EXEC_PLACEHOLDERS = new Set(['{prompt_file}', '{question}', '{mode}', '{output_file}'])
const CONTEXT_OVERFLOW_PATTERNS = [
  /\bprompt is too long\b/i,
  /\bcontext (?:window|length) (?:exceeded|overflow|too (?:long|large|big))\b/i,
  /\b(?:maximum|max) context\b/i,
  /\btoo many tokens\b/i,
]
const PROMPT_FILE_COMMAND_SUBSTITUTION_PATTERNS = [
  /\$\([^)]*\{prompt_file\}[^)]*\)/i,
  /`[^`]*\{prompt_file\}[^`]*`/i,
]

function timestampDirectoryName(date: Date): string {
  const iso = date.toISOString()
  return iso.slice(0, 19).replace(/:/g, '-')
}

function summarizeExecTemplate(execTemplate: string): CompareExecCommandSummary {
  const placeholders = [...execTemplate.matchAll(EXEC_TEMPLATE_PLACEHOLDER_PATTERN)].map((match) => match[0])

  return {
    command: null,
    placeholders: [...new Set(placeholders)],
    redacted: true,
  }
}

function validateCompareExecTemplate(template: string): void {
  if (PROMPT_FILE_COMMAND_SUBSTITUTION_PATTERNS.some((pattern) => pattern.test(template))) {
    throw new Error(
      'Exec templates must not expand {prompt_file} with shell command substitution. Use stdin or file redirection with {prompt_file}, for example: cat {prompt_file} | claude -p',
    )
  }
}

function shellEscape(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `'${value.replaceAll("'", "''")}'`
  }
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

export function expandCompareExecTemplate(
  template: string,
  values: CompareExecTemplateValues,
  platform: NodeJS.Platform = process.platform,
): string {
  return template.replaceAll(EXEC_TEMPLATE_PLACEHOLDER_PATTERN, (placeholder) => {
    const normalizedPlaceholder = placeholder.toLowerCase()
    if (!COMPARE_EXEC_PLACEHOLDERS.has(normalizedPlaceholder)) {
      throw new Error(`Unknown compare exec placeholder: ${placeholder}`)
    }

    if (normalizedPlaceholder === '{prompt_file}') {
      return shellEscape(values.promptFile, platform)
    }
    if (normalizedPlaceholder === '{question}') {
      return shellEscape(values.question, platform)
    }
    if (normalizedPlaceholder === '{mode}') {
      return shellEscape(values.mode, platform)
    }
    return shellEscape(values.outputFile, platform)
  })
}

function writeCompareReport(report: ComparePromptReport): void {
  writeFileSync(
    report.paths.report,
    `${JSON.stringify(
      {
        ...report,
        graph_path: portablePath(report.graph_path),
        answer_paths: {
          baseline: portablePath(report.answer_paths.baseline),
          graphify: portablePath(report.answer_paths.graphify),
        },
        paths: {
          output_dir: portablePath(report.paths.output_dir),
          baseline_prompt: portablePath(report.paths.baseline_prompt),
          graphify_prompt: portablePath(report.paths.graphify_prompt),
          report: portablePath(report.paths.report),
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

async function defaultComparePromptRunner(execution: ComparePromptExecution): Promise<ComparePromptRunnerResult> {
  const startedAt = Date.now()

  return await new Promise<ComparePromptRunnerResult>((resolveExecution, rejectExecution) => {
    const command =
      process.platform === 'win32'
        ? {
            file: 'powershell.exe',
            args: ['-NoProfile', '-Command', execution.command],
          }
        : {
            file: '/bin/sh',
            args: ['-lc', execution.command],
          }
    const child = spawn(command.file, command.args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk: string | Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: string | Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      rejectExecution(error)
    })
    child.on('close', (code) => {
      resolveExecution({
        exitCode: code ?? 1,
        stdout,
        stderr,
        elapsedMs: Date.now() - startedAt,
      })
    })
  })
}

function answerFilePath(outputDir: string, mode: CompareRunMode): string {
  return join(outputDir, `${mode}-answer.txt`)
}

function ensureCompareAnswerFile(filePath: string, stdout: string): void {
  if (existsSync(filePath)) {
    return
  }
  writeFileSync(filePath, stdout, 'utf8')
}

function sanitizeCompareStderr(stderr: string): string | null {
  const trimmed = stderr.trim()
  if (!trimmed) {
    return null
  }

  const redacted = trimmed
    .replaceAll(/\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*)=([^\s]+)/gi, '$1=[REDACTED]')
    .replaceAll(/(Bearer)\s+[^\s]+/gi, '$1 [REDACTED]')
  const maxLength = 2_000
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength).trimEnd()}\n…[truncated]` : redacted
}

function summarizeCompareRunnerStderr(stderr: string): string | null {
  const sanitized = sanitizeCompareStderr(stderr)
  if (sanitized === null) {
    return null
  }
  return `stderr omitted for safety (${sanitized.length} chars captured)`
}

function extractContextOverflowEvidence(...messages: string[]): string | null {
  const combined = messages.map((message) => message.trim()).filter((message) => message.length > 0).join('\n')
  if (!CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(combined))) {
    return null
  }

  const matchingLine = combined.split(/\r?\n/).find((line) => CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(line))) ?? combined
  return sanitizeCompareStderr(matchingLine)
}

function createCompareOutputRoot(outputDir: string, date: Date): string {
  mkdirSync(outputDir, { recursive: true })

  const timestampDirectory = timestampDirectoryName(date)
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidate = join(
      outputDir,
      suffix === 0 ? timestampDirectory : `${timestampDirectory}-${String(suffix).padStart(3, '0')}`,
    )

    try {
      mkdirSync(candidate)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue
      }
      throw error
    }
  }

  throw new Error(`Unable to create a unique compare output directory inside ${outputDir}`)
}

function baselinePromptSections(graph: KnowledgeGraph, corpusBody: string, mode: CompareBaselineMode): ContextPromptStableSection[] {
  return [
    {
      ref: 'graph_summary',
      sort_key: '10-graph-summary',
      title: 'Project graph summary',
      body: [
        `- Nodes: ${graph.numberOfNodes()}`,
        `- Edges: ${graph.numberOfEdges()}`,
      ].join('\n'),
    },
    {
      ref: 'project_corpus',
      sort_key: '20-project-corpus',
      title: `Corpus (${mode})`,
      body: corpusBody,
    },
  ]
}

function buildBaselinePromptArtifact(
  question: string,
  graph: KnowledgeGraph,
  corpusBody: string,
  mode: CompareBaselineMode,
  session?: ContextSessionState,
) {
  return buildContextPrompt({
    instructions: [
      'Answer the question using only the provided project corpus.',
      'If the corpus does not contain the answer, say so.',
    ],
    stable_sections: baselinePromptSections(graph, corpusBody, mode),
    dynamic_sections: [
      { title: 'Question', body: question },
      { body: 'Answer:' },
    ],
    ...(session ? { session } : {}),
  })
}

function buildBoundedCorpusExcerpt(question: string, graph: KnowledgeGraph, corpusText: string, maxTokens: number): string {
  const note = '[bounded baseline excerpt]'
  let excerpt = corpusText.trim()
  let prompt = buildBaselinePromptArtifact(question, graph, `${note}\n${excerpt}`, 'bounded').prompt
  while (estimateQueryTokens(prompt) > maxTokens && excerpt.length > 0) {
    excerpt = excerpt.slice(0, Math.max(0, Math.floor(excerpt.length * 0.9))).trimEnd()
    prompt = buildBaselinePromptArtifact(question, graph, `${note}\n${excerpt}`, 'bounded').prompt
  }

  if (estimateQueryTokens(prompt) > maxTokens) {
    throw new Error(`Bounded baseline token budget ${maxTokens} is too small for the compare prompt floor.`)
  }

  return `${note}\n${excerpt}`.trimEnd()
}

function formatGraphifyContextSections(retrieval: RetrieveResult): ContextPromptStableSection[] {
  const nodeLines = retrieval.matched_nodes.map((node) => {
    const source = node.source_file ? ` @ ${node.source_file}${node.line_number > 0 ? `:${node.line_number}` : ''}` : ''
    const community = node.community_label ? ` [${node.community_label}]` : ''
    const snippet = node.snippet ? `\n  ${node.snippet}` : ''
    return `- ${node.label}${source}${community}${snippet}`
  })
  const relationshipLines = retrieval.relationships.map((relationship) => `- ${relationship.from} -[${relationship.relation}]-> ${relationship.to}`)
  const communityLines = retrieval.community_context.map((community) => `- ${community.label} (${community.node_count} nodes)`)
  const signalLines = [...retrieval.graph_signals.god_nodes, ...retrieval.graph_signals.bridge_nodes]

  return [
    {
      ref: 'matched_nodes',
      sort_key: '10-matched-nodes',
      title: 'Matched nodes',
      body: nodeLines.length > 0 ? nodeLines.join('\n') : '- (none)',
    },
    {
      ref: 'relationships',
      sort_key: '20-relationships',
      title: 'Relationships',
      body: relationshipLines.length > 0 ? relationshipLines.join('\n') : '- (none)',
    },
    ...(communityLines.length > 0
      ? [{
          ref: 'community_context',
          sort_key: '30-community-context',
          title: 'Community context',
          body: communityLines.join('\n'),
        }]
      : []),
    ...(signalLines.length > 0
      ? [{
          ref: 'graph_signals',
          sort_key: '40-graph-signals',
          title: 'Graph signals',
          body: `- ${signalLines.join(', ')}`,
        }]
      : []),
  ]
}

function computeReductionRatio(baselinePromptTokens: number, graphifyPromptTokens: number): number {
  if (baselinePromptTokens <= 0 || graphifyPromptTokens <= 0) {
    return 0
  }
  return Number((baselinePromptTokens / graphifyPromptTokens).toFixed(1))
}

function formatTokenComparison(baselineTokens: number, graphifyTokens: number): string {
  if (baselineTokens <= 0 || graphifyTokens <= 0) {
    return 'n/a'
  }
  if (baselineTokens === graphifyTokens) {
    return 'same size'
  }
  if (baselineTokens > graphifyTokens) {
    return `${computeReductionRatio(baselineTokens, graphifyTokens)}x smaller`
  }
  return `${Number((graphifyTokens / baselineTokens).toFixed(1))}x larger`
}

function syncComparePromptMetrics(report: ComparePromptReport): void {
  report.baseline_prompt_tokens = report.usage.baseline?.input_total_tokens ?? report.baseline_prompt_tokens_estimated
  report.graphify_prompt_tokens = report.usage.graphify?.input_total_tokens ?? report.graphify_prompt_tokens_estimated
  report.reduction_ratio = computeReductionRatio(report.baseline_prompt_tokens, report.graphify_prompt_tokens)
  report.baseline_effective_prompt_tokens =
    report.usage.baseline !== null
      ? report.usage.baseline.input_total_tokens - report.usage.baseline.cache_read_input_tokens
      : report.baseline_effective_prompt_tokens
  report.graphify_effective_prompt_tokens =
    report.usage.graphify !== null
      ? report.usage.graphify.input_total_tokens - report.usage.graphify.cache_read_input_tokens
      : report.graphify_effective_prompt_tokens
  report.effective_reduction_ratio = computeReductionRatio(
    report.baseline_effective_prompt_tokens,
    report.graphify_effective_prompt_tokens,
  )
  report.baseline_reused_context_tokens = report.usage.baseline?.cache_read_input_tokens ?? report.baseline_reused_context_tokens
  report.graphify_reused_context_tokens = report.usage.graphify?.cache_read_input_tokens ?? report.graphify_reused_context_tokens
  report.baseline_total_tokens = report.usage.baseline?.total_tokens ?? null
  report.graphify_total_tokens = report.usage.graphify?.total_tokens ?? null
  report.total_reduction_ratio =
    report.baseline_total_tokens !== null && report.graphify_total_tokens !== null
      ? computeReductionRatio(report.baseline_total_tokens, report.graphify_total_tokens)
      : null
  report.prompt_token_source.baseline = comparePromptTokenSource(report.usage.baseline)
  report.prompt_token_source.graphify = comparePromptTokenSource(report.usage.graphify)
  report.provider_proof = buildCompareProviderProof(report)
}

function comparePromptTokenSource(usage: ComparePromptUsage | null): ComparePromptTokenSource {
  if (usage === null) {
    return 'estimated_cl100k_base'
  }

  return usage.provider === 'claude' ? 'claude_reported_input' : 'gemini_reported_input'
}

function compareProviderForUsage(usage: ComparePromptUsage | null): 'claude' | 'gemini' | null {
  return usage?.provider ?? null
}

function buildCompareProviderProofEntry(
  usage: ComparePromptUsage | null,
  source: ComparePromptTokenSource,
): ComparePromptProviderProofEntry {
  return {
    provider: compareProviderForUsage(usage),
    input_tokens_source: source,
    effective_tokens_source:
      usage === null
        ? 'session_reuse_estimate'
        : usage.cache_read_input_tokens > 0
          ? 'provider_cache_read_tokens'
          : 'provider_input_minus_zero_cache',
    total_tokens_source: usage === null ? 'not_available' : 'provider_reported_total',
  }
}

function buildCompareProviderProof(report: Pick<ComparePromptReport, 'usage' | 'prompt_token_source'>): ComparePromptProviderProof {
  const baselineUsage = report.usage.baseline
  const graphifyUsage = report.usage.graphify

  return {
    baseline: buildCompareProviderProofEntry(baselineUsage, report.prompt_token_source.baseline),
    graphify: buildCompareProviderProofEntry(graphifyUsage, report.prompt_token_source.graphify),
    reduction_basis:
      baselineUsage !== null && graphifyUsage !== null
        ? 'provider_reported'
        : baselineUsage !== null || graphifyUsage !== null
          ? 'mixed'
          : 'estimated',
  }
}

function portablePath(path: string): string {
  return relative(process.cwd(), path) || '.'
}

function inferProjectRootFromGraphPath(graphPath: string): string {
  let currentPath = dirname(resolve(graphPath))

  while (dirname(currentPath) !== currentPath) {
    if (basename(currentPath) === 'graphify-out') {
      return dirname(currentPath)
    }
    currentPath = dirname(currentPath)
  }

  return dirname(resolve(graphPath))
}

function loadGraphBackedManifestFingerprints(graphPath: string): Map<string, number> {
  const manifestPath = join(dirname(resolve(graphPath)), 'manifest.json')
  if (!existsSync(manifestPath)) {
    return new Map()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
  } catch {
    throw new Error(`Compare baseline manifest is invalid: ${manifestPath}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Compare baseline manifest is invalid: ${manifestPath}`)
  }

  const manifestEntries = Object.entries(parsed as Record<string, unknown>).filter(([key]) => key !== MANIFEST_METADATA_KEY)
  for (const [, fingerprint] of manifestEntries) {
    if (typeof fingerprint !== 'number' || !Number.isFinite(fingerprint)) {
      throw new Error(`Compare baseline manifest is invalid: ${manifestPath}`)
    }
  }

  return new Map(manifestEntries.map(([filePath, fingerprint]) => [resolve(filePath), fingerprint as number]))
}

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, targetPath)
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

function isReadableCorpusPath(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase()
  return (
    CODE_EXTENSIONS.has(extension) ||
    DOC_EXTENSIONS.has(extension) ||
    PAPER_EXTENSIONS.has(extension) ||
    OFFICE_EXTENSIONS.has(extension)
  )
}

function collectGraphBackedCorpusFiles(graph: KnowledgeGraph, projectRoot: string): string[] {
  return graph.nodeEntries()
    .map(([, attributes]) => String(attributes.source_file ?? '').trim())
    .filter((sourceFile) => sourceFile.length > 0)
    .map((sourceFile) => resolve(projectRoot, sourceFile))
}

function collectBaselineCorpusFiles(graph: KnowledgeGraph, projectRoot: string, manifestFingerprints: ReadonlyMap<string, number>): string[] {
  if (manifestFingerprints.size > 0) {
    return [...manifestFingerprints.keys()]
  }

  return collectGraphBackedCorpusFiles(graph, projectRoot)
}

function resolveCompareSnippetPath(sourceFile: string, projectRoot: string): string | null {
  if (sourceFile.length === 0) {
    return null
  }

  const candidatePath = isAbsolute(sourceFile) ? sourceFile : resolve(projectRoot, sourceFile)
  const normalizedPath = existsSync(candidatePath) ? realpathSync(candidatePath) : resolve(candidatePath)

  if (isPathWithinRoot(normalizedPath, projectRoot)) {
    return normalizedPath
  }

  return null
}

function compareMatchedNodeId(node: Pick<RetrieveResult['matched_nodes'][number], 'node_id'>): string | null {
  return typeof node.node_id === 'string' && node.node_id.length > 0 ? node.node_id : null
}

function compareEntryTokens(node: Pick<RetrieveResult['matched_nodes'][number], 'label' | 'source_file' | 'line_number' | 'snippet'>): number {
  return estimateQueryTokens(`${node.label} ${node.source_file}:${node.line_number} ${node.snippet ?? ''}`)
}

function relevanceBandPriority(band: RetrieveResult['matched_nodes'][number]['relevance_band']): number {
  switch (band) {
    case 'direct':
      return 2
    case 'related':
      return 1
    default:
      return 0
  }
}

function trimCompareRetrieval(graph: KnowledgeGraph, retrieval: RetrieveResult, budget: number): RetrieveResult {
  const orderedNodes = [...retrieval.matched_nodes].sort((left, right) => {
    const leftId = compareMatchedNodeId(left)
    const rightId = compareMatchedNodeId(right)
    return (
      relevanceBandPriority(right.relevance_band) - relevanceBandPriority(left.relevance_band) ||
      (rightId ? graph.degree(rightId) : 0) - (leftId ? graph.degree(leftId) : 0) ||
      right.match_score - left.match_score
    )
  })

  const matchedNodes: RetrieveResult['matched_nodes'] = []
  const includedIds = new Set<string>()
  let tokenCount = 0

  for (const node of orderedNodes) {
    const nodeTokens = compareEntryTokens(node)
    if (tokenCount + nodeTokens > budget && matchedNodes.length > 0) {
      continue
    }

    matchedNodes.push(node)
    const nodeId = compareMatchedNodeId(node)
    if (nodeId) {
      includedIds.add(nodeId)
    }
    tokenCount += nodeTokens
  }

  const includedLabels = new Set(matchedNodes.map((node) => node.label))
  const includedCommunities = new Set(matchedNodes.flatMap((node) => (node.community === null ? [] : [node.community])))

  return {
    ...retrieval,
    token_count: tokenCount,
    matched_nodes: matchedNodes,
    relationships: retrieval.relationships.filter((relationship) => {
      if (includedIds.size > 0 && relationship.from_id && relationship.to_id) {
        return includedIds.has(relationship.from_id) && includedIds.has(relationship.to_id)
      }
      return includedLabels.has(relationship.from) && includedLabels.has(relationship.to)
    }),
    community_context: retrieval.community_context.filter((community) => includedCommunities.has(community.id)),
    graph_signals: {
      god_nodes: retrieval.graph_signals.god_nodes.filter((label) => includedLabels.has(label)),
      bridge_nodes: retrieval.graph_signals.bridge_nodes.filter((label) => includedLabels.has(label)),
    },
  }
}

function createCompareRetrievalGraph(
  graph: KnowledgeGraph,
  projectRoot: string,
): { graph: KnowledgeGraph; originalSourceFiles: Map<string, string> } {
  const retrievalGraph = new KnowledgeGraph(graph.isDirected())
  Object.assign(retrievalGraph.graph, graph.graph)

  const originalSourceFiles = new Map<string, string>()
  let outsideSourceIndex = 0
  for (const [id, attributes] of graph.nodeEntries()) {
    const sourceFile = String(attributes.source_file ?? '')
    const safeSourceFileTokens = tokenizeLabel(sourceFile)
    const { snippet: _snippet, ...nodeAttributes } = attributes
    const retrievalSourceFile =
      sourceFile.length > 0 && resolveCompareSnippetPath(sourceFile, projectRoot) === null
        ? `__compare_outside__/${
            safeSourceFileTokens.length > 0 ? safeSourceFileTokens.join('/') : 'source'
          }%${outsideSourceIndex}`
        : sourceFile
    if (retrievalSourceFile !== sourceFile) {
      outsideSourceIndex += 1
    }

    retrievalGraph.addNode(id, {
      ...nodeAttributes,
      ...(retrievalSourceFile !== sourceFile ? { source_file: retrievalSourceFile } : {}),
    })
    if (retrievalSourceFile !== sourceFile) {
      originalSourceFiles.set(retrievalSourceFile, sourceFile)
    }
  }

  for (const [source, target, attributes] of graph.edgeEntries()) {
    retrievalGraph.addEdge(source, target, attributes)
  }

  return { graph: retrievalGraph, originalSourceFiles }
}

function retrieveCompareContext(graph: KnowledgeGraph, question: string, budget: number, projectRoot: string): RetrieveResult {
  const { graph: retrievalGraph, originalSourceFiles } = createCompareRetrievalGraph(graph, projectRoot)
  const originalCwd = process.cwd()
  try {
    process.chdir(projectRoot)
    const retrieval = retrieveContext(retrievalGraph, { question, budget: Math.max(budget, 200) })
    for (const matchedNode of retrieval.matched_nodes) {
      matchedNode.source_file = originalSourceFiles.get(matchedNode.source_file) ?? matchedNode.source_file
    }
    return trimCompareRetrieval(retrievalGraph, retrieval, budget)
  } finally {
    process.chdir(originalCwd)
  }
}

function addBaselineCorpusFile(
  files: Map<string, string>,
  candidatePath: string,
  realProjectRoot: string,
  manifestFingerprints: ReadonlyMap<string, number>,
): void {
  const expectsTextContent = isReadableCorpusPath(candidatePath)
  const expectedFingerprint = manifestFingerprints.get(resolve(candidatePath))
  let absolutePath: string
  try {
    absolutePath = realpathSync(candidatePath)
  } catch {
    if (expectsTextContent) {
      throw new Error(`Compare baseline could not read graph-backed file: ${candidatePath}`)
    }
    return
  }

  if (!isPathWithinRoot(absolutePath, realProjectRoot)) {
    return
  }

  if (!isReadableCorpusPath(absolutePath)) {
    return
  }

  if (expectedFingerprint !== undefined) {
    const modifiedAt = statSync(candidatePath).mtimeMs
    if (sidecarAwareFileFingerprint(candidatePath, modifiedAt) !== expectedFingerprint) {
      throw new Error(`Compare baseline graph-backed file is out of sync with the saved graph snapshot: ${candidatePath}`)
    }
  }

  const corpusPath = relative(realProjectRoot, absolutePath).replaceAll(sep, '/')
  if (files.has(corpusPath)) {
    return
  }

  const corpusText = readBaselineCorpusFile(absolutePath)
  if (corpusText === null) {
    return
  }

  files.set(corpusPath, corpusText)
}

function readBaselineCorpusFile(filePath: string): string | null {
  const extension = extname(filePath).toLowerCase()

  if (CODE_EXTENSIONS.has(extension) || DOC_EXTENSIONS.has(extension)) {
    if (statSync(filePath).size > MAX_TEXT_BYTES) {
      return null
    }
    return readFileSync(filePath, 'utf8').trimEnd()
  }

  const nonCodeText = extractCompareBaselineNonCodeText(filePath)
  return nonCodeText
}

function deriveBaselineCorpusText(graphPath: string, graph: KnowledgeGraph): string {
  const projectRoot = inferProjectRootFromGraphPath(graphPath)
  const realProjectRoot = realpathSync(projectRoot)
  const manifestFingerprints = loadGraphBackedManifestFingerprints(graphPath)
  const candidateFiles = collectBaselineCorpusFiles(graph, projectRoot, manifestFingerprints)
  const files = new Map<string, string>()

  for (const candidatePath of candidateFiles) {
    addBaselineCorpusFile(files, candidatePath, realProjectRoot, manifestFingerprints)
  }

  if (files.size === 0) {
    throw new Error('Unable to derive a baseline corpus from graph-backed project files.')
  }

  return [...files.entries()]
    .flatMap(([filePath, content]) => [filePath, content, ''])
    .join('\n')
    .trimEnd()
}

export function buildBaselinePromptPack(input: BuildBaselinePromptPackInput): ComparePromptPack {
  const corpusText = input.corpusText.trim()
  const corpusBody =
    input.mode === 'bounded'
      ? buildBoundedCorpusExcerpt(input.question, input.graph, corpusText, input.maxTokens ?? DEFAULT_BOUNDED_BASELINE_TOKENS)
      : corpusText
  const builtPrompt = buildBaselinePromptArtifact(input.question, input.graph, corpusBody, input.mode, input.session)

  return {
    kind: 'baseline',
    question: input.question,
    prompt: builtPrompt.prompt,
    session_payload: builtPrompt.session_payload,
    token_count: builtPrompt.metrics.raw_prompt_tokens,
    session_payload_token_count: builtPrompt.metrics.session_payload_tokens,
    effective_token_count: builtPrompt.metrics.effective_prompt_tokens,
    reused_context_tokens: builtPrompt.metrics.reused_context_tokens,
    session_state: builtPrompt.session_state,
  }
}

export function buildGraphifyPromptPack(input: BuildGraphifyPromptPackInput): ComparePromptPack {
  const builtPrompt = buildContextPrompt({
    instructions: [
      'Answer the question using only the provided graph-guided retrieval output.',
      'If the retrieval does not contain the answer, say so.',
    ],
    stable_prefix_title: 'Retrieved graph context',
    stable_sections: formatGraphifyContextSections(input.retrieval),
    dynamic_sections: [
      { title: 'Question', body: input.question },
      { body: 'Answer:' },
    ],
    ...(input.session ? { session: input.session } : {}),
  })

  return {
    kind: 'graphify',
    question: input.question,
    prompt: builtPrompt.prompt,
    session_payload: builtPrompt.session_payload,
    token_count: builtPrompt.metrics.raw_prompt_tokens,
    session_payload_token_count: builtPrompt.metrics.session_payload_tokens,
    effective_token_count: builtPrompt.metrics.effective_prompt_tokens,
    reused_context_tokens: builtPrompt.metrics.reused_context_tokens,
    session_state: builtPrompt.session_state,
  }
}

export function resolveCompareQuestions(options: Pick<GenerateCompareArtifactsInput, 'question' | 'questionsPath' | 'limit'>): string[] {
  if (options.question !== undefined && options.question !== null && options.questionsPath !== undefined && options.questionsPath !== null) {
    throw new Error('Compare runtime accepts either a single question or a questions path, but not both.')
  }

  if (options.limit !== undefined && options.limit !== null) {
    if (!Number.isInteger(options.limit) || options.limit <= 0) {
      throw new Error('Compare runtime limit must be a positive integer.')
    }
  }

  const rawQuestions =
    options.questionsPath !== undefined && options.questionsPath !== null
      ? loadBenchmarkQuestions(options.questionsPath).map((entry) => entry.question)
      : options.question !== undefined && options.question !== null
        ? [options.question]
        : []

  const trimmedQuestions = rawQuestions.map((question) => question.trim()).filter((question) => question.length > 0)
  if (trimmedQuestions.length === 0) {
    throw new Error('No compare questions were provided.')
  }

  if (options.limit !== undefined && options.limit !== null) {
      return trimmedQuestions.slice(0, options.limit)
  }

  return trimmedQuestions
}

export function generateCompareArtifacts(input: GenerateCompareArtifactsInput): GenerateCompareArtifactsResult {
  const graphPath = validateGraphPath(input.graphPath)
  const graph = loadGraph(graphPath)
  const corpusText = input.corpusText ?? deriveBaselineCorpusText(graphPath, graph)
  const questions = resolveCompareQuestions(input)
  const outputDir = validateGraphOutputPath(input.outputDir)
  const now = input.now ?? new Date()
  const outputRoot = createCompareOutputRoot(outputDir, now)
  let baselineSession: ContextSessionState | undefined
  let graphifySession: ContextSessionState | undefined

  const reports = questions.map((question, index) => {
    const questionOutputDir = questions.length === 1 ? outputRoot : join(outputRoot, `question-${String(index + 1).padStart(3, '0')}`)
    mkdirSync(questionOutputDir, { recursive: true })

    const baselinePrompt = buildBaselinePromptPack({
      question,
      graph,
      corpusText,
      mode: input.baselineMode,
      ...(input.baselineMaxTokens !== undefined ? { maxTokens: input.baselineMaxTokens } : {}),
      ...(baselineSession ? { session: baselineSession } : {}),
    })
    baselineSession = baselinePrompt.session_state
    const projectRoot = realpathSync(inferProjectRootFromGraphPath(graphPath))
    const retrievalBudget = input.retrievalBudget ?? DEFAULT_RETRIEVAL_BUDGET
    const retrieval = retrieveCompareContext(graph, question, retrievalBudget, projectRoot)
    const graphifyPrompt = buildGraphifyPromptPack({
      question,
      retrieval,
      ...(graphifySession ? { session: graphifySession } : {}),
    })
    graphifySession = graphifyPrompt.session_state

    const paths: ComparePromptArtifactPaths = {
      output_dir: questionOutputDir,
      baseline_prompt: join(questionOutputDir, 'baseline-prompt.txt'),
      graphify_prompt: join(questionOutputDir, 'graphify-prompt.txt'),
      report: join(questionOutputDir, 'report.json'),
    }
    const answerPaths: CompareAnswerArtifactPaths = {
      baseline: answerFilePath(questionOutputDir, 'baseline'),
      graphify: answerFilePath(questionOutputDir, 'graphify'),
    }

    const baselinePromptText = baselinePrompt.session_payload
    const graphifyPromptText = graphifyPrompt.session_payload

    writeFileSync(paths.baseline_prompt, baselinePromptText, 'utf8')
    writeFileSync(paths.graphify_prompt, graphifyPromptText, 'utf8')

    const baselinePromptTokens = baselinePrompt.token_count
    const graphifyPromptTokens = graphifyPrompt.token_count

    const report: ComparePromptReport = {
      question,
      graph_path: graphPath,
      exec_command: summarizeExecTemplate(input.execTemplate),
      baseline_mode: input.baselineMode,
      baseline_prompt_tokens: baselinePromptTokens,
      graphify_prompt_tokens: graphifyPromptTokens,
      reduction_ratio: computeReductionRatio(baselinePromptTokens, graphifyPromptTokens),
      baseline_effective_prompt_tokens: baselinePrompt.effective_token_count,
      graphify_effective_prompt_tokens: graphifyPrompt.effective_token_count,
      effective_reduction_ratio: computeReductionRatio(baselinePrompt.effective_token_count, graphifyPrompt.effective_token_count),
      baseline_reused_context_tokens: baselinePrompt.reused_context_tokens,
      graphify_reused_context_tokens: graphifyPrompt.reused_context_tokens,
      baseline_total_tokens: null,
      graphify_total_tokens: null,
      total_reduction_ratio: null,
      baseline_prompt_tokens_estimated: baselinePromptTokens,
      graphify_prompt_tokens_estimated: graphifyPromptTokens,
      reduction_ratio_estimated: computeReductionRatio(baselinePromptTokens, graphifyPromptTokens),
      prompt_token_estimator: QUERY_TOKEN_ESTIMATOR,
      prompt_token_source: {
        baseline: 'estimated_cl100k_base',
        graphify: 'estimated_cl100k_base',
      },
      usage: {
        baseline: null,
        graphify: null,
      },
      started_at: now.toISOString(),
      completed_at: now.toISOString(),
      elapsed_ms: {
        baseline: 0,
        graphify: 0,
      },
      status: {
        baseline: 'not_run',
        graphify: 'not_run',
      },
      answer_paths: answerPaths,
      exit_code: {
        baseline: null,
        graphify: null,
      },
      stderr: {
        baseline: null,
        graphify: null,
      },
      failure_reason: {
        baseline: null,
        graphify: null,
      },
      evidence: {
        baseline: null,
        graphify: null,
      },
      paths,
    }

    syncComparePromptMetrics(report)
    writeCompareReport(report)
    return report
  })

  return {
    graph_path: graphPath,
    output_root: resolve(outputRoot),
    reports,
  }
}

export async function executeCompareRuns(
  input: GenerateCompareArtifactsInput,
  dependencies: ExecuteCompareRunsDependencies = {},
): Promise<GenerateCompareArtifactsResult> {
  const result = generateCompareArtifacts(input)
  const runPrompt = dependencies.runner ?? defaultComparePromptRunner
  const now = dependencies.now ?? (() => new Date())

  for (const report of result.reports) {
    const executions: Array<{
      mode: CompareRunMode
      promptFile: string
      outputFile: string
    }> = [
      {
        mode: 'baseline',
        promptFile: report.paths.baseline_prompt,
        outputFile: report.answer_paths.baseline,
      },
      {
        mode: 'graphify',
        promptFile: report.paths.graphify_prompt,
        outputFile: report.answer_paths.graphify,
      },
    ]

    for (const execution of executions) {
      try {
        validateCompareExecTemplate(input.execTemplate)
        const command = expandCompareExecTemplate(input.execTemplate, {
          promptFile: execution.promptFile,
          question: report.question,
          mode: execution.mode,
          outputFile: execution.outputFile,
        })
        const executionResult = await runPrompt({
          ...execution,
          question: report.question,
          command,
        })
        const parsedOutput = parsePromptRunnerOutput(executionResult.stdout)
        ensureCompareAnswerFile(
          execution.outputFile,
          parsedOutput.answerText ?? '',
        )
        const contextOverflowEvidence =
          executionResult.exitCode === 0 ? null : extractContextOverflowEvidence(executionResult.stdout, executionResult.stderr)
        report.usage[execution.mode] = executionResult.exitCode === 0 ? parsedOutput.usage : null
        report.status[execution.mode] =
          executionResult.exitCode === 0 ? 'succeeded' : contextOverflowEvidence !== null ? 'context_overflow' : 'failed'
        report.elapsed_ms[execution.mode] = executionResult.elapsedMs
        report.exit_code[execution.mode] = executionResult.exitCode
        report.stderr[execution.mode] = summarizeCompareRunnerStderr(executionResult.stderr)
        report.failure_reason[execution.mode] =
          executionResult.exitCode === 0 ? null : contextOverflowEvidence !== null ? 'prompt_too_long' : 'runner_error'
        report.evidence[execution.mode] = contextOverflowEvidence
      } catch (error) {
        ensureCompareAnswerFile(execution.outputFile, '')
        report.usage[execution.mode] = null
        const errorMessage = error instanceof Error ? error.message : String(error)
        const contextOverflowEvidence = extractContextOverflowEvidence(errorMessage)
        report.status[execution.mode] = contextOverflowEvidence !== null ? 'context_overflow' : 'failed'
        report.elapsed_ms[execution.mode] = 0
        report.exit_code[execution.mode] = null
        report.stderr[execution.mode] = sanitizeCompareStderr(errorMessage)
        report.failure_reason[execution.mode] = contextOverflowEvidence !== null ? 'prompt_too_long' : 'exec_error'
        report.evidence[execution.mode] = contextOverflowEvidence
      }

      syncComparePromptMetrics(report)
      report.completed_at = now().toISOString()
      writeCompareReport(report)
    }
  }

  return result
}

function sumPromptTokens(reports: readonly ComparePromptReport[], mode: CompareRunMode): number {
  return reports.reduce((total, report) => total + (mode === 'baseline' ? report.baseline_prompt_tokens : report.graphify_prompt_tokens), 0)
}

function sumEffectivePromptTokens(reports: readonly ComparePromptReport[], mode: CompareRunMode): number {
  return reports.reduce(
    (total, report) => total + (mode === 'baseline' ? report.baseline_effective_prompt_tokens : report.graphify_effective_prompt_tokens),
    0,
  )
}

function sumReusedContextTokens(reports: readonly ComparePromptReport[], mode: CompareRunMode): number {
  return reports.reduce(
    (total, report) => total + (mode === 'baseline' ? report.baseline_reused_context_tokens : report.graphify_reused_context_tokens),
    0,
  )
}

function sumTotalTokens(reports: readonly ComparePromptReport[], mode: CompareRunMode): number | null {
  let total = 0
  for (const report of reports) {
    const value = mode === 'baseline' ? report.baseline_total_tokens : report.graphify_total_tokens
    if (value === null) {
      return null
    }
    total += value
  }
  return total
}

function countPromptRuns(reports: readonly ComparePromptReport[], status: Exclude<CompareRunStatus, 'not_run'>): number {
  return reports.reduce((total, report) => {
    const baseline = report.status.baseline === status ? 1 : 0
    const graphify = report.status.graphify === status ? 1 : 0
    return total + baseline + graphify
  }, 0)
}

function countPromptUsageRuns(reports: readonly ComparePromptReport[]): number {
  return reports.reduce((total, report) => total + (report.usage.baseline === null ? 0 : 1) + (report.usage.graphify === null ? 0 : 1), 0)
}

function usageProviderSummaryLabel(reports: readonly ComparePromptReport[]): string {
  const providers = new Set<ComparePromptUsage['provider']>()

  for (const report of reports) {
    if (report.usage.baseline !== null) {
      providers.add(report.usage.baseline.provider)
    }
    if (report.usage.graphify !== null) {
      providers.add(report.usage.graphify.provider)
    }
  }

  if (providers.size !== 1) {
    return 'Runner'
  }

  const [provider] = providers
  return provider === 'gemini' ? 'Gemini' : 'Claude'
}

function formatCompareProviderProof(result: GenerateCompareArtifactsResult): string {
  const proofs = result.reports
    .flatMap((report) => (report.provider_proof ? [report.provider_proof.baseline, report.provider_proof.graphify] : []))
  const totalRuns = result.reports.length * 2
  const providerReportedRuns = proofs.filter((proof) => proof.input_tokens_source !== 'estimated_cl100k_base').length
  const cacheReportedRuns = proofs.filter((proof) => proof.effective_tokens_source === 'provider_cache_read_tokens').length
  const zeroCacheProviderRuns = proofs.filter((proof) => proof.effective_tokens_source === 'provider_input_minus_zero_cache').length
  const totalReportedRuns = proofs.filter((proof) => proof.total_tokens_source === 'provider_reported_total').length
  const providers = [...new Set(proofs.flatMap((proof) => (proof.provider ? [proof.provider] : [])))]
  const providerLabel =
    providers.length === 1
      ? providers[0] === 'gemini'
        ? 'Gemini'
        : 'Claude'
      : 'Provider'

  if (providerReportedRuns <= 0) {
    return `local ${QUERY_TOKEN_ESTIMATOR.model} estimate + session reuse accounting`
  }

  if (providerReportedRuns === totalRuns && cacheReportedRuns === totalRuns && totalReportedRuns === totalRuns) {
    return `${providerLabel} reported input, cache, and total tokens for ${providerReportedRuns}/${totalRuns} prompt runs`
  }

  if (providerReportedRuns === totalRuns && zeroCacheProviderRuns === totalRuns && totalReportedRuns === totalRuns) {
    return `${providerLabel} reported input and total tokens; no provider cache-read tokens were reported for ${providerReportedRuns}/${totalRuns} prompt runs`
  }

  return `mixed provider-reported usage (${providerReportedRuns}/${totalRuns} prompt runs) with local estimate fallback`
}

export function formatCompareSummary(result: GenerateCompareArtifactsResult): string {
  const baselineTokens = sumPromptTokens(result.reports, 'baseline')
  const graphifyTokens = sumPromptTokens(result.reports, 'graphify')
  const baselineEffectiveTokens = sumEffectivePromptTokens(result.reports, 'baseline')
  const graphifyEffectiveTokens = sumEffectivePromptTokens(result.reports, 'graphify')
  const baselineReusedTokens = sumReusedContextTokens(result.reports, 'baseline')
  const graphifyReusedTokens = sumReusedContextTokens(result.reports, 'graphify')
  const baselineTotalTokens = sumTotalTokens(result.reports, 'baseline')
  const graphifyTotalTokens = sumTotalTokens(result.reports, 'graphify')
  const totalReductionRatio =
    baselineTotalTokens !== null && graphifyTotalTokens !== null ? computeReductionRatio(baselineTotalTokens, graphifyTotalTokens) : null
  const failedRuns = countPromptRuns(result.reports, 'failed')
  const contextOverflowRuns = countPromptRuns(result.reports, 'context_overflow')
  const succeededRuns = countPromptRuns(result.reports, 'succeeded')
  const usageRuns = countPromptUsageRuns(result.reports)
  const totalRuns = result.reports.length * 2
  const usageProviderLabel = usageProviderSummaryLabel(result.reports)
  const promptTokenLabel =
    usageRuns === totalRuns
      ? `Input tokens (${usageProviderLabel} reported)`
      : usageRuns > 0
        ? `Input tokens (${usageProviderLabel} reported where available; ${QUERY_TOKEN_ESTIMATOR.model} estimate fallback)`
        : `Prompt tokens (estimated ${QUERY_TOKEN_ESTIMATOR.model})`

  // Lead with run-shape signal (succeeded/overflow/failed counts). When baseline
  // mode is full/bounded, the comparison is against a constructed baseline prompt
  // (not a real agent's behavior) so reduction_ratio is a synthetic estimate;
  // append an explicit disclosure line. native_agent mode is preferred for shipping.
  const baselineModes = new Set<CompareBaselineMode>(result.reports.map((report) => report.baseline_mode))
  const usesSyntheticBaseline = baselineModes.has('full') || baselineModes.has('bounded')

  const lines = [
    `[graphify compare] completed ${result.reports.length} question(s)`,
    `- Output: ${result.output_root}`,
    `- Prompt runs: ${succeededRuns} succeeded${contextOverflowRuns > 0 ? ` · ${contextOverflowRuns} context overflow` : ''}${
      failedRuns > 0 ? ` · ${failedRuns} failed` : ''
    }`,
    `- ${promptTokenLabel}: baseline ${baselineTokens} · graphify ${graphifyTokens} · ${formatTokenComparison(baselineTokens, graphifyTokens)}`,
    `- Effective input tokens (cache-adjusted): baseline ${baselineEffectiveTokens} · graphify ${graphifyEffectiveTokens} · ${formatTokenComparison(baselineEffectiveTokens, graphifyEffectiveTokens)}`,
  ]

  if (usesSyntheticBaseline) {
    lines.push(`- Note: reduction_ratio above is a synthetic prompt-token estimate (${QUERY_TOKEN_ESTIMATOR.model}); use --baseline-mode native_agent for Anthropic-reported usage.`)
  }

  if (baselineTotalTokens !== null && graphifyTotalTokens !== null && totalReductionRatio !== null) {
    lines.push(`- Total tokens (${usageProviderLabel} reported): baseline ${baselineTotalTokens} · graphify ${graphifyTotalTokens} · ${formatTokenComparison(baselineTotalTokens, graphifyTotalTokens)}`)
  } else if (usageRuns > 0 && usageRuns < totalRuns) {
    lines.push(`- Usage capture: ${usageProviderLabel} reported usage for ${usageRuns}/${totalRuns} prompt runs; remaining runs used local estimate fallback`)
  }
  lines.push(`- Reused context tokens: baseline ${baselineReusedTokens} · graphify ${graphifyReusedTokens}`)
  lines.push(`- Provider/runtime proof: ${formatCompareProviderProof(result)}`)

  return lines.join('\n')
}

export async function runCompareCommand(
  input: GenerateCompareArtifactsInput,
  dependencies: ExecuteCompareRunsDependencies = {},
): Promise<string> {
  if (input.baselineMode === 'native_agent') {
    const nativeResult = await executeNativeAgentCompare(input, dependencies)
    const failed = nativeResult.reports.filter((report) => report.baseline.kind !== 'succeeded' || report.graphify.kind !== 'succeeded').length
    if (failed > 0) {
      throw new Error(`[graphify compare] ${failed} native_agent run(s) failed. Partial artifacts were saved under ${nativeResult.output_root}`)
    }
    return formatNativeAgentCompareSummary(nativeResult)
  }

  const result = await executeCompareRuns(input, dependencies)
  const failedRuns = countPromptRuns(result.reports, 'failed')
  if (failedRuns > 0) {
    throw new Error(`[graphify compare] ${failedRuns} prompt run(s) failed. Partial artifacts were saved under ${result.output_root}`)
  }
  return formatCompareSummary(result)
}

// ─────────────────────────────────────────────────────────────────────────────
// native_agent baseline mode
//
// Unlike `full` and `bounded`, which build synthetic baseline prompts from the
// project corpus, `native_agent` runs the user's `--exec` command twice — once
// in a snapshot-renamed environment (no graphify-out/, no .mcp.json, no
// CLAUDE.md, no .claude/) and once with those artifacts in place. We capture
// the trailing JSON `result` event from `claude --output-format json` (or any
// runner emitting the same shape), report Anthropic-billed `usage` blocks
// as-is, and compute reductions on the real numbers — not on a constructed
// baseline prompt-token count.
// ─────────────────────────────────────────────────────────────────────────────

// What to hide from the baseline agent. We hide the *graph artifacts* (graph.json,
// GRAPH_REPORT.md, graph.html) rather than the entire `graphify-out/` directory
// because the compare run writes its prompt and answer artifacts into
// `graphify-out/compare/<ts>/` — renaming the parent would make those paths
// inaccessible during the baseline run. We additionally hide `.mcp.json`,
// `CLAUDE.md`, and `.claude/` so the baseline agent has no MCP server, no
// project-level graphify rules, and no PreToolUse hooks.
const NATIVE_AGENT_SNAPSHOT_TARGETS = [
  'graphify-out/graph.json',
  'graphify-out/GRAPH_REPORT.md',
  'graphify-out/graph.html',
  '.mcp.json',
  'CLAUDE.md',
  '.claude',
] as const

export interface AnthropicUsageBlock {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
}

export interface AnthropicResultEvent {
  model: string | null
  num_turns: number
  duration_ms: number
  total_cost_usd: number | null
  result: string | null
  usage: AnthropicUsageBlock
}

export type NativeAgentRunStatus =
  | { kind: 'succeeded'; model: string | null; usage: AnthropicUsageBlock; total_input_tokens_anthropic_exact: number; total_cost_usd: number | null; num_turns: number; duration_ms: number; result_path: string }
  | { kind: 'runner_error'; evidence: string | null; exit_code: number | null; stderr: string | null }

export interface NativeAgentCompareReport {
  baseline_mode: 'native_agent'
  question: string
  graph_path: string
  exec_command: CompareExecCommandSummary
  baseline: NativeAgentRunStatus
  graphify: NativeAgentRunStatus
  reductions: {
    input_tokens: number | null
    num_turns: number | null
    duration_ms: number | null
    cost_usd: number | null
  } | null
  prompt_token_source: {
    baseline: 'anthropic_provider_reported' | 'unknown'
    graphify: 'anthropic_provider_reported' | 'unknown'
  }
  provider_proof?: {
    baseline: {
      provider: 'anthropic' | null
      input_tokens_source: 'anthropic_provider_reported' | 'unknown'
      effective_tokens_source: 'anthropic_provider_reported' | 'unknown'
      total_tokens_source: 'anthropic_provider_reported' | 'unknown'
    }
    graphify: {
      provider: 'anthropic' | null
      input_tokens_source: 'anthropic_provider_reported' | 'unknown'
      effective_tokens_source: 'anthropic_provider_reported' | 'unknown'
      total_tokens_source: 'anthropic_provider_reported' | 'unknown'
    }
    reduction_basis: 'provider_reported' | 'mixed' | 'unknown'
  }
  started_at: string
  completed_at: string
  paths: {
    output_dir: string
    report: string
    baseline_answer: string
    graphify_answer: string
    prompt_file: string
  }
}

export interface NativeAgentCompareResult {
  graph_path: string
  output_root: string
  reports: NativeAgentCompareReport[]
}

export interface NativeAgentRunnerInput {
  mode: CompareRunMode
  question: string
  promptFile: string
  outputFile: string
  command: string
}

export interface NativeAgentRunnerResult {
  exitCode: number
  stdout: string
  stderr: string
  elapsedMs: number
}

export type NativeAgentRunner = (input: NativeAgentRunnerInput) => Promise<NativeAgentRunnerResult>

export interface ExecuteNativeAgentCompareDependencies {
  runner?: NativeAgentRunner
  now?: () => Date
}

function isAnthropicUsageBlock(value: unknown): value is AnthropicUsageBlock {
  if (!value || typeof value !== 'object') {
    return false
  }
  const usage = value as Record<string, unknown>
  return (
    typeof usage.input_tokens === 'number' &&
    typeof usage.cache_creation_input_tokens === 'number' &&
    typeof usage.cache_read_input_tokens === 'number' &&
    typeof usage.output_tokens === 'number'
  )
}

/**
 * Parse the trailing JSON event from `claude --output-format json` (or stream-json)
 * stdout. Returns null when no parseable trailing object with a usage block
 * exists, so the caller can classify the run as runner_error.
 */
export function parseAnthropicResultEvent(stdout: string): AnthropicResultEvent | null {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    return null
  }

  // Try parsing the full stdout first (non-stream mode), then fall back to
  // reading the last JSON-looking line (stream-json mode).
  const candidates: string[] = []
  try {
    JSON.parse(trimmed)
    candidates.push(trimmed)
  } catch {
    // not a single object — fall through to line-mode
  }
  if (candidates.length === 0) {
    const lines = trimmed.split(/\r?\n/).reverse()
    for (const line of lines) {
      const stripped = line.trim()
      if (stripped.startsWith('{') && stripped.endsWith('}')) {
        candidates.push(stripped)
        break
      }
    }
  }

  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') {
      continue
    }
    const obj = parsed as Record<string, unknown>
    if (!isAnthropicUsageBlock(obj.usage)) {
      continue
    }
    return {
      model: typeof obj.model === 'string' ? obj.model : null,
      num_turns: typeof obj.num_turns === 'number' ? obj.num_turns : 0,
      duration_ms: typeof obj.duration_ms === 'number' ? obj.duration_ms : 0,
      total_cost_usd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null,
      result: typeof obj.result === 'string' ? obj.result : null,
      usage: obj.usage,
    }
  }

  return null
}

interface SnapshotRecord {
  backupPath: string
  originalPath: string
}

function snapshotGraphifyArtifacts(projectRoot: string, timestamp: string): SnapshotRecord[] {
  const records: SnapshotRecord[] = []
  for (const target of NATIVE_AGENT_SNAPSHOT_TARGETS) {
    const original = join(projectRoot, target)
    if (!existsSync(original)) {
      continue
    }
    const backup = `${original}.compare-bak-${timestamp}`
    renameSync(original, backup)
    records.push({ backupPath: backup, originalPath: original })
  }
  return records
}

function restoreGraphifyArtifacts(records: readonly SnapshotRecord[]): void {
  // Walk in reverse so any nested entries restore atomically. Each rename is
  // best-effort; a partial restore is logged via stderr but never throws,
  // because this runs from finally{} blocks where throwing would mask the real
  // error.
  for (const record of [...records].reverse()) {
    if (!existsSync(record.backupPath)) {
      continue
    }
    try {
      if (existsSync(record.originalPath)) {
        rmSync(record.originalPath, { recursive: true, force: true })
      }
      renameSync(record.backupPath, record.originalPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[graphify compare native_agent] restore failed for ${record.originalPath}: ${message}\n`)
    }
  }
}

async function defaultNativeAgentRunner(input: NativeAgentRunnerInput): Promise<NativeAgentRunnerResult> {
  const startedAt = Date.now()

  return await new Promise<NativeAgentRunnerResult>((resolveExecution, rejectExecution) => {
    const command =
      process.platform === 'win32'
        ? { file: 'powershell.exe', args: ['-NoProfile', '-Command', input.command] }
        : { file: '/bin/sh', args: ['-lc', input.command] }
    const child = spawn(command.file, command.args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: string | Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: string | Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      rejectExecution(error)
    })
    child.on('close', (code) => {
      resolveExecution({ exitCode: code ?? 1, stdout, stderr, elapsedMs: Date.now() - startedAt })
    })
  })
}

function computeReduction(baseline: number, graphify: number): number | null {
  if (graphify <= 0 || baseline <= 0) {
    return null
  }
  return Number((baseline / graphify).toFixed(2))
}

function totalAnthropicInputTokens(usage: AnthropicUsageBlock): number {
  return usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
}

export async function executeNativeAgentCompare(
  input: GenerateCompareArtifactsInput,
  dependencies: ExecuteNativeAgentCompareDependencies = {},
): Promise<NativeAgentCompareResult> {
  if (input.baselineMode !== 'native_agent') {
    throw new Error(`executeNativeAgentCompare requires baselineMode "native_agent", got "${input.baselineMode}"`)
  }

  const graphPath = validateGraphPath(input.graphPath)
  const projectRoot = realpathSync(inferProjectRootFromGraphPath(graphPath))
  const questions = resolveCompareQuestions(input)
  const outputDir = validateGraphOutputPath(input.outputDir)
  const now = dependencies.now ?? (() => new Date())
  const timestamp = now()
  const outputRoot = createCompareOutputRoot(outputDir, timestamp)
  const runner = dependencies.runner ?? defaultNativeAgentRunner
  const reports: NativeAgentCompareReport[] = []

  for (const [index, question] of questions.entries()) {
    const questionDir = questions.length === 1 ? outputRoot : join(outputRoot, `question-${String(index + 1).padStart(3, '0')}`)
    mkdirSync(questionDir, { recursive: true })

    const promptFile = join(questionDir, 'native_agent-prompt.txt')
    writeFileSync(promptFile, question, 'utf8')
    const baselineAnswerPath = answerFilePath(questionDir, 'baseline')
    const graphifyAnswerPath = answerFilePath(questionDir, 'graphify')
    const reportPath = join(questionDir, 'report.json')

    const reportShell: NativeAgentCompareReport = {
      baseline_mode: 'native_agent',
      question,
      graph_path: graphPath,
      exec_command: summarizeExecTemplate(input.execTemplate),
      baseline: { kind: 'runner_error', evidence: null, exit_code: null, stderr: null },
      graphify: { kind: 'runner_error', evidence: null, exit_code: null, stderr: null },
      reductions: null,
      prompt_token_source: {
        baseline: 'unknown',
        graphify: 'unknown',
      },
      provider_proof: {
        baseline: {
          provider: null,
          input_tokens_source: 'unknown',
          effective_tokens_source: 'unknown',
          total_tokens_source: 'unknown',
        },
        graphify: {
          provider: null,
          input_tokens_source: 'unknown',
          effective_tokens_source: 'unknown',
          total_tokens_source: 'unknown',
        },
        reduction_basis: 'unknown',
      },
      started_at: timestamp.toISOString(),
      completed_at: timestamp.toISOString(),
      paths: {
        output_dir: questionDir,
        report: reportPath,
        baseline_answer: baselineAnswerPath,
        graphify_answer: graphifyAnswerPath,
        prompt_file: promptFile,
      },
    }

    // Step 1: snapshot graphify artifacts and run baseline.
    const stamp = timestamp.toISOString().replace(/[^0-9]/g, '').slice(0, 14)
    let snapshot: SnapshotRecord[] = []
    let baselineCrashed: unknown = null
    try {
      snapshot = snapshotGraphifyArtifacts(projectRoot, stamp)
      const baselineCommand = expandCompareExecTemplate(input.execTemplate, {
        promptFile,
        question,
        mode: 'baseline',
        outputFile: baselineAnswerPath,
      })
      let baselineRun: NativeAgentRunnerResult | null = null
      try {
        baselineRun = await runner({ mode: 'baseline', question, promptFile, outputFile: baselineAnswerPath, command: baselineCommand })
      } catch (error) {
        baselineCrashed = error
      }
      if (baselineRun !== null) {
        const event = parseAnthropicResultEvent(baselineRun.stdout)
        if (event !== null) {
          reportShell.baseline = {
            kind: 'succeeded',
            model: event.model,
            usage: event.usage,
            total_input_tokens_anthropic_exact: totalAnthropicInputTokens(event.usage),
            total_cost_usd: event.total_cost_usd,
            num_turns: event.num_turns,
            duration_ms: event.duration_ms,
            result_path: baselineAnswerPath,
          }
          reportShell.prompt_token_source.baseline = 'anthropic_provider_reported'
          if (reportShell.provider_proof) {
            reportShell.provider_proof.baseline = {
              provider: 'anthropic',
              input_tokens_source: 'anthropic_provider_reported',
              effective_tokens_source: 'anthropic_provider_reported',
              total_tokens_source: 'anthropic_provider_reported',
            }
          }
          ensureCompareAnswerFile(baselineAnswerPath, event.result ?? baselineRun.stdout)
        } else {
          reportShell.baseline = {
            kind: 'runner_error',
            evidence: baselineRun.stdout.slice(0, 2000),
            exit_code: baselineRun.exitCode,
            stderr: sanitizeCompareStderr(baselineRun.stderr),
          }
          ensureCompareAnswerFile(baselineAnswerPath, baselineRun.stdout)
        }
      }
    } finally {
      restoreGraphifyArtifacts(snapshot)
    }

    if (baselineCrashed !== null) {
      // Persist a partial report before re-throwing so users can inspect it.
      reportShell.completed_at = now().toISOString()
      writeNativeAgentReport(reportShell)
      reports.push(reportShell)
      throw baselineCrashed instanceof Error ? baselineCrashed : new Error(String(baselineCrashed))
    }

    // Step 2: run graphify (artifacts are restored, MCP server is in place).
    const graphifyCommand = expandCompareExecTemplate(input.execTemplate, {
      promptFile,
      question,
      mode: 'graphify',
      outputFile: graphifyAnswerPath,
    })
    let graphifyRun: NativeAgentRunnerResult | null = null
    try {
      graphifyRun = await runner({ mode: 'graphify', question, promptFile, outputFile: graphifyAnswerPath, command: graphifyCommand })
    } catch (error) {
      reportShell.graphify = {
        kind: 'runner_error',
        evidence: error instanceof Error ? error.message : String(error),
        exit_code: null,
        stderr: null,
      }
      ensureCompareAnswerFile(graphifyAnswerPath, '')
    }
    if (graphifyRun !== null) {
      const event = parseAnthropicResultEvent(graphifyRun.stdout)
      if (event !== null) {
        reportShell.graphify = {
          kind: 'succeeded',
          model: event.model,
          usage: event.usage,
          total_input_tokens_anthropic_exact: totalAnthropicInputTokens(event.usage),
          total_cost_usd: event.total_cost_usd,
          num_turns: event.num_turns,
          duration_ms: event.duration_ms,
          result_path: graphifyAnswerPath,
        }
        reportShell.prompt_token_source.graphify = 'anthropic_provider_reported'
        if (reportShell.provider_proof) {
          reportShell.provider_proof.graphify = {
            provider: 'anthropic',
            input_tokens_source: 'anthropic_provider_reported',
            effective_tokens_source: 'anthropic_provider_reported',
            total_tokens_source: 'anthropic_provider_reported',
          }
        }
        ensureCompareAnswerFile(graphifyAnswerPath, event.result ?? graphifyRun.stdout)
      } else {
        reportShell.graphify = {
          kind: 'runner_error',
          evidence: graphifyRun.stdout.slice(0, 2000),
          exit_code: graphifyRun.exitCode,
          stderr: sanitizeCompareStderr(graphifyRun.stderr),
        }
        ensureCompareAnswerFile(graphifyAnswerPath, graphifyRun.stdout)
      }
    }

    // Compute reductions only when both runs reported usage.
    if (reportShell.baseline.kind === 'succeeded' && reportShell.graphify.kind === 'succeeded') {
      reportShell.reductions = {
        input_tokens: computeReduction(reportShell.baseline.total_input_tokens_anthropic_exact, reportShell.graphify.total_input_tokens_anthropic_exact),
        num_turns: computeReduction(reportShell.baseline.num_turns, reportShell.graphify.num_turns),
        duration_ms: computeReduction(reportShell.baseline.duration_ms, reportShell.graphify.duration_ms),
        cost_usd:
          reportShell.baseline.total_cost_usd !== null && reportShell.graphify.total_cost_usd !== null
            ? computeReduction(reportShell.baseline.total_cost_usd, reportShell.graphify.total_cost_usd)
            : null,
      }
    }
    if (reportShell.provider_proof) {
      reportShell.provider_proof.reduction_basis =
        reportShell.provider_proof.baseline.input_tokens_source === 'anthropic_provider_reported'
        && reportShell.provider_proof.graphify.input_tokens_source === 'anthropic_provider_reported'
          ? 'provider_reported'
          : reportShell.provider_proof.baseline.input_tokens_source === 'anthropic_provider_reported'
            || reportShell.provider_proof.graphify.input_tokens_source === 'anthropic_provider_reported'
            ? 'mixed'
            : 'unknown'
    }

    reportShell.completed_at = now().toISOString()
    writeNativeAgentReport(reportShell)
    reports.push(reportShell)
  }

  return {
    graph_path: graphPath,
    output_root: resolve(outputRoot),
    reports,
  }
}

function writeNativeAgentReport(report: NativeAgentCompareReport): void {
  writeFileSync(
    report.paths.report,
    `${JSON.stringify(
      {
        ...report,
        graph_path: portablePath(report.graph_path),
        paths: {
          output_dir: portablePath(report.paths.output_dir),
          report: portablePath(report.paths.report),
          baseline_answer: portablePath(report.paths.baseline_answer),
          graphify_answer: portablePath(report.paths.graphify_answer),
          prompt_file: portablePath(report.paths.prompt_file),
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

export function formatNativeAgentCompareSummary(result: NativeAgentCompareResult): string {
  const lines: string[] = [
    `[graphify compare] completed ${result.reports.length} native_agent question(s)`,
    `- Output: ${result.output_root}`,
  ]
  for (const report of result.reports) {
    if (report.baseline.kind !== 'succeeded' || report.graphify.kind !== 'succeeded') {
      lines.push(`- "${report.question}" → runner error (see ${portablePath(report.paths.report)})`)
      continue
    }
    const reductions = report.reductions
    lines.push(
      `- "${report.question}"`,
      `    num_turns: baseline ${report.baseline.num_turns} → graphify ${report.graphify.num_turns}${reductions?.num_turns ? ` (${reductions.num_turns}x fewer)` : ''}`,
      `    latency:   baseline ${report.baseline.duration_ms}ms → graphify ${report.graphify.duration_ms}ms${reductions?.duration_ms ? ` (${reductions.duration_ms}x faster)` : ''}`,
      `    input_tokens (Anthropic-reported): baseline ${report.baseline.total_input_tokens_anthropic_exact} → graphify ${report.graphify.total_input_tokens_anthropic_exact}${reductions?.input_tokens ? ` (${reductions.input_tokens}x less)` : ''}`,
      `    provider/runtime proof: Anthropic reported input, cache, and total tokens for both runs`,
    )
  }
  return lines.join('\n')
}
