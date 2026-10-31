import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { lineRangeFromSourceLocation } from '../../src/shared/source-location.js'
import { selectSourceDependencies, sourceCallsiteBundlesKey } from '../../src/runtime/retrieve/source-dependencies.js'
import { retrieveContext, withRetrieveSnippetBudget } from '../../src/runtime/retrieve.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { compactRepeatedSourceMetadata, resolveSourceSnippet, SOURCE_EVIDENCE_RESPONSE_FORMAT } from '../../src/runtime/source-evidence-response.js'
import * as continuations from '../../src/runtime/source-continuation.js'
import type { SourceContinuationHandle } from '../../src/runtime/source-continuation.js'

type RecordValue = Record<string, unknown>
type Range = { start_line: number; end_line: number }
type SourceNode = RecordValue & { node_id: string; source_file: string; snippet_line_range: Range; snippet_omitted_ranges?: Range[] }
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
const record = (value: unknown): RecordValue => value as RecordValue
const nodes = (payload: RecordValue): SourceNode[] => record(payload.pack).matched_nodes as SourceNode[]

function fixture(propertyScope = false, valueReferences = false) {
  const root = mkdtempSync(join(tmpdir(), 'madar-callsite-completion-')); roots.push(root)
  const lines = [
    'import { applyPolicy } from "./policy.mjs";',
    'export function normalizeRecord(value) { return value + 1; }',
    'export function rejectRecord(value) { return value - 1; }',
    'export function processRecords(records, enabled) {',
    '  let total = applyPolicy(records.length);',
    '  if (total < 0) throw new Error("E_RECORDS_POLICY");',
    ...(valueReferences ? ['  queue("VALUE_REF_POLICY", cleanupRecord.bind(null));'] : []),
    ...Array.from({ length: 55 }, (_, i) => `  total += ${i + 1};`),
    '  if (enabled) {',
    '    total = normalizeRecord(total);',
    '  }',
    ...Array.from({ length: 55 }, (_, i) => `  total += ${i + 100};`),
    '  records.forEach((record) => {',
    '    if (record > 0) {',
    '      total = normalizeRecord(record);',
    '    }',
    '  });',
    ...(valueReferences ? ['  queue("VALUE_REF_POLICY", cleanupRecord.bind(null));'] : []),
    ...(propertyScope ? [
      '  if (enabled) {',
      '    const results = {',
      ...Array.from({ length: 40 }, (_, i) => `      unrelated${i}: "UNRELATED_PROPERTY_${i}",`),
      '      ["normalized" + records.length]: enabled',
      '        ? normalizeRecord(total)',
      '        : rejectRecord(total),',
      '      accepted: enabled && normalizeRecord(total),',
      '      unrelatedMethod() { return "UNRELATED_METHOD_BODY"; },',
      '    };',
      '    total += Object.keys(results).length;',
      '  }',
    ] : []),
    '  return total;',
    '}',
    'export function pair() { return normalizeRecord(1) + rejectRecord(2); }',
    'export function mutable() { let alias = normalizeRecord; alias = rejectRecord; return alias(1); }',
    ...(valueReferences ? ['export function cleanupRecord() { return "CLEANUP_APPLIED"; }'] : []),
    ...(propertyScope ? [
      'export function multipleDeclarations() {',
      '  const prior = "MULTI_DECLARATION_SIBLING", result = {',
      '    value: normalizeRecord(1),',
      '    sibling: "MULTI_OBJECT_SIBLING",',
      '  };',
      '  return result;',
      '}',
      'export function destructuredObject() {',
      '  const { value } = {',
      '    value: normalizeRecord(2),',
      '    sibling: "DESTRUCTURED_SIBLING",',
      '  };',
      '  return value;',
      '}',
      'export function assignedObject(target) {',
      '  target.value = {',
      '    value: normalizeRecord(3),',
      '    sibling: "ASSIGNMENT_SIBLING",',
      '  };',
      '}',
      'export function spreadObject() {',
      '  const result = {',
      '    ...normalizeRecord(4),',
      '    sibling: "SPREAD_SIBLING",',
      '  };',
      '  return result;',
      '}',
      'export function nestedCallback(records) {',
      '  const result = {',
      '    value: records.map(record => normalizeRecord(record)),',
      '    sibling: "CALLBACK_SIBLING",',
      '  };',
      '  return result;',
      '}',
    ] : []),
  ]
  const file = join(root, 'records.mjs'); writeFileSync(file, lines.join('\n'))
  const policyFile = join(root, 'policy.mjs'); writeFileSync(policyFile, 'export function applyPolicy(value) { return value; }\n')
  const extracted = [extractJs(file), extractJs(policyFile)]
  const graph = buildFromJson({ schema_version: 1, nodes: extracted.flatMap(fragment => fragment.nodes), edges: extracted.flatMap(fragment => fragment.edges) }, { directed: true })
  graph.graph.root_path = root
  const idFor = (name: string): string => graph.nodeEntries().find(([, node]) => node.label === `${name}()`)?.[0] ?? ''
  const entry = idFor('processRecords'), callee = idFor('normalizeRecord')
  expect(entry).toBeTruthy(); expect(callee).toBeTruthy()
  const dependencies = selectSourceDependencies(graph, [entry], root, new Map(), { includeCallers: false, inspectionOnly: true,
    ...(valueReferences ? { functionValueCallerIds: [entry] } : {}) })
  const callerNode = graph.nodeEntries().find(([id]) => id === entry)![1], calleeNode = graph.nodeEntries().find(([id]) => id === callee)![1]
  const range = lineRangeFromSourceLocation(callerNode.source_location)!
  const calleeRange = lineRangeFromSourceLocation(calleeNode.source_location)!
  const omitted = { start_line: range.start + 3, end_line: range.end - 1 }
  const payload: RecordValue = {
    task: 'explain', response_format: SOURCE_EVIDENCE_RESPONSE_FORMAT,
    pack: { matched_nodes: [
      { node_id: entry, label: 'processRecords()', source_file: file, snippet_scope: 'symbol',
        snippet_line_range: { start_line: range.start, end_line: range.end }, snippet_omitted_ranges: [omitted], snippet_truncated: true,
        snippet: [...lines.slice(range.start - 1, omitted.start_line - 1), `[omitted lines ${omitted.start_line}-${omitted.end_line}]`, ...lines.slice(omitted.end_line, range.end)].join('\n') },
      { node_id: callee, label: 'normalizeRecord()', source_file: file, snippet_scope: 'symbol',
        snippet_line_range: { start_line: calleeRange.start, end_line: calleeRange.end }, snippet: lines.slice(calleeRange.start - 1, calleeRange.end).join('\n') },
      { node_id: 'callee-ref', label: 'normalizeRecord()', source_file: file, snippet_scope: 'symbol',
        snippet_line_range: { start_line: calleeRange.start, end_line: calleeRange.end }, snippet_ref: callee },
    ], relationships: [{ from_id: entry, to_id: callee, relation: 'calls' }] },
    evidence: { answerability: { advisory: true, caveats: ['Source coverage remains partial.'], broad_search_fallback: 'allowed' } },
    governance: { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } },
    omitted_evidence: 'output_budget',
  }
  const bundles = (dependencies.source_callsite_bundles ?? []).filter(bundle => bundle.from_id === entry && bundle.to_id === callee)
  return { root, file, lines, graph, idFor, entry, callee, dependencies, bundles, payload }
}

