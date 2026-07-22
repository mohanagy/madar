import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export type TelemetryCommand =
  | 'install'
  | 'generate'
  | 'pack'
  | 'prompt'
  | 'context_pack'
  | 'doctor'
  | 'status'
  | 'compare'

export type TelemetryStage = 'started' | 'succeeded' | 'failed'
export type TelemetryRepoSizeBucket = '1-24' | '25-99' | '100-499' | '500-999' | '1000+'
export type TelemetryGraphSizeBucket = '1-99' | '100-499' | '500-999' | '1000-4999' | '5000+'
export type TelemetryFailureBucket =
  | 'usage_error'
  | 'invalid_params'
  | 'missing_graph'
  | 'stale_graph'
  | 'stale_context'
  | 'tool_profile'
  | 'unsupported_corpus'
  | 'install_error'
  | 'unknown'
export type TelemetryStatusBucket = 'healthy' | 'attention_needed'
export type TelemetryAnswerabilityBucket = 'ready' | 'ready_with_caveat' | 'verify_targets' | 'insufficient'
export type TelemetryRecoveryAttemptsBucket = '0' | '1' | '2'
export type TelemetryRecoveryImprovementBucket = 'not_attempted' | 'improved' | 'unchanged'
export type TelemetryBroadSearchFallbackBucket = 'not_needed' | 'targeted_only' | 'allowed' | 'blocked'
export type TelemetryAgentTarget =
  | 'claude'
  | 'cursor'
  | 'codex'
  | 'copilot'
  | 'gemini'
  | 'aider'
  | 'opencode'
  | 'windows'
  | 'claw'
  | 'droid'
  | 'trae'
  | 'trae-cn'

export interface TelemetryEventInput {
  command: TelemetryCommand
  stage: TelemetryStage
  version: string
  os: NodeJS.Platform
  nodeMajor: number
  repoSizeBucket?: TelemetryRepoSizeBucket
  graphSizeBucket?: TelemetryGraphSizeBucket
  agentTarget?: TelemetryAgentTarget
  failureBucket?: TelemetryFailureBucket
  statusBucket?: TelemetryStatusBucket
  initialAnswerabilityBucket?: TelemetryAnswerabilityBucket
  recoveryAttemptsBucket?: TelemetryRecoveryAttemptsBucket
  recoveryImprovementBucket?: TelemetryRecoveryImprovementBucket
  finalAnswerabilityBucket?: TelemetryAnswerabilityBucket
  broadSearchFallbackBucket?: TelemetryBroadSearchFallbackBucket
}

export interface TelemetryOptions {
  configRoot?: string
  cacheRoot?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  maxEvents?: number
}

export interface TelemetryStatus {
  enabled: boolean
  reason: string
  configFile: string
  spoolFile: string
  eventCount: number
}

interface TelemetryConfig {
  schema_version: 1
  enabled: boolean
  updated_at: number
}

interface LegacyPersistedTelemetryEvent {
  event: 'install_success' | 'generate_success' | 'pack_success' | 'compare_success'
  recorded_at: string
  version: string
  os: NodeJS.Platform
  repo_size_bucket?: TelemetryRepoSizeBucket
  install_platform?: string
}

interface PersistedTelemetryEvent {
  command: TelemetryCommand
  stage: TelemetryStage
  recorded_at: string
  version: string
  os: NodeJS.Platform
  node_major?: number
  repo_size_bucket?: TelemetryRepoSizeBucket
  graph_size_bucket?: TelemetryGraphSizeBucket
  agent_target?: TelemetryAgentTarget
  failure_bucket?: TelemetryFailureBucket
  status_bucket?: TelemetryStatusBucket
  initial_answerability_bucket?: TelemetryAnswerabilityBucket
  recovery_attempts_bucket?: TelemetryRecoveryAttemptsBucket
  recovery_improvement_bucket?: TelemetryRecoveryImprovementBucket
  final_answerability_bucket?: TelemetryAnswerabilityBucket
  broad_search_fallback_bucket?: TelemetryBroadSearchFallbackBucket
}

interface LegacyTelemetrySpool {
  schema_version: 1
  events: LegacyPersistedTelemetryEvent[]
}

