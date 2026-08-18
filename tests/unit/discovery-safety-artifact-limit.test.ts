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
  // Set once the real constant is importable. The mock factory is hoisted
  // above the imports, so it cannot close over the binding directly.
  classifyPrefixBytes: -1,
  /** Every read, probe or not, so the discriminator below can be audited. */
  rawReads: [] as { path: string; length: number; position: number }[],
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
  // The bounded reader opens a descriptor, sizes it with fstat and reads from
  // that same descriptor, so both interceptions have to follow it there.
  // Watching only statSync and readFileSync left forcedSizes ignored and
  // control.reads empty, which turns every assertion below into a pass that
  // observes nothing.
  const descriptorPaths = new Map<number, string>()
  const forcedFor = (path: string): number | undefined => control.forcedSizes[path]
  const overrideSize = (stats: unknown, forced: number | undefined): unknown => {
    if (stats === undefined || forced === undefined) return stats
    return new Proxy(stats as object, {
      get: (target, property, receiver) =>
        property === 'size' ? forced : Reflect.get(target, property, receiver),
    })
  }
  return {
    ...actual,
    // A forced size overrides `size` on the real Stats and nothing else. A
    // bare `{ size }` object drops `isFile()`, and the artifact reader asks
    // exactly that before reading -- so the stand-in made every forced-size
    // path look like a special file and get refused, which is a different
    // outcome from the oversized one these tests are about.
    statSync: ((path: never, ...rest: never[]) => {
      const stats = (actual.statSync as never as (...a: never[]) => unknown)(path, ...rest)
      return overrideSize(stats, forcedFor(String(path)))
    }) as never,
    fstatSync: ((descriptor: never, ...rest: never[]) => {
      const stats = (actual.fstatSync as never as (...a: never[]) => unknown)(descriptor, ...rest)
      const path = descriptorPaths.get(Number(descriptor))
      return overrideSize(stats, path === undefined ? undefined : forcedFor(path))
    }) as never,
    openSync: ((path: never, ...rest: never[]) => {
      const descriptor = (actual.openSync as never as (...a: never[]) => number)(path, ...rest)
      descriptorPaths.set(descriptor, String(path))
      return descriptor
    }) as never,
    readSync: ((...args: never[]) => {
      const [descriptor, , , length] = args as unknown as [number, unknown, unknown, unknown]
      const path = descriptorPaths.get(descriptor)
      const [, , , , rawPosition] = args as unknown as [number, unknown, unknown, unknown, unknown]
      if (path !== undefined && typeof length === 'number' && typeof rawPosition === 'number') {
        control.rawReads.push({ path, length, position: rawPosition })
      }
      // A classification probe is not a read of the artifact. It is the only
      // read that asks for exactly CLASSIFY_PREFIX_BYTES at position 0, which
      // is the one discriminator that holds when maxBytes is smaller than the
      // probe itself.
      const [, , , , position] = args as unknown as [number, unknown, unknown, unknown, unknown]
      const isProbe = length === control.classifyPrefixBytes && position === 0
      if (path !== undefined && !isProbe) control.reads.push(path)
      return (actual.readSync as never as (...a: never[]) => number)(...args)
    }) as never,
    readFileSync: ((path: never, ...rest: never[]) => {
      control.reads.push(String(path))
      return (actual.readFileSync as never as (...a: never[]) => unknown)(path, ...rest)
    }) as never,
  }
})

const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { KnowledgeGraph } = await import('../../src/contracts/graph.js')
const {
  serializeGraphArtifactV2,
  GRAPH_ARTIFACT_V2_TOMBSTONE,
  readGraphArtifactMetadata,
} = await import('../../src/contracts/graph-artifact.js')
const { MAX_GRAPH_ARTIFACT_BYTES, readDiscoverySafetyMetadata } = await import('../../src/shared/discovery-safety.js')
const { CLASSIFY_PREFIX_BYTES } = await import('../../src/contracts/graph-artifact-selection.js')
control.classifyPrefixBytes = CLASSIFY_PREFIX_BYTES

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
  control.rawReads = []
}

const cleanup = (dir: string): void => {
  reset()
  rmSync(join(dir, '..'), { recursive: true, force: true })
}

/**
 * The probe discriminator above separates a classification probe from an
 * artifact read by the exact width it asks for, because size alone cannot: a
 * bounded read under a small maxBytes asks for fewer bytes than the probe.
 *
 * That rule has one blind spot. A bounded read whose limit happens to equal
 * CLASSIFY_PREFIX_BYTES asks for exactly the probe's width at position 0 and
 * would be filed as a probe, silently vanishing from control.reads and making
 * a `not.toContain` assertion pass for the wrong reason. No bound in this file
 * is 89 today. This makes that a loud failure rather than a silent one if it
 * ever becomes true.
 */
