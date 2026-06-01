import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { analyzePrImpact, compactPrImpactResult } from '../runtime/pr-impact.js'
import { estimateQueryTokens, loadGraph } from '../runtime/serve.js'
import {
  sanitizeShareSafeText,
  toShareSafeArtifactPath,
  type ShareSafePathRoots,
} from '../shared/share-safe-artifacts.js'
import { findNearestExistingAncestor, validateGraphPath } from '../shared/security.js'
import { buildContextPrompt } from './context-prompt.js'

export type ReviewCompareMode = 'verbose' | 'compact'
export type ReviewCompareRunStatus = 'not_run' | 'succeeded' | 'failed'

export interface ReviewComparePromptArtifactPaths {
  output_dir: string
  verbose_prompt: string
  compact_prompt: string
  report: string
  share_safe_report: string
}

export interface ReviewCompareAnswerArtifactPaths {
  verbose: string
  compact: string
}

export interface ReviewCompareExecution {
  mode: ReviewCompareMode
  promptFile: string
  outputFile: string
  command: string
}

export interface ReviewCompareRunnerResult {
  exitCode: number
  stdout: string
  stderr: string
  elapsedMs: number
}

export interface ReviewCompareInput {
  graphPath: string
  execTemplate: string
  outputDir: string
  baseBranch?: string
  budget?: number
  now?: Date
}

export interface ReviewCompareReport {
  graph_path: string
  base_branch: string
  budget: number
  changed_files: string[]
  seed_count: number
  supporting_path_count: number
  test_path_count: number
  hotspot_count: number
  verbose_payload_tokens: number
  compact_payload_tokens: number
  payload_reduction_ratio: number
  verbose_prompt_tokens: number
  compact_prompt_tokens: number
  reduction_ratio: number
  verbose_effective_prompt_tokens: number
  compact_effective_prompt_tokens: number
  effective_reduction_ratio: number
  verbose_reused_context_tokens: number
  compact_reused_context_tokens: number
  provider_proof?: {
    verbose: {
      input_tokens_source: 'estimated_cl100k_base'
      effective_tokens_source: 'session_reuse_estimate'
      total_tokens_source: 'not_available'
    }
    compact: {
      input_tokens_source: 'estimated_cl100k_base'
      effective_tokens_source: 'session_reuse_estimate'
      total_tokens_source: 'not_available'
    }
    reduction_basis: 'estimated'
  }
  started_at: string
  completed_at: string
  elapsed_ms: Record<ReviewCompareMode, number>
  status: Record<ReviewCompareMode, ReviewCompareRunStatus>
  answer_paths: ReviewCompareAnswerArtifactPaths
  exit_code: Record<ReviewCompareMode, number | null>
  stderr: Record<ReviewCompareMode, string | null>
  paths: ReviewComparePromptArtifactPaths
}

export interface ReviewCompareResult {
  graph_path: string
  output_root: string
  report: ReviewCompareReport
}

export interface ExecuteReviewCompareRunsDependencies {
  runner?: (execution: ReviewCompareExecution) => Promise<ReviewCompareRunnerResult>
  now?: () => Date
}

const EXEC_TEMPLATE_PLACEHOLDER_PATTERN = /\{[a-z_][a-z0-9_]*\}/gi
const REVIEW_COMPARE_EXEC_PLACEHOLDERS = new Set(['{prompt_file}', '{mode}', '{output_file}'])
const REVIEW_PROMPT_ID_FIELDS = new Set(['node_id', 'from_id', 'to_id'])
const PATH_DERIVED_ID_TOKENS = new Set([
  'users',
  'user',
  'home',
  'desktop',
  'documents',
  'downloads',
  'projects',
  'project',
  'workspace',
  'workspaces',
  'src',
  'app',
  'tmp',
  'var',
])

function timestampDirectoryName(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/:/g, '-')
}

function portablePath(path: string): string {
  return relative(process.cwd(), path) || '.'
}