function controlFixture() {
  const f = fixture()
  const lines = [
    'export function normalizeRecord(value) { return value + 1; }',
    'export function rejectRecord(value) { return value - 1; }',
    'export function processRecords(records, enabled) {',
    '  let total = 0;',
    '  try {',
    '    if (enabled) {',
    '      total = normalizeRecord(total);',
    '    } else {',
    ...Array.from({ length: 12 }, (_, i) => `      total += "OTHER_BRANCH_${i}_${'unrelated '.repeat(8)}".length;`),
    '    }',
    '  } catch (error) {',
    ...Array.from({ length: 12 }, (_, i) => `    recordFailure("HANDLER_${i}_${'diagnostic '.repeat(8)}", error);`),
    '  } finally {',
    `    cleanupRecord("CLEANUP_DETAIL_${'closed record sequence '.repeat(24)}");`,
    '  }',
    '  register(records, (record) => {',
    '    if (record > 0) {',
    '      total = normalizeRecord(record);',
    '    } else {',
    '      total--;',
    '    }',
    '  }, enabled, "CALLBACK_ARGUMENT");',
    '  total = rejectRecord(total);',
    '  return total;',
    '}',
  ]
  writeFileSync(f.file, lines.join('\n'))
  const extracted = extractJs(f.file)
  const graph = buildFromJson({ schema_version: 1, nodes: extracted.nodes, edges: extracted.edges }, { directed: true })
  graph.graph.root_path = f.root
  const idFor = (name: string): string => graph.nodeEntries().find(([, node]) => node.label === `${name}()`)![0]
  const entry = idFor('processRecords'), callee = idFor('normalizeRecord')
  const dependencies = selectSourceDependencies(graph, [entry], f.root, new Map(), { includeCallers: false, inspectionOnly: true })
  const sourceNode = (name: string): SourceNode => {
    const id = idFor(name), range = lineRangeFromSourceLocation(graph.nodeAttributes(id).source_location)!
    return { node_id: id, label: `${name}()`, source_file: f.file, snippet_scope: 'symbol',
      snippet_line_range: { start_line: range.start, end_line: range.end }, snippet: lines.slice(range.start - 1, range.end).join('\n') }
  }
  const caller = sourceNode('processRecords'), range = caller.snippet_line_range
  caller.snippet_omitted_ranges = [{ start_line: range.start_line + 2, end_line: range.end_line - 1 }]
  caller.snippet_truncated = true
  caller.snippet = [...lines.slice(range.start_line - 1, range.start_line + 1),
    `[omitted lines ${range.start_line + 2}-${range.end_line - 1}]`, lines[range.end_line - 1]].join('\n')
  const payload = structuredClone(f.payload)
  record(payload.pack).matched_nodes = [caller, sourceNode('normalizeRecord'), sourceNode('rejectRecord')]
  record(payload.pack).relationships = [callee, idFor('rejectRecord')].map(to_id => ({ from_id: entry, to_id, relation: 'calls' }))
  const bundles = [callee, idFor('rejectRecord')].map(id => dependencies.source_callsite_bundles!.find(bundle => bundle.from_id === entry && bundle.to_id === id)!)
  return { ...f, lines, graph, idFor, entry, callee, dependencies, bundles, payload }
}

