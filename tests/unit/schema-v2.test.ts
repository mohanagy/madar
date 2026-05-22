import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateExtraction } from '../../src/contracts/extraction.js'
import { buildFromJson } from '../../src/pipeline/build.js'
import { toJson } from '../../src/pipeline/export.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

type ExtractionFixture = {
  schema_version?: number
  nodes: Array<Record<string, unknown>>
  edges: Array<Record<string, unknown>>
  hyperedges?: Array<Record<string, unknown>>
}

function loadFixture(): ExtractionFixture {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'extraction-v2.json'), 'utf8')) as ExtractionFixture
}

describe('schema v2 extraction contracts', () => {
  it('accepts legacy v1 payloads with an implicit schema version', () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, 'extraction.json'), 'utf8')) as unknown

    expect(validateExtraction(fixture)).toEqual([])
  })

  it('accepts schema v2 payloads with layered provenance metadata', () => {
    expect(validateExtraction(loadFixture())).toEqual([])
  })

  it('rejects unsupported schema versions', () => {
    const fixture = loadFixture()
    const errors = validateExtraction({ ...fixture, schema_version: 3 })

    expect(errors.some((error) => error.includes('schema_version'))).toBe(true)
  })

  it('rejects invalid layer values across nodes, edges, and hyperedges', () => {
    const fixture = loadFixture()
    const errors = validateExtraction({
      ...fixture,
      nodes: fixture.nodes.map((node, index) => (index === 0 ? { ...node, layer: 'mystery' } : node)),
      edges: fixture.edges.map((edge, index) => (index === 0 ? { ...edge, layer: 'unknown' } : edge)),
      hyperedges: fixture.hyperedges?.map((hyperedge, index) => (index === 0 ? { ...hyperedge, layer: 'shadow' } : hyperedge)),
    })

    expect(errors.some((error) => error.includes('Node 0') && error.includes('layer'))).toBe(true)
    expect(errors.some((error) => error.includes('Edge 0') && error.includes('layer'))).toBe(true)
    expect(errors.some((error) => error.includes('Hyperedge 0') && error.includes('layer'))).toBe(true)
  })

  it('preserves layered metadata when building a graph', () => {
    const graph = buildFromJson(loadFixture())
    const hyperedges = Array.isArray(graph.graph.hyperedges) ? graph.graph.hyperedges : []

    expect(graph.nodeAttributes('n_auth_client').layer).toBe('base')
    expect(graph.edgeAttributes('n_auth_client', 'n_oauth_concept').layer).toBe('semantic')
    expect(hyperedges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'h_auth_bundle',
          layer: 'semantic',
        }),
      ]),
    )
  })

  it('preserves layered metadata in exported json', () => {
    const graph = buildFromJson(loadFixture())
    const tempDir = mkdtempSync(join(tmpdir(), 'madar-schema-v2-'))

    try {
      const outputPath = join(tempDir, 'graph.json')
      toJson(graph, { 0: ['n_auth_client', 'n_oauth_concept'] }, outputPath)
      const data = JSON.parse(readFileSync(outputPath, 'utf8')) as {
        schema_version?: number
        nodes: Array<Record<string, unknown>>
        links: Array<Record<string, unknown>>
        hyperedges: Array<Record<string, unknown>>
      }

      expect(data.schema_version).toBe(2)
      expect(data.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'n_oauth_concept', layer: 'semantic' })]))
      expect(data.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'n_auth_client',
            target: 'n_oauth_concept',
            layer: 'semantic',
          }),
        ]),
      )
      expect(data.hyperedges).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'h_auth_bundle', layer: 'semantic' })]))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
