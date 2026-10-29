import { expect, it } from 'vitest'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { compactDuplicateSourcePositions } from '../../src/runtime/source-evidence-wire.js'
import { resolveSourceSnippet } from '../../src/runtime/source-evidence-response.js'

type Value = Record<string, any>
function price(payload: Value): string {
  payload.serialized_budget ??= { max_tokens: 2400, token_count: 0, enforced: true }
  for (let attempt = 0; attempt < 12; attempt++) {
    const text = JSON.stringify(payload), count = estimateQueryTokens(text)
    if (payload.serialized_budget.token_count === count) return text
    payload.serialized_budget.token_count = count
  }
  throw new Error('Fixture receipt did not stabilize')
}

it('omits duplicate source positions only at the final tool boundary', () => {
  const node = (id: string, line: unknown, range: unknown): Value => ({ node_id: id, label: `${id}()`,
    source_file: 'src/example.ts', line_number: line, snippet: 'function example() { return 1 }',
    snippet_line_range: range, snippet_scope: 'symbol' })
  const values = [
    node('complete', 4, { start_line: 4, end_line: 4 }),
    { ...node('partial', 9, { start_line: 9, end_line: 20 }), snippet: 'function partial() {\n[omitted lines 10-19]\n}',
      snippet_omitted_ranges: [{ start_line: 10, end_line: 19 }], source_expand_handle: 'source-expand:unchanged' },
    node('different', 2, { start_line: 3, end_line: 4 }),
    node('extended', 4, { start_line: 4, end_line: 4, column: 1 }),
    node('reversed', 4, { start_line: 4, end_line: 3 }),
    node('zero', 0, { start_line: 0, end_line: 4 }),
    node('fraction', 1.5, { start_line: 1.5, end_line: 4 }),
    node('string', '4', { start_line: 4, end_line: 4 }),
    node('missing-end', 4, { start_line: 4 }),
    node('missing-range', 4, undefined),
    node('missing-line', undefined, { start_line: 4, end_line: 4 }),
    node('unsafe', Number.MAX_SAFE_INTEGER + 1, { start_line: Number.MAX_SAFE_INTEGER + 1, end_line: Number.MAX_SAFE_INTEGER + 1 }),
  ]
  for (const tool of ['context_pack', 'context_expand']) for (const task of ['explain', 'implement']) {
    const payload = { response_format: 'source_evidence_v2', task, cache: { status: 'hit' },
      pack: { matched_nodes: values, relationships: [{ from_id: 'complete', to_id: 'partial', relation: 'calls' }] },
      evidence: { answerability: { state: 'insufficient', missing_obligations: ['query:second'] } },
      source_continuation: { delivered_lines: 2, remaining_lines: 10 },
      expandable: [{ handle_id: 'generic:unchanged' }], serialized_budget: { max_tokens: 2400, token_count: 0, enforced: true } }
    const text = price(payload), response = { jsonrpc: '2.0', id: 7,
      result: { content: [{ type: 'text', text, annotations: { audience: ['assistant'] } }], extension: 'retained' } }
    const before = JSON.stringify(response)
    const output = compactDuplicateSourcePositions(response, tool, {})
    expect(JSON.stringify(response)).toBe(before)
    expect(output.result.extension).toBe('retained')
    expect(output.result.content[0]!.annotations).toEqual(response.result.content[0]!.annotations)
    const compact = JSON.parse(output.result.content[0]!.text), original = JSON.parse(text)
    expect(compact.pack.matched_nodes[0]).not.toHaveProperty('line_number')
    expect(compact.pack.matched_nodes[1]).not.toHaveProperty('line_number')
    expect(compact.pack.matched_nodes.slice(2)).toEqual(original.pack.matched_nodes.slice(2))
    expect(compact.serialized_budget.token_count).toBe(estimateQueryTokens(output.result.content[0]!.text))
    expect(compact.serialized_budget.token_count).toBeLessThan(original.serialized_budget.token_count)
    // The only source changes are redundant fields with an exact inverse.
    for (const index of [0, 1]) compact.pack.matched_nodes[index].line_number = compact.pack.matched_nodes[index].snippet_line_range.start_line
    compact.serialized_budget.token_count = original.serialized_budget.token_count
    expect(compact).toEqual(original)
    expect(compactDuplicateSourcePositions(output, tool, {})).toBe(output)
    expect(compactDuplicateSourcePositions(response, tool, { verbose: true })).toBe(response)
    expect(compactDuplicateSourcePositions(response, tool, { format: 'text' })).toBe(response)
    expect(compactDuplicateSourcePositions(response, 'retrieve', {})).toBe(response)
    for (const unsupported of [
      { ...response, error: { code: -1 } },
      { ...response, result: { ...response.result, structuredContent: original } },
      { ...response, result: { ...response.result, isError: true } },
      { ...response, result: { content: [...response.result.content, { type: 'text', text: '{}' }] } },
      { ...response, result: { content: [{ type: 'text', text: 'raw source text' }] } },
      { ...response, result: { content: [{ type: 'text', text: JSON.stringify(original, null, 2) }] } },
    ]) expect(compactDuplicateSourcePositions(unsupported, tool, {})).toBe(unsupported)
    for (const receipt of [
      { ...original.serialized_budget, token_count: 1 },
      { ...original.serialized_budget, enforced: false },
      { ...original.serialized_budget, extension: 'unknown' },
      { ...original.serialized_budget, max_tokens: 127 },
    ]) {
      const bad = { ...response, result: { content: [{ type: 'text', text: JSON.stringify({ ...original, serialized_budget: receipt }) }] } }
      expect(compactDuplicateSourcePositions(bad, tool, {})).toBe(bad)
    }
  }
})

