import { describe, expect, it, vi } from 'vitest'

/**
 * The two size checks cannot be told apart by their result: both refuse an
 * oversized artifact. What distinguishes them is I/O -- the stat exists so the
 * bytes are never read, and the post-read length exists to catch a file that
 * grew after the stat. Observing that needs node:fs itself intercepted, which
 * is why these two live apart from the behavioural suite.
 */
const control = vi.hoisted(() => ({
  forcedStatSize: null as number | null,
  reads: [] as string[],
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: ((path: never, ...rest: never[]) => (
      control.forcedStatSize === null
        ? (actual.statSync as never as (...a: never[]) => unknown)(path, ...rest)
        : { size: control.forcedStatSize }
    )) as never,
    readFileSync: ((path: never, ...rest: never[]) => {
      control.reads.push(String(path))
      return (actual.readFileSync as never as (...a: never[]) => unknown)(path, ...rest)
    }) as never,
  }
})

const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { KnowledgeGraph } = await import('../../src/contracts/graph.js')
const { readGraphArtifactMetadata, serializeGraphArtifactV2 } = await import('../../src/contracts/graph-artifact.js')

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

function outputDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'metadata-limit-io-'))
  mkdirSync(join(root, 'out'), { recursive: true })
  return join(root, 'out')
}

const cleanup = (dir: string): void => rmSync(join(dir, '..'), { recursive: true, force: true })

describe('the two size checks do different jobs', () => {
  it('refuses on the stat without ever reading the bytes', () => {
    const dir = outputDir()
    try {
      const artifact = join(dir, 'graph.madar')
      writeFileSync(artifact, canonicalBytes())
      control.forcedStatSize = null
      control.reads = []

      expect(readGraphArtifactMetadata(artifact, { maxBytes: 32 }).format).toBe('unreadable')

      // Reading an oversized artifact just to discover it is oversized is the
      // exact behaviour the pre-read check exists to prevent.
      expect(control.reads.filter((path) => path === artifact)).toEqual([])
    } finally {
      control.forcedStatSize = null
      cleanup(dir)
    }
  })

  it('catches a file that grew between the stat and the read', () => {
    const dir = outputDir()
    try {
      const artifact = join(dir, 'graph.madar')
      writeFileSync(artifact, canonicalBytes())
      // A stat that under-reports lets the pre-read check pass, leaving only
      // the post-read length to notice the artifact is over the limit.
      control.forcedStatSize = 1

      expect(readGraphArtifactMetadata(artifact, { maxBytes: 32 }).format).toBe('unreadable')
      expect(control.reads).toContain(artifact)
    } finally {
      control.forcedStatSize = null
      cleanup(dir)
    }
  })

  it('still accepts a within-limit artifact through the same path', () => {
    const dir = outputDir()
    try {
      const artifact = join(dir, 'graph.madar')
      writeFileSync(artifact, canonicalBytes())
      control.forcedStatSize = null

      expect(readGraphArtifactMetadata(artifact, { maxBytes: 10 * 1024 * 1024 }).format).toBe('v2')
    } finally {
      cleanup(dir)
    }
  })
})
