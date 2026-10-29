import { describe, expect, it } from 'vitest'

import type {
  CompiledContextPack,
  ContextPackNode,
  ContextPackRelationship,
} from '../../src/contracts/context-pack.js'
import {
  collectPackNodeIds,
  collectDeliveredContextReceipts,
  computeDeltaContextPack,
  nodeContentReceipt,
  relationshipContentReceipt,
} from '../../src/runtime/context-pack-delta.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { compactDuplicateSourcePositions } from '../../src/runtime/source-evidence-wire.js'

function node(id: string, label: string): ContextPackNode {
  return {
    node_id: id,
    label,
    source_file: `src/${label}.ts`,
    line_number: 1,
    snippet: null,
    file_type: 'code',
  }
}

function relationship(
  fromId: string,
  toId: string,
  fromLabel: string,
  toLabel: string,
  relation = 'calls',
): ContextPackRelationship {
  return { from_id: fromId, to_id: toId, from: fromLabel, to: toLabel, relation }
}

function pack(nodes: ContextPackNode[], rels: ContextPackRelationship[] = []): CompiledContextPack {
  return {
    task_contract: {
      version: 1,
      task_kind: 'explain',
      evidence_recipe_id: 'explain',
      budget: 1000,
      required_evidence: [],
      preferred_evidence: [],
      semantic_required: [],
      semantic_optional: [],
    },
    token_count: 100,
    nodes,
    relationships: rels,
    community_context: [],
    claims: [],
    expandable: [],
    coverage: {
      required_evidence: [],
      semantic_required: [],
      semantic_optional: [],
      entries: [],
      semantic_entries: [],
      missing_required: [],
      missing_semantic: [],
      available_relationships: rels.length,
      selected_relationships: rels.length,
    },
  }
}

describe('computeDeltaContextPack (#81)', () => {
  it('returns the input pack unchanged when there are no previously-sent ids', () => {
    const original = pack([node('a', 'A'), node('b', 'B')])
    const result = computeDeltaContextPack(original, [])
    expect(result.delta_applied).toBe(false)
    expect(result.delta_pack).toBe(original)
    expect(result.referenced_ids).toEqual([])
    expect(result.bytes_saved).toBe(0)
  })

  it('drops nodes whose node_id is in the previously-sent set and surfaces them as references', () => {
    const original = pack([node('a', 'A'), node('b', 'B'), node('c', 'C')])
    const result = computeDeltaContextPack(original, [nodeContentReceipt(original.nodes[0]!), nodeContentReceipt(original.nodes[2]!)])
    expect(result.delta_applied).toBe(true)
    expect(result.delta_pack.nodes.map((n) => n.node_id)).toEqual(['b'])
    expect(result.referenced_ids.sort()).toEqual(['a', 'c'])
    expect(result.bytes_saved).toBeGreaterThan(0)
  })

  it('drops relationships only when BOTH endpoints are referenced (mixed edges are kept)', () => {
    const original = pack(
      [node('a', 'A'), node('b', 'B'), node('c', 'C'), node('d', 'D')],
      [
        relationship('a', 'b', 'A', 'B'), // both new (a, b not referenced) — keep
        relationship('a', 'c', 'A', 'C'), // mixed (a new, c referenced) — keep (novel link)
        relationship('b', 'c', 'B', 'C'), // mixed (b new, c referenced) — keep (novel link)
        relationship('c', 'd', 'C', 'D'), // both referenced — DROP (receiver already has it)
      ],
    )
    const result = computeDeltaContextPack(original, [nodeContentReceipt(original.nodes[2]!), nodeContentReceipt(original.nodes[3]!), relationshipContentReceipt(original.relationships[3]!)])
    expect(result.delta_pack.relationships).toHaveLength(3)
    const keptKinds = result.delta_pack.relationships.map((r) => `${r.from_id}->${r.to_id}`)
    expect(keptKinds).toEqual(['a->b', 'a->c', 'b->c'])
  })

  it('passes through nodes that have no node_id (cannot be deduplicated by handle)', () => {
    const noIdNode: ContextPackNode = {
      label: 'NoId',
      source_file: 'src/x.ts',
      line_number: 1,
      snippet: null,
    }
    const result = computeDeltaContextPack(pack([noIdNode, node('a', 'A')]), [nodeContentReceipt(node('a', 'A'))])
    expect(result.delta_pack.nodes.map((n) => n.label)).toEqual(['NoId'])
  })

  it('reports zero bytes_saved when there is no overlap', () => {
    const original = pack([node('a', 'A'), node('b', 'B')])
    const result = computeDeltaContextPack(original, ['x', 'y'])
    expect(result.delta_applied).toBe(false)
    expect(result.bytes_saved).toBe(0)
  })
})

