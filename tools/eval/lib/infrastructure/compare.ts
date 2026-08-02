import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'

import { readGraphSourceRoot } from '../shared/graph-source-root.js'
import { resolveShellCommand, shellEscape } from '../shared/shell.js'
import { sanitizeShareSafeText } from '../shared/share-safe-artifacts.js'
import { validateGraphOutputPath, validateGraphPath } from '../../../../src/shared/security.js'

export type CompareRunMode = 'baseline' | 'madar'

export interface GenerateCompareArtifactsInput {
  graphPath: string
  question: string
  outputDir: string
  execTemplate: string
  perArmTimeoutSeconds?: number
}

const DEFAULT_COMPARE_PER_ARM_TIMEOUT_SECONDS = 600
const EXEC_TEMPLATE_PLACEHOLDER_PATTERN = /\{[a-z_][a-z0-9_]*\}/gi
const PROMPT_FILE_COMMAND_SUBSTITUTION_PATTERNS = [
  /\$\([^)]*\{prompt_file\}[^)]*\)/i,
  /`[^`]*\{prompt_file\}[^`]*`/i,
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function createCompareOutputRoot(outputDir: string): string {
  const safeOutput = validateGraphOutputPath(outputDir)
  mkdirSync(safeOutput, { recursive: true })
  return mkdtempSync(join(safeOutput, 'run-'))
}

function validateCompareExecTemplate(template: string): void {
  if (PROMPT_FILE_COMMAND_SUBSTITUTION_PATTERNS.some((pattern) => pattern.test(template))) {
    throw new Error(
      'Exec templates must not expand {prompt_file} with shell command substitution. Use stdin or file redirection with {prompt_file}.',
    )
  }
}

export function expandCompareExecTemplate(
  template: string,
  values: {
    promptFile: string
    question: string
    mode: CompareRunMode
    outputFile: string
  },
  platform: NodeJS.Platform = process.platform,
): string {
  const replacements: Record<string, string> = {
    '{prompt_file}': values.promptFile,
    '{question}': values.question,
    '{mode}': values.mode,
    '{output_file}': values.outputFile,
  }
  return template.replaceAll(EXEC_TEMPLATE_PLACEHOLDER_PATTERN, (placeholder) => {
    const replacement = replacements[placeholder.toLowerCase()]
    if (replacement === undefined) {
      throw new Error(`Unknown compare exec placeholder: ${placeholder}`)
    }
    return shellEscape(replacement, platform)
  })
}

function buildNativeAgentBaselinePrompt(question: string): string {
  return [
    'Answer the following repository question. Inspect the repository directly.',
    'Do not use Madar. Cite exact files and symbols and state uncertainty.',
    '',
    question,
  ].join('\n')
}

export function buildNativeAgentPrompt(
  question: string,
): string {
  return [
    'For this repository question, call the Madar `retrieve` tool exactly once before any direct repository search.',
    'Pass exactly the question below and no legacy retrieval controls.',
    'Answer from the authenticated excerpts and directed relationships returned by Madar.',
    'If Madar reports a boundary, use only targeted direct reads needed to verify that boundary.',
    'Do not call another Madar tool. Cite exact files and symbols and state remaining uncertainty.',
    '',
    question,
  ].join('\n')
}

function ensureAnswerFile(path: string, answer: string | null, stdout: string): void {
  if (!existsSync(path)) writeFileSync(path, answer ?? stdout, 'utf8')
}

export type NativeAgentRunStatus =
  | {
      kind: 'succeeded'
      total_input_tokens: number
      total_cost_usd: number | null
      duration_ms: number
    }
  | {
      kind: 'runner_error'
      exit_code: number | null
      stderr: string | null
      timed_out: boolean
    }

export type NativeAgentToolCallCountsEntry = Record<'total' | 'read' | 'search', number>
export type NativeAgentToolCallCounts = Record<CompareRunMode, NativeAgentToolCallCountsEntry>

export interface NativeAgentCompareReport {
  baseline: NativeAgentRunStatus
  madar: NativeAgentRunStatus
  attribution_status: 'verified' | 'missing' | 'violated'
  tool_call_counts?: NativeAgentToolCallCounts
}

export interface NativeAgentRunnerInput {
  mode: CompareRunMode
  command: string
  cwd: string
  signal?: AbortSignal
}

export type NativeAgentRunnerResult = { exitCode: number; stdout: string; stderr: string }
export type NativeAgentRunner = (input: NativeAgentRunnerInput) => Promise<NativeAgentRunnerResult>

function parseJsonRecords(stdout: string): Record<string, unknown>[] {
  const records: unknown[] = []
  for (const candidate of stdout.split(/\r?\n/).map((line) => line.trim())) {
    if (!candidate) continue
    try {
      const value = JSON.parse(candidate) as unknown
      records.push(...(Array.isArray(value) ? value : [value]))
    } catch {
      continue
    }
  }
  return records.filter(isRecord)
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null
}

export function parseAnthropicResultEvent(stdout: string) {
  const records = parseJsonRecords(stdout)
  for (const record of records.reverse()) {
    if (record.type !== 'result' || !isRecord(record.usage)) continue
    const inputTokens = nonNegativeNumber(record.usage.input_tokens)
    const duration = nonNegativeNumber(record.duration_ms)
    if (inputTokens === null || duration === null) continue
    return {
      duration_ms: duration,
      total_cost_usd: nonNegativeNumber(record.total_cost_usd),
      result: typeof record.result === 'string' ? record.result : null,
      total_input_tokens:
        inputTokens +
        (nonNegativeNumber(record.usage.cache_creation_input_tokens) ?? 0) +
        (nonNegativeNumber(record.usage.cache_read_input_tokens) ?? 0),
    }
  }
  return null
}

function collectToolUses(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectToolUses(entry, output)
    return
  }
  if (!isRecord(value)) return
  if (value.type === 'tool_use' && typeof value.name === 'string') {
    output.push(value.name)
  }
  for (const entry of Object.values(value)) collectToolUses(entry, output)
}

