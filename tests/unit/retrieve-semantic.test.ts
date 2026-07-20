import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import { describe, expect, it, vi } from 'vitest'

describe('retrieve semantic path', () => {
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
    const graph = new KnowledgeGraph()
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
