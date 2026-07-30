import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadGraphArtifact } from '../../src/adapters/filesystem/graph-artifact.js'
import { generateIndex } from '../../src/application/generate-index.js'
import { retrieveContext } from '../../src/application/retrieve-context.js'
import {
  attachBuildState,
  readBuildState,
} from '../../src/domain/index/build-state.js'
import {
  inspectQueryIndex,
  type ReadyQueryIndex,
} from '../../src/domain/query/index-status.js'
import { sliceEvidence } from '../../src/domain/query/slice.js'
import type {
  EvidenceNode,
  EvidenceRelationship,
  RetrieveContextResult,
} from '../../src/domain/query/types.js'

interface StageContract {
  id: string
  label: string
  source_suffix?: string
}

interface RelationshipContract {
  from: string
  relation: string
  to: string
}

interface HandoffContract {
  from: string
  to: string
}

interface Issue625Fixture {
  queries: {
    beta_3_broad: string
    focused_recovery: string
    punctuation_variants: string[]
    clause_order_variants: string[]
    distant_paraphrases: string[]
    field_incident_variants: string[]
  }
  stages: StageContract[]
  causal_relationships: RelationshipContract[]
  disconnected_handoffs: HandoffContract[]
  focused_required_stages: string[]
  focused_required_relationships: RelationshipContract[]
  distractor_source_prefixes: string[]
}

const baseFixtureDirectory = fileURLToPath(new URL(
  '../fixtures/pack-quality/runtime-generation-explain-report-flow/',
  import.meta.url,
))
const regressionFixtureDirectory = fileURLToPath(new URL(
  '../fixtures/issue-625-evidence-skeleton/',
  import.meta.url,
))
const contract = JSON.parse(
  readFileSync(join(regressionFixtureDirectory, 'fixture.json'), 'utf8'),
) as Issue625Fixture

let root = ''
let index: ReadyQueryIndex
let overlayIndex: ReadyQueryIndex
let renamedIndex: ReadyQueryIndex
let falseReadyIndex: ReadyQueryIndex

const renamedStages: StageContract[] = [
  { id: 'submission', label: '.executeAlpha()', source_suffix: '/phase-alpha.ts' },
  { id: 'kickoff', label: 'executeBravo()', source_suffix: '/phase-bravo.ts' },
  { id: 'dispatch', label: 'executeCharlie()', source_suffix: '/channel-charlie.ts' },
  { id: 'orchestration', label: '.executeStage()', source_suffix: '/phase-delta.ts' },
  { id: 'planning', label: '.executeEcho()', source_suffix: '/phase-echo.ts' },
  { id: 'section_worker', label: '.executeStage()', source_suffix: '/phase-foxtrot.ts' },
  { id: 'research', label: '.executeGolf()', source_suffix: '/phase-golf.ts' },
  { id: 'assembly_worker', label: '.executeStage()', source_suffix: '/phase-hotel.ts' },
  { id: 'assembly', label: '.executeIndia()', source_suffix: '/phase-india.ts' },
  { id: 'persistence', label: '.executeStage()', source_suffix: '/phase-juliet.ts' },
]

function evidenceNode(id: string, sourceFile = `src/${id}.ts`): EvidenceNode {
  return {
    node_id: id,
    evidence_kind: 'symbol_declaration',
    label: `${id}()`,
    node_kind: 'function',
    source_file: sourceFile,
    source_location: 'L1',
    line_number: 1,
    end_line_number: 1,
    definition_range: {
      start: { line: 1, column: 1 },
      end: { line: 1, column: 24 },
    },
    declaration_range: {
      start: { line: 1, column: 1 },
      end: { line: 1, column: 24 },
    },
    source_domain: 'production',
    provenance: [{}],
    content_hash: 'a'.repeat(64),
    snippet: `export function ${id}() {}`,
  }
}

