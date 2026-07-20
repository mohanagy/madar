import { describe, expect, it, vi } from 'vitest'

import type { ContextPackCoverage, ContextPackExpandableRef } from '../../src/contracts/context-pack.js'
import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import { recoverContextPackResult } from '../../src/runtime/context-pack-recovery.js'
import type { RetrieveResult } from '../../src/runtime/retrieve.js'

function conceptualPlan(finallyCovered: number): NonNullable<RetrieveResult['retrieval_plan']> {
  const quality = {
    selected_nodes: 1,
    selected_files: 1,
    direct_matches: 1,
    explicit_anchors: 0,
    workflow_coherence: 0.5,
    missing_required_evidence: 0,
    missing_semantic_evidence: 0,
    token_count: 100,
  }
  return {
    version: 1,
    status: 'recovered',
    reasons: ['missing_query_obligations'],
    initial: quality,
    final: quality,
    attempts: [],
    query_obligations: {
      total: 1,
      initially_covered: 0,
      finally_covered: finallyCovered,
    },
  }
}

function coverage(supportingCovered: boolean): ContextPackCoverage {
  return {
    required_evidence: ['primary', 'supporting'],
    semantic_required: [],
    semantic_optional: [],
    entries: [
      { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
      {
        evidence_class: 'supporting',
        required: true,
        available_nodes: 1,
        selected_nodes: supportingCovered ? 1 : 0,
        status: supportingCovered ? 'covered' : 'available',
      },
    ],
    semantic_entries: [],
    missing_required: supportingCovered ? [] : ['supporting'],
    missing_semantic: [],
    available_relationships: 1,
    selected_relationships: supportingCovered ? 1 : 0,
  }
}

function target(handleId: string, sourceFile: string): ContextPackExpandableRef {
  return {
    kind: 'nodes',
    handle_id: handleId,
    evidence_class: 'supporting',
    count: 1,
    preview: [{ node_id: sourceFile, label: sourceFile, source_file: `src/${sourceFile}.ts` }],
    follow_up: {
      kind: 'context_pack',
      task_kind: 'explain',
      evidence_class: 'supporting',
      focus_files: [`src/${sourceFile}.ts`],
      focus_ranges: [],
    },
  }
}

function result(input: {
  supportingCovered: boolean
  expandable?: ContextPackExpandableRef[]
  includeSupportingNode?: boolean
}): RetrieveResult {
  const nodes: RetrieveResult['matched_nodes'] = [{
    node_id: 'primary',
    label: 'PrimaryController.run',
    source_file: 'src/primary.ts',
    line_number: 1,
    file_type: 'code',
    snippet: 'run()',
    match_score: 2,
    relevance_band: 'direct',
    community: 0,
    community_label: 'Workflow',
    evidence_class: 'primary',
  }]
  if (input.includeSupportingNode) {
    nodes.push({
      node_id: 'supporting',
      label: 'SupportingStore.save',
      source_file: 'src/supporting.ts',
      line_number: 1,
      file_type: 'code',
      // The recovery result must prove the prompt's workflow-persistence
      // obligation in a selected source snippet, not merely add a node whose
      // label sounds related.
      snippet: 'await workflow.persist(record)',
      match_score: 1,
      relevance_band: 'related',
      community: 0,
      community_label: 'Workflow',
      evidence_class: 'supporting',
    })
  }
  return {
    question: 'How does the workflow persist?',
    token_count: input.includeSupportingNode ? 180 : 100,
    matched_nodes: nodes,
    relationships: input.includeSupportingNode
      ? [{ from_id: 'primary', from: 'PrimaryController.run', to_id: 'supporting', to: 'SupportingStore.save', relation: 'calls' }]
      : [],
    community_context: [{ id: 0, label: 'Workflow', node_count: 2 }],
    graph_signals: { god_nodes: [], bridge_nodes: [] },
    coverage: coverage(input.supportingCovered),
    expandable: input.expandable ?? [],
  }
}

function recoveryGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.addNode('primary', { label: 'PrimaryController.run', source_file: 'src/primary.ts', file_type: 'code' })
  graph.addNode('supporting', { label: 'SupportingStore.save', source_file: 'src/supporting.ts', file_type: 'code' })
  graph.addNode('alternate', { label: 'AlternateVerifier.check', source_file: 'src/alternate.ts', file_type: 'code' })
  graph.addEdge('primary', 'supporting', { relation: 'calls' })
  return graph
}

