import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

import {
  readGraphArtifactReceipt,
  type GraphArtifactReceipt,
} from '../adapters/filesystem/graph-artifact.js'
import { readBuildState } from '../domain/index/build-state.js'
import {
  startWatchIndex,
  updateIndexInWorker,
  type GraphAutoRefreshController,
} from '../infrastructure/watch-index.js'
import { readPackageVersion } from '../shared/package-metadata.js'
import { validateGraphPath } from '../shared/security.js'
import { resolveMadarWorkspace } from '../shared/workspace.js'
import { MCP_TOOLS } from './stdio/definitions.js'
import {
  handleResourceRead,
  resourcesForGraph,
} from './stdio/resources.js'
import { handleToolCall } from './stdio/tools.js'

const JSONRPC_PARSE_ERROR = -32700
const JSONRPC_INVALID_REQUEST = -32600
const JSONRPC_METHOD_NOT_FOUND = -32601
const JSONRPC_INVALID_PARAMS = -32602
const JSONRPC_SERVER_ERROR = -32000
const MCP_PROTOCOL_VERSION = '2025-11-25'
const MCP_SERVER_NAME = 'madar'
const MCP_SERVER_TITLE = 'Madar TS'
const MAX_STDIO_LINE_BYTES = 1_000_000
const MAX_STDIO_RESOURCE_BYTES = 5_000_000
const DEFAULT_AUTO_REFRESH_REQUEST_WAIT_MS = 25_000
const AUTO_REFRESH_READINESS_POLL_MS = 50
const GRAPH_BACKED_METHODS = new Set(['tools/call', 'resources/read'])
const graphCache = new Map<string, GraphArtifactReceipt>()

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
  autoRefresh?: boolean
  workspaceRoot?: string
  autoRefreshDebounceSeconds?: number
  input?: Readable
  output?: Writable
  errorOutput?: Writable
  autoRefreshStarter?: typeof startWatchIndex
  autoRefreshRequestWaitMs?: number
  logger?: {
    log(message?: string): void
    error(message?: string): void
  }
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
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
  }
}

function requestId(request: StdioRequest): string | number | null {
  return typeof request.id === 'string' || typeof request.id === 'number'
    ? request.id
    : null
}

function sameFilesystemPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return resolve(left) === resolve(right)
  }
}

function loadGraphReceiptCached(graphPath: string): GraphArtifactReceipt {
  const safeGraphPath = validateGraphPath(graphPath)
  const receipt = readGraphArtifactReceipt(
    safeGraphPath,
    graphCache.get(safeGraphPath),
  )
  graphCache.set(safeGraphPath, receipt)
  return receipt
}

function graphRootPath(graphPath: string): string | null {
  try {
    const graph = loadGraphReceiptCached(graphPath).graph
    const rootPath = readBuildState(graph)?.source_root.root_path
      ?? graph.graph.root_path
    return typeof rootPath === 'string' && rootPath.trim().length > 0
      ? rootPath.trim()
      : null
  } catch {
    return null
  }
}

function autoRefreshGraphReadiness(
  controller: GraphAutoRefreshController,
  graphPath: string,
): {
  ready: boolean
  detail: string
  state: string
  retryable: boolean
  retryAfterMs?: number
} {
  const startupComplete = controller.startupComplete()
  const backgroundFailure = controller.failureReason()
  const state = controller.state()
  const acceptedBuildId = controller.acceptedBuildId()
  const retryable = backgroundFailure === null
    && (!startupComplete
      || state === 'starting'
      || state === 'pending'
      || state === 'reconciling')

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
      detail:
        `status=${state}, accepted_build=${acceptedBuildId?.slice(0, 12) ?? 'unavailable'}`
        + `${backgroundFailure ? `, failure=${backgroundFailure}` : ''}`,
    }
  }

  let publishedBuildId: string | null = null
  let artifactFailure: string | null = null
  try {
    publishedBuildId = readBuildState(loadGraphReceiptCached(graphPath).graph)
      ?.build_id ?? null
    if (!publishedBuildId) {
      artifactFailure = 'published graph has no authenticated index build state'
    }
  } catch {
    artifactFailure = 'published graph cannot be loaded or authenticated'
  }
  const publicationMatches = acceptedBuildId !== null
    && acceptedBuildId === publishedBuildId

  return {
    ready: publicationMatches,
    state,
    retryable: false,
    detail: [
      `status=${state}`,
      `accepted_build=${acceptedBuildId?.slice(0, 12) ?? 'pending'}`,
      `published_build=${publishedBuildId?.slice(0, 12) ?? 'unavailable'}`,
      `publication=${publicationMatches ? 'match' : 'mismatch'}`,
      ...(artifactFailure ? [`artifact_failure=${artifactFailure}`] : []),
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
  if (readiness.ready || !readiness.retryable || waitMs <= 0) return readiness

  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await delay(Math.min(
      AUTO_REFRESH_READINESS_POLL_MS,
      Math.max(1, deadline - Date.now()),
    ))
    readiness = autoRefreshGraphReadiness(controller, graphPath)
    if (readiness.ready || !readiness.retryable) return readiness
  }
  return autoRefreshGraphReadiness(controller, graphPath)
}

