/**
 * Aggregate wall-clock timeouts cannot identify the slow phase, and Vitest
 * cannot interrupt a synchronous test body when its per-test timeout expires.
 */

import { onTestFinished } from 'vitest'

export interface PhaseRecord {
  readonly name: string
  readonly kind: 'work' | 'cleanup'
  readonly status: 'ok' | 'failed'
  readonly startedAtMs: number
  readonly durationMs: number
  readonly error?: unknown
}

export interface PhaseRunOptions {
  readonly label: string
  /** Injected monotonic clock in milliseconds. Defaults to a real monotonic source. */
  readonly now?: () => number
  /** Optional sink for the report. Defaults to console output. */
  readonly report?: (text: string) => void
}

export interface PhaseRun {
  phase<T>(name: string, run: () => T): T
  cleanup(name: string, run: () => void): void
  timeline(): readonly PhaseRecord[]
  cleanupErrors(): readonly PhaseFailure[]
  format(): string
  emit(testFailed?: boolean): void
}

export class PhaseFailure extends Error {
  readonly phase: string
  readonly kind: 'work' | 'cleanup'
  readonly durationMs: number
  /**
   * Live reference to the run's records, deliberately not a snapshot. The
   * asymmetry with `timeline()`, which copies, is intentional: a failure needs
   * to carry the cleanup phases that ran *after* it, since whether cleanup
   * succeeded is part of diagnosing the failure. Snapshotting at throw time
   * would discard exactly the evidence a post-hoc timeout verdict already
   * fails to produce. `timeline()` copies because its callers are reading a
   * finished run rather than holding a handle to one still in progress.
   */
  readonly timeline: readonly PhaseRecord[]

  constructor(
    message: string,
    options: {
      cause: unknown
      phase: string
      kind: 'work' | 'cleanup'
      durationMs: number
      timeline: readonly PhaseRecord[]
    },
  ) {
    super(message, { cause: options.cause })
    this.name = 'PhaseFailure'
    this.phase = options.phase
    this.kind = options.kind
    this.durationMs = options.durationMs
    this.timeline = options.timeline
  }
}

export class PhaseDeadlock extends PhaseFailure {
  constructor(
    message: string,
    options: {
      cause: unknown
      phase: string
      kind: 'work' | 'cleanup'
      durationMs: number
      timeline: readonly PhaseRecord[]
    },
  ) {
    super(message, options)
    this.name = 'PhaseDeadlock'
  }
}

function causeMessage(failure: PhaseFailure): string {
  const { cause } = failure
  if (typeof cause === 'object' && cause !== null && 'message' in cause && typeof cause.message === 'string') {
    return cause.message
  }
  return failure.message
}

function isDeadlock(error: unknown): boolean {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') {
    return false
  }
  return ('isDeadlock' in error && Boolean(error.isDeadlock)) || ('code' in error && error.code === 'ETIMEDOUT')
}

export function createPhaseRun(options: PhaseRunOptions): PhaseRun {
  const now = options.now ?? (() => performance.now())
  const report = options.report ?? ((text: string) => console.log(text))
  const records: PhaseRecord[] = []
  const failures: PhaseFailure[] = []
  const names = new Set<string>()

  const reserveName = (name: string): void => {
    if (names.has(name)) {
      throw new Error(`${options.label}: duplicate phase name "${name}"`)
    }
    names.add(name)
  }

  const durationSince = (startedAtMs: number): number => Math.round(now() - startedAtMs)

  const phase = <T>(name: string, run: () => T): T => {
    reserveName(name)
    const startedAtMs = now()
    try {
      const value = run()
      records.push({ name, kind: 'work', status: 'ok', startedAtMs, durationMs: durationSince(startedAtMs) })
      return value
    } catch (error) {
      const durationMs = durationSince(startedAtMs)
      records.push({ name, kind: 'work', status: 'failed', startedAtMs, durationMs, error })
      if (error instanceof PhaseFailure) {
        throw error
      }
      const Failure = isDeadlock(error) ? PhaseDeadlock : PhaseFailure
      const message = isDeadlock(error)
        ? `${options.label}: phase "${name}" exceeded its deadlock limit after ${durationMs} ms`
        : `${options.label}: phase "${name}" failed after ${durationMs} ms`
      throw new Failure(message, {
        cause: error,
        phase: name,
        kind: 'work',
        durationMs,
        timeline: records,
      })
    }
  }

  const cleanup = (name: string, run: () => void): void => {
    reserveName(name)
    const startedAtMs = now()
    try {
      run()
      records.push({ name, kind: 'cleanup', status: 'ok', startedAtMs, durationMs: durationSince(startedAtMs) })
    } catch (error) {
      const durationMs = durationSince(startedAtMs)
      records.push({ name, kind: 'cleanup', status: 'failed', startedAtMs, durationMs, error })
      const Failure = isDeadlock(error) ? PhaseDeadlock : PhaseFailure
      const message = isDeadlock(error)
        ? `${options.label}: cleanup phase "${name}" exceeded its deadlock limit after ${durationMs} ms`
        : `${options.label}: cleanup phase "${name}" failed after ${durationMs} ms`
      failures.push(new Failure(message, {
        cause: error,
        phase: name,
        kind: 'cleanup',
        durationMs,
        timeline: records,
      }))
    }
  }

  const timeline = (): readonly PhaseRecord[] => records.slice()
  const cleanupErrors = (): readonly PhaseFailure[] => failures.slice()
  const format = (): string => {
    const totalMs = records.reduce((total, record) => total + record.durationMs, 0)
    const lines = [`[phase-run] ${options.label} total=${totalMs}ms`]
    records.forEach((record, index) => {
      lines.push(`[phase-run] ${options.label} ${index + 1}. ${record.kind} ${record.name} ${record.status} ${record.durationMs}ms`)
    })
    failures.forEach((failure) => {
      lines.push(`[phase-run] ${options.label} cleanup-error ${failure.phase}: ${causeMessage(failure)}`)
    })
    return lines.join('\n')
  }

  return {
    phase,
    cleanup,
    timeline,
    cleanupErrors,
    format,
    emit: (testFailed = false) => {
      if (testFailed || records.some((record) => record.status === 'failed') || failures.length > 0) {
        report(format())
      }
    },
  }
}

export function usePhaseRun(label: string): PhaseRun {
  const phases = createPhaseRun({ label })
  onTestFinished((context) => {
    phases.emit(context.task.result?.state === 'fail')
  })
  return phases
}
