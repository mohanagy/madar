import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { serializeGraphArtifactV2 } from '../../src/contracts/graph-artifact.js'
import { publishTransitionalGraphArtifacts } from '../../src/infrastructure/graph-artifact-transitional.js'
import { loadGraph } from '../../src/runtime/serve.js'

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
  /** Mirrors what persistSnapshot copies into a snapshot directory. */
  const snapshot = (root: string, outputDir: string): string => {
    // loadGraph resolves an out/ base and refuses anything outside it, so the
    // snapshot fixture has to use the same layout a real snapshot does.
    const target = join(mkdtempSync(join(root, 'snapshot-')), 'out')
    mkdirSync(target, { recursive: true })
    for (const basename of ['graph.json', 'graph.madar', 'graph.local.json']) {
      const source = join(outputDir, basename)
      if (existsSync(source)) writeFileSync(join(target, basename), readFileSync(source))
    }
    return target
  }

  it('round-trips both parallel facts through a snapshot', () => {
    const { root, outputDir } = publishedWorkspace()
    const target = snapshot(root, outputDir)
    try {
      // Read through graph.json exactly as the snapshot reader does; canonical
      // sibling preference must pick up graph.madar.
      expect(loadGraph(join(target, 'graph.json')).numberOfFacts()).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('carries the canonical artifact and the machine-local sidecar', () => {
    const { root, outputDir } = publishedWorkspace()
    const target = snapshot(root, outputDir)
    try {
      expect(existsSync(join(target, 'graph.madar'))).toBe(true)
      expect(existsSync(join(target, 'graph.local.json'))).toBe(true)
      expect(JSON.parse(readFileSync(join(target, 'graph.local.json'), 'utf8'))).toEqual({ root_path: root })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the transitional mirror available for old readers', () => {
    const { root, outputDir } = publishedWorkspace()
    const target = snapshot(root, outputDir)
    try {
      const mirror = JSON.parse(readFileSync(join(target, 'graph.json'), 'utf8')) as { schema_version: number }

      expect(mirror.schema_version).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('degrades explicitly to the mirror when no canonical artifact was captured', () => {
    const { root, outputDir } = publishedWorkspace()
    const target = snapshot(root, outputDir)
    try {
      rmSync(join(target, 'graph.madar'), { force: true })

      // A snapshot taken before v2 existed is still readable; it is simply the
      // lossy view, and it says so by having one fact instead of two.
      expect(loadGraph(join(target, 'graph.json')).numberOfFacts()).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
