import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { finalizeSourceEvidenceResponse } from '../../src/runtime/stdio/tools.js'
import * as responses from '../../src/runtime/source-evidence-response.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { type SourceContinuationHandle } from '../../src/runtime/source-continuation.js'

type Value = Record<string, unknown>
type Range = { start_line: number; end_line: number }
const roots: string[] = []
const object = (value: unknown): Value => value as Value
const nodes = (value: Value): Value[] => (object(value.pack ?? {}).matched_nodes ?? []) as Value[]
const ids = (value: Value): unknown[] => nodes(value).map(node => node.node_id)
const cost = (value: Value): number => estimateQueryTokens(JSON.stringify(value))
const linesOf = (ranges: readonly Range[]): number[] => ranges.flatMap(r => Array.from({ length: r.end_line - r.start_line + 1 }, (_, i) => r.start_line + i))
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })

function fixture(ambiguous = false) {
  const root = mkdtempSync(join(tmpdir(), 'madar-bracketed-branch-')); roots.push(root)
  const target = ['export function dispatch(value) {', '  if (value !== null) {'], gaps: Range[] = []
  for (const key of ambiguous ? ['enabled', 'ready'] : ['enabled']) {
    const start = target.length + 1
    target.push(`    if (value.${key}) {`, '      if (!value.label) {', "        value.label = 'ready'", '      }',
      '      const selected = value.inner', '        ? value.inner', '        : value', '      useValue(selected)',
      '      return value', '    }')
    gaps.push({ start_line: start + 1, end_line: start + 7 })
  }
  target.push('  }')
  const tailStart = target.length + 1
  target.push(...Array.from({ length: 90 }, (_, i) => `  value.sequence += ${i}`))
  gaps.push({ start_line: tailStart, end_line: target.length })
  target.push('  return value', '}')
  const partial = ['export function retain(value) {', ...Array.from({ length: 30 }, (_, i) => `  value += ${i};`), '  return value;', '}']
  const outside = ['export function bookkeeping(value) {', ...Array.from({ length: 48 }, (_, i) => `  value += ${i};`), '  return value;', '}']
  const distractor = ['export function unrelated(value) {', ...Array.from({ length: 120 }, (_, i) => `  value += ${i};`), '  return value;', '}']
  const source: Record<string, string[]> = { 'entry.mjs': target, 'companion.mjs': partial, 'context.mjs': outside, 'unrelated.mjs': distractor }
  for (const [file, lines] of Object.entries(source)) writeFileSync(join(root, file), lines.join('\n'))
  const names = ['dispatch', 'retain', 'bookkeeping', 'unrelated'], nodeIds = ['entry_dispatch', 'partial', 'outside', 'unrelated']
  const entries = Object.entries(source).map(([file, lines], index) => ({ node_id: nodeIds[index], label: `${names[index]}()`,
    source_file: file, line_number: 1, snippet_scope: 'symbol', snippet_line_range: { start_line: 1, end_line: lines.length },
    snippet: lines.join('\n') } as Value))
  const render = (lines: readonly string[], omitted: readonly Range[]): string => {
    const result: string[] = []
    for (let line = 1; line <= lines.length; line++) {
      const gap = omitted.find(range => range.start_line === line)
      if (gap) { result.push(`[omitted lines ${gap.start_line}-${gap.end_line}]`); line = gap.end_line }
      else result.push(lines[line - 1]!)
    }
    return result.join('\n')
  }
  Object.assign(entries[0]!, { snippet: render(target, gaps), snippet_truncated: true, snippet_omitted_ranges: gaps })
  Object.assign(entries[1]!, { snippet: render(partial, [{ start_line: 2, end_line: 31 }]),
    snippet_truncated: true, snippet_omitted_ranges: [{ start_line: 2, end_line: 31 }] })
  const payload: Value = { task: 'explain', response_format: 'source_evidence_v2',
    pack: { selection_scope: 'task_context', matched_nodes: entries, relationships: [] },
    evidence: { answerability: { advisory: true, broad_search_fallback: 'allowed', missing_obligations: ['runtime:unverified'] } },
    governance: { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } } }
  const evaluate = (input: Value, budget: number, enabled = true, prompt = 'Find runtime source for dispatch() value handling in entry.mjs and companion.mjs.') => {
    const store = new Map<string, unknown>([['prior-session-entry', { retained: true }]])
    const result = finalizeSourceEvidenceResponse(input, budget, {
      requestedSource: { rootPath: root, prompt },
      ...(enabled ? { callsites: { bundles: [], configurationFresh: () => true } } : {}),
      continuations: { rootPath: root, store: (id: string, handle: SourceContinuationHandle) => { store.set(id, handle) } },
    })
    return { result, store }
  }
  const subset = structuredClone(payload)
  object(subset.pack).matched_nodes = nodes(subset).slice(0, 3)
  const budget = cost(evaluate(subset, 10000, false).result) + 100
  return { root, payload, budget, evaluate, gaps, target }
}

