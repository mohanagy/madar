import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { classifyTaskContract, compileContextPack, type ContextPackNodeCandidate } from '../../src/runtime/context-pack.js'
import { sourceCoherencePriority, sourceCompositionPriority } from '../../src/runtime/retrieve/source-coherence.js'
import { selectSourceDependencies, sourceSelectionProvenanceKey } from '../../src/runtime/retrieve/source-dependencies.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(bridge = 'dispatch() { const first = this.first(); return this.finish(first, this.second()); }', second = 'second() { return "audit"; }') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-source-coherence-')))
  roots.push(root)
  const sourceFile = join(root, 'ledger.ts')
  const lines = [
    'export class Ledger {',
    '  first() { return "invoice"; }',
    `  ${second}`,
    `  ${bridge}`,
    '  finish(...values: unknown[]) { return values; }',
    '}',
    'export class Other {',
    '  second() { return "different"; }',
    '}',
    'export const unrelated = "invoice audit";',
  ]
  writeFileSync(sourceFile, lines.join('\n'))
  const node = (id: string, label: string, line: number) => ({ id, label, sourceFile, sourceLocation: `L${line}-L${line}` })
  const first = node('first', '.first()', 2), next = node('second', '.second()', 3)
  const dispatch = node('dispatch', '.dispatch()', 4), finish = node('finish', '.finish()', 5)
  const other = node('other-second', '.second()', 8), unrelated = node('unrelated', 'unrelated', 10)
  const candidates = [first, next, unrelated, dispatch, finish, other]
  return { root, lines, first, next, dispatch, finish, other, unrelated, candidates }
}

