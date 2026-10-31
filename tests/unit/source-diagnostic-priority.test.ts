import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import ts from 'typescript'
import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'
import { queryEvidenceObligations, querySourceEvidenceClauses } from '../../src/runtime/retrieve/conceptual-fallback.js'
import { searchSourceBodies, searchSourceBodyQuestions, sourceDiagnosticAdmissionsKey, sourceDiagnosticAlternativesKey, sourceDiagnosticClauseEvidence, sourceBodyWords, sourceQueryLiterals, sourceQueryWithoutLiteralSpans, type SourceBodyMatch } from '../../src/runtime/retrieve/source-evidence.js'
import { sourceExecutableWitnesses } from '../../src/runtime/retrieve/source-executable-witnesses.js'
import { sourceDiagnosticQueries, sourceDiagnosticSeeds, sourceDiagnosticCandidatePool, sourceDiagnosticContextsKey, sourceDiagnosticDecisionsKey, type SourceDiagnosticClauseMatches } from '../../src/runtime/retrieve/source-diagnostic-priority.js'
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


function languageFixture(distractors = 0) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-source-language-')))
  roots.push(root)
  const targetFile = join(root, 'lease.ts'), fakeFile = join(root, 'lease.test.ts'), noiseFile = join(root, 'noise.ts')
  const source = [
    'export function finish(nowMs: number, lifetime: number, handle: string) {',
    '  const expiresAtMs = nowMs + lifetime;',
    '  if (!validate(handle)) throw new Error("denied");',
    '  return expiresAtMs;',
    '}',
  ].join('\n')
  writeFileSync(targetFile, source)
  writeFileSync(fakeFile, 'export function simulate(lifetime: number, handle: string) { const expiresAtMs = lifetime; if (!validate(handle)) throw Error("bucket operation selection current state"); return expiresAtMs; }')
  writeFileSync(noiseFile, Array.from({ length: distractors }, (_, index) =>
    `export function topic${index}() { return "bucket operation selection current state lifetime"; }`).join('\n'))
  const extracted = [targetFile, fakeFile, noiseFile].map(file => extractJs(file))
  const graph = buildFromJson({ schema_version: 1, nodes: extracted.flatMap(value => value.nodes), edges: extracted.flatMap(value => value.edges) }, { directed: true })
  graph.graph.root_path = root
  const target = graph.nodeEntries().find(([, node]) => node.label === 'finish()')![0]
  const fake = graph.nodeEntries().find(([, node]) => node.label === 'simulate()')![0]
  return { root, graph, target, fake, targetFile, source }
}

function headingFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-source-heading-')))
  roots.push(root)
  const file = join(root, 'lease.ts'), noiseFile = join(root, 'lease-operations.ts'), fakeFile = join(root, 'lease.test.ts')
  const vocabulary = 'lease operations expiration checked lifetime validation errors handles'
  const source = [
    'export class LeaseOperations {',
    `  describe() { return "${vocabulary}"; }`,
    '  issue(lifetime: number, handle: string) {',
    '    const expiresAtMs = lifetime;',
    '    if (!validate(handle)) throw new Error("denied");',
    '    return expiresAtMs;',
    '  }',
    '  inspect(lifetime: number, handle: string) {',
    '    const expiresAtMs = lifetime;',
    '    if (!validate(handle)) throw new Error("refused");',
    '    return expiresAtMs;',
    '  }',
    '}',
  ].join('\n')
  writeFileSync(file, source)
  writeFileSync(noiseFile, Array.from({ length: 140 }, (_, index) =>
    `export function noise${index}() { return "${vocabulary} ${'unrelated '.repeat(30)}"; }`).join('\n'))
  writeFileSync(fakeFile, source.replace('LeaseOperations', 'TestLeaseOperations'))
  const extracted = [file, noiseFile, fakeFile].map(path => extractJs(path))
  const graph = buildFromJson({ schema_version: 1, nodes: extracted.flatMap(value => value.nodes), edges: extracted.flatMap(value => value.edges) }, { directed: true })
  graph.graph.root_path = root
  const id = (label: string, path = file) => graph.nodeEntries().find(([, node]) => node.label === label && node.source_file === path)![0]
  return { root, file, source, graph, head: id('.describe()'), first: id('.issue()'), second: id('.inspect()'), fake: id('.issue()', fakeFile) }
}

