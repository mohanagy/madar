import { createHash } from 'node:crypto'
// Compiler-independent facts used while the TypeScript adapter writes the
// canonical graph. These records never leave the adapter as a second index.
export type IndexLanguage =
  | 'typescript'
  | 'javascript'
  | 'tsx'
  | 'jsx'
export type IndexFile = {
  id: string
  path: string
  language: IndexLanguage
  loc: number
  hash: string
}
export type IndexSymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type-alias'
  | 'enum'
  | 'method'
  | 'constant'
  | 'variable'
  | 'namespace'
export type IndexPosition = {
  line: number
  column: number
}
export type IndexRange = {
  start: IndexPosition
  end: IndexPosition
}
export type IndexSha256 = string
type Immutable<T> = { readonly [K in keyof T]: T[K] }
export type IndexFactConfidence = 'high' | 'medium' | 'low'
export type IndexFactSource =
  | 'typescript-semantic' | 'typescript-syntactic' | 'framework' | 'wrapper-summary'
export type IndexCallScheduling = 'sync' | 'awaited' | 'fire_and_forget'
export type IndexLiteralRole =
  | 'argument' | 'initializer' | 'condition' | 'return' | 'channel' | 'configuration'
type IndexConditionKind = 'if' | 'switch' | 'ternary' | 'logical_and' | 'logical_or' | 'nullish' | 'guard';
type IndexLoopKind = 'for' | 'for_in' | 'for_of' | 'while' | 'do_while' | 'array_iteration';
export type IndexPromiseCombinator = 'all' | 'allSettled' | 'any' | 'race'
export type IndexParallelCompletion =
  | 'all_or_first_rejection' | 'all_settled' | 'first_fulfilled' | 'first_settled'
export type IndexMutationOperation =
  | 'assign' | 'increment' | 'decrement' | 'append' | 'remove' | 'delete'
export type IndexPersistenceOperation =
  | 'read' | 'create' | 'update' | 'delete' | 'upsert' | 'transaction'
  | 'file_read' | 'file_write' | 'object_read' | 'object_write'
type IndexUnknownReason = 'dynamic' | 'ambiguous' | 'unsupported'
const KS = ['condition', 'loop', 'parallel', 'call', 'literal',
  'mutation', 'persistence', 'return', 'throw'] as const
const LS = ['high', 'medium', 'low'] as const
const SS = ['typescript-semantic', 'typescript-syntactic', 'framework', 'wrapper-summary'] as const
const TM = ['sync', 'awaited', 'fire_and_forget'] as const
const RS = ['argument', 'initializer', 'condition', 'return', 'channel', 'configuration'] as const
const CS = ['if', 'switch', 'ternary', 'logical_and', 'logical_or', 'nullish', 'guard'] as const
const LP = ['for', 'for_in', 'for_of', 'while', 'do_while', 'array_iteration'] as const
const PM = ['all', 'allSettled', 'any', 'race'] as const
const CP = ['all_or_first_rejection', 'all_settled', 'first_fulfilled', 'first_settled'] as const
const MU = ['assign', 'increment', 'decrement', 'append', 'remove', 'delete'] as const
const ST = ['read', 'create', 'update', 'delete', 'upsert', 'transaction',
  'file_read', 'file_write', 'object_read', 'object_write'] as const
const UK = ['dynamic', 'ambiguous', 'unsupported'] as const
const SHA256 = /^[a-f0-9]{64}$/
const MR = 8_192, MB = 262_144, MT = 8_388_608
const MD = 5, ME = 32, MX = 512
const aa = Array.isArray, bl = Buffer.byteLength, js = JSON.stringify
export type IndexFactEvidence = Immutable<{
  file_id: string
  /** Smallest expression or token range that proves the fact. */
  range: IndexRange
  /** Bounded range whose exact UTF-8 bytes are authenticated by excerpt_sha256. */
  statement_range: IndexRange; excerpt_sha256: IndexSha256
}>
export type IndexScalarValue = string | number | boolean | null
export type IndexObjectEntry = Immutable<{ key: string; value: IndexValue }>
/**
 * A bounded, compiler-independent representation of statically known values.
 * Collectors are responsible for depth, element-count, byte-length, and secret
 * redaction limits before a value reaches this model.
 */
