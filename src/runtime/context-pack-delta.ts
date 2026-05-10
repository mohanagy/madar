// Context-pack delta helper (#81): given a freshly compiled pack and a set
// of node ids the agent already received in earlier session turns, return a
// "delta" pack that contains only NEW nodes and relationships, plus an
// explicit reference list of the ids that were dropped.
//
// This is the standalone, side-effect-free building block of #81. The
// stdio context_pack tool wires it in on a follow-up by:
//   1. Reading the per-session handle store to get already-seen ids.
//   2. Calling computeDeltaContextPack(pack, seenIds) to filter the pack.
//   3. Returning { mode: 'delta', delta_pack, referenced_ids } to the agent.
//   4. Updating the session store with the new ids the agent has now
//      received so the next call's delta is correct.
//
// Splitting the pure helper from the session-state plumbing keeps the
// computation testable in isolation and lets future delta consumers
// (e.g., the prompt compiler or a future federation surface) reuse the
// same logic without re-implementing the filtering rules.

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
  /** True iff the input pack overlapped with previously-sent ids. When
   *  false, the delta is identical to the input pack. */
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

  // Filter nodes: drop those whose node_id is in `seen`. Nodes without a
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
