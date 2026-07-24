import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  collectGitVisibleFiles,
  diffGitFilesBetweenCommits,
  findGitRoot,
  readGitSnapshot,
} from '../../src/shared/git.js'

const sandboxes: string[] = []

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-git-'))
  sandboxes.push(root)
  git(root, 'init', '--quiet')
  git(root, 'config', 'user.name', 'Madar Tests')
  git(root, 'config', 'user.email', 'madar@example.test')
  writeFileSync(join(root, 'tracked.ts'), 'export const first = 1\n', 'utf8')
  mkdirSync(join(root, 'packages', 'app'), { recursive: true })
  writeFileSync(join(root, 'packages', 'app', 'nested.ts'), 'export const nested = true\n', 'utf8')
  writeFileSync(join(root, '.gitignore'), 'ignored.log\nignored-dir/\n', 'utf8')
  git(root, 'add', '.')
  git(root, 'commit', '--quiet', '-m', 'initial')
  return root
}

afterEach(() => {
  for (const root of sandboxes.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Git workspace helpers', () => {
  it('finds repositories from nested directories and returns null outside Git', () => {
    const root = repository()
    const nested = join(root, 'packages', 'app')
    expect(findGitRoot(nested)).toBe(root)

    const outside = mkdtempSync(join(tmpdir(), 'madar-not-git-'))
    sandboxes.push(outside)
    mkdirSync(join(outside, 'nested'))
    expect(findGitRoot(join(outside, 'nested'))).toBeNull()
  })

  it('lists tracked and untracked visible files while respecting ignore rules', () => {
    const root = repository()
    writeFileSync(join(root, 'untracked file.ts'), 'export const visible = true\n', 'utf8')
    writeFileSync(join(root, 'ignored.log'), 'ignored\n', 'utf8')
    mkdirSync(join(root, 'ignored-dir'))
    writeFileSync(join(root, 'ignored-dir', 'hidden.ts'), 'ignored\n', 'utf8')

    expect(collectGitVisibleFiles(root)?.map((path) => path.slice(root.length + 1)).sort()).toEqual([
      '.gitignore',
      'packages/app/nested.ts',
      'tracked.ts',
      'untracked file.ts',
    ])

    const outside = mkdtempSync(join(tmpdir(), 'madar-visible-no-git-'))
    sandboxes.push(outside)
    expect(collectGitVisibleFiles(outside)).toBeNull()
  })

  it('captures modified, untracked, deleted, and renamed paths for a project subtree', () => {
    const root = repository()
    const project = join(root, 'packages', 'app')
    writeFileSync(join(project, 'nested.ts'), 'export const nested = false\n', 'utf8')
    writeFileSync(join(project, 'new.ts'), 'export const added = true\n', 'utf8')
    writeFileSync(join(root, 'outside.ts'), 'export const outside = true\n', 'utf8')
    git(root, 'mv', 'tracked.ts', 'renamed.ts')

    const snapshot = readGitSnapshot(project)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.repoRoot).toBe(root)
    expect(snapshot?.headSha).toBe(git(root, 'rev-parse', 'HEAD'))
    expect(snapshot?.dirtyFiles).toEqual(['nested.ts', 'new.ts'])

    const rootSnapshot = readGitSnapshot(root)
    expect(rootSnapshot?.dirtyFiles).toEqual([
      'outside.ts',
      'packages/app/nested.ts',
      'packages/app/new.ts',
      'renamed.ts',
      'tracked.ts',
    ])
  })

  it('returns null snapshots for non-repositories and repositories without a commit', () => {
    const outside = mkdtempSync(join(tmpdir(), 'madar-snapshot-no-git-'))
    sandboxes.push(outside)
    expect(readGitSnapshot(outside)).toBeNull()

    const unborn = mkdtempSync(join(tmpdir(), 'madar-snapshot-unborn-'))
    sandboxes.push(unborn)
    git(unborn, 'init', '--quiet')
    expect(readGitSnapshot(unborn)).toBeNull()
  })

  it('reports sorted project-relative changes between commits and handles invalid boundaries', () => {
    const root = repository()
    const from = git(root, 'rev-parse', 'HEAD')
    writeFileSync(join(root, 'tracked.ts'), 'export const first = 2\n', 'utf8')
    writeFileSync(join(root, 'packages', 'app', 'added.ts'), 'export const added = true\n', 'utf8')
    writeFileSync(join(root, 'outside.ts'), 'export const outside = true\n', 'utf8')
    git(root, 'add', '.')
    git(root, 'commit', '--quiet', '-m', 'change files')
    const to = git(root, 'rev-parse', 'HEAD')

    expect(diffGitFilesBetweenCommits(join(root, 'packages', 'app'), from, to)).toEqual(['added.ts'])
    expect(diffGitFilesBetweenCommits(root, from, to)).toEqual([
      'outside.ts',
      'packages/app/added.ts',
      'tracked.ts',
    ])
    expect(diffGitFilesBetweenCommits(root, to, to)).toEqual([])
    expect(diffGitFilesBetweenCommits(root, 'not-a-commit', to)).toEqual([])

    const outside = mkdtempSync(join(tmpdir(), 'madar-diff-no-git-'))
    sandboxes.push(outside)
    expect(diffGitFilesBetweenCommits(outside, from, to)).toEqual([])
  })

  it('recognizes a linked Git worktree whose .git marker is a file', () => {
    const root = repository()
    const branch = `coverage-${Date.now()}`
    const worktree = mkdtempSync(join(tmpdir(), 'madar-linked-worktree-'))
    rmSync(worktree, { recursive: true, force: true })
    sandboxes.push(worktree)
    git(root, 'worktree', 'add', '--quiet', '-b', branch, worktree)

    expect(readFileSync(join(worktree, '.git'), 'utf8')).toContain('gitdir:')
    expect(findGitRoot(join(worktree, 'packages', 'app'))).toBe(resolve(worktree))
    expect(readGitSnapshot(worktree)).toEqual({
      repoRoot: resolve(worktree),
      headSha: git(worktree, 'rev-parse', 'HEAD'),
      dirtyFiles: [],
    })

    git(root, 'worktree', 'remove', '--force', worktree)
    const index = sandboxes.indexOf(worktree)
    if (index >= 0) sandboxes.splice(index, 1)
  })
})
