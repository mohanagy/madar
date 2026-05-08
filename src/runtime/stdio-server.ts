import { createInterface } from 'node:readline'
import { statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { Readable, Writable } from 'node:stream'

import type { ContextSessionState } from '../contracts/context-session.js'
import { compareRefs } from '../infrastructure/time-travel.js'
import { diffGraphs } from './diff.js'
import { MCP_PROMPTS, MCP_TOOLS, activeMcpTools, isCoreToolName, resolveToolProfileFromEnv, type McpPromptDefinition } from './stdio/definitions.js'
import { handleCompletion, handlePromptGet, promptDefinitionsForGraph, readStoredCommunityLabels } from './stdio/prompts.js'
import {
  emitResourceNotifications,
  handleResourceRead,
  handleResourceSubscribe,
  handleResourceUnsubscribe,
  resourcesForGraph,
  type ResourceSessionState,
} from './stdio/resources.js'
import { handleToolCall as handleToolCallRequest } from './stdio/tools.js'
import {
  communitiesFromGraph,
  getCommunity,
  getNeighbors,
  getNode,
  godNodesSummary,
  graphStats,
  loadGraph,
  queryGraph,
  semanticAnomaliesSummary,
  shortestPath,
} from './serve.js'
import { validateGraphPath } from '../shared/security.js'

const JSONRPC_PARSE_ERROR = -32700
const JSONRPC_INVALID_REQUEST = -32600
const JSONRPC_INVALID_PARAMS = -32602
const JSONRPC_METHOD_NOT_FOUND = -32601
const JSONRPC_SERVER_ERROR = -32000
const MCP_PROTOCOL_VERSION = '2025-11-25'
const MCP_SERVER_NAME = 'graphify-ts'
const MCP_SERVER_TITLE = 'Graphify TS'
const MCP_SERVER_VERSION = '0.1.0'
const MAX_STDIO_LINE_BYTES = 1_000_000
const MAX_STDIO_TEXT_LENGTH = 512
const MAX_STDIO_TOKEN_BUDGET = 100_000
const MAX_STDIO_DEPTH = 20
const MAX_STDIO_HOPS = 20
const MAX_STDIO_RESOURCE_BYTES = 5_000_000
const MAX_STDIO_DIFF_ITEMS = 100
const MAX_RESOURCE_SUBSCRIPTIONS = 16
const MAX_CONTEXT_PROMPT_SESSIONS = 256
const graphCache = new Map<string, { mtimeMs: number; graph: ReturnType<typeof loadGraph> }>()
const MAX_COMPLETION_VALUES = 25
const MAX_LOG_NOTIFICATION_CHARS = 10_000

type McpLogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency'

interface StdioSessionState extends ResourceSessionState {
  logLevel: McpLogLevel
  contextPromptSessions?: Map<string, ContextSessionState>
  contextPackHandles?: Map<string, unknown>
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

interface StdioToolOverrides {
  compareRefs?: typeof compareRefs
}

const DEFAULT_STDIO_LOG_LEVEL: McpLogLevel = 'info'
const LOG_LEVEL_PRIORITY: Record<McpLogLevel, number> = {
  debug: 10,
  info: 20,
  notice: 30,
  warning: 40,
  error: 50,
  critical: 60,
  alert: 70,
  emergency: 80,
}

function createSessionState(): StdioSessionState {
  return {
    logLevel: DEFAULT_STDIO_LOG_LEVEL,
    subscribedResourceUris: new Set<string>(),
    resourceVersions: new Map<string, string>(),
    resourceListSignature: null,
    contextPromptSessions: new Map<string, ContextSessionState>(),
    contextPackHandles: new Map<string, unknown>(),
  }
}

interface StdioRequest {
  id?: string | number | null
  method?: unknown
  params?: unknown
}

interface StdioResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

export interface ServeGraphStdioOptions {
  graphPath: string
  input?: Readable
  output?: Writable
  errorOutput?: Writable
  logger?: {
    log(message?: string): void
    error(message?: string): void
  }
}

function ok(id: string | number | null, result: unknown): StdioResponse {
  return { jsonrpc: '2.0', id, result }
}

function failure(id: string | number | null, code: number, message: string): StdioResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  }
}

