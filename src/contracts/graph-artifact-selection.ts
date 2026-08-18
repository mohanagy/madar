import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import {
  GRAPH_ARTIFACT_MOVED_PREFIX,
  GRAPH_ARTIFACT_V2_HEADER,
  GRAPH_ARTIFACT_V2_TOMBSTONE,
  isMovedMarkerText,
} from './graph-artifact-format.js'
import { v2PayloadStructureError } from './graph-artifact-payload.js'

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
  /** A default load in a workspace that has not cut over yet. */
  | 'legacy_default'
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
  const descriptor = openSync(path, 'r')
  try {
    // Sized and read through one descriptor. statSync followed by readFileSync
    // leaves a window in which the file grows, and readFileSync then allocates
    // the whole replacement before any check runs -- the bound this function
    // exists to enforce would be applied only after the memory was already
    // committed. Reading one byte past the bound is what makes growth past it
    // observable rather than silently truncated.
    const { size } = fstatSync(descriptor)
    if (size > bound) throw new GraphArtifactTooLargeError(path, size, bound)
    // The bound is the ceiling, not the reported size. fstat is a fast reject
    // for the common case, but a size that under-reports must still yield the
    // whole artifact when the bytes fit -- so the read grows past the reported
    // size rather than truncating there, and stops one byte past the bound,
    // which is what makes exceeding it detectable.
    let capacity = Math.min(size, bound) + 1
    let buffer = Buffer.allocUnsafe(capacity)
    let read = 0
    for (;;) {
      if (read === capacity) {
        if (capacity > bound) break
        const grown = Buffer.allocUnsafe(Math.min(capacity * 2, bound + 1))
        buffer.copy(grown, 0, 0, read)
        buffer = grown
        capacity = grown.byteLength
      }
      const chunk = readSync(descriptor, buffer, read, capacity - read, read)
      if (chunk === 0) break
      read += chunk
    }
    if (read > bound) throw new GraphArtifactTooLargeError(path, read, bound)
    // A view, not a copy: the artifact is tens of megabytes and this is the
    // load path. Only the bytes actually read are ever exposed.
    return buffer.subarray(0, read)
  } finally {
    closeSync(descriptor)
  }
}

const TOMBSTONE_BYTES = Buffer.byteLength(GRAPH_ARTIFACT_V2_TOMBSTONE, 'utf8')
const GRAPH_ARTIFACT_MOVED_PREFIX_BYTES = Buffer.byteLength(GRAPH_ARTIFACT_MOVED_PREFIX, 'utf8')

/** Just enough bytes to tell the four shapes apart, never the whole file. */
/**
 * Exported so a test can tell a classification probe apart from an artifact
 * read. Both go through readSync on a descriptor, and size alone cannot
 * separate them: a bounded read under a small maxBytes asks for fewer bytes
 * than this probe does.
 */
export const CLASSIFY_PREFIX_BYTES = Math.max(
  Buffer.byteLength(GRAPH_ARTIFACT_V2_HEADER, 'utf8'),
  TOMBSTONE_BYTES,
) + 8

/**
 * Reads at most `byteCount` bytes from the front of a file.
 *
 * Classification must never load a whole artifact. `readFileSync(...).subarray()`
 * looks bounded but is not: it pulls the entire file into memory first and only
 * then discards the tail, so a large legacy artifact or backup would be read in
 * full on every classification.
 */
function readPrefix(path: string, byteCount: number): Buffer | null {
  let handle: number
  try {
    handle = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.allocUnsafe(byteCount)
    return buffer.subarray(0, readSync(handle, buffer, 0, byteCount, 0))
  } catch {
    return null
  } finally {
    closeSync(handle)
  }
}

type ArtifactShape = 'v2_header' | 'exact_tombstone' | 'json_like' | 'unknown' | 'absent'

