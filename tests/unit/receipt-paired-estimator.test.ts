import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { carryForwardSupersededEstimates } from '../../scripts/lib/receipt-estimate-history.mjs'

/**
 * The receipt runner's ratio must describe a comparison that actually happened.
 *
 * Sessions are counterbalanced on purpose: one measures baseline first, the
 * other candidate first, so that ordering effects cancel. The published ratio
 * then reduced the two arms INDEPENDENTLY -- a minimum per arm across sessions
 * -- so it could take the baseline median from one order and the candidate
 * median from the other. That pairing was never measured, and it throws away
 * the counterbalancing entirely.
 *
 * On `src-plus-tests-js-ts` it published 943.3 against 941.9 for a ratio of
 * 0.999, while the two sessions measured 1.029 and 0.946. The published number
 * sat between two figures that disagreed by more than 8%, and looked like the
 * quietest result of the three.
 *
 * The estimator is the geometric mean of the per-session ratios. It has to be
 * geometric rather than arithmetic because a ratio estimator must be
 * symmetric: swapping baseline and candidate has to invert the result exactly.
 */

const ROOT = process.cwd()
const BENCH = join(ROOT, 'docs/benchmarks')

interface Session {
  readonly order: string
  readonly baseline: { readonly medianMs: number; readonly peakRssMb: number }
  readonly candidate: { readonly medianMs: number; readonly peakRssMb: number }
}

interface Comparison {
  readonly corpus_scope?: string
  readonly sessions?: readonly Session[]
  readonly ratio?: number
  readonly rss_ratio?: number
  readonly estimator?: string
  readonly session_ratios?: readonly { readonly order: string; readonly wall_ratio: number }[]
  readonly superseded_estimate?: Record<string, unknown>
  readonly baseline_median_ms?: number
  readonly candidate_median_ms?: number
}

const geometricMean = (values: readonly number[]): number =>
  Math.exp(values.reduce((total, value) => total + Math.log(value), 0) / values.length)

/** Every tracked receipt comparison that carries counterbalanced sessions. */
function pairedComparisons(): { file: string; comparison: Comparison }[] {
  const found: { file: string; comparison: Comparison }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (!entry.name.endsWith('.json')) continue
      let parsed: unknown
      try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch { continue }
      const performance = (parsed as { performance?: { comparisons?: Comparison[] } })?.performance
      for (const comparison of performance?.comparisons ?? []) {
        if ((comparison.sessions?.length ?? 0) >= 2) found.push({ file: path, comparison })
      }
    }
  }
  walk(BENCH)
  return found
}

describe('PE-01 — the estimator is symmetric and paired', () => {
  it('inverts exactly when baseline and candidate are swapped', () => {
    // The property that makes a geometric mean the right aggregate for ratios.
    // An arithmetic mean fails this: mean(2, 1/2) is 1.25, not 1.
    const ratios = [1.029, 0.946]
    const inverted = ratios.map((value) => 1 / value)
    expect(geometricMean(ratios) * geometricMean(inverted)).toBeCloseTo(1, 12)
  })

  it('is not the arithmetic mean, which is not symmetric', () => {
    const ratios = [2, 0.5]
    const arithmetic = ratios.reduce((total, value) => total + value, 0) / ratios.length
    expect(geometricMean(ratios)).toBeCloseTo(1, 12)
    expect(arithmetic).toBeCloseTo(1.25, 12)
  })

  it('rejects the per-arm minimum, which can pair medians from different orders', () => {
    // The defect, reproduced on the genuine numbers. The mixed pairing reads
    // as a 0.1% difference while both real sessions disagree with it and with
    // each other by an order of magnitude more.
    const sessions = [
      { baseline: 943.3, candidate: 970.7 },
      { baseline: 996.1, candidate: 941.9 },
    ]
    const mixed = Math.min(...sessions.map((s) => s.candidate))
      / Math.min(...sessions.map((s) => s.baseline))
    const paired = geometricMean(sessions.map((s) => s.candidate / s.baseline))

    expect(Number(mixed.toFixed(3))).toBe(0.999)
    expect(Number(paired.toFixed(3))).toBe(0.986)
    // And the mixed figure corresponds to no session at all.
    for (const session of sessions) {
      expect(Number((session.candidate / session.baseline).toFixed(3))).not.toBe(0.999)
    }
  })
})

