import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Writable } from 'node:stream'

import { freshnessAnnotations, resourceFreshnessMetadata } from '../freshness.js'
import { validateGraphPath } from '../../shared/security.js'
import { resolveWorkspaceGraphPath } from '../../shared/workspace.js'
import { readGraphArtifactReceipt, type GraphArtifactReceipt } from '../../adapters/filesystem/graph-artifact.js'
import { readMatchingReportReceipt } from '../../adapters/filesystem/index-store.js'

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

export function resourcesForGraph(graphPath: string, knownReceipt?: GraphArtifactReceipt): McpResourceDefinition[] {
  // During a first auto-refresh startup the MCP transport is available before
  // graph.json. Resource discovery must return an empty list instead of making
  // initialize fail through notification bookkeeping.
  const effectiveGraphPath = resolveWorkspaceGraphPath(graphPath)
  if (!existsSync(effectiveGraphPath)) {
    return []
  }
  const safeGraphPath = validateGraphPath(effectiveGraphPath)
  const graphReceipt = knownReceipt?.graphPath === safeGraphPath ? knownReceipt : readGraphArtifactReceipt(safeGraphPath)
  const graphArtifact = graphReceipt.artifact
  const reportReceipt = readMatchingReportReceipt(safeGraphPath, graphReceipt)
  const outputDir = dirname(safeGraphPath)
  const candidates: McpResourceDefinition[] = [
    {
      uri: resourceUri('graph.json'),
      name: 'graph.json',
      title: 'Graph JSON',
      description: 'Canonical directed multigraph artifact with metadata, nodes, and edges.',
      mimeType: 'application/json',
      filePath: safeGraphPath,
    },
    {
      uri: resourceUri('GRAPH_REPORT.md'),
      name: 'GRAPH_REPORT.md',
      title: 'Graph Report',
      description: 'Markdown report summarizing the generated graph.',
      mimeType: 'text/markdown',
      filePath: join(outputDir, 'GRAPH_REPORT.md'),
    },
  ]

  return candidates
    .filter((resource) => existsSync(resource.filePath)
      && (resource.name !== 'GRAPH_REPORT.md' || reportReceipt !== null))
    .map((resource) => {
      const content = resource.name === 'graph.json' ? graphArtifact : reportReceipt!.report
      const reportFreshness = reportReceipt ? { ...reportReceipt, resourceModifiedMs: reportReceipt.reportModifiedMs } : undefined
      return { ...resource, annotations: freshnessAnnotations(resourceFreshnessMetadata(
        safeGraphPath, resource.filePath, content, graphReceipt.graphSha256,
        resource.name === 'graph.json' ? graphReceipt : reportFreshness,
      )) }
    })
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

  const safeGraphPath = validateGraphPath(resolveWorkspaceGraphPath(graphPath))
  const graphReceipt = readGraphArtifactReceipt(safeGraphPath)
  const resource = resourcesForGraph(graphPath, graphReceipt).find((entry) => entry.uri === uri)
  if (!resource) {
    return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unknown resource: ${uri}`)
  }

  const receipt = resource.name === 'GRAPH_REPORT.md' ? readMatchingReportReceipt(safeGraphPath, graphReceipt) : null
  if (resource.name === 'GRAPH_REPORT.md' && receipt === null) {
    return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unknown resource: ${uri}`)
  }
  const text = receipt?.report ?? graphReceipt.artifact
  if (Buffer.byteLength(text) > helpers.maxResourceBytes) {
    return helpers.failure(id, helpers.jsonrpcServerError, `Resource too large to read over stdio: ${resource.name}`)
  }
  const annotations = freshnessAnnotations(resourceFreshnessMetadata(
    safeGraphPath, resource.filePath, text, graphReceipt.graphSha256,
    receipt ? { ...receipt, resourceModifiedMs: receipt.reportModifiedMs } : graphReceipt,
  ))

  return helpers.ok(id, {
    contents: [
      {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text,
        annotations,
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
    return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unknown resource: ${uri}`)
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
