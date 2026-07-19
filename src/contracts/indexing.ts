import type { ExtractionMode } from './generation-policy.js'

export const INDEXING_MANIFEST_VERSION = 1 as const

/**
 * The actual pipeline route used for a candidate. `legacy_fallback` is
 * intentionally distinct from `legacy`: it proves that auto mode chose SPI
 * first, then retained a source language SPI does not implement.
 */
export const EXTRACTION_STRATEGIES = [
  'spi',
  'legacy',
  'legacy_fallback',
  'non_code',
  'not_extracted',
] as const

export type ExtractionStrategy = (typeof EXTRACTION_STRATEGIES)[number]

export const EXTRACTION_FALLBACK_REASONS = [
  'spi_unsupported_language',
] as const

export type ExtractionFallbackReason = (typeof EXTRACTION_FALLBACK_REASONS)[number]

export const INDEXING_OUTCOME_STATUSES = [
  'indexed',
  'indexed_with_warnings',
  'skipped_by_policy',
  'unsupported',
  'failed',
] as const

export type IndexingOutcomeStatus = (typeof INDEXING_OUTCOME_STATUSES)[number]

export type IndexingOutcomeKind = 'file' | 'directory'

export const INDEXING_REASON_CODES = [
  'indexed',
  'indexed_from_cache',
  'retained_from_graph',
  'retained_evidence_missing',
  'parser_fallback',
  'empty_extraction',
  'environment_file',
  'private_key',
  'credential_store',
  'secret_config',
  'sensitive_directory',
  'unreadable_path',
  'unreadable_directory',
  'hidden_path',
  'hard_ignored',
  'madarignore',
  'gitignored',
  'noise_path',
  'symlink_disabled',
  'symlink_outside_root',
  'symlink_cycle',
  'docs_disabled',
  'unsupported_file_type',
  'unsupported_spi_language',
  'capability_missing',
  'extractor_error',
  'spi_diagnostic',
  'spi_file_missing',
  'manifest_stat_failed',
] as const

export type IndexingReasonCode = (typeof INDEXING_REASON_CODES)[number]

export interface IndexingDiagnostic {
  code: string
  level: 'info' | 'warning' | 'error'
  /** Local-only diagnostic. Share-safe projections never include messages. */
  message?: string
}

export interface IndexingOutcome {
  path: string
  kind: IndexingOutcomeKind
  status: IndexingOutcomeStatus
  reason: IndexingReasonCode
  capability: string | null
  /** Actual route selected for this candidate in the published graph. */
  extraction_strategy?: ExtractionStrategy
  /** Present only when auto mode deliberately routed a file away from SPI. */
  fallback_reason?: ExtractionFallbackReason
  diagnostics?: IndexingDiagnostic[]
}

export interface IndexingStatusCounts {
  indexed: number
  indexed_with_warnings: number
  skipped_by_policy: number
  unsupported: number
  failed: number
}

export type IndexingCompletenessState = 'complete' | 'partial' | 'failed'

export interface IndexingSummary {
  state: IndexingCompletenessState
  candidates: number
  counts: IndexingStatusCounts
  reason_buckets: Partial<Record<IndexingReasonCode, number>>
  capability_buckets: Record<string, number>
  /** Omitted for pre-receipt manifests so they remain readable. */
  extraction_strategy_buckets?: Partial<Record<ExtractionStrategy, number>>
  fallback_reason_buckets?: Partial<Record<ExtractionFallbackReason, number>>
}

export interface IndexingSpiDiagnostic {
  id: string
  level: 'info' | 'warn' | 'error'
  reason: 'spi_diagnostic'
  path?: string
  /** Local-only diagnostic. Share-safe projections never include messages. */
  message?: string
}

export interface IndexingManifestV1 {
  version: typeof INDEXING_MANIFEST_VERSION
  generated_at: string
  /** Requested user-facing mode, independent from the per-file route below. */
  requested_extraction_mode?: ExtractionMode
  summary: IndexingSummary
  outcomes: IndexingOutcome[]
  spi_diagnostics: IndexingSpiDiagnostic[]
}

export interface ShareSafeIndexingManifestV1 {
  version: typeof INDEXING_MANIFEST_VERSION
  generated_at: string
  requested_extraction_mode?: ExtractionMode
  summary: IndexingSummary
  spi_diagnostics: {
    total: number
    levels: Record<'info' | 'warn' | 'error', number>
  }
}

export interface IndexingStrictThresholds {
  maxFailed: number
  maxUnsupported: number
}

export interface RelevantIndexingUncertainty {
  total: number
  relevant: number
  state: IndexingCompletenessState
  reasons: Partial<Record<IndexingReasonCode, number>>
  relevant_reasons: Partial<Record<IndexingReasonCode, number>>
  has_relevant_failures: boolean
}
