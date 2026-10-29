import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { lineRangeFromSourceLocation } from '../../src/shared/source-location.js'
import { buildExpandableRefs, classifyTaskContract } from '../../src/runtime/context-pack.js'
import { selectSourceDependencies, type SourceFlowCatalog } from '../../src/runtime/retrieve/source-dependencies.js'
import { finalizeSourceEvidenceResponse } from '../../src/runtime/stdio/tools.js'
import { expandSourceContinuation, isSourceContinuationHandle } from '../../src/runtime/source-continuation.js'
import * as responses from '../../src/runtime/source-evidence-response.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'

type Value = Record<string, unknown>
type Range = { start_line: number; end_line: number }
const roots: string[] = []
const object = (value: unknown): Value => value as Value
const nodes = (value: Value): Value[] => (object(value.pack ?? {}).matched_nodes ?? []) as Value[]
const ids = (value: Value): unknown[] => nodes(value).map(node => node.node_id)
const cost = (value: Value): number => estimateQueryTokens(JSON.stringify(value))
const lines = (ranges: readonly Range[]): number[] => ranges.flatMap(range => Array.from({ length: range.end_line - range.start_line + 1 }, (_, i) => range.start_line + i))
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })

function fixture(padding = 56, ambiguous = false, dependent = false, large?: 'callee' | 'read', lookup?: {
  overflowOwners?: number
  paddingStatements?: { entry: number; stages: number }
  ambiguousRange?: boolean
  literal?: { value: string; request: string }
}) {
  const root = mkdtempSync(join(tmpdir(), 'madar-flow-allocation-')); roots.push(root)
  const entry = [
    "import { applyPhase } from './stages.mjs'", '',
    'export function PacketContext(options) {',
    '  this.activeParser = options.activeParser',
    '  this.queryLimit = options.queryLimit',
    ...Array.from({ length: padding }, (_, index) => '  this.padding' + index + " = '" + 'padding '.repeat(12) + "'"),
    ...(lookup?.literal ? ['  this.notice = ' + JSON.stringify(lookup.literal.value)] : []),
    ...(dependent ? ['  this.temporary = options.fallback', '  this.queryLimit = this.temporary',
      "  this.paddingMixed = 'pad'; this.queryLimit = options.queryLimit"] : []),
    '  this.installParser = options.installParser',
    '  this.removeParser = options.removeParser',
    '}', '',
    'export function dispatchTask(request) {', '  return applyPhase(request)', '}',
  ]
  const largeBody = Array.from({ length: 32 }, (_, index) => `  request.detail${index} = '${'implementation detail '.repeat(20)}'`)
  const stages = [
    'export function applyPhase(request) {', ...(large === 'callee' ? largeBody : []), '  return request', '}', '',
    ...(lookup?.ambiguousRange
      ? ['export function finishStage(request) { return (() => request.verifyStage(request))() }', '']
      : ['export function finishStage(request) {', '  if (request.verifyStage) {', '    return request.verifyStage(request)', '  }', ...(large === 'read' ? largeBody : []), '  return request', '}', '']),
    'export function spareStage(request) {', '  return request.sparePhase', '}',
    ...(ambiguous ? ['', 'export function alternateStage(request) {', '  return request.verifyStage(request)', '}'] : []),
    ...Array.from({ length: lookup?.overflowOwners ?? 0 }, (_, index) => [
      '', `export function irrelevantStage${index}(request) {`,
      ...Array.from({ length: 12 }, (_, field) => `  request.ordinary${field} = ${field}`),
      '  return request', '}',
    ]).flat(),
  ]
  writeFileSync(join(root, 'entry.mjs'), entry.join('\n')); writeFileSync(join(root, 'stages.mjs'), stages.join('\n'))
  const fragments = ['entry.mjs', 'stages.mjs'].map(file => extractJs(join(root, file)))
  const graph = buildFromJson({ schema_version: 1, nodes: fragments.flatMap(fragment => fragment.nodes), edges: fragments.flatMap(fragment => fragment.edges) }, { directed: true })
  graph.graph.root_path = root
  const sourceNode = (name: string): Value => {
    const [id, node] = graph.nodeEntries().find(([, node]) => node.label === name + '()')!
    const range = lineRangeFromSourceLocation(node.source_location)!, file = String(node.source_file)
    const source = readFileSync(resolve(root, file), 'utf8').split(/\r?\n/)
    return { node_id: id, label: node.label, source_file: file, line_number: range.start, snippet_scope: 'symbol',
      snippet_line_range: { start_line: range.start, end_line: range.end }, snippet: source.slice(range.start - 1, range.end).join('\n') }
  }
  const donor = sourceNode('PacketContext'), caller = sourceNode('dispatchTask'), callee = sourceNode('applyPhase'), target = sourceNode('finishStage')
  const overflow = [target, sourceNode('spareStage'), ...(ambiguous ? [sourceNode('alternateStage')] : []),
    ...Array.from({ length: lookup?.overflowOwners ?? 0 }, (_, index) => sourceNode(`irrelevantStage${index}`))]
  const prompt = 'Trace PacketContext and dispatchTask through applyPhase, preserving activeParser and queryLimit before verifyStage. Inspect installParser/removeParser in entry.mjs and stages.mjs.'
    + (lookup?.literal ? ' ' + lookup.literal.request : '')
  const taskContract = classifyTaskContract('explain', { prompt, budget: 8000 })
  const metadata = (node: Value) => ({ node_id: String(node.node_id), label: String(node.label), source_file: String(node.source_file), range: node.snippet_line_range as Range })
  const catalog: SourceFlowCatalog = { version: 1, task_contract: taskContract, callees: [metadata(callee)], overflow: overflow.map(node => ({ ...metadata(node), evidence_class: 'primary' })) }
  const expandable = buildExpandableRefs(taskContract, overflow.map(node => ({
    node_id: String(node.node_id), label: String(node.label), source_file: String(node.source_file), evidence_class: 'primary' as const,
    expandable_ref: { node_id: String(node.node_id), label: String(node.label), source_file: String(node.source_file), line_range: node.snippet_line_range as Range },
    estimate_tokens: () => 1,
    build_entry: () => ({ node_id: String(node.node_id), label: String(node.label), source_file: String(node.source_file), line_number: Number(node.line_number), snippet: String(node.snippet) }),
  })))
  const generic = expandable[0]!
  const oldHandle = { prompt, task: 'explain', task_intent: taskContract.evidence_recipe_id, follow_up: generic.follow_up }
  const dependency = selectSourceDependencies(graph, [String(caller.node_id)], root, new Map(), { includeCallers: false, inspectionOnly: true })
  const bundles = dependency.source_callsite_bundles ?? []
  expect(bundles.some(bundle => bundle.from_id === caller.node_id && bundle.to_id === callee.node_id)).toBe(true)
  if (lookup?.paddingStatements) {
    // Add only inert statements after the resolver's verified declarations and
    // sites. Refresh the exact file hashes; no binding or offset has changed.
    for (const [file, count] of [['entry.mjs', lookup.paddingStatements.entry], ['stages.mjs', lookup.paddingStatements.stages]] as const) {
      writeFileSync(join(root, file), readFileSync(join(root, file), 'utf8') + '\n' + '0;'.repeat(count))
    }
    for (const bundle of bundles) {
      bundle.source_sha256 = createHash('sha256').update(readFileSync(resolve(root, bundle.source_file))).digest('hex')
      for (const source of bundle.source_dependencies) {
        source.source_sha256 = createHash('sha256').update(readFileSync(resolve(root, source.source_file))).digest('hex')
      }
    }
  }
  const payload: Value = { task: 'explain', task_intent: taskContract.evidence_recipe_id, prompt, response_format: 'source_evidence_v2',
    pack: { selection_scope: 'task_context', matched_nodes: [donor, caller], relationships: [] }, expandable,
    omitted_evidence: { count: 1, reason: 'output_budget', continuation: 'Keep original omitted-owner accounting.' },
    evidence: { answerability: { advisory: true, broad_search_fallback: 'allowed', state: 'insufficient', answer_scope: 'partial',
      missing_obligations: ['runtime:unverified'], verification_targets: [{ handle_id: generic.handle_id }] } },
    governance: { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } } }
  const evaluate = (enabled = true, data = catalog, budget = 8000) => {
    const store = new Map<string, unknown>([[generic.handle_id, structuredClone(oldHandle)]])
    const writes: string[] = []
    const storeHandle = (id: string, handle: unknown): void => { writes.push(id); store.set(id, handle) }
    const result = finalizeSourceEvidenceResponse(structuredClone(payload), budget, {
      requestedSource: { rootPath: root, prompt }, callsites: { bundles, configurationFresh: () => true },
      continuations: { rootPath: root, store: storeHandle },
      ...(enabled ? { flowBudget: { catalog: data, lookup: (id: string) => store.get(id), store: storeHandle } } : {}),
    })
    return { result, store, writes }
  }
  return { root, entry, donor, caller, callee, target, overflow, catalog, generic, payload, evaluate }
}

