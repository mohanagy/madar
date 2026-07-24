import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { generateIndex } from '../../src/application/generate-index.js'
import { canonicalJsonString } from '../../src/domain/graph/canonical-json.js'
import type {
  GraphAutoRefreshController,
  WatchIndexState,
} from '../../src/infrastructure/watch-index.js'
import {
  handleStdioRequest,
  serveGraphStdio,
} from '../../src/runtime/stdio-server.js'

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: {
    content?: Array<{ type: string; text: string }>
    tools?: Array<{
      name: string
      inputSchema: {
        additionalProperties: boolean
        properties: Record<string, unknown>
        required: string[]
      }
    }>
    [key: string]: unknown
  }
  error?: {
    code: number
    message: string
  }
}

let fixtureRoot = ''
let graphPath = ''

function request(
  id: number,
  method: string,
  params?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method,
    ...(params ? { params } : {}),
  }
}

function toolCall(
  id: number,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return request(id, 'tools/call', {
    name,
    arguments: args,
  })
}

function responseFor(payload: unknown): JsonRpcResponse {
  const response = handleStdioRequest(graphPath, payload)
  if (!response) throw new Error('Expected a JSON-RPC response')
  return response as JsonRpcResponse
}

function parsedToolResult(response: JsonRpcResponse): Record<string, unknown> {
  const text = response.result?.content?.[0]?.text
  if (!text) throw new Error('Expected text tool content')
  return JSON.parse(text) as Record<string, unknown>
}