describe('bounded cumulative context-pack recovery', () => {
  it('merges the original and focused evidence and accepts a genuinely improved result', () => {
    const initial = result({ supportingCovered: false, expandable: [target('expand-supporting', 'supporting')] })
    const recovered = result({ supportingCovered: true, includeSupportingNode: true })
    const runPass = vi.fn((boosts: ReadonlyMap<string, number>) => {
      expect(boosts.has('primary')).toBe(true)
      expect(boosts.has('supporting')).toBe(true)
      expect(boosts.get('primary')).toBeGreaterThan(boosts.get('supporting') ?? 0)
      return recovered
    })

    const output = recoverContextPackResult(
      recoveryGraph(),
      initial,
      { question: initial.question, budget: 500 },
      runPass,
    )

    expect(runPass).toHaveBeenCalledTimes(1)
    expect(output.matched_nodes.map((node) => node.node_id)).toEqual(['primary', 'supporting'])
    expect(new Set(output.matched_nodes.map((node) => node.node_id)).size).toBe(output.matched_nodes.length)
    expect(output.recovery).toMatchObject({
      status: 'improved',
      initial_state: 'verify_targets',
      final_state: 'ready',
      improved: true,
      budget: {
        max_attempts: 2,
        max_candidate_nodes: 64,
        max_elapsed_ms: 750,
        output_token_budget: 500,
      },
      attempts: [expect.objectContaining({
        status: 'improved',
        changed_result: true,
        missing_obligations_before: 2,
        missing_obligations_after: 0,
      })],
    })
  })

  it('reconciles conceptual query coverage after a later accepted recovery pass', () => {
    const initial = {
      ...result({ supportingCovered: false, expandable: [target('expand-supporting', 'supporting')] }),
      retrieval_plan: conceptualPlan(0),
    }
    const recovered = result({ supportingCovered: true, includeSupportingNode: true })

    const output = recoverContextPackResult(
      recoveryGraph(),
      initial,
      { question: initial.question, budget: 500 },
      () => recovered,
    )

    expect(output.retrieval_plan?.query_obligations).toEqual({
      total: 1,
      initially_covered: 0,
      finally_covered: 1,
    })
  })

  it('keeps the cumulative prior result when two bounded attempts remain partial', () => {
    const targets = [target('expand-supporting', 'supporting'), target('expand-alternate', 'alternate')]
    const initial = result({ supportingCovered: false, expandable: targets })
    const runPass = vi.fn(() => result({ supportingCovered: false, expandable: targets }))

    const output = recoverContextPackResult(
      recoveryGraph(),
      initial,
      { question: initial.question, budget: 500 },
      runPass,
    )

    expect(runPass).toHaveBeenCalledTimes(2)
    expect(output.matched_nodes).toEqual(initial.matched_nodes)
    expect(output.recovery).toMatchObject({
      status: 'exhausted',
      initial_state: 'verify_targets',
      final_state: 'verify_targets',
      improved: false,
      attempts: [
        expect.objectContaining({ status: 'kept_prior', changed_result: false }),
        expect.objectContaining({ status: 'kept_prior', changed_result: false }),
      ],
    })
  })

  it('runtime-normalizes invalid untyped recovery budgets', () => {
    const targets = [
      target('expand-supporting', 'supporting'),
      target('expand-alternate', 'alternate'),
      target('expand-third', 'third'),
    ]
    const graph = recoveryGraph()
    graph.addNode('third', { label: 'ThirdVerifier.check', source_file: 'src/third.ts', file_type: 'code' })
    const initial = result({ supportingCovered: false, expandable: targets })
    for (const recoveryOptions of [
      { maxAttempts: 99 as 2 },
      {
        maxAttempts: Number.NaN as 2,
        maxCandidateNodes: Number.NaN,
        maxElapsedMs: Number.NaN,
      },
    ]) {
      const runPass = vi.fn(() => result({ supportingCovered: false, expandable: targets }))
      const output = recoverContextPackResult(
        graph,
        initial,
        { question: initial.question, budget: 500 },
        runPass,
        recoveryOptions,
      )

      expect(runPass).toHaveBeenCalledTimes(2)
      expect(output.recovery).toMatchObject({
        status: 'exhausted',
        budget: {
          max_attempts: 2,
          max_candidate_nodes: 64,
          max_elapsed_ms: 750,
          output_token_budget: 500,
        },
        attempts: [
          expect.objectContaining({ attempt: 1 }),
          expect.objectContaining({ attempt: 2 }),
        ],
      })
    }
  })

  it('returns insufficient without broad retry when there are no exact targets', () => {
    const initial: RetrieveResult = {
      question: 'quasar marmalade',
      token_count: 0,
      matched_nodes: [],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
    }
    const runPass = vi.fn(() => initial)

    const output = recoverContextPackResult(
      recoveryGraph(),
      initial,
      { question: initial.question, budget: 300 },
      runPass,
    )

    expect(runPass).not.toHaveBeenCalled()
    expect(output.recovery).toMatchObject({
      status: 'no_targets',
      initial_state: 'insufficient',
      final_state: 'insufficient',
      attempts: [],
      improved: false,
    })
  })

  it('caps new expansion candidates without letting retained originals consume the allowance', () => {
    const graph = recoveryGraph()
    graph.addNode('supporting-extra', {
      label: 'SupportingStore.audit',
      source_file: 'src/supporting.ts',
      file_type: 'code',
    })
    const initial = result({ supportingCovered: false, expandable: [target('expand-supporting', 'supporting')] })
    const recovered = result({ supportingCovered: true, includeSupportingNode: true })
    const runPass = vi.fn((boosts: ReadonlyMap<string, number>) => {
      expect(boosts.size).toBe(2)
      expect(boosts.has('primary')).toBe(true)
      expect(boosts.has('supporting')).toBe(true)
      expect(boosts.has('supporting-extra')).toBe(false)
      return recovered
    })

    const output = recoverContextPackResult(
      graph,
      initial,
      { question: initial.question, budget: 500 },
      runPass,
      { maxCandidateNodes: 1 },
    )

    expect(runPass).toHaveBeenCalledTimes(1)
    expect(output.recovery?.budget.max_candidate_nodes).toBe(1)
    expect(output.recovery?.attempts[0]?.candidate_nodes).toBe(1)
  })

  it('rejects a recovery pass that exceeds the output-token budget', () => {
    const initial = result({ supportingCovered: false, expandable: [target('expand-supporting', 'supporting')] })
    const overBudget = { ...result({ supportingCovered: true, includeSupportingNode: true }), token_count: 501 }
    const runPass = vi.fn(() => overBudget)

    const output = recoverContextPackResult(
      recoveryGraph(),
      initial,
      { question: initial.question, budget: 500 },
      runPass,
    )

    expect(output.matched_nodes).toEqual(initial.matched_nodes)
    expect(output.recovery).toMatchObject({
      status: 'budget_exhausted',
      final_state: 'verify_targets',
      improved: false,
      attempts: [expect.objectContaining({
        status: 'budget_exhausted',
        selected_nodes_after: initial.matched_nodes.length,
        changed_result: false,
      })],
    })

    const invalidBudgetOutput = recoverContextPackResult(
      recoveryGraph(),
      initial,
      { question: initial.question, budget: Number.NaN },
      runPass,
    )
    expect(invalidBudgetOutput.recovery).toMatchObject({
      status: 'budget_exhausted',
      budget: { output_token_budget: 1 },
    })
  })

  it('preserves a partial-improvement status when a later attempt exceeds its budget', () => {
    const targets = [target('expand-supporting', 'supporting'), target('expand-alternate', 'alternate')]
    const initial = result({ supportingCovered: false, expandable: targets })
    const partial = result({ supportingCovered: false, expandable: targets })
    partial.coverage = { ...partial.coverage!, selected_relationships: 1 }
    partial.relationships = [{
      from_id: 'primary',
      from: 'PrimaryController.run',
      to_id: 'supporting',
      to: 'SupportingStore.save',
      relation: 'calls',
    }]
    const overBudget = { ...result({ supportingCovered: true, includeSupportingNode: true }), token_count: 501 }
    const runPass = vi.fn()
      .mockReturnValueOnce(partial)
      .mockReturnValueOnce(overBudget)

    const output = recoverContextPackResult(
      recoveryGraph(),
      initial,
      { question: initial.question, budget: 500 },
      runPass,
    )

    expect(output.relationships).toEqual(partial.relationships)
    expect(output.recovery).toMatchObject({
      status: 'partial',
      final_state: 'verify_targets',
      improved: true,
      attempts: [
        expect.objectContaining({ status: 'improved' }),
        expect.objectContaining({ status: 'budget_exhausted' }),
      ],
    })
  })

  it('stops between synchronous passes when the elapsed-time budget is exhausted', () => {
    const targets = [target('expand-supporting', 'supporting'), target('expand-alternate', 'alternate')]
    const initial = result({ supportingCovered: false, expandable: targets })
    const runPass = vi.fn(() => {
      const started = performance.now()
      while (performance.now() - started < 3) {
        // The retrieval pass is synchronous, so the budget is enforced before
        // another pass begins rather than interrupting a graph operation.
      }
      return result({ supportingCovered: false, expandable: targets })
    })

    const output = recoverContextPackResult(
      recoveryGraph(),
      initial,
      { question: initial.question, budget: 500 },
      runPass,
      { maxElapsedMs: 1 },
    )

    expect(runPass).toHaveBeenCalledTimes(1)
    expect(output.recovery).toMatchObject({
      status: 'budget_exhausted',
      final_state: 'verify_targets',
      budget: { max_elapsed_ms: 1 },
    })
  })

  it('does not relabel a completed final attempt as a time-budget abort', () => {
    const initial = result({ supportingCovered: false, expandable: [target('expand-supporting', 'supporting')] })
    const runPass = vi.fn(() => {
      const started = performance.now()
      while (performance.now() - started < 3) {
        // A synchronous final pass can finish after the wall-clock allowance;
        // only a prevented next pass is reported as a time-budget abort.
      }
      return result({ supportingCovered: false, expandable: initial.expandable ?? [] })
    })

    const output = recoverContextPackResult(
      recoveryGraph(),
      initial,
      { question: initial.question, budget: 500 },
      runPass,
      { maxAttempts: 1, maxElapsedMs: 1 },
    )

    expect(runPass).toHaveBeenCalledTimes(1)
    expect(output.recovery).toMatchObject({
      status: 'exhausted',
      final_state: 'verify_targets',
      attempts: [expect.objectContaining({ status: 'kept_prior' })],
    })
  })
})
