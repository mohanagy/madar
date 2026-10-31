import { sliceCandidatesForRetrieve } from '../../src/runtime/retrieve/slicing.js'
import { extractPromptExclusions } from '../../src/runtime/retrieval-gate.js'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { retrieveContext, retrieveContextAsync, readQueryEvidenceSnippet, withRetrieveSnippetBudget } from '../../src/runtime/retrieve.js'
import { interpretRetrievalQuery } from '../../src/runtime/retrieve/pipeline.js'
import { coherentSourceSnippet, searchSourceBodies, searchSourceBodyQuestions, sourceDeclarationQualifiedName, sourceDeclarationKind, sourceRangeMatchesSymbol, resolveSourceSymbolRange, sourceQueryIsLiteralLookup, sourceQueryRequestsClauseLocations, sourceQueryLiterals, sourceQueryWithoutLiteralSpans } from '../../src/runtime/retrieve/source-evidence.js'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); vi.doUnmock('../../src/runtime/semantic.js') })

function workspace(prefix = 'madar-source-evidence-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  mkdirSync(join(root, 'src'))
  const handler = join(root, 'src', 'handler.ts')
  const metrics = join(root, 'src', 'metrics.ts')
  writeFileSync(handler, [
    'export function processRequest(record: { issuedAt: number; allowed: boolean }) {',
    '  if (!record.allowed) throw new Error("ACCESS_DENIED");',
    '  const elapsed = Date.now() - record.issuedAt;',
    '  if (elapsed > 900000) throw new Error("SESSION_EXPIRED");',
    '  return { status: 200 };',
    '}',
  ].join('\n'))
  writeFileSync(metrics, [
    'export function recordSessionExpiredMetric(counter: Map<string, number>) {',
    '  counter.set("expired", (counter.get("expired") ?? 0) + 1);',
    '}',
    'export function describeSessionExpiration() {',
    '  return "Historical count of expired sessions";',
    '}',
  ].join('\n'))
  const fragments = [handler, metrics].map(extractJs)
  const graph = buildFromJson({ schema_version: 1, nodes: fragments.flatMap((f) => f.nodes), edges: fragments.flatMap((f) => f.edges) }, { directed: true })
  graph.graph.root_path = root
  return { root, handler, metrics, graph }
}

