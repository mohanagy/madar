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

class IntegrityError extends Error {}

function fail(subject: string): never {
  throw new IntegrityError(`canonical ${subject}`)
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && !v.includes('\0')
}

function bounded(v: unknown, maxBytes: number): v is string {
  return nonEmpty(v) && Buffer.byteLength(v, 'utf8') <= maxBytes
}

function safeInt(v: unknown, minimum = 0): v is number {
  return typeof v === 'number'
    && Number.isSafeInteger(v)
    && !Object.is(v, -0)
    && v >= minimum
}

function exact(v: unknown, keys: readonly string[]): Record<string, unknown> | null {
  return isRecord(v)
    && Object.keys(v).length === keys.length
    && keys.every((key) => Object.hasOwn(v, key))
    ? v : null
}

function posCmp(a: IndexRange['start'], b: IndexRange['start']): number {
  return a.line - b.line || a.column - b.column
}

function rangeOf(v: unknown): IndexRange | null {
  const range = exact(v, ['start', 'end'])
  const start = exact(range?.start, ['line', 'column'])
  const end = exact(range?.end, ['line', 'column'])
  if (!range || !start || !end
    || !safeInt(start.line, 1) || !safeInt(start.column, 1)
    || !safeInt(end.line, 1) || !safeInt(end.column, 1)) return null
  const parsed = {
    start: { line: start.line, column: start.column },
    end: { line: end.line, column: end.column },
  }
  return posCmp(parsed.start, parsed.end) <= 0 ? parsed : null
}

function contains(outer: IndexRange, inner: IndexRange): boolean {
  return posCmp(outer.start, inner.start) <= 0
    && posCmp(inner.end, outer.end) <= 0
}

function sameSpan(a: IndexRange, b: IndexRange): boolean {
  return posCmp(a.start, b.start) === 0
    && posCmp(a.end, b.end) === 0
}

function validArm(
  ctl: Extract<IndexBodyFact, { kind: 'condition' }>,
  arm: string,
): boolean {
  if (ctl.condition_kind === 'if') return ['then', 'else'].includes(arm)
  if (ctl.condition_kind === 'switch') {
    return arm === 'default' || (arm.startsWith('case:') && arm.length > 5)
  }
  if (ctl.condition_kind === 'logical_and') return arm === 'truthy'
  if (ctl.condition_kind === 'logical_or') return arm === 'falsy'
  if (ctl.condition_kind === 'nullish') return arm === 'nullish'
  return ctl.condition_kind === 'ternary'
    ? ['truthy', 'falsy'].includes(arm)
    : ['then', 'else'].includes(arm)
}

function edgeProof(a: GraphAttributes, files: ReadonlyMap<string, string>, nodes: ReadonlyMap<string, GraphAttributes>): boolean {
    const source = a.source_file;
    const ownerId = a.execution_owner_id;
    const owner = typeof ownerId === 'string' ? nodes.get(ownerId) : undefined;
    const span = rangeOf(owner?.definition_range);
    const record = exact(a.evidence, ['source', 'range', 'statement_range', 'excerpt_sha256']);
    const range = rangeOf(record?.range);
    const statement = rangeOf(record?.statement_range);
    return typeof source === 'string'
        && files.has(source)
        && typeof ownerId === 'string'
        && owner?.source_file === source
        && owner?.node_kind !== 'file'
        && owner?.node_kind !== 'channel'
        && span !== null
        && record !== null
        && EDGE_SOURCES.has(String(record.source))
        && range !== null
        && statement !== null
        && contains(span, statement)
        && contains(statement, range)
        && typeof record.excerpt_sha256 === 'string'
        && SHA256.test(record.excerpt_sha256);
}

function valueHas(v: IndexValue, test: (candidate: IndexValue) => boolean): boolean {
  return test(v)
    || v.kind === 'array' && v.elements.some((entry) => valueHas(entry, test))
    || v.kind === 'object' && v.entries.some((entry) => valueHas(entry.value, test))
    || v.kind === 'template' && v.parts.some((entry) => valueHas(entry, test))
}

