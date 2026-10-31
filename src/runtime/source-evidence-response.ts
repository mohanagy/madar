import { sourcePathsAllowedByCurrentPolicy } from '../shared/source-access.js'
import { estimateQueryTokens } from './serve.js'
import { completeSourceFileCandidates } from './source-read-context.js'
import { completeRequestedSymbolCandidates } from './source-symbol-completion.js'
import { sourceContainerBudgetPreference, sourceDisconnectedBudgetPreference } from './source-container-budget.js'
import { applySourceLexicalCaution } from './source-lexical-context.js'

type RecordValue = Record<string, unknown>
export const MIN_SOURCE_EVIDENCE_BUDGET = 128
export const SOURCE_EVIDENCE_RESPONSE_FORMAT = 'source_evidence_v2'

function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function pick(value: unknown, keys: readonly string[]): RecordValue {
  const input = record(value)
  return Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]]))
}
function clone(value: object): RecordValue { return JSON.parse(JSON.stringify(value)) as RecordValue }
function unique(values: readonly unknown[]): unknown[] {
  return [...new Map(values.map(value => [JSON.stringify(value), value])).values()]
}
function omitEmptyFields(value: RecordValue): void {
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry) && entry.length === 0) delete value[key]
  }
}

/** Evidence identity includes representation but is independent of graph ranking. */
export function sourceSpanIdentity(node: RecordValue): string {
  return JSON.stringify([node.source_file, node.snippet_line_range ?? node.snippet_line_number ?? node.line_number,
    node.snippet, node.snippet_omitted_ranges ?? [], node.snippet_scope, node.snippet_source ?? null,
    node.representation_type ?? null])
}

const NODE_FIELDS = ['node_id', 'label', 'source_file', 'line_number', 'snippet', 'snippet_line_number',
  'snippet_line_range', 'snippet_omitted_ranges', 'snippet_unverified', 'snippet_source', 'snippet_scope', 'snippet_truncated', 'snippet_ref', 'snippet_file_complete', 'node_kind', 'representation_type']
function completeRange(node: RecordValue): { start_line: number; end_line: number } | null {
  const range = record(node.snippet_line_range)
  if (node.snippet_source === 'derived' || node.snippet_truncated === true || node.snippet_unverified === true || array(node.snippet_omitted_ranges).length > 0) return null
  if (!Number.isInteger(range.start_line) || !Number.isInteger(range.end_line)
    || Number(range.start_line) < 1 || Number(range.end_line) < Number(range.start_line)) return null
  return { start_line: Number(range.start_line), end_line: Number(range.end_line) }
}

function literalReferenceNode(node: RecordValue): boolean {
  return typeof node.source_file === 'string' && node.source_file.length > 0
    && (node.snippet_scope === 'symbol' || node.snippet_scope === 'source_file')
    && node.snippet_source === undefined && node.representation_type === undefined
    && (node.snippet_unverified === undefined || node.snippet_unverified === false)
    && (node.snippet_truncated === undefined || typeof node.snippet_truncated === 'boolean')
}

function containedSourceText(node: RecordValue, owner: RecordValue, source: string): string | null {
  const targetRange = completeRange(node), ownerRange = record(owner.snippet_line_range)
  if (node.source_file !== owner.source_file || !targetRange
    || owner.snippet_source === 'derived' || owner.snippet_unverified === true
    || !Number.isSafeInteger(ownerRange.start_line) || !Number.isSafeInteger(ownerRange.end_line)
    || Number(ownerRange.start_line) < 1 || Number(ownerRange.end_line) < Number(ownerRange.start_line)
    || targetRange.start_line < Number(ownerRange.start_line) || targetRange.end_line > Number(ownerRange.end_line)) return null
  const lines = source.split('\n')
  if (completeRange(owner)) {
    const start = targetRange.start_line - Number(ownerRange.start_line)
    const end = targetRange.end_line - Number(ownerRange.start_line) + 1
    return end <= lines.length ? lines.slice(start, end).join('\n') : null
  }
  // A partial supplier may contain a complete child. Interpret every explicit
  // omission before projecting; unknown truncation or a child crossing a gap
  // cannot supply source, even when the surrounding lines happen to match.
  if (!literalReferenceNode(node) || !literalReferenceNode(owner)
    || !Array.isArray(owner.snippet_omitted_ranges) || !owner.snippet_omitted_ranges.length
    || owner.snippet_omitted_ranges.length > 4096 || owner.snippet_truncated === false) return null
  let cursor = Number(ownerRange.start_line), offset = 0, projected: string | null = null
  const retain = (end: number): void => {
    if (targetRange.start_line >= cursor && targetRange.end_line <= end) {
      projected = lines.slice(offset + targetRange.start_line - cursor, offset + targetRange.end_line - cursor + 1).join('\n')
    }
    offset += end - cursor + 1
  }
  for (const value of owner.snippet_omitted_ranges) {
    const gap = record(value)
    if (!Number.isSafeInteger(gap.start_line) || !Number.isSafeInteger(gap.end_line)
      || Number(gap.start_line) < cursor || Number(gap.end_line) < Number(gap.start_line)
      || Number(gap.end_line) > Number(ownerRange.end_line)) return null
    retain(Number(gap.start_line) - 1)
    if (lines[offset++] !== `[omitted lines ${gap.start_line}-${gap.end_line}]`) return null
    cursor = Number(gap.end_line) + 1
  }
  retain(Number(ownerRange.end_line))
  return offset === lines.length ? projected : null
}

/** Resolve exactly the referenced subrange; never attribute the owner's whole body to a child symbol. */
export function resolveSourceSnippet(node: RecordValue, nodes: readonly RecordValue[], visiting = new Set<string>()): string | null {
  if (typeof node.snippet === 'string') return node.snippet
  if (typeof node.snippet_ref !== 'string' || visiting.has(node.snippet_ref)) return null
  const owner = nodes.find(value => value.node_id === node.snippet_ref)
  if (!owner || node.source_file !== owner.source_file) return null
  const source = resolveSourceSnippet(owner, nodes, new Set([...visiting, node.snippet_ref]))
  if (source === null) return null
  // Exact-span refs also support legacy range-less evidence; containment always has ranges.
  if (JSON.stringify(node.snippet_line_range ?? null) === JSON.stringify(owner.snippet_line_range ?? null)) return source
  return containedSourceText(node, owner, source)
}

