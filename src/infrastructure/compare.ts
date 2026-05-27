import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { ContextPackRoutingDebug } from '../contracts/context-pack.js'
import { KnowledgeGraph } from '../contracts/graph.js'
import type { ContextSessionState } from '../contracts/context-session.js'
import { buildContextPrompt, type ContextPromptStableSection } from './context-prompt.js'
import { buildExplainPackPayload } from './context-pack-command.js'
import { CODE_EXTENSIONS, DOC_EXTENSIONS, MANIFEST_METADATA_KEY, OFFICE_EXTENSIONS, PAPER_EXTENSIONS } from '../pipeline/detect.js'
import { extractCompareBaselineNonCodeText } from '../pipeline/extract/non-code.js'
import { loadBenchmarkQuestions } from './benchmark/questions.js'
import {
  benchmarkIsolationEnabled,
  captureBenchmarkEnvironment,
  emptyBenchmarkEnvironmentContamination,
  extractEnvironmentContamination,
  type BenchmarkEnvironment,
  type BenchmarkEnvironmentContamination,
} from './benchmark/environment.js'
import { parsePromptRunnerJsonRecord, parsePromptRunnerOutput, type PromptRunnerUsage } from './prompt-runner.js'
import { classifyRetrievalLevel } from '../runtime/retrieval-gate.js'
import { compactRetrieveResult, retrieveContext, tokenizeLabel, type CompactRetrieveResult, type RetrieveResult } from '../runtime/retrieve.js'
import { buildRoutingDebug } from '../runtime/routing-debug.js'
import { QUERY_TOKEN_ESTIMATOR, estimateQueryTokens, loadGraph } from '../runtime/serve.js'
import { sidecarAwareFileFingerprint } from '../shared/binary-ingest-sidecar.js'
import { sanitizeShareSafeText, toShareSafeArtifactPath, type ShareSafePathRoots } from '../shared/share-safe-artifacts.js'
import { MAX_TEXT_BYTES, validateGraphOutputPath, validateGraphPath } from '../shared/security.js'

export type CompareBaselineMode = 'full' | 'bounded' | 'pack_only' | 'native_agent'
export type CompareRunMode = 'baseline' | 'madar'
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
  madar: ComparePromptProviderProofEntry
  reduction_basis: 'provider_reported' | 'mixed' | 'estimated'
}

