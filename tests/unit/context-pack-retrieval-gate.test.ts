import { describe, expect, it } from 'vitest'

import type { ContextPackNode } from '../../src/contracts/context-pack.js'
import type { RetrievalGateDecision } from '../../src/contracts/retrieval-gate.js'
import {
  classifyTaskContract,
  compactContextPack,
  compileContextPack,
  type ContextPackNodeCandidate,
} from '../../src/runtime/context-pack.js'
import { classifyRetrievalLevel } from '../../src/runtime/retrieval-gate.js'

function nodeCandidate(
  entry: ContextPackNode,
  evidenceClass: 'primary' | 'supporting' | 'structural' | 'change' | 'impact',
  tokenCost: number,
): ContextPackNodeCandidate<ContextPackNode> {
  return {
    label: entry.label,
    ...(typeof entry.node_id === 'string' ? { node_id: entry.node_id } : {}),
    community: entry.community ?? null,
    ...(typeof entry.source_file === 'string' ? { source_file: entry.source_file } : {}),
    ...(typeof entry.line_number === 'number' ? { line_number: entry.line_number } : {}),
    ...(typeof entry.file_type === 'string' ? { file_type: entry.file_type } : {}),
    ...(typeof entry.node_kind === 'string' ? { node_kind: entry.node_kind } : {}),
    ...(typeof entry.snippet === 'string' ? { snippet: entry.snippet } : {}),
    evidence_class: evidenceClass,
    estimate_tokens: () => tokenCost,
    build_entry: () => ({ ...entry, evidence_class: evidenceClass }),
  }
}

function sampleCandidate(): ContextPackNodeCandidate<ContextPackNode> {
  return nodeCandidate({
    node_id: 'auth_service',
    label: 'AuthService',
    source_file: 'src/auth.ts',
    line_number: 10,
    file_type: 'code',
    snippet: 'export class AuthService {}',
    match_score: 9,
    relevance_band: 'direct',
    community: 0,
    community_label: 'Auth',
  }, 'primary', 5)
}

function sampleContract(prompt: string) {
  return classifyTaskContract('explain', { budget: 100, prompt })
}

describe('compileContextPack — retrieval-gate metadata (#75-ii)', () => {
  it('omits the retrieval_gate field when the caller does not supply one', () => {
    const pack = compileContextPack({
      task_contract: sampleContract('explain `AuthService`'),
      nodes: [sampleCandidate()],
    })
    expect(pack.retrieval_gate).toBeUndefined()
  })

  it('attaches the supplied retrieval_gate decision unchanged', () => {
    const decision = classifyRetrievalLevel({ prompt: 'explain `AuthService`' })
    const pack = compileContextPack({
      task_contract: sampleContract('explain `AuthService`'),
      nodes: [sampleCandidate()],
      retrieval_gate: decision,
    })

    expect(pack.retrieval_gate).toBeDefined()
    expect(pack.retrieval_gate).toEqual(decision)
    expect(pack.retrieval_gate?.intent).toBe('explain')
    expect(pack.retrieval_gate?.level).toBe(2)
    expect(pack.retrieval_gate?.skipped_retrieval).toBe(false)
  })

  it('carries the gate decision through compactContextPack (review mode)', () => {
    const decision: RetrievalGateDecision = {
      level: 5,
      skipped_retrieval: false,
      reason: 'PR diff present + review intent',
      intent: 'review',
      signals: { has_pr_diff: true, has_stack_trace: false, mentioned_paths: [], mentioned_symbols: [] },
    }
    const pack = compileContextPack({
      task_contract: classifyTaskContract('review', { budget: 100, prompt: 'review this PR' }),
      nodes: [sampleCandidate()],
      retrieval_gate: decision,
    })

    const compacted = compactContextPack(pack, { kind: 'review', seed_node_ids: ['auth_service'] })
    expect(compacted.retrieval_gate).toEqual(decision)
  })

  it('carries the gate decision through compactContextPack (retrieve mode)', () => {
    const decision: RetrievalGateDecision = {
      level: 0,
      skipped_retrieval: true,
      reason: 'manual override',
      intent: 'chitchat',
      signals: { has_pr_diff: false, has_stack_trace: false, mentioned_paths: [], mentioned_symbols: [] },
    }
    const pack = compileContextPack({
      task_contract: sampleContract('hello'),
      nodes: [sampleCandidate()],
      retrieval_gate: decision,
    })

    const compacted = compactContextPack(pack, { kind: 'retrieve' })
    expect(compacted.retrieval_gate).toEqual(decision)
    expect(compacted.retrieval_gate?.skipped_retrieval).toBe(true)
  })

  it('preserves all gate signals (paths, symbols, stack-trace flag, PR-diff flag) on the carried decision', () => {
    const decision = classifyRetrievalLevel({
      prompt: 'why does src/auth/auth-service.ts crash on `loginWithPassword`?',
      hasPrDiff: false,
    })
    const pack = compileContextPack({
      task_contract: sampleContract('why does it crash?'),
      nodes: [sampleCandidate()],
      retrieval_gate: decision,
    })

    expect(pack.retrieval_gate?.signals.mentioned_paths).toContain('src/auth/auth-service.ts')
    expect(pack.retrieval_gate?.signals.mentioned_symbols).toContain('loginWithPassword')
    expect(pack.retrieval_gate?.signals.has_pr_diff).toBe(false)
    expect(pack.retrieval_gate?.signals.has_stack_trace).toBe(false)
    expect(pack.retrieval_gate?.intent).toBe('debug')
    expect(pack.retrieval_gate?.level).toBe(3)
  })

  it('does not affect the rest of the pack when a gate decision is supplied', () => {
    const decision = classifyRetrievalLevel({ prompt: 'explain `AuthService`' })
    const withGate = compileContextPack({
      task_contract: sampleContract('explain `AuthService`'),
      nodes: [sampleCandidate()],
      retrieval_gate: decision,
    })
    const withoutGate = compileContextPack({
      task_contract: sampleContract('explain `AuthService`'),
      nodes: [sampleCandidate()],
    })

    // Pack contents are identical apart from the new metadata field.
    expect(withGate.token_count).toBe(withoutGate.token_count)
    expect(withGate.nodes).toEqual(withoutGate.nodes)
    expect(withGate.relationships).toEqual(withoutGate.relationships)
    expect(withGate.coverage).toEqual(withoutGate.coverage)
  })
})
