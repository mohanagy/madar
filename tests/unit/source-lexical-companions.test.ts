import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'
import { reconcileSourceCalls, selectSourceDependencies, sourceSelectionProvenanceKey } from '../../src/runtime/retrieve/source-dependencies.js'
import { sourceDiagnosticLexicalCompanions } from '../../src/runtime/retrieve/source-lexical-companions.js'
import { finalizeSourceEvidenceResponse } from '../../src/runtime/source-evidence-response.js'
import { SOURCE_LEXICAL_DEFINITION_CAVEAT } from '../../src/runtime/source-lexical-context.js'
import { attachSourceContinuationHandles, expandSourceContinuation, type SourceContinuationHandle } from '../../src/runtime/source-continuation.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'

const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const question = 'Trace wrong state with expected tenant and supplied code; a response error with expected state and tenant. Use tests if helpful.'
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-lexical-context-'))); roots.push(root)
  const file = join(root, 'channel.ts')
  const lines = [
    'export class Channel {',
    '  private pending: any;',
    '  begin(expected: any) {',
    '    return new Promise((resolve, reject) => {',
    '      this.pending = { expectedState: expected.state, expectedTenant: expected.tenant, resolve, reject };',
    '    });',
    '  }',
    '  consume(response: any) {',
    '    if (response.state !== this.pending.expectedState || response.tenant !== this.pending.expectedTenant) return false;',
    '    if (response.error || !response.code) { this.finish(); return false; }',
    '    queueMicrotask(() => this.release());',
    '    const other = function (this: any) { this.unrelated(); };',
    '    return this.pending.resolve(response.code);',
    '  }',
    '  private finish() {',
    '    const job = this.pending;',
    '    this.pending = undefined;',
    '    job.reject();',
    '  }',
    '  private release() {',
    '    this.closed = true;',
    '  }',
    '  private unrelated() { return "NESTED_RECEIVER"; }',
    '  static staticTarget() { return "STATIC_RECEIVER"; }',
    '  private closed = false;',
    '}',
    'export class Other { finish() { return "OTHER_CLASS"; } }',
  ]
  writeFileSync(file, lines.join('\n'))
  const extracted = extractJs(file)
  const graph = buildFromJson({ schema_version: 1, nodes: extracted.nodes, edges: extracted.edges }, { directed: true })
  graph.graph.root_path = root
  const candidates = graph.nodeEntries().map(([id, attrs]) => ({ id, label: String(attrs.label), sourceFile: String(attrs.source_file), sourceLocation: String(attrs.source_location) }))
  const named = (name: string) => candidates.find(node => node.label === `.${name}()` && node.sourceLocation !== 'L27-L27')!
  const consume = named('consume'), begin = named('begin'), finish = named('finish'), release = named('release')
  const dependencies = selectSourceDependencies(graph, [consume.id, begin.id], root, new Map(), { includeCallers: false })
  const provenance = dependencies[sourceSelectionProvenanceKey]!
  const select = (allowed = () => true) => sourceDiagnosticLexicalCompanions([consume.id, begin.id], candidates,
    provenance, dependencies.source_call_authority_owner_ids ?? [], allowed, root)
  return { root, file, lines, graph, candidates, named, consume, begin, finish, release, dependencies, provenance, select }
}

