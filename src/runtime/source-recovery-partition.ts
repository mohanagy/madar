import { resolve } from 'node:path'
import { classifySourceDomain } from '../shared/source-discovery.js'
import { extractPromptExclusions } from './retrieval-gate.js'
import { compileSourceExclusions } from './source-exclusions.js'
import { isSourceContinuationHandle, sourceContinuationHandleId, type SourceContinuationHandle } from './source-continuation.js'
import { resolveSourceSnippet } from './source-evidence-response.js'
import { verifySourceGroupInputs, type SourceGroupContinuation } from './source-group-continuation.js'
import { sourcePathForEvidence } from './retrieve/source-evidence.js'
import { estimateQueryTokens } from './serve.js'

type Value = Record<string, unknown>
export type SourceRecoveryRange = { start_line: number; end_line: number }
type GroupIdentity = Pick<SourceGroupContinuation, 'prompt' | 'catalog' | 'fingerprints'>
/** Immutable ownership, not a ledger of delivered source. Pending pages never
 * narrow it: initial context and group recovery jointly own these exact spans. */
export type SourceRecoveryPartition = Readonly<{ version: 1 } & GroupIdentity>
export type PartitionedSourceContinuation = SourceContinuationHandle & { source_recovery_partition: SourceRecoveryPartition }
const object = (v: unknown): Value => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Value : {}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function validRanges(value: unknown, owner?: SourceRecoveryRange): value is SourceRecoveryRange[] {
  return Array.isArray(value) && value.length <= 4096 && value.every((entry, index) => {
    const r = object(entry)
    return Object.keys(r).every(key => key === 'start_line' || key === 'end_line')
      && Number.isSafeInteger(r.start_line) && Number.isSafeInteger(r.end_line)
      && Number(r.start_line) > 0 && Number(r.end_line) >= Number(r.start_line)
      && (!owner || Number(r.start_line) >= owner.start_line && Number(r.end_line) <= owner.end_line)
      && (!index || Number(r.start_line) > value[index - 1].end_line)
  })
}
function union(input: readonly SourceRecoveryRange[]): SourceRecoveryRange[] {
  const result: SourceRecoveryRange[] = []
  for (const range of [...input].sort((a, b) => a.start_line - b.start_line || a.end_line - b.end_line)) {
    const previous = result.at(-1)
    if (previous && range.start_line <= previous.end_line + 1) previous.end_line = Math.max(previous.end_line, range.end_line)
    else result.push({ ...range })
  }
  return result
}
/** Inputs must be ordered, disjoint positive ranges; no owner scope is inferred. */
export function subtractSourceRecoveryRanges(input: readonly SourceRecoveryRange[], gaps: readonly SourceRecoveryRange[]): SourceRecoveryRange[] {
  if (!validRanges(input) || !validRanges(gaps)) throw new Error('Invalid source recovery ranges')
  const result: SourceRecoveryRange[] = []
  for (const range of input) {
    let cursor = range.start_line
    for (const gap of gaps) {
      if (gap.end_line < cursor || gap.start_line > range.end_line) continue
      if (gap.start_line > cursor) result.push({ start_line: cursor, end_line: gap.start_line - 1 })
      cursor = Math.max(cursor, gap.end_line + 1)
    }
    if (cursor <= range.end_line) result.push({ start_line: cursor, end_line: range.end_line })
  }
  return result
}
function render(lines: readonly string[], owner: SourceRecoveryRange, retained: readonly SourceRecoveryRange[]) {
  const omitted = subtractSourceRecoveryRanges([owner], retained)
  const parts = [...retained.map(r => ({ ...r, omitted: false })), ...omitted.map(r => ({ ...r, omitted: true }))]
    .sort((a, b) => a.start_line - b.start_line)
  return { omitted, snippet: parts.map(r => r.omitted ? `[omitted lines ${r.start_line}-${r.end_line}]`
    : lines.slice(r.start_line - 1, r.end_line).join('\n')).join('\n') }
}
function shape(value: unknown): value is SourceRecoveryPartition {
  const p = object(value), c = object(p.catalog)
  return p.version === 1 && Object.keys(p).every(key => ['version', 'prompt', 'catalog', 'fingerprints'].includes(key))
    && typeof p.prompt === 'string' && p.prompt.length <= 32768 && c.version === 1
    && typeof c.root_path === 'string' && typeof c.real_root === 'string' && typeof c.bounded === 'boolean'
    && Array.isArray(c.owners) && c.owners.length > 0 && c.owners.length <= 32
    && Array.isArray(c.source_dependencies) && c.source_dependencies.length > 0 && c.source_dependencies.length <= 32
    && Array.isArray(p.fingerprints) && p.fingerprints.length === c.source_dependencies.length
    && JSON.stringify(value).length <= 2 * 1024 * 1024
}

