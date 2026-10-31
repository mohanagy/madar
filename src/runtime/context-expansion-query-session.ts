import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { isContextExpansionQueryGoal, type ContextExpansionQueryGoal,
  type ContextExpansionQueryRegistry } from './context-expansion-query.js'
import { isSourceContinuationHandle, sourceContinuationHandleId } from './source-continuation.js'

interface SourceRange { start_line: number; end_line: number }
export interface ContextExpansionSourceHandoff {
  source_expand_handle: string
  node_id: string
  source_file: string
  owner_range: SourceRange
  pending_ranges: SourceRange[]
  cursor_fingerprint: string
}

/** Advisory selection only. Never part of a public ID or a source cursor. */
export interface ContextExpansionQuerySelection {
  goal: ContextExpansionQueryGoal
  binding: string
  page_fingerprint: string
  source_fingerprints: Array<{ source_file: string; canonical_file: string; fingerprint: string }>
  /** Private class facts; the final published page determines order and retention. */
  primary_node_ids?: string[]
  source_handoff?: ContextExpansionSourceHandoff
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sourceRange(value: unknown): value is SourceRange {
  return record(value) && Number.isSafeInteger(value.start_line) && Number(value.start_line) > 0
    && Number.isSafeInteger(value.end_line) && Number(value.end_line) >= Number(value.start_line)
}

export function contextExpansionQueryFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
}

export function contextExpansionQuerySelection(value: unknown): ContextExpansionQuerySelection | undefined {
  if (!record(value) || typeof value.prompt !== 'string' || !record(value.query_selection)) return undefined
  const claim = value.query_selection
  if (!isContextExpansionQueryGoal(claim.goal, value.prompt) || typeof claim.binding !== 'string' || !claim.binding
    || typeof claim.page_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(claim.page_fingerprint)
    || !Array.isArray(claim.source_fingerprints) || !claim.source_fingerprints.length || claim.source_fingerprints.length > 16
    || claim.source_fingerprints.some(row => !record(row) || typeof row.source_file !== 'string' || !row.source_file
      || typeof row.canonical_file !== 'string' || !row.canonical_file
      || typeof row.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.fingerprint))
    || new Set(claim.source_fingerprints.map(row => (row as Record<string, unknown>).source_file)).size !== claim.source_fingerprints.length
    || claim.primary_node_ids !== undefined && (!Array.isArray(claim.primary_node_ids) || claim.primary_node_ids.length > 32
      || claim.primary_node_ids.some(id => typeof id !== 'string' || !id)
      || new Set(claim.primary_node_ids).size !== claim.primary_node_ids.length)) return undefined
  if (claim.source_handoff !== undefined) {
    const handoff = claim.source_handoff
    if (!record(handoff) || !['source_expand_handle', 'node_id', 'source_file'].every(key => typeof handoff[key] === 'string' && handoff[key])
      || typeof handoff.cursor_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(handoff.cursor_fingerprint)
      || !sourceRange(handoff.owner_range) || !Array.isArray(handoff.pending_ranges) || !handoff.pending_ranges.length
      || handoff.pending_ranges.length > 4096 || !handoff.pending_ranges.every(sourceRange)) return undefined
  }
  return claim as unknown as ContextExpansionQuerySelection
}

