import { spawn } from 'node:child_process'

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

/** Windows has no process groups; each platform gets its own tree kill. */
function killTree(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    // Narrowly scoped to this pid and its descendants, never a name match.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    // Negative pid targets the process group this child leads, so a build's
    // own children die with it rather than outliving the run.
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
  }
}

export function terminateChildTree(child, signal = 'SIGTERM') {
  killTree(child, signal)
}

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

    const token = registry?.registerChild(description, child) ?? null
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let forceTimer = null

    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })

    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        terminateChildTree(child, 'SIGTERM')
        // A child that ignores graceful termination is force-killed rather
        // than allowed to hold the run open indefinitely.
        forceTimer = setTimeout(() => terminateChildTree(child, 'SIGKILL'), graceMs)
      }, timeoutMs)
      : null

    child.on('error', (error) => {
      if (timer !== null) clearTimeout(timer)
      if (forceTimer !== null) clearTimeout(forceTimer)
      if (token !== null) registry?.releaseChild(token)
      reject(error)
    })

    // `close` rather than `exit`: stdio is drained before the result is built,
    // so evidence is never truncated by winning a race with the pipes.
    child.on('close', (code, signal) => {
      if (timer !== null) clearTimeout(timer)
      if (forceTimer !== null) clearTimeout(forceTimer)
      if (token !== null) registry?.releaseChild(token)
      resolve({ code, signal, stdout, stderr, timedOut })
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