interface TelemetrySpool {
  schema_version: 2
  events: PersistedTelemetryEvent[]
}

const DEFAULT_MAX_EVENTS = 200
const LOCK_RETRY_DELAY_MS = 10
const LOCK_TIMEOUT_MS = 1_000

const TELEMETRY_COMMANDS: readonly TelemetryCommand[] = [
  'install',
  'generate',
  'pack',
  'prompt',
  'context_pack',
  'doctor',
  'status',
  'compare',
]
const TELEMETRY_STAGES: readonly TelemetryStage[] = ['started', 'succeeded', 'failed']
const TELEMETRY_REPO_SIZE_BUCKETS: readonly TelemetryRepoSizeBucket[] = ['1-24', '25-99', '100-499', '500-999', '1000+']
const TELEMETRY_GRAPH_SIZE_BUCKETS: readonly TelemetryGraphSizeBucket[] = ['1-99', '100-499', '500-999', '1000-4999', '5000+']
const TELEMETRY_FAILURE_BUCKETS: readonly TelemetryFailureBucket[] = [
  'usage_error',
  'invalid_params',
  'missing_graph',
  'stale_graph',
  'stale_context',
  'tool_profile',
  'unsupported_corpus',
  'install_error',
  'unknown',
]
const TELEMETRY_STATUS_BUCKETS: readonly TelemetryStatusBucket[] = ['healthy', 'attention_needed']
const TELEMETRY_ANSWERABILITY_BUCKETS: readonly TelemetryAnswerabilityBucket[] = ['ready', 'ready_with_caveat', 'verify_targets', 'insufficient']
const TELEMETRY_RECOVERY_ATTEMPTS_BUCKETS: readonly TelemetryRecoveryAttemptsBucket[] = ['0', '1', '2']
const TELEMETRY_RECOVERY_IMPROVEMENT_BUCKETS: readonly TelemetryRecoveryImprovementBucket[] = ['not_attempted', 'improved', 'unchanged']
const TELEMETRY_BROAD_SEARCH_FALLBACK_BUCKETS: readonly TelemetryBroadSearchFallbackBucket[] = ['not_needed', 'targeted_only', 'allowed', 'blocked']
const TELEMETRY_AGENT_TARGETS: readonly TelemetryAgentTarget[] = [
  'claude',
  'cursor',
  'codex',
  'copilot',
  'gemini',
  'aider',
  'opencode',
  'windows',
  'claw',
  'droid',
  'trae',
  'trae-cn',
]

function defaultConfigRoot(env: NodeJS.ProcessEnv): string {
  if (typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim().length > 0) {
    return env.XDG_CONFIG_HOME
  }

  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support')
  }

  if (platform() === 'win32') {
    if (typeof env.APPDATA === 'string' && env.APPDATA.trim().length > 0) {
      return env.APPDATA
    }
    return join(homedir(), 'AppData', 'Roaming')
  }

  return join(homedir(), '.config')
}

function defaultCacheRoot(env: NodeJS.ProcessEnv): string {
  if (typeof env.XDG_CACHE_HOME === 'string' && env.XDG_CACHE_HOME.trim().length > 0) {
    return env.XDG_CACHE_HOME
  }

  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Caches')
  }

  if (platform() === 'win32') {
    if (typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim().length > 0) {
      return env.LOCALAPPDATA
    }
    return join(homedir(), 'AppData', 'Local')
  }

  return join(homedir(), '.cache')
}

function telemetryConfigFilePath(configRoot: string): string {
  return join(configRoot, 'madar', 'telemetry.json')
}

function telemetrySpoolFilePath(cacheRoot: string): string {
  return join(cacheRoot, 'madar', 'telemetry-events.json')
}

function parseConfig(text: string): TelemetryConfig | null {
  try {
    const parsed = JSON.parse(text) as Partial<TelemetryConfig>
    if (parsed.schema_version !== 1 || typeof parsed.enabled !== 'boolean' || typeof parsed.updated_at !== 'number') {
      return null
    }
    return {
      schema_version: 1,
      enabled: parsed.enabled,
      updated_at: parsed.updated_at,
    }
  } catch {
    return null
  }
}

