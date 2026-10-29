import { randomUUID } from 'node:crypto'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

import type { ContextPackExpandableRef, ContextPackTaskKind } from '../contracts/context-pack.js'
import type { TaskIntentKind } from '../contracts/task-intent.js'
import { JS_TS_SOURCE_EXTENSIONS } from '../shared/source-extensions.js'
import { beginSourceContinuation, isSourceContinuationHandle, readVerifiedSourceSnapshot, type SourceContinuationHandle } from './source-continuation.js'
import { MIN_SOURCE_EVIDENCE_BUDGET, SOURCE_EVIDENCE_RESPONSE_FORMAT, resolveSourceSnippet } from './source-evidence-response.js'
import { estimateQueryTokens } from './serve.js'
import { sourceDeclarationKind } from './retrieve/source-evidence.js'

type RecordValue = Record<string, unknown>
const MAX_TARGETS = 8
const MAX_TARGET_LENGTH = 512
const SOURCE_EXTENSIONS = new Set(JS_TS_SOURCE_EXTENSIONS)
const SYMBOL = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/
const CAVEAT = 'Explicit target lookup verifies only the requested source owners; it does not establish whole-task completeness.'
const BUDGET_CAVEAT = 'Source evidence omitted to fit the output budget.'
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const records = (value: unknown): RecordValue[] => Array.isArray(value) ? value.map(record) : []

export class ExplicitSourceTargetError extends Error {}

export interface ExplicitSourceTarget { file: string; symbol: string; callee?: string }

/** Normalize lexical paths only. Canonical paths, policy, and declarations require owner verification. */
export function parseExplicitSourceTargets(value: unknown): ExplicitSourceTarget[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TARGETS) {
    throw new ExplicitSourceTargetError('targets must contain between 1 and 8 exact file and symbol pairs')
  }
  const seen = new Set<string>()
  return value.map(entry => {
    const target = record(entry)
    if (Object.keys(target).some(key => !['file', 'symbol', 'callee'].includes(key)) || !Object.hasOwn(target, 'file') || !Object.hasOwn(target, 'symbol')
      || typeof target.file !== 'string' || typeof target.symbol !== 'string') {
      throw new ExplicitSourceTargetError('Each target must contain string file and symbol fields, with an optional callee')
    }
    const rawFile = target.file.replaceAll('\\', '/')
    if (!rawFile || rawFile.length > MAX_TARGET_LENGTH || rawFile !== rawFile.trim()
      || /[\u0000-\u001f\u007f:?#]/.test(rawFile) || rawFile.startsWith('/') || rawFile.endsWith('/')
      || rawFile.split('/').includes('..')) {
      throw new ExplicitSourceTargetError('Target file must be a workspace-relative JS/TS path without traversal, drive, URL, or control characters')
    }
    const file = rawFile.split('/').filter(part => part !== '' && part !== '.').join('/')
    if (!file || !SOURCE_EXTENSIONS.has(extname(file).toLowerCase())) {
      throw new ExplicitSourceTargetError('Target file must name a JavaScript or TypeScript source file')
    }
    if (target.symbol.length > MAX_TARGET_LENGTH || !SYMBOL.test(target.symbol)) {
      throw new ExplicitSourceTargetError('Target symbol must be an exact dotted identifier, optionally ending in (), of at most 512 characters')
    }
    if (Object.hasOwn(target, 'callee') && (typeof target.callee !== 'string' || target.callee.length > MAX_TARGET_LENGTH
      || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(target.callee))) {
      throw new ExplicitSourceTargetError('Target callee must be an exact identifier or static dotted call expression, without arguments or optional/computed access')
    }
    const symbol = target.symbol.replace(/\(\)$/, ''), key = JSON.stringify([file, symbol, target.callee ?? null])
    if (seen.has(key)) throw new ExplicitSourceTargetError('targets must not contain duplicate normalized file and symbol pairs')
    seen.add(key)
    return { file, symbol, ...(typeof target.callee === 'string' ? { callee: target.callee } : {}) }
  })
}

