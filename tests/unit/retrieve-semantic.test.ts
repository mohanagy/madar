import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

describe('retrieve semantic path', () => {
  it('filters excluded source before semantic ranking and reranking while preserving lexical anchors', async () => {
    vi.resetModules()
    const rank = vi.fn(async (_question: string, candidates: Array<{ id: string; text: string }>) => new Map(candidates.map(candidate => [candidate.id, 0.9])))
    const rerank = vi.fn(async (_question: string, candidates: Array<{ id: string; text: string }>) => new Map(candidates.map(candidate => [candidate.id, 0.9])))
    vi.doMock('../../src/runtime/semantic.js', () => ({
      rankCandidatesBySemanticSimilarity: rank, rerankCandidatesWithCrossEncoder: rerank,
      DEFAULT_SEMANTIC_MODEL: 'mock-semantic-model', DEFAULT_RERANK_MODEL: 'mock-rerank-model',
    }))
    const { retrieveContext, retrieveContextAsync } = await import('../../src/runtime/retrieve.js')
    const root = mkdtempSync(join(tmpdir(), 'madar-semantic-exclusions-'))
    try {
      const graph = new KnowledgeGraph()
      graph.graph.root_path = root
      for (const [id, label, relative] of [
        ['allowed', 'InvoiceAllowed', 'src/allowed.ts'],
        ['blocked', 'InvoiceBlocked', 'src/blocked.ts'],
        ['legacy', 'LegacyInvoice', 'src/old.ts'],
        ['spec', 'InvoiceSpec', 'src/invoice.spec.ts'],
      ]) {
        const file = join(root, relative!)
        mkdirSync(dirname(file), { recursive: true })
        const snippet = `export function ${label}() { return "invoice storage" }`
        writeFileSync(file, snippet)
        graph.addNode(id!, { label: `${label}()`, file_type: 'code', source_file: file, source_location: 'L1', snippet })
      }
      const options = { budget: 3000, semantic: true, rerank: true }
      const scoped = await retrieveContextAsync(graph, { ...options,
        question: 'Where is invoice storage implemented? Exclude src/blocked.ts, legacy, tests.',
      })
      for (const mock of [rank, rerank]) {
        expect(mock).toHaveBeenCalled()
        expect(mock.mock.calls.at(-1)![1].map(candidate => candidate.id)).toEqual(['allowed'])
      }
      expect(scoped.matched_nodes.map(node => node.node_id)).toEqual(['allowed'])

      const anchored = 'Explain `InvoiceBlocked`. Exclude src/blocked.ts.'
      expect(retrieveContext(graph, { question: anchored, budget: 3000 }).matched_nodes.map(node => node.node_id)).toContain('blocked')
      rank.mockClear(); rerank.mockClear()
      await retrieveContextAsync(graph, { ...options, question: anchored })
      for (const mock of [rank, rerank]) expect(mock.mock.calls.at(-1)![1].map(candidate => candidate.id)).toContain('blocked')

      rank.mockClear(); rerank.mockClear()
      const invalid = await retrieveContextAsync(graph, { ...options, question: 'Explain `InvoiceBlocked`. Exclude ../src/blocked.ts.' })
      expect(invalid.matched_nodes).toEqual([])
      expect(rank).not.toHaveBeenCalled()
      expect(rerank).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
      vi.doUnmock('../../src/runtime/semantic.js')
    }
  })

  it('adds semantic-only matches when lexical retrieval misses', async () => {
    vi.resetModules()
    vi.doMock('../../src/runtime/semantic.js', () => ({
      rankCandidatesBySemanticSimilarity: vi.fn(async () => new Map([['ledger_repo', 0.82], ['logger', 0.12]])),
      rerankCandidatesWithCrossEncoder: vi.fn(async () => new Map()),
      DEFAULT_SEMANTIC_MODEL: 'mock-semantic-model',
      DEFAULT_RERANK_MODEL: 'mock-rerank-model',
    }))

    const { retrieveContextAsync } = await import('../../src/runtime/retrieve.js')
    const graph = new KnowledgeGraph()
    graph.addNode('ledger_repo', {
      label: 'LedgerRepository',
      file_type: 'code',
      source_file: '/src/ledger.ts',
      source_location: 'L4-L6',
      snippet: 'class LedgerRepository {\n  saveInvoice() {}\n}',
    })
    graph.addNode('logger', {
      label: 'Logger',
      file_type: 'code',
      source_file: '/src/logger.ts',
      source_location: 'L1-L3',
      snippet: 'class Logger {\n  info() {}\n}',
    })

    const result = await retrieveContextAsync(graph, {
      question: 'where is invoice persistence handled',
      budget: 3000,
      semantic: true,
    })

    expect(result.matched_nodes[0]?.label).toBe('LedgerRepository')
    expect(result.matched_nodes[0]?.snippet).toContain('saveInvoice')
  })

  it('lets the reranker reorder the semantic candidate pool', async () => {
    vi.resetModules()
    vi.doMock('../../src/runtime/semantic.js', () => ({
      rankCandidatesBySemanticSimilarity: vi.fn(async () => new Map([
        ['invoice_service', 0.9],
        ['archive_store', 0.8],
      ])),
      rerankCandidatesWithCrossEncoder: vi.fn(async () => new Map([
        ['invoice_service', 0.1],
        ['archive_store', 0.99],
      ])),
      DEFAULT_SEMANTIC_MODEL: 'mock-semantic-model',
      DEFAULT_RERANK_MODEL: 'mock-rerank-model',
    }))

    const { retrieveContextAsync } = await import('../../src/runtime/retrieve.js')
    const graph = new KnowledgeGraph()
    graph.addNode('invoice_service', {
      label: 'InvoiceService',
      file_type: 'code',
      source_file: '/src/invoice-service.ts',
      source_location: 'L2-L4',
      snippet: 'class InvoiceService {\n  createInvoice() {}\n}',
    })
    graph.addNode('archive_store', {
      label: 'ArchiveStore',
      file_type: 'code',
      source_file: '/src/archive-store.ts',
      source_location: 'L8-L10',
      snippet: 'class ArchiveStore {\n  loadInvoiceHistory() {}\n}',
    })

    const result = await retrieveContextAsync(graph, {
      question: 'where is invoice history stored',
      budget: 3000,
      semantic: true,
      rerank: true,
    })

    expect(result.matched_nodes[0]?.label).toBe('ArchiveStore')
  })

  it('keeps semantic slice-v1 retrieval inside the lexical slice and preserves slice metadata', async () => {
    vi.resetModules()
    vi.doMock('../../src/runtime/semantic.js', () => ({
      rankCandidatesBySemanticSimilarity: vi.fn(async () => new Map([
        ['unrelated_worker', 0.99],
        ['session_store', 0.55],
      ])),
      rerankCandidatesWithCrossEncoder: vi.fn(async () => new Map()),
      DEFAULT_SEMANTIC_MODEL: 'mock-semantic-model',
      DEFAULT_RERANK_MODEL: 'mock-rerank-model',
    }))

    const { retrieveContextAsync } = await import('../../src/runtime/retrieve.js')
    const graph = new KnowledgeGraph({ directed: true })
    graph.addNode('auth_service', {
      label: 'AuthService.login',
      file_type: 'code',
      source_file: '/src/auth-service.ts',
      source_location: 'L2-L6',
      snippet: 'export class AuthService { async login() { return this.sessionStore.create() } }',
    })
    graph.addNode('session_store', {
      label: 'SessionStore.create',
      file_type: 'code',
      source_file: '/src/session-store.ts',
      source_location: 'L1-L3',
      snippet: 'export function create() {}',
    })
    graph.addNode('unrelated_worker', {
      label: 'UnrelatedWorker.rebuild',
      file_type: 'code',
      source_file: '/src/unrelated-worker.ts',
      source_location: 'L1-L3',
      snippet: 'export function rebuild() {}',
    })
    graph.addEdge('auth_service', 'session_store', { relation: 'calls' })

    const result = await retrieveContextAsync(graph, {
      question: 'Explain `AuthService.login`',
      budget: 3000,
      semantic: true,
      retrievalStrategy: 'slice-v1',
    })

    const labels = result.matched_nodes.map((node) => node.label)
    expect(labels).toContain('AuthService.login')
    expect(labels).toContain('SessionStore.create')
    expect(labels).not.toContain('UnrelatedWorker.rebuild')
    expect((result as { retrieval_strategy?: string }).retrieval_strategy).toBe('slice-v1')
    expect((result as { slice?: { mode?: string } }).slice?.mode).toBe('explain')
  })
})