const match: SourceBodyMatch = { score: 2, exact_literal: false, coverage: 1, relevance: 1, matched_literals: [], lines: [9] }
describe('diagnostic current-source priority', () => {
  it('requires runtime or own-name primary families before contextual nomination', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-runtime-clause-')))
    roots.push(root)
    const file = join(root, 'lease.ts')
    writeFileSync(file, [
      'export class LeaseOperations {',
      '  validateClient(input: unknown): asserts input is ToolHandle { use(input); }',
      '  forward(input: unknown): ToolResult { return handle(input); }',
      '  inspect(handle: string) { if (!validate(handle)) throw Error("denied"); return handle; }',
      '  expiry(lifetime: number) { const expiresAtMs = lifetime; return expiresAtMs; }',
      '}',
      'export class Lease {',
      '  decide(lifetime: number, handle: string, assertion: any) {',
      '    const expiresAtMs = Math.min(lifetime, assertion.expiration);',
      '    if (!validate(handle)) throw Error("denied");',
      '    return expiresAtMs;',
      '  }',
      '}',
    ].join('\n'))
    const extracted = extractJs(file)
    const graph = buildFromJson({ schema_version: 1, nodes: extracted.nodes, edges: extracted.edges }, { directed: true })
    graph.graph.root_path = root
    const id = (label: string) => graph.nodeEntries().find(([, node]) => node.label === label)![0]
    const full = 'Trace lease operations client validation assertions tool handle expiration lifetime error'
    const clauses = ['validation assertions', 'tools handles', 'expiration lifetime handles', 'errors handles']
    let inspections = 0
    const run = searchSourceBodyQuestions(graph, [full, ...clauses], root, undefined, {
      contexts: clauses.map(() => 'lease operations'), allowedOwner: () => { inspections++; return true },
    })
    const ordinary = searchSourceBodies(graph, full, root)
    expect(ordinary.matches.has(id('.inspect()'))).toBe(true) // The unchanged raw-positive guard is a fixture premise.
    expect([...run[0]!.matches]).toEqual([...ordinary.matches])
    const alternatives = run[0]![sourceDiagnosticAlternativesKey]!
    expect(alternatives[0]).toContain(id('.decide()'))
    expect(alternatives[0]).not.toContain(id('.validateClient()')) // asserts occurs only in the return type.
    expect(alternatives[1]).not.toContain(id('.forward()')) // ToolResult is not runtime tool evidence.
    expect(alternatives[2]).toEqual([id('.expiry()'), id('.decide()')]) // Specific heading and lexical alternatives coexist; family count is eligibility only.
    expect(alternatives[3]).toContain(id('.inspect()'))
    expect(inspections).toBeLessThanOrEqual(32)
    const evidence = sourceDiagnosticClauseEvidence(run[1]!.matches)!
    const declaration = evidence.owners.get(id('.validateClient()'))!
    expect(declaration.nameFamilies).toContain('@stem:valid')
    expect(declaration.witnesses.flatMap(witness => witness.families)).not.toContain('@stem:assert')
    expect(sourceDiagnosticClauseEvidence(new Map(run[1]!.matches))).toBeUndefined()
    expect(sourceDiagnosticClauseEvidence(searchSourceBodyQuestions(graph, [full, ...clauses], root, undefined, { allowedOwner: () => true })[1]!.matches)).toBeUndefined()
  })

  it('preserves exhaustive runtime defaults and destructuring with one shared traversal budget', () => {
    const text = [
      'function inspect(input: ToolResult = openHandle(), { issuer: renamed, subject } = context) {',
      '  // validation assertions are not executable evidence',
      '  const [binding] = values;',
      '  return { [key()](value = defaultHandle()) { return validate(value); } };',
      '  const pattern = /tenant|audience/;',
      '  class Derived extends validateTenantAudience() implements TypeOnly {}',
      '  const specialized = resolve<SignatureOnly>;',
      '}',
    ].join('\n')
    const source = ts.createSourceFile('runtime.ts', text, ts.ScriptTarget.Latest, true)
    const declaration = source.statements[0] as ts.FunctionDeclaration
    const words = (value: string) => [...new Set(sourceBodyWords(value).filter(Boolean))]
    const budget = { visited: 0, maxNodes: 100_000, exhausted: false }
    const evidence = sourceExecutableWitnesses(declaration, source, budget, words, () => true)!
    const runtime = new Set(evidence.witnesses.flatMap(witness => witness.families))
    for (const term of ['open', 'handle', 'issuer', 'subject', 'key', 'default', 'validate', 'tenant', 'audience']) expect(runtime).toContain(term)
    for (const term of ['tool', 'result', 'renamed', 'binding', 'validation', 'assertions', 'type', 'signature', 'only']) expect(runtime).not.toContain(term)
    expect(evidence.completeOwner).toBe(true)
    expect(evidence.witnesses.some(witness => text.slice(witness.start, witness.end) === 'openHandle')).toBe(true)
    for (const expression of ['validateTenantAudience', 'resolve']) {
      expect(evidence.witnesses.some(witness => text.slice(witness.start, witness.end) === expression)).toBe(true)
    }
    expect(sourceExecutableWitnesses(declaration, source, { visited: 0, maxNodes: 100_000, exhausted: false }, words, line => line !== 4)?.completeOwner).toBe(false)
    const limited = { visited: 0, maxNodes: 2, exhausted: false }
    expect(sourceExecutableWitnesses(declaration, source, limited, words, () => true)).toBeUndefined()
    expect(limited.exhausted).toBe(true)
    expect(sourceExecutableWitnesses(declaration, source, limited, words, () => true)).toBeUndefined()
  })

  it('normalizes only optional diagnostic words, retaining literal identity and raw matches', () => {
    const value = languageFixture(), full = 'Explain lifetime', clauses = ['expiration', 'validation errors for handles', 'expiry']
    const ordinary = searchSourceBodies(value.graph, full, value.root)
    const raw = searchSourceBodyQuestions(value.graph, [full, ...clauses], value.root)
    const normalized = searchSourceBodyQuestions(value.graph, [full, ...clauses], value.root, undefined, { allowedOwner: () => true })
    expect([...normalized[0]!.matches]).toEqual([...ordinary.matches])
    expect(raw[1]!.matches.has(value.target)).toBe(false)
    expect(raw[2]!.matches.has(value.target)).toBe(false)
    expect(normalized[1]!.matches.get(value.target)?.score).toBe(0.5)
    expect(normalized[2]!.matches.get(value.target)?.score).toBe(1.5)
    expect(normalized[2]!.matches.get(value.target)?.exact_literal).toBe(false)
    expect(normalized[3]!.matches.has(value.target)).toBe(false) // Standard Porter does not equate expiry and expires.
    expect(sourceBodyWords('validateErrors expiresAtMs')).toEqual(['validate', 'errors', 'expires', 'at', 'ms'])
    const literalQueries = [full, '"validation"', 'errors for handles']
    const literalRaw = searchSourceBodyQuestions(value.graph, literalQueries, value.root)
    const literalOptional = searchSourceBodyQuestions(value.graph, literalQueries, value.root, undefined, { allowedOwner: () => true })
    expect(literalOptional).toEqual(literalRaw)
    expect(literalOptional[1]!.matches.has(value.target)).toBe(false)
    const repeated = `${'errors '.repeat(40)}validation handles`
    const repeatedResult = searchSourceBodyQuestions(value.graph, [full, repeated, 'expiration'], value.root, undefined, { allowedOwner: () => true })
    expect(repeatedResult[1]!.matches.get(value.target)?.score).toBe(1.5)
  })

  it('removes only diagnostic framing votes and preserves authored clauses and code colons', () => {
    const text = 'In the Sample source, trace lease operations: how expiration is bounded by lifetime; validation errors for handles. Find relevant configuration limits and tests if available.'
    expect(sourceDiagnosticQueries(text)).toEqual(['how expiration is bounded by lifetime', 'validation errors for handles'])
    expect(sourceDiagnosticQueries(text)[sourceDiagnosticContextsKey]).toEqual(['lease operations', 'lease operations'])
    expect(querySourceEvidenceClauses(text)[0]).toBe('In the Sample source')
    expect(sourceDiagnosticQueries('In the Sample source, explain expiration checks; validation errors for handles. Use tests if helpful.'))
      .toEqual(['explain expiration checks', 'validation errors for handles'])
    expect(sourceDiagnosticQueries('Trace the stream: pending messages; rejected updates.'))
      .toEqual(['Trace the stream: pending messages', 'rejected updates'])
    expect(sourceDiagnosticQueries('Trace pending work; configuration limits reject bad values.'))
      .toContain('configuration limits reject bad values')
    expect(sourceDiagnosticQueries('Trace "topic: how validation works"; expiration errors.')).toEqual([])
    expect(sourceDiagnosticQueries('Trace “lease operations”: how expiration is bounded; validation errors for handles.')[sourceDiagnosticContextsKey]).toBeUndefined()
    expect(sourceDiagnosticQueries('Trace inspect({ topic: how }); expiration errors.')).toEqual([])
    expect(sourceDiagnosticQueries('Trace expiration errors; include failing tests.')).toEqual([])
    expect(sourceDiagnosticQueries('Explain class Parser: how requests arrive; why requests fail.')).toEqual([])
    expect(sourceDiagnosticQueries('Find functions In and Out; explain validation errors.')).toEqual([])
    expect(sourceDiagnosticQueries('Find Parser and Client; explain validation errors.')).toEqual([])
    expect(sourceDiagnosticQueries('Find In and Out; explain validation errors.')).toEqual([])
    expect(sourceDiagnosticQueries('  Where can I find Parser and Client; explain validation errors.')).toEqual([])
    expect(sourceDiagnosticQueries('Explain Parser: how requests arrive; why requests fail.')).toEqual([])
    const separate = sourceDiagnosticQueries('Trace lease operations: how expiration is bounded; validation errors for handles. Also explain mail delivery errors; failed delivery attempts.')
    expect(separate[sourceDiagnosticContextsKey]).toEqual(['lease operations', 'lease operations', '', ''])
    expect(sourceDiagnosticQueries('Trace expiration errors; validation errors for handles.')[sourceDiagnosticContextsKey]).toBeUndefined()
  })

  it('uses current declaration context and outside-head seats for supported clause alternatives', () => {
    const value = headingFixture()
    const full = 'Trace lease operations: how expiration is checked against lifetime; validation errors for handles.'
    const clauses = sourceDiagnosticQueries(full), ordinary = searchSourceBodies(value.graph, full, value.root)
    expect(ordinary.matches.size).toBe(128)
    expect([...ordinary.matches.keys()].slice(0, 125)).toContain(value.head)
    for (const id of [value.first, value.second]) expect(ordinary.matches.has(id)).toBe(false)
    const run = (allowedOwner = (_file: string, _canonical: string, _label: string, _text: string) => true) =>
      searchSourceBodyQuestions(value.graph, [full, ...clauses], value.root, undefined, { contexts: clauses[sourceDiagnosticContextsKey]!, allowedOwner })
    const searches = run(), admitted = searches[0]!, nominations = admitted[sourceDiagnosticAdmissionsKey] ?? []
    expect(nominations).toEqual(expect.arrayContaining([value.first, value.second]))
    expect(nominations).not.toContain(value.head)
    expect(nominations).not.toContain(value.fake)
    expect(nominations.length).toBeLessThanOrEqual(3)
    expect(admitted.matches.size).toBe(128)
    expect([...admitted.matches.keys()].slice(0, 125)).toEqual([...ordinary.matches.keys()].slice(0, 125))
    for (const [id, match] of ordinary.matches) if (admitted.matches.has(id)) expect(admitted.matches.get(id)).toEqual(match)
    expect(admitted.matches.get(value.first)?.score).toBe(0.5)
    const alternatives = admitted[sourceDiagnosticAlternativesKey]!
    expect(alternatives.flat()).toContain(value.head)
    expect(alternatives.every(ids => ids.length <= 3)).toBe(true)
    expect(alternatives.flat()).not.toContain(value.fake)
    expect(sourceDiagnosticCandidatePool([...admitted.matches.keys()].map(id => ({ id })), nominations, alternatives)).toHaveLength(32)
    expect(JSON.stringify(admitted)).not.toContain('sourceDiagnosticAlternatives')
    expect(run(file => file !== value.file)[0]![sourceDiagnosticAdmissionsKey] ?? []).not.toContain(value.first)
    writeFileSync(value.file, value.source.replace('  issue(', '  renamed('))
    expect(run()[0]![sourceDiagnosticAdmissionsKey] ?? []).not.toContain(value.first)
    writeFileSync(value.file, value.source)
    value.graph.addNode('duplicate_issue', { ...value.graph.nodeAttributes(value.first) })
    expect(run()[0]![sourceDiagnosticAdmissionsKey] ?? []).not.toContain(value.first)
  })

  it('keeps authored round-robin decisions separate from the three dependency roots', () => {
    const value = fixture()
    const configure = value.candidates.find(node => node.label === 'configure()')!
    const alternatives = [
      [value.consume.id, value.startup.id, configure.id],
      [value.reject.id, value.begin.id, value.startup.id],
      [value.begin.id, configure.id],
      [value.reject.id, value.consume.id],
    ]
    const clauses: SourceDiagnosticClauseMatches = Object.assign(alternatives.map(ids => new Map(ids.map(id => [id, match]))), {
      [sourceDiagnosticAlternativesKey]: alternatives,
    })
    const candidates = [...value.candidates, value.reject]
    const seeds = sourceDiagnosticSeeds(candidates, clauses, () => true, value.root)
    expect(seeds.length).toBeLessThanOrEqual(3)
    expect(seeds[sourceDiagnosticDecisionsKey]).toEqual([value.consume.id, value.reject.id, value.begin.id, value.startup.id, configure.id])
    const excluded = sourceDiagnosticSeeds(candidates, clauses, (_, label) => label !== '.reject()', value.root)
    expect(excluded[sourceDiagnosticDecisionsKey]).not.toContain(value.reject.id)
    const missing = sourceDiagnosticSeeds(candidates.filter(node => node.id !== configure.id), clauses, () => true, value.root)
    expect(missing[sourceDiagnosticDecisionsKey]).not.toContain(configure.id)
    const rescued = Object.assign(clauses.slice(), {
      [sourceDiagnosticAlternativesKey]: alternatives,
      [sourceDiagnosticAdmissionsKey]: [configure.id, value.simulate.id, value.begin.id],
    })
    const prioritized = sourceDiagnosticSeeds(candidates, rescued, () => true, value.root)
    expect(prioritized[sourceDiagnosticDecisionsKey]).toEqual([configure.id, value.begin.id, value.consume.id, value.reject.id, value.startup.id])
    const refusedRescue = sourceDiagnosticSeeds(candidates, rescued, (_, label) => label !== 'configure()', value.root)
    expect(refusedRescue[sourceDiagnosticDecisionsKey]).not.toContain(configure.id)
    expect(refusedRescue[sourceDiagnosticDecisionsKey]).not.toContain(value.simulate.id) // No clause decision can be manufactured by the rescue list.
  })

  it('admits at most three current executable clause owners inside the raw128 and diagnostic32 caps', () => {
    const value = languageFixture(140)
    const full = 'Trace bucket operation selection current state; how expiration is checked against lifetime; validation errors for handles.'
    const clauses = sourceDiagnosticQueries(full), ordinary = searchSourceBodies(value.graph, full, value.root)
    expect(ordinary.matches.size).toBe(128)
    expect(ordinary.matches.has(value.target)).toBe(false)
    const searches = searchSourceBodyQuestions(value.graph, [full, ...clauses], value.root, undefined, { allowedOwner: () => true })
    const admitted = searches[0]!, nominations = admitted[sourceDiagnosticAdmissionsKey] ?? []
    expect(nominations).toContain(value.target)
    expect(nominations).not.toContain(value.fake)
    expect(nominations.length).toBeLessThanOrEqual(3)
    expect(admitted.matches.size).toBe(128)
    expect([...admitted.matches.keys()].slice(0, 125)).toEqual([...ordinary.matches.keys()].slice(0, 125))
    for (const [id, match] of ordinary.matches) if (admitted.matches.has(id)) expect(admitted.matches.get(id)).toEqual(match)
    expect(admitted.matches.get(value.target)?.score).toBe(0.5) // Only raw lifetime matched; stem coverage is not copied.
    const pool = sourceDiagnosticCandidatePool([...ordinary.matches.keys(), value.target].map(id => ({ id })), nominations)
    expect(pool).toHaveLength(32)
    expect(pool.map(node => node.id)).toContain(value.target)
    expect(Object.keys(admitted)).not.toContain(String(sourceDiagnosticAdmissionsKey))
    expect(JSON.stringify(admitted)).not.toContain('sourceDiagnosticAdmissions')
  })

  it('declines excluded, stale, malformed and duplicate declaration nominations', () => {
    const value = languageFixture(140), full = 'Trace bucket operation selection current state; expiration lifetime; validation errors handles.'
    const queries = [full, ...sourceDiagnosticQueries(full)]
    const run = (allowedOwner: (file: string, canonical: string, label: string, text: string) => boolean = () => true) =>
      searchSourceBodyQuestions(value.graph, queries, value.root, undefined, { allowedOwner })[0]![sourceDiagnosticAdmissionsKey] ?? []
    expect(run((file, canonical, label, text) => file !== value.targetFile && canonical !== value.targetFile && !text.includes('expiresAtMs'))).not.toContain(value.target)
    writeFileSync(value.targetFile, value.source.replace('function finish', 'function changed'))
    expect(run()).not.toContain(value.target)
    writeFileSync(value.targetFile, value.source.replace('return expiresAtMs;', 'return (expiresAtMs;'))
    expect(run()).not.toContain(value.target)
    writeFileSync(value.targetFile, value.source)
    value.graph.addNode('duplicate_finish', { ...value.graph.nodeAttributes(value.target) })
    expect(run()).not.toContain(value.target)
    expect(run()).not.toContain('duplicate_finish')
  })

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
