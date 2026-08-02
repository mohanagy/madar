import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { IndexBodyFact, IndexRange } from '../domain/index/model.js'
import type { QueryIndex, ReadyQueryIndex } from '../domain/query/index-status.js'
import type {
  EvidenceHydrationTargets, HydratedControl, HydratedEntity, HydratedEvidenceResult,
  HydratedExcerpt, HydratedFile, HydratedProof, SelectedEvidenceEdge,
} from '../domain/query/types.js'

type Failure = Extract<HydratedEvidenceResult, { subject: string }>
type Source = [string, string, string, number[], number[], string]
type Call = Extract<IndexBodyFact, { kind: 'call' }>
class Halt { constructor(readonly value: Failure) {} }
function halt(state: Failure['state'], key: string): never {
  throw new Halt({ state, subject: key })
}
function bad(key: string): never { halt('corrupt', key) }
const same = (a: IndexRange, b: IndexRange): boolean =>
  a.start.line === b.start.line && a.start.column === b.start.column
  && a.end.line === b.end.line && a.end.column === b.end.column

function lines(text: string): [number[], number[]] {
  const starts = [0], ends: number[] = []
  for (const match of text.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) {
    ends.push(match.index); starts.push(match.index + match[0].length)
  }
  ends.push(text.length)
  return [starts, ends]
}

function clip(src: Source, r: IndexRange): string | null {
  const { start, end } = r ?? {}
  if (!start || !end) return null
  const a = src[3][start.line - 1], z = src[4][end.line - 1]
  if (a === undefined || z === undefined) return null
  const from = a + start.column - 1, to = src[3][end.line - 1]! + end.column - 1
  return from <= z && to <= z && from <= to ? src[2].slice(from, to) : null
}

