import type { ExtractionData, ExtractionNode } from './contracts.js'
import { lineNumberFromSourceLocation } from '../../shared/source-location.js'
import { addUniqueEdge, createEdge, normalizeLabel } from './core.js'
import type { ExtractionFragment } from './dispatch.js'

export interface ResolveSourceNodeReferencesOptions {
  contextNodes?: readonly ExtractionNode[]
}

function addNodeReferenceKey(index: Map<string, string[]>, key: string, nodeId: string): void {
  const existing = index.get(key) ?? []
  if (!existing.includes(nodeId)) {
    index.set(key, [...existing, nodeId])
  }
}

export function mergeExtractionFragments(fragments: readonly ExtractionFragment[]): ExtractionData {
  return {
    nodes: fragments.flatMap((fragment) => fragment.nodes),
    edges: fragments.flatMap((fragment) => fragment.edges),
    input_tokens: 0,
    output_tokens: 0,
  }
}

export function resolveSourceNodeReferences(extraction: ExtractionData, options: ResolveSourceNodeReferencesOptions = {}): ExtractionData {
  const nodes = [...extraction.nodes]
  const edges = [...extraction.edges]
  const allNodes = options.contextNodes && options.contextNodes.length > 0 ? [...nodes, ...options.contextNodes] : nodes
  const nodeIdsByKey = new Map<string, string[]>()

  for (const node of allNodes) {
    addNodeReferenceKey(nodeIdsByKey, node.id, node.id)
    addNodeReferenceKey(nodeIdsByKey, normalizeLabel(String(node.label ?? '')), node.id)
  }

  const seenEdges = new Set(edges.map((edge) => `${edge.source}|${edge.target}|${edge.relation}`))
  for (const node of nodes) {
    const rawSourceNodes = node.source_nodes
    if (!Array.isArray(rawSourceNodes) || rawSourceNodes.length === 0) {
      continue
    }

    for (const sourceNodeReference of rawSourceNodes) {
      if (typeof sourceNodeReference !== 'string') {
        continue
      }

      const normalizedReference = sourceNodeReference.trim()
      if (!normalizedReference) {
        continue
      }

      const candidateIds = new Set([...(nodeIdsByKey.get(normalizedReference) ?? []), ...(nodeIdsByKey.get(normalizeLabel(normalizedReference)) ?? [])])

      for (const targetId of candidateIds) {
        if (targetId === node.id) {
          continue
        }

        addUniqueEdge(edges, seenEdges, createEdge(node.id, targetId, 'references', node.source_file, lineNumberFromSourceLocation(node.source_location)))
      }
    }
  }

  return {
    ...extraction,
    nodes,
    edges,
  }
}
