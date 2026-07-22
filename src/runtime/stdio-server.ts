import { createInterface } from 'node:readline'
import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

import type { ContextSessionState } from '../contracts/context-session.js'
import { compareRefs } from '../infrastructure/time-travel.js'
import { startWatchIndex, type GraphAutoRefreshController } from '../infrastructure/watch-index.js'
import { diffGraphs } from './diff.js'
import { buildGraphSummary } from './graph-summary.js'
import { MCP_PROMPTS, MCP_TOOLS, activeMcpTools, isToolEnabledInProfile, resolveToolProfileFromEnv, type McpPromptDefinition } from './stdio/definitions.js'
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
import { isSemanticRuntimeAvailable } from './semantic.js'
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
import {
  graphSizeBucketFromNodeCount,
  recordTelemetryEvent,
  repoSizeBucketFromFileCount,
  type TelemetryAnswerabilityBucket,
  type TelemetryBroadSearchFallbackBucket,
  type TelemetryFailureBucket,
  type TelemetryEventInput,
} from '../shared/telemetry.js'
import { findPackageRoot, readPackageVersion } from '../shared/package-metadata.js'
import { resolveGraphSourceRoot } from '../shared/graph-source-root.js'
import { resolveMadarWorkspace } from '../shared/workspace.js'
import { GRAPH_ARTIFACT_REGENERATE_MESSAGE } from '../domain/graph/artifact.js'
import { readBuildState } from '../domain/index/build-state.js'

const JSONRPC_PARSE_ERROR = -32700
const JSONRPC_INVALID_REQUEST = -32600
const JSONRPC_INVALID_PARAMS = -32602
const JSONRPC_METHOD_NOT_FOUND = -32601
const JSONRPC_SERVER_ERROR = -32000
const MCP_PROTOCOL_VERSION = '2025-11-25'
const MCP_SERVER_NAME = 'madar'
const MCP_SERVER_TITLE = 'Madar TS'
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
const MAX_CONTEXT_PACK_CACHE_ENTRIES = 256
const graphCache = new Map<string, { mtimeMs: number; size: number; graph: ReturnType<typeof loadGraph> }>()
const graphBuildStateCache = new WeakMap<ReturnType<typeof loadGraph>, ReturnType<typeof readBuildState>>()
const MAX_COMPLETION_VALUES = 25
const MAX_LOG_NOTIFICATION_CHARS = 10_000
const DEFAULT_AUTO_REFRESH_REQUEST_WAIT_MS = 25_000
const AUTO_REFRESH_READINESS_POLL_MS = 50

const AUTO_REFRESH_CONTROL_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'logging/setLevel',
  'ping',
  'prompts/list',
  'resources/list',
  'tools/list',
])

// These pre-MCP convenience methods are retained for existing clients, but
// they must not provide an unadvertised graph-navigation escape hatch when a
// client deliberately selected the bounded strict context-pack profile.
const STRICT_DISABLED_LEGACY_GRAPH_METHODS = new Set([
  'query',
  'diff',
  'anomalies',
  'node',
  'neighbors',
  'path',
  'explain',
  'stats',
  'god_nodes',
  'community',
])

type McpLogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency'

/** Per-session record of node ids already shipped to a given `delta_session_id`.
 *  Used by the context_pack delta surface (#81) so subsequent calls return
 *  only nodes the agent hasn't already received. */
type ContextPackNodeIdStore = Map<string, Set<string>>
type ContextPackCacheStore = Map<string, string>

interface StdioSessionState extends ResourceSessionState {
  logLevel: McpLogLevel
  contextPromptSessions?: Map<string, ContextSessionState>
  contextPackHandles?: Map<string, unknown>
  contextPackCache?: ContextPackCacheStore
  /** Slice #81 — per-delta-session node ids already shipped. */
  contextPackNodeIds?: ContextPackNodeIdStore
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
    contextPackCache: new Map<string, string>(),
    contextPackNodeIds: new Map<string, Set<string>>(),
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
    data?: Record<string, unknown>
  }
}

