import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { GRAPH_ARTIFACT_V2_TOMBSTONE, readGraphArtifactMetadata } from '../../src/contracts/graph-artifact.js'
import { classifyWorkspaceGraph } from '../../src/contracts/graph-artifact-selection.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { analyzeGraphContextFreshness } from '../../src/runtime/freshness.js'
import { loadGraph, resolvedLoadPath } from '../../src/runtime/serve.js'

/**
 * Metadata, freshness and the loader must describe the same artifact.
 *
 * Each decided separately whether a request naming `out/graph.json` redirects to
 * the canonical artifact, and they disagreed. Metadata and freshness redirected
 * whenever `graph.madar` merely existed; the loader redirected only on a moved
 * marker. In a mixed workspace that produced v2 provenance and v2 freshness
 * describing a v1 graph body -- a combination that is worse than either answer
 * on its own, because each surface looks internally consistent.
 *
 * The table below is the agreement contract, one row per workspace state.
 */

const LIVE_V1 = (root: string): string => JSON.stringify({
  schema_version: 1,
  directed: true,
  root_path: root,
  nodes: [{ id: 'v1_only', label: 'v1Only()', file_type: 'code', source_file: 'src/a.ts', source_location: 'L1' }],
  links: [],
})

function cutOverWorkspace(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export function alpha() { beta() }\nexport function beta() {}\n')
  generateGraph(root, { noHtml: true })
  return root
}

describe('metadata, freshness and the loader agree on the artifact', () => {
  it('current_v2: an explicit legacy request resolves to the canonical artifact everywhere', () => {
    const root = cutOverWorkspace('agree-current-')
    try {
      const legacy = join(root, 'out', 'graph.json')
      expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('current_v2')

      // The tombstone is addressed to old readers; a current reader follows it.
      expect(resolvedLoadPath(legacy).endsWith('graph.madar')).toBe(true)
      expect(readGraphArtifactMetadata(legacy).format).toBe('v2')
      expect(analyzeGraphContextFreshness(legacy).graph_path).toBe('out/graph.madar')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('mixed: an explicit legacy request stays on the live v1 everywhere', () => {
    const root = cutOverWorkspace('agree-mixed-')
    try {
      const legacy = join(root, 'out', 'graph.json')
      writeFileSync(legacy, LIVE_V1(root))
      expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('mixed_v2_and_live_v1')

      // The loader returns the v1 body for this path, so nothing else may
      // describe the v2 artifact.
      expect(loadGraph(legacy).numberOfNodes()).toBe(1)
      expect(resolvedLoadPath(legacy).endsWith('graph.json')).toBe(true)
      expect(readGraphArtifactMetadata(legacy).format).not.toBe('v2')
      expect(analyzeGraphContextFreshness(legacy).graph_path).toBe('out/graph.json')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('legacy_v1_only: everything describes the legacy artifact', () => {
    const root = cutOverWorkspace('agree-legacy-')
    try {
      const legacy = join(root, 'out', 'graph.json')
      unlinkSync(join(root, 'out', 'graph.madar'))
      writeFileSync(legacy, LIVE_V1(root))
      expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('legacy_v1_only')

      expect(loadGraph(legacy).numberOfNodes()).toBe(1)
      expect(resolvedLoadPath(legacy).endsWith('graph.json')).toBe(true)
      expect(analyzeGraphContextFreshness(legacy).graph_path).toBe('out/graph.json')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('invalid_current_v2: a live v1 beside a corrupt canonical is not described as v2', () => {
    const root = cutOverWorkspace('agree-invalid-')
    try {
      const legacy = join(root, 'out', 'graph.json')
      writeFileSync(join(root, 'out', 'graph.madar'), 'MADAR_NOT_AN_ARTIFACT')
      writeFileSync(legacy, LIVE_V1(root))
      expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('invalid_current_v2')

      // Redirecting here would report provenance from a file that does not parse.
      expect(resolvedLoadPath(legacy).endsWith('graph.json')).toBe(true)
      expect(readGraphArtifactMetadata(legacy).format).not.toBe('v2')
      expect(analyzeGraphContextFreshness(legacy).graph_path).toBe('out/graph.json')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('moved_without_canonical: no surface invents an artifact', () => {
    const root = cutOverWorkspace('agree-moved-')
    try {
      const legacy = join(root, 'out', 'graph.json')
      unlinkSync(join(root, 'out', 'graph.madar'))
      writeFileSync(legacy, GRAPH_ARTIFACT_V2_TOMBSTONE)
      expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('moved_without_canonical')

      expect(() => loadGraph(legacy)).toThrow(/graph\.madar/)
      expect(readGraphArtifactMetadata(legacy).format).toBe('unreadable')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})
