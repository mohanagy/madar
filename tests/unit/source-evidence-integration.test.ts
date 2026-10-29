import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'

const HANDLER = [
  'export function processRequest(record: { issuedAt: number; allowed: boolean }) {',
  '  recordSessionExpiredMetric(new Map());',
  '  if (!record.allowed) throw new Error("ACCESS_DENIED");',
  '  const elapsed = Date.now() - record.issuedAt;',
  '  if (elapsed > 900000) throw new Error("SESSION_EXPIRED");',
  '  return { status: 200 };',
  '}',
].join('\n')

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
})

function fixture(withCallers = false): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-source-integration-'))
  roots.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'handler.ts'), `import { recordSessionExpiredMetric } from './metrics.js';\n${HANDLER}`)
  writeFileSync(join(root, 'src', 'metrics.ts'), [
    'export function recordSessionExpiredMetric(counter: Map<string, number>) {',
    '  counter.set("expired", (counter.get("expired") ?? 0) + 1);',
    '}',
    'export function describeSessionExpiration() {',
    '  return "Historical count of expired sessions";',
    '}',
  ].join('\n'))
  if (withCallers) {
    writeFileSync(join(root, 'src', 'caller.ts'), [
      "import { processRequest } from './handler.js';",
      'export function invokeRequest() {',
      '  return processRequest({ issuedAt: Date.now(), allowed: true });',
      '}',
      'export function describeProcessRequest() {',
      '  return "processRequest logs are enabled";',
      '}',
    ].join('\n'))
  }
  return generateGraph(root, { noHtml: true }).graphPath
}

interface WirePack {
  response_format: string
  pack: { matched_nodes: Array<{ source_file: string; label: string; snippet?: string; snippet_ref?: string }> }
  evidence: { answerability: { advisory: boolean; broad_search_fallback: string } }
  serialized_budget: { token_count: number; max_tokens: number; enforced: boolean }
  expandable?: Array<{ handle_id: string; focus_files: string[] }>
  cache?: { status: string }
}

describe('source evidence through default indexing and MCP', () => {
  it('returns the actual throwing implementation despite similarly named metrics', async () => {
    vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
    const graphPath = fixture()
    const state = { logLevel: 'info' as const, subscribedResourceUris: new Set<string>(), resourceVersions: new Map<string, string>(), resourceListSignature: null }
    for (const [index, prompt] of [
      'Where is SESSION_EXPIRED thrown?',
      'Where is ACCESS_DENIED thrown?',
      'What does processRequest do?',
      'Where does code reject a session older than 15 minutes?',
    ].entries()) {
      const response = await handleStdioRequest(graphPath, {
        id: index + 1, method: 'tools/call',
        params: { name: 'context_pack', arguments: { prompt, task: 'explain', budget: 3000 } },
      }, state)
      expect(response?.error).toBeUndefined()
      const text = (response?.result as { content: Array<{ text: string }> }).content[0]!.text
      const payload = JSON.parse(text) as WirePack
      const evidence = payload.pack.matched_nodes.filter(node => node.source_file.replaceAll('\\', '/').endsWith('/handler.ts'))
      expect(evidence.length).toBeGreaterThan(0)
      expect(evidence.map(node => node.snippet ?? '').join('\n')).toContain(HANDLER)
      expect(payload.evidence.answerability).toMatchObject({ advisory: true, broad_search_fallback: 'allowed' })
      expect(payload.serialized_budget).toMatchObject({ max_tokens: 3000, enforced: true, token_count: estimateQueryTokens(text) })
      expect(estimateQueryTokens(text)).toBeLessThanOrEqual(3000)
    }
    const prompt = 'Explain how issuedAt and elapsed determine SESSION_EXPIRED, and how allowed controls ACCESS_DENIED. Include the runtime decisions.'
    let recoveryHandle: string | undefined
    for (const id of [10, 11]) {
      const response = await handleStdioRequest(graphPath, {
        id, method: 'tools/call', params: { name: 'context_pack', arguments: { prompt, task: 'explain', budget: 3000 } },
      }, state)
      expect(response?.error).toBeUndefined()
      const text = (response?.result as { content: Array<{ text: string }> }).content[0]!.text
      const payload = JSON.parse(text) as WirePack
      const snippets = payload.pack.matched_nodes.map(node => node.snippet ?? '').join('\n')
      expect(snippets).toContain(HANDLER)
      expect(snippets).not.toContain('counter.set("expired"')
      expect(payload.pack.matched_nodes.every(node => node.snippet || node.snippet_ref)).toBe(true)
      expect(payload.evidence.answerability).toMatchObject({ state: 'insufficient', answer_scope: 'partial', advisory: true })
      expect(payload.serialized_budget.token_count).toBe(estimateQueryTokens(text))
      recoveryHandle = payload.expandable?.find(entry => entry.focus_files.some(path => path.endsWith('metrics.ts')))?.handle_id
      expect(recoveryHandle).toBeTruthy()
      if (id === 11) expect(payload.cache?.status).toBe('hit')
    }
    const expansion = await handleStdioRequest(graphPath, {
      id: 12, method: 'tools/call', params: { name: 'context_expand', arguments: { handle_id: recoveryHandle, symbol: 'recordSessionExpiredMetric', budget: 2000 } },
    }, state)
    expect(expansion?.error).toBeUndefined()
    const text = (expansion?.result as { content: Array<{ text: string }> }).content[0]!.text
    const recovered = JSON.parse(text) as WirePack
    expect(recovered.pack.matched_nodes.map(node => node.snippet ?? '').join('\n')).toContain('counter.set("expired"')
    expect(recovered.serialized_budget).toMatchObject({ max_tokens: 2000, token_count: estimateQueryTokens(text), enforced: true })
  })
})


describe('focused symbol evidence', () => {
  it('returns the named declaration without caller bodies or textual mentions', async () => {
    vi.stubEnv('MADAR_TOOL_PROFILE', 'full')
    const graphPath = fixture(true)
    const state = { logLevel: 'info' as const, subscribedResourceUris: new Set<string>(), resourceVersions: new Map<string, string>(), resourceListSignature: null }
    const response = await handleStdioRequest(graphPath, {
      id: 1, method: 'tools/call',
      params: { name: 'context_pack', arguments: { prompt: 'What does processRequest do?', task: 'explain', budget: 3000 } },
    }, state)
    expect(response?.error).toBeUndefined()
    const text = (response?.result as { content: Array<{ text: string }> }).content[0]!.text
    const payload = JSON.parse(text) as WirePack
    expect(payload.pack.matched_nodes).toHaveLength(1)
    expect(payload.pack.matched_nodes[0]?.snippet).toBe(HANDLER)
    expect(payload.pack.matched_nodes[0]?.source_file).toMatch(/handler\.ts$/)
    expect(payload.serialized_budget.token_count).toBe(estimateQueryTokens(text))
  })
})
