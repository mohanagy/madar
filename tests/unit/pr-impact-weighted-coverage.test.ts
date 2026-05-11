// Weighted coverage scoring + severity tiers (#79, v0.16 refinement).

import { describe, expect, it } from 'vitest'

import {
  compactPrImpactResult,
  type PrImpactResult,
} from '../../src/runtime/pr-impact.js'

function changedNode(label: string, sourceFile: string): PrImpactResult['changed_nodes'][number] {
  return {
    node_id: label.toLowerCase(),
    label,
    source_file: sourceFile,
    node_kind: 'function',
    community: null,
    community_label: null,
    line_number: 1,
    source_location: 'L1',
  }
}

function reviewBundleWithLabels(labels: ReadonlyArray<string>): PrImpactResult['review_bundle'] {
  return {
    budget: 1000,
    token_count: 0,
    nodes: labels.map((label) => ({
      label,
      source_file: 'src/x.ts',
      line_number: 1,
      node_kind: 'function',
      file_type: 'code',
      snippet: null,
      match_score: 0,
      relevance_band: 'direct',
      community: null,
      community_label: null,
    })),
    relationships: [],
    community_context: [],
  }
}

function fixture(opts: {
  highImpact: string[]
  reviewLabels: string[]
  criticalLabels: string[]
  changed: string[]
}): PrImpactResult {
  return {
    base_branch: 'main',
    changed_files: [],
    changed_ranges: [],
    changed_nodes: opts.changed.map((label) => changedNode(label, 'src/x.ts')),
    seed_nodes: [],
    per_node_impact: [],
    total_blast_radius: 0,
    affected_files: [],
    affected_communities: [],
    review_context: { supporting_paths: [], test_paths: [], hotspots: [] },
    review_bundle: reviewBundleWithLabels(opts.reviewLabels),
    risk_summary: {
      high_impact_nodes: [...opts.highImpact],
      cross_community_changes: 0,
      top_risks: [],
    },
    coverage_score: 0.5,
    uncovered_hotspots: [],
    coverage_score_weighted: 0.5,
    uncovered_hotspot_severities: [],
    critical_labels: [...opts.criticalLabels],
  }
}

describe('Weighted coverage score (#79 v0.16)', () => {
  it('compactPrImpactResult emits coverage_score_weighted', () => {
    const result = fixture({
      highImpact: ['a', 'b'],
      reviewLabels: ['a'],
      criticalLabels: [],
      changed: ['a', 'b'],
    })
    const compact = compactPrImpactResult(result)
    expect(typeof compact.coverage_score_weighted).toBe('number')
  })

  it('critical labels weight 3x in the compact score', () => {
    // a is critical, b is regular. Review covers only b.
    // Unweighted: 1/2 = 0.5. Weighted: 1 / (3+1) = 0.25.
    const result = fixture({
      highImpact: ['a', 'b'],
      reviewLabels: ['b'],
      criticalLabels: ['a'],
      changed: ['a', 'b'],
    })
    const compact = compactPrImpactResult(result)
    expect(compact.coverage_score).toBe(0.5)
    expect(compact.coverage_score_weighted).toBe(0.25)
  })

  it('critical-only review gives 0.75 weighted (3/(3+1)) — bias toward critical coverage', () => {
    const result = fixture({
      highImpact: ['a', 'b'],
      reviewLabels: ['a'],
      criticalLabels: ['a'],
      changed: ['a', 'b'],
    })
    const compact = compactPrImpactResult(result)
    expect(compact.coverage_score).toBe(0.5)
    expect(compact.coverage_score_weighted).toBe(0.75)
  })

  it('uncovered hotspots get severity tiers: critical / high', () => {
    const result = fixture({
      highImpact: ['critical_node', 'regular_node'],
      reviewLabels: [],
      criticalLabels: ['critical_node'],
      changed: ['critical_node', 'regular_node'],
    })
    const compact = compactPrImpactResult(result)
    const severities = new Map(compact.uncovered_hotspot_severities.map((s) => [s.label, s.severity]))
    expect(severities.get('critical_node')).toBe('critical')
    expect(severities.get('regular_node')).toBe('high')
  })

  it('returns 1.0 weighted score when there are no high-impact hotspots', () => {
    const result = fixture({
      highImpact: [],
      reviewLabels: [],
      criticalLabels: [],
      changed: [],
    })
    const compact = compactPrImpactResult(result)
    expect(compact.coverage_score_weighted).toBe(1)
  })
})
