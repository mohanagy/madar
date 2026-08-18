import { graphPathForCommand, graphPathIntentFor } from '../shared/workspace.js'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { validateGraphPath } from '../shared/security.js'
import { graphFreshnessHeaders, graphFreshnessMetadata, resourceFreshnessHeaders, resourceFreshnessMetadata } from './freshness.js'
import { communitiesFromGraph, getCommunity, getNeighbors, getNode, graphStats, loadGraph, queryGraph, semanticAnomaliesSummary, shortestPath } from './serve.js'
import type { KnowledgeGraph } from '../contracts/graph.js'
import {
  CANONICAL_ARTIFACT_BASENAME,
  LEGACY_ARTIFACT_BASENAME,
  type WorkspaceGraphState,
  classifyWorkspaceGraph,
} from '../contracts/graph-artifact-selection.js'

export interface ServeLogger {
  log(message?: string): void
  error(message?: string): void
}

export interface ServeGraphOptions {
  graphPath?: string
  host?: string
  port?: number
  signal?: AbortSignal
  logger?: ServeLogger
}

export interface ServeGraphHandle {
  host: string
  port: number
  url: string
  close(): Promise<void>
}

const MAX_HTTP_QUERY_LENGTH = 2_000
const MAX_HTTP_LABEL_LENGTH = 512
const MAX_HTTP_TOKEN_BUDGET = 100_000
const REQUESTS_PER_WINDOW = 120
const RATE_LIMIT_WINDOW_MS = 60_000
const SERVER_TIMEOUT_MS = 30_000

function defaultLogger(logger?: ServeLogger): ServeLogger {
  return logger ?? console
}

function parsePort(value: number | undefined): number {
  if (value === undefined) {
    return 4173
  }
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`Invalid port: ${value}`)
  }
  return value
}

function sendText(response: ServerResponse, statusCode: number, body: string, contentType = 'text/plain; charset=utf-8', headers: Record<string, string> = {}): void {
  response.writeHead(statusCode, { 'content-type': contentType, ...headers })
  response.end(body)
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', ...headers })
  response.end(`${JSON.stringify(body, null, 2)}\n`)
}

/** Vendor media type: a v2 artifact is not JSON and must not claim to be. */
const GRAPH_ARTIFACT_MEDIA_TYPE = 'application/vnd.madar.graph-artifact.v2; charset=utf-8'

const PROBLEM_BASE = 'https://madar.dev/problems'

function sendProblem(
  response: ServerResponse,
  statusCode: number,
  problem: Record<string, unknown>,
  extra: { link?: string } = {},
): void {
  response.writeHead(statusCode, {
    'content-type': 'application/problem+json; charset=utf-8',
    ...(extra.link === undefined ? {} : { link: extra.link }),
  })
  response.end(`${JSON.stringify(problem, null, 2)}\n`)
}

function workspaceStateDetail(state: WorkspaceGraphState): string {
  switch (state) {
    case 'mixed_v2_and_live_v1':
      return `A valid ${CANONICAL_ARTIFACT_BASENAME} and a live v1 ${LEGACY_ARTIFACT_BASENAME} exist together, `
        + 'and nothing proves they describe the same generation.'
    case 'moved_without_canonical':
      return `${LEGACY_ARTIFACT_BASENAME} has moved but ${CANONICAL_ARTIFACT_BASENAME} is missing.`
    case 'invalid_current_v2':
      return `${CANONICAL_ARTIFACT_BASENAME} exists but is not a readable v2 artifact.`
    case 'missing':
      return 'This workspace has no graph artifact.'
    default:
      return 'The graph artifacts in this workspace cannot be classified.'
  }
}

function readUtf8File(filePath: string): string {
  return readFileSync(filePath, 'utf8')
}

