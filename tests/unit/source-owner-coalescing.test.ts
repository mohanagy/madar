import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { attachSourceContinuationHandles, completeOverlappingSourceOwners, type SourceContinuationHandle } from '../../src/runtime/source-continuation.js'
import { resolveSourceSnippet, SOURCE_EVIDENCE_RESPONSE_FORMAT } from '../../src/runtime/source-evidence-response.js'

type Value = Record<string, unknown>
type Range = { start_line: number; end_line: number }
type Node = Value & { node_id: string; label: string; source_file: string; snippet_line_range: Range; snippet_omitted_ranges?: Range[] }
const object = (value: unknown): Value => value as Value
const nodes = (payload: Value): Node[] => object(payload.pack).matched_nodes as Node[]
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

function recount(payload: Value, budget = 5000): Value {
  payload.serialized_budget = { max_tokens: budget, token_count: 0, enforced: true }
  for (let i = 0; i < 8; i++) {
    const count = estimateQueryTokens(JSON.stringify(payload))
    if (object(payload.serialized_budget).token_count === count) break
    object(payload.serialized_budget).token_count = count
  }
  return payload
}

function fixture(errorMessage = 'negative input', canonicalName?: string) {
  const root = mkdtempSync(join(tmpdir(), 'madar-coalesced-owner-')); roots.push(root)
  const lines = [
    'export function processRecords(input) {',
    '  let value = input;',
    '  const enabled = true;',
    '  if (!enabled) return null;',
    '  value = value ?? 0;',
    '  function firstStep(current) {',
    ...Array.from({ length: 30 }, (_, i) => `    current += ${i + 1};`),
    '    return current;',
    '  }',
    '  value = firstStep(value);',
    `  if (value < 0) throw new Error(${JSON.stringify(errorMessage)});`,
    '  function secondStep(current) {',
    ...Array.from({ length: 30 }, (_, i) => `    current += ${i + 101};`),
    '    return current;',
    '  }',
    '  return secondStep(value);',
    '}',
    'export function unrelatedFlag(value) {',
    ...Array.from({ length: 30 }, (_, i) => `  value += ${i + 201};`),
    '  return value;',
    '}',
  ]
  const file = join(root, 'records.mjs')
  writeFileSync(canonicalName ? join(root, canonicalName) : file, lines.join('\n'))
  if (canonicalName) symlinkSync(canonicalName, file)
  const firstStart = lines.indexOf('  function firstStep(current) {') + 1
  const secondStart = lines.indexOf('  function secondStep(current) {') + 1
  const parentEnd = lines.indexOf('export function unrelatedFlag(value) {')
  const make = (id: string, label: string, start: number, end: number, gap?: Range): Node => ({
    node_id: id, label, source_file: 'records.mjs', snippet_scope: 'symbol', line_number: start,
    snippet_line_range: { start_line: start, end_line: end },
    ...(gap ? { snippet_omitted_ranges: [gap], snippet_truncated: true } : {}),
    snippet: gap ? [...lines.slice(start - 1, gap.start_line - 1), `[omitted lines ${gap.start_line}-${gap.end_line}]`,
      ...lines.slice(gap.end_line, end)].join('\n') : lines.slice(start - 1, end).join('\n'),
    future_field: { keep: id },
  })
  const payload: Value = {
    task: 'explain', response_format: SOURCE_EVIDENCE_RESPONSE_FORMAT,
    pack: { selection_scope: 'task_context', matched_nodes: [
      make('parent', 'processRecords()', 1, parentEnd, { start_line: 4, end_line: secondStart - 1 }),
      make('first', 'firstStep()', firstStart, firstStart + 32),
      make('second', 'secondStep()', secondStart, secondStart + 32),
      make('other', 'unrelatedFlag()', parentEnd + 1, lines.length, { start_line: parentEnd + 3, end_line: lines.length - 2 }),
    ], relationships: [{ from_id: 'parent', to_id: 'first', relation: 'calls' }] },
    evidence: { answerability: { advisory: true, state: 'insufficient', answer_scope: 'partial',
      caveats: ['Other execution steps remain missing.'], broad_search_fallback: 'allowed' }, future_evidence: [1, 2] },
    governance: { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } },
    expandable: [{ handle_id: 'existing-generic-handle', future_metadata: true }],
    omitted_evidence: { reason: 'output_budget', count: 1 }, future_payload: 'preserve',
  }
  const store = new Map<string, SourceContinuationHandle>()
  const staged = attachSourceContinuationHandles(recount(payload), 5000, root, (id, handle) => store.set(id, handle))
  return { root, file, lines, parentEnd, payload: staged, store }
}

function verify(payload: Value, source: readonly string[]): Set<number> {
  const entries = nodes(payload), delivered = new Set<number>()
  for (const node of entries) {
    const expected: string[] = []
    for (let line = node.snippet_line_range.start_line; line <= node.snippet_line_range.end_line; line++) {
      const gap = node.snippet_omitted_ranges?.find(range => range.start_line === line)
      if (gap) { expected.push(`[omitted lines ${gap.start_line}-${gap.end_line}]`); line = gap.end_line }
      else { expected.push(source[line - 1]!); delivered.add(line) }
    }
    expect(resolveSourceSnippet(node, entries)).toBe(expected.join('\n'))
  }
  expect(object(payload.serialized_budget).token_count).toBe(estimateQueryTokens(JSON.stringify(payload)))
  return delivered
}

