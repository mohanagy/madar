import { isAbsolute, resolve } from 'node:path'
import { relativizeSourceFile } from '../shared/source-path.js'
import { estimateQueryTokens } from './serve.js'
import { compactFreshness } from './source-evidence-response.js'

type RecordValue = Record<string, unknown>
type ToolResponse = { result?: unknown; error?: unknown }
const MAX_WIRE_CHARS = 1024 * 1024
const MAX_WIRE_NODES = 128

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Text equivalence is deliberately separate from owner/selection identity.
 * Only equal, self-consistent partial excerpts may share bytes across scopes. */
function partialSourceTextKey(node: RecordValue): string | undefined {
  if (typeof node.node_id !== 'string' || !node.node_id || typeof node.source_file !== 'string' || !node.source_file
    || typeof node.snippet !== 'string' || !node.snippet || Object.hasOwn(node, 'snippet_ref')
    || node.snippet_scope !== 'symbol' && node.snippet_scope !== 'source_file'
    || node.snippet_source !== undefined || node.representation_type !== undefined
    || node.snippet_unverified !== undefined && node.snippet_unverified !== false
    || node.snippet_file_complete !== undefined && node.snippet_file_complete !== false
    || node.snippet_truncated !== undefined && node.snippet_truncated !== true) return undefined
  const validRange = (value: unknown): value is { start_line: number; end_line: number } => record(value)
    && Object.keys(value).every(key => key === 'start_line' || key === 'end_line')
    && Number.isSafeInteger(value.start_line) && Number.isSafeInteger(value.end_line)
    && Number(value.start_line) > 0 && Number(value.end_line) >= Number(value.start_line)
  const range = node.snippet_line_range, omissions = node.snippet_omitted_ranges
  if (!validRange(range) || !Array.isArray(omissions) || !omissions.length || omissions.length > 4096) return undefined
  let end = range.start_line - 1
  for (const gap of omissions) {
    if (!validRange(gap) || gap.start_line <= end || gap.start_line < range.start_line || gap.end_line > range.end_line) return undefined
    end = gap.end_line
  }
  let cursor = range.start_line, gapIndex = 0, visible = 0
  for (const line of node.snippet.split('\n')) {
    const gap = omissions[gapIndex]
    if (gap?.start_line === cursor) {
      if (line !== `[omitted lines ${gap.start_line}-${gap.end_line}]`) return undefined
      cursor = gap.end_line + 1; gapIndex++
    } else {
      if (cursor > range.end_line || /^\[omitted lines \d+-\d+\]$/.test(line)) return undefined
      cursor++; visible++
    }
  }
  if (!visible || cursor !== range.end_line + 1 || gapIndex !== omissions.length) return undefined
  return JSON.stringify([node.source_file, range.start_line, range.end_line, node.snippet,
    omissions.map(gap => [gap.start_line, gap.end_line]),
    ['snippet_unverified', 'snippet_file_complete', 'snippet_truncated'].map(key => [Object.hasOwn(node, key), node[key]])])
}

function shareIdenticalPartialSource(nodes: unknown[]): boolean {
  const ids = nodes.map(node => record(node) ? node.node_id : undefined)
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return false
  const referenced = new Set(nodes.flatMap(node => record(node) && typeof node.snippet_ref === 'string' ? [node.snippet_ref] : []))
  const owners = new Map<string, string>()
  let changed = false
  for (const value of nodes) {
    if (!record(value)) continue
    const key = partialSourceTextKey(value)
    if (key === undefined) continue
    const owner = owners.get(key)
    if (!owner) { owners.set(key, String(value.node_id)); continue }
    // Earlier literal owners only: never create a reference chain or cycle.
    if (referenced.has(String(value.node_id))) continue
    delete value.snippet
    value.snippet_ref = owner
    changed = true
  }
  return changed
}