function renderIndex(outputDir: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>madar runtime</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 2rem; line-height: 1.5; }
    code { background: #f4f4f4; padding: 0.125rem 0.25rem; border-radius: 0.25rem; }
    ul { padding-left: 1.25rem; }
  </style>
</head>
<body>
  <h1>madar runtime</h1>
  <p>Serving graph artifacts from <code>${outputDir}</code>.</p>
  <ul>
    <li><a href="/graph.html">graph.html</a></li>
    <li><a href="/graph.madar">graph.madar</a></li>
    <li><a href="/GRAPH_REPORT.md">GRAPH_REPORT.md</a></li>
    <li><a href="/stats">/stats</a></li>
    <li><a href="/health">/health</a></li>
  </ul>
  <p>Query endpoints:</p>
  <ul>
    <li><code>/query?q=auth+flow&amp;mode=bfs&amp;budget=2000&amp;rank=degree&amp;community=0&amp;file_type=code</code></li>
    <li><code>/anomalies?limit=5</code></li>
    <li><code>/path?source=Auth&amp;target=Database</code></li>
    <li><code>/node?label=HttpClient</code></li>
    <li><code>/neighbors?label=HttpClient&amp;relation=calls</code></li>
    <li><code>/community?id=0</code></li>
  </ul>
</body>
</html>`
}

function graphOutputDirectory(graphPath: string): string {
  return dirname(validateGraphPath(graphPath))
}

function parseQueryText(value: string | null, field: string, maxLength: number): string {
  const normalized = value?.trim() ?? ''
  if (normalized.length === 0) {
    throw new Error(`Missing required query parameter: ${field}`)
  }
  if (normalized.length > maxLength) {
    throw new Error(`Query parameter '${field}' exceeds maximum length of ${maxLength}`)
  }
  return normalized
}

function normalizeBudget(value: string | null): number {
  const parsed = Number.parseInt(value ?? '2000', 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 2000
  }
  return Math.min(parsed, MAX_HTTP_TOKEN_BUDGET)
}

function normalizeRank(value: string | null): 'relevance' | 'degree' {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) {
    return 'relevance'
  }
  if (normalized === 'relevance' || normalized === 'degree') {
    return normalized
  }
  throw new Error("Query parameter 'rank' must be one of relevance, degree")
}

function parseOptionalNonNegativeInteger(value: string | null, field: string): number | undefined {
  const normalized = value?.trim() ?? ''
  if (normalized.length === 0) {
    return undefined
  }

  const parsed = Number(normalized)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Query parameter '${field}' must be a non-negative integer`)
  }

  return parsed
}

function parseOptionalShortText(value: string | null, field: string): string | undefined {
  const normalized = value?.trim() ?? ''
  if (normalized.length === 0) {
    return undefined
  }
  if (normalized.length > MAX_HTTP_LABEL_LENGTH) {
    throw new Error(`Query parameter '${field}' exceeds maximum length of ${MAX_HTTP_LABEL_LENGTH}`)
  }
  return normalized
}

function parsePositiveInteger(value: string | null, field: string, defaultValue: number, maxValue: number): number {
  const normalized = value?.trim() ?? ''
  if (normalized.length === 0) {
    return defaultValue
  }

  const parsed = Number(normalized)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxValue) {
    throw new Error(`Query parameter '${field}' must be an integer between 1 and ${maxValue}`)
  }

  return parsed
}

function createGraphLoader(graphPath: string): () => KnowledgeGraph {
  let cachedGraph: KnowledgeGraph | null = null
  let cachedMtime = -1

  return () => {
    const currentMtime = statSync(graphPath).mtimeMs
    if (!cachedGraph || currentMtime !== cachedMtime) {
      cachedGraph = loadGraph(graphPath)
      cachedMtime = currentMtime
    }
    return cachedGraph
  }
}

function allowRequest(rateLimitState: Map<string, { count: number; resetAt: number }>, remoteAddress: string | undefined, now = Date.now()): boolean {
  const key = remoteAddress && remoteAddress.length > 0 ? remoteAddress : 'unknown'
  const current = rateLimitState.get(key)

  if (!current || current.resetAt <= now) {
    rateLimitState.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }

  if (current.count >= REQUESTS_PER_WINDOW) {
    return false
  }

  rateLimitState.set(key, { count: current.count + 1, resetAt: current.resetAt })
  return true
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolvePromise()
    })
  })
}

