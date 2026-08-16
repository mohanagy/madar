import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import {
  GRAPH_ARTIFACT_V2_HEADER,
  GRAPH_ARTIFACT_V2_TOMBSTONE,
} from './graph-artifact.js'

/**
 * One place that decides which graph artifact a request actually means.
 *
 * Before this existed, three sites resolved a `graph.json` request to its
 * canonical sibling independently -- `serve.ts`, `loadGraphArtifactFromPath`
 * and `readGraphArtifactMetadata` -- and each grew slightly different rules.
 * Everything that needs to know "which file, and is this workspace healthy?"
 * comes here instead.
 */

export const CANONICAL_ARTIFACT_BASENAME = 'graph.madar'
export const LEGACY_ARTIFACT_BASENAME = 'graph.json'
export const LEGACY_BACKUP_BASENAME = 'graph.v1.json'

/**
 * Ceiling for any artifact read through this module.
 *
 * Omitting a bound never means unlimited. A caller may ask for a smaller
 * positive bound; it may not opt out.
 */
export const MAX_GRAPH_ARTIFACT_BYTES = 100 * 1024 * 1024

/**
 * Whether the caller named an artifact, or fell back to a built-in default.
 *
 * This cannot be recovered from the path string. `--graph out/graph.json` and
 * an omitted option both normalize to the same text, and they mean opposite
 * things once a workspace can be ambiguous: an explicit request is a
 * diagnostic instruction, a default request must fail closed.
 */
export type GraphPathIntent = 'default' | 'explicit'

/**
 * What the files on disk actually say about the workspace.
 *
 * `mixed_v2_and_live_v1` is deliberately not a success state. A canonical
 * artifact beside a live v1 may be a B1 workspace, an interrupted cutover, a
 * downgrade, or a manual rollback, and nothing durable distinguishes them.
 */
export type WorkspaceGraphState =
  | 'current_v2'
  | 'legacy_v1_only'
  | 'mixed_v2_and_live_v1'
  | 'moved_without_canonical'
  | 'invalid_current_v2'
  | 'missing'
  | 'invalid'

export type GraphArtifactSelectionKind =
  | 'canonical_default'
  | 'explicit_v2'
  | 'explicit_legacy'
  | 'tombstone_alias'

export interface ResolvedGraphArtifactSelection {
  readonly requestedPath: string
  /** For stat, read, hash, sidecar and linked-worktree work. */
  readonly selectedPhysicalPath: string
  /** For Pack fields, governance freshness and public diagnostics. */
  readonly selectedLogicalPath: string
  readonly format: 'v2' | 'v1'
  readonly intent: GraphPathIntent
  readonly workspaceState: WorkspaceGraphState
  readonly selection: GraphArtifactSelectionKind
}

/** A refusal that names the state rather than guessing past it. */
export class GraphArtifactStateError extends Error {
  readonly state: WorkspaceGraphState
  readonly tombstonePath: string | undefined
  readonly expectedCanonicalPath: string | undefined
  /** Present for diagnostics only. It never becomes an automatic selection. */
  readonly legacyBackupPath: string | undefined

  constructor(
    state: WorkspaceGraphState,
    message: string,
    paths: {
      tombstonePath?: string
      expectedCanonicalPath?: string
      legacyBackupPath?: string
    } = {},
  ) {
    super(message)
    this.name = 'GraphArtifactStateError'
    this.state = state
    this.tombstonePath = paths.tombstonePath
    this.expectedCanonicalPath = paths.expectedCanonicalPath
    this.legacyBackupPath = paths.legacyBackupPath
  }
}

export class GraphArtifactTooLargeError extends Error {
  constructor(path: string, size: number, maxBytes: number) {
    super(`Graph artifact ${path} is ${size} bytes, over the ${maxBytes} byte limit`)
    this.name = 'GraphArtifactTooLargeError'
  }
}

function assertBound(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError(`Graph artifact byte bound must be a positive safe integer, received ${maxBytes}`)
  }
  return maxBytes
}

/**
 * Reads a file only if it is within the bound, checked twice.
 *
 * The stat avoids pulling an oversized artifact into memory at all; the
 * post-read length catches a file that grew between the two calls.
 */
export function readArtifactWithinBound(path: string, maxBytes = MAX_GRAPH_ARTIFACT_BYTES): Buffer {
  const bound = assertBound(maxBytes)
  const { size } = statSync(path)
  if (size > bound) throw new GraphArtifactTooLargeError(path, size, bound)
  const bytes = readFileSync(path)
  if (bytes.byteLength > bound) throw new GraphArtifactTooLargeError(path, bytes.byteLength, bound)
  return bytes
}

