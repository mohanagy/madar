import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { lineRangeFromSourceLocation } from '../../src/shared/source-location.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { attachSourceContinuationHandles } from '../../src/runtime/source-continuation.js'
import { resolveSourceSnippet, SOURCE_EVIDENCE_RESPONSE_FORMAT } from '../../src/runtime/source-evidence-response.js'
import * as sourceEvidenceResponses from '../../src/runtime/source-evidence-response.js'
import { activeMcpTools } from '../../src/runtime/stdio/definitions.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'

type RecordValue = Record<string, unknown>
type Range = { start_line: number; end_line: number }
type SourceNode = RecordValue & { node_id: string; label: string; source_file: string; snippet_line_range: Range }
type Payload = RecordValue & { pack: { matched_nodes: SourceNode[]; relationships?: RecordValue[] }; evidence: { answerability: RecordValue }; serialized_budget: RecordValue }
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })

function fixture(withLongOwner = false, queuedOwners = 0) {
  vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
  const root = mkdtempSync(join(tmpdir(), 'madar-targeted-expansion-')); roots.push(root)
  const source = [
    'import { importedOnly } from "./helpers.mjs";',
    'export const valueOnly = 42;',
    'export class RecordBuilder {',
    '  static buildRecord(value) {',
    '    if (value < 0) throw new Error("E_RECORD_NEGATIVE");',
    '    const record = { value: value + 1 };',
    '    return record;',
    '  }',
    '}',
    'export function duplicated(value) {',
    '  return value;',
    '}',
    'export function unrelated(value) {',
    '  return importedOnly(value);',
    '}',
  ]
  source.push(...Array.from({ length: queuedOwners }, (_, index) => [
    `export function queuedRecord${index}(value) {`,
    `  return value + ${index};`,
    '}',
  ].join('\n')))
  writeFileSync(join(root, 'records.mjs'), source.join('\n'))
  writeFileSync(join(root, 'helpers.mjs'), [
    'export function importedOnly(value) {',
    '  return value * 2;',
    '}',
    'export function outsideOnly(value) {',
    '  return value - 1;',
    '}',
    'export function duplicated(value) {',
    '  return value + 2;',
    '}',
  ].join('\n'))
  const longSource = ['export function accumulateRecord(value) {',
    ...Array.from({ length: 80 }, (_, index) => `  value += ${index};`),
    '  return value;', '}'].join('\n')
  if (withLongOwner) writeFileSync(join(root, 'long.mjs'), longSource)
  mkdirSync(join(root, 'scoped'))
  writeFileSync(join(root, 'scoped', 'records.mjs'), 'export function scopedOnly(value) {\n  return value;\n}\n')
  const graphPath = generateGraph(root, { noHtml: true, includeDocs: false, docs: false }).graphPath
  const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as { nodes: Array<{ id: string; label: string; source_file: string; source_location: string }> }
  const target = graph.nodes.find(node => node.label.replace(/\(\)$/, '').split(/[.:]/).at(-1) === 'buildRecord')!
  expect(target).toBeDefined()
  const targetLocation = lineRangeFromSourceLocation(target.source_location)!
  const targetRange = { start_line: targetLocation.start, end_line: targetLocation.end }
  expect(targetRange).toEqual({ start_line: 4, end_line: 8 })
  const state: NonNullable<Parameters<typeof handleStdioRequest>[2]> = {
    logLevel: 'info', subscribedResourceUris: new Set(), resourceVersions: new Map(), resourceListSignature: null,
    contextPackHandles: new Map(),
  }
  const prompt = 'Explain how records are built and sent, including downstream failure paths.'
  const store = (id: string, focus_files: string[], focus_ranges: Array<Range & { source_file: string }> = []) => {
    state.contextPackHandles!.set(id, { prompt, task: 'explain', task_intent: 'explain',
      follow_up: { kind: 'context_pack', task_kind: 'explain', evidence_class: 'primary', focus_files, focus_ranges } })
  }
  store('records', ['records.mjs'])
  let requestId = 0
  const response = (args: RecordValue) => handleStdioRequest(graphPath, { id: ++requestId, method: 'tools/call',
    params: { name: 'context_expand', arguments: args } }, state)
  const call = async (args: RecordValue) => {
    const result = await response(args)
    expect(result?.error).toBeUndefined()
    const text = (result!.result as { content: Array<{ text: string }> }).content[0]!.text
    const payload = JSON.parse(text) as Payload
    expect(payload.serialized_budget).toEqual({ max_tokens: args.budget, token_count: estimateQueryTokens(text), enforced: true })
    expect(estimateQueryTokens(text)).toBeLessThanOrEqual(Number(args.budget))
    return { payload, text }
  }
  return { root, source, longSource, graphPath, target, targetRange, state, prompt, store, response, call }
}

