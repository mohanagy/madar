import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { IndexingOutcome } from '../../src/contracts/indexing.js'
import { cacheDir, fileHash } from '../../src/infrastructure/cache.js'
import {
  parseIndexingManifest,
  relevantIndexingUncertainty,
} from '../../src/infrastructure/indexing-manifest.js'
import {
  localExtractionIndexingOutcome,
  projectSpiIndexingOutcomes,
  retainedIndexingOutcomes,
} from '../../src/pipeline/indexing-generation.js'
import {
  readCachedExtraction,
  writeCachedExtraction,
} from '../../src/pipeline/extract.js'
import {
  createIndexingManifest,
  indexingStrictViolations,
  shareSafeIndexingManifest,
} from '../../src/pipeline/indexing-outcomes.js'
import type { BuildSpiCachedResult } from '../../src/pipeline/spi/cache.js'

function outcome(overrides: Partial<IndexingOutcome> = {}): IndexingOutcome {
  return {
    path: 'src/index.ts',
    kind: 'file',
    status: 'indexed',
    reason: 'indexed',
    capability: 'builtin:extract:typescript',
    ...overrides,
  }
}

function spiResult(overrides: Partial<BuildSpiCachedResult['spi']> = {}): BuildSpiCachedResult {
  return {
    spi: {
      version: 1,
      generated_at: '2026-07-15T00:00:00.000Z',
      workspace: {
        root: '/repo',
        fingerprint: 'fixture',
        extractor_version: 'fixture',
        madar_version: 'fixture',
      },
      files: [
        { id: 'file:src/index.ts', path: 'src/index.ts', language: 'typescript', loc: 1, hash: 'a' },
      ],
      symbols: [],
      edges: [],
      diagnostics: [],
      ...overrides,
    },
    cache: {
      hit: false,
      reason: 'no-cache',
      file_count: 1,
      cache_key: 'fixture',
      duration_ms: 1,
    },
  }
}

