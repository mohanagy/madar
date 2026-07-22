import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

import type { ContextPackTaskKind } from '../../contracts/context-pack.js'
import {
  executeNativeAgentCompare,
  inspectClaudeNativeAgentInstall,
  type NativeAgentCompareReport,
  type NativeAgentCompareResult,
  type NativeAgentWorkflowOutcome,
} from '../compare.js'
import { claudeInstall } from '../install.js'
import { copyWorkspaceForBenchmark } from '../../shared/workspace-copy.js'
import {
  benchmarkIsolationEnabled,
  captureBenchmarkEnvironment,
  findEnvironmentDrift,
  type BenchmarkEnvironment,
  type BenchmarkExpectedEnvironment,
} from './environment.js'
import { generateGraph, type GenerateGraphOptions, type GenerateGraphResult } from '../generate.js'
import { shellEscape } from '../../shared/shell.js'
import { findPackageRoot } from '../../shared/package-metadata.js'
import { validateGraphOutputPath } from '../../shared/security.js'

export type BenchmarkSuiteMode = 'cold' | 'warm' | 'all'
export type BenchmarkSuiteEntryStatus = 'ready' | 'planned'

export interface BenchmarkSuiteRepoPathSource {
  kind: 'path'
  path: string
}

export interface BenchmarkSuiteRepoGitSource {
  kind: 'git'
  url: string
  ref?: string
}

export type BenchmarkSuiteRepoSource = BenchmarkSuiteRepoPathSource | BenchmarkSuiteRepoGitSource

export interface BenchmarkSuiteRepo {
  id: string
  name: string
  path?: string
  source?: BenchmarkSuiteRepoSource
  graphRoot?: string
  description: string
  size: 'small' | 'mid' | 'large'
  language: string
  shape: string
  status: BenchmarkSuiteEntryStatus
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
  reposManifestPath?: string | null
  tasksManifestPath?: string | null
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

interface BenchmarkSuitePassFailSummary {
  passed: number
  failed: number
  n: number
}

interface BenchmarkSuiteYesNoSummary {
  yes: number
  no: number
  n: number
}

interface BenchmarkSuiteWorkflowOutcomeSummary {
  wrong_file_edits: BenchmarkSuiteMetricStats | null
  validation_passed: BenchmarkSuitePassFailSummary | null
  review_time_seconds: BenchmarkSuiteMetricStats | null
  rework_loops: BenchmarkSuiteMetricStats | null
  human_intervention_required: BenchmarkSuiteYesNoSummary | null
  evidence: string[]
}

interface BenchmarkSuiteBenchmarkOutcomeCounts {
  full_win: number
  partial_win: number
  regression: number
  not_measured: number
}

interface BenchmarkSuiteBenchmarkOutcomeSummary {
  counts: BenchmarkSuiteBenchmarkOutcomeCounts
  evidence: string[]
}

interface BenchmarkSuiteCellPlan {
  repo: BenchmarkSuiteRepo
  task: BenchmarkSuiteTask
  mode: 'cold' | 'warm'
  prompt: string | null
  status: 'ready' | 'planned'
  reason: string | null
}

interface PreparedBenchmarkRepo {
  sourceRoot: string
  graphPath: string
}

export interface BenchmarkSuiteSummaryCell {
  repoId: string
  repoName: string
  taskId: string
  taskName: string
  mode: 'cold' | 'warm'
  prompt: string | null
  status: 'completed' | 'partial' | 'planned' | 'skipped' | 'env_mismatch'
  reason: string | null
  isolation: boolean | null
  baseline: BenchmarkSuiteArmMetricsSummary
  madar: BenchmarkSuiteArmMetricsSummary
  benchmark_outcomes: BenchmarkSuiteBenchmarkOutcomeSummary | null
  workflow_outcomes: BenchmarkSuiteWorkflowOutcomeSummary | null
  artifacts: {
    share_safe_reports: string[]
  }
}

export interface BenchmarkSuiteSummary {
  schema_version: 2
  started_at: string
  completed_at: string
  output_root: string
  runtime_artifact: {
    source: string
    package_version: string | null
    tarball_name: string | null
    tarball_sha256: string | null
  }
  filters: {
    repo: string | null
    task: string | null
    repos_manifest: string | null
    tasks_manifest: string | null
    mode: BenchmarkSuiteMode
    trials: number
  }
  cells_skipped_for_install: number
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
  tasksPath?: string
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function normalizeBenchmarkSuiteGitSource(
  source: BenchmarkSuiteRepoGitSource,
  repoId: string,
): BenchmarkSuiteRepoGitSource {
  if (typeof source.url !== 'string' || source.url.trim().length === 0) {
    throw new Error(`Benchmark suite repo ${repoId} source.url is missing`)
  }
  const url = source.url.trim()
  const ref = typeof source.ref === 'string' && source.ref.trim().length > 0 ? source.ref.trim() : undefined
  return ref ? { kind: 'git', url, ref } : { kind: 'git', url }
}

function normalizeBenchmarkSuiteGraphRoot(graphRoot: string | undefined, repoId: string): string | undefined {
  const trimmed = graphRoot?.trim()
  if (!trimmed || trimmed === '.') {
    return undefined
  }
  if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new Error(`Benchmark suite repo ${repoId} graphRoot must be relative`)
  }
  const segments = trimmed.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`Benchmark suite repo ${repoId} graphRoot contains unsafe path segments`)
  }
  return segments.join('/')
}