function loadConfig(configFile: string): TelemetryConfig | null {
  if (!existsSync(configFile)) {
    return null
  }
  return parseConfig(readFileSync(configFile, 'utf8'))
}

function isTelemetryCommand(value: unknown): value is TelemetryCommand {
  return typeof value === 'string' && TELEMETRY_COMMANDS.includes(value as TelemetryCommand)
}

function isTelemetryStage(value: unknown): value is TelemetryStage {
  return typeof value === 'string' && TELEMETRY_STAGES.includes(value as TelemetryStage)
}

function isTelemetryRepoSizeBucket(value: unknown): value is TelemetryRepoSizeBucket {
  return typeof value === 'string' && TELEMETRY_REPO_SIZE_BUCKETS.includes(value as TelemetryRepoSizeBucket)
}

function isTelemetryGraphSizeBucket(value: unknown): value is TelemetryGraphSizeBucket {
  return typeof value === 'string' && TELEMETRY_GRAPH_SIZE_BUCKETS.includes(value as TelemetryGraphSizeBucket)
}

function isTelemetryFailureBucket(value: unknown): value is TelemetryFailureBucket {
  return typeof value === 'string' && TELEMETRY_FAILURE_BUCKETS.includes(value as TelemetryFailureBucket)
}

function isTelemetryStatusBucket(value: unknown): value is TelemetryStatusBucket {
  return typeof value === 'string' && TELEMETRY_STATUS_BUCKETS.includes(value as TelemetryStatusBucket)
}

function isTelemetryAnswerabilityBucket(value: unknown): value is TelemetryAnswerabilityBucket {
  return typeof value === 'string' && TELEMETRY_ANSWERABILITY_BUCKETS.includes(value as TelemetryAnswerabilityBucket)
}

function isTelemetryRecoveryAttemptsBucket(value: unknown): value is TelemetryRecoveryAttemptsBucket {
  return typeof value === 'string' && TELEMETRY_RECOVERY_ATTEMPTS_BUCKETS.includes(value as TelemetryRecoveryAttemptsBucket)
}

function isTelemetryRecoveryImprovementBucket(value: unknown): value is TelemetryRecoveryImprovementBucket {
  return typeof value === 'string' && TELEMETRY_RECOVERY_IMPROVEMENT_BUCKETS.includes(value as TelemetryRecoveryImprovementBucket)
}

function isTelemetryBroadSearchFallbackBucket(value: unknown): value is TelemetryBroadSearchFallbackBucket {
  return typeof value === 'string' && TELEMETRY_BROAD_SEARCH_FALLBACK_BUCKETS.includes(value as TelemetryBroadSearchFallbackBucket)
}

function isTelemetryAgentTarget(value: unknown): value is TelemetryAgentTarget {
  return typeof value === 'string' && TELEMETRY_AGENT_TARGETS.includes(value as TelemetryAgentTarget)
}

function normalizeTelemetryEvent(record: Partial<PersistedTelemetryEvent>): PersistedTelemetryEvent | null {
  if (!isTelemetryCommand(record.command) || !isTelemetryStage(record.stage)) {
    return null
  }
  if (typeof record.recorded_at !== 'string' || record.recorded_at.length === 0) {
    return null
  }
  if (typeof record.version !== 'string' || record.version.length === 0) {
    return null
  }
  if (typeof record.os !== 'string') {
    return null
  }

  const normalized: PersistedTelemetryEvent = {
    command: record.command,
    stage: record.stage,
    recorded_at: record.recorded_at,
    version: record.version,
    os: record.os,
  }

  if (typeof record.node_major === 'number' && Number.isInteger(record.node_major) && record.node_major > 0) {
    normalized.node_major = record.node_major
  }
  if (isTelemetryRepoSizeBucket(record.repo_size_bucket)) {
    normalized.repo_size_bucket = record.repo_size_bucket
  }
  if (isTelemetryGraphSizeBucket(record.graph_size_bucket)) {
    normalized.graph_size_bucket = record.graph_size_bucket
  }
  if (isTelemetryAgentTarget(record.agent_target)) {
    normalized.agent_target = record.agent_target
  }
  if (isTelemetryFailureBucket(record.failure_bucket)) {
    normalized.failure_bucket = record.failure_bucket
  }
  if (isTelemetryStatusBucket(record.status_bucket)) {
    normalized.status_bucket = record.status_bucket
  }
  if (isTelemetryAnswerabilityBucket(record.initial_answerability_bucket)) {
    normalized.initial_answerability_bucket = record.initial_answerability_bucket
  }
  if (isTelemetryRecoveryAttemptsBucket(record.recovery_attempts_bucket)) {
    normalized.recovery_attempts_bucket = record.recovery_attempts_bucket
  }
  if (isTelemetryRecoveryImprovementBucket(record.recovery_improvement_bucket)) {
    normalized.recovery_improvement_bucket = record.recovery_improvement_bucket
  }
  if (isTelemetryAnswerabilityBucket(record.final_answerability_bucket)) {
    normalized.final_answerability_bucket = record.final_answerability_bucket
  }
  if (isTelemetryBroadSearchFallbackBucket(record.broad_search_fallback_bucket)) {
    normalized.broad_search_fallback_bucket = record.broad_search_fallback_bucket
  }

  return normalized
}