/** This operates only on the parsed wire clone, never stored source/handle data. */
function compactRecoveryMetadata(payload: RecordValue, sourceRoot?: string): boolean {
  let changed = false
  const root = typeof sourceRoot === 'string' && !sourceRoot.includes('\0')
    && isAbsolute(sourceRoot) && resolve(sourceRoot) === sourceRoot ? sourceRoot : undefined
  const displayPath = (value: unknown): unknown => {
    // Normalizing dot segments can change meaning through a symlink. Keep
    // unusual paths verbatim, including relative, outside-root and root paths.
    if (!root || typeof value !== 'string' || value.includes('\0') || !isAbsolute(value)
      || resolve(value) !== value || /^[\\/]{2}/.test(value)) return value
    const relative = relativizeSourceFile(value, root)
    if (relative === value || resolve(root, relative) !== value) return value
    changed = true
    return relative
  }
  const boundedArray = (value: unknown): unknown[] => Array.isArray(value) && value.length <= 4096 ? value : []
  const sourcePath = (value: unknown): void => {
    if (record(value) && Object.hasOwn(value, 'source_file')) value.source_file = displayPath(value.source_file)
  }
  const pack = record(payload.pack) ? payload.pack : {}
  for (const node of boundedArray(pack.matched_nodes)) sourcePath(node)
  const dependencies = record(pack.source_dependencies) ? pack.source_dependencies : {}
  for (const call of boundedArray(dependencies.unresolved)) sourcePath(call)
  for (const group of boundedArray(dependencies.unresolved_groups)) sourcePath(group)
  for (const entry of boundedArray(payload.expandable)) if (record(entry)) {
    if (Array.isArray(entry.focus_files) && entry.focus_files.length <= 128) entry.focus_files = entry.focus_files.map(displayPath)
    for (const range of boundedArray(entry.focus_ranges)) sourcePath(range)
  }

  const governance = record(payload.governance) ? payload.governance : undefined
  const freshness = governance && record(governance.graph_freshness) ? governance.graph_freshness : undefined
  if (freshness && typeof freshness.status === 'string' && typeof freshness.selected_context_status === 'string'
    && ['fresh', 'partially_stale', 'possibly_stale', 'stale', 'missing'].includes(freshness.status)
    && ['fresh', 'possibly_stale', 'stale', 'unknown'].includes(freshness.selected_context_status)) {
    const compact = compactFreshness(freshness)
    for (const [key, value] of Object.entries(freshness)) {
      if (Object.hasOwn(compact, key)) continue
      const ordinaryTelemetry = (['graph_path', 'madar_version'].includes(key) && typeof value === 'string')
        || (['graph_modified_at', 'generated_at'].includes(key) && (value === null || typeof value === 'string'))
        || (['graph_modified_ms', 'generated_ms'].includes(key) && (value === null || typeof value === 'number' && Number.isFinite(value)))
        || (['indexed_file_count', 'selected_context_file_count'].includes(key) && Number.isSafeInteger(value) && Number(value) >= 0)
      const zeroChange = ['changed_source_count', 'missing_source_count', 'changed_selected_context_count',
        'missing_selected_context_count', 'changed_outside_selected_context_count'].includes(key) && value === 0
      const defaultRecommendation = key === 'recommendation' && freshness.status === 'fresh'
        && freshness.selected_context_status === 'fresh' && value === 'Graph is fresh enough to rely on.'
      // Unknown warnings/reasons, non-default recommendations and malformed or
      // unknown counters retain their original values. This is not a new verdict.
      if (!ordinaryTelemetry && !zeroChange && !defaultRecommendation) compact[key] = value
    }
    if (Object.keys(freshness).some(key => !Object.hasOwn(compact, key))) {
      governance!.graph_freshness = compact
      changed = true
    }
  }
  return changed
}

/** Wire-only compaction, after all source allocation and handle commits.
 * An omitted duplicate position is recovered from snippet_line_range.start_line.
 * Recovery metadata projection changes neither page contents nor private handles.
 * Never feed this result back into selection, completion, or continuation fitting.
 */
export function compactDuplicateSourcePositions<T extends ToolResponse>(
  response: T, toolName: string | null, arguments_: RecordValue | null, sourceRoot?: string,
): T {
  if (toolName !== 'context_pack' && toolName !== 'context_expand'
    || arguments_?.verbose === true || arguments_?.format !== undefined && arguments_.format !== 'json'
    || response.error !== undefined || !record(response.result)) return response
  const result = response.result
  if (result.isError === true || Object.hasOwn(result, 'structuredContent')
    || !Array.isArray(result.content) || result.content.length !== 1) return response
  const content = result.content[0]
  if (!record(content) || content.type !== 'text' || typeof content.text !== 'string'
    || content.text.length > MAX_WIRE_CHARS) return response
  try {
    const payload: unknown = JSON.parse(content.text)
    if (!record(payload) || payload.response_format !== 'source_evidence_v2' || payload.verbose === true
      || !record(payload.pack) || !Array.isArray(payload.pack.matched_nodes)
      || payload.pack.matched_nodes.length > MAX_WIRE_NODES || !record(payload.serialized_budget)) return response
    const receipt = payload.serialized_budget
    if (Object.keys(receipt).some(key => !['max_tokens', 'token_count', 'enforced'].includes(key))
      || receipt.enforced !== true || !Number.isSafeInteger(receipt.max_tokens) || Number(receipt.max_tokens) < 128
      || !Number.isSafeInteger(receipt.token_count) || Number(receipt.token_count) <= 0
      || Number(receipt.token_count) > Number(receipt.max_tokens)
      || JSON.stringify(payload) !== content.text
      || estimateQueryTokens(content.text) !== receipt.token_count) return response
    const originalCount = Number(receipt.token_count)
    let changed = false
    for (const node of payload.pack.matched_nodes) {
      if (!record(node) || !Number.isSafeInteger(node.line_number) || Number(node.line_number) <= 0
        || !record(node.snippet_line_range)) continue
      const range = node.snippet_line_range
      if (Object.keys(range).some(key => key !== 'start_line' && key !== 'end_line')
        || !Number.isSafeInteger(range.start_line) || !Number.isSafeInteger(range.end_line)
        || Number(range.start_line) <= 0 || Number(range.end_line) < Number(range.start_line)
        || node.line_number !== range.start_line) continue
      delete node.line_number
      changed = true
    }
    changed = shareIdenticalPartialSource(payload.pack.matched_nodes) || changed
    if (toolName === 'context_expand') changed = compactRecoveryMetadata(payload, sourceRoot) || changed
    if (!changed) return response
    for (let attempt = 0; attempt < 12; attempt++) {
      const text = JSON.stringify(payload)
      const count = estimateQueryTokens(text)
      if (count === receipt.token_count) {
        if (count > originalCount || count > Number(receipt.max_tokens)) return response
        return { ...response, result: { ...result, content: [{ ...content, text }] } }
      }
      receipt.token_count = count
    }
  } catch {
    // Unsupported or unverifiable output keeps the exact accepted response.
  }
  return response
}
