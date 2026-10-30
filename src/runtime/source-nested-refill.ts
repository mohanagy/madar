import { isAbsolute, relative, resolve } from 'node:path'

import { classifySourceDomain } from '../shared/source-discovery.js'
import { extractPromptExclusions } from './retrieval-gate.js'
import type { SourceContinuationHandle } from './source-continuation.js'
import { compactSourceEvidenceNode } from './source-evidence-response.js'
import { compileSourceExclusions } from './source-exclusions.js'

type RecordValue = Record<string, unknown>
type Range = { start_line: number; end_line: number }
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as RecordValue : {}

function range(value: unknown): Range | undefined {
  const span = record(value)
  return Number.isSafeInteger(span.start_line) && Number.isSafeInteger(span.end_line)
    && Number(span.start_line) > 0 && Number(span.end_line) >= Number(span.start_line)
    && Object.keys(span).every(key => key === 'start_line' || key === 'end_line')
    ? { start_line: Number(span.start_line), end_line: Number(span.end_line) } : undefined
}

function directSymbol(node: RecordValue): boolean {
  const own = range(node.snippet_line_range)
  return typeof node.node_id === 'string' && !!node.node_id.trim() && typeof node.label === 'string' && !!node.label.trim()
    && typeof node.source_file === 'string' && !!node.source_file && typeof node.snippet === 'string' && !!node.snippet.trim() && node.snippet.length <= 12000
    && node.snippet_scope === 'symbol' && node.snippet_source === undefined && node.representation_type === undefined
    && node.snippet_ref === undefined && node.snippet_file_complete === undefined
    && (node.snippet_unverified === undefined || node.snippet_unverified === false)
    && (node.snippet_truncated === undefined || typeof node.snippet_truncated === 'boolean') && !!own
    && (node.line_number === undefined || node.line_number === own.start_line)
    && (node.snippet_line_number === undefined || node.snippet_line_number === own.start_line)
}

function omissions(node: RecordValue): Range[] | undefined {
  const owner = range(node.snippet_line_range), gaps = node.snippet_omitted_ranges
  if (!owner || !Array.isArray(gaps) || !gaps.length || gaps.length > 4096 || node.snippet_truncated === false) return undefined
  const result: Range[] = []
  let end = owner.start_line - 1
  for (const value of gaps) {
    const gap = range(value)
    if (!gap || gap.start_line <= end || gap.end_line > owner.end_line) return undefined
    result.push(gap); end = gap.end_line
  }
  return result
}

function ordinary(payload: RecordValue): boolean {
  const pack = record(payload.pack), answer = record(record(payload.evidence).answerability)
  const fresh = record(record(payload.governance).graph_freshness)
  return payload.task === 'explain' && payload.mode !== 'delta' && !payload.delta_session_id
    && pack.selection_scope === 'task_context' && (!pack.retrieval_strategy || pack.retrieval_strategy === 'default')
    && pack.nodes === undefined && pack.review_bundle === undefined && payload.omitted_nodes === undefined
    && fresh.status === 'fresh' && fresh.selected_context_status === 'fresh' && answer.broad_search_fallback !== 'blocked'
}

