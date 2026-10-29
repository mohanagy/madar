import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { loadGraph, estimateQueryTokens } from '../../src/runtime/serve.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { retrieveContext, sourceDiscoveryCoreKey } from '../../src/runtime/retrieve.js'
import { sourceSelectionProvenanceKey } from '../../src/runtime/retrieve/source-selection-provenance.js'
import { selectRequestedPrototypeOwners, selectVerifiedExplicitPrototypeOwners, sourceRequestedOperations } from '../../src/runtime/retrieve/source-requested-operations.js'

const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
const base = [
  'function WidgetMaker(options) { this.scale = readScale(options); }',
  'function readScale(options) { return options.scale; }',
  'WidgetMaker.prototype.mergeItems =',
  '  function WidgetMaker_mergeItems(consumer) {',
  '    if (!consumer) throw new Error("consumer required");',
  '    return consumer.adjust(this.scale);',
  '  };',
  'function Auxiliary() { return "separately requested evidence"; }',
  'function AuditPeer() { return new WidgetMaker({ scale: 9 }); }',
].join('\n')
const prompt = 'A WidgetMaker has scale 3. The consumer.adjust result is supplied. Trace instance.mergeItems(consumer) from source. Explain the returned value and the missing-consumer failure.'
function fixture(source = base) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-requested-operation-'))); roots.push(root)
  const file = join(root, 'widget.js'); writeFileSync(file, source)
  const graphPath = generateGraph(root, { noHtml: true, includeDocs: false, docs: false }).graphPath
  const graph = loadGraph(graphPath)
  const allowed = new Set([file])
  return { root, file, graphPath, graph,
    select: (question = prompt) => selectRequestedPrototypeOwners(graph, question, root, new Map(), allowed) }
}

