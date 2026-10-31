import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'
import { queryEvidenceObligations, querySourceEvidenceClauses } from '../../src/runtime/retrieve/conceptual-fallback.js'
import { searchSourceBodies, searchSourceBodyQuestions, sourceQueryLiterals, sourceQueryWithoutLiteralSpans, type SourceBodyMatch } from '../../src/runtime/retrieve/source-evidence.js'
import { sourceDiagnosticQueries, sourceDiagnosticSeeds } from '../../src/runtime/retrieve/source-diagnostic-priority.js'
import { sourceQuerySymbols } from '../../src/runtime/retrieve/source-query-symbols.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const question = 'Trace queue startup and channel responses; wrong state with expected tenant and supplied code; a response error with expected state and tenant; whether pending work can settle again. Use tests if helpful.'
function fixture(arrow = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-diagnostic-priority-')))
  roots.push(root)
  const file = join(root, 'request.ts'), fake = join(root, 'request.test.ts')
  const lines = [
    'export class RequestChannel {',
    '  private pending: any;',
    '  begin(expected: any) {',
    `    return new Promise(${arrow ? '(resolve, reject) =>' : 'function (this: any, resolve, reject)'} {`,
    '      this.pending = { expectedState: expected.state, expectedTenant: expected.tenant, resolve, reject };',
    '    });',
    '  }',
    '  consume(response: any) {',
    '    if (response.state !== this.pending.expectedState || response.tenant !== this.pending.expectedTenant) {',
    '      this.reject(); return false;',
    '    }',
    '    if (response.error || !response.code) { this.reject(); return false; }',
    '    this.pending.resolve(response.code); return true;',
    '  }',
    '  reject() { this.pending.reject(); this.pending = undefined; }',
    '}',
    'export function configure(options: any) {',
    '  return { state: options.state, tenant: options.tenant, response: options.response, pending: options.pending };',
    '}',
    'export function startup(options: any) {',
    '  if (options.queue && options.startup) options.startQueue();',
    '  if (options.channel && options.responses) options.startChannel();',
    '  if (options.response && options.error) options.logError();',
    '  if (options.pending && options.work) options.schedule();',
    ...Array.from({ length: 12 }, (_, index) => `  if (options.queue${index} && options.channel${index}) options.record${index}();`),
    '  return options;',
    '}',
  ]
  writeFileSync(file, lines.join('\n'))
  writeFileSync(fake, 'export function simulate(expected: any) { const response = expected; if (response.state !== expected.state || response.tenant !== expected.tenant) throw Error("wrong state expected tenant supplied code response error pending work"); return response.code; }')
  const extracted = [file, fake].map(path => extractJs(path))
  const graph = buildFromJson({ schema_version: 1, nodes: extracted.flatMap(value => value.nodes), edges: extracted.flatMap(value => value.edges) }, { directed: true })
  graph.graph.root_path = root
  const node = (label: string) => {
    const [id, n] = graph.nodeEntries().find(([, n]) => n.label === label)!
    return { id, label, sourceFile: String(n.source_file), sourceLocation: String(n.source_location), sourceDomain: n.source_file === fake ? 'test' : 'production' }
  }
  const begin = node('.begin()'), consume = node('.consume()'), reject = node('.reject()'), configure = node('configure()'), startup = node('startup()'), simulate = node('simulate()')
  return { root, file, fake, graph, begin, consume, reject, startup, simulate, candidates: [simulate, startup, configure, begin, consume] }
}