function notification(method: string, params?: unknown): JsonRpcNotification {
  return {
    jsonrpc: '2.0',
    method,
    ...(params !== undefined ? { params } : {}),
  }
}

function ensureSubscribedResourceUris(state: StdioSessionState): Set<string> {
  if (!state.subscribedResourceUris) {
    state.subscribedResourceUris = new Set<string>()
  }

  return state.subscribedResourceUris
}

function ensureResourceVersions(state: StdioSessionState): Map<string, string> {
  if (!state.resourceVersions) {
    state.resourceVersions = new Map<string, string>()
  }

  return state.resourceVersions
}

function ensureContextPromptSessions(state: StdioSessionState): Map<string, ContextSessionState> {
  if (!state.contextPromptSessions) {
    state.contextPromptSessions = new Map<string, ContextSessionState>()
  }

  return state.contextPromptSessions
}

function ensureContextPackHandles(state: StdioSessionState): Map<string, unknown> {
  if (!state.contextPackHandles) {
    state.contextPackHandles = new Map<string, unknown>()
  }

  return state.contextPackHandles
}

function requestId(request: StdioRequest): string | number | null {
  return typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null
}

function stringParam(params: unknown, key: string): string | null {
  if (!params || typeof params !== 'object' || !(key in params)) {
    return null
  }
  const value = (params as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length <= MAX_STDIO_TEXT_LENGTH ? value : null
}

function stringParamAlias(params: unknown, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = stringParam(params, key)
    if (value !== null) {
      return value
    }
  }

  return null
}

