import { createHash } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { GraphAttributes } from '../domain/graph/directed-multigraph.js'
import type {
  IndexBodyFact, IndexChannelNode, IndexRange, IndexValue,
} from '../domain/index/model.js'
import type { QueryIndex, ReadyQueryIndex } from '../domain/query/index-status.js'
import {
  type EvidenceHydrationTargets, type HydratedEntity,
  type HydratedEvidenceResult, type HydratedExcerpt, type HydratedFile,
  type HydratedProof, type SelectedEvidenceEdge,
} from '../domain/query/types.js'
type Failure = Extract<HydratedEvidenceResult, { subject: string }>
type ReadySource = [
  path: string, sha256: string, text: string,
  starts: readonly number[], ends: readonly number[], file: string,
]
type FactProof = [owner: string, excerpt: string]
type CallFact = Extract<IndexBodyFact, { kind: 'call' }>
type EdgeRow = readonly [from: string, to: string, attrs: GraphAttributes, id: string]
const SHA = /^[a-f0-9]{64}$/
const channelFields: readonly (keyof IndexChannelNode)[] = [
  'channel_kind', 'transport', 'key', 'parent_channel_id', 'scope',
]
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0
class Halt { constructor(readonly value: Failure) {} }
function halt(state: Failure['state'], subject: string): never {
  throw new Halt({ state, subject })
}
function corrupt(subject: string): never { halt('corrupt', subject) }
const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.includes('\0')
const populated = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0
const orderPos = (
  left: IndexRange['start'], right: IndexRange['start'],
): number => left.line - right.line || left.column - right.column
function range(value: unknown): value is IndexRange {
  if (!value || typeof value !== 'object') return false
  const candidate = value as IndexRange
  return [candidate.start, candidate.end].every((position) =>
    position && typeof position === 'object'
    && Number.isSafeInteger(position.line) && position.line > 0
    && Number.isSafeInteger(position.column) && position.column > 0)
    && orderPos(candidate.start, candidate.end) <= 0
}
const contains = (outer: IndexRange, inner: IndexRange): boolean =>
  orderPos(outer.start, inner.start) <= 0
  && orderPos(inner.end, outer.end) <= 0
const sameRange = (left: IndexRange, right: IndexRange): boolean =>
  orderPos(left.start, right.start) === 0
  && orderPos(left.end, right.end) === 0
const location = (value: IndexRange): string =>
  `L${value.start.line}${value.start.line === value.end.line
    ? '' : `-L${value.end.line}`}`
