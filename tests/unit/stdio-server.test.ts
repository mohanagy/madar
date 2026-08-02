import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  retrieveContext,
  serializeRetrieveContextResult,
} from '../../src/application/retrieve-context.js'
import { failedQueryIndex } from '../../src/domain/query/index-status.js'
import {
  handleMcpProtocolRequest,
  MAX_STDIO_LINE_BYTES,
  type JsonRpcResponse,
} from '../../src/adapters/mcp/protocol.js'
import {
  serveMcpServer,
  type McpServerOptions,
  type ReconciliationController,
  type ReconcilerStarter,
} from '../../src/adapters/mcp/server.js'

interface ToolResult {
  content?: Array<{ type: string; text: string }>
  tools?: Array<Record<string, unknown>>
  [key: string]: unknown
}

const SERVER_SOURCE = readFileSync(
  new URL('../../src/adapters/mcp/server.ts', import.meta.url),
  'utf8',
)

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

function notification(method: string): Record<string, unknown> {
  return { jsonrpc: '2.0', method }
}

function toolCall(
  id: number,
  args: Record<string, unknown>,
  name = 'retrieve',
): Record<string, unknown> {
  return request(id, 'tools/call', { name, arguments: args })
}

function result(response: JsonRpcResponse): ToolResult {
  if (!response.result || typeof response.result !== 'object') {
    throw new Error('Expected an object JSON-RPC result')
  }
  return response.result as ToolResult
}

function textResult(response: JsonRpcResponse): string {
  const text = result(response).content?.[0]?.text
  if (typeof text !== 'string') throw new Error('Expected MCP text content')
  return text
}

function fakeController(
  state: 'starting' | 'reconciling' | 'idle' | 'failed' = 'reconciling',
): {
  controller: ReconciliationController
  stop: ReturnType<typeof vi.fn>
} {
  const stop = vi.fn()
  return {
    stop,
    controller: {
      startupComplete: () => state !== 'starting',
      failureReason: () => state === 'failed' ? 'fixture failure' : null,
      state: () => state,
      acceptedBuildId: () => null,
      stop,
      completed: Promise.resolve(),
    },
  }
}

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function runServer(
  lines: readonly string[],
  overrides: Partial<McpServerOptions> = {},
): Promise<{
  responses: JsonRpcResponse[]
  stderr: string
}> {
  const cwd = mkdtempSync(join(tmpdir(), 'madar-thin-mcp-'))
  temporaryRoots.push(cwd)
  const input = new PassThrough()
  const output = new PassThrough()
  const errorOutput = new PassThrough()
  let stdout = ''
  let stderr = ''
  output.on('data', (chunk) => {
    stdout += chunk.toString('utf8')
  })
  errorOutput.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })

  const serving = serveMcpServer({
    version: '0.32.0-test',
    cwd,
    input,
    output,
    errorOutput,
    ...overrides,
  })
  input.end(`${lines.join('\n')}\n`)
  await serving
  return {
    responses: stdout.trim().length === 0
      ? []
      : stdout.trim().split('\n').map((line) =>
          JSON.parse(line) as JsonRpcResponse),
    stderr,
  }
}

