import { describe, expect, it } from 'vitest'

import { createTestGraph } from '../helpers/knowledge-graph.js'
import { computeContextPackDiagnostics } from '../../src/runtime/context-pack-diagnostics.js'
import { compactRetrieveResult, contextPackFromRetrieveResult, retrieveContext } from '../../src/runtime/retrieve.js'

function buildProductionPipelineGraph() {
  return createTestGraph({
    metadata: { root_path: '/' },
    nodes: [
        ['ideas_controller', {
                label: 'IdeasController', file_type: 'code', source_file: '/src/ideas/ideas.controller.ts', source_location: 'L5', node_kind: 'class', framework: 'nestjs', framework_role: 'nest_controller', community: 0
            }],
        ['ideas_method', {
                label: 'IdeasController.generateFromProblem', file_type: 'code', source_file: '/src/ideas/ideas.controller.ts', source_location: 'L18', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_controller', community: 0
            }],
        ['ideas_method_duplicate', {
                label: 'IdeasController.generateFromProblem', file_type: 'code', source_file: '/backend/.worktrees/copy/src/ideas/ideas.controller.ts', source_location: 'L18', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_controller', community: 8
            }],
        ['ideas_list', {
                label: 'IdeasController.listIdeas', file_type: 'code', source_file: '/src/ideas/ideas.controller.ts', source_location: 'L42', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_controller', community: 0
            }],
        ['ideas_health', {
                label: 'IdeasController.health', file_type: 'code', source_file: '/src/ideas/ideas.controller.ts', source_location: 'L50', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_controller', community: 0
            }],
        ['ideas_route', {
                label: 'POST /ideas/generate', file_type: 'code', source_file: '/src/ideas/ideas.routes.ts', source_location: 'L4', node_kind: 'route', framework: 'nestjs', framework_role: 'nest_route', community: 0
            }],
        ['ideas_service', {
                label: 'IdeasService', file_type: 'code', source_file: '/src/ideas/ideas.service.ts', source_location: 'L5', node_kind: 'class', framework: 'nestjs', framework_role: 'nest_provider', community: 1
            }],
        ['ideas_service_method', {
                label: 'IdeasService.generateFromProblem', file_type: 'code', source_file: '/src/ideas/ideas.service.ts', source_location: 'L21', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_provider', community: 1
            }],
        ['report_orchestrator', {
                label: 'ReportOrchestrator.run', file_type: 'code', source_file: '/src/reporting/report-orchestrator.ts', source_location: 'L9', node_kind: 'method', framework_role: 'orchestrator', community: 2
            }],
        ['research_agent', {
                label: 'ResearchAgent.search', file_type: 'code', source_file: '/src/research/research-agent.ts', source_location: 'L11', node_kind: 'method', community: 3
            }],
        ['scoring_service', {
                label: 'ScoringService.score', file_type: 'code', source_file: '/src/scoring/scoring.service.ts', source_location: 'L12', node_kind: 'method', community: 4
            }],
        ['report_repository', {
                label: 'ReportRepository.save', file_type: 'code', source_file: '/src/persistence/report.repository.ts', source_location: 'L8', node_kind: 'method', framework_role: 'repository', community: 5
            }],
        ['runtime_config', {
                label: 'VALIDATION_PROVIDER', file_type: 'code', source_file: '/src/config/runtime.ts', source_location: 'L3', node_kind: 'function', community: 6
            }],
        ['ideas_test', {
                label: 'IdeasController.generateFromProblem.spec', file_type: 'code', source_file: '/src/__tests__/ideas.controller.spec.ts', source_location: 'L5', node_kind: 'function', community: 7
            }],
        ['html_reporter', {
                label: 'HtmlReporter.render', file_type: 'code', source_file: '/benchmarks/html-reporter.ts', source_location: 'L14', node_kind: 'method', community: 7
            }],
        ['report_fixture', {
                label: 'idea-report.fixture', file_type: 'code', source_file: '/fixtures/idea-report.fixture.ts', source_location: 'L2', node_kind: 'function', community: 7
            }]
    ],
    edges: [
        ['ideas_controller', 'ideas_method', {
                relation: 'controller_route', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.controller.ts'
            }],
        ['ideas_controller', 'ideas_list', {
                relation: 'controller_route', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.controller.ts'
            }],
        ['ideas_controller', 'ideas_health', {
                relation: 'controller_route', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.controller.ts'
            }],
        ['ideas_route', 'ideas_method', {
                relation: 'route_handler', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.routes.ts'
            }],
        ['ideas_controller', 'ideas_service', {
                relation: 'injects', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.controller.ts'
            }],
        ['ideas_method', 'ideas_service_method', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.controller.ts'
            }],
        ['ideas_service_method', 'report_orchestrator', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.service.ts'
            }],
        ['report_orchestrator', 'research_agent', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/reporting/report-orchestrator.ts'
            }],
        ['report_orchestrator', 'scoring_service', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/reporting/report-orchestrator.ts'
            }],
        ['report_orchestrator', 'report_repository', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/reporting/report-orchestrator.ts'
            }],
        ['ideas_service_method', 'runtime_config', {
                relation: 'reads_env', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.service.ts'
            }],
        ['ideas_service_method', 'ideas_test', {
                relation: 'covered_by', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.service.ts'
            }],
        ['html_reporter', 'report_fixture', {
                relation: 'uses', confidence: 'EXTRACTED', source_file: '/benchmarks/html-reporter.ts'
            }]
    ]
})
}

