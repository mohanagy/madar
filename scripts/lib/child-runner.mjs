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
function killTree(child, signal, onTreeKillOutcome = null) {
  const pid = child.pid
  // A pid of 0 or 1 addresses the caller's own group or init; never signal it.
  if (typeof pid !== 'number' || pid <= 1) return
  if (process.platform === 'win32') {
    // Narrowly scoped to this pid and its descendants, never a name match.
    //
    // The outcome is OBSERVED rather than discarded. `taskkill` was previously
    // spawned with its stdio ignored and its exit code unread, so a failure to
    // terminate the tree was indistinguishable from success -- on the one
    // platform where this command is the entire termination guarantee.
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    if (onTreeKillOutcome !== null) {
      // 128 is taskkill's "process not found", which means the tree is already
      // gone. That is the goal, not a failure.
      killer.once('exit', (code) => onTreeKillOutcome({
        ok: code === 0 || code === 128,
        code,
      }))
      killer.once('error', (error) => onTreeKillOutcome({ ok: false, code: null, error }))
    }
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

export function terminateChildTree(child, signal = 'SIGTERM', onTreeKillOutcome = null) {
  killTree(child, signal, onTreeKillOutcome)
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
  if (process.platform === 'win32') return windowsLeaderState(pid)
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
 * How emptiness was established, so a caller is never told a Windows result
 * carries POSIX-grade evidence.
 *
 * The two are genuinely different claims. `process_group_probe` asks the kernel
 * whether an owned group has any member at all. `leader_exit_and_tree_kill`
 * establishes that the leader is gone and that a tree kill scoped to its pid
 * reported success -- which is the strongest proof Windows offers and is not
 * the same as enumerating survivors.
 */
export const OWNED_TREE_PROOFS = Object.freeze({
  processGroupProbe: 'process_group_probe',
  leaderExit: 'leader_exit',
  leaderExitAndTreeKill: 'leader_exit_and_tree_kill',
  none: 'none',
})

/**
 * The Windows half of the tree probe.
 *
 * Windows has no process groups, so there is nothing to ask about the tree as a
 * unit. What CAN be established exactly is whether the leader is still running,
 * and `taskkill /T /F` scoped to that pid is what owns its descendants.
 *
 * Returning a flat `'unprovable'` here, as this did, was not conservative --
 * it was wrong in the other direction. `reapOwnedTree` settles only on
 * `'empty'`, so EVERY Windows child, including one that exited cleanly with no
 * descendants at all, waited out the full reap deadline and then rejected with
 * `OwnedProcessTreeUnprovableError`. Both Windows lanes failed that way on
 * normal completion, timeout, descendant and cleanup cases alike.
 */
function windowsLeaderState(pid) {
  if (typeof pid !== 'number' || pid <= 1) return 'empty'
  try {
    // Signal 0 on Windows is a liveness query, exactly as on POSIX; only the
    // negative-pid GROUP form is unsupported.
    process.kill(pid, 0)
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

    /**
     * Rejects with the original error after the spawned child is actually gone.
     *
     * Both early-exit paths below deferred their rejection to `child.once
     * ('close', ...)` alone. This file documents, at `killTree`, that a
     * descendant which inherited stdout/stderr keeps those pipes open after the
     * child itself exits -- so `close` can be delayed indefinitely, and in that
     * case `runChild` never settled at all. The child is not registered on
     * either path, so the coordinator could not reap it either: an unregistered
     * process outliving a promise that never resolves.
     *
     * The lifecycle is therefore bounded and driven by termination rather than
     * by stdio: terminate the tree, settle on `exit`, escalate to a force kill
     * at the grace deadline, and reject on a hard bound regardless. The
     * ORIGINAL typed error is what surfaces either way -- the caller needs to
     * know the registry was shutting down, not that a kill took too long.
     */
    const rejectAfterTermination = (error) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(graceTimer)
        clearTimeout(hardTimer)
        ownedTimers.delete(graceTimer)
        ownedTimers.delete(hardTimer)
        reject(error)
      }

      terminateChildTree(child, 'SIGTERM')
      child.once('exit', finish)

      const graceTimer = setTimeout(() => {
        ownedTimers.delete(graceTimer)
        if (done) return
        terminateChildTree(child, 'SIGKILL')
      }, graceMs)
      const hardTimer = setTimeout(() => {
        ownedTimers.delete(hardTimer)
        // Even SIGKILL cannot make an unreachable holder release a pipe, so the
        // wait ends here rather than trusting a further event to arrive.
        finish()
      }, graceMs * 2)
      ownedTimers.add(graceTimer)
      ownedTimers.add(hardTimer)
    }

    let token = null
    if (registry !== null) {
      if (reservation !== null && !reservation.valid()) {
        rejectAfterTermination(
          new ResourceRegistryShuttingDownError(`child "${description}" (shutdown began during spawn)`),
        )
        return
      }
      try {
        token = registry.registerChild(description, child)
      } catch (error) {
        rejectAfterTermination(error)
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
      treeProof: OWNED_TREE_PROOFS.none,
      treeKilled: false,
      treeKillFailure: null,
    }

    /**
     * Records what a platform tree kill actually reported.
     *
     * On Windows this command IS the termination guarantee, so discarding its
     * result would leave a failed kill indistinguishable from a successful one.
     */
    const noteTreeKill = (outcome) => {
      facts.treeKilled = true
      if (!outcome.ok) {
        facts.treeKillFailure = outcome.error
          ? `taskkill failed to start: ${outcome.error.message}`
          : `taskkill exited ${outcome.code}`
      }
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
        // Raw OS facts, reported exactly as the platform gave them. On POSIX a
        // terminated child carries a signal and a null code; on Windows it
        // carries an exit code and a null signal. Neither is normalised away.
        code: exitInfo?.code ?? null,
        signal: exitInfo?.signal ?? null,
        stdout,
        stderr,
        timedOut: facts.timedOut,
        descendantsHeldStdio: facts.descendantsHeldStdio,
        forceKilled: facts.forceKilled,
        ownedTreeState: facts.treeState,
        ownedTreeProof: facts.treeProof,
        // The semantic outcome, which IS the same on every platform. Controls
        // that need to prove "this child was force-killed" assert on this;
        // asserting on `signal` made them assert a POSIX implementation detail
        // that Windows cannot produce, and both Windows lanes failed on
        // `expected null to be 'SIGKILL'` for a child that was in fact killed.
        outcome: classifyOutcome(),
        ...extra,
      })
    }

    /**
     * One semantic verdict, derived from facts rather than from a raw signal.
     *
     * Ordered most-specific first: a timed-out child is also force-killed, and
     * reporting it as merely `force_killed` would lose the reason.
     */
    const classifyOutcome = () => {
      if (facts.timedOut) return 'timed_out'
      if (facts.forceKilled) return 'force_killed'
      if (facts.descendantsHeldStdio) return 'terminated'
      if (exitInfo?.signal != null) return 'terminated'
      return 'exited'
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
      if (state === 'empty') {
        if (facts.treeKillFailure !== null) {
          // The leader is gone, but the command that owns its descendants
          // reported failure, so nothing establishes that they went with it.
          // A dead leader is not a proof of an empty tree on Windows.
          failSettle(new OwnedProcessTreeUnprovableError(
            `"${command} ${args.join(' ')}" (${facts.treeKillFailure})`,
          ))
          return
        }
        facts.treeProof = process.platform !== 'win32'
          ? OWNED_TREE_PROOFS.processGroupProbe
          : facts.treeKilled
            ? OWNED_TREE_PROOFS.leaderExitAndTreeKill
            : OWNED_TREE_PROOFS.leaderExit
        settle()
        return
      }

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
        terminateChildTree(child, 'SIGKILL', noteTreeKill)
      } else {
        terminateChildTree(child, 'SIGTERM', noteTreeKill)
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
