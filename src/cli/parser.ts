import { dirname, resolve } from 'node:path'

import { validateGraphOutputPath, validateGraphPath } from '../shared/security.js'
import { resolveWorkspaceGraphPath } from '../shared/workspace.js'
import { type InstallPlatform, isInstallPlatform } from '../infrastructure/install.js'

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export interface QueryCliOptions {
  question: string
  graphPath: string
  budget?: number
}

export interface TryCliOptions {
  question: string
  path: string
}

export interface BenchmarkCliOptions {
  graphPath: string
  questionsPath: string | null
  execTemplate: string
  yes: boolean
}

export interface BenchSuiteCliOptions {
  repo: string | null
  task: string | null
  reposManifestPath: string | null
  tasksManifestPath: string | null
  mode: 'cold' | 'warm' | 'all'
  trials: number
  outputDir: string
  execTemplate: string
  dryRun: boolean
  yes: boolean
}

export interface CompareCliOptions {
  question: string
  graphPath: string
  execTemplate: string
  outputDir: string
  perArmTimeoutSeconds: number
  yes: boolean
}

export interface GenerateCliOptions {
  path: string
  update: boolean
  watch: boolean
  followSymlinks?: true
  respectGitignore?: true
  debounceSeconds: number
  neo4jPushUri: string | null
  neo4jUser: string | null
  neo4jPassword: string | null
  neo4jDatabase: string | null
  strictIndexing: boolean
  maxIndexingFailed: number
  maxIndexingUnsupported: number
}

export interface WatchCliOptions {
  path: string
  followSymlinks: boolean
  respectGitignore: boolean
  debounceSeconds: number
}

export interface ServeCliOptions {
  graphPath: string
  autoRefresh: boolean
}

export interface DoctorCliOptions {
  graphPath: string
}

export interface HookCliOptions {
  action: 'install' | 'uninstall' | 'status'
}

export interface InstallCliOptions {
  platform: InstallPlatform
}

export type TelemetryCliOptions =
  | { action: 'enable' | 'disable' | 'status' | 'clear' }
  | { action: 'report'; spoolPaths: string[] }

const COMPARE_USAGE = 'Usage: madar compare <question> --exec TEMPLATE [--graph path] [--output-dir DIR] [--per-arm-timeout S] [--yes]'
export const INSTALL_USAGE = 'Usage: madar install [platform|--platform P]'

export interface PlatformActionCliOptions {
  action: 'install' | 'uninstall'
}

const MAX_CLI_LABEL_LENGTH = 512
const MAX_CLI_PATH_LENGTH = 4_096

function requireNonEmptyValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new UsageError(`error: ${flag} requires a value`)
  }
  return value
}

function requireOptionValue(flag: string, value: string | undefined): string {
  const required = requireNonEmptyValue(flag, value)
  if (required.startsWith('--')) {
    throw new UsageError(`error: ${flag} requires a value`)
  }
  return required
}

function parsePositiveInteger(flag: string, value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UsageError(`error: ${flag} must be a positive integer`)
  }
  return parsed
}

function parsePositiveDecimalInteger(flag: string, value: string): number {
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) {
    throw new UsageError(`error: ${flag} must be a positive integer`)
  }
  return parsePositiveInteger(flag, normalized)
}

function parseNonNegativeInteger(flag: string, value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`error: ${flag} must be a non-negative integer`)
  }
  return parsed
}

function parseNonNegativeNumber(flag: string, value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new UsageError(`error: ${flag} must be a non-negative number`)
  }
  return parsed
}

function validateCliText(field: string, value: string): string {
  if (value.length > MAX_CLI_LABEL_LENGTH) {
    throw new UsageError(`error: ${field} exceeds maximum length of ${MAX_CLI_LABEL_LENGTH} characters`)
  }
  return value
}

function parseValidatedGraphPath(flag: string, value: string | undefined): string {
  return validateGraphPath(requireOptionValue(flag, value))
}

export function parseQueryArgs(args: string[]): QueryCliOptions {
  const question = args[0]?.trim()
  if (!question) {
    throw new UsageError('Usage: madar query "<question>" [--budget N] [--graph path]')
  }

  let graphPath = 'out/graph.json'
  let budget: number | undefined

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (argument === '--budget') {
      budget = parsePositiveDecimalInteger(
        '--budget',
        requireOptionValue('--budget', args[index + 1]),
      )
      index += 1
      continue
    }

    if (argument.startsWith('--budget=')) {
      const [, value] = argument.split('=', 2)
      budget = parsePositiveDecimalInteger(
        '--budget',
        requireOptionValue('--budget', value),
      )
      continue
    }

    if (argument === '--graph') {
      graphPath = parseValidatedGraphPath('--graph', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--graph=')) {
      const [, value] = argument.split('=', 2)
      graphPath = parseValidatedGraphPath('--graph', value)
      continue
    }

    throw new UsageError(`error: unknown option for query: ${argument}`)
  }

  return {
    question,
    graphPath,
    ...(budget === undefined ? {} : { budget }),
  }
}

