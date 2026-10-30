import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { withExtractionFileStemContext } from '../../src/pipeline/extract/core.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'
import { selectSourceDependencies, sourceSelectionProvenanceKey, sourceSubjectPriorityKey } from '../../src/runtime/retrieve/source-dependencies.js'
import { sourceSubjectQueries } from '../../src/runtime/retrieve/source-subject-priority.js'
import { sourcePathForEvidence } from '../../src/runtime/retrieve/source-evidence.js'
import type { SourceReadPolicy } from '../../src/runtime/retrieve/source-modules.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const fields = 'invoice approval customer amount currency balance receipt ledger status payment account transaction validation persistence response history reason timestamp identifier merchant region address delivery discount subtotal tax total quantity item product inventory stock warehouse shipment settlement cancellation confirmation'.split(' ')
const head = `Trace ${fields.join(' ')}.`
const tail = 'Also trace expired lease reconciliation and orphan release.'
const question = `${head} ${tail}`

function fixture(mutable = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-source-subject-'))); roots.push(root)
  const files = {
    'src/flow.ts': `import { settle, ${Array.from({ length: 14 }, (_, i) => `touch${i}`).join(', ')} } from './state';
export function runOperation(input: any) {
  function rollback(id: string) { return { refund: true, result: settle(id) }; }
  const { ${fields.join(', ')} } = input;
  if (input.failed) return rollback(input.id);
  settle(input.id);
  ${Array.from({ length: 14 }, (_, i) => `touch${i}();`).join('\n  ')}
  ${Array.from({ length: 85 }, () => '// Preserve the original operation.').join('\n  ')}
  return { ${fields.join(', ')} };
}`,
    'src/state.ts': `export const RECORDS = ${mutable ? '{ bucket: "records" }' : '"records"'};
export function settle(id: string) { const collection = RECORDS; return { id, collection, refunded: true }; }
export function resumeExpired(lease: any) {
  const reconciliation = RECORDS;
  if (lease.expired) return { reconciliation, release: settle(lease.orphan) };
  return null;
}
export function unrelatedRecovery(lease: any) {
  if (lease.expired) return { release: settle(lease.orphan), reconciliation: true };
  return null;
}
${Array.from({ length: 14 }, (_, i) => `export function touch${i}() { return ${i}; }`).join('\n')}`,
  }
  const fragments = withExtractionFileStemContext(Object.keys(files).map(file => join(root, file)), () => Object.entries(files).map(([file, text]) => {
    const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return extractJs(path)
  }))
  // Scalar indexing is a separate generator pass; supply its exact declaration.
  const nodes = [...fragments.flatMap(f => f.nodes), { id: 'fixture-records', label: 'RECORDS', file_type: 'code',
    source_file: join(root, 'src/state.ts'), source_location: 'L1-L1', snippet: files['src/state.ts'].split('\n')[0] }]
  const graph = buildFromJson({ schema_version: 1, nodes, edges: fragments.flatMap(f => f.edges) }, { directed: true })
  graph.graph.root_path = root
  const id = (label: string) => [...graph.nodeEntries()].find(([, attrs]) => attrs.label === label)![0]
  return { graph, root, seed: id('runOperation()'), alternate: id('resumeExpired()'), unrelated: id('unrelatedRecovery()') }
}

it('keeps subject requests outside quoted examples and literal lookups', () => {
  expect(sourceSubjectQueries(question)).toEqual([tail.slice(0, -1)])
  expect(sourceSubjectQueries(`Explain invoice approval. Also trace invoice approval.`)).toEqual([])
  expect(sourceSubjectQueries(`${head} "${tail}"`)).toEqual([])
  expect(sourceSubjectQueries(`${head}\n\`\`\`text\n${tail}\n\`\`\``)).toEqual([])
  expect(sourceSubjectQueries('Where is `ACCESS_DENIED` thrown?')).toEqual([])
  expect(sourceSubjectQueries(`${'x'.repeat(12_001)} ${tail}`)).toEqual([])
})

it('reserves source-connected alternate behavior within existing limits without inventing forward reachability', () => {
  const value = fixture()
  const pathChecks = new Set<string>()
  const allowedPath: SourceReadPolicy = (file) => { pathChecks.add(file); return true }
  // Retrieval checks owner bodies with the source-only reader. Configuration
  // probes, including missing policy files, need their own path permission.
  const allowedOwner = (file: string) => !!sourcePathForEvidence(file, value.root)
  const choose = (owner = allowedOwner, path = allowedPath) => selectSourceDependencies(value.graph, [value.seed], value.root, new Map(), {
    includeCallers: true, subjectPriority: { seedId: value.seed, question, allowedOwner: owner, allowedPath: path },
  })
  const selected = choose()
  expect(selected.node_ids.length).toBeLessThanOrEqual(12)
  expect(selected.node_ids, JSON.stringify({ priority: selected[sourceSubjectPriorityKey], provenance: selected[sourceSelectionProvenanceKey] })).toContain(value.alternate)
  expect(selected[sourceSubjectPriorityKey]).toContain(value.alternate)
  expect(pathChecks.has(join(value.root, '.madarignore'))).toBe(true)
  expect(allowedOwner(join(value.root, '.madarignore'))).toBe(false)
  expect(choose(allowedOwner, allowedOwner)[sourceSubjectPriorityKey]).toBeUndefined()
  expect(choose(allowedOwner, file => !file.endsWith('.madarignore'))[sourceSubjectPriorityKey]).toBeUndefined()
  expect(selected[sourceSubjectPriorityKey]).not.toContain(value.unrelated)
  expect(selected[sourceSelectionProvenanceKey]!.forward.known_reachable_ids).not.toContain(value.alternate)
  expect(selected.relationships.some(edge => edge.from_id === value.seed && edge.to_id === value.alternate)).toBe(false)
  const pack = retrieveContext(value.graph, { question, taskKind: 'explain', budget: 3000 })
  expect(pack.matched_nodes.some(node => node.node_id === value.seed)).toBe(true)
  expect(pack.matched_nodes.some(node => node.snippet?.includes('refund: true'))).toBe(true)
  expect(pack.matched_nodes.find(node => node.node_id === value.alternate)?.snippet,
    JSON.stringify(pack.matched_nodes.map(node => node.label))).toContain('if (lease.expired)')
  expect(pack.token_count).toBeLessThanOrEqual(3000)
  expect(choose(file => allowedOwner(file) && !file.endsWith('/state.ts'))[sourceSubjectPriorityKey]).toBeUndefined()
  const object = fixture(true)
  const rejected = selectSourceDependencies(object.graph, [object.seed], object.root, new Map(), {
    includeCallers: true, subjectPriority: { seedId: object.seed, question,
      allowedOwner: file => !!sourcePathForEvidence(file, object.root), allowedPath: () => true },
  })
  expect(rejected[sourceSubjectPriorityKey]).toBeUndefined()
})
