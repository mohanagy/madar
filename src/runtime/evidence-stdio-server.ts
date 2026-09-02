import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

import { EvidenceNavigator, type LocationRequest } from './evidence-navigation.js'

const JSONRPC_PARSE_ERROR = -32700
const JSONRPC_INVALID_REQUEST = -32600
const JSONRPC_METHOD_NOT_FOUND = -32601
const JSONRPC_INVALID_PARAMS = -32602
const JSONRPC_SERVER_ERROR = -32000
const MCP_PROTOCOL_VERSION = '2025-11-25'
const MCP_SERVER_NAME = 'madar-evidence'
const MCP_SERVER_TITLE = 'Madar Interactive Evidence Prototype'
const MCP_SERVER_VERSION = '0.1.0-prototype'
const MAX_INPUT_TEXT = 4_096
const MAX_LIMIT = 500

interface JsonRpcRequest {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface EvidenceStdioOptions {
  rootDir: string
  input?: Readable
  output?: Writable
  errorOutput?: Writable
}

export const EVIDENCE_MCP_TOOLS: ToolDefinition[] = [
  {
    name: 'resolve_anchor',
    description: 'Resolve an explicit repository path, literal, TypeScript symbol, or static route exactly. Exact evidence is never displaced by fuzzy ranking; ambiguity is returned explicitly.',
    inputSchema: {
      type: 'object',
      required: ['anchor'],
      properties: {
        anchor: { type: 'string', description: 'Exact path, literal, symbol, qualified symbol, or METHOD /route anchor.' },
        limit: { type: 'number', description: 'Maximum candidates to return (default 100, max 500).' },
      },
    },
  },
  {
    name: 'search_exact',
    description: 'Return exact repository text occurrences for one literal. No semantic or graph ranking is applied.',
    inputSchema: {
      type: 'object',
      required: ['literal'],
      properties: {
        literal: { type: 'string', description: 'Exact UTF-8 text to find.' },
        limit: { type: 'number', description: 'Maximum occurrences to return (default 100, max 500).' },
      },
    },
  },
  {
    name: 'read_evidence',
    description: 'Read a bounded line range from one exact repository-relative file. Absolute paths, traversal, and symlink escapes are refused.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Repository-relative file path.' },
        start_line: { type: 'number', description: '1-based inclusive start line (default 1).' },
        end_line: { type: 'number', description: '1-based inclusive end line (default start+79; max 400 returned lines).' },
      },
    },
  },
  {
    name: 'definition',
    description: 'Ask the pinned TypeScript Language Service for the definition of an exact symbol or source location. Unsupported project/provider states are explicit.',
    inputSchema: {
      type: 'object',
      properties: {
        anchor: { type: 'string', description: 'Exact symbol or qualified symbol. Ambiguous symbols must be disambiguated with a source location.' },
        path: { type: 'string', description: 'Repository-relative source path for location-based navigation.' },
        line: { type: 'number', description: '1-based line when path is supplied.' },
        column: { type: 'number', description: '1-based column when path is supplied.' },
        limit: { type: 'number', description: 'Maximum ambiguous symbol candidates (default 100, max 500).' },
      },
    },
  },
  {
    name: 'references',
    description: 'Ask the pinned TypeScript Language Service for references to an exact symbol or source location. Results are provider references, not a claim of every runtime caller.',
    inputSchema: {
      type: 'object',
      properties: {
        anchor: { type: 'string', description: 'Exact symbol or qualified symbol. Ambiguous symbols must be disambiguated with a source location.' },
        path: { type: 'string', description: 'Repository-relative source path for location-based navigation.' },
        line: { type: 'number', description: '1-based line when path is supplied.' },
        column: { type: 'number', description: '1-based column when path is supplied.' },
        limit: { type: 'number', description: 'Maximum references to return (default 100, max 500).' },
      },
    },
  },
]

