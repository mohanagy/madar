import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  createGenerationPolicy,
  parseGenerationPolicy,
  type GenerationPolicyV2,
} from '../../src/contracts/generation-policy.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import {
  buildGenerationPolicy,
  exclusionRulesFingerprint,
  generationOptionsFromPolicy,
  readStoredGenerationPolicy,
  resolveExtractionMode,
} from '../../src/infrastructure/generation-policy.js'
import { loadManifestMetadata } from '../../src/pipeline/detect.js'
import { loadGraph } from '../../src/runtime/serve.js'
import { readGeneratedGraphJson } from './helpers/generated-graph.js'

function withTempDir<T>(callback: (tempDir: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-generation-policy-'))
  try {
    return callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('generation policy contract', () => {
  test('defaults programmatic extraction to auto while preserving explicit compatibility settings', () => {
    expect(resolveExtractionMode({})).toBe('auto')
    expect(resolveExtractionMode({ useSpi: false })).toBe('legacy')
    expect(resolveExtractionMode({ useSpi: true })).toBe('spi')
    expect(resolveExtractionMode({ extractionMode: 'auto', useSpi: false })).toBe('auto')
    expect(resolveExtractionMode({ extractionMode: 'legacy', useSpi: true })).toBe('legacy')
  })

  test('has a stable authenticated fingerprint and rejects tampering', () => {
    const policy = createGenerationPolicy({
      directed: true,
      use_spi: false,
      respect_gitignore: false,
      follow_symlinks: false,
      include_documents: false,
      include_non_code: true,
      extractor_cache_version: 68,
      exclusion_rules_fingerprint: 'a'.repeat(64),
      indexing_strict: { max_failed: 0, max_unsupported: 2 },
    })

    expect(createGenerationPolicy(policy.settings)).toEqual(policy)
    expect(parseGenerationPolicy(policy)).toEqual(policy)
    expect(parseGenerationPolicy({
      ...policy,
      settings: { ...policy.settings, include_documents: true },
    })).toBeNull()
    expect(parseGenerationPolicy({
      ...policy,
      settings: { ...policy.settings, extraction_mode: 'auto' },
    })).toBeNull()
  })

  test('records the explicit v2 extraction mode and reads v1 policies as strict modes', () => {
    const legacyV1 = createGenerationPolicy({
      directed: true,
      use_spi: true,
      respect_gitignore: false,
      follow_symlinks: false,
      include_documents: true,
      include_non_code: true,
      extractor_cache_version: 68,
      exclusion_rules_fingerprint: 'b'.repeat(64),
      indexing_strict: null,
    })
    const autoV2 = buildGenerationPolicy('/workspace', {
      extractionMode: 'auto',
    }, 68, null)
    const inferredV2: GenerationPolicyV2 = createGenerationPolicy(autoV2.settings)

    expect(legacyV1.version).toBe(1)
    expect(generationOptionsFromPolicy(legacyV1)).toMatchObject({ extractionMode: 'spi' })
    expect(autoV2).toMatchObject({
      version: 2,
      settings: {
        extraction_mode: 'auto',
        use_spi: true,
      },
    })
    expect(parseGenerationPolicy(autoV2)).toEqual(autoV2)
    expect(inferredV2).toEqual(autoV2)
  })

  test('fingerprints Madar and Git exclusion controls without persisting their contents', () => {
    withTempDir((tempDir) => {
      execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' })
      writeFileSync(join(tempDir, '.madarignore'), 'private/**\n', 'utf8')
      writeFileSync(join(tempDir, '.gitignore'), 'generated/**\n', 'utf8')
      const visible = [join(tempDir, '.gitignore')]
      const before = exclusionRulesFingerprint(tempDir, true, visible)

      writeFileSync(join(tempDir, '.gitignore'), 'generated/**\ncache/**\n', 'utf8')
      const after = exclusionRulesFingerprint(tempDir, true, visible)

      expect(before).toMatch(/^[a-f0-9]{64}$/)
      expect(after).toMatch(/^[a-f0-9]{64}$/)
      expect(after).not.toBe(before)
      expect(after).not.toContain('cache')
    })
  })

  test('publishes the same versioned policy in graph and source manifest', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export const value = 1\n', 'utf8')
      const result = generateGraph(tempDir, {
        directed: false,
        extractionMode: 'auto',
        includeDocs: false,
        noHtml: true,
        indexingStrict: { maxFailed: 1, maxUnsupported: 2 },
      })
      const rawGraph = readGeneratedGraphJson(result.graphPath) as { generation_policy?: unknown }
      const graphPolicy = parseGenerationPolicy(rawGraph.generation_policy)
      const manifestPolicy = loadManifestMetadata(join(result.outputDir, 'manifest.json')).generation_policy

      expect(graphPolicy).not.toBeNull()
      expect(manifestPolicy).toEqual(graphPolicy)
      expect(graphPolicy?.settings).toMatchObject({
        directed: false,
        extraction_mode: 'auto',
        include_documents: false,
        indexing_strict: { max_failed: 1, max_unsupported: 2 },
      })
      expect(loadGraph(result.graphPath).graph.generation_policy).toEqual(graphPolicy)
      expect(readStoredGenerationPolicy(result.graphPath, join(result.outputDir, 'manifest.json'))).toEqual(graphPolicy)

      const manifestPath = join(result.outputDir, 'manifest.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { __madar_meta__?: { generation_policy?: unknown } }
      if (manifest.__madar_meta__) {
        delete manifest.__madar_meta__.generation_policy
      }
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      expect(readStoredGenerationPolicy(result.graphPath, manifestPath)).toBeNull()
    })
  })

  /**
   * #722 FULL_GENERATE_ONLY_V1. This used to assert the "Generation policy
   * changed" note, which announced an incremental run deciding to rebuild.
   * Every run is now a full generation, so there is no such transition to
   * announce and the note was retired with the `--update` continuation.
   *
   * The substantive behaviour is unchanged and is what is asserted now:
   * exclusion and document-inclusion controls decide the corpus. Membership is
   * a stronger assertion than the old extracted-file counts, which were
   * artifacts of what the incremental path happened to re-extract.
   */
  test('corpus policy and exclusion controls decide what a full generation covers', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export const main = true\n', 'utf8')
      writeFileSync(join(tempDir, 'ignored.ts'), 'export const ignored = true\n', 'utf8')
      writeFileSync(join(tempDir, '.madarignore'), 'ignored.ts\n', 'utf8')

      const excluded = generateGraph(tempDir, { includeDocs: false, noHtml: true })
      const excludedFiles = readGeneratedGraphJson(excluded.graphPath).nodes
        .map((node) => String(node.source_file ?? ''))
      expect(excludedFiles.some((file) => file.endsWith('ignored.ts')), 'EXCLUSION_NOT_APPLIED').toBe(false)
      expect(excludedFiles.some((file) => file.endsWith('main.ts'))).toBe(true)

      // Removing the exclusion must bring the file into the corpus.
      writeFileSync(join(tempDir, '.madarignore'), '', 'utf8')
      const included = generateGraph(tempDir, { update: true, includeDocs: false, noHtml: true })
      expect(included.mode, 'UPDATE_DID_NOT_ROUTE_TO_FULL_GENERATION').toBe('generate')
      expect(included.notes.join('\n'), 'CONTINUATION_NOTE_RESURFACED').not.toContain('Generation policy changed')
      const includedFiles = readGeneratedGraphJson(included.graphPath).nodes
        .map((node) => String(node.source_file ?? ''))
      expect(includedFiles.some((file) => file.endsWith('ignored.ts')), 'EXCLUSION_CHANGE_IGNORED').toBe(true)

      // Document inclusion is the same kind of control over the same corpus.
      writeFileSync(join(tempDir, 'README.md'), '# Included now\n', 'utf8')
      const withDocs = generateGraph(tempDir, { update: true, includeDocs: true, noHtml: true })
      const withDocsFiles = readGeneratedGraphJson(withDocs.graphPath).nodes
        .map((node) => String(node.source_file ?? ''))
      expect(withDocsFiles.some((file) => file.endsWith('README.md')), 'DOCUMENT_POLICY_IGNORED').toBe(true)
    })
  })
})
