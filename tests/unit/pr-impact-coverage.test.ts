import { describe, expect, it } from 'vitest'

import {
  compactPrImpactResult,
  type PrImpactResult,
} from '../../src/runtime/pr-impact.js'

// #79 — focused coverage_score / uncovered_hotspots tests. Constructs
// PrImpactResult fixtures directly so the unit under test is the coverage
// computation in analyzePrImpact's return shape, not git/diff parsing.

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
  highImpactNodes: ReadonlyArray<string>
  changedNodes: ReadonlyArray<{ label: string; sourceFile: string }>
  reviewLabels: ReadonlyArray<string>
  coverageScore: number
  uncoveredLabels: ReadonlyArray<string>
}): PrImpactResult {
  // Smallest valid PrImpactResult that exercises the coverage logic.
  return {
    base_branch: 'main',
    changed_files: [],
    changed_ranges: [],
    changed_nodes: opts.changedNodes.map((n) => changedNode(n.label, n.sourceFile)),
    seed_nodes: [],
    per_node_impact: [],
    total_blast_radius: 0,
    affected_files: [],
    affected_communities: [],
    review_context: { supporting_paths: [], test_paths: [], hotspots: [] },
    review_bundle: reviewBundleWithLabels(opts.reviewLabels),
    risk_summary: {
      high_impact_nodes: [...opts.highImpactNodes],
      cross_community_changes: 0,
      top_risks: [],
    },
    coverage_score: opts.coverageScore,
    uncovered_hotspots: opts.uncoveredLabels.map((label) => changedNode(label, 'src/x.ts')),
    coverage_score_weighted: opts.coverageScore,
    uncovered_hotspot_severities: opts.uncoveredLabels.map((label) => ({ label, severity: 'high' as const })),
    critical_labels: [],
  }
}

describe('PR-impact coverage scoring (#79)', () => {
  it('compactPrImpactResult preserves coverage_score and uncovered_hotspots', () => {
    const full = fixture({
      highImpactNodes: ['authService', 'sessionStore'],
      changedNodes: [
        { label: 'authService', sourceFile: 'src/auth.ts' },
        { label: 'sessionStore', sourceFile: 'src/session.ts' },
      ],
      reviewLabels: ['authService'],
      coverageScore: 0.5,
      uncoveredLabels: ['sessionStore'],
    })

    const compact = compactPrImpactResult(full)
    expect(compact.coverage_score).toBe(0.5)
    expect(compact.uncovered_hotspots).toHaveLength(1)
    expect(compact.uncovered_hotspots[0]?.label).toBe('sessionStore')
  })

  it('coverage_score 1.0 with no uncovered hotspots when every high-impact node is in the review bundle', () => {
    const full = fixture({
      highImpactNodes: ['authService'],
      changedNodes: [{ label: 'authService', sourceFile: 'src/auth.ts' }],
      reviewLabels: ['authService'],
      coverageScore: 1,
      uncoveredLabels: [],
    })
    const compact = compactPrImpactResult(full)
    expect(compact.coverage_score).toBe(1)
    expect(compact.uncovered_hotspots).toHaveLength(0)
  })

  it('coverage_score 0.0 when no high-impact node survives compaction into the review bundle', () => {
    const full = fixture({
      highImpactNodes: ['authService', 'sessionStore'],
      changedNodes: [
        { label: 'authService', sourceFile: 'src/auth.ts' },
        { label: 'sessionStore', sourceFile: 'src/session.ts' },
      ],
      reviewLabels: ['somethingElse'],
      coverageScore: 0,
      uncoveredLabels: ['authService', 'sessionStore'],
    })
    const compact = compactPrImpactResult(full)
    expect(compact.coverage_score).toBe(0)
    expect(compact.uncovered_hotspots).toHaveLength(2)
  })

  it('CodeRabbit follow-up: coverage is recomputed against the POST-compaction review bundle, not inherited verbatim', () => {
    // Construct a fixture where every high-impact node DOES appear in the
    // full review bundle (full coverage_score = 1.0 in the verbose result),
    // but where the bundle is large enough that compactReviewBundle drops
    // some of those same nodes during compaction. The compact result must
    // honestly report the post-compaction coverage, not the verbose one.
    // Use 12 high-impact nodes; compactReviewBundle's per-evidence-class
    // caps will drop most, so the compact coverage_score should be < 1.
    const labels = Array.from({ length: 12 }, (_, i) => `Hotspot${i + 1}`)
    const full: PrImpactResult = {
      base_branch: 'main',
      changed_files: [],
      changed_ranges: [],
      changed_nodes: labels.map((label) => changedNode(label, 'src/x.ts')),
      seed_nodes: labels.map((label) => ({ ...changedNode(label, 'src/x.ts'), match_kind: 'line' })),
      per_node_impact: [],
      total_blast_radius: 0,
      affected_files: [],
      affected_communities: [],
      review_context: { supporting_paths: [], test_paths: [], hotspots: [] },
      review_bundle: reviewBundleWithLabels(labels),
      risk_summary: {
        high_impact_nodes: labels,
        cross_community_changes: 0,
        top_risks: [],
      },
      // Verbose claims full coverage; compact must NOT inherit this.
      coverage_score: 1,
      uncovered_hotspots: [],
      coverage_score_weighted: 1,
      uncovered_hotspot_severities: [],
      critical_labels: [],
    }

    const compact = compactPrImpactResult(full)
    // The compact bundle MAY contain all 12 nodes if the budget allows it,
    // OR fewer if compactReviewBundle dropped some. Either way, the compact
    // coverage_score must reflect the compact bundle's actual contents —
    // not be slavishly copied from the verbose 1.0.
    const compactReviewLabels = new Set(compact.review_bundle.nodes.map((n) => n.label))
    const expectedCovered = labels.filter((label) => compactReviewLabels.has(label)).length
    const expectedScore = labels.length === 0 ? 1 : expectedCovered / labels.length
    expect(compact.coverage_score).toBeCloseTo(expectedScore, 5)
    // And uncovered_hotspots is the symmetric set.
    const expectedUncoveredCount = labels.filter((label) => !compactReviewLabels.has(label)).length
    expect(compact.uncovered_hotspots).toHaveLength(expectedUncoveredCount)
  })

  it('coverage_score is 1.0 by convention when there are no high-impact nodes', () => {
    const full = fixture({
      highImpactNodes: [],
      changedNodes: [{ label: 'minorChange', sourceFile: 'src/x.ts' }],
      reviewLabels: [],
      coverageScore: 1,
      uncoveredLabels: [],
    })
    const compact = compactPrImpactResult(full)
    expect(compact.coverage_score).toBe(1)
  })
})
