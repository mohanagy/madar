import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { writeCanonicalGraphFixture } from '../helpers/graph-artifact.js'

function createGraphFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-stdio-semantic-'))
  mkdirSync(root, { recursive: true })
  writeCanonicalGraphFixture(
    join(root, 'graph.json'),
    {
      nodes: [
        {
          id: 'ledger_repo',
          label: 'LedgerRepository',
          source_file: 'ledger.ts',
          source_location: 'L4-L6',
          file_type: 'code',
          community: 0,
          snippet: 'class LedgerRepository {\n  saveInvoiceHistory() {}\n}',
        },
        {
          id: 'logger',
          label: 'Logger',
          source_file: 'logger.ts',
          source_location: 'L1-L3',
          file_type: 'code',
          community: 1,
          snippet: 'class Logger {\n  info() {}\n}',
        },
      ],
      edges: [],
    },
  )
  return root
}

describe('stdio semantic retrieve', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('surfaces semantic options in the retrieve tool schema when transformers is installed', async () => {
    const root = createGraphFixtureRoot()
    try {
      const packageDir = join(root, 'node_modules', '@huggingface', 'transformers')
      mkdirSync(packageDir, { recursive: true })
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({ name: '@huggingface/transformers', version: '0.0.0-test', type: 'module', main: 'index.js' }),
        'utf8',
      )
      writeFileSync(join(packageDir, 'index.js'), 'export async function pipeline() { return async () => [] }\n', 'utf8')

      vi.resetModules()
      const { handleStdioRequest } = await import('../../src/runtime/stdio-server.js')
      const graphPath = join(root, 'graph.json')
      const toolsList = await Promise.resolve(handleStdioRequest(graphPath, { id: 1, method: 'tools/list' }))
      const retrieveTool = (toolsList?.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }).tools.find(
        (tool) => tool.name === 'retrieve',
      )

      expect(retrieveTool?.inputSchema.properties).toHaveProperty('semantic')
      expect(retrieveTool?.inputSchema.properties).toHaveProperty('semantic_model')
      expect(retrieveTool?.inputSchema.properties).toHaveProperty('rerank')
      expect(retrieveTool?.inputSchema.properties).toHaveProperty('rerank_model')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits semantic options from the retrieve tool schema when transformers is unavailable', async () => {
    const root = createGraphFixtureRoot()
    try {
      vi.resetModules()
      const { handleStdioRequest } = await import('../../src/runtime/stdio-server.js')
      const graphPath = join(root, 'graph.json')
      const toolsList = await Promise.resolve(handleStdioRequest(graphPath, { id: 1, method: 'tools/list' }))
      const retrieveTool = (toolsList?.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }).tools.find(
        (tool) => tool.name === 'retrieve',
      )

      expect(retrieveTool?.inputSchema.properties).not.toHaveProperty('semantic')
      expect(retrieveTool?.inputSchema.properties).not.toHaveProperty('semantic_model')
      expect(retrieveTool?.inputSchema.properties).not.toHaveProperty('rerank')
      expect(retrieveTool?.inputSchema.properties).not.toHaveProperty('rerank_model')
      expect(retrieveTool?.inputSchema.properties).toHaveProperty('question')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
