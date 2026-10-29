import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { readQueryEvidenceSnippet } from '../../src/runtime/retrieve.js'
import { sourceExcerptGuardRanges } from '../../src/runtime/retrieve/source-excerpt-guards.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { attachSourceContinuationHandles, completeSourceExcerptGuards, type SourceContinuationHandle } from '../../src/runtime/source-continuation.js'
import { resolveSourceSnippet, SOURCE_EVIDENCE_RESPONSE_FORMAT } from '../../src/runtime/source-evidence-response.js'

type RecordValue = Record<string, unknown>
type Range = { start_line: number; end_line: number }
type SourceNode = RecordValue & { node_id: string; label: string; source_file: string; snippet_line_range: Range; snippet_omitted_ranges?: Range[] }
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const object = (value: unknown): RecordValue => value as RecordValue
const nodes = (payload: RecordValue): SourceNode[] => object(payload.pack).matched_nodes as SourceNode[]
const rangeLines = (ranges: readonly Range[]): number[] => ranges.flatMap(range => Array.from({ length: range.end_line - range.start_line + 1 }, (_, i) => range.start_line + i))
const budgeted = (value: RecordValue, budget: number): RecordValue => {
  const payload = structuredClone(value)
  payload.serialized_budget = { max_tokens: budget, token_count: 0, enforced: true }
  for (let i = 0; i < 12; i++) {
    const count = estimateQueryTokens(JSON.stringify(payload)), receipt = object(payload.serialized_budget)
    if (receipt.token_count === count) return payload
    receipt.token_count = count
  }
  throw new Error('Fixture serialized receipt did not stabilize')
}

function fixture(lines: string[], options: { file?: string; label?: string; ownerEnd?: number; sibling?: Range } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'madar-excerpt-guards-')); roots.push(root)
  const file = join(root, options.file ?? 'records.js'), label = options.label ?? 'routeRequest()'
  const ownerEnd = options.ownerEnd ?? lines.length, prompt = 'Where is `TRACK_SOCKET` recorded?'
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, lines.join('\n'))
  const read = (start: number, end: number, name: string): SourceNode => {
    const excerpt = readQueryEvidenceSnippet(file, start, { question: prompt, label: name, sourceLocation: `L${start}-L${end}`, rootPath: root })
    expect(excerpt).not.toBeNull()
    return { node_id: start === 1 ? 'selected-owner' : 'request-helper', label: name, source_file: file, line_number: start,
      snippet: excerpt!.snippet, snippet_line_number: excerpt!.lineNumber, snippet_scope: excerpt!.scope,
      snippet_line_range: excerpt!.snippet_line_range!,
      ...(excerpt!.snippet_omitted_ranges ? { snippet_omitted_ranges: excerpt!.snippet_omitted_ranges, snippet_truncated: excerpt!.snippet_truncated } : {}),
      extension: { opaque: ['preserve', start] } }
  }
  const entries = [read(1, ownerEnd, label)]
  if (options.sibling) entries.push(read(options.sibling.start_line, options.sibling.end_line, 'createRequest()'))
  const input: RecordValue = { task: 'explain', response_format: SOURCE_EVIDENCE_RESPONSE_FORMAT,
    pack: { selection_scope: 'task_context', retrieval_strategy: 'default', matched_nodes: entries,
      relationships: options.sibling ? [{ from_id: 'selected-owner', to_id: 'request-helper', relation: 'calls', extension: { keep: true } }] : [],
      extension: { opaque: 'keep pack metadata' } },
    evidence: { answerability: { state: 'insufficient', answer_scope: 'partial', advisory: true,
      missing_obligations: ['runtime:invocation'], broad_search_fallback: 'allowed', caveats: ['Guard source is not invocation proof.'] } },
    governance: { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } },
    extension: { retain: [false, 'unknown top-level metadata'] } }
  const handles = new Map<string, SourceContinuationHandle>()
  const payload = attachSourceContinuationHandles(budgeted(input, 5000), 5000, root, (id, handle) => handles.set(id, handle))
  return { root, file, lines, prompt, payload, handles, ownerEnd }
}

