import { describe, expect, it } from 'vitest'

import { pickImpactTarget } from '../../src/runtime/context-pack-target.js'

describe('pickImpactTarget', () => {
  it('ignores whitespace-only direct matches', () => {
    expect(pickImpactTarget({
      question: 'What breaks if auth changes?',
      token_count: 0,
      matched_nodes: [
        {
          label: '   ',
          source_file: 'src/empty.ts',
          line_number: 1,
          snippet: null,
          match_score: 99,
          relevance_band: 'direct',
          community: null,
          community_label: null,
          file_type: 'code',
        },
        {
          label: 'AuthService',
          source_file: 'src/auth.ts',
          line_number: 12,
          snippet: null,
          match_score: 4,
          relevance_band: 'direct',
          community: null,
          community_label: null,
          file_type: 'code',
        },
      ],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
    })).toBe('AuthService')
  })
})
