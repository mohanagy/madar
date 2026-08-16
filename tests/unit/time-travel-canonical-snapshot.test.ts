import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { serializeGraphArtifactV2 } from '../../src/contracts/graph-artifact.js'
import { publishTransitionalGraphArtifacts } from '../../src/infrastructure/graph-artifact-transitional.js'
import { loadGraph } from '../../src/runtime/serve.js'
import { loadOrBuildSnapshot } from '../../src/infrastructure/time-travel.js'

/**
 * Two facts between one endpoint pair. The v1 mirror cannot represent this --
 * it collapses to a single link -- so it is exactly what a snapshot loses if
 * it keeps only the mirror.
 */
function parallelFactGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })
  graph.addNode('a', { label: 'A' })
  graph.addNode('b', { label: 'B' })
  graph.addEdge('a', 'b', { relation: 'calls', confidence: 'EXTRACTED' })
  graph.addEdge('a', 'b', { relation: 'imports', confidence: 'EXTRACTED' })
  return graph
}

function publishedWorkspace(): { root: string; outputDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'time-travel-canonical-'))
  const outputDir = join(root, 'out')
  mkdirSync(outputDir, { recursive: true })
  const graph = parallelFactGraph()
  publishTransitionalGraphArtifacts({
    outputDir,
    artifactBytes: serializeGraphArtifactV2({
      graph,
      repositoryRevision: 'rev',
      generationMode: 'full',
      generatedAt: '2026-08-16T00:00:00.000Z',
    }),
    legacyJson: JSON.stringify({
      schema_version: 1,
      directed: true,
      nodes: [
        { id: 'a', label: 'A', file_type: 'code', source_file: 'a.ts' },
        { id: 'b', label: 'B', file_type: 'code', source_file: 'b.ts' },
      ],
      // The mirror can only carry one of the two facts.
      links: [{ source: 'a', target: 'b', relation: 'calls', confidence: 'EXTRACTED' }],
    }),
    rootPath: root,
  })
  return { root, outputDir }
}

describe('the transitional output really is lossy in the mirror', () => {
  it('keeps two parallel facts canonically and one in the mirror', () => {
    const { root, outputDir } = publishedWorkspace()
    try {
      expect(loadGraph(join(outputDir, 'graph.madar')).numberOfFacts()).toBe(2)

      const mirror = JSON.parse(readFileSync(join(outputDir, 'graph.json'), 'utf8')) as { links: unknown[] }

      // This asymmetry is the whole reason a snapshot must carry graph.madar.
      expect(mirror.links).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('a snapshot preserves the canonical artifact', () => {
  /**
   * Drives the real persistSnapshot through loadOrBuildSnapshot. An earlier
   * version of this suite copied the files itself and asserted on its own copy,
   * so it passed while production copied nothing -- a mutation deleting the
   * canonical copy survived it untouched.
   */
  const build = async (): Promise<{ root: string; snapshotDir: string }> => {
    const { root, outputDir } = publishedWorkspace()
    const snapshot = await loadOrBuildSnapshot({ ref: 'HEAD' }, {
      rootDir: root,
      git: {
        resolveRef: () => 'c'.repeat(40),
        createDetachedWorktree: () => undefined,
        removeWorktree: () => undefined,
      },
      generateGraph: () => ({ graphPath: join(outputDir, 'graph.json'), reportPath: '' }),
      loadGraphExtractorVersion: () => 1,
    })
    return { root, snapshotDir: dirname(snapshot.graphPath) }
  }

  it('round-trips both parallel facts through a real snapshot', async () => {
    const { root, snapshotDir } = await build()
    try {
      // Read through graph.json exactly as the snapshot reader does; canonical
      // sibling preference must pick up the copied graph.madar.
      expect(loadGraph(join(snapshotDir, 'graph.json')).numberOfFacts()).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('carries the canonical artifact and the machine-local sidecar', async () => {
    const { root, snapshotDir } = await build()
    try {
      expect(existsSync(join(snapshotDir, 'graph.madar'))).toBe(true)
      expect(existsSync(join(snapshotDir, 'graph.local.json'))).toBe(true)
      expect(JSON.parse(readFileSync(join(snapshotDir, 'graph.local.json'), 'utf8')))
        .toEqual({ root_path: root })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the transitional mirror available for old readers', async () => {
    const { root, snapshotDir } = await build()
    try {
      const mirror = JSON.parse(readFileSync(join(snapshotDir, 'graph.json'), 'utf8')) as { schema_version: number }

      expect(mirror.schema_version).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('degrades explicitly to the mirror when no canonical artifact was captured', async () => {
    const { root, snapshotDir } = await build()
    try {
      rmSync(join(snapshotDir, 'graph.madar'), { force: true })

      // A snapshot taken before v2 existed is still readable; it is simply the
      // lossy view, and it says so by having one fact instead of two.
      expect(loadGraph(join(snapshotDir, 'graph.json')).numberOfFacts()).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('a retried snapshot does not inherit the previous attempt', () => {
  it('drops a stale canonical artifact when the new source has none', async () => {
    const { root, outputDir } = publishedWorkspace()
    try {
      const snapshot = await loadOrBuildSnapshot({ ref: 'HEAD' }, {
        rootDir: root,
        git: {
          resolveRef: () => 'd'.repeat(40),
          createDetachedWorktree: () => undefined,
          removeWorktree: () => undefined,
        },
        generateGraph: () => ({ graphPath: join(outputDir, 'graph.json'), reportPath: '' }),
        loadGraphExtractorVersion: () => 1,
      })
      expect(existsSync(join(dirname(snapshot.graphPath), 'graph.madar'))).toBe(true)

      // Regenerate with no canonical artifact and no sidecar, as a pre-v2
      // workspace or an interrupted publication would leave things.
      rmSync(join(outputDir, 'graph.madar'), { force: true })
      rmSync(join(outputDir, 'graph.local.json'), { force: true })

      const retried = await loadOrBuildSnapshot({ ref: 'HEAD', refresh: true }, {
        rootDir: root,
        git: {
          resolveRef: () => 'd'.repeat(40),
          createDetachedWorktree: () => undefined,
          removeWorktree: () => undefined,
        },
        generateGraph: () => ({ graphPath: join(outputDir, 'graph.json'), reportPath: '' }),
        loadGraphExtractorVersion: () => 1,
      })

      // Keeping the old file would leave a snapshot whose canonical artifact
      // describes a different run than its mirror, and readers prefer the
      // canonical one.
      const dir = dirname(retried.graphPath)
      expect(existsSync(join(dir, 'graph.madar'))).toBe(false)
      expect(existsSync(join(dir, 'graph.local.json'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
