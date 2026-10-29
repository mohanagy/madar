import { createHash } from 'node:crypto'
import { relative, resolve, sep } from 'node:path'
import { classifySourceDomain } from '../shared/source-discovery.js'
import { extractPromptExclusions } from './retrieval-gate.js'
import { compileSourceExclusions } from './source-exclusions.js'
import { readVerifiedSourceSnapshot } from './source-continuation.js'
import { resolveSourceSnippet } from './source-evidence-response.js'
import { sourceDeclarationKind, resolveSourceSymbolRange } from './retrieve/source-evidence.js'
import { sourceModuleConfigurationSnapshotIsFresh } from './retrieve/source-modules.js'
import type { SourceCoherentContinuationCatalog } from './retrieve/source-coherent-continuation.js'
import { estimateQueryTokens } from './serve.js'

type Value = Record<string, unknown>
type Range = { start_line: number; end_line: number }
type Snapshot = ReturnType<typeof readVerifiedSourceSnapshot>
type Fingerprint = { source_file: string; canonical: string; realRoot: string; hash: string; policyFingerprint: string }
type Pending = { owner_id: string; ranges: Range[] }
export interface SourceGroupContinuation {
  kind: 'source_group_continuation'
  version: 1
  prompt: string
  catalog: SourceCoherentContinuationCatalog
  fingerprints: Fingerprint[]
  pending: Pending[]
  evidence: Value
}
const object = (v: unknown): Value => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Value : {}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const local = (file: string, root: string): string => relative(resolve(root), resolve(root, file)).split(sep).join('/')
const fresh = (v: unknown): boolean => {
  const state = object(object(v).graph_freshness)
  return state.status === 'fresh' && state.selected_context_status === 'fresh'
}
function ranges(value: unknown, owner?: Range): value is Range[] {
  return Array.isArray(value) && value.length <= 4096 && value.every((r, i) => {
    const a = object(r)
    return Number.isSafeInteger(a.start_line) && Number.isSafeInteger(a.end_line)
      && Number(a.start_line) > 0 && Number(a.end_line) >= Number(a.start_line)
      && (!owner || Number(a.start_line) >= owner.start_line && Number(a.end_line) <= owner.end_line)
      && (!i || a.start_line as number > value[i - 1].end_line)
  })
}
function union(input: readonly Range[]): Range[] {
  const out: Range[] = []
  for (const r of [...input].sort((a, b) => a.start_line - b.start_line || a.end_line - b.end_line)) {
    const previous = out.at(-1)
    if (previous && r.start_line <= previous.end_line + 1) previous.end_line = Math.max(previous.end_line, r.end_line)
    else out.push({ ...r })
  }
  return out
}
function subtract(input: readonly Range[], gaps: readonly Range[]): Range[] {
  const out: Range[] = []
  for (const r of input) {
    let cursor = r.start_line
    for (const gap of gaps) {
      if (gap.end_line < cursor || gap.start_line > r.end_line) continue
      if (gap.start_line > cursor) out.push({ start_line: cursor, end_line: gap.start_line - 1 })
      cursor = Math.max(cursor, gap.end_line + 1)
    }
    if (cursor <= r.end_line) out.push({ start_line: cursor, end_line: r.end_line })
  }
  return out
}
function render(lines: readonly string[], owner: Range, retained: readonly Range[]): { snippet: string; omitted: Range[] } {
  const omitted = subtract([owner], retained)
  const pieces = [...retained.map(r => ({ ...r, omitted: false })), ...omitted.map(r => ({ ...r, omitted: true }))]
    .sort((a, b) => a.start_line - b.start_line)
  return { snippet: pieces.map(r => r.omitted ? `[omitted lines ${r.start_line}-${r.end_line}]`
    : lines.slice(r.start_line - 1, r.end_line).join('\n')).join('\n'), omitted }
}
function recount(payload: Value, budget: number): number {
  payload.serialized_budget = { max_tokens: budget, token_count: 0, enforced: true }
  for (let i = 0; i < 12; i++) {
    const count = estimateQueryTokens(JSON.stringify(payload))
    if (object(payload.serialized_budget).token_count === count) return count
    object(payload.serialized_budget).token_count = count
  }
  throw new Error('Source group token receipt did not stabilize')
}
export const sourceGroupHandleId = (handle: SourceGroupContinuation): string => `source-group:${hash(JSON.stringify(handle)).slice(0, 32)}`
export function isSourceGroupContinuation(value: unknown): value is SourceGroupContinuation {
  const h = object(value), c = object(h.catalog)
  return h.kind === 'source_group_continuation' && h.version === 1 && typeof h.prompt === 'string'
    && h.prompt.length <= 32768 && c.version === 1 && typeof c.root_path === 'string' && typeof c.real_root === 'string'
    && typeof c.bounded === 'boolean'
    && Array.isArray(c.owners) && c.owners.length > 0 && c.owners.length <= 32
    && Array.isArray(c.source_dependencies) && c.source_dependencies.length > 0 && c.source_dependencies.length <= 32
    && Array.isArray(h.fingerprints) && h.fingerprints.length === c.source_dependencies.length
    && Array.isArray(h.pending) && h.pending.length > 0 && h.pending.length <= 32
    && h.evidence !== null && typeof h.evidence === 'object' && !Array.isArray(h.evidence)
    && JSON.stringify(value).length <= 2 * 1024 * 1024
}

