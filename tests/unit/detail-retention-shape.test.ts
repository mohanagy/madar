import { describe, expect, it } from 'vitest'

import {
  assertDetailRetention,
  detailRetention,
  GraphIntegrityInvariantError,
} from '../../src/contracts/graph-integrity.js'

/** Every rejection must be the typed graph invariant, never a raw TypeError. */
function expectTyped(run: () => unknown): void {
  let thrown: unknown
  try {
    run()
  } catch (error) {
    thrown = error
  }
  expect(thrown, 'expected a rejection').toBeDefined()
  expect(thrown).toBeInstanceOf(GraphIntegrityInvariantError)
  expect(thrown).not.toBeInstanceOf(TypeError)
}

describe('V2 — DetailRetention is an exact closed contract', () => {
  it('accepts exactly the four declared fields', () => {
    expect(() => assertDetailRetention(detailRetention(4, 10), 'r')).not.toThrow()
  })

  it('rejects a fifth field carrying a private path', () => {
    // The exact reviewer case: the four known fields were valid, so the extra
    // one rode along unvalidated into whatever consumed the object.
    expectTyped(() => assertDetailRetention({
      retained: 4, total: 10, omitted: 6, truncated: true,
      note: '/Users/reviewer/secret.ts',
    } as never, 'r'))
  })

  it('rejects any unknown field, harmless-looking or not', () => {
    expectTyped(() => assertDetailRetention({
      retained: 0, total: 0, omitted: 0, truncated: false, extra: 1,
    } as never, 'r'))
  })

  it('never silently copies four fields out of a five-field input', () => {
    const five = { retained: 4, total: 10, omitted: 6, truncated: true, leaked: 'x' }
    expectTyped(() => assertDetailRetention(five as never, 'r'))
    // The input is refused, not repaired: nothing reads it and moves on.
    expect(five.leaked).toBe('x')
  })

  it('rejects a symbol key', () => {
    const retention = { retained: 0, total: 0, omitted: 0, truncated: false }
    Object.defineProperty(retention, Symbol('hidden'), { value: 1, enumerable: true })
    expectTyped(() => assertDetailRetention(retention as never, 'r'))
  })

  it('rejects an accessor property', () => {
    // A getter can return one value to the validator and another to the
    // serializer, so the shape is refused rather than sampled.
    const retention = { retained: 0, total: 0, omitted: 0 }
    Object.defineProperty(retention, 'truncated', { get: () => false, enumerable: true })
    expectTyped(() => assertDetailRetention(retention as never, 'r'))
  })

  it('rejects a custom prototype', () => {
    class Retention {
      retained = 0
      total = 0
      omitted = 0
      truncated = false
    }
    expectTyped(() => assertDetailRetention(new Retention() as never, 'r'))
  })

  it.each([
    ['a missing field', { retained: 0, total: 0, omitted: 0 }],
    ['null', null],
    ['undefined', undefined],
    ['an array', []],
    ['a string', 'retention'],
    ['a negative number', { retained: -1, total: 0, omitted: 1, truncated: true }],
    ['a fractional number', { retained: 1.5, total: 10, omitted: 8.5, truncated: true }],
    ['an unsafe integer', { retained: 0, total: Number.MAX_SAFE_INTEGER + 10, omitted: 0, truncated: false }],
    ['NaN', { retained: Number.NaN, total: 0, omitted: 0, truncated: false }],
    ['Infinity', { retained: Number.POSITIVE_INFINITY, total: 0, omitted: 0, truncated: false }],
    ['an omitted mismatch', { retained: 4, total: 10, omitted: 3, truncated: true }],
    ['a truncated mismatch', { retained: 4, total: 10, omitted: 6, truncated: false }],
    ['a non-boolean truncated', { retained: 0, total: 0, omitted: 0, truncated: 'no' }],
  ])('rejects %s', (_label, retention) => {
    expectTyped(() => assertDetailRetention(retention as never, 'r'))
  })
})
