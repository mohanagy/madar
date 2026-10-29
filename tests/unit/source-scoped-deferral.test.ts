import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ContextPackNode } from '../../src/contracts/context-pack.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { retrieveContext, type RetrieveMatchedNode, type RetrieveResult } from '../../src/runtime/retrieve.js'
import { selectSourceDependencies, sourceSelectionProvenanceKey } from '../../src/runtime/retrieve/source-dependencies.js'
import { readEvidenceLines, resolveSourceSymbolRange } from '../../src/runtime/retrieve/source-evidence.js'
import { loadGraph } from '../../src/runtime/serve.js'
import { protectSourceQueryWitnesses, scopedSourceDeferralCore } from '../../src/runtime/source-scoped-deferral.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import { lineRangeFromSourceLocation } from '../../src/shared/source-location.js'

const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })

describe('scoped source deferral', () => {
  it('retains an independent unnamed behavior witness beside a requested operation', async () => {
    vi.stubEnv('MADAR_TOOL_PROFILE', 'strict')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-independent-witness-'))); roots.push(root)
    const source = [
      'const api = {};',
      'api.run = (input) => input + 1;',
      'function processTransfer(transfer) {',
      '  if (transfer.rejected) {',
      '    transfer.quarantined = true;',
      '    return { status: "quarantined", reason: "rejected" };',
      '  }',
      '  return { status: "accepted" };',
      '}',
    ].join('\n')
    writeFileSync(join(root, 'workflow.js'), source)
    const graphPath = generateGraph(root, { noHtml: true, includeDocs: false, docs: false }).graphPath
    const prompt = 'Trace api.run(input) and its return value. Also explain how rejected transfers become quarantined and which status is returned.'
    const result = await handleStdioRequest(graphPath, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'context_pack', arguments: { prompt, task: 'explain', budget: 3000 },
    } })
    expect(result?.error).toBeUndefined()
    const payload = JSON.parse((result!.result as { content: Array<{ text: string }> }).content[0]!.text)
    expect(payload.pack.matched_nodes.map((node: ContextPackNode) => node.label))
      .toEqual(expect.arrayContaining(['api.run()', 'processTransfer()']))
    expect(payload.evidence.answerability.advisory).toBe(true)
    expect(payload.evidence.answerability.state).not.toBe('ready')

    // An omitted witness does not justify hiding its only visible supplier.
    // A forged retained snippet cannot supply the missing word either.
    const nodes = payload.pack.matched_nodes as ContextPackNode[]
    const witness = nodes.find(node => node.label === 'processTransfer()')!
    const omitted: ContextPackNode = { ...witness, node_id: 'retained',
      snippet: `${source.split('\n')[2]}\n[omitted lines 4-8]\n}`, snippet_truncated: true,
      snippet_omitted_ranges: [{ start_line: 4, end_line: 8 }] }
    expect(protectSourceQueryWitnesses(prompt, [omitted, witness], new Set(['retained']), root)).toContain(witness.node_id)
    const forged = { ...omitted, snippet: witness.snippet }
    expect(protectSourceQueryWitnesses(prompt, [forged, witness], new Set(['retained']), root)).toContain(witness.node_id)
    const complete = { ...witness, node_id: 'retained' }
    expect(protectSourceQueryWitnesses(prompt, [complete, witness], new Set(['retained']), root)).not.toContain(witness.node_id)
  })

  it('defers a recoverable secondary owner while preserving source obligations and unknown identities', () => {
    // Keep graph, provenance and source-cache paths canonical on macOS, where
    // the temp directory's /var spelling can alias /private/var.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-scoped-deferral-'))); roots.push(root)
    // Identical text and range in the second module gives the reference a real
    // source supplier; only the first module is named in the question.
    const donorSource = 'function donor() { return "shared"; }'
    const mainSource = [
      donorSource,
      'import { marker } from "./other.mjs";',
      'export function entryPoint() { return leaf(); }',
      'function leaf() { return "shared"; }',
      'function spare() { return "shared"; }',
      'function plain() { return "shared"; }',
      'function firstWitness() { return "beacon"; }',
      'function secondWitness() { return "beacon"; }',
      'function partialOwner() {',
      '  return "shared";',
      '}',
      'function uncertain() { return "shared"; }',
      'function missing() { return "shared"; }',
    ].join('\n') + '\n'
    writeFileSync(join(root, 'main.mjs'), mainSource)
    writeFileSync(join(root, 'other.mjs'), `${donorSource}\nexport const marker = 1;\n`)
    const graph = loadGraph(generateGraph(root, { noHtml: true }).graphPath)
    graph.graph.root_path = root
    const idFor = (name: string, file: string): string => {
      const matches = graph.nodeEntries().filter(([, node]) =>
        String(node.label).replace(/\(\)$/, '') === name && String(node.source_file).endsWith(file))
      expect(matches, `generated owner ${file}:${name}`).toHaveLength(1)
      return matches[0]![0]
    }
    const names = ['donor', 'entryPoint', 'leaf', 'spare', 'plain', 'firstWitness', 'secondWitness', 'partialOwner', 'uncertain', 'missing']
    const ids = new Map<string, string>(names.map(name => [name, idFor(name, 'main.mjs')] as const))
    const copyId = idFor('donor', 'other.mjs')
    const uncertainId = ids.get('uncertain')!
    graph.addNode(`${uncertainId}_duplicate`, { ...graph.nodeAttributes(uncertainId) })

    const question = 'In main.mjs explain how entryPoint handles shared values. Also inspect plain and locate beacon behavior.'
    const raw = retrieveContext(graph, { question, taskKind: 'explain', budget: 8000 })
    expect(raw.selection_scope).toBe('task_context')
    expect(raw.task_contract?.task_kind).toBe('explain')
    // Use the real bounded dependency census, while materializing the complete
    // generated candidate set so ranking cannot hide one of the negative cases.
    const selection = selectSourceDependencies(graph, [ids.get('entryPoint')!], root, new Map(), { includeCallers: false })
    const observed = selection[sourceSelectionProvenanceKey]!
    expect(observed.scans).toMatchObject({ source_loading: 'complete', program: 'complete', identity: 'complete', calls: 'complete', mutation: 'complete' })
    expect(observed.forward.known_reachable_ids).toContain(ids.get('leaf'))
    expect(observed.forward.known_reachable_ids).not.toContain(ids.get('spare'))
    expect(observed.owners).toContainEqual(expect.objectContaining({ node_id: uncertainId, status: 'ambiguous' }))
    for (const name of names.filter(name => name !== 'uncertain')) {
      expect(observed.owners).toContainEqual(expect.objectContaining({ node_id: ids.get(name), status: 'unique' }))
    }

    type SourceNode = ContextPackNode & RetrieveMatchedNode
    const materialize = (id: string, file: string): SourceNode => {
      const attributes = graph.nodeAttributes(id)
      const lines = readEvidenceLines(file, root)!
      const indexed = lineRangeFromSourceLocation(attributes.source_location)!
      const label = String(attributes.label)
      const range = resolveSourceSymbolRange(lines, indexed, label, join(root, file))!
      expect(range, `complete current range for ${label}`).toBeTruthy()
      return { node_id: id, label, source_file: file, line_number: range.start,
        snippet: lines.slice(range.start - 1, range.end).join('\n'), snippet_scope: 'symbol',
        snippet_line_range: { start_line: range.start, end_line: range.end }, file_type: 'code',
        match_score: 1, relevance_band: 'direct', community: null, community_label: null, evidence_class: 'primary' }
    }
    const nodes = names.map(name => materialize(ids.get(name)!, 'main.mjs'))
    const reference = materialize(copyId, 'other.mjs')
    expect(reference.snippet).toBe(nodes.find(node => node.node_id === ids.get('donor'))!.snippet)
    expect(reference.snippet_line_range).toEqual(nodes.find(node => node.node_id === ids.get('donor'))!.snippet_line_range)
    reference.snippet = null
    reference.snippet_ref = ids.get('donor')!
    nodes.push(reference)
    const partial = nodes.find(node => node.node_id === ids.get('partialOwner'))!
    const partialLines = partial.snippet!.split('\n'), gap = partial.snippet_line_range!.start_line + 1
    partial.snippet = `${partialLines[0]}\n[omitted lines ${gap}-${gap}]\n${partialLines[2]}`
    partial.snippet_omitted_ranges = [{ start_line: gap, end_line: gap }]
    partial.snippet_truncated = true
    const provenance = structuredClone(observed)
    // Absence of a private owner receipt is unknown, not deferral permission.
    provenance.owners = provenance.owners.filter(owner => owner.node_id !== ids.get('missing'))
    const retrieval: RetrieveResult = { ...raw, matched_nodes: nodes, [sourceSelectionProvenanceKey]: provenance }
    const before = JSON.stringify({ nodes, provenance })
    const core = scopedSourceDeferralCore(retrieval, nodes, root)
    expect(core).toBeDefined()
    expect(core!.question).toBe(question)
    expect(core!.selected_node_ids).toEqual(nodes.map(node => node.node_id))
    expect(core!.node_ids).toEqual(nodes.filter(node => node.node_id !== ids.get('spare')).map(node => node.node_id))
    // In particular, the two beacon bodies cannot justify removing each other.
    expect(core!.node_ids).toEqual(expect.arrayContaining([ids.get('firstWitness'), ids.get('secondWitness')]))
    expect(provenance.forward.exclusion_proof).toBe('not_provided')
    expect(JSON.stringify({ nodes, provenance })).toBe(before)

    for (const unsupportedQuestion of [
      'In main.mjs explain callers of entryPoint.',
      'In main.mjs trace the entryPoint flow.',
      'In main.mjs explain entryPoint and "shared" values.',
      'In main.mjs explain entryPoint and behavior in other.mjs.',
      `${question} ${Array.from({ length: 8 }, (_, index) => `CODE_${index}`).join(' ')}`,
      `${question}${' '.repeat(16_384)}`,
    ]) {
      expect(scopedSourceDeferralCore({ ...retrieval, question: unsupportedQuestion }, nodes, root), unsupportedQuestion.slice(0, 80)).toBeUndefined()
    }
    expect(scopedSourceDeferralCore({ ...retrieval, task_contract: { ...raw.task_contract!, task_kind: 'implement' } }, nodes, root)).toBeUndefined()

    // The same declarations still exist, but the exact source snapshot changed.
    // Fresh names/ranges alone cannot authorize a trial using old provenance.
    writeFileSync(join(root, 'main.mjs'), `${mainSource}// changed after the census\n`)
    expect(scopedSourceDeferralCore(retrieval, nodes, root)).toBeUndefined()
  })
})
