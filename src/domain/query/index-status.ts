import {
  KnowledgeGraph,
  type GraphAttributes,
  type GraphEdge,
} from '../graph/directed-multigraph.js'
import { compareCodeUnits } from '../graph/canonical-json.js'
import {
  CANONICAL_INDEX_FORMAT_VERSION,
  readBuildState,
  type SourceSnapshotEntry,
} from '../index/build-state.js'
import type {
  IndexBodyFact,
  IndexChannelKind,
  IndexChannelNode,
  IndexChannelTransport,
  IndexControlFrame,
  IndexRange,
  IndexValue,
} from '../index/model.js'
import { decodeIndexBodyFactTable, indexChannelId } from '../index/model.js'
import { isRecord } from '../../shared/guards.js'

export interface QueryGraph {
  hasNode(id: string): boolean; hasEdge(source: string, target: string): boolean
  nodeEntries(): Array<[string, GraphAttributes]>
  edgeEntries(): Array<[string, string, GraphAttributes, string]>
  predecessors(id: string): string[]; successors(id: string): string[]
  edgesBetween(source: string, target: string): GraphEdge[]; nodeAttributes(id: string): GraphAttributes
}

export interface ReadyQueryIndex {
  state: 'ready'; graph: QueryGraph; root_path: string
  file_hashes: ReadonlyMap<string, string>; unsupported_sources: readonly SourceSnapshotEntry[]
  operation_by_id: ReadonlyMap<string, IndexBodyFact>
  operations_by_owner: ReadonlyMap<string, readonly IndexBodyFact[]>
  channels_by_id: ReadonlyMap<string, IndexChannelNode>
  channels_by_key: ReadonlyMap<string, readonly IndexChannelNode[]>
}

export interface FailedQueryIndex { state: 'unavailable' | 'corrupt'; subject: string }

export type QueryIndex = ReadyQueryIndex | FailedQueryIndex

const SHA256 = /^[a-f0-9]{64}$/
const MAX_TEXT = 512
const KINDS = new Set<IndexChannelKind>(['queue', 'job', 'event'])
const TRANSPORTS = new Set<IndexChannelTransport>([
  'bull',
  'bullmq',
  'node-event-emitter',
  'nestjs-event-emitter',
])
const RELATIONS = new Set([
  'publishes_to',
  'routes_through',
  'consumed_by',
])
const EDGE_SOURCES = new Set([
  'typescript-semantic',
  'typescript-syntactic',
  'framework-decorator',
  'wrapper-summary',
])

class QueryIndexIntegrityError extends Error {}

function fail(subject: string): never {
  throw new QueryIndexIntegrityError(subject)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

function bounded(value: unknown, maxBytes: number): value is string {
  return nonEmpty(value)
    && Buffer.byteLength(value, 'utf8') <= maxBytes
}

function safeInt(value: unknown, minimum = 0): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= minimum
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
    if (!isRecord(value))
        return null;
    const allowed = new Set([...required, ...optional]);
    return required.every((key) => Object.hasOwn(value, key))
        && Object.keys(value).every((key) => allowed.has(key))
        ? value
        : null;
}

function comparePos(left: IndexRange['start'], right: IndexRange['start']): number {
    return left.line - right.line || left.column - right.column;
}

function parseRange(value: unknown): IndexRange | null {
  const range = exact(value, ['start', 'end'])
  const start = exact(range?.start, ['line', 'column'])
  const end = exact(range?.end, ['line', 'column'])
  if (!range || !start || !end
    || !safeInt(start.line, 1) || !safeInt(start.column, 1)
    || !safeInt(end.line, 1) || !safeInt(end.column, 1)) return null
  const parsed = {
    start: { line: start.line, column: start.column },
    end: { line: end.line, column: end.column },
  }
  return comparePos(parsed.start, parsed.end) <= 0 ? parsed : null
}

function containsRange(container: IndexRange, value: IndexRange): boolean {
  return comparePos(container.start, value.start) <= 0
    && comparePos(value.end, container.end) <= 0
}

function sameRange(left: IndexRange, right: IndexRange): boolean {
  return comparePos(left.start, right.start) === 0
    && comparePos(left.end, right.end) === 0
}

function validBranchArm(
  control: Extract<IndexBodyFact, { kind: 'condition' }>,
  arm: string,
): boolean {
  if (control.condition_kind === 'if') return ['then', 'else'].includes(arm)
  if (control.condition_kind === 'switch') {
    return arm === 'default' || (arm.startsWith('case:') && arm.length > 5)
  }
  if (control.condition_kind === 'logical_and') return arm === 'truthy'
  if (control.condition_kind === 'logical_or') return arm === 'falsy'
  if (control.condition_kind === 'nullish') return arm === 'nullish'
  return control.condition_kind === 'ternary'
    ? ['truthy', 'falsy'].includes(arm)
    : ['then', 'else'].includes(arm)
}

