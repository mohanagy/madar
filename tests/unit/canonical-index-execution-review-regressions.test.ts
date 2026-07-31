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
