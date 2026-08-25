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
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { ownedTimerCount, runChild } from '../../scripts/lib/child-runner.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const HOLDER = resolve(REPO, 'tests/fixtures/descendant-holds-stdio.mjs')
// `npm` is a .cmd shim on Windows, which `spawn` cannot execute by bare name,
// so the whole worktree-preparation control failed there before it could
// exercise anything it was written to prove.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const scratch: string[] = []
const worktrees: string[] = []

/**
 * Descendant markers this file handed out, and the reaper that owns them.
 *
 * A control that provokes a failure owns what the failure leaves behind. When
 * the runner is mutated to settle without proving emptiness, the descendant
 * survives -- that IS the catch -- but it kept running for its full lifetime and
 * the next run of this suite counted it as its own survivor, failing a control
 * that had done nothing wrong. Measured directly: with the tree-proof mutant
 * applied, strays went 0 -> 1 and stayed 1 for at least 25s.
 *
 * Killing by marker is a name match, which the runner under test must never do.
 * It is sound HERE and only here: the token is minted per test process, embedded
 * by this file's own fixture, and so cannot name anything this control did not
 * create.
 */
const descendantMarkers: string[] = []

const newDescendantMarker = (): string => {
  const marker = `madar-owned-desc-${process.pid}-${randomUUID().slice(0, 8)}`
  descendantMarkers.push(marker)
  return marker
}

/**
 * Lists `pid command` for every running process, in the platform's own way.
 *
 * `ps` and `bash` do not exist on Windows, and these controls have to run
 * there: what they prove -- that no owned descendant survives resolution -- is
 * a semantic guarantee, not a POSIX one. PowerShell's process table is the
 * Windows equivalent, and both produce the same two-column shape, so every
 * caller below is unchanged.
 */
function processTable(): string {
  if (process.platform === 'win32') {
    return execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
    ], { encoding: 'utf8', maxBuffer: 1 << 26 })
  }
  return execFileSync('ps', ['-eo', 'pid,command'], { encoding: 'utf8', maxBuffer: 1 << 26 })
}

/** Rows of the process table carrying `marker`, never the probe itself. */
function markedRows(marker: string): string[] {
  return processTable()
    .split('\n')
    .filter((line) => line.includes(marker))
    // The probe's own command line mentions the marker on some shells.
    .filter((line) => !line.includes('Get-CimInstance'))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Counts processes still carrying one of this run's markers. */
const livingMarked = (marker: string): number => markedRows(marker).length

const reapMarked = (marker: string): void => {
  for (const line of markedRows(marker)) {
    const pid = Number(line.trim().split(/\s+/)[0])
    if (Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
}

afterEach(() => {
  for (const marker of descendantMarkers.splice(0)) reapMarked(marker)
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
  return markedRows(`setTimeout(() => {}, ${holdMs})`).length
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
    // Proved by OWNERSHIP, not by outrunning a deadline.
    //
    // Two earlier versions of this control raced the timeout: a trivial child
    // settles in ~30 ms, but under a concurrently running suite doing git
    // worktree I/O the same spawn was measured at 30 ms, 213 ms and 1,162 ms in
    // succession. Any fixed bound is a race against unrelated load, and
    // widening it only moves the failure.
    //
    // The real invariant is that settlement leaves no owned timer alive, so
    // there is nothing left that could reclassify the result. That is checked
    // directly and is independent of how long anything took.
    const result = await runChild(process.execPath, ['-e', 'process.stdout.write("done")'], {
      cwd: REPO, timeoutMs: 10_000, graceMs: 200,
    })
    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
    expect(ownedTimerCount()).toBe(0)

    // Nothing appears later either, and the settled result does not change.
    await new Promise((r) => setTimeout(r, 1_000))
    expect(ownedTimerCount()).toBe(0)
    expect(result.timedOut).toBe(false)
  }, 60_000)

  it('leaves zero runner-owned timers after every settlement path', async () => {
    // §4.4: not just the happy path. Each entry settles through a different
    // branch, and none may leave an owned timer behind.
    // Runner-owned timers, not process-wide ones: getActiveResourcesInfo()
    // counts the whole process, and inside a test worker that includes the
    // framework's own timers, so it fails for reasons this control does not own.
    const timers = (): number => ownedTimerCount()
    const paths: Array<[string, () => Promise<unknown>]> = [
      ['normal success', () => runChild(process.execPath, ['-e', 'process.stdout.write("ok")'], {
        cwd: REPO, timeoutMs: 20_000, graceMs: 300,
      })],
      ['ordinary non-zero exit', () => runChild(process.execPath, ['-e', 'process.exit(4)'], {
        cwd: REPO, timeoutMs: 20_000, graceMs: 300,
      })],
      ['timeout with cooperative TERM', () => runChild(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        cwd: REPO, timeoutMs: 800, graceMs: 300,
      })],
      ['timeout with force kill', () => runChild(process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"], {
          cwd: REPO, timeoutMs: 800, graceMs: 300,
        })],
      ['descendant-held stdio reclamation', () => runChild(process.execPath, [HOLDER], {
        cwd: REPO, timeoutMs: 20_000, graceMs: 300,
        env: { ...process.env, MADAR_STDIO_HOLD_MS: '20000' },
      })],
      ['spawn failure', () => runChild(resolve(tmpdir(), 'madar-no-such-binary-ever'), [], {
        cwd: REPO, timeoutMs: 20_000, graceMs: 300,
      }).catch(() => undefined)],
    ]

    for (const [label, run] of paths) {
      await run()
      expect(timers(), `${label} left an owned timer active`).toBe(0)
    }

    // And still zero once every former deadline has elapsed.
    await new Promise((r) => setTimeout(r, 2_000))
    expect(timers()).toBe(0)
  }, 120_000)

  it('still times out and reaps a genuinely hung child', async () => {
    const started = Date.now()
    const result = await runChild(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: REPO, timeoutMs: 1_500, graceMs: 300,
    })
    expect(result.timedOut).toBe(true)
    // The semantic verdict, which is the same on every platform. Asserting
    // `result.signal` here asserted a POSIX implementation detail: Windows
    // terminates through an exit code and reports a null signal, so the
    // Windows lanes failed with `expected null to be 'SIGTERM'` for a child
    // that had in fact been terminated exactly as intended.
    expect(result.outcome).toBe('timed_out')
    // The raw OS fields stay truthful rather than normalised, and are asserted
    // for what each platform actually produces.
    if (process.platform === 'win32') {
      expect(result.signal).toBeNull()
    } else {
      expect(result.signal).toBe('SIGTERM')
    }
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 40_000)
})

