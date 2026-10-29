import { describe, expect, it } from 'vitest'

import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { compactContainedSourceReferences, compactRepeatedSourceMetadata, expandSourceDependencyCalls, MIN_SOURCE_EVIDENCE_BUDGET,
  resolveSourceSnippet, SOURCE_EVIDENCE_RESPONSE_FORMAT } from '../../src/runtime/source-evidence-response.js'

type Value = Record<string, unknown>
const object = (value: unknown): Value => value as Value
function withReceipt(payload: Value, budget: number): Value {
  payload.serialized_budget = { max_tokens: budget, token_count: 0, enforced: true }
  for (let i = 0; i < 12; i++) {
    const count = estimateQueryTokens(JSON.stringify(payload))
    if (object(payload.serialized_budget).token_count === count) return payload
    object(payload.serialized_budget).token_count = count
  }
  throw new Error('Metadata fixture token receipt did not stabilize')
}

describe('lossless source evidence metadata compaction', () => {
  it('shares only a complete visible child of a partial supplier without changing owner evidence', () => {
    const childLines = [
      '  summarize(value: string) {',
      '    const normalized = value.trim();',
      '    const label = "shipment handling and dispatch record";',
      '    const first = `${label}:${normalized}`;',
      '    const second = first.toUpperCase();',
      '    const third = second.replaceAll(" ", "-");',
      '    const fourth = third.slice(0, 96);',
      '    if (fourth.length === 0) return "empty shipment record";',
      '    return fourth;',
      '  }',
    ]
    const child = childLines.join('\n')
    const input = withReceipt({ task: 'explain', response_format: SOURCE_EVIDENCE_RESPONSE_FORMAT,
      pack: { selection_scope: 'task_context', matched_nodes: [
        { node_id: 'class', label: 'Shipment', source_file: 'src/shipment.ts', snippet_scope: 'symbol',
          snippet_line_range: { start_line: 1, end_line: 30 },
          snippet_omitted_ranges: [{ start_line: 2, end_line: 9 }, { start_line: 20, end_line: 29 }],
          snippet: `export class Shipment {\n[omitted lines 2-9]\n${child}\n[omitted lines 20-29]\n}`,
          source_expand_handle: 'source-expand:unchanged-class', future_owner: { retained: true } },
        { node_id: 'method', label: '.summarize()', source_file: 'src/shipment.ts', snippet_scope: 'symbol',
          snippet_line_range: { start_line: 10, end_line: 19 }, snippet: child, future_child: ['preserve'] },
      ], relationships: [{ from_id: 'class', to_id: 'method', relation: 'method' }] },
      expandable: [{ handle_id: 'expand:unchanged-scope', count: 2 }],
      evidence: { answerability: { state: 'insufficient', answer_scope: 'partial', advisory: true } },
      future_response: { retained: true },
    }, 3000)
    const before = JSON.stringify(input), original = object(input.pack).matched_nodes as Value[]
    const output = compactContainedSourceReferences(input, 3000)
    const nodes = object(output.pack).matched_nodes as Value[]
    expect(nodes[1]!.snippet_ref).toBe('class')
    expect(nodes.map(node => resolveSourceSnippet(node, nodes))).toEqual(original.map(node => resolveSourceSnippet(node, original)))
    const restored = structuredClone(output), restoredNodes = object(restored.pack).matched_nodes as Value[]
    restoredNodes[1]!.snippet = child
    delete restoredNodes[1]!.snippet_ref
    restored.serialized_budget = input.serialized_budget
    expect(restored).toEqual(input) // Includes all unknown metadata, omission maps, handles and relationships.
    expect(object(output.serialized_budget).token_count).toBe(estimateQueryTokens(JSON.stringify(output)))
    expect(estimateQueryTokens(JSON.stringify(output))).toBeLessThan(estimateQueryTokens(before))
    expect(compactContainedSourceReferences(output, 3000)).toEqual(output)
    expect(JSON.stringify(input)).toBe(before)

    const negatives = ['marker', 'gap', 'unknown truncation', 'derived', 'different file'].map(kind => {
      const changed = structuredClone(input), entries = object(changed.pack).matched_nodes as Value[]
      const supplier = entries[0]!
      if (kind === 'marker') supplier.snippet = String(supplier.snippet).replace('[omitted lines 2-9]', '[omitted lines 2-8]')
      if (kind === 'gap') {
        supplier.snippet = String(supplier.snippet).replace(childLines[5]!, '[omitted lines 15-15]')
        supplier.snippet_omitted_ranges = [{ start_line: 2, end_line: 9 }, { start_line: 15, end_line: 15 }, { start_line: 20, end_line: 29 }]
      }
      if (kind === 'unknown truncation') { delete supplier.snippet_omitted_ranges; supplier.snippet_truncated = true }
      if (kind === 'derived') supplier.snippet_source = 'derived'
      if (kind === 'different file') entries[1]!.source_file = 'src/other.ts'
      withReceipt(changed, 3000)
      const reference: Value = { ...entries[1]!, snippet_ref: 'class' }
      delete reference.snippet
      return { unchanged: compactContainedSourceReferences(changed, 3000) === changed,
        projected: resolveSourceSnippet(reference, [supplier, reference]) }
    })
    expect(negatives).toEqual(Array.from({ length: 5 }, () => ({ unchanged: true, projected: null })))
  })

  it('round-trips ordered diagnostic duplicates and unknown fields while preserving source, handles and unequal identities', () => {
    const repeated = 'external.library.repeatedDiagnostic'
    const calls = [
      ...[7, 7, 9, 12].map(line_number => ({ callee: repeated, line_number })),
      { callee: 'anotherDiagnostic', line_number: 8 },
      ...[3, 3, 2].map(line_number => ({ callee: repeated, line_number })),
      { callee: repeated, line_number: 20, future_detail: { uncertain: true } },
    ]
    const snippet = 'export function process(value) {\n  if (!value) throw new Error("missing");\n[omitted lines 12-18]\n  return normalize(value);\n}'
    const range = { start_line: 10, end_line: 20 }, omissions = [{ start_line: 12, end_line: 18 }]
    const input = withReceipt({ task: 'explain', task_intent: 'explain', response_format: SOURCE_EVIDENCE_RESPONSE_FORMAT,
      cache: { graph_version: 'same-version', status: 'hit', future_cache_field: 'preserve' },
      governance: { graph_freshness: { status: 'fresh', selected_context_status: 'fresh', graph_version: 'same-version' } },
      evidence: { missing_phases: [], answerability: { advisory: true, missing_obligations: ['runtime:binding'],
        caveats: ['Source does not establish runtime invocation.'], broad_search_fallback: 'allowed' } },
      pack: { selection_scope: 'task_context', matched_nodes: [
        { node_id: 'owner', label: 'process()', source_file: 'src/records.ts', snippet_scope: 'symbol',
          snippet_line_range: range, snippet_omitted_ranges: omissions, snippet_truncated: true, snippet,
          source_expand_handle: 'source-expand:frozen-owner-page', future_source_field: { retained: true } },
        { node_id: 'owner-ref', label: 'process()', source_file: 'src/records.ts', snippet_scope: 'symbol',
          snippet_line_range: range, snippet_omitted_ranges: omissions, snippet_truncated: true, snippet_ref: 'owner' },
      ], relationships: [{ from_id: 'owner-ref', to_id: 'owner', relation: 'depends_on', confidence: 'partial' }],
      source_dependencies: { unresolved_calls: calls.length, bounded: true, future_receipt: [1, 2],
        unresolved_groups: [{ source_file: 'src/records.ts', reason: 'external', calls, future_group: 'preserve' }] } },
      future_response_field: { preserved: ['a', 'b'] },
    }, 5000)
    const before = JSON.stringify(input), output = compactRepeatedSourceMetadata(input, 5000)
    const groups = object(object(output.pack).source_dependencies).unresolved_groups as Value[]
    expect(expandSourceDependencyCalls(groups[0]!.calls as unknown[])).toEqual(calls)
    expect((groups[0]!.calls as Value[]).filter(call => Array.isArray(call.line_numbers))).toHaveLength(2)

    // Restore only documented duplicate fields and the reversible call codec.
    const restored = structuredClone(output)
    restored.task_intent = restored.task
    object(restored.cache).graph_version = object(object(restored.governance).graph_freshness).graph_version
    object(restored.evidence).missing_phases = []
    for (const group of object(object(restored.pack).source_dependencies).unresolved_groups as Value[]) {
      group.calls = expandSourceDependencyCalls(group.calls as unknown[])
    }
    restored.serialized_budget = input.serialized_budget
    expect(restored).toEqual(input)
    const entries = object(output.pack).matched_nodes as Value[]
    expect(entries).toEqual(object(input.pack).matched_nodes)
    expect(resolveSourceSnippet(entries[1]!, entries)).toBe(snippet)
    expect(entries[0]!.source_expand_handle).toBe('source-expand:frozen-owner-page')
    expect(estimateQueryTokens(JSON.stringify(output))).toBeLessThan(estimateQueryTokens(before))
    expect(object(output.serialized_budget).token_count).toBe(estimateQueryTokens(JSON.stringify(output)))
    expect(compactRepeatedSourceMetadata(output, 5000)).toEqual(output)

    const unequal = structuredClone(input)
    unequal.task_intent = 'impact'
    object(unequal.cache).graph_version = 'different-version'
    object(unequal.evidence).missing_phases = ['binding']
    withReceipt(unequal, 5000)
    const unequalOutput = compactRepeatedSourceMetadata(unequal, 5000)
    expect(unequalOutput.task_intent).toBe('impact')
    expect(object(unequalOutput.cache).graph_version).toBe('different-version')
    expect(object(unequalOutput.evidence).missing_phases).toEqual(['binding'])
    expect(object(unequalOutput.serialized_budget).token_count).toBe(estimateQueryTokens(JSON.stringify(unequalOutput)))
    // Compaction does not evict evidence or rewrite a receipt when savings cannot meet the supplied cap.
    expect(compactRepeatedSourceMetadata(input, MIN_SOURCE_EVIDENCE_BUDGET)).toBe(input)
    expect(expandSourceDependencyCalls([{ callee: 'x', line_numbers: [0] }])).toBeUndefined()
    expect(expandSourceDependencyCalls([{ callee: 'x', line_numbers: [1], future_detail: true }])).toBeUndefined()
    expect(JSON.stringify(input)).toBe(before)
  })
})
