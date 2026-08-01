import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildCanonicalTypeScriptIndex } from '../../src/adapters/typescript/index.js'
import { loadGraphArtifact } from '../../src/adapters/filesystem/graph-artifact.js'
import { generateIndex } from '../../src/application/generate-index.js'
import {
  decodeIndexBodyFactTable,
  type IndexBodyFact,
} from '../../src/domain/index/model.js'
import { inspectQueryIndex } from '../../src/domain/query/index-status.js'

type NodeAttributes = Record<string, unknown>
type Edge = readonly [string, string, Record<string, unknown>, string]

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function build(sources: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'madar-execution-review-'))
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
    root,
    nodes: new Map<string, NodeAttributes>(result.graph.nodeEntries()),
    edges: result.graph.edgeEntries() as Edge[],
  }
}

function symbol(
  nodes: ReadonlyMap<string, NodeAttributes>,
  qualifiedName: string,
): readonly [string, NodeAttributes] {
  const entry = [...nodes].find(([, attributes]) =>
    attributes.qualified_name === qualifiedName)
  if (!entry) throw new Error(`Missing fixture symbol ${qualifiedName}`)
  return entry
}

function facts(
  nodes: ReadonlyMap<string, NodeAttributes>,
  entry: readonly [string, NodeAttributes],
  kind?: IndexBodyFact['kind'],
): IndexBodyFact[] {
  const [ownerId, attributes] = entry
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
  return kind
    ? [...decoded].filter((fact) => fact.kind === kind)
    : [...decoded]
}

function channels(
  nodes: ReadonlyMap<string, NodeAttributes>,
  predicate: (attributes: NodeAttributes) => boolean,
): Array<readonly [string, NodeAttributes]> {
  return [...nodes].filter(([, attributes]) =>
    attributes.node_kind === 'channel' && predicate(attributes))
}

function outgoing(
  edges: readonly Edge[],
  from: string,
  relation: string,
): Edge[] {
  return edges.filter(([source, , attributes]) =>
    source === from && attributes.relation === relation)
}

function hasEdge(
  edges: readonly Edge[],
  from: string,
  to: string,
  relation: string,
): boolean {
  return edges.some(([source, target, attributes]) =>
    source === from
    && target === to
    && attributes.relation === relation)
}

function publishedQueueKeys(
  nodes: ReadonlyMap<string, NodeAttributes>,
  edges: readonly Edge[],
  ownerId: string,
): string[] {
  const byId = nodes
  return outgoing(edges, ownerId, 'publishes_to').flatMap(([, target]) => {
    const endpoint = byId.get(target)
    if (endpoint?.channel_kind === 'queue') return [String(endpoint.key)]
    if (endpoint?.channel_kind !== 'job'
      || typeof endpoint.parent_channel_id !== 'string') return []
    const queue = byId.get(endpoint.parent_channel_id)
    return queue?.channel_kind === 'queue' ? [String(queue.key)] : []
  })
}

