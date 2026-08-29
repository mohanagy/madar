import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { GRAPH_ARTIFACT_V2_HEADER } from '../../src/contracts/graph-artifact.js'
import { writeBinaryIngestSidecar, readBinaryIngestSidecar } from '../../src/shared/binary-ingest-sidecar.js'

/**
 * #722 FULL_GENERATE_ONLY_V1 — a machine-local sidecar is not a generation input.
 *
 * PREQUAL occurrence 1: binary extraction read `.<asset>.madar-ingest.json` and
 * spread its contents into the generated file node, so persisted sidecar content
 * became graph content. The sidecar may be read by supported diagnostics and
 * written after a successful generation; it may not feed generation.
 */

const POISON_URL = 'https://madar-722-sidecar-poison.invalid/asset.png'
const POISON_CONTRIBUTOR = 'MADAR-722-SIDECAR-POISON-CONTRIBUTOR'

/** A one-pixel PNG, so the asset is a real binary the pipeline will classify. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function fixture(withSidecar: boolean): { dir: string; asset: string } {
  const dir = mkdtempSync(join(tmpdir(), 'madar-722-sidecar-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"fx","type":"module"}\n')
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true },
  }))
  writeFileSync(join(dir, 'src/a.ts'), 'export const alpha = 1\n')
  const asset = join(dir, 'assets', 'poison.png')
  writeFileSync(asset, PNG)
  if (withSidecar) {
    writeBinaryIngestSidecar(asset, {
      source_url: POISON_URL,
      captured_at: '2026-01-01T00:00:00.000Z',
      contributor: POISON_CONTRIBUTOR,
      ingest_url_type: 'image',
    })
  }
  return { dir, asset }
}

function artifactText(graphPath: string): string {
  return readFileSync(graphPath, 'utf8')
}

function nodeCount(graphPath: string): number {
  const raw = artifactText(graphPath)
  const payload = JSON.parse(raw.slice(GRAPH_ARTIFACT_V2_HEADER.length)) as { nodes: unknown[] }
  return payload.nodes.length
}

describe('FULL-GENERATE-ONLY no machine-local sidecar input', () => {
  afterEach(() => { vi.resetModules() })

  test('precondition: the real sidecar reader loads the poisoned marker', () => {
    const { asset } = fixture(true)
    const loaded = readBinaryIngestSidecar(asset)
    // Without this, "generation ignored the sidecar" would be true because the
    // sidecar was unreadable rather than because generation refused to read it.
    expect(loaded, 'SIDECAR_NOT_READABLE').not.toBeNull()
    expect(loaded?.source_url, 'SIDECAR_NOT_READABLE').toBe(POISON_URL)
    expect(loaded?.contributor, 'SIDECAR_NOT_READABLE').toBe(POISON_CONTRIBUTOR)
  })

  test('ordinary generation calls no sidecar reader and admits no sidecar content', async () => {
    const { dir, asset } = fixture(true)
    let sidecarReads = 0

    vi.resetModules()
    const actual = await vi.importActual<typeof import('../../src/shared/binary-ingest-sidecar.js')>(
      '../../src/shared/binary-ingest-sidecar.js',
    )
    vi.doMock('../../src/shared/binary-ingest-sidecar.js', () => ({
      ...actual,
      readBinaryIngestSidecar: (...a: Parameters<typeof actual.readBinaryIngestSidecar>) => {
        sidecarReads += 1
        return actual.readBinaryIngestSidecar(...a)
      },
    }))

    try {
      const { generateGraph } = await import('../../src/infrastructure/generate.js')
      const result = generateGraph(dir, { extractionMode: 'legacy', noHtml: true, includeDocs: true })

      expect(sidecarReads, 'MACHINE_LOCAL_SIDECAR_REENTERED_GENERATION').toBe(0)

      const text = artifactText(result.graphPath)
      expect(text.includes(POISON_URL), 'MACHINE_LOCAL_SIDECAR_REENTERED_GENERATION').toBe(false)
      expect(text.includes(POISON_CONTRIBUTOR), 'MACHINE_LOCAL_SIDECAR_REENTERED_GENERATION').toBe(false)

      // The sidecar file itself must be untouched by generation.
      expect(readBinaryIngestSidecar(asset)?.source_url, 'GENERATION_MODIFIED_THE_SIDECAR').toBe(POISON_URL)
    } finally {
      vi.doUnmock('../../src/shared/binary-ingest-sidecar.js')
      vi.resetModules()
    }
  })

  test('a sidecar cannot change graph totals', async () => {
    const withSidecar = fixture(true)
    const without = fixture(false)
    const { generateGraph } = await import('../../src/infrastructure/generate.js')
    const a = generateGraph(withSidecar.dir, { extractionMode: 'legacy', noHtml: true, includeDocs: true })
    const b = generateGraph(without.dir, { extractionMode: 'legacy', noHtml: true, includeDocs: true })
    expect(nodeCount(a.graphPath), 'SIDECAR_CHANGED_GRAPH_TOTALS').toBe(nodeCount(b.graphPath))
  })
})