/** Authenticate exactly the catalog's original authorized spans. Omitted gaps
 * are never converted into authorization by this cursor. */
export function verifySourceGroupInputs(catalog: SourceCoherentContinuationCatalog, prompt: string, prior?: readonly Fingerprint[]) {
  const root = resolve(catalog.root_path), exclusions = extractPromptExclusions(prompt)
  const policy = compileSourceExclusions(exclusions.excludedTerms, exclusions.excludedPathHints, root)
  const allowed = (file: string, canonical?: string): boolean => policy.valid && [file, ...(canonical ? [canonical] : [])]
    .every(path => !policy.matchesPath(path, root) && !exclusions.excludedDomains.includes(classifySourceDomain(path, root) as never))
  const configurationFresh = (): boolean => sourceModuleConfigurationSnapshotIsFresh(catalog.configuration, root, allowed)
  if (!configurationFresh() || !catalog.source_dependencies.length || catalog.source_dependencies.length > 32
    || !catalog.owners.length || catalog.owners.length > 32) throw new Error('Source group configuration or scope cannot be verified; request a new context_pack')
  const files = new Map<string, Snapshot>(), fingerprints: Fingerprint[] = []
  let bytes = 0
  for (const dependency of catalog.source_dependencies) {
    if (typeof dependency.source_file !== 'string' || typeof dependency.canonical_file !== 'string'
      || !/^[a-f0-9]{64}$/.test(dependency.source_sha256)
      || !allowed(dependency.source_file)) throw new Error('Source group dependency scope is invalid')
    const key = resolve(root, dependency.source_file)
    if (files.has(key)) throw new Error('Source group dependency identity is duplicated')
    const source = readVerifiedSourceSnapshot(dependency.source_file, root)
    if (!allowed(dependency.source_file, source.canonical) || source.canonical !== dependency.canonical_file
      || source.realRoot !== catalog.real_root || hash(source.lines.join('\n')) !== dependency.source_sha256
      || (bytes += source.readBytes) > 1024 * 1024) throw new Error('Source group binding input changed or is excluded; request a new context_pack')
    files.set(key, source)
    fingerprints.push({ source_file: key, canonical: source.canonical, realRoot: source.realRoot,
      hash: source.hash, policyFingerprint: source.policyFingerprint })
  }
  if (prior && JSON.stringify(prior) !== JSON.stringify(fingerprints)) throw new Error('Source group source identity or policy changed; request a new context_pack')
  const ids = new Set<string>()
  for (const owner of catalog.owners) {
    const source = files.get(resolve(root, owner.source_file)), range = owner.owner_range
    if (!source || typeof owner.node_id !== 'string' || !owner.node_id || ids.has(owner.node_id)
      || typeof owner.label !== 'string' || !ranges([range]) || !ranges(owner.retained_ranges, range)
      || !owner.retained_ranges.length || range.end_line > source.lines.length
      || hash(source.lines.join('\n')) !== owner.source_sha256 || policy.matchesLabel(owner.label)
      || policy.matchesText(source.lines.slice(range.start_line - 1, range.end_line).join('\n'))
      || !sourceDeclarationKind(source.lines, { start: range.start_line, end: range.end_line }, owner.label, source.canonical)) {
      throw new Error('Source group owner could not be authenticated')
    }
    const current = resolveSourceSymbolRange(source.lines, { start: range.start_line, end: range.end_line }, owner.label, source.canonical)
    const rendered = render(source.lines, range, owner.retained_ranges)
    if (!current || current.start !== range.start_line || current.end !== range.end_line
      || rendered.snippet !== owner.snippet || JSON.stringify(rendered.omitted) !== JSON.stringify(owner.snippet_omitted_ranges)) {
      throw new Error('Source group owner range or source changed')
    }
    ids.add(owner.node_id)
  }
  if (!configurationFresh()) throw new Error('Source group configuration changed during verification')
  return { files, fingerprints, validate: (): void => { verifySourceGroupInputs(catalog, prompt, fingerprints) } }
}
function entry(handle: SourceGroupContinuation): Value {
  const ids = new Set(handle.pending.map(p => p.owner_id))
  return { handle_id: sourceGroupHandleId(handle), evidence_class: 'supporting', count: ids.size,
    symbols: handle.catalog.owners.filter(o => ids.has(o.node_id)).slice(0, 3).map(o => o.label) }
}
function sourceNode(owner: SourceCoherentContinuationCatalog['owners'][number], pending: readonly Range[], file: Snapshot, root: string): Value {
  const rendered = render(file.lines, owner.owner_range, pending)
  return { node_id: owner.node_id, label: owner.label, source_file: local(owner.source_file, root),
    snippet_scope: 'symbol', snippet_line_range: { ...owner.owner_range }, snippet: rendered.snippet,
    ...(rendered.omitted.length ? { snippet_omitted_ranges: rendered.omitted } : {}) }
}

