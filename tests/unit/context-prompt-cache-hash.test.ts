// Cache-aware prompt layout — stable_prefix_hash (#80, v0.16).

import { describe, expect, it } from 'vitest'

import { buildContextPrompt } from '../../src/infrastructure/context-prompt.js'

const baseInput = () => ({
  instructions: ['Read the workspace manifest.'] as const,
  stable_sections: [
    { ref: 's:workspace', sort_key: '01_workspace_manifest', body: 'Workspace: madar\nLanguage: TypeScript' },
    { ref: 's:communities', sort_key: '10_communities_overview', body: 'Communities: pipeline, runtime, contracts' },
    { ref: 's:evidence', sort_key: '20_evidence_token-budget', body: 'Top files: src/runtime/retrieve.ts' },
  ] as const,
  dynamic_sections: [{ body: 'Question: What does the retrieval gate do?' }] as const,
  stable_prefix_title: 'Stable context',
})

describe('stable_prefix_hash (#80)', () => {
  it('emits a 16-char sha256 hash on every build', () => {
    const built = buildContextPrompt(baseInput())
    expect(built.stable_prefix_hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is byte-stable across builds when the stable_prefix is unchanged', () => {
    const first = buildContextPrompt(baseInput())
    const second = buildContextPrompt(baseInput())
    expect(first.stable_prefix_hash).toBe(second.stable_prefix_hash)
    expect(first.stable_prefix).toBe(second.stable_prefix)
  })

  it('changes when a stable_section body changes', () => {
    const first = buildContextPrompt(baseInput())
    const mutated = {
      ...baseInput(),
      stable_sections: [
        { ref: 's:workspace', sort_key: '01_workspace_manifest', body: 'Workspace: DIFFERENT\nLanguage: TypeScript' },
        { ref: 's:communities', sort_key: '10_communities_overview', body: 'Communities: pipeline, runtime, contracts' },
        { ref: 's:evidence', sort_key: '20_evidence_token-budget', body: 'Top files: src/runtime/retrieve.ts' },
      ] as const,
    }
    const second = buildContextPrompt(mutated)
    expect(second.stable_prefix_hash).not.toBe(first.stable_prefix_hash)
  })

  it('does NOT change when only the dynamic_suffix changes (cache-aware invariant)', () => {
    const first = buildContextPrompt(baseInput())
    const dynamicChanged = {
      ...baseInput(),
      dynamic_sections: [{ body: 'Question: A totally different question.' }] as const,
    }
    const second = buildContextPrompt(dynamicChanged)
    // The stable prefix is what Anthropic's cache reuses — its hash must
    // be invariant under dynamic-suffix changes for cache hits to occur.
    expect(second.stable_prefix_hash).toBe(first.stable_prefix_hash)
    expect(second.stable_prefix).toBe(first.stable_prefix)
  })

  it('is deterministic regardless of stable_sections input order (sort_key drives layout)', () => {
    const inputA = baseInput()
    const inputB = {
      ...inputA,
      stable_sections: [...inputA.stable_sections].reverse(),
    }
    const a = buildContextPrompt(inputA)
    const b = buildContextPrompt(inputB)
    expect(a.stable_prefix_hash).toBe(b.stable_prefix_hash)
  })
})