describe('MCP tools-only protocol', () => {
  it('initializes with only tools capability and exposes exactly retrieve', async () => {
    const context = {
      version: '0.32.0-test',
      loadQueryIndex: vi.fn(() => failedQueryIndex('unavailable', 'fixture')),
    }
    const initialized = await handleMcpProtocolRequest(
      request(1, 'initialize'),
      context,
    )
    const listed = await handleMcpProtocolRequest(
      request(2, 'tools/list'),
      context,
    )

    expect(initialized).not.toBeNull()
    expect(result(initialized!)).toMatchObject({
      protocolVersion: '2025-11-25',
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: 'madar',
        title: 'Madar',
        version: '0.32.0-test',
      },
    })
    expect(Object.keys(
      result(initialized!).capabilities as Record<string, unknown>,
    )).toEqual(['tools'])
    expect(result(listed!).tools?.map((tool) => tool.name)).toEqual(['retrieve'])
    expect(result(listed!).tools?.[0]).toMatchObject({
      description: expect.stringContaining('authenticated answer dossier'),
      inputSchema: {
        properties: {
          budget: {
            type: 'integer',
            minimum: 1,
            default: 4000,
          },
        },
      },
    })
    expect(context.loadQueryIndex).not.toHaveBeenCalled()
  })

  it('supports ping and ignores notifications without starting graph work', async () => {
    const context = {
      version: 'test',
      loadQueryIndex: vi.fn(() => failedQueryIndex('unavailable', 'fixture')),
    }

    await expect(handleMcpProtocolRequest(
      request(1, 'ping'),
      context,
    )).resolves.toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {},
    })
    await expect(handleMcpProtocolRequest(
      notification('notifications/initialized'),
      context,
    )).resolves.toBeNull()
    await expect(handleMcpProtocolRequest(
      notification('notifications/cancelled'),
      context,
    )).resolves.toBeNull()
    expect(context.loadQueryIndex).not.toHaveBeenCalled()
  })

  it.each(['resources/list', 'resources/read', 'prompts/list', 'prompts/get'])(
    'does not surface retired MCP method %s',
    async (method) => {
      const response = await handleMcpProtocolRequest(
        request(3, method),
        { version: 'test', loadQueryIndex: vi.fn() },
      )
      expect(response?.error).toEqual({
        code: -32601,
        message: `Method not found: ${method}`,
      })
    },
  )

  it('validates the tool name and input before invoking the loader', async () => {
    const loadQueryIndex = vi.fn(() =>
      failedQueryIndex('unavailable', 'fixture'))
    const context = { version: 'test', loadQueryIndex }
    const invalidRequests = [
      toolCall(1, { question: 'where?' }, 'context_pack'),
      request(2, 'tools/call', { name: 'retrieve' }),
      toolCall(3, { question: '' }),
      toolCall(4, { question: 'where?', budget: 0 }),
      toolCall(5, { question: 'where?', semantic: true }),
      toolCall(6, { question: 'x'.repeat(513) }),
    ]

    for (const payload of invalidRequests) {
      const response = await handleMcpProtocolRequest(payload, context)
      expect(response?.error).toBeDefined()
    }
    expect(loadQueryIndex).not.toHaveBeenCalled()
  })

  it('returns byte-identical canonical application output', async () => {
    const index = failedQueryIndex(
      'unavailable',
      'canonical graph for current workspace',
    )
    const input = { question: 'Where is auth?', budget: 512 }
    const response = await handleMcpProtocolRequest(toolCall(7, input), {
      version: 'test',
      loadQueryIndex: () => index,
    })
    const expected = serializeRetrieveContextResult(
      retrieveContext(index, input),
    )

    expect(textResult(response!)).toBe(expected)
    expect(Buffer.from(textResult(response!))).toEqual(Buffer.from(expected))
  })

  it('returns stable JSON-RPC errors for malformed requests and failures', async () => {
    const context = {
      version: 'test',
      loadQueryIndex: vi.fn(() => {
        throw new Error('private failure detail')
      }),
    }

    await expect(handleMcpProtocolRequest(null, context)).resolves.toMatchObject({
      error: { code: -32600, message: 'Invalid request' },
    })
    await expect(handleMcpProtocolRequest(
      { jsonrpc: '2.0', id: 2 },
      context,
    )).resolves.toMatchObject({
      error: { code: -32600, message: 'Invalid request: missing method' },
    })
    await expect(handleMcpProtocolRequest(
      request(3, 'removed/method'),
      context,
    )).resolves.toMatchObject({
      error: { code: -32601, message: 'Method not found: removed/method' },
    })
    await expect(handleMcpProtocolRequest(
      toolCall(4, { question: 'Where is auth?' }),
      context,
    )).resolves.toMatchObject({
      error: { code: -32000, message: 'Madar request failed' },
    })
  })
})

