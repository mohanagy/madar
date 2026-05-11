// Context-pack quality diagnostics tests (#78).
// Pure unit tests against synthetic CompiledContextPack inputs — no I/O,
// no graph build. Validates every rule fires when expected, doesn't fire
// when not expected, and the quality_score moves in the right direction.

import { describe, expect, it } from 'vitest'

import type {
  CompiledContextPack,
  ContextPackClaim,
  ContextPackNode,
  ContextPackRelationship,
  ContextPackTaskContract,
} from '../../src/contracts/context-pack.js'
import { computeContextPackDiagnostics } from '../../src/runtime/context-pack-diagnostics.js'

function taskContract(overrides: Partial<ContextPackTaskContract> = {}): ContextPackTaskContract {
  return {
    version: 1,
    task_kind: 'explain',
    evidence_recipe_id: 'explain',
    budget: 3000,
    required_evidence: ['primary'],
    preferred_evidence: ['supporting'],
    semantic_required: ['implementation'],
    semantic_optional: ['tests'],
    ...overrides,
  }
}

function makeNode(overrides: Partial<ContextPackNode> = {}): ContextPackNode {
  return {
    node_id: overrides.node_id ?? 'node-1',
    label: 'fooBar()',
    source_file: '/repo/src/foo.ts',
    line_number: 10,
    snippet: 'export function fooBar() { return 1 }',
    match_score: 0.8,
    ...overrides,
  }
}

function makeRelationship(from: string, to: string, relation = 'calls'): ContextPackRelationship {
  return { from_id: from, from, to_id: to, to, relation }
}

function makeClaim(text = 'fooBar returns 1'): ContextPackClaim {
  return { evidence_class: 'primary', text, node_labels: ['fooBar()'] }
}

function makePack(overrides: Partial<CompiledContextPack> = {}): CompiledContextPack {
  const base: CompiledContextPack = {
    task_contract: taskContract(),
    token_count: 800,
    nodes: [
      makeNode({ node_id: 'a' }),
      makeNode({ node_id: 'b', label: 'baz()', match_score: 0.6 }),
      makeNode({ node_id: 'c', label: 'qux()', match_score: 0.7 }),
    ],
    relationships: [
      makeRelationship('a', 'b'),
      makeRelationship('b', 'c'),
    ],
    community_context: [],
    claims: [makeClaim(), makeClaim('baz calls qux')],
    expandable: [],
    coverage: {
      required_evidence: ['primary'],
      semantic_required: ['implementation'],
      semantic_optional: ['tests'],
      entries: [],
      semantic_entries: [],
      missing_required: [],
      missing_semantic: [],
      available_relationships: 2,
      selected_relationships: 2,
    },
    graph_signals: { god_nodes: ['Logger'], bridge_nodes: [] },
  }
  return { ...base, ...overrides }
}