export interface ExplicitSourceTargetOwner {
  nodeId: string
  label: string
  sourceFile: string
  range: { start: number; end: number }
  snippet: string
  validate(): void
}

/** Uses the existing session-owned context_pack handle contract. */
export interface ExplicitSourceTargetHandle {
  prompt: string
  task: ContextPackTaskKind
  task_intent: TaskIntentKind
  follow_up: ContextPackExpandableRef['follow_up']
  explicit_target: { node_id: string; symbol: string }
}

export type ExplicitSourceTargetStoredHandle = ExplicitSourceTargetHandle | SourceContinuationHandle

export interface ExplicitSourceTargetPayloadOptions {
  owners: readonly ExplicitSourceTargetOwner[]
  prompt: string
  task: ContextPackTaskKind
  taskIntent?: TaskIntentKind
  budget: number
  rootPath: string
  governance: unknown
  finalize(input: object, budget: number, options: {
    continuations: { rootPath: string; store(id: string, handle: SourceContinuationHandle): void }
  }): RecordValue
}

function sameRange(value: unknown, owner: ExplicitSourceTargetOwner): boolean {
  const range = record(value)
  return range.start_line === owner.range.start && range.end_line === owner.range.end
}

function sourceNode(owner: ExplicitSourceTargetOwner): RecordValue {
  return { node_id: owner.nodeId, label: owner.label, source_file: owner.sourceFile,
    line_number: owner.range.start, snippet: owner.snippet, snippet_scope: 'symbol',
    snippet_line_range: { start_line: owner.range.start, end_line: owner.range.end } }
}

function genericReference(owner: ExplicitSourceTargetOwner, options: ExplicitSourceTargetPayloadOptions): {
  ref: ContextPackExpandableRef; handle: ExplicitSourceTargetHandle
} {
  const follow_up: ContextPackExpandableRef['follow_up'] = { kind: 'context_pack', task_kind: options.task,
    evidence_class: 'primary', focus_files: [owner.sourceFile],
    focus_ranges: [{ source_file: owner.sourceFile, start_line: owner.range.start, end_line: owner.range.end }] }
  return {
    ref: { kind: 'nodes', handle_id: `explicit-source:${randomUUID()}`, evidence_class: 'primary', count: 1,
      symbols: [owner.label.replace(/\(\)$/, '')], preview: [], follow_up },
    handle: { prompt: options.prompt, task: options.task, task_intent: options.taskIntent ?? options.task, follow_up,
      explicit_target: { node_id: owner.nodeId, symbol: owner.label.replace(/\(\)$/, '') } },
  }
}

