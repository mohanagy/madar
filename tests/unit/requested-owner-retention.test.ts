import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { lineRangeFromSourceLocation } from '../../src/shared/source-location.js'
import { selectSourceDependencies } from '../../src/runtime/retrieve/source-dependencies.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import * as responses from '../../src/runtime/source-evidence-response.js'
import * as containerBudget from '../../src/runtime/source-container-budget.js'
import * as continuations from '../../src/runtime/source-continuation.js'
import type { SourceContinuationHandle } from '../../src/runtime/source-continuation.js'

type RecordValue = Record<string, unknown>
type Range = { start_line: number; end_line: number }
type SourceNode = RecordValue & { node_id: string; source_file: string; snippet_line_range: Range; snippet_omitted_ranges?: Range[] }
const roots: string[] = []
const object = (value: unknown): RecordValue => value as RecordValue
const nodes = (value: RecordValue): SourceNode[] => (object(value.pack ?? {}).matched_nodes ?? []) as SourceNode[]
const ids = (value: RecordValue): string[] => nodes(value).map(node => node.node_id)
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'madar-owner-retention-')); roots.push(root)
  const records = [
    'export function createRegistry(enabled = true) {',
    '  let bookkeeping = 0;',
    ...Array.from({ length: 48 }, (_, i) => `  bookkeeping += ${i + 1};`),
    '  function sendItem(value) {',
    '    return value.trim();',
    '  }',
    ...Array.from({ length: 48 }, (_, i) => `  bookkeeping += ${i + 100};`),
    '  return sendItem;',
    '}',
  ]
  const format = [
    'export function formatItem(value) {',
    '  let length = value.length;',
    ...Array.from({ length: 28 }, (_, i) => `  length += ${i + 200};`),
    '  return length;',
    '}',
  ]
  writeFileSync(join(root, 'records.mjs'), records.join('\n'))
  writeFileSync(join(root, 'format.mjs'), format.join('\n'))
  const omission = { start_line: 51, end_line: records.length - 2 }
  const payload: RecordValue = {
    task: 'explain',
    pack: { selection_scope: 'task_context', matched_nodes: [
      { node_id: 'outer', label: 'createRegistry()', source_file: 'records.mjs', line_number: 1,
        snippet_scope: 'symbol', snippet_line_range: { start_line: 1, end_line: records.length },
        snippet_omitted_ranges: [omission], snippet_truncated: true,
        snippet: [...records.slice(0, omission.start_line - 1), `[omitted lines ${omission.start_line}-${omission.end_line}]`, ...records.slice(omission.end_line)].join('\n') },
      { node_id: 'child', label: 'sendItem()', source_file: 'records.mjs', line_number: 51,
        snippet_scope: 'symbol', snippet_line_range: { start_line: 51, end_line: 53 }, snippet: records.slice(50, 53).join('\n') },
      { node_id: 'formatter', label: 'formatItem()', source_file: 'format.mjs', line_number: 1,
        snippet_scope: 'symbol', snippet_line_range: { start_line: 1, end_line: format.length }, snippet: format.join('\n') },
    ], relationships: [{ from_id: 'outer', to_id: 'child', relation: 'contains' }] },
    evidence: { answerability: { advisory: true, missing_obligations: ['behavior:external-runtime'],
      caveats: ['Static source does not prove invocation.'], broad_search_fallback: 'allowed' },
      discovery_exclusions: { relevant: 0, total: 0 } },
    governance: { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } },
  }
  return { root, records, format, payload,
    prompt: 'Trace item delivery through records.mjs and format.mjs.' }
}

