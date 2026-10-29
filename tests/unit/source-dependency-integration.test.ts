import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { resolveSourceSnippet } from '../../src/runtime/source-evidence-response.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'

const fixtureSources = JSON.parse(readFileSync(new URL('../fixtures/source-evidence-dependencies.json', import.meta.url), 'utf8')) as {
  injected: Record<string, string>
  medium: Record<string, string>
  abstract: Record<string, string>
  body: Record<string, string>
}
const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
})

function graphFixture(files: Record<string, string>, distractors = 0): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-dependency-integration-'))
  roots.push(root)
  for (const [path, source] of Object.entries(files)) {
    const fullPath = join(root, path)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, source)
  }
  for (let index = 0; index < distractors; index += 1) {
    const path = join(root, `src/features/feature-${index}.ts`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `export function normalizeFeature${index}(id: string) { return id.trim().toLowerCase(); }`)
  }
  return generateGraph(root, { noHtml: true }).graphPath
}

interface WirePayload {
  pack: {
    matched_nodes: Array<Record<string, unknown>>
    source_dependencies?: {
      unresolved_calls: number
      unresolved?: Array<{ callee: string; reason: string }>
      unresolved_groups?: Array<{ source_file: string; reason: string; calls: Array<{ callee: string }> }>
    }
  }
  serialized_budget: { token_count: number; max_tokens: number; enforced: boolean }
}
async function request(graph: string, prompt: string, task = 'explain'): Promise<{ payload: WirePayload; source: string }> {
  vi.stubEnv('MADAR_TOOL_PROFILE', 'full')
  const state = { logLevel: 'info' as const, subscribedResourceUris: new Set<string>(), resourceVersions: new Map<string, string>(), resourceListSignature: null }
  const response = await handleStdioRequest(graph, {
    id: 1, method: 'tools/call', params: { name: 'context_pack', arguments: { prompt, task, budget: 3000 } },
  }, state)
  expect(response?.error).toBeUndefined()
  const text = (response?.result as { content: Array<{ text: string }> }).content[0]!.text
  const payload = JSON.parse(text) as WirePayload
  expect(payload.serialized_budget).toEqual({ max_tokens: 3000, enforced: true, token_count: estimateQueryTokens(text) })
  expect(estimateQueryTokens(text)).toBeLessThanOrEqual(3000)
  const nodes = payload.pack.matched_nodes
  return { payload, source: nodes.map(node => resolveSourceSnippet(node, nodes) ?? '').join('\n') }
}

