import { relative, sep } from 'node:path'

import {
  INDEXING_MANIFEST_VERSION,
  type ExtractionFallbackReason,
  type ExtractionStrategy,
  type IndexingCompletenessState,
  type IndexingManifestV1,
  type IndexingOutcome,
  type IndexingOutcomeStatus,
  type IndexingReasonCode,
  type IndexingSpiDiagnostic,
  type IndexingStatusCounts,
  type IndexingStrictThresholds,
  type IndexingSummary,
  type ShareSafeIndexingManifestV1,
} from '../contracts/indexing.js'
import type { ExtractionMode } from '../contracts/generation-policy.js'

const STATUS_SEVERITY: Record<IndexingOutcomeStatus, number> = {
  indexed: 0,
  skipped_by_policy: 1,
  indexed_with_warnings: 2,
  unsupported: 3,
  failed: 4,
}

export function localIndexingPath(rootPath: string, path: string): string {
  const localPath = relative(rootPath, path).split(sep).join('/')
  if (localPath.length > 0 && !localPath.startsWith('../')) {
    return localPath
  }
  return path.split(sep).at(-1) ?? path
}

function mergeDiagnostics(left: IndexingOutcome['diagnostics'], right: IndexingOutcome['diagnostics']): IndexingOutcome['diagnostics'] {
  const diagnostics = [...(left ?? []), ...(right ?? [])]
  if (diagnostics.length === 0) {
    return undefined
  }
  const unique = new Map(diagnostics.map((diagnostic) => [
    `${diagnostic.level}:${diagnostic.code}:${diagnostic.message ?? ''}`,
    diagnostic,
  ]))
  return [...unique.values()]
}

export function deduplicateIndexingOutcomes(outcomes: readonly IndexingOutcome[]): IndexingOutcome[] {
  const deduplicated = new Map<string, IndexingOutcome>()
  for (const outcome of outcomes) {
    const normalized = { ...outcome, path: outcome.path.replaceAll('\\', '/') }
    const key = `${normalized.kind}:${normalized.path}`
    const existing = deduplicated.get(key)
    if (!existing) {
      deduplicated.set(key, normalized)
      continue
    }

    const preferred = STATUS_SEVERITY[normalized.status] >= STATUS_SEVERITY[existing.status]
      ? normalized
      : existing
    const diagnostics = mergeDiagnostics(existing.diagnostics, normalized.diagnostics)
    deduplicated.set(key, {
      ...preferred,
      ...(preferred.extraction_strategy || !existing.extraction_strategy
        ? {}
        : { extraction_strategy: existing.extraction_strategy }),
      ...(preferred.fallback_reason || !existing.fallback_reason
        ? {}
        : { fallback_reason: existing.fallback_reason }),
      ...(diagnostics ? { diagnostics } : {}),
    })
  }
  return [...deduplicated.values()].sort((left, right) =>
    left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind))
}

function emptyStatusCounts(): IndexingStatusCounts {
  return {
    indexed: 0,
    indexed_with_warnings: 0,
    skipped_by_policy: 0,
    unsupported: 0,
    failed: 0,
  }
}

function completenessState(counts: IndexingStatusCounts): IndexingCompletenessState {
  const indexed = counts.indexed + counts.indexed_with_warnings
  if (indexed === 0 && (counts.failed > 0 || counts.unsupported > 0)) {
    return 'failed'
  }
  if (
    counts.indexed_with_warnings > 0
    || counts.skipped_by_policy > 0
    || counts.unsupported > 0
    || counts.failed > 0
  ) {
    return 'partial'
  }
  return 'complete'
}

export function summarizeIndexingOutcomes(outcomes: readonly IndexingOutcome[]): IndexingSummary {
  const counts = emptyStatusCounts()
  const reasonBuckets: Partial<Record<IndexingReasonCode, number>> = {}
  const capabilityBuckets: Record<string, number> = {}
  const strategyBuckets: Partial<Record<ExtractionStrategy, number>> = {}
  const fallbackReasonBuckets: Partial<Record<ExtractionFallbackReason, number>> = {}

  for (const outcome of outcomes) {
    counts[outcome.status] += 1
    reasonBuckets[outcome.reason] = (reasonBuckets[outcome.reason] ?? 0) + 1
    const capability = outcome.capability ?? 'none'
    capabilityBuckets[capability] = (capabilityBuckets[capability] ?? 0) + 1
    if (outcome.extraction_strategy) {
      strategyBuckets[outcome.extraction_strategy] = (strategyBuckets[outcome.extraction_strategy] ?? 0) + 1
    }
    if (outcome.fallback_reason) {
      fallbackReasonBuckets[outcome.fallback_reason] = (fallbackReasonBuckets[outcome.fallback_reason] ?? 0) + 1
    }
  }

  return {
    state: completenessState(counts),
    candidates: outcomes.length,
    counts,
    reason_buckets: Object.fromEntries(Object.entries(reasonBuckets).sort(([left], [right]) => left.localeCompare(right))),
    capability_buckets: Object.fromEntries(Object.entries(capabilityBuckets).sort(([left], [right]) => left.localeCompare(right))),
    ...(Object.keys(strategyBuckets).length > 0
      ? { extraction_strategy_buckets: Object.fromEntries(Object.entries(strategyBuckets).sort(([left], [right]) => left.localeCompare(right))) }
      : {}),
    ...(Object.keys(fallbackReasonBuckets).length > 0
      ? { fallback_reason_buckets: Object.fromEntries(Object.entries(fallbackReasonBuckets).sort(([left], [right]) => left.localeCompare(right))) }
      : {}),
  }
}

export function createIndexingManifest(input: {
  outcomes: readonly IndexingOutcome[]
  spiDiagnostics?: readonly IndexingSpiDiagnostic[]
  requestedExtractionMode?: ExtractionMode
  now?: Date
}): IndexingManifestV1 {
  const outcomes = deduplicateIndexingOutcomes(input.outcomes)
  return {
    version: INDEXING_MANIFEST_VERSION,
    generated_at: (input.now ?? new Date()).toISOString(),
    ...(input.requestedExtractionMode ? { requested_extraction_mode: input.requestedExtractionMode } : {}),
    summary: summarizeIndexingOutcomes(outcomes),
    outcomes,
    spi_diagnostics: [...(input.spiDiagnostics ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
  }
}

export function shareSafeIndexingManifest(manifest: IndexingManifestV1): ShareSafeIndexingManifestV1 {
  const levels = { info: 0, warn: 0, error: 0 }
  for (const diagnostic of manifest.spi_diagnostics) {
    levels[diagnostic.level] += 1
  }
  return {
    version: manifest.version,
    generated_at: manifest.generated_at,
    ...(manifest.requested_extraction_mode ? { requested_extraction_mode: manifest.requested_extraction_mode } : {}),
    summary: manifest.summary,
    spi_diagnostics: {
      total: manifest.spi_diagnostics.length,
      levels,
    },
  }
}

export function indexingStrictViolations(
  summary: IndexingSummary,
  thresholds: IndexingStrictThresholds,
): string[] {
  const violations: string[] = []
  if (summary.counts.failed > thresholds.maxFailed) {
    violations.push(`failed=${summary.counts.failed} exceeds maxFailed=${thresholds.maxFailed}`)
  }
  if (summary.counts.unsupported > thresholds.maxUnsupported) {
    violations.push(`unsupported=${summary.counts.unsupported} exceeds maxUnsupported=${thresholds.maxUnsupported}`)
  }
  return violations
}