/** No reads or issuance: retain only the first partial primary on the final wire page. */
function publishedSourceHandoff(claim: ContextExpansionQuerySelection, pages: unknown[],
  handles: ReadonlyMap<string, unknown>): ContextExpansionSourceHandoff | undefined {
  const primary = new Set(claim.primary_node_ids ?? [])
  const nodes = pages.flatMap(page => Array.isArray(page) ? page.filter(record) : [])
  const node = nodes.find(node => typeof node.node_id === 'string' && primary.has(node.node_id)
    && (node.snippet_truncated === true || Array.isArray(node.snippet_omitted_ranges) && node.snippet_omitted_ranges.length > 0))
  if (!node || typeof node.source_expand_handle !== 'string' || typeof node.snippet !== 'string' || typeof node.source_file !== 'string'
    || node.snippet_unverified === true || node.snippet_source === 'derived'
    || nodes.filter(other => other.node_id === node.node_id).length !== 1
    || !sourceRange(node.snippet_line_range) || !Array.isArray(node.snippet_omitted_ranges)
    || !node.snippet_omitted_ranges.length || !node.snippet_omitted_ranges.every(sourceRange)) return undefined
  const cursor = handles.get(node.source_expand_handle)
  const omissions = node.snippet_omitted_ranges as SourceRange[]
  if (!isSourceContinuationHandle(cursor) || sourceContinuationHandleId(cursor) !== node.source_expand_handle
    || cursor.node_id !== node.node_id || cursor.label !== node.label
    || resolve(cursor.logical_root, cursor.source_file) !== resolve(cursor.logical_root, node.source_file)
    || cursor.scope !== node.snippet_scope || JSON.stringify(cursor.owner_range) !== JSON.stringify(node.snippet_line_range)
    || !claim.source_fingerprints.some(row => resolve(cursor.logical_root, row.source_file) === resolve(cursor.logical_root, cursor.source_file)
      && row.canonical_file === cursor.canonical_file)
    || !cursor.pending_ranges.every(range => omissions.some(gap =>
      range.start_line >= gap.start_line && range.end_line <= gap.end_line))) return undefined
  return { source_expand_handle: node.source_expand_handle, node_id: cursor.node_id, source_file: node.source_file,
    owner_range: { ...cursor.owner_range }, pending_ranges: cursor.pending_ranges.map(range => ({ ...range })),
    cursor_fingerprint: contextExpansionQueryFingerprint(cursor) }
}

/** Observe publication, not provisional allocation. Existing reference-only pages
 * do not issue a new claim. The registry outlives handle/cache eviction. */
export function publishContextExpansionQuerySelections(
  response: { result?: unknown; error?: unknown }, written: ReadonlyMap<string, unknown>,
  handles: Map<string, unknown>, registry: ContextExpansionQueryRegistry,
): void {
  if (response.error || !record(response.result) || response.result.isError === true
    || !Array.isArray(response.result.content)) return
  const advertised = new Set<string>(), pages: unknown[] = []
  const add = (entries: unknown, key: string): void => {
    if (Array.isArray(entries)) for (const entry of entries) {
      if (record(entry) && typeof entry[key] === 'string') advertised.add(entry[key])
    }
  }
  for (const item of response.result.content) {
    if (!record(item) || item.type !== 'text' || typeof item.text !== 'string') continue
    let payload: unknown
    try { payload = JSON.parse(item.text) } catch { continue }
    if (!record(payload)) continue
    add([payload], 'handle_id')
    add(payload.expandable, 'handle_id')
    if (record(payload.pack)) {
      add(payload.pack.expandable, 'handle_id')
      add(payload.pack.matched_nodes, 'source_expand_handle')
      pages.push(payload.pack.matched_nodes ?? [])
    }
    if (record(payload.evidence) && record(payload.evidence.answerability)) {
      add(payload.evidence.answerability.verification_targets, 'handle_id')
    }
  }
  for (const id of advertised) {
    if (!written.has(id)) continue
    const value = written.get(id)
    // Verification and caller-selected IDs also identify generic handles.
    // Classify the stored scope, not its public spelling; source cursors differ.
    if (!record(value) || typeof value.prompt !== 'string' || typeof value.task !== 'string'
      || typeof value.task_intent !== 'string' || !record(value.follow_up) || value.follow_up.kind !== 'context_pack') continue
    // Concurrent replacement/eviction cannot authorize an older private goal.
    if (handles.get(id) !== value) { registry.observe(id, 'unavailable-at-publication'); continue }
    const claim = contextExpansionQuerySelection(value)
    // Recompute rather than inherit a parent's cursor into a later child page.
    const { source_handoff: _priorHandoff, ...withoutHandoff } = claim ?? {}
    const handoff = claim ? publishedSourceHandoff(claim, pages, handles) : undefined
    const published = claim && record(value)
      ? { ...value, query_selection: { ...withoutHandoff, page_fingerprint: contextExpansionQueryFingerprint(pages),
        ...(handoff ? { source_handoff: handoff } : {}) } } : value
    if (published !== value) handles.set(id, published)
    const selected = contextExpansionQuerySelection(published)
    registry.observe(id, contextExpansionQueryFingerprint(published), selected?.goal, selected?.binding)
  }
}
