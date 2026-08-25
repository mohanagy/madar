import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { canonicalPathKey, samePath, worktreePaths } from './helpers/worktree-paths.js'

/**
 * The comparator that decides whether git is naming the main worktree.
 *
 * Two suites carried byte-identical copies of a raw string comparison between
 * `realpathSync(root)` and the paths in `git worktree list --porcelain`. On
 * Windows those two sources disagree in three independent ways at once --
 * separator, drive-letter case, and an extended-length prefix -- so the main
 * worktree was never excluded and both suites failed on the Windows lanes:
 * one worktree expected where two were seen, and none expected where one was.
 *
 * The platform-shaped cases below are asserted by driving the pure key
 * function directly rather than by fabricating a Windows filesystem, so they
 * run and mean something on every lane. The end-to-end cases use real git
 * worktrees, which is what proves the filter still excludes the right one.
 */

const created: string[] = []
afterAll(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const onWindows = process.platform === 'win32'

describe('WP-01 — the key folds exactly what the platform folds', () => {
  it('drops a trailing separator without collapsing the root', () => {
    expect(canonicalPathKey('/tmp/repo/')).toBe(canonicalPathKey('/tmp/repo'))
    // A lone separator names the root and must survive.
    expect(canonicalPathKey('/')).toBe('/')
  })

  it('strips the Windows extended-length prefix', () => {
    // `realpathSync` may return this form; git never emits it.
    expect(canonicalPathKey('\\\\?\\C:\\repo')).toBe(canonicalPathKey('C:\\repo'))
  })

  it.runIf(onWindows)('folds separators and drive-letter case on Windows', () => {
    expect(canonicalPathKey('C:\\Users\\runner\\repo')).toBe(canonicalPathKey('c:/users/runner/repo'))
    expect(canonicalPathKey('C:/repo/')).toBe(canonicalPathKey('c:\\repo'))
  })

  it.runIf(!onWindows)('keeps case distinct on POSIX, where it is distinct', () => {
    // Folding here would be a different defect: these are two directories.
    expect(canonicalPathKey('/tmp/Repo')).not.toBe(canonicalPathKey('/tmp/repo'))
  })

  it.runIf(!onWindows)('does not treat a backslash as a separator on POSIX', () => {
    // A backslash is a legal filename character on POSIX, so rewriting it
    // would merge two genuinely different paths.
    expect(canonicalPathKey('/tmp/a\\b')).toBe('/tmp/a\\b')
  })
})

describe('WP-02 — samePath survives a missing directory', () => {
  it('does not throw when a listed worktree has already been removed', () => {
    // git keeps listing a worktree until it is pruned, so the comparator meets
    // paths that no longer resolve. Throwing there would turn a stale entry
    // into a suite-wide failure.
    const gone = join(tmpdir(), 'madar-worktree-never-existed-000')
    expect(() => samePath(gone, tmpdir())).not.toThrow()
    expect(samePath(gone, tmpdir())).toBe(false)
  })

  it('matches a directory against itself through any spelling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madar-wp-self-'))
    created.push(dir)
    expect(samePath(dir, dir)).toBe(true)
    expect(samePath(`${dir}/`, dir)).toBe(true)
  })
})

describe('WP-03 — the real filter excludes the main worktree and keeps the rest', () => {
  function repository(): string {
    const repo = mkdtempSync(join(tmpdir(), 'madar-wp-repo-'))
    created.push(repo)
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
    git('init', '--quiet')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'test')
    writeFileSync(join(repo, 'file.txt'), 'contents\n')
    git('add', 'file.txt')
    git('commit', '--quiet', '-m', 'initial')
    return repo
  }

  it('reports none for a repository with only its main worktree', () => {
    // The exact assertion that failed on Windows: the main worktree was never
    // excluded, so this saw one where none belonged.
    expect(worktreePaths(repository())).toEqual([])
  })

  it('reports exactly the added worktree', () => {
    const repo = repository()
    const extra = join(mkdtempSync(join(tmpdir(), 'madar-wp-extra-')), 'wt')
    created.push(extra)
    execFileSync('git', ['worktree', 'add', '--quiet', extra, '-b', 'wp-branch'], { cwd: repo })

    const found = worktreePaths(repo)
    expect(found).toHaveLength(1)
    expect(samePath(found[0] as string, extra)).toBe(true)
    expect(samePath(found[0] as string, repo)).toBe(false)
  })

  it('reports none again after the worktree is removed', () => {
    const repo = repository()
    const extra = join(mkdtempSync(join(tmpdir(), 'madar-wp-cycle-')), 'wt')
    created.push(extra)
    execFileSync('git', ['worktree', 'add', '--quiet', extra, '-b', 'wp-cycle'], { cwd: repo })
    expect(worktreePaths(repo)).toHaveLength(1)

    execFileSync('git', ['worktree', 'remove', '--force', extra], { cwd: repo })
    expect(worktreePaths(repo)).toEqual([])
  })
})
