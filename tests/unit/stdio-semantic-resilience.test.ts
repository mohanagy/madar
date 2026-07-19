import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { beforeEach, describe, expect, it, vi } from 'vitest'

interface JsonRpcLine {
  id?: string | number | null
  method?: string
  result?: {
    isError?: boolean
    content?: Array<{ type: string; text: string }>
    tools?: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>
  }
  error?: { code: number; message: string }
}

function writeGraphFixture(root: string): string {
  const outDir = join(root, 'out')
  mkdirSync(outDir, { recursive: true })
  const graphPath = join(outDir, 'graph.json')
  writeFileSync(
    graphPath,
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
  return graphPath
}

function installTransformersStub(root: string): void {
  const packageDir = join(root, 'node_modules', '@huggingface', 'transformers')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@huggingface/transformers',
      version: '0.0.0-test',
      type: 'module',
      main: 'index.js',
    }),
    'utf8',
  )
  writeFileSync(
    join(packageDir, 'index.js'),
    [
      'export async function pipeline(task, model) {',
      "  if (task === 'text-classification') {",
      '    return async (input) => (Array.isArray(input) ? input : [input]).map((pair) => [{',
      "      label: 'RELEVANT',",
      "      score: typeof pair?.text_pair === 'string' && pair.text_pair.includes('Ledger') ? 0.9 : 0.2,",
      '    }])',
      '  }',
      '  return async (input) => (Array.isArray(input) ? input : [input]).map(() => ({ data: [1, 0] }))',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
}

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'madar-semantic-resilience-'))
}

function retrieveCall(id: number, args: Record<string, unknown>): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'retrieve', arguments: { question: 'ledger invoice history', budget: 2000, ...args } },
  }
}

