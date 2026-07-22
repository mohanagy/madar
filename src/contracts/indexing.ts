export const INDEXING_MANIFEST_VERSION = 2 as const

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
  'unsupported_file_type',
  'canonical_diagnostic',
  'canonical_file_missing',
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
}

export interface IndexDiagnosticReceipt {
  id: string
  level: 'info' | 'warn' | 'error'
  reason: 'canonical_diagnostic'
  path?: string
  /** Local-only diagnostic. Share-safe projections never include messages. */
  message?: string
}

export interface IndexingManifest {
  version: typeof INDEXING_MANIFEST_VERSION
  generated_at: string
  summary: IndexingSummary
  outcomes: IndexingOutcome[]
  index_diagnostics: IndexDiagnosticReceipt[]
}

export interface ShareSafeIndexingManifest {
  version: typeof INDEXING_MANIFEST_VERSION
  generated_at: string
  summary: IndexingSummary
  index_diagnostics: {
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
