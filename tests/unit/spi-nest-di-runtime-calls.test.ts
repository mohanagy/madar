import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { relative as pathRelative, resolve as pathResolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
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
const TEST_ARTIFACTS_DIR = pathResolve(process.cwd(), '.test-artifacts', 'spi-nest-di-runtime-calls')

function normalizePathForAssertion(value: string): string {
  return value.replaceAll('\\', '/')
}

function buildFixtureSpi(): SemanticProgramIndex {
  return buildSpi({
    root: FIXTURE_ROOT,
    sadeemVersion: 'test-0.0.0',
    extractorVersion: 'spi-v1.0.0-nest-di-runtime-calls',
    now: FROZEN_NOW,
  })
}

function buildFixtureExtraction(): ExtractionData {
  return projectSpiToExtraction(buildFixtureSpi(), { root: FIXTURE_ROOT })
}

function rebaseFixturePath(sourceFile: string, rootPath: string): string {
  const relativePath = pathRelative(FIXTURE_ROOT, sourceFile).replaceAll('\\', '/')
  return `${rootPath.replace(/\/+$/u, '')}/${relativePath}`
}

function buildFixtureGraph(options: { rootPath?: string } = {}): KnowledgeGraph {
  const extraction = buildFixtureExtraction()
  if (!options.rootPath) {
    return buildFromJson({ ...extraction, root_path: FIXTURE_ROOT }, { directed: true })
  }

  return buildFromJson({
    ...extraction,
    root_path: options.rootPath,
    nodes: extraction.nodes.map((node) => ({
      ...node,
      source_file: rebaseFixturePath(node.source_file, options.rootPath!),
    })),
    edges: extraction.edges.map((edge) => ({
      ...edge,
      source_file: edge.source_file ? rebaseFixturePath(edge.source_file, options.rootPath!) : undefined,
    })),
  }, { directed: true })
}

function buildLegacyQueueBridgeGraph(): KnowledgeGraph {
  const scratchDir = pathResolve(TEST_ARTIFACTS_DIR, 'legacy-queue-bridge')
  mkdirSync(scratchDir, { recursive: true })
  const fixturePath = pathResolve(scratchDir, 'pipeline.ts')
  writeFileSync(fixturePath, [
    "import { Controller, Injectable, Post } from '@nestjs/common'",
    '',
    'function Processor(_queueName: string): ClassDecorator {',
    '  return () => undefined',
    '}',
    '',
    'function Process(_jobName: string): MethodDecorator {',
    '  return () => undefined',
    '}',
    '',
    'type PipelineJobPayload = {',
    '  problem: string',
    '  ideaId: string',
    '}',
    '',
    'class PipelineQueue {',
    '  async add(jobName: string, input: PipelineJobPayload) {',
    '    return {',
    '      id: `${input.ideaId}:${jobName}`,',
    '      data: input,',
    '    }',
    '  }',
    '}',
    '',
    '@Injectable()',
    'class QueueRegistryService {',
    '  private readonly pipelineQueue = new PipelineQueue()',
    '',
    '  async addJob(input: PipelineJobPayload) {',
    "    return this.pipelineQueue.add('legacy.pipeline.bridge.process', input)",
    '  }',
    '}',
    '',
    '@Injectable()',
    'class ResearchAgentService {',
    '  async search(problem: string) {',
    '    return `research:${problem}`',
    '  }',
    '}',
    '',
    '@Injectable()',
    'class MetricsScoringService {',
    '  async score(research: string) {',
    '    return `score:${research}`',
    '  }',
    '}',
    '',
    '@Injectable()',
    'class ReportRepository {',
    '  async save(ideaId: string, score: string) {',
    '    return { ideaId, score }',
    '  }',
    '}',
    '',
    "@Processor('legacy.pipeline.bridge')",
    'class OrchestratorWorker {',
    '  constructor(',
    '    private readonly researchAgent: ResearchAgentService,',
    '    private readonly scoringService: MetricsScoringService,',
    '    private readonly reportRepository: ReportRepository,',
    '  ) {}',
    '',
    "  @Process('legacy.pipeline.bridge.process')",
    '  async process(job: { data: PipelineJobPayload }) {',
    '    const research = await this.researchAgent.search(job.data.problem)',
    '    const score = await this.scoringService.score(research)',
    '    return this.reportRepository.save(job.data.ideaId, score)',
    '  }',
    '}',
    '',
    '@Injectable()',
    'class PipelineTriggerService {',
    '  constructor(private readonly queueRegistryService: QueueRegistryService) {}',
    '',
    '  async startPipeline(problem: string, ideaId: string) {',
    '    return this.queueRegistryService.addJob({ problem, ideaId })',
    '  }',
    '}',
    '',
    '@Injectable()',
    'class IdeasService {',
    '  async createIdea(problem: string) {',
    '    return { id: problem }',
    '  }',
    '}',
    '',
    "@Controller('ideas')",
    'class IdeaGenerationController {',
    '  constructor(',
    '    private readonly ideasService: IdeasService,',
    '    private readonly pipelineTriggerService: PipelineTriggerService,',
    '  ) {}',
    '',
    "  @Post('generate')",
    '  async generateFromProblem(problem: string, ideaId: string) {',
    '    await this.ideasService.createIdea(problem)',
    '    return this.pipelineTriggerService.startPipeline(problem, ideaId)',
    '  }',
    '}',
  ].join('\n'))

  const extraction = extractJs(fixturePath)
  return buildFromJson({ ...extraction, root_path: scratchDir }, { directed: true })
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
    try {
      const graph = buildLegacyQueueBridgeGraph()
      const result = retrieveContext(graph, {
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
      expect(result.slice?.selected_paths).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ from: '.startPipeline()', to: '.process()', relation: 'calls', direction: 'forward' }),
      ]))
      expect(result.matched_nodes.map((node) => node.label)).toEqual(expect.arrayContaining([
        '.addJob()',
        '.process()',
        '.search()',
        '.score()',
        '.save()',
      ]))
    } finally {
      rmSync(TEST_ARTIFACTS_DIR, { recursive: true, force: true })
    }
  })

  it('does not suppress runtime flow when parent directories contain migration in the name', () => {
    const result = retrieveContext(buildFixtureGraph({
      rootPath: '/tmp/issue-245-sadeem-rebrand-migration',
    }), {
      question:
        'Explain the production runtime path for IdeaGenerationController.generateFromProblem and how it creates a validation report. Follow the controller into service/orchestrator/job/research agents/scoring/report builder/persistence.',
      budget: 4000,
      retrievalLevel: 4,
      retrievalStrategy: 'slice-v1',
    })

    expect(result.slice?.selected_paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: '.generateFromProblem()', to: '.startPipeline()', relation: 'calls', direction: 'forward' }),
      expect.objectContaining({ from: '.startPipeline()', to: '.process()', relation: 'calls', direction: 'forward' }),
      expect.objectContaining({ from: '.process()', to: '.save()', relation: 'calls', direction: 'forward' }),
    ]))
    expect(result.matched_nodes.map((node) => node.label)).toEqual(expect.arrayContaining([
      '.startPipeline()',
      '.process()',
      '.save()',
    ]))
  })
})
