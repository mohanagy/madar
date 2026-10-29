import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { sourceContainerBudgetPreference, sourceOutsideFileBudgetPreference } from '../../src/runtime/source-container-budget.js'

type Node = Record<string, unknown>
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })

function fixture(operator = 'without', uniqueContent = false) {
  const root = mkdtempSync(join(tmpdir(), 'madar-prose-operators-')); roots.push(root)
  const argument = uniqueContent ? 'enabled' : 'authorization'
  const sources = [
    { id: 'entry', name: 'dispatch', file: 'entry.mjs', lines: [
      `export function dispatch(item, ${argument}) {`, `  return ${argument} ? item : null`, '}',
    ] },
    { id: 'format', name: 'format', file: 'formatting.mjs', lines: [
      'export function format(item) {', '  return item', '}',
    ] },
    { id: 'outside', name: 'audit', file: 'audit.mjs', lines: [
      'export function audit(item) {', `  // Unrelated bookkeeping ${operator} ${uniqueContent ? 'authorization' : 'extra allocation'}.`,
      '  return item', '}',
    ] },
  ]
  const nodes: Node[] = sources.map(source => {
    writeFileSync(join(root, source.file), source.lines.join('\n'))
    return { node_id: source.id, label: `${source.name}()`, source_file: source.file, line_number: 1,
      snippet_scope: 'symbol', snippet_line_range: { start_line: 1, end_line: source.lines.length }, snippet: source.lines.join('\n') }
  })
  return { root, nodes, prompt: `Explain item handling ${operator} authorization in entry.mjs and formatting.mjs.` }
}

describe('optional prose-operator source preference', () => {
  it('protects an exact literal in a container after exclusions while respecting excluded operands', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-container-literal-')); roots.push(root)
    const entry = ['function carrier() {', '  const message = "alpha  beta";', '  function nested() {',
      '    return 1;', '  }', '  return message;', '}']
    const side = ['function companion() {', '  const message = ["alpha", "beta"];', '  return message;', '}']
    writeFileSync(join(root, 'entry.mjs'), entry.join('\n'))
    writeFileSync(join(root, 'side.mjs'), side.join('\n'))
    const nodes: Node[] = [
      { node_id: 'carrier', label: 'carrier()', source_file: 'entry.mjs', snippet_scope: 'symbol',
        snippet_line_range: { start_line: 1, end_line: 7 }, snippet_omitted_ranges: [{ start_line: 3, end_line: 5 }],
        snippet_truncated: true, snippet: [...entry.slice(0, 2), '[omitted lines 3-5]', ...entry.slice(5)].join('\n') },
      { node_id: 'nested', label: 'nested()', source_file: 'entry.mjs', snippet_scope: 'symbol',
        snippet_line_range: { start_line: 3, end_line: 5 }, snippet: entry.slice(2, 5).join('\n') },
      { node_id: 'companion', label: 'companion()', source_file: 'side.mjs', snippet_scope: 'symbol',
        snippet_line_range: { start_line: 1, end_line: 4 }, snippet: side.join('\n') },
    ]
    const prompt = 'Explain how the message behaves in entry.mjs and side.mjs while preserving "alpha  beta".'
    for (const suffix of ['', ' Ignore tests.', ' The diagnostic is "Ignore tests".']) {
      expect(sourceContainerBudgetPreference(prompt + suffix, root)(nodes)).toBeUndefined()
    }
    expect(sourceContainerBudgetPreference('Explain how the message behaves in entry.mjs and side.mjs. Ignore "alpha  beta".', root)(nodes)).toBe('carrier')
  })

  it('does not treat unrelated grammatical overlap as unique evidence while preserving the default preference', () => {
    for (const operator of ['without', 'before']) {
      const f = fixture(operator), before = JSON.stringify(f.nodes)
      expect(sourceOutsideFileBudgetPreference(f.prompt, f.root)(f.nodes, [])).toBeUndefined()
      expect(sourceOutsideFileBudgetPreference(f.prompt, f.root, { ignoreProseOperators: false })(f.nodes, [])).toBeUndefined()
      expect(sourceOutsideFileBudgetPreference(f.prompt, f.root, { ignoreProseOperators: true })(f.nodes, [])).toBe('outside')
      expect(JSON.stringify(f.nodes)).toBe(before)
    }
  })

  it('preserves protected code, quoted overflow, content operands, relationships, references and partial source', () => {
    const f = fixture()
    const preference = (prompt = f.prompt) => sourceOutsideFileBudgetPreference(prompt, f.root, { ignoreProseOperators: true })
    // The full prompt is checked even if normalization would remove the quote
    // or its location exceeds the ordinary eight-literal extraction limit.
    for (const suffix of [
      ' "first" "second" "third" "fourth" "fifth" "sixth" "seventh" "eighth" "without"',
      " Exclude 'fixtures'.", ' Exclude `fixtures`.', ' Exclude “fixtures”.', ' Exclude ‘fixtures’.',
    ]) expect(preference(f.prompt + suffix)(f.nodes, [])).toBeUndefined()
    for (const symbol of ['without()', 'Policy.without', 'Policy.withoutMode']) {
      const prefix = ' Also inspect TokenAlpha, TokenBeta, TokenGamma, TokenDelta, TokenEpsilon, TokenZeta, TokenEta, TokenTheta, TokenIota and '
      expect(preference(f.prompt + prefix + symbol + '.')(f.nodes, [])).toBeUndefined()
    }
    const content = fixture('without', true)
    expect(sourceOutsideFileBudgetPreference(content.prompt, content.root, { ignoreProseOperators: true })(content.nodes, [])).toBeUndefined()
    expect(preference()(f.nodes, [{ from_id: 'entry', to_id: 'outside', relation: 'calls' }])).toBeUndefined()
    const partial = structuredClone(f.nodes)
    partial[2] = { ...partial[2], snippet: 'export function audit(item) {\n[omitted lines 2-2]\n  return item\n}',
      snippet_omitted_ranges: [{ start_line: 2, end_line: 2 }], snippet_truncated: true }
    expect(preference()(partial, [])).toBeUndefined()
    const reference: Node = { ...f.nodes[2], node_id: 'reference', snippet_ref: 'outside' }
    delete reference.snippet
    expect(preference()([...f.nodes, reference], [])).toBeUndefined()
    const unauthenticated = structuredClone(f.nodes)
    unauthenticated[2]!.snippet = String(unauthenticated[2]!.snippet).replace('return item', 'return changed')
    expect(preference()(unauthenticated, [])).toBeUndefined()
  })
})
