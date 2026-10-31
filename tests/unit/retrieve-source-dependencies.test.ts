import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'
import { loadGraph } from '../../src/runtime/serve.js'
import { reconcileSourceCalls, selectSourceDependencies, sourceLocalPriorityKey, sourceSelectionProvenanceKey } from '../../src/runtime/retrieve/source-dependencies.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

function fixture(files: Record<string, string>, generated = false) {
  const root = mkdtempSync(join(tmpdir(), 'madar-source-deps-')); roots.push(root)
  const fragments = Object.entries(files).map(([name, source]) => {
    const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source)
    return extractJs(path)
  })
  const graph = generated ? loadGraph(generateGraph(root, { noHtml: true }).graphPath)
    : buildFromJson({ schema_version: 1, nodes: fragments.flatMap(fragment => fragment.nodes), edges: fragments.flatMap(fragment => fragment.edges) }, { directed: true })
  graph.graph.root_path = root
  const idFor = (name: string, file: string) => graph.nodeEntries().find(([, node]) => String(node.label).replace(/\(\)$/, '').split('.').at(-1) === name && String(node.source_file).endsWith(file))?.[0] ?? ''
  return { root, graph, idFor }
}

describe('source grounded dependency selection', () => {
  it('attributes static-assignment bodies to canonical source owners without binding receivers', () => {
    const { graph, root, idFor } = fixture({ 'assigned.mjs': [
      'const api = {};',
      'function helper() { return 1; }',
      'function internalName() { return 2; }',
      'api.run = function internalName() {',
      '  helper();',
      '  internalName();',
      '  return this.helper();',
      '};',
      'export function entry() { internalName(); return api.run(); }',
    ].join('\n') }, true)
    const run = idFor('run', 'assigned.mjs'), helper = idFor('helper', 'assigned.mjs')
    const entry = idFor('entry', 'assigned.mjs'), ordinary = idFor('internalName', 'assigned.mjs')
    const result = selectSourceDependencies(graph, [run, entry], root, new Map(), { includeCallers: false })
    expect(result.relationships).toEqual(expect.arrayContaining([
      { from_id: run, to_id: helper, relation: 'calls' },
      { from_id: entry, to_id: ordinary, relation: 'calls' },
    ]))
    expect(result.source_resolved_call_pairs).not.toContainEqual({ from_id: run, to_id: ordinary })
    expect(result.source_resolved_call_pairs).not.toContainEqual({ from_id: entry, to_id: run })
    expect(result.source_resolved_call_pairs).toContainEqual({ from_id: run, to_id: run })
    expect(result.relationships).not.toContainEqual({ from_id: run, to_id: idFor('api', 'assigned.mjs'), relation: 'depends_on' })
    expect(reconcileSourceCalls([{ from_id: run, to_id: ordinary, relation: 'calls' }], result)).not.toContainEqual({ from_id: run, to_id: ordinary, relation: 'calls' })
    expect(result[sourceSelectionProvenanceKey]!.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ from_id: run, callee: 'this.helper' }),
      expect.objectContaining({ from_id: entry, callee: 'api.run' }),
    ]))
    expect(result.source_callsite_bundles!.find(bundle => bundle.from_id === run && bundle.to_id === helper)?.ranges[0]?.start_line).toBe(4)
    graph.addNode('duplicate-run', { ...graph.nodeAttributes(run) })
    const ambiguous = selectSourceDependencies(graph, [run], root, new Map(), { includeCallers: false })
    expect(ambiguous.source_resolved_call_pairs?.some(pair => [run, 'duplicate-run'].includes(pair.from_id))).toBe(false)
  })

  it('keeps nested named and assignment callable boundaries separate', () => {
    const { graph, root, idFor } = fixture({ 'nested.mjs': [
      'const api = {};',
      'function helper() { return 1; }',
      'function innerHelper() { return 2; }',
      'api.run = (function privateRun() {',
      '  function nested() { return innerHelper(); }',
      '  api.inner = () => helper();',
      '  return nested();',
      '});',
    ].join('\n') }, true)
    const run = idFor('run', 'nested.mjs'), inner = idFor('inner', 'nested.mjs'), nested = idFor('nested', 'nested.mjs')
    const helper = idFor('helper', 'nested.mjs'), innerHelper = idFor('innerHelper', 'nested.mjs')
    const result = selectSourceDependencies(graph, [run, inner], root, new Map(), { includeCallers: false })
    expect(result.source_resolved_call_pairs).toEqual(expect.arrayContaining([
      { from_id: run, to_id: nested }, { from_id: nested, to_id: innerHelper }, { from_id: inner, to_id: helper },
    ]))
    expect(result.source_resolved_call_pairs).not.toContainEqual({ from_id: run, to_id: helper })
    expect(result.source_resolved_call_pairs).not.toContainEqual({ from_id: run, to_id: innerHelper })
  })

  it('withholds same-line assignment ownership instead of leaking calls to the enclosing function', () => {
    const { graph, root, idFor } = fixture({ 'ambiguous.mjs': [
      'const api = {};',
      'function helper() { return 1; }',
      'export function entry() {',
      '  api.left = () => helper(); api.right = () => helper();',
      '}',
    ].join('\n') }, true)
    const entry = idFor('entry', 'ambiguous.mjs'), left = idFor('left', 'ambiguous.mjs'), right = idFor('right', 'ambiguous.mjs')
    const result = selectSourceDependencies(graph, [entry, left, right], root, new Map(), { includeCallers: false })
    expect(result.source_resolved_call_pairs).toEqual([])
    expect(result.receipt.unattributed_calls).toBe(2)
    expect(result[sourceSelectionProvenanceKey]!.owners.filter(owner => [left, right].includes(owner.node_id)).every(owner => owner.status === 'unmatched')).toBe(true)
  })

  it('retains private seed, multi-role cycle, callback and data provenance without promoting unknown roles', () => {
    const text = [
      'export const settings = { enabled: true };',
      'export function entry(port) {',
      '  peer(); consume(callback);',
      '  return settings.enabled && port.dispatch();',
      '}',
      'export function peer() { return entry(null); }',
      'export function consume(fn) { return fn(); }',
      'export function callback() { return settings.enabled; }',
      'export function callerOnly() { return entry(null); }',
      'export function disconnected() { return distant(); }',
      'export function distant() { return 1; }',
    ].join('\n')
    const { graph, root, idFor } = fixture({ 'flow.mjs': text }, true)
    const id = (name: string) => idFor(name, 'flow.mjs')
    const entry = id('entry'), peer = id('peer'), callback = id('callback'), settings = id('settings')
    expect([entry, peer, callback, settings].every(Boolean)).toBe(true)
    const origins = { requested_member_ids: [entry], explicit_symbol_candidate_ids: [entry], helper_request_ids: [],
      named_file_member_ids: [], anchor_ids: [entry], heuristic_anchor_ids: [] }
    const plain = selectSourceDependencies(graph, [entry], root, new Map())
    const result = selectSourceDependencies(graph, [entry], root, new Map(), { seedOrigins: origins })
    const provenance = result[sourceSelectionProvenanceKey]!
    expect(JSON.stringify(result)).toBe(JSON.stringify(plain))
    expect({ ...result }[sourceSelectionProvenanceKey]).toBe(provenance)
    expect(JSON.parse(JSON.stringify(result))[String(sourceSelectionProvenanceKey)]).toBeUndefined()
    expect(provenance.seed_ids).toEqual([entry])
    expect(provenance.seed_origins).toEqual(origins)
    expect(plain[sourceSelectionProvenanceKey]!.seed_origins).toBeUndefined()
    expect(provenance.admissions.filter(event => event.node_id === peer)).toEqual([{ node_id: peer, role: 'incoming', depth: 0 }])
    expect(provenance.observed_roles.find(owner => owner.node_id === peer)!.roles).toEqual(expect.arrayContaining(['incoming', 'outgoing']))
    expect(provenance.resolved_pairs).toEqual(expect.arrayContaining([
      { from_id: entry, to_id: callback, relation: 'depends_on', kind: 'function_value_argument' },
      { from_id: entry, to_id: settings, relation: 'depends_on', kind: 'data_reference' },
      { from_id: id('disconnected'), to_id: id('distant'), relation: 'calls', kind: 'call' },
    ]))
    expect(provenance.forward.known_reachable_ids).toEqual(expect.arrayContaining([entry, peer, callback, settings, id('consume')]))
    expect(provenance.forward.known_reachable_ids).not.toContain(id('callerOnly'))
    expect(provenance.forward.known_reachable_ids).not.toContain(id('disconnected'))
    expect(provenance.forward.unresolved_from_reachable_ids).toContain(entry)
    expect(provenance.forward.exclusion_proof).toBe('not_provided')
    expect(provenance.unresolved).toContainEqual(expect.objectContaining({ from_id: entry, callee: 'port.dispatch', relation: 'calls' }))
    expect(provenance.scans).toMatchObject({ identity: 'complete', calls: 'complete', data_references: 'complete', mutation: 'complete' })
    expect(provenance.sources).toContainEqual({ source_file: join(root, 'flow.mjs'), canonical_file: realpathSync(join(root, 'flow.mjs')), source_sha256: createHash('sha256').update(text).digest('hex'), in_program: true })
    const retrieved = retrieveContext(graph, { question: 'Explain entry() and the helper implementations it calls.', taskKind: 'implement', budget: 4000 })
    expect(retrieved[sourceSelectionProvenanceKey]!.seed_ids).toContain(entry)
    expect(retrieved[sourceSelectionProvenanceKey]!.seed_origins!.explicit_symbol_candidate_ids).toContain(entry)
    expect({ ...retrieved }[sourceSelectionProvenanceKey]).toBe(retrieved[sourceSelectionProvenanceKey])
    const empty = selectSourceDependencies(graph, ['missing'], root, new Map())[sourceSelectionProvenanceKey]!
    expect(empty.seed_ids).toEqual(['missing'])
    expect(Object.values(empty.scans).every(value => value === 'not_started')).toBe(true)
    expect(empty.limitations).toContain('no_supported_seed_files')
    // Existing indexed identities are not authority after the current parse fails.
    writeFileSync(join(root, 'flow.mjs'), 'export function entry( {')
    const broken = selectSourceDependencies(graph, [entry], root, new Map())[sourceSelectionProvenanceKey]!
    expect(broken.scans.program).toBe('incomplete')
    expect(broken.scans.calls).toBe('not_started')
    expect(broken.limitations).toContain('program_parse_diagnostics')
    expect(broken.forward.exclusion_proof).toBe('not_provided')
  })

  it('maps same-line call targets to their declarations instead of the containing entry', () => {
    const { graph, root, idFor } = fixture({
      'source.mjs': 'export class First { run(){return "FIRST"} } export class Second { run(){return "SECOND"} } export function entry(){return new Second().run()}\n',
    }, true)
    const entry = idFor('entry', 'source.mjs')
    const method = graph.nodeEntries().find(([, node]) => node.label === '.run()' && String(node.snippet).includes('SECOND'))?.[0]
    expect(method).toBeDefined()
    const source = selectSourceDependencies(graph, [entry], root, new Map(), { includeCallers: false })
    expect(source.relationships).toContainEqual({ from_id: entry, to_id: method, relation: 'calls' })
    expect(source.relationships).toContainEqual({ from_id: entry, to_id: idFor('Second', 'source.mjs'), relation: 'calls' })
    expect(source.source_resolved_call_pairs).not.toContainEqual({ from_id: entry, to_id: entry })
    expect(source.receipt).toMatchObject({ resolved_calls: 2, unresolved_calls: 0, bounded: false })
  })

  it('withholds ambiguous current-owner graph calls without inventing a source binding', () => {
    const { graph, root, idFor } = fixture({
      'source.mjs': 'export class First { run(){return "SAME"} } export class Second { run(){return "SAME"} } export function entry(){return new Second().run()}\n',
    }, true)
    const entry = idFor('entry', 'source.mjs')
    const ambiguous = graph.nodeEntries().find(([, node]) => node.label === '.run()')![0]
    const falseEdge = { from_id: ambiguous, to_id: entry, relation: 'calls' }
    const source = selectSourceDependencies(graph, [entry], root, new Map(), { includeCallers: false })
    expect(source.receipt).toMatchObject({ bounded: true, unresolved_calls: 1 })
    expect(source.source_resolved_call_pairs).not.toContainEqual({ from_id: ambiguous, to_id: entry })
    expect(reconcileSourceCalls([falseEdge], source)).toEqual([])
    expect(source.receipt.withheld_graph_calls).toBe(1)
  })

  it('keeps ordinary local initializers in the enclosing callable scope', () => {
    const { graph, root, idFor } = fixture({
      'source.mjs': 'function helper(){return {value:1}}\nexport function entry(){const value=helper();const {value:other}=helper();return value.value+other}\n',
    }, true)
    const entry = idFor('entry', 'source.mjs'), helper = idFor('helper', 'source.mjs')
    const source = selectSourceDependencies(graph, [entry], root, new Map(), { includeCallers: false })
    expect(source.relationships.filter(edge => edge.from_id === entry && edge.to_id === helper && edge.relation === 'calls')).toHaveLength(2)
    expect(source.receipt.unattributed_calls).toBeUndefined()
  })

  it('refuses an overwritten class-expression prototype through a constructor alias', () => {
    const { graph, root, idFor } = fixture({ 'entry.mjs': [
      'const Worker = class WorkerImplementation {',
      '  run() { return "OLD_PROTOTYPE_METHOD"; }',
      '};',
      'const Constructor = Worker;',
      'function replacement() { return "NEW_PROTOTYPE_METHOD"; }',
      'Constructor.prototype.run = replacement;',
      'const worker = new Worker();',
      'export function entry() { return worker.run(); }',
    ].join('\n') }, true)
    // A source graph may index the concrete method even when the default
    // extractor does not yet emit class-expression members.
    graph.addNode('class-expression-run', { type: 'function', file_type: 'code', label: 'WorkerImplementation.run()',
      source_file: join(root, 'entry.mjs'), source_location: 'L2',
      snippet: 'run() { return "OLD_PROTOTYPE_METHOD"; }' })
    const entry = idFor('entry', 'entry.mjs')
    const source = selectSourceDependencies(graph, [entry], root, new Map(), { includeCallers: false })
    expect(source.relationships.filter(edge => edge.from_id === entry && edge.relation === 'calls')).toEqual([])
    expect(source.receipt.unresolved).toContainEqual(expect.objectContaining({ callee: 'worker.run', reason: 'unresolved' }))
  })

  it.each<{ name: string; files: Record<string, string> }>([
    {"name": "namespace-prototype-export-overwritten", "files": {"src/service.mjs": "export class Worker {\n  run() { return \"OLD_EXPORTED_INSTANCE_METHOD\"; }\n}\nexport const prototype = new Worker();\n", "src/entry.mjs": "import * as service from \"./service.mjs\";\nfunction replacement() { return \"NEW_EXPORTED_INSTANCE_METHOD\"; }\nservice.prototype.run = replacement;\nexport function entry() {\n  return service.prototype.run();\n}\n"}},
    {"name": "prototype-member-overwritten", "files": {"src/entry.mjs": "export class Worker {\n  run() { return \"OLD_PROTOTYPE_METHOD\"; }\n}\nfunction replacement() { return \"NEW_PROTOTYPE_METHOD\"; }\nWorker.prototype.run = replacement;\nconst worker = new Worker();\nexport function entry() {\n  return worker.run();\n}\n"}},
    {"name": "function-reassigned", "files": {"src/entry.mjs": "export function step() {\n  return \"OLD_FUNCTION\";\n}\nfunction replacement() {\n  return \"NEW_FUNCTION\";\n}\nstep = replacement;\nexport function entry() {\n  return step();\n}\n"}},
    {"name": "export-live-binding", "files": {"src/service.mjs": "export function step() {\n  return \"OLD_EXPORTED\";\n}\nfunction replacement() {\n  return \"NEW_EXPORTED\";\n}\nstep = replacement;\n", "src/entry.mjs": "import { step } from \"./service.mjs\";\nexport function entry() {\n  return step();\n}\n"}},
    {"name": "class-reassigned", "files": {"src/entry.mjs": "export class Worker {\n  run() { return \"OLD_CLASS\"; }\n}\nclass Replacement {\n  run() { return \"NEW_CLASS\"; }\n}\nWorker = Replacement;\nexport function entry() {\n  return new Worker().run();\n}\n"}},
    {"name": "instance-method-overwritten", "files": {"src/entry.mjs": "class Worker {\n  run() { return \"OLD_METHOD\"; }\n}\nconst worker = new Worker();\nfunction replacement() {\n  return \"NEW_METHOD\";\n}\nworker.run = replacement;\nexport function entry() {\n  return worker.run();\n}\n"}},
    {"name": "const-alias-overwritten", "files": {"src/entry.mjs": "class Worker {\n  run() { return \"OLD_ALIAS_METHOD\"; }\n}\nconst worker = new Worker();\nfunction replacement() {\n  return \"NEW_ALIAS_METHOD\";\n}\nconst alias = worker;\nalias.run = replacement;\nexport function entry() {\n  return worker.run();\n}\n"}},
    {"name": "assigned-alias-overwritten", "files": {"src/entry.mjs": "class Worker {\n  run() { return \"OLD_ALIAS_METHOD\"; }\n}\nconst worker = new Worker();\nfunction replacement() {\n  return \"NEW_ALIAS_METHOD\";\n}\nlet alias;\nalias = worker;\nalias.run = replacement;\nexport function entry() {\n  return worker.run();\n}\n"}},
    {"name": "conditional-alias-overwritten", "files": {"src/entry.mjs": "class Worker {\n  run() { return \"OLD_CONDITIONAL\"; }\n}\nclass Other {\n  run() { return \"OTHER_BRANCH\"; }\n}\nconst worker = new Worker();\nconst other = new Other();\nconst flag = true;\nconst alias = flag ? worker : other;\nfunction replacement() { return \"NEW_CONDITIONAL\"; }\nalias.run = replacement;\nexport function entry() {\n  return worker.run();\n}\n"}},
    {"name": "logical-assignment-overwritten", "files": {"src/entry.mjs": "class Worker {\n  run() { return \"OLD_LOGICAL_ASSIGNMENT\"; }\n}\nconst worker = new Worker();\nlet alias;\nalias ||= worker;\nfunction replacement() { return \"NEW_LOGICAL_ASSIGNMENT\"; }\nalias.run = replacement;\nexport function entry() {\n  return worker.run();\n}\n"}}
  ])('leaves visibly reassigned callable values unresolved: $name', ({ files }) => {
    const { graph, root, idFor } = fixture(files, true)
    const entry = idFor('entry', 'src/entry.mjs')
    expect(entry).not.toBe('')
    const source = selectSourceDependencies(graph, [entry], root, new Map(), { includeCallers: false })
    expect(source.relationships.filter(edge => edge.from_id === entry && edge.relation === 'calls')).toEqual([])
    expect(source.receipt.unresolved_calls).toBeGreaterThan(0)
    expect(source.receipt.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_file: expect.stringContaining('entry.mjs'), reason: 'unresolved' }),
    ]))
  })

  it.each<{ name: string; files: Record<string, string>; targetName: string; targetFile: string; expectUnbounded: boolean }>([
    {"name": "const-function-control", "files": {"src/entry.mjs": "const step = () => {\n  return \"UNCHANGED_CONST\";\n};\nexport function entry() {\n  return step();\n}\n"}, "targetName": "step", "targetFile": "src/entry.mjs", "expectUnbounded": true},
    {"name": "shadowed-write-control", "files": {"src/entry.mjs": "function step() {\n  return \"UNCHANGED_OUTER\";\n}\nfunction replacement() {\n  return \"INNER_REPLACEMENT\";\n}\nfunction otherScope() {\n  let step = () => \"INNER_OLD\";\n  step = replacement;\n  return step();\n}\nexport function entry() {\n  return step();\n}\n"}, "targetName": "step", "targetFile": "src/entry.mjs", "expectUnbounded": true},
    {"name": "unrelated-object-control", "files": {"src/worker.mjs": "export class Worker {\n  run() { return \"UNCHANGED_WORKER\"; }\n}\n", "src/other.mjs": "export class Other {\n  run() { return \"OTHER_OBJECT\"; }\n}\n", "src/entry.mjs": "import { Worker } from \"./worker.mjs\";\nimport { Other } from \"./other.mjs\";\nconst worker = new Worker();\nconst other = new Other();\nfunction replacement() { return \"NEW_OTHER\"; }\nother.run = replacement;\nexport function entry() {\n  return worker.run();\n}\n"}, "targetName": "run", "targetFile": "src/worker.mjs", "expectUnbounded": false}
  ])('preserves unchanged callable identity with unrelated writes: $name', ({ files, targetName, targetFile, expectUnbounded }) => {
    const { graph, root, idFor } = fixture(files, true)
    const entry = idFor('entry', 'src/entry.mjs')
    const target = idFor(targetName, targetFile)
    expect(entry).not.toBe('')
    expect(target).not.toBe('')
    const source = selectSourceDependencies(graph, [entry], root, new Map(), { includeCallers: false })
    expect(source.relationships.filter(edge => edge.from_id === entry && edge.relation === 'calls'))
      .toEqual([{ from_id: entry, to_id: target, relation: 'calls' }])
    expect(source.receipt.resolved_calls).toBeGreaterThan(0)
    expect(source.receipt.unresolved_calls).toBe(0)
    if (expectUnbounded) expect(source.receipt.bounded).toBe(false)
  })

  it.each([
    { write: 'api.step = () => 2;', imported: false },
    { write: "const key = 'step'; api[key] = () => 2;", imported: false },
    { write: 'api.unrelated = () => 2;', imported: true },
  ])('checks export slots without poisoning the local callable: $write', ({ write, imported }) => {
    const { graph, root, idFor } = fixture({
      'target.cjs': 'function step() { return 1; }\nexports.step = step;\nfunction localEntry() { return step(); }\nexports.localEntry = localEntry;\n',
      'writer.cjs': `const api = require('./target.cjs');\n${write}\n`,
      'star.mjs': "export * from './target.cjs';\n",
      'named.mjs': "export { step as default } from './target.cjs';\n",
      'entry.mjs': "import './writer.cjs';\nimport { step as alias } from './target.cjs';\nimport * as barrel from './star.mjs';\nimport viaDefault from './named.mjs';\nexport function entry() { return alias() + barrel.step() + viaDefault(); }\n",
    }, true)
    const entry = idFor('entry', 'entry.mjs'), local = idFor('localEntry', 'target.cjs'), step = idFor('step', 'target.cjs')
    expect([entry, local, step]).not.toContain('')
    const result = selectSourceDependencies(graph, [entry, local], root, new Map(), { includeCallers: false })
    expect(result.source_resolved_call_pairs).toContainEqual({ from_id: local, to_id: step })
    expect(result.source_resolved_call_pairs?.some(pair => pair.from_id === entry && pair.to_id === step)).toBe(imported)
    expect(result[sourceSelectionProvenanceKey]!.scans).toMatchObject({ mutation: 'complete', write_origins: 'complete' })
    const stale = { from_id: entry, to_id: step, relation: 'calls' }
    expect(reconcileSourceCalls([stale], result)).toEqual(imported ? [stale] : [])
  })

  it('does not restore a written export through constructor receivers, callback values or data aliases', () => {
    const { graph, root, idFor } = fixture({
      'target.cjs': 'class Worker {\n  static run() { return 1; }\n  deliver() { return 2; }\n}\nexports.Worker = Worker;\nfunction step(value) { return value; }\nexports.step = step;\nconst settings = { enabled: true };\nexports.settings = settings;\n',
      'writer.cjs': "const api = require('./target.cjs');\napi.Worker = class Replacement {};\napi.step = value => 0;\napi.settings = {};\n",
      'entry.mjs': "import './writer.cjs';\nimport { Worker, step, settings } from './target.cjs';\nconst Constructor = Worker;\nconst callback = step;\nexport function entry() {\n  const worker = new Constructor();\n  [1].map(callback);\n  return Constructor.run() + worker.deliver() + settings.enabled;\n}\n",
    }, true)
    const entry = idFor('entry', 'entry.mjs')
    expect(entry).not.toBe('')
    const result = selectSourceDependencies(graph, [entry], root, new Map(), { includeCallers: false })
    expect(result.relationships.filter(edge => edge.from_id === entry && String(graph.nodeAttributes(edge.to_id).source_file).endsWith('target.cjs'))).toEqual([])
    expect(result.receipt.unresolved_calls).toBeGreaterThan(0)
    expect(result[sourceSelectionProvenanceKey]!.scans.mutation).toBe('complete')
  })

  it('keeps cached export routes within the depth bound and preserves concrete cyclic-barrel exports', () => {
    const files: Record<string, string> = {
      'target.mjs': 'export function target() { return 1; }\n',
      'cycle-a.mjs': "export * from './cycle-b.mjs';\nexport * from './target.mjs';\n",
      'cycle-b.mjs': "export * from './cycle-a.mjs';\n",
    }
    for (let index = 0; index < 8; index += 1) files[`layer-${index}.mjs`] = `export * from './${index === 7 ? 'target' : `layer-${index + 1}`}.mjs';\n`
    files['entry.mjs'] = [
      "import { target as shallow } from './layer-1.mjs';",
      "import { target as deep } from './layer-0.mjs';",
      "import { target as cyclic } from './cycle-a.mjs';",
      ...Object.keys(files).map(file => `import './${file}';`),
      'export function entry() { return shallow(); }',
      'export function deepEntry() { return deep(); }',
      'export function cycleEntry() { return cyclic(); }',
    ].join('\n')
    const { graph, root, idFor } = fixture(files, true)
    const entry = idFor('entry', 'entry.mjs'), deep = idFor('deepEntry', 'entry.mjs'), cyclic = idFor('cycleEntry', 'entry.mjs')
    const target = idFor('target', 'target.mjs')
    expect([entry, deep, cyclic, target]).not.toContain('')
    const result = selectSourceDependencies(graph, [entry, deep, cyclic, target], root, new Map(), { includeCallers: false })
    expect(result.source_resolved_call_pairs).toContainEqual({ from_id: entry, to_id: target })
    expect(result.source_resolved_call_pairs).not.toContainEqual({ from_id: deep, to_id: target })
    // The circular branch supplies no value route; the independent concrete
    // leaf export remains supported, as it was before success memoization.
    expect(result.source_resolved_call_pairs).toContainEqual({ from_id: cyclic, to_id: target })
    expect(result[sourceSelectionProvenanceKey]!.scans).toMatchObject({ program: 'complete', mutation: 'complete' })
  })

  it('withholds a source-unconfirmed builtin collision while preserving non-call graph relations', () => {
    const { graph, root, idFor } = fixture({
      'batch.ts': 'export function collect(values: number[]) { return Promise.all(values); }\nexport function all(values: number[]) { return values; }',
    })
    const caller = idFor('collect', 'batch.ts')
    const unrelated = idFor('all', 'batch.ts')
    expect(graph.hasEdge(caller, unrelated)).toBe(true)
    const source = selectSourceDependencies(graph, [caller], root, new Map(), { includeCallers: false })
    expect(source.source_call_authority_owner_ids).toContain(caller)
    expect(source.receipt.unresolved_calls).toBeGreaterThan(0)
    const edges = [
      { from_id: caller, to_id: unrelated, relation: 'calls' },
      { from_id: caller, to_id: unrelated, relation: 'depends_on' },
      { from_id: caller, to_id: unrelated, relation: 'imports' },
    ]
    expect(reconcileSourceCalls(edges, source)).toEqual(edges.slice(1))
    expect(source.receipt.withheld_graph_calls).toBe(1)
  })

  it('preserves a resolved call between inspected owners outside the selected source closure', () => {
    const { graph, root, idFor } = fixture({
      'composition.ts': 'export function entrypoint() { return 1; }\nexport function reduceBatch(value: number) { return renderRow(value); }\nexport function renderRow(value: number) { return value + 1; }',
    })
    const entry = idFor('entrypoint', 'composition.ts')
    const caller = idFor('reduceBatch', 'composition.ts')
    const callee = idFor('renderRow', 'composition.ts')
    expect(graph.hasEdge(caller, callee)).toBe(true)
    const source = selectSourceDependencies(graph, [entry], root, new Map(), { includeCallers: false })
    expect(source.node_ids).not.toContain(caller)
    expect(source.node_ids).not.toContain(callee)
    const edge = { from_id: caller, to_id: callee, relation: 'calls' }
    expect(source.relationships).not.toContainEqual(edge)
    expect(source.source_call_authority_owner_ids).toContain(caller)
    expect(source.source_resolved_call_pairs).toContainEqual({ from_id: caller, to_id: callee })
    expect(reconcileSourceCalls([edge], source)).toEqual([edge])
    expect(source.receipt.withheld_graph_calls).toBeUndefined()
  })

  it('resets withheld graph call receipts when reconciliation is repeated or has no authority', () => {
    const { graph, root, idFor } = fixture({
      'batch.ts': 'export function collect(values: number[]) { return Promise.all(values); }\nexport function all(values: number[]) { return values; }',
    })
    const caller = idFor('collect', 'batch.ts')
    const source = selectSourceDependencies(graph, [caller], root, new Map(), { includeCallers: false })
    const edge = { from_id: caller, to_id: idFor('all', 'batch.ts'), relation: 'calls' }
    expect(reconcileSourceCalls([edge], source)).toEqual([])
    expect(source.receipt.withheld_graph_calls).toBe(1)
    expect(reconcileSourceCalls([edge], source)).toEqual([])
    expect(source.receipt.withheld_graph_calls).toBe(1)
    expect(reconcileSourceCalls([], source)).toEqual([])
    expect(source.receipt.withheld_graph_calls).toBeUndefined()
    expect(reconcileSourceCalls([edge], source)).toEqual([])
    expect(source.receipt.withheld_graph_calls).toBe(1)
    source.source_call_authority_owner_ids = []
    expect(reconcileSourceCalls([edge], source)).toEqual([edge])
    expect(source.receipt.withheld_graph_calls).toBeUndefined()
  })

  it('keeps a real callee when incidental callers fill the closure, while caller requests retain priority', () => {
    const { graph, root, idFor } = fixture({
      'service.ts': 'import { deriveQuota } from "./quota.js";\nexport function processTicket(value: number) { return deriveQuota(value); }',
      'quota.ts': 'export function deriveQuota(value: number) { return value - 1; }',
      'panels.ts': 'import { processTicket } from "./service.js";\n' + Array.from({ length: 18 }, (_, index) => `export function panel${index}(value: number) { return processTicket(value); }`).join('\n'),
    })
    const seed = idFor('processTicket', 'service.ts')
    const callee = idFor('deriveQuota', 'quota.ts')
    const firstCaller = idFor('panel0', 'panels.ts')
    const ordinary = selectSourceDependencies(graph, [seed], root, new Map())
    expect(ordinary.node_ids).toHaveLength(12)
    expect(ordinary.node_ids).toEqual(expect.arrayContaining([callee, firstCaller]))
    expect(ordinary.receipt.bounded).toBe(true)
    expect(ordinary.relationships).toContainEqual({ from_id: seed, to_id: callee, relation: 'calls' })
    const callers = selectSourceDependencies(graph, [seed], root, new Map(), { callerPriority: true })
    expect(callers.node_ids).toHaveLength(12)
    expect(callers.node_ids).not.toContain(callee)
    expect(callers.node_ids).toContain(firstCaller)
  })

  it('reserves a bounded local calculation group without promoting shadowed, nested or stale bindings', () => {
    const source = [
      'export const FREE_ATTEMPTS = 3;',
      'function normalizeAttemptCount(value: unknown) {',
      '  return typeof value === "number" && value >= 0 ? Math.floor(value) : 0;',
      '}',
      'export function calculateShipmentAllowance(attemptsUsed: unknown) {',
      '  const used = normalizeAttemptCount(attemptsUsed);',
      '  return { free: used < FREE_ATTEMPTS, remainingAllowance: Math.max(0, FREE_ATTEMPTS - used - 1) };',
      '}',
      'export function supplied(value: unknown, FREE_ATTEMPTS: number) { return normalizeAttemptCount(value) < FREE_ATTEMPTS; }',
      'export function deferred(value: unknown) { return () => normalizeAttemptCount(value) < FREE_ATTEMPTS; }',
      'export const WRITTEN = 4;',
      'function overwrite() { WRITTEN = 0; }',
      'export function changed(value: unknown) { return normalizeAttemptCount(value) < WRITTEN; }',
      ...Array.from({ length: 18 }, (_, index) => `export function view${index}() { return calculateShipmentAllowance(${index}); }`),
    ].join('\n')
    const { graph, root, idFor } = fixture({ 'allowance.ts': source }, true)
    const id = (name: string) => idFor(name, 'allowance.ts')
    const leader = id('calculateShipmentAllowance'), helper = id('normalizeAttemptCount'), scalar = id('FREE_ATTEMPTS')
    const cache = new Map<string, string[] | null>()
    const allowedOwner = () => true
    const preference = { seedId: leader, allowedOwner }
    const before = JSON.stringify(graph.edgeEntries())
    const ordinary = selectSourceDependencies(graph, [leader], root, cache)
    const preferred = selectSourceDependencies(graph, [leader], root, cache, { localPriority: preference })
    expect(ordinary.node_ids).toHaveLength(12)
    expect(ordinary.node_ids).not.toContain(scalar)
    expect(preferred.node_ids).toHaveLength(12)
    expect(preferred[sourceLocalPriorityKey]).toEqual([leader, helper, scalar])
    expect(preferred[sourceSelectionProvenanceKey]!.admissions.slice(0, 2)).toEqual([
      { node_id: helper, role: 'outgoing', depth: 0 }, { node_id: scalar, role: 'data_reference', depth: 0 },
    ])
    expect(preferred.relationships).toEqual(expect.arrayContaining([
      { from_id: leader, to_id: helper, relation: 'calls' }, { from_id: leader, to_id: scalar, relation: 'depends_on' },
    ]))
    expect(JSON.stringify(graph.edgeEntries())).toBe(before)
    const result = retrieveContext(graph, { question: 'How is attemptsUsed normalized when missing or negative, and when does a shipment qualify for another free attempt? Explain the remaining allowance.', taskKind: 'explain', budget: 3000 })
    expect(result.matched_nodes.slice(0, 3).map(node => node.node_id)).toEqual([leader, helper, scalar])
    expect(result.matched_nodes.find(node => node.node_id === scalar)?.snippet).toContain('FREE_ATTEMPTS = 3')
    expect(result.token_count).toBeLessThanOrEqual(3000)
    for (const name of ['supplied', 'deferred', 'changed']) {
      const seedId = id(name)
      expect(selectSourceDependencies(graph, [seedId], root, cache, { localPriority: { seedId, allowedOwner } })[sourceLocalPriorityKey]).toBeUndefined()
    }
    expect(selectSourceDependencies(graph, [leader], root, cache, { callerPriority: true, localPriority: preference })[sourceLocalPriorityKey]).toBeUndefined()
    expect(selectSourceDependencies(graph, [leader], root, cache, { localPriority: { seedId: leader,
      allowedOwner: (_file, label) => label !== 'FREE_ATTEMPTS' } })[sourceLocalPriorityKey]).toBeUndefined()
    writeFileSync(join(root, 'allowance.ts'), source.replace('FREE_ATTEMPTS = 3', 'FREE_ATTEMPTS = 8'))
    expect(selectSourceDependencies(graph, [leader], root, cache, { localPriority: preference })[sourceLocalPriorityKey]).toBeUndefined()
  })

  it.each([false, true])('retains a separate requested behavior after a named owner with a call: %s', withCall => {
    const { graph } = fixture({
      'identity.ts': withCall
        ? 'import { forward } from "./forward.js";\nexport function inspectValue(value: number) { return forward(value); }'
        : 'export function inspectValue(value: number) { return value; }',
      'forward.ts': 'export function forward(value: number) { return value + 1; }',
      'window.ts': 'export function delayWindow(retries: number) {\n  const backoffDelay = Math.min(4000, 100 * 2 ** retries);\n  return backoffDelay;\n}',
    })
    const result = retrieveContext(graph, { question: 'Explain `inspectValue` and how backoff delays are computed.', taskKind: 'explain', budget: 3500 })
    expect(result.selection_scope).toBe('task_context')
    expect(result.matched_nodes.find(node => node.label === 'inspectValue()')?.snippet).toContain('export function inspectValue')
    expect(result.matched_nodes.find(node => node.label === 'delayWindow()')?.snippet).toContain('100 * 2 ** retries')
    if (withCall) expect(result.matched_nodes.some(node => node.label === 'forward()')).toBe(true)
    expect(result.relationships.some(edge => edge.from_id === 'identity_inspectvalue' && edge.to_id === 'window_delaywindow')).toBe(false)
  })

  it('does not turn prose matching a generic helper name into a dependency anchor', () => {
    const { graph } = fixture({
      'batch.ts': 'export function advanceBatch(state: any) {\n  const retry_count = state.retry_count + 1;\n  if (retry_count > 3) throw new Error("RETRY_LIMIT");\n  return { retry_count, accepted_items: state.items.filter((item: any) => item.accepted) };\n}',
      'report.ts': 'function renderStats(value: number) { return "UNRELATED_REPORT" + value; }\nexport function count(values: any[]) { return renderStats(values.length); }',
    })
    const result = retrieveContext(graph, { question: 'Show the batch implementation that increments retry_count, selects accepted_items and stops at the retry limit. Include the previous-count calculation.', taskKind: 'explain', budget: 4000 })
    expect(result.matched_nodes.find(node => node.label === 'advanceBatch()')?.snippet).toContain('retry_count > 3')
    expect(result.matched_nodes[0]?.label).not.toBe('count()')
  })

  it('still recognizes explicitly named simple functions in dependency questions', () => {
    const { graph } = fixture({
      'report.ts': 'function renderStats(value: number) { return "NAMED_REPORT" + value; }\nexport function count(values: any[]) { return renderStats(values.length); }',
    })
    const result = retrieveContext(graph, { question: 'Show count() and its dependencies.', taskKind: 'implement', budget: 3000 })
    expect(result.matched_nodes.map(node => node.label)).toEqual(expect.arrayContaining(['count()', 'renderStats()']))
  })

  it('includes aliased function arguments as dependencies without claiming they are invoked', () => {
    const service = "import { compare as orderById } from './order.js';\nimport { limit } from './config.js';\nexport function list(items: any[]) { return items.slice(0, limit).sort(orderById); }\nexport function valueReads(register: any, supplied: any) {\n  register(orderById.bind(null));\n  register(orderById.bind(null));\n  const stable = orderById; register(stable);\n  let mutable = orderById; mutable = supplied; register(mutable);\n  const conditional = supplied ? orderById : supplied; register(conditional);\n  register(supplied);\n  return orderById({}, {});\n}"
    const { graph, root, idFor } = fixture({
      'service.ts': service,
      'order.ts': 'export function compare(a: any, b: any) { return a.id.localeCompare(b.id); }',
      'config.ts': 'export const limit = 10;',
      'unrelated.ts': 'export function compare() { return "WRONG_COMPARATOR"; }',
    })
    const selected = selectSourceDependencies(graph, [idFor('list', 'service.ts')], root, new Map(), { includeCallers: false })
    expect(selected.node_ids).toContain(idFor('compare', 'order.ts'))
    expect(selected.node_ids).not.toContain(idFor('compare', 'unrelated.ts'))
    expect(selected.node_ids).not.toContain(idFor('limit', 'config.ts'))
    expect(selected.relationships).toContainEqual({ from_id: idFor('list', 'service.ts'), to_id: idFor('compare', 'order.ts'), relation: 'depends_on' })
    expect(selected.relationships).not.toContainEqual({ from_id: idFor('list', 'service.ts'), to_id: idFor('compare', 'order.ts'), relation: 'calls' })
    expect(selected.receipt.resolved_references).toBe(1)
    // This legacy-only graph has no constant owner; disclose the missing value.
    expect(selected.receipt.unresolved_references).toBe(1)
    expect(selected.receipt.bounded).toBe(true)
    const caller = idFor('valueReads', 'service.ts')
    const baseline = selectSourceDependencies(graph, [caller], root, new Map(), { includeCallers: false })
    const values = selectSourceDependencies(graph, [caller], root, new Map(), { includeCallers: false, functionValueCallerIds: [caller] })
    const { source_function_value_references: references, ...original } = values
    expect(original).toEqual(baseline)
    expect(references?.length).toBeGreaterThan(0)
    expect(references!.every(reference => reference.caller.node_id === caller && reference.target.node_id === idFor('compare', 'order.ts'))).toBe(true)
    const reads = references!.map(reference => service.slice(reference.read.start_offset, reference.read.end_offset))
    expect(reads).toContain('stable')
    expect(reads).not.toContain('mutable'); expect(reads).not.toContain('conditional'); expect(reads).not.toContain('supplied')
    const boundReads = references!.filter(reference => service.slice(reference.read.end_offset).startsWith('.bind(null)'))
    expect(boundReads).toHaveLength(2)
    expect(boundReads[0]!.read.start_offset).not.toBe(boundReads[1]!.read.start_offset)
    expect(references!.some(reference => service.slice(reference.read.end_offset).startsWith('({}, {})'))).toBe(false)
    expect(selectSourceDependencies(graph, [caller], root, new Map(), { includeCallers: false, functionValueCallerIds: ['not-a-current-caller'] }).source_function_value_references).toBeUndefined()
  })

  it('includes the bound policy data through aliases and namespaces without unrelated readers', () => {
    const { graph, root, idFor } = fixture({
      'service.ts': "import { maximum as cap } from './public.js';\nimport * as policy from './policy.js';\nexport function canDispatch(kind: string, attempts: number) {\n  if (attempts >= cap) return false;\n  return !policy.blockedKinds.has(kind);\n}",
      'public.ts': "export { maximum } from './policy.js';",
      'policy.ts': "export const maximum = 4;\nexport const blockedKinds = new Set(['expired', 'revoked']);\nexport const unused = 9999;",
      'unrelated.ts': "import { maximum } from './policy.js';\nexport function reportLimit() { return 'UNRELATED_READER' + maximum; }\nexport const blockedKinds = ['WRONG_POLICY'];",
    }, true)
    const selected = selectSourceDependencies(graph, [idFor('canDispatch', 'service.ts')], root, new Map())
    expect(selected.node_ids).toEqual(expect.arrayContaining([idFor('maximum', 'policy.ts'), idFor('blockedKinds', 'policy.ts')]))
    expect(selected.node_ids).not.toContain(idFor('reportLimit', 'unrelated.ts'))
    expect(selected.node_ids).not.toContain(idFor('unused', 'policy.ts'))
    expect(selected.node_ids).not.toContain(idFor('blockedKinds', 'unrelated.ts'))
    const source = retrieveContext(graph, { question: 'Explain canDispatch and the policy values used to decide its result.', taskKind: 'explain', budget: 3500 }).matched_nodes.map(node => node.snippet ?? '').join('\n')
    expect(source).toContain('maximum = 4')
    expect(source).toContain("new Set(['expired', 'revoked'])")
    expect(source).not.toContain('WRONG_POLICY')
    expect(source).not.toContain('UNRELATED_READER')
  })

  it('does not substitute constants for type-only, supplied, mutable, or shadowed data', () => {
    const { graph, root, idFor } = fixture({
      'service.ts': "import { maximum } from './policy.js';\nimport type * as policy from './policy.js';\nlet mutable = maximum;\nmutable = 0;\nexport function supplied(values: typeof policy, maximum: number) {\n  type OnlyAType = typeof import('./policy.js').maximum;\n  return values.maximum + maximum + mutable;\n}",
      'policy.ts': 'export const maximum = 4;',
    }, true)
    const selected = selectSourceDependencies(graph, [idFor('supplied', 'service.ts')], root, new Map(), { includeCallers: false })
    expect(selected.node_ids).toEqual([])
    expect(selected.relationships).toEqual([])
  })

  it('bounds data additions while preserving the executable callee', () => {
    const names = Array.from({ length: 16 }, (_, index) => `limit${index}`)
    const { graph, root, idFor } = fixture({
      'service.ts': `import { ${names.join(', ')} } from './policy.js';\nimport { normalize } from './normalize.js';\nexport function values() { return normalize([${names.join(', ')}]); }`,
      'policy.ts': names.map((name, index) => `export const ${name} = ${index};`).join('\n'),
      'normalize.ts': "import { finish } from './finish.js';\nexport function normalize(values: number[]) { return finish(values); }",
      'finish.ts': 'export function finish(values: number[]) { return values.slice(0, 2); }',
    }, true)
    const selected = selectSourceDependencies(graph, [idFor('values', 'service.ts')], root, new Map(), { includeCallers: false })
    expect(selected.node_ids).toHaveLength(12)
    expect(selected.node_ids[0]).toBe(idFor('normalize', 'normalize.ts'))
    expect(selected.node_ids[1]).toBe(idFor('finish', 'finish.ts'))
    expect(selected.receipt.bounded).toBe(true)
  })

  it('resolves local function-value aliases without guessing interface implementations', () => {
    const { graph, root, idFor } = fixture({
      'service.ts': "import { compare } from './order.js';\nconst ordering = compare;\ninterface Options { compare: (a: unknown, b: unknown) => number }\nexport function list(items: any[], options: Options) { return [items.sort(ordering), items.sort(options.compare)]; }",
      'order.ts': 'export function compare(a: any, b: any) { return a.id - b.id; }',
      'unrelated.ts': 'export function compare() { return "UNBOUND_INTERFACE"; }',
    })
    const selected = selectSourceDependencies(graph, [idFor('list', 'service.ts')], root, new Map(), { includeCallers: false })
    expect(selected.node_ids).toContain(idFor('compare', 'order.ts'))
    expect(selected.node_ids).not.toContain(idFor('compare', 'unrelated.ts'))
    expect(selected.receipt.resolved_references).toBe(1)
  })

  it('does not mistake a shared callback type signature for a uniquely bound implementation', () => {
    const { graph, root, idFor } = fixture({
      'service.ts': "import { forward, reverse } from './order.js';\nexport function list(items: number[], descending: boolean) {\n  const compare = descending ? reverse : forward;\n  return items.sort(compare);\n}",
      'order.ts': 'export function forward(a: number, b: number) { return a - b; }\nexport function reverse(a: number, b: number) { return b - a; }',
    })
    const selected = selectSourceDependencies(graph, [idFor('list', 'service.ts')], root, new Map(), { includeCallers: false })
    expect(selected.node_ids).not.toContain(idFor('forward', 'order.ts'))
    expect(selected.node_ids).not.toContain(idFor('reverse', 'order.ts'))
    expect(selected.receipt.unresolved_references).toBe(1)
  })

  it('does not resolve a mutable callback alias from its initializer alone', () => {
    const { graph, root, idFor } = fixture({
      'service.ts': "import { forward, reverse } from './order.js';\nexport function list(items: number[]) {\n  let compare = forward;\n  compare = reverse;\n  return items.sort(compare);\n}",
      'order.ts': 'export function forward(a: number, b: number) { return a - b; }\nexport function reverse(a: number, b: number) { return b - a; }',
    })
    const selected = selectSourceDependencies(graph, [idFor('list', 'service.ts')], root, new Map(), { includeCallers: false })
    expect(selected.node_ids).toEqual([])
    expect(selected.receipt.unresolved_references).toBe(1)
  })

  it('does not turn a direct call through a dynamic function value into a definite implementation', () => {
    for (const body of [
      'const chosen = descending ? reverse : forward; return chosen(a, b);',
      'let chosen = forward; chosen = reverse; return chosen(a, b);',
      'return supplied(a, b);',
    ]) {
      const { graph, root, idFor } = fixture({
        'service.ts': `import { forward, reverse } from './order.js';\nexport function compareValues(a: number, b: number, descending: boolean, supplied: typeof forward) {\n  ${body}\n}`,
        'order.ts': 'export function forward(a: number, b: number) { return a - b; }\nexport function reverse(a: number, b: number) { return b - a; }',
      })
      const selected = selectSourceDependencies(graph, [idFor('compareValues', 'service.ts')], root, new Map(), { includeCallers: false })
      expect(selected.node_ids, body).toEqual([])
      expect(selected.receipt.resolved_calls, body).toBe(0)
      expect(selected.receipt.unresolved_calls, body).toBe(1)
      const result = retrieveContext(graph, { question: 'Trace the compareValues implementation and its actual callee.', taskKind: 'explain', budget: 4000 })
      expect(result.matched_nodes.map(node => node.label), body).toEqual(['compareValues()'])
      expect(result.source_dependencies?.unresolved_calls, body).toBe(1)
    }
  })

  it('does not infer a constructor binding from a conditional, mutable or parameter type signature', () => {
    for (const body of [
      'const Selected = blue ? Blue : Red; return new Selected();',
      'let Selected = Blue; Selected = Red; return new Selected();',
      'return new supplied();',
    ]) {
      const { graph, root, idFor } = fixture({
        'service.ts': `import { Blue, Red } from './models.js';\nexport function createModel(blue: boolean, supplied: typeof Blue) {\n  ${body}\n}`,
        'models.ts': 'export class Blue {\n  constructor() {}\n  color() { return "blue"; }\n}\nexport class Red {\n  constructor() {}\n  color() { return "red"; }\n}',
      })
      const selected = selectSourceDependencies(graph, [idFor('createModel', 'service.ts')], root, new Map(), { includeCallers: false })
      expect(selected.node_ids, body).toEqual([])
      expect(selected.receipt.resolved_calls, body).toBe(0)
      expect(selected.receipt.unresolved_calls, body).toBe(1)
    }
  })

  it('keeps concrete overloaded functions, methods and constructors through stable aliases', () => {
    const { graph, root, idFor } = fixture({
      'service.ts': "import { normalize as apply, Repository } from './implementation.js';\nimport * as implementation from './implementation.js';\nconst stable = apply;\nconst Constructor = Repository;\nexport function accept(value: string) {\n  const repository = new Constructor(value);\n  return stable(value) + repository.store(value) + implementation.normalize(value);\n}",
      'implementation.ts': 'export function normalize(value: string): string;\nexport function normalize(value: number): string;\nexport function normalize(value: string | number) { return "NORMALIZED" + value; }\nexport class Repository {\n  constructor(value: string);\n  constructor(value: number);\n  constructor(public value: string | number) {}\n  store(value: string): string;\n  store(value: number): string;\n  store(value: string | number) { return "STORED" + value; }\n}',
    })
    const selected = selectSourceDependencies(graph, [idFor('accept', 'service.ts')], root, new Map(), { includeCallers: false })
    expect(selected.receipt.resolved_calls).toBe(4)
    expect(selected.receipt.unresolved_calls).toBe(0)
    for (const [name, line] of [['normalize', 3], ['constructor', 7], ['store', 10]] as const) {
      expect(graph.nodeAttributes(idFor(name, 'implementation.ts')).source_location).toBe(`L${line}`)
    }
    // Concrete owners must retain their implementation source, not signatures.
    const result = retrieveContext(graph, { question: 'Trace the accept implementation and its actual callees.', taskKind: 'explain', budget: 4000 })
    const source = result.matched_nodes.map(node => node.snippet ?? '').join('\n')
    expect(source).toContain('return "NORMALIZED" + value')
    expect(source).toContain('constructor(public value: string | number) {}')
    expect(source).toContain('return "STORED" + value')
  })

  it('binds instance methods to the actual stable constructor despite a wider annotation', () => {
    const { graph, root, idFor } = fixture({
      'service.ts': "import { BasePort } from './base.js';\nimport { DerivedPort } from './derived.js';\nconst Constructor = DerivedPort;\nexport function dispatch() {\n  const port: BasePort = new Constructor();\n  const alias = port;\n  return alias.deliver() + new DerivedPort().deliver() + DerivedPort.identify();\n}",
      'base.ts': 'export class BasePort {\n  deliver() { return "BASE_IMPLEMENTATION"; }\n}',
      'derived.ts': "import { BasePort } from './base.js';\nexport class DerivedPort extends BasePort {\n  override deliver() { return 'DERIVED_IMPLEMENTATION'; }\n  static identify() { return 'STATIC_IMPLEMENTATION'; }\n}",
    })
    const selected = selectSourceDependencies(graph, [idFor('dispatch', 'service.ts')], root, new Map(), { includeCallers: false })
    expect(selected.receipt.unresolved_calls).toBe(0)
    expect(selected.relationships).toContainEqual({ from_id: idFor('dispatch', 'service.ts'), to_id: idFor('deliver', 'derived.ts'), relation: 'calls' })
    expect(selected.relationships).toContainEqual({ from_id: idFor('dispatch', 'service.ts'), to_id: idFor('identify', 'derived.ts'), relation: 'calls' })
    expect(selected.relationships.some(edge => edge.to_id === idFor('deliver', 'base.ts'))).toBe(false)
  })

  it('keeps parameter, mutable, conditional and returned method receivers unresolved', () => {
    for (const body of [
      'return supplied.deliver();',
      'let port: BasePort = new BasePort(); port = new DerivedPort(); return port.deliver();',
      'const port = flag ? new BasePort() : new DerivedPort(); return port.deliver();',
      'const port = factory(); return port.deliver();',
    ]) {
      const { graph, root, idFor } = fixture({
        'service.ts': `import { BasePort } from './base.js';\nimport { DerivedPort } from './derived.js';\nexport function dispatch(supplied: BasePort, factory: () => BasePort, flag: boolean) {\n  ${body}\n}`,
        'base.ts': 'export class BasePort {\n  deliver() { return "BASE_IMPLEMENTATION"; }\n}',
        'derived.ts': "import { BasePort } from './base.js';\nexport class DerivedPort extends BasePort {\n  override deliver() { return 'DERIVED_IMPLEMENTATION'; }\n}",
      })
      const selected = selectSourceDependencies(graph, [idFor('dispatch', 'service.ts')], root, new Map(), { includeCallers: false })
      expect(selected.relationships.some(edge => [idFor('deliver', 'base.ts'), idFor('deliver', 'derived.ts')].includes(edge.to_id)), body).toBe(false)
      expect(selected.receipt.unresolved, body).toContainEqual(expect.objectContaining({ callee: body.startsWith('return supplied') ? 'supplied.deliver' : 'port.deliver', reason: 'unresolved' }))
    }
  })

  it('preserves lexical private methods while keeping public this dispatch unresolved', () => {
    const { graph, root, idFor } = fixture({
      'service.ts': 'export class Service {\n  #secret() { return "PRIVATE_IMPLEMENTATION"; }\n  deliver() { return "VIRTUAL_IMPLEMENTATION"; }\n  dispatch() { return this.#secret() + this.deliver(); }\n}',
    })
    const selected = selectSourceDependencies(graph, [idFor('dispatch', 'service.ts')], root, new Map(), { includeCallers: false })
    expect(selected.receipt.resolved_calls).toBe(1)
    expect(selected.receipt.unresolved).toContainEqual(expect.objectContaining({ callee: 'this.deliver', reason: 'unresolved' }))
    expect(selected.relationships).toContainEqual({ from_id: idFor('dispatch', 'service.ts'), to_id: idFor('#secret', 'service.ts'), relation: 'calls' })
    expect(graph.nodeAttributes(idFor('#secret', 'service.ts')).snippet).toContain('#secret() { return "PRIVATE_IMPLEMENTATION"; }')
    expect(selected.relationships.some(edge => edge.to_id === idFor('deliver', 'service.ts'))).toBe(false)
  })

  it('retains a second explicitly requested implementation even when the first has a different call closure', () => {
    const { graph } = fixture({
      'first.ts': "import { normalize } from './normalize.js';\nexport function acceptRequest(value: string) { return normalize(value); }",
      'normalize.ts': 'export function normalize(value: string) { return value.trim(); }',
      'second.ts': 'export function releaseLease(id: string) { return "RELEASE_LEASE_BODY" + id; }',
    })
    const result = retrieveContext(graph, { question: 'Show the implementation of acceptRequest and releaseLease and their dependencies.', taskKind: 'implement', budget: 4000 })
    expect(result.matched_nodes.map(node => node.snippet).join('\n')).toContain('RELEASE_LEASE_BODY')
    expect(result.matched_nodes.map(node => node.label)).toEqual(expect.arrayContaining(['acceptRequest()', 'releaseLease()', 'normalize()']))
  })

  it('retains functions in an explicitly requested helper file alongside the primary call closure', () => {
    const { graph } = fixture({
      'service.ts': "import { normalize } from './normalize.js';\nexport function acceptRequest(value: string) { return normalize(value); }",
      'normalize.ts': 'export function normalize(value: string) { return value.trim(); }',
      'lease.ts': 'export function releaseLease(id: string) { return "REQUESTED_FILE_HELPER" + id; }',
    })
    const result = retrieveContext(graph, { question: 'Show the implementation of acceptRequest and the helpers in lease.ts.', taskKind: 'implement', budget: 4000 })
    expect(result.matched_nodes.map(node => node.snippet).join('\n')).toContain('REQUESTED_FILE_HELPER')
  })

  it('follows import aliases through a barrel and excludes a same-name implementation', () => {
    const { root, graph, idFor } = fixture({
      'service.ts': "import { consume as takeToken } from './public.js';\nexport function completeReset(token: string) { return takeToken(token) }",
      'public.ts': "export { consume } from './store.js';",
      'store.ts': 'export function consume(token: string) { if (!token) throw new Error("BAD_TOKEN"); return "REAL_STORE"; }',
      'metrics.ts': 'export function consume(token: string) { return "WRONG_ANALYTICS"; }',
    })
    const selected = selectSourceDependencies(graph, [idFor('completeReset', 'service.ts')], root, new Map())
    expect(selected.node_ids).toContain(idFor('consume', 'store.ts'))
    expect(selected.node_ids).not.toContain(idFor('consume', 'metrics.ts'))
    const result = retrieveContext(graph, { question: 'Show completeReset and the actual consume implementation called through takeToken.', budget: 4000 })
    expect(result.matched_nodes.map(node => node.snippet ?? '').join('\n')).toContain('REAL_STORE')
    expect(result.matched_nodes.map(node => node.snippet ?? '').join('\n')).not.toContain('WRONG_ANALYTICS')
    expect(result.source_dependencies?.resolved_calls).toBeGreaterThan(0)
  })

  it('resolves namespace functions but does not treat a typed injection as a proven method receiver', () => {
    const { root, graph, idFor } = fixture({
      'service.ts': "import type { Repository } from './repository.js';\nimport * as sessions from './sessions.js';\ninterface Dependencies { repository: Repository }\nexport class Service {\n  constructor(private dependencies: Dependencies) {}\n  completeReset(token: string) {\n    const user = this.dependencies.repository.consume(token);\n    if (!user) return false;\n    sessions.revoke(user.id);\n    return true;\n  }\n}",
      'repository.ts': 'export class Repository {\n  consume(token: string) { if (token === "expired") return null; return { id: token }; }\n}',
      'sessions.ts': 'export function revoke(id: string) { return "REAL_REVOKE" + id }',
      'metrics.ts': 'export class Metrics { consume() { return "WRONG_CONSUME" } }\nexport function revoke(id: string) { return "WRONG_REVOKE" + id }',
    })
    const selected = selectSourceDependencies(graph, [idFor('completeReset', 'service.ts')], root, new Map())
    expect(selected.node_ids).not.toContain(idFor('consume', 'repository.ts'))
    expect(selected.receipt.unresolved).toContainEqual(expect.objectContaining({ callee: 'this.dependencies.repository.consume', reason: 'unresolved' }))
    expect(selected.node_ids).toContain(idFor('revoke', 'sessions.ts'))
    expect(selected.node_ids).not.toContain(idFor('consume', 'metrics.ts'))
    expect(selected.node_ids).not.toContain(idFor('revoke', 'metrics.ts'))
  })

  it('reports interface callbacks as unresolved instead of choosing a same-name class', () => {
    const { root, graph, idFor } = fixture({
      'service.ts': 'interface Port { deliver(message: string): void }\nexport function notifyAccount(port: Port) { port.deliver("notice"); }',
      'smtp.ts': 'export class Smtp { deliver(message: string) { return "SMTP" + message } }',
      'sms.ts': 'export class Sms { deliver(message: string) { return "SMS" + message } }',
    })
    const selected = selectSourceDependencies(graph, [idFor('notifyAccount', 'service.ts')], root, new Map())
    expect(selected.node_ids).toEqual([])
    expect(selected.receipt.unresolved).toContainEqual(expect.objectContaining({ callee: 'port.deliver', reason: 'no_implementation', line_number: 2 }))
  })

  it('keeps a simple exact lookup on the requested symbol without expanding callers or callees', () => {
    const { graph } = fixture({
      'service.ts': "import { consume } from './store.js';\nexport function completeReset(token: string) { return consume(token) }",
      'store.ts': 'export function consume(token: string) { return token }',
      'app.ts': "import { completeReset } from './service.js';\nexport function main() { return completeReset('token') }",
    })
    const result = retrieveContext(graph, { question: 'What does completeReset do?', budget: 4000 })
    expect(result.selection_scope).toBe('symbol_lookup')
    expect(result.matched_nodes).toHaveLength(1)
    expect(result.matched_nodes[0]?.label).toBe('completeReset()')
    expect(result.source_dependencies).toBeUndefined()
    expect(result.task_contract?.required_evidence).toEqual(['primary'])
    expect(result.coverage?.missing_required).toEqual([])
    expect(result.coverage?.missing_semantic).toEqual([])
  })

  it('discloses exact literal owners omitted by the focused selection cap', () => {
    const { graph } = fixture(Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
      `owner-${index}.ts`, `export function owner${index}() { throw new Error("LIMIT_HIT"); }`,
    ])))
    const result = retrieveContext(graph, { question: 'Where is LIMIT_HIT thrown?', budget: 4000 })
    expect(result.selection_scope).toBe('symbol_lookup')
    expect(result.matched_nodes).toHaveLength(4)
    expect(result.selection_omitted).toBe(2)
    expect(result.source_search?.bounded).toBe(false)
  })

  it('prefers the requested qualified declaration over the same method name on another class', () => {
    const { graph, idFor } = fixture({
      'auth.ts': 'export class AuthService { login() { return "AUTH_SERVICE"; } }\nexport function decorativeBadge() { return "UNRELATED_BADGE"; }',
      'controller.ts': 'export class AuthController { login() { return "AUTH_CONTROLLER"; } }',
    })
    for (const [file, label] of [['auth.ts', 'AuthService.login'], ['controller.ts', 'AuthController.login']]) {
      const id = idFor('login', file!)
      graph.addNode(id, { ...graph.nodeAttributes(id), label })
    }
    const result = retrieveContext(graph, { question: 'Explain `AuthService.login`', budget: 3000 })
    expect(result.matched_nodes.map(node => node.label)).toEqual(['AuthService.login'])
    expect(result.matched_nodes[0]?.snippet).toContain('AUTH_SERVICE')
    const scoped = retrieveContext(graph, {
      question: 'Explain how AuthService.login() returns its result in auth.ts.',
      taskKind: 'explain', budget: 3000,
    })
    const snippets = scoped.matched_nodes.map(node => node.snippet).join('\n')
    expect(snippets).toContain('AUTH_SERVICE')
    expect(snippets).not.toContain('AUTH_CONTROLLER')
    expect(snippets).not.toContain('UNRELATED_BADGE')
    const unresolved = retrieveContext(graph, {
      question: 'Explain how client.login(Error) returns its result in auth.ts.',
      taskKind: 'explain', budget: 3000,
    })
    const unresolvedSnippets = unresolved.matched_nodes.map(node => node.snippet).join('\n')
    expect(unresolvedSnippets).toContain('AUTH_SERVICE')
    // An unverified receiver retains the legacy file owners; it must not pass
    // the location selector merely because "client.login" resembles a path.
    expect(unresolvedSnippets).toContain('UNRELATED_BADGE')
  })

  it('resolves qualified class ownership for bare method labels from default indexing', () => {
    const { root } = fixture({
      'auth.ts': 'export class AuthService {\n  login() { return "AUTH_SERVICE"; }\n}',
      'controller.ts': 'export class AuthController {\n  login() { return "AUTH_CONTROLLER"; }\n}',
    })
    const graph = loadGraph(generateGraph(root, { noHtml: true }).graphPath)
    const methods = graph.nodeEntries().filter(([, node]) => String(node.label).includes('login'))
    expect(methods).toHaveLength(2)
    expect(methods.every(([, node]) => node.label === '.login()')).toBe(true)
    const result = retrieveContext(graph, { question: 'Explain `AuthService.login`', budget: 3000 })
    expect(result.matched_nodes).toHaveLength(1)
    expect(result.matched_nodes[0]?.source_file).toBe('auth.ts')
    expect(result.matched_nodes[0]?.snippet).toContain('AUTH_SERVICE')
    expect(result.matched_nodes[0]?.snippet).not.toContain('AUTH_CONTROLLER')
  })

  it('does not treat import text inside comments and strings as module bindings', () => {
    const { graph, root, idFor } = fixture({
      'service.ts': `// import { surprise } from './wrong.js';\nexport function run() { return "import { surprise } from './wrong.js'"; }`,
      'wrong.ts': 'export function surprise() { return "WRONG" }',
    })
    const selected = selectSourceDependencies(graph, [idFor('run', 'service.ts')], root, new Map(), { includeCallers: false })
    expect(selected.receipt.scanned_files).toBe(1)
    expect(selected.node_ids).toEqual([])
  })
})
