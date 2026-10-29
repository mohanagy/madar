import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { resolveSourceSnippet } from '../../src/runtime/source-evidence-response.js'
import { readEvidenceLines, sourcePathForEvidence } from '../../src/runtime/retrieve/source-evidence.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { finalizeSourceEvidenceResponse } from '../../src/runtime/stdio/tools.js'
import { buildExplicitSourceTargetPayload } from '../../src/runtime/explicit-source-targets.js'
import { beginSourceContinuation } from '../../src/runtime/source-continuation.js'

type RecordValue = Record<string, unknown>
type Target = { file: string; symbol: string }
type Range = { start_line: number; end_line: number }
type SourceNode = RecordValue & {
  node_id: string; label: string; source_file: string; snippet_line_range: Range
  snippet_omitted_ranges?: Range[]; source_expand_handle?: string
}
type Expansion = { handle_id: string; symbols: string[] }
type Payload = RecordValue & {
  pack: { selection_scope?: string; matched_nodes: SourceNode[]; relationships?: RecordValue[]; expandable?: Expansion[] }
  evidence: { answerability: RecordValue }
  expandable?: Expansion[]
  serialized_budget: { max_tokens: number; token_count: number; enforced: boolean }
}
type Owner = Target & { lines: string[]; range: Range }
const roots: string[] = []
const mappingLines = ['export function MappingList() {}',
  'MappingList.prototype.unsortedForEach = function MappingList_forEach(callback) {',
  '  return this._array.forEach(callback);', '};']
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-explicit-targets-')))
  roots.push(root)
  return root
}

function fixture(files: Record<string, string>) {
  vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
  const root = temporaryRoot()
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), source)
  }
  const graphPath = generateGraph(root, { noHtml: true, includeDocs: false, docs: false }).graphPath
  const state: NonNullable<Parameters<typeof handleStdioRequest>[2]> = {
    logLevel: 'info', subscribedResourceUris: new Set(), resourceVersions: new Map(), resourceListSignature: null,
    contextPackHandles: new Map(),
  }
  let requestId = 0
  const response = (name: string, args: RecordValue) => handleStdioRequest(graphPath, {
    id: ++requestId, method: 'tools/call', params: { name, arguments: args },
  }, state)
  const parse = (result: Awaited<ReturnType<typeof response>>, budget: number): Payload => {
    expect(result?.error).toBeUndefined()
    const text = (result!.result as { content: Array<{ text: string }> }).content[0]!.text
    const payload = JSON.parse(text) as Payload
    expect(payload.serialized_budget).toEqual({ max_tokens: budget, token_count: estimateQueryTokens(text), enforced: true })
    expect(estimateQueryTokens(text)).toBeLessThanOrEqual(budget)
    return payload
  }
  const call = async (name: string, args: RecordValue) => parse(await response(name, args), Number(args.budget))
  return { root, state, response, parse, call }
}

function request(targets: Target[], budget = 4000): RecordValue {
  return { prompt: 'Explain these functions, including their callers and downstream error handling.', task: 'explain', targets, budget }
}

function assertPartial(payload: Payload): void {
  expect(payload.pack?.relationships ?? []).toEqual([])
  expect(payload.evidence.answerability.advisory).toBe(true)
  expect(payload.evidence.answerability.state).not.toBe('ready')
  expect(payload.evidence.answerability.answer_scope, JSON.stringify({
    handle_id: payload.handle_id, answerability: payload.evidence.answerability,
  })).toBe('partial')
}

/** Compare delivered source with the fixture, independently of stored continuation ranges. */
function recordDelivered(root: string, payload: Payload, owners: Owner[], delivered: Map<string, Set<number>>): void {
  assertPartial(payload)
  const nodes = payload.pack.matched_nodes
  for (const node of nodes) {
    const owner = owners.find(owner => resolve(root, owner.file) === resolve(root, node.source_file)
      && node.label.replace(/\(\)$/, '').split(/[.:]/).at(-1) === owner.symbol.split('.').at(-1))
    expect(owner, `Unexpected source owner ${node.source_file}:${node.label}`).toBeDefined()
    expect(node.snippet_scope).toBe('symbol')
    expect(node.snippet_line_range).toEqual(owner!.range)
    expect(node.snippet_unverified).not.toBe(true)
    const actual = resolveSourceSnippet(node, nodes)
    const expected: string[] = [], seen = delivered.get(owner!.file) ?? new Set<number>()
    const omitted = node.snippet_omitted_ranges ?? []
    for (let line = owner!.range.start_line; line <= owner!.range.end_line; line++) {
      const gap = omitted.find(range => range.start_line === line)
      if (gap) {
        expect(gap.end_line).toBeGreaterThanOrEqual(line)
        expect(gap.end_line).toBeLessThanOrEqual(owner!.range.end_line)
        expected.push(`[omitted lines ${line}-${gap.end_line}]`)
        line = gap.end_line
      } else {
        expected.push(owner!.lines[line - 1]!)
        seen.add(line)
      }
    }
    expect(actual).toBe(expected.join('\n'))
    delivered.set(owner!.file, seen)
  }
}

