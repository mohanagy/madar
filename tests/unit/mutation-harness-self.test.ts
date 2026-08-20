import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  baselineVerdict,
  matchesExpectation,
  planMutation,
  readSuiteResult,
  scoreMutant,
} from '../../scripts/lib/mutation-scoring.mjs'

/** A Vitest JSON report with the given test outcomes. */
function report(...outcomes: Array<[string, 'passed' | 'failed']>): unknown {
  return {
    testResults: [{
      assertionResults: outcomes.map(([fullName, status]) => ({ fullName, status })),
    }],
  }
}

const usable = (...outcomes: Array<[string, 'passed' | 'failed']>) =>
  readSuiteResult({ raw: '', report: report(...outcomes) })

describe('mutation harness — a run must be usable before it is evidence', () => {
  it('reads failures by exact test identity', () => {
    const result = usable(['suite names the invariant', 'failed'], ['suite does something else', 'passed'])
    expect(result).toEqual({ usable: true, total: 2, failed: ['suite names the invariant'] })
  })

  it('refuses a worker startup failure', () => {
    const result = readSuiteResult({ raw: 'Failed to start forks worker', report: null })
    expect(result).toEqual({ usable: false, why: 'worker startup failure' })
  })

  it('refuses a worker timeout', () => {
    const result = readSuiteResult({ raw: 'Timeout waiting for worker to respond', report: null })
    expect(result.usable).toBe(false)
  })

  it('refuses a run that produced no report', () => {
    expect(readSuiteResult({ raw: '', report: null }))
      .toEqual({ usable: false, why: 'no JSON report produced' })
  })

  it('refuses a non-test crash that executed nothing', () => {
    // A collection error reports a suite with no assertions. Scoring that as
    // green would read a crash as proof the invariant is uncovered.
    expect(readSuiteResult({ raw: '', report: { testResults: [{ assertionResults: [] }] } }))
      .toEqual({ usable: false, why: 'suite did not execute any test' })
  })
})

describe('mutation harness — a mutation must actually be applied', () => {
  const source = 'const a = 1\nconst b = 2\n'

  it('applies a unique anchor', () => {
    const plan = planMutation({ source, from: 'const a = 1', to: 'const a = 9' })
    expect(plan).toEqual({ ok: true, mutated: 'const a = 9\nconst b = 2\n' })
  })

  it('refuses a stale anchor', () => {
    // The original defect: a multi-line anchor that no longer exists was
    // treated as applied, and the suite ran on unmutated source.
    expect(planMutation({ source, from: 'const a = 1\nconst gone = 0', to: 'x' }))
      .toEqual({ ok: false, why: 'anchor not found' })
  })

  it('refuses an ambiguous anchor', () => {
    expect(planMutation({ source: 'x\nx\n', from: 'x', to: 'y' }))
      .toEqual({ ok: false, why: 'anchor is ambiguous' })
  })

  it('refuses a no-op replacement', () => {
    expect(planMutation({ source, from: 'const a = 1', to: 'const a = 1' }))
      .toEqual({ ok: false, why: 'mutation changed nothing' })
  })
})

describe('mutation harness — only a named expected failure counts as caught', () => {
  const expected = ['names the invariant']

  it('scores an expected failure as caught', () => {
    const score = scoreMutant({ expect: expected, result: usable(['suite names the invariant', 'failed']) })
    expect(score.kind).toBe('caught')
  })

  it('never scores an unrelated failure as caught', () => {
    // The exact misattribution the review found: red for some other reason is
    // not evidence about this mutant.
    const score = scoreMutant({ expect: expected, result: usable(['suite tests something else', 'failed']) })
    expect(score.kind).toBe('SKIPPED')
    expect(score.detail).toContain('only unrelated tests failed')
  })

  it('scores a green suite as uncaught', () => {
    const score = scoreMutant({ expect: expected, result: usable(['suite names the invariant', 'passed']) })
    expect(score.kind).toBe('UNCAUGHT')
  })

  it('refuses to score a mutant with no expectation declared', () => {
    const score = scoreMutant({ expect: [], result: usable(['anything', 'failed']) })
    expect(score.kind).toBe('SKIPPED')
    expect(score.detail).toBe('no expected test declared')
  })

  it('never scores an unusable run as caught or uncaught', () => {
    const score = scoreMutant({ expect: expected, result: { usable: false, why: 'worker startup failure' } })
    expect(score.kind).toBe('SKIPPED')
  })

  it('matches by substring and by regex', () => {
    expect(matchesExpectation('a suite names the invariant here', ['names the invariant'])).toBe(true)
    expect(matchesExpectation('a suite names the invariant here', [/^a suite.*here$/])).toBe(true)
    expect(matchesExpectation('unrelated', ['names the invariant'])).toBe(false)
  })
})