function requestId(request: JsonRpcRequest): string | number | null {
  return typeof request.id === 'string' || typeof request.id === 'number' || request.id === null ? request.id : null
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function failure(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringValue(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key]
  if (typeof value !== 'string') return null
  if (value.length === 0 || value.length > MAX_INPUT_TEXT) return null
  return value
}

function integerValue(record: Record<string, unknown> | null, key: string, min: number, max: number): number | null {
  const value = record?.[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null
}

function locationRequest(argumentsRecord: Record<string, unknown> | null): LocationRequest | null {
  const anchor = stringValue(argumentsRecord, 'anchor')
  const path = stringValue(argumentsRecord, 'path')
  if (!anchor && !path) return null
  const line = integerValue(argumentsRecord, 'line', 1, 10_000_000)
  const column = integerValue(argumentsRecord, 'column', 1, 10_000_000)
  const limit = integerValue(argumentsRecord, 'limit', 1, MAX_LIMIT)
  return {
    ...(anchor ? { anchor } : {}),
    ...(path ? { path } : {}),
    ...(line !== null ? { line } : {}),
    ...(column !== null ? { column } : {}),
    ...(limit !== null ? { limit } : {}),
  }
}

function toolTextResult(value: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown } {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  }
}

export function handleEvidenceMcpRequest(
  navigator: EvidenceNavigator,
  payload: unknown,
): JsonRpcResponse | null {
  const request = asRecord(payload) as JsonRpcRequest | null
  if (!request || typeof request.method !== 'string') {
    return failure(null, JSONRPC_INVALID_REQUEST, 'Invalid JSON-RPC request')
  }
  const id = requestId(request)

  if (request.method === 'notifications/initialized') return null
  if (request.method === 'ping') return ok(id, {})
  if (request.method === 'initialize') {
    return ok(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, title: MCP_SERVER_TITLE, version: MCP_SERVER_VERSION },
      instructions: 'Use exact evidence navigation incrementally. Resolve explicit anchors before broader exploration. Ambiguity and unsupported states are valid outcomes; never treat them as evidence absence.',
    })
  }
  if (request.method === 'tools/list') return ok(id, { tools: EVIDENCE_MCP_TOOLS })
  if (request.method !== 'tools/call') return failure(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${request.method}`)

  const params = asRecord(request.params)
  const name = stringValue(params, 'name')
  if (!name) return failure(id, JSONRPC_INVALID_PARAMS, 'tools/call requires a valid string name')
  const argumentsRecord = asRecord(params?.arguments)

  try {
    switch (name) {
      case 'resolve_anchor': {
        const anchor = stringValue(argumentsRecord, 'anchor')
        if (!anchor) return failure(id, JSONRPC_INVALID_PARAMS, 'resolve_anchor requires a non-empty string anchor')
        const limit = integerValue(argumentsRecord, 'limit', 1, MAX_LIMIT) ?? undefined
        return ok(id, toolTextResult(navigator.resolveAnchor(anchor, limit)))
      }
      case 'search_exact': {
        const literal = stringValue(argumentsRecord, 'literal')
        if (!literal) return failure(id, JSONRPC_INVALID_PARAMS, 'search_exact requires a non-empty string literal')
        const limit = integerValue(argumentsRecord, 'limit', 1, MAX_LIMIT) ?? undefined
        return ok(id, toolTextResult(navigator.searchExact(literal, limit)))
      }
      case 'read_evidence': {
        const path = stringValue(argumentsRecord, 'path')
        if (!path) return failure(id, JSONRPC_INVALID_PARAMS, 'read_evidence requires a repository-relative path')
        const startLine = integerValue(argumentsRecord, 'start_line', 1, 10_000_000) ?? 1
        const endLine = integerValue(argumentsRecord, 'end_line', startLine, 10_000_000) ?? startLine + 79
        return ok(id, toolTextResult(navigator.readEvidence(path, startLine, endLine)))
      }
      case 'definition': {
        const location = locationRequest(argumentsRecord)
        if (!location) return failure(id, JSONRPC_INVALID_PARAMS, 'definition requires anchor or path; path navigation may include line and column')
        return ok(id, toolTextResult(navigator.definition(location)))
      }
      case 'references': {
        const location = locationRequest(argumentsRecord)
        if (!location) return failure(id, JSONRPC_INVALID_PARAMS, 'references requires anchor or path; path navigation may include line and column')
        return ok(id, toolTextResult(navigator.references(location)))
      }
      default:
        return failure(id, JSONRPC_METHOD_NOT_FOUND, `Unknown evidence tool: ${name}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Evidence navigation failed'
    return failure(id, JSONRPC_SERVER_ERROR, message)
  }
}

export async function serveEvidenceStdio(options: EvidenceStdioOptions): Promise<void> {
  const navigator = new EvidenceNavigator({ rootDir: options.rootDir })
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const errorOutput = options.errorOutput ?? process.stderr
  errorOutput.write(`[madar evidence] stdio ready for ${navigator.rootDir}\n`)

  const readline = createInterface({ input, crlfDelay: Infinity })
  for await (const line of readline) {
    if (line.trim().length === 0) continue
    let payload: unknown
    try {
      payload = JSON.parse(line)
    } catch {
      output.write(`${JSON.stringify(failure(null, JSONRPC_PARSE_ERROR, 'Parse error'))}\n`)
      continue
    }
    const response = handleEvidenceMcpRequest(navigator, payload)
    if (response) output.write(`${JSON.stringify(response)}\n`)
  }
}