function lineOffsets(text: string): [number[], number[]] {
  const starts = [0]
  const ends: number[] = []
  for (const match of text.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) {
    ends.push(match.index)
    starts.push(match.index + match[0].length)
  }
  ends.push(text.length)
  return [starts, ends]
}
function offset(source: ReadySource, line: number, column: number): number | null {
  const start = source[3][line - 1], end = source[4][line - 1],
    result = start === undefined ? 0 : start + column - 1
  return start === undefined || end === undefined || result > end ? null : result
}
function excerpt(source: ReadySource, value: IndexRange): string | null {
  const start = offset(source, value.start.line, value.start.column),
    end = offset(source, value.end.line, value.end.column)
  return start === null || end === null || end < start
    ? null
    : source[2].slice(start, end)
}
function ready(i: ReadyQueryIndex, input: EvidenceHydrationTargets): HydratedEvidenceResult {
  const ids = (values: readonly string[], subject: string): string[] => {
    if (!Array.isArray(values) || values.some((value) => !nonEmpty(value))) corrupt(subject)
    return [...new Set(values)].sort(compare)
  }
  const symbols = ids(input.symbolIds, 'symbol targets')
  const decls = ids(input.declarationSymbolIds, 'declaration targets')
  const ops = ids(input.operationIds, 'operation targets')
  const validations = ids(input.validationOperationIds ?? [], 'validation operation targets')
  for (const id of decls) if (!symbols.includes(id)) corrupt(id)
  if (!Array.isArray(input.edges)) corrupt('edge targets')
  const edges = new Map<string, [
    target: SelectedEvidenceEdge, row?: EdgeRow | null,
  ]>()
  for (const edge of input.edges) {
    if (!edge || !nonEmpty(edge.id) || !nonEmpty(edge.fromId) || !nonEmpty(edge.toId)
      || edge.relation !== undefined && !nonEmpty(edge.relation)) corrupt('edge targets')
    const prior = edges.get(edge.id)?.[0]
    if (prior && (prior.fromId !== edge.fromId || prior.toId !== edge.toId
      || prior.relation !== edge.relation)) corrupt(edge.id)
    if (!prior) edges.set(edge.id, [edge])
  }
  const d = new Set(decls), o = new Set([...ops, ...validations])
  const s = new Map<string, ReadySource>(), f = new Map<string, HydratedFile>()
  const e = new Map<string, HydratedEntity>(), x = new Map<string, HydratedExcerpt>()
  const p = new Map<string, HydratedProof>(), u = new Set<string>()
  function node(id: string): GraphAttributes {
    if (!i.graph.hasNode(id)) corrupt(id)
    return i.graph.nodeAttributes(id)
  }
  function src(path: string): ReadySource {
    const cached = s.get(path)
    if (cached) return cached
    const expected = i.file_hashes.get(path)
    if (expected === undefined) halt('stale', path)
    if (!SHA.test(expected)) corrupt(path)
    let root: string, candidate: string, bytes: Buffer
    try {
      root = realpathSync(i.root_path)
      candidate = realpathSync(resolve(root, path))
      const rel = relative(root, candidate)
      if (isAbsolute(path) || rel === '..'
        || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        halt('unavailable', path)
      }
      bytes = readFileSync(candidate)
    } catch {
      halt('unavailable', path)
    }
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected) halt('stale', path)
    if (!isUtf8(bytes)) corrupt(path)
    const text = bytes.toString('utf8')
    const file = `f${f.size}`
    const result: ReadySource = [path, expected, text, ...lineOffsets(text), file]
    f.set(path, [file, expected])
    s.set(path, result)
    return result
  }
  function proof(
    source: ReadySource, value: IndexRange,
    expected?: string, subject = source[0], store = true,
  ): string {
    const text = excerpt(source, value)
    if (text === null) corrupt(subject)
    const actual = createHash('sha256').update(text, 'utf8').digest('hex')
    if (expected !== undefined && (!SHA.test(expected) || actual !== expected)) {
      corrupt(subject)
    }
    if (!store) return ''
    const key = `${source[1]}\0${value.start.line}:${value.start.column}:${value.end.line}:${value.end.column}\0${actual}`
    const cached = x.get(key)
    if (cached) return cached[0]
    const alias = `x${x.size}`
    x.set(key, [alias, source[5], value, actual, text])
    return alias
  }
  function entity(id: string, allowChannel = false): string {
    const cached = e.get(id)
    if (cached) {
      if (!allowChannel && cached[1] === 'channel') corrupt(id)
      return cached[0]
    }
    const attrs = node(id)
    const alias = `e${e.size}`
    if (attrs.node_kind === 'channel') {
      if (!allowChannel) corrupt(id)
      const channel = i.channels_by_id.get(id)
      if (!channel || channelFields.some((field) => attrs[field] !== channel[field])) {
        corrupt(id)
      }
      e.set(id, [
        alias, 'channel', channel.channel_kind, channel.transport, channel.key,
        channel.parent_channel_id, channel.scope,
      ])
      return alias
    }
    const {
      node_kind: nodeKind, label, source_file: path,
      definition_range: definition, declaration_range: declaration,
    } = attrs
    if (!nonEmpty(nodeKind) || nodeKind === 'file'
      || !nonEmpty(label) || !nonEmpty(path)
      || !range(definition) || !range(declaration)
      || !contains(definition, declaration)
      || !populated(attrs.provenance)
      || attrs.line_number !== definition.start.line
      || attrs.end_line_number !== definition.end.line
      || attrs.source_location !== location(definition)) {
      corrupt(id)
    }
    const source = src(path)
    if (excerpt(source, definition) === null) halt('stale', path)
    const declProof = d.has(id) ? proof(source, declaration) : undefined
    e.set(id, [alias, 'symbol', label, nodeKind, source[5]])
    if (declProof) {
      p.set(id, [`p${p.size}`, 'declaration', alias, declProof])
      u.add(alias)
    }
    return alias
  }
  function fact(value: IndexBodyFact, exactOnly: boolean, store = true): FactProof {
    const { owner_symbol_id: ownerId, evidence } = value
    const hadOwner = e.has(ownerId)
    const ownerKey = entity(ownerId)
    if ((!exactOnly || !store) && !hadOwner) e.delete(ownerId)
    const targetId = value.kind === 'call' ? value.target_symbol_id : undefined
    if (targetId && ['channel', 'file'].includes(String(node(targetId).node_kind))) {
      corrupt(targetId)
    }
    if (targetId && e.has(targetId)) u.add(entity(targetId))
    const owner = node(ownerId)
    const definition = owner.definition_range
    if (!range(definition)) corrupt(value.id)
    const file = i.graph.hasNode(evidence.file_id)
      ? i.graph.nodeAttributes(evidence.file_id) : null
    const path = owner.source_file
    const owns = (id: string): boolean => {
      const target = i.operation_by_id.get(id)
      return (!exactOnly || o.has(id)) && target?.owner_symbol_id === ownerId
    }
    const invalidRefs = value.control.some((frame) =>
      frame.kind !== 'exception' && !owns(frame.controller_fact_id))
      || value.kind === 'parallel' && value.member_fact_ids.some((id) => !owns(id))
      || value.kind === 'persistence' && !owns(value.call_fact_id)
    if (!file || file.node_kind !== 'file'
      || !nonEmpty(path) || file.source_file !== path
      || file.content_hash !== i.file_hashes.get(path)
      || !range(evidence.range) || !range(evidence.statement_range)
      || !contains(definition, evidence.statement_range)
      || !contains(evidence.statement_range, evidence.range)
      || invalidRefs) {
      corrupt(value.id)
    }
    const source = src(path)
    const controlled = ['condition', 'loop', 'parallel'].includes(value.kind)
    const statement = proof(
      source, evidence.statement_range, evidence.excerpt_sha256, value.id,
      store && !controlled,
    )
    return [ownerKey, controlled ? proof(source, evidence.range, undefined, value.id, store)
      : statement]
  }
  function edge(target: SelectedEvidenceEdge, row: EdgeRow): void {
    const [from, to, attrs, id] = row
    const {
      relation, source_file: path, evidence, execution_owner_id: ownerId,
      source_location: sourceLocation,
    } = attrs
    if (id !== target.id || from !== target.fromId || to !== target.toId
      || !nonEmpty(relation)
      || target.relation !== undefined && relation !== target.relation) {
      corrupt(target.id)
    }
    const fromKey = entity(from, true)
    const toKey = entity(to, true)
    if (!nonEmpty(path) || !populated(attrs.provenance)
      || !evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      corrupt(id)
    }
    const raw = evidence as Record<string, unknown>
    const {
      range: at, source: proofKind, statement_range: statement,
      excerpt_sha256: hash,
    } = raw
    if (![
      'typescript-semantic', 'typescript-syntactic',
      'framework-decorator', 'wrapper-summary',
    ].includes(proofKind as string) || !range(at)) corrupt(id)
    if (relation === 'calls') {
      if (Object.keys(raw).length !== 2 || ownerId !== undefined
        || sourceLocation !== location(at)) corrupt(id)
      const excerptKey = selectedCall(id, from, (call) =>
        call.target_symbol_id === to && sameRange(call.evidence.range, at)
        && proofKind === (call.source === 'framework'
          ? 'framework-decorator' : call.source))
      if (path !== node(from).source_file) corrupt(id)
      return record(id, fromKey, toKey, relation, excerptKey)
    }
    if (Object.keys(raw).length !== 4 || !range(statement)
      || !contains(statement, at) || !nonEmpty(hash)
      || sourceLocation !== location(statement)) corrupt(id)
    if (!nonEmpty(ownerId)) corrupt(id)
    const ownerAttrs = node(ownerId)
    if (ownerAttrs.node_kind === 'channel' || ownerAttrs.node_kind === 'file'
      || ownerAttrs.source_file !== path || !range(ownerAttrs.definition_range)
      || !contains(ownerAttrs.definition_range, statement)) corrupt(id)
    const fromChannel = i.channels_by_id.get(from)
    const toChannel = i.channels_by_id.get(to)
    const valid = relation === 'publishes_to'
      ? ownerId === from && !fromChannel && !!toChannel
      : relation === 'routes_through'
        ? fromChannel?.channel_kind === 'job'
        && toChannel?.channel_kind === 'queue'
        && fromChannel.parent_channel_id === to
        && fromChannel.transport === toChannel.transport
        : relation === 'consumed_by'
          && !!fromChannel && !toChannel
    if (!valid) corrupt(id)
    if (relation === 'consumed_by' && ownerId !== to) {
      selectedCall(id, ownerId, (call) =>
        sameRange(statement, call.evidence.statement_range)
        && call.evidence.excerpt_sha256 === hash)
    }
    const source = src(path)
    record(id, fromKey, toKey, relation, proof(source, statement, hash, id))
  }
  function selectedCall(
    edgeId: string, ownerId: string, accepts: (fact: CallFact) => boolean,
  ): string {
    const accepted = (call: CallFact): boolean =>
      call.owner_symbol_id === ownerId && accepts(call)
    const matches = (i.operations_by_owner.get(ownerId) ?? [])
      .filter((value): value is CallFact => value.kind === 'call'
        && accepted(value))
    if (matches.length !== 1) corrupt(edgeId)
    const match = matches[0]!
    const indexed = i.operation_by_id.get(match.id)
    if (indexed?.kind !== 'call' || !accepted(indexed)
      || !sameRange(indexed.evidence.range, match.evidence.range)
      || !sameRange(indexed.evidence.statement_range, match.evidence.statement_range)) {
      corrupt(edgeId)
    }
    return fact(indexed, false)[1]
  }
  function record(
    id: string, fromKey: string, toKey: string, relation: string, excerptKey: string,
  ): void {
    p.set(id, [`p${p.size}`, 'edge', fromKey, toKey, relation, excerptKey])
    u.add(fromKey).add(toKey)
  }
  for (const id of symbols) entity(id)
  for (const id of validations) {
    const value = i.operation_by_id.get(id)
    if (!value || value.id !== id) corrupt(id)
    fact(value, true, false)
  }
  for (const id of ops) {
    const value = i.operation_by_id.get(id)
    if (!value || value.id !== id) corrupt(id)
    const hydrated = fact(value, true)
    const alias = `e${e.size}`
    e.set(id, [alias, 'operation', hydrated[0], value])
    p.set(id, [`p${p.size}`, 'operation', alias, hydrated[1]])
    u.add(hydrated[0])
  }
  try {
    for (const row of i.graph.edgeEntries()) {
      const selected = edges.get(row[3])
      if (selected) selected[1] = selected[1] === undefined ? row : null
    }
  } catch {
    corrupt('selected edges')
  }
  for (const [, [target, row]] of [...edges].sort((a, b) => compare(a[0], b[0]))) {
    if (!row) corrupt(target.id)
    edge(target, row)
  }
  for (const [id, entry] of e) {
    if (entry[1] === 'symbol' && !u.has(entry[0])) corrupt(id)
  }
  return { state: 'ready', files: f, excerpts: x, entities: e, proofs: p }
}
export function hydrateEvidence(
  index: QueryIndex,
  input: EvidenceHydrationTargets,
): HydratedEvidenceResult {
  try {
    if (index.state !== 'ready') return { state: index.state, subject: index.subject }
    return ready(index, input)
  } catch (error) {
    return error instanceof Halt
      ? error.value : { state: 'corrupt', subject: 'evidence hydration' }
  }
}