export async function startGraphServer(options: ServeGraphOptions = {}): Promise<ServeGraphHandle> {
  const output = defaultLogger(options.logger)
  const host = options.host ?? '127.0.0.1'
  const port = parsePort(options.port)
  // Intent survives the server boundary. Substituting the canonical default for
  // an omitted option and handing that to validateGraphPath marked every start
  // explicit, so a server launched with no --graph in an ambiguous workspace
  // loaded the canonical artifact instead of failing closed like every other
  // default load.
  const graphPath = validateGraphPath(graphPathForCommand({
    graphPath: options.graphPath ?? `out/${CANONICAL_ARTIFACT_BASENAME}`,
    graphPathIntent: graphPathIntentFor(options.graphPath),
  }))
  const outputDir = graphOutputDirectory(graphPath)
  const graph = createGraphLoader(graphPath)
  const rateLimitState = new Map<string, { count: number; resetAt: number }>()

  const server = createServer((request, response) => {
    try {
      if (!allowRequest(rateLimitState, request.socket.remoteAddress)) {
        sendText(response, 429, 'Too many requests')
        return
      }

      const url = new URL(request.url ?? '/', `http://${host}`)
      const graphHeaders = graphFreshnessHeaders(graphFreshnessMetadata(graphPath))

      if (url.pathname === '/' || url.pathname === '/index.html') {
        const htmlPath = join(outputDir, 'graph.html')
        const html = existsSync(htmlPath) ? readUtf8File(htmlPath) : renderIndex(outputDir)
        sendText(response, 200, html, 'text/html; charset=utf-8', graphHeaders)
        return
      }

      if (url.pathname === '/graph.html') {
        const htmlPath = join(outputDir, 'graph.html')
        if (!existsSync(htmlPath)) {
          sendText(response, 404, 'graph.html not found. Re-run madar generate without --no-html.')
          return
        }
        sendText(response, 200, readUtf8File(htmlPath), 'text/html; charset=utf-8', resourceFreshnessHeaders(resourceFreshnessMetadata(graphPath, htmlPath)))
        return
      }

      if (
        url.pathname === `/${CANONICAL_ARTIFACT_BASENAME}`
        || url.pathname === `/${LEGACY_ARTIFACT_BASENAME}`
      ) {
        /*
         * Raw artifact routes are decided by workspace state, not by which
         * files happen to exist. The two 200-serving states are mutually
         * exclusive -- current_v2 serves only the canonical artifact,
         * legacy_v1_only serves only the v1 -- and every ambiguous or damaged
         * state serves neither.
         */
        const state = classifyWorkspaceGraph(outputDir).state
        const wantsCanonical = url.pathname === `/${CANONICAL_ARTIFACT_BASENAME}`
        const canonical = join(outputDir, CANONICAL_ARTIFACT_BASENAME)

        if (state === 'current_v2') {
          if (wantsCanonical) {
            sendText(
              response,
              200,
              readUtf8File(canonical),
              GRAPH_ARTIFACT_MEDIA_TYPE,
              resourceFreshnessHeaders(resourceFreshnessMetadata(graphPath, canonical)),
            )
            return
          }
          /*
           * Gone, not moved. A redirect would hand a v1 client a v2 body it
           * cannot parse: the formats are not interchangeable, so the request
           * must be reported unsatisfiable rather than quietly pointed
           * elsewhere. The Link header names the successor for clients that
           * can act on it, without implying the response body is a substitute.
           */
          sendProblem(response, 410, {
            type: `${PROBLEM_BASE}/graph-artifact-moved`,
            title: 'The v1 graph artifact is gone',
            status: 410,
            detail: `${LEGACY_ARTIFACT_BASENAME} is no longer published. Request `
              + `/${CANONICAL_ARTIFACT_BASENAME}, which serves artifact v2 and is not v1-compatible.`,
            canonical_path: `/${CANONICAL_ARTIFACT_BASENAME}`,
          }, { link: `</${CANONICAL_ARTIFACT_BASENAME}>; rel="successor-version"` })
          return
        }

        if (state === 'legacy_v1_only') {
          if (wantsCanonical) {
            // Truthful: this workspace has no v2 artifact to serve.
            sendProblem(response, 404, {
              type: `${PROBLEM_BASE}/canonical-artifact-required`,
              title: 'No canonical graph artifact',
              status: 404,
              detail: `This workspace has not been cut over, so ${CANONICAL_ARTIFACT_BASENAME} does not `
                + `exist. Run \`madar generate .\` to produce it, or request /${LEGACY_ARTIFACT_BASENAME} `
                + 'for the legacy v1 artifact.',
              workspace_state: state,
            })
            return
          }
          // Nothing has moved here, so the v1 is served as itself -- and the
          // freshness headers describe that same file. Measuring graphPath
          // instead made etag, last-modified and the resource-byte headers
          // describe a different artifact than the body they accompany.
          const servedLegacyPath = join(outputDir, LEGACY_ARTIFACT_BASENAME)
          sendText(
            response,
            200,
            readUtf8File(servedLegacyPath),
            'application/json; charset=utf-8',
            resourceFreshnessHeaders(resourceFreshnessMetadata(servedLegacyPath, servedLegacyPath)),
          )
          return
        }

        // mixed_v2_and_live_v1, moved_without_canonical, invalid_current_v2,
        // invalid, missing: neither endpoint serves a graph, and a preserved
        // backup is never an automatic fallback.
        sendProblem(response, 409, {
          type: `${PROBLEM_BASE}/graph-workspace-unusable`,
          title: 'The graph workspace is not in a servable state',
          status: 409,
          detail: `${workspaceStateDetail(state)} Run \`madar generate .\` to rebuild from source.`,
          workspace_state: state,
        })
        return
      }

      if (url.pathname === '/GRAPH_REPORT.md') {
        const reportPath = join(outputDir, 'GRAPH_REPORT.md')
        if (!existsSync(reportPath)) {
          sendText(response, 404, 'GRAPH_REPORT.md not found.')
          return
        }
        sendText(response, 200, readUtf8File(reportPath), 'text/markdown; charset=utf-8', resourceFreshnessHeaders(resourceFreshnessMetadata(graphPath, reportPath)))
        return
      }

      if (url.pathname === '/health') {
        sendJson(response, 200, { ok: true }, graphHeaders)
        return
      }

      if (url.pathname === '/stats') {
        const loadedGraph = graph()
        sendText(response, 200, graphStats(loadedGraph, communitiesFromGraph(loadedGraph)), 'text/plain; charset=utf-8', graphHeaders)
        return
      }

      if (url.pathname === '/anomalies') {
        const limit = parsePositiveInteger(url.searchParams.get('limit'), 'limit', 5, 100)
        sendText(response, 200, semanticAnomaliesSummary(graphPath, limit), 'text/plain; charset=utf-8', graphHeaders)
        return
      }

      if (url.pathname === '/query') {
        const question = parseQueryText(url.searchParams.get('q'), 'q', MAX_HTTP_QUERY_LENGTH)
        const mode = url.searchParams.get('mode') === 'dfs' ? 'dfs' : 'bfs'
        const budget = normalizeBudget(url.searchParams.get('budget'))
        const rankBy = normalizeRank(url.searchParams.get('rank') ?? url.searchParams.get('rank_by'))
        const community = parseOptionalNonNegativeInteger(url.searchParams.get('community'), 'community')
        const fileType = parseOptionalShortText(url.searchParams.get('file_type') ?? url.searchParams.get('fileType'), 'file_type')
        const filters = {
          ...(community !== undefined ? { community } : {}),
          ...(fileType ? { fileType } : {}),
        }
        sendText(
          response,
          200,
          queryGraph(graph(), question, {
            mode,
            tokenBudget: budget,
            rankBy,
            ...(Object.keys(filters).length > 0 ? { filters } : {}),
          }),
          'text/plain; charset=utf-8',
          graphHeaders,
        )
        return
      }

      if (url.pathname === '/path') {
        const source = parseQueryText(url.searchParams.get('source'), 'source', MAX_HTTP_LABEL_LENGTH)
        const target = parseQueryText(url.searchParams.get('target'), 'target', MAX_HTTP_LABEL_LENGTH)
        sendText(response, 200, shortestPath(graph(), source, target), 'text/plain; charset=utf-8', graphHeaders)
        return
      }

      if (url.pathname === '/node') {
        const label = parseQueryText(url.searchParams.get('label'), 'label', MAX_HTTP_LABEL_LENGTH)
        sendText(response, 200, getNode(graph(), label), 'text/plain; charset=utf-8', graphHeaders)
        return
      }

      if (url.pathname === '/neighbors') {
        const label = parseQueryText(url.searchParams.get('label'), 'label', MAX_HTTP_LABEL_LENGTH)
        const relation = url.searchParams.get('relation')?.trim() ?? ''
        if (relation.length > MAX_HTTP_LABEL_LENGTH) {
          sendText(response, 400, `Query parameter 'relation' exceeds maximum length of ${MAX_HTTP_LABEL_LENGTH}`)
          return
        }
        sendText(response, 200, getNeighbors(graph(), label, relation), 'text/plain; charset=utf-8', graphHeaders)
        return
      }

      if (url.pathname === '/community') {
        const communityId = Number.parseInt(url.searchParams.get('id') ?? '', 10)
        if (!Number.isFinite(communityId)) {
          sendText(response, 400, 'Missing required numeric query parameter: id')
          return
        }
        const loadedGraph = graph()
        sendText(response, 200, getCommunity(loadedGraph, communitiesFromGraph(loadedGraph), communityId), 'text/plain; charset=utf-8', graphHeaders)
        return
      }

      sendText(response, 404, 'Not found')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('Missing required query parameter') || message.startsWith("Query parameter '")) {
        sendText(response, 400, message)
        return
      }

      output.error(`[madar serve] Request failed: ${message}`)
      sendText(response, 500, 'Internal server error')
    }
  })

  server.setTimeout(SERVER_TIMEOUT_MS)
  server.requestTimeout = SERVER_TIMEOUT_MS
  server.headersTimeout = SERVER_TIMEOUT_MS

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolvePromise()
    })
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  const url = `http://${host}:${actualPort}/`

  const close = async (): Promise<void> => {
    if (!server.listening) {
      return
    }
    await closeServer(server)
  }

  if (options.signal) {
    if (options.signal.aborted) {
      await close()
    } else {
      options.signal.addEventListener(
        'abort',
        () => {
          void close()
        },
        { once: true },
      )
    }
  }

  return {
    host,
    port: actualPort,
    url,
    close,
  }
}

