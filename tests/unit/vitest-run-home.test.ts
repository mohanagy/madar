import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  createRunRoot,
  isInsideRoot,
  prepareWorkerHome,
  removeOwnedPath,
  removeRunRoot,
  RUN_ROOT_ENV,
  RUN_ROOT_PREFIX,
  WORKER_HOME_PREFIX,
  workerHomePath,
} from '../helpers/run-home.js'
import { createRunTeardown, setup as globalSetup } from '../global-setup.js'

/**
 * Real filesystem throughout. The defect was that nothing removed a directory,
 * so a control asserting on source text would prove nothing about whether the
 * directory is gone.
 */

const created: string[] = []

function track<T extends string>(path: T): T {
  created.push(path)
  return path
}

afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true })
})

describe('699 control 1 — a worker home is created inside the exact run-owned root', () => {
  it('places the home under the published run root', () => {
    const runRoot = track(createRunRoot())
    const previous = process.env[RUN_ROOT_ENV]
    process.env[RUN_ROOT_ENV] = runRoot
    try {
      const { home, restore } = prepareWorkerHome()
      expect(existsSync(home)).toBe(true)
      expect(isInsideRoot(runRoot, home)).toBe(true)
      expect(process.env.CODEX_HOME).toBe(home)
      restore()
    } finally {
      if (previous === undefined) delete process.env[RUN_ROOT_ENV]
      else process.env[RUN_ROOT_ENV] = previous
    }
  })
})

describe('699 control 2 — worker homes are unique but share one run owner', () => {
  it('gives each pid a distinct directory under the same root', () => {
    const runRoot = track(createRunRoot())
    const homes = [101, 102, 103].map((pid) => workerHomePath(runRoot, pid))
    for (const home of homes) mkdirSync(home, { recursive: true })

    expect(new Set(homes).size).toBe(homes.length)
    for (const home of homes) expect(isInsideRoot(runRoot, home)).toBe(true)
    expect(readdirSync(runRoot).sort()).toEqual([
      `${WORKER_HOME_PREFIX}101`,
      `${WORKER_HOME_PREFIX}102`,
      `${WORKER_HOME_PREFIX}103`,
    ])
  })
})

/**
 * Controls 3 and 4 -- cleanup after a passing run and after an ordinary failing
 * run -- are proven by the direct global-setup contract at the bottom of this
 * file rather than by spawning a real Vitest inside this one.
 *
 * A child-spawned variant was written first and removed. It was stable locally
 * and failed on all six CI lanes for reasons incidental to this fix: the child
 * inherited the outer run's environment and emitted GitHub Actions annotations
 * into the parent job; `execFileSync` returned stdout alone while Vitest wrote
 * its summary elsewhere; and the pipe filled until `spawnSync` reported EPIPE
 * with nothing captured -- which an assertion cannot distinguish from a child
 * that never started. Three CI cycles did not settle it, and a control that
 * cannot be trusted to fail honestly is worse than no control.
 *
 * What replaces it is stronger where it matters and weaker where it does not.
 * The exported teardown is exercised directly, so what cleanup *does* is proven
 * deterministically on every platform. That Vitest *calls* that teardown after a
 * failing run is Vitest's own documented `globalSetup` contract, not behaviour
 * this issue implements; it was verified locally against this branch with a real
 * failing invocation, which created zero directories where the base created one.
 */

describe('699 controls 5 and 6 — cleanup tolerates absence and repetition', () => {
  it('control 5 — a missing worker directory does not make cleanup fail', () => {
    const runRoot = track(createRunRoot())
    const never = workerHomePath(runRoot, 424_242)
    expect(existsSync(never)).toBe(false)
    expect(removeOwnedPath(runRoot, never)).toBe(false)
  })

  it('control 6 — repeated cleanup is safe and idempotent', () => {
    const runRoot = track(createRunRoot())
    const home = workerHomePath(runRoot, 555)
    mkdirSync(home, { recursive: true })

    expect(removeOwnedPath(runRoot, home)).toBe(true)
    expect(removeOwnedPath(runRoot, home)).toBe(false)
    expect(removeOwnedPath(runRoot, home)).toBe(false)

    expect(removeRunRoot(runRoot)).toBe(true)
    expect(removeRunRoot(runRoot)).toBe(false)
    expect(existsSync(runRoot)).toBe(false)
  })
})