it('compacts recovery metadata without duplicate positions or changing source and recovery identity', () => {
  const root = '/workspace/isolated/source-evidence/project'
  const sourceFile = `${root}/src/dispatch.ts`
  const payload: Value = { response_format: 'source_evidence_v2',
    pack: { matched_nodes: [{ node_id: `node:${sourceFile}:dispatch`, label: 'dispatch()', source_file: sourceFile,
      snippet: `function dispatch() {\n  return '${sourceFile}'\n[omitted lines 6-8]\n}`,
      snippet_line_range: { start_line: 4, end_line: 9 }, snippet_omitted_ranges: [{ start_line: 6, end_line: 8 }],
      snippet_scope: 'symbol', snippet_ref: { node_id: 'prior:owner', start_line: 4, end_line: 5 },
      source_expand_handle: 'source-expand:fixed' }],
      relationships: [{ from_id: `node:${sourceFile}:dispatch`, to_id: 'helper', relation: 'depends_on' }],
      source_dependencies: { unresolved: [{ source_file: sourceFile, reason: `Unresolved call in ${sourceFile}` }],
        unresolved_groups: [{ source_file: sourceFile, count: 2, reason: 'dynamic' }], bounded: true } },
    expandable: [{ handle_id: 'context-expand:fixed', evidence_class: 'supporting', omitted_nodes: 3,
      focus_files: [sourceFile], focus_ranges: [{ source_file: sourceFile, start_line: 6, end_line: 8 }],
      symbols: ['dispatch'] }],
    evidence: { answerability: { state: 'insufficient', missing_obligations: ['query:second'] },
      verification_targets: [{ handle_id: 'context-expand:fixed', reason: 'Remaining source is unverified' }] },
    source_continuation: { delivered_lines: 3, remaining_lines: 3 },
    source_recovery: { withheld_lines: 2, reason: 'owned_by_original_context_pack_or_group' },
    governance: { graph_freshness: { status: 'fresh', graph_version: 'version:fixed', selected_context_status: 'fresh',
      graph_path: `${root}/.madar/graph.json`, graph_modified_ms: 123, indexed_file_count: 40,
      changed_source_count: 0, recommendation: 'Graph is fresh enough to rely on.' } } }
  const text = price(payload), original = JSON.parse(text)
  const response = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }
  const before = JSON.stringify(response)
  const output = compactDuplicateSourcePositions(response, 'context_expand', {}, root)
  const compact = JSON.parse(output.result.content[0]!.text)
  expect(JSON.stringify(response)).toBe(before)
  expect(payload).toEqual(original)
  expect(compact.pack.matched_nodes[0].source_file).toBe('src/dispatch.ts')
  expect(compact.pack.source_dependencies.unresolved[0].source_file).toBe('src/dispatch.ts')
  expect(compact.pack.source_dependencies.unresolved_groups[0].source_file).toBe('src/dispatch.ts')
  expect(compact.expandable[0].focus_files).toEqual(['src/dispatch.ts'])
  expect(compact.expandable[0].focus_ranges[0].source_file).toBe('src/dispatch.ts')
  expect(compact.governance.graph_freshness).toEqual({ status: 'fresh', graph_version: 'version:fixed', selected_context_status: 'fresh' })
  expect(compact.serialized_budget.token_count).toBe(estimateQueryTokens(output.result.content[0]!.text))
  expect(compact.serialized_budget.token_count).toBeLessThan(original.serialized_budget.token_count)
  // Restoring only the declared metadata projection reconstructs every other field exactly.
  compact.pack.matched_nodes[0].source_file = sourceFile
  compact.pack.source_dependencies.unresolved[0].source_file = sourceFile
  compact.pack.source_dependencies.unresolved_groups[0].source_file = sourceFile
  compact.expandable[0].focus_files = [sourceFile]
  compact.expandable[0].focus_ranges[0].source_file = sourceFile
  compact.governance.graph_freshness = original.governance.graph_freshness
  compact.serialized_budget.token_count = original.serialized_budget.token_count
  expect(compact).toEqual(original)
  expect(compactDuplicateSourcePositions(response, 'context_pack', {}, root)).toBe(response)
})