describe('collectPackNodeIds (#81)', () => {
  it('returns every node_id present on the pack nodes', () => {
    const ids = collectPackNodeIds(pack([node('a', 'A'), node('b', 'B')]))
    expect(ids.sort()).toEqual(['a', 'b'])
  })

  it('skips nodes without a node_id', () => {
    const noIdNode: ContextPackNode = {
      label: 'NoId',
      source_file: 'src/x.ts',
      line_number: 1,
      snippet: null,
    }
    const ids = collectPackNodeIds(pack([noIdNode, node('a', 'A')]))
    expect(ids).toEqual(['a'])
  })
})


describe('delta source content identity', () => {
  it('does not treat an old bare node ID as proof of received source', () => {
    expect(computeDeltaContextPack(pack([node('a', 'A')]), ['a']).delta_pack.nodes).toHaveLength(1)
  })
  it('resends a changed excerpt for the same symbol ID', () => {
    const before = { ...node('a', 'A'), snippet: 'return true' }
    const after = { ...before, snippet: 'return false' }
    expect(computeDeltaContextPack(pack([after]), [nodeContentReceipt(before)]).delta_pack.nodes).toEqual([after])
  })
  it('resends new relationships between previously received nodes', () => {
    const a = node('a', 'A'), b = node('b', 'B')
    const rel = relationship('a', 'b', 'A', 'B', 'calls')
    const output = computeDeltaContextPack(pack([a, b], [rel]), [nodeContentReceipt(a), nodeContentReceipt(b)])
    expect(output.delta_pack.nodes).toEqual([])
    expect(output.delta_pack.relationships).toEqual([rel])
    expect(output.delta_pack.token_count).toBe(0)
  })
})

describe('delta receipts for contained source references', () => {
  it('recognizes unchanged source after the wire omits its redundant declaration position', () => {
    const source = { ...node('method', 'method'), line_number: 4, snippet: 'return true',
      snippet_line_range: { start_line: 4, end_line: 4 }, snippet_scope: 'symbol' as const }
    const payload = { response_format: 'source_evidence_v2', pack: { matched_nodes: [source], relationships: [] },
      serialized_budget: { max_tokens: 1000, token_count: 0, enforced: true } }
    for (let pass = 0; pass < 12; pass++) {
      const count = estimateQueryTokens(JSON.stringify(payload))
      if (payload.serialized_budget.token_count === count) break
      payload.serialized_budget.token_count = count
    }
    const response = compactDuplicateSourcePositions({ result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }, 'context_pack', {})
    const wire = JSON.parse(response.result.content[0]!.text)
    expect(wire.pack.matched_nodes[0]).not.toHaveProperty('line_number')
    const delivered = collectDeliveredContextReceipts(wire)
    const result = computeDeltaContextPack(pack([source]), delivered)
    expect(result.delta_pack.nodes).toEqual([])
    expect(result.referenced_ids).toEqual(['method'])
    for (const changed of [{ ...source, line_number: 3 }, { ...source, snippet: 'return false' },
      { ...source, snippet_line_range: { start_line: 5, end_line: 5 } },
      { ...source, snippet_omitted_ranges: [{ start_line: 4, end_line: 4 }] }]) {
      expect(computeDeltaContextPack(pack([changed]), delivered).delta_pack.nodes).toEqual([changed])
    }
  })

  it('normalizes the excerpt start supplied by its source range', async () => {
    const { collectDeliveredContextReceipts } = await import('../../src/runtime/context-pack-delta.js')
    const source = { ...node('method', 'method'), snippet: 'return true', snippet_line_number: 4,
      snippet_line_range: { start_line: 4, end_line: 4 } }
    const delivered = collectDeliveredContextReceipts({ pack: { matched_nodes: [{ ...source, snippet_line_number: undefined }], relationships: [] } })
    expect(computeDeltaContextPack(pack([source]), delivered).delta_pack.nodes).toEqual([])
    expect(computeDeltaContextPack(pack([{ ...source, snippet_line_range: { start_line: 5, end_line: 5 } }]), delivered).delta_pack.nodes).toHaveLength(1)
  })

  it('hashes the exact child body and resends changed content under the same node ID', async () => {
    const { collectDeliveredContextReceipts } = await import('../../src/runtime/context-pack-delta.js')
    const child = { ...node('method', 'method'), source_file: 'src/reset.ts', line_number: 2, snippet: 'return true',
      snippet_line_range: { start_line: 2, end_line: 2 } }
    const owner = { ...node('file', 'file'), source_file: 'src/reset.ts', snippet: 'function f() {\nreturn true\n}',
      snippet_line_range: { start_line: 1, end_line: 3 } }
    const delivered = collectDeliveredContextReceipts({ pack: { matched_nodes: [
      { ...child, snippet: undefined, snippet_ref: 'file' }, owner,
    ], relationships: [] } })
    expect(delivered).toContain(nodeContentReceipt(child))
    expect(computeDeltaContextPack(pack([child]), delivered).delta_pack.nodes).toEqual([])
    const changed = { ...child, snippet: 'return false' }
    expect(computeDeltaContextPack(pack([changed]), delivered).delta_pack.nodes).toEqual([changed])
  })
})
