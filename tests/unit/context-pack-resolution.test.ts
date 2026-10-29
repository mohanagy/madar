// Multi-resolution context tests (#76 — v0.16).

import { describe, expect, it } from 'vitest'

import type {
  ContextPackNode,
  ContextPackRelationship,
} from '../../src/contracts/context-pack.js'
import {
  applyContextPackResolution,
  type ContextPackResolution,
} from '../../src/runtime/context-pack-resolution.js'
import { finalizeSourceEvidenceResponse, renderSourceEvidenceText } from '../../src/runtime/source-evidence-response.js'
import { nodeContentReceipt } from '../../src/runtime/context-pack-delta.js'

type TaskAwareResolutionOptions = Parameters<typeof applyContextPackResolution>[1]

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

function makeRelationship(from: string, to: string, relation: string): ContextPackRelationship {
  return { from_id: from, from, to_id: to, to, relation }
}

describe('applyContextPackResolution (#76)', () => {
  it('keeps derived representations distinct from exact source at the wire boundary', () => {
    const source = { ...makeNode({ snippet: 'export function fn() {\n  return save()\n}',
      snippet_line_number: 1, snippet_line_range: { start_line: 1, end_line: 3 },
      snippet_scope: 'symbol', evidence_class: 'change' }), snippet_file_complete: true }
    const wire = (node: ContextPackNode) => {
      const output = finalizeSourceEvidenceResponse({ task: 'explain', pack: { matched_nodes: [node] } }, 3000)
      return (output.pack as { matched_nodes: Array<Record<string, unknown>> }).matched_nodes[0]!
    }
    const cases: Array<[TaskAwareResolutionOptions, string]> = [
      [{ resolution: 'signature' }, 'signature'],
      [{ resolution: 'summary' }, 'summary'],
      [{ resolution: 'mixed', detail_top_n: 0 }, 'summary'],
      [{ resolution: 'sketch', task_kind: 'review' }, 'signature'],
      [{ resolution: 'sketch', relationships: [makeRelationship('a', 'save', 'calls')] }, 'dependency_record'],
    ]
    for (const [options, expectedType] of cases) {
      const node = applyContextPackResolution([{ ...source, evidence_class: 'supporting' as const }], options).nodes[0]!
      const delivered = wire(node)
      expect(delivered).toMatchObject({ representation_type: expectedType, snippet_source: 'derived',
        source_file: source.source_file, line_number: source.line_number })
      expect(renderSourceEvidenceText({ pack: { matched_nodes: [delivered] } })).toContain(`Derived representation: ${expectedType}`)
      for (const field of ['snippet_line_number', 'snippet_line_range', 'snippet_scope', 'snippet_file_complete', 'snippet_ref']) {
        expect(delivered).not.toHaveProperty(field)
      }
    }
    for (const options of [{ resolution: 'detail' }, { resolution: 'sketch', task_kind: 'review' }] as const) {
      const delivered = wire(applyContextPackResolution([source], options).nodes[0]!)
      expect(delivered).toMatchObject({ snippet: source.snippet, snippet_line_range: source.snippet_line_range,
        snippet_scope: 'symbol', snippet_file_complete: true })
      expect(delivered).not.toHaveProperty('snippet_source')
    }
    const singleLine = makeNode()
    const signature = applyContextPackResolution([singleLine], { resolution: 'signature' }).nodes[0]!
    expect(signature.snippet).toBe(singleLine.snippet)
    expect(nodeContentReceipt(signature)).not.toBe(nodeContentReceipt(singleLine))
    expect(source.snippet_line_range).toEqual({ start_line: 1, end_line: 3 })
  })

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

  it('keeps selected node ids stable while task-aware sketch rendering changes representations', () => {
    const nodes = [
      makeNode({
        node_id: 'entrypoint',
        label: 'AuthController.callback',
        source_file: '/repo/src/auth/controller.ts',
        snippet: 'export async function callback() { return authService.login() }',
        evidence_class: 'structural',
      }),
      makeNode({
        node_id: 'contract',
        label: 'LoginInput',
        source_file: '/repo/src/auth/contracts.ts',
        snippet: 'export interface LoginInput {\n  userId: string\n}',
        node_kind: 'interface',
        evidence_class: 'supporting',
      }),
      makeNode({
        node_id: 'impl',
        label: 'TokenService.sign',
        source_file: '/repo/src/auth/token.ts',
        snippet: 'export function sign() {\n  return cookieService.set("token")\n}',
        evidence_class: 'change',
      }),
      makeNode({
        node_id: 'cookie',
        label: 'CookieService.set',
        source_file: '/repo/src/http/cookies.ts',
        snippet: 'export function set() {}',
        evidence_class: 'supporting',
      }),
    ]
    const relationships = [
      makeRelationship('entrypoint', 'impl', 'calls'),
      makeRelationship('impl', 'cookie', 'calls'),
    ]

    const explain = applyContextPackResolution(
      nodes,
      {
        resolution: 'sketch',
        relationships,
        task_kind: 'explain',
      } as TaskAwareResolutionOptions,
    )
    const review = applyContextPackResolution(
      nodes,
      {
        resolution: 'sketch',
        relationships,
        task_kind: 'review',
      } as TaskAwareResolutionOptions,
    )
    const impact = applyContextPackResolution(
      nodes,
      {
        resolution: 'sketch',
        relationships,
        task_kind: 'impact',
      } as TaskAwareResolutionOptions,
    )

    expect(explain.nodes.map((node) => node.node_id)).toEqual(nodes.map((node) => node.node_id))
    expect(review.nodes.map((node) => node.node_id)).toEqual(nodes.map((node) => node.node_id))
    expect(impact.nodes.map((node) => node.node_id)).toEqual(nodes.map((node) => node.node_id))
    expect(explain.nodes.find((node) => node.node_id === 'entrypoint')?.representation_type).toBe('call_chain')
    expect(review.nodes.find((node) => node.node_id === 'contract')?.representation_type).toBe('contract_view')
    expect(impact.nodes.find((node) => node.node_id === 'impl')?.representation_type).toBe('dependency_record')
  })
})