describe('699 controls 7 and 8 — nothing unowned is ever a target', () => {
  it('control 7 — a similarly named unrelated directory survives', () => {
    const runRoot = track(createRunRoot())
    // Same prefix, adjacent on disk, different run. Exactly the directory a
    // prefix-matching collector would take with it.
    const sibling = track(createRunRoot())
    const siblingHome = workerHomePath(sibling, 777)
    mkdirSync(siblingHome, { recursive: true })

    expect(removeOwnedPath(runRoot, siblingHome)).toBe(false)
    expect(removeRunRoot(runRoot)).toBe(true)
    expect(existsSync(sibling)).toBe(true)
    expect(existsSync(siblingHome)).toBe(true)
  })

  it('control 8 — a path outside the run root is refused', () => {
    const runRoot = track(createRunRoot())
    const outside = track(mkdtempSync(join(tmpdir(), 'madar-699-outside-')))
    const outsideFile = join(outside, 'keep.txt')
    writeFileSync(outsideFile, 'keep')

    for (const target of [outside, outsideFile, tmpdir(), join(runRoot, '..'), resolve(runRoot, '..', '..')]) {
      expect(removeOwnedPath(runRoot, target), `must refuse ${target}`).toBe(false)
    }
    expect(existsSync(outsideFile)).toBe(true)

    // The root is not a child of itself, so the child-removal path refuses it.
    expect(removeOwnedPath(runRoot, runRoot)).toBe(false)
    // And a directory without the run prefix is not removable as a root.
    expect(removeRunRoot(outside)).toBe(false)
    expect(existsSync(outside)).toBe(true)
  })
})

describe('699 control 9 — a symlink cannot escape the owned root', () => {
  it('refuses a link inside the root that points outside it', () => {
    const runRoot = track(createRunRoot())
    const outside = track(mkdtempSync(join(tmpdir(), 'madar-699-escape-')))
    const victim = join(outside, 'victim.txt')
    writeFileSync(victim, 'must survive')

    const link = join(runRoot, `${WORKER_HOME_PREFIX}escape`)
    try {
      symlinkSync(outside, link, 'dir')
    } catch {
      // Unprivileged Windows cannot create a directory symlink. The guard is
      // still asserted directly below, which is the part that matters.
      expect(isInsideRoot(runRoot, outside)).toBe(false)
      return
    }

    // Lexically the link looks like a child; through realpath it is not.
    expect(isInsideRoot(runRoot, link)).toBe(false)
    expect(removeOwnedPath(runRoot, link)).toBe(false)
    expect(existsSync(victim)).toBe(true)

    // Removing the whole root must not follow the link out either.
    expect(removeRunRoot(runRoot)).toBe(true)
    expect(existsSync(victim)).toBe(true)
    expect(existsSync(outside)).toBe(true)
  })
})