function migrateLegacyEvent(record: Partial<LegacyPersistedTelemetryEvent>): PersistedTelemetryEvent | null {
  if (typeof record.recorded_at !== 'string' || record.recorded_at.length === 0) {
    return null
  }
  if (typeof record.version !== 'string' || record.version.length === 0) {
    return null
  }
  if (typeof record.os !== 'string') {
    return null
  }

  const base: PersistedTelemetryEvent = {
    command: 'generate',
    stage: 'succeeded',
    recorded_at: record.recorded_at,
    version: record.version,
    os: record.os,
  }

  switch (record.event) {
    case 'install_success':
      base.command = 'install'
      if (isTelemetryAgentTarget(record.install_platform)) {
        base.agent_target = record.install_platform
      }
      return base
    case 'generate_success':
      base.command = 'generate'
      if (isTelemetryRepoSizeBucket(record.repo_size_bucket)) {
        base.repo_size_bucket = record.repo_size_bucket
      }
      return base
    case 'pack_success':
      base.command = 'pack'
      if (isTelemetryRepoSizeBucket(record.repo_size_bucket)) {
        base.repo_size_bucket = record.repo_size_bucket
      }
      return base
    case 'compare_success':
      base.command = 'compare'
      if (isTelemetryRepoSizeBucket(record.repo_size_bucket)) {
        base.repo_size_bucket = record.repo_size_bucket
      }
      return base
    default:
      return null
  }
}

function parseSpool(text: string): TelemetrySpool | null {
  try {
    const parsed = JSON.parse(text) as { schema_version?: unknown; events?: unknown }
    if (parsed.schema_version === 1 && Array.isArray(parsed.events)) {
      return {
        schema_version: 2,
        events: parsed.events
          .filter((event: unknown): event is LegacyPersistedTelemetryEvent => typeof event === 'object' && event !== null)
          .map((event) => migrateLegacyEvent(event))
          .filter((event): event is PersistedTelemetryEvent => event !== null),
      }
    }
    if (parsed.schema_version !== 2 || !Array.isArray(parsed.events)) {
      return null
    }
    return {
      schema_version: 2,
      events: parsed.events
        .filter((event: unknown): event is PersistedTelemetryEvent => typeof event === 'object' && event !== null)
        .map((event) => normalizeTelemetryEvent(event))
        .filter((event): event is PersistedTelemetryEvent => event !== null),
    }
  } catch {
    return null
  }
}

function loadSpool(spoolFile: string): TelemetrySpool {
  if (!existsSync(spoolFile)) {
    return { schema_version: 2, events: [] }
  }
  return parseSpool(readFileSync(spoolFile, 'utf8')) ?? { schema_version: 2, events: [] }
}

