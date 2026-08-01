import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import type {
  IndexBodyFact, IndexChannelNode, IndexControlFrame, IndexRange,
  IndexScalarValue, IndexValue,
} from '../../src/domain/index/model.js'
import type { ReadyQueryIndex } from '../../src/domain/query/index-status.js'
import type { QueryPlan } from '../../src/domain/query/types.js'
import { selectWorkflow } from '../../src/domain/query/workflow.js'

const evidence = {
  file_id: 'file',
  range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
  statement_range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
  excerpt_sha256: 'a'.repeat(64),
} as const

function typedCase(value: IndexScalarValue): `case:${string}` {
  return `case:${Buffer.from(JSON.stringify([typeof value, value])).toString('base64url')}`
}

function triggerPayload(value: IndexScalarValue): IndexValue {
  return {
    kind: 'object',
    entries: [{ key: 'trigger', value: { kind: 'literal', value } }],
  }
}

function plan(intent: QueryPlan['intent'], subject = 'idea report'): QueryPlan {
  const obligations = intent === 'workflow' ? [
    { id: 'o1', kind: 'subject', target: subject, mandatory: true },
    { id: 'o2', kind: 'entry', target: subject, mandatory: true },
    { id: 'o3', kind: 'stage', target: subject, mandatory: true },
    { id: 'o4', kind: 'handoff', target: subject, mandatory: true },
    { id: 'o5', kind: 'behavior', target: subject, mandatory: true },
    { id: 'o6', kind: 'ordering', target: subject, mandatory: true },
    { id: 'o7', kind: 'terminal', target: subject, mandatory: true },
  ] : intent === 'explain' ? [
    { id: 'o1', kind: 'subject', target: subject, mandatory: true },
    { id: 'o2', kind: 'behavior', target: subject, mandatory: true },
  ] : [{ id: 'o1', kind: 'subject', target: subject, mandatory: true }]
  return { intent, subject, terms: subject.split(' ').sort(), obligations } as QueryPlan
}

class Fixture {
  readonly graph = new KnowledgeGraph({ root_path: '/workspace' })
  readonly facts = new Map<string, IndexBodyFact>()
  readonly owners = new Map<string, IndexBodyFact[]>()
  readonly channels = new Map<string, IndexChannelNode>()
  private order = 0

  symbol(
    id: string, label: string, sourceFile = `src/${id}.ts`,
    nodeKind = 'function', frameworkRole?: string,
  ): this {
    this.graph.addNode(id, {
      node_kind: nodeKind, label: `${label}()`, qualified_name: label,
      source_file: sourceFile, source_location: 'L1', provenance: [{}],
      definition_range: evidence.statement_range,
      declaration_range: evidence.range,
      ...(frameworkRole ? { framework_role: frameworkRole } : {}),
    })
    return this
  }

  private add(owner: string, fact: IndexBodyFact): void {
    this.facts.set(fact.id, fact)
    this.owners.set(owner, [...(this.owners.get(owner) ?? []), fact])
  }

  private base(owner: string, id: string, control: readonly IndexControlFrame[] = []) {
    return {
      id, owner_symbol_id: owner, order: [this.order++, 3, 0, 0], evidence,
      control, confidence: 'high' as const, source: 'typescript-semantic' as const,
    }
  }

  call(
    from: string, to: string, id = `${from}-calls-${to}`,
    control: readonly IndexControlFrame[] = [],
    args: readonly IndexValue[] = [],
    statementRange?: IndexRange,
  ): this {
    const base = this.base(from, id, control)
    const range = {
      start: { line: base.order[0]! + 1, column: 1 },
      end: { line: base.order[0]! + 1, column: 2 },
    }
    this.add(from, {
      ...base, evidence: {
        ...evidence, range, statement_range: statementRange ?? range,
      },
      kind: 'call', callee: to,
      target_symbol_id: to, arguments: args, scheduling: 'awaited',
    })
    this.graph.addEdge(from, to, {
      relation: 'calls', evidence: { source: 'typescript-semantic', range },
      provenance: [{}],
    })
    return this
  }

  behavior(owner: string, id = `${owner}-returns`): this {
    this.add(owner, { ...this.base(owner, id), kind: 'return' })
    return this
  }

  literal(
    owner: string,
    id = `${owner}-literal`,
    value = 'report',
  ): this {
    this.add(owner, {
      ...this.base(owner, id), kind: 'literal',
      value: { kind: 'literal', value }, role: 'initializer',
    })
    return this
  }

  dynamicCall(owner: string, id = `${owner}-dynamic`): this {
    this.add(owner, {
      ...this.base(owner, id), kind: 'call', callee: 'dynamic',
      arguments: [], scheduling: 'sync',
    })
    return this
  }

  persistence(
    owner: string, id = `${owner}-persistence`,
    operation: 'read' | 'update' = 'update',
    resource?: IndexValue,
    receiverType = 'Repository',
    control: readonly IndexControlFrame[] = [],
  ): this {
    const callId = `${id}-call`
    this.add(owner, {
      ...this.base(owner, callId, control), kind: 'call', callee: 'save',
      arguments: [], scheduling: 'awaited',
    })
    this.add(owner, {
      ...this.base(owner, id, control), kind: 'persistence', operation,
      call_fact_id: callId, receiver_type: receiverType,
      ...(resource ? { resource } : {}),
    })
    return this
  }

  persistenceInCase(
    owner: string, controller: string, value: IndexScalarValue,
    id = `${owner}-persistence`,
  ): this {
    return this.persistence(owner, id, 'update', undefined, 'Repository', [{
      kind: 'branch', controller_fact_id: controller, arm: typedCase(value),
    }])
  }

  switchSelector(
    owner: string, id: string,
    path: readonly string[] = ['data', 'trigger'],
  ): this {
    this.add(owner, {
      ...this.base(owner, id), kind: 'condition', condition_kind: 'switch',
      test: {
        kind: 'template',
        parts: [
          { kind: 'parameter', position: 0 },
          ...path.map((value): IndexValue => ({ kind: 'literal', value })),
        ],
      },
    })
    return this
  }

  controller(
    owner: string, id: string, kind: 'condition' | 'loop' | 'parallel',
    members: readonly string[] = [],
    control: readonly IndexControlFrame[] = [],
  ): this {
    if (kind === 'condition') this.add(owner, {
      ...this.base(owner, id, control), kind, condition_kind: 'if',
    })
    else if (kind === 'loop') this.add(owner, {
      ...this.base(owner, id, control), kind, loop_kind: 'while',
    })
    else this.add(owner, {
      ...this.base(owner, id, control), kind, combinator: 'all',
      completion: 'all_or_first_rejection', lane_count: members.length,
      member_fact_ids: members,
    })
    return this
  }

  channel(channel: IndexChannelNode): this {
    this.channels.set(channel.id, channel)
    this.graph.addNode(channel.id, channel)
    return this
  }

  edge(from: string, to: string, relation: string, source = 'typescript-semantic'): this {
    this.graph.addEdge(from, to, { relation,
      evidence: { ...evidence, source }, provenance: [{}] })
    return this
  }

  route(from: string, to: string, owner: string, publishId: string): this {
    const fact = this.facts.get(publishId)
    if (!fact) throw new Error(`Missing route fact ${publishId}`)
    this.graph.addEdge(from, to, {
      relation: 'routes_through', execution_owner_id: owner,
      evidence: {
        source: 'typescript-semantic',
        range: fact.evidence.range,
        statement_range: fact.evidence.statement_range,
        excerpt_sha256: fact.evidence.excerpt_sha256,
      },
      provenance: [{}],
    })
    return this
  }

  publish(
    from: string, helper: string, channel: string, id: string,
    args: readonly IndexValue[] = [], dispatchPayloadArgument?: number,
  ): this {
    this.call(from, helper, id, [], args)
    const fact = this.facts.get(id)
    if (!fact) throw new Error(`Missing publish fact ${id}`)
    this.graph.addEdge(from, channel, {
      relation: 'publishes_to',
      ...(dispatchPayloadArgument === undefined
        ? {} : { dispatch_payload_argument: dispatchPayloadArgument }),
      evidence: {
        source: 'typescript-semantic',
        range: fact.evidence.range,
        statement_range: fact.evidence.statement_range,
        excerpt_sha256: fact.evidence.excerpt_sha256,
      },
      provenance: [{}],
    })
    return this
  }

  publishWithNestedCall(
    from: string, helper: string, nested: string, channel: string,
    id: string, args: readonly IndexValue[], dispatchPayloadArgument?: number,
  ): this {
    this.call(from, helper, id, [], args)
    const fact = this.facts.get(id)!
    this.call(from, nested, `${id}-nested`, [], [], fact.evidence.statement_range)
    this.graph.addEdge(from, channel, {
      relation: 'publishes_to',
      ...(dispatchPayloadArgument === undefined
        ? {} : { dispatch_payload_argument: dispatchPayloadArgument }),
      evidence: {
        source: 'wrapper-summary',
        range: fact.evidence.range,
        statement_range: fact.evidence.statement_range,
        excerpt_sha256: fact.evidence.excerpt_sha256,
      },
      provenance: [{}],
    })
    return this
  }

