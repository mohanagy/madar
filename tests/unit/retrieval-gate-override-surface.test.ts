import { describe, expect, it } from 'vitest'

import { parsePackArgs } from '../../src/cli/parser.js'
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

describe('parsePackArgs --retrieval-level (#75 manual override CLI surface)', () => {
  it('accepts --retrieval-level <N> with a separate value', () => {
    const opts = parsePackArgs(['"explain auth"', '--retrieval-level', '0'])
    expect(opts.retrievalLevel).toBe(0)
  })

  it('accepts --retrieval-level=N with an inline value', () => {
    const opts = parsePackArgs(['"explain auth"', '--retrieval-level=5'])
    expect(opts.retrievalLevel).toBe(5)
  })

  it('omits retrievalLevel when the flag is not provided', () => {
    const opts = parsePackArgs(['"explain auth"'])
    expect(opts.retrievalLevel).toBeUndefined()
  })

  it('rejects out-of-range levels', () => {
    expect(() => parsePackArgs(['"explain auth"', '--retrieval-level', '6'])).toThrow(/between 0 and 5/)
    expect(() => parsePackArgs(['"explain auth"', '--retrieval-level', '-1'])).toThrow(/between 0 and 5/)
  })

  it('rejects non-integer levels', () => {
    expect(() => parsePackArgs(['"explain auth"', '--retrieval-level', '1.5'])).toThrow(/integer/)
    expect(() => parsePackArgs(['"explain auth"', '--retrieval-level', 'foo'])).toThrow(/integer/)
  })

  it('rejects --retrieval-level without a value', () => {
    expect(() => parsePackArgs(['"explain auth"', '--retrieval-level'])).toThrow()
  })
})

describe('retrieveContext honors options.retrievalLevel (#75 manual override runtime surface)', () => {
  it('forces level 0 (skipped_retrieval=true) regardless of prompt', () => {
    const graph = buildSmallGraph()
    const result = retrieveContext(graph, {
      question: 'why does AuthService crash on login?', // would normally classify as debug → level 3
      budget: 1000,
      retrievalLevel: 0,
    })

    expect(result.retrieval_gate?.level).toBe(0)
    expect(result.retrieval_gate?.skipped_retrieval).toBe(true)
    expect(result.retrieval_gate?.reason).toBe('manual override')
    // Intent is still detected for transparency.
    expect(result.retrieval_gate?.intent).toBe('debug')
  })

  it('forces level 5 even on a chitchat prompt', () => {
    const graph = buildSmallGraph()
    const result = retrieveContext(graph, {
      question: 'thanks',
      budget: 1000,
      retrievalLevel: 5,
    })

    expect(result.retrieval_gate?.level).toBe(5)
    expect(result.retrieval_gate?.reason).toBe('manual override')
    expect(result.retrieval_gate?.intent).toBe('chitchat')
  })

  it('the empty-question branch also honors the override', () => {
    const graph = buildSmallGraph()
    const result = retrieveContext(graph, {
      question: 'how does the', // all-stop-words → empty branch
      budget: 1000,
      retrievalLevel: 4,
    })

    expect(result.token_count).toBe(0)
    expect(result.retrieval_gate?.level).toBe(4)
    expect(result.retrieval_gate?.reason).toBe('manual override')
  })

  it('without the override, the gate runs heuristic classification as before', () => {
    const graph = buildSmallGraph()
    const result = retrieveContext(graph, {
      question: 'explain `AuthService`',
      budget: 1000,
    })

    expect(result.retrieval_gate?.intent).toBe('explain')
    expect(result.retrieval_gate?.level).toBe(2)
    expect(result.retrieval_gate?.reason).not.toBe('manual override')
  })
})
