import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

import { executeNativeAgentCompare, type NativeAgentCompareReport, type NativeAgentCompareResult } from '../compare.js'
import {
  benchmarkIsolationEnabled,
  captureBenchmarkEnvironment,
  findEnvironmentDrift,
  type BenchmarkEnvironment,
  type BenchmarkExpectedEnvironment,
} from './environment.js'
import { generateGraph, type GenerateGraphOptions, type GenerateGraphResult } from '../generate.js'

export type BenchmarkSuiteMode = 'cold' | 'warm' | 'all'
export type BenchmarkSuiteEntryStatus = 'ready' | 'planned'

export interface BenchmarkSuiteRepo {
  id: string
  name: string
  path: string
  description: string
  size: 'small' | 'mid' | 'large'
  language: string
  shape: string
  status: BenchmarkSuiteEntryStatus
  supportsSpi: boolean
}

export interface BenchmarkSuiteTask {
  id: string
  name: string
  description: string
  status: BenchmarkSuiteEntryStatus
  prompts: Record<string, string>
}

export interface BenchmarkSuiteRunOptions {
  repo: string | null
  task: string | null
  mode: BenchmarkSuiteMode
  trials: number
  outputDir: string
  execTemplate: string
  dryRun: boolean
  yes: boolean
}

interface BenchmarkSuiteMetricStats {
  median: number
  min: number
  max: number
  n: number
}

interface BenchmarkSuiteArmMetricsSummary {
  input_tokens: BenchmarkSuiteMetricStats | null
  total_tool_calls: BenchmarkSuiteMetricStats | null
  read_calls: BenchmarkSuiteMetricStats | null
  glob_grep_calls: BenchmarkSuiteMetricStats | null
  wall_clock_ms: BenchmarkSuiteMetricStats | null
  cost_usd: BenchmarkSuiteMetricStats | null
}

interface BenchmarkSuiteCellPlan {
  repo: BenchmarkSuiteRepo
  task: BenchmarkSuiteTask
  mode: 'cold' | 'warm'
  prompt: string | null
  status: 'ready' | 'planned'
  reason: string | null
}

export interface BenchmarkSuiteSummaryCell {
  repoId: string
  repoName: string
  taskId: string
  taskName: string
  mode: 'cold' | 'warm'
  prompt: string | null
  status: 'completed' | 'partial' | 'planned' | 'env_mismatch'
  reason: string | null
  isolation: boolean | null
  baseline: BenchmarkSuiteArmMetricsSummary
  madar: BenchmarkSuiteArmMetricsSummary
  spi_madar: BenchmarkSuiteArmMetricsSummary | null
  artifacts: {
    legacy_share_safe_reports: string[]
    spi_share_safe_reports: string[]
  }
}

export interface BenchmarkSuiteSummary {
  schema_version: 1
  started_at: string
  completed_at: string
  output_root: string
  filters: {
    repo: string | null
    task: string | null
    mode: BenchmarkSuiteMode
    trials: number
  }
  cells_skipped_for_env_drift: number
  cells: BenchmarkSuiteSummaryCell[]
}

export interface BenchmarkSuiteRunResult {
  text: string
  outputRoot?: string
  summaryPath?: string
  summaryJsonPath?: string
  summary?: BenchmarkSuiteSummary
}

export interface BenchmarkSuiteDependencies {
  repos?: BenchmarkSuiteRepo[]
  tasks?: BenchmarkSuiteTask[]
  now?: () => Date
  generateGraph?: (rootPath?: string, options?: GenerateGraphOptions) => GenerateGraphResult
  captureBenchmarkEnvironment?: (
    options: { projectRoot: string },
  ) => Promise<BenchmarkEnvironment>
  executeNativeAgentCompare?: (
    input: Parameters<typeof executeNativeAgentCompare>[0],
  ) => Promise<NativeAgentCompareResult>
  expectedEnvironment?: BenchmarkExpectedEnvironment | null
}

const DEFAULT_REPOS_PATH = resolve('docs/benchmarks/suite/repos.json')
const DEFAULT_TASKS_PATH = resolve('docs/benchmarks/suite/tasks.json')
const DEFAULT_EXPECTED_ENVIRONMENT_PATH = resolve('docs/benchmarks/suite/isolation/environment.json')

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

