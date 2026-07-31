import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base'
import { afterEach, describe, expect, it } from 'vitest'

import { loadGraphArtifact } from '../../src/adapters/filesystem/graph-artifact.js'
import { generateIndex } from '../../src/application/generate-index.js'
import { retrieveContext } from '../../src/application/retrieve-context.js'
import { canonicalJsonString } from '../../src/domain/graph/canonical-json.js'
import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import {
  inspectQueryIndex,
  type ReadyQueryIndex,
} from '../../src/domain/query/index-status.js'
import { rankQueryAnchors } from '../../src/domain/query/rank.js'
import { sliceEvidence } from '../../src/domain/query/slice.js'
import { traverseEvidencePaths } from '../../src/domain/query/traverse.js'
import type {
  EvidenceNode, EvidenceRelationship, RankQueryResult,
  RetrieveContextResult,
} from '../../src/domain/query/types.js'

const roots: string[] = []

function readyFixture(
  name: string,
  sources: Readonly<Record<string, string>>,
): ReadyQueryIndex {
  const root = mkdtempSync(join(tmpdir(), `madar-625-${name}-`))
  roots.push(root)
  for (const [path, source] of Object.entries(sources)) {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, source.endsWith('\n') ? source : `${source}\n`, 'utf8')
  }
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
    },
  }), 'utf8')
  const generated = generateIndex(root)
  const inspected = inspectQueryIndex(loadGraphArtifact(generated.graphPath))
  if (inspected.state !== 'ready') {
    throw new Error(`Expected ready ${name} fixture, received ${inspected.state}`)
  }
  return inspected
}

function symbolId(result: RetrieveContextResult, symbol: string): string {
  const node = result.matched_nodes.find((candidate) =>
    candidate.label.includes(symbol))
  expect(node, `missing ${symbol}`).toBeDefined()
  return node!.node_id
}

function relationshipIdentities(
  relationships: readonly EvidenceRelationship[],
): Set<string> {
  return new Set(relationships.map((edge) =>
    `${edge.from_id}\0${edge.relation}\0${edge.to_id}`))
}

function expectCall(
  result: RetrieveContextResult,
  fromSymbol: string,
  toSymbol: string,
): void {
  const fromId = symbolId(result, fromSymbol)
  const toId = symbolId(result, toSymbol)
  expect(relationshipIdentities(result.relationships))
    .toContain(`${fromId}\0calls\0${toId}`)
}

function expectWithinProtocol(result: RetrieveContextResult): void {
  expect(result.metrics.selected_files).toBeLessThanOrEqual(12)
  expect(result.metrics.snippets).toBeLessThanOrEqual(25)
  expect(result.metrics.serialized_tokens).toBeLessThanOrEqual(4_000)
  expect(result.metrics.closure_passes).toBeLessThanOrEqual(1)
}

function syntheticNode(label: string, file: string): Record<string, unknown> {
  return {
    label: `${label}()`,
    qualified_name: label,
    node_kind: 'function',
    source_file: file,
    source_location: 'L1',
    provenance: [{}],
    definition_range: {
      start: { line: 1, column: 1 },
      end: { line: 1, column: 24 },
    },
    declaration_range: {
      start: { line: 1, column: 1 },
      end: { line: 1, column: 23 },
    },
  }
}

function syntheticIndex(graph: KnowledgeGraph): ReadyQueryIndex {
  return {
    state: 'ready',
    graph,
    root_path: '/workspace',
    file_hashes: new Map(),
    unsupported_sources: [],
    operation_by_id: new Map(),
    operations_by_owner: new Map(),
    channels_by_id: new Map(),
    channels_by_key: new Map(),
  }
}