describe('complete overlapping source owners without increasing wire cost', () => {
  it('exchanges duplicated child source for missing parent lines and retires only completed recovery', () => {
    const f = fixture(), beforeText = JSON.stringify(f.payload), before = verify(f.payload, f.lines)
    expect(f.store.size).toBe(2)
    const parentHandle = f.store.get(String(nodes(f.payload)[0]!.source_expand_handle))!
    const result = completeOverlappingSourceOwners(f.payload, 5000, f.root, 'Trace record processing through both steps.')
    const after = verify(result, f.lines)
    expect(estimateQueryTokens(JSON.stringify(result))).toBeLessThan(estimateQueryTokens(beforeText))
    expect(after.size).toBeGreaterThan(before.size)
    for (const line of before) expect(after.has(line)).toBe(true)
    for (const range of parentHandle.pending_ranges) for (let line = range.start_line; line <= range.end_line; line++) expect(after.has(line)).toBe(true)
    expect(nodes(result)[0]!.snippet).toBe(f.lines.slice(0, f.parentEnd).join('\n'))
    expect(nodes(result)[0]!.source_expand_handle).toBeUndefined()
    expect(nodes(result).slice(1, 3).map(node => node.snippet_ref)).toEqual(['parent', 'parent'])
    expect(nodes(result)[3]).toEqual(nodes(f.payload)[3])
    expect(nodes(result).map(node => [node.node_id, node.label, node.future_field])).toEqual(nodes(f.payload).map(node => [node.node_id, node.label, node.future_field]))
    expect(object(result.pack).relationships).toEqual(object(f.payload.pack).relationships)
    for (const key of ['evidence', 'governance', 'expandable', 'omitted_evidence', 'future_payload']) expect(result[key]).toEqual(f.payload[key])
    expect(JSON.stringify(f.payload)).toBe(beforeText)
  })

  it('keeps source policy, drift, excluded work and non-saving or unsupported requests unchanged', () => {
    const f = fixture()
    const finish = (payload = f.payload, prompt = 'Trace record processing.', budget = 5000) => completeOverlappingSourceOwners(payload, budget, f.root, prompt)
    for (const extra of [{ verbose: true }, { mode: 'delta' }, { task: 'implement' }]) {
      const input = recount({ ...structuredClone(f.payload), ...extra })
      expect(finish(input)).toEqual(input)
    }
    const stale = structuredClone(f.payload)
    object(object(stale.governance).graph_freshness).selected_context_status = 'stale'
    recount(stale); expect(finish(stale)).toEqual(stale)
    const extended = structuredClone(f.payload), receipt = object(extended.serialized_budget)
    receipt.future_receipt = { preserve: true }
    for (let i = 0; i < 8; i++) receipt.token_count = estimateQueryTokens(JSON.stringify(extended))
    expect(finish(extended)).toEqual(extended)
    expect(finish(f.payload, 'Trace record processing, excluding secondStep.')).toEqual(f.payload)
    const single = structuredClone(f.payload)
    object(single.pack).matched_nodes = [nodes(single)[0]]
    object(single.pack).relationships = []; recount(single)
    expect(finish(single)).toEqual(single)
    expect(finish(f.payload, 'Trace record processing.', 128)).toEqual(f.payload)
    writeFileSync(f.file, f.lines.join('\n').replace('current += 101;', 'current -= 101;'))
    expect(finish()).toEqual(f.payload)
    writeFileSync(f.file, f.lines.join('\n'))
    writeFileSync(join(f.root, '.madarignore'), 'records.mjs\n')
    expect(finish()).toEqual(f.payload)
  })

  it('applies filename exclusions to source paths while retaining unrelated paths and body mentions', () => {
    const f = fixture('blocked.mjs', 'canonical.mjs')
    const finish = (instruction: string) => completeOverlappingSourceOwners(f.payload, 5000, f.root,
      `${instruction} Trace record processing through both steps.`)
    const baseline = finish('')
    expect(baseline).not.toEqual(f.payload)
    for (const instruction of ['Do not read blocked.mjs.', 'Exclude `blocked.mjs`.', 'Ignore nested/records.mjs.', 'Ignore nested/canonical.mjs.']) {
      expect(finish(instruction)).toEqual(baseline)
    }
    for (const instruction of ['Do not read records.mjs.', 'Exclude `records.mjs`.', 'Ignore **/records.mjs.', 'Exclude canonical.mjs.', 'Exclude ../records.mjs.', 'Exclude x.']) {
      expect(finish(instruction)).toEqual(f.payload)
    }
    expect(finish('Exclude negative.')).toEqual(baseline)
    expect(finish('Exclude blocked.')).toEqual(f.payload)
  })
})
