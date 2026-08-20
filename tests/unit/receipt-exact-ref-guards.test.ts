import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  assertCleanTree,
  assertDistinctArms,
  assertFreshBuild,
  partitionSessions,
  resolveExactCommit,
  sessionIsComparable,
} from '../../scripts/lib/receipt-guards.mjs'

/** Isolated temporary repositories, never the active checkout. */
let repo: string
let firstSha: string
let secondSha: string
const created: string[] = []

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' })

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'madar-guards-repo-'))
  created.push(repo)
  git(repo, 'init', '--quiet')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'file.txt'), 'one\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'first')
  firstSha = git(repo, 'rev-parse', 'HEAD').trim()
  writeFileSync(join(repo, 'file.txt'), 'two\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'second')
  secondSha = git(repo, 'rev-parse', 'HEAD').trim()
})

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('M1-05 — a baseline ref resolves to an exact commit or refuses', () => {
  it('resolves a full sha', () => {
    expect(resolveExactCommit(repo, firstSha)).toBe(firstSha)
  })

  it('resolves a short sha to the full commit', () => {
    expect(resolveExactCommit(repo, firstSha.slice(0, 8))).toBe(firstSha)
  })

  it('refuses an unresolvable ref', () => {
    expect(() => resolveExactCommit(repo, 'no-such-ref')).toThrow(/cannot be resolved/)
  })

  it('refuses an empty ref rather than defaulting to HEAD', () => {
    // Silently defaulting would compare a head with itself and report a ratio.
    expect(() => resolveExactCommit(repo, '')).toThrow(/baseline ref is required/)
    expect(() => resolveExactCommit(repo, undefined as never)).toThrow(/baseline ref is required/)
  })

  it('does not resolve a ref to the candidate head by accident', () => {
    expect(resolveExactCommit(repo, firstSha)).not.toBe(secondSha)
  })
})

describe('M1-05 — a dirty tree cannot be measured', () => {
  it('accepts a clean tree', () => {
    expect(() => assertCleanTree(repo)).not.toThrow()
  })

  it('refuses an uncommitted change', () => {
    writeFileSync(join(repo, 'file.txt'), 'dirty\n')
    expect(() => assertCleanTree(repo)).toThrow(/dirty tree/)
  })

  it('refuses an untracked file', () => {
    writeFileSync(join(repo, 'extra.txt'), 'x\n')
    expect(() => assertCleanTree(repo)).toThrow(/dirty tree/)
  })
})

describe('M1-05 — an arm must carry its own build', () => {
  it('accepts a worktree that built its own dist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madar-guards-dist-'))
    created.push(dir)
    mkdirSync(join(dir, 'dist/src/pipeline'), { recursive: true })
    writeFileSync(join(dir, 'dist/src/pipeline/build.js'), 'export const x = 1\n')
    expect(() => assertFreshBuild(dir, firstSha)).not.toThrow()
  })

  it('refuses a worktree with no dist rather than reusing another', () => {
    // Reusing whatever dist happens to be present measures the current head
    // twice and reports the ratio as a comparison.
    const dir = mkdtempSync(join(tmpdir(), 'madar-guards-nodist-'))
    created.push(dir)
    expect(() => assertFreshBuild(dir, firstSha)).toThrow(/produced no dist/)
  })
})

describe('M1-05 — both arms must have received the same bytes', () => {
  const session = (baseSum: string, headSum: string) => ({
    order: 'baseline-first',
    base: { inputChecksum: baseSum },
    head: { inputChecksum: headSum },
  })

  it('accepts a session whose arms agree', () => {
    expect(sessionIsComparable(session('abc', 'abc') as never)).toBe(true)
  })

  it('rejects a session whose arms disagree', () => {
    expect(sessionIsComparable(session('abc', 'def') as never)).toBe(false)
  })

  it('invalidates rather than silently dropping a mismatched session', () => {
    const { usable, invalidated } = partitionSessions(
      [session('abc', 'abc'), session('abc', 'def')] as never,
      'src-only',
    )
    expect(usable).toHaveLength(1)
    expect(invalidated).toEqual([
      { scope: 'src-only', order: 'baseline-first', reason: 'arms did not receive identical input' },
    ])
  })

  it('reports every mismatched session, not just the first', () => {
    const { usable, invalidated } = partitionSessions(
      [session('a', 'b'), session('c', 'd')] as never,
      'src-only',
    )
    expect(usable).toEqual([])
    expect(invalidated).toHaveLength(2)
  })
})

describe('M1-05 — the arms must be different commits', () => {
  it('accepts two distinct commits', () => {
    expect(() => assertDistinctArms(firstSha, secondSha)).not.toThrow()
  })

  it('refuses a baseline that resolved to the candidate head', () => {
    // The mutation this guards against: resolving --baseline-ref to HEAD would
    // produce a plausible ~1.00x ratio that means nothing at all.
    expect(() => assertDistinctArms(secondSha, secondSha)).toThrow(/same commit/)
  })
})

describe('M1-05 — the runner refuses to qualify without a comparison', () => {
  it('exits non-zero with no baseline and no explicit corpus-only', () => {
    let status = 0
    let stderr = ''
    try {
      execFileSync(process.execPath, [join(process.cwd(), 'scripts/verify-integrity-receipts.mjs')], {
        cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const failure = error as { status?: number; stderr?: string }
      status = failure.status ?? 0
      stderr = failure.stderr ?? ''
    }
    expect(status).toBe(2)
    expect(stderr).toContain('refusing to produce a receipt with no comparison')
  }, 120_000)
})