function selectedStageNodesFor(
  result: RetrieveContextResult,
  expectedStages: readonly StageContract[],
): Map<string, EvidenceNode> {
  const selected = new Map<string, EvidenceNode>()
  for (const stage of expectedStages) {
    const match = result.matched_nodes.find((node) =>
      node.label === stage.label
      && (!stage.source_suffix || node.source_file.endsWith(stage.source_suffix)))
    if (match) selected.set(stage.id, match)
  }
  return selected
}

function selectedStageNodes(result: RetrieveContextResult): Map<string, EvidenceNode> {
  return selectedStageNodesFor(result, contract.stages)
}

function relationshipIdentity(
  edge: EvidenceRelationship,
): string {
  return `${edge.from_id}\u0000${edge.relation}\u0000${edge.to_id}`
}

function assertProtocolLimits(result: RetrieveContextResult): void {
  expect(result.outcome).toBe('evidence')
  expect(result.metrics.selected_files).toBeLessThanOrEqual(12)
  expect(result.metrics.snippets).toBeLessThanOrEqual(25)
  expect(result.metrics.serialized_tokens).toBeLessThanOrEqual(4_000)
  expect(result.metrics.closure_passes).toBeLessThanOrEqual(1)
}

function assertNoDistractors(result: RetrieveContextResult): void {
  for (const prefix of contract.distractor_source_prefixes) {
    expect(
      result.matched_nodes.some((node) => node.source_file.startsWith(prefix)),
      `selected high-degree non-causal distractor ${prefix}`,
    ).toBe(false)
  }
}

function assertSemanticRelationships(
  result: RetrieveContextResult,
  stages: ReadonlyMap<string, EvidenceNode>,
  expected: readonly RelationshipContract[],
): void {
  const selectedRelationships = new Set(result.relationships.map(relationshipIdentity))
  for (const relationship of expected) {
    const from = stages.get(relationship.from)
    const to = stages.get(relationship.to)
    expect(from, `missing semantic stage ${relationship.from}`).toBeDefined()
    expect(to, `missing semantic stage ${relationship.to}`).toBeDefined()
    expect(
      selectedRelationships.has(
        `${from!.node_id}\u0000${relationship.relation}\u0000${to!.node_id}`,
      ),
      `missing ${relationship.from} --${relationship.relation}--> ${relationship.to}`,
    ).toBe(true)
    expect(
      selectedRelationships.has(
        `${to!.node_id}\u0000${relationship.relation}\u0000${from!.node_id}`,
      ),
      `reversed ${relationship.to} --${relationship.relation}--> ${relationship.from}`,
    ).toBe(false)
  }
}

function assertDisconnectedHandoffs(
  result: RetrieveContextResult,
  stages: ReadonlyMap<string, EvidenceNode>,
  expected: readonly HandoffContract[] = contract.disconnected_handoffs,
): void {
  const boundaries = new Set(
    result.boundaries
      .filter((candidate) => candidate.kind === 'disconnected')
      .map((candidate) => candidate.subject),
  )
  for (const handoff of expected) {
    const from = stages.get(handoff.from)
    const to = stages.get(handoff.to)
    expect(from, `missing semantic stage ${handoff.from}`).toBeDefined()
    expect(to, `missing semantic stage ${handoff.to}`).toBeDefined()
    expect(
      boundaries.has(`${from!.node_id} -> ${to!.node_id}`),
      `missing verification boundary ${handoff.from} -> ${handoff.to}`,
    ).toBe(true)
  }
}

