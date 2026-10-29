import { describe, expect, it } from 'vitest'
import { finalizeSourceEvidenceResponse, renderSourceEvidenceText } from '../../src/runtime/source-evidence-response.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'

const code = 'export function reset(token: string) {\n  if (expired(token)) throw new Error("expired");\n  return consume(token);\n}'
function response(task = 'explain') {
  return {
    task, prompt: 'reset tokens', plan: { diagnostics: 'redundant metadata '.repeat(100) },
    pack: { matched_nodes: ['a', 'b'].map(node_id => ({ node_id, label: 'reset', source_file: 'src/reset.ts',
      line_number: 1, snippet: code, snippet_line_range: { start_line: 1, end_line: 4 }, snippet_scope: 'symbol',
      match_score: 100, representation_reason: 'ranking detail' })),
      relationships: [{ from_id: 'a', from: 'reset', to_id: 'b', to: 'reset', relation: 'calls' }],
      community_context: [{ label: 'diagnostic community' }] },
    evidence: { answerability: { state: 'ready', answer_scope: 'complete', advisory: true,
      caveats: [], missing_obligations: [], verification_targets: [], broad_search_fallback: 'allowed' },
      discovery_exclusions: { relevant: 1, reasons: ['policy-excluded secret directory'] } },
    governance: { graph_freshness: { status: 'fresh', graph_version: 'v1', selected_context_status: 'fresh' } },
    cache: { status: 'hit', graph_version: 'v1' },
  }
}