function shapeOf(path: string): ArtifactShape {
  if (!existsSync(path)) return 'absent'
  const bytes = readPrefix(path, CLASSIFY_PREFIX_BYTES)
  if (bytes === null) return 'unknown'
  const prefix = bytes.toString('utf8')
  if (prefix.startsWith(GRAPH_ARTIFACT_V2_HEADER)) return 'v2_header'
  if (prefix.startsWith(GRAPH_ARTIFACT_V2_TOMBSTONE)) return 'exact_tombstone'
  if (/^\s*\{/.test(prefix)) return 'json_like'
  return 'unknown'
}

/**
 * True for any versioned moved marker at this path.
 *
 * Generation writes the byte-exact tombstone, but reading accepts any
 * `MADAR_GRAPH_MOVED/<n>`: nothing else writes that magic, so a marker from a
 * different version -- or one with trailing bytes from a partial write -- still
 * means the artifact moved. Calling that "invalid" would hide a cutover that
 * demonstrably happened, and it is the same rule loadGraphArtifact applies, so
 * one file cannot mean "moved" to one module and "corrupt" to another.
 */
function isMovedMarker(path: string): boolean {
  const bytes = readPrefix(path, GRAPH_ARTIFACT_MOVED_PREFIX_BYTES)
  return bytes !== null && isMovedMarkerText(bytes.toString('utf8'))
}

/**
 * Whether the canonical artifact is actually readable, not merely magic-marked.
 *
 * A header check alone called a truncated artifact healthy, which is the
 * likeliest real corruption: a write cut short still begins with the right
 * bytes. Classifying that as `current_v2` meant a default read returned a
 * selection that then failed downstream, and `invalid_current_v2` was only ever
 * reachable for wrong magic or an oversized file.
 *
 * This reads the artifact in full, within the bound, and parses the payload.
 * That read is inherent to answering the question -- nothing cheaper can
 * distinguish a complete artifact from a truncated one.
 */
function canonicalIsValid(path: string, maxBytes: number): boolean {
  try {
    const bytes = readArtifactWithinBound(path, maxBytes)
    if (bytes.subarray(0, GRAPH_ARTIFACT_V2_HEADER.length).toString('utf8') !== GRAPH_ARTIFACT_V2_HEADER) {
      return false
    }
    const payload: unknown = JSON.parse(bytes.subarray(GRAPH_ARTIFACT_V2_HEADER.length).toString('utf8'))
    // Parsing is not validity. Accepting any JSON body meant a header followed
    // by `{}` classified as current_v2: the default load selected it, doctor
    // called the workspace healthy, and the parser then threw a raw invariant
    // error carrying no workspace state. The structural rule is shared with
    // the parser so the two cannot drift apart again.
    return v2PayloadStructureError(payload) === null
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
/**
 * Whether a request naming the legacy path resolves to the canonical artifact.
 *
 * Only a cut-over workspace redirects. Every other state either keeps live v1
 * bytes at `graph.json` -- legacy-only, and mixed -- or refuses outright.
 *
 * This exists because three readers each decided it separately and two decided
 * it differently: metadata and freshness redirected whenever a canonical
 * artifact merely *existed*, while `loadGraph` redirected only on a moved
 * marker. In a mixed workspace that produced v2 provenance and freshness
 * describing a v1 graph body, which is worse than either answer alone.
 */
export function legacyRequestResolvesToCanonical(state: WorkspaceGraphState): boolean {
  return state === 'current_v2'
}

export function classifyWorkspaceGraph(
  outputDir: string,
  maxBytes = MAX_GRAPH_ARTIFACT_BYTES,
): WorkspaceGraphClassification {
  const canonicalPath = join(outputDir, CANONICAL_ARTIFACT_BASENAME)
  const legacyPath = join(outputDir, LEGACY_ARTIFACT_BASENAME)
  const backupPath = join(outputDir, LEGACY_BACKUP_BASENAME)

  const hasBackup = shapeOf(backupPath) === 'json_like'
  const canonicalShape = shapeOf(canonicalPath)
  const tombstoned = isMovedMarker(legacyPath)
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
  /**
   * Directory spelling to show in diagnostics instead of the physical one.
   *
   * Refusals are the states an operator most needs to read, and for a linked
   * worktree the physical directory is private. Sanitizing here rather than in
   * the caller keeps the split intact for every caller, including ones that
   * only ever see the thrown error.
   */
  readonly logicalOutputDir?: string
}

function refuse(
  classification: WorkspaceGraphClassification,
  display: (path: string) => string,
  message: string,
): never {
  throw new GraphArtifactStateError(classification.state, message, {
    tombstonePath: display(classification.legacyPath),
    expectedCanonicalPath: display(classification.canonicalPath),
    ...(classification.hasBackup ? { legacyBackupPath: display(classification.backupPath) } : {}),
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

  const displayDir = options.logicalOutputDir
  // Forward slashes, on every platform. This is the logical spelling a user
  // reads in a refusal, and the tombstone it has to be matched against says
  // `out/graph.madar` literally -- a Windows refusal naming `out\graph.madar`
  // makes the reader work out that the two are the same file.
  const display = (path: string): string =>
    displayDir === undefined ? path : join(displayDir, basename(path)).replaceAll('\\', '/')
  const displayOutputDir = displayDir ?? outputDir

  const common = { requestedPath, intent: options.intent } as const

  // Classification already read and parsed the canonical artifact under this
  // same bound to decide the state, and these are exactly the two states it
  // reaches by finding a valid one. Asking canonicalIsValid again re-read and
  // re-parsed the whole file -- up to MAX_GRAPH_ARTIFACT_BYTES -- immediately
  // before the caller loads it a third time.
  const canonicalUsable = classification.state === 'current_v2'
    || classification.state === 'mixed_v2_and_live_v1'

  if (options.intent === 'explicit') {
    if (name === LEGACY_BACKUP_BASENAME) {
      if (!classification.hasBackup) {
        refuse(classification, display, `No readable legacy backup at ${display(classification.backupPath)}.`)
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
      if (!canonicalUsable) {
        refuse(classification, display, `Canonical artifact ${display(classification.canonicalPath)} is missing or not a valid v2 artifact.`)
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
    if (isMovedMarker(requestedPath)) {
      if (!canonicalUsable) {
        refuse(classification, display, `${display(requestedPath)} has moved but ${display(classification.canonicalPath)} is missing or invalid.`)
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
    refuse(classification, display, `${display(requestedPath)} is not a readable graph artifact.`)
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
        // Nobody asked for this artifact by name. Reporting `explicit_legacy`
        // for an automatic compatibility fallback made the two cases
        // indistinguishable to anything reading the selection kind.
        selection: 'legacy_default',
      }
    case 'mixed_v2_and_live_v1':
      refuse(
        classification,
        display,
        `A valid ${CANONICAL_ARTIFACT_BASENAME} and a live v1 ${LEGACY_ARTIFACT_BASENAME} exist together in ${displayOutputDir}. `
        + 'This may be an interrupted cutover, a transitional workspace, or a rollback state, and Madar cannot tell '
        + 'them apart safely. Run the current `madar generate .` to complete the v2 cutover, or select '
        + `${CANONICAL_ARTIFACT_BASENAME} or the legacy artifact explicitly for diagnostics.`,
      )
    case 'moved_without_canonical':
      refuse(
        classification,
        display,
        `${display(classification.legacyPath)} has moved but ${display(classification.canonicalPath)} is missing. `
        + 'Run the current `madar generate .` to rebuild it.',
      )
    case 'invalid_current_v2':
      refuse(
        classification,
        display,
        `${display(classification.canonicalPath)} exists but is not a readable v2 artifact. `
        + 'Run the current `madar generate .` to rebuild it.',
      )
    case 'missing':
      refuse(classification, display, `No graph artifact found in ${displayOutputDir}. Run \`madar generate .\` first.`)
    default:
      refuse(classification, display, `The graph artifact in ${displayOutputDir} is unreadable.`)
  }
}