function connectorIndex(): ReadyQueryIndex {
  const graph = new KnowledgeGraph({ root_path: '/workspace' })
  const queueFile = 'src/runtime/queue.ts'
  graph.addNode('entry', syntheticNode('openWorkflow', 'src/runtime/entry.ts'))
  graph.addNode('hub', syntheticNode('enqueueTask', queueFile))
  graph.addNode('registry', syntheticNode('registerWorker', queueFile))
  graph.addEdge('entry', 'hub', {
    relation: 'calls', source_file: 'src/runtime/entry.ts',
    source_location: 'L1', provenance: [{}],
  })
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    const lower = name.toLowerCase()
    const file = `src/runtime/${lower}-worker.ts`
    const owner = `worker-${lower}`
    const registrar = `register-${lower}`
    const consumer = `process-${lower}`
    const service = `service-${lower}`
    graph.addNode(owner, {
      ...syntheticNode(`${name}Worker`, file),
      label: `${name}Worker`,
      node_kind: 'class',
    })
    graph.addNode(registrar, syntheticNode('register', file))
    graph.addNode(consumer, syntheticNode('process', file))
    graph.addNode(service, syntheticNode(
      `Service${name}.run${name}`,
      `src/runtime/${lower}-service.ts`,
    ))
    graph.addEdge(owner, registrar, {
      relation: 'contains', source_file: file,
      source_location: 'L1', provenance: [{}],
    })
    graph.addEdge(owner, consumer, {
      relation: 'contains', source_file: file,
      source_location: 'L1', provenance: [{}],
    })
    graph.addEdge(registrar, 'registry', {
      relation: 'calls', source_file: file,
      source_location: 'L1', provenance: [{}],
    })
    graph.addEdge(registrar, consumer, {
      relation: 'calls', source_file: file,
      source_location: 'L2', provenance: [{}],
    })
    graph.addEdge(consumer, service, {
      relation: 'calls', source_file: file,
      source_location: 'L3', provenance: [{}],
    })
    if (name === 'Alpha') {
      graph.addEdge('hub', consumer, {
        relation: 'calls', source_file: queueFile,
        source_location: 'L1', provenance: [{}],
      })
    }
  }
  return syntheticIndex(graph)
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('issue #625 topology-independent adversarial retrieval', () => {
  it('keeps lowercase prose periods distinct from sentence and then boundaries', () => {
    const graph = new KnowledgeGraph({ root_path: '/workspace' })
    graph.addNode('alpha', syntheticNode('alpha', 'src/alpha.ts'))
    graph.addNode('beta', syntheticNode('beta', 'src/beta.ts'))
    const index = syntheticIndex(graph)

    const lowercase = rankQueryAnchors(index, {
      question: 'Explain alpha. beta behavior',
      budget: 4_000,
    })
    const sentence = rankQueryAnchors(index, {
      question: 'Explain alpha. Beta behavior',
      budget: 4_000,
    })
    const then = rankQueryAnchors(index, {
      question: 'Explain alpha And Then beta behavior',
      budget: 4_000,
    })

    expect(lowercase.structuralRequired).toBe(false)
    expect(sentence.structuralRequired).toBe(true)
    expect(then.structuralRequired).toBe(true)
    expect(then.sequential).toBe(true)
  })

  it('treats an explicit scope already in the connector entry as satisfied', () => {
    const ranked = rankQueryAnchors(connectorIndex(), {
      question: 'Trace openWorkflow through `enqueueTask`.',
      budget: 4_000,
    })

    expect(ranked.anchors.map(({ id }) => id)).toContain('hub')
    expect(ranked.structuralCoverageComplete).toBe(true)
  })

  it('does not silently drop a second explicit connector scope', () => {
    const index = connectorIndex()
    const ranked = rankQueryAnchors(index, {
      question:
        'Trace enqueueTask through `ServiceAlpha.runAlpha` and `ServiceBeta.runBeta`.',
      budget: 4_000,
    })
    const traversed = traverseEvidencePaths(index, ranked)

    expect(ranked.anchors.map(({ id }) => id)).toEqual(expect.arrayContaining([
      'service-alpha',
      'service-beta',
    ]))
    expect(traversed.edges.map(({ from, to }) => `${from}->${to}`))
      .toEqual(expect.arrayContaining([
        'process-alpha->service-alpha',
        'process-beta->service-beta',
      ]))
    expect(ranked.structuralCoverageComplete).toBe(true)
  })

  it('preserves every directed edge in a pure three-node causal cycle', () => {
    const index = readyFixture('pure-cycle', {
      'src/cycle/alpha.ts': [
        "import { stepBeta } from './beta.js'",
        '',
        'export function stepAlpha(value: string): string {',
        '  return stepBeta(value)',
        '}',
      ].join('\n'),
      'src/cycle/beta.ts': [
        "import { stepGamma } from './gamma.js'",
        '',
        'export function stepBeta(value: string): string {',
        '  return stepGamma(value)',
        '}',
      ].join('\n'),
      'src/cycle/gamma.ts': [
        "import { stepAlpha } from './alpha.js'",
        '',
        'export function stepGamma(value: string): string {',
        '  return stepAlpha(value)',
        '}',
      ].join('\n'),
    })

    const result = retrieveContext(index, {
      question:
        'Trace stepAlpha through stepBeta and stepGamma back to stepAlpha.',
      budget: 4_000,
    })

    expect(result.outcome).toBe('evidence')
    expectCall(result, 'stepAlpha', 'stepBeta')
    expectCall(result, 'stepBeta', 'stepGamma')
    expectCall(result, 'stepGamma', 'stepAlpha')
    expectWithinProtocol(result)
  })

  it('retrieves a synchronous direct causal chain without a registry or worker lifecycle', () => {
    const index = readyFixture('direct-chain', {
      'src/direct/accept.ts': [
        "import { normalizeRecord } from './normalize.js'",
        '',
        'export function acceptEnvelope(value: string): string {',
        '  return normalizeRecord(value)',
        '}',
      ].join('\n'),
      'src/direct/normalize.ts': [
        "import { persistRecord } from './persist.js'",
        '',
        'export function normalizeRecord(value: string): string {',
        '  return persistRecord(value.trim())',
        '}',
      ].join('\n'),
      'src/direct/persist.ts': [
        'export function persistRecord(value: string): string {',
        "  return `${value}:stored`",
        '}',
      ].join('\n'),
    })

    const result = retrieveContext(index, {
      question:
        'Trace the synchronous flow from acceptEnvelope through normalizeRecord to persistRecord.',
      budget: 4_000,
    })

    expect(result.outcome).toBe('evidence')
    expectCall(result, 'acceptEnvelope', 'normalizeRecord')
    expectCall(result, 'normalizeRecord', 'persistRecord')
    expectWithinProtocol(result)
  })

  it('retains two requested disconnected chains and the exact inter-chain boundary', () => {
    const index = readyFixture('disconnected-chains', {
      'src/alpha/ingress.ts': [
        "import { alphaArchive } from './archive.js'",
        '',
        'export function alphaIngress(value: string): string {',
        '  return alphaArchive(value)',
        '}',
      ].join('\n'),
      'src/alpha/archive.ts': [
        'export function alphaArchive(value: string): string {',
        "  return `archived:${value}`",
        '}',
      ].join('\n'),
      'src/omega/ingress.ts': [
        "import { omegaPublish } from './publish.js'",
        '',
        'export function omegaIngress(value: string): string {',
        '  return omegaPublish(value)',
        '}',
      ].join('\n'),
      'src/omega/publish.ts': [
        'export function omegaPublish(value: string): string {',
        "  return `published:${value}`",
        '}',
      ].join('\n'),
    })

    const result = retrieveContext(index, {
      question:
        'Trace alphaIngress through alphaArchive, then omegaIngress through omegaPublish.',
      budget: 4_000,
    })

    expect(result.outcome).toBe('evidence')
    expectCall(result, 'alphaIngress', 'alphaArchive')
    expectCall(result, 'omegaIngress', 'omegaPublish')
    const archiveId = symbolId(result, 'alphaArchive')
    const omegaIngressId = symbolId(result, 'omegaIngress')
    expect(result.boundaries).toContainEqual(expect.objectContaining({
      kind: 'disconnected',
      subject: `${archiveId} -> ${omegaIngressId}`,
    }))
    expectWithinProtocol(result)
  })

  it('does not claim evidence when a requested disconnected-chain concept is absent', () => {
    const index = readyFixture('incomplete-disconnected-chains', {
      'src/alpha/ingress.ts': [
        "import { alphaArchive } from './archive.js'",
        '',
        'export function alphaIngress(value: string): string {',
        '  return alphaArchive(value)',
        '}',
      ].join('\n'),
      'src/alpha/archive.ts': [
        'export function alphaArchive(value: string): string {',
        "  return `archived:${value}`",
        '}',
      ].join('\n'),
      'src/omega/ingress.ts': [
        "import { omegaPublish } from './publish.js'",
        '',
        'export function omegaIngress(value: string): string {',
        '  return omegaPublish(value)',
        '}',
      ].join('\n'),
      'src/omega/publish.ts': [
        'export function omegaPublish(value: string): string {',
        "  return `published:${value}`",
        '}',
      ].join('\n'),
    })

    const result = retrieveContext(index, {
      question:
        'Trace alphaIngress through missingArchive, then omegaIngress through omegaPublish.',
      budget: 4_000,
    })

    expect(result.outcome).not.toBe('evidence')
    expect(result.boundaries).toContainEqual(expect.objectContaining({
      kind: 'missing',
    }))
    expectWithinProtocol(result)
  })

  it('keeps an exact-symbol locator focused instead of expanding a full skeleton', () => {
    const index = readyFixture('focused-locator', {
      'src/locator/target.ts': [
        'export function targetLocator(value: string): string {',
        "  return `target:${value}`",
        '}',
      ].join('\n'),
      'src/unrelated/open.ts': [
        "import { continueUnrelated } from './continue.js'",
        'export function openUnrelated(value: string): string {',
        '  return continueUnrelated(value)',
        '}',
      ].join('\n'),
      'src/unrelated/continue.ts': [
        "import { finishUnrelated } from './finish.js'",
        'export function continueUnrelated(value: string): string {',
        '  return finishUnrelated(value)',
        '}',
      ].join('\n'),
      'src/unrelated/finish.ts': [
        'export function finishUnrelated(value: string): string {',
        '  return value',
        '}',
      ].join('\n'),
    })

    const result = retrieveContext(index, {
      question: 'Where is targetLocator defined?',
      budget: 4_000,
    })

    expect(result.outcome).toBe('evidence')
    expect(symbolId(result, 'targetLocator')).toBeTruthy()
    expect(result.matched_nodes.some((node) =>
      node.label.includes('Unrelated'))).toBe(false)
    expect(result.matched_nodes.length).toBeLessThanOrEqual(2)
    expectWithinProtocol(result)
  })

  it('accepts a multi-file shallow dispatch fan-out and keeps every causal edge', () => {
    const index = readyFixture('dispatch-fanout', {
      'src/orders/dispatch.ts': [
        "import { sendEmail } from '../sinks/email.js'",
        "import { writeAudit } from '../sinks/audit.js'",
        "import { updateMetric } from '../sinks/metric.js'",
        '',
        'export function dispatchOrder(order: string): string[] {',
        '  return [sendEmail(order), writeAudit(order), updateMetric(order)]',
        '}',
      ].join('\n'),
      'src/sinks/email.ts': [
        'export function sendEmail(order: string): string {',
        "  return `email:${order}`",
        '}',
      ].join('\n'),
      'src/sinks/audit.ts': [
        'export function writeAudit(order: string): string {',
        "  return `audit:${order}`",
        '}',
      ].join('\n'),
      'src/sinks/metric.ts': [
        'export function updateMetric(order: string): string {',
        "  return `metric:${order}`",
        '}',
      ].join('\n'),
    })

    for (const question of [
      'Trace dispatchOrder to sendEmail, writeAudit, and updateMetric.',
      'Trace from dispatchOrder to sendEmail and writeAudit.',
    ]) {
      const result = retrieveContext(index, { question, budget: 4_000 })

      expect(result.outcome).toBe('evidence')
      expectCall(result, 'dispatchOrder', 'sendEmail')
      expectCall(result, 'dispatchOrder', 'writeAudit')
      if (question.includes('updateMetric')) {
        expectCall(result, 'dispatchOrder', 'updateMetric')
      }
      expect(result.boundaries).toEqual([])
      expectWithinProtocol(result)
    }
  })

  it('reports a sequential request between sibling sinks as disconnected', () => {
    const index = readyFixture('sequential-siblings', {
      'src/orders/dispatch.ts': [
        "import { sendEmail } from '../sinks/email.js'",
        "import { writeAudit } from '../sinks/audit.js'",
        'export function dispatchOrder(order: string): string[] {',
        '  return [sendEmail(order), writeAudit(order)]',
        '}',
      ].join('\n'),
      'src/sinks/email.ts': [
        'export function sendEmail(order: string): string {',
        "  return `email:${order}`",
        '}',
      ].join('\n'),
      'src/sinks/audit.ts': [
        'export function writeAudit(order: string): string {',
        "  return `audit:${order}`",
        '}',
      ].join('\n'),
    })

    const result = retrieveContext(index, {
      question: 'Trace sendEmail through writeAudit.',
      budget: 4_000,
    })

    const emailId = symbolId(result, 'sendEmail')
    const auditId = symbolId(result, 'writeAudit')
    expect(result.boundaries).toContainEqual(expect.objectContaining({
      kind: 'disconnected',
      subject: `${emailId} -> ${auditId}`,
    }))
    expectWithinProtocol(result)
  })

  it('uses only real locator attributes in disconnected verification details', () => {
    const graph = new KnowledgeGraph({ root_path: '/workspace' })
    graph.addNode('left', { label: 'left()', node_kind: 'function' })
    graph.addNode('right', {
      label: 'right()',
      node_kind: 'function',
      source_file: 'src/right.ts',
    })
    const ranked: RankQueryResult = {
      anchors: ['left', 'right'].map((id, firstMatch) => ({
        id,
        attributes: graph.nodeAttributes(id),
        score: 1,
        matchedTerms: [],
        firstMatch,
      })),
      boundaries: [],
      queryTerms: ['left', 'right'],
      flow: true,
      branch: [],
      priorityAnchorIds: ['left', 'right'],
      structuralRequired: true,
      structuralCoverageComplete: true,
    }

    const traversed = traverseEvidencePaths(syntheticIndex(graph), ranked)

    expect(traversed.boundaries).toContainEqual({
      kind: 'disconnected',
      subject: 'left -> right',
      detail: 'left -> src/right.ts',
    })
    expect(traversed.boundaries[0]?.detail).not.toContain('undefined')
  })

  it('does not use a test-only common parent as runtime flow evidence', () => {
    const index = readyFixture('test-common-parent', {
      'src/orders/email.ts': [
        "import { finishOrder } from './finish.js'",
        'export function sendEmail(order: string): string {',
        '  return finishOrder(`email:${order}`)',
        '}',
      ].join('\n'),
      'src/orders/audit.ts': [
        "import { finishOrder } from './finish.js'",
        'export function writeAudit(order: string): string {',
        '  return finishOrder(`audit:${order}`)',
        '}',
      ].join('\n'),
      'src/orders/finish.ts': [
        'export function finishOrder(order: string): string { return order }',
      ].join('\n'),
      'tests/orders/dispatch.test.ts': [
        "import { sendEmail } from '../../src/orders/email.js'",
        "import { writeAudit } from '../../src/orders/audit.js'",
        'export function dispatchTestOrder(order: string): string[] {',
        '  return [sendEmail(order), writeAudit(order)]',
        '}',
      ].join('\n'),
    })

    const result = retrieveContext(index, {
      question:
        'Explain the flow from sendEmail and writeAudit to finishOrder.',
      budget: 4_000,
    })

    expect(result.outcome).toBe('evidence')
    expectCall(result, 'sendEmail', 'finishOrder')
    expectCall(result, 'writeAudit', 'finishOrder')
    expect(result.matched_nodes.some(({ source_file }) =>
      source_file.startsWith('tests/'))).toBe(false)
    expectWithinProtocol(result)
  })

  it('preserves a causal flow when the query explicitly requests tests', () => {
    const index = readyFixture('explicit-test-flow', {
      'tests/auth-route.test.ts': [
        "import { testAuthService } from '../src/auth-service.js'",
        'export function testAuthRoute(): string {',
        '  return testAuthService()',
        '}',
      ].join('\n'),
      'src/auth-service.ts': [
        "import { assertAuthRecord } from '../tests/auth-assertion.js'",
        'export function testAuthService(): string {',
        '  return assertAuthRecord()',
        '}',
      ].join('\n'),
      'tests/auth-assertion.ts': [
        'export function assertAuthRecord(): string {',
        "  return 'verified'",
        '}',
      ].join('\n'),
    })

    const result = retrieveContext(index, {
      question:
        'Explain the test flow from testAuthRoute through assertAuthRecord.',
      budget: 4_000,
    })

    expect(result.outcome).toBe('evidence')
    expectCall(result, 'testAuthRoute', 'testAuthService')
    expectCall(result, 'testAuthService', 'assertAuthRecord')
    expect(result.matched_nodes.map(({ source_file }) => source_file))
      .toContain('src/auth-service.ts')
    expectWithinProtocol(result)
  })

  it('does not authenticate a production path through a test-only bridge', () => {
    const index = readyFixture('test-only-bridge', {
      'src/runtime-start.ts': [
        "import { testBridge } from '../tests/runtime-bridge.test.js'",
        'export function runtimeStart(): string {',
        '  return testBridge()',
        '}',
      ].join('\n'),
      'tests/runtime-bridge.test.ts': [
        "import { runtimeFinish } from '../src/runtime-finish.js'",
        'export function testBridge(): string {',
        '  return runtimeFinish()',
        '}',
      ].join('\n'),
      'src/runtime-finish.ts': [
        'export function runtimeFinish(): string {',
        "  return 'complete'",
        '}',
      ].join('\n'),
    })

    const result = retrieveContext(index, {
      question: 'Trace runtimeStart through runtimeFinish.',
      budget: 4_000,
    })

    expect(result.outcome).toBe('missing')
    expect(result.relationships).toEqual([])
    expect(result.boundaries.length).toBeGreaterThan(0)
    expect(result.matched_nodes.some(({ source_file }) =>
      source_file.startsWith('tests/'))).toBe(false)
    expectWithinProtocol(result)
  })

  it('does not borrow an unrelated registry topology for disconnected flow siblings', () => {
    const index = readyFixture('false-connector', {
      'src/flow/shared-flow.ts': [
        'export function beginFlow(value: string): string {',
        "  return `begin:${value}`",
        '}',
        '',
        'export function finishFlow(value: string): string {',
        "  return `finish:${value}`",
        '}',
      ].join('\n'),
      'src/registry/queue.ts': [
        'export class Queue {',
        '  addJob(value: string): string { return this.noise(value) }',
        '  noise(value: string): string { return value }',
        '  registerWorker(task: () => string): string { return task() }',
        '}',
        'export const queue = new Queue()',
        'export function bootstrapRegistry(): string { return queue.addJob("boot") }',
      ].join('\n'),
      'src/registry/worker-alpha.ts': [
        "import { queue } from './queue.js'",
        "import { AlphaService } from './service-alpha.js'",
        'export class AlphaWorker {',
        '  private readonly service = new AlphaService()',
        '  register(): string {',
        '    queue.registerWorker(() => this.process())',
        '    return this.process()',
        '  }',
        '  process(): string { return this.service.execute() }',
        '}',
      ].join('\n'),
      'src/registry/worker-omega.ts': [
        "import { queue } from './queue.js'",
        "import { OmegaService } from './service-omega.js'",
        'export class OmegaWorker {',
        '  private readonly service = new OmegaService()',
        '  register(): string {',
        '    queue.registerWorker(() => this.process())',
        '    return this.process()',
        '  }',
        '  process(): string { return this.service.execute() }',
        '}',
      ].join('\n'),
      'src/registry/service-alpha.ts': [
        "import { queue } from './queue.js'",
        'export class AlphaService {',
        '  execute(): string { return queue.addJob("alpha") }',
        '}',
      ].join('\n'),
      'src/registry/service-omega.ts': [
        'export class OmegaService {',
        '  execute(): string { return "omega" }',
        '}',
      ].join('\n'),
    })

    const result = retrieveContext(index, {
      question: 'Trace beginFlow through finishFlow.',
      budget: 4_000,
    })

    expect(result.outcome).not.toBe('evidence')
    expect(result.matched_nodes.some((node) =>
      node.source_file.startsWith('src/registry/'))).toBe(false)
    expect(result.boundaries).toContainEqual(expect.objectContaining({
      kind: 'missing',
    }))
    expectWithinProtocol(result)
  })

  it('uses an authenticated enqueues_job edge for an independent queued topology', () => {
    const index = readyFixture('queued-handoff', {
      'src/queue/publisher.ts': [
        'class Queue {',
        '  async add(name: string, value: string): Promise<string> {',
        '    return `${name}:${value}`',
        '  }',
        '}',
        '',
        'const outboundQueue = new Queue()',
        '',
        'export async function publishEnvelope(value: string): Promise<string> {',
        "  return outboundQueue.add('delivery.consume', value)",
        '}',
      ].join('\n'),
      'src/queue/worker.ts': [
        'function Processor(_queue: string): ClassDecorator {',
        '  return () => undefined',
        '}',
        'function Process(_job: string): MethodDecorator {',
        '  return () => undefined',
        '}',
        '',
        "@Processor('delivery')",
        'export class DeliveryWorker {',
        "  @Process('consume')",
        '  async consumeEnvelope(value: string): Promise<string> {',
        '    return value',
        '  }',
        '}',
      ].join('\n'),
    })

    const result = retrieveContext(index, {
      question:
        'Trace publishEnvelope through the queued handoff to consumeEnvelope.',
      budget: 4_000,
    })

    expect(result.outcome).toBe('evidence')
    const publisherId = symbolId(result, 'publishEnvelope')
    const consumerId = symbolId(result, 'consumeEnvelope')
    expect(relationshipIdentities(result.relationships)).toContain(
      `${publisherId}\0enqueues_job\0${consumerId}`,
    )
    expectWithinProtocol(result)
  })

  it('preserves both fan-out branches and their shared fan-in target across multiple hubs', () => {
    const index = readyFixture('fan-forest', {
      'src/forest/launch.ts': [
        "import { coordinateBatch } from './coordinate.js'",
        '',
        'export function launchBatch(value: string): string[] {',
        '  return coordinateBatch(value)',
        '}',
      ].join('\n'),
      'src/forest/coordinate.ts': [
        "import { enrichSlice } from './enrich.js'",
        "import { verifySlice } from './verify.js'",
        '',
        'export function coordinateBatch(value: string): string[] {',
        '  return [enrichSlice(value), verifySlice(value)]',
        '}',
      ].join('\n'),
      'src/forest/enrich.ts': [
        "import { foldContribution } from './fold.js'",
        '',
        'export function enrichSlice(value: string): string {',
        "  return foldContribution(`enriched:${value}`)",
        '}',
      ].join('\n'),
      'src/forest/verify.ts': [
        "import { foldContribution } from './fold.js'",
        '',
        'export function verifySlice(value: string): string {',
        "  return foldContribution(`verified:${value}`)",
        '}',
      ].join('\n'),
      'src/forest/fold.ts': [
        'export function foldContribution(value: string): string {',
        '  return value',
        '}',
      ].join('\n'),
    })

    const result = retrieveContext(index, {
      question:
        'Trace launchBatch through coordinateBatch, both enrichSlice and verifySlice branches, to foldContribution.',
      budget: 4_000,
    })

    expect(result.outcome).toBe('evidence')
    expectCall(result, 'launchBatch', 'coordinateBatch')
    expectCall(result, 'coordinateBatch', 'enrichSlice')
    expectCall(result, 'coordinateBatch', 'verifySlice')
    expectCall(result, 'enrichSlice', 'foldContribution')
    expectCall(result, 'verifySlice', 'foldContribution')
    expectWithinProtocol(result)
  })

  it('does not fabricate a disconnected handoff between pure fan-in branches', () => {
    const index = readyFixture('pure-fan-in', {
      'src/fan-in/alpha.ts': [
        "import { mergeResult } from './merge.js'",
        'export function alphaProcess(value: string): string {',
        '  return mergeResult(`alpha:${value}`)',
        '}',
      ].join('\n'),
      'src/fan-in/beta.ts': [
        "import { mergeResult } from './merge.js'",
        'export function betaProcess(value: string): string {',
        '  return mergeResult(`beta:${value}`)',
        '}',
      ].join('\n'),
      'src/fan-in/merge.ts': [
        'export function mergeResult(value: string): string { return value }',
      ].join('\n'),
    })

    const result = retrieveContext(index, {
      question:
        'Explain the flow from alphaProcess and betaProcess to mergeResult.',
      budget: 4_000,
    })

    expect(result.outcome).toBe('evidence')
    expectCall(result, 'alphaProcess', 'mergeResult')
    expectCall(result, 'betaProcess', 'mergeResult')
    expect(result.boundaries.filter(({ kind }) => kind === 'disconnected'))
      .toEqual([])
    expectWithinProtocol(result)
  })

  it('keeps retry-cycle evidence while exposing an unresolved terminal handoff', () => {
    const index = readyFixture('retry-cycle', {
      'src/retry/open.ts': [
        "import { runAttempt } from './run.js'",
        '',
        'export function openCycle(value: string): string {',
        '  return runAttempt(value, 0)',
        '}',
      ].join('\n'),
      'src/retry/run.ts': [
        "import { scheduleRetry } from './schedule.js'",
        "import { completeAttempt } from './terminal.js'",
        '',
        'export function runAttempt(value: string, count: number): string {',
        '  return count < 1',
        '    ? scheduleRetry(value, count + 1)',
        '    : completeAttempt(value)',
        '}',
      ].join('\n'),
      'src/retry/schedule.ts': [
        "import { runAttempt } from './run.js'",
        '',
        'export function scheduleRetry(value: string, count: number): string {',
        '  return runAttempt(value, count)',
        '}',
      ].join('\n'),
      'src/retry/terminal.ts': [
        'export function completeAttempt(value: string): string {',
        '  return value',
        '}',
        '',
        'export function publishOutcome(value: string): string {',
        "  return `published:${value}`",
        '}',
      ].join('\n'),
    })

    const result = retrieveContext(index, {
      question:
        'Trace openCycle through runAttempt and scheduleRetry to completeAttempt, then verify the unresolved handoff to publishOutcome.',
      budget: 4_000,
    })

    expectCall(result, 'openCycle', 'runAttempt')
    expectCall(result, 'runAttempt', 'scheduleRetry')
    expectCall(result, 'scheduleRetry', 'runAttempt')
    expectCall(result, 'runAttempt', 'completeAttempt')
    const completeId = symbolId(result, 'completeAttempt')
    const publishId = symbolId(result, 'publishOutcome')
    expect(result.boundaries).toContainEqual(expect.objectContaining({
      kind: 'disconnected',
      subject: `${completeId} -> ${publishId}`,
    }))
    expectWithinProtocol(result)
  })

  it('does not mistake a connected presentation call-star for an end-to-end runtime flow', () => {
    const index = readyFixture('presentation-star', {
      'src/presentation/journey-card.ts': [
        'function showRequestCreation(): string { return "created" }',
        'function showProcessingStage(): string { return "processing" }',
        'function showAssemblyStage(): string { return "assembly" }',
        'function showPersistenceStage(): string { return "persistence" }',
        '',
        'export function renderJourneyCard(): string {',
        '  return [',
        '    showRequestCreation(),',
        '    showProcessingStage(),',
        '    showAssemblyStage(),',
        '    showPersistenceStage(),',
        '  ].join(":")',
        '}',
      ].join('\n'),
    })

    const result = retrieveContext(index, {
      question:
        'Explain the end-to-end runtime flow from request creation through processing and assembly to persistence.',
      budget: 4_000,
    })

    expect(result.outcome).not.toBe('evidence')
    expect(result.boundaries).toContainEqual(expect.objectContaining({
      kind: 'missing',
    }))
    expectWithinProtocol(result)
  })

  it('bounds common-parent expansion before ordering a deep 7k-node candidate', () => {
    const graph = new KnowledgeGraph({ root_path: '/workspace' })
    const file = 'src/deep-common-parents.ts'
    graph.addNode('alpha-anchor', syntheticNode('alphaAnchor', file))
    graph.addNode('beta-anchor', syntheticNode('betaAnchor', file))
    for (let index = 0; index < 7_000; index += 1) {
      const id = `parent-${index.toString().padStart(4, '0')}`
      graph.addNode(id, syntheticNode(`sharedParent${index}`, file))
    }
    for (let index = 0; index < 7_000; index += 1) {
      const id = `parent-${index.toString().padStart(4, '0')}`
      for (const target of [
        index < 6_999
          ? `parent-${(index + 1).toString().padStart(4, '0')}`
          : '',
        'alpha-anchor',
        'beta-anchor',
      ].filter(Boolean)) {
        graph.addEdge(id, target, {
          relation: 'calls',
          source_file: file,
          source_location: 'L1',
          provenance: [{}],
        })
      }
    }

    const ranked = rankQueryAnchors(syntheticIndex(graph), {
      question: 'Trace alphaAnchor through betaAnchor.',
      budget: 4_000,
    })

    expect(ranked.anchors.length).toBeGreaterThan(0)
    expect(ranked.anchors.length).toBeLessThanOrEqual(25)
  })

  it('selects exact endpoints in a concentrated 12k-node scope', () => {
    const graph = new KnowledgeGraph({ root_path: '/workspace' })
    const file = 'src/concentrated.ts'
    const count = 12_344
    for (let index = 0; index < count; index += 1) {
      const id = `chain-${index.toString().padStart(5, '0')}`
      const label = index === 0
        ? 'startConcentrated'
        : index === count - 1 ? 'finishConcentrated' : `chainNode${index}`
      graph.addNode(id, syntheticNode(label, file))
    }
    graph.addEdge('chain-00000', 'chain-12343', {
      relation: 'calls',
      source_file: file,
      source_location: 'L1',
      provenance: [{}],
    })

    const ranked = rankQueryAnchors(syntheticIndex(graph), {
      question: 'Trace startConcentrated through finishConcentrated.',
      budget: 4_000,
    })

    expect(ranked.priorityAnchorIds).toEqual([
      'chain-00000',
      'chain-12343',
    ])
  })

  it('preserves parallel authenticated edges before budget packing', () => {
    const graph = new KnowledgeGraph({ root_path: '/workspace' })
    const file = 'src/parallel.ts'
    graph.addNode('parallel-start', syntheticNode('parallelStart', file))
    graph.addNode('parallel-finish', syntheticNode('parallelFinish', file))
    for (let index = 0; index < 2_000; index += 1) {
      graph.addEdge('parallel-start', 'parallel-finish', {
        relation: 'calls',
        source_file: file,
        source_location: `L${index + 1}`,
        provenance: [{}],
      })
    }
    const queryIndex = syntheticIndex(graph)
    const ranked: RankQueryResult = {
      anchors: ['parallel-start', 'parallel-finish'].map((id, firstMatch) => ({
        id,
        attributes: graph.nodeAttributes(id),
        score: 1,
        matchedTerms: [],
        firstMatch,
      })),
      boundaries: [],
      queryTerms: ['parallel'],
      flow: true,
      branch: [],
      priorityAnchorIds: ['parallel-start', 'parallel-finish'],
      structuralRequired: true,
      structuralCoverageComplete: true,
    }
    const evidenceNodes: EvidenceNode[] = ranked.anchors.map(({ id, attributes }) => ({
      node_id: id,
      label: String(attributes.label),
      node_kind: 'function',
      evidence_kind: 'symbol_declaration',
      source_file: file,
      source_location: 'L1',
      line_number: 1,
      end_line_number: 1,
      provenance: [{}],
      content_hash: 'hash',
      definition_range: {
        start: { line: 1, column: 1 },
        end: { line: 1, column: 24 },
      },
      declaration_range: {
        start: { line: 1, column: 1 },
        end: { line: 1, column: 23 },
      },
      snippet: `export function ${String(attributes.label).replace('()', '')}(): void {}`,
    }))

    const traversed = traverseEvidencePaths(queryIndex, ranked)
    const result = sliceEvidence({
      request: {
        question: 'Trace parallelStart through parallelFinish.',
        budget: 4_000,
      },
      outcome: 'evidence',
      matchedNodes: evidenceNodes,
      relationships: traversed.edges.map((edge): EvidenceRelationship => ({
        id: edge.id,
        from_id: edge.from,
        to_id: edge.to,
        relation: edge.relation,
        source_file: file,
        source_location: String(edge.attributes.source_location),
        provenance: [{}],
      })),
      boundaries: traversed.boundaries,
      priorityNodeIds: ranked.priorityAnchorIds ?? [],
      closurePasses: traversed.closurePasses,
      structuralRequired: true,
      structuralCoverageComplete: true,
    })

    expect(traversed.edges).toHaveLength(2_000)
    expect(traversed.boundaries).toEqual([])
    expect(result.relationships.length).toBeGreaterThan(0)
    expect(result.relationships.length).toBeLessThan(2_000)
    expect(result.metrics.serialized_tokens).toBeLessThanOrEqual(4_000)
    expect(result.metrics.truncated).toBe(true)

    const fitting = sliceEvidence({
      request: {
        question: 'Trace parallelStart through parallelFinish.',
        budget: 4_000,
      },
      outcome: 'evidence',
      matchedNodes: evidenceNodes,
      relationships: traversed.edges.slice(0, 2).map((edge): EvidenceRelationship => ({
        id: edge.id,
        from_id: edge.from,
        to_id: edge.to,
        relation: edge.relation,
        source_file: file,
        source_location: String(edge.attributes.source_location),
        provenance: [{}],
      })),
      boundaries: [],
      priorityNodeIds: ranked.priorityAnchorIds ?? [],
      closurePasses: 1,
      structuralRequired: true,
      structuralCoverageComplete: true,
    })
    expect(fitting.relationships).toHaveLength(2)

    const packed = sliceEvidence({
      request: {
        question: 'Trace parallelStart through parallelFinish.',
        budget: 500,
      },
      outcome: 'evidence',
      matchedNodes: evidenceNodes,
      relationships: ['a-small', 'b-huge', 'c-small'].map((id) => ({
        id,
        from_id: 'parallel-start',
        to_id: 'parallel-finish',
        relation: 'calls',
        source_file: file,
        source_location: 'L1',
        provenance: id === 'b-huge' ? [{ detail: 'x'.repeat(8_000) }] : [{}],
      })),
      boundaries: [],
      priorityNodeIds: ranked.priorityAnchorIds ?? [],
      closurePasses: 1,
      structuralRequired: true,
      structuralCoverageComplete: true,
    })
    expect(packed.relationships.map(({ id }) => id)).toEqual([
      'a-small',
      'c-small',
    ])
  })

  it('keeps incremental parallel-edge accounting within the exact final budget', () => {
    const file = 'src/exact-budget.ts'
    const nodes: EvidenceNode[] = ['budgetStart', 'budgetFinish'].map((label) => ({
      node_id: label,
      label: `${label}()`,
      node_kind: 'function',
      evidence_kind: 'symbol_declaration',
      source_file: file,
      source_location: 'L1',
      line_number: 1,
      end_line_number: 1,
      provenance: [{}],
      content_hash: 'hash',
      definition_range: {
        start: { line: 1, column: 1 },
        end: { line: 1, column: 24 },
      },
      declaration_range: {
        start: { line: 1, column: 1 },
        end: { line: 1, column: 23 },
      },
      snippet: `export function ${label}(): void {}`,
    }))
    const boundaryDetails = [
      'plain',
      'punctuation: },{][::,,',
      'escaped: "quote" \\ slash \n newline',
      'unicode: مرحبا — 東京 🙂',
    ] as const
    const relationships: EvidenceRelationship[] = Array.from(
      { length: 96 },
      (_, index) => ({
        id: `${String(index).padStart(3, '0')}-${'xy'.repeat(index % 13)}`,
        from_id: 'budgetStart',
        to_id: 'budgetFinish',
        relation: 'calls',
        source_file: file,
        source_location: `L${index + 1}-${'q'.repeat(index % 37)}`,
        provenance: [{
          detail: `${boundaryDetails[index % boundaryDetails.length]}:${
            'z'.repeat((index * 17) % 53)
          }`,
        }],
      }),
    )
    const retrieveAt = (budget: number): RetrieveContextResult => sliceEvidence({
      request: {
        question: 'Trace budgetStart through budgetFinish.',
        budget,
      },
      outcome: 'evidence',
      matchedNodes: nodes,
      relationships,
      boundaries: [],
      priorityNodeIds: nodes.map(({ node_id }) => node_id),
      closurePasses: 1,
      structuralRequired: true,
      structuralCoverageComplete: true,
    })
    const probe = retrieveAt(777)
    const threshold = probe.metrics.serialized_tokens
    const budgets = [...new Set([
      256, 333, 511, threshold - 1, threshold, threshold + 1,
      1_024, 2_048, 3_999,
    ].filter((budget) => budget >= 256 && budget <= 4_000))]

    for (const budget of budgets) {
      const result = retrieveAt(budget)

      expect(retrieveAt(budget)).toEqual(result)
      expect(result.metrics.serialized_tokens).toBeLessThanOrEqual(budget)
      expect(countTokens(canonicalJsonString(result)))
        .toBe(result.metrics.serialized_tokens)
      const retainedIds = new Set(
        result.matched_nodes.map(({ node_id }) => node_id),
      )
      for (const edge of result.relationships) {
        expect(retainedIds.has(edge.from_id)).toBe(true)
        expect(retainedIds.has(edge.to_id)).toBe(true)
      }
    }
  })

  it('bounds a structural-missing envelope for a maximum-length question', () => {
    const result = sliceEvidence({
      request: {
        question: '🙂'.repeat(256),
        budget: 256,
      },
      outcome: 'evidence',
      matchedNodes: [],
      relationships: [],
      boundaries: [],
      priorityNodeIds: [],
      closurePasses: 0,
      structuralRequired: true,
      structuralCoverageComplete: false,
    })

    expect(result.outcome).toBe('missing')
    expect(result.boundaries).toContainEqual({
      kind: 'missing',
      subject: 'structural coverage',
    })
    expect(result.metrics.serialized_tokens).toBeLessThanOrEqual(256)
    expect(countTokens(canonicalJsonString(result)))
      .toBe(result.metrics.serialized_tokens)
  })
})
