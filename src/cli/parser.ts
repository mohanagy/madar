import { dirname, isAbsolute, resolve } from 'node:path'

import type { ContextPackFormat, ContextPackRetrievalStrategy, ContextPackTaskKind } from '../contracts/context-pack.js'
import { validateGraphOutputPath, validateGraphPath } from '../shared/security.js'
import { type InstallPlatform, isInstallPlatform, type InstallProfile, isInstallProfile } from '../infrastructure/install.js'

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export type QueryRankBy = 'relevance' | 'degree'

export interface QueryCliOptions {
  question: string
  mode: 'bfs' | 'dfs'
  tokenBudget: number
  graphPath: string
  rankBy: QueryRankBy
  community: number | null
  fileType: string | null
}

export interface PackCliOptions {
  prompt: string
  budget: number
  task: ContextPackTaskKind
  taskExplicit?: boolean
  graphPath: string
  format?: ContextPackFormat
  why?: boolean
  verbose?: boolean
  /** #75 manual override for the retrieval gate. When set (0-5), the gate
   *  emits a decision with reason 'manual override' at the supplied level
   *  instead of running its heuristic classifier on the prompt. */
  retrievalLevel?: 0 | 1 | 2 | 3 | 4 | 5
  retrievalStrategy?: ContextPackRetrievalStrategy
}

export interface HandoffCliOptions {
  prompt: string
  budget: number
  task: ContextPackTaskKind
  graphPath: string
  consumer: 'generic' | 'codex' | 'cursor' | 'copilot'
  allowSnippets?: boolean
}

export type PromptCliProvider = 'claude' | 'gemini'

export interface PromptCliOptions {
  prompt: string
  provider: PromptCliProvider
  graphPath: string
}

export interface PathCliOptions {
  source: string
  target: string
  graphPath: string
  maxHops: number
}

export interface DiffCliOptions {
  baselineGraphPath: string
  graphPath: string
  limit: number
}

export interface ExplainCliOptions {
  label: string
  graphPath: string
  relation: string
}

export interface AddCliOptions {
  url: string
  path: string
  followSymlinks: boolean
  noHtml: boolean
}

export interface SaveResultCliOptions {
  question: string
  answer: string
  queryType: string
  sourceNodes: string[]
  memoryDir: string
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
  mode: 'cold' | 'warm' | 'all'
  trials: number
  outputDir: string
  execTemplate: string
  dryRun: boolean
  yes: boolean
}

export interface CompareCliOptions {
  question: string | null
  graphPath: string
  execTemplate: string
  questionsPath: string | null
  outputDir: string
  task: 'explain' | 'implement'
  baselineMode: 'full' | 'bounded' | 'pack_only' | 'native_agent'
  perArmTimeoutSeconds: number
  heartbeatIntervalMs: number
  strictMadarFirst: boolean
  strictBenchmarkReadiness: boolean
  allowNoInstall: boolean
  yes: boolean
  limit: number | null
  why?: boolean
}

export interface ReviewCompareCliOptions {
  graphPath: string
  execTemplate: string
  outputDir: string
  baseBranch: string | null
  budget: number | null
  yes: boolean
}

export interface TimeTravelCliOptions {
  fromRef: string
  toRef: string
  view: 'summary' | 'risk' | 'drift' | 'timeline'
  json: boolean
  refresh: boolean
  limit: number
}

export interface GenerateCliOptions {
  path: string
  update: boolean
  clusterOnly: boolean
  watch: boolean
  directed: boolean
  followSymlinks: boolean
  debounceSeconds: number
  noHtml: boolean
  wiki: boolean
  obsidian: boolean
  obsidianDir: string | null
  svg: boolean
  graphml: boolean
  neo4j: boolean
  neo4jPushUri: string | null
  neo4jUser: string | null
  neo4jPassword: string | null
  neo4jDatabase: string | null
  includeDocs: boolean
  docs: boolean
  /** v0.18 (#85 candidate): opt-in to the SPI v1 build pipeline.
   *  When true, `buildSpiCached` + `projectSpiToExtraction` replace the
   *  legacy `extract()` call site so framework_role / framework_metadata
   *  flows into graph.json. Default false — same output as before v0.14. */
  useSpi: boolean
}

export interface WatchCliOptions {
  path: string
  followSymlinks: boolean
  debounceSeconds: number
  noHtml: boolean
}

export interface ServeCliOptions {
  graphPath: string
  host: string
  port: number
  transport: 'http' | 'stdio'
}

export interface DoctorCliOptions {
  graphPath: string
}

export interface SummaryCliOptions {
  graphPath: string
}

export interface ProofReportCliOptions {
  graphPath: string
  outputDir: string
  compareDir: string
  packPath: string | null
}

export interface HookCliOptions {
  action: 'install' | 'uninstall' | 'status'
}

export interface InstallCliOptions {
  platform: InstallPlatform
}

const COMPARE_USAGE = 'Usage: madar compare [question] --exec TEMPLATE [--graph path] [--questions PATH] [--output-dir DIR] [--task TASK] [--baseline-mode MODE] [--per-arm-timeout S] [--heartbeat-interval-ms N] [--strict-madar-first] [--strict] [--allow-no-install] [--yes] [--limit N] [--why]'