function assertBroadEvidenceSkeleton(result: RetrieveContextResult): void {
  assertProtocolLimits(result)

  const stages = selectedStageNodes(result)
  expect(
    [...stages.keys()].sort(),
    'broad retrieval must cover every semantic runtime stage',
  ).toEqual(contract.stages.map((stage) => stage.id).sort())
  assertSemanticRelationships(result, stages, contract.causal_relationships)
  assertDisconnectedHandoffs(result, stages)
  assertNoDistractors(result)
  const requiredFiles = new Set([...stages.values()].map((node) => node.source_file))
  const selectedFiles = new Set(result.matched_nodes.map((node) => node.source_file))
  expect(requiredFiles.size / selectedFiles.size).toBeGreaterThanOrEqual(0.7)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'madar-issue-625-evidence-skeleton-'))
  const workspace = join(root, 'workspace')
  mkdirSync(dirname(workspace), { recursive: true })
  cpSync(join(baseFixtureDirectory, 'workspace'), workspace, { recursive: true })
  cpSync(join(regressionFixtureDirectory, 'workspace'), workspace, { recursive: true })
  const generated = generateIndex(workspace)
  const inspected = inspectQueryIndex(loadGraphArtifact(generated.graphPath))
  if (inspected.state !== 'ready') {
    throw new Error(`Expected ready query index, received ${inspected.state}`)
  }
  index = inspected

  const overlayGraph = loadGraphArtifact(generated.graphPath)
  const overlayBuild = readBuildState(overlayGraph)
  if (!overlayBuild) throw new Error('Expected overlay source build state')
  const moduleEntry = overlayGraph.nodeEntries().find(([, attributes]) =>
    attributes.source_file
      === 'src/modules/pipeline/assembly/pipeline-assembly-catalog.module.ts'
    && attributes.node_kind === 'class')
  const methodEntry = overlayGraph.nodeEntries().find(([, attributes]) =>
    attributes.source_file
      === 'src/modules/pipeline/assembly/pipeline-assembly-catalog.module.ts'
    && attributes.node_kind !== 'class'
    && attributes.node_kind !== 'file')
  if (!moduleEntry || !methodEntry) {
    throw new Error('Expected deterministic module distractor nodes')
  }
  for (let ordinal = 0; ordinal < 10_001; ordinal += 1) {
    const nodeId = `issue-625-overlay-${ordinal.toString().padStart(5, '0')}`
    overlayGraph.addNode(nodeId, {
      ...methodEntry[1],
      label: `ideaReportPipelineAssemblyPersistenceOverlay${ordinal}()`,
      qualified_name:
        `PipelineAssemblyCatalogModule.ideaReportPipelineAssemblyPersistenceOverlay${ordinal}`,
    })
    overlayGraph.addEdge(moduleEntry[0], nodeId, {
      relation: 'module_provides',
      source_file: methodEntry[1].source_file,
      source_location: methodEntry[1].source_location,
      provenance: methodEntry[1].provenance,
    })
  }
  const { build_id: _previousBuildId, ...overlayBuildWithoutId } = overlayBuild
  attachBuildState(overlayGraph, overlayBuildWithoutId)
  const inspectedOverlay = inspectQueryIndex(overlayGraph)
  if (inspectedOverlay.state !== 'ready') {
    throw new Error(`Expected ready overlay query index, received ${inspectedOverlay.state}`)
  }
  overlayIndex = inspectedOverlay

  const renamedWorkspace = join(root, 'renamed-workspace')
  cpSync(join(baseFixtureDirectory, 'workspace'), renamedWorkspace, { recursive: true })
  const replacements = [
    ['idea-generation.controller', 'phase-alpha'],
    ['pipeline-trigger.service', 'phase-bravo'],
    ['queue-registry.service', 'channel-charlie'],
    ['orchestrator.worker', 'phase-delta'],
    ['planner.service', 'phase-echo'],
    ['section-research.worker', 'phase-foxtrot'],
    ['research-agent.service', 'phase-golf'],
    ['assembly.worker', 'phase-hotel'],
    ['assembly.service', 'phase-india'],
    ['db-sync.worker', 'phase-juliet'],
    ['IdeaGenerationController', 'PhaseAlpha'],
    ['generateFromProblem', 'executeAlpha'],
    ['startPipeline', 'executeBravo'],
    ['enqueueJob', 'executeCharlie'],
    ['OrchestratorWorker', 'PhaseDelta'],
    ['PlannerService', 'PhaseEcho'],
    ['SectionResearchWorker', 'PhaseFoxtrot'],
    ['ResearchAgentService', 'PhaseGolf'],
    ['researchSection', 'executeGolf'],
    ['AssemblyWorker', 'PhaseHotel'],
    ['AssemblyService', 'PhaseIndia'],
    ['assembleReport', 'executeIndia'],
    ['DbSyncWorker', 'PhaseJuliet'],
  ] as const
  const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? sourceFiles(path) : [path]
    })
  for (const path of sourceFiles(renamedWorkspace).filter((candidate) =>
    /\.[cm]?[jt]sx?$/u.test(candidate))) {
    let source = readFileSync(path, 'utf8')
    for (const [from, to] of replacements) source = source.replaceAll(from, to)
    source = source.replace(/\bplan\b/gu, 'executeEcho')
      .replace(/\bprocess\b/gu, 'executeStage')
    writeFileSync(path, source, 'utf8')
  }
  const renamedPaths = [
    ['src/modules/ideas/interface/http/idea-generation.controller.ts', 'phase-alpha.ts'],
    ['src/modules/pipeline/api/pipeline-trigger.service.ts', 'phase-bravo.ts'],
    ['src/modules/pipeline/api/queue-registry.service.ts', 'channel-charlie.ts'],
    ['src/modules/pipeline/workers/orchestrator.worker.ts', 'phase-delta.ts'],
    ['src/modules/planning/planner.service.ts', 'phase-echo.ts'],
    ['src/modules/research/workers/section-research.worker.ts', 'phase-foxtrot.ts'],
    ['src/modules/research/research-agent.service.ts', 'phase-golf.ts'],
    ['src/modules/pipeline/assembly/assembly.worker.ts', 'phase-hotel.ts'],
    ['src/modules/reports/assembly.service.ts', 'phase-india.ts'],
    ['src/modules/pipeline/workers/db-sync.worker.ts', 'phase-juliet.ts'],
  ] as const
  for (const [from, to] of renamedPaths) {
    renameSync(join(renamedWorkspace, from), join(dirname(join(renamedWorkspace, from)), to))
  }
  const renamed = generateIndex(renamedWorkspace)
  const inspectedRenamed = inspectQueryIndex(loadGraphArtifact(renamed.graphPath))
  if (inspectedRenamed.state !== 'ready') {
    throw new Error(`Expected ready renamed query index, received ${inspectedRenamed.state}`)
  }
  renamedIndex = inspectedRenamed

  const falseReadyWorkspace = join(root, 'false-ready-workspace')
  const falseReadySources = {
    'src/ui/idea-report-pipeline-view.ts': [
      'export function renderIdeaReportPipelineStagesAssembly(',
      '  value: string,',
      '): string {',
      "  return `view:${value}`",
      '}',
      '',
    ].join('\n'),
    'src/config/report-persistence-catalog.module.ts': [
      'export class ReportPersistenceCatalogModule {',
      '  reportPersistenceStatus(): string {',
      "    return 'configured'",
      '  }',
      '}',
      '',
    ].join('\n'),
  }
  for (const [path, source] of Object.entries(falseReadySources)) {
    const absolute = join(falseReadyWorkspace, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, source, 'utf8')
  }
  const falseReady = generateIndex(falseReadyWorkspace)
  const inspectedFalseReady = inspectQueryIndex(loadGraphArtifact(falseReady.graphPath))
  if (inspectedFalseReady.state !== 'ready') {
    throw new Error(`Expected ready false-ready query index, received ${inspectedFalseReady.state}`)
  }
  falseReadyIndex = inspectedFalseReady
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('issue #625 generic evidence-skeleton retrieval', () => {
  it('recovers the complete semantic skeleton for the exact beta.3 broad query', () => {
    const result = retrieveContext(index, {
      question: contract.queries.beta_3_broad,
      budget: 4_000,
    })

    assertBroadEvidenceSkeleton(result)
  })

  it('recovers the creation-to-planning handoff for the exact focused recovery query', () => {
    const result = retrieveContext(index, {
      question: contract.queries.focused_recovery,
      budget: 4_000,
    })
    assertProtocolLimits(result)

    const stages = selectedStageNodes(result)
    expect([...stages.keys()]).toEqual(expect.arrayContaining(
      contract.focused_required_stages,
    ))
    assertSemanticRelationships(
      result,
      stages,
      contract.focused_required_relationships,
    )
    assertDisconnectedHandoffs(
      result,
      stages,
      contract.disconnected_handoffs.filter((handoff) =>
        contract.focused_required_stages.includes(handoff.from)
        && contract.focused_required_stages.includes(handoff.to)),
    )
    assertNoDistractors(result)
    expect(result.relationships.length).toBeGreaterThan(0)
  })

  it.each([
    ...contract.queries.punctuation_variants,
    ...contract.queries.clause_order_variants,
    ...contract.queries.distant_paraphrases,
    ...contract.queries.field_incident_variants,
  ])('keeps the same semantic skeleton for paraphrase: %s', (question) => {
    const result = retrieveContext(index, { question, budget: 4_000 })

    assertBroadEvidenceSkeleton(result)
  })

  it('rejects deterministic high-degree module and UI distractors', () => {
    const result = retrieveContext(index, {
      question: contract.queries.beta_3_broad,
      budget: 4_000,
    })

    assertNoDistractors(result)
    expect(selectedStageNodes(result).size).toBe(contract.stages.length)
  })

  it('retains the semantic skeleton under a deterministic 10k-node overlay', () => {
    const result = retrieveContext(overlayIndex, {
      question: contract.queries.beta_3_broad,
      budget: 4_000,
    })

    assertBroadEvidenceSkeleton(result)
  })

  it('retains graph-grounded phase coverage after alpha-renaming owners and files', () => {
    const result = retrieveContext(renamedIndex, {
      question: contract.queries.beta_3_broad,
      budget: 4_000,
    })
    assertProtocolLimits(result)

    const stages = selectedStageNodesFor(result, renamedStages)
    expect([...stages.keys()].sort()).toEqual(
      renamedStages.map((stage) => stage.id).sort(),
    )
    assertSemanticRelationships(result, stages, contract.causal_relationships)
    assertDisconnectedHandoffs(result, stages)
    const requiredFiles = new Set([...stages.values()].map((node) => node.source_file))
    const selectedFiles = new Set(result.matched_nodes.map((node) => node.source_file))
    expect(requiredFiles.size / selectedFiles.size).toBeGreaterThanOrEqual(0.7)
  })

  it('does not report disconnected lexical UI/config hits as a ready flow', () => {
    const result = retrieveContext(falseReadyIndex, {
      question: contract.queries.beta_3_broad,
      budget: 4_000,
    })

    expect(result.outcome).not.toBe('evidence')
    expect(result.relationships).toEqual([])
    expect(result.boundaries.length).toBeGreaterThan(0)
    expect(result.metrics.selected_files).toBeLessThanOrEqual(12)
    expect(result.metrics.snippets).toBeLessThanOrEqual(25)
    expect(result.metrics.serialized_tokens).toBeLessThanOrEqual(4_000)
  })

  it('does not promote retained structure when concept coverage is incomplete', () => {
    const source = evidenceNode('coverage-source')
    const target = evidenceNode('coverage-target')
    const result = sliceEvidence({
      request: { question: 'trace the complete runtime flow', budget: 4_000 },
      outcome: 'evidence',
      matchedNodes: [source, target],
      relationships: [{
        id: 'coverage-edge',
        from_id: source.node_id,
        to_id: target.node_id,
        relation: 'calls',
        source_file: source.source_file,
        source_location: 'L1',
        provenance: [{}],
      }],
      boundaries: [],
      priorityNodeIds: [source.node_id, target.node_id],
      closurePasses: 1,
      structuralRequired: true,
      structuralCoverageComplete: false,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.outcome).toBe('missing')
    expect(result.boundaries).toContainEqual(expect.objectContaining({
      kind: 'missing',
      subject: 'structural coverage for trace the complete runtime flow',
    }))
  })

  it('preserves a stronger corrupt outcome when structural coverage is unavailable', () => {
    const result = sliceEvidence({
      request: { question: 'trace the unavailable runtime flow', budget: 4_000 },
      outcome: 'corrupt',
      matchedNodes: [],
      relationships: [],
      boundaries: [{ kind: 'corrupt', subject: 'canonical index' }],
      priorityNodeIds: [],
      closurePasses: 0,
      structuralRequired: true,
      structuralCoverageComplete: false,
    })

    expect(result.outcome).toBe('corrupt')
    expect(result.boundaries).toEqual([
      { kind: 'corrupt', subject: 'canonical index' },
    ])
  })

  it('packs each disconnected handoff with both endpoints under the hard file cap', () => {
    const nodes = Array.from({ length: 13 }, (_, pair) => [
      evidenceNode(`producer-${pair}`),
      evidenceNode(`consumer-${pair}`),
    ]).flat()
    const boundaries = Array.from({ length: 13 }, (_, pair) => ({
      kind: 'disconnected' as const,
      subject: `producer-${pair} -> consumer-${pair}`,
    }))
    const result = sliceEvidence({
      request: { question: 'trace all handoffs', budget: 4_000 },
      outcome: 'evidence',
      matchedNodes: nodes,
      relationships: [],
      boundaries,
      priorityNodeIds: nodes.map((node) => node.node_id),
      closurePasses: 1,
    })

    const retainedIds = new Set(result.matched_nodes.map((node) => node.node_id))
    const retainedHandoffs = new Set(
      result.boundaries
        .filter((boundary) => boundary.kind === 'disconnected')
        .map((boundary) => boundary.subject),
    )
    expect(retainedHandoffs.size).toBeGreaterThan(0)
    for (let pair = 0; pair < 13; pair += 1) {
      const subject = `producer-${pair} -> consumer-${pair}`
      const endpointsRetained = retainedIds.has(`producer-${pair}`)
        && retainedIds.has(`consumer-${pair}`)
      expect(retainedHandoffs.has(subject)).toBe(endpointsRetained)
      expect(retainedIds.has(`producer-${pair}`))
        .toBe(retainedIds.has(`consumer-${pair}`))
    }
    expect(result.metrics.selected_files).toBeLessThanOrEqual(12)
    expect(result.metrics.truncated).toBe(true)
  })

  it('keeps priority disconnected endpoints ahead of non-priority causal closure', () => {
    const askedStart = evidenceNode('asked-start')
    const askedFinish = evidenceNode('asked-finish')
    const closureNodes = Array.from({ length: 12 }, (_, index) =>
      evidenceNode(`closure-${index}`))
    const relationships = Array.from({ length: 6 }, (_, pair) => ({
      id: `closure-edge-${pair}`,
      from_id: `closure-${pair * 2}`,
      to_id: `closure-${pair * 2 + 1}`,
      relation: 'calls',
      source_file: `src/closure-${pair * 2}.ts`,
      source_location: 'L1',
      provenance: [{}],
    }))
    const result = sliceEvidence({
      request: { question: 'trace asked start to asked finish', budget: 4_000 },
      outcome: 'evidence',
      matchedNodes: [askedStart, askedFinish, ...closureNodes],
      relationships,
      boundaries: [{
        kind: 'disconnected',
        subject: `${askedStart.node_id} -> ${askedFinish.node_id}`,
      }],
      priorityNodeIds: [askedStart.node_id, askedFinish.node_id],
      closurePasses: 1,
    })

    expect(result.matched_nodes.map(({ node_id }) => node_id))
      .toEqual(expect.arrayContaining([askedStart.node_id, askedFinish.node_id]))
    expect(result.boundaries).toContainEqual({
      kind: 'disconnected',
      subject: `${askedStart.node_id} -> ${askedFinish.node_id}`,
    })
    expect(result.metrics.selected_files).toBeLessThanOrEqual(12)
    expect(result.metrics.truncated).toBe(true)
  })

  it('packs each disconnected handoff with both endpoints under the token budget', () => {
    const nodes = Array.from({ length: 5 }, (_, pair) => [
      evidenceNode(`budget-producer-${pair}`),
      evidenceNode(`budget-consumer-${pair}`),
    ]).flat()
    const boundaries = Array.from({ length: 5 }, (_, pair) => ({
      kind: 'disconnected' as const,
      subject: `budget-producer-${pair} -> budget-consumer-${pair}`,
      detail: `verification target ${String(pair).repeat(80)}`,
    }))
    const result = sliceEvidence({
      request: { question: 'trace budget handoffs', budget: 700 },
      outcome: 'evidence',
      matchedNodes: nodes,
      relationships: [],
      boundaries,
      priorityNodeIds: nodes.map((node) => node.node_id),
      closurePasses: 1,
    })

    const retainedIds = new Set(result.matched_nodes.map((node) => node.node_id))
    const retainedHandoffs = result.boundaries.filter(
      (candidate) => candidate.kind === 'disconnected',
    )
    expect(retainedHandoffs.length).toBeGreaterThan(0)
    for (const boundary of retainedHandoffs) {
      const [fromId, toId] = boundary.subject.split(' -> ')
      expect(retainedIds.has(fromId!)).toBe(true)
      expect(retainedIds.has(toId!)).toBe(true)
    }
    for (let pair = 0; pair < 5; pair += 1) {
      expect(retainedIds.has(`budget-producer-${pair}`))
        .toBe(retainedIds.has(`budget-consumer-${pair}`))
    }
    expect(result.metrics.serialized_tokens).toBeLessThanOrEqual(700)
    expect(result.metrics.truncated).toBe(true)
  })

  it('keeps the real next path edge ahead of high-degree non-causal fanout', () => {
    const anchor = evidenceNode('anchor')
    const realNext = evidenceNode('real-next')
    const noise = Array.from({ length: 20 }, (_, index) =>
      evidenceNode(`noise-${index}`))
    const relationship = (
      id: string,
      from: EvidenceNode,
      to: EvidenceNode,
    ): EvidenceRelationship => ({
      id,
      from_id: from.node_id,
      to_id: to.node_id,
      relation: 'calls',
      source_file: from.source_file,
      source_location: 'L1',
      provenance: [{}],
    })
    const result = sliceEvidence({
      request: { question: 'trace anchor', budget: 850 },
      outcome: 'evidence',
      matchedNodes: [anchor, realNext, ...noise],
      relationships: [
        relationship('real-edge', anchor, realNext),
        ...noise.map((node, index) =>
          relationship(`noise-edge-${index}`, anchor, node)),
      ],
      boundaries: [],
      priorityNodeIds: [anchor.node_id, realNext.node_id],
      closurePasses: 1,
    })

    expect(result.relationships).toContainEqual(expect.objectContaining({
      id: 'real-edge',
      from_id: anchor.node_id,
      to_id: realNext.node_id,
    }))
    expect(result.relationships.length).toBeGreaterThan(0)
    const retainedIds = new Set(
      result.matched_nodes.map((node) => node.node_id),
    )
    for (const edge of result.relationships) {
      expect(retainedIds.has(edge.from_id)).toBe(true)
      expect(retainedIds.has(edge.to_id)).toBe(true)
    }
    expect(result.matched_nodes.map((node) => node.node_id))
      .toEqual(expect.arrayContaining([anchor.node_id, realNext.node_id]))
    expect(result.metrics.selected_files).toBeLessThanOrEqual(12)
    expect(result.metrics.serialized_tokens).toBeLessThanOrEqual(850)
    expect(result.metrics.truncated).toBe(true)
  })

  it('packs causal flow evidence before higher-priority navigation under token pressure', () => {
    const navigationSource = evidenceNode('navigation-source')
    const navigationTarget = evidenceNode('navigation-target')
    const causalSource = evidenceNode('causal-source')
    const causalTarget = evidenceNode('causal-target')
    const relationship = (
      id: string,
      from: EvidenceNode,
      to: EvidenceNode,
      relation: string,
    ): EvidenceRelationship => ({
      id,
      from_id: from.node_id,
      to_id: to.node_id,
      relation,
      source_file: from.source_file,
      source_location: 'L1',
      provenance: [{}],
    })
    const result = sliceEvidence({
      request: { question: 'trace the complete runtime flow', budget: 400 },
      outcome: 'evidence',
      matchedNodes: [
        navigationSource,
        navigationTarget,
        causalSource,
        causalTarget,
      ],
      relationships: [
        relationship(
          'navigation-edge',
          navigationSource,
          navigationTarget,
          'contains',
        ),
        relationship('causal-edge', causalSource, causalTarget, 'calls'),
      ],
      boundaries: [],
      priorityNodeIds: [
        navigationSource.node_id,
        navigationTarget.node_id,
        causalSource.node_id,
        causalTarget.node_id,
      ],
      closurePasses: 1,
      structuralRequired: true,
      structuralCoverageComplete: true,
    })

    expect(result.outcome).toBe('evidence')
    expect(result.relationships).toEqual([
      expect.objectContaining({ id: 'causal-edge', relation: 'calls' }),
    ])
    expect(result.matched_nodes.map(({ node_id }) => node_id).sort())
      .toEqual([causalSource.node_id, causalTarget.node_id].sort())
    expect(result.metrics.serialized_tokens).toBeLessThanOrEqual(400)
    expect(result.metrics.truncated).toBe(true)
  })

  it('does not treat navigation-only structure as a complete runtime flow', () => {
    const source = evidenceNode('navigation-only-source')
    const target = evidenceNode('navigation-only-target')
    const result = sliceEvidence({
      request: { question: 'trace the complete runtime flow', budget: 4_000 },
      outcome: 'evidence',
      matchedNodes: [source, target],
      relationships: [{
        id: 'navigation-only-edge',
        from_id: source.node_id,
        to_id: target.node_id,
        relation: 'contains',
        source_file: source.source_file,
        source_location: 'L1',
        provenance: [{}],
      }],
      boundaries: [],
      priorityNodeIds: [source.node_id, target.node_id],
      closurePasses: 1,
      structuralRequired: true,
      structuralCoverageComplete: true,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.outcome).toBe('missing')
    expect(result.boundaries).toContainEqual(expect.objectContaining({
      kind: 'missing',
      subject: 'structural coverage for trace the complete runtime flow',
    }))
  })

  it('deduplicates priority identities before enforcing snippet limits', () => {
    const node = evidenceNode('repeated-priority')
    const result = sliceEvidence({
      request: { question: 'locate repeated priority', budget: 4_000 },
      outcome: 'evidence',
      matchedNodes: [node],
      relationships: [],
      boundaries: [],
      priorityNodeIds: Array.from({ length: 26 }, () => node.node_id),
      closurePasses: 1,
    })

    expect(result.matched_nodes).toEqual([node])
    expect(result.metrics.snippets).toBe(1)
    expect(result.metrics.snippets).toBeLessThanOrEqual(25)
    expect(result.metrics.truncated).toBe(false)
  })
})