function numberParam(params: unknown, key: string, options: { min?: number; max?: number } = {}): number | null {
  if (!params || typeof params !== 'object' || !(key in params)) {
    return null
  }
  const value = (params as Record<string, unknown>)[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  if (options.min !== undefined && value < options.min) {
    return null
  }
  if (options.max !== undefined && value > options.max) {
    return null
  }
  return value
}

function numberParamAlias(params: unknown, keys: readonly string[], options: { min?: number; max?: number } = {}): number | null {
  for (const key of keys) {
    const value = numberParam(params, key, options)
    if (value !== null) {
      return value
    }
  }

  return null
}

function integerLikeParamAlias(params: unknown, keys: readonly string[], options: { min?: number; max?: number } = {}): number | null {
  for (const key of keys) {
    if (!params || typeof params !== 'object' || !(key in params)) {
      continue
    }

    const rawValue = (params as Record<string, unknown>)[key]
    const numericValue = typeof rawValue === 'number' ? rawValue : typeof rawValue === 'string' && /^\d+$/.test(rawValue.trim()) ? Number(rawValue.trim()) : null

    if (numericValue === null || !Number.isFinite(numericValue)) {
      continue
    }
    if (options.min !== undefined && numericValue < options.min) {
      continue
    }
    if (options.max !== undefined && numericValue > options.max) {
      continue
    }
    return numericValue
  }

  return null
}

function recordParam(params: unknown, key: string): Record<string, unknown> | null {
  if (!params || typeof params !== 'object' || !(key in params)) {
    return null
  }
  const value = (params as Record<string, unknown>)[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function hasParam(params: unknown, key: string): boolean {
  return Boolean(params && typeof params === 'object' && key in params)
}

function hasParamAlias(params: unknown, keys: readonly string[]): boolean {
  return keys.some((key) => hasParam(params, key))
}

function parseRankBy(value: string | null): 'relevance' | 'degree' | null {
  const normalized = value?.trim().toLowerCase() ?? ''
  if (!normalized) {
    return null
  }
  if (normalized === 'relevance' || normalized === 'degree') {
    return normalized
  }
  return null
}

function queryOptionsFromParams(id: string | number | null, params: unknown): { failureResponse?: StdioResponse; queryOptions?: Record<string, unknown> } {
  const mode = stringParam(params, 'mode') === 'dfs' ? 'dfs' : 'bfs'
  const depth = numberParam(params, 'depth', { min: 0, max: MAX_STDIO_DEPTH })
  const tokenBudget = numberParamAlias(params, ['token_budget', 'tokenBudget'], { min: 1, max: MAX_STDIO_TOKEN_BUDGET })
  const rawRankBy = stringParamAlias(params, ['rank_by', 'rankBy'])
  const rankBy = parseRankBy(rawRankBy)
  if (hasParamAlias(params, ['rank_by', 'rankBy']) && rankBy === null) {
    return {
      failureResponse: failure(id, JSONRPC_INVALID_PARAMS, 'rank_by must be one of relevance, degree'),
    }
  }

  const community = numberParamAlias(params, ['community_id', 'communityId'], { min: 0 })
  if (hasParamAlias(params, ['community_id', 'communityId']) && community === null) {
    return {
      failureResponse: failure(id, JSONRPC_INVALID_PARAMS, 'community_id must be a non-negative number'),
    }
  }

  const fileType = stringParamAlias(params, ['file_type', 'fileType'])
  const filters = {
    ...(community !== null ? { community } : {}),
    ...(fileType ? { fileType } : {}),
  }

  return {
    queryOptions: {
      mode,
      ...(depth !== null ? { depth } : {}),
      ...(tokenBudget !== null ? { tokenBudget } : {}),
      ...(rankBy ? { rankBy } : {}),
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
    },
  }
}

function graphDiffOptionsFromParams(id: string | number | null, params: unknown): { failureResponse?: StdioResponse; baselineGraphPath?: string; limit?: number } {
  const baselineGraphPath = stringParamAlias(params, ['baseline_graph_path', 'baselineGraphPath'])
  if (!baselineGraphPath) {
    return {
      failureResponse: failure(id, JSONRPC_INVALID_PARAMS, `baseline_graph_path requires a string parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`),
    }
  }

  const limit = numberParamAlias(params, ['limit'], { min: 1, max: MAX_STDIO_DIFF_ITEMS })
  if (hasParam(params, 'limit') && limit === null) {
    return {
      failureResponse: failure(id, JSONRPC_INVALID_PARAMS, `limit must be a number between 1 and ${MAX_STDIO_DIFF_ITEMS}`),
    }
  }

  return { baselineGraphPath, ...(limit !== null ? { limit } : {}) }
}

function shouldEmitLog(level: McpLogLevel, currentLevel: McpLogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLevel]
}

function parseLogLevel(value: string | null): McpLogLevel | null {
  switch (value) {
    case 'debug':
    case 'info':
    case 'notice':
    case 'warning':
    case 'error':
    case 'critical':
    case 'alert':
    case 'emergency':
      return value
    default:
      return null
  }
}

function emitLogNotification(output: Writable, state: StdioSessionState, level: McpLogLevel, data: unknown, logger = MCP_SERVER_NAME): void {
  if (!shouldEmitLog(level, state.logLevel)) {
    return
  }

  let payloadData: unknown
  try {
    const serialized = JSON.stringify(data)
    payloadData = serialized.length <= MAX_LOG_NOTIFICATION_CHARS ? data : `${serialized.slice(0, MAX_LOG_NOTIFICATION_CHARS)}... [truncated]`
  } catch {
    payloadData = String(data).slice(0, MAX_LOG_NOTIFICATION_CHARS)
  }

  try {
    output.write(
      `${JSON.stringify(
        notification('notifications/message', {
          level,
          logger,
          data: payloadData,
        }),
      )}\n`,
    )
  } catch {
    // Ignore broken pipe / closed stream cases; the client has already gone away.
  }
}

function textToolResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text }],
  }
}

function loadGraphCached(graphPath: string): ReturnType<typeof loadGraph> {
  const safeGraphPath = validateGraphPath(graphPath)
  const currentMtime = statSync(safeGraphPath).mtimeMs
  const cached = graphCache.get(safeGraphPath)
  if (cached && cached.mtimeMs === currentMtime) {
    return cached.graph
  }

  const graph = loadGraph(safeGraphPath)
  graphCache.set(safeGraphPath, { mtimeMs: currentMtime, graph })
  return graph
}

function sanitizePromptValue(value: string | null, fallback: string): string {
  if (!value) {
    return fallback
  }

  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return sanitized.length > 0 ? sanitized : fallback
}