function closingFixture(extension = 'js', sourceFile = `records.${extension}`) {
  const lines = [
    'export function routeRequest(req, res, closing, return503OnClosing) {',
    '  const observed = [];',
    '  let total = 0;',
    '  // Existing leading source stays in place.',
    ...Array.from({ length: 26 }, (_, i) => `  total += ${i + 1};`),
    '  // if (imaginaryClosing) { const inventedHeaders = {}; }',
    '  if (closing) {',
    '    // A comment is not another controlling branch.',
    '    if (return503OnClosing) {',
    '      const headers = {',
    '        "Content-Type": "application/json",',
    '        "Content-Length": "80"',
    '      };',
    '      res.writeHead(503, headers);',
    '      res.end("Service Unavailable");',
    '      return;',
    '    }',
    '  }',
    '',
    '  // Existing later processing is not traded away for the guards.',
    '  const connHeader = String(req.headers.connection || "").toLowerCase();',
    '  if (connHeader === "keep-alive") {',
    '    if (!observed.includes(req.socket)) {',
    '      observed.push("TRACK_SOCKET");',
    '      req.socket.on("close", removeTrackedSocket.bind({ observed, socket: req.socket }));',
    '    }',
    '  }',
    '  const request = createRequest(req);',
    '  inspectRequest(request);',
    ...Array.from({ length: 56 }, (_, i) => `  total += ${i + 100};`),
    '  if (req.unrelatedMode) {',
    '    observed.push("UNRELATED_BRANCH_NOT_SELECTED");',
    '  }',
    '  return request;',
    '}',
  ]
  const ownerEnd = lines.length
  lines.push('function createRequest(req) {', '  return { raw: req };', '}')
  return fixture(lines, { file: sourceFile, ownerEnd, sibling: { start_line: ownerEnd + 1, end_line: ownerEnd + 3 } })
}

function delivered(f: ReturnType<typeof fixture>, payload: RecordValue, id = 'selected-owner'): Set<number> {
  const entries = nodes(payload), node = entries.find(value => value.node_id === id)!
  expect(node).toBeDefined()
  const seen = new Set<number>(), expected: string[] = []
  for (let line = node.snippet_line_range.start_line; line <= node.snippet_line_range.end_line; line++) {
    const gap = node.snippet_omitted_ranges?.find(range => range.start_line === line)
    if (gap) { expected.push(`[omitted lines ${gap.start_line}-${gap.end_line}]`); line = gap.end_line }
    else { expected.push(f.lines[line - 1]!); seen.add(line) }
  }
  expect(resolveSourceSnippet(node, entries)).toBe(expected.join('\n'))
  return seen
}