function ready(i: ReadyQueryIndex, q: EvidenceHydrationTargets): HydratedEvidenceResult {
  const ids = (xs: readonly string[]): string[] => [...new Set(xs)].sort()
  const nodes = ids(q.symbolIds), decls = ids(q.declarationSymbolIds),
    ops = ids(q.operationIds), checks = ids(q.validationOperationIds ?? [])
  if (decls.some((id) => !nodes.includes(id))) bad('declaration targets')
  const edges: SelectedEvidenceEdge[] = [...q.edges]
    .sort((a, b) => a.id < b.id ? -1 : Number(a.id > b.id))
  const ds = new Set(decls), srcs = new Map<string, Source>(),
    fs = new Map<string, HydratedFile>(), ctrls = new Map<string, HydratedControl>(),
    ents = new Map<string, HydratedEntity>(),
    cuts = new Map<string, HydratedExcerpt>(), refs = new Map<string, HydratedProof>(),
    used = new Set<string>()

  const node = (id: string) => {
    if (!i.graph.hasNode(id)) bad(id)
    return i.graph.nodeAttributes(id)
  }
  const load = (path: string): Source => {
    const old = srcs.get(path)
    if (old) return old
    const hash = i.file_hashes.get(path)
    if (hash === undefined) halt('stale', path)
    let file: string, buf: Buffer
    try {
      const root = realpathSync(i.root_path)
      file = realpathSync(resolve(root, path))
      const rel = relative(root, file)
      if (isAbsolute(path) || rel === '..'
        || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        halt('unavailable', path)
      }
      buf = readFileSync(file)
    } catch (err) {
      if (err instanceof Halt) throw err
      halt('unavailable', path)
    }
    if (createHash('sha256').update(buf).digest('hex') !== hash) halt('stale', path)
    if (!isUtf8(buf)) bad(path)
    const text = buf.toString('utf8'), id = `f${fs.size}`
    const row: Source = [path, hash, text, ...lines(text), id]
    srcs.set(path, row); fs.set(path, [id, hash])
    return row
  }
  const auth = (
    src: Source, r: IndexRange, hash?: string,
    key = src[0], keep = true,
  ): string => {
    const text = clip(src, r)
    if (text === null) bad(key)
    const sum = createHash('sha256').update(text).digest('hex')
    if (hash !== undefined && sum !== hash) bad(key)
    if (!keep) return ''
    const sig = `${src[1]}\0${r.start.line}:${r.start.column}:${
      r.end.line}:${r.end.column}\0${sum}`
    const old = cuts.get(sig)
    if (old) return old[0]
    const id = `x${cuts.size}`
    cuts.set(sig, [id, src[5], r, sum, text])
    return id
  }
  const ent = (id: string): string => {
    const old = ents.get(id)
    if (old) return old[0]
    const a = node(id), ref = `e${ents.size}`, ch = i.channels_by_id.get(id)
    if (ch) {
      ents.set(id, [ref, 'channel', ch.channel_kind, ch.transport,
        ch.key, ch.parent_channel_id, ch.scope])
      if (ch.parent_channel_id) ent(ch.parent_channel_id)
      return ref
    }
    const path = a.source_file as string, label = a.label as string,
      kind = a.node_kind as string, decl = a.declaration_range as IndexRange
    if (kind === 'file') bad(id)
    const src = load(path), proof = ds.has(id) ? auth(src, decl, undefined, id) : undefined
    ents.set(id, [ref, 'symbol', label, kind, src[5]])
    if (proof) {
      refs.set(id, [`p${refs.size}`, 'declaration', ref, proof]); used.add(ref)
    }
    return ref
  }
  const fact = (v: IndexBodyFact, exact: boolean, keep = true): [string, string] => {
    const owner = v.owner_symbol_id, own = ents.get(owner)?.[0]
      ?? (exact && keep ? ent(owner) : '')
    if (v.kind === 'call' && v.target_symbol_id) {
      node(v.target_symbol_id)
      if (ents.has(v.target_symbol_id)) used.add(ent(v.target_symbol_id))
    }
    const src = load(node(owner).source_file as string),
      ctrl = ['condition', 'loop', 'parallel'].includes(v.kind)
    const stmt = auth(src, v.evidence.statement_range,
      v.evidence.excerpt_sha256, v.id, keep && !ctrl)
    return [own, ctrl ? auth(src, v.evidence.range, undefined, v.id, keep) : stmt]
  }
  const callAt = (
    edge: string, owner: string, ok: (v: Call) => boolean, keep = true,
  ): string => {
    const hits = (i.operations_by_owner.get(owner) ?? [])
      .filter((v): v is Call => v.kind === 'call'
        && v.owner_symbol_id === owner && ok(v))
    if (hits.length !== 1) bad(edge)
    const hit = hits[0]!
    if (i.operation_by_id.get(hit.id) !== hit) bad(edge)
    return fact(hit, false, keep)[1]
  }
  const link = (
    id: string, from: string, to: string, rel: string, cut: string,
  ): void => {
    refs.set(id, [`p${refs.size}`, 'edge', from, to, rel, cut])
    used.add(from); used.add(to)
  }
  const ranged = (
    id: string, from: string, to: string, rel: string,
    file: string, range: IndexRange,
  ): void => {
    refs.set(id, [`p${refs.size}`, 'edge_range', from, to, rel, file, range])
    used.add(from); used.add(to)
  }

  for (const id of nodes) {
    if (i.channels_by_id.has(id)) bad(id)
    ent(id)
  }
  for (const id of checks) {
    const value = i.operation_by_id.get(id)
    if (!value) bad(id)
    fact(value, true, false)
    if (['condition', 'loop', 'parallel'].includes(value.kind)) {
      const src = load(node(value.owner_symbol_id).source_file as string)
      ctrls.set(id, [src[5], value.evidence.range])
    }
  }
  for (const id of ops) {
    const value = i.operation_by_id.get(id)
    if (!value) bad(id)
    const [owner, excerpt] = fact(value, true), ref = `e${ents.size}`
    ents.set(id, [ref, 'operation', owner, value])
    refs.set(id, [`p${refs.size}`, 'operation', ref, excerpt]); used.add(owner)
  }
  for (const edge of edges) {
    const hits = i.graph.edgesBetween(edge.fromId, edge.toId)
      .filter((hit) => hit.id === edge.id)
    if (hits.length !== 1) bad(edge.id)
    const a = hits[0]!.attributes, rel = a.relation as string
    if (edge.relation !== undefined && edge.relation !== rel) bad(edge.id)
    const from = ent(edge.fromId), to = ent(edge.toId)
    const ev = a.evidence as {
      source: string; range: IndexRange; statement_range?: IndexRange; excerpt_sha256?: string
    }
    if (rel === 'calls') {
      const cut = callAt(edge.id, edge.fromId, (call) =>
        call.target_symbol_id === edge.toId && same(call.evidence.range, ev.range)
        && ev.source === (call.source === 'framework'
          ? 'framework-decorator' : call.source))
      link(edge.id, from, to, rel, cut)
      continue
    }
    const owner = a.execution_owner_id as string,
      stmt = ev.statement_range!, sum = ev.excerpt_sha256!, path = a.source_file as string
    if (rel === 'consumed_by' && owner !== edge.toId) {
      callAt(edge.id, owner, (call) =>
        same(stmt, call.evidence.statement_range)
        && call.evidence.excerpt_sha256 === sum, false)
    }
    const src = load(path)
    auth(src, stmt, sum, edge.id, false)
    auth(src, ev.range, undefined, edge.id, false)
    ranged(edge.id, from, to, rel, src[5], ev.range)
  }
  for (const [id, entry] of ents) {
    if (entry[1] === 'symbol' && !used.has(entry[0])) bad(id)
  }
  return {
    state: 'ready', files: fs, controls: ctrls,
    excerpts: cuts, entities: ents, proofs: refs,
  }
}

export function hydrateEvidence(
  index: QueryIndex, input: EvidenceHydrationTargets,
): HydratedEvidenceResult {
  try {
    return index.state === 'ready' ? ready(index, input)
      : { state: index.state, subject: index.subject }
  } catch (error) {
    return error instanceof Halt ? error.value
      : { state: 'corrupt', subject: 'evidence hydration' }
  }
}
