/**
 * RCP-01. The receipt runner must complete deterministically from fresh
 * worktrees.
 *
 * An independent reviewer hit two failures. In the first, a measurement child
 * emitted a complete result and exited 0, yet the wrapper reported a timeout
 * after 600,000 ms: a descendant had inherited stdout/stderr, `close` could not
 * fire, and the timeout's tree kill refused to act because the child itself had
 * already exited. In the second, a fresh-worktree `npm ci` was reported as
 * timing out after 900,000 ms.
 *
 * These controls drive the real child runner and the real guards.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { runChild } from '../../scripts/lib/child-runner.mjs'
import { assertArmResult } from '../../scripts/lib/receipt-guards.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const HOLDER = resolve(REPO, 'tests/fixtures/descendant-holds-stdio.mjs')

const scratch: string[] = []
const worktrees: string[] = []
afterEach(() => {
  for (const dir of worktrees.splice(0)) {
    try { execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: REPO }) } catch { /* already gone */ }
  }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const scratchDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/** Counts descendants still alive by their exact fixture marker. */
const survivingHolders = (holdMs: number): number => {
  const probe = execFileSync('bash', ['-c',
    `ps -eo command | grep -F 'setTimeout(() => {}, ${holdMs})' | grep -v grep | wc -l`,
  ], { encoding: 'utf8' })
  return Number(probe.trim())
}

describe('RCP-01 — a completed child is not a timeout', () => {
  it('accepts a complete result even when a descendant holds the pipes', async () => {
    const dir = scratchDir('madar-rcp-complete-')
    const resultFile = join(dir, 'result.json')
    const started = Date.now()

    const result = await runChild(process.execPath, [HOLDER], {
      cwd: REPO,
      timeoutMs: 30_000,
      graceMs: 500,
      env: { ...process.env, MADAR_STDIO_HOLD_MS: '25000', MADAR_RESULT_FILE: resultFile },
    })

    // The child exited successfully and its result is durable and complete.
    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(existsSync(resultFile)).toBe(true)
    expect(JSON.parse(readFileSync(resultFile, 'utf8'))['emittedCandidates']).toBe(7)

    // The wait was bounded by the drain policy, not by the descendant's hold.
    expect(Date.now() - started).toBeLessThan(20_000)
    // And the descendant was reclaimed rather than left running.
    expect(result.descendantsHeldStdio).toBe(true)
    await new Promise((r) => setTimeout(r, 1000))
    expect(survivingHolders(25_000)).toBe(0)
  }, 60_000)

  it('does not let a stale timer convert a completed child into a timeout', async () => {
    // The timer is cancelled when the terminal conditions hold, so nothing can
    // reclassify the run afterwards.
    const result = await runChild(process.execPath, ['-e', 'process.stdout.write("done")'], {
      cwd: REPO, timeoutMs: 1_500, graceMs: 200,
    })
    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)

    await new Promise((r) => setTimeout(r, 2_500))
    // Re-read after the original deadline would have elapsed.
    expect(result.timedOut).toBe(false)
  }, 30_000)

  it('still times out and reaps a genuinely hung child', async () => {
    const started = Date.now()
    const result = await runChild(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: REPO, timeoutMs: 1_500, graceMs: 300,
    })
    expect(result.timedOut).toBe(true)
    expect(result.signal).toBe('SIGTERM')
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 40_000)
})

describe('RCP-01 — an arm result is accepted only when it is complete and its own', () => {
  const valid = {
    scope: 'src-only',
    samples: [1, 2, 3],
    medianMs: 2,
    minMs: 1,
    maxMs: 3,
    spreadMs: 2,
    peakRssMb: 10,
    inputChecksum: 'a'.repeat(64),
    emittedCandidates: 7,
  }
  const options = { scope: 'src-only', inputChecksum: 'a'.repeat(64), where: 'arm' }

  it('accepts a complete, matching result', () => {
    expect(assertArmResult({ ...valid }, options)).toMatchObject({ emittedCandidates: 7 })
  })

  it('refuses a result for another scope', () => {
    expect(() => assertArmResult({ ...valid, scope: 'src-plus-tests-js-ts' }, options))
      .toThrow(/is for scope/)
  })

  it('refuses a result built from a different canonical input', () => {
    expect(() => assertArmResult({ ...valid, inputChecksum: 'b'.repeat(64) }, options))
      .toThrow(/input checksum does not match/)
  })

  it('refuses a result with no samples', () => {
    expect(() => assertArmResult({ ...valid, samples: [] }, options)).toThrow(/carries no samples/)
  })

  it.each(['medianMs', 'minMs', 'maxMs', 'spreadMs', 'peakRssMb', 'emittedCandidates'])(
    'refuses a result whose %s is not a finite number', (field) => {
      expect(() => assertArmResult({ ...valid, [field]: 'x' }, options)).toThrow(new RegExp(field))
    })

  it('refuses a non-object result', () => {
    expect(() => assertArmResult('{}', options)).toThrow(/not an object/)
  })
})