function verifiedLines(payload: RecordValue, file: string, lines: readonly string[]): Set<number> {
  const seen = new Set<number>(), entries = nodes(payload)
  for (const node of entries.filter(node => resolve(dirname(file), node.source_file) === resolve(file))) {
    const expected: string[] = [], range = node.snippet_line_range, omitted = node.snippet_omitted_ranges ?? []
    for (let line = range.start_line; line <= range.end_line; line++) {
      const gap = omitted.find(gap => gap.start_line === line)
      if (gap) { expected.push(`[omitted lines ${gap.start_line}-${gap.end_line}]`); line = gap.end_line }
      else { expected.push(lines[line - 1]!); seen.add(line) }
    }
    expect(resolveSourceSnippet(node, entries)).toBe(expected.join('\n'))
  }
  return seen
}
function finish(f: ReturnType<typeof fixture>, budget: number, bundles = f.bundles, configurationFresh?: () => boolean) {
  const store = new Map<string, SourceContinuationHandle>()
  const baseline = structuredClone(f.payload)
  baseline.serialized_budget = { max_tokens: budget, token_count: 0, enforced: true }
  for (let i = 0; i < 12; i++) {
    const count = estimateQueryTokens(JSON.stringify(baseline))
    if (record(baseline.serialized_budget).token_count === count) break
    record(baseline.serialized_budget).token_count = count
  }
  const payload = continuations.finalizeSourceCallsiteCompletion(baseline, budget, f.root, bundles,
    (id, handle) => store.set(id, handle), configurationFresh)
  expect(record(payload.serialized_budget).token_count).toBe(estimateQueryTokens(JSON.stringify(payload)))
  expect(estimateQueryTokens(JSON.stringify(payload))).toBeLessThanOrEqual(budget)
  return { payload, store }
}