describe('the probe discriminator is unambiguous for this file', () => {
  it('uses no artifact bound equal to the classification prefix width', () => {
    const source = readFileSync(new URL(import.meta.url), 'utf8')
    const bounds = [...source.matchAll(/maxBytes: ([0-9_]+)/g)]
      .map((match) => Number(match[1]!.replaceAll('_', '')))

    expect(bounds.length).toBeGreaterThan(0)
    expect(CLASSIFY_PREFIX_BYTES).toBe(89)
    expect(bounds).not.toContain(CLASSIFY_PREFIX_BYTES)
  })
})

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

describe('the cache describes what was read, not what was asked for', () => {
  it('does not serve a value cached under a different ceiling', () => {
    const dir = workspace()
    try {
      reset()
      const graphJson = join(dir, 'graph.json')
      const canonical = join(dir, 'graph.madar')
      writeFileSync(graphJson, LEGACY)
      writeFileSync(canonical, canonicalBytes())

      // Warm the cache under the default ceiling, then ask under a tiny one.
      readDiscoverySafetyMetadata(graphJson)
      control.metadataCalls = []

      expect(readDiscoverySafetyMetadata(graphJson, { maxBytes: 64 })).toBeNull()
      // A cache keyed only on the path would have answered from the first call
      // and reported a value that the second ceiling forbids.
      expect(control.metadataCalls).toHaveLength(1)
      expect(control.metadataCalls[0]?.maxBytes).toBe(64)
    } finally {
      cleanup(dir)
    }
  })

  it('re-reads when the canonical sibling changes but the mirror does not', () => {
    const dir = workspace()
    try {
      reset()
      const graphJson = join(dir, 'graph.json')
      const canonical = join(dir, 'graph.madar')
      // A cut-over workspace, not a mixed one. graph.json must be the tombstone
      // for this request to resolve to the canonical sibling at all: where a
      // live v1 sits there, the request stays on the v1 and this cache never
      // reads graph.madar. The fixture used a live v1 and so depended on the
      // metadata redirect that disagreed with the loader.
      writeFileSync(graphJson, GRAPH_ARTIFACT_V2_TOMBSTONE)
      writeFileSync(canonical, canonicalBytes())

      readDiscoverySafetyMetadata(graphJson)
      control.metadataCalls = []

      // graph.json is untouched; only the artifact actually read changes.
      writeFileSync(canonical, Buffer.concat([canonicalBytes(), Buffer.from('\n')]))
      readDiscoverySafetyMetadata(graphJson)

      // Keyed on the mirror's stat, this would have returned stale metadata
      // describing an artifact that no longer exists on disk.
      expect(control.metadataCalls).toHaveLength(1)
    } finally {
      cleanup(dir)
    }
  })

  it('serves a genuine repeat from cache', () => {
    const dir = workspace()
    try {
      reset()
      const graphJson = join(dir, 'graph.json')
      writeFileSync(graphJson, LEGACY)
      writeFileSync(join(dir, 'graph.madar'), canonicalBytes())

      readDiscoverySafetyMetadata(graphJson)
      control.metadataCalls = []
      readDiscoverySafetyMetadata(graphJson)

      // The fix must not turn the cache off; nothing changed, so no re-read.
      expect(control.metadataCalls).toEqual([])
    } finally {
      cleanup(dir)
    }
  })
})

describe('one request honours one size limit', () => {
  it('never reads a canonical artifact that exceeds the caller\'s bound', () => {
    const dir = workspace()
    try {
      reset()
      const graphJson = join(dir, 'graph.json')
      const canonical = join(dir, 'graph.madar')
      writeFileSync(graphJson, GRAPH_ARTIFACT_V2_TOMBSTONE)
      writeFileSync(canonical, canonicalBytes())
      control.forcedSizes[canonical] = 5_000_000

      const metadata = readGraphArtifactMetadata(graphJson, { maxBytes: 1_000 })

      // Classification decides the state by reading the canonical artifact in
      // full. On the module-wide default a 5 MB artifact is comfortably valid,
      // so it was read whole -- and only then did the caller's own 1 KB limit
      // refuse the same file. The bound the caller asked for has to reach the
      // classifier, or the read it exists to prevent has already happened.
      expect(control.reads).not.toContain(canonical)
      expect(metadata.format).not.toBe('v2')
    } finally {
      cleanup(dir)
    }
  })
})