it('preserves unverifiable paths and unknown or malformed freshness meaning', () => {
  const root = '/workspace/isolated/project'
  const paths = [`${root}/src/owner.ts`, '/elsewhere/src/owner.ts', `${root}/src/../owner.ts`,
    `${root}/./owner.ts`, root, 'src/relative.ts', `${root}/invalid\0.ts`]
  const freshness = { status: 'fresh', selected_context_status: 'fresh', graph_version: 'fixed',
    graph_path: `${root}/.madar/graph.json`, generated_ms: 123,
    changed_source_count: '0', missing_selected_context_count: -1, changed_outside_selected_context_count: 2,
    unknown_count: 3, reason: 'Binding remains unverified', warning: { source_file: `${root}/private.ts` },
    recommendation: 'Inspect the unresolved source before relying on this result.' }
  for (const knownRoot of [root, undefined, `${root}/.`]) {
    const payload: Value = { response_format: 'source_evidence_v2',
      pack: { matched_nodes: paths.map((source_file, index) => ({ node_id: `owner:${index}`, source_file, snippet: 'return 1' })) },
      expandable: [{ handle_id: 'fixed', focus_files: paths, focus_ranges: paths.map(source_file => ({ source_file, start_line: 1, end_line: 1 })) }],
      governance: { graph_freshness: freshness } }
    const text = price(payload), response = { result: { content: [{ type: 'text', text }] } }
    const output = compactDuplicateSourcePositions(response, 'context_expand', {}, knownRoot)
    const compact = JSON.parse(output.result.content[0]!.text)
    const expectedPaths = paths.map((path, index) => knownRoot === root && index === 0 ? 'src/owner.ts' : path)
    expect(compact.pack.matched_nodes.map((node: Value) => node.source_file)).toEqual(expectedPaths)
    expect(compact.expandable[0].focus_files).toEqual(expectedPaths)
    expect(compact.expandable[0].focus_ranges.map((range: Value) => range.source_file)).toEqual(expectedPaths)
    const { graph_path: _path, generated_ms: _time, ...meaning } = freshness
    expect(compact.governance.graph_freshness).toEqual(meaning)
    expect(compact.serialized_budget.token_count).toBe(estimateQueryTokens(output.result.content[0]!.text))
    expect(response.result.content[0]!.text).toBe(text)
  }
  const malformed = { ...freshness, status: ['fresh'] }
  const text = price({ response_format: 'source_evidence_v2', pack: { matched_nodes: [{ source_file: paths[0], snippet: 'return 1' }] },
    governance: { graph_freshness: malformed } })
  const response = { result: { content: [{ type: 'text', text }] } }
  const output = compactDuplicateSourcePositions(response, 'context_expand', {}, root)
  expect(JSON.parse(output.result.content[0]!.text).governance.graph_freshness).toEqual(malformed)
  expect(compactDuplicateSourcePositions(response, 'context_expand', {})).toBe(response)
})