function compactNodes(values: unknown[]): RecordValue[] {
  const nodes = values.map((value, index) => {
    const node = pick(value, NODE_FIELDS)
    if (typeof node.node_id !== 'string') node.node_id = `source-${index + 1}`
    if (node.snippet_truncated === false) delete node.snippet_truncated
    if (node.snippet_line_number === record(node.snippet_line_range).start_line) delete node.snippet_line_number
    return node
  })
  const originals = nodes.map(node => ({ ...node }))
  for (const [index, node] of nodes.entries()) {
    if (typeof node.snippet !== 'string' || node.snippet.length === 0) continue
    const candidates = originals.map((owner, ownerIndex) => ({ owner, ownerIndex }))
      .filter(({ owner, ownerIndex }) => {
        if (ownerIndex === index || owner.node_id === node.node_id || typeof owner.snippet !== 'string') return false
        if (ownerIndex < index && sourceSpanIdentity(owner) === sourceSpanIdentity(node)) return true
        const ownRange = completeRange(node), range = completeRange(owner)
        if (!ownRange || !range) return false
        const larger = range.end_line - range.start_line > ownRange.end_line - ownRange.start_line
        return (larger || ownerIndex < index) && containedSourceText(node, owner, owner.snippet) === node.snippet
      })
      .sort((left, right) => {
        const size = (owner: RecordValue): number => { const range = completeRange(owner); return range ? range.end_line - range.start_line : -1 }
        return size(right.owner) - size(left.owner) || left.ownerIndex - right.ownerIndex
      })
    const owner = candidates[0]?.owner
    if (owner) { delete node.snippet; node.snippet_ref = owner.node_id }
  }
  return nodes
}

/** Use the established wire fields for one independently authenticated source owner. */
export function compactSourceEvidenceNode(node: RecordValue): RecordValue {
  return compactNodes([node])[0]!
}

function compactRelationships(values: unknown[]): RecordValue[] {
  return unique(values.map(value => {
    const edge = record(value)
    return {
      ...(typeof edge.from_id === 'string' ? { from_id: edge.from_id } : { from: edge.from }),
      ...(typeof edge.to_id === 'string' ? { to_id: edge.to_id } : { to: edge.to }),
      relation: edge.relation,
      ...pick(edge, ['confidence', 'source_file', 'source_location']),
    }
  })) as RecordValue[]
}

/** Group adjacent locations without changing their order, detail, or uncertainty.
 * The flat representation remains available when grouping would cost more tokens.
 */
function compactSourceDependencies(value: unknown): RecordValue {
  const dependencies = record(value)
  if (!Array.isArray(dependencies.unresolved) || dependencies.unresolved_groups !== undefined) return dependencies
  const groups: Array<{ source_file: string; reason: string; calls: RecordValue[] }> = []
  for (const entry of dependencies.unresolved) {
    const { source_file, reason, ...call } = record(entry)
    if (typeof source_file !== 'string' || typeof reason !== 'string') return dependencies
    const previous = groups.at(-1)
    if (previous?.source_file === source_file && previous.reason === reason) previous.calls.push(call)
    else groups.push({ source_file, reason, calls: [call] })
  }
  const grouped: RecordValue = { ...dependencies, unresolved_groups: groups }
  delete grouped.unresolved
  return estimateQueryTokens(JSON.stringify(grouped)) < estimateQueryTokens(JSON.stringify(dependencies))
    ? grouped : dependencies
}

/** Decode the compact diagnostic variant without discarding order or repeated locations. */
export function expandSourceDependencyCalls(calls: readonly unknown[]): RecordValue[] | undefined {
  if (calls.length > 4096) return undefined
  const expanded: RecordValue[] = []
  for (const value of calls) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const call = record(value)
    if (!Object.hasOwn(call, 'line_numbers')) { expanded.push({ ...call }); continue }
    if (Object.keys(call).some(key => key !== 'callee' && key !== 'line_numbers')
      || typeof call.callee !== 'string' || !Array.isArray(call.line_numbers) || !call.line_numbers.length
      || expanded.length + call.line_numbers.length > 4096
      || !call.line_numbers.every(line => Number.isSafeInteger(line) && line > 0)) return undefined
    for (const line_number of call.line_numbers) expanded.push({ line_number, callee: call.callee })
  }
  return expanded.length <= 4096 ? expanded : undefined
}

/** Apply reversible metadata savings after source and recovery allocation are settled. */
export function compactRepeatedSourceMetadata(input: RecordValue, maxTokens: number): RecordValue {
  if (input.response_format !== SOURCE_EVIDENCE_RESPONSE_FORMAT || input.verbose === true) return input
  const result = clone(input)
  if (typeof result.task === 'string' && result.task_intent === result.task) delete result.task_intent
  const cache = record(result.cache), freshness = record(record(result.governance).graph_freshness)
  if (typeof cache.graph_version === 'string' && cache.graph_version === freshness.graph_version) delete cache.graph_version
  const evidence = record(result.evidence)
  if (Array.isArray(evidence.missing_phases) && !evidence.missing_phases.length) delete evidence.missing_phases
  const dependencies = record(record(result.pack).source_dependencies)
  if (Array.isArray(dependencies.unresolved_groups)) for (const value of dependencies.unresolved_groups) {
    const group = record(value)
    if (!Array.isArray(group.calls)) continue
    const flat = expandSourceDependencyCalls(group.calls)
    if (!flat) continue
    const compressed: RecordValue[] = []
    for (const call of flat) {
      const simple = Object.keys(call).length === 2 && typeof call.callee === 'string'
        && Number.isSafeInteger(call.line_number) && Number(call.line_number) > 0
      const previous = compressed.at(-1)
      if (simple && previous && previous.callee === call.callee && Array.isArray(previous.line_numbers)) previous.line_numbers.push(call.line_number)
      else if (simple) compressed.push({ callee: call.callee, line_numbers: [call.line_number] })
      else compressed.push({ ...call })
    }
    const calls = compressed.map(call => Array.isArray(call.line_numbers) && call.line_numbers.length === 1
      ? { line_number: call.line_numbers[0], callee: call.callee } : call)
    if (estimateQueryTokens(JSON.stringify(calls)) < estimateQueryTokens(JSON.stringify(group.calls))) group.calls = calls
  }
  result.serialized_budget = { max_tokens: maxTokens, token_count: 0, enforced: true }
  for (let index = 0; index < 8; index++) {
    const count = estimateQueryTokens(JSON.stringify(result))
    if (record(result.serialized_budget).token_count === count) break
    record(result.serialized_budget).token_count = count
  }
  const count = estimateQueryTokens(JSON.stringify(result))
  return count <= maxTokens && count <= estimateQueryTokens(JSON.stringify(input)) ? result : input
}

/** Spend a constrained response on source before optional navigation examples.
 * Counts, uncertainty, source identities and usable recovery handles remain. */