function verifySource(value: RecordValue, root: string): void {
  const entries = nodes(value)
  for (const node of entries) {
    const source = readFileSync(resolve(root, node.source_file), 'utf8').split(/\r?\n/)
    const expected: string[] = []
    for (let line = node.snippet_line_range.start_line; line <= node.snippet_line_range.end_line; line++) {
      const gap = (node.snippet_omitted_ranges ?? []).find(gap => gap.start_line === line)
      if (gap) { expected.push(`[omitted lines ${gap.start_line}-${gap.end_line}]`); line = gap.end_line }
      else expected.push(source[line - 1]!)
    }
    expect(responses.resolveSourceSnippet(node, entries)).toBe(expected.join('\n'))
  }
  const present = new Set(ids(value))
  for (const edge of (object(value.pack ?? {}).relationships ?? []) as RecordValue[]) {
    if (edge.from_id) expect(present.has(String(edge.from_id))).toBe(true)
    if (edge.to_id) expect(present.has(String(edge.to_id))).toBe(true)
  }
}
function finish(f: ReturnType<typeof fixture>, budget: number, prompt = f.prompt, eligible = true): RecordValue {
  const value = responses.finalizeSourceEvidenceResponse(f.payload, budget,
    eligible ? { requestedSource: { rootPath: f.root, prompt } } : {})
  const actual = estimateQueryTokens(JSON.stringify(value))
  expect(value.serialized_budget).toEqual({ max_tokens: budget, token_count: actual, enforced: true })
  expect(actual).toBeLessThanOrEqual(budget)
  return value
}
function pressureBudget(f: ReturnType<typeof fixture>): number {
  const firstTwo = structuredClone(f.payload)
  object(firstTwo.pack).matched_nodes = nodes(firstTwo).slice(0, 2)
  return estimateQueryTokens(JSON.stringify(responses.finalizeSourceEvidenceResponse(firstTwo, 10000))) + 100
}