describe('explicit symbol selection on owned context expansion handles', () => {
  it('continues only ordered omitted owners and keeps child handles inside the same identity scope', async () => {
    const f = fixture(false, 40)
    const graph = JSON.parse(readFileSync(f.graphPath, 'utf8')) as { nodes: Array<{ id: string; label: string }> }
    const ids = graph.nodes.filter(node => /^queuedRecord\d+\(\)$/.test(node.label)).map(node => node.id).reverse()
    expect(ids).toHaveLength(40)
    f.store('queued', ['records.mjs'])
    const stored = f.state.contextPackHandles!.get('queued') as { follow_up: RecordValue }
    stored.follow_up.node_ids = ids
    const { payload, text } = await f.call({ handle_id: 'queued', budget: 900 })
    const delivered = payload.pack.matched_nodes.map(node => node.node_id)
    expect(delivered.length).toBeGreaterThan(0)
    expect(delivered).toEqual(ids.slice(0, delivered.length))
    expect(text).not.toContain('node_ids')
    const next = (payload.expandable as Array<{ handle_id: string; count: number }>)[0]!
    expect(next).toBeDefined()
    const child = f.state.contextPackHandles!.get(next.handle_id) as { follow_up: { node_ids: string[] } }
    expect(child.follow_up.node_ids.length).toBeLessThan(ids.length)
    expect(child.follow_up.node_ids).toEqual(ids.slice(ids.indexOf(child.follow_up.node_ids[0]!)))
    expect(child.follow_up.node_ids.every(id => !delivered.includes(id))).toBe(true)
    expect(new Set([...delivered, ...child.follow_up.node_ids])).toEqual(new Set(ids))
    // Packing and wire serialization have distinct budgets. Every owner dropped
    // by either boundary must survive in the returned child, in the same order.
    const seen = new Set(delivered)
    let cursor = next.handle_id
    for (let page = 0; cursor && page < ids.length; page++) {
      const before = new Set(f.state.contextPackHandles!.keys())
      const nextPage = await f.call({ handle_id: cursor, budget: 900 })
      const pageIds = nextPage.payload.pack.matched_nodes.map(node => node.node_id)
      expect(pageIds.length).toBeGreaterThan(0)
      expect(pageIds.every(id => ids.includes(id) && !seen.has(id)), JSON.stringify({ page, pageIds, seen: [...seen], cursor, stored: f.state.contextPackHandles!.get(cursor) })).toBe(true)
      pageIds.forEach(id => seen.add(id))
      const refs = (nextPage.payload.expandable ?? []) as Array<{ handle_id: string }>
      const advertised = new Set([...refs.map(ref => ref.handle_id), ...nextPage.payload.pack.matched_nodes
        .flatMap(node => typeof node.source_expand_handle === 'string' ? [node.source_expand_handle] : [])])
      expect([...f.state.contextPackHandles!.keys()].filter(id => !before.has(id)).every(id => advertised.has(id))).toBe(true)
      const childIds = refs.flatMap(ref => (f.state.contextPackHandles!.get(ref.handle_id) as { follow_up: { node_ids: string[] } }).follow_up.node_ids)
      expect(new Set([...seen, ...childIds])).toEqual(new Set(ids))
      cursor = refs[0]?.handle_id ?? ''
    }
    expect(seen).toEqual(new Set(ids))
    const expanded = await f.call({ handle_id: next.handle_id, budget: 900 })
    expect(expanded.payload.pack.matched_nodes[0]?.node_id).toBe(child.follow_up.node_ids[0])
    expect(expanded.payload.pack.matched_nodes.every(node => child.follow_up.node_ids.includes(node.node_id))).toBe(true)

    // A selector still names a verified owner within the authorized file scope.
    const selected = await f.call({ handle_id: 'queued', symbol: 'RecordBuilder.buildRecord', budget: 2000 })
    expect(selected.payload.pack.matched_nodes.map(node => node.node_id)).toEqual([f.target.id])
    stored.follow_up.node_ids = ['missing-owner']
    const missing = await f.response({ handle_id: 'queued', budget: 900 })
    expect(missing?.error?.message).toMatch(/no longer indexed|fresh context_pack/)
    expect(missing?.result).toBeUndefined()
    stored.follow_up.node_ids = [null]
    expect((await f.response({ handle_id: 'queued', budget: 900 }))?.error?.message).toMatch(/Malformed/)
  })

  it('removes an owner restored during serialization retries from the published generic child scope', async () => {
    const f = fixture(false, 40)
    const graph = JSON.parse(readFileSync(f.graphPath, 'utf8')) as { nodes: Array<{ id: string; label: string }> }
    const ids = graph.nodes.filter(node => /^queuedRecord\d+\(\)$/.test(node.label)).map(node => node.id).reverse()
    f.store('restoration', ['records.mjs'])
    const parent = f.state.contextPackHandles!.get('restoration') as { follow_up: RecordValue }
    parent.follow_up.node_ids = ids
    const serialize = sourceEvidenceResponses.finalizeSourceEvidenceResponse
    let restored: string | undefined
    // Deterministically model source completion restoring a previously omitted
    // owner on the next allocation attempt; actual packing and handle storage run.
    const serializer = vi.spyOn(sourceEvidenceResponses, 'finalizeSourceEvidenceResponse').mockImplementation((input, budget, options) => {
      const output = serialize(input, budget, options)
      const raw = input as { pack?: { matched_nodes?: SourceNode[] }; expandable?: Array<{ follow_up?: { node_ids?: string[] } }> }
      const result = output as Payload
      const visible = result.pack?.matched_nodes ?? []
      const queued = new Set((raw.expandable ?? []).flatMap(ref => ref.follow_up?.node_ids ?? []))
      const target = raw.pack?.matched_nodes?.find(node => restored ? node.node_id === restored
        : queued.has(node.node_id) && !visible.some(other => other.node_id === node.node_id))
      if (!target || !visible.length || visible.some(node => node.node_id === target.node_id)) return output
      restored = target.node_id
      return serialize({ ...output, pack: { ...result.pack,
        matched_nodes: [sourceEvidenceResponses.compactSourceEvidenceNode(target), ...visible.slice(0, -1)] } }, budget, { verbose: true })
    })
    const { payload } = await f.call({ handle_id: 'restoration', budget: 900 })
    serializer.mockRestore()
    expect(restored).toBeDefined()
    const delivered = payload.pack.matched_nodes.map(node => node.node_id)
    expect(delivered).toContain(restored)
    const refs = (payload.expandable ?? []) as Array<{ handle_id: string; count: number }>
    expect(refs.length).toBeGreaterThan(0)
    const remaining = refs.flatMap(ref => {
      const handle = f.state.contextPackHandles!.get(ref.handle_id) as { follow_up: { node_ids: string[] } }
      expect(ref.count).toBe(handle.follow_up.node_ids.length)
      expect(handle.follow_up.node_ids.some(id => delivered.includes(id))).toBe(false)
      return handle.follow_up.node_ids
    })
    expect(new Set([...delivered, ...remaining])).toEqual(new Set(ids))
    const next = await f.call({ handle_id: refs[0]!.handle_id, budget: 900 })
    expect(next.payload.pack.matched_nodes.every(node => !delivered.includes(node.node_id))).toBe(true)
  })

  it('rehydrates only advertised omission handles for owners removed by the final cached pack budget', async () => {
    const f = fixture(false, 24)
    const request = { prompt: `Explain how ${Array.from({ length: 24 }, (_, index) => `queuedRecord${index}`).join(', ')} build records.`, budget: 1200 }
    const pack = async () => {
      const response = await handleStdioRequest(f.graphPath, { id: 100, method: 'tools/call',
        params: { name: 'context_pack', arguments: request } }, f.state)
      expect(response?.error).toBeUndefined()
      const text = (response!.result as { content: Array<{ text: string }> }).content[0]!.text
      const payload = JSON.parse(text) as Payload
      expect(payload.serialized_budget).toEqual({ max_tokens: request.budget, token_count: estimateQueryTokens(text), enforced: true })
      expect(estimateQueryTokens(text)).toBeLessThanOrEqual(request.budget)
      return payload
    }
    const before = new Set(f.state.contextPackHandles!.keys())
    const cold = await pack()
    expect(cold.cache).toMatchObject({ status: 'miss' })
    const cached = JSON.parse([...f.state.contextPackCache!.values()][0]!) as { payload: Payload }
    const rawIds = cached.payload.pack.matched_nodes.map(node => node.node_id)
    const delivered = cold.pack.matched_nodes.map(node => node.node_id)
    expect(rawIds.filter(id => !delivered.includes(id)).length).toBeGreaterThan(0)
    const assertRecoverable = (payload: Payload) => {
      const refs = (payload.expandable ?? []) as Array<{ handle_id: string }>
      const accessible = refs.flatMap(ref => (f.state.contextPackHandles!.get(ref.handle_id) as { follow_up: { node_ids?: string[] } }).follow_up.node_ids ?? [])
      const retained = payload.pack.matched_nodes.map(node => node.node_id)
      expect(rawIds.every(id => retained.includes(id) || accessible.includes(id))).toBe(true)
      const advertised = new Set([...refs.map(ref => ref.handle_id), ...payload.pack.matched_nodes
        .flatMap(node => typeof node.source_expand_handle === 'string' ? [node.source_expand_handle] : [])])
      expect([...f.state.contextPackHandles!.keys()].filter(id => !before.has(id)).every(id => advertised.has(id))).toBe(true)
      return advertised
    }
    for (const id of assertRecoverable(cold)) f.state.contextPackHandles!.delete(id)
    const warm = await pack()
    expect(warm.cache).toMatchObject({ status: 'hit' })
    assertRecoverable(warm)
    expect(warm.pack.matched_nodes).toEqual(cold.pack.matched_nodes)
    expect(warm.expandable).toEqual(cold.expandable)
  })

  it('keeps filename exclusions scoped to source paths when expanding an allowed same-extension owner', async () => {
    const f = fixture()
    f.store('both-files', ['records.mjs', 'helpers.mjs'])
    const stored = f.state.contextPackHandles!.get('both-files')!
    if (typeof stored !== 'object' || !('prompt' in stored)) throw new Error('Expected stored context handle')
    stored.prompt = 'Explain the selected function. Do not read helpers.mjs.'
    const { payload } = await f.call({ handle_id: 'both-files', symbol: 'RecordBuilder.buildRecord', budget: 2000 })
    expect(payload.pack.matched_nodes).toHaveLength(1)
    expect(resolveSourceSnippet(payload.pack.matched_nodes[0]!, payload.pack.matched_nodes)).toContain('E_RECORD_NEGATIVE')
    const handles = structuredClone([...f.state.contextPackHandles!])
    const blocked = await f.response({ handle_id: 'both-files', symbol: 'outsideOnly', budget: 2000 })
    expect(blocked?.error?.message).toMatch(/symbol|scope|match|owner/i)
    expect(blocked?.result).toBeUndefined()
    expect([...f.state.contextPackHandles!]).toEqual(handles)
  })

  it('returns the exact complete scoped function under the wire cap while retaining partial task authority and default expansion', async () => {
    const f = fixture(), storedBefore = structuredClone(f.state.contextPackHandles!.get('records'))
    const defaults = await f.call({ handle_id: 'records', budget: 4000 })
    expect(defaults.payload.pack.matched_nodes.some(node => node.label.includes('unrelated'))).toBe(true)
    for (const symbol of ['  RecordBuilder.buildRecord()  ', 'buildRecord']) {
      const { payload } = await f.call({ handle_id: 'records', symbol, budget: 2000 })
      expect(payload.handle_id).toBe('records')
      expect(payload.task).toBe('explain')
      expect(payload.pack.matched_nodes).toHaveLength(1)
      const node = payload.pack.matched_nodes[0]!
      expect(node.node_id).toBe(f.target.id)
      expect(realpathSync(resolve(f.root, node.source_file))).toBe(realpathSync(join(f.root, 'records.mjs')))
      expect(node.snippet_scope).toBe('symbol')
      expect(node.snippet_line_range).toEqual(f.targetRange)
      expect(resolveSourceSnippet(node, payload.pack.matched_nodes)).toBe(f.source.slice(3, 8).join('\n'))
      expect(node.snippet_omitted_ranges ?? []).toEqual([])
      expect(node.snippet_truncated).not.toBe(true)
      expect(node.snippet_unverified).not.toBe(true)
      expect(payload.pack.relationships ?? []).toEqual([])
      expect(payload.evidence.answerability.advisory).toBe(true)
      expect(payload.evidence.answerability.state).not.toBe('ready')
      expect(payload.evidence.answerability.answer_scope).not.toBe('complete')
      expect(payload.evidence.answerability.missing_obligations).toEqual(expect.arrayContaining([expect.any(String)]))
    }
    expect(f.state.contextPackHandles!.get('records')).toEqual(storedBefore)
    expect((await f.call({ handle_id: 'records', budget: 4000 })).text).toBe(defaults.text)

    // A selected body that fits the entry estimate must still yield source when
    // its complete response exceeds the wire budget. Follow real stored pages.
    const long = fixture(true)
    long.store('long-record', ['long.mjs'])
    const stored = structuredClone(long.state.contextPackHandles!.get('long-record'))
    let page = await long.call({ handle_id: 'long-record', symbol: 'accumulateRecord', budget: 900 })
    const delivered = new Map<number, string>()
    for (let count = 0; count < 4; count++) {
      expect(page.payload.pack.matched_nodes).toHaveLength(1)
      const node = page.payload.pack.matched_nodes[0]!
      expect(node.label.replace(/\(\)$/, '')).toBe('accumulateRecord')
      expect(node.snippet_line_range).toEqual({ start_line: 1, end_line: 83 })
      const omitted = (node.snippet_omitted_ranges ?? []) as Range[]
      const actual = String(node.snippet).split('\n').filter(line => !/^\[omitted lines \d+-\d+\]$/.test(line))
      let cursor = 0
      for (let line = 1; line <= 83; line++) {
        if (omitted.some(range => range.start_line <= line && line <= range.end_line)) continue
        expect(delivered.has(line)).toBe(false)
        expect(actual[cursor]).toBe(long.longSource.split('\n')[line - 1])
        delivered.set(line, actual[cursor++]!)
      }
      expect(page.payload.evidence.answerability).toMatchObject({ advisory: true })
      expect(page.payload.evidence.answerability.state).not.toBe('ready')
      const handle = node.source_expand_handle
      if (!handle) break
      expect(long.state.contextPackHandles!.has(String(handle))).toBe(true)
      page = await long.call({ handle_id: handle, budget: 900 })
    }
    expect(delivered.size).toBe(83)
    expect(long.state.contextPackHandles!.get('long-record')).toEqual(stored)

  })

  it('rejects invalid, ambiguous, excluded, stale and non-concrete selectors without changing stored navigation', async () => {
    const f = fixture()
    const schema = activeMcpTools('strict').find(tool => tool.name === 'context_expand')!.inputSchema
    expect(Object.keys(schema.properties).sort()).toEqual(['budget', 'handle_id', 'symbol'])
    expect(schema.properties.symbol).toMatchObject({ type: 'string' })
    const refusal = async (args: RecordValue, code = -32602, message?: RegExp) => {
      const handles = structuredClone([...f.state.contextPackHandles!])
      const result = await f.response({ handle_id: 'records', budget: 2000, ...args })
      expect(result?.error?.code).toBe(code)
      if (message) expect(result?.error?.message).toMatch(message)
      expect(result?.result).toBeUndefined()
      expect([...f.state.contextPackHandles!]).toEqual(handles)
    }
    for (const symbol of ['', '   ', null, 7, ['buildRecord'], 'x'.repeat(513)]) await refusal({ symbol }, -32602, /symbol/i)
    await refusal({ symbol: 'buildRecord', unexpected: true }, -32602, /unsupported|unexpected|unknown/i)
    for (const symbol of ['missingRecord', 'buildrecord', 'OtherBuilder.buildRecord', 'outsideOnly', 'importedOnly', 'valueOnly']) {
      await refusal({ symbol }, -32602, /symbol|concrete|scope|match/i)
    }
    f.store('both-files', ['records.mjs', 'helpers.mjs'])
    await refusal({ handle_id: 'both-files', symbol: 'duplicated' }, -32602, /ambiguous|unique|multiple/i)
    f.store('overlap-only', ['records.mjs'], [{ source_file: 'records.mjs', start_line: 4, end_line: 4 }])
    await refusal({ handle_id: 'overlap-only', symbol: 'RecordBuilder.buildRecord' }, -32602, /symbol|scope|match/i)
    f.store('nested-only', ['scoped/records.mjs'])
    await refusal({ handle_id: 'nested-only', symbol: 'buildRecord' }, -32602, /symbol|scope|match/i)

    // Produce a genuine source cursor; selector support must not reinterpret its pending-range contract.
    const omitted = { start_line: 5, end_line: 7 }
    const continuationPayload: RecordValue = { task: 'explain', response_format: SOURCE_EVIDENCE_RESPONSE_FORMAT,
      pack: { matched_nodes: [{ node_id: f.target.id, label: f.target.label, source_file: 'records.mjs', snippet_scope: 'symbol',
        snippet_line_range: f.targetRange, snippet_omitted_ranges: [omitted], snippet_truncated: true,
        snippet: [f.source[3], '[omitted lines 5-7]', f.source[7]].join('\n') }] },
      evidence: { answerability: { advisory: true, state: 'insufficient', answer_scope: 'partial', broad_search_fallback: 'allowed' } },
      governance: { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } } }
    const handlesBefore = new Set(f.state.contextPackHandles!.keys())
    attachSourceContinuationHandles(continuationPayload, 2000, f.root, (id, handle) => f.state.contextPackHandles!.set(id, handle))
    const sourceHandle = [...f.state.contextPackHandles!.keys()].find(id => !handlesBefore.has(id))
    expect(sourceHandle).toMatch(/^source-expand:/)
    await refusal({ handle_id: sourceHandle, symbol: 'buildRecord' }, -32602, /symbol|source.*continuation/i)

    const path = join(f.root, 'records.mjs'), before = statSync(path)
    writeFileSync(path, f.source.join('\n').replace('value + 1', 'value + 2'))
    utimesSync(path, before.atime, new Date(before.mtimeMs + 2000))
    await refusal({ symbol: 'buildRecord' }, -32000, /stale|fresh|changed/i)
  })
})