function complete(f: ReturnType<typeof fixture>, input = f.payload, configurationFresh = () => true) {
  const handles = new Map([...f.handles].map(([id, handle]) => [id, structuredClone(handle)])), written: string[] = []
  const budget = Number(object(input.serialized_budget).max_tokens)
  const payload = completeSourceExcerptGuards(input, budget, f.root, f.prompt, id => handles.get(id),
    (id, handle) => { handles.set(id, handle); written.push(id) }, configurationFresh)
  const count = estimateQueryTokens(JSON.stringify(payload))
  expect(payload.serialized_budget).toEqual({ max_tokens: budget, token_count: count, enforced: true })
  expect(count).toBeLessThanOrEqual(budget)
  const advertised = new Set(nodes(payload).flatMap(node => typeof node.source_expand_handle === 'string' ? [node.source_expand_handle] : []))
  for (const id of written) expect(advertised.has(id)).toBe(true)
  return { payload, handles, written }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const lineRanges = (values: Iterable<number>): Range[] => {
  const ranges: Range[] = []
  for (const line of [...new Set(values)].sort((a, b) => a - b)) {
    const last = ranges.at(-1)
    if (last && last.end_line + 1 === line) last.end_line = line
    else ranges.push({ start_line: line, end_line: line })
  }
  return ranges
}

/** Render an explicitly chosen source set; no retrieval or syntax selection participates. */
function exactExcerpt(lines: readonly string[], ownerEnd: number, kept: ReadonlySet<number>) {
  const omitted = lineRanges(Array.from({ length: ownerEnd }, (_, i) => i + 1).filter(line => !kept.has(line)))
  const snippet: string[] = []
  for (let line = 1; line <= ownerEnd; line++) {
    const gap = omitted.find(range => range.start_line === line)
    if (gap) { snippet.push(`[omitted lines ${gap.start_line}-${gap.end_line}]`); line = gap.end_line }
    else snippet.push(lines[line - 1]!)
  }
  return { snippet: snippet.join('\n'), snippet_omitted_ranges: omitted }
}

function terminalFixture(selected: string[], branch: 'then' | 'else' = 'then') {
  const root = mkdtempSync(join(tmpdir(), 'madar-terminal-guards-')); roots.push(root)
  const file = join(root, 'branch.js'), other = ['    record("OTHER_BRANCH");', '    return null;']
  const lines = ['export function settleRequest(req) {', '  const trace = [];', '  if (req.ready) {',
    ...(branch === 'then' ? selected : other), '  } else {', ...(branch === 'else' ? selected : other),
    '  }', '  afterBranch();', '}']
  const ownerEnd = lines.length, selectedLine = lines.indexOf('    record("SELECTED_STEP");') + 1
  expect(selectedLine).toBeGreaterThan(0)
  lines.push('function keepOwner(value) {', '  return value;', '}')
  writeFileSync(file, lines.join('\n'))
  const originalLines = new Set([1, selectedLine, ownerEnd])
  const oldGuardLines = new Set([...originalLines,
    ...['  if (req.ready) {', '  } else {', '  }'].map(text => lines.indexOf(text) + 1)])
  const input: RecordValue = { task: 'explain', response_format: SOURCE_EVIDENCE_RESPONSE_FORMAT,
    pack: { selection_scope: 'task_context', retrieval_strategy: 'default', matched_nodes: [
      { node_id: 'selected-owner', label: 'settleRequest()', source_file: file, line_number: 1,
        snippet_scope: 'symbol', snippet_line_range: { start_line: 1, end_line: ownerEnd },
        ...exactExcerpt(lines, ownerEnd, originalLines), snippet_truncated: true, extension: { retained: true } },
      { node_id: 'request-helper', label: 'keepOwner()', source_file: file, line_number: ownerEnd + 1,
        snippet_scope: 'symbol', snippet_line_range: { start_line: ownerEnd + 1, end_line: lines.length },
        snippet: lines.slice(ownerEnd).join('\n'), extension: { retained: 'other owner' } },
    ], relationships: [{ from_id: 'selected-owner', to_id: 'request-helper', relation: 'related', extension: { keep: true } }],
    extension: { retained: 'pack' } },
    evidence: { answerability: { state: 'insufficient', answer_scope: 'partial', advisory: true,
      missing_obligations: ['runtime:invocation'], broad_search_fallback: 'allowed', caveats: ['Selected source does not prove invocation.'] } },
    governance: { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } }, extension: { retained: 'response' } }
  const handles = new Map<string, SourceContinuationHandle>()
  const payload = attachSourceContinuationHandles(budgeted(input, 5000), 5000, root, (id, handle) => handles.set(id, handle))
  expect(handles.size).toBe(1)
  return { root, file, lines, prompt: 'Explain the selected branch.', payload, handles, ownerEnd, originalLines, oldGuardLines }
}

function exactCompletion(f: ReturnType<typeof terminalFixture>, kept: ReadonlySet<number>) {
  const payload = structuredClone(f.payload), node = nodes(payload)[0]!
  const old = f.handles.get(String(node.source_expand_handle))!, handle = structuredClone(old)
  Object.assign(node, exactExcerpt(f.lines, f.ownerEnd, kept))
  handle.pending_ranges = lineRanges(rangeLines(old.pending_ranges).filter(line => !kept.has(line)))
  const id = `source-expand:${sha256(JSON.stringify(handle)).slice(0, 32)}`
  node.source_expand_handle = id
  return { payload, handle, id }
}

