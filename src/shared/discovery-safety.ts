import { basename, dirname, extname, relative, sep } from 'node:path'

import { loadGraphArtifact } from '../adapters/filesystem/graph-artifact.js'
import { fileIdentity } from './atomic-file.js'

export type DiscoveryExclusionKind = 'sensitive' | 'unreadable'

export type DiscoveryExclusionReason =
  | 'environment_file'
  | 'private_key'
  | 'credential_store'
  | 'secret_config'
  | 'sensitive_directory'
  | 'unreadable_path'
  | 'unreadable_directory'

export interface DiscoveryExclusion {
  path: string
  kind: DiscoveryExclusionKind
  reason: DiscoveryExclusionReason
}

export interface DiscoverySafetySummary {
  total: number
  sensitive: number
  unreadable: number
  reasons: Partial<Record<DiscoveryExclusionReason, number>>
}

export interface DiscoverySafetyMetadata {
  version: 1
  summary: DiscoverySafetySummary
  /** Local-only paths. Share-safe surfaces must emit summary data, never this array. */
  exclusions: DiscoveryExclusion[]
}

export interface RelevantDiscoveryExclusions {
  total: number
  relevant: number
  reasons: Partial<Record<DiscoveryExclusionReason, number>>
  relevantReasons: Partial<Record<DiscoveryExclusionReason, number>>
  hasUnreadable: boolean
}

const PRIVATE_KEY_EXTENSIONS = new Set(['.der', '.jks', '.key', '.keystore', '.p12', '.pem', '.pfx', '.p8', '.pkcs12'])
const SECRET_CONFIG_EXTENSIONS = new Set([
  '',
  '.conf',
  '.config',
  '.ini',
  '.json',
  '.properties',
  '.tfvars',
  '.toml',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
])
const SENSITIVE_DIRECTORY_NAMES = new Set([
  '.aws',
  '.azure',
  '.credentials',
  '.docker',
  '.gcloud',
  '.kube',
  '.secrets',
  '.ssh',
  'credential',
  'credentials',
  'keys',
  'keystore',
  'keystores',
  'password',
  'passwords',
  'private',
  'private-keys',
  'private_keys',
  'secret',
  'secrets',
  'token',
  'tokens',
])
const CREDENTIAL_STORE_DIRECTORY_NAMES = new Set([
  '.aws',
  '.azure',
  '.credentials',
  '.docker',
  '.gcloud',
  '.kube',
  '.ssh',
])
const GENERIC_RELEVANCE_TOKENS = new Set([
  'and', 'app', 'apps', 'code', 'config', 'data', 'does', 'file', 'files', 'flow', 'from', 'how', 'into',
  'lib', 'libs', 'package', 'packages', 'path', 'project', 'repo', 'repository', 'src', 'test', 'tests',
  'the', 'this', 'through', 'what', 'where', 'with',
])
const RELEVANCE_TOKEN_ALIASES: Readonly<Record<string, string>> = {
  authentication: 'auth',
  authorisation: 'auth',
  authorise: 'auth',
  authorization: 'auth',
  authorize: 'auth',
  credentials: 'credential',
  environment: 'env',
  keys: 'key',
  keystore: 'key',
  keystores: 'key',
  passwd: 'password',
  passwords: 'password',
  pwd: 'password',
  secrets: 'secret',
  sensitive: 'secret',
  tokens: 'token',
}
const ENVIRONMENT_CONFIG_INTENT_PATTERN = /(?:^|[^a-z0-9])\.env(?:[^a-z0-9]|$)|\b(?:config(?:uration)?|credentials?|deploy(?:ment)?|environment|key|password|runtime\s+variable|secret|settings|token)\b/i
const MAX_STORED_EXCLUSIONS = 10_000
const MAX_METADATA_CACHE_ENTRIES = 16
const discoveryMetadataCache = new Map<string, {
  identity: string
  value: DiscoverySafetyMetadata | null
}>()

function toPosixPath(path: string): string {
  return path.replaceAll('\\', '/').split(sep).join('/')
}

export function localDiscoveryPath(root: string, path: string): string {
  const localPath = toPosixPath(relative(root, path))
  return localPath.length > 0 && !localPath.startsWith('../') ? localPath : toPosixPath(basename(path))
}

function pathSegments(path: string): string[] {
  return toPosixPath(path)
    .toLowerCase()
    .split('/')
    .filter(Boolean)
}

export function isSensitiveDirectoryName(name: string): boolean {
  return SENSITIVE_DIRECTORY_NAMES.has(name.toLowerCase())
}

