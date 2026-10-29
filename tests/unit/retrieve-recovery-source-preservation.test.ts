import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildFromJson } from '../../src/pipeline/build.js'
import { extractJs } from '../../src/pipeline/extract.js'
import { lineRangeFromSourceLocation } from '../../src/shared/source-location.js'
import { recoverContextPackResult } from '../../src/runtime/context-pack-recovery.js'
import { retrieveContext, type RetrieveMatchedNode, type RetrieveResult } from '../../src/runtime/retrieve.js'
import * as conceptual from '../../src/runtime/retrieve/conceptual-fallback.js'
import { recoverySourceGuard } from '../../src/runtime/retrieve/recovery-source-preservation.js'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks() })

function fixture(sources: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'madar-recovery-evidence-'))
  roots.push(root)
  const fragments = Object.entries(sources).map(([file, content]) => {
    const path = join(root, file)
    writeFileSync(path, content)
    return extractJs(path)
  })
  const graph = buildFromJson({ schema_version: 1, nodes: fragments.flatMap(f => f.nodes), edges: fragments.flatMap(f => f.edges) }, { directed: true })
  graph.graph.root_path = root
  function node(label: string): RetrieveMatchedNode {
    const [id, attributes] = [...graph.nodeEntries()].find(([, value]) => value.label === label)!
    const range = lineRangeFromSourceLocation(attributes.source_location)!
    const file = String(attributes.source_file)
    const lines = readFileSync(file, 'utf8').split('\n')
    return { node_id: id, label, source_file: file, line_number: range.start, file_type: 'code',
      snippet: lines.slice(range.start - 1, range.end).join('\n'), snippet_scope: 'symbol',
      snippet_line_range: { start_line: range.start, end_line: range.end }, match_score: 10,
      relevance_band: 'direct', community: null, community_label: null, evidence_class: 'primary' }
  }
  return { graph, root, node }
}

const question = 'How are retry_count and rejected_items computed?'
const executable = [
  'export function processBatch(items: any[], retry_count: number) {',
  '  if (retry_count > 3) throw new Error("RETRY_LIMIT");',
  '  const rejected_items = items.filter(item => !item.accepted);',
  '  return { rejected_items, retry_count: retry_count + 1 };',
  '}',
].join('\n')