export function loadBenchmarkSuiteRepos(path = DEFAULT_REPOS_PATH): BenchmarkSuiteRepo[] {
  const parsed = readJsonFile(path)
  if (!Array.isArray(parsed)) {
    throw new Error(`Benchmark suite repo manifest must be an array: ${path}`)
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Benchmark suite repo manifest entry ${index + 1} must be an object`)
    }
    const repo = entry as Record<string, unknown>
    if (typeof repo.id !== 'string' || repo.id.trim().length === 0) {
      throw new Error(`Benchmark suite repo manifest entry ${index + 1} is missing id`)
    }
    validateSuiteId(repo.id, 'repo')
    if (typeof repo.name !== 'string' || repo.name.trim().length === 0) {
      throw new Error(`Benchmark suite repo ${repo.id} is missing name`)
    }
    if (typeof repo.path !== 'string' || repo.path.trim().length === 0) {
      throw new Error(`Benchmark suite repo ${repo.id} is missing path`)
    }
    if (repo.status !== 'ready' && repo.status !== 'planned') {
      throw new Error(`Benchmark suite repo ${repo.id} status must be "ready" or "planned"`)
    }
    if (typeof repo.supportsSpi !== 'boolean') {
      throw new Error(`Benchmark suite repo ${repo.id} is missing supportsSpi`)
    }

    return {
      id: repo.id,
      name: repo.name,
      path: resolve(String(repo.path)),
      description: typeof repo.description === 'string' ? repo.description : '',
      size: repo.size === 'small' || repo.size === 'mid' || repo.size === 'large' ? repo.size : 'mid',
      language: typeof repo.language === 'string' ? repo.language : 'unknown',
      shape: typeof repo.shape === 'string' ? repo.shape : 'unknown',
      status: repo.status,
      supportsSpi: repo.supportsSpi,
    }
  })
}

export function loadBenchmarkSuiteTasks(path = DEFAULT_TASKS_PATH): BenchmarkSuiteTask[] {
  const parsed = readJsonFile(path)
  if (!Array.isArray(parsed)) {
    throw new Error(`Benchmark suite task manifest must be an array: ${path}`)
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Benchmark suite task manifest entry ${index + 1} must be an object`)
    }
    const task = entry as Record<string, unknown>
    if (typeof task.id !== 'string' || task.id.trim().length === 0) {
      throw new Error(`Benchmark suite task manifest entry ${index + 1} is missing id`)
    }
    validateSuiteId(task.id, 'task')
    if (typeof task.name !== 'string' || task.name.trim().length === 0) {
      throw new Error(`Benchmark suite task ${task.id} is missing name`)
    }
    if (task.status !== 'ready' && task.status !== 'planned') {
      throw new Error(`Benchmark suite task ${task.id} status must be "ready" or "planned"`)
    }
    const prompts = task.prompts
    if (!prompts || typeof prompts !== 'object' || Array.isArray(prompts)) {
      throw new Error(`Benchmark suite task ${task.id} prompts must be an object`)
    }
    return {
      id: task.id,
      name: task.name,
      description: typeof task.description === 'string' ? task.description : '',
      status: task.status,
      prompts: Object.fromEntries(
        Object.entries(prompts as Record<string, unknown>)
          .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
          .map(([repoId, value]) => [repoId, String(value)]),
      ),
    }
  })
}

function timestampDirectoryName(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/:/g, '-')
}

function validateSuiteId(id: string, kind: string): void {
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error(`Benchmark suite ${kind} id contains unsafe path characters: ${id}`)
  }
}

function createSuiteOutputRoot(outputDir: string, now: Date): string {
  mkdirSync(outputDir, { recursive: true })
  const timestamp = timestampDirectoryName(now)
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidate = join(outputDir, suffix === 0 ? timestamp : `${timestamp}-${String(suffix).padStart(3, '0')}`)
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
  throw new Error(`Unable to create a unique benchmark suite directory inside ${outputDir}`)
}

function suiteModes(mode: BenchmarkSuiteMode): Array<'cold' | 'warm'> {
  return mode === 'all' ? ['cold', 'warm'] : [mode]
}

