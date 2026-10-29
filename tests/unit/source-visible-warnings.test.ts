import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { selectSourceDependencies, sourceSelectionProvenanceKey } from '../../src/runtime/retrieve/source-dependencies.js'
import { sourceVisibleWarnings } from '../../src/runtime/retrieve/source-visible-warnings.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-visible-warnings-')))
  roots.push(root)
  mkdirSync(join(root, 'src'))
  const lines = [
    'export function selectedRoot() { return 1; }',
    'export class Worker {',
    '  run(port: { send(value: string): void }) { return port.send(',
    '    "payload"',
    '  ); }',
    '}',
  ]
  const file = join(root, 'src/worker.ts')
  writeFileSync(file, lines.join('\n'))
  const extracted = extractJs(file)
  const graph = buildFromJson({ schema_version: 1, nodes: extracted.nodes, edges: extracted.edges }, { directed: true })
  graph.graph.root_path = root
  const selected = graph.nodeEntries().find(([, node]) => node.label === 'selectedRoot()')![0]
  const method = graph.nodeEntries().find(([, node]) => node.label === '.run()')![0]
  // A legacy point index is valid identity evidence, but it is not the full
  // declaration range. The real source inspector must supply that boundary.
  graph.addNode(method, { ...graph.nodeAttributes(method), source_location: 'L3' })
  const result = selectSourceDependencies(graph, [selected], root, new Map(), { includeCallers: false })
  const provenance = result[sourceSelectionProvenanceKey]!
  const node = { source_file: file, label: 'Worker.run()', snippet: lines.slice(2, 5).join('\n'),
    snippet_line_range: { start_line: 3, end_line: 5 } }
  return { root, lines, method, receipt: result.receipt, provenance, node }
}

it('requires the full inspected declaration when an unresolved multiline call starts at a point-indexed header', () => {
  const f = fixture()
  expect(f.provenance.owners.find(owner => owner.node_id === f.method)).toMatchObject({
    status: 'unique', indexed_range: { start: 3, end: 3 },
    declaration_offsets: { start: expect.any(Number), end: expect.any(Number) },
  })
  expect(f.provenance.unresolved).toContainEqual(expect.objectContaining({ from_id: f.method, callee: 'port.send', line_number: 3 }))
  const headerOnly = { ...f.node, snippet: f.lines[2]!, snippet_line_range: { start_line: 3, end_line: 3 } }
  expect(sourceVisibleWarnings(f.receipt, f.provenance, [headerOnly], f.root, 'Explain selectedRoot.')).toBe(f.receipt)

  const complete = sourceVisibleWarnings(f.receipt, f.provenance, [f.node], f.root, 'Explain selectedRoot.')
  expect(complete.unresolved_calls).toBe(f.receipt.unresolved_calls + 1)
  expect(complete.unresolved).toContainEqual(expect.objectContaining({ callee: 'port.send', line_number: 3 }))
})

it('does not add inspected warnings after a current request or ignore policy excludes their source', () => {
  const f = fixture()
  expect(sourceVisibleWarnings(f.receipt, f.provenance, [f.node], f.root,
    'Explain selectedRoot. Do not read src/worker.ts.')).toBe(f.receipt)
  writeFileSync(join(f.root, '.madarignore'), 'src/worker.ts\n')
  expect(sourceVisibleWarnings(f.receipt, f.provenance, [f.node], f.root, 'Explain selectedRoot.')).toBe(f.receipt)
})