function retrieve(prompt: string) {
  return retrieveContext(buildProductionPipelineGraph(), {
    question: prompt,
    budget: 4000,
    retrievalStrategy: 'slice-v1',
  })
}

function buildBidirectionalHubGraph() {
  return createTestGraph({
    metadata: { root_path: '/' },
    nodes: [
        ['route', {
                label: '.generateFromProblem()', file_type: 'code', source_file: '/src/ideas/idea-generation.controller.ts', source_location: 'L20', node_kind: 'route', framework: 'nestjs', framework_role: 'nest_route', community: 0
            }],
        ['auth_helper', {
                label: 'requireIdeasUserId', file_type: 'code', source_file: '/src/ideas/ideas-authenticated-request.ts', source_location: 'L6', node_kind: 'function', community: 0
            }],
        ['create_idea', {
                label: '.createIdea()', file_type: 'code', source_file: '/src/ideas/ideas.service.ts', source_location: 'L30', node_kind: 'method', framework_role: 'nest_provider', community: 1
            }],
        ['start_pipeline', {
                label: '.startPipeline()', file_type: 'code', source_file: '/src/pipeline/pipeline-trigger.service.ts', source_location: 'L40', node_kind: 'method', framework_role: 'nest_provider', community: 1
            }],
        ['add_job', {
                label: '.addJob()', file_type: 'code', source_file: '/src/queue/queue-registry.service.ts', source_location: 'L11', node_kind: 'method', framework_role: 'queue', community: 2
            }],
        ['process', {
                label: '.process()', file_type: 'code', source_file: '/src/pipeline/orchestrator.worker.ts', source_location: 'L12', node_kind: 'method', framework_role: 'worker', community: 2
            }],
        ['search', {
                label: '.search()', file_type: 'code', source_file: '/src/research/research-agent.service.ts', source_location: 'L11', node_kind: 'method', community: 3
            }],
        ['score', {
                label: '.score()', file_type: 'code', source_file: '/src/scoring/metrics-scoring.service.ts', source_location: 'L12', node_kind: 'method', community: 3
            }],
        ['save', {
                label: '.save()', file_type: 'code', source_file: '/src/persistence/report.repository.ts', source_location: 'L8', node_kind: 'method', framework_role: 'repository', community: 3
            }],
        ['call_llm', {
                label: '.callLlm()', file_type: 'code', source_file: '/src/llm/llm-provider-resolver.service.ts', source_location: 'L14', node_kind: 'method', community: 3
            }],
        ['resolve_llm', {
                label: '.resolve()', file_type: 'code', source_file: '/src/llm/llm-provider-resolver.service.ts', source_location: 'L8', node_kind: 'method', community: 3
            }],
        ['other_controller_a', {
                label: '.exportIdeaToPdf()', file_type: 'code', source_file: '/src/ideas/export.controller.ts', source_location: 'L18', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_route', community: 4
            }],
        ['other_controller_b', {
                label: '.publishIdea()', file_type: 'code', source_file: '/src/ideas/publish.controller.ts', source_location: 'L18', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_route', community: 4
            }],
        ['other_worker', {
                label: '.queueLetsBuild()', file_type: 'code', source_file: '/src/pipeline/lets-build.worker.ts', source_location: 'L22', node_kind: 'method', community: 5
            }],
        ['plan_enforcement', {
                label: 'PlanEnforcement', file_type: 'code', source_file: '/src/guards/plan-enforcement.ts', source_location: 'L5', node_kind: 'function', community: 6
            }]
    ],
    edges: [
        ['route', 'auth_helper', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/idea-generation.controller.ts'
            }],
        ['route', 'create_idea', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/idea-generation.controller.ts'
            }],
        ['route', 'start_pipeline', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/idea-generation.controller.ts'
            }],
        ['route', 'plan_enforcement', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/idea-generation.controller.ts'
            }],
        ['start_pipeline', 'add_job', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/pipeline-trigger.service.ts'
            }],
        ['add_job', 'process', {
                relation: 'enqueues_job', confidence: 'EXTRACTED', source_file: '/src/queue/queue-registry.service.ts'
            }],
        ['process', 'search', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/orchestrator.worker.ts'
            }],
        ['process', 'score', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/orchestrator.worker.ts'
            }],
        ['process', 'save', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/orchestrator.worker.ts'
            }],
        ['call_llm', 'resolve_llm', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/llm/llm-provider-resolver.service.ts'
            }],
        ['resolve_llm', 'create_idea', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/llm/llm-provider-resolver.service.ts'
            }],
        ['auth_helper', 'route', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas-authenticated-request.ts'
            }],
        ['create_idea', 'route', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/ideas.service.ts'
            }],
        ['start_pipeline', 'route', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/pipeline-trigger.service.ts'
            }],
        ['add_job', 'start_pipeline', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/queue/queue-registry.service.ts'
            }],
        ['other_controller_a', 'auth_helper', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/export.controller.ts'
            }],
        ['other_controller_b', 'auth_helper', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/publish.controller.ts'
            }],
        ['other_worker', 'add_job', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/lets-build.worker.ts'
            }]
    ]
})
}

