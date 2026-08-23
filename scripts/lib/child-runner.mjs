import { spawn } from 'node:child_process'

import { ResourceRegistryShuttingDownError } from './shutdown-error.mjs'

/**
 * Raised when an owned process tree cannot be proven empty.
 *
 * `unprovable` used to settle as success, which let a real closed-stdio
 * descendant outlive `runChild` whenever the group probe was unavailable.
 * Absence of proof is not proof of absence.
 */
export class OwnedProcessTreeUnprovableError extends Error {
  constructor(what) {
    super(`owned process tree could not be proven empty for ${what}`)
    this.name = 'OwnedProcessTreeUnprovableError'
    this.code = 'OWNED_PROCESS_TREE_UNPROVABLE'
  }
}

/**
 * Asynchronous, interruptible child execution.
 *
 * The previous runner used `execFileSync` for `npm ci`, `npm run build` and each
 * measurement arm. A signal handler cannot run while the event loop is blocked
 * inside a synchronous child, so SIGTERM during a build did nothing at all: the
 * parent stayed alive, the child stayed alive, and every registered resource
 * survived until the child was killed by other means. Ordering and ownership
 * were already correct — the handler simply never got to run.
 *
 * Bounded local metadata probes (`git rev-parse`, `git status --porcelain`,
 * `npm --version`) remain synchronous deliberately. They cannot hold a live
 * child across a signal in any meaningful window, and making them async would
 * spread asynchrony through the guards for no gain in interruptibility.
 */

/**
 * Windows has no process groups; each platform gets its own tree kill.
 *
 * Deliberately NOT gated on whether the child itself has exited. It used to
 * return early once `child.exitCode !== null`, which meant a descendant that
 * outlived its parent could never be terminated -- and a descendant is exactly
 * what keeps the inherited stdout/stderr open. An independent reviewer hit this:
 * the measurement child exited 0 with a complete result, a descendant held the
 * pipes, the timeout fired, this function did nothing, and the wrapper waited
 * for `close` far past its own bound before reporting a timeout.
 */
function killTree(child, signal) {
  const pid = child.pid
  // A pid of 0 or 1 addresses the caller's own group or init; never signal it.
  if (typeof pid !== 'number' || pid <= 1) return
  if (process.platform === 'win32') {
    // Narrowly scoped to this pid and its descendants, never a name match.
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    // Negative pid targets the process group this child leads, so a build's own
    // children die with it rather than outliving the run. The group survives
    // the leader, which is the whole point of reaching it here.
    process.kill(-pid, signal)
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal)
      } catch {
        // Already gone.
      }
    }
  }
}

export function terminateChildTree(child, signal = 'SIGTERM') {
  killTree(child, signal)
}

/**
 * How long a completed child's stdio may stay open before its owned descendants
 * are terminated. Long enough for ordinary pipe drain, short enough that a
 * descendant cannot hold the run open.
 */
export const STDIO_DRAIN_GRACE_MS = 2000

/**
 * Timers this module currently owns, across every in-flight run.
 *
 * Exported so a control can assert ownership precisely.
 * `process.getActiveResourcesInfo()` counts the WHOLE process -- inside a test
 * worker that includes the framework's own timers -- so asserting on it
 * measures something this module does not own and fails for unrelated reasons.
 */
const ownedTimers = new Set()

export function ownedTimerCount() {
  return ownedTimers.size
}

/**
 * Runs a child to completion, or terminates it on timeout.
 *
 * The child is registered with the owning registry immediately after spawn and
 * released only once its exit has actually been observed, so a signal arriving
 * at any point finds it and can reap it.
 */
/**
 * Probes whether the owned process group still has members.
 *
 * `kill(-pid, 0)` sends no signal; it asks the kernel whether the group exists.
 * ESRCH means empty. EPERM means it exists but is not ours to signal, which is
 * NOT emptiness and must never be read as success.
 *
 * Windows has no process groups. `taskkill /T` owns the tree there, and
 * emptiness cannot be probed the same way, so the POSIX proof is unavailable
 * and the bounded terminate/force-kill sequence is the guarantee instead.
 */
