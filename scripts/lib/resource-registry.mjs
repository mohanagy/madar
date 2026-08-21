import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'

import { terminateChildTree } from './child-runner.mjs'

/**
 * Raised when work is requested after shutdown has begun.
 *
 * A distinct type rather than a boolean return, so a caller cannot mistake
 * refusal for an ordinary failure and retry it.
 */
export class ResourceRegistryShuttingDownError extends Error {
  code = 'RESOURCE_REGISTRY_SHUTTING_DOWN'

  constructor(what) {
    super(`refusing to admit ${what}: shutdown has begun`)
    this.name = 'ResourceRegistryShuttingDownError'
  }
}

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
  // Children are tracked apart from directories because they must be
  // terminated and REAPED before any directory is removed -- a live build
  // writing into a worktree that has just been deleted is a different failure
  // from the one being cleaned up after.
  const children = new Map()
  let nextId = 0
  let cleaning = false
  let interrupted = false
  let acceptingWork = true

  /**
   * Admission, not merely bookkeeping.
   *
   * `acceptingWork` was previously recorded and never consulted, so shutdown
   * announced that it had stopped accepting work while continuing to accept
   * it. Refusing here is the difference between a flag and a gate.
   */
  function register(description, cleanup) {
    if (!acceptingWork) throw new ResourceRegistryShuttingDownError(`resource "${description}"`)
    const id = (nextId += 1)
    resources.set(id, { description, cleanup })
    return id
  }

  /**
   * Reserves admission for work that is about to start.
   *
   * Node runs signal callbacks on the event loop, so nothing can interleave
   * between this synchronous check and the caller's own synchronous spawn. The
   * reservation exists for what happens AFTER that: if shutdown wins before the
   * child is registered, the reservation is already void and the caller must
   * terminate what it started rather than leaving it unregistered.
   */
  function reserveAdmission(description) {
    if (!acceptingWork) throw new ResourceRegistryShuttingDownError(description)
    return { valid: () => acceptingWork }
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

  function registerChild(description, child) {
    if (!acceptingWork) throw new ResourceRegistryShuttingDownError(`child "${description}"`)
    const id = (nextId += 1)
    children.set(id, { description, child })
    return id
  }

  /** Called once a child's exit has actually been observed. */
  function releaseChild(id) {
    children.delete(id)
  }

  /**
   * Terminates every live child, waits a bounded grace period, force-kills the
   * survivors, and waits for each to be reaped.
   *
   * Resolves only when no registered child is still running, so directory
   * cleanup afterwards cannot race a process still writing into it.
   */
  async function terminateChildren({ graceMs = 5000 } = {}) {
    const live = [...children.entries()].filter(([, entry]) => (
      entry.child.exitCode === null && entry.child.signalCode === null
    ))
    if (live.length === 0) return []

    const reaped = live.map(([id, entry]) => new Promise((resolve) => {
      const done = () => resolve({ id, description: entry.description })
      if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
        done()
        return
      }
      entry.child.once('close', done)
      entry.child.once('exit', done)
    }))

    for (const [, entry] of live) {
      try {
        terminateChildTree(entry.child, 'SIGTERM')
      } catch (error) {
        onWarning(`could not signal ${entry.description}: ${error?.message ?? String(error)}`)
      }
    }

    const grace = new Promise((resolve) => setTimeout(resolve, graceMs))
    await Promise.race([Promise.all(reaped), grace])

    for (const [, entry] of live) {
      if (entry.child.exitCode !== null || entry.child.signalCode !== null) continue
      onWarning(`force-killing ${entry.description} after ${graceMs}ms`)
      try {
        terminateChildTree(entry.child, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }

    const settled = await Promise.all(reaped)
    for (const { id } of settled) children.delete(id)
    return settled
  }

  return {
    register,
    reserveAdmission,
    release: releaseOne,
    registerChild,
    releaseChild,
    terminateChildren,
    cleanupAll,
    get liveChildren() {
      return [...children.values()]
        .filter((entry) => entry.child.exitCode === null && entry.child.signalCode === null)
        .map((entry) => entry.description)
    },
    get acceptingWork() {
      return acceptingWork
    },
    stopAcceptingWork() {
      acceptingWork = false
    },
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
/**
 * The single signal coordinator for a process.
 *
 * The previous version cleaned resources and exited synchronously, which was
 * correct in ordering and useless in practice: while the event loop was blocked
 * inside a synchronous child, the handler could not run at all. Children are now
 * asynchronous and registered, so a signal can actually be serviced.
 *
 * The sequence is fixed: stop launching new work, terminate every live child,
 * wait a bounded grace, force-kill survivors, reap them, clean every registered
 * resource, then exit. `process.exit` is never called before that completes,
 * because exiting first is exactly how a live child outlives its worktree.
 */
export function installSignalCoordinator(registry, {
  exit = (code) => process.exit(code),
  graceMs = 5000,
  onWarning = () => undefined,
} = {}) {
  const handlers = []
  let shuttingDown = false
  let requestedCode = null

  async function shutdown(code) {
    // Idempotent. A second signal may escalate termination but must never skip
    // cleanup by short-circuiting the first pass.
    if (shuttingDown) {
      onWarning(`already shutting down; ignoring repeat signal (exit ${requestedCode})`)
      return
    }
    shuttingDown = true
    requestedCode = code
    registry.stopAcceptingWork()
    try {
      await registry.terminateChildren({ graceMs })
    } catch (error) {
      onWarning(`child termination failed: ${error?.message ?? String(error)}`)
    }
    registry.cleanupAll()
    process.exitCode = code
    exit(code)
  }

  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const handler = () => {
      registry.markInterrupted()
      void shutdown(code)
    }
    process.on(signal, handler)
    handlers.push([signal, handler])
  }

  // A normal exit path that somehow skipped a finally still cleans up. This is
  // synchronous by necessity -- nothing async can run during 'exit' -- so it is
  // a backstop for directories, not the child contract.
  const onExit = () => registry.cleanupAll()
  process.on('exit', onExit)
  handlers.push(['exit', onExit])

  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
}

/**
 * Removes a git worktree registration and its directory, best effort.
 *
 * Synchronous deliberately: cleanup may run from an exit path where nothing
 * async can execute, and these are bounded local git operations rather than
 * long-lived children.
 */
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