function selectById<T extends { id: string }>(entries: readonly T[], kind: string, id: string | null): T[] {
  if (id === null) {
    return [...entries]
  }
  const match = entries.find((entry) => entry.id === id)
  if (!match) {
    throw new Error(`Unknown ${kind} id: ${id}`)
  }
  return [match]
}

function planCell(repo: BenchmarkSuiteRepo, task: BenchmarkSuiteTask, mode: 'cold' | 'warm'): BenchmarkSuiteCellPlan {
  const prompt = task.prompts[repo.id] ?? null
  if (repo.status !== 'ready') {
    return { repo, task, mode, prompt, status: 'planned', reason: 'repo not wired yet' }
  }
  if (task.status !== 'ready') {
    return { repo, task, mode, prompt, status: 'planned', reason: 'task not wired yet' }
  }
  if (prompt === null) {
    return { repo, task, mode, prompt: null, status: 'planned', reason: 'prompt not defined for repo' }
  }
  return { repo, task, mode, prompt, status: 'ready', reason: null }
}

function portablePath(path: string): string {
  return relative(process.cwd(), path) || '.'
}

function filterWorkspaceCopy(sourceRoot: string, sourcePath: string): boolean {
  const relativePath = relative(sourceRoot, sourcePath)
  return (
    relativePath !== 'out'
    && !relativePath.startsWith(`out${sep}`)
    && relativePath !== '.git'
    && !relativePath.startsWith(`.git${sep}`)
  )
}

