import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runChild, runChildOrThrow } from '../../scripts/lib/child-runner.mjs'
import {
  createResourceRegistry,
  directoryCleanup,
  worktreeCleanup,
} from '../../scripts/lib/resource-registry.mjs'

/**
 * The reviewer's reproduction: a registered resource, a LIVE child, a real
 * signal. The previous implementation cleaned up correctly in ordering and
 * ownership and still failed this, because a handler cannot run while the event
 * loop is blocked inside a synchronous child. Every case here keeps a child
 * genuinely alive across the signal.
 *
 * Isolated temporary repositories only -- never the active checkout.
 */
let repo: string
const created: string[] = []

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' })

function worktreePaths(root: string): string[] {
  const main = realpathSync(root)
  return git(root, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((path) => realpathSync(path) !== main)
}

const alive = (pid: number): boolean => {
  // pid 0 addresses the CALLER'S process group, so it always reports alive.
  // Guarding it here stops a child that never spawned from masquerading as one
  // that survived termination.
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`refusing to probe pid ${pid}: not a real child`)
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A child that sleeps, ignoring nothing — terminable by SIGTERM. */
const sleeper = (seconds = 60): string[] => ['-e', `setTimeout(() => {}, ${seconds * 1000})`]

/**
 * A child that ignores SIGTERM and must be force-killed.
 *
 * It touches a readiness file only AFTER installing the handler. Waiting a fixed
 * number of milliseconds instead was flaky: node's cold start can exceed it on a
 * loaded machine, and the child would then be killed by the default SIGTERM
 * action before its handler existed -- making the test assert on a race rather
 * than on escalation.
 */
const stubborn = (readyPath: string): string[] => ['-e',
  "process.on('SIGTERM', () => {});"
  + `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready');`
  + 'setTimeout(() => {}, 60000)',
]

async function waitForReady(readyPath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(readyPath)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`child never signalled readiness at ${readyPath}`)
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'madar-signal-repo-'))
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

function registerWorktree(registry: ReturnType<typeof createResourceRegistry>): string {
  const dir = mkdtempSync(join(tmpdir(), 'madar-signal-wt-'))
  created.push(dir)
  rmSync(dir, { recursive: true, force: true })
  registry.register(`worktree ${dir}`, worktreeCleanup(repo, dir))
  git(repo, 'worktree', 'add', '--detach', '--quiet', dir, 'HEAD')
  return dir
}

/**
 * Real signals are exercised in a dedicated child process rather than by
 * emitting into this one. `process.emit('SIGTERM')` inside a vitest worker also
 * runs vitest's own handlers, and leaks across test files that share a worker --
 * so it asserts on the harness rather than on us, and it breaks neighbours.
 */