export function omitSourceNavigationDetails(input: RecordValue): RecordValue {
  if (input.task !== 'explain' || input.mode === 'delta' || input.delta_session_id
    || record(input.pack).selection_scope !== 'task_context'
    || input.diagnostics_omitted !== undefined && input.diagnostics_omitted !== 'output_budget') return input
  const result = clone(input), dependencies = record(record(result.pack).source_dependencies)
  const callCount = (value: unknown): number | undefined => {
    const call = record(value), keys = Object.keys(call)
    if (typeof call.callee !== 'string' || !call.callee) return undefined
    if (keys.every(key => ['callee', 'line_number'].includes(key))
      && Number.isSafeInteger(call.line_number) && Number(call.line_number) > 0) return 1
    if (keys.every(key => ['callee', 'line_numbers'].includes(key)) && Array.isArray(call.line_numbers)
      && call.line_numbers.length > 0 && call.line_numbers.length <= 4096
      && call.line_numbers.every(line => Number.isSafeInteger(line) && line > 0)) return call.line_numbers.length
    return undefined
  }
  const examples = dependencies.unresolved_groups ?? dependencies.unresolved
  if (!(dependencies.unresolved_groups !== undefined && dependencies.unresolved !== undefined)
    && Array.isArray(examples) && examples.length <= 4096
    && Number.isSafeInteger(dependencies.unresolved_calls) && Number(dependencies.unresolved_calls) >= 0) {
    let count = 0, known = true
    for (const value of examples) {
      const entry = record(value)
      if (typeof entry.source_file !== 'string' || !entry.source_file || typeof entry.reason !== 'string'
        || !['unresolved', 'external', 'no_implementation', 'outside_index', 'limit'].includes(entry.reason)) { known = false; break }
      if (dependencies.unresolved_groups !== undefined) {
        if (Object.keys(entry).some(key => !['source_file', 'reason', 'calls'].includes(key))
          || !Array.isArray(entry.calls) || entry.calls.length > 4096) { known = false; break }
        for (const call of entry.calls) {
          const size = callCount(call)
          if (size === undefined || (count += size) > 4096) { known = false; break }
        }
      } else {
        const { source_file: _file, reason: _reason, ...call } = entry
        const size = callCount(call)
        if (size === undefined || (count += size) > 4096) known = false
      }
      if (!known) break
    }
    if (known && count <= Number(dependencies.unresolved_calls)) {
      delete dependencies.unresolved_groups
      delete dependencies.unresolved
    }
  }
  const knownHint = (key: string, value: unknown): boolean => Array.isArray(value) && value.length <= 4096
    && (key === 'focus_ranges' ? value.every(item => {
      const range = record(item)
      return Object.keys(range).every(field => ['source_file', 'start_line', 'end_line'].includes(field))
        && typeof range.source_file === 'string' && Number.isSafeInteger(range.start_line)
        && Number(range.start_line) > 0 && Number.isSafeInteger(range.end_line)
        && Number(range.end_line) >= Number(range.start_line)
    }) : value.every(item => typeof item === 'string'))
  for (const value of array(result.expandable)) {
    const entry = record(value)
    const handle = typeof entry.handle_id === 'string'
      ? /^expand:explain:(primary|supporting|structural|change|impact):[a-f0-9]{12}$/.exec(entry.handle_id) : null
    if (!handle || handle[1] !== entry.evidence_class || !Number.isSafeInteger(entry.count) || Number(entry.count) <= 0) continue
    for (const key of ['focus_files', 'focus_ranges', 'symbols']) if (knownHint(key, entry[key])) delete entry[key]
  }
  const answerability = record(record(result.evidence).answerability)
  const redundantHandles = new Set<string>()
  const handles = array(result.expandable).map(record)
  for (const entry of handles) {
    const parsed = typeof entry.handle_id === 'string'
      ? /^expand:explain:(primary|supporting|structural|change|impact):[a-f0-9]{12}$/.exec(entry.handle_id) : null
    if (parsed && parsed[1] === entry.evidence_class && Number.isSafeInteger(entry.count) && Number(entry.count) > 0
      && handles.filter(other => other.handle_id === entry.handle_id).length === 1
      && array(answerability.missing_obligations).includes(`evidence:${parsed[1]}`)) redundantHandles.add(String(entry.handle_id))
  }
  const repeatedReasons = new Set([
    ...array(answerability.missing_obligations).filter(value => typeof value === 'string').map(value => `verify ${value}`),
    ...array(answerability.caveats).filter(value => typeof value === 'string'),
  ])
  if (Array.isArray(answerability.verification_targets)) {
    const targets = answerability.verification_targets.filter(value => {
      const target = record(value)
      if (Object.keys(target).length === 1 && typeof target.handle_id === 'string' && redundantHandles.has(target.handle_id)) return false
      return typeof target.handle_id === 'string' && !!target.handle_id
        || Object.keys(target).some(key => !['focus_files', 'focus_ranges', 'reason'].includes(key))
        || target.reason !== undefined && !repeatedReasons.has(target.reason as string)
        || ['focus_files', 'focus_ranges'].some(key => target[key] !== undefined && !knownHint(key, target[key]))
        || target.focus_files === undefined && target.focus_ranges === undefined
    })
    if (targets.length) answerability.verification_targets = targets
    else delete answerability.verification_targets
  }
  result.diagnostics_omitted = 'output_budget'
  return estimateQueryTokens(JSON.stringify(result)) < estimateQueryTokens(JSON.stringify(input)) ? result : input
}

/** Final representation only: retain every owner's exact source and recovery
 * identity while sharing complete bodies inside an unchanged partial supplier. */
export function compactContainedSourceReferences(input: RecordValue, maxTokens: number): RecordValue {
  const receipt = record(input.serialized_budget)
  if (input.response_format !== SOURCE_EVIDENCE_RESPONSE_FORMAT || input.task !== 'explain'
    || input.verbose === true || input.mode === 'delta' || input.delta_session_id
    || !Number.isSafeInteger(maxTokens) || maxTokens < MIN_SOURCE_EVIDENCE_BUDGET
    || Object.keys(receipt).some(key => !['max_tokens', 'token_count', 'enforced'].includes(key))
    || receipt.max_tokens !== maxTokens || receipt.enforced !== true
    || !Number.isSafeInteger(receipt.token_count) || Number(receipt.token_count) > maxTokens
    || receipt.token_count !== estimateQueryTokens(JSON.stringify(input))) return input
  const pack = record(input.pack), original = array(pack.matched_nodes).map(record)
  if (!original.length || original.length > 128 || original.some(node => typeof node.node_id !== 'string' || !node.node_id)
    || new Set(original.map(node => node.node_id)).size !== original.length
    || original.reduce((sum, node) => sum + (typeof node.snippet === 'string' ? node.snippet.length : 0), 0) > 1024 * 1024) return input
  const result = clone(input), resultPack = record(result.pack), nodes = array(resultPack.matched_nodes).map(record)
  const before = original.map(node => resolveSourceSnippet(node, original))
  let shared = false
  for (const [index, node] of nodes.entries()) {
    if (!literalReferenceNode(node) || typeof node.snippet !== 'string' || node.snippet_ref !== undefined || !completeRange(node)
      || original.some(other => other.snippet_ref === node.node_id)) continue
    const owner = original.find(other => literalReferenceNode(other) && other.node_id !== node.node_id && typeof other.snippet === 'string'
      && other.snippet_ref === undefined && array(other.snippet_omitted_ranges).length > 0
      && containedSourceText(node, other, other.snippet) === node.snippet)
    if (!owner || before[index] === null) continue
    delete node.snippet
    node.snippet_ref = owner.node_id
    shared = true
  }
  if (!shared || nodes.some((node, index) => resolveSourceSnippet(node, nodes) !== before[index])) return input
  result.serialized_budget = { max_tokens: maxTokens, token_count: 0, enforced: true }
  for (let index = 0; index < 12; index++) {
    const count = estimateQueryTokens(JSON.stringify(result))
    if (record(result.serialized_budget).token_count === count) {
      return count <= maxTokens && count < estimateQueryTokens(JSON.stringify(input)) ? result : input
    }
    record(result.serialized_budget).token_count = count
  }
  return input
}

