import {
  readGraphArtifactReceipt,
  type GraphArtifactReceipt,
} from '../../adapters/filesystem/graph-artifact.js'
import { inspectQueryIndex } from '../../domain/query/index-status.js'
import { validateGraphPath } from '../../shared/security.js'
import { resolveWorkspaceGraphPath } from '../../shared/workspace.js'

interface StdioResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

export interface McpResourceDefinition {
  uri: string
  name: string
  title: string
  description: string
  mimeType: string
}

interface InternalResourceDefinition extends McpResourceDefinition {
  text: string
}

interface ResourceHelpers {
  ok(id: string | number | null, result: unknown): StdioResponse
  failure(id: string | number | null, code: number, message: string): StdioResponse
  jsonrpcInvalidParams: number
  jsonrpcServerError: number
  maxResourceBytes: number
}

function stringField(value: unknown, key: string): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field.length > 0 ? field : null
}

function resourceUri(name: string): string {
  return `madar://artifact/${name}`
}

function acceptedGraphReceipt(
  graphPath: string,
  knownReceipt?: GraphArtifactReceipt,
): GraphArtifactReceipt | null {
  try {
    const safeGraphPath = validateGraphPath(resolveWorkspaceGraphPath(graphPath))
    const receipt = knownReceipt?.graphPath === safeGraphPath
      ? knownReceipt
      : readGraphArtifactReceipt(safeGraphPath)
    return inspectQueryIndex(receipt.graph).state === 'ready' ? receipt : null
  } catch {
    return null
  }
}

function internalResourcesForGraph(
  graphPath: string,
  knownReceipt?: GraphArtifactReceipt,
): InternalResourceDefinition[] {
  const graphReceipt = acceptedGraphReceipt(graphPath, knownReceipt)
  if (!graphReceipt) return []

  return [
    {
      uri: resourceUri('graph.json'),
      name: 'graph.json',
      title: 'Graph JSON',
      description: 'The authenticated canonical directed multigraph artifact.',
      mimeType: 'application/json',
      text: graphReceipt.artifact,
    },
  ]
}

export function resourcesForGraph(
  graphPath: string,
  knownReceipt?: GraphArtifactReceipt,
): McpResourceDefinition[] {
  return internalResourcesForGraph(graphPath, knownReceipt)
    .map(({ text: _text, ...resource }) => resource)
}

export function handleResourceRead(
  id: string | number | null,
  graphPath: string,
  params: unknown,
  helpers: ResourceHelpers,
): StdioResponse {
  const uri = stringField(params, 'uri')
  if (!uri) {
    return helpers.failure(
      id,
      helpers.jsonrpcInvalidParams,
      'resources/read requires a non-empty string uri',
    )
  }

  const resource = internalResourcesForGraph(graphPath)
    .find((entry) => entry.uri === uri)
  if (!resource) {
    return helpers.failure(
      id,
      helpers.jsonrpcInvalidParams,
      `Unknown resource: ${uri}`,
    )
  }
  if (Buffer.byteLength(resource.text) > helpers.maxResourceBytes) {
    return helpers.failure(
      id,
      helpers.jsonrpcServerError,
      `Resource too large to read over stdio: ${resource.name}`,
    )
  }

  return helpers.ok(id, {
    contents: [
      {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: resource.text,
      },
    ],
  })
}