describe('strict context_pack explicit file and symbol targets', () => {
  it('reports a source byte bound without claiming a missing owner or widening ordinary reads', async () => {
    const owner = 'export function exactLookup(input) {\n  return input.value;\n}\n'
    const padded = (bytes: number) => '// ' + 'x'.repeat(bytes - Buffer.byteLength(owner) - 4) + '\n' + owner
    const f = fixture({ 'src/at-limit.js': padded(262144), 'src/over-limit.js': padded(262145), 'src/small.js': owner })
    const blocked = await f.response('context_pack', request([{ file: 'src/over-limit.js', symbol: 'exactLookup' }]))
    expect(blocked?.error?.message).toContain('verification unavailable: source_file_byte_limit (max_bytes=262144)')
    expect(blocked?.error?.message).toContain('native source reader or editor')
    expect(blocked?.error?.message).not.toMatch(/no verified function owner|Verified symbols in this file/)
    expect(blocked?.error?.code).not.toBe(-32602)
    expect(blocked?.result).toBeUndefined()
    expect(f.state.contextPackHandles!.size).toBe(0)
    expect(sourcePathForEvidence('src/over-limit.js', f.root)).toBeNull()
    expect(readEvidenceLines('src/over-limit.js', f.root)).toBeNull()
    for (const file of ['src/at-limit.js', 'src/small.js']) {
      const payload = await f.call('context_pack', request([{ file, symbol: 'exactLookup' }]))
      expect(payload.pack.matched_nodes).toHaveLength(1)
      expect(resolveSourceSnippet(payload.pack.matched_nodes[0]!, payload.pack.matched_nodes)).toBe(owner.trimEnd())
      assertPartial(payload)
    }
    const missing = await f.response('context_pack', request([{ file: 'src/small.js', symbol: 'absent' }]))
    expect(missing?.error?.message).toContain('no verified function owner')
    expect(missing?.error?.message).not.toContain('source_file_byte_limit')
    expect(f.state.contextPackHandles!.size).toBe(0)
  })

  it('keeps read-bound details opaque for excluded, missing and escaping source targets', async () => {
    const source = '// ' + 'x'.repeat(262145) + '\nexport function exactLookup() { return 1; }\n'
    const f = fixture(Object.fromEntries(['large.js', 'alias.js', 'outside.js', 'removed.js', 'sensitive.js'].map(file => [`src/${file}`, source])))
    const refuseWithoutBound = async (file: string, prompt?: string) => {
      const result = await f.response('context_pack', { ...request([{ file, symbol: 'exactLookup' }]), ...(prompt ? { prompt } : {}) })
      expect(result?.error).toBeDefined()
      expect(result?.error?.message).not.toMatch(/source_file_byte_limit|max_bytes=|native source reader|Verified symbols in this file/)
      expect(result?.result).toBeUndefined()
      expect(f.state.contextPackHandles!.size).toBe(0)
    }
    await refuseWithoutBound('src/large.js', 'Explain the selected function. Do not read large.js.')
    await refuseWithoutBound('src/large.js', 'Explain the selected function. Exclude ../outside.js.')
    writeFileSync(join(f.root, '.madarignore'), 'src/large.js\n')
    await refuseWithoutBound('src/large.js')
    rmSync(join(f.root, 'src/alias.js'))
    symlinkSync(join(f.root, 'src/large.js'), join(f.root, 'src/alias.js'))
    await refuseWithoutBound('src/alias.js')
    rmSync(join(f.root, '.madarignore'))
    const outside = temporaryRoot()
    writeFileSync(join(outside, 'target.js'), source)
    rmSync(join(f.root, 'src/outside.js'))
    symlinkSync(join(outside, 'target.js'), join(f.root, 'src/outside.js'))
    await refuseWithoutBound('src/outside.js')
    writeFileSync(join(f.root, '.env.js'), source)
    rmSync(join(f.root, 'src/sensitive.js'))
    symlinkSync(join(f.root, '.env.js'), join(f.root, 'src/sensitive.js'))
    await refuseWithoutBound('src/sensitive.js')
    rmSync(join(f.root, 'src/removed.js'))
    await refuseWithoutBound('src/removed.js')
  })

  it('enforces filename and canonical domain exclusions without suppressing permitted source', async () => {
    const f = fixture({
      'src/config.ts': 'export function configure() { return "EXCLUDED_CONFIG_BODY"; }',
      'src/invoice.ts': 'export function invoice() { return "config.ts"; }',
      'src/domain-alias.js': 'export function domainOnly() { return "EXCLUDED_DOMAIN_BODY"; }',
      'e2e/owner.js': 'export function domainOnly() { return "EXCLUDED_DOMAIN_BODY"; }',
    })
    const prompt = 'Explain the selected function. Do not read config.ts.'
    const allowed = await f.call('context_pack', { ...request([{ file: 'src/invoice.ts', symbol: 'invoice' }]), prompt })
    expect(allowed.pack.matched_nodes).toHaveLength(1)
    expect(resolveSourceSnippet(allowed.pack.matched_nodes[0]!, allowed.pack.matched_nodes)).toContain('return "config.ts"')
    const handles = structuredClone([...f.state.contextPackHandles!])
    const blocked = await f.response('context_pack', { ...request([{ file: 'src/config.ts', symbol: 'configure' }]), prompt })
    expect(blocked?.error?.message).toMatch(/excluded|scope|owner|target/i)
    expect(blocked?.result).toBeUndefined()
    expect([...f.state.contextPackHandles!]).toEqual(handles)
    rmSync(join(f.root, 'src/domain-alias.js'))
    symlinkSync(join(f.root, 'e2e/owner.js'), join(f.root, 'src/domain-alias.js'))
    const target = { file: 'src/domain-alias.js', symbol: 'domainOnly' }
    const unexcluded = await f.call('context_pack', request([target]))
    expect(unexcluded.pack.matched_nodes[0]!.snippet).toContain('EXCLUDED_DOMAIN_BODY')
    const domainPrompt = 'Explain the selected function. Do not read tests.'
    const before = structuredClone([...f.state.contextPackHandles!])
    const domainBlocked = await f.response('context_pack', { ...request([target]), prompt: domainPrompt })
    expect(domainBlocked?.error?.code).toBe(-32602)
    expect(domainBlocked?.result).toBeUndefined()
    expect(JSON.stringify(domainBlocked)).not.toContain('EXCLUDED_DOMAIN_BODY')
    expect([...f.state.contextPackHandles!]).toEqual(before)
    const production = await f.call('context_pack', { ...request([{ file: 'src/invoice.ts', symbol: 'invoice' }]), prompt: domainPrompt })
    expect(production.pack.matched_nodes[0]!.snippet).toContain('return "config.ts"')
  })

  it('disambiguates equal leaf names across files and returns only requested current function bodies with partial authority', async () => {
    const joinLines = ['export function join(left, right) {', '  return `${left}:${right}`;', '}']
    const renderLines = ['export function render(value: string) {', '  return value.toUpperCase();', '}']
    const assignmentLines = ['export function Thing() {}', 'Thing.prototype.run = function Thing_run(value) {',
      '  return value + 1;', '};', 'Thing.prototype.other = function Thing_other() { return "UNREQUESTED_ASSIGNMENT"; };']
    const callbackLines = ['var normalize = lruMemoize(function normalize(input) {', '  return input.trim();', '});']
    const f = fixture({
      'lib/util.js': [...joinLines, 'export function unrelated() { return "UNREQUESTED_UTIL_BODY"; }'].join('\n'),
      'lib/render.ts': [...renderLines, 'export const valueOnly = "UNREQUESTED_VALUE";'].join('\n'),
      'lib/thing.js': assignmentLines.join('\n'),
      'lib/normalize.js': [...callbackLines, 'var unrelatedValue = "UNREQUESTED_WRAPPER";'].join('\n'),
      'lib/mapping-list.js': mappingLines.join('\n'),
      'other/util.js': 'export function join(left, right) { return "WRONG_JOIN_OWNER"; }',
      'caller.js': 'import { join } from "./lib/util.js";\nexport function caller() { return join("UNREQUESTED_CALLER", "x"); }',
    })
    const targets = [{ file: 'lib/util.js', symbol: 'join' }, { file: 'lib/render.ts', symbol: 'render' }]
    const owners = targets.map((target, index) => ({ ...target, lines: [joinLines, renderLines][index]!, range: { start_line: 1, end_line: 3 } }))
    const payload = await f.call('context_pack', request(targets))
    expect(payload.pack.matched_nodes).toHaveLength(2)
    const delivered = new Map<string, Set<number>>()
    recordDelivered(f.root, payload, owners, delivered)
    for (const owner of owners) expect(delivered.get(owner.file)).toEqual(new Set([1, 2, 3]))
    expect(JSON.stringify(payload.pack)).not.toMatch(/WRONG_JOIN_OWNER|UNREQUESTED_UTIL_BODY|UNREQUESTED_VALUE|UNREQUESTED_CALLER/)

    const canonical = { file: 'lib/thing.js', symbol: 'Thing.prototype.run' }, internal = { ...canonical, symbol: 'Thing_run' }
    const assignmentOwner = { ...canonical, lines: assignmentLines, range: { start_line: 2, end_line: 4 } }
    const ownerIds = new Set<string>()
    for (const selection of [[canonical], [internal], [canonical, internal]]) {
      const aliasPayload = await f.call('context_pack', request(selection))
      expect(aliasPayload.pack.matched_nodes).toHaveLength(1)
      const node = aliasPayload.pack.matched_nodes[0]!
      expect(node.label.replace(/\(\)$/, '')).toBe(canonical.symbol)
      ownerIds.add(node.node_id)
      const recovered = new Map<string, Set<number>>()
      recordDelivered(f.root, aliasPayload, [assignmentOwner], recovered)
      expect(recovered.get(canonical.file)).toEqual(new Set([2, 3, 4]))
      expect(JSON.stringify(aliasPayload.pack)).not.toContain('UNREQUESTED_ASSIGNMENT')
    }
    expect(ownerIds.size).toBe(1)

    const callbackTarget = { file: 'lib/normalize.js', symbol: 'normalize' }
    const callback = await f.call('context_pack', request([callbackTarget]))
    expect(callback.pack.matched_nodes).toHaveLength(1)
    expect(callback.pack.matched_nodes[0]!.label).toBe('normalize()')
    const callbackDelivered = new Map<string, Set<number>>()
    recordDelivered(f.root, callback, [{ ...callbackTarget, lines: callbackLines, range: { start_line: 1, end_line: 3 } }], callbackDelivered)
    expect(callbackDelivered.get(callbackTarget.file)).toEqual(new Set([1, 2, 3]))
    expect(JSON.stringify(callback.pack)).not.toContain('UNREQUESTED_WRAPPER')

    const beforeSuggestion = structuredClone([...f.state.contextPackHandles!])
    const misspelled = await f.response('context_pack', request([{ file: 'lib/mapping-list.js', symbol: 'MappingList_unsortedForEach' }]))
    expect(misspelled?.error?.message).toMatch(/Verified symbols in this file:.*MappingList\.prototype\.unsortedForEach/)
    expect(misspelled?.result).toBeUndefined()
    expect([...f.state.contextPackHandles!]).toEqual(beforeSuggestion)
    const suggested = misspelled!.error!.message.match(/MappingList\.prototype\.unsortedForEach/)![0]
    const exactTarget = { file: 'lib/mapping-list.js', symbol: suggested }
    const exact = await f.call('context_pack', request([exactTarget]))
    expect(exact.pack.matched_nodes).toHaveLength(1)
    expect(exact.pack.matched_nodes[0]!.label.replace(/\(\)$/, '')).toBe(suggested)
    const exactDelivered = new Map<string, Set<number>>()
    recordDelivered(f.root, exact, [{ ...exactTarget, lines: mappingLines, range: { start_line: 2, end_line: 4 } }], exactDelivered)
    expect(exactDelivered.get(exactTarget.file)).toEqual(new Set([2, 3, 4]))
  })

  it('rejects invalid, escaping, ambiguous, missing, excluded and stale selections atomically without leaking session handles', async () => {
    const f = fixture({
      'lib/util.js': 'export function join(left, right) {\n  return left + right;\n}',
      'lib/render.ts': 'export function render(value: string) {\n  return value;\n}\nexport const valueOnly = 1;',
      'lib/ambiguous.ts': 'export class First {\n  join(value: string) { return value; }\n}\nexport class Second {\n  join(value: string) { return value; }\n}',
      'lib/ambiguous-alias.js': 'const First = {}, Second = {};\nFirst.run = function shared_run(value) { return value; };\nSecond.run = function shared_run(value) { return value + 1; };',
      'lib/collision.js': 'const collide = other(); consume(function collide() { return 1; });',
      'lib/mapping-list.js': mappingLines.join('\n'),
    })
    const good = { file: 'lib/render.ts', symbol: 'render' }, util = { file: 'lib/util.js', symbol: 'join' }
    await f.call('context_pack', request([good]))
    const refuse = async (args: RecordValue, message: RegExp) => {
      const before = structuredClone([...f.state.contextPackHandles!])
      const result = await f.response('context_pack', args)
      expect(result?.error?.message).toMatch(message)
      expect(result?.result).toBeUndefined()
      expect([...f.state.contextPackHandles!]).toEqual(before)
      return result
    }
    for (const targets of [null, [], [null], [{ file: 'lib/util.js' }], [{ ...util, symbol: '' }], [{ ...util, unknown: true }], Array.from({ length: 9 }, () => util)]) {
      await refuse({ ...request([good]), targets }, /target|symbol|file|unsupported|unknown/i)
    }
    const withoutPrompt = request([good]); delete withoutPrompt.prompt
    await refuse(withoutPrompt, /prompt/i)
    for (const task of [null, '', 7, 'implement']) await refuse({ ...request([good]), task }, /task|explain/i)

    const outside = temporaryRoot()
    writeFileSync(join(outside, 'outside.js'), 'export function join() { return "OUTSIDE_SECRET"; }')
    symlinkSync(join(outside, 'outside.js'), join(f.root, 'lib', 'outside.js'))
    for (const file of ['', '../outside.js', 'lib/../lib/util.js', join(outside, 'outside.js'), 'lib/outside.js']) {
      await refuse(request([good, { file, symbol: 'join' }]), /target|path|file|scope|outside|owner/i)
    }
    for (const target of [{ file: 'lib/ambiguous.ts', symbol: 'join' }, { ...util, symbol: 'missing' },
      { file: 'missing.js', symbol: 'join' }, { file: 'lib/render.ts', symbol: 'valueOnly' }]) {
      await refuse(request([good, target]), /ambiguous|unique|match|owner|function|source|target|file/i)
    }
    const ambiguousAlias = await refuse(request([good, { file: 'lib/ambiguous-alias.js', symbol: 'shared_run' }]), /ambiguous/i)
    expect(ambiguousAlias?.error?.message).toContain('lib/ambiguous-alias.js:shared_run')
    await refuse({ ...request([good, { file: 'lib/ambiguous-alias.js', symbol: 'shared_run' }]),
      prompt: 'Explain the selected functions. Exclude shared_run.' }, /excluded/i)
    const collision = await refuse(request([good, { file: 'lib/collision.js', symbol: 'collide' }]), /ambiguous|unverifiable|unique/i)
    expect(collision?.error?.message).toContain('lib/collision.js:collide')
    const missingMapping = request([good, { file: 'lib/mapping-list.js', symbol: 'MappingList_unsortedForEach' }])
    const noHint = async (args: RecordValue) => {
      const result = await refuse(args, /owner|excluded|fresh|stale|changed|source/i)
      expect(result?.error?.message).not.toContain('Verified symbols in this file:')
      expect(result?.error?.message).not.toContain('MappingList.prototype.unsortedForEach')
    }
    await noHint({ ...missingMapping, prompt: 'Explain the selected functions. Exclude prototype.' })
    await refuse({ ...request([good, util]), prompt: 'Explain render and joins. Exclude util.' }, /excluded|scope|owner|target/i)
    writeFileSync(join(f.root, '.madarignore'), 'lib/util.js\nlib/mapping-list.js\n')
    await refuse(request([good, util]), /excluded|scope|owner|target|policy|fresh|changed/i)
    await noHint(missingMapping)
    rmSync(join(f.root, '.madarignore'))

    const mappingFile = join(f.root, 'lib/mapping-list.js'), mappingBefore = statSync(mappingFile)
    writeFileSync(mappingFile, mappingLines.join('\n').replace('this._array.forEach(callback)', 'this._array.map(callback)'))
    utimesSync(mappingFile, mappingBefore.atime, new Date(mappingBefore.mtimeMs + 2000))
    await noHint(missingMapping)

    const file = join(f.root, 'lib/util.js'), before = statSync(file)
    writeFileSync(file, 'export function join(left, right) {\n  return left - right;\n}')
    utimesSync(file, before.atime, new Date(before.mtimeMs + 2000))
    await refuse(request([good, util]), /stale|fresh|changed/i)
    rmSync(file)
    await refuse(request([good, util]), /missing|unreadable|source|file|owner|fresh|stale|changed/i)
  })

  it('delivers the first bounded page of one oversized explicit owner without a navigation-only turn', async () => {
    const owner: Owner = { file: 'src/records.ts', symbol: 'processRecords',
      lines: ['export function processRecords(value: number) {',
        ...Array.from({ length: 322 }, (_, line) => `  value += ${line + 1}; // record processing operation ${line + 1}`),
        '  return value;', '}'], range: { start_line: 1, end_line: 325 } }
    const f = fixture({ [owner.file]: owner.lines.join('\n') })
    const beforeTiny = structuredClone([...f.state.contextPackHandles!])
    const tiny = await f.response('context_pack', request([{ file: owner.file, symbol: owner.symbol }], 128))
    expect(tiny?.error?.message).toMatch(/budget|tokens/i)
    expect(tiny?.result).toBeUndefined()
    expect([...f.state.contextPackHandles!]).toEqual(beforeTiny)
    const initial = await f.call('context_pack', request([{ file: owner.file, symbol: owner.symbol }], 3000))
    expect(initial.pack.selection_scope).toBe('symbol_lookup')
    expect(initial.pack.matched_nodes).toHaveLength(1)
    expect(initial.expandable ?? []).toEqual([])
    expect(initial.pack.matched_nodes[0]!.source_expand_handle).toMatch(/^source-expand:/)
    const stored = f.state.contextPackHandles!.get(initial.pack.matched_nodes[0]!.source_expand_handle!) as RecordValue
    expect(stored.task_intent).toBe('explain')
    expect(stored.evidence).toEqual({ answerability: { state: 'insufficient', answer_scope: 'partial', advisory: true,
      caveats: ['Explicit target lookup verifies only the requested source owners; it does not establish whole-task completeness.'] } })
    expect(initial.pack).not.toHaveProperty('_explicit_source_targets')
    expect(initial).not.toHaveProperty('omitted_evidence')
    const delivered = new Map<string, Set<number>>()
    recordDelivered(f.root, initial, [owner], delivered)
    expect(delivered.get(owner.file)!.size).toBeGreaterThan(0)
    expect(delivered.get(owner.file)!.size).toBeLessThan(owner.lines.length)
    let payload = initial
    for (let page = 0; page < 4 && payload.pack.matched_nodes[0]?.source_expand_handle; page++) {
      const before = delivered.get(owner.file)!.size
      payload = await f.call('context_expand', { handle_id: payload.pack.matched_nodes[0]!.source_expand_handle, budget: 1500 })
      recordDelivered(f.root, payload, [owner], delivered)
      expect(delivered.get(owner.file)!.size - before).toBe((payload.source_continuation as RecordValue).delivered_lines)
    }
    expect(delivered.get(owner.file)).toEqual(new Set(owner.lines.map((_, index) => index + 1)))
    expect(payload.pack.matched_nodes[0]!.source_expand_handle).toBeUndefined()
  })

  it('does not replace a finalizer refusal or an added evidence obligation with the original lookup context', () => {
    const lines = ['export function processRecords(value: number) {',
      ...Array.from({ length: 322 }, (_, line) => `  value += ${line + 1}; // record processing operation ${line + 1}`),
      '  return value;', '}']
    const sourceFile = 'src/records.ts', snippet = lines.join('\n'), f = fixture({ [sourceFile]: snippet })
    for (const cause of ['unverifiable', 'missing_obligation'] as const) {
      let attempts = 0
      const result = buildExplicitSourceTargetPayload({ prompt: 'Explain record processing.', task: 'explain', budget: 1500,
        rootPath: f.root, governance: { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } },
        owners: [{ nodeId: 'process_records', label: 'processRecords', sourceFile, range: { start: 1, end: lines.length }, snippet,
          validate: () => expect(readEvidenceLines(sourceFile, f.root)?.join('\n')).toBe(snippet) }],
        finalize(input, budget, options) {
          attempts++
          const payload = finalizeSourceEvidenceResponse(input, budget, options)
          if (cause === 'unverifiable') payload.omitted_evidence = 'source recovery could not be verified'
          else ((payload.evidence as RecordValue).answerability as RecordValue).missing_obligations = ['Verify external adapter behavior.']
          const receipt = payload.serialized_budget as RecordValue
          for (let pass = 0; pass < 12; pass++) {
            const count = estimateQueryTokens(JSON.stringify(payload))
            if (receipt.token_count === count) break
            receipt.token_count = count
          }
          return payload
        },
      })
      expect(attempts).toBe(2)
      expect((result.payload.pack as RecordValue).matched_nodes).toEqual([])
      expect(result.handles.size).toBe(1)
      expect([...result.handles.keys()][0]).toMatch(/^explicit-source:/)
      if (cause === 'unverifiable') expect(result.payload.omitted_evidence).toBe('source recovery could not be verified')
      else expect(((result.payload.evidence as RecordValue).answerability as RecordValue).missing_obligations)
        .toEqual(['Verify external adapter behavior.'])
    }
  })

  it('reserves the full lookup wrapper when a dense source prefix has less slack than that wrapper', () => {
    const root = temporaryRoot(), sourceFile = 'records.ts'
    const lines = ['export function processRecords(value: number) {',
      ...Array.from({ length: 322 }, (_, line) => `  value += ${line + 1}; // record processing operation ${line + 1}`),
      '  return value;', '}']
    const snippet = lines.join('\n')
    writeFileSync(join(root, sourceFile), snippet)
    const owner = { node_id: 'process_records', label: 'processRecords', source_file: sourceFile,
      range: { start_line: 1, end_line: lines.length }, snippet }
    const origin = { task: 'explain', task_intent: 'explain',
      evidence: { answerability: { state: 'insufficient', answer_scope: 'partial', advisory: true,
        caveats: ['Explicit target lookup verifies only the requested source owners; it does not establish whole-task completeness.'] } },
      governance: { graph_freshness: { status: 'fresh', selected_context_status: 'fresh' } } }
    const prefix = beginSourceContinuation(owner, origin, 1500, root)
    // Seven spare tokens keep this prefix affordable throughout the old three
    // two-token reductions, but do not cover the nine-token lookup wrapper.
    const budget = estimateQueryTokens(JSON.stringify(prefix.payload)) + 7
    const result = buildExplicitSourceTargetPayload({ prompt: 'Explain record processing.', task: 'explain', budget,
      rootPath: root, governance: origin.governance,
      owners: [{ nodeId: owner.node_id, label: owner.label, sourceFile, range: { start: 1, end: lines.length }, snippet,
        validate: () => expect(readEvidenceLines(sourceFile, root)?.join('\n')).toBe(snippet) }],
      finalize: finalizeSourceEvidenceResponse })
    const payload = result.payload as Payload
    expect(payload.pack.matched_nodes).toHaveLength(1)
    expect(payload.pack.selection_scope).toBe('symbol_lookup')
    const node = payload.pack.matched_nodes[0]!
    expect(node.source_expand_handle).toMatch(/^source-expand:/)
    expect([...result.handles.keys()]).toEqual([node.source_expand_handle])
    expect(payload.serialized_budget).toEqual({ max_tokens: budget,
      token_count: estimateQueryTokens(JSON.stringify(payload)), enforced: true })
    expect(payload.serialized_budget.token_count).toBeLessThanOrEqual(budget)
    const delivered = new Map<string, Set<number>>()
    recordDelivered(root, payload, [{ file: sourceFile, symbol: owner.label, lines, range: owner.range }], delivered)
    expect(delivered.get(sourceFile)!.size).toBeGreaterThan(0)
    expect(delivered.get(sourceFile)!.size).toBeLessThan(lines.length)
  })

  it('keeps all eight selected owners recoverable under a tight budget, follows pinned handles, and refuses an impossible budget explicitly', async () => {
    const owners: Owner[] = Array.from({ length: 8 }, (_, index) => {
      const symbol = `collectRecords${index}`, lines = [`export function ${symbol}(value: number) {`,
        ...Array.from({ length: 100 }, (_, line) => `  value += ${line + 1}; // selected owner ${index}, operation ${line + 1}`),
        '  return value;', '}']
      return { file: `lib/records-${index}.ts`, symbol, lines, range: { start_line: 1, end_line: lines.length } }
    })
    const f = fixture({ ...Object.fromEntries(owners.map((owner, index) => [owner.file,
      [...owner.lines, `export function unrequestedRecords${index}() { return "UNREQUESTED_OWNER"; }`].join('\n')])),
      'unrelated.ts': 'export function unrelated() { return 1; }',
    })
    const targets = owners.map(({ file, symbol }) => ({ file, symbol })), budget = 3200
    const initial = await f.call('context_pack', request(targets, budget))
    const delivered = new Map<string, Set<number>>()
    const queue: Array<{ handle_id: string; symbol?: string }> = [], visited = new Set<string>()
    const recoveryKey = (entry: { handle_id: string; symbol?: string }) => `${entry.handle_id}\0${entry.symbol ?? ''}`
    const accept = (payload: Payload) => {
      recordDelivered(f.root, payload, owners, delivered)
      const handles: Array<{ handle_id: string; symbol?: string }> = [
        ...payload.pack.matched_nodes.flatMap(node => node.source_expand_handle ? [{ handle_id: node.source_expand_handle }] : []),
        ...[...(payload.expandable ?? []), ...(payload.pack.expandable ?? [])].map(entry => {
          expect(entry.symbols[0]).toEqual(expect.any(String))
          return { handle_id: entry.handle_id, symbol: entry.symbols[0]! }
        }),
      ]
      for (const handle of handles) {
        expect(f.state.contextPackHandles!.has(handle.handle_id)).toBe(true)
        const key = recoveryKey(handle)
        if (!visited.has(key) && !queue.some(entry => recoveryKey(entry) === key)) queue.push(handle)
      }
    }
    accept(initial)
    expect(owners.some(owner => (delivered.get(owner.file)?.size ?? 0) < owner.lines.length)).toBe(true)
    expect(queue.length).toBeGreaterThan(0)

    // Target recovery remains pinned even if the caller omits the optional
    // selector; a different concrete function in the same file is refused.
    const generic = [...(initial.expandable ?? []), ...(initial.pack.expandable ?? [])][0]
    expect(generic).toBeDefined()
    const owner = owners.find(owner => owner.symbol === generic!.symbols[0]!.replace(/\(\)$/, ''))!
    expect(owner).toBeDefined()
    const beforeExpansion = structuredClone([...f.state.contextPackHandles!])
    const tinyExpansion = await f.response('context_expand', { handle_id: generic!.handle_id, budget: 128 })
    if (tinyExpansion?.error) expect(tinyExpansion.error.message).toMatch(/budget|tokens/i)
    else {
      const insufficient = f.parse(tinyExpansion, 128)
      assertPartial(insufficient)
      expect(insufficient.source_continuation_status).toBe('budget_insufficient')
      expect(insufficient.pack?.matched_nodes ?? []).toEqual([])
    }
    expect([...f.state.contextPackHandles!]).toEqual(beforeExpansion)
    const retry = await f.call('context_expand', { handle_id: generic!.handle_id, budget })
    recordDelivered(f.root, retry, [owner], delivered)
    accept(retry)
    const beforeWrongSymbol = structuredClone([...f.state.contextPackHandles!])
    const wrongSymbol = await f.response('context_expand', { handle_id: generic!.handle_id,
      symbol: owner.symbol.replace('collectRecords', 'unrequestedRecords'), budget })
    expect(wrongSymbol?.error?.message).toMatch(/symbol|target|owner|scope/i)
    expect(wrongSymbol?.result).toBeUndefined()
    expect([...f.state.contextPackHandles!]).toEqual(beforeWrongSymbol)

    for (let pages = 0; queue.length && pages < 32; pages++) {
      const handle = queue.shift()!; visited.add(recoveryKey(handle))
      accept(await f.call('context_expand', { ...handle, budget }))
    }
    expect(queue).toEqual([])
    expect(visited.size).toBeGreaterThan(0)
    // All owners, including the fourth, must be delivered; a capped list of
    // continuation pointers must not silently strand any requested source.
    for (const owner of owners) expect(delivered.get(owner.file)).toEqual(new Set(owner.lines.map((_, index) => index + 1)))

    const handlesBefore = structuredClone([...f.state.contextPackHandles!])
    const tiny = await f.response('context_pack', request(targets, 128))
    expect(tiny?.error?.message).toMatch(/budget|tokens/i)
    expect(tiny?.result).toBeUndefined()
    expect([...f.state.contextPackHandles!]).toEqual(handlesBefore)

    // Fresh selected files must not advertise recovery that the globally stale
    // graph would immediately refuse to follow.
    const unrelated = join(f.root, 'unrelated.ts'), before = statSync(unrelated)
    writeFileSync(unrelated, 'export function unrelated() { return 2; }')
    utimesSync(unrelated, before.atime, new Date(before.mtimeMs + 2000))
    const stale = await f.response('context_pack', request(targets, budget))
    expect(stale?.error?.message).toMatch(/fresh|stale|refresh/i)
    expect(stale?.result).toBeUndefined()
    expect([...f.state.contextPackHandles!]).toEqual(handlesBefore)
  })
})