  publishWithMismatchedRange(
    from: string, helper: string, channel: string, id: string,
  ): this {
    this.call(from, helper, id)
    const fact = this.facts.get(id)!
    this.graph.addEdge(from, channel, {
      relation: 'publishes_to',
      evidence: {
        source: 'wrapper-summary',
        range: {
          start: {
            line: fact.evidence.range.start.line,
            column: fact.evidence.range.start.column + 1,
          },
          end: fact.evidence.range.end,
        },
        statement_range: fact.evidence.statement_range,
        excerpt_sha256: fact.evidence.excerpt_sha256,
      },
      provenance: [{}],
    })
    return this
  }

  index(): ReadyQueryIndex {
    return {
      state: 'ready', graph: this.graph, root_path: '/workspace',
      file_hashes: new Map(), unsupported_sources: [],
      operation_by_id: this.facts, operations_by_owner: this.owners,
      channels_by_id: this.channels, channels_by_key: new Map(),
    }
  }
}

function directFixture(): Fixture {
  return new Fixture()
    .symbol('entry', 'generateIdeaReport')
    .symbol('stage', 'assembleIdeaReport')
    .symbol('terminal', 'persistIdeaReport')
    .call('entry', 'stage').call('stage', 'terminal')
    .persistence('terminal')
}

function channelFixture(consumerQueue: 'queue' | 'other' | null): Fixture {
  const fixture = new Fixture()
    .symbol('entry', 'generateIdeaReport').behavior('entry')
    .symbol('enqueue', 'enqueueJob')
    .symbol('worker', 'assembleIdeaReport')
    .symbol('terminal', 'persistIdeaReport').persistence('terminal')
    .channel({
      id: 'queue', node_kind: 'channel', channel_kind: 'queue',
      transport: 'bullmq', key: 'reports',
    })
    .channel({
      id: 'job', node_kind: 'channel', channel_kind: 'job',
      transport: 'bullmq', key: 'assemble', parent_channel_id: 'queue',
    })
    .publish('entry', 'enqueue', 'job', 'publish-report')
    .route('job', 'queue', 'entry', 'publish-report')
    .call('worker', 'terminal')
  if (consumerQueue === 'other') fixture
    .channel({
      id: 'other', node_kind: 'channel', channel_kind: 'queue',
      transport: 'bullmq', key: 'other',
    })
    .edge('other', 'worker', 'consumed_by')
  else if (consumerQueue === 'queue') fixture
    .edge('queue', 'worker', 'consumed_by')
  return fixture
}

function discriminatedChannelFixture(options: {
  dispatchPayloadArgument?: number | null
  payload?: IndexScalarValue
  persistenceCase?: IndexScalarValue | null
} = {}): Fixture {
  const dispatchPayloadArgument = options.dispatchPayloadArgument === undefined
      ? 0 : options.dispatchPayloadArgument,
    payload = options.payload === undefined ? 'assembly_complete' : options.payload,
    persistenceCase = options.persistenceCase === undefined
      ? 'assembly_complete' : options.persistenceCase,
    fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('enqueue', 'enqueueReportJob')
      .symbol('terminal', 'persistIdeaReport')
      .switchSelector('terminal', 'terminal-trigger')
  if (persistenceCase === null) fixture.persistence('terminal')
  else fixture.persistenceInCase(
    'terminal', 'terminal-trigger', persistenceCase,
  )
  return fixture
    .channel({
      id: 'queue', node_kind: 'channel', channel_kind: 'queue',
      transport: 'bullmq', key: 'reports',
    })
    .publish(
      'entry', 'enqueue', 'queue', 'publish-report',
      [triggerPayload(payload)], dispatchPayloadArgument ?? undefined,
    )
    .edge('queue', 'terminal', 'consumed_by')
}

function multipleIncomingChannelFixture(secondProducerProven: boolean): Fixture {
  return new Fixture()
    .symbol('entry', 'generateIdeaReport')
    .symbol('enqueue', 'enqueueReportJob')
    .symbol('terminal', 'persistIdeaReport')
    .switchSelector('terminal', 'terminal-trigger')
    .persistenceInCase(
      'terminal', 'terminal-trigger', 'primary_complete', 'primary-persistence',
    )
    .persistenceInCase(
      'terminal', 'terminal-trigger', 'archive_complete', 'archive-persistence',
    )
    .channel({
      id: 'primary-queue', node_kind: 'channel', channel_kind: 'queue',
      transport: 'bullmq', key: 'primary',
    })
    .channel({
      id: 'archive-queue', node_kind: 'channel', channel_kind: 'queue',
      transport: 'bullmq', key: 'archive',
    })
    .publish(
      'entry', 'enqueue', 'primary-queue', 'publish-primary',
      [triggerPayload('primary_complete')], 0,
    )
    .publish(
      'entry', 'enqueue', 'archive-queue', 'publish-archive',
      [triggerPayload('archive_complete')], secondProducerProven ? 0 : undefined,
    )
    .edge('primary-queue', 'terminal', 'consumed_by')
    .edge('archive-queue', 'terminal', 'consumed_by')
}

