import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { withExtractionFileStemContext } from '../../src/pipeline/extract/core.js'
import { retrieveContext, compactRetrieveResult } from '../../src/runtime/retrieve.js'
import { searchSourceBodies } from '../../src/runtime/retrieve/source-evidence.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'madar-behavior-selection-'))
  roots.push(root)
  const fragments = withExtractionFileStemContext(Object.keys(files).map(file => join(root, file)), () => Object.entries(files).map(([file, source]) => {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
    return extractJs(path)
  }))
  const graph = buildFromJson({ schema_version: 1, nodes: fragments.flatMap(f => f.nodes), edges: fragments.flatMap(f => f.edges) }, { directed: true })
  graph.graph.root_path = root
  return { graph, root }
}

const liveQuestion = 'How do content-ref context sessions compute added, updated, reused, invalidated refs, reused_token_count, next token_count and revision from a previous state, and how are duplicate refs in one input list handled? Find the executing source.'

function sessionFixture(distractors = 24) {
  const files: Record<string, string> = {
    'src/runtime/context-session.ts': readFileSync(new URL('../../src/runtime/context-session.ts', import.meta.url), 'utf8'),
  }
  for (let index = 0; index < distractors; index += 1) {
    files[`src/reports/report-${index}.ts`] = [
      `export function computeContentRefContextSessionReport${index}(input: any, previous: any) {`,
      '  const refs = input.refs ?? [];',
      '  const state = previous.state;',
      '  return { refs, state, token_count: input.token_count + previous.token_count };',
      '}',
    ].join('\n')
  }
  return fixture(files)
}

