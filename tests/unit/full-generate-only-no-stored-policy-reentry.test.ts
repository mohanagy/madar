import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { GRAPH_ARTIFACT_V2_HEADER } from '../../src/contracts/graph-artifact.js'

/**
 * #722 FULL_GENERATE_ONLY_V1 — the stored generation policy must never re-enter
 * ordinary full generation.
 *
 * PREQUAL occurrence 1 reproduced the defect this owns: a warm ordinary
 * generation called readGraphGenerationPolicy exactly once, so full generation
 * consumed a persisted semantic result. Generation options must come from the
 * current run -- explicit options, supported configuration, defaults -- never
 * from a prior artifact.
 *
 * The stored policy is NOT tampered with. Its fingerprint self-validates against
 * its settings, so a hand-edited policy reads back as null, and "generation
 * ignored it" would then be true because it was unreadable rather than because
 * generation refused to read it. Instead the prior run is given materially
 * different options, which produces a genuine, genuinely readable stored policy
 * that disagrees with the current run.
 */

const FIXED_CLOCK = new Date('2026-01-01T00:00:00.000Z')

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'madar-722-policy-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"fx","type":"module"}\n')
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true },
  }))
  writeFileSync(join(dir, 'src/a.ts'), 'export const alpha = 1\nexport function realSymbol(){return alpha}\n')
  writeFileSync(join(dir, 'src/b.ts'), 'import { realSymbol } from "./a.js"\nexport const beta = realSymbol()\n')
  writeFileSync(join(dir, 'README.md'), '# Doc corpus marker\n')
  return dir
}

function payloadOf(graphPath: string): Record<string, unknown> {
  const raw = readFileSync(graphPath, 'utf8')
  return JSON.parse(raw.slice(GRAPH_ARTIFACT_V2_HEADER.length)) as Record<string, unknown>
}

function publishedPolicySettings(graphPath: string): Record<string, unknown> {
  const provenance = payloadOf(graphPath).provenance as { generation_policy?: { settings?: Record<string, unknown> } }
  return provenance?.generation_policy?.settings ?? {}
}

function documentNodeCount(graphPath: string): number {
  const nodes = payloadOf(graphPath).nodes as { attributes?: Record<string, unknown> }[]
  return nodes.filter((n) => n.attributes?.file_type === 'document').length
}

/** Canonical payload with run-varying provenance removed, so bytes are comparable. */
function semanticDigest(graphPath: string): string {
  const payload = payloadOf(graphPath)
  delete payload.provenance
  delete payload.generated_at
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

describe('FULL-GENERATE-ONLY no stored-policy re-entry', () => {
  afterEach(() => { vi.useRealTimers(); vi.resetModules() })

  test('precondition: a prior run leaves a genuinely readable stored policy that disagrees with the next run', async () => {
    const dir = fixture()
    const { generateGraph } = await import('../../src/infrastructure/generate.js')
    const { readGraphGenerationPolicy } = await import('../../src/infrastructure/generation-policy.js')

    const priorRun = generateGraph(dir, { extractionMode: 'legacy', noHtml: true, includeDocs: false })
    const stored = readGraphGenerationPolicy(priorRun.graphPath)

    // If this were unreadable, every assertion below would pass for the wrong reason.
    expect(stored, 'STORED_POLICY_NOT_READABLE').not.toBeNull()
    expect(stored?.settings.include_documents, 'STORED_POLICY_DOES_NOT_DISAGREE').toBe(false)
  })

  test('ordinary generation calls no persisted semantic reader, cold or warm', async () => {
    const dir = fixture()
    const counts = { graphPolicy: 0, storedPolicy: 0, indexingManifest: 0, loadGraph: 0, cachedExtraction: 0 }

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

    try {
      const { generateGraph } = await import('../../src/infrastructure/generate.js')

      const cold = generateGraph(dir, { extractionMode: 'legacy', noHtml: true, includeDocs: false })
      const coldCounts = { ...counts }
      expect(cold.extractedFiles, 'COLD_DID_NOT_EXTRACT').toBeGreaterThan(0)
      // Both runs publish to the same path, so the cold values must be read now.
      const coldDocs = publishedPolicySettings(cold.graphPath).include_documents
      const coldDocNodes = documentNodeCount(cold.graphPath)

      for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] = 0

      // Warm, and with options that DISAGREE with the stored policy.
      const warm = generateGraph(dir, { extractionMode: 'legacy', noHtml: true, includeDocs: true })
      const warmCounts = { ...counts }
      expect(warm.extractedFiles, 'WARM_DID_NOT_RE_EXTRACT').toBeGreaterThan(0)

      for (const [label, c] of [['cold', coldCounts], ['warm', warmCounts]] as const) {
        expect(c.graphPolicy, `STORED_GENERATION_POLICY_REENTERED_FULL_GENERATION (${label})`).toBe(0)
        expect(c.storedPolicy, `STORED_GENERATION_POLICY_REENTERED_FULL_GENERATION (${label})`).toBe(0)
        expect(c.indexingManifest, `INDEXING_MANIFEST_REENTERED_FULL_GENERATION (${label})`).toBe(0)
        expect(c.loadGraph, `PRIOR_GRAPH_LOADED_FOR_CONTINUATION (${label})`).toBe(0)
        expect(c.cachedExtraction, `EXTRACTION_CACHE_REENTERED_FULL_GENERATION (${label})`).toBe(0)
      }

      // The current run's options must have decided the corpus, not the stored ones.
      expect(documentNodeCount(warm.graphPath), 'STORED_POLICY_DECIDED_THE_CORPUS').toBeGreaterThan(0)
      // The republished policy must describe THIS run, not the prior one.
      expect(coldDocs, 'COLD_POLICY_WRONG').toBe(false)
      expect(coldDocNodes, 'COLD_CORPUS_WRONG').toBe(0)
      expect(publishedPolicySettings(warm.graphPath).include_documents, 'STORED_POLICY_WAS_REPUBLISHED').toBe(true)
    } finally {
      for (const m of ['../../src/infrastructure/generation-policy.js', '../../src/infrastructure/indexing-manifest.js',
                       '../../src/runtime/serve.js', '../../src/pipeline/extract.js']) vi.doUnmock(m)
      vi.resetModules()
    }
  })

  test('the same options produce the same semantic digest warm as cold, under a fixed clock', async () => {
    // One workspace: absolute source paths are embedded in the artifact, so two
    // directories can never be byte-comparable.
    const dir = fixture()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(FIXED_CLOCK)
    try {
      const { generateGraph } = await import('../../src/infrastructure/generate.js')
      const first = generateGraph(dir, { extractionMode: 'legacy', noHtml: true })
      const second = generateGraph(dir, { extractionMode: 'legacy', noHtml: true })
      expect(semanticDigest(second.graphPath), 'WARM_RUN_DIVERGED_FROM_COLD').toBe(semanticDigest(first.graphPath))
    } finally {
      vi.useRealTimers()
    }
  })
})
