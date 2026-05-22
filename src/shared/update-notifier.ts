import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { safeFetchText } from './security.js'

const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000
const REGISTRY_TIMEOUT_MS = 5_000

interface UpdateCheckCache {
  checked_at: number
  latest_version: string | null
  notified_at?: number
}

export interface UpdateNotificationOptions {
  packageName: string
  currentVersion: string
  cacheRoot?: string
  stdoutIsTTY?: boolean
  env?: NodeJS.ProcessEnv
  now?: () => number
  ttlMs?: number
  fetchText?: (url: string, maxBytes?: number, timeout?: number) => Promise<string>
}

function defaultCacheRoot(env: NodeJS.ProcessEnv): string {
  if (typeof env.XDG_CACHE_HOME === 'string' && env.XDG_CACHE_HOME.trim().length > 0) {
    return env.XDG_CACHE_HOME
  }

  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches')
  }

  if (process.platform === 'win32') {
    if (typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim().length > 0) {
      return env.LOCALAPPDATA
    }
    return join(homedir(), 'AppData', 'Local')
  }

  return join(homedir(), '.cache')
}

function updateCacheFilePath(cacheRoot: string): string {
  return join(cacheRoot, 'madar', 'update-check.json')
}

function isNotifierDisabled(env: NodeJS.ProcessEnv, stdoutIsTTY: boolean): boolean {
  if (!stdoutIsTTY) {
    return true
  }

  if (env.CI) {
    return true
  }

  if (env.NO_UPDATE_NOTIFIER === '1' || env.MADAR_DISABLE_UPDATE_NOTIFIER === '1') {
    return true
  }

  return false
}

function parseCache(text: string): UpdateCheckCache | null {
  try {
    const parsed = JSON.parse(text) as Partial<UpdateCheckCache>
    if (typeof parsed.checked_at !== 'number') {
      return null
    }
    if (parsed.latest_version !== null && typeof parsed.latest_version !== 'string') {
      return null
    }
    if (parsed.notified_at !== undefined && typeof parsed.notified_at !== 'number') {
      return null
    }
    return {
      checked_at: parsed.checked_at,
      latest_version: parsed.latest_version ?? null,
      ...(typeof parsed.notified_at === 'number' ? { notified_at: parsed.notified_at } : {}),
    }
  } catch {
    return null
  }
}

function loadCache(cacheFile: string): UpdateCheckCache | null {
  if (!existsSync(cacheFile)) {
    return null
  }

  return parseCache(readFileSync(cacheFile, 'utf8'))
}

function saveCache(cacheFile: string, cache: UpdateCheckCache): void {
  mkdirSync(dirname(cacheFile), { recursive: true })
  const tempFile = `${cacheFile}.tmp`
  try {
    writeFileSync(tempFile, JSON.stringify(cache))
    renameSync(tempFile, cacheFile)
  } catch (error) {
    rmSync(tempFile, { force: true })
    throw error
  }
}

function parseVersion(version: string): { core: number[]; prerelease: string[] | null } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim())
  if (!match) {
    return null
  }

  const [, major, minor, patch, prerelease] = match
  return {
    core: [Number(major), Number(minor), Number(patch)],
    prerelease: prerelease ? prerelease.split('.') : null,
  }
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)

  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right)
  }

  if (leftNumeric) {
    return -1
  }

  if (rightNumeric) {
    return 1
  }

  return left.localeCompare(right)
}

export function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left)
  const rightVersion = parseVersion(right)

  if (!leftVersion || !rightVersion) {
    return left.localeCompare(right)
  }

  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const difference = (leftVersion.core[index] ?? 0) - (rightVersion.core[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }

  if (!leftVersion.prerelease && !rightVersion.prerelease) {
    return 0
  }

  if (!leftVersion.prerelease) {
    return 1
  }

  if (!rightVersion.prerelease) {
    return -1
  }

  const maxLength = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length)
  for (let index = 0; index < maxLength; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index]
    const rightIdentifier = rightVersion.prerelease[index]

    if (leftIdentifier === undefined) {
      return -1
    }
    if (rightIdentifier === undefined) {
      return 1
    }

    const difference = compareIdentifiers(leftIdentifier, rightIdentifier)
    if (difference !== 0) {
      return difference
    }
  }

  return 0
}

function formatUpdateNotice(packageName: string, currentVersion: string, latestVersion: string): string {
  return [
    `A newer madar is available: ${currentVersion} -> ${latestVersion}`,
    `Update: npm i -g ${packageName}@latest`,
    'Then re-run: madar claude install | cursor install | gemini install',
  ].join('\n')
}

export async function getUpdateNotification(options: UpdateNotificationOptions): Promise<string | null> {
  const env = options.env ?? process.env
  const stdoutIsTTY = options.stdoutIsTTY ?? Boolean(process.stdout.isTTY)
  if (isNotifierDisabled(env, stdoutIsTTY)) {
    return null
  }

  const now = options.now ?? Date.now
  const currentTime = now()
  const ttlMs = options.ttlMs ?? UPDATE_CHECK_TTL_MS
  const cacheFile = updateCacheFilePath(options.cacheRoot ?? defaultCacheRoot(env))
  const cached = loadCache(cacheFile)

  let latestVersion = cached?.latest_version ?? null
  let checkedAt = cached?.checked_at ?? currentTime
  const shouldRefresh = !cached || currentTime - cached.checked_at >= ttlMs
  if (shouldRefresh) {
    const fetchText = options.fetchText ?? safeFetchText
    const latestUrl = `https://registry.npmjs.org/${encodeURIComponent(options.packageName)}/latest`
    try {
      const latest = JSON.parse(await fetchText(latestUrl, undefined, REGISTRY_TIMEOUT_MS)) as { version?: unknown }
      latestVersion = typeof latest.version === 'string' && latest.version.trim().length > 0 ? latest.version : null
      checkedAt = currentTime
      saveCache(cacheFile, {
        checked_at: checkedAt,
        latest_version: latestVersion,
      })
    } catch {
      saveCache(cacheFile, {
        checked_at: currentTime,
        latest_version: cached?.latest_version ?? null,
        ...(typeof cached?.notified_at === 'number' ? { notified_at: cached.notified_at } : {}),
      })
      return null
    }
  }

  if (!latestVersion || compareVersions(latestVersion, options.currentVersion) <= 0) {
    return null
  }

  if (!shouldRefresh && cached?.latest_version === latestVersion && typeof cached.notified_at === 'number') {
    return null
  }

  saveCache(cacheFile, {
    checked_at: checkedAt,
    latest_version: latestVersion,
    notified_at: currentTime,
  })
  return formatUpdateNotice(options.packageName, options.currentVersion, latestVersion)
}