describe('mutation harness — restoration is proven, not assumed', () => {
  it('declares a restore that verifies the file came back', () => {
    // A run killed while blocked in a synchronous child can leave a mutation on
    // disk: the signal handler queues behind the blocking call and never runs
    // if the process group dies. That happened. The surviving mutation was
    // invisible to `git status` because the file was untracked -- git showed it
    // as a new file, which is exactly what it was meant to be.
    const source = readFileSync(join(process.cwd(), 'scripts/verify-integrity-mutations.mjs'), 'utf8')
    expect(source).toContain('FAILED TO RESTORE')
    expect(source).toContain('function assertNoResidualMutation()')
  })

  it('refuses to report a tally when a mutation survives', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/verify-integrity-mutations.mjs'), 'utf8')
    const guard = source.indexOf('const residual = assertNoResidualMutation()')
    expect(guard).toBeGreaterThan(-1)
    const tally = source.indexOf('caught=${caught}')
    // The refusal comes before the number, so a corrupted tree cannot produce
    // a result at all.
    expect(guard).toBeLessThan(tally)
    expect(source.slice(guard, tally)).toContain('process.exit(1)')
  })
})

describe('mutation harness — an already-red suite attributes nothing', () => {
  it('accepts a green baseline', () => {
    expect(baselineVerdict(usable(['a', 'passed']))).toBeNull()
  })

  it('refuses a baseline that is already red', () => {
    expect(baselineVerdict(usable(['a', 'failed']))).toContain('baseline already red')
  })

  it('refuses an unusable baseline', () => {
    expect(baselineVerdict({ usable: false, why: 'worker startup failure' }))
      .toContain('baseline unusable')
  })
})

/**
 * These two drive the real harness as a subprocess, and the harness writes to
 * production source while it runs. Nothing else may be reading those files at
 * the time, so they are opt-in rather than part of the parallel suite --
 * `npm run verify:integrity-mutations` sets the flag and runs them alone, after
 * the mutants themselves. Running them inside the parallel suite corrupted
 * concurrent workers, which is exactly the hazard they exist to guard against.
 */
const HARNESS_E2E = process.env['MADAR_MUTATION_HARNESS_E2E'] === '1'

describe('mutation harness — the working tree survives a run', () => {
  it('declares every mutant with a focused suite and an expectation', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/verify-integrity-mutations.mjs'), 'utf8')
    const names = source.match(/^ {4}name: '/gm) ?? []
    const tests = source.match(/^ {4}test: /gm) ?? []
    const expects = source.match(/^ {4}expect: \[/gm) ?? []
    expect(names.length).toBeGreaterThan(0)
    expect(tests).toHaveLength(names.length)
    expect(expects).toHaveLength(names.length)
  })

  it.runIf(HARNESS_E2E)('restores every mutated file, leaving the tree clean', () => {
    const before = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    execFileSync('node', ['scripts/verify-integrity-mutations.mjs', '--filter', 'R3-05'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000,
    })
    expect(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })).toBe(before)
  }, 600_000)

  it.runIf(HARNESS_E2E)('restores the tree even when interrupted', () => {
    const before = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    // Start a run, kill it mid-flight, and require the tree to come back. The
    // handler is the only thing standing between an interrupted run and a
    // repository left holding mutated production source.
    execFileSync('bash', ['-c',
      'node scripts/verify-integrity-mutations.mjs --filter R3-05 >/dev/null 2>&1 & '
      + 'pid=$!; sleep 8; kill -TERM $pid 2>/dev/null; wait $pid 2>/dev/null; exit 0',
    ], { encoding: 'utf8', timeout: 120_000 })
    expect(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })).toBe(before)
  }, 180_000)
})