export function parseTryArgs(args: string[]): TryCliOptions {
  const usage = 'Usage: madar try "<question>" [path]'
  const question = args[0]?.trim()
  if (!question) {
    throw new UsageError(usage)
  }

  const path = args[1] ?? '.'
  if (args.length > 2 || path.startsWith('--')) {
    throw new UsageError(usage)
  }
  if (path.length > MAX_CLI_PATH_LENGTH) {
    throw new UsageError(`error: path exceeds maximum length of ${MAX_CLI_PATH_LENGTH} characters`)
  }

  return { question, path }
}

export function parseBenchmarkArgs(args: string[], commandName = 'benchmark'): BenchmarkCliOptions {
  const usage = `Usage: madar ${commandName} [graph.json] --exec TEMPLATE [--questions PATH] [--yes]`
  let graphPath = 'out/graph.json'
  let questionsPath: string | null = null
  let execTemplate = ''
  let yes = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (!argument.startsWith('--')) {
      if (graphPath !== 'out/graph.json') {
        throw new UsageError(usage)
      }
      graphPath = requireNonEmptyValue('graph path', argument)
      continue
    }

    if (argument === '--questions') {
      questionsPath = requireOptionValue('--questions', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--questions=')) {
      const [, value] = argument.split('=', 2)
      questionsPath = requireNonEmptyValue('--questions', value)
      continue
    }

    if (argument === '--exec') {
      execTemplate = requireOptionValue('--exec', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--exec=')) {
      const [, value] = argument.split('=', 2)
      execTemplate = requireOptionValue('--exec', value)
      continue
    }

    if (argument === '--yes') {
      yes = true
      continue
    }

    throw new UsageError(`error: unknown option for ${commandName}: ${argument}`)
  }

  if (execTemplate.length === 0) {
    throw new UsageError('error: --exec is required')
  }

  return { graphPath, questionsPath, execTemplate, yes }
}

export function parseBenchSuiteArgs(args: string[]): BenchSuiteCliOptions {
  let repo: string | null = null
  let task: string | null = null
  let reposManifestPath: string | null = null
  let tasksManifestPath: string | null = null
  let mode: BenchSuiteCliOptions['mode'] = 'all'
  let trials = 3
  let outputDir = resolve('docs/benchmarks/suite/results')
  let execTemplate = ''
  let dryRun = false
  let yes = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (argument === '--repo') {
      repo = requireOptionValue('--repo', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--repo=')) {
      const [, value] = argument.split('=', 2)
      repo = requireOptionValue('--repo', value)
      continue
    }

    if (argument === '--task') {
      task = requireOptionValue('--task', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--task=')) {
      const [, value] = argument.split('=', 2)
      task = requireOptionValue('--task', value)
      continue
    }

    if (argument === '--repos-manifest') {
      reposManifestPath = resolve(requireOptionValue('--repos-manifest', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--repos-manifest=')) {
      const [, value] = argument.split('=', 2)
      reposManifestPath = resolve(requireOptionValue('--repos-manifest', value))
      continue
    }

    if (argument === '--tasks-manifest') {
      tasksManifestPath = resolve(requireOptionValue('--tasks-manifest', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--tasks-manifest=')) {
      const [, value] = argument.split('=', 2)
      tasksManifestPath = resolve(requireOptionValue('--tasks-manifest', value))
      continue
    }

    if (argument === '--mode') {
      const value = requireOptionValue('--mode', args[index + 1])
      if (value !== 'cold' && value !== 'warm' && value !== 'all') {
        throw new UsageError('error: --mode must be one of cold, warm, all')
      }
      mode = value
      index += 1
      continue
    }

    if (argument.startsWith('--mode=')) {
      const [, value] = argument.split('=', 2)
      if (value !== 'cold' && value !== 'warm' && value !== 'all') {
        throw new UsageError('error: --mode must be one of cold, warm, all')
      }
      mode = value
      continue
    }

    if (argument === '--trials') {
      trials = parsePositiveDecimalInteger('--trials', requireOptionValue('--trials', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--trials=')) {
      const [, value] = argument.split('=', 2)
      trials = parsePositiveDecimalInteger('--trials', requireOptionValue('--trials', value))
      continue
    }

    if (argument === '--output-dir') {
      outputDir = resolve(requireOptionValue('--output-dir', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--output-dir=')) {
      const [, value] = argument.split('=', 2)
      outputDir = resolve(requireOptionValue('--output-dir', value))
      continue
    }

    if (argument === '--exec') {
      execTemplate = requireOptionValue('--exec', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--exec=')) {
      const [, value] = argument.split('=', 2)
      execTemplate = requireOptionValue('--exec', value)
      continue
    }

    if (argument === '--dry-run') {
      dryRun = true
      continue
    }

    if (argument === '--yes') {
      yes = true
      continue
    }

    throw new UsageError(`error: unknown option for bench:suite: ${argument}`)
  }

  if (!dryRun && execTemplate.length === 0) {
    throw new UsageError('error: --exec is required unless --dry-run is set')
  }

  return { repo, task, reposManifestPath, tasksManifestPath, mode, trials, outputDir, execTemplate, dryRun, yes }
}

export function parseCompareArgs(args: string[]): CompareCliOptions {
  let question: string | null = null
  let graphPath = 'out/graph.json'
  let execTemplate = ''
  let outputDir = 'out/compare'
  let perArmTimeoutSeconds = 600
  let yes = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (!argument.startsWith('--')) {
      if (question !== null) {
        throw new UsageError(COMPARE_USAGE)
      }
      const normalizedQuestion = argument.trim()
      if (normalizedQuestion.length === 0) {
        throw new UsageError(COMPARE_USAGE)
      }
      question = normalizedQuestion
      continue
    }

    if (argument === '--graph') {
      graphPath = requireOptionValue('--graph', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--graph=')) {
      const [, value] = argument.split('=', 2)
      graphPath = requireOptionValue('--graph', value)
      continue
    }

    if (argument === '--exec') {
      execTemplate = requireOptionValue('--exec', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--exec=')) {
      const [, value] = argument.split('=', 2)
      execTemplate = requireOptionValue('--exec', value)
      continue
    }

    if (argument === '--output-dir') {
      outputDir = requireOptionValue('--output-dir', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--output-dir=')) {
      const [, value] = argument.split('=', 2)
      outputDir = requireOptionValue('--output-dir', value)
      continue
    }

    if (argument === '--per-arm-timeout') {
      perArmTimeoutSeconds = parsePositiveDecimalInteger('--per-arm-timeout', requireOptionValue('--per-arm-timeout', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--per-arm-timeout=')) {
      const [, value] = argument.split('=', 2)
      perArmTimeoutSeconds = parsePositiveDecimalInteger('--per-arm-timeout', requireOptionValue('--per-arm-timeout', value))
      continue
    }

    if (argument === '--yes') {
      yes = true
      continue
    }

    throw new UsageError(`error: unknown option for compare: ${argument}`)
  }

  if (question === null) {
    throw new UsageError(COMPARE_USAGE)
  }

  if (execTemplate.length === 0) {
    throw new UsageError('error: --exec is required')
  }

  const resolvedGraphPath = resolveWorkspaceGraphPath(graphPath)
  const graphArtifactDir = dirname(resolve(resolvedGraphPath))
  // Keep compare receipts beside the graph. This is especially important for
  // linked worktrees, whose graph artifact directory intentionally lives
  // outside the source checkout.
  outputDir = outputDir === 'out/compare'
    ? validateGraphOutputPath(resolve(graphArtifactDir, 'compare'), graphArtifactDir)
    : validateGraphOutputPath(outputDir)

  return {
    question,
    graphPath: resolvedGraphPath,
    execTemplate,
    outputDir,
    perArmTimeoutSeconds,
    yes,
  }
}

export function parseGenerateArgs(args: string[]): GenerateCliOptions {
  let path = '.'
  let update = false
  let watch = false
  let followSymlinks: true | undefined
  let respectGitignore: true | undefined
  let debounceSeconds = 3
  let neo4jPushUri: string | null = null
  let neo4jUser: string | null = null
  let neo4jPassword: string | null = null
  let neo4jDatabase: string | null = null
  let strictIndexing = false
  let maxIndexingFailed = 0
  let maxIndexingUnsupported = 0

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (argument === '--strict-indexing') {
      strictIndexing = true
      continue
    }

    if (argument === '--max-indexing-failed') {
      maxIndexingFailed = parseNonNegativeInteger('--max-indexing-failed', requireNonEmptyValue('--max-indexing-failed', args[index + 1]))
      strictIndexing = true
      index += 1
      continue
    }

    if (argument.startsWith('--max-indexing-failed=')) {
      const [, value] = argument.split('=', 2)
      maxIndexingFailed = parseNonNegativeInteger('--max-indexing-failed', requireNonEmptyValue('--max-indexing-failed', value))
      strictIndexing = true
      continue
    }

    if (argument === '--max-indexing-unsupported') {
      maxIndexingUnsupported = parseNonNegativeInteger('--max-indexing-unsupported', requireNonEmptyValue('--max-indexing-unsupported', args[index + 1]))
      strictIndexing = true
      index += 1
      continue
    }

    if (argument.startsWith('--max-indexing-unsupported=')) {
      const [, value] = argument.split('=', 2)
      maxIndexingUnsupported = parseNonNegativeInteger('--max-indexing-unsupported', requireNonEmptyValue('--max-indexing-unsupported', value))
      strictIndexing = true
      continue
    }

    if (!argument.startsWith('--')) {
      if (path !== '.') {
        throw new UsageError(
          'Usage: madar generate [path] [--update] [--watch] [--follow-symlinks] [--respect-gitignore] [--debounce S] [--neo4j-push URI] [--neo4j-user USER] [--neo4j-password PW] [--neo4j-database DB] [--strict-indexing] [--max-indexing-failed N] [--max-indexing-unsupported N]',
        )
      }
      path = argument
      continue
    }

    if (argument === '--update') {
      update = true
      continue
    }

    if (argument === '--watch') {
      watch = true
      continue
    }

    if (argument === '--follow-symlinks') {
      followSymlinks = true
      continue
    }

    if (argument === '--respect-gitignore') {
      respectGitignore = true
      continue
    }

    if (argument === '--neo4j-push') {
      neo4jPushUri = requireNonEmptyValue('--neo4j-push', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--neo4j-push=')) {
      const [, value] = argument.split('=', 2)
      neo4jPushUri = requireNonEmptyValue('--neo4j-push', value)
      continue
    }

    if (argument === '--neo4j-user') {
      neo4jUser = requireNonEmptyValue('--neo4j-user', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--neo4j-user=')) {
      const [, value] = argument.split('=', 2)
      neo4jUser = requireNonEmptyValue('--neo4j-user', value)
      continue
    }

    if (argument === '--neo4j-password') {
      neo4jPassword = requireNonEmptyValue('--neo4j-password', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--neo4j-password=')) {
      const [, value] = argument.split('=', 2)
      neo4jPassword = requireNonEmptyValue('--neo4j-password', value)
      continue
    }

    if (argument === '--neo4j-database') {
      neo4jDatabase = requireNonEmptyValue('--neo4j-database', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--neo4j-database=')) {
      const [, value] = argument.split('=', 2)
      neo4jDatabase = requireNonEmptyValue('--neo4j-database', value)
      continue
    }

    if (argument === '--debounce') {
      debounceSeconds = parseNonNegativeNumber('--debounce', requireNonEmptyValue('--debounce', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--debounce=')) {
      const [, value] = argument.split('=', 2)
      debounceSeconds = parseNonNegativeNumber('--debounce', requireNonEmptyValue('--debounce', value))
      continue
    }

    throw new UsageError(`error: unknown option for generate: ${argument}`)
  }

  return {
    path,
    update,
    watch,
    ...(followSymlinks ? { followSymlinks } : {}),
    ...(respectGitignore ? { respectGitignore } : {}),
    debounceSeconds,
    neo4jPushUri,
    neo4jUser,
    neo4jPassword,
    neo4jDatabase,
    strictIndexing,
    maxIndexingFailed,
    maxIndexingUnsupported,
  }
}

export function parseWatchArgs(args: string[]): WatchCliOptions {
  let path = '.'
  let followSymlinks = false
  let respectGitignore = false
  let debounceSeconds = 3

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (!argument.startsWith('--')) {
      if (path !== '.') {
        throw new UsageError('Usage: madar watch [path] [--follow-symlinks] [--respect-gitignore] [--debounce S]')
      }
      path = argument
      continue
    }

    if (argument === '--follow-symlinks') {
      followSymlinks = true
      continue
    }

    if (argument === '--respect-gitignore') {
      respectGitignore = true
      continue
    }

    if (argument === '--debounce') {
      debounceSeconds = parseNonNegativeNumber('--debounce', requireNonEmptyValue('--debounce', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--debounce=')) {
      const [, value] = argument.split('=', 2)
      debounceSeconds = parseNonNegativeNumber('--debounce', requireNonEmptyValue('--debounce', value))
      continue
    }

    throw new UsageError(`error: unknown option for watch: ${argument}`)
  }

  return { path, followSymlinks, respectGitignore, debounceSeconds }
}

export function parseServeArgs(args: string[]): ServeCliOptions {
  let graphPath = 'out/graph.json'
  let autoRefresh = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (!argument.startsWith('--')) {
      if (graphPath !== 'out/graph.json') {
        throw new UsageError(
          'Usage: madar serve [graph.json] [--stdio|--mcp] [--auto-refresh]',
        )
      }
      graphPath = validateGraphPath(argument)
      continue
    }

    if (argument === '--stdio' || argument === '--mcp') {
      continue
    }

    if (argument === '--auto-refresh') {
      autoRefresh = true
      continue
    }

    throw new UsageError(`error: unknown option for serve: ${argument}`)
  }

  return { graphPath, autoRefresh }
}

export function parseDoctorArgs(args: string[], commandName: 'doctor' | 'status' = 'doctor'): DoctorCliOptions {
  const usage = `Usage: madar ${commandName} [graph.json] [--graph path]`
  let graphPath = 'out/graph.json'

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (!argument.startsWith('--')) {
      if (graphPath !== 'out/graph.json') {
        throw new UsageError(usage)
      }
      graphPath = argument
      continue
    }

    if (argument === '--graph') {
      graphPath = requireOptionValue('--graph', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--graph=')) {
      const [, value] = argument.split('=', 2)
      graphPath = requireOptionValue('--graph', value)
      continue
    }

    throw new UsageError(`error: unknown option for ${commandName}: ${argument}`)
  }

  return { graphPath }
}

export function parseHookArgs(args: string[]): HookCliOptions {
  const action = args[0]
  if (action === 'install' || action === 'uninstall' || action === 'status') {
    if (args.length > 1) {
      throw new UsageError('Usage: madar hook <install|uninstall|status>')
    }
    return { action }
  }

  throw new UsageError('Usage: madar hook <install|uninstall|status>')
}

export function parseTelemetryArgs(args: string[]): TelemetryCliOptions {
  const action = args[0]
  if (action === 'enable' || action === 'disable' || action === 'status' || action === 'clear') {
    if (args.length > 1) {
      throw new UsageError('Usage: madar telemetry <enable|disable|status|clear|report [spool.json ...]>')
    }
    return { action }
  }
  if (action === 'report') {
    return { action, spoolPaths: args.slice(1) }
  }

  throw new UsageError('Usage: madar telemetry <enable|disable|status|clear|report [spool.json ...]>')
}

export function parseInstallArgs(args: string[], defaultPlatform: InstallPlatform): InstallCliOptions {
  let platform = defaultPlatform
  let platformProvided = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (argument === '--platform') {
      const value = requireNonEmptyValue('--platform', args[index + 1])
      if (platformProvided) {
        throw new UsageError(INSTALL_USAGE)
      }
      if (!isInstallPlatform(value)) {
        throw new UsageError(`error: unknown platform '${value}'`)
      }
      platform = value
      platformProvided = true
      index += 1
      continue
    }

    if (argument.startsWith('--platform=')) {
      const [, value] = argument.split('=', 2)
      const normalizedValue = requireNonEmptyValue('--platform', value)
      if (platformProvided) {
        throw new UsageError(INSTALL_USAGE)
      }
      if (!isInstallPlatform(normalizedValue)) {
        throw new UsageError(`error: unknown platform '${normalizedValue}'`)
      }
      platform = normalizedValue
      platformProvided = true
      continue
    }

    if (isInstallPlatform(argument)) {
      if (platformProvided) {
        throw new UsageError(INSTALL_USAGE)
      }
      platform = argument
      platformProvided = true
      continue
    }

    throw new UsageError(INSTALL_USAGE)
  }

  return { platform }
}

export function parsePlatformActionArgs(command: string, args: string[]): PlatformActionCliOptions {
  const action = args[0]
  const usage = `Usage: madar ${command} <install|uninstall>`
  if (action !== 'install' && action !== 'uninstall') {
    throw new UsageError(usage)
  }
  if (args.length !== 1) throw new UsageError(usage)
  return { action }
}