describe('deterministic workflow selection', () => {
  it('proves an explicit request entry only from structural request metadata', () => {
    const requestPlan = {
      ...plan('workflow'),
      obligations: plan('workflow').obligations.map((obligation) =>
        obligation.kind === 'entry' ? { ...obligation, target: 'request' } : obligation),
    }
    const migration = new Fixture()
      .symbol('migration', 'migrateIdeaReportRequest', 'src/migrations/request.ts')
      .symbol('stage', 'assembleIdeaReport')
      .symbol('terminal', 'persistIdeaReport')
      .call('migration', 'stage').call('stage', 'terminal').persistence('terminal')
    const fakeHandler = new Fixture()
      .symbol('handler', 'ideaReportHandler', 'src/http/helper.ts')
      .symbol('stage', 'assembleIdeaReport')
      .symbol('terminal', 'persistIdeaReport')
      .call('handler', 'stage').call('stage', 'terminal').persistence('terminal')
    const route = new Fixture()
      .symbol(
        'route', 'IdeaReportController.submit',
        'src/http/idea-report.controller.ts', 'route',
      )
      .symbol('stage', 'assembleIdeaReport')
      .symbol('terminal', 'persistIdeaReport')
      .call('route', 'stage').call('stage', 'terminal').persistence('terminal')

    const rejected = selectWorkflow(migration.index(), requestPlan)
    const rejectedHandler = selectWorkflow(fakeHandler.index(), requestPlan)
    const accepted = selectWorkflow(route.index(), requestPlan)

    expect(rejected.complete).toBe(false)
    expect(rejectedHandler.complete).toBe(false)
    expect(rejected.missing).toContainEqual({
      code: 'entrypoint_unproven', target: 'request', obligationId: 'o2',
    })
    expect(accepted.complete).toBe(true)
    expect(accepted.rootSymbolIds).toEqual(['route'])
  })

  it('uses explicit entry, stage, and terminal bounds to choose the proven corridor', () => {
    const boundedPlan = {
      ...plan('workflow'),
      obligations: plan('workflow').obligations.map((obligation) =>
        obligation.kind === 'entry' ? { ...obligation, target: 'request' }
          : obligation.kind === 'stage' ? { ...obligation, target: 'planning' }
            : obligation.kind === 'terminal'
              ? { ...obligation, target: 'database persistence' } : obligation),
    }
    const fixture = new Fixture()
      .symbol('a-cli', 'generateIdeaReport')
      .symbol('file-stage', 'assembleIdeaReport')
      .symbol('file', 'persistIdeaReportFile')
      .persistence('file', 'file-write', 'update', undefined, 'FileSystem')
      .call('a-cli', 'file-stage').call('file-stage', 'file')
      .symbol('z-route', 'IdeaReportController.submit', 'src/http/report.ts', 'route')
      .symbol('planning', 'planIdeaReport')
      .symbol('database', 'persistIdeaReportDatabase')
      .persistence('database', 'db-write')
      .call('z-route', 'planning').call('planning', 'database')

    const result = selectWorkflow(fixture.index(), boundedPlan)

    expect(result.complete).toBe(true)
    expect(result.rootSymbolIds).toEqual(['z-route'])
    expect(result.terminalSymbolIds).toEqual(['database'])
    expect(result.symbolIds).toContain('planning')
  })

  it('does not relabel file persistence as database persistence', () => {
    const boundedPlan = {
      ...plan('workflow'),
      obligations: plan('workflow').obligations.map((obligation) =>
        obligation.kind === 'terminal'
          ? { ...obligation, target: 'database persistence' } : obligation),
    }
    const result = selectWorkflow(new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('file', 'persistIdeaReportFile')
      .persistence('file', 'file-write', 'update', undefined, 'FileSystem')
      .call('entry', 'file').index(), boundedPlan)

    expect(result.complete).toBe(false)
    expect(result.missing).toContainEqual({
      code: 'terminal_persistence_unproven',
      target: 'database persistence', obligationId: 'o7',
    })
  })

  it('selects a direct authenticated chain through terminal persistence', () => {
    const result = selectWorkflow(directFixture().index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.rootSymbolIds).toEqual(['entry'])
    expect(result.terminalSymbolIds).toEqual(['terminal'])
    expect(result.symbolIds).toEqual(['entry', 'stage', 'terminal'])
    expect(result.edges.map((edge) => edge.relation)).toEqual(['calls', 'calls'])
    expect(result.operationIds).toEqual(expect.arrayContaining([
      'entry-calls-stage', 'stage-calls-terminal',
      'terminal-persistence', 'terminal-persistence-call',
    ]))
    expect(result.links.flatMap(({ operationIds }) => operationIds))
      .toEqual(['entry-calls-stage', 'stage-calls-terminal'])
    const selectedOperations = new Set(result.operationIds)
    expect([
      ...result.links.flatMap(({ operationIds }) => operationIds),
      ...result.obligations.flatMap(({ operationIds }) => operationIds),
      ...result.controlGroups.flatMap(({ operationIds, controllerOperationId }) => [
        ...operationIds, ...(controllerOperationId ? [controllerOperationId] : []),
      ]),
    ].every((id) => selectedOperations.has(id))).toBe(true)
    expect(result.obligations.map((entry) => [entry.id, entry.kind, entry.proven]))
      .toEqual([
        ['o1', 'subject', true], ['o2', 'entry', true],
        ['o3', 'stage', true], ['o4', 'handoff', true],
        ['o5', 'behavior', true], ['o6', 'ordering', true],
        ['o7', 'terminal', true],
      ])
  })

  it('does not seed redundant behavior for edge-incident or persisted stages', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport').behavior('entry', 'entry-return')
      .symbol('stage', 'assembleIdeaReport').behavior('stage', 'stage-return')
      .symbol('terminal', 'persistIdeaReport').behavior('terminal', 'terminal-return')
      .call('entry', 'stage').call('stage', 'terminal').persistence('terminal')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.operationIds).not.toEqual(expect.arrayContaining([
      'entry-return', 'stage-return', 'terminal-return',
    ]))
    expect(result.obligations.find(({ kind }) => kind === 'behavior')?.proven).toBe(true)
  })

  it('selects only a complete exact job-to-queue channel macro', () => {
    const queue: IndexChannelNode = {
      id: 'queue', node_kind: 'channel', channel_kind: 'queue',
      transport: 'bullmq', key: 'reports',
    }
    const job: IndexChannelNode = {
      id: 'job', node_kind: 'channel', channel_kind: 'job',
      transport: 'bullmq', key: 'assemble', parent_channel_id: 'queue',
    }
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport').behavior('entry')
      .symbol('enqueue', 'enqueueJob')
      .symbol('worker', 'assembleIdeaReport')
      .symbol('terminal', 'persistIdeaReport').persistence('terminal')
      .channel(queue).channel(job)
      .publish('entry', 'enqueue', 'job', 'publish-report')
      .route('job', 'queue', 'entry', 'publish-report')
      .edge('queue', 'worker', 'consumed_by')
      .call('worker', 'terminal')

    const result = selectWorkflow(fixture.index(), plan('workflow'))
    expect(result.complete).toBe(true)
    expect(result.edges.map((edge) => edge.relation).sort()).toEqual([
      'calls', 'consumed_by', 'publishes_to', 'routes_through',
    ])
    expect(result.metrics.actualNodeCount).toBe(6)
  })

  it('binds acronym channel and generic database persistence targets structurally', () => {
    const bounded = {
      ...plan('workflow'),
      obligations: plan('workflow').obligations.map((obligation) =>
        obligation.kind === 'stage'
          ? { ...obligation, target: 'bull mq queue' }
          : obligation.kind === 'terminal'
            ? { ...obligation, target: 'database persist' }
            : obligation),
    }

    const result = selectWorkflow(channelFixture('queue').index(), bounded)

    expect(result.complete).toBe(true)
    expect(result.obligations.find(({ kind }) => kind === 'stage')?.proven).toBe(true)
    expect(result.obligations.find(({ kind }) => kind === 'terminal')?.proven).toBe(true)
  })

  it.each([
    ['missing', null],
    ['changed to an out-of-range position', 1],
  ])('rejects a terminal channel with a %s dispatch payload argument', (
    _name, dispatchPayloadArgument,
  ) => {
    expect(selectWorkflow(
      discriminatedChannelFixture().index(), plan('workflow'),
    ).complete).toBe(true)

    const result = selectWorkflow(discriminatedChannelFixture({
      dispatchPayloadArgument,
    }).index(), plan('workflow'))

    expect(result.complete).toBe(false)
    expect(result.terminalSymbolIds).toEqual([])
    expect(result.missing.map(({ code }) => code))
      .toContain('terminal_persistence_unproven')
  })

  it.each([
    ['value', 'section_complete' as IndexScalarValue, 'assembly_complete' as IndexScalarValue],
    ['type', 1 as IndexScalarValue, '1' as IndexScalarValue],
  ])('rejects a terminal channel after a trigger %s mismatch', (
    _name, payload, persistenceCase,
  ) => {
    const result = selectWorkflow(discriminatedChannelFixture({
      payload, persistenceCase,
    }).index(), plan('workflow'))

    expect(result.complete).toBe(false)
    expect(result.terminalSymbolIds).toEqual([])
    expect(result.missing.map(({ code }) => code))
      .toContain('terminal_persistence_unproven')
  })

  it.each([
    ['moved to a sibling case', 'section_complete' as IndexScalarValue],
    ['removed from the matching case', null],
  ])('rejects terminal persistence %s', (_name, persistenceCase) => {
    const result = selectWorkflow(discriminatedChannelFixture({
      persistenceCase,
    }).index(), plan('workflow'))

    expect(result.complete).toBe(false)
    expect(result.terminalSymbolIds).toEqual([])
    expect(result.missing.map(({ code }) => code))
      .toContain('terminal_persistence_unproven')
  })

  it('requires exact proof from every incoming channel producer', () => {
    expect(selectWorkflow(
      multipleIncomingChannelFixture(true).index(), plan('workflow'),
    ).complete).toBe(true)

    const result = selectWorkflow(
      multipleIncomingChannelFixture(false).index(), plan('workflow'),
    )

    expect(result.complete).toBe(false)
    expect(result.terminalSymbolIds).toEqual([])
    expect(result.missing.map(({ code }) => code))
      .toContain('terminal_persistence_unproven')
  })

  it.each([
    ['unrelated route owner', 'noise', 'publish-report'],
    ['unrelated route statement', 'entry', 'unrelated-call'],
  ])('rejects a job route proved by an %s', (_name, owner, proof) => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport').behavior('entry')
      .symbol('enqueue', 'enqueueJob')
      .symbol('noise', 'unrelatedHelper')
      .symbol('worker', 'assembleIdeaReport')
      .symbol('terminal', 'persistIdeaReport').persistence('terminal')
      .channel({
        id: 'queue', node_kind: 'channel', channel_kind: 'queue',
        transport: 'bullmq', key: 'reports',
      })
      .channel({
        id: 'job', node_kind: 'channel', channel_kind: 'job',
        transport: 'bullmq', key: 'assemble', parent_channel_id: 'queue',
      })
      .call('entry', 'noise', 'unrelated-call')
      .publish('entry', 'enqueue', 'job', 'publish-report')
      .route('job', 'queue', owner, proof)
      .edge('queue', 'worker', 'consumed_by')
      .call('worker', 'terminal')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(false)
    expect(result.links.some((link) => link.kind === 'channel')).toBe(false)
  })

  it('keeps shared producer APIs out of the causal dossier', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('producer2', 'dispatchIdeaReport')
      .symbol('worker1', 'planIdeaReport')
      .symbol('terminal', 'persistIdeaReport')
      .switchSelector('terminal', 'terminal-trigger')
      .persistenceInCase('terminal', 'terminal-trigger', 'two.process')
      .symbol('enqueue', 'enqueueJob', 'src/queue-registry.ts').behavior('enqueue')
      .symbol('string', 'String')
      .edge('enqueue', 'string', 'calls', 'heuristic')
      .channel({
        id: 'queue1', node_kind: 'channel', channel_kind: 'queue',
        transport: 'bullmq', key: 'one',
      })
      .channel({
        id: 'job1', node_kind: 'channel', channel_kind: 'job',
        transport: 'bullmq', key: 'one.process', parent_channel_id: 'queue1',
      })
      .channel({
        id: 'queue2', node_kind: 'channel', channel_kind: 'queue',
        transport: 'bullmq', key: 'two',
      })
      .channel({
        id: 'job2', node_kind: 'channel', channel_kind: 'job',
        transport: 'bullmq', key: 'two.process', parent_channel_id: 'queue2',
      })
      .publish('entry', 'enqueue', 'job1', 'publish-one')
      .route('job1', 'queue1', 'entry', 'publish-one')
      .edge('queue1', 'worker1', 'consumed_by')
      .call('worker1', 'producer2')
      .publish(
        'producer2', 'enqueue', 'job2', 'publish-two',
        [triggerPayload('two.process')], 0,
      )
      .route('job2', 'queue2', 'producer2', 'publish-two')
      .edge('queue2', 'terminal', 'consumed_by')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.symbolIds).not.toContain('enqueue')
    expect(result.links.filter((link) => link.kind === 'channel')).toHaveLength(2)
    expect(result.links.some((link) => link.toId === 'enqueue')).toBe(false)
    expect(result.operationIds).toEqual(expect.arrayContaining([
      'publish-one', 'publish-two',
    ]))
    for (const kind of ['stage', 'handoff', 'behavior', 'ordering']) {
      expect(result.obligations.find((proof) => proof.kind === kind)?.symbolIds)
        .not.toContain('enqueue')
    }
  })

  it.each([
    ['consumer removal', null],
    ['queue mismatch', 'other' as const],
  ])('turns a ready channel dossier incomplete after %s', (_name, mutation) => {
    expect(selectWorkflow(channelFixture('queue').index(), plan('workflow')).complete)
      .toBe(true)

    const result = selectWorkflow(channelFixture(mutation).index(), plan('workflow'))

    expect(result.complete).toBe(false)
    expect(result.symbolIds).toEqual(['entry'])
    expect(result.rootSymbolIds).toEqual(['entry'])
    expect(result.obligations.map(({ kind, proven }) => [kind, proven])).toEqual([
      ['subject', true], ['entry', true], ['stage', true], ['handoff', false],
      ['behavior', true], ['ordering', false], ['terminal', false],
    ])
    expect(result.missing).toEqual([
      { code: 'adjacent_handoff_unproven', target: 'entry', obligationId: 'o4' },
      { code: 'obligation_target_unproven', target: 'idea report', obligationId: 'o6' },
      { code: 'terminal_persistence_unproven', target: 'idea report', obligationId: 'o7' },
    ])
  })

  it.each([
    ['removed consumer', (fixture: Fixture) => fixture],
    ['channel mismatch', (fixture: Fixture) => fixture
      .channel({ id: 'other', node_kind: 'channel', channel_kind: 'queue',
        transport: 'bullmq', key: 'other' })
      .edge('other', 'worker', 'consumed_by')],
  ])('fails closed for %s', (_name, mutate) => {
    const fixture = mutate(new Fixture()
      .symbol('entry', 'generateIdeaReport').behavior('entry')
      .symbol('worker', 'assembleIdeaReport')
      .symbol('terminal', 'persistIdeaReport').persistence('terminal')
      .channel({ id: 'queue', node_kind: 'channel', channel_kind: 'queue',
        transport: 'bullmq', key: 'reports' })
      .edge('entry', 'queue', 'publishes_to').call('worker', 'terminal'))

    const result = selectWorkflow(fixture.index(), plan('workflow'))
    expect(result.complete).toBe(false)
    expect(result.missing.map((entry) => entry.code)).toContain(
      'terminal_persistence_unproven',
    )
  })

  it('fails closed when an otherwise connected flow has no persistence terminal', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('stage', 'assembleIdeaReport')
      .call('entry', 'stage').behavior('stage')
    const result = selectWorkflow(fixture.index(), plan('workflow'))
    expect(result.complete).toBe(false)
    expect(result.terminalSymbolIds).toEqual([])
    expect(result.metrics.recoveryPasses).toBe(1)
    expect(result.metrics.recoveryFrontierCount).toBeGreaterThan(0)
    expect(result.metrics.recoveryFrontierCount).toBeLessThanOrEqual(64)
    expect(result.missing.map((entry) => entry.code))
      .toContain('terminal_persistence_unproven')
  })

  it('retains authenticated generic stages when only persistence is absent', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('alpha', 'alpha')
      .symbol('omega', 'omega').behavior('omega')
      .call('entry', 'alpha').call('alpha', 'omega')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.rootSymbolIds).toEqual(['entry'])
    expect(result.symbolIds).toEqual(['alpha', 'entry', 'omega'])
    expect(result.links).toHaveLength(2)
    expect(result.metrics.recoveryPasses).toBe(1)
    expect(result.metrics.recoveryFrontierCount).toBeGreaterThan(0)
    expect(result.metrics.recoveryFrontierCount).toBeLessThanOrEqual(64)
    expect(result.obligations.map(({ kind, proven }) => [kind, proven])).toEqual([
      ['subject', true], ['entry', true], ['stage', true], ['handoff', true],
      ['behavior', true], ['ordering', true], ['terminal', false],
    ])
    expect(result.missing).toEqual([
      { code: 'terminal_persistence_unproven', target: 'idea report', obligationId: 'o7' },
    ])
  })

  it('rejects a graph call edge that has no matching owner call fact', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport').behavior('entry')
      .symbol('terminal', 'persistIdeaReport').persistence('terminal')
      .edge('entry', 'terminal', 'calls')
    const result = selectWorkflow(fixture.index(), plan('workflow'))
    expect(result.complete).toBe(false)
    expect(result.links).toEqual([])
    expect(result.terminalSymbolIds).toEqual([])
  })

  it('preserves fan-out, fan-in, branch, loop, parallel and cycle groups', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('left', 'researchIdeaReportLeft')
      .symbol('right', 'researchIdeaReportRight')
      .symbol('join', 'assembleIdeaReport')
      .symbol('terminal', 'persistIdeaReport')
    fixture.controller('entry', 'parallel', 'parallel', ['to-left', 'to-right'])
      .call('entry', 'left', 'to-left', [{ kind: 'parallel', controller_fact_id: 'parallel', lane: 0 }])
      .call('entry', 'right', 'to-right', [{ kind: 'parallel', controller_fact_id: 'parallel', lane: 1 }])
      .controller('left', 'branch', 'condition')
      .call('left', 'join', 'left-join', [{ kind: 'branch', controller_fact_id: 'branch', arm: 'then' }])
      .controller('right', 'loop', 'loop')
      .call('right', 'join', 'right-join', [{ kind: 'loop', controller_fact_id: 'loop' }])
      .call('join', 'terminal').call('terminal', 'join', 'cycle-back')
      .persistence('terminal')

    const result = selectWorkflow(fixture.index(), plan('workflow'))
    expect(result.complete).toBe(true)
    expect(result.edges).toHaveLength(6)
    expect(new Set(result.controlGroups.map((group) => group.kind)))
      .toEqual(new Set(['branch', 'loop', 'parallel', 'cycle']))
    expect(result.controlGroups.find((group) => group.kind === 'cycle')?.symbolIds)
      .toEqual(['join', 'terminal'])
  })

  it('preserves a bounded unequal-length branch detour to the same terminal', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('left', 'ideaReportLeft').symbol('right', 'ideaReportRight')
      .symbol('middle', 'ideaReportMiddle').symbol('join', 'assembleIdeaReport')
      .symbol('terminal', 'persistIdeaReport').persistence('terminal')
      .call('entry', 'left').call('left', 'join')
      .call('entry', 'right').call('right', 'middle').call('middle', 'join')
      .call('join', 'terminal')
    const result = selectWorkflow(fixture.index(), plan('workflow'))
    expect(result.complete).toBe(true)
    expect(result.symbolIds).toEqual([
      'entry', 'join', 'left', 'middle', 'right', 'terminal',
    ])
    expect(result.links).toHaveLength(6)
  })

  it('retains a valid branch more than four relations longer than its sibling', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('short', 'ideaReportShort')
      .symbol('long1', 'ideaReportLongOne')
      .symbol('long2', 'ideaReportLongTwo')
      .symbol('long3', 'ideaReportLongThree')
      .symbol('long4', 'ideaReportLongFour')
      .symbol('long5', 'ideaReportLongFive')
      .symbol('long6', 'ideaReportLongSix')
      .symbol('join', 'assembleIdeaReport')
      .symbol('terminal', 'persistIdeaReport').persistence('terminal')
      .call('entry', 'short').call('short', 'join')
      .call('entry', 'long1').call('long1', 'long2')
      .call('long2', 'long3').call('long3', 'long4')
      .call('long4', 'long5').call('long5', 'long6')
      .call('long6', 'join').call('join', 'terminal')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.symbolIds).toEqual([
      'entry', 'join', 'long1', 'long2', 'long3', 'long4', 'long5', 'long6',
      'short', 'terminal',
    ])
    expect(result.links).toHaveLength(10)
  })

  it('fails closed when distinct terminal routes exceed the relation bound', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('start', 'startPipeline')
      .symbol('research', 'researchSection')
      .symbol('check', 'checkAndDispatchNext')
      .symbol('enqueue', 'enqueueJob')
      .symbol('assembly-worker', 'AssemblyWorker.process')
      .symbol('assembly', 'AssemblyService.assembleReport')
      .symbol('dispatch', 'dispatchDbSync')
      .symbol('terminal', 'DbSyncWorker.process').persistence('terminal')
      .channel({
        id: 'assembly-queue', node_kind: 'channel', channel_kind: 'queue',
        transport: 'bullmq', key: 'assembly-queue',
      })
      .channel({
        id: 'assembly-job', node_kind: 'channel', channel_kind: 'job',
        transport: 'bullmq', key: 'assemble_report',
        parent_channel_id: 'assembly-queue',
      })
      .call('entry', 'start')
      .call('start', 'research')
      .call('entry', 'research', 'request-wrapper-shortcut')
      .call('research', 'terminal', 'progress-db-sync')
      .call('research', 'check')
      .publish('check', 'enqueue', 'assembly-job', 'publish-assembly')
      .route('assembly-job', 'assembly-queue', 'check', 'publish-assembly')
      .edge('assembly-queue', 'assembly-worker', 'consumed_by')
      .call('assembly-worker', 'assembly')
      .call('assembly', 'dispatch')
      .call('assembly', 'terminal', 'sync-wrapper-shortcut')
      .call('dispatch', 'terminal')
    for (let index = 0; index < 11; index += 1) {
      const id = `sibling-${index}`
      fixture.symbol(id, `unrelatedStage${index}`)
        .call('research', id).call(id, 'terminal')
    }

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(false)
    expect(result.metrics.bounded).toBe(true)
    expect(result.missing).toContainEqual({
      code: 'selection_bound_reached', target: 'idea report',
    })
  })

  it('chooses the deepest relevant persistence instead of an early write', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('early', 'createIdeaReport').persistence('early')
      .symbol('assembly', 'assembleIdeaReport')
      .symbol('terminal', 'syncIdeaReport').persistence('terminal')
      .call('entry', 'early').call('early', 'assembly').call('assembly', 'terminal')

    const result = selectWorkflow(fixture.index(), plan('workflow'))
    expect(result.complete).toBe(true)
    expect(result.terminalSymbolIds).toEqual(['terminal'])
    expect(result.symbolIds).toContain('early')
  })

  it('keeps a persisted channel consumer as a stage when a later final write exists', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('enqueue', 'enqueueJob')
      .symbol('draft', 'persistIdeaReportDraft').persistence('draft')
      .symbol('final', 'omega').persistence('final')
      .channel({
        id: 'queue', node_kind: 'channel', channel_kind: 'queue',
        transport: 'bullmq', key: 'reports',
      })
      .channel({
        id: 'job', node_kind: 'channel', channel_kind: 'job',
        transport: 'bullmq', key: 'draft', parent_channel_id: 'queue',
      })
      .publish('entry', 'enqueue', 'job', 'publish-draft')
      .route('job', 'queue', 'entry', 'publish-draft')
      .edge('queue', 'draft', 'consumed_by')
      .call('draft', 'final')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.terminalSymbolIds).toEqual(['final'])
    expect(result.symbolIds).toContain('draft')
    expect(result.links).toHaveLength(2)
  })

  it('follows persisted channel-consumer fan-out through a shared final write', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('enqueue', 'enqueueJob')
      .symbol('draft', 'persistIdeaReportDraft').persistence('draft')
      .symbol('left', 'alpha')
      .symbol('right', 'beta')
      .symbol('join', 'gamma')
      .symbol('final', 'omega').persistence('final')
      .channel({
        id: 'queue', node_kind: 'channel', channel_kind: 'queue',
        transport: 'bullmq', key: 'reports',
      })
      .publish('entry', 'enqueue', 'queue', 'publish-draft')
      .edge('queue', 'draft', 'consumed_by')
      .call('draft', 'left')
      .call('draft', 'right')
      .call('left', 'join')
      .call('right', 'join')
      .call('join', 'final')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.terminalSymbolIds).toEqual(['final'])
    expect(result.symbolIds).toEqual([
      'draft', 'entry', 'final', 'join', 'left', 'right',
    ])
  })

  it('preserves independent persisted terminals and sibling-call order', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('left', 'buildIdeaReportPrimary')
      .symbol('right', 'buildIdeaReportArchive')
      .symbol('leftTerminal', 'persistIdeaReportPrimary').persistence('leftTerminal')
      .symbol('rightTerminal', 'persistIdeaReportArchive').persistence('rightTerminal')
      .call('entry', 'left').call('entry', 'right')
      .call('left', 'leftTerminal').call('right', 'rightTerminal')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.terminalSymbolIds).toEqual(['leftTerminal', 'rightTerminal'])
    expect(result.symbolIds).toEqual([
      'entry', 'left', 'leftTerminal', 'right', 'rightTerminal',
    ])
    expect(result.controlGroups).toContainEqual({
      kind: 'sequence',
      operationIds: ['entry-calls-left', 'entry-calls-right'],
      symbolIds: ['left', 'right'],
    })
    expect(result.obligations.find(({ kind }) => kind === 'ordering'))
      .toEqual(expect.objectContaining({
        proven: true, edgeIds: result.edges.map(({ id }) => id),
        operationIds: expect.arrayContaining(['entry-calls-left', 'entry-calls-right']),
      }))
  })

  it('keeps authenticated sibling order when target names sort in reverse', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('zTarget', 'persistFirst').persistence('zTarget')
      .symbol('aTarget', 'persistSecond').persistence('aTarget')
      .call('entry', 'zTarget', 'call-z')
      .call('entry', 'aTarget', 'call-a')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.controlGroups).toContainEqual({
      kind: 'sequence',
      operationIds: ['call-z', 'call-a'],
      symbolIds: ['zTarget', 'aTarget'],
    })
  })

  it('closes every independently controlled selected handoff', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('zBranch', 'researchFirst')
      .symbol('aBranch', 'researchSecond')
      .symbol('join', 'assembleIdeaReport')
      .symbol('terminal', 'persistIdeaReport').persistence('terminal')
      .controller('entry', 'guard-z', 'condition')
      .call('entry', 'zBranch', 'call-z', [
        { kind: 'branch', controller_fact_id: 'guard-z', arm: 'then' },
      ])
      .controller('entry', 'guard-a', 'condition')
      .call('entry', 'aBranch', 'call-a', [
        { kind: 'branch', controller_fact_id: 'guard-a', arm: 'then' },
      ])
      .call('zBranch', 'join')
      .call('aBranch', 'join')
      .call('join', 'terminal')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.operationIds).toEqual(expect.arrayContaining([
      'call-z', 'guard-z', 'call-a', 'guard-a',
    ]))
    expect(result.links.find(({ fromId, toId }) =>
      fromId === 'entry' && toId === 'zBranch')?.operationIds).toEqual(['call-z'])
    expect(result.links.find(({ fromId, toId }) =>
      fromId === 'entry' && toId === 'aBranch')?.operationIds).toEqual(['call-a'])
  })

  it('preserves recursively nested control groups', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('terminal', 'persistIdeaReport').persistence('terminal')
      .controller('entry', 'outer-loop', 'loop')
      .controller('entry', 'inner-guard', 'condition', [], [{
        kind: 'loop', controller_fact_id: 'outer-loop',
      }])
      .call('entry', 'terminal', 'persist-call', [{
        kind: 'branch', controller_fact_id: 'inner-guard', arm: 'then',
      }])

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.operationIds).toEqual(expect.arrayContaining([
      'outer-loop', 'inner-guard', 'persist-call',
    ]))
    expect(result.controlGroups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'branch', controllerOperationId: 'inner-guard',
        operationIds: ['persist-call'],
      }),
      expect.objectContaining({
        kind: 'loop', controllerOperationId: 'outer-loop',
        operationIds: ['inner-guard'],
      }),
    ]))
  })

  it('fails closed instead of dropping an over-limit controlled branch', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('terminal', 'persistIdeaReport').persistence('terminal')
      .controller('entry', 'guard', 'condition')
    for (const arm of ['then', 'else'] as const) {
      let owner = 'entry'
      for (let index = 0; index < 12; index += 1) {
        const next = `${arm}-${index}`
        fixture.symbol(next, `${arm}IdeaReport${index}`)
          .call(owner, next, `${arm}-call-${index}`, [
            { kind: 'branch', controller_fact_id: 'guard', arm },
          ])
        owner = next
      }
      fixture.call(owner, 'terminal', `${arm}-terminal`, [
        { kind: 'branch', controller_fact_id: 'guard', arm },
      ])
    }

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(false)
    expect(result.metrics.bounded).toBe(true)
    expect(result.missing).toContainEqual({
      code: 'selection_bound_reached', target: 'idea report',
    })
  })

  it('keeps independent direct and queued persistence terminals', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('enqueue', 'enqueueReportJob')
      .symbol('async-terminal', 'persistIdeaReportAsync')
      .switchSelector('async-terminal', 'async-trigger')
      .persistenceInCase('async-terminal', 'async-trigger', 'assembly_complete')
      .symbol('direct-terminal', 'persistIdeaReportDirect').persistence('direct-terminal')
      .channel({
        id: 'queue', node_kind: 'channel', channel_kind: 'queue',
        transport: 'bullmq', key: 'reports',
      })
      .publish(
        'entry', 'enqueue', 'queue', 'publish-job',
        [triggerPayload('assembly_complete')], 0,
      )
      .edge('queue', 'async-terminal', 'consumed_by')
      .call('entry', 'direct-terminal', 'entry-to-direct')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.terminalSymbolIds).toEqual(['async-terminal', 'direct-terminal'])
    expect(result.operationIds).toEqual(expect.arrayContaining([
      'publish-job', 'entry-to-direct',
    ]))
    expect(result.links).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromId: 'entry', toId: 'async-terminal', kind: 'channel',
      }),
      expect.objectContaining({
        fromId: 'entry', toId: 'direct-terminal', kind: 'direct',
      }),
    ]))
  })

  it('fails closed instead of dropping an over-limit unconditional branch', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('terminal', 'persistIdeaReport').persistence('terminal')
    for (const branch of ['a', 'b']) {
      let owner = 'entry'
      for (let index = 0; index < 12; index += 1) {
        const next = `${branch}-${index}`
        fixture.symbol(next, `${branch}IdeaReport${index}`)
          .call(owner, next, `${branch}-call-${index}`)
        owner = next
      }
      fixture.call(owner, 'terminal', `${branch}-terminal`)
    }

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(false)
    expect(result.metrics.bounded).toBe(true)
    expect(result.missing).toContainEqual({
      code: 'selection_bound_reached', target: 'idea report',
    })
  })

  it('does not prefer a deeper persistence branch unrelated to the subject', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('relevant', 'persistIdeaReport').persistence('relevant')
      .symbol('noise1', 'recordTelemetry').symbol('noise2', 'flushTelemetry')
      .symbol('noise3', 'storeTelemetry').persistence('noise3')
      .call('entry', 'relevant').call('entry', 'noise1')
      .call('noise1', 'noise2').call('noise2', 'noise3')
    const result = selectWorkflow(fixture.index(), plan('workflow'))
    expect(result.complete).toBe(true)
    expect(result.terminalSymbolIds).toEqual(['relevant'])
  })

  it('keeps locate and explain focused without imposing workflow terminals', () => {
    const locate = new Fixture().symbol('subject', 'ideaReport').index()
    const explain = new Fixture().symbol('subject', 'ideaReport')
      .behavior('subject').index()
    const located = selectWorkflow(locate, plan('locate'))
    expect(located.complete).toBe(true)
    expect(located.operationIds).toEqual([])
    expect(located.controlGroups).toEqual([])
    const explained = selectWorkflow(explain, plan('explain'))
    expect(explained.complete).toBe(true)
    expect(explained.obligations.find(({ kind }) => kind === 'behavior'))
      .toEqual(expect.objectContaining({
        proven: true, operationIds: ['subject-returns'], edgeIds: [],
      }))
  })

  it.each(['x', 'Δ', 'مرحبا'])(
    'locates Unicode and one-character identifiers: %s',
    (label) => {
      const result = selectWorkflow(
        new Fixture().symbol('subject', label).index(),
        plan('locate', label),
      )

      expect(result.complete).toBe(true)
      expect(result.symbolIds).toEqual(['subject'])
    },
  )

  it('closes a nonterminal persistence behavior over its authenticated backing call', () => {
    const fixture = new Fixture().symbol('subject', 'ideaReport').persistence('subject')
    fixture.owners.set('subject', [...fixture.owners.get('subject')!].reverse())
    const result = selectWorkflow(fixture.index(), plan('explain'))

    expect(result.complete).toBe(true)
    expect(result.operationIds).toEqual([
      'subject-persistence', 'subject-persistence-call',
    ])
  })

  it('cannot prove explanation behavior from a declaration alone', () => {
    const result = selectWorkflow(
      new Fixture().symbol('subject', 'ideaReport').index(),
      plan('explain'),
    )

    expect(result.complete).toBe(false)
    expect(result.operationIds).toEqual([])
    expect(result.obligations.find(({ kind }) => kind === 'behavior'))
      .toEqual(expect.objectContaining({ proven: false, operationIds: [], edgeIds: [] }))
    expect(result.missing).toEqual([
      { code: 'behavior_unproven', target: 'idea report', obligationId: 'o2' },
    ])
  })

  it('includes both endpoints when explaining an authenticated direct call', () => {
    const fixture = new Fixture()
      .symbol('submit', 'submitOrder')
      .symbol('save', 'saveOrder')
      .call('submit', 'save')
      .behavior('save')
    const query: QueryPlan = {
      ...plan('explain', 'submit order'),
      terms: ['order', 'save', 'submit'],
    }

    const result = selectWorkflow(fixture.index(), query)

    expect(result.complete).toBe(true)
    expect(result.symbolIds).toEqual(['save', 'submit'])
    expect(result.rootSymbolIds).toEqual(['submit'])
    expect(result.links).toEqual([expect.objectContaining({
      kind: 'direct', fromId: 'submit', toId: 'save',
    })])
    expect(result.obligations.find(({ kind }) => kind === 'behavior'))
      .toEqual(expect.objectContaining({
        proven: true,
        operationIds: ['submit-calls-save'],
        edgeIds: result.edges.map(({ id }) => id),
      }))
    expect(result.metrics.causalRelationHops).toBe(1)
  })

  it('cannot prove a requested behavior with an unrelated call', () => {
    const fixture = new Fixture()
      .symbol('entry', 'submitOrder')
      .symbol('telemetry', 'logTelemetry')
      .call('entry', 'telemetry')
    const query = {
      ...plan('explain', 'submit order'),
      terms: ['order', 'save', 'submit'],
      obligations: [
        { id: 'o1', kind: 'subject', target: 'submit order', mandatory: true },
        { id: 'o2', kind: 'behavior', target: 'save', mandatory: true },
      ],
    } satisfies QueryPlan

    const result = selectWorkflow(fixture.index(), query)

    expect(result.complete).toBe(false)
    expect(result.missing).toContainEqual({
      code: 'behavior_unproven', target: 'save', obligationId: 'o2',
    })
  })

  it('proves a compound responsibility across a bounded direct-call bundle', () => {
    const fixture = new Fixture()
      .symbol('close', 'runMonthlyCloseJob')
      .symbol('collect', 'collectOutstandingInvoices', 'src/billing/invoice-service.ts')
      .symbol('report', 'buildMonthlyRevenueReport')
      .call('close', 'collect').call('close', 'report')
      .behavior('collect').behavior('report')
    const query: QueryPlan = {
      ...plan('explain', 'monthly billing close'),
      terms: ['billing', 'close', 'monthly', 'run'],
    }

    const result = selectWorkflow(fixture.index(), query)

    expect(result.complete).toBe(true)
    expect(result.symbolIds).toEqual(['close', 'collect', 'report'])
    expect(result.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromId: 'close', toId: 'collect' }),
      expect.objectContaining({ fromId: 'close', toId: 'report' }),
    ]))
    expect(result.obligations.find(({ kind }) => kind === 'subject'))
      .toEqual(expect.objectContaining({
        proven: true,
        symbolIds: expect.arrayContaining(['close', 'collect']),
      }))
    expect(result.obligations.find(({ kind }) => kind === 'behavior'))
      .toEqual(expect.objectContaining({
        proven: true,
        operationIds: expect.arrayContaining([
          'close-calls-collect', 'close-calls-report',
        ]),
      }))
  })

  it('keeps an exact locator on the declaration instead of a called suffix match', () => {
    const fixture = new Fixture()
      .symbol('handle', 'handleClick')
      .symbol('track', 'trackClick')
      .symbol('redirect', 'redirectToDestination')
      .call('handle', 'track')
      .call('handle', 'redirect')

    const result = selectWorkflow(fixture.index(), plan('locate', 'handle click'))

    expect(result.complete).toBe(true)
    expect(result.symbolIds).toEqual(['handle'])
  })

  it('uses authenticated read/write intent to disambiguate exact field locators', () => {
    const fixture = new Fixture()
      .symbol('read', 'findUserByResetToken')
      .symbol('write', 'saveResetToken')
      .persistence(
        'read', 'read-token', 'read',
        { kind: 'literal', value: 'reset token' },
      )
      .persistence(
        'write', 'write-token', 'update',
        { kind: 'literal', value: 'reset token' },
      )
      .index()
    const base = plan('locate', 'reset token')
    const terms = ['email', 'job', 'reset', 'run', 'token']

    expect(selectWorkflow(fixture, { ...base, terms, access: 'write' }).symbolIds)
      .toEqual(['write'])
    expect(selectWorkflow(fixture, { ...base, terms, access: 'read' }).symbolIds)
      .toEqual(['read'])
  })

  it('requires every significant subject term and meaningful explanation behavior', () => {
    const partial = new Fixture().symbol('subject', 'reportTelemetry').index()
    const literalOnly = new Fixture().symbol('subject', 'ideaReport')
      .literal('subject').index()
    expect(selectWorkflow(partial, plan('locate')).complete).toBe(false)
    const explanation = selectWorkflow(literalOnly, plan('explain'))
    expect(explanation.complete).toBe(false)
    expect(explanation.missing.map((entry) => entry.code)).toContain('behavior_unproven')
  })

  it('fails closed when a selected intermediate stage has an incomplete handoff', () => {
    const fixture = directFixture()
      .channel({
        id: 'orphan-job', node_kind: 'channel', channel_kind: 'job',
        transport: 'bullmq', key: 'orphan',
        parent_channel_id: 'missing-queue',
      })
      .edge('stage', 'orphan-job', 'publishes_to')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(false)
    expect(result.symbolIds).toEqual(['entry', 'stage', 'terminal'])
    expect(result.missing.map((entry) => entry.code))
      .toContain('adjacent_handoff_unproven')
  })

  it('does not accept read-only persistence as a terminal write', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('reader', 'readIdeaReport').persistence('reader', 'read-only', 'read')
      .call('entry', 'reader')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(false)
    expect(result.terminalSymbolIds).toEqual([])
    expect(result.missing.map((entry) => entry.code))
      .toContain('terminal_persistence_unproven')
  })

  it('preserves repeated authenticated calls between the same symbols', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('terminal', 'persistIdeaReport').persistence('terminal')
      .call('entry', 'terminal', 'first-call')
      .call('entry', 'terminal', 'second-call')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.operationIds).toEqual(expect.arrayContaining([
      'first-call', 'second-call',
    ]))
    expect(result.links).toHaveLength(2)
    expect(result.links.flatMap((link) => link.operationIds).sort()).toEqual([
      'first-call', 'second-call',
    ])
  })

  it('selects the same topology after file and symbol identifiers are renamed', () => {
    const build = (ids: readonly [string, string, string], prefix: string): Fixture =>
      new Fixture()
        .symbol(ids[0], 'alpha', `${prefix}/one.ts`)
        .literal(ids[0], `${ids[0]}-subject`, 'idea report')
        .symbol(ids[1], 'beta', `${prefix}/two.ts`)
        .symbol(ids[2], 'gamma', `${prefix}/three.ts`)
        .persistence(ids[2])
        .call(ids[0], ids[1])
        .call(ids[1], ids[2])
    const first = selectWorkflow(
      build(['a', 'b', 'c'], 'src/original').index(),
      plan('workflow'),
    )
    const renamed = selectWorkflow(
      build(['x', 'y', 'z'], 'src/renamed').index(),
      plan('workflow'),
    )
    const shape = (result: typeof first) => ({
      complete: result.complete,
      symbols: result.symbolIds.length,
      terminals: result.terminalSymbolIds.length,
      relations: result.edges.map((edge) => edge.relation),
      handoffs: result.links.map((link) => link.kind),
      controls: result.controlGroups.map((group) => group.kind),
    })

    expect(shape(renamed)).toEqual(shape(first))
    expect(first.complete).toBe(true)
  })

  it('rejects an isolated lexical decoy before bounded recovery', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateReport')
      .symbol('stage', 'assembleIdeaReport')
      .symbol('terminal', 'persistIdeaReport')
      .call('entry', 'stage').call('stage', 'terminal')
      .persistence('terminal')
      .symbol('decoy', 'ideaReport')
    const result = selectWorkflow(fixture.index(), plan('workflow'))
    expect(result.complete).toBe(true)
    expect(result.rootSymbolIds).toEqual(['entry'])
    expect(result.metrics.recoveryPasses).toBe(0)
    expect(result.metrics.recoveryFrontierCount).toBe(0)
  })

  it('prefers an executable entry corridor over a one-link report UI decoy', () => {
    const fixture = new Fixture()
      .symbol(
        'ui-root',
        'ReportMetaPanel',
        'src/features/idea/FullReportView.tsx',
      )
      .symbol('format-date', 'formatHeaderDate')
      .call('ui-root', 'format-date')
      .symbol(
        'entry',
        'generateFromProblem',
        'src/modules/ideas/idea-generation.controller.ts',
      )
      .symbol('stage', 'startPipeline')
      .symbol('terminal', 'persistIdeaReport')
      .call('entry', 'stage')
      .call('stage', 'terminal')
      .persistence('terminal')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.rootSymbolIds).toEqual(['entry'])
    expect(result.symbolIds).not.toContain('ui-root')
  })

  it('keeps the generation entry when retry and migration roots share its pipeline', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateFromProblem', 'src/ideas/idea-generation.controller.ts')
      .symbol('retry', 'retryPipeline', 'src/ideas/idea-pipeline.controller.ts')
      .symbol('resume', 'resumePipeline')
      .symbol('migration', 'main', 'src/scripts/migrate-old-ideas.ts')
      .symbol('migrate', 'migrateIdea')
      .symbol('start', 'startPipeline')
      .symbol('enqueue', 'enqueueJob')
      .symbol('worker', 'processIdeaReport')
      .symbol('terminal', 'persistIdeaReport').persistence('terminal')
      .call('entry', 'start')
      .call('retry', 'resume')
      .call('resume', 'start')
      .call('migration', 'migrate')
      .call('migrate', 'start')
      .channel({
        id: 'queue', node_kind: 'channel', channel_kind: 'queue',
        transport: 'bullmq', key: 'reports',
      })
      .publish('start', 'enqueue', 'queue', 'publish-report')
      .edge('queue', 'worker', 'consumed_by')
      .call('worker', 'terminal')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.rootSymbolIds).toEqual(['entry'])
    expect(result.symbolIds).not.toEqual(expect.arrayContaining(['retry', 'migration']))
  })

  it('does not replace a stronger partial corridor with a disconnected complete backup', () => {
    const fixture = new Fixture()
      .symbol('a-primary', 'generateIdeaReport')
      .symbol('alpha', 'alpha')
      .symbol('omega', 'omega').behavior('omega')
      .call('a-primary', 'alpha').call('alpha', 'omega')
      .symbol('z-backup', 'generateIdeaReportBackup')
      .symbol('backup-terminal', 'persistBackup').persistence('backup-terminal')
      .call('z-backup', 'backup-terminal')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.rootSymbolIds).toEqual(['a-primary'])
    expect(result.symbolIds).toEqual(['a-primary', 'alpha', 'omega'])
    expect(result.terminalSymbolIds).toEqual([])
    expect(result.metrics.recoveryPasses).toBe(1)
    expect(result.metrics.recoveryFrontierCount).toBeGreaterThan(0)
    expect(result.metrics.recoveryFrontierCount).toBeLessThanOrEqual(64)
    expect(result.missing).toEqual([
      { code: 'terminal_persistence_unproven', target: 'idea report', obligationId: 'o7' },
    ])
  })

  it('ranks a connected production root ahead of a high-degree test hub in recovery', () => {
    const fixture = new Fixture()
      .symbol('decoy', 'ideaReport', 'tests/decoy.test.ts')
      .symbol('semantic-root', 'bootstrap', 'src/semantic.ts')
      .symbol('semantic-stage', 'ideaReportStage', 'src/semantic.ts')
      .symbol('semantic-terminal', 'omega', 'src/semantic.ts')
      .persistence('semantic-terminal')
      .call('semantic-root', 'semantic-stage')
      .call('semantic-stage', 'semantic-terminal')
      .symbol('hub', 'ideaReportHub', 'tests/hub.test.ts')
      .symbol('hub-terminal', 'sink', 'tests/hub.test.ts')
      .persistence('hub-terminal')
      .call('hub', 'hub-terminal')
    for (let index = 0; index < 20; index += 1) {
      fixture.symbol(`noise-${index}`, `noise${index}`, 'tests/hub.test.ts')
        .call('hub', `noise-${index}`)
    }

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.rootSymbolIds).toEqual(['semantic-root'])
    expect(result.terminalSymbolIds).toEqual(['semantic-terminal'])
    expect(result.symbolIds).not.toContain('hub')
  })

  it('does not let a test caller disqualify a production entrypoint', () => {
    const fixture = new Fixture()
      .symbol('harness', 'runIdeaReportHarness', 'tests/report.test.ts')
      .symbol('entry', 'generateIdeaReport', 'src/report.ts')
      .symbol('terminal', 'persistIdeaReport', 'src/report.ts')
      .persistence('terminal')
      .call('harness', 'entry')
      .call('entry', 'terminal')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.rootSymbolIds).toEqual(['entry'])
    expect(result.symbolIds).not.toContain('harness')
  })

  it('is deterministic and bounded with 10k disconnected distractors', () => {
    const fixture = directFixture()
    fixture.symbol('hub', 'generateIdeaReport', 'tests/hub.test.ts').dynamicCall('hub')
    for (let index = 0; index < 40; index += 1) {
      fixture.symbol(`test-decoy-${index}`, 'generateIdeaReport', `tests/decoy-${index}.test.ts`)
    }
    for (let index = 0; index < 10_000; index += 1) {
      fixture.symbol(
        `noise-${index.toString().padStart(5, '0')}`,
        `generateIdeaReportNoise${index}`,
      )
    }
    const index = fixture.index(), query = plan('workflow')
    const first = selectWorkflow(index, query)
    const second = selectWorkflow(index, query)
    expect(second).toEqual(first)
    expect(first.complete).toBe(true)
    expect(first.rootSymbolIds).toEqual(['entry'])
    expect(first.metrics.candidateCount).toBeLessThanOrEqual(32)
    expect(first.metrics.actualNodeCount).toBeLessThanOrEqual(512)
    expect(first.metrics.causalRelationHops).toBeLessThanOrEqual(24)
    expect(first.metrics.recoveryFrontierCount).toBeLessThanOrEqual(64)
    expect(first.rootSymbolIds).toHaveLength(1)
  })

  it('fails closed when every complete corridor exceeds the 24-relation bound', () => {
    const fixture = new Fixture().symbol('n0', 'generateIdeaReport')
    for (let index = 1; index <= 25; index += 1) {
      fixture.symbol(`n${index}`, `ideaReportStage${index}`)
        .call(`n${index - 1}`, `n${index}`)
    }
    fixture.persistence('n25')
    const result = selectWorkflow(fixture.index(), plan('workflow'))
    expect(result.complete).toBe(false)
    expect(result.terminalSymbolIds).toEqual([])
    expect(result.metrics.actualNodeCount).toBeLessThanOrEqual(512)
    expect(result.metrics.causalRelationHops).toBeLessThanOrEqual(24)
    expect(result.metrics.bounded).toBe(true)
    expect(result.metrics.recoveryPasses).toBe(1)
    expect(result.metrics.recoveryFrontierCount).toBeLessThanOrEqual(64)
    expect(result.missing.map((entry) => entry.code)).toContain('selection_bound_reached')
  })

  it('never substitutes a catch shortcut for an over-limit success corridor', () => {
    const fixture = new Fixture().symbol('entry', 'generateIdeaReport')
    let previous = 'entry'
    for (let index = 1; index <= 24; index += 1) {
      const current = `stage-${index}`
      fixture.symbol(current, `ideaReportStage${index}`)
        .call(previous, current)
      previous = current
    }
    fixture.symbol('terminal', 'persistIdeaReport')
      .call(previous, 'terminal')
      .call('entry', 'terminal', 'failure-shortcut', [{
        kind: 'exception', arm: 'catch',
      }])
      .persistence('terminal')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(false)
    expect(result.operationIds).not.toContain('failure-shortcut')
    expect(result.metrics.bounded).toBe(true)
    expect(result.missing.map(({ code }) => code)).toContain('selection_bound_reached')
  })

  it('excludes a catch shortcut whose endpoints share the success corridor', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('stage', 'assembleIdeaReport')
      .symbol('terminal', 'persistIdeaReport').persistence('terminal')
      .call('entry', 'stage', 'success-entry')
      .call('stage', 'terminal', 'success-terminal')
      .call('entry', 'terminal', 'failure-shortcut', [{
        kind: 'exception', arm: 'catch',
      }])

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.operationIds).toEqual(expect.arrayContaining([
      'success-entry', 'success-terminal',
    ]))
    expect(result.operationIds).not.toContain('failure-shortcut')
    expect(result.links).toHaveLength(2)
  })

  it('retains a guaranteed finally handoff in the normal workflow', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('terminal', 'persistIdeaReport').persistence('terminal')
      .symbol('audit', 'persistIdeaReportAudit').persistence('audit')
      .call('entry', 'terminal', 'try-call', [{
        kind: 'exception', arm: 'try',
      }])
      .call('entry', 'audit', 'finally-call', [{
        kind: 'exception', arm: 'finally',
      }])

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.terminalSymbolIds).toEqual(['audit', 'terminal'])
    expect(result.operationIds).toEqual(expect.arrayContaining([
      'try-call', 'finally-call',
    ]))
  })

  it('keeps ordinary stages whose alpha-renamed identifiers contain failure words', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('stage', 'recordFailureMetrics')
      .symbol('terminal', 'persistIdeaReport')
      .call('entry', 'stage')
      .call('stage', 'terminal')
      .persistence('terminal')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.symbolIds).toEqual(['entry', 'stage', 'terminal'])
  })

  it('binds a nested publish statement by exact range and avoids explicit failure data', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('failure', 'alpha')
      .symbol('normal', 'beta')
      .symbol('enqueue', 'enqueue')
      .symbol('nested', 'format')
      .symbol('terminal', 'persistIdeaReport')
      .switchSelector('terminal', 'terminal-trigger')
      .persistenceInCase('terminal', 'terminal-trigger', 'assembly_complete')
      .channel({
        id: 'queue', node_kind: 'channel', channel_kind: 'queue',
        transport: 'bullmq', key: 'reports',
      })
      .call('entry', 'failure')
      .call('entry', 'normal')
      .publishWithNestedCall(
        'failure', 'enqueue', 'nested', 'queue', 'failed-publish',
        [{ kind: 'object', entries: [{
          key: 'status', value: { kind: 'literal', value: 'FAILED' },
        }] }],
      )
      .publish(
        'normal', 'enqueue', 'queue', 'normal-publish',
        [triggerPayload('assembly_complete')], 0,
      )
      .edge('queue', 'terminal', 'consumed_by')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(true)
    expect(result.symbolIds).toContain('normal')
    expect(result.symbolIds).not.toContain('failure')
    expect(result.operationIds).toContain('normal-publish')
    expect(result.operationIds).not.toContain('failed-publish')
  })

  it('does not authenticate a publisher from statement range alone', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('enqueue', 'enqueue')
      .symbol('terminal', 'persistIdeaReport').persistence('terminal')
      .channel({
        id: 'queue', node_kind: 'channel', channel_kind: 'queue',
        transport: 'bullmq', key: 'reports',
      })
      .publishWithMismatchedRange('entry', 'enqueue', 'queue', 'publish')
      .edge('queue', 'terminal', 'consumed_by')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(false)
    expect(result.operationIds).not.toContain('publish')
    expect(result.missing).toContainEqual({
      code: 'obligation_target_unproven',
      target: 'idea report',
      obligationId: 'o6',
    })
  })

  it('fails closed when distinct channel and direct routes exceed the relation bound', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('enqueue', 'enqueueJob')
      .symbol('a-merge', 'alpha')
      .symbol('z-short', 'beta')
      .channel({
        id: 'queue', node_kind: 'channel', channel_kind: 'queue',
        transport: 'bullmq', key: 'reports',
      })
      .channel({
        id: 'job', node_kind: 'channel', channel_kind: 'job',
        transport: 'bullmq', key: 'assemble', parent_channel_id: 'queue',
      })
      .publish('entry', 'enqueue', 'job', 'slow-publish')
      .route('job', 'queue', 'entry', 'slow-publish')
      .edge('queue', 'a-merge', 'consumed_by')
      .call('entry', 'z-short')
      .call('z-short', 'a-merge')
    let previous = 'a-merge'
    for (let index = 1; index <= 22; index += 1) {
      const current = `n${index}`
      fixture.symbol(current, index === 22 ? 'persistIdeaReport' : `alpha${index}`)
        .call(previous, current)
      previous = current
    }
    fixture.persistence('n22')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(false)
    expect(result.metrics.bounded).toBe(true)
    expect(result.missing).toContainEqual({
      code: 'selection_bound_reached', target: 'idea report',
    })
  })

  it('fails closed when 25 distinct persisted terminal edges are required', () => {
    const fixture = new Fixture().symbol('entry', 'generateIdeaReport')
    for (let index = 0; index < 25; index += 1) {
      const terminal = `terminal-${index}`
      fixture.symbol(terminal, `persistIdeaReport${index}`).persistence(terminal)
        .call('entry', terminal)
    }

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(false)
    expect(result.metrics.causalRelationHops).toBeLessThanOrEqual(24)
    expect(result.metrics.bounded).toBe(true)
    expect(result.missing.map(({ code }) => code)).toContain('selection_bound_reached')
  })

  it('fails closed when a multi-terminal selection would drop a distinct long route', () => {
    const fixture = new Fixture()
      .symbol('entry', 'generateIdeaReport')
      .symbol('terminal-a', 'persistIdeaReportA').persistence('terminal-a')
      .symbol('terminal-b', 'persistIdeaReportB').persistence('terminal-b')
      .call('entry', 'terminal-a', 'direct-a')
      .call('entry', 'terminal-b', 'direct-b')
    let owner = 'entry'
    for (let index = 0; index < 24; index += 1) {
      const next = `stage-${index}`
      fixture.symbol(next, `ideaReportStage${index}`)
        .call(owner, next, `long-${index}`)
      owner = next
    }
    fixture.call(owner, 'terminal-a', 'long-terminal')

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(false)
    expect(result.metrics.bounded).toBe(true)
    expect(result.missing.map(({ code }) => code)).toContain('selection_bound_reached')
  })

  it('keeps a terminal-free fan-out inside the global relation bound', () => {
    const fixture = new Fixture().symbol('entry', 'generateIdeaReport').behavior('entry')
    for (let index = 0; index < 25; index += 1) {
      fixture.symbol(`stage${index}`, `ideaReportStage${index}`).behavior(`stage${index}`)
        .call('entry', `stage${index}`)
    }

    const result = selectWorkflow(fixture.index(), plan('workflow'))

    expect(result.complete).toBe(false)
    expect(result.rootSymbolIds).toEqual(['entry'])
    expect(result.metrics.causalRelationHops).toBeLessThanOrEqual(24)
    expect(result.metrics.bounded).toBe(true)
    expect(result.missing.map((entry) => entry.code)).toContain('selection_bound_reached')
  })

  it('reports zero attempted roots when no lexical candidate exists', () => {
    const fixture = new Fixture().symbol('unrelated', 'telemetry')
    const result = selectWorkflow(fixture.index(), plan('workflow'))
    expect(result.complete).toBe(false)
    expect(result.metrics.rootCandidateCount).toBe(0)
    expect(result.metrics.recoveryPasses).toBe(0)
  })
})
