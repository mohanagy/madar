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
const KINDS = [
  'condition', 'loop', 'parallel', 'call', 'literal',
  'mutation', 'persistence', 'return', 'throw',
] as const
const LEVELS = ['high', 'medium', 'low'] as const
const SOURCES = [
  'typescript-semantic', 'typescript-syntactic', 'framework', 'wrapper-summary',
] as const
const TIMING = ['sync', 'awaited', 'fire_and_forget'] as const
const ROLES = [
  'argument', 'initializer', 'condition', 'return', 'channel', 'configuration',
] as const
const CONDITIONS = [
  'if', 'switch', 'ternary', 'logical_and', 'logical_or', 'nullish', 'guard',
] as const
const LOOPS = [
  'for', 'for_in', 'for_of', 'while', 'do_while', 'array_iteration',
] as const
const PROMISES = ['all', 'allSettled', 'any', 'race'] as const
const COMPLETION = [
  'all_or_first_rejection', 'all_settled', 'first_fulfilled', 'first_settled',
] as const
const MUTATIONS = [
  'assign', 'increment', 'decrement', 'append', 'remove', 'delete',
] as const
const STORAGE = [
  'read', 'create', 'update', 'delete', 'upsert', 'transaction',
  'file_read', 'file_write', 'object_read', 'object_write',
] as const
const UNKNOWN = ['dynamic', 'ambiguous', 'unsupported'] as const
const SHA256 = /^[a-f0-9]{64}$/
const MAX_ROWS = 8_192, MAX_ROW = 262_144, MAX_TABLE = 8_388_608
const MAX_DEPTH = 5, MAX_ELEMENTS = 32, MAX_TEXT = 512
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
/**
 * Binds an operation identity to its owner, stable AST order, and authenticated
 * statement bytes. Query-index validation recomputes this value so a
 * well-shaped but replaced excerpt digest cannot silently become ready.
 */
