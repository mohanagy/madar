import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export function findGitRoot(path: string): string | null {
  let current = resolve(path)
  while (true) {
    if (existsSync(join(current, '.git'))) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

/**
 * Lists tracked files plus untracked files that are not excluded by Git's
 * standard ignore rules. `null` means Git is unavailable or the path is not
 * inside a repository; an empty array is a valid empty worktree result.
 */
export function collectGitVisibleFiles(rootDir: string): string[] | null {
  const root = resolve(rootDir)

  let repoRoot: string
  try {
    repoRoot = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
  } catch {
    if (findGitRoot(root) !== null) {
      throw new Error(`Unable to determine the Git root for --respect-gitignore: ${root}`)
    }
    return null
  }

  try {
    const canonicalRoot = realpathSync(root)
    const canonicalRepoRoot = realpathSync(repoRoot)
    const relativeRoot = relative(canonicalRepoRoot, canonicalRoot)
    if (relativeRoot === '..' || relativeRoot.startsWith(`..${sep}`) || isAbsolute(relativeRoot)) {
      return null
    }

    let output: string
    try {
      output = execFileSync(
        'git',
        ['-C', canonicalRepoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', `:(literal)${relativeRoot || '.'}`],
        { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, windowsHide: true },
      )
    } catch {
      throw new Error(`Unable to list Git-visible files for --respect-gitignore: ${root}`)
    }

    return output
      .split('\0')
      .filter(Boolean)
      .map((repoRelativePath) => {
        const canonicalFilePath = resolve(canonicalRepoRoot, repoRelativePath)
        const rootRelativePath = relative(canonicalRoot, canonicalFilePath)
        if (rootRelativePath === '..' || rootRelativePath.startsWith(`..${sep}`) || isAbsolute(rootRelativePath)) {
          throw new Error(`Git returned a path outside the requested root for --respect-gitignore: ${root}`)
        }
        return resolve(root, rootRelativePath)
      })
  } catch (error) {
    if (error instanceof Error) {
      throw error
    }
    throw new Error(`Unable to resolve Git-visible files for --respect-gitignore: ${root}`)
  }
}

function gitOutput(rootDir: string, args: string[], trim = true): string {
  const output = execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return trim ? output.trim() : output
}

function mapRepoPathToProjectPath(projectDir: string, repoDir: string, repoRelativePath: string): string | null {
  const absolutePath = resolve(repoDir, repoRelativePath)
  const relativePath = relative(resolve(projectDir), absolutePath)
  if (relativePath === '' || relativePath === '.') {
    return ''
  }
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return null
  }
  return relativePath.replaceAll('\\', '/')
}

function parseStatusPaths(statusOutput: string): string[] {
  const entries = statusOutput.split('\0')
  const paths: string[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry === undefined) {
      continue
    }
    if (entry.length < 4 || entry[2] !== ' ') {
      continue
    }
    const status = entry.slice(0, 2)
    paths.push(entry.slice(3))
    if (status.includes('R') || status.includes('C')) {
      index += 1
    }
  }
  return paths
}

function dedupePaths(paths: Iterable<string>): string[] {
  return [...new Set([...paths].filter((path) => path.length > 0))].sort((left, right) => left.localeCompare(right))
}

export interface GitSnapshot {
  repoRoot: string
  headSha: string
  dirtyFiles: string[]
}

export function readGitSnapshot(projectDir: string): GitSnapshot | null {
  const repoRoot = findGitRoot(projectDir)
  if (repoRoot === null) {
    return null
  }

  try {
    const headSha = gitOutput(repoRoot, ['rev-parse', '--verify', 'HEAD'])
    const statusOutput = gitOutput(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], false)
    const dirtyFiles = dedupePaths(
      parseStatusPaths(statusOutput)
        .map((repoRelativePath) => mapRepoPathToProjectPath(projectDir, repoRoot, repoRelativePath))
        .filter((path): path is string => path !== null),
    )

    return {
      repoRoot,
      headSha,
      dirtyFiles,
    }
  } catch {
    return null
  }
}

export function diffGitFilesBetweenCommits(projectDir: string, fromSha: string, toSha: string): string[] {
  if (fromSha === toSha) {
    return []
  }

  const repoRoot = findGitRoot(projectDir)
  if (repoRoot === null) {
    return []
  }

  try {
    const output = gitOutput(repoRoot, ['diff', '--name-only', '-z', '--find-renames=50%', '--no-ext-diff', fromSha, toSha, '--'], false)
    return dedupePaths(
      output
        .split('\0')
        .filter((line) => line.length > 0)
        .map((repoRelativePath) => mapRepoPathToProjectPath(projectDir, repoRoot, repoRelativePath))
        .filter((path): path is string => path !== null),
    )
  } catch {
    return []
  }
}
