import { describe, expect, it } from 'vitest'

import { build } from '../../src/pipeline/build.js'
import { computeContextPackDiagnostics } from '../../src/runtime/context-pack-diagnostics.js'
import { contextPackFromRetrieveResult, retrieveContext } from '../../src/runtime/retrieve.js'

function buildProductionPipelineGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'ideas_controller', label: 'IdeasController', file_type: 'code', source_file: '/src/ideas/ideas.controller.ts', source_location: 'L5', node_kind: 'class', framework: 'nestjs', framework_role: 'nest_controller', community: 0 },
          { id: 'ideas_method', label: 'IdeasController.generateFromProblem', file_type: 'code', source_file: '/src/ideas/ideas.controller.ts', source_location: 'L18', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_controller', community: 0 },
          { id: 'ideas_method_duplicate', label: 'IdeasController.generateFromProblem', file_type: 'code', source_file: '/backend/.worktrees/copy/src/ideas/ideas.controller.ts', source_location: 'L18', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_controller', community: 8 },
          { id: 'ideas_list', label: 'IdeasController.listIdeas', file_type: 'code', source_file: '/src/ideas/ideas.controller.ts', source_location: 'L42', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_controller', community: 0 },
          { id: 'ideas_health', label: 'IdeasController.health', file_type: 'code', source_file: '/src/ideas/ideas.controller.ts', source_location: 'L50', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_controller', community: 0 },
          { id: 'ideas_route', label: 'POST /ideas/generate', file_type: 'code', source_file: '/src/ideas/ideas.routes.ts', source_location: 'L4', node_kind: 'route', framework: 'nestjs', framework_role: 'nest_route', community: 0 },
          { id: 'ideas_service', label: 'IdeasService', file_type: 'code', source_file: '/src/ideas/ideas.service.ts', source_location: 'L5', node_kind: 'class', framework: 'nestjs', framework_role: 'nest_provider', community: 1 },
          { id: 'ideas_service_method', label: 'IdeasService.generateFromProblem', file_type: 'code', source_file: '/src/ideas/ideas.service.ts', source_location: 'L21', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_provider', community: 1 },
          { id: 'report_orchestrator', label: 'ReportOrchestrator.run', file_type: 'code', source_file: '/src/reporting/report-orchestrator.ts', source_location: 'L9', node_kind: 'method', framework_role: 'orchestrator', community: 2 },
          { id: 'research_agent', label: 'ResearchAgent.search', file_type: 'code', source_file: '/src/research/research-agent.ts', source_location: 'L11', node_kind: 'method', community: 3 },
          { id: 'scoring_service', label: 'ScoringService.score', file_type: 'code', source_file: '/src/scoring/scoring.service.ts', source_location: 'L12', node_kind: 'method', community: 4 },
          { id: 'report_repository', label: 'ReportRepository.save', file_type: 'code', source_file: '/src/persistence/report.repository.ts', source_location: 'L8', node_kind: 'method', framework_role: 'repository', community: 5 },
          { id: 'runtime_config', label: 'VALIDATION_PROVIDER', file_type: 'code', source_file: '/src/config/runtime.ts', source_location: 'L3', node_kind: 'function', community: 6 },
          { id: 'ideas_test', label: 'IdeasController.generateFromProblem.spec', file_type: 'code', source_file: '/src/__tests__/ideas.controller.spec.ts', source_location: 'L5', node_kind: 'function', community: 7 },
          { id: 'html_reporter', label: 'HtmlReporter.render', file_type: 'code', source_file: '/benchmarks/html-reporter.ts', source_location: 'L14', node_kind: 'method', community: 7 },
          { id: 'report_fixture', label: 'idea-report.fixture', file_type: 'code', source_file: '/fixtures/idea-report.fixture.ts', source_location: 'L2', node_kind: 'function', community: 7 },
        ],
        edges: [
          { source: 'ideas_controller', target: 'ideas_method', relation: 'controller_route', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.controller.ts' },
          { source: 'ideas_controller', target: 'ideas_list', relation: 'controller_route', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.controller.ts' },
          { source: 'ideas_controller', target: 'ideas_health', relation: 'controller_route', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.controller.ts' },
          { source: 'ideas_route', target: 'ideas_method', relation: 'route_handler', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.routes.ts' },
          { source: 'ideas_controller', target: 'ideas_service', relation: 'injects', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.controller.ts' },
          { source: 'ideas_method', target: 'ideas_service_method', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.controller.ts' },
          { source: 'ideas_service_method', target: 'report_orchestrator', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.service.ts' },
          { source: 'report_orchestrator', target: 'research_agent', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/reporting/report-orchestrator.ts' },
          { source: 'report_orchestrator', target: 'scoring_service', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/reporting/report-orchestrator.ts' },
          { source: 'report_orchestrator', target: 'report_repository', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/reporting/report-orchestrator.ts' },
          { source: 'ideas_service_method', target: 'runtime_config', relation: 'reads_env', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.service.ts' },
          { source: 'ideas_service_method', target: 'ideas_test', relation: 'covered_by', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.service.ts' },
          { source: 'html_reporter', target: 'report_fixture', relation: 'uses', confidence: 'EXTRACTED', source_file: '/benchmarks/html-reporter.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

function retrieve(prompt: string) {
  return retrieveContext(buildProductionPipelineGraph(), {
    question: prompt,
    budget: 4000,
    retrievalStrategy: 'slice-v1',
  })
}

function buildBidirectionalHubGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'route', label: '.generateFromProblem()', file_type: 'code', source_file: '/src/ideas/idea-generation.controller.ts', source_location: 'L20', node_kind: 'route', framework: 'nestjs', framework_role: 'nest_route', community: 0 },
          { id: 'auth_helper', label: 'requireIdeasUserId', file_type: 'code', source_file: '/src/ideas/ideas-authenticated-request.ts', source_location: 'L6', node_kind: 'function', community: 0 },
          { id: 'create_idea', label: '.createIdea()', file_type: 'code', source_file: '/src/ideas/ideas.service.ts', source_location: 'L30', node_kind: 'method', framework_role: 'nest_provider', community: 1 },
          { id: 'start_pipeline', label: '.startPipeline()', file_type: 'code', source_file: '/src/pipeline/pipeline-trigger.service.ts', source_location: 'L40', node_kind: 'method', framework_role: 'nest_provider', community: 1 },
          { id: 'add_job', label: '.addJob()', file_type: 'code', source_file: '/src/queue/queue-registry.service.ts', source_location: 'L11', node_kind: 'method', framework_role: 'queue', community: 2 },
          { id: 'process', label: '.process()', file_type: 'code', source_file: '/src/pipeline/orchestrator.worker.ts', source_location: 'L12', node_kind: 'method', framework_role: 'worker', community: 2 },
          { id: 'search', label: '.search()', file_type: 'code', source_file: '/src/research/research-agent.service.ts', source_location: 'L11', node_kind: 'method', community: 3 },
          { id: 'score', label: '.score()', file_type: 'code', source_file: '/src/scoring/metrics-scoring.service.ts', source_location: 'L12', node_kind: 'method', community: 3 },
          { id: 'save', label: '.save()', file_type: 'code', source_file: '/src/persistence/report.repository.ts', source_location: 'L8', node_kind: 'method', framework_role: 'repository', community: 3 },
          { id: 'call_llm', label: '.callLlm()', file_type: 'code', source_file: '/src/llm/llm-provider-resolver.service.ts', source_location: 'L14', node_kind: 'method', community: 3 },
          { id: 'resolve_llm', label: '.resolve()', file_type: 'code', source_file: '/src/llm/llm-provider-resolver.service.ts', source_location: 'L8', node_kind: 'method', community: 3 },
          { id: 'other_controller_a', label: '.exportIdeaToPdf()', file_type: 'code', source_file: '/src/ideas/export.controller.ts', source_location: 'L18', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_route', community: 4 },
          { id: 'other_controller_b', label: '.publishIdea()', file_type: 'code', source_file: '/src/ideas/publish.controller.ts', source_location: 'L18', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_route', community: 4 },
          { id: 'other_worker', label: '.queueLetsBuild()', file_type: 'code', source_file: '/src/pipeline/lets-build.worker.ts', source_location: 'L22', node_kind: 'method', community: 5 },
          { id: 'plan_enforcement', label: 'PlanEnforcement', file_type: 'code', source_file: '/src/guards/plan-enforcement.ts', source_location: 'L5', node_kind: 'function', community: 6 },
        ],
        edges: [
          { source: 'route', target: 'auth_helper', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/idea-generation.controller.ts' },
          { source: 'route', target: 'create_idea', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/idea-generation.controller.ts' },
          { source: 'route', target: 'start_pipeline', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/idea-generation.controller.ts' },
          { source: 'route', target: 'plan_enforcement', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/idea-generation.controller.ts' },
          { source: 'start_pipeline', target: 'add_job', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/pipeline-trigger.service.ts' },
          { source: 'add_job', target: 'process', relation: 'enqueues_job', confidence: 'EXTRACTED', source_file: '/src/queue/queue-registry.service.ts' },
          { source: 'process', target: 'search', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/orchestrator.worker.ts' },
          { source: 'process', target: 'score', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/orchestrator.worker.ts' },
          { source: 'process', target: 'save', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/orchestrator.worker.ts' },
          { source: 'call_llm', target: 'resolve_llm', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/llm/llm-provider-resolver.service.ts' },
          { source: 'resolve_llm', target: 'create_idea', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/llm/llm-provider-resolver.service.ts' },

          // Simulate the real GoValidate graph shape where call edges can appear in both directions.
          { source: 'auth_helper', target: 'route', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas-authenticated-request.ts' },
          { source: 'create_idea', target: 'route', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.service.ts' },
          { source: 'start_pipeline', target: 'route', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/pipeline-trigger.service.ts' },
          { source: 'add_job', target: 'start_pipeline', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/queue/queue-registry.service.ts' },

          { source: 'other_controller_a', target: 'auth_helper', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/export.controller.ts' },
          { source: 'other_controller_b', target: 'auth_helper', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/publish.controller.ts' },
          { source: 'other_worker', target: 'add_job', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/lets-build.worker.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

describe('retrieveContext production retrieval regressions', () => {
  it('follows the production runtime path while suppressing excluded test and benchmark domains', () => {
    const result = retrieve(
      'Explain the production backend pipeline that generates an idea validation report. Exclude tests, benchmarks, fixtures, html reporters, and reporter utilities.',
    )

    const labels = result.matched_nodes.map((node) => node.label)
    const sourceFiles = result.matched_nodes.map((node) => node.source_file)
    const signals = result.retrieval_gate?.signals as NonNullable<typeof result.retrieval_gate>['signals'] & {
      excluded_domains?: string[]
      excluded_terms?: string[]
    }

    expect(result.retrieval_gate?.intent).toBe('explain')
    expect(signals.excluded_domains).toEqual(expect.arrayContaining(['test', 'benchmark', 'fixture']))
    expect(signals.excluded_terms).toEqual(expect.arrayContaining(['html reporters', 'reporter utilities']))
    expect(labels).toEqual(expect.arrayContaining([
      'IdeasController.generateFromProblem',
      'IdeasService',
      'IdeasService.generateFromProblem',
      'ReportOrchestrator.run',
      'ResearchAgent.search',
      'ScoringService.score',
      'ReportRepository.save',
    ]))
    expect(labels).not.toContain('IdeasController.listIdeas')
    expect(labels).not.toContain('IdeasController.health')
    expect(labels).not.toContain('IdeasController.generateFromProblem.spec')
    expect(labels).not.toContain('HtmlReporter.render')
    expect(labels).not.toContain('idea-report.fixture')
    expect(sourceFiles.some((sourceFile) => sourceFile.includes('/.worktrees/'))).toBe(false)
  })

  it('promotes explicit Class.method prompts to method anchors instead of controller-class anchors', () => {
    const result = retrieve(
      'Explain the production runtime path for IdeasController.generateFromProblem and how it creates a validation report. Follow the controller into service/orchestrator/job/research agents/scoring/report builder/persistence. Exclude tests, benchmarks, fixtures, html reporters, and reporter utilities.',
    )

    expect(result.slice?.anchors[0]).toEqual(
      expect.objectContaining({
        label: 'IdeasController.generateFromProblem',
        reason: 'symbol mention',
      }),
    )
    expect(result.slice?.selected_paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'IdeasController.generateFromProblem', to: 'IdeasService.generateFromProblem', relation: 'calls' }),
      expect.objectContaining({ from: 'IdeasService.generateFromProblem', to: 'ReportOrchestrator.run', relation: 'calls' }),
      expect.objectContaining({ from: 'ReportOrchestrator.run', to: 'ResearchAgent.search', relation: 'calls' }),
      expect.objectContaining({ from: 'ReportOrchestrator.run', to: 'ScoringService.score', relation: 'calls' }),
      expect.objectContaining({ from: 'ReportOrchestrator.run', to: 'ReportRepository.save', relation: 'calls' }),
    ]))
    expect(result.matched_nodes.map((node) => node.label)).not.toEqual(expect.arrayContaining([
      'IdeasController.listIdeas',
      'IdeasController.health',
    ]))
  })

  it('uses truthful anchor reasons for lexical source matches vs literal paths', () => {
    const symbolPrompt = retrieve(
      'Explain how generateFromProblem creates the validation report without using test or benchmark files.',
    )
    const pathPrompt = retrieve(
      'Explain src/ideas/ideas.controller.ts and how it creates a validation report.',
    )

    expect(symbolPrompt.slice?.anchors.some((anchor) => anchor.reason === 'path mention')).toBe(false)
    expect(pathPrompt.slice?.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'path mention' }),
      ]),
    )
  })

  it('does not emit bad-pack warnings for the recovered production pipeline slice', () => {
    const result = retrieve(
      'Explain the production runtime path for IdeasController.generateFromProblem and how it creates a validation report. Follow the controller into service/orchestrator/job/research agents/scoring/report builder/persistence. Exclude tests, benchmarks, fixtures, html reporters, and reporter utilities.',
    )
    const diagnostics = computeContextPackDiagnostics(contextPackFromRetrieveResult(result))
    const warningKinds = diagnostics.warnings.map((warning) => warning.kind)

    expect(warningKinds).not.toContain('controller_only_pipeline_pack')
    expect(warningKinds).not.toContain('missing_runtime_pipeline')
    expect(warningKinds).not.toContain('excluded_domain_selected')
    expect(warningKinds).not.toContain('polluted_source_path_selected')
  })

  it('keeps slice-v1 paths forward and suppresses shared-hub fan-in for exact method pipeline prompts', () => {
    const result = retrieveContext(buildBidirectionalHubGraph(), {
      question:
        'Explain the production runtime path for IdeaGenerationController.generateFromProblem and how it creates a validation report. Follow the controller into service/orchestrator/job/research agents/scoring/report builder/persistence.',
      budget: 4000,
      retrievalLevel: 4,
      retrievalStrategy: 'slice-v1',
    })

    expect(result.slice?.selected_paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: '.generateFromProblem()', to: '.createIdea()', relation: 'calls', direction: 'forward' }),
      expect.objectContaining({ from: '.generateFromProblem()', to: '.startPipeline()', relation: 'calls', direction: 'forward' }),
      expect.objectContaining({ from: '.startPipeline()', to: '.addJob()', relation: 'calls', direction: 'forward' }),
      expect.objectContaining({ from: '.addJob()', to: '.process()', relation: 'enqueues_job', direction: 'forward' }),
      expect.objectContaining({ from: '.process()', to: '.search()', relation: 'calls', direction: 'forward' }),
      expect.objectContaining({ from: '.process()', to: '.score()', relation: 'calls', direction: 'forward' }),
      expect.objectContaining({ from: '.process()', to: '.save()', relation: 'calls', direction: 'forward' }),
    ]))
    expect(result.matched_nodes.map((node) => node.label)).toEqual(expect.arrayContaining([
      '.process()',
      '.search()',
      '.score()',
      '.save()',
    ]))
    expect(result.execution_slice?.status).toBe('complete')
    expect(result.execution_slice?.steps.map((step) => step.label)).toEqual([
      '.generateFromProblem()',
      '.startPipeline()',
      '.addJob()',
      '.process()',
      '.save()',
    ])

    const forbiddenPaths = [
      { from: '.createIdea()', to: '.generateFromProblem()', relation: 'calls' },
      { from: '.exportIdeaToPdf()', to: 'requireIdeasUserId', relation: 'calls' },
      { from: '.publishIdea()', to: 'requireIdeasUserId', relation: 'calls' },
      { from: '.queueLetsBuild()', to: '.addJob()', relation: 'calls' },
      { from: '.callLlm()', to: '.resolve()', relation: 'calls' },
    ]
    for (const path of forbiddenPaths) {
      expect(result.slice?.selected_paths).not.toContainEqual(expect.objectContaining(path))
    }
  })
})
