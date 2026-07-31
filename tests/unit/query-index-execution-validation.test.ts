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
import { computeBuildId } from '../../src/domain/index/build-state.js'
import {
  indexBodyFactId,
  indexChannelId,
  type IndexBodyFact,
} from '../../src/domain/index/model.js'
import {
  inspectQueryIndex,
  type ReadyQueryIndex,
} from '../../src/domain/query/index-status.js'

const roots: string[] = []
const wireKinds = [
  'condition', 'loop', 'parallel', 'call', 'literal',
  'mutation', 'persistence', 'return', 'throw',
] as const satisfies readonly IndexBodyFact['kind'][]

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function resign(
  graph: ReturnType<typeof loadGraphArtifact>,
): void {
  const current = graph.graph.index_build as Record<string, unknown>
  graph.graph.index_build = { ...current, build_id: '' }
  graph.graph.index_build = {
    ...current,
    build_id: computeBuildId(graph),
  }
}

type Fixture = {
  graph: ReturnType<typeof loadGraphArtifact>
  root: string
  source: string
  sourcePath: string
  runId: string
  queueId: string
  dynamicQueueId: string
  jobId: string
  eventId: string
  operationIds: readonly string[]
}

function ready(value: ReturnType<typeof inspectQueryIndex>): ReadyQueryIndex {
  if (value.state !== 'ready') {
    throw new Error(`Expected ready index, received ${value.state}: ${value.subject}`)
  }
  return value
}

function fixture(bom = false): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'madar-query-execution-'))
  roots.push(root)
  const source = `${bom ? '\uFEFF' : ''}import type { MongoRepository } from 'typeorm'

type RecordRow = { id: string }

export async function run(
  repository: MongoRepository<RecordRow>,
  enabled: boolean,
): Promise<unknown> {
  if (enabled) {
    await repository.update('record-1', { id: 'record-1' })
  }
  const values = await Promise.all([Promise.resolve(1), Promise.resolve(2)])
  return values
}
`
  const sourcePath = join(root, 'src/run.ts')
  mkdirSync(dirname(sourcePath), { recursive: true })
  writeFileSync(sourcePath, source, 'utf8')
  const generated = generateIndex(root)
  const graph = loadGraphArtifact(generated.graphPath)
  const run = graph.nodeEntries().find(([, attributes]) =>
    attributes.qualified_name === 'run')
  if (!run) throw new Error('Execution validation fixture is incomplete')
  const [runId] = run
  const initial = ready(inspectQueryIndex(graph))
  const operations = initial.operations_by_owner.get(runId)
  if (!operations?.length) {
    throw new Error('Execution validation fixture has no generated operations')
  }
  const proof = operations[0]!.evidence

  const queueId = indexChannelId({
    channel_kind: 'queue',
    transport: 'bullmq',
    key: 'reports',
  })
  const dynamicQueueId = indexChannelId({
    channel_kind: 'queue',
    transport: 'bullmq',
    key: 'dynamic-jobs',
  })
  const jobId = indexChannelId({
    channel_kind: 'job',
    transport: 'bullmq',
    key: 'complete',
    parent_channel_id: queueId,
  })
  const eventId = indexChannelId({
    channel_kind: 'event',
    transport: 'node-event-emitter',
    key: 'report.ready',
    scope: 'instance:events',
  })
  graph.addNode(queueId, {
    node_kind: 'channel',
    channel_kind: 'queue',
    transport: 'bullmq',
    key: 'reports',
  })
  graph.addNode(jobId, {
    node_kind: 'channel',
    channel_kind: 'job',
    transport: 'bullmq',
    key: 'complete',
    parent_channel_id: queueId,
  })
  graph.addNode(dynamicQueueId, {
    node_kind: 'channel',
    channel_kind: 'queue',
    transport: 'bullmq',
    key: 'dynamic-jobs',
  })
  graph.addNode(eventId, {
    node_kind: 'channel',
    channel_kind: 'event',
    transport: 'node-event-emitter',
    key: 'report.ready',
    scope: 'instance:events',
  })
  const channelEvidence = {
    source_file: 'src/run.ts',
    execution_owner_id: runId,
    evidence: {
      source: 'typescript-syntactic',
      range: proof.range,
      statement_range: proof.statement_range,
      excerpt_sha256: proof.excerpt_sha256,
    },
  }
  graph.addEdge(runId, jobId, {
    relation: 'publishes_to',
    ...channelEvidence,
  })
  graph.addEdge(runId, dynamicQueueId, {
    relation: 'publishes_to',
    ...channelEvidence,
  })
  graph.addEdge(jobId, queueId, {
    relation: 'routes_through',
    ...channelEvidence,
  })
  graph.addEdge(queueId, runId, {
    relation: 'consumed_by',
    ...channelEvidence,
  })
  graph.addEdge(runId, eventId, {
    relation: 'publishes_to',
    ...channelEvidence,
  })
  graph.addEdge(eventId, runId, {
    relation: 'consumed_by',
    ...channelEvidence,
  })
  resign(graph)
  return {
    graph,
    root,
    source,
    sourcePath,
    runId,
    queueId,
    dynamicQueueId,
    jobId,
    eventId,
    operationIds: operations.map((operation) => operation.id),
  }
}