it('shares only identical valid partial source text while preserving each owner and cursor', () => {
  const source = 'export function processItems(items: number[]) {\n  let total = items.length;\n[omitted lines 3-8]\n  return total;\n}'
  const owner: Value = { node_id: 'items_process', label: 'processItems()', source_file: 'src/items.ts', snippet: source,
    snippet_scope: 'symbol', snippet_line_range: { start_line: 1, end_line: 10 },
    snippet_omitted_ranges: [{ start_line: 3, end_line: 8 }], snippet_truncated: true, source_expand_handle: 'source-expand:process' }
  const values = [owner,
    { ...owner, node_id: 'items_file', label: 'items.ts', snippet_scope: 'source_file', source_expand_handle: 'source-expand:file' },
    { ...owner, node_id: 'items_alias', source_expand_handle: 'source-expand:alias' },
    { ...owner, node_id: 'other_file', source_file: 'src/other.ts' },
    { ...owner, node_id: 'other_bytes', snippet: source.replace('items.length', 'items.length + 1') },
    { ...owner, node_id: 'other_omission', snippet_omitted_ranges: [{ start_line: 4, end_line: 8 }] },
    { ...owner, node_id: 'other_range', snippet_line_range: { start_line: 1, end_line: 11 } },
    { ...owner, node_id: 'unverified', snippet_unverified: true },
    { ...owner, node_id: 'derived', snippet_source: 'derived', representation_type: 'summary' },
    { ...owner, node_id: 'already_referenced', snippet: undefined, snippet_ref: 'items_alias' },
  ]
  for (const tool of ['context_pack', 'context_expand']) {
    const payload: Value = { response_format: 'source_evidence_v2', task: 'explain',
      pack: { matched_nodes: values, relationships: [{ from_id: 'items_file', to_id: 'items_process', relation: 'contains' }] },
      evidence: { answerability: { state: 'insufficient', answer_scope: 'partial', missing_obligations: ['query:pending'] } },
      expandable: [{ handle_id: 'expand:unchanged' }] }
    const text = price(payload), response = { result: { content: [{ type: 'text', text }] } }
    const output = compactDuplicateSourcePositions(response, tool, {})
    const compact = JSON.parse(output.result.content[0]!.text), nodes = compact.pack.matched_nodes
    expect(response.result.content[0]!.text).toBe(text)
    expect(nodes[0].snippet).toBe(source)
    for (const index of [1]) {
      expect(nodes[index].snippet).toBeUndefined()
      expect(nodes[index].snippet_ref).toBe('items_process')
      expect(resolveSourceSnippet(nodes[index], nodes)).toBe(source)
      nodes[index].snippet = source
      delete nodes[index].snippet_ref
    }
    expect(nodes[2].snippet).toBe(source)
    expect(nodes[2].snippet_ref).toBeUndefined()
    expect(compact.serialized_budget.token_count).toBe(estimateQueryTokens(output.result.content[0]!.text))
    expect(compact.serialized_budget.token_count).toBeLessThan(payload.serialized_budget.token_count)
    compact.serialized_budget.token_count = payload.serialized_budget.token_count
    expect(compact).toEqual(payload)
    expect(compactDuplicateSourcePositions(output, tool, {})).toBe(output)
  }
  const duplicateIds = price({ response_format: 'source_evidence_v2', pack: { matched_nodes: [owner, { ...owner }] } })
  const ambiguous = { result: { content: [{ type: 'text', text: duplicateIds }] } }
  expect(compactDuplicateSourcePositions(ambiguous, 'context_pack', {})).toBe(ambiguous)
})
