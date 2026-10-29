import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { finalizeSourceEvidenceResponse } from '../../src/runtime/source-evidence-response.js'
import { completeRequestedSymbolCandidates, requestedSourceSymbols } from '../../src/runtime/source-symbol-completion.js'
import { coherentSourceSnippet } from '../../src/runtime/retrieve/source-evidence.js'

const longFunction = (name: string): string => [
  `export function ${name}(input: { fail: boolean; count: number }) {`,
  '  let total = input.count;',
  '  if (input.fail) throw new Error("E_QUEUE_FAILURE");',
  ...Array.from({ length: 100 }, (_, index) => `  total = (total + ${index + 1}) % 65521;`),
  '  if (total < 10) return { retry: true, total };',
  '  return { retry: false, total };',
  '}',
].join('\n')

let root: string, graphPath: string
let state: Parameters<typeof handleStdioRequest>[2]
let requestId = 0
const source = longFunction('processQueue'), second = longFunction('reconcileQueue')

beforeEach(() => {
  vi.stubEnv('MADAR_TOOL_PROFILE', 'full')
  root = mkdtempSync(join(tmpdir(), 'madar-explicit-completion-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/queue.ts'), source)
  writeFileSync(join(root, 'src/reconcile.ts'), second)
  graphPath = generateGraph(root, { noHtml: true, includeDocs: false }).graphPath
  state = { logLevel: 'info', subscribedResourceUris: new Set(), resourceVersions: new Map(), resourceListSignature: null }
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

async function call(prompt: string, budget = 6000) {
  const response = await handleStdioRequest(graphPath, { id: ++requestId, method: 'tools/call', params: {
    name: 'context_pack', arguments: { prompt, task: 'explain', budget },
  } }, state)
  expect(response?.error).toBeUndefined()
  const text = (response!.result as { content: Array<{ text: string }> }).content[0]!.text
  const payload = JSON.parse(text)
  expect(payload.serialized_budget.token_count).toBe(estimateQueryTokens(text))
  expect(estimateQueryTokens(text)).toBeLessThanOrEqual(budget)
  return payload
}

describe('explicit source completion at the actual MCP wire boundary', () => {
  it('keeps source-owner keywords inside quoted data separate from explicit quoted operands', () => {
    for (const literal of ['"function foo"', "'function foo'", '`function foo`']) {
      expect(requestedSourceSymbols(`Where is ${literal} thrown?`)).toEqual([])
    }
    expect(requestedSourceSymbols('Show foo(). Diagnostic: "function missingOwner".')).toEqual(['foo'])
    expect(requestedSourceSymbols('Show function "foo".')).toEqual(['foo'])
    expect(requestedSourceSymbols('Show function `foo`.')).toEqual(['foo'])
    expect(requestedSourceSymbols('Show function "symbol".')).toEqual(['symbol'])
    expect(requestedSourceSymbols('Show foo() and missingOwner.')).toEqual(['foo', 'missingOwner'])
  })

  it('preserves fence, exclusion, path, and legacy normalization boundaries for source-owner keywords', () => {
    expect(requestedSourceSymbols('Show foo().\n~~~text\nfunction ghost\n~~~\nIgnore tests.')).toEqual(['foo'])
    expect(requestedSourceSymbols('Where is "function foo" thrown? Ignore tests.')).toEqual([])
    expect(requestedSourceSymbols('Show function "foo". Ignore function "missingOwner".')).toEqual(['foo'])
    expect(requestedSourceSymbols('Show function sourceCode/queueWorker.ts.')).toEqual([])
    expect(requestedSourceSymbols('Show function Foo .bar. Ignore tests.')).toEqual(['Foo.bar'])
  })

  it('fills a named long function on initial and cached reads without hiding evidence gaps', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const payload = await call('Show processQueue.')
      const node = payload.pack.matched_nodes.find((entry: { label: string }) => entry.label === 'processQueue()')
      expect(node.snippet).toBe(source)
      expect(node.snippet_omitted_ranges).toBeUndefined()
      expect(node.snippet_scope).toBe('symbol')
      expect(payload.evidence.answerability.advisory).toBe(true)
      expect(payload.evidence.answerability.state).not.toBe('ready')
      expect(payload.cache.status).toBe(attempt ? 'hit' : 'miss')
    }
  })

  it('completes all named owners together, and keeps original excerpts when the set does not fit', async () => {
    const prompt = 'Show processQueue and reconcileQueue.'
    const sufficient = await call(prompt)
    expect(sufficient.pack.matched_nodes.map((node: { snippet: string }) => node.snippet)).toEqual(expect.arrayContaining([source, second]))
    const constrained = await call(prompt, 1700)
    expect(constrained.pack.matched_nodes).toHaveLength(2)
    expect(constrained.pack.matched_nodes.every((node: { snippet_omitted_ranges?: unknown[] }) => node.snippet_omitted_ranges?.length)).toBe(true)
  })

  it('does not upgrade just one owner when another named symbol is unresolved', async () => {
    const payload = await call('Show processQueue and missingOwner.')
    const node = payload.pack.matched_nodes.find((entry: { label: string }) => entry.label === 'processQueue()')
    expect(node.snippet_omitted_ranges.length).toBeGreaterThan(0)
  })

  it.each(['Where is `E_QUEUE_FAILURE` thrown?', 'How does the queue retry after failures?'])(
    'leaves error-literal and unrelated prose retrieval unchanged: %s', async prompt => {
      const payload = await call(prompt)
      expect(payload.pack.matched_nodes.length).toBeGreaterThan(0)
      expect(payload.pack.matched_nodes.some((node: { snippet_omitted_ranges?: unknown[] }) => node.snippet_omitted_ranges?.length)).toBe(true)
      expect(payload.pack.matched_nodes.some((node: { snippet: string }) => node.snippet === source || node.snippet === second)).toBe(false)
    },
  )

  it('does not expand stale source even if the declaration still has the same range', async () => {
    writeFileSync(join(root, 'src/queue.ts'), source.replace('total < 10', 'total < 20'))
    const future = new Date(Date.now() + 10_000)
    utimesSync(join(root, 'src/queue.ts'), future, future)
    const payload = await call('Show processQueue.')
    expect(payload.governance.graph_freshness.selected_context_status).not.toBe('fresh')
    expect(payload.pack.matched_nodes[0].snippet_omitted_ranges.length).toBeGreaterThan(0)
  })

  it.each([
    ['Trace processQueue implementation, retry handling and its tests.', true],
    ['Trace the queue implementation, retry handling and its tests.', false],
  ] as const)('uses the stored prompt, not generic handle file focus, to authorize completion: %s', async (prompt, authorized) => {
    const payload = await call(prompt, 1700)
    const handle = payload.expandable?.find((entry: { focus_files?: string[] }) => entry.focus_files?.includes('src/queue.ts'))?.handle_id
    expect(handle).toBeTruthy()
    const response = await handleStdioRequest(graphPath, { id: ++requestId, method: 'tools/call', params: {
      name: 'context_expand', arguments: { handle_id: handle, budget: 6000 },
    } }, state)
    expect(response?.error).toBeUndefined()
    const text = (response!.result as { content: Array<{ text: string }> }).content[0]!.text
    const expanded = JSON.parse(text)
    expect(expanded.serialized_budget.token_count).toBe(estimateQueryTokens(text))
    expect(expanded.pack.matched_nodes.some((node: { snippet: string }) => node.snippet === source)).toBe(authorized)
  })

  it('preserves every source node and all obligations and rejects ambiguous or incorrect source ranges', () => {
    const lines = source.split('\n')
    const excerpt = coherentSourceSnippet(lines, { start: 1, end: lines.length }, 'Show processQueue.', 'symbol')!
    const node = { node_id: 'queue', label: 'processQueue()', source_file: 'src/queue.ts', snippet: excerpt.snippet,
      snippet_scope: 'symbol', snippet_line_range: excerpt.lineRange, snippet_omitted_ranges: excerpt.omittedRanges, snippet_truncated: true }
    const other = { node_id: 'other', label: 'unrelated', source_file: 'src/other.ts', snippet: 'existing source', snippet_unverified: true }
    writeFileSync(join(root, other.source_file), other.snippet, 'utf8')
    const input = { task: 'explain', pack: { matched_nodes: [node, other] },
      evidence: { answerability: { missing_obligations: ['query:obligation:2'], broad_search_fallback: 'blocked' }, agent_directive: 'explore_with_caution' },
      governance: { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } } }
    const baseline = finalizeSourceEvidenceResponse(input, 6000)
    const completed = finalizeSourceEvidenceResponse(input, 6000, { requestedSource: { rootPath: root, prompt: 'Show processQueue.' } })
    const pack = completed.pack as { matched_nodes: Array<Record<string, unknown>> }
    expect(pack.matched_nodes.map(entry => entry.node_id)).toEqual(['queue', 'other'])
    expect(pack.matched_nodes[1]).toEqual((baseline.pack as typeof pack).matched_nodes[1])
    expect(completed.evidence).toEqual(baseline.evidence)
    expect(pack.matched_nodes[0]!.snippet).toBe(source)
    const constrained = finalizeSourceEvidenceResponse(input, 1000)
    expect(finalizeSourceEvidenceResponse(input, 1000, { requestedSource: { rootPath: root, prompt: 'Show processQueue.' } })).toEqual(constrained)
    const incomplete = { ...input, omitted_evidence: { count: 1, reason: 'output_budget' } }
    expect(finalizeSourceEvidenceResponse(incomplete, 6000, { requestedSource: { rootPath: root, prompt: 'Show processQueue.' } }))
      .toEqual(finalizeSourceEvidenceResponse(incomplete, 6000))
    expect(completeRequestedSymbolCandidates([{ ...node, snippet_line_range: { start_line: 1, end_line: 30 } }], 'Show processQueue.', root)).toEqual([])
    expect(completeRequestedSymbolCandidates([{ ...node, snippet: node.snippet.replace('input.fail', 'input.wrong') }], 'Show processQueue.', root)).toEqual([])
    writeFileSync(join(root, 'src/duplicate.ts'), source)
    expect(completeRequestedSymbolCandidates([node, { ...node, source_file: 'src/duplicate.ts' }], 'Show processQueue.', root)).toEqual([])
    expect(requestedSourceSymbols('How does normal queue processing work?')).toEqual([])
    expect(requestedSourceSymbols('Where is `E_QUEUE_FAILURE` thrown?')).toEqual([])
    expect(requestedSourceSymbols('Where is "processQueue" logged?')).toEqual([])
    expect(requestedSourceSymbols('Where is `processQueue` logged?')).toEqual([])
    expect(requestedSourceSymbols('Show processQueue. Do not include reconcileQueue.')).toEqual(['processQueue'])
    expect(requestedSourceSymbols('Show processQueue in sourceCode/queueWorker.ts.')).toEqual(['processQueue'])
    const plainSource = longFunction('foo')
    writeFileSync(join(root, 'src/plain.ts'), plainSource)
    const plainExcerpt = coherentSourceSnippet(plainSource.split('\n'), { start: 1, end: lines.length }, 'Show foo().', 'symbol')!
    const plainNode = { ...node, label: 'foo()', source_file: 'src/plain.ts', snippet: plainExcerpt.snippet,
      snippet_line_range: plainExcerpt.lineRange, snippet_omitted_ranges: plainExcerpt.omittedRanges }
    for (const prompt of ['Show function foo and bar.', 'Show foo() and bar.', 'Show functions foo, bar and baz.']) {
      expect(requestedSourceSymbols(prompt)).toEqual([])
      expect(completeRequestedSymbolCandidates([plainNode], prompt, root)).toEqual([])
    }
    expect(completeRequestedSymbolCandidates([plainNode], 'Show function foo.', root)).toHaveLength(1)
    expect(requestedSourceSymbols('Show foo() and bar().')).toEqual(['foo', 'bar'])
  })
})