export interface ComparePromptPack {
  kind: 'baseline' | 'madar'
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

export interface BuildMadarPromptPackInput {
  question: string
  retrieval: RetrieveResult
  session?: ContextSessionState
}

export interface ComparePromptArtifactPaths {
  output_dir: string
  baseline_prompt: string
  madar_prompt: string
  report: string
  share_safe_report: string
}

export interface CompareAnswerArtifactPaths {
  baseline: string
  madar: string
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

export interface CompareReportPack extends CompactRetrieveResult {
  claims?: NonNullable<RetrieveResult['claims']>
  coverage?: NonNullable<RetrieveResult['coverage']>
  selection_diagnostics?: NonNullable<RetrieveResult['selection_diagnostics']>
}

export interface CompareMadarTraceTurnSummary {
  turn: number
  tool_call_count: number
  tools: string[]
}

type CompareMadarTraceOutcome =
  | 'no_install'
  | 'madar_available_but_unused'
  | 'madar_invoked'
  | 'madar_invoked_with_followup_exploration'

export interface CompareMadarTrace {
  source: 'claude_messages_tool_use'
  summary: string
  tool_call_count: number
  tool_calls_by_name: Record<string, number>
  per_turn: CompareMadarTraceTurnSummary[]
  madar_mcp_call_count: number
  madar_mcp_calls_by_name: Record<string, number>
  context_pack_call_count: number
  focused_follow_up_tool_call_count: number
  broad_exploration_tool_call_count: number
  broad_exploration_tool_calls_by_name: Record<string, number>
  exploration_outcome: CompareMadarTraceOutcome
  exploration_summary: string
}

export type NativeAgentMeasurementValidity = 'valid' | 'degraded' | 'invalid'

interface NativeAgentInstallArtifactCheck {
  label: string
  ok: boolean
  detail: string
  path: string
}

export interface NativeAgentInstallCheck {
  verified: boolean
  artifacts: NativeAgentInstallArtifactCheck[]
}

export interface ComparePromptReport {
  question: string
  graph_path: string
  exec_command: CompareExecCommandSummary
  baseline_mode: CompareBaselineMode
  baseline_prompt_tokens: number
  madar_prompt_tokens: number
  reduction_ratio: number
  baseline_effective_prompt_tokens: number
  madar_effective_prompt_tokens: number
  effective_reduction_ratio: number
  baseline_reused_context_tokens: number
  madar_reused_context_tokens: number
  baseline_total_tokens: number | null
  madar_total_tokens: number | null
  total_reduction_ratio: number | null
  baseline_prompt_tokens_estimated: number
  madar_prompt_tokens_estimated: number
  reduction_ratio_estimated: number
  prompt_token_estimator: ComparePromptTokenEstimator
  prompt_token_source: {
    baseline: ComparePromptTokenSource
    madar: ComparePromptTokenSource
  }
  usage: {
    baseline: ComparePromptUsage | null
    madar: ComparePromptUsage | null
  }
  started_at: string
  completed_at: string
  elapsed_ms: {
    baseline: number
    madar: number
  }
  status: {
    baseline: CompareRunStatus
    madar: CompareRunStatus
  }
  answer_paths: CompareAnswerArtifactPaths
  exit_code: {
    baseline: number | null
    madar: number | null
  }
  stderr: {
    baseline: string | null
    madar: string | null
  }
  failure_reason: {
    baseline: CompareFailureReason | null
    madar: CompareFailureReason | null
  }
  evidence: {
    baseline: string | null
    madar: string | null
  }
  provider_proof?: ComparePromptProviderProof
  madar_trace?: CompareMadarTrace
  pack?: CompareReportPack
  routing?: ContextPackRoutingDebug
  paths: ComparePromptArtifactPaths
}

export interface GenerateCompareArtifactsInput {
  graphPath: string
  question?: string | null
  questionsPath?: string | null
  outputDir: string
  execTemplate: string
  baselineMode: CompareBaselineMode
  allowNoInstall?: boolean
  why?: boolean
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

function promptWantsReportGenerationCore(prompt: string): boolean {
  return /\b(?:report(?:\s+generation)?|generated\s+report|validation\s+report|final\s+report|assembly|assemble|synthesis|renderer|render|planner|research|metrics?|scor(?:e|ing)|quality(?:\s|-)?gate)\b/i.test(prompt)
}

function answerContractInstructions(retrieval: RetrieveResult): string[] {
  const answerContract = retrieval.answer_contract
  if (!answerContract) {
    return []
  }

  const instructions = [
    'Treat HTTP/controller entrypoints as trigger context, not the full answer.',
  ]

  const requiredElements = new Set(answerContract.required_elements)
  const phaseLabels = [
    ['planner_phase', 'planner'],
    ['research_phase', 'research'],
    ['assembly_phase', 'assembly'],
    ['scoring_phase', 'scoring'],
    ['report_builder_phase', 'rendering'],
  ] as const satisfies ReadonlyArray<readonly [string, string]>
  const selectedPhaseLabels: string[] = phaseLabels.flatMap(([key, label]) => requiredElements.has(key) ? [label] : [])
  if (selectedPhaseLabels.length > 0 || requiredElements.has('persistence_or_artifact_storage')) {
    const segments = [...selectedPhaseLabels]
    if (requiredElements.has('persistence_or_artifact_storage')) {
      segments.push('persistence')
    }
    instructions.push(`Follow ${segments.join(', ')} evidence before concluding the flow.`)
  } else if (requiredElements.has('main_pipeline_phases')) {
    instructions.push('Cover the main runtime pipeline phases instead of stopping at the entrypoint.')
  }

  if (requiredElements.has('queue_worker_handoff')) {
    instructions.push('Describe queue-to-worker handoffs explicitly when the flow crosses an enqueues_job boundary.')
  }

  if (answerContract.do_not_claim.includes('direct_producer_to_worker_calls_without_enqueues_boundary')) {
    instructions.push('Do not collapse producer-to-worker handoffs into direct calls when the evidence is an enqueues_job boundary.')
  }

  if (
    answerContract.uncertainty_notes?.includes('mention missing or uncertain phases when the execution slice is partial')
    || answerContract.do_not_claim.includes('full_runtime_certainty_when_slice_is_partial')
  ) {
    instructions.push('Mention missing or uncertain phases when the execution slice is partial.')
  }

  if (answerContract.do_not_claim.includes('irrelevant_model_or_provider_details')) {
    instructions.push('Do not mention model or provider details unless they are directly relevant to the question.')
  }

  return instructions
}

function generationCoreInstructions(question: string, retrieval: RetrieveResult): string[] {
  const contractInstructions = answerContractInstructions(retrieval)
  if (contractInstructions.length > 0) {
    return contractInstructions
  }

  if (
    retrieval.retrieval_gate?.signals.generation_intent !== 'runtime_generation'
    || retrieval.retrieval_gate?.signals.target_domain_hint !== 'backend_runtime'
    || !promptWantsReportGenerationCore(question)
  ) {
    return []
  }

  return [
    'Treat HTTP/controller entrypoints as trigger context, not the full answer, when downstream generation-core evidence is present.',
    'Follow planner, research, assembly, scoring, rendering, and persistence evidence before concluding the flow.',
  ]
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
  const shareSafeRoots = {
    artifactRoot: report.paths.output_dir,
    projectRoot: inferProjectRootFromGraphPath(report.graph_path),
  }
  const serializedReport = {
    ...report,
    graph_path: portablePath(report.graph_path),
    answer_paths: {
      baseline: portablePath(report.answer_paths.baseline),
      madar: portablePath(report.answer_paths.madar),
    },
    paths: {
      output_dir: portablePath(report.paths.output_dir),
      baseline_prompt: portablePath(report.paths.baseline_prompt),
      madar_prompt: portablePath(report.paths.madar_prompt),
      report: portablePath(report.paths.report),
      share_safe_report: portablePath(report.paths.share_safe_report),
    },
  }
  const shareSafeReport = sanitizeCompareShareSafeValue(report, shareSafeRoots)

  writeFileSync(
    report.paths.report,
    `${JSON.stringify(serializedReport, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    report.paths.share_safe_report,
    `${JSON.stringify(shareSafeReport, null, 2)}\n`,
    'utf8',
  )
}

function isAbsolutePathLike(value: string): boolean {
  const normalized = value.replaceAll('\\', '/')
  return normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
}

function compareShareSafePathRoots(path: readonly string[], roots: ShareSafePathRoots): string[] {
  const key = path[path.length - 1]
  const parentKey = path[path.length - 2]

  if (parentKey === 'paths' || parentKey === 'answer_paths') {
    return [roots.artifactRoot]
  }

  if (key === 'graph_path' || key === 'source_file' || key === 'focus_files') {
    return [roots.projectRoot]
  }

  return [roots.projectRoot, roots.artifactRoot]
}

function isCompareArtifactRootField(path: readonly string[]): boolean {
  const parentKey = path[path.length - 2]
  return parentKey === 'paths' || parentKey === 'answer_paths'
}

function compareExternalPathFallback(path: string): string {
  const normalizedPath = path.replaceAll('\\', '/')
  const lastSegment = normalizedPath.split('/').pop()
  return lastSegment && lastSegment.length > 0 ? lastSegment : '<external-path>'
}

function sanitizeCompareShareSafePath(value: string, roots: ShareSafePathRoots, path: readonly string[]): string {
  if (isCompareArtifactRootField(path)) {
    if (isAbsolutePathLike(value)) {
      return isPathWithinRoot(resolve(value), roots.artifactRoot)
        ? toShareSafeArtifactPath(value, roots)
        : compareExternalPathFallback(value)
    }

    return isPathWithinRoot(resolve(roots.artifactRoot, value), roots.artifactRoot)
      ? value
      : compareExternalPathFallback(value)
  }

  if (isAbsolutePathLike(value)) {
    return toShareSafeArtifactPath(value, roots)
  }

  const candidateRoots = compareShareSafePathRoots(path, roots)
  for (const root of candidateRoots) {
    if (isPathWithinRoot(resolve(root, value), root)) {
      return value
    }
  }

  const fallbackRoot = candidateRoots[0] ?? roots.projectRoot
  return toShareSafeArtifactPath(resolve(fallbackRoot, value), roots)
}

function shouldSanitizeCompareShareSafeText(path: readonly string[]): boolean {
  const rootKey = path[0]
  return rootKey === 'stderr' || rootKey === 'evidence'
}

function shouldSanitizeCompareShareSafePath(path: readonly string[]): boolean {
  const key = path[path.length - 1]
  const parentKey = path[path.length - 2]

  return (
    key === 'graph_path' ||
    key === 'result_path' ||
    key === 'source_file' ||
    key === 'focus_files' ||
    (parentKey === 'exclusions' && key === 'path_hints') ||
    parentKey === 'paths' ||
    parentKey === 'answer_paths'
  )
}

function sanitizeCompareShareSafeValue(value: unknown, roots: ShareSafePathRoots, path: string[] = []): unknown {
  if (typeof value === 'string') {
    if (shouldSanitizeCompareShareSafeText(path)) {
      return sanitizeShareSafeText(value, roots)
    }
    if (shouldSanitizeCompareShareSafePath(path)) {
      return sanitizeCompareShareSafePath(value, roots, path)
    }
    return value
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeCompareShareSafeValue(entry, roots, path))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeCompareShareSafeValue(entry, roots, [...path, key])]),
    )
  }

  return value
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

function compareReportPackFromRetrieveResult(retrieval: RetrieveResult): CompareReportPack {
  const compact = compactRetrieveResult(retrieval)
  return {
    ...compact,
    ...(retrieval.claims ? { claims: retrieval.claims } : {}),
    ...(retrieval.coverage ? { coverage: retrieval.coverage } : {}),
    ...(retrieval.selection_diagnostics ? { selection_diagnostics: retrieval.selection_diagnostics } : {}),
  }
}

function appendRoutingSummary(lines: string[], reports: readonly ComparePromptReport[]): void {
  const routedReports = reports.filter((report): report is ComparePromptReport & { routing: ContextPackRoutingDebug } => report.routing !== undefined)
  for (const report of routedReports) {
    const prefix = routedReports.length === 1 ? '' : ` (${report.question})`
    lines.push(
      `- Routing${prefix}: ${report.routing.detected_intent} · ${report.routing.generation_intent} · ${report.routing.target_domain_hint} · level ${report.routing.retrieval_level} · ${report.routing.effective_retrieval_strategy}`,
    )
    lines.push(`- Routing reason${prefix}: ${report.routing.reason}`)
  }
}

function computeReductionRatio(baselinePromptTokens: number, madarPromptTokens: number): number {
  if (baselinePromptTokens <= 0 || madarPromptTokens <= 0) {
    return 0
  }
  return Number((baselinePromptTokens / madarPromptTokens).toFixed(1))
}

function formatTokenComparison(baselineTokens: number, madarTokens: number): string {
  if (baselineTokens <= 0 || madarTokens <= 0) {
    return 'n/a'
  }
  if (baselineTokens === madarTokens) {
    return 'same size'
  }
  if (baselineTokens > madarTokens) {
    return `${computeReductionRatio(baselineTokens, madarTokens)}x smaller`
  }
  return `${Number((madarTokens / baselineTokens).toFixed(1))}x larger`
}

function syncComparePromptMetrics(report: ComparePromptReport): void {
  report.baseline_prompt_tokens = report.usage.baseline?.input_total_tokens ?? report.baseline_prompt_tokens_estimated
  report.madar_prompt_tokens = report.usage.madar?.input_total_tokens ?? report.madar_prompt_tokens_estimated
  report.reduction_ratio = computeReductionRatio(report.baseline_prompt_tokens, report.madar_prompt_tokens)
  report.baseline_effective_prompt_tokens =
    report.usage.baseline !== null
      ? report.usage.baseline.input_total_tokens - report.usage.baseline.cache_read_input_tokens
      : report.baseline_effective_prompt_tokens
  report.madar_effective_prompt_tokens =
    report.usage.madar !== null
      ? report.usage.madar.input_total_tokens - report.usage.madar.cache_read_input_tokens
      : report.madar_effective_prompt_tokens
  report.effective_reduction_ratio = computeReductionRatio(
    report.baseline_effective_prompt_tokens,
    report.madar_effective_prompt_tokens,
  )
  report.baseline_reused_context_tokens = report.usage.baseline?.cache_read_input_tokens ?? report.baseline_reused_context_tokens
  report.madar_reused_context_tokens = report.usage.madar?.cache_read_input_tokens ?? report.madar_reused_context_tokens
  report.baseline_total_tokens = report.usage.baseline?.total_tokens ?? null
  report.madar_total_tokens = report.usage.madar?.total_tokens ?? null
  report.total_reduction_ratio =
    report.baseline_total_tokens !== null && report.madar_total_tokens !== null
      ? computeReductionRatio(report.baseline_total_tokens, report.madar_total_tokens)
      : null
  report.prompt_token_source.baseline = comparePromptTokenSource(report.usage.baseline)
  report.prompt_token_source.madar = comparePromptTokenSource(report.usage.madar)
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseTraceToolName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmedValue = value.trim()
  return trimmedValue.length > 0 ? trimmedValue : null
}

function parseAnthropicTraceRecords(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    return []
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed)) {
      return parsed.filter(isRecord)
    }
    if (isRecord(parsed)) {
      return [parsed]
    }
  } catch {
    // Fall through to line-mode parsing below.
  }

  const records: Record<string, unknown>[] = []
  for (const line of trimmed.split(/\r?\n/)) {
    const stripped = line.trim()
    if (stripped.length === 0) {
      continue
    }
    try {
      const parsed = JSON.parse(stripped) as unknown
      if (isRecord(parsed)) {
        records.push(parsed)
      }
    } catch {
      continue
    }
  }

  return records
}

const MADAR_CONTEXT_PACK_TOOL_NAMES = new Set(['context_pack'])
const MADAR_FOCUSED_FOLLOW_UP_TOOL_NAMES = new Set([
  'context_expand',
  'retrieve',
  'impact',
  'relevant_files',
  'feature_map',
  'risk_map',
  'implementation_checklist',
  'graph_summary',
  'graph_stats',
  'community_overview',
  'call_chain',
  'pr_impact',
])

const TRACE_FOCUSED_FOLLOW_UP_TOOL_NAMES = new Set(['read'])
const TRACE_BROAD_EXPLORATION_TOOL_NAMES = new Set(['bash', 'glob', 'grep', 'toolsearch'])

function canonicalTraceToolName(toolName: string): string {
  return toolName.startsWith('mcp__madar__') ? toolName.slice('mcp__madar__'.length) : toolName
}

function isMadarTraceToolName(toolName: string): boolean {
  const canonicalName = canonicalTraceToolName(toolName)
  return toolName.startsWith('mcp__madar__')
    || MADAR_CONTEXT_PACK_TOOL_NAMES.has(canonicalName)
    || MADAR_FOCUSED_FOLLOW_UP_TOOL_NAMES.has(canonicalName)
}

function isFocusedFollowUpTraceToolName(toolName: string): boolean {
  return TRACE_FOCUSED_FOLLOW_UP_TOOL_NAMES.has(toolName.toLowerCase())
}

function isBroadExplorationTraceToolName(toolName: string): boolean {
  return TRACE_BROAD_EXPLORATION_TOOL_NAMES.has(toolName.toLowerCase())
}

function traceToolCountSummary(toolCallsByName: Record<string, number>): string {
  return Object.entries(toolCallsByName)
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    .map(([toolName, count]) => `${toolName}×${count}`)
    .join(', ')
}

function analyzeMadarTraceExploration(perTurn: CompareMadarTraceTurnSummary[]): {
  madar_mcp_call_count: number
  madar_mcp_calls_by_name: Record<string, number>
  context_pack_call_count: number
  focused_follow_up_tool_call_count: number
  broad_exploration_tool_call_count: number
  broad_exploration_tool_calls_by_name: Record<string, number>
  exploration_outcome: CompareMadarTraceOutcome
  exploration_summary: string
} {
  let madarMcpCallCount = 0
  let contextPackCallCount = 0
  let focusedFollowUpToolCallCount = 0
  let broadExplorationToolCallCount = 0
  const madarMcpCallsByName: Record<string, number> = {}
  const focusedFollowUpToolCallsByName: Record<string, number> = {}
  const broadExplorationToolCallsByName: Record<string, number> = {}
  let sawFirstMadarCall = false

  for (const turn of perTurn) {
    for (const toolName of turn.tools) {
      const canonicalName = canonicalTraceToolName(toolName)
      const hadSeenMadarCall = sawFirstMadarCall
      if (isMadarTraceToolName(toolName)) {
        madarMcpCallCount += 1
        madarMcpCallsByName[toolName] = (madarMcpCallsByName[toolName] ?? 0) + 1
        if (MADAR_CONTEXT_PACK_TOOL_NAMES.has(canonicalName)) {
          contextPackCallCount += 1
        } else if (hadSeenMadarCall) {
          focusedFollowUpToolCallCount += 1
          focusedFollowUpToolCallsByName[toolName] = (focusedFollowUpToolCallsByName[toolName] ?? 0) + 1
        }
        sawFirstMadarCall = true
        continue
      }

      if (!hadSeenMadarCall) {
        continue
      }

      if (isFocusedFollowUpTraceToolName(toolName)) {
        focusedFollowUpToolCallCount += 1
        focusedFollowUpToolCallsByName[toolName] = (focusedFollowUpToolCallsByName[toolName] ?? 0) + 1
        continue
      }

      if (!isBroadExplorationTraceToolName(toolName)) {
        continue
      }

      broadExplorationToolCallCount += 1
      broadExplorationToolCallsByName[toolName] = (broadExplorationToolCallsByName[toolName] ?? 0) + 1
    }
  }

  const sortedMadarMcpCallsByName = Object.fromEntries(
    Object.entries(madarMcpCallsByName).sort(([leftName], [rightName]) => leftName.localeCompare(rightName)),
  )
  const sortedFocusedFollowUpToolCallsByName = Object.fromEntries(
    Object.entries(focusedFollowUpToolCallsByName).sort(([leftName], [rightName]) => leftName.localeCompare(rightName)),
  )
  const sortedBroadExplorationToolCallsByName = Object.fromEntries(
    Object.entries(broadExplorationToolCallsByName).sort(([leftName], [rightName]) => leftName.localeCompare(rightName)),
  )

  if (madarMcpCallCount === 0) {
    return {
      madar_mcp_call_count: madarMcpCallCount,
      madar_mcp_calls_by_name: sortedMadarMcpCallsByName,
      context_pack_call_count: 0,
      focused_follow_up_tool_call_count: 0,
      broad_exploration_tool_call_count: 0,
      broad_exploration_tool_calls_by_name: {},
      exploration_outcome: 'madar_available_but_unused',
      exploration_summary: 'No Madar MCP call was recorded.',
    }
  }

  const madarToolNames = Object.keys(sortedMadarMcpCallsByName)
  const madarInvocationSummary = `Madar MCP invoked ${madarMcpCallCount} ${madarMcpCallCount === 1 ? 'time' : 'times'}${madarToolNames.length > 0 ? ` (${madarToolNames.join(', ')})` : ''}`
  const contextPackSummary =
    contextPackCallCount > 0
      ? `${contextPackCallCount} context_pack ${contextPackCallCount === 1 ? 'call' : 'calls'}`
      : null
  const focusedSummary =
    focusedFollowUpToolCallCount > 0
      ? `${focusedFollowUpToolCallCount} focused follow-up ${focusedFollowUpToolCallCount === 1 ? 'call' : 'calls'}`
      : null
  if (broadExplorationToolCallCount === 0) {
    const summaryParts = [madarInvocationSummary]
    if (contextPackSummary !== null) {
      summaryParts.push(contextPackSummary)
    }
    if (focusedSummary !== null) {
      summaryParts.push(focusedSummary)
    }
    summaryParts.push('no broad exploration after the first Madar call.')
    return {
      madar_mcp_call_count: madarMcpCallCount,
      madar_mcp_calls_by_name: sortedMadarMcpCallsByName,
      context_pack_call_count: contextPackCallCount,
      focused_follow_up_tool_call_count: focusedFollowUpToolCallCount,
      broad_exploration_tool_call_count: 0,
      broad_exploration_tool_calls_by_name: {},
      exploration_outcome: 'madar_invoked',
      exploration_summary: summaryParts.join('; '),
    }
  }

  const broadSummary = `${broadExplorationToolCallCount} broad exploration ${broadExplorationToolCallCount === 1 ? 'call' : 'calls'} after the first Madar call${Object.keys(sortedBroadExplorationToolCallsByName).length > 0 ? ` (${traceToolCountSummary(sortedBroadExplorationToolCallsByName)})` : ''}`
  const summaryParts = [madarInvocationSummary]
  if (contextPackSummary !== null) {
    summaryParts.push(contextPackSummary)
  }
  if (focusedSummary !== null) {
    summaryParts.push(focusedSummary)
  }
  summaryParts.push(broadSummary)

  return {
    madar_mcp_call_count: madarMcpCallCount,
    madar_mcp_calls_by_name: sortedMadarMcpCallsByName,
    context_pack_call_count: contextPackCallCount,
    focused_follow_up_tool_call_count: focusedFollowUpToolCallCount,
    broad_exploration_tool_call_count: broadExplorationToolCallCount,
    broad_exploration_tool_calls_by_name: sortedBroadExplorationToolCallsByName,
    exploration_outcome: 'madar_invoked_with_followup_exploration',
    exploration_summary: summaryParts.join('; '),
  }
}

function parseTraceTurnNumber(value: unknown, fallbackTurn: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value
  }
  return fallbackTurn
}

function emptyNativeAgentToolCallCountsEntry(): NativeAgentToolCallCountsEntry {
  return {
    total: 0,
    Read: 0,
    Bash: 0,
    Glob: 0,
    Grep: 0,
    ToolSearch: 0,
    other: {},
  }
}

function extractNativeAgentToolCallCounts(stdout: string): NativeAgentToolCallCountsEntry | null {
  const records = parseAnthropicTraceRecords(stdout)
  if (records.length === 0) {
    return null
  }

  const counts = emptyNativeAgentToolCallCountsEntry()
  for (const record of records) {
    if (record.type !== 'assistant' || !isRecord(record.message) || !Array.isArray(record.message.content)) {
      continue
    }

    for (const contentPart of record.message.content) {
      if (!isRecord(contentPart) || contentPart.type !== 'tool_use') {
        continue
      }

      const toolName = parseTraceToolName(contentPart.name)
      if (toolName === null) {
        continue
      }

      const canonicalName = canonicalTraceToolName(toolName)
      const normalizedName = canonicalName.toLowerCase()
      counts.total += 1
      switch (normalizedName) {
        case 'read':
          counts.Read += 1
          break
        case 'bash':
          counts.Bash += 1
          break
        case 'glob':
          counts.Glob += 1
          break
        case 'grep':
          counts.Grep += 1
          break
        case 'toolsearch':
        case 'tool_search':
          counts.ToolSearch += 1
          break
        default:
          counts.other[canonicalName] = (counts.other[canonicalName] ?? 0) + 1
          break
      }
    }
  }

  if (counts.total === 0) {
    return null
  }

  counts.other = Object.fromEntries(
    Object.entries(counts.other).sort(([leftName], [rightName]) => leftName.localeCompare(rightName)),
  )
  return counts
}

function extractMadarTrace(stdout: string): CompareMadarTrace | undefined {
  const parsedRecords = parseAnthropicTraceRecords(stdout)
  if (parsedRecords.length === 0) {
    return undefined
  }
  const records =
    parsedRecords.length === 1 && Array.isArray(parsedRecords[0]?.messages)
      ? parsedRecords[0].messages.filter(isRecord)
      : parsedRecords
  const toolCallsByName: Record<string, number> = {}
  const perTurnIndex = new Map<number, CompareMadarTraceTurnSummary>()
  let fallbackTurn = 1
  let totalToolCalls = 0

  for (const message of records) {
    if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.content)) {
      if (message.type !== 'assistant' || !isRecord(message.message) || !Array.isArray(message.message.content)) {
        continue
      }
    }

    const content = Array.isArray(message.content)
      ? message.content
      : isRecord(message.message) && Array.isArray(message.message.content)
        ? message.message.content
        : []
    const tools: string[] = []
    for (const contentPart of content) {
      if (!isRecord(contentPart) || contentPart.type !== 'tool_use') {
        continue
      }

      const toolName = parseTraceToolName(contentPart.name)
      if (toolName === null) {
        continue
      }

      tools.push(toolName)
      toolCallsByName[toolName] = (toolCallsByName[toolName] ?? 0) + 1
      totalToolCalls += 1
    }

    if (tools.length === 0) {
      continue
    }

    const turn = parseTraceTurnNumber(message.turn, fallbackTurn)
    fallbackTurn = Math.max(fallbackTurn, turn + 1)
    const existingTurn = perTurnIndex.get(turn)
    if (existingTurn) {
      existingTurn.tool_call_count += tools.length
      existingTurn.tools.push(...tools)
      continue
    }

    perTurnIndex.set(turn, {
      turn,
      tool_call_count: tools.length,
      tools,
    })
  }

  if (totalToolCalls === 0) {
    return undefined
  }

  const sortedTurns = [...perTurnIndex.keys()].sort((leftTurn, rightTurn) => leftTurn - rightTurn)
  const perTurn = sortedTurns.map((turn) => perTurnIndex.get(turn)!)
  const exploration = analyzeMadarTraceExploration(perTurn)

  return {
    source: 'claude_messages_tool_use',
    summary: `${totalToolCalls} tool calls across ${sortedTurns.length} turns`,
    tool_call_count: totalToolCalls,
    tool_calls_by_name: Object.fromEntries(
      Object.entries(toolCallsByName).sort(([leftName], [rightName]) => leftName.localeCompare(rightName)),
    ),
    per_turn: perTurn,
    ...exploration,
  }
}

function applyNativeAgentMadarTraceOutcome(
  madarTrace: CompareMadarTrace,
  installVerified: boolean,
): CompareMadarTrace {
  if (madarTrace.madar_mcp_call_count > 0) {
    return madarTrace
  }

  return {
    ...madarTrace,
    exploration_outcome: installVerified ? 'madar_available_but_unused' : 'no_install',
    exploration_summary:
      installVerified
        ? 'Madar install was verified, but no Madar MCP call was recorded.'
        : 'No Madar install was detected, so no Madar MCP call could be recorded.',
  }
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
  const madarUsage = report.usage.madar

  return {
    baseline: buildCompareProviderProofEntry(baselineUsage, report.prompt_token_source.baseline),
    madar: buildCompareProviderProofEntry(madarUsage, report.prompt_token_source.madar),
    reduction_basis:
      baselineUsage !== null && madarUsage !== null
        ? 'provider_reported'
        : baselineUsage !== null || madarUsage !== null
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
    if (basename(currentPath) === 'out') {
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
    const gate = classifyRetrievalLevel({ prompt: question })
    const retrieval = retrieveContext(retrievalGraph, {
      question,
      budget: Math.max(budget, 200),
      ...(gate.signals.generation_intent === 'runtime_generation' ? { retrievalStrategy: 'slice-v1' as const } : {}),
    })
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
    input.mode === 'bounded' || input.mode === 'pack_only'
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

export function buildMadarPromptPack(input: BuildMadarPromptPackInput): ComparePromptPack {
  const explainPayload = JSON.stringify(
    buildExplainPackPayload(compactRetrieveResult(input.retrieval), input.retrieval),
    null,
    2,
  )
  const builtPrompt = buildContextPrompt({
    instructions: [
      'Answer the question using only the provided graph-guided retrieval output.',
      'If the retrieval does not contain the answer, say so.',
      ...generationCoreInstructions(input.question, input.retrieval),
    ],
    stable_prefix_title: 'Retrieved graph context',
    stable_sections: [
      {
        ref: 'explain_pack_payload',
        sort_key: '10-explain-pack-payload',
        body: explainPayload,
      },
    ],
    dynamic_sections: [
      { title: 'Question', body: input.question },
      { body: 'Answer:' },
    ],
    ...(input.session ? { session: input.session } : {}),
  })

  return {
    kind: 'madar',
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
  const projectRoot = realpathSync(inferProjectRootFromGraphPath(graphPath))
  const retrievalBudget = input.retrievalBudget ?? DEFAULT_RETRIEVAL_BUDGET
  let baselineSession: ContextSessionState | undefined
  let madarSession: ContextSessionState | undefined

  const reports = questions.map((question, index) => {
    const questionOutputDir = questions.length === 1 ? outputRoot : join(outputRoot, `question-${String(index + 1).padStart(3, '0')}`)
    mkdirSync(questionOutputDir, { recursive: true })

    const retrieval = retrieveCompareContext(graph, question, retrievalBudget, projectRoot)
    const madarPrompt = buildMadarPromptPack({
      question,
      retrieval,
      ...(madarSession ? { session: madarSession } : {}),
    })
    madarSession = madarPrompt.session_state
    const comparePack = input.baselineMode === 'pack_only' ? compareReportPackFromRetrieveResult(retrieval) : undefined
    const baselineMaxTokens =
      input.baselineMode === 'pack_only'
        ? madarPrompt.token_count
        : input.baselineMaxTokens
    const baselinePrompt = buildBaselinePromptPack({
      question,
      graph,
      corpusText,
      mode: input.baselineMode,
      ...(baselineMaxTokens !== undefined ? { maxTokens: baselineMaxTokens } : {}),
      ...(baselineSession ? { session: baselineSession } : {}),
    })
    baselineSession = baselinePrompt.session_state

    const paths: ComparePromptArtifactPaths = {
      output_dir: questionOutputDir,
      baseline_prompt: join(questionOutputDir, 'baseline-prompt.txt'),
      madar_prompt: join(questionOutputDir, 'madar-prompt.txt'),
      report: join(questionOutputDir, 'report.json'),
      share_safe_report: join(questionOutputDir, 'report.share-safe.json'),
    }
    const answerPaths: CompareAnswerArtifactPaths = {
      baseline: answerFilePath(questionOutputDir, 'baseline'),
      madar: answerFilePath(questionOutputDir, 'madar'),
    }

    const baselinePromptText = baselinePrompt.session_payload
    const madarPromptText = madarPrompt.session_payload

    writeFileSync(paths.baseline_prompt, baselinePromptText, 'utf8')
    writeFileSync(paths.madar_prompt, madarPromptText, 'utf8')

    const baselinePromptTokens = baselinePrompt.token_count
    const madarPromptTokens = madarPrompt.token_count

    const report: ComparePromptReport = {
      question,
      graph_path: graphPath,
      exec_command: summarizeExecTemplate(input.execTemplate),
      baseline_mode: input.baselineMode,
      baseline_prompt_tokens: baselinePromptTokens,
      madar_prompt_tokens: madarPromptTokens,
      reduction_ratio: computeReductionRatio(baselinePromptTokens, madarPromptTokens),
      baseline_effective_prompt_tokens: baselinePrompt.effective_token_count,
      madar_effective_prompt_tokens: madarPrompt.effective_token_count,
      effective_reduction_ratio: computeReductionRatio(baselinePrompt.effective_token_count, madarPrompt.effective_token_count),
      baseline_reused_context_tokens: baselinePrompt.reused_context_tokens,
      madar_reused_context_tokens: madarPrompt.reused_context_tokens,
      baseline_total_tokens: null,
      madar_total_tokens: null,
      total_reduction_ratio: null,
      baseline_prompt_tokens_estimated: baselinePromptTokens,
      madar_prompt_tokens_estimated: madarPromptTokens,
      reduction_ratio_estimated: computeReductionRatio(baselinePromptTokens, madarPromptTokens),
      prompt_token_estimator: QUERY_TOKEN_ESTIMATOR,
      prompt_token_source: {
        baseline: 'estimated_cl100k_base',
        madar: 'estimated_cl100k_base',
      },
      usage: {
        baseline: null,
        madar: null,
      },
      started_at: now.toISOString(),
      completed_at: now.toISOString(),
      elapsed_ms: {
        baseline: 0,
        madar: 0,
      },
      status: {
        baseline: 'not_run',
        madar: 'not_run',
      },
      answer_paths: answerPaths,
      exit_code: {
        baseline: null,
        madar: null,
      },
      stderr: {
        baseline: null,
        madar: null,
      },
      failure_reason: {
        baseline: null,
        madar: null,
      },
      evidence: {
        baseline: null,
        madar: null,
      },
      ...(comparePack ? { pack: comparePack } : {}),
      ...(input.why ? { routing: buildRoutingDebug(retrieval) } : {}),
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
        mode: 'madar',
        promptFile: report.paths.madar_prompt,
        outputFile: report.answer_paths.madar,
      },
    ]

    for (const execution of executions) {
      let madarTrace: CompareMadarTrace | undefined
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
        if (execution.mode === 'madar') {
          madarTrace = extractMadarTrace(executionResult.stdout)
        }
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
        if (execution.mode === 'madar') {
          if (madarTrace) {
            report.madar_trace = madarTrace
          } else {
            delete report.madar_trace
          }
        }
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
        if (execution.mode === 'madar') {
          delete report.madar_trace
        }
      }

      syncComparePromptMetrics(report)
      report.completed_at = now().toISOString()
      writeCompareReport(report)
    }
  }

  return result
}

function sumPromptTokens(reports: readonly ComparePromptReport[], mode: CompareRunMode): number {
  return reports.reduce((total, report) => total + (mode === 'baseline' ? report.baseline_prompt_tokens : report.madar_prompt_tokens), 0)
}

function sumEffectivePromptTokens(reports: readonly ComparePromptReport[], mode: CompareRunMode): number {
  return reports.reduce(
    (total, report) => total + (mode === 'baseline' ? report.baseline_effective_prompt_tokens : report.madar_effective_prompt_tokens),
    0,
  )
}

function sumReusedContextTokens(reports: readonly ComparePromptReport[], mode: CompareRunMode): number {
  return reports.reduce(
    (total, report) => total + (mode === 'baseline' ? report.baseline_reused_context_tokens : report.madar_reused_context_tokens),
    0,
  )
}

function sumTotalTokens(reports: readonly ComparePromptReport[], mode: CompareRunMode): number | null {
  let total = 0
  for (const report of reports) {
    const value = mode === 'baseline' ? report.baseline_total_tokens : report.madar_total_tokens
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
    const madar = report.status.madar === status ? 1 : 0
    return total + baseline + madar
  }, 0)
}

function countPromptUsageRuns(reports: readonly ComparePromptReport[]): number {
  return reports.reduce((total, report) => total + (report.usage.baseline === null ? 0 : 1) + (report.usage.madar === null ? 0 : 1), 0)
}

function usageProviderSummaryLabel(reports: readonly ComparePromptReport[]): string {
  const providers = new Set<ComparePromptUsage['provider']>()

  for (const report of reports) {
    if (report.usage.baseline !== null) {
      providers.add(report.usage.baseline.provider)
    }
    if (report.usage.madar !== null) {
      providers.add(report.usage.madar.provider)
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
    .flatMap((report) => (report.provider_proof ? [report.provider_proof.baseline, report.provider_proof.madar] : []))
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

function formatCompareMadarTraceSummary(result: GenerateCompareArtifactsResult): string | null {
  const traces = result.reports.flatMap((report) => (report.madar_trace ? [report.madar_trace] : []))
  if (traces.length === 0) {
    return null
  }

  const toolCallsByName = new Map<string, number>()
  const totalToolCalls = traces.reduce((total, trace) => {
    for (const [toolName, count] of Object.entries(trace.tool_calls_by_name)) {
      toolCallsByName.set(toolName, (toolCallsByName.get(toolName) ?? 0) + count)
    }
    return total + trace.tool_call_count
  }, 0)
  const totalTurns = traces.reduce((total, trace) => total + trace.per_turn.length, 0)
  const noInstallRuns = traces.filter((trace) => trace.exploration_outcome === 'no_install').length
  const madarAvailableButUnusedRuns = traces.filter((trace) => trace.exploration_outcome === 'madar_available_but_unused').length
  const madarInvokedRuns = traces.filter((trace) => trace.exploration_outcome === 'madar_invoked').length
  const madarInvokedWithFollowUpExplorationRuns =
    traces.filter((trace) => trace.exploration_outcome === 'madar_invoked_with_followup_exploration').length
  const topTools = [...toolCallsByName.entries()]
    .sort((leftEntry, rightEntry) => rightEntry[1] - leftEntry[1] || leftEntry[0].localeCompare(rightEntry[0]))
    .slice(0, 3)
    .map(([toolName, count]) => `${toolName}×${count}`)
  const traceCoverage = traces.length === result.reports.length ? '' : ` · traces for ${traces.length}/${result.reports.length} madar runs`
  const topToolsSummary = topTools.length > 0 ? ` · top tools: ${topTools.join(', ')}` : ''
  const outcomeParts: string[] = []
  if (noInstallRuns > 0) {
    outcomeParts.push(`${noInstallRuns} no install`)
  }
  if (madarAvailableButUnusedRuns > 0) {
    outcomeParts.push(`${madarAvailableButUnusedRuns} available but unused`)
  }
  if (madarInvokedRuns > 0) {
    outcomeParts.push(`${madarInvokedRuns} madar invoked`)
  }
  if (madarInvokedWithFollowUpExplorationRuns > 0) {
    outcomeParts.push(`${madarInvokedWithFollowUpExplorationRuns} madar invoked with follow-up exploration`)
  }
  const outcomeSummary = outcomeParts.length > 0 ? ` · outcomes: ${outcomeParts.join(', ')}` : ''

  return `Madar trace: ${totalToolCalls} tool call${totalToolCalls === 1 ? '' : 's'} across ${totalTurns} turn${totalTurns === 1 ? '' : 's'}${traceCoverage}${topToolsSummary}${outcomeSummary}`
}

export function formatCompareSummary(result: GenerateCompareArtifactsResult): string {
  const baselineTokens = sumPromptTokens(result.reports, 'baseline')
  const madarTokens = sumPromptTokens(result.reports, 'madar')
  const baselineEffectiveTokens = sumEffectivePromptTokens(result.reports, 'baseline')
  const madarEffectiveTokens = sumEffectivePromptTokens(result.reports, 'madar')
  const baselineReusedTokens = sumReusedContextTokens(result.reports, 'baseline')
  const madarReusedTokens = sumReusedContextTokens(result.reports, 'madar')
  const baselineTotalTokens = sumTotalTokens(result.reports, 'baseline')
  const madarTotalTokens = sumTotalTokens(result.reports, 'madar')
  const totalReductionRatio =
    baselineTotalTokens !== null && madarTotalTokens !== null ? computeReductionRatio(baselineTotalTokens, madarTotalTokens) : null
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
  const usesSyntheticBaseline = baselineModes.has('full') || baselineModes.has('bounded') || baselineModes.has('pack_only')

  const lines = [
    `[madar compare] completed ${result.reports.length} question(s)`,
    `- Output: ${result.output_root}`,
    `- Prompt runs: ${succeededRuns} succeeded${contextOverflowRuns > 0 ? ` · ${contextOverflowRuns} context overflow` : ''}${
      failedRuns > 0 ? ` · ${failedRuns} failed` : ''
    }`,
    `- ${promptTokenLabel}: baseline ${baselineTokens} · madar ${madarTokens} · ${formatTokenComparison(baselineTokens, madarTokens)}`,
    `- Effective input tokens (cache-adjusted): baseline ${baselineEffectiveTokens} · madar ${madarEffectiveTokens} · ${formatTokenComparison(baselineEffectiveTokens, madarEffectiveTokens)}`,
  ]

  if (usesSyntheticBaseline) {
    lines.push(`- Note: reduction_ratio above is a synthetic prompt-token estimate (${QUERY_TOKEN_ESTIMATOR.model}); use --baseline-mode native_agent for Anthropic-reported usage.`)
  }

  if (baselineTotalTokens !== null && madarTotalTokens !== null && totalReductionRatio !== null) {
    lines.push(`- Total tokens (${usageProviderLabel} reported): baseline ${baselineTotalTokens} · madar ${madarTotalTokens} · ${formatTokenComparison(baselineTotalTokens, madarTotalTokens)}`)
  } else if (usageRuns > 0 && usageRuns < totalRuns) {
    lines.push(`- Usage capture: ${usageProviderLabel} reported usage for ${usageRuns}/${totalRuns} prompt runs; remaining runs used local estimate fallback`)
  }
  lines.push(`- Reused context tokens: baseline ${baselineReusedTokens} · madar ${madarReusedTokens}`)
  lines.push(`- Provider/runtime proof: ${formatCompareProviderProof(result)}`)
  const madarTraceSummary = formatCompareMadarTraceSummary(result)
  if (madarTraceSummary !== null) {
    lines.push(`- ${madarTraceSummary}`)
  }
  appendRoutingSummary(lines, result.reports)

  return lines.join('\n')
}

export async function runCompareCommand(
  input: GenerateCompareArtifactsInput,
  dependencies: ExecuteCompareRunsDependencies = {},
): Promise<string> {
  if (input.baselineMode === 'native_agent') {
    const nativeResult = await executeNativeAgentCompare(input, dependencies)
    const failed = nativeResult.reports.filter((report) => isNativeAgentRunFailure(report.baseline) || isNativeAgentRunFailure(report.madar)).length
    if (failed > 0) {
      throw new Error(`[madar compare] ${failed} native_agent run(s) failed. Partial artifacts were saved under ${nativeResult.output_root}`)
    }
    return formatNativeAgentCompareSummary(nativeResult)
  }

  const result = await executeCompareRuns(input, dependencies)
  const failedRuns = countPromptRuns(result.reports, 'failed')
  if (failedRuns > 0) {
    throw new Error(`[madar compare] ${failedRuns} prompt run(s) failed. Partial artifacts were saved under ${result.output_root}`)
  }
  return formatCompareSummary(result)
}

// ─────────────────────────────────────────────────────────────────────────────
// native_agent baseline mode
//
// Unlike `full` and `bounded`, which build synthetic baseline prompts from the
// project corpus, `native_agent` runs the user's `--exec` command twice — once
// in a snapshot-renamed environment (no out/, no .mcp.json, no
// CLAUDE.md, no .claude/) and once with those artifacts in place. We capture
// the trailing JSON `result` event from `claude --output-format json` (or any
// runner emitting the same shape), report Anthropic-billed `usage` blocks
// as-is, and compute reductions on the real numbers — not on a constructed
// baseline prompt-token count.
// ─────────────────────────────────────────────────────────────────────────────

// What to hide from the baseline agent. We hide the *graph artifacts* (graph.json,
// GRAPH_REPORT.md, graph.html) rather than the entire `out/` directory
// because the compare run writes its prompt and answer artifacts into
// `out/compare/<ts>/` — renaming the parent would make those paths
// inaccessible during the baseline run. We additionally hide `.mcp.json`,
// `CLAUDE.md`, and `.claude/` so the baseline agent has no MCP server, no
// project-level madar rules, and no PreToolUse hooks.
const NATIVE_AGENT_SNAPSHOT_TARGETS = [
  'out/graph.json',
  'out/GRAPH_REPORT.md',
  'out/graph.html',
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
  | {
      kind: 'succeeded'
      model: string | null
      usage: AnthropicUsageBlock
      total_input_tokens_anthropic_exact: number
      uncached_input_tokens_anthropic_exact: number
      cached_input_tokens_anthropic_exact: number
      total_cost_usd: number | null
      num_turns: number
      duration_ms: number
      result_path: string
    }
  | { kind: 'answer_only'; evidence: string | null; exit_code: number; stderr: string | null; result_path: string }
  | { kind: 'runner_error'; evidence: string | null; exit_code: number | null; stderr: string | null }

export type NativeAgentTokenRegressionMetric =
  | 'uncached_input_tokens'
  | 'cache_creation_input_tokens'

export interface NativeAgentToolCallCountsEntry {
  total: number
  Read: number
  Bash: number
  Glob: number
  Grep: number
  ToolSearch: number
  other: Record<string, number>
}

export interface NativeAgentToolCallCounts {
  baseline: NativeAgentToolCallCountsEntry
  madar: NativeAgentToolCallCountsEntry
}

export interface NativeAgentCompareReport {
  baseline_mode: 'native_agent'
  question: string
  graph_path: string
  isolation: boolean
  environment: BenchmarkEnvironment
  environment_contamination: BenchmarkEnvironmentContamination
  exec_command: CompareExecCommandSummary
  baseline: NativeAgentRunStatus
  madar: NativeAgentRunStatus
  install_verified: boolean
  measurement_validity: NativeAgentMeasurementValidity
  madar_mcp_call_count: number
  tool_call_counts?: NativeAgentToolCallCounts
  madar_trace?: CompareMadarTrace
  reductions: {
    input_tokens: number | null
    uncached_input_tokens?: number | null
    cache_creation_input_tokens?: number | null
    num_turns: number | null
    duration_ms: number | null
    cost_usd: number | null
  } | null
  token_regression: boolean
  token_regression_reasons: NativeAgentTokenRegressionMetric[]
  prompt_token_source: {
    baseline: 'anthropic_provider_reported' | 'unknown'
    madar: 'anthropic_provider_reported' | 'unknown'
  }
  provider_proof?: {
    baseline: {
      provider: 'anthropic' | null
      input_tokens_source: 'anthropic_provider_reported' | 'unknown'
      effective_tokens_source: 'anthropic_provider_reported' | 'unknown'
      total_tokens_source: 'anthropic_provider_reported' | 'unknown'
    }
    madar: {
      provider: 'anthropic' | null
      input_tokens_source: 'anthropic_provider_reported' | 'unknown'
      effective_tokens_source: 'anthropic_provider_reported' | 'unknown'
      total_tokens_source: 'anthropic_provider_reported' | 'unknown'
    }
    reduction_basis: 'provider_reported' | 'mixed' | 'unknown'
  }
  started_at: string
  completed_at: string
  answer_quality?: {
    gate: string
    prompt: string
    baseline: {
      passed: boolean
      missing_required_terms: string[]
      forbidden_terms_present: string[]
    }
    madar: {
      passed: boolean
      missing_required_terms: string[]
      forbidden_terms_present: string[]
    }
    required_concepts: string[]
    answer_quality_notes: string[]
    manual_review_notes: string[]
  }
  paths: {
    output_dir: string
    report: string
    share_safe_report: string
    baseline_answer: string
    madar_answer: string
    prompt_file: string
  }
}

export interface NativeAgentCompareResult {
  graph_path: string
  output_root: string
  reports: NativeAgentCompareReport[]
  answer_quality?: {
    questions_checked: number
    baseline_passed: number
    madar_passed: number
    madar_required_terms_missing: number
    madar_forbidden_terms_present: number
    manual_review_required: number
  }
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

const MADAR_SECTION_MARKER = '## madar'
const OUT_PATH_SEGMENT_PATTERN = /(^|[^a-z0-9_])out(?:[\\/]|[^a-z0-9_]|$)/i

function readJsonObject(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) {
    return null
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function containsOutPathReference(value: unknown): boolean {
  if (typeof value === 'string') {
    return OUT_PATH_SEGMENT_PATTERN.test(value)
  }
  if (Array.isArray(value)) {
    return value.some(containsOutPathReference)
  }
  if (isRecord(value)) {
    return Object.values(value).some(containsOutPathReference)
  }
  return false
}

function hasSectionMarker(filePath: string, marker = MADAR_SECTION_MARKER): boolean {
  if (!existsSync(filePath)) {
    return false
  }
  return readFileSync(filePath, 'utf8').includes(marker)
}

function findHookEntry(
  settingsPath: string,
  hookName: 'UserPromptSubmit' | 'PreToolUse' | 'BeforeTool',
): boolean {
  const settings = readJsonObject(settingsPath)
  if (!settings) {
    return false
  }

  const hooks = settings.hooks
  if (!isRecord(hooks)) {
    return false
  }

  const hookEntries = hooks[hookName]
  return Array.isArray(hookEntries) && hookEntries.some(containsOutPathReference)
}

function hasMadarMcpEntry(configPath: string): boolean {
  const config = readJsonObject(configPath)
  if (!config) {
    return false
  }

  return [config.mcpServers, config.servers].some((servers) => isRecord(servers) && isRecord(servers.madar))
}

export function inspectClaudeNativeAgentInstall(projectRoot: string): NativeAgentInstallCheck {
  const mcpPath = join(projectRoot, '.mcp.json')
  const claudeRulesPath = join(projectRoot, 'CLAUDE.md')
  const settingsPath = join(projectRoot, '.claude', 'settings.json')
  const artifacts: NativeAgentInstallArtifactCheck[] = [
    {
      label: '.mcp.json',
      ok: hasMadarMcpEntry(mcpPath),
      detail: '.mcp.json missing or has no `madar` entry',
      path: mcpPath,
    },
    {
      label: 'CLAUDE.md',
      ok: hasSectionMarker(claudeRulesPath),
      detail: 'CLAUDE.md missing `## madar` section',
      path: claudeRulesPath,
    },
    {
      label: '.claude/settings.json',
      ok:
        findHookEntry(settingsPath, 'UserPromptSubmit')
        || findHookEntry(settingsPath, 'PreToolUse')
        || findHookEntry(settingsPath, 'BeforeTool'),
      detail: '.claude/settings.json missing Madar hook',
      path: settingsPath,
    },
  ]