function runSignalHarness(options: {
  signal: 'SIGINT' | 'SIGTERM'
  child?: 'cooperative' | 'stubborn'
  repeat?: boolean
}): { status: number; report: Record<string, unknown> } {
  const scratch = mkdtempSync(join(tmpdir(), 'madar-signal-case-'))
  created.push(scratch)
  const worktree = join(scratch, 'wt')
  const readyPath = join(scratch, 'ready')
  const outPath = join(scratch, 'report.json')

  let status = 0
  try {
    execFileSync(process.execPath, [
      join(process.cwd(), 'tests/fixtures/signal-harness.mjs'),
      '--repo', repo,
      '--worktree', worktree,
      '--signal', options.signal,
      '--child', options.child ?? 'cooperative',
      '--ready', readyPath,
      '--out', outPath,
      ...(options.repeat === true ? ['--repeat'] : []),
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
  } catch (error) {
    status = (error as { status?: number }).status ?? -1
  }
  expect(existsSync(outPath), 'the harness never reported').toBe(true)
  return { status, report: JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown> }
}

/**
 * Opt-in, and run alone.
 *
 * Each case spawns a process that spawns its own child and waits out real grace
 * periods. Under parallel load alongside other suites those waits are not
 * reliable, and a flaky signal test is worse than a slow one: it teaches you to
 * rerun until green. `npm run verify:receipt-signals` sets the flag and runs
 * this file by itself, and the required validation invokes it separately -- the
 * same treatment the mutation-harness end-to-end tests already get.
 */
const SIGNAL_E2E = process.env['MADAR_RECEIPT_SIGNAL_E2E'] === '1'

describe.runIf(SIGNAL_E2E)('E1-04 — a real signal is serviced while a child is genuinely alive', () => {
  it('6. SIGINT terminates the child, cleans up, and exits 130', () => {
    const { status, report } = runSignalHarness({ signal: 'SIGINT' })
    expect(report['liveChildrenBefore']).toBe(1)
    expect(report['liveChildrenAfter']).toBe(0)
    expect(report['worktreeDirExists']).toBe(false)
    expect(report['outstandingResources']).toEqual([])
    expect(report['interrupted']).toBe(true)
    expect(report['exitCode']).toBe(130)
    expect(status).toBe(130)
    expect(worktreePaths(repo)).toEqual([])
  }, 90_000)

  it('7. SIGTERM terminates the child, cleans up, and exits 143', () => {
    const { status, report } = runSignalHarness({ signal: 'SIGTERM' })
    expect(report['liveChildrenAfter']).toBe(0)
    expect(report['worktreeDirExists']).toBe(false)
    expect(report['exitCode']).toBe(143)
    expect(status).toBe(143)
    expect(worktreePaths(repo)).toEqual([])
  }, 90_000)

  it('8. a child that ignores graceful termination is force-killed', () => {
    const { report } = runSignalHarness({ signal: 'SIGTERM', child: 'stubborn' })
    expect((report['warnings'] as string[]).join(' ')).toContain('force-killing')
    expect(report['liveChildrenAfter']).toBe(0)
    expect(report['worktreeDirExists']).toBe(false)
    expect(worktreePaths(repo)).toEqual([])
  }, 90_000)

  it('8b. a cooperative child needs no force kill', () => {
    const { report } = runSignalHarness({ signal: 'SIGTERM' })
    expect((report['warnings'] as string[]).join(' ')).not.toContain('force-killing')
    expect(report['liveChildrenAfter']).toBe(0)
  }, 90_000)

  it('11. a repeated signal is idempotent and never skips cleanup', () => {
    const { report } = runSignalHarness({ signal: 'SIGTERM', repeat: true })
    expect((report['warnings'] as string[]).join(' ')).toContain('already shutting down')
    expect(report['exitCode']).toBe(143)
    expect(report['worktreeDirExists']).toBe(false)
    expect(report['outstandingResources']).toEqual([])
    expect(worktreePaths(repo)).toEqual([])
  }, 90_000)

  it('leaves no worktree registration behind in the real repository', () => {
    runSignalHarness({ signal: 'SIGTERM' })
    // Inspected through real porcelain output, after the harness process died.
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('madar-signal-case-')
  }, 90_000)
})

describe.runIf(SIGNAL_E2E)('E1-04 — termination escalates and reaps, driven directly', () => {
  it('descendants of the child die with it', async () => {
    const registry = createResourceRegistry()
    const readyDir = mkdtempSync(join(tmpdir(), 'madar-signal-tree-'))
    created.push(readyDir)
    const readyPath = join(readyDir, 'grandchild.pid')

    const running = runChild(process.execPath, ['-e',
      "const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)']);"
      + `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, String(c.pid));`
      + 'setTimeout(()=>{},60000)',
    ], { registry, description: 'parent with descendant' })
    await waitForReady(readyPath)

    const grandchild = Number(readFileSync(readyPath, 'utf8').trim())
    expect(grandchild).toBeGreaterThan(1)
    expect(alive(grandchild)).toBe(true)

    await registry.terminateChildren({ graceMs: 800 })
    await running

    let stillAlive = true
    for (let attempt = 0; attempt < 80 && stillAlive; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      stillAlive = alive(grandchild)
    }
    // The whole owned process group goes, not just the direct child.
    expect(stillAlive).toBe(false)
  }, 90_000)

  it('12. no unrelated process is terminated', async () => {
    const registry = createResourceRegistry()
    // Deliberately unregistered: the registry must not touch it.
    const bystander = runChild(process.execPath, sleeper(4), { description: 'unregistered bystander' })
    const owned = runChild(process.execPath, sleeper(), { registry, description: 'owned child' })
    await new Promise((resolve) => setTimeout(resolve, 400))

    await registry.terminateChildren({ graceMs: 800 })
    await owned

    const result = await bystander
    expect(result.signal).toBeNull()
    expect(result.code).toBe(0)
  }, 90_000)
})

// Also timing-sensitive: a child racing its own stdout flush against a kill is
// not reliable under parallel load.
describe.runIf(SIGNAL_E2E)('E1-04 — timeouts fail closed', () => {
  it('10. terminates and reaps a child that exceeds its timeout', async () => {
    const registry = createResourceRegistry()
    const result = await runChild(process.execPath, sleeper(), {
      registry, description: 'timeout victim', timeoutMs: 500, graceMs: 500,
    })

    expect(result.timedOut).toBe(true)
    expect(result.signal ?? '').not.toBe('')
    expect(registry.liveChildren).toEqual([])
  }, 60_000)

  it('a timeout is a failure with retained evidence, never a silent success', async () => {
    const registry = createResourceRegistry()
    let thrown: unknown
    try {
      await runChildOrThrow(process.execPath, ['-e', "console.log('partial'); setTimeout(()=>{},60000)"], {
        registry, description: 'timeout victim', timeoutMs: 900, graceMs: 500,
      })
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error).message).toContain('timed out')
    // Whatever the child managed to emit is kept.
    expect((thrown as { result: { stdout: string } }).result.stdout).toContain('partial')
    expect(registry.liveChildren).toEqual([])
  }, 60_000)

  it('a non-zero exit retains command, output and status', async () => {
    const registry = createResourceRegistry()
    let thrown: unknown
    try {
      await runChildOrThrow(process.execPath, ['-e', "console.error('why'); process.exit(3)"], {
        registry, description: 'failing child',
      })
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error).message).toContain('exit 3')
    expect((thrown as Error).message).toContain('why')
  }, 60_000)
})