function copyWorkspace(sourceRoot: string, targetRoot: string): void {
  mkdirSync(dirname(targetRoot), { recursive: true })
  cpSync(sourceRoot, targetRoot, {
    recursive: true,
    filter: (sourcePath) => filterWorkspaceCopy(sourceRoot, sourcePath),
  })
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

function execTemplateForWorkspace(execTemplate: string, workspaceRoot: string): string {
  if (process.platform === 'win32') {
    return `Set-Location -LiteralPath ${shellQuote(workspaceRoot)}; ${execTemplate}`
  }
  return `cd ${shellQuote(workspaceRoot)} && ${execTemplate}`
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

function summarizeValues(values: number[]): BenchmarkSuiteMetricStats | null {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((left, right) => left - right)
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  const medianValue = median(sorted)
  if (min === undefined || max === undefined || medianValue === null) {
    return null
  }
  return {
    median: medianValue,
    min,
    max,
    n: values.length,
  }
}

function baselineMetric(report: NativeAgentCompareReport, selector: (report: NativeAgentCompareReport) => number | null): number | null {
  if (report.baseline.kind !== 'succeeded') {
    return null
  }
  return selector(report)
}

function madarMetric(report: NativeAgentCompareReport, selector: (report: NativeAgentCompareReport) => number | null): number | null {
  if (report.madar.kind !== 'succeeded') {
    return null
  }
  return selector(report)
}

function collectNumbers<T>(reports: readonly T[], selector: (report: T) => number | null): number[] {
  return reports.flatMap((report) => {
    const value = selector(report)
    return typeof value === 'number' && Number.isFinite(value) ? [value] : []
  })
}

function summarizeArmMetrics(
  reports: readonly NativeAgentCompareReport[],
  arm: 'baseline' | 'madar',
): BenchmarkSuiteArmMetricsSummary {
  const select = arm === 'baseline' ? baselineMetric : madarMetric
  return {
    input_tokens: summarizeValues(collectNumbers(reports, (report) => select(report, (candidate) => candidate[arm].kind === 'succeeded' ? candidate[arm].total_input_tokens_anthropic_exact : null))),
    total_tool_calls: summarizeValues(collectNumbers(reports, (report) => report.tool_call_counts ? report.tool_call_counts[arm].total : null)),
    read_calls: summarizeValues(collectNumbers(reports, (report) => report.tool_call_counts ? report.tool_call_counts[arm].Read : null)),
    glob_grep_calls: summarizeValues(collectNumbers(reports, (report) => report.tool_call_counts ? report.tool_call_counts[arm].Glob + report.tool_call_counts[arm].Grep : null)),
    wall_clock_ms: summarizeValues(collectNumbers(reports, (report) => select(report, (candidate) => candidate[arm].kind === 'succeeded' ? candidate[arm].duration_ms : null))),
    cost_usd: summarizeValues(collectNumbers(reports, (report) => select(report, (candidate) => candidate[arm].kind === 'succeeded' ? candidate[arm].total_cost_usd : null))),
  }
}

function isCompletedArm(summary: BenchmarkSuiteArmMetricsSummary): boolean {
  return summary.input_tokens !== null
}

function summarizeCellStatus(
  baseline: BenchmarkSuiteArmMetricsSummary,
  madar: BenchmarkSuiteArmMetricsSummary,
  spiMadar: BenchmarkSuiteArmMetricsSummary | null,
  planned: boolean,
): BenchmarkSuiteSummaryCell['status'] {
  if (planned) {
    return 'planned'
  }
  const baselineDone = isCompletedArm(baseline)
  const madarDone = isCompletedArm(madar)
  const spiDone = spiMadar === null || isCompletedArm(spiMadar)
  if (baselineDone && madarDone && spiDone) {
    return 'completed'
  }
  return 'partial'
}

function formatMetric(stats: BenchmarkSuiteMetricStats | null, digits = 0): string {
  if (stats === null) {
    return '—'
  }
  const formatter = (value: number) => digits === 0 ? Math.round(value).toString() : value.toFixed(digits)
  return `${formatter(stats.median)} (${formatter(stats.min)}-${formatter(stats.max)}, n=${stats.n})`
}

function formatCellRow(cell: BenchmarkSuiteSummaryCell): string {
  return [
    cell.repoId,
    cell.status,
    cell.isolation === null ? '—' : String(cell.isolation),
    formatMetric(cell.baseline.input_tokens),
    formatMetric(cell.madar.input_tokens),
    formatMetric(cell.spi_madar?.input_tokens ?? null),
    formatMetric(cell.baseline.total_tool_calls),
    formatMetric(cell.madar.total_tool_calls),
    formatMetric(cell.spi_madar?.total_tool_calls ?? null),
    formatMetric(cell.baseline.read_calls),
    formatMetric(cell.madar.read_calls),
    formatMetric(cell.spi_madar?.read_calls ?? null),
    formatMetric(cell.baseline.glob_grep_calls),
    formatMetric(cell.madar.glob_grep_calls),
    formatMetric(cell.spi_madar?.glob_grep_calls ?? null),
    formatMetric(cell.baseline.wall_clock_ms),
    formatMetric(cell.madar.wall_clock_ms),
    formatMetric(cell.spi_madar?.wall_clock_ms ?? null),
    formatMetric(cell.baseline.cost_usd, 2),
    formatMetric(cell.madar.cost_usd, 2),
    formatMetric(cell.spi_madar?.cost_usd ?? null, 2),
  ].join(' | ')
}

function formatBenchmarkSuiteSummaryMarkdown(summary: BenchmarkSuiteSummary): string {
  const lines = [
    '# Benchmark suite summary',
    '',
    `- Generated: ${summary.completed_at}`,
    `- Filters: repo=${summary.filters.repo ?? 'all'}, task=${summary.filters.task ?? 'all'}, mode=${summary.filters.mode}, trials=${summary.filters.trials}`,
    `- Cells skipped for env drift: ${summary.cells_skipped_for_env_drift}`,
    '- Per-repo rows only.',
    '',
  ]

  const taskIds = [...new Set(summary.cells.map((cell) => cell.taskId))]
  for (const taskId of taskIds) {
    const taskCells = summary.cells.filter((cell) => cell.taskId === taskId)
    if (taskCells.length === 0) {
      continue
    }
    lines.push(`## ${taskId}`)
    lines.push('')
    for (const mode of ['cold', 'warm'] as const) {
      const modeCells = taskCells.filter((cell) => cell.mode === mode)
      if (modeCells.length === 0) {
        continue
      }
      lines.push(`### ${mode === 'cold' ? 'Cold cache' : 'Warm cache'}`)
      lines.push('')
      lines.push('| Repo | Status | Isolation | Baseline input tokens | Madar input tokens | SPI Madar input tokens | Baseline tool calls | Madar tool calls | SPI Madar tool calls | Baseline Read | Madar Read | SPI Madar Read | Baseline Glob/Grep | Madar Glob/Grep | SPI Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | SPI Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | SPI Madar cost (USD) |')
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
      for (const cell of modeCells) {
        lines.push(`| ${formatCellRow(cell)} |`)
      }
      lines.push('')
    }
  }

  return `${lines.join('\n').trimEnd()}\n`
}

function writeSummary(outputRoot: string, summary: BenchmarkSuiteSummary): { summaryPath: string; summaryJsonPath: string } {
  const summaryJsonPath = join(outputRoot, 'summary.json')
  const summaryPath = join(outputRoot, 'summary.md')
  writeFileSync(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeFileSync(summaryPath, formatBenchmarkSuiteSummaryMarkdown(summary), 'utf8')
  return { summaryPath, summaryJsonPath }
}

function dryRunText(plans: readonly BenchmarkSuiteCellPlan[]): string {
  if (plans.length === 0) {
    return 'No suite cells matched the selected filters.'
  }
  return plans.map((plan) => `[${plan.status}] ${plan.repo.id} / ${plan.task.id} / ${plan.mode}-cache`).join('\n')
}

async function maybePrimeWarmCache(
  mode: 'cold' | 'warm',
  compare: NonNullable<BenchmarkSuiteDependencies['executeNativeAgentCompare']>,
  input: Parameters<NonNullable<BenchmarkSuiteDependencies['executeNativeAgentCompare']>>[0],
): Promise<void> {
  if (mode !== 'warm') {
    return
  }
  await compare({
    ...input,
    outputDir: join(input.outputDir, '..', '_warmup'),
  })
}

function stringifyArtifacts(paths: string[]): string[] {
  return paths.map((path) => portablePath(path))
}

function loadExpectedEnvironment(path = DEFAULT_EXPECTED_ENVIRONMENT_PATH): BenchmarkExpectedEnvironment | null {
  if (!existsSync(path)) {
    return null
  }
  return readJsonFile(path) as BenchmarkExpectedEnvironment
}

function summarizeIsolation(reports: readonly NativeAgentCompareReport[]): boolean | null {
  if (reports.length === 0) {
    return null
  }
  return reports.every((report) => report.isolation)
}

function copyReportArtifacts(
  report: NativeAgentCompareReport,
  destinationParent: string,
): string {
  const copiedRoot = join(destinationParent, basename(report.paths.output_dir))
  mkdirSync(dirname(copiedRoot), { recursive: true })
  cpSync(report.paths.output_dir, copiedRoot, { recursive: true })
  const copiedShareSafeReport = join(copiedRoot, 'report.share-safe.json')
  if (!existsSync(copiedShareSafeReport)) {
    throw new Error(`Missing share-safe report in copied benchmark artifacts: ${copiedShareSafeReport}`)
  }
  writeFileSync(join(copiedRoot, 'report.json'), readFileSync(copiedShareSafeReport, 'utf8'), 'utf8')
  return copiedShareSafeReport
}

export async function runBenchmarkSuite(
  options: BenchmarkSuiteRunOptions,
  dependencies: BenchmarkSuiteDependencies = {},
): Promise<BenchmarkSuiteRunResult> {
  const repos = dependencies.repos ?? loadBenchmarkSuiteRepos()
  const tasks = dependencies.tasks ?? loadBenchmarkSuiteTasks()
  const now = dependencies.now ?? (() => new Date())
  const runGenerateGraph = dependencies.generateGraph ?? generateGraph
  const getBenchmarkEnvironment = dependencies.captureBenchmarkEnvironment ?? captureBenchmarkEnvironment
  const runCompare = dependencies.executeNativeAgentCompare ?? executeNativeAgentCompare
  const isolation = benchmarkIsolationEnabled()
  const expectedEnvironment = isolation
    ? (dependencies.expectedEnvironment === undefined ? loadExpectedEnvironment() : dependencies.expectedEnvironment)
    : null

  const selectedRepos = selectById(repos, 'repo', options.repo)
  const selectedTasks = selectById(tasks, 'task', options.task)
  const plans = selectedRepos.flatMap((repo) => selectedTasks.flatMap((task) => suiteModes(options.mode).map((mode) => planCell(repo, task, mode))))

  if (options.dryRun) {
    return { text: dryRunText(plans) }
  }

  const startedAt = now()
  const outputRoot = createSuiteOutputRoot(resolve(options.outputDir), startedAt)
  const readyPlans = plans.filter((plan) => plan.status === 'ready')
  const preparedRepos = new Map<string, { legacyGraphPath: string; spiGraphPath: string | null }>()
  const scratchRoots: string[] = []
  const stagingRoot = resolve('out/benchmark-suite-staging', timestampDirectoryName(startedAt))
  const summaryCells: BenchmarkSuiteSummaryCell[] = []

  try {
    mkdirSync(stagingRoot, { recursive: true })

    for (const repo of [...new Set(readyPlans.map((plan) => plan.repo))]) {
      const scratchRoot = mkdtempSync(join(tmpdir(), `madar-bench-suite-${repo.id}-`))
      scratchRoots.push(scratchRoot)

      const legacyWorkspace = join(scratchRoot, 'legacy')
      copyWorkspace(repo.path, legacyWorkspace)
      const legacyResult = runGenerateGraph(legacyWorkspace, { noHtml: true })

      let spiGraphPath: string | null = null
      if (repo.supportsSpi) {
        const spiWorkspace = join(scratchRoot, 'spi')
        copyWorkspace(repo.path, spiWorkspace)
        spiGraphPath = runGenerateGraph(spiWorkspace, { noHtml: true, useSpi: true }).graphPath
      }

      preparedRepos.set(repo.id, {
        legacyGraphPath: legacyResult.graphPath,
        spiGraphPath,
      })
    }

    for (const plan of plans) {
      if (plan.status !== 'ready' || plan.prompt === null) {
        summaryCells.push({
          repoId: plan.repo.id,
          repoName: plan.repo.name,
          taskId: plan.task.id,
          taskName: plan.task.name,
          mode: plan.mode,
          prompt: plan.prompt,
          status: 'planned',
          reason: plan.reason,
          isolation: null,
          baseline: summarizeArmMetrics([], 'baseline'),
          madar: summarizeArmMetrics([], 'madar'),
          spi_madar: plan.repo.supportsSpi ? summarizeArmMetrics([], 'madar') : null,
          artifacts: {
            legacy_share_safe_reports: [],
            spi_share_safe_reports: [],
          },
        })
        continue
      }

      const prepared = preparedRepos.get(plan.repo.id)
      if (!prepared) {
        throw new Error(`Missing prepared repo for ${plan.repo.id}`)
      }

      if (isolation && expectedEnvironment !== null) {
        const workspaceRoot = dirname(dirname(prepared.legacyGraphPath))
        const liveEnvironment = await getBenchmarkEnvironment({ projectRoot: workspaceRoot })
        const driftReasons = findEnvironmentDrift(expectedEnvironment, liveEnvironment, { isolation })
        if (driftReasons.length > 0) {
          summaryCells.push({
            repoId: plan.repo.id,
            repoName: plan.repo.name,
            taskId: plan.task.id,
            taskName: plan.task.name,
            mode: plan.mode,
            prompt: plan.prompt,
            status: 'env_mismatch',
            reason: driftReasons.join('; '),
            isolation,
            baseline: summarizeArmMetrics([], 'baseline'),
            madar: summarizeArmMetrics([], 'madar'),
            spi_madar: plan.repo.supportsSpi ? summarizeArmMetrics([], 'madar') : null,
            artifacts: {
              legacy_share_safe_reports: [],
              spi_share_safe_reports: [],
            },
          })
          continue
        }
      }

      const legacyReports: NativeAgentCompareReport[] = []
      const spiReports: NativeAgentCompareReport[] = []
      const copiedLegacyArtifacts: string[] = []
      const copiedSpiArtifacts: string[] = []

      for (let trial = 1; trial <= options.trials; trial += 1) {
        const trialLabel = `trial-${String(trial).padStart(3, '0')}`
        const legacyInput = {
          graphPath: prepared.legacyGraphPath,
          question: plan.prompt,
          outputDir: join(stagingRoot, plan.repo.id, plan.task.id, `${plan.mode}-cache`, 'legacy', trialLabel),
          execTemplate: execTemplateForWorkspace(options.execTemplate, dirname(dirname(prepared.legacyGraphPath))),
          baselineMode: 'native_agent' as const,
        }
        await maybePrimeWarmCache(plan.mode, runCompare, legacyInput)
        const legacyResult = await runCompare(legacyInput)
        const legacyReport = legacyResult.reports[0]
        if (legacyReport) {
          legacyReports.push(legacyReport)
          copiedLegacyArtifacts.push(copyReportArtifacts(
            legacyReport,
            join(outputRoot, 'raw', plan.repo.id, plan.task.id, `${plan.mode}-cache`, 'legacy', trialLabel),
          ))
        }

        if (prepared.spiGraphPath) {
          const spiInput = {
            graphPath: prepared.spiGraphPath,
            question: plan.prompt,
            outputDir: join(stagingRoot, plan.repo.id, plan.task.id, `${plan.mode}-cache`, 'spi', trialLabel),
            execTemplate: execTemplateForWorkspace(options.execTemplate, dirname(dirname(prepared.spiGraphPath))),
            baselineMode: 'native_agent' as const,
          }
          await maybePrimeWarmCache(plan.mode, runCompare, spiInput)
          const spiResult = await runCompare(spiInput)
          const spiReport = spiResult.reports[0]
          if (spiReport) {
            spiReports.push(spiReport)
            copiedSpiArtifacts.push(copyReportArtifacts(
              spiReport,
              join(outputRoot, 'raw', plan.repo.id, plan.task.id, `${plan.mode}-cache`, 'spi', trialLabel),
            ))
          }
        }
      }

      const baseline = summarizeArmMetrics(legacyReports, 'baseline')
      const madar = summarizeArmMetrics(legacyReports, 'madar')
      const spiMadar = prepared.spiGraphPath ? summarizeArmMetrics(spiReports, 'madar') : null
      const cellIsolation = summarizeIsolation([...legacyReports, ...spiReports])
      summaryCells.push({
        repoId: plan.repo.id,
        repoName: plan.repo.name,
        taskId: plan.task.id,
        taskName: plan.task.name,
        mode: plan.mode,
        prompt: plan.prompt,
        status: summarizeCellStatus(baseline, madar, spiMadar, false),
        reason: null,
        isolation: cellIsolation,
        baseline,
        madar,
        spi_madar: spiMadar,
        artifacts: {
          legacy_share_safe_reports: stringifyArtifacts(copiedLegacyArtifacts),
          spi_share_safe_reports: stringifyArtifacts(copiedSpiArtifacts),
        },
      })
    }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
    for (const scratchRoot of scratchRoots) {
      rmSync(scratchRoot, { recursive: true, force: true })
    }
  }

  const completedAt = now()
  const summary: BenchmarkSuiteSummary = {
    schema_version: 1,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    output_root: portablePath(outputRoot),
    filters: {
      repo: options.repo,
      task: options.task,
      mode: options.mode,
      trials: options.trials,
    },
    cells_skipped_for_env_drift: summaryCells.filter((cell) => cell.status === 'env_mismatch').length,
    cells: summaryCells,
  }
  const { summaryPath, summaryJsonPath } = writeSummary(outputRoot, summary)
  const runnableCount = summaryCells.filter((cell) => cell.status !== 'planned' && cell.status !== 'env_mismatch').length
  const envMismatchCount = summaryCells.filter((cell) => cell.status === 'env_mismatch').length
  const plannedCount = summaryCells.filter((cell) => cell.status === 'planned').length

  return {
    text: [
      `Wrote benchmark suite results to ${portablePath(outputRoot)}`,
      `Summary: ${portablePath(summaryPath)}`,
      `JSON: ${portablePath(summaryJsonPath)}`,
      `Cells: ${runnableCount} measured · ${envMismatchCount} env mismatch · ${plannedCount} planned`,
    ].join('\n'),
    outputRoot,
    summaryPath,
    summaryJsonPath,
    summary,
  }
}
