import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { ContextPackSelectionDiagnostics } from '../../src/contracts/context-pack.js'
import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import { buildAnswerReadyPackSchema, runContextPackCommand, type ContextPackCommandDependencies } from '../../src/infrastructure/context-pack-command.js'
import { createTestGraph } from '../helpers/knowledge-graph.js'
import { assessMadarResponseEvidence } from '../../src/runtime/mcp-response-evidence.js'
import { compactRetrieveResult, retrieveContext, type RetrieveResult } from '../../src/runtime/retrieve.js'
import { evaluateQueryEvidenceCoverage } from '../../src/runtime/retrieve/conceptual-fallback.js'
import { buildRetrievalEvidencePlanFromResult } from '../../src/runtime/retrieve/pipeline.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { buildCrossLayerMonitorFlowFixture } from '../fixtures/cross-layer-monitor-flow.js'
import { writeCanonicalGraphFixture } from '../helpers/graph-artifact.js'

const tempFixtureRoots: string[] = []
const repoGraphFixturePath = join(process.cwd(), 'out', 'graph.json')
const repoBackendGraphFixturePath = join(process.cwd(), 'backend', 'out', 'graph.json')
let createdRepoGraphFixture = false
let createdRepoGraphFixtureDir = false
let createdRepoBackendGraphFixture = false
let createdRepoBackendGraphFixtureDir = false

beforeAll(() => {
  if (existsSync(repoGraphFixturePath)) {
    // no-op
  } else {
    const repoGraphDir = dirname(repoGraphFixturePath)
    if (!existsSync(repoGraphDir)) {
      mkdirSync(repoGraphDir, { recursive: true })
      createdRepoGraphFixtureDir = true
    }
    writeCanonicalGraphFixture(repoGraphFixturePath, {})
    createdRepoGraphFixture = true
  }
  if (existsSync(repoBackendGraphFixturePath)) {
    return
  }
  const repoBackendGraphDir = dirname(repoBackendGraphFixturePath)
  if (!existsSync(repoBackendGraphDir)) {
    mkdirSync(repoBackendGraphDir, { recursive: true })
    createdRepoBackendGraphFixtureDir = true
  }
  writeCanonicalGraphFixture(repoBackendGraphFixturePath, {})
  createdRepoBackendGraphFixture = true
})

afterAll(() => {
  if (createdRepoGraphFixture) {
    rmSync(repoGraphFixturePath, { force: true })
  }
  if (createdRepoGraphFixtureDir) {
    rmSync(dirname(repoGraphFixturePath), { recursive: true, force: true })
  }
  if (createdRepoBackendGraphFixture) {
    rmSync(repoBackendGraphFixturePath, { force: true })
  }
  if (createdRepoBackendGraphFixtureDir) {
    rmSync(dirname(repoBackendGraphFixturePath), { recursive: true, force: true })
  }
})

afterEach(() => {
  while (tempFixtureRoots.length > 0) {
    const root = tempFixtureRoots.pop()
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

function buildRuntimeGenerationGraph() {
  return createTestGraph({
    metadata: { root_path: '/' },
    nodes: [
        ['auth_route', {
                label: 'POST /login', file_type: 'code', source_file: '/src/auth/routes.ts', source_location: 'L10', node_kind: 'route', framework: 'express', framework_role: 'express_route', community: 0
            }],
        ['auth_controller', {
                label: 'AuthController.login', file_type: 'code', source_file: '/src/auth/controller.ts', source_location: 'L20', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_controller', community: 0
            }],
        ['auth_service', {
                label: 'AuthService.login', file_type: 'code', source_file: '/src/auth/service.ts', source_location: 'L30', node_kind: 'method', community: 0
            }],
        ['queue_registry', {
                label: 'QueueRegistry.addJob', file_type: 'code', source_file: '/src/queue/registry.ts', source_location: 'L40', node_kind: 'method', community: 1
            }],
        ['auth_worker', {
                label: 'AuthWorker.process', file_type: 'code', source_file: '/src/auth/worker.ts', source_location: 'L50', node_kind: 'method', framework_role: 'worker', community: 1
            }],
        ['session_store', {
                label: 'SessionStore.createSession', file_type: 'code', source_file: '/src/session/store.ts', source_location: 'L60', node_kind: 'method', community: 1
            }],
        ['audit_publisher', {
                label: 'AuditPublisher.publishLogin', file_type: 'code', source_file: '/src/auth/audit.ts', source_location: 'L70', node_kind: 'method', community: 2
            }],
        ['auth_test', {
                label: 'AuthService.login.spec', file_type: 'code', source_file: '/tests/auth.service.spec.ts', source_location: 'L80', node_kind: 'function', community: 2
            }]
    ],
    edges: [
        ['auth_route', 'auth_controller', {
                relation: 'controller_route', confidence: 'EXTRACTED', source_file: '/src/auth/routes.ts'
            }],
        ['auth_controller', 'auth_service', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/controller.ts'
            }],
        ['auth_service', 'queue_registry', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts'
            }],
        ['auth_service', 'audit_publisher', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts'
            }],
        ['queue_registry', 'auth_worker', {
                relation: 'enqueues_job', confidence: 'EXTRACTED', source_file: '/src/queue/registry.ts'
            }],
        ['auth_worker', 'session_store', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/worker.ts'
            }],
        ['auth_service', 'auth_test', {
                relation: 'covered_by', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts'
            }]
    ]
})
}

function buildImplementationPackGraph() {
  const root = mkdtempSync(join(tmpdir(), 'madar-fixture-'))
  tempFixtureRoots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'madar-fixture',
    private: true,
    scripts: {
      typecheck: 'tsc --noEmit',
      build: 'tsc -p tsconfig.build.json',
      'test:run': 'vitest run',
    },
  }))
  const graph = createTestGraph({
    metadata: { root_path: root },
    nodes: [
        ['pack_parser', {
                label: 'parsePackArgs', file_type: 'code', source_file: `${root}/src/cli/parser.ts`, source_location: 'L416', node_kind: 'function', community: 0
            }],
        ['pack_command', {
                label: 'runContextPackCommand', file_type: 'code', source_file: `${root}/src/infrastructure/context-pack-command.ts`, source_location: 'L224', node_kind: 'function', community: 0
            }],
        ['retrieve_context', {
                label: 'retrieveContext', file_type: 'code', source_file: `${root}/src/runtime/retrieve.ts`, source_location: 'L3601', node_kind: 'function', community: 1
            }],
        ['task_planner', {
                label: 'buildTaskContextPlan', file_type: 'code', source_file: `${root}/src/runtime/task-context-planner.ts`, source_location: 'L151', node_kind: 'function', community: 1
            }],
        ['gate', {
                label: 'classifyRetrievalLevel', file_type: 'code', source_file: `${root}/src/runtime/retrieval-gate.ts`, source_location: 'L1', node_kind: 'function', community: 1
            }],
        ['contract', {
                label: 'ContextPackTaskKind', file_type: 'code', source_file: `${root}/src/contracts/context-pack.ts`, source_location: 'L13', community: 2
            }],
        ['mcp_surface', {
                label: 'context_pack', file_type: 'code', source_file: `${root}/src/runtime/stdio/definitions.ts`, source_location: 'L239', node_kind: 'function', community: 2
            }],
        ['pack_test', {
                label: 'context-pack-command.test', file_type: 'code', source_file: `${root}/tests/unit/context-pack-command.test.ts`, source_location: 'L1', node_kind: 'function', community: 3
            }],
        ['retrieve_test', {
                label: 'retrieve-slice-v1.test', file_type: 'code', source_file: `${root}/tests/unit/retrieve-slice-v1.test.ts`, source_location: 'L1', node_kind: 'function', community: 3
            }],
        ['pack_e2e_test', {
                label: 'context-pack.e2e', file_type: 'code', source_file: `${root}/tests/e2e/context-pack.e2e.test.ts`, source_location: 'L1', node_kind: 'function', community: 3
            }],
        ['gate_test', {
                label: 'retrieval-gate.test', file_type: 'code', source_file: `${root}/tests/unit/retrieval-gate.test.ts`, source_location: 'L1', node_kind: 'function', community: 3
            }],
        ['prompt_pattern', {
                label: 'runContextPromptCommand', file_type: 'code', source_file: `${root}/src/infrastructure/context-prompt-command.ts`, source_location: 'L1', node_kind: 'function', community: 4
            }],
        ['review_template_pattern', {
                label: 'renderReviewTemplate', file_type: 'code', source_file: `${root}/src/infrastructure/review-template.ts`, source_location: 'L10', node_kind: 'function', community: 4
            }]
    ],
    edges: [
        ['pack_parser', 'pack_command', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/cli/parser.ts`
            }],
        ['pack_command', 'retrieve_context', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/infrastructure/context-pack-command.ts`
            }],
        ['pack_command', 'task_planner', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/infrastructure/context-pack-command.ts`
            }],
        ['pack_command', 'contract', {
                relation: 'depends_on', confidence: 'EXTRACTED', source_file: `${root}/src/infrastructure/context-pack-command.ts`
            }],
        ['pack_command', 'mcp_surface', {
                relation: 'depends_on', confidence: 'EXTRACTED', source_file: `${root}/src/infrastructure/context-pack-command.ts`
            }],
        ['retrieve_context', 'gate', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/runtime/retrieve.ts`
            }],
        ['retrieve_context', 'retrieve_test', {
                relation: 'covered_by', confidence: 'EXTRACTED', source_file: `${root}/src/runtime/retrieve.ts`
            }],
        ['retrieve_context', 'gate_test', {
                relation: 'covered_by', confidence: 'EXTRACTED', source_file: `${root}/src/runtime/retrieve.ts`
            }],
        ['pack_command', 'pack_test', {
                relation: 'covered_by', confidence: 'EXTRACTED', source_file: `${root}/src/infrastructure/context-pack-command.ts`
            }],
        ['mcp_surface', 'pack_e2e_test', {
                relation: 'covered_by', confidence: 'EXTRACTED', source_file: `${root}/src/runtime/stdio/definitions.ts`
            }],
        ['pack_command', 'prompt_pattern', {
                relation: 'related_to', confidence: 'EXTRACTED', source_file: `${root}/src/infrastructure/context-pack-command.ts`
            }],
        ['pack_command', 'review_template_pattern', {
                relation: 'related_to', confidence: 'EXTRACTED', source_file: `${root}/src/infrastructure/context-pack-command.ts`
            }]
    ]
})
  return graph
}