describe('completing one original bracketed source branch', () => {
  it('fills the full interior, rekeys authenticated pending source, and accounts for the single removed owner', () => {
    const f = fixture(), input = JSON.stringify(f.payload), baseline = f.evaluate(f.payload, f.budget, false)
    expect(ids(baseline.result)).toContain('outside')
    expect(ids(baseline.result)).not.toContain('unrelated')
    const original = nodes(baseline.result).find(node => node.node_id === 'entry_dispatch')!
    expect(original.snippet).not.toContain('useValue(selected)')
    const candidate = f.evaluate(f.payload, f.budget), completed = nodes(candidate.result).find(node => node.node_id === 'entry_dispatch')!
    expect(ids(candidate.result)).not.toContain('outside')
    expect(completed.snippet).toContain("      if (!value.label) {\n        value.label = 'ready'\n      }\n      const selected = value.inner\n        ? value.inner\n        : value\n      useValue(selected)\n      return value")
    for (const key of ['node_id', 'label', 'source_file', 'line_number', 'snippet_line_range']) expect(completed[key]).toEqual(original[key])
    expect(completed.snippet_omitted_ranges).toEqual(f.gaps.slice(1))
    expect(completed.source_expand_handle).not.toBe(original.source_expand_handle)
    const oldHandle = baseline.store.get(original.source_expand_handle as string) as SourceContinuationHandle
    const newHandle = candidate.store.get(completed.source_expand_handle as string) as SourceContinuationHandle
    expect(newHandle).toEqual({ ...oldHandle, pending_ranges: newHandle.pending_ranges })
    expect(linesOf(newHandle.pending_ranges)).toEqual(linesOf(oldHandle.pending_ranges).filter(line => !linesOf([f.gaps[0]!]).includes(line)))
    expect(nodes(candidate.result).find(node => node.node_id === 'partial')).toEqual(nodes(baseline.result).find(node => node.node_id === 'partial'))
    expect(object(candidate.result.pack).relationships).toEqual(object(baseline.result.pack).relationships)
    expect(candidate.result.omitted_evidence).toEqual({ ...object(baseline.result.omitted_evidence), count: Number(object(baseline.result.omitted_evidence).count) + 1 })
    expect(cost(candidate.result)).toBeLessThanOrEqual(cost(baseline.result))
    expect(cost(candidate.result)).toBeLessThanOrEqual(f.budget)
    const advertised = new Set(nodes(candidate.result).map(node => node.source_expand_handle).filter(Boolean))
    expect([...candidate.store.keys()].filter(id => id !== 'prior-session-entry')).toEqual([...advertised])
    expect(candidate.store.has(original.source_expand_handle as string)).toBe(false)
    expect(candidate.store.get('prior-session-entry')).toEqual({ retained: true })
    expect(JSON.stringify(f.payload)).toBe(input)
    expect(object(object(candidate.result.evidence).answerability).missing_obligations).toContain('runtime:unverified')
  })

  it('abstains without an exact requested owner or when more than one original branch qualifies', () => {
    const f = fixture(), prompt = 'Find runtime source for value handling in entry.mjs and companion.mjs.'
    const baseline = f.evaluate(f.payload, f.budget, false, prompt), candidate = f.evaluate(f.payload, f.budget, true, prompt)
    expect(JSON.stringify(candidate.result)).toBe(JSON.stringify(baseline.result))
    expect([...candidate.store]).toEqual([...baseline.store])
    const ambiguous = fixture(true), prior = ambiguous.evaluate(ambiguous.payload, ambiguous.budget, false)
    const unchanged = ambiguous.evaluate(ambiguous.payload, ambiguous.budget)
    expect(JSON.stringify(unchanged.result)).toBe(JSON.stringify(prior.result))
    expect([...unchanged.store]).toEqual([...prior.store])
  })

  it('retains exact baseline bytes and handles if completed source and recovery cannot fit', () => {
    const f = fixture(), baseline = f.evaluate(f.payload, f.budget, false), fit = responses.fitPreparedSourceEvidenceResponse
    let rejected = 0
    vi.spyOn(responses, 'fitPreparedSourceEvidenceResponse').mockImplementation((input, budget, prepare, options) => {
      if (String(nodes(input).find(node => node.node_id === 'entry_dispatch')?.snippet).includes('useValue(selected)')) {
        rejected++; return fit(input, 128, prepare, options)
      }
      return fit(input, budget, prepare, options)
    })
    const candidate = f.evaluate(f.payload, f.budget)
    expect(rejected).toBe(1)
    expect(JSON.stringify(candidate.result)).toBe(JSON.stringify(baseline.result))
    expect([...candidate.store]).toEqual([...baseline.store])
  })

  it('refuses hidden source drift before replacing the authenticated original continuation', () => {
    const f = fixture(), fit = responses.fitPreparedSourceEvidenceResponse
    let changed = false
    vi.spyOn(responses, 'fitPreparedSourceEvidenceResponse').mockImplementation((input, budget, prepare, options) => {
      const result = fit(input, budget, prepare, options)
      if (!changed && result.preparation) {
        changed = true
        const path = join(f.root, 'entry.mjs')
        writeFileSync(path, readFileSync(path, 'utf8').replace("value.label = 'ready'", "value.label = 'changed'"))
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
