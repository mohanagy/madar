import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { resolveSourceSnippet } from '../../src/runtime/source-evidence-response.js'

let root = '', graphPath = '', previousProfile: string | undefined
let state: Parameters<typeof handleStdioRequest>[2]
let requestId = 0
function source(returnValue: string) {
  return `export function resetToken(token: string) {\n  return ${returnValue};\n}\n\nexport function expireToken() {\n  return false;\n}\n`
}
async function call(name: string, args: Record<string, unknown>) {
  const response = await handleStdioRequest(graphPath, { id: ++requestId, method: 'tools/call', params: { name, arguments: args } }, state)
  const text = (response?.result as { content: Array<{ text: string }> } | undefined)?.content[0]?.text
  if (!text) throw new Error(JSON.stringify(response))
  return { payload: JSON.parse(text), text }
}
beforeEach(() => {
  previousProfile = process.env.MADAR_TOOL_PROFILE
  process.env.MADAR_TOOL_PROFILE = 'full'
  root = mkdtempSync(join(tmpdir(), 'madar-source-wire-'))
  mkdirSync(join(root, 'out'))
  graphPath = join(root, 'out', 'graph.json')
  writeFileSync(join(root, 'reset.ts'), source('token.length > 0'))
  writeFileSync(graphPath, JSON.stringify({ directed: true, root_path: root, nodes: [
    { id: 'reset', label: 'resetToken', source_file: join(root, 'reset.ts'), source_location: 'L1-L3', file_type: 'code', node_kind: 'function', community: 0 },
    { id: 'expire', label: 'expireToken', source_file: join(root, 'reset.ts'), source_location: 'L5-L7', file_type: 'code', node_kind: 'function', community: 0 },
  ], edges: [{ source: 'reset', target: 'expire', relation: 'calls' }], hyperedges: [] }))
  state = { logLevel: 'info', subscribedResourceUris: new Set(), resourceVersions: new Map(), resourceListSignature: null }
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  if (previousProfile === undefined) delete process.env.MADAR_TOOL_PROFILE
  else process.env.MADAR_TOOL_PROFILE = previousProfile
})