/** Only the known allocation-only result may be replaced by a first source page. */
function isSoleOwnerBudgetOmission(context: RecordValue, origin: RecordValue, budget: number): boolean {
  const evidence = record(context.evidence), answerability = record(evidence.answerability)
  const omitted = record(context.omitted_evidence), pack = record(context.pack), receipt = record(context.serialized_budget)
  const freshness = record(record(context.governance).graph_freshness)
  const originFreshness = record(record(origin.governance).graph_freshness)
  const intent = Object.hasOwn(context, 'task_intent') ? context.task_intent : context.task
  // Unknown fields can contain new policy or verification obligations. Leave those results alone.
  if (Object.keys(context).some(key => !['response_format', 'task', 'task_intent', 'pack', 'evidence',
    'governance', 'omitted_evidence', 'serialized_budget'].includes(key))
    || Object.keys(evidence).some(key => !['answerability', 'agent_directive'].includes(key))
    || Object.keys(answerability).some(key => !['state', 'answer_scope', 'advisory', 'caveats', 'broad_search_fallback'].includes(key))
    || Object.keys(pack).some(key => !['selection_scope', 'matched_nodes', 'relationships'].includes(key))
    || Object.keys(receipt).some(key => !['max_tokens', 'token_count', 'enforced'].includes(key))
    || Object.keys(record(context.governance)).some(key => key !== 'graph_freshness')
    || Object.entries(freshness).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(originFreshness[key]))) return false
  return context.response_format === SOURCE_EVIDENCE_RESPONSE_FORMAT && context.task === origin.task
    && intent === origin.task_intent && pack.selection_scope === 'symbol_lookup'
    && Array.isArray(pack.matched_nodes) && pack.matched_nodes.length === 0
    && (pack.relationships === undefined || Array.isArray(pack.relationships) && pack.relationships.length === 0)
    && originFreshness.status === 'fresh' && originFreshness.selected_context_status === 'fresh'
    && freshness.status === 'fresh' && freshness.selected_context_status === 'fresh'
    && omitted.reason === 'output_budget' && omitted.count === 1
    && omitted.continuation === 'Request a focused context_pack or expand a supplied handle.'
    && receipt.max_tokens === budget && receipt.enforced === true
    && Number.isSafeInteger(receipt.token_count) && Number(receipt.token_count) <= budget
    && receipt.token_count === estimateQueryTokens(JSON.stringify(context))
    && Object.keys(omitted).every(key => ['reason', 'count', 'continuation'].includes(key))
    && evidence.agent_directive === 'explore_with_caution'
    && answerability.state === 'insufficient' && answerability.answer_scope === 'partial' && answerability.advisory === true
    && answerability.broad_search_fallback === 'allowed'
    && Array.isArray(answerability.caveats) && answerability.caveats.length === 2
    && answerability.caveats.includes(CAVEAT) && answerability.caveats.includes(BUDGET_CAVEAT)
}

/** The original lookup obligations persist; a discarded allocation's budget warnings do not. */
function firstExplicitSourcePage(owner: ExplicitSourceTargetOwner, context: RecordValue, origin: RecordValue,
  options: ExplicitSourceTargetPayloadOptions): ReturnType<typeof beginSourceContinuation> | undefined {
  if (!isSoleOwnerBudgetOmission(context, origin, options.budget)) return undefined
  owner.validate()
  const lines = readVerifiedSourceSnapshot(owner.sourceFile, options.rootPath).lines
  // The existing paginator supports callable owners; other declarations retain ordinary recovery.
  if (sourceDeclarationKind(lines, owner.range, owner.label, owner.sourceFile) !== 'function') {
    owner.validate()
    return undefined
  }
  let pageBudget = options.budget
  let wrapperReserve = 0
  for (let attempt = 0; attempt < 3 && pageBudget >= MIN_SOURCE_EVIDENCE_BUDGET; attempt++) {
    const page = beginSourceContinuation({ node_id: owner.nodeId, label: owner.label,
      source_file: owner.sourceFile, range: { start_line: owner.range.start, end_line: owner.range.end },
      snippet: owner.snippet }, origin, pageBudget, options.rootPath)
    if (!records(record(page.payload.pack).matched_nodes).length) {
      owner.validate()
      return undefined
    }
    const payload: RecordValue = { ...page.payload,
      pack: { ...record(page.payload.pack), selection_scope: 'symbol_lookup', relationships: [] },
      serialized_budget: { max_tokens: options.budget, token_count: 0, enforced: true } }
    const receipt = record(payload.serialized_budget)
    let count = 0
    for (let pass = 0; pass < 12; pass++) {
      count = estimateQueryTokens(JSON.stringify(payload))
      if (receipt.token_count === count) break
      receipt.token_count = count
    }
    owner.validate()
    if (estimateQueryTokens(JSON.stringify(payload)) !== count) {
      throw new Error('Explicit source page token receipt did not stabilize')
    }
    if (count <= options.budget) return { payload, ...(page.child ? { child: page.child } : {}) }
    // Reserve the whole wrapper cost: subtracting only the excess can select
    // the same source prefix on every retry. Failed trial children stay private.
    wrapperReserve = Math.max(wrapperReserve, count - estimateQueryTokens(JSON.stringify(page.payload)))
    pageBudget = Math.min(pageBudget - 1, options.budget - wrapperReserve)
  }
  return undefined
}