export type IndexValue =
  | Immutable<{ kind: 'literal'; value: IndexScalarValue }>
  | Immutable<{ kind: 'symbol'; symbol_id: string }>
  | Immutable<{ kind: 'parameter'; position: number; scope?: 'iteration' }>
  | Immutable<{ kind: 'array'; elements: readonly IndexValue[] }>
  | Immutable<{ kind: 'object'; entries: readonly IndexObjectEntry[] }>
  | Immutable<{ kind: 'template'; parts: readonly IndexValue[] }>
  | Immutable<{ kind: 'redacted'; sha256: IndexSha256; byte_length: number }>
  | Immutable<{ kind: 'unknown'; reason: IndexUnknownReason }>
export type IndexBranchArm = 'then' | 'else' | 'truthy' | 'falsy' | 'nullish'
  | 'default' | `case:${string}`
export type IndexControlFrame =
  | Immutable<{ kind: 'branch'; controller_fact_id: string; arm: IndexBranchArm }>
  | Immutable<{ kind: 'loop'; controller_fact_id: string }>
  | Immutable<{ kind: 'parallel'; controller_fact_id: string; lane: number | 'each' }>
  | Immutable<{ kind: 'exception'; arm: 'try' | 'catch' | 'finally' }>
export type IndexBodyFactBase = Immutable<{
  id: string; owner_symbol_id: string
  /** Numeric AST path; lexicographic comparison gives stable source order. */
  order: readonly number[]; evidence: IndexFactEvidence
  control: readonly IndexControlFrame[]
  confidence: IndexFactConfidence; source: IndexFactSource
}>
type Fact<K extends string, T extends object = object> =
  IndexBodyFactBase & Immutable<{ kind: K } & T>
export type IndexCallFact = Fact<'call', {
  callee: string; target_symbol_id?: string
  arguments: readonly IndexValue[]; scheduling: IndexCallScheduling
}>
export type IndexLiteralFact = Fact<'literal', {
  value: IndexValue; role: IndexLiteralRole
}>
export type IndexConditionFact = Fact<'condition', {
  condition_kind: IndexConditionKind; test?: IndexValue
}>
export type IndexLoopFact = Fact<'loop', {
  loop_kind: IndexLoopKind; test?: IndexValue
}>
export type IndexParallelFact = Fact<'parallel', {
  combinator: IndexPromiseCombinator
  completion: IndexParallelCompletion; lane_count: number
  /** The array/iterable passed to the combinator when statically representable. */
  input?: IndexValue; member_fact_ids: readonly string[]
}>
export type IndexReturnFact = Fact<'return', { value?: IndexValue }>
export type IndexThrowFact = Fact<'throw', { value?: IndexValue }>
export type IndexMutationFact = Fact<'mutation', {
  operation: IndexMutationOperation
  target: string; value?: IndexValue
}>
export type IndexPersistenceFact = Fact<'persistence', {
  operation: IndexPersistenceOperation
  call_fact_id: string; resource?: IndexValue
  /** Receiver/type proof, not a method-name-only classification. */
  receiver_type: string
}>
export type IndexBodyFact = IndexCallFact | IndexLiteralFact | IndexConditionFact
  | IndexLoopFact | IndexParallelFact | IndexReturnFact | IndexThrowFact
  | IndexMutationFact | IndexPersistenceFact
