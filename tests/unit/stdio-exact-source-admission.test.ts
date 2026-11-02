import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { activeMcpTools, experimentalExactSourceOnly, resolveToolProfileFromEnv } from '../../src/runtime/stdio/definitions.js'

let root: string, graph: string
let state: Parameters<typeof handleStdioRequest>[2]
let id = 0
beforeEach(() => {
  vi.stubEnv('MADAR_EXPERIMENTAL_EXACT_SOURCE_ONLY', '1')
  vi.stubEnv('MADAR_TOOL_PROFILE', 'full')
  root = mkdtempSync(join(tmpdir(), 'madar-exact-admission-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/queue.ts'), [
    'export function processQueue(count: number) {',
    ...Array.from({length: 120}, (_, i) => `  count = (count + ${i}) % 65521;`),
    '  return count;', '}',
  ].join('\n'))
  graph = generateGraph(root, { noHtml: true, includeDocs: false }).graphPath
  state = { logLevel: 'info', subscribedResourceUris: new Set(), resourceVersions: new Map(), resourceListSignature: null }
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, {recursive: true, force: true}) })

const request = (name: string, args: object, session = state) => handleStdioRequest(graph,
  {id: ++id, method: 'tools/call', params: {name, arguments: args}}, session)
const payload = (response: Awaited<ReturnType<typeof handleStdioRequest>>) => {
  expect(response?.error).toBeUndefined()
  const result = response!.result as {isError?: boolean; content: Array<{text: string}>}
  expect(result.isError).not.toBe(true)
  return JSON.parse(result.content[0]!.text)
}

describe('experimental exact-source admission at the tool boundary', () => {
  it('advertises required targets, blocks discovery and graph bypasses, and leaves flag-off profiles intact', async () => {
    expect(resolveToolProfileFromEnv()).toBe('strict')
    const tools = activeMcpTools('full', {exactSourceOnly: true})
    expect(tools.map(t => t.name)).toEqual(['context_pack', 'context_expand'])
    expect(tools[0]!.inputSchema.required).toContain('targets')
    expect(tools[1]!.inputSchema.properties).not.toHaveProperty('symbol')
    expect((await request('context_pack', {prompt: 'How does queue processing work?'}))?.error?.code).toBe(-32602)
    expect((await request('context_pack', {prompt: 'Exact source function processQueue in src/queue.ts'}))?.error?.code).toBe(-32602)
    expect((await request('retrieve', {query: 'queue'}))?.error?.code).toBe(-32601)
    expect((await handleStdioRequest(graph, {id: ++id, method: 'query', params: {query: 'queue'}}, state))?.error?.code).toBe(-32601)
    vi.stubEnv('MADAR_EXPERIMENTAL_EXACT_SOURCE_ONLY', '0')
    expect(experimentalExactSourceOnly()).toBe(false)
    expect(resolveToolProfileFromEnv()).toBe('full')
    expect(activeMcpTools('strict')[0]!.inputSchema.required).not.toContain('targets')
  })

  it('delivers exact source and permits its source continuation only in the issuing session', async () => {
    const first = payload(await request('context_pack', {prompt: 'Read queue source', targets: [{file: 'src/queue.ts', symbol: 'processQueue'}], budget: 1000}))
    const node = first.pack.matched_nodes.find((n: {label: string}) => n.label === 'processQueue()')
    expect(node).toBeTruthy()
    const handle = node.source_expand_handle
    expect(handle).toBeTruthy()
    expect((await request('context_expand', {handle_id: handle, symbol: 'processQueue'}))?.error?.code).toBe(-32602)
    expect((await request('context_expand', {handle_id: handle}, {logLevel: 'info', subscribedResourceUris: new Set(), resourceVersions: new Map(), resourceListSignature: null}))?.error?.code).toBe(-32602)
    const expanded = payload(await request('context_expand', {handle_id: handle, budget: 1000}))
    expect(expanded.pack.matched_nodes.length).toBeGreaterThan(0)
    const next = expanded.pack.matched_nodes[0]?.source_expand_handle
    expect(next).toBeTruthy()
    payload(await request('context_expand', {handle_id: next, budget: 1000}))
  })

  it('rejects prior discovery handles and applies the existing target and source validation', async () => {
    vi.stubEnv('MADAR_EXPERIMENTAL_EXACT_SOURCE_ONLY', '0')
    const prior = payload(await request('context_pack', {prompt: 'processQueue processing count', budget: 1000}))
    expect(state?.contextPackHandles?.size).toBeGreaterThan(0)
    const ids = [...state!.contextPackHandles!.keys()]
    vi.stubEnv('MADAR_EXPERIMENTAL_EXACT_SOURCE_ONLY', '1')
    for (const handle_id of ids) expect((await request('context_expand', {handle_id}))?.error?.code).toBe(-32602)
    expect((await request('context_pack', {prompt: 'Read', targets: [{file: 'src/queue.ts', symbol: 'missing'}]}))?.error?.code).toBe(-32602)
    expect((await request('context_pack', {prompt: 'Read', task: 'review', targets: [{file: 'src/queue.ts', symbol: 'processQueue'}]}))?.error?.code).toBe(-32602)
    expect((await request('context_pack', {prompt: 'Read', targets: [{file: '../queue.ts', symbol: 'processQueue'}]}))?.error?.code).toBe(-32602)
    expect(prior).toBeTruthy()
  })
})
