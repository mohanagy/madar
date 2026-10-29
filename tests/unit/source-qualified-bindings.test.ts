import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

const receiptFiles = {
  'invoice.ts': "import { recordReceipt as saveReceipt } from './public.js';\nexport function finishInvoice(ref: string) { return saveReceipt(ref); }",
  'public.ts': "export { recordReceipt } from './ledger.js';",
  'ledger.ts': 'export function recordReceipt(ref: string) { return "LEDGER_RECEIPT:" + ref; }',
  'telemetry.ts': 'export function recordReceipt(ref: string) { return "TELEMETRY_RECEIPT:" + ref; }',
}

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'madar-qualified-binding-'))
  roots.push(root)
  const fragments = Object.entries(files).map(([name, source]) => {
    const file = join(root, name)
    writeFileSync(file, source)
    return extractJs(file)
  })
  const graph = buildFromJson({ schema_version: 1, nodes: fragments.flatMap(fragment => fragment.nodes),
    edges: fragments.flatMap(fragment => fragment.edges) }, { directed: true })
  graph.graph.root_path = root
  const idFor = (name: string, file: string): string => graph.nodeEntries().find(([, node]) =>
    node.label === `${name}()` && String(node.source_file).endsWith(file))![0]
  return { graph, idFor }
}

it('keeps a later bare symbol request ambiguous after a source-bound alias qualifier', () => {
  const { graph, idFor } = fixture(receiptFiles)
  const caller = idFor('finishInvoice', 'invoice.ts'), ledger = idFor('recordReceipt', 'ledger.ts')
  const telemetry = idFor('recordReceipt', 'telemetry.ts')
  const question = 'Show finishInvoice and the actual recordReceipt implementation called through saveReceipt.'
  const qualified = retrieveContext(graph, { question, taskKind: 'explain', budget: 3000 })
  expect(qualified.matched_nodes.map(node => node.node_id)).toEqual(expect.arrayContaining([caller, ledger]))
  expect(qualified.matched_nodes.map(node => node.node_id)).not.toContain(telemetry)
  expect(qualified.relationships).toContainEqual(expect.objectContaining({ from_id: caller, to_id: ledger, relation: 'calls' }))

  const independent = retrieveContext(graph, { question: `${question} Separately show recordReceipt.`, taskKind: 'explain', budget: 3000 })
  expect(independent.matched_nodes.map(node => node.node_id)).toEqual(expect.arrayContaining([caller, ledger, telemetry]))
  expect(independent.relationships).not.toContainEqual(expect.objectContaining({ from_id: caller, to_id: telemetry, relation: 'calls' }))
})

it('requires a matching bound call in every requested root for an each-qualified implementation', () => {
  for (const everyCallerHasSite of [true, false]) {
    const { graph, idFor } = fixture({ ...receiptFiles, 'review.ts': everyCallerHasSite
      ? "import { recordReceipt as saveReceipt } from './public.js';\nexport function reviewInvoice(ref: string) { return saveReceipt(ref); }"
      : 'export function reviewInvoice(ref: string) { return ref; }' })
    const first = idFor('finishInvoice', 'invoice.ts'), second = idFor('reviewInvoice', 'review.ts')
    const ledger = idFor('recordReceipt', 'ledger.ts'), telemetry = idFor('recordReceipt', 'telemetry.ts')
    // One qualified occurrence only: the zero-site guard, not a later bare
    // occurrence, must prevent narrowing when reviewInvoice has no such call.
    const question = 'Show finishInvoice and reviewInvoice, and the actual recordReceipt implementation that each calls through saveReceipt.'
    const result = retrieveContext(graph, { question, taskKind: 'explain', budget: 3000 })
    const ids = result.matched_nodes.map(node => node.node_id)
    expect(ids).toEqual(expect.arrayContaining([first, second, ledger]))
    expect(ids.includes(telemetry)).toBe(!everyCallerHasSite)
    expect(result.relationships).toContainEqual(expect.objectContaining({ from_id: first, to_id: ledger, relation: 'calls' }))
    expect(result.relationships.some(edge => edge.from_id === second && edge.to_id === ledger && edge.relation === 'calls')).toBe(everyCallerHasSite)
    expect(result.relationships.some(edge => (edge.from_id === first || edge.from_id === second)
      && edge.to_id === telemetry && edge.relation === 'calls')).toBe(false)
  }
})

it('settles an implicit call expression only when every direct invocation is authenticated', () => {
  for (const extraInvocation of ['', 'port(ref)', 'taggedReceipt`receipt`']) {
    const { graph, idFor } = fixture({ ...receiptFiles,
      'invoice.ts': "import { recordReceipt as saveReceipt } from './public.js';\n"
        + "import { recordReceipt as taggedReceipt } from './telemetry.js';\n"
        + `export function finishInvoice(ref: string, port: (ref: string) => string) {\n`
        + `  const receipt = saveReceipt(ref);\n  return ${extraInvocation || 'receipt'};\n}` })
    const caller = idFor('finishInvoice', 'invoice.ts'), ledger = idFor('recordReceipt', 'ledger.ts')
    const telemetry = idFor('recordReceipt', 'telemetry.ts')
    const question = 'Show finishInvoice and the actual recordReceipt implementation it calls.'
    const result = retrieveContext(graph, { question, taskKind: 'explain', budget: 3000 })
    const ids = result.matched_nodes.map(node => node.node_id)
    expect(ids).toEqual(expect.arrayContaining([caller, ledger]))
    expect(ids.includes(telemetry)).toBe(extraInvocation !== '')
    expect(result.relationships).toContainEqual(expect.objectContaining({ from_id: caller, to_id: ledger, relation: 'calls' }))
    expect(result.relationships).not.toContainEqual(expect.objectContaining({ from_id: caller, to_id: telemetry, relation: 'calls' }))
    if (!extraInvocation) {
      const independent = retrieveContext(graph, { question: `${question} Separately show recordReceipt.`, taskKind: 'explain', budget: 3000 })
      expect(independent.matched_nodes.map(node => node.node_id)).toEqual(expect.arrayContaining([caller, ledger, telemetry]))
    }
  }
})
