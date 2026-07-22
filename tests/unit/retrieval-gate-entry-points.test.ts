import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import { createTestGraph } from '../helpers/knowledge-graph.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'

function buildSmallGraph(): KnowledgeGraph {
  return createTestGraph({
    nodes: [
        ['auth_service', {
                label: 'AuthService',
                file_type: 'code',
                source_file: 'src/auth.ts',
                source_location: 'L1'
            }]
    ],
    edges: []
})
}

describe('retrieveContext attaches retrieval_gate metadata (#75 entry-point hook)', () => {
  it('attaches a retrieval_gate decision when the question is matched', () => {
    const graph = buildSmallGraph()
    const result = retrieveContext(graph, { question: 'explain `AuthService`', budget: 1000 })

    expect(result.retrieval_gate).toBeDefined()
    expect(result.retrieval_gate?.intent).toBe('explain')
    expect(result.retrieval_gate?.level).toBeGreaterThanOrEqual(1)
    expect(result.retrieval_gate?.signals.mentioned_symbols).toContain('AuthService')
    expect(result.retrieval_gate?.signals.has_pr_diff).toBe(false)
  })

  it('attaches a retrieval_gate decision on the empty-question branch (no tokens after stop-word filter)', () => {
    const graph = buildSmallGraph()
    // 'how does the' is all stop words → tokenizeQuestion returns [] → empty branch.
    const result = retrieveContext(graph, { question: 'how does the', budget: 1000 })

    expect(result.token_count).toBe(0)
    expect(result.matched_nodes).toEqual([])
    expect(result.retrieval_gate).toBeDefined()
    expect(result.retrieval_gate?.signals).toBeDefined()
  })

  it('classifies a debug-shaped question as debug intent at level 3', () => {
    const graph = buildSmallGraph()
    const result = retrieveContext(graph, { question: 'why does `AuthService` crash on login?', budget: 1000 })

    expect(result.retrieval_gate?.intent).toBe('debug')
    expect(result.retrieval_gate?.level).toBe(3)
  })

  it('classifies a chitchat question as chitchat (level 0, skipped_retrieval=true) — even though we still build a result shape', () => {
    const graph = buildSmallGraph()
    // Chitchat goes through the empty-question branch because tokenizeQuestion
    // strips all words.
    const result = retrieveContext(graph, { question: 'thanks', budget: 1000 })

    expect(result.retrieval_gate?.intent).toBe('chitchat')
    expect(result.retrieval_gate?.level).toBe(0)
    expect(result.retrieval_gate?.skipped_retrieval).toBe(true)
  })

  it('preserves the gate decision across both retrieve paths so callers can rely on it always being present', () => {
    const graph = buildSmallGraph()
    const matched = retrieveContext(graph, { question: 'auth', budget: 1000 })
    const empty = retrieveContext(graph, { question: 'a b c', budget: 1000 })

    // Both results carry the field, regardless of whether retrieval matched.
    expect(matched.retrieval_gate).toBeDefined()
    expect(empty.retrieval_gate).toBeDefined()
  })
})
