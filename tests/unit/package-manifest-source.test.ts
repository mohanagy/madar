import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { readPackageManifest } from '../../src/shared/package-manifest.js'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.unstubAllEnvs() })

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'madar-package-source-')); roots.push(root)
  writeFileSync(join(root, 'entry.ts'), 'export function start() { return "START"; }\n')
  vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
  return root
}

function session(graphPath: string) {
  const state: NonNullable<Parameters<typeof handleStdioRequest>[2]> = {
    logLevel: 'info', subscribedResourceUris: new Set(), resourceVersions: new Map(), resourceListSignature: null,
    contextPackCache: new Map(),
  }
  let id = 0
  return async (prompt: string) => {
    const response = await handleStdioRequest(graphPath, { id: ++id, method: 'tools/call', params: {
      name: 'context_pack', arguments: { prompt, task: 'explain', budget: 2000 },
    } }, state)
    expect(response?.error).toBeUndefined()
    const text = (response!.result as { content: Array<{ text: string }> }).content[0]!.text
    const payload = JSON.parse(text)
    expect(estimateQueryTokens(text)).toBeLessThanOrEqual(2000)
    expect(payload.serialized_budget.token_count).toBe(estimateQueryTokens(text))
    expect(text).not.toContain('package_configuration')
    return payload
  }
}

describe('package source through generation and MCP cache', () => {
  it('serves original manifest bytes, reuses cache, and invalidates same-size restored-mtime edits', async () => {
    const root = workspace(), path = join(root, 'package.json')
    const original = '{"name":"first-package","scripts":{"test":"node --test"}}\n'
    const changed = original.replace('first-package', 'other-package')
    writeFileSync(path, original)
    expect(readPackageManifest(relative(process.cwd(), path))?.text).toBe(original)
    const call = session(generateGraph(root, { noHtml: true, includeDocs: false, docs: false }).graphPath)
    const first = await call('Show package.json')
    expect(first.pack.matched_nodes.find((node: { source_file: string }) => node.source_file === 'package.json')?.snippet).toBe(original)
    expect((await call('Show package.json')).cache.status).toBe('hit')
    const before = statSync(path)
    writeFileSync(path, changed); utimesSync(path, before.atime, before.mtime)
    expect(statSync(path).size).toBe(before.size)
    const updated = await call('Show package.json')
    expect(updated.cache.status).toBe('miss')
    expect(updated.pack.matched_nodes.find((node: { source_file: string }) => node.source_file === 'package.json')?.snippet).toBe(changed)
    expect((await call('Show package.json')).cache.status).toBe('hit')
    writeFileSync(join(root, '.madarignore'), 'package.json\n')
    const blocked = await call('Show package.json')
    expect(blocked.cache?.status).not.toBe('hit')
    expect(JSON.stringify(blocked.pack)).not.toContain('other-package')
  })

  it('uses the generation root policy for nested manifests and excludes arbitrary JSON', async () => {
    const root = workspace()
    mkdirSync(join(root, 'packages', 'worker'), { recursive: true })
    const manifest = '{"name":"nested-worker"}\n'
    writeFileSync(join(root, 'packages/worker/package.json'), manifest)
    writeFileSync(join(root, 'packages/worker/.madarignore'), 'package.json\n')
    writeFileSync(join(root, 'ordinary.json'), '{"name":"unrelated-json"}\n')
    const call = session(generateGraph(root, { noHtml: true, includeDocs: false, docs: false }).graphPath)
    const response = await call('Show packages/worker/package.json')
    expect(response.pack.matched_nodes.find((node: { source_file: string }) => node.source_file === 'packages/worker/package.json')?.snippet).toBe(manifest)
    expect(JSON.stringify(response.pack)).not.toContain('unrelated-json')
    expect((await call('Show packages/worker/package.json')).cache.status).toBe('hit')
  })
})