/** Pure selection from the original packet; source authority remains with the existing preparation cache. */
export function prepareNestedSourceRefill(input: object, request: { rootPath: string; prompt: string }) {
  const original = record(input), pack = record(original.pack), values = pack.matched_nodes
  if (!ordinary(original) || original.omitted_evidence !== undefined || !Array.isArray(values)
    || !values.length || values.length > 128) return undefined
  const nodes = values.map(record), ids = new Set(nodes.map(node => node.node_id))
  if (ids.size !== nodes.length || nodes.some(node => !directSymbol(node) || node.source_expand_handle !== undefined)) return undefined
  const identities = nodes.map(node => JSON.stringify([resolve(request.rootPath, String(node.source_file)), range(node.snippet_line_range)]))
  if (new Set(identities).size !== nodes.length) return undefined
  const exclusions = extractPromptExclusions(request.prompt)
  const excluded = compileSourceExclusions(exclusions.excludedTerms, exclusions.excludedPathHints, request.rootPath)
  const allowed = (node: RecordValue): boolean => {
    const file = String(node.source_file), logical = resolve(request.rootPath, file), local = relative(request.rootPath, logical)
    return excluded.valid && !!local && !local.startsWith('..') && !isAbsolute(local) && !file.split('/').includes('..')
      && !/[\\\u0000-\u001f\u007f]/.test(file)
      && !exclusions.excludedDomains.includes(classifySourceDomain(logical, request.rootPath) as never)
      && !excluded.matchesSource(file, String(node.label)) && !excluded.matchesPath(logical)
      && !excluded.matchesText(String(node.snippet))
  }
  const parents = nodes.flatMap(node => {
    const gaps = omissions(node)
    return gaps && allowed(node) ? [{ node, gaps }] : []
  })
  const candidates = nodes.filter(node => {
    if (!directSymbol(node) || node.snippet_truncated === true || node.source_expand_handle !== undefined
      || node.snippet_omitted_ranges !== undefined && (!Array.isArray(node.snippet_omitted_ranges) || node.snippet_omitted_ranges.length)
      || !allowed(node)) return false
    const own = range(node.snippet_line_range)!
    return own.end_line - own.start_line < 80 && String(node.snippet).length <= 12000
      && String(node.snippet).split('\n').length === own.end_line - own.start_line + 1
      && parents.some(parent => parent.node.source_file === node.source_file && parent.gaps.some(gap =>
        own.start_line >= gap.start_line && own.end_line <= gap.end_line))
  })
  if (!candidates.length) return undefined
  return {
    candidates,
    trial(payload: RecordValue, node: RecordValue, lookup: (id: string) => SourceContinuationHandle | undefined): RecordValue | undefined {
      if (!candidates.includes(node)) return undefined
      const current = record(payload.pack), retained = current.matched_nodes, omitted = record(payload.omitted_evidence)
      if (!ordinary(payload) || !Array.isArray(retained) || !retained.length || retained.length >= 128
        || omitted.reason !== 'output_budget' || !Number.isSafeInteger(omitted.count) || Number(omitted.count) <= 0
        || Object.keys(omitted).some(key => !['count', 'reason', 'continuation'].includes(key))
        || omitted.continuation !== undefined && omitted.continuation !== 'Request a focused context_pack or expand a supplied handle.') return undefined
      const kept = retained.map(record), delivered = new Set(kept.map(owner => owner.node_id))
      if (delivered.size !== kept.length || kept.some(owner => !ids.has(owner.node_id)) || delivered.has(node.node_id)
        || Number(omitted.count) !== nodes.filter(owner => !delivered.has(owner.node_id)).length) return undefined
      const own = range(node.snippet_line_range)!
      if (!kept.some(parent => {
        if (!directSymbol(parent) || !parents.some(({ node: raw }) => raw.node_id === parent.node_id
          && raw.source_file === parent.source_file && JSON.stringify(raw.snippet_line_range) === JSON.stringify(parent.snippet_line_range))
          || parent.source_file !== node.source_file || !omissions(parent)?.some(gap => own.start_line >= gap.start_line && own.end_line <= gap.end_line)
          || typeof parent.source_expand_handle !== 'string') return false
        // The accepted proof already resolved this file. Apply prompt exclusions
        // to that canonical identity without another source read or proof cache.
        const handle = lookup(parent.source_expand_handle)
        return !!handle && handle.node_id === parent.node_id && handle.label === parent.label
          && resolve(handle.logical_root) === resolve(request.rootPath)
          && resolve(request.rootPath, handle.source_file) === resolve(request.rootPath, String(parent.source_file))
          && JSON.stringify(handle.owner_range) === JSON.stringify(range(parent.snippet_line_range))
          && !excluded.matchesPath(handle.canonical_file, handle.real_root)
          && !exclusions.excludedDomains.includes(classifySourceDomain(handle.canonical_file, handle.real_root) as never)
      })) return undefined
      const trial = JSON.parse(JSON.stringify(payload)) as RecordValue
      record(trial.pack).matched_nodes = [...record(trial.pack).matched_nodes as RecordValue[], compactSourceEvidenceNode(node)]
      if (Number(omitted.count) === 1) delete trial.omitted_evidence
      else trial.omitted_evidence = { ...omitted, count: Number(omitted.count) - 1 }
      return trial
    },
  }
}