describe('source dependency evidence through default indexing and MCP', () => {
  it('emits actual constructed method bindings and unresolved parameter dispatch through strict MCP', async () => {
    const graph = graphFixture({
      'base.ts': 'export class BasePort {\n  deliver() { return "BASE_IMPLEMENTATION"; }\n}',
      'derived.ts': "import { BasePort } from './base.js';\nexport class DerivedPort extends BasePort {\n  override deliver() { return 'DERIVED_IMPLEMENTATION'; }\n}",
      'dispatch.ts': "import { BasePort } from './base.js';\nimport { DerivedPort } from './derived.js';\nexport function dispatchFromWidenedLocal() {\n  const port: BasePort = new DerivedPort();\n  return port.deliver();\n}\nexport function dispatchFromParameter(port: BasePort) {\n  return port.deliver();\n}",
    })
    vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
    for (const name of ['dispatchFromWidenedLocal', 'dispatchFromParameter']) {
      const response = await handleStdioRequest(graph, { id: 1, method: 'tools/call', params: { name: 'context_pack', arguments: {
        prompt: `Explain ${name} and the actual implementation of port.deliver it invokes.`, task: 'explain', budget: 3000,
      } } })
      expect(response?.error).toBeUndefined()
      const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]!.text)
      const nodes = payload.pack.matched_nodes as Array<Record<string, unknown>>
      const caller = nodes.find(node => node.label === `${name}()`)
      expect(caller).toBeDefined()
      const methodEdges = payload.pack.relationships.filter((edge: { from_id: string; to_id: string; relation: string }) =>
        edge.from_id === caller?.node_id && edge.relation === 'calls' && nodes.find(node => node.node_id === edge.to_id)?.label === '.deliver()')
      if (name === 'dispatchFromWidenedLocal') {
        expect(methodEdges).toHaveLength(1)
        const target = nodes.find(node => node.node_id === methodEdges[0].to_id)!
        expect(resolveSourceSnippet(target, nodes)).toContain('DERIVED_IMPLEMENTATION')
        expect(target.source_file).toBe('derived.ts')
      } else {
        expect(methodEdges).toEqual([])
        expect(payload.pack.source_dependencies.unresolved).toContainEqual(expect.objectContaining({ callee: 'port.deliver', reason: 'unresolved' }))
      }
    }
  })

  it('delivers the ordering callback with a pagination body and direct cursor helpers', async () => {
    const files = {
      'orders/page.mjs': "import { compareOrders } from './order.mjs';\nimport { encodeCursor, decodeCursor } from './cursor.mjs';\nexport function pageOrders(orders, { limit, after } = {}) {\n  const cursor = after ? decodeCursor(after) : null;\n  const items = orders.slice().sort(compareOrders).filter(order => !cursor || order.id > cursor.id).slice(0, limit);\n  return { items, nextCursor: items.length ? encodeCursor(items.at(-1)) : null };\n}",
      'orders/order.mjs': 'export function compareOrders(a, b) {\n  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);\n}',
      'orders/cursor.mjs': 'export function encodeCursor(order) { return JSON.stringify(order); }\nexport function decodeCursor(cursor) { return JSON.parse(cursor); }',
    }
    const graph = graphFixture(files)
    const { source } = await request(graph, 'How does pageOrders in orders/page.mjs implement ordering, after cursor boundaries and nextCursor, and which helpers in orders/order.mjs and orders/cursor.mjs define comparison and cursor encoding?', 'implement')
    expect(source).toContain(files['orders/order.mjs'])
    expect(source).toContain(files['orders/cursor.mjs'].split('\n')[0])
    expect(source).toContain(files['orders/cursor.mjs'].split('\n')[1])
  })

  it('preserves expiry caller guards and reports injected repository dispatch as unproven amid distractors', async () => {
    const graph = graphFixture(fixtureSources.injected, 48)
    const { source, payload } = await request(graph, 'Add expiry to password reset tokens.', 'implement')
    const service = fixtureSources.injected['src/services/password-reset-service.ts']!.split('\n')
    for (const requiredBody of [service.slice(14, 31), service.slice(32, 42)]) {
      expect(source).toContain(requiredBody.join('\n'))
    }
    // The old body expectation relied only on the injected class annotation.
    // It does not prove which runtime object or override the service receives.
    const unresolved = payload.pack.source_dependencies?.unresolved
      ?? payload.pack.source_dependencies?.unresolved_groups?.flatMap(group => group.calls.map(call => ({ ...call, reason: group.reason })))
    expect(unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ callee: 'this.dependencies.userRepository.findUserByResetToken', reason: 'unresolved' }),
      expect.objectContaining({ callee: 'this.dependencies.userRepository.updatePasswordHash', reason: 'unresolved' }),
    ]))
  })

  it.each([
    ['Show completePasswordReset and the actual consumeCredential implementation called through useResetToken.', ['service', 'storage'], 'ANALYTICS_DUPLICATE_MUST_NOT_LINK'],
    ['Explain handlePasswordReset and follow its imported completePasswordReset implementation.', ['controller', 'service'], 'ANALYTICS_DUPLICATE_MUST_NOT_LINK'],
    ['Explain revokeActiveSessions and the actual sessionStore.revoke implementation it invokes.', ['namespace', 'sessions'], 'ANALYTICS_REVOKE_MUST_NOT_LINK'],
  ] as const)('follows source bindings for %s', async (prompt, required, collision) => {
    const graph = graphFixture(fixtureSources.medium, 24)
    const { source } = await request(graph, prompt)
    for (const name of required) expect(source).toContain(fixtureSources.body[name])
    expect(source).not.toContain(collision)
  })

  it('reports interface-only dispatch as unresolved without choosing an unrelated implementation', async () => {
    const graph = graphFixture(fixtureSources.abstract)
    const { source, payload } = await request(graph, 'Explain notifyAccount and the actual implementation of port.deliver it invokes.')
    expect(source).toContain(fixtureSources.abstract['src/service.ts']!.split('\n').slice(1).join('\n'))
    expect(source).not.toContain('SMTP_ACTUAL_NOT_ESTABLISHED')
    expect(source).not.toContain('SMS_ACTUAL_NOT_ESTABLISHED')
    expect(payload.pack.source_dependencies?.unresolved_calls).toBeGreaterThan(0)
    expect(payload.pack.source_dependencies?.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ callee: 'port.deliver', reason: 'no_implementation' }),
    ]))
  })
})