describe('requested owner retention at the final serialized budget', () => {
  it('retains specific owners from two named files instead of an unrequested enclosing excerpt', () => {
    const f = fixture(), budget = pressureBudget(f), before = JSON.stringify(f.payload)
    const baseline = finish(f, budget, f.prompt, false)
    expect(ids(baseline)).toContain('outer')
    expect(ids(baseline)).not.toContain('formatter')
    const result = finish(f, budget)
    expect(ids(result)).toEqual(['child', 'formatter'])
    verifySource(result, f.root)
    expect(object(object(result.evidence).answerability).missing_obligations).toContain('behavior:external-runtime')
    expect(object(object(result.evidence).answerability).caveats).toContain('Static source does not prove invocation.')
    expect(object(object(result.evidence).answerability).state).not.toBe('ready')
    expect(result.omitted_evidence).toBeDefined()
    expect(JSON.stringify(f.payload)).toBe(before)
  })

  it('protects explicit outer symbols, unique plain-prose guards, references and unverifiable identities', () => {
    const f = fixture(), budget = pressureBudget(f)
    const explicit = finish(f, budget, 'Trace createRegistry() delivery through records.mjs and format.mjs.')
    expect(ids(explicit)).toContain('outer')
    const originalFormat = f.format[1]!
    f.format[1] = '  const createRegistry = value; let length = createRegistry.length;'
    writeFileSync(join(f.root, 'format.mjs'), f.format.join('\n'))
    nodes(f.payload)[2]!.snippet = f.format.join('\n')
    expect(ids(finish(f, budget, 'Trace Registry.createRegistry() through records.mjs and format.mjs.'))).toContain('outer')
    f.format[1] = originalFormat
    writeFileSync(join(f.root, 'format.mjs'), f.format.join('\n'))
    nodes(f.payload)[2]!.snippet = f.format.join('\n')
    const original = structuredClone(f.payload)
    f.records[1] = '  if (!enabled) return;'
    writeFileSync(join(f.root, 'records.mjs'), f.records.join('\n'))
    nodes(f.payload)[0]!.snippet = String(nodes(f.payload)[0]!.snippet).replace('  let bookkeeping = 0;', f.records[1]!)
    expect(ids(finish(f, budget, 'Trace item delivery when enabled through records.mjs and format.mjs.'))).toContain('outer')
    f.payload = original
    writeFileSync(join(f.root, 'records.mjs'), f.records.map((line, index) => index === 1 ? '  let bookkeeping = 0;' : line).join('\n'))
    const ref: SourceNode = { ...nodes(f.payload)[0]!, node_id: 'outer-ref', snippet_ref: 'outer' }
    delete ref.snippet
    nodes(f.payload).splice(1, 0, ref)
    expect(ids(finish(f, budget))).toContain('outer')
    f.payload = structuredClone(original)
    nodes(f.payload)[0]!.label = 'notTheCurrentDeclaration()'
    expect(finish(f, budget)).toEqual(finish(f, budget, f.prompt, false))
    f.payload = structuredClone(original)
    nodes(f.payload)[0]!.snippet = String(nodes(f.payload)[0]!.snippet).replace('bookkeeping += 1;', 'bookkeeping += 9;')
    expect(finish(f, budget)).toEqual(finish(f, budget, f.prompt, false))
  })

  it('leaves single-file, excluded-path and stale requests conservative and reports impossible budgets', () => {
    const f = fixture(), budget = pressureBudget(f)
    for (const prompt of ['Trace item delivery through records.mjs.', 'Trace item delivery.',
      'Trace item delivery through records.mjs, excluding format.mjs.']) {
      expect(finish(f, budget, prompt)).toEqual(finish(f, budget, prompt, false))
    }
    writeFileSync(join(f.root, '.madarignore'), 'records.mjs\n')
    const beforeExcluded = JSON.stringify(f.payload), excluded = finish(f, budget)
    expect(ids(excluded)).toEqual([])
    expect(excluded.expandable ?? []).toEqual([])
    expect(excluded.omitted_evidence).toMatch(/current policy/)
    expect(object(object(excluded.evidence).answerability)).toMatchObject({ state: 'insufficient', advisory: true })
    expect(JSON.stringify(f.payload)).toBe(beforeExcluded)
    rmSync(join(f.root, '.madarignore'))
    object(f.payload.pack).retrieval_strategy = 'slice-v1'
    expect(finish(f, budget)).toEqual(finish(f, budget, f.prompt, false))
    delete object(f.payload.pack).retrieval_strategy
    object(object(f.payload.governance).graph_freshness).selected_context_status = 'stale'
    expect(finish(f, budget)).toEqual(finish(f, budget, f.prompt, false))
    object(object(f.payload.evidence).answerability).broad_search_fallback = 'blocked'
    const minimal = finish(f, 128)
    expect(minimal.omitted_evidence).toBeDefined()
    expect(object(object(minimal.evidence).answerability).broad_search_fallback).toBe('blocked')
  })

  it('uses the same selection preference through the strict MCP final boundary', async () => {
    vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
    const f = fixture()
    const graphPath = generateGraph(f.root, { noHtml: true, includeDocs: false }).graphPath
    const original = containerBudget.sourceContainerBudgetPreference
    const preferredIds: string[] = []
    vi.spyOn(containerBudget, 'sourceContainerBudgetPreference').mockImplementation((prompt, rootPath) => {
      const preference = original(prompt, rootPath)
      return entries => {
        const id = preference(entries)
        if (id) preferredIds.push(id)
        return id
      }
    })
    const response = await handleStdioRequest(graphPath, { id: 1, method: 'tools/call', params: { name: 'context_pack', arguments: {
      prompt: f.prompt, task: 'explain', budget: 900,
    } } })
    expect(response?.error).toBeUndefined()
    const text = (response!.result as { content: Array<{ text: string }> }).content[0]!.text
    const payload = JSON.parse(text) as RecordValue
    verifySource(payload, f.root)
    expect(object(payload.serialized_budget).token_count).toBe(estimateQueryTokens(text))
    expect(estimateQueryTokens(text)).toBeLessThanOrEqual(900)
    expect(preferredIds).toContain('records_createregistry')
    expect(ids(payload)).not.toContain('records_createregistry')
    expect(ids(payload)).toContain('records_createregistry_senditem')
    expect(nodes(payload).some(node => node.source_file.endsWith('format.mjs'))).toBe(true)
    expect(object(object(payload.evidence).answerability).state).not.toBe('ready')
  })

  it('trades only a disconnected helper for an atomic callsite bundle and preserves rejected staged handles', () => {
    const build = (compactHelper = false) => {
      const root = mkdtempSync(join(tmpdir(), 'madar-callsite-owner-trade-')); roots.push(root)
      const lines = [
        'import { normalizeRecord } from "./policy.mjs";',
        'export function processRecords(records, enabled) {',
        '  let total = 0;',
        ...Array.from({ length: 40 }, (_, i) => `  total += ${i + 1};`),
        '  if (enabled) {',
        '    total = normalizeRecord(',
        '      total',
        ...Array.from({ length: 24 }, (_, i) => `      + ${i + 1}`),
        '    );',
        '  }',
        ...Array.from({ length: 40 }, (_, i) => `  total += ${i + 100};`),
        '  records.forEach((record) => {',
        '    if (record > 0) {',
        '      total = normalizeRecord(',
        '        record',
        ...Array.from({ length: 24 }, (_, i) => `        + ${i + 200}`),
        '      );',
        '    }',
        '  });',
        '  return total;',
        '}',
      ]
      const policy = [
        'export function normalizeRecord(value) { return value + 1; }',
        ...(compactHelper ? ['export function optionalHelper(value) { return value; }'] : [
          'export function optionalHelper(value) {',
          ...Array.from({ length: 80 }, (_, i) => `  value += ${i + 300};`),
          '  return value;',
          '}',
        ]),
      ]
      const file = join(root, 'records.mjs'), policyFile = join(root, 'policy.mjs')
      writeFileSync(file, lines.join('\n')); writeFileSync(policyFile, policy.join('\n'))
      const fragments = [extractJs(file), extractJs(policyFile)]
      const graph = buildFromJson({ schema_version: 1, nodes: fragments.flatMap(fragment => fragment.nodes),
        edges: fragments.flatMap(fragment => fragment.edges) }, { directed: true })
      graph.graph.root_path = root
      const entry = (name: string) => graph.nodeEntries().find(([, node]) => node.label === `${name}()` )!
      const [caller] = entry('processRecords'), [callee] = entry('normalizeRecord'), [helper] = entry('optionalHelper')
      const sourceNode = (name: string, source: string[], sourceFile: string): SourceNode => {
        const [id, node] = entry(name), range = lineRangeFromSourceLocation(node.source_location)!
        return { node_id: id, label: `${name}()`, source_file: sourceFile, snippet_scope: 'symbol',
          snippet_line_range: { start_line: range.start, end_line: range.end }, snippet: source.slice(range.start - 1, range.end).join('\n') }
      }
      const owner = sourceNode('processRecords', lines, file)
      const gap = { start_line: owner.snippet_line_range.start_line + 2, end_line: owner.snippet_line_range.end_line - 2 }
      owner.snippet_omitted_ranges = [gap]; owner.snippet_truncated = true
      owner.snippet = [...lines.slice(owner.snippet_line_range.start_line - 1, gap.start_line - 1),
        `[omitted lines ${gap.start_line}-${gap.end_line}]`, ...lines.slice(gap.end_line)].join('\n')
      const payload: RecordValue = {
        task: 'explain', response_format: responses.SOURCE_EVIDENCE_RESPONSE_FORMAT,
        pack: { selection_scope: 'task_context', matched_nodes: [owner, sourceNode('normalizeRecord', policy, policyFile),
          sourceNode('optionalHelper', policy, policyFile)], relationships: [{ from_id: caller, to_id: callee, relation: 'calls' }] },
        evidence: { answerability: { advisory: true, caveats: ['Invocation remains unverified.'], broad_search_fallback: 'allowed' } },
        governance: { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } }, omitted_evidence: 'output_budget',
      }
      const bundles = (selectSourceDependencies(graph, [caller], root, new Map(),
        { includeCallers: false, inspectionOnly: true }).source_callsite_bundles ?? []).filter(bundle => bundle.from_id === caller && bundle.to_id === callee)
      expect(bundles).toHaveLength(1); expect(bundles[0]!.sites).toHaveLength(2)
      return { root, payload, bundles, caller, callee, helper,
        prompt: 'Trace processRecords() and normalizeRecord() through records.mjs and policy.mjs.' }
    }
    const finishCallsite = (f: ReturnType<typeof build>, budget: number, request?: { prompt: string }, bundles = f.bundles) => {
      const input = structuredClone(f.payload), store = new Map<string, SourceContinuationHandle>()
      input.serialized_budget = { max_tokens: budget, token_count: 0, enforced: true }
      for (let i = 0; i < 12; i++) {
        const count = estimateQueryTokens(JSON.stringify(input))
        if (object(input.serialized_budget).token_count === count) break
        object(input.serialized_budget).token_count = count
      }
      const payload = continuations.finalizeSourceCallsiteCompletion(input, budget, f.root, bundles,
        (id, handle) => store.set(id, handle), () => true, request)
      expect(object(payload.serialized_budget).token_count).toBe(estimateQueryTokens(JSON.stringify(payload)))
      expect(estimateQueryTokens(JSON.stringify(payload))).toBeLessThanOrEqual(budget)
      return { payload, store }
    }
    const baselineBudget = (f: ReturnType<typeof build>) => {
      let budget = estimateQueryTokens(JSON.stringify(finishCallsite(f, 10000, undefined, []).payload))
      for (let i = 0; i < 12; i++) {
        const count = estimateQueryTokens(JSON.stringify(finishCallsite(f, budget, undefined, []).payload))
        if (count === budget) return budget
        budget = count
      }
      throw new Error('Baseline callsite budget did not stabilize')
    }
    const f = build(), before = JSON.stringify(f.payload), budget = baselineBudget(f)
    const baseline = finishCallsite(f, budget, undefined, []), appendOnly = finishCallsite(f, budget)
    expect(baseline.store.size).toBe(1)
    expect(appendOnly).toEqual(baseline)
    const result = finishCallsite(f, budget, { prompt: f.prompt })
    expect(ids(result.payload)).toEqual([f.caller, f.callee])
    verifySource(result.payload, f.root)
    const owner = nodes(result.payload).find(node => node.node_id === f.caller)!
    for (const range of f.bundles[0]!.ranges) for (let line = range.start_line; line <= range.end_line; line++) {
      expect((owner.snippet_omitted_ranges ?? []).some(gap => gap.start_line <= line && gap.end_line >= line)).toBe(false)
    }
    expect(object(result.payload.pack).relationships).toEqual(object(f.payload.pack).relationships)
    const answerability = object(object(result.payload.evidence).answerability)
    expect(answerability.caveats).toContain('Invocation remains unverified.')
    expect(answerability.broad_search_fallback).toBe('allowed')
    expect(answerability.state).not.toBe('ready')
    expect([...result.store.keys()]).toEqual(nodes(result.payload).flatMap(node => typeof node.source_expand_handle === 'string' ? [node.source_expand_handle] : []))
    expect(finishCallsite(f, budget, { prompt: `${f.prompt} Include optionalHelper().` })).toEqual(baseline)
    expect(JSON.stringify(f.payload)).toBe(before)
    const small = build(true), smallBudget = baselineBudget(small)
    const smallBaseline = finishCallsite(small, smallBudget, undefined, [])
    expect(smallBaseline.store.size).toBe(1)
    const smallerTrial = responses.omitDisconnectedSourceForCallsite(small.payload, { rootPath: small.root, prompt: small.prompt })
    expect(smallerTrial).toBeDefined()
    expect(ids(smallerTrial!)).toEqual([small.caller, small.callee])
    expect(finishCallsite(small, smallBudget, { prompt: small.prompt })).toEqual(smallBaseline)
  })
})