function buildImplementationPackDistractorGraph() {
  const root = mkdtempSync(join(tmpdir(), 'madar-fixture-'))
  tempFixtureRoots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'madar-fixture',
    private: true,
    scripts: {
      typecheck: 'tsc --noEmit',
      build: 'tsc -p tsconfig.build.json',
      'test:run': 'vitest run',
    },
  }))
  const graph = createTestGraph({
    metadata: { root_path: root },
    nodes: [
        ['pack_command', {
                label: 'runContextPackCommand', file_type: 'code', source_file: `${root}/src/infrastructure/context-pack-command.ts`, source_location: 'L224', node_kind: 'function', community: 0
            }],
        ['pack_helper', {
                label: 'buildContextPackHelper', file_type: 'code', source_file: `${root}/src/infrastructure/context-pack-helper.ts`, source_location: 'L18', node_kind: 'function', community: 0
            }],
        ['pack_contract', {
                label: 'ContextPackTaskKind', file_type: 'code', source_file: `${root}/src/contracts/context-pack.ts`, source_location: 'L13', community: 1
            }],
        ['pack_test', {
                label: 'context-pack-command.test', file_type: 'code', source_file: `${root}/tests/unit/context-pack-command.test.ts`, source_location: 'L1', node_kind: 'function', community: 2
            }]
    ],
    edges: [
        ['pack_command', 'pack_helper', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: `${root}/src/infrastructure/context-pack-command.ts`
            }],
        ['pack_command', 'pack_contract', {
                relation: 'depends_on', confidence: 'EXTRACTED', source_file: `${root}/src/infrastructure/context-pack-command.ts`
            }],
        ['pack_command', 'pack_test', {
                relation: 'covered_by', confidence: 'EXTRACTED', source_file: `${root}/src/infrastructure/context-pack-command.ts`
            }]
    ]
})
  return graph
}

