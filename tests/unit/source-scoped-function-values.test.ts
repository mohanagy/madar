import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { lineRangeFromSourceLocation } from '../../src/shared/source-location.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'
import { selectSourceDependencies, sourceFunctionValueReferencesKey, type SourceFunctionValueReference } from '../../src/runtime/retrieve/source-dependencies.js'
import { finalizeSourceEvidenceResponse } from '../../src/runtime/stdio/tools.js'
import * as responses from '../../src/runtime/source-evidence-response.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import type { SourceContinuationHandle } from '../../src/runtime/source-continuation.js'

type Value = Record<string, unknown>
const roots: string[] = []
const object = (value: unknown): Value => value as Value
const nodes = (value: Value): Value[] => (object(value.pack ?? {}).matched_nodes ?? []) as Value[]
const ids = (value: Value): unknown[] => nodes(value).map(node => node.node_id)
const cost = (value: Value): number => estimateQueryTokens(JSON.stringify(value))
const serialize = responses.finalizeSourceEvidenceResponse
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })

function fixture(mode: 'plain' | 'ambiguous' | 'large' = 'plain') {
  const root = mkdtempSync(join(tmpdir(), 'madar-scoped-values-')); roots.push(root)
  const source = [
    'export function dispatchValue(value) {', '  queue(value, finishValue)',
    ...(mode === 'ambiguous' ? ['  queue(value, otherValue)'] : []), '  return value', '}', '',
    'function queue(value, callback) { return callback(value) }', '',
    'function finishValue(value) {', mode === 'large' ? `  return '${'large '.repeat(500)}' + value` : '  return String(value)', '}', '',
    'function otherValue(value) { return value }',
  ]
  const pending = ['export function retainValue(value) {', ...Array.from({ length: 30 }, (_, index) => `  value += ${index}`), '  return value', '}']
  writeFileSync(join(root, 'dispatch.mjs'), source.join('\n')); writeFileSync(join(root, 'support.mjs'), pending.join('\n'))
  const fragments = ['dispatch.mjs', 'support.mjs'].map(file => extractJs(join(root, file)))
  const graph = buildFromJson({ schema_version: 1, nodes: fragments.flatMap(fragment => fragment.nodes), edges: fragments.flatMap(fragment => fragment.edges) }, { directed: true })
  graph.graph.root_path = root
  const entry = (name: string): Value => {
    const [id, node] = graph.nodeEntries().find(([, node]) => node.label === `${name}()` )!
    const range = lineRangeFromSourceLocation(node.source_location)!, file = String(node.source_file)
    const lines = readFileSync(resolve(root, file), 'utf8').split(/\r?\n/)
    return { node_id: id, label: node.label, source_file: file, line_number: range.start, snippet_scope: 'symbol',
      snippet_line_range: { start_line: range.start, end_line: range.end }, snippet: lines.slice(range.start - 1, range.end).join('\n') }
  }
  const caller = entry('dispatchValue'), retained = entry('retainValue'), target = entry('finishValue'), other = entry('otherValue')
  Object.assign(retained, { snippet: [pending[0], '[omitted lines 2-31]', ...pending.slice(31)].join('\n'),
    snippet_omitted_ranges: [{ start_line: 2, end_line: 31 }], snippet_truncated: true })
  const dependency = selectSourceDependencies(graph, [String(caller.node_id)], root, new Map(), {
    includeCallers: false, inspectionOnly: true, functionValueCallerIds: [String(caller.node_id)],
  })
  const references = dependency.source_function_value_references ?? []
  expect(references.some(reference => reference.target.node_id === target.node_id)).toBe(true)
  const prompt = 'Trace dispatchValue and retainValue in dispatch.mjs and support.mjs.'
  const payload: Value = { task: 'explain', response_format: 'source_evidence_v2',
    pack: { selection_scope: 'task_context', matched_nodes: [caller, retained, target, ...(mode === 'ambiguous' ? [other] : [])], relationships: [] },
    evidence: { answerability: { advisory: true, broad_search_fallback: 'allowed', missing_obligations: ['runtime:unverified'] } },
    governance: { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } } }
  // Isolate the final admission seam: the real serializer receives an already
  // culled row set, while the finalizer retains the original compiled identities.
  const omitted = new Set([target.node_id, other.node_id])
  vi.spyOn(responses, 'finalizeSourceEvidenceResponse').mockImplementation((input, budget, options) => {
    const next = structuredClone(input) as Value, before = nodes(next)
    if (before.some(node => omitted.has(node.node_id))) {
      object(next.pack).matched_nodes = before.filter(node => !omitted.has(node.node_id))
      next.omitted_evidence = { count: 4, reason: 'output_budget', continuation: 'Keep the existing receipt fields.' }
    }
    const result = serialize(next, budget, options)
    if (next.omitted_evidence) result.omitted_evidence = next.omitted_evidence
    return result
  })
  const evaluate = (input = payload, refs: readonly SourceFunctionValueReference[] | null = references, budget = 10000) => {
    const store = new Map<string, unknown>([['prior-session', { retained: true }]])
    const result = finalizeSourceEvidenceResponse(input, budget, { requestedSource: { rootPath: root, prompt },
      callsites: { bundles: [], configurationFresh: () => true },
      ...(refs ? { functionValues: { references: refs, configurationFresh: () => true } } : {}),
      continuations: { rootPath: root, store: (id: string, handle: SourceContinuationHandle) => { store.set(id, handle) } } })
    return { result, store }
  }
  return { root, graph, source, prompt, payload, caller, target, other, retained, references, evaluate }
}