export interface ServeGraphStdioOptions {
  graphPath: string
  /** Reconcile once and watch the selected workspace for this MCP process. */
  autoRefresh?: boolean
  /** Source root selected when the MCP process was launched. */
  workspaceRoot?: string
  /** Internal/testing override for the filesystem change debounce. */
  autoRefreshDebounceSeconds?: number
  input?: Readable
  output?: Writable
  errorOutput?: Writable
  /** Internal/testing seam for the in-process incremental watcher. */
  autoRefreshStarter?: typeof startWatchIndex
  /** Internal/testing override for how long graph-backed requests await reconciliation. */
  autoRefreshRequestWaitMs?: number
  logger?: {
    log(message?: string): void
    error(message?: string): void
  }
}

function sameFilesystemPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return resolve(left) === resolve(right)
  }
}

function cachedBuildState(graph: ReturnType<typeof loadGraph>): ReturnType<typeof readBuildState> {
  if (graphBuildStateCache.has(graph)) return graphBuildStateCache.get(graph) ?? null
  const state = readBuildState(graph)
  graphBuildStateCache.set(graph, state)
  return state
}

function graphRootPath(graphPath: string): string | null {
  try {
    const graph = loadGraphCached(graphPath)
    const rootPath = cachedBuildState(graph)?.source_root.root_path ?? graph.graph.root_path
    return typeof rootPath === 'string' && rootPath.trim().length > 0 ? rootPath.trim() : null
  } catch {
    return null
  }
}

function autoRefreshGraphReadiness(
  controller: GraphAutoRefreshController,
  graphPath: string,
): { ready: boolean; detail: string; state: string; retryable: boolean; retryAfterMs?: number } {
  const startupComplete = controller.startupComplete()
  const backgroundFailure = controller.failureReason()
  const state = controller.state()
  const acceptedBuildId = controller.acceptedBuildId()
  const retryable = backgroundFailure === null
    && (!startupComplete || state === 'starting' || state === 'pending' || state === 'reconciling')
  if (retryable) {
    return {
      ready: false,
      state,
      retryable: true,
      retryAfterMs: 1_000,
      detail: `status=${state}, accepted_build=${acceptedBuildId?.slice(0, 12) ?? 'pending'}`,
    }
  }
  if (backgroundFailure !== null || state !== 'idle') {
    return {
      ready: false,
      state,
      retryable: false,
      detail: `status=${state}, accepted_build=${acceptedBuildId?.slice(0, 12) ?? 'unavailable'}${backgroundFailure ? `, failure=${backgroundFailure}` : ''}`,
    }
  }

  let publishedBuildId: string | null = null
  let artifactFailure: string | null = null
  try {
    const graph = loadGraphCached(graphPath)
    const buildState = cachedBuildState(graph)
    if (buildState) publishedBuildId = buildState.build_id
    else artifactFailure = 'published graph has no authenticated index build state'
  } catch {
    artifactFailure = 'published graph cannot be loaded or authenticated'
  }
  const acceptedGraphMatches = acceptedBuildId !== null && publishedBuildId === acceptedBuildId

  return {
    ready: acceptedGraphMatches,
    state,
    retryable: false,
    detail: [
      `status=${state}`,
      `accepted_build=${acceptedBuildId?.slice(0, 12) ?? 'pending'}`,
      `published_build=${publishedBuildId?.slice(0, 12) ?? 'unavailable'}`,
      `publication=${acceptedGraphMatches ? 'match' : 'mismatch'}`,
      ...(artifactFailure ? [`artifact_failure=${artifactFailure}`] : []),
      ...(backgroundFailure ? [`failure=${backgroundFailure}`] : []),
    ].join(', '),
  }
}

type AutoRefreshGraphReadiness = ReturnType<typeof autoRefreshGraphReadiness>

