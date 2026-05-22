import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

function withTempGraph(graph: unknown, run: (graphPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sadeem-bench-stats-'))
  const graphPath = join(dir, 'graph.json')
  try {
    writeFileSync(graphPath, JSON.stringify(graph, null, 2))
    run(graphPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('benchmark graph stats helper', () => {
  it('counts edges when graph.json has an edges array', () => {
    withTempGraph({
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [{ source: 'a', target: 'b' }],
    }, (graphPath) => {
      const output = execFileSync('node', [
        'docs/benchmarks/2026-05-11-spi-vs-legacy/graph-stats.mjs',
        graphPath,
      ], { cwd: process.cwd(), encoding: 'utf8' })
      expect(JSON.parse(output)).toEqual({ node_count: 2, edge_count: 1 })
    })
  })

  it('falls back to zero edges when graph.json omits the edges array', () => {
    withTempGraph({
      nodes: [{ id: 'a' }, { id: 'b' }],
    }, (graphPath) => {
      const output = execFileSync('node', [
        'docs/benchmarks/2026-05-11-spi-vs-legacy/graph-stats.mjs',
        graphPath,
      ], { cwd: process.cwd(), encoding: 'utf8' })
      expect(JSON.parse(output)).toEqual({ node_count: 2, edge_count: 0 })
    })
  })

  it('prints a clear error when graph.json is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sadeem-bench-stats-bad-'))
    const graphPath = join(dir, 'graph.json')
    writeFileSync(graphPath, '{"nodes":[', 'utf8')
    try {
      expect(() => execFileSync('node', [
        'docs/benchmarks/2026-05-11-spi-vs-legacy/graph-stats.mjs',
        graphPath,
      ], { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' })).toThrowError(
        expect.objectContaining({
          stderr: expect.stringContaining(graphPath),
        }),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
