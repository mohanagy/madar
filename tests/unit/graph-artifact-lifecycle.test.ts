import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  GRAPH_ARTIFACT_V2_HEADER,
  GRAPH_LOCAL_SIDECAR_BASENAME,
  loadGraphArtifact,
  readGraphArtifactMetadata,
} from '../../src/contracts/graph-artifact.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { loadGraph } from '../../src/runtime/serve.js'

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-lifecycle-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'src', 'service.ts'),
    'export class Service {\n  run(): void { helper() }\n}\nexport function helper(): void {}\n',
  )
  writeFileSync(
    join(root, 'src', 'caller.ts'),
    "import { Service } from './service.js'\nexport function main(): void { new Service().run() }\n",
  )
  return root
}

function generated(): { root: string; outputDir: string } {
  const root = project()
  generateGraph(root, { noHtml: true })
  return { root, outputDir: join(root, 'out') }
}

describe('B1 transitional dual-artifact generation', () => {
  it('writes graph.madar as the canonical v2 artifact', () => {
    const { outputDir } = generated()
    const artifact = join(outputDir, 'graph.madar')

    expect(existsSync(artifact)).toBe(true)
    expect(readFileSync(artifact).subarray(0, GRAPH_ARTIFACT_V2_HEADER.length).toString('utf8'))
      .toBe(GRAPH_ARTIFACT_V2_HEADER)
  })

  it('keeps graph.json as a real v1 mirror rather than a tombstone', () => {
    const { outputDir } = generated()

    const legacy = readFileSync(join(outputDir, 'graph.json'), 'utf8')
    expect(legacy).not.toContain('MADAR_GRAPH_MOVED/')
    const parsed = JSON.parse(legacy) as { nodes?: unknown[]; links?: unknown[] }
    expect(Array.isArray(parsed.nodes)).toBe(true)
    expect(Array.isArray(parsed.links)).toBe(true)
  })

  it('does not perform the B2 cutover', () => {
    const { outputDir } = generated()

    // graph.v1.json is produced by the tombstone cutover, which B1 must not run.
    expect(existsSync(join(outputDir, 'graph.v1.json'))).toBe(false)
  })

  it('generates the mirror from the same run as the canonical artifact', () => {
    const { outputDir } = generated()

    const legacy = JSON.parse(readFileSync(join(outputDir, 'graph.json'), 'utf8')) as {
      nodes: { id: string }[]
    }
    const canonical = loadGraphArtifact(readFileSync(join(outputDir, 'graph.madar'))).graph

    // Same revision, so the node sets agree. A stale mirror would diverge here.
    expect(new Set(legacy.nodes.map((node) => node.id)))
      .toEqual(new Set(canonical.nodeIds()))
  })

  it('writes root_path only to the machine-local sidecar', () => {
    const { root, outputDir } = generated()

    const sidecar = JSON.parse(
      readFileSync(join(outputDir, GRAPH_LOCAL_SIDECAR_BASENAME), 'utf8'),
    ) as { root_path?: string }
    expect(sidecar.root_path).toBe(root)
    expect(readFileSync(join(outputDir, 'graph.madar'), 'utf8')).not.toContain('root_path')
  })

  it('leaves no staging file behind', () => {
    const { outputDir } = generated()

    expect(readdirSync(outputDir).filter((name) => name.includes('.publishing'))).toEqual([])
  })

  it('succeeds on a second generation over an activated workspace', () => {
    const { root, outputDir } = generated()

    expect(() => generateGraph(root, { noHtml: true })).not.toThrow()
    expect(existsSync(join(outputDir, 'graph.madar'))).toBe(true)
    expect(JSON.parse(readFileSync(join(outputDir, 'graph.json'), 'utf8'))).toHaveProperty('nodes')
  })
})

describe('B1 new-reader preference', () => {
  it('prefers graph.madar even when handed the legacy path', () => {
    const { outputDir } = generated()

    // Hand the reader graph.json while a valid canonical artifact exists. The
    // mirror cannot represent parallel facts, so settling for it would lose
    // relationships silently.
    writeFileSync(
      join(outputDir, 'graph.json'),
      JSON.stringify({ schema_version: 1, directed: true, nodes: [], links: [] }),
    )

    expect(loadGraph(join(outputDir, 'graph.json')).numberOfNodes()).toBeGreaterThan(0)
    expect(readGraphArtifactMetadata(join(outputDir, 'graph.json')).format).toBe('v2')
  })

  it('loads directly from the canonical path', () => {
    const { outputDir } = generated()

    expect(loadGraph(join(outputDir, 'graph.madar')).numberOfNodes()).toBeGreaterThan(0)
  })

  it('still reads a v1 workspace that has no canonical artifact', () => {
    const { outputDir } = generated()
    const legacyOnly = join(mkdtempSync(join(tmpdir(), 'madar-v1only-')), 'out')
    mkdirSync(legacyOnly, { recursive: true })
    writeFileSync(join(legacyOnly, 'graph.json'), readFileSync(join(outputDir, 'graph.json')))

    // No sibling graph.madar, so the preference must fall through to v1
    // rather than reporting the workspace as unreadable.
    const metadata = readGraphArtifactMetadata(join(legacyOnly, 'graph.json'))

    expect(metadata.format).toBe('v1')
    expect(metadata.nodeSourceFiles.length).toBeGreaterThan(0)
  })

  it('reports node source files from the nested v2 attribute level', () => {
    const { outputDir } = generated()

    // v2 nests producer attributes; reading the top level returned nothing and
    // silently emptied the freshness source-file set.
    expect(readGraphArtifactMetadata(join(outputDir, 'graph.madar')).nodeSourceFiles.length)
      .toBeGreaterThan(0)
  })

  it('exposes extractor provenance through the canonical artifact', () => {
    const { root, outputDir } = generated()
    const metadata = readGraphArtifactMetadata(join(outputDir, 'graph.madar'))

    expect(metadata.format).toBe('v2')
    expect(metadata.extractorVersion).not.toBeNull()
    expect(metadata.rootPath).toBe(root)
  })

  it('records zero unresolved admissions for a real corpus', () => {
    const { outputDir } = generated()

    expect(loadGraph(join(outputDir, 'graph.madar')).storageAdmissionSummary())
      .toEqual({ unresolvedUnregisteredRelationCandidates: 0, unregisteredRelationCounts: {} })
  })
})