function compactPack(input: unknown): RecordValue {
  const pack = record(input)
  const result = pick(pack, ['target', 'target_node_id', 'target_file', 'depth', 'traversal', 'impact_traversal', 'affected_files', 'total_affected',
    'selection_scope', 'selection_omitted', 'source_search', 'source_dependencies', 'changed_files', 'base_branch', 'head_branch', 'uncovered_hotspots', 'critical_labels'])
  if (pack.source_dependencies) result.source_dependencies = compactSourceDependencies(pack.source_dependencies)
  if (Array.isArray(pack.matched_nodes)) result.matched_nodes = compactNodes(pack.matched_nodes)
  if (Array.isArray(pack.nodes)) result.nodes = compactNodes(pack.nodes)
  if ([...array(result.matched_nodes), ...array(result.nodes)].some(node => record(node).snippet_ref)) {
    result.snippet_references = "snippet_ref points to node_id; select this node's snippet_line_range from that source. Equal ranges share the excerpt."
  }
  if (Array.isArray(pack.relationships)) result.relationships = compactRelationships(pack.relationships)
  for (const field of ['direct_dependents', 'transitive_dependents', 'seed_nodes', 'changed_nodes']) {
    if (Array.isArray(pack[field])) result[field] = pack[field].map(value => pick(value,
      ['node_id', 'id', 'label', 'source_file', 'line_number', 'distance', 'relation', 'traversal']))
  }
  if (pack.review_bundle) result.review_bundle = compactPack(pack.review_bundle)
  // Ordered source-linked paths are useful evidence; graph summaries and rankings are diagnostics.
  if (pack.execution_slice) result.execution_slice = pick(pack.execution_slice,
    ['status', 'boundary_reason', 'steps', 'missing_phases', 'gaps', 'omitted_branches'])
  if (pack.answer_contract) result.answer_contract = pick(pack.answer_contract, ['missing_phases', 'uncertainty_notes', 'do_not_claim'])
  return result
}
export function compactFreshness(value: unknown): RecordValue {
  const freshness = record(value)
  const result = pick(freshness, ['status', 'graph_version', 'selected_context_status'])
  for (const [key, count] of Object.entries(freshness)) {
    if (/(changed|missing).*count$/.test(key) && typeof count === 'number' && count > 0) result[key] = count
  }
  if (freshness.status !== 'fresh' || freshness.selected_context_status !== 'fresh') {
    if (typeof freshness.recommendation === 'string') result.recommendation = freshness.recommendation
  }
  return result
}
function compactPayload(input: RecordValue): RecordValue {
  const result = pick(input, ['schema_version', 'task', 'task_intent', 'target', 'handle_id', 'mode',
    'delta_session_id', 'delta_applied', 'referenced_ids', 'cache', 'routing'])
  result.response_format = SOURCE_EVIDENCE_RESPONSE_FORMAT
  result.pack = compactPack(input.pack)
  const pack = record(result.pack)
  // This is an explicit source-selection receipt, never an inferred readiness score.
  const focusedLookup = pack.selection_scope === 'symbol_lookup' || pack.selection_scope === 'file_lookup'
  const evidence = record(input.evidence)
  result.evidence = pick(evidence, ['answerability', 'missing_phases', 'discovery_exclusions',
    'indexing_completeness', 'agent_directive'])
  record(result.evidence).answerability = {
    ...pick(evidence.answerability, ['caveats', 'missing_obligations', 'verification_targets', 'broad_search_fallback']),
    advisory: true,
  }
  const detail = record(evidence.coverage_detail)
  const answerability = record(record(result.evidence).answerability)
  // Internal, cache-persisted deferral is an intentional missing-source state.
  // compactPack does not emit this marker; ordinary response semantics stay unchanged.
  if (record(input.pack)._source_discovery_deferred === true || record(input.pack)._explicit_source_targets === true) {
    Object.assign(answerability, { state: 'insufficient', answer_scope: 'partial', advisory: true })
  }
  const unverifiedOmitted = record(input.pack)._unverified_source_omitted
  if (Number.isSafeInteger(unverifiedOmitted) && Number(unverifiedOmitted) > 0) {
    Object.assign(answerability, { state: 'insufficient', answer_scope: 'partial', advisory: true })
    answerability.missing_obligations = unique([...array(answerability.missing_obligations), 'evidence:unverified_source'])
    answerability.caveats = unique([...array(answerability.caveats), 'Unverified cached source was omitted.'])
    if (answerability.broad_search_fallback !== 'blocked') record(result.evidence).agent_directive = 'explore_with_caution'
  }
  const missingObligations = unique([...array(answerability.missing_obligations),
    ...array(evidence.missing_obligations), ...array(detail.missing_obligations)])
  if (missingObligations.length) answerability.missing_obligations = missingObligations
  for (const [key, value] of Object.entries(evidence)) {
    if (/(policy|exclusion|indexing)/.test(key)) record(result.evidence)[key] = value
  }
  for (const field of ['missing_context', 'missing_semantic']) {
    const prefix = field === 'missing_context' ? 'evidence:' : 'semantic:'
    const remaining = array(input[field]).filter(value => !missingObligations.includes(`${prefix}${String(value)}`))
    if (remaining.length) result[field] = remaining
  }
  if (array(input.expandable).length) result.expandable = array(input.expandable).map(value => {
    const entry = record(value), followUp = record(entry.follow_up)
    const continuation = { ...pick(entry, ['handle_id', 'evidence_class', 'count', 'symbols']),
      focus_files: array(followUp.focus_files ?? entry.focus_files).slice(0, 4),
      focus_ranges: array(followUp.focus_ranges ?? entry.focus_ranges).slice(0, 2) }
    omitEmptyFields(continuation)
    return continuation
  })
  // Keep owned handle details once; verification targets can refer to that same handle.
  const handles = new Set(array(result.expandable).map(value => record(value).handle_id))
  if (Array.isArray(answerability.verification_targets)) {
    answerability.verification_targets = unique(answerability.verification_targets.map(value => {
      const target = record(value)
      return typeof target.handle_id === 'string' && handles.has(target.handle_id)
        ? { handle_id: target.handle_id, ...(target.basis === 'evidence_class'
          ? pick(target, ['basis', 'obligation_id', 'evidence_class']) : {}) }
        : target
    }))
  }
  const caveats = array(record(record(result.evidence).answerability).caveats)
  if (Number(record(input.pack).selection_omitted) > 0) caveats.push('Additional matching source targets were omitted by the selection limit.')
  if (record(record(input.pack).source_search).bounded === true) caveats.push('Source search was bounded; unmatched code may exist.')
  if (array(record(input.pack).matched_nodes).some(node => record(node).snippet_unverified === true)) {
    caveats.push('Cached source excerpt could not be verified against the current file.')
  }
  record(record(result.evidence).answerability).caveats = [...new Set(caveats)]
  applySourceLexicalCaution(result)
  if (input.governance) result.governance = { graph_freshness: compactFreshness(record(input.governance).graph_freshness) }
  const implementation = record(input.implementation)
  const guidance = pick(implementation, ['likely_edit_files', 'likely_test_files', 'validation_commands', 'validation_discovery', 'risk_boundaries'])
  for (const key of ['likely_edit_files', 'likely_test_files']) {
    if (Array.isArray(guidance[key])) guidance[key] = unique(guidance[key].map(value => pick(value, ['path', 'matched_symbols'])))
  }
  if (Array.isArray(guidance.risk_boundaries)) {
    guidance.risk_boundaries = unique(guidance.risk_boundaries.map(value => pick(value, ['label', 'affected_files'])))
  }
  omitEmptyFields(guidance)
  if (Object.keys(guidance).length) result.implementation = guidance
  if (focusedLookup) {
    if (result.task_intent === result.task) delete result.task_intent
    omitEmptyFields(answerability)
    omitEmptyFields(record(result.evidence))
    for (const key of ['relationships', 'direct_dependents', 'transitive_dependents', 'seed_nodes', 'changed_nodes']) {
      if (Array.isArray(pack[key]) && pack[key].length === 0) delete pack[key]
    }
    // Counts and planning prose are diagnostics for a direct, explicitly located lookup.
    if (pack.source_search) pack.source_search = pick(pack.source_search, ['bounded'])
    delete record(result.evidence).agent_directive
    const cache = record(result.cache), freshness = record(record(result.governance).graph_freshness)
    if (cache.graph_version === freshness.graph_version) delete cache.graph_version
  }
  return result
}