function rewriteAnswerPaths(paths: ReviewCompareAnswerArtifactPaths, roots: ShareSafePathRoots): ReviewCompareAnswerArtifactPaths {
  return {
    verbose: toShareSafeArtifactPath(paths.verbose, roots),
    compact: toShareSafeArtifactPath(paths.compact, roots),
  }
}

function rewriteReviewComparePaths(
  paths: ReviewComparePromptArtifactPaths,
  roots: ShareSafePathRoots,
): ReviewComparePromptArtifactPaths {
  return {
    output_dir: toShareSafeArtifactPath(paths.output_dir, roots),
    verbose_prompt: toShareSafeArtifactPath(paths.verbose_prompt, roots),
    compact_prompt: toShareSafeArtifactPath(paths.compact_prompt, roots),
    report: toShareSafeArtifactPath(paths.report, roots),
    share_safe_report: toShareSafeArtifactPath(paths.share_safe_report, roots),
  }
}

function rewriteShareSafeStderr(
  stderr: Record<ReviewCompareMode, string | null>,
  roots: ShareSafePathRoots,
): Record<ReviewCompareMode, string | null> {
  return {
    verbose: stderr.verbose === null ? null : sanitizeShareSafeText(stderr.verbose, roots),
    compact: stderr.compact === null ? null : sanitizeShareSafeText(stderr.compact, roots),
  }
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

function validateOutputDirForGraph(graphPath: string, outputDir: string): string {
  const projectRoot = realpathSync(inferProjectRootFromGraphPath(graphPath))
  const baseDir = realpathSync(resolve(projectRoot, 'out'))
  const resolvedOutputDir = isAbsolute(outputDir)
    ? resolve(outputDir)
    : outputDir === 'out' || outputDir.startsWith(`out${sep}`)
      ? resolve(projectRoot, outputDir)
      : resolve(outputDir)
  const existingAncestor = findNearestExistingAncestor(resolvedOutputDir)
  const normalizedOutputDir = existingAncestor === null
    ? resolvedOutputDir
    : resolve(realpathSync(existingAncestor), relative(existingAncestor, resolvedOutputDir))
  const basePrefix = baseDir.endsWith(sep) ? baseDir : `${baseDir}${sep}`

  if (normalizedOutputDir !== baseDir && !normalizedOutputDir.startsWith(basePrefix)) {
    throw new Error(`Path ${JSON.stringify(outputDir)} escapes the allowed directory ${baseDir}. Only paths inside out/ are permitted.`)
  }

  return normalizedOutputDir
}

function answerFilePath(outputDir: string, mode: ReviewCompareMode): string {
  return join(outputDir, `${mode}-answer.txt`)
}

function createOutputRoot(outputDir: string, date: Date): string {
  mkdirSync(outputDir, { recursive: true })
  const candidate = join(outputDir, timestampDirectoryName(date))
  mkdirSync(candidate, { recursive: true })
  return candidate
}

function shellEscape(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `'${value.replaceAll("'", "''")}'`
  }
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

function expandExecTemplate(
  template: string,
  values: Pick<ReviewCompareExecution, 'promptFile' | 'mode' | 'outputFile'>,
  platform: NodeJS.Platform = process.platform,
): string {
  return template.replaceAll(EXEC_TEMPLATE_PLACEHOLDER_PATTERN, (placeholder) => {
    const normalizedPlaceholder = placeholder.toLowerCase()
    if (!REVIEW_COMPARE_EXEC_PLACEHOLDERS.has(normalizedPlaceholder)) {
      throw new Error(`Unknown review-compare exec placeholder: ${placeholder}`)
    }
    if (normalizedPlaceholder === '{prompt_file}') {
      return shellEscape(values.promptFile, platform)
    }
    if (normalizedPlaceholder === '{mode}') {
      return shellEscape(values.mode, platform)
    }
    return shellEscape(values.outputFile, platform)
  })
}

async function defaultRunner(execution: ReviewCompareExecution): Promise<ReviewCompareRunnerResult> {
  const startedAt = Date.now()
  return await new Promise<ReviewCompareRunnerResult>((resolveExecution, rejectExecution) => {
    const command =
      process.platform === 'win32'
        ? { file: 'powershell.exe', args: ['-NoProfile', '-Command', execution.command] }
        : { file: '/bin/sh', args: ['-lc', execution.command] }
    const child = spawn(command.file, command.args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: string | Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: string | Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', rejectExecution)
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

function summarizeStderr(stderr: string): string | null {
  const trimmed = stderr.trim()
  return trimmed.length > 0 ? trimmed : null
}

function computeReductionRatio(left: number, right: number): number {
  if (left <= 0 || right <= 0) {
    return 0
  }
  return Number((left / right).toFixed(3))
}

function formatTokenComparison(left: number, right: number): string {
  if (left <= 0 || right <= 0) {
    return 'n/a'
  }
  if (left === right) {
    return 'same size'
  }
  if (left > right) {
    return `${computeReductionRatio(left, right)}x smaller`
  }
  return `${Number((right / left).toFixed(3))}x larger`
}

function isPathDerivedIdentifier(value: string): boolean {
  if (value.includes('/') || value.includes('\\')) {
    return true
  }

  const tokens = value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0)
  if (tokens.length < 4) {
    return false
  }

  const matchingTokens = tokens.filter((token) => PATH_DERIVED_ID_TOKENS.has(token)).length
  return matchingTokens >= 2
}

function sanitizePersistedIdentifier(value: string): string {
  return `review_node_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
}

function sanitizePersistedReviewPayload<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizePersistedReviewPayload(entry)) as T
  }

  if (value && typeof value === 'object') {
    const sanitizedEntries = Object.entries(value).map(([key, entryValue]) => {
      if (
        REVIEW_PROMPT_ID_FIELDS.has(key) &&
        typeof entryValue === 'string' &&
        entryValue.length > 0 &&
        isPathDerivedIdentifier(entryValue)
      ) {
        return [key, sanitizePersistedIdentifier(entryValue)]
      }
      return [key, sanitizePersistedReviewPayload(entryValue)]
    })
    return Object.fromEntries(sanitizedEntries) as T
  }

  return value
}

function renderReviewPrompt(payload: unknown, mode: ReviewCompareMode): ReturnType<typeof buildContextPrompt> {
  return buildContextPrompt({
    instructions: [
      'Review the current git diff using only the provided pr_impact payload.',
      'Summarize the changed areas, top risks, supporting files to inspect, likely tests to run, and structural hotspots to watch.',
    ],
    stable_prefix_title: 'pr_impact payload',
    stable_sections: [
      {
        ref: 'pr_impact_payload',
        body: JSON.stringify(payload, null, 2),
      },
    ],
    dynamic_sections: [
      { body: `Mode: ${mode}` },
      { body: 'Answer:' },
    ],
  })
}

function writeReport(report: ReviewCompareReport): void {
  const roots = {
    artifactRoot: report.paths.output_dir,
    projectRoot: inferProjectRootFromGraphPath(report.graph_path),
  }
  const serializedReport = {
    ...report,
    graph_path: portablePath(report.graph_path),
    answer_paths: {
      verbose: portablePath(report.answer_paths.verbose),
      compact: portablePath(report.answer_paths.compact),
    },
    paths: {
      output_dir: portablePath(report.paths.output_dir),
      verbose_prompt: portablePath(report.paths.verbose_prompt),
      compact_prompt: portablePath(report.paths.compact_prompt),
      report: portablePath(report.paths.report),
      share_safe_report: portablePath(report.paths.share_safe_report),
    },
  }
  const shareSafeReport = {
    ...report,
    graph_path: toShareSafeArtifactPath(report.graph_path, roots),
    answer_paths: rewriteAnswerPaths(report.answer_paths, roots),
    stderr: rewriteShareSafeStderr(report.stderr, roots),
    paths: rewriteReviewComparePaths(report.paths, roots),
  }

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

export function generateReviewCompareArtifacts(input: ReviewCompareInput): ReviewCompareResult {
  const graphPath = validateGraphPath(input.graphPath)
  const outputDir = validateOutputDirForGraph(graphPath, input.outputDir)
  const graph = loadGraph(graphPath)
  const projectRoot = realpathSync(inferProjectRootFromGraphPath(graphPath))
  const now = input.now ?? new Date()
  const outputRoot = createOutputRoot(outputDir, now)
  const verbosePayload = analyzePrImpact(graph, projectRoot, {
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
  })
  const compactPayload = compactPrImpactResult(verbosePayload)
  const persistedVerbosePayload = sanitizePersistedReviewPayload(verbosePayload)
  const persistedCompactPayload = sanitizePersistedReviewPayload(compactPayload)
  const verbosePromptArtifact = renderReviewPrompt(persistedVerbosePayload, 'verbose')
  const compactPromptArtifact = renderReviewPrompt(persistedCompactPayload, 'compact')
  const verbosePrompt = verbosePromptArtifact.prompt
  const compactPrompt = compactPromptArtifact.prompt

  const paths: ReviewComparePromptArtifactPaths = {
    output_dir: outputRoot,
    verbose_prompt: join(outputRoot, 'verbose-prompt.txt'),
    compact_prompt: join(outputRoot, 'compact-prompt.txt'),
    report: join(outputRoot, 'report.json'),
    share_safe_report: join(outputRoot, 'report.share-safe.json'),
  }
  const answerPaths: ReviewCompareAnswerArtifactPaths = {
    verbose: answerFilePath(outputRoot, 'verbose'),
    compact: answerFilePath(outputRoot, 'compact'),
  }

  writeFileSync(paths.verbose_prompt, verbosePrompt, 'utf8')
  writeFileSync(paths.compact_prompt, compactPrompt, 'utf8')

  const verbosePayloadTokens = estimateQueryTokens(JSON.stringify(persistedVerbosePayload))
  const compactPayloadTokens = estimateQueryTokens(JSON.stringify(persistedCompactPayload))
  const verbosePromptTokens = estimateQueryTokens(verbosePrompt)
  const compactPromptTokens = estimateQueryTokens(compactPrompt)

  const report: ReviewCompareReport = {
    graph_path: graphPath,
    base_branch: verbosePayload.base_branch,
    budget: verbosePayload.review_bundle.budget,
    changed_files: verbosePayload.changed_files,
    seed_count: verbosePayload.seed_nodes.length,
    supporting_path_count: verbosePayload.review_context.supporting_paths.length,
    test_path_count: verbosePayload.review_context.test_paths.length,
    hotspot_count: verbosePayload.review_context.hotspots.length,
    verbose_payload_tokens: verbosePayloadTokens,
    compact_payload_tokens: compactPayloadTokens,
    payload_reduction_ratio: computeReductionRatio(verbosePayloadTokens, compactPayloadTokens),
    verbose_prompt_tokens: verbosePromptTokens,
    compact_prompt_tokens: compactPromptTokens,
    reduction_ratio: computeReductionRatio(verbosePromptTokens, compactPromptTokens),
    verbose_effective_prompt_tokens: verbosePromptArtifact.metrics.effective_prompt_tokens,
    compact_effective_prompt_tokens: compactPromptArtifact.metrics.effective_prompt_tokens,
    effective_reduction_ratio: computeReductionRatio(
      verbosePromptArtifact.metrics.effective_prompt_tokens,
      compactPromptArtifact.metrics.effective_prompt_tokens,
    ),
    verbose_reused_context_tokens: verbosePromptArtifact.metrics.reused_context_tokens,
    compact_reused_context_tokens: compactPromptArtifact.metrics.reused_context_tokens,
    provider_proof: {
      verbose: {
        input_tokens_source: 'estimated_cl100k_base',
        effective_tokens_source: 'session_reuse_estimate',
        total_tokens_source: 'not_available',
      },
      compact: {
        input_tokens_source: 'estimated_cl100k_base',
        effective_tokens_source: 'session_reuse_estimate',
        total_tokens_source: 'not_available',
      },
      reduction_basis: 'estimated',
    },
    started_at: now.toISOString(),
    completed_at: now.toISOString(),
    elapsed_ms: {
      verbose: 0,
      compact: 0,
    },
    status: {
      verbose: 'not_run',
      compact: 'not_run',
    },
    answer_paths: answerPaths,
    exit_code: {
      verbose: null,
      compact: null,
    },
    stderr: {
      verbose: null,
      compact: null,
    },
    paths,
  }

  writeReport(report)

  return {
    graph_path: graphPath,
    output_root: resolve(outputRoot),
    report,
  }
}

export async function executeReviewCompareRuns(
  input: ReviewCompareInput,
  dependencies: ExecuteReviewCompareRunsDependencies = {},
): Promise<ReviewCompareResult> {
  const result = generateReviewCompareArtifacts(input)
  const runPrompt = dependencies.runner ?? defaultRunner
  const now = dependencies.now ?? (() => new Date())

  const executions: Array<{ mode: ReviewCompareMode; promptFile: string; outputFile: string }> = [
    {
      mode: 'verbose',
      promptFile: result.report.paths.verbose_prompt,
      outputFile: result.report.answer_paths.verbose,
    },
    {
      mode: 'compact',
      promptFile: result.report.paths.compact_prompt,
      outputFile: result.report.answer_paths.compact,
    },
  ]

  for (const execution of executions) {
    try {
      const command = expandExecTemplate(input.execTemplate, execution)
      const executionResult = await runPrompt({
        ...execution,
        command,
      })
      writeFileSync(execution.outputFile, executionResult.stdout, 'utf8')
      result.report.status[execution.mode] = executionResult.exitCode === 0 ? 'succeeded' : 'failed'
      result.report.elapsed_ms[execution.mode] = executionResult.elapsedMs
      result.report.exit_code[execution.mode] = executionResult.exitCode
      result.report.stderr[execution.mode] = summarizeStderr(executionResult.stderr)
    } catch (error) {
      writeFileSync(execution.outputFile, '', 'utf8')
      result.report.status[execution.mode] = 'failed'
      result.report.elapsed_ms[execution.mode] = 0
      result.report.exit_code[execution.mode] = null
      result.report.stderr[execution.mode] = summarizeStderr(error instanceof Error ? error.message : String(error))
    }
    result.report.completed_at = now().toISOString()
    writeReport(result.report)
  }

  return result
}

export function formatReviewCompareSummary(result: ReviewCompareResult): string {
  return [
    '[madar review-compare] completed current diff comparison',
    `- Output: ${result.output_root}`,
    `- Prompt tokens: verbose ${result.report.verbose_prompt_tokens} · compact ${result.report.compact_prompt_tokens} · ${formatTokenComparison(result.report.verbose_prompt_tokens, result.report.compact_prompt_tokens)}`,
    `- Effective prompt tokens: verbose ${result.report.verbose_effective_prompt_tokens} · compact ${result.report.compact_effective_prompt_tokens} · ${formatTokenComparison(result.report.verbose_effective_prompt_tokens, result.report.compact_effective_prompt_tokens)}`,
    `- Payload tokens: verbose ${result.report.verbose_payload_tokens} · compact ${result.report.compact_payload_tokens} · ${formatTokenComparison(result.report.verbose_payload_tokens, result.report.compact_payload_tokens)}`,
    '- Provider/runtime proof: local cl100k_base estimate + session reuse accounting',
    `- Prompt runs: verbose ${result.report.status.verbose} (${result.report.elapsed_ms.verbose} ms) · compact ${result.report.status.compact} (${result.report.elapsed_ms.compact} ms)`,
  ].join('\n')
}

export async function runReviewCompareCommand(
  input: ReviewCompareInput,
  dependencies: ExecuteReviewCompareRunsDependencies = {},
): Promise<string> {
  const result = await executeReviewCompareRuns(input, dependencies)
  const failedRuns = [result.report.status.verbose, result.report.status.compact].filter((status) => status === 'failed').length
  if (failedRuns > 0) {
    throw new Error(`[madar review-compare] ${failedRuns} prompt run(s) failed. Partial artifacts were saved under ${result.output_root}`)
  }
  return formatReviewCompareSummary(result)
}