function factHas(
  fact: IndexBodyFact,
  test: (candidate: IndexValue) => boolean,
): boolean {
  let xs: readonly IndexValue[]
  switch (fact.kind) {
    case 'call':
      xs = fact.arguments; break
    case 'literal':
      xs = [fact.value]; break
    case 'condition':
    case 'loop':
      xs = fact.test ? [fact.test] : []; break
    case 'parallel':
      xs = fact.input ? [fact.input] : []; break
    case 'return':
    case 'throw':
    case 'mutation':
      xs = fact.value ? [fact.value] : []; break
    case 'persistence':
      xs = fact.resource ? [fact.resource] : []
  }
  return xs.some((value) => valueHas(value, test))
}

function readChannel(id: string, a: GraphAttributes): IndexChannelNode | null {
    if (!nonEmpty(id)
        || !KINDS.has(a.channel_kind as IndexChannelKind)
        || !TRANSPORTS.has(a.transport as IndexChannelTransport)
        || !bounded(a.key, MAX_TEXT)
        || (Object.hasOwn(a, 'parent_channel_id')
            && !nonEmpty(a.parent_channel_id))
        || (Object.hasOwn(a, 'scope')
            && !bounded(a.scope, 512)))
        return null;
    const channel: IndexChannelNode = {
        id,
        node_kind: 'channel',
        channel_kind: a.channel_kind as IndexChannelKind,
        transport: a.transport as IndexChannelTransport,
        key: a.key,
        ...(typeof a.parent_channel_id === 'string'
            ? { parent_channel_id: a.parent_channel_id }
            : {}),
        ...(typeof a.scope === 'string'
            ? { scope: a.scope }
            : {}),
    };
    return id === indexChannelId(channel) ? channel : null;
}

function orderCmp(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index]! - b[index]!
    if (difference !== 0) return difference
  }
  return a.length - b.length
}

function freeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    for (const entry of Object.values(v)) freeze(entry)
    Object.freeze(v)
  }
  return v
}

function sealMap<K, V>(entries: Iterable<readonly [
    K,
    V
]>): ReadonlyMap<K, V> {
    const xs = new Map(entries);
    let view: ReadonlyMap<K, V>;
    view = {
        get size() { return xs.size; },
        get(key: K) { return xs.get(key); },
        has(key: K) { return xs.has(key); },
        entries() { return xs.entries(); },
        keys() { return xs.keys(); },
        values() { return xs.values(); },
        forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
            xs.forEach((value, key) => callback.call(thisArg, value, key, view));
        },
        [Symbol.iterator]() { return xs[Symbol.iterator](); },
    };
    return Object.freeze(view);
}

