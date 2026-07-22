import { describe, expect, it } from 'vitest'

import type { CanonicalTypeScriptIndexResult } from '../../src/adapters/typescript/index.js'
import type { IndexingOutcome } from '../../src/contracts/indexing.js'
import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import {
  parseIndexingManifest,
  relevantIndexingUncertainty,
} from '../../src/infrastructure/indexing-manifest.js'
import { canonicalTypeScriptIndexingOutcomes } from '../../src/pipeline/indexing-generation.js'
import {
  createIndexingManifest,
  indexingStrictViolations,
  shareSafeIndexingManifest,
} from '../../src/pipeline/indexing-outcomes.js'

function outcome(overrides: Partial<IndexingOutcome> = {}): IndexingOutcome {
  return {
    path: 'src/index.ts',
    kind: 'file',
    status: 'indexed',
    reason: 'indexed',
    capability: 'builtin:index:typescript',
    ...overrides,
  }
}

function canonicalResult(
  overrides: Partial<Pick<CanonicalTypeScriptIndexResult, 'files' | 'diagnostics'>> = {},
): CanonicalTypeScriptIndexResult {
  return {
    graph: new KnowledgeGraph({ root_path: '/repo' }),
    files: [{ id: 'file:src/index.ts', path: 'src/index.ts', language: 'typescript', loc: 1, hash: 'a' }],
    diagnostics: [],
    ...overrides,
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
          reason: 'canonical_diagnostic',
          diagnostics: [{ code: 'typescript.partial-analysis', level: 'warning', message: 'local detail' }],
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
        canonical_diagnostic: 1,
        hidden_path: 1,
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
          reason: 'canonical_file_missing',
          diagnostics: [{ code: 'typescript.file-missing', level: 'error', message: 'secret local detail' }],
        }),
      ],
      indexDiagnostics: [{
        id: 'typescript.file-missing',
        level: 'error',
        reason: 'canonical_diagnostic',
        path: 'src/auth/private-loader.ts',
        message: 'secret index detail',
      }],
    })

    const shareSafe = shareSafeIndexingManifest(manifest)
    const serialized = JSON.stringify(shareSafe)

    expect(shareSafe.index_diagnostics).toEqual({
      total: 1,
      levels: { info: 0, warn: 0, error: 1 },
    })
    expect(serialized).not.toContain('private-loader.ts')
    expect(serialized).not.toContain('secret local detail')
    expect(serialized).not.toContain('secret index detail')
    expect(serialized).not.toContain('outcomes')
    expect(shareSafe.summary.reason_buckets).toEqual({ canonical_file_missing: 1 })
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
          reason: 'canonical_file_missing',
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
      relevant_reasons: { canonical_file_missing: 1 },
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

  it('does not treat same-domain env, hidden paths, or unrelated artifacts as code-flow uncertainty', () => {
    const manifest = createIndexingManifest({
      outcomes: [
        outcome({ path: 'apps/status-page/.env.example', status: 'skipped_by_policy', reason: 'environment_file', capability: null }),
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
})

describe('canonical TypeScript indexing projection', () => {
  it('projects canonical diagnostics into terminal outcomes', () => {
    const result = canonicalResult({
      diagnostics: [{
        id: 'typescript.file-warning',
        level: 'warn',
        message: 'partial semantic analysis',
        evidence: { file_id: 'file:src/index.ts' },
      }],
    })

    const projected = canonicalTypeScriptIndexingOutcomes({
      rootPath: '/repo',
      codeFiles: ['/repo/src/index.ts'],
      result,
    })

    expect(projected.outcomes).toEqual([
      expect.objectContaining({
        path: 'src/index.ts',
        status: 'indexed_with_warnings',
        reason: 'canonical_diagnostic',
        capability: 'builtin:index:typescript',
      }),
    ])
    expect(projected.diagnostics).toEqual([
      expect.objectContaining({ id: 'typescript.file-warning', path: 'src/index.ts' }),
    ])
  })

  it('applies a global compiler warning to every indexed file', () => {
    const result = canonicalResult({
      diagnostics: [{
        id: 'typescript.program-create-failed',
        level: 'warn',
        message: 'call layer skipped',
      }],
    })

    const projected = canonicalTypeScriptIndexingOutcomes({
      rootPath: '/repo',
      codeFiles: ['/repo/src/index.ts'],
      result,
    })

    expect(projected.outcomes).toEqual([
      expect.objectContaining({
        path: 'src/index.ts',
        status: 'indexed_with_warnings',
        reason: 'canonical_diagnostic',
      }),
    ])
  })

  it('marks a requested TypeScript file missing from the canonical index as failed', () => {
    const projected = canonicalTypeScriptIndexingOutcomes({
      rootPath: '/repo',
      codeFiles: ['/repo/src/missing.ts'],
      result: canonicalResult({ files: [] }),
    })

    expect(projected.outcomes).toEqual([
      expect.objectContaining({
        path: 'src/missing.ts',
        status: 'failed',
        reason: 'canonical_file_missing',
        capability: 'builtin:index:typescript',
      }),
    ])
  })
})