/** Add one new cursor only into spare space; retain the entire accepted first
 * response and every existing generic/source recovery handle. */
export function attachSourceGroupContinuation(
  input: Value, catalog: SourceCoherentContinuationCatalog | undefined, prompt: string, budget: number,
  store: (id: string, handle: SourceGroupContinuation) => void, expectedRoot: string,
  prepareSiblingRecovery?: (payload: Value, identity: Pick<SourceGroupContinuation, 'catalog' | 'prompt' | 'fingerprints'>) => Value,
): Value {
  if (!catalog || resolve(catalog.root_path) !== resolve(expectedRoot)
    || input.response_format !== 'source_evidence_v2' || input.task !== 'explain'
    || input.mode === 'delta' || input.delta_session_id || input.verbose === true || !fresh(input.governance)
    || object(object(input.evidence).answerability).broad_search_fallback === 'blocked') return input
  try {
    const proof = verifySourceGroupInputs(catalog, prompt), nodes = object(input.pack).matched_nodes
    if (!Array.isArray(nodes) || nodes.length > 128) return input
    const covered = new Map<string, Range[]>()
    for (const value of nodes) {
      const n = object(value), file = typeof n.source_file === 'string' ? proof.files.get(resolve(catalog.root_path, n.source_file)) : undefined
      if (!file) continue
      const range = n.snippet_line_range as Range, omitted = n.snippet_omitted_ranges ?? []
      if (n.snippet_unverified === true || n.snippet_source === 'derived' || !ranges([range]) || !ranges(omitted, range)) return input
      const visible = subtract([range], omitted)
      if (range.end_line > file.lines.length || render(file.lines, range, visible).snippet !== resolveSourceSnippet(n, nodes)) return input
      covered.set(file.canonical, union([...(covered.get(file.canonical) ?? []), ...visible]))
    }
    const pending: Pending[] = []
    for (const owner of catalog.owners) {
      const file = proof.files.get(resolve(catalog.root_path, owner.source_file))!
      const missing = subtract(owner.retained_ranges, covered.get(file.canonical) ?? [])
      if (missing.length) pending.push({ owner_id: owner.node_id, ranges: missing })
      covered.set(file.canonical, union([...(covered.get(file.canonical) ?? []), ...missing]))
    }
    if (!pending.length) return input
    const baseline = prepareSiblingRecovery?.(input, { catalog, prompt, fingerprints: proof.fingerprints }) ?? input
    const baselineNodes = object(baseline.pack).matched_nodes
    if (!Array.isArray(baselineNodes)) return input
    const evidence = clone(object(baseline.evidence)), answer = object(evidence.answerability)
    evidence.answerability = { ...answer, state: 'insufficient', answer_scope: 'partial', advisory: true,
      caveats: [...new Set([...(Array.isArray(answer.caveats) ? answer.caveats : []),
        'This cursor covers a bounded static source group, not whole-task completeness.'])] }
    const handle: SourceGroupContinuation = { kind: 'source_group_continuation', version: 1, prompt,
      catalog: clone(catalog), fingerprints: proof.fingerprints, pending, evidence }
    if (!isSourceGroupContinuation(handle)) return input
    const added: Value[] = [], originalIds = new Set(nodes.map(n => object(n).node_id))
    const initial = (cursor: SourceGroupContinuation, additions: readonly Value[]): Value => {
      const payload = clone(baseline)
      object(payload.pack).matched_nodes = [...clone(baselineNodes), ...clone(additions)]
      payload.expandable = [...(cursor.pending.length ? [entry(cursor)] : []),
        ...(Array.isArray(baseline.expandable) ? clone(baseline.expandable) : [])]
      recount(payload, budget)
      return payload
    }
    let accepted = handle, result = initial(handle, added)
    if (Number(object(result.serialized_budget).token_count) > budget) return input
    // Spend only unused first-response space on complete pending units. Earlier
    // source, identities and recovery scopes stay untouched; a large unit may
    // remain for the next page while a later small unit fits this one.
    for (const p of pending) {
      if (originalIds.has(p.owner_id)) continue
      const owner = catalog.owners.find(o => o.node_id === p.owner_id)!
      const file = proof.files.get(resolve(catalog.root_path, owner.source_file))!
      const node = sourceNode(owner, p.ranges, file, catalog.root_path)
      const next = { ...accepted, pending: accepted.pending.filter(value => value.owner_id !== p.owner_id) }
      const trial = initial(next, [...added, node])
      if (Number(object(trial.serialized_budget).token_count) > budget) continue
      added.push(node); accepted = next; result = trial
    }
    proof.validate()
    if (accepted.pending.length) store(sourceGroupHandleId(accepted), accepted)
    return result
  } catch { return input }
}

