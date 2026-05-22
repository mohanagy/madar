import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { KnowledgeGraph } from '../../contracts/graph.js'
import type { ContextSessionState } from '../../contracts/context-session.js'
import { type RetrieveResult, retrieveContext } from '../../runtime/retrieve.js'
import { QUERY_TOKEN_ESTIMATOR } from '../../runtime/serve.js'
import { toShareSafeArtifactPath } from '../../shared/share-safe-artifacts.js'
import { validateGraphOutputPath } from '../../shared/security.js'
import { buildMadarPromptPack, expandCompareExecTemplate } from '../compare.js'
import { parsePromptRunnerOutput, type PromptRunnerUsage } from '../prompt-runner.js'

const DEFAULT_RETRIEVAL_BUDGET = 3_000
const PROMPT_FILE_COMMAND_SUBSTITUTION_PATTERNS = [
  /\$\([^)]*\{prompt_file\}[^)]*\)/i,
  /`[^`]*\{prompt_file\}[^`]*`/i,
]

export type BenchmarkPromptTokenSource = 'estimated_cl100k_base' | 'claude_reported_input' | 'gemini_reported_input'

export interface BenchmarkPromptArtifacts {
  prompt: string
  answer: string
  report: string
  share_safe_report: string
}

export interface BenchmarkPromptExecution {
  mode: 'madar'
  question: string
  promptFile: string
  outputFile: string
  command: string
}

export interface BenchmarkPromptRunnerResult {
  exitCode: number
  stdout: string
  stderr: string
  elapsedMs: number
}

export interface RunBenchmarkPromptOptions {
  graphPath: string
  graph: KnowledgeGraph
  question: string
  execTemplate: string
  outputDir?: string
  now?: Date
  retrievalBudget?: number
  retrieval?: RetrieveResult
  session?: ContextSessionState
  runner?: (execution: BenchmarkPromptExecution) => Promise<BenchmarkPromptRunnerResult>
}

export interface BenchmarkPromptRun {
  prompt_tokens_estimated: number
  query_tokens: number
  effective_query_tokens: number
  reused_context_tokens: number
  total_tokens: number | null
  prompt_token_source: BenchmarkPromptTokenSource
  usage: PromptRunnerUsage | null
  answer_text: string | null
  elapsed_ms: number
  artifacts: BenchmarkPromptArtifacts
  session_state: ContextSessionState
}

function timestampDirectoryName(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/:/g, '-')
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

function createBenchmarkOutputRoot(graphPath: string, outputDir: string | undefined, now: Date): string {
  const graphOutputDir = dirname(resolve(graphPath))
  const outputRoot = validateGraphOutputPath(outputDir ?? join(graphOutputDir, 'benchmark'), graphOutputDir)
  mkdirSync(outputRoot, { recursive: true })

  const timestampDirectory = timestampDirectoryName(now)
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidate = join(outputRoot, suffix === 0 ? timestampDirectory : `${timestampDirectory}-${String(suffix).padStart(3, '0')}`)
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

  throw new Error(`Unable to create a unique benchmark output directory inside ${outputRoot}`)
}

function validateBenchmarkExecTemplate(template: string): void {
  if (PROMPT_FILE_COMMAND_SUBSTITUTION_PATTERNS.some((pattern) => pattern.test(template))) {
    throw new Error(
      'Exec templates must not expand {prompt_file} with shell command substitution. Use stdin or file redirection with {prompt_file}, for example: cat {prompt_file} | claude -p',
    )
  }
}