describe('source evidence retrieval', () => {
  it('keeps project framing lexical so incidental brand literals cannot exhaust behavior admission', () => {
    const { graph, root } = workspace()
    const path = join(root, 'src', 'reservations.ts')
    writeFileSync(path, [
      ...Array.from({ length: 130 }, (_, index) => `export function banner${index}() { return "LedgerGarden"; }`),
      'export function settleReservation(attempt: { status: string; credit: number }) {',
      '  // Refund a reservation credit and persist durable attempt state exactly once.',
      '  if (attempt.status === "reserved") { attempt.status = "refunded"; attempt.credit += 1; }',
      '  return attempt;',
      '}',
    ].join('\n'))
    const extraction = extractJs(path)
    for (const node of extraction.nodes) graph.addNode(node.id, node)
    const owner = extraction.nodes.find(node => node.label === 'settleReservation()')!.id
    const question = 'In the LedgerGarden source, trace reservation credit refund and durable attempt state.'
    const [behavior, explicit] = searchSourceBodyQuestions(graph, [question, 'Where is `LedgerGarden` used?'], root)
    expect(behavior!.matches.has(owner)).toBe(true)
    expect(behavior!.matches.get(owner)?.exact_literal).toBe(false)
    expect(behavior!.matches.size).toBe(128)
    expect(behavior!.bounded).toBe(true)
    expect(explicit!.matches.has(owner)).toBe(false)
    expect(explicit!.matches.size).toBe(128)
    expect([...explicit!.matches.values()].every(match => match.exact_literal)).toBe(true)
    expect(sourceQueryLiterals(question)).toEqual([])
    expect(sourceQueryWithoutLiteralSpans(question)).toBe(question)
    expect(sourceQueryLiterals('In LedgerGarden repository, find the refund implementation.')).toEqual([])
    for (const protectedQuestion of [
      'In the `LedgerGarden` source, trace refunds.',
      '"In the LedgerGarden source, trace refunds."',
      '```text\nIn the LedgerGarden source, trace refunds.\n```',
      'In the LedgerGarden() source, trace refunds.',
      'In the src/LedgerGarden.ts source, trace refunds.',
      'In the LedgerGarden source, trace LedgerGarden() and its callers.',
      'Find the LedgerGarden implementation.',
      'In the LedgerGarden source trace refunds.',
    ]) expect(sourceQueryLiterals(protectedQuestion), protectedQuestion).toContain('LedgerGarden')
  })

  it('consumes matching quote spans without manufacturing literals between short or malformed values', () => {
    expect(sourceQueryLiterals("'' 'i' \"\" \"g\" `` 'useful value' \"second value\""))
      .toEqual(['useful value', 'second value'])
    expect(sourceQueryLiterals("Find 'say \"hello\"' and \"it's ready\"."))
      .toEqual(['say "hello"', "it's ready"])
    const escaped = String.raw`Keep "say \"hello\"" and 'can\'t fail' then tail.`
    expect(sourceQueryLiterals(escaped)).toEqual([String.raw`say \"hello\"`, String.raw`can\'t fail`])
    expect(sourceQueryWithoutLiteralSpans(escaped)).toBe(escaped
      .replace(String.raw`"say \"hello\""`, value => ' '.repeat(value.length))
      .replace(String.raw`'can\'t fail'`, value => ' '.repeat(value.length)))
    expect(sourceQueryLiterals("The user's flags aren't markers; clients' values stay; inspect 'real value'."))
      .toEqual(['real value'])
    for (const prefix of ['r', 'U', 'b', 'f', 't', 'br', 'Rb', 'fr', 'rF', 'tr', 'Rt', 'N', 'E']) {
      const prefixed = `Find ${prefix}'error text'.`
      expect(sourceQueryLiterals(prefixed), prefix).toEqual(['error text'])
      expect(sourceQueryWithoutLiteralSpans(prefixed), prefix).toBe(prefixed.replace("'error text'", ' '.repeat(12)))
    }
    expect(sourceQueryLiterals("The user's flags aren't markers; other'ignored text' ownern'ignored text' _r'ignored text' αr'ignored text' precede 'real value'."))
      .toEqual(['real value'])
    expect(sourceQueryLiterals('Inspect "unterminated \'pretend\'\nthen \'real value\'.'))
      .toEqual(['real value'])
    expect(sourceQueryLiterals(`"${'x'.repeat(161)}" then "real value"`)).toEqual(['real value'])
    expect(sourceQueryLiterals("' a ' 'ab' \"" + 'x'.repeat(160) + '"'))
      .toEqual(['ab', 'x'.repeat(160)])
    const fenced = ['```js', "const value = 'inside';", 'const flag = "";', '```', "After 'outside'.",
      '~~~js', 'const value = `template value`;', '~~~'].join('\n')
    expect(sourceQueryLiterals(fenced)).toEqual(['inside', 'outside', 'template value'])
    for (const newline of ['\n', '\r\n']) {
      const continued = ['```js', 'const first = "long\\', 'continued"; const second = "real value";', '```'].join(newline)
      expect(sourceQueryLiterals(continued)).toEqual(['real value'])
    }
    expect(sourceQueryLiterals("Inspect `read('inside')` and 'outside'."))
      .toEqual(["read('inside')", 'outside'])
    expect(sourceQueryLiterals('Inspect ``code `with` "quotes"``.')).toEqual(['code `with` "quotes"'])
    const positions = "α 🙂 '' 'x' then 'value' stays value"
    expect(sourceQueryWithoutLiteralSpans(positions)).toBe(positions.replace("'value'", ' '.repeat(7)))
    expect(sourceQueryWithoutLiteralSpans(positions).length).toBe(positions.length)
    expect(sourceQueryLiterals('APP_ERROR userValue snake_case #slot /api/user/path'))
      .toEqual(['APP_ERROR', 'userValue', 'snake_case', '/api/user/path', '#slot'])
    expect(sourceQueryLiterals(Array.from({ length: 10 }, (_, index) => `"literal ${index}"`).join(' ')))
      .toEqual(Array.from({ length: 8 }, (_, index) => `literal ${index}`))
  })

  it('preserves complete path lexemes without manufacturing slash-list suffix literals', () => {
    for (const question of [
      'Explain matching issuer/subject/audience/chat and time boundaries.',
      'Compare read/write/execute permissions and success/failure/retry outcomes.',
    ]) {
      expect(sourceQueryLiterals(question), question).toEqual([])
      expect(sourceQueryWithoutLiteralSpans(question), question).toBe(question)
    }
    const paths = [
      ['Explain /api/user/path behavior.', '/api/user/path'],
      ['Explain src/auth/service.ts behavior.', 'src/auth/service.ts'],
      [String.raw`Explain C:\src\auth\service.ts behavior.`, String.raw`C:\src\auth\service.ts`],
      ['Explain ./src/auth behavior.', './src/auth'],
      ['Explain ../src/auth behavior.', '../src/auth'],
      ['Explain https://example.test/api/user/path behavior.', 'https://example.test/api/user/path'],
      ['src/auth', 'src/auth'],
      ['Find src/auth', 'src/auth'],
      ['Locate directory src/auth', 'src/auth'],
      ['Find "issuer/subject/audience/chat".', 'issuer/subject/audience/chat'],
    ] as const
    for (const [question, path] of paths) {
      expect(sourceQueryLiterals(question), question).toEqual([path])
      expect(sourceQueryLiterals(question), question).not.toContain('/subject/audience/chat')
      const quoted = question.includes(`"${path}"`) ? `"${path}"` : path
      expect(sourceQueryWithoutLiteralSpans(question), question)
        .toBe(question.replace(quoted, ' '.repeat(quoted.length)))
    }
    expect(interpretRetrievalQuery({ question: 'Explain src/auth/service.ts behavior.', budget: 1000 })
      .retrieval_gate.signals.mentioned_paths).toContain('src/auth/service.ts')
  })

  it('verifies concrete constructor source and retains range and ownership ambiguity checks', () => {
    const lines = ['class Repository {', '  constructor(value: string);', '  constructor(public value: string) {', '    this.value = value;', '  }', '}']
    const range = { start: 3, end: 5 }
    expect(sourceRangeMatchesSymbol(lines, range, '.constructor()', 'source.ts')).toBe(true)
    expect(sourceDeclarationKind(lines, range, '.constructor()', 'source.ts')).toBe('function')
    expect(sourceDeclarationQualifiedName(lines, range, '.constructor()', 'source.ts')).toBe('Repository.constructor')
    expect(resolveSourceSymbolRange(lines, { start: 3, end: 3 }, '.constructor()', 'source.ts')).toEqual(range)
    expect(sourceRangeMatchesSymbol(lines, { start: 2, end: 5 }, '.constructor()', 'source.ts')).toBe(false)
    expect(sourceRangeMatchesSymbol(lines, { start: 4, end: 5 }, '.constructor()', 'source.ts')).toBe(false)
    expect(sourceDeclarationQualifiedName(['class First { constructor() {} } class Second { constructor() {} }'], { start: 1, end: 1 }, '.constructor()', 'source.ts')).toBeUndefined()
  })

  it('uses the source word vocabulary for markup and digit-camel query terms', () => {
    const { graph, root } = workspace()
    const path = join(root, 'src/gauge.ts')
    writeFileSync(path, 'export function drawGauge(cache2State: number) {\n  return `<meter>${cache2State}</meter>`;\n}\n')
    const extraction = extractJs(path)
    for (const node of extraction.nodes) graph.addNode(node.id, node)
    const owner = extraction.nodes.find(node => node.label === 'drawGauge()')!.id
    for (const question of ['Which source produces the <meter> element?', 'Describe cache2State restoration after restart.']) {
      expect(searchSourceBodies(graph, question, root).matches.has(owner)).toBe(true)
    }
  })

  it('refuses ambiguous or parser-recovered qualified ownership', () => {
    const ambiguous = ['class First { run() {} } class Second { run() {} }']
    for (const label of ['First.run()', 'Second.run()', '.run()']) {
      expect(sourceDeclarationQualifiedName(ambiguous, { start: 1, end: 1 }, label, 'source.ts')).toBeUndefined()
    }
    expect(sourceDeclarationQualifiedName(['class First { run() {} }'], { start: 1, end: 1 }, '.run()', 'source.ts')).toBe('First.run')
    expect(sourceDeclarationQualifiedName(['class First { run() {}'], { start: 1, end: 1 }, '.run()', 'source.ts')).toBeUndefined()
  })

  it('keeps literal and behavior matching independent when source scans are batched', () => {
    const { graph, root, handler } = workspace()
    graph.addNode('zz_synthetic_route', { label: '/unrelated', node_kind: 'route', file_type: 'code',
      source_file: handler, source_location: 'L1-L6' })
    const [literal, behavior, empty] = searchSourceBodyQuestions(graph, ['Where is `ACCESS_DENIED` thrown?', 'Historical count', ''], root)
    expect([...literal!.matches.keys()]).toEqual(['handler_processrequest'])
    expect(literal!.matches.get('handler_processrequest')?.exact_literal).toBe(true)
    expect([...behavior!.matches.keys()]).toEqual(['metrics_describesessionexpiration'])
    expect(behavior!.matches.get('metrics_describesessionexpiration')?.exact_literal).toBe(false)
    expect(empty).toEqual({ matches: new Map(), scanned_files: 0, scanned_bytes: 0, bounded: false })
  })

  it('uses positive indexed literals to navigate the file cap without trusting stale hints', () => {
    const { graph, root } = workspace()
    const add = (name: string, body: string, snippet?: string) => {
      const path = join(root, 'src', `${name}.ts`)
      writeFileSync(path, body)
      graph.addNode(name, { label: 'value()', file_type: 'code', source_file: path,
        source_location: 'L1', ...(snippet ? { snippet } : {}) })
      return realpathSync(path)
    }
    for (let index = 1023; index >= 0; index--) {
      add(`a${String(index).padStart(4, '0')}`, 'export function value() { return 0; }')
    }
    const stale = add('z-stale', 'export function value() { return "removed"; }', 'return "READY_SIGNAL";')
    const target = add('z-target', 'export function value() { return "READY_SIGNAL"; }', 'return "READY_SIGNAL";')
    const prefix = add('z-prefix', 'export function value() { return "READY_SIGNAL"; }', 'return "READY_SIGNAL_EXTRA";')
    const excluded = add('z-excluded', 'export function value() { return "AVOID_SIGNAL"; }', 'return "AVOID_SIGNAL";')
    const oversized = add('z-oversized', ' '.repeat(300 * 1024), 'return "READY_SIGNAL";')
    const cache = new Map<string, string[] | null>()
    const result = searchSourceBodies(graph, 'Where is "READY_SIGNAL" thrown? Exclude "AVOID_SIGNAL".', root, cache)
    expect(result.scanned_files).toBe(1024)
    expect(result.scanned_bytes).toBeLessThan(16 * 1024 * 1024)
    expect(result.bounded).toBe(true)
    expect([...result.matches.keys()]).toEqual(['z-target'])
    expect(result.matches.get('z-target')?.exact_literal).toBe(true)
    expect([...cache.keys()].slice(0, 2)).toEqual([stale, target])
    for (const path of [prefix, excluded, oversized]) expect(cache.has(path), path).toBe(false)
  })

  it('ranks concentrated source evidence above vocabulary scattered through a large owner', () => {
    const { graph, root } = workspace()
    const files = {
      'compact.ts': 'export function receipt(invoice: any) {\n  return invoice.confirmation ? invoice.refund : null;\n}',
      'large.ts': [
        'export function dashboard() {',
        '  // invoice confirmation refund cancellation retries errors',
        '  let padding = 0;',
        ...Array.from({ length: 180 }, (_, index) => `  padding = padding + ${index};`),
        '  return padding;',
        '}',
      ].join('\n'),
      'controls.ts': Array.from({ length: 16 }, (_, index) => `export function control${index}() { return ${index}; }`).join('\n'),
    }
    for (const [name, text] of Object.entries(files)) {
      const path = join(root, 'src', name)
      writeFileSync(path, text)
      for (const node of extractJs(path).nodes) graph.addNode(node.id, node)
    }
    const question = 'Explain invoice confirmation refund cancellation retries errors.'
    const result = searchSourceBodies(graph, question, root)
    const compact = result.matches.get('compact_receipt')!
    const large = result.matches.get('large_dashboard')!
    expect(compact.coverage).toBeLessThan(large.coverage)
    expect(compact.relevance).toBeGreaterThan(large.relevance!)
    expect([...result.matches.keys()][0]).toBe('compact_receipt')
    // Batching another query changes neither corpus length nor this query's rank.
    const [batched] = searchSourceBodyQuestions(graph, [question, 'Historical count'], root)
    expect(batched!.matches.get('compact_receipt')).toEqual(compact)
    expect(batched!.matches.get('large_dashboard')).toEqual(large)
  })

  it('distinguishes static module navigation from executable file evidence', () => {
    const { graph, root } = workspace()
    const files = {
      'navigation.ts': ['import {', '  computeMonthlyRevenue,', '} from "./revenue";', 'export { computeMonthlyRevenue } from "./revenue";'].join('\n'),
      'top-level.ts': 'import { computeMonthlyRevenue } from "./revenue";\ncomputeMonthlyRevenue();',
      'same-line.ts': 'import { computeMonthlyRevenue } from "./revenue"; computeMonthlyRevenue();',
      'assignment.ts': 'export default computeMonthlyRevenue();',
    }
    for (const [name, text] of Object.entries(files)) {
      const path = join(root, 'src', name)
      writeFileSync(path, text)
      for (const node of extractJs(path).nodes) graph.addNode(node.id, node)
    }
    const matches = (question: string) => new Map([...searchSourceBodies(graph, question, root).matches]
      .map(([id, match]) => [graph.nodeAttributes(id).label, match]))
    const behavior = matches('How is monthly revenue computed?')
    expect(behavior.get('navigation.ts')?.navigation_only).toBe(true)
    for (const label of ['top-level.ts', 'same-line.ts', 'assignment.ts']) {
      expect(behavior.get(label), label).toBeDefined()
      expect(behavior.get(label)?.navigation_only, label).toBeUndefined()
    }
    for (const question of ['Where is computeMonthlyRevenue?', 'Which modules import monthly revenue?', 'Show monthly revenue in navigation.ts']) {
      expect(matches(question).get('navigation.ts'), question).toBeDefined()
      expect(matches(question).get('navigation.ts')?.navigation_only, question).toBeUndefined()
    }
  })

  it('keeps the live content-session query focused when an evidence inventory is appended', async () => {
    const { graph, root } = workspace()
    for (const file of ['runtime/context-session.ts', 'infrastructure/time-travel.ts']) {
      const path = join(root, 'src', file.replaceAll('/', '-'))
      writeFileSync(path, readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8'))
      for (const node of extractJs(path).nodes) graph.addNode(node.id, node)
    }
    const subject = 'How do content-ref context sessions compare input content hashes with previous state to produce added, updated, reused, invalidated refs, reused token counts, and next revision, and how are duplicate refs handled?'
    const question = `${subject} Use only source, tests, configuration, and root README.md.`
    const unscoped = retrieveContext(graph, { question: subject, budget: 5000, taskKind: 'explain' })
    for (const result of [retrieveContext(graph, { question, budget: 5000, taskKind: 'explain' }), await retrieveContextAsync(graph, { question, budget: 5000, taskKind: 'explain' })]) {
      expect(result.question).toBe(question)
      expect(result.matched_nodes.map(node => node.node_id)).toEqual(unscoped.matched_nodes.map(node => node.node_id))
      const body = result.matched_nodes.find(node => node.label === 'buildContextSession()')?.snippet
      expect(body).toContain('Duplicate context session ref:')
      expect(body).toContain('previousRef.hash !== hash')
      expect(body).toContain('baseState.refs[ref]?.token_count')
      expect(body).toContain('revision: baseState.revision + 1')
    }
  })

  it('matches source exclusions inside the repository rather than its parent path', () => {
    const { graph, root } = workspace('madar-workspace-')
    const path = join(root, 'src', 'workspace.ts')
    writeFileSync(path, 'export function trackRequest() { return "EXCLUDED_WORKSPACE"; }')
    for (const node of extractJs(path).nodes) graph.addNode(node.id, node)
    const result = retrieveContext(graph, { question: 'Explain request flow. Exclude workspace.', budget: 3000 })
    expect(result.matched_nodes.some(node => node.label === 'processRequest()')).toBe(true)
    expect(result.matched_nodes.some(node => node.source_file.endsWith('workspace.ts'))).toBe(false)
  })

  it('excludes an explicit filename while retaining allowed sources with the same extension', () => {
    const { graph, root } = workspace()
    const excluded = join(root, 'src', 'auth.ts')
    writeFileSync(excluded, 'export function auditRequest() { return "REQUEST_AUDIT"; }')
    for (const node of extractJs(excluded).nodes) graph.addNode(node.id, node)
    const baseline = retrieveContext(graph, { question: 'Explain request flow.', budget: 3000 })
    expect(baseline.matched_nodes.some(node => node.source_file.endsWith('auth.ts'))).toBe(true)
    const result = retrieveContext(graph, { question: 'Explain request flow. Do not read auth.ts.', budget: 3000 })
    expect(result.matched_nodes.some(node => node.label === 'processRequest()')).toBe(true)
    expect(result.matched_nodes.some(node => node.source_file.endsWith('auth.ts'))).toBe(false)
  })

  it('refuses invalid exclusion scope even with a positive anchor while preserving valid-scope precedence', () => {
    const { graph, root } = workspace()
    const question = 'Explain `processRequest`.'
    const original = retrieveContext(graph, { question, budget: 3000 })
    const node = original.matched_nodes.find(value => value.label === 'processRequest()')!
    expect(node).toBeDefined()
    if (typeof node.node_id !== 'string') throw new Error('Expected indexed source owner')
    const scored = [{ id: node.node_id, label: node.label, sourceFile: node.source_file,
      exactLabelMatch: true, sourcePathMatch: true, score: 1 }]
    for (const scope of ['../auth.ts', 'src/{auth,other}.ts']) {
      const prompt = `${question} Exclude ${scope}.`
      const exclusions = extractPromptExclusions(prompt)
      expect(retrieveContext(graph, { question: prompt, budget: 3000 }).matched_nodes).toEqual([])
      expect(sliceCandidatesForRetrieve(graph, scored, 'explain', {
        rootPath: root, excludedTerms: exclusions.excludedTerms, excludedPathHints: exclusions.excludedPathHints,
      })).toBeNull()
    }
    const allowed = retrieveContext(graph, { question: `${question} Exclude handler.ts.`, budget: 3000 })
    expect(allowed.matched_nodes.some(value => value.node_id === node.node_id)).toBe(true)
    expect(sliceCandidatesForRetrieve(graph, scored, 'explain', {
      rootPath: root, excludedTerms: ['handler.ts'],
    })?.ordered_ids).toContain(node.node_id)
  })

  it('finds exact body-only error literals ahead of label distractors', () => {
    const { graph } = workspace()
    for (const question of ['Where is SESSION_EXPIRED thrown?', 'Where is `SESSION_EXPIRED` thrown?', 'Where is ACCESS_DENIED thrown?']) {
      const result = retrieveContext(graph, { question, budget: 3000 })
      expect(result.matched_nodes[0]?.label, question).toBe('processRequest()')
      expect(result.matched_nodes[0]?.snippet).toContain('throw new Error("ACCESS_DENIED")')
      expect(result.matched_nodes[0]?.snippet).toContain('if (elapsed > 900000)')
      expect(result.matched_nodes[0]?.snippet_line_range).toEqual({ start_line: 1, end_line: 6 })
    }
  })

  it('returns every guard and the calculation in a complete small body', () => {
    const { graph, handler } = workspace()
    const result = retrieveContext(graph, { question: 'What does processRequest do?', budget: 3000 })
    const node = result.matched_nodes.find((node) => node.label === 'processRequest()')
    expect(node?.snippet).toBe(readFileSync(handler, 'utf8'))
    expect(node?.snippet_omitted_ranges).toBeUndefined()
  })

  it('admits separately requested behavior without treating literal fragments as evidence', () => {
    for (const question of [
      'Find JavaScript source for QueryHandler. Also locate Session construction.',
      'Locate source for QueryHandler and show Session construction.',
      'Show source in ./src/first.ts; then locate Session construction.',
    ]) expect(sourceQueryRequestsClauseLocations(question), question).toBe(true)
    for (const question of [
      'Explain how source handles QueryHandler. Also locate Session construction.',
      'Show how source handles QueryHandler. Also locate Session construction.',
      'Find source for QueryHandler; show why Session construction changes.',
      'Find source for QueryHandler. Also locate Session construction. Explain why it is needed.',
      'Find source callers for QueryHandler. Also locate Session construction.',
      'Find source for QueryHandler impact. Also locate Session construction.',
      'Find source to modify QueryHandler. Also locate Session construction.',
      'Find source containing "Also locate Session construction".',
      'Find source for QueryHandler(input, "Also locate Session").',
      'Find source in ./show.how/locate.ts.',
    ]) expect(sourceQueryRequestsClauseLocations(question), question).toBe(false)
    for (const question of ['Find Handler. Also locate Session construction.', 'Find Handler and locate Session construction.', 'Find Handler; show Session construction.']) expect(sourceQueryIsLiteralLookup(question)).toBe(false)
    for (const question of ['Find QueryHandler', 'Find QueryHandler (input, trace)', 'Find "QueryHandler. Also locate Session"', 'Find QueryHandler in ./lib/']) expect(sourceQueryIsLiteralLookup(question)).toBe(true)
    const { graph, root } = workspace()
    const path = join(root, 'src', 'backoff.ts')
    writeFileSync(path, [
      'export function interval(attempt: number) {',
      '  // Backoff delays for retries.',
      '  return Math.min(8000, 20 * 2 ** attempt);',
      '}',
      'export function report() { return "SESSION_EXPIRED_TOTAL"; }',
    ].join('\n'))
    for (const node of extractJs(path).nodes) graph.addNode(node.id, node)
    const labels = (question: string) => [...searchSourceBodies(graph, question, root).matches.keys()]
      .map(id => graph.nodeAttributes(id).label)
    expect(labels('Where is `SESSION_EXPIRED` thrown, and how are backoff delays for retries computed?'))
      .toContain('interval()')
    expect(labels('Where is `SESSION_EXPIRED` thrown, and how are backoff delays for retries computed?'))
      .not.toContain('report()')
    expect(labels('Where is `SESSION_EXPIRED` thrown?')).toEqual(['processRequest()'])
  })

  it('retains the exact literal owner before capping a mixed behavior candidate pool', () => {
    const { graph, root } = workspace()
    const path = join(root, 'src', 'candidate-cap.ts')
    writeFileSync(path, [
      'export function thrower() { throw new Error("E7"); }',
      ...Array.from({ length: 130 }, (_, index) => `export function delay${index}() { return "retries scheduled backoff delays computed"; }`),
    ].join('\n'))
    for (const node of extractJs(path).nodes) graph.addNode(node.id, node)
    const result = searchSourceBodies(graph, 'Where is `E7` raised, and how are retries scheduled and backoff delays computed?', root)
    expect(result.bounded).toBe(true)
    expect(result.matches.size).toBe(128)
    const [id, match] = [...result.matches][0]!
    expect(graph.nodeAttributes(id).label).toBe('thrower()')
    expect(match.exact_literal).toBe(true)
  })

  it('never substitutes a sibling function for a matched symbol', () => {
    const { metrics } = workspace()
    const snippet = readQueryEvidenceSnippet(metrics, 1, { question: 'What historical sessions are described?', label: 'recordSessionExpiredMetric()', sourceLocation: 'L1-L3' })
    expect(snippet?.scope).toBe('symbol')
    expect(snippet?.snippet).toContain('counter.set')
    expect(snippet?.snippet).not.toContain('Historical count')
  })

  it('keeps matched conditions and reports exact omissions for a large function', () => {
    const { handler } = workspace()
    const lines = ['export function largeHandler() {', ...Array.from({ length: 130 }, (_, i) => `  const value${i} = ${i};`), '  if (value129 > 100) throw new Error("QUOTA_EXCEEDED");', '  return value129;', '}']
    writeFileSync(handler, lines.join('\n'))
    const snippet = readQueryEvidenceSnippet(handler, 1, { question: 'Where is QUOTA_EXCEEDED thrown?', label: 'largeHandler()', sourceLocation: `L1-L${lines.length}` })
    expect(snippet?.snippet).toContain('if (value129 > 100)')
    expect(snippet?.snippet).toContain('[omitted lines ')
    expect(snippet?.snippet_omitted_ranges?.length).toBeGreaterThan(0)
    expect(snippet?.snippet_line_range).toEqual({ start_line: 1, end_line: lines.length })
    for (const range of snippet?.snippet_omitted_ranges ?? []) {
      expect(range.start_line).toBeGreaterThan(1)
      expect(range.end_line).toBeLessThan(lines.length)
    }
  })

  it('retains the error path and returned JSX binding of an already selected callback within the excerpt bounds', () => {
    const { root } = workspace()
    const path = join(root, 'src', 'action-panel.tsx')
    const lines = Array.from({ length: 129 }, () => '  // padding')
    const source: Record<number, string> = {
      1: 'export function ActionPanel({ recordType, className }: Props) {',
      3: '  const entries = [];', 4: '  let loading = false;',
      30: '  load().catch((error) => {', 31: '    log(error);', 32: '  });',
      36: '  const dispatch = wrap(', 37: '    async (event) => {',
      40: '      if (!authenticated) {', 42: '        notify.error("Sign in to save entries");',
      43: '        return;', 44: '      }', 46: '      if (loading) return;', 47: '      loading = true;',
      49: '      const method = active ? "DELETE" : "POST";',
      51: '      try {', 52: '        const token = await credentials();',
      53: '        const response = await send(', 54: '          "/api/entries",',
      55: '          { method, token, recordType }', 60: '        );',
      62: '        if (!response.ok) {', 63: '          const data = await response.json();',
      64: '          throw new Error(data.error ?? "Failed to update entries");', 65: '        }',
      67: '        persist(await response.json());',
      80: '      } catch (error) {', 81: '        const message = error instanceof Error ? error.message : "Failed";',
      82: '        notify.error(message);', 83: '        log(error);', 84: '      } finally {',
      85: '        if (mounted) {', 86: '          loading = false;', 87: '        }', 88: '      }',
      89: '    },', 90: '    [authenticated, loading, recordType]', 91: '  );',
      101: '  return (', 102: '    <Control', 103: '      kind="compact"',
      106: '      onAction={dispatch}', 109: '    >', 110: '      Continue', 122: '    </Control>',
      123: '  );', 129: '}',
    }
    for (const [line, text] of Object.entries(source)) lines[Number(line) - 1] = text
    const question = 'If I already have 12 saved entries and try to save another record type, does the app reject the addition, and what message reaches me? Also what happens for an existing entry?'
    const baseline = (current: string[], prompt = question) => coherentSourceSnippet(current, { start: 1, end: current.length }, prompt, 'symbol')!
    const snippet = (current: string[], prompt = question) => {
      writeFileSync(path, current.join('\n'))
      return readQueryEvidenceSnippet(path, 1, { question: prompt, label: 'ActionPanel()', sourceLocation: `L1-L${current.length}`, rootPath: root })!
    }
    const before = baseline(lines), after = snippet(lines)
    expect(before.snippet).not.toContain('notify.error(message)')
    for (const text of ['const data = await response.json()', 'throw new Error(data.error', '} catch (error)',
      'notify.error(message)', '} finally {', 'onAction={dispatch}', '</Control>']) expect(after.snippet).toContain(text)
    const visible = (gaps: Array<{ start_line: number; end_line: number }>) => lines.map((_, index) => index + 1)
      .filter(line => !gaps.some(gap => line >= gap.start_line && line <= gap.end_line))
    const prior = visible(before.omittedRanges), retained = visible(after.snippet_omitted_ranges ?? [])
    expect(retained).toEqual(expect.arrayContaining(prior))
    expect(retained.length).toBeLessThanOrEqual(80)
    expect(after.snippet.length).toBeLessThanOrEqual(12_000)
    const variant = (...changes: Array<[number, string]>) => {
      const current = [...lines]; for (const [line, text] of changes) current[line - 1] = text; return current
    }
    const splitHandler = variant([5, source[36]!], [6, source[37]!], [25, source[51]!],
      [36, '  // padding'], [37, '  // padding'], [51, '  // padding'],
      [84, '      }'], [85, '      finally'], [86, '      {'], [87, '        loading = false;'])
    const shellQuestion = question.replace('try to save', 'save')
    expect(baseline(splitHandler, shellQuestion).snippet).not.toContain('try {')
    const shells = snippet(splitHandler, shellQuestion).snippet
    expect(shells).toContain('try {')
    expect(shells).toContain('      finally\n      {')
    const nestedJsx = snippet(variant([102, '    <Panel>'], [103, '      {'], [104, '      ('],
      [105, '        <Control'], [123, '      )}</Panel>'], [124, '  );']))
    expect(nestedJsx.snippet).toContain('    <Panel>\n      {\n      (')
    expect(nestedJsx.snippet).toContain('      )}</Panel>\n  );')
    expect(visible(nestedJsx.snippet_omitted_ranges ?? []).length).toBeLessThanOrEqual(80)
    for (const current of [
      variant([96, '  dispatch = replacement;']),
      variant([96, '  function nested(dispatch: unknown) { return dispatch; }']),
      variant([106, '      onAction={alias}']),
      variant([102, '    <section>{shown ? ('], [103, '      <Control'],
        [123, '    ) : null}</section>'], [124, '  );']),
      variant([81, `        const message = "${'x'.repeat(12_000)}";`]),
      variant([65, '          log(response);'], [77, '        }']),
    ]) expect(snippet(current).snippet).toBe(baseline(current).snippet)
    for (const prompt of [`${question} Exclude "OTHER_MARKER".`, 'Where is "save entries"?']) {
      expect(snippet(lines, prompt).snippet).toBe(baseline(lines, prompt).snippet)
    }
  })

  it('does not use an excluded marker to select another excerpt, while preserving quoted source data', () => {
    const { handler } = workspace()
    const lines = ['export function largeHandler() {', ...Array.from({ length: 160 }, (_, i) => `  const value${i} = ${i};`), '}']
    lines[20] = '  const primary = "PRIMARY_SIGNAL";'
    lines[140] = '  const legacy = "LEGACY_MARKER";'
    writeFileSync(handler, lines.join('\n'))
    const snippet = (question: string) => readQueryEvidenceSnippet(handler, 1, {
      question, label: 'largeHandler()', sourceLocation: `L1-L${lines.length}`,
    })
    const excluded = snippet('Explain "PRIMARY_SIGNAL" behavior; exclude "LEGACY_MARKER".')
    expect(excluded?.snippet).toContain('const primary = "PRIMARY_SIGNAL"')
    expect(excluded?.snippet).not.toContain('const legacy = "LEGACY_MARKER"')
    const requested = snippet('Explain "PRIMARY_SIGNAL" and "LEGACY_MARKER" behavior.')
    expect(requested?.snippet).toContain('const primary = "PRIMARY_SIGNAL"')
    expect(requested?.snippet).toContain('const legacy = "LEGACY_MARKER"')
  })

  it('selects separate executable clauses and lexical wiring without comment or nested-owner substitution', () => {
    const { root } = workspace()
    mkdirSync(join(root, 'lib'))
    const padding = Array.from({ length: 90 }, (_, index) => `  bookkeeping += ${index};`)
    const entry = [
      "const hook = require('./lib/hook')",
      'export function createRegistry() {',
      '  let bookkeeping = 0;',
      ...padding,
      '  const registry = new Registry({ expose: { use: "register" } });',
      '  // Install the callback on this newly constructed registry.',
      '  registry.override = hook;',
      ...padding,
      '  return registry;',
      '}',
    ].join('\n')
    const hooks = [
      'export function shouldSkipExtension(fn) { return fn.skip === true; }',
      'export function registerExtension(fn) { checkName(fn); return shouldSkipExtension(fn); }',
      'module.exports = function replaceHost(parent, fn) {',
      '  const skip = registerExtension(fn);',
      '  if (skip) return parent;',
      '  return Object.create(parent);',
      '}',
    ].join('\n')
    const transport = [
      'export function installRoutes(context, app) {',
      '  let bookkeeping = 0;', ...padding,
      '  app.once("ready", () => {',
      '    if (context.enabled) {',
      '      while (!context.Envelope.marked && context.Envelope.parent) {',
      '        context.Envelope = context.Envelope.parent;',
      '      }',
      '    }',
      '  });', ...padding,
      '}',
      'export function deliver(context, input) {',
      '  let bookkeeping = 0;', ...padding,
      '  const message = new context.Envelope(input);', ...padding,
      '  return message;',
      '}',
      'export function unrelatedOuter() {',
      '  function helper(context) { return new context.Envelope(context); }',
      '  return helper;',
      '}',
      'export function schemaReport(data) {',
      '  // context Envelope construction constructor selection undecorated envelope constructors',
      '  const schema = { description: "context Envelope construction selection", properties: { Envelope: "context" } };',
      '  return validate(data, schema);',
      '}',
    ].join('\n')
    const files = { 'entry.js': entry, 'lib/hook.js': hooks, 'lib/transport.js': transport }
    const extracted = Object.entries(files).map(([file, source]) => { const path = join(root, file); writeFileSync(path, source); return extractJs(path) })
    const graph = buildFromJson({ schema_version: 1, nodes: extracted.flatMap(value => value.nodes).filter(node => node.label !== 'helper()'), edges: [] }, { directed: true })
    graph.graph.root_path = root
    const question = 'Find JavaScript source connecting ordinary registration to hook.js, including registerExtension and shouldSkipExtension. Also locate message construction using the route context Envelope constructor and any constructor selection that skips unmarked envelope constructors. Restrict to entry.js and lib/*.js.'
    const result = retrieveContext(graph, { question, taskKind: 'explain', budget: 4000 })
    const source = result.matched_nodes.map(node => node.snippet ?? '').join('\n')
    const diagnostic = retrieveContext(graph, { question, taskKind: 'explain', taskIntent: 'debug-flow', budget: 4000 })
    const diagnosticSource = diagnostic.matched_nodes.map(node => node.snippet ?? '').join('\n')
    for (const required of ["const hook = require('./lib/hook')", 'new Registry({ expose:', 'registry.override = hook',
      'const skip = registerExtension(fn)', 'return shouldSkipExtension(fn)', 'fn.skip === true',
      'app.once("ready", () => {', 'if (context.enabled)', 'while (!context.Envelope.marked',
      'context.Envelope = context.Envelope.parent', 'new context.Envelope(input)']) {
      expect(source).toContain(required)
      expect(diagnosticSource).toContain(required)
    }
    expect(result.matched_nodes.some(node => ['unrelatedOuter()', 'schemaReport()'].includes(node.label))).toBe(false)
    expect(diagnostic.matched_nodes.some(node => ['unrelatedOuter()', 'schemaReport()'].includes(node.label))).toBe(false)
    const bindingOwner = result.matched_nodes.find(node => node.label === 'entry.js')
    expect(bindingOwner?.snippet_scope).toBe('source_file')
    expect(bindingOwner?.snippet).toBe(`const hook = require('./lib/hook')\n[omitted lines 2-${entry.split('\n').length}]`)
    expect(bindingOwner?.snippet_omitted_ranges).toEqual([{ start_line: 2, end_line: entry.split('\n').length }])
    expect(source).not.toContain('bookkeeping +=')
    expect(source).toContain('new Registry({ expose: { use: "register" } });\n  // Install the callback on this newly constructed registry.\n  registry.override = hook;')
    expect(source).toContain('module.exports = function replaceHost(parent, fn) {')
    const partials = result.matched_nodes.filter(node => node.snippet_omitted_ranges?.length)
    expect(partials.length).toBeGreaterThanOrEqual(3)
    for (const node of result.matched_nodes) {
      if (!node.snippet_line_range || !node.snippet) continue
      const lines = readFileSync(join(root, node.source_file), 'utf8').split(/\r?\n/)
      const expected: string[] = []
      for (let line = node.snippet_line_range.start_line; line <= node.snippet_line_range.end_line; line++) {
        const gap = node.snippet_omitted_ranges?.find(range => range.start_line === line)
        if (gap) { expected.push(`[omitted lines ${gap.start_line}-${gap.end_line}]`); line = gap.end_line }
        else expected.push(lines[line - 1]!)
      }
      expect(node.snippet).toBe(expected.join('\n'))
    }
  })

  it('drops a source span explicitly instead of silently slicing it again under budget', () => {
    const { graph } = workspace()
    const result = retrieveContext(graph, { question: 'What does processRequest do?', budget: 3000 })
    const shaped = withRetrieveSnippetBudget(result, { snippetBudget: 1 })
    const node = shaped.matched_nodes.find((node) => node.label === 'processRequest()')
    expect(node?.snippet).toBeNull()
    expect(node?.snippet_truncated).toBe(true)
    expect(node?.snippet_omitted_ranges).toEqual([{ start_line: 1, end_line: 6 }])
  })

  it('does not read a symlink escaping the graph root or Markdown', () => {
    const { root, graph } = workspace()
    const outside = mkdtempSync(join(tmpdir(), 'madar-outside-')); roots.push(outside)
    const target = join(outside, 'private.ts'); writeFileSync(target, 'export const value = "PRIVATE_SENTINEL"')
    const linked = join(root, 'src', 'linked.ts'); symlinkSync(target, linked)
    const markdown = join(root, 'notes.md'); writeFileSync(markdown, 'PRIVATE_SENTINEL')
    const secret = join(root, 'secrets.json'); writeFileSync(secret, '{"value":"PRIVATE_SENTINEL"}')
    const disguised = join(root, 'src', 'disguised.ts'); symlinkSync(secret, disguised)
    graph.addNode('disguised', { label: 'disguised', file_type: 'code', source_file: disguised, source_location: 'L1' })
    for (const [id, file] of [['linked', linked], ['markdown', markdown]]) graph.addNode(id!, { label: id, file_type: 'code', source_file: file, source_location: 'L1' })
    expect(searchSourceBodies(graph, 'PRIVATE_SENTINEL', root).matches.size).toBe(0)
    expect(readQueryEvidenceSnippet(linked, 1, { question: 'PRIVATE_SENTINEL', label: 'linked', sourceLocation: 'L1', rootPath: root })).toBeNull()
  })

  it('does not confuse identifier prefixes with an exact literal', () => {
    const { graph, metrics, root } = workspace()
    writeFileSync(metrics, readFileSync(metrics, 'utf8').replace('Historical count', 'NOT_SESSION_EXPIRED SESSION_EXPIRED_METRIC count'))
    const matches = searchSourceBodies(graph, 'Where is SESSION_EXPIRED thrown?', root).matches
    expect([...matches.keys()]).toEqual(['handler_processrequest'])
  })

  it('refuses a live body when the indexed declaration moved to another range', () => {
    const { handler } = workspace()
    writeFileSync(handler, 'export function anotherHandler() {\n  return "WRONG_FUNCTION";\n}\n\n\n\n' + readFileSync(handler, 'utf8'))
    expect(readQueryEvidenceSnippet(handler, 1, { question: 'What does processRequest do?', label: 'processRequest()', sourceLocation: 'L1-L6' })).toBeNull()
  })

  it('marks source search incomplete when an indexed source exceeds the read bound', () => {
    const { handler, graph, root } = workspace()
    writeFileSync(handler, ' '.repeat(300 * 1024))
    expect(searchSourceBodies(graph, 'ACCESS_DENIED', root).bounded).toBe(true)
  })

  it('keeps a body candidate when natural phrasing matches only one meaningful body term', () => {
    const { graph } = workspace()
    const result = retrieveContext(graph, { question: 'Where does the code reject a session older than 15 minutes?', budget: 3000 })
    expect(result.matched_nodes.some((node) => node.label === 'processRequest()' && node.snippet?.includes('elapsed > 900000'))).toBe(true)
  })

  it('passes real source and candidates omitted by the output budget to the optional reranker', async () => {
    const { graph } = workspace()
    const rerank = vi.fn(async (_question: string, candidates: Array<{ id: string; text: string }>) => new Map(candidates.map((candidate) => [candidate.id, candidate.id === 'handler_processrequest' ? 0.99 : 0.01])))
    vi.doMock('../../src/runtime/semantic.js', () => ({ rerankCandidatesWithCrossEncoder: rerank }))
    await retrieveContextAsync(graph, { question: 'session expiry', budget: 40, rerank: true })
    const candidates = rerank.mock.calls[0]?.[1] ?? []
    const handler = candidates.find((candidate) => candidate.id === 'handler_processrequest')
    expect(handler?.text).toContain('throw new Error("ACCESS_DENIED")')
    expect(handler?.text).toContain('if (elapsed > 900000)')
  })

  it('honors the classifier local level for simple automatic lookups', () => {
    const interpreted = interpretRetrievalQuery({ question: 'Where is ACCESS_DENIED thrown?', budget: 3000 })
    expect(interpreted.retrieval_gate.level).toBe(1)
    expect(interpreted.effective_retrieval_level).toBe(1)
  })
})
