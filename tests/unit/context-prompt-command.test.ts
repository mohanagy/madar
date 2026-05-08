import { describe, expect, it, vi } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { runContextPromptCommand, type ContextPromptCommandDependencies } from '../../src/infrastructure/context-prompt-command.js'

describe('context-prompt-command', () => {
  it('emits a compact deterministic provider prompt payload', async () => {
    const graph = new KnowledgeGraph()
    const dependencies: ContextPromptCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn().mockReturnValue({
        question: 'how does auth work',
        token_count: 18,
        matched_nodes: [],
        relationships: [],
        community_context: [],
        graph_signals: { god_nodes: [], bridge_nodes: [] },
      }),
      buildGraphifyPromptPack: vi.fn().mockReturnValue({
        kind: 'graphify',
        question: 'how does auth work',
        prompt: 'Retrieved graph context\n\nQuestion:\nhow does auth work',
        session_payload: 'Retrieved graph context\n\nQuestion:\nhow does auth work',
        token_count: 120,
        session_payload_token_count: 120,
        effective_token_count: 120,
        reused_context_tokens: 0,
        session_state: {
          version: 1,
          revision: 1,
          refs: {},
        },
      }),
    }

    const output = await runContextPromptCommand({
      prompt: 'how does auth work',
      provider: 'claude',
      graphPath: 'graphify-out/graph.json',
    }, dependencies)

    expect(dependencies.retrieveContext).toHaveBeenCalledWith(graph, {
      question: 'how does auth work',
      budget: 3000,
    })
    expect(output).toBe(JSON.stringify({
      provider: 'claude',
      task: 'explain',
      prompt: 'how does auth work',
      graph_path: 'graphify-out/graph.json',
      compiled: {
        kind: 'graphify',
        question: 'how does auth work',
        prompt: 'Retrieved graph context\n\nQuestion:\nhow does auth work',
        session_payload: 'Retrieved graph context\n\nQuestion:\nhow does auth work',
        token_count: 120,
        session_payload_token_count: 120,
        effective_token_count: 120,
        reused_context_tokens: 0,
        session_state: {
          version: 1,
          revision: 1,
          refs: {},
        },
      },
    }))
  })
})
