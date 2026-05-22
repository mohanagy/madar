import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { startGraphServer } from '../../src/runtime/http-server.js'

function withTempDir<T>(callback: (tempDir: string) => Promise<T> | T): Promise<T> | T {
  const tempDir = mkdtempSync(join(tmpdir(), 'sadeem-http-'))
  const finalize = (): void => {
    rmSync(tempDir, { recursive: true, force: true })
  }

  try {
    const result = callback(tempDir)
    if (result instanceof Promise) {
      return result.finally(finalize)
    }
    finalize()
    return result
  } catch (error) {
    finalize()
    throw error
  }
}

describe('startGraphServer', () => {
  test('serves graph artifacts and runtime query endpoints', async () => {
    await withTempDir(async (tempDir) => {
      const outputDir = join(tempDir, 'out')
      const graphPath = join(outputDir, 'graph.json')
      mkdirSync(outputDir, { recursive: true })
      writeFileSync(
        graphPath,
        `${JSON.stringify({
          semantic_anomalies: [
            {
              id: 'bridge-httpclient',
              kind: 'bridge_node',
              severity: 'HIGH',
              score: 8.4,
              summary: 'HttpClient bridges the code graph and document graph.',
              why: 'It links code and document communities through direct references.',
            },
          ],
          nodes: [
            { id: 'n1', label: 'HttpClient', source_file: 'client.ts', file_type: 'code', community: 0 },
            { id: 'n2', label: 'buildHeaders', source_file: 'client.ts', file_type: 'code', community: 0 },
            { id: 'n3', label: 'HttpClientGuide', source_file: 'guide.md', file_type: 'document', community: 1 },
          ],
          links: [{ source: 'n1', target: 'n2', relation: 'calls', confidence: 'EXTRACTED', source_file: 'client.ts' }],
          hyperedges: [],
        })}\n`,
        'utf8',
      )
      writeFileSync(join(outputDir, 'GRAPH_REPORT.md'), '# report\n', 'utf8')
      writeFileSync(join(outputDir, 'graph.html'), '<html><body>graph</body></html>\n', 'utf8')

      const handle = await startGraphServer({ graphPath, port: 0 })

      try {
        const health = await fetch(`${handle.url}health`)
        expect(health.status).toBe(200)
        expect(await health.json()).toEqual({ ok: true })
        const healthVersion = health.headers.get('x-sadeem-graph-version')
        expect(healthVersion).toMatch(/^[a-f0-9]{12}$/)
        expect(health.headers.get('x-sadeem-graph-modified-ms')).toMatch(/^\d+$/)

        const stats = await fetch(`${handle.url}stats`)
        expect(stats.status).toBe(200)
        expect(await stats.text()).toContain('Nodes: 3')
        expect(stats.headers.get('x-sadeem-graph-version')).toBe(healthVersion)

        const query = await fetch(`${handle.url}query?q=httpclient`)
        expect(query.status).toBe(200)
        expect(await query.text()).toContain('Traversal: BFS')
        expect(query.headers.get('x-sadeem-graph-version')).toBe(healthVersion)

        const filteredQuery = await fetch(`${handle.url}query?q=httpclient&rank=degree&community=0&file_type=code`)
        expect(filteredQuery.status).toBe(200)
        const filteredText = await filteredQuery.text()
        expect(filteredText).toContain('Rank: DEGREE')
        expect(filteredText).toContain('HttpClient')
        expect(filteredText).not.toContain('HttpClientGuide')
        expect(filteredQuery.headers.get('x-sadeem-graph-version')).toBe(healthVersion)

        const anomalies = await fetch(`${handle.url}anomalies?limit=1`)
        expect(anomalies.status).toBe(200)
        const anomalyText = await anomalies.text()
        expect(anomalyText).toContain('Semantic anomalies (1 shown)')
        expect(anomalyText).toContain('HttpClient bridges the code graph and document graph.')
        expect(anomalies.headers.get('x-sadeem-graph-version')).toBe(healthVersion)

        const graphResponse = await fetch(`${handle.url}graph.json`)
        expect(graphResponse.status).toBe(200)
        expect(graphResponse.headers.get('x-sadeem-graph-version')).toBe(healthVersion)
        expect(graphResponse.headers.get('last-modified')).toBeTruthy()
        expect(graphResponse.headers.get('etag')).toBeTruthy()

        writeFileSync(
          graphPath,
          `${JSON.stringify({
            nodes: [{ id: 'updated', label: 'UpdatedNode', source_file: 'updated.ts', file_type: 'code', community: 0 }],
            links: [],
            hyperedges: [],
          })}\n`,
          'utf8',
        )

        const updatedStats = await fetch(`${handle.url}stats`)
        expect(updatedStats.status).toBe(200)
        expect(await updatedStats.text()).toContain('Nodes: 1')
        expect(updatedStats.headers.get('x-sadeem-graph-version')).not.toBe(healthVersion)

        const index = await fetch(handle.url)
        expect(index.status).toBe(200)
        expect(await index.text()).toContain('graph')
      } finally {
        await handle.close()
      }
    })
  })

  test('rejects oversized query parameters with a 400 response', async () => {
    await withTempDir(async (tempDir) => {
      const outputDir = join(tempDir, 'out')
      const graphPath = join(outputDir, 'graph.json')
      mkdirSync(outputDir, { recursive: true })
      writeFileSync(
        graphPath,
        `${JSON.stringify({
          nodes: [{ id: 'n1', label: 'HttpClient', source_file: 'client.ts', file_type: 'code', community: 0 }],
          links: [],
          hyperedges: [],
        })}\n`,
        'utf8',
      )

      const handle = await startGraphServer({ graphPath, port: 0 })

      try {
        const response = await fetch(`${handle.url}query?q=${'x'.repeat(2501)}`)
        expect(response.status).toBe(400)
        expect(await response.text()).toContain('exceeds maximum length')
      } finally {
        await handle.close()
      }
    })
  })
})