async function waitForAutoRefreshGraphReadiness(
  controller: GraphAutoRefreshController,
  graphPath: string,
  waitMs: number,
): Promise<AutoRefreshGraphReadiness> {
  let readiness = autoRefreshGraphReadiness(controller, graphPath)
  if (readiness.ready || !readiness.retryable || waitMs <= 0) {
    return readiness
  }

  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await delay(Math.min(AUTO_REFRESH_READINESS_POLL_MS, Math.max(1, deadline - Date.now())))
    readiness = autoRefreshGraphReadiness(controller, graphPath)
    if (readiness.ready || !readiness.retryable) {
      return readiness
    }
  }

  return autoRefreshGraphReadiness(controller, graphPath)
}

function graphNotReadyResponse(
  request: StdioRequest,
  readiness: AutoRefreshGraphReadiness,
  waitedMs: number,
): StdioResponse {
  const readinessData = {
    type: 'madar_graph_not_ready',
    state: readiness.state,
    retryable: readiness.retryable,
    ...(readiness.retryAfterMs !== undefined
      ? { retry_after_ms: readiness.retryAfterMs }
      : {}),
    ...(waitedMs > 0 ? { waited_ms: waitedMs } : {}),
    suggested_action: readiness.retryable ? 'retry_same_request' : 'repair_graph',
  }
  return failure(
    requestId(request),
    JSONRPC_SERVER_ERROR,
    readiness.retryable
      ? `Madar graph is temporarily ${readiness.state} (${readiness.detail}). Retry the same request after ${readiness.retryAfterMs ?? 1_000}ms; no manual graph generation is needed while reconciliation is active.`
      : `Madar auto-refresh cannot guarantee a fresh graph (${readiness.detail}). Run \`madar status\`, then \`madar generate . --update\` if repair is required before retrying.`,
    readinessData,
  )
}

function ok(id: string | number | null, result: unknown): StdioResponse {
  return { jsonrpc: '2.0', id, result }
}

function failure(
  id: string | number | null,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): StdioResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data ? { data } : {}) },
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

function ensureContextPackCache(state: StdioSessionState): ContextPackCacheStore {
  if (!state.contextPackCache) {
    state.contextPackCache = new Map<string, string>()
  }

  return state.contextPackCache
}

function ensureContextPackNodeIds(state: StdioSessionState): ContextPackNodeIdStore {
  if (!state.contextPackNodeIds) {
    state.contextPackNodeIds = new Map<string, Set<string>>()
  }
  return state.contextPackNodeIds
}

function requestId(request: StdioRequest): string | number | null {
  return typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null
}

function readInstalledVersionForTelemetry(): string {
  return readPackageVersion(findPackageRoot())
}

function readNodeMajorForTelemetry(): number {
  const major = Number.parseInt(process.versions.node.split('.', 1)[0] ?? '', 10)
  return Number.isInteger(major) && major > 0 ? major : 0
}

function classifyToolTelemetryFailure(message: string, code: number): TelemetryFailureBucket {
  const normalizedMessage = message.toLowerCase()
  if (code === JSONRPC_INVALID_PARAMS) {
    return 'invalid_params'
  }
  if (normalizedMessage.includes('require_fresh_graph') || normalizedMessage.includes('non-fresh graph')) {
    return 'stale_graph'
  }
  if (normalizedMessage.includes('require_fresh_context') || normalizedMessage.includes('stale selected context')) {
    return 'stale_context'
  }
  if (normalizedMessage.includes('tool') && normalizedMessage.includes('profile')) {
    return 'tool_profile'
  }
  return 'unknown'
}

function telemetryRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function telemetryAnswerability(value: unknown): TelemetryAnswerabilityBucket | null {
  return value === 'ready' || value === 'ready_with_caveat' || value === 'verify_targets' || value === 'insufficient'
    ? value
    : null
}

function telemetryBroadSearchFallback(value: unknown): TelemetryBroadSearchFallbackBucket | null {
  return value === 'not_needed' || value === 'targeted_only' || value === 'allowed' || value === 'blocked'
    ? value
    : null
}

function contextPackTelemetryBuckets(
  response: StdioResponse,
): Pick<
  TelemetryEventInput,
  'initialAnswerabilityBucket' | 'recoveryAttemptsBucket' | 'recoveryImprovementBucket' | 'finalAnswerabilityBucket' | 'broadSearchFallbackBucket'