export function verifySourceRecoveryPartition(partition: SourceRecoveryPartition, expectedRoot: string) {
  if (!shape(partition) || resolve(partition.catalog.root_path) !== resolve(expectedRoot)) {
    throw new Error('Source recovery partition identity is invalid; request a new context_pack')
  }
  const proof = verifySourceGroupInputs(partition.catalog, partition.prompt, partition.fingerprints)
  const reserved = new Map<string, SourceRecoveryRange[]>()
  for (const owner of partition.catalog.owners) {
    const file = proof.files.get(resolve(expectedRoot, owner.source_file))!
    reserved.set(file.canonical, union([...(reserved.get(file.canonical) ?? []), ...owner.retained_ranges]))
  }
  return { files: proof.files, fingerprints: proof.fingerprints, reserved: reserved as ReadonlyMap<string, readonly SourceRecoveryRange[]>,
    validate: proof.validate }
}

export function createSourceRecoveryPartition(identity: GroupIdentity, expectedRoot: string): SourceRecoveryPartition {
  const partition: SourceRecoveryPartition = clone({ version: 1, prompt: identity.prompt, catalog: identity.catalog,
    fingerprints: identity.fingerprints })
  const proof = verifySourceRecoveryPartition(partition, expectedRoot)
  proof.validate()
  return freeze(partition)
}

/** Metadata is part of the returned handle's JSON and therefore its content ID.
 * Callers must reissue the ID after this operation, even when pending is unchanged. */
export function restrictSourceRecoveryContinuation(
  handle: SourceContinuationHandle, partition: SourceRecoveryPartition, expectedRoot: string,
): PartitionedSourceContinuation | undefined {
  const proof = verifySourceRecoveryPartition(partition, expectedRoot)
  const existing = object(handle).source_recovery_partition
  if (!isSourceContinuationHandle(handle) || resolve(handle.logical_root) !== resolve(expectedRoot)
    || handle.real_root !== partition.catalog.real_root || existing !== undefined && !same(existing, partition)) {
    throw new Error('Source recovery cursor scope is invalid; request a new context_pack')
  }
  const reserved = proof.reserved.get(handle.canonical_file) ?? []
  if (reserved.length) {
    const source = [...proof.files.values()].find(file => file.canonical === handle.canonical_file)
    const canonical = sourcePathForEvidence(handle.source_file, expectedRoot)
    if (!source || canonical !== handle.canonical_file || source.hash !== handle.file_sha256
      || source.realRoot !== handle.real_root) throw new Error('Source recovery cursor source changed; request a new context_pack')
  }
  const pending = subtractSourceRecoveryRanges(handle.pending_ranges, reserved)
  proof.validate()
  return pending.length ? { ...clone(handle), pending_ranges: pending, source_recovery_partition: partition } : undefined
}

function recount(payload: Value, budget: number): void {
  payload.serialized_budget = { max_tokens: budget, token_count: 0, enforced: true }
  for (let index = 0; index < 12; index++) {
    const count = estimateQueryTokens(JSON.stringify(payload))
    if (object(payload.serialized_budget).token_count === count) {
      if (count > budget) throw new Error('Filtered source and recovery exceed output budget')
      return
    }
    object(payload.serialized_budget).token_count = count
  }
  throw new Error('Source recovery token receipt did not stabilize')
}

/** Run only after ordinary source completion and child-handle narrowing. This
 * function never publishes handles or falls back to the unfiltered response. */
