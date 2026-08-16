import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The second bound in readArtifactWithinBound guards the window between the
 * stat and the read: a file that grows after it was measured small. No real
 * file can be made to do that on demand, so the only deterministic way to
 * reach that branch is a stat that under-reports.
 */
const understatedSize = { bytes: null as number | null }

/** Every path passed to readFileSync, so a whole-file read cannot hide. */
const wholeFileReads: string[] = []

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    readFileSync: (path: Parameters<typeof real.readFileSync>[0], ...rest: unknown[]) => {
      if (typeof path === 'string') wholeFileReads.push(path)
      return (real.readFileSync as (...args: unknown[]) => ReturnType<typeof real.readFileSync>)(path, ...rest)
    },
    // Passes through untouched unless a test arms it, so every other suite
    // and the fixture helpers below keep the real filesystem.
    statSync: (path: Parameters<typeof real.statSync>[0], ...rest: unknown[]) => {
      const stats = (real.statSync as (...args: unknown[]) => ReturnType<typeof real.statSync>)(path, ...rest)
      // `throwIfNoEntry: false` callers get undefined; pass that through.
      if (stats === undefined || understatedSize.bytes === null) return stats
      return new Proxy(stats, {
        get: (target, property, receiver) =>
          property === 'size' ? understatedSize.bytes : Reflect.get(target, property, receiver),
      })
    },
  }
})

const { GraphArtifactTooLargeError, classifyWorkspaceGraph, readArtifactWithinBound } = await import(
  '../../src/contracts/graph-artifact-selection.js'
)
const { GRAPH_ARTIFACT_V2_TOMBSTONE, serializeGraphArtifactV2 } = await import('../../src/contracts/graph-artifact.js')
const { KnowledgeGraph } = await import('../../src/contracts/graph.js')

afterEach(() => {
  understatedSize.bytes = null
  wholeFileReads.length = 0
})

/**
 * Every assertion in this file is conditional on the node:fs mock above being
 * live. If that factory ever stops taking effect, `understatedSize` is ignored
 * and `wholeFileReads` stays permanently empty -- at which point the post-read
 * bound test and both `not.toContain` assertions pass while testing nothing.
 * These two check the instrument before trusting its readings.
 */
describe('the fs mock is live', () => {
  it('reports the size the test arms, not the real one', () => {
    const root = mkdtempSync(join(tmpdir(), 'mock-check-'))
    const path = join(root, 'probe')
    writeFileSync(path, 'x'.repeat(4096))

    try {
      understatedSize.bytes = 8
      expect(statSync(path).size).toBe(8)
      understatedSize.bytes = null
      expect(statSync(path).size).toBe(4096)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records the paths readFileSync is called with', () => {
    const root = mkdtempSync(join(tmpdir(), 'mock-check-'))
    const path = join(root, 'probe')
    writeFileSync(path, 'recorded')

    try {
      readFileSync(path)
      expect(wholeFileReads).toContain(path)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('classification never reads a whole legacy artifact or backup', () => {
  const LIVE_V1 = JSON.stringify({ schema_version: 1, directed: true, nodes: [], links: [] })

  function canonicalArtifact(): string {
    const graph = new KnowledgeGraph({ directed: true })
    graph.addNode('a', { label: 'A' })
    return serializeGraphArtifactV2({
      graph,
      repositoryRevision: 'rev',
      generationMode: 'full',
      generatedAt: '2026-08-16T00:00:00.000Z',
    }).toString('utf8')
  }

  function outputDir(files: Partial<Record<'canonical' | 'legacy' | 'backup', string>>): string {
    const root = mkdtempSync(join(tmpdir(), 'classify-reads-'))
    const out = join(root, 'out')
    mkdirSync(out, { recursive: true })
    if (files.canonical !== undefined) writeFileSync(join(out, 'graph.madar'), files.canonical)
    if (files.legacy !== undefined) writeFileSync(join(out, 'graph.json'), files.legacy)
    if (files.backup !== undefined) writeFileSync(join(out, 'graph.v1.json'), files.backup)
    return out
  }

  it.each([
    ['a live v1 beside a canonical artifact', { legacy: LIVE_V1 }],
    ['a tombstone beside a canonical artifact', { legacy: GRAPH_ARTIFACT_V2_TOMBSTONE }],
  ])('classifies %s without a whole-file read of the legacy artifact or backup', (_label, files) => {
    const out = outputDir({ canonical: canonicalArtifact(), backup: LIVE_V1, ...files })
    try {
      classifyWorkspaceGraph(out)

      // The canonical artifact IS read in full, bounded: deciding whether it is
      // valid means parsing it, and that read is the reason this recorder is
      // never empty here. Anchoring on it keeps the exclusions below honest --
      // `not.toContain` against an empty array would hold no matter what.
      expect(wholeFileReads).toContain(join(out, 'graph.madar'))

      // The legacy artifact and the backup only need a short prefix. Pulling
      // either into memory on every classification is the defect.
      expect(wholeFileReads).not.toContain(join(out, 'graph.json'))
      expect(wholeFileReads).not.toContain(join(out, 'graph.v1.json'))
    } finally {
      rmSync(join(out, '..'), { recursive: true, force: true })
    }
  })
})

describe('pre-read bound', () => {
  it('rejects an oversized artifact without loading it into memory', () => {
    const root = mkdtempSync(join(tmpdir(), 'bounds-pre-'))
    const path = join(root, 'graph.madar')
    writeFileSync(path, 'x'.repeat(4096))

    try {
      expect(() => readArtifactWithinBound(path, 64)).toThrow(GraphArtifactTooLargeError)

      // The point of the stat gate: an oversized artifact is refused before it
      // is read at all. Rejecting it only after the read would raise the same
      // error while still pulling the whole file into memory.
      expect(wholeFileReads).not.toContain(path)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('post-read bound', () => {
  it('rejects an artifact that stat under-reported', () => {
    const root = mkdtempSync(join(tmpdir(), 'bounds-'))
    const path = join(root, 'graph.madar')
    mkdirSync(root, { recursive: true })
    writeFileSync(path, 'x'.repeat(4096))

    try {
      // Stat claims it fits; the bytes on disk do not.
      understatedSize.bytes = 8
      expect(() => readArtifactWithinBound(path, 64)).toThrow(GraphArtifactTooLargeError)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still accepts an artifact that genuinely fits', () => {
    const root = mkdtempSync(join(tmpdir(), 'bounds-'))
    const path = join(root, 'graph.madar')
    writeFileSync(path, 'x'.repeat(16))

    try {
      understatedSize.bytes = 8
      expect(readArtifactWithinBound(path, 64).byteLength).toBe(16)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