describe('atomic final source excerpt guard completion', () => {
  it('closes immediate branch return and throw while preserving source recovery and admitted guards under pressure', () => {
    const terminals: Array<{ branch: 'then' | 'else'; lines: string[] }> = [
      { branch: 'then', lines: ['    return {', '      accepted: true,', '      requestId: req.id,',
        '      value: req.value,', '      note: "The accepted request is returned to its caller."', '    };'] },
      { branch: 'else', lines: ['    throw new Error("The request cannot continue because its selected branch rejected the supplied value.");'] },
    ]
    for (const terminal of terminals) {
      const f = terminalFixture(['    record("SELECTED_STEP");', ...terminal.lines], terminal.branch)
      const snapshot = JSON.stringify(f.payload), before = delivered(f, f.payload)
      expect(before).toEqual(f.originalLines)
      const owner = nodes(f.payload)[0]!, originalRanges = lineRanges(before)
      const legacy = sourceExcerptGuardRanges(f.lines, f.file, owner.label, owner.snippet_line_range, originalRanges)
      expect(legacy).not.toBeNull()
      expect(new Set([...before, ...rangeLines(legacy!)])).toEqual(f.oldGuardLines)
      const terminalStart = f.lines.indexOf(terminal.lines[0]!) + 1
      const terminalLines = Array.from({ length: terminal.lines.length }, (_, i) => terminalStart + i)
      for (const line of terminalLines) expect(before.has(line)).toBe(false)
      const expectedLines = new Set([...f.oldGuardLines, ...terminalLines])
      const optedIn = sourceExcerptGuardRanges(f.lines, f.file, owner.label, owner.snippet_line_range,
        originalRanges, { includeTerminalSiblings: true })
      expect(optedIn).not.toBeNull()
      expect(new Set([...before, ...rangeLines(optedIn!)])).toEqual(expectedLines)
      const expected = exactCompletion(f, expectedLines), result = complete(f), after = delivered(f, result.payload)
      expect(after).toEqual(expectedLines)
      expect(result.payload).toEqual(budgeted(expected.payload, 5000))
      for (const line of before) expect(after.has(line)).toBe(true)
      expect(after.has(f.lines.indexOf('    record("OTHER_BRANCH");') + 1)).toBe(false)
      expect(after.has(f.lines.indexOf('    return null;') + 1)).toBe(false)
      expect(nodes(result.payload).map(node => node.node_id)).toEqual(nodes(f.payload).map(node => node.node_id))
      expect(nodes(result.payload)[1]).toEqual(nodes(f.payload)[1])
      delivered(f, result.payload, 'request-helper')
      for (const [key, value] of Object.entries(owner)) {
        if (!['snippet', 'snippet_omitted_ranges', 'snippet_truncated', 'source_expand_handle'].includes(key)) {
          expect(nodes(result.payload)[0]![key], key).toEqual(value)
        }
      }
      for (const key of ['evidence', 'governance', 'extension']) expect(result.payload[key]).toEqual(f.payload[key])
      expect(object(result.payload.pack).relationships).toEqual(object(f.payload.pack).relationships)
      expect(object(result.payload.pack).extension).toEqual(object(f.payload.pack).extension)
      const oldId = String(owner.source_expand_handle), oldHandle = f.handles.get(oldId)!
      const newId = String(nodes(result.payload)[0]!.source_expand_handle), newHandle = result.handles.get(newId)!
      expect(newId).toBe(`source-expand:${sha256(JSON.stringify(newHandle)).slice(0, 32)}`)
      expect(newHandle.file_sha256).toBe(sha256(f.lines.join('\n')))
      expect(newHandle).toEqual({ ...oldHandle, pending_ranges: newHandle.pending_ranges })
      expect(rangeLines(newHandle.pending_ranges)).toEqual(rangeLines(oldHandle.pending_ranges).filter(line => !after.has(line)))
      expect(new Set(rangeLines(newHandle.pending_ranges)).size).toBe(rangeLines(newHandle.pending_ranges).length)
      for (const line of rangeLines(newHandle.pending_ranges)) expect(after.has(line)).toBe(false)
      for (const [id, handle] of f.handles) expect(result.handles.get(id)).toEqual(handle)
      expect(result.written).toEqual([newId])
      expect(newId).not.toBe(oldId)
      expect(JSON.stringify(f.payload)).toBe(snapshot)
    }

    // A separate costly expression supplies real pressure; a short exit may save tokens.
    const costlyTerminal = ['    return {',
      ...Array.from({ length: 32 }, (_, i) => `      item${i}: req.values[${i}] + ${i},`), '    };']
    const f = terminalFixture(['    record("SELECTED_STEP");', ...costlyTerminal]), snapshot = JSON.stringify(f.payload)
    const terminalStart = f.lines.indexOf(costlyTerminal[0]!) + 1
    const expected = exactCompletion(f, new Set([...f.oldGuardLines,
      ...Array.from({ length: costlyTerminal.length }, (_, i) => terminalStart + i)]))
    // Independently price only the old guards. An optional terminal must not erase them.
    const oldOnly = exactCompletion(f, f.oldGuardLines)
    let cap = estimateQueryTokens(JSON.stringify(oldOnly.payload)), pricedOld = budgeted(oldOnly.payload, cap)
    for (let i = 0; i < 12 && estimateQueryTokens(JSON.stringify(pricedOld)) !== cap; i++) {
      cap = estimateQueryTokens(JSON.stringify(pricedOld)); pricedOld = budgeted(oldOnly.payload, cap)
    }
    expect(estimateQueryTokens(JSON.stringify(pricedOld))).toBe(cap)
    expect(estimateQueryTokens(JSON.stringify(budgeted(expected.payload, cap)))).toBeGreaterThan(cap)
    const tight = budgeted(f.payload, cap), tightSnapshot = JSON.stringify(tight), pressure = complete(f, tight)
    expect(pressure.payload).toEqual(pricedOld)
    expect(delivered(f, pressure.payload)).toEqual(f.oldGuardLines)
    expect(pressure.handles.get(oldOnly.id)).toEqual(oldOnly.handle)
    expect(pressure.written).toEqual([oldOnly.id])
    expect(pressure.handles.has(expected.id)).toBe(false)
    for (const [id, handle] of f.handles) expect(pressure.handles.get(id)).toEqual(handle)
    expect(JSON.stringify(tight)).toBe(tightSnapshot)
    expect(JSON.stringify(f.payload)).toBe(snapshot)
  })

  it('keeps legacy guards when terminals are not immediate final same-branch statements or exceed optional bounds', () => {
    const selected = '    record("SELECTED_STEP");'
    const cases = [
      [selected, '    touchUnselected();', '    return req.value;'],
      [selected, '    return req.value;', '    touchUnselected();'],
      [selected, '    return () => req.value;'],
      [selected],
      [selected, `    return "${'x'.repeat(12050)}";`],
    ]
    for (const body of cases) {
      const f = terminalFixture(body), snapshot = JSON.stringify(f.payload), owner = nodes(f.payload)[0]!
      const originalRanges = lineRanges(f.originalLines)
      const legacy = sourceExcerptGuardRanges(f.lines, f.file, owner.label, owner.snippet_line_range, originalRanges)
      expect(legacy).not.toBeNull()
      expect(new Set([...f.originalLines, ...rangeLines(legacy!)])).toEqual(f.oldGuardLines)
      expect(sourceExcerptGuardRanges(f.lines, f.file, owner.label, owner.snippet_line_range,
        originalRanges, { includeTerminalSiblings: true })).toEqual(legacy)
      const expected = exactCompletion(f, f.oldGuardLines), result = complete(f)
      expect(result.payload).toEqual(budgeted(expected.payload, 5000))
      expect(delivered(f, result.payload)).toEqual(f.oldGuardLines)
      expect(result.handles.get(expected.id)).toEqual(expected.handle)
      expect(result.written).toEqual([expected.id])
      for (const [id, handle] of f.handles) expect(result.handles.get(id)).toEqual(handle)
      expect(nodes(result.payload)[1]).toEqual(nodes(f.payload)[1])
      expect(result.payload.evidence).toEqual(f.payload.evidence)
      expect(object(result.payload.pack).relationships).toEqual(object(f.payload.pack).relationships)
      expect(JSON.stringify(f.payload)).toBe(snapshot)
    }
  })

  it('adds exact nested guards and the boundary object declaration while preserving all earlier evidence and remaining recovery', () => {
    for (const extension of ['js', 'ts']) {
      const f = closingFixture(extension), original = JSON.stringify(f.payload), before = delivered(f, f.payload)
      expect(before.has(37)).toBe(true)
      for (const line of [32, 34, 35, 36]) expect(before.has(line)).toBe(false)
      for (const line of [46, 49, 50, 53, 54]) expect(before.has(line)).toBe(true)
      const result = complete(f), after = delivered(f, result.payload)
      for (const line of before) expect(after.has(line)).toBe(true)
      for (const line of [32, 34, 35, 36, 37, 38]) expect(after.has(line)).toBe(true)
      expect(after.has(31)).toBe(false)
      expect(resolveSourceSnippet(nodes(result.payload)[0]!, nodes(result.payload))).not.toContain('UNRELATED_BRANCH_NOT_SELECTED')
      expect(after.size).toBeGreaterThan(before.size)
      expect(nodes(result.payload).map(node => node.node_id)).toEqual(nodes(f.payload).map(node => node.node_id))
      expect(nodes(result.payload)[1]).toEqual(nodes(f.payload)[1])
      delivered(f, result.payload, 'request-helper')
      const oldOwner = nodes(f.payload)[0]!, newOwner = nodes(result.payload)[0]!
      for (const [key, value] of Object.entries(oldOwner)) {
        if (!['snippet', 'snippet_omitted_ranges', 'snippet_truncated', 'source_expand_handle'].includes(key)) expect(newOwner[key], key).toEqual(value)
      }
      for (const key of ['evidence', 'governance', 'extension']) expect(result.payload[key]).toEqual(f.payload[key])
      expect(object(result.payload.pack).relationships).toEqual(object(f.payload.pack).relationships)
      expect(object(result.payload.pack).extension).toEqual(object(f.payload.pack).extension)
      const oldId = String(oldOwner.source_expand_handle), newId = String(newOwner.source_expand_handle)
      expect(newId).not.toBe(oldId)
      const oldHandle = f.handles.get(oldId)!, newHandle = result.handles.get(newId)!
      expect(oldHandle).toBeDefined(); expect(newHandle).toBeDefined()
      expect(rangeLines(newHandle.pending_ranges)).toEqual(rangeLines(oldHandle.pending_ranges).filter(line => !after.has(line)))
      expect(newHandle).toEqual({ ...oldHandle, pending_ranges: newHandle.pending_ranges })
      expect(result.handles.get(oldId)).toEqual(oldHandle)
      expect(result.written).toEqual([newId])
      expect(JSON.stringify(f.payload)).toBe(original)
    }
  })

  it('keeps the original payload and handle store at the exact cap or when source syntax and scope cannot safely support completion', () => {
    const unchanged = (f: ReturnType<typeof fixture>, input = f.payload, configurationFresh?: () => boolean) => {
      const before = JSON.stringify(input), result = complete(f, input, configurationFresh)
      expect(JSON.stringify(result.payload)).toBe(before)
      expect([...result.handles]).toEqual([...f.handles])
      expect(result.written).toEqual([])
    }
    const f = closingFixture()
    let cap = estimateQueryTokens(JSON.stringify(f.payload)), tight = budgeted(f.payload, cap)
    for (let i = 0; i < 12 && estimateQueryTokens(JSON.stringify(tight)) !== cap; i++) {
      cap = estimateQueryTokens(JSON.stringify(tight)); tight = budgeted(f.payload, cap)
    }
    expect(estimateQueryTokens(JSON.stringify(tight))).toBe(cap)
    unchanged(f, tight)
    unchanged(f, f.payload, () => false)
    const ignoredTests = closingFixture('js', 'cypress/helper.js')
    ignoredTests.prompt = 'Where is `TRACK_SOCKET` recorded? Ignore tests.'
    unchanged(ignoredTests)
    const unknownReceipt = structuredClone(f.payload)
    object(unknownReceipt.serialized_budget).future_field = 'keep unknown receipt exactly'
    // Recount the added field without replacing the receipt extension.
    for (let i = 0; i < 12; i++) object(unknownReceipt.serialized_budget).token_count = estimateQueryTokens(JSON.stringify(unknownReceipt))
    const refused = completeSourceExcerptGuards(unknownReceipt, 5000, f.root, f.prompt, id => f.handles.get(id), () => { throw new Error('Unexpected handle write') }, () => true)
    expect(JSON.stringify(refused)).toBe(JSON.stringify(unknownReceipt))

    const small = fixture(['export function routeRequest(req) {', '  if (req.ready) {', '    return "TRACK_SOCKET";', '  }', '  return null;', '}'])
    expect(nodes(small.payload)[0]!.snippet_omitted_ranges).toBeUndefined()
    unchanged(small)
    unchanged(fixture(['def route_request(req):', '    total = 0', ...Array.from({ length: 90 }, (_, i) => `    total += ${i}`),
      '    print("TRACK_SOCKET")', '    return total'], { file: 'records.py', label: 'route_request' }))
    const nested = ['export function routeRequest(req) {', '  let total = 0;',
      ...Array.from({ length: 28 }, (_, i) => `  total += ${i};`),
      '  req.register(function nestedCallback() {', ...Array.from({ length: 35 }, (_, i) => `    total += ${i + 50};`),
      '    consume("TRACK_SOCKET");', ...Array.from({ length: 40 }, (_, i) => `    total += ${i + 100};`),
      '  });', '  return total;', '}']
    unchanged(fixture(nested))
    const overbound = ['export function routeRequest(req) {', ...Array.from({ length: 256 }, (_, i) => `  if (req.guard${i}) {`),
      '    consume("TRACK_SOCKET");', ...Array.from({ length: 256 }, () => '  }'), '}']
    unchanged(fixture(overbound))
    writeFileSync(f.file, f.lines.join('\n') + '\n// source identity changed after the handle was created')
    unchanged(f)
  })
})