describe('source flow allocation with authenticated deferral', () => {
  it.each([
    ['alpha  beta', 'Preserve the exact "alpha  beta" text. Ignore tests.', true],
    ['ignore  tests', 'Preserve the exact "ignore  tests" text. Ignore docs.', true],
    ['alpha  beta', 'Ignore "alpha  beta".', false],
  ] as const)('preserves the exact positive literal boundary for %s: %s', (value, request, retained) => {
    const f = fixture(56, false, false, undefined, { literal: { value, request } })
    const baseline = f.evaluate(false), candidate = f.evaluate()
    expect(ids(candidate.result)).toEqual([...ids(baseline.result), f.callee.node_id, f.target.node_id])
    const donor = nodes(candidate.result).find(node => node.node_id === f.donor.node_id)!
    const line = f.entry.findIndex(text => text === '  this.notice = ' + JSON.stringify(value)) + 1
    expect(line).toBeGreaterThan(0)
    expect(String(donor.snippet).includes('this.notice = ' + JSON.stringify(value))).toBe(retained)
    const omitted = lines(donor.snippet_omitted_ranges as Range[])
    expect(omitted.includes(line)).toBe(!retained)
    const handle = candidate.store.get(String(donor.source_expand_handle))
    expect(isSourceContinuationHandle(handle)).toBe(true)
    if (!isSourceContinuationHandle(handle)) throw new Error('Missing authenticated donor recovery')
    expect(lines(handle.pending_ranges)).toEqual(omitted)
    const recovered = expandSourceContinuation(handle, 8000, f.root, candidate.result.governance)
    expect(recovered.child).toBeUndefined()
    expect(nodes(recovered.payload).some(node => String(node.snippet).includes('this.notice = ' + JSON.stringify(value)))).toBe(!retained)
    expect(object(candidate.result.serialized_budget).token_count).toBe(cost(candidate.result))
    expect(cost(candidate.result)).toBeLessThanOrEqual(8000)
  })

  const syntaxCounts = (root: string) => ['entry.mjs', 'stages.mjs'].map(file => {
    const ast = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
    let count = 0
    const visit = (node: ts.Node): void => { count++; ts.forEachChild(node, visit) }
    visit(ast)
    return count
  })

  it('reuses a complete AST index when repeated overflow lookups exceed the shared visit budget', () => {
    const f = fixture(56, false, false, undefined, { overflowOwners: 45 })
    const [entryCount, stagesCount] = syntaxCounts(f.root)
    expect(entryCount! + stagesCount!).toBeLessThan(100_000)
    expect(entryCount! + stagesCount! * f.catalog.overflow.length).toBeGreaterThan(100_000)
    const baseline = f.evaluate(false), candidate = f.evaluate()
    expect(ids(candidate.result)).toEqual([...ids(baseline.result), f.callee.node_id, f.target.node_id])
    expect(object(candidate.result.pack).relationships).toEqual([
      ...(object(baseline.result.pack).relationships as Value[]),
      { from_id: f.caller.node_id, to_id: f.callee.node_id, relation: 'calls' },
    ])
    expect(nodes(candidate.result).at(-1)?.snippet).toBe(f.target.snippet)
    expect((candidate.result.expandable as Value[])[0]?.count).toBe(f.catalog.overflow.length - 1)
    expect(candidate.store.get(f.generic.handle_id)).toEqual(baseline.store.get(f.generic.handle_id))
    expect(object(candidate.result.serialized_budget).token_count).toBe(cost(candidate.result))
    const cached = f.evaluate(true, JSON.parse(JSON.stringify(f.catalog)) as SourceFlowCatalog)
    expect(cached.result).toEqual(candidate.result); expect([...cached.store]).toEqual([...candidate.store])
  })

  it('refuses incomplete AST indexes when individually bounded files exceed the shared visit budget', () => {
    const f = fixture(56, false, false, undefined, { paddingStatements: { entry: 20_000, stages: 35_000 } })
    const counts = syntaxCounts(f.root)
    expect(counts.every(count => count < 100_000)).toBe(true)
    expect(counts.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(100_000)
    const baseline = f.evaluate(false), candidate = f.evaluate()
    expect(candidate.result).toEqual(baseline.result); expect([...candidate.store]).toEqual([...baseline.store])
    expect(candidate.writes).toEqual(baseline.writes)
  })

  it('preserves same-range function ambiguity in the AST index', () => {
    const f = fixture(56, false, false, undefined, { ambiguousRange: true })
    const ast = ts.createSourceFile('stages.mjs', readFileSync(join(f.root, 'stages.mjs'), 'utf8'), ts.ScriptTarget.Latest, true)
    const range = f.target.snippet_line_range as Range, matches: ts.Node[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) && 'body' in node && node.body
        && ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 === range.start_line
        && ast.getLineAndCharacterOfPosition(node.getEnd()).line + 1 === range.end_line) matches.push(node)
      ts.forEachChild(node, visit)
    }
    visit(ast)
    expect(matches).toHaveLength(2)
    const baseline = f.evaluate(false), candidate = f.evaluate()
    expect(candidate.result).toEqual(baseline.result); expect([...candidate.store]).toEqual([...baseline.store])
  })

  it('admits the requested-read owner after a joint refusal without inventing an edge or committing the rejected trial', () => {
    const f = fixture(12, false, false, 'callee')
    const budget = cost(f.evaluate(false).result) + 128, baseline = f.evaluate(false, f.catalog, budget)
    const fit = responses.fitPreparedSourceEvidenceResponse, attempted: unknown[][] = [], statuses: string[] = []
    vi.spyOn(responses, 'fitPreparedSourceEvidenceResponse').mockImplementation((input, budget, prepare, options) => {
      const result = fit(input, budget, prepare, options)
      if (ids(input).includes(f.target.node_id) || ids(input).includes(f.callee.node_id)) {
        attempted.push(ids(input)); statuses.push(result.status)
      }
      return result
    })
    const candidate = f.evaluate(true, f.catalog, budget)
    expect(attempted.map(entries => entries.filter(id => id === f.callee.node_id || id === f.target.node_id)))
      .toEqual([[f.callee.node_id, f.target.node_id], [f.target.node_id]])
    expect(statuses).toEqual(['over_budget', 'fit'])
    expect(ids(candidate.result)).toEqual([...ids(baseline.result), f.target.node_id])
    expect(nodes(candidate.result).at(-1)?.snippet).toBe(f.target.snippet)
    expect(object(candidate.result.pack).relationships).toEqual(object(baseline.result.pack).relationships)
    expect(cost(candidate.result)).toBeLessThanOrEqual(cost(baseline.result))
    expect(object(candidate.result.serialized_budget).token_count).toBe(cost(candidate.result))
    expect(candidate.result.omitted_evidence).toEqual(baseline.result.omitted_evidence)
    const ref = (candidate.result.expandable as Value[])[0]!
    expect(ref.count).toBe(1)
    expect(ref.handle_id).not.toBe(f.generic.handle_id)
    expect(object(object(candidate.store.get(String(ref.handle_id))).follow_up).focus_ranges)
      .toEqual([{ source_file: f.overflow[1]!.source_file, ...(f.overflow[1]!.snippet_line_range as Range) }])
    expect(object(object(candidate.result.evidence).answerability).verification_targets).toEqual([{ handle_id: ref.handle_id }])
    const sourceHandles = nodes(candidate.result).flatMap(node => typeof node.source_expand_handle === 'string' ? [node.source_expand_handle] : [])
    expect(new Set(candidate.writes)).toEqual(new Set([...sourceHandles, ref.handle_id]))
    expect(candidate.writes.length).toBe(sourceHandles.length + 1)
    expect(candidate.store.get(f.generic.handle_id)).toEqual(baseline.store.get(f.generic.handle_id))
  })

  it('admits only the verified callee when the requested-read owner cannot fit and preserves the complete generic scope', () => {
    const f = fixture(12, false, false, 'read')
    const budget = cost(f.evaluate(false).result) + 128, baseline = f.evaluate(false, f.catalog, budget)
    const fit = responses.fitPreparedSourceEvidenceResponse, attempted: unknown[][] = [], statuses: string[] = []
    vi.spyOn(responses, 'fitPreparedSourceEvidenceResponse').mockImplementation((input, budget, prepare, options) => {
      const result = fit(input, budget, prepare, options)
      if (ids(input).includes(f.target.node_id) || ids(input).includes(f.callee.node_id)) {
        attempted.push(ids(input)); statuses.push(result.status)
      }
      return result
    })
    const candidate = f.evaluate(true, f.catalog, budget)
    expect(attempted.map(entries => entries.filter(id => id === f.callee.node_id || id === f.target.node_id)))
      .toEqual([[f.callee.node_id, f.target.node_id], [f.target.node_id], [f.callee.node_id]])
    expect(statuses).toEqual(['over_budget', 'over_budget', 'fit'])
    expect(ids(candidate.result)).toEqual([...ids(baseline.result), f.callee.node_id])
    expect(nodes(candidate.result).at(-1)?.snippet).toBe(f.callee.snippet)
    expect(object(candidate.result.pack).relationships).toEqual([{ from_id: f.caller.node_id, to_id: f.callee.node_id, relation: 'calls' }])
    expect(candidate.result.expandable).toEqual(baseline.result.expandable)
    expect(candidate.result.evidence).toEqual(baseline.result.evidence)
    expect(candidate.result.omitted_evidence).toEqual(baseline.result.omitted_evidence)
    expect(candidate.store.get(f.generic.handle_id)).toEqual(baseline.store.get(f.generic.handle_id))
    expect(cost(candidate.result)).toBeLessThanOrEqual(cost(baseline.result))
    expect(object(candidate.result.serialized_budget).token_count).toBe(cost(candidate.result))
    const sourceHandles = nodes(candidate.result).flatMap(node => typeof node.source_expand_handle === 'string' ? [node.source_expand_handle] : [])
    expect(new Set(candidate.writes)).toEqual(new Set(sourceHandles))
    expect(candidate.writes.length).toBe(sourceHandles.length)
  })

  it('funds two source-proven stages and can recover every deferred line with truthful generic scope', () => {
    const f = fixture(), original = JSON.stringify(f.payload), baseline = f.evaluate(false), candidate = f.evaluate()
    expect(ids(candidate.result)).toEqual([...ids(baseline.result), f.callee.node_id, f.target.node_id])
    expect(cost(candidate.result)).toBeLessThanOrEqual(cost(baseline.result))
    expect(object(candidate.result.serialized_budget).token_count).toBe(cost(candidate.result))
    expect(candidate.result.omitted_evidence).toEqual(baseline.result.omitted_evidence)
    expect(object(candidate.result.pack).relationships).toContainEqual({ from_id: f.caller.node_id, to_id: f.callee.node_id, relation: 'calls' })
    const deferred = nodes(candidate.result).find(node => node.node_id === f.donor.node_id)!
    expect(deferred.snippet_line_range).toEqual(f.donor.snippet_line_range)
    expect(String(deferred.snippet)).toContain('this.installParser = options.installParser')
    expect(String(deferred.snippet)).toContain('this.removeParser = options.removeParser')
    const handle = candidate.store.get(String(deferred.source_expand_handle))
    expect(isSourceContinuationHandle(handle)).toBe(true)
    if (!isSourceContinuationHandle(handle)) throw new Error('Missing authenticated donor recovery')
    const pending = lines(handle.pending_ranges), omitted = lines(deferred.snippet_omitted_ranges as Range[])
    expect(pending.length).toBeGreaterThan(0); expect(pending).toEqual(omitted)
    const recovered = expandSourceContinuation(handle, 8000, f.root, candidate.result.governance)
    expect(recovered.child).toBeUndefined()
    const text = nodes(recovered.payload).map(node => String(node.snippet)).join('\n')
    for (const line of pending) if (f.entry[line - 1]!.trim()) expect(text).toContain(f.entry[line - 1])
    const ref = (candidate.result.expandable as Value[])[0]!
    expect(ref.count).toBe(1); expect(ref.handle_id).not.toBe(f.generic.handle_id)
    const nextHandle = object(candidate.store.get(String(ref.handle_id)))
    expect(object(nextHandle.follow_up).focus_ranges).toEqual([{ source_file: f.overflow[1]!.source_file, ...(f.overflow[1]!.snippet_line_range as Range) }])
    expect(object(object(candidate.result.evidence).answerability).verification_targets).toContainEqual({ handle_id: ref.handle_id })
    const cached = f.evaluate(true, JSON.parse(JSON.stringify(f.catalog)) as SourceFlowCatalog)
    expect(cached.result).toEqual(candidate.result); expect([...cached.store]).toEqual([...candidate.store])
    expect(JSON.stringify(f.payload)).toBe(original)
  })

  it('preserves the exact baseline when the missing requested read has two independent owners', () => {
    const f = fixture(56, true), baseline = f.evaluate(false), candidate = f.evaluate()
    expect(candidate.result).toEqual(baseline.result); expect([...candidate.store]).toEqual([...baseline.store])
  })

  it('preserves the exact baseline and private state when protected source cannot fund admission', () => {
    const f = fixture(0), baseline = f.evaluate(false), candidate = f.evaluate()
    expect(candidate.result).toEqual(baseline.result); expect([...candidate.store]).toEqual([...baseline.store])
    expect(ids(candidate.result)).not.toContain(f.callee.node_id)
    const dependent = fixture(56, false, true), previous = dependent.evaluate(false), refused = dependent.evaluate()
    expect(refused.result).toEqual(previous.result); expect([...refused.store]).toEqual([...previous.store])
  })

  it('refuses source drift after a rejected joint proposal before any atomic fallback or store commit', () => {
    const f = fixture(12, false, false, 'callee'), fit = responses.fitPreparedSourceEvidenceResponse
    const budget = cost(f.evaluate(false).result) + 128
    let changed = false, atomicFits = 0
    vi.spyOn(responses, 'fitPreparedSourceEvidenceResponse').mockImplementation((input, budget, prepare, options) => {
      if (ids(input).includes(f.target.node_id) && !ids(input).includes(f.callee.node_id)) atomicFits++
      const result = fit(input, budget, prepare, options)
      if (!changed && result.status === 'over_budget' && ids(input).includes(f.callee.node_id) && ids(input).includes(f.target.node_id)) {
        changed = true
        writeFileSync(join(f.root, 'entry.mjs'), f.entry.join('\n').replace('options.queryLimit', 'options.changedLimit'))
      }
      return result
    })
    const candidate = f.evaluate(true, f.catalog, budget)
    expect(changed).toBe(true); expect(atomicFits).toBe(0); expect(nodes(candidate.result)).toEqual([])
    expect(object(object(candidate.result.evidence).answerability).state).toBe('insufficient')
    expect([...candidate.store.keys()]).toEqual([f.generic.handle_id])
  })

  it('uses the requested budget for a complete joint gain while preserving existing source and recovery', () => {
    const f = fixture(1), baseline = f.evaluate(false), before = JSON.stringify(f.payload)
    const fit = responses.fitPreparedSourceEvidenceResponse, attempted: unknown[][] = []
    vi.spyOn(responses, 'fitPreparedSourceEvidenceResponse').mockImplementation((input, budget, prepare, options) => {
      if (ids(input).includes(f.target.node_id) || ids(input).includes(f.callee.node_id)) attempted.push(ids(input))
      return fit(input, budget, prepare, options)
    })
    const candidate = f.evaluate()
    expect(attempted.map(entries => entries.filter(id => id === f.callee.node_id || id === f.target.node_id)))
      .toEqual([[f.callee.node_id, f.target.node_id]])
    expect(cost(candidate.result)).toBeGreaterThan(cost(baseline.result))
    expect(cost(candidate.result)).toBeLessThanOrEqual(8000)
    expect(object(candidate.result.serialized_budget)).toEqual({ max_tokens: 8000, token_count: cost(candidate.result), enforced: true })
    expect(ids(candidate.result)).toEqual([...ids(baseline.result), f.callee.node_id, f.target.node_id])
    for (const original of [f.callee, f.target]) {
      expect(nodes(candidate.result).find(node => node.node_id === original.node_id)).toEqual(original)
    }
    expect(nodes(candidate.result).find(node => node.node_id === f.caller.node_id))
      .toEqual(nodes(baseline.result).find(node => node.node_id === f.caller.node_id))
    const donor = nodes(candidate.result).find(node => node.node_id === f.donor.node_id)!
    expect(donor.snippet_line_range).toEqual(f.donor.snippet_line_range)
    const handle = candidate.store.get(String(donor.source_expand_handle))
    expect(isSourceContinuationHandle(handle)).toBe(true)
    if (!isSourceContinuationHandle(handle)) throw new Error('Missing authenticated deferred source')
    expect(lines(handle.pending_ranges)).toEqual(lines(donor.snippet_omitted_ranges as Range[]))
    const pending = new Set(lines(handle.pending_ranges)), owner = f.donor.snippet_line_range as Range
    for (const line of lines([owner])) {
      if (!pending.has(line) && f.entry[line - 1]!.trim()) expect(String(donor.snippet)).toContain(f.entry[line - 1])
    }
    expect(object(candidate.result.pack).relationships).toEqual([
      ...(object(baseline.result.pack).relationships as Value[]),
      { from_id: f.caller.node_id, to_id: f.callee.node_id, relation: 'calls' },
    ])
    expect(candidate.result.omitted_evidence).toEqual(baseline.result.omitted_evidence)
    const ref = (candidate.result.expandable as Value[])[0]!
    expect(ref.count).toBe(1)
    expect(object(object(candidate.store.get(String(ref.handle_id))).follow_up).focus_ranges)
      .toEqual([{ source_file: f.overflow[1]!.source_file, ...(f.overflow[1]!.snippet_line_range as Range) }])
    const expectedEvidence = structuredClone(baseline.result.evidence)
    object(object(expectedEvidence).answerability).verification_targets = [{ handle_id: ref.handle_id }]
    expect(candidate.result.evidence).toEqual(expectedEvidence)
    expect(candidate.store.get(f.generic.handle_id)).toEqual(baseline.store.get(f.generic.handle_id))
    expect(new Set(candidate.writes)).toEqual(new Set([donor.source_expand_handle, ref.handle_id]))
    expect(JSON.stringify(f.payload)).toBe(before)
  })
})
