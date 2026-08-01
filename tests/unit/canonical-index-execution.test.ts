import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildCanonicalTypeScriptIndex } from '../../src/adapters/typescript/index.js'
import { decodeIndexBodyFactTable } from '../../src/domain/index/model.js'

type Position = {
  line: number
  column: number
}

type Range = {
  start: Position
  end: Position
}

type BodyFact = {
  id: string
  owner_symbol_id: string
  order: readonly number[]
  kind: string
  evidence: {
    file_id: string
    range: Range
    statement_range: Range
    excerpt_sha256: string
  }
  control: ReadonlyArray<{ kind: string; [key: string]: unknown }>
  confidence: string
  source: string
  [key: string]: unknown
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function build(sources: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'madar-canonical-execution-'))
  roots.push(root)
  const files = Object.entries(sources).map(([path, source]) => {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, source, 'utf8')
    return absolute
  })
  const result = buildCanonicalTypeScriptIndex({ root, files })
  return {
    result,
    nodes: new Map(result.graph.nodeEntries()),
    edges: result.graph.edgeEntries(),
  }
}

function named(
  nodes: ReadonlyMap<string, Record<string, unknown>>,
  qualifiedName: string,
): [string, Record<string, unknown>] {
  const entry = [...nodes].find(([, attributes]) =>
    attributes.qualified_name === qualifiedName)
  if (!entry) throw new Error(`Missing fixture symbol ${qualifiedName}`)
  return entry
}

function bodyFacts(
  attributes: Record<string, unknown>,
  ownerId: string,
  fileId: string,
): BodyFact[] {
  if (!Object.hasOwn(attributes, 'body_facts')) return []
  const decoded = decodeIndexBodyFactTable(
    attributes.body_facts,
    ownerId,
    fileId,
  )
  if (!decoded) throw new Error(`Invalid body-fact table for ${ownerId}`)
  return [...decoded] as BodyFact[]
}

function comparePosition(left: Position, right: Position): number {
  return left.line - right.line || left.column - right.column
}

function compareOrder(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

function excerpt(source: string, range: Range): string {
  const lines = source.split('\n')
  const offset = (position: Position): number => {
    let value = 0
    for (let line = 1; line < position.line; line += 1) {
      value += (lines[line - 1]?.length ?? 0) + 1
    }
    return value + position.column - 1
  }
  return source.slice(offset(range.start), offset(range.end))
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function plainIndexValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainIndexValue)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if (record.kind === 'literal') return record.value
  if (record.kind === 'array' && Array.isArray(record.elements)) {
    return record.elements.map(plainIndexValue)
  }
  return value
}

function hasRelation(
  edges: ReturnType<typeof build>['edges'],
  from: string,
  to: string,
  relation: string,
): boolean {
  return edges.some(([source, target, attributes]) =>
    source === from
    && target === to
    && attributes.relation === relation)
}

function decodeTypedCaseArm(
  arm: unknown,
): readonly [string, unknown] | null {
  if (typeof arm !== 'string') return null
  const match = /^case:([A-Za-z0-9_-]+)$/u.exec(arm)
  if (!match) return null
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(match[1]!, 'base64url').toString('utf8'),
    )
    return Array.isArray(decoded)
      && decoded.length === 2
      && typeof decoded[0] === 'string'
      ? [decoded[0], decoded[1]]
      : null
  } catch {
    return null
  }
}

function typedCaseValues(
  facts: readonly BodyFact[],
  controllerId: string,
): Array<readonly [string, unknown]> {
  return facts.flatMap((fact) => fact.control.flatMap((frame) => {
    if (frame.kind !== 'branch'
      || frame.controller_fact_id !== controllerId) return []
    const value = decodeTypedCaseArm(frame.arm)
    return value ? [value] : []
  }))
}