describe('bounded current source coherence', () => {
  it('protects an admitted current forward function connector before optional incoming source', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-source-connector-')))
    roots.push(root)
    const targetFile = join(root, 'target.ts'), entryFile = join(root, 'entry.ts')
    const targetSource = [
      'export function chooseTarget() { return "local"; }',
      'export function runTarget() { return chooseTarget(); }',
    ].join('\n')
    writeFileSync(targetFile, targetSource)
    writeFileSync(entryFile, [
      'import { runTarget } from "./target.js";',
      'export function serveEntry() { return runTarget(); }',
      'export function invoke(action: string) {',
      '  if (action === "preview") { serveEntry(); return; }',
      '}',
      'export function unrelated() { return 1; }',
    ].join('\n'))
    const extracted = [targetFile, entryFile].map(file => extractJs(file))
    const graph = buildFromJson({ schema_version: 1, nodes: extracted.flatMap(value => value.nodes),
      edges: extracted.flatMap(value => value.edges) }, { directed: true })
    graph.graph.root_path = root
    const entries = graph.nodeEntries()
    const id = (name: string) => entries.find(([, node]) => node.label === `${name}()` )![0]
    const leaders = [id('chooseTarget'), id('serveEntry')], bridge = id('runTarget'), incoming = id('invoke'), unrelated = id('unrelated')
    const dependencies = selectSourceDependencies(graph, [...leaders, unrelated], root, new Map(), { includeCallers: true })
    const provenance = dependencies[sourceSelectionProvenanceKey]!
    const candidates = [...leaders, incoming, unrelated, bridge].map(id => {
      const node = graph.nodeAttributes(id)
      return { id, label: String(node.label), sourceFile: String(node.source_file),
        sourceLocation: typeof node.source_location === 'string' ? node.source_location : null }
    })
    const independent = candidates.filter(candidate => leaders.includes(candidate.id))
    const allow = () => true, connector = { fromId: leaders[1]!, toId: leaders[0]! }
    const before = JSON.stringify({ provenance, candidates, edges: graph.edgeEntries() })
    expect(sourceCompositionPriority(independent, candidates, provenance, allow, allow, root)).toEqual([])
    const priority = sourceCompositionPriority(independent, candidates, provenance, allow, allow, root, connector)
    expect(priority).toEqual([...leaders, bridge])
    const nodes: ContextPackNodeCandidate[] = candidates.map(candidate => ({
      node_id: candidate.id, label: candidate.label, source_file: candidate.sourceFile, file_type: 'code', node_kind: 'function',
      evidence_class: 'primary', estimate_tokens: () => 40,
      build_entry: () => ({ node_id: candidate.id, label: candidate.label, source_file: candidate.sourceFile, line_number: 1,
        snippet: candidate.label, evidence_class: 'primary', file_type: 'code', node_kind: 'function' }),
    }))
    const relationships = dependencies.relationships.map(pair => ({ ...pair,
      from: String(graph.nodeAttributes(pair.from_id).label), to: String(graph.nodeAttributes(pair.to_id).label) }))
    const input = { task_contract: classifyTaskContract('explain', { budget: 160 }), nodes, relationships,
      selection_strategy: 'value-per-token' as const }
    expect(compileContextPack(input).nodes.map(node => node.node_id)).not.toContain(bridge)
    expect(compileContextPack({ ...input, source_priority_ids: [...priority, incoming] }).nodes.map(node => node.node_id))
      .toEqual([...leaders, bridge, incoming])
    expect(JSON.stringify({ provenance, candidates, edges: graph.edgeEntries() })).toBe(before)

    for (const mutate of [
      (proof: typeof provenance) => { proof.selected_ids = proof.selected_ids.filter(id => id !== bridge) },
      (proof: typeof provenance) => { proof.owners.find(owner => owner.node_id === bridge)!.status = 'ambiguous' },
      (proof: typeof provenance) => { proof.scans.calls = 'incomplete' },
      (proof: typeof provenance) => { proof.observed_sites!.find(site => site.from_id === leaders[1] && site.to_id === bridge)!.start_offset++ },
      (proof: typeof provenance) => { proof.observed_sites!.find(site => site.from_id === bridge && site.to_id === leaders[0])!.start_offset++ },
    ]) {
      const changed = structuredClone(provenance); mutate(changed)
      expect(sourceCompositionPriority(independent, candidates, changed, allow, allow, root, connector)).toEqual([])
    }
    expect(sourceCompositionPriority(independent, candidates.filter(candidate => candidate.id !== bridge), provenance, allow, allow, root, connector)).toEqual([])
    expect(sourceCompositionPriority(independent, candidates, provenance, allow, allow, root, { fromId: leaders[0]!, toId: leaders[1]! })).toEqual([])
    expect(sourceCompositionPriority([candidates.find(candidate => candidate.id === unrelated)!, ...independent], candidates, provenance, allow, allow, root, connector)).toEqual([])
    expect(sourceCompositionPriority(independent, candidates, provenance, file => resolve(file) !== targetFile, allow, root, connector)).toEqual([])
    writeFileSync(targetFile, targetSource.replace('"local"', '"other"'))
    expect(sourceCompositionPriority(independent, candidates, provenance, allow, allow, root, connector)).toEqual([])
  })

  it('prioritizes only an admitted current composition caller with visible unambiguous proof', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-source-composition-')))
    roots.push(root)
    writeFileSync(join(root, 'package.json'), '{"type":"module"}')
    const partsFile = join(root, 'parts.ts'), compositionFile = join(root, 'composition.ts')
    writeFileSync(partsFile, [
      'export class Ledger { constructor(readonly limit: number) {} }',
      'export class Sender { constructor(readonly ledger: Ledger) {} }',
    ].join('\n'))
    const source = [
      'import { Ledger, Sender } from "./parts.js";',
      'export class Dispatch {',
      '  constructor(limit: number) {',
      '    const ledger = new Ledger(limit);',
      '    new Sender(ledger);',
      '  }',
      '}',
    ].join('\n')
    writeFileSync(compositionFile, source)
    const extracted = [partsFile, compositionFile].map(file => extractJs(file))
    const graph = buildFromJson({ schema_version: 1, nodes: extracted.flatMap(value => value.nodes),
      edges: extracted.flatMap(value => value.edges) }, { directed: true })
    graph.graph.root_path = root
    const entries = graph.nodeEntries()
    const leaders = ['Ledger', 'Sender'].map(label => entries.find(([, node]) => node.label === label)![0])
    const caller = entries.find(([, node]) => node.label === '.constructor()' && resolve(String(node.source_file)) === compositionFile)![0]
    const cache = new Map<string, string[] | null>()
    const selected = selectSourceDependencies(graph, leaders, root, cache, { includeCallers: true })
    const provenance = selected[sourceSelectionProvenanceKey]!
    expect(selected.node_ids).toContain(caller)
    const candidates = [...new Set([...leaders, ...selected.node_ids])].map(id => {
      const node = graph.nodeAttributes(id)
      return { id, label: String(node.label), sourceFile: String(node.source_file),
        sourceLocation: typeof node.source_location === 'string' ? node.source_location : null }
    })
    const independent = candidates.filter(node => leaders.includes(node.id))
    const allow = () => true
    const before = JSON.stringify({ independent, candidates, provenance, edges: graph.edgeEntries() })
    expect(sourceCompositionPriority(independent, candidates, provenance, allow, allow, root)).toEqual([...leaders, caller])

    const ambiguous = structuredClone(provenance)
    ambiguous.owners.find(owner => owner.node_id === caller)!.status = 'ambiguous'
    const hiddenSite = structuredClone(provenance)
    const site = hiddenSite.observed_sites!.find(value => value.from_id === caller && value.to_id === leaders[0])!
    site.start_offset += 1 // The recorded span no longer identifies an actual visible call expression.
    expect([
      sourceCompositionPriority(independent, candidates, ambiguous, allow, allow, root),
      sourceCompositionPriority(independent, candidates.filter(node => node.id !== caller), provenance, allow, allow, root),
      sourceCompositionPriority(independent, candidates, hiddenSite, allow, allow, root),
      sourceCompositionPriority(independent, candidates, provenance, file => resolve(file) !== compositionFile, allow, root),
    ]).toEqual([[], [], [], []])
    expect(JSON.stringify({ independent, candidates, provenance, edges: graph.edgeEntries() })).toBe(before)

    // A populated resolver cache must not authenticate subsequently changed bytes,
    // even when the path, line ranges and file length are unchanged.
    expect(cache.get(compositionFile)?.join('\n')).toBe(source)
    writeFileSync(compositionFile, source.replace('new Ledger(limit)', 'new Ledger(99999)'))
    expect(sourceCompositionPriority(independent, candidates, provenance, allow, allow, root)).toEqual([])
  })

  it('prioritizes existing same-class source without changing evidence classes or inventing call relationships', () => {
    const f = fixture()
    const independent = Object.freeze([f.first, f.next, f.unrelated])
    const candidates = Object.freeze(f.candidates.map(node => Object.freeze(node)))
    const before = JSON.stringify({ independent, candidates })
    const priority = sourceCoherencePriority(independent, candidates, undefined, f.root)
    expect(priority).toEqual(['first', 'second', 'dispatch', 'finish'])
    expect(priority.every(id => candidates.some(candidate => candidate.id === id))).toBe(true)
    const nodes: ContextPackNodeCandidate[] = candidates.map(node => {
      const evidence_class = node.id === 'finish' ? 'supporting' : 'primary'
      return {
        label: node.label, node_id: node.id, source_file: 'ledger.ts', file_type: 'code', node_kind: 'method', evidence_class,
        estimate_tokens: () => 40,
        build_entry: () => ({ node_id: node.id, label: node.label, source_file: 'ledger.ts', line_number: 1,
          snippet: node.label, evidence_class, file_type: 'code', node_kind: 'method' }),
      }
    })
    const input = { task_contract: classifyTaskContract('explain', { budget: 160 }), nodes, relationships: [], selection_strategy: 'value-per-token' as const }
    const ordinary = compileContextPack(input)
    expect(ordinary.nodes.map(node => node.node_id)).toEqual(['first', 'second', 'unrelated', 'dispatch'])
    const pack = compileContextPack({ ...input, source_priority_ids: priority })
    expect(pack.nodes.map(node => node.node_id)).toEqual(priority)
    expect(pack.nodes.find(node => node.node_id === 'finish')?.evidence_class).toBe('supporting')
    expect(pack.relationships).toEqual([])
    expect(JSON.stringify({ independent, candidates })).toBe(before)
  })

  it.each(['different class', 'static target', 'static bridge', 'nested function', 'nested class'])(
    'does not derive same-receiver affinity from %s', scenario => {
      const bridge = scenario === 'static bridge' ? 'static dispatch() { return [this.first(), this.second()]; }'
        : scenario === 'nested function' ? 'dispatch() { function nested() { return [this.first(), this.second()]; } return nested; }'
          : scenario === 'nested class' ? 'dispatch() { return class Nested { run() { return [this.first(), this.second()]; } }; }'
            : undefined
      const f = fixture(bridge, scenario === 'static target' ? 'static second() { return "audit"; }' : undefined)
      const independent = [f.first, scenario === 'different class' ? f.other : f.next]
      expect(sourceCoherencePriority(independent, f.candidates, undefined, f.root)).toEqual([])
    },
  )

  it.each(['duplicate owner', 'stale range', 'unadmitted bridge', 'higher-ranked value'])(
    'keeps ambiguous or unsupported discovery unchanged: %s', scenario => {
      const f = fixture()
      const independent = scenario === 'higher-ranked value' ? [f.unrelated, f.first, f.next]
        : scenario === 'stale range' ? [{ ...f.first, sourceLocation: 'L99-L99' }, f.next] : [f.first, f.next]
      const candidates = scenario === 'duplicate owner' ? [...f.candidates, { ...f.dispatch, id: 'duplicate-dispatch' }]
        : scenario === 'unadmitted bridge' ? f.candidates.filter(node => node.id !== 'dispatch') : f.candidates
      expect(sourceCoherencePriority(independent, candidates, undefined, f.root)).toEqual([])
    },
  )
})
