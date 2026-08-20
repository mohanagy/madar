import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createResourceRegistry,
  directoryCleanup,
  installSignalCoordinator,
  worktreeCleanup,
} from '../../scripts/lib/resource-registry.mjs'

/**
 * These run against isolated temporary repositories, never the active checkout.
 * The whole point is to prove that a failed or interrupted run leaves nothing
 * behind, and a test that could leave something behind in the real repository
 * would be proving it at the repository's expense.
 */
let repo: string
const created: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function worktreePaths(root: string): string[] {
  // Compared through realpath: on macOS the temp root is a symlink, and git
  // reports the resolved path, so a naive string compare fails to exclude the
  // main worktree.
  const main = realpathSync(root)
  return git(root, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((path) => realpathSync(path) !== main)
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'madar-registry-repo-'))
  created.push(repo)
  git(repo, 'init', '--quiet')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'file.txt'), 'one\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'first')
})

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true })
})

function addWorktree(): { dir: string; token: number; registry: ReturnType<typeof createResourceRegistry> } {
  const registry = createResourceRegistry()
  const dir = mkdtempSync(join(tmpdir(), 'madar-registry-wt-'))
  created.push(dir)
  rmSync(dir, { recursive: true, force: true })
  const token = registry.register(`worktree ${dir}`, worktreeCleanup(repo, dir))
  git(repo, 'worktree', 'add', '--detach', '--quiet', dir, 'HEAD')
  return { dir, token, registry }
}

describe('E1-04 — one registry cleans every resource', () => {
  it('removes a worktree registration and its directory on success', () => {
    const { dir, registry } = addWorktree()
    expect(worktreePaths(repo)).toHaveLength(1)

    registry.cleanupAll()

    expect(worktreePaths(repo)).toEqual([])
    expect(existsSync(dir)).toBe(false)
    expect(registry.outstanding).toEqual([])
  })

  it('cleans an inner resource even when an outer one was registered first', () => {
    // The exact defect: nested per-helper signal handlers meant the outermost
    // ran first, exited, and the inner worktree leaked.
    const registry = createResourceRegistry()
    const outer = mkdtempSync(join(tmpdir(), 'madar-registry-outer-'))
    const inner = mkdtempSync(join(tmpdir(), 'madar-registry-inner-'))
    created.push(outer, inner)
    rmSync(outer, { recursive: true, force: true })
    rmSync(inner, { recursive: true, force: true })

    registry.register(`outer ${outer}`, worktreeCleanup(repo, outer))
    git(repo, 'worktree', 'add', '--detach', '--quiet', outer, 'HEAD')
    registry.register(`inner ${inner}`, worktreeCleanup(repo, inner))
    git(repo, 'worktree', 'add', '--detach', '--quiet', inner, 'HEAD')
    expect(worktreePaths(repo)).toHaveLength(2)

    registry.cleanupAll()

    expect(worktreePaths(repo)).toEqual([])
    expect(existsSync(outer)).toBe(false)
    expect(existsSync(inner)).toBe(false)
  })

  it('cleans remaining resources when one cleanup itself fails', () => {
    const warnings: string[] = []
    const registry = createResourceRegistry({ onWarning: (message) => warnings.push(message) })
    const survivor = mkdtempSync(join(tmpdir(), 'madar-registry-survivor-'))
    created.push(survivor)

    registry.register('exploding resource', () => { throw new Error('cleanup exploded') })
    registry.register(`survivor ${survivor}`, directoryCleanup(survivor))

    registry.cleanupAll()

    // Best effort: the failure is reported, and everything else still goes.
    expect(existsSync(survivor)).toBe(false)
    expect(registry.outstanding).toEqual([])
    expect(warnings.join(' ')).toContain('cleanup exploded')
  })

  it('is idempotent', () => {
    const { dir, registry } = addWorktree()
    registry.cleanupAll()
    expect(() => registry.cleanupAll()).not.toThrow()
    expect(existsSync(dir)).toBe(false)
    expect(worktreePaths(repo)).toEqual([])
  })

  it('releases a single resource without disturbing the others', () => {
    const registry = createResourceRegistry()
    const first = mkdtempSync(join(tmpdir(), 'madar-registry-a-'))
    const second = mkdtempSync(join(tmpdir(), 'madar-registry-b-'))
    created.push(first, second)
    const token = registry.register(`first ${first}`, directoryCleanup(first))
    registry.register(`second ${second}`, directoryCleanup(second))

    registry.release(token)

    expect(existsSync(first)).toBe(false)
    expect(existsSync(second)).toBe(true)
    expect(registry.outstanding).toHaveLength(1)
  })
})