function handleDirectQuery(graphPath: string, id: string | number | null, params: unknown): StdioResponse {
  const graph = loadGraphCached(graphPath)
  const question = stringParam(params, 'question')
  if (!question) {
    return failure(id, JSONRPC_INVALID_PARAMS, `query requires a string question parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
  }

  const { failureResponse, queryOptions } = queryOptionsFromParams(id, params)
  if (failureResponse) {
    return failureResponse
  }

  return ok(id, queryGraph(graph, question, queryOptions))
}

function handleGraphDiff(id: string | number | null, currentGraphPath: string, params: unknown): StdioResponse {
  const options = graphDiffOptionsFromParams(id, params)
  if (options.failureResponse) {
    return options.failureResponse
  }

  try {
    const baselineGraph = loadGraphCached(options.baselineGraphPath ?? currentGraphPath)
    const currentGraph = loadGraphCached(currentGraphPath)
    return ok(id, diffGraphs(baselineGraph, currentGraph, { ...(options.limit !== undefined ? { limit: options.limit } : {}) }))
  } catch (error) {
    return failure(id, JSONRPC_SERVER_ERROR, error instanceof Error ? error.message : 'Graph diff failed')
  }
}

export function handleStdioRequest(
  graphPath: string,
  payload: unknown,
  sessionState: StdioSessionState = createSessionState(),
  toolOverrides: StdioToolOverrides = {},
): StdioResponse | Promise<StdioResponse> | null {
  if (!payload || typeof payload !== 'object') {
    return failure(null, JSONRPC_INVALID_REQUEST, 'Invalid request')
  }

  const request = payload as StdioRequest
  const id = requestId(request)
  const method = typeof request.method === 'string' ? request.method : null
  if (!method) {
    return failure(id, JSONRPC_INVALID_REQUEST, 'Invalid request: missing method')
  }

  try {
    const params = request.params

    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            completions: {},
            logging: {},
            prompts: { listChanged: false },
            resources: { subscribe: true, listChanged: true },
            tools: { listChanged: false },
          },
          serverInfo: {
            name: MCP_SERVER_NAME,
            title: MCP_SERVER_TITLE,
            version: MCP_SERVER_VERSION,
          },
          instructions: 'Use tools/list to discover graph tools, then tools/call to query the generated graph.',
        })
      case 'notifications/initialized':
        return null
      case 'completion/complete':
        return handleCompletion(id, graphPath, params, {
          ok,
          failure,
          stringParam,
          stringParamAlias,
          integerLikeParamAlias,
          recordParam,
          jsonrpcInvalidParams: JSONRPC_INVALID_PARAMS,
          maxStdioTextLength: MAX_STDIO_TEXT_LENGTH,
          maxCompletionValues: MAX_COMPLETION_VALUES,
        })
      case 'logging/setLevel': {
        const requestedLevel = parseLogLevel(stringParam(params, 'level'))
        if (!requestedLevel) {
          return failure(id, JSONRPC_INVALID_PARAMS, 'logging/setLevel requires level to be one of debug, info, notice, warning, error, critical, alert, emergency')
        }
        sessionState.logLevel = requestedLevel
        return ok(id, {})
      }
      case 'prompts/list':
        return ok(id, { prompts: promptDefinitionsForGraph(graphPath) })
      case 'prompts/get':
        return handlePromptGet(id, graphPath, params, {
          ok,
          failure,
          stringParam,
          stringParamAlias,
          integerLikeParamAlias,
          recordParam,
          jsonrpcInvalidParams: JSONRPC_INVALID_PARAMS,
          maxStdioTextLength: MAX_STDIO_TEXT_LENGTH,
          maxCompletionValues: MAX_COMPLETION_VALUES,
        })
      case 'resources/list':
        return ok(id, {
          resources: resourcesForGraph(graphPath).map(({ uri, name, title, description, mimeType, annotations }) => ({
            uri,
            name,
            title,
            description,
            mimeType,
            annotations,
          })),
        })
      case 'resources/subscribe':
        return handleResourceSubscribe(id, graphPath, params, sessionState, {
          ok,
          failure,
          stringParam,
          ensureSubscribedResourceUris,
          ensureResourceVersions,
          jsonrpcInvalidParams: JSONRPC_INVALID_PARAMS,
          jsonrpcServerError: JSONRPC_SERVER_ERROR,
          maxStdioTextLength: MAX_STDIO_TEXT_LENGTH,
          maxResourceBytes: MAX_STDIO_RESOURCE_BYTES,
          maxResourceSubscriptions: MAX_RESOURCE_SUBSCRIPTIONS,
        })
      case 'resources/unsubscribe':
        return handleResourceUnsubscribe(id, params, sessionState, {
          ok,
          failure,
          stringParam,
          ensureSubscribedResourceUris,
          ensureResourceVersions,
          jsonrpcInvalidParams: JSONRPC_INVALID_PARAMS,
          jsonrpcServerError: JSONRPC_SERVER_ERROR,
          maxStdioTextLength: MAX_STDIO_TEXT_LENGTH,
          maxResourceBytes: MAX_STDIO_RESOURCE_BYTES,
          maxResourceSubscriptions: MAX_RESOURCE_SUBSCRIPTIONS,
        })
      case 'resources/read':
        return handleResourceRead(id, graphPath, params, {
          ok,
          failure,
          stringParam,
          ensureSubscribedResourceUris,
          ensureResourceVersions,
          jsonrpcInvalidParams: JSONRPC_INVALID_PARAMS,
          jsonrpcServerError: JSONRPC_SERVER_ERROR,
          maxStdioTextLength: MAX_STDIO_TEXT_LENGTH,
          maxResourceBytes: MAX_STDIO_RESOURCE_BYTES,
          maxResourceSubscriptions: MAX_RESOURCE_SUBSCRIPTIONS,
        })
      case 'tools/list': {
        const profile = resolveToolProfileFromEnv()
        return ok(id, { tools: activeMcpTools(profile) })
      }
      case 'tools/call': {
        const profile = resolveToolProfileFromEnv()
        const toolName = stringParam(params, 'name')
        if (toolName !== null && !isCoreToolName(toolName, profile)) {
          return failure(
            id,
            JSONRPC_METHOD_NOT_FOUND,
            `Tool '${toolName}' is not enabled in the active graphify-ts MCP tool profile. Set GRAPHIFY_TOOL_PROFILE=full in your MCP server config (e.g. .mcp.json for Claude, .cursor/mcp.json for Cursor, .vscode/mcp.json for VS Code Copilot) to enable advanced tools.`,
          )
        }
        return handleToolCallRequest(id, graphPath, params, {
          ok,
          failure,
          textToolResult,
          stringParam,
          stringParamAlias,
          numberParamAlias,
          recordParam,
          loadGraphCached,
          queryOptionsFromParams,
          handleGraphDiff,
          compareRefs: async (input) => {
            const safeGraphPath = validateGraphPath(graphPath)
            const projectRoot = dirname(dirname(safeGraphPath))
            return await (toolOverrides.compareRefs ?? compareRefs)(input, { rootDir: projectRoot })
          },
           getContextPromptSession: (sessionId) => ensureContextPromptSessions(sessionState).get(sessionId),
           setContextPromptSession: (sessionId, nextState) => {
             const sessions = ensureContextPromptSessions(sessionState)
             if (!sessions.has(sessionId) && sessions.size >= MAX_CONTEXT_PROMPT_SESSIONS) {
               const oldestSessionId = sessions.keys().next().value as string | undefined
              if (oldestSessionId !== undefined) {
                sessions.delete(oldestSessionId)
              }
             }
             sessions.set(sessionId, nextState)
           },
           clearContextPromptSession: (sessionId) => ensureContextPromptSessions(sessionState).delete(sessionId),
           getContextPackHandle: (handleId) => ensureContextPackHandles(sessionState).get(handleId),
           setContextPackHandle: (handleId, expansion) => {
             const handles = ensureContextPackHandles(sessionState)
             if (!handles.has(handleId) && handles.size >= MAX_CONTEXT_PROMPT_SESSIONS) {
               const oldestHandleId = handles.keys().next().value as string | undefined
               if (oldestHandleId !== undefined) {
                 handles.delete(oldestHandleId)
               }
             }
             handles.set(handleId, expansion)
           },
           readStoredCommunityLabels,
          jsonrpcInvalidParams: JSONRPC_INVALID_PARAMS,
          jsonrpcServerError: JSONRPC_SERVER_ERROR,
          maxStdioTextLength: MAX_STDIO_TEXT_LENGTH,
          maxStdioHops: MAX_STDIO_HOPS,
          maxStdioTokenBudget: MAX_STDIO_TOKEN_BUDGET,
        })
      }
      case 'ping':
        return ok(id, { ok: true })
      case 'query':
        return handleDirectQuery(graphPath, id, params)
      case 'diff':
        return handleGraphDiff(id, graphPath, params)
      case 'anomalies':
        return ok(id, semanticAnomaliesSummary(graphPath, numberParamAlias(params, ['top_n', 'topN'], { min: 1, max: 100 }) ?? 5))
      case 'node': {
        const graph = loadGraphCached(graphPath)
        const label = stringParam(params, 'label')
        if (!label) {
          return failure(id, JSONRPC_INVALID_PARAMS, `node requires a string label parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
        }
        return ok(id, getNode(graph, label))
      }
      case 'neighbors': {
        const graph = loadGraphCached(graphPath)
        const label = stringParam(params, 'label')
        if (!label) {
          return failure(id, JSONRPC_INVALID_PARAMS, `neighbors requires a string label parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
        }
        return ok(id, getNeighbors(graph, label, stringParamAlias(params, ['relation_filter', 'relation']) ?? ''))
      }
      case 'path': {
        const graph = loadGraphCached(graphPath)
        const source = stringParam(params, 'source')
        const target = stringParam(params, 'target')
        if (!source || !target) {
          return failure(id, JSONRPC_INVALID_PARAMS, `path requires string source and target parameters <= ${MAX_STDIO_TEXT_LENGTH} characters`)
        }
        return ok(id, shortestPath(graph, source, target, numberParamAlias(params, ['max_hops', 'maxHops'], { min: 1, max: MAX_STDIO_HOPS }) ?? 8))
      }
      case 'explain': {
        const graph = loadGraphCached(graphPath)
        const label = stringParam(params, 'label')
        if (!label) {
          return failure(id, JSONRPC_INVALID_PARAMS, `explain requires a string label parameter <= ${MAX_STDIO_TEXT_LENGTH} characters`)
        }
        const relation = stringParamAlias(params, ['relation_filter', 'relation']) ?? ''
        return ok(id, `${getNode(graph, label)}\n\n${getNeighbors(graph, label, relation)}`)
      }
      case 'stats': {
        const graph = loadGraphCached(graphPath)
        return ok(id, graphStats(graph))
      }
      case 'god_nodes': {
        const graph = loadGraphCached(graphPath)
        return ok(id, godNodesSummary(graph, numberParamAlias(params, ['top_n', 'topN'], { min: 1, max: 100 }) ?? 10))
      }
      case 'community': {
        const graph = loadGraphCached(graphPath)
        const communityId = numberParamAlias(params, ['community_id', 'communityId'], { min: 0 })
        if (communityId === null) {
          return failure(id, JSONRPC_INVALID_PARAMS, 'community requires a numeric community_id parameter >= 0')
        }
        return ok(id, getCommunity(graph, communitiesFromGraph(graph), communityId))
      }
      default:
        return failure(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`)
    }
  } catch {
    return failure(id, JSONRPC_SERVER_ERROR, 'Graph query failed')
  }
}