function normalizeBenchmarkSuiteRepo(repo: BenchmarkSuiteRepo): BenchmarkSuiteRepo {
  const graphRoot = normalizeBenchmarkSuiteGraphRoot(repo.graphRoot, repo.id)
  const { graphRoot: _ignoredGraphRoot, ...repoWithoutGraphRoot } = repo
  if (repo.source?.kind === 'path') {
    const sourcePath = resolve(repo.source.path)
    return {
      ...repoWithoutGraphRoot,
      ...(graphRoot ? { graphRoot } : {}),
      path: sourcePath,
      source: {
        kind: 'path',
        path: sourcePath,
      },
    }
  }

  if (repo.source?.kind === 'git') {
    const { path: _ignoredPath, ...rest } = repoWithoutGraphRoot
    return {
      ...rest,
      ...(graphRoot ? { graphRoot } : {}),
      source: normalizeBenchmarkSuiteGitSource(repo.source, repo.id),
    }
  }

  if (typeof repo.path === 'string' && repo.path.trim().length > 0) {
    const sourcePath = resolve(repo.path)
    return {
      ...repoWithoutGraphRoot,
      ...(graphRoot ? { graphRoot } : {}),
      path: sourcePath,
      source: {
        kind: 'path',
        path: sourcePath,
      },
    }
  }

  throw new Error(`Benchmark suite repo ${repo.id} is missing path`)
}