describe('append-only final callsite source completion', () => {
  it('builds bounded control context alternatives without changing legacy all-sites output', () => {
    const f = controlFixture(), bundle = f.bundles[0]!
    expect(bundle.sites).toHaveLength(2)
    expect(bundle.range_alternatives).toHaveLength(2)
    const text = (ranges: Range[]) => ranges.map(range => f.lines.slice(range.start_line - 1, range.end_line).join('\n')).join('\n')
    const preferred = text(bundle.range_alternatives![0]!), shells = text(bundle.range_alternatives![1]!)
    for (const token of ['if (enabled)', '} else {', 'catch (error)', '} finally {', 'register(records, (record) => {',
      'if (record > 0)', 'total = normalizeRecord(total);', 'total = normalizeRecord(record);', '}, enabled, "CALLBACK_ARGUMENT");']) {
      expect(preferred).toContain(token); expect(shells).toContain(token)
    }
    expect(preferred).toContain('CLEANUP_DETAIL_'); expect(preferred).toContain('total--;')
    expect(shells).not.toContain('CLEANUP_DETAIL_'); expect(shells).not.toContain('total--;')
    for (const variant of [preferred, shells]) { expect(variant).not.toContain('HANDLER_'); expect(variant).not.toContain('OTHER_BRANCH_') }
    const legacy = f.bundles.map(({ range_alternatives: _alternatives, ...bundle }) => bundle)
    expect(finish(f, 10000)).toEqual(finish(f, 10000, legacy))
  })

  it('adds bounded control context atomically after all legacy additions and preserves source recovery', () => {
    const f = controlFixture(), first = f.bundles[0]!, late = f.bundles[1]!
    const { range_alternatives, ...base } = first
    const compact = { ...base, ranges: range_alternatives![0]! }
    const estimate = finish(f, 10000, [compact, late])
    const budget = Number(record(estimate.payload.serialized_budget).token_count) + 4
    const result = finish(f, budget)
    const original = verifiedLines(f.payload, f.file, f.lines), delivered = verifiedLines(result.payload, f.file, f.lines)
    for (const line of original) expect(delivered.has(line)).toBe(true)
    for (const range of compact.ranges) for (let line = range.start_line; line <= range.end_line; line++) expect(delivered.has(line)).toBe(true)
    expect(resolveSourceSnippet(nodes(result.payload)[0]!, nodes(result.payload))).not.toContain('HANDLER_')
    expect(record(result.payload.pack).relationships).toEqual(record(f.payload.pack).relationships)
    expect(result.payload.evidence).toEqual(f.payload.evidence)
    expect([...result.store.keys()]).toEqual(nodes(result.payload).flatMap(node => typeof node.source_expand_handle === 'string' ? [node.source_expand_handle] : []))
    const handle = result.store.get(String(nodes(result.payload)[0]!.source_expand_handle))!
    expect(handle).toBeDefined()
    for (const line of delivered) expect(handle.pending_ranges.some(range => range.start_line <= line && range.end_line >= line)).toBe(false)
    // Measure both complete cursor-bearing alternatives: a price without the
    // late callsite cannot bound its union because cursor token sizes can differ.
    const shell = { ...base, ranges: range_alternatives![1]! }
    const lower = compactRepeatedSourceMetadata(finish(f, 10000, [shell, late]).payload, 10000)
    const upper = compactRepeatedSourceMetadata(estimate.payload, 10000)
    for (const [payload, ranges] of [[lower, shell.ranges], [upper, compact.ranges]] as const) {
      const lines = verifiedLines(payload, f.file, f.lines)
      for (const range of [...ranges, ...late.ranges]) for (let line = range.start_line; line <= range.end_line; line++) expect(lines.has(line)).toBe(true)
      expect(nodes(payload)[0]!.source_expand_handle).toEqual(expect.any(String))
    }
    const priceAt = (payload: RecordValue, cap: number): number => {
      const priced = structuredClone(payload)
      priced.serialized_budget = { max_tokens: cap, token_count: 0, enforced: true }
      for (let i = 0; i < 12; i++) {
        const count = estimateQueryTokens(JSON.stringify(priced))
        if (record(priced.serialized_budget).token_count === count) break
        record(priced.serialized_budget).token_count = count
      }
      const count = estimateQueryTokens(JSON.stringify(priced))
      expect(record(priced.serialized_budget).token_count).toBe(count)
      return count
    }
    const tight = Math.floor((priceAt(lower, 10000) + priceAt(upper, 10000)) / 2)
    // Reserve every late legacy range while excluding the preferred optional
    // context at the actual cap, including its exact cursor and budget receipt.
    expect(priceAt(lower, tight)).toBeLessThanOrEqual(tight)
    expect(priceAt(upper, tight)).toBeGreaterThan(tight)
    const tightResult = finish(f, tight), tightLines = verifiedLines(tightResult.payload, f.file, f.lines)
    for (const range of late.ranges) for (let line = range.start_line; line <= range.end_line; line++) expect(tightLines.has(line)).toBe(true)
    for (const site of first.sites) expect(tightLines.has(f.lines.join('\n').slice(0, site.start_offset).split('\n').length)).toBe(true)
    expect(resolveSourceSnippet(nodes(tightResult.payload)[0]!, nodes(tightResult.payload))).not.toContain('CLEANUP_DETAIL_')
    const laterOnly = finish(f, tight, [late])
    for (const line of verifiedLines(laterOnly.payload, f.file, f.lines)) expect(tightLines.has(line)).toBe(true)
  })

  it('prices bounded control context after repeated metadata while reserving its actual source cursor', () => {
    const f = controlFixture(), first = f.bundles[0]!, late = f.bundles[1]!
    f.payload.task_intent = 'explain'
    f.payload.cache = { status: 'miss', graph_version: 'fixture-version' }
    record(record(f.payload.governance).graph_freshness).graph_version = 'fixture-version'
    record(f.payload.evidence).missing_phases = []
    record(f.payload.pack).source_dependencies = { unresolved_groups: [{ source_file: f.file, reason: 'unresolved',
      calls: [5, 6, 7, 8].map(line_number => ({ line_number, callee: 'recordFailure' })) }] }
    const { range_alternatives, ...legacy } = first
    const shell = { ...legacy, ranges: range_alternatives![1]! }
    const uncompressed = finish(f, 10000, [shell, late])
    const projected = compactRepeatedSourceMetadata(uncompressed.payload, 10000)
    const budget = Number(record(projected.serialized_budget).token_count) + 8
    expect(estimateQueryTokens(JSON.stringify(uncompressed.payload))).toBeGreaterThan(budget)
    // Both calls fit only through optional pricing: the ordinary full-range
    // path retains the original metadata and cannot reserve this same source.
    const ordinary = finish(f, budget, [shell, late]), result = finish(f, budget)
    const delivered = verifiedLines(result.payload, f.file, f.lines)
    const ordinaryLines = verifiedLines(ordinary.payload, f.file, f.lines)
    expect(first.sites.some(site => !ordinaryLines.has(f.lines.join('\n').slice(0, site.start_offset).split('\n').length))).toBe(true)
    for (const line of verifiedLines(f.payload, f.file, f.lines)) expect(delivered.has(line)).toBe(true)
    for (const range of [...shell.ranges, ...late.ranges]) for (let line = range.start_line; line <= range.end_line; line++) expect(delivered.has(line)).toBe(true)
    expect(result.payload.task_intent).toBeUndefined()
    expect(record(result.payload.cache)).toEqual({ status: 'miss' })
    expect(record(result.payload.evidence).answerability).toEqual(record(f.payload.evidence).answerability)
    expect(record(result.payload.pack).relationships).toEqual(record(f.payload.pack).relationships)
    const handle = result.store.get(String(nodes(result.payload)[0]!.source_expand_handle))!
    expect(handle).toBeDefined()
    for (const line of delivered) expect(handle.pending_ranges.some(range => range.start_line <= line && range.end_line >= line)).toBe(false)
    expect([...result.store.keys()]).toEqual(nodes(result.payload).flatMap(node => typeof node.source_expand_handle === 'string' ? [node.source_expand_handle] : []))
    // When even the compact proposal is too large, source, metadata and stores
    // remain exactly those of the completed legacy pass.
    const tightBudget = Number(record(finish(f, 10000, [late]).payload.serialized_budget).token_count) + 1
    expect(finish(f, tightBudget)).toEqual(finish(f, tightBudget, [late]))
  })

  it('rejects invalid bounded control context and stale proof instead of delivering an easy site', () => {
    const f = controlFixture(), first = f.bundles[0]!, late = f.bundles[1]!
    const baseline = finish(f, 10000, [late])
    const budget = Number(record(baseline.payload.serialized_budget).token_count) + 100
    const expected = finish(f, budget, [late])
    const incomplete = [{ start_line: first.ranges[0]!.start_line, end_line: first.ranges[0]!.end_line }]
    for (const alternatives of [[incomplete], [first.ranges], [incomplete, incomplete, incomplete]]) {
      expect(finish(f, budget, [{ ...first, range_alternatives: alternatives }, late])).toEqual(expected)
    }
    expect(finish(f, budget, f.bundles, () => false)).toEqual(finish(f, budget, []))
    writeFileSync(f.file, f.lines.join('\n').replace('normalizeRecord(record)', 'normalizeRecord(total)'))
    const stale = finish(f, budget)
    expect(resolveSourceSnippet(nodes(stale.payload)[0]!, nodes(stale.payload))).not.toContain('total = normalizeRecord(record);')
  })

  it('binds distinct calls and complete conditional/callback statements while refusing mutable aliases', () => {
    const f = fixture(true), all = f.dependencies.source_callsite_bundles ?? []
    expect(f.bundles).toHaveLength(1)
    expect(f.bundles[0]!.sites).toHaveLength(4)
    const text = f.bundles[0]!.ranges.map(range => f.lines.slice(range.start_line - 1, range.end_line).join('\n')).join('\n')
    expect(text).toContain('if (enabled) {\n    total = normalizeRecord(total);\n  }')
    expect(text).toContain('records.forEach((record) => {\n    if (record > 0) {\n      total = normalizeRecord(record);\n    }\n  });')
    expect(text).toContain('if (enabled) {\n    const results = {')
    expect(text).toContain('["normalized" + records.length]: enabled\n        ? normalizeRecord(total)\n        : rejectRecord(total),')
    expect(text).toContain('accepted: enabled && normalizeRecord(total),')
    expect(text).toContain('    };\n  }')
    expect(text).not.toContain('UNRELATED_PROPERTY_')
    expect(text).not.toContain('UNRELATED_METHOD_BODY')
    for (const [name, marker] of [['multipleDeclarations', 'MULTI_OBJECT_SIBLING'],
      ['destructuredObject', 'DESTRUCTURED_SIBLING'], ['assignedObject', 'ASSIGNMENT_SIBLING'],
      ['spreadObject', 'SPREAD_SIBLING'], ['nestedCallback', 'CALLBACK_SIBLING']]) {
      const bundle = all.find(bundle => bundle.from_id === f.idFor(name!) && bundle.to_id === f.callee)
      expect(bundle, name).toBeDefined()
      const source = bundle!.ranges.map(range => f.lines.slice(range.start_line - 1, range.end_line).join('\n')).join('\n')
      expect(source, name).toContain(marker)
    }
    const pair = all.filter(bundle => bundle.from_id === f.idFor('pair'))
    expect(pair).toHaveLength(2)
    const expressions = pair.map(bundle => f.lines.join('\n').slice(bundle.sites[0]!.start_offset, bundle.sites[0]!.end_offset))
    expect(expressions.sort()).toEqual(['normalizeRecord(1)', 'rejectRecord(2)'])
    expect(all.filter(bundle => bundle.from_id === f.idFor('mutable'))).toEqual([])
    const retrieval = withRetrieveSnippetBudget(retrieveContext(f.graph, {
      question: 'Trace record processing E_RECORDS_POLICY and transformation calls through records.mjs.', budget: 2500, taskKind: 'explain',
    }))
    expect(retrieval[sourceCallsiteBundlesKey]?.length).toBeGreaterThan(0)
    const wire = JSON.stringify(retrieval)
    for (const internal of ['source_callsite_bundles', 'source_sha256', 'start_offset', 'end_offset']) expect(wire).not.toContain(`"${internal}"`)
    const { payload } = finish(f, 2500)
    const baseline = verifiedLines(f.payload, f.file, f.lines), delivered = verifiedLines(payload, f.file, f.lines)
    expect(delivered.size).toBeGreaterThan(baseline.size)
    for (const line of baseline) expect(delivered.has(line)).toBe(true)
    for (const range of f.bundles[0]!.ranges) for (let line = range.start_line; line <= range.end_line; line++) expect(delivered.has(line)).toBe(true)
    expect(resolveSourceSnippet(nodes(payload)[0]!, nodes(payload))).not.toContain('UNRELATED_PROPERTY_')
    expect(record(payload.pack).relationships).toEqual(record(f.payload.pack).relationships)
    expect(nodes(payload).find(node => node.node_id === 'callee-ref')).toEqual(nodes(f.payload).find(node => node.node_id === 'callee-ref'))
    expect(payload.evidence).toEqual(f.payload.evidence)
  })

  it('keeps complete bundles atomic at the final budget and preserves referenced owners and rejected handle stores', () => {
    const f = fixture(), input = JSON.stringify(f.payload)
    const baseline = finish(f, 2500, [])
    const smallBudget = Number(record(baseline.payload.serialized_budget).token_count)
    const tightBaseline = finish(f, smallBudget, [])
    const tight = finish(f, smallBudget)
    expect(tight.payload).toEqual(tightBaseline.payload)
    expect([...tight.store]).toEqual([...tightBaseline.store])
    expect(JSON.stringify(f.payload)).toBe(input)
    const withRef = structuredClone(f.payload)
    nodes(withRef).push({ ...nodes(withRef)[0]!, node_id: 'caller-ref', snippet: undefined, snippet_ref: f.entry })
    f.payload = withRef
    const referencedBaseline = finish(f, 2500, [])
    expect(finish(f, 2500).payload).toEqual(referencedBaseline.payload)
    f.payload = JSON.parse(input) as RecordValue
    expect(finish(f, 2500, f.bundles, () => false).payload).toEqual(finish(f, 2500, []).payload)
  })

  it('uses final ranges for continuations and rejects same-size source drift through helper and strict MCP cache', async () => {
    vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
    const f = fixture(), initial = finish(f, 2500)
    const seen = verifiedLines(initial.payload, f.file, f.lines)
    const owner = nodes(initial.payload).find(node => node.node_id === f.entry)!
    const id = String(owner.source_expand_handle)
    expect(initial.store.has(id)).toBe(true)
    const handle = initial.store.get(id)!
    const page = continuations.expandSourceContinuation(handle, 1000, f.root, initial.payload.governance)
    for (const line of verifiedLines(page.payload, f.file, f.lines)) expect(seen.has(line)).toBe(false)

    const graphPath = generateGraph(f.root, { noHtml: true, includeDocs: false }).graphPath
    const state: NonNullable<Parameters<typeof handleStdioRequest>[2]> = { logLevel: 'info', subscribedResourceUris: new Set(), resourceVersions: new Map(), resourceListSignature: null }
    let requestId = 0
    const call = async () => {
      const response = await handleStdioRequest(graphPath, { id: ++requestId, method: 'tools/call', params: { name: 'context_pack', arguments: {
        prompt: 'Trace record processing E_RECORDS_POLICY and transformation calls through records.mjs.', task: 'explain', budget: 2500,
      } } }, state)
      expect(response?.error).toBeUndefined()
      const text = (response!.result as { content: Array<{ text: string }> }).content[0]!.text
      const payload = JSON.parse(text) as RecordValue
      expect(record(payload.serialized_budget).token_count).toBe(estimateQueryTokens(text))
      expect(estimateQueryTokens(text)).toBeLessThanOrEqual(2500)
      return payload
    }
    const spy = vi.spyOn(continuations, 'finalizeSourceCallsiteCompletion')
    const mcp = await call()
    expect(spy).toHaveBeenCalled()
    const beforeMcp = verifiedLines(spy.mock.calls[0]![0], f.file, f.lines)
    const afterMcp = verifiedLines(mcp, f.file, f.lines)
    expect(afterMcp.size).toBeGreaterThan(beforeMcp.size)
    for (const line of beforeMcp) expect(afterMcp.has(line)).toBe(true)
    const cached = await call()
    expect(record(cached.cache).status).toBe('hit')
    const cachedLines = verifiedLines(cached, f.file, f.lines)
    expect([...cachedLines].sort((a, b) => a - b)).toEqual([...afterMcp].sort((a, b) => a - b))
    expect(spy).toHaveBeenCalledTimes(2)
    const before = statSync(f.file)
    writeFileSync(f.file, f.lines.join('\n').replace('value + 1', 'value + 2'))
    utimesSync(f.file, before.atime, before.mtime)
    expect(statSync(f.file).size).toBe(before.size)
    expect(finish(f, 2500).payload).toEqual(finish(f, 2500, []).payload)
    expect(() => continuations.expandSourceContinuation(handle, 1000, f.root, initial.payload.governance)).toThrow(/changed|source/i)
    const changed = await call()
    // A cache may return its original conservative source, but must never resurrect a new source addition from stale provenance.
    expect(nodes(changed).find(node => node.node_id === f.entry)?.snippet).not.toContain('total = normalizeRecord(record)')
    writeFileSync(join(f.root, '.madarignore'), 'records.mjs\n')
    expect(finish(f, 2500).payload).toEqual(finish(f, 2500, []).payload)

    const v = fixture(false, true), references = v.dependencies.source_function_value_references!
    record(v.payload.pack).selection_scope = 'task_context'
    const targetId = v.idFor('cleanupRecord'), targetReferences = references.filter(reference => reference.target.node_id === targetId)
    expect(targetReferences).toHaveLength(2)
    expect(v.dependencies.relationships.some(edge => edge.to_id === targetId)).toBe(false)
    const append = (input: ReturnType<typeof finish>, budget = 2500) => {
      const handles = new Map(input.store), written: string[] = []
      const payload = continuations.completeSourceFunctionValueReferences(input.payload, budget, v.root,
        'Explain E_RECORDS_POLICY validation and VALUE_REF_POLICY cleanup.', references, id => handles.get(id),
        (id, handle) => { handles.set(id, handle); written.push(id) }, () => true)
      return { payload, handles, written }
    }
    const hidden = finish(v, 2500, [])
    expect(append(hidden).payload).toEqual(hidden.payload)
    // Expose only the first read; the second identical binding stays omitted.
    const valueOwner = nodes(v.payload)[0]!, firstGap = valueOwner.snippet_omitted_ranges![0]!
    const shown = firstGap.start_line
    firstGap.start_line++
    valueOwner.snippet = [...v.lines.slice(valueOwner.snippet_line_range.start_line - 1, shown),
      `[omitted lines ${firstGap.start_line}-${firstGap.end_line}]`, ...v.lines.slice(firstGap.end_line, valueOwner.snippet_line_range.end_line)].join('\n')
    nodes(v.payload).push({ node_id: 'source-file', label: 'records.mjs', source_file: v.file, snippet_scope: 'source_file',
      snippet_line_range: { start_line: 1, end_line: v.lines.length }, snippet_omitted_ranges: [{ start_line: 2, end_line: v.lines.length }],
      snippet_truncated: true, snippet: `${v.lines[0]}\n[omitted lines 2-${v.lines.length}]` })
    const visible = finish(v, 2500, []), appended = append(visible)
    const added = nodes(appended.payload).find(node => node.node_id === targetId)!
    expect(added.snippet).toContain('CLEANUP_APPLIED')
    verifiedLines(appended.payload, v.file, v.lines)
    expect(appended.payload.evidence).toEqual(visible.payload.evidence)
    expect(record(appended.payload.pack).relationships).toEqual(record(visible.payload.pack).relationships)
    for (const node of nodes(visible.payload)) expect(resolveSourceSnippet(node, nodes(visible.payload)))
      .toBe(resolveSourceSnippet(nodes(appended.payload).find(next => next.node_id === node.node_id)!, nodes(appended.payload)))
    expect(appended.written.length).toBeGreaterThan(0)
    for (const id of appended.written) {
      const handle = appended.handles.get(id)!
      expect(handle.pending_ranges.some(range => range.start_line <= added.snippet_line_range.end_line && range.end_line >= added.snippet_line_range.start_line)).toBe(false)
      expect(nodes(appended.payload).some(node => node.source_expand_handle === id)).toBe(true)
    }
    let cap = Number(record(visible.payload.serialized_budget).token_count), tight = finish(v, cap, [])
    for (let i = 0; i < 12 && Number(record(tight.payload.serialized_budget).token_count) !== cap; i++) {
      cap = Number(record(tight.payload.serialized_budget).token_count); tight = finish(v, cap, [])
    }
    expect(append(tight, cap).payload).toEqual(tight.payload)
    const valueGraphPath = generateGraph(v.root, { noHtml: true, includeDocs: false }).graphPath
    const valueState: NonNullable<Parameters<typeof handleStdioRequest>[2]> = { logLevel: 'info', subscribedResourceUris: new Set(), resourceVersions: new Map(), resourceListSignature: null }
    const valueCall = async () => {
      const response = await handleStdioRequest(valueGraphPath, { id: ++requestId, method: 'tools/call', params: { name: 'context_pack', arguments: {
        prompt: 'Explain E_RECORDS_POLICY validation and VALUE_REF_POLICY cleanup, tracing their transformation calls.', task: 'explain', budget: 2500,
      } } }, valueState)
      expect(response?.error).toBeUndefined()
      return JSON.parse((response!.result as { content: Array<{ text: string }> }).content[0]!.text) as RecordValue
    }
    const valueSpy = vi.spyOn(continuations, 'completeSourceFunctionValueReferences')
    const coldValues = await valueCall()
    expect(valueSpy).toHaveBeenCalled()
    expect(nodes(valueSpy.mock.calls[0]![0]).some(node => node.label === 'cleanupRecord()')).toBe(false)
    expect(nodes(coldValues).some(node => node.snippet?.toString().includes('CLEANUP_APPLIED'))).toBe(true)
    for (const [key, text] of valueState.contextPackCache ?? []) {
      const cached = JSON.parse(text); expect(cached.source_function_values.references.length).toBeGreaterThan(0)
      delete cached.source_callsites
      valueState.contextPackCache!.set(key, JSON.stringify(cached))
    }
    const warmValues = await valueCall()
    expect(record(warmValues.cache).status).toBe('hit')
    expect(nodes(warmValues).some(node => node.snippet?.toString().includes('CLEANUP_APPLIED'))).toBe(true)
    const sourceStat = statSync(v.file)
    writeFileSync(v.file, v.lines.join('\n').replace('CLEANUP_APPLIED', 'CLEANUP_IGNORED'))
    utimesSync(v.file, sourceStat.atime, sourceStat.mtime)
    expect(statSync(v.file).size).toBe(sourceStat.size)
    const driftedValues = await valueCall()
    expect(nodes(driftedValues).some(node => node.snippet?.toString().includes('CLEANUP_APPLIED'))).toBe(false)
    expect(append(visible).payload).toEqual(visible.payload)
  })
})
