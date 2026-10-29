import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { buildSpi } from '../../src/pipeline/spi/build.js'
import { analyzeGraphContextFreshness } from '../../src/runtime/freshness.js'
import { sourceRangeMatchesSymbol } from '../../src/runtime/retrieve/source-evidence.js'
import { loadGraph } from '../../src/runtime/serve.js'
import { resolveSourceSnippet } from '../../src/runtime/source-evidence-response.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.unstubAllEnvs() })
const source = [
  'export class Vault {',
  '  #deliver() {',
  '    return "PRIVATE_BODY";',
  '  }',
  '  deliver() {',
  '    return "PUBLIC_BODY";',
  '  }',
  '  invokePrivate() {',
  '    return this.#deliver();',
  '  }',
  '}',
  'export class OtherVault {',
  '  #deliver() { return "OTHER_PRIVATE_BODY"; }',
  '  run() { return this.#deliver(); }',
  '}',
  'export function describePrivate() {',
  '  // #deliver is mentioned here, not declared here.',
  '  return "PRIVATE_LITERAL #deliver";',
  '}',
].join('\n')

describe('private symbol evidence identity', () => {
  it.each(['auto', 'legacy', 'spi'] as const)('keeps private and public methods distinct through %s indexing and MCP', async extractionMode => {
    const root = mkdtempSync(join(tmpdir(), 'madar-private-symbol-')); roots.push(root)
    const file = join(root, 'vault.ts'); writeFileSync(file, source)
    const generated = generateGraph(root, { noHtml: true, extractionMode })
    const graph = loadGraph(generated.graphPath)
    expect(graph.nodeAttributes('vault_vault_deliver').label).toBe('.deliver()')
    expect(graph.nodeAttributes('vault_vault_#deliver').label).toBe('.#deliver()')
    expect(analyzeGraphContextFreshness(generated.graphPath, graph).status).toBe('fresh')
    vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
    const call = async (prompt: string) => {
      const response = await handleStdioRequest(generated.graphPath, { id: 1, method: 'tools/call', params: {
        name: 'context_pack', arguments: { prompt, task: 'explain', budget: 3000 },
      } })
      expect(response?.error).toBeUndefined()
      return JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]!.text)
    }
    for (const [name, id, body, start] of [
      ['Vault.#deliver', 'vault_vault_#deliver', 'PRIVATE_BODY', 2],
      ['Vault.deliver', 'vault_vault_deliver', 'PUBLIC_BODY', 5],
    ] as const) {
      const payload = await call(`Explain \`${name}\``)
      expect(payload.pack.matched_nodes).toHaveLength(1)
      const node = payload.pack.matched_nodes[0]
      expect(node.node_id).toBe(id)
      expect(node.snippet_unverified).toBeUndefined()
      expect(node.snippet_line_range).toEqual({ start_line: start, end_line: start + 2 })
      expect(resolveSourceSnippet(node, [node])).toContain(body)
      expect(resolveSourceSnippet({ ...node, snippet: undefined, snippet_ref: id }, [node])).toContain(body)
    }
    const dependencies = await call('Explain invokePrivate and the actual private method it calls.')
    expect(dependencies.pack.relationships).toContainEqual({ from_id: 'vault_vault_invokeprivate', to_id: 'vault_vault_#deliver', relation: 'calls' })
    expect(dependencies.pack.relationships).not.toContainEqual({ from_id: 'vault_vault_invokeprivate', to_id: 'vault_vault_deliver', relation: 'calls' })
    if (extractionMode === 'auto') {
      const ambiguous = await call('Explain #deliver')
      expect(ambiguous.pack.matched_nodes.map((node: { node_id: string }) => node.node_id).sort()).toEqual(['vault_othervault_#deliver', 'vault_vault_#deliver'])
      const behavior = await call('How does #deliver behave and how do invokePrivate and run call it?')
      expect(behavior.pack.selection_scope).toBe('task_context')
    }
    const spi = buildSpi({ root, madarVersion: 'test' })
    expect(spi.symbols.find(symbol => symbol.name === 'Vault.#deliver')?.exported).toBe(false)
    expect(spi.symbols.find(symbol => symbol.name === 'Vault.deliver')?.exported).toBe(true)
    writeFileSync(file, source.replace('PRIVATE_BODY', 'PRIVATE_EDIT'))
    expect(analyzeGraphContextFreshness(generated.graphPath, graph).status).not.toBe('fresh')
  })

  it('rejects private/public source attribution swaps even when only the private marker changed', () => {
    const lines = source.split('\n')
    expect(sourceRangeMatchesSymbol(lines, { start: 2, end: 4 }, '.#deliver()', 'vault.ts')).toBe(true)
    expect(sourceRangeMatchesSymbol(lines, { start: 2, end: 4 }, '.deliver()', 'vault.ts')).toBe(false)
    expect(sourceRangeMatchesSymbol(lines, { start: 5, end: 7 }, '.#deliver()', 'vault.ts')).toBe(false)
    const changed = source.replace('#deliver()', 'deliver()').split('\n')
    expect(sourceRangeMatchesSymbol(changed, { start: 2, end: 4 }, '.#deliver()', 'vault.ts')).toBe(false)
  })
})