describe('C2 — success requires the owned process tree to be empty', () => {
  /**
   * Distinct from the held-stdio case. There the descendant INHERITS the pipes,
   * so `close` is late and the drain path reclaims it. Here the descendant
   * closes its stdio, so `close` fires immediately and a runner that keys
   * success off stdio closure settles while an owned process is still running.
   *
   * The mutation matrix found this gap: a mutant that settled before proving
   * tree emptiness survived, because no control covered a closed-stdio
   * descendant.
   */
  const OWNED = resolve(REPO, 'tests/fixtures/owned-descendant.mjs')
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true } catch { return false }
  }

  it('reaps a cooperative closed-stdio descendant before resolving', async () => {
    const result = await runChild(process.execPath, [OWNED], {
      cwd: REPO, timeoutMs: 30_000, graceMs: 500,
      env: { ...process.env, MADAR_DESC_LIFE_MS: '60000', MADAR_DESC_MARKER: newDescendantMarker() },
    })
    const { descendantPid } = JSON.parse(result.stdout) as { descendantPid: number }

    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    // The whole point: dead by the time the promise resolved, not later.
    expect(alive(descendantPid), 'owned descendant outlived a successful settlement').toBe(false)
    expect(result.ownedTreeState).toBe('empty')
    expect(ownedTimerCount()).toBe(0)
  }, 60_000)

  it('force-kills an uncooperative closed-stdio descendant before resolving', async () => {
    const result = await runChild(process.execPath, [OWNED], {
      cwd: REPO, timeoutMs: 30_000, graceMs: 500,
      env: {
        ...process.env,
        MADAR_DESC_LIFE_MS: '60000',
        MADAR_DESC_IGNORE_TERM: '1',
        MADAR_DESC_MARKER: newDescendantMarker(),
      },
    })
    const { descendantPid } = JSON.parse(result.stdout) as { descendantPid: number }

    expect(alive(descendantPid), 'descendant ignoring TERM outlived settlement').toBe(false)
    expect(result.ownedTreeState).toBe('empty')
    expect(ownedTimerCount()).toBe(0)
  }, 60_000)

  it('leaves an unrelated process in its own group untouched', async () => {
    // Reclamation must target the exact group we created, never a name match.
    const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore', detached: true,
    })
    bystander.unref()
    await new Promise((r) => setTimeout(r, 300))

    try {
      const result = await runChild(process.execPath, [OWNED], {
        cwd: REPO, timeoutMs: 30_000, graceMs: 400,
        env: {
          ...process.env,
          MADAR_DESC_LIFE_MS: '30000',
          MADAR_DESC_IGNORE_TERM: '1',
          MADAR_DESC_MARKER: newDescendantMarker(),
        },
      })
      const { descendantPid } = JSON.parse(result.stdout) as { descendantPid: number }
      expect(alive(descendantPid)).toBe(false)
      expect(alive(bystander.pid as number), 'an unrelated process was terminated').toBe(true)
    } finally {
      try { process.kill(bystander.pid as number, 'SIGKILL') } catch { /* already gone */ }
    }
  }, 60_000)

  it('does not force-kill when the leader had no descendants', async () => {
    const result = await runChild(process.execPath, ['-e', 'process.stdout.write("solo")'], {
      cwd: REPO, timeoutMs: 30_000, graceMs: 400,
    })
    expect(result.code).toBe(0)
    expect(result.forceKilled).toBe(false)
    expect(result.descendantsHeldStdio).toBe(false)
    expect(result.ownedTreeState).toBe('empty')
  }, 30_000)
})

