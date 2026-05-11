// Value-per-token budget selector tests (#74).

import { describe, expect, it } from 'vitest'

import {
  selectByValuePerToken,
  type ValuePerTokenCandidate,
} from '../../src/runtime/value-per-token.js'

function c(id: string, score: number, token_cost: number): ValuePerTokenCandidate<string> {
  return { id, score, token_cost, payload: id }
}

describe('selectByValuePerToken', () => {
  it('selects all candidates when the total cost is under budget', () => {
    const result = selectByValuePerToken(
      [c('a', 10, 100), c('b', 8, 100), c('c', 6, 100)],
      { budget: 500 },
    )
    expect(result.selected.map((s) => s.id).sort()).toEqual(['a', 'b', 'c'])
    expect(result.total_cost).toBe(300)
    expect(result.remaining_budget).toBe(200)
  })

  it('prefers higher density over higher absolute score', () => {
    // Candidate a: score 10 / cost 100 = density 0.1
    // Candidate b: score 8  / cost 40  = density 0.2
    // With budget 50, only b fits and density wins.
    const result = selectByValuePerToken(
      [c('a', 10, 100), c('b', 8, 40)],
      { budget: 50 },
    )
    expect(result.selected.map((s) => s.id)).toEqual(['b'])
  })

  it('pins zero-cost candidates by default', () => {
    const result = selectByValuePerToken(
      [c('a', 5, 0), c('b', 100, 50)],
      { budget: 40 },  // can't afford b
    )
    expect(result.selected.map((s) => s.id)).toEqual(['a'])
    expect(result.total_cost).toBe(0)
  })

  it('skips zero-cost candidates when pinZeroCost is false', () => {
    const result = selectByValuePerToken(
      [c('a', 5, 0), c('b', 100, 50)],
      { budget: 40, pinZeroCost: false },
    )
    expect(result.selected.map((s) => s.id)).toEqual([])
  })

  it('respects the budget when greedy adds items', () => {
    const result = selectByValuePerToken(
      [c('a', 10, 60), c('b', 5, 50), c('c', 7, 30)],
      { budget: 100 },
    )
    // Densities: a=0.166, b=0.10, c=0.233. Sorted: c, a, b.
    // Pick c (30), pick a (90), skip b (would be 140 > 100).
    expect(result.selected.map((s) => s.id)).toEqual(['c', 'a'])
    expect(result.total_cost).toBe(90)
  })

  it('skips items with cost > budget even when greedy passes', () => {
    // a has high density but it alone exceeds budget — must be skipped.
    const result = selectByValuePerToken([c('a', 100, 1000)], { budget: 100 })
    expect(result.selected).toEqual([])
    expect(result.total_cost).toBe(0)
  })

  it('filters out non-finite scores and costs', () => {
    const result = selectByValuePerToken(
      [
        c('a', Number.NaN, 50),
        c('b', 5, Number.POSITIVE_INFINITY),
        c('c', 3, 10),
      ],
      { budget: 100 },
    )
    expect(result.selected.map((s) => s.id)).toEqual(['c'])
  })

  it('returns ranking with rank + density + included flags', () => {
    const result = selectByValuePerToken(
      [c('a', 10, 50), c('b', 5, 50)],
      { budget: 60 },
    )
    // a fits first (density 0.2), b skipped (would push to 100 > 60).
    expect(result.ranking).toEqual([
      { id: 'a', score: 10, token_cost: 50, density: 0.2, rank: 1, included: true },
      { id: 'b', score: 5, token_cost: 50, density: 0.1, rank: 2, included: false },
    ])
  })

  it('is deterministic on ties — score desc, cost asc, id asc', () => {
    // Two items with identical density and identical score — id breaks tie.
    const result = selectByValuePerToken(
      [c('z', 5, 50), c('a', 5, 50)],
      { budget: 50 },
    )
    // Only one fits at cost 50; tie broken by id asc → 'a' wins.
    expect(result.selected.map((s) => s.id)).toEqual(['a'])
  })

  it('clamps negative budget to 0', () => {
    const result = selectByValuePerToken([c('a', 10, 50)], { budget: -100 })
    expect(result.selected).toEqual([])
    expect(result.remaining_budget).toBe(0)
  })

  it('handles empty input', () => {
    const result = selectByValuePerToken<string>([], { budget: 100 })
    expect(result.selected).toEqual([])
    expect(result.ranking).toEqual([])
    expect(result.total_cost).toBe(0)
    expect(result.remaining_budget).toBe(100)
  })
})