function sortEntries<V>(
  xs: ReadonlyMap<string, V>,
): Array<readonly [string, V]> {
  return [...xs.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
}

type ExecutionIndexes = Pick<ReadyQueryIndex, 'operation_by_id' | 'operations_by_owner' | 'channels_by_id' | 'channels_by_key'>;

function buildMaps(view: KnowledgeGraph, files: ReadonlyMap<string, string>): ExecutionIndexes {
    const nodes = view.nodeEntries();
    const byId = new Map(nodes);
    const symbols = new Set<string>();
    const facts = new Map<string, IndexBodyFact>();
    const owned = new Map<string, IndexBodyFact[]>();
    const chs = new Map<string, IndexChannelNode>();
    const byKey = new Map<string, IndexChannelNode[]>();
    const orderKeys = new Map<string, Set<string>>();
    for (const [id, a] of nodes) {
        if (a.node_kind === 'channel') {
            if (Object.hasOwn(a, 'body_facts')) {
                fail('channel body facts');
            }
            const ch = readChannel(id, a);
            if (!ch)
                fail('channel node');
            chs.set(id, ch);
            continue;
        }
        if (a.node_kind === 'file') {
            if (Object.hasOwn(a, 'body_facts')
                || Object.hasOwn(a, 'channel_kind')
                || Object.hasOwn(a, 'parent_channel_id')) {
                fail('file-node execution metadata');
            }
            continue;
        }
        if (Object.hasOwn(a, 'channel_kind')
            || Object.hasOwn(a, 'parent_channel_id')) {
            fail('channel discriminator');
        }
        symbols.add(id);
        if (!Object.hasOwn(a, 'body_facts'))
            continue;
        const source = a.source_file;
        const fileId = typeof source === 'string'
            ? files.get(source)
            : undefined;
        const span = rangeOf(a.definition_range);
        const ownerFile = fileId ? byId.get(fileId) : undefined;
        if (!fileId || !span || !ownerFile
            || ownerFile.node_kind !== 'file') {
            fail('operation owner');
        }
        const bodyFacts = decodeIndexBodyFactTable(a.body_facts, id, fileId);
        if (!bodyFacts)
            fail('symbol body facts');
        const orders = orderKeys.get(id) ?? new Set<string>();
        orderKeys.set(id, orders);
        for (const fact of bodyFacts) {
            if (!contains(span, fact.evidence.statement_range)
                || facts.has(fact.id)) {
                fail('operation fact');
            }
            const orderKey = fact.order.join('.');
            if (orders.has(orderKey))
                fail('operation order');
            orders.add(orderKey);
            facts.set(fact.id, fact);
            const ownerFacts = owned.get(id) ?? [];
            ownerFacts.push(fact);
            owned.set(id, ownerFacts);
        }
    }
    for (const ch of chs.values()) {
        if (ch.channel_kind === 'job') {
            const parent = ch.parent_channel_id
                ? chs.get(ch.parent_channel_id)
                : undefined;
            if (!parent || parent.channel_kind !== 'queue'
                || parent.transport !== ch.transport) {
                fail('job parent channel');
            }
        }
        else if (ch.parent_channel_id !== undefined) {
            fail('non-job parent channel');
        }
        if (ch.channel_kind === 'event') {
            if (!bounded(ch.scope, 512)) {
                fail('event channel scope');
            }
        }
        else if (ch.scope !== undefined) {
            fail('non-event channel scope');
        }
        const keyed = byKey.get(ch.key) ?? [];
        keyed.push(ch);
        byKey.set(ch.key, keyed);
    }
    for (const fact of facts.values()) {
        if (factHas(fact, (value) => value.kind === 'symbol' && !symbols.has(value.symbol_id))) {
            fail('operation value reference');
        }
        if (fact.kind === 'call' && fact.target_symbol_id
            && !symbols.has(fact.target_symbol_id)) {
            fail('call target');
        }
        const controlIds = new Set<string>();
        for (const f of fact.control) {
            if (f.kind === 'exception')
                continue;
            if (controlIds.has(f.controller_fact_id)) {
                fail('duplicate control reference');
            }
            controlIds.add(f.controller_fact_id);
            const ctl = facts.get(f.controller_fact_id);
            const expectedKind = f.kind === 'branch'
                ? 'condition'
                : f.kind;
            const guardFallthrough = f.kind === 'branch'
                && ctl?.kind === 'condition'
                && ctl.condition_kind === 'guard';
            if (!ctl || ctl.owner_symbol_id !== fact.owner_symbol_id
                || ctl.kind !== expectedKind
                || orderCmp(ctl.order, fact.order) >= 0
                || (!guardFallthrough && !contains(f.kind === 'parallel'
                    ? ctl.evidence.range
                    : ctl.evidence.statement_range, fact.evidence.range))
                || (f.kind === 'branch' && ctl.kind === 'condition'
                    && !validArm(ctl, f.arm))
                || (f.kind === 'parallel' && ctl.kind === 'parallel'
                    && (f.lane === 'each'
                        ? ctl.lane_count === 0
                        : f.lane >= ctl.lane_count))
                || (fact.kind === 'call' && f.kind === 'parallel'
                    && ctl.kind === 'parallel'
                    && !ctl.member_fact_ids.includes(fact.id))) {
                fail('operation control reference');
            }
        }
        if (factHas(fact, (value) => value.kind === 'parameter' && value.scope === 'iteration')
            && !fact.control.some((f) => {
                const ctl = f.kind === 'loop'
                    ? facts.get(f.controller_fact_id)
                    : undefined;
                return ctl?.kind === 'loop'
                    && ctl.loop_kind === 'array_iteration';
            })) {
            fail('iteration parameter');
        }
        if (fact.kind === 'parallel') {
            const laneCount = fact.input?.kind === 'array'
                ? fact.input.elements.length
                : 0;
            if (fact.member_fact_ids.some((id) => {
                const member = facts.get(id);
                const frame = member?.control.find((f): f is Extract<IndexControlFrame, {
                    kind: 'parallel';
                }> => f.kind === 'parallel'
                    && f.controller_fact_id === fact.id);
                const loop = frame?.lane === 'each'
                    ? member?.control.some((f) => {
                        const ctl = f.kind === 'loop'
                            ? facts.get(f.controller_fact_id)
                            : undefined;
                        return ctl?.kind === 'loop'
                            && ctl.loop_kind === 'array_iteration';
                    })
                    : true;
                return !member || member.kind !== 'call' || !frame || !loop
                    || member.owner_symbol_id !== fact.owner_symbol_id;
            }) || fact.lane_count !== laneCount) {
                fail('parallel member reference');
            }
        }
        if (fact.kind === 'persistence') {
            const call = facts.get(fact.call_fact_id);
            if (!call || call.kind !== 'call'
                || call.owner_symbol_id !== fact.owner_symbol_id
                || !sameSpan(call.evidence.range, fact.evidence.range)
                || !sameSpan(call.evidence.statement_range, fact.evidence.statement_range)
                || call.evidence.excerpt_sha256 !== fact.evidence.excerpt_sha256
                || call.order[0] !== fact.order[0]
                || call.order[2] !== fact.order[2]
                || call.order[3] !== fact.order[3]
                || JSON.stringify(call.control) !== JSON.stringify(fact.control)
                || !bounded(fact.receiver_type, MAX_TEXT)) {
                fail('persistence call reference');
            }
        }
    }
    const routes = new Map<string, number>();
    for (const [source, target, a] of view.edgeEntries()) {
        const relation = a.relation;
        const srcCh = chs.get(source);
        const dstCh = chs.get(target);
        const usesChannel = srcCh !== undefined || dstCh !== undefined;
        if (!usesChannel && !RELATIONS.has(String(relation)))
            continue;
        if (!RELATIONS.has(String(relation))) {
            fail('channel relation');
        }
        if (!edgeProof(a, files, byId)) {
            fail('channel evidence');
        }
        const edgeOwner = a.execution_owner_id;
        if (relation === 'publishes_to') {
            if (!symbols.has(source) || !dstCh
                || source !== edgeOwner
                || !['queue', 'job', 'event'].includes(dstCh.channel_kind)) {
                fail('publishes_to endpoints');
            }
        }
        else if (relation === 'routes_through') {
            if (!srcCh || srcCh.channel_kind !== 'job'
                || !dstCh || dstCh.channel_kind !== 'queue'
                || srcCh.parent_channel_id !== target
                || srcCh.transport !== dstCh.transport) {
                fail('routes_through endpoints');
            }
            routes.set(source, (routes.get(source) ?? 0) + 1);
        }
        else if (relation === 'consumed_by') {
            if (!srcCh || !symbols.has(target) || dstCh) {
                fail('consumed_by endpoints');
            }
        }
    }
    for (const ch of chs.values()) {
        if (ch.channel_kind === 'job'
            && routes.get(ch.id) !== 1) {
            fail('job routing');
        }
    }
    for (const xs of owned.values()) {
        xs.sort((a, b) => orderCmp(a.order, b.order) || compareCodeUnits(a.id, b.id));
        xs.forEach(freeze);
        Object.freeze(xs);
    }
    for (const xs of byKey.values()) {
        xs.sort((a, b) => compareCodeUnits(a.id, b.id));
        xs.forEach(freeze);
        Object.freeze(xs);
    }
    facts.forEach(freeze);
    chs.forEach(freeze);
    return {
        operation_by_id: sealMap(sortEntries(facts)),
        operations_by_owner: sealMap(sortEntries(owned)),
        channels_by_id: sealMap(sortEntries(chs)),
        channels_by_key: sealMap(sortEntries(byKey)),
    };
}

function copyGraph(source: KnowledgeGraph): KnowledgeGraph {
  const view = new KnowledgeGraph(source.graph)
  for (const [id, a] of source.nodeEntries()) {
    view.addNode(id, a)
  }
  for (const [from, to, a, expectedId] of source.edgeEntries()) {
    const id = view.addEdge(from, to, a)
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
  for (const [id, a] of view.nodeEntries()) {
    if (a.node_kind !== 'file') continue
    const source = a.source_file
    const hash = a.content_hash
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
      error instanceof IntegrityError
        ? error.message
        : 'canonical execution index',
    )
  }
  for (const [id, a] of view.nodeEntries()) {
    if (!Object.hasOwn(a, 'body_facts')) continue
    const { body_facts: _decoded, ...retained } = a
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