export async function serveGraph(options: ServeGraphOptions = {}): Promise<void> {
  const output = defaultLogger(options.logger)
  // Intent survives the server boundary. Substituting the canonical default for
  // an omitted option and handing that to validateGraphPath marked every start
  // explicit, so a server launched with no --graph in an ambiguous workspace
  // loaded the canonical artifact instead of failing closed like every other
  // default load.
  const graphPath = validateGraphPath(graphPathForCommand({
    graphPath: options.graphPath ?? `out/${CANONICAL_ARTIFACT_BASENAME}`,
    graphPathIntent: graphPathIntentFor(options.graphPath),
  }))
  const handle = await startGraphServer(options)

  output.log(`[madar serve] Serving ${graphPath}`)
  output.log(`[madar serve] Runtime available at ${handle.url}`)
  output.log('[madar serve] Press Ctrl+C to stop.')

  await new Promise<void>((resolvePromise) => {
    if (options.signal?.aborted) {
      resolvePromise()
      return
    }

    const finish = (): void => {
      process.off('SIGINT', finish)
      process.off('SIGTERM', finish)
      options.signal?.removeEventListener('abort', finish)
      resolvePromise()
    }

    process.once('SIGINT', finish)
    process.once('SIGTERM', finish)
    options.signal?.addEventListener('abort', finish, { once: true })
  })

  await handle.close()
}
