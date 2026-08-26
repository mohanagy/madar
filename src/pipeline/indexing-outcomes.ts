import { relative, sep } from 'node:path'

import { compareUnicodeCodePoints } from '../contracts/canonical-json.js'
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
  // Code point, not collation: this order is written into indexing-manifest.json,
  // and `localeCompare` answers according to the host's ICU locale, so two
  // machines published different bytes for the same repository. De-duplication
  // above is by `kind:path` and has already happened, so this sort only decides
  // byte order -- it can never change which outcome survives.
  return [...deduplicated.values()].sort((left, right) =>
    compareUnicodeCodePoints(left.path, right.path) || compareUnicodeCodePoints(left.kind, right.kind))
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

  // The bucket key orders below are byte order: this summary is serialized with
  // a plain `JSON.stringify`, so an object's insertion order IS its byte order.
  // `reason`, `extraction_strategy` and `fallback_reason` are closed ASCII sets
  // that every collation orders alike, but `capability` is an open domain --
  // `parseIndexingManifest` accepts any string and incremental generation
  // returns a prior outcome verbatim -- so a manifest on disk can round-trip a
  // value the host locale orders differently. All four use the one comparator.
  return {
    state: completenessState(counts),
    candidates: outcomes.length,
    counts,
    reason_buckets: Object.fromEntries(Object.entries(reasonBuckets).sort(([left], [right]) => compareUnicodeCodePoints(left, right))),
    capability_buckets: Object.fromEntries(Object.entries(capabilityBuckets).sort(([left], [right]) => compareUnicodeCodePoints(left, right))),
    ...(Object.keys(strategyBuckets).length > 0
      ? { extraction_strategy_buckets: Object.fromEntries(Object.entries(strategyBuckets).sort(([left], [right]) => compareUnicodeCodePoints(left, right))) }
      : {}),
    ...(Object.keys(fallbackReasonBuckets).length > 0
      ? { fallback_reason_buckets: Object.fromEntries(Object.entries(fallbackReasonBuckets).sort(([left], [right]) => compareUnicodeCodePoints(left, right))) }
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
    // Diagnostic ids are projected verbatim from the SPI, and the SPI cache
    // shape-checks only version/workspace/files/symbols, so a cached index can
    // carry any id at all. Code point keeps the manifest bytes host-independent.
    spi_diagnostics: [...(input.spiDiagnostics ?? [])].sort((left, right) =>
      compareUnicodeCodePoints(left.id, right.id)),
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
