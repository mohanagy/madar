import { createHash } from 'node:crypto'

import { graphArtifact } from '../graph/artifact.js'
import { canonicalJsonString, canonicalJsonValue } from '../graph/canonical-json.js'
import type { KnowledgeGraph } from '../graph/directed-multigraph.js'
import { hasExactKeys, isRecord } from '../../shared/guards.js'

export const CANONICAL_INDEX_FORMAT_VERSION = 2 as const
export const GENERATION_POLICY_VERSION = 4 as const
export const INDEX_BUILD_STATE_VERSION = 1 as const
export const INDEX_ENGINE_ID = 'madar-typescript-index-v2' as const

export const INDEXING_OUTCOME_STATUSES = [
  'indexed', 'indexed_with_warnings', 'skipped_by_policy', 'unsupported', 'failed',
] as const

export const INDEXING_REASON_CODES = [
  'indexed', 'environment_file', 'private_key', 'credential_store', 'secret_config',
  'sensitive_directory', 'unreadable_path', 'unreadable_directory', 'hidden_path',
  'hard_ignored', 'madarignore', 'gitignored', 'noise_path', 'symlink_disabled',
  'symlink_outside_root', 'symlink_cycle', 'unsupported_file_type',
  'canonical_diagnostic', 'canonical_file_missing',
] as const

export type IndexingOutcomeStatus = (typeof INDEXING_OUTCOME_STATUSES)[number]
export type IndexingReasonCode = (typeof INDEXING_REASON_CODES)[number]
export interface IndexingDiagnostic {
  code: string
  level: 'info' | 'warning' | 'error'
  message?: string
}
export interface IndexingOutcome {
  path: string
  kind: 'file' | 'directory'
  status: IndexingOutcomeStatus
  reason: IndexingReasonCode
  capability: string | null
  diagnostics?: IndexingDiagnostic[]
}
export type IndexingStatusCounts = Record<IndexingOutcomeStatus, number>
export interface IndexingSummary {
  /** Only supported JS/TS failures make this partial or failed. */
  state: 'complete' | 'partial' | 'failed'
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
  message?: string
}
export type IndexingStrictThresholds = { maxFailed: number; maxUnsupported: number }
export interface GenerationPolicySettings {
  index_format_version: typeof CANONICAL_INDEX_FORMAT_VERSION
  respect_gitignore: boolean
  follow_symlinks: boolean
  exclusion_rules_fingerprint: string
  indexing_strict: { max_failed: number; max_unsupported: number } | null
}
export interface GenerationPolicy {
  version: typeof GENERATION_POLICY_VERSION
  fingerprint: string
  settings: GenerationPolicySettings
}
export type SourceSnapshotEntry = { path: string; hash: string }
export interface SourceSnapshot {
  version: 1
  fingerprint: string
  supported: SourceSnapshotEntry[]
  controls: SourceSnapshotEntry[]
  unsupported: SourceSnapshotEntry[]
}
export interface SourceRootIdentity {
  kind: 'directory' | 'primary_worktree' | 'linked_worktree'
  root_path: string
  worktree_root: string | null
  scope: string
}
export interface IndexBuildState {
  version: typeof INDEX_BUILD_STATE_VERSION
  engine_id: typeof INDEX_ENGINE_ID
  build_id: string
  policy: GenerationPolicy
  sources: SourceSnapshot
  source_root: SourceRootIdentity
  corpus: {
    supported_files: number
    unsupported_files: number
    total_words: number
    warning: string | null
  }
  completeness: {
    summary: IndexingSummary
    supported_failures: Array<{ path: string; reason: IndexingReasonCode }>
  }
}
export type UpdateMode = 'cold_noop' | 'cold_reconcile' | 'warm_incremental'
export interface UpdateReceipt {
  mode: UpdateMode
  scanned_files: number
  parsed_files: number
  reused_files: number
  invalidated_files: number
  dependency_closure_size: number
  fallback_reason: 'cold_process' | 'compiler_control_changed' | 'corrupt_warm_state' | null
  previous_build_id: string | null
  accepted_build_id: string
  publication_advanced: boolean
}

