import { createRunRoot, removeRunRoot, RUN_ROOT_ENV } from './helpers/run-home.js'

/**
 * One run identity, created before any worker starts and removed after the run
 * finishes -- including a run that finished because tests failed.
 *
 * Vitest calls the returned teardown for an ordinary failing run as well as a
 * passing one, which is what makes this the right owner: a per-worker
 * `afterAll` would not survive a worker that never reached its hooks, and the
 * previous layout had no owner at all.
 */

/**
 * Builds the teardown Vitest will call, with the remover injectable so the
 * failure path can be exercised without breaking a real filesystem.
 *
 * The exit status is set here on purpose, and an earlier version of this file
 * was wrong about why it has to be. Vitest 4.1.10 does not fail a run because
 * global teardown rejected: `Vitest.close()` collects the teardown rejection,
 * awaits it through `Promise.allSettled`, logs `error during close`, and then
 * neither rethrows nor touches `process.exitCode`. Leaving the error to
 * "propagate" therefore propagates it precisely nowhere -- the run root would
 * survive, the invocation would exit 0, and the leak this issue exists to stop
 * would be back, now invisible.
 *
 * So the teardown sets the status itself and still rethrows: the status is what
 * fails the invocation, and the rethrow is what puts the real filesystem error
 * in front of whoever has to fix it.
 *
 * A status that is already non-zero is left alone. A run that failed for its own
 * reasons should keep reporting that reason rather than have it overwritten by a
 * cleanup code.
 */
export function createRunTeardown(
  runRoot: string,
  remove: (root: string) => boolean = removeRunRoot,
): () => Promise<void> {
  return async () => {
    try {
      // Idempotent and tolerant: workers may already have removed their own
      // directories, and the root may already be gone.
      remove(runRoot)
    } catch (error) {
      if (process.exitCode == null || Number(process.exitCode) === 0) {
        process.exitCode = 1
      }
      throw error
    } finally {
      // Only this run's variable, and only while it still names this root.
      if (process.env[RUN_ROOT_ENV] === runRoot) delete process.env[RUN_ROOT_ENV]
    }
  }
}

export async function setup(): Promise<() => Promise<void>> {
  const runRoot = createRunRoot()
  process.env[RUN_ROOT_ENV] = runRoot
  return createRunTeardown(runRoot)
}
