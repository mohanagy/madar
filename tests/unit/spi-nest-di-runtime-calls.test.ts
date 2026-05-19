import { resolve as pathResolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildFromJson } from '../../src/pipeline/build.js'
import { buildSpi } from '../../src/pipeline/spi/build.js'
import { projectSpiToExtraction } from '../../src/pipeline/spi/projector.js'
import type {
  ExtractionData,
  ExtractionEdge,
  ExtractionNode,
} from '../../src/contracts/types.js'
import { computeContextPackDiagnostics } from '../../src/runtime/context-pack-diagnostics.js'
import { contextPackFromRetrieveResult, retrieveContext } from '../../src/runtime/retrieve.js'
import type { KnowledgeGraph } from '../../src/contracts/graph.js'
import type {
  SemanticProgramIndex,
  SpiEdge,
  SpiSymbol,
  SpiSymbolKind,
} from '../../src/pipeline/spi/types.js'

const FROZEN_NOW = () => new Date('2026-05-12T00:00:00.000Z')
const FIXTURE_ROOT = pathResolve(
  __dirname,
  '../fixtures/spi/nest-di-runtime-calls',
)

function normalizePathForAssertion(value: string): string {
  return value.replaceAll('\\', '/')
}

function buildFixtureSpi(): SemanticProgramIndex {
  return buildSpi({
    root: FIXTURE_ROOT,
    graphifyVersion: 'test-0.0.0',
    extractorVersion: 'spi-v1.0.0-nest-di-runtime-calls',
    now: FROZEN_NOW,
  })
}

function buildFixtureExtraction(): ExtractionData {
  return projectSpiToExtraction(buildFixtureSpi(), { root: FIXTURE_ROOT })
}

function buildFixtureGraph(): KnowledgeGraph {
  const extraction = buildFixtureExtraction()
  return buildFromJson({ ...extraction, root_path: FIXTURE_ROOT }, { directed: true })
}

