import { describe, expect, test } from 'vitest'

import { createPhaseRun, PhaseDeadlock, PhaseFailure } from './helpers/phase-run.js'

function injectedClock(...values: number[]): () => number {
  let index = 0
  return () => {
    const value = values[index]
    if (value === undefined) {
      throw new Error(`Injected clock exhausted at call ${index + 1}`)
    }
    index += 1
    return value
  }
}

function captureThrown(run: () => void): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('Expected callback to throw')
}

describe('workspace phase runs', () => {
  test('allows logical work durations well beyond 20 seconds', () => {
    const phases = createPhaseRun({ label: 'long-logical-run', now: injectedClock(0, 25_000, 25_000, 45_000) })

    expect(phases.phase('first', () => 'first-result')).toBe('first-result')
    expect(phases.phase('second', () => 'second-result')).toBe('second-result')

    expect(phases.timeline().map((record) => record.durationMs)).toEqual([25_000, 20_000])
    expect(phases.timeline().every((record) => record.status === 'ok')).toBe(true)
    expect(phases.format()).toContain('total=45000ms')
  })

  test('preserves phase ordering in the timeline', () => {
    const phases = createPhaseRun({ label: 'ordered', now: injectedClock(0, 1, 2, 3, 4, 5) })

    phases.phase('alpha', () => undefined)
    phases.phase('beta', () => undefined)
    phases.cleanup('gamma', () => undefined)

    expect(phases.timeline().map((record) => record.name)).toEqual(['alpha', 'beta', 'gamma'])
  })

  test('names the exact failing phase and preserves the original cause', () => {
    const reports: string[] = []
    const original = new Error('work exploded')
    const phases = createPhaseRun({
      label: 'failure',
      now: injectedClock(100, 140),
      report: (text) => reports.push(text),
    })

    const caught = captureThrown(() => phases.phase('resolve-workspace', () => {
      throw original
    }))

    expect(caught).toBeInstanceOf(PhaseFailure)
    expect(caught).not.toBeInstanceOf(PhaseDeadlock)
    expect((caught as PhaseFailure).phase).toBe('resolve-workspace')
    expect((caught as PhaseFailure).message).toBe('failure: phase "resolve-workspace" failed after 40 ms')
    expect((caught as PhaseFailure).cause).toBe(original)
    phases.emit()
    expect(reports).toHaveLength(1)
  })

  test('retains completed durations before a later failure', () => {
    const phases = createPhaseRun({ label: 'partial', now: injectedClock(0, 10, 10, 35) })

    phases.phase('completed', () => undefined)
    captureThrown(() => phases.phase('failed', () => {
      throw new Error('later failure')
    }))

    expect(phases.timeline().map(({ name, status, durationMs }) => ({ name, status, durationMs }))).toEqual([
      { name: 'completed', status: 'ok', durationMs: 10 },
      { name: 'failed', status: 'failed', durationMs: 25 },
    ])
  })

  test('does not re-wrap a nested PhaseFailure', () => {
    const phases = createPhaseRun({ label: 'nested', now: injectedClock(0, 1, 3, 5) })
    let innerFailure: unknown

    const caught = captureThrown(() => phases.phase('outer', () => {
      try {
        phases.phase('inner', () => {
          throw new Error('inner failure')
        })
      } catch (error) {
        innerFailure = error
        throw error
      }
    }))

    expect(caught).toBe(innerFailure)
    expect(caught).toBeInstanceOf(PhaseFailure)
    expect((caught as PhaseFailure).phase).toBe('inner')
  })

  test('runs cleanup after a work failure', () => {
    const events: string[] = []
    const phases = createPhaseRun({ label: 'cleanup-after-work', now: injectedClock(0, 5, 5, 6) })

    const caught = captureThrown(() => {
      try {
        phases.phase('work', () => {
          events.push('work')
          throw new Error('work failed')
        })
      } finally {
        phases.cleanup('cleanup', () => {
          events.push('cleanup')
        })
      }
    })

    expect(caught).toBeInstanceOf(PhaseFailure)
    expect(events).toEqual(['work', 'cleanup'])
    expect(phases.timeline().map((record) => record.name)).toEqual(['work', 'cleanup'])
  })

  test('carries cleanup records that ran after the failure was thrown', () => {
    const phases = createPhaseRun({ label: 'live-failure-timeline', now: injectedClock(0, 7, 7, 11) })
    const caught = captureThrown(() => phases.phase('work', () => {
      throw new Error('work failed')
    }))

    expect(caught).toBeInstanceOf(PhaseFailure)
    phases.cleanup('remove-temp-root', () => undefined)

    expect((caught as PhaseFailure).timeline.map(({ name, kind, durationMs }) => ({ name, kind, durationMs }))).toEqual([
      { name: 'work', kind: 'work', durationMs: 7 },
      { name: 'remove-temp-root', kind: 'cleanup', durationMs: 4 },
    ])
  })

  test('runs cleanup after a simulated graph-generation failure', () => {
    const generatorError = new Error('graph generator failed')
    const generateGraphStub = (): never => {
      throw generatorError
    }
    let cleaned = false
    const phases = createPhaseRun({ label: 'graph-failure', now: injectedClock(0, 8, 8, 10) })

    const caught = captureThrown(() => {
      try {
        phases.phase('generate-graph', generateGraphStub)
      } finally {
        phases.cleanup('remove-temp-root', () => {
          cleaned = true
        })
      }
    })

    expect(caught).toBeInstanceOf(PhaseFailure)
    expect((caught as PhaseFailure).phase).toBe('generate-graph')
    expect((caught as PhaseFailure).cause).toBe(generatorError)
    expect(cleaned).toBe(true)
  })

  test('records cleanup failure without replacing the work failure', () => {
    const workError = new Error('original work failure')
    const cleanupError = new Error('cleanup failure')
    const phases = createPhaseRun({ label: 'dual-failure', now: injectedClock(0, 4, 4, 7) })

    const caught = captureThrown(() => {
      try {
        phases.phase('work', () => {
          throw workError
        })
      } finally {
        phases.cleanup('cleanup', () => {
          throw cleanupError
        })
      }
    })

    expect(caught).toBeInstanceOf(PhaseFailure)
    expect((caught as PhaseFailure).phase).toBe('work')
    expect((caught as PhaseFailure).cause).toBe(workError)
    expect(phases.cleanupErrors()).toHaveLength(1)
    expect(phases.cleanupErrors()[0]?.phase).toBe('cleanup')
    expect(phases.cleanupErrors()[0]?.cause).toBe(cleanupError)
  })

  test('classifies a timed-out phase as a deadlock and retains its diagnostics', () => {
    const timedOut = Object.assign(new Error('spawn timed out'), { code: 'ETIMEDOUT' })
    const phases = createPhaseRun({ label: 'deadlock', now: injectedClock(0, 120, 120, 30_120) })

    phases.phase('git-init', () => undefined)
    const caught = captureThrown(() => phases.phase('git-commit', () => {
      throw timedOut
    }))

    expect(caught).toBeInstanceOf(PhaseDeadlock)
    expect((caught as PhaseDeadlock).phase).toBe('git-commit')
    expect((caught as PhaseDeadlock).message).toBe('deadlock: phase "git-commit" exceeded its deadlock limit after 30000 ms')
    expect((caught as PhaseDeadlock).cause).toBe(timedOut)

    // The failure must carry the diagnostics, not merely the phase name: every
    // completed phase and its duration travels with the thrown error, so a
    // reader of the failure alone can see what ran and how long it took.
    expect((caught as PhaseDeadlock).timeline.map(({ name, status, durationMs }) => ({ name, status, durationMs }))).toEqual([
      { name: 'git-init', status: 'ok', durationMs: 120 },
      { name: 'git-commit', status: 'failed', durationMs: 30_000 },
    ])

    const markedDeadlock = Object.assign(new Error('child received a signal'), { isDeadlock: true })
    const markedPhases = createPhaseRun({ label: 'marked-deadlock', now: injectedClock(0, 1) })
    const markedCaught = captureThrown(() => markedPhases.phase('worktree-add', () => {
      throw markedDeadlock
    }))
    expect(markedCaught).toBeInstanceOf(PhaseDeadlock)
    expect((markedCaught as PhaseDeadlock).phase).toBe('worktree-add')
  })

  test('rejects duplicate phase names before running them again', () => {
    const phases = createPhaseRun({ label: 'duplicates', now: injectedClock(0, 1) })
    let ranAgain = false

    phases.phase('same-name', () => undefined)

    expect(() => phases.cleanup('same-name', () => {
      ranAgain = true
    })).toThrow('duplicates: duplicate phase name "same-name"')
    expect(ranAgain).toBe(false)
  })

  test('formats deterministically and emits nothing for a successful run', () => {
    const reports: string[] = []
    const phases = createPhaseRun({
      label: 'deterministic',
      now: injectedClock(100, 112, 200, 205),
      report: (text) => reports.push(text),
    })

    phases.phase('work', () => undefined)
    phases.cleanup('cleanup', () => undefined)

    expect(phases.format()).toBe([
      '[phase-run] deterministic total=17ms',
      '[phase-run] deterministic 1. work work ok 12ms',
      '[phase-run] deterministic 2. cleanup cleanup ok 5ms',
    ].join('\n'))
    phases.emit()
    expect(reports).toEqual([])
  })
})
