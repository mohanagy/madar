import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { federate } from '../../src/pipeline/federate.js'

function withTempDir(fn: (dir: string) => void): void {
  const dir = join(tmpdir(), `madar-federate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function createMiniGraph(dir: string, repoName: string, nodes: Array<{ id: string; label: string }>, edges: Array<[string, string]>): string {
  const repoDir = join(dir, repoName, 'out')
  mkdirSync(repoDir, { recursive: true })

  const graphData = {
    schema_version: 1,
    directed: false,
    nodes: nodes.map((n) => ({ id: n.id, label: n.label, file_type: 'code', source_file: `${repoName}/src/${n.id}.ts` })),
    edges: edges.map(([source, target]) => ({ source, target, relation: 'calls', confidence: 'EXTRACTED', source_file: `${repoName}/src/${source}.ts` })),
  }

  const graphPath = join(repoDir, 'graph.json')
  writeFileSync(graphPath, JSON.stringify(graphData), 'utf8')
  return graphPath
}

describe('federate', () => {
  it('merges two graphs into a federated graph', () => {
    withTempDir((dir) => {
      const graph1 = createMiniGraph(dir, 'frontend', [
        { id: 'auth', label: 'AuthComponent' },
        { id: 'api', label: 'ApiClient' },
      ], [['auth', 'api']])

      const graph2 = createMiniGraph(dir, 'backend', [
        { id: 'handler', label: 'AuthHandler' },
        { id: 'db', label: 'Database' },
      ], [['handler', 'db']])

      const outputDir = join(dir, 'federated')
      const result = federate([graph1, graph2], { outputDir })

      expect(result.repos).toEqual(['frontend', 'backend'])
      expect(result.totalNodes).toBe(4)
      expect(result.totalEdges).toBeGreaterThanOrEqual(2)
      expect(existsSync(result.graphPath)).toBe(true)
      expect(existsSync(result.reportPath)).toBe(true)
    })
  })

  it('finds cross-repo edges for shared labels', () => {
    withTempDir((dir) => {
      const graph1 = createMiniGraph(dir, 'frontend', [
        { id: 'user', label: 'UserModel' },
      ], [])

      const graph2 = createMiniGraph(dir, 'backend', [
        { id: 'user', label: 'UserModel' },
      ], [])

      const outputDir = join(dir, 'federated')
      const result = federate([graph1, graph2], { outputDir })

      expect(result.crossRepoEdges).toBeGreaterThan(0)
    })
  })

  it('throws on empty input', () => {
    expect(() => federate([])).toThrow('At least one graph path is required')
  })
})
