import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'

export type TelemetryEventName = 'install_success' | 'generate_success' | 'pack_success' | 'compare_success'
export type TelemetryRepoSizeBucket = '1-24' | '25-99' | '100-499' | '500-999' | '1000+'

export interface TelemetryEventInput {
  event: TelemetryEventName
  version: string
  os: NodeJS.Platform
  repoSizeBucket?: TelemetryRepoSizeBucket
  installPlatform?: string
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

interface PersistedTelemetryEvent {
  event: TelemetryEventName
  recorded_at: string
  version: string
  os: NodeJS.Platform
  repo_size_bucket?: TelemetryRepoSizeBucket
  install_platform?: string
}

interface TelemetrySpool {
  schema_version: 1
  events: PersistedTelemetryEvent[]
}

const DEFAULT_MAX_EVENTS = 200

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

function parseSpool(text: string): TelemetrySpool | null {
  try {
    const parsed = JSON.parse(text) as Partial<TelemetrySpool>
    if (parsed.schema_version !== 1 || !Array.isArray(parsed.events)) {
      return null
    }
    return {
      schema_version: 1,
      events: parsed.events
        .filter((event): event is PersistedTelemetryEvent => typeof event === 'object' && event !== null)
        .map((event) => {
          const record = event as Partial<PersistedTelemetryEvent>
          return {
            event: record.event as TelemetryEventName,
            recorded_at: String(record.recorded_at ?? ''),
            version: String(record.version ?? ''),
            os: (record.os as NodeJS.Platform | undefined) ?? platform(),
            ...(record.repo_size_bucket ? { repo_size_bucket: record.repo_size_bucket } : {}),
            ...(record.install_platform ? { install_platform: String(record.install_platform) } : {}),
          }
        })
        .filter((event) => event.recorded_at.length > 0 && event.version.length > 0),
    }
  } catch {
    return null
  }
}

function loadSpool(spoolFile: string): TelemetrySpool {
  if (!existsSync(spoolFile)) {
    return { schema_version: 1, events: [] }
  }
  return parseSpool(readFileSync(spoolFile, 'utf8')) ?? { schema_version: 1, events: [] }
}

function writeJsonAtomic(targetPath: string, value: unknown): void {
  mkdirSync(dirname(targetPath), { recursive: true })
  const tempPath = `${targetPath}.tmp`
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2))
    renameSync(tempPath, targetPath)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
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
    'Tracked fields: event, version, os, optional install target, optional repo-size bucket',
    'Excluded fields: prompts, answers, source paths, source content',
  ].join('\n')
}

function formatTelemetryPreferenceUpdate(preferenceEnabled: boolean, runtimeStatus: TelemetryStatus): string {
  const persistedReason = preferenceEnabled ? 'enabled by persisted preference' : 'disabled by persisted preference'
  const lines = [
    `Telemetry preference: ${preferenceEnabled ? 'enabled' : 'disabled'}`,
    `Config file: ${runtimeStatus.configFile}`,
    `Event cache: ${runtimeStatus.eventCount} event(s) at ${runtimeStatus.spoolFile}`,
    'Tracked fields: event, version, os, optional install target, optional repo-size bucket',
    'Excluded fields: prompts, answers, source paths, source content',
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
  writeJsonAtomic(telemetryConfigFilePath(configRoot), {
    schema_version: 1,
    enabled: true,
    updated_at: now(),
  } satisfies TelemetryConfig)
  return formatTelemetryPreferenceUpdate(true, getTelemetryStatus({ ...options, configRoot, cacheRoot, env }))
}

export function disableTelemetry(options: TelemetryOptions = {}): string {
  const env = options.env ?? process.env
  const configRoot = options.configRoot ?? defaultConfigRoot(env)
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot(env)
  const now = options.now ?? Date.now
  writeJsonAtomic(telemetryConfigFilePath(configRoot), {
    schema_version: 1,
    enabled: false,
    updated_at: now(),
  } satisfies TelemetryConfig)
  return formatTelemetryPreferenceUpdate(false, getTelemetryStatus({ ...options, configRoot, cacheRoot, env }))
}

export function recordTelemetryEvent(input: TelemetryEventInput, options: TelemetryOptions = {}): boolean {
  const env = options.env ?? process.env
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot(env)
  const status = getTelemetryStatus(options)
  if (!status.enabled) {
    return false
  }

  const now = options.now ?? Date.now
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
  const spoolFile = telemetrySpoolFilePath(cacheRoot)
  const spool = loadSpool(spoolFile)
  spool.events.push({
    event: input.event,
    recorded_at: new Date(now()).toISOString(),
    version: input.version,
    os: input.os,
    ...(input.repoSizeBucket ? { repo_size_bucket: input.repoSizeBucket } : {}),
    ...(input.installPlatform ? { install_platform: input.installPlatform } : {}),
  })
  if (spool.events.length > maxEvents) {
    spool.events = spool.events.slice(-maxEvents)
  }
  writeJsonAtomic(spoolFile, spool)
  return true
}