function uniqueTempPath(targetPath: string): string {
  return `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
}

function sleepMs(durationMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs)
}

function withExclusiveLock<T>(targetPath: string, action: () => T): T {
  const lockPath = `${targetPath}.lock`
  const start = Date.now()
  mkdirSync(dirname(lockPath), { recursive: true })

  while (true) {
    try {
      const lockFd = openSync(lockPath, 'wx')
      try {
        return action()
      } finally {
        closeSync(lockFd)
        rmSync(lockPath, { force: true })
      }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
        throw error
      }
      if (Date.now() - start >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for telemetry lock at ${lockPath}`)
      }
      sleepMs(LOCK_RETRY_DELAY_MS)
    }
  }
}

function writeJsonAtomic(targetPath: string, value: unknown): void {
  mkdirSync(dirname(targetPath), { recursive: true })
  const tempPath = uniqueTempPath(targetPath)
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2))
    renameSync(tempPath, targetPath)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
}

function summarizeCounts(values: string[]): string[] {
  const counts = new Map<string, number>()
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([leftLabel, leftCount], [rightLabel, rightCount]) => rightCount - leftCount || leftLabel.localeCompare(rightLabel))
    .map(([label, count]) => `- ${label} ${count}`)
}

export function repoSizeBucketFromFileCount(fileCount: number): TelemetryRepoSizeBucket {
  if (fileCount <= 24) {
    return '1-24'
  }
  if (fileCount <= 99) {
    return '25-99'
  }
  if (fileCount <= 499) {
    return '100-499'
  }
  if (fileCount <= 999) {
    return '500-999'
  }
  return '1000+'
}

export function graphSizeBucketFromNodeCount(nodeCount: number): TelemetryGraphSizeBucket {
  if (nodeCount <= 99) {
    return '1-99'
  }
  if (nodeCount <= 499) {
    return '100-499'
  }
  if (nodeCount <= 999) {
    return '500-999'
  }
  if (nodeCount <= 4_999) {
    return '1000-4999'
  }
  return '5000+'
}

export function getTelemetryStatus(options: TelemetryOptions = {}): TelemetryStatus {
  const env = options.env ?? process.env
  const configRoot = options.configRoot ?? defaultConfigRoot(env)
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot(env)
  const configFile = telemetryConfigFilePath(configRoot)
  const spoolFile = telemetrySpoolFilePath(cacheRoot)
  const eventCount = loadSpool(spoolFile).events.length

  if (env.CI) {
    return {
      enabled: false,
      reason: 'disabled in CI',
      configFile,
      spoolFile,
      eventCount,
    }
  }

  if (env.DO_NOT_TRACK === '1') {
    return {
      enabled: false,
      reason: 'disabled by DO_NOT_TRACK=1',
      configFile,
      spoolFile,
      eventCount,
    }
  }

  if (env.MADAR_DISABLE_TELEMETRY === '1') {
    return {
      enabled: false,
      reason: 'disabled by MADAR_DISABLE_TELEMETRY=1',
      configFile,
      spoolFile,
      eventCount,
    }
  }

  if (env.MADAR_ENABLE_TELEMETRY === '1') {
    return {
      enabled: true,
      reason: 'enabled by MADAR_ENABLE_TELEMETRY=1',
      configFile,
      spoolFile,
      eventCount,
    }
  }

  const config = loadConfig(configFile)
  if (config?.enabled) {
    return {
      enabled: true,
      reason: 'enabled by persisted preference',
      configFile,
      spoolFile,
      eventCount,
    }
  }

  return {
    enabled: false,
    reason: 'disabled by default',
    configFile,
    spoolFile,
    eventCount,
  }
}

export function formatTelemetryStatus(status: TelemetryStatus): string {
  return [
    `Telemetry: ${status.enabled ? 'enabled' : 'disabled'}`,
    `Reason: ${status.reason}`,
    `Event cache: ${status.eventCount} event(s) at ${status.spoolFile}`,
    'Tracked fields: command, stage, recorded_at, version, os, node_major, optional agent_target, size/status/failure buckets, and source-safe answerability/recovery buckets',
    'Tracked surfaces: install, generate, pack, prompt, context_pack, doctor, status, compare',
    'Local controls: madar telemetry clear, madar telemetry report [spool.json ...]',
    'Excluded fields: prompts, answers, source paths, source content, repository names',
  ].join('\n')
}