function nodeContainers(pack: RecordValue): Array<{ owner: RecordValue; key: string }> {
  const found = ['matched_nodes', 'nodes'].filter(key => Array.isArray(pack[key])).map(key => ({ owner: pack, key }))
  if (pack.review_bundle) found.push(...nodeContainers(record(pack.review_bundle)))
  return found
}
function markOmitted(payload: RecordValue, count: number): void {
  payload.omitted_evidence = { count, reason: 'output_budget', continuation: 'Request a focused context_pack or expand a supplied handle.' }
  const evidence = record(payload.evidence)
  const answerability = record(evidence.answerability)
  evidence.answerability = {
    ...answerability, state: 'insufficient', answer_scope: 'partial', advisory: true,
    broad_search_fallback: answerability.broad_search_fallback === 'blocked' ? 'blocked' : 'allowed',
    caveats: [...new Set([...array(answerability.caveats), 'Source evidence omitted to fit the output budget.'])],
  }
  evidence.agent_directive = 'explore_with_caution'
  payload.evidence = evidence
}
function removeOneEvidenceUnit(payload: RecordValue, preferred?: (nodes: readonly RecordValue[]) => string | undefined): boolean {
  const pack = record(payload.pack)
  for (const { owner, key } of nodeContainers(pack).reverse()) {
    const nodes = array(owner[key])
    if (!nodes.length) continue
    const originalNodes = nodes.map(record)
    const preferredId = preferred?.(originalNodes)
    const index = preferredId ? nodes.findIndex(node => record(node).node_id === preferredId) : -1
    const removed = record(index >= 0 ? nodes.splice(index, 1)[0] : nodes.pop())
    const ids = new Set(nodes.map(node => record(node).node_id))
    const labels = new Set(nodes.map(node => record(node).label))
    // A reference must never outlive the excerpt that supplies its source text.
    for (const value of nodes) {
      const node = record(value)
      if (node.snippet_ref === removed.node_id) {
        const source = resolveSourceSnippet(node, originalNodes)
        delete node.snippet_ref
        node.snippet = source
      }
    }
    owner.relationships = array(owner.relationships).filter(value => {
      const edge = record(value)
      return (edge.from_id ? ids.has(edge.from_id) : labels.has(edge.from))
        && (edge.to_id ? ids.has(edge.to_id) : labels.has(edge.to))
    })
    delete pack.execution_slice
    delete pack.answer_contract
    return true
  }
  for (const key of ['transitive_dependents', 'direct_dependents', 'seed_nodes', 'changed_nodes', 'affected_files', 'changed_files']) {
    if (array(pack[key]).length) { array(pack[key]).pop(); return true }
  }
  return false
}

/** One optional source unit may fund a verified callsite; the caller must price the entire trial. */
export function omitDisconnectedSourceForCallsite(
  payload: RecordValue, request: { rootPath: string; prompt: string },
): RecordValue | undefined {
  const pack = record(payload.pack)
  if (pack.selection_scope !== 'task_context' || !Array.isArray(pack.matched_nodes) || !Array.isArray(pack.relationships)) return undefined
  const entries = pack.matched_nodes.map(record)
  const id = sourceDisconnectedBudgetPreference(request.prompt, request.rootPath)(entries, pack.relationships.map(record))
  if (!id) return undefined
  const trial = clone(payload), trialPack = record(trial.pack)
  // Deliberately no tail fallback: failure to find an optional unit leaves the
  // original source and its recovery handles intact.
  trialPack.matched_nodes = array(trialPack.matched_nodes).filter(node => record(node).node_id !== id)
  delete trialPack.execution_slice
  delete trialPack.answer_contract
  markOmitted(trial, (Number(record(payload.omitted_evidence).count) || 0) + 1)
  return trial
}