export interface PlatformActionCliOptions {
  action: 'install' | 'uninstall'
  profile?: InstallProfile
}

const PROFILE_AWARE_PLATFORM_COMMANDS = new Set(['claude', 'cursor', 'copilot', 'gemini'])

const MAX_CLI_SOURCE_NODES = 50
const MAX_CLI_LABEL_LENGTH = 512
const MAX_CLI_PATH_LENGTH = 4_096
const MAX_QUESTION_LENGTH = 2_000
const MAX_ANSWER_LENGTH = 100_000
const MAX_PATH_HOPS = 20
const MAX_TOKEN_BUDGET = 100_000
const MAX_PORT = 65_535

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
  if (!Number.isInteger(parsed) || parsed <= 0) {
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

function parsePort(flag: string, value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_PORT) {
    throw new UsageError(`error: ${flag} must be between 0 and ${MAX_PORT}`)
  }
  return parsed
}

function parseServeTransport(flag: string, value: string): 'http' | 'stdio' {
  const normalized = value.trim().toLowerCase()
  if (normalized !== 'http' && normalized !== 'stdio') {
    throw new UsageError(`error: ${flag} must be one of http, stdio`)
  }

  return normalized
}

function parseBudget(value: string): number {
  const parsed = parsePositiveInteger('--budget', value)
  if (parsed > MAX_TOKEN_BUDGET) {
    throw new UsageError(`error: --budget must be <= ${MAX_TOKEN_BUDGET}`)
  }
  return parsed
}

function parseQueryRankBy(value: string): QueryRankBy {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'relevance' || normalized === 'degree') {
    return normalized
  }
  throw new UsageError('error: --rank-by must be one of relevance, degree')
}

function parseCompareBaselineMode(value: string): 'full' | 'bounded' | 'pack_only' | 'native_agent' {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'full' || normalized === 'bounded' || normalized === 'pack_only' || normalized === 'native_agent') {
    return normalized
  }
  throw new UsageError('error: --baseline-mode must be one of full, bounded, pack_only, native_agent')
}

function parseTimeTravelView(value: string): 'summary' | 'risk' | 'drift' | 'timeline' {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'summary' || normalized === 'risk' || normalized === 'drift' || normalized === 'timeline') {
    return normalized
  }
  throw new UsageError('error: --view must be one of summary, risk, drift, timeline')
}

function parseContextPackTask(value: string): ContextPackTaskKind {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'explain' || normalized === 'implement' || normalized === 'review' || normalized === 'impact') {
    return normalized
  }
  throw new UsageError('error: --task must be one of explain, implement, review, impact')
}

function parseCompareTask(value: string): 'explain' | 'implement' {
  const task = parseContextPackTask(value)
  if (task === 'explain' || task === 'implement') {
    return task
  }
  throw new UsageError('error: compare --task must be one of explain, implement')
}

function parsePromptProvider(value: string): PromptCliProvider {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'claude' || normalized === 'gemini') {
    return normalized
  }
  throw new UsageError('error: --provider must be one of claude, gemini')
}

function validateCliText(field: string, value: string): string {
  if (value.length > MAX_CLI_LABEL_LENGTH) {
    throw new UsageError(`error: ${field} exceeds maximum length of ${MAX_CLI_LABEL_LENGTH} characters`)
  }
  return value
}

function validateCliQuestionText(field: string, value: string): string {
  if (value.length > MAX_QUESTION_LENGTH) {
    throw new UsageError(`error: ${field} exceeds maximum length of ${MAX_QUESTION_LENGTH} characters`)
  }
  return value
}

function validateReviewCompareOutputDir(outputDir: string): string {
  return isAbsolute(outputDir) ? resolve(outputDir) : validateGraphOutputPath(outputDir)
}

function parseValidatedGraphPath(flag: string, value: string | undefined): string {
  return validateGraphPath(requireOptionValue(flag, value))
}

function parseGraphPathArgument(flag: string, value: string | undefined): string {
  return validateCliText(flag, requireOptionValue(flag, value))
}

