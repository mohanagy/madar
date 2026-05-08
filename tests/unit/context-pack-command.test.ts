import { describe, expect, it, vi } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { runContextPackCommand, type ContextPackCommandDependencies } from '../../src/infrastructure/context-pack-command.js'

describe('context-pack-command', () => {
  it('emits a compact deterministic explain pack', async () => {
    const graph = new KnowledgeGraph()
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn().mockReturnValue({
        question: 'how does auth work',
        token_count: 42,
        matched_nodes: [],
        relationships: [],
        community_context: [],
        graph_signals: { god_nodes: [], bridge_nodes: [] },
      }),
      compactRetrieveResult: vi.fn().mockReturnValue({
        question: 'how does auth work',
        token_count: 18,
        matched_nodes: [
          {
            label: 'AuthService',
            source_file: 'src/auth.ts',
            line_number: 12,
            snippet: 'export class AuthService {}',
            relevance_band: 'direct',
            community: 0,
          },
        ],
        relationships: [],
        community_context: [],
        graph_signals: { god_nodes: [], bridge_nodes: [] },
        shared_file_type: 'code',
      }),
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    const output = await runContextPackCommand({
      prompt: 'how does auth work',
      budget: 1800,
      task: 'explain',
      graphPath: 'graphify-out/graph.json',
    }, dependencies)

    const expected = {
      task: 'explain',
      prompt: 'how does auth work',
      budget: 1800,
      graph_path: 'graphify-out/graph.json',
      pack: {
        question: 'how does auth work',
        token_count: 18,
        matched_nodes: [
          {
            label: 'AuthService',
            source_file: 'src/auth.ts',
            line_number: 12,
            snippet: 'export class AuthService {}',
            relevance_band: 'direct',
            community: 0,
          },
        ],
        relationships: [],
        community_context: [],
        graph_signals: { god_nodes: [], bridge_nodes: [] },
        shared_file_type: 'code',
      },
    }

    expect(dependencies.loadGraph).toHaveBeenCalledWith('graphify-out/graph.json')
    expect(dependencies.retrieveContext).toHaveBeenCalledWith(graph, {
      question: 'how does auth work',
      budget: 1800,
    })
    expect(output).toBe(JSON.stringify(expected))
  })

  it('emits a compact deterministic review pack', async () => {
    const graph = new KnowledgeGraph()
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn(),
      compactRetrieveResult: vi.fn(),
      analyzePrImpact: vi.fn().mockReturnValue({
        base_branch: 'origin/main',
      }),
      compactPrImpactResult: vi.fn().mockReturnValue({
        base_branch: 'origin/main',
        changed_files: ['src/auth.ts'],
        changed_ranges: [],
        seed_nodes: [],
        per_node_impact: [],
        total_blast_radius: 0,
        affected_communities: [],
        review_context: {
          supporting_paths: [],
          test_paths: [],
          hotspots: [],
        },
        review_bundle: {
          budget: 1800,
          token_count: 12,
          nodes: [],
          relationships: [],
          community_context: [],
        },
        risk_summary: {
          high_impact_nodes: [],
          cross_community_changes: 0,
          top_risks: [],
        },
      }),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    const output = await runContextPackCommand({
      prompt: 'review current diff',
      budget: 1800,
      task: 'review',
      graphPath: 'graphify-out/graph.json',
    }, dependencies)

    expect(dependencies.analyzePrImpact).toHaveBeenCalledWith(graph, '.', { budget: 1800 })
    expect(output).toBe(JSON.stringify({
      task: 'review',
      prompt: 'review current diff',
      budget: 1800,
      graph_path: 'graphify-out/graph.json',
      pack: {
        base_branch: 'origin/main',
        changed_files: ['src/auth.ts'],
        changed_ranges: [],
        seed_nodes: [],
        per_node_impact: [],
        total_blast_radius: 0,
        affected_communities: [],
        review_context: {
          supporting_paths: [],
          test_paths: [],
          hotspots: [],
        },
        review_bundle: {
          budget: 1800,
          token_count: 12,
          nodes: [],
          relationships: [],
          community_context: [],
        },
        risk_summary: {
          high_impact_nodes: [],
          cross_community_changes: 0,
          top_risks: [],
        },
      },
    }))
  })

  it('derives an impact target from the highest-signal retrieved node', async () => {
    const graph = new KnowledgeGraph()
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn().mockReturnValue({
        question: 'what breaks if auth changes',
        token_count: 20,
        matched_nodes: [
          {
            label: 'AuthService',
            source_file: 'src/auth.ts',
            line_number: 12,
            snippet: 'export class AuthService {}',
            match_score: 9,
            relevance_band: 'direct',
            community: 0,
            community_label: 'Auth',
            file_type: 'code',
          },
        ],
        relationships: [],
        community_context: [],
        graph_signals: { god_nodes: [], bridge_nodes: [] },
      }),
      compactRetrieveResult: vi.fn(),
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn().mockReturnValue({
        target: 'AuthService',
        target_file: 'src/auth.ts',
        depth: 3,
        direct_dependents: [],
        transitive_dependents: [],
        affected_files: ['src/session.ts'],
        affected_communities: [],
        top_paths_per_community: [],
        total_affected: 1,
      }),
      compactImpactResult: vi.fn().mockReturnValue({
        target: 'AuthService',
        target_file: 'src/auth.ts',
        depth: 3,
        direct_dependents: [],
        transitive_dependents: [],
        affected_files: ['src/session.ts'],
        affected_communities: [],
        top_paths_per_community: [],
        total_affected: 1,
        shared_file_type: 'code',
      }),
    }

    const output = await runContextPackCommand({
      prompt: 'what breaks if auth changes',
      budget: 900,
      task: 'impact',
      graphPath: 'graphify-out/graph.json',
    }, dependencies)

    expect(dependencies.analyzeImpact).toHaveBeenCalledWith(graph, {}, {
      label: 'AuthService',
      depth: 3,
    })
    expect(output).toBe(JSON.stringify({
      task: 'impact',
      prompt: 'what breaks if auth changes',
      budget: 900,
      graph_path: 'graphify-out/graph.json',
      target: 'AuthService',
      pack: {
        target: 'AuthService',
        target_file: 'src/auth.ts',
        depth: 3,
        direct_dependents: [],
        transitive_dependents: [],
        affected_files: ['src/session.ts'],
        affected_communities: [],
        top_paths_per_community: [],
        total_affected: 1,
        shared_file_type: 'code',
      },
    }))
  })
})
