import { basename } from 'node:path'

import type {
  ContextPackRoutingDebug,
  ContextPackRoutingDebugAnchor,
} from '../contracts/context-pack.js'
import { computeContextPackDiagnostics } from './context-pack-diagnostics.js'
import { contextPackFromRetrieveResult, type RetrieveResult } from './retrieve.js'

// Treat obvious path-shaped strings as private-ish anchor candidates so
// safeAnchorLabel can collapse them to a basename: absolute paths, any value
// containing a slash, or bare filenames with short extensions.
const PATH_LIKE_PATTERN = /^(?:\/|[A-Za-z]:[\\/])|[\\/]|(?:^|[\\/])[^\\/]+\.[A-Za-z0-9]{1,8}$/

function safeAnchorLabel(value: string): string {
  const trimmed = value.trim()
  if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//i.test(trimmed)) {
    return trimmed
  }
  if (!PATH_LIKE_PATTERN.test(trimmed)) {
    return trimmed
  }
  return basename(trimmed.replaceAll('\\', '/'))
}

function dedupeAnchors(anchors: ContextPackRoutingDebugAnchor[]): ContextPackRoutingDebugAnchor[] {
  const seen = new Set<string>()
  return anchors.filter((anchor) => {
    const key = `${anchor.label}\u0000${anchor.reason}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function topAnchors(retrieval: RetrieveResult): ContextPackRoutingDebugAnchor[] {
  const sliceAnchors = retrieval.slice?.anchors.map((anchor) => ({
    label: safeAnchorLabel(anchor.label),
    reason: anchor.reason,
  })) ?? []
  if (sliceAnchors.length > 0) {
    return dedupeAnchors(sliceAnchors).slice(0, 3)
  }

  const signalAnchors: ContextPackRoutingDebugAnchor[] = [
    ...(retrieval.retrieval_gate?.signals.mentioned_symbols ?? []).map((label) => ({
      label: safeAnchorLabel(label),
      reason: 'symbol mention',
    })),
    ...(retrieval.retrieval_gate?.signals.mentioned_paths ?? []).map((label) => ({
      label: safeAnchorLabel(label),
      reason: 'path mention',
    })),
  ]
  if (signalAnchors.length > 0) {
    return dedupeAnchors(signalAnchors).slice(0, 3)
  }

  return dedupeAnchors(
    retrieval.matched_nodes.slice(0, 10).map((node) => ({
      label: safeAnchorLabel(node.label),
      reason: 'top retrieval match',
    })),
  ).slice(0, 3)
}

export function buildRoutingDebug(retrieval: RetrieveResult): ContextPackRoutingDebug {
  const gate = retrieval.retrieval_gate
  const diagnostics = computeContextPackDiagnostics(contextPackFromRetrieveResult(retrieval))

  return {
    detected_intent: gate?.intent ?? 'unknown',
    generation_intent: gate?.signals.generation_intent ?? 'unknown',
    target_domain_hint: gate?.signals.target_domain_hint ?? 'unknown',
    retrieval_level: gate?.level ?? 1,
    effective_retrieval_strategy: retrieval.retrieval_strategy ?? 'default',
    reason: gate?.reason ?? 'retrieval gate unavailable',
    top_anchors: topAnchors(retrieval),
    exclusions: {
      domains: [...(gate?.signals.excluded_domains ?? [])],
      terms: [...(gate?.signals.excluded_terms ?? [])],
      path_hints: [...(gate?.signals.excluded_path_hints ?? [])],
    },
    warnings: diagnostics.warnings,
  }
}