function canonicalToolName(name: string): string {
  return name.replace(/^mcp__madar__/, '').replace(/^madar[_.:-]+/i, '')
}

function isMadarTool(name: string): boolean {
  return name.startsWith('mcp__madar__') || /^madar[_.:-]/i.test(name)
}

function isRepositoryTool(name: string): boolean {
  return /^(?:Read|Glob|Grep|Bash|Agent|Search|WebSearch|list|shell-read-only)$/i.test(name)
}

function isNeutralDiscoveryTool(name: string): boolean {
  return /^ToolSearch$/i.test(name)
}

function extractAttribution(stdout: string): {
  madarCallCount: number
  firstMadarToolName: string | null
  repositoryCallCount: number
  repositoryCallsBeforeMadar: number
  unclassifiedCallCount: number
  counts: NativeAgentToolCallCountsEntry
} | undefined {
  const records = parseJsonRecords(stdout)
  if (records.length === 0) return undefined
  const uses: string[] = []
  records.forEach((record) => collectToolUses(record, uses))
  if (!records.some((record) => record.type === 'assistant')) return undefined
  const madarUses = uses.filter(isMadarTool)
  const firstMadar = madarUses[0]
  const firstMadarIndex = firstMadar ? uses.indexOf(firstMadar) : -1
  const repositoryCallsBeforeMadar =
    firstMadarIndex < 0
      ? uses.filter(isRepositoryTool).length
      : uses.slice(0, firstMadarIndex).filter(isRepositoryTool).length
  return {
    madarCallCount: madarUses.length,
    firstMadarToolName: firstMadar ? canonicalToolName(firstMadar) : null,
    repositoryCallCount: uses.filter(isRepositoryTool).length,
    repositoryCallsBeforeMadar,
    unclassifiedCallCount: uses.filter((name) =>
      !isMadarTool(name) && !isRepositoryTool(name) && !isNeutralDiscoveryTool(name)).length,
    counts: {
      total: uses.length,
      read: uses.filter((name) => name === 'Read').length,
      search: uses.filter((name) => name === 'Glob' || name === 'Grep').length,
    },
  }
}

