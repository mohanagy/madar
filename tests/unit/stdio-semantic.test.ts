import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

function createGraphFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sadeem-stdio-semantic-'))
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'graph.json'),
    JSON.stringify({
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
      hyperedges: [],
    }),
    'utf8',
  )
  return root
}

describe('stdio semantic retrieve', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('surfaces semantic options in the retrieve tool schema', async () => {
    const root = createGraphFixtureRoot()
    try {
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
})
