import { beforeEach, describe, expect, it, vi } from 'vitest'

const pipelineMock = vi.hoisted(() => vi.fn())

vi.mock('@huggingface/transformers', () => ({
  pipeline: pipelineMock,
}))

describe('semantic runtime', () => {
  beforeEach(() => {
    pipelineMock.mockReset()
    vi.resetModules()
  })

  it('ranks candidates by semantic similarity with a cached local embedder', async () => {
    const extractor = vi.fn(async (input: string | string[]) => {
      const texts = Array.isArray(input) ? input : [input]
      return texts.map((text) => ({
        data: text.includes('invoice') ? [1, 0] : text.includes('repository') ? [0.9, 0.1] : [0, 1],
      }))
    })
    pipelineMock.mockImplementation(async (task: string) => {
      expect(task).toBe('feature-extraction')
      return extractor
    })

    const { rankCandidatesBySemanticSimilarity } = await import('../../src/runtime/semantic.js')
    const candidates = [
      { id: 'invoice_repo', text: 'Invoice repository persistence layer' },
      { id: 'logger', text: 'Logger diagnostics and telemetry' },
    ]

    const firstScores = await rankCandidatesBySemanticSimilarity('invoice persistence', candidates)
    const secondScores = await rankCandidatesBySemanticSimilarity('invoice persistence', candidates)

    expect(firstScores.get('invoice_repo')).toBeGreaterThan(firstScores.get('logger') ?? 0)
    expect(secondScores.get('invoice_repo')).toBeGreaterThan(secondScores.get('logger') ?? 0)
    expect(pipelineMock).toHaveBeenCalledTimes(1)
  })

  it('reranks candidate pairs with a cached local cross-encoder', async () => {
    const reranker = vi.fn(async (input: Array<{ text: string; text_pair: string }>) => (
      input.map((pair) => [
        {
          label: 'RELEVANT',
          score: pair.text_pair.toLowerCase().includes('archive') ? 0.96 : 0.18,
        },
      ])
    ))
    pipelineMock.mockImplementation(async (task: string) => {
      expect(task).toBe('text-classification')
      return reranker
    })

    const { rerankCandidatesWithCrossEncoder } = await import('../../src/runtime/semantic.js')
    const candidates = [
      { id: 'invoice_service', text: 'InvoiceService handles invoice creation' },
      { id: 'archive_store', text: 'ArchiveStore keeps historical invoice records' },
    ]

    const firstScores = await rerankCandidatesWithCrossEncoder('where is invoice history stored', candidates)
    const secondScores = await rerankCandidatesWithCrossEncoder('where is invoice history stored', candidates)

    expect(firstScores.get('archive_store')).toBeGreaterThan(firstScores.get('invoice_service') ?? 0)
    expect(secondScores.get('archive_store')).toBeGreaterThan(secondScores.get('invoice_service') ?? 0)
    expect(pipelineMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces an install hint when the optional transformers package is unavailable', async () => {
    pipelineMock.mockImplementation(async () => {
      throw new Error("Cannot find package '@huggingface/transformers' imported from /tmp/madar-semantic-test")
    })

    const { rankCandidatesBySemanticSimilarity } = await import('../../src/runtime/semantic.js')

    await expect(rankCandidatesBySemanticSimilarity('invoice persistence', [
      { id: 'invoice_repo', text: 'Invoice repository persistence layer' },
    ])).rejects.toThrow(/npm install @huggingface\/transformers/)
  })
})