export function renderSourceEvidenceText(payload: RecordValue): string {
  const lines = [`${String(payload.task ?? 'context')} source evidence`]
  const pack = record(payload.pack)
  for (const { owner, key } of nodeContainers(pack)) {
    for (const value of array(owner[key])) {
      const node = record(value)
      lines.push(`\n${String(node.source_file ?? '')}:${String(node.line_number ?? '')} ${String(node.label ?? '')} [${String(node.node_id ?? '')}]`)
      if (node.snippet_source === 'derived') lines.push(`Derived representation: ${String(node.representation_type ?? 'summary')}`)
      if (typeof node.snippet === 'string') lines.push(node.snippet)
      if (node.snippet_ref) lines.push(node.snippet_source === 'derived'
        ? `Representation reference: ${String(node.snippet_ref)}`
        : `Source excerpt: ${String(node.snippet_ref)} lines ${JSON.stringify(node.snippet_line_range ?? 'same range')}`)
      if (array(node.snippet_omitted_ranges).length) lines.push(`Omitted ranges: ${JSON.stringify(node.snippet_omitted_ranges)}`)
    }
  }
  const remainder = clone(payload)
  const remainderPack = record(remainder.pack)
  for (const { owner, key } of nodeContainers(remainderPack)) delete owner[key]
  delete remainder.task
  lines.push(`\nContext and limits: ${JSON.stringify(remainder)}`)
  return lines.join('\n')
}

/** Optional source-read context can consume spare wire budget, never evict evidence. */
function withCompleteSourceFiles(payload: RecordValue, maxTokens: number, rootPath: string): RecordValue {
  if (payload.task !== 'implement' || payload.mode === 'delta' || payload.delta_session_id
    || payload.response_format !== SOURCE_EVIDENCE_RESPONSE_FORMAT) return payload
  const nodes = array(record(payload.pack).matched_nodes).map(record)
  const resolved = nodes.map(node => ({ ...node, snippet: resolveSourceSnippet(node, nodes) }))
  let result = payload
  for (const file of completeSourceFileCandidates(resolved, rootPath)) {
    const trial = clone(result), pack = record(trial.pack)
    const entries = array(pack.matched_nodes).map(record)
    const owner = entries[file.owner_index]!
    Object.assign(owner, { snippet: file.snippet, snippet_line_range: { start_line: 1, end_line: file.end_line },
      snippet_scope: 'source_file', snippet_file_complete: true })
    for (const key of ['snippet_ref', 'snippet_line_number', 'snippet_omitted_ranges', 'snippet_truncated', 'snippet_unverified']) delete owner[key]
    pack.matched_nodes = compactNodes(entries)
    pack.source_read = 'Complete-file excerpts were read for this response and include imports. Use them as source reads; read again if files change or further context is needed. Other excerpts cover only their stated ranges.'
    const budget = record(trial.serialized_budget)
    for (let i = 0; i < 8; i++) {
      const count = estimateQueryTokens(JSON.stringify(trial))
      if (budget.token_count === count) break
      budget.token_count = count
    }
    if (estimateQueryTokens(JSON.stringify(trial)) <= maxTokens) result = trial
  }
  return result
}

/** Fill explicitly requested bodies using spare wire budget; never evict other evidence. */
function withCompleteRequestedSymbols(payload: RecordValue, maxTokens: number, request: { rootPath: string; prompt: string }): RecordValue {
  const freshness = record(record(payload.governance).graph_freshness)
  if (payload.mode === 'delta' || payload.delta_session_id || payload.response_format !== SOURCE_EVIDENCE_RESPONSE_FORMAT
    || payload.omitted_evidence || payload.omitted_nodes || Number(record(payload.pack).selection_omitted) > 0
    || freshness.status !== 'fresh' || freshness.selected_context_status !== 'fresh') return payload
  const nodes = array(record(payload.pack).matched_nodes).map(record)
  const resolved = nodes.map(node => ({ ...node, snippet: resolveSourceSnippet(node, nodes) }))
  const candidates = completeRequestedSymbolCandidates(resolved, request.prompt, request.rootPath)
  if (!candidates.some(candidate => candidate.snippet !== resolved[candidate.node_index]?.snippet)) return payload
  const trial = clone(payload)
  const entries = array(record(trial.pack).matched_nodes).map(record)
  for (const candidate of candidates) {
    const node = entries[candidate.node_index]!
    node.snippet = candidate.snippet
    for (const key of ['snippet_ref', 'snippet_omitted_ranges', 'snippet_truncated']) delete node[key]
  }
  const budget = record(trial.serialized_budget)
  for (let i = 0; i < 8; i++) {
    const count = estimateQueryTokens(JSON.stringify(trial))
    if (budget.token_count === count) break
    budget.token_count = count
  }
  return estimateQueryTokens(JSON.stringify(trial)) <= maxTokens ? trial : payload
}

function insufficientSourceEvidenceResponse(
  original: RecordValue, payload: RecordValue, maxTokens: number, format: 'json' | 'text' = 'json',
  cause = 'output_budget; request focused source or a larger budget',
): RecordValue {
  const evidence = record(payload.evidence)
  const blocked = record(evidence.answerability).broad_search_fallback === 'blocked'
  const minimalFreshness = record(record(payload.governance).graph_freshness)
  const indexing = record(evidence.indexing_completeness)
  const exclusions = record(evidence.discovery_exclusions)
  const dependencies = record(record(original.pack).source_dependencies)
  const result: RecordValue = {
    evidence: { answerability: { state: 'insufficient', advisory: true,
      broad_search_fallback: blocked ? 'blocked' : 'allowed' } },
    omitted_evidence: cause,
    limitations: {
      ...(minimalFreshness.status ? { graph: minimalFreshness.status } : {}),
      ...(minimalFreshness.selected_context_status ? { source: minimalFreshness.selected_context_status } : {}),
      ...(indexing.state ? { indexing: indexing.state } : {}),
      ...(record(record(original.pack).source_search).bounded === true ? { bounded_search: true } : {}),
      ...(dependencies.bounded === true ? { bounded_dependencies: true } : {}),
      ...(Number(dependencies.withheld_graph_calls) > 0 ? { withheld_graph_calls: dependencies.withheld_graph_calls } : {}),
      ...(Number(dependencies.unresolved_calls) > 0 ? { unresolved_calls: dependencies.unresolved_calls } : {}),
      ...(Number(dependencies.unattributed_calls) > 0 ? { unattributed_calls: dependencies.unattributed_calls } : {}),
      ...(Number(dependencies.unresolved_references) > 0 ? { unresolved_references: dependencies.unresolved_references } : {}),
      ...(Number(record(original.pack).selection_omitted) > 0 ? { selection_omitted: record(original.pack).selection_omitted } : {}),
      ...(Object.keys(exclusions).length ? { source_exclusions: exclusions.relevant ?? exclusions.total ?? 'unknown' } : {}),
    },
  }
  result.serialized_budget = { max_tokens: maxTokens, token_count: 0, enforced: true }
  const count = (): number => estimateQueryTokens(format === 'text' ? renderSourceEvidenceText(result) : JSON.stringify(result))
  for (let i = 0; i < 8; i++) {
    const next = count()
    if (record(result.serialized_budget).token_count === next) break
    record(result.serialized_budget).token_count = next
  }
  if (count() > maxTokens) throw new Error(`Budget ${maxTokens} is too small for the required evidence status`)
  return result
}

