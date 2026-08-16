import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  GRAPH_ARTIFACT_V2_HEADER,
  GRAPH_ARTIFACT_V2_TOMBSTONE,
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

describe('cutover generation', () => {
  it('writes graph.madar as the canonical v2 artifact', () => {
    const { outputDir } = generated()
    const artifact = join(outputDir, 'graph.madar')

    expect(existsSync(artifact)).toBe(true)
    expect(readFileSync(artifact).subarray(0, GRAPH_ARTIFACT_V2_HEADER.length).toString('utf8'))
      .toBe(GRAPH_ARTIFACT_V2_HEADER)
  })

  it('leaves graph.json as the exact tombstone, not a v1 mirror', () => {
    const { outputDir } = generated()

    // Inverted at the cutover: B1 kept a fresh v1 mirror here so old readers
    // kept working. #705 ends that, and the byte-exact tombstone is what makes
    // an old reader fail closed instead of silently reading a stale graph.
    expect(readFileSync(join(outputDir, 'graph.json'), 'utf8'))
      .toBe(GRAPH_ARTIFACT_V2_TOMBSTONE)
  })

  it('creates no v1 backup for a workspace that never had one', () => {
    const { outputDir } = generated()

    // graph.v1.json preserves a *prior* v1 artifact. A fresh project has none,
    // so inventing one would fabricate rollback evidence.
    expect(existsSync(join(outputDir, 'graph.v1.json'))).toBe(false)
  })

  it('preserves a prior v1 artifact byte-for-byte on first cutover', () => {
    const root = project()
    const outputDir = join(root, 'out')
    mkdirSync(outputDir, { recursive: true })
    const priorV1 = JSON.stringify({ schema_version: 1, directed: true, nodes: [{ id: 'prior' }], links: [] })
    writeFileSync(join(outputDir, 'graph.json'), priorV1)

    generateGraph(root, { noHtml: true })

    expect(readFileSync(join(outputDir, 'graph.v1.json'), 'utf8')).toBe(priorV1)
    expect(readFileSync(join(outputDir, 'graph.json'), 'utf8')).toBe(GRAPH_ARTIFACT_V2_TOMBSTONE)
  })

  it('does not overwrite the preserved backup on a later generation', () => {
    const root = project()
    const outputDir = join(root, 'out')
    mkdirSync(outputDir, { recursive: true })
    const priorV1 = JSON.stringify({ schema_version: 1, directed: true, nodes: [{ id: 'prior' }], links: [] })
    writeFileSync(join(outputDir, 'graph.json'), priorV1)

    generateGraph(root, { noHtml: true })
    generateGraph(root, { noHtml: true })
    generateGraph(root, { noHtml: true })

    // The backup is the only copy of what the workspace had before the
    // cutover. Re-running generation must never disturb it.
    expect(readFileSync(join(outputDir, 'graph.v1.json'), 'utf8')).toBe(priorV1)
  })

  it('writes root_path only to the machine-local sidecar', () => {
    const { root, outputDir } = generated()

    const sidecar = JSON.parse(
      readFileSync(join(outputDir, GRAPH_LOCAL_SIDECAR_BASENAME), 'utf8'),
    ) as { root_path?: string }
    expect(sidecar.root_path).toBe(root)
    expect(readFileSync(join(outputDir, 'graph.madar'), 'utf8')).not.toContain('root_path')
  })

  it('carries extraction provenance that only the v1 mirror used to expose', () => {
    const { outputDir } = generated()

    const raw = readFileSync(join(outputDir, 'graph.madar'), 'utf8')
    const payload = JSON.parse(raw.slice(GRAPH_ARTIFACT_V2_HEADER.length)) as {
      provenance?: Record<string, unknown>
    }

    // v2 provenance omitted these while graph.json was still a live mirror, so
    // readers kept getting them from the mirror and the gap stayed invisible.
    // The canonical artifact is now the only published graph; without these a
    // generated graph cannot be audited for how it was extracted.
    expect(payload.provenance?.extraction_receipt).toBeDefined()
    expect(payload.provenance?.indexing_completeness).toBeDefined()
    expect(payload.provenance?.discovery_safety).toBeDefined()
    expect(payload.provenance?.generation_policy).toBeDefined()
  })

  it('leaves no staging file behind', () => {
    const { outputDir } = generated()

    expect(readdirSync(outputDir).filter((name) => name.includes('.publishing'))).toEqual([])
  })

  it('is repeatable over an already-cut-over workspace', () => {
    const { root, outputDir } = generated()

    // The second run reads a tombstone where the first read a real v1. It must
    // recognize that as "already cut over" rather than treating the tombstone
    // as a legacy artifact worth preserving.
    expect(() => generateGraph(root, { noHtml: true })).not.toThrow()
    expect(existsSync(join(outputDir, 'graph.madar'))).toBe(true)
    expect(readFileSync(join(outputDir, 'graph.json'), 'utf8')).toBe(GRAPH_ARTIFACT_V2_TOMBSTONE)
    expect(existsSync(join(outputDir, 'graph.v1.json'))).toBe(false)
  })
})

describe('new-reader preference', () => {
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
    const legacyOnly = join(mkdtempSync(join(tmpdir(), 'madar-v1only-')), 'out')
    mkdirSync(legacyOnly, { recursive: true })
    // Written directly rather than copied from a generated workspace: after the
    // cutover that source is a tombstone, which is the moved state, not a
    // pre-cutover v1 workspace.
    writeFileSync(
      join(legacyOnly, 'graph.json'),
      JSON.stringify({
        schema_version: 1,
        directed: true,
        nodes: [{ id: 'service', source_file: 'src/service.ts' }],
        links: [],
      }),
    )

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
