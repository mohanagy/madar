import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'
import { sourceClientContextRequest, sourceClientImportGroup } from '../../src/runtime/retrieve/source-client-context.js'
import { selectSourceDependencies, sourceClientPriorityKey, sourceSelectionProvenanceKey } from '../../src/runtime/retrieve/source-dependencies.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const question = 'Trace ticket capture, storage persistence and consumption during account setup; explain when pending state is discarded. Focus client side.'

function fixture(noise = 0) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-client-context-'))); roots.push(root)
  const files: Record<string, string> = {
    'view.ts': [
      '"use client";',
      ...Array.from({ length: noise }, (_, index) => `import { observe${index} } from './noise-${index}.js';`),
      "import { captureTicket, consumeTicket } from './handoff.js';",
      'export function Workbench() {',
      '  // Ticket capture, storage persistence and consumption during account setup.',
      '  // Pending state is discarded after this client handoff.',
      ...Array.from({ length: noise }, (_, index) => `  observe${index}();`),
      '  captureTicket(location.search);',
      '  return consumeTicket();',
      '}',
    ].join('\n'),
    'handoff.ts': [
      "import { LIMIT, FORMAT } from './policy.js';",
      "export const KEY = 'pending-ticket';",
      'export const EXPIRY = LIMIT * 1000;',
      'export function parseTicket(text: string) {',
      '  return FORMAT.test(text) ? text : null;',
      '}',
      'export function captureTicket(text: string) {',
      '  const value = parseTicket(text);',
      '  if (value) localStorage.setItem(KEY, value);',
      '}',
      'export function consumeTicket() {',
      '  const value = localStorage.getItem(KEY);',
      '  localStorage.removeItem(KEY);',
      '  return { value, ttl: EXPIRY };',
      '}',
    ].join('\n'),
    'policy.ts': 'export const LIMIT = 42;\nexport const FORMAT = /^[A-Z]+$/;',
    'server.ts': 'export function processAccount() {\n  // Ticket account setup is logged on the server.\n  return "UNRELATED_SERVER";\n}',
  }
  for (let index = 0; index < noise; index++) files[`noise-${index}.ts`] = `export function observe${index}() { return ${index}; }`
  const nodes: ReturnType<typeof extractJs>['nodes'] = [], edges: ReturnType<typeof extractJs>['edges'] = []
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, path); writeFileSync(file, text)
    const extracted = extractJs(file); nodes.push(...extracted.nodes); edges.push(...extracted.edges)
    // The graph generator's value pass is separate from extractJs. Supply
    // these four exact indexed declarations without invoking a whole index run.
    for (const [line, statement] of text.split('\n').entries()) {
      const value = statement.match(/^export const (KEY|EXPIRY|LIMIT|FORMAT) = /)?.[1]
      if (value) nodes.push({ id: `fixture-${value}`, label: value,
        file_type: 'code', source_file: file, source_location: `L${line + 1}-L${line + 1}`, snippet: statement })
    }
  }
  const graph = buildFromJson({ schema_version: 1, nodes, edges }, { directed: true }); graph.graph.root_path = root
  const id = (label: string) => {
    const entry = graph.nodeEntries().find(([, attrs]) => attrs.label === label)
    if (!entry) throw new Error(`Fixture owner not indexed: ${label}`)
    return entry[0]
  }
  const leader = id('Workbench()')
  const select = (prompt = question, allowedOwner = (_file: string, _label: string, _text: string) => true,
    cache = new Map<string, string[] | null>()) => selectSourceDependencies(graph, [leader], root, cache,
      { clientPriority: { seedId: leader, question: prompt, allowedOwner } })
  return { root, files, graph, id, leader, select }
}

