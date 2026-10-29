import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { fitPreparedSourceEvidenceResponse, resolveSourceSnippet, SOURCE_EVIDENCE_RESPONSE_FORMAT } from '../../src/runtime/source-evidence-response.js'
import * as evidenceResponses from '../../src/runtime/source-evidence-response.js'
import { finalizeSourceEvidenceResponse as finalizeWithRecovery } from '../../src/runtime/stdio/tools.js'
import {
  attachSourceContinuationHandles, createSourceContinuationPreparation, expandSourceContinuation, type SourceContinuationHandle,
} from '../../src/runtime/source-continuation.js'

type Range = { start_line: number; end_line: number }
type SourceNode = Record<string, unknown> & {
  node_id: string; label: string; source_file: string
  snippet_line_range: Range; snippet_omitted_ranges?: Range[]; source_expand_handle?: string
}
type Payload = Record<string, unknown> & {
  pack?: { matched_nodes?: SourceNode[]; relationships?: Array<Record<string, unknown>>; selection_scope?: string }
  evidence: Record<string, unknown>
  serialized_budget: { max_tokens: number; token_count: number; enforced: boolean }
  cache?: { status: string }
  expandable?: Array<{ handle_id: string }>
  source_continuation_status?: string
}
let root: string, graphPath: string
let state: NonNullable<Parameters<typeof handleStdioRequest>[2]>
let requestId = 0
const sourceLines = (name = 'processRecords') => [
  `export function ${name}(records: number[]) {`,
  '  let total = records.length;',
  ...Array.from({ length: 200 }, (_, i) => `  total += ${i + 1};`),
  '  if (total < 0) throw new Error("E_RECORDS_NEGATIVE");',
  '  return total;',
  '}',
]
const nodes = (payload: Payload): SourceNode[] => payload.pack?.matched_nodes ?? []
const pointers = (payload: Payload): string[] => nodes(payload).flatMap(node => node.source_expand_handle ? [node.source_expand_handle] : [])