function buildLegacyQueueBridgeGraph(): KnowledgeGraph {
  return buildFromJson({
    root_path: FIXTURE_ROOT,
    nodes: [
      { id: 'route', label: '.generateFromProblem()', file_type: 'code', source_file: pathResolve(FIXTURE_ROOT, 'src/idea-generation.controller.ts'), source_location: 'L20', node_kind: 'route', framework: 'nestjs', framework_role: 'nest_route', community: 0 },
      { id: 'create_idea', label: '.createIdea()', file_type: 'code', source_file: pathResolve(FIXTURE_ROOT, 'src/ideas.service.ts'), source_location: 'L30', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_provider', community: 1 },
      { id: 'start_pipeline', label: '.startPipeline()', file_type: 'code', source_file: pathResolve(FIXTURE_ROOT, 'src/pipeline-trigger.service.ts'), source_location: 'L40', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_provider', community: 1 },
      { id: 'add_job', label: '.addJob()', file_type: 'code', source_file: pathResolve(FIXTURE_ROOT, 'src/queue-registry.service.ts'), source_location: 'L11', node_kind: 'method', framework_role: 'queue', community: 2 },
      { id: 'process', label: '.process()', file_type: 'code', source_file: pathResolve(FIXTURE_ROOT, 'src/orchestrator.worker.ts'), source_location: 'L12', node_kind: 'method', framework_role: 'worker', community: 3 },
      { id: 'search', label: '.search()', file_type: 'code', source_file: pathResolve(FIXTURE_ROOT, 'src/research-agent.service.ts'), source_location: 'L11', node_kind: 'method', community: 4 },
      { id: 'score', label: '.score()', file_type: 'code', source_file: pathResolve(FIXTURE_ROOT, 'src/metrics-scoring.service.ts'), source_location: 'L12', node_kind: 'method', community: 5 },
      { id: 'save', label: '.save()', file_type: 'code', source_file: pathResolve(FIXTURE_ROOT, 'src/report.repository.ts'), source_location: 'L8', node_kind: 'method', framework_role: 'repository', community: 6 },
    ],
    edges: [
      { source: 'route', target: 'create_idea', relation: 'calls', confidence: 'EXTRACTED', source_file: pathResolve(FIXTURE_ROOT, 'src/idea-generation.controller.ts') },
      { source: 'route', target: 'start_pipeline', relation: 'calls', confidence: 'EXTRACTED', source_file: pathResolve(FIXTURE_ROOT, 'src/idea-generation.controller.ts') },
      { source: 'start_pipeline', target: 'add_job', relation: 'calls', confidence: 'EXTRACTED', source_file: pathResolve(FIXTURE_ROOT, 'src/pipeline-trigger.service.ts') },
      { source: 'add_job', target: 'process', relation: 'enqueues_job', confidence: 'EXTRACTED', source_file: pathResolve(FIXTURE_ROOT, 'src/queue-registry.service.ts') },
      { source: 'process', target: 'search', relation: 'calls', confidence: 'EXTRACTED', source_file: pathResolve(FIXTURE_ROOT, 'src/orchestrator.worker.ts') },
      { source: 'process', target: 'score', relation: 'calls', confidence: 'EXTRACTED', source_file: pathResolve(FIXTURE_ROOT, 'src/orchestrator.worker.ts') },
      { source: 'process', target: 'save', relation: 'calls', confidence: 'EXTRACTED', source_file: pathResolve(FIXTURE_ROOT, 'src/orchestrator.worker.ts') },
    ],
  }, { directed: true })
}

function findSymbol(
  spi: SemanticProgramIndex,
  filePath: string,
  name: string,
  kind: SpiSymbolKind,
): SpiSymbol {
  const file = spi.files.find((entry) => entry.path === filePath)
  if (!file) {
    throw new Error(`fixture missing SpiFile: ${filePath}`)
  }

  const symbol = spi.symbols.find(
    (entry) => entry.file_id === file.id && entry.kind === kind && entry.name === name,
  )
  if (!symbol) {
    throw new Error(`fixture missing ${kind} ${name} in ${filePath}`)
  }

  return symbol
}

function findCallsEdge(
  spi: SemanticProgramIndex,
  fromId: string,
  toId: string,
): SpiEdge | undefined {
  return spi.edges.find(
    (edge) => edge.kind === 'calls' && edge.from === fromId && edge.to === toId,
  )
}

function findNode(
  extraction: ExtractionData,
  predicate: (node: ExtractionNode) => boolean,
): ExtractionNode {
  const node = extraction.nodes.find(predicate)
  if (!node) {
    throw new Error('expected extraction node not found')
  }
  return node
}

function outgoingCallLabels(
  extraction: ExtractionData,
  sourceId: string,
): string[] {
  const labelsById = new Map(extraction.nodes.map((node) => [node.id, node.label]))
  return extraction.edges
    .filter(
      (edge): edge is ExtractionEdge =>
        edge.source === sourceId && edge.relation === 'calls',
    )
    .map((edge) => labelsById.get(edge.target))
    .filter((label): label is string => typeof label === 'string')
}

function graphOutgoingCallLabels(graph: KnowledgeGraph, sourceId: string): string[] {
  return graph.successors(sourceId)
    .filter(
      (targetId) => String(graph.edgeAttributes(sourceId, targetId).relation ?? '') === 'calls',
    )
    .map((targetId) => String(graph.nodeAttributes(targetId).label ?? targetId))
}

describe('SPI Nest DI runtime-call fixture', () => {
  it('emits DI-aware call edges from the route method into provider and worker methods', () => {
    const spi = buildFixtureSpi()
    const routeMethod = findSymbol(
      spi,
      'src/idea-generation.controller.ts',
      'IdeaGenerationController.generateFromProblem',
      'method',
    )

    expect(spi.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'src/__tests__/idea-generation.controller.spec.ts',
        'benchmark/html-reporter.ts',
        'fixtures/idea-report.fixture.ts',
      ]),
    )

    const directTargets = [
      ['src/ideas.service.ts', 'IdeasService.createIdea'],
      ['src/title-generation.service.ts', 'TitleGenerationService.generateTitle'],
      ['src/ideas.service.ts', 'IdeasService.updateTitle'],
      ['src/pipeline-trigger.service.ts', 'PipelineTriggerService.startPipeline'],
      ['src/ideas.service.ts', 'IdeasService.claimQueuedPipelineRun'],
      ['src/pipeline-trigger.service.ts', 'PipelineTriggerService.cancelPipeline'],
      ['src/idea-generation.controller.ts', 'IdeaGenerationController.getStatusMessage'],
    ] as const

    for (const [filePath, qualifiedName] of directTargets) {
      const callee = findSymbol(spi, filePath, qualifiedName, 'method')
      expect(findCallsEdge(spi, routeMethod.id, callee.id)).toBeTruthy()
    }

    const startPipeline = findSymbol(
      spi,
      'src/pipeline-trigger.service.ts',
      'PipelineTriggerService.startPipeline',
      'method',
    )
    const process = findSymbol(
      spi,
      'src/orchestrator.worker.ts',
      'OrchestratorWorker.process',
      'method',
    )
    const search = findSymbol(
      spi,
      'src/research-agent.service.ts',
      'ResearchAgentService.search',
      'method',
    )
    const score = findSymbol(
      spi,
      'src/metrics-scoring.service.ts',
      'MetricsScoringService.score',
      'method',
    )
    const save = findSymbol(
      spi,
      'src/report.repository.ts',
      'ReportRepository.save',
      'method',
    )

    expect(findCallsEdge(spi, startPipeline.id, process.id)).toBeTruthy()
    expect(findCallsEdge(spi, process.id, search.id)).toBeTruthy()
    expect(findCallsEdge(spi, process.id, score.id)).toBeTruthy()
    expect(findCallsEdge(spi, process.id, save.id)).toBeTruthy()
  })

  it('preserves the route method outgoing calls through SPI projection and graph building', () => {
    const extraction = buildFixtureExtraction()
    const graph = buildFromJson({ ...extraction, root_path: FIXTURE_ROOT }, { directed: true })
    const routeNode = findNode(
      extraction,
      (node) =>
        node.label === '.generateFromProblem()'
        && node.framework_role === 'nest_route'
        && normalizePathForAssertion(String(node.source_file)).endsWith('/src/idea-generation.controller.ts'),
    )

    const expectedTargets = [
      '.createIdea()',
      '.generateTitle()',
      '.updateTitle()',
      '.startPipeline()',
      '.claimQueuedPipelineRun()',
      '.cancelPipeline()',
      '.getStatusMessage()',
    ]

    expect(outgoingCallLabels(extraction, routeNode.id)).toEqual(
      expect.arrayContaining(expectedTargets),
    )
    expect(graphOutgoingCallLabels(graph, routeNode.id)).toEqual(
      expect.arrayContaining(expectedTargets),
    )
  })

  it('retrieves the production runtime path from the real fixture while suppressing wrong-domain noise', () => {
    const result = retrieveContext(buildFixtureGraph(), {
      question:
        'Explain the production runtime path for IdeaGenerationController.generateFromProblem and how it creates a validation report. Follow the controller into service/orchestrator/job/research agents/scoring/report builder/persistence. Exclude tests, benchmarks, fixtures, html reporters, and reporter utilities.',
      budget: 4000,
      retrievalLevel: 4,
      retrievalStrategy: 'slice-v1',
    })

    const labels = result.matched_nodes.map((node) => node.label)
    const sourceFiles = result.matched_nodes.map((node) => node.source_file)
    const diagnostics = computeContextPackDiagnostics(
      contextPackFromRetrieveResult(result),
    )

    expect(result.retrieval_gate?.intent).toBe('explain')
    expect(result.slice?.anchors[0]).toEqual(
      expect.objectContaining({
        label: '.generateFromProblem()',
        reason: 'symbol mention',
      }),
    )
    expect(labels).toEqual(
      expect.arrayContaining([
        '.generateFromProblem()',
        '.createIdea()',
        '.generateTitle()',
        '.updateTitle()',
        '.startPipeline()',
        '.claimQueuedPipelineRun()',
        '.cancelPipeline()',
        '.process()',
        '.search()',
        '.score()',
        '.save()',
      ]),
    )
    expect(
      sourceFiles.some((sourceFile) =>
        normalizePathForAssertion(sourceFile).includes('/__tests__/')
        || normalizePathForAssertion(sourceFile).includes('/benchmark/')
        || normalizePathForAssertion(sourceFile).includes('/fixtures/'),
      ),
    ).toBe(false)
    expect(diagnostics.warnings.map((warning) => warning.kind)).not.toEqual(
      expect.arrayContaining([
        'controller_only_pipeline_pack',
        'missing_runtime_pipeline',
        'isolated_route_method',
        'missing_provider_call_edges',
      ]),
    )
  })

  it('preserves queue-to-worker linkage when the runtime path crosses an enqueue boundary', () => {
    const result = retrieveContext(buildLegacyQueueBridgeGraph(), {
      question:
        'Explain the production runtime path for IdeaGenerationController.generateFromProblem and how it creates a validation report. Follow the controller into service/orchestrator/job/research agents/scoring/report builder/persistence.',
      budget: 4000,
      retrievalLevel: 4,
      retrievalStrategy: 'slice-v1',
    })

    expect(result.slice?.selected_paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: '.generateFromProblem()', to: '.startPipeline()', relation: 'calls', direction: 'forward' }),
      expect.objectContaining({ from: '.startPipeline()', to: '.addJob()', relation: 'calls', direction: 'forward' }),
      expect.objectContaining({ from: '.addJob()', to: '.process()', relation: 'enqueues_job', direction: 'forward' }),
      expect.objectContaining({ from: '.process()', to: '.search()', relation: 'calls', direction: 'forward' }),
      expect.objectContaining({ from: '.process()', to: '.score()', relation: 'calls', direction: 'forward' }),
      expect.objectContaining({ from: '.process()', to: '.save()', relation: 'calls', direction: 'forward' }),
    ]))
    expect(result.matched_nodes.map((node) => node.label)).toEqual(expect.arrayContaining([
      '.addJob()',
      '.process()',
      '.search()',
      '.score()',
      '.save()',
    ]))
  })
})
