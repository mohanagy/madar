import {
  DEFAULT_RETRIEVE_BUDGET,
  MAX_RETRIEVE_BUDGET,
  MAX_RETRIEVE_QUESTION_LENGTH,
  normalizeRetrieveRequest,
} from '../../domain/query/types.js'
import {
  retrieveContext,
  serializeRetrieveContextResult,
} from '../../application/retrieve-context.js'
import type { QueryIndex } from '../../domain/query/index-status.js'
export const MCP_PROTOCOL_VERSION = '2025-11-25'
export const MAX_STDIO_LINE_BYTES = 1_000_000
const JSONRPC_PARSE_ERROR = -32700
const JSONRPC_INVALID_REQUEST = -32600
const JSONRPC_METHOD_NOT_FOUND = -32601
const JSONRPC_INVALID_PARAMS = -32602
const JSONRPC_SERVER_ERROR = -32000
export type JsonRpcId = string | number | null
export interface JsonRpcRequest {
  id?: JsonRpcId
  method?: unknown
  params?: unknown
}
export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: {
    code: number
    message: string
  }
}
export interface McpProtocolContext {
  version: string
  loadQueryIndex(): Promise<QueryIndex> | QueryIndex
}
export interface McpToolDefinition {
  name: 'retrieve'
  description: string
  inputSchema: {
    type: 'object'
    additionalProperties: false
    required: readonly ['question']
    properties: {
      question: Record<string, unknown>
      budget: Record<string, unknown>
    }
  }
}
export const MCP_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'retrieve',
    description:
      'Return one deterministic authenticated answer dossier, or exact missing requirements, for a TypeScript or JavaScript codebase question.',
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['question'] as const),
      properties: Object.freeze({
        question: Object.freeze({
          type: 'string',
          minLength: 1,
          maxLength: MAX_RETRIEVE_QUESTION_LENGTH,
          description: 'A locate, explain, or workflow question to prove from the indexed graph.',
        }),
        budget: Object.freeze({
          type: 'integer',
          minimum: 1,
          default: DEFAULT_RETRIEVE_BUDGET,
          description: 'Omit for default',
        }),
      }),
    }),
  }),
])
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
export function requestMethod(payload: unknown): string | null {
  const request = record(payload)
  return request && typeof request.method === 'string' ? request.method : null
}
export function requestId(payload: unknown): JsonRpcId {
  const request = record(payload)
  if (!request || !Object.hasOwn(request, 'id')) return null
  const id = request.id
  return typeof id === 'string' || typeof id === 'number' || id === null
    ? id
    : null
}
function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}
export function protocolError(
  id: JsonRpcId,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}
export function parseError(message = 'Parse error'): JsonRpcResponse {
  return protocolError(null, JSONRPC_PARSE_ERROR, message)
}
export function invalidRequest(message = 'Invalid request'): JsonRpcResponse {
  return protocolError(null, JSONRPC_INVALID_REQUEST, message)
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Invalid retrieve input'
}
export async function handleMcpProtocolRequest(
  payload: unknown,
  context: McpProtocolContext,
): Promise<JsonRpcResponse | null> {
  const request = record(payload)
  if (!request || request.jsonrpc !== '2.0') return invalidRequest()
  const id = requestId(request)
  const method = requestMethod(request)
  if (!method) {
    return protocolError(id, JSONRPC_INVALID_REQUEST, 'Invalid request: missing method')
  }
  if (!Object.hasOwn(request, 'id')) return null
  switch (method) {
    case 'initialize':
      return success(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: 'madar',
          title: 'Madar',
          version: context.version,
        },
        instructions:
          'Call retrieve once with the codebase question. State ready contains a complete authenticated dossier; every other state names the exact missing or terminal condition. Do not infer omitted workflow steps.',
      })
    case 'ping':
      return success(id, {})
    case 'tools/list':
      return success(id, { tools: MCP_TOOLS })
    case 'tools/call': {
      const params = record(request.params)
      if (!params || typeof params.name !== 'string') {
        return protocolError(
          id,
          JSONRPC_INVALID_PARAMS,
          'tools/call requires a string name and an arguments object',
        )
      }
      if (params.name !== 'retrieve') {
        return protocolError(
          id,
          JSONRPC_METHOD_NOT_FOUND,
          `Unknown tool: ${params.name}`,
        )
      }
      const input = record(params.arguments)
      if (!input) {
        return protocolError(
          id,
          JSONRPC_INVALID_PARAMS,
          'retrieve requires an arguments object',
        )
      }
      let normalized
      try {
        normalized = normalizeRetrieveRequest(input)
      } catch (error) {
        return protocolError(id, JSONRPC_INVALID_PARAMS, errorMessage(error))
      }
      try {
        const index = await context.loadQueryIndex()
        return success(id, {
          content: [{
            type: 'text',
            text: serializeRetrieveContextResult(
              retrieveContext(index, normalized),
            ),
          }],
        })
      } catch {
        return protocolError(id, JSONRPC_SERVER_ERROR, 'Madar request failed')
      }
    }
    default:
      return protocolError(
        id,
        JSONRPC_METHOD_NOT_FOUND,
        `Method not found: ${method}`,
      )
  }
}
export function serverFailure(payload: unknown): JsonRpcResponse {
  return protocolError(
    requestId(payload),
    JSONRPC_SERVER_ERROR,
    'Madar request failed',
  )
}