describe('requested operation priority', () => {
  it('keeps verified explicit prototype admission separate from caller direction and manual level', () => {
    const f = fixture()
    const question = 'Explain WidgetMaker.mergeItems from source. Trace the returned value. List its callers.'
    const owner = f.graph.nodeEntries().find(([, node]) => node.label === 'WidgetMaker.prototype.mergeItems()')![0]
    const result = retrieveContext(f.graph, { question, taskKind: 'explain', budget: 3000, projectRoot: f.root })
    expect(result[sourceSelectionProvenanceKey]?.seed_origins?.requested_member_ids).toContain(owner)
    expect(result[sourceSelectionProvenanceKey]?.policy).toMatchObject({ include_callers: true, caller_priority: true })
    expect(result.matched_nodes[0]?.node_id).toBe(owner)
    const manual = retrieveContext(f.graph, { question, taskKind: 'explain', retrievalLevel: 3, budget: 3000, projectRoot: f.root })
    expect(manual[sourceSelectionProvenanceKey]?.seed_origins?.requested_member_ids).not.toContain(owner)
  })

  it('refuses current ignore policy and a conflicting request snapshot before explicit admission', () => {
    const f = fixture(), question = 'Explain WidgetMaker.mergeItems from source.'
    const ids = new Set(f.graph.nodeEntries().map(([id]) => id)), files = new Set([f.file])
    const cache = new Map<string, string[] | null>([[f.file, ['different request bytes']]])
    expect(selectVerifiedExplicitPrototypeOwners(f.graph, question, f.root, cache, ids, files)).toEqual([])
    expect(cache.get(f.file)).toEqual(['different request bytes'])
    expect(selectVerifiedExplicitPrototypeOwners(f.graph, question, f.root, new Map(), ids, files)).toHaveLength(1)
    writeFileSync(join(f.root, '.madarignore'), 'widget.js\n')
    const ignoredCache = new Map<string, string[] | null>()
    expect(selectVerifiedExplicitPrototypeOwners(f.graph, question, f.root, ignoredCache, ids, files)).toEqual([])
    expect(ignoredCache.size).toBe(0)
  })

  it('refuses an excluded canonical domain behind an eligible source alias', () => {
    const f = fixture(), question = 'Explain WidgetMaker.mergeItems from source. No tests.'
    mkdirSync(join(f.root, 'e2e'))
    const canonical = join(f.root, 'e2e', 'widget.js')
    writeFileSync(canonical, base)
    unlinkSync(f.file); symlinkSync(canonical, f.file)
    const cache = new Map<string, string[] | null>()
    expect(selectVerifiedExplicitPrototypeOwners(f.graph, question, f.root, cache,
      new Set(f.graph.nodeEntries().map(([id]) => id)), new Set([f.file]))).toEqual([])
    expect(cache.size).toBe(0)
  })

  it('bounds explicit owners by requested operations while keeping unknown and mixed receiver pools conservative', () => {
    const f = fixture()
    const noise = 'Amber, Birch, Cedar, Delta, Elm, Flint, Grove, Hazel, Iris, Jade, Knox, Larch, Maple, North, Oak, Pine, Quartz are background labels. '
    const explicit = 'A WidgetMaker exists. Explain WidgetMaker.mergeItems(input) from source. Explain the returned value.'
    expect(f.select(noise + explicit)).toEqual(f.select(explicit))
    expect(f.select(explicit)).toHaveLength(1)
    const result = retrieveContext(f.graph, { question: noise + explicit, taskKind: 'explain', budget: 3000, projectRoot: f.root })
    expect(result.matched_nodes[0]?.label).toBe('WidgetMaker.prototype.mergeItems()')
    expect(result[sourceSelectionProvenanceKey]?.policy.include_callers).toBe(false)
    const unknown = 'A WidgetMaker exists. Explain instance.mergeItems(input) from source.'
    expect(f.select(unknown)).toHaveLength(1)
    expect(f.select(noise + unknown)).toEqual([])
    expect(f.select(noise + explicit + ' Also explain instance.mergeItems(input).')).toEqual([])
    expect(f.select(noise + explicit + ' Also explain application.instance.mergeItems(input).')).toEqual([])
  })

  it('keeps example caller words inert even when a real exclusion compresses the evidence prompt', () => {
    const f = fixture()
    const question = 'Do not execute or import the library. A WidgetMaker exists. Trace WidgetMaker.mergeItems(input) from source.\n```js\n// caller: Explain OtherBox.adjust(input)\n```\nThe error is "consumer required". Exclude `auth.ts`.'
    expect(sourceRequestedOperations(question).map(item => item.name)).toEqual(['WidgetMaker.mergeItems'])
    expect(f.select(question)).toHaveLength(1)
    const result = retrieveContext(f.graph, { question, taskKind: 'explain', budget: 3000, projectRoot: f.root })
    expect(result[sourceSelectionProvenanceKey]?.policy.include_callers).toBe(false)
    expect(result.matched_nodes[0]?.label).toBe('WidgetMaker.prototype.mergeItems()')
    const caller = retrieveContext(f.graph, { question: `${question}\nList callers of WidgetMaker.`, taskKind: 'explain', budget: 3000, projectRoot: f.root })
    expect(caller[sourceSelectionProvenanceKey]?.policy.include_callers).toBe(true)
    expect(sourceRequestedOperations('```js\nExplain WidgetMaker.mergeItems(input)\n```')).toEqual([])
  })

  it('delivers the requested current implementation before background constructors under the final wire budget', async () => {
    vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
    const f = fixture(), before = JSON.stringify([f.graph.nodeEntries(), f.graph.edgeEntries()])
    const result = await handleStdioRequest(f.graphPath, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'context_pack', arguments: { prompt, task: 'explain', budget: 1800 },
    } })
    expect(result?.error).toBeUndefined()
    const text = (result!.result as { content: Array<{ text: string }> }).content[0]!.text
    const payload = JSON.parse(text)
    expect(payload.serialized_budget.token_count).toBe(estimateQueryTokens(text))
    expect(payload.serialized_budget.token_count).toBeLessThanOrEqual(1800)
    const first = payload.pack.matched_nodes[0]
    expect(first.label).toBe('WidgetMaker.prototype.mergeItems()')
    expect(first.snippet_line_range).toEqual({ start_line: 3, end_line: 7 })
    expect(first.snippet).toBe(base.split('\n').slice(2, 7).join('\n'))
    expect(payload.evidence.answerability.advisory).toBe(true)
    expect(payload.evidence.answerability.state).not.toBe('ready')
    expect(JSON.stringify([f.graph.nodeEntries(), f.graph.edgeEntries()])).toBe(before)
    const retrieval = retrieveContext(f.graph, { question: prompt, taskKind: 'explain', budget: 3000, projectRoot: f.root })
    expect(retrieval[sourceSelectionProvenanceKey]?.policy.include_callers).toBe(false)
    expect(retrieval[sourceDiscoveryCoreKey]?.node_ids.map(id => f.graph.nodeAttributes(id).label))
      .toEqual(expect.arrayContaining(['WidgetMaker.prototype.mergeItems()', 'WidgetMaker()', 'readScale()']))
    // A user-given receiver is never added as a graph/runtime binding.
    expect(retrieval.relationships.some(edge => edge.from === 'instance.mergeItems' || edge.to === 'instance.mergeItems')).toBe(false)
  })

  it('keeps exact qualified operations and other requested members while preserving explicit caller requests', () => {
    const f = fixture()
    const question = 'A WidgetMaker has scale 3. Trace WidgetMaker.prototype.mergeItems(consumer) from source. Also explain Auxiliary() and its returned value.'
    const result = retrieveContext(f.graph, { question, taskKind: 'explain', budget: 3000, projectRoot: f.root })
    expect(result.matched_nodes[0]?.label).toBe('WidgetMaker.prototype.mergeItems()')
    expect(result.matched_nodes.some(node => node.label === 'Auxiliary()')).toBe(true)
    expect(result[sourceDiscoveryCoreKey]?.node_ids.map(id => f.graph.nodeAttributes(id).label)).toContain('Auxiliary()')
    for (const question of ['Explain the exact behavior of WidgetMaker.mergeItems in this checkout.',
      'Inspect the implementation of WidgetMaker.mergeItems.', 'Analyze WidgetMaker.mergeItems.',
      'Trace WidgetMaker.prototype.mergeItems.']) {
      const operation = retrieveContext(f.graph, { question: `${question} Explain the return value and failure flow.`, taskKind: 'explain', budget: 3000, projectRoot: f.root })
      expect(operation.matched_nodes[0]?.label, question).toBe('WidgetMaker.prototype.mergeItems()')
      expect(operation[sourceSelectionProvenanceKey]?.policy.include_callers, question).toBe(false)
    }
    for (const question of ['Find consumers of WidgetMaker. ' + prompt,
      'A WidgetMaker exists. Trace instance.mergeItems(consumer) and its consumers.',
      'A WidgetMaker exists. Trace instance.mergeItems(consumer); list downstream consumers.',
      'Explain the behavior of WidgetMaker.mergeItems and its consumers. Trace the failure flow.',
      'Analyze WidgetMaker.mergeItems. Analyze its consumer.',
      'Trace WidgetMaker.mergeItems. Follow its consumer.']) {
      const caller = retrieveContext(f.graph, { question, taskKind: 'explain', budget: 3000, projectRoot: f.root })
      expect(caller[sourceSelectionProvenanceKey]?.policy.include_callers).toBe(true)
    }
    expect(sourceRequestedOperations('The example says "Trace instance.mergeItems(input)".')).toEqual([])
    for (const question of ['The example says "Explain the behavior of WidgetMaker.mergeItems".',
      'Inspect `WidgetMaker.mergeItems`.', 'Exclude WidgetMaker.mergeItems.',
      'Analyze the calls to WidgetMaker.mergeItems below.']) expect(sourceRequestedOperations(question)).toEqual([])
  })

  it('abstains for unknown, competing, excluded or unverified prototype owners without changing graph authority', () => {
    const f = fixture(), before = JSON.stringify([f.graph.nodeEntries(), f.graph.edgeEntries()])
    expect(f.select()).toHaveLength(1)
    for (const question of [
      'Trace instance.mergeItems(consumer) from source. Explain the result.',
      'A WidgetMaker exists. The example says "Trace instance.mergeItems(consumer)".',
      'A WidgetMaker exists. Exclude instance.mergeItems(consumer).',
      'A WidgetMaker exists. Trace application.instance.mergeItems(consumer).',
    ]) expect(f.select(question)).toEqual([])
    expect(selectRequestedPrototypeOwners(f.graph, prompt, f.root, new Map(), new Set())).toEqual([])
    for (const extra of [
      'WidgetMaker.prototype.mergeItems = function duplicate() {};',
      'instance.mergeItems = function exactReceiver() {};',
      'WidgetMaker.prototype[key] = function dynamic() {};',
      'WidgetMaker.prototype = {};',
      'function WidgetMaker() {}',
    ]) {
      writeFileSync(f.file, base + '\n' + extra)
      expect(f.select()).toEqual([])
    }
    for (const extra of ['class OtherMaker { mergeItems() { return 1; } }',
      'class OtherMaker { ["mergeItems"]() { return 1; } }',
      'class OtherMaker { [key]() { return 1; } }',
      'class OtherMaker { mergeItems = () => 1; }',
      'function OtherMaker() {} OtherMaker.mergeItems = () => 1;']) {
      const competing = fixture(base + '\n' + extra)
      expect(competing.select('An OtherMaker exists. ' + prompt)).toEqual([])
    }
    writeFileSync(f.file, base)
    const shorthand = 'Explain the exact behavior of WidgetMaker.mergeItems in this checkout.'
    expect(f.select(shorthand)).toHaveLength(1)
    for (const extra of ['WidgetMaker.mergeItems = function staticMember() {};',
      'WidgetMaker["mergeItems"] = function computedStaticMember() {};',
      'WidgetMaker[key] = function dynamicStaticMember() {};',
      'class WidgetMaker { mergeItems() {} }',
      'class WidgetMaker { [key]() {} }',
      'Object.defineProperty(WidgetMaker, "mergeItems", { value: function staticMember() {} });',
      'Object.defineProperty(WidgetMaker.prototype, "mergeItems", { value: function replacement() {} });',
      'Object.defineProperty(WidgetMaker, "prototype", { value: { mergeItems() {} } });',
      'Reflect.defineProperty(WidgetMaker, key, { value: function staticMember() {} });',
      'Object.defineProperties(WidgetMaker, { mergeItems: { value: function staticMember() {} } });',
      'Object.defineProperties(WidgetMaker.prototype, { [key]: { value: function member() {} } });',
      'Object.assign(WidgetMaker, { mergeItems() {} });',
      'Object.assign(WidgetMaker.prototype, { mergeItems() {} });',
      'Object.assign(WidgetMaker.prototype, members);']) {
      writeFileSync(f.file, base + '\n' + extra)
      expect(f.select(shorthand), extra).toEqual([])
    }
    writeFileSync(f.file, base + '\nObject.defineProperty(WidgetMaker.prototype, "unrelated", { get() { return 0; } });')
    expect(f.select(shorthand)).toHaveLength(1)
    writeFileSync(f.file, base)
    const duplicate = fixture(), duplicateMethod = duplicate.graph.nodeEntries().find(([, node]) => node.label === 'WidgetMaker.prototype.mergeItems()')!
    duplicate.graph.addNode('duplicate-owner', duplicateMethod[1])
    expect(duplicate.select()).toEqual([])
    const stale = fixture(), method = stale.graph.nodeEntries().find(([, node]) => node.label === 'WidgetMaker.prototype.mergeItems()')!
    stale.graph.addNode(method[0], { ...method[1], source_location: 'L1' })
    expect(stale.select()).toEqual([])
    expect(JSON.stringify([f.graph.nodeEntries(), f.graph.edgeEntries()])).toBe(before)
    expect(readFileSync(f.file, 'utf8')).toBe(base)
  })
})
