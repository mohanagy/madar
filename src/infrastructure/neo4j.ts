import { resolve } from 'node:path'

import { type GraphAttributes, KnowledgeGraph } from '../domain/graph/directed-multigraph.js'
import { getEnvValue } from '../shared/env.js'
import { sanitizeLabel } from '../shared/security.js'

export interface Neo4jPushOptions {
  uri: string
  user?: string | null
  password?: string | null
  database?: string | null
  projectRoot?: string
}

export interface ResolvedNeo4jPushConfig {
  uri: string
  user: string
  password: string
  database: string
  projectRoot: string
}

export interface Neo4jPushResult {
  uri: string
  database: string
  nodes: number
  edges: number
}

interface Neo4jTransactionLike {
  run(query: string, parameters: Record<string, unknown>): Promise<unknown>
}

interface Neo4jSessionLike {
  executeWrite<T>(work: (tx: Neo4jTransactionLike) => Promise<T> | T): Promise<T>
  close(): Promise<void>
}

interface Neo4jDriverLike {
  session(options: { database: string }): Neo4jSessionLike
  close(): Promise<void>
}

export interface Neo4jDependencies {
  createDriver?(uri: string, user: string, password: string): Promise<Neo4jDriverLike> | Neo4jDriverLike
}

const DEFAULT_NEO4J_DATABASE = 'neo4j'
const ALLOWED_NEO4J_PROTOCOLS = new Set(['bolt:', 'bolt+s:', 'bolt+ssc:', 'neo4j:', 'neo4j+s:', 'neo4j+ssc:'])

function capitalize(value: string): string {
  if (value.length === 0) {
    return value
  }
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
}

function identifierSegments(value: string): string[] {
  return (
    sanitizeLabel(value)
      .trim()
      .match(/[A-Za-z0-9]+/g) ?? []
  )
}

function primitiveProperties(attributes: GraphAttributes): Record<string, string | number | boolean> {
  const properties: Record<string, string | number | boolean> = {}

  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string' || typeof value === 'boolean') {
      properties[key] = value
      continue
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      properties[key] = value
    }
  }

  return properties
}

async function defaultCreateDriver(uri: string, user: string, password: string): Promise<Neo4jDriverLike> {
  try {
    const neo4j = await import('neo4j-driver')
    return neo4j.default.driver(uri, neo4j.default.auth.basic(user, password), {
      maxConnectionPoolSize: 50,
      connectionAcquisitionTimeout: 30_000,
      connectionLivenessCheckTimeout: 30_000,
      maxTransactionRetryTime: 15_000,
    }) as Neo4jDriverLike
  } catch {
    throw new Error('neo4j-driver is not installed. Run `npm install neo4j-driver`.')
  }
}

export function sanitizeNeo4jLabel(value: string): string {
  const sanitized = identifierSegments(value)
    .filter((segment) => /^[A-Za-z]/.test(segment))
    .map(capitalize)
    .join('')

  if (sanitized.length === 0) {
    return 'Entity'
  }

  return sanitized
}

export function sanitizeNeo4jRelation(value: string): string {
  const sanitized = identifierSegments(value)
    .map((segment) => segment.toUpperCase())
    .join('_')

  return sanitized.length > 0 ? sanitized : 'RELATED_TO'
}

export function validateNeo4jUri(value: string): string {
  const uri = value.trim()
  let parsed: URL

  try {
    parsed = new URL(uri)
  } catch {
    throw new Error(`Invalid Neo4j URI: ${JSON.stringify(value)}. Use a bolt:// or neo4j:// style URI.`)
  }

  if (!ALLOWED_NEO4J_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Unsupported Neo4j URI scheme '${parsed.protocol.replace(/:$/, '')}'. Use one of bolt, bolt+s, bolt+ssc, neo4j, neo4j+s, or neo4j+ssc.`)
  }

  if (parsed.hostname.trim().length === 0) {
    throw new Error(`Invalid Neo4j URI: ${JSON.stringify(value)}. A hostname is required.`)
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error('Do not embed Neo4j credentials in the URI. Pass --neo4j-user/--neo4j-password or use NEO4J_* variables instead.')
  }

  return uri
}

export function resolveNeo4jPushConfig(options: Neo4jPushOptions, env: NodeJS.ProcessEnv = process.env): ResolvedNeo4jPushConfig {
  const projectRoot = resolve(options.projectRoot ?? '.')
  const uriValue = options.uri.trim().length > 0 ? options.uri.trim() : (getEnvValue('NEO4J_URI', projectRoot, env) ?? '')
  if (uriValue.length === 0) {
    throw new Error('Neo4j URI is required. Pass --neo4j-push URI or set NEO4J_URI.')
  }

  const uri = validateNeo4jUri(uriValue)

  const user = options.user?.trim() || getEnvValue('NEO4J_USER', projectRoot, env) || 'neo4j'
  const password = options.password?.trim() || getEnvValue('NEO4J_PASSWORD', projectRoot, env) || ''
  if (password.length === 0) {
    throw new Error('Neo4j password is required. Pass --neo4j-password, set NEO4J_PASSWORD, or add it to .env.')
  }

  const database = options.database?.trim() || getEnvValue('NEO4J_DATABASE', projectRoot, env) || DEFAULT_NEO4J_DATABASE

  return {
    uri,
    user,
    password,
    database,
    projectRoot,
  }
}

export async function pushGraphToNeo4j(graph: KnowledgeGraph, options: Neo4jPushOptions, dependencies: Neo4jDependencies = {}): Promise<Neo4jPushResult> {
  const config = resolveNeo4jPushConfig(options)
  const createDriver = dependencies.createDriver ?? defaultCreateDriver
  let driver: Neo4jDriverLike | null = null
  let session: Neo4jSessionLike | null = null

  try {
    driver = await createDriver(config.uri, config.user, config.password)
    session = driver.session({ database: config.database })

    await session.executeWrite(async (tx) => {
      for (const [nodeId, attributes] of graph.nodeEntries()) {
        const fileType = sanitizeNeo4jLabel(String(attributes.file_type ?? 'Entity'))
        const properties = {
          ...primitiveProperties(attributes),
          id: nodeId,
        }
        await tx.run(`MERGE (n:${fileType} {id: $id}) SET n += $props`, {
          id: nodeId,
          props: properties,
        })
      }

      for (const [source, target, attributes, edgeId] of graph.edgeEntries()) {
        const relation = sanitizeNeo4jRelation(String(attributes.relation ?? 'RELATED_TO'))
        await tx.run(`MATCH (a {id: $src}), (b {id: $tgt}) MERGE (a)-[r:${relation} {id: $edgeId}]->(b) SET r += $props`, {
          src: source,
          tgt: target,
          edgeId,
          props: { ...primitiveProperties(attributes), id: edgeId },
        })
      }
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Failed to push graph to Neo4j at ${config.uri} (database ${config.database}). Ensure the URI, credentials, and server availability are correct. Original error: ${detail}`,
    )
  } finally {
    if (session) {
      await session.close()
    }
    if (driver) {
      await driver.close()
    }
  }

  return {
    uri: config.uri,
    database: config.database,
    nodes: graph.numberOfNodes(),
    edges: graph.numberOfEdges(),
  }
}
