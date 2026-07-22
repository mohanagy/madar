import { PassThrough } from 'node:stream'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { emitResourceNotifications } from '../../src/runtime/stdio/resources.js'
import { writeCanonicalGraphFixture } from '../helpers/graph-artifact.js'

function createGraphFixtureRoot(): string {
  const parentDir = resolve('out', 'test-runtime')
  mkdirSync(parentDir, { recursive: true })
  const root = mkdtempSync(join(parentDir, 'madar-stdio-resources-'))
  writeCanonicalGraphFixture(
    join(root, 'graph.json'),
    {
      nodes: [{ id: 'auth', label: 'AuthService', source_file: 'auth.ts', source_location: '1', file_type: 'code', community: 0 }],
      edges: [],
    },
  )
  writeFileSync(join(root, 'GRAPH_REPORT.md'), '# Graph Report\n', 'utf8')
  return root
}

describe('stdio resource helpers', () => {
  it('emits list_changed when available resources change', () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'graph.json')
      const output = new PassThrough()
      let outputText = ''
      output.on('data', (chunk) => {
        outputText += chunk.toString('utf8')
      })

      const sessionState = {
        subscribedResourceUris: new Set<string>(),
        resourceVersions: new Map<string, string>(),
        resourceListSignature: null,
      }

      emitResourceNotifications(output, graphPath, sessionState)
      unlinkSync(join(root, 'GRAPH_REPORT.md'))
      emitResourceNotifications(output, graphPath, sessionState)

      const messages = outputText
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))

      expect(messages).toEqual([
        {
          jsonrpc: '2.0',
          method: 'notifications/resources/list_changed',
        },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