function buildBroadReportGenerationGraph() {
  return createTestGraph({
    metadata: { root_path: '/' },
    nodes: [
        ['route', {
                label: '.generateFromProblem()', file_type: 'code', source_file: '/src/ideas/idea-generation.controller.ts', source_location: 'L20', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_route', community: 0
            }],
        ['create_idea', {
                label: '.createIdea()', file_type: 'code', source_file: '/src/ideas/ideas.service.ts', source_location: 'L30', node_kind: 'method', framework_role: 'nest_provider', community: 0
            }],
        ['start_pipeline', {
                label: '.startPipeline()', file_type: 'code', source_file: '/src/pipeline/pipeline-trigger.service.ts', source_location: 'L40', node_kind: 'method', framework_role: 'nest_provider', community: 1
            }],
        ['add_job', {
                label: '.addJob()', file_type: 'code', source_file: '/src/pipeline/queue-registry.service.ts', source_location: 'L50', node_kind: 'method', framework_role: 'queue', community: 1
            }],
        ['title_generation', {
                label: '.generateTitle()', file_type: 'code', source_file: '/src/ideas/title-generation.service.ts', source_location: 'L60', node_kind: 'method', framework_role: 'nest_provider', community: 1
            }],
        ['status_endpoint', {
                label: '.getIdeaStatus()', file_type: 'code', source_file: '/src/ideas/idea-status.controller.ts', source_location: 'L70', node_kind: 'method', framework_role: 'nest_route', community: 1
            }],
        ['planner', {
                label: '.plan()', file_type: 'code', source_file: '/src/pipeline/planner/planner.service.ts', source_location: 'L80', node_kind: 'method', framework_role: 'worker', community: 2
            }],
        ['section_worker', {
                label: '.processSection()', file_type: 'code', source_file: '/src/pipeline/research/section-research.worker.ts', source_location: 'L90', node_kind: 'method', framework_role: 'worker', community: 2
            }],
        ['research', {
                label: '.search()', file_type: 'code', source_file: '/src/pipeline/research/research-agent.service.ts', source_location: 'L100', node_kind: 'method', framework_role: 'service', community: 2
            }],
        ['assembly', {
                label: '.assembleReport()', file_type: 'code', source_file: '/src/pipeline/assembly/assembly.service.ts', source_location: 'L110', node_kind: 'method', framework_role: 'service', community: 3
            }],
        ['scoring', {
                label: '.score()', file_type: 'code', source_file: '/src/pipeline/assembly/metrics-scoring.service.ts', source_location: 'L120', node_kind: 'method', framework_role: 'service', community: 3
            }],
        ['quality_gate', {
                label: '.validateReport()', file_type: 'code', source_file: '/src/pipeline/assembly/report-quality-gate.service.ts', source_location: 'L130', node_kind: 'method', framework_role: 'service', community: 3
            }],
        ['renderer', {
                label: '.renderFinalReport()', file_type: 'code', source_file: '/src/pipeline/assembly/deterministic-final-report.renderer.ts', source_location: 'L140', node_kind: 'method', framework_role: 'service', community: 3
            }],
        ['persist', {
                label: '.saveStructuredReport()', file_type: 'code', source_file: '/src/pipeline/persistence/db-sync.worker.ts', source_location: 'L150', node_kind: 'method', framework_role: 'repository', community: 4
            }]
    ],
    edges: [
        ['route', 'create_idea', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/idea-generation.controller.ts'
            }],
        ['route', 'start_pipeline', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/idea-generation.controller.ts'
            }],
        ['route', 'title_generation', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/idea-generation.controller.ts'
            }],
        ['start_pipeline', 'add_job', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/pipeline-trigger.service.ts'
            }],
        ['planner', 'section_worker', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/planner/planner.service.ts'
            }],
        ['section_worker', 'research', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/research/section-research.worker.ts'
            }],
        ['section_worker', 'assembly', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/research/section-research.worker.ts'
            }],
        ['assembly', 'scoring', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/assembly/assembly.service.ts'
            }],
        ['assembly', 'quality_gate', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/assembly/assembly.service.ts'
            }],
        ['assembly', 'renderer', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/assembly/assembly.service.ts'
            }],
        ['assembly', 'persist', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/assembly/assembly.service.ts'
            }],
        ['status_endpoint', 'route', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/idea-status.controller.ts'
            }]
    ]
})
}

