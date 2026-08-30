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
export async function setup(): Promise<() => Promise<void>> {
  const runRoot = createRunRoot()
  process.env[RUN_ROOT_ENV] = runRoot

  return async () => {
    // Idempotent and tolerant: workers may already have removed their own
    // directories, and the root may already be gone.
    removeRunRoot(runRoot)
    if (process.env[RUN_ROOT_ENV] === runRoot) delete process.env[RUN_ROOT_ENV]
  }
}