  return {
    verified: artifacts.every((artifact) => artifact.ok),
    artifacts,
  }
}

function formatNativeAgentInstallRequiredMessage(check: NativeAgentInstallCheck): string {
  return [
    'No Madar install detected in this directory:',
    ...check.artifacts
      .filter((artifact) => !artifact.ok)
      .map((artifact) => `  x ${artifact.detail}`),
    '',
    'Run `madar claude install` in the target repo, then rerun compare.',
    'To proceed without a verified install and mark the metrics INVALID, add `--allow-no-install`.',
  ].join('\n')
}

export class NativeAgentInstallRequiredError extends Error {
  readonly check: NativeAgentInstallCheck

  constructor(check: NativeAgentInstallCheck) {
    super(formatNativeAgentInstallRequiredMessage(check))
    this.name = 'NativeAgentInstallRequiredError'
    this.check = check
  }
}

interface NativeAgentAnswerQualityGate {
  prompt: string
  required_answer_terms: string[]
  forbidden_answer_terms: string[]
  required_concepts: string[]
  answer_quality_notes: string[]
  manual_review_notes: string[]
}

function normalizeAnswerQualityText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function parseAnswerQualityStringArray(
  gateName: string,
  fieldName: string,
  value: unknown,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new Error(`Malformed quality gate "${gateName}": ${fieldName} must be a string array`)
  }
  if (!allowEmpty && value.length === 0) {
    throw new Error(`Malformed quality gate "${gateName}": ${fieldName} must be a non-empty string array`)
  }
  return value.map((entry) => entry.trim())
}

function parseNativeAgentAnswerQualityGate(gateName: string, value: unknown): NativeAgentAnswerQualityGate {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed quality gate "${gateName}": expected an object`)
  }
  const gate = value as Record<string, unknown>
  if (typeof gate.prompt !== 'string' || gate.prompt.trim().length === 0) {
    throw new Error(`Malformed quality gate "${gateName}": prompt must be a non-empty string`)
  }

  return {
    prompt: gate.prompt.trim(),
    required_answer_terms: parseAnswerQualityStringArray(gateName, 'required_answer_terms', gate.required_answer_terms),
    forbidden_answer_terms: parseAnswerQualityStringArray(gateName, 'forbidden_answer_terms', gate.forbidden_answer_terms, { allowEmpty: true }),
    required_concepts: parseAnswerQualityStringArray(gateName, 'required_concepts', gate.required_concepts),
    answer_quality_notes: parseAnswerQualityStringArray(gateName, 'answer_quality_notes', gate.answer_quality_notes),
    manual_review_notes: parseAnswerQualityStringArray(gateName, 'manual_review_notes', gate.manual_review_notes),
  }
}

function loadNativeAgentAnswerQualityGates(
  questionsPath: string | null | undefined,
): Map<string, NativeAgentAnswerQualityGate> | null {
  if (!questionsPath) {
    return null
  }
  const configPath = join(dirname(resolve(questionsPath)), 'quality-gates.json')
  if (!existsSync(configPath)) {
    return null
  }

  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Malformed quality gate config: expected a JSON object at ${configPath}`)
  }

  return new Map(
    Object.entries(parsed).map(([gateName, gate]) => [gateName, parseNativeAgentAnswerQualityGate(gateName, gate)]),
  )
}