describe('source evidence wire contract', () => {
  it('preserves impact identities and limits in compact JSON and text', () => {
    const traversal = { status: 'node_limited', depth: 3, node_limit: 500 }
    const impact_traversal = { analyzed_targets: 13, partial_targets: 1, depth_limited_targets: 0, node_limited_targets: 1 }
    const input = { ...response('impact'), pack: { target: 'reset', target_node_id: 'reset-id', total_affected: 499,
      traversal, impact_traversal, changed_nodes: [{ node_id: 'reset-id', label: 'reset', traversal }] } }
    for (const format of ['json', 'text'] as const) {
      const output = finalizeSourceEvidenceResponse(input, 3000, { format })
      expect(output.pack).toMatchObject(input.pack)
      if (format === 'text') expect(renderSourceEvidenceText(output)).toContain('node_limited')
    }
  })

  it('groups repeated dependency metadata losslessly without changing counts or source', () => {
    const input = response() as Record<string, unknown>
    const file = 'src/features/accounts/application/services/account-recovery.ts'
    const call = { source_file: file, line_number: 5, callee: 'port.deliver', reason: 'no_implementation',
      binding: { declaration: 'DeliveryPort' } }
    const unresolved = [call, { ...call }, { ...call, line_number: 8 },
      { ...call, reason: 'external' }, { ...call, reason: 'external', line_number: 12 },
      { ...call, source_file: `${file}.other` }, { ...call, source_file: `${file}.other`, line_number: 19 },
      { ...call, line_number: 22 }, { ...call, line_number: 25 }]
    const dependencies = { scanned_files: 4, resolved_calls: 2, unresolved_calls: 15,
      unresolved_references: 1, bounded: true, extension: { limit: 9 }, unresolved }
    ;(input.pack as Record<string, unknown>).source_dependencies = dependencies
    const output = finalizeSourceEvidenceResponse(input, 10000)
    expect(output.response_format).toBe('source_evidence_v2')
    const compact = (output.pack as Record<string, unknown>).source_dependencies as Record<string, unknown>
    expect(compact).not.toHaveProperty('unresolved')
    const groups = compact.unresolved_groups as Array<{ source_file: string; reason: string; calls: Record<string, unknown>[] }>
    expect(groups).toHaveLength(4)
    const restored: Record<string, unknown> = { ...compact, unresolved: groups.flatMap(group => group.calls.map(entry => ({
      source_file: group.source_file, reason: group.reason, ...entry,
    }))) }
    delete restored.unresolved_groups
    expect(restored).toEqual(dependencies)
    expect(estimateQueryTokens(JSON.stringify(compact))).toBeLessThan(estimateQueryTokens(JSON.stringify(dependencies)))
    expect((output.pack as { matched_nodes: unknown[] }).matched_nodes).toEqual(
      (finalizeSourceEvidenceResponse(response(), 10000).pack as { matched_nodes: unknown[] }).matched_nodes)
    expect(output.evidence).toEqual(finalizeSourceEvidenceResponse(response(), 10000).evidence)
    expect(output.governance).toEqual(finalizeSourceEvidenceResponse(response(), 10000).governance)
    expect((finalizeSourceEvidenceResponse(input, 10000, { verbose: true }).pack as Record<string, unknown>).source_dependencies).toEqual(dependencies)
    expect((input.pack as Record<string, unknown>).source_dependencies).toEqual(dependencies)
  })

  it('keeps dependency details flat when grouping is larger or an entry has an unknown shape', () => {
    for (const unresolved of [[], [{ source_file: 'a.ts', line_number: 1, callee: 'x', reason: 'external' }],
      [{ source_file: 'a.ts', callee: 'x', reason: null }, { source_file: 'a.ts', callee: 'y', reason: null }]]) {
      const input = response() as Record<string, unknown>
      const dependencies = { unresolved_calls: unresolved.length, bounded: false, unresolved }
      ;(input.pack as Record<string, unknown>).source_dependencies = dependencies
      expect((finalizeSourceEvidenceResponse(input, 3000).pack as Record<string, unknown>).source_dependencies).toEqual(dependencies)
    }
  })

  it('deduplicates exact spans without changing source, locations, edges, policy or freshness', () => {
    const original = response()
    const result = finalizeSourceEvidenceResponse(original, 3000)
    const pack = result.pack as typeof original.pack
    expect(pack.matched_nodes[0]?.snippet).toBe(code)
    expect(pack.matched_nodes[1]).toMatchObject({ node_id: 'b', snippet_ref: 'a', snippet_line_range: { start_line: 1, end_line: 4 } })
    expect(pack.matched_nodes[1]?.snippet).toBeUndefined()
    expect(pack.relationships).toEqual([{ from_id: 'a', to_id: 'b', relation: 'calls' }])
    expect(result.evidence).toMatchObject({ discovery_exclusions: original.evidence.discovery_exclusions })
    expect(result.governance).toEqual(original.governance)
    expect(result.evidence).toMatchObject({ answerability: { advisory: true } })
    expect((result.evidence as { answerability: object }).answerability).not.toHaveProperty('state')
    expect((result.evidence as { answerability: object }).answerability).not.toHaveProperty('answer_scope')
    expect(estimateQueryTokens(JSON.stringify(result))).toBeLessThan(estimateQueryTokens(JSON.stringify(original)))
    expect(original.pack.matched_nodes[1]?.snippet).toBe(code)
  })

  it.each(['explain', 'implement', 'review', 'impact'])('caps the complete %s response after cache metadata', task => {
    const input = response(task)
    input.pack.matched_nodes.push(...Array.from({ length: 25 }, (_, i) => ({ ...input.pack.matched_nodes[0]!, node_id: `n${i}`,
      source_file: `src/reset-${i}.ts`, snippet: code.repeat(10) })))
    const output = finalizeSourceEvidenceResponse(input, 500)
    const actual = estimateQueryTokens(JSON.stringify(output))
    expect(actual).toBeLessThanOrEqual(500)
    expect(output.serialized_budget).toEqual({ max_tokens: 500, token_count: actual, enforced: true })
    expect(output.evidence).toMatchObject({ answerability: { state: 'insufficient', advisory: true } })
    for (const node of (output.pack as { matched_nodes?: Array<{ snippet?: string }> } | undefined)?.matched_nodes ?? []) {
      if (node.snippet) expect([code, code.repeat(10)]).toContain(node.snippet)
    }
  })

  it('keeps diagnostic verbose output if it fits and reports complete final size', () => {
    const output = finalizeSourceEvidenceResponse(response(), 10000, { verbose: true })
    expect(output.plan).toBeDefined()
    expect(output.serialized_budget).toMatchObject({ token_count: estimateQueryTokens(JSON.stringify(output)), enforced: true })
  })

  it('renders source in text output with its own exact output budget', () => {
    const output = finalizeSourceEvidenceResponse(response(), 1000, { format: 'text' })
    const text = renderSourceEvidenceText(output)
    expect(text).toContain('src/reset.ts:1')
    expect(text).toContain(code)
    expect(output.serialized_budget).toMatchObject({ token_count: estimateQueryTokens(text), enforced: true })
  })

  it('uses an honest bounded insufficiency envelope when no source can fit', () => {
    const output = finalizeSourceEvidenceResponse(response(), 128)
    expect(estimateQueryTokens(JSON.stringify(output))).toBeLessThanOrEqual(128)
    expect(output.evidence).toMatchObject({ answerability: { state: 'insufficient', broad_search_fallback: 'allowed' } })
    expect(output.omitted_evidence).toBeDefined()
  })

  it('preserves a policy block even at the minimum budget', () => {
    const input = response()
    input.evidence.answerability.broad_search_fallback = 'blocked'
    const output = finalizeSourceEvidenceResponse(input, 128)
    expect(output.evidence).toMatchObject({ answerability: { broad_search_fallback: 'blocked' } })
  })

  it('preserves unresolved dependency and scan bounds in the minimum-budget envelope', () => {
    const input = response() as Record<string, unknown>
    ;(input.pack as Record<string, unknown>).source_dependencies = { scanned_files: 10, resolved_calls: 4, unresolved_calls: 3, unresolved_references: 2, bounded: true }
    ;(input.pack as Record<string, unknown>).source_search = { bounded: true }
    const output = finalizeSourceEvidenceResponse(input, 128)
    expect(output.limitations).toMatchObject({ bounded_dependencies: true, unresolved_calls: 3, unresolved_references: 2, bounded_search: true })
    expect(estimateQueryTokens(JSON.stringify(output))).toBeLessThanOrEqual(128)
  })
})