describe('PE-02 — every tracked receipt uses that estimator', () => {
  const comparisons = pairedComparisons()

  it('finds the counterbalanced receipts to check', () => {
    // Guards against this whole block passing because it found nothing.
    expect(comparisons.length).toBeGreaterThan(0)
  })

  for (const { file, comparison } of comparisons) {
    const label = `${file.slice(BENCH.length + 1)} ${comparison.corpus_scope ?? ''}`.trim()

    it(`${label} publishes the paired geometric mean`, () => {
      const sessions = comparison.sessions as readonly Session[]
      const expected = geometricMean(sessions.map((s) => s.candidate.medianMs / s.baseline.medianMs))
      expect(comparison.ratio).toBe(Number(expected.toFixed(3)))
    })

    it(`${label} retains its per-session ratios`, () => {
      // An aggregate that hides two disagreeing sessions is how a mixed-order
      // number looked reasonable in the first place.
      expect(comparison.estimator).toContain('geometric mean')
      expect(comparison.session_ratios).toHaveLength((comparison.sessions ?? []).length)
    })

    it(`${label} records what it superseded rather than rewriting it`, () => {
      expect(comparison.superseded_estimate).toBeDefined()
      expect(comparison.superseded_estimate?.['reason']).toBe('PERF-PAIR-01')
      expect(typeof comparison.superseded_estimate?.['ratio']).toBe('number')
    })

    it(`${label} keeps the published medians consistent with the published ratio`, () => {
      // geomean(head)/geomean(base) === geomean(head/base) exactly, so the two
      // numbers a reader divides must agree with the ratio beside them.
      const quotient = (comparison.candidate_median_ms as number) / (comparison.baseline_median_ms as number)
      expect(quotient).toBeCloseTo(comparison.ratio as number, 2)
    })
  }
})


describe('PE-03 — regenerating a migrated receipt keeps its history', () => {
  /**
   * The runner produces the corrected estimator fields and knows nothing about
   * what they replaced. Regenerating a migrated receipt in place would
   * therefore delete `superseded_estimate` silently -- and PE-02 above requires
   * that field on every tracked paired comparison, so the contract would fail
   * on some later run rather than at the moment the history was lost.
   */
  const scratch: string[] = []
  afterAll(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function previousReceipt(body: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'madar-receipt-history-'))
    scratch.push(dir)
    const path = join(dir, 'receipt.json')
    writeFileSync(path, JSON.stringify(body, null, 2))
    return path
  }

  const migrated = {
    performance: {
      comparisons: [{
        corpus_scope: 'src-only',
        superseded_estimate: { reason: 'PERF-PAIR-01', ratio: 0.976 },
        ratio: 1.015,
      }],
    },
  }

  const regenerated = JSON.stringify({
    performance: { comparisons: [{ corpus_scope: 'src-only', ratio: 1.015 }] },
  }, null, 2)

  it('carries the prior estimate onto the regenerated comparison', () => {
    const path = previousReceipt(migrated)
    const merged = JSON.parse(carryForwardSupersededEstimates(regenerated, path)) as typeof migrated
    expect(merged.performance.comparisons[0]?.superseded_estimate)
      .toEqual({ reason: 'PERF-PAIR-01', ratio: 0.976 })
  })

  it('does not disturb the freshly measured figures', () => {
    const path = previousReceipt(migrated)
    const merged = JSON.parse(carryForwardSupersededEstimates(regenerated, path)) as typeof migrated
    // The history is additive: the new measurement is what it measured.
    expect(merged.performance.comparisons[0]?.ratio).toBe(1.015)
  })

  it('matches by corpus scope rather than by position', () => {
    const path = previousReceipt(migrated)
    const other = JSON.stringify({
      performance: { comparisons: [{ corpus_scope: 'src-plus-tests-js-ts', ratio: 1.1 }] },
    })
    const merged = JSON.parse(carryForwardSupersededEstimates(other, path)) as typeof migrated
    // A scope the previous file did not carry gets nothing invented for it.
    expect(merged.performance.comparisons[0]?.superseded_estimate).toBeUndefined()
  })

  it('leaves output unchanged when there is no previous receipt', () => {
    expect(carryForwardSupersededEstimates(regenerated, join(tmpdir(), 'madar-no-such-receipt.json')))
      .toBe(regenerated)
  })

  it('does not fail a fresh measurement over an unreadable previous receipt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'madar-receipt-bad-'))
    scratch.push(dir)
    const path = join(dir, 'receipt.json')
    writeFileSync(path, '{ not valid json')
    expect(carryForwardSupersededEstimates(regenerated, path)).toBe(regenerated)
  })
})