export function sensitiveDirectoryReasonForPath(
  path: string,
  root: string,
): Extract<DiscoveryExclusionReason, 'credential_store' | 'sensitive_directory'> | null {
  const segments = pathSegments(localDiscoveryPath(root, path))
  if (segments.some((segment) => CREDENTIAL_STORE_DIRECTORY_NAMES.has(segment))) {
    return 'credential_store'
  }
  return segments.some(isSensitiveDirectoryName) ? 'sensitive_directory' : null
}

/**
 * Source-aware secret policy:
 * - private key material, environment files, and known credential stores are never read;
 * - ordinary source files are indexable regardless of security-related names or ancestors;
 * - non-source secret configs and files below explicit secret directories are not read.
 */
export function sensitiveArtifactReason(
  path: string,
  root: string,
  options: { isSourceFile: boolean },
): Extract<DiscoveryExclusionReason, 'environment_file' | 'private_key' | 'credential_store' | 'secret_config' | 'sensitive_directory'> | null {
  const name = basename(path).toLowerCase()
  const artifactName = name.replace(/\.(?:bak|backup|old|orig)$/i, '')
  const extension = extname(artifactName)
  const stem = extension.length > 0 ? artifactName.slice(0, -extension.length) : artifactName

  if (/^\.env(?:\.|$)/i.test(name) || name === '.envrc') {
    return 'environment_file'
  }
  if (PRIVATE_KEY_EXTENSIONS.has(extension) || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i.test(artifactName)) {
    return 'private_key'
  }
  if (/^(?:\.netrc|\.npmrc|\.pgpass|\.pypirc|\.htpasswd|aws_credentials|gcloud_credentials|kubeconfig)$/i.test(artifactName)) {
    return 'credential_store'
  }

  // Security-related source names describe behavior; they are not secret artifacts.
  if (options.isSourceFile) {
    return null
  }

  const relativeSegments = pathSegments(localDiscoveryPath(root, path))
  const ancestorSegments = relativeSegments.slice(0, -1)
  if (ancestorSegments.some(isSensitiveDirectoryName)) {
    return 'sensitive_directory'
  }

  const secretNamedConfig = /^(?:credential|credentials|password|passwords|passwd|private[-_]?key|secret|secrets|token|tokens)$/i.test(stem)
    || /^(?:aws[-_]?credentials|gcloud[-_]?credentials|service[-_.]?account)$/i.test(stem)
  return secretNamedConfig && SECRET_CONFIG_EXTENSIONS.has(extension) ? 'secret_config' : null
}

export function summarizeDiscoveryExclusions(exclusions: readonly DiscoveryExclusion[]): DiscoverySafetySummary {
  let sensitive = 0
  let unreadable = 0

  for (const exclusion of exclusions) {
    if (exclusion.kind === 'sensitive') {
      sensitive += 1
    } else {
      unreadable += 1
    }
  }

  return {
    total: exclusions.length,
    sensitive,
    unreadable,
    reasons: reasonBuckets(exclusions),
  }
}

export function buildDiscoverySafetyMetadata(exclusions: readonly DiscoveryExclusion[]): DiscoverySafetyMetadata {
  const localExclusions = exclusions.slice(0, MAX_STORED_EXCLUSIONS).map((entry) => ({ ...entry }))
  return {
    version: 1,
    summary: summarizeDiscoveryExclusions(localExclusions),
    exclusions: localExclusions,
  }
}

function isExclusionKind(value: unknown): value is DiscoveryExclusionKind {
  return value === 'sensitive' || value === 'unreadable'
}

function isExclusionReason(value: unknown): value is DiscoveryExclusionReason {
  return value === 'environment_file'
    || value === 'private_key'
    || value === 'credential_store'
    || value === 'secret_config'
    || value === 'sensitive_directory'
    || value === 'unreadable_path'
    || value === 'unreadable_directory'
}

export function parseDiscoverySafetyMetadata(value: unknown): DiscoverySafetyMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.exclusions)) {
    return null
  }

  const exclusions = record.exclusions
    .slice(0, MAX_STORED_EXCLUSIONS)
    .flatMap((entry): DiscoveryExclusion[] => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return []
      }
      const exclusion = entry as Record<string, unknown>
      if (
        typeof exclusion.path !== 'string'
        || exclusion.path.length === 0
        || exclusion.path.length > 4_096
        || !isExclusionKind(exclusion.kind)
        || !isExclusionReason(exclusion.reason)
      ) {
        return []
      }
      return [{
        path: toPosixPath(exclusion.path),
        kind: exclusion.kind,
        reason: exclusion.reason,
      }]
    })

  return buildDiscoverySafetyMetadata(exclusions)
}

