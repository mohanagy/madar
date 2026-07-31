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
})
