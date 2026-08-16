import { describe, expect, it, vi } from 'vitest'

/**
 * Proves the size ceiling actually reaches the artifact discovery safety reads,
 * rather than only guarding the path it was handed.
 *
 * Two interceptions, because two different things need proving. The metadata
 * reader is wrapped to record the limit it receives, which is the wiring. And
 * node:fs is wrapped so a tiny fixture can behave as an oversized resolved
 * artifact, which is the behaviour -- committing a 100 MB fixture to observe
 * the real default would be a worse thing to keep in the repository.
 */
const control = vi.hoisted(() => ({
  metadataCalls: [] as { path: string; maxBytes: unknown }[],
  forcedSizes: {} as Record<string, number>,
  reads: [] as string[],
}))

vi.mock('../../src/contracts/graph-artifact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/contracts/graph-artifact.js')>()
  return {
    ...actual,
    readGraphArtifactMetadata: (path: string, options?: { maxBytes?: number }) => {
      control.metadataCalls.push({ path, maxBytes: options?.maxBytes })
      return actual.readGraphArtifactMetadata(path, options)
    },
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: ((path: never, ...rest: never[]) => {
      const forced = control.forcedSizes[String(path)]
      if (forced !== undefined) return { size: forced, mtimeMs: 1 }
      return (actual.statSync as never as (...a: never[]) => unknown)(path, ...rest)
    }) as never,
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
const { serializeGraphArtifactV2 } = await import('../../src/contracts/graph-artifact.js')
const { MAX_GRAPH_ARTIFACT_BYTES, readDiscoverySafetyMetadata } = await import('../../src/shared/discovery-safety.js')

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

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'discovery-limit-'))
  mkdirSync(join(root, 'out'), { recursive: true })
  return join(root, 'out')
}

function reset(): void {
  control.metadataCalls = []
  control.forcedSizes = {}
  control.reads = []
}

const cleanup = (dir: string): void => {
  reset()
  rmSync(join(dir, '..'), { recursive: true, force: true })
}

describe('discovery safety supplies its ceiling to the artifact reader', () => {
  it('passes MAX_GRAPH_ARTIFACT_BYTES by default', () => {
    const dir = workspace()
    try {
      reset()
      const graphJson = join(dir, 'graph.json')
      writeFileSync(graphJson, LEGACY)

      readDiscoverySafetyMetadata(graphJson)

      // The wiring, asserted as a value rather than read off the call site.
      expect(control.metadataCalls).toHaveLength(1)
      expect(control.metadataCalls[0]?.maxBytes).toBe(MAX_GRAPH_ARTIFACT_BYTES)
      expect(MAX_GRAPH_ARTIFACT_BYTES).toBe(100 * 1024 * 1024)
    } finally {
      cleanup(dir)
    }
  })

  it('passes an explicit override through unchanged', () => {
    const dir = workspace()
    try {
      reset()
      const graphJson = join(dir, 'graph.json')
      writeFileSync(graphJson, LEGACY)

      readDiscoverySafetyMetadata(graphJson, { maxBytes: 4096 })

      expect(control.metadataCalls[0]?.maxBytes).toBe(4096)
    } finally {
      cleanup(dir)
    }
  })
})

describe('a small graph.json cannot smuggle in an oversized sibling', () => {
  it('refuses when the resolved canonical artifact is over the limit', () => {
    const dir = workspace()
    try {
      reset()
      const graphJson = join(dir, 'graph.json')
      const canonical = join(dir, 'graph.madar')
      writeFileSync(graphJson, LEGACY)
      writeFileSync(canonical, canonicalBytes())
      // graph.json is genuinely tiny; the sibling reports as huge.
      control.forcedSizes[canonical] = MAX_GRAPH_ARTIFACT_BYTES + 1

      expect(readDiscoverySafetyMetadata(graphJson)).toBeNull()
    } finally {
      cleanup(dir)
    }
  })

  it('never reads the oversized sibling', () => {
    const dir = workspace()
    try {
      reset()
      const graphJson = join(dir, 'graph.json')
      const canonical = join(dir, 'graph.madar')
      writeFileSync(graphJson, LEGACY)
      writeFileSync(canonical, canonicalBytes())
      control.forcedSizes[canonical] = MAX_GRAPH_ARTIFACT_BYTES + 1
      control.reads = []

      readDiscoverySafetyMetadata(graphJson)

      // The pre-read check exists so an oversized artifact is refused without
      // loading it, not merely reported as too large after loading it.
      expect(control.reads.filter((path) => path === canonical)).toEqual([])
    } finally {
      cleanup(dir)
    }
  })

  it('catches a sibling that grew between the stat and the read', () => {
    const dir = workspace()
    try {
      reset()
      const graphJson = join(dir, 'graph.json')
      const canonical = join(dir, 'graph.madar')
      writeFileSync(graphJson, LEGACY)
      writeFileSync(canonical, canonicalBytes())
      // Stat under-reports, so only the post-read byte length can notice.
      control.forcedSizes[canonical] = 1
      control.reads = []

      expect(readDiscoverySafetyMetadata(graphJson, { maxBytes: 64 })).toBeNull()
      expect(control.reads).toContain(canonical)
    } finally {
      cleanup(dir)
    }
  })

  it('reads a canonical sibling that is inside the limit', () => {
    const dir = workspace()
    try {
      reset()
      const graphJson = join(dir, 'graph.json')
      const canonical = join(dir, 'graph.madar')
      writeFileSync(graphJson, LEGACY)
      writeFileSync(canonical, canonicalBytes())

      readDiscoverySafetyMetadata(graphJson)

      // A null result here would mean "this artifact declares no discovery
      // safety", which is not the same as "refused on size" -- so the proof is
      // that the reader was consulted and the sibling actually got read.
      expect(control.metadataCalls).toHaveLength(1)
      expect(control.reads).toContain(canonical)
    } finally {
      cleanup(dir)
    }
  })
})

describe('the limit does not blur absent or unreadable', () => {
  it('returns null for an absent artifact', () => {
    const dir = workspace()
    try {
      reset()

      expect(readDiscoverySafetyMetadata(join(dir, 'graph.json'))).toBeNull()
    } finally {
      cleanup(dir)
    }
  })

  it('returns null for a corrupt artifact inside the limit', () => {
    const dir = workspace()
    try {
      reset()
      const graphJson = join(dir, 'graph.json')
      writeFileSync(graphJson, '{ not json')

      expect(readDiscoverySafetyMetadata(graphJson)).toBeNull()
      // Reached the reader rather than being refused on size.
      expect(control.metadataCalls).toHaveLength(1)
    } finally {
      cleanup(dir)
    }
  })

  it('still refuses when the requested path itself is oversized', () => {
    const dir = workspace()
    try {
      reset()
      const graphJson = join(dir, 'graph.json')
      writeFileSync(graphJson, LEGACY)
      control.forcedSizes[graphJson] = MAX_GRAPH_ARTIFACT_BYTES + 1

      expect(readDiscoverySafetyMetadata(graphJson)).toBeNull()
      // Refused before the reader was consulted at all.
      expect(control.metadataCalls).toEqual([])
    } finally {
      cleanup(dir)
    }
  })
})
