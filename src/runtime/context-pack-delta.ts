// Delta delivery uses content receipts for source spans and individual edges.
// A bare node ID cannot establish which query-dependent excerpt the receiver has.
// The MCP caller records receipts only after final serialization and budget culling,
// resets them on graph generation changes, and exposes explicit session reset.

import { createHash } from 'node:crypto'
import { estimateQueryTokens } from './serve.js'
import { resolveSourceSnippet } from './source-evidence-response.js'

import type {
  CompiledContextPack,
  ContextPackCommunityContext,
  ContextPackNode,
  ContextPackRelationship,
} from '../contracts/context-pack.js'

export interface DeltaContextPackResult<
  TNode extends ContextPackNode = ContextPackNode,
  TRelationship extends ContextPackRelationship = ContextPackRelationship,
  TCommunity extends ContextPackCommunityContext = ContextPackCommunityContext,
> {
  /** True when at least one exact source or edge receipt was already delivered. */
  delta_applied: boolean
  /** Pack with overlapping nodes + their relationships removed. */
  delta_pack: CompiledContextPack<TNode, TRelationship, TCommunity>
  /** Node ids the caller already had — surfaced explicitly so the agent
   *  can resolve them from session state instead of re-reading content. */
  referenced_ids: string[]
  /** Bytes-saved estimate (delta vs original JSON length). */
  bytes_saved: number
}

export function computeDeltaContextPack<
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

  // Receipts identify exactly delivered content, not merely a symbol that appeared before.
  // Legacy bare node IDs deliberately do not suppress content: they cannot prove which
  // query-dependent excerpt or source revision the receiver has.
  const keptNodes = pack.nodes.filter((node) => {
    if (typeof node.node_id === 'string' && seen.has(nodeContentReceipt(node))) {
      referencedIds.push(node.node_id)
      return false
    }
    return true
  })
  const keptRelationships = pack.relationships.filter((relationship) => !seen.has(relationshipContentReceipt(relationship)))
  if (keptNodes.length === pack.nodes.length && keptRelationships.length === pack.relationships.length) {
    return { delta_applied: false, delta_pack: pack, referenced_ids: [], bytes_saved: 0 }
  }

  const deltaPack: CompiledContextPack<TNode, TRelationship, TCommunity> = {
    ...pack,
    nodes: keptNodes,
    relationships: keptRelationships,
    token_count: keptNodes.reduce((total, node) => total + estimateQueryTokens(node.snippet ?? ''), 0),
  }

  const deltaBytes = JSON.stringify(deltaPack).length
  return {
    delta_applied: referencedIds.length > 0 || keptRelationships.length < pack.relationships.length,
    delta_pack: deltaPack,
    referenced_ids: referencedIds,
    bytes_saved: Math.max(0, originalBytes - deltaBytes),
  }
}

/**
 * Convenience overload: extract every `node_id` from a pack. Use this to
 * record what the agent received after each call so the next call's
 * `previouslySentNodeIds` argument is correct.
 */
export function collectPackNodeIds<TNode extends ContextPackNode>(
  pack: CompiledContextPack<TNode>,
): string[] {
  const out: string[] = []
  for (const node of pack.nodes) {
    if (typeof node.node_id === 'string' && node.node_id.length > 0) {
      out.push(node.node_id)
    }
  }
  return out
}

function receipt(kind: string, value: unknown): string {
  return `${kind}:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

export function nodeContentReceipt(node: ContextPackNode): string {
  const range = node.snippet_line_range
  // Final wire output may omit this position only when the exact range supplies it.
  const lineNumber = node.line_number === undefined && range
    && Object.keys(range).every(key => key === 'start_line' || key === 'end_line')
    && Number.isSafeInteger(range.start_line) && range.start_line > 0
    && Number.isSafeInteger(range.end_line) && range.end_line >= range.start_line
    ? range.start_line : node.line_number
  return receipt('source', [node.node_id, node.label, node.source_file, lineNumber,
    node.snippet ?? null, node.snippet_line_number ?? node.snippet_line_range?.start_line ?? null, node.snippet_line_range ?? null,
    node.snippet_omitted_ranges ?? [], node.snippet_scope ?? null, node.snippet_unverified ?? false,
    node.snippet_source ?? null, node.representation_type ?? null])
}

export function relationshipContentReceipt(edge: ContextPackRelationship): string {
  return receipt('edge', [edge.from_id ?? edge.from, edge.to_id ?? edge.to, edge.relation,
    edge.source_file ?? null, edge.source_location ?? null, edge.confidence ?? null])
}

/** Record only evidence actually delivered after final serialization and budget selection. */
export function collectDeliveredContextReceipts(payload: Record<string, unknown>): string[] {
  const pack = payload.pack as { matched_nodes?: Array<ContextPackNode & { snippet_ref?: string }>; relationships?: ContextPackRelationship[] } | undefined
  const nodes = pack?.matched_nodes ?? []
  return [
    ...nodes.filter(node => typeof node.node_id === 'string').map(node => nodeContentReceipt({
      ...node, snippet: resolveSourceSnippet(node as unknown as Record<string, unknown>, nodes as unknown as Record<string, unknown>[]),
    })),
    ...(pack?.relationships ?? []).map(relationshipContentReceipt),
  ]
}