/** Just enough bytes to tell the four shapes apart, never the whole file. */
const CLASSIFY_PREFIX_BYTES = Math.max(
  GRAPH_ARTIFACT_V2_HEADER.length,
  GRAPH_ARTIFACT_V2_TOMBSTONE.length,
) + 8

type ArtifactShape = 'v2_header' | 'exact_tombstone' | 'json_like' | 'unknown' | 'absent'

function shapeOf(path: string): ArtifactShape {
  if (!existsSync(path)) return 'absent'
  let prefix: string
  try {
    prefix = readFileSync(path).subarray(0, CLASSIFY_PREFIX_BYTES).toString('utf8')
  } catch {
    return 'unknown'
  }
  if (prefix.startsWith(GRAPH_ARTIFACT_V2_HEADER)) return 'v2_header'
  if (prefix.startsWith(GRAPH_ARTIFACT_V2_TOMBSTONE)) return 'exact_tombstone'
  if (/^\s*\{/.test(prefix)) return 'json_like'
  return 'unknown'
}

/** True only for a byte-exact tombstone, not merely the moved prefix. */
function isExactTombstone(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    return readFileSync(path, 'utf8') === GRAPH_ARTIFACT_V2_TOMBSTONE
  } catch {
    return false
  }
}

function canonicalIsValid(path: string, maxBytes: number): boolean {
  try {
    return readArtifactWithinBound(path, maxBytes).subarray(0, GRAPH_ARTIFACT_V2_HEADER.length)
      .toString('utf8') === GRAPH_ARTIFACT_V2_HEADER
  } catch {
    return false
  }
}

export interface WorkspaceGraphClassification {
  readonly state: WorkspaceGraphState
  readonly canonicalPath: string
  readonly legacyPath: string
  readonly backupPath: string
  readonly hasBackup: boolean
}

/**
 * Classifies an output directory.
 *
 * The exact tombstone is evaluated before any backup-based compatibility. A
 * preserved `graph.v1.json` is rollback evidence, not an active graph, so it
 * must never turn a moved-or-broken workspace into a usable one.
 */
export function classifyWorkspaceGraph(
  outputDir: string,
  maxBytes = MAX_GRAPH_ARTIFACT_BYTES,
): WorkspaceGraphClassification {
  const canonicalPath = join(outputDir, CANONICAL_ARTIFACT_BASENAME)
  const legacyPath = join(outputDir, LEGACY_ARTIFACT_BASENAME)
  const backupPath = join(outputDir, LEGACY_BACKUP_BASENAME)

  const hasBackup = shapeOf(backupPath) === 'json_like'
  const canonicalShape = shapeOf(canonicalPath)
  const tombstoned = isExactTombstone(legacyPath)
  const base = { canonicalPath, legacyPath, backupPath, hasBackup }

  if (tombstoned) {
    if (canonicalShape === 'absent') return { ...base, state: 'moved_without_canonical' }
    if (canonicalShape !== 'v2_header' || !canonicalIsValid(canonicalPath, maxBytes)) {
      return { ...base, state: 'invalid_current_v2' }
    }
    return { ...base, state: 'current_v2' }
  }

  const legacyShape = shapeOf(legacyPath)
  if (canonicalShape === 'v2_header') {
    if (!canonicalIsValid(canonicalPath, maxBytes)) return { ...base, state: 'invalid_current_v2' }
    if (legacyShape === 'json_like') return { ...base, state: 'mixed_v2_and_live_v1' }
    // Canonical present with no legacy file: the cutover never wrote a
    // tombstone, but the graph itself is healthy and usable.
    return { ...base, state: 'current_v2' }
  }

  if (canonicalShape !== 'absent') return { ...base, state: 'invalid_current_v2' }
  if (legacyShape === 'json_like') return { ...base, state: 'legacy_v1_only' }
  if (legacyShape === 'absent') return { ...base, state: 'missing' }
  return { ...base, state: 'invalid' }
}

export interface ResolveGraphArtifactOptions {
  readonly intent: GraphPathIntent
  readonly maxBytes?: number
  /** Logical path to report publicly when it differs from the physical one. */
  readonly logicalPath?: string
}

function refuse(classification: WorkspaceGraphClassification, message: string): never {
  throw new GraphArtifactStateError(classification.state, message, {
    tombstonePath: classification.legacyPath,
    expectedCanonicalPath: classification.canonicalPath,
    ...(classification.hasBackup ? { legacyBackupPath: classification.backupPath } : {}),
  })
}