function result(nodes: RetrieveMatchedNode[], supporting = false): RetrieveResult {
  return { question, token_count: 200, matched_nodes: nodes, relationships: [], community_context: [],
    graph_signals: { god_nodes: [], bridge_nodes: [] },
    coverage: { required_evidence: ['primary', 'supporting'], semantic_required: [], semantic_optional: [],
      entries: [
        { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
        { evidence_class: 'supporting', required: true, available_nodes: 1, selected_nodes: supporting ? 1 : 0, status: supporting ? 'covered' : 'available' },
      ], semantic_entries: [], missing_required: supporting ? [] : ['supporting'], missing_semantic: [],
      available_relationships: 1, selected_relationships: supporting ? 1 : 0 },
  }
}

describe('source preservation during recovery', () => {
  it('protects every qualifying delivered body, including one beyond a small fixed cap', () => {
    const { graph, node } = fixture(Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
      `batch-${index}.ts`, executable.replace('processBatch', `processBatch${index}`),
    ])))
    const nodes = Array.from({ length: 6 }, (_, index) => node(`processBatch${index}()`))
    expect(recoverySourceGuard(graph, result(nodes), question)(result(nodes.slice(0, 5))))
      .toEqual({ protected_spans: 6, lost_spans: 1 })
  })

  it('accepts exact source retained under different node identities or split excerpts', () => {
    const { graph, node } = fixture({ 'batch.ts': executable })
    const original = node('processBatch()')
    const guard = recoverySourceGuard(graph, result([original]), question)
    const lines = executable.split('\n')
    const split = [
      { ...original, node_id: 'new-first', snippet: lines.slice(0, 2).join('\n'), snippet_line_range: { start_line: 1, end_line: 2 } },
      { ...original, node_id: 'new-second', snippet: lines.slice(2).join('\n'), snippet_line_range: { start_line: 3, end_line: 5 } },
    ]
    expect(guard(result(split))).toEqual({ protected_spans: 1, lost_spans: 0 })
    expect(guard(result([{ ...original, node_id: 'new-file', label: 'batch.ts', snippet_scope: 'source_file' }]))).toEqual({ protected_spans: 1, lost_spans: 0 })
  })

  it('does not mistake a retained ID, omitted branch or copied text in another file for retained source', () => {
    const { graph, node } = fixture({ 'batch.ts': executable, 'other.ts': executable.replace('processBatch', 'reportBatch') })
    const original = node('processBatch()')
    const guard = recoverySourceGuard(graph, result([original]), question)
    const omitted = { ...original, snippet: `${executable.split('\n')[0]}\n[omitted lines 2-4]\n}`, snippet_omitted_ranges: [{ start_line: 2, end_line: 4 }], snippet_truncated: true }
    for (const replacement of [{ ...original, snippet: null }, omitted, { ...original, source_file: node('reportBatch()').source_file }]) {
      expect(guard(result([replacement]))).toEqual({ protected_spans: 1, lost_spans: 1 })
    }
  })

  it('does not protect type wrappers, unrelated bodies or unverifiable cached text', () => {
    const { graph, node } = fixture({
      'batch.ts': executable,
      'types.ts': 'export interface BatchResult { retry_count: number; rejected_items: string[] }',
      'other.ts': 'export function normalizeName(name: string) { return name.trim(); }',
    })
    const initial = result([node('BatchResult'), node('normalizeName()'), { ...node('processBatch()'), snippet: 'old cached source' }])
    expect(recoverySourceGuard(graph, initial, question)(result([]))).toEqual({ protected_spans: 0, lost_spans: 0 })
  })

  it('rejects target recovery that reports better coverage but drops executable evidence', () => {
    const { graph, node } = fixture({ 'batch.ts': executable, 'other.ts': 'export function summary() { return { retry_count: 0, rejected_items: [] }; }' })
    const original = node('processBatch()'), alternate = node('summary()')
    const initial = result([original])
    initial.expandable = [{ kind: 'nodes', handle_id: 'support', evidence_class: 'supporting', count: 1,
      preview: [{ node_id: alternate.node_id!, label: alternate.label, source_file: alternate.source_file }],
      follow_up: { kind: 'context_pack', task_kind: 'explain', evidence_class: 'supporting', focus_files: [alternate.source_file], focus_ranges: [] } }]
    const recovered = result([alternate], true)
    const runPass = vi.fn(() => recovered)
    const output = recoverContextPackResult(graph, initial, { question, budget: 1000 }, runPass)
    expect(runPass).toHaveBeenCalled()
    expect(output.matched_nodes).toEqual(initial.matched_nodes)
    expect(output.recovery?.attempts[0]).toMatchObject({ status: 'kept_prior', changed_result: false,
      source_evidence_loss: { protected_spans: 1, lost_spans: 1 } })

    const additive = recoverContextPackResult(graph, initial, { question, budget: 1000 }, () => result([original, alternate], true))
    expect(additive.matched_nodes).toHaveLength(2)
    expect(additive.recovery?.improved).toBe(true)
  })

  it('carries protected source through file representations across two accepted recovery stages', () => {
    const { graph, node } = fixture({
      'batch.ts': executable,
      'support.ts': 'export function supportBatch() { return { retry_count: 1 }; }',
      'alternate.ts': 'export function reportBatch() { return { rejected_items: [] }; }',
    })
    const original = node('processBatch()'), support = node('supportBatch()'), alternate = node('reportBatch()')
    const initial = result([original])
    const targets = [support, alternate].map((entry, index) => ({
      kind: 'nodes' as const, handle_id: `support-${index}`, evidence_class: 'supporting' as const, count: 1,
      preview: [{ node_id: entry.node_id!, label: entry.label, source_file: entry.source_file }],
      follow_up: { kind: 'context_pack' as const, task_kind: 'explain' as const, evidence_class: 'supporting' as const, focus_files: [entry.source_file], focus_ranges: [] },
    }))
    initial.expandable = targets
    const partial = result([{ ...original, node_id: 'file-representation', snippet_scope: 'source_file' }])
    partial.expandable = targets
    partial.coverage = { ...partial.coverage!, selected_relationships: 1 }
    partial.relationships = [{ from_id: original.node_id!, from: original.label, to_id: support.node_id!, to: support.label, relation: 'calls' }]
    const dropped = result([alternate], true)
    const runPass = vi.fn().mockReturnValueOnce(partial).mockReturnValueOnce(dropped)
    const output = recoverContextPackResult(graph, initial, { question, budget: 1000 }, runPass)
    expect(runPass).toHaveBeenCalledTimes(2)
    expect(output.matched_nodes).toEqual(partial.matched_nodes)
    expect(output.recovery?.attempts).toMatchObject([
      { status: 'improved' },
      { status: 'kept_prior', source_evidence_loss: { protected_spans: 1, lost_spans: 1 } },
    ])

    // The same representation can cross the conceptual-to-target boundary via
    // result metadata spreads, without forgetting the original source proof.
    const laterStage = { ...partial }
    expect(recoverySourceGuard(graph, laterStage, question)(dropped)).toEqual({ protected_spans: 1, lost_spans: 1 })
    expect(recoverySourceGuard(graph, laterStage, 'Where is an unrelated operation?')(dropped)).toEqual({ protected_spans: 0, lost_spans: 0 })
  })

  it('keeps the delta-empty-receiver implementation when conceptual recovery promotes wrappers', () => {
    // Frozen released implementation that exposed recovery losing complete source.
    const deltaSource = `export function computeDeltaContextPack<
  TNode extends ContextPackNode = ContextPackNode,
  TRelationship extends ContextPackRelationship = ContextPackRelationship,
  TCommunity extends ContextPackCommunityContext = ContextPackCommunityContext,
>(
  pack: CompiledContextPack<TNode, TRelationship, TCommunity>,
  previouslySentNodeIds: ReadonlyArray<string>,
): DeltaContextPackResult<TNode, TRelationship, TCommunity> {
  const seen = new Set(previouslySentNodeIds)
  if (seen.size === 0) {
    // No prior session — the delta is the full pack.
    return {
      delta_applied: false,
      delta_pack: pack,
      referenced_ids: [],
      bytes_saved: 0,
    }
  }

  const originalBytes = JSON.stringify(pack).length
  const referencedIds: string[] = []

  // Filter nodes: drop those whose node_id is in \`seen\`. Nodes without a
  // node_id can't be deduplicated by handle, so they always pass through.
  const keptNodes = pack.nodes.filter((node) => {
    const nodeId = typeof node.node_id === 'string' ? node.node_id : null
    if (nodeId !== null && seen.has(nodeId)) {
      referencedIds.push(nodeId)
      return false
    }
    return true
  })

  // Filter relationships: drop edges only when BOTH endpoints are already
  // in the receiver's session. Mixed edges (one new endpoint, one
  // referenced) carry novel information about how the new node connects
  // to the known one, so they're kept. Edges between two new nodes are
  // also kept. Only edges where the receiver already has both ends and
  // the relation between them are redundant.
  const referencedSet = new Set(referencedIds)
  const keptRelationships = pack.relationships.filter((rel) => {
    const fromId = typeof rel.from_id === 'string' ? rel.from_id : null
    const toId = typeof rel.to_id === 'string' ? rel.to_id : null
    if (
      fromId !== null && toId !== null &&
      referencedSet.has(fromId) && referencedSet.has(toId)
    ) {
      return false
    }
    return true
  })

  const deltaPack: CompiledContextPack<TNode, TRelationship, TCommunity> = {
    ...pack,
    nodes: keptNodes,
    relationships: keptRelationships,
    // token_count is a snapshot from the original pack; dropping nodes
    // does not retroactively update upstream token estimates. Consumers
    // that care about post-delta token cost should re-estimate.
  }

  const deltaBytes = JSON.stringify(deltaPack).length
  return {
    delta_applied: referencedIds.length > 0,
    delta_pack: deltaPack,
    referenced_ids: referencedIds,
    bytes_saved: Math.max(0, originalBytes - deltaBytes),
  }
}`
    const { graph, node } = fixture({ 'context-pack-delta.ts': deltaSource, 'receiver.ts': [
      'export function describeReceiverHistory() {',
      '  // Find empty receiver history differs later; including delta applied; bytes saved original pack token accounting.',
      '  return { delta_applied: false, bytes_saved: 0 };',
      '}',
    ].join('\n') })
    const prompt = 'Find how an empty receiver history differs from a later context-pack delta, including delta_applied, bytes_saved and the original pack token accounting.'
    const output = retrieveContext(graph, { question: prompt, taskKind: 'explain', budget: 5000 })
    const body = output.matched_nodes.find(node => node.label === 'computeDeltaContextPack()')?.snippet
    for (const branch of ['if (seen.size === 0)', 'const originalBytes = JSON.stringify(pack).length', 'seen.has(nodeId)', 'token_count is a snapshot', 'bytes_saved: Math.max(0, originalBytes - deltaBytes)']) expect(body).toContain(branch)
    // Isolate the observed failure mechanism: a wrapper-only replacement can
    // improve heuristic coverage while deleting the executing implementation.
    const original = node('computeDeltaContextPack()')
    const alternate = node('describeReceiverHistory()')
    const quality = { selected_nodes: 1, selected_files: 1, direct_matches: 1, explicit_anchors: 0,
      workflow_coherence: 0.5, missing_required_evidence: 1, missing_semantic_evidence: 0, token_count: 1000 }
    const proposal: conceptual.ConceptualFallbackProposal = {
      nodeBoosts: new Map([[alternate.node_id!, 30]]),
      plan: { version: 1, status: 'recovered', reasons: ['missing_required_evidence'], initial: quality, final: quality,
        attempts: [{ fallback: 'repository_vocabulary_v1', status: 'applied', reasons: ['missing_required_evidence'],
          vocabulary_sources: ['exported_symbol'], expansion_terms: ['receiver'], promoted_candidates: 1,
          changed_result: false, added_selected_files: 0, removed_selected_files: 0 }] },
    }
    const replacementQuality = { ...quality, missing_required_evidence: 0 }
    const args = [proposal, replacementQuality, new Set([original.source_file]), new Set([alternate.source_file])] as const
    expect(conceptual.finalizeConceptualFallbackPlan(...args).useRecovered).toBe(true)
    const loss = recoverySourceGuard(graph, result([original]), prompt)(result([alternate]))
    const guarded = conceptual.finalizeConceptualFallbackPlan(...args, new Set([alternate.node_id!]), undefined, loss)
    expect(guarded.useRecovered).toBe(false)
    expect(guarded.plan).toMatchObject({ status: 'kept_initial', final: quality,
      attempts: [{ status: 'kept_initial', changed_result: false, source_evidence_loss: { protected_spans: 1, lost_spans: 1 } }] })
    expect(guarded.plan.selected_fallback).toBeUndefined()
    expect(output.token_count).toBeLessThanOrEqual(5000)
  })
})