async function defaultNativeAgentRunner(
  input: NativeAgentRunnerInput,
): Promise<NativeAgentRunnerResult> {
  return await new Promise((resolveExecution, rejectExecution) => {
    const command = resolveShellCommand(input.command)
    const child = spawn(command.file, command.args, {
      cwd: input.cwd,
      shell: false,
      signal: input.signal,
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
    child.on('error', rejectExecution)
    child.on('close', (code) => {
      resolveExecution({
        exitCode: code ?? 1,
        stdout,
        stderr,
      })
    })
  })
}

async function runNativeArm(
  input: NativeAgentRunnerInput,
  runner: NativeAgentRunner,
  timeoutSeconds: number,
): Promise<NativeAgentRunnerResult & { timedOut: boolean }> {
  const controller = new AbortController()
  let timeout: NodeJS.Timeout | undefined
  try {
    const execution = runner({ ...input, signal: controller.signal })
      .then((result) => ({ ...result, timedOut: controller.signal.aborted }))
      .catch((error: unknown) => ({
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: controller.signal.aborted,
      }))
    const timedOut = new Promise<NativeAgentRunnerResult & { timedOut: boolean }>(
      (resolveTimeout) => {
        timeout = setTimeout(() => {
          controller.abort()
          resolveTimeout({
            exitCode: 1,
            stdout: '',
            stderr: `runner timed out after ${timeoutSeconds} seconds`,
            timedOut: true,
          })
        }, timeoutSeconds * 1000)
      },
    )
    return await Promise.race([execution, timedOut])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function nativeStatus(
  result: NativeAgentRunnerResult & { timedOut: boolean },
  resultPath: string,
): NativeAgentRunStatus {
  const parsed = parseAnthropicResultEvent(result.stdout)
  ensureAnswerFile(resultPath, parsed?.result ?? null, result.stdout)
  const failure = (
    exitCode: number | null,
    message: string | null,
    timedOut = false,
  ): NativeAgentRunStatus => ({
    kind: 'runner_error',
    exit_code: exitCode,
    stderr: message,
    timed_out: timedOut,
  })
  if (result.timedOut) return failure(null, result.stderr.trim() || null, true)
  if (result.exitCode !== 0) {
    return failure(result.exitCode, result.stderr.trim() || null)
  }
  if (!parsed) return failure(0, 'runner did not emit a structured result event')
  return {
    kind: 'succeeded',
    total_input_tokens: parsed.total_input_tokens,
    total_cost_usd: parsed.total_cost_usd,
    duration_ms: parsed.duration_ms,
  }
}

function writeNativeReport(
  report: NativeAgentCompareReport,
  outputDir: string,
  projectRoot: string,
): void {
  const roots = {
    artifactRoot: outputDir,
    projectRoot,
  }
  writeFileSync(
    join(outputDir, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  )
  const sanitizeStatus = (status: NativeAgentRunStatus): NativeAgentRunStatus =>
    status.kind === 'runner_error' && status.stderr
      ? { ...status, stderr: sanitizeShareSafeText(status.stderr, roots) }
      : status
  const safe = {
    ...report,
    baseline: sanitizeStatus(report.baseline),
    madar: sanitizeStatus(report.madar),
  }
  writeFileSync(
    join(outputDir, 'report.share-safe.json'),
    `${JSON.stringify(safe, null, 2)}\n`,
    'utf8',
  )
}

export async function executeNativeAgentCompare(
  input: GenerateCompareArtifactsInput,
  dependencies: { runner?: NativeAgentRunner } = {},
) {
  validateCompareExecTemplate(input.execTemplate)
  const graphPath = validateGraphPath(input.graphPath)
  const projectRoot = realpathSync(readGraphSourceRoot(graphPath))
  const question = input.question.trim()
  if (!question) throw new Error('Compare requires a question')
  const outputRoot = createCompareOutputRoot(input.outputDir)
  const runner = dependencies.runner ?? defaultNativeAgentRunner
  const timeoutSeconds =
    input.perArmTimeoutSeconds ?? DEFAULT_COMPARE_PER_ARM_TIMEOUT_SECONDS
  const runArm = async (mode: CompareRunMode, prompt: string) => {
    const promptFile = join(outputRoot, `${mode}-prompt.txt`)
    const answerFile = join(outputRoot, `${mode}-answer.txt`)
    writeFileSync(promptFile, prompt, 'utf8')
    const raw = await runNativeArm(
      {
        mode,
        command: expandCompareExecTemplate(input.execTemplate, {
          promptFile,
          question,
          mode,
          outputFile: answerFile,
        }),
        cwd: projectRoot,
      },
      runner,
      timeoutSeconds,
    )
    return {
      status: nativeStatus(raw, answerFile),
      trace: extractAttribution(raw.stdout),
    }
  }
  const baselineRun = await runArm(
    'baseline',
    buildNativeAgentBaselinePrompt(question),
  )
  const madarRun = await runArm('madar', buildNativeAgentPrompt(question))
  const { status: baseline, trace: baselineTrace } = baselineRun
  const { status: madar, trace: madarTrace } = madarRun
  const attributionStatus: NativeAgentCompareReport['attribution_status'] =
    !baselineTrace || !madarTrace
      ? 'missing'
      : baselineTrace.madarCallCount === 0 &&
          madarTrace.madarCallCount === 1 &&
          madarTrace.firstMadarToolName === 'retrieve' &&
          madarTrace.repositoryCallsBeforeMadar === 0 &&
          madarTrace.repositoryCallCount === 0 &&
          madarTrace.unclassifiedCallCount === 0
        ? 'verified'
        : 'violated'
  const report: NativeAgentCompareReport = {
    baseline,
    madar,
    attribution_status: attributionStatus,
    ...(baselineTrace && madarTrace
      ? {
          tool_call_counts: {
            baseline: baselineTrace.counts,
            madar: madarTrace.counts,
          },
        }
      : {}),
  }
  writeNativeReport(report, outputRoot, projectRoot)
  return { output_root: outputRoot, report }
}

export async function runCompareCommand(
  input: GenerateCompareArtifactsInput,
): Promise<string> {
  const result = await executeNativeAgentCompare(input)
  return [
    '[madar compare] completed native_agent comparison',
    `- Output: ${relative(process.cwd(), result.output_root) || '.'}`,
    `- Attribution: ${result.report.attribution_status}`,
  ].join('\n')
}
