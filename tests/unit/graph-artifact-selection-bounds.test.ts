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

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
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

const { GraphArtifactTooLargeError, readArtifactWithinBound } = await import(
  '../../src/contracts/graph-artifact-selection.js'
)

afterEach(() => {
  understatedSize.bytes = null
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
