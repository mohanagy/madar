import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

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
  if (existsSync(outputDir) && lstatSync(outputDir).isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked Madar output directory: ${outputDir}`)
  }

  return {
    rootPath: sourceRoot,
    worktreeRoot,
    gitCommonDir,
    isLinkedWorktree,
    artifactRoot,
    outputDir,
    graphPath: join(outputDir, 'graph.json'),
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