export function indexBodyFactId(
  ownerSymbolId: string,
  kind: IndexBodyFact['kind'],
  order: readonly number[],
  excerptSha256: IndexSha256,
): string {
  const identity = [ownerSymbolId, kind, order.join('.'), excerptSha256].join('\u0000')
  return `operation:${createHash('sha256').update(identity, 'utf8')
    .digest('hex').slice(0, 32)}`
}
/** Compact graph-artifact representation; rows are canonical JSON strings. */
export type IndexBodyFactTable = readonly [version: 1, rows: readonly string[]]
export const INDEX_BODY_FACT_CONTROL_LIMIT = 64
export class IndexBodyFactBoundsError extends Error {}
function enumPos(values: readonly string[], value: string): number {
  const index = values.indexOf(value)
  if (index < 0) throw new Error(`Unsupported execution value ${value}`)
  return index
}
function orderCmp(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return left.length - right.length
}
function isDense(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1)
    if (!Object.hasOwn(value, index)) return false
  return true
}
function scalar(value: unknown): value is IndexScalarValue {
  return (value === null || ['string', 'number', 'boolean'].includes(typeof value))
    && !(typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))
    && !(typeof value === 'string' && Buffer.byteLength(value, 'utf8') > MAX_TEXT)
}
function packVal(value: IndexValue, depth = 0): unknown {
  const nestedCount = value.kind === 'array' ? value.elements.length
    : value.kind === 'object' ? value.entries.length
      : value.kind === 'template' ? value.parts.length : 0
  if (depth > MAX_DEPTH || (depth === MAX_DEPTH && nestedCount > 0))
    return [7, enumPos(UNKNOWN, 'unsupported')]
  switch (value.kind) {
    case 'literal':
      if (!scalar(value.value)) throw new Error('Execution literal is not JSON-lossless')
      return [0, value.value]
    case 'symbol':
      if (!validText(value.symbol_id, 1_024))
        throw new Error('Execution symbol reference is invalid')
      return [1, value.symbol_id]
    case 'parameter':
      if (!safeInt(value.position)
        || (value.scope !== undefined && value.scope !== 'iteration'))
        throw new Error('Execution parameter position is invalid')
      return value.scope === 'iteration'
        ? [2, value.position, 1]
        : [2, value.position]
    case 'array':
      if (value.elements.length > MAX_ELEMENTS || !isDense(value.elements))
        throw new Error('Execution array exceeds its element bound')
      return [3, value.elements.map((entry) => packVal(entry, depth + 1))]
    case 'object': {
      const keys = new Set<string>()
      if (value.entries.length > MAX_ELEMENTS || !isDense(value.entries))
        throw new Error('Execution object exceeds its element bound')
      for (const entry of value.entries) {
        if (Buffer.byteLength(entry.key, 'utf8') > MAX_TEXT
          || entry.key.includes('\0') || keys.has(entry.key))
          throw new Error('Execution object key is invalid')
        keys.add(entry.key)
      }
      return [4, value.entries.map((entry) => [
        entry.key, packVal(entry.value, depth + 1),
      ])]
    }
    case 'template':
      if (value.parts.length > MAX_ELEMENTS || !isDense(value.parts))
        throw new Error('Execution template exceeds its element bound')
      return [5, value.parts.map((entry) => packVal(entry, depth + 1))]
    case 'redacted':
      if (!SHA256.test(value.sha256) || !safeInt(value.byte_length))
        throw new Error('Execution redaction is invalid')
      return [6, value.sha256, value.byte_length]
    case 'unknown': return [7, enumPos(UNKNOWN, value.reason)]
  }
  throw new Error('Unsupported execution value')
}
function packEvidence(proof: IndexFactEvidence): unknown {
  return [
    proof.range.start.line, proof.range.start.column,
    proof.range.end.line, proof.range.end.column,
    proof.statement_range.start.line, proof.statement_range.start.column,
    proof.statement_range.end.line, proof.statement_range.end.column, proof.excerpt_sha256,
  ]
}
export function encodeIndexBodyFactTable(
  facts: readonly IndexBodyFact[],
): IndexBodyFactTable {
  if (facts.length === 0 || facts.length > MAX_ROWS) {
    throw new IndexBodyFactBoundsError(
      'Execution fact table is outside its row bound',
    )
  }
  if (!isDense(facts)) throw new Error('Execution fact table is sparse')
  const ordered = [...facts].sort((left, right) =>
    orderCmp(left.order, right.order)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const ordinals = new Map(ordered.map((fact, index) => [fact.id, index]))
  if (ordinals.size !== ordered.length)
    throw new Error('Execution fact IDs are not unique')
  const ordinal = (id: string): number => {
    const value = ordinals.get(id)
    if (value === undefined) throw new Error(`Missing execution fact reference ${id}`)
    return value
  }
  const control = (frame: IndexControlFrame): unknown => {
    if (frame.kind === 'branch') {
      if (!validText(frame.arm, 96)
        || (!['then', 'else', 'truthy', 'falsy', 'nullish', 'default'].includes(frame.arm)
          && !(frame.arm.startsWith('case:') && frame.arm.length > 5))) {
        throw new Error('Execution branch arm is invalid')
      }
      return [0, ordinal(frame.controller_fact_id), frame.arm]
    }
    if (frame.kind === 'loop') return [1, ordinal(frame.controller_fact_id)]
    if (frame.kind === 'parallel') {
      if (frame.lane !== 'each' && !safeInt(frame.lane))
        throw new Error('Execution parallel lane is invalid')
      return [2, ordinal(frame.controller_fact_id), frame.lane]
    }
    if (frame.kind === 'exception')
      return [3, enumPos(['try', 'catch', 'finally'], frame.arm)]
    throw new Error('Unsupported execution control frame')
  }
  let bytes = 0
  const orderKeys = new Set<string>()
  const rows = ordered.map((fact) => {
    const orderKey = fact.order.join('.')
    if (fact.order.length !== 4
      || !isDense(fact.order) || !fact.order.every((value) => safeInt(value))
      || !isDense(fact.control)
      || fact.control.length > INDEX_BODY_FACT_CONTROL_LIMIT
      || fact.order[1] !== enumPos(KINDS, fact.kind)
      || orderKeys.has(orderKey)
      || fact.id !== indexBodyFactId(fact.owner_symbol_id, fact.kind, fact.order,
        fact.evidence.excerpt_sha256)) {
      throw new Error(`Invalid execution fact identity ${fact.id}`)
    }
    orderKeys.add(orderKey)
    let wire: unknown
    switch (fact.kind) {
      case 'call':
        if (!isDense(fact.arguments)) throw new Error(`Sparse call arguments for ${fact.id}`)
        wire = [
          fact.callee, fact.target_symbol_id ?? null,
          fact.arguments.map(packVal), enumPos(TIMING, fact.scheduling),
        ]
        break
      case 'literal':
        wire = [packVal(fact.value), enumPos(ROLES, fact.role)]
        break
      case 'condition':
        wire = [
          enumPos(CONDITIONS, fact.condition_kind),
          fact.test ? packVal(fact.test) : null,
        ]
        break
      case 'loop':
        wire = [
          enumPos(LOOPS, fact.loop_kind),
          fact.test ? packVal(fact.test) : null,
        ]
        break
      case 'parallel': {
        const combinator = enumPos(PROMISES, fact.combinator)
        if (fact.completion !== COMPLETION[combinator]
          || !safeInt(fact.lane_count)
          || !isDense(fact.member_fact_ids)
          || new Set(fact.member_fact_ids).size !== fact.member_fact_ids.length)
          throw new Error(`Invalid parallel completion ${fact.id}`)
        wire = [
          combinator, fact.input ? packVal(fact.input) : null,
          fact.member_fact_ids.map(ordinal), fact.lane_count,
        ]
        break
      }
      case 'return':
      case 'throw':
        wire = [fact.value ? packVal(fact.value) : null]
        break
      case 'mutation':
        wire = [
          enumPos(MUTATIONS, fact.operation), fact.target,
          fact.value ? packVal(fact.value) : null,
        ]
        break
      case 'persistence':
        if (!validText(fact.receiver_type))
          throw new Error(`Persistence proof is missing for ${fact.id}`)
        wire = [
          enumPos(STORAGE, fact.operation), ordinal(fact.call_fact_id),
          fact.resource ? packVal(fact.resource) : null,
          fact.receiver_type,
        ]
        break
    }
    const row = JSON.stringify([
      fact.id, enumPos(KINDS, fact.kind),
      fact.order[0], fact.order[2], fact.order[3], packEvidence(fact.evidence),
      fact.control.map(control), enumPos(LEVELS, fact.confidence),
      enumPos(SOURCES, fact.source), wire,
    ])
    const rowBytes = Buffer.byteLength(row, 'utf8')
    bytes += rowBytes
    if (rowBytes > MAX_ROW || bytes > MAX_TABLE)
      throw new IndexBodyFactBoundsError(
        `Execution fact table exceeds its byte bound at ${fact.id}`,
      )
    return row
  })
  return [1, rows]
}
function safeInt(value: unknown, minimum = 0): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && value >= minimum
}
function validText(value: unknown, maxBytes = MAX_TEXT): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\0')
    && Buffer.byteLength(value, 'utf8') <= maxBytes
}
function tuple(value: unknown, length: number): unknown[] | null {
  return Array.isArray(value) && value.length === length ? value : null
}
function enumValue<T extends string>(values: readonly T[], value: unknown): T | null {
  return safeInt(value) && value < values.length ? values[value]! : null
}
function readVal(value: unknown, depth = 0): IndexValue | null {
  if (!Array.isArray(value)
    || !safeInt(value[0]) || value[0] > 7) return null
  if (depth > MAX_DEPTH) return null
  if (depth === MAX_DEPTH && [3, 4, 5].includes(value[0])
    && (!Array.isArray(value[1]) || value[1].length > 0)) return null
  switch (value[0]) {
    case 0: {
      return value.length === 2 && scalar(value[1])
        ? { kind: 'literal', value: value[1] } : null
    }
    case 1:
      return value.length === 2 && validText(value[1], 1_024)
        ? { kind: 'symbol', symbol_id: value[1] }
        : null
    case 2:
      return (value.length === 2 || (value.length === 3 && value[2] === 1))
        && safeInt(value[1])
        ? {
            kind: 'parameter',
            position: value[1],
            ...(value[2] === 1 ? { scope: 'iteration' as const } : {}),
          }
        : null
    case 3:
    case 5: {
      if (value.length !== 2 || !Array.isArray(value[1])
        || value[1].length > MAX_ELEMENTS) return null
      const values = value[1].map((entry) => readVal(entry, depth + 1))
      if (!values.every((entry): entry is IndexValue => entry !== null)) return null
      return value[0] === 3
        ? { kind: 'array', elements: values }
        : { kind: 'template', parts: values }
    }
    case 4: {
      if (value.length !== 2 || !Array.isArray(value[1])
        || value[1].length > MAX_ELEMENTS) return null
      const keys = new Set<string>()
      const entries: IndexObjectEntry[] = []
      for (const raw of value[1]) {
        const entry = tuple(raw, 2)
        const decoded = entry ? readVal(entry[1], depth + 1) : null
        if (!entry || typeof entry[0] !== 'string' || entry[0].includes('\0')
          || Buffer.byteLength(entry[0], 'utf8') > MAX_TEXT
          || keys.has(entry[0]) || !decoded) return null
        keys.add(entry[0])
        entries.push({ key: entry[0], value: decoded })
      }
      return { kind: 'object', entries }
    }
    case 6:
      return value.length === 3 && typeof value[1] === 'string'
        && SHA256.test(value[1]) && safeInt(value[2])
        ? { kind: 'redacted', sha256: value[1], byte_length: value[2] }
        : null
    case 7: {
      const reason = enumValue(UNKNOWN, value[1])
      return value.length === 2 && reason ? { kind: 'unknown', reason } : null
    }
  }
  return null
}
type DecodedRow = {
  id: string; kind: IndexBodyFact['kind']; order: readonly number[]
  evidence: IndexFactEvidence; control: readonly unknown[]
  confidence: IndexFactConfidence; source: IndexFactSource; payload: unknown
}
function readEvidence(value: unknown, file: string): IndexFactEvidence | null {
  const row = tuple(value, 9)
  if (!row || !row.slice(0, 8).every((entry) => safeInt(entry, 1))
    || typeof row[8] !== 'string' || !SHA256.test(row[8])) return null
  const range = {
    start: { line: row[0] as number, column: row[1] as number },
    end: { line: row[2] as number, column: row[3] as number },
  }
  const statement_range = {
    start: { line: row[4] as number, column: row[5] as number },
    end: { line: row[6] as number, column: row[7] as number },
  }
  const compare = (left: IndexPosition, right: IndexPosition): number =>
    left.line - right.line || left.column - right.column
  return compare(range.start, range.end) <= 0
    && compare(statement_range.start, statement_range.end) <= 0
    && compare(statement_range.start, range.start) <= 0
    && compare(range.end, statement_range.end) <= 0
    ? { file_id: file, range, statement_range, excerpt_sha256: row[8] }
    : null
}
function decodeRow(value: string, owner: string, file: string): DecodedRow | null {
  if (Buffer.byteLength(value, 'utf8') > MAX_ROW) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (JSON.stringify(parsed) !== value) return null
  const row = tuple(parsed, 10)
  if (!row || !validText(row[0], 64)
    || !safeInt(row[1]) || row[1] >= KINDS.length
    || !safeInt(row[2]) || !safeInt(row[3]) || !safeInt(row[4])
    || !Array.isArray(row[6])
    || row[6].length > INDEX_BODY_FACT_CONTROL_LIMIT) return null
  const kind = KINDS[row[1]]!
  const proof = readEvidence(row[5], file)
  const confidence = enumValue(LEVELS, row[7])
  const source = enumValue(SOURCES, row[8])
  const order = [row[2], row[1], row[3], row[4]] as number[]
  if (!proof || !confidence || !source
    || row[0] !== indexBodyFactId(owner, kind, order, proof.excerpt_sha256)) {
    return null
  }
  return {
    id: row[0], kind, order, evidence: proof, control: row[6], confidence, source,
    payload: row[9],
  }
}
export function decodeIndexBodyFactTable(
  value: unknown,
  owner: string,
  file: string,
): readonly IndexBodyFact[] | null {
  const table = tuple(value, 2)
  if (!validText(owner, 1_024) || !validText(file, 128)
    || !table || table[0] !== 1 || !Array.isArray(table[1])
    || table[1].length === 0 || table[1].length > MAX_ROWS) return null
  const decoded: DecodedRow[] = []
  let bytes = 0
  for (const value of table[1]) {
    if (typeof value !== 'string') return null
    bytes += Buffer.byteLength(value, 'utf8')
    if (bytes > MAX_TABLE) return null
    const row = decodeRow(value, owner, file)
    if (!row) return null
    decoded.push(row)
  }
  const ids = decoded.map((row) => row.id)
  if (new Set(ids).size !== ids.length
    || decoded.some((row, index) => index > 0
      && orderCmp(decoded[index - 1]!.order, row.order) >= 0)) {
    return null
  }
  const idAt = (value: unknown): string | null =>
    safeInt(value) && value < ids.length ? ids[value]! : null
  const control = (value: unknown): IndexControlFrame | null => {
    if (!Array.isArray(value) || !safeInt(value[0])) return null
    const controller_fact_id = idAt(value[1])
    if (value[0] === 0) {
      return value.length === 3 && controller_fact_id
        && validText(value[2], 96)
        && (['then', 'else', 'truthy', 'falsy', 'nullish', 'default'].includes(value[2])
          || (value[2].startsWith('case:') && value[2].length > 5))
        ? { kind: 'branch', controller_fact_id, arm: value[2] as IndexBranchArm }
        : null
    }
    if (value[0] === 1) return value.length === 2 && controller_fact_id
      ? { kind: 'loop', controller_fact_id } : null
    if (value[0] === 2) return value.length === 3 && controller_fact_id
      && (value[2] === 'each' || safeInt(value[2]))
      ? { kind: 'parallel', controller_fact_id, lane: value[2] } : null
    const arm = enumValue(['try', 'catch', 'finally'] as const, value[1])
    return value[0] === 3 && value.length === 2 && arm
      ? { kind: 'exception', arm } : null
  }
  const facts: IndexBodyFact[] = []
  for (const row of decoded) {
    const frames = row.control.map(control)
    if (!frames.every((frame): frame is IndexControlFrame => frame !== null)) return null
    const base = {
      id: row.id, owner_symbol_id: owner, order: row.order,
      evidence: row.evidence, control: frames,
      confidence: row.confidence, source: row.source,
    }
    const wire = Array.isArray(row.payload) ? row.payload : null
    let fact: IndexBodyFact | null = null
    if (row.kind === 'call' && wire?.length === 4) {
      const scheduling = enumValue(TIMING, wire[3])
      const args = Array.isArray(wire[2])
        ? wire[2].map((entry) => readVal(entry))
        : []
      if (validText(wire[0]) && scheduling
        && (wire[1] === null || validText(wire[1], 1_024))
        && Array.isArray(wire[2])
        && args.every((entry): entry is IndexValue => entry !== null)) {
        fact = {
          ...base, kind: 'call', callee: wire[0],
          ...(typeof wire[1] === 'string' ? { target_symbol_id: wire[1] } : {}),
          arguments: args, scheduling,
        }
      }
    } else if (row.kind === 'literal' && wire?.length === 2) {
      const decoded = readVal(wire[0])
      const role = enumValue(ROLES, wire[1])
      if (decoded && role) fact = { ...base, kind: 'literal', value: decoded, role }
    } else if (row.kind === 'condition' && wire?.length === 2) {
      const condition_kind = enumValue(CONDITIONS, wire[0])
      const test = wire[1] === null ? undefined : readVal(wire[1])
      if (condition_kind && (wire[1] === null || test)) {
        fact = { ...base, kind: 'condition', condition_kind, ...(test ? { test } : {}) }
      }
    } else if (row.kind === 'loop' && wire?.length === 2) {
      const loop_kind = enumValue(LOOPS, wire[0])
      const test = wire[1] === null ? undefined : readVal(wire[1])
      if (loop_kind && (wire[1] === null || test)) {
        fact = { ...base, kind: 'loop', loop_kind, ...(test ? { test } : {}) }
      }
    } else if (row.kind === 'parallel' && wire?.length === 4) {
      const combinator = enumValue(PROMISES, wire[0])
      const input = wire[1] === null ? undefined : readVal(wire[1])
      const members = Array.isArray(wire[2])
        ? wire[2].map(idAt)
        : []
      if (combinator && (wire[1] === null || input)
        && Array.isArray(wire[2])
        && members.every((id): id is string => id !== null)
        && new Set(members).size === members.length
        && safeInt(wire[3])) {
        fact = {
          ...base, kind: 'parallel', combinator,
          completion: COMPLETION[PROMISES.indexOf(combinator)]!,
          lane_count: wire[3],
          ...(input ? { input } : {}),
          member_fact_ids: members,
        }
      }
    } else if ((row.kind === 'return' || row.kind === 'throw')
      && wire?.length === 1) {
      const decoded = wire[0] === null ? undefined : readVal(wire[0])
      if (wire[0] === null || decoded) {
        fact = { ...base, kind: row.kind, ...(decoded ? { value: decoded } : {}) }
      }
    } else if (row.kind === 'mutation' && wire?.length === 3) {
      const operation = enumValue(MUTATIONS, wire[0])
      const decoded = wire[2] === null ? undefined : readVal(wire[2])
      if (operation && validText(wire[1])
        && (wire[2] === null || decoded)) {
        fact = {
          ...base, kind: 'mutation', operation, target: wire[1],
          ...(decoded ? { value: decoded } : {}),
        }
      }
    } else if (row.kind === 'persistence' && wire?.length === 4) {
      const operation = enumValue(STORAGE, wire[0])
      const call_fact_id = idAt(wire[1])
      const resource = wire[2] === null ? undefined : readVal(wire[2])
      if (operation && call_fact_id && (wire[2] === null || resource)
        && validText(wire[3])) {
        fact = {
          ...base, kind: 'persistence', operation, call_fact_id,
          ...(resource ? { resource } : {}),
          receiver_type: wire[3],
        }
      }
    }
    if (!fact) return null
    facts.push(fact)
  }
  return facts
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