function buildReportGenerationLeafHelperGraph() {
  return createTestGraph({
    metadata: { root_path: '/' },
    nodes: [
        ['route', {
                label: '.generateFromProblem()', file_type: 'code', source_file: '/src/ideas/idea-generation.controller.ts', source_location: 'L20', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_route', community: 0
            }],
        ['start_pipeline', {
                label: '.startPipeline()', file_type: 'code', source_file: '/src/pipeline/pipeline-trigger.service.ts', source_location: 'L40', node_kind: 'method', framework_role: 'service', community: 1
            }],
        ['planner', {
                label: '.plan()', file_type: 'code', source_file: '/src/pipeline/planner/planner.service.ts', source_location: 'L50', node_kind: 'method', framework_role: 'worker', community: 1
            }],
        ['assembly', {
                label: '.assembleReport()', file_type: 'code', source_file: '/src/pipeline/assembly/assembly.service.ts', source_location: 'L60', node_kind: 'method', framework_role: 'service', community: 2
            }],
        ['score_report', {
                label: '.scoreReport()', file_type: 'code', source_file: '/src/pipeline/assembly/metrics-scoring.service.ts', source_location: 'L70', node_kind: 'method', framework_role: 'service', community: 2
            }],
        ['generate_scoring_ledger', {
                label: '.generateScoringLedger()', file_type: 'code', source_file: '/src/pipeline/assembly/metrics-scoring.service.ts', source_location: 'L80', node_kind: 'method', framework_role: 'service', community: 2
            }],
        ['generate_sensitivity_analysis', {
                label: '.generateSensitivityAnalysis()', file_type: 'code', source_file: '/src/pipeline/assembly/metrics-scoring.service.ts', source_location: 'L90', node_kind: 'method', framework_role: 'service', community: 2
            }],
        ['persist', {
                label: '.saveStructuredReport()', file_type: 'code', source_file: '/src/pipeline/persistence/db-sync.worker.ts', source_location: 'L100', node_kind: 'method', framework_role: 'repository', community: 3
            }],
        ['title_generation', {
                label: '.generateTitle()', file_type: 'code', source_file: '/src/ideas/title-generation.service.ts', source_location: 'L110', node_kind: 'method', framework_role: 'service', community: 4
            }]
    ],
    edges: [
        ['route', 'start_pipeline', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/idea-generation.controller.ts'
            }],
        ['start_pipeline', 'planner', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/pipeline-trigger.service.ts'
            }],
        ['planner', 'assembly', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/planner/planner.service.ts'
            }],
        ['assembly', 'score_report', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/assembly/assembly.service.ts'
            }],
        ['score_report', 'generate_scoring_ledger', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/assembly/metrics-scoring.service.ts'
            }],
        ['score_report', 'generate_sensitivity_analysis', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/assembly/metrics-scoring.service.ts'
            }],
        ['assembly', 'persist', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/assembly/assembly.service.ts'
            }],
        ['route', 'title_generation', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/idea-generation.controller.ts'
            }]
    ]
})
}