> {
  try {
    const result = telemetryRecord(response.result)
    const content = Array.isArray(result?.content) ? result.content : []
    const text = content
      .map((entry) => telemetryRecord(entry))
      .map((entry) => entry?.text)
      .find((value): value is string => typeof value === 'string')
    if (!text) return {}
    const payload = telemetryRecord(JSON.parse(text))
    const evidence = telemetryRecord(payload?.evidence)
    const answerability = telemetryRecord(evidence?.answerability)
    const pack = telemetryRecord(payload?.pack)
    const recovery = telemetryRecord(evidence?.recovery) ?? telemetryRecord(pack?.recovery)
    const finalState = telemetryAnswerability(recovery?.final_state) ?? telemetryAnswerability(answerability?.state)
    const initialState = telemetryAnswerability(recovery?.initial_state) ?? finalState
    const attemptCount = Math.min(2, Array.isArray(recovery?.attempts) ? recovery.attempts.length : 0) as 0 | 1 | 2
    const broadSearch = telemetryBroadSearchFallback(answerability?.broad_search_fallback)
    return {
      ...(initialState ? { initialAnswerabilityBucket: initialState } : {}),
      recoveryAttemptsBucket: String(attemptCount) as '0' | '1' | '2',
      recoveryImprovementBucket: attemptCount === 0
        ? 'not_attempted'
        : recovery?.improved === true ? 'improved' : 'unchanged',
      ...(finalState ? { finalAnswerabilityBucket: finalState } : {}),
      ...(broadSearch ? { broadSearchFallbackBucket: broadSearch } : {}),
    }
  } catch {
    return {}
  }
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

function errorToolResult(text: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  }
}