describe('behavior evidence selection', () => {
  it('orders an admitted HTTP implementation before its referring UI without inventing a call edge', () => {
    const { graph, root } = fixture({
      'src/app/confirmation.ts': `export function confirmInvoiceApproval() {
  // Invoice approval confirmation UI reports receipt persistence and response failures.
  return fetch('/api/invoice/approve', { method: 'POST' });
}`,
      'src/app/api/invoice/approve/route.ts': `export function POST(invoice: unknown) {
  return Response.json({ invoice, approval: true, receipt: 'saved' });
}`,
      'src/app/api/session/route.ts': `export function POST() {
  return Response.json({ receipt: 'session' });
}`,
    })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '16.0.0' } }))
    const result = retrieveContext(graph, {
      question: 'Trace invoice approval from confirmation UI through POST. Explain receipt persistence and response failures.',
      taskKind: 'explain', budget: 3000,
    })
    const api = result.matched_nodes.findIndex(node => node.source_file === 'src/app/api/invoice/approve/route.ts')
    const ui = result.matched_nodes.findIndex(node => node.label === 'confirmInvoiceApproval()')
    expect(api, JSON.stringify(result.matched_nodes.map(node => [node.label, node.source_file]))).toBeGreaterThanOrEqual(0)
    expect(ui).toBeGreaterThan(api)
    expect(result.relationships.some(edge => edge.from_id === result.matched_nodes[ui]!.node_id
      && edge.to_id === result.matched_nodes[api]!.node_id)).toBe(false)
    expect(result.token_count).toBeLessThanOrEqual(3000)
  })

  it('admits disconnected body owners before incidental dependencies despite inferred framework hints', () => {
    const decisions = ['approval', 'refund', 'settlement', 'cancellation', 'reconciliation', 'archiving']
    const { graph } = fixture({ 'src/options.ts': `export interface Options { ${decisions.map(decision => `${decision}: string`).join('; ')} }`,
      ...Object.fromEntries(decisions.map((decision, index) => [
      `src/stage-${index}.ts`, `export function stage${index}() {
 const invoice = "${decision}";
 return wrap(invoice);
}
function wrap(value: string) { return value.trim(); }`,
    ])) })
    for (const [id, attrs] of graph.nodeEntries()) {
      if (String(attrs.label).startsWith('stage')) graph.addNode(id, { ...attrs,
        framework: /stage-[45]/.test(String(attrs.source_file)) ? 'nextjs' : 'express',
        framework_role: 'express_handler',
      })
    }
    const question = `Trace invoice ${decisions.join(', ')} through POST.`
    const result = retrieveContext(graph, { question, taskKind: 'explain', budget: 3000 })
    const requested = result.matched_nodes.filter(node => /^stage\d\(\)$/.test(node.label))
    expect(requested).toHaveLength(decisions.length)
    expect(result.matched_nodes.slice(0, decisions.length).every(node => /^stage\d\(\)$/.test(node.label))).toBe(true)
    expect(compactRetrieveResult(result).matched_nodes.filter(node => /^stage\d\(\)$/.test(node.label))).toHaveLength(decisions.length)
    expect(result.token_count).toBeLessThanOrEqual(3000)
  })

  it('does not let a shared HTTP handler name replace the requested behavior with unrelated call closures', () => {
    const { graph } = fixture({
      'src/orders.ts': 'export function POST() { return orderReceipt(); }\nfunction orderReceipt() { return "UNRELATED_ORDER_RECEIPT"; }',
      'src/uploads.ts': 'export function POST() { return uploadReceipt(); }\nfunction uploadReceipt() { return "UNRELATED_UPLOAD_RECEIPT"; }',
      'src/subscriptions.ts': 'export function cancelSubscription(account: any) {\n // Subscription cancellation through the POST endpoint persists the preference.\n account.preference = false;\n return "PERSISTED_CANCELLATION";\n}',
    })
    const result = retrieveContext(graph, {
      question: 'Trace subscription cancellation through POST.', taskKind: 'explain', budget: 3000,
    })
    expect(result.matched_nodes[0]?.source_file).toBe('src/subscriptions.ts')
    expect(result.matched_nodes.map(node => node.snippet).join('\n')).toContain('PERSISTED_CANCELLATION')
    const explicit = retrieveContext(graph, {
      question: 'In src/orders.ts explain POST() and its helper calls.', taskKind: 'explain', budget: 3000,
    })
    expect(explicit.matched_nodes.map(node => node.snippet).join('\n')).toContain('UNRELATED_ORDER_RECEIPT')
  })

  it('retains unresolved requested owners alongside a separate unique symbol', () => {
    const { graph } = fixture({
      'src/local.ts': 'export function runTask() { return "LOCAL_TASK"; }',
      'src/remote.ts': 'export function runTask() { return "REMOTE_TASK"; }',
      'src/cleanup.ts': 'export function cleanupTask() { return cleanupResult(); }\nfunction cleanupResult() { return "CLEANUP_RESULT"; }',
    })
    const result = retrieveContext(graph, {
      question: 'Trace runTask() and inspect cleanupTask().', taskKind: 'explain', budget: 5000,
    })
    const snippets = result.matched_nodes.map(node => node.snippet).join('\n')
    expect(snippets).toContain('LOCAL_TASK')
    expect(snippets).toContain('REMOTE_TASK')
    expect(snippets).toContain('CLEANUP_RESULT')
  })

  it('does not discard a class file scope merely because another file repeats the class name', () => {
    const { graph } = fixture(Object.fromEntries(['local', 'remote'].map(kind => [
      `src/${kind}.ts`, `export class Worker {\n run(input: string) {\n  return "${kind.toUpperCase()}_WORKER" + input;\n }\n}\n`,
    ])))
    const result = retrieveContext(graph, {
      question: 'In src/local.ts explain how Worker processes input and returns its result.', taskKind: 'explain', budget: 3000,
    })
    expect(result.matched_nodes.map(node => node.snippet).join('\n')).toContain('LOCAL_WORKER')
    expect(result.matched_nodes.every(node => node.source_file === 'src/local.ts')).toBe(true)
  })

  it('prefers the named-file owner per symbol while retaining cross-file dependencies and other requests', () => {
    const { graph } = fixture({
      'src/main.ts': 'import { headerVersion } from "../shared/header.js";\nexport function encodeArchive(input: string) {\n  return headerVersion() + input;\n}\n',
      'lib/browser.cjs': 'function encodeArchive(input) {\n  return "BROWSER_OWNER" + input;\n}\n',
      'types/archive.d.ts': 'export declare function encodeArchive(input: string): string;\n',
      'shared/header.ts': 'export function headerVersion() {\n  return "CROSS_FILE_HEADER";\n}\n',
      'support/upload.ts': 'export function readUpload() {\n  return "SEPARATE_REQUEST";\n}\n',
    })
    const result = retrieveContext(graph, {
      question: 'In src/main.ts find encodeArchive and explain how its helper call determines the return value. Also inspect readUpload.',
      taskKind: 'explain', budget: 5000,
    })
    expect(result.matched_nodes.filter(node => node.label === 'encodeArchive()').map(node => node.source_file)).toEqual(['src/main.ts'])
    const snippets = result.matched_nodes.map(node => node.snippet).join('\n')
    expect(snippets).toContain('CROSS_FILE_HEADER')
    expect(snippets).toContain('SEPARATE_REQUEST')
    expect(snippets).not.toContain('BROWSER_OWNER')
    const caller = result.matched_nodes.find(node => node.label === 'encodeArchive()')!
    const callee = result.matched_nodes.find(node => node.label === 'headerVersion()')!
    expect(result.relationships).toContainEqual(expect.objectContaining({ from_id: caller.node_id, to_id: callee.node_id, relation: 'calls' }))
  })

  it('preserves same-file CJS owner ambiguity and falls back when no concrete scoped owner exists', () => {
    const { graph, root } = fixture({
      'lib/node.cjs': 'function encodeArchive() {\n  return "NODE_FIRST";\n}\nfunction encodeArchive() {\n  return "NODE_SECOND";\n}\n',
      'lib/browser.cjs': 'function encodeArchive() {\n  return "BROWSER_OWNER";\n}\n',
      'types/archive.d.cts': 'export declare function encodeArchive(): string;\n',
    })
    graph.addNode('second_node_owner', { label: 'encodeArchive()', node_kind: 'function', file_type: 'code',
      source_file: join(root, 'lib/node.cjs'), source_location: 'L4-L6' })
    const retrieve = (prefix: string) => retrieveContext(graph, {
      question: `${prefix}find encodeArchive and explain how its return value is selected.`, taskKind: 'explain', budget: 5000,
    })
    const scoped = retrieve('In lib/node.cjs ')
    const scopedOwners = scoped.matched_nodes.filter(node => node.label === 'encodeArchive()')
    expect(scopedOwners).toHaveLength(2)
    expect(scopedOwners.every(node => node.source_file === 'lib/node.cjs')).toBe(true)
    expect(scopedOwners.map(node => node.snippet).join('\n')).toContain('NODE_FIRST')
    expect(scopedOwners.map(node => node.snippet).join('\n')).toContain('NODE_SECOND')
    for (const prefix of ['', 'In lib/missing.cjs ', 'In types/archive.d.cts ']) {
      const fallback = retrieve(prefix)
      expect(fallback.matched_nodes.filter(node => node.label === 'encodeArchive()').length).toBeGreaterThanOrEqual(2)
    }
    const overloaded = fixture({
      'src/overloaded.ts': 'export function encodeArchive(input: string): string; export function encodeArchive(input: unknown) { return String(input); }\n',
      'lib/browser.cjs': 'function encodeArchive(input) {\n  return "BROWSER_OWNER" + input;\n}\n',
    })
    const ambiguousLine = retrieveContext(overloaded.graph, {
      question: 'In src/overloaded.ts find encodeArchive and explain how its return value is selected.',
      taskKind: 'explain', budget: 5000,
    })
    expect(ambiguousLine.matched_nodes.some(node => node.source_file === 'lib/browser.cjs' && node.label === 'encodeArchive()')).toBe(true)
  })

  it.each(['count', 'input'])('does not interpret %s in a prose noun phrase as a symbol request', word => {
    const { graph } = fixture({
      'src/policy.ts': `export function classify(value: number) {\n // ${word} validation rejects negative records and records the exclusion reason.\n if (value < 0) return { reason: "NEGATIVE_RECORD" };\n return { reason: "ACCEPTED_RECORD" };\n}\n`,
      'src/metric.ts': `export function ${word}() { return "UNRELATED_METRIC"; }\n`,
    })
    const result = retrieveContext(graph, {
      question: `How does ${word} validation reject negative records, and which exclusion reason is recorded?`,
      taskKind: 'explain', budget: 3000,
    })
    expect(result.matched_nodes.some(node => node.snippet?.includes('NEGATIVE_RECORD'))).toBe(true)
    // Explicitly asking for the same ordinary name must still select it.
    for (const question of [`Explain the function ${word} and its dependencies`, `How does \`${word}\` work and which dependencies does it call?`]) {
      const explicit = retrieveContext(graph, { question, taskKind: 'explain', budget: 3000 })
      expect(explicit.matched_nodes.some(node => node.snippet?.includes('UNRELATED_METRIC'))).toBe(true)
      expect(explicit.matched_nodes.some(node => node.snippet?.includes('NEGATIVE_RECORD'))).toBe(false)
    }
  })

  it.each([
    'Where is retry policy exhausted?',
    'In this module, where is retry policy exhausted?',
    'In this state transition, where is retry policy exhausted?',
    'Which handler throws when retry policy is exhausted?',
    'Where is the retry policy exhausted in the next operation?',
    'Which handler throws "retry policy exhausted"?',
  ])('preserves source-body matches despite incidental framework vocabulary: %s', question => {
    const { graph } = fixture({
      'src/worker.ts': 'export function execute(value: { attempts: number }) {\n  if (value.attempts > 3) throw new Error("retry policy exhausted");\n  return value;\n}\n',
      'src/state.ts': 'export function stateVersion() { return 1; }\nexport function moduleVersion() { return 2; }\nexport function nextVersion() { return 3; }\n',
    })
    const result = retrieveContext(graph, { question, taskKind: 'explain', budget: 3000 })
    const body = result.matched_nodes.find(node => node.label === 'execute()')?.snippet
    expect(body).toContain('if (value.attempts > 3) throw new Error("retry policy exhausted")')
    expect(result.token_count).toBeLessThanOrEqual(3000)
  })

  it('keeps separate requested decisions from a named file instead of one bounded file excerpt', () => {
    const decisions = [
      'export function leaseLocation(linked: boolean) {\n  return linked ? "LINKED_LEASE_ROOT" : "LOCAL_LEASE_ROOT";\n}',
      'export function explicitLocation(path: string) {\n  return path || "DEFAULT_LEASE_PATH";\n}',
      'export function outputLocation(linked: boolean, path: string) {\n  return linked && path.startsWith("out/") ? "REDIRECT_OUTPUT" : path;\n}',
    ]
    const directoryDecision = [
      'export function validateLeaseSegments(segments: string[]) {',
      '  // Reject parent traversal segments before joining the lease path.',
      '  if (segments.includes("..")) throw new Error("PARENT_SEGMENT_REJECTED");',
      '  return segments.join("/");',
      '}',
    ].join('\n')
    const explicitOwner = 'export function sourceVersion() {\n  return "EXPLICIT_OWNER_OUTSIDE_SCOPE";\n}'
    const { graph } = fixture({
      'src/lease.ts': [...decisions, 'export function decorativeBadge() { return "UNRELATED_NAMED_FILE_BADGE"; }'].join('\n'.repeat(50)),
      'src/cli.ts': 'import { leaseLocation } from "./lease.js";\nexport function command() { return "UNRELATED_CALLER" + leaseLocation(true); }',
      'lib/lease-policy.ts': `${directoryDecision}\nexport function paletteColor() { return "UNRELATED_LIB_BADGE"; }`,
      'library/decoy-policy.ts': directoryDecision.replace('PARENT_SEGMENT_REJECTED', 'WRONG_DIRECTORY_PARENT_SEGMENT'),
      'lib/experimental/ignored-policy.ts': directoryDecision.replace('PARENT_SEGMENT_REJECTED', 'EXCLUDED_PARENT_SEGMENT'),
      'support/identity.ts': explicitOwner,
      'support/nearby.ts': 'export function sourceVersionNote() { return "UNREQUESTED_SIMILAR_OWNER"; }',
    })
    const scopedQuestion = 'Explain the location rules in src/lease.ts and under lib/: how a linked checkout obtains its lease location, when an explicitly supplied path is preserved, how an output path below out is redirected, and when parent traversal segments are rejected before joining the lease path. Exclude experimental. Keep each decision visible.'
    const result = retrieveContext(graph, {
      question: scopedQuestion,
      taskKind: 'explain', budget: 3000,
    })
    expect(result.selection_scope).toBe('task_context')
    const snippets = result.matched_nodes.map(node => node.snippet).join('\n')
    for (const decision of [...decisions, directoryDecision]) expect(snippets).toContain(decision)
    for (const unrelated of ['UNRELATED_CALLER', 'UNRELATED_NAMED_FILE_BADGE', 'UNRELATED_LIB_BADGE',
      'WRONG_DIRECTORY_PARENT_SEGMENT', 'EXCLUDED_PARENT_SEGMENT', 'EXPLICIT_OWNER_OUTSIDE_SCOPE', 'UNREQUESTED_SIMILAR_OWNER']) {
      expect(snippets).not.toContain(unrelated)
    }
    expect(result.matched_nodes.some(node => node.source_file.startsWith('library/'))).toBe(false)
    expect(result.matched_nodes.some(node => node.source_file.startsWith('lib/experimental/'))).toBe(false)
    expect(result.token_count).toBeLessThanOrEqual(3000)

    // Removing an exclusion clause must not join 'under' to the ./ path token.
    const relative = retrieveContext(graph, {
      question: scopedQuestion.replace('under lib/', 'under ./lib/'), taskKind: 'explain', budget: 3000,
    })
    const relativeSnippets = relative.matched_nodes.map(node => node.snippet).join('\n')
    for (const decision of [...decisions, directoryDecision]) expect(relativeSnippets).toContain(decision)
    expect(relativeSnippets).not.toContain('WRONG_DIRECTORY_PARENT_SEGMENT')
    expect(relativeSnippets).not.toContain('EXCLUDED_PARENT_SEGMENT')
    expect(relative.token_count).toBeLessThanOrEqual(3000)

    const explicit = retrieveContext(graph, {
      question: `${scopedQuestion} Also include sourceVersion().`, taskKind: 'explain', budget: 3000,
    })
    const explicitId = graph.nodeEntries().find(([, node]) => node.label === 'sourceVersion()')![0]
    expect(explicit.matched_nodes.find(node => node.node_id === explicitId)?.snippet).toBe(explicitOwner)
    const explicitSnippets = explicit.matched_nodes.map(node => node.snippet).join('\n')
    for (const unrelated of ['UNREQUESTED_SIMILAR_OWNER', 'UNRELATED_NAMED_FILE_BADGE', 'UNRELATED_LIB_BADGE',
      'WRONG_DIRECTORY_PARENT_SEGMENT', 'EXCLUDED_PARENT_SEGMENT']) expect(explicitSnippets).not.toContain(unrelated)
    expect(explicit.token_count).toBeLessThanOrEqual(3000)

    const callers = retrieveContext(graph, {
      question: 'Explain the location rules in src/lease.ts and which callers use these decisions.',
      taskKind: 'explain', budget: 3000,
    })
    expect(callers.matched_nodes.map(node => node.snippet).join('\n')).toContain('UNRELATED_CALLER')
  })

  it.each([
    liveQuestion,
    'How do content sessions calculate reused_token_count and token_count, advance revision, and handle duplicate refs? Show the relevant source.',
    'Explain how content sessions compare previous hashes to identify added, updated, reused and invalidated refs, account for token counts, and reject duplicate refs.',
    'Where is reused_token_count computed and how are duplicate refs rejected, previous hashes compared, and the next revision determined?',
  ])('retains the executing branches for %s', question => {
    const { graph } = sessionFixture()
    const result = retrieveContext(graph, { question, taskKind: 'explain', budget: 5000 })
    expect(result.selection_scope).toBe('task_context')
    const body = result.matched_nodes.find(node => node.label === 'buildContextSession()')?.snippet
    for (const branch of ['Duplicate context session ref:', 'previousRef.hash !== hash', 'baseState.refs[ref]?.token_count', 'revision: baseState.revision + 1']) {
      expect(body, branch).toContain(branch)
    }
  })

  it('ranks distinct evidence before the bounded source-match cap', () => {
    const { graph, root } = sessionFixture(140)
    const result = searchSourceBodies(graph, liveQuestion, root)
    const targetId = [...graph.nodeEntries()].find(([, node]) => node.label === 'buildContextSession()')![0]
    expect(result.bounded).toBe(true)
    expect(result.matches.size).toBe(128)
    expect([...result.matches.keys()][0]).toBe(targetId)
    expect(result.matches.get(targetId)?.matched_literals).toEqual(expect.arrayContaining(['reused_token_count', 'token_count']))
    const firstDistractor = [...result.matches.entries()].find(([id]) => id !== targetId && id.includes('report'))![1]
    expect(result.matches.get(targetId)!.coverage).toBeGreaterThan(firstDistractor.coverage)
  })

  it('handles a behavior question about different fields and control flow', () => {
    const { graph } = fixture({
      'src/retry.ts': [
        'export function dispatchBatch(batch: any[], previous: any) {',
        '  const failed_items = batch.filter(item => !item.accepted);',
        '  if (previous.retry_count >= 3) throw new Error("RETRY_LIMIT");',
        '  const retry_count = previous.retry_count + 1;',
        '  return { failed_items, retry_count, elapsed_ms: Date.now() - previous.startedAt };',
        '}',
      ].join('\n'),
      ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`src/retry-report-${index}.ts`, `export function retryCountElapsedReport${index}(previous: any) { return { retry_count: previous.retry_count, elapsed_ms: 0 }; }`])),
    })
    const result = retrieveContext(graph, { question: 'How are failed_items selected, retry_count incremented and elapsed_ms calculated, and when does a batch stop retrying? Find the source.', taskKind: 'explain', budget: 4000 })
    expect(result.selection_scope).toBe('task_context')
    const body = result.matched_nodes.find(node => node.label === 'dispatchBatch()')?.snippet
    expect(body).toContain('batch.filter(item => !item.accepted)')
    expect(body).toContain('previous.retry_count >= 3')
    expect(body).toContain('previous.retry_count + 1')
    expect(body).toContain('Date.now() - previous.startedAt')
  })

  it('keeps ordering stable across mixed source, symbol and framework candidates', () => {
    const { graph, root } = fixture({
      'src/processor.ts': [
        'export function processBatch(items: any[], revision: number) {',
        '  const seen = new Set<string>();',
        '  for (const item of items) {',
        '    if (seen.has(item.id)) throw new Error("duplicate");',
        '    seen.add(item.id);',
        '  }',
        '  return { accepted: items.length, revision: revision + 1 };',
        '}',
      ].join('\n'),
    })
    const source = [...graph.nodeEntries()].find(([, node]) => node.label === 'processBatch()')!
    const candidates = [
      { id: source[0], ...source[1], framework: 'express', framework_role: 'express_handler' },
      { id: 'handler', label: 'handler()', node_kind: 'function', file_type: 'code', source_file: join(root, 'src', 'missing-handler.ts'), source_location: 'L1', framework: 'express', framework_role: 'express_handler' },
      { id: 'route', label: 'route()', node_kind: 'function', file_type: 'code', source_file: join(root, 'src', 'missing-route.ts'), source_location: 'L1', framework: 'express', framework_role: 'express_route' },
    ]
    const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
    const results = permutations.map(order => {
      const reordered = buildFromJson({ schema_version: 1, nodes: order.map(index => candidates[index]!), edges: [] }, { directed: true })
      reordered.graph.root_path = root
      return retrieveContext(reordered, { question: 'How does an Express handler accept items, reject duplicate records, and update revision?', taskKind: 'explain', budget: 4000 })
    })
    expect(results[0]!.matched_nodes.some(node => node.snippet?.includes('seen.has(item.id)'))).toBe(true)
    for (const result of results.slice(1)) {
      expect(result.matched_nodes.map(node => node.node_id)).toEqual(results[0]!.matched_nodes.map(node => node.node_id))
    }
  })

  it.each([
    ['Explain processRequest', 'symbol_lookup'],
    ['Where is ACCESS_DENIED thrown?', 'symbol_lookup'],
    ['Find occurrences of `ACCESS_DENIED`', 'symbol_lookup'],
    ['Show src/handler.ts', 'file_lookup'],
  ] as const)('preserves focused lookup for %s', (question, scope) => {
    const { graph } = fixture({
      'src/handler.ts': 'export function processRequest(allowed: boolean) { if (!allowed) throw new Error("ACCESS_DENIED"); return true; }',
      'src/caller.ts': 'export function callHandler() { return processRequest(true); }',
      'src/metrics.ts': 'export function reportAccessDenied() { return "ACCESS_DENIED_METRIC"; }',
    })
    const result = retrieveContext(graph, { question, taskKind: 'explain', budget: 3000 })
    expect(result.selection_scope).toBe(scope)
    expect(result.matched_nodes).toHaveLength(1)
    expect(result.matched_nodes[0]?.source_file).toBe('src/handler.ts')
    expect(result.matched_nodes[0]?.snippet).toContain('throw new Error("ACCESS_DENIED")')
  })
})
