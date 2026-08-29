import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { GRAPH_ARTIFACT_V2_HEADER } from '../../src/contracts/graph-artifact.js'
import { UPDATE_SATISFIED_BY_FULL_REGENERATION_NOTE } from '../../src/infrastructure/generate.js'

/**
 * #722 FULL_GENERATE_ONLY_V1 — `--update` is a compatibility alias for ordinary
 * full regeneration.
 *
 * It does not refuse and it does not continue from persisted semantics. It must
 * invoke the one supported owner exactly once, succeed, report mode `generate`,
 * say plainly that the update was satisfied by full regeneration, and make no
 * incremental-reuse or changed-file-only claim.
 */

const FIXED_CLOCK = new Date('2026-01-01T00:00:00.000Z')

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'madar-722-update-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"fx","type":"module"}\n')
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true },
  }))
  writeFileSync(join(dir, 'src/a.ts'), 'export const alpha = 1\nexport function realSymbol(){return alpha}\n')
  writeFileSync(join(dir, 'src/b.ts'), 'import { realSymbol } from "./a.js"\nexport const beta = realSymbol()\n')
  return dir
}

function semanticDigest(graphPath: string): string {
  const raw = readFileSync(graphPath, 'utf8')
  const payload = JSON.parse(raw.slice(GRAPH_ARTIFACT_V2_HEADER.length)) as Record<string, unknown>
  delete payload.provenance
  delete payload.generated_at
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/** Claims that would be false under full regeneration. */
const INCREMENTAL_CLAIMS = [
  /incremental update re-extracted/i,
  /reused the existing graph/i,
  /no changed files detected/i,
  /retained \d+ unchanged file/i,
  /changed file\(s\) were included during --update/i,
  /generation policy changed/i,
  /re-clustered the existing graph/i,
]

describe('FULL-GENERATE-ONLY --update is a full-regeneration alias', () => {
  afterEach(() => { vi.useRealTimers(); vi.resetModules() })

  test('succeeds, reports mode generate, and states how it was satisfied', async () => {
    const dir = fixture()
    const { generateGraph } = await import('../../src/infrastructure/generate.js')
    generateGraph(dir, { extractionMode: 'legacy', noHtml: true })
    const updated = generateGraph(dir, { extractionMode: 'legacy', noHtml: true, update: true })

    expect(updated.mode, 'UPDATE_DID_NOT_REPORT_GENERATE').toBe('generate')
    expect(updated.notes.join('\n'), 'UPDATE_DID_NOT_STATE_FULL_REGENERATION')
      .toContain(UPDATE_SATISFIED_BY_FULL_REGENERATION_NOTE)
    expect(updated.extractedFiles, 'UPDATE_DID_NOT_RE_EXTRACT_THE_CORPUS').toBeGreaterThan(0)

    const joined = updated.notes.join('\n')
    for (const claim of INCREMENTAL_CLAIMS) {
      expect(joined, `UPDATE_MADE_AN_INCREMENTAL_CLAIM: ${claim}`).not.toMatch(claim)
    }
  })

  test('reads no persisted semantic state', async () => {
    const dir = fixture()
    const counts = { graphPolicy: 0, storedPolicy: 0, indexingManifest: 0, loadGraph: 0, cachedExtraction: 0, sidecar: 0 }

    vi.resetModules()
    const pol = await vi.importActual<typeof import('../../src/infrastructure/generation-policy.js')>('../../src/infrastructure/generation-policy.js')
    vi.doMock('../../src/infrastructure/generation-policy.js', () => ({
      ...pol,
      readGraphGenerationPolicy: (...a: Parameters<typeof pol.readGraphGenerationPolicy>) => { counts.graphPolicy += 1; return pol.readGraphGenerationPolicy(...a) },
      readStoredGenerationPolicy: (...a: Parameters<typeof pol.readStoredGenerationPolicy>) => { counts.storedPolicy += 1; return pol.readStoredGenerationPolicy(...a) },
    }))
    const man = await vi.importActual<typeof import('../../src/infrastructure/indexing-manifest.js')>('../../src/infrastructure/indexing-manifest.js')
    vi.doMock('../../src/infrastructure/indexing-manifest.js', () => ({
      ...man,
      readIndexingManifestForGraph: (...a: Parameters<typeof man.readIndexingManifestForGraph>) => { counts.indexingManifest += 1; return man.readIndexingManifestForGraph(...a) },
    }))
    const serve = await vi.importActual<typeof import('../../src/runtime/serve.js')>('../../src/runtime/serve.js')
    vi.doMock('../../src/runtime/serve.js', () => ({
      ...serve,
      loadGraph: (...a: Parameters<typeof serve.loadGraph>) => { counts.loadGraph += 1; return serve.loadGraph(...a) },
    }))
    const ext = await vi.importActual<typeof import('../../src/pipeline/extract.js')>('../../src/pipeline/extract.js')
    vi.doMock('../../src/pipeline/extract.js', () => ({
      ...ext,
      readCachedExtraction: (...a: Parameters<typeof ext.readCachedExtraction>) => { counts.cachedExtraction += 1; return ext.readCachedExtraction(...a) },
    }))
    const sc = await vi.importActual<typeof import('../../src/shared/binary-ingest-sidecar.js')>('../../src/shared/binary-ingest-sidecar.js')
    vi.doMock('../../src/shared/binary-ingest-sidecar.js', () => ({
      ...sc,
      readBinaryIngestSidecar: (...a: Parameters<typeof sc.readBinaryIngestSidecar>) => { counts.sidecar += 1; return sc.readBinaryIngestSidecar(...a) },
    }))

    try {
      const { generateGraph } = await import('../../src/infrastructure/generate.js')
      generateGraph(dir, { extractionMode: 'legacy', noHtml: true })
      for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] = 0
      generateGraph(dir, { extractionMode: 'legacy', noHtml: true, update: true })

      for (const [k, v] of Object.entries(counts)) {
        expect(v, `UPDATE_USED_PERSISTED_SEMANTIC_STATE (${k})`).toBe(0)
      }
    } finally {
      for (const m of ['../../src/infrastructure/generation-policy.js', '../../src/infrastructure/indexing-manifest.js',
                       '../../src/runtime/serve.js', '../../src/pipeline/extract.js',
                       '../../src/shared/binary-ingest-sidecar.js']) vi.doUnmock(m)
      vi.resetModules()
    }
  })

  test('produces the same semantic digest as plain generate under a fixed clock', async () => {
    const dir = fixture()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(FIXED_CLOCK)
    try {
      const { generateGraph } = await import('../../src/infrastructure/generate.js')
      const plain = generateGraph(dir, { extractionMode: 'legacy', noHtml: true })
      const plainDigest = semanticDigest(plain.graphPath)
      const updated = generateGraph(dir, { extractionMode: 'legacy', noHtml: true, update: true })
      expect(semanticDigest(updated.graphPath), 'UPDATE_DIVERGED_FROM_PLAIN_GENERATION').toBe(plainDigest)
    } finally {
      vi.useRealTimers()
    }
  })

  test('--update and --cluster-only together is still a usage error', async () => {
    const dir = fixture()
    const { generateGraph } = await import('../../src/infrastructure/generate.js')
    expect(() => generateGraph(dir, { update: true, clusterOnly: true })).toThrow(/cannot be used together/i)
  })
})
