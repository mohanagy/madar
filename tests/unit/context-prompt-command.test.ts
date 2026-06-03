import { describe, expect, it, vi } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { runContextPromptCommand, type ContextPromptCommandDependencies } from '../../src/infrastructure/context-prompt-command.js'

function expectGraphFreshnessContract(value: unknown): void {
  expect(value).toEqual(expect.objectContaining({
    status: expect.stringMatching(/^(fresh|partially_stale|possibly_stale|stale|missing)$/),
    graph_path: expect.any(String),
    madar_version: expect.any(String),
    indexed_file_count: expect.any(Number),
    changed_source_count: expect.any(Number),
    missing_source_count: expect.any(Number),
    recommendation: expect.any(String),
  }))

  const freshness = value as {
    status?: string
    graph_version?: unknown
    graph_modified_ms?: unknown
    graph_modified_at?: unknown
    generated_ms?: unknown
    generated_at?: unknown
  }
  if (freshness.status === 'missing') {
    expect(freshness.graph_version).toBeNull()
    expect(freshness.graph_modified_ms).toBeNull()
    expect(freshness.graph_modified_at).toBeNull()
    expect(freshness.generated_ms).toBeNull()
    expect(freshness.generated_at).toBeNull()
    return
  }

  expect(freshness.graph_version).toEqual(expect.anything())
  expect(freshness.graph_modified_ms).toEqual(expect.anything())
  expect(freshness.graph_modified_at).toEqual(expect.anything())
  expect(freshness.generated_ms).toEqual(expect.anything())
  expect(freshness.generated_at).toEqual(expect.anything())
}

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
      buildMadarPromptPack: vi.fn().mockReturnValue({
        kind: 'madar',
        question: 'how does auth work',
        prompt: 'provider-agnostic prompt',
        session_payload: 'claude session payload',
        token_count: 120,
        session_payload_token_count: 140,
        effective_token_count: 118,
        reused_context_tokens: 22,
        session_diagnostics: {
          mode: 'follow_up',
          previous_revision: 1,
          reused_refs: ['explain_pack_payload'],
          added_refs: [],
          updated_refs: [],
          invalidated_refs: [],
          reused_context_tokens: 22,
          effective_token_count: 118,
        },
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
      graphPath: 'out/graph.json',
    }, dependencies)

    expect(dependencies.retrieveContext).toHaveBeenCalledWith(graph, {
      question: 'how does auth work',
      budget: 3000,
    })
    const parsed = JSON.parse(output) as {
      graph_freshness?: unknown
      compiled?: unknown
    }

    expect(parsed).toEqual({
      provider: 'claude',
      prompt: 'how does auth work',
      graph_path: 'out/graph.json',
      graph_freshness: expect.any(Object),
      compiled: {
        provider: 'claude',
        format: 'session_payload',
        prompt: 'claude session payload',
        token_count: 120,
        session_payload_token_count: 140,
        effective_token_count: 118,
        reused_context_tokens: 22,
        session_diagnostics: {
          mode: 'follow_up',
          previous_revision: 1,
          reused_refs: ['explain_pack_payload'],
          added_refs: [],
          updated_refs: [],
          invalidated_refs: [],
          reused_context_tokens: 22,
          effective_token_count: 118,
        },
        session_state: {
          version: 1,
          revision: 1,
          refs: {},
        },
      },
    })
    expectGraphFreshnessContract(parsed.graph_freshness)
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
      buildMadarPromptPack: vi.fn().mockReturnValue({
        kind: 'madar',
        question: 'how does auth work',
        prompt: 'provider-agnostic prompt',
        session_payload: 'claude session payload',
        token_count: 120,
        session_payload_token_count: 140,
        effective_token_count: 118,
        reused_context_tokens: 22,
        session_diagnostics: {
          mode: 'follow_up',
          previous_revision: 1,
          reused_refs: ['explain_pack_payload'],
          added_refs: [],
          updated_refs: [],
          invalidated_refs: [],
          reused_context_tokens: 22,
          effective_token_count: 118,
        },
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
      graphPath: 'out/graph.json',
    }, dependencies)

    const parsed = JSON.parse(output) as {
      graph_freshness?: unknown
      compiled?: unknown
    }

    expect(parsed).toEqual({
      provider: 'gemini',
      prompt: 'how does auth work',
      graph_path: 'out/graph.json',
      graph_freshness: expect.any(Object),
      compiled: {
        provider: 'gemini',
        format: 'prompt',
        prompt: 'provider-agnostic prompt',
        token_count: 120,
      },
    })
    expectGraphFreshnessContract(parsed.graph_freshness)
  })

    it('fails fast on requireFreshGraph before retrieval begins', async () => {
      const graph = new KnowledgeGraph()
      const dependencies: ContextPromptCommandDependencies = {
        loadGraph: vi.fn().mockReturnValue(graph),
        retrieveContext: vi.fn(),
        buildMadarPromptPack: vi.fn(),
      }

      await expect(runContextPromptCommand({
        prompt: 'how does auth work',
        provider: 'claude',
        graphPath: 'out/missing/context-prompt-graph.json',
        requireFreshGraph: true,
      }, dependencies)).rejects.toThrow(/require-fresh-graph|fresh graph/i)
      expect(dependencies.retrieveContext).not.toHaveBeenCalled()
    })
  })