function graphNotReadyResponse(
  request: StdioRequest,
  readiness: AutoRefreshGraphReadiness,
  waitedMs: number,
): StdioResponse {
  return failure(
    requestId(request),
    JSONRPC_SERVER_ERROR,
    readiness.retryable
      ? `Madar graph is temporarily ${readiness.state}. Retry the same request after ${readiness.retryAfterMs ?? 1_000}ms.`
      : `Madar cannot serve the accepted graph (${readiness.detail}). Run madar status and repair the index before retrying.`,
    {
      type: 'madar_graph_not_ready',
      state: readiness.state,
      retryable: readiness.retryable,
      ...(readiness.retryAfterMs === undefined
        ? {}
        : { retry_after_ms: readiness.retryAfterMs }),
      ...(waitedMs > 0 ? { waited_ms: waitedMs } : {}),
      suggested_action: readiness.retryable
        ? 'retry_same_request'
        : 'repair_graph',
    },
  )
}

function listedResources(graphPath: string) {
  try {
    return resourcesForGraph(graphPath, loadGraphReceiptCached(graphPath))
  } catch {
    return []
  }
}

export function handleStdioRequest(
  graphPath: string,
  payload: unknown,
): StdioResponse | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return failure(null, JSONRPC_INVALID_REQUEST, 'Invalid request')
  }

  const request = payload as StdioRequest
  const id = requestId(request)
  const method = typeof request.method === 'string' ? request.method : null
  if (!method) {
    return failure(id, JSONRPC_INVALID_REQUEST, 'Invalid request: missing method')
  }

  const notification = !Object.hasOwn(request, 'id')
  if (notification) return null

  try {
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            resources: { listChanged: false },
            tools: { listChanged: false },
          },
          serverInfo: {
            name: MCP_SERVER_NAME,
            title: MCP_SERVER_TITLE,
            version: readPackageVersion(),
          },
          instructions:
            'Call retrieve once with the user codebase question. The result is a deterministic, bounded evidence path from the authenticated TypeScript/JavaScript index.',
        })
      case 'ping':
        return ok(id, {})
      case 'tools/list':
        return ok(id, { tools: MCP_TOOLS })
      case 'tools/call':
        return handleToolCall(id, graphPath, request.params, {
          ok,
          failure,
          loadGraphReceipt: loadGraphReceiptCached,
          jsonrpcInvalidParams: JSONRPC_INVALID_PARAMS,
          jsonrpcMethodNotFound: JSONRPC_METHOD_NOT_FOUND,
        })
      case 'resources/list':
        return ok(id, { resources: listedResources(graphPath) })
      case 'resources/templates/list':
        return ok(id, { resourceTemplates: [] })
      case 'resources/read':
        return handleResourceRead(id, graphPath, request.params, {
          ok,
          failure,
          jsonrpcInvalidParams: JSONRPC_INVALID_PARAMS,
          jsonrpcServerError: JSONRPC_SERVER_ERROR,
          maxResourceBytes: MAX_STDIO_RESOURCE_BYTES,
        })
      case 'prompts/list':
        return ok(id, { prompts: [] })
      default:
        return failure(
          id,
          JSONRPC_METHOD_NOT_FOUND,
          `Method not found: ${method}`,
        )
    }
  } catch {
    return failure(id, JSONRPC_SERVER_ERROR, 'Madar request failed')
  }
}