function edgeProof(attrs: GraphAttributes, fileIds: ReadonlyMap<string, string>, nodeById: ReadonlyMap<string, GraphAttributes>): boolean {
    const source = attrs.source_file;
    const ownerId = attrs.execution_owner_id;
    const owner = typeof ownerId === 'string' ? nodeById.get(ownerId) : undefined;
    const span = parseRange(owner?.definition_range);
    const record = exact(attrs.evidence, ['source', 'range', 'statement_range', 'excerpt_sha256']);
    const range = parseRange(record?.range);
    const statement = parseRange(record?.statement_range);
    return typeof source === 'string'
        && fileIds.has(source)
        && typeof ownerId === 'string'
        && owner?.source_file === source
        && owner?.node_kind !== 'file'
        && owner?.node_kind !== 'channel'
        && span !== null
        && record !== null
        && EDGE_SOURCES.has(String(record.source))
        && range !== null
        && statement !== null
        && containsRange(span, statement)
        && containsRange(statement, range)
        && typeof record.excerpt_sha256 === 'string'
        && SHA256.test(record.excerpt_sha256);
}

function valueHas(value: IndexValue, test: (candidate: IndexValue) => boolean): boolean {
    if (test(value))
        return true;
    if (value.kind === 'array') {
        return value.elements.some((entry) => valueHas(entry, test));
    }
    if (value.kind === 'object') {
        return value.entries.some((entry) => valueHas(entry.value, test));
    }
    return value.kind === 'template'
        && value.parts.some((entry) => valueHas(entry, test));
}

function factHas(
  fact: IndexBodyFact,
  test: (candidate: IndexValue) => boolean,
): boolean {
  let values: readonly IndexValue[]
  switch (fact.kind) {
    case 'call':
      values = fact.arguments; break
    case 'literal':
      values = [fact.value]; break
    case 'condition':
    case 'loop':
      values = fact.test ? [fact.test] : []; break
    case 'parallel':
      values = fact.input ? [fact.input] : []; break
    case 'return':
    case 'throw':
    case 'mutation':
      values = fact.value ? [fact.value] : []; break
    case 'persistence':
      values = fact.resource ? [fact.resource] : []
  }
  return values.some((value) => valueHas(value, test))
}

function channelFrom(id: string, attrs: GraphAttributes): IndexChannelNode | null {
    if (!nonEmpty(id)
        || !KINDS.has(attrs.channel_kind as IndexChannelKind)
        || !TRANSPORTS.has(attrs.transport as IndexChannelTransport)
        || !bounded(attrs.key, MAX_TEXT)
        || (Object.hasOwn(attrs, 'parent_channel_id')
            && !nonEmpty(attrs.parent_channel_id))
        || (Object.hasOwn(attrs, 'scope')
            && !bounded(attrs.scope, 512)))
        return null;
    const channel: IndexChannelNode = {
        id,
        node_kind: 'channel',
        channel_kind: attrs.channel_kind as IndexChannelKind,
        transport: attrs.transport as IndexChannelTransport,
        key: attrs.key,
        ...(typeof attrs.parent_channel_id === 'string'
            ? { parent_channel_id: attrs.parent_channel_id }
            : {}),
        ...(typeof attrs.scope === 'string'
            ? { scope: attrs.scope }
            : {}),
    };
    return id === indexChannelId(channel) ? channel : null;
}

function orderCmp(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freeze(entry)
    Object.freeze(value)
  }
  return value
}

function sealMap<K, V>(entries: Iterable<readonly [
    K,
    V
]>): ReadonlyMap<K, V> {
    const values = new Map(entries);
    let facade: ReadonlyMap<K, V>;
    facade = {
        get size() { return values.size; },
        get(key: K) { return values.get(key); },
        has(key: K) { return values.has(key); },
        entries() { return values.entries(); },
        keys() { return values.keys(); },
        values() { return values.values(); },
        forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
            values.forEach((value, key) => callback.call(thisArg, value, key, facade));
        },
        [Symbol.iterator]() { return values[Symbol.iterator](); },
    };
    return Object.freeze(facade);
}