/** A group owns its bounded pending ranges. Never pass these pages through
 * single-owner preparation, which would authorize the owner's other omissions. */
export function expandSourceGroupContinuation(
  handle: SourceGroupContinuation, handleId: string, budget: number, rootPath: string, governance: unknown,
): { payload: Value; child?: { id: string; handle: SourceGroupContinuation } } {
  if (!isSourceGroupContinuation(handle) || sourceGroupHandleId(handle) !== handleId || resolve(rootPath) !== resolve(handle.catalog.root_path)
    || !Number.isSafeInteger(budget) || budget < 128 || !fresh(governance)
    || object(handle.evidence.answerability).broad_search_fallback === 'blocked') throw new Error('Source group cursor is invalid, stale or blocked; request a new context_pack')
  const proof = verifySourceGroupInputs(handle.catalog, handle.prompt, handle.fingerprints)
  const ownerById = new Map(handle.catalog.owners.map(o => [o.node_id, o]))
  const seen = new Set<string>(), allocated = new Map<string, Range[]>()
  for (const p of handle.pending) {
    const owner = ownerById.get(p.owner_id)
    if (!owner || seen.has(p.owner_id) || !ranges(p.ranges, owner.owner_range) || !p.ranges.length
      || subtract(p.ranges, owner.retained_ranges).length) throw new Error('Source group pending scope is invalid')
    const file = proof.files.get(resolve(rootPath, owner.source_file))!
    const prior = allocated.get(file.canonical) ?? []
    if (JSON.stringify(subtract(p.ranges, prior)) !== JSON.stringify(p.ranges)) throw new Error('Source group pending ranges overlap')
    allocated.set(file.canonical, union([...prior, ...p.ranges])); seen.add(p.owner_id)
  }
  const build = (count: number) => {
    const selected = handle.pending.slice(0, count), remaining = handle.pending.slice(count)
    const childHandle = remaining.length ? { ...clone(handle), pending: clone(remaining) } : undefined
    const nodes = selected.map(p => {
      const owner = ownerById.get(p.owner_id)!, file = proof.files.get(resolve(rootPath, owner.source_file))!
      return sourceNode(owner, p.ranges, file, rootPath)
    })
    const lineCount = (values: Pending[]) => values.reduce((n, p) => n + p.ranges.reduce((s, r) => s + r.end_line - r.start_line + 1, 0), 0)
    const payload: Value = { task: 'explain', response_format: 'source_evidence_v2',
      pack: { selection_scope: 'task_context', matched_nodes: nodes, relationships: [] },
      evidence: clone(handle.evidence), governance: clone(governance),
      source_group_continuation: { delivered_lines: lineCount(selected), remaining_lines: lineCount(remaining) },
      ...(childHandle ? { expandable: [entry(childHandle)] } : {}) }
    recount(payload, budget)
    return { payload, ...(childHandle ? { child: { id: sourceGroupHandleId(childHandle), handle: childHandle } } : {}) }
  }
  const whole = build(handle.pending.length)
  let result: ReturnType<typeof build> | undefined = Number(object(whole.payload.serialized_budget).token_count) <= budget ? whole : undefined
  if (!result) for (let count = 1; count < handle.pending.length; count++) {
    const trial = build(count)
    // Child previews change with the pending suffix, so wire cost need not be
    // monotone. Check every bounded prefix without changing discovery order.
    if (Number(object(trial.payload.serialized_budget).token_count) <= budget) result = trial
  }
  proof.validate()
  if (result) return result
  // Do not advance or publish a new cursor when no complete pending owner fits.
  const payload: Value = { source_group_continuation_status: 'budget_insufficient',
    evidence: { answerability: { state: 'insufficient', answer_scope: 'partial', advisory: true } },
    limitations: { pending_source: 'unchanged; retry the same handle with a larger budget or use focused source',
      prior_evidence_obligations: 'retained_in_handle; not_reassessed' } }
  if (recount(payload, budget) > budget) throw new Error('Source group budget cannot carry its required status')
  return { payload }
}