/** Creates a draft collector ID, or a sealed ID when given canonical wire semantics. */
export function indexBodyFactId(
  ownerSymbolId: string,
  kind: IndexBodyFact['kind'],
  order: readonly number[],
  excerptSha256: IndexSha256,
  semantics?: readonly unknown[],
): string {
  const identity = semantics
    ? JSON.stringify([ownerSymbolId, ...semantics])
    : [ownerSymbolId, kind, order.join('.'), excerptSha256].join('\u0000')
  return `operation:${createHash('sha256').update(identity, 'utf8')
    .digest('hex').slice(0, 32)}`
}
/** Compact graph-artifact representation; rows are canonical JSON strings. */
export type IndexBodyFactTable = readonly [version: 1, rows: readonly string[]]
export const INDEX_BODY_FACT_CONTROL_LIMIT = 64
export class IndexBodyFactBoundsError extends Error {}
function ep(a: readonly string[], b: string): number { const i = a.indexOf(b); if (i < 0) throw new Error(`Unsupported execution value ${b}`); return i }
function oc(a: readonly number[], b: readonly number[]): number { for (let i = 0; i < Math.min(a.length, b.length); i += 1) { const d = a[i]! - b[i]!; if (d !== 0) return d } return a.length - b.length }
function dn(a: readonly unknown[]): boolean { for (let i = 0; i < a.length; i += 1) if (!Object.hasOwn(a, i)) return false; return true }
const sc = (a: unknown): a is IndexScalarValue => (a === null || ['string', 'number', 'boolean'].includes(typeof a)) && !(typeof a === 'number' && (!Number.isFinite(a) || Object.is(a, -0))) && !(typeof a === 'string' && bl(a) > MX)
function pv(a: IndexValue, d = 0): unknown {
  const n = a.kind === 'array' ? a.elements.length
    : a.kind === 'object' ? a.entries.length
      : a.kind === 'template' ? a.parts.length : 0
  if (d > MD || (d === MD && n > 0))
    return [7, ep(UK, 'unsupported')]
  switch (a.kind) {
    case 'literal':
      if (!sc(a.value)) throw new Error('Execution literal is not JSON-lossless')
      return [0, a.value]
    case 'symbol':
      if (!vt(a.symbol_id, 1_024))
        throw new Error('Execution symbol reference is invalid')
      return [1, a.symbol_id]
    case 'parameter':
      if (!si(a.position)
        || (a.scope !== undefined && a.scope !== 'iteration'))
        throw new Error('Execution parameter position is invalid')
      return a.scope === 'iteration'
        ? [2, a.position, 1]
        : [2, a.position]
    case 'array':
      if (a.elements.length > ME || !dn(a.elements))
        throw new Error('Execution array exceeds its element bound')
      return [3, a.elements.map((e) => pv(e, d + 1))]
    case 'object': {
      const k = new Set<string>()
      if (a.entries.length > ME || !dn(a.entries))
        throw new Error('Execution object exceeds its element bound')
      for (const e of a.entries) {
        if (bl(e.key) > MX || e.key.includes('\0') || k.has(e.key))
          throw new Error('Execution object key is invalid')
        k.add(e.key)
      }
      return [4, a.entries.map((e) => [
        e.key, pv(e.value, d + 1),
      ])]
    }
    case 'template':
      if (a.parts.length > ME || !dn(a.parts))
        throw new Error('Execution template exceeds its element bound')
      return [5, a.parts.map((e) => pv(e, d + 1))]
    case 'redacted':
      if (!SHA256.test(a.sha256) || !si(a.byte_length))
        throw new Error('Execution redaction is invalid')
      return [6, a.sha256, a.byte_length]
    case 'unknown': return [7, ep(UK, a.reason)]
  }
  throw new Error('Unsupported execution value')
}
const pe = (a: IndexFactEvidence): unknown => [a.range.start.line, a.range.start.column, a.range.end.line, a.range.end.column, a.statement_range.start.line, a.statement_range.start.column, a.statement_range.end.line, a.statement_range.end.column, a.excerpt_sha256]
export function encodeIndexBodyFactTable(
  facts: readonly IndexBodyFact[],
): IndexBodyFactTable {
  if (facts.length === 0 || facts.length > MR) {
    throw new IndexBodyFactBoundsError(
      'Execution fact table is outside its row bound',
    )
  }
  if (!dn(facts)) throw new Error('Execution fact table is sparse')
  const a = [...facts].sort((l, r) =>
    oc(l.order, r.order) || (l.id < r.id ? -1 : l.id > r.id ? 1 : 0))
  const m = new Map(a.map((f, i) => [f.id, i]))
  if (m.size !== a.length)
    throw new Error('Execution fact IDs are not unique')
  const oi = (id: string): number => {
    const v = m.get(id)
    if (v === undefined) throw new Error(`Missing execution fact reference ${id}`)
    return v
  }
  const cf = (f: IndexControlFrame): unknown => {
    if (f.kind === 'branch') {
      if (!vt(f.arm, 96)
        || (!['then', 'else', 'truthy', 'falsy', 'nullish', 'default'].includes(f.arm)
          && !(f.arm.startsWith('case:') && f.arm.length > 5))) {
        throw new Error('Execution branch arm is invalid')
      }
      return [0, oi(f.controller_fact_id), f.arm]
    }
    if (f.kind === 'loop') return [1, oi(f.controller_fact_id)]
    if (f.kind === 'parallel') {
      if (f.lane !== 'each' && !si(f.lane))
        throw new Error('Execution parallel lane is invalid')
      return [2, oi(f.controller_fact_id), f.lane]
    }
    if (f.kind === 'exception')
      return [3, ep(['try', 'catch', 'finally'], f.arm)]
    throw new Error('Unsupported execution control frame')
  }
  let b = 0
  const k = new Set<string>()
  const r = a.map((f) => {
    const o = f.order.join('.')
    if (f.order.length !== 4
      || !dn(f.order) || !f.order.every((v) => si(v))
      || !dn(f.control)
      || f.control.length > INDEX_BODY_FACT_CONTROL_LIMIT
      || f.order[1] !== ep(KS, f.kind)
      || k.has(o)) {
      throw new Error(`Invalid execution fact identity ${f.id}`)
    }
    k.add(o)
    let w: unknown
    switch (f.kind) {
      case 'call':
        if (!dn(f.arguments)) throw new Error(`Sparse call arguments for ${f.id}`)
        w = [
          f.callee, f.target_symbol_id ?? null,
          f.arguments.map(pv), ep(TM, f.scheduling),
        ]
        break
      case 'literal':
        w = [pv(f.value), ep(RS, f.role)]
        break
      case 'condition':
        w = [
          ep(CS, f.condition_kind),
          f.test ? pv(f.test) : null,
        ]
        break
      case 'loop':
        w = [
          ep(LP, f.loop_kind),
          f.test ? pv(f.test) : null,
        ]
        break
      case 'parallel': {
        const c = ep(PM, f.combinator)
        if (f.completion !== CP[c]
          || !si(f.lane_count)
          || !dn(f.member_fact_ids)
          || new Set(f.member_fact_ids).size !== f.member_fact_ids.length)
          throw new Error(`Invalid parallel completion ${f.id}`)
        w = [
          c, f.input ? pv(f.input) : null,
          f.member_fact_ids.map(oi), f.lane_count,
        ]
        break
      }
      case 'return':
      case 'throw':
        w = [f.value ? pv(f.value) : null]
        break
      case 'mutation':
        w = [
          ep(MU, f.operation), f.target,
          f.value ? pv(f.value) : null,
        ]
        break
      case 'persistence':
        if (!vt(f.receiver_type))
          throw new Error(`Persistence proof is missing for ${f.id}`)
        w = [
          ep(ST, f.operation), oi(f.call_fact_id),
          f.resource ? pv(f.resource) : null,
          f.receiver_type,
        ]
        break
    }
    const s = [
      ep(KS, f.kind),
      f.order[0], f.order[2], f.order[3], pe(f.evidence),
      f.control.map(cf), ep(LS, f.confidence),
      ep(SS, f.source), w,
    ]
    const id = indexBodyFactId(
      f.owner_symbol_id, f.kind, f.order,
      f.evidence.excerpt_sha256, s,
    )
    if (f.id !== id && f.id !== indexBodyFactId(
      f.owner_symbol_id, f.kind, f.order, f.evidence.excerpt_sha256,
    )) throw new Error(`Invalid execution fact identity ${f.id}`)
    const x = js([id, ...s])
    const z = bl(x)
    b += z
    if (z > MB || b > MT)
      throw new IndexBodyFactBoundsError(
        `Execution fact table exceeds its byte bound at ${f.id}`,
      )
    return x
  })
  return [1, r]
}
const si = (a: unknown, m = 0): a is number => typeof a === 'number' && Number.isSafeInteger(a) && !Object.is(a, -0) && a >= m
const vt = (a: unknown, m = MX): a is string => typeof a === 'string' && a.length > 0 && !a.includes('\0') && bl(a) <= m
const tu = (a: unknown, l: number): unknown[] | null => aa(a) && a.length === l ? a : null
const ev = <T extends string>(a: readonly T[], b: unknown): T | null => si(b) && b < a.length ? a[b]! : null
function rv(a: unknown, d = 0): IndexValue | null {
  if (!aa(a) || !si(a[0]) || a[0] > 7) return null
  if (d > MD) return null
  if (d === MD && [3, 4, 5].includes(a[0])
    && (!aa(a[1]) || a[1].length > 0)) return null
  switch (a[0]) {
    case 0: {
      return a.length === 2 && sc(a[1])
        ? { kind: 'literal', value: a[1] } : null
    }
    case 1:
      return a.length === 2 && vt(a[1], 1_024)
        ? { kind: 'symbol', symbol_id: a[1] }
        : null
    case 2:
      return (a.length === 2 || (a.length === 3 && a[2] === 1))
        && si(a[1])
        ? {
            kind: 'parameter',
            position: a[1],
            ...(a[2] === 1 ? { scope: 'iteration' as const } : {}),
          }
        : null
    case 3:
    case 5: {
      if (a.length !== 2 || !aa(a[1]) || a[1].length > ME) return null
      const v = a[1].map((e) => rv(e, d + 1))
      if (!v.every((e): e is IndexValue => e !== null)) return null
      return a[0] === 3
        ? { kind: 'array', elements: v }
        : { kind: 'template', parts: v }
    }
    case 4: {
      if (a.length !== 2 || !aa(a[1]) || a[1].length > ME) return null
      const k = new Set<string>(), e: IndexObjectEntry[] = []
      for (const x of a[1]) {
        const r = tu(x, 2), v = r ? rv(r[1], d + 1) : null
        if (!r || typeof r[0] !== 'string' || r[0].includes('\0')
          || bl(r[0]) > MX || k.has(r[0]) || !v) return null
        k.add(r[0])
        e.push({ key: r[0], value: v })
      }
      return { kind: 'object', entries: e }
    }
    case 6:
      return a.length === 3 && typeof a[1] === 'string'
        && SHA256.test(a[1]) && si(a[2])
        ? { kind: 'redacted', sha256: a[1], byte_length: a[2] }
        : null
    case 7: {
      const r = ev(UK, a[1])
      return a.length === 2 && r ? { kind: 'unknown', reason: r } : null
    }
  }
  return null
}
type DecodedRow = {
  id: string; kind: IndexBodyFact['kind']; order: readonly number[]
  evidence: IndexFactEvidence; control: readonly unknown[]
  confidence: IndexFactConfidence; source: IndexFactSource; payload: unknown
}
function re(a: unknown, f: string): IndexFactEvidence | null {
  const r = tu(a, 9)
  if (!r || !r.slice(0, 8).every((e) => si(e, 1))
    || typeof r[8] !== 'string' || !SHA256.test(r[8])) return null
  const g = { start: { line: r[0] as number, column: r[1] as number },
    end: { line: r[2] as number, column: r[3] as number } }
  const s = { start: { line: r[4] as number, column: r[5] as number },
    end: { line: r[6] as number, column: r[7] as number } }
  const c = (a: IndexPosition, b: IndexPosition): number =>
    a.line - b.line || a.column - b.column
  return c(g.start, g.end) <= 0 && c(s.start, s.end) <= 0
    && c(s.start, g.start) <= 0 && c(g.end, s.end) <= 0
    ? { file_id: f, range: g, statement_range: s, excerpt_sha256: r[8] }
    : null
}
function dr(a: string, o: string, f: string): DecodedRow | null {
  if (bl(a) > MB) return null
  let p: unknown
  try { p = JSON.parse(a) } catch { return null }
  if (js(p) !== a) return null
  const r = tu(p, 10)
  if (!r || !vt(r[0], 64)
    || !si(r[1]) || r[1] >= KS.length
    || !si(r[2]) || !si(r[3]) || !si(r[4])
    || !aa(r[6])
    || r[6].length > INDEX_BODY_FACT_CONTROL_LIMIT) return null
  const k = KS[r[1]]!, e = re(r[5], f), c = ev(LS, r[7]), s = ev(SS, r[8])
  const q = [r[2], r[1], r[3], r[4]] as number[]
  if (!e || !c || !s || r[0] !== indexBodyFactId(
    o, k, q, e.excerpt_sha256, r.slice(1))) return null
  return { id: r[0], kind: k, order: q, evidence: e, control: r[6],
    confidence: c, source: s, payload: r[9] }
}
export function decodeIndexBodyFactTable(
  value: unknown,
  owner: string,
  file: string,
): readonly IndexBodyFact[] | null {
  const t = tu(value, 2)
  if (!vt(owner, 1_024) || !vt(file, 128)
    || !t || t[0] !== 1 || !aa(t[1])
    || t[1].length === 0 || t[1].length > MR) return null
  const d: DecodedRow[] = []
  let b = 0
  for (const x of t[1]) {
    if (typeof x !== 'string') return null
    b += bl(x)
    if (b > MT) return null
    const r = dr(x, owner, file)
    if (!r) return null
    d.push(r)
  }
  const i = d.map((r) => r.id)
  if (new Set(i).size !== i.length
    || d.some((r, n) => n > 0 && oc(d[n - 1]!.order, r.order) >= 0)) {
    return null
  }
  const ia = (v: unknown): string | null =>
    si(v) && v < i.length ? i[v]! : null
  const cf = (v: unknown): IndexControlFrame | null => {
    if (!aa(v) || !si(v[0])) return null
    const id = ia(v[1])
    if (v[0] === 0) {
      return v.length === 3 && id
        && vt(v[2], 96)
        && (['then', 'else', 'truthy', 'falsy', 'nullish', 'default'].includes(v[2])
          || (v[2].startsWith('case:') && v[2].length > 5))
        ? { kind: 'branch', controller_fact_id: id, arm: v[2] as IndexBranchArm }
        : null
    }
    if (v[0] === 1) return v.length === 2 && id
      ? { kind: 'loop', controller_fact_id: id } : null
    if (v[0] === 2) return v.length === 3 && id
      && (v[2] === 'each' || si(v[2]))
      ? { kind: 'parallel', controller_fact_id: id, lane: v[2] } : null
    const a = ev(['try', 'catch', 'finally'] as const, v[1])
    return v[0] === 3 && v.length === 2 && a
      ? { kind: 'exception', arm: a } : null
  }
  const f: IndexBodyFact[] = []
  for (const r of d) {
    const c = r.control.map(cf)
    if (!c.every((x): x is IndexControlFrame => x !== null)) return null
    const z = {
      id: r.id, owner_symbol_id: owner, order: r.order,
      evidence: r.evidence, control: c,
      confidence: r.confidence, source: r.source,
    }
    const w = aa(r.payload) ? r.payload : null
    let x: IndexBodyFact | null = null
    if (r.kind === 'call' && w?.length === 4) {
      const s = ev(TM, w[3])
      const a = aa(w[2])
        ? w[2].map((e) => rv(e))
        : []
      if (vt(w[0]) && s
        && (w[1] === null || vt(w[1], 1_024))
        && aa(w[2])
        && a.every((e): e is IndexValue => e !== null)) {
        x = {
          ...z, kind: 'call', callee: w[0],
          ...(typeof w[1] === 'string' ? { target_symbol_id: w[1] } : {}),
          arguments: a, scheduling: s,
        }
      }
    } else if (r.kind === 'literal' && w?.length === 2) {
      const v = rv(w[0]), o = ev(RS, w[1])
      if (v && o) x = { ...z, kind: 'literal', value: v, role: o }
    } else if (r.kind === 'condition' && w?.length === 2) {
      const k = ev(CS, w[0]), t = w[1] === null ? undefined : rv(w[1])
      if (k && (w[1] === null || t)) {
        x = { ...z, kind: 'condition', condition_kind: k, ...(t ? { test: t } : {}) }
      }
    } else if (r.kind === 'loop' && w?.length === 2) {
      const k = ev(LP, w[0]), t = w[1] === null ? undefined : rv(w[1])
      if (k && (w[1] === null || t)) {
        x = { ...z, kind: 'loop', loop_kind: k, ...(t ? { test: t } : {}) }
      }
    } else if (r.kind === 'parallel' && w?.length === 4) {
      const q = ev(PM, w[0]), n = w[1] === null ? undefined : rv(w[1])
      const m = aa(w[2])
        ? w[2].map(ia)
        : []
      if (q && (w[1] === null || n)
        && aa(w[2])
        && m.every((id): id is string => id !== null)
        && new Set(m).size === m.length
        && si(w[3])) {
        x = {
          ...z, kind: 'parallel', combinator: q,
          completion: CP[PM.indexOf(q)]!,
          lane_count: w[3],
          ...(n ? { input: n } : {}),
          member_fact_ids: m,
        }
      }
    } else if ((r.kind === 'return' || r.kind === 'throw')
      && w?.length === 1) {
      const v = w[0] === null ? undefined : rv(w[0])
      if (w[0] === null || v) {
        x = { ...z, kind: r.kind, ...(v ? { value: v } : {}) }
      }
    } else if (r.kind === 'mutation' && w?.length === 3) {
      const o = ev(MU, w[0]), v = w[2] === null ? undefined : rv(w[2])
      if (o && vt(w[1]) && (w[2] === null || v)) {
        x = {
          ...z, kind: 'mutation', operation: o, target: w[1],
          ...(v ? { value: v } : {}),
        }
      }
    } else if (r.kind === 'persistence' && w?.length === 4) {
      const o = ev(ST, w[0]), id = ia(w[1])
      const v = w[2] === null ? undefined : rv(w[2])
      if (o && id && (w[2] === null || v) && vt(w[3])) {
        x = {
          ...z, kind: 'persistence', operation: o, call_fact_id: id,
          ...(v ? { resource: v } : {}),
          receiver_type: w[3],
        }
      }
    }
    if (!x) return null
    f.push(x)
  }
  return f
}
export type IndexFrameworkRole =
  | 'nest_module'
  | 'nest_controller'
  | 'nest_route'
  | 'nest_provider'
  | 'nest_guard'
  | 'nest_pipe'
  | 'nest_interceptor'
  | 'express_app'
  | 'express_router'
  | 'express_route'
  | 'express_middleware'
  | 'nextjs_app_page'
  | 'nextjs_app_route'
  | 'nextjs_app_layout'
  | 'nextjs_app_loading'
  | 'nextjs_app_error'
  | 'nextjs_app_template'
  | 'nextjs_pages_page'
  | 'nextjs_pages_api'
  | 'nextjs_middleware'
  | 'nextjs_client_component'
  | 'nextjs_server_action'
  | 'react_router_router'
  | 'react_router_loader'
  | 'react_router_action'
  | 'hono_app'
  | 'hono_route'
  | 'hono_middleware'
  | 'fastify_app'
  | 'fastify_route'
  | 'fastify_plugin'
  | 'trpc_router'
  | 'trpc_procedure_query'
  | 'trpc_procedure_mutation'
  | 'trpc_procedure_subscription'
  | 'prisma_client'
  | 'prisma_model_reader'
  | 'prisma_model_writer'
  | 'prisma_model_access'
