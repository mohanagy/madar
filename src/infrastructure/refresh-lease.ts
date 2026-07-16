import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REFRESH_LOCK_FILENAME = '.madar-refresh.lock'
const REFRESH_RECOVERY_LOCK_FILENAME = '.madar-refresh.recovery.lock'
const DEFAULT_RETRY_MIN_MS = 50
const DEFAULT_RETRY_MAX_MS = 1_000
const DEFAULT_SYNC_TIMEOUT_MS = 30_000
const INCOMPLETE_LEASE_GRACE_MS = 5_000

export type ReleaseRefreshLease = () => void

interface RefreshLeaseOwner {
  pid: number
  leaseId: string
  acquiredAt: string
}

export interface RefreshLeaseOptions {
  /** Internal test seam. Production uses process.kill(pid, 0). */
  isProcessAlive?: (pid: number) => boolean
  /** Internal test seam for retry timing. */
  retryMinMs?: number
  /** Internal test seam for retry timing. */
  retryMaxMs?: number
  /** Stops an asynchronous lease wait when its watcher is shutting down. */
  signal?: AbortSignal
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : null
    // EPERM means the process exists but belongs to another user.
    return code === 'EPERM'
  }
}

function parseRefreshLease(contents: string): RefreshLeaseOwner | null {
  const [pidValue, leaseId, acquiredAt] = contents.trim().split(/\s+/, 3)
  const pid = Number(pidValue)
  if (
    !Number.isSafeInteger(pid)
    || pid <= 0
    || !leaseId
    || !acquiredAt
    || !Number.isFinite(Date.parse(acquiredAt))
  ) {
    return null
  }
  return { pid, leaseId, acquiredAt }
}

function createExclusiveLease(lockPath: string): ReleaseRefreshLease | null {
  let descriptor: number
  try {
    descriptor = openSync(lockPath, 'wx')
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : null
    if (code === 'EEXIST') {
      return null
    }
    throw error
  }

  const leaseId = randomUUID()
  try {
    writeFileSync(descriptor, `${process.pid} ${leaseId} ${new Date().toISOString()}\n`, 'utf8')
  } finally {
    closeSync(descriptor)
  }

  return () => {
    try {
      const contents = readFileSync(lockPath, 'utf8')
      if (parseRefreshLease(contents)?.leaseId === leaseId) {
        rmSync(lockPath, { force: true })
      }
    } catch {
      // The owner may have crashed or the lease may already have been recovered.
    }
  }
}

function lockIsOldEnoughToRecoverIncompleteMetadata(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs >= INCOMPLETE_LEASE_GRACE_MS
  } catch {
    return false
  }
}

function tryAcquireRecoveryGuard(outputDir: string): ReleaseRefreshLease | null {
  const recoveryPath = join(outputDir, REFRESH_RECOVERY_LOCK_FILENAME)
  const release = createExclusiveLease(recoveryPath)
  if (release) {
    return release
  }

  // A crashed contender must not leave dead-lease recovery disabled forever.
  try {
    const contents = readFileSync(recoveryPath, 'utf8')
    const owner = parseRefreshLease(contents)
    if (
      (owner && !processIsAlive(owner.pid))
      || (!owner && lockIsOldEnoughToRecoverIncompleteMetadata(recoveryPath))
    ) {
      if (readFileSync(recoveryPath, 'utf8') === contents) {
        rmSync(recoveryPath, { force: true })
      }
    }
  } catch {
    // Another contender may have completed recovery between reads.
  }
  return null
}

function recoverUnavailableLease(
  outputDir: string,
  lockPath: string,
  isProcessAlive: (pid: number) => boolean,
): boolean {
  const releaseRecoveryGuard = tryAcquireRecoveryGuard(outputDir)
  if (!releaseRecoveryGuard) {
    return false
  }

  try {
    const observedContents = readFileSync(lockPath, 'utf8')
    const owner = parseRefreshLease(observedContents)
    if (owner ? isProcessAlive(owner.pid) : !lockIsOldEnoughToRecoverIncompleteMetadata(lockPath)) {
      return false
    }

    // Recheck the lease identity after acquiring the recovery guard. This keeps
    // two Madar contenders from deleting a newly published owner record.
    if (readFileSync(lockPath, 'utf8') !== observedContents) {
      return false
    }
    rmSync(lockPath, { force: true })
    return true
  } catch {
    return false
  } finally {
    releaseRecoveryGuard()
  }
}

export function tryAcquireRefreshLease(
  outputDir: string,
  options: RefreshLeaseOptions = {},
): ReleaseRefreshLease | null {
  mkdirSync(outputDir, { recursive: true })
  const lockPath = join(outputDir, REFRESH_LOCK_FILENAME)
  const isProcessAlive = options.isProcessAlive ?? processIsAlive

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const release = createExclusiveLease(lockPath)
    if (release) {
      return release
    }
    if (!recoverUnavailableLease(outputDir, lockPath, isProcessAlive)) {
      return null
    }
  }
  return null
}

function pauseSynchronously(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function nextBackoff(current: number, maximum: number): number {
  return Math.min(maximum, Math.max(current + 1, current * 2))
}

export function acquireRefreshLease(
  outputDir: string,
  options: RefreshLeaseOptions & { timeoutMs?: number } = {},
): ReleaseRefreshLease {
  const startedAt = Date.now()
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS)
  const retryMaxMs = Math.max(1, options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS)
  let retryMs = Math.min(retryMaxMs, Math.max(1, options.retryMinMs ?? DEFAULT_RETRY_MIN_MS))

  while (true) {
    const release = tryAcquireRefreshLease(outputDir, options)
    if (release) {
      return release
    }

    const remaining = timeoutMs - (Date.now() - startedAt)
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for another Madar refresh in ${outputDir}`)
    }
    pauseSynchronously(Math.min(retryMs, remaining))
    retryMs = nextBackoff(retryMs, retryMaxMs)
  }
}

function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false)
  }
  return new Promise<boolean>((resolvePromise) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise(true)
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      resolvePromise(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Waits for the active refresh owner without imposing a terminal contention
 * timeout. The caller's AbortSignal remains the bounded shutdown mechanism.
 */
export async function acquireRefreshLeaseWithoutBlocking(
  outputDir: string,
  options: RefreshLeaseOptions = {},
): Promise<ReleaseRefreshLease | null> {
  const retryMaxMs = Math.max(1, options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS)
  let retryMs = Math.min(retryMaxMs, Math.max(1, options.retryMinMs ?? DEFAULT_RETRY_MIN_MS))

  while (!options.signal?.aborted) {
    const release = tryAcquireRefreshLease(outputDir, options)
    if (release) {
      return release
    }
    if (!await waitForRetry(retryMs, options.signal)) {
      return null
    }
    retryMs = nextBackoff(retryMs, retryMaxMs)
  }
  return null
}