describe('E1-04 — failure paths leave nothing behind', () => {
  it('cleans up when the work throws after both worktrees exist', () => {
    const registry = createResourceRegistry()
    for (const label of ['baseline', 'candidate']) {
      const dir = mkdtempSync(join(tmpdir(), `madar-registry-${label}-`))
      created.push(dir)
      rmSync(dir, { recursive: true, force: true })
      registry.register(`${label} ${dir}`, worktreeCleanup(repo, dir))
      git(repo, 'worktree', 'add', '--detach', '--quiet', dir, 'HEAD')
    }
    expect(worktreePaths(repo)).toHaveLength(2)

    try {
      throw new Error('candidate build failed')
    } catch {
      registry.cleanupAll()
    }

    expect(worktreePaths(repo)).toEqual([])
  })

  it('cleans up a shared input directory when an arm throws', () => {
    const registry = createResourceRegistry()
    const inputDir = mkdtempSync(join(tmpdir(), 'madar-registry-input-'))
    created.push(inputDir)
    mkdirSync(join(inputDir, 'nested'), { recursive: true })
    writeFileSync(join(inputDir, 'extraction.json'), '{}')
    const token = registry.register(`shared input ${inputDir}`, directoryCleanup(inputDir))

    expect(() => {
      try {
        throw new Error('arm failed')
      } finally {
        // Previously this removal sat after the arms rather than in a finally,
        // so a throwing arm skipped it entirely.
        registry.release(token)
      }
    }).toThrow('arm failed')

    expect(existsSync(inputDir)).toBe(false)
    expect(registry.outstanding).toEqual([])
  })
})

describe('E1-04 — one signal coordinator, cleanup before exit', () => {
  let installed: (() => void) | null = null
  afterEach(() => {
    installed?.()
    installed = null
  })

  it('cleans every resource on SIGINT and exits 130', async () => {
    const registry = createResourceRegistry()
    const dir = mkdtempSync(join(tmpdir(), 'madar-registry-sigint-'))
    created.push(dir)
    rmSync(dir, { recursive: true, force: true })
    registry.register(`worktree ${dir}`, worktreeCleanup(repo, dir))
    git(repo, 'worktree', 'add', '--detach', '--quiet', dir, 'HEAD')

    const codes: number[] = []
    // Resolved from inside the exit callback, which the coordinator invokes only
    // after children are reaped and every resource is cleaned. Awaiting it is
    // the ordering assertion.
    const exited = new Promise<void>((resolve) => {
      installed = installSignalCoordinator(registry, {
        exit: (code) => { codes.push(code); resolve() },
      })
    })
    process.emit('SIGINT')
    await exited

    expect(worktreePaths(repo)).toEqual([])
    expect(existsSync(dir)).toBe(false)
    expect(codes).toEqual([130])
    expect(registry.interrupted).toBe(true)
  })

  it('cleans every resource on SIGTERM and exits 143', async () => {
    const registry = createResourceRegistry()
    const dir = mkdtempSync(join(tmpdir(), 'madar-registry-sigterm-'))
    created.push(dir)
    rmSync(dir, { recursive: true, force: true })
    registry.register(`worktree ${dir}`, worktreeCleanup(repo, dir))
    git(repo, 'worktree', 'add', '--detach', '--quiet', dir, 'HEAD')

    const codes: number[] = []
    const exited = new Promise<void>((resolve) => {
      installed = installSignalCoordinator(registry, {
        exit: (code) => { codes.push(code); resolve() },
      })
    })
    process.emit('SIGTERM')
    await exited

    expect(worktreePaths(repo)).toEqual([])
    expect(codes).toEqual([143])
  })

  it('cleans resources owned by every nesting level on one signal', async () => {
    const registry = createResourceRegistry()
    const dirs = ['outer', 'inner'].map((label) => {
      const dir = mkdtempSync(join(tmpdir(), `madar-registry-sig-${label}-`))
      created.push(dir)
      rmSync(dir, { recursive: true, force: true })
      registry.register(`${label} ${dir}`, worktreeCleanup(repo, dir))
      git(repo, 'worktree', 'add', '--detach', '--quiet', dir, 'HEAD')
      return dir
    })
    expect(worktreePaths(repo)).toHaveLength(2)

    const exited = new Promise<void>((resolve) => {
      installed = installSignalCoordinator(registry, { exit: () => resolve() })
    })
    process.emit('SIGINT')
    await exited

    expect(worktreePaths(repo)).toEqual([])
    for (const dir of dirs) expect(existsSync(dir)).toBe(false)
  })

  it('leaves the original repository untouched', () => {
    const { registry } = addWorktree()
    const before = git(repo, 'status', '--porcelain')
    const head = git(repo, 'rev-parse', 'HEAD')

    registry.cleanupAll()

    expect(git(repo, 'status', '--porcelain')).toBe(before)
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
  })
})
