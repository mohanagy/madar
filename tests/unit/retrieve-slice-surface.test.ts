import { describe, expect, it, vi } from 'vitest'

import { parsePackArgs } from '../../src/cli/parser.js'
import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { runContextPackCommand, type ContextPackCommandDependencies } from '../../src/infrastructure/context-pack-command.js'

describe('slice-v1 CLI surface', () => {
  it('accepts --retrieval-strategy slice-v1 for pack', () => {
    const options = parsePackArgs(['"Explain auth"', '--retrieval-strategy', 'slice-v1'])
    expect((options as { retrievalStrategy?: string }).retrievalStrategy).toBe('slice-v1')
  })

  it('rejects unsupported retrieval strategies for pack', () => {
    expect(() => parsePackArgs(['"Explain auth"', '--retrieval-strategy', 'invented'])).toThrow(/slice-v1/)
  })
})

describe('slice-v1 context-pack command surface', () => {
  it('forwards retrievalStrategy to retrieveContext for explain packs', async () => {
    const graph = new KnowledgeGraph()
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn().mockReturnValue({
        question: 'Explain auth',
        token_count: 10,
        matched_nodes: [],
        relationships: [],
        community_context: [],
        graph_signals: { god_nodes: [], bridge_nodes: [] },
        retrieval_strategy: 'slice-v1',
        slice: {
          mode: 'explain',
          anchors: [{ label: 'AuthService', reason: 'symbol mention' }],
          directions: ['backward', 'forward'],
          selected_paths: [],
        },
      }),
      compactRetrieveResult: vi.fn().mockReturnValue({
        question: 'Explain auth',
        token_count: 10,
        matched_nodes: [],
        relationships: [],
        community_context: [],
        graph_signals: { god_nodes: [], bridge_nodes: [] },
        retrieval_strategy: 'slice-v1',
        slice: {
          mode: 'explain',
          anchors: [{ label: 'AuthService', reason: 'symbol mention' }],
          directions: ['backward', 'forward'],
          selected_paths: [],
        },
      }),
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    const output = await runContextPackCommand({
      prompt: 'Explain auth',
      budget: 1000,
      task: 'explain',
      graphPath: 'out/graph.json',
      retrievalStrategy: 'slice-v1',
    } as never, dependencies)

    expect(dependencies.retrieveContext).toHaveBeenCalledWith(graph, {
      question: 'Explain auth',
      budget: 1000,
      taskIntent: 'explain',
      retrievalStrategy: 'slice-v1',
    })

    const payload = JSON.parse(output) as { pack: { retrieval_strategy?: string } }
    expect(payload.pack.retrieval_strategy).toBe('slice-v1')
  })

  it('rejects retrievalStrategy for review packs instead of silently ignoring it', async () => {
    const graph = new KnowledgeGraph()
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn(),
      compactRetrieveResult: vi.fn(),
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    await expect(runContextPackCommand({
      prompt: 'Review current diff',
      budget: 1000,
      task: 'review',
      graphPath: 'out/graph.json',
      retrievalStrategy: 'slice-v1',
    } as never, dependencies)).rejects.toThrow(/retrievalStrategy/i)
  })
})