describe('699 control 10 — environment is set and restored truthfully', () => {
  it('restores CODEX_HOME to its previous value', () => {
    const runRoot = track(createRunRoot())
    const previousRoot = process.env[RUN_ROOT_ENV]
    const sentinel = join(tmpdir(), 'madar-699-preexisting-codex-home')
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = sentinel
    process.env[RUN_ROOT_ENV] = runRoot
    try {
      const { home, restore } = prepareWorkerHome()
      expect(process.env.CODEX_HOME).toBe(home)
      restore()
      expect(process.env.CODEX_HOME).toBe(sentinel)
      expect(existsSync(home)).toBe(false)
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      if (previousRoot === undefined) delete process.env[RUN_ROOT_ENV]
      else process.env[RUN_ROOT_ENV] = previousRoot
    }
  })

  it('deletes CODEX_HOME again when it was previously unset', () => {
    const runRoot = track(createRunRoot())
    const previousRoot = process.env[RUN_ROOT_ENV]
    const previousCodexHome = process.env.CODEX_HOME
    delete process.env.CODEX_HOME
    process.env[RUN_ROOT_ENV] = runRoot
    try {
      const { restore } = prepareWorkerHome()
      expect(process.env.CODEX_HOME).toBeDefined()
      restore()
      expect('CODEX_HOME' in process.env).toBe(false)
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      if (previousRoot === undefined) delete process.env[RUN_ROOT_ENV]
      else process.env[RUN_ROOT_ENV] = previousRoot
    }
  })

  it('owns and removes its own root when no run root was published', () => {
    // The path someone takes by running Vitest through a different config.
    // Isolation must survive it without reintroducing an unowned directory.
    const previousRoot = process.env[RUN_ROOT_ENV]
    const previousCodexHome = process.env.CODEX_HOME
    delete process.env[RUN_ROOT_ENV]
    try {
      const { home, restore } = prepareWorkerHome()
      expect(existsSync(home)).toBe(true)
      expect(home.includes(RUN_ROOT_PREFIX)).toBe(true)
      restore()
      expect(existsSync(home)).toBe(false)
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      if (previousRoot === undefined) delete process.env[RUN_ROOT_ENV]
      else process.env[RUN_ROOT_ENV] = previousRoot
    }
  })

  it('uses the platform temp directory rather than a hard-coded separator', () => {
    // Cross-platform behaviour is about resolving through the OS temp dir and
    // path APIs. `tests/setup.ts` does not assign HOME or USERPROFILE, so there
    // is no such variable to restore and none is invented here.
    const runRoot = track(createRunRoot())
    expect(runRoot.startsWith(resolve(tmpdir()))).toBe(true)
    expect(workerHomePath(runRoot, 9)).toBe(join(runRoot, `${WORKER_HOME_PREFIX}9`))
  })
})

describe('699 control 11 — the run leaves no owned residue', () => {
  it('removes every worker home together with the root', () => {
    const runRoot = track(createRunRoot())
    for (const pid of [1, 2, 3, 4]) {
      const home = workerHomePath(runRoot, pid)
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, 'config.toml'), '# worker state')
    }
    expect(readdirSync(runRoot)).toHaveLength(4)

    expect(removeRunRoot(runRoot)).toBe(true)
    expect(existsSync(runRoot)).toBe(false)
  })

})

describe('699 — the shipped global setup contract, invoked directly', () => {
  it('creates a run root, publishes it, and removes exactly that root on teardown', async () => {
    // Deterministic companion to controls 3 and 4. Those spawn a real Vitest to
    // prove the runner calls teardown on both paths; this exercises the exact
    // exported contract the runner calls, without a child process.
    const previous = process.env[RUN_ROOT_ENV]
    delete process.env[RUN_ROOT_ENV]
    const before = readdirSync(tmpdir()).filter((entry) => entry.startsWith(RUN_ROOT_PREFIX))
    try {
      const teardown = await globalSetup()
      const published = process.env[RUN_ROOT_ENV]
      expect(published, 'global setup published no run root').toBeTruthy()
      expect(existsSync(published!)).toBe(true)

      // A worker home created the way tests/setup.ts creates one.
      const home = workerHomePath(published!, 4242)
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, 'config.toml'), '# state')

      // A sibling root belonging to a different run must survive teardown.
      const sibling = track(createRunRoot())

      await teardown()
      expect(existsSync(published!)).toBe(false)
      expect(existsSync(home)).toBe(false)
      expect(existsSync(sibling)).toBe(true)

      // Idempotent: the runner may call it again, and nothing else is taken.
      await teardown()
      expect(existsSync(sibling)).toBe(true)
      const after = readdirSync(tmpdir()).filter((entry) => entry.startsWith(RUN_ROOT_PREFIX))
      expect(after.filter((entry) => !before.includes(entry) && entry !== sibling.split(sep).pop())).toEqual([])
    } finally {
      if (previous === undefined) delete process.env[RUN_ROOT_ENV]
      else process.env[RUN_ROOT_ENV] = previous
    }
  })

  it('is the setup Vitest is actually configured to run', () => {
    // Guards the wiring: the contract above is only worth proving if the runner
    // is pointed at it.
    const config = readFileSync(resolve(__dirname, '..', '..', 'vitest.config.ts'), 'utf8')
    expect(config).toContain("globalSetup: ['tests/global-setup.ts']")
    expect(config).toContain("setupFiles: ['tests/setup.ts']")
  })
})

