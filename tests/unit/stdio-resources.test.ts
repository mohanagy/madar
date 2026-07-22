import { PassThrough } from 'node:stream'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { generateIndex } from '../../src/application/generate-index.js'
import { emitResourceNotifications, resourcesForGraph } from '../../src/runtime/stdio/resources.js'

function createGraphFixtureRoot(): string {
  const parentDir = tmpdir()
  mkdirSync(parentDir, { recursive: true })
  const root = mkdtempSync(join(parentDir, 'madar-stdio-resources-'))
  writeFileSync(join(root, 'auth.ts'), 'export function AuthService(): boolean { return true }\n', 'utf8')
  generateIndex(root)
  return root
}

describe('stdio resource helpers', () => {
  it('hides a report whose build id does not match the accepted graph', () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'out', 'graph.json')
      expect(resourcesForGraph(graphPath).map((resource) => resource.name)).toContain('GRAPH_REPORT.md')

      writeFileSync(
        join(root, 'out', 'GRAPH_REPORT.md'),
        `<!-- madar-build-id: ${'0'.repeat(64)} -->\n# stale report\n`,
        'utf8',
      )
      expect(resourcesForGraph(graphPath).map((resource) => resource.name)).not.toContain('GRAPH_REPORT.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('emits list_changed when available resources change', () => {
    const root = createGraphFixtureRoot()
    try {
      const graphPath = join(root, 'out', 'graph.json')
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
      unlinkSync(join(root, 'out', 'GRAPH_REPORT.md'))
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
