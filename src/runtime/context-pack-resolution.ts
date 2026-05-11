// Multi-resolution context representations (#76 — v0.16).
//
// Adapts a CompiledContextPack (or any pack-shaped node list) to three
// resolutions:
//
//   * 'detail'   — full snippet + all node metadata (current default)
//   * 'summary'  — label + source_file + line_number + match_score only
//                  (snippet bodies dropped to save tokens)
//   * 'mixed'   — top-N most relevant nodes get 'detail', rest get
//                 'summary'. N is configurable (default: ceil(nodes/3))
//
// The transform is non-destructive: pass any node list and get a new
// list back with the requested resolution applied. Consumers that need
// the full pack metadata (coverage, claims, etc.) keep the original
// upstream pack; this helper only reshapes the per-node payload.
//
// Why it lives here and not in compact-context-pack: this is a UX/
// budget-shaping decision that's downstream of compaction. Compaction
// is about taking the OUTER LIMIT (max_nodes); resolution is about
// shaping each node's payload so the agent can decide whether to expand.

import type { ContextPackNode } from '../contracts/context-pack.js'

export type ContextPackResolution = 'detail' | 'summary' | 'mixed'

export interface ApplyResolutionOptions {
  resolution: ContextPackResolution
  /** For 'mixed': number of top nodes that retain full detail. Defaults
   *  to ceil(nodes.length / 3) so a 12-node pack keeps 4 detail nodes. */
  detail_top_n?: number
}

export interface ApplyResolutionResult<T extends ContextPackNode> {
  nodes: T[]
  /** Per-node resolution after applying. Useful for diagnostics. */
  resolution_map: Array<{ node_id: string | undefined; resolution: 'detail' | 'summary' }>
  /** Estimated bytes saved (rough — based on dropped snippet length). */
  bytes_saved: number
}

/** Apply a resolution to a list of context-pack nodes. Pure and
 *  deterministic — same input always produces the same output. */
export function applyContextPackResolution<T extends ContextPackNode>(
  nodes: ReadonlyArray<T>,
  options: ApplyResolutionOptions,
): ApplyResolutionResult<T> {
  if (options.resolution === 'detail') {
    return {
      nodes: [...nodes],
      resolution_map: nodes.map((n) => ({ node_id: n.node_id, resolution: 'detail' })),
      bytes_saved: 0,
    }
  }

  if (options.resolution === 'summary') {
    return summarizeAll(nodes)
  }

  // mixed: top-N detail by match_score desc, rest summary.
  const n = options.detail_top_n ?? Math.ceil(nodes.length / 3)
  return mixedResolution(nodes, Math.max(0, n))
}

function summarizeAll<T extends ContextPackNode>(
  nodes: ReadonlyArray<T>,
): ApplyResolutionResult<T> {
  let bytesSaved = 0
  const transformed = nodes.map((node) => {
    bytesSaved += dropSnippetBytes(node)
    return summarizeNode(node)
  })
  return {
    nodes: transformed,
    resolution_map: nodes.map((n) => ({ node_id: n.node_id, resolution: 'summary' })),
    bytes_saved: bytesSaved,
  }
}

function mixedResolution<T extends ContextPackNode>(
  nodes: ReadonlyArray<T>,
  detailCount: number,
): ApplyResolutionResult<T> {
  // Rank by match_score desc; stable for ties using original index.
  const indexed = nodes.map((node, idx) => ({ node, idx, score: node.match_score ?? 0 }))
  indexed.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.idx - b.idx
  })
  const detailIndices = new Set<number>()
  for (let i = 0; i < Math.min(detailCount, indexed.length); i += 1) {
    detailIndices.add(indexed[i]!.idx)
  }

  let bytesSaved = 0
  const out: T[] = []
  const resolutionMap: Array<{ node_id: string | undefined; resolution: 'detail' | 'summary' }> = []
  nodes.forEach((node, idx) => {
    if (detailIndices.has(idx)) {
      out.push(node)
      resolutionMap.push({ node_id: node.node_id, resolution: 'detail' })
    } else {
      bytesSaved += dropSnippetBytes(node)
      out.push(summarizeNode(node))
      resolutionMap.push({ node_id: node.node_id, resolution: 'summary' })
    }
  })
  return { nodes: out, resolution_map: resolutionMap, bytes_saved: bytesSaved }
}

function summarizeNode<T extends ContextPackNode>(node: T): T {
  // Drop the snippet body. Preserve all other metadata so the agent can
  // still rank/filter/expand. Casts back to T because the shape is the
  // same — only the snippet content changed.
  return { ...node, snippet: null } as T
}

function dropSnippetBytes(node: ContextPackNode): number {
  return typeof node.snippet === 'string' ? node.snippet.length : 0
}
