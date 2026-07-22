import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { GRAPH_ARTIFACT_VERSION } from '../../src/domain/graph/artifact.js'
import { startGraphServer } from '../../src/runtime/http-server.js'
import { writeCanonicalGraphFixture } from '../helpers/graph-artifact.js'

const GRAPH_REGENERATION_INSTRUCTION = 'Run `madar generate . --update` to regenerate it.'

function withTempDir<T>(callback: (tempDir: string) => Promise<T> | T): Promise<T> | T {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-http-'))
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
      writeCanonicalGraphFixture(
        graphPath,
        {
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
          edges: [{ source: 'n1', target: 'n2', relation: 'calls', confidence: 'EXTRACTED', source_file: 'client.ts' }],
        },
      )
      writeFileSync(join(outputDir, 'GRAPH_REPORT.md'), '# report\n', 'utf8')

      const handle = await startGraphServer({ graphPath, port: 0 })

      try {
        const health = await fetch(`${handle.url}health`)
        expect(health.status).toBe(200)
        expect(await health.json()).toEqual({ ok: true })
        const healthVersion = health.headers.get('x-madar-graph-version')
        expect(healthVersion).toMatch(/^[a-f0-9]{12}$/)
        expect(health.headers.get('x-madar-graph-modified-ms')).toMatch(/^\d+$/)

        const stats = await fetch(`${handle.url}stats`)
        expect(stats.status).toBe(200)
        expect(await stats.text()).toContain('Nodes: 3')
        expect(stats.headers.get('x-madar-graph-version')).toBe(healthVersion)

        const query = await fetch(`${handle.url}query?q=httpclient`)
        expect(query.status).toBe(200)
        expect(await query.text()).toContain('Traversal: BFS')
        expect(query.headers.get('x-madar-graph-version')).toBe(healthVersion)

        const filteredQuery = await fetch(`${handle.url}query?q=httpclient&rank=degree&community=0&file_type=code`)
        expect(filteredQuery.status).toBe(200)
        const filteredText = await filteredQuery.text()
        expect(filteredText).toContain('Rank: DEGREE')
        expect(filteredText).toContain('HttpClient')
        expect(filteredText).not.toContain('HttpClientGuide')
        expect(filteredQuery.headers.get('x-madar-graph-version')).toBe(healthVersion)

        const anomalies = await fetch(`${handle.url}anomalies?limit=1`)
        expect(anomalies.status).toBe(200)
        const anomalyText = await anomalies.text()
        expect(anomalyText).toContain('Semantic anomalies (1 shown)')
        expect(anomalyText).toContain('HttpClient bridges the code graph and document graph.')
        expect(anomalies.headers.get('x-madar-graph-version')).toBe(healthVersion)

        const expectedGraphJson = readFileSync(graphPath, 'utf8')
        const expectedGraphVersion = createHash('sha256').update(expectedGraphJson).digest('hex').slice(0, 12)
        const graphResponse = await fetch(`${handle.url}graph.json`)
        expect(graphResponse.status).toBe(200)
        expect(graphResponse.headers.get('x-madar-graph-version')).toBe(expectedGraphVersion)
        expect(graphResponse.headers.get('last-modified')).toBeTruthy()
        expect(graphResponse.headers.get('etag')).toContain(expectedGraphVersion)
        expect(graphResponse.headers.get('x-madar-resource-bytes')).toBe(String(Buffer.byteLength(expectedGraphJson)))
        const graphJson = await graphResponse.text()
        expect(graphJson).toBe(expectedGraphJson)
        expect(JSON.parse(graphJson)).toMatchObject({
          schema: 'madar.graph',
          version: GRAPH_ARTIFACT_VERSION,
          directed: true,
          nodes: expect.arrayContaining([
            expect.objectContaining({ id: 'n1', attributes: expect.objectContaining({ label: 'HttpClient' }) }),
          ]),
        })

        writeCanonicalGraphFixture(
          graphPath,
          {
            nodes: [{ id: 'updated', label: 'UpdatedNode', source_file: 'updated.ts', file_type: 'code', community: 0 }],
            edges: [],
          },
        )

        const updatedStats = await fetch(`${handle.url}stats`)
        expect(updatedStats.status).toBe(200)
        expect(await updatedStats.text()).toContain('Nodes: 1')
        expect(updatedStats.headers.get('x-madar-graph-version')).not.toBe(healthVersion)

        const index = await fetch(handle.url)
        expect(index.status).toBe(200)
        const indexText = await index.text()
        expect(indexText).toContain('graph.json')
        expect(indexText).not.toContain('graph.html')
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
      writeCanonicalGraphFixture(
        graphPath,
        {
          nodes: [{ id: 'n1', label: 'HttpClient', source_file: 'client.ts', file_type: 'code', community: 0 }],
          edges: [],
        },
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

  test('returns the graph regeneration instruction for legacy artifacts', async () => {
    await withTempDir(async (tempDir) => {
      const graphPath = join(tempDir, 'out', 'graph.json')
      mkdirSync(join(tempDir, 'out'), { recursive: true })
      writeFileSync(graphPath, JSON.stringify({ nodes: [], links: [] }), 'utf8')
      const handle = await startGraphServer({ graphPath, port: 0, logger: { log() {}, error() {} } })

      try {
        for (const endpoint of ['stats', 'query?q=auth', 'graph.json']) {
          const response = await fetch(`${handle.url}${endpoint}`)
          expect(response.status).toBe(500)
          expect(await response.text()).toContain(GRAPH_REGENERATION_INSTRUCTION)
        }
      } finally {
        await handle.close()
      }
    })
  })

  test('validates the exact graph bytes when size and mtime match a prior response', async () => {
    await withTempDir(async (tempDir) => {
      const graphPath = join(tempDir, 'out', 'graph.json')
      mkdirSync(join(tempDir, 'out'), { recursive: true })
      writeCanonicalGraphFixture(graphPath, {
        nodes: [{ id: 'n1', label: 'Node', source_file: 'node.ts', file_type: 'code' }],
        edges: [],
      })
      const validArtifact = readFileSync(graphPath, 'utf8')
      const originalTimes = statSync(graphPath)
      const handle = await startGraphServer({ graphPath, port: 0, logger: { log() {}, error() {} } })

      try {
        const initialResponse = await fetch(`${handle.url}graph.json`)
        expect(initialResponse.status).toBe(200)

        const rewrittenArtifact = validArtifact.replace('"Node"', '"Mode"')
        expect(rewrittenArtifact).toHaveLength(validArtifact.length)
        writeFileSync(graphPath, rewrittenArtifact, 'utf8')
        utimesSync(graphPath, originalTimes.atime, originalTimes.mtime)
        const rewrittenResponse = await fetch(`${handle.url}graph.json`)
        const rewrittenVersion = createHash('sha256').update(rewrittenArtifact).digest('hex').slice(0, 12)
        expect(rewrittenResponse.status).toBe(200)
        expect(rewrittenResponse.headers.get('x-madar-graph-version')).toBe(rewrittenVersion)
        expect(await rewrittenResponse.text()).toBe(rewrittenArtifact)

        const unsupportedArtifact = rewrittenArtifact.replace(`"version": ${GRAPH_ARTIFACT_VERSION}`, '"version": 0')
        writeFileSync(graphPath, unsupportedArtifact, 'utf8')
        utimesSync(graphPath, originalTimes.atime, originalTimes.mtime)

        const response = await fetch(`${handle.url}graph.json`)
        expect(response.status).toBe(500)
        expect(await response.text()).toContain(GRAPH_REGENERATION_INSTRUCTION)
      } finally {
        await handle.close()
      }
    })
  })

  test('rejects oversized graph artifacts before reading them', async () => {
    await withTempDir(async (tempDir) => {
      const graphPath = join(tempDir, 'out', 'graph.json')
      mkdirSync(join(tempDir, 'out'), { recursive: true })
      writeFileSync(graphPath, '', 'utf8')
      truncateSync(graphPath, 100 * 1024 * 1024 + 1)
      const handle = await startGraphServer({ graphPath, port: 0, logger: { log() {}, error() {} } })

      try {
        const response = await fetch(`${handle.url}graph.json`)
        expect(response.status).toBe(500)
        expect(await response.text()).toBe('Internal server error')
      } finally {
        await handle.close()
      }
    })
  })
})
