import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadGraphArtifact } from '../../src/adapters/filesystem/graph-artifact.js'
import { generateIndex } from '../../src/application/generate-index.js'
import { retrieveContext } from '../../src/application/retrieve-context.js'
import {
  inspectQueryIndex,
  type ReadyQueryIndex,
} from '../../src/domain/query/index-status.js'
import type {
  EvidenceRelationship,
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

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('issue #625 topology-independent adversarial retrieval', () => {
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

    const result = retrieveContext(index, {
      question:
        'Trace dispatchOrder to sendEmail, writeAudit, and updateMetric.',
      budget: 4_000,
    })

    expect(result.outcome).toBe('evidence')
    expectCall(result, 'dispatchOrder', 'sendEmail')
    expectCall(result, 'dispatchOrder', 'writeAudit')
    expectCall(result, 'dispatchOrder', 'updateMetric')
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
      'src/registry/unrelated-registry.ts': [
        "import { AlphaUnit } from './unit-alpha.js'",
        "import { OmegaUnit } from './unit-omega.js'",
        '',
        'export class UnrelatedRegistry {',
        '  registerUnit(task: () => string): void { void task }',
        '}',
        '',
        'export function bootstrapRegistry(): void {',
        '  const registry = new UnrelatedRegistry()',
        '  const alpha = new AlphaUnit()',
        '  const omega = new OmegaUnit()',
        '  registry.registerUnit(() => alpha.runTask())',
        '  registry.registerUnit(() => omega.runTask())',
        '}',
      ].join('\n'),
      'src/registry/unit-alpha.ts': [
        'export class AlphaUnit {',
        '  runTask(): string { return "alpha" }',
        '}',
      ].join('\n'),
      'src/registry/unit-omega.ts': [
        'export class OmegaUnit {',
        '  runTask(): string { return "omega" }',
        '}',
      ].join('\n'),
    })

    const result = retrieveContext(index, {
      question: 'Trace beginFlow through finishFlow.',
      budget: 4_000,
    })

    expect(result.outcome).not.toBe('evidence')
    expect(result.matched_nodes.some((node) =>
      node.label.includes('runTask')
      || node.label.includes('registerUnit')
      || node.label.includes('UnrelatedRegistry'))).toBe(false)
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
})
