import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Writable } from 'node:stream'

import { freshnessAnnotations, resourceFreshnessMetadata } from '../freshness.js'
import { validateGraphPath } from '../../shared/security.js'
import { resolveWorkspaceGraphPath } from '../../shared/workspace.js'
import {
  CANONICAL_ARTIFACT_BASENAME,
  LEGACY_ARTIFACT_BASENAME,
} from '../../contracts/graph-artifact-selection.js'

interface StdioResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface ResourceSessionState {
  subscribedResourceUris?: Set<string>
  resourceVersions?: Map<string, string>
  resourceListSignature?: string | null
}

interface McpResourceDefinition {
  uri: string
  name: string
  title: string
  description: string
  mimeType: string
  filePath: string
  annotations?: Record<string, number | string>
}

interface ResourceHelpers {
  ok(id: string | number | null, result: unknown): StdioResponse
  failure(id: string | number | null, code: number, message: string): StdioResponse
  stringParam(params: unknown, key: string): string | null
  ensureSubscribedResourceUris(state: ResourceSessionState): Set<string>
  ensureResourceVersions(state: ResourceSessionState): Map<string, string>
  jsonrpcInvalidParams: number
  jsonrpcServerError: number
  maxStdioTextLength: number
  maxResourceBytes: number
  maxResourceSubscriptions: number
}

function notification(method: string, params?: unknown): JsonRpcNotification {
  return {
    jsonrpc: '2.0',
    method,
    ...(params !== undefined ? { params } : {}),
  }
}

function resourceUri(name: string): string {
  return `madar://artifact/${name}`
}

/**
 * Explains a resource miss, distinguishing "moved" from "never existed".
 *
 * "Unknown resource" reads like a typo or a version skew. A client that
 * hard-coded the v1 artifact URI needs to learn the resource moved AND that the
 * replacement is a different format, not a rename it can transparently follow.
 * Only said once the workspace actually has a canonical artifact -- in a
 * pre-cutover workspace the v1 URI is served, so nothing has moved.
 */
function unknownResourceMessage(uri: string, graphPath: string): string {
  if (uri !== resourceUri(LEGACY_ARTIFACT_BASENAME)) return `Unknown resource: ${uri}`
  const canonicalServed = resourcesForGraph(graphPath)
    .some((entry) => entry.uri === resourceUri(CANONICAL_ARTIFACT_BASENAME))
  return canonicalServed
    ? `${uri} is gone. Read ${resourceUri(CANONICAL_ARTIFACT_BASENAME)} instead, which serves artifact v2 `
      + 'and is not v1-compatible.'
    : `Unknown resource: ${uri}`
}

export function resourcesForGraph(graphPath: string): McpResourceDefinition[] {
  // During a first auto-refresh startup the MCP transport is available before
  // graph.json. Resource discovery must return an empty list instead of making
  // initialize fail through notification bookkeeping.
  const effectiveGraphPath = resolveWorkspaceGraphPath(graphPath, undefined, 'explicit')
  if (!existsSync(effectiveGraphPath)) {
    return []
  }
  const safeGraphPath = validateGraphPath(effectiveGraphPath)
  const outputDir = dirname(safeGraphPath)
  const canonicalPath = join(outputDir, CANONICAL_ARTIFACT_BASENAME)
  // A workspace that never cut over still has a real v1 and keeps serving it
  // under its own URI and media type. Publishing it as the canonical artifact
  // would label v1 bytes as v2; publishing nothing would strip a legacy
  // workspace of its graph resource entirely.
  const graphResource: McpResourceDefinition = existsSync(canonicalPath)
    ? {
        uri: resourceUri(CANONICAL_ARTIFACT_BASENAME),
        name: CANONICAL_ARTIFACT_BASENAME,
        title: 'Graph Artifact',
        description: 'Canonical Madar graph artifact v2 with nodes, facts, occurrences, and provenance.',
        // Not application/json. The artifact is a header followed by JSON, so a
        // client that trusts the MIME type and parses the whole body fails.
        mimeType: 'application/vnd.madar.graph-artifact.v2',
        filePath: canonicalPath,
      }
    : {
        uri: resourceUri(LEGACY_ARTIFACT_BASENAME),
        name: LEGACY_ARTIFACT_BASENAME,
        title: 'Graph JSON',
        description: 'GraphRAG-ready graph export with nodes, links, and hyperedges.',
        mimeType: 'application/json',
        filePath: safeGraphPath,
      }
  const candidates: McpResourceDefinition[] = [
    graphResource,
    {
      uri: resourceUri('GRAPH_REPORT.md'),
      name: 'GRAPH_REPORT.md',
      title: 'Graph Report',
      description: 'Markdown report summarizing the generated graph.',
      mimeType: 'text/markdown',
      filePath: join(outputDir, 'GRAPH_REPORT.md'),
    },
    {
      uri: resourceUri('graph.html'),
      name: 'graph.html',
      title: 'Interactive Graph Explorer',
      description: 'Interactive HTML graph explorer generated by madar.',
      mimeType: 'text/html',
      filePath: join(outputDir, 'graph.html'),
    },
  ]

  return candidates
    .filter((resource) => existsSync(resource.filePath))
    .map((resource) => ({
      ...resource,
      annotations: freshnessAnnotations(resourceFreshnessMetadata(safeGraphPath, resource.filePath)),
    }))
}

