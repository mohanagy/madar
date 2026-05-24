import { describe, expect, it } from 'vitest'

import { buildRoutingDebug } from '../../src/runtime/routing-debug.js'

describe('buildRoutingDebug', () => {
  it('dedupes matched-node fallback anchors before taking the top three', () => {
    const routing = buildRoutingDebug({
      question: 'Trace the runtime path',
      token_count: 42,
      retrieval_gate: {
        level: 3,
        skipped_retrieval: false,
        reason: 'test routing fallback',
        intent: 'explain',
        signals: {
          has_pr_diff: false,
          has_stack_trace: false,
          mentioned_paths: [],
          mentioned_symbols: [],
          generation_intent: 'runtime_generation',
          target_domain_hint: 'backend_runtime',
          excluded_domains: [],
          excluded_terms: [],
          excluded_path_hints: [],
        },
      },
      matched_nodes: [
        {
          node_id: '1',
          label: 'src/foo.ts',
          node_kind: 'file',
          source_file: 'src/foo.ts',
          line_number: 1,
          snippet: null,
          match_score: 0.9,
          file_type: 'code',
          relevance_band: 'direct',
          community: 0,
          community_label: null,
        },
        {
          node_id: '2',
          label: 'lib/foo.ts',
          node_kind: 'file',
          source_file: 'lib/foo.ts',
          line_number: 1,
          snippet: null,
          match_score: 0.8,
          file_type: 'code',
          relevance_band: 'direct',
          community: 0,
          community_label: null,
        },
        {
          node_id: '3',
          label: 'app/foo.ts',
          node_kind: 'file',
          source_file: 'app/foo.ts',
          line_number: 1,
          snippet: null,
          match_score: 0.7,
          file_type: 'code',
          relevance_band: 'direct',
          community: 0,
          community_label: null,
        },
        {
          node_id: '4',
          label: 'src/bar.ts',
          node_kind: 'file',
          source_file: 'src/bar.ts',
          line_number: 1,
          snippet: null,
          match_score: 0.6,
          file_type: 'code',
          relevance_band: 'related',
          community: 0,
          community_label: null,
        },
        {
          node_id: '5',
          label: 'src/baz.ts',
          node_kind: 'file',
          source_file: 'src/baz.ts',
          line_number: 1,
          snippet: null,
          match_score: 0.5,
          file_type: 'code',
          relevance_band: 'related',
          community: 0,
          community_label: null,
        },
      ],
      relationships: [],
      community_context: [],
      graph_signals: {
        god_nodes: [],
        bridge_nodes: [],
      },
    })

    expect(routing.top_anchors).toEqual([
      { label: 'foo.ts', reason: 'top retrieval match' },
      { label: 'bar.ts', reason: 'top retrieval match' },
      { label: 'baz.ts', reason: 'top retrieval match' },
    ])
  })
})