/** Every successful result contains either the complete owner or a current-scope recovery route. */
export function buildExplicitSourceTargetPayload(options: ExplicitSourceTargetPayloadOptions): {
  payload: RecordValue; handles: Map<string, ExplicitSourceTargetStoredHandle>
} {
  if (!Number.isSafeInteger(options.budget) || options.budget < MIN_SOURCE_EVIDENCE_BUDGET) {
    throw new ExplicitSourceTargetError(`Explicit target budget must be at least ${MIN_SOURCE_EVIDENCE_BUDGET} tokens`)
  }
  if (!options.owners.length || options.owners.length > MAX_TARGETS) {
    throw new ExplicitSourceTargetError('Explicit target lookup requires between 1 and 8 verified owners')
  }
  const byId = new Map<string, ExplicitSourceTargetOwner>()
  for (const original of options.owners) {
    original.validate()
    const sourceFile = relative(resolve(options.rootPath), resolve(options.rootPath, original.sourceFile.replaceAll('\\', '/'))).split(sep).join('/')
    if (!sourceFile || sourceFile === '..' || sourceFile.startsWith('../') || isAbsolute(sourceFile)
      || !original.nodeId || !SYMBOL.test(original.label) || typeof original.snippet !== 'string'
      || !Number.isSafeInteger(original.range.start) || !Number.isSafeInteger(original.range.end)
      || original.range.start < 1 || original.range.end < original.range.start) {
      throw new ExplicitSourceTargetError('Explicit target lookup requires exact verified source owners within the workspace')
    }
    const owner = { ...original, sourceFile }, prior = byId.get(owner.nodeId)
    if (prior && JSON.stringify(sourceNode(prior)) !== JSON.stringify(sourceNode(owner))) {
      throw new ExplicitSourceTargetError('Explicit target aliases do not agree on the same verified source owner')
    }
    byId.set(owner.nodeId, owner)
  }
  const owners = [...byId.values()]
  const generic = new Map<string, ReturnType<typeof genericReference>>()
  const addReference = (owner: ExplicitSourceTargetOwner): void => {
    if (!generic.has(owner.nodeId)) generic.set(owner.nodeId, genericReference(owner, options))
  }
  const origin: RecordValue = { task: options.task, task_intent: options.taskIntent ?? options.task,
    evidence: { answerability: { state: 'insufficient', answer_scope: 'partial', advisory: true, caveats: [CAVEAT] } },
    governance: structuredClone(options.governance) }
  let nodes = owners.map(sourceNode)
  for (let attempt = 0; attempt <= owners.length; attempt++) {
    const staged = new Map<string, ExplicitSourceTargetStoredHandle>()
    for (const { ref, handle } of generic.values()) staged.set(ref.handle_id, handle)
    let payload = options.finalize({ ...structuredClone(origin),
      pack: { selection_scope: 'symbol_lookup', _explicit_source_targets: true,
        matched_nodes: nodes, relationships: [] },
      ...(generic.size ? { expandable: [...generic.values()].map(value => value.ref) } : {}),
    }, options.budget, { continuations: { rootPath: options.rootPath, store: (id, handle) => staged.set(id, handle) } })
    if (attempt === 0 && owners.length === 1 && !records(record(payload.pack).matched_nodes).length
      && !records(payload.expandable).length && !records(record(payload.pack).expandable).length) {
      const page = firstExplicitSourcePage(owners[0]!, payload, origin, options)
      if (page) {
        payload = page.payload
        staged.clear()
        if (page.child) staged.set(page.child.id, page.child.handle)
      }
    }
    const visible = records(record(payload.pack).matched_nodes)
    const references = records(payload.expandable)
    const advertised = new Set<string>()
    const recovered = (owner: ExplicitSourceTargetOwner): boolean => {
      const node = visible.find(value => value.node_id === owner.nodeId && value.label === owner.label
        && value.source_file === owner.sourceFile && sameRange(value.snippet_line_range, owner))
      if (node && node.snippet_unverified !== true && node.snippet_source !== 'derived'
        && node.snippet_truncated !== true && records(node.snippet_omitted_ranges).length === 0
        && resolveSourceSnippet(node, visible) === owner.snippet) return true
      if (node && typeof node.source_expand_handle === 'string') {
        const handle = staged.get(node.source_expand_handle)
        if (isSourceContinuationHandle(handle) && handle.node_id === owner.nodeId && handle.label === owner.label
          && resolve(options.rootPath, handle.source_file) === resolve(options.rootPath, owner.sourceFile)
          && sameRange(handle.owner_range, owner)) {
          advertised.add(node.source_expand_handle)
          return true
        }
      }
      const fallback = generic.get(owner.nodeId)
      if (!fallback) return false
      const ref = references.find(value => value.handle_id === fallback.ref.handle_id)
      const scope = record(ref?.follow_up ?? ref)
      if (!ref || JSON.stringify(ref.symbols) !== JSON.stringify(fallback.ref.symbols)
        || JSON.stringify(scope.focus_files) !== JSON.stringify(fallback.handle.follow_up.focus_files)
        || JSON.stringify(scope.focus_ranges) !== JSON.stringify(fallback.handle.follow_up.focus_ranges)) return false
      advertised.add(fallback.ref.handle_id)
      return true
    }
    const missing = owners.filter(owner => !recovered(owner))
    if (!missing.length) {
      // Source finalization is allowed to compact or omit these owners, never to widen selection.
      if (visible.some(node => !owners.some(owner => node.node_id === owner.nodeId && node.label === owner.label
        && node.source_file === owner.sourceFile && sameRange(node.snippet_line_range, owner)))) {
        throw new Error('Explicit target finalization changed the verified source selection')
      }
      const answerability = record(record(payload.evidence).answerability)
      if (answerability.state !== 'insufficient' || answerability.answer_scope !== 'partial'
        || answerability.advisory !== true || record(payload.pack).selection_scope !== 'symbol_lookup') {
        throw new Error('Explicit target finalization lost the partial source lookup boundary')
      }
      const receipt = record(payload.serialized_budget), count = estimateQueryTokens(JSON.stringify(payload))
      if (count > options.budget || receipt.max_tokens !== options.budget || receipt.token_count !== count || receipt.enforced !== true) {
        throw new Error('Explicit target finalization did not preserve the serialized budget')
      }
      for (const owner of options.owners) owner.validate()
      // Include all advertised pointers, including redundant but retained navigation.
      for (const node of visible) if (typeof node.source_expand_handle === 'string') advertised.add(node.source_expand_handle)
      for (const ref of references) if (typeof ref.handle_id === 'string') advertised.add(ref.handle_id)
      const handles = new Map<string, ExplicitSourceTargetStoredHandle>()
      for (const id of advertised) {
        const handle = staged.get(id)
        if (!handle) throw new Error('Explicit target finalization advertised an unstaged handle')
        handles.set(id, handle)
      }
      const freshness = record(record(options.governance).graph_freshness)
      if (handles.size && (freshness.status !== 'fresh' || freshness.selected_context_status !== 'fresh')) {
        throw new Error('Explicit target recovery requires a fresh graph; refresh the index or increase the budget to receive complete source')
      }
      return { payload, handles }
    }
    const lostNavigation = missing.some(owner => generic.has(owner.nodeId))
    if (lostNavigation) {
      // The ordinary serializer prioritizes source over navigation. When that drops
      // a requested target, retry a complete navigation-only packet before failing.
      if (!nodes.length) break
      nodes = []
      for (const owner of owners) addReference(owner)
    } else {
      for (const owner of missing) addReference(owner)
      nodes = visible.filter(node => typeof node.node_id === 'string' && !generic.has(node.node_id))
    }
  }
  throw new ExplicitSourceTargetError('Explicit target budget cannot retain recovery for every requested owner; increase budget or request fewer targets')
}