describe('selected scoped function-value restoration', () => {
  it('restores one selected value with exact scoped provenance and rejects indexed-only or mismatched raw identities', () => {
    const f = fixture(), before = JSON.stringify(f.payload)
    const retrieved = retrieveContext(f.graph, { question: f.prompt, taskKind: 'explain', projectRoot: f.root, budget: 10000 })
    expect(retrieved[sourceFunctionValueReferencesKey]?.some(reference => reference.caller.node_id === f.caller.node_id
      && reference.target.node_id === f.target.node_id)).toBe(true)
    const baseline = f.evaluate(f.payload, null), candidate = f.evaluate(), cached = f.evaluate(f.payload, JSON.parse(JSON.stringify(f.references)))
    expect(ids(candidate.result)).toEqual([...ids(baseline.result), f.target.node_id])
    expect(nodes(candidate.result).slice(0, -1)).toEqual(nodes(baseline.result))
    expect(nodes(candidate.result).at(-1)?.snippet).toBe(f.target.snippet)
    expect(object(candidate.result.pack).relationships).toEqual(object(baseline.result.pack).relationships)
    expect(candidate.result.omitted_evidence).toEqual({ ...object(baseline.result.omitted_evidence), count: 3 })
    expect(cost(candidate.result)).toBeLessThanOrEqual(cost(baseline.result) + 200)
    expect(object(candidate.result.serialized_budget).token_count).toBe(cost(candidate.result))
    expect([...candidate.store]).toEqual([...baseline.store])
    expect(cached.result).toEqual(candidate.result); expect([...cached.store]).toEqual([...candidate.store])
    expect(JSON.stringify(f.payload)).toBe(before)
    const indexedOnly = structuredClone(f.payload)
    object(indexedOnly.pack).matched_nodes = nodes(indexedOnly).filter(node => node.node_id !== f.target.node_id)
    indexedOnly.omitted_evidence = { count: 4, reason: 'output_budget', continuation: 'Keep the existing receipt fields.' }
    const indexedBaseline = f.evaluate(indexedOnly, null), indexedCandidate = f.evaluate(indexedOnly)
    expect(object(indexedBaseline.result.omitted_evidence).count).toBeGreaterThan(0)
    expect(object(indexedBaseline.result.omitted_evidence).reason).toBe('output_budget')
    expect(indexedCandidate.result).toEqual(indexedBaseline.result)
    expect([...indexedCandidate.store]).toEqual([...indexedBaseline.store])
    expect(ids(indexedCandidate.result)).not.toContain(f.target.node_id)
    for (const change of ['label', 'source_file', 'range', 'duplicate']) {
      const invalid = structuredClone(f.payload), target = nodes(invalid).find(node => node.node_id === f.target.node_id)!
      if (change === 'label') target.label = 'unrelatedValue()'
      else if (change === 'source_file') target.source_file = 'support.mjs'
      else if (change === 'range') object(target.snippet_line_range).end_line = Number(object(target.snippet_line_range).end_line) + 1
      else nodes(invalid).push(structuredClone(target))
      const prior = f.evaluate(invalid, null), next = f.evaluate(invalid)
      expect(next.result).toEqual(prior.result); expect([...next.store]).toEqual([...prior.store])
    }
  })

  it('abstains for an omitted value read or more than one admissible target', () => {
    const f = fixture(), hidden = structuredClone(f.payload)
    const caller = nodes(hidden)[0]!, range = object(caller.snippet_line_range)
    caller.snippet = [f.source[0], '[omitted lines 2-2]', ...f.source.slice(2, Number(range.end_line))].join('\n')
    caller.snippet_omitted_ranges = [{ start_line: 2, end_line: 2 }]; caller.snippet_truncated = true
    const baseline = f.evaluate(hidden, null), candidate = f.evaluate(hidden)
    expect(nodes(baseline.result)[0]!.snippet_omitted_ranges).toContainEqual({ start_line: 2, end_line: 2 })
    expect(String(nodes(baseline.result)[0]!.snippet)).not.toContain('queue(value, finishValue)')
    expect(candidate.result).toEqual(baseline.result); expect([...candidate.store]).toEqual([...baseline.store])
    const ambiguous = fixture('ambiguous'), prior = ambiguous.evaluate(ambiguous.payload, null), next = ambiguous.evaluate()
    expect(next.result).toEqual(prior.result); expect([...next.store]).toEqual([...prior.store])
    const selectedOnly = structuredClone(ambiguous.payload)
    object(selectedOnly.pack).matched_nodes = nodes(selectedOnly).filter(node => node.node_id !== ambiguous.other.node_id)
    const selectedBaseline = ambiguous.evaluate(selectedOnly, null), selectedCandidate = ambiguous.evaluate(selectedOnly)
    expect(ids(selectedCandidate.result)).toEqual([...ids(selectedBaseline.result), ambiguous.target.node_id])
    expect(nodes(selectedCandidate.result).slice(0, -1)).toEqual(nodes(selectedBaseline.result))
    expect(selectedCandidate.result.omitted_evidence).toEqual({ ...object(selectedBaseline.result.omitted_evidence), count: 3 })
    expect([...selectedCandidate.store]).toEqual([...selectedBaseline.store])
  })

  it('keeps the exact baseline and store when preparation or the additive token cap refuses', () => {
    const f = fixture(), baseline = f.evaluate(f.payload, null), fit = responses.fitPreparedSourceEvidenceResponse
    let refused = 0
    vi.spyOn(responses, 'fitPreparedSourceEvidenceResponse').mockImplementation((input, budget, prepare, options) => {
      if (ids(input).includes(f.target.node_id)) { refused++; return fit(input, 128, prepare, options) }
      return fit(input, budget, prepare, options)
    })
    const candidate = f.evaluate()
    expect(refused).toBe(1); expect(candidate.result).toEqual(baseline.result); expect([...candidate.store]).toEqual([...baseline.store])
    vi.restoreAllMocks()
    const large = fixture('large'), prior = large.evaluate(large.payload, null), next = large.evaluate()
    expect(next.result).toEqual(prior.result); expect([...next.store]).toEqual([...prior.store])
  })

  it('refuses source drift without committing a stale baseline or new handles', () => {
    const f = fixture(), fit = responses.fitPreparedSourceEvidenceResponse
    let changed = false
    vi.spyOn(responses, 'fitPreparedSourceEvidenceResponse').mockImplementation((input, budget, prepare, options) => {
      const result = fit(input, budget, prepare, options)
      if (!changed && result.preparation && !ids(input).includes(f.target.node_id)) {
        changed = true
        writeFileSync(join(f.root, 'dispatch.mjs'), f.source.join('\n').replace('return String(value)', 'return Number(value)'))
      }
      return result
    })
    const candidate = f.evaluate()
    expect(changed).toBe(true); expect(nodes(candidate.result)).toEqual([])
    expect(object(object(candidate.result.evidence).answerability).state).toBe('insufficient')
    expect([...candidate.store]).toEqual([['prior-session', { retained: true }]])
  })
})
