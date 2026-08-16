import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  CANONICAL_ARTIFACT_BASENAME,
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
  /**
   * Legacy alias for {@link legacyGraphPath}.
   *
   * @deprecated Name the artifact you mean. Consumers migrate to
   * `canonicalGraphPath` or an intent-carrying selection.
   */
  graphPath: string
}

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
    graphPath: legacyGraphPath,
  }
}

export function resolveMadarOutputDirectory(rootPath = '.'): string {
  return resolveMadarWorkspace(rootPath).outputDir
}

/**
 * Resolves the conventional graph path for the active workspace. Explicit
 * graph paths are left alone so users can still serve an arbitrary artifact.
 */
export function resolveWorkspaceGraphPath(graphPath = 'out/graph.json', workspaceRoot = process.cwd()): string {
  const normalized = graphPath.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '')
  if (normalized === 'out/graph.json') {
    const workspace = resolveMadarWorkspace(workspaceRoot)
    // Preserve the public relative default for normal checkouts. A linked
    // worktree is the only case that needs a redirected physical artifact.
    return workspace.isLinkedWorktree ? workspace.graphPath : graphPath
  }
  return graphPath
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
