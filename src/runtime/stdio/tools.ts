import {
  retrieveContext,
  serializeRetrieveContextResult,
} from '../../application/retrieve-context.js'
import type { GraphArtifactReceipt } from '../../adapters/filesystem/graph-artifact.js'
import {
  failedQueryIndex,
  inspectQueryIndex,
  type QueryIndex,
} from '../../domain/query/index-status.js'

interface StdioResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

interface ToolHelpers {
  ok(id: string | number | null, result: unknown): StdioResponse
  failure(id: string | number | null, code: number, message: string): StdioResponse
  loadGraphReceipt(graphPath: string): GraphArtifactReceipt
  jsonrpcInvalidParams: number
  jsonrpcMethodNotFound: number
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function unavailableGraphError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') return true
  const message = error instanceof Error ? error.message : ''
  return /not found|does not exist|permission denied/i.test(message)
}

function loadQueryIndex(graphPath: string, helpers: ToolHelpers): QueryIndex {
  try {
    return inspectQueryIndex(helpers.loadGraphReceipt(graphPath).graph)
  } catch (error) {
    return failedQueryIndex(
      unavailableGraphError(error) ? 'unavailable' : 'corrupt',
      'canonical graph artifact',
    )
  }
}

export function handleToolCall(
  id: string | number | null,
  graphPath: string,
  params: unknown,
  helpers: ToolHelpers,
): StdioResponse {
  const call = record(params)
  if (!call || typeof call.name !== 'string') {
    return helpers.failure(
      id,
      helpers.jsonrpcInvalidParams,
      'tools/call requires a string name and an arguments object',
    )
  }
  if (call.name !== 'retrieve') {
    return helpers.failure(
      id,
      helpers.jsonrpcMethodNotFound,
      `Unknown tool: ${call.name}`,
    )
  }

  const input = record(call.arguments)
  if (!input) {
    return helpers.failure(
      id,
      helpers.jsonrpcInvalidParams,
      'retrieve requires an arguments object',
    )
  }

  try {
    const result = retrieveContext(loadQueryIndex(graphPath, helpers), input)
    return helpers.ok(id, {
      content: [
        {
          type: 'text',
          text: serializeRetrieveContextResult(result),
        },
      ],
    })
  } catch (error) {
    return helpers.failure(
      id,
      helpers.jsonrpcInvalidParams,
      error instanceof Error ? error.message : 'Invalid retrieve input',
    )
  }
}
