import {
  KnowledgeGraph,
  type GraphAttributes,
  type GraphEdge,
} from '../graph/directed-multigraph.js'
import { compareCodeUnits as cc } from '../graph/canonical-json.js'
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
  'bull', 'bullmq', 'node-event-emitter', 'nestjs-event-emitter'])
const RELATIONS = new Set(['publishes_to', 'routes_through', 'consumed_by'])
const EDGE_SOURCES = new Set([
  'typescript-semantic', 'typescript-syntactic', 'framework-decorator', 'wrapper-summary'])
const CH = 'channel_kind', PH = 'parent_channel_id',
  CO = 'condition_kind', SR = 'statement_range', EH = 'excerpt_sha256',
  CF = 'controller_fact_id', OW = 'owner_symbol_id', NK = 'node_kind',
  EV = 'evidence', TR = 'transport', SF = 'source_file',
  MF = 'member_fact_ids', LC = 'lane_count', EO = 'execution_owner_id',
  DR = 'definition_range', PL = 'parallel', CD = 'condition',
  CR = 'corrupt', CA = 'call'
const oh = Object.hasOwn, of = Object.freeze

class IntegrityError extends Error {}
function fl(s: string): never { throw new IntegrityError(`canonical ${s}`) }
const ne = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !v.includes('\0')
const bd = (v: unknown, m: number): v is string => ne(v) && Buffer.byteLength(v, 'utf8') <= m
const si = (v: unknown, m = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && !Object.is(v, -0) && v >= m
const ex = (v: unknown, k: readonly string[]): Record<string, unknown> | null => isRecord(v) && Object.keys(v).length === k.length && k.every((x) => oh(v, x)) ? v : null
const pc = (a: IndexRange['start'], b: IndexRange['start']): number => a.line - b.line || a.column - b.column

function ro(v: unknown): IndexRange | null {
  const r = ex(v, ['start', 'end']), s = ex(r?.start, ['line', 'column']),
    e = ex(r?.end, ['line', 'column'])
  if (!r || !s || !e || !si(s.line, 1) || !si(s.column, 1)
    || !si(e.line, 1) || !si(e.column, 1)) return null
  const p = { start: { line: s.line, column: s.column },
    end: { line: e.line, column: e.column } }
  return pc(p.start, p.end) <= 0 ? p : null
}

const ct = (a: IndexRange, b: IndexRange): boolean => pc(a.start, b.start) <= 0 && pc(b.end, a.end) <= 0
const ss = (a: IndexRange, b: IndexRange): boolean => pc(a.start, b.start) === 0 && pc(a.end, b.end) === 0

function va(c: Extract<IndexBodyFact, { kind: 'condition' }>, a: string): boolean {
  if (c[CO] === 'if') return ['then', 'else'].includes(a)
  if (c[CO] === 'switch') return a === 'default'
    || (a.startsWith('case:') && a.length > 5)
  if (c[CO] === 'logical_and') return a === 'truthy'
  if (c[CO] === 'logical_or') return a === 'falsy'
  if (c[CO] === 'nullish') return a === 'nullish'
  return (c[CO] === 'ternary' ? ['truthy', 'falsy'] : ['then', 'else']).includes(a)
}

function ep(a: GraphAttributes, f: ReadonlyMap<string, string>,
  n: ReadonlyMap<string, GraphAttributes>, t: IndexChannelNode | undefined,
  o: ReadonlyMap<string, readonly IndexBodyFact[]>): boolean {
  const s = a[SF], i = a[EO], w = typeof i === 'string' ? n.get(i) : undefined
  const p = ro(w?.[DR]), r = ex(a[EV],
    ['source', 'range', 'statement_range', 'excerpt_sha256'])
  const g = ro(r?.range), m = ro(r?.[SR]), d = a.dispatch_payload_argument
  const q = !oh(a, 'dispatch_payload_argument')
    || a.relation === 'publishes_to' && t?.[CH] !== 'event'
    && si(d) && (o.get(String(i)) ?? []).filter((x) =>
      x.kind === CA && d < x.arguments.length
      && g !== null && ss(x[EV].range, g)
      && m !== null && ss(x[EV][SR], m)
      && x[EV][EH] === r?.[EH]).length === 1
  return typeof s === 'string' && f.has(s) && typeof i === 'string'
    && w?.[SF] === s && w?.[NK] !== 'file' && w?.[NK] !== 'channel'
    && p !== null && r !== null && EDGE_SOURCES.has(String(r.source))
    && g !== null && m !== null && ct(p, m) && ct(m, g)
    && typeof r[EH] === 'string' && SHA256.test(r[EH]) && q
}

const vh = (v: IndexValue, t: (candidate: IndexValue) => boolean): boolean => t(v) || v.kind === 'array' && v.elements.some((e) => vh(e, t)) || v.kind === 'object' && v.entries.some((e) => vh(e.value, t)) || v.kind === 'template' && v.parts.some((e) => vh(e, t))

function fh(
  f: IndexBodyFact,
  t: (candidate: IndexValue) => boolean,
): boolean {
  let x: readonly IndexValue[]
  switch (f.kind) {
    case CA: x = f.arguments; break
    case 'literal': x = [f.value]; break
    case CD:
    case 'loop': x = f.test ? [f.test] : []; break
    case PL: x = f.input ? [f.input] : []; break
    case 'return':
    case 'throw':
    case 'mutation': x = f.value ? [f.value] : []; break
    case 'persistence': x = f.resource ? [f.resource] : []
  }
  return x.some((v) => vh(v, t))
}

function rc(i: string, a: GraphAttributes): IndexChannelNode | null {
  if (!ne(i) || !KINDS.has(a[CH] as IndexChannelKind)
    || !TRANSPORTS.has(a[TR] as IndexChannelTransport) || !bd(a.key, MAX_TEXT)
    || oh(a, 'parent_channel_id') && !ne(a[PH])
    || oh(a, 'scope') && !bd(a.scope, 512)) return null
  const c: IndexChannelNode = {
    id: i, node_kind: 'channel', channel_kind: a[CH] as IndexChannelKind,
    transport: a[TR] as IndexChannelTransport, key: a.key,
    ...(typeof a[PH] === 'string' ? { parent_channel_id: a[PH] } : {}),
    ...(typeof a.scope === 'string' ? { scope: a.scope } : {}),
  }
  return i === indexChannelId(c) ? c : null
}

function oc(a: readonly number[], b: readonly number[]): number { for (let i = 0; i < Math.min(a.length, b.length); i += 1) { const d = a[i]! - b[i]!; if (d !== 0) return d } return a.length - b.length }
function fr<T>(v: T): T { if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { for (const e of Object.values(v)) fr(e); of(v) } return v }

function sm<K, V>(e: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const x = new Map(e); let v: ReadonlyMap<K, V>
  v = {
    get size() { return x.size }, get(k: K) { return x.get(k) },
    has(k: K) { return x.has(k) }, entries() { return x.entries() },
    keys() { return x.keys() }, values() { return x.values() },
    forEach(c, t) { x.forEach((a, b) => c.call(t, a, b, v)) },
    [Symbol.iterator]() { return x[Symbol.iterator]() },
  }
  return of(v)
}

const se = <V>(x: ReadonlyMap<string, V>): Array<readonly [string, V]> => [...x.entries()].sort(([a], [b]) => cc(a, b))

type ExecutionIndexes = Pick<ReadyQueryIndex, 'operation_by_id' | 'operations_by_owner' | 'channels_by_id' | 'channels_by_key'>;

function bm(v: KnowledgeGraph, l: ReadonlyMap<string, string>): ExecutionIndexes {
    const n = v.nodeEntries();
    const b = new Map(n);
    const s = new Set<string>();
    const f = new Map<string, IndexBodyFact>();
    const o = new Map<string, IndexBodyFact[]>();
    const c = new Map<string, IndexChannelNode>();
    const k = new Map<string, IndexChannelNode[]>();
    const q = new Map<string, Set<string>>();
    for (const [i, a] of n) {
        if (a[NK] === 'channel') {
            if (oh(a, 'body_facts')) {
                fl('channel body facts');
            }
            const h = rc(i, a);
            if (!h)
                fl('channel node');
            c.set(i, h);
            continue;
        }
        if (a[NK] === 'file') {
            if (oh(a, 'body_facts')
                || oh(a, 'channel_kind')
                || oh(a, 'parent_channel_id')) {
                fl('file-node execution metadata');
            }
            continue;
        }
        if (oh(a, 'channel_kind')
            || oh(a, 'parent_channel_id')) {
            fl('channel discriminator');
        }
        s.add(i);
        if (!oh(a, 'body_facts'))
            continue;
        const u = a[SF];
        const d = typeof u === 'string'
            ? l.get(u)
            : undefined;
        const p = ro(a[DR]);
        const w = d ? b.get(d) : undefined;
        if (!d || !p || !w
            || w[NK] !== 'file') {
            fl('operation owner');
        }
        const x = decodeIndexBodyFactTable(a.body_facts, i, d);
        if (!x)
            fl('symbol body facts');
        const y = x.filter((t) => t.kind === 'persistence');
        const z = new Set(y.map((t) => t.order[3]));
        if (z.size !== y.length || y.some((_, j) => !z.has(j + 1)))
            fl('persistence order');
        const e = q.get(i) ?? new Set<string>();
        q.set(i, e);
        for (const t of x) {
            if (!ct(p, t[EV][SR])
                || f.has(t.id)) {
                fl('operation fact');
            }
            const g = t.order.join('.');
            if (e.has(g))
                fl('operation order');
            e.add(g);
            f.set(t.id, t);
            const m = o.get(i) ?? [];
            m.push(t);
            o.set(i, m);
        }
    }
    for (const h of c.values()) {
        if (h[CH] === 'job') {
            const p = h[PH]
                ? c.get(h[PH])
                : undefined;
            if (!p || p[CH] !== 'queue'
                || p[TR] !== h[TR]) {
                fl('job parent channel');
            }
        }
        else if (h[PH] !== undefined) {
            fl('non-job parent channel');
        }
        if (h[CH] === 'event') {
            if (!bd(h.scope, 512)) {
                fl('event channel scope');
            }
        }
        else if (h.scope !== undefined) {
            fl('non-event channel scope');
        }
        const y = k.get(h.key) ?? [];
        y.push(h);
        k.set(h.key, y);
    }
    for (const t of f.values()) {
        if (fh(t, (v) => v.kind === 'symbol' && !s.has(v.symbol_id))) {
            fl('operation value reference');
        }
        if (t.kind === CA && t.target_symbol_id
            && !s.has(t.target_symbol_id)) {
            fl('call target');
        }
        const i = new Set<string>();
        for (const d of t.control) {
            if (d.kind === 'exception')
                continue;
            if (i.has(d[CF])) {
                fl('duplicate control reference');
            }
            i.add(d[CF]);
            const c = f.get(d[CF]);
            const k = d.kind === 'branch'
                ? CD
                : d.kind;
            const g = d.kind === 'branch'
                && c?.kind === CD
                && c[CO] === 'guard';
            if (!c || c[OW] !== t[OW]
                || c.kind !== k
                || oc(c.order, t.order) >= 0
                || (!g && !ct(d.kind === PL
                    ? c[EV].range
                    : c[EV][SR], t[EV].range))
                || (d.kind === 'branch' && c.kind === CD
                    && !va(c, d.arm))
                || (d.kind === PL && c.kind === PL
                    && (d.lane === 'each'
                        ? c[LC] === 0
                        : d.lane >= c[LC]))
                || (t.kind === CA && d.kind === PL
                    && c.kind === PL
                    && !c[MF].includes(t.id))) {
                fl('operation control reference');
            }
        }
        if (fh(t, (v) => v.kind === 'parameter' && v.scope === 'iteration')
            && !t.control.some((d) => {
                const c = d.kind === 'loop'
                    ? f.get(d[CF])
                    : undefined;
                return c?.kind === 'loop'
                    && c.loop_kind === 'array_iteration';
            })) {
            fl('iteration parameter');
        }
        if (t.kind === PL) {
            const l = t.input?.kind === 'array'
                ? t.input.elements.length
                : 0;
            if (t[MF].some((i) => {
                const m = f.get(i);
                const r = m?.control.find((d): d is Extract<IndexControlFrame, {
                    kind: 'parallel';
                }> => d.kind === PL
                    && d[CF] === t.id);
                const p = r?.lane === 'each'
                    ? m?.control.some((d) => {
                        const c = d.kind === 'loop'
                            ? f.get(d[CF])
                            : undefined;
                        return c?.kind === 'loop'
                            && c.loop_kind === 'array_iteration';
                    })
                    : true;
                return !m || m.kind !== CA || !r || !p
                    || m[OW] !== t[OW];
            }) || t[LC] !== l) {
                fl('parallel member reference');
            }
        }
        if (t.kind === 'persistence') {
            const a = f.get(t.call_fact_id);
            if (!a || a.kind !== CA
                || a[OW] !== t[OW]
                || !ss(a[EV].range, t[EV].range)
                || !ss(a[EV][SR], t[EV][SR])
                || a[EV][EH] !== t[EV][EH]
                || a.order[0] !== t.order[0]
                || a.order[2] !== t.order[2]
                || JSON.stringify(a.control) !== JSON.stringify(t.control)
                || !bd(t.receiver_type, MAX_TEXT)) {
                fl('persistence call reference');
            }
        }
    }
    const r = new Map<string, number>();
    for (const [u, t, a] of v.edgeEntries()) {
        const e = a.relation;
        const x = c.get(u);
        const y = c.get(t);
        const g = x !== undefined || y !== undefined;
        if (oh(a, 'dispatch_payload_argument')
            && (!g || e !== 'publishes_to'))
            fl('dispatch payload relation');
        if (!g && !RELATIONS.has(String(e)))
            continue;
        if (!RELATIONS.has(String(e))) {
            fl('channel relation');
        }
        if (!ep(a, l, b, y, o)) {
            fl('channel evidence');
        }
        const w = a[EO];
        if (e === 'publishes_to') {
            if (!s.has(u) || !y
                || u !== w
                || !['queue', 'job', 'event'].includes(y[CH])) {
                fl('publishes_to endpoints');
            }
        }
        else if (e === 'routes_through') {
            if (!x || x[CH] !== 'job'
                || !y || y[CH] !== 'queue'
                || x[PH] !== t
                || x[TR] !== y[TR]) {
                fl('routes_through endpoints');
            }
            r.set(u, (r.get(u) ?? 0) + 1);
        }
        else if (e === 'consumed_by') {
            if (!x || !s.has(t) || y) {
                fl('consumed_by endpoints');
            }
        }
    }
    for (const h of c.values()) {
        if (h[CH] === 'job'
            && r.get(h.id) !== 1) {
            fl('job routing');
        }
    }
    for (const x of o.values()) {
        x.sort((a, b) => oc(a.order, b.order) || cc(a.id, b.id));
        x.forEach(fr);
        of(x);
    }
    for (const x of k.values()) {
        x.sort((a, b) => cc(a.id, b.id));
        x.forEach(fr);
        of(x);
    }
    f.forEach(fr);
    c.forEach(fr);
    return {
        operation_by_id: sm(se(f)),
        operations_by_owner: sm(se(o)),
        channels_by_id: sm(se(c)),
        channels_by_key: sm(se(k)),
    };
}

function cg(s: KnowledgeGraph): KnowledgeGraph {
  const v = new KnowledgeGraph(s.graph)
  for (const [i, a] of s.nodeEntries()) {
    v.addNode(i, a)
  }
  for (const [f, t, a, e] of s.edgeEntries()) {
    const i = v.addEdge(f, t, a)
    if (i !== e) {
      throw new Error('Canonical graph edge identity changed while sealing query index')
    }
  }
  return v
}

const sg = (v: KnowledgeGraph): QueryGraph => of({
  hasNode: (i: string) => v.hasNode(i), hasEdge: (s: string, t: string) => v.hasEdge(s, t),
  nodeEntries: () => v.nodeEntries(), edgeEntries: () => v.edgeEntries(),
  predecessors: (i: string) => v.predecessors(i), successors: (i: string) => v.successors(i),
  edgesBetween: (s: string, t: string) => v.edgesBetween(s, t),
  nodeAttributes: (i: string) => v.nodeAttributes(i),
})
export function failedQueryIndex(state: FailedQueryIndex['state'], subject: string): FailedQueryIndex { return { state, subject } }

export function inspectQueryIndex(graph: KnowledgeGraph): QueryIndex {
  let v: KnowledgeGraph
  try {
    v = cg(graph)
  } catch {
    return failedQueryIndex(CR, 'canonical graph snapshot')
  }
  const b = readBuildState(v)
  const r = v.graph.root_path
  if (!b || v.graph.canonical_typescript_index !== true
    || v.graph.schema_version !== CANONICAL_INDEX_FORMAT_VERSION
    || typeof r !== 'string' || r.trim().length === 0
    || b.source_root.root_path !== r) {
    return failedQueryIndex(CR, 'canonical TypeScript index metadata')
  }
  if (b.completeness.summary.state !== 'complete'
    || b.completeness.supported_failures.length > 0) {
    return failedQueryIndex(
      'unavailable',
      'canonical TypeScript index incomplete',
    )
  }

  const h = new Map<string, string>()
  const f = new Map<string, string>()
  for (const [i, a] of v.nodeEntries()) {
    if (a[NK] !== 'file') continue
    const s = a[SF]
    const x = a.content_hash
    if (typeof s !== 'string' || typeof x !== 'string'
      || !SHA256.test(x)) {
      return failedQueryIndex(CR, 'canonical file-node hash')
    }
    if (h.has(s) || f.has(s)) {
      return failedQueryIndex(CR, s)
    }
    h.set(s, x)
    f.set(s, i)
  }

  if (h.size !== b.sources.supported.length
    || b.sources.supported.some((s) =>
      h.get(s.path) !== s.hash)) {
    return failedQueryIndex(CR, 'canonical file-node coverage')
  }

  let e: ExecutionIndexes
  try {
    e = bm(v, f)
  } catch (x) {
    return failedQueryIndex(
      CR,
      x instanceof IntegrityError
        ? x.message
        : 'canonical execution index',
    )
  }
  for (const [i, a] of v.nodeEntries()) {
    if (!oh(a, 'body_facts')) continue
    const { body_facts: _, ...t } = a
    v.replaceNodeAttributes(i, t)
  }

  return of({
    state: 'ready',
    graph: sg(v),
    root_path: r,
    file_hashes: sm(h),
    unsupported_sources: of(
      b.sources.unsupported.map((s) => of({ ...s })),
    ),
    ...e,
  })
}