function parseBenchmarkSuiteRepoSource(
  repo: Record<string, unknown>,
  repoId: string,
): BenchmarkSuiteRepoSource | undefined {
  if (!isRecord(repo.source)) {
    return undefined
  }

  if (repo.source.kind === 'path') {
    if (!hasOnlyKeys(repo.source, ['kind', 'path'])) {
      throw new Error(`Benchmark suite repo ${repoId} path source contains unsupported fields`)
    }
    if (typeof repo.source.path !== 'string' || repo.source.path.trim().length === 0) {
      throw new Error(`Benchmark suite repo ${repoId} source.path is missing`)
    }
    return {
      kind: 'path',
      path: repo.source.path,
    }
  }

  if (repo.source.kind === 'git') {
    if (!hasOnlyKeys(repo.source, ['kind', 'url', 'ref'])) {
      throw new Error(`Benchmark suite repo ${repoId} git source contains unsupported fields`)
    }
    if (typeof repo.source.url !== 'string' || repo.source.url.trim().length === 0) {
      throw new Error(`Benchmark suite repo ${repoId} source.url is missing`)
    }
    return {
      kind: 'git',
      url: repo.source.url,
      ...(typeof repo.source.ref === 'string' && repo.source.ref.trim().length > 0
        ? { ref: repo.source.ref }
        : {}),
    }
  }

  throw new Error(`Benchmark suite repo ${repoId} source.kind must be "path" or "git"`)
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
    if (!hasOnlyKeys(repo, ['id', 'name', 'path', 'source', 'graphRoot', 'description', 'size', 'language', 'shape', 'status'])) {
      throw new Error(`Benchmark suite repo manifest entry ${index + 1} contains unsupported fields`)
    }
    if (typeof repo.id !== 'string' || repo.id.trim().length === 0) {
      throw new Error(`Benchmark suite repo manifest entry ${index + 1} is missing id`)
    }
    validateSuiteId(repo.id, 'repo')
    if (typeof repo.name !== 'string' || repo.name.trim().length === 0) {
      throw new Error(`Benchmark suite repo ${repo.id} is missing name`)
    }
    if (repo.status !== 'ready' && repo.status !== 'planned') {
      throw new Error(`Benchmark suite repo ${repo.id} status must be "ready" or "planned"`)
    }
    const source = parseBenchmarkSuiteRepoSource(repo, String(repo.id))

    return normalizeBenchmarkSuiteRepo({
      id: repo.id,
      name: repo.name,
      ...(typeof repo.path === 'string' && repo.path.trim().length > 0 ? { path: repo.path } : {}),
      ...(source ? { source } : {}),
      ...(typeof repo.graphRoot === 'string' && repo.graphRoot.trim().length > 0 ? { graphRoot: repo.graphRoot } : {}),
      description: typeof repo.description === 'string' ? repo.description : '',
      size: repo.size === 'small' || repo.size === 'mid' || repo.size === 'large' ? repo.size : 'mid',
      language: typeof repo.language === 'string' ? repo.language : 'unknown',
      shape: typeof repo.shape === 'string' ? repo.shape : 'unknown',
      status: repo.status,
    })
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
    if (!hasOnlyKeys(task, ['id', 'name', 'description', 'status', 'prompts'])) {
      throw new Error(`Benchmark suite task manifest entry ${index + 1} contains unsupported fields`)
    }
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

function suiteTaskKind(taskId: string): ContextPackTaskKind | null {
  if (taskId === 'explain-runtime' || taskId === 'explain-auth') {
    return 'explain'
  }
  if (taskId === 'implement') {
    return 'implement'
  }
  if (taskId === 'review') {
    return 'review'
  }
  if (taskId === 'impact') {
    return 'impact'
  }
  return null
}

function portablePath(path: string): string {
  return relative(process.cwd(), path) || '.'
}

function receiptManifestPath(path: string): string {
  const relativeToPackage = relative(findPackageRoot(), resolve(path))
  if (
    relativeToPackage === '..'
    || relativeToPackage.startsWith(`..${sep}`)
    || isAbsolute(relativeToPackage)
  ) {
    return '<external-manifest>'
  }
  return (relativeToPackage || '.').split(sep).join('/')
}

function copyWorkspace(sourceRoot: string, targetRoot: string): void {
  copyWorkspaceForBenchmark(sourceRoot, targetRoot)
}

function cloneBenchmarkSuiteRepo(source: BenchmarkSuiteRepoGitSource, targetRoot: string): void {
  mkdirSync(dirname(targetRoot), { recursive: true })
  if (source.ref && /^[0-9a-f]{7,40}$/i.test(source.ref)) {
    execFileSync('git', ['init', targetRoot], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    execFileSync('git', ['remote', 'add', 'origin', source.url], {
      cwd: targetRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    execFileSync('git', ['fetch', '--depth', '1', 'origin', source.ref], {
      cwd: targetRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    execFileSync('git', ['checkout', '--detach', 'FETCH_HEAD'], {
      cwd: targetRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return
  }
  const args = ['clone', '--depth', '1', '--single-branch']
  if (source.ref) {
    args.push('--branch', source.ref)
  }
  args.push(source.url, targetRoot)
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function materializeBenchmarkRepoSource(repo: BenchmarkSuiteRepo, scratchRoot: string): string {
  const source = repo.source
  if (!source) {
    throw new Error(`Benchmark suite repo ${repo.id} has no source`)
  }
  const sourceRoot = join(scratchRoot, 'source')
  if (source.kind === 'path') {
    copyWorkspace(source.path, sourceRoot)
    return sourceRoot
  }
  cloneBenchmarkSuiteRepo(source, sourceRoot)
  return sourceRoot
}

function resetBenchmarkWorkspaceConfig(workspaceRoot: string): void {
  rmSync(join(workspaceRoot, 'CLAUDE.md'), { force: true })
  rmSync(join(workspaceRoot, '.mcp.json'), { force: true })
  rmSync(join(workspaceRoot, '.claude'), { recursive: true, force: true })
  rmSync(join(workspaceRoot, '.cursor', 'mcp.json'), { force: true })
  rmSync(join(workspaceRoot, '.vscode', 'mcp.json'), { force: true })
  rmSync(join(workspaceRoot, '.opencode', 'plugins'), { recursive: true, force: true })
}

function benchmarkWorkspaceCliPath(): string {
  const override = process.env.MADAR_BENCH_CLI_PATH?.trim()
  const cliPath = override ? resolve(override) : join(findPackageRoot(), 'dist', 'src', 'cli', 'bin.js')
  if (!existsSync(cliPath)) {
    throw new Error(`Benchmark suite requires the built CLI at ${portablePath(cliPath)}. Run npm run build first.`)
  }
  return cliPath
}

function writeBenchmarkWorkspaceCliShim(workspaceRoot: string): string {
  const shimDirectory = join(workspaceRoot, '.claude', 'bin')
  mkdirSync(shimDirectory, { recursive: true })
  const cliPath = benchmarkWorkspaceCliPath()

  if (process.platform === 'win32') {
    const shimPath = join(shimDirectory, 'madar.cmd')
    writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${cliPath}" %*\r\n`, 'utf8')
    return shimDirectory
  }

  const shimPath = join(shimDirectory, 'madar')
  writeFileSync(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" "$@"\n`, 'utf8')
  chmodSync(shimPath, 0o755)
  return shimDirectory
}

function pinBenchmarkWorkspaceClaudeCommandPath(workspaceRoot: string): void {
  const mcpConfigPath = join(workspaceRoot, '.mcp.json')
  const mcpConfig = readJsonFile(mcpConfigPath)
  if (!isRecord(mcpConfig) || !isRecord(mcpConfig.mcpServers) || !isRecord(mcpConfig.mcpServers.madar)) {
    throw new Error(`Benchmark suite could not pin the Claude MCP server inside ${portablePath(workspaceRoot)}: missing .mcp.json madar entry`)
  }

  const server = mcpConfig.mcpServers.madar as Record<string, unknown>
  const env = isRecord(server.env) ? { ...server.env } : {}
  const pathKey = typeof env.PATH === 'string'
    ? 'PATH'
    : typeof env.Path === 'string'
      ? 'Path'
      : process.platform === 'win32'
        ? 'Path'
        : 'PATH'
  const inheritedPath =
    (typeof env[pathKey] === 'string' ? env[pathKey] : null)
    ?? (pathKey === 'Path' ? process.env.Path : process.env.PATH)
    ?? process.env.PATH
    ?? process.env.Path
    ?? ''
  const shimDirectory = writeBenchmarkWorkspaceCliShim(workspaceRoot)
  server.env = {
    ...env,
    [pathKey]: [shimDirectory, inheritedPath].filter((entry) => typeof entry === 'string' && entry.length > 0).join(delimiter),
  }
  writeFileSync(mcpConfigPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, 'utf8')
}

function ensureBenchmarkWorkspaceInstall(workspaceRoot: string): void {
  resetBenchmarkWorkspaceConfig(workspaceRoot)
  claudeInstall(workspaceRoot)
  pinBenchmarkWorkspaceClaudeCommandPath(workspaceRoot)
  const installCheck = inspectClaudeNativeAgentInstall(workspaceRoot)
  if (installCheck.verified) {
    return
  }
  throw new Error(
    [
      `Benchmark suite could not provision a Madar install inside ${portablePath(workspaceRoot)}:`,
      ...installCheck.artifacts
        .filter((artifact) => !artifact.ok)
        .map((artifact) => `  x ${artifact.detail}`),
    ].join('\n'),
  )
}

function execTemplateForWorkspace(execTemplate: string, workspaceRoot: string): string {
  if (process.platform === 'win32') {
    return `cd /d ${shellEscape(workspaceRoot, process.platform)} && ${execTemplate}`
  }
  return `cd ${shellEscape(workspaceRoot, process.platform)} && ${execTemplate}`
}

function prepareBenchmarkWorkspace(
  sourceRoot: string,
  runGenerateGraph: (rootPath?: string, options?: GenerateGraphOptions) => GenerateGraphResult,
  scratchRoot: string,
  graphRoot?: string,
): string {
  const workspaceRoot = join(scratchRoot, 'canonical')
  copyWorkspace(sourceRoot, workspaceRoot)
  const graphWorkspaceRoot = graphRoot ? resolve(workspaceRoot, graphRoot) : workspaceRoot
  if (!existsSync(graphWorkspaceRoot)) {
    throw new Error(`Benchmark suite graphRoot does not exist: ${portablePath(graphWorkspaceRoot)}`)
  }
  if (graphWorkspaceRoot !== workspaceRoot) {
    resetBenchmarkWorkspaceConfig(workspaceRoot)
  }
  ensureBenchmarkWorkspaceInstall(graphWorkspaceRoot)
  return runGenerateGraph(graphWorkspaceRoot, {}).graphPath
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

function summarizePassFail(values: boolean[]): BenchmarkSuitePassFailSummary | null {
  if (values.length === 0) {
    return null
  }
  const passed = values.filter(Boolean).length
  return {
    passed,
    failed: values.length - passed,
    n: values.length,
  }
}

function summarizeYesNo(values: boolean[]): BenchmarkSuiteYesNoSummary | null {
  if (values.length === 0) {
    return null
  }
  const yes = values.filter(Boolean).length
  return {
    yes,
    no: values.length - yes,
    n: values.length,
  }
}

function collectWorkflowOutcomes(reports: readonly NativeAgentCompareReport[]): NativeAgentWorkflowOutcome[] {
  return reports.flatMap((report) => report.workflow_outcome ? [report.workflow_outcome] : [])
}

function collectWorkflowBooleans(
  outcomes: readonly NativeAgentWorkflowOutcome[],
  selector: (outcome: NativeAgentWorkflowOutcome) => boolean | null | undefined,
): boolean[] {
  return outcomes.flatMap((outcome) => {
    const value = selector(outcome)
    return typeof value === 'boolean' ? [value] : []
  })
}

function summarizeWorkflowOutcomes(
  reports: readonly NativeAgentCompareReport[],
): BenchmarkSuiteWorkflowOutcomeSummary | null {
  const outcomes = collectWorkflowOutcomes(reports)
  if (outcomes.length === 0) {
    return null
  }

  const summary: BenchmarkSuiteWorkflowOutcomeSummary = {
    wrong_file_edits: summarizeValues(collectNumbers(outcomes, (outcome) => outcome.wrong_file_edits ?? null)),
    validation_passed: summarizePassFail(collectWorkflowBooleans(outcomes, (outcome) => outcome.validation_passed)),
    review_time_seconds: summarizeValues(collectNumbers(outcomes, (outcome) => outcome.review_time_seconds ?? null)),
    rework_loops: summarizeValues(collectNumbers(outcomes, (outcome) => outcome.rework_loops ?? null)),
    human_intervention_required: summarizeYesNo(collectWorkflowBooleans(outcomes, (outcome) => outcome.human_intervention_required)),
    evidence: [...new Set(outcomes.flatMap((outcome) => outcome.evidence ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0))],
  }

  return (
    summary.wrong_file_edits !== null
    || summary.validation_passed !== null
    || summary.review_time_seconds !== null
    || summary.rework_loops !== null
    || summary.human_intervention_required !== null
    || summary.evidence.length > 0
  )
    ? summary
    : null
}

const BENCHMARK_OUTCOME_KEYS = ['full_win', 'partial_win', 'regression', 'not_measured'] as const

function emptyBenchmarkOutcomeCounts(): BenchmarkSuiteBenchmarkOutcomeCounts {
  return {
    full_win: 0,
    partial_win: 0,
    regression: 0,
    not_measured: 0,
  }
}

function summarizeBenchmarkOutcomeArm(
  reports: readonly NativeAgentCompareReport[],
): BenchmarkSuiteBenchmarkOutcomeSummary | null {
  const countedReports = reports.flatMap((report) => report.benchmark_outcome ? [report.benchmark_outcome] : [])
  if (countedReports.length === 0) {
    return null
  }

  const counts = emptyBenchmarkOutcomeCounts()
  const evidence = new Set<string>()
  for (const outcome of countedReports) {
    counts[outcome.outcome] += 1
    for (const entry of outcome.evidence) {
      const normalized = entry.trim()
      if (normalized.length > 0) {
        evidence.add(normalized)
      }
    }
  }

  return {
    counts,
    evidence: [...evidence],
  }
}

function isCompletedArm(summary: BenchmarkSuiteArmMetricsSummary): boolean {
  return summary.input_tokens !== null
}

function summarizeCellStatus(
  baseline: BenchmarkSuiteArmMetricsSummary,
  madar: BenchmarkSuiteArmMetricsSummary,
  planned: boolean,
  skipped: boolean,
): BenchmarkSuiteSummaryCell['status'] {
  if (planned) {
    return 'planned'
  }
  if (skipped) {
    return 'skipped'
  }
  const baselineDone = isCompletedArm(baseline)
  const madarDone = isCompletedArm(madar)
  if (baselineDone && madarDone) {
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

function formatSingleBenchmarkOutcome(summary: BenchmarkSuiteBenchmarkOutcomeSummary): string {
  const parts = BENCHMARK_OUTCOME_KEYS
    .filter((key) => summary.counts[key] > 0)
    .map((key) => summary.counts[key] === 1 ? key : `${key} x${summary.counts[key]}`)
  if (parts.length === 0) {
    return '—'
  }
  return summary.evidence.length > 0 ? `${parts.join(', ')} (${summary.evidence.join('; ')})` : parts.join(', ')
}

function formatBenchmarkOutcomes(summary: BenchmarkSuiteBenchmarkOutcomeSummary | null): string {
  return summary ? formatSingleBenchmarkOutcome(summary) : '—'
}

function formatCellRow(cell: BenchmarkSuiteSummaryCell): string {
  const statusLabel = cell.status === 'skipped' ? 'skipped' : cell.status
  const reason = cell.reason ?? '—'
  return [
    cell.repoId,
    statusLabel,
    formatBenchmarkOutcomes(cell.benchmark_outcomes),
    cell.isolation === null ? '—' : String(cell.isolation),
    reason,
    formatMetric(cell.baseline.input_tokens),
    formatMetric(cell.madar.input_tokens),
    formatMetric(cell.baseline.total_tool_calls),
    formatMetric(cell.madar.total_tool_calls),
    formatMetric(cell.baseline.read_calls),
    formatMetric(cell.madar.read_calls),
    formatMetric(cell.baseline.glob_grep_calls),
    formatMetric(cell.madar.glob_grep_calls),
    formatMetric(cell.baseline.wall_clock_ms),
    formatMetric(cell.madar.wall_clock_ms),
    formatMetric(cell.baseline.cost_usd, 2),
    formatMetric(cell.madar.cost_usd, 2),
    formatWorkflowOutcomes(cell.workflow_outcomes),
  ].join(' | ')
}

function formatSingleWorkflowOutcomes(summary: BenchmarkSuiteWorkflowOutcomeSummary): string {
  const parts: string[] = []
  if (summary.validation_passed) {
    parts.push(`validation pass ${summary.validation_passed.passed}/${summary.validation_passed.n}`)
  }
  if (summary.wrong_file_edits) {
    parts.push(`wrong-file edits ${formatMetric(summary.wrong_file_edits)}`)
  }
  if (summary.review_time_seconds) {
    parts.push(`review time (s) ${formatMetric(summary.review_time_seconds)}`)
  }
  if (summary.rework_loops) {
    parts.push(`rework ${formatMetric(summary.rework_loops)}`)
  }
  if (summary.human_intervention_required) {
    parts.push(`human intervention ${summary.human_intervention_required.yes}/${summary.human_intervention_required.n}`)
  }
  if (parts.length === 0 && summary.evidence.length > 0) {
    parts.push(summary.evidence.join(', '))
  }
  return parts.length > 0 ? parts.join('; ') : '—'
}

function formatWorkflowOutcomes(summary: BenchmarkSuiteWorkflowOutcomeSummary | null): string {
  return summary ? formatSingleWorkflowOutcomes(summary) : '—'
}

function formatBenchmarkSuiteSummaryMarkdown(summary: BenchmarkSuiteSummary): string {
  const lines = [
    '# Benchmark suite summary',
    '',
    `- Generated: ${summary.completed_at}`,
    `- Runtime artifact: source=${summary.runtime_artifact.source}, package=${summary.runtime_artifact.package_version ?? 'unknown'}, tarball_sha256=${summary.runtime_artifact.tarball_sha256 ?? 'n/a'}`,
    `- Filters: repo=${summary.filters.repo ?? 'all'}, task=${summary.filters.task ?? 'all'}, mode=${summary.filters.mode}, trials=${summary.filters.trials}`,
    `- cells_skipped_for_install: ${summary.cells_skipped_for_install} (preparation failures)`,
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
      lines.push('| Repo | Status | Benchmark outcomes | Isolation | Reason | Baseline input tokens | Madar input tokens | Baseline tool calls | Madar tool calls | Baseline Read | Madar Read | Baseline Glob/Grep | Madar Glob/Grep | Baseline wall-clock (ms) | Madar wall-clock (ms) | Baseline cost (USD) | Madar cost (USD) | Workflow outcomes |')
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
      for (const cell of modeCells) {
        lines.push(`| ${formatCellRow(cell)} |`)
      }
      lines.push('')
    }
  }

  return `${lines.join('\n').trimEnd()}\n`
}

function benchmarkRuntimeArtifact(): BenchmarkSuiteSummary['runtime_artifact'] {
  const tarballPath = process.env.MADAR_BENCH_PACKAGE_TARBALL
  const hasTarball = typeof tarballPath === 'string' && existsSync(tarballPath)
  return {
    source: process.env.MADAR_BENCH_RUNTIME_SOURCE ?? 'checkout',
    package_version: process.env.MADAR_BENCH_PACKAGE_VERSION ?? null,
    tarball_name: hasTarball ? tarballPath.split(/[\\/]/).at(-1) ?? null : null,
    tarball_sha256: hasTarball
      ? `sha256:${createHash('sha256').update(readFileSync(tarballPath)).digest('hex')}`
      : null,
  }
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
  return plans
    .map((plan) => [
      `[${plan.status}] ${plan.repo.id} / ${plan.task.id} / ${plan.mode}-cache`,
      plan.reason ? ` — ${plan.reason}` : '',
    ].join(''))
    .join('\n')
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

function formatRepoPreparationFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `Repo preparation failed: ${message}`
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
  const copiedRoot = destinationParent
  mkdirSync(copiedRoot, { recursive: true })
  for (const entry of readdirSync(report.paths.output_dir)) {
    cpSync(join(report.paths.output_dir, entry), join(copiedRoot, entry), { recursive: true })
  }
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
  const reposPath = options.reposManifestPath ? resolve(options.reposManifestPath) : DEFAULT_REPOS_PATH
  const repos = (dependencies.repos ?? loadBenchmarkSuiteRepos(reposPath)).map((repo) => normalizeBenchmarkSuiteRepo(repo))
  const configuredTasksPath = options.tasksManifestPath ? resolve(options.tasksManifestPath) : DEFAULT_TASKS_PATH
  const tasksPath = dependencies.tasksPath ?? (dependencies.tasks === undefined ? configuredTasksPath : null)
  const tasks = dependencies.tasks ?? loadBenchmarkSuiteTasks(tasksPath ?? DEFAULT_TASKS_PATH)
  const now = dependencies.now ?? (() => new Date())
  const runGenerateGraph = dependencies.generateGraph ?? generateGraph
  const getBenchmarkEnvironment = dependencies.captureBenchmarkEnvironment ?? captureBenchmarkEnvironment
  const runCompare = dependencies.executeNativeAgentCompare ?? executeNativeAgentCompare
  const isolation = benchmarkIsolationEnabled()
  const expectedEnvironment = isolation
    ? (dependencies.expectedEnvironment === undefined ? loadExpectedEnvironment() : dependencies.expectedEnvironment)
    : null
  if (isolation && expectedEnvironment === null) {
    throw new Error(
      `Benchmark isolation is enabled but no expected environment was loaded from ${portablePath(DEFAULT_EXPECTED_ENVIRONMENT_PATH)}`,
    )
  }

  const selectedRepos = selectById(repos, 'repo', options.repo)
  const selectedTasks = selectById(tasks, 'task', options.task)
  const plans = selectedRepos.flatMap((repo) => selectedTasks.flatMap((task) => suiteModes(options.mode).map((mode) => planCell(repo, task, mode))))

  if (options.dryRun) {
    return { text: dryRunText(plans) }
  }

  const startedAt = now()
  const outputRoot = createSuiteOutputRoot(resolve(options.outputDir), startedAt)
  const readyPlans = plans.filter((plan) => plan.status === 'ready')
  const preparedRepos = new Map<string, PreparedBenchmarkRepo>()
  const skippedRepos = new Map<string, string>()
  const scratchRoots: string[] = []
  const stagingRoot = validateGraphOutputPath(
    join('out', 'benchmark-suite-staging', timestampDirectoryName(startedAt)),
  )
  const summaryCells: BenchmarkSuiteSummaryCell[] = []

  try {
    mkdirSync(stagingRoot, { recursive: true })

    for (const repo of [...new Set(readyPlans.map((plan) => plan.repo))]) {
      const scratchRoot = mkdtempSync(join(tmpdir(), `madar-bench-suite-${repo.id}-`))
      scratchRoots.push(scratchRoot)
      try {
        const sourceRoot = materializeBenchmarkRepoSource(repo, scratchRoot)

        const graphPath = prepareBenchmarkWorkspace(sourceRoot, runGenerateGraph, scratchRoot, repo.graphRoot)

        preparedRepos.set(repo.id, {
          sourceRoot,
          graphPath,
        })
      } catch (error) {
        skippedRepos.set(repo.id, formatRepoPreparationFailure(error))
      }
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
          benchmark_outcomes: null,
          workflow_outcomes: null,
          artifacts: {
            share_safe_reports: [],
          },
        })
        continue
      }

      const skippedReason = skippedRepos.get(plan.repo.id)
      if (skippedReason) {
        summaryCells.push({
          repoId: plan.repo.id,
          repoName: plan.repo.name,
          taskId: plan.task.id,
          taskName: plan.task.name,
          mode: plan.mode,
          prompt: plan.prompt,
          status: 'skipped',
          reason: skippedReason,
          isolation: null,
          baseline: summarizeArmMetrics([], 'baseline'),
          madar: summarizeArmMetrics([], 'madar'),
          benchmark_outcomes: null,
          workflow_outcomes: null,
          artifacts: {
            share_safe_reports: [],
          },
        })
        continue
      }

      const prepared = preparedRepos.get(plan.repo.id)
      if (!prepared) {
        throw new Error(`Missing prepared repo for ${plan.repo.id}`)
      }

      if (isolation && expectedEnvironment !== null) {
        const workspaceRoot = dirname(dirname(prepared.graphPath))
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
            benchmark_outcomes: null,
            workflow_outcomes: null,
            artifacts: {
              share_safe_reports: [],
            },
          })
          continue
        }
      }

      const reports: NativeAgentCompareReport[] = []
      const copiedArtifacts: string[] = []

      for (let trial = 1; trial <= options.trials; trial += 1) {
        const trialLabel = `trial-${String(trial).padStart(3, '0')}`
        const coldScratchRoot = plan.mode === 'cold'
          ? mkdtempSync(join(tmpdir(), `madar-bench-suite-${plan.repo.id}-${trialLabel}-`))
          : null
        if (coldScratchRoot) {
          scratchRoots.push(coldScratchRoot)
        }
        const graphPath = coldScratchRoot
          ? prepareBenchmarkWorkspace(prepared.sourceRoot, runGenerateGraph, coldScratchRoot, plan.repo.graphRoot)
          : prepared.graphPath
        const taskKind = suiteTaskKind(plan.task.id)
        const compareInput = {
          graphPath,
          question: plan.prompt,
          ...(tasksPath ? { questionsPath: tasksPath } : {}),
          outputDir: join(stagingRoot, plan.repo.id, plan.task.id, `${plan.mode}-cache`, 'canonical', trialLabel),
          execTemplate: execTemplateForWorkspace(options.execTemplate, dirname(dirname(graphPath))),
          ...(taskKind ? { task: taskKind } : {}),
          baselineMode: 'native_agent' as const,
        }
        await maybePrimeWarmCache(plan.mode, runCompare, compareInput)
        const compareResult = await runCompare(compareInput)
        const report = compareResult.reports[0]
        if (report) {
          reports.push(report)
          copiedArtifacts.push(copyReportArtifacts(
            report,
            join(outputRoot, 'raw', plan.repo.id, plan.task.id, `${plan.mode}-cache`, 'canonical', trialLabel),
          ))
        }
      }

      const baseline = summarizeArmMetrics(reports, 'baseline')
      const madar = summarizeArmMetrics(reports, 'madar')
      const cellIsolation = summarizeIsolation(reports)
      summaryCells.push({
        repoId: plan.repo.id,
        repoName: plan.repo.name,
        taskId: plan.task.id,
        taskName: plan.task.name,
        mode: plan.mode,
        prompt: plan.prompt,
        status: summarizeCellStatus(baseline, madar, false, false),
        reason: null,
        isolation: cellIsolation,
        baseline,
        madar,
        benchmark_outcomes: summarizeBenchmarkOutcomeArm(reports),
        workflow_outcomes: summarizeWorkflowOutcomes(reports),
        artifacts: {
          share_safe_reports: stringifyArtifacts(copiedArtifacts),
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
    schema_version: 2,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    output_root: portablePath(outputRoot),
    runtime_artifact: benchmarkRuntimeArtifact(),
    filters: {
      repo: options.repo,
      task: options.task,
      repos_manifest: receiptManifestPath(reposPath),
      tasks_manifest: tasksPath ? receiptManifestPath(tasksPath) : null,
      mode: options.mode,
      trials: options.trials,
    },
    cells_skipped_for_install: summaryCells.filter((cell) => cell.status === 'skipped').length,
    cells_skipped_for_env_drift: summaryCells.filter((cell) => cell.status === 'env_mismatch').length,
    cells: summaryCells,
  }
  const { summaryPath, summaryJsonPath } = writeSummary(outputRoot, summary)
  const runnableCount = summaryCells.filter(
    (cell) => cell.status !== 'planned' && cell.status !== 'skipped' && cell.status !== 'env_mismatch',
  ).length
  const envMismatchCount = summary.cells_skipped_for_env_drift
  const plannedCount = summaryCells.filter((cell) => cell.status === 'planned').length
  const skippedCount = summary.cells_skipped_for_install
  const cellSummaryParts = [`Cells: ${runnableCount} measured`]

  if (envMismatchCount > 0) {
    cellSummaryParts.push(`${envMismatchCount} env mismatch`)
  }
  cellSummaryParts.push(`${plannedCount} planned`)
  if (skippedCount > 0) {
    cellSummaryParts.push(`${skippedCount} skipped during preparation`)
  }

  return {
    text: [
      `Wrote benchmark suite results to ${portablePath(outputRoot)}`,
      `Summary: ${portablePath(summaryPath)}`,
      `JSON: ${portablePath(summaryJsonPath)}`,
      cellSummaryParts.join(' · '),
    ].join('\n'),
    outputRoot,
    summaryPath,
    summaryJsonPath,
    summary,
  }
}