function formatTelemetryPreferenceUpdate(preferenceEnabled: boolean, runtimeStatus: TelemetryStatus): string {
  const persistedReason = preferenceEnabled ? 'enabled by persisted preference' : 'disabled by persisted preference'
  const lines = [
    `Telemetry preference: ${preferenceEnabled ? 'enabled' : 'disabled'}`,
    `Config file: ${runtimeStatus.configFile}`,
    `Event cache: ${runtimeStatus.eventCount} event(s) at ${runtimeStatus.spoolFile}`,
    'Tracked fields: command, stage, recorded_at, version, os, node_major, optional agent_target, size/status/failure buckets, and source-safe answerability/recovery buckets',
    'Excluded fields: prompts, answers, source paths, source content, repository names',
  ]

  if (runtimeStatus.enabled !== preferenceEnabled || runtimeStatus.reason !== persistedReason) {
    lines.splice(1, 0, `Current runtime override: ${runtimeStatus.reason}`)
  }

  return lines.join('\n')
}

export function enableTelemetry(options: TelemetryOptions = {}): string {
  const env = options.env ?? process.env
  const configRoot = options.configRoot ?? defaultConfigRoot(env)
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot(env)
  const now = options.now ?? Date.now
  const configFile = telemetryConfigFilePath(configRoot)
  withExclusiveLock(configFile, () => {
    writeJsonAtomic(configFile, {
      schema_version: 1,
      enabled: true,
      updated_at: now(),
    } satisfies TelemetryConfig)
  })
  return formatTelemetryPreferenceUpdate(true, getTelemetryStatus({ ...options, configRoot, cacheRoot, env }))
}

export function disableTelemetry(options: TelemetryOptions = {}): string {
  const env = options.env ?? process.env
  const configRoot = options.configRoot ?? defaultConfigRoot(env)
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot(env)
  const now = options.now ?? Date.now
  const configFile = telemetryConfigFilePath(configRoot)
  withExclusiveLock(configFile, () => {
    writeJsonAtomic(configFile, {
      schema_version: 1,
      enabled: false,
      updated_at: now(),
    } satisfies TelemetryConfig)
  })
  return formatTelemetryPreferenceUpdate(false, getTelemetryStatus({ ...options, configRoot, cacheRoot, env }))
}

export function clearTelemetry(options: TelemetryOptions = {}): string {
  const env = options.env ?? process.env
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot(env)
  const spoolFile = telemetrySpoolFilePath(cacheRoot)
  let clearedEvents = 0
  withExclusiveLock(spoolFile, () => {
    clearedEvents = loadSpool(spoolFile).events.length
    writeJsonAtomic(spoolFile, { schema_version: 2, events: [] } satisfies TelemetrySpool)
  })
  return `Telemetry cache cleared: removed ${clearedEvents} event(s) at ${spoolFile}`
}

export function recordTelemetryEvent(input: TelemetryEventInput, options: TelemetryOptions = {}): boolean {
  const env = options.env ?? process.env
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot(env)
  const status = getTelemetryStatus(options)
  if (!status.enabled) {
    return false
  }

  const now = options.now ?? Date.now
  const requestedMaxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
  const maxEvents = Number.isInteger(requestedMaxEvents) && requestedMaxEvents > 0
    ? requestedMaxEvents
    : DEFAULT_MAX_EVENTS
  const spoolFile = telemetrySpoolFilePath(cacheRoot)
  withExclusiveLock(spoolFile, () => {
    const spool = loadSpool(spoolFile)
    spool.events.push({
      command: input.command,
      stage: input.stage,
      recorded_at: new Date(now()).toISOString(),
      version: input.version,
      os: input.os,
      node_major: input.nodeMajor,
      ...(input.repoSizeBucket ? { repo_size_bucket: input.repoSizeBucket } : {}),
      ...(input.graphSizeBucket ? { graph_size_bucket: input.graphSizeBucket } : {}),
      ...(input.agentTarget ? { agent_target: input.agentTarget } : {}),
      ...(input.failureBucket ? { failure_bucket: input.failureBucket } : {}),
      ...(input.statusBucket ? { status_bucket: input.statusBucket } : {}),
      ...(input.initialAnswerabilityBucket ? { initial_answerability_bucket: input.initialAnswerabilityBucket } : {}),
      ...(input.recoveryAttemptsBucket ? { recovery_attempts_bucket: input.recoveryAttemptsBucket } : {}),
      ...(input.recoveryImprovementBucket ? { recovery_improvement_bucket: input.recoveryImprovementBucket } : {}),
      ...(input.finalAnswerabilityBucket ? { final_answerability_bucket: input.finalAnswerabilityBucket } : {}),
      ...(input.broadSearchFallbackBucket ? { broad_search_fallback_bucket: input.broadSearchFallbackBucket } : {}),
    })
    if (spool.events.length > maxEvents) {
      spool.events = spool.events.slice(-maxEvents)
    }
    writeJsonAtomic(spoolFile, spool)
  })
  return true
}

