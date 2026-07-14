import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { createGenerationPolicy, parseGenerationPolicy } from '../../src/contracts/generation-policy.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { exclusionRulesFingerprint, readStoredGenerationPolicy } from '../../src/infrastructure/generation-policy.js'
import { loadManifestMetadata } from '../../src/pipeline/detect.js'
import { loadGraph } from '../../src/runtime/serve.js'

function withTempDir<T>(callback: (tempDir: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-generation-policy-'))
  try {
    return callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('generation policy contract', () => {
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
        includeDocs: false,
        noHtml: true,
        indexingStrict: { maxFailed: 1, maxUnsupported: 2 },
      })
      const rawGraph = JSON.parse(readFileSync(result.graphPath, 'utf8')) as { generation_policy?: unknown }
      const graphPolicy = parseGenerationPolicy(rawGraph.generation_policy)
      const manifestPolicy = loadManifestMetadata(join(result.outputDir, 'manifest.json')).generation_policy

      expect(graphPolicy).not.toBeNull()
      expect(manifestPolicy).toEqual(graphPolicy)
      expect(graphPolicy?.settings).toMatchObject({
        directed: false,
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

  test('forces a full rebuild when corpus policy or exclusion controls change', () => {
    withTempDir((tempDir) => {
      writeFileSync(join(tempDir, 'main.ts'), 'export const main = true\n', 'utf8')
      writeFileSync(join(tempDir, 'ignored.ts'), 'export const ignored = true\n', 'utf8')
      writeFileSync(join(tempDir, '.madarignore'), 'ignored.ts\n', 'utf8')
      generateGraph(tempDir, { includeDocs: false, noHtml: true })

      writeFileSync(join(tempDir, '.madarignore'), '', 'utf8')
      const exclusionsChanged = generateGraph(tempDir, { update: true, includeDocs: false, noHtml: true })
      expect(exclusionsChanged.notes.join('\n')).toContain('Generation policy changed')
      expect(exclusionsChanged.extractedFiles).toBe(2)

      writeFileSync(join(tempDir, 'README.md'), '# Included now\n', 'utf8')
      const documentsChanged = generateGraph(tempDir, { update: true, includeDocs: true, noHtml: true })
      expect(documentsChanged.notes.join('\n')).toContain('Generation policy changed')
      expect(documentsChanged.extractedFiles).toBe(3)
    })
  })
})
