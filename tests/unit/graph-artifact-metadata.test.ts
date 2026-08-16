import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  GRAPH_ARTIFACT_V2_TOMBSTONE,
  readGraphArtifactMetadata,
  serializeGraphArtifactV2,
} from '../../src/contracts/graph-artifact.js'
import { KnowledgeGraph } from '../../src/contracts/graph.js'

const PROVENANCE = Object.freeze({
  schema_version: 2,
  extractor_version: 41,
  spi_mode: true,
  generation_policy: Object.freeze({ mode: 'auto' }),
})

function v2Bytes(): Buffer {
  const graph = new KnowledgeGraph()
  graph.addNode('a', {})
  graph.addNode('b', {})
  graph.addEdge('a', 'b', { relation: 'calls' })
  return serializeGraphArtifactV2({
    graph,
    repositoryRevision: 'rev',
    generationMode: 'auto',
    generatedAt: '2026-01-01T00:00:00.000Z',
    provenance: PROVENANCE,
  })
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'madar-artifact-metadata-'))
}

describe('graph artifact metadata accessor', () => {
  it('reads portable provenance from a v2 artifact without building a graph', () => {
    const dir = workspace()
    writeFileSync(join(dir, 'graph.madar'), v2Bytes())

    const metadata = readGraphArtifactMetadata(join(dir, 'graph.madar'))

    expect(metadata.format).toBe('v2')
    expect(metadata.schemaVersion).toBe(2)
    expect(metadata.extractorVersion).toBe(41)
    expect(metadata.spiMode).toBe(true)
    expect(metadata.generationPolicy).toEqual({ mode: 'auto' })
    expect(metadata.communityLabels).toEqual({})
  })

  it('resolves the sibling v2 artifact when graph.json holds the tombstone', () => {
    const dir = workspace()
    writeFileSync(join(dir, 'graph.madar'), v2Bytes())
    writeFileSync(join(dir, 'graph.json'), GRAPH_ARTIFACT_V2_TOMBSTONE)

    const metadata = readGraphArtifactMetadata(join(dir, 'graph.json'))

    expect(metadata.format).toBe('v2')
    expect(metadata.extractorVersion).toBe(41)
  })

  it('still reads a pure v1 graph.json', () => {
    const dir = workspace()
    writeFileSync(
      join(dir, 'graph.json'),
      JSON.stringify({ schema_version: 1, extractor_version: 7, root_path: '/tmp/x', nodes: [], links: [] }),
    )

    const metadata = readGraphArtifactMetadata(join(dir, 'graph.json'))

    expect(metadata.format).toBe('v1')
    expect(metadata.schemaVersion).toBe(1)
    expect(metadata.extractorVersion).toBe(7)
    expect(metadata.rootPath).toBe('/tmp/x')
  })

  it('reports absent rather than throwing when the file does not exist', () => {
    const metadata = readGraphArtifactMetadata(join(workspace(), 'graph.json'))

    expect(metadata.format).toBe('absent')
    expect(metadata.schemaVersion).toBeNull()
    expect(metadata.extractorVersion).toBeNull()
  })

  it('reports unreadable rather than silently degrading on a corrupt file', () => {
    const dir = workspace()
    writeFileSync(join(dir, 'graph.json'), '{ this is not json')

    const metadata = readGraphArtifactMetadata(join(dir, 'graph.json'))

    expect(metadata.format).toBe('unreadable')
  })

  it('distinguishes a missing artifact from an unreadable one', () => {
    const dir = workspace()
    writeFileSync(join(dir, 'graph.json'), 'garbage')

    expect(readGraphArtifactMetadata(join(dir, 'graph.json')).format).toBe('unreadable')
    expect(readGraphArtifactMetadata(join(dir, 'absent.json')).format).toBe('absent')
  })

  it('keeps the machine-local root path out of the portable artifact', () => {
    const text = v2Bytes().toString('utf8')

    expect(text).not.toContain('root_path')
  })

  it('reads the machine-local root path from the local sidecar', () => {
    const dir = workspace()
    writeFileSync(join(dir, 'graph.madar'), v2Bytes())
    writeFileSync(join(dir, 'graph.local.json'), JSON.stringify({ root_path: '/somewhere/repo' }))

    expect(readGraphArtifactMetadata(join(dir, 'graph.madar')).rootPath).toBe('/somewhere/repo')
  })
})
