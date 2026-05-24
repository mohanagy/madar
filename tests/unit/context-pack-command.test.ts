import { describe, expect, it, vi } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { runContextPackCommand, type ContextPackCommandDependencies } from '../../src/infrastructure/context-pack-command.js'
import { build } from '../../src/pipeline/build.js'
import { compactRetrieveResult, retrieveContext } from '../../src/runtime/retrieve.js'

function buildRuntimeGenerationGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'auth_route', label: 'POST /login', file_type: 'code', source_file: '/src/auth/routes.ts', source_location: 'L10', node_kind: 'route', framework: 'express', framework_role: 'express_route', community: 0 },
          { id: 'auth_controller', label: 'AuthController.login', file_type: 'code', source_file: '/src/auth/controller.ts', source_location: 'L20', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_controller', community: 0 },
          { id: 'auth_service', label: 'AuthService.login', file_type: 'code', source_file: '/src/auth/service.ts', source_location: 'L30', node_kind: 'method', community: 0 },
          { id: 'queue_registry', label: 'QueueRegistry.addJob', file_type: 'code', source_file: '/src/queue/registry.ts', source_location: 'L40', node_kind: 'method', community: 1 },
          { id: 'auth_worker', label: 'AuthWorker.process', file_type: 'code', source_file: '/src/auth/worker.ts', source_location: 'L50', node_kind: 'method', framework_role: 'worker', community: 1 },
          { id: 'session_store', label: 'SessionStore.createSession', file_type: 'code', source_file: '/src/session/store.ts', source_location: 'L60', node_kind: 'method', community: 1 },
          { id: 'audit_publisher', label: 'AuditPublisher.publishLogin', file_type: 'code', source_file: '/src/auth/audit.ts', source_location: 'L70', node_kind: 'method', community: 2 },
          { id: 'auth_test', label: 'AuthService.login.spec', file_type: 'code', source_file: '/tests/auth.service.spec.ts', source_location: 'L80', node_kind: 'function', community: 2 },
        ],
        edges: [
          { source: 'auth_route', target: 'auth_controller', relation: 'controller_route', confidence: 'EXTRACTED', source_file: '/src/auth/routes.ts' },
          { source: 'auth_controller', target: 'auth_service', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/controller.ts' },
          { source: 'auth_service', target: 'queue_registry', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts' },
          { source: 'auth_service', target: 'audit_publisher', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts' },
          { source: 'queue_registry', target: 'auth_worker', relation: 'enqueues_job', confidence: 'EXTRACTED', source_file: '/src/queue/registry.ts' },
          { source: 'auth_worker', target: 'session_store', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/worker.ts' },
          { source: 'auth_service', target: 'auth_test', relation: 'covered_by', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

describe('context-pack-command', () => {
  it('preserves execution_slice for runtime-generation explain packs', async () => {
    const graph = buildRuntimeGenerationGraph()
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn((currentGraph, options) => retrieveContext(currentGraph, options as never)),
      compactRetrieveResult,
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    const output = await runContextPackCommand({
      prompt: 'Trace how `POST /login` reaches persistence in the backend runtime pipeline',
      budget: 1800,
      task: 'explain',
      graphPath: 'out/graph.json',
      retrievalStrategy: 'slice-v1',
    }, dependencies)

    const payload = JSON.parse(output) as {
      pack?: {
        answer_contract?: {
          version?: number
          answer_focus?: string
          entrypoint_scope?: string
          required_elements?: string[]
          do_not_claim?: string[]
          observed_phases?: string[]
          missing_phases?: string[]
        }
        execution_slice?: {
          status?: string
          confidence?: string
          confidence_reasons?: string[]
          steps?: Array<{ label?: string }>
          primary_path?: {
            boundaries?: Array<{ relation?: string }>
          }
          phase_coverage?: {
            missing?: string[]
          }
        }
      }
    }

    expect(dependencies.loadGraph).toHaveBeenCalledWith('out/graph.json')
    expect(dependencies.retrieveContext).toHaveBeenCalledWith(graph, {
      question: 'Trace how `POST /login` reaches persistence in the backend runtime pipeline',
      budget: 1800,
      taskKind: 'explain',
      taskIntent: 'explain',
      retrievalStrategy: 'slice-v1',
    })
    expect(payload.pack?.execution_slice).toEqual(expect.objectContaining({
      status: 'complete',
      confidence: 'high',
      confidence_reasons: expect.arrayContaining([
        'explicit_anchor',
        'runtime_handoff_evidence',
        'expected_phases_covered',
      ]),
      steps: [
        expect.objectContaining({ label: 'POST /login' }),
        expect.objectContaining({ label: 'AuthController.login' }),
        expect.objectContaining({ label: 'AuthService.login' }),
        expect.objectContaining({ label: 'QueueRegistry.addJob' }),
        expect.objectContaining({ label: 'AuthWorker.process' }),
        expect.objectContaining({ label: 'SessionStore.createSession' }),
      ],
      primary_path: expect.objectContaining({
        boundaries: expect.arrayContaining([
          expect.objectContaining({ relation: 'enqueues_job' }),
        ]),
      }),
      phase_coverage: {
        expected: ['controller', 'queue', 'worker', 'persistence'],
        observed: ['controller', 'service', 'queue', 'worker', 'persistence'],
        missing: [],
      },
    }))
    expect(payload.pack?.answer_contract).toEqual(expect.objectContaining({
      version: 1,
      answer_focus: 'runtime_generation',
      entrypoint_scope: 'setup_context',
      required_elements: expect.arrayContaining([
        'main_pipeline_phases',
        'queue_worker_handoff',
        'persistence_or_artifact_storage',
      ]),
      do_not_claim: expect.arrayContaining([
        'direct_producer_to_worker_calls_without_enqueues_boundary',
        'irrelevant_model_or_provider_details',
      ]),
      observed_phases: ['controller', 'service', 'queue', 'worker', 'persistence'],
      missing_phases: [],
    }))
  })

  it('defaults runtime-generation explain packs to slice-v1 retrieval', async () => {
    const graph = buildRuntimeGenerationGraph()
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn((currentGraph, options) => retrieveContext(currentGraph, options as never)),
      compactRetrieveResult,
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    const output = await runContextPackCommand({
      prompt: 'How `POST /login` reaches persistence in the backend runtime pipeline',
      budget: 1800,
      task: 'explain',
      graphPath: 'out/graph.json',
    }, dependencies)

    const payload = JSON.parse(output) as {
      pack?: {
        retrieval_strategy?: string
        execution_slice?: {
          status?: string
        }
      }
    }

    expect(dependencies.retrieveContext).toHaveBeenCalledWith(graph, {
      question: 'How `POST /login` reaches persistence in the backend runtime pipeline',
      budget: 1800,
      taskKind: 'explain',
      taskIntent: 'explain',
      retrievalStrategy: 'slice-v1',
    })
    expect(payload.pack?.retrieval_strategy).toBe('slice-v1')
    expect(payload.pack?.execution_slice?.status).toBe('complete')
  })

  it('adds routing metadata only when --why is enabled', async () => {
    const graph = new KnowledgeGraph()
    const retrieval = {
      question: 'Explain the runtime path for login session creation excluding tests',
      token_count: 120,
      matched_nodes: [
        {
          label: 'POST /login',
          source_file: '/src/auth/routes.ts',
          line_number: 10,
          file_type: 'code',
          snippet: 'app.post("/login", controller.login)',
          match_score: 0.92,
          relevance_band: 'direct' as const,
          community: 0,
        },
        {
          label: 'AuthService.login',
          source_file: '/src/auth/service.ts',
          line_number: 24,
          file_type: 'code',
          snippet: 'return sessionStore.createSession(userId)',
          match_score: 0.88,
          relevance_band: 'direct' as const,
          community: 0,
        },
        {
          label: 'AuthService.login.spec',
          source_file: '/tests/auth.service.spec.ts',
          line_number: 12,
          file_type: 'code',
          snippet: 'expect(login()).toEqual(...)',
          match_score: 0.33,
          relevance_band: 'related' as const,
          community: 1,
          source_domain: 'test' as const,
        },
      ],
      relationships: [
        { from: 'POST /login', to: 'AuthService.login', relation: 'calls' },
        { from: 'AuthService.login', to: 'AuthService.login.spec', relation: 'covered_by' },
      ],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      claims: [
        {
          evidence_class: 'primary' as const,
          text: 'AuthService.login handles the login runtime path.',
          node_labels: ['AuthService.login'],
        },
      ],
      coverage: {
        required_evidence: ['primary' as const],
        semantic_required: ['implementation' as const],
        semantic_optional: ['tests' as const],
        entries: [],
        semantic_entries: [],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 2,
        selected_relationships: 2,
      },
      retrieval_gate: {
        level: 3 as const,
        skipped_retrieval: false,
        reason: 'runtime generation intent — behavior slice retrieval',
        intent: 'explain' as const,
        signals: {
          has_pr_diff: false,
          has_stack_trace: false,
          mentioned_paths: [],
          mentioned_symbols: ['AuthService.login'],
          generation_intent: 'runtime_generation' as const,
          target_domain_hint: 'backend_runtime' as const,
          excluded_domains: ['test' as const],
          excluded_terms: ['tests'],
          excluded_path_hints: ['test'],
        },
      },
      retrieval_strategy: 'slice-v1' as const,
      slice: {
        mode: 'explain' as const,
        anchors: [
          { label: 'AuthService.login', reason: 'symbol mention' },
          { label: 'POST /login', reason: 'route mention' },
        ],
        directions: ['forward' as const],
        selected_paths: [],
      },
    }
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn().mockReturnValue(retrieval),
      compactRetrieveResult,
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    const withoutWhy = JSON.parse(await runContextPackCommand({
      prompt: retrieval.question,
      budget: 1800,
      task: 'explain',
      graphPath: 'out/graph.json',
    }, dependencies)) as Record<string, unknown>

    const withWhy = JSON.parse(await runContextPackCommand({
      prompt: retrieval.question,
      budget: 1800,
      task: 'explain',
      graphPath: 'out/graph.json',
      why: true,
    } as never, dependencies)) as {
      routing?: {
        detected_intent?: string
        generation_intent?: string
        target_domain_hint?: string
        retrieval_level?: number
        effective_retrieval_strategy?: string
        reason?: string
        top_anchors?: Array<{ label?: string; reason?: string }>
        exclusions?: {
          domains?: string[]
          terms?: string[]
          path_hints?: string[]
        }
        warnings?: Array<{ kind?: string; severity?: string }>
      }
    }

    expect(withoutWhy).not.toHaveProperty('routing')
    expect(withWhy.routing).toEqual(expect.objectContaining({
      detected_intent: 'explain',
      generation_intent: 'runtime_generation',
      target_domain_hint: 'backend_runtime',
      retrieval_level: 3,
      effective_retrieval_strategy: 'slice-v1',
      reason: 'runtime generation intent — behavior slice retrieval',
      top_anchors: [
        { label: 'AuthService.login', reason: 'symbol mention' },
        { label: 'POST /login', reason: 'route mention' },
      ],
      exclusions: {
        domains: ['test'],
        terms: ['tests'],
        path_hints: ['test'],
      },
      warnings: expect.arrayContaining([
        expect.objectContaining({
          kind: 'excluded_domain_selected',
          severity: 'warn',
        }),
      ]),
    }))
  })

  it('normalizes sub-minimum explain budgets before retrieving', async () => {
    const graph = new KnowledgeGraph()
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn().mockReturnValue({
        question: 'auth',
        token_count: 4,
        matched_nodes: [],
        relationships: [],
        community_context: [],
        graph_signals: { god_nodes: [], bridge_nodes: [] },
      }),
      compactRetrieveResult: vi.fn().mockReturnValue({
        question: 'auth',
        token_count: 4,
        matched_nodes: [],
        relationships: [],
        community_context: [],
        graph_signals: { god_nodes: [], bridge_nodes: [] },
      }),
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    const output = await runContextPackCommand({
      prompt: 'auth',
      budget: 1,
      task: 'explain',
      graphPath: 'out/graph.json',
    }, dependencies)

    expect(dependencies.retrieveContext).toHaveBeenCalledWith(graph, {
      question: 'auth',
      budget: 3,
      taskKind: 'explain',
      taskIntent: 'explain',
    })
    expect(JSON.parse(output)).toEqual(expect.objectContaining({
      budget: 3,
    }))
  })

  it('infers implement packs from imperative prompts when --task is omitted', async () => {
    const graph = new KnowledgeGraph()
    const retrieval = {
      question: 'Implement issue #275 by collecting implementation context for changed files',
      token_count: 4,
      matched_nodes: [],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
    }
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn().mockReturnValue(retrieval),
      compactRetrieveResult: vi.fn().mockReturnValue(retrieval),
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    const output = await runContextPackCommand({
      prompt: retrieval.question,
      budget: 1800,
      task: 'explain',
      graphPath: 'out/graph.json',
    }, dependencies)

    expect(dependencies.retrieveContext).toHaveBeenCalledWith(graph, {
      question: retrieval.question,
      budget: 1800,
      taskIntent: 'implement',
      taskKind: 'implement',
    })
    expect(JSON.parse(output)).toEqual(expect.objectContaining({
      task: 'implement',
      task_intent: 'implement',
      plan: expect.objectContaining({
        task_kind: 'implement',
        evidence: expect.objectContaining({
          recipe_id: 'implement',
        }),
      }),
    }))
  })

  it('honors explicit --task implement even for explain-shaped prompts', async () => {
    const graph = new KnowledgeGraph()
    const retrieval = {
      question: 'Explain how auth works',
      token_count: 4,
      matched_nodes: [],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
    }
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn().mockReturnValue(retrieval),
      compactRetrieveResult: vi.fn().mockReturnValue(retrieval),
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    const output = await runContextPackCommand({
      prompt: retrieval.question,
      budget: 1800,
      task: 'implement',
      taskExplicit: true,
      graphPath: 'out/graph.json',
    } as never, dependencies)

    expect(dependencies.retrieveContext).toHaveBeenCalledWith(graph, {
      question: retrieval.question,
      budget: 1800,
      taskIntent: 'implement',
      taskKind: 'implement',
    })
    expect(JSON.parse(output)).toEqual(expect.objectContaining({
      task: 'implement',
      task_intent: 'implement',
      plan: expect.objectContaining({
        task_kind: 'implement',
      }),
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
      graphPath: 'out/graph.json',
    }, dependencies)

    expect(dependencies.analyzePrImpact).toHaveBeenCalledWith(graph, '.', { budget: 1800, taskIntent: 'pr-review-risk' })
    expect(JSON.parse(output)).toEqual(expect.objectContaining({
      task: 'review',
      task_intent: 'pr-review-risk',
      prompt: 'review current diff',
      budget: 1800,
      graph_path: 'out/graph.json',
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

  it('normalizes sub-minimum review budgets before analyzing PR impact', async () => {
    const graph = new KnowledgeGraph()
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn(),
      compactRetrieveResult: vi.fn(),
      analyzePrImpact: vi.fn().mockReturnValue({
        base_branch: 'origin/main',
        changed_files: [],
        changed_ranges: [],
        changed_nodes: [],
        seed_nodes: [],
        per_node_impact: [],
        total_blast_radius: 0,
        affected_files: [],
        affected_communities: [],
        review_context: {
          supporting_paths: [],
          test_paths: [],
          hotspots: [],
        },
        review_bundle: {
          budget: 3,
          token_count: 0,
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
        changed_files: [],
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
          budget: 3,
          token_count: 0,
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
      prompt: 'review auth diff',
      budget: 1,
      task: 'review',
      graphPath: 'out/graph.json',
    }, dependencies)

    expect(dependencies.analyzePrImpact).toHaveBeenCalledWith(graph, '.', {
      budget: 3,
      taskIntent: 'pr-review-risk',
    })
    expect(JSON.parse(output)).toEqual(expect.objectContaining({
      budget: 3,
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
      graphPath: 'out/graph.json',
    }, dependencies)

    const payload = JSON.parse(output) as Record<string, unknown>
    expect(payload).toEqual(expect.objectContaining({
      task: 'review',
      task_intent: 'review',
      plan: expect.objectContaining({
        task_kind: 'review',
        evidence: expect.objectContaining({
          recipe_id: 'review',
          semantic_required: ['changes', 'impact'],
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
      graphPath: 'out/graph.json',
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
      graph_path: 'out/graph.json',
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

  it('normalizes sub-minimum impact budgets before retrieval and metadata assembly', async () => {
    const graph = new KnowledgeGraph()
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn().mockReturnValue({
        question: 'auth',
        token_count: 2,
        matched_nodes: [
          {
            label: 'AuthService',
            source_file: 'src/auth.ts',
            line_number: 1,
            snippet: null,
            match_score: 1,
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
        affected_files: [],
        affected_communities: [],
        top_paths_per_community: [],
        total_affected: 0,
      }),
      compactImpactResult: vi.fn().mockReturnValue({
        target: 'AuthService',
        target_file: 'src/auth.ts',
        depth: 3,
        direct_dependents: [],
        transitive_dependents: [],
        affected_files: [],
        affected_communities: [],
        top_paths_per_community: [],
        total_affected: 0,
      }),
    }

    const output = await runContextPackCommand({
      prompt: 'auth',
      budget: 1,
      task: 'impact',
      graphPath: 'out/graph.json',
    }, dependencies)

    expect(dependencies.retrieveContext).toHaveBeenCalledWith(graph, {
      question: 'auth',
      budget: 3,
      taskKind: 'impact',
      taskIntent: 'impact',
    })
    expect(JSON.parse(output)).toEqual(expect.objectContaining({
      budget: 3,
    }))
  })
})
