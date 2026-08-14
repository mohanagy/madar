import { describe, expect, it } from 'vitest'

import {
  canonicalJsonBytes,
  orderedCanonicalArray,
  serializeCanonicalJson,
  setLikeCanonicalArray,
} from '../../src/contracts/canonical-json.js'

describe('canonical JSON serialization', () => {
  it('orders normalized object keys lexically by Unicode code point', () => {
    expect(serializeCanonicalJson({ '\u{10000}': 1, '\uE000': 2, b: 3, a: 4 })).toBe(
      '{"a":4,"b":3,"\uE000":2,"\u{10000}":1}',
    )
  })

  it('normalizes object keys and string values to NFC', () => {
    expect(serializeCanonicalJson({ 'caf\u0065\u0301': 're\u0301sume\u0301' })).toBe(
      '{"caf\u00E9":"r\u00E9sum\u00E9"}',
    )
    expect(() => serializeCanonicalJson({ '\u00E9': 1, 'e\u0301': 2 })).toThrow(
      'object keys collide after NFC normalization',
    )
  })

  it('rejects non-finite numbers and normalizes negative zero', () => {
    expect(() => serializeCanonicalJson(Number.NaN)).toThrow('numbers must be finite')
    expect(() => serializeCanonicalJson(Number.POSITIVE_INFINITY)).toThrow('numbers must be finite')
    expect(() => serializeCanonicalJson(Number.NEGATIVE_INFINITY)).toThrow('numbers must be finite')
    expect(serializeCanonicalJson(-0)).toBe('0')
  })

  it('rejects undefined instead of silently omitting it', () => {
    expect(() => serializeCanonicalJson({ absent: undefined })).toThrow('does not permit undefined')
  })

  it('preserves order and duplicates for explicitly ordered arrays', () => {
    expect(serializeCanonicalJson(orderedCanonicalArray(['second', 'first', 'first']))).toBe(
      '["second","first","first"]',
    )
  })

  it('recursively normalizes, deduplicates, and byte-sorts set-like arrays', () => {
    expect(serializeCanonicalJson(setLikeCanonicalArray(['e\u0301', '\u00E9', 'z']))).toBe(
      '["z","\u00E9"]',
    )
    expect(serializeCanonicalJson(setLikeCanonicalArray([
      { b: 2, a: 1 },
      { a: 1, b: 2 },
    ]))).toBe('[{"a":1,"b":2}]')
  })

  it('requires callers to declare plain-array semantics explicitly', () => {
    expect(() => serializeCanonicalJson(['a', 'b'])).toThrow(
      'arrays require explicit ordered or set-like semantics',
    )
    expect(serializeCanonicalJson(['b', 'a'], { arraySemantics: 'ordered' })).toBe('["b","a"]')
    expect(serializeCanonicalJson(['b', 'a', 'a'], { arraySemantics: 'set-like' })).toBe('["a","b"]')
  })

  it('emits deterministic UTF-8 bytes', () => {
    expect(canonicalJsonBytes({ text: 'e\u0301' })).toEqual(Buffer.from('{"text":"\u00E9"}', 'utf8'))
  })
})
