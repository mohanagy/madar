import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import {
  GRAPH_ARTIFACT_V2_TOMBSTONE,
  readGraphArtifactMetadata,
  serializeGraphArtifactV2,
} from '../../src/contracts/graph-artifact.js'

function canonicalBytes(): Buffer {
  const graph = new KnowledgeGraph({ directed: true })
  graph.addNode('a', { label: 'A' })
  graph.addNode('b', { label: 'B' })
  graph.addEdge('a', 'b', { relation: 'calls', confidence: 'EXTRACTED' })
  return serializeGraphArtifactV2({
    graph,
    repositoryRevision: 'rev',
    generationMode: 'full',
    generatedAt: '2026-08-16T00:00:00.000Z',
  })
}

const LEGACY = JSON.stringify({ schema_version: 1, directed: true, nodes: [], links: [] })

function outputDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'metadata-limit-'))
  mkdirSync(join(root, 'out'), { recursive: true })
  return join(root, 'out')
}

const cleanup = (dir: string): void => rmSync(join(dir, '..'), { recursive: true, force: true })

describe('the size limit follows the artifact actually read', () => {
  it('refuses an oversized sibling reached from a small graph.json', () => {
    const dir = outputDir()
    try {
      writeFileSync(join(dir, 'graph.json'), LEGACY)
      writeFileSync(join(dir, 'graph.madar'), canonicalBytes())

      // The caller only ever sees graph.json, which is tiny. Resolution then
      // switches to the canonical sibling, so a limit applied to the requested
      // path would have said nothing about the bytes that get loaded.
      const metadata = readGraphArtifactMetadata(join(dir, 'graph.json'), { maxBytes: 32 })

      expect(metadata.format).toBe('unreadable')
    } finally {
      cleanup(dir)
    }
  })

  it('refuses an oversized artifact requested directly', () => {
    const dir = outputDir()
    try {
      writeFileSync(join(dir, 'graph.madar'), canonicalBytes())

      expect(readGraphArtifactMetadata(join(dir, 'graph.madar'), { maxBytes: 32 }).format)
        .toBe('unreadable')
    } finally {
      cleanup(dir)
    }
  })

  it('refuses an oversized sibling reached through a tombstone', () => {
    const dir = outputDir()
    try {
      // Deliberately not graph.json. A graph.json request resolves straight to
      // the canonical sibling before the tombstone is ever parsed, so naming
      // this file graph.json exercised the sibling hop twice and left the
      // tombstone redirect -- a genuinely separate unbounded read -- untested.
      const tombstone = join(dir, 'graph.snapshot')
      writeFileSync(tombstone, GRAPH_ARTIFACT_V2_TOMBSTONE)
      writeFileSync(join(dir, 'graph.madar'), canonicalBytes())

      expect(readGraphArtifactMetadata(tombstone, { maxBytes: 64 }).format).toBe('unreadable')
    } finally {
      cleanup(dir)
    }
  })

  it('follows a tombstone to a within-limit sibling', () => {
    const dir = outputDir()
    try {
      const tombstone = join(dir, 'graph.snapshot')
      writeFileSync(tombstone, GRAPH_ARTIFACT_V2_TOMBSTONE)
      writeFileSync(join(dir, 'graph.madar'), canonicalBytes())

      // Proves the redirect is actually taken, so the refusal above is a size
      // refusal rather than the tombstone simply failing to parse.
      expect(readGraphArtifactMetadata(tombstone, { maxBytes: 10 * 1024 * 1024 }).format)
        .toBe('v2')
    } finally {
      cleanup(dir)
    }
  })

  it('accepts a canonical artifact within the limit', () => {
    const dir = outputDir()
    try {
      writeFileSync(join(dir, 'graph.madar'), canonicalBytes())

      expect(readGraphArtifactMetadata(join(dir, 'graph.madar'), { maxBytes: 10 * 1024 * 1024 }).format)
        .toBe('v2')
    } finally {
      cleanup(dir)
    }
  })

  it('accepts a legacy artifact within the limit', () => {
    const dir = outputDir()
    try {
      writeFileSync(join(dir, 'graph.json'), LEGACY)

      expect(readGraphArtifactMetadata(join(dir, 'graph.json'), { maxBytes: 10 * 1024 * 1024 }).format)
        .toBe('v1')
    } finally {
      cleanup(dir)
    }
  })

  it('reads without a limit when none is supplied', () => {
    const dir = outputDir()
    try {
      writeFileSync(join(dir, 'graph.madar'), canonicalBytes())

      expect(readGraphArtifactMetadata(join(dir, 'graph.madar')).format).toBe('v2')
    } finally {
      cleanup(dir)
    }
  })
})

describe('the limit does not blur the other outcomes', () => {
  it('still reports absent for a missing artifact', () => {
    const dir = outputDir()
    try {
      expect(readGraphArtifactMetadata(join(dir, 'graph.json'), { maxBytes: 32 }).format)
        .toBe('absent')
    } finally {
      cleanup(dir)
    }
  })

  it('still reports unreadable for a corrupt artifact within the limit', () => {
    const dir = outputDir()
    try {
      writeFileSync(join(dir, 'graph.json'), '{ not json')

      expect(readGraphArtifactMetadata(join(dir, 'graph.json'), { maxBytes: 10 * 1024 * 1024 }).format)
        .toBe('unreadable')
    } finally {
      cleanup(dir)
    }
  })

  it('reports unreadable for a tombstone whose sibling is missing', () => {
    const dir = outputDir()
    try {
      const tombstone = join(dir, 'graph.snapshot')
      writeFileSync(tombstone, GRAPH_ARTIFACT_V2_TOMBSTONE)

      expect(readGraphArtifactMetadata(tombstone, { maxBytes: 10 * 1024 * 1024 }).format)
        .toBe('unreadable')
    } finally {
      cleanup(dir)
    }
  })

  it('rejects at exactly one byte over and accepts at the limit', () => {
    const dir = outputDir()
    try {
      const bytes = canonicalBytes()
      writeFileSync(join(dir, 'graph.madar'), bytes)

      expect(readGraphArtifactMetadata(join(dir, 'graph.madar'), { maxBytes: bytes.byteLength }).format)
        .toBe('v2')
      expect(readGraphArtifactMetadata(join(dir, 'graph.madar'), { maxBytes: bytes.byteLength - 1 }).format)
        .toBe('unreadable')
    } finally {
      cleanup(dir)
    }
  })
})