describe('E1-04 — cleanup failure stays fail-closed', () => {
  it('9. one failing cleanup does not stop the others, and is retained', async () => {
    const warnings: string[] = []
    const registry = createResourceRegistry({ onWarning: (message: string) => warnings.push(message) })
    const survivor = mkdtempSync(join(tmpdir(), 'madar-signal-survivor-'))
    created.push(survivor)
    const dir = registerWorktree(registry)

    registry.register('exploding resource', () => { throw new Error('cleanup exploded') })
    registry.register(`survivor ${survivor}`, directoryCleanup(survivor))

    registry.cleanupAll()

    expect(existsSync(survivor)).toBe(false)
    expect(existsSync(dir)).toBe(false)
    expect(worktreePaths(repo)).toEqual([])
    expect(warnings.join(' ')).toContain('cleanup exploded')
    expect(registry.outstanding).toEqual([])
  }, 60_000)
})

describe('E1-04 — failure paths leave nothing behind', () => {
  it.each([
    ['2/3. a build failure', async (registry: ReturnType<typeof createResourceRegistry>) => {
      await runChildOrThrow(process.execPath, ['-e', 'process.exit(1)'], { registry, description: 'failing build' })
    }],
    ['4. a failure after shared input creation', async (registry: ReturnType<typeof createResourceRegistry>) => {
      const input = mkdtempSync(join(tmpdir(), 'madar-signal-input-'))
      created.push(input)
      registry.register(`shared input ${input}`, directoryCleanup(input))
      throw new Error('arm failed after input creation')
    }],
    ['5. a failure after both worktree registrations', async (registry: ReturnType<typeof createResourceRegistry>) => {
      registerWorktree(registry)
      registerWorktree(registry)
      throw new Error('failed with both worktrees live')
    }],
  ])('%s cleans every resource', async (_label, provoke) => {
    const registry = createResourceRegistry()
    registerWorktree(registry)

    await expect(provoke(registry)).rejects.toThrow()
    registry.cleanupAll()

    expect(worktreePaths(repo)).toEqual([])
    expect(registry.outstanding).toEqual([])
    expect(registry.liveChildren).toEqual([])
  }, 60_000)

  it('1. a normal success leaves nothing behind', async () => {
    const registry = createResourceRegistry()
    const dir = registerWorktree(registry)
    const result = await runChildOrThrow(process.execPath, ['-e', "console.log('ok')"], {
      registry, description: 'successful child',
    })
    expect(result.stdout.trim()).toBe('ok')

    registry.cleanupAll()

    expect(worktreePaths(repo)).toEqual([])
    expect(existsSync(dir)).toBe(false)
    expect(registry.liveChildren).toEqual([])
    expect(git(repo, 'status', '--porcelain')).toBe('')
  }, 60_000)
})
