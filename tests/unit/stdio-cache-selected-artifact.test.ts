import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { GRAPH_ARTIFACT_V2_TOMBSTONE } from '../../src/contracts/graph-artifact.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { loadGraph, resolvedLoadPath } from '../../src/runtime/serve.js'

/**
 * The MCP graph cache must watch the artifact its bytes came from.
 *
 * It keyed on the requested path. When that path is `out/graph.json` in a
 * cut-over workspace, `loadGraph` reads `out/graph.madar` instead -- and the
 * tombstone is a constant, so its mtime and size never change. The cache
 * therefore never invalidated, and a session kept answering from the graph it
 * had loaded first no matter how many times the canonical artifact was
 * refreshed underneath it.
 */

const SMALL = 'export function alpha() { beta() }\nexport function beta() {}\n'
const LARGER = `${SMALL}export function gamma() {}\nexport function delta() { gamma() }\n`

function workspace(prefix: string, source: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), source)
  generateGraph(root, { noHtml: true })
  return root
}

function summaryNodeCount(graphPath: string): number {
  const response = handleStdioRequest(graphPath, {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'graph_summary', arguments: {} },
  }, undefined as never) as { result?: { content?: Array<{ text?: string }> } }
  const text = response?.result?.content?.[0]?.text ?? '{}'
  return (JSON.parse(text.slice(text.indexOf('{'))) as { node_count?: number }).node_count ?? -1
}

describe('the MCP graph cache follows the selected artifact', () => {
  it('sees a refreshed canonical artifact when the request names the tombstone', () => {
    const served = workspace('stdio-cache-served-', SMALL)
    const refreshed = workspace('stdio-cache-refresh-', LARGER)
    try {
      const tombstonePath = join(served, 'out', 'graph.json')
      const first = summaryNodeCount(tombstonePath)

      // Only the canonical artifact changes. The tombstone is byte-identical
      // and untouched, which is exactly what made the stale answer invisible.
      copyFileSync(join(refreshed, 'out', 'graph.madar'), join(served, 'out', 'graph.madar'))
      const second = summaryNodeCount(tombstonePath)

      expect(first).toBeGreaterThan(0)
      expect(second).toBeGreaterThan(first)
    } finally {
      rmSync(served, { recursive: true, force: true })
      rmSync(refreshed, { recursive: true, force: true })
    }
  }, 180_000)

  it('still answers from the requested file for a workspace that never cut over', () => {
    const root = mkdtempSync(join(tmpdir(), 'stdio-cache-legacy-'))
    try {
      mkdirSync(join(root, 'out'), { recursive: true })
      const legacy = join(root, 'out', 'graph.json')
      writeFileSync(legacy, JSON.stringify({
        schema_version: 1, directed: true, root_path: root,
        nodes: [{ id: 'a', label: 'alpha()', file_type: 'code', source_file: 'src/a.ts', source_location: 'L1' }],
        links: [],
      }))

      // Pre-cutover behaviour must stay truthful: no redirection here.
      // Compared as real paths because the resolver canonicalizes symlinks.
      expect(resolvedLoadPath(legacy)).toBe(realpathSync(legacy))
      expect(summaryNodeCount(legacy)).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['a cut-over workspace, canonical requested', 'graph.madar'],
    ['a cut-over workspace, tombstone requested', 'graph.json'],
  ])('resolves the same artifact loadGraph reads for %s', (_label, requested) => {
    const root = workspace('stdio-cache-agree-', SMALL)
    try {
      const requestedPath = join(root, 'out', requested)
      const resolved = resolvedLoadPath(requestedPath)

      // The resolver mirrors loadGraph's redirect. Pinning them together is
      // what stops a second implementation of the rule from drifting.
      expect(loadGraph(resolved).numberOfNodes()).toBe(loadGraph(requestedPath).numberOfNodes())
      expect(resolved.endsWith('graph.madar')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)

  it('does not redirect when the tombstone has no canonical sibling', () => {
    const root = mkdtempSync(join(tmpdir(), 'stdio-cache-moved-'))
    try {
      mkdirSync(join(root, 'out'), { recursive: true })
      const legacy = join(root, 'out', 'graph.json')
      writeFileSync(legacy, GRAPH_ARTIFACT_V2_TOMBSTONE)

      // moved_without_canonical must not resolve anywhere; loadGraph refuses it.
      expect(resolvedLoadPath(legacy)).toBe(realpathSync(legacy))
      expect(() => loadGraph(legacy)).toThrow(/graph\.madar/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