function bodyFactWireRows(
  graph: Fixture['graph'],
  runId: string,
): string[] {
  const table = graph.nodeAttributes(runId).body_facts
  if (!Array.isArray(table) || table[0] !== 1 || !Array.isArray(table[1])
    || table[1].some((row) => typeof row !== 'string')) {
    throw new Error('Expected compact execution fact table fixture')
  }
  return [...table[1]] as string[]
}

function parsedBodyFactRows(
  graph: Fixture['graph'],
  runId: string,
): unknown[][] {
  return bodyFactWireRows(graph, runId).map((value) => {
    const row = JSON.parse(value) as unknown
    if (!Array.isArray(row)) throw new Error('Expected execution fact wire row')
    return row
  })
}

function replaceBodyFactWireRows(
  graph: Fixture['graph'],
  runId: string,
  rows: readonly unknown[],
): void {
  const attributes = graph.nodeAttributes(runId)
  graph.replaceNodeAttributes(runId, {
    ...attributes,
    body_facts: [1, rows],
  })
}

function mutateBodyFactWireRows(
  graph: Fixture['graph'],
  runId: string,
  mutate: (rows: unknown[][]) => void,
): void {
  const rows = parsedBodyFactRows(graph, runId)
  mutate(rows)
  replaceBodyFactWireRows(
    graph,
    runId,
    rows.map((row) => JSON.stringify(row)),
  )
}

function rowOfKind(rows: unknown[][], kind: number): unknown[] {
  const row = rows.find((candidate) => candidate[1] === kind)
  if (!row) throw new Error(`Expected wire fact kind ${kind}`)
  return row
}

function controlRows(row: unknown[]): unknown[][] {
  const controls = row[6]
  if (!Array.isArray(controls)
    || controls.some((control) => !Array.isArray(control))) {
    throw new Error('Expected wire control rows')
  }
  return controls as unknown[][]
}

function payload(row: unknown[]): unknown[] {
  if (!Array.isArray(row[9])) throw new Error('Expected wire payload')
  return row[9]
}