describe('indexing completeness manifests', () => {
  it('deduplicates terminal outcomes, keeps diagnostics, and summarizes partial success', () => {
    const manifest = createIndexingManifest({
      now: new Date('2026-07-15T00:00:00.000Z'),
      outcomes: [
        outcome(),
        outcome({
          status: 'indexed_with_warnings',
          reason: 'parser_fallback',
          diagnostics: [{ code: 'parser_fallback', level: 'warning', message: 'local parser detail' }],
        }),
        outcome({
          path: 'src/legacy.vue',
          status: 'unsupported',
          reason: 'unsupported_file_type',
          capability: null,
        }),
        outcome({
          path: '.private',
          kind: 'directory',
          status: 'skipped_by_policy',
          reason: 'hidden_path',
          capability: null,
        }),
      ],
    })

    expect(manifest.summary).toMatchObject({
      state: 'partial',
      candidates: 3,
      counts: {
        indexed: 0,
        indexed_with_warnings: 1,
        skipped_by_policy: 1,
        unsupported: 1,
        failed: 0,
      },
      reason_buckets: {
        hidden_path: 1,
        parser_fallback: 1,
        unsupported_file_type: 1,
      },
    })
    expect(manifest.outcomes.find((entry) => entry.path === 'src/index.ts')?.diagnostics).toHaveLength(1)
  })

  it('creates a share-safe projection without paths, messages, or per-file outcomes', () => {
    const manifest = createIndexingManifest({
      outcomes: [
        outcome({
          path: 'src/auth/private-loader.ts',
          status: 'failed',
          reason: 'extractor_error',
          diagnostics: [{ code: 'extractor_error', level: 'error', message: 'secret local detail' }],
        }),
      ],
      spiDiagnostics: [{
        id: 'spi.failure',
        level: 'error',
        reason: 'spi_diagnostic',
        path: 'src/auth/private-loader.ts',
        message: 'secret SPI detail',
      }],
    })

    const shareSafe = shareSafeIndexingManifest(manifest)
    const serialized = JSON.stringify(shareSafe)

    expect(shareSafe.spi_diagnostics).toEqual({
      total: 1,
      levels: { info: 0, warn: 0, error: 1 },
    })
    expect(serialized).not.toContain('private-loader.ts')
    expect(serialized).not.toContain('secret local detail')
    expect(serialized).not.toContain('secret SPI detail')
    expect(serialized).not.toContain('outcomes')
    expect(shareSafe.summary.reason_buckets).toEqual({ extractor_error: 1 })
  })

  it('recomputes aggregate counts when parsing and rejects invalid reason codes', () => {
    const manifest = createIndexingManifest({ outcomes: [outcome()] })
    const mismatched = {
      ...manifest,
      summary: {
        ...manifest.summary,
        candidates: 99,
        counts: { ...manifest.summary.counts, indexed: 99 },
      },
    }

    expect(parseIndexingManifest(mismatched)?.summary.counts.indexed).toBe(1)
    expect(parseIndexingManifest({
      ...manifest,
      outcomes: [{ ...manifest.outcomes[0], reason: 'invented_reason' }],
    })).toBeNull()
  })

  it('finds only question- or owner-relevant uncertainty and applies strict thresholds', () => {
    const manifest = createIndexingManifest({
      outcomes: [
        outcome({
          path: 'src/auth/token-loader.ts',
          status: 'failed',
          reason: 'extractor_error',
        }),
        outcome({
          path: 'src/billing/legacy.vue',
          status: 'unsupported',
          reason: 'unsupported_file_type',
          capability: null,
        }),
      ],
    })

    expect(relevantIndexingUncertainty(manifest, {
      question: 'How does the auth token loader work?',
      coveredWorkflowOwners: ['src/auth/service.ts'],
    })).toMatchObject({
      total: 2,
      relevant: 1,
      relevant_reasons: { extractor_error: 1 },
      has_relevant_failures: true,
    })
    expect(relevantIndexingUncertainty(manifest, {
      question: 'How are invoices rendered?',
      coveredWorkflowOwners: ['src/invoices/render.ts'],
    }).relevant).toBe(0)
    expect(indexingStrictViolations(manifest.summary, { maxFailed: 0, maxUnsupported: 1 })).toEqual([
      'failed=1 exceeds maxFailed=0',
    ])
  })

  it('does not treat same-domain env, docs, hidden paths, or unrelated artifacts as code-flow uncertainty', () => {
    const manifest = createIndexingManifest({
      outcomes: [
        outcome({ path: 'apps/status-page/.env.example', status: 'skipped_by_policy', reason: 'environment_file', capability: null }),
        outcome({ path: 'apps/status-page/README.md', status: 'skipped_by_policy', reason: 'docs_disabled', capability: null }),
        outcome({ path: '.github', kind: 'directory', status: 'skipped_by_policy', reason: 'hidden_path', capability: null }),
        outcome({ path: 'apps/status-page/public/logo.svg', status: 'unsupported', reason: 'unsupported_file_type', capability: null }),
      ],
    })

    const codeFlow = relevantIndexingUncertainty(manifest, {
      question: 'How does an incident affect the public status page?',
      coveredWorkflowOwners: ['apps/status-page/src/content/status-json.ts'],
    })
    expect(codeFlow.relevant).toBe(0)

    expect(relevantIndexingUncertainty(manifest, {
      question: 'Which environment config controls the status page?',
    }).relevant_reasons).toEqual({ environment_file: 1 })
    expect(relevantIndexingUncertainty(manifest, {
      question: 'What does the status-page README document?',
    }).relevant_reasons).toEqual({ docs_disabled: 1 })
    expect(relevantIndexingUncertainty(manifest, {
      question: 'How is the status-page logo.svg asset used?',
    }).relevant_reasons).toEqual({ unsupported_file_type: 1 })
  })

  it('marks an unsupported-only candidate set as failed rather than false-partial', () => {
    const manifest = createIndexingManifest({
      outcomes: [outcome({
        path: 'src/legacy.vue',
        status: 'unsupported',
        reason: 'unsupported_file_type',
        capability: null,
      })],
    })

    expect(manifest.summary).toMatchObject({
      state: 'failed',
      counts: { indexed: 0, indexed_with_warnings: 0, unsupported: 1, failed: 0 },
    })
  })

  it('normalizes extraction paths without leaking an external parent path', () => {
    expect(localExtractionIndexingOutcome('/repo', {
      filePath: join('/repo', 'src', 'index.ts'),
      status: 'indexed',
      reason: 'indexed',
      capability: 'builtin:extract:typescript',
    }).path).toBe('src/index.ts')

    expect(localExtractionIndexingOutcome('/repo', {
      filePath: join('/outside', 'private.ts'),
      status: 'failed',
      reason: 'extractor_error',
      capability: null,
    }).path).toBe('private.ts')
  })

  it('does not claim legacy retained evidence for a file absent from the graph', () => {
    const rootPath = resolve('/repo')
    const presentFile = resolve(rootPath, 'src', 'present.ts')
    const missingFile = resolve(rootPath, 'src', 'missing.ts')
    const retained = retainedIndexingOutcomes({
      rootPath,
      files: [presentFile, missingFile],
      previousManifest: null,
      retainedSourceFiles: new Set([presentFile]),
    })

    expect(retained).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'src/present.ts',
        status: 'indexed',
        reason: 'retained_from_graph',
      }),
      expect.objectContaining({
        path: 'src/missing.ts',
        status: 'failed',
        reason: 'retained_evidence_missing',
      }),
    ]))
  })
})

