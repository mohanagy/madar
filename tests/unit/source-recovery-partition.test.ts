import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { expandSourceContinuation, sourceContinuationHandleId, type SourceContinuationHandle } from '../../src/runtime/source-continuation.js'
import { verifySourceGroupInputs, type SourceGroupContinuation } from '../../src/runtime/source-group-continuation.js'
import { createSourceRecoveryPartition, filterSourceRecoveryResponse, restrictSourceRecoveryContinuation,
  verifySourceRecoveryPartition } from '../../src/runtime/source-recovery-partition.js'
import type { SourceCoherentContinuationCatalog } from '../../src/runtime/retrieve/source-coherent-continuation.js'

type Value = Record<string, unknown>
type Range = { start_line: number; end_line: number }
type Node = Value & { node_id: string; snippet: string; snippet_line_range: Range; snippet_omitted_ranges?: Range[] }
const roots: string[] = []
const governance = { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } }
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const nodes = (payload: Value): Node[] => (payload.pack as { matched_nodes: Node[] } | undefined)?.matched_nodes ?? []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// Independent line oracle; neither the partition's subtraction nor its pending
// cursor state determines the expected source emitted by these controls.
function excerpt(lines: string[], range: Range, wanted: number[]) {
  const text: string[] = [], gaps: Range[] = []
  for (let line = range.start_line; line <= range.end_line; line++) {
    if (wanted.includes(line)) { text.push(lines[line - 1]!); continue }
    const start = line
    while (line < range.end_line && !wanted.includes(line + 1)) line++
    gaps.push({ start_line: start, end_line: line }); text.push(`[omitted lines ${start}-${line}]`)
  }
  return { snippet: text.join('\n'), snippet_omitted_ranges: gaps }
}
function visible(payload: Value, lines: string[]): number[] {
  const result: number[] = []
  for (const node of nodes(payload)) {
    const expected: string[] = []
    for (let line = node.snippet_line_range.start_line; line <= node.snippet_line_range.end_line; line++) {
      const gap = node.snippet_omitted_ranges?.find(gap => gap.start_line === line)
      if (gap) { expected.push(`[omitted lines ${gap.start_line}-${gap.end_line}]`); line = gap.end_line }
      else { result.push(line); expected.push(lines[line - 1]!) }
    }
    expect(node.snippet).toBe(expected.join('\n'))
  }
  return result
}
function cost(payload: Value, max: number): void {
  expect(payload.serialized_budget).toEqual({ max_tokens: max, token_count: estimateQueryTokens(JSON.stringify(payload)), enforced: true })
  expect(estimateQueryTokens(JSON.stringify(payload))).toBeLessThanOrEqual(max)
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-recovery-partition-'))); roots.push(root)
  mkdirSync(join(root, 'src'))
  const lines = ['export function settleInvoice() {', '  const input = 1;', '  const reserved = input + 10;',
    '  const outside = input + 20;', '  return reserved + outside;', '}',
    'export function helper() {', '  return 9;', '}', '// undisplayed binding input: before']
  const file = join(root, 'src/invoice.ts'); writeFileSync(file, lines.join('\n'))
  const hash = sha(lines.join('\n')), invoice = { start_line: 1, end_line: 6 }, helper = { start_line: 7, end_line: 9 }
  const catalog: SourceCoherentContinuationCatalog = { version: 1, bounded: true, root_path: root, real_root: root,
    configuration: { version: 1, root_path: root, real_root: root, cacheable: true,
      files: { [join(root, '.madarignore')]: 'missing', [join(root, 'tsconfig.json')]: 'missing' } },
    source_dependencies: [{ source_file: file, source_sha256: hash, canonical_file: file }],
    owners: [{ node_id: 'invoice', label: 'settleInvoice()', source_file: file, source_sha256: hash, owner_range: invoice,
      retained_ranges: [{ start_line: 1, end_line: 3 }, { start_line: 6, end_line: 6 }], ...excerpt(lines, invoice, [1, 2, 3, 6]) },
    { node_id: 'helper', label: 'helper()', source_file: file, source_sha256: hash, owner_range: helper,
      retained_ranges: [helper], ...excerpt(lines, helper, [7, 8, 9]) }],
    groups: [{ anchor_ids: ['invoice'], owner_ids: ['invoice', 'helper'] }] }
  const prompt = 'Explain invoice settlement using source only.'
  const evidence = { answerability: { state: 'insufficient', answer_scope: 'partial', advisory: true,
    broad_search_fallback: 'allowed', caveats: ['External behavior remains unverified.'],
    missing_obligations: ['external behavior'], verification_targets: [{ handle_id: 'expand:partitioned-generic' }] } }
  const group: SourceGroupContinuation = { kind: 'source_group_continuation', version: 1, prompt, catalog,
    fingerprints: verifySourceGroupInputs(catalog, prompt).fingerprints,
    // Simulate a group whose initial backfill already supplied other authorized spans.
    pending: [{ owner_id: 'invoice', ranges: [{ start_line: 2, end_line: 3 }] }], evidence }
  const partition = createSourceRecoveryPartition(group, root)
  const sourceHandle: SourceContinuationHandle = { kind: 'source_continuation', version: 1, source_file: 'src/invoice.ts',
    logical_root: root, real_root: root, canonical_file: file, file_sha256: hash, owner_range: invoice,
    pending_ranges: [{ start_line: 4, end_line: 6 }], node_id: 'invoice', label: 'settleInvoice()', scope: 'symbol',
    evidence: structuredClone(evidence), task: 'explain' }
  const payload = (invoiceLines: number[], includeHelper = false): Value => ({ task: 'explain', response_format: 'source_evidence_v2', governance,
    pack: { matched_nodes: [{ node_id: 'invoice', label: 'settleInvoice()', source_file: 'src/invoice.ts', snippet_scope: 'symbol',
      snippet_line_range: invoice, ...excerpt(lines, invoice, invoiceLines) }, ...(includeHelper ? [{ node_id: 'helper', label: 'helper()',
      source_file: 'src/invoice.ts', snippet_scope: 'symbol', snippet_line_range: helper, ...excerpt(lines, helper, [7, 8, 9]) }] : [])],
    relationships: [{ from_id: 'invoice', to_id: 'helper', relation: 'calls' }] }, evidence: structuredClone(evidence) })
  return { root, file, lines, invoice, helper, group, partition, sourceHandle, payload }
}

