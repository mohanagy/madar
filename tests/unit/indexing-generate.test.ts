import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { IndexingManifest, ShareSafeIndexingManifest } from '../../src/contracts/indexing.js'
import {
  generateGraph,
  IndexingCompletenessError,
} from '../../src/infrastructure/generate.js'
import { readCanonicalGraphFixture } from '../helpers/graph-artifact.js'

function withWorkspace(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'madar-indexing-generate-'))
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

describe('generate indexing completeness', () => {
  it('writes local and share-safe manifests and marks a partial graph prominently', () => {
    withWorkspace((root) => {
      writeFileSync(join(root, 'main.ts'), 'export function main() { return 1 }\n', 'utf8')
      writeFileSync(join(root, 'legacy.vue'), '<template><main /></template>\n', 'utf8')
      writeFileSync(join(root, '.hidden.ts'), 'export const hidden = true\n', 'utf8')
      writeFileSync(join(root, '.madarignore'), 'ignored.ts\n', 'utf8')
      writeFileSync(join(root, 'ignored.ts'), 'export const ignored = true\n', 'utf8')

      const result = generateGraph(root, {  })
      const manifestPath = join(root, 'out', 'indexing-manifest.json')
      const shareSafePath = join(root, 'out', 'indexing-manifest.share-safe.json')
      const manifest = readJson<IndexingManifest>(manifestPath)
      const shareSafe = readJson<ShareSafeIndexingManifest>(shareSafePath)
      const graph = readCanonicalGraphFixture(join(root, 'out', 'graph.json'))
      const report = readFileSync(join(root, 'out', 'GRAPH_REPORT.md'), 'utf8')

      expect(result.indexing).toMatchObject({
        state: 'partial',
        counts: {
          indexed: 1,
          skipped_by_policy: 2,
          unsupported: 1,
          failed: 0,
        },
      })
      expect(result.indexingManifestPath).toBe(manifestPath)
      expect(result.indexingShareSafeManifestPath).toBe(shareSafePath)
      expect(manifest.outcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'main.ts', status: 'indexed' }),
        expect.objectContaining({ path: 'legacy.vue', reason: 'unsupported_file_type' }),
        expect.objectContaining({ path: '.hidden.ts', reason: 'hidden_path' }),
        expect.objectContaining({ path: 'ignored.ts', reason: 'madarignore' }),
      ]))
      expect(shareSafe.summary).toEqual(manifest.summary)
      expect(shareSafe).not.toHaveProperty('outcomes')
      expect(JSON.stringify(shareSafe)).not.toContain('legacy.vue')
      expect(graph.indexing_completeness).toMatchObject({
        version: 2,
        summary: { state: 'partial' },
      })
      expect(JSON.stringify(graph.indexing_completeness)).not.toContain('legacy.vue')
      expect(report).toContain('**Indexing completeness: PARTIAL**')
      expect(result.notes.join('\n')).toContain('Indexing partial:')
    })
  })

  it('writes the audit manifest before strict thresholds fail generation', () => {
    withWorkspace((root) => {
      writeFileSync(join(root, 'main.ts'), 'export const main = 1\n', 'utf8')
      writeFileSync(join(root, 'legacy.svelte'), '<script>export let value</script>\n', 'utf8')

      let thrown: unknown
      try {
        generateGraph(root, {
          indexingStrict: { maxFailed: 0, maxUnsupported: 0 },
        })
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(IndexingCompletenessError)
      expect(thrown).toMatchObject({
        violations: ['unsupported=1 exceeds maxUnsupported=0'],
      })
      expect(existsSync(join(root, 'out', 'indexing-manifest.json'))).toBe(false)
      expect(existsSync(join(root, 'out', 'indexing-manifest.failed.share-safe.json'))).toBe(true)
      expect(readJson<IndexingManifest>(join(root, 'out', 'indexing-manifest.failed.json')).summary).toMatchObject({
        state: 'partial',
        counts: { indexed: 1, unsupported: 1 },
      })
      expect(existsSync(join(root, 'out', 'graph.json'))).toBe(false)
      expect(existsSync(join(root, 'out', 'manifest.json'))).toBe(false)
    })
  })

  it('does not advance incremental fingerprints when strict generation fails', () => {
    withWorkspace((root) => {
      const sourcePath = join(root, 'main.ts')
      const unsupportedPath = join(root, 'legacy.vue')
      const sourceManifestPath = join(root, 'out', 'manifest.json')
      const graphPath = join(root, 'out', 'graph.json')
      writeFileSync(sourcePath, 'export function initialFlow() { return 1 }\n', 'utf8')
      generateGraph(root, {  })
      const manifestBeforeFailure = readFileSync(sourceManifestPath, 'utf8')
      const indexingManifestBeforeFailure = readFileSync(join(root, 'out', 'indexing-manifest.json'), 'utf8')

      writeFileSync(sourcePath, 'export function updatedFlow() { return 2 }\n', 'utf8')
      const future = new Date(Date.now() + 1_000)
      utimesSync(sourcePath, future, future)
      writeFileSync(unsupportedPath, '<template />\n', 'utf8')

      expect(() => generateGraph(root, {
        update: true,
        indexingStrict: { maxFailed: 0, maxUnsupported: 0 },
      })).toThrow(IndexingCompletenessError)

      expect(readFileSync(sourceManifestPath, 'utf8')).toBe(manifestBeforeFailure)
      expect(readFileSync(join(root, 'out', 'indexing-manifest.json'), 'utf8')).toBe(indexingManifestBeforeFailure)
      expect(existsSync(join(root, 'out', 'indexing-manifest.failed.json'))).toBe(true)
      expect(JSON.stringify(readCanonicalGraphFixture(graphPath))).not.toContain('updatedFlow')

      unlinkSync(unsupportedPath)
      const retry = generateGraph(root, { update: true })
      const retriedGraph = readCanonicalGraphFixture(graphPath)

      expect(retry.mode).toBe('update')
      expect(retriedGraph.nodes.some((node) => node.label?.includes('updatedFlow'))).toBe(true)
      expect(existsSync(join(root, 'out', 'indexing-manifest.failed.json'))).toBe(false)
    })
  })
})
