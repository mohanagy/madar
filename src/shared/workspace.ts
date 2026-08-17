import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import {
  CANONICAL_ARTIFACT_BASENAME,
  GraphArtifactStateError,
  LEGACY_ARTIFACT_BASENAME,
  LEGACY_BACKUP_BASENAME,
  type GraphPathIntent,
  type ResolvedGraphArtifactSelection,
  resolveGraphArtifact,
} from '../contracts/graph-artifact-selection.js'

export interface MadarWorkspace {
  /** Source root Madar is indexing. This may be a directory within a worktree. */
  rootPath: string
  /** Git worktree root, when the source root belongs to a Git checkout. */
  worktreeRoot: string | null
  /** Shared Git metadata directory for the repository, when available. */
  gitCommonDir: string | null
  /** True only for a linked Git worktree, never the primary checkout. */
  isLinkedWorktree: boolean
  /** Physical directory that owns this source root's Madar artifacts. */
  artifactRoot: string
  outputDir: string
  /** Canonical v2 artifact. The only artifact generation keeps active. */
  canonicalGraphPath: string
  /** Legacy v1 location. After a cutover this holds the tombstone. */
  legacyGraphPath: string
  /** Preserved prior v1 artifact, when a first cutover backed one up. */
  legacyBackupPath: string
}

/*
 * There is deliberately no `graphPath` field.
 *
 * It existed as a transitional alias for `legacyGraphPath`, and a name that
 * general made callers take the legacy artifact without choosing it. That is
 * how the auto-refresh guard came to compare a requested `graph.madar` against
 * the legacy spelling and refuse its own workspace, and how a watch test came
 * to assert the existence of a path that the cutover fills with a tombstone.
 * Callers name the artifact they mean, or resolve one with an intent.
 */