const match: SourceBodyMatch = { score: 2, exact_literal: false, coverage: 1, relevance: 1, matched_literals: [], lines: [9] }
describe('diagnostic current-source priority', () => {
  it('keeps title-case prose lexical while preserving explicit requested symbol occurrences', () => {
    for (const [text, name] of [
      ['In the source, trace state validation.', 'In'],
      ['For the current request, trace state validation.', 'For'],
      ['With the supplied state, trace validation.', 'With'],
      ['Find the refund owner; In the source, trace state validation.', 'In'],
    ] as const) {
      expect(sourceQuerySymbols(text).some(symbol => symbol.name === name), text).toBe(false)
      expect(sourceQuerySymbols(text, { includeImplicit: true }).find(symbol => symbol.name === name), text)
        .toEqual({ name, start: text.indexOf(name), end: text.indexOf(name) + name.length, explicit: false })
    }
    for (const [text, names] of [
      ['Explain In() and its result.', ['In']],
      ['Explain `In` and its result.', ['In']],
      ['Explain "In" and its result.', ['In']],
      ['Explain obj.In and its result.', ['obj.In']],
      ['Explain function In and its result.', ['In']],
      ['Explain class In and its members.', ['In']],
      ['Explain In', ['In']],
      ['Find In and Out', ['In', 'Out']],
      ['Where is In?', ['In']],
      ['Where are In and Out?', ['In', 'Out']],
      ['Find classes In and Out', ['In', 'Out']],
      ['Explain functions In and Out', ['In', 'Out']],
      ['Explain IN behavior and Parser and Client behavior.', ['IN', 'Parser', 'Client']],
    ] as const) {
      const explicit = sourceQuerySymbols(text).map(symbol => symbol.name)
      for (const name of names) expect(explicit, text).toContain(name)
    }
  })

  it('keeps the recorded profile-context query free of fabricated source anchors', () => {
    const text = 'In the Miftah source, trace opt-in modern stateless profile-context handle selection and upstream tool calls: how handle expiry is calculated from requested lifetime and host assertion expiration; validation against renewed assertion issuer/subject/audience/chat and time boundaries; errors for rejected handles; selected profile and ordinary tool processing; whether the dedicated handle is forwarded upstream with tool arguments. Find relevant configuration limits and tests if available.'
    expect(sourceQueryLiterals(text)).toEqual([])
    expect(sourceQueryWithoutLiteralSpans(text)).toBe(text)
    expect(sourceQuerySymbols(text).some(symbol => symbol.name === 'In')).toBe(false)
    expect(sourceQuerySymbols(text, { includeImplicit: true }).find(symbol => symbol.name === 'In'))
      .toEqual({ name: 'In', start: 0, end: 2, explicit: false })
  })

  it('retains requested decisions when natural leading In has a real unrelated declaration', () => {
    const value = fixture()
    const file = join(value.root, 'upstream.ts')
    writeFileSync(file, 'export function In() { return "unrelated upstream decorator"; }')
    const extracted = extractJs(file)
    for (const node of extracted.nodes) value.graph.addNode(node.id, node)
    const decoy = extracted.nodes.find(node => node.label === 'In()')!.id
    const text = 'In the LedgerGarden source, trace wrong state with expected tenant and supplied code; a response error with expected state and tenant. Use tests if helpful.'
    const result = retrieveContext(value.graph, { question: text, budget: 1600, taskKind: 'explain', taskIntent: 'debug-flow' })
    const ids = result.matched_nodes.map(node => node.node_id)
    for (const id of [value.consume.id, value.begin.id, value.reject.id]) expect(ids).toContain(id)
    if (ids.includes(decoy)) expect(ids.indexOf(value.consume.id)).toBeLessThan(ids.indexOf(decoy))
    expect(result.matched_nodes.find(node => node.node_id === value.consume.id)?.snippet)
      .toContain('response.state !== this.pending.expectedState')
    expect(result.token_count).toBeLessThanOrEqual(1600)
    // The existing seed gate needs body vocabulary for an unquoted two-letter name.
    const explicit = retrieveContext(value.graph, { question: 'Explain In() and its unrelated upstream decorator result.', budget: 1000, taskKind: 'explain', taskIntent: 'explain' })
    expect(explicit.matched_nodes[0]?.node_id).toBe(decoy)
  })

  it('preserves raw decision nouns and unchanged public obligations/full-query source matches', () => {
    const text = 'Explain state and code; a response error.'
    expect(querySourceEvidenceClauses(text)).toEqual(['Explain state and code', 'a response error'])
    expect(queryEvidenceObligations(text)).toEqual([{ index: 0, terms: ['response', '@failure'] }])
    const value = fixture(), queries = sourceDiagnosticQueries(question)
    expect(queries.join(' ')).toContain('wrong state with expected tenant and supplied code')
    expect(queries.join(' ')).toContain('response error')
    expect(queries.length).toBeLessThanOrEqual(8)
    expect(sourceDiagnosticQueries(question.replace('tests if helpful', 'failing tests'))).toEqual([])
    const ordinary = searchSourceBodies(value.graph, question, value.root)
    const [batched, ...clauses] = searchSourceBodyQuestions(value.graph, [question, ...queries], value.root)
    expect(batched).toEqual(ordinary)
    const priority = sourceDiagnosticSeeds(value.candidates, clauses.map(clause => clause.matches), () => true, value.root)
    expect(priority).toContain(value.consume.id)
    expect(priority).toContain(value.begin.id)
    expect(priority).not.toContain(value.simulate.id)
    expect(priority.length).toBeLessThanOrEqual(3)
  })

  it('keeps a lexical-arrow companion without admitting clause-only or stale/excluded owners', () => {
    const value = fixture(), allow = () => true
    const clauses = [new Map([[value.consume.id, match]]), new Map([[value.consume.id, match]])]
    expect(sourceDiagnosticSeeds(value.candidates, clauses, allow, value.root)).toEqual([value.consume.id, value.begin.id])
    const ordinary = fixture(false), ordinaryClauses = [new Map([[ordinary.consume.id, match]]), new Map([[ordinary.consume.id, match]])]
    expect(sourceDiagnosticSeeds(ordinary.candidates, ordinaryClauses, allow, ordinary.root)).toEqual([ordinary.consume.id])
    expect(sourceDiagnosticSeeds(value.candidates.filter(n => n.id !== value.consume.id), clauses, allow, value.root)).toEqual([])
    expect(sourceDiagnosticSeeds(value.candidates, clauses, (_, label) => label !== '.consume()', value.root)).toEqual([])
    expect(sourceDiagnosticSeeds(value.candidates.map(n => n.id === value.consume.id ? { ...n, sourceLocation: 'L9-L13' } : n), clauses, allow, value.root)).toEqual([])
    expect(sourceDiagnosticSeeds(Array.from({ length: 33 }, () => value.consume), clauses, allow, value.root)).toEqual([])
    expect(sourceDiagnosticSeeds([...value.candidates, { ...value.consume, id: 'alias' }], clauses, allow, value.root)).toEqual([])
  })

  it('retains requested decisions with startup context, and resists unsolicited startup/test topic matches', () => {
    const value = fixture()
    const result = retrieveContext(value.graph, { question, budget: 1600, taskKind: 'explain', taskIntent: 'debug-flow' })
    const ids = result.matched_nodes.map(node => node.node_id)
    expect(ids).toContain(value.consume.id)
    if (ids.includes(value.simulate.id)) expect(ids.indexOf(value.consume.id)).toBeLessThan(ids.indexOf(value.simulate.id))
    expect(ids).toContain(value.begin.id)
    expect(ids).toContain(value.reject.id)
    expect(result.token_count).toBeLessThanOrEqual(1600)
    expect(result.matched_nodes.find(node => node.node_id === value.consume.id)?.snippet).toContain('response.state !== this.pending.expectedState')
    expect(result.matched_nodes.find(node => node.node_id === value.consume.id)?.snippet).toContain('response.error || !response.code')
    expect(result.matched_nodes.find(node => node.node_id === value.begin.id)?.snippet).toContain('this.pending =')
    expect(result.matched_nodes.find(node => node.node_id === value.reject.id)?.snippet).toContain('this.pending.reject()')
    // The same broad production source is present, but startup is no longer a
    // requested subject. Separate concrete clauses still retain their owners.
    const focusedQuestion = 'Trace wrong state with expected tenant and supplied code; a response error with expected state and tenant. Use tests if helpful.'
    const focused = retrieveContext(value.graph, { question: focusedQuestion, budget: 1600, taskKind: 'explain', taskIntent: 'debug-flow' })
    const focusedIds = focused.matched_nodes.map(node => node.node_id)
    for (const id of [value.consume.id, value.begin.id, value.reject.id]) expect(focusedIds).toContain(id)
    for (const rival of [value.simulate.id, value.startup.id]) if (focusedIds.includes(rival)) {
      expect(focusedIds.indexOf(value.consume.id)).toBeLessThan(focusedIds.indexOf(rival))
      expect(focusedIds.indexOf(value.begin.id)).toBeLessThan(focusedIds.indexOf(rival))
    }
    expect(focused.token_count).toBeLessThanOrEqual(1600)
    const explicit = retrieveContext(value.graph, { question: 'Debug why simulate() fails in request.test.ts; determine the state and tenant behavior.', budget: 1000, taskKind: 'explain', taskIntent: 'debug-flow' })
    expect(explicit.matched_nodes[0]?.node_id).toBe(value.simulate.id)
  })
})