function loadGraphCached(graphPath: string): ReturnType<typeof loadGraph> {
  const safeGraphPath = validateGraphPath(graphPath)
  const currentGraphStat = statSync(safeGraphPath)
  const cached = graphCache.get(safeGraphPath)
  if (cached && cached.mtimeMs === currentGraphStat.mtimeMs && cached.size === currentGraphStat.size) {
    return cached.graph
  }

  const graph = loadGraph(safeGraphPath)
  graphCache.set(safeGraphPath, { mtimeMs: currentGraphStat.mtimeMs, size: currentGraphStat.size, graph })
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
    const toolProfile = resolveToolProfileFromEnv()
    const strictContextPackProfile = toolProfile === 'strict'

    if (strictContextPackProfile && STRICT_DISABLED_LEGACY_GRAPH_METHODS.has(method)) {
      return failure(
        id,
        JSONRPC_METHOD_NOT_FOUND,
        `Legacy graph method '${method}' is disabled in the strict context_pack profile. Use context_pack, or select MADAR_TOOL_PROFILE=core or full for graph navigation.`,
      )
    }

    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            logging: {},
            ...(strictContextPackProfile
              ? {}
              : {
                  completions: {},
                  prompts: { listChanged: false },
                  resources: { subscribe: true, listChanged: true },
                }),
            tools: { listChanged: false },
          },
          serverInfo: {
            name: MCP_SERVER_NAME,
            title: MCP_SERVER_TITLE,
            version: MCP_SERVER_VERSION,
          },
          instructions: strictContextPackProfile
            ? 'Strict profile: use context_pack once with the user request verbatim. Use context_expand only for a listed verify_targets handle; graph prompts, resources, and completions are disabled.'
            : 'Use tools/list to discover graph tools, then tools/call to query the generated graph.',
        })
      case 'notifications/initialized':
        return null
      case 'completion/complete':
        if (strictContextPackProfile) {
          return failure(id, JSONRPC_METHOD_NOT_FOUND, 'MCP prompt completions are disabled in the strict context_pack profile.')
        }
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
        return ok(id, { prompts: strictContextPackProfile ? [] : promptDefinitionsForGraph(graphPath) })
      case 'prompts/get':
        if (strictContextPackProfile) {
          return failure(id, JSONRPC_METHOD_NOT_FOUND, 'MCP prompts are disabled in the strict context_pack profile.')
        }
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
          resources: strictContextPackProfile ? [] : resourcesForGraph(graphPath).map(({ uri, name, title, description, mimeType, annotations }) => ({
            uri,
            name,
            title,
            description,
            mimeType,
            annotations,
          })),
        })
      case 'resources/subscribe':
        if (strictContextPackProfile) {
          return failure(id, JSONRPC_METHOD_NOT_FOUND, 'MCP resources are disabled in the strict context_pack profile.')
        }
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
        if (strictContextPackProfile) {
          return failure(id, JSONRPC_METHOD_NOT_FOUND, 'MCP resources are disabled in the strict context_pack profile.')
        }
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
        if (strictContextPackProfile) {
          return failure(id, JSONRPC_METHOD_NOT_FOUND, 'MCP resources are disabled in the strict context_pack profile.')
        }
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
        // Only advertise semantic/rerank params when the optional transformers
        // package is actually resolvable on this machine — agents cannot pass
        // parameters that are absent from the schema.
        const semanticAvailable = isSemanticRuntimeAvailable(graphRootPath(graphPath) ?? resolveGraphSourceRoot(graphPath))
        return ok(id, { tools: activeMcpTools(toolProfile, { semanticAvailable }) })
      }
      case 'tools/call': {
        const toolName = stringParam(params, 'name')
        if (toolName !== null && !isToolEnabledInProfile(toolName, toolProfile)) {
          return failure(
            id,
            JSONRPC_METHOD_NOT_FOUND,
            `Tool '${toolName}' is not enabled in the active madar MCP tool profile '${toolProfile}'. Use MADAR_TOOL_PROFILE=strict for the bounded context_pack/context_expand flow, MADAR_TOOL_PROFILE=core for graph navigation, or MADAR_TOOL_PROFILE=full for every tool.`,
          )
        }
        const toolArguments = recordParam(params, 'arguments')
        if (strictContextPackProfile && toolName === 'context_pack') {
          const unsupported = Object.keys(toolArguments ?? {}).filter((key) => key !== 'prompt' && key !== 'task')
          if (unsupported.length > 0) {
            return failure(
              id,
              JSONRPC_INVALID_PARAMS,
              `strict context_pack accepts only prompt and optional task; unsupported argument${unsupported.length === 1 ? '' : 's'}: ${unsupported.join(', ')}. Use MADAR_TOOL_PROFILE=full for diagnostics or retrieval tuning.`,
            )
          }
        }
        if (strictContextPackProfile && toolName === 'context_expand') {
          const unsupported = Object.keys(toolArguments ?? {}).filter((key) => key !== 'handle_id')
          if (unsupported.length > 0) {
            return failure(
              id,
              JSONRPC_INVALID_PARAMS,
              `strict context_expand accepts only handle_id; unsupported argument${unsupported.length === 1 ? '' : 's'}: ${unsupported.join(', ')}. Use MADAR_TOOL_PROFILE=full for expansion tuning.`,
            )
          }
        }
        const response = handleToolCallRequest(id, graphPath, params, {
          ok,
          failure,
          textToolResult,
          errorToolResult,
          stringParam,
          stringParamAlias,
          numberParamAlias,
          recordParam,
          loadGraphCached,
          queryOptionsFromParams,
          handleGraphDiff,
          compareRefs: async (input) => {
            const safeGraphPath = validateGraphPath(graphPath)
            const projectRoot = resolveGraphSourceRoot(safeGraphPath, loadGraphCached(safeGraphPath))
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
           strictContextPackMode: strictContextPackProfile,
           getContextPackNodeIds: (sessionId) => {
             const store = ensureContextPackNodeIds(sessionState).get(sessionId)
             return store ? Array.from(store) : []
           },
           recordContextPackNodeIds: (sessionId, nodeIds) => {
             const store = ensureContextPackNodeIds(sessionState)
             let bucket = store.get(sessionId)
             if (!bucket) {
               if (store.size >= MAX_CONTEXT_PROMPT_SESSIONS) {
                 const oldestSessionId = store.keys().next().value as string | undefined
                 if (oldestSessionId !== undefined) {
                   store.delete(oldestSessionId)
                 }
               }
               bucket = new Set<string>()
               store.set(sessionId, bucket)
             }
             for (const id of nodeIds) bucket.add(id)
           },
           clearContextPackNodeIds: (sessionId) => ensureContextPackNodeIds(sessionState).delete(sessionId),
           getContextPackHandle: (handleId) => ensureContextPackHandles(sessionState).get(handleId),
           takeContextPackHandle: (handleId) => {
             const handles = ensureContextPackHandles(sessionState)
             const stored = handles.get(handleId)
             handles.delete(handleId)
             return stored
           },
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
            clearContextPackHandles: () => ensureContextPackHandles(sessionState).clear(),
            getContextPackCache: (cacheKey) => ensureContextPackCache(sessionState).get(cacheKey),
            setContextPackCache: (cacheKey, payloadText) => {
              const cache = ensureContextPackCache(sessionState)
              if (!cache.has(cacheKey) && cache.size >= MAX_CONTEXT_PACK_CACHE_ENTRIES) {
                const oldestKey = cache.keys().next().value as string | undefined
                if (oldestKey !== undefined) {
                  cache.delete(oldestKey)
                }
              }
              cache.set(cacheKey, payloadText)
            },
            clearContextPackCache: (cacheKey) => ensureContextPackCache(sessionState).delete(cacheKey),
            readStoredCommunityLabels,
           jsonrpcInvalidParams: JSONRPC_INVALID_PARAMS,
           jsonrpcServerError: JSONRPC_SERVER_ERROR,
          maxStdioTextLength: MAX_STDIO_TEXT_LENGTH,
          maxStdioHops: MAX_STDIO_HOPS,
          maxStdioTokenBudget: MAX_STDIO_TOKEN_BUDGET,
        })
        const recordContextPackTelemetry = (toolResponse: StdioResponse): StdioResponse => {
          if (toolName === 'context_pack') {
            try {
              const summary = buildGraphSummary(loadGraphCached(graphPath))
              recordTelemetryEvent({
                command: 'context_pack',
                stage: toolResponse.error ? 'failed' : 'succeeded',
                version: readInstalledVersionForTelemetry(),
                os: process.platform,
                nodeMajor: readNodeMajorForTelemetry(),
                repoSizeBucket: repoSizeBucketFromFileCount(summary.file_count),
                graphSizeBucket: graphSizeBucketFromNodeCount(summary.node_count),
                ...contextPackTelemetryBuckets(toolResponse),
                ...(toolResponse.error ? { failureBucket: classifyToolTelemetryFailure(toolResponse.error.message, toolResponse.error.code) } : {}),
              })
            } catch {
              // Telemetry is best-effort and must never break the MCP response path.
            }
          }
          return toolResponse
        }
        return response instanceof Promise ? response.then(recordContextPackTelemetry) : recordContextPackTelemetry(response)
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
  } catch (error) {
    return failure(id, JSONRPC_SERVER_ERROR, error instanceof Error && error.message.includes(GRAPH_ARTIFACT_REGENERATE_MESSAGE) ? error.message : 'Graph query failed')
  }
}

