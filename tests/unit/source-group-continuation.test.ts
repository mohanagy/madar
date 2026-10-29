import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { attachSourceGroupContinuation, expandSourceGroupContinuation, sourceGroupHandleId,
  type SourceGroupContinuation } from '../../src/runtime/source-group-continuation.js'
import type { SourceCoherentContinuationCatalog } from '../../src/runtime/retrieve/source-coherent-continuation.js'

type Range = { start_line: number; end_line: number }
type Value = Record<string, unknown>
type Node = Value & { node_id: string; snippet: string; snippet_line_range: Range; snippet_omitted_ranges?: Range[] }
const roots: string[] = []
const governance = { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } }
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const nodes = (payload: Value): Node[] => (payload.pack as { matched_nodes: Node[] } | undefined)?.matched_nodes ?? []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// Independent line oracle: the cursor's pending list is not used to decide what
// source is authentic or whether a gap was accidentally widened.
function excerpt(lines: string[], owner: Range, retained: Range[]) {
  const snippet: string[] = [], omissions: Range[] = []
  for (let line = owner.start_line; line <= owner.end_line; line++) {
    if (retained.some(r => line >= r.start_line && line <= r.end_line)) { snippet.push(lines[line - 1]!); continue }
    const start = line
    while (line < owner.end_line && !retained.some(r => line + 1 >= r.start_line && line + 1 <= r.end_line)) line++
    omissions.push({ start_line: start, end_line: line }); snippet.push(`[omitted lines ${start}-${line}]`)
  }
  return { snippet: snippet.join('\n'), snippet_omitted_ranges: omissions }
}
function visible(payload: Value, lines: string[]): Set<number> {
  const delivered = new Set<number>()
  for (const node of nodes(payload)) {
    const expected: string[] = []
    for (let line = node.snippet_line_range.start_line; line <= node.snippet_line_range.end_line; line++) {
      const gap = node.snippet_omitted_ranges?.find(r => r.start_line === line)
      if (gap) { expected.push(`[omitted lines ${gap.start_line}-${gap.end_line}]`); line = gap.end_line }
      else { expect(delivered.has(line)).toBe(false); delivered.add(line); expected.push(lines[line - 1]!) }
    }
    expect(node.snippet).toBe(expected.join('\n'))
  }
  return delivered
}
function cost(payload: Value, budget: number): void {
  const receipt = payload.serialized_budget as { token_count: number; max_tokens: number; enforced: boolean }
  expect(receipt).toEqual({ token_count: estimateQueryTokens(JSON.stringify(payload)), max_tokens: budget, enforced: true })
  expect(receipt.token_count).toBeLessThanOrEqual(budget)
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-source-group-'))); roots.push(root)
  mkdirSync(join(root, 'src'))
  const block = (name: string) => [`export function ${name}(records: number[]) {`, '  let total = records.length;',
    ...Array.from({ length: 40 }, (_, i) => `  total += ${i + 1};`), '  return total;', '}']
  const first = block('sumRecords'), second = block('countRecords')
  const lines = [...first, '', ...second, '// undisplayed tail: before']
  const file = join(root, 'src/records.ts'); writeFileSync(file, lines.join('\n'))
  const hash = sha(lines.join('\n')), a = { start_line: 1, end_line: first.length }
  const b = { start_line: first.length + 2, end_line: first.length + 1 + second.length }
  const authorized = [{ start_line: 1, end_line: 3 }, { start_line: 10, end_line: 40 }, { start_line: 43, end_line: 44 }]
  const initialRanges = [{ start_line: 1, end_line: 1 }, { start_line: 44, end_line: 44 }]
  const owners: SourceCoherentContinuationCatalog['owners'] = [
    { node_id: 'sum', label: 'sumRecords()', source_file: file, source_sha256: hash, owner_range: a,
      retained_ranges: authorized, ...excerpt(lines, a, authorized) },
    { node_id: 'count', label: 'countRecords()', source_file: file, source_sha256: hash, owner_range: b,
      retained_ranges: [b], ...excerpt(lines, b, [b]) },
  ]
  const catalog: SourceCoherentContinuationCatalog = { version: 1, bounded: true, root_path: root, real_root: root,
    configuration: { version: 1, root_path: root, real_root: root, cacheable: true,
      files: { [join(root, '.madarignore')]: 'missing', [join(root, 'tsconfig.json')]: 'missing' } },
    source_dependencies: [{ source_file: file, source_sha256: hash, canonical_file: file }], owners,
    groups: [{ anchor_ids: ['sum'], owner_ids: ['sum', 'count'] }] }
  const original: Value = { task: 'explain', response_format: 'source_evidence_v2', governance,
    pack: { selection_scope: 'task_context', matched_nodes: [{ node_id: 'sum', label: 'sumRecords()', source_file: 'src/records.ts',
      snippet_scope: 'symbol', snippet_line_range: a, ...excerpt(lines, a, initialRanges) }], relationships: [] },
    evidence: { answerability: { state: 'insufficient', answer_scope: 'partial', advisory: true,
      broad_search_fallback: 'allowed', caveats: ['The full task is not established.'] } },
    expandable: [{ handle_id: 'expand:existing', evidence_class: 'supporting', count: 1 }],
    serialized_budget: { token_count: 0, max_tokens: 500, enforced: true } }
  const stored = new Map<string, SourceGroupContinuation>()
  const initial = attachSourceGroupContinuation(original, catalog, 'Explain the source calculation.', 500,
    (id, handle) => stored.set(id, handle), root)
  const entry = [...stored][0]
  expect(entry).toBeDefined()
  return { root, file, lines, original, initial, catalog, handle: entry![1], id: entry![0], authorized: [...authorized, b] }
}