export async function serveGraphStdio(
  options: ServeGraphStdioOptions,
): Promise<void> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const errorOutput = options.errorOutput ?? process.stderr
  let autoRefresh: GraphAutoRefreshController | null = null

  if (options.autoRefresh) {
    const workspaceRoot = options.workspaceRoot ?? graphRootPath(options.graphPath)
    if (!workspaceRoot) {
      throw new Error(
        'Cannot auto-refresh a graph without a workspace root. Run madar generate from the workspace first.',
      )
    }

    const workspace = resolveMadarWorkspace(workspaceRoot)
    if (!sameFilesystemPath(options.graphPath, workspace.graphPath)) {
      throw new Error(
        `Refusing to auto-refresh ${options.graphPath}: it is not the graph artifact for ${workspace.rootPath}. `
        + 'Start the MCP server from the intended worktree instead.',
      )
    }

    const startAutoRefresh = options.autoRefreshStarter ?? startWatchIndex
    autoRefresh = startAutoRefresh(
      workspace.rootPath,
      options.autoRefreshDebounceSeconds ?? 1,
      {
        update: updateIndexInWorker,
        logger: {
          log() {},
          error(message) {
            errorOutput.write(
              `[madar serve] ${message ?? 'Auto-refresh failed'}\n`,
            )
          },
        },
      },
    )
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
      const method = typeof request.method === 'string' ? request.method : null
      const needsReadiness = method !== null
        && (GRAPH_BACKED_METHODS.has(method) || method === 'resources/list')
      let readiness = autoRefresh && needsReadiness
        ? autoRefreshGraphReadiness(autoRefresh, options.graphPath)
        : null
      let waitedMs = 0

      if (awaitReconciliation && autoRefresh && readiness?.retryable) {
        const maxWaitMs = Math.max(
          0,
          options.autoRefreshRequestWaitMs
            ?? DEFAULT_AUTO_REFRESH_REQUEST_WAIT_MS,
        )
        readiness = await waitForAutoRefreshGraphReadiness(
          autoRefresh,
          options.graphPath,
          Math.max(0, maxWaitMs - (Date.now() - arrivalMs)),
        )
        waitedMs = Date.now() - arrivalMs
      }

      if (method === 'resources/list' && readiness && !readiness.ready) {
        response = ok(requestId(request), { resources: [] })
      } else {
        response = readiness && !readiness.ready
          ? graphNotReadyResponse(request, readiness, waitedMs)
          : handleStdioRequest(options.graphPath, payload)
      }
    } catch {
      response = failure(
        requestId(payload as StdioRequest),
        JSONRPC_SERVER_ERROR,
        'Madar request failed',
      )
    }

    if (response) output.write(`${JSON.stringify(response)}\n`)
  }

  try {
    for await (const line of readline) {
      const trimmed = line.trim()
      if (!trimmed) continue

      if (Buffer.byteLength(trimmed) > MAX_STDIO_LINE_BYTES) {
        output.write(`${JSON.stringify(failure(
          null,
          JSONRPC_INVALID_REQUEST,
          `Payload too large (max ${MAX_STDIO_LINE_BYTES} bytes)`,
        ))}\n`)
        continue
      }

      let payload: unknown
      try {
        payload = JSON.parse(trimmed)
      } catch {
        output.write(`${JSON.stringify(failure(
          null,
          JSONRPC_PARSE_ERROR,
          'Parse error',
        ))}\n`)
        continue
      }

      const request = payload as StdioRequest
      const method = typeof request.method === 'string' ? request.method : null
      if (autoRefresh && method && GRAPH_BACKED_METHODS.has(method)) {
        const arrivalMs = Date.now()
        graphRequestQueue = graphRequestQueue.then(
          () => handleAndWritePayload(payload, true, arrivalMs),
        )
      } else {
        await handleAndWritePayload(payload, false)
      }
    }
  } finally {
    await graphRequestQueue
    if (autoRefresh) {
      autoRefresh.stop()
      await autoRefresh.completed
    }
  }
}
