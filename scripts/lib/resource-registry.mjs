import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'

/**
 * One owner for every temporary resource a receipt run creates.
 *
 * The previous design let each helper install its own SIGINT/SIGTERM handler
 * that cleaned its own directory and then called `process.exit`. Node runs
 * listeners in registration order, so on an interrupt the outermost helper
 * cleaned up and exited before any inner helper's handler ran at all — the
 * candidate worktree simply leaked. Nested ownership cannot be made correct by
 * adding more handlers; there has to be exactly one.
 *
 * Cleanup is best-effort across every resource: one failing removal must not
 * prevent the others, because the alternative is leaving more behind than
 * necessary at exactly the moment something is already going wrong.
 */
export function createResourceRegistry({ onWarning = () => undefined } = {}) {
  const resources = new Map()
  let nextId = 0
  let cleaning = false
  let interrupted = false

  function register(description, cleanup) {
    const id = (nextId += 1)
    resources.set(id, { description, cleanup })
    return id
  }

  /** Runs one resource's cleanup and forgets it, whether or not it succeeded. */
  function releaseOne(id) {
    const entry = resources.get(id)
    if (entry === undefined) return true
    resources.delete(id)
    try {
      entry.cleanup()
      return true
    } catch (error) {
      onWarning(`cleanup failed for ${entry.description}: ${error?.message ?? String(error)}`)
      return false
    }
  }

  /**
   * Idempotent, best-effort, safe from success, failure, or a signal.
   *
   * Reverse order so a worktree is removed before the directory containing it.
   */
  function cleanupAll() {
    if (cleaning) return
    cleaning = true
    try {
      for (const id of [...resources.keys()].reverse()) releaseOne(id)
    } finally {
      cleaning = false
    }
  }

  return {
    register,
    release: releaseOne,
    cleanupAll,
    get outstanding() {
      return [...resources.values()].map((entry) => entry.description)
    },
    get interrupted() {
      return interrupted
    },
    markInterrupted() {
      interrupted = true
    },
  }
}

/**
 * Installs the single signal coordinator for a process.
 *
 * No helper below this may install its own exit-producing handler. Cleanup runs
 * to completion before the exit, rather than racing it.
 */
export function installSignalCoordinator(registry, { exit = (code) => process.exit(code) } = {}) {
  const handlers = []
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const handler = () => {
      registry.markInterrupted()
      registry.cleanupAll()
      exit(code)
    }
    process.on(signal, handler)
    handlers.push([signal, handler])
  }
  // A normal exit path that somehow skipped a finally still cleans up.
  const onExit = () => registry.cleanupAll()
  process.on('exit', onExit)
  handlers.push(['exit', onExit])

  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
}

/** Removes a git worktree registration and its directory, best effort. */
export function worktreeCleanup(repoRoot, dir) {
  return () => {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: repoRoot, stdio: 'ignore' })
    } catch {
      // Never registered, or already gone.
    }
    rmSync(dir, { recursive: true, force: true })
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'ignore' })
    } catch {
      // Nothing to prune.
    }
  }
}

/** Removes a plain temporary directory. */
export function directoryCleanup(dir) {
  return () => rmSync(dir, { recursive: true, force: true })
}
