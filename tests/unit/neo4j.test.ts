import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { resolveRelationDiscriminator } from '../../src/contracts/relation-discriminator.js'
import {
  assertNeo4jExportableFacts,
  type Neo4jDependencies,
  Neo4jUnsupportedFactMultiplicityError,
  pushGraphToNeo4j,
  resolveNeo4jPushConfig,
  sanitizeNeo4jLabel,
  sanitizeNeo4jRelation,
} from '../../src/infrastructure/neo4j.js'

function withTempDir<T>(callback: (tempDir: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-neo4j-'))
  try {
    return callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function makeGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.addNode('auth', { label: 'AuthService', file_type: 'code', source_file: 'main.py', community: 1 })
  graph.addNode('client', { label: 'HttpClient', file_type: 'code', source_file: 'client.py', community: 1 })
  graph.addEdge('auth', 'client', { relation: 'depends_on', confidence: 'EXTRACTED' })
  return graph
}

describe('neo4j integration helpers', () => {
  test('sanitizes neo4j labels and relationships for safe query interpolation', () => {
    expect(sanitizeNeo4jLabel('code')).toBe('Code')
    expect(sanitizeNeo4jLabel('123bad')).toBe('Entity')
    expect(sanitizeNeo4jLabel('code); MATCH (n) DETACH DELETE n //')).toBe('CodeMatchNDetachDeleteN')
    expect(sanitizeNeo4jRelation('depends on')).toBe('DEPENDS_ON')
    expect(sanitizeNeo4jRelation('depends on); DELETE n //')).toBe('DEPENDS_ON_DELETE_N')
    expect(sanitizeNeo4jRelation('')).toBe('RELATED_TO')
  })

  test('resolves neo4j connection settings from .env with defaults', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, '.env'), 'NEO4J_URI=neo4j://localhost:7687\nNEO4J_USER=madar\nNEO4J_PASSWORD=super-secret\n', 'utf8')

      expect(
        resolveNeo4jPushConfig(
          {
            uri: '',
            projectRoot: tempDir,
          },
          {},
        ),
      ).toEqual({
        uri: 'neo4j://localhost:7687',
        user: 'madar',
        password: 'super-secret',
        database: 'neo4j',
        projectRoot: tempDir,
      })
    })
  })

  test('rejects neo4j pushes without a password from flags, env, or .env', () => {
    withTempDir((tempDir) => {
      expect(() =>
        resolveNeo4jPushConfig(
          {
            uri: 'bolt://localhost:7687',
            projectRoot: tempDir,
          },
          {},
        ),
      ).toThrow('Neo4j password is required. Pass --neo4j-password, set NEO4J_PASSWORD, or add it to .env.')
    })
  })

  test('rejects unsupported neo4j uri schemes and embedded credentials', () => {
    expect(() =>
      resolveNeo4jPushConfig(
        {
          uri: 'http://localhost:7474',
          password: 'super-secret',
        },
        {},
      ),
    ).toThrow("Unsupported Neo4j URI scheme 'http'")

    expect(() =>
      resolveNeo4jPushConfig(
        {
          uri: 'bolt://neo4j:super-secret@localhost:7687',
          user: 'neo4j',
          password: 'super-secret',
        },
        {},
      ),
    ).toThrow('Do not embed Neo4j credentials in the URI.')
  })

  test('pushes nodes and edges using MERGE statements', async () => {
    const run = vi.fn().mockResolvedValue({})
    const sessionClose = vi.fn().mockResolvedValue(undefined)
    const driverClose = vi.fn().mockResolvedValue(undefined)
    const executeWriteSpy = vi.fn()
    const executeWrite = async <T>(work: (tx: { run: (query: string, parameters: Record<string, unknown>) => Promise<unknown> }) => Promise<T> | T): Promise<T> => {
      executeWriteSpy()
      return work({
        run: (query: string, parameters: Record<string, unknown>) => run(query, parameters),
      })
    }
    const session = {
      executeWrite,
      close: sessionClose,
    }
    const sessionFactory = vi.fn(() => session)
    const createDriver: NonNullable<Neo4jDependencies['createDriver']> = async () => ({
      session: sessionFactory,
      close: driverClose,
    })

    const result = await pushGraphToNeo4j(
      makeGraph(),
      {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'super-secret',
        database: 'madar',
      },
      { createDriver },
    )

    expect(sessionFactory).toHaveBeenCalledWith({ database: 'madar' })
    expect(executeWriteSpy).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(expect.stringContaining('MERGE (n:Code {id: $id})'), expect.objectContaining({ id: 'auth' }))
    expect(run).toHaveBeenCalledWith(expect.stringContaining('MERGE (a)-[r:DEPENDS_ON]->(b)'), expect.objectContaining({ src: 'auth', tgt: 'client' }))
    expect(result).toEqual({
      uri: 'bolt://localhost:7687',
      database: 'madar',
      nodes: 2,
      edges: 1,
    })
    expect(sessionClose).toHaveBeenCalledTimes(1)
    expect(driverClose).toHaveBeenCalledTimes(1)
  })

  test('assertNeo4jExportableFacts accepts current one-fact-per-pair entries unchanged', () => {
    expect(() =>
      assertNeo4jExportableFacts([
        ['auth', 'client', { relation: 'depends on' }],
        ['auth', 'db', { relation: 'depends on' }],
        // Same endpoints, different relation type: two distinct Neo4j relationship
        // types, not a collision on the (endpoints, relation) MERGE key.
        ['auth', 'client', { relation: 'calls' }],
      ]),
    ).not.toThrow()
  })

  test('assertNeo4jExportableFacts rejects multiple facts sharing endpoints and relation type', () => {
    expect(() =>
      assertNeo4jExportableFacts([
        ['auth', 'client', { relation: 'depends on', confidence: 'EXTRACTED' }],
        ['auth', 'client', { relation: 'depends on', confidence: 'INFERRED' }],
      ]),
    ).toThrow(Neo4jUnsupportedFactMultiplicityError)
    expect(() =>
      assertNeo4jExportableFacts([
        ['auth', 'client', { relation: 'depends on' }],
        ['auth', 'client', { relation: 'depends on' }],
      ]),
    ).toThrow('found 2 facts for auth -[DEPENDS_ON]-> client')
  })

  test('assertNeo4jExportableFacts rejects distinct raw relations that collide after normalization', () => {
    expect(() =>
      assertNeo4jExportableFacts([
        ['auth', 'client', { relation: 'depends on' }],
        ['auth', 'client', { relation: 'DEPENDS_ON' }],
      ]),
    ).toThrow('found 2 facts for auth -[DEPENDS_ON]-> client')
  })

  test('exports endpoint pairs that only collide under a space-joined multiplicity key', async () => {
    const graph = new KnowledgeGraph({ directed: true })
    for (const nodeId of ['a', 'b c', 'a b', 'c']) graph.addNode(nodeId, {})
    graph.addEdge('a', 'b c', { relation: 'calls' })
    graph.addEdge('a b', 'c', { relation: 'calls' })

    const run = vi.fn().mockResolvedValue({})
    const createDriver: NonNullable<Neo4jDependencies['createDriver']> = async () => ({
      session: () => ({
        executeWrite: async (work) => work({ run }),
        close: async () => undefined,
      }),
      close: async () => undefined,
    })

    await expect(
      pushGraphToNeo4j(
        graph,
        { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'super-secret' },
        { createDriver },
      ),
    ).resolves.toMatchObject({ nodes: 4, edges: 2 })
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining('MERGE (a)-[r:CALLS]->(b)'),
      expect.objectContaining({ src: 'a', tgt: 'b c' }),
    )
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining('MERGE (a)-[r:CALLS]->(b)'),
      expect.objectContaining({ src: 'a b', tgt: 'c' }),
    )
  })

  test('pushes every fact when one endpoint pair has different relation identities', async () => {
    const graph = new KnowledgeGraph({ directed: true })
    graph.addNode('source', {})
    graph.addNode('target', {})
    graph.addEdge('source', 'target', { relation: 'injects' })
    graph.addEdge('source', 'target', { relation: 'calls' })

    const run = vi.fn().mockResolvedValue({})
    const createDriver: NonNullable<Neo4jDependencies['createDriver']> = async () => ({
      session: () => ({
        executeWrite: async (work) => work({ run }),
        close: async () => undefined,
      }),
      close: async () => undefined,
    })

    await expect(pushGraphToNeo4j(
      graph,
      { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'super-secret' },
      { createDriver },
    )).resolves.toMatchObject({ edges: 2 })
    const relationshipQueries = run.mock.calls
      .map(([query]) => String(query))
      .filter((query) => query.includes('MERGE (a)-[r:'))
    expect(relationshipQueries).toHaveLength(2)
    expect(relationshipQueries).toEqual(expect.arrayContaining([
      expect.stringContaining('[r:CALLS]'),
      expect.stringContaining('[r:INJECTS]'),
    ]))
  })

  test('pushGraphToNeo4j refuses to write a graph it cannot export without collapsing facts, before touching the driver', async () => {
    const unsupportedGraph = new KnowledgeGraph({ directed: true })
    unsupportedGraph.addNode('auth', { label: 'AuthService', file_type: 'code' })
    unsupportedGraph.addNode('client', { label: 'HttpClient', file_type: 'code' })
    const call = resolveRelationDiscriminator('calls', { invocation_kind: 'call' })
    const construct = resolveRelationDiscriminator('calls', { invocation_kind: 'construct' })
    if (call.status !== 'registered' || construct.status !== 'registered') {
      throw new Error('calls must be registered')
    }
    unsupportedGraph.addEdge('auth', 'client', { relation: 'calls', confidence: 'EXTRACTED' }, {
      discriminator: call.discriminator,
    })
    unsupportedGraph.addEdge('auth', 'client', { relation: 'calls', confidence: 'INFERRED' }, {
      discriminator: construct.discriminator,
    })

    const createDriver = vi.fn()

    await expect(
      pushGraphToNeo4j(
        unsupportedGraph,
        { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'super-secret', database: 'madar' },
        { createDriver },
      ),
    ).rejects.toThrow(Neo4jUnsupportedFactMultiplicityError)
    expect(createDriver).not.toHaveBeenCalled()
  })

  test('wraps connection failures with actionable neo4j context', async () => {
    const createDriver: NonNullable<Neo4jDependencies['createDriver']> = async () => {
      throw new Error('ECONNREFUSED')
    }

    await expect(
      pushGraphToNeo4j(
        makeGraph(),
        {
          uri: 'bolt://localhost:7687',
          user: 'neo4j',
          password: 'super-secret',
          database: 'madar',
        },
        { createDriver },
      ),
    ).rejects.toThrow('Failed to push graph to Neo4j at bolt://localhost:7687 (database madar)')
  })
})
