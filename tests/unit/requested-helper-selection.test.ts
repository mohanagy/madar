import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'
import { sourceRequestedHelpers, selectRequestedHelperOwners } from '../../src/runtime/retrieve/source-requested-helpers.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'madar-requested-helper-'))
  roots.push(root)
  const fragments = Object.entries(files).map(([file, source]) => {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
    return extractJs(path)
  })
  const graph = buildFromJson({ schema_version: 1, nodes: fragments.flatMap(f => f.nodes), edges: fragments.flatMap(f => f.edges) }, { directed: true })
  graph.graph.root_path = root
  return { graph, root }
}

describe('bounded requested helper admission', () => {
  it('retains explicit lowercase helper list owners from the named file under the existing budget', () => {
    const names = ['pad', 'plen', 'tail', 'fail']
    const { graph } = fixture({
      'src/packet.ts': [
        'export function packetEntry() { return "PRIMARY_ENTRY"; }',
        ...names.map(name => `const ${name} = function () { return "REQUESTED_${name.toUpperCase()}"; };`),
        'function decoration() { return "UNREQUESTED_DECORATION"; }',
      ].join('\n'.repeat(30)),
      'lib/browser.ts': names.map(name => `function ${name}() { return "WRONG_FILE_${name}"; }`).join('\n'),
    })
    const before = JSON.stringify([graph.nodeEntries(), graph.edgeEntries()])
    const question = 'In src/packet.ts find packetEntry and explain its implementation. Include pad, plen, tail and relevant failure handling. Also locate the fail helper.'
    expect(sourceRequestedHelpers(question).map(item => item.name)).toEqual(['fail', 'pad', 'plen', 'tail'])
    const result = retrieveContext(graph, { question, taskKind: 'explain', budget: 5000 })
    for (const name of names) {
      expect(result.matched_nodes.filter(node => node.label === `${name}()`).map(node => node.source_file)).toEqual(['src/packet.ts'])
      expect(result.matched_nodes.find(node => node.label === `${name}()`)?.snippet).toContain(`REQUESTED_${name.toUpperCase()}`)
    }
    expect(result.token_count).toBeLessThanOrEqual(5000)
    expect(result.matched_nodes.map(node => node.snippet).join('\n')).not.toContain('WRONG_FILE_')
    expect(result.relationships.filter(edge => edge.relation === 'calls')).toEqual([])
    expect(JSON.stringify([graph.nodeEntries(), graph.edgeEntries()])).toBe(before)
  })

  it('does not admit prose, quoted data, exclusions or missing/ambiguous/current-source-mismatched owners', () => {
    const query = 'In src/packet.ts inspect the implementation. Include pad, plen and tail.'
    const lines = ['function pad() { return 1; }', 'function plen() { return 2; }', 'function tail() { return 3; }']
    const owners = lines.map((_, index) => ({ id: String(index), label: `${['pad', 'plen', 'tail'][index]}()`, range: { start: index + 1, end: index + 1 } }))
    for (const question of [
      'In src/packet.ts explain how input, count and mode determine the result.',
      'In src/packet.ts inspect the implementation. Include "pad, plen and tail" as example data.',
      'In src/packet.ts inspect the implementation. The sample says "locate the pad helper".',
      'In src/packet.ts inspect the implementation. Include pad, plen and tail as data values.',
    ]) expect(sourceRequestedHelpers(question)).toEqual([])
    expect(selectRequestedHelperOwners(query, [], lines, 'src/packet.ts')).toEqual([])
    expect(selectRequestedHelperOwners(query, owners, [...lines, 'function pad() { return 4; }'], 'src/packet.ts')).toEqual(['1', '2'])
    expect(selectRequestedHelperOwners(query, [...owners, { ...owners[0]!, id: 'duplicate' }], lines, 'src/packet.ts')).toEqual(['1', '2'])
    expect(selectRequestedHelperOwners(query, [{ ...owners[0]!, range: { start: 2, end: 2 } }], lines, 'src/packet.ts')).toEqual([])
    expect(selectRequestedHelperOwners(query, owners, [...lines, 'function broken('], 'src/packet.ts')).toEqual([])
    const sharedLine = ['function pad() {} function plen() {} function tail() {}']
    const sharedOwners = owners.map(owner => ({ ...owner, range: { start: 1, end: 1 } }))
    expect(selectRequestedHelperOwners(query, sharedOwners, sharedLine, 'src/packet.ts')).toEqual([])
    // A differently named overload without a body still competes for L1.
    expect(selectRequestedHelperOwners(query, [sharedOwners[0]!], ['declare function other(): void; function pad() {}'], 'src/packet.ts')).toEqual([])
    expect(selectRequestedHelperOwners(query, [sharedOwners[0]!], ['const pad = () => 1; obj.other = function () {};'], 'src/packet.ts')).toEqual([])
    expect(selectRequestedHelperOwners(query, [sharedOwners[0]!], ['function pad() {} class X { constructor() {} }'], 'src/packet.ts')).toEqual([])
    expect(selectRequestedHelperOwners(query, [sharedOwners[0]!], ['const pad = () => 1; class X { other = () => 2 }'], 'src/packet.ts')).toEqual([])
    const { graph } = fixture({ 'src/packet.ts': ['function packetEntry() { return "ENTRY"; }', ...lines].join('\n'.repeat(30)) })
    const excluded = retrieveContext(graph, { question: 'In src/packet.ts find packetEntry and explain its implementation. Include pad, plen and tail. Exclude pad.', taskKind: 'explain', budget: 3000 })
    expect(excluded.matched_nodes.some(node => node.label === 'pad()')).toBe(false)
  })
})