/** Price all retained source and its authenticated recovery after completion.
 * This boundary never exchanges source owners to fund continuation metadata.
 */
export function fitPreparedSourceEvidenceResponse<T extends {
  payload: RecordValue; valid: boolean; refused?: boolean; rejectedNodeIds: readonly string[]; validate: () => boolean
  handles?: ReadonlyMap<string, unknown>
}>(
  input: RecordValue,
  maxTokens: number,
  prepare: (payload: RecordValue) => T,
  _options: { requestedSource?: { rootPath: string; prompt: string } } = {},
): { payload: RecordValue; preparation?: T; status: 'fit' | 'over_budget' | 'unsupported' | 'unverifiable'
  overflow?: { requiredTokens: number; sourceTokens: number } } {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < MIN_SOURCE_EVIDENCE_BUDGET) throw new Error('Invalid source evidence budget')
  const prepared = prepare(input)
  const refuse = (cause: string, status: 'over_budget' | 'unsupported' | 'unverifiable') => ({
    payload: insufficientSourceEvidenceResponse(input, input, maxTokens, 'json', cause),
    status,
  })
  if (prepared.refused) return refuse('source recovery could not be verified', 'unverifiable')
  if (!prepared.valid) return refuse('source recovery could not be verified', 'unsupported')
  const payload = clone(prepared.payload)
  // Preparation authenticates this container only.
  for (const value of array(record(payload.pack).matched_nodes)) {
    const node = record(value), range = record(node.snippet_line_range)
    const omitted = node.snippet_omitted_ranges
    // Exact omission receipts already express this optional boolean. Encode
    // only authenticated source after completion; keep all source positions,
    // omissions, references, and other flag values unchanged.
    if (node.snippet_truncated !== true || node.snippet_source !== undefined
      || node.snippet_unverified !== undefined && node.snippet_unverified !== false
      || node.snippet_scope !== 'symbol' && node.snippet_scope !== 'source_file'
      || !Number.isSafeInteger(range.start_line) || !Number.isSafeInteger(range.end_line)
      || Number(range.start_line) <= 0 || Number(range.end_line) < Number(range.start_line)
      || Object.keys(range).some(field => field !== 'start_line' && field !== 'end_line')
      || !Array.isArray(omitted) || !omitted.length) continue
    let previousEnd = Number(range.start_line) - 1
    const valid = omitted.every(value => {
      const gap = record(value)
      if (!Number.isSafeInteger(gap.start_line) || !Number.isSafeInteger(gap.end_line)
        || Number(gap.start_line) <= previousEnd || Number(gap.end_line) < Number(gap.start_line)
        || Number(gap.end_line) > Number(range.end_line)
        || Object.keys(gap).some(field => field !== 'start_line' && field !== 'end_line')) return false
      previousEnd = Number(gap.end_line)
      return true
    })
    if (valid) delete node.snippet_truncated
  }
  payload.serialized_budget = { max_tokens: maxTokens, token_count: 0, enforced: true }
  const recount = (candidate: RecordValue = payload): number => {
    for (let i = 0; i < 12; i++) {
      const count = estimateQueryTokens(JSON.stringify(candidate))
      if (record(candidate.serialized_budget).token_count === count) return count
      if (i === 11) throw new Error('Prepared source token receipt did not stabilize')
      record(candidate.serialized_budget).token_count = count
    }
    throw new Error('Prepared source token receipt did not stabilize')
  }
  let count = recount()
  if (count > maxTokens) {
    const omitted = record(payload.omitted_evidence)
    const handles = array(record(payload.pack).matched_nodes).map(record)
      .flatMap(node => typeof node.source_expand_handle === 'string' ? [node.source_expand_handle] : [])
    // This generated hint repeats navigation already supplied by authenticated
    // handles. Keep the omission facts and all evidence; unknown prose stays.
    if (omitted.reason === 'output_budget' && Number.isSafeInteger(omitted.count) && Number(omitted.count) > 0
      && omitted.continuation === 'Request a focused context_pack or expand a supplied handle.'
      && Object.keys(omitted).every(key => ['count', 'reason', 'continuation'].includes(key))
      && handles.length > 0 && handles.every(id => prepared.handles?.has(id))) {
      delete omitted.continuation
      count = recount()
    }
  }
  // Validate even an oversized proposal so a known source/configuration failure
  // is not misreported as a budget problem. Preparation never commits stores.
  if (!prepared.validate()) return refuse('source recovery could not be verified', 'unverifiable')
  if (count > maxTokens) {
    // Reserve every mandatory pointer, regardless of how many an earlier
    // completion stage happened to fit. This pricing clone is never emitted.
    const sourceOnly = clone(payload)
    for (const value of array(record(sourceOnly.pack).matched_nodes)) delete record(value).source_expand_handle
    record(sourceOnly.serialized_budget).token_count = 0
    return {
      ...refuse('source and recovery exceed output budget; request focused source', 'over_budget'),
      overflow: { requiredTokens: count, sourceTokens: recount(sourceOnly) },
    }
  }
  prepared.payload = payload
  return { payload, preparation: prepared, status: 'fit' }
}