describe('client forward context', () => {
  it('reserves current topical calls and values before unrelated fanout under the existing bounds', () => {
    const f = fixture(36), selected = f.select(), proof = selected[sourceSelectionProvenanceKey]!
    const expected = ['captureTicket()', 'consumeTicket()', 'parseTicket()', 'KEY', 'EXPIRY', 'LIMIT', 'FORMAT'].map(f.id)
    expect(selected[sourceClientPriorityKey]?.[0]).toBe(f.leader)
    expect(selected[sourceClientPriorityKey]?.slice(1)).toEqual(expect.arrayContaining(expected))
    expect(selected.node_ids).toEqual(expect.arrayContaining(expected))
    expect(selected.node_ids).toHaveLength(12)
    expect(proof.addition_limit_hit).toBe(true)
    expect(proof.policy.include_callers).toBe(false)
    expect(proof.sources.filter(source => source.in_program)).toHaveLength(32)
    expect(proof.sources.find(source => source.source_file === join(f.root, 'policy.ts'))?.in_program).toBe(true)
    expect(proof.admissions.slice(0, 7).map(entry => entry.node_id)).toEqual(expect.arrayContaining(expected))
    expect(selected.relationships).toContainEqual({ from_id: f.leader, to_id: f.id('captureTicket()'), relation: 'calls' })
    expect(selected.relationships).toContainEqual({ from_id: f.id('consumeTicket()'), to_id: f.id('EXPIRY'), relation: 'depends_on' })
    expect(selected[sourceClientPriorityKey]).not.toContain(f.id('processAccount()'))
  })

  it('retains the client implementation group through retrieval without creating server or unused-import authority', () => {
    const f = fixture()
    const result = retrieveContext(f.graph, { question, taskKind: 'explain', taskIntent: 'explain', budget: 1800 })
    const source = result.matched_nodes.map(node => node.snippet ?? '').join('\n')
    for (const text of ['localStorage.setItem(KEY, value)', 'localStorage.removeItem(KEY)', 'FORMAT.test(text)', "KEY = 'pending-ticket'", 'EXPIRY = LIMIT * 1000']) expect(source).toContain(text)
    expect(result.token_count).toBeLessThanOrEqual(1800)
    expect(result.relationships.some(edge => edge.from_id === f.leader && edge.to_id === f.id('processAccount()'))).toBe(false)
    writeFileSync(join(f.root, 'view.ts'), f.files['view.ts']!.replace('  captureTicket(location.search);', '  void location.search;'))
    const unused = f.select()
    expect(unused[sourceClientPriorityKey]).toBeUndefined()
    expect(unused.relationships.some(edge => edge.from_id === f.leader && edge.to_id === f.id('captureTicket()'))).toBe(false)
  })

  it('declines ambiguous scope, imports, stale identity and excluded owners without granting preference', () => {
    const parse = (text: string) => ts.createSourceFile('view.ts', text, ts.ScriptTarget.Latest, true)
    const source = '"use client";\nimport { captureTicket, consumeTicket } from "./one.js";'
    expect(sourceClientImportGroup(parse(source), question)?.names).toEqual(['captureTicket', 'consumeTicket'])
    for (const prompt of [question.replace('Focus client side.', ''), `${question} Include server behavior.`,
      question.replace('Focus client side.', 'Focus client library.'), question.replace('Focus client side.', 'Focus client side only if enabled.'),
      `${question} Trace callers.`]) expect(sourceClientContextRequest(prompt)).toBe(false)
    for (const text of [source.replace('use client', 'use server'),
      source.replace('captureTicket, consumeTicket', 'captureTicket as saveTicket, consumeTicket'),
      source + '\nimport { captureTicketLater, consumeTicketLater } from "./two.js";',
      source + '\nimport * as namespace from "./one.js";']) expect(sourceClientImportGroup(parse(text), question)).toBeUndefined()
    const f = fixture()
    const ordinary = selectSourceDependencies(f.graph, [f.leader], f.root, new Map())
    expect(f.select(question.replace('Focus client side.', 'Include server behavior.'))).toEqual(ordinary)
    expect(f.select(question, (_file, label) => label !== 'consumeTicket()')[sourceClientPriorityKey]).toBeUndefined()
    const cache = new Map([[join(f.root, 'handoff.ts'), f.files['handoff.ts']!.split('\n')]])
    writeFileSync(join(f.root, 'handoff.ts'), f.files['handoff.ts']!.replace('LIMIT * 1000', 'LIMIT * 2000'))
    expect(f.select(question, () => true, cache)[sourceClientPriorityKey]).toBeUndefined()
    writeFileSync(join(f.root, 'handoff.ts'), f.files['handoff.ts']!)
    f.graph.addNode('duplicate-capture', { ...f.graph.nodeAttributes(f.id('captureTicket()')) })
    expect(f.select()[sourceClientPriorityKey]).toBeUndefined()
  })
})