export async function serveGraphStdio(options: ServeGraphStdioOptions): Promise<void> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const errorOutput = options.errorOutput ?? process.stderr
  const sessionState = createSessionState()

  errorOutput.write(`[graphify serve] stdio ready for ${options.graphPath}\n`)

  const readline = createInterface({ input, crlfDelay: Infinity })

  for await (const line of readline) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    if (trimmed.length > MAX_STDIO_LINE_BYTES) {
      const response = failure(null, JSONRPC_INVALID_REQUEST, `Payload too large (max ${MAX_STDIO_LINE_BYTES} bytes)`)
      output.write(`${JSON.stringify(response)}\n`)
      continue
    }

    let payload: unknown
    try {
      payload = JSON.parse(trimmed)
    } catch {
      const response = failure(null, JSONRPC_PARSE_ERROR, 'Parse error')
      emitLogNotification(output, sessionState, 'error', { message: response.error?.message ?? 'Parse error', code: JSONRPC_PARSE_ERROR })
      output.write(`${JSON.stringify(response)}\n`)
      continue
    }

    emitResourceNotifications(output, options.graphPath, sessionState)
    const response = await Promise.resolve(handleStdioRequest(options.graphPath, payload, sessionState))
    if (response) {
      if (response.error) {
        emitLogNotification(output, sessionState, 'error', { message: response.error.message, code: response.error.code })
      }
      output.write(`${JSON.stringify(response)}\n`)
    }
  }
}
