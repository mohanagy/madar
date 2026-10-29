import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { lineRangeFromSourceLocation } from '../../src/shared/source-location.js'
import { selectSourceDependencies } from '../../src/runtime/retrieve/source-dependencies.js'
import { finalizeSourceEvidenceResponse } from '../../src/runtime/stdio/tools.js'
import * as responses from '../../src/runtime/source-evidence-response.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { type SourceContinuationHandle } from '../../src/runtime/source-continuation.js'

type Value = Record<string, unknown>
const roots: string[] = []
const object = (value: unknown): Value => value as Value
const nodes = (value: Value): Value[] => (object(value.pack ?? {}).matched_nodes ?? []) as Value[]
const ids = (value: Value): unknown[] => nodes(value).map(node => node.node_id)
const cost = (value: Value): number => estimateQueryTokens(JSON.stringify(value))
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })

function fixture(ambiguous = false) {
  const root = mkdtempSync(join(tmpdir(), 'madar-type-rejection-')); roots.push(root)
  const caller = ["import { checkValue } from './conversion.mjs'", 'export function processValue(value) {',
    '  checkValue(value)', '  return value', '}']
  const partial = ['export function retainedValue(value) {', ...Array.from({ length: 30 }, (_, i) => `  value += ${i};`), '  return value;', '}']
  const outside = ['export function bookkeeping(value) {', ...Array.from({ length: 48 }, (_, i) => `  value += ${i};`), '  return value;', '}']
  const distractor = ['export function checkValue(value) {', ...Array.from({ length: 60 }, (_, i) => `  value += ${i};`), '  return "WRONG_BINDING" + value;', '}']
  const target = ['export function checkValue(value) {', '  let observed = 0',
    ...Array.from({ length: 40 }, (_, i) => `  observed += ${i}`),
    // This is executable validation, but its throw has only a string anchor.
    '  if (typeof value === "boolean") {', '    throw new Error("value")', '  }',
    ...(ambiguous ? ['  if (typeof value === "number") {', '    throw new TypeError(value)', '  }'] : []),
    "  if (typeof value !== 'string') {", '    throw new TypeError(typeof value)', '  }',
    ...Array.from({ length: 40 }, (_, i) => `  observed += ${i}`), '  return observed', '}']
  const source: Record<string, string[]> = { 'caller.mjs': caller, 'pending.mjs': partial, 'context.mjs': outside,
    'distractor.mjs': distractor, 'conversion.mjs': target }
  for (const [file, lines] of Object.entries(source)) writeFileSync(join(root, file), lines.join('\n'))
  const fragments = Object.keys(source).map(file => extractJs(join(root, file)))
  const graph = buildFromJson({ schema_version: 1, nodes: fragments.flatMap(fragment => fragment.nodes),
    edges: fragments.flatMap(fragment => fragment.edges) }, { directed: true })
  graph.graph.root_path = root
  const names = ['processValue', 'retainedValue', 'bookkeeping', 'checkValue', 'checkValue']
  const entries = Object.entries(source).map(([file, lines], index) => {
    const [id, node] = graph.nodeEntries().find(([, node]) => node.label === `${names[index]}()`
      && typeof node.source_file === 'string' && resolve(root, node.source_file) === join(root, file))!
    const range = lineRangeFromSourceLocation(node.source_location)!
    return { node_id: id, label: node.label, source_file: file, line_number: range.start, snippet_scope: 'symbol',
      snippet_line_range: { start_line: range.start, end_line: range.end }, snippet: lines.slice(range.start - 1, range.end).join('\n') } as Value
  })
  Object.assign(entries[1]!, { snippet: [partial[0], '[omitted lines 2-31]', ...partial.slice(31)].join('\n'),
    snippet_truncated: true, snippet_omitted_ranges: [{ start_line: 2, end_line: 31 }] })
  Object.assign(entries[4]!, { snippet: [...target.slice(0, 2), `[omitted lines 3-${target.length - 2}]`, ...target.slice(-2)].join('\n'),
    snippet_truncated: true, snippet_omitted_ranges: [{ start_line: 3, end_line: target.length - 2 }] })
  const [callerId, partialId, outsideId, distractorId, targetId] = entries.map(node => node.node_id as string)
  const dependencies = selectSourceDependencies(graph, [callerId!], root, new Map(), { includeCallers: false, inspectionOnly: true })
  const bundles = (dependencies.source_callsite_bundles ?? []).filter(bundle => bundle.from_id === callerId && bundle.to_id === targetId)
  expect(bundles).toHaveLength(1)
  const payload: Value = { task: 'explain', response_format: 'source_evidence_v2',
    pack: { selection_scope: 'task_context', matched_nodes: entries,
      relationships: [{ from_id: callerId, to_id: targetId, relation: 'calls' }] },
    evidence: { answerability: { advisory: true, broad_search_fallback: 'allowed', missing_obligations: ['runtime:unverified'] } },
    governance: { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } } }
  const evaluate = (input: Value, budget: number, enabled = true, prompt = 'Find runtime source for value type validation in caller.mjs and conversion.mjs.') => {
    const store = new Map<string, unknown>([['prior-session-entry', { retained: true }]])
    const result = finalizeSourceEvidenceResponse(input, budget, {
      requestedSource: { rootPath: root, prompt },
      callsites: { bundles: enabled ? bundles : [], configurationFresh: () => true },
      continuations: { rootPath: root, store: (id: string, handle: SourceContinuationHandle) => { store.set(id, handle) } },
    })
    return { result, store }
  }
  const subset = structuredClone(payload)
  object(subset.pack).matched_nodes = nodes(subset).slice(0, 3)
  object(subset.pack).relationships = []
  const budget = cost(evaluate(subset, 10000, false).result) + 150
  return { root, payload, budget, evaluate, callerId, partialId, outsideId, distractorId, targetId, target }
}