describe('contained source span sharing', () => {
  it('shares byte-equal contained bodies through an explicit owner range without cycles', async () => {
    const { resolveSourceSnippet } = await import('../../src/runtime/source-evidence-response.js')
    const ownerCode = `const prefix = 0;\n${code}\nconst suffix = 1;`
    const input = response()
    const child = { ...input.pack.matched_nodes[0]!, node_id: 'method', line_number: 2, snippet_line_range: { start_line: 2, end_line: 5 } }
    const owner = { ...child, node_id: 'file', label: 'reset.ts', line_number: 1, snippet: ownerCode, snippet_line_range: { start_line: 1, end_line: 6 }, snippet_scope: 'source_file' }
    input.pack.matched_nodes = [child, owner]
    input.pack.relationships = []
    const output = finalizeSourceEvidenceResponse(input, 3000)
    const nodes = (output.pack as { matched_nodes: Record<string, unknown>[] }).matched_nodes
    expect(nodes.map(node => node.node_id)).toEqual(['method', 'file'])
    expect(nodes[0]).toMatchObject({ snippet_ref: 'file', snippet_line_range: { start_line: 2, end_line: 5 } })
    expect(nodes[1]?.snippet).toBe(ownerCode)
    expect(resolveSourceSnippet(nodes[0]!, nodes)).toBe(code)
    expect(nodes[1]).not.toHaveProperty('snippet_ref')
  })

  it('rehydrates only the child subrange when its large owner is culled', async () => {
    const { resolveSourceSnippet } = await import('../../src/runtime/source-evidence-response.js')
    const ownerCode = `const prefix = 0;\n${code}\n${'const unrelated = "padding";\n'.repeat(200)}`
    const input = response()
    input.pack.matched_nodes = [
      { ...input.pack.matched_nodes[0]!, node_id: 'method', line_number: 2, snippet_line_range: { start_line: 2, end_line: 5 } },
      { ...input.pack.matched_nodes[0]!, node_id: 'file', label: 'reset.ts', snippet: ownerCode,
        snippet_line_range: { start_line: 1, end_line: ownerCode.split('\n').length }, snippet_scope: 'source_file' },
    ]
    input.pack.relationships = []
    const output = finalizeSourceEvidenceResponse(input, 500)
    const nodes = (output.pack as { matched_nodes: Record<string, unknown>[] }).matched_nodes
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.node_id).toBe('method')
    expect(resolveSourceSnippet(nodes[0]!, nodes)).toBe(code)
    expect(nodes[0]?.snippet).not.toContain('unrelated')
    expect(nodes[0]).not.toHaveProperty('snippet_ref')
    expect(estimateQueryTokens(JSON.stringify(output))).toBeLessThanOrEqual(500)
  })

  it('does not share mismatched bytes', () => {
    const input = response()
    input.pack.matched_nodes[1]!.snippet = code.replace('consume', 'reject')
    const output = finalizeSourceEvidenceResponse(input, 3000)
    expect((output.pack as { matched_nodes: object[] }).matched_nodes[1]).not.toHaveProperty('snippet_ref')
  })

  it('does not select a subrange from an owner with omitted source', () => {
    const input = response()
    input.pack.matched_nodes = [
      { ...input.pack.matched_nodes[0]!, node_id: 'method', line_number: 2, snippet_line_range: { start_line: 2, end_line: 5 } },
      { ...input.pack.matched_nodes[1]!, node_id: 'file', snippet: `const prefix = 0;\n${code}\nconst suffix = 1;`,
        snippet_line_range: { start_line: 1, end_line: 6 }, snippet_truncated: true } as typeof input.pack.matched_nodes[number],
    ]
    const output = finalizeSourceEvidenceResponse(input, 3000)
    expect((output.pack as { matched_nodes: object[] }).matched_nodes[0]).not.toHaveProperty('snippet_ref')
  })
})

