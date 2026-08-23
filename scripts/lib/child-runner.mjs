import { spawn } from 'node:child_process'

import { ResourceRegistryShuttingDownError } from './shutdown-error.mjs'

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
 * Runs a child to completion, or terminates it on timeout.
 *
 * The child is registered with the owning registry immediately after spawn and
 * released only once its exit has actually been observed, so a signal arriving
 * at any point finds it and can reap it.
 */
export function runChild(command, args, options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 0,
    registry = null,
    description = `${command} ${args.join(' ')}`,
    graceMs = 5000,
  } = options

  return new Promise((resolve, reject) => {
    // Pre-spawn gate: after shutdown begins, no PID is created at all. Spawning
    // and immediately killing would still start work the coordinator has
    // already declared closed.
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

    // The narrow race: shutdown may have started between the reservation and
    // here. The just-spawned child is then terminated and reaped rather than
    // left running unregistered.
    let token = null
    if (registry !== null) {
      if (reservation !== null && !reservation.valid()) {
        terminateChildTree(child, 'SIGTERM')
        // The same typed class the pre-spawn gate throws. A plain Error here
        // would make the race path indistinguishable from an ordinary failure,
        // and a caller that retried on failure would retry into a shutdown.
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
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let descendantsHeldStdio = false
    let forceTimer = null
    let drainTimer = null
    let settled = false
    let exitInfo = null

    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })

    /**
     * Resolves exactly once and cancels every timer first.
     *
     * A stale timer must never be able to convert a completed child into a
     * timeout after the fact, so cancellation happens here rather than at each
     * call site.
     */
    const settle = (outcome) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (forceTimer !== null) clearTimeout(forceTimer)
      if (drainTimer !== null) clearTimeout(drainTimer)
      if (token !== null) registry?.releaseChild(token)
      resolve(outcome)
    }

    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        terminateChildTree(child, 'SIGTERM')
        // A child that ignores graceful termination is force-killed rather
        // than allowed to hold the run open indefinitely.
        forceTimer = setTimeout(() => {
          terminateChildTree(child, 'SIGKILL')
          // Even SIGKILL cannot make an unreachable holder release a pipe, so
          // the wait itself is bounded rather than trusting `close` to arrive.
          drainTimer = setTimeout(() => settle({
            code: exitInfo?.code ?? null,
            signal: exitInfo?.signal ?? null,
            stdout,
            stderr,
            timedOut,
            descendantsHeldStdio,
          }), graceMs)
        }, graceMs)
      }, timeoutMs)
      : null

    child.on('error', (error) => {
      if (timer !== null) clearTimeout(timer)
      if (forceTimer !== null) clearTimeout(forceTimer)
      if (drainTimer !== null) clearTimeout(drainTimer)
      if (token !== null) registry?.releaseChild(token)
      if (!settled) { settled = true; reject(error) }
    })

    // `exit` is process completion; `close` is stdio completion. They are not
    // the same event and conflating them is what let a finished child be
    // reported as a timeout: a descendant inherited the pipes, `close` never
    // arrived, and the wait outlived its own bound.
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal }
      if (settled) return
      // Give the pipes a bounded moment to drain normally, then reclaim them
      // from any descendant still holding them.
      drainTimer = setTimeout(() => {
        descendantsHeldStdio = true
        terminateChildTree(child, 'SIGTERM')
        forceTimer = setTimeout(() => {
          terminateChildTree(child, 'SIGKILL')
          settle({ code, signal, stdout, stderr, timedOut, descendantsHeldStdio })
        }, graceMs)
      }, STDIO_DRAIN_GRACE_MS)
    })

    // The ordinary path: stdio drained before the result is built, so evidence
    // is never truncated by winning a race with the pipes.
    child.on('close', (code, signal) => {
      settle({
        code: code ?? exitInfo?.code ?? null,
        signal: signal ?? exitInfo?.signal ?? null,
        stdout,
        stderr,
        timedOut,
        descendantsHeldStdio,
      })
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
