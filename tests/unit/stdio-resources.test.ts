import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { generateIndex } from '../../src/application/generate-index.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { resourcesForGraph } from '../../src/runtime/stdio/resources.js'

function createGraphFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-stdio-resources-'))
  writeFileSync(
    join(root, 'auth.ts'),
    'export function AuthService(): boolean { return true }\n',
    'utf8',
  )
  generateIndex(root)
  return root
}

describe('stdio authenticated resources', () => {
  it('lists and reads only the accepted graph', () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'out', 'graph.json')
      expect(resourcesForGraph(graphPath).map((resource) => resource.name)).toEqual([
        'graph.json',
      ])

      const response = handleStdioRequest(graphPath, {
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: 'madar://artifact/graph.json' },
      })
      const contents = (response?.result as {
        contents: Array<{ mimeType: string; text: string }>
      }).contents
      expect(contents[0]?.mimeType).toBe('application/json')
      expect(JSON.parse(contents[0]?.text ?? '{}')).toMatchObject({
        schema: 'madar.graph',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not expose a retired report artifact', () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'out', 'graph.json')
      writeFileSync(
        join(root, 'out', 'GRAPH_REPORT.md'),
        `<!-- madar-build-id: ${'0'.repeat(64)} -->\n# stale report\n`,
        'utf8',
      )

      expect(resourcesForGraph(graphPath).map((resource) => resource.name)).toEqual([
        'graph.json',
      ])

      const response = handleStdioRequest(graphPath, {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: 'madar://artifact/GRAPH_REPORT.md' },
      })
      expect(response?.error).toMatchObject({
        code: -32602,
        message: 'Unknown resource: madar://artifact/GRAPH_REPORT.md',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