/** A healthy competing process currently owns the index publication lease. */
export class IndexLeaseContentionError extends Error {
  constructor(readonly outputDir: string) {
    super(`Another Madar index build is already running for ${outputDir}`)
    this.name = 'IndexLeaseContentionError'
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseCounts(value: unknown, allowed?: readonly string[], exact = false): Record<string, number> | null {
  if (!isRecord(value) || (exact && allowed && !hasExactKeys(value, [...allowed]))) return null
  const entries = Object.entries(value)
  if (entries.some(([key, count]) => key.length === 0 || !isNonNegativeInteger(count)
    || (allowed !== undefined && !allowed.includes(key)))) return null
  return Object.fromEntries(entries) as Record<string, number>
}
function isSafeSnapshotPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) return false
  if (value.startsWith('/') || /^[a-zA-Z]:\//.test(value)) return false
  return !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
}

function parseSnapshotEntries(value: unknown): SourceSnapshotEntry[] | null {
  if (!Array.isArray(value)) return null
  const entries: SourceSnapshotEntry[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isRecord(entry) || !hasExactKeys(entry, ['path', 'hash'])
      || !isSafeSnapshotPath(entry.path) || !isSha256(entry.hash) || seen.has(entry.path)) return null
    seen.add(entry.path)
    entries.push({ path: entry.path, hash: entry.hash })
  }
  return entries
}
function parseSourceSnapshot(value: unknown): SourceSnapshot | null {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'fingerprint', 'supported', 'controls', 'unsupported'])
    || value.version !== 1 || !isSha256(value.fingerprint)) return null
  const supported = parseSnapshotEntries(value.supported)
  const controls = parseSnapshotEntries(value.controls)
  const unsupported = parseSnapshotEntries(value.unsupported)
  if (!supported || !controls || !unsupported) return null
  const parsed = createSourceSnapshot({ supported, controls, unsupported })
  return canonicalJsonString(parsed) === canonicalJsonString(value) ? parsed : null
}
function parseIndexingSummary(value: unknown): IndexingSummary | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'state', 'candidates', 'counts', 'reason_buckets', 'capability_buckets',
  ]) || !['complete', 'partial', 'failed'].includes(String(value.state))
    || !isNonNegativeInteger(value.candidates)) return null
  const counts = parseCounts(value.counts, INDEXING_OUTCOME_STATUSES, true)
  const reasons = parseCounts(value.reason_buckets, INDEXING_REASON_CODES)
  const capabilities = parseCounts(value.capability_buckets)
  if (!counts || !reasons || !capabilities) return null
  return {
    state: value.state as IndexingSummary['state'],
    candidates: value.candidates,
    counts: counts as IndexingStatusCounts,
    reason_buckets: reasons as IndexingSummary['reason_buckets'],
    capability_buckets: capabilities,
  }
}
function parseSourceRoot(value: unknown): SourceRootIdentity | null {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'root_path', 'worktree_root', 'scope'])
    || !['directory', 'primary_worktree', 'linked_worktree'].includes(String(value.kind))
    || typeof value.root_path !== 'string' || value.root_path.length === 0
    || !(value.worktree_root === null || (typeof value.worktree_root === 'string' && value.worktree_root.length > 0))
    || typeof value.scope !== 'string' || value.scope.length === 0) return null
  return value as unknown as SourceRootIdentity
}
function parseCorpus(value: unknown): IndexBuildState['corpus'] | null {
  if (!isRecord(value) || !hasExactKeys(value, ['supported_files', 'unsupported_files', 'total_words', 'warning'])
    || !isNonNegativeInteger(value.supported_files) || !isNonNegativeInteger(value.unsupported_files)
    || !isNonNegativeInteger(value.total_words)
    || !(value.warning === null || typeof value.warning === 'string')) return null
  return value as unknown as IndexBuildState['corpus']
}
function parseCompleteness(value: unknown): IndexBuildState['completeness'] | null {
  if (!isRecord(value) || !hasExactKeys(value, ['summary', 'supported_failures'])
    || !Array.isArray(value.supported_failures)) return null
  const summary = parseIndexingSummary(value.summary)
  if (!summary) return null
  const supportedFailures: IndexBuildState['completeness']['supported_failures'] = []
  for (const failure of value.supported_failures) {
    if (!isRecord(failure) || !hasExactKeys(failure, ['path', 'reason'])
      || !isSafeSnapshotPath(failure.path)
      || !INDEXING_REASON_CODES.includes(failure.reason as IndexingReasonCode)) return null
    supportedFailures.push({ path: failure.path, reason: failure.reason as IndexingReasonCode })
  }
  if ((supportedFailures.length === 0) !== (summary.state === 'complete')) return null
  return { summary, supported_failures: supportedFailures }
}
export function createGenerationPolicy(settings: GenerationPolicySettings): GenerationPolicy {
  const document = { version: GENERATION_POLICY_VERSION, settings }
  return { ...document, fingerprint: sha256(canonicalJsonString(document)) }
}
export function parseGenerationPolicy(value: unknown): GenerationPolicy | null {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'fingerprint', 'settings'])
    || value.version !== GENERATION_POLICY_VERSION || !isSha256(value.fingerprint)
    || !isRecord(value.settings)
    || !hasExactKeys(value.settings, [
      'index_format_version', 'respect_gitignore', 'follow_symlinks',
      'exclusion_rules_fingerprint', 'indexing_strict',
    ])) return null
  const strict = value.settings.indexing_strict
  if (value.settings.index_format_version !== CANONICAL_INDEX_FORMAT_VERSION
    || typeof value.settings.respect_gitignore !== 'boolean'
    || typeof value.settings.follow_symlinks !== 'boolean'
    || !isSha256(value.settings.exclusion_rules_fingerprint)
    || !(strict === null || (isRecord(strict) && hasExactKeys(strict, ['max_failed', 'max_unsupported'])
      && isNonNegativeInteger(strict.max_failed) && isNonNegativeInteger(strict.max_unsupported)))) return null
  const parsed = createGenerationPolicy(value.settings as unknown as GenerationPolicySettings)
  return canonicalJsonString(parsed) === canonicalJsonString(value) ? parsed : null
}
export function createSourceSnapshot(input: Omit<SourceSnapshot, 'version' | 'fingerprint'>): SourceSnapshot {
  const normalize = (entries: readonly SourceSnapshotEntry[]) => [...entries]
    .map((entry) => ({ path: entry.path.replaceAll('\\', '/').replace(/^\.\//, ''), hash: entry.hash }))
    .sort((left, right) => left.path.localeCompare(right.path))
  const contents = {
    supported: normalize(input.supported),
    controls: normalize(input.controls),
    unsupported: normalize(input.unsupported),
  }
  return { version: 1, fingerprint: sha256(canonicalJsonString(contents)), ...contents }
}
export function sourceSnapshotsEqual(left: SourceSnapshot, right: SourceSnapshot): boolean {
  return left.fingerprint === right.fingerprint && canonicalJsonString(left) === canonicalJsonString(right)
}

function portableBuildPayload(graph: KnowledgeGraph): unknown {
  const artifact = canonicalJsonValue(graphArtifact(graph)) as ReturnType<typeof graphArtifact>
  artifact.metadata.root_path = '.'
  const state = artifact.metadata.index_build
  if (isRecord(state)) {
    state.build_id = ''
    const sourceRoot = state.source_root
    if (isRecord(sourceRoot)) {
      sourceRoot.root_path = '.'
      sourceRoot.worktree_root = sourceRoot.worktree_root === null ? null : '<worktree>'
    }
  }
  return artifact
}
export function computeBuildId(graph: KnowledgeGraph): string {
  return sha256(canonicalJsonString(portableBuildPayload(graph)))
}
export function attachBuildState(graph: KnowledgeGraph, state: Omit<IndexBuildState, 'build_id'>): IndexBuildState {
  const pending: IndexBuildState = { ...state, build_id: '' }
  graph.graph.index_build = pending
  const accepted = { ...pending, build_id: computeBuildId(graph) }
  graph.graph.index_build = accepted
  return accepted
}
export function readBuildState(graph: KnowledgeGraph): IndexBuildState | null {
  const value = graph.graph.index_build
  if (!isRecord(value) || !hasExactKeys(value, [
    'version', 'engine_id', 'build_id', 'policy', 'sources', 'source_root', 'corpus', 'completeness',
  ]) || value.version !== INDEX_BUILD_STATE_VERSION || value.engine_id !== INDEX_ENGINE_ID
    || !isSha256(value.build_id)) return null
  const policy = parseGenerationPolicy(value.policy)
  const sources = parseSourceSnapshot(value.sources)
  const sourceRoot = parseSourceRoot(value.source_root)
  const corpus = parseCorpus(value.corpus)
  const completeness = parseCompleteness(value.completeness)
  if (!policy || !sources || !sourceRoot || !corpus || !completeness
    || corpus.supported_files !== sources.supported.length
    || corpus.unsupported_files !== sources.unsupported.length) return null
  const parsed: IndexBuildState = {
    version: INDEX_BUILD_STATE_VERSION,
    engine_id: INDEX_ENGINE_ID,
    build_id: value.build_id,
    policy,
    sources,
    source_root: sourceRoot,
    corpus,
    completeness,
  }
  if (canonicalJsonString(parsed) !== canonicalJsonString(value)) return null
  return computeBuildId(graph) === parsed.build_id ? parsed : null
}