function buildReverseFlowReportGenerationGraph() {
  return createTestGraph({
    metadata: { root_path: '/' },
    nodes: [
        ['route', {
                label: '.generateFromProblem()', file_type: 'code', source_file: '/src/ideas/idea-generation.controller.ts', source_location: 'L20', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_route', community: 0
            }],
        ['start_pipeline', {
                label: '.startPipeline()', file_type: 'code', source_file: '/src/pipeline/pipeline-trigger.service.ts', source_location: 'L30', node_kind: 'method', framework_role: 'service', community: 1
            }],
        ['add_job', {
                label: '.addJob()', file_type: 'code', source_file: '/src/pipeline/queue-registry.service.ts', source_location: 'L40', node_kind: 'method', framework_role: 'queue', community: 1
            }],
        ['process', {
                label: '.process()', file_type: 'code', source_file: '/src/pipeline/orchestrator.worker.ts', source_location: 'L50', node_kind: 'method', framework_role: 'worker', community: 2
            }],
        ['assemble_report', {
                label: '.assembleReport()', file_type: 'code', source_file: '/src/pipeline/assembly/assembly.service.ts', source_location: 'L60', node_kind: 'method', framework_role: 'service', community: 2
            }],
        ['score_metrics', {
                label: '.scoreMetrics()', file_type: 'code', source_file: '/src/pipeline/assembly/metrics-scoring.service.ts', source_location: 'L70', node_kind: 'method', framework_role: 'service', community: 2
            }],
        ['generate_scoring_ledger', {
                label: '.generateScoringLedger()', file_type: 'code', source_file: '/src/pipeline/assembly/metrics-scoring.service.ts', source_location: 'L80', node_kind: 'method', framework_role: 'service', community: 2
            }],
        ['persist', {
                label: '.saveStructuredReport()', file_type: 'code', source_file: '/src/pipeline/persistence/db-sync.worker.ts', source_location: 'L90', node_kind: 'method', framework_role: 'repository', community: 3
            }],
        ['status', {
                label: '.getStatusMessage()', file_type: 'code', source_file: '/src/ideas/idea-generation.controller.ts', source_location: 'L100', node_kind: 'method', framework_role: 'service', community: 4
            }],
        ['title_generation', {
                label: '.generateTitle()', file_type: 'code', source_file: '/src/ideas/title-generation.service.ts', source_location: 'L110', node_kind: 'method', framework_role: 'service', community: 4
            }]
    ],
    edges: [
        ['start_pipeline', 'route', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/pipeline-trigger.service.ts'
            }],
        ['add_job', 'start_pipeline', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/queue-registry.service.ts'
            }],
        ['process', 'add_job', {
                relation: 'enqueues_job', confidence: 'EXTRACTED', source_file: '/src/pipeline/orchestrator.worker.ts'
            }],
        ['assemble_report', 'process', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/assembly/assembly.service.ts'
            }],
        ['score_metrics', 'assemble_report', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/assembly/metrics-scoring.service.ts'
            }],
        ['generate_scoring_ledger', 'score_metrics', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/assembly/metrics-scoring.service.ts'
            }],
        ['persist', 'assemble_report', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/pipeline/persistence/db-sync.worker.ts'
            }],
        ['status', 'route', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/idea-generation.controller.ts'
            }],
        ['title_generation', 'route', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ideas/title-generation.service.ts'
            }]
    ]
})
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

  it('adds a semantic generation-core anchor for broad report-generation prompts instead of centering only the HTTP trigger', () => {
    const result = retrieveContext(buildBroadReportGenerationGraph(), {
      question: 'How idea report is being generated',
      budget: 4000,
      retrievalLevel: 4,
      retrievalStrategy: 'slice-v1',
    })

    expect(result.slice?.anchors.map((anchor) => anchor.label)).toEqual(expect.arrayContaining([
      '.generateFromProblem()',
    ]))
    expect(
      result.slice?.anchors.some((anchor) => [
        '.plan()',
        '.processSection()',
        '.search()',
        '.assembleReport()',
        '.score()',
        '.validateReport()',
        '.renderFinalReport()',
        '.saveStructuredReport()',
      ].includes(anchor.label)),
    ).toBe(true)
    expect(result.matched_nodes.map((node) => node.label)).toEqual(expect.arrayContaining([
      '.plan()',
      '.processSection()',
      '.search()',
      '.assembleReport()',
      '.score()',
      '.validateReport()',
      '.renderFinalReport()',
      '.saveStructuredReport()',
    ]))
  })

  it('prefers central report-generation nodes over leaf helper generators for broad report-generation prompts', () => {
    const result = retrieveContext(buildReportGenerationLeafHelperGraph(), {
      question: 'How idea report is being generated',
      budget: 4000,
      retrievalLevel: 4,
      retrievalStrategy: 'slice-v1',
    })

    const anchorLabels = result.slice?.anchors.map((anchor) => anchor.label) ?? []
    expect(anchorLabels).toEqual(expect.arrayContaining([
      '.generateFromProblem()',
    ]))
    expect(anchorLabels).toEqual(expect.arrayContaining([
      expect.stringMatching(/^\.plan\(\)$|^\.assembleReport\(\)$|^\.scoreReport\(\)$/),
    ]))
    expect(anchorLabels).not.toEqual(expect.arrayContaining([
      '.generateScoringLedger()',
      '.generateSensitivityAnalysis()',
      '.generateTitle()',
    ]))
  })

  it('keeps backward-selected runtime flow as structural evidence for broad report-generation prompts', () => {
    const result = retrieveContext(buildReverseFlowReportGenerationGraph(), {
      question: 'How idea report is being generated',
      budget: 4000,
      retrievalLevel: 4,
      retrievalStrategy: 'slice-v1',
    })

    expect(result.slice?.selected_paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: '.startPipeline()', to: '.generateFromProblem()', relation: 'calls' }),
      expect.objectContaining({ from: '.addJob()', to: '.startPipeline()', relation: 'calls' }),
      expect.objectContaining({ from: '.process()', to: '.addJob()', relation: 'enqueues_job' }),
      expect.objectContaining({ from: '.scoreMetrics()', to: '.assembleReport()', relation: 'calls' }),
    ]))

    const matched = result.matched_nodes.map((node) => ({ label: node.label, evidence_class: node.evidence_class }))
    expect(matched).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '.startPipeline()', evidence_class: 'structural' }),
      expect.objectContaining({ label: '.addJob()', evidence_class: 'structural' }),
      expect.objectContaining({ label: '.process()', evidence_class: 'structural' }),
      expect.objectContaining({ label: '.assembleReport()', evidence_class: 'structural' }),
      expect.objectContaining({ label: '.scoreMetrics()', evidence_class: 'structural' }),
    ]))
    expect(matched).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '.getStatusMessage()', evidence_class: 'structural' }),
      expect.objectContaining({ label: '.generateTitle()', evidence_class: 'structural' }),
    ]))
  })

  it('compacts broad report-generation packs around the execution flow instead of status/title noise', () => {
    const compact = compactRetrieveResult(retrieveContext(buildReverseFlowReportGenerationGraph(), {
      question: 'How idea report is being generated',
      budget: 4000,
      retrievalLevel: 4,
      retrievalStrategy: 'slice-v1',
    }))

    const labels = compact.matched_nodes.map((node) => node.label)
    expect(labels).toEqual(expect.arrayContaining([
      '.generateFromProblem()',
      '.startPipeline()',
      '.addJob()',
      '.process()',
      '.assembleReport()',
      '.scoreMetrics()',
    ]))
    expect(labels).not.toEqual(expect.arrayContaining([
      '.getStatusMessage()',
      '.generateTitle()',
    ]))
  })

  it('keeps low-confidence report-generation slices honest when no runtime handoff was traced', () => {
    const compact = compactRetrieveResult(retrieveContext(buildBroadReportGenerationGraph(), {
      question: 'How idea report is being generated',
      budget: 4000,
      retrievalLevel: 4,
      retrievalStrategy: 'slice-v1',
    }))

    expect(compact.execution_slice?.confidence).toBe('low')
    expect(compact.execution_slice?.confidence_reasons).toEqual(expect.arrayContaining([
      'no_runtime_handoff',
    ]))
    expect(compact.execution_slice?.status).toBe('partial')
    expect(compact.execution_slice?.phase_coverage).toEqual(expect.objectContaining({
      missing: expect.arrayContaining([
        'external_research_or_api',
        'report_builder',
        'scoring',
        'quality_gate',
        'renderer_or_synthesis',
        'persistence',
      ]),
    }))
    expect(compact.execution_slice?.phase_coverage?.observed).not.toContain('external_research_or_api')
    expect(compact.execution_slice?.phase_coverage?.observed).not.toContain('report_builder')
    expect(compact.execution_slice?.phase_coverage?.observed).not.toContain('scoring')
    expect(compact.execution_slice?.phase_coverage?.observed).not.toContain('quality_gate')
    expect(compact.execution_slice?.phase_coverage?.observed).not.toContain('renderer_or_synthesis')
    expect(compact.execution_slice?.phase_coverage?.observed).not.toContain('persistence')
    expect(compact.answer_contract).toEqual(expect.objectContaining({
      observed_phases: compact.execution_slice?.phase_coverage?.observed,
      missing_phases: compact.execution_slice?.phase_coverage?.missing,
      do_not_claim: expect.arrayContaining([
        'full_runtime_certainty_when_slice_is_partial',
      ]),
      uncertainty_notes: expect.arrayContaining([
        expect.stringMatching(/not enough evidence; missing .*persistence/),
      ]),
    }))
  })

  it('retains richer report-generation expectations without overclaiming untraced phases', () => {
    const compact = compactRetrieveResult(retrieveContext(buildBroadReportGenerationGraph(), {
      question: 'How idea report is being generated',
      budget: 4000,
      retrievalLevel: 4,
      retrievalStrategy: 'slice-v1',
    }))

    expect(compact.execution_slice?.phase_coverage).toEqual(expect.objectContaining({
      expected: [
        'planner',
        'external_research_or_api',
        'report_builder',
        'scoring',
        'quality_gate',
        'renderer_or_synthesis',
        'persistence',
      ],
      observed: expect.arrayContaining([
        'controller',
        'service',
        'queue',
      ]),
      missing: expect.arrayContaining([
        'planner',
        'external_research_or_api',
        'report_builder',
        'scoring',
        'quality_gate',
        'renderer_or_synthesis',
        'persistence',
      ]),
    }))
  })
})
