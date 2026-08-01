import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildCanonicalTypeScriptIndex } from '../../src/adapters/typescript/index.js'
import { decodeIndexBodyFactTable } from '../../src/domain/index/model.js'

type GraphNode = Record<string, unknown>
type GraphEdge = readonly [string, string, Record<string, unknown>, string]
type BodyFact = Record<string, unknown> & {
  kind: string
}

const sandboxes: string[] = []

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

function build(
  sources: Record<string, string>,
  options: { reverse?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'madar-execution-hardening-'))
  sandboxes.push(root)
  const files = Object.entries(sources).map(([path, source]) => {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, source, 'utf8')
    return absolute
  })
  const result = buildCanonicalTypeScriptIndex({
    root,
    files: options.reverse ? files.reverse() : files,
  })
  return {
    result,
    nodes: new Map<string, GraphNode>(result.graph.nodeEntries()),
    edges: result.graph.edgeEntries() as GraphEdge[],
  }
}

function symbol(
  nodes: ReadonlyMap<string, GraphNode>,
  qualifiedName: string,
): readonly [string, GraphNode] {
  const entry = [...nodes].find(([, attributes]) =>
    attributes.qualified_name === qualifiedName)
  if (!entry) throw new Error(`Missing fixture symbol ${qualifiedName}`)
  return entry
}

function channels(
  nodes: ReadonlyMap<string, GraphNode>,
  predicate: (attributes: GraphNode) => boolean,
): Array<readonly [string, GraphNode]> {
  return [...nodes].filter(([, attributes]) =>
    attributes.node_kind === 'channel' && predicate(attributes))
}

function facts(
  nodes: ReadonlyMap<string, GraphNode>,
  [ownerId, attributes]: readonly [string, GraphNode],
  kind?: string,
): BodyFact[] {
  if (!Object.hasOwn(attributes, 'body_facts')) return []
  const sourceFile = attributes.source_file
  const file = typeof sourceFile === 'string'
    ? [...nodes].find(([, candidate]) =>
        candidate.node_kind === 'file'
        && candidate.source_file === sourceFile)
    : undefined
  if (!file) throw new Error(`Missing file node for ${ownerId}`)
  const decoded = decodeIndexBodyFactTable(
    attributes.body_facts,
    ownerId,
    file[0],
  )
  if (!decoded) throw new Error(`Invalid body-fact table for ${ownerId}`)
  const all = [...decoded] as BodyFact[]
  return kind ? all.filter((fact) => fact.kind === kind) : all
}

function hasEdge(
  edges: readonly GraphEdge[],
  from: string,
  to: string,
  relation: string,
): boolean {
  return edges.some(([source, target, attributes]) =>
    source === from
    && target === to
    && attributes.relation === relation)
}

function outgoing(
  edges: readonly GraphEdge[],
  from: string,
  relation: string,
): GraphEdge[] {
  return edges.filter(([source, , attributes]) =>
    source === from && attributes.relation === relation)
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
  ownerFacts: readonly BodyFact[],
  controllerId: string,
): Array<readonly [string, unknown]> {
  return ownerFacts.flatMap((fact) => {
    const control = Array.isArray(fact.control) ? fact.control : []
    return control.flatMap((rawFrame) => {
      const frame = rawFrame as Record<string, unknown>
      if (frame.kind !== 'branch'
        || frame.controller_fact_id !== controllerId) return []
      const value = decodeTypedCaseArm(frame.arm)
      return value ? [value] : []
    })
  })
}

