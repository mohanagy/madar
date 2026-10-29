import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { loadGraph } from '../../src/runtime/serve.js'
import { selectSourceDependencies, sourceSelectionProvenanceKey } from '../../src/runtime/retrieve/source-dependencies.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

function fixture(files: Record<string, string[]>) {
  const root = mkdtempSync(join(tmpdir(), 'madar-stable-local-')); roots.push(root)
  for (const [name, lines] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${lines.join('\n')}\n`)
  }
  const graph = loadGraph(generateGraph(root, { noHtml: true }).graphPath)
  graph.graph.root_path = root
  const idFor = (name: string, file: string): string => {
    const matches = graph.nodeEntries().filter(([, node]) =>
      String(node.label).replace(/\(\)$/, '').split('.').at(-1) === name
      && String(node.source_file).endsWith(file))
    expect(matches, `one generated owner for ${file}:${name}`).toHaveLength(1)
    return matches[0]![0]
  }
  return { root, graph, idFor }
}

describe('stable module-local callable bindings', () => {
  it('adds only unique direct static targets while preserving mutation, scope and route exclusions', () => {
    const annexSource = [
      'var annexTarget = function () { return "ORIGINAL"; };',
      'if (flag) { function blockTarget() { return "REBOUND"; } }',
      'function entryAnnex() { return annexTarget(); }',
    ]
    const stableSource = [
      'exports.entryVar = entryVar;',
      // Deliberately before initialization: this is a static target, not proof
      // that a hoisted exported caller executes after module initialization.
      'function entryVar() { return stableVar(); }',
      'var stableVar = function () { return "VAR_TARGET"; };',
      'exports.stableVar = stableVar;',
      'exports.stableVar = 0;',
      'function shadow(stableVar) { stableVar++; return stableVar; }',
      'const workerOptions = { eval: true };',
      'function workerBody() { workerSignal = 1; }',
    ]
    const { root, graph, idFor } = fixture({
      'stable.cjs': stableSource,
      'stable.mjs': [
        'export function entryLet() { return stableLet(); }',
        'export let stableLet = function () { return "LET_TARGET"; };',
      ],
      'mutations.cjs': [
        'var closed = function () { return "CLOSED"; };',
        'let destructured = function () { return "DESTRUCTURED"; };',
        'var iterated = function () { return "ITERATED"; };',
        'let updated = function () { return "UPDATED"; };',
        'var redeclared = function () { return "REDECLARED"; };',
        'var redeclared;',
        'function replacement() { return "REPLACEMENT"; }',
        'function mutate(values) {',
        '  closed = replacement;',
        '  ({ destructured } = values);',
        '  for (iterated of values) {}',
        '  updated++;',
        '}',
        'function entryMutations() {',
        '  return [closed(), destructured(), iterated(), updated(), redeclared()];',
        '}',
      ],
      'dynamic.cjs': [
        'var evalTarget = function () { return "EVAL_TARGET"; };',
        'function nestedEval() { (eval)("evalTarget = null"); }',
        'function entryEval() { return evalTarget(); }',
      ],
      'with.cjs': [
        'var withTarget = function () { return "WITH_TARGET"; };',
        'function nestedWith(object) { with (object) { return withTarget(); } }',
        'function entryWith() { return withTarget(); }',
      ],
      'annex.cjs': annexSource,
      'wrapper.cjs': [
        'var exports = function () { return \"ORIGINAL\"; };',
        'arguments[0] = null;',
        'function entryWrapper() { return exports(); }',
      ],
      'global.js': [
        'var globalTarget = function () { return "GLOBAL_TARGET"; };',
        'function entryGlobal() { return globalTarget(); }',
      ],
      'routes.mjs': [
        'import { foreignTarget } from "./foreign.mjs";',
        'var routeTarget = function () { return "ROUTE_TARGET"; };',
        'const alias = routeTarget;',
        'const holder = { run: routeTarget };',
        'const constTarget = function () { return "CONST_TARGET"; };',
        'var arrowTarget = () => "ARROW_TARGET";',
        'var asyncTarget = async function () { return "ASYNC_TARGET"; };',
        'var generatorTarget = function* () { yield "GENERATOR_TARGET"; };',
        'var multiTarget = function () { return "MULTI_TARGET"; }, companion = 1;',
        'function consume(fn) { return fn; }',
        'export function entryRoutes() {',
        '  holder.run();',
        '  new routeTarget();',
        '  consume(routeTarget);',
        '  alias();',
        '  foreignTarget();',
        '  routeTarget?.();',
        '  arrowTarget(); asyncTarget(); generatorTarget(); multiTarget();',
        '  constTarget();',
        '  return [routeTarget, constTarget];',
        '}',
      ],
      'foreign.mjs': [
        'export var foreignTarget = function () { return "FOREIGN_TARGET"; };',
      ],
      'ambiguous.cjs': [
        'var ambiguousTarget = function () { return "AMBIGUOUS_TARGET"; };',
        'function entryAmbiguous() { return ambiguousTarget(); }',
      ],
    })
    // The generator merges same-label owners. Rename only the block declaration
    // after indexing so the original var's exact source/range remains available
    // and the new same-name Annex B declaration must be checked in current source.
    const annexTarget = idFor('annexTarget', 'annex.cjs')
    expect(graph.nodeAttributes(annexTarget).snippet).toContain('"ORIGINAL"')
    writeFileSync(join(root, 'annex.cjs'), `${annexSource.join('\n').replace('function blockTarget()', 'function annexTarget()')}\n`)
    const callers = [
      ['entryVar', 'stable.cjs'], ['entryLet', 'stable.mjs'],
      ['entryMutations', 'mutations.cjs'], ['entryEval', 'dynamic.cjs'],
      ['entryWith', 'with.cjs'], ['entryGlobal', 'global.js'], ['entryRoutes', 'routes.mjs'],
      ['entryAnnex', 'annex.cjs'], ['entryWrapper', 'wrapper.cjs'],
    ] as const
    const ids = new Map(callers.map(([name, file]) => [name, idFor(name, file)]))
    const routes = ids.get('entryRoutes')!
    const selected = selectSourceDependencies(graph, [...ids.values()], root, new Map(), {
      includeCallers: false, functionValueCallerIds: [routes],
    })
    const provenance = selected[sourceSelectionProvenanceKey]!
    expect(provenance.scans).toMatchObject({ program: 'complete', identity: 'complete', mutation: 'complete', calls: 'complete' })
    const unique = (id: string) => expect(provenance.owners).toContainEqual(expect.objectContaining({ node_id: id, status: 'unique' }))
    for (const id of ids.values()) unique(id)

    for (const [caller, targetName, file] of [
      ['entryVar', 'stableVar', 'stable.cjs'],
      ['entryLet', 'stableLet', 'stable.mjs'],
      ['entryRoutes', 'constTarget', 'routes.mjs'],
    ] as const) {
      const from = ids.get(caller)!, target = idFor(targetName, file)
      unique(target)
      expect(selected.relationships).toContainEqual({ from_id: from, to_id: target, relation: 'calls' })
      expect(selected.source_resolved_call_pairs).toContainEqual({ from_id: from, to_id: target })
      expect(provenance.unresolved.filter(call => call.from_id === from && call.callee === targetName)).toEqual([])
    }
    // Constant-value reads remain supported; mutable function-value reads and
    // callback arguments must not gain the new direct-call authority.
    expect(selected.source_function_value_references).toEqual(expect.arrayContaining([
      expect.objectContaining({ caller: expect.objectContaining({ node_id: routes }),
        target: expect.objectContaining({ node_id: idFor('constTarget', 'routes.mjs') }) }),
    ]))
    const routeTarget = idFor('routeTarget', 'routes.mjs')
    expect(selected.source_function_value_references?.some(reference => reference.target.node_id === routeTarget)).toBe(false)
    expect(provenance.unresolved).toContainEqual(expect.objectContaining({ from_id: routes, callee: 'routeTarget', relation: 'depends_on' }))

    const withheld = [
      ['entryMutations', 'closed', 'mutations.cjs'],
      ['entryMutations', 'destructured', 'mutations.cjs'],
      ['entryMutations', 'iterated', 'mutations.cjs'],
      ['entryMutations', 'updated', 'mutations.cjs'],
      ['entryMutations', 'redeclared', 'mutations.cjs'],
      ['entryEval', 'evalTarget', 'dynamic.cjs'],
      ['entryWith', 'withTarget', 'with.cjs'],
      ['entryGlobal', 'globalTarget', 'global.js'],
      ['entryWrapper', 'exports', 'wrapper.cjs'],
      ['entryRoutes', 'routeTarget', 'routes.mjs'],
      ['entryRoutes', 'foreignTarget', 'foreign.mjs'],
      ['entryRoutes', 'arrowTarget', 'routes.mjs'],
      ['entryRoutes', 'asyncTarget', 'routes.mjs'],
      ['entryRoutes', 'generatorTarget', 'routes.mjs'],
      ['entryRoutes', 'multiTarget', 'routes.mjs'],
    ] as const
    for (const [caller, targetName, file] of withheld) {
      const from = ids.get(caller)!, target = idFor(targetName, file)
      unique(target) // A missing owner cannot make a negative resolver case pass.
      expect(selected.relationships.filter(edge => edge.from_id === from && edge.to_id === target), targetName).toEqual([])
      expect(selected.source_resolved_call_pairs, targetName).not.toContainEqual({ from_id: from, to_id: target })
    }
    for (const [caller, callees] of [
      ['entryMutations', ['closed', 'destructured', 'iterated', 'updated', 'redeclared']],
      ['entryEval', ['evalTarget']], ['entryWith', ['withTarget']], ['entryGlobal', ['globalTarget']],
      ['entryRoutes', ['holder.run', 'routeTarget', 'alias', 'foreignTarget', 'arrowTarget', 'asyncTarget', 'generatorTarget', 'multiTarget']],
    ] as const) for (const callee of callees) {
      expect(provenance.unresolved).toContainEqual(expect.objectContaining({ from_id: ids.get(caller), callee, relation: 'calls' }))
    }
    // Annex B can rebind the outer var despite a distinct block-function symbol.
    // Its original current owner is still unique, so missing index evidence is
    // not the reason this call remains unresolved.
    unique(annexTarget)
    expect(selected.source_resolved_call_pairs).not.toContainEqual({ from_id: ids.get('entryAnnex'), to_id: annexTarget })
    expect(selected.relationships.some(edge => edge.from_id === ids.get('entryAnnex') && edge.to_id === annexTarget)).toBe(false)
    for (const [caller, callee] of [['entryAnnex', 'annexTarget'], ['entryWrapper', 'exports']] as const) {
      expect(provenance.unresolved).toContainEqual(expect.objectContaining({ from_id: ids.get(caller), callee, relation: 'calls' }))
    }
    expect(provenance.forward.exclusion_proof).toBe('not_provided')

    // Duplicate a real generated owner, preserving its exact source and range.
    // Neither ID may become the target by first/last-row selection.
    const ambiguous = idFor('ambiguousTarget', 'ambiguous.cjs')
    const ambiguousCaller = idFor('entryAmbiguous', 'ambiguous.cjs')
    const duplicate = `${ambiguous}_duplicate`
    graph.addNode(duplicate, { ...graph.nodeAttributes(ambiguous) })
    const unresolved = selectSourceDependencies(graph, [ambiguousCaller], root, new Map(), { includeCallers: false })
    const ambiguity = unresolved[sourceSelectionProvenanceKey]!
    for (const id of [ambiguous, duplicate]) {
      expect(ambiguity.owners).toContainEqual(expect.objectContaining({ node_id: id, status: 'ambiguous' }))
      expect(unresolved.source_resolved_call_pairs).not.toContainEqual({ from_id: ambiguousCaller, to_id: id })
      expect(unresolved.relationships.some(edge => edge.from_id === ambiguousCaller && edge.to_id === id)).toBe(false)
    }
    expect(ambiguity.unresolved).toContainEqual(expect.objectContaining({ from_id: ambiguousCaller, callee: 'ambiguousTarget', relation: 'calls' }))

    // Reuse the already-proved stable owner. Two AST nodes per tiny expression
    // exceed the 100k census while staying well below the source byte limit;
    // the callable's original lines and body remain unchanged.
    writeFileSync(join(root, 'stable.cjs'), `${stableSource.join('\n')}\n${'0;\n'.repeat(50_001)}`)
    const bounded = selectSourceDependencies(graph, [ids.get('entryVar')!], root, new Map(), { includeCallers: false })
    expect(bounded[sourceSelectionProvenanceKey]!.scans.identity).toBe('incomplete')
    expect(bounded.receipt.bounded).toBe(true)
    expect(bounded.source_resolved_call_pairs ?? []).not.toContainEqual({ from_id: ids.get('entryVar'), to_id: idFor('stableVar', 'stable.cjs') })
    expect(bounded.relationships.filter(edge => edge.from_id === ids.get('entryVar'))).toEqual([])
  })
})