function buildOversizedAnswerReadySchema() {
  const repeatedSnippet = (name: string, repeat: number) => Array.from(
    { length: repeat },
    (_, index) => `function ${name}_${index}() { return "${name}-${index}"; }`,
  ).join('\n')

  return {
    schema_version: 1,
    task: 'explain',
    prompt: 'Explain how the runtime pipeline works',
    budget: 1500,
    graph_path: 'out/graph.json',
    evidence: {
      pack_confidence: 'high' as const,
      coverage: 'complete' as const,
      missing_phases: [],
      covered_workflow_owners: ['src/runtime/controller.ts', 'src/runtime/service.ts'],
      confidence_reasons: ['all required evidence covered'],
      agent_directive: 'answer_from_pack' as const,
    },
    governance: {
      version: 1 as const,
      surface: 'cli_pack' as const,
      privacy_boundary: {
        source_safe: true as const,
        includes_prompt: false as const,
        includes_source_content: false as const,
        includes_answer_content: false as const,
        includes_file_paths: false as const,
      },
      graph_freshness: {
        graph_version: 'fixture-graph',
        graph_modified_ms: 0,
        graph_modified_at: new Date(0).toUTCString(),
      },
      request: {
        task: 'explain' as const,
        task_intent: 'explain' as const,
        budget: 1500,
        retrieval_strategy: 'slice-v1' as const,
      },
      directive: {
        pack_confidence: 'high' as const,
        coverage: 'complete' as const,
        agent_directive: 'answer_from_pack' as const,
        missing_phases: [],
      },
      follow_up: {
        expandable_handle_count: 1,
        expandable_evidence_classes: ['supporting'] as const,
        expansion_task_kinds: ['explain'] as const,
        preview_item_count: 2,
        focus_file_count: 0,
        focus_range_count: 16,
      },
    },
    workflow_centers: [
      { label: 'RuntimeController.handle', path: 'src/runtime/controller.ts', reason: 'controller entrypoint' },
      { label: 'RuntimeService.execute', path: 'src/runtime/service.ts', reason: 'service handoff' },
    ],
    recommended_first_read: [
      { label: 'RuntimeController.handle', path: 'src/runtime/controller.ts', reason: 'entrypoint' },
    ],
    pack: {
      answer_contract: {
        version: 1,
        answer_focus: 'runtime_generation',
        entrypoint_scope: 'setup_context',
        required_elements: ['main_pipeline_phases'],
        do_not_claim: ['unverified_background_jobs'],
        observed_phases: ['controller', 'service'],
        missing_phases: [],
        confidence: 'high',
      },
      matched_nodes: [
        {
          node_id: 'workflow-controller',
          label: 'RuntimeController.handle',
          source_file: 'src/runtime/controller.ts',
          line_number: 10,
          snippet: repeatedSnippet('controller', 24),
        },
        {
          node_id: 'workflow-service',
          label: 'RuntimeService.execute',
          source_file: 'src/runtime/service.ts',
          line_number: 30,
          snippet: repeatedSnippet('service', 24),
        },
        {
          node_id: 'helper-low-1',
          label: 'StatusFormatter.render',
          source_file: 'src/runtime/status.ts',
          line_number: 50,
          snippet: repeatedSnippet('status', 22),
        },
        {
          node_id: 'helper-low-2',
          label: 'AuditLogger.enqueue',
          source_file: 'src/runtime/audit.ts',
          line_number: 70,
          snippet: repeatedSnippet('audit', 22),
        },
      ],
      relationships: [
        { from_id: 'workflow-controller', from: 'RuntimeController.handle', to_id: 'workflow-service', to: 'RuntimeService.execute', relation: 'calls' },
        { from_id: 'workflow-service', from: 'RuntimeService.execute', to_id: 'helper-low-1', to: 'StatusFormatter.render', relation: 'calls' },
        { from_id: 'workflow-service', from: 'RuntimeService.execute', to_id: 'helper-low-2', to: 'AuditLogger.enqueue', relation: 'calls' },
      ],
    },
    expandable: [
      {
        kind: 'more_matches',
        reason: 'additional supporting nodes',
        preview: [
          { node_id: 'helper-low-1', label: 'StatusFormatter.render', source_file: 'src/runtime/status.ts' },
          { node_id: 'helper-low-2', label: 'AuditLogger.enqueue', source_file: 'src/runtime/audit.ts' },
        ],
        follow_up: {
          focus_ranges: Array.from({ length: 16 }, (_, index) => ({
            source_file: `src/runtime/focus-${index}.ts`,
            start_line: index + 1,
            end_line: index + 12,
            reason: 'secondary detail',
          })),
        },
      },
    ],
    routing: {
      warnings: [],
    },
  }
}
function buildAnswerReadySelectionDiagnostics(): ContextPackSelectionDiagnostics {
  return {
    selection_strategy: 'value-per-token',
    budget: 1500,
    used_tokens: 1400,
    required_overflow: false,
    ranking: [
      {
        id: 'workflow-controller',
        label: 'RuntimeController.handle',
        evidence_class: 'primary',
        score: 0.99,
        token_cost: 220,
        density: 1.2,
        included: true,
        reasons: ['entrypoint'],
        penalties: [],
      },
      {
        id: 'workflow-service',
        label: 'RuntimeService.execute',
        evidence_class: 'supporting',
        score: 0.96,
        token_cost: 220,
        density: 1.1,
        included: true,
        reasons: ['handoff'],
        penalties: [],
      },
      {
        id: 'helper-low-1',
        label: 'StatusFormatter.render',
        evidence_class: 'supporting',
        score: 0.52,
        token_cost: 240,
        density: 0.12,
        included: true,
        reasons: ['secondary formatting detail'],
        penalties: ['low load-bearing value'],
      },
      {
        id: 'helper-low-2',
        label: 'AuditLogger.enqueue',
        evidence_class: 'supporting',
        score: 0.48,
        token_cost: 240,
        density: 0.08,
        included: true,
        reasons: ['secondary audit detail'],
        penalties: ['low load-bearing value'],
      },
    ],
  }
}
describe('context-pack-command', () => {
  it('uses discovery safety metadata from the loaded graph without serializing local exclusion paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-discovery-pack-'))
    tempFixtureRoots.push(root)
    const graphPath = join(root, 'out', 'graph.json')
    mkdirSync(dirname(graphPath), { recursive: true })
    writeCanonicalGraphFixture(graphPath, {
      discovery_safety: {
        version: 1,
        summary: { total: 1, sensitive: 1, unreadable: 0, reasons: { secret_config: 1 } },
        exclusions: [
          { path: 'src/billing/credentials.json', kind: 'sensitive', reason: 'secret_config' },
        ],
      },
    })

    const graph = buildRuntimeGenerationGraph()
    graph.graph.discovery_safety = {
      version: 1,
      summary: { total: 1, sensitive: 0, unreadable: 1, reasons: { unreadable_path: 1 } },
      exclusions: [
        { path: 'src/auth/token-loader.ts', kind: 'unreadable', reason: 'unreadable_path' },
      ],
    }
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: (loadedGraph, options) => retrieveContext(loadedGraph, options),
      compactRetrieveResult,
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    const output = await runContextPackCommand({
      prompt: 'How does the auth token loader work?',
      budget: 3000,
      task: 'explain',
      graphPath,
      format: 'json',
      verbose: true,
    }, dependencies)
    const payload = JSON.parse(output) as {
      evidence?: {
        pack_confidence?: string
        discovery_exclusions?: {
          policy?: string
          total?: number
          relevant?: number
          reasons?: Record<string, number>
          relevant_reasons?: Record<string, number>
        }
      }
    }

    expect(payload.evidence?.pack_confidence).toBe('low')
    expect(payload.evidence?.discovery_exclusions).toEqual({
      policy: 'artifact_path_only',
      total: 1,
      relevant: 1,
      reasons: { unreadable_path: 1 },
      relevant_reasons: { unreadable_path: 1 },
    })
    expect(output).not.toContain('token-loader.ts')
    expect(output).not.toContain('billing/credentials.json')
  })

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

  it('derives runtime-generation explain workflow centers and first-read from the execution spine', async () => {
    const graph = buildRuntimeGenerationGraph()
    const retrieval = {
      question: 'How idea report is being generated',
      token_count: 220,
      matched_nodes: [
        {
          node_id: 'status_helper',
          label: 'getStatusMessage',
          source_file: 'src/ideas/report-status.ts',
          line_number: 18,
          file_type: 'code',
          snippet: 'export function getStatusMessage() {}',
          match_score: 0.98,
          relevance_band: 'direct' as const,
          community: 2,
          community_label: 'Idea report helpers',
        },
        {
          node_id: 'next_steps_helper',
          label: 'generateSuggestedNextSteps',
          source_file: 'src/ideas/next-steps.ts',
          line_number: 24,
          file_type: 'code',
          snippet: 'export function generateSuggestedNextSteps() {}',
          match_score: 0.95,
          relevance_band: 'direct' as const,
          community: 2,
          community_label: 'Idea report helpers',
        },
        {
          node_id: 'controller_entry',
          label: 'IdeasController.generateReport',
          source_file: 'src/ideas/controller.ts',
          line_number: 40,
          file_type: 'code',
          snippet: 'return this.reportService.generateReport(id)',
          match_score: 0.74,
          relevance_band: 'direct' as const,
          community: 0,
          community_label: 'Idea report runtime',
        },
        {
          node_id: 'service_handoff',
          label: 'IdeaReportService.generateReport',
          source_file: 'src/ideas/report-service.ts',
          line_number: 58,
          file_type: 'code',
          snippet: 'await queue.enqueue(reportJob)',
          match_score: 0.72,
          relevance_band: 'direct' as const,
          community: 0,
          community_label: 'Idea report runtime',
        },
      ],
      relationships: [],
      community_context: [
        { id: 2, label: 'Idea report helpers', node_count: 8 },
      ],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      claims: [],
      expandable: [
        {
          kind: 'nodes',
          handle_id: 'expand-idea-runtime',
          evidence_class: 'supporting' as const,
          count: 2,
          preview: [
            {
              node_id: 'helper-status',
              label: 'StatusBadge.render',
              source_file: 'src/ideas/report-status.ts',
            },
          ],
          follow_up: {
            kind: 'context_pack' as const,
            task_kind: 'explain' as const,
            evidence_class: 'supporting' as const,
            focus_files: ['src/ideas/report-status.ts', 'src/ideas/next-steps.ts'],
            focus_ranges: [
              {
                source_file: 'src/ideas/report-status.ts',
                start_line: 18,
                end_line: 42,
              },
            ],
          },
        },
      ],
      coverage: {
        required_evidence: ['primary', 'supporting', 'structural'] as const,
        semantic_required: ['implementation', 'structure'] as const,
        semantic_optional: ['contracts', 'configuration', 'tests'] as const,
        entries: [],
        semantic_entries: [],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 0,
        selected_relationships: 0,
      },
      retrieval_gate: {
        level: 4,
        skipped_retrieval: false,
        reason: 'manual override',
        intent: 'explain',
        signals: {
          has_pr_diff: false,
          has_stack_trace: false,
          mentioned_paths: [],
          mentioned_symbols: [],
          generation_intent: 'runtime_generation' as const,
          target_domain_hint: 'backend_runtime' as const,
        },
      },
      retrieval_strategy: 'slice-v1' as const,
      execution_slice: {
        status: 'complete' as const,
        confidence: 'high' as const,
        steps: [
          {
            node_id: 'controller_entry',
            label: 'IdeasController.generateReport',
            source_file: 'src/ideas/controller.ts',
            line_number: 40,
            node_kind: 'method',
            framework_role: 'nest_controller',
          },
          {
            node_id: 'service_handoff',
            label: 'IdeaReportService.generateReport',
            source_file: 'src/ideas/report-service.ts',
            line_number: 58,
            node_kind: 'method',
          },
          {
            node_id: 'queue_boundary',
            label: 'IdeaReportQueue.enqueue',
            source_file: 'src/ideas/report-queue.ts',
            line_number: 72,
            node_kind: 'method',
          },
          {
            node_id: 'worker_entry',
            label: 'IdeaReportWorker.process',
            source_file: 'src/ideas/report-worker.ts',
            line_number: 84,
            node_kind: 'method',
            framework_role: 'worker',
          },
          {
            node_id: 'assembler',
            label: 'IdeaReportAssembler.build',
            source_file: 'src/ideas/report-assembler.ts',
            line_number: 102,
            node_kind: 'method',
          },
          {
            node_id: 'store',
            label: 'IdeaReportStore.save',
            source_file: 'src/ideas/report-store.ts',
            line_number: 119,
            node_kind: 'method',
          },
        ],
        phase_coverage: {
          expected: ['controller', 'service', 'queue', 'worker', 'report_builder', 'persistence'],
          observed: ['controller', 'service', 'queue', 'worker', 'report_builder', 'persistence'],
          missing: [],
        },
      },
      answer_contract: {
        version: 1,
        answer_focus: 'runtime_generation' as const,
        entrypoint_scope: 'setup_context' as const,
        required_elements: ['main_pipeline_phases'],
        do_not_claim: ['irrelevant_model_or_provider_details'],
        observed_phases: ['controller', 'service', 'queue', 'worker', 'report_builder', 'persistence'],
        missing_phases: [],
      },
    } satisfies import('../../src/runtime/retrieve.js').RetrieveResult
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn().mockReturnValue(retrieval),
      compactRetrieveResult,
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    const output = await runContextPackCommand({
      prompt: 'How idea report is being generated',
      budget: 1800,
      task: 'explain',
      graphPath: 'out/graph.json',
      retrievalStrategy: 'slice-v1',
      format: 'json',
    }, dependencies)

    const payload = JSON.parse(output) as {
      evidence?: {
        pack_confidence?: string
        coverage?: string
        agent_directive?: string
      }
      governance?: {
        version?: number
        surface?: string
        privacy_boundary?: {
          source_safe?: boolean
        }
        directive?: {
          agent_directive?: string
        }
        follow_up?: {
          expandable_handle_count?: number
          preview_item_count?: number
        }
      }
      expandable?: unknown[]
      workflow_centers?: Array<{ path?: string; label?: string }>
      recommended_first_read?: Array<{ path?: string; label?: string }>
      negative_guidance?: string[]
    }

    expect(payload.evidence).toEqual(expect.objectContaining({
      pack_confidence: 'high',
      coverage: 'complete',
      agent_directive: 'answer_from_pack',
    }))
    expect(payload.governance).toEqual(expect.objectContaining({
      version: 1,
      surface: 'cli_pack',
      privacy_boundary: {
        source_safe: true,
      },
      directive: expect.objectContaining({
        agent_directive: 'answer_from_pack',
      }),
    }))
    expect(payload.governance?.follow_up).toBeUndefined()
    expect(payload.expandable).toEqual([])
    expect(JSON.stringify(payload.governance)).not.toContain('How idea report is being generated')
    expect(JSON.stringify(payload.governance)).not.toContain('src/ideas/')
    expect(payload.workflow_centers?.slice(0, 4)).toEqual([
      expect.objectContaining({
        path: 'src/ideas/controller.ts',
        label: 'IdeasController.generateReport',
      }),
      expect.objectContaining({
        path: 'src/ideas/report-service.ts',
        label: 'IdeaReportService.generateReport',
      }),
      expect.objectContaining({
        path: 'src/ideas/report-queue.ts',
        label: 'IdeaReportQueue.enqueue',
      }),
      expect.objectContaining({
        path: 'src/ideas/report-worker.ts',
        label: 'IdeaReportWorker.process',
      }),
    ])
    expect(payload.recommended_first_read).toEqual([
      expect.objectContaining({
        path: 'src/ideas/controller.ts',
        label: 'IdeasController.generateReport',
      }),
      expect.objectContaining({
        path: 'src/ideas/report-service.ts',
        label: 'IdeaReportService.generateReport',
      }),
      expect.objectContaining({
        path: 'src/ideas/report-queue.ts',
        label: 'IdeaReportQueue.enqueue',
      }),
    ])
    expect(payload.negative_guidance).toEqual(expect.arrayContaining([
      expect.stringContaining('src/ideas/report-status.ts'),
      expect.stringContaining('src/ideas/next-steps.ts'),
    ]))
  })

  it('defaults runtime-generation explain JSON to an answer-ready payload with serialized budget enforcement', async () => {
    const graph = buildRuntimeGenerationGraph()
    const noisySelectedPaths = Array.from({ length: 80 }, (_, index) => ({
      from_id: `helper_${index}`,
      from: `Helper${index}.formatStatus`,
      to_id: `target_${index}`,
      to: `Target${index}.renderSummary`,
      relation: 'calls',
      direction: 'forward' as const,
    }))
    const retrieval = {
      question: 'How idea report is being generated',
      token_count: 220,
      matched_nodes: [
        {
          node_id: 'controller_entry',
          label: 'IdeasController.generateReport',
          source_file: 'src/ideas/controller.ts',
          line_number: 40,
          file_type: 'code',
          snippet: 'return this.reportService.generateReport(id)',
          match_score: 0.92,
          relevance_band: 'direct' as const,
          community: 0,
          community_label: 'Idea report runtime',
        },
        {
          node_id: 'service_handoff',
          label: 'IdeaReportService.generateReport',
          source_file: 'src/ideas/report-service.ts',
          line_number: 58,
          file_type: 'code',
          snippet: 'await queue.enqueue(reportJob)',
          match_score: 0.88,
          relevance_band: 'direct' as const,
          community: 0,
          community_label: 'Idea report runtime',
        },
      ],
      relationships: [
        { from_id: 'controller_entry', from: 'IdeasController.generateReport', to_id: 'service_handoff', to: 'IdeaReportService.generateReport', relation: 'calls' },
      ],
      community_context: [
        { id: 0, label: 'Idea report runtime', node_count: 12 },
      ],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      claims: [],
      expandable: [],
      coverage: {
        required_evidence: ['primary', 'supporting', 'structural'] as const,
        semantic_required: ['implementation', 'structure'] as const,
        semantic_optional: ['contracts', 'configuration', 'tests'] as const,
        entries: [],
        semantic_entries: [],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 1,
        selected_relationships: 1,
      },
      retrieval_gate: {
        level: 4,
        skipped_retrieval: false,
        reason: 'manual override',
        intent: 'explain',
        signals: {
          has_pr_diff: false,
          has_stack_trace: false,
          mentioned_paths: [],
          mentioned_symbols: [],
          generation_intent: 'runtime_generation' as const,
          target_domain_hint: 'backend_runtime' as const,
        },
      },
      retrieval_strategy: 'slice-v1' as const,
      slice: {
        mode: 'explain' as const,
        anchors: [
          { node_id: 'controller_entry', label: 'IdeasController.generateReport', reason: 'source path token match' },
        ],
        directions: ['forward' as const],
        selected_paths: noisySelectedPaths,
      },
      execution_slice: {
        status: 'complete' as const,
        confidence: 'high' as const,
        confidence_reasons: ['explicit_anchor', 'runtime_handoff_evidence', 'expected_phases_covered'],
        steps: [
          {
            node_id: 'controller_entry',
            label: 'IdeasController.generateReport',
            source_file: 'src/ideas/controller.ts',
            line_number: 40,
            node_kind: 'method',
          },
          {
            node_id: 'service_handoff',
            label: 'IdeaReportService.generateReport',
            source_file: 'src/ideas/report-service.ts',
            line_number: 58,
            node_kind: 'method',
          },
        ],
        side_effects: Array.from({ length: 20 }, (_, index) => ({
          steps: [
            {
              label: `Helper${index}.formatStatus`,
              source_file: `src/ideas/helpers/${index}.ts`,
              line_number: index + 1,
            },
          ],
        })),
        phase_coverage: {
          expected: ['controller', 'service'],
          observed: ['controller', 'service'],
          missing: [],
        },
      },
      answer_contract: {
        version: 1,
        answer_focus: 'runtime_generation' as const,
        entrypoint_scope: 'setup_context' as const,
        required_elements: ['main_pipeline_phases'],
        do_not_claim: ['irrelevant_model_or_provider_details'],
        observed_phases: ['controller', 'service'],
        missing_phases: [],
        confidence: 'high' as const,
      },
      retrieval_plan: {
        version: 1,
        status: 'recovered',
        reasons: ['low_workflow_coherence'],
        initial: {
          selected_nodes: 30,
          selected_files: 20,
          direct_matches: 20,
          explicit_anchors: 0,
          workflow_coherence: 0.1,
          missing_required_evidence: 1,
          missing_semantic_evidence: 0,
          token_count: 1_600,
        },
        final: {
          selected_nodes: 2,
          selected_files: 2,
          direct_matches: 2,
          explicit_anchors: 0,
          workflow_coherence: 1,
          missing_required_evidence: 0,
          missing_semantic_evidence: 0,
          token_count: 700,
        },
        attempts: [{
          fallback: 'repository_vocabulary_v1',
          status: 'applied',
          reasons: ['low_workflow_coherence'],
          vocabulary_sources: ['exported_symbol', 'module_name'],
          expansion_terms: ['controller', 'service'],
          promoted_candidates: 12,
          changed_result: true,
          added_selected_files: 2,
          removed_selected_files: 20,
        }],
        selected_fallback: 'repository_vocabulary_v1',
      },
    } satisfies import('../../src/runtime/retrieve.js').RetrieveResult
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn().mockReturnValue(retrieval),
      compactRetrieveResult,
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    const output = await runContextPackCommand({
      prompt: retrieval.question,
      budget: 800,
      task: 'explain',
      graphPath: 'out/graph.json',
      retrievalStrategy: 'slice-v1',
      format: 'json',
    }, dependencies)
    const payload = JSON.parse(output) as {
      serialized_budget?: { token_count?: number; max_tokens?: number; enforced?: boolean }
      pack?: {
        slice?: { selected_paths?: unknown[]; selected_path_count?: number }
        execution_slice?: { side_effects?: unknown[] }
        retrieval_plan?: {
          version?: number
          status?: string
          reasons?: string[]
          selected_fallback?: string
          attempts?: Array<{ fallback?: string; status?: string; changed_result?: boolean; expansion_terms?: unknown }>
          initial?: unknown
          final?: unknown
        }
      }
      evidence?: { agent_directive?: string }
      governance?: {
        request?: { task_intent?: string; retrieval_strategy?: string }
      }
      recommended_first_read?: Array<{ path?: string }>
    }

    expect(estimateQueryTokens(output)).toBeLessThanOrEqual(800)
    expect(payload.serialized_budget).toEqual(expect.objectContaining({
      max_tokens: 800,
      enforced: true,
    }))
    expect(payload.serialized_budget?.token_count).toBeLessThanOrEqual(800)
    expect(payload.pack?.slice?.selected_paths).toBeUndefined()
    expect(payload.pack?.slice?.selected_path_count).toBe(noisySelectedPaths.length)
    expect(payload.pack?.execution_slice?.side_effects).toBeUndefined()
    expect(payload.pack?.retrieval_plan).toEqual({
      version: 1,
      status: 'recovered',
      reasons: ['low_workflow_coherence'],
      selected_fallback: 'repository_vocabulary_v1',
      attempts: [{
        fallback: 'repository_vocabulary_v1',
        status: 'applied',
        changed_result: true,
      }],
    })
    expect(payload.evidence?.agent_directive).toBe('answer_from_pack')
    expect(payload.governance?.request).toEqual(expect.objectContaining({
      task_intent: 'explain',
      retrieval_strategy: 'slice-v1',
    }))
    expect(payload.recommended_first_read?.map((entry) => entry.path)).toEqual([
      'src/ideas/controller.ts',
      'src/ideas/report-service.ts',
    ])
  })

  it('does not preserve a ready verdict when the serialized pack omits prompt obligations', async () => {
    const prompt = 'Explain the exact end-to-end path from a failed HTTP monitor check to incident creation, notification delivery, and the public status-page result. Compare every distinct overall-status computation. Read-only: do not modify files.'
    const graph = buildCrossLayerMonitorFlowFixture()
    const retrieval = retrieveContext(graph, {
      question: prompt,
      budget: 1_800,
      taskKind: 'explain',
      retrievalStrategy: 'slice-v1',
    })
    const compact = compactRetrieveResult(retrieval)
    const omittedNodeIds = new Set(
      compact.matched_nodes
        .filter((node) => /apps\/workflows\/src\/checker\/(?:index|alerting|utils)\.ts$/.test(node.source_file))
        .flatMap((node) => node.node_id ? [node.node_id] : []),
    )
    const serialized = {
      ...compact,
      matched_nodes: compact.matched_nodes.filter((node) => !node.node_id || !omittedNodeIds.has(node.node_id)),
      relationships: compact.relationships.filter((relationship) => (
        (!relationship.from_id || !omittedNodeIds.has(relationship.from_id))
        && (!relationship.to_id || !omittedNodeIds.has(relationship.to_id))
      )),
    }
    const optimisticRetrieval: RetrieveResult = {
      ...retrieval,
      recovery: {
        ...retrieval.recovery!,
        status: 'not_needed',
        initial_state: 'ready',
        final_state: 'ready',
        attempts: [],
        improved: false,
      },
    }
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn().mockReturnValue(optimisticRetrieval),
      compactRetrieveResult: vi.fn().mockReturnValue(serialized),
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    const payload = JSON.parse(await runContextPackCommand({
      prompt,
      budget: 1_800,
      task: 'explain',
      graphPath: 'out/graph.json',
      retrievalStrategy: 'slice-v1',
      format: 'json',
    }, dependencies)) as {
      evidence?: {
        coverage?: string
        coverage_detail?: { missing_obligations?: string[] }
        answerability?: { state?: string; broad_search_fallback?: string }
        agent_directive?: string
      }
      pack?: {
        matched_nodes?: Array<{ label: string; source_file: string; snippet?: string | null }>
        retrieval_plan?: { query_obligations?: { total?: number; finally_covered?: number } }
      }
    }

    expect(optimisticRetrieval.recovery?.final_state).toBe('ready')
    expect(payload.evidence).toMatchObject({
      coverage: 'partial',
      answerability: {
        state: 'verify_targets',
        broad_search_fallback: 'targeted_only',
      },
      agent_directive: 'verify_one_targeted_file',
    })
    expect(payload.evidence?.coverage_detail?.missing_obligations).toEqual(expect.arrayContaining([
      'query:obligation:2',
      'query:obligation:3',
    ]))
  })

  it('reconciles a retained retrieval-plan receipt to the serialized snippets', () => {
    const prompt = 'Explain the exact end-to-end path from a failed HTTP monitor check to incident creation, notification delivery, and the public status-page result. Compare every distinct overall-status computation. Read-only: do not modify files.'
    const retrieval = retrieveContext(buildCrossLayerMonitorFlowFixture(), {
      question: prompt,
      budget: 1_800,
      taskKind: 'explain',
      retrievalStrategy: 'slice-v1',
    })
    const compact = compactRetrieveResult(retrieval)
    const omittedNodeIds = new Set(
      compact.matched_nodes
        .filter((node) => /apps\/workflows\/src\/checker\/(?:index|alerting|utils)\.ts$/.test(node.source_file))
        .flatMap((node) => node.node_id ? [node.node_id] : []),
    )
    const { score: _score, ...evidence } = assessMadarResponseEvidence({
      evidencePlan: buildRetrievalEvidencePlanFromResult(retrieval),
      question: prompt,
      recovery: retrieval.recovery,
    })
    const payload = buildAnswerReadyPackSchema({
      schema_version: 1,
      task: 'explain',
      prompt,
      budget: 5_000,
      evidence,
      pack: {
        ...compact,
        matched_nodes: compact.matched_nodes.filter((node) => !node.node_id || !omittedNodeIds.has(node.node_id)),
      },
    }, 5_000, retrieval.selection_diagnostics)
    const pack = payload.pack as {
      matched_nodes: Array<{ label: string; source_file: string; snippet?: string | null }>
      retrieval_plan?: { query_obligations?: { total?: number; finally_covered?: number } }
    }

    const serializedCoverage = evaluateQueryEvidenceCoverage(prompt, pack.matched_nodes)
    expect(pack.retrieval_plan?.query_obligations).toMatchObject({
      total: serializedCoverage.total,
      finally_covered: serializedCoverage.covered,
    })
  })

  it('keeps a late unique evidence owner when the eight-node response cap would otherwise drop it', () => {
    const prompt = 'Explain the exact end-to-end path from a failed HTTP monitor check to incident creation, notification delivery, and the public status-page result. Compare every distinct overall-status computation.'
    const retrieval = retrieveContext(buildCrossLayerMonitorFlowFixture(), {
      question: prompt,
      budget: 1_800,
      taskKind: 'explain',
      retrievalStrategy: 'slice-v1',
    })
    const compact = compactRetrieveResult(retrieval)
    const incidentOwner = compact.matched_nodes.find((node) => node.snippet?.includes('insert(incidentTable)'))
    expect(incidentOwner).toBeDefined()
    const nonIncidentNodes = compact.matched_nodes
      .filter((node) => node.node_id !== incidentOwner?.node_id)
      .map((node) => node.snippet?.includes('insert(incidentTable)')
        ? { ...node, snippet: 'const incident = await findOpenIncident(monitorId)' }
        : node)
    const duplicateSource = nonIncidentNodes.find((node) => node.source_file.includes('status-json'))
      ?? nonIncidentNodes[0]!
    const pressuredNodes = [
      ...nonIncidentNodes,
      { ...duplicateSource, node_id: 'duplicate-status-owner-1', label: 'toUnresolvedIncidents' },
      { ...duplicateSource, node_id: 'duplicate-status-owner-2', label: 'unresolvedIncidents' },
      incidentOwner!,
    ]
    const { score: _score, ...evidence } = assessMadarResponseEvidence({
      evidencePlan: buildRetrievalEvidencePlanFromResult(retrieval),
      question: prompt,
      recovery: retrieval.recovery,
    })

    const payload = buildAnswerReadyPackSchema({
      schema_version: 1,
      task: 'explain',
      prompt,
      budget: 5_000,
      evidence,
      expandable: retrieval.expandable ?? [],
      pack: {
        ...compact,
        matched_nodes: pressuredNodes,
      },
    }, 5_000, retrieval.selection_diagnostics)
    const selectedNodes = (payload.pack as {
      matched_nodes: Array<{ node_id?: string; label: string; source_file: string; snippet?: string }>
      retrieval_plan?: { query_obligations?: { total?: number; finally_covered?: number } }
    }).matched_nodes
    const retrievalPlan = (payload.pack as {
      retrieval_plan?: { query_obligations?: { total?: number; finally_covered?: number } }
    }).retrieval_plan
    const serializedEvidence = payload.evidence as {
      answerability?: { state?: string }
      agent_directive?: string
    }

    expect(selectedNodes).toHaveLength(8)
    expect(selectedNodes.some((node) => node.node_id === incidentOwner?.node_id)).toBe(true)
    expect(selectedNodes.map((node) => node.snippet ?? '').join('\n')).toMatch(/insert\(incidentTable\)/)
    expect(serializedEvidence).toMatchObject({
      answerability: { state: expect.stringMatching(/^ready(?:_with_caveat)?$/) },
      agent_directive: 'answer_from_pack',
    })
    const serializedCoverage = evaluateQueryEvidenceCoverage(prompt, selectedNodes)
    expect(retrievalPlan?.query_obligations).toMatchObject({
      total: serializedCoverage.total,
      finally_covered: serializedCoverage.covered,
    })
  })

  it('keeps every cited supporting node when one falls beyond the answer-ready node cap', () => {
    const matchedNodes = Array.from({ length: 9 }, (_, index) => ({
      node_id: `node-${index}`,
      label: `Node${index}`,
      source_file: `src/node-${index}.ts`,
      line_number: index + 1,
      snippet: `export const node${index} = ${index}`,
    }))
    const claimAnchor = matchedNodes[8]!
    const payload = buildAnswerReadyPackSchema({
      prompt: 'Describe this pack.',
      evidence: {
        agent_directive: 'answer_from_pack',
      },
      claims: [{
        evidence_class: 'primary',
        text: `input provenance: ${claimAnchor.label} consumes router output`,
        node_labels: [matchedNodes[0]!.label, claimAnchor.label],
      }],
      pack: {
        matched_nodes: matchedNodes,
        relationships: [],
        community_context: [],
      },
    }, 5_000)
    const selectedNodes = (payload.pack as {
      matched_nodes: Array<{ label: string }>
    }).matched_nodes

    expect(selectedNodes).toHaveLength(8)
    expect(selectedNodes.some((node) => node.label === 'Node0')).toBe(true)
    expect(selectedNodes.some((node) => node.label === claimAnchor.label)).toBe(true)
    expect(selectedNodes.some((node) => node.label === 'Node7')).toBe(false)
  })

  it('compacts envelope metadata and snippets before culling a cross-layer workflow spine', () => {
    const base = buildOversizedAnswerReadySchema()
    const extraNodes = Array.from({ length: 4 }, (_, index) => ({
      node_id: `cross-layer-${index}`,
      label: `CrossLayerStep${index}.run`,
      source_file: `apps/layer-${index}/src/step.ts`,
      line_number: 90 + index,
      snippet: `export async function run${index}() { ${'await downstream.execute(); '.repeat(40)} }`,
    }))
    const allNodes = [...base.pack.matched_nodes, ...extraNodes]
    const relationships = allNodes.slice(1).map((node, index) => ({
      from_id: allNodes[index]?.node_id,
      from: allNodes[index]?.label,
      to_id: node.node_id,
      to: node.label,
      relation: 'calls',
    }))
    const schema = {
      ...base,
      evidence: {
        ...base.evidence,
        evidence_strength: {
          level: 'strong',
          direct_selected_nodes: 8,
          supporting_selected_nodes: 0,
          selected_relationships: relationships.length,
          available_relationships: relationships.length,
          reasons: ['direct graph evidence spans the workflow'],
        },
        coverage_detail: {
          status: 'complete',
          required_obligations: ['failure source', 'incident persistence', 'notification dispatch', 'public status', 'divergence'],
          covered_obligations: ['failure source', 'incident persistence', 'notification dispatch', 'public status', 'divergence'],
          missing_obligations: [],
        },
        answerability: {
          state: 'ready',
          answer_scope: 'complete',
          caveats: [],
          missing_obligations: [],
          verification_targets: [],
          broad_search_fallback: 'not_needed',
        },
        recovery: {
          version: 1,
          status: 'not_needed',
          budget: { max_attempts: 2, max_candidate_nodes: 24, max_elapsed_ms: 2_000, output_token_budget: 1_800 },
          initial_state: 'ready',
          final_state: 'ready',
          attempts: [],
          improved: false,
        },
        discovery_exclusions: {
          policy: 'artifact_path_only',
          total: 15,
          relevant: 0,
          reasons: { env_file: 15 },
          relevant_reasons: {},
        },
        indexing_completeness: {
          state: 'partial',
          total_uncertain: 158,
          relevant_uncertain: 0,
          reasons: { unsupported_file_type: 85 },
          relevant_reasons: {},
        },
      },
      pack: {
        ...base.pack,
        question: base.prompt,
        token_count: 1_793,
        recovery: {
          version: 1,
          status: 'not_needed',
          budget: { max_attempts: 2, max_candidate_nodes: 24, max_elapsed_ms: 2_000, output_token_budget: 1_800 },
          initial_state: 'ready',
          final_state: 'ready',
          attempts: [],
          improved: false,
        },
        matched_nodes: allNodes,
        relationships,
      },
    }

    const payload = buildAnswerReadyPackSchema(schema, 1_800, buildAnswerReadySelectionDiagnostics())
    const pack = payload.pack as {
      matched_nodes?: Array<{ source_file?: string; snippet?: string }>
      relationships?: unknown[]
    }
    const evidence = payload.evidence as {
      pack_confidence?: string
      confidence_reasons?: string[]
    }

    expect(estimateQueryTokens(JSON.stringify(payload))).toBeLessThanOrEqual(1_800)
    expect(payload.serialized_budget).toEqual(expect.objectContaining({
      max_tokens: 1_800,
      enforced: true,
    }))
    expect(pack.matched_nodes).toHaveLength(8)
    expect(new Set(pack.matched_nodes?.map((node) => node.source_file))).toHaveLength(8)
    expect(pack.matched_nodes?.every((node) => (node.snippet?.length ?? 0) <= 300)).toBe(true)
    expect(pack.relationships).toHaveLength(relationships.length)
    expect(evidence.pack_confidence).toBe('high')
    expect(evidence.confidence_reasons ?? []).not.toContain('budget too tight for workflow spine')
  })

  it('preserves existing obligations, caveats, and blocked fallback when tight budgets cull the workflow spine', () => {
    const matchedNodes = Array.from({ length: 6 }, (_, index) => ({
      node_id: `runtime-${index}`,
      label: `RuntimeStep${index}.run`,
      source_file: `src/runtime/step-${index}.ts`,
      line_number: index + 1,
      snippet: 'return workflowResult'.repeat(30),
    }))
    const payload = buildAnswerReadyPackSchema({
      pack: {
        matched_nodes: matchedNodes,
        relationships: [],
        community_context: [],
        execution_slice: {
          status: 'complete',
          confidence: 'high',
          steps: matchedNodes,
          primary_path: { steps: matchedNodes },
        },
      },
      evidence: {
        pack_confidence: 'low',
        evidence_strength: {
          level: 'weak',
          reasons: ['relevant_unreadable_source'],
        },
        coverage: 'partial',
        coverage_detail: {
          status: 'partial',
          required_obligations: ['discovery:unreadable_path'],
          covered_obligations: [],
          missing_obligations: ['discovery:unreadable_path'],
        },
        answerability: {
          state: 'insufficient',
          answer_scope: 'none',
          caveats: ['source reliability is incomplete'],
          missing_obligations: ['discovery:unreadable_path'],
          verification_targets: [],
          broad_search_fallback: 'blocked',
        },
        confidence_reasons: ['relevant unreadable source'],
        agent_directive: 'explore_with_caution',
      },
      routing: { warnings: [] },
    }, 160)
    const pack = payload.pack as { matched_nodes?: unknown[] }
    const evidence = payload.evidence as {
      coverage_detail: { missing_obligations: string[] }
      answerability: {
        state: string
        caveats: string[]
        missing_obligations: string[]
        broad_search_fallback: string
      }
    }

    expect(pack.matched_nodes?.length ?? 0).toBeLessThan(matchedNodes.length)
    expect(evidence.coverage_detail.missing_obligations).toEqual(expect.arrayContaining([
      'discovery:unreadable_path',
      'serialization:workflow_spine',
    ]))
    expect(evidence.answerability).toMatchObject({
      state: 'insufficient',
      broad_search_fallback: 'blocked',
      caveats: expect.arrayContaining([
        'source reliability is incomplete',
        'serialized workflow spine was culled to the output budget',
      ]),
      missing_obligations: expect.arrayContaining([
        'discovery:unreadable_path',
        'serialization:workflow_spine',
      ]),
    })

    const legacyPayload = buildAnswerReadyPackSchema({
      pack: {
        matched_nodes: matchedNodes,
        relationships: [],
        community_context: [],
        execution_slice: {
          status: 'complete',
          confidence: 'high',
          steps: matchedNodes,
          primary_path: { steps: matchedNodes },
        },
      },
      evidence: {
        pack_confidence: 'low',
        evidence_strength: { level: 'weak', reasons: ['relevant_unreadable_source'] },
        coverage: 'complete',
        answerability: {
          state: 'insufficient',
          answer_scope: 'none',
          caveats: ['source reliability is incomplete'],
          missing_obligations: ['discovery:unreadable_path'],
          verification_targets: [{
            handle_id: 'safe-graph-expansion',
            focus_files: [],
            focus_ranges: [],
            reason: 'verify missing graph evidence',
          }],
          broad_search_fallback: 'blocked',
        },
        confidence_reasons: ['relevant unreadable source'],
        agent_directive: 'explore_with_caution',
      },
      routing: { warnings: [] },
    }, 160)
    const legacyEvidence = legacyPayload.evidence as {
      coverage: string
      coverage_detail: { status: string; missing_obligations: string[] }
      answerability: {
        state: string
        missing_obligations: string[]
        broad_search_fallback: string
      }
    }

    expect(legacyEvidence.coverage).toBe('partial')
    expect(legacyEvidence.coverage_detail).toMatchObject({
      status: 'partial',
      missing_obligations: expect.arrayContaining([
        'discovery:unreadable_path',
        'serialization:workflow_spine',
      ]),
    })
    expect(legacyEvidence.answerability).toMatchObject({
      state: 'verify_targets',
      broad_search_fallback: 'blocked',
      missing_obligations: expect.arrayContaining([
        'discovery:unreadable_path',
        'serialization:workflow_spine',
      ]),
    })
  })

  it('keeps debug-heavy path details when pack verbose mode is explicitly requested', async () => {
    const graph = buildRuntimeGenerationGraph()
    const retrieval = retrieveContext(graph, {
      question: 'Trace how `POST /login` reaches persistence in the backend runtime pipeline',
      budget: 1800,
      taskKind: 'explain',
      taskIntent: 'explain',
      retrievalStrategy: 'slice-v1',
    })
    const retrievalWithStalePlan = {
      ...retrieval,
      retrieval_plan: {
        version: 1 as const,
        status: 'kept_initial' as const,
        reasons: ['missing_query_obligations' as const],
        initial: {
          selected_nodes: retrieval.matched_nodes.length,
          selected_files: retrieval.matched_nodes.length,
          direct_matches: retrieval.matched_nodes.length,
          explicit_anchors: 0,
          workflow_coherence: 1,
          missing_required_evidence: 0,
          missing_semantic_evidence: 0,
          token_count: retrieval.token_count,
        },
        final: {
          selected_nodes: retrieval.matched_nodes.length,
          selected_files: retrieval.matched_nodes.length,
          direct_matches: retrieval.matched_nodes.length,
          explicit_anchors: 0,
          workflow_coherence: 1,
          missing_required_evidence: 0,
          missing_semantic_evidence: 0,
          token_count: retrieval.token_count,
        },
        attempts: [],
        query_obligations: { total: 99, initially_covered: 99, finally_covered: 99 },
      },
    }
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn().mockReturnValue(retrievalWithStalePlan),
      compactRetrieveResult,
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
      retrievalStrategy: 'slice-v1',
      format: 'json',
      verbose: true,
    } as never, dependencies)
    const payload = JSON.parse(output) as {
      pack?: {
        slice?: { selected_paths?: unknown[]; selected_path_count?: number }
        matched_nodes?: Array<{ label: string; source_file: string; snippet?: string | null }>
        retrieval_plan?: { query_obligations?: { total?: number; initially_covered?: number; finally_covered?: number } }
      }
    }

    expect(payload.pack?.slice?.selected_paths?.length).toBeGreaterThan(0)
    expect(payload.pack?.slice?.selected_path_count).toBeUndefined()
    const coverage = evaluateQueryEvidenceCoverage(retrieval.question, payload.pack?.matched_nodes ?? [])
    expect(payload.pack?.retrieval_plan?.query_obligations).toEqual(expect.objectContaining({
      total: coverage.total,
      initially_covered: Math.min(99, coverage.total),
      finally_covered: coverage.covered,
    }))
  })

  it('deprioritizes helper-like matched nodes when runtime-generation explain falls back without an execution spine', async () => {
    const graph = buildRuntimeGenerationGraph()
    const retrieval = {
      question: 'How idea report is being generated',
      token_count: 220,
      matched_nodes: [
        {
          node_id: 'status_helper',
          label: 'getStatusMessage',
          source_file: 'src/ideas/report-status.ts',
          line_number: 18,
          file_type: 'code',
          snippet: 'export function getStatusMessage() {}',
          match_score: 0.98,
          relevance_band: 'direct' as const,
          community: 2,
          community_label: 'Idea report helpers',
        },
        {
          node_id: 'next_steps_helper',
          label: 'generateSuggestedNextSteps',
          source_file: 'src/ideas/next-steps.ts',
          line_number: 24,
          file_type: 'code',
          snippet: 'export function generateSuggestedNextSteps() {}',
          match_score: 0.95,
          relevance_band: 'direct' as const,
          community: 2,
          community_label: 'Idea report helpers',
        },
        {
          node_id: 'controller_entry',
          label: 'IdeasController.generateReport',
          source_file: 'src/ideas/controller.ts',
          line_number: 40,
          file_type: 'code',
          snippet: 'return this.reportService.generateReport(id)',
          match_score: 0.74,
          relevance_band: 'direct' as const,
          community: 0,
          community_label: 'Idea report runtime',
        },
        {
          node_id: 'service_handoff',
          label: 'IdeaReportService.generateReport',
          source_file: 'src/ideas/report-service.ts',
          line_number: 58,
          file_type: 'code',
          snippet: 'await queue.enqueue(reportJob)',
          match_score: 0.72,
          relevance_band: 'direct' as const,
          community: 0,
          community_label: 'Idea report runtime',
        },
      ],
      relationships: [],
      community_context: [
        { id: 2, label: 'Idea report helpers', node_count: 8 },
      ],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      claims: [],
      expandable: [],
      coverage: {
        required_evidence: ['primary', 'supporting', 'structural'] as const,
        semantic_required: ['implementation', 'structure'] as const,
        semantic_optional: ['contracts', 'configuration', 'tests'] as const,
        entries: [],
        semantic_entries: [],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 0,
        selected_relationships: 0,
      },
      retrieval_gate: {
        level: 4,
        skipped_retrieval: false,
        reason: 'manual override',
        intent: 'explain',
        signals: {
          has_pr_diff: false,
          has_stack_trace: false,
          mentioned_paths: [],
          mentioned_symbols: [],
          generation_intent: 'runtime_generation' as const,
          target_domain_hint: 'backend_runtime' as const,
        },
      },
      retrieval_strategy: 'slice-v1' as const,
    } satisfies import('../../src/runtime/retrieve.js').RetrieveResult
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn().mockReturnValue(retrieval),
      compactRetrieveResult,
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    const output = await runContextPackCommand({
      prompt: 'How idea report is being generated',
      budget: 1800,
      task: 'explain',
      graphPath: 'out/graph.json',
      retrievalStrategy: 'slice-v1',
      format: 'json',
    }, dependencies)

    const payload = JSON.parse(output) as {
      recommended_first_read?: Array<{ path?: string; reason?: string }>
    }

    expect(payload.recommended_first_read?.slice(0, 2)).toEqual([
      expect.objectContaining({
        path: 'src/ideas/controller.ts',
        reason: expect.stringMatching(/fallback/i),
      }),
      expect.objectContaining({
        path: 'src/ideas/report-service.ts',
        reason: expect.stringMatching(/fallback/i),
      }),
    ])
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

  it('downgrades root non-SPI report-generation packs with weak scope quality and missing answer-containedness', async () => {
    const graph = buildRuntimeGenerationGraph()
    const retrieval = {
      question: 'How idea report is being generated',
      token_count: 260,
      matched_nodes: [
        {
          node_id: 'controller_entry',
          label: 'IdeaGenerationController.generateFromProblem',
          source_file: 'backend/src/modules/ideas/interface/http/idea-generation.controller.ts',
          line_number: 58,
          file_type: 'code',
          snippet: 'return this.pipelineTrigger.startPipeline(problem)',
          match_score: 0.96,
          relevance_band: 'direct' as const,
          community: 0,
          community_label: 'Idea report runtime',
        },
        {
          node_id: 'trigger',
          label: 'PipelineTriggerService.startPipeline',
          source_file: 'backend/src/modules/pipeline/infrastructure/pipeline-trigger.service.ts',
          line_number: 24,
          file_type: 'code',
          snippet: 'return this.queueRegistry.addJob(payload)',
          match_score: 0.93,
          relevance_band: 'direct' as const,
          community: 0,
          community_label: 'Idea report runtime',
        },
      ],
      relationships: [],
      community_context: [{ id: 0, label: 'Idea report runtime', node_count: 12 }],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      claims: [],
      expandable: [],
      coverage: {
        required_evidence: ['primary', 'supporting', 'structural'] as const,
        semantic_required: ['implementation', 'structure'] as const,
        semantic_optional: ['tests'] as const,
        entries: [
          { evidence_class: 'primary', required: true, available_nodes: 2, selected_nodes: 2, status: 'covered' },
          { evidence_class: 'supporting', required: true, available_nodes: 2, selected_nodes: 2, status: 'covered' },
          { evidence_class: 'structural', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
        ],
        semantic_entries: [
          { category: 'implementation', label: 'implementation', required: true, available_nodes: 2, selected_nodes: 2, status: 'covered' },
          { category: 'structure', label: 'structure', required: true, available_nodes: 2, selected_nodes: 2, status: 'covered' },
          { category: 'tests', label: 'tests', required: false, available_nodes: 0, selected_nodes: 0, status: 'missing' },
        ],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 1,
        selected_relationships: 1,
      },
      retrieval_gate: {
        level: 4,
        skipped_retrieval: false,
        reason: 'runtime generation intent — behavior slice retrieval',
        intent: 'unknown',
        signals: {
          has_pr_diff: false,
          has_stack_trace: false,
          mentioned_paths: [],
          mentioned_symbols: [],
          generation_intent: 'runtime_generation' as const,
          target_domain_hint: 'backend_runtime' as const,
        },
      },
      retrieval_strategy: 'slice-v1' as const,
      execution_slice: {
        status: 'partial' as const,
        confidence: 'low' as const,
        confidence_reasons: ['no_runtime_handoff'],
        steps: [
          {
            node_id: 'controller_entry',
            label: 'IdeaGenerationController.generateFromProblem',
            source_file: 'backend/src/modules/ideas/interface/http/idea-generation.controller.ts',
            line_number: 58,
            node_kind: 'method',
          },
          {
            node_id: 'trigger',
            label: 'PipelineTriggerService.startPipeline',
            source_file: 'backend/src/modules/pipeline/infrastructure/pipeline-trigger.service.ts',
            line_number: 24,
            node_kind: 'method',
          },
        ],
        phase_coverage: {
          expected: ['planner', 'external_research_or_api', 'report_builder', 'scoring', 'quality_gate', 'renderer_or_synthesis', 'persistence'],
          observed: ['controller', 'service'],
          missing: ['planner', 'external_research_or_api', 'report_builder', 'scoring', 'quality_gate', 'renderer_or_synthesis', 'persistence'],
        },
      },
      answer_contract: {
        version: 1,
        answer_focus: 'runtime_generation' as const,
        entrypoint_scope: 'setup_context' as const,
        required_elements: ['main_pipeline_phases', 'missing_or_uncertain_phases'],
        do_not_claim: ['full_runtime_certainty_when_slice_is_partial'],
        observed_phases: ['controller', 'service'],
        missing_phases: ['planner', 'external_research_or_api', 'report_builder', 'scoring', 'quality_gate', 'renderer_or_synthesis', 'persistence'],
        confidence: 'low' as const,
      },
    } satisfies RetrieveResult
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn().mockReturnValue(retrieval),
      compactRetrieveResult,
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    const output = await runContextPackCommand({
      prompt: 'How idea report is being generated',
      budget: 1800,
      task: 'explain',
      graphPath: 'out/graph.json',
      retrievalStrategy: 'slice-v1',
      format: 'json',
    }, dependencies)

    const payload = JSON.parse(output) as {
      evidence?: {
        pack_confidence?: string
        agent_directive?: string
        confidence_reasons?: string[]
      }
    }

    expect(payload.evidence?.pack_confidence).toBeTypeOf('string')
    expect(payload.evidence?.agent_directive).toBeTypeOf('string')
    expect(payload.evidence).toEqual(expect.objectContaining({
      pack_confidence: expect.not.stringMatching(/^high$/),
      agent_directive: expect.not.stringMatching(/^answer_from_pack$/),
      confidence_reasons: expect.arrayContaining([
        expect.stringContaining('scope'),
        expect.stringContaining('answer'),
        expect.stringContaining('phase'),
      ]),
    }))
  })

  it('flags root SPI report-generation packs when answer-containedness is still incomplete', async () => {
    const graph = buildRuntimeGenerationGraph()
    const retrieval = {
      question: 'How idea report is being generated',
      token_count: 260,
      matched_nodes: [
        {
          node_id: 'spi_entry',
          label: 'IdeaReportSpi.generate',
          source_file: 'backend/src/spi/idea-report.spi.ts',
          line_number: 12,
          file_type: 'code',
          snippet: 'export interface IdeaReportSpi { generate(): Promise<void> }',
          match_score: 0.97,
          relevance_band: 'direct' as const,
          community: 0,
          community_label: 'Idea report runtime',
        },
      ],
      relationships: [],
      community_context: [{ id: 0, label: 'Idea report runtime', node_count: 12 }],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      claims: [],
      expandable: [],
      coverage: {
        required_evidence: ['primary', 'supporting', 'structural'] as const,
        semantic_required: ['implementation', 'structure'] as const,
        semantic_optional: ['tests'] as const,
        entries: [
          { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { evidence_class: 'supporting', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { evidence_class: 'structural', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
        ],
        semantic_entries: [
          { category: 'implementation', label: 'implementation', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { category: 'structure', label: 'structure', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
          { category: 'tests', label: 'tests', required: false, available_nodes: 0, selected_nodes: 0, status: 'missing' },
        ],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 1,
        selected_relationships: 1,
      },
      retrieval_gate: {
        level: 4,
        skipped_retrieval: false,
        reason: 'runtime generation intent — behavior slice retrieval',
        intent: 'unknown',
        signals: {
          has_pr_diff: false,
          has_stack_trace: false,
          mentioned_paths: [],
          mentioned_symbols: [],
          generation_intent: 'runtime_generation' as const,
          target_domain_hint: 'backend_runtime' as const,
        },
      },
      retrieval_strategy: 'slice-v1' as const,
      execution_slice: {
        status: 'partial' as const,
        confidence: 'medium' as const,
        confidence_reasons: ['missing_phase:persistence'],
        steps: [
          {
            node_id: 'spi_entry',
            label: 'IdeaReportSpi.generate',
            source_file: 'backend/src/spi/idea-report.spi.ts',
            line_number: 12,
            node_kind: 'method',
          },
        ],
        phase_coverage: {
          expected: ['planner', 'report_builder', 'scoring', 'renderer_or_synthesis', 'persistence'],
          observed: ['planner', 'report_builder', 'scoring', 'renderer_or_synthesis'],
          missing: ['persistence'],
        },
      },
      answer_contract: {
        version: 1,
        answer_focus: 'runtime_generation' as const,
        entrypoint_scope: 'setup_context' as const,
        required_elements: ['main_pipeline_phases', 'persistence_or_artifact_storage'],
        do_not_claim: ['full_runtime_certainty_when_slice_is_partial'],
        observed_phases: ['planner', 'report_builder', 'scoring', 'renderer_or_synthesis'],
        missing_phases: ['persistence'],
        confidence: 'medium' as const,
      },
    } satisfies RetrieveResult
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn().mockReturnValue(retrieval),
      compactRetrieveResult,
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    const output = await runContextPackCommand({
      prompt: 'How idea report is being generated',
      budget: 1800,
      task: 'explain',
      graphPath: 'out/graph.json',
      retrievalStrategy: 'slice-v1',
      format: 'json',
    }, dependencies)

    const payload = JSON.parse(output) as {
      evidence?: {
        pack_confidence?: string
        agent_directive?: string
        confidence_reasons?: string[]
      }
    }

    expect(payload.evidence?.pack_confidence).toBeTypeOf('string')
    expect(payload.evidence?.agent_directive).toBeTypeOf('string')
    expect(payload.evidence).toEqual(expect.objectContaining({
      pack_confidence: expect.not.stringMatching(/^high$/),
      agent_directive: expect.not.stringMatching(/^answer_from_pack$/),
      confidence_reasons: expect.arrayContaining([
        expect.stringContaining('phase'),
        expect.stringContaining('answer'),
      ]),
    }))
  })

  it('keeps backend SPI report-generation packs high confidence and answer_from_pack when the answer is contained', async () => {
    const graph = buildRuntimeGenerationGraph()
    const retrieval = {
      question: 'How idea report is being generated',
      token_count: 260,
      matched_nodes: [
        {
          node_id: 'spi_entry',
          label: 'IdeaReportSpi.generate',
          source_file: 'src/spi/idea-report.spi.ts',
          line_number: 12,
          file_type: 'code',
          snippet: 'export interface IdeaReportSpi { generate(): Promise<void> }',
          match_score: 0.97,
          relevance_band: 'direct' as const,
          community: 0,
          community_label: 'Idea report runtime',
        },
        {
          node_id: 'worker_entry',
          label: 'IdeaReportWorker.process',
          source_file: 'src/ideas/report-worker.ts',
          line_number: 84,
          file_type: 'code',
          snippet: 'return this.assembler.build(job)',
          match_score: 0.9,
          relevance_band: 'direct' as const,
          community: 0,
          community_label: 'Idea report runtime',
        },
      ],
      relationships: [],
      community_context: [{ id: 0, label: 'Idea report runtime', node_count: 12 }],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      claims: [],
      expandable: [],
      coverage: {
        required_evidence: ['primary', 'supporting', 'structural'] as const,
        semantic_required: ['implementation', 'structure'] as const,
        semantic_optional: ['tests'] as const,
        entries: [
          { evidence_class: 'primary', required: true, available_nodes: 2, selected_nodes: 2, status: 'covered' },
          { evidence_class: 'supporting', required: true, available_nodes: 2, selected_nodes: 2, status: 'covered' },
          { evidence_class: 'structural', required: true, available_nodes: 2, selected_nodes: 2, status: 'covered' },
        ],
        semantic_entries: [
          { category: 'implementation', label: 'implementation', required: true, available_nodes: 2, selected_nodes: 2, status: 'covered' },
          { category: 'structure', label: 'structure', required: true, available_nodes: 2, selected_nodes: 2, status: 'covered' },
          { category: 'tests', label: 'tests', required: false, available_nodes: 1, selected_nodes: 1, status: 'covered' },
        ],
        missing_required: [],
        missing_semantic: [],
        available_relationships: 2,
        selected_relationships: 2,
      },
      retrieval_gate: {
        level: 4,
        skipped_retrieval: false,
        reason: 'runtime generation intent — behavior slice retrieval',
        intent: 'unknown',
        signals: {
          has_pr_diff: false,
          has_stack_trace: false,
          mentioned_paths: [],
          mentioned_symbols: [],
          generation_intent: 'runtime_generation' as const,
          target_domain_hint: 'backend_runtime' as const,
        },
      },
      retrieval_strategy: 'slice-v1' as const,
      execution_slice: {
        status: 'complete' as const,
        confidence: 'high' as const,
        confidence_reasons: ['explicit_anchor', 'runtime_handoff_evidence', 'expected_phases_covered'],
        steps: [
          {
            node_id: 'spi_entry',
            label: 'IdeaReportSpi.generate',
            source_file: 'src/spi/idea-report.spi.ts',
            line_number: 12,
            node_kind: 'method',
          },
          {
            node_id: 'worker_entry',
            label: 'IdeaReportWorker.process',
            source_file: 'src/ideas/report-worker.ts',
            line_number: 84,
            node_kind: 'method',
          },
        ],
        primary_path: {
          steps: [],
          boundaries: [{ relation: 'enqueues_job' }],
        },
        phase_coverage: {
          expected: ['planner', 'report_builder', 'scoring', 'renderer_or_synthesis', 'persistence'],
          observed: ['planner', 'report_builder', 'scoring', 'renderer_or_synthesis', 'persistence'],
          missing: [],
        },
      },
      answer_contract: {
        version: 1,
        answer_focus: 'runtime_generation' as const,
        entrypoint_scope: 'setup_context' as const,
        required_elements: ['main_pipeline_phases', 'persistence_or_artifact_storage'],
        do_not_claim: [],
        observed_phases: ['planner', 'report_builder', 'scoring', 'renderer_or_synthesis', 'persistence'],
        missing_phases: [],
        confidence: 'high' as const,
      },
    } satisfies RetrieveResult
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn().mockReturnValue(retrieval),
      compactRetrieveResult,
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    const output = await runContextPackCommand({
      prompt: 'How idea report is being generated',
      budget: 1800,
      task: 'explain',
      graphPath: 'backend/out/graph.json',
      retrievalStrategy: 'slice-v1',
      format: 'json',
    }, dependencies)

    const payload = JSON.parse(output) as {
      evidence?: {
        pack_confidence?: string
        agent_directive?: string
        confidence_reasons?: string[]
      }
    }

    expect(payload.evidence).toEqual(expect.objectContaining({
      pack_confidence: 'high',
      agent_directive: 'answer_from_pack',
      confidence_reasons: expect.arrayContaining([
        expect.stringContaining('scope'),
        expect.stringContaining('answer'),
      ]),
    }))
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

  it('adds implementation guidance sections for implement packs', async () => {
    const graph = buildImplementationPackGraph()
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
      prompt: 'Implement issue #275: add implementation-task context packs with validation commands for context_pack',
      budget: 2400,
      task: 'implement',
      taskExplicit: true,
      graphPath: 'out/graph.json',
    } as never, dependencies)

    const payload = JSON.parse(output) as {
      task?: string
      implementation?: {
        likely_edit_files?: Array<{ path?: string; score?: number; reason?: string }>
        likely_test_files?: Array<{ path?: string; score?: number; reason?: string }>
        contracts_and_public_surfaces?: Array<{ source_file?: string; kind?: string }>
        existing_patterns?: Array<{ source_file?: string; kind?: string }>
        validation_commands?: string[]
        risk_boundaries?: Array<{ label?: string }>
      }
    }

    expect(payload.task).toBe('implement')
    expect(payload.implementation).toEqual(expect.objectContaining({
      likely_edit_files: expect.arrayContaining([
        expect.objectContaining({ path: 'src/infrastructure/context-pack-command.ts', score: expect.any(Number), reason: expect.any(String) }),
        expect.objectContaining({ path: 'src/runtime/retrieve.ts', score: expect.any(Number), reason: expect.any(String) }),
      ]),
      likely_test_files: expect.arrayContaining([
        expect.objectContaining({ path: 'tests/unit/context-pack-command.test.ts', score: expect.any(Number), reason: expect.any(String) }),
        expect.objectContaining({ path: 'tests/e2e/context-pack.e2e.test.ts', score: expect.any(Number), reason: expect.stringMatching(/e2e|integration|entry/i) }),
      ]),
      contracts_and_public_surfaces: expect.arrayContaining([
        expect.objectContaining({ source_file: 'src/contracts/context-pack.ts', kind: 'contract' }),
        expect.objectContaining({ source_file: 'src/runtime/stdio/definitions.ts', kind: 'public_surface' }),
      ]),
      validation_commands: expect.arrayContaining([
        'npm run typecheck',
        'npm run build',
        expect.stringMatching(/npm run test:run -- .*context-pack-command\.test\.ts/),
      ]),
      risk_boundaries: expect.arrayContaining([
        expect.objectContaining({ label: 'retrieveContext' }),
      ]),
    }))
    expect(payload.implementation?.existing_patterns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'pattern',
        source_file: expect.stringMatching(/^src\//),
      }),
    ]))
    expect(payload.implementation?.likely_edit_files?.every((entry) => !entry.path?.startsWith('tests/'))).toBe(true)
  })

  it('emits a pack schema v1 envelope for implement packs', async () => {
    const graph = buildImplementationPackGraph()
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn((currentGraph, options) => retrieveContext(currentGraph, options as never)),
      compactRetrieveResult,
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    const runPack = () => runContextPackCommand({
      prompt: 'Implement issue #275: add implementation-task context packs with validation commands for context_pack',
      budget: 2400,
      task: 'implement',
      taskExplicit: true,
      graphPath: 'out/graph.json',
      format: 'json',
    } as never, dependencies)

    const firstOutput = await runPack()
    const secondOutput = await runPack()
    const payload = JSON.parse(firstOutput) as {
      schema_version?: number
      task?: string
      task_intent?: string
      pack?: {
        workflow_centers?: unknown
        recommended_first_read?: unknown
        confidence_score?: unknown
      }
      workflow_centers?: Array<{
        label?: string
        path?: string
        score?: number
        reasons?: string[]
      }>
      recommended_first_read?: Array<{ path?: string }>
      likely_edit_files?: Array<{ path?: string; score?: number; reason?: string }>
      likely_test_files?: Array<{ path?: string; score?: number; reason?: string }>
      public_contracts?: Array<{ source_file?: string; kind?: string }>
      risk_boundaries?: Array<{ label?: string }>
      validation_commands?: string[]
      negative_guidance?: string[]
      confidence_score?: number
      why_explanation?: string[]
    }

    expect(firstOutput).toBe(secondOutput)
    expect(payload).toEqual(expect.objectContaining({
      schema_version: 1,
      task: 'implement',
      task_intent: 'implement',
      retrieval_pipeline: expect.objectContaining({
        phases: [
          expect.objectContaining({ phase: 'seed' }),
          expect.objectContaining({ phase: 'expand' }),
          expect.objectContaining({ phase: 'promote' }),
          expect.objectContaining({ phase: 'attach' }),
          expect.objectContaining({ phase: 'refine' }),
          expect.objectContaining({ phase: 'render' }),
        ],
      }),
      workflow_centers: expect.arrayContaining([
        expect.objectContaining({
          label: expect.any(String),
          path: expect.stringMatching(/^src\//),
          score: expect.any(Number),
          reasons: expect.arrayContaining([expect.any(String)]),
        }),
      ]),
      likely_edit_files: expect.arrayContaining([
        expect.objectContaining({
          path: 'src/infrastructure/context-pack-command.ts',
          score: expect.any(Number),
          reason: expect.any(String),
          phases: expect.arrayContaining([expect.any(String)]),
        }),
      ]),
      likely_test_files: expect.arrayContaining([
        expect.objectContaining({ path: 'tests/unit/context-pack-command.test.ts', score: expect.any(Number), reason: expect.any(String) }),
        expect.objectContaining({ path: 'tests/e2e/context-pack.e2e.test.ts', score: expect.any(Number), reason: expect.any(String) }),
      ]),
      public_contracts: expect.arrayContaining([
        expect.objectContaining({ source_file: 'src/contracts/context-pack.ts', kind: 'contract' }),
      ]),
      risk_boundaries: expect.arrayContaining([
        expect.objectContaining({ label: 'retrieveContext' }),
      ]),
      validation_commands: expect.arrayContaining([
        'npm run typecheck',
        'npm run build',
      ]),
      negative_guidance: expect.arrayContaining([expect.any(String)]),
      confidence_score: expect.any(Number),
      why_explanation: expect.arrayContaining([expect.any(String)]),
    }))
    expect(payload.recommended_first_read?.[0]?.path).toBe(payload.workflow_centers?.[0]?.path)
    expect(payload.recommended_first_read?.[0]?.path).toBe('src/infrastructure/context-pack-command.ts')
    expect(payload.likely_edit_files?.some((entry) => entry.path === 'src/contracts/context-pack.ts')).toBe(false)
    expect(payload.pack?.workflow_centers).toBeUndefined()
    expect(payload.pack?.recommended_first_read).toBeUndefined()
    expect(payload.pack?.confidence_score).toBeUndefined()
  })

  it('surfaces lexical helpers as negative guidance instead of edit targets for implementation packs', async () => {
    const graph = buildImplementationPackDistractorGraph()
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
      prompt: 'Implement context pack command compression guidance',
      budget: 1800,
      task: 'implement',
      taskExplicit: true,
      graphPath: 'out/graph.json',
      format: 'json',
    } as never, dependencies)

    const payload = JSON.parse(output) as {
      likely_edit_files?: Array<{ path?: string }>
      negative_guidance?: string[]
    }

    expect(payload.likely_edit_files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/infrastructure/context-pack-command.ts' }),
    ]))
    expect(payload.likely_edit_files?.some((entry) => entry.path === 'src/infrastructure/context-pack-helper.ts')).toBe(false)
    expect(payload.negative_guidance).toEqual(expect.arrayContaining([
      expect.stringContaining('src/infrastructure/context-pack-helper.ts'),
    ]))
  })

  it('renders pack schema v1 as a generic markdown brief', async () => {
    const graph = buildImplementationPackGraph()
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
      prompt: 'Implement issue #275: add implementation-task context packs with validation commands for context_pack',
      budget: 2400,
      task: 'implement',
      taskExplicit: true,
      graphPath: 'out/graph.json',
      format: 'markdown',
    } as never, dependencies)

    expect(output).toContain('# Pack Schema v1')
    expect(output).toContain('Task: implement')
    expect(output).toContain('## Workflow centers')
    expect(output).toContain('## Recommended first read')
    expect(output).toContain('## Likely edit files')
    expect(output).toContain('## Likely test files')
    expect(output).toContain('## Public contracts')
    expect(output).toContain('## Risk boundaries')
    expect(output).toContain('## Validation commands')
    expect(output).toContain('## Negative guidance')
    expect(output).toContain('## Why this pack')
    expect(output).toContain('Confidence score:')
    expect(output).not.toContain(': undefined')
  })

  it('keeps the legacy text adapter output stable', async () => {
    const graph = buildImplementationPackGraph()
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
      prompt: 'Implement issue #275: add implementation-task context packs with validation commands for context_pack',
      budget: 2400,
      task: 'implement',
      taskExplicit: true,
      graphPath: 'out/graph.json',
      format: 'text',
    } as never, dependencies)

    expect(output).toContain('Pack Schema v1')
    expect(output).toContain('Task: implement')
    expect(output).toContain('Workflow centers')
    expect(output).toContain('Recommended first read')
    expect(output).toContain('Likely edit files')
    expect(output).toContain('Retrieval pipeline')
    expect(output).toContain('Validation commands')
    expect(output).not.toContain('# Pack Schema v1')
    expect(output).not.toContain('## Workflow centers')
    expect(output).not.toContain(': undefined')
    expect(output.match(/^Workflow centers$/gm)).toHaveLength(1)
  })

  it('renders a claude adapter brief with confidence-aware execution guidance', async () => {
    const graph = buildImplementationPackGraph()
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
      prompt: 'Implement issue #275: add implementation-task context packs with validation commands for context_pack',
      budget: 2400,
      task: 'implement',
      taskExplicit: true,
      graphPath: 'out/graph.json',
      format: 'claude',
    } as never, dependencies)

    expect(output).toContain('# Claude Code execution brief')
    expect(output).toContain('## Start here')
    expect(output).toContain('Use targeted verification to confirm the listed starting points before widening the search.')
    expect(output).toContain('## Workflow centers')
    expect(output).toContain('## Likely edit files')
    expect(output).toContain('## Likely test files')
    expect(output).toContain('## Public contracts')
    expect(output).toContain('## Risk boundaries')
    expect(output).toContain('## Validation commands')
    expect(output).toContain('## Negative guidance')
    expect(output).toContain('## Why this pack')
    expect(output).not.toContain(': undefined')
  })

  it('renders a copilot adapter brief with a confidence-aware implementation plan', async () => {
    const graph = buildImplementationPackGraph()
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
      prompt: 'Implement issue #275: add implementation-task context packs with validation commands for context_pack',
      budget: 2400,
      task: 'implement',
      taskExplicit: true,
      graphPath: 'out/graph.json',
      format: 'copilot',
    } as never, dependencies)

    expect(output).toContain('# GitHub Copilot implementation brief')
    expect(output).toContain('## Suggested plan')
    expect(output).toContain('Verify the suggested starting file against the prompt and workflow centers before editing.')
    expect(output).toContain('## Workflow centers')
    expect(output).toContain('## Likely edit files')
    expect(output).toContain('## Likely test files')
    expect(output).toContain('## Public contracts')
    expect(output).toContain('## Risk boundaries')
    expect(output).toContain('## Validation commands')
    expect(output).toContain('## Negative guidance')
    expect(output).toContain('## Why this pack')
    expect(output).not.toContain(': undefined')
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

  it('rejects requireFreshContext for review packs instead of silently ignoring it', async () => {
    const graph = new KnowledgeGraph()
    const dependencies: ContextPackCommandDependencies = {
      loadGraph: vi.fn().mockReturnValue(graph),
      retrieveContext: vi.fn(),
      compactRetrieveResult: vi.fn(),
      analyzePrImpact: vi.fn(),
      compactPrImpactResult: vi.fn(),
      analyzeImpact: vi.fn(),
      compactImpactResult: vi.fn(),
    }

    await expect(runContextPackCommand({
      prompt: 'review current diff',
      budget: 1800,
      task: 'review',
      graphPath: 'out/graph.json',
      requireFreshContext: true,
    }, dependencies)).rejects.toThrow(/requireFreshContext.*review/i)
    expect(dependencies.analyzePrImpact).not.toHaveBeenCalled()
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