function controlledRefresh(initialState: WatchIndexState): {
  controller: GraphAutoRefreshController
  stopped: () => boolean
} {
  let state = initialState
  let stopped = false
  return {
    controller: {
      startupComplete: () => state !== 'starting',
      failureReason: () => state === 'failed' ? 'test failure' : null,
      state: () => state,
      acceptedBuildId: () => null,
      startupSettled: Promise.resolve(),
      stop() {
        stopped = true
        state = 'stopped'
      },
      completed: Promise.resolve(),
    },
    stopped: () => stopped,
  }
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'madar-stdio-core-reset-'))
  writeFileSync(
    join(fixtureRoot, 'route.ts'),
    [
      "import { storeValue } from './store.js'",
      '',
      'export function routeEntry(value: string): string {',
      '  return storeValue(value)',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(fixtureRoot, 'store.ts'),
    [
      'export function storeValue(value: string): string {',
      '  return value.trim()',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(fixtureRoot, 'tsconfig.json'),
    '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","strict":true}}\n',
    'utf8',
  )
  graphPath = generateIndex(fixtureRoot).graphPath
})

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('MCP stdio delivery surface', () => {
  it('initializes and exposes exactly one retrieve tool', () => {
    const initialized = responseFor(request(1, 'initialize'))
    expect(initialized.result).toMatchObject({
      protocolVersion: '2025-11-25',
      capabilities: {
        resources: { listChanged: false },
        tools: { listChanged: false },
      },
      serverInfo: {
        name: 'madar',
        title: 'Madar TS',
      },
    })
    expect(initialized.result?.instructions).toContain('Call retrieve once')

    const listed = responseFor(request(2, 'tools/list'))
    expect(listed.result?.tools?.map((tool) => tool.name)).toEqual(['retrieve'])
    expect(listed.result?.tools?.[0]?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: { type: 'string', minLength: 1 },
        budget: { type: 'integer', minimum: 1 },
      },
    })
    expect(
      Object.keys(listed.result?.tools?.[0]?.inputSchema.properties ?? {}),
    ).toEqual(['question', 'budget'])
  })

  it('reports the installed package version in the initialize handshake', () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { version: string }
    const initialized = responseFor(request(2, 'initialize'))

    expect(initialized.result).toMatchObject({
      serverInfo: {
        name: 'madar',
        version: manifest.version,
      },
    })
  })

  it('returns a canonical authenticated retrieve result', () => {
    const response = responseFor(toolCall(3, 'retrieve', {
      question: 'Trace routeEntry through storeValue.',
      budget: 1200,
    }))
    const text = response.result?.content?.[0]?.text
    const result = parsedToolResult(response)

    expect(response.error).toBeUndefined()
    expect(result).toMatchObject({
      schema: 'madar.retrieve',
      version: 1,
      outcome: 'evidence',
      metrics: {
        closure_passes: 1,
        truncated: false,
      },
    })
    expect(result.matched_nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidence_kind: 'symbol_declaration',
        label: 'routeEntry()',
        source_file: 'route.ts',
        snippet: 'export function routeEntry(value: string): string ',
      }),
      expect.objectContaining({
        evidence_kind: 'symbol_declaration',
        label: 'storeValue()',
        source_file: 'store.ts',
        snippet: 'export function storeValue(value: string): string ',
      }),
    ]))
    expect(result.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relation: 'calls',
      }),
    ]))
    expect(text).toBe(canonicalJsonString(result))
  })

  it('rejects retired tools and non-contract retrieve arguments', () => {
    expect(responseFor(toolCall(4, 'context_pack', {
      prompt: 'question',
    })).error).toEqual({
      code: -32601,
      message: 'Unknown tool: context_pack',
    })

    expect(responseFor(toolCall(5, 'retrieve', {
      question: 'question',
      semantic: true,
    })).error).toEqual({
      code: -32602,
      message: 'retrieve accepts only question and optional budget',
    })

    expect(responseFor(toolCall(6, 'retrieve', {
      question: 'question',
      budget: 0,
    })).error).toEqual({
      code: -32602,
      message: 'retrieve budget must be a positive integer',
    })
  })

  it('handles notifications and malformed JSON-RPC requests predictably', () => {
    expect(handleStdioRequest(graphPath, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })).toBeNull()
    expect(responseFor(null).error).toEqual({
      code: -32600,
      message: 'Invalid request',
    })
    expect(responseFor({ jsonrpc: '2.0', id: 7 }).error).toEqual({
      code: -32600,
      message: 'Invalid request: missing method',
    })
    expect(responseFor(request(8, 'removed/method')).error).toEqual({
      code: -32601,
      message: 'Method not found: removed/method',
    })
  })

  it('serves the remaining MCP control and resource methods', () => {
    expect(responseFor(request(10, 'ping')).result).toEqual({})
    expect(responseFor(request(11, 'prompts/list')).result).toEqual({ prompts: [] })
    expect(responseFor(request(12, 'resources/templates/list')).result)
      .toEqual({ resourceTemplates: [] })
    const resources = responseFor(request(13, 'resources/list')).result?.resources
    expect(resources).toEqual(expect.any(Array))
    expect(responseFor(request(14, 'resources/read', {
      uri: 'madar://artifact/missing.json',
    })).error).toBeDefined()
  })

  it('returns a server error when graph-backed work cannot authenticate', () => {
    const response = handleStdioRequest(join(fixtureRoot, 'missing.json'), toolCall(
      15,
      'retrieve',
      { question: 'What is routeEntry?' },
    )) as JsonRpcResponse
    expect(parsedToolResult(response)).toMatchObject({
      outcome: 'corrupt',
      matched_nodes: [],
      boundaries: [{ kind: 'corrupt', subject: 'canonical graph artifact' }],
    })
  })

  it('keeps the stdio stream alive after a parse error', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    let outputText = ''
    output.on('data', (chunk) => {
      outputText += chunk.toString('utf8')
    })

    const serving = serveGraphStdio({
      graphPath,
      input,
      output,
      errorOutput,
    })
    input.end([
      '{not json}',
      JSON.stringify(request(9, 'ping')),
      '',
    ].join('\n'))
    await serving

    const responses = outputText
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JsonRpcResponse)
    expect(responses).toEqual([
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      },
      {
        jsonrpc: '2.0',
        id: 9,
        result: {},
      },
    ])
  })

  it('rejects oversized stream messages and still answers the next control request', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    let outputText = ''
    output.on('data', (chunk) => {
      outputText += chunk.toString('utf8')
    })

    const serving = serveGraphStdio({ graphPath, input, output, errorOutput })
    input.end(`${'x'.repeat(1_000_001)}\n${JSON.stringify(request(16, 'ping'))}\n`)
    await serving
    const responses = outputText.trim().split('\n').map((line) =>
      JSON.parse(line) as JsonRpcResponse)
    expect(responses[0]?.error).toEqual({
      code: -32600,
      message: 'Payload too large (max 1000000 bytes)',
    })
    expect(responses[1]?.result).toEqual({})
  })

  it.each(['failed', 'reconciling'] as const)(
    'gates graph requests while auto-refresh is %s but keeps control requests responsive',
    async (state) => {
      const input = new PassThrough()
      const output = new PassThrough()
      const errorOutput = new PassThrough()
      const refresh = controlledRefresh(state)
      let outputText = ''
      output.on('data', (chunk) => {
        outputText += chunk.toString('utf8')
      })
      const serving = serveGraphStdio({
        graphPath,
        workspaceRoot: fixtureRoot,
        autoRefresh: true,
        autoRefreshRequestWaitMs: 0,
        autoRefreshStarter: () => refresh.controller,
        input,
        output,
        errorOutput,
      })
      input.end([
        JSON.stringify(toolCall(17, 'retrieve', { question: 'What is routeEntry?' })),
        JSON.stringify(request(18, 'resources/list')),
        JSON.stringify(request(19, 'ping')),
        '',
      ].join('\n'))
      await serving
      const responses = outputText.trim().split('\n').map((line) =>
        JSON.parse(line) as JsonRpcResponse)
      expect(responses.find((response) => response.id === 17)?.error).toMatchObject({
        code: -32000,
        data: {
          state,
          retryable: state === 'reconciling',
          suggested_action: state === 'reconciling'
            ? 'retry_same_request'
            : 'repair_graph',
        },
      })
      expect(responses.find((response) => response.id === 18)?.result)
        .toEqual({ resources: [] })
      expect(responses.find((response) => response.id === 19)?.result).toEqual({})
      expect(refresh.stopped()).toBe(true)
    },
  )

  it('refuses auto-refresh when the requested graph belongs to another workspace', async () => {
    const input = new PassThrough()
    input.end()
    await expect(serveGraphStdio({
      graphPath: join(fixtureRoot, 'other', 'graph.json'),
      workspaceRoot: fixtureRoot,
      autoRefresh: true,
      autoRefreshStarter: vi.fn(),
      input,
      output: new PassThrough(),
      errorOutput: new PassThrough(),
    })).rejects.toThrow('it is not the graph artifact')
  })
})