describe('computeContextPackDiagnostics', () => {
  it('emits zero warnings on a healthy pack', () => {
    const diag = computeContextPackDiagnostics(makePack())
    expect(diag.warnings).toEqual([])
    expect(diag.quality_score).toBe(1)
    expect(diag.signals.node_count).toBe(3)
    expect(diag.signals.relationship_count).toBe(2)
    expect(diag.signals.claim_count).toBe(2)
    expect(diag.signals.snippet_coverage).toBe(1)
  })

  it('flags missing_required_evidence as error', () => {
    const diag = computeContextPackDiagnostics(makePack({
      coverage: {
        required_evidence: ['primary'],
        semantic_required: ['implementation'],
        semantic_optional: [],
        entries: [],
        semantic_entries: [],
        missing_required: ['primary'],
        missing_semantic: [],
        available_relationships: 2,
        selected_relationships: 2,
      },
    }))
    const warning = diag.warnings.find((w) => w.kind === 'missing_required_evidence')
    expect(warning?.severity).toBe('error')
    expect(warning?.detail).toEqual({ classes: ['primary'] })
    expect(diag.quality_score).toBeLessThan(1)
  })

  it('flags missing_required_semantic as warn', () => {
    const diag = computeContextPackDiagnostics(makePack({
      coverage: {
        required_evidence: ['primary'],
        semantic_required: ['implementation'],
        semantic_optional: [],
        entries: [],
        semantic_entries: [],
        missing_required: [],
        missing_semantic: ['implementation'],
        available_relationships: 2,
        selected_relationships: 2,
      },
    }))
    const warning = diag.warnings.find((w) => w.kind === 'missing_required_semantic')
    expect(warning?.severity).toBe('warn')
  })

  it('flags zero_claims when claims array is empty', () => {
    const diag = computeContextPackDiagnostics(makePack({ claims: [] }))
    expect(diag.warnings.map((w) => w.kind)).toContain('zero_claims')
  })

  it('flags undersized_retrieval when fewer than 3 nodes', () => {
    const diag = computeContextPackDiagnostics(makePack({
      nodes: [makeNode({ node_id: 'a' }), makeNode({ node_id: 'b', label: 'baz()' })],
      relationships: [makeRelationship('a', 'b')],
    }))
    const warning = diag.warnings.find((w) => w.kind === 'undersized_retrieval')
    expect(warning?.detail).toEqual({ node_count: 2, threshold: 3 })
  })

  it('flags budget_underutilized when token_count is far below the budget', () => {
    const diag = computeContextPackDiagnostics(makePack({
      task_contract: taskContract({ budget: 4000 }),
      token_count: 200,
    }))
    const warning = diag.warnings.find((w) => w.kind === 'budget_underutilized')
    expect(warning?.severity).toBe('info')
  })

  it('does NOT flag budget_underutilized when skipBudgetUnderutilization is set', () => {
    const diag = computeContextPackDiagnostics(
      makePack({ token_count: 200 }),
      { skipBudgetUnderutilization: true },
    )
    expect(diag.warnings.map((w) => w.kind)).not.toContain('budget_underutilized')
  })

  it('flags missing_snippets when more than 50% of nodes lack a snippet', () => {
    const diag = computeContextPackDiagnostics(makePack({
      nodes: [
        makeNode({ node_id: 'a', snippet: null }),
        makeNode({ node_id: 'b', snippet: null }),
        makeNode({ node_id: 'c', snippet: 'has source' }),
      ],
    }))
    const warning = diag.warnings.find((w) => w.kind === 'missing_snippets')
    expect(warning?.severity).toBe('warn')
  })

  it('flags low_avg_match_score even when average is exactly 0 (CodeRabbit fix)', () => {
    // The worst-case retrieval is 0 match-score across the board. The
    // predicate must NOT exclude that case via a `> 0` clause — only the
    // NaN guard protects against "no scored nodes at all".
    const diag = computeContextPackDiagnostics(makePack({
      nodes: [
        makeNode({ node_id: 'a', match_score: 0 }),
        makeNode({ node_id: 'b', match_score: 0 }),
        makeNode({ node_id: 'c', match_score: 0 }),
      ],
    }))
    expect(diag.signals.avg_match_score).toBe(0)
    expect(diag.warnings.map((w) => w.kind)).toContain('low_avg_match_score')
  })

  it('flags low_avg_match_score when average is below 0.30', () => {
    const diag = computeContextPackDiagnostics(makePack({
      nodes: [
        makeNode({ node_id: 'a', match_score: 0.1 }),
        makeNode({ node_id: 'b', match_score: 0.2 }),
        makeNode({ node_id: 'c', match_score: 0.15 }),
      ],
    }))
    expect(diag.warnings.map((w) => w.kind)).toContain('low_avg_match_score')
  })

  it('flags orphan_nodes when nodes>1 but no relationships', () => {
    const diag = computeContextPackDiagnostics(makePack({
      relationships: [],
    }))
    expect(diag.warnings.map((w) => w.kind)).toContain('orphan_nodes')
  })

  it('flags no_graph_signals when both god/bridge are empty and nodes>=3', () => {
    const diag = computeContextPackDiagnostics(makePack({
      graph_signals: { god_nodes: [], bridge_nodes: [] },
    }))
    const warning = diag.warnings.find((w) => w.kind === 'no_graph_signals')
    expect(warning?.severity).toBe('info')
  })

  it('orders warnings by severity (error → warn → info) then by kind', () => {
    const diag = computeContextPackDiagnostics(makePack({
      claims: [],
      task_contract: taskContract({ budget: 4000 }),
      token_count: 200,
      coverage: {
        required_evidence: ['primary'],
        semantic_required: [],
        semantic_optional: [],
        entries: [],
        semantic_entries: [],
        missing_required: ['primary'],
        missing_semantic: [],
        available_relationships: 0,
        selected_relationships: 0,
      },
    }))
    const severities = diag.warnings.map((w) => w.severity)
    // Errors come first, then warns, then infos.
    let mode: 'error' | 'warn' | 'info' = 'error'
    for (const sev of severities) {
      if (mode === 'error' && sev === 'warn') mode = 'warn'
      else if (mode === 'warn' && sev === 'info') mode = 'info'
      expect(sev === mode || (mode === 'warn' && sev === 'info') || (mode === 'info' && sev === 'info')).toBe(true)
    }
    expect(severities[0]).toBe('error')
  })

  it('quality_score collapses for a pathologically bad pack', () => {
    const diag = computeContextPackDiagnostics(makePack({
      nodes: [],
      relationships: [],
      claims: [],
      token_count: 0,
      coverage: {
        required_evidence: ['primary'],
        semantic_required: ['implementation'],
        semantic_optional: [],
        entries: [],
        semantic_entries: [],
        missing_required: ['primary'],
        missing_semantic: ['implementation'],
        available_relationships: 0,
        selected_relationships: 0,
      },
      graph_signals: { god_nodes: [], bridge_nodes: [] },
    }))
    expect(diag.quality_score).toBeLessThanOrEqual(0.5)
    expect(diag.warnings.length).toBeGreaterThanOrEqual(4)
  })

  it('quality_score is between 0 and 1 and rounded to 3 decimals', () => {
    const diag = computeContextPackDiagnostics(makePack({ claims: [] }))
    expect(diag.quality_score).toBeGreaterThanOrEqual(0)
    expect(diag.quality_score).toBeLessThanOrEqual(1)
    expect(diag.quality_score).toEqual(Number(diag.quality_score.toFixed(3)))
  })

  it('signals.avg_match_score is NaN when no scored nodes exist', () => {
    const diag = computeContextPackDiagnostics(makePack({
      nodes: [
        makeNode({ node_id: 'a', match_score: undefined }),
        makeNode({ node_id: 'b', match_score: undefined }),
        makeNode({ node_id: 'c', match_score: undefined }),
      ],
    }))
    expect(Number.isNaN(diag.signals.avg_match_score)).toBe(true)
    // The low_avg_match_score rule should NOT fire when no scores exist.
    expect(diag.warnings.map((w) => w.kind)).not.toContain('low_avg_match_score')
  })

  it('does not flag undersized_retrieval when node_count is 0 (handled by orphan/missing rules)', () => {
    const diag = computeContextPackDiagnostics(makePack({
      nodes: [],
      relationships: [],
      claims: [],
    }))
    expect(diag.warnings.map((w) => w.kind)).not.toContain('undersized_retrieval')
  })
})
