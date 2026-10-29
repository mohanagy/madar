import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { completeSourceFileCandidates } from '../../src/runtime/source-read-context.js'
import { finalizeSourceEvidenceResponse, resolveSourceSnippet } from '../../src/runtime/source-evidence-response.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'

type Node = Record<string, unknown>
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'madar-source-read-'))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const node = (path: string, start: number, end: number, id = path): Node => ({
    node_id: id, label: id, source_file: path, line_number: start,
    snippet: readFileSync(join(root, path), 'utf8').split(/\r?\n/).slice(start - 1, end).join('\n'),
    snippet_line_range: { start_line: start, end_line: end }, snippet_scope: 'symbol',
  })
  return { root, node }
}

const implementation = 'export function processItem(value: string) {\n  return normalize(value);\n}'
const source = `import { normalize } from './util.js';\n\n${implementation}\n`
function response(nodes: Node[], extra: Record<string, unknown> = {}) {
  return { task: 'implement', pack: { matched_nodes: nodes, relationships: [] },
    evidence: { answerability: { advisory: true, broad_search_fallback: 'allowed' } }, ...extra }
}
function selected(output: Record<string, unknown>): Node[] {
  return (output.pack as { matched_nodes?: Node[] } | undefined)?.matched_nodes ?? []
}