describe('diagnostic lexical definition context', () => {
  it('admits direct and lexical-arrow definitions without changing unresolved dispatch or dependency membership', () => {
    const f = fixture(), before = JSON.stringify(f.dependencies)
    const selected = f.select()
    expect(selected.map(value => value.candidate.id)).toEqual([f.finish.id, f.release.id])
    expect(selected.every(value => value.fragment.retained.length === 1)).toBe(true)
    expect(JSON.stringify(f.dependencies)).toBe(before)
    expect(f.dependencies.node_ids).not.toContain(f.finish.id)
    expect(f.provenance.forward.known_reachable_ids).not.toContain(f.finish.id)
    expect(f.provenance.unresolved).toContainEqual(expect.objectContaining({ from_id: f.consume.id, callee: 'this.finish', reason: 'unresolved' }))
    expect(reconcileSourceCalls([{ from_id: f.consume.id, to_id: f.finish.id, relation: 'calls' }], f.dependencies)).toEqual([])
    const result = retrieveContext(f.graph, { question, taskKind: 'explain', taskIntent: 'debug-flow', budget: 1800 })
    // Ordinary conceptual recovery can independently retain these definitions;
    // it need not advertise an admission mechanism that it did not use.
    expect(result.source_dependencies?.unresolved).toContainEqual(expect.objectContaining({ callee: 'this.finish', reason: 'unresolved' }))
    expect(result.matched_nodes.find(node => node.node_id === f.finish.id)?.snippet).toContain('job.reject()')
    expect(result.matched_nodes.find(node => node.node_id === f.release.id)?.snippet).toContain('this.closed = true')
    expect(result.relationships.some(edge => edge.from_id === f.consume.id && [f.finish.id, f.release.id].includes(edge.to_id ?? ''))).toBe(false)
  })

  it('declines excluded, stale, duplicate and unsupported owners without widening authority', () => {
    const f = fixture()
    expect(f.select((_file?: string, label?: string) => label !== f.finish.label).map(value => value.candidate.id)).toEqual([f.release.id])
    const alias = { ...f.provenance.owners.find(owner => owner.node_id === f.finish.id)!, node_id: 'duplicate' }
    const duplicate = { ...f.provenance, owners: [...f.provenance.owners, alias] }
    expect(sourceDiagnosticLexicalCompanions([f.consume.id], [...f.candidates, { ...f.finish, id: 'duplicate' }], duplicate,
      [...(f.dependencies.source_call_authority_owner_ids ?? []), 'duplicate'], () => true, f.root).map(value => value.candidate.id)).toEqual([f.release.id])
    expect(sourceDiagnosticLexicalCompanions([f.consume.id], f.candidates, f.provenance, [], () => true, f.root)).toEqual([])
    const noObservation = { ...f.provenance, unresolved: [] }
    expect(sourceDiagnosticLexicalCompanions([f.consume.id], f.candidates, noObservation,
      f.dependencies.source_call_authority_owner_ids ?? [], () => true, f.root)).toEqual([])
    writeFileSync(f.file, f.lines.join('\n').replace('job.reject()', 'job.resolve()'))
    expect(f.select()).toEqual([])
  })

  it('preserves partial dispatch caution through compact/cache-shaped payloads and source pagination', () => {
    const f = fixture(), context = { admitted_node_ids: [f.finish.id], runtime_dispatch: 'unresolved' as const }
    const input = { task: 'explain', pack: { source_dependencies: { scanned_files: 1, resolved_calls: 0, unresolved_calls: 1,
      bounded: false, lexical_definition_context: context }, matched_nodes: [{ node_id: f.finish.id, label: f.finish.label,
      source_file: f.file, line_number: 15, snippet_scope: 'symbol', snippet: [f.lines[14], '[omitted lines 16-18]', f.lines[18]].join('\n'),
      snippet_line_range: { start_line: 15, end_line: 19 }, snippet_omitted_ranges: [{ start_line: 16, end_line: 18 }], snippet_truncated: true }] },
      evidence: { answerability: { state: 'ready', answer_scope: 'complete', broad_search_fallback: 'allowed' } },
      governance: { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } } }
    for (const verbose of [false, true]) {
      const compact = finalizeSourceEvidenceResponse(JSON.parse(JSON.stringify(input)), 1500, { verbose })
      expect(compact.evidence).toMatchObject({ answerability: { state: 'insufficient', answer_scope: 'partial', caveats: [SOURCE_LEXICAL_DEFINITION_CAVEAT] } })
      if (verbose) continue // Existing verbose responses deliberately do not issue source cursors.
      const handles = new Map<string, SourceContinuationHandle>()
      const attached = attachSourceContinuationHandles(compact, 1500, f.root, (id, handle) => handles.set(id, handle))
      const nodes = (attached.pack as { matched_nodes: Array<{ source_expand_handle: string }> }).matched_nodes
      const handle = handles.get(nodes[0]!.source_expand_handle)!
      expect(handle).toBeDefined()
      const next = expandSourceContinuation(handle, 1500, f.root, input.governance)
      expect(next.payload.evidence).toMatchObject({ answerability: { answer_scope: 'partial', caveats: [SOURCE_LEXICAL_DEFINITION_CAVEAT] } })
      expect(JSON.stringify(next.payload)).toContain('job.reject()')
    }
    const tiny = finalizeSourceEvidenceResponse(input, 128)
    if ((tiny.pack as { matched_nodes?: unknown[] } | undefined)?.matched_nodes?.length) {
      expect(tiny.evidence).toMatchObject({ answerability: { answer_scope: 'partial', caveats: [SOURCE_LEXICAL_DEFINITION_CAVEAT] } })
    }
    expect(estimateQueryTokens(JSON.stringify(tiny))).toBeLessThanOrEqual(128)
  })

  it('retains caution in generic expansion and its remaining owned handle', async () => {
    vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
    const f = fixture(), out = join(f.root, 'out'); mkdirSync(out)
    const graphPath = join(out, 'graph.json')
    const large = `export const Large = {\n${Array.from({ length: 75 }, (_, n) => `  row${n}: '${'expensive '.repeat(180)}',`).join('\n')}\n}`
    writeFileSync(join(f.root, 'large.ts'), large)
    const nodes = [...f.graph.nodeEntries().map(([id, attrs]) => ({ id, ...attrs })),
      { id: 'large', label: 'Large', source_file: 'large.ts', source_location: 'L1-L77', file_type: 'code', node_kind: 'constant' }]
    writeFileSync(graphPath, JSON.stringify({ directed: true, root_path: f.root, nodes, edges: [], hyperedges: [] }))
    const lexicalContext = { admitted_node_ids: [f.finish.id], runtime_dispatch: 'unresolved' }
    const handles = new Map<string, unknown>([['owned', { prompt: question, task: 'explain', task_intent: 'debug-flow',
      lexical_definition_context: lexicalContext, follow_up: { kind: 'context_pack', task_kind: 'explain', evidence_class: 'primary',
        node_ids: [f.finish.id, 'large'], focus_files: [f.file, 'large.ts'], focus_ranges: [] } }]])
    const state = { logLevel: 'info' as const, subscribedResourceUris: new Set<string>(), resourceVersions: new Map<string, string>(),
      resourceListSignature: null, contextPackHandles: handles }
    const response = await handleStdioRequest(graphPath, { id: 1, method: 'tools/call', params: { name: 'context_expand', arguments: { handle_id: 'owned', budget: 1500 } } }, state)
    const text = (response?.result as { content: { text: string }[] }).content[0]!.text
    const payload = JSON.parse(text)
    expect(payload.pack.matched_nodes).toContainEqual(expect.objectContaining({ node_id: f.finish.id, snippet: expect.stringContaining('job.reject()') }))
    expect(payload.evidence.answerability).toMatchObject({ state: 'insufficient', answer_scope: 'partial', caveats: expect.arrayContaining([SOURCE_LEXICAL_DEFINITION_CAVEAT]) })
    expect(payload.pack.source_dependencies.lexical_definition_context).toEqual(lexicalContext)
    const next = payload.expandable.find((entry: { handle_id: string }) => entry.handle_id !== 'owned')
    expect(next).toBeDefined()
    expect(handles.get(next.handle_id)).toMatchObject({ lexical_definition_context: lexicalContext, follow_up: { node_ids: ['large'] } })
    expect(estimateQueryTokens(text)).toBeLessThanOrEqual(1500)
    // An ordinary request can reissue the same stable child ID. It must not
    // erase the caution inherited by an earlier response using that handle.
    const original = handles.get('owned') as Record<string, unknown>
    const { lexical_definition_context: _context, ...unmarked } = original
    handles.set('unmarked', unmarked)
    await handleStdioRequest(graphPath, { id: 2, method: 'tools/call', params: { name: 'context_expand', arguments: { handle_id: 'unmarked', budget: 1500 } } }, state)
    expect(handles.get(next.handle_id)).toMatchObject({ lexical_definition_context: lexicalContext, follow_up: { node_ids: ['large'] } })
  })
})