async function defaultBenchmarkPromptRunner(execution: BenchmarkPromptExecution): Promise<BenchmarkPromptRunnerResult> {
  const startedAt = Date.now()

  return await new Promise<BenchmarkPromptRunnerResult>((resolveExecution, rejectExecution) => {
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

function ensureBenchmarkAnswerFile(filePath: string, answerText: string | null, stdout: string): void {
  if (existsSync(filePath)) {
    return
  }
  writeFileSync(filePath, answerText ?? stdout, 'utf8')
}

function benchmarkPromptTokenSource(usage: PromptRunnerUsage | null): BenchmarkPromptTokenSource {
  if (usage === null) {
    return 'estimated_cl100k_base'
  }

  return usage.provider === 'claude' ? 'claude_reported_input' : 'gemini_reported_input'
}

export function retrieveBenchmarkContext(graph: KnowledgeGraph, graphPath: string, question: string, budget: number): RetrieveResult {
  const projectRoot = realpathSync(inferProjectRootFromGraphPath(graphPath))
  const originalCwd = process.cwd()
  try {
    process.chdir(projectRoot)
    return retrieveContext(graph, { question, budget })
  } finally {
    process.chdir(originalCwd)
  }
}

export async function runBenchmarkPrompt(options: RunBenchmarkPromptOptions): Promise<BenchmarkPromptRun> {
  validateBenchmarkExecTemplate(options.execTemplate)

  const startedAt = options.now ?? new Date()
  const outputRoot = createBenchmarkOutputRoot(options.graphPath, options.outputDir, startedAt)
  const retrieval = options.retrieval ?? retrieveBenchmarkContext(
    options.graph,
    options.graphPath,
      options.question,
      options.retrievalBudget ?? DEFAULT_RETRIEVAL_BUDGET,
  )
  const promptPack = buildMadarPromptPack({
    question: options.question,
    retrieval,
    ...(options.session ? { session: options.session } : {}),
  })
  const artifacts: BenchmarkPromptArtifacts = {
    prompt: join(outputRoot, 'madar-prompt.txt'),
    answer: join(outputRoot, 'madar-answer.txt'),
    report: join(outputRoot, 'report.json'),
    share_safe_report: join(outputRoot, 'report.share-safe.json'),
  }
  writeFileSync(artifacts.prompt, promptPack.session_payload, 'utf8')

  const command = expandCompareExecTemplate(options.execTemplate, {
    promptFile: artifacts.prompt,
    question: options.question,
    mode: 'madar',
    outputFile: artifacts.answer,
  })
  const execute = options.runner ?? defaultBenchmarkPromptRunner
  const execution = await execute({
    mode: 'madar',
    question: options.question,
    promptFile: artifacts.prompt,
    outputFile: artifacts.answer,
    command,
  })
  const parsedOutput = parsePromptRunnerOutput(execution.stdout)
  ensureBenchmarkAnswerFile(artifacts.answer, parsedOutput.answerText, execution.stdout)

  if (execution.exitCode !== 0) {
    throw new Error(`Benchmark runner failed for ${JSON.stringify(options.question)} (exit ${execution.exitCode})${execution.stderr.trim().length > 0 ? `: ${execution.stderr.trim()}` : ''}`)
  }

  const usage = parsedOutput.usage
  const run: BenchmarkPromptRun = {
    prompt_tokens_estimated: promptPack.session_payload_token_count,
    query_tokens: usage?.input_total_tokens ?? promptPack.session_payload_token_count,
    effective_query_tokens:
      usage?.input_total_tokens !== undefined
        ? usage.input_total_tokens - usage.cache_read_input_tokens
        : promptPack.effective_token_count,
    reused_context_tokens: usage?.cache_read_input_tokens ?? promptPack.reused_context_tokens,
    total_tokens: usage?.total_tokens ?? null,
    prompt_token_source: benchmarkPromptTokenSource(usage),
    usage,
    answer_text: parsedOutput.answerText,
    elapsed_ms: execution.elapsedMs,
    artifacts,
    session_state: promptPack.session_state,
  }

  const localReportArtifacts = {
    prompt: portablePath(artifacts.prompt),
    answer: portablePath(artifacts.answer),
    report: portablePath(artifacts.report),
  }
  const localReport = {
    question: options.question,
    prompt_tokens_estimated: run.prompt_tokens_estimated,
    query_tokens: run.query_tokens,
    effective_query_tokens: run.effective_query_tokens,
    reused_context_tokens: run.reused_context_tokens,
    total_tokens: run.total_tokens,
    prompt_token_source: run.prompt_token_source,
    usage: run.usage,
    elapsed_ms: run.elapsed_ms,
    prompt_token_estimator: QUERY_TOKEN_ESTIMATOR,
    artifacts: localReportArtifacts,
  }
  const shareSafeRoots = {
    artifactRoot: outputRoot,
    projectRoot: inferProjectRootFromGraphPath(options.graphPath),
  }
  writeFileSync(
    artifacts.report,
    `${JSON.stringify(localReport, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    artifacts.share_safe_report,
      `${JSON.stringify(
        {
          ...localReport,
          share_safe_report: true,
          artifacts: {
            ...Object.fromEntries(
              Object.entries(localReportArtifacts).map(([key, path]) => [key, toShareSafeArtifactPath(path, shareSafeRoots)]),
            ),
            share_safe_report: toShareSafeArtifactPath(artifacts.share_safe_report, shareSafeRoots),
          },
        },
      null,
      2,
    )}\n`,
    'utf8',
  )

  return run
}