describe('focused lookup metadata', () => {
  it('discloses additional matches omitted by selection, including in a tiny response', () => {
    const input = response() as Record<string, unknown>
    Object.assign(input.pack as Record<string, unknown>, { selection_scope: 'symbol_lookup', selection_omitted: 3 })
    const output = finalizeSourceEvidenceResponse(input, 3000)
    expect(output.pack).toMatchObject({ selection_omitted: 3 })
    expect(output.evidence).toMatchObject({ answerability: { caveats: expect.arrayContaining([
      'Additional matching source targets were omitted by the selection limit.',
    ]) } })
    const tiny = finalizeSourceEvidenceResponse(input, 128)
    expect(tiny.limitations).toMatchObject({ selection_omitted: 3 })
    expect(estimateQueryTokens(JSON.stringify(tiny))).toBeLessThanOrEqual(128)
  })

  it('uses the explicit selection scope to keep a direct lookup small without changing its source', () => {
    const input = response() as Record<string, unknown>
    input.task_intent = 'explain'
    const pack = input.pack as Record<string, unknown>
    pack.matched_nodes = [response().pack.matched_nodes[0]]
    pack.relationships = []
    pack.source_search = { scanned_files: 50, scanned_bytes: 30000, bounded: false }
    const normal = finalizeSourceEvidenceResponse(input, 3000)
    pack.selection_scope = 'symbol_lookup'
    const focused = finalizeSourceEvidenceResponse(input, 3000)
    const focusedPack = focused.pack as Record<string, unknown>
    expect(focusedPack.matched_nodes).toEqual((normal.pack as Record<string, unknown>).matched_nodes)
    expect(focusedPack.source_search).toEqual({ bounded: false })
    expect(focused.evidence).toMatchObject({ answerability: { advisory: true, broad_search_fallback: 'allowed' } })
    expect(focused.governance).toEqual(normal.governance)
    expect(focused.cache).toEqual({ status: 'hit' })
    expect(focused).not.toHaveProperty('task_intent')
    expect(focusedPack).not.toHaveProperty('relationships')
    expect(estimateQueryTokens(JSON.stringify(focused))).toBeLessThan(estimateQueryTokens(JSON.stringify(normal)))
    expect(focused.serialized_budget).toMatchObject({ token_count: estimateQueryTokens(JSON.stringify(focused)) })
  })

  it('retains policy, source verification, omission and dependency limits for focused lookups', () => {
    const input = response() as Record<string, unknown>
    const pack = input.pack as Record<string, unknown>
    pack.selection_scope = 'file_lookup'
    pack.source_search = { scanned_files: 1, scanned_bytes: 100, bounded: true }
    pack.source_dependencies = { scanned_files: 1, resolved_calls: 0, unresolved_calls: 1, bounded: true,
      unresolved: [{ source_file: 'src/reset.ts', line_number: 3, callee: 'consume', reason: 'outside_index' }] }
    const node = (pack.matched_nodes as Record<string, unknown>[])[0]!
    node.snippet_unverified = true
    node.snippet_truncated = true
    node.snippet_omitted_ranges = [{ start_line: 5, end_line: 9 }]
    const evidence = input.evidence as Record<string, unknown>
    ;(evidence.answerability as Record<string, unknown>).broad_search_fallback = 'blocked'
    evidence.indexing_completeness = { state: 'partial', skipped_files: 3 }
    input.governance = { graph_freshness: { status: 'stale', selected_context_status: 'stale', changed_source_count: 1 } }
    const output = finalizeSourceEvidenceResponse(input, 3000)
    expect(output.pack).toMatchObject({ source_search: { bounded: true }, source_dependencies: pack.source_dependencies,
      matched_nodes: expect.arrayContaining([expect.objectContaining({ snippet: code, snippet_unverified: true,
        snippet_omitted_ranges: [{ start_line: 5, end_line: 9 }] })]) })
    expect(output.evidence).toMatchObject({ indexing_completeness: evidence.indexing_completeness,
      discovery_exclusions: evidence.discovery_exclusions, answerability: { broad_search_fallback: 'blocked',
        caveats: expect.arrayContaining(['Source search was bounded; unmatched code may exist.',
          'Cached source excerpt could not be verified against the current file.']) } })
    expect(output.governance).toEqual(input.governance)
  })

  it('keeps repeated limitations and owned continuation details once', () => {
    const input = response() as Record<string, unknown>
    const evidence = input.evidence as Record<string, unknown>
    evidence.coverage_detail = { missing_obligations: ['evidence:structural', 'query:obligation:1'] }
    ;(evidence.answerability as Record<string, unknown>).missing_obligations = ['evidence:structural']
    ;(evidence.answerability as Record<string, unknown>).verification_targets = [
      { handle_id: 'h1', focus_files: ['src/reset.ts'], reason: 'verify source' },
      { focus_files: ['src/other.ts'], reason: 'read unhandled source' },
    ]
    input.missing_context = ['structural', 'supporting']
    input.expandable = [{ handle_id: 'h1', count: 1, evidence_class: 'supporting', follow_up: { focus_files: ['src/reset.ts'] } }]
    const pack = input.pack as Record<string, unknown>
    pack.relationships = [...response().pack.relationships, ...response().pack.relationships]
    const output = finalizeSourceEvidenceResponse(input, 3000)
    expect((output.pack as Record<string, unknown>).relationships).toHaveLength(1)
    expect(output.evidence).toMatchObject({ answerability: { missing_obligations: ['evidence:structural', 'query:obligation:1'],
      verification_targets: [{ handle_id: 'h1' }, { focus_files: ['src/other.ts'], reason: 'read unhandled source' }] } })
    expect(output.evidence).not.toHaveProperty('missing_obligations')
    expect(output.missing_context).toEqual(['supporting'])
    expect(output.expandable).toEqual([{ handle_id: 'h1', count: 1, evidence_class: 'supporting', focus_files: ['src/reset.ts'] }])
  })

  it('retains actionable implementation locations while keeping graph ranking prose in verbose output', () => {
    const input = response('implement') as Record<string, unknown>
    input.implementation = {
      likely_edit_files: [{ path: 'src/reset.ts', matched_symbols: ['reset'], reason: 'Graph centrality ranking '.repeat(40) }],
      likely_test_files: [{ path: 'tests/reset.test.ts', matched_symbols: ['reset rejects expired tokens'] }],
      validation_commands: ['npm test -- reset'],
      validation_discovery: { source_file: 'package.json', scope: 'root_package_validation_scripts',
        observed_at: '2026-10-23T00:00:00.000Z', status: 'inspected', result: 'commands_available' },
      risk_boundaries: [{ label: 'reset', severity: 'high', affected_files: ['src/reset.ts'],
        affected_communities: ['Auth', 'Reset'], reason: 'Graph hotspot ranking '.repeat(40) }],
    }
    const output = finalizeSourceEvidenceResponse(input, 3000)
    expect(output.implementation).toEqual({
      likely_edit_files: [{ path: 'src/reset.ts', matched_symbols: ['reset'] }],
      likely_test_files: [{ path: 'tests/reset.test.ts', matched_symbols: ['reset rejects expired tokens'] }],
      validation_commands: ['npm test -- reset'],
      validation_discovery: { source_file: 'package.json', scope: 'root_package_validation_scripts',
        observed_at: '2026-10-23T00:00:00.000Z', status: 'inspected', result: 'commands_available' },
      risk_boundaries: [{ label: 'reset', affected_files: ['src/reset.ts'] }],
    })
    expect(finalizeSourceEvidenceResponse(input, 10000, { verbose: true }).implementation).toEqual(input.implementation)
  })

  it('preserves an inspected empty result even when commands are omitted, without crowding out source', () => {
    const input = response('implement') as Record<string, unknown>
    const discovery = { source_file: 'package.json', scope: 'root_package_validation_scripts',
      observed_at: '2026-10-23T00:00:00.000Z', status: 'inspected', result: 'no_scripts' }
    input.implementation = { validation_commands: [], validation_discovery: discovery }
    expect(finalizeSourceEvidenceResponse(input, 3000).implementation).toEqual({ validation_discovery: discovery })
    // A missing optional receipt under a tight budget makes no negative assertion.
    const bounded = finalizeSourceEvidenceResponse(input, 128)
    expect(bounded.implementation).toBeUndefined()
    expect(JSON.stringify(bounded)).not.toContain('no_scripts')
  })
})
