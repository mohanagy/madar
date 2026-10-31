import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import * as continuations from '../../src/runtime/source-continuation.js'

const roots: string[] = []
beforeEach(() => { vi.stubEnv('MADAR_TOOL_PROFILE', 'strict') })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(largeCount = 1, smallSource = 'export function small() {\n  return "available witness";\n}\n') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-owned-expansion-')))
  roots.push(root)
  mkdirSync(join(root, 'out'))
  const graphPath = join(root, 'out', 'graph.json'), nodes: Record<string, unknown>[] = []
  for (let index = 0; index < largeCount; index++) {
    const text = `export const Large${index} = {\n${Array.from({ length: 70 }, (_, n) =>
      `  item${n}: '${Array.from({ length: 90 }, (_, j) => `word${n}_${j}`).join(' ')}',`).join('\n')}\n}\n`
    writeFileSync(join(root, `large${index}.ts`), text)
    nodes.push({ id: `large${index}`, label: `Large${index}`, source_file: `large${index}.ts`, source_location: 'L1-L72', file_type: 'code', node_kind: 'constant', community: 0 })
  }
  writeFileSync(join(root, 'small.ts'), smallSource)
  nodes.push({ id: 'small', label: 'small()', source_file: 'small.ts', source_location: `L1-L${smallSource.trimEnd().split('\n').length}`, file_type: 'code', node_kind: 'function', community: 0 })
  writeFileSync(graphPath, JSON.stringify({ directed: true, root_path: root, nodes, edges: [], hyperedges: [] }))
  const stored = { prompt: 'Explain the available witness and remaining source.', task: 'explain', task_intent: 'explain',
    follow_up: { kind: 'context_pack', task_kind: 'explain', evidence_class: 'primary',
      node_ids: nodes.map(node => node.id), focus_files: nodes.map(node => node.source_file), focus_ranges: [] } }
  const handles = new Map<string, unknown>([['owned', stored]])
  const state = { logLevel: 'info' as const, subscribedResourceUris: new Set<string>(), resourceVersions: new Map<string, string>(),
    resourceListSignature: null, contextPackHandles: handles }
  const call = async (budget: number, handle = 'owned') => {
    const response = await handleStdioRequest(graphPath, { id: 1, method: 'tools/call',
      params: { name: 'context_expand', arguments: { handle_id: handle, budget } } }, state)
    const text = (response?.result as { content: { text: string }[] } | undefined)?.content[0]?.text
    if (!text) throw new Error(JSON.stringify(response))
    return { payload: JSON.parse(text), text }
  }
  return { root, graphPath, nodes, stored, handles, call }
}