async function waitForResponse(lines: () => JsonRpcLine[], id: number, timeoutMs = 5000): Promise<JsonRpcLine> {
  const start = Date.now()
  for (;;) {
    const found = lines().find((line) => line.id === id)
    if (found) {
      return found
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for response id=${id}`)
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20))
  }
}

describe('semantic optional dependency resilience', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('retrieve without semantic works when @huggingface/transformers is not installed', async () => {
    const root = makeTempRoot()
    try {
      const graphPath = writeGraphFixture(root)
      const { handleStdioRequest } = await import('../../src/runtime/stdio-server.js')

      const response = (await Promise.resolve(handleStdioRequest(graphPath, retrieveCall(1, {})))) as JsonRpcLine

      expect(response?.error).toBeUndefined()
      expect(response?.result?.isError).toBeUndefined()
      expect(response?.result?.content?.[0]?.text).toContain('LedgerRepository')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rerank without the package returns isError and the server keeps answering', async () => {
    const root = makeTempRoot()
    try {
      const graphPath = writeGraphFixture(root)
      const { serveGraphStdio } = await import('../../src/runtime/stdio-server.js')

      const input = new PassThrough()
      const output = new PassThrough()
      const errorOutput = new PassThrough()
      errorOutput.resume()
      const chunks: string[] = []
      output.on('data', (chunk) => chunks.push(String(chunk)))
      const parsedLines = (): JsonRpcLine[] =>
        chunks
          .join('')
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            try {
              return JSON.parse(line) as JsonRpcLine
            } catch {
              return {}
            }
          })

      const serverDone = serveGraphStdio({ graphPath, input, output, errorOutput })

      input.write(`${JSON.stringify(retrieveCall(1, { rerank: true }))}\n`)
      const first = await waitForResponse(parsedLines, 1)
      expect(first.error).toBeUndefined()
      expect(first.result?.isError).toBe(true)
      expect(first.result?.content?.[0]?.text).toContain('@huggingface/transformers')

      input.write(`${JSON.stringify(retrieveCall(2, {}))}\n`)
      const second = await waitForResponse(parsedLines, 2)
      expect(second.error).toBeUndefined()
      expect(second.result?.isError).toBeUndefined()
      expect(second.result?.content?.[0]?.text).toContain('LedgerRepository')

      input.end()
      await serverDone
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves a project-local @huggingface/transformers install for rerank', async () => {
    const root = makeTempRoot()
    try {
      const graphPath = writeGraphFixture(root)
      installTransformersStub(root)
      const { handleStdioRequest } = await import('../../src/runtime/stdio-server.js')

      const response = (await Promise.resolve(handleStdioRequest(graphPath, retrieveCall(1, { rerank: true })))) as JsonRpcLine

      expect(response?.error).toBeUndefined()
      expect(response?.result?.isError).toBeUndefined()
      expect(response?.result?.content?.[0]?.text).toContain('LedgerRepository')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reranks via a project-local install passed as projectRoot', async () => {
    const root = makeTempRoot()
    try {
      installTransformersStub(root)
      const { rerankCandidatesWithCrossEncoder } = await import('../../src/runtime/semantic.js')

      const scores = await rerankCandidatesWithCrossEncoder(
        'where is invoice history stored',
        [
          { id: 'ledger_repo', text: 'LedgerRepository persists invoice history' },
          { id: 'logger', text: 'Logger telemetry' },
        ],
        { projectRoot: root, model: 'stub-model-project-local' },
      )

      expect(scores.get('ledger_repo')).toBeGreaterThan(scores.get('logger') ?? 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not poison pipelineCache after a failed load', async () => {
    const root = makeTempRoot()
    try {
      const { rerankCandidatesWithCrossEncoder } = await import('../../src/runtime/semantic.js')
      const candidates = [{ id: 'ledger_repo', text: 'LedgerRepository persists invoice history' }]
      const options = { projectRoot: root, model: 'stub-model-eviction' }

      await expect(rerankCandidatesWithCrossEncoder('invoice history', candidates, options))
        .rejects.toThrow(/@huggingface\/transformers/)

      installTransformersStub(root)

      const scores = await rerankCandidatesWithCrossEncoder('invoice history', candidates, options)
      expect(scores.get('ledger_repo')).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('activeMcpTools omits semantic fields when unavailable and keeps them when available', async () => {
    const { activeMcpTools } = await import('../../src/runtime/stdio/definitions.js')

    const findRetrieve = (tools: ReturnType<typeof activeMcpTools>) =>
      tools.find((tool) => tool.name === 'retrieve')

    const gated = findRetrieve(activeMcpTools('core', { semanticAvailable: false }))
    expect(gated?.inputSchema.properties).not.toHaveProperty('semantic')
    expect(gated?.inputSchema.properties).not.toHaveProperty('semantic_model')
    expect(gated?.inputSchema.properties).not.toHaveProperty('rerank')
    expect(gated?.inputSchema.properties).not.toHaveProperty('rerank_model')
    expect(gated?.inputSchema.properties).toHaveProperty('question')
    expect(gated?.inputSchema.properties).toHaveProperty('budget')

    const open = findRetrieve(activeMcpTools('core', { semanticAvailable: true }))
    expect(open?.inputSchema.properties).toHaveProperty('semantic')
    expect(open?.inputSchema.properties).toHaveProperty('rerank')

    const defaulted = findRetrieve(activeMcpTools('core'))
    expect(defaulted?.inputSchema.properties).toHaveProperty('rerank')
  })

  it('tools/list reflects project-local availability', async () => {
    const unavailableRoot = makeTempRoot()
    const availableRoot = makeTempRoot()
    try {
      const unavailableGraph = writeGraphFixture(unavailableRoot)
      const availableGraph = writeGraphFixture(availableRoot)
      installTransformersStub(availableRoot)
      const { handleStdioRequest } = await import('../../src/runtime/stdio-server.js')

      const listFor = async (graphPath: string) => {
        const response = (await Promise.resolve(handleStdioRequest(graphPath, { id: 1, method: 'tools/list' }))) as JsonRpcLine
        return response?.result?.tools?.find((tool) => tool.name === 'retrieve')
      }

      const gated = await listFor(unavailableGraph)
      expect(gated?.inputSchema.properties).not.toHaveProperty('rerank')
      expect(gated?.inputSchema.properties).not.toHaveProperty('semantic')

      const open = await listFor(availableGraph)
      expect(open?.inputSchema.properties).toHaveProperty('rerank')
      expect(open?.inputSchema.properties).toHaveProperty('semantic')
    } finally {
      rmSync(unavailableRoot, { recursive: true, force: true })
      rmSync(availableRoot, { recursive: true, force: true })
    }
  })

  it('doctor reports semantic availability without affecting health', async () => {
    const unavailableRoot = makeTempRoot()
    const availableRoot = makeTempRoot()
    try {
      installTransformersStub(availableRoot)
      const { buildDoctorReport, runDoctorCommand } = await import('../../src/infrastructure/doctor.js')

      const unavailableReport = buildDoctorReport({ projectDir: unavailableRoot })
      expect(unavailableReport.semantic.available).toBe(false)
      expect(unavailableReport.nextCommands.join(' ')).not.toContain('transformers')

      const availableReport = buildDoctorReport({ projectDir: availableRoot })
      expect(availableReport.semantic.available).toBe(true)

      expect(unavailableReport.healthy).toBe(availableReport.healthy)

      const unavailableOutput = runDoctorCommand({ projectDir: unavailableRoot })
      expect(unavailableOutput).toContain('semantic/rerank: unavailable')
      expect(unavailableOutput).toContain('@huggingface/transformers')

      const availableOutput = runDoctorCommand({ projectDir: availableRoot })
      expect(availableOutput).toContain('semantic/rerank: available')
    } finally {
      rmSync(unavailableRoot, { recursive: true, force: true })
      rmSync(availableRoot, { recursive: true, force: true })
    }
  })
})