export type IndexStorageOperation =
  | 'create'
  | 'createMany'
  | 'update'
  | 'updateMany'
  | 'delete'
  | 'deleteMany'
  | 'upsert'
  | 'findUnique'
  | 'findUniqueOrThrow'
  | 'findFirst'
  | 'findFirstOrThrow'
  | 'findMany'
  | 'count'
  | 'aggregate'
  | 'groupBy'
  | '$transaction'
export type IndexRuntimeBoundary = 'client' | 'server'
export type IndexFrameworkMetadata = {
  storage_operation?: IndexStorageOperation
  runtime_boundary?: IndexRuntimeBoundary
  [key: string]: unknown
}
export type IndexSymbol = {
  id: string
  file_id: string
  name: string
  kind: IndexSymbolKind
  range: IndexRange
  declaration_range?: IndexRange
  exported: boolean
  framework_role?: IndexFrameworkRole
  framework_metadata?: IndexFrameworkMetadata
  body_facts?: readonly IndexBodyFact[]
}
export type IndexChannelKind = 'queue' | 'job' | 'event'
export type IndexChannelTransport =
  | 'bull'
  | 'bullmq'
  | 'node-event-emitter'
  | 'nestjs-event-emitter'
/**
 * Shared channel identity. Only exact, statically resolved identities become
 * nodes; dynamic or ambiguous references remain diagnostics/facts.
 */