describe('MCP source evidence final boundary', () => {
  it('routes named source review to both clean helpers without treating a diff filename as Git intent', async () => {
    const receipt = 'export function sealReceipt(amount: number) {\n  return amount.toFixed(2);\n}\nexport function isRetryable(status: number) {\n  return status === 429 || status === 503;\n}\n'
    writeFileSync(join(root, 'diff.ts'), receipt)
    writeFileSync(graphPath, JSON.stringify({ directed: true, root_path: root, nodes: [
      { id: 'seal', label: 'sealReceipt()', source_file: 'diff.ts', source_location: 'L1-L3', file_type: 'code' },
      { id: 'retry', label: 'isRetryable()', source_file: 'diff.ts', source_location: 'L4-L6', file_type: 'code' },
    ], edges: [], hyperedges: [] }))
    for (const location of [' in diff.ts', '']) {
      const result = await call('context_pack', {
        prompt: `Review sealReceipt together with isRetryable${location}: show how the amount is formatted and which status values allow another attempt.`,
        task: 'review', budget: 4000, resolution: 'detail', retrieval_strategy: 'default',
      })
      expect(result.payload.task).toBe('review')
      expect(result.payload.task_intent).toBe('source-review')
      expect(result.payload.evidence.answerability.missing_obligations ?? []).not.toEqual(expect.arrayContaining(['evidence:change']))
      for (const obligation of ['evidence:supporting', 'evidence:impact', 'semantic:changes', 'semantic:impact']) {
        expect(result.payload.evidence.answerability.missing_obligations ?? []).not.toContain(obligation)
      }
      const nodes = result.payload.pack.matched_nodes as Record<string, unknown>[]
      const excerpts = nodes.map(node => resolveSourceSnippet(node, nodes) ?? '').join('\n')
      expect(excerpts).toContain('return amount.toFixed(2);')
      expect(excerpts).toContain('return status === 429 || status === 503;')
      expect(result.payload.pack).not.toHaveProperty('changed_files')
    }
  })

  it('keeps file-qualified current-change reviews on the Git route and preserves its restrictions', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    execFileSync('git', ['add', 'reset.ts'], { cwd: root })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial source'], { cwd: root })
    writeFileSync(join(root, 'reset.ts'), source('token.length > 1'))
    const args = { prompt: 'Review current changes in reset.ts.', task: 'review', budget: 4000 }
    const result = await call('context_pack', args)
    expect(result.payload.task).toBe('review')
    expect(result.payload.pack.changed_files).toContain('reset.ts')
    expect(result.payload.pack).toHaveProperty('review_bundle')
    expect(result.payload.task_intent).toBe('review')
    expect(result.payload.evidence.answerability.missing_obligations ?? []).toContain('evidence:impact')
    const restricted = await handleStdioRequest(graphPath, { id: ++requestId, method: 'tools/call',
      params: { name: 'context_pack', arguments: { ...args, resolution: 'detail' } } }, state)
    expect(restricted?.error?.message).toContain('resolution is only supported')
  })

  it('preserves requested source-review evidence gaps through a focused continuation', async () => {
    const prompt = 'Review resetToken in reset.ts, including its tests, dependencies and downstream impact.'
    const result = await call('context_pack', { prompt, task: 'review', budget: 5000 })
    expect(result.payload.task_intent).toBe('source-review')
    expect(result.payload.evidence.answerability.missing_obligations).toEqual(expect.arrayContaining([
      'semantic:tests', 'evidence:impact', 'semantic:impact',
    ]))
    // Continue with the actual routed intent, as persisted by owned handles.
    const handles = state!.contextPackHandles as Map<string, { prompt: string; task_intent: string }>
    const stored = [...handles.values()].filter(handle => handle.prompt === prompt)
    expect(stored.length).toBeGreaterThan(0)
    expect(stored.every(handle => handle.task_intent === 'source-review')).toBe(true)
    const handleId = [...handles.entries()].find(([, handle]) => handle.prompt === prompt)![0]
    const expanded = await call('context_expand', { handle_id: handleId, budget: 5000 })
    expect(expanded.payload.task_intent).toBe('source-review')
    expect(expanded.payload.evidence.answerability.missing_obligations).toEqual(expect.arrayContaining([
      'semantic:tests', 'evidence:impact', 'semantic:impact',
    ]))
    expect(expanded.payload.evidence.answerability.missing_obligations).not.toContain('evidence:change')
    expect(expanded.payload.evidence.answerability.missing_obligations).not.toContain('semantic:changes')
  })

  it('retains source evidence when a full task prompt prohibits unrelated agent actions', async () => {
    const workspace = join(root, 'workspace')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    const code = 'export function computeTotal(price: number, quantity: number): number {\n  return price * quantity;\n}\n'
    writeFileSync(join(workspace, 'src', 'compute.ts'), code)
    graphPath = generateGraph(workspace, { noHtml: true, includeDocs: false, docs: false, extractionMode: 'auto' }).graphPath
    const prompt = [
      'Answer the repository question using only source, tests, configuration and root README in the working directory.',
      'Do not read outside this workspace, browse the web, change files, invoke another agent/model, or inspect evaluation artifacts.',
      'Use available tools as useful. Return the requested JSON answers with precise workspace-relative source citations.',
      'Call Madar context_pack to inspect computeTotal. Answer id operation with its arithmetic operation; cite source.',
    ].join('\n\n')
    const result = await call('context_pack', { prompt, task: 'explain', budget: 2000 })
    const nodes = result.payload.pack.matched_nodes as Array<{ node_id: string; label: string; snippet?: string; snippet_ref?: string }>
    const symbol = nodes.find(node => node.label === 'computeTotal()')
    expect(symbol).toEqual(expect.objectContaining({ snippet_line_range: { start_line: 1, end_line: 3 } }))
    const excerpt = symbol?.snippet ?? nodes.find(node => node.node_id === symbol?.snippet_ref)?.snippet
    expect(excerpt?.trimEnd()).toBe(code.trimEnd())
    expect(estimateQueryTokens(result.text)).toBeLessThanOrEqual(2000)
  })

  it.each(['explain', 'implement', 'impact'])('enforces the final %s budget and counts all serialized fields', async task => {
    const result = await call('context_pack', { prompt: 'Explain resetToken and expireToken', task, budget: 500 })
    expect(estimateQueryTokens(result.text)).toBeLessThanOrEqual(500)
    expect(result.payload.serialized_budget).toEqual({ max_tokens: 500, token_count: estimateQueryTokens(result.text), enforced: true })
  })

  it('recounts cache-hit metadata before enforcing the same cap', async () => {
    const args = { prompt: 'Explain resetToken', task: 'explain', budget: 1500 }
    await call('context_pack', args)
    const hit = await call('context_pack', args)
    expect(hit.payload.cache.status).toBe('hit')
    expect(hit.payload.serialized_budget.token_count).toBe(estimateQueryTokens(hit.text))
    expect(estimateQueryTokens(hit.text)).toBeLessThanOrEqual(1500)
  })

  it('deduplicates repeated source, resends changed content, and resets explicitly', async () => {
    const args = { prompt: 'Explain `resetToken`', task: 'explain', budget: 2000, delta_session_id: 'same-conversation' }
    const first = await call('context_pack', args)
    expect(first.payload.pack.matched_nodes.length).toBeGreaterThan(0)
    const again = await call('context_pack', args)
    expect(again.payload.pack.matched_nodes).toEqual([])
    expect(estimateQueryTokens(again.text)).toBeLessThan(estimateQueryTokens(first.text))
    writeFileSync(join(root, 'reset.ts'), source('false'))
    const changed = await call('context_pack', args)
    expect(changed.payload.pack.matched_nodes.some((node: { snippet?: string }) => node.snippet?.includes('return false'))).toBe(true)
    expect(changed.payload.serialized_budget.token_count).toBe(estimateQueryTokens(changed.text))
    await call('context_pack_session_reset', { delta_session_id: 'same-conversation' })
    const reset = await call('context_pack', args)
    expect(reset.payload.pack.matched_nodes.length).toBeGreaterThan(0)
    expect(reset.payload.delta_applied).toBe(false)
  })

  it.each(['signature', 'sketch'])('deduplicates the delivered %s representation without suppressing original source', async resolution => {
    const args = { prompt: 'Explain resetToken and expireToken', task: 'explain', budget: 2000,
      delta_session_id: `compressed-${resolution}`, resolution }
    const first = await call('context_pack', args)
    expect(first.payload.pack.matched_nodes.length).toBeGreaterThan(0)
    expect(first.payload.pack.matched_nodes.every((node: { snippet_source?: string }) => node.snippet_source === 'derived')).toBe(true)
    const repeated = await call('context_pack', args)
    expect(repeated.payload.pack.matched_nodes).toEqual([])
    expect(estimateQueryTokens(repeated.text)).toBeLessThan(estimateQueryTokens(first.text))

    const detail = await call('context_pack', { ...args, resolution: 'detail' })
    expect(detail.payload.pack.matched_nodes.some((node: { snippet?: string }) => node.snippet?.includes('return token.length > 0'))).toBe(true)
    expect((await call('context_pack', { ...args, resolution: 'detail' })).payload.pack.matched_nodes).toEqual([])

    const reverse = { ...args, delta_session_id: `detail-first-${resolution}` }
    await call('context_pack', { ...reverse, resolution: 'detail' })
    expect((await call('context_pack', reverse)).payload.pack.matched_nodes.length).toBeGreaterThan(0)
  })


  it('counts the final focused-expansion payload and permits repeated owned handles', async () => {
    state!.contextPackHandles = new Map([['focus', { prompt: 'Explain resetToken', task: 'explain', task_intent: 'explain',
      follow_up: { kind: 'context_pack', task_kind: 'explain', evidence_class: 'primary', focus_files: ['reset.ts'], focus_ranges: [] } }]])
    const first = await call('context_expand', { handle_id: 'focus', budget: 500 })
    const second = await call('context_expand', { handle_id: 'focus', budget: 500 })
    for (const result of [first, second]) {
      expect(estimateQueryTokens(result.text)).toBeLessThanOrEqual(500)
      expect(result.payload.serialized_budget.token_count).toBe(estimateQueryTokens(result.text))
    }
  })

  it('expands the composition body of a default-indexed file node without node_kind', async () => {
    writeFileSync(join(root, 'dependency.ts'), 'export function createService(config: { expiry: number }) { return config; }\n')
    const appSource = [
      "import { createService } from './dependency.js';",
      '',
      'const service = createService({ expiry: 900000 });',
      '',
      'export function application() { return service; }',
      '',
    ].join('\n')
    writeFileSync(join(root, 'app.ts'), appSource)
    graphPath = generateGraph(root, { noHtml: true }).graphPath
    const generated = JSON.parse(readFileSync(graphPath, 'utf8')) as { nodes: Array<{ label: string; node_kind?: string }> }
    expect(generated.nodes.find(node => node.label === 'app.ts')?.node_kind).toBeUndefined()
    state!.contextPackHandles = new Map([['composition', { prompt: 'Show how the application service is configured', task: 'explain', task_intent: 'explain',
      follow_up: { kind: 'context_pack', task_kind: 'explain', evidence_class: 'primary', focus_files: ['app.ts'], focus_ranges: [] } }]])
    const result = await call('context_expand', { handle_id: 'composition', budget: 2000 })
    const file = result.payload.pack.matched_nodes.find((node: { label: string }) => node.label === 'app.ts')
    expect(file.snippet_scope).toBe('source_file')
    expect(file.snippet).toBe(appSource)
    expect(file.snippet_line_range).toEqual({ start_line: 1, end_line: 6 })
    expect(result.payload.serialized_budget.token_count).toBe(estimateQueryTokens(result.text))
    expect(estimateQueryTokens(result.text)).toBeLessThanOrEqual(2000)
  })

  it('invalidates delta receipts when the graph generation changes', async () => {
    const args = { prompt: 'Explain `resetToken`', task: 'explain', budget: 2000, delta_session_id: 'refresh' }
    await call('context_pack', args)
    expect((await call('context_pack', args)).payload.pack.matched_nodes).toEqual([])
    const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
    graph.generation_marker = 'new-generation'
    writeFileSync(graphPath, JSON.stringify(graph))
    const refreshed = await call('context_pack', args)
    expect(refreshed.payload.pack.matched_nodes.length).toBeGreaterThan(0)
    expect(refreshed.payload.delta_applied).toBe(false)
  })
  it('rejects an impossible budget before returning a success payload', async () => {
    const response = await handleStdioRequest(graphPath, { id: 1, method: 'tools/call', params: { name: 'context_pack', arguments: { prompt: 'reset', budget: 1 } } }, state)
    expect(response?.error?.message).toContain('128')
  })
})