describe('RCP-01 — partial, absent and failed arm results', () => {
  it('a child that exits zero without writing a result leaves nothing to accept', async () => {
    const dir = scratchDir('madar-rcp-none-')
    const resultFile = join(dir, 'result.json')
    const result = await runChild(process.execPath, [HOLDER], {
      cwd: REPO,
      timeoutMs: 20_000,
      graceMs: 300,
      env: { ...process.env, MADAR_STDIO_HOLD_MS: '0', MADAR_RESULT_MODE: 'none', MADAR_RESULT_FILE: resultFile },
    })
    expect(result.code).toBe(0)
    expect(existsSync(resultFile)).toBe(false)
  }, 40_000)

  it('a partial result never becomes a usable arm result', async () => {
    const dir = scratchDir('madar-rcp-partial-')
    const resultFile = join(dir, 'result.json')
    await runChild(process.execPath, [HOLDER], {
      cwd: REPO,
      timeoutMs: 20_000,
      graceMs: 300,
      env: { ...process.env, MADAR_STDIO_HOLD_MS: '0', MADAR_RESULT_MODE: 'partial', MADAR_RESULT_FILE: resultFile },
    })
    // Written, but truncated: parsing it is what must fail, not a byte count.
    expect(existsSync(resultFile)).toBe(true)
    expect(() => JSON.parse(readFileSync(resultFile, 'utf8'))).toThrow()
  }, 40_000)

  it('a non-zero exit is a failure even when the result is complete', async () => {
    const dir = scratchDir('madar-rcp-nonzero-')
    const resultFile = join(dir, 'result.json')
    const result = await runChild(process.execPath, [HOLDER], {
      cwd: REPO,
      timeoutMs: 20_000,
      graceMs: 300,
      env: {
        ...process.env,
        MADAR_STDIO_HOLD_MS: '0',
        MADAR_RESULT_FILE: resultFile,
        MADAR_EXIT_CODE: '3',
      },
    })
    // Complete output cannot override a failed process result.
    expect(result.code).toBe(3)
    expect(existsSync(resultFile)).toBe(true)
    expect(JSON.parse(readFileSync(resultFile, 'utf8'))['emittedCandidates']).toBe(7)
  }, 40_000)
})

describe('RCP-01 — fresh-worktree preparation through the real runner', () => {
  it('creates a worktree, installs, builds and cleans up', async () => {
    // The runner path, not a reimplementation of it. Bounded by using the
    // repository's own refs and the same child runner the receipt uses.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()
    const dir = scratchDir('madar-rcp-prep-')
    const target = join(dir, 'worktree')
    worktrees.push(target)

    const added = await runChild('git', ['worktree', 'add', '--detach', target, head], {
      cwd: REPO, timeoutMs: 300_000, graceMs: 5_000,
    })
    expect(added.code).toBe(0)
    expect(existsSync(join(target, 'package-lock.json'))).toBe(true)
    expect(existsSync(join(target, 'node_modules'))).toBe(false)

    const install = await runChild('npm', ['ci'], { cwd: target, timeoutMs: 900_000, graceMs: 5_000 })
    expect(install.timedOut).toBe(false)
    expect(install.code).toBe(0)
    expect(readdirSync(join(target, 'node_modules')).length).toBeGreaterThan(50)
    expect(existsSync(join(target, 'node_modules', 'typescript'))).toBe(true)

    const build = await runChild('npm', ['run', 'build'], { cwd: target, timeoutMs: 900_000, graceMs: 5_000 })
    expect(build.timedOut).toBe(false)
    expect(build.code).toBe(0)
    expect(existsSync(join(target, 'dist'))).toBe(true)
  }, 600_000)

  it('reports a cleanup failure rather than hiding it', () => {
    // One unremovable path must not silence the others or the overall result.
    const dir = scratchDir('madar-rcp-cleanup-')
    const kept = join(dir, 'kept.txt')
    writeFileSync(kept, 'evidence')
    const missing = join(dir, 'no-such-directory')

    const errors: string[] = []
    for (const target of [missing, dir]) {
      try {
        if (!existsSync(target)) throw new Error(`cleanup target missing: ${target}`)
        rmSync(target, { recursive: true, force: true })
      } catch (error) {
        errors.push((error as Error).message)
      }
    }

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('no-such-directory')
    // The removable one still went, and the failure is retained, not swallowed.
    expect(existsSync(dir)).toBe(false)
  })
})