/** The final wire boundary. No source string is truncated to satisfy this cap. */
export function finalizeSourceEvidenceResponse(
  input: object,
  maxTokens: number,
  options: { verbose?: boolean; format?: 'json' | 'text'; sourceRoot?: string; sourcePolicyRoot?: string; requestedSource?: { rootPath: string; prompt: string }; deferNavigationDetails?: boolean } = {},
): RecordValue {
  if (maxTokens < MIN_SOURCE_EVIDENCE_BUDGET) throw new Error(`Source evidence budget must be at least ${MIN_SOURCE_EVIDENCE_BUDGET} tokens`)
  const original = clone(input)
  applySourceLexicalCaution(original)
  let payload = options.verbose ? clone(original) : compactPayload(original)
  const count = (): number => estimateQueryTokens(options.format === 'text' ? renderSourceEvidenceText(payload) : JSON.stringify(payload))
  const attach = (): number => {
    payload.serialized_budget = { max_tokens: maxTokens, token_count: 0, enforced: true }
    for (let i = 0; i < 8; i++) {
      const next = count()
      if (record(payload.serialized_budget).token_count === next) return next
      record(payload.serialized_budget).token_count = next
    }
    return count()
  }
  const finish = (): RecordValue => {
    const completed = !options.verbose && options.format !== 'text' && options.requestedSource && !original.omitted_evidence && !original.omitted_nodes
      ? withCompleteRequestedSymbols(payload, maxTokens, options.requestedSource) : payload
    const result = !options.verbose && options.format !== 'text' && options.sourceRoot
      ? withCompleteSourceFiles(completed, maxTokens, options.sourceRoot) : completed
    const policyRoot = options.sourcePolicyRoot ?? options.sourceRoot ?? options.requestedSource?.rootPath
    const sourceFiles = nodeContainers(record(result.pack)).flatMap(({ owner, key }) => array(owner[key]).map(record)
      .filter(node => typeof node.snippet === 'string' && node.snippet.length > 0 || typeof node.snippet_ref === 'string')
      .map(node => typeof node.source_file === 'string' ? node.source_file : ''))
    const withheld = new Set<string>()
    if (policyRoot) {
      // Verification navigation is not delivered source. Withhold an unavailable
      // whole handle using its original scope, never its truncated wire hints.
      const advertised = new Set([...array(result.expandable), ...array(record(result.pack).expandable),
        ...array(record(record(result.evidence).answerability).verification_targets)]
        .map(record).map(entry => entry.handle_id)
        .filter((id): id is string => typeof id === 'string' && /^verify-[a-f0-9]{16}$/.test(id)))
      const originals = [...array(original.expandable), ...array(record(original.pack).expandable)].map(record)
      for (const id of advertised) {
        const bindings = originals.filter(entry => entry.handle_id === id)
        if (bindings.length !== 1) { withheld.add(id); continue }
        const entry = bindings[0]!, followUp = record(entry.follow_up)
        const paths = [...array(followUp.focus_files ?? entry.focus_files),
          ...array(followUp.focus_ranges ?? entry.focus_ranges).map(value => record(value).source_file)]
        if (!paths.length || paths.some(path => typeof path !== 'string')
          || !sourcePathsAllowedByCurrentPolicy(paths as string[], policyRoot)) withheld.add(id)
      }
    }
    if (policyRoot && !sourcePathsAllowedByCurrentPolicy(sourceFiles, policyRoot)) {
      return insufficientSourceEvidenceResponse(original, result, maxTokens, options.format, 'source access could not be verified against current policy')
    }
    if (withheld.size) {
      const removeWithheld = (entries: unknown[]): unknown[] => entries.filter(entry => !withheld.has(String(record(entry).handle_id)))
      if (Array.isArray(result.expandable)) result.expandable = removeWithheld(result.expandable)
      const pack = record(result.pack), evidence = record(result.evidence), answerability = record(evidence.answerability)
      if (Array.isArray(pack.expandable)) pack.expandable = removeWithheld(pack.expandable)
      if (Array.isArray(answerability.verification_targets)) answerability.verification_targets = removeWithheld(answerability.verification_targets)
      const cause = 'Verification source access could not be verified against current policy.'
      evidence.answerability = { ...answerability, state: 'insufficient', answer_scope: 'partial', advisory: true,
        caveats: unique([...array(answerability.caveats), cause]) }
      if (answerability.broad_search_fallback === 'blocked') delete evidence.agent_directive
      else evidence.agent_directive = 'explore_with_caution'
      result.evidence = evidence
      result.omitted_evidence ??= original.omitted_evidence ?? cause
      result.serialized_budget = { max_tokens: maxTokens, token_count: 0, enforced: true }
      const recount = (): number => estimateQueryTokens(options.format === 'text' ? renderSourceEvidenceText(result) : JSON.stringify(result))
      for (let index = 0; index < 8; index++) {
        const count = recount()
        if (record(result.serialized_budget).token_count === count) break
        record(result.serialized_budget).token_count = count
      }
      if (recount() > maxTokens) return insufficientSourceEvidenceResponse(original, result, maxTokens, options.format, cause)
    }
    return result
  }
  if (attach() <= maxTokens) return finish()
  if (options.verbose) {
    payload = compactPayload(original)
    payload.diagnostics_omitted = 'output_budget'
    if (attach() <= maxTokens) return finish()
  }
  // Remove advisory implementation summaries before sacrificing the underlying source.
  delete payload.implementation
  // Continuations and navigation summaries must not crowd out their source evidence.
  if (array(payload.expandable).length > 2) {
    payload.omitted_continuations = array(payload.expandable).length - 2
    payload.expandable = array(payload.expandable).slice(0, 2)
  }
  const answerability = record(record(payload.evidence).answerability)
  if (array(answerability.verification_targets).length > 2) {
    answerability.verification_targets = array(answerability.verification_targets).slice(0, 2)
  }
  if (attach() > maxTokens) { delete record(payload.pack).execution_slice; delete record(payload.pack).answer_contract }
  if (attach() > maxTokens && payload.routing) { delete payload.routing; payload.diagnostics_omitted = 'output_budget' }
  let omitted = 0
  const freshness = record(record(payload.governance).graph_freshness)
  const preferred = options.requestedSource && !options.verbose && options.format !== 'text'
    && payload.task === 'explain' && !payload.delta_session_id && payload.mode !== 'delta'
    && (!record(original.pack).retrieval_strategy || record(original.pack).retrieval_strategy === 'default')
    && record(payload.pack).selection_scope === 'task_context'
    && freshness.status === 'fresh' && freshness.selected_context_status === 'fresh'
    ? sourceContainerBudgetPreference(options.requestedSource.prompt, options.requestedSource.rootPath) : undefined
  let navigationDetailsConsidered = false
  while (attach() > maxTokens) {
    if (!options.verbose && options.format !== 'text') {
      // Reversible metadata savings may fit the remaining owners after an earlier
      // eviction. Preserve their source before removing another owner.
      const compact = compactRepeatedSourceMetadata(payload, maxTokens)
      if (compact !== payload) { payload = compact; break }
      if (!navigationDetailsConsidered && !options.deferNavigationDetails) {
        navigationDetailsConsidered = true
        const reduced = omitSourceNavigationDetails(payload)
        if (reduced !== payload) { payload = reduced; continue }
      }
    }
    if (!removeOneEvidenceUnit(payload, preferred)) break
    markOmitted(payload, ++omitted)
  }
  if (attach() <= maxTokens) return finish()
  // Tiny budgets cannot carry source plus all continuations. Preserve the policy decision and freshness.
  return insufficientSourceEvidenceResponse(original, payload, maxTokens, options.format)
}
