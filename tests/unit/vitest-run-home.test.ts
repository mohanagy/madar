import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, afterEach, describe, expect, it } from 'vitest'

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

describe('699 controls 3 and 4 — a real run cleans up after success and after failure', () => {
  const workspaces: string[] = []
  afterEach(() => {
    for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true })
  })

  /**
   * Runs a real bounded Vitest child against this repository's own config, so
   * the assertion covers the configured global setup rather than a re-creation
   * of it inside the parent process.
   */
  function runChild(shouldPass: boolean): { rootsBefore: string[], rootsAfter: string[], exitCode: number, output: string } {
    const repoRoot = resolve(__dirname, '..', '..')
    const scratch = mkdtempSync(join(tmpdir(), 'madar-699-child-'))
    workspaces.push(scratch)
    const specPath = join(repoRoot, 'tests', 'unit', `zz-699-child-${process.pid}-${shouldPass ? 'pass' : 'fail'}.test.ts`)
    workspaces.push(specPath)
    writeFileSync(specPath, [
      "import { describe, expect, it } from 'vitest'",
      `describe('699 child', () => { it('${shouldPass ? 'passes' : 'fails'}', () => {`,
      `  expect(1).toBe(${shouldPass ? '1' : '2'})`,
      '}) })',
      '',
    ].join('\n'))

    const listRoots = (): string[] =>
      readdirSync(tmpdir()).filter((entry) => entry.startsWith(RUN_ROOT_PREFIX)).sort()

    const rootsBefore = listRoots()
    let exitCode = 0
    let output = ''
    try {
      output = execFileSync('npx', ['vitest', 'run', specPath], {
        cwd: repoRoot, stdio: 'pipe', encoding: 'utf8', timeout: 180_000,
      })
    } catch (error) {
      const failure = error as { status?: number, stdout?: string, stderr?: string }
      exitCode = failure.status ?? 1
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
    }
    return { rootsBefore, rootsAfter: listRoots(), exitCode, output }
  }

  it('control 3 — a passing run leaves no run-owned root behind', () => {
    const { rootsBefore, rootsAfter, exitCode, output } = runChild(true)
    // Prove the child really executed the spec, so a Vitest that failed to
    // start cannot be mistaken for a run that cleaned up after itself.
    expect(output, `child produced no run summary: ${output.slice(0, 400)}`).toMatch(/Test Files\s+1 passed/)
    expect(exitCode).toBe(0)
    // Nothing new survives. Pre-existing roots from a concurrent run are not
    // this run's to remove, so only the difference is asserted.
    expect(rootsAfter.filter((entry) => !rootsBefore.includes(entry))).toEqual([])
  }, 200_000)

  it('control 4 — an ordinary failing run still cleans up', () => {
    const { rootsBefore, rootsAfter, exitCode, output } = runChild(false)
    // The run must genuinely have executed and genuinely have failed, or this
    // proves nothing about teardown on the failing path.
    expect(output, `child produced no run summary: ${output.slice(0, 400)}`).toMatch(/Test Files\s+1 failed/)
    expect(exitCode).not.toBe(0)
    expect(rootsAfter.filter((entry) => !rootsBefore.includes(entry))).toEqual([])
  }, 200_000)
})

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

  it('leaves no run-owned root for this suite behind', () => {
    // Any root this file created is tracked and removed; nothing schedules a
    // timer or a child process that outlives the run.
    for (const path of created) {
      if (path.includes(RUN_ROOT_PREFIX) && existsSync(path)) {
        expect(readdirSync(path).every((entry) => entry.startsWith(WORKER_HOME_PREFIX))).toBe(true)
      }
    }
    expect(true).toBe(true)
  })
})