describe('owned generic expansion allocation', () => {
  it('refuses source allocation after a real source mutation without publishing trial handles', async () => {
    const f = fixture(), before = JSON.stringify([...f.handles])
    const file = join(f.root, 'small.ts')
    writeFileSync(file, readFileSync(file, 'utf8').replace('available witness', 'modified witness'))
    const changed = new Date(Date.now() + 60_000)
    utimesSync(file, changed, changed)
    await expect(f.call(1500)).rejects.toThrow(/source freshness could not be verified/)
    expect(JSON.stringify([...f.handles])).toBe(before)
  })

  it('delivers a smaller admitted owner behind oversized source and preserves skipped scope', async () => {
    const f = fixture(), before = JSON.stringify(f.stored)
    const result = await f.call(1500)
    expect(result.payload.pack.matched_nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ node_id: 'small', snippet: expect.stringContaining('available witness') }),
    ]))
    expect(estimateQueryTokens(result.text)).toBeLessThanOrEqual(1500)
    expect(result.payload.serialized_budget.token_count).toBe(estimateQueryTokens(result.text))
    const next = result.payload.expandable.find((entry: { handle_id: string }) => entry.handle_id !== 'owned')
    expect(next).toBeDefined()
    expect(f.handles.get(next.handle_id)).toMatchObject({ follow_up: { node_ids: ['large0'] } })
    expect(JSON.stringify(f.handles.get('owned'))).toBe(before)
    expect((await f.call(1500)).payload.pack.matched_nodes[0].node_id).toBe('small')
  })

  it('skips metadata within the original retry window while retaining its owned scope', async () => {
    const f = fixture()
    f.nodes.unshift({ id: 'metadata', label: 'Metadata', source_file: '/src/metadata.ts', source_location: 'L1', file_type: 'code', community: 0 })
    f.stored.follow_up.node_ids.unshift('metadata')
    f.stored.follow_up.focus_files.unshift('/src/metadata.ts')
    writeFileSync(f.graphPath, JSON.stringify({ directed: true, root_path: f.root, nodes: f.nodes, edges: [], hyperedges: [] }))
    const before = JSON.stringify(f.stored), result = await f.call(1500)
    expect(result.payload.pack.matched_nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ node_id: 'small', snippet: expect.stringContaining('available witness') }),
    ]))
    const next = result.payload.expandable.find((entry: { handle_id: string }) => entry.handle_id !== 'owned')
    expect(f.handles.get(next.handle_id)).toMatchObject({ follow_up: { node_ids: ['metadata', 'large0'] } })
    expect(JSON.stringify(f.handles.get('owned'))).toBe(before)
    expect(estimateQueryTokens(result.text)).toBeLessThanOrEqual(1500)
  })

  it('stops after four unfit entries and retains original retry navigation even at minimum budget', async () => {
    const f = fixture(4), before = JSON.stringify(f.stored)
    const originalHandle = 'expand:explain:primary:e4cd78779edd'
    f.handles.delete('owned'); f.handles.set(originalHandle, f.stored)
    for (const budget of [1500, 128]) {
      const result = await f.call(budget, originalHandle)
      expect(result.payload.expansion_status).toBe('budget_insufficient')
      expect(result.payload.handle_id).toBe(originalHandle)
      expect(result.payload.expandable).toEqual([{ handle_id: originalHandle }])
      expect(result.payload.pack?.matched_nodes ?? []).toEqual([])
      expect(result.payload.evidence.answerability.broad_search_fallback).toBe('allowed')
      expect(estimateQueryTokens(result.text)).toBeLessThanOrEqual(budget)
      expect([...f.handles.keys()]).toEqual([originalHandle])
      expect(JSON.stringify(f.handles.get(originalHandle))).toBe(before)
    }
    expect((await f.call(24000, originalHandle)).payload.pack.matched_nodes.length).toBeGreaterThan(0)
    expect(readFileSync(join(f.root, 'small.ts'), 'utf8')).toContain('available witness')
  })

  it('keeps a delivered partial owner in the original scope when no usable source cursor is advertised', async () => {
    // Model navigation that cannot be attached; source materialization and
    // current owner/hash verification still run through the real boundary.
    vi.spyOn(continuations, 'attachSourceContinuationHandles').mockImplementation(payload => payload)
    const source = `export function small() {\n${Array.from({ length: 160 }, (_, n) => `  const part${n} = ${n};`).join('\n')}\n  return "available witness";\n}\n`
    const f = fixture(1, source), before = JSON.stringify(f.stored)
    const result = await f.call(1500)
    const node = result.payload.pack.matched_nodes.find((entry: { node_id: string }) => entry.node_id === 'small')
    expect(node.snippet).toContain('available witness')
    expect(node.snippet_omitted_ranges.length).toBeGreaterThan(0)
    expect(node).not.toHaveProperty('source_expand_handle')
    expect(result.payload.expandable).toEqual(expect.arrayContaining([expect.objectContaining({ handle_id: 'owned' })]))
    expect(JSON.stringify(f.handles.get('owned'))).toBe(before)
    expect([...f.handles.keys()]).toEqual(['owned'])
    expect(estimateQueryTokens(result.text)).toBeLessThanOrEqual(1500)
  })
})