export type IndexChannelNode = Immutable<{
  id: string
  node_kind: 'channel'
  channel_kind: IndexChannelKind
  transport: IndexChannelTransport
  key: string
  /** Exact emitter-instance namespace; absent for globally named queues/jobs. */
  scope?: string
  parent_channel_id?: string
}>
export function indexChannelId(
  input: Omit<IndexChannelNode, 'id' | 'node_kind'>,
): string {
  const descriptor = {
    channel_kind: input.channel_kind,
    transport: input.transport,
    key: input.key,
    ...(input.parent_channel_id
      ? { parent_channel_id: input.parent_channel_id }
      : {}),
    ...(input.scope ? { scope: input.scope } : {}),
  }
  return `channel:${createHash('sha256')
    .update(JSON.stringify(descriptor), 'utf8').digest('hex').slice(0, 32)}`
}
export type IndexEdgeKind =
  | 'imports'
  | 'reexports'
  | 'declares'
  | 'calls'
  | 'enqueues_job'
  | 'publishes_to'
  | 'routes_through'
  | 'consumed_by'
  | 'extends'
  | 'implements'
  | 'param_type'
  | 'return_type'
  | 'module_provides'
  | 'module_imports'
  | 'module_exports'
  | 'controller_route'
  | 'route_handler'
  | 'registers_controller'
  | 'injects'
  | 'guards'
  | 'intercepts'
  | 'pipes'
export type IndexEdgeConfidence = 'high' | 'medium' | 'low'
export type IndexEdgeSource =
  | 'typescript-semantic'
  | 'typescript-syntactic'
  | 'framework-decorator'
  | 'wrapper-summary'
  | 'heuristic'
export type IndexEdgeEvidence = {
  file_id: string
  range: IndexRange
  statement_range?: IndexRange
  excerpt_sha256?: IndexSha256
}
export type IndexEdge = {
  from: string
  to: string
  kind: IndexEdgeKind
  confidence: IndexEdgeConfidence
  source: IndexEdgeSource
  evidence?: IndexEdgeEvidence
  metadata?: Record<string, unknown>
}
export type IndexDiagnosticLevel = 'info' | 'warn' | 'error'
export type IndexDiagnosticEvidence = {
  file_id: string
  range?: IndexRange
}
export type IndexDiagnostic = {
  id: string
  level: IndexDiagnosticLevel
  message: string
  evidence?: IndexDiagnosticEvidence
}