describe('indexing extraction cache', () => {
  it('round-trips parser diagnostics so cache hits cannot become false-complete', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-indexing-cache-'))
    const filePath = join(root, 'fallback.py')
    writeFileSync(filePath, 'def fallback():\n    return True\n', 'utf8')
    const cachePath = join(cacheDir(), `${fileHash(filePath)}.json`)
    try {
      writeCachedExtraction(filePath, {
        nodes: [{
          id: 'fallback_file',
          label: 'fallback.py',
          file_type: 'code',
          source_file: filePath,
        }],
        edges: [],
        diagnostics: [{
          code: 'tree_sitter_python_fallback',
          level: 'warning',
          message: 'tree-sitter unavailable',
        }],
      })

      expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toMatchObject({
        __madarTsExtractorVersion: 68,
        diagnostics: [{
          code: 'tree_sitter_python_fallback',
          level: 'warning',
          message: 'tree-sitter unavailable',
        }],
      })
      expect(readCachedExtraction(filePath)?.diagnostics).toEqual([{
        code: 'tree_sitter_python_fallback',
        level: 'warning',
        message: 'tree-sitter unavailable',
      }])
    } finally {
      rmSync(cachePath, { force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('SPI indexing projection', () => {
  it('projects file diagnostics and unsupported SPI languages into terminal outcomes', () => {
    const result = spiResult({
      diagnostics: [{
        id: 'spi.file-warning',
        level: 'warn',
        message: 'partial semantic analysis',
        evidence: { file_id: 'file:src/index.ts' },
      }],
    })

    const projected = projectSpiIndexingOutcomes({
      rootPath: '/repo',
      codeFiles: ['/repo/src/index.ts', '/repo/src/main.py'],
      result,
    })

    expect(projected.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'src/index.ts',
        status: 'indexed_with_warnings',
        reason: 'spi_diagnostic',
      }),
      expect.objectContaining({
        path: 'src/main.py',
        status: 'unsupported',
        reason: 'unsupported_spi_language',
      }),
    ]))
    expect(projected.diagnostics).toEqual([
      expect.objectContaining({ id: 'spi.file-warning', path: 'src/index.ts' }),
    ])
  })

  it('applies a global SPI warning to every SPI file so completeness cannot stay false-green', () => {
    const result = spiResult({
      diagnostics: [{
        id: 'spi.call.program-create-failed',
        level: 'warn',
        message: 'call layer skipped',
      }],
    })

    const projected = projectSpiIndexingOutcomes({
      rootPath: '/repo',
      codeFiles: ['/repo/src/index.ts'],
      result,
    })

    expect(projected.outcomes).toEqual([
      expect.objectContaining({
        path: 'src/index.ts',
        status: 'indexed_with_warnings',
        reason: 'spi_diagnostic',
      }),
    ])
  })
})