export async function serveGraphStdio(options: ServeGraphStdioOptions): Promise<void> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const errorOutput = options.errorOutput ?? process.stderr
  const sessionState = createSessionState()
  const strictContextPackProfile = resolveToolProfileFromEnv() === 'strict'
  let autoRefresh: GraphAutoRefreshController | null = null

  if (options.autoRefresh) {
    const workspaceRoot = options.workspaceRoot ?? graphRootPath(options.graphPath)
    if (!workspaceRoot) {
      throw new Error('Cannot auto-refresh a graph without a workspace root. Run madar generate from the workspace first.')
    }

    const workspace = resolveMadarWorkspace(workspaceRoot)
    if (!sameFilesystemPath(options.graphPath, workspace.graphPath)) {
      throw new Error(
        `Refusing to auto-refresh ${options.graphPath}: it is not the graph artifact for ${workspace.rootPath}. ` +
        'Start the MCP server from the intended worktree instead.',
      )
    }

    const startAutoRefresh = options.autoRefreshStarter ?? startWatchIndex
    autoRefresh = startAutoRefresh(workspace.rootPath, options.autoRefreshDebounceSeconds ?? 1, {
      // stdout is reserved for JSON-RPC; watcher progress stays silent unless
      // a reconciliation fails.
      logger: {
        log() {},
        error(message) {
          errorOutput.write(`[madar serve] ${message ?? 'Auto-refresh failed'}\n`)
        },
      },
    })
  }

  errorOutput.write(`[madar serve] stdio ready for ${options.graphPath}\n`)

  const readline = createInterface({ input, crlfDelay: Infinity })
  let graphRequestQueue = Promise.resolve()

  const handleAndWritePayload = async (
    payload: unknown,
    awaitReconciliation: boolean,
    arrivalMs = Date.now(),
  ): Promise<void> => {
    let response: StdioResponse | null
    try {
      const request = payload as StdioRequest
      const requestMethod = typeof request.method === 'string' ? request.method : null
      let refreshReadiness = autoRefresh && requestMethod
        ? autoRefreshGraphReadiness(autoRefresh, options.graphPath)
        : null
      let waitedMs = 0

      if (
        awaitReconciliation
        && autoRefresh
        && refreshReadiness
        && !refreshReadiness.ready
        && refreshReadiness.retryable
      ) {
        const maxWaitMs = Math.max(0, options.autoRefreshRequestWaitMs ?? DEFAULT_AUTO_REFRESH_REQUEST_WAIT_MS)
        const remainingWaitMs = Math.max(0, maxWaitMs - (Date.now() - arrivalMs))
        refreshReadiness = await waitForAutoRefreshGraphReadiness(
          autoRefresh,
          options.graphPath,
          remainingWaitMs,
        )
        waitedMs = Date.now() - arrivalMs
      }

      if (refreshReadiness && !refreshReadiness.ready && requestMethod === 'prompts/list') {
        response = ok(requestId(request), { prompts: strictContextPackProfile ? [] : MCP_PROMPTS })
      } else if (refreshReadiness && !refreshReadiness.ready && requestMethod === 'resources/list') {
        response = ok(requestId(request), { resources: [] })
      } else if (refreshReadiness && !refreshReadiness.ready && requestMethod !== null && !AUTO_REFRESH_CONTROL_METHODS.has(requestMethod)) {
        response = graphNotReadyResponse(request, refreshReadiness, waitedMs)
      } else {
        if (!strictContextPackProfile) {
          emitResourceNotifications(output, options.graphPath, sessionState)
        }
        response = await Promise.resolve(handleStdioRequest(options.graphPath, payload, sessionState))
      }
    } catch (error) {
      // A rejected handler must never tear down the whole stdio server: every
      // request gets an answer and the loop keeps serving (#crash).
      const message = error instanceof Error ? error.message : 'Request failed'
      response = failure(requestId(payload as StdioRequest), JSONRPC_SERVER_ERROR, message)
    }
    if (response) {
      if (response.error) {
        emitLogNotification(output, sessionState, 'error', { message: response.error.message, code: response.error.code })
      }
      output.write(`${JSON.stringify(response)}\n`)
    }
  }

  try {
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

      const request = payload as StdioRequest
      const requestMethod = typeof request.method === 'string' ? request.method : null
      if (autoRefresh && requestMethod !== null && !AUTO_REFRESH_CONTROL_METHODS.has(requestMethod)) {
        // Keep control/discovery requests responsive while graph-backed work
        // waits for one bounded reconciliation window. Graph requests remain
        // serialized because context-pack calls mutate per-session state.
        const arrivalMs = Date.now()
        graphRequestQueue = graphRequestQueue.then(() => handleAndWritePayload(payload, true, arrivalMs))
        continue
      }

      await handleAndWritePayload(payload, false)
    }
  } finally {
    await graphRequestQueue
    if (autoRefresh) {
      autoRefresh.stop()
      await autoRefresh.completed
    }
  }
}