function evaluateNativeAgentAnswerQualityRun(
  gate: NativeAgentAnswerQualityGate,
  answerText: string,
): {
  passed: boolean
  missing_required_terms: string[]
  forbidden_terms_present: string[]
} {
  const normalizedAnswer = normalizeAnswerQualityText(answerText)
  const missingRequiredTerms = gate.required_answer_terms.filter((term) => !normalizedAnswer.includes(normalizeAnswerQualityText(term)))
  const forbiddenTermsPresent = gate.forbidden_answer_terms.filter((term) => normalizedAnswer.includes(normalizeAnswerQualityText(term)))
  return {
    passed: missingRequiredTerms.length === 0 && forbiddenTermsPresent.length === 0,
    missing_required_terms: missingRequiredTerms,
    forbidden_terms_present: forbiddenTermsPresent,
  }
}

function evaluateNativeAgentAnswerQualityReport(
  gates: ReadonlyMap<string, NativeAgentAnswerQualityGate> | null,
  question: string,
  baselineAnswerPath: string,
  madarAnswerPath: string,
): NativeAgentCompareReport['answer_quality'] | undefined {
  if (gates === null) {
    return undefined
  }
  const match = [...gates.entries()].find(([gateName, gate]) => gateName === question || gate.prompt === question)
  if (!match) {
    return undefined
  }
  if (!existsSync(baselineAnswerPath) || !existsSync(madarAnswerPath)) {
    return undefined
  }

  const [gateName, gate] = match
  const baselineAnswer = readFileSync(baselineAnswerPath, 'utf8')
  const madarAnswer = readFileSync(madarAnswerPath, 'utf8')
  return {
    gate: gateName,
    prompt: gate.prompt,
    baseline: evaluateNativeAgentAnswerQualityRun(gate, baselineAnswer),
    madar: evaluateNativeAgentAnswerQualityRun(gate, madarAnswer),
    required_concepts: gate.required_concepts,
    answer_quality_notes: gate.answer_quality_notes,
    manual_review_notes: gate.manual_review_notes,
  }
}