beforeEach(() => {
  vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
  root = mkdtempSync(join(tmpdir(), 'madar-source-continuation-'))
  mkdirSync(join(root, 'src'))
  state = { logLevel: 'info', subscribedResourceUris: new Set(), resourceVersions: new Map(), resourceListSignature: null }
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

function index(files: Record<string, string>): void {
  for (const [file, source] of Object.entries(files)) writeFileSync(join(root, file), source)
  graphPath = generateGraph(root, { noHtml: true, includeDocs: false }).graphPath
}
function storedHandles(): Map<string, unknown> {
  if (!state.contextPackHandles) throw new Error('Expected session handle store')
  return state.contextPackHandles
}
async function response(name: string, args: Record<string, unknown>) {
  return handleStdioRequest(graphPath, { id: ++requestId, method: 'tools/call', params: { name, arguments: args } }, state)
}
async function call(name: string, args: Record<string, unknown>): Promise<Payload> {
  const result = await response(name, args)
  expect(result?.error).toBeUndefined()
  const text = (result!.result as { content: Array<{ text: string }> }).content[0]!.text
  const payload = JSON.parse(text) as Payload
  expect(payload.serialized_budget).toMatchObject({ max_tokens: args.budget, enforced: true })
  expect(payload.serialized_budget.token_count).toBe(estimateQueryTokens(text))
  expect(estimateQueryTokens(text)).toBeLessThanOrEqual(Number(args.budget))
  return payload
}
function packRequest(budget = 2000) {
  return { prompt: 'Explain how records are processed and validated.', task: 'explain', budget }
}

/** Verify actual delivered bytes against source and derive line identity independently of the handle. */
function deliveredLines(payload: Payload, file: string, source: readonly string[]): Set<number> {
  const delivered = new Set<number>(), all = nodes(payload)
  for (const node of all.filter(node => resolve(root, node.source_file) === resolve(root, file))) {
    const range = node.snippet_line_range, omitted = node.snippet_omitted_ranges ?? []
    expect(range.start_line).toBeGreaterThan(0)
    expect(range.end_line).toBeLessThanOrEqual(source.length)
    for (const [index, gap] of omitted.entries()) {
      expect(gap.start_line).toBeGreaterThanOrEqual(range.start_line)
      expect(gap.end_line).toBeLessThanOrEqual(range.end_line)
      expect(gap.end_line).toBeGreaterThanOrEqual(gap.start_line)
      if (index) expect(gap.start_line).toBeGreaterThan(omitted[index - 1]!.end_line)
    }
    const expected: string[] = []
    for (let line = range.start_line; line <= range.end_line; line++) {
      const gap = omitted.find(value => value.start_line === line)
      if (gap) { expected.push(`[omitted lines ${gap.start_line}-${gap.end_line}]`); line = gap.end_line }
      else { expected.push(source[line - 1]!); delivered.add(line) }
    }
    expect(resolveSourceSnippet(node, all)).toBe(expected.join('\n'))
  }
  return delivered
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const sourceHandles = (): Map<string, SourceContinuationHandle> => new Map(
  [...(state.contextPackHandles ?? [])].filter((entry): entry is [string, SourceContinuationHandle] =>
    (entry[1] as { kind?: string } | undefined)?.kind === 'source_continuation'),
)

/** Independent source/hash/range oracle; no continuation validation helper is used. */
function assertRecoveryCoverage(
  payload: Payload, files: Record<string, readonly string[]>, priorDelivered = new Map<string, Set<number>>(),
): Map<string, Set<number>> {
  const all = nodes(payload), ids = new Set(all.map(node => node.node_id))
  expect(ids.size).toBe(all.length)
  for (const node of all) {
    if (node.snippet_ref !== undefined) expect(ids.has(String(node.snippet_ref))).toBe(true)
  }
  for (const edge of payload.pack?.relationships ?? []) {
    if (edge.from_id !== undefined) expect(ids.has(String(edge.from_id))).toBe(true)
    if (edge.to_id !== undefined) expect(ids.has(String(edge.to_id))).toBe(true)
  }
  const delivered = new Map<string, Set<number>>(), pending = new Map<string, Set<number>>()
  for (const [file, lines] of Object.entries(files)) delivered.set(resolve(root, file), deliveredLines(payload, file, lines))
  const advertised = pointers(payload)
  expect(new Set(advertised).size).toBe(advertised.length)
  for (const node of all.filter(node => node.source_expand_handle)) {
    const id = node.source_expand_handle!, handle = sourceHandles().get(id)
    expect(handle).toBeDefined()
    const file = Object.keys(files).find(file => resolve(root, file) === resolve(root, node.source_file))!
    expect(file).toBeDefined()
    expect(id).toBe(`source-expand:${sha256(JSON.stringify(handle)).slice(0, 32)}`)
    expect(handle).toMatchObject({ kind: 'source_continuation', version: 1, node_id: node.node_id, label: node.label,
      logical_root: resolve(root), real_root: realpathSync(root), canonical_file: realpathSync(join(root, file)),
      file_sha256: sha256(files[file]!.join('\n')), owner_range: node.snippet_line_range, scope: node.snippet_scope })
    expect(resolve(root, handle!.source_file)).toBe(resolve(root, file))
    expect(handle!.pending_ranges.length).toBeGreaterThan(0)
    const key = resolve(root, file), reserved = pending.get(key) ?? new Set<number>()
    for (const [index, range] of handle!.pending_ranges.entries()) {
      expect(Number.isSafeInteger(range.start_line) && Number.isSafeInteger(range.end_line)).toBe(true)
      expect(range.start_line).toBeGreaterThanOrEqual(handle!.owner_range.start_line)
      expect(range.end_line).toBeLessThanOrEqual(handle!.owner_range.end_line)
      expect(range.end_line).toBeGreaterThanOrEqual(range.start_line)
      if (index) expect(range.start_line).toBeGreaterThan(handle!.pending_ranges[index - 1]!.end_line)
      for (let line = range.start_line; line <= range.end_line; line++) {
        expect(reserved.has(line) || delivered.get(key)!.has(line) || priorDelivered.get(key)?.has(line)).toBeFalsy()
        expect(node.snippet_omitted_ranges?.some(gap => line >= gap.start_line && line <= gap.end_line)).toBe(true)
        reserved.add(line)
      }
    }
    pending.set(key, reserved)
  }
  for (const node of all) {
    const key = resolve(root, node.source_file)
    expect(delivered.has(key)).toBe(true)
    for (const gap of node.snippet_omitted_ranges ?? []) {
      for (let line = gap.start_line; line <= gap.end_line; line++) {
        expect(delivered.get(key)!.has(line) || priorDelivered.get(key)?.has(line) || pending.get(key)?.has(line)).toBe(true)
      }
    }
  }
  return delivered
}

describe('bounded source continuation through strict MCP', () => {
  function navigationFixture() {
    const file = 'src/navigation.ts', source = sourceLines('processNavigation')
    writeFileSync(join(root, file), source.join('\n'))
    const input: Payload = {
      response_format: SOURCE_EVIDENCE_RESPONSE_FORMAT, task: 'explain',
      evidence: { answerability: { state: 'insufficient', answer_scope: 'partial', advisory: true,
        broad_search_fallback: 'allowed', caveats: ['Source search was bounded; unmatched code may exist.'],
        missing_obligations: ['query:unverified'] } },
      governance: { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } },
      pack: { selection_scope: 'task_context', matched_nodes: [{
        node_id: 'navigation', label: 'processNavigation()', source_file: file, line_number: 1,
        snippet_scope: 'symbol', snippet_line_range: { start_line: 1, end_line: source.length },
        snippet: [...source.slice(0, 2), `[omitted lines 3-${source.length - 3}]`, ...source.slice(-3)].join('\n'),
        snippet_omitted_ranges: [{ start_line: 3, end_line: source.length - 3 }],
      }], relationships: [] },
      omitted_evidence: { count: 1, reason: 'output_budget', continuation: 'Request a focused context_pack or expand a supplied handle.' },
      serialized_budget: { max_tokens: 1000, token_count: 0, enforced: true },
    }
    const exact = (payload: Record<string, unknown>): Payload => {
      const result = structuredClone(payload) as Payload
      for (let i = 0; i < 12; i++) {
        const count = estimateQueryTokens(JSON.stringify(result))
        result.serialized_budget = { max_tokens: count, token_count: count, enforced: true }
      }
      expect(estimateQueryTokens(JSON.stringify(result))).toBe(result.serialized_budget.max_tokens)
      return result
    }
    return { file, source, input, exact }
  }

  function reservationFixture() {
    const f = navigationFixture(), input = structuredClone(f.input)
    delete input.omitted_evidence
    const files: Record<string, string[]> = {}
    input.pack!.matched_nodes = Array.from({ length: 5 }, (_, index) => {
      const file = `src/records-${index}.ts`, source = sourceLines(`accumulateRecords${index}`)
      files[file] = source; writeFileSync(join(root, file), source.join('\n'))
      return { node_id: `records:${index}`, label: `accumulateRecords${index}()`, source_file: file, line_number: 1,
        snippet_scope: 'symbol', snippet_line_range: { start_line: 1, end_line: source.length },
        snippet: [...source.slice(0, 2), `[omitted lines 3-${source.length - 3}]`, ...source.slice(-3)].join('\n'),
        snippet_omitted_ranges: [{ start_line: 3, end_line: source.length - 3 }],
      }
    })
    const requestedSource = { rootPath: root, prompt: 'Explain how records are accumulated and returned.' }
    const sourceOnly = evidenceResponses.finalizeSourceEvidenceResponse(input, 10000, { requestedSource })
    const budget = f.exact(sourceOnly).serialized_budget.max_tokens
    const run = (cap = budget, configurationFresh = () => true) => {
      const handles = new Map<string, SourceContinuationHandle>(), writes: string[] = []
      const payload = finalizeWithRecovery(input, cap, { requestedSource,
        callsites: { bundles: [], configurationFresh },
        continuations: { rootPath: root, store: (id, handle) => { writes.push(id); handles.set(id, handle) } },
      }) as Payload
      return { payload, handles, writes }
    }
    return { input, files, budget, run }
  }

  it('reserves measured recovery cost with bounded original-input repacking', () => {
    const f = reservationFixture(), before = JSON.stringify(f.input), fit = evidenceResponses.fitPreparedSourceEvidenceResponse
    const prospective = createSourceContinuationPreparation(root)(f.input)
    expect(prospective.valid).toBe(true); expect(prospective.handles.size).toBe(5)
    const canonical = structuredClone(prospective.payload) as Payload
    for (const node of nodes(canonical)) delete node.source_expand_handle
    canonical.serialized_budget = { max_tokens: 128, token_count: 0, enforced: true }
    for (let i = 0; i < 12; i++) canonical.serialized_budget.token_count = estimateQueryTokens(JSON.stringify(canonical))
    const costs: Array<{ requiredTokens: number; sourceTokens: number }> = []
    for (const supplied of [0, 2, 5]) {
      const variant = structuredClone(prospective.payload) as Payload
      nodes(variant).forEach((node, index) => { if (index >= supplied) delete node.source_expand_handle })
      const snapshot = JSON.stringify(variant)
      const prepared = createSourceContinuationPreparation(root, id => prospective.handles.get(id))(variant)
      const preparedSnapshot = JSON.stringify(prepared.payload), handles = [...prepared.handles]
      const oversized = fit(variant, 128, () => prepared)
      expect(oversized.status).toBe('over_budget'); expect(oversized.preparation).toBeUndefined()
      expect(oversized.overflow!.sourceTokens).toBe(canonical.serialized_budget.token_count)
      costs.push(oversized.overflow!)
      expect(JSON.stringify(prepared.payload)).toBe(preparedSnapshot)
      expect([...prepared.handles]).toEqual(handles)
      expect(JSON.stringify(variant)).toBe(snapshot)
    }
    expect(costs[1]).toEqual(costs[0]); expect(costs[2]).toEqual(costs[0])
    expect(costs[0]!.requiredTokens).toBeGreaterThan(costs[0]!.sourceTokens)
    const attempts: Array<{ sourceCap: number; required?: number; source?: number; status: string }> = []
    vi.spyOn(evidenceResponses, 'fitPreparedSourceEvidenceResponse').mockImplementation((input, budget, prepare, options) => {
      const fitted = fit(input, budget, prepare, options)
      attempts.push({ sourceCap: (input.serialized_budget as Payload['serialized_budget']).max_tokens, status: fitted.status,
        ...(fitted.overflow ? { required: fitted.overflow.requiredTokens, source: fitted.overflow.sourceTokens } : {}) })
      return fitted
    })
    const result = f.run()
    expect(attempts.length).toBeGreaterThan(1); expect(attempts.length).toBeLessThanOrEqual(3)
    expect(attempts[0]!.status).toBe('over_budget'); expect(attempts.at(-1)!.status).toBe('fit')
    for (let index = 1; index < attempts.length; index++) {
      const prior = attempts[index - 1]!, next = attempts[index]!
      expect(next.sourceCap).toBeLessThan(prior.sourceCap)
      expect(next.sourceCap).toBeLessThanOrEqual(f.budget - Math.max(0, prior.required! - prior.source!))
    }
    expect(nodes(result.payload).length).toBeGreaterThan(0)
    expect(nodes(result.payload).length).toBeLessThan(nodes(f.input).length)
    expect(result.payload.serialized_budget).toEqual({ max_tokens: f.budget,
      token_count: estimateQueryTokens(JSON.stringify(result.payload)), enforced: true })
    expect(result.payload.serialized_budget.token_count).toBeLessThanOrEqual(f.budget)
    expect(result.payload.omitted_evidence).toMatchObject({ count: nodes(f.input).length - nodes(result.payload).length, reason: 'output_budget' })
    expect(result.payload.evidence.answerability).toMatchObject({ state: 'insufficient', answer_scope: 'partial', advisory: true })
    expect(nodes(result.payload)[0]!.node_id).toBe(nodes(f.input)[0]!.node_id)
    expect(result.writes).toEqual(pointers(result.payload))
    expect([...result.handles.keys()]).toEqual(pointers(result.payload))
    state.contextPackHandles = result.handles
    assertRecoveryCoverage(result.payload, f.files)
    expect(JSON.stringify(f.input)).toBe(before)
  })

  it('keeps fitting recovery packets to one attempt and refuses a latched configuration failure', () => {
    const f = reservationFixture(), fit = evidenceResponses.fitPreparedSourceEvidenceResponse, statuses: string[] = []
    vi.spyOn(evidenceResponses, 'fitPreparedSourceEvidenceResponse').mockImplementation((input, budget, prepare, options) => {
      const fitted = fit(input, budget, prepare, options); statuses.push(fitted.status); return fitted
    })
    const first = f.run(10000)
    expect(statuses).toEqual(['fit']); expect(nodes(first.payload)).toHaveLength(nodes(f.input).length)
    statuses.length = 0
    const repeated = f.run(10000)
    expect(statuses).toEqual(['fit']); expect(repeated.payload).toEqual(first.payload)
    expect([...repeated.handles]).toEqual([...first.handles])
    statuses.length = 0; let firstCheck = true
    const refused = f.run(f.budget, () => { if (firstCheck) { firstCheck = false; return false } return true })
    expect(statuses).toEqual(['unverifiable'])
    expect(nodes(refused.payload)).toEqual([]); expect(refused.writes).toEqual([])
    expect(refused.payload.omitted_evidence).toBe('source recovery could not be verified')
  })

  it('retains the first source proof across recovery reservation retries without committing losing handles', () => {
    const f = reservationFixture(), fit = evidenceResponses.fitPreparedSourceEvidenceResponse, statuses: string[] = []
    let changed = false
    vi.spyOn(evidenceResponses, 'fitPreparedSourceEvidenceResponse').mockImplementation((input, budget, prepare, options) => {
      const fitted = fit(input, budget, prepare, options); statuses.push(fitted.status)
      if (!changed && fitted.status === 'over_budget') {
        changed = true
        const [file, source] = Object.entries(f.files).at(-1)!
        writeFileSync(join(root, file), source.join('\n').replace('total += 1;', 'total += 9;'))
      }
      return fitted
    })
    const result = f.run()
    expect(changed).toBe(true); expect(statuses).toEqual(['over_budget', 'unverifiable'])
    expect(nodes(result.payload)).toEqual([]); expect(result.writes).toEqual([]); expect(result.handles.size).toBe(0)
    expect(result.payload.omitted_evidence).toBe('source recovery could not be verified')
    expect(result.payload.serialized_budget.max_tokens).toBe(f.budget)
  })

  it('retains all source when a generated navigation hint is the only recovery budget obstacle', () => {
    const f = navigationFixture(), before = JSON.stringify(f.input), prospective = createSourceContinuationPreparation(root)(f.input)
    expect(prospective.valid).toBe(true)
    const withoutHint = structuredClone(prospective.payload)
    delete (withoutHint.omitted_evidence as Record<string, unknown>).continuation
    const expected = f.exact(withoutHint), budget = expected.serialized_budget.max_tokens
    expect(estimateQueryTokens(JSON.stringify({ ...prospective.payload, serialized_budget: expected.serialized_budget }))).toBeGreaterThan(budget)
    const fitted = fitPreparedSourceEvidenceResponse(f.input, budget, createSourceContinuationPreparation(root))
    expect(fitted.status).toBe('fit'); expect(fitted.payload).toEqual(expected)
    expect(fitted.payload.evidence).toEqual(f.input.evidence)
    expect(fitted.payload.omitted_evidence).toEqual({ count: 1, reason: 'output_budget' })
    expect([...fitted.preparation!.handles]).toEqual([...prospective.handles])
    expect(pointers(fitted.payload as Payload)).toEqual([...fitted.preparation!.handles.keys()])
    expect(fitted.preparation!.validate()).toBe(true)
    const handle = [...fitted.preparation!.handles.values()][0]!
    const expansion = expandSourceContinuation(handle, 8000, root, f.input.governance)
    expect(expansion.child).toBeUndefined()
    const delivered = new Set([...deliveredLines(fitted.payload as Payload, f.file, f.source),
      ...deliveredLines(expansion.payload as Payload, f.file, f.source)])
    expect(delivered.size).toBe(f.source.length)
    expect(state.contextPackHandles?.size ?? 0).toBe(0)
    expect(JSON.stringify(f.input)).toBe(before)
  })

  it('preserves fitting navigation hints and refuses unknown or unsupported navigation elision', () => {
    const f = navigationFixture(), prospective = createSourceContinuationPreparation(root)(f.input)
    const fitting = f.exact(prospective.payload)
    expect(fitPreparedSourceEvidenceResponse(f.input, fitting.serialized_budget.max_tokens,
      createSourceContinuationPreparation(root)).payload).toEqual(fitting)
    for (const fields of [
      { continuation: 'Do not proceed until this additional verification has been performed.' },
      { count: 0 }, { count: -1 }, { count: 1.5 }, { reason: 'policy_excluded' }, { custom_instruction: 'preserve' },
    ]) {
      const input = structuredClone(f.input)
      Object.assign(input.omitted_evidence as Record<string, unknown>, fields)
      const prepared = createSourceContinuationPreparation(root)(input), withoutHint = structuredClone(prepared.payload)
      delete (withoutHint.omitted_evidence as Record<string, unknown>).continuation
      const budget = f.exact(withoutHint).serialized_budget.max_tokens, before = JSON.stringify(input)
      const refused = fitPreparedSourceEvidenceResponse(input, budget, createSourceContinuationPreparation(root))
      expect(refused.status).toBe('over_budget'); expect(refused.preparation).toBeUndefined()
      expect(nodes(refused.payload as Payload)).toEqual([])
      expect(JSON.stringify(input)).toBe(before)
    }
    const withoutHint = structuredClone(prospective.payload)
    delete (withoutHint.omitted_evidence as Record<string, unknown>).continuation
    const budget = f.exact(withoutHint).serialized_budget.max_tokens
    const noProof = fitPreparedSourceEvidenceResponse(f.input, budget,
      () => ({ ...prospective, handles: new Map<string, SourceContinuationHandle>() }))
    expect(noProof.status).toBe('over_budget'); expect(noProof.preparation).toBeUndefined()
    expect(state.contextPackHandles?.size ?? 0).toBe(0)
  })

  it('keeps navigation fallback bounded and refuses source drift despite possible metadata savings', () => {
    const f = navigationFixture(), prepare = createSourceContinuationPreparation(root), prospective = prepare(f.input)
    const withoutHint = structuredClone(prospective.payload)
    delete (withoutHint.omitted_evidence as Record<string, unknown>).continuation
    const budget = f.exact(withoutHint).serialized_budget.max_tokens
    const tooSmall = fitPreparedSourceEvidenceResponse(f.input, 128, createSourceContinuationPreparation(root))
    expect(tooSmall.status).toBe('over_budget'); expect(tooSmall.preparation).toBeUndefined()
    expect(tooSmall.payload.omitted_evidence).toBe('source and recovery exceed output budget; request focused source')
    writeFileSync(join(root, f.file), f.source.join('\n').replace('total += 1;', 'total += 9;'))
    const drifted = fitPreparedSourceEvidenceResponse(f.input, budget, prepare)
    expect(drifted.status).toBe('unverifiable'); expect(drifted.preparation).toBeUndefined()
    expect(drifted.payload.omitted_evidence).toBe('source recovery could not be verified')
    expect(nodes(drifted.payload as Payload)).toEqual([])
    expect(state.contextPackHandles?.size ?? 0).toBe(0)
  })

  it('preserves every owner when optional flags fund exact recovery admission and pagination', async () => {
    const files: Record<string, string[]> = Object.fromEntries(['Records', 'Batches', 'Rows', 'Entries'].map(name =>
      [`src/${name.toLowerCase()}.ts`, sourceLines(`process${name}`)]))
    index(Object.fromEntries(Object.entries(files).map(([file, lines]) => [file, lines.join('\n')])))
    const input: Payload = {
      response_format: SOURCE_EVIDENCE_RESPONSE_FORMAT, task: 'explain',
      evidence: { answerability: { state: 'insufficient', answer_scope: 'partial', advisory: true, broad_search_fallback: 'allowed' } },
      governance: { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } },
      pack: { selection_scope: 'task_context', matched_nodes: Object.entries(files).map(([file, lines], index) => ({
        node_id: `owner:${index}`, label: `process${['Records', 'Batches', 'Rows', 'Entries'][index]}()`, source_file: file, line_number: 1,
        snippet: [...lines.slice(0, 2), `[omitted lines 3-${lines.length - 3}]`, ...lines.slice(-3)].join('\n'),
        snippet_scope: 'symbol', snippet_line_range: { start_line: 1, end_line: lines.length },
        snippet_omitted_ranges: [{ start_line: 3, end_line: lines.length - 3 }], snippet_truncated: true,
      })), relationships: [{ from_id: 'owner:0', to_id: 'owner:3', relation: 'related' }] },
      serialized_budget: { max_tokens: 128, token_count: 0, enforced: true },
    }
    const alias: SourceNode = { ...nodes(input)[0]!, node_id: 'alias:0', snippet_ref: 'owner:0' }
    delete alias.snippet
    nodes(input).splice(1, 0, alias)
    input.pack!.relationships!.push({ from_id: 'alias:0', to_id: 'owner:2', relation: 'related' })
    const snapshot = JSON.stringify(input)
    // Price the expected whole packet independently, including all authentic pointers.
    // Only the explicitly redundant flags are absent from this reference encoding.
    const withExactReceipt = (payload: Payload): Payload => {
      const result = JSON.parse(JSON.stringify(payload)) as Payload
      for (let i = 0; i < 12; i++) {
        const count = estimateQueryTokens(JSON.stringify(result))
        result.serialized_budget = { max_tokens: count, token_count: count, enforced: true }
      }
      expect(estimateQueryTokens(JSON.stringify(result))).toBe(result.serialized_budget.max_tokens)
      return result
    }
    state.contextPackHandles = new Map()
    const prospective = createSourceContinuationPreparation(root)(input)
    expect(prospective.valid).toBe(true)
    expect(prospective.handles.size).toBe(4)
    const expected = JSON.parse(JSON.stringify(prospective.payload)) as Payload
    for (const node of nodes(expected)) delete node.snippet_truncated
    const reference = withExactReceipt(expected), budget = reference.serialized_budget.max_tokens
    const unencoded = { ...prospective.payload, serialized_budget: reference.serialized_budget }
    expect(estimateQueryTokens(JSON.stringify(unencoded))).toBeGreaterThan(budget)
    const refused = fitPreparedSourceEvidenceResponse(input, 128, createSourceContinuationPreparation(root))
    expect(nodes(refused.payload as Payload)).toEqual([])
    expect(pointers(refused.payload as Payload)).toEqual([])
    expect(refused.preparation).toBeUndefined()
    expect(refused.payload.omitted_evidence).toBe('source and recovery exceed output budget; request focused source')
    expect((refused.payload.evidence as Payload['evidence']).answerability).toMatchObject({ state: 'insufficient', advisory: true })
    expect(sourceHandles().size).toBe(0)
    const fitted = fitPreparedSourceEvidenceResponse(input, budget, createSourceContinuationPreparation(root)), admitted = fitted.payload as Payload
    expect(admitted).toEqual(reference)
    expect(nodes(admitted).map(node => node.node_id)).toEqual(nodes(input).map(node => node.node_id))
    expect(admitted.pack?.relationships).toEqual(input.pack?.relationships)
    expect(admitted.evidence).toEqual(input.evidence)
    expect(admitted.omitted_evidence).toBeUndefined()
    for (const [index, node] of nodes(admitted).entries()) {
      const original = nodes(input)[index]!, comparable = { ...node }
      delete comparable.source_expand_handle
      expect(comparable).toEqual(Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'snippet_truncated')))
      expect(node.line_number).toBe(original.line_number)
      expect(node.snippet_line_range).toEqual(original.snippet_line_range)
      expect(node.snippet_omitted_ranges).toEqual(original.snippet_omitted_ranges)
      expect(node.snippet_ref).toBe(original.snippet_ref)
      expect(resolveSourceSnippet(node, nodes(admitted))).toBe(resolveSourceSnippet(original, nodes(input)))
    }
    for (const [payload, cap] of [[refused.payload, 128], [admitted, budget]] as const) {
      expect(payload.serialized_budget).toEqual({ max_tokens: cap, token_count: estimateQueryTokens(JSON.stringify(payload)), enforced: true })
      expect(estimateQueryTokens(JSON.stringify(payload))).toBeLessThanOrEqual(cap)
    }
    expect(JSON.stringify(input)).toBe(snapshot)
    expect(sourceHandles().size).toBe(0)
    // Unknown, false, null and absent flags carry distinct information and must survive.
    for (const flag of [false, 'unknown', null, undefined]) {
      const variant = JSON.parse(snapshot) as Payload
      if (flag === undefined) delete nodes(variant)[0]!.snippet_truncated
      else nodes(variant)[0]!.snippet_truncated = flag
      const before = JSON.stringify(variant), prepared = createSourceContinuationPreparation(root)(variant)
      expect(prepared.valid).toBe(true)
      const cap = withExactReceipt(prepared.payload as Payload).serialized_budget.max_tokens
      const result = fitPreparedSourceEvidenceResponse(variant, cap, createSourceContinuationPreparation(root))
      expect(result.preparation).toBeDefined()
      expect(nodes(result.payload as Payload)).toHaveLength(nodes(variant).length)
      expect(nodes(result.payload as Payload)[0]!.snippet_truncated).toBe(flag)
      expect(Object.hasOwn(nodes(result.payload as Payload)[0]!, 'snippet_truncated')).toBe(flag !== undefined)
      expect(result.payload.serialized_budget).toEqual({ max_tokens: cap, token_count: estimateQueryTokens(JSON.stringify(result.payload)), enforced: true })
      expect(estimateQueryTokens(JSON.stringify(result.payload))).toBeLessThanOrEqual(cap)
      expect(JSON.stringify(variant)).toBe(before)
      expect(sourceHandles().size).toBe(0)
    }
    // These true flags are not redundant proofs; refusing them cannot rewrite the input.
    const invalid: Array<Record<string, unknown>> = [
      { snippet_omitted_ranges: [] },
      { snippet_omitted_ranges: null },
      { snippet_omitted_ranges: [{ start_line: 0, end_line: 3 }] },
      { snippet_omitted_ranges: [{ start_line: 4, end_line: 3 }] },
      { snippet_omitted_ranges: [{ start_line: 3, end_line: 5 }, { start_line: 5, end_line: 6 }] },
      { snippet_omitted_ranges: [{ start_line: 3.5, end_line: 8 }] },
      { snippet_omitted_ranges: [{ start_line: 3, end_line: Number.MAX_SAFE_INTEGER + 1 }] },
      { snippet_omitted_ranges: [{ start_line: 3, end_line: sourceLines().length + 1 }] },
      { snippet_line_range: null }, { snippet_source: 'derived' }, { snippet_unverified: true }, { snippet_scope: 'excerpt' },
    ]
    for (const fields of invalid) {
      const variant = JSON.parse(snapshot) as Payload
      Object.assign(nodes(variant)[0]!, fields)
      const before = JSON.stringify(variant)
      const result = fitPreparedSourceEvidenceResponse(variant, budget, createSourceContinuationPreparation(root))
      expect(result.preparation).toBeUndefined()
      expect(nodes(result.payload as Payload)).toEqual([])
      expect(pointers(result.payload as Payload)).toEqual([])
      expect(result.payload.omitted_evidence).toBe('source recovery could not be verified')
      expect((result.payload.evidence as Payload['evidence']).answerability).toMatchObject({ state: 'insufficient', advisory: true })
      expect(result.payload.serialized_budget).toEqual({ max_tokens: budget, token_count: estimateQueryTokens(JSON.stringify(result.payload)), enforced: true })
      expect(estimateQueryTokens(JSON.stringify(result.payload))).toBeLessThanOrEqual(budget)
      expect(JSON.stringify(variant)).toBe(before)
      expect(sourceHandles().size).toBe(0)
    }
    expect(fitted.preparation?.validate()).toBe(true)
    expect([...fitted.preparation!.handles.keys()].sort()).toEqual(pointers(admitted).sort())
    for (const [id, handle] of fitted.preparation!.handles) storedHandles().set(id, handle)
    const delivered = assertRecoveryCoverage(admitted, files)
    expect([...sourceHandles().keys()].sort()).toEqual(pointers(admitted).sort())
    const owner = nodes(admitted).find(node => node.source_expand_handle)!, file = owner.source_file
    const seen = new Set(delivered.get(resolve(root, file))), initialHandles = new Map(sourceHandles())
    let handle = owner.source_expand_handle
    let pages = 0
    while (handle && pages < 2) {
      const before = new Map(sourceHandles()), page = await call('context_expand', { handle_id: handle, budget: 1200 })
      const current = assertRecoveryCoverage(page, files, new Map([[resolve(root, file), seen]])).get(resolve(root, file))!
      expect(current.size).toBeGreaterThan(0)
      for (const line of current) { expect(seen.has(line)).toBe(false); seen.add(line) }
      expect(page.source_continuation).toEqual({ delivered_lines: current.size, remaining_lines: files[file]!.length - seen.size })
      expect([...sourceHandles().keys()].filter(id => !before.has(id)).sort()).toEqual(pointers(page).filter(id => !before.has(id)).sort())
      for (const [id, prior] of initialHandles) expect(sourceHandles().get(id)).toEqual(prior)
      expect(pointers(page).length).toBeLessThanOrEqual(1)
      handle = pointers(page)[0]
      pages++
    }
    expect(pages).toBeGreaterThan(0)
    expect(handle).toBeUndefined()
    expect([...seen].sort((a, b) => a - b)).toEqual(files[file]!.map((_, index) => index + 1))
  })

  it('jointly prices implement recovery and refuses stale source without committing handles', async () => {
    const files: Record<string, string[]> = Object.fromEntries(['Records', 'Batches', 'Rows', 'Entries'].map(name =>
      [`src/${name.toLowerCase()}.ts`, sourceLines(`process${name}`)]))
    index(Object.fromEntries(Object.entries(files).map(([file, lines]) => [file, lines.join('\n')])))
    const initial = await call('context_pack', {
      prompt: 'Implement record validation in processRecords, processBatches, processRows, and processEntries.',
      task: 'implement', budget: 2400,
    })
    expect(initial.task).toBe('implement')
    expect(initial.pack?.selection_scope).toBe('task_context')
    expect(pointers(initial).length).toBeGreaterThan(0)
    const delivered = assertRecoveryCoverage(initial, files)
    expect([...sourceHandles().keys()].sort()).toEqual(pointers(initial).sort())
    const id = pointers(initial)[0]!, handle = sourceHandles().get(id)!
    const page = await call('context_expand', { handle_id: id, budget: 700 })
    expect(page.task).toBe('implement')
    const pageLines = assertRecoveryCoverage(page, files, delivered).get(resolve(root, handle.source_file))!
    expect(pageLines.size).toBeGreaterThan(0)
    for (const line of pageLines) expect(delivered.get(resolve(root, handle.source_file))?.has(line)).toBe(false)
    const file = resolve(root, handle.source_file), before = statSync(file)
    const original = files[Object.keys(files).find(path => resolve(root, path) === file)!]!.join('\n')
    writeFileSync(file, original.replace('total += 99;', 'total += 98;'))
    utimesSync(file, before.atime, before.mtime)
    expect(statSync(file).size).toBe(before.size)
    const snapshot = JSON.stringify([...storedHandles()]), writes = vi.spyOn(storedHandles(), 'set')
    const rejected = await response('context_expand', { handle_id: id, budget: 700 })
    expect(rejected?.error?.message).toMatch(/freshness|changed|source/i)
    expect(rejected?.result).toBeUndefined()
    expect(writes).not.toHaveBeenCalled()
    expect(JSON.stringify([...storedHandles()])).toBe(snapshot)
  })

  it('preserves cached source recovery and prior handles while stale expansion writes nothing', async () => {
    const files: Record<string, string[]> = Object.fromEntries(['Records', 'Batches', 'Rows', 'Entries'].map(name =>
      [`src/${name.toLowerCase()}.ts`, sourceLines(`process${name}`)]))
    index(Object.fromEntries(Object.entries(files).map(([file, lines]) => [file, lines.join('\n')])))
    const request = { prompt: 'Explain how processRecords, processBatches, processRows, and processEntries process records and perform validation.', task: 'explain', budget: 3200 }
    const cold = await call('context_pack', request), ids = pointers(cold)
    expect(cold.cache?.status).toBe('miss')
    expect(ids.length).toBeGreaterThan(1)
    assertRecoveryCoverage(cold, files)
    expect([...sourceHandles().keys()].sort()).toEqual([...ids].sort())
    // Rehydrate missing cached pointers while preserving a previously issued source cursor.
    for (const id of ids.slice(1)) storedHandles().delete(id)
    const retained = new Map(storedHandles())
    const warm = await call('context_pack', request)
    expect(warm.cache?.status).toBe('hit')
    expect(nodes(warm)).toEqual(nodes(cold))
    expect(warm.evidence).toEqual(cold.evidence)
    expect(pointers(warm)).toEqual(ids)
    assertRecoveryCoverage(warm, files)
    for (const [id, prior] of retained) expect(storedHandles().get(id)).toEqual(prior)
    expect([...sourceHandles().keys()].sort()).toEqual([...ids].sort())
    const target = sourceHandles().get(ids[0]!)!, file = resolve(root, target.source_file), before = statSync(file)
    writeFileSync(file, files[Object.keys(files).find(path => resolve(root, path) === file)!]!.join('\n').replace('total += 99;', 'total += 98;'))
    utimesSync(file, before.atime, before.mtime)
    expect(statSync(file).size).toBe(before.size)
    const snapshot = JSON.stringify([...storedHandles()]), pending = JSON.stringify(target.pending_ranges)
    const writes = vi.spyOn(storedHandles(), 'set')
    const rejected = await response('context_expand', { handle_id: ids[0], budget: 1200 })
    expect(rejected?.error?.message).toMatch(/freshness|changed|source/i)
    expect(rejected?.result).toBeUndefined()
    expect(writes).not.toHaveBeenCalled()
    expect(JSON.stringify([...storedHandles()])).toBe(snapshot)
    expect(JSON.stringify(target.pending_ranges)).toBe(pending)
    writes.mockRestore()
  })

  it('delivers the complete long owner across pages without repeated source or changed evidence obligations', async () => {
    const lines = sourceLines()
    index({ 'src/records.ts': lines.join('\n') })
    const initial = await call('context_pack', packRequest())
    const initialSnapshot = JSON.stringify(initial)
    const seen = deliveredLines(initial, 'src/records.ts', lines)
    expect(seen.size).toBeLessThan(lines.length)
    let handle = pointers(initial)[0]
    expect(handle).toBeTruthy()
    let pages = 0
    while (handle && pages < 20) {
      const page = await call('context_expand', { handle_id: handle, budget: 700 })
      // The compact wire contract permits omission of an empty missing_phases.
      // All substantive evidence and remaining obligations must stay identical.
      const normalizeEvidence = (evidence: Record<string, unknown>) => ({
        ...evidence, missing_phases: evidence.missing_phases === undefined ? [] : evidence.missing_phases,
      })
      expect(normalizeEvidence(page.evidence)).toEqual(normalizeEvidence(initial.evidence))
      const delivered = deliveredLines(page, 'src/records.ts', lines)
      expect(delivered.size).toBeGreaterThan(0)
      for (const line of delivered) { expect(seen.has(line)).toBe(false); seen.add(line) }
      expect(page.source_continuation).toEqual({ delivered_lines: delivered.size, remaining_lines: lines.length - seen.size })
      expect(pointers(page).length).toBeLessThanOrEqual(1)
      handle = pointers(page)[0]
      pages++
    }
    expect(pages).toBeGreaterThan(1)
    expect(handle).toBeUndefined()
    expect([...seen].sort((a, b) => a - b)).toEqual(lines.map((_, i) => i + 1))
    expect(JSON.stringify(initial)).toBe(initialSnapshot)
  })

  it('rejects an existing handle after a same-size source edit with its timestamp restored', async () => {
    const source = sourceLines().join('\n'), file = join(root, 'src/records.ts')
    index({ 'src/records.ts': source })
    const initial = await call('context_pack', packRequest()), handle = pointers(initial)[0]
    expect(handle).toBeTruthy()
    const before = statSync(file)
    writeFileSync(file, source.replace('total += 99;', 'total += 98;'))
    utimesSync(file, before.atime, before.mtime)
    expect(statSync(file).size).toBe(before.size)
    const rejected = await response('context_expand', { handle_id: handle, budget: 700 })
    expect(rejected?.error).toBeDefined()
    expect(rejected?.error?.message).toMatch(/freshness|changed|source/i)
    expect(rejected?.result).toBeUndefined()
  })

  it('rehydrates cached handles and preserves every returned handle when the 256-entry session store is full', async () => {
    index({
      'src/records.ts': sourceLines().join('\n'),
      'src/batches.ts': sourceLines('processBatches').join('\n'),
      'src/rows.ts': sourceLines('processRows').join('\n'),
      'src/entries.ts': sourceLines('processEntries').join('\n'),
    })
    const request = { prompt: 'Explain how processRecords, processBatches, processRows, and processEntries process records and perform validation.', task: 'explain', budget: 3200 }
    const initial = await call('context_pack', request), ids = pointers(initial)
    expect(ids).toHaveLength(4)
    const handles = storedHandles()
    handles.clear()
    const rehydrated = await call('context_pack', request)
    expect(rehydrated.cache?.status).toBe('hit')
    expect(pointers(rehydrated)).toEqual(ids)
    for (const id of ids) expect(handles.has(id)).toBe(true)

    // Keep only the first returned source handle, oldest. Other source handles must be recreated.
    // Keep ordinary verification handles too, so their rehydration cannot mask this eviction edge.
    const prior = new Map(handles), oldest = ids[0]!
    handles.clear(); handles.set(oldest, prior.get(oldest))
    for (const entry of rehydrated.expandable ?? []) {
      if (prior.has(entry.handle_id)) handles.set(entry.handle_id, prior.get(entry.handle_id))
    }
    for (let i = 0; handles.size < 256; i++) handles.set(`unrelated:${i}`, { unrelated: true })
    const atCapacity = await call('context_pack', request)
    expect(atCapacity.cache?.status).toBe('hit')
    expect(pointers(atCapacity)).toEqual(ids)
    expect(handles.size).toBe(256)
    for (const id of ids) expect(handles.has(id)).toBe(true)
    const expanded = await call('context_expand', { handle_id: oldest, budget: 700 })
    expect(nodes(expanded).length).toBeGreaterThan(0)

    // Retry only a missing cursor. The accepted cursors must keep their exact
    // IDs/content, and a stale supplied cursor must refuse all new writes.
    const retryInput = JSON.parse(JSON.stringify(initial)) as Payload
    const unserved = nodes(retryInput).find(node => node.source_expand_handle === ids.at(-1))!
    delete unserved.source_expand_handle
    const writes = new Map<string, SourceContinuationHandle>()
    const lookup = (id: string) => prior.get(id) as SourceContinuationHandle | undefined
    const retried = attachSourceContinuationHandles(retryInput, 3200, root,
      (id, handle) => writes.set(id, handle), lookup) as Payload
    expect(pointers(retried)).toEqual(ids)
    expect(writes.size).toBe(1)
    for (const id of ids.slice(0, -1)) expect(writes.has(id)).toBe(false)
    const stale = { ...lookup(ids[0]!)!, file_sha256: '0'.repeat(64) }
    const refusedWrites = vi.fn()
    expect(attachSourceContinuationHandles(retryInput, 3200, root, refusedWrites,
      id => id === ids[0] ? stale : lookup(id))).toBe(retryInput)
    expect(refusedWrites).not.toHaveBeenCalled()
  })

  it('does not advance at 128 tokens or split an oversized pending source line', async () => {
    index({ 'src/records.ts': sourceLines().join('\n') })
    const initial = await call('context_pack', packRequest()), id = pointers(initial)[0]!
    expect(id).toBeTruthy()
    const before = JSON.stringify(storedHandles().get(id))
    const tiny = await call('context_expand', { handle_id: id, budget: 128 })
    expect(tiny.source_continuation_status).toBe('budget_insufficient')
    expect(nodes(tiny)).toEqual([])
    expect(pointers(tiny)).toEqual([])
    expect(JSON.stringify(storedHandles().get(id))).toBe(before)
    expect(nodes(await call('context_expand', { handle_id: id, budget: 700 })).length).toBeGreaterThan(0)

    // Only this >budget-line case uses the helper, because normal packing must not emit the line.
    const huge = ['export function hugeRecord() {', `  const value = "${'x'.repeat(160000)}";`, '  return value;', '}']
    writeFileSync(join(root, 'src/huge.ts'), huge.join('\n'))
    const governance = { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } }
    let stored: SourceContinuationHandle | undefined
    attachSourceContinuationHandles({
      response_format: SOURCE_EVIDENCE_RESPONSE_FORMAT, task: 'explain', evidence: initial.evidence, governance,
      pack: { matched_nodes: [{ node_id: 'huge', label: 'hugeRecord()', source_file: 'src/huge.ts',
        snippet: `${huge[0]}\n[omitted lines 2-3]\n}`, snippet_scope: 'symbol',
        snippet_line_range: { start_line: 1, end_line: 4 }, snippet_omitted_ranges: [{ start_line: 2, end_line: 3 }], snippet_truncated: true }] },
    }, 2000, root, (_id, handle) => { stored = handle })
    expect(stored).toBeDefined()
    const pending = JSON.stringify(stored!.pending_ranges)
    const result = expandSourceContinuation(stored!, 700, root, governance)
    expect(result.payload.source_continuation_status).toBe('budget_insufficient')
    expect(result.child).toBeUndefined()
    expect((result.payload.pack as { matched_nodes: unknown[] }).matched_nodes).toEqual([])
    expect(JSON.stringify(stored!.pending_ranges)).toBe(pending)
    const receipt = result.payload.serialized_budget as { token_count: number }
    expect(receipt.token_count).toBe(estimateQueryTokens(JSON.stringify(result.payload)))
    expect(receipt.token_count).toBeLessThanOrEqual(700)
  })
})