describe('requested type-rejection branch admission', () => {
  it('admits one complete local guard with authentic owner identity and recovery at lower packet cost', () => {
    const f = fixture(), input = JSON.stringify(f.payload), baseline = f.evaluate(f.payload, f.budget, false)
    expect(ids(baseline.result)).toContain(f.outsideId)
    expect(ids(baseline.result)).not.toContain(f.targetId)
    const candidate = f.evaluate(f.payload, f.budget)
    expect(ids(candidate.result)).toContain(f.targetId)
    expect(ids(candidate.result)).not.toContain(f.outsideId)
    expect(ids(candidate.result)).not.toContain(f.distractorId)
    expect(cost(candidate.result)).toBeLessThanOrEqual(cost(baseline.result))
    expect(cost(candidate.result)).toBeLessThanOrEqual(f.budget)
    for (const id of [f.callerId, f.partialId]) {
      expect(nodes(candidate.result).find(node => node.node_id === id)).toEqual(nodes(baseline.result).find(node => node.node_id === id))
    }
    const added = nodes(candidate.result).find(node => node.node_id === f.targetId)!
    expect(added.snippet).toContain("  if (typeof value !== 'string') {\n    throw new TypeError(typeof value)\n  }")
    expect(added.snippet).not.toContain('throw new Error("value")')
    expect(added.snippet).not.toContain('observed +=')
    expect(added.snippet).toContain('export function checkValue(value) {')
    expect(added.snippet_line_range).toEqual({ start_line: 1, end_line: f.target.length })
    const continuation = candidate.store.get(added.source_expand_handle as string) as SourceContinuationHandle
    expect(continuation.owner_range).toEqual(added.snippet_line_range)
    expect(continuation.pending_ranges).toEqual(added.snippet_omitted_ranges)
    expect(continuation.pending_ranges.length).toBeGreaterThan(0)
    expect(continuation.pending_ranges.reduce((sum, range) => sum + range.end_line - range.start_line + 1, 0)).toBe(f.target.length - 5)
    expect(object(candidate.result.pack).relationships).toContainEqual({ from_id: f.callerId, to_id: f.targetId, relation: 'calls' })
    expect(candidate.result.omitted_evidence).toEqual(baseline.result.omitted_evidence)
    const advertised = new Set(nodes(candidate.result).map(node => node.source_expand_handle).filter(Boolean))
    expect([...candidate.store.keys()].filter(id => id !== 'prior-session-entry')).toEqual([...advertised])
    for (const [id, handle] of baseline.store) expect(candidate.store.get(id)).toEqual(handle)
    expect(JSON.stringify(f.payload)).toBe(input)
    expect(object(object(candidate.result.evidence).answerability).missing_obligations).toContain('runtime:unverified')
  })

  it('abstains for quoted or negated intent and for multiple matching executable guards', () => {
    const f = fixture()
    for (const prompt of [
      'Find source in caller.mjs and conversion.mjs. The words "value type validation" are quoted examples.',
      'Find source in caller.mjs and conversion.mjs; do not include value type validation.',
      "Find source in caller.mjs and conversion.mjs. This request isn't about value type validation.",
      'Find source in caller.mjs and conversion.mjs without payload type validation and value type rejection.',
      'Find source in caller.mjs and conversion.mjs where value type validation cannot run.',
      'Find source in caller.mjs and conversion.mjs with neither value type validation nor payload type rejection.',
    ]) {
      const baseline = f.evaluate(f.payload, f.budget, false, prompt), candidate = f.evaluate(f.payload, f.budget, true, prompt)
      expect(ids(baseline.result)).not.toContain(f.targetId)
      expect(JSON.stringify(candidate.result)).toBe(JSON.stringify(baseline.result))
      expect([...candidate.store]).toEqual([...baseline.store])
    }
    const ambiguous = fixture(true), baseline = ambiguous.evaluate(ambiguous.payload, ambiguous.budget, false)
    const candidate = ambiguous.evaluate(ambiguous.payload, ambiguous.budget)
    expect(ids(baseline.result)).not.toContain(ambiguous.targetId)
    expect(JSON.stringify(candidate.result)).toBe(JSON.stringify(baseline.result))
    expect([...candidate.store]).toEqual([...baseline.store])
  })

  it('returns the exact baseline and commits no rejected recovery when whole-response fitting fails', () => {
    const f = fixture(), baseline = f.evaluate(f.payload, f.budget, false), fit = responses.fitPreparedSourceEvidenceResponse
    let rejected = 0
    vi.spyOn(responses, 'fitPreparedSourceEvidenceResponse').mockImplementation((input, budget, prepare, options) => {
      if (ids(input).includes(f.targetId)) { rejected++; return fit(input, 128, prepare, options) }
      return fit(input, budget, prepare, options)
    })
    const candidate = f.evaluate(f.payload, f.budget)
    expect(rejected).toBe(1)
    expect(JSON.stringify(candidate.result)).toBe(JSON.stringify(baseline.result))
    expect([...candidate.store]).toEqual([...baseline.store])
  })

  it('refuses a changed omitted branch rather than publishing a stale fallback or new source handle', () => {
    const f = fixture(), fit = responses.fitPreparedSourceEvidenceResponse
    let changed = false
    vi.spyOn(responses, 'fitPreparedSourceEvidenceResponse').mockImplementation((input, budget, prepare, options) => {
      const result = fit(input, budget, prepare, options)
      if (!changed && result.preparation && !ids(input).includes(f.targetId)) {
        changed = true
        const path = join(f.root, 'conversion.mjs')
        writeFileSync(path, readFileSync(path, 'utf8').replace("typeof value !== 'string'", "typeof value !== 'number'"))
      }
      return result
    })
    const candidate = f.evaluate(f.payload, f.budget)
    expect(changed).toBe(true)
    expect(nodes(candidate.result)).toEqual([])
    expect(object(object(candidate.result.evidence).answerability).state).toBe('insufficient')
    expect([...candidate.store]).toEqual([['prior-session-entry', { retained: true }]])
  })
})