it('partitions catalog ownership immutably, preserves outside source and withholds unsupported outgoing edges', () => {
  const f = fixture(), before = JSON.stringify(f.partition), input = f.payload([1, 2, 3, 4, 5, 6], true)
  f.group.pending = []
  f.group.catalog.owners[0]!.retained_ranges = []
  const result = filterSourceRecoveryResponse(input, f.partition, 1500, { expectedRoot: f.root, lookupSourceHandle: () => undefined })
  expect(visible(result.payload, f.lines)).toEqual([4, 5])
  expect(result.removed_node_ids).toEqual(['helper'])
  expect((result.payload.pack as Value).relationships).toEqual([])
  expect(result.payload.source_recovery).toEqual({ withheld_lines: 7, reason: 'owned_by_original_context_pack_or_group' })
  expect((result.payload.evidence as typeof f.sourceHandle.evidence).answerability).toMatchObject({
    state: 'insufficient', answer_scope: 'partial', missing_obligations: ['external behavior'],
    caveats: expect.arrayContaining(['External behavior remains unverified.']),
  })
  expect(visible(input, f.lines)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  expect(JSON.stringify(f.partition)).toBe(before)
  expect(Object.isFrozen(f.partition.catalog.owners[0]!.retained_ranges)).toBe(true)
  result.validate(); cost(result.payload, 1500)
})

it('retains a source-free row and its narrowed child, then delivers every outside-owned pending line', () => {
  const f = fixture(), original = JSON.stringify(f.sourceHandle), partitionBefore = JSON.stringify(f.partition)
  const child = restrictSourceRecoveryContinuation(f.sourceHandle, f.partition, f.root)!
  expect(child.pending_ranges).toEqual([{ start_line: 4, end_line: 5 }])
  expect(sourceContinuationHandleId(child)).not.toBe(sourceContinuationHandleId(f.sourceHandle))
  expect(child.evidence).toEqual(f.sourceHandle.evidence)
  const childId = sourceContinuationHandleId(child), input = f.payload([1, 2, 3])
  nodes(input)[0]!.source_expand_handle = childId
  input.source_continuation = { delivered_lines: 3, remaining_lines: 3 }
  const filtered = filterSourceRecoveryResponse(input, f.partition, 1500, { expectedRoot: f.root,
    lookupSourceHandle: id => id === childId ? child : undefined })
  expect(visible(filtered.payload, f.lines)).toEqual([])
  expect(nodes(filtered.payload)).toHaveLength(1)
  expect(nodes(filtered.payload)[0]!.source_expand_handle).toBe(childId)
  expect(filtered.payload.source_continuation).toEqual({ delivered_lines: 0, remaining_lines: 2 })
  const expanded = expandSourceContinuation(child, 1500, f.root, governance)
  expect(expanded.child).toBeUndefined()
  const final = filterSourceRecoveryResponse(expanded.payload, f.partition, 1500,
    { expectedRoot: f.root, lookupSourceHandle: () => undefined })
  expect(visible(final.payload, f.lines)).toEqual([4, 5])
  expect(restrictSourceRecoveryContinuation({ ...f.sourceHandle, node_id: 'helper', label: 'helper()',
    owner_range: f.helper, pending_ranges: [f.helper] }, f.partition, f.root)).toBeUndefined()
  expect(JSON.stringify(f.sourceHandle)).toBe(original)
  expect(JSON.stringify(f.partition)).toBe(partitionBefore)
  cost(filtered.payload, 1500); cost(final.payload, 1500)
})

it('refuses changes to hidden source, configuration, policy or root without returning unfiltered source', () => {
  for (const change of ['source', 'configuration', 'policy'] as const) {
    const f = fixture(), before = JSON.stringify(f.partition)
    if (change === 'source') writeFileSync(f.file, readFileSync(f.file, 'utf8').replace('input: before', 'input: after!'))
    if (change === 'configuration') writeFileSync(join(f.root, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}')
    if (change === 'policy') writeFileSync(join(f.root, '.madarignore'), '# changed policy\n')
    expect(() => filterSourceRecoveryResponse(f.payload([1, 2, 3]), f.partition, 1500,
      { expectedRoot: f.root, lookupSourceHandle: () => undefined })).toThrow()
    expect(() => restrictSourceRecoveryContinuation(f.sourceHandle, f.partition, f.root)).toThrow()
    expect(JSON.stringify(f.partition)).toBe(before)
  }
  const f = fixture()
  expect(() => verifySourceRecoveryPartition(f.partition, join(f.root, 'src'))).toThrow(/identity/)
})

it('preserves the authenticated 128-token insufficient envelope without advancing its source cursor', () => {
  const f = fixture(), source = structuredClone(f.sourceHandle)
  source.evidence = { answerability: { state: 'insufficient', answer_scope: 'partial', advisory: true,
    broad_search_fallback: 'allowed', caveats: ['An unresolved obligation remains. '.repeat(300)] } }
  const child = restrictSourceRecoveryContinuation(source, f.partition, f.root)!, before = JSON.stringify(child)
  const refused = expandSourceContinuation(child, 128, f.root, governance)
  expect(refused.payload.source_continuation_status).toBe('budget_insufficient')
  expect(refused.payload.response_format).toBeUndefined()
  expect(refused.child).toBeUndefined()
  const result = filterSourceRecoveryResponse(refused.payload, f.partition, 128,
    { expectedRoot: f.root, lookupSourceHandle: () => undefined })
  expect(result.payload).toEqual(refused.payload)
  expect(result.changed_node_ids).toEqual([])
  expect(result.removed_node_ids).toEqual([])
  expect(JSON.stringify(child)).toBe(before)
  expect(() => filterSourceRecoveryResponse({ ...refused.payload, source_expand_handle: 'unknown' }, f.partition, 128,
    { expectedRoot: f.root, lookupSourceHandle: () => undefined })).toThrow(/unsupported/)
  cost(result.payload, 128)
})
