import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })

function workspace(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'madar-file-owner-')); roots.push(root)
  const graph = new KnowledgeGraph({ directed: true })
  graph.graph.root_path = root
  const add = (name: string, source: string, attributes: Record<string, unknown> = {}) => {
    const path = join(root, name)
    writeFileSync(path, source)
    graph.addNode(name, { label: basename(path), file_type: 'code', source_file: path, source_location: 'L1',
      snippet: source, ...attributes })
    if (name !== 'registry.ts') graph.addEdge('registry.ts', name, { relation: 'references' })
    return path
  }
  add('registry.ts', '// registry inventory\nexport const registry = 1;\n')
  for (const [name, source] of Object.entries(files)) add(name, source)
  const retrieve = () => retrieveContext(graph, { question: 'registry inventory', budget: 1, retrievalLevel: 5, taskKind: 'explain' })
  return { root, graph, add, retrieve }
}

function ranges(result: ReturnType<typeof retrieveContext>, root: string, path?: string) {
  return (result.expandable ?? []).flatMap(ref => ref.follow_up.focus_ranges ?? [])
    .filter(range => !path || resolve(root, range.source_file) === path)
}

describe('verified file-owner generic expansion ranges', () => {
  it('delivers or advertises the current full file while preserving symbol ranges and indexed metadata', () => {
    const source = ['// registry inventory', 'export function first() {', '  return 1;', '}',
      'export function second() {', '  return 2;', '}', ''].join('\n')
    const f = workspace({ 'functions.ts': source }), path = join(f.root, 'functions.ts')
    const extracted = extractJs(path)
    // Keep the actual indexed file owner, whose normal location is the file entry point.
    const file = extracted.nodes.find(node => node.label === 'functions.ts')!
    f.graph.addNode('functions.ts', { ...file, source_location: 'L1' })
    for (const node of extracted.nodes.filter(node => node.label !== 'functions.ts')) {
      f.graph.addNode(node.id, node)
      f.graph.addEdge('registry.ts', node.id, { relation: 'references' })
    }
    const before = JSON.stringify(f.graph.nodeEntries())
    const result = f.retrieve(), scoped = ranges(result, f.root, path)
    const wholeFile = { start_line: 1, end_line: source.split('\n').length }
    const delivered = result.matched_nodes.find(node => node.node_id === 'functions.ts')
    if (delivered) {
      expect(delivered.snippet).toBe(source)
      expect(delivered.snippet_line_range).toEqual(wholeFile)
      expect(resolve(f.root, delivered.source_file)).toBe(path)
    } else {
      expect(scoped).toContainEqual({ source_file: 'functions.ts', ...wholeFile })
    }
    for (const range of scoped.filter(range => range.start_line !== 1)) {
      expect([{ start_line: 2, end_line: 4 }, { start_line: 5, end_line: 7 }]).toContainEqual({
        start_line: range.start_line, end_line: range.end_line })
    }
    expect(scoped.some(range => range.start_line === 2 || range.start_line === 5)).toBe(true)
    expect(JSON.stringify(f.graph.nodeEntries())).toBe(before)
    expect(f.retrieve().expandable).toEqual(result.expandable)
  })

  it('retains indexed point scopes for ambiguous or non-file identities', () => {
    const text = '// registry inventory\nexport const value = 1;\n'
    const f = workspace({ 'duplicate.ts': text, 'case.ts': text, 'kind.ts': text, 'range.ts': text })
    f.graph.addNode('duplicate-again', { ...f.graph.nodeAttributes('duplicate.ts') })
    f.graph.addEdge('registry.ts', 'duplicate-again', { relation: 'references' })
    f.graph.addNode('case.ts', { ...f.graph.nodeAttributes('case.ts'), label: 'CASE.ts' })
    f.graph.addNode('kind.ts', { ...f.graph.nodeAttributes('kind.ts'), node_kind: 'function' })
    f.graph.addNode('range.ts', { ...f.graph.nodeAttributes('range.ts'), source_location: 'L1-L999' })
    const result = f.retrieve()
    for (const name of ['duplicate.ts', 'case.ts', 'kind.ts']) {
      const scoped = ranges(result, f.root, join(f.root, name))
      expect(scoped.length).toBeGreaterThan(0)
      expect(scoped.every(range => range.start_line === 1 && range.end_line === 1)).toBe(true)
    }
    expect(ranges(result, f.root, join(f.root, 'range.ts'))).toContainEqual({ source_file: 'range.ts', start_line: 1, end_line: 999 })
  })

  it('does not widen disallowed, escaping or oversized file references', () => {
    const f = workspace({})
    const outside = mkdtempSync(join(tmpdir(), 'madar-file-owner-outside-')); roots.push(outside)
    writeFileSync(join(outside, 'private.ts'), '// registry inventory\nexport const value = 1;\n')
    const linked = join(f.root, 'linked.ts')
    symlinkSync(join(outside, 'private.ts'), linked)
    f.graph.addNode('linked.ts', { label: 'linked.ts', file_type: 'code', source_file: linked, source_location: 'L1', snippet: '// registry inventory' })
    f.graph.addEdge('registry.ts', 'linked.ts', { relation: 'references' })
    f.add('notes.md', '// registry inventory\nprivate source\n')
    f.add('large.ts', '// registry inventory\n' + 'x'.repeat(300 * 1024) + '\n')
    const result = f.retrieve()
    for (const name of ['linked.ts', 'notes.md', 'large.ts']) {
      const scoped = ranges(result, f.root, join(f.root, name))
      expect(scoped.length).toBeGreaterThan(0)
      expect(scoped.every(range => range.start_line === 1 && range.end_line === 1)).toBe(true)
    }
  })

  it('bounds new file scopes across recovery passes and admitted source bytes', () => {
    const small = workspace(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [
      `part-${i}.ts`, '// registry inventory\nexport const value = 1;\n',
    ])))
    const smallRanges = ranges(small.retrieve(), small.root)
    expect(smallRanges.filter(range => range.end_line > 1)).toHaveLength(32)
    expect(smallRanges.some(range => range.end_line === 1)).toBe(true)
    const large = workspace(Object.fromEntries(Array.from({ length: 14 }, (_, i) => [
      `part-${i}.ts`, '// registry inventory\nexport const value = "' + 'x'.repeat(96 * 1024) + '";\n',
    ])))
    const largeRanges = ranges(large.retrieve(), large.root)
    const admitted = largeRanges.filter(range => range.end_line > 1)
    expect(admitted.length).toBeGreaterThan(0)
    expect(largeRanges.some(range => range.end_line === 1)).toBe(true)
    const bytes = [...new Set(admitted.map(range => range.source_file))]
      .reduce((sum, file) => sum + Buffer.byteLength(readFileSync(resolve(large.root, file), 'utf8')), 0)
    expect(bytes).toBeLessThanOrEqual(1024 * 1024)
  })
})
