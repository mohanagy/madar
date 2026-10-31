import { createHash } from 'node:crypto'
import { isContextExpansionQueryGoal, type ContextExpansionQueryGoal,
  type ContextExpansionQueryRegistry } from './context-expansion-query.js'

/** Advisory selection only. Never part of a public ID or a source cursor. */
export interface ContextExpansionQuerySelection {
  goal: ContextExpansionQueryGoal
  binding: string
  page_fingerprint: string
  source_fingerprints: Array<{ source_file: string; canonical_file: string; fingerprint: string }>
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
    || new Set(claim.source_fingerprints.map(row => (row as Record<string, unknown>).source_file)).size !== claim.source_fingerprints.length) return undefined
  return claim as unknown as ContextExpansionQuerySelection
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
    const published = claim && record(value)
      ? { ...value, query_selection: { ...claim, page_fingerprint: contextExpansionQueryFingerprint(pages) } } : value
    if (published !== value) handles.set(id, published)
    const selected = contextExpansionQuerySelection(published)
    registry.observe(id, contextExpansionQueryFingerprint(published), selected?.goal, selected?.binding)
  }
}
