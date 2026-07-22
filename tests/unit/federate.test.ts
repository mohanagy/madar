import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { federate } from '../../src/pipeline/federate.js'
import { readMatchingReport } from '../../src/adapters/filesystem/index-store.js'
import { resourcesForGraph } from '../../src/runtime/stdio/resources.js'
import { readCanonicalGraphFixture, writeCanonicalGraphFixture } from '../helpers/graph-artifact.js'

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
    nodes: nodes.map((n) => ({ id: n.id, label: n.label, file_type: 'code', source_file: `${repoName}/src/${n.id}.ts` })),
    edges: edges.map(([source, target]) => ({ source, target, relation: 'calls', confidence: 'EXTRACTED', source_file: `${repoName}/src/${source}.ts` })),
  }

  const graphPath = join(repoDir, 'graph.json')
  writeCanonicalGraphFixture(graphPath, graphData)
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

      const outputDir = join(dir, 'out', 'federated')
      const result = federate([graph1, graph2], { outputDir })

      expect(result.repos).toEqual(['frontend', 'backend'])
      expect(result.totalNodes).toBe(4)
      expect(result.totalEdges).toBeGreaterThanOrEqual(2)
      expect(existsSync(result.graphPath)).toBe(true)
      expect(existsSync(result.reportPath)).toBe(true)
      expect(readMatchingReport(result.graphPath)).toContain('madar-graph-sha256')
      expect(resourcesForGraph(result.graphPath).map((resource) => resource.name)).toContain('GRAPH_REPORT.md')
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

  it('orients shared-label facts canonically regardless of input order', () => {
    withTempDir((dir) => {
      const frontend = createMiniGraph(dir, 'frontend', [{ id: 'user', label: 'UserModel' }], [])
      const backend = createMiniGraph(dir, 'backend', [{ id: 'user', label: 'UserModel' }], [])
      const forward = federate([frontend, backend], { outputDir: join(dir, 'forward') })
      const reverse = federate([backend, frontend], { outputDir: join(dir, 'reverse') })
      const sharedEdges = (path: string) => readCanonicalGraphFixture(path).edges
        .filter((edge) => edge.relation === 'shared_across_repos')
        .map(({ id, source, target }) => ({ id, source, target }))

      expect(readFileSync(forward.graphPath, 'utf8')).toBe(readFileSync(reverse.graphPath, 'utf8'))
      expect(sharedEdges(forward.graphPath)).toEqual(sharedEdges(reverse.graphPath))
      expect(sharedEdges(forward.graphPath)).toEqual([
        expect.objectContaining({ source: 'backend::user', target: 'frontend::user' }),
      ])
    })
  })

  it('throws on empty input', () => {
    expect(() => federate([])).toThrow('At least one graph path is required')
  })

  it('reproduces the checked-in three-repo federation receipt', () => {
    withTempDir((dir) => {
      const fixtureRoot = mkdtempSync(join(process.cwd(), 'out', 'federation-fixture-'))
      const frontendGraph = join(fixtureRoot, 'frontend', 'out', 'graph.json')
      const backendGraph = join(fixtureRoot, 'backend', 'out', 'graph.json')
      const sharedGraph = join(fixtureRoot, 'shared', 'out', 'graph.json')
      const receipt = JSON.parse(
        readFileSync(resolve('docs/benchmarks/2026-06-01-federation-flagship/federation-receipt.json'), 'utf8'),
      ) as {
        repos: string[]
        totalNodes: number
        totalEdges: number
        crossRepoEdges: number
        communityCount: number
      }

      try {
        mkdirSync(join(fixtureRoot, 'frontend', 'out'), { recursive: true })
        mkdirSync(join(fixtureRoot, 'backend', 'out'), { recursive: true })
        mkdirSync(join(fixtureRoot, 'shared', 'out'), { recursive: true })
        writeFileSync(frontendGraph, readFileSync(resolve('tests/fixtures/federation-flagship/frontend/graph.json')))
        writeFileSync(backendGraph, readFileSync(resolve('tests/fixtures/federation-flagship/backend/graph.json')))
        writeFileSync(sharedGraph, readFileSync(resolve('tests/fixtures/federation-flagship/shared/graph.json')))

        const outputDir = join(dir, 'federated')
        const result = federate([frontendGraph, backendGraph, sharedGraph], { outputDir })

        expect(result.repos).toEqual(receipt.repos)
        expect(result.totalNodes).toBe(receipt.totalNodes)
        expect(result.totalEdges).toBe(receipt.totalEdges)
        expect(result.crossRepoEdges).toBe(receipt.crossRepoEdges)
        expect(result.communityCount).toBe(receipt.communityCount)
        expect(existsSync(result.graphPath)).toBe(true)
        expect(existsSync(result.reportPath)).toBe(true)
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true })
      }
    })
  })
})