describe('canonical TypeScript semantic execution facts', () => {
  it('stores selective authenticated facts with nested control and derivable Promise parallelism', () => {
    const source = `const METRIC_BATCHES = [
  ['desirability', 'viability', 'feasibility'],
  ['competition', 'impact', 'risk'],
] as const

function record(metric: string): void {
  void metric
}

function scoreMetricBatch(metrics: readonly string[]): number {
  return metrics.length
}

export async function assemble(enabled: boolean) {
  const unusedHumanNote = 'do-not-index-unused-local'
  if (!enabled) return 'skipped'

  for (const metric of METRIC_BATCHES[0]) {
    record(metric)
  }

  const settled = await Promise.allSettled(
    METRIC_BATCHES.map((metrics) => scoreMetricBatch(metrics)),
  )
  return settled
}
`
    const { nodes } = build({ 'src/execution.ts': source })
    const [assembleId, assembleNode] = named(nodes, 'assemble')
    const [batchesId, batchesNode] = named(nodes, 'METRIC_BATCHES')
    const file = [...nodes].find(([, attributes]) =>
      attributes.node_kind === 'file'
      && attributes.source_file === 'src/execution.ts')
    if (!file) throw new Error('Missing fixture file node src/execution.ts')
    const facts = bodyFacts(assembleNode, assembleId, file[0])
    const batchFacts = bodyFacts(batchesNode, batchesId, file[0])

    expect(facts).not.toEqual([])
    expect(batchFacts).not.toEqual([])
    expect(facts.map((fact) => fact.kind)).toEqual(expect.arrayContaining([
      'call',
      'condition',
      'loop',
      'parallel',
      'return',
    ]))
    expect(batchFacts.map((fact) => fact.kind)).toContain('literal')

    const allFacts = [...facts, ...batchFacts]
    for (const fact of allFacts) {
      expect(fact.owner_symbol_id).toBe(
        facts.includes(fact) ? assembleId : batchesId,
      )
      expect(fact.order.length).toBeGreaterThan(0)
      expect(fact.order.every((part) =>
        Number.isSafeInteger(part) && part >= 0)).toBe(true)
      expect(fact.evidence).toMatchObject({
        file_id: file?.[0],
        range: {
          start: { line: expect.any(Number), column: expect.any(Number) },
          end: { line: expect.any(Number), column: expect.any(Number) },
        },
        statement_range: {
          start: { line: expect.any(Number), column: expect.any(Number) },
          end: { line: expect.any(Number), column: expect.any(Number) },
        },
        excerpt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      expect(comparePosition(
        fact.evidence.statement_range.start,
        fact.evidence.range.start,
      )).toBeLessThanOrEqual(0)
      expect(comparePosition(
        fact.evidence.range.end,
        fact.evidence.statement_range.end,
      )).toBeLessThanOrEqual(0)
      expect(fact.evidence.excerpt_sha256).toBe(
        sha256(excerpt(source, fact.evidence.statement_range)),
      )
    }

    expect(facts.map((fact) => fact.order)).toEqual(
      [...facts.map((fact) => fact.order)].sort(compareOrder),
    )
    expect(new Set(facts.map((fact) => JSON.stringify(fact.order))).size)
      .toBe(facts.length)

    const skippedReturn = facts.find((fact) =>
      fact.kind === 'return' && JSON.stringify(fact).includes('skipped'))
    expect(skippedReturn?.control).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'branch' }),
    ]))

    const loopCall = facts.find((fact) =>
      fact.kind === 'call' && JSON.stringify(fact).includes('record'))
    expect(loopCall?.control).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'loop' }),
    ]))

    const parallel = facts.find((fact) => fact.kind === 'parallel')
    expect(parallel).toMatchObject({
      combinator: 'allSettled',
      completion: 'all_settled',
      lane_count: 2,
    })
    expect(parallel?.kind === 'parallel' && parallel.input
      ? plainIndexValue(parallel.input)
      : null).toEqual([
      ['desirability', 'viability', 'feasibility'],
      ['competition', 'impact', 'risk'],
    ])

    const groupedCall = facts.find((fact) =>
      fact.kind === 'call'
      && fact.callee === 'scoreMetricBatch')
    expect(groupedCall?.control).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'loop' }),
      expect.objectContaining({ kind: 'parallel', lane: 'each' }),
    ]))
    const groupedArguments = groupedCall?.arguments as unknown[] | undefined
    expect(groupedCall?.kind === 'call' && groupedArguments
      ? plainIndexValue(groupedArguments[0]!)
      : null).toEqual({
      kind: 'parameter',
      position: 0,
      scope: 'iteration',
    })
    expect(parallel?.kind === 'parallel'
      ? parallel.member_fact_ids
      : []).toEqual([groupedCall?.id])

    const structuredBatches = batchFacts
      .filter((fact) => fact.kind === 'literal')
      .map((fact) => plainIndexValue(fact.value))
      .find((value) => Array.isArray(value))
    expect(structuredBatches).toEqual([
      ['desirability', 'viability', 'feasibility'],
      ['competition', 'impact', 'risk'],
    ])
    expect(JSON.stringify(allFacts)).not.toContain('do-not-index-unused-local')
  })

  it('connects only exact queue/job/event producers and consumers through shared channels', () => {
    const source = `import { EventEmitter } from 'node:events'
import { Queue, Worker } from 'bullmq'

type ReportJob = { id: string }

class QueueRegistry {
  addJob(queueName: string, jobName: string, data: ReportJob) {
    return new Queue(queueName).add(jobName, data)
  }

  registerWorker(
    queueName: string,
    processor: (job: { data: ReportJob }) => Promise<void>,
  ) {
    return new Worker(queueName, processor)
  }
}

const registry = new QueueRegistry()
const events = new EventEmitter()

export function publishReport() {
  return registry.addJob('reports', 'complete', { id: 'report-1' })
}

export async function consumeReport(job: { data: ReportJob }) {
  void job.data.id
}

export function wireReport() {
  return registry.registerWorker('reports', consumeReport)
}

export async function consumeOther(job: { data: ReportJob }) {
  void job.data.id
}

export function wireOther() {
  return registry.registerWorker('other', consumeOther)
}

export function publishDynamic(queueName: string) {
  return registry.addJob(queueName, 'complete', { id: 'report-2' })
}

export function emitReady() {
  events.emit('report.ready', { id: 'report-1' })
}

export function handleReady(): void {}

export function wireReady() {
  events.on('report.ready', handleReady)
}

export function handleFailed(): void {}

export function wireFailed() {
  events.on('report.failed', handleFailed)
}

export function emitDynamic(eventName: string) {
  events.emit(eventName, { id: 'report-2' })
}
`
    const { nodes, edges } = build({ 'src/channels.ts': source })
    const channels = [...nodes].filter(([, attributes]) =>
      attributes.node_kind === 'channel')
    const reportQueue = channels.find(([, attributes]) =>
      attributes.channel_kind === 'queue'
      && attributes.transport === 'bullmq'
      && attributes.key === 'reports')
    const otherQueue = channels.find(([, attributes]) =>
      attributes.channel_kind === 'queue'
      && attributes.transport === 'bullmq'
      && attributes.key === 'other')
    const reportJob = channels.find(([, attributes]) =>
      attributes.channel_kind === 'job'
      && attributes.transport === 'bullmq'
      && attributes.key === 'complete'
      && attributes.parent_channel_id === reportQueue?.[0])
    const readyEvent = channels.find(([, attributes]) =>
      attributes.channel_kind === 'event'
      && attributes.transport === 'node-event-emitter'
      && attributes.key === 'report.ready')
    const failedEvent = channels.find(([, attributes]) =>
      attributes.channel_kind === 'event'
      && attributes.transport === 'node-event-emitter'
      && attributes.key === 'report.failed')

    expect(reportQueue).toBeDefined()
    expect(otherQueue).toBeDefined()
    expect(reportJob).toBeDefined()
    expect(readyEvent).toBeDefined()
    expect(failedEvent).toBeDefined()

    const [publishReport] = named(nodes, 'publishReport')
    const [consumeReport] = named(nodes, 'consumeReport')
    const [consumeOther] = named(nodes, 'consumeOther')
    const [publishDynamic] = named(nodes, 'publishDynamic')
    const [emitReady] = named(nodes, 'emitReady')
    const [handleReady] = named(nodes, 'handleReady')
    const [handleFailed] = named(nodes, 'handleFailed')
    const [emitDynamic] = named(nodes, 'emitDynamic')

    expect(hasRelation(edges, publishReport, reportJob![0], 'publishes_to')).toBe(true)
    expect(hasRelation(edges, reportJob![0], reportQueue![0], 'routes_through')).toBe(true)
    expect(hasRelation(edges, reportQueue![0], consumeReport, 'consumed_by')).toBe(true)
    expect(hasRelation(edges, otherQueue![0], consumeOther, 'consumed_by')).toBe(true)
    expect(hasRelation(edges, reportQueue![0], consumeOther, 'consumed_by')).toBe(false)
    expect(hasRelation(edges, otherQueue![0], consumeReport, 'consumed_by')).toBe(false)

    expect(hasRelation(edges, emitReady, readyEvent![0], 'publishes_to')).toBe(true)
    expect(hasRelation(edges, readyEvent![0], handleReady, 'consumed_by')).toBe(true)
    expect(hasRelation(edges, readyEvent![0], handleFailed, 'consumed_by')).toBe(false)
    expect(hasRelation(edges, failedEvent![0], handleFailed, 'consumed_by')).toBe(true)

    expect(edges.some(([source, , attributes]) =>
      source === publishDynamic
      && attributes.relation === 'publishes_to')).toBe(false)
    expect(edges.some(([source, , attributes]) =>
      source === emitDynamic
      && attributes.relation === 'publishes_to')).toBe(false)
  })

  it('binds an exact Bull payload argument to typed consumer switch cases', () => {
    const source = `import { Queue, Worker } from 'bullmq'

type SyncJob = { trigger: 'complete' | 'progress' | 1 }
const queue = new Queue<SyncJob>('sync')

export function dispatch(): Promise<unknown> {
  return queue.add('persist', { trigger: 'complete' })
}

export async function process(job: { data: SyncJob }): Promise<void> {
  switch (job.data.trigger) {
    case 'complete':
      return
    case 'progress':
      return
    case 1:
      return
  }
}

export const worker = new Worker<SyncJob>('sync', process)
`
    const { nodes, edges } = build({ 'src/discriminator.ts': source })
    const file = [...nodes].find(([, attributes]) =>
      attributes.node_kind === 'file'
      && attributes.source_file === 'src/discriminator.ts')
    if (!file) throw new Error('Missing fixture file node src/discriminator.ts')
    const [dispatchId] = named(nodes, 'dispatch')
    const [processId, processNode] = named(nodes, 'process')
    const processFacts = bodyFacts(processNode, processId, file[0])
    const condition = processFacts.find((fact) =>
      fact.kind === 'condition' && fact.condition_kind === 'switch')

    const publishEdges = edges.filter(([source, , attributes]) =>
      source === dispatchId && attributes.relation === 'publishes_to')
    expect(publishEdges).toHaveLength(1)
    expect(publishEdges[0]![2]).toMatchObject({
      dispatch_payload_argument: 1,
    })
    expect(condition?.test).toEqual({
      kind: 'template',
      parts: [
        { kind: 'parameter', position: 0 },
        { kind: 'literal', value: 'data' },
        { kind: 'literal', value: 'trigger' },
      ],
    })
    expect(new Set(typedCaseValues(processFacts, String(condition?.id))
      .map((value) => JSON.stringify(value)))).toEqual(new Set([
      JSON.stringify(['string', 'complete']),
      JSON.stringify(['string', 'progress']),
      JSON.stringify(['number', 1]),
    ]))
  })
})
