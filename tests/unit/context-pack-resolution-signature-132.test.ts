// v0.20 #132 — signature resolution level for applyContextPackResolution.

import { describe, expect, it } from 'vitest'

import type { ContextPackNode } from '../../src/contracts/context-pack.js'
import { applyContextPackResolution } from '../../src/runtime/context-pack-resolution.js'

function makeNode(snippet: string): ContextPackNode {
  return {
    node_id: 'n1',
    label: 'fn()',
    source_file: '/src/fn.ts',
    line_number: 1,
    snippet,
    match_score: 0.5,
  }
}

describe('applyContextPackResolution signature mode (#132)', () => {
  it('keeps lines up through the opening brace, drops the body', () => {
    const snippet = [
      'export function transform(input: string): string {',
      '  if (!input) return ""',
      '  return input.toUpperCase()',
      '}',
    ].join('\n')
    const result = applyContextPackResolution([makeNode(snippet)], { resolution: 'signature' })
    expect(result.nodes[0]?.snippet).toBe('export function transform(input: string): string {')
    expect(result.bytes_saved).toBeGreaterThan(0)
  })

  it('keeps lines up through an arrow function fat arrow', () => {
    const snippet = [
      'export const fetchUser = async (id: string) =>',
      '  prisma.user.findUnique({ where: { id } })',
    ].join('\n')
    const result = applyContextPackResolution([makeNode(snippet)], { resolution: 'signature' })
    expect(result.nodes[0]?.snippet).toBe('export const fetchUser = async (id: string) =>')
  })

  it('falls back to first 2 lines when no { or => is found in first 3 lines', () => {
    const snippet = [
      'export class FooBar',
      '  extends BaseClass',
      '  implements IFoo',
      '{',
      '  // body',
      '}',
    ].join('\n')
    const result = applyContextPackResolution([makeNode(snippet)], { resolution: 'signature' })
    // First 3 lines don't end in { or =>, so the fallback takes the first 2.
    expect(result.nodes[0]?.snippet).toBe('export class FooBar\n  extends BaseClass')
  })

  it('leaves nodes with null snippets unchanged and reports zero bytes saved for those', () => {
    const result = applyContextPackResolution(
      [{ ...makeNode(''), snippet: null }],
      { resolution: 'signature' },
    )
    expect(result.nodes[0]?.snippet).toBe(null)
    expect(result.bytes_saved).toBe(0)
  })

  it('saves bytes proportionally — bigger body = more savings', () => {
    const small = makeNode('export function tiny() {\n  return 1\n}')
    const big = makeNode([
      'export function processAndValidate(input: Input): Output {',
      ...Array(50).fill('  // body line').map((s, i) => `${s} ${i}`),
      '  return result',
      '}',
    ].join('\n'))
    const r1 = applyContextPackResolution([small], { resolution: 'signature' })
    const r2 = applyContextPackResolution([big], { resolution: 'signature' })
    expect(r2.bytes_saved).toBeGreaterThan(r1.bytes_saved)
  })
})