function resourceListSignature(resources: readonly McpResourceDefinition[]): string {
  return resources
    .map((resource) => resource.uri)
    .sort()
    .join('|')
}

function resourceVersion(resource: McpResourceDefinition): string {
  const graphVersion = String(resource.annotations?.graph_version ?? '')
  const modifiedAt = String(resource.annotations?.resource_modified_ms ?? '')
  return `${graphVersion}:${modifiedAt}`
}

function emitJsonRpcNotification(output: Writable, message: JsonRpcNotification): void {
  try {
    output.write(`${JSON.stringify(message)}\n`)
  } catch {
    // Ignore closed stream cases.
  }
}

export function emitResourceNotifications(output: Writable, graphPath: string, state: ResourceSessionState): void {
  const resources = resourcesForGraph(graphPath)
  const nextListSignature = resourceListSignature(resources)
  if (state.resourceListSignature !== null && state.resourceListSignature !== nextListSignature) {
    emitJsonRpcNotification(output, notification('notifications/resources/list_changed'))
  }
  state.resourceListSignature = nextListSignature

  const subscribedUris = state.subscribedResourceUris ?? new Set<string>()
  if (subscribedUris.size === 0) {
    return
  }

  const versions = state.resourceVersions ?? new Map<string, string>()
  state.resourceVersions = versions
  const resourcesByUri = new Map(resources.map((resource) => [resource.uri, resource]))
  for (const uri of [...subscribedUris].sort()) {
    const resource = resourcesByUri.get(uri)
    if (!resource) {
      versions.delete(uri)
      continue
    }

    const nextVersion = resourceVersion(resource)
    const previousVersion = versions.get(uri)
    if (previousVersion !== undefined && previousVersion !== nextVersion) {
      emitJsonRpcNotification(output, notification('notifications/resources/updated', { uri }))
    }

    versions.set(uri, nextVersion)
  }
}

export function handleResourceRead(
  id: string | number | null,
  graphPath: string,
  params: unknown,
  helpers: ResourceHelpers,
): StdioResponse {
  const uri = helpers.stringParam(params, 'uri')
  if (!uri) {
    return helpers.failure(id, helpers.jsonrpcInvalidParams, `resources/read requires a string uri parameter <= ${helpers.maxStdioTextLength} characters`)
  }

  const resource = resourcesForGraph(graphPath).find((entry) => entry.uri === uri)
  if (!resource) {
    return helpers.failure(id, helpers.jsonrpcInvalidParams, unknownResourceMessage(uri, graphPath))
  }

  if (statSync(resource.filePath).size > helpers.maxResourceBytes) {
    return helpers.failure(id, helpers.jsonrpcServerError, `Resource too large to read over stdio: ${resource.name}`)
  }

  return helpers.ok(id, {
    contents: [
      {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: readFileSync(resource.filePath, 'utf8'),
        annotations: resource.annotations,
      },
    ],
  })
}

export function handleResourceSubscribe(
  id: string | number | null,
  graphPath: string,
  params: unknown,
  sessionState: ResourceSessionState,
  helpers: ResourceHelpers,
): StdioResponse {
  const uri = helpers.stringParam(params, 'uri')
  if (!uri) {
    return helpers.failure(id, helpers.jsonrpcInvalidParams, `resources/subscribe requires a string uri parameter <= ${helpers.maxStdioTextLength} characters`)
  }

  const resource = resourcesForGraph(graphPath).find((entry) => entry.uri === uri)
  if (!resource) {
    return helpers.failure(id, helpers.jsonrpcInvalidParams, unknownResourceMessage(uri, graphPath))
  }

  const subscribedUris = helpers.ensureSubscribedResourceUris(sessionState)
  if (!subscribedUris.has(uri) && subscribedUris.size >= helpers.maxResourceSubscriptions) {
    return helpers.failure(id, helpers.jsonrpcInvalidParams, `Subscription limit exceeded (${helpers.maxResourceSubscriptions})`)
  }

  subscribedUris.add(uri)
  helpers.ensureResourceVersions(sessionState).set(uri, resourceVersion(resource))
  sessionState.resourceListSignature = resourceListSignature(resourcesForGraph(graphPath))
  return helpers.ok(id, {})
}

export function handleResourceUnsubscribe(
  id: string | number | null,
  params: unknown,
  sessionState: ResourceSessionState,
  helpers: ResourceHelpers,
): StdioResponse {
  const uri = helpers.stringParam(params, 'uri')
  if (!uri) {
    return helpers.failure(id, helpers.jsonrpcInvalidParams, `resources/unsubscribe requires a string uri parameter <= ${helpers.maxStdioTextLength} characters`)
  }

  helpers.ensureSubscribedResourceUris(sessionState).delete(uri)
  helpers.ensureResourceVersions(sessionState).delete(uri)
  return helpers.ok(id, {})
}