describe('canonical execution independent-review regressions', () => {
  it('does not attribute binary-assigned deferred closures to their enclosing method', () => {
    const source = `declare function persist(job: string): void
export class Worker {
  handler?: (job: string) => void
  install(): void {
    this.handler = (job) => persist(job)
  }
}
`
    const { nodes } = build({ 'src/deferred-property.ts': source })
    const calls = facts(nodes, symbol(nodes, 'Worker.install'), 'call')
    expect(calls.filter((fact) =>
      fact.kind === 'call' && fact.callee === 'persist')).toEqual([])
  })

  it('keeps unsupported Promise arrays queryable and their direct calls unscoped', () => {
    const oversized = Array.from(
      { length: 33 },
      (_, index) => `task(${index + 4})`,
    ).join(', ')
    const source = `declare function task(id: number): Promise<number>

export async function coordinate(tasks: Promise<number>[]) {
  const omitted = await Promise.all([task(0), , task(1)])
  const spread = await Promise.all([task(2), ...tasks, task(3)])
  const oversized = await Promise.all([${oversized}])
  return { omitted, spread, oversized }
}
`
    const built = build({ 'src/parallel.ts': source })
    const graph = loadGraphArtifact(generateIndex(built.root).graphPath)
    const nodes = new Map<string, NodeAttributes>(graph.nodeEntries())
    expect(inspectQueryIndex(graph)).toEqual(
      expect.objectContaining({ state: 'ready' }),
    )

    const ownerFacts = facts(nodes, symbol(nodes, 'coordinate'))
    const direct = ownerFacts.filter((fact) =>
      fact.kind === 'call' && fact.callee === 'task')
    expect(direct).toHaveLength(37)
    expect(direct.every((fact) =>
      fact.control.every((frame) => frame.kind !== 'parallel'))).toBe(true)

    const parallel = ownerFacts.filter((fact) => fact.kind === 'parallel')
    expect(parallel).toEqual([])
  })

  it('records mutation methods only for proven arrays, not custom stacks', () => {
    const source = `class Stack {
  push(_value: number): void {}
  pop(): number | undefined { return undefined }
  splice(_start: number, _count: number): void {}
}

export function mutateStack(stack: Stack) {
  stack.push(1)
  stack.pop()
  stack.splice(0, 1)
}

export function mutateArray(values: number[]) {
  values.push(1)
  values.pop()
  values.splice(0, 1)
}
`
    const { nodes } = build({ 'src/mutations.ts': source })
    expect(facts(nodes, symbol(nodes, 'mutateStack'), 'mutation')).toEqual([])
    expect(facts(nodes, symbol(nodes, 'mutateArray'), 'mutation')
      .map((fact) => fact.kind === 'mutation' ? fact.operation : null))
      .toEqual(['append', 'remove', 'remove'])
  })

  it('keeps switch arms distinct and omits calls after abrupt arm exits', () => {
    const source = `declare function first(): void
declare function second(): void
declare function fallback(): void
declare function deadAfterBreak(): void
declare function deadAfterReturn(): void
declare function deadAfterThrow(): void

export function choose(code: number): void {
  switch (code) {
    case 1:
      first()
      break
      deadAfterBreak()
    case 2:
      second()
      return
      deadAfterReturn()
    default:
      fallback()
      throw new Error('stop')
      deadAfterThrow()
  }
}
`
    const { nodes } = build({ 'src/switch.ts': source })
    const calls = facts(nodes, symbol(nodes, 'choose'), 'call')
    const byName = new Map(calls
      .filter((fact) => fact.kind === 'call')
      .map((fact) => [fact.callee, fact]))
    for (const dead of [
      'deadAfterBreak',
      'deadAfterReturn',
      'deadAfterThrow',
    ]) {
      expect(byName.has(dead)).toBe(false)
    }
    const arm = (name: string): string | undefined =>
      byName.get(name)?.control.find((frame) =>
        frame.kind === 'branch')?.kind === 'branch'
        ? (byName.get(name)!.control.find((frame) =>
            frame.kind === 'branch') as { arm: string }).arm
        : undefined
    expect(arm('first')).toBeDefined()
    expect(arm('second')).toBeDefined()
    expect(arm('first')).not.toBe(arm('second'))
  })

  it('stops loop blocks at break/continue and controls conditional fallthrough', () => {
    const source = `declare function beforeContinue(): void
declare function deadAfterContinue(): void
declare function beforeBreak(): void
declare function deadAfterBreak(): void
declare function afterConditionalContinue(): void
declare function afterConditionalBreak(): void

export function loops(flag: boolean): void {
  for (let index = 0; index < 1; index += 1) {
    beforeContinue()
    continue
    deadAfterContinue()
  }
  while (flag) {
    beforeBreak()
    break
    deadAfterBreak()
  }
  for (let index = 0; index < 1; index += 1) {
    if (flag) continue
    afterConditionalContinue()
  }
  while (flag) {
    if (flag) break
    afterConditionalBreak()
    break
  }
}
`
    const { nodes } = build({ 'src/loops.ts': source })
    const calls = facts(nodes, symbol(nodes, 'loops'), 'call')
    const byName = new Map(calls
      .filter((fact) => fact.kind === 'call')
      .map((fact) => [fact.callee, fact]))
    expect(byName.has('deadAfterContinue')).toBe(false)
    expect(byName.has('deadAfterBreak')).toBe(false)
    for (const name of [
      'afterConditionalContinue',
      'afterConditionalBreak',
    ]) {
      expect(byName.get(name)?.control).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'loop' }),
        expect.objectContaining({ kind: 'branch', arm: 'else' }),
      ]))
    }
  })

  it('does not execute an uninvoked nested function declaration', () => {
    const source = `import { Queue } from 'bullmq'
const reports = new Queue('reports')
declare function hiddenWork(): void

export function outer(): number {
  function hidden(): void {
    hiddenWork()
    reports.add('hidden', {})
  }
  return 1
}
`
    const { nodes, edges } = build({ 'src/nested.ts': source })
    const outer = symbol(nodes, 'outer')
    expect(facts(nodes, outer, 'call')
      .some((fact) => fact.kind === 'call'
        && fact.callee === 'hiddenWork')).toBe(false)
    expect(outgoing(edges, outer[0], 'publishes_to')).toEqual([])
  })

  it('classifies bare calls from their return type', () => {
    const source = `function syncWork(): number { return 1 }
async function asyncWork(): Promise<number> { return 1 }
function thenableWork(): PromiseLike<number> {
  return { then: () => Promise.resolve(1) } as PromiseLike<number>
}

export function schedule(): void {
  syncWork()
  asyncWork()
  thenableWork()
}
`
    const { nodes } = build({ 'src/scheduling.ts': source })
    const scheduling = new Map(
      facts(nodes, symbol(nodes, 'schedule'), 'call')
        .filter((fact) => fact.kind === 'call')
        .map((fact) => [fact.callee, fact.scheduling]),
    )
    expect(scheduling.get('syncWork')).toBe('sync')
    expect(scheduling.get('asyncWork')).toBe('fire_and_forget')
    expect(scheduling.get('thenableWork')).toBe('fire_and_forget')
  })

  it('does not reuse stale literal or Queue bindings as exact channels', () => {
    const source = `import { Queue } from 'bullmq'

export function reassignedName() {
  let queueName = 'reports'
  queueName = 'audit'
  const queue = new Queue(queueName)
  return queue.add('complete', {})
}

export function reassignedQueue(dynamicName: string) {
  let queue = new Queue('reports')
  queue = new Queue(dynamicName)
  return queue.add('complete', {})
}
`
    const { nodes, edges } = build({ 'src/reassignment.ts': source })
    for (const name of ['reassignedName', 'reassignedQueue']) {
      expect(publishedQueueKeys(nodes, edges, symbol(nodes, name)[0]))
        .not.toContain('reports')
    }
  })

  it('never joins separate local EventEmitter instances', () => {
    const source = `import { EventEmitter } from 'node:events'
export function handle(): void {}

export function localEmitters(): void {
  const producer = new EventEmitter()
  const consumer = new EventEmitter()
  producer.emit('ready')
  consumer.on('ready', handle)
}
`
    const { nodes, edges } = build({ 'src/local-events.ts': source })
    const ready = channels(nodes, (node) =>
      node.channel_kind === 'event' && node.key === 'ready')
    expect(ready).toHaveLength(2)
    const ownerId = symbol(nodes, 'localEmitters')[0]
    const handlerId = symbol(nodes, 'handle')[0]
    const emitted = ready.find(([id]) =>
      hasEdge(edges, ownerId, id, 'publishes_to'))
    const consumed = ready.find(([id]) =>
      hasEdge(edges, id, handlerId, 'consumed_by'))
    expect(emitted).toBeDefined()
    expect(consumed).toBeDefined()
    expect(emitted?.[0]).not.toBe(consumed?.[0])
    expect(hasEdge(edges, emitted![0], handlerId, 'consumed_by')).toBe(false)
  })

  it('accepts only direct inline consumers and preserves zero-argument events', () => {
    const source = `import { EventEmitter } from 'node:events'
import { Worker, type Job } from 'bullmq'
type Payload = { ready: boolean }

export async function handle(
  _job: Job<Payload>,
  _side?: unknown,
): Promise<void> {}
export async function first(job: Job<Payload>): Promise<void> {
  return handle(job)
}
export async function second(job: Job<Payload>): Promise<void> {
  return handle(job)
}
export class Handler {
  process(job: Job<Payload>): Promise<void> { return handle(job) }
}
export class AlternateHandler {
  process(job: Job<Payload>): Promise<void> { return second(job) }
}
export function handleEvent(..._args: unknown[]): void {}
declare function mutateJob(job: Job<Payload>): unknown
declare function explode(): never
declare const flag: boolean

export const directWorker = new Worker<Payload>('direct', (job) => handle(job))
export const returnedWorker = new Worker<Payload>('returned', (job) => { return handle(job) })
export const awaitedWorker = new Worker<Payload>('awaited', async (job) => await handle(job))
export const voidedWorker = new Worker<Payload>('voided', (job) => { void handle(job) })
export const pureLaterWorker = new Worker<Payload>('pure-later',
  (job) => handle(job, 42))
export const typeofLaterWorker = new Worker<Payload>('typeof-later',
  (job) => handle(job, typeof job))
export const equalityLaterWorker = new Worker<Payload>('equality-later',
  (job) => handle(job, job === fakeJob))
export const voidLaterWorker = new Worker<Payload>('void-later',
  (job) => handle(job, void job))
export const missingVoidWorker = new Worker<Payload>('missing-void',
  (job) => handle(job, void missingName))
export const sideEffectWorker = new Worker<Payload>('side-effect',
  (job) => handle(job, mutateJob(job)))
declare const maybeHandler: typeof handle | undefined
export const optionalReceiverWorker = new Worker<Payload>('optional-receiver',
  (job) => maybeHandler?.(job))
declare const maybeOwner: Handler | undefined
declare const deep: { box?: { handler: Handler } }
export const optionalElementWorker = new Worker<Payload>('optional-element',
  (job) => maybeOwner?.['process'](job))
export const nestedOptionalWorker = new Worker<Payload>('nested-optional',
  (job) => deep.box?.handler.process(job))
export const conditionalTargetWorker = new Worker<Payload>('conditional-target',
  (job) => (flag ? first : second)(job))
const chosen = flag ? first : second
export const aliasedConditionalWorker = new Worker<Payload>('aliased-conditional',
  (job) => chosen(job))
const directAlias = first
export const directAliasWorker = new Worker<Payload>('direct-alias',
  (job) => directAlias(job))
const stableService = new Handler()
export const stableReceiverWorker = new Worker<Payload>('stable-receiver',
  (job) => stableService.process(job))
export const directNewReceiverWorker = new Worker<Payload>('direct-new-receiver',
  (job) => new Handler().process(job))
const proxiedService: Handler = new Proxy(new Handler(), {
  get: () => second,
})
export const proxiedReceiverWorker = new Worker<Payload>('proxied-receiver',
  (job) => proxiedService.process(job))
const objectPrototypeService = new Handler()
Object.setPrototypeOf(objectPrototypeService, { process: second })
export const objectPrototypeWorker = new Worker<Payload>('object-prototype',
  (job) => objectPrototypeService.process(job))
const reflectPrototypeService = new Handler()
Reflect.setPrototypeOf(reflectPrototypeService, { process: second })
export const reflectPrototypeWorker = new Worker<Payload>('reflect-prototype',
  (job) => reflectPrototypeService.process(job))
let mutableService: Handler | AlternateHandler = new Handler()
mutableService = new AlternateHandler()
export const mutableReceiverWorker = new Worker<Payload>('mutable-receiver',
  (job) => mutableService.process(job))
const unionService: Handler | AlternateHandler =
  flag ? new Handler() : new AlternateHandler()
export const unionReceiverWorker = new Worker<Payload>('union-receiver',
  (job) => unionService.process(job))
class SelectingHandler {
  get selected(): typeof first { return flag ? first : second }
}
const selectingHandler = new SelectingHandler()
export const getterTargetWorker = new Worker<Payload>('getter-target',
  (job) => selectingHandler.selected(job))
function makeWorker(
  name: string,
  handler: (job: Job<Payload>) => Promise<void>,
) {
  return new Worker<Payload>(name, (job) => handler(job))
}
export const parameterForwardWorker =
  makeWorker('parameter-forward', first)
export const throwingLaterWorker = new Worker<Payload>('throwing-later',
  (job) => handle(job, explode()))
export const conditionalWorker = new Worker<Payload>('conditional', (job) =>
  job.data.ready ? handle(job) : Promise.resolve())
export const guardedWorker = new Worker<Payload>('guarded', (job) => {
  if (job.data.ready) return handle(job)
})
export const deadTailWorker = new Worker<Payload>('dead-tail', (job) => {
  handle(job)
  return handle(job)
})
export const wrongArgumentWorker = new Worker<Payload>('wrong-argument',
  (job, other) => handle(other as Job<Payload>))

function registerWorker(
  name: string,
  handler: (job: Job<Payload>) => Promise<void>,
) {
  return new Worker<Payload>(name, handler)
}
declare const fakeJob: Job<Payload>
export const wrappedDirect = registerWorker('wrapped-direct', (job) => handle(job))
export const wrappedWrong = registerWorker('wrapped-wrong', (_job) => handle(fakeJob))
export const wrappedConditional = registerWorker('wrapped-conditional', (job) =>
  job.data.ready ? handle(job) : Promise.resolve())
export const wrappedDeadTail = registerWorker('wrapped-dead-tail', (job) => {
  handle(job)
  return handle(job)
})

const events = new EventEmitter()
function registerEvent(name: string, handler: () => void) {
  return events.on(name, handler)
}
export const wrappedEvent =
  registerEvent('wrapped-event', () => handleEvent())
export const wrappedConditionalEvent =
  registerEvent('wrapped-conditional-event', () => true && handleEvent())
export const readyListener = events.on('ready', () => handleEvent())
export const explodingListener = events.on('exploding',
  (event) => handleEvent(event, explode()))
export const conditionalListener = events.on('conditional', () => true && handleEvent())
`
    const { nodes, edges } = build({ 'src/inline-consumers.ts': source })
    const handlerId = symbol(nodes, 'handle')[0]
    const eventHandlerId = symbol(nodes, 'handleEvent')[0]
    const consumes = (key: string, target: string) => channels(nodes, (node) =>
      node.key === key).some(([id]) => hasEdge(edges, id, target, 'consumed_by'))
    const hasConsumer = (key: string) => channels(nodes, (node) =>
      node.key === key).some(([id]) => edges.some(([from, , attributes]) =>
        from === id && attributes.relation === 'consumed_by'))

    for (const key of [
      'direct', 'returned', 'awaited', 'voided', 'pure-later',
      'typeof-later', 'equality-later', 'void-later',
      'wrapped-direct',
    ])
      expect(consumes(key, handlerId), key).toBe(true)
    expect(consumes(
      'stable-receiver',
      symbol(nodes, 'Handler.process')[0],
    )).toBe(true)
    for (const key of [
      'conditional',
      'guarded',
      'dead-tail',
      'side-effect',
      'optional-receiver',
      'wrong-argument',
      'wrapped-wrong',
      'wrapped-conditional',
      'wrapped-dead-tail',
    ]) expect(consumes(key, handlerId)).toBe(false)
    for (const key of [
      'optional-element',
      'nested-optional',
      'conditional-target',
      'aliased-conditional',
      'throwing-later',
      'missing-void',
      'mutable-receiver',
      'union-receiver',
      'getter-target',
      'direct-alias',
      'parameter-forward',
      'direct-new-receiver',
      'proxied-receiver',
      'object-prototype',
      'reflect-prototype',
    ]) expect(hasConsumer(key), key).toBe(false)
    expect(consumes('ready', eventHandlerId)).toBe(true)
    expect(hasConsumer('exploding')).toBe(false)
    expect(consumes('wrapped-event', eventHandlerId)).toBe(true)
    expect(consumes('conditional', eventHandlerId)).toBe(false)
    expect(consumes('wrapped-conditional-event', eventHandlerId)).toBe(false)
  })

  it('uses proven Map values for queues instead of assuming the lookup key', () => {
    const source = `import { Queue } from 'bullmq'
const queues = new Map<string, Queue>()
const alias = 'alias'
const real = 'real'
queues.set(alias, new Queue(real))

const registry = new Map<string, Queue>()
const registryKey = 'reports'
registry.set(registryKey, new Queue(registryKey))

export function fromAlias() {
  return queues.get(alias)!.add('complete', {})
}

export function fromProvenRegistry() {
  return registry.get(registryKey)!.add('complete', {})
}
`
    const { nodes, edges } = build({ 'src/map-queues.ts': source })
    expect(publishedQueueKeys(
      nodes,
      edges,
      symbol(nodes, 'fromAlias')[0],
    )).toEqual(['real'])
    expect(publishedQueueKeys(
      nodes,
      edges,
      symbol(nodes, 'fromProvenRegistry')[0],
    )).toEqual(['reports'])
  })

  it('requires an executed write and distinguishes filesystem open flags', () => {
    const source = `import type { Repository, UpdateQueryBuilder } from 'typeorm'
import { open } from 'node:fs/promises'
type Row = { id: string }

export function createEntity(repository: Repository<Row>) {
  return repository.create({ id: 'one' })
}

export function prepareUpdate(builder: UpdateQueryBuilder<Row>) {
  return builder.update().set({ id: 'two' })
}

export function saveEntity(repository: Repository<Row>) {
  return repository.save({ id: 'three' })
}

export function openRead(path: string) {
  return open(path, 'r')
}

export function openWrite(path: string) {
  return open(path, 'w')
}

export function openUnknown(path: string, flags: string) {
  return open(path, flags)
}
`
    const { nodes } = build({ 'src/persistence.ts': source })
    expect(facts(nodes, symbol(nodes, 'createEntity'), 'persistence')).toEqual([])
    expect(facts(nodes, symbol(nodes, 'prepareUpdate'), 'persistence')).toEqual([])
    expect(facts(nodes, symbol(nodes, 'saveEntity'), 'persistence')).toEqual([
      expect.objectContaining({ operation: 'upsert' }),
    ])
    expect(facts(nodes, symbol(nodes, 'openRead'), 'persistence')).toEqual([
      expect.objectContaining({ operation: 'file_read' }),
    ])
    expect(facts(nodes, symbol(nodes, 'openWrite'), 'persistence')).toEqual([
      expect.objectContaining({ operation: 'file_write' }),
    ])
    expect(facts(nodes, symbol(nodes, 'openUnknown'), 'persistence')).toEqual([])
  })

  it('redacts credential URLs and JWT values independent of variable names', () => {
    const credentialUrl = 'postgresql://alice:hunter2@db.example/app'
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature'
    const source = `declare function use(value: string): void
export function secrets(): void {
  use('${credentialUrl}')
  use('${jwt}')
}
`
    const { nodes } = build({ 'src/secrets.ts': source })
    const serialized = JSON.stringify(
      facts(nodes, symbol(nodes, 'secrets'), 'call'),
    )
    expect(serialized).not.toContain(credentialUrl)
    expect(serialized).not.toContain(jwt)
    expect(serialized.match(/"kind":"redacted"/g)).toHaveLength(2)
  })

  it('fails a wrapper expansion product closed with no partial owner topology', () => {
    const effects = Array.from(
      { length: 100 },
      (_, index) => `  reports.add('job-${index}', {})`,
    ).join('\n')
    const calls = Array.from(
      { length: 100 },
      () => '  fanout()',
    ).join('\n')
    const source = `import { Queue } from 'bullmq'
const reports = new Queue('reports')
function fanout(): void {
${effects}
}
export function overflow(): void {
${calls}
}
`
    const { result, nodes, edges } = build({ 'src/overflow-product.ts': source })
    const owner = symbol(nodes, 'overflow')
    expect(Object.hasOwn(owner[1], 'body_facts')).toBe(false)
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: 'error',
        id: expect.stringContaining('execution.owner-bound'),
      }),
    ]))
    expect(outgoing(edges, owner[0], 'publishes_to')).toEqual([])
  })

  it('does not prove a queue removed from a Map', () => {
    const source = `import { Queue } from 'bullmq'
const queues = new Map<string, Queue>()
queues.set('alias', new Queue('real'))
queues.delete('alias')
export function publish() {
  return queues.get('alias')!.add('complete', {})
}
`
    const { nodes, edges } = build({ 'src/map-delete.ts': source })
    expect(publishedQueueKeys(nodes, edges, symbol(nodes, 'publish')[0]))
      .not.toContain('real')
  })

  it('preserves conditional reachability after dead tail text', () => {
    const source = `declare function dead(): void
declare function after(): void
export function run(flag: boolean): void {
  if (flag) {
    return
    dead()
  }
  after()
}
`
    const { nodes } = build({ 'src/reachability-tail.ts': source })
    const calls = facts(nodes, symbol(nodes, 'run'), 'call')
    expect(calls.some((fact) =>
      fact.kind === 'call' && fact.callee === 'dead')).toBe(false)
    const after = calls.find((fact) =>
      fact.kind === 'call' && fact.callee === 'after')
    expect(after?.control).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'branch', arm: 'else' }),
    ]))
  })

  it('resolves computed mutation keys and fails closed when they are dynamic', () => {
    const source = `export function sensitive(target: Record<string, unknown>): void {
  const key = 'password'
  target[key] = 'hunter2'
}
export function nested(target: Record<string, unknown>): void {
  const first = 'credentials'
  const key = first
  target[key] = { nested: 'hunter2' }
}
export function dynamic(target: Record<string, unknown>, key: string): void {
  target[key] = 'hunter2'
}
export function safe(target: Record<string, unknown>): void {
  const key = 'displayName'
  target[key] = 'Ada'
}
export function numeric(items: string[]): void {
  items[0] = 'visible'
}
`
    const { nodes } = build({ 'src/computed-secret.ts': source })
    for (const name of ['sensitive', 'nested', 'dynamic']) {
      const mutation = facts(nodes, symbol(nodes, name), 'mutation')
      expect(mutation).toHaveLength(1)
      expect(mutation[0]).toMatchObject({ target: expect.stringMatching(/^redacted:/) })
      expect(JSON.stringify(mutation)).not.toContain('hunter2')
    }
    expect(facts(nodes, symbol(nodes, 'safe'), 'mutation')[0])
      .toMatchObject({
        target: expect.not.stringMatching(/^redacted:/),
        value: { kind: 'literal', value: 'Ada' },
      })
    expect(facts(nodes, symbol(nodes, 'numeric'), 'mutation')[0])
      .toMatchObject({ value: { kind: 'literal', value: 'visible' } })
  })

  it('preserves every persistence effect behind a wrapper call', () => {
    const source = `import { writeFile } from 'node:fs/promises'
async function persistBoth(): Promise<void> {
  await writeFile('first.json', 'one')
  await writeFile('second.json', 'two')
}
export async function run(): Promise<void> {
  await persistBoth()
  await writeFile('third.json', 'three')
}
`
    const built = build({ 'src/wrapped-persistence.ts': source })
    const graph = loadGraphArtifact(generateIndex(built.root).graphPath)
    expect(inspectQueryIndex(graph)).toMatchObject({ state: 'ready' })
    const nodes = new Map<string, NodeAttributes>(graph.nodeEntries())
    const persisted = facts(nodes, symbol(nodes, 'run'), 'persistence')
    expect(persisted).toHaveLength(3)
    expect(persisted.map((fact) => fact.order[3])).toEqual([2, 3, 1])
    expect(JSON.stringify(persisted)).toContain('first.json')
    expect(JSON.stringify(persisted)).toContain('second.json')
    expect(JSON.stringify(persisted)).toContain('third.json')
  })

  it('represents switch fallthrough in the executed arm set', () => {
    const source = `declare function first(): void
declare function second(): void
export function choose(code: number): void {
  switch (code) {
    case 1:
      first()
    case 2:
      second()
      break
  }
}
`
    const { nodes } = build({ 'src/switch-fallthrough.ts': source })
    const calls = facts(nodes, symbol(nodes, 'choose'), 'call')
    const first = calls.find((fact) =>
      fact.kind === 'call' && fact.callee === 'first')
    const second = calls.filter((fact) =>
      fact.kind === 'call' && fact.callee === 'second')
    const firstArm = first?.control.find((frame) => frame.kind === 'branch')
    const secondArms = second.flatMap((fact) =>
      fact.control.filter((frame) => frame.kind === 'branch'))
    expect(secondArms).toEqual(expect.arrayContaining([
      firstArm,
      expect.objectContaining({ kind: 'branch' }),
    ]))
    expect(new Set(secondArms.map((frame) =>
      frame.kind === 'branch' ? frame.arm : '')).size).toBe(2)
  })

  it('keeps only the surviving guarded switch-fallthrough path', () => {
    const source = `declare function first(): void
declare function second(): void
export function choose(code: number, stop: boolean): void {
  switch (code) {
    case 1:
      first()
      if (stop) break
    case 2:
      second()
      break
  }
}
`
    const { nodes } = build({ 'src/switch-guarded-fallthrough.ts': source })
    const calls = facts(nodes, symbol(nodes, 'choose'), 'call')
    const first = calls.find((fact) =>
      fact.kind === 'call' && fact.callee === 'first')
    const second = calls.filter((fact) =>
      fact.kind === 'call' && fact.callee === 'second')
    const firstArm = first?.control.find((frame) =>
      frame.kind === 'branch')?.arm
    expect(second).toHaveLength(2)
    expect(second.some((fact) => fact.control.some((frame) =>
      frame.kind === 'branch' && frame.arm === firstArm))).toBe(true)
    expect(second.find((fact) => fact.control.some((frame) =>
      frame.kind === 'branch' && frame.arm === firstArm))?.control)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'branch', arm: 'else' }),
      ]))
  })

  it('does not fall through when every conditional arm exits a switch clause', () => {
    const source = `declare function later(): void
export function choose(code: number, stop: boolean): void {
  switch (code) {
    case 1:
      if (stop) break
      else return
    case 2:
      later()
      break
  }
}
`
    const { nodes } = build({ 'src/switch-all-exit.ts': source })
    expect(facts(nodes, symbol(nodes, 'choose'), 'call')
      .filter((fact) => fact.kind === 'call' && fact.callee === 'later'))
      .toHaveLength(1)
  })

  it('preserves default and three-clause switch entry paths deterministically', () => {
    const source = `declare function shared(): void
export function choose(code: number): void {
  switch (code) {
    case 1:
    default:
      shared()
    case 2:
      shared()
      break
  }
}
`
    const first = build({
      'src/switch-chain.ts': source,
      'src/companion.ts': 'export const companion = true\n',
    })
    const second = build({
      'src/companion.ts': 'export const companion = true\n',
      'src/switch-chain.ts': source,
    })
    const firstOwner = symbol(first.nodes, 'choose')
    const secondOwner = symbol(second.nodes, 'choose')
    const firstCalls = facts(first.nodes, firstOwner, 'call')
      .filter((fact) => fact.kind === 'call' && fact.callee === 'shared')
    expect(firstCalls).toHaveLength(5)
    expect(new Set(firstCalls.map((fact) =>
      fact.control.flatMap((frame) => frame.kind === 'branch'
        && (frame.arm === 'default' || frame.arm.startsWith('case:'))
        ? [frame.arm]
        : [])[0])).size).toBe(3)
    expect(firstOwner[1].body_facts).toEqual(secondOwner[1].body_facts)
  })

  it('binds fallthrough persistence facts to their matching call paths', () => {
    const source = `import { writeFile } from 'node:fs/promises'
export async function persist(code: number): Promise<void> {
  switch (code) {
    case 1:
    case 2:
      await writeFile('report.json', 'ready')
      break
  }
}
`
    const { nodes } = build({ 'src/switch-persistence.ts': source })
    const owner = symbol(nodes, 'persist')
    const calls = facts(nodes, owner, 'call').filter((fact) =>
      fact.kind === 'call' && fact.callee === 'writeFile')
    const persisted = facts(nodes, owner, 'persistence')
    expect(calls).toHaveLength(2)
    expect(persisted).toHaveLength(2)
    expect(new Set(persisted.map((fact) =>
      fact.kind === 'persistence' ? fact.call_fact_id : '')))
      .toEqual(new Set(calls.map((fact) => fact.id)))
  })

  it('does not fall through provably non-terminating loop clauses', () => {
    const source = `import { writeFile } from 'node:fs/promises'
declare function dynamic(): boolean
export async function withWhile(code: string): Promise<void> {
  switch (code) {
    case 'complete':
      while (true) {}
    case 'progress':
      await writeFile('while.json', code)
  }
}
export async function withDo(code: string): Promise<void> {
  switch (code) {
    case 'complete':
      do {} while (true)
    case 'progress':
      await writeFile('do.json', code)
  }
}
export async function withFor(code: string): Promise<void> {
  switch (code) {
    case 'complete':
      for (;;) {}
    case 'progress':
      await writeFile('for.json', code)
  }
}
export async function withNumeric(code: string): Promise<void> {
  switch (code) {
    case 'complete':
      while (1) {}
    case 'progress':
      await writeFile('numeric.json', code)
  }
}
export async function withNegatedBoolean(code: string): Promise<void> {
  switch (code) {
    case 'complete':
      while (!false) {
        if (false) break
      }
    case 'progress':
      await writeFile('negated.json', code)
  }
}
export async function withStrictComparison(code: string): Promise<void> {
  switch (code) {
    case 'complete':
      while (1 === 1) {}
    case 'progress':
      await writeFile('comparison.json', code)
  }
}
export async function withObject(code: string): Promise<void> {
  switch (code) {
    case 'complete':
      while ({}) {}
    case 'progress':
      await writeFile('object.json', code)
  }
}
export async function withDoReturn(code: string): Promise<void> {
  switch (code) {
    case 'complete':
      do { return } while (dynamic())
    case 'progress':
      await writeFile('do-return.json', code)
  }
}
export async function withDoThrow(code: string): Promise<void> {
  switch (code) {
    case 'complete':
      do { throw new Error('stop') } while (dynamic())
    case 'progress':
      await writeFile('do-throw.json', code)
  }
}
export async function withIfObject(code: string): Promise<void> {
  switch (code) {
    case 'complete':
      if ({}) return
    case 'progress':
      await writeFile('if-object.json', code)
  }
}
export async function withIfStrict(code: string): Promise<void> {
  switch (code) {
    case 'complete':
      if (1 === 1) return
    case 'progress':
      await writeFile('if-strict.json', code)
  }
}
`
    const { nodes } = build({ 'src/switch-infinite-loop.ts': source })
    for (const name of [
      'withWhile',
      'withDo',
      'withFor',
      'withNumeric',
      'withNegatedBoolean',
      'withStrictComparison',
      'withObject',
      'withDoReturn',
      'withDoThrow',
      'withIfObject',
      'withIfStrict',
    ]) {
      const persisted = facts(nodes, symbol(nodes, name), 'persistence')
      expect(persisted).toHaveLength(1)
      const arms = persisted[0]!.control.flatMap((frame) =>
        frame.kind === 'branch' ? [frame.arm] : [])
      expect(arms).toHaveLength(1)
      expect(JSON.parse(
        Buffer.from(arms[0]!.slice(5), 'base64url').toString('utf8'),
      )).toEqual(['string', 'progress'])
    }
  })

  it('keeps a do-continue path reachable when its condition may be false', () => {
    const source = `import { writeFile } from 'node:fs/promises'
declare function dynamic(): boolean
export async function run(code: string): Promise<void> {
  switch (code) {
    case 'complete':
      do { continue } while (dynamic())
    case 'progress':
      await writeFile('continued.json', code)
  }
}
`
    const { nodes } = build({ 'src/do-continue.ts': source })
    const persisted = facts(nodes, symbol(nodes, 'run'), 'persistence')
    expect(persisted).toHaveLength(2)
    const arms = persisted.flatMap((fact) => fact.control.flatMap((frame) =>
      frame.kind === 'branch' ? [frame.arm] : []))
    expect(new Set(arms.map((arm) => JSON.parse(
      Buffer.from(arm.slice(5), 'base64url').toString('utf8'),
    )[1]))).toEqual(new Set(['complete', 'progress']))
  })

  it('fails an oversized or effectful switch owner closed', () => {
    const clauses = Array.from(
      { length: 33 },
      (_, index) => `case ${index}: break`,
    ).join('\n')
    const oversized = build({
      'src/switch-overflow.ts': `export function choose(code: number): void {
  switch (code) {
    ${clauses}
  }
}
`,
    })
    const effectful = build({
      'src/switch-effect.ts': `declare function selector(): number
declare function work(): void
export function choose(code: number): void {
  switch (code) {
    case selector(): work()
  }
}
`,
    })
    for (const candidate of [oversized, effectful]) {
      expect(Object.hasOwn(
        symbol(candidate.nodes, 'choose')[1],
        'body_facts',
      )).toBe(false)
      expect(candidate.result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          level: 'error',
          id: expect.stringContaining('execution.owner-bound'),
        }),
      ]))
    }
  })

  it('records only immutable same-owner switch discriminants', () => {
    const source = `type Job = {
  data: { trigger: string; fallback: string }
}

export function exact(job: Job): void {
  const { trigger: kind } = job.data
  switch (kind) {
    case 'complete':
      return
    case 'progress':
      return
  }
}

export function reassigned(job: Job): void {
  let kind = job.data.trigger
  kind = job.data.fallback
  switch (kind) {
    case 'complete':
      return
  }
}

export function defaulted(job: Job): void {
  const { trigger = 'progress' } = job.data
  switch (trigger) {
    case 'complete':
      return
  }
}

export function rested(job: Job): void {
  const { ...payload } = job.data
  switch (payload.trigger) {
    case 'complete':
      return
  }
}

export function computed(job: Job): void {
  const { ['trigger']: kind } = job.data
  switch (kind) {
    case 'complete':
      return
  }
}

export function dynamicCase(job: Job): void {
  const expected = job.data.fallback
  switch (job.data.trigger) {
    case expected:
      return
  }
}

export function duplicateCase(job: Job): void {
  switch (job.data.trigger) {
    case 'complete':
      return
    case 'complete':
      return
  }
}

export function reassignedRoot(job: Job, replacement: Job): void {
  job = replacement
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}

export function mutatedRoot(job: Job): void {
  job.data.trigger = job.data.fallback
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}

export function compatibleAliasMutation(job: Job, alias: Job): void {
  alias.data.trigger = 'progress'
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}

function aliasThroughCall(job: Job, alias: Job): void {
  alias.data.trigger = 'progress'
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}
export function sameArgumentAlias(job: Job): void {
  aliasThroughCall(job, job)
}

declare function mutateJob(job: Job): void
export function externalAliasMutation(job: Job, alias: Job): void {
  mutateJob(alias)
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}

type AliasMarker = { marker: boolean }
export function intersectionAliasMutation(
  job: Job,
  alias: AliasMarker,
): void {
  ;(alias as unknown as Job).data.trigger = 'progress'
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}
export function intersectionAliasCaller(value: Job & AliasMarker): void {
  intersectionAliasMutation(value, value)
}

class GetterJob {
  data = { trigger: 'complete', fallback: 'progress' }
  get touch(): number {
    this.data.trigger = 'progress'
    return 1
  }
}
export function getterAliasMutation(job: GetterJob, alias: GetterJob): void {
  void alias.touch
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}

export function logicalAliasMutation(job: Job, alias: Job): void {
  const linked = alias || job
  linked.data.trigger = 'progress'
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}

class CoerciveJob {
  data = { trigger: 'complete', fallback: 'progress' }
  valueOf(): number {
    this.data.trigger = 'progress'
    return 1
  }
}
export function coerciveAliasMutation(
  job: CoerciveJob,
  alias: CoerciveJob,
): void {
  void (alias + 1)
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}

export function destructuredAliasMutation(
  job: Job,
  { data }: Job,
): void {
  data.trigger = 'progress'
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}

export function hoistedAliasMutation(job: Job, alias: Job): void {
  changeAlias()
  switch (job.data.trigger) {
    case 'complete':
      return
  }
  function changeAlias(): void {
    mutateJob(alias)
  }
}

export function defaultRoot(
  job: Job = { data: { trigger: 'progress', fallback: 'progress' } },
): void {
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}

export function explicitThis(this: void, job: Job): void {
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}

class DataAccessorJob {
  get data(): Job['data'] {
    return { trigger: 'progress', fallback: 'progress' }
  }
}
export function dataAccessorSelector(job: DataAccessorJob): void {
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}

class AccessorPayload {
  get trigger(): string { return 'progress' }
  fallback = 'progress'
}
class TriggerAccessorJob { data = new AccessorPayload() }
export function triggerAccessorSelector(job: TriggerAccessorJob): void {
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}
export function triggerAccessorAlias(job: TriggerAccessorJob): void {
  const { trigger: kind } = job.data
  switch (kind) {
    case 'complete':
      return
  }
}
export function triggerAccessorShorthand(job: TriggerAccessorJob): void {
  const { trigger } = job.data
  switch (trigger) {
    case 'complete':
      return
  }
}

export function conditionalVar(job: Job, enabled: boolean): void {
  if (enabled) {
    var { trigger: kind } = job.data
  }
  switch (kind) {
    case 'complete':
      return
  }
}

export function forOfRoot(job: Job, replacements: Job[]): void {
  for (job of replacements) void job
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}

export function forInRoot(
  job: Job,
  replacements: Record<string, Job>,
): void {
  for (job in replacements) void job
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}

export function duplicateDefault(job: Job): void {
  switch (job.data.trigger) {
    default:
      return
    default:
      return
  }
}

export function conditionalCase(job: Job, enabled: boolean): void {
  if (enabled) {
    var expected = 'complete'
  }
  switch (job.data.trigger) {
    case expected:
      return
  }
}

export function lateCase(job: Job): void {
  switch (job.data.trigger) {
    case expected:
      return
  }
  const expected = 'complete'
  void expected
}

export function crossCase(job: Job, route: number): void {
  switch (route) {
    case 0:
      const expected = 'complete'
      void expected
      break
    case 1:
      switch (job.data.trigger) {
        case expected:
          return
      }
  }
}

export function lateEnum(job: Job): void {
  switch (job.data.trigger) {
    case Status.Done:
      return
  }
  enum Status { Done = 'complete' }
}

enum State { Done = 'complete' }
export function mutatedEnum(job: Job): void {
  State.Done = 'progress'
  switch (job.data.trigger) {
    case State.Done:
      return
  }
}

declare function externalEnum(value: unknown): void
enum ExternalState { Done = 'complete' }
export function externallyMutatedEnum(job: Job): void {
  externalEnum(ExternalState)
  switch (job.data.trigger) {
    case ExternalState.Done:
      return
  }
}

enum ModuleState { Done = 'complete' }
externalEnum(ModuleState)
export function moduleMutatedEnum(job: Job): void {
  switch (job.data.trigger) {
    case ModuleState.Done:
      return
  }
}

enum CaseBodyState { Done = 'complete' }
export function caseBodyMutatedEnum(job: Job, flag: number): void {
  switch (flag) {
    case 1:
      externalEnum(CaseBodyState)
      break
  }
  switch (job.data.trigger) {
    case CaseBodyState.Done:
      return
  }
}

enum ModuleCaseBodyState { Done = 'complete' }
switch (1) {
  case 1:
    externalEnum(ModuleCaseBodyState)
}
export function moduleCaseBodyMutatedEnum(job: Job): void {
  switch (job.data.trigger) {
    case ModuleCaseBodyState.Done:
      return
  }
}

enum LaterState { Done = 'complete' }
export function laterMutatedEnum(job: Job): void {
  switch (job.data.trigger) {
    case LaterState.Done:
      break
  }
  externalEnum(LaterState)
}

export enum PublicState { Done = 'complete' }
export function publicEnum(job: Job): void {
  switch (job.data.trigger) {
    case PublicState.Done:
      return
  }
}

declare enum AmbientState { Done = 'complete' }
export function ambientEnum(job: Job): void {
  switch (job.data.trigger) {
    case AmbientState.Done:
      return
  }
}

enum ReexportedState { Done = 'complete' }
export { ReexportedState }
export function reexportedEnum(job: Job): void {
  switch (job.data.trigger) {
    case ReexportedState.Done:
      return
  }
}

enum SecretState {
  Password = 'hunter2',
  Ready = 'sk-live-do-not-index',
}
export function secretEnum(job: Job): void {
  switch (job.data.trigger) {
    case SecretState.Password:
    case SecretState.Ready:
      return
  }
}

export function nestedMutation(job: Job): void {
  let { data: { trigger } } = job
  trigger = 'progress'
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}

export function reflectedMutation(job: Job): void {
  Reflect.set(job.data, 'trigger', 'progress')
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}

function change(data: Job['data']): void {
  data.trigger = 'progress'
}
function changeThroughHelper(data: Job['data']): void {
  change(data)
}
export function helperMutation(job: Job): void {
  changeThroughHelper(job.data)
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}

function overloadedChange(data: Job['data']): void
function overloadedChange(data: Job['data']): void {
  data.trigger = 'progress'
}
function argumentsChange(data: Job['data']): void {
  arguments[0].trigger = 'progress'
}
const boundChange = change.bind(undefined)
class ConstructorChange {
  constructor(data: Job['data']) { data.trigger = 'progress' }
}
class MutableData {
  trigger = 'complete'
  fallback = 'progress'
  mutate(): void { this.trigger = 'progress' }
  mutateAlias(): void {
    const self = this
    self.trigger = 'progress'
  }
  mutateArrow = (): void => { this.trigger = 'progress' }
}
interface UnknownMutator {
  mutate(data: Job['data']): void
}
class PureMutator {
  mutate(_data: Job['data']): void {}
}
class ImpureMutator {
  mutate(data: Job['data']): void { data.trigger = 'progress' }
}

export function overloadMutation(job: Job): void {
  overloadedChange(job.data)
  switch (job.data.trigger) { case 'complete': return }
}
export function argumentsMutation(job: Job): void {
  argumentsChange(job.data)
  switch (job.data.trigger) { case 'complete': return }
}
export function callMutation(job: Job): void {
  change.call(undefined, job.data)
  switch (job.data.trigger) { case 'complete': return }
}
export function applyMutation(job: Job): void {
  change.apply(undefined, [job.data])
  switch (job.data.trigger) { case 'complete': return }
}
export function boundMutation(job: Job): void {
  boundChange(job.data)
  switch (job.data.trigger) { case 'complete': return }
}
export function constructorMutation(job: Job): void {
  new ConstructorChange(job.data)
  switch (job.data.trigger) { case 'complete': return }
}
export function receiverMutation(job: { data: MutableData }): void {
  job.data.mutate()
  switch (job.data.trigger) { case 'complete': return }
}
export function receiverAliasMutation(job: { data: MutableData }): void {
  job.data.mutateAlias()
  switch (job.data.trigger) { case 'complete': return }
}
export function receiverArrowMutation(job: { data: MutableData }): void {
  job.data.mutateArrow()
  switch (job.data.trigger) { case 'complete': return }
}
export function unknownMutation(job: Job, mutator: UnknownMutator): void {
  mutator.mutate(job.data)
  switch (job.data.trigger) { case 'complete': return }
}
export function ambiguousMutation(
  job: Job,
  mutator: PureMutator | ImpureMutator,
): void {
  mutator.mutate(job.data)
  switch (job.data.trigger) { case 'complete': return }
}
export function callbackMutation(job: Job): void {
  ;[job.data].forEach((data) => { data.trigger = 'progress' })
  switch (job.data.trigger) { case 'complete': return }
}
export function forOfMutation(job: Job): void {
  for (const data of [job.data]) data.trigger = 'progress'
  switch (job.data.trigger) { case 'complete': return }
}
function identity<T>(value: T): T { return value }
async function asyncIdentity<T>(value: T): Promise<T> { return value }
export function returnedAliasMutation(job: Job): void {
  const alias = identity(job.data)
  alias.trigger = 'progress'
  switch (job.data.trigger) { case 'complete': return }
}
export async function awaitedAliasMutation(job: Job): Promise<void> {
  const alias = await asyncIdentity(job.data)
  alias.trigger = 'progress'
  switch (job.data.trigger) { case 'complete': return }
}
export function conditionalAliasMutation(
  job: Job,
  other: Job['data'],
  enabled: boolean,
): void {
  const alias = enabled ? job.data : other
  alias.trigger = 'progress'
  switch (job.data.trigger) { case 'complete': return }
}
export function malformedRest(...rest: Job[], job: Job): void {
  void rest
  switch (job.data.trigger) { case 'complete': return }
}

export function misplacedThis(job: Job, this: void): void {
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}

export function duplicateParameter(job: Job, job: Job): void {
  switch (job.data.trigger) {
    case 'complete':
      return
  }
}

export function longCase(job: Job): void {
  switch (job.data.trigger) {
    case 'this-case-value-is-deliberately-long-enough-to-exceed-the-encoded-branch-arm-limit':
      return
  }
}
`
    const { nodes } = build({ 'src/switch-discriminants.ts': source })
    const condition = (name: string) => facts(
      nodes,
      symbol(nodes, name),
      'condition',
    ).find((fact): fact is Extract<IndexBodyFact, { kind: 'condition' }> =>
      fact.kind === 'condition' && fact.condition_kind === 'switch')
    const caseValue = (arm: string): unknown => {
      const parts = arm.split(':')
      if (parts.length !== 2) return undefined
      try {
        const value = JSON.parse(
          Buffer.from(parts[1]!, 'base64url').toString('utf8'),
        ) as unknown
        return Array.isArray(value) && value.length === 2
          ? value[1]
          : undefined
      } catch {
        return undefined
      }
    }
    const cases = (name: string) => facts(
      nodes,
      symbol(nodes, name),
    ).flatMap((fact) => fact.control.flatMap((control) =>
      control.kind === 'branch' && control.arm.startsWith('case:')
        ? [caseValue(control.arm)]
        : []))
    const selector = {
      kind: 'template',
      parts: [
        { kind: 'parameter', position: 0 },
        { kind: 'literal', value: 'data' },
        { kind: 'literal', value: 'trigger' },
      ],
    }

    expect(condition('exact')).toMatchObject({
      test: selector,
      evidence: {
        statement_range: {
          start: { line: 6, column: 3 },
          end: { line: 12, column: 4 },
        },
      },
    })
    expect(cases('exact')).toEqual(
      expect.arrayContaining(['complete', 'progress']),
    )
    for (const name of [
      'reassigned',
      'defaulted',
      'rested',
      'computed',
    ]) {
      expect(condition(name)).toBeDefined()
      expect(condition(name)?.test, name).not.toMatchObject(selector)
    }
    expect(condition('dynamicCase')?.test).not.toMatchObject(selector)
    expect(cases('dynamicCase')).toEqual([undefined])
    expect(condition('duplicateCase')?.test).not.toMatchObject(selector)
    expect(cases('duplicateCase')).toEqual(['complete'])
    expect(condition('externallyMutatedEnum')?.test).not.toMatchObject(selector)
    expect(cases('externallyMutatedEnum')).toEqual([undefined])
    expect(condition('moduleMutatedEnum')?.test).not.toMatchObject(selector)
    expect(cases('moduleMutatedEnum')).toEqual([undefined])
    for (const name of [
      'caseBodyMutatedEnum',
      'moduleCaseBodyMutatedEnum',
      'laterMutatedEnum',
      'publicEnum',
      'ambientEnum',
      'reexportedEnum',
      'secretEnum',
    ]) {
      expect(condition(name)?.test, name).not.toMatchObject(selector)
      expect(cases(name), name).not.toContain('complete')
    }
    expect(cases('secretEnum').filter(Boolean)).toEqual([])
    for (const name of [
      'reassignedRoot',
      'mutatedRoot',
      'compatibleAliasMutation',
      'aliasThroughCall',
      'externalAliasMutation',
      'intersectionAliasMutation',
      'getterAliasMutation',
      'logicalAliasMutation',
      'coerciveAliasMutation',
      'destructuredAliasMutation',
      'hoistedAliasMutation',
    ]) {
      expect(condition(name)).toBeDefined()
      expect(condition(name)?.test).not.toMatchObject(selector)
    }
    expect(condition('explicitThis')?.test).toMatchObject(selector)
    for (const name of [
      'dataAccessorSelector',
      'triggerAccessorSelector',
      'triggerAccessorAlias',
      'triggerAccessorShorthand',
    ]) {
      expect(condition(name)?.test, name).not.toMatchObject(selector)
    }
    for (const name of [
      'defaultRoot',
      'conditionalVar',
      'forOfRoot',
      'forInRoot',
      'duplicateDefault',
      'conditionalCase',
      'lateCase',
      'crossCase',
      'lateEnum',
      'mutatedEnum',
      'nestedMutation',
      'reflectedMutation',
      'helperMutation',
      'overloadMutation',
      'argumentsMutation',
      'callMutation',
      'applyMutation',
      'boundMutation',
      'constructorMutation',
      'receiverMutation',
      'receiverAliasMutation',
      'receiverArrowMutation',
      'unknownMutation',
      'ambiguousMutation',
      'callbackMutation',
      'forOfMutation',
      'returnedAliasMutation',
      'awaitedAliasMutation',
      'conditionalAliasMutation',
      'malformedRest',
      'misplacedThis',
      'duplicateParameter',
    ]) {
      expect(condition(name)).toBeDefined()
      expect(condition(name)?.test, name).not.toMatchObject(selector)
    }
    expect(condition('longCase')?.test).not.toMatchObject(selector)
    const longArms = facts(nodes, symbol(nodes, 'longCase'))
      .flatMap((fact) => fact.control.flatMap((control) =>
        control.kind === 'branch' ? [control.arm] : []))
    expect(longArms).toContainEqual(expect.stringMatching(/^case:[a-f0-9]{16}$/u))
    expect(longArms.every((arm) => Buffer.byteLength(arm) <= 96)).toBe(true)
  })

  it('fails file-local static proofs closed for direct lexical eval', () => {
    const poisoned = build({
      'src/eval-poison.ts': `import { Queue } from 'bullmq'
type Job = { data: { trigger: string } }
enum State { Done = 'complete' }
let name = 'reports'
;(eval)("name = 'audit'")
const queue = new Queue(name)
export function dispatch(data: Job['data']) {
  return queue.add('persist', data)
}
export function process(job: Job): void {
  switch (job.data.trigger) {
    case State.Done:
      return
  }
}
`,
      'src/asserted-eval.ts': `import { Queue } from 'bullmq'
const queue = new Queue<{ trigger: string }>('asserted')
;(eval as typeof eval)("void 0")
export function assertedPublish(data: { trigger: string }) {
  return queue.add('persist', data)
}
`,
      'src/shadowed-eval.ts': `import { Queue } from 'bullmq'
function eval(_source: string): void {}
const queue = new Queue('shadowed')
eval('ignored')
export function shadowedPublish() {
  return queue.add('persist', { trigger: 'complete' })
}
`,
    })
    expect(publishedQueueKeys(
      poisoned.nodes,
      poisoned.edges,
      symbol(poisoned.nodes, 'dispatch')[0],
    )).not.toContain('reports')
    expect(outgoing(
      poisoned.edges,
      symbol(poisoned.nodes, 'assertedPublish')[0],
      'publishes_to',
    )).toEqual([])
    expect(publishedQueueKeys(
      poisoned.nodes,
      poisoned.edges,
      symbol(poisoned.nodes, 'shadowedPublish')[0],
    )).toEqual(['shadowed'])
    const process = facts(
      poisoned.nodes,
      symbol(poisoned.nodes, 'process'),
    )
    const condition = process.find((fact): fact is Extract<
      IndexBodyFact,
      { kind: 'condition' }
    > => fact.kind === 'condition' && fact.condition_kind === 'switch')
    expect(condition?.test).not.toMatchObject({
      kind: 'template',
      parts: [{ kind: 'parameter', position: 0 }],
    })
    expect(JSON.stringify(process)).not.toContain(
      Buffer.from(JSON.stringify(['string', 'complete'])).toString('base64url'),
    )
  })

  it('fails closed when an external bodyless call receives the selector root', () => {
    const { nodes } = build({
      'src/mutator.d.ts': `export declare function mutate(
  value: { trigger: string },
): void
`,
      'src/external-mutation.ts': `import { mutate } from './mutator.js'
type Job = { data: { trigger: string } }
export function process(job: Job): void {
  mutate(job.data)
  switch (job.data.trigger) { case 'complete': return }
}
export function hoistedMutation(job: Job): void {
  change()
  switch (job.data.trigger) { case 'complete': return }
  function change(): void { mutate(job.data) }
}
`,
    })
    for (const name of ['process', 'hoistedMutation']) {
      const condition = facts(nodes, symbol(nodes, name), 'condition')
        .find((fact): fact is Extract<IndexBodyFact, { kind: 'condition' }> =>
          fact.kind === 'condition' && fact.condition_kind === 'switch')
      expect(condition?.test).not.toMatchObject({
        kind: 'template',
        parts: [{ kind: 'parameter', position: 0 }],
      })
    }
  })

  it('does not authenticate imported enum case values', () => {
    const { nodes } = build({
      'src/state.ts': `export enum SharedState { Done = 'complete' }\n`,
      'src/imported-state.ts': `import { SharedState } from './state.js'
type Job = { data: { trigger: string } }
export function process(job: Job): void {
  switch (job.data.trigger) {
    case SharedState.Done:
      return
  }
}
`,
    })
    const condition = facts(nodes, symbol(nodes, 'process'), 'condition')
      .find((fact): fact is Extract<IndexBodyFact, { kind: 'condition' }> =>
        fact.kind === 'condition' && fact.condition_kind === 'switch')
    expect(condition?.test).not.toMatchObject({
      kind: 'template',
      parts: [{ kind: 'parameter', position: 0 }],
    })
  })

  it('tracks exact positional dispatch payloads and omits transformations', () => {
    const source = `import { Queue } from 'bullmq'

type Payload = { trigger: string }
const queue = new Queue<Payload>('reports')
declare function log(message: string, metadata: object): void

function pass(name: string, data: Payload, options: object) {
  void options
  return queue.add(name, data)
}

function duplicate(name: string, data: Payload, mirror: Payload) {
  void mirror
  return queue.add(name, data)
}

function transform(name: string, data: Payload) {
  return queue.add(name, { trigger: data.trigger })
}

function reassign(name: string, data: Payload, replacement: Payload) {
  data = replacement
  return queue.add(name, data)
}

function mutate(name: string, data: Payload) {
  data.trigger = 'changed'
  return queue.add(name, data)
}

function argumentsMutation(name: string, data: Payload) {
  arguments[1].trigger = 'changed'
  return queue.add(name, data)
}

function arrowArgumentsMutation(name: string, data: Payload) {
  ;(() => { arguments[1].trigger = 'changed' })()
  return queue.add(name, data)
}

function laterArgumentsMutation(name: string, data: Payload) {
  const pending = queue.add(name, data)
  arguments[1].trigger = 'changed'
  return pending
}

function optional(
  name: string,
  data: Payload = { trigger: 'fallback' },
) {
  return queue.add(name, data)
}

function rest(name: string, ...packets: Payload[]) {
  return queue.add(name, packets as unknown as Payload)
}

function spread(name: string, ...packets: Payload[]) {
  return queue.add(name, ...packets)
}

function malformedRest(
  name: string,
  ...packets: Payload[],
  data: Payload,
) {
  void packets
  return queue.add(name, data)
}

function iterate(name: string, data: Payload, replacements: Payload[]) {
  for (data of replacements) void data
  return queue.add(name, data)
}

function enumerate(
  name: string,
  data: Payload,
  replacements: Record<string, Payload>,
) {
  for (data in replacements) void data
  return queue.add(name, data)
}

function withThis(
  this: void,
  name: string,
  data: Payload,
  options: object,
) {
  void options
  return queue.add(name, data)
}

function misplacedThis(
  name: string,
  this: void,
  data: Payload,
  options: object,
) {
  void options
  return queue.add(name, data)
}

function duplicateParameter(
  name: string,
  data: Payload,
  data: Payload,
) {
  return queue.add(name, data)
}

function nestedMutation(name: string, data: Payload) {
  let { trigger } = data
  trigger = 'changed'
  return queue.add(name, data)
}

function reflectedMutation(name: string, data: Payload) {
  Reflect.set(data, 'trigger', 'changed')
  return queue.add(name, data)
}

function change(data: Payload) {
  data.trigger = 'changed'
}

function helperMutation(name: string, data: Payload) {
  change(data)
  return queue.add(name, data)
}

function postCallHelperMutation(name: string, data: Payload) {
  const pending = queue.add(name, data)
  change(data)
  return pending
}

function postCallExternalMutation(name: string, data: Payload) {
  const pending = queue.add(name, data)
  mutateExternal(data)
  return pending
}

function dual(name: string, left: Payload, right: Payload) {
  void queue.add(name, left)
  return queue.add(name, right)
}

function aliasedMutation(name: string, data: Payload, mirror: Payload) {
  mirror.trigger = 'changed'
  return queue.add(name, data)
}

declare function mutateExternal(data: Payload): void
declare function mutateNested(data: { value: string }): void
declare function tag(
  strings: TemplateStringsArray,
  value: { value: string },
): void

const modulePayload: Payload = { trigger: 'complete' }

function localMutation(name: string) {
  const data: Payload = { trigger: 'complete' }
  mutateExternal(data)
  return queue.add(name, data)
}

function hoistedLocalMutation(name: string) {
  const data: Payload = { trigger: 'complete' }
  change()
  return queue.add(name, data)
  function change() { mutateExternal(data) }
}

function passEnvelope(
  name: string,
  payload: { envelope: Payload },
) {
  return queue.add(name, payload)
}

function nestedAliasMutation(
  name: string,
  data: Payload & { nested: { value: string } },
) {
  const nested = data.nested
  mutateNested(nested)
  return queue.add(name, data)
}

function directNestedMutation(
  name: string,
  data: Payload & { nested: { value: string } },
) {
  mutateNested(data.nested)
  return queue.add(name, data)
}

function nestedContainerMutation(
  name: string,
  data: Payload & { nested: { value: string } },
) {
  const envelope = { nested: data.nested }
  mutateNested(envelope.nested)
  return queue.add(name, data)
}

function defaultNestedMutation(
  name: string,
  data: Payload & { nested: { value: string } },
  mutate = (nested = data.nested) => mutateNested(nested),
) {
  mutate()
  return queue.add(name, data)
}

function thrownNestedMutation(
  name: string,
  data: Payload & { nested: { value: string } },
) {
  try {
    throw data.nested
  } catch (nested) {
    mutateNested(nested as { value: string })
  }
  return queue.add(name, data)
}

function returnedNestedMutation(
  name: string,
  data: Payload & { nested: { value: string } },
) {
  void queue.add(name, data)
  return data.nested
}

function iteratedNestedMutation(
  name: string,
  data: Payload & { items: Array<{ value: string }> },
) {
  for (const item of data.items) mutateNested(item)
  return queue.add(name, data)
}

function taggedNestedMutation(
  name: string,
  data: Payload & { nested: { value: string } },
) {
  tag\`value:\${data.nested}\`
  return queue.add(name, data)
}

async function awaitedNestedMutation(
  name: string,
  data: Payload & { nested: PromiseLike<void> },
) {
  await data.nested
  return queue.add(name, data)
}

function coercedNestedMutation(
  name: string,
  data: Payload & { nested: { value: string }; matcher: Function },
) {
  void +(data.nested as unknown as number)
  void \`value:\${data.nested}\`
  void (data.nested instanceof (data.matcher as typeof Function))
  return queue.add(name, data)
}

function observed(name: string, data: Payload) {
  const pending = queue.add(name, data)
  const jobMeta = typeof data === 'object' && data !== null
    ? { trigger: data.trigger }
    : {}
  void jobMeta
  return pending
}

async function observedAfterAwait<T extends Payload>(
  name: string,
  data: T,
) {
  const job = await queue.add(name, data)
  const jobMeta = typeof data === 'object' && data !== null
    ? { trigger: (data as Record<string, unknown>).trigger }
    : {}
  log('added', { name, ...jobMeta })
  return job
}

function observedBeforeAwait<T extends Payload>(name: string, data: T) {
  const pending = queue.add(name, data)
  const jobMeta = typeof data === 'object' && data !== null
    ? { trigger: (data as Record<string, unknown>).trigger }
    : {}
  log('adding', { name, ...jobMeta })
  return pending
}

async function hoistedMutationDuringDispatch(
  name: string,
  data: Payload,
) {
  return await queue.add(name, data, change() as object)
  function change() {
    mutateExternal(data)
    return {}
  }
}

function typeOnly(name: string, data: Payload) {
  type Snapshot = typeof data
  const pending = queue.add(name, data)
  return pending as Promise<unknown> & { __type?: Snapshot }
}

function siblingTypeOnly(name: string, data: Payload, meta: object) {
  type Metadata = typeof meta
  const pending = queue.add(name, data)
  return pending as Promise<unknown> & { __type?: Metadata }
}

function coerciveRead(name: string, data: Payload) {
  const pending = queue.add(name, data)
  void ((data as unknown as number) + 1)
  return pending
}

function logicalAliasRead(
  name: string,
  data: Payload,
  fallback: Payload,
) {
  const pending = queue.add(name, data)
  const linked = data || fallback
  linked.trigger = 'changed'
  return pending
}

function spreadBeforePayload(
  _meta: object,
  data: Payload,
  ..._options: object[]
) {
  return queue.add('complete', data)
}

export function exact(data: Payload, options: object) {
  return pass('complete', data, options)
}

export function observedExact(data: Payload) {
  return observed('complete', data)
}

export function awaitedObservedExact(data: Payload) {
  return observedAfterAwait('complete', data)
}

export function pendingObservedExact(data: Payload) {
  return observedBeforeAwait('complete', data)
}

export function hoistedAwaitedMutation(data: Payload) {
  return hoistedMutationDuringDispatch('complete', data)
}

export function typeOnlyExact(data: Payload) {
  return typeOnly('complete', data)
}

export function siblingTypeOnlyExact(data: Payload, meta: object) {
  return siblingTypeOnly('complete', data, meta)
}

export function coerciveObserved(data: Payload) {
  return coerciveRead('complete', data)
}

export function logicalObserved(data: Payload, fallback: Payload) {
  return logicalAliasRead('complete', data, fallback)
}

export function spreadBefore(data: Payload, options: object) {
  const pair: [object, Payload] = [{}, data]
  return spreadBeforePayload(...pair, options)
}

export function spreadAfter(data: Payload, ...options: object[]) {
  return queue.add('complete', data, ...options)
}

export function directPayloadSpread(payloads: Payload[]) {
  return queue.add('complete', ...payloads)
}

export function directLeadingSpread(pair: [string, Payload]) {
  return queue.add(...pair)
}

export function prototypeSetterPayload() {
  return queue.add(
    'complete',
    { __proto__: 'complete' } as unknown as Payload,
  )
}

function forwardSpread(
  _meta: object,
  name: string,
  data: Payload,
  ..._extra: unknown[]
) {
  return queue.add(name, data)
}
export function spreadBeforeSelector(
  head: [object, string],
  data: Payload,
) {
  return forwardSpread(...head, 'decoy-name', data)
}

export function decorated(data: Payload, options: object) {
  const pending = pass('complete', data, options) as Promise<unknown> & {
    label?: string
  }
  pending.label = 'local'
  return pending
}

export function directResult(data: Payload) {
  const pending = queue.add('complete', data) as Promise<unknown> & {
    label?: string
  }
  pending.label = 'local'
  return pending
}

export function ambiguous(data: Payload) {
  return duplicate('complete', data, data)
}

export function transformed(data: Payload) {
  return transform('complete', data)
}

export function reassigned(data: Payload, replacement: Payload) {
  return reassign('complete', data, replacement)
}

export function mutated(data: Payload) {
  return mutate('complete', data)
}

export function argumentsAliased() {
  return argumentsMutation('complete', { trigger: 'complete' })
}

export function arrowArgumentsAliased() {
  return arrowArgumentsMutation('complete', { trigger: 'complete' })
}

export function laterArgumentsAliased() {
  return laterArgumentsMutation('complete', { trigger: 'complete' })
}

export function omitted() {
  return optional('complete')
}

export function rested(first: Payload, second: Payload) {
  return rest('complete', first, second)
}

export function spreadPayload(first: Payload, second: Payload) {
  return spread('complete', first, second)
}

export function malformedRested(first: Payload, second: Payload) {
  return malformedRest('complete', first, second)
}

export function iterated(data: Payload, replacements: Payload[]) {
  return iterate('complete', data, replacements)
}

export function enumerated(
  data: Payload,
  replacements: Record<string, Payload>,
) {
  return enumerate('complete', data, replacements)
}

export function explicitThis(data: Payload, options: object) {
  return withThis('complete', data, options)
}

export function malformedThis(data: Payload, options: object) {
  return misplacedThis('complete', data, options)
}

export function duplicated(first: Payload, second: Payload) {
  return duplicateParameter('complete', first, second)
}

export function nestedMutated(data: Payload) {
  return nestedMutation('complete', data)
}

export function reflected(data: Payload) {
  return reflectedMutation('complete', data)
}

export function helperMutated(data: Payload) {
  return helperMutation('complete', data)
}

export function postCallHelperMutated(data: Payload) {
  return postCallHelperMutation('complete', data)
}

export function postCallExternalMutated(data: Payload) {
  return postCallExternalMutation('complete', data)
}

export function conflicting(first: Payload, second: Payload) {
  return dual('complete', first, second)
}

export function aliased(data: Payload) {
  return aliasedMutation('complete', data, data)
}

export function staleLocal() {
  return localMutation('complete')
}

export function directStaleLocal() {
  const data: Payload = { trigger: 'complete' }
  mutateExternal(data)
  return queue.add('complete', data)
}

export function staleModulePayload() {
  const pending = queue.add('complete', modulePayload)
  mutateExternal(modulePayload)
  return pending
}

export function repeatedFor(items: Payload[]) {
  const data: Payload = { trigger: 'complete' }
  for (const item of items) {
    void item
    void queue.add('complete', data)
    mutateExternal(data)
  }
}

export function repeatedWhile(more: () => boolean) {
  const data: Payload = { trigger: 'complete' }
  while (more()) {
    void queue.add('complete', data)
    mutateExternal(data)
  }
}

export function laterWrapperMutation(data: Payload) {
  return pass(
    'complete',
    data,
    mutateExternal(data) as unknown as object,
  )
}

export function laterDirectMutation(data: Payload) {
  return queue.add(
    'complete',
    data,
    mutateExternal(data) as unknown as object,
  )
}

export function nestedStaleLocal() {
  const data: Payload = { trigger: 'complete' }
  mutateExternal(data)
  return queue.add('complete', { envelope: data })
}

export function nestedStaleWrapper() {
  const data: Payload = { trigger: 'complete' }
  mutateExternal(data)
  return passEnvelope('complete', { envelope: data })
}

export function nestedAliased(
  data: Payload & { nested: { value: string } },
) {
  return nestedAliasMutation('complete', data)
}

export function directNestedAliased(
  data: Payload & { nested: { value: string } },
) {
  return directNestedMutation('complete', data)
}

export function nestedContainerAliased(
  data: Payload & { nested: { value: string } },
) {
  return nestedContainerMutation('complete', data)
}

export function defaultNestedAliased(
  data: Payload & { nested: { value: string } },
) {
  return defaultNestedMutation('complete', data)
}

export function thrownNestedAliased(
  data: Payload & { nested: { value: string } },
) {
  return thrownNestedMutation('complete', data)
}

export function returnedNestedAliased(
  data: Payload & { nested: { value: string } },
) {
  return returnedNestedMutation('complete', data)
}

export function iteratedNestedAliased(
  data: Payload & { items: Array<{ value: string }> },
) {
  return iteratedNestedMutation('complete', data)
}

export function taggedNestedAliased(
  data: Payload & { nested: { value: string } },
) {
  return taggedNestedMutation('complete', data)
}

export function awaitedNestedAliased(
  data: Payload & { nested: PromiseLike<void> },
) {
  return awaitedNestedMutation('complete', data)
}

export function coercedNestedAliased(
  data: Payload & { nested: { value: string }; matcher: Function },
) {
  return coercedNestedMutation('complete', data)
}

export function staleHoistedLocal() {
  return hoistedLocalMutation('complete')
}

`
    const built = build({ 'src/dispatch-payload.ts': source })
    const { nodes, edges } = built
    const marked = (name: string) => outgoing(
      edges,
      symbol(nodes, name)[0],
      'publishes_to',
    ).flatMap(([, , attributes]) =>
      attributes.dispatch_payload_argument === undefined
        ? []
        : [attributes.dispatch_payload_argument])

    expect(marked('exact')).toEqual([1])
    expect(marked('observedExact')).toEqual([1])
    expect(marked('awaitedObservedExact')).toEqual([1])
    expect(marked('pendingObservedExact')).toEqual([])
    expect(marked('hoistedAwaitedMutation')).toEqual([])
    expect(marked('typeOnlyExact')).toEqual([1])
    expect(marked('siblingTypeOnlyExact')).toEqual([1])
    expect(marked('coerciveObserved')).toEqual([])
    expect(marked('logicalObserved')).toEqual([])
    expect(marked('spreadBefore')).toEqual([])
    expect(marked('spreadAfter')).toEqual([1])
    expect(marked('directPayloadSpread')).toEqual([])
    expect(marked('directLeadingSpread')).toEqual([])
    expect(marked('prototypeSetterPayload')).toEqual([])
    expect(marked('spreadBeforeSelector')).toEqual([])
    expect(marked('decorated')).toEqual([1])
    expect(marked('directResult')).toEqual([1])
    expect(marked('ambiguous')).toEqual([])
    expect(marked('transformed')).toEqual([])
    expect(marked('reassigned')).toEqual([])
    expect(marked('mutated')).toEqual([])
    expect(marked('argumentsAliased')).toEqual([])
    expect(marked('arrowArgumentsAliased')).toEqual([])
    expect(marked('laterArgumentsAliased')).toEqual([])
    expect(marked('omitted')).toEqual([])
    expect(marked('rested')).toEqual([])
    expect(marked('spreadPayload')).toEqual([])
    expect(marked('malformedRested')).toEqual([])
    expect(marked('iterated')).toEqual([])
    expect(marked('enumerated')).toEqual([])
    expect(marked('explicitThis')).toEqual([1])
    expect(marked('malformedThis')).toEqual([])
    expect(marked('duplicated')).toEqual([])
    expect(marked('nestedMutated')).toEqual([])
    expect(marked('reflected')).toEqual([])
    expect(marked('helperMutated')).toEqual([])
    expect(marked('postCallHelperMutated')).toEqual([])
    expect(marked('postCallExternalMutated')).toEqual([])
    expect(marked('conflicting')).toEqual([])
    expect(marked('aliased')).toEqual([])
    expect(marked('staleLocal')).toEqual([])
    expect(marked('directStaleLocal')).toEqual([])
    expect(marked('staleModulePayload')).toEqual([])
    expect(marked('repeatedFor')).toEqual([])
    expect(marked('repeatedWhile')).toEqual([])
    expect(marked('laterWrapperMutation')).toEqual([])
    expect(marked('laterDirectMutation')).toEqual([])
    expect(marked('nestedStaleLocal')).toEqual([])
    expect(marked('nestedStaleWrapper')).toEqual([])
    expect(marked('nestedAliased')).toEqual([])
    expect(marked('directNestedAliased')).toEqual([])
    expect(marked('nestedContainerAliased')).toEqual([])
    expect(marked('defaultNestedAliased')).toEqual([])
    expect(marked('thrownNestedAliased')).toEqual([])
    expect(marked('returnedNestedAliased')).toEqual([])
    expect(marked('iteratedNestedAliased')).toEqual([])
    expect(marked('taggedNestedAliased')).toEqual([])
    expect(marked('awaitedNestedAliased')).toEqual([])
    expect(marked('coercedNestedAliased')).toEqual([])
    expect(marked('staleHoistedLocal')).toEqual([])
    const duplicate = build({
      'src/duplicate-witness.ts': `import { Queue } from 'bullmq'
const queue = new Queue<{ trigger: string }>('sync')
export function dispatch(code: number) {
  switch (code) {
    case 1:
    case 2:
      return queue.add('persist', { trigger: 'complete' })
  }
}
`,
    })
    const duplicateEdge = outgoing(
      duplicate.edges,
      symbol(duplicate.nodes, 'dispatch')[0],
      'publishes_to',
    )[0]
    expect(duplicateEdge).toBeDefined()
    expect(duplicateEdge?.[2].dispatch_payload_argument).toBeUndefined()
    const duplicateGraph = loadGraphArtifact(generateIndex(duplicate.root).graphPath)
    expect(inspectQueryIndex(duplicateGraph)).toMatchObject({ state: 'ready' })
    for (const name of [
      'exact',
      'observedExact',
      'awaitedObservedExact',
      'pendingObservedExact',
      'hoistedAwaitedMutation',
      'typeOnlyExact',
      'siblingTypeOnlyExact',
      'coerciveObserved',
      'logicalObserved',
      'spreadBefore',
      'spreadAfter',
      'directPayloadSpread',
      'directLeadingSpread',
      'prototypeSetterPayload',
      'spreadBeforeSelector',
      'decorated',
      'directResult',
      'ambiguous',
      'transformed',
      'reassigned',
      'mutated',
      'argumentsAliased',
      'arrowArgumentsAliased',
      'laterArgumentsAliased',
      'omitted',
      'rested',
      'spreadPayload',
      'malformedRested',
      'iterated',
      'enumerated',
      'explicitThis',
      'malformedThis',
      'duplicated',
      'nestedMutated',
      'reflected',
      'helperMutated',
      'postCallHelperMutated',
      'postCallExternalMutated',
      'conflicting',
      'aliased',
      'staleLocal',
      'directStaleLocal',
      'staleModulePayload',
      'repeatedFor',
      'repeatedWhile',
      'laterWrapperMutation',
      'laterDirectMutation',
      'nestedStaleLocal',
      'nestedStaleWrapper',
      'nestedAliased',
      'directNestedAliased',
      'nestedContainerAliased',
      'staleHoistedLocal',
    ]) {
      expect(outgoing(
        edges,
        symbol(nodes, name)[0],
        'publishes_to',
      )).not.toEqual([])
    }
    const target = (name: string) => outgoing(
      edges,
      symbol(nodes, name)[0],
      'publishes_to',
    ).map(([, id]) => nodes.get(id))
    expect(target('directPayloadSpread')).toContainEqual(
      expect.objectContaining({ channel_kind: 'job', key: 'complete' }),
    )
    expect(target('directLeadingSpread')).not.toContainEqual(
      expect.objectContaining({ channel_kind: 'job' }),
    )
    expect(target('spreadBeforeSelector')).not.toContainEqual(
      expect.objectContaining({ channel_kind: 'job' }),
    )
  })

  it('selects exact Bull payload positions without speculating overloads', () => {
    const source = `import Queue from 'bull'
type Payload = { trigger: string }
const queue = new Queue('sync')
export function unnamed() {
  return queue.add(
    { trigger: 'complete' },
    { attempts: 1, trigger: 'wrong-options-value' } as any,
  )
}
export function named() {
  return queue.add('persist', { trigger: 'complete' })
}
function passUnnamed(data: Payload, options: object) {
  return queue.add(data, options)
}
export function wrappedUnnamed() {
  return passUnnamed({ trigger: 'complete' }, { attempts: 1 })
}
function passNamed(name: string, data: Payload) {
  return queue.add(name, data)
}
export function wrappedNamed() {
  return passNamed('persist', { trigger: 'complete' })
}
export function dynamic(first: string | Payload, second: Payload) {
  return queue.add(first, second)
}
export function boxed(first: String, data: Payload) {
  return queue.add(first, data)
}
export function boxedUnion(first: String | Payload, data: Payload) {
  return queue.add(first, data)
}
interface Stringish extends String {}
export function extendedString(first: Stringish, data: Payload) {
  return queue.add(first, data)
}
export function structuralString(
  first: { length: number },
  data: Payload,
) {
  return queue.add(first, data)
}
`
    const { nodes, edges } = build({ 'src/bull-overloads.ts': source })
    const marked = (name: string) => outgoing(
      edges,
      symbol(nodes, name)[0],
      'publishes_to',
    ).flatMap(([, , attributes]) =>
      typeof attributes.dispatch_payload_argument === 'number'
        ? [attributes.dispatch_payload_argument] : [])
    expect(marked('unnamed')).toEqual([0])
    expect(marked('named')).toEqual([1])
    expect(marked('wrappedUnnamed')).toEqual([0])
    expect(marked('wrappedNamed')).toEqual([1])
    expect(marked('dynamic')).toEqual([])
    expect(marked('boxed')).toEqual([])
    expect(marked('boxedUnion')).toEqual([])
    expect(marked('extendedString')).toEqual([])
    expect(marked('structuralString')).toEqual([])
    const unnamedTarget = outgoing(
      edges,
      symbol(nodes, 'unnamed')[0],
      'publishes_to',
    )[0]?.[1]
    expect(nodes.get(unnamedTarget ?? '')?.channel_kind).toBe('queue')
    for (const name of [
      'unnamed',
      'named',
      'wrappedUnnamed',
      'wrappedNamed',
      'dynamic',
      'boxed',
      'boxedUnion',
      'extendedString',
      'structuralString',
    ]) {
      expect(outgoing(
        edges,
        symbol(nodes, name)[0],
        'publishes_to',
      )).not.toEqual([])
    }
  })

  it('fails closed when a recognized queue constructor is monkey-patched', () => {
    const source = `import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
type Payload = { trigger: string }
declare function mutate(data: Payload): void
Queue.prototype.add = (async function(_name: string, data: unknown) {
  mutate(data as Payload)
  return {} as never
}) as typeof Queue.prototype.add
const queue = new Queue<Payload>('sync')
async function dispatch(data: Payload) {
  return await queue.add('persist', data)
}
export function outer() {
  return dispatch({ trigger: 'complete' })
}
class Publisher {
  constructor(@InjectQueue('sync') private readonly queue: Queue<Payload>) {}
  async dispatch(data: Payload) {
    return await this.queue.add('persist', data)
  }
}
export function outerNest(publisher: Publisher) {
  return publisher.dispatch({ trigger: 'complete' })
}
`
    const { nodes, edges, root } = build({
      'src/patched-queue.ts': source,
    })
    for (const name of [
      'dispatch',
      'outer',
      'Publisher.dispatch',
      'outerNest',
    ]) {
      expect(outgoing(
        edges,
        symbol(nodes, name)[0],
        'publishes_to',
      )).toEqual([])
    }
    expect(inspectQueryIndex(
      loadGraphArtifact(generateIndex(root).graphPath),
    )).toMatchObject({ state: 'ready' })
  })

  it('scopes unresolved import mutation authority to the exact module binding', () => {
    const publisher = `import { Queue } from 'bullmq'
type Payload = { trigger: string }
const queue = new Queue<Payload>('sync')
export async function publish(data: Payload) {
  return await queue.add('persist', data)
}
`
    const unrelated = build({
      'src/publisher.ts': publisher,
      'src/unrelated.ts': `import { Missing } from 'unresolved-package'
Missing.value = 1
`,
    })
    expect(outgoing(
      unrelated.edges,
      symbol(unrelated.nodes, 'publish')[0],
      'publishes_to',
    )).not.toEqual([])

    const patched = build({
      'src/publisher.ts': publisher,
      'src/patch.ts': `import { Queue } from 'bullmq'
Queue.prototype.add = async function() { return {} as never }
`,
    })
    expect(outgoing(
      patched.edges,
      symbol(patched.nodes, 'publish')[0],
      'publishes_to',
    )).toEqual([])

    const namespacePatched = build({
      'src/publisher.ts': publisher,
      'src/patch.ts': `import * as Bull from 'bullmq'
const { Queue: Patched } = Bull
Patched.prototype.add = async function() { return {} as never }
`,
    })
    expect(outgoing(
      namespacePatched.edges,
      symbol(namespacePatched.nodes, 'publish')[0],
      'publishes_to',
    )).toEqual([])

    for (const [name, patch] of [
      ['shorthand', `import * as Bull from 'bullmq'
const { Queue } = Bull
Queue.prototype.add = async function() { return {} as never }
`],
      ['alias-chain', `import * as Bull from 'bullmq'
const { Queue: Patched } = Bull
const Alias = Patched
Alias.prototype.add = async function() { return {} as never }
`],
      ['nested', `import * as Bull from 'bullmq'
const { Queue: { prototype } } = Bull
prototype.add = async function() { return {} as never }
`],
      ['static-computed', `import * as Bull from 'bullmq'
const { ['Queue']: Patched } = Bull
Patched.prototype.add = async function() { return {} as never }
`],
      ['defaulted', `import * as Bull from 'bullmq'
const { Queue: Patched = class {} as typeof Bull.Queue } = Bull
Patched.prototype.add = async function() { return {} as never }
`],
      ['rest', `import * as Bull from 'bullmq'
const { ...rest } = Bull
rest.Queue.prototype.add = async function() { return {} as never }
`],
      ['namespace-alias', `import * as Bull from 'bullmq'
const Namespace = Bull
const { Queue: Patched } = Namespace
Patched.prototype.add = async function() { return {} as never }
`],
      ['assignment', `import * as Bull from 'bullmq'
let Patched = class {} as typeof Bull.Queue
;({ Queue: Patched } = Bull)
Patched.prototype.add = async function() { return {} as never }
`],
      ['dynamic-computed', `import * as Bull from 'bullmq'
declare const key: string
const { [key]: Patched } = Bull as Record<string, typeof Bull.Queue>
Patched.prototype.add = async function() { return {} as never }
`],
    ] as const) {
      const graph = build({
        'src/publisher.ts': publisher,
        [`src/${name}.ts`]: patch,
      })
      expect(outgoing(
        graph.edges,
        symbol(graph.nodes, 'publish')[0],
        'publishes_to',
      ), name).toEqual([])
    }

    const otherMemberPatched = build({
      'src/publisher.ts': publisher,
      'src/patch.ts': `import * as Bull from 'bullmq'
const { Worker: Patched } = Bull
Patched.prototype.close = async function() {}
`,
    })
    expect(outgoing(
      otherMemberPatched.edges,
      symbol(otherMemberPatched.nodes, 'publish')[0],
      'publishes_to',
    )).not.toEqual([])
  })

  it('keeps producer changes and terminal persistence arms mutation-sensitive', () => {
    const source = (
      producer: string,
      order: readonly string[],
      alias = true,
      writes: Readonly<Record<string, readonly string[]>> =
        Object.fromEntries(order.map((arm) => [arm, [arm]])),
      nestedCollision = false,
    ) => `import { Queue, Worker, type Job } from 'bullmq'
import type { MongoRepository } from 'typeorm'
type Payload = {
  trigger: 'section_complete' | 'assembly_complete' | 'status_change'
  fallback: 'section_complete' | 'assembly_complete' | 'status_change'
  id: string
}
type Row = { id: string; status: string }
const queue = new Queue<Payload>('sync')
declare const repository: MongoRepository<Row>
export function dispatch(id: string) {
  return queue.add('persist', {
    trigger: '${producer}',
    fallback: 'status_change',
    id,
  })
}
export async function process(
  job: Job<Payload>,
  repository: MongoRepository<Row>,
): Promise<void> {
  ${alias
    ? 'const { trigger: kind } = job.data'
    : `let kind = job.data.trigger
  kind = job.data.fallback`}
  switch (kind) {
${order.map((arm) => `    case '${arm}':
${(writes[arm] ?? []).map((status) => `      await repository.update(job.data.id, {
        id: job.data.id,
        status: '${status}',
      })`).join('\n')}
${nestedCollision && arm === 'status_change' ? `      switch (job.data.fallback) {
        case 'assembly_complete':
          await repository.update(job.data.id, {
            id: job.data.id,
            status: 'nested-collision',
          })
      }` : ''}
      return`).join('\n')}
  }
}
export const worker = new Worker<Payload>(
  'sync',
  (job) => process(job, repository),
)
`
    const complete = [
      'section_complete',
      'assembly_complete',
      'status_change',
    ] as const
    const baseline = build({
      'src/mapping.ts': source('assembly_complete', complete),
    })
    const changed = build({
      'src/mapping.ts': source('status_change', complete),
    })
    const moved = build({
      'src/mapping.ts': source('assembly_complete', [
        'assembly_complete',
        'section_complete',
        'status_change',
      ], true, {
        section_complete: ['section_complete'],
        assembly_complete: [],
        status_change: ['status_change', 'assembly_complete'],
      }),
    })
    const removed = build({
      'src/mapping.ts': source('assembly_complete', [
        'section_complete',
        'status_change',
      ]),
    })
    const unproven = build({
      'src/mapping.ts': source('assembly_complete', complete, false),
    })
    const collision = build({
      'src/mapping.ts': source(
        'assembly_complete',
        ['status_change'],
        true,
        { status_change: [] },
        true,
      ),
    })
    const decodeArm = (arm: string): string | undefined => {
      if (!arm.startsWith('case:')) return undefined
      try {
        const value = JSON.parse(
          Buffer.from(arm.slice(5), 'base64url').toString('utf8'),
        ) as unknown
        return Array.isArray(value) && typeof value[1] === 'string'
          ? value[1] : undefined
      } catch { return undefined }
    }
    const mapping = (built: ReturnType<typeof build>) => {
      const owner = symbol(built.nodes, 'process')
      const all = facts(built.nodes, owner)
      const condition = all.find((fact): fact is Extract<
        IndexBodyFact,
        { kind: 'condition' }
      > =>
        fact.kind === 'condition' && fact.condition_kind === 'switch'
        && JSON.stringify(fact.test) === JSON.stringify(selector))
      const persisted = all.filter((fact) => fact.kind === 'persistence')
      return {
        body: owner[1].body_facts,
        condition,
        labels: all.flatMap((fact) => fact.control.flatMap((frame) =>
          frame.kind === 'branch' ? [decodeArm(frame.arm)] : [])),
        arms: condition ? persisted.flatMap((fact) =>
          fact.control.flatMap((frame) =>
            frame.kind === 'branch'
            && frame.controller_fact_id === condition.id
              ? [decodeArm(frame.arm)] : [])) : [],
      }
    }
    const dispatch = (built: ReturnType<typeof build>) => {
      const owner = symbol(built.nodes, 'dispatch')
      const edge = outgoing(built.edges, owner[0], 'publishes_to')[0]
      const call = facts(built.nodes, owner, 'call').find((fact): fact is Extract<
        IndexBodyFact,
        { kind: 'call' }
      > =>
        fact.kind === 'call' && fact.arguments.length >= 2)
      return { edge, call }
    }
    const selectedPersistence = (built: ReturnType<typeof build>) => {
      const published = dispatch(built)
      const target = published.edge?.[1]
      const channel = target
        ? built.nodes.get(target)?.parent_channel_id ?? target
        : undefined
      const consumer = channel && built.edges.some(([from, to, attributes]) =>
        from === channel && to === symbol(built.nodes, 'process')[0]
        && attributes.relation === 'consumed_by')
      const position = published.edge?.[2].dispatch_payload_argument
      const argument = typeof position === 'number'
        ? published.call?.arguments[position] : undefined
      const trigger = argument?.kind === 'object'
        ? argument.entries.find((entry) => entry.key === 'trigger')?.value
        : undefined
      const value = trigger?.kind === 'literal'
        && typeof trigger.value === 'string' ? trigger.value : undefined
      const persisted = consumer
        ? mapping(built).arms.filter((arm) => arm === value)
        : []
      return { trigger: value, persisted, consumer }
    }
    const selector = {
      kind: 'template',
      parts: [
        { kind: 'parameter', position: 0 },
        { kind: 'literal', value: 'data' },
        { kind: 'literal', value: 'trigger' },
      ],
    }

    const baseDispatch = dispatch(baseline)
    const changedDispatch = dispatch(changed)
    expect(baseDispatch.edge?.[2]).toMatchObject({
      dispatch_payload_argument: 1,
    })
    expect(selectedPersistence(baseline).consumer).toBe(true)
    expect(JSON.stringify(baseDispatch.call?.arguments[1]))
      .toContain('assembly_complete')
    expect(JSON.stringify(changedDispatch.call?.arguments[1]))
      .toContain('status_change')
    expect(baseDispatch.edge?.[2].evidence).not.toEqual(
      changedDispatch.edge?.[2].evidence,
    )

    const baseMap = mapping(baseline)
    const movedMap = mapping(moved)
    const removedMap = mapping(removed)
    expect(baseMap.condition?.test).toMatchObject(selector)
    expect(movedMap.condition?.test).toMatchObject(selector)
    expect(removedMap.condition?.test).toMatchObject(selector)
    expect(baseMap.arms).toEqual(expect.arrayContaining([...complete]))
    expect(movedMap.labels).toEqual(expect.arrayContaining([...complete]))
    expect(movedMap.body).not.toEqual(baseMap.body)
    expect(movedMap.arms).not.toContain('assembly_complete')
    expect(removedMap.arms).toEqual(expect.arrayContaining([
      'section_complete',
      'status_change',
    ]))
    expect(removedMap.arms).not.toContain('assembly_complete')
    expect(mapping(unproven).condition?.test).not.toMatchObject(selector)
    expect(mapping(collision).labels).toContain('assembly_complete')
    expect(mapping(collision).arms).toEqual(['status_change'])
    expect(selectedPersistence(baseline)).toEqual({
      trigger: 'assembly_complete',
      persisted: ['assembly_complete'],
      consumer: true,
    })
    expect(selectedPersistence(changed)).toEqual({
      trigger: 'status_change',
      persisted: ['status_change'],
      consumer: true,
    })
    expect(selectedPersistence(moved)).toEqual({
      trigger: 'assembly_complete',
      persisted: [],
      consumer: true,
    })
    expect(selectedPersistence(removed)).toEqual({
      trigger: 'assembly_complete',
      persisted: [],
      consumer: true,
    })
    expect(selectedPersistence(collision)).toEqual({
      trigger: 'assembly_complete',
      persisted: [],
      consumer: true,
    })
  })

  it('preserves secret taint through nested object keys', () => {
    const source = `export const SETTINGS = {
  credentials: { value: 'hunter2' },
}
`
    const { nodes } = build({ 'src/nested-secret.ts': source })
    expect(JSON.stringify(
      facts(nodes, symbol(nodes, 'SETTINGS'), 'literal'),
    )).not.toContain('hunter2')
  })

  it('does not reuse a reassigned injected Queue identity', () => {
    const source = `import { InjectQueue } from '@nestjs/bullmq'
import type { Queue } from 'bullmq'
export class Service {
  constructor(@InjectQueue('reports') private queue: Queue) {}
  replace(queue: Queue): void { this.queue = queue }
  publish() { return this.queue.add('complete', {}) }
}
`
    const { nodes, edges } = build({ 'src/injected-reassign.ts': source })
    expect(publishedQueueKeys(
      nodes,
      edges,
      symbol(nodes, 'Service.publish')[0],
    )).not.toContain('reports')
  })

  it('does not prove stale Promise lanes after array mutation', () => {
    const source = `declare function task(value: string): Promise<string>
const BATCHES = [['a'], ['b']]
BATCHES.push(['c'])
export async function run(): Promise<void> {
  await Promise.allSettled(BATCHES.map((batch) => task(batch[0]!)))
}
`
    const { nodes } = build({ 'src/mutable-lanes.ts': source })
    expect(facts(nodes, symbol(nodes, 'run'), 'parallel')).toEqual([])
  })

  it('does not reuse a reassigned typed emitter scope', () => {
    const source = `import { EventEmitter } from 'node:events'
export class Service {
  constructor(private events: EventEmitter) {}
  replace(events: EventEmitter): void { this.events = events }
  publish(): void { this.events.emit('ready') }
}
`
    const { nodes, edges } = build({ 'src/emitter-reassign.ts': source })
    expect(outgoing(
      edges,
      symbol(nodes, 'Service.publish')[0],
      'publishes_to',
    )).toEqual([])
  })

  it('does not prove Map topology from an uninvoked function', () => {
    const source = `import { Queue } from 'bullmq'
const queues = new Map<string, Queue>()
function neverCalled(): void {
  queues.set('alias', new Queue('real'))
}
export function publish() {
  return queues.get('alias')!.add('complete', {})
}
`
    const { nodes, edges } = build({ 'src/uninvoked-map.ts': source })
    expect(publishedQueueKeys(
      nodes,
      edges,
      symbol(nodes, 'publish')[0],
    )).toEqual([])
  })

  it('accepts Map topology only from an authenticated Nest lifecycle root', () => {
    const source = `import { Injectable, OnModuleInit } from '@nestjs/common'
import { Queue } from 'bullmq'
const CONFIGS = [{ name: 'reports' }]
@Injectable()
class Registry implements OnModuleInit {
  private queues = new Map<string, Queue>()
  onModuleInit(): void {
    for (const config of CONFIGS) {
      this.queues.set(config.name, new Queue(config.name))
    }
  }
  add(name: string) { return this.queues.get(name)!.add('complete', {}) }
}
class Plain implements OnModuleInit {
  private queues = new Map<string, Queue>()
  onModuleInit(): void {
    for (const config of CONFIGS) {
      this.queues.set(config.name, new Queue(config.name))
    }
  }
  add(name: string) { return this.queues.get(name)!.add('complete', {}) }
}
@Injectable()
class Dead implements OnModuleInit {
  private queues = new Map<string, Queue>()
  onModuleInit(): void {
    return
    this.queues.set('alias', new Queue('dead'))
  }
  add(name: string) { return this.queues.get(name)!.add('complete', {}) }
}
@Injectable()
class Disabled implements OnModuleInit {
  private queues = new Map<string, Queue>()
  onModuleInit(): void {
    if (false) this.queues.set('alias', new Queue('disabled'))
  }
  add(name: string) { return this.queues.get(name)!.add('complete', {}) }
}
@Injectable()
class Conditional implements OnModuleInit {
  private queues = new Map<string, Queue>()
  constructor(private enabled: boolean) {}
  onModuleInit(): void {
    if (this.enabled) this.queues.set('alias', new Queue('conditional'))
  }
  add(name: string) { return this.queues.get(name)!.add('complete', {}) }
}
@Injectable()
class PossiblyEmpty implements OnModuleInit {
  private queues = new Map<string, Queue>()
  constructor(private configs: Array<{ name: string }>) {}
  onModuleInit(): void {
    for (const config of this.configs)
      this.queues.set(config.name, new Queue(config.name))
  }
  add(name: string) { return this.queues.get(name)!.add('complete', {}) }
}
export function managed(registry: Registry) { return registry.add('reports') }
export function unregistered(registry: Plain) { return registry.add('reports') }
export function dead(registry: Dead) { return registry.add('alias') }
export function disabled(registry: Disabled) { return registry.add('alias') }
export function conditional(registry: Conditional) { return registry.add('alias') }
export function possiblyEmpty(registry: PossiblyEmpty) { return registry.add('reports') }
`
    const { nodes, edges } = build({ 'src/nest-lifecycle.ts': source })
    expect(publishedQueueKeys(
      nodes,
      edges,
      symbol(nodes, 'managed')[0],
    )).toEqual(['reports'])
    expect(publishedQueueKeys(
      nodes,
      edges,
      symbol(nodes, 'unregistered')[0],
    )).toEqual([])
    for (const name of ['dead', 'disabled', 'conditional', 'possiblyEmpty']) {
      expect(publishedQueueKeys(nodes, edges, symbol(nodes, name)[0])).toEqual([])
    }
  })

  it('invalidates Map topology after mutation through a stable alias', () => {
    const source = `import { Queue } from 'bullmq'
const queues = new Map<string, Queue>()
queues.set('alias', new Queue('real'))
const alias = queues
alias.clear()
export function publish() {
  return queues.get('alias')!.add('complete', {})
}
`
    const { nodes, edges } = build({ 'src/aliased-map.ts': source })
    expect(publishedQueueKeys(
      nodes,
      edges,
      symbol(nodes, 'publish')[0],
    )).toEqual([])
  })

  it('invalidates topology through container and later-assigned aliases', () => {
    const source = `import { Queue } from 'bullmq'
const contained = new Map<string, Queue>()
contained.set('alias', new Queue('contained'))
const holder = { contained }
holder.contained.clear()
const assigned = new Map<string, Queue>()
assigned.set('alias', new Queue('assigned'))
let alias: Map<string, Queue>
alias = assigned
alias.clear()
const destructured = new Map<string, Queue>()
destructured.set('alias', new Queue('destructured'))
const wrapper = { destructured }
const { destructured: destructuredAlias } = wrapper
destructuredAlias.clear()
export function fromContainer() {
  return contained.get('alias')!.add('complete', {})
}
export function fromAssignment() {
  return assigned.get('alias')!.add('complete', {})
}
export function fromDestructure() {
  return destructured.get('alias')!.add('complete', {})
}
`
    const { nodes, edges } = build({ 'src/indirect-aliases.ts': source })
    for (const name of ['fromContainer', 'fromAssignment', 'fromDestructure']) {
      expect(publishedQueueKeys(nodes, edges, symbol(nodes, name)[0])).toEqual([])
    }
  })

  it('invalidates Promise lanes after mutation through a stable alias', () => {
    const source = `declare function task(value: string): Promise<string>
const BATCHES = [['a'], ['b']]
const alias = BATCHES
alias.push(['c'])
export async function run(): Promise<void> {
  await Promise.allSettled(BATCHES.map((batch) => task(batch[0]!)))
}
`
    const { nodes } = build({ 'src/aliased-lanes.ts': source })
    expect(facts(nodes, symbol(nodes, 'run'), 'parallel')).toEqual([])
  })

  it('does not collapse EventEmitter properties across runtime instances', () => {
    const source = `import { EventEmitter } from 'node:events'
export function handle(): void {}
export class Service {
  private readonly events = new EventEmitter()
  publish(): void { this.events.emit('ready') }
  consume(): void { this.events.on('ready', handle) }
}
export function wire(): void {
  const producer = new Service()
  const consumer = new Service()
  producer.publish()
  consumer.consume()
}
`
    const { nodes } = build({ 'src/instance-events.ts': source })
    expect(channels(nodes, (node) =>
      node.channel_kind === 'event' && node.key === 'ready')).toEqual([])
  })

  it('models try-catch-finally completion without indexing dead tails', () => {
    const source = `declare function cleanup(): void
declare function dead(): void
declare function reachable(): void
export function finalReturn(): void {
  try { return } finally { cleanup() }
  dead()
}
export function caughtThrow(): void {
  try { throw new Error('stop') } catch {}
  reachable()
}
export function caughtReturn(): void {
  try { throw new Error('stop') } catch { return }
  dead()
}
export function overridden(): void {
  try {
    try { return } finally { throw new Error('override') }
  } catch {}
  reachable()
}
export function exhaustiveSwitch(code: 1 | 2): void {
  try {
    switch (code) {
      case 1: return
      case 2: return
      default: return
    }
  } finally { cleanup() }
  dead()
}
`
    const { nodes } = build({ 'src/try-completion.ts': source })
    expect(facts(nodes, symbol(nodes, 'finalReturn'), 'call')
      .some((fact) => fact.kind === 'call' && fact.callee === 'dead')).toBe(false)
    expect(facts(nodes, symbol(nodes, 'caughtThrow'), 'call')
      .some((fact) => fact.kind === 'call' && fact.callee === 'reachable')).toBe(true)
    expect(facts(nodes, symbol(nodes, 'caughtReturn'), 'call')
      .some((fact) => fact.kind === 'call' && fact.callee === 'dead')).toBe(false)
    expect(facts(nodes, symbol(nodes, 'overridden'), 'call')
      .some((fact) => fact.kind === 'call' && fact.callee === 'reachable')).toBe(true)
    expect(facts(nodes, symbol(nodes, 'exhaustiveSwitch'), 'call')
      .some((fact) => fact.kind === 'call' && fact.callee === 'dead')).toBe(false)
  })

  it('omits the impossible direct path for a duplicate switch case', () => {
    const source = `declare function first(): void
declare function second(): void
export function run(code: number): void {
  switch (code) {
    case 1:
      first()
    case 1:
      second()
      break
  }
}
enum Code { First = 1, Alias = 1 }
export function enumRun(code: Code): void {
  switch (code) {
    case Code.First:
      first()
    case Code.Alias:
      second()
      break
  }
}
export function zeroRun(code: number): void {
  switch (code) {
    case 0:
      first()
    case -0:
      second()
      break
  }
}
`
    const { nodes } = build({ 'src/duplicate-case.ts': source })
    expect(facts(nodes, symbol(nodes, 'run'), 'call')
      .filter((fact) => fact.kind === 'call' && fact.callee === 'second'))
      .toHaveLength(1)
    expect(facts(nodes, symbol(nodes, 'enumRun'), 'call')
      .filter((fact) => fact.kind === 'call' && fact.callee === 'second'))
      .toHaveLength(1)
    expect(facts(nodes, symbol(nodes, 'zeroRun'), 'call')
      .filter((fact) => fact.kind === 'call' && fact.callee === 'second'))
      .toHaveLength(1)
  })

  it('substitutes wrapper conditions before propagating persistence', () => {
    const source = `import { writeFile } from 'node:fs/promises'
async function maybePersist(enabled: boolean, path: string): Promise<void> {
  if (enabled) await writeFile(path, 'ready')
}
export async function disabled(): Promise<void> {
  await maybePersist(false, 'disabled.json')
}
export async function enabled(): Promise<void> {
  await maybePersist(true, 'enabled.json')
}
async function afterGuard(skip: boolean, path: string): Promise<void> {
  if (skip) return
  await writeFile(path, 'ready')
}
export async function skipped(): Promise<void> {
  await afterGuard(true, 'skipped.json')
}
export async function continued(): Promise<void> {
  await afterGuard(false, 'continued.json')
}
async function equalityGuard(enabled: boolean, path: string): Promise<void> {
  if (enabled === false) return
  await writeFile(path, 'ready')
}
export async function equalityDisabled(): Promise<void> {
  await equalityGuard(false, 'equality-disabled.json')
}
export async function equalityEnabled(): Promise<void> {
  await equalityGuard(true, 'equality-enabled.json')
}
async function negated(enabled: boolean, path: string): Promise<void> {
  if (!enabled) return
  await writeFile(path, 'ready')
}
export async function negatedDisabled(): Promise<void> {
  await negated(false, 'negated-disabled.json')
}
export async function negatedEnabled(): Promise<void> {
  await negated(true, 'negated-enabled.json')
}
async function defaults(enabled = false, path = 'default.json'): Promise<void> {
  if (!enabled) return
  await writeFile(path, 'ready')
}
export async function omitted(): Promise<void> {
  await defaults()
}
async function insideTry(path: string): Promise<void> {
  try { await writeFile(path, 'ready') } finally {}
}
export async function tried(): Promise<void> {
  await insideTry('tried.json')
}
`
    const { nodes } = build({ 'src/conditional-wrapper.ts': source })
    expect(facts(nodes, symbol(nodes, 'disabled'), 'persistence')).toEqual([])
    expect(facts(nodes, symbol(nodes, 'enabled'), 'persistence')).toEqual([
      expect.objectContaining({
        operation: 'file_write',
        resource: { kind: 'literal', value: 'enabled.json' },
      }),
    ])
    expect(facts(nodes, symbol(nodes, 'skipped'), 'persistence')).toEqual([])
    expect(facts(nodes, symbol(nodes, 'continued'), 'persistence')).toEqual([
      expect.objectContaining({
        operation: 'file_write',
        resource: { kind: 'literal', value: 'continued.json' },
      }),
    ])
    expect(facts(nodes, symbol(nodes, 'equalityDisabled'), 'persistence')).toEqual([])
    expect(facts(nodes, symbol(nodes, 'equalityEnabled'), 'persistence')).toEqual([
      expect.objectContaining({
        resource: { kind: 'literal', value: 'equality-enabled.json' },
      }),
    ])
    expect(facts(nodes, symbol(nodes, 'negatedDisabled'), 'persistence')).toEqual([])
    expect(facts(nodes, symbol(nodes, 'negatedEnabled'), 'persistence')).toEqual([
      expect.objectContaining({ resource: { kind: 'literal', value: 'negated-enabled.json' } }),
    ])
    expect(facts(nodes, symbol(nodes, 'omitted'), 'persistence')).toEqual([])
    expect(facts(nodes, symbol(nodes, 'tried'), 'persistence')).toEqual([
      expect.objectContaining({ resource: { kind: 'literal', value: 'tried.json' } }),
    ])
  })

  it('does not propagate effects through reassigned callable identities', () => {
    const source = `import { writeFile } from 'node:fs/promises'
async function persist(path: string): Promise<void> {
  await writeFile(path, 'ready')
}
async function ignore(_path: string): Promise<void> {}
async function assignedPersist(path: string): Promise<void> {
  await writeFile(path, 'ready')
}
let selected = persist
selected = ignore
const holder = { selected: persist }
holder.selected = ignore
const assigned = { selected: assignedPersist }
Object.assign(assigned, { selected: ignore })
const defined = { selected: persist }
Object.defineProperty(defined, 'selected', { value: ignore })
export async function run(): Promise<void> {
  await selected('first.json')
  await holder.selected('second.json')
  await assigned.selected('third.json')
  await defined.selected('fourth.json')
}
`
    const { nodes } = build({ 'src/reassigned-callable.ts': source })
    expect(facts(nodes, symbol(nodes, 'run'), 'persistence')).toEqual([])
  })
})
