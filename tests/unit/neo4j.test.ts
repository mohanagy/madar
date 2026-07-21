import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import { type Neo4jDependencies, pushGraphToNeo4j, resolveNeo4jPushConfig, sanitizeNeo4jLabel, sanitizeNeo4jRelation } from '../../src/infrastructure/neo4j.js'

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
  graph.addEdge('auth', 'client', { relation: 'depends on', confidence: 'EXTRACTED', source_location: 'L1' })
  graph.addEdge('auth', 'client', { relation: 'depends on', confidence: 'EXTRACTED', source_location: 'L2' })
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
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining('MERGE (a)-[r:DEPENDS_ON {id: $edgeId}]->(b)'),
      expect.objectContaining({ src: 'auth', tgt: 'client', edgeId: expect.stringMatching(/^edge_[a-f0-9]{32}$/) }),
    )
    expect(run.mock.calls.filter(([query]) => String(query).includes('MERGE (a)-[r:DEPENDS_ON')).map(([, params]) => params.edgeId)).toHaveLength(2)
    expect(new Set(run.mock.calls.filter(([query]) => String(query).includes('MERGE (a)-[r:DEPENDS_ON')).map(([, params]) => params.edgeId)).size).toBe(2)
    expect(result).toEqual({
      uri: 'bolt://localhost:7687',
      database: 'madar',
      nodes: 2,
      edges: 2,
    })
    expect(sessionClose).toHaveBeenCalledTimes(1)
    expect(driverClose).toHaveBeenCalledTimes(1)
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
