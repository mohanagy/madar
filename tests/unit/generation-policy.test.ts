import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  CANONICAL_INDEX_FORMAT_VERSION,
  createGenerationPolicy,
  GENERATION_POLICY_VERSION,
  parseGenerationPolicy,
} from '../../src/contracts/generation-policy.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import {
  buildGenerationPolicy,
  exclusionRulesFingerprint,
  generationOptionsFromPolicy,
  readStoredGenerationPolicy,
} from '../../src/infrastructure/generation-policy.js'
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

describe('canonical generation policy contract', () => {
  test('has a stable authenticated fingerprint and rejects tampering or retired fields', () => {
    const policy = createGenerationPolicy({
      index_format_version: CANONICAL_INDEX_FORMAT_VERSION,
      respect_gitignore: false,
      follow_symlinks: false,
      exclusion_rules_fingerprint: 'a'.repeat(64),
      indexing_strict: { max_failed: 0, max_unsupported: 2 },
    })

    expect(policy.version).toBe(GENERATION_POLICY_VERSION)
    expect(createGenerationPolicy(policy.settings)).toEqual(policy)
    expect(parseGenerationPolicy(policy)).toEqual(policy)
    expect(parseGenerationPolicy({
      ...policy,
      settings: { ...policy.settings, follow_symlinks: true },
    })).toBeNull()
    expect(parseGenerationPolicy({
      ...policy,
      settings: { ...policy.settings, extraction_mode: 'auto' },
    })).toBeNull()
  })

  test('builds and restores only canonical corpus controls', () => {
    const policy = buildGenerationPolicy('/workspace', {
      respectGitignore: true,
      followSymlinks: true,
      indexingStrict: { maxFailed: 1, maxUnsupported: 2 },
    }, null)

    expect(policy.settings).toMatchObject({
      index_format_version: CANONICAL_INDEX_FORMAT_VERSION,
      respect_gitignore: true,
      follow_symlinks: true,
      indexing_strict: { max_failed: 1, max_unsupported: 2 },
    })
    expect(generationOptionsFromPolicy(policy)).toEqual({
      respectGitignore: true,
      followSymlinks: true,
      indexingStrict: { maxFailed: 1, maxUnsupported: 2 },
    })
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
        indexingStrict: { maxFailed: 1, maxUnsupported: 2 },
      })
      const graphPolicy = parseGenerationPolicy(loadGraph(result.graphPath).graph.generation_policy)
      const manifestPath = join(result.outputDir, 'manifest.json')
      const manifestPolicy = loadManifestMetadata(manifestPath).generation_policy

      expect(graphPolicy).not.toBeNull()
      expect(manifestPolicy).toEqual(graphPolicy)
      expect(graphPolicy?.settings).toMatchObject({
        index_format_version: CANONICAL_INDEX_FORMAT_VERSION,
        indexing_strict: { max_failed: 1, max_unsupported: 2 },
      })
      expect(readStoredGenerationPolicy(result.graphPath, manifestPath)).toEqual(graphPolicy)

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        __madar_meta__?: { generation_policy?: unknown }
      }
      if (manifest.__madar_meta__) delete manifest.__madar_meta__.generation_policy
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      expect(readStoredGenerationPolicy(result.graphPath, manifestPath)).toBeNull()
    })
  })
})