export function ownedTreeState(pid) {
  if (process.platform === 'win32') return 'unprovable'
  if (typeof pid !== 'number' || pid <= 1) return 'empty'
  try {
    process.kill(-pid, 0)
    return 'populated'
  } catch (error) {
    if (error.code === 'ESRCH') return 'empty'
    if (error.code === 'EPERM') return 'populated'
    return 'unprovable'
  }
}

/**
 * Runs a child to completion, or terminates it on timeout.
 *
 * Three facts are tracked separately and none may overwrite another: the direct
 * child's exit, its stdio closure, and whether the OWNED PROCESS TREE is empty.
 * A leader can exit zero while a descendant with closed stdio lives on for
 * minutes -- `close` fires immediately in that case, so keying success off
 * stdio closure resolved successfully while an owned process was still running.
 *
 * Every timer has an explicit owner. Reusing one variable for the drain, grace
 * and force-kill timers let one handle overwrite another, so a settlement could
 * leave an orphaned timer active until its own later deadline.
 */
export function runChild(command, args, options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 0,
    registry = null,
    description = `${command} ${args.join(' ')}`,
    graceMs = 5000,
    treeReapDeadlineMs = 10000,
  } = options

  return new Promise((resolve, reject) => {
    // Pre-spawn gate: after shutdown begins, no PID is created at all.
    let reservation = null
    if (registry !== null) {
      try {
        reservation = registry.reserveAdmission(description)
      } catch (error) {
        reject(error)
        return
      }
    }

    let child
    try {
      child = spawn(command, args, {
        cwd,
        env: env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group on POSIX so the whole tree is addressable.
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      reject(error)
      return
    }

    let token = null
    if (registry !== null) {
      if (reservation !== null && !reservation.valid()) {
        terminateChildTree(child, 'SIGTERM')
        child.once('close', () => {
          reject(new ResourceRegistryShuttingDownError(`child "${description}" (shutdown began during spawn)`))
        })
        return
      }
      try {
        token = registry.registerChild(description, child)
      } catch (error) {
        terminateChildTree(child, 'SIGTERM')
        child.once('close', () => reject(error))
        return
      }
    }

    // ---- one explicit owner for every timer ---------------------------------
    const activeTimers = new Set()
    const scheduleOwnedTimer = (fn, ms) => {
      const handle = setTimeout(() => {
        // Each callback releases its own handle before doing work, so a timer
        // can never be cancelled twice or leak past its own firing.
        activeTimers.delete(handle)
        ownedTimers.delete(handle)
        fn()
      }, ms)
      activeTimers.add(handle)
      ownedTimers.add(handle)
      return handle
    }
    const cancelAllOwnedTimers = () => {
      for (const handle of activeTimers) {
        clearTimeout(handle)
        ownedTimers.delete(handle)
      }
      activeTimers.clear()
    }

    // ---- terminal facts, tracked separately ---------------------------------
    const facts = {
      exited: false,
      closed: false,
      timedOut: false,
      descendantsHeldStdio: false,
      forceKilled: false,
      treeState: 'unknown',
    }
    let exitInfo = null
    let stdout = ''
    let stderr = ''
    let settled = false

    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })

    const settle = (extra = {}) => {
      if (settled) return
      settled = true
      // Cancel first: a late callback after settlement must be inert and must
      // not retain the event loop.
      cancelAllOwnedTimers()
      if (token !== null) registry?.releaseChild(token)
      resolve({
        code: exitInfo?.code ?? null,
        signal: exitInfo?.signal ?? null,
        stdout,
        stderr,
        timedOut: facts.timedOut,
        descendantsHeldStdio: facts.descendantsHeldStdio,
        forceKilled: facts.forceKilled,
        ownedTreeState: facts.treeState,
        ...extra,
      })
    }

    const failSettle = (error) => {
      if (settled) return
      settled = true
      cancelAllOwnedTimers()
      if (token !== null) registry?.releaseChild(token)
      reject(error)
    }

    /**
     * Success is not declared until the owned tree is empty.
     *
     * Polls, then escalates TERM and KILL against the owned group only, and
     * fails rather than claiming success if emptiness cannot be established.
     */
    const reapOwnedTree = (deadline) => {
      const state = ownedTreeState(child.pid)
      facts.treeState = state
      // ONLY `empty` is success. `unprovable` means the proof is unavailable,
      // not that the tree is gone -- a real descendant survived resolution when
      // those two were treated alike.
      if (state === 'empty') { settle(); return }

      if (Date.now() >= deadline) {
        if (state === 'unprovable') {
          // Ownership was retained throughout, and the bounded TERM/KILL
          // sequence below has already run against the exact owned group. The
          // operation still fails: it cannot be shown that nothing survived.
          failSettle(new OwnedProcessTreeUnprovableError(`"${command} ${args.join(' ')}"`))
          return
        }
        failSettle(new Error(
          `"${command} ${args.join(' ')}" completed but its owned process tree was still populated `
          + `after ${treeReapDeadlineMs}ms`,
        ))
        return
      }
      // Escalation applies to `populated` and `unprovable` alike: the exact
      // owned group is asked to terminate, then force-killed, never a name
      // match and never an unrelated group.
      if (!facts.forceKilled && Date.now() >= deadline - graceMs) {
        facts.forceKilled = true
        terminateChildTree(child, 'SIGKILL')
      } else {
        terminateChildTree(child, 'SIGTERM')
      }
      scheduleOwnedTimer(() => reapOwnedTree(deadline), 100)
    }

    const finishWhenTerminal = () => {
      if (settled) return
      if (!facts.exited || !facts.closed) return
      reapOwnedTree(Date.now() + treeReapDeadlineMs)
    }

    if (timeoutMs > 0) {
      scheduleOwnedTimer(() => {
        facts.timedOut = true
        terminateChildTree(child, 'SIGTERM')
        scheduleOwnedTimer(() => {
          facts.forceKilled = true
          terminateChildTree(child, 'SIGKILL')
          // Bounded: even SIGKILL cannot make an unreachable holder release a
          // pipe, so the wait ends here rather than trusting `close` to arrive.
          scheduleOwnedTimer(() => settle(), graceMs)
        }, graceMs)
      }, timeoutMs)
    }

    child.on('error', (error) => failSettle(error))

    // `exit` is process completion; `close` is stdio completion; neither is
    // owned-tree completion.
    child.on('exit', (code, signal) => {
      facts.exited = true
      exitInfo = { code, signal }
      if (settled) return
      scheduleOwnedTimer(() => {
        if (settled || facts.closed) return
        // A descendant is holding the inherited pipes; reclaim them.
        facts.descendantsHeldStdio = true
        terminateChildTree(child, 'SIGTERM')
        scheduleOwnedTimer(() => {
          facts.forceKilled = true
          terminateChildTree(child, 'SIGKILL')
          facts.closed = true
          finishWhenTerminal()
        }, graceMs)
      }, STDIO_DRAIN_GRACE_MS)
      finishWhenTerminal()
    })

    child.on('close', (code, signal) => {
      facts.closed = true
      if (exitInfo === null) exitInfo = { code, signal }
      finishWhenTerminal()
    })
  })
}

/**
 * Runs a child and fails loudly, retaining every piece of evidence.
 *
 * A timeout is a failure with a reason, never a silent success and never a
 * retry until green.
 */
export async function runChildOrThrow(command, args, options = {}) {
  const result = await runChild(command, args, options)
  if (result.timedOut) {
    const error = new Error(`"${command} ${args.join(' ')}" timed out after ${options.timeoutMs}ms`)
    error.result = result
    throw error
  }
  if (result.code !== 0) {
    const detail = `${result.stdout}${result.stderr}`.trim().split('\n').slice(-12).join('\n')
    const how = result.signal !== null ? `signal ${result.signal}` : `exit ${result.code}`
    const error = new Error(`"${command} ${args.join(' ')}" failed with ${how}:\n${detail}`)
    error.result = result
    throw error
  }
  return result
}