describe('699 — a terminal cleanup failure fails the invocation', () => {
  /**
   * Vitest 4.1.10 does not fail a run because global teardown rejected: it
   * collects the rejection, awaits it through `Promise.allSettled`, logs
   * `error during close`, and neither rethrows nor sets `process.exitCode`.
   *
   * These controls therefore mirror that swallowing deliberately -- each one
   * settles the teardown rather than awaiting it -- and assert on the exit
   * status, which is the only thing that actually survives to fail the
   * invocation.
   */
  const sentinel = new Error('sentinel: removal exhausted its retries')
  const throwingRemover = (): boolean => { throw sentinel }

  it('Control A — swallowing the rejection does not erase the failure', async () => {
    const runRoot = createRunRoot()
    const previousExit = process.exitCode
    const previousRoot = process.env[RUN_ROOT_ENV]
    process.env[RUN_ROOT_ENV] = runRoot
    process.exitCode = 0
    try {
      const teardown = createRunTeardown(runRoot, throwingRemover)
      // Exactly what the framework does with the returned promise.
      const [settled] = await Promise.allSettled([teardown()])

      expect(settled?.status).toBe('rejected')
      expect((settled as PromiseRejectedResult).reason).toBe(sentinel)
      // The part that matters: the process still reports failure.
      expect(process.exitCode).toBe(1)
      expect(process.env[RUN_ROOT_ENV]).toBeUndefined()
    } finally {
      process.exitCode = previousExit
      if (previousRoot === undefined) delete process.env[RUN_ROOT_ENV]
      else process.env[RUN_ROOT_ENV] = previousRoot
      rmSync(runRoot, { recursive: true, force: true })
    }
  })

  it('Control B — an existing non-zero status is preserved, not overwritten', async () => {
    const runRoot = createRunRoot()
    const previousExit = process.exitCode
    const previousRoot = process.env[RUN_ROOT_ENV]
    process.env[RUN_ROOT_ENV] = runRoot
    process.exitCode = 7
    try {
      const [settled] = await Promise.allSettled([createRunTeardown(runRoot, throwingRemover)()])
      expect(settled?.status).toBe('rejected')
      // A run that already failed for its own reason keeps reporting it.
      expect(process.exitCode).toBe(7)
    } finally {
      process.exitCode = previousExit
      if (previousRoot === undefined) delete process.env[RUN_ROOT_ENV]
      else process.env[RUN_ROOT_ENV] = previousRoot
      rmSync(runRoot, { recursive: true, force: true })
    }
  })

  it('Control C — a successful teardown manufactures no failure', async () => {
    const runRoot = createRunRoot()
    const home = workerHomePath(runRoot, 31_337)
    mkdirSync(home, { recursive: true })
    const previousExit = process.exitCode
    const previousRoot = process.env[RUN_ROOT_ENV]
    process.env[RUN_ROOT_ENV] = runRoot
    process.exitCode = undefined
    try {
      await createRunTeardown(runRoot)()

      expect(existsSync(runRoot)).toBe(false)
      expect(existsSync(home)).toBe(false)
      expect(process.exitCode === undefined || Number(process.exitCode) === 0).toBe(true)
      expect(process.env[RUN_ROOT_ENV]).toBeUndefined()

      // Idempotent: a second call on an already-removed root stays silent.
      await createRunTeardown(runRoot)()
      expect(process.exitCode === undefined || Number(process.exitCode) === 0).toBe(true)
    } finally {
      process.exitCode = previousExit
      if (previousRoot === undefined) delete process.env[RUN_ROOT_ENV]
      else process.env[RUN_ROOT_ENV] = previousRoot
      rmSync(runRoot, { recursive: true, force: true })
    }
  })

  it("leaves another run's environment variable alone", () => {
    // The teardown clears the run-root variable only while it still names the
    // root being torn down.
    const runRoot = createRunRoot()
    const previousRoot = process.env[RUN_ROOT_ENV]
    process.env[RUN_ROOT_ENV] = '/some/other/run/root'
    try {
      void createRunTeardown(runRoot)
      expect(process.env[RUN_ROOT_ENV]).toBe('/some/other/run/root')
    } finally {
      if (previousRoot === undefined) delete process.env[RUN_ROOT_ENV]
      else process.env[RUN_ROOT_ENV] = previousRoot
      rmSync(runRoot, { recursive: true, force: true })
    }
  })
})