function summarizeNativeAgentAnswerQuality(
  reports: readonly NativeAgentCompareReport[],
): NativeAgentCompareResult['answer_quality'] | undefined {
  const checkedReports = reports.filter((report) => report.answer_quality !== undefined)
  if (checkedReports.length === 0) {
    return undefined
  }

  return {
    questions_checked: checkedReports.length,
    baseline_passed: checkedReports.filter((report) => report.answer_quality?.baseline.passed).length,
    madar_passed: checkedReports.filter((report) => report.answer_quality?.madar.passed).length,
    madar_required_terms_missing: checkedReports.reduce(
      (total, report) => total + (report.answer_quality?.madar.missing_required_terms.length ?? 0),
      0,
    ),
    madar_forbidden_terms_present: checkedReports.reduce(
      (total, report) => total + (report.answer_quality?.madar.forbidden_terms_present.length ?? 0),
      0,
    ),
    manual_review_required: checkedReports.reduce(
      (total, report) => total + (report.answer_quality?.manual_review_notes.length ?? 0),
      0,
    ),
  }
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
  const records = parseAnthropicTraceRecords(stdout)
  if (records.length === 0) {
    return null
  }

  for (const obj of [...records].reverse()) {
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

function snapshotMadarArtifacts(projectRoot: string, timestamp: string): SnapshotRecord[] {
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

function restoreMadarArtifacts(records: readonly SnapshotRecord[]): void {
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
      process.stderr.write(`[madar compare native_agent] restore failed for ${record.originalPath}: ${message}\n`)
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

function computeReduction(baseline: number, madar: number): number | null {
  if (madar <= 0 || baseline <= 0) {
    return null
  }
  return Number((baseline / madar).toFixed(2))
}

function relativeChangeFraction(baseline: number, madar: number): number | null {
  if (baseline <= 0 || madar <= 0) {
    return null
  }
  return Math.abs(madar - baseline) / baseline
}

function formatDirectionalDelta(
  baseline: number,
  madar: number,
  decreasedLabel: string,
  increasedLabel: string,
  options: {
    noMeaningfulChangeThreshold?: number
    neutralLabel?: string
  } = {},
): string {
  if (baseline <= 0 || madar <= 0) {
    return ''
  }

  if (
    options.neutralLabel
    && options.noMeaningfulChangeThreshold !== undefined
    && (relativeChangeFraction(baseline, madar) ?? Number.POSITIVE_INFINITY) <= options.noMeaningfulChangeThreshold
  ) {
    return ` (${options.neutralLabel})`
  }

  if (baseline === madar) {
    return ''
  }

  if (madar < baseline) {
    return ` (${Number((baseline / madar).toFixed(2))}x ${decreasedLabel})`
  }

  return ` (${Number((madar / baseline).toFixed(2))}x ${increasedLabel})`
}

function collectTokenRegressionReasons(
  baseline: Extract<NativeAgentRunStatus, { kind: 'succeeded' }>,
  madar: Extract<NativeAgentRunStatus, { kind: 'succeeded' }>,
): NativeAgentTokenRegressionMetric[] {
  const reasons: NativeAgentTokenRegressionMetric[] = []
  if (madar.uncached_input_tokens_anthropic_exact > baseline.uncached_input_tokens_anthropic_exact) {
    reasons.push('uncached_input_tokens')
  }
  if (madar.usage.cache_creation_input_tokens > baseline.usage.cache_creation_input_tokens) {
    reasons.push('cache_creation_input_tokens')
  }
  return reasons
}

function formatTokenRegressionMetric(
  metric: NativeAgentTokenRegressionMetric,
  baseline: Extract<NativeAgentRunStatus, { kind: 'succeeded' }>,
  madar: Extract<NativeAgentRunStatus, { kind: 'succeeded' }>,
): string {
  if (metric === 'uncached_input_tokens') {
    return `uncached_input_tokens baseline ${baseline.uncached_input_tokens_anthropic_exact} → madar ${madar.uncached_input_tokens_anthropic_exact}${formatDirectionalDelta(baseline.uncached_input_tokens_anthropic_exact, madar.uncached_input_tokens_anthropic_exact, 'less', 'more')}`
  }

  return `cache_creation_input_tokens baseline ${baseline.usage.cache_creation_input_tokens} → madar ${madar.usage.cache_creation_input_tokens}${formatDirectionalDelta(baseline.usage.cache_creation_input_tokens, madar.usage.cache_creation_input_tokens, 'less', 'more')}`
}

function formatTokenRegressionWarning(
  baseline: Extract<NativeAgentRunStatus, { kind: 'succeeded' }>,
  madar: Extract<NativeAgentRunStatus, { kind: 'succeeded' }>,
  reasons: readonly NativeAgentTokenRegressionMetric[],
): string | null {
  if (reasons.length === 0) {
    return null
  }

  return `WARNING: fresh-token regression — ${reasons.map((metric) => formatTokenRegressionMetric(metric, baseline, madar)).join('; ')}`
}

type NativeAgentComparableReport = NativeAgentCompareReport & {
  baseline: Extract<NativeAgentRunStatus, { kind: 'succeeded' }>
  madar: Extract<NativeAgentRunStatus, { kind: 'succeeded' }>
}

interface NativeAgentSuiteChange {
  question: string
  percentReduction: number
}

function isComparableNativeAgentReport(report: NativeAgentCompareReport): report is NativeAgentComparableReport {
  return report.baseline.kind === 'succeeded' && report.madar.kind === 'succeeded'
}

function computeReductionPercent(baseline: number, madar: number): number | null {
  if (baseline <= 0 || madar <= 0) {
    return null
  }
  return Number((((baseline - madar) / baseline) * 100).toFixed(1))
}

function formatPercent(value: number): string {
  return Number(value.toFixed(1)).toString()
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null
  }
  return values.reduce((total, value) => total + value, 0) / values.length
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null
  }
  const left = sorted[middle - 1]
  const right = sorted[middle]
  if (left === undefined || right === undefined) {
    return null
  }
  return (left + right) / 2
}

function nativeAgentSuiteChanges(
  reports: readonly NativeAgentComparableReport[],
  metric: (report: NativeAgentComparableReport) => { baseline: number; madar: number },
): NativeAgentSuiteChange[] {
  return reports.flatMap((report) => {
    const values = metric(report)
    const percentReduction = computeReductionPercent(values.baseline, values.madar)
    return percentReduction === null ? [] : [{ question: report.question, percentReduction }]
  })
}

function bestWin(changes: readonly NativeAgentSuiteChange[]): NativeAgentSuiteChange | null {
  const wins = changes.filter((change) => change.percentReduction > 0)
  if (wins.length === 0) {
    return null
  }
  return wins.reduce((best, change) => (change.percentReduction > best.percentReduction ? change : best))
}

function worstRegression(changes: readonly NativeAgentSuiteChange[]): NativeAgentSuiteChange | null {
  const losses = changes.filter((change) => change.percentReduction < 0)
  if (losses.length === 0) {
    return null
  }
  return losses.reduce((worst, change) => (change.percentReduction < worst.percentReduction ? change : worst))
}

function formatSuiteOutcome(change: NativeAgentSuiteChange | null, decreasedLabel: string, increasedLabel: string): string {
  if (change === null) {
    return 'none'
  }
  const amount = formatPercent(Math.abs(change.percentReduction))
  const direction = change.percentReduction > 0 ? decreasedLabel : increasedLabel
  return `"${change.question}" (${amount}% ${direction})`
}

function formatNativeAgentSuiteMetricLine(
  label: string,
  changes: readonly NativeAgentSuiteChange[],
  decreasedLabel: string,
  increasedLabel: string,
  includeMeanMedian = false,
  totalQuestionCount = changes.length,
): string {
  const wins = changes.filter((change) => change.percentReduction > 0).length
  const losses = changes.filter((change) => change.percentReduction < 0).length
  const parts = [
    `- Suite ${label}: ${formatCount(wins, 'win', 'wins')} · ${formatCount(losses, 'loss', 'losses')}`,
  ]
  if (changes.length !== totalQuestionCount) {
    parts.push(`${changes.length}/${totalQuestionCount} comparable`)
  }

  if (includeMeanMedian) {
    const reductions = changes.map((change) => change.percentReduction)
    const meanReduction = mean(reductions)
    const medianReduction = median(reductions)
    if (meanReduction !== null && medianReduction !== null) {
      parts.push(`mean reduction ${formatPercent(meanReduction)}%`)
      parts.push(`median reduction ${formatPercent(medianReduction)}%`)
    }
  }

  parts.push(`best win: ${formatSuiteOutcome(bestWin(changes), decreasedLabel, increasedLabel)}`)
  parts.push(`worst regression: ${formatSuiteOutcome(worstRegression(changes), decreasedLabel, increasedLabel)}`)
  return parts.join(' · ')
}

function isNativeAgentRunFailure(run: NativeAgentRunStatus): boolean {
  return run.kind === 'runner_error'
}

function totalAnthropicInputTokens(usage: AnthropicUsageBlock): number {
  return usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
}

function uncachedAnthropicInputTokens(usage: AnthropicUsageBlock): number {
  return usage.input_tokens + usage.cache_creation_input_tokens
}

function cachedAnthropicInputTokens(usage: AnthropicUsageBlock): number {
  return usage.cache_read_input_tokens
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
  const answerQualityGates = loadNativeAgentAnswerQualityGates(input.questionsPath)
  const environment = await captureBenchmarkEnvironment({ projectRoot })
  const isolation = benchmarkIsolationEnabled()
  const installCheck = inspectClaudeNativeAgentInstall(projectRoot)
  if (!installCheck.verified && !input.allowNoInstall) {
    throw new NativeAgentInstallRequiredError(installCheck)
  }

  for (const [index, question] of questions.entries()) {
    const questionDir = questions.length === 1 ? outputRoot : join(outputRoot, `question-${String(index + 1).padStart(3, '0')}`)
    mkdirSync(questionDir, { recursive: true })

    const promptFile = join(questionDir, 'native_agent-prompt.txt')
    writeFileSync(promptFile, question, 'utf8')
    const baselineAnswerPath = answerFilePath(questionDir, 'baseline')
    const madarAnswerPath = answerFilePath(questionDir, 'madar')
    const reportPath = join(questionDir, 'report.json')
    const shareSafeReportPath = join(questionDir, 'report.share-safe.json')

    const reportShell: NativeAgentCompareReport = {
      baseline_mode: 'native_agent',
      question,
      graph_path: graphPath,
      isolation,
      environment,
      environment_contamination: emptyBenchmarkEnvironmentContamination(),
      exec_command: summarizeExecTemplate(input.execTemplate),
      baseline: { kind: 'runner_error', evidence: null, exit_code: null, stderr: null },
      madar: { kind: 'runner_error', evidence: null, exit_code: null, stderr: null },
      install_verified: installCheck.verified,
      measurement_validity: installCheck.verified ? 'degraded' : 'invalid',
      madar_mcp_call_count: 0,
      reductions: null,
      token_regression: false,
      token_regression_reasons: [],
      prompt_token_source: {
        baseline: 'unknown',
        madar: 'unknown',
      },
      provider_proof: {
        baseline: {
          provider: null,
          input_tokens_source: 'unknown',
          effective_tokens_source: 'unknown',
          total_tokens_source: 'unknown',
        },
        madar: {
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
        share_safe_report: shareSafeReportPath,
        baseline_answer: baselineAnswerPath,
        madar_answer: madarAnswerPath,
        prompt_file: promptFile,
      },
    }

    // Step 1: snapshot madar artifacts and run baseline.
    const stamp = timestamp.toISOString().replace(/[^0-9]/g, '').slice(0, 14)
    let snapshot: SnapshotRecord[] = []
    let baselineCrashed: unknown = null
    let baselineToolCallCounts: NativeAgentToolCallCountsEntry | null = null
    try {
      snapshot = snapshotMadarArtifacts(projectRoot, stamp)
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
        baselineToolCallCounts = extractNativeAgentToolCallCounts(baselineRun.stdout)
        const event = parseAnthropicResultEvent(baselineRun.stdout)
        if (event !== null) {
          reportShell.baseline = {
            kind: 'succeeded',
            model: event.model,
            usage: event.usage,
            total_input_tokens_anthropic_exact: totalAnthropicInputTokens(event.usage),
            uncached_input_tokens_anthropic_exact: uncachedAnthropicInputTokens(event.usage),
            cached_input_tokens_anthropic_exact: cachedAnthropicInputTokens(event.usage),
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
          reportShell.baseline =
            baselineRun.exitCode === 0
              ? {
                  kind: 'answer_only',
                  evidence: baselineRun.stdout.slice(0, 2000),
                  exit_code: baselineRun.exitCode,
                  stderr: sanitizeCompareStderr(baselineRun.stderr),
                  result_path: baselineAnswerPath,
                }
              : {
                  kind: 'runner_error',
                  evidence: baselineRun.stdout.slice(0, 2000),
                  exit_code: baselineRun.exitCode,
                  stderr: sanitizeCompareStderr(baselineRun.stderr),
                }
          ensureCompareAnswerFile(baselineAnswerPath, baselineRun.stdout)
        }
      }
    } finally {
      restoreMadarArtifacts(snapshot)
    }

    if (baselineCrashed !== null) {
      // Persist a partial report before re-throwing so users can inspect it.
      reportShell.completed_at = now().toISOString()
      writeNativeAgentReport(reportShell)
      reports.push(reportShell)
      throw baselineCrashed instanceof Error ? baselineCrashed : new Error(String(baselineCrashed))
    }

    // Step 2: run madar (artifacts are restored, MCP server is in place).
    const madarCommand = expandCompareExecTemplate(input.execTemplate, {
      promptFile,
      question,
      mode: 'madar',
      outputFile: madarAnswerPath,
    })
    let madarRun: NativeAgentRunnerResult | null = null
    let madarToolCallCounts: NativeAgentToolCallCountsEntry | null = null
    try {
      madarRun = await runner({ mode: 'madar', question, promptFile, outputFile: madarAnswerPath, command: madarCommand })
    } catch (error) {
      reportShell.madar = {
        kind: 'runner_error',
        evidence: error instanceof Error ? error.message : String(error),
        exit_code: null,
        stderr: null,
      }
      ensureCompareAnswerFile(madarAnswerPath, '')
    }
    if (madarRun !== null) {
      madarToolCallCounts = extractNativeAgentToolCallCounts(madarRun.stdout)
      reportShell.environment_contamination = extractEnvironmentContamination(madarRun.stdout)
      const rawMadarTrace = extractMadarTrace(madarRun.stdout)
      const madarTrace =
        rawMadarTrace === undefined
          ? undefined
          : applyNativeAgentMadarTraceOutcome(rawMadarTrace, installCheck.verified)
      if (madarTrace) {
        reportShell.madar_trace = madarTrace
        reportShell.madar_mcp_call_count = madarTrace.madar_mcp_call_count
      } else {
        delete reportShell.madar_trace
        reportShell.madar_mcp_call_count = 0
      }
      const event = parseAnthropicResultEvent(madarRun.stdout)
      if (event !== null) {
        reportShell.madar = {
          kind: 'succeeded',
          model: event.model,
          usage: event.usage,
          total_input_tokens_anthropic_exact: totalAnthropicInputTokens(event.usage),
          uncached_input_tokens_anthropic_exact: uncachedAnthropicInputTokens(event.usage),
          cached_input_tokens_anthropic_exact: cachedAnthropicInputTokens(event.usage),
          total_cost_usd: event.total_cost_usd,
          num_turns: event.num_turns,
          duration_ms: event.duration_ms,
          result_path: madarAnswerPath,
        }
        reportShell.prompt_token_source.madar = 'anthropic_provider_reported'
        if (reportShell.provider_proof) {
          reportShell.provider_proof.madar = {
            provider: 'anthropic',
            input_tokens_source: 'anthropic_provider_reported',
            effective_tokens_source: 'anthropic_provider_reported',
            total_tokens_source: 'anthropic_provider_reported',
          }
        }
        ensureCompareAnswerFile(madarAnswerPath, event.result ?? madarRun.stdout)
      } else {
        reportShell.madar =
          madarRun.exitCode === 0
            ? {
                kind: 'answer_only',
                evidence: madarRun.stdout.slice(0, 2000),
                exit_code: madarRun.exitCode,
                stderr: sanitizeCompareStderr(madarRun.stderr),
                result_path: madarAnswerPath,
              }
            : {
                kind: 'runner_error',
                evidence: madarRun.stdout.slice(0, 2000),
                exit_code: madarRun.exitCode,
                stderr: sanitizeCompareStderr(madarRun.stderr),
              }
        ensureCompareAnswerFile(madarAnswerPath, madarRun.stdout)
      }
    }

    if (baselineToolCallCounts !== null && madarToolCallCounts !== null) {
      reportShell.tool_call_counts = {
        baseline: baselineToolCallCounts,
        madar: madarToolCallCounts,
      }
    } else {
      delete reportShell.tool_call_counts
    }

    // Compute reductions only when both runs reported usage.
    if (reportShell.baseline.kind === 'succeeded' && reportShell.madar.kind === 'succeeded') {
      reportShell.reductions = {
        input_tokens: computeReduction(reportShell.baseline.total_input_tokens_anthropic_exact, reportShell.madar.total_input_tokens_anthropic_exact),
        uncached_input_tokens: computeReduction(reportShell.baseline.uncached_input_tokens_anthropic_exact, reportShell.madar.uncached_input_tokens_anthropic_exact),
        cache_creation_input_tokens: computeReduction(reportShell.baseline.usage.cache_creation_input_tokens, reportShell.madar.usage.cache_creation_input_tokens),
        num_turns: computeReduction(reportShell.baseline.num_turns, reportShell.madar.num_turns),
        duration_ms: computeReduction(reportShell.baseline.duration_ms, reportShell.madar.duration_ms),
        cost_usd:
          reportShell.baseline.total_cost_usd !== null && reportShell.madar.total_cost_usd !== null
            ? computeReduction(reportShell.baseline.total_cost_usd, reportShell.madar.total_cost_usd)
            : null,
      }
      reportShell.token_regression_reasons = collectTokenRegressionReasons(reportShell.baseline, reportShell.madar)
      reportShell.token_regression = reportShell.token_regression_reasons.length > 0
    }
    if (reportShell.provider_proof) {
      reportShell.provider_proof.reduction_basis =
        reportShell.provider_proof.baseline.input_tokens_source === 'anthropic_provider_reported'
        && reportShell.provider_proof.madar.input_tokens_source === 'anthropic_provider_reported'
          ? 'provider_reported'
          : reportShell.provider_proof.baseline.input_tokens_source === 'anthropic_provider_reported'
            || reportShell.provider_proof.madar.input_tokens_source === 'anthropic_provider_reported'
            ? 'mixed'
            : 'unknown'
    }
    reportShell.measurement_validity =
      reportShell.install_verified
        ? reportShell.madar_mcp_call_count > 0
          ? 'valid'
          : 'degraded'
        : 'invalid'
    const answerQuality = evaluateNativeAgentAnswerQualityReport(
      answerQualityGates,
      question,
      baselineAnswerPath,
      madarAnswerPath,
    )
    if (answerQuality !== undefined) {
      reportShell.answer_quality = answerQuality
    }

    reportShell.completed_at = now().toISOString()
    writeNativeAgentReport(reportShell)
    reports.push(reportShell)
  }

  const answerQualitySummary = summarizeNativeAgentAnswerQuality(reports)
  return {
    graph_path: graphPath,
    output_root: resolve(outputRoot),
    reports,
    ...(answerQualitySummary ? { answer_quality: answerQualitySummary } : {}),
  }
}

function writeNativeAgentReport(report: NativeAgentCompareReport): void {
  const shareSafeRoots = {
    artifactRoot: report.paths.output_dir,
    projectRoot: inferProjectRootFromGraphPath(report.graph_path),
  }
  const serializedReport = {
    ...report,
    graph_path: portablePath(report.graph_path),
    paths: {
      output_dir: portablePath(report.paths.output_dir),
      report: portablePath(report.paths.report),
      share_safe_report: portablePath(report.paths.share_safe_report),
      baseline_answer: portablePath(report.paths.baseline_answer),
      madar_answer: portablePath(report.paths.madar_answer),
      prompt_file: portablePath(report.paths.prompt_file),
    },
  }
  const shareSafeReport = sanitizeCompareShareSafeValue(report, shareSafeRoots)

  writeFileSync(
    report.paths.report,
    `${JSON.stringify(serializedReport, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    report.paths.share_safe_report,
    `${JSON.stringify(shareSafeReport, null, 2)}\n`,
    'utf8',
  )
}

function formatMeasurementValidityLine(report: NativeAgentCompareReport): string {
  switch (report.measurement_validity) {
    case 'valid':
      return 'measurement_validity: valid'
    case 'degraded':
      return 'measurement_validity: degraded (install detected, but no Madar MCP call was recorded)'
    case 'invalid':
      return 'measurement_validity: INVALID — no Madar install was detected; do not cite these numbers'
  }
}

function formatMadarMcpCallCountLine(report: NativeAgentCompareReport): string {
  if (!report.madar_trace) {
    return `madar_mcp_call_count: ${report.madar_mcp_call_count}`
  }

  const madarToolSummary = Object.entries(report.madar_trace.madar_mcp_calls_by_name)
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    .map(([toolName]) => toolName)
    .join(', ')

  return madarToolSummary.length > 0
    ? `madar_mcp_call_count: ${report.madar_mcp_call_count} (${madarToolSummary})`
    : `madar_mcp_call_count: ${report.madar_mcp_call_count}`
}

function appendNativeAgentValidityLines(lines: string[], report: NativeAgentCompareReport): void {
  lines.push(
    `    ${formatMeasurementValidityLine(report)}`,
    `    install_verified: ${report.install_verified}`,
    `    ${formatMadarMcpCallCountLine(report)}`,
  )
}

export function formatNativeAgentCompareSummary(result: NativeAgentCompareResult): string {
  const lines: string[] = [
    `[madar compare] completed ${result.reports.length} native_agent question(s)`,
    `- Output: ${result.output_root}`,
  ]
  const totalQuestionCount = result.reports.length
  const comparableReports = result.reports.filter(isComparableNativeAgentReport)
  if (comparableReports.length > 1) {
    lines.push(
      formatNativeAgentSuiteMetricLine(
        'input_tokens (Anthropic-reported)',
        nativeAgentSuiteChanges(comparableReports, (report) => ({
          baseline: report.baseline.total_input_tokens_anthropic_exact,
          madar: report.madar.total_input_tokens_anthropic_exact,
        })),
        'less',
        'more',
        true,
        totalQuestionCount,
      ),
      formatNativeAgentSuiteMetricLine(
        'num_turns',
        nativeAgentSuiteChanges(comparableReports, (report) => ({
          baseline: report.baseline.num_turns,
          madar: report.madar.num_turns,
        })),
        'fewer',
        'more',
        false,
        totalQuestionCount,
      ),
      formatNativeAgentSuiteMetricLine(
        'latency',
        nativeAgentSuiteChanges(comparableReports, (report) => ({
          baseline: report.baseline.duration_ms,
          madar: report.madar.duration_ms,
        })),
        'faster',
        'slower',
        false,
        totalQuestionCount,
      ),
    )
  }
  if (result.answer_quality) {
    lines.push(
      `- Answer quality: madar ${result.answer_quality.madar_passed}/${result.answer_quality.questions_checked} passed deterministic gates · baseline ${result.answer_quality.baseline_passed}/${result.answer_quality.questions_checked} passed deterministic gates · ${formatCount(result.answer_quality.manual_review_required, 'manual-review note', 'manual-review notes')}`,
    )
  }
  for (const report of result.reports) {
    if (isNativeAgentRunFailure(report.baseline) || isNativeAgentRunFailure(report.madar)) {
      lines.push(`- "${report.question}"`)
      appendNativeAgentValidityLines(lines, report)
      lines.push(`    runner error (see ${portablePath(report.paths.report)})`)
      continue
    }
    if (report.baseline.kind === 'answer_only' || report.madar.kind === 'answer_only') {
      lines.push(`- "${report.question}"`)
      appendNativeAgentValidityLines(lines, report)
      lines.push(`    answer-only run saved; no Anthropic usage block was available, so provider-proof reductions were not computed (see ${portablePath(report.paths.report)})`)
      continue
    }

    const baseline = report.baseline
    const madar = report.madar
    if (baseline.kind !== 'succeeded' || madar.kind !== 'succeeded') {
      lines.push(`- "${report.question}" → runner error (see ${portablePath(report.paths.report)})`)
      continue
    }

    const hasCacheActivity =
      baseline.usage.cache_creation_input_tokens > 0 ||
      baseline.cached_input_tokens_anthropic_exact > 0 ||
      madar.usage.cache_creation_input_tokens > 0 ||
      madar.cached_input_tokens_anthropic_exact > 0

    lines.push(
      `- "${report.question}"`,
      ...(() => {
        const validityLines: string[] = []
        appendNativeAgentValidityLines(validityLines, report)
        return validityLines
      })(),
      `    num_turns: baseline ${baseline.num_turns} → madar ${madar.num_turns}${formatDirectionalDelta(baseline.num_turns, madar.num_turns, 'fewer', 'more')}`,
      `    latency:   baseline ${baseline.duration_ms}ms → madar ${madar.duration_ms}ms${formatDirectionalDelta(baseline.duration_ms, madar.duration_ms, 'faster', 'slower')}`,
      `    input_tokens (Anthropic-reported): baseline ${baseline.total_input_tokens_anthropic_exact} → madar ${madar.total_input_tokens_anthropic_exact}${formatDirectionalDelta(baseline.total_input_tokens_anthropic_exact, madar.total_input_tokens_anthropic_exact, 'less', 'more', { noMeaningfulChangeThreshold: 0.1, neutralLabel: 'no meaningful change' })}`,
    )
    if (hasCacheActivity) {
      lines.push(
        `    uncached_input_tokens (Anthropic-reported): baseline ${baseline.uncached_input_tokens_anthropic_exact} → madar ${madar.uncached_input_tokens_anthropic_exact}${formatDirectionalDelta(baseline.uncached_input_tokens_anthropic_exact, madar.uncached_input_tokens_anthropic_exact, 'less', 'more')}`,
        `    cache_creation_input_tokens (Anthropic-reported): baseline ${baseline.usage.cache_creation_input_tokens} → madar ${madar.usage.cache_creation_input_tokens}${formatDirectionalDelta(baseline.usage.cache_creation_input_tokens, madar.usage.cache_creation_input_tokens, 'less', 'more')}`,
        `    cache_read_input_tokens (Anthropic-reported): baseline ${baseline.usage.cache_read_input_tokens} → madar ${madar.usage.cache_read_input_tokens}${formatDirectionalDelta(baseline.usage.cache_read_input_tokens, madar.usage.cache_read_input_tokens, 'less', 'more')}`,
      )
    }
    if (report.tool_call_counts) {
      lines.push(
        `    tool calls: baseline ${report.tool_call_counts.baseline.total} → madar ${report.tool_call_counts.madar.total}${formatDirectionalDelta(report.tool_call_counts.baseline.total, report.tool_call_counts.madar.total, 'fewer', 'more')}`,
      )
    }
    const derivedTokenRegressionReasons = collectTokenRegressionReasons(baseline, madar)
    const tokenRegressionReasons =
      report.token_regression_reasons && report.token_regression_reasons.length > 0
        ? report.token_regression_reasons
        : derivedTokenRegressionReasons
    const tokenRegressionWarning = formatTokenRegressionWarning(baseline, madar, tokenRegressionReasons)
    if (tokenRegressionWarning) {
      lines.push(`    ${tokenRegressionWarning}`)
    }
    if (report.answer_quality) {
      const baselineFindings = [
        ...report.answer_quality.baseline.missing_required_terms.map((term) => `missing ${term}`),
        ...report.answer_quality.baseline.forbidden_terms_present.map((term) => `forbidden ${term}`),
      ]
      const madarFindings = [
        ...report.answer_quality.madar.missing_required_terms.map((term) => `missing ${term}`),
        ...report.answer_quality.madar.forbidden_terms_present.map((term) => `forbidden ${term}`),
      ]
      lines.push(
        `    answer quality: baseline ${report.answer_quality.baseline.passed ? 'PASS' : `FAIL (${baselineFindings.join(', ')})`} · madar ${report.answer_quality.madar.passed ? 'PASS' : `FAIL (${madarFindings.join(', ')})`}${report.answer_quality.manual_review_notes.length > 0 ? ` · manual review: ${formatCount(report.answer_quality.manual_review_notes.length, 'note', 'notes')}` : ''}`,
      )
    }
    if (report.madar_trace) {
      lines.push(`    madar_trace: ${report.madar_trace.exploration_outcome} · ${report.madar_trace.exploration_summary}`)
    }
    lines.push(`    provider/runtime proof: Anthropic reported input, cache, and total tokens for both runs`)
  }
  return lines.join('\n')
}
