// Multi-resolution context tests (#76 — v0.16).

import { describe, expect, it } from 'vitest'

import type { ContextPackNode } from '../../src/contracts/context-pack.js'
import {
  applyContextPackResolution,
  type ContextPackResolution,
} from '../../src/runtime/context-pack-resolution.js'

function makeNode(overrides: Partial<ContextPackNode> = {}): ContextPackNode {
  return {
    node_id: overrides.node_id ?? 'a',
    label: 'fn()',
    source_file: '/repo/src/fn.ts',
    line_number: 1,
    snippet: 'export function fn() { return 1 }',
    match_score: 0.8,
    ...overrides,
  }
}

describe('applyContextPackResolution (#76)', () => {
  it('detail resolution is a no-op (clones the list)', () => {
    const nodes = [makeNode({ node_id: 'a' }), makeNode({ node_id: 'b' })]
    const result = applyContextPackResolution(nodes, { resolution: 'detail' })
    expect(result.bytes_saved).toBe(0)
    expect(result.nodes.length).toBe(2)
    expect(result.nodes[0]?.snippet).toBe(nodes[0]?.snippet)
    expect(result.resolution_map.every((r) => r.resolution === 'detail')).toBe(true)
  })

  it('summary strips all snippet bodies and reports bytes saved', () => {
    const nodes = [
      makeNode({ node_id: 'a', snippet: 'a'.repeat(50) }),
      makeNode({ node_id: 'b', snippet: 'b'.repeat(30) }),
    ]
    const result = applyContextPackResolution(nodes, { resolution: 'summary' })
    expect(result.nodes.every((n) => n.snippet === null)).toBe(true)
    expect(result.bytes_saved).toBe(80)
    expect(result.resolution_map.every((r) => r.resolution === 'summary')).toBe(true)
  })

  it('mixed keeps top-N most relevant in detail, rest summary', () => {
    const nodes = [
      makeNode({ node_id: 'a', match_score: 0.9, snippet: 'a-snippet' }),
      makeNode({ node_id: 'b', match_score: 0.5, snippet: 'b-snippet' }),
      makeNode({ node_id: 'c', match_score: 0.7, snippet: 'c-snippet' }),
      makeNode({ node_id: 'd', match_score: 0.1, snippet: 'd-snippet' }),
    ]
    const result = applyContextPackResolution(nodes, { resolution: 'mixed', detail_top_n: 2 })
    // Top-2 by match_score: a (0.9), c (0.7). b and d should be summarized.
    const byId = new Map(result.nodes.map((n) => [n.node_id, n.snippet]))
    expect(byId.get('a')).toBe('a-snippet')
    expect(byId.get('c')).toBe('c-snippet')
    expect(byId.get('b')).toBe(null)
    expect(byId.get('d')).toBe(null)
  })

  it('mixed defaults detail_top_n to ceil(n/3)', () => {
    const nodes = [
      makeNode({ node_id: 'a', match_score: 0.9 }),
      makeNode({ node_id: 'b', match_score: 0.8 }),
      makeNode({ node_id: 'c', match_score: 0.7 }),
      makeNode({ node_id: 'd', match_score: 0.6 }),
      makeNode({ node_id: 'e', match_score: 0.5 }),
      makeNode({ node_id: 'f', match_score: 0.4 }),
    ]
    const result = applyContextPackResolution(nodes, { resolution: 'mixed' })
    // ceil(6/3) = 2 detail nodes.
    const detailNodes = result.resolution_map.filter((r) => r.resolution === 'detail')
    expect(detailNodes.length).toBe(2)
  })

  it('preserves order of input nodes (mixed picks top by score, output keeps input order)', () => {
    const nodes = [
      makeNode({ node_id: 'low', match_score: 0.1 }),
      makeNode({ node_id: 'high', match_score: 0.9 }),
      makeNode({ node_id: 'mid', match_score: 0.5 }),
    ]
    const result = applyContextPackResolution(nodes, { resolution: 'mixed', detail_top_n: 1 })
    expect(result.nodes.map((n) => n.node_id)).toEqual(['low', 'high', 'mid'])
  })

  it('handles empty input', () => {
    for (const resolution of ['detail', 'summary', 'mixed'] as ContextPackResolution[]) {
      const result = applyContextPackResolution<ContextPackNode>([], { resolution })
      expect(result.nodes).toEqual([])
      expect(result.bytes_saved).toBe(0)
      expect(result.resolution_map).toEqual([])
    }
  })

  it('mixed with detail_top_n=0 summarizes everything', () => {
    const nodes = [makeNode({ node_id: 'a' }), makeNode({ node_id: 'b' })]
    const result = applyContextPackResolution(nodes, { resolution: 'mixed', detail_top_n: 0 })
    expect(result.nodes.every((n) => n.snippet === null)).toBe(true)
  })

  it('mixed with detail_top_n >= node_count gives everyone detail', () => {
    const nodes = [makeNode({ node_id: 'a' }), makeNode({ node_id: 'b' })]
    const result = applyContextPackResolution(nodes, { resolution: 'mixed', detail_top_n: 10 })
    expect(result.nodes.every((n) => n.snippet !== null)).toBe(true)
  })

  it('summary works on nodes with null snippets (no error, zero bytes saved)', () => {
    const nodes = [makeNode({ node_id: 'a', snippet: null })]
    const result = applyContextPackResolution(nodes, { resolution: 'summary' })
    expect(result.bytes_saved).toBe(0)
    expect(result.nodes[0]?.snippet).toBe(null)
  })
})