describe('query execution index validation', () => {
  it('builds deeply immutable generated operation and channel indexes', () => {
    const current = fixture()
    const value = ready(inspectQueryIndex(current.graph))
    const operations = value.operations_by_owner.get(current.runId)
    const operation = value.operation_by_id.get(current.operationIds[0]!)
    const reports = value.channels_by_key.get('reports')

    expect(operations?.map((fact) => fact.kind)).toEqual(expect.arrayContaining([
      'condition',
      'parallel',
      'persistence',
      'return',
    ]))
    expect(operation).toBeDefined()
    expect(value.operations_by_owner.get(operation!.owner_symbol_id))
      .toEqual(operations)
    expect(reports).toEqual([
      expect.objectContaining({
        channel_kind: 'queue',
        transport: 'bullmq',
        key: 'reports',
      }),
    ])
    expect(value.channels_by_key.get('complete')).toEqual([
      expect.objectContaining({
        channel_kind: 'job',
        parent_channel_id: reports![0]!.id,
      }),
    ])
    expect(value.channels_by_key.get('dynamic-jobs')).toEqual([
      expect.objectContaining({
        channel_kind: 'queue',
        key: 'dynamic-jobs',
      }),
    ])
    expect(value.channels_by_key.get('report.ready')).toEqual([
      expect.objectContaining({
        channel_kind: 'event',
        scope: 'instance:events',
      }),
    ])
    expect(Object.isFrozen(operation)).toBe(true)
    expect(Object.isFrozen(operation!.evidence)).toBe(true)
    expect(Object.isFrozen(operations)).toBe(true)
    expect(Object.isFrozen(reports)).toBe(true)
    expect((value.operation_by_id as Map<string, unknown>).set).toBeUndefined()
    expect(Object.hasOwn(
      value.graph.nodeAttributes(current.runId),
      'body_facts',
    )).toBe(false)
  })

  it.each([
    {
      name: 'a sparse compact row slot',
      mutate: ({ graph, runId }: Fixture) => {
        const rows: unknown[] = bodyFactWireRows(graph, runId)
        rows[1] = null
        replaceBodyFactWireRows(graph, runId, rows)
      },
    },
    {
      name: 'a noncanonical compact row',
      mutate: ({ graph, runId }: Fixture) => {
        const rows = bodyFactWireRows(graph, runId)
        rows[0] = rows[0]!.replace(',', ', ')
        replaceBodyFactWireRows(graph, runId, rows)
      },
    },
    {
      name: 'reordered compact rows',
      mutate: ({ graph, runId }: Fixture) => {
        const rows = bodyFactWireRows(graph, runId)
        ;[rows[0], rows[1]] = [rows[1]!, rows[0]!]
        replaceBodyFactWireRows(graph, runId, rows)
      },
    },
    {
      name: 'an invalid excerpt hash',
      mutate: ({ graph, runId }: Fixture) => {
        mutateBodyFactWireRows(graph, runId, (rows) => {
          const evidence = rows[0]![5]
          if (!Array.isArray(evidence)) throw new Error('Missing wire evidence')
          evidence[8] = 'not-a-hash'
        })
      },
    },
    {
      name: 'a well-shaped replaced excerpt hash',
      mutate: ({ graph, runId }: Fixture) => {
        mutateBodyFactWireRows(graph, runId, (rows) => {
          const evidence = rows[0]![5]
          if (!Array.isArray(evidence)) throw new Error('Missing wire evidence')
          evidence[8] = 'a'.repeat(64)
        })
      },
    },
    {
      name: 'a statement outside its owner range',
      mutate: ({ graph, runId }: Fixture) => {
        mutateBodyFactWireRows(graph, runId, (rows) => {
          const evidence = rows[0]![5]
          if (!Array.isArray(evidence)) throw new Error('Missing wire evidence')
          evidence[6] = 99
          evidence[7] = 1
        })
      },
    },
    {
      name: 'a wrong authenticated operation id',
      mutate: ({ graph, runId }: Fixture) => {
        mutateBodyFactWireRows(graph, runId, (rows) => {
          rows[0]![0] = `operation:${'f'.repeat(32)}`
        })
      },
    },
    {
      name: 'duplicate branch controls',
      mutate: ({ graph, runId }: Fixture) => {
        mutateBodyFactWireRows(graph, runId, (rows) => {
          const row = rows.find((candidate) =>
            candidate[1] === 3
            && controlRows(candidate).some((control) => control[0] === 0))
          if (!row) throw new Error('Expected branch-controlled call')
          const branch = controlRows(row).find((control) => control[0] === 0)!
          controlRows(row).push([...branch])
        })
      },
    },
    {
      name: 'an incompatible branch arm',
      mutate: ({ graph, runId }: Fixture) => {
        mutateBodyFactWireRows(graph, runId, (rows) => {
          const row = rows.find((candidate) =>
            candidate[1] === 3
            && controlRows(candidate).some((control) => control[0] === 0))
          if (!row) throw new Error('Expected branch-controlled call')
          const branch = controlRows(row).find((control) => control[0] === 0)!
          branch[2] = 'truthy'
        })
      },
    },
    {
      name: 'a null persistence receiver',
      mutate: ({ graph, runId }: Fixture) => {
        mutateBodyFactWireRows(graph, runId, (rows) => {
          payload(rowOfKind(rows, 6))[3] = null
        })
      },
    },
    {
      name: 'an unrelated persistence call target',
      mutate: ({ graph, runId }: Fixture) => {
        mutateBodyFactWireRows(graph, runId, (rows) => {
          const persistence = payload(rowOfKind(rows, 6))
          const unrelated = rows.findIndex((row, ordinal) =>
            row[1] === 3 && ordinal !== persistence[1])
          if (unrelated < 0) throw new Error('Expected unrelated call')
          persistence[1] = unrelated
        })
      },
    },
    {
      name: 'dropped persistence control context',
      mutate: ({ graph, runId }: Fixture) => {
        mutateBodyFactWireRows(graph, runId, (rows) => {
          rowOfKind(rows, 6)[6] = []
        })
      },
    },
    {
      name: 'an unrelated parallel member',
      mutate: ({ graph, runId }: Fixture) => {
        mutateBodyFactWireRows(graph, runId, (rows) => {
          const parallelOrdinal = rows.findIndex((row) => row[1] === 2)
          if (parallelOrdinal < 0) throw new Error('Expected parallel fact')
          const members = payload(rows[parallelOrdinal]!)[2]
          if (!Array.isArray(members)) throw new Error('Expected parallel members')
          const unrelated = rows.findIndex((row, ordinal) =>
            row[1] === 3
            && !members.includes(ordinal)
            && !controlRows(row).some((control) =>
              control[0] === 2 && control[1] === parallelOrdinal))
          if (unrelated < 0) throw new Error('Expected unrelated parallel call')
          members[0] = unrelated
        })
      },
    },
    {
      name: 'a parallel lane at lane_count',
      mutate: ({ graph, runId }: Fixture) => {
        mutateBodyFactWireRows(graph, runId, (rows) => {
          const parallelOrdinal = rows.findIndex((row) => row[1] === 2)
          if (parallelOrdinal < 0) throw new Error('Expected parallel fact')
          const laneCount = payload(rows[parallelOrdinal]!)[3]
          const member = rows.find((row) =>
            controlRows(row).some((control) =>
              control[0] === 2 && control[1] === parallelOrdinal))
          if (!member || typeof laneCount !== 'number') {
            throw new Error('Expected parallel member and lane count')
          }
          const frame = controlRows(member).find((control) =>
            control[0] === 2 && control[1] === parallelOrdinal)!
          frame[2] = laneCount
        })
      },
    },
    {
      name: 'a channel descriptor changed without its canonical ID',
      mutate: ({ graph, queueId }: Fixture) => {
        graph.replaceNodeAttributes(queueId, {
          ...graph.nodeAttributes(queueId),
          key: 'forged-reports',
        })
      },
    },
    {
      name: 'a missing job parent',
      mutate: ({ graph, jobId }: Fixture) => {
        graph.replaceNodeAttributes(jobId, {
          ...graph.nodeAttributes(jobId),
          parent_channel_id: 'channel:bullmq:queue:missing',
        })
      },
    },
    {
      name: 'reversed publish endpoints',
      mutate: ({ graph, runId, jobId }: Fixture) => {
        graph.addEdge(jobId, runId, { relation: 'publishes_to' })
      },
    },
    {
      name: 'a channel relation without authenticated evidence',
      mutate: ({ graph, runId, queueId }: Fixture) => {
        graph.addEdge(runId, queueId, { relation: 'publishes_to' })
      },
    },
    {
      name: 'an unscoped event',
      mutate: ({ graph, eventId }: Fixture) => {
        const attributes = graph.nodeAttributes(eventId)
        delete attributes.scope
        graph.replaceNodeAttributes(eventId, attributes)
      },
    },
  ])('rejects $name as corrupt after re-signing', ({ mutate }) => {
    const value = fixture()
    mutate(value)
    resign(value.graph)

    expect(inspectQueryIndex(value.graph)).toMatchObject({
      state: 'corrupt',
    })
  })

  it('rejects a structurally self-consistent forged fact at retrieval', () => {
    const current = fixture()
    mutateBodyFactWireRows(current.graph, current.runId, (rows) => {
      const parallel = rowOfKind(rows, 2)
      const members = payload(parallel)[2]
      if (!Array.isArray(members) || typeof members[0] !== 'number') {
        throw new Error('Expected parallel member ordinal')
      }
      const member = rows[members[0]]
      if (!member) throw new Error('Expected parallel member row')
      const evidence = member[5]
      if (!Array.isArray(evidence)) throw new Error('Expected member evidence')
      const forgedHash = 'b'.repeat(64)
      evidence[8] = forgedHash
      const kindOrdinal = member[1]
      if (typeof kindOrdinal !== 'number' || !wireKinds[kindOrdinal]) {
        throw new Error('Expected wire fact kind')
      }
      member[0] = indexBodyFactId(
        current.runId,
        wireKinds[kindOrdinal]!,
        [member[2], kindOrdinal, member[3], member[4]] as number[],
        forgedHash,
      )
    })
    resign(current.graph)
    const structurallyReady = ready(inspectQueryIndex(current.graph))

    const result = retrieveContext(structurallyReady, {
      question: 'Explain the `run` function.',
      budget: 4_000,
    })
    expect(result.outcome).toBe('corrupt')
    expect(result.matched_nodes).toEqual([])
    expect(result.boundaries).toContainEqual({
      kind: 'corrupt',
      subject: current.runId,
    })
  })

  it('authenticates selected-owner channel edge bytes before returning evidence', () => {
    const current = fixture()
    const edge = current.graph.edgeEntries().find(([from, , attributes]) =>
      from === current.runId && attributes.relation === 'publishes_to')
    if (!edge) throw new Error('Expected generated channel edge')
    const attributes = structuredClone(edge[2])
    const evidence = attributes.evidence as Record<string, unknown>
    evidence.excerpt_sha256 = 'c'.repeat(64)
    const forgedId = current.graph.addEdge(edge[0], edge[1], attributes)
    resign(current.graph)
    const index = ready(inspectQueryIndex(current.graph))

    const result = retrieveContext(index, {
      question: 'Explain the `run` function.',
      budget: 4_000,
    })
    expect(result.outcome).toBe('corrupt')
    expect(result.boundaries).toContainEqual({
      kind: 'corrupt',
      subject: forgedId,
    })
  })

  it('reports stale when selected-owner source bytes change', () => {
    const current = fixture()
    const index = ready(inspectQueryIndex(current.graph))
    writeFileSync(
      current.sourcePath,
      current.source.replace('return values', 'return values.slice()'),
      'utf8',
    )

    const result = retrieveContext(index, {
      question: 'Where is the `run` function defined?',
      budget: 4_000,
    })

    expect(result.outcome).toBe('stale')
    expect(result.matched_nodes).toEqual([])
    expect(result.boundaries).toContainEqual({
      kind: 'stale',
      subject: 'src/run.ts',
    })
  })

  it('authenticates operation ranges generated from a BOM-prefixed source', () => {
    const current = fixture(true)
    const result = retrieveContext(ready(inspectQueryIndex(current.graph)), {
      question: 'Where is the `run` function defined?',
      budget: 4_000,
    })

    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes.some((node) => node.node_id === current.runId)).toBe(true)
  })

  it('reports stale before decoding mutated invalid UTF-8 bytes', () => {
    const current = fixture()
    const index = ready(inspectQueryIndex(current.graph))
    writeFileSync(current.sourcePath, Buffer.from([0xff]))

    const result = retrieveContext(index, {
      question: 'Where is the `run` function defined?',
      budget: 4_000,
    })

    expect(result.outcome).toBe('stale')
    expect(result.boundaries).toContainEqual({
      kind: 'stale',
      subject: 'src/run.ts',
    })
  })
})
