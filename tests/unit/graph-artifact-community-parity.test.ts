import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { loadGraphArtifact, serializeGraphArtifactV2 } from '../../src/contracts/graph-artifact.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { loadGraph } from '../../src/runtime/serve.js'
import { readGeneratedGraphJson } from './helpers/generated-graph.js'

const FIXTURE = 'tests/fixtures/pack-quality/framework-runtime-boundary-distractor/workspace'

function generated(): { root: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'community-parity-'))
  cpSync(FIXTURE, root, { recursive: true })
  generateGraph(root, { noHtml: true, extractionMode: 'legacy' })
  return { root, out: join(root, 'out') }
}

describe('community assignment survives the artifact round trip', () => {
  it('preserves per-node community in the v2 artifact', () => {
    const { root, out } = generated()
    try {
      // community is a clustering result that v1 injected at write time rather
      // than storing on the node. v2 must carry it too: without it a v2 load
      // returned community-less nodes and retrieval scored them differently.
      //
      // Compared against the artifact's own serialized nodes rather than a v1
      // mirror, which the #705 cutover removed. The stored bytes are what a
      // reader actually gets, so this is the stronger of the two comparisons.
      const stored = readGeneratedGraphJson(out) as unknown as {
        nodes: { id: string; community?: number }[]
      }
      const canonical = loadGraph(join(out, 'graph.madar'))

      const fromStored = Object.fromEntries(stored.nodes.map((node) => [node.id, node.community]))
      const fromCanonical = Object.fromEntries(
        canonical.nodeIds().map((id) => [id, canonical.nodeAttributes(id).community]),
      )

      expect(stored.nodes.length).toBeGreaterThan(0)
      expect(Object.values(fromCanonical).every((value) => typeof value === 'number')).toBe(true)
      expect(fromCanonical).toEqual(fromStored)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the stored artifact and the loaded graph agreeing on every node', () => {
    const { root, out } = generated()
    try {
      const stored = readGeneratedGraphJson(out) as unknown as { nodes: { id: string }[] }
      const canonical = loadGraph(join(out, 'graph.madar'))

      expect(canonical.nodeIds().sort()).toEqual(stored.nodes.map((node) => node.id).sort())
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('serialized community is insertion-order invariant', () => {
  const build = (reverse: boolean): KnowledgeGraph => {
    const graph = new KnowledgeGraph({ directed: true })
    const nodes = [
      ['alpha', { label: 'Alpha', source_file: 'a.ts' }],
      ['beta', { label: 'Beta', source_file: 'b.ts' }],
      ['gamma', { label: 'Gamma', source_file: 'c.ts' }],
    ] as const
    for (const [id, attributes] of reverse ? [...nodes].reverse() : nodes) graph.addNode(id, attributes)
    const edges = [['alpha', 'beta'], ['beta', 'gamma']] as const
    for (const [source, target] of reverse ? [...edges].reverse() : edges) {
      graph.addEdge(source, target, { relation: 'calls', confidence: 'EXTRACTED' })
    }
    return graph
  }

  const serialize = (graph: KnowledgeGraph): Buffer => serializeGraphArtifactV2({
    graph,
    repositoryRevision: 'rev',
    generationMode: 'full',
    generatedAt: '2026-08-15T00:00:00.000Z',
    nodeCommunities: { alpha: 0, beta: 0, gamma: 1 },
  })

  it('produces identical bytes under reversed insertion', () => {
    expect(serialize(build(true))).toEqual(serialize(build(false)))
  })

  it('round-trips the same community for every node either way', () => {
    const read = (reverse: boolean): Record<string, unknown> => {
      const graph = loadGraphArtifact(serialize(build(reverse))).graph
      return Object.fromEntries(graph.nodeIds().map((id) => [id, graph.nodeAttributes(id).community]))
    }

    expect(read(true)).toEqual({ alpha: 0, beta: 0, gamma: 1 })
    expect(read(true)).toEqual(read(false))
  })

  it('leaves nodes untouched when no community map is supplied', () => {
    const graph = build(false)
    const bytes = serializeGraphArtifactV2({
      graph,
      repositoryRevision: 'rev',
      generationMode: 'full',
      generatedAt: '2026-08-15T00:00:00.000Z',
    })

    // No invented community: absent stays absent rather than defaulting to 0,
    // which would silently place every node in one community.
    const loaded = loadGraphArtifact(bytes).graph
    expect(loaded.nodeIds().every((id) => loaded.nodeAttributes(id).community === undefined)).toBe(true)
  })
})

describe('community parity holds on an unrelated workspace shape', () => {
  /**
   * Generic holdout. The community round-trip defect was found through one
   * Next.js fixture, so the regression must not be able to pass by knowing
   * that fixture. This workspace shares none of its names: a presentational
   * widget, a runtime owner module, and a shared helper.
   */
  function holdoutWorkspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'community-holdout-'))
    mkdirSync(join(root, 'src', 'ui'), { recursive: true })
    mkdirSync(join(root, 'src', 'runtime'), { recursive: true })
    writeFileSync(
      join(root, 'src', 'ui', 'report-widget.ts'),
      "import { persistReportSelection } from '../runtime/report-owner.js'\n"
      + 'export function ReportWidget(): void { persistReportSelection() }\n',
    )
    writeFileSync(
      join(root, 'src', 'runtime', 'report-owner.ts'),
      "import { normalizeSelection } from './selection-helper.js'\n"
      + 'export function persistReportSelection(): void { normalizeSelection() }\n',
    )
    writeFileSync(
      join(root, 'src', 'runtime', 'selection-helper.ts'),
      'export function normalizeSelection(): void {}\n',
    )
    return root
  }

  it('agrees between the stored artifact and the loaded graph', () => {
    const root = holdoutWorkspace()
    try {
      generateGraph(root, { noHtml: true, extractionMode: 'legacy' })
      const out = join(root, 'out')
      const stored = readGeneratedGraphJson(out) as unknown as {
        nodes: { id: string; community?: number }[]
      }
      const canonical = loadGraph(join(out, 'graph.madar'))

      expect(stored.nodes.length).toBeGreaterThan(0)
      expect(Object.fromEntries(canonical.nodeIds().map((id) => [id, canonical.nodeAttributes(id).community])))
        .toEqual(Object.fromEntries(stored.nodes.map((node) => [node.id, node.community])))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