export function filterSourceRecoveryResponse(
  input: Value, partition: SourceRecoveryPartition, budget: number,
  options: { expectedRoot: string; lookupSourceHandle: (id: string) => SourceContinuationHandle | undefined },
): { payload: Value; changed_node_ids: string[]; removed_node_ids: string[]; validate: () => void } {
  if (!Number.isSafeInteger(budget) || budget < 128) throw new Error('Source recovery response budget is invalid')
  const proof = verifySourceRecoveryPartition(partition, options.expectedRoot)
  const minimalEvidence = object(input.evidence), minimalAnswer = object(minimalEvidence.answerability)
  // The ordinary source cursor's tiny-budget refusal carries no source, child
  // pointer or advancement. Preserve that exact supported envelope after proof
  // revalidation; arbitrary missing/blocked payloads do not receive this path.
  if (input.source_continuation_status === 'budget_insufficient'
    && !Object.hasOwn(input, 'pack') && !Object.hasOwn(input, 'response_format')
    && Object.keys(input).every(key => ['source_continuation_status', 'evidence', 'limitations', 'serialized_budget'].includes(key))
    && Object.keys(minimalEvidence).length === 1 && Object.hasOwn(minimalEvidence, 'answerability')
    && minimalAnswer.state === 'insufficient' && minimalAnswer.advisory === true && minimalAnswer.broad_search_fallback === 'allowed'
    && (minimalAnswer.answer_scope === undefined || minimalAnswer.answer_scope === 'partial')
    && Object.keys(minimalAnswer).every(key => ['state', 'advisory', 'answer_scope', 'broad_search_fallback'].includes(key))
    && same(input.limitations, { graph: 'fresh', source: 'fresh', prior_evidence_obligations: 'retained_in_handle; not_reassessed' })) {
    const payload = clone(input)
    recount(payload, budget); proof.validate()
    return { payload, changed_node_ids: [], removed_node_ids: [], validate: proof.validate }
  }
  if (input.response_format !== 'source_evidence_v2' || minimalAnswer.broad_search_fallback === 'blocked') {
    throw new Error('Source recovery response is unsupported or blocked')
  }
  const nodes = object(input.pack).matched_nodes
  if (!Array.isArray(nodes) || nodes.length > 128 || nodes.some(n => typeof object(n).node_id !== 'string')
    || new Set(nodes.map(n => object(n).node_id)).size !== nodes.length) throw new Error('Source recovery response owners are invalid')
  const exclusions = extractPromptExclusions(partition.prompt)
  const policy = compileSourceExclusions(exclusions.excludedTerms, exclusions.excludedPathHints, options.expectedRoot)
  const permitted = (file: string): boolean => policy.valid && !policy.matchesPath(file, options.expectedRoot)
    && !exclusions.excludedDomains.includes(classifySourceDomain(file, options.expectedRoot) as never)
  const byCanonical = new Map([...proof.files.values()].map(file => [file.canonical, file]))
  const originals = nodes.map(object), results: Value[] = [], changed = new Set<string>(), removed = new Set<string>()
  const resolvedSnippets = new Map<string, string>(), withheld = new Map<string, SourceRecoveryRange[]>()
  const emitted = new Map<string, SourceRecoveryRange[]>(), children = new Map<string, PartitionedSourceContinuation>()
  const inherited = object(input.source_recovery)
  if (Object.keys(inherited).length) throw new Error('Source recovery response was already partitioned')
  for (const original of originals) {
    const node = clone(original), id = String(node.node_id)
    if (typeof node.source_file !== 'string' || !permitted(node.source_file)) throw new Error('Source recovery file scope is invalid')
    const canonical = sourcePathForEvidence(node.source_file, options.expectedRoot)
    if (!canonical || !permitted(canonical)) throw new Error('Source recovery file identity is unavailable')
    const reserved = proof.reserved.get(canonical)
    if (!reserved?.length) { results.push(node); continue }
    const source = byCanonical.get(canonical), range = node.snippet_line_range as SourceRecoveryRange
    const gaps = node.snippet_omitted_ranges ?? []
    if (!source || !validRanges([range]) || !validRanges(gaps, range) || range.end_line > source.lines.length
      || node.snippet_unverified === true || node.snippet_source === 'derived'
      || typeof node.label !== 'string' || policy.matchesLabel(node.label)
      || policy.matchesText(source.lines.slice(range.start_line - 1, range.end_line).join('\n'))) throw new Error('Source recovery excerpt cannot be verified')
    const visible = subtractSourceRecoveryRanges([range], gaps)
    const text = resolveSourceSnippet(original, originals)
    if (text === null || render(source.lines, range, visible).snippet !== text) throw new Error('Source recovery excerpt does not match current source')
    resolvedSnippets.set(id, text)
    const retained = subtractSourceRecoveryRanges(visible, reserved)
    const hidden = subtractSourceRecoveryRanges(visible, retained)
    let child: PartitionedSourceContinuation | undefined
    if (node.source_expand_handle !== undefined) {
      const handle = typeof node.source_expand_handle === 'string' ? options.lookupSourceHandle(node.source_expand_handle) : undefined
      if (!isSourceContinuationHandle(handle) || sourceContinuationHandleId(handle) !== node.source_expand_handle
        || handle.node_id !== id || handle.label !== node.label || handle.scope !== node.snippet_scope
        || resolve(handle.logical_root) !== resolve(options.expectedRoot) || handle.real_root !== source.realRoot
        || handle.canonical_file !== canonical || handle.file_sha256 !== source.hash
        || sourcePathForEvidence(handle.source_file, options.expectedRoot) !== canonical
        || !same(handle.owner_range, range) || !same(object(handle).source_recovery_partition, partition)
        || subtractSourceRecoveryRanges(handle.pending_ranges, gaps).length
        || !same(subtractSourceRecoveryRanges(handle.pending_ranges, reserved), handle.pending_ranges)) {
        throw new Error('Source recovery child is not the narrowed authenticated cursor')
      }
      child = handle as PartitionedSourceContinuation
      children.set(node.source_expand_handle as string, child)
    }
    emitted.set(canonical, union([...(emitted.get(canonical) ?? []), ...retained]))
    if (!hidden.length) { results.push(node); continue }
    changed.add(id)
    withheld.set(canonical, union([...(withheld.get(canonical) ?? []), ...hidden]))
    if (!retained.length && !child) { removed.add(id); continue }
    const rendered = render(source.lines, range, retained)
    node.snippet = rendered.snippet
    node.snippet_omitted_ranges = rendered.omitted
    node.snippet_truncated = true
    delete node.snippet_ref
    // An empty excerpt deliberately retains a nonempty narrowed source child.
    // Its omitted owner gaps do not become new recovery authority.
    results.push(node)
  }
  // A changed supplier may no longer support an unchanged reference's range.
  // Materialize only those dependents, using their already verified exact text.
  const dependsOnChanged = (node: Value, seen = new Set<string>()): boolean => {
    if (typeof node.snippet_ref !== 'string') return false
    if (changed.has(node.snippet_ref)) return true
    if (seen.has(node.snippet_ref)) throw new Error('Source recovery reference cycle')
    const supplier = originals.find(n => n.node_id === node.snippet_ref)
    if (!supplier) throw new Error('Source recovery reference supplier is absent')
    return dependsOnChanged(supplier, new Set([...seen, node.snippet_ref]))
  }
  for (const node of results) if (dependsOnChanged(node)) {
    const text = resolvedSnippets.get(String(node.node_id))
    if (text === undefined) throw new Error('Source recovery reference could not be materialized')
    node.snippet = text; delete node.snippet_ref
  }
  const payload = clone(input), pack = object(payload.pack)
  pack.matched_nodes = results
  if (Array.isArray(pack.relationships)) pack.relationships = pack.relationships.filter(value => {
    const edge = object(value)
    // A changed caller has no remaining-site proof in this presentation pass.
    // Do not retain an edge whose supporting occurrence may have been withheld.
    return !changed.has(String(edge.from_id ?? edge.from)) && !removed.has(String(edge.to_id ?? edge.to))
  })
  const countLines = (ranges: readonly SourceRecoveryRange[]): number => ranges.reduce((n, r) => n + r.end_line - r.start_line + 1, 0)
  const hiddenLines = [...withheld.values()].reduce((n, ranges) => n + countLines(ranges), 0)
  if (hiddenLines) {
    payload.source_recovery = { withheld_lines: hiddenLines, reason: 'owned_by_original_context_pack_or_group' }
    const evidence = object(payload.evidence), answer = object(evidence.answerability)
    evidence.answerability = { ...answer, state: 'insufficient', answer_scope: 'partial', advisory: true,
      caveats: [...new Set([...(Array.isArray(answer.caveats) ? answer.caveats : []),
        'Some source ranges belong to the original context pack or its source-group cursor; this response does not assert they were already delivered.'])] }
    payload.evidence = evidence
    if (Object.hasOwn(payload, 'source_continuation')) {
      if (children.size > 1) throw new Error('Source continuation response has ambiguous children')
      payload.source_continuation = { ...object(payload.source_continuation),
        delivered_lines: [...emitted.values()].reduce((n, ranges) => n + countLines(ranges), 0),
        remaining_lines: [...children.values()].reduce((n, handle) => n + countLines(handle.pending_ranges), 0) }
    }
  }
  recount(payload, budget)
  proof.validate()
  return { payload, changed_node_ids: [...changed], removed_node_ids: [...removed], validate: proof.validate }
}