describe('canonical TypeScript execution hardening', () => {
  it('resolves GoValidate-style Map-backed queue wrappers and inline worker delegates exactly', () => {
    const source = `import { Queue, Worker, type Job } from 'bullmq'

type AssemblyJobData = {
  ideaId: string
  trigger: 'section_complete' | 'assembly_complete'
}
const QUEUE_NAME = 'assembly-queue'
const JOB_NAME = 'assemble_report'

class QueueRegistryService {
  private readonly queues = new Map<string, Queue>()

  constructor() {
    this.queues.set(QUEUE_NAME, new Queue(QUEUE_NAME))
  }

  addJob(queueName: string, jobName: string, data: AssemblyJobData) {
    const queue = this.queues.get(queueName)
    if (!queue) throw new Error('Queue not registered')
    return queue.add(jobName, data)
  }

  registerWorker(
    queueName: string,
    processor: (job: Job<AssemblyJobData>) => Promise<void>,
  ) {
    return new Worker(queueName, processor)
  }
}

class AssemblyWorker {
  constructor(private readonly registry: QueueRegistryService) {}

  start() {
    return this.registry.registerWorker(
      'assembly-queue',
      (job) => this.process(job),
    )
  }

  async process(job: Job<AssemblyJobData>): Promise<void> {
    const { trigger } = job.data
    switch (trigger) {
      case 'section_complete':
        void job.data.ideaId
        return
      case 'assembly_complete':
        void job.data.ideaId
        return
    }
  }
}

export function dispatch(
  registry: QueueRegistryService,
  ideaId: string,
) {
  return registry.addJob(QUEUE_NAME, JOB_NAME, {
    ideaId,
    trigger: 'assembly_complete',
  })
}
`
    const { nodes, edges } = build({ 'src/queue-registry.ts': source })
    const queue = channels(nodes, (node) =>
      node.channel_kind === 'queue'
      && node.transport === 'bullmq'
      && node.key === 'assembly-queue')
    expect(queue).toHaveLength(1)
    const job = channels(nodes, (node) =>
      node.channel_kind === 'job'
      && node.transport === 'bullmq'
      && node.key === 'assemble_report'
      && node.parent_channel_id === queue[0]![0])
    expect(job).toHaveLength(1)

    const [dispatchId] = symbol(nodes, 'dispatch')
    const [processId] = symbol(nodes, 'AssemblyWorker.process')
    expect(hasEdge(edges, dispatchId, job[0]![0], 'publishes_to')).toBe(true)
    expect(hasEdge(edges, job[0]![0], queue[0]![0], 'routes_through')).toBe(true)
    expect(hasEdge(edges, queue[0]![0], processId, 'consumed_by')).toBe(true)
    expect(outgoing(edges, queue[0]![0], 'consumed_by')).toHaveLength(1)
    const publishEdges = outgoing(edges, dispatchId, 'publishes_to')
      .filter(([, target]) => target === job[0]![0])
    expect(publishEdges).toHaveLength(1)
    expect(publishEdges[0]![2]).toMatchObject({
      dispatch_payload_argument: 2,
    })

    const processFacts = facts(nodes, symbol(nodes, 'AssemblyWorker.process'))
    const condition = processFacts.find((fact) =>
      fact.kind === 'condition' && fact.condition_kind === 'switch')
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
      JSON.stringify(['string', 'section_complete']),
      JSON.stringify(['string', 'assembly_complete']),
    ]))
  })

  it('expands two wrapper hops but never joins cycles, dynamics, or unmatched channel halves', () => {
    const source = `import { Queue, Worker, type Job } from 'bullmq'

type Payload = { id: string }
const reports = new Queue<Payload>('reports')

function inner(queueName: string, jobName: string, data: Payload) {
  if (queueName !== 'reports') throw new Error('wrong queue')
  return reports.add(jobName, data)
}

function outer(queueName: string, jobName: string, data: Payload) {
  return inner(queueName, jobName, data)
}

export function publishThroughTwoHops(id: string) {
  return outer('reports', 'complete', { id })
}

function cycleA(queueName: string): unknown {
  return cycleB(queueName)
}

function cycleB(queueName: string): unknown {
  return cycleA(queueName)
}

export function publishCycle(queueName: string) {
  return cycleA(queueName)
}

export function publishDynamic(
  queue: Queue<Payload>,
  jobName: string,
  id: string,
) {
  return queue.add(jobName, { id })
}

export function publishOnly(id: string) {
  return new Queue<Payload>('producer-only').add('orphan', { id })
}

export async function consumeReports(job: Job<Payload>): Promise<void> {
  void job.data.id
}

export const reportWorker = new Worker<Payload>('reports', consumeReports)

export async function consumeOnly(job: Job<Payload>): Promise<void> {
  void job.data.id
}

export const consumerOnlyWorker =
  new Worker<Payload>('consumer-only', consumeOnly)
`
    const { nodes, edges } = build({ 'src/wrappers.ts': source })
    const reportQueue = channels(nodes, (node) =>
      node.channel_kind === 'queue'
      && node.transport === 'bullmq'
      && node.key === 'reports')
    expect(reportQueue).toHaveLength(1)
    const completeJob = channels(nodes, (node) =>
      node.channel_kind === 'job'
      && node.transport === 'bullmq'
      && node.key === 'complete'
      && node.parent_channel_id === reportQueue[0]![0])
    expect(completeJob).toHaveLength(1)

    const [successId] = symbol(nodes, 'publishThroughTwoHops')
    const [cycleId] = symbol(nodes, 'publishCycle')
    const [dynamicId] = symbol(nodes, 'publishDynamic')
    const [consumerId] = symbol(nodes, 'consumeReports')
    const [consumerOnlyId] = symbol(nodes, 'consumeOnly')

    expect(hasEdge(edges, successId, completeJob[0]![0], 'publishes_to')).toBe(true)
    expect(hasEdge(edges, reportQueue[0]![0], consumerId, 'consumed_by')).toBe(true)
    expect(outgoing(edges, cycleId, 'publishes_to')).toEqual([])
    expect(outgoing(edges, dynamicId, 'publishes_to')).toEqual([])
    expect(hasEdge(edges, reportQueue[0]![0], consumerOnlyId, 'consumed_by')).toBe(false)

    const producerOnly = channels(nodes, (node) =>
      node.channel_kind === 'queue' && node.key === 'producer-only')
    const consumerOnly = channels(nodes, (node) =>
      node.channel_kind === 'queue' && node.key === 'consumer-only')
    expect(producerOnly).toHaveLength(1)
    expect(consumerOnly).toHaveLength(1)
    expect(outgoing(edges, producerOnly[0]![0], 'consumed_by')).toEqual([])
    expect(hasEdge(edges, consumerOnly[0]![0], consumerOnlyId, 'consumed_by')).toBe(true)
    const publishEdges = outgoing(edges, successId, 'publishes_to')
      .filter(([, target]) => target === completeJob[0]![0])
    expect(publishEdges).toHaveLength(1)
    expect(publishEdges[0]![2]).toMatchObject({
      dispatch_payload_argument: 2,
    })
  })

  it('requires receiver proof for persistence and recognizes imported filesystem writes', () => {
    const source = `import type { MongoRepository } from 'typeorm'
import { writeFile } from 'node:fs/promises'

type Idea = { id: string; status: string }

class CoincidentalCache {
  update(id: string, value: unknown): void {
    void id
    void value
  }
}

export async function persistIdea(
  repository: MongoRepository<Idea>,
  id: string,
) {
  return repository.update(id, { status: 'complete' })
}

export function updateCache(cache: CoincidentalCache, id: string) {
  return cache.update(id, { status: 'complete' })
}

export async function persistArtifact(path: string, value: string) {
  await writeFile(path, value, 'utf8')
}

export async function persistConditionally(
  repository: MongoRepository<Idea>,
  id: string,
  enabled: boolean,
) {
  if (enabled) return repository.update(id, { status: 'complete' })
}

class TaskDelegate {
  update(id: string): void {
    void id
  }
}

export function coincidentalDelegate(delegate: TaskDelegate, id: string) {
  return delegate.update(id)
}
`
    const { nodes } = build({ 'src/persistence.ts': source })
    const persistIdea = facts(nodes, symbol(nodes, 'persistIdea'), 'persistence')
    const updateCache = facts(nodes, symbol(nodes, 'updateCache'), 'persistence')
    const persistArtifact = facts(nodes, symbol(nodes, 'persistArtifact'), 'persistence')
    const conditional = facts(
      nodes,
      symbol(nodes, 'persistConditionally'),
      'persistence',
    )
    const coincidentalDelegate = facts(
      nodes,
      symbol(nodes, 'coincidentalDelegate'),
      'persistence',
    )

    expect(persistIdea).toEqual([
      expect.objectContaining({
        kind: 'persistence',
        operation: 'update',
        call_fact_id: expect.any(String),
        receiver_type: expect.stringMatching(/MongoRepository/),
      }),
    ])
    expect(updateCache).toEqual([])
    expect(persistArtifact).toEqual([
      expect.objectContaining({
        kind: 'persistence',
        operation: 'file_write',
        call_fact_id: expect.any(String),
      }),
    ])
    expect(coincidentalDelegate).toEqual([])
    expect(conditional[0]?.control).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'branch', arm: 'then' }),
    ]))

    const callIds = new Set(facts(nodes, symbol(nodes, 'persistIdea'), 'call')
      .map((fact) => fact.id))
    expect(callIds.has(String(persistIdea[0]!.call_fact_id))).toBe(true)
  })

  it('scopes identical event keys by emitter identity and prevents cross-handler edges', () => {
    const source = `import { EventEmitter } from 'node:events'

const domainEvents = new EventEmitter()
const auditEvents = new EventEmitter()

export function emitDomain() {
  domainEvents.emit('ready', { kind: 'domain' })
}

export function emitAudit() {
  auditEvents.emit('ready', { kind: 'audit' })
}

export function onDomain(): void {}
export function onAudit(): void {}

export function wireDomain() {
  domainEvents.on('ready', onDomain)
}

export function wireAudit() {
  auditEvents.on('ready', onAudit)
}
`
    const { nodes, edges } = build({ 'src/events.ts': source })
    const ready = channels(nodes, (node) =>
      node.channel_kind === 'event'
      && node.transport === 'node-event-emitter'
      && node.key === 'ready')
    expect(ready).toHaveLength(2)
    expect(new Set(ready.map(([, node]) => node.scope)).size).toBe(2)

    const [emitDomain] = symbol(nodes, 'emitDomain')
    const [emitAudit] = symbol(nodes, 'emitAudit')
    const [onDomain] = symbol(nodes, 'onDomain')
    const [onAudit] = symbol(nodes, 'onAudit')
    const domainEvent = ready.find(([id]) =>
      hasEdge(edges, emitDomain, id, 'publishes_to'))
    const auditEvent = ready.find(([id]) =>
      hasEdge(edges, emitAudit, id, 'publishes_to'))
    expect(domainEvent).toBeDefined()
    expect(auditEvent).toBeDefined()
    expect(domainEvent?.[0]).not.toBe(auditEvent?.[0])
    expect(hasEdge(edges, domainEvent![0], onDomain, 'consumed_by')).toBe(true)
    expect(hasEdge(edges, domainEvent![0], onAudit, 'consumed_by')).toBe(false)
    expect(hasEdge(edges, auditEvent![0], onAudit, 'consumed_by')).toBe(true)
    expect(hasEdge(edges, auditEvent![0], onDomain, 'consumed_by')).toBe(false)
  })

  it('records Promise completion semantics and bounds secrets, long values, and nesting', () => {
    const longValue = 'x'.repeat(600)
    const unicodeKey = '😀'.repeat(200)
    const templateParts = Array.from(
      { length: 17 },
      (_, index) => '${value}part' + index,
    ).join('')
    const source = `export const SECRET_API_KEY = 'sk-test-never-expose'
export const LONG_TEXT = '${longValue}'
export const DEEP_VALUE = [[[[[[['too-deep']]]]]]]

export async function coordinate(tasks: Array<Promise<number>>) {
  const all = await Promise.all(tasks)
  const settled = await Promise.allSettled(tasks)
  const any = await Promise.any(tasks)
  const race = await Promise.race(tasks)
  return { all, settled, any, race }
}

declare function first(): Promise<number>
declare function second(): Promise<number>
declare function check(): boolean
declare function step(): void

export async function exactLanes() {
  return Promise.all([first(), second()])
}

export function repeatedCondition() {
  while (check()) step()
}

export function redactMutation(config: { password: string }) {
  config.password = 'hunter2'
}

export function jsonLosslessNumbers() {
  return [1e400, -0]
}

export function duplicateObject() {
  return { value: 1, value: 2 }
}

export function boundedLargeTemplate(value: string) {
  return \`head${templateParts}\`
}

export function boundedUnicodeMutation(record: Record<string, string>) {
  record['${unicodeKey}'] = 'safe'
}
`
    const { nodes } = build({ 'src/bounds.ts': source })
    expect(facts(nodes, symbol(nodes, 'coordinate'), 'parallel')).toEqual([])

    const secretJson = JSON.stringify(facts(nodes, symbol(nodes, 'SECRET_API_KEY')))
    const longJson = JSON.stringify(facts(nodes, symbol(nodes, 'LONG_TEXT')))
    const deepJson = JSON.stringify(facts(nodes, symbol(nodes, 'DEEP_VALUE')))
    expect(secretJson).not.toContain('sk-test-never-expose')
    expect(secretJson).toContain('"kind":"redacted"')
    expect(longJson).not.toContain(longValue)
    expect(longJson).toContain('"kind":"redacted"')
    expect(deepJson).not.toContain('too-deep')
    expect(deepJson).toContain('"kind":"unknown"')

    const laneCalls = facts(nodes, symbol(nodes, 'exactLanes'), 'call')
      .filter((fact) => ['first', 'second'].includes(String(fact.callee)))
    expect(laneCalls.map((fact) =>
      (fact.control as Array<Record<string, unknown>>)
        .find((frame) => frame.kind === 'parallel')?.lane)).toEqual([0, 1])

    const repeated = facts(nodes, symbol(nodes, 'repeatedCondition'), 'call')
    for (const fact of repeated) {
      expect(fact.control).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'loop' }),
      ]))
    }

    const mutationJson = JSON.stringify(
      facts(nodes, symbol(nodes, 'redactMutation'), 'mutation'),
    )
    expect(mutationJson).not.toContain('hunter2')
    expect(mutationJson).toContain('"kind":"redacted"')

    const numbers = JSON.stringify(
      facts(nodes, symbol(nodes, 'jsonLosslessNumbers'), 'return'),
    )
    expect(numbers.match(/"kind":"unknown"/g)).toHaveLength(2)

    const duplicate = facts(
      nodes,
      symbol(nodes, 'duplicateObject'),
      'return',
    )[0]?.value as { entries?: Array<{ value: { value?: unknown } }> }
    expect(duplicate.entries).toHaveLength(1)
    expect(duplicate.entries?.[0]?.value.value).toBe(2)

    const template = JSON.stringify(
      facts(nodes, symbol(nodes, 'boundedLargeTemplate'), 'return'),
    )
    expect(template).toContain('"kind":"unknown"')
    const unicodeMutation = facts(
      nodes,
      symbol(nodes, 'boundedUnicodeMutation'),
      'mutation',
    )[0]
    expect(Buffer.byteLength(String(unicodeMutation?.target), 'utf8'))
      .toBeLessThanOrEqual(256)
  })

  it('deduplicates structural routes and follows exact cross-file channels', () => {
    const sources = {
      'src/shared.ts': `import { EventEmitter } from 'node:events'
import { Queue } from 'bullmq'
export const reports = new Queue('reports')
export const events = new EventEmitter()
`,
      'src/publish.ts': `import { events, reports } from './shared.js'
export function publishOne() {
  reports.add('complete', { id: 1 })
  events.emit('ready', { id: 1 })
}
export function publishTwo() {
  return reports.add('complete', { id: 2 })
}
`,
    }
    const { nodes, edges } = build(sources)
    const queue = channels(nodes, (node) =>
      node.channel_kind === 'queue' && node.key === 'reports')
    const job = channels(nodes, (node) =>
      node.channel_kind === 'job'
      && node.key === 'complete'
      && node.parent_channel_id === queue[0]?.[0])
    const event = channels(nodes, (node) =>
      node.channel_kind === 'event' && node.key === 'ready')
    expect(queue).toHaveLength(1)
    expect(job).toHaveLength(1)
    expect(event).toHaveLength(1)
    expect(outgoing(edges, job[0]![0], 'routes_through')).toHaveLength(1)
    expect(hasEdge(
      edges,
      symbol(nodes, 'publishOne')[0],
      job[0]![0],
      'publishes_to',
    )).toBe(true)
    expect(hasEdge(
      edges,
      symbol(nodes, 'publishTwo')[0],
      job[0]![0],
      'publishes_to',
    )).toBe(true)
    expect(hasEdge(
      edges,
      symbol(nodes, 'publishOne')[0],
      event[0]![0],
      'publishes_to',
    )).toBe(true)
  })

  it('keeps guards, nullish flow, deferred closures, and shadowed globals exact', () => {
    const source = `import { Queue } from 'bullmq'
import type { Repository } from 'typeorm'

const reports = new Queue('reports')
const Promise = { all: (values: unknown[]) => values }
class FakeEventEmitter { emit(_event: string): void {} }
namespace Local {
  export class Repository<T> {
    update(_value: T): void {}
  }
}

declare function fallback(): string
declare function afterGuard(): void
declare function deadCode(): void

export function flow(value: string | null, enabled: boolean) {
  const selected = value ?? fallback()
  if (!enabled) return selected
  afterGuard()
  return selected
  deadCode()
}

export function returnedClosure() {
  return () => reports.add('deferred', {})
}

export function scheduled() {
  setTimeout(() => reports.add('scheduled', {}), 0)
}

export function dynamicJob(jobName: string) {
  return reports.add(jobName, {})
}

export function shadowedPromise(tasks: unknown[]) {
  return Promise.all(tasks.map((task) => task))
}

export class FakeService {
  constructor(
    private readonly events: FakeEventEmitter,
    private readonly repository: Local.Repository<string>,
    _realTypeOnly: Repository<string>,
  ) {}

  run(): void {
    this.events.emit('ready')
    this.repository.update('value')
  }
}
`
    const { nodes, edges } = build({ 'src/exactness.ts': source })
    const flow = facts(nodes, symbol(nodes, 'flow'))
    const fallbackCall = flow.find((fact) =>
      fact.kind === 'call' && fact.callee === 'fallback')
    expect(fallbackCall?.control).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'branch', arm: 'nullish' }),
    ]))
    const nullish = flow.find((fact) => fact.kind === 'condition'
      && fact.condition_kind === 'nullish')
    expect(nullish).toBeDefined()
    const guarded = flow.find((fact) =>
      fact.kind === 'call' && fact.callee === 'afterGuard')
    expect(guarded?.control).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'branch', arm: 'else' }),
    ]))
    expect(flow.some((fact) =>
      fact.kind === 'call' && fact.callee === 'deadCode')).toBe(false)
    for (const name of ['returnedClosure', 'scheduled']) {
      expect(outgoing(edges, symbol(nodes, name)[0], 'publishes_to')).toEqual([])
    }
    const reportQueue = channels(nodes, (node) =>
      node.channel_kind === 'queue' && node.key === 'reports')
    expect(reportQueue).toHaveLength(1)
    expect(hasEdge(
      edges,
      symbol(nodes, 'dynamicJob')[0],
      reportQueue[0]![0],
      'publishes_to',
    )).toBe(true)
    expect(channels(nodes, (node) =>
      node.channel_kind === 'job' && node.parent_channel_id === reportQueue[0]![0]))
      .toEqual([])
    expect(facts(nodes, symbol(nodes, 'shadowedPromise'), 'parallel')).toEqual([])
    expect(facts(nodes, symbol(nodes, 'FakeService.run'), 'persistence')).toEqual([])
    expect(channels(nodes, (node) =>
      node.channel_kind === 'event' && node.key === 'ready')).toEqual([])
  })

  it('redacts literal and comment trivia from every structural display field', () => {
    const secrets = [
      'sk-live-comment-secret',
      'sk-test-call-secret',
      'sk-test-target-secret',
      'sk-test-switch-secret',
    ]
    const source = `export function sensitive(
  client: (value: string) => { send(): void },
  target: Record<string, string>,
  value: string,
  code: string,
) {
  client/* ${secrets[0]} */('${secrets[1]}').send()
  target/* credential */['${secrets[2]}'] = value
  switch (code) {
    case '${secrets[3]}':
      return
  }
}
`
    const { result } = build({ 'src/secrets.ts': source })
    const serialized = JSON.stringify(result.graph.nodeEntries())
    for (const secret of secrets) expect(serialized).not.toContain(secret)
    expect(serialized).toContain('<literal>')
    expect(serialized).not.toContain('credential')
  })

  it('separates same-named Nest classes and Bull transports deterministically', () => {
    const sources = {
      'src/legacy.ts': `import { InjectQueue } from '@nestjs/bull'
import type { Queue } from 'bull'
export class WorkerService {
  constructor(@InjectQueue('reports') private readonly reports: Queue) {}
  publish() { return this.reports.add('legacy', {}) }
}
`,
      'src/modern.ts': `import { InjectQueue } from '@nestjs/bullmq'
import type { Queue } from 'bullmq'
export class WorkerService {
  constructor(@InjectQueue('reports') private readonly reports: Queue) {}
  publish() { return this.reports.add('modern', {}) }
}
`,
    }
    const forward = build(sources)
    const reverse = build(sources, { reverse: true })
    expect(reverse.result.graph.nodeEntries())
      .toEqual(forward.result.graph.nodeEntries())
    expect(reverse.result.graph.edgeEntries())
      .toEqual(forward.result.graph.edgeEntries())
    const queues = channels(forward.nodes, (node) =>
      node.channel_kind === 'queue' && node.key === 'reports')
    expect(queues.map(([, node]) => node.transport).sort())
      .toEqual(['bull', 'bullmq'])
    const jobs = channels(forward.nodes, (node) => node.channel_kind === 'job')
    expect(jobs.map(([, node]) => [node.key, node.transport]).sort())
      .toEqual([['legacy', 'bull'], ['modern', 'bullmq']])
  })

  it('marks owner overflow incomplete and projects no partial channel topology', () => {
    const calls = Array.from(
      { length: 8_193 },
      (_, index) => `  reports.add('job-${index}', {})`,
    ).join('\n')
    const source = `import { Queue } from 'bullmq'
const reports = new Queue('reports')
export function overflow() {
${calls}
}
`
    const { result, nodes, edges } = build({ 'src/overflow.ts': source })
    const [ownerId, owner] = symbol(nodes, 'overflow')
    expect(Object.hasOwn(owner, 'body_facts')).toBe(false)
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: 'error',
        id: expect.stringContaining('execution.owner-bound'),
      }),
    ]))
    expect(outgoing(edges, ownerId, 'publishes_to')).toEqual([])
  }, 60_000)

  it('is deterministic when the scanner enumerates execution files in reverse', () => {
    const sources = {
      'src/producer.ts': `import { Queue } from 'bullmq'
const queue = new Queue('reports')
export function publish() {
  return queue.add('complete', { id: 'report-1' })
}
`,
      'src/consumer.ts': `import { Worker, type Job } from 'bullmq'
type Payload = { id: string }
export async function consume(job: Job<Payload>) {
  void job.data.id
}
export const worker = new Worker<Payload>('reports', consume)
`,
    }
    const forward = build(sources)
    const reversed = build(sources, { reverse: true })

    expect(reversed.result.graph.nodeEntries())
      .toEqual(forward.result.graph.nodeEntries())
    expect(reversed.result.graph.edgeEntries())
      .toEqual(forward.result.graph.edgeEntries())
    expect(reversed.result.diagnostics).toEqual(forward.result.diagnostics)
  })
})