function safeLoadSpool(spoolFile: string): TelemetrySpool {
  try {
    return loadSpool(spoolFile)
  } catch {
    return { schema_version: 2, events: [] }
  }
}

export function readTelemetryReport(options: TelemetryOptions = {}, spoolPaths: string[] = []): string {
  const env = options.env ?? process.env
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot(env)
  const resolvedPaths = [...new Set([
    telemetrySpoolFilePath(cacheRoot),
    ...spoolPaths.map((spoolPath) => resolve(spoolPath)),
  ])]
  const events = resolvedPaths.flatMap((spoolPath) => safeLoadSpool(spoolPath).events)

  const lines = [
    'Telemetry funnel summary',
    `Spools: ${resolvedPaths.length}`,
    `Events: ${events.length}`,
  ]

  if (events.length === 0) {
    lines.push('No telemetry events found.')
    return lines.join('\n')
  }

  lines.push('Commands:')
  lines.push(...summarizeCounts(events.map((event) => event.command)))

  lines.push('Stages:')
  lines.push(...summarizeCounts(events.map((event) => event.stage)))

  const agentTargets = events.flatMap((event) => event.agent_target ? [event.agent_target] : [])
  if (agentTargets.length > 0) {
    lines.push('Agent targets:')
    lines.push(...summarizeCounts(agentTargets))
  }

  const failureBuckets = events.flatMap((event) => event.failure_bucket ? [event.failure_bucket] : [])
  if (failureBuckets.length > 0) {
    lines.push('Failure buckets:')
    lines.push(...summarizeCounts(failureBuckets))
  }

  const statusBuckets = events.flatMap((event) => event.status_bucket ? [event.status_bucket] : [])
  if (statusBuckets.length > 0) {
    lines.push('Status buckets:')
    lines.push(...summarizeCounts(statusBuckets))
  }

  const initialAnswerability = events.flatMap((event) => event.initial_answerability_bucket ? [event.initial_answerability_bucket] : [])
  if (initialAnswerability.length > 0) {
    lines.push('Initial answerability:')
    lines.push(...summarizeCounts(initialAnswerability))
  }

  const recoveryAttempts = events.flatMap((event) => event.recovery_attempts_bucket ? [event.recovery_attempts_bucket] : [])
  if (recoveryAttempts.length > 0) {
    lines.push('Recovery attempts:')
    lines.push(...summarizeCounts(recoveryAttempts))
  }

  const recoveryImprovement = events.flatMap((event) => event.recovery_improvement_bucket ? [event.recovery_improvement_bucket] : [])
  if (recoveryImprovement.length > 0) {
    lines.push('Recovery improvement:')
    lines.push(...summarizeCounts(recoveryImprovement))
  }

  const finalAnswerability = events.flatMap((event) => event.final_answerability_bucket ? [event.final_answerability_bucket] : [])
  if (finalAnswerability.length > 0) {
    lines.push('Final answerability:')
    lines.push(...summarizeCounts(finalAnswerability))
  }

  const broadSearchFallback = events.flatMap((event) => event.broad_search_fallback_bucket ? [event.broad_search_fallback_bucket] : [])
  if (broadSearchFallback.length > 0) {
    lines.push('Broad-search fallback:')
    lines.push(...summarizeCounts(broadSearchFallback))
  }

  return lines.join('\n')
}