describe('C2 — an unprovable owned tree fails closed', () => {
  /**
   * `unprovable` used to settle as success. A reviewer forced only the
   * process-group emptiness probe to EINVAL and a real closed-stdio descendant
   * survived resolution with code 0.
   *
   * Absence of proof is not proof of absence. The bounded TERM/KILL sequence
   * still runs against the exact owned group -- and the descendant does die --
   * but the operation rejects, because emptiness cannot be shown.
   */
  const OWNED = resolve(REPO, 'tests/fixtures/owned-descendant.mjs')

  it('rejects with the typed error, kills the descendant and spares a bystander', async () => {
    const marker = newDescendantMarker()
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
    const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore', detached: true,
    })
    bystander.unref()
    await new Promise((r) => setTimeout(r, 300))

    const realKill = process.kill.bind(process)
    // Only the negative-pid signal-0 probe is broken; real delivery is intact.
    process.kill = ((pid: number, signal?: string | number) => {
      if (pid < 0 && (signal === 0 || signal === '0')) {
        const error = new Error('kill EINVAL') as Error & { code?: string }
        error.code = 'EINVAL'
        throw error
      }
      return realKill(pid, signal as NodeJS.Signals)
    }) as typeof process.kill

    let rejectedCode: string | null = null
    try {
      await runChild(process.execPath, [OWNED], {
        cwd: REPO, timeoutMs: 30_000, graceMs: 500, treeReapDeadlineMs: 4_000,
        env: { ...process.env, MADAR_DESC_LIFE_MS: '60000', MADAR_DESC_MARKER: marker },
      })
    } catch (error) {
      rejectedCode = (error as { code?: string }).code ?? null
    } finally {
      process.kill = realKill
    }

    // Read the survivor count BEFORE cleanup: afterEach reaps this marker
    // unconditionally, so a control that measured afterwards could never fail.
    const survivors = livingMarked(marker)
    try {
      expect(rejectedCode, 'an unprovable tree settled successfully').toBe('OWNED_PROCESS_TREE_UNPROVABLE')
      // The owned descendant is dead even though emptiness could not be proven.
      expect(survivors, 'the owned descendant outlived a rejected settlement').toBe(0)
      expect(ownedTimerCount()).toBe(0)
      expect(alive(bystander.pid as number), 'an unrelated process was terminated').toBe(true)
    } finally {
      try { realKill(bystander.pid as number, 'SIGKILL') } catch { /* already gone */ }
    }
  }, 120_000)
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

    const install = await runChild(NPM, ['ci'], { cwd: target, timeoutMs: 900_000, graceMs: 5_000 })
    expect(install.timedOut).toBe(false)
    expect(install.code).toBe(0)
    expect(readdirSync(join(target, 'node_modules')).length).toBeGreaterThan(50)
    expect(existsSync(join(target, 'node_modules', 'typescript'))).toBe(true)

    const build = await runChild(NPM, ['run', 'build'], { cwd: target, timeoutMs: 900_000, graceMs: 5_000 })
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
