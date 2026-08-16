import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const { GRAPH_ARTIFACT_V2_TOMBSTONE } = await import('../../src/contracts/graph-artifact.js')

afterEach(() => {
  understatedSize.bytes = null
  wholeFileReads.length = 0
})

describe('classification never reads a whole artifact', () => {
  const LIVE_V1 = JSON.stringify({ schema_version: 1, directed: true, nodes: [], links: [] })

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
    ['live v1 and a backup', { legacy: LIVE_V1, backup: LIVE_V1 }],
    ['a tombstone and a backup', { legacy: GRAPH_ARTIFACT_V2_TOMBSTONE, backup: LIVE_V1 }],
  ])('classifies %s without a whole-file read of either', (_label, files) => {
    const out = outputDir(files)
    try {
      classifyWorkspaceGraph(out)

      // Classification needs a short prefix of each. Pulling a whole legacy
      // artifact or backup into memory on every call is the defect.
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