export function readDiscoverySafetyMetadata(graphPath: string): DiscoverySafetyMetadata | null {
  let identity: string
  try {
    identity = fileIdentity(graphPath)
  } catch {
    return null
  }
  const cached = discoveryMetadataCache.get(graphPath)
  if (cached?.identity === identity) {
    return cached.value
  }
  const value = parseDiscoverySafetyMetadata(loadGraphArtifact(graphPath).graph.discovery_safety)
  discoveryMetadataCache.set(graphPath, { identity, value })
  while (discoveryMetadataCache.size > MAX_METADATA_CACHE_ENTRIES) {
    const oldestKey = discoveryMetadataCache.keys().next().value as string | undefined
    if (!oldestKey) break
    discoveryMetadataCache.delete(oldestKey)
  }
  return value
}

export function relevanceTokens(value: string): Set<string> {
  return new Set(
    value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => RELEVANCE_TOKEN_ALIASES[token] ?? token)
      .filter((token) => token.length >= 3 && !GENERIC_RELEVANCE_TOKENS.has(token)),
  )
}

export function tokenSetsIntersect(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const token of left) {
    if (right.has(token)) {
      return true
    }
  }
  return false
}

function normalizedDirectory(path: string): string {
  return dirname(toPosixPath(path)).replace(/^\.\//, '').replace(/^\/$/, '')
}

function directoryScopeSpecificEnough(path: string): boolean {
  const segments = path.split('/').filter((segment) => segment.length > 0 && !/^[A-Za-z]:$/.test(segment))
  const lastSegment = segments.at(-1)?.toLowerCase() ?? ''
  return segments.length >= 2 && !GENERIC_RELEVANCE_TOKENS.has(lastSegment)
}

function sharesOwnerDirectory(exclusionPath: string, ownerPaths: readonly string[]): boolean {
  const exclusionDirectory = normalizedDirectory(exclusionPath)
  if (exclusionDirectory.length === 0 || exclusionDirectory === '.') {
    return false
  }
  return ownerPaths.some((ownerPath) => {
    const ownerDirectory = normalizedDirectory(ownerPath)
    return ownerDirectory === exclusionDirectory
      || (ownerDirectory.startsWith(`${exclusionDirectory}/`) && directoryScopeSpecificEnough(exclusionDirectory))
      || (exclusionDirectory.startsWith(`${ownerDirectory}/`) && directoryScopeSpecificEnough(ownerDirectory))
  })
}

export function reasonBuckets<Reason extends string>(
  entries: readonly { reason: Reason }[],
): Partial<Record<Reason, number>> {
  const reasons: Partial<Record<Reason, number>> = {}
  for (const entry of entries) reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1
  return reasons
}

export function relevantPathEntries<Entry extends { path: string }>(
  entries: readonly Entry[],
  input: { question?: string; coveredWorkflowOwners?: readonly string[] },
  relevanceText: (entry: Entry) => string = (entry) => entry.path,
): Entry[] {
  const questionTokens = relevanceTokens(input.question ?? '')
  const ownerPaths = (input.coveredWorkflowOwners ?? []).map(toPosixPath)
  const ownerTokens = relevanceTokens(ownerPaths.join(' '))
  return entries.filter((entry) => {
    const entryTokens = relevanceTokens(relevanceText(entry))
    return tokenSetsIntersect(entryTokens, questionTokens)
      || tokenSetsIntersect(entryTokens, ownerTokens)
      || sharesOwnerDirectory(entry.path, ownerPaths)
  })
}

export function relevantDiscoveryExclusions(
  metadata: DiscoverySafetyMetadata,
  input: { question?: string; coveredWorkflowOwners?: readonly string[] },
): RelevantDiscoveryExclusions {
  const candidates = metadata.exclusions.filter((exclusion) => (
    exclusion.reason !== 'environment_file' || ENVIRONMENT_CONFIG_INTENT_PATTERN.test(input.question ?? '')
  ))
  const relevantEntries = relevantPathEntries(
    candidates,
    input,
    (exclusion) => `${exclusion.path} ${exclusion.reason}`,
  )
  const relevantSummary = summarizeDiscoveryExclusions(relevantEntries)

  return {
    total: metadata.summary.total,
    relevant: relevantEntries.length,
    reasons: metadata.summary.reasons,
    relevantReasons: relevantSummary.reasons,
    hasUnreadable: relevantEntries.some((entry) => entry.kind === 'unreadable'),
  }
}