export function parseQueryArgs(args: string[]): QueryCliOptions {
  const question = args[0]?.trim()
  if (!question) {
    throw new UsageError('Usage: madar query "<question>" [--dfs] [--budget N] [--graph path] [--rank-by MODE] [--community ID] [--file-type TYPE]')
  }

  let mode: 'bfs' | 'dfs' = 'bfs'
  let tokenBudget = 2000
  let graphPath = 'out/graph.json'
  let rankBy: QueryRankBy = 'relevance'
  let community: number | null = null
  let fileType: string | null = null

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (argument === '--dfs') {
      mode = 'dfs'
      continue
    }

    if (argument === '--budget') {
      tokenBudget = parseBudget(requireNonEmptyValue('--budget', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--budget=')) {
      const [, value] = argument.split('=', 2)
      tokenBudget = parseBudget(requireNonEmptyValue('--budget', value))
      continue
    }

    if (argument === '--graph') {
      graphPath = requireNonEmptyValue('--graph', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--graph=')) {
      const [, value] = argument.split('=', 2)
      graphPath = requireNonEmptyValue('--graph', value)
      continue
    }

    if (argument === '--rank-by') {
      rankBy = parseQueryRankBy(requireNonEmptyValue('--rank-by', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--rank-by=')) {
      const [, value] = argument.split('=', 2)
      rankBy = parseQueryRankBy(requireNonEmptyValue('--rank-by', value))
      continue
    }

    if (argument === '--community') {
      community = parseNonNegativeInteger('--community', requireNonEmptyValue('--community', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--community=')) {
      const [, value] = argument.split('=', 2)
      community = parseNonNegativeInteger('--community', requireNonEmptyValue('--community', value))
      continue
    }

    if (argument === '--file-type') {
      fileType = validateCliText('--file-type', requireNonEmptyValue('--file-type', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--file-type=')) {
      const [, value] = argument.split('=', 2)
      fileType = validateCliText('--file-type', requireNonEmptyValue('--file-type', value))
      continue
    }

    throw new UsageError(`error: unknown option for query: ${argument}`)
  }

  return { question, mode, tokenBudget, graphPath, rankBy, community, fileType }
}

export function parsePackArgs(args: string[]): PackCliOptions {
  const usage = 'Usage: madar pack "<prompt>" [--budget N] [--task KIND] [--graph path] [--format json|text|markdown|claude|copilot] [--verbose] [--retrieval-level 0-5] [--retrieval-strategy default|slice-v1]'
  const prompt = args[0]?.trim()
  if (!prompt) {
    throw new UsageError(usage)
  }

  let budget = 3000
  let task: ContextPackTaskKind = 'explain'
  let taskExplicit = false
  let graphPath = 'out/graph.json'
  let format: PackCliOptions['format'] | undefined
  let why = false
  let verbose = false
  let retrievalLevel: PackCliOptions['retrievalLevel'] | undefined
  let retrievalStrategy: PackCliOptions['retrievalStrategy'] | undefined

  const normalizedPrompt = validateCliQuestionText('prompt', prompt)

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (!argument.startsWith('--')) {
      throw new UsageError(usage)
    }

    if (argument === '--budget') {
      budget = parseBudget(requireOptionValue('--budget', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--budget=')) {
      const [, value] = argument.split('=', 2)
      budget = parseBudget(requireOptionValue('--budget', value))
      continue
    }

    if (argument === '--task') {
      task = parseContextPackTask(requireOptionValue('--task', args[index + 1]))
      taskExplicit = true
      index += 1
      continue
    }

    if (argument.startsWith('--task=')) {
      const [, value] = argument.split('=', 2)
      task = parseContextPackTask(requireOptionValue('--task', value))
      taskExplicit = true
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

    if (argument === '--format') {
      format = parseContextPackFormat(requireOptionValue('--format', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--format=')) {
      const [, value] = argument.split('=', 2)
      format = parseContextPackFormat(requireOptionValue('--format', value))
      continue
    }

    if (argument === '--retrieval-level') {
      retrievalLevel = parseRetrievalLevel(requireOptionValue('--retrieval-level', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--retrieval-level=')) {
      const [, value] = argument.split('=', 2)
      retrievalLevel = parseRetrievalLevel(requireOptionValue('--retrieval-level', value))
      continue
    }

    if (argument === '--retrieval-strategy') {
      retrievalStrategy = parseRetrievalStrategy(requireOptionValue('--retrieval-strategy', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--retrieval-strategy=')) {
      const [, value] = argument.split('=', 2)
      retrievalStrategy = parseRetrievalStrategy(requireOptionValue('--retrieval-strategy', value))
      continue
    }

    if (argument === '--why') {
      why = true
      continue
    }

    if (argument === '--verbose') {
      verbose = true
      continue
    }

    throw new UsageError(`error: unknown option for pack: ${argument}`)
  }

  return {
    prompt: normalizedPrompt,
    budget,
    task,
    ...(taskExplicit ? { taskExplicit: true } : {}),
    graphPath,
    ...(format ? { format } : {}),
    ...(why ? { why: true } : {}),
    ...(verbose ? { verbose: true } : {}),
    ...(retrievalLevel !== undefined ? { retrievalLevel } : {}),
    ...(retrievalStrategy !== undefined ? { retrievalStrategy } : {}),
  }
}

export function parseHandoffArgs(args: string[]): HandoffCliOptions {
  const usage = 'Usage: madar handoff "<prompt>" [--budget N] [--task KIND] [--graph path] [--consumer generic|codex|cursor|copilot] [--allow-snippets]'
  const prompt = args[0]?.trim()
  if (!prompt) {
    throw new UsageError(usage)
  }

  let budget = 3000
  let task: ContextPackTaskKind = 'explain'
  let graphPath = 'out/graph.json'
  let consumer: HandoffCliOptions['consumer'] = 'generic'
  let allowSnippets = false

  const normalizedPrompt = validateCliQuestionText('prompt', prompt)

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (!argument.startsWith('--')) {
      throw new UsageError(usage)
    }

    if (argument === '--budget') {
      budget = parseBudget(requireOptionValue('--budget', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--budget=')) {
      const [, value] = argument.split('=', 2)
      budget = parseBudget(requireOptionValue('--budget', value))
      continue
    }

    if (argument === '--task') {
      task = parseContextPackTask(requireOptionValue('--task', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--task=')) {
      const [, value] = argument.split('=', 2)
      task = parseContextPackTask(requireOptionValue('--task', value))
      continue
    }

    if (argument === '--graph') {
      graphPath = parseGraphPathArgument('--graph', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--graph=')) {
      const [, value] = argument.split('=', 2)
      graphPath = parseGraphPathArgument('--graph', value)
      continue
    }

    if (argument === '--consumer') {
      consumer = parseHandoffConsumer(requireOptionValue('--consumer', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--consumer=')) {
      const [, value] = argument.split('=', 2)
      consumer = parseHandoffConsumer(requireOptionValue('--consumer', value))
      continue
    }

    if (argument === '--allow-snippets') {
      allowSnippets = true
      continue
    }

    throw new UsageError(`error: unknown option for handoff: ${argument}`)
  }

  return {
    prompt: normalizedPrompt,
    budget,
    task,
    graphPath,
    consumer,
    ...(allowSnippets ? { allowSnippets: true } : {}),
  }
}

function parseContextPackFormat(value: string): PackCliOptions['format'] {
  const normalized = value.trim().toLowerCase()
  if (
    normalized === 'json'
    || normalized === 'text'
    || normalized === 'markdown'
    || normalized === 'claude'
    || normalized === 'copilot'
  ) {
    return normalized as PackCliOptions['format']
  }
  throw new UsageError('error: --format must be one of json, text, markdown, claude, copilot')
}

function parseHandoffConsumer(value: string): HandoffCliOptions['consumer'] {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'generic' || normalized === 'codex' || normalized === 'cursor' || normalized === 'copilot') {
    return normalized as HandoffCliOptions['consumer']
  }
  throw new UsageError('error: --consumer must be one of generic, codex, cursor, copilot')
}

function parseRetrievalLevel(value: string): PackCliOptions['retrievalLevel'] {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 5) {
    throw new UsageError(`error: --retrieval-level must be an integer between 0 and 5 (got ${JSON.stringify(value)})`)
  }
  return parsed as PackCliOptions['retrievalLevel']
}

function parseRetrievalStrategy(value: string): PackCliOptions['retrievalStrategy'] {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'default' || normalized === 'slice-v1') {
    return normalized
  }
  throw new UsageError(`error: --retrieval-strategy must be one of default, slice-v1 (got ${JSON.stringify(value)})`)
}

export function parsePromptArgs(args: string[]): PromptCliOptions {
  const usage = 'Usage: madar prompt "<prompt>" --provider NAME [--graph path]'
  const prompt = args[0]?.trim()
  if (!prompt) {
    throw new UsageError(usage)
  }

  let provider: PromptCliProvider | null = null
  let graphPath = 'out/graph.json'

  const normalizedPrompt = validateCliQuestionText('prompt', prompt)

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (!argument.startsWith('--')) {
      throw new UsageError(usage)
    }

    if (argument === '--provider') {
      provider = parsePromptProvider(requireOptionValue('--provider', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--provider=')) {
      const [, value] = argument.split('=', 2)
      provider = parsePromptProvider(requireOptionValue('--provider', value))
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

    throw new UsageError(`error: unknown option for prompt: ${argument}`)
  }

  if (provider === null) {
    throw new UsageError('error: --provider is required')
  }

  return {
    prompt: normalizedPrompt,
    provider,
    graphPath,
  }
}

export function parsePathArgs(args: string[]): PathCliOptions {
  const source = args[0]?.trim()
  const target = args[1]?.trim()
  if (!source || !target) {
    throw new UsageError('Usage: madar path <source> <target> [--graph path] [--max-hops N]')
  }

  let graphPath = 'out/graph.json'
  let maxHops = 8
  const normalizedSource = validateCliText('source', source)
  const normalizedTarget = validateCliText('target', target)

  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (argument === '--graph') {
      graphPath = requireNonEmptyValue('--graph', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--graph=')) {
      const [, value] = argument.split('=', 2)
      graphPath = requireNonEmptyValue('--graph', value)
      continue
    }

    if (argument === '--max-hops') {
      maxHops = parsePositiveInteger('--max-hops', requireNonEmptyValue('--max-hops', args[index + 1]))
      index += 1
    } else if (argument.startsWith('--max-hops=')) {
      const [, value] = argument.split('=', 2)
      maxHops = parsePositiveInteger('--max-hops', requireNonEmptyValue('--max-hops', value))
    } else {
      throw new UsageError(`error: unknown option for path: ${argument}`)
    }

    if (maxHops > MAX_PATH_HOPS) {
      throw new UsageError(`error: --max-hops must be <= ${MAX_PATH_HOPS}`)
    }
  }

  return { source: normalizedSource, target: normalizedTarget, graphPath, maxHops }
}

export function parseDiffArgs(args: string[]): DiffCliOptions {
  const baselineGraphPath = args[0]?.trim()
  if (!baselineGraphPath) {
    throw new UsageError('Usage: madar diff <baseline-graph.json> [--graph path] [--limit N]')
  }
  if (baselineGraphPath.length > MAX_CLI_PATH_LENGTH) {
    throw new UsageError(`error: baseline graph path exceeds maximum length of ${MAX_CLI_PATH_LENGTH} characters`)
  }

  let graphPath = 'out/graph.json'
  let limit = 10

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (argument === '--graph') {
      graphPath = requireNonEmptyValue('--graph', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--graph=')) {
      const [, value] = argument.split('=', 2)
      graphPath = requireNonEmptyValue('--graph', value)
      continue
    }

    if (argument === '--limit') {
      limit = parsePositiveDecimalInteger('--limit', requireNonEmptyValue('--limit', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--limit=')) {
      const [, value] = argument.split('=', 2)
      limit = parsePositiveDecimalInteger('--limit', requireNonEmptyValue('--limit', value))
      continue
    }

    throw new UsageError(`error: unknown option for diff: ${argument}`)
  }

  return { baselineGraphPath, graphPath, limit }
}

export function parseExplainArgs(args: string[]): ExplainCliOptions {
  const label = args[0]?.trim()
  if (!label) {
    throw new UsageError('Usage: madar explain <label> [--graph path] [--relation REL]')
  }

  let graphPath = 'out/graph.json'
  let relation = ''
  const normalizedLabel = validateCliText('label', label)

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (argument === '--graph') {
      graphPath = requireNonEmptyValue('--graph', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--graph=')) {
      const [, value] = argument.split('=', 2)
      graphPath = requireNonEmptyValue('--graph', value)
      continue
    }

    if (argument === '--relation') {
      relation = validateCliText('--relation', requireNonEmptyValue('--relation', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--relation=')) {
      const [, value] = argument.split('=', 2)
      relation = validateCliText('--relation', requireNonEmptyValue('--relation', value))
      continue
    }

    throw new UsageError(`error: unknown option for explain: ${argument}`)
  }

  return { label: normalizedLabel, graphPath, relation }
}

export function parseAddArgs(args: string[]): AddCliOptions {
  const url = args[0]?.trim()
  if (!url) {
    throw new UsageError('Usage: madar add <url> [path] [--follow-symlinks] [--no-html]')
  }

  let path = '.'
  let followSymlinks = false
  let noHtml = false

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (!argument.startsWith('--')) {
      if (path !== '.') {
        throw new UsageError('Usage: madar add <url> [path] [--follow-symlinks] [--no-html]')
      }
      path = argument
      continue
    }

    if (argument === '--follow-symlinks') {
      followSymlinks = true
      continue
    }

    if (argument === '--no-html') {
      noHtml = true
      continue
    }

    throw new UsageError(`error: unknown option for add: ${argument}`)
  }

  return { url, path, followSymlinks, noHtml }
}

export function parseSaveResultArgs(args: string[]): SaveResultCliOptions {
  let question = ''
  let answer = ''
  let queryType = 'query'
  let memoryDir = 'out/memory'
  const sourceNodes: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (argument === '--question') {
      question = requireNonEmptyValue('--question', args[index + 1])
      index += 1
      continue
    }

    if (argument === '--answer') {
      answer = requireNonEmptyValue('--answer', args[index + 1])
      index += 1
      continue
    }

    if (argument === '--type') {
      queryType = requireNonEmptyValue('--type', args[index + 1])
      index += 1
      continue
    }

    if (argument === '--memory-dir') {
      memoryDir = requireNonEmptyValue('--memory-dir', args[index + 1])
      index += 1
      continue
    }

    if (argument === '--nodes') {
      let cursor = index + 1
      while (cursor < args.length && !String(args[cursor]).startsWith('--')) {
        const value = args[cursor]?.trim()
        if (value) {
          if (sourceNodes.length >= MAX_CLI_SOURCE_NODES) {
            throw new UsageError(`error: --nodes is limited to ${MAX_CLI_SOURCE_NODES} items`)
          }
          sourceNodes.push(value)
        }
        cursor += 1
      }
      index = cursor - 1
      continue
    }

    throw new UsageError(`error: unknown option for save-result: ${argument}`)
  }

  if (question.trim().length === 0 || answer.trim().length === 0) {
    throw new UsageError('Usage: madar save-result --question Q --answer A [--type T] [--nodes N1 N2 ...] [--memory-dir DIR]')
  }

  if (question.length > MAX_QUESTION_LENGTH) {
    throw new UsageError(`error: --question exceeds maximum length of ${MAX_QUESTION_LENGTH} characters`)
  }
  if (answer.length > MAX_ANSWER_LENGTH) {
    throw new UsageError(`error: --answer exceeds maximum length of ${MAX_ANSWER_LENGTH} characters`)
  }

  memoryDir = validateGraphOutputPath(memoryDir)

  return { question, answer, queryType, sourceNodes, memoryDir }
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

  return { repo, task, mode, trials, outputDir, execTemplate, dryRun, yes }
}

export function parseCompareArgs(args: string[]): CompareCliOptions {
  let question: string | null = null
  let graphPath = 'out/graph.json'
  let execTemplate = ''
  let questionsPath: string | null = null
  let outputDir = 'out/compare'
  let task: 'explain' | 'implement' = 'explain'
  let baselineMode: 'full' | 'bounded' | 'pack_only' | 'native_agent' = 'full'
  let perArmTimeoutSeconds = 600
  let heartbeatIntervalMs = 30000
  let strictMadarFirst = false
  let strictBenchmarkReadiness = false
  let allowNoInstall = false
  let yes = false
  let limit: number | null = null
  let why = false

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

    if (argument === '--questions') {
      questionsPath = requireOptionValue('--questions', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--questions=')) {
      const [, value] = argument.split('=', 2)
      questionsPath = requireOptionValue('--questions', value)
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

    if (argument === '--task') {
      task = parseCompareTask(requireOptionValue('--task', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--task=')) {
      const [, value] = argument.split('=', 2)
      task = parseCompareTask(requireOptionValue('--task', value))
      continue
    }

    if (argument === '--baseline-mode') {
      baselineMode = parseCompareBaselineMode(requireOptionValue('--baseline-mode', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--baseline-mode=')) {
      const [, value] = argument.split('=', 2)
      baselineMode = parseCompareBaselineMode(requireOptionValue('--baseline-mode', value))
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

    if (argument === '--heartbeat-interval-ms') {
      heartbeatIntervalMs = parseNonNegativeInteger('--heartbeat-interval-ms', requireOptionValue('--heartbeat-interval-ms', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--heartbeat-interval-ms=')) {
      const [, value] = argument.split('=', 2)
      heartbeatIntervalMs = parseNonNegativeInteger('--heartbeat-interval-ms', requireOptionValue('--heartbeat-interval-ms', value))
      continue
    }

    if (argument === '--yes') {
      yes = true
      continue
    }

    if (argument === '--strict-madar-first') {
      strictMadarFirst = true
      continue
    }

    if (argument === '--strict' || argument === '--strict-benchmark-readiness') {
      strictBenchmarkReadiness = true
      continue
    }

    if (argument === '--allow-no-install') {
      allowNoInstall = true
      continue
    }

    if (argument === '--limit') {
      limit = parsePositiveDecimalInteger('--limit', requireOptionValue('--limit', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--limit=')) {
      const [, value] = argument.split('=', 2)
      limit = parsePositiveDecimalInteger('--limit', requireOptionValue('--limit', value))
      continue
    }

    if (argument === '--why') {
      why = true
      continue
    }

    throw new UsageError(`error: unknown option for compare: ${argument}`)
  }

  if (question !== null && questionsPath !== null) {
    throw new UsageError('error: compare accepts either a positional question or --questions, but not both')
  }

  if (question === null && questionsPath === null) {
    throw new UsageError(COMPARE_USAGE)
  }

  if (execTemplate.length === 0) {
    throw new UsageError('error: --exec is required')
  }

  outputDir = validateGraphOutputPath(outputDir)

  return {
    question,
    graphPath,
    execTemplate,
    questionsPath,
    outputDir,
    task,
    baselineMode,
    perArmTimeoutSeconds,
    heartbeatIntervalMs,
    strictMadarFirst,
    strictBenchmarkReadiness,
    allowNoInstall,
    yes,
    limit,
    ...(why ? { why: true } : {}),
  }
}

export function parseReviewCompareArgs(args: string[]): ReviewCompareCliOptions {
  const usage = 'Usage: madar review-compare [graph.json] --exec TEMPLATE [--output-dir DIR] [--base-branch BRANCH] [--budget N] [--yes]'
  let graphPath = 'out/graph.json'
  let execTemplate = ''
  let outputDir = 'out/review-compare'
  let baseBranch: string | null = null
  let budget: number | null = null
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

    if (argument === '--base-branch') {
      baseBranch = validateCliText('--base-branch', requireOptionValue('--base-branch', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--base-branch=')) {
      const [, value] = argument.split('=', 2)
      baseBranch = validateCliText('--base-branch', requireOptionValue('--base-branch', value))
      continue
    }

    if (argument === '--budget') {
      budget = parseBudget(requireOptionValue('--budget', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--budget=')) {
      const [, value] = argument.split('=', 2)
      budget = parseBudget(requireOptionValue('--budget', value))
      continue
    }

    if (argument === '--yes') {
      yes = true
      continue
    }

    throw new UsageError(`error: unknown option for review-compare: ${argument}`)
  }

  if (execTemplate.length === 0) {
    throw new UsageError('error: --exec is required')
  }

  return {
    graphPath,
    execTemplate,
    outputDir: validateReviewCompareOutputDir(outputDir),
    baseBranch,
    budget,
    yes,
  }
}

export function parseTimeTravelArgs(args: string[]): TimeTravelCliOptions {
  const usage = 'Usage: madar time-travel <from> <to> [--view MODE] [--json] [--refresh] [--limit N]'
  let fromRef: string | null = null
  let toRef: string | null = null
  let view: 'summary' | 'risk' | 'drift' | 'timeline' = 'summary'
  let json = false
  let refresh = false
  let limit = 10

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (!argument.startsWith('--')) {
      if (fromRef === null) {
        fromRef = argument.trim()
        continue
      }
      if (toRef === null) {
        toRef = argument.trim()
        continue
      }
      throw new UsageError(usage)
    }

    if (argument === '--view') {
      view = parseTimeTravelView(requireOptionValue('--view', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--view=')) {
      const [, value] = argument.split('=', 2)
      view = parseTimeTravelView(requireOptionValue('--view', value))
      continue
    }

    if (argument === '--json') {
      json = true
      continue
    }

    if (argument === '--refresh') {
      refresh = true
      continue
    }

    if (argument === '--limit') {
      limit = parsePositiveDecimalInteger('--limit', requireOptionValue('--limit', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--limit=')) {
      const [, value] = argument.split('=', 2)
      limit = parsePositiveDecimalInteger('--limit', requireOptionValue('--limit', value))
      continue
    }

    throw new UsageError(`error: unknown option for time-travel: ${argument}`)
  }

  if (fromRef === null || fromRef.length === 0 || toRef === null || toRef.length === 0) {
    throw new UsageError(usage)
  }

  return { fromRef, toRef, view, json, refresh, limit }
}

export function parseGenerateArgs(args: string[]): GenerateCliOptions {
  let path = '.'
  let update = false
  let clusterOnly = false
  let watch = false
  let directed = false
  let followSymlinks = false
  let debounceSeconds = 3
  let noHtml = false
  let wiki = false
  let obsidian = false
  let obsidianDir: string | null = null
  let svg = false
  let graphml = false
  let neo4j = false
  let neo4jPushUri: string | null = null
  let neo4jUser: string | null = null
  let neo4jPassword: string | null = null
  let neo4jDatabase: string | null = null
  let includeDocs = false
  let docs = false
  let useSpi = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (argument === '--spi') {
      useSpi = true
      continue
    }

    if (!argument.startsWith('--')) {
      if (path !== '.') {
        throw new UsageError(
          'Usage: madar generate [path] [--update] [--cluster-only] [--watch] [--directed] [--follow-symlinks] [--debounce S] [--no-html] [--wiki] [--obsidian] [--obsidian-dir DIR] [--svg] [--graphml] [--neo4j] [--neo4j-push URI] [--neo4j-user USER] [--neo4j-password PW] [--neo4j-database DB] [--spi]',
        )
      }
      path = argument
      continue
    }

    if (argument === '--update') {
      update = true
      continue
    }

    if (argument === '--cluster-only') {
      clusterOnly = true
      continue
    }

    if (argument === '--watch') {
      watch = true
      continue
    }

    if (argument === '--directed') {
      directed = true
      continue
    }

    if (argument === '--follow-symlinks') {
      followSymlinks = true
      continue
    }

    if (argument === '--no-html') {
      noHtml = true
      continue
    }

    if (argument === '--wiki') {
      wiki = true
      continue
    }

    if (argument === '--obsidian') {
      obsidian = true
      continue
    }

    if (argument === '--graphml') {
      graphml = true
      continue
    }

    if (argument === '--svg') {
      svg = true
      continue
    }

    if (argument === '--neo4j') {
      neo4j = true
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

    if (argument === '--obsidian-dir') {
      obsidianDir = requireNonEmptyValue('--obsidian-dir', args[index + 1])
      obsidian = true
      index += 1
      continue
    }

    if (argument.startsWith('--obsidian-dir=')) {
      const [, value] = argument.split('=', 2)
      obsidianDir = requireNonEmptyValue('--obsidian-dir', value)
      obsidian = true
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

    if (argument === '--include-docs') {
      includeDocs = true
      continue
    }

    if (argument === '--docs') {
      docs = true
      continue
    }

    throw new UsageError(`error: unknown option for generate: ${argument}`)
  }

  if (update && clusterOnly) {
    throw new UsageError('error: --update and --cluster-only cannot be used together')
  }

  return {
    path,
    update,
    clusterOnly,
    watch,
    directed,
    followSymlinks,
    debounceSeconds,
    noHtml,
    wiki,
    obsidian,
    obsidianDir,
    svg,
    graphml,
    neo4j,
    neo4jPushUri,
    neo4jUser,
    neo4jPassword,
    neo4jDatabase,
    includeDocs,
    docs,
    useSpi,
  }
}

export function parseWatchArgs(args: string[]): WatchCliOptions {
  let path = '.'
  let followSymlinks = false
  let debounceSeconds = 3
  let noHtml = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (!argument.startsWith('--')) {
      if (path !== '.') {
        throw new UsageError('Usage: madar watch [path] [--follow-symlinks] [--debounce S] [--no-html]')
      }
      path = argument
      continue
    }

    if (argument === '--follow-symlinks') {
      followSymlinks = true
      continue
    }

    if (argument === '--no-html') {
      noHtml = true
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

  return { path, followSymlinks, debounceSeconds, noHtml }
}

export function parseServeArgs(args: string[]): ServeCliOptions {
  let graphPath = 'out/graph.json'
  let host = '127.0.0.1'
  let port = 4173
  let transport: 'http' | 'stdio' = 'http'

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (!argument.startsWith('--')) {
      if (graphPath !== 'out/graph.json') {
        throw new UsageError('Usage: madar serve [graph.json] [--host H] [--port N] [--transport http|stdio] [--http|--stdio|--mcp]')
      }
      graphPath = argument
      continue
    }

    if (argument === '--http') {
      transport = 'http'
      continue
    }

    if (argument === '--stdio' || argument === '--mcp') {
      transport = 'stdio'
      continue
    }

    if (argument === '--transport') {
      transport = parseServeTransport('--transport', requireNonEmptyValue('--transport', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--transport=')) {
      const [, value] = argument.split('=', 2)
      transport = parseServeTransport('--transport', requireNonEmptyValue('--transport', value))
      continue
    }

    if (argument === '--host') {
      host = requireNonEmptyValue('--host', args[index + 1])
      index += 1
      continue
    }

    if (argument.startsWith('--host=')) {
      const [, value] = argument.split('=', 2)
      host = requireNonEmptyValue('--host', value)
      continue
    }

    if (argument === '--port') {
      port = parsePort('--port', requireNonEmptyValue('--port', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--port=')) {
      const [, value] = argument.split('=', 2)
      port = parsePort('--port', requireNonEmptyValue('--port', value))
      continue
    }

    throw new UsageError(`error: unknown option for serve: ${argument}`)
  }

  return { graphPath, host, port, transport }
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

export function parseSummaryArgs(args: string[]): SummaryCliOptions {
  const usage = 'Usage: madar summary [graph.json]'
  let graphPath = 'out/graph.json'

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
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

    if (argument.startsWith('--')) {
      throw new UsageError(`error: unknown option for summary: ${argument}`)
    }

    if (graphPath !== 'out/graph.json') {
      throw new UsageError(usage)
    }

    graphPath = argument
  }

  return { graphPath }
}

export function parseProofReportArgs(args: string[]): ProofReportCliOptions {
  const usage = 'Usage: madar proof-report [graph.json] [--output-dir DIR] [--compare-dir DIR] [--pack PATH]'
  let graphPath = 'out/graph.json'
  let outputDir: string | null = null
  let compareDir: string | null = null
  let packPath: string | null = null

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (argument === '--output-dir') {
      outputDir = validateGraphOutputPath(requireOptionValue('--output-dir', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--output-dir=')) {
      const [, value] = argument.split('=', 2)
      outputDir = validateGraphOutputPath(requireOptionValue('--output-dir', value))
      continue
    }

    if (argument === '--compare-dir') {
      compareDir = validateGraphOutputPath(requireOptionValue('--compare-dir', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--compare-dir=')) {
      const [, value] = argument.split('=', 2)
      compareDir = validateGraphOutputPath(requireOptionValue('--compare-dir', value))
      continue
    }

    if (argument === '--pack') {
      packPath = validateGraphOutputPath(requireOptionValue('--pack', args[index + 1]))
      index += 1
      continue
    }

    if (argument.startsWith('--pack=')) {
      const [, value] = argument.split('=', 2)
      packPath = validateGraphOutputPath(requireOptionValue('--pack', value))
      continue
    }

    if (argument.startsWith('--')) {
      throw new UsageError(`error: unknown option for proof-report: ${argument}`)
    }

    if (graphPath !== 'out/graph.json') {
      throw new UsageError(usage)
    }

    graphPath = argument
  }

  const graphBase = dirname(resolve(graphPath))
  return {
    graphPath,
    outputDir: outputDir ?? resolve(graphBase, 'proof-report'),
    compareDir: compareDir ?? resolve(graphBase, 'compare'),
    packPath,
  }
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

export function parseInstallArgs(args: string[], defaultPlatform: InstallPlatform): InstallCliOptions {
  let platform = defaultPlatform

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (argument === '--platform') {
      const value = requireNonEmptyValue('--platform', args[index + 1])
      if (!isInstallPlatform(value)) {
        throw new UsageError(`error: unknown platform '${value}'`)
      }
      platform = value
      index += 1
      continue
    }

    if (argument.startsWith('--platform=')) {
      const [, value] = argument.split('=', 2)
      const normalizedValue = requireNonEmptyValue('--platform', value)
      if (!isInstallPlatform(normalizedValue)) {
        throw new UsageError(`error: unknown platform '${normalizedValue}'`)
      }
      platform = normalizedValue
      continue
    }

    throw new UsageError('Usage: madar install [--platform P]')
  }

  return { platform }
}

export function parsePlatformActionArgs(command: string, args: string[]): PlatformActionCliOptions {
  const action = args[0]
  const profileAware = PROFILE_AWARE_PLATFORM_COMMANDS.has(command)
  const usage = profileAware
    ? `Usage: madar ${command} <install|uninstall> [--profile core|full|strict]`
    : `Usage: madar ${command} <install|uninstall>`
  if (action !== 'install' && action !== 'uninstall') {
    throw new UsageError(usage)
  }

  if (action === 'uninstall') {
    if (args.length === 1) {
      return { action }
    }
    throw new UsageError(usage)
  }

  let profile: InstallProfile | undefined
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }
    if (!profileAware) {
      throw new UsageError(usage)
    }

    if (argument === '--profile') {
      const value = requireNonEmptyValue('--profile', args[index + 1])
      if (!isInstallProfile(value)) {
        throw new UsageError('error: --profile must be one of core, full, strict')
      }
      profile = value
      index += 1
      continue
    }

    if (argument.startsWith('--profile=')) {
      const [, value] = argument.split('=', 2)
      const normalizedValue = requireNonEmptyValue('--profile', value)
      if (!isInstallProfile(normalizedValue)) {
        throw new UsageError('error: --profile must be one of core, full, strict')
      }
      profile = normalizedValue
      continue
    }

    throw new UsageError(usage)
  }

  return profile ? { action, profile } : { action }
}
