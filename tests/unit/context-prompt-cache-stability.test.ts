import { describe, expect, it } from 'vitest'

import {
  buildContextPrompt,
  type BuildContextPromptInput,
} from '../../src/infrastructure/context-prompt.js'

// #80 — cache-aware prompt layout regression tests. Two consecutive
// buildContextPrompt calls with the same anchor and same stable input must
// produce a byte-identical stable_prefix. If this regresses, Anthropic's
// automatic prompt cache stops reusing the prefix and effective_prompt_tokens
// trends UP turn-over-turn instead of down.

function workspacePromptInput(question: string): BuildContextPromptInput {
  return {
    instructions: ['Use only graph evidence.'],
    stable_sections: [
      // Most stable — workspace manifest. Sort key 01.
      { ref: 'workspace_manifest', title: 'Workspace', body: 'sadeem (TypeScript, 148 files)', sort_key: '01_workspace_manifest' },
      // Semi-stable — community structure. Sort key 10.
      { ref: 'communities_overview', title: 'Communities', body: 'Pipeline Extract, Runtime Retrieve, Infrastructure Compare, ...', sort_key: '10_communities_overview' },
      // Anchor — current task. Sort key 90 (last).
      { ref: 'task_anchor', title: 'Anchor', body: question, sort_key: '90_anchor' },
    ],
    dynamic_sections: [
      { title: 'Question', body: question },
    ],
    stable_prefix_title: 'Stable context',
  }
}

describe('cache-aware prompt layout (#80)', () => {
  it('produces a byte-identical stable_prefix on two consecutive calls with the same anchor', () => {
    const input = workspacePromptInput('How does authentication work?')
    const first = buildContextPrompt(input)
    const second = buildContextPrompt(input)
    expect(first.stable_prefix).toBe(second.stable_prefix)
    expect(first.metrics.stable_prefix_tokens).toBe(second.metrics.stable_prefix_tokens)
  })

  it('reorders stable_sections deterministically by sort_key regardless of input order', () => {
    const inOrder = workspacePromptInput('Q1')
    const reordered: BuildContextPromptInput = {
      ...inOrder,
      stable_sections: [...inOrder.stable_sections].reverse(),
    }
    const a = buildContextPrompt(inOrder)
    const b = buildContextPrompt(reordered)
    expect(a.stable_prefix).toBe(b.stable_prefix)
    expect(a.ordered_stable_refs).toEqual(b.ordered_stable_refs)
  })

  it('changes the stable_prefix when the anchor body changes (stable for one anchor, NOT shared across anchors)', () => {
    const a = buildContextPrompt(workspacePromptInput('How does auth work?'))
    const b = buildContextPrompt(workspacePromptInput('Why is the report slow?'))
    // Anchor section is part of stable_prefix sorted last, so it does change
    // across questions. The earlier sort-keyed sections (workspace_manifest,
    // communities_overview) STAY identical — that's the cache-friendly part.
    expect(a.stable_prefix).not.toBe(b.stable_prefix)
    // But the workspace + communities portion is shared. We can't easily
    // slice the prefix, so we rely on stable_prefix_tokens monotonicity
    // across changing anchors with the same stable sections being roughly
    // similar (token deltas come only from the anchor body diff).
    expect(Math.abs(a.metrics.stable_prefix_tokens - b.metrics.stable_prefix_tokens)).toBeLessThan(20)
  })

  it('exposes reused_context_tokens on a follow-up call with a passed-in session state', () => {
    // First call — no session, no reuse.
    const first = buildContextPrompt(workspacePromptInput('Q1'))
    expect(first.metrics.reused_context_tokens).toBe(0)
    // Second call — supply the prior session_state. The compiler should
    // detect the unchanged refs and report a non-zero reused_context_tokens.
    const second = buildContextPrompt({
      ...workspacePromptInput('Q1'),
      session: first.session_state,
    })
    expect(second.metrics.reused_context_tokens).toBeGreaterThan(0)
    expect(second.metrics.effective_prompt_tokens).toBeLessThanOrEqual(first.metrics.raw_prompt_tokens)
  })

  it('the stable prefix never embeds an ISO timestamp (prevents accidental cache invalidation)', () => {
    const built = buildContextPrompt(workspacePromptInput('Q'))
    expect(built.stable_prefix).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})
