import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Run-owned homes for the Vitest workers.
 *
 * `tests/setup.ts` gives each worker its own `CODEX_HOME` so the installer's
 * real global-config path can be exercised without a test writing over another
 * test's config mid-assertion. That isolation is the reason the directory
 * exists and is preserved here; what was missing is any owner able to remove it
 * afterwards.
 *
 * The previous naming keyed on `process.pid` alone, which cannot express
 * ownership: pids are recycled, so a collector matching the prefix and probing
 * whether the pid is alive gets the wrong answer in both directions -- it spares
 * a dead worker's directory whose number now belongs to an unrelated live
 * process, and it would delete a live worker's directory whose number it
 * happened to reuse. On this host that is not hypothetical; several historical
 * directories match currently-live unrelated pids.
 *
 * So a run gets one identity: a single `mkdtemp` root, created once, whose
 * uniqueness comes from the operating system rather than from a number the
 * platform reuses. Every worker home lives inside it, and the run removes that
 * one root. Nothing outside it is ever a deletion target.
 */

/** Env var carrying the run root from global setup to every worker. */
export const RUN_ROOT_ENV = 'MADAR_VITEST_RUN_ROOT'

/** Distinguishes this run's root from any other temp directory. */
export const RUN_ROOT_PREFIX = 'madar-vitest-run-'

/** Worker home directories are created directly beneath the run root. */
export const WORKER_HOME_PREFIX = 'codex-home-'

/** Creates the single root that identifies one test run. */
export function createRunRoot(): string {
  return mkdtempSync(join(tmpdir(), RUN_ROOT_PREFIX))
}

/** The home directory this worker owns inside the run root. */
export function workerHomePath(runRoot: string, pid: number = process.pid): string {
  return join(runRoot, `${WORKER_HOME_PREFIX}${pid}`)
}

/**
 * Whether `candidate` really lives inside `root`.
 *
 * Both sides are resolved through `realpathSync` before comparing, so a symlink
 * or a Windows junction planted inside the run root cannot make an outside
 * target look owned. A path that does not exist is resolved lexically instead,
 * which is the honest answer for a directory a worker already removed.
 *
 * The empty-relative case is excluded deliberately: the root is not contained in
 * itself for the purpose of deleting a *child*, and callers that mean to remove
 * the whole root say so directly.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const resolveReal = (value: string): string => {
    try {
      return realpathSync(value)
    } catch {
      return resolve(value)
    }
  }
  const realRoot = resolveReal(root)
  const realCandidate = resolveReal(candidate)
  if (realRoot === realCandidate) return false
  const rel = relative(realRoot, realCandidate)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..')
}

/**
 * Removes a path only after proving it is inside the run root.
 *
 * Returns whether anything was deleted, so a caller can tell "removed" from
 * "was never there" without inspecting the filesystem twice. Missing paths and
 * repeat calls are both ordinary: a worker may have cleaned up after itself, and
 * teardown may run more than once.
 */
export function removeOwnedPath(runRoot: string, target: string): boolean {
  if (!isInsideRoot(runRoot, target)) return false
  if (!existsSync(target)) return false
  rmSync(target, { recursive: true, force: true })
  return true
}

/**
 * Removes the run root itself.
 *
 * Guarded on the prefix rather than on containment, because the root is the one
 * path a run may delete outright. A directory that does not carry the prefix is
 * refused: that is the difference between removing what this run created and
 * running a recursive delete over whatever a caller happened to pass in.
 */
export function removeRunRoot(runRoot: string): boolean {
  const resolved = resolve(runRoot)
  const base = resolved.split(sep).pop() ?? ''
  if (!base.startsWith(RUN_ROOT_PREFIX)) return false
  if (!existsSync(resolved)) return false
  rmSync(resolved, { recursive: true, force: true })
  return true
}

/**
 * Prepares this worker's home and returns a restore function.
 *
 * When global setup has published a run root the home is created inside it and
 * the run owns cleanup. When it has not -- someone running Vitest through a
 * different config, for instance -- the worker creates a root of its own rather
 * than falling back to the unowned layout, and removes it when the process
 * exits. Either way nothing is left behind.
 */
export function prepareWorkerHome(): { home: string, restore: () => void } {
  const published = process.env[RUN_ROOT_ENV]
  const ownsRoot = published === undefined || published.length === 0
  const runRoot = ownsRoot ? createRunRoot() : published
  const home = workerHomePath(runRoot)
  mkdirSync(home, { recursive: true })

  const previousCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = home

  return {
    home,
    restore: () => {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      if (ownsRoot) removeRunRoot(runRoot)
      else removeOwnedPath(runRoot, home)
    },
  }
}
