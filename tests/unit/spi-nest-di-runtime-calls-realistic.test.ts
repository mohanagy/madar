import { resolve as pathResolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { KnowledgeGraph } from '../../src/contracts/graph.js'
import type {
  ExtractionData,
  ExtractionEdge,
  ExtractionNode,
} from '../../src/contracts/types.js'
import { buildFromJson } from '../../src/pipeline/build.js'
import { buildSpi } from '../../src/pipeline/spi/build.js'
import { projectSpiToExtraction } from '../../src/pipeline/spi/projector.js'
import type {
  SemanticProgramIndex,
  SpiEdge,
  SpiSymbol,
  SpiSymbolKind,
} from '../../src/pipeline/spi/types.js'
import { computeContextPackDiagnostics } from '../../src/runtime/context-pack-diagnostics.js'
import { compactRetrieveResult, contextPackFromRetrieveResult, retrieveContext } from '../../src/runtime/retrieve.js'

const FROZEN_NOW = () => new Date('2026-05-12T00:00:00.000Z')
const FIXTURE_ROOT = pathResolve(
  __dirname,
  '../fixtures/spi/nest-di-runtime-calls-realistic',
)

function normalizePathForAssertion(value: string): string {
  return value.replaceAll('\\', '/')
}

function buildFixtureSpi(): SemanticProgramIndex {
  return buildSpi({
    root: FIXTURE_ROOT,
    graphifyVersion: 'test-0.0.0',
    extractorVersion: 'spi-v1.0.0-nest-di-runtime-calls-realistic',
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

describe('SPI realistic Nest DI runtime-call fixture', () => {
  it('emits realistic DI-aware call edges from the route method into provider and worker methods', () => {
    const spi = buildFixtureSpi()
    const routeMethod = findSymbol(
      spi,
      'src/modules/ideas/interface/http/idea-generation.controller.ts',
      'IdeaGenerationController.generateFromProblem',
      'method',
    )

    expect(spi.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'src/modules/ideas/interface/http/__tests__/idea-generation.controller.spec.ts',
        'benchmark/html-reporter.ts',
        'fixtures/idea-report.fixture.ts',
      ]),
    )

    const directTargets = [
      ['src/modules/ideas/infrastructure/services/input-validation.service.ts', 'InputValidationService.validateProblem'],
      ['src/modules/ideas/core/application/ideas.service.ts', 'IdeasService.createIdea'],
      ['src/modules/ideas/infrastructure/services/title-generation.service.ts', 'TitleGenerationService.generateTitle'],
      ['src/modules/ideas/core/application/ideas.service.ts', 'IdeasService.updateTitle'],
      ['src/modules/pipeline/api/pipeline-trigger.service.ts', 'PipelineTriggerService.startPipeline'],
      ['src/modules/ideas/core/application/ideas.service.ts', 'IdeasService.claimQueuedPipelineRun'],
      ['src/modules/pipeline/api/pipeline-trigger.service.ts', 'PipelineTriggerService.cancelPipeline'],
      ['src/modules/ideas/interface/http/idea-generation.controller.ts', 'IdeaGenerationController.getStatusMessage'],
    ] as const

    for (const [filePath, qualifiedName] of directTargets) {
      const callee = findSymbol(spi, filePath, qualifiedName, 'method')
      expect(findCallsEdge(spi, routeMethod.id, callee.id)).toBeTruthy()
    }

    const startPipeline = findSymbol(
      spi,
      'src/modules/pipeline/api/pipeline-trigger.service.ts',
      'PipelineTriggerService.startPipeline',
      'method',
    )
    const process = findSymbol(
      spi,
      'src/modules/pipeline/workers/orchestrator.worker.ts',
      'OrchestratorWorker.process',
      'method',
    )
    const search = findSymbol(
      spi,
      'src/modules/research/research-agent.service.ts',
      'ResearchAgentService.search',
      'method',
    )
    const score = findSymbol(
      spi,
      'src/modules/scoring/metrics-scoring.service.ts',
      'MetricsScoringService.score',
      'method',
    )
    const save = findSymbol(
      spi,
      'src/modules/reports/report.repository.ts',
      'ReportRepository.save',
      'method',
    )

    expect(findCallsEdge(spi, startPipeline.id, process.id)).toBeTruthy()
    expect(findCallsEdge(spi, process.id, search.id)).toBeTruthy()
    expect(findCallsEdge(spi, process.id, score.id)).toBeTruthy()
    expect(findCallsEdge(spi, process.id, save.id)).toBeTruthy()
  })

  it('preserves realistic route-method outgoing calls through SPI projection and graph building', () => {
    const extraction = buildFixtureExtraction()
    const graph = buildFromJson({ ...extraction, root_path: FIXTURE_ROOT }, { directed: true })
    const routeNode = findNode(
      extraction,
      (node) =>
        node.label === '.generateFromProblem()'
        && node.framework_role === 'nest_route'
        && normalizePathForAssertion(String(node.source_file)).endsWith('/src/modules/ideas/interface/http/idea-generation.controller.ts'),
    )

    const expectedTargets = [
      '.validateProblem()',
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

  it('retrieves the realistic production runtime path while suppressing wrong-domain noise', () => {
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
        '.validateProblem()',
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
        'isolated_route_method',
        'missing_provider_call_edges',
        'missing_runtime_pipeline',
        'excluded_domain_selected',
        'polluted_source_path_selected',
      ]),
    )
  })

  it('keeps direct runtime-path nodes in the compact pack for exact method pipeline prompts', () => {
    const result = retrieveContext(buildFixtureGraph(), {
      question:
        'Explain the production runtime path for IdeaGenerationController.generateFromProblem and how it creates a validation report. Follow the controller into service/orchestrator/job/research agents/scoring/report builder/persistence. Exclude tests, benchmarks, fixtures, html reporters, and reporter utilities.',
      budget: 4000,
      retrievalLevel: 4,
      retrievalStrategy: 'slice-v1',
    })

    const compact = compactRetrieveResult(result)
    const labels = compact.matched_nodes.map((node) => node.label)
    const sourceFiles = compact.matched_nodes.map((node) => node.source_file)

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
      ]),
    )
    expect(
      sourceFiles.some((sourceFile) =>
        normalizePathForAssertion(sourceFile).includes('/__tests__/')
        || normalizePathForAssertion(sourceFile).includes('/benchmark/')
        || normalizePathForAssertion(sourceFile).includes('/fixtures/'),
      ),
    ).toBe(false)
  })
})