/**
 * Decides which artifact a request resolves to, or refuses.
 *
 * Default intent must never resolve an ambiguous or broken workspace. Explicit
 * intent may reach a specific artifact for diagnosis, which is the only way to
 * read a preserved backup.
 */
export function resolveGraphArtifact(
  requestedPath: string,
  options: ResolveGraphArtifactOptions,
): ResolvedGraphArtifactSelection {
  const maxBytes = assertBound(options.maxBytes ?? MAX_GRAPH_ARTIFACT_BYTES)
  const outputDir = dirname(requestedPath)
  const name = basename(requestedPath)
  const classification = classifyWorkspaceGraph(outputDir, maxBytes)
  const logicalPath = options.logicalPath ?? requestedPath

  const common = { requestedPath, intent: options.intent } as const

  if (options.intent === 'explicit') {
    if (name === LEGACY_BACKUP_BASENAME) {
      if (!classification.hasBackup) {
        refuse(classification, `No readable legacy backup at ${classification.backupPath}.`)
      }
      return {
        ...common,
        selectedPhysicalPath: classification.backupPath,
        selectedLogicalPath: logicalPath,
        format: 'v1',
        workspaceState: classification.state,
        selection: 'explicit_legacy',
      }
    }

    if (name === CANONICAL_ARTIFACT_BASENAME) {
      if (!canonicalIsValid(classification.canonicalPath, maxBytes)) {
        refuse(classification, `Canonical artifact ${classification.canonicalPath} is missing or not a valid v2 artifact.`)
      }
      return {
        ...common,
        selectedPhysicalPath: classification.canonicalPath,
        selectedLogicalPath: logicalPath,
        format: 'v2',
        workspaceState: classification.state,
        selection: 'explicit_v2',
      }
    }

    // Explicit legacy path: a tombstone forwards to its sibling, a live v1
    // loads degraded. Neither silently becomes the other.
    if (isExactTombstone(requestedPath)) {
      if (!canonicalIsValid(classification.canonicalPath, maxBytes)) {
        refuse(classification, `${requestedPath} has moved but ${classification.canonicalPath} is missing or invalid.`)
      }
      return {
        ...common,
        selectedPhysicalPath: classification.canonicalPath,
        selectedLogicalPath: options.logicalPath ?? classification.canonicalPath,
        format: 'v2',
        workspaceState: classification.state,
        selection: 'tombstone_alias',
      }
    }
    if (shapeOf(requestedPath) === 'json_like') {
      return {
        ...common,
        selectedPhysicalPath: requestedPath,
        selectedLogicalPath: logicalPath,
        format: 'v1',
        workspaceState: classification.state,
        selection: 'explicit_legacy',
      }
    }
    refuse(classification, `${requestedPath} is not a readable graph artifact.`)
  }

  switch (classification.state) {
    case 'current_v2':
      return {
        ...common,
        selectedPhysicalPath: classification.canonicalPath,
        selectedLogicalPath: options.logicalPath ?? classification.canonicalPath,
        format: 'v2',
        workspaceState: classification.state,
        selection: 'canonical_default',
      }
    case 'legacy_v1_only':
      return {
        ...common,
        selectedPhysicalPath: classification.legacyPath,
        selectedLogicalPath: options.logicalPath ?? classification.legacyPath,
        format: 'v1',
        workspaceState: classification.state,
        selection: 'explicit_legacy',
      }
    case 'mixed_v2_and_live_v1':
      refuse(
        classification,
        `A valid ${CANONICAL_ARTIFACT_BASENAME} and a live v1 ${LEGACY_ARTIFACT_BASENAME} exist together in ${outputDir}. `
        + 'This may be an interrupted cutover, a transitional workspace, or a rollback state, and Madar cannot tell '
        + 'them apart safely. Run the current `madar generate .` to complete the v2 cutover, or select '
        + `${CANONICAL_ARTIFACT_BASENAME} or the legacy artifact explicitly for diagnostics.`,
      )
    case 'moved_without_canonical':
      refuse(
        classification,
        `${classification.legacyPath} has moved but ${classification.canonicalPath} is missing. `
        + 'Run the current `madar generate .` to rebuild it.',
      )
    case 'invalid_current_v2':
      refuse(
        classification,
        `${classification.canonicalPath} exists but is not a readable v2 artifact. `
        + 'Run the current `madar generate .` to rebuild it.',
      )
    case 'missing':
      refuse(classification, `No graph artifact found in ${outputDir}. Run \`madar generate .\` first.`)
    default:
      refuse(classification, `The graph artifact in ${outputDir} is unreadable.`)
  }
}