function sortEntries<V>(
  values: ReadonlyMap<string, V>,
): Array<readonly [string, V]> {
  return [...values.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
}

type ExecutionIndexes = Pick<ReadyQueryIndex, 'operation_by_id' | 'operations_by_owner' | 'channels_by_id' | 'channels_by_key'>;

function buildMaps(view: KnowledgeGraph, fileIds: ReadonlyMap<string, string>): ExecutionIndexes {
    const nodes = view.nodeEntries();
    const nodeById = new Map(nodes);
    const symbolIds = new Set<string>();
    const factById = new Map<string, IndexBodyFact>();
    const ownedFacts = new Map<string, IndexBodyFact[]>();
    const channels = new Map<string, IndexChannelNode>();
    const byKey = new Map<string, IndexChannelNode[]>();
    const orderKeys = new Map<string, Set<string>>();
    for (const [id, attrs] of nodes) {
        if (attrs.node_kind === 'channel') {
            if (Object.hasOwn(attrs, 'body_facts')) {
                fail('canonical channel body facts');
            }
            const channel = channelFrom(id, attrs);
            if (!channel)
                fail('canonical channel node');
            channels.set(id, channel);
            continue;
        }
        if (attrs.node_kind === 'file') {
            if (Object.hasOwn(attrs, 'body_facts')
                || Object.hasOwn(attrs, 'channel_kind')
                || Object.hasOwn(attrs, 'parent_channel_id')) {
                fail('canonical file-node execution metadata');
            }
            continue;
        }
        if (Object.hasOwn(attrs, 'channel_kind')
            || Object.hasOwn(attrs, 'parent_channel_id')) {
            fail('canonical channel discriminator');
        }
        symbolIds.add(id);
        if (!Object.hasOwn(attrs, 'body_facts'))
            continue;
        const source = attrs.source_file;
        const fileId = typeof source === 'string'
            ? fileIds.get(source)
            : undefined;
        const span = parseRange(attrs.definition_range);
        const ownerFile = fileId ? nodeById.get(fileId) : undefined;
        if (!fileId || !span || !ownerFile
            || ownerFile.node_kind !== 'file') {
            fail('canonical operation owner');
        }
        const facts = decodeIndexBodyFactTable(attrs.body_facts, id, fileId);
        if (!facts)
            fail('canonical symbol body facts');
        const orders = orderKeys.get(id) ?? new Set<string>();
        orderKeys.set(id, orders);
        for (const fact of facts) {
            if (!containsRange(span, fact.evidence.statement_range)
                || factById.has(fact.id)) {
                fail('canonical operation fact');
            }
            const orderKey = fact.order.join('.');
            if (orders.has(orderKey))
                fail('canonical operation order');
            orders.add(orderKey);
            factById.set(fact.id, fact);
            const owned = ownedFacts.get(id) ?? [];
            owned.push(fact);
            ownedFacts.set(id, owned);
        }
    }
    for (const channel of channels.values()) {
        if (channel.channel_kind === 'job') {
            const parent = channel.parent_channel_id
                ? channels.get(channel.parent_channel_id)
                : undefined;
            if (!parent || parent.channel_kind !== 'queue'
                || parent.transport !== channel.transport) {
                fail('canonical job parent channel');
            }
        }
        else if (channel.parent_channel_id !== undefined) {
            fail('canonical non-job parent channel');
        }
        if (channel.channel_kind === 'event') {
            if (!bounded(channel.scope, 512)) {
                fail('canonical event channel scope');
            }
        }
        else if (channel.scope !== undefined) {
            fail('canonical non-event channel scope');
        }
        const keyed = byKey.get(channel.key) ?? [];
        keyed.push(channel);
        byKey.set(channel.key, keyed);
    }
    for (const fact of factById.values()) {
        if (factHas(fact, (value) => value.kind === 'symbol' && !symbolIds.has(value.symbol_id))) {
            fail('canonical operation value reference');
        }
        if (fact.kind === 'call' && fact.target_symbol_id
            && !symbolIds.has(fact.target_symbol_id)) {
            fail('canonical call target');
        }
        const controlIds = new Set<string>();
        for (const frame of fact.control) {
            if (frame.kind === 'exception')
                continue;
            if (controlIds.has(frame.controller_fact_id)) {
                fail('canonical duplicate control reference');
            }
            controlIds.add(frame.controller_fact_id);
            const control = factById.get(frame.controller_fact_id);
            const expectedKind = frame.kind === 'branch'
                ? 'condition'
                : frame.kind;
            const guardFallthrough = frame.kind === 'branch'
                && control?.kind === 'condition'
                && control.condition_kind === 'guard';
            if (!control || control.owner_symbol_id !== fact.owner_symbol_id
                || control.kind !== expectedKind
                || orderCmp(control.order, fact.order) >= 0
                || (!guardFallthrough && !containsRange(frame.kind === 'parallel'
                    ? control.evidence.range
                    : control.evidence.statement_range, fact.evidence.range))
                || (frame.kind === 'branch' && control.kind === 'condition'
                    && !validBranchArm(control, frame.arm))
                || (frame.kind === 'parallel' && control.kind === 'parallel'
                    && (frame.lane === 'each'
                        ? control.lane_count === 0
                        : frame.lane >= control.lane_count))
                || (fact.kind === 'call' && frame.kind === 'parallel'
                    && control.kind === 'parallel'
                    && !control.member_fact_ids.includes(fact.id))) {
                fail('canonical operation control reference');
            }
        }
        if (factHas(fact, (value) => value.kind === 'parameter' && value.scope === 'iteration')
            && !fact.control.some((frame) => {
                const control = frame.kind === 'loop'
                    ? factById.get(frame.controller_fact_id)
                    : undefined;
                return control?.kind === 'loop'
                    && control.loop_kind === 'array_iteration';
            })) {
            fail('canonical iteration parameter');
        }
        if (fact.kind === 'parallel') {
            const laneCount = fact.input?.kind === 'array'
                ? fact.input.elements.length
                : 0;
            if (fact.member_fact_ids.some((id) => {
                const member = factById.get(id);
                const frame = member?.control.find((candidate): candidate is Extract<IndexControlFrame, {
                    kind: 'parallel';
                }> => candidate.kind === 'parallel'
                    && candidate.controller_fact_id === fact.id);
                const loop = frame?.lane === 'each'
                    ? member?.control.some((candidate) => {
                        const control = candidate.kind === 'loop'
                            ? factById.get(candidate.controller_fact_id)
                            : undefined;
                        return control?.kind === 'loop'
                            && control.loop_kind === 'array_iteration';
                    })
                    : true;
                return !member || member.kind !== 'call' || !frame || !loop
                    || member.owner_symbol_id !== fact.owner_symbol_id;
            }) || fact.lane_count !== laneCount) {
                fail('canonical parallel member reference');
            }
        }
        if (fact.kind === 'persistence') {
            const call = factById.get(fact.call_fact_id);
            if (!call || call.kind !== 'call'
                || call.owner_symbol_id !== fact.owner_symbol_id
                || !sameRange(call.evidence.range, fact.evidence.range)
                || !sameRange(call.evidence.statement_range, fact.evidence.statement_range)
                || call.evidence.excerpt_sha256 !== fact.evidence.excerpt_sha256
                || call.order[0] !== fact.order[0]
                || call.order[2] !== fact.order[2]
                || call.order[3] !== fact.order[3]
                || JSON.stringify(call.control) !== JSON.stringify(fact.control)
                || !bounded(fact.receiver_type, MAX_TEXT)) {
                fail('canonical persistence call reference');
            }
        }
    }
    const routes = new Map<string, number>();
    for (const [source, target, attrs] of view.edgeEntries()) {
        const relation = attrs.relation;
        const fromChannel = channels.get(source);
        const toChannel = channels.get(target);
        const usesChannel = fromChannel !== undefined || toChannel !== undefined;
        if (!usesChannel && !RELATIONS.has(String(relation)))
            continue;
        if (!RELATIONS.has(String(relation))) {
            fail('canonical channel relation');
        }
        if (!edgeProof(attrs, fileIds, nodeById)) {
            fail('canonical channel evidence');
        }
        const edgeOwner = attrs.execution_owner_id;
        if (relation === 'publishes_to') {
            if (!symbolIds.has(source) || !toChannel
                || source !== edgeOwner
                || !['queue', 'job', 'event'].includes(toChannel.channel_kind)) {
                fail('canonical publishes_to endpoints');
            }
        }
        else if (relation === 'routes_through') {
            if (!fromChannel || fromChannel.channel_kind !== 'job'
                || !toChannel || toChannel.channel_kind !== 'queue'
                || fromChannel.parent_channel_id !== target
                || fromChannel.transport !== toChannel.transport) {
                fail('canonical routes_through endpoints');
            }
            routes.set(source, (routes.get(source) ?? 0) + 1);
        }
        else if (relation === 'consumed_by') {
            if (!fromChannel || !symbolIds.has(target) || toChannel) {
                fail('canonical consumed_by endpoints');
            }
        }
    }
    for (const channel of channels.values()) {
        if (channel.channel_kind === 'job'
            && routes.get(channel.id) !== 1) {
            fail('canonical job routing');
        }
    }
    for (const values of ownedFacts.values()) {
        values.sort((left, right) => orderCmp(left.order, right.order) || compareCodeUnits(left.id, right.id));
        values.forEach(freeze);
        Object.freeze(values);
    }
    for (const values of byKey.values()) {
        values.sort((left, right) => compareCodeUnits(left.id, right.id));
        values.forEach(freeze);
        Object.freeze(values);
    }
    factById.forEach(freeze);
    channels.forEach(freeze);
    return {
        operation_by_id: sealMap(sortEntries(factById)),
        operations_by_owner: sealMap(sortEntries(ownedFacts)),
        channels_by_id: sealMap(sortEntries(channels)),
        channels_by_key: sealMap(sortEntries(byKey)),
    };
}

function copyGraph(source: KnowledgeGraph): KnowledgeGraph {
  const view = new KnowledgeGraph(source.graph)
  for (const [id, attrs] of source.nodeEntries()) {
    view.addNode(id, attrs)
  }
  for (const [from, to, attrs, expectedId] of source.edgeEntries()) {
    const id = view.addEdge(from, to, attrs)
    if (id !== expectedId) {
      throw new Error('Canonical graph edge identity changed while sealing query index')
    }
  }
  return view
}

function sealGraph(view: KnowledgeGraph): QueryGraph {
    return Object.freeze({
        hasNode: (id: string) => view.hasNode(id),
        hasEdge: (source: string, target: string) => view.hasEdge(source, target),
        nodeEntries: () => view.nodeEntries(),
        edgeEntries: () => view.edgeEntries(),
        predecessors: (id: string) => view.predecessors(id),
        successors: (id: string) => view.successors(id),
        edgesBetween: (source: string, target: string) => view.edgesBetween(source, target),
        nodeAttributes: (id: string) => view.nodeAttributes(id),
    });
}

export function failedQueryIndex(
  state: FailedQueryIndex['state'],
  subject: string,
): FailedQueryIndex {
  return { state, subject }
}

export function inspectQueryIndex(graph: KnowledgeGraph): QueryIndex {
  let view: KnowledgeGraph
  try {
    view = copyGraph(graph)
  } catch {
    return failedQueryIndex('corrupt', 'canonical graph snapshot')
  }
  const build = readBuildState(view)
  const root = view.graph.root_path
  if (!build || view.graph.canonical_typescript_index !== true
    || view.graph.schema_version !== CANONICAL_INDEX_FORMAT_VERSION
    || typeof root !== 'string' || root.trim().length === 0
    || build.source_root.root_path !== root) {
    return failedQueryIndex('corrupt', 'canonical TypeScript index metadata')
  }
  if (build.completeness.summary.state !== 'complete'
    || build.completeness.supported_failures.length > 0) {
    return failedQueryIndex(
      'unavailable',
      'canonical TypeScript index incomplete',
    )
  }

  const hashes = new Map<string, string>()
  const fileIds = new Map<string, string>()
  for (const [id, attrs] of view.nodeEntries()) {
    if (attrs.node_kind !== 'file') continue
    const source = attrs.source_file
    const hash = attrs.content_hash
    if (typeof source !== 'string' || typeof hash !== 'string'
      || !SHA256.test(hash)) {
      return failedQueryIndex('corrupt', 'canonical file-node hash')
    }
    if (hashes.has(source) || fileIds.has(source)) {
      return failedQueryIndex('corrupt', source)
    }
    hashes.set(source, hash)
    fileIds.set(source, id)
  }

  if (hashes.size !== build.sources.supported.length
    || build.sources.supported.some((source) =>
      hashes.get(source.path) !== source.hash)) {
    return failedQueryIndex('corrupt', 'canonical file-node coverage')
  }

  let execution: ExecutionIndexes
  try {
    execution = buildMaps(view, fileIds)
  } catch (error) {
    return failedQueryIndex(
      'corrupt',
      error instanceof QueryIndexIntegrityError
        ? error.message
        : 'canonical execution index',
    )
  }
  for (const [id, attrs] of view.nodeEntries()) {
    if (!Object.hasOwn(attrs, 'body_facts')) continue
    const { body_facts: _decoded, ...retained } = attrs
    view.replaceNodeAttributes(id, retained)
  }

  return Object.freeze({
    state: 'ready',
    graph: sealGraph(view),
    root_path: root,
    file_hashes: sealMap(hashes),
    unsupported_sources: Object.freeze(
      build.sources.unsupported.map((source) => Object.freeze({ ...source })),
    ),
    ...execution,
  })
}