function canonicalPath(path: string): string {
  const resolved = resolve(path)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

function gitPath(rootPath: string, args: string[]): string | null {
  try {
    const value = execFileSync('git', ['-C', rootPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

function worktreeArtifactId(commonDir: string, worktreeRoot: string, sourceRoot: string): string {
  return createHash('sha256')
    .update(`${canonicalPath(commonDir)}\u0000${canonicalPath(worktreeRoot)}\u0000${canonicalPath(sourceRoot)}`)
    .digest('hex')
    .slice(0, 24)
}

/**
 * Resolves where Madar should store artifacts for a source root.
 *
 * Primary checkouts and non-Git directories keep the established `<root>/out`
 * layout. A linked Git worktree receives an isolated artifact directory below
 * the repository's common Git directory, keeping generated data outside the
 * worktree while ensuring two branches cannot share a graph.
 */
export function resolveMadarWorkspace(rootPath = '.'): MadarWorkspace {
  // Keep public paths in the caller's resolved spelling. Canonical paths are
  // only for identity/hash comparisons, otherwise macOS /var -> /private/var
  // aliases leak into normal non-worktree output paths.
  const sourceRoot = resolve(rootPath)
  const worktreeValue = gitPath(sourceRoot, ['rev-parse', '--show-toplevel'])
  // Ask Git for absolute metadata paths. Relative `--git-common-dir` output
  // varies across Git platforms when the source root is nested below a primary
  // checkout, and can otherwise make that primary checkout look like a linked
  // worktree on Windows.
  const commonDirValue = worktreeValue
    ? gitPath(sourceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    : null
  const gitDirValue = worktreeValue
    ? gitPath(sourceRoot, ['rev-parse', '--path-format=absolute', '--git-dir'])
    : null

  const worktreeRoot = worktreeValue ? resolve(worktreeValue) : null
  const gitCommonDir = worktreeRoot && commonDirValue ? resolve(commonDirValue) : null
  const gitDir = worktreeRoot && gitDirValue ? resolve(gitDirValue) : null
  const isLinkedWorktree = gitCommonDir !== null
    && gitDir !== null
    && canonicalPath(gitCommonDir) !== canonicalPath(gitDir)

  const artifactRoot = isLinkedWorktree && gitCommonDir && worktreeRoot
    ? join(gitCommonDir, 'madar', 'worktrees', worktreeArtifactId(gitCommonDir, worktreeRoot, sourceRoot))
    : sourceRoot
  const outputDir = join(artifactRoot, 'out')
  const legacyGraphPath = join(outputDir, LEGACY_ARTIFACT_BASENAME)

  return {
    rootPath: sourceRoot,
    worktreeRoot,
    gitCommonDir,
    isLinkedWorktree,
    artifactRoot,
    outputDir,
    canonicalGraphPath: join(outputDir, CANONICAL_ARTIFACT_BASENAME),
    legacyGraphPath,
    legacyBackupPath: join(outputDir, LEGACY_BACKUP_BASENAME),
  }
}

export function resolveMadarOutputDirectory(rootPath = '.'): string {
  return resolveMadarWorkspace(rootPath).outputDir
}

/**
 * Resolves the graph path a command should read.
 *
 * `intent` is required rather than defaulted. A default lookup must fail
 * closed on an ambiguous workspace, and an omitted argument would silently
 * pick the permissive branch for any caller that forgot to pass one.
 *
 * Default intent goes through the workspace classifier and therefore throws
 * GraphArtifactStateError for mixed, moved-without-canonical and
 * invalid-canonical workspaces. Explicit intent stays a pure path mapping: it
 * performs no I/O, so callers may still probe a path that does not exist yet.
 */
export function graphPathIntentFor(graphPath: string | undefined): GraphPathIntent {
  // Presence of the argument is the signal, never what the path spells. A
  // caller that supplied nothing made a default lookup, and calling it
  // explicit would skip classification and hand back an artifact path the
  // workspace may not have.
  return graphPath === undefined ? 'default' : 'explicit'
}

export function resolveWorkspaceGraphPath(
  graphPath: string | undefined,
  workspaceRoot: string | undefined,
  intent: GraphPathIntent,
): string {
  const requested = graphPath ?? `out/${CANONICAL_ARTIFACT_BASENAME}`
  const root = workspaceRoot ?? process.cwd()

  if (intent === 'default') {
    return resolveWorkspaceGraphArtifact({
      intent: 'default',
      requestedPath: requested,
      workspaceRoot: root,
    }).selectedPhysicalPath
  }

  const normalized = normalizeGraphPathSpelling(requested)
  if (normalized === `out/${LEGACY_ARTIFACT_BASENAME}` || normalized === `out/${CANONICAL_ARTIFACT_BASENAME}`) {
    const workspace = resolveMadarWorkspace(root)
    // Preserve the public relative default for normal checkouts. A linked
    // worktree is the only case that needs a redirected physical artifact.
    if (!workspace.isLinkedWorktree) return requested
    return normalized === `out/${CANONICAL_ARTIFACT_BASENAME}`
      ? workspace.canonicalGraphPath
      : workspace.legacyGraphPath
  }
  return requested
}

/**
 * Resolves a conventional `out` artifact path for the active workspace.
 *
 * This intentionally only redirects paths rooted at `out/`. Explicit paths
 * remain explicit, while built-in commands can keep using their established
 * relative defaults without creating a second `out` directory in a linked
 * worktree.
 */
export function resolveWorkspaceOutputPath(outputPath = 'out', workspaceRoot = process.cwd()): string {
  const normalized = outputPath.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '')
  if (normalized !== 'out' && !normalized.startsWith('out/')) {
    return outputPath
  }

  const workspace = resolveMadarWorkspace(workspaceRoot)
  if (!workspace.isLinkedWorktree) {
    return outputPath
  }

  if (normalized === 'out') {
    return workspace.outputDir
  }

  const suffix = normalized.slice('out/'.length).split('/').filter((segment) => segment.length > 0)
  return join(workspace.outputDir, ...suffix)
}

export function isLinkedGitWorktree(rootPath = '.'): boolean {
  return resolveMadarWorkspace(rootPath).isLinkedWorktree
}

/**
 * Reduces the ways a caller can spell the same relative artifact path to one
 * form, so `out/graph.madar`, `./out/graph.madar` and `out\graph.madar` are
 * never treated as three different requests.
 */
export function normalizeGraphPathSpelling(graphPath: string): string {
  return graphPath.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '')
}

/** The relative spellings that name a workspace's own artifact. */
const DEFAULT_GRAPH_PATH_SPELLINGS: ReadonlySet<string> = new Set([
  `out/${CANONICAL_ARTIFACT_BASENAME}`,
  `out/${LEGACY_ARTIFACT_BASENAME}`,
])

export function isDefaultGraphPathSpelling(graphPath: string): boolean {
  return DEFAULT_GRAPH_PATH_SPELLINGS.has(normalizeGraphPathSpelling(graphPath))
}

/**
 * The public spelling for an artifact a command actually used.
 *
 * Output that names a path -- Pack fields, governance freshness -- must not
 * echo the request, which after the cutover may be a tombstone, and must not
 * expose a linked worktree's redirected directory under .git. Any artifact
 * inside the workspace output directory is reported as `out/<name>`; anything
 * else was a deliberate path from the caller and is returned unchanged.
 */
/**
 * The artifact a command should read, given the options it was parsed with.
 *
 * Commands used to call loadGraph with their raw option string. That worked
 * only because loadGraph itself preferred the canonical artifact, which the
 * #705 mixed-state decision had to remove -- leaving those commands silently
 * reading a stale v1. Routing options through here applies the same intent
 * boundary every other surface uses, and throws GraphArtifactStateError for an
 * ambiguous workspace on a default load.
 */
export function graphPathForCommand(
  options: { readonly graphPath: string; readonly graphPathIntent: GraphPathIntent },
  workspaceRoot?: string,
): string {
  try {
    return resolveWorkspaceGraphPath(options.graphPath, workspaceRoot, options.graphPathIntent)
  } catch (error) {
    // A workspace with no graph at all is not ambiguous, and commands already
    // explain that case. Refusing it here would replace a familiar "run madar
    // generate ." path with a different error and break callers that supply
    // their own loader. Every ambiguous or damaged state still propagates.
    if (error instanceof GraphArtifactStateError && error.state === 'missing') {
      return resolveWorkspaceGraphPath(options.graphPath, workspaceRoot, 'explicit')
    }
    throw error
  }
}

export function logicalGraphPath(physicalPath: string, workspaceRoot = process.cwd()): string {
  const workspace = resolveMadarWorkspace(workspaceRoot)
  const resolved = resolve(physicalPath)
  return dirname(resolved) === workspace.outputDir
    ? `out/${basename(resolved)}`
    : physicalPath
}

export interface ResolveWorkspaceGraphArtifactOptions {
  /**
   * Whether the caller named this artifact or fell back to a default.
   *
   * Required, and never derived from the path: an omitted `--graph` and an
   * explicit `--graph out/graph.json` normalize to identical text but must
   * behave differently once a workspace is ambiguous.
   */
  readonly intent: GraphPathIntent
  /** Omit for the workspace default. */
  readonly requestedPath?: string
  readonly workspaceRoot?: string
  readonly maxBytes?: number
}

/**
 * Resolves a graph request against a real workspace.
 *
 * Default requests are answered from the workspace's own output directory,
 * which is redirected for a linked worktree. That redirected location is
 * physical only -- the logical path stays the conventional `out/...` spelling
 * so a private worktree directory never reaches a Pack field or public output.
 */
export function resolveWorkspaceGraphArtifact(
  options: ResolveWorkspaceGraphArtifactOptions,
): ResolvedGraphArtifactSelection {
  const workspace = resolveMadarWorkspace(options.workspaceRoot ?? process.cwd())
  const requestedPath = options.requestedPath ?? `out/${CANONICAL_ARTIFACT_BASENAME}`
  const treatAsWorkspaceDefault = options.intent === 'default' || isDefaultGraphPathSpelling(requestedPath)

  // An explicit path outside the workspace convention is used verbatim; only
  // conventional paths are redirected onto the workspace's own artifacts.
  const physicalRequest = treatAsWorkspaceDefault
    ? join(workspace.outputDir, basenameOfSpelling(requestedPath))
    : requestedPath

  const selection = resolveGraphArtifact(physicalRequest, {
    intent: options.intent,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    // Also governs refusals, which is where a linked worktree's private
    // directory would otherwise surface.
    ...(treatAsWorkspaceDefault ? { logicalOutputDir: 'out' } : {}),
  })

  if (!treatAsWorkspaceDefault) return { ...selection, requestedPath }

  // Report whichever artifact was actually chosen, under the conventional
  // spelling rather than the worktree's private physical directory.
  return {
    ...selection,
    requestedPath,
    selectedLogicalPath: `out/${basenameOfSpelling(selection.selectedPhysicalPath)}`,
  }
}

function basenameOfSpelling(graphPath: string): string {
  const normalized = normalizeGraphPathSpelling(graphPath)
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}