describe('bounded source-read context', () => {
  it('supplies complete small-file imports with source scope and exact line addressing', () => {
    const { root, node } = fixture({ 'item.ts': source })
    const input = response([node('item.ts', 3, 5)])
    const output = finalizeSourceEvidenceResponse(input, 2000, { sourceRoot: root })
    expect(selected(output)).toHaveLength(1)
    expect(selected(output)[0]).toMatchObject({
      node_id: 'item.ts', line_number: 3, snippet: source, snippet_scope: 'source_file',
      snippet_line_range: { start_line: 1, end_line: 6 }, snippet_file_complete: true,
    })
    expect((output.pack as Node).source_read).toContain('read for this response')
    expect(output.serialized_budget).toMatchObject({ token_count: estimateQueryTokens(JSON.stringify(output)) })
    expect(input.pack.matched_nodes[0]?.snippet).toBe(implementation)
  })

  it('preserves every originally deliverable body when imports cannot fit the remaining wire budget', () => {
    const longImport = `import { normalize } from '${'module/'.repeat(160)}util.js';`
    const other = 'export function otherItem() {\n  return 17;\n}'
    const { root, node } = fixture({ 'item.ts': `${longImport}\n\n${implementation}\n`, 'other.ts': other })
    const input = response([node('item.ts', 3, 5), node('other.ts', 1, 3)])
    const roomyBaseline = finalizeSourceEvidenceResponse(input, 10000)
    const budget = estimateQueryTokens(JSON.stringify(roomyBaseline)) + 8
    const baseline = finalizeSourceEvidenceResponse(input, budget)
    const output = finalizeSourceEvidenceResponse(input, budget, { sourceRoot: root })
    expect(output).toEqual(baseline)
    expect(selected(output).map(entry => entry.snippet)).toEqual([implementation, other])
    expect(estimateQueryTokens(JSON.stringify(output))).toBeLessThanOrEqual(budget)
  })

  it('retains the baseline omission result when the original response itself exceeds budget', () => {
    const { root, node } = fixture({ 'item.ts': source })
    const input = response(Array.from({ length: 10 }, (_, i) => ({ ...node('item.ts', 3, 5, `item-${i}`), note: 'irrelevant' })))
    const baseline = finalizeSourceEvidenceResponse(input, 128)
    expect(finalizeSourceEvidenceResponse(input, 128, { sourceRoot: root })).toEqual(baseline)
  })

  it.each([
    ['same-line side effect', `import { normalize } from './util.js'; startBackgroundJob();\n\n${implementation}\n`],
    ['unselected sibling', `${source}export function unrelatedOperation() { return 99; }\n`],
    ['unselected top-level state', `const mode = loadRuntimeMode();\n\n${implementation}\n`],
    ['unselected comment', `// Configuration instructions not previously delivered\n\n${implementation}\n`],
  ])('does not introduce %s outside the selected source', (_label, text) => {
    const { root, node } = fixture({ 'item.ts': text })
    const input = response([node('item.ts', 3, 5)])
    expect(completeSourceFileCandidates(input.pack.matched_nodes, root)).toEqual([])
    expect(finalizeSourceEvidenceResponse(input, 2000, { sourceRoot: root }))
      .toEqual(finalizeSourceEvidenceResponse(input, 2000))
  })

  it('does not complete an internal executable gap even when both boundary excerpts match', () => {
    const { root, node } = fixture({ 'item.ts': source })
    expect(completeSourceFileCandidates([node('item.ts', 3, 3), node('item.ts', 5, 5)], root)).toEqual([])
  })

  it('refuses mismatched, omitted, unverified, missing, and malformed selected excerpts', () => {
    const { root, node } = fixture({ 'item.ts': source })
    const original = node('item.ts', 3, 5)
    const invalid: Node[] = [
      { ...original, snippet: implementation.replace('normalize(value)', 'value') },
      { ...original, snippet: null },
      { ...original, snippet_unverified: true },
      { ...original, snippet_truncated: true },
      { ...original, snippet_omitted_ranges: [{ start_line: 4, end_line: 4 }] },
      { ...original, snippet_line_range: { start_line: 0, end_line: 5 } },
      { ...original, source_file: 'missing.ts' },
    ]
    for (const entry of invalid) expect(completeSourceFileCandidates([entry], root)).toEqual([])
    writeFileSync(join(root, 'item.ts'), source.replace('normalize(value)', 'changed(value)'))
    expect(completeSourceFileCandidates([original], root)).toEqual([])
  })

  it('reads current imports when the selected body still matches', () => {
    const { root, node } = fixture({ 'item.ts': source })
    const original = node('item.ts', 3, 5)
    const updated = source.replace('./util.js', './current-util.js')
    writeFileSync(join(root, 'item.ts'), updated)
    const output = finalizeSourceEvidenceResponse(response([original]), 2000, { sourceRoot: root })
    expect(selected(output)[0]?.snippet).toBe(updated)
  })

  it('does not expand source outside the root or through sensitive/non-source symlink targets', () => {
    const { root, node } = fixture({ 'item.ts': source, '.env.ts': source, 'secret.json': source })
    const outside = fixture({ 'outside.ts': source })
    symlinkSync(join(outside.root, 'outside.ts'), join(root, 'outside-link.ts'))
    symlinkSync(join(root, 'secret.json'), join(root, 'json-link.ts'))
    const original = node('item.ts', 3, 5)
    for (const path of [join(outside.root, 'outside.ts'), 'outside-link.ts', 'json-link.ts', '.env.ts']) {
      expect(completeSourceFileCandidates([{ ...original, source_file: path }], root)).toEqual([])
    }
  })

  it('honors file size/line bounds and rejects parse errors', () => {
    const { root, node } = fixture({ 'item.ts': source })
    const original = node('item.ts', 3, 5)
    for (const text of [source + '\n'.repeat(81), source + ' '.repeat(12001), `import { broken from './bad';\n\n${implementation}\n`]) {
      writeFileSync(join(root, 'item.ts'), text)
      expect(completeSourceFileCandidates([original], root)).toEqual([])
    }
  })

  it.each([false, true])('keeps existing reference subranges exact, including forward references=%s', forwardReference => {
    const { root, node } = fixture({ 'item.ts': source })
    const original = node('item.ts', 3, 5, 'first')
    const first = forwardReference ? { ...original, snippet: undefined, snippet_ref: 'second' } : original
    const second = forwardReference ? { ...original, node_id: 'second' } : { ...original, node_id: 'second', snippet: undefined, snippet_ref: 'first' }
    const output = finalizeSourceEvidenceResponse(response([first, second]), 2000, { sourceRoot: root })
    const nodes = selected(output)
    expect(nodes[0]?.snippet).toBe(source)
    expect(nodes[1]).toMatchObject({ snippet_ref: 'first', snippet_line_range: { start_line: 3, end_line: 5 } })
    expect(resolveSourceSnippet(nodes[1]!, nodes)).toBe(implementation)
    expect(nodes.filter(entry => typeof entry.snippet === 'string')).toHaveLength(1)
  })

  it('does not enrich delta, explain, verbose, or text responses', () => {
    const { root, node } = fixture({ 'item.ts': source })
    const base = response([node('item.ts', 3, 5)])
    for (const input of [{ ...base, mode: 'delta' }, { ...base, delta_session_id: 'session' }, { ...base, task: 'explain' }]) {
      expect(finalizeSourceEvidenceResponse(input, 2000, { sourceRoot: root })).toEqual(finalizeSourceEvidenceResponse(input, 2000))
    }
    for (const options of [{ verbose: true }, { format: 'text' as const }]) {
      expect(finalizeSourceEvidenceResponse(base, 2000, { ...options, sourceRoot: root })).toEqual(finalizeSourceEvidenceResponse(base, 2000, options))
    }
    const summarized = response([{ ...node('item.ts', 3, 5), snippet: null }])
    expect(finalizeSourceEvidenceResponse(summarized, 2000, { sourceRoot: root })).toEqual(finalizeSourceEvidenceResponse(summarized, 2000))
  })
})
