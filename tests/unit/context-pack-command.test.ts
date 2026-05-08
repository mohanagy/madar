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
        task_contract: {
          version: 1,
          task_kind: 'explain',
          task_intent: 'explain',
          evidence_recipe_id: 'explain',
          budget: 1800,
          prompt: 'how does auth work',
          required_evidence: ['primary', 'supporting', 'structural'],
          preferred_evidence: ['primary', 'supporting', 'structural'],
          semantic_required: ['implementation', 'structure'],
          semantic_optional: ['contracts', 'configuration', 'tests'],
        },
        claims: [
          {
            evidence_class: 'primary',
            text: 'primary evidence: AuthService',
            node_labels: ['AuthService'],
          },
        ],
        expandable: [
          {
            kind: 'nodes',
            handle_id: 'expand:explain:structural:demo',
            evidence_class: 'structural',
            count: 1,
            preview: [
              {
                node_id: 'logger',
                label: 'Logger',
                source_file: 'src/logger.ts',
                line_range: {
                  start_line: 3,
                  end_line: 3,
                },
              },
            ],
            follow_up: {
              kind: 'context_pack',
              task_kind: 'explain',
              evidence_class: 'structural',
              focus_files: ['src/logger.ts'],
              focus_ranges: [
                {
                  source_file: 'src/logger.ts',
                  start_line: 3,
                  end_line: 3,
                },
              ],
            },
          },
        ],
        coverage: {
          required_evidence: ['primary', 'supporting', 'structural'],
          semantic_required: ['implementation', 'structure'],
          semantic_optional: ['contracts', 'configuration', 'tests'],
          entries: [],
          semantic_entries: [
            {
              category: 'implementation',
              label: 'implementation',
              required: true,
              available_nodes: 1,
              selected_nodes: 1,
              status: 'covered',
            },
          ],
          missing_required: [],
          missing_semantic: [],
          available_relationships: 0,
          selected_relationships: 0,
        },
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

    const payload = JSON.parse(output) as Record<string, unknown>

    expect(dependencies.loadGraph).toHaveBeenCalledWith('graphify-out/graph.json')
    expect(dependencies.retrieveContext).toHaveBeenCalledWith(graph, {
      question: 'how does auth work',
      budget: 1800,
      taskIntent: 'explain',
    })
    expect(payload).toEqual(expect.objectContaining({
      task: 'explain',
      task_intent: 'explain',
      prompt: 'how does auth work',
      budget: 1800,
      graph_path: 'graphify-out/graph.json',
      plan: expect.objectContaining({
        task_kind: 'explain',
        evidence: expect.objectContaining({
          recipe_id: 'explain',
        }),
      }),
      claims: [
        {
          evidence_class: 'primary',
          text: 'primary evidence: AuthService',
          node_labels: ['AuthService'],
        },
      ],
      expandable: [
        expect.objectContaining({
          handle_id: 'expand:explain:structural:demo',
        }),
      ],
      coverage: expect.objectContaining({
        semantic_entries: [
          expect.objectContaining({
            category: 'implementation',
            status: 'covered',
          }),
        ],
      }),
      missing_context: [],
      missing_semantic: [],
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
    }))
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

    expect(dependencies.analyzePrImpact).toHaveBeenCalledWith(graph, '.', { budget: 1800, taskIntent: 'pr-review-risk' })
    expect(JSON.parse(output)).toEqual(expect.objectContaining({
      task: 'review',
      task_intent: 'pr-review-risk',
      prompt: 'review current diff',
      budget: 1800,
      graph_path: 'graphify-out/graph.json',
      plan: expect.objectContaining({
        task_kind: 'review',
        evidence: expect.objectContaining({
          recipe_id: 'pr-review-risk',
        }),
      }),
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
      claims: [],
      expandable: [],
      missing_context: [],
      missing_semantic: [],
    }))
  })

  it('classifies review prompts through the task planner and returns the resulting plan', async () => {
    const graph = new KnowledgeGraph()
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn(),
      compactRetrieveResult: vi.fn(),
      analyzePrImpact: vi.fn().mockReturnValue({
        base_branch: 'origin/main',
        changed_files: ['src/auth.ts'],
        changed_ranges: [],
        changed_nodes: [],
        seed_nodes: [],
        per_node_impact: [],
        total_blast_radius: 0,
        affected_files: [],
        affected_communities: [],
        review_context: {
          supporting_paths: [],
          test_paths: ['tests/auth.test.ts'],
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
          test_paths: ['tests/auth.test.ts'],
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
      prompt: 'Generate regression tests for token refresh and session expiry.',
      budget: 1800,
      task: 'review',
      graphPath: 'graphify-out/graph.json',
    }, dependencies)

    const payload = JSON.parse(output) as Record<string, unknown>
    expect(payload).toEqual(expect.objectContaining({
      task: 'review',
      task_intent: 'test-generation',
      plan: expect.objectContaining({
        task_kind: 'review',
        evidence: expect.objectContaining({
          recipe_id: 'test-generation',
          semantic_required: ['implementation', 'tests', 'structure'],
        }),
      }),
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
        target_file_type: 'code',
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
    const payload = JSON.parse(output) as Record<string, unknown>
    expect(payload).toEqual(expect.objectContaining({
      task: 'impact',
      task_intent: 'impact',
      prompt: 'what breaks if auth changes',
      budget: 900,
      graph_path: 'graphify-out/graph.json',
      target: 'AuthService',
      plan: expect.objectContaining({
        evidence: expect.objectContaining({
          recipe_id: 'impact',
        }),
      }),
      coverage: expect.objectContaining({
        semantic_entries: expect.arrayContaining([
          expect.objectContaining({
            category: 'implementation',
            status: 'covered',
            selected_nodes: 1,
          }),
        ]),
      }),
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
    expect(payload.missing_semantic).not.toContain('implementation')
  })
})