describe('MCP reconciliation lifecycle', () => {
  it('sends initialize and tools/list before starting exactly one controller', async () => {
    const fixture = fakeController()
    const starter = vi.fn<ReconcilerStarter>(() => fixture.controller)
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    const cwd = mkdtempSync(join(tmpdir(), 'madar-thin-mcp-order-'))
    temporaryRoots.push(cwd)
    const startCountsAtResponse: number[] = []
    output.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').trim().split('\n')) {
        if (line.length === 0) continue
        const response = JSON.parse(line) as JsonRpcResponse
        if (response.id === 1 || response.id === 2 || response.id === 3) {
          startCountsAtResponse.push(starter.mock.calls.length)
        }
      }
    })

    const serving = serveMcpServer({
      version: 'test',
      cwd,
      input,
      output,
      errorOutput,
      reconcilerStarter: starter,
    })
    input.end([
      JSON.stringify(request(1, 'tools/list')),
      JSON.stringify(request(2, 'initialize')),
      JSON.stringify(request(3, 'tools/list')),
      '',
    ].join('\n'))
    await serving

    expect(startCountsAtResponse).toEqual([0, 0, 1])
    expect(starter).toHaveBeenCalledTimes(1)
    expect(starter.mock.calls[0]?.[0]).toBe(cwd)
    expect(fixture.stop).toHaveBeenCalledTimes(1)
  })

  it('returns terminal unavailable within the capped wait with no retry instruction', async () => {
    const fixture = fakeController('reconciling')
    const starter = vi.fn<ReconcilerStarter>(() => fixture.controller)
    const { responses } = await runServer([
      JSON.stringify(request(1, 'initialize')),
      JSON.stringify(request(2, 'tools/list')),
      JSON.stringify(toolCall(3, { question: 'Where is auth?' })),
    ], {
      requestWaitMs: 0,
      reconcilerStarter: starter,
    })
    const response = responses.find((entry) => entry.id === 3)
    const text = textResult(response!)

    expect(JSON.parse(text)).toMatchObject({
      schema: 'madar.retrieve',
      version: 2,
      state: 'unavailable',
      failures: [{
        state: 'unavailable',
        subject: 'canonical graph for current workspace',
      }],
      metrics: {
        selected_files: 0,
        authenticated_excerpts: 0,
      },
    })
    expect(JSON.parse(text)).not.toHaveProperty('dossier')
    expect(JSON.parse(text)).not.toHaveProperty('missing')
    expect(text.toLowerCase()).not.toContain('retry')
    expect(response?.error).toBeUndefined()
    expect(starter).toHaveBeenCalledTimes(1)
    expect(fixture.stop).toHaveBeenCalledTimes(1)
    expect(SERVER_SOURCE).toContain('const MAX_REQUEST_WAIT_MS = 25_000')
    expect(SERVER_SOURCE).toContain('Math.min(\n    MAX_REQUEST_WAIT_MS')
  })

  it('builds a missing graph and completes the cold first retrieve', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'madar-thin-mcp-cold-'))
    temporaryRoots.push(cwd)
    execFileSync('git', ['init'], { cwd, stdio: 'pipe' })
    execFileSync('git', ['config', 'user.email', 'madar-tests@example.com'], { cwd })
    execFileSync('git', ['config', 'user.name', 'Madar Tests'], { cwd })
    mkdirSync(join(cwd, 'src'))
    writeFileSync(
      join(cwd, 'src', 'payment-retry.ts'),
      'export function retryPayment(): string { return "retried" }\n',
    )
    execFileSync('git', ['add', '.'], { cwd })
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd, stdio: 'pipe' })
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    let stdout = ''
    let resolveCall!: () => void
    const called = new Promise<void>((resolvePromise) => {
      resolveCall = resolvePromise
    })
    output.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      if (stdout.split('\n').some((line) => line.includes('"id":3'))) {
        input.end()
        resolveCall()
      }
    })
    const serving = serveMcpServer({
      version: 'test',
      cwd,
      input,
      output,
      errorOutput,
      requestWaitMs: 20_000,
    })
    input.write([
      JSON.stringify(request(1, 'initialize')),
      JSON.stringify(request(2, 'tools/list')),
      JSON.stringify(toolCall(3, { question: 'Where is payment retry?' })),
      '',
    ].join('\n'))
    await called
    await serving

    const response = stdout.trim().split('\n')
      .map((line) => JSON.parse(line) as JsonRpcResponse)
      .find((entry) => entry.id === 3)
    const retrieved = JSON.parse(textResult(response!)) as {
      schema: string
      version: number
      state: string
      dossier?: {
        obligations: Array<{ proofs: string[] }>
        evidence: {
          files: Array<{ path: string }>
          entities: Array<{ kind: string; label?: string }>
        }
      }
    }
    expect(retrieved).toMatchObject({
      schema: 'madar.retrieve',
      version: 2,
      state: 'ready',
    })
    expect(retrieved).not.toHaveProperty('missing')
    expect(retrieved.dossier?.evidence.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/payment-retry.ts' }),
    ]))
    expect(retrieved.dossier?.evidence.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'symbol', label: 'retryPayment()' }),
    ]))
    expect(retrieved.dossier?.obligations.length).toBeGreaterThan(0)
    expect(retrieved.dossier?.obligations.every((claim) => claim.proofs.length > 0))
      .toBe(true)
  }, 30_000)

  it('keeps the stream alive after parse and oversized-line errors', async () => {
    const { responses } = await runServer([
      '{not json}',
      'x'.repeat(MAX_STDIO_LINE_BYTES + 1),
      JSON.stringify(request(9, 'ping')),
    ])

    expect(responses).toEqual([
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      },
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: `Payload too large (max ${MAX_STDIO_LINE_BYTES} bytes)`,
        },
      },
      {
        jsonrpc: '2.0',
        id: 9,
        result: {},
      },
    ])
  })

  it('bounds an unterminated oversized line before recovering at the newline', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    const cwd = mkdtempSync(join(tmpdir(), 'madar-thin-mcp-bounded-'))
    temporaryRoots.push(cwd)
    let stdout = ''
    output.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    const serving = serveMcpServer({
      version: 'test',
      cwd,
      input,
      output,
      errorOutput,
    })
    for (let written = 0; written <= MAX_STDIO_LINE_BYTES; written += 4096) {
      input.write('x'.repeat(Math.min(4096, MAX_STDIO_LINE_BYTES + 1 - written)))
    }
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
    expect(stdout).toBe('')
    input.end(`\n${JSON.stringify(request(9, 'ping'))}\n`)
    await serving

    expect(stdout).toContain(`Payload too large (max ${MAX_STDIO_LINE_BYTES} bytes)`)
    expect(stdout).toContain('"id":9')
  })

  it('stops the process-local controller on an external abort', async () => {
    const fixture = fakeController()
    const starter = vi.fn<ReconcilerStarter>(() => fixture.controller)
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    const signal = new AbortController()
    const cwd = mkdtempSync(join(tmpdir(), 'madar-thin-mcp-abort-'))
    temporaryRoots.push(cwd)
    let responseCount = 0
    output.on('data', (chunk) => {
      responseCount += chunk.toString('utf8')
        .split('\n')
        .filter((line: string) => line.length > 0)
        .length
      if (responseCount === 2) signal.abort()
    })

    const serving = serveMcpServer({
      version: 'test',
      cwd,
      input,
      output,
      errorOutput,
      signal: signal.signal,
      reconcilerStarter: starter,
    })
    input.write(`${JSON.stringify(request(1, 'initialize'))}\n`)
    input.write(`${JSON.stringify(request(2, 'tools/list'))}\n`)
    await serving

    expect(starter).toHaveBeenCalledTimes(1)
    expect(fixture.stop).toHaveBeenCalled()
  })

  it('cancels an active reconciliation wait promptly on external abort', async () => {
    const fixture = fakeController('reconciling')
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    const signal = new AbortController()
    const cwd = mkdtempSync(join(tmpdir(), 'madar-thin-mcp-active-abort-'))
    temporaryRoots.push(cwd)
    const serving = serveMcpServer({
      version: 'test',
      cwd,
      input,
      output,
      errorOutput,
      signal: signal.signal,
      reconcilerStarter: () => fixture.controller,
    })
    input.write([
      JSON.stringify(request(1, 'initialize')),
      JSON.stringify(request(2, 'tools/list')),
      JSON.stringify(toolCall(3, { question: 'Where is auth?' })),
      '',
    ].join('\n'))
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20))
    const started = Date.now()
    signal.abort()
    await serving

    expect(Date.now() - started).toBeLessThan(500)
    expect(fixture.stop).toHaveBeenCalled()
  })

  it('does not wait for a reconciler starter that ignores abort', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    const signal = new AbortController()
    const cwd = mkdtempSync(join(tmpdir(), 'madar-thin-mcp-hung-start-'))
    temporaryRoots.push(cwd)
    const serving = serveMcpServer({
      version: 'test',
      cwd,
      input,
      output,
      errorOutput,
      signal: signal.signal,
      reconcilerStarter: () => new Promise<ReconciliationController>(() => {}),
    })
    input.write(`${JSON.stringify(request(1, 'initialize'))}\n`)
    input.write(`${JSON.stringify(request(2, 'tools/list'))}\n`)
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20))
    signal.abort()

    await expect(Promise.race([
      serving.then(() => 'settled'),
      new Promise<string>((resolvePromise) =>
        setTimeout(() => resolvePromise('timed-out'), 250)),
    ])).resolves.toBe('settled')
  })

  it('cleans deadline listeners after repeated sequential calls', async () => {
    const fixture = fakeController('idle')
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    const cwd = mkdtempSync(join(tmpdir(), 'madar-thin-mcp-deadlines-'))
    temporaryRoots.push(cwd)
    const pending = new Map<number, (response: JsonRpcResponse) => void>()
    let buffered = ''
    output.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        const response = JSON.parse(line) as JsonRpcResponse
        if (typeof response.id === 'number') pending.get(response.id)?.(response)
      }
    })
    const serving = serveMcpServer({
      version: 'test',
      cwd,
      input,
      output,
      errorOutput,
      reconcilerStarter: () => fixture.controller,
    })
    const send = async (payload: Record<string, unknown>): Promise<JsonRpcResponse> =>
      await new Promise((resolvePromise) => {
        pending.set(payload.id as number, resolvePromise)
        input.write(`${JSON.stringify(payload)}\n`)
      })
    const warnings: Error[] = []
    const warning = (value: Error): void => { warnings.push(value) }
    process.on('warning', warning)
    try {
      await send(request(1, 'initialize'))
      await send(request(2, 'tools/list'))
      for (let id = 3; id < 23; id += 1) {
        await send(toolCall(id, { question: 'Where is auth?' }))
      }
      input.end()
      await serving
    } finally {
      process.removeListener('warning', warning)
    }
    expect(warnings.filter((value) => value.name === 'MaxListenersExceededWarning'))
      .toEqual([])
  })
})