it('keeps authorized gaps closed across bounded pages, with exact costs and no repeated source', () => {
  const f = fixture(), before = JSON.stringify(f.handle)
  expect(nodes(f.initial)).toEqual(nodes(f.original))
  expect((f.initial.expandable as Value[]).at(-1)).toEqual((f.original.expandable as Value[])[0])
  cost(f.initial, 500)
  const delivered = visible(f.initial, f.lines)
  const expected = new Set(f.authorized.flatMap(r => Array.from({ length: r.end_line - r.start_line + 1 }, (_, i) => r.start_line + i)))
  let current: { handle: SourceGroupContinuation; id: string } | undefined = { handle: f.handle, id: f.id }
  let pages = 0
  while (current && pages < 2) {
    const result = expandSourceGroupContinuation(current.handle, current.id, 600, f.root, governance)
    cost(result.payload, 600)
    const page = visible(result.payload, f.lines)
    expect(page.size).toBeGreaterThan(0)
    for (const line of page) { expect(expected.has(line)).toBe(true); expect(delivered.has(line)).toBe(false); delivered.add(line) }
    expect((result.payload.pack as Value).relationships).toEqual([])
    expect((result.payload.evidence as { answerability: Value }).answerability).toMatchObject({ state: 'insufficient', answer_scope: 'partial', advisory: true })
    current = result.child; pages++
  }
  expect(pages).toBe(2)
  expect(current).toBeUndefined()
  expect([...delivered].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b))
  expect(JSON.stringify(f.handle)).toBe(before)
  const widened = structuredClone(f.handle)
  widened.pending[0]!.ranges = [{ start_line: 4, end_line: 9 }]
  expect(() => expandSourceGroupContinuation(widened, sourceGroupHandleId(widened), 600, f.root, governance)).toThrow(/scope/)
})

it('does not advance a cursor when the budget cannot fit one complete pending owner', () => {
  const f = fixture(), before = JSON.stringify(f.handle)
  const refused = expandSourceGroupContinuation(f.handle, f.id, 128, f.root, governance)
  expect(refused.payload.source_group_continuation_status).toBe('budget_insufficient')
  expect(refused.child).toBeUndefined()
  expect(nodes(refused.payload)).toEqual([])
  cost(refused.payload, 128)
  expect(JSON.stringify(f.handle)).toBe(before)
  const first = expandSourceGroupContinuation(f.handle, f.id, 600, f.root, governance)
  expect(visible(first.payload, f.lines).size).toBeGreaterThan(0)
  expect(first.child).toBeDefined()
})

it('refuses changed undisplayed source, configuration, policy and roots before producing another page', () => {
  for (const change of ['tail', 'configuration', 'policy'] as const) {
    const f = fixture(), before = JSON.stringify(f.handle)
    if (change === 'tail') writeFileSync(f.file, readFileSync(f.file, 'utf8').replace('tail: before', 'tail: after!'))
    if (change === 'configuration') writeFileSync(join(f.root, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}')
    if (change === 'policy') writeFileSync(join(f.root, '.madarignore'), '# changed policy even though source remains allowed\n')
    expect(() => expandSourceGroupContinuation(f.handle, f.id, 600, f.root, governance)).toThrow(/changed|configuration/)
    expect(JSON.stringify(f.handle)).toBe(before)
  }
  const f = fixture()
  expect(attachSourceGroupContinuation(f.original, f.catalog, 'Explain the source calculation.', 500,
    () => { throw new Error('must not register wrong-root cursor') }, join(f.root, 'src'))).toBe(f.original)
  expect(() => expandSourceGroupContinuation(f.handle, f.id, 600, join(f.root, 'src'), governance)).toThrow(/invalid|stale/)
  expect(() => expandSourceGroupContinuation(f.handle, f.id, 600, f.root,
    { graph_freshness: { status: 'stale', selected_context_status: 'stale' } })).toThrow(/invalid|stale/)
})
