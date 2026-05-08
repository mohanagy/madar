import { describe, expect, it, vi } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { runContextPromptCommand, type ContextPromptCommandDependencies } from '../../src/infrastructure/context-prompt-command.js'

describe('context-prompt-command', () => {
  it('compiles Claude output from the cache-aware session payload', async () => {
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
        prompt: 'provider-agnostic prompt',
        session_payload: 'claude session payload',
        token_count: 120,
        session_payload_token_count: 140,
        effective_token_count: 118,
        reused_context_tokens: 22,
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
      prompt: 'how does auth work',
      graph_path: 'graphify-out/graph.json',
      compiled: {
        provider: 'claude',
        format: 'session_payload',
        prompt: 'claude session payload',
        token_count: 120,
        session_payload_token_count: 140,
        effective_token_count: 118,
        reused_context_tokens: 22,
        session_state: {
          version: 1,
          revision: 1,
          refs: {},
        },
      },
    }))
  })

  it('compiles Gemini output from the provider-agnostic prompt text', async () => {
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
        prompt: 'provider-agnostic prompt',
        session_payload: 'claude session payload',
        token_count: 120,
        session_payload_token_count: 140,
        effective_token_count: 118,
        reused_context_tokens: 22,
        session_state: {
          version: 1,
          revision: 1,
          refs: {},
        },
      }),
    }

    const output = await runContextPromptCommand({
      prompt: 'how does auth work',
      provider: 'gemini',
      graphPath: 'graphify-out/graph.json',
    }, dependencies)

    expect(output).toBe(JSON.stringify({
      provider: 'gemini',
      prompt: 'how does auth work',
      graph_path: 'graphify-out/graph.json',
      compiled: {
        provider: 'gemini',
        format: 'prompt',
        prompt: 'provider-agnostic prompt',
        token_count: 120,
      },
    }))
  })
})
