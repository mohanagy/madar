import { createHash } from 'node:crypto'
import { graphArtifact } from '../graph/artifact.js'
import { canonicalJsonString, canonicalJsonValue, compareCodeUnits } from '../graph/canonical-json.js'
import type { KnowledgeGraph } from '../graph/directed-multigraph.js'
import { hasExactKeys, isRecord } from '../../shared/guards.js'

export const CANONICAL_INDEX_FORMAT_VERSION = 2 as const
export const GENERATION_POLICY_VERSION = 4 as const
export const INDEX_BUILD_STATE_VERSION = 2 as const
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
  code: string; level: 'info' | 'warning' | 'error'; message?: string
}
export interface IndexingOutcome {
  path: string; kind: 'file' | 'directory'; status: IndexingOutcomeStatus
  reason: IndexingReasonCode; capability: string | null
  diagnostics?: IndexingDiagnostic[]
}
export type IndexingStatusCounts = Record<IndexingOutcomeStatus, number>
export interface IndexingSummary {
  state: 'complete' | 'partial' | 'failed'; candidates: number; counts: IndexingStatusCounts
  reason_buckets: Partial<Record<IndexingReasonCode, number>>
  capability_buckets: Record<string, number>
}
export interface IndexDiagnosticReceipt {
  id: string; level: 'info' | 'warn' | 'error'; reason: 'canonical_diagnostic'
  path?: string; message?: string
}
export type IndexingStrictThresholds = { maxFailed: number; maxUnsupported: number }
export interface GenerationPolicySettings {
  index_format_version: typeof CANONICAL_INDEX_FORMAT_VERSION; respect_gitignore: boolean
  follow_symlinks: boolean; exclusion_rules_fingerprint: string
  indexing_strict: { max_failed: number; max_unsupported: number } | null
}
export interface GenerationPolicy {
  version: typeof GENERATION_POLICY_VERSION; fingerprint: string; settings: GenerationPolicySettings
}
export type SourceSnapshotEntry = { path: string; hash: string }
export interface SourceSnapshot {
  version: 2; fingerprint: string
  supported: SourceSnapshotEntry[]; controls: SourceSnapshotEntry[]; unsupported: SourceSnapshotEntry[]
  inventory: SourceSnapshotEntry[]
}
export interface SourceRootIdentity {
  kind: 'directory' | 'primary_worktree' | 'linked_worktree'; root_path: string
  worktree_root: string | null; scope: string
}
export interface IndexBuildState {
  version: typeof INDEX_BUILD_STATE_VERSION; engine_id: typeof INDEX_ENGINE_ID; build_id: string
  policy: GenerationPolicy; sources: SourceSnapshot; source_root: SourceRootIdentity
  corpus: {
    supported_files: number; unsupported_files: number; total_words: number; warning: string | null
  }
  completeness: {
    summary: IndexingSummary; supported_failures: Array<{ path: string; reason: IndexingReasonCode }>
  }
}
export type UpdateMode = 'cold_noop' | 'cold_reconcile'
export interface UpdateReceipt {
  mode: UpdateMode; scanned_files: number; parsed_files: number; reused_files: number
  invalidated_files: number; dependency_closure_size: number
  fallback_reason: 'cold_process' | 'source_or_policy_changed' | 'accepted_artifact_incomplete' | null
  previous_build_id: string | null; accepted_build_id: string; publication_advanced: boolean
}

export class IndexLeaseContentionError extends Error {
  constructor(readonly outputDir: string) {
    super(`Another Madar index build is already running for ${outputDir}`)
    this.name = 'IndexLeaseContentionError'
  }
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }
function isSha256(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
function isNonNegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null { return isRecord(value) && hasExactKeys(value, keys) ? value : null }
function parseCounts(value: unknown, allowed?: readonly string[], exact = false): Record<string, number> | null {
  if (!isRecord(value) || (exact && allowed && !hasExactKeys(value, allowed))
    || Object.entries(value).some(([key, count]) => key.length === 0 || !isNonNegativeInteger(count)
      || (allowed !== undefined && !allowed.includes(key)))) return null
  return value as Record<string, number>
}
function isSafeSnapshotPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\')
    && !value.startsWith('/') && !/^[a-zA-Z]:\//.test(value)
    && !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
}
function parseSnapshotEntries(value: unknown): SourceSnapshotEntry[] | null {
  if (!Array.isArray(value)) return null
  const seen = new Set<string>()
  for (const entry of value) {
    const record = exactRecord(entry, ['path', 'hash'])
    if (!record || !isSafeSnapshotPath(record.path) || !isSha256(record.hash) || seen.has(record.path)) return null
    seen.add(record.path)
  }
  return value as SourceSnapshotEntry[]
}
function parseSourceSnapshot(value: unknown): SourceSnapshot | null {
  const record = exactRecord(value, ['version', 'fingerprint', 'supported', 'controls', 'unsupported', 'inventory'])
  if (!record || record.version !== 2 || !isSha256(record.fingerprint)) return null
  const [supported, controls, unsupported, inventory] = [record.supported, record.controls, record.unsupported, record.inventory].map(parseSnapshotEntries)
  if (!supported || !controls || !unsupported || !inventory) return null
  const parsed = createSourceSnapshot({ supported, controls, unsupported, inventory })
  return canonicalJsonString(parsed) === canonicalJsonString(record) ? parsed : null
}
function parseIndexingSummary(value: unknown): IndexingSummary | null {
  const record = exactRecord(value, ['state', 'candidates', 'counts', 'reason_buckets', 'capability_buckets'])
  if (!record || !['complete', 'partial', 'failed'].includes(String(record.state))
    || !isNonNegativeInteger(record.candidates)
    || !parseCounts(record.counts, INDEXING_OUTCOME_STATUSES, true)
    || !parseCounts(record.reason_buckets, INDEXING_REASON_CODES)
    || !parseCounts(record.capability_buckets)) return null
  return record as unknown as IndexingSummary
}
function parseSourceRoot(value: unknown): SourceRootIdentity | null {
  const record = exactRecord(value, ['kind', 'root_path', 'worktree_root', 'scope'])
  return record && ['directory', 'primary_worktree', 'linked_worktree'].includes(String(record.kind))
    && typeof record.root_path === 'string' && record.root_path.length > 0 && typeof record.scope === 'string' && record.scope.length > 0
    && (record.worktree_root === null || (typeof record.worktree_root === 'string' && record.worktree_root.length > 0))
    ? record as unknown as SourceRootIdentity : null
}
function parseCorpus(value: unknown): IndexBuildState['corpus'] | null {
  const record = exactRecord(value, ['supported_files', 'unsupported_files', 'total_words', 'warning'])
  return record && [record.supported_files, record.unsupported_files, record.total_words].every(isNonNegativeInteger)
    && (record.warning === null || typeof record.warning === 'string')
    ? record as unknown as IndexBuildState['corpus'] : null
}
function parseCompleteness(value: unknown): IndexBuildState['completeness'] | null {
  const record = exactRecord(value, ['summary', 'supported_failures'])
  if (!record || !Array.isArray(record.supported_failures)) return null
  const summary = parseIndexingSummary(record.summary)
  const validFailures = record.supported_failures.every((failure) => {
    const item = exactRecord(failure, ['path', 'reason'])
    return item !== null && isSafeSnapshotPath(item.path) && INDEXING_REASON_CODES.includes(item.reason as IndexingReasonCode)
  })
  return summary && validFailures && ((record.supported_failures.length === 0) === (summary.state === 'complete'))
    ? record as unknown as IndexBuildState['completeness'] : null
}
export function createGenerationPolicy(settings: GenerationPolicySettings): GenerationPolicy {
  const document = { version: GENERATION_POLICY_VERSION, settings }
  return { ...document, fingerprint: sha256(canonicalJsonString(document)) }
}
export function parseGenerationPolicy(value: unknown): GenerationPolicy | null {
  const record = exactRecord(value, ['version', 'fingerprint', 'settings'])
  const settings = exactRecord(record?.settings, [
    'index_format_version', 'respect_gitignore', 'follow_symlinks', 'exclusion_rules_fingerprint', 'indexing_strict',
  ])
  if (!record || record.version !== GENERATION_POLICY_VERSION || !isSha256(record.fingerprint) || !settings) return null
  const strict = settings.indexing_strict
  if (settings.index_format_version !== CANONICAL_INDEX_FORMAT_VERSION
    || typeof settings.respect_gitignore !== 'boolean' || typeof settings.follow_symlinks !== 'boolean'
    || !isSha256(settings.exclusion_rules_fingerprint)
    || !(strict === null || (isRecord(strict) && hasExactKeys(strict, ['max_failed', 'max_unsupported'])
      && isNonNegativeInteger(strict.max_failed) && isNonNegativeInteger(strict.max_unsupported)))) return null
  const parsed = createGenerationPolicy(settings as unknown as GenerationPolicySettings)
  return canonicalJsonString(parsed) === canonicalJsonString(record) ? parsed : null
}
export function createSourceSnapshot(
  input: Omit<SourceSnapshot, 'version' | 'fingerprint' | 'inventory'> & { inventory?: SourceSnapshotEntry[] },
): SourceSnapshot {
  const normalize = (entries: readonly SourceSnapshotEntry[]) => [...entries]
    .map((entry) => ({ path: entry.path.replaceAll('\\', '/').replace(/^\.\//, ''), hash: entry.hash }))
    .sort((left, right) => compareCodeUnits(left.path, right.path))
  const contents = {
    supported: normalize(input.supported),
    controls: normalize(input.controls),
    unsupported: normalize(input.unsupported),
    inventory: normalize(input.inventory ?? []),
  }
  return { version: 2, fingerprint: sha256(canonicalJsonString(contents)), ...contents }
}
export function sourceSnapshotsEqual(left: SourceSnapshot, right: SourceSnapshot): boolean { return left.fingerprint === right.fingerprint }
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
export function computeBuildId(graph: KnowledgeGraph): string { return sha256(canonicalJsonString(portableBuildPayload(graph))) }
export function attachBuildState(graph: KnowledgeGraph, state: Omit<IndexBuildState, 'build_id'>): IndexBuildState {
  const pending: IndexBuildState = { ...state, build_id: '' }
  graph.graph.index_build = pending
  const accepted = { ...pending, build_id: computeBuildId(graph) }
  graph.graph.index_build = accepted
  return accepted
}
export function readBuildState(graph: KnowledgeGraph): IndexBuildState | null {
  const value = exactRecord(graph.graph.index_build, ['version', 'engine_id', 'build_id', 'policy', 'sources', 'source_root', 'corpus', 'completeness'])
  if (!value || value.version !== INDEX_BUILD_STATE_VERSION || value.engine_id !== INDEX_ENGINE_ID
    || !isSha256(value.build_id)) return null
  const policy = parseGenerationPolicy(value.policy)
  const sources = parseSourceSnapshot(value.sources)
  const sourceRoot = parseSourceRoot(value.source_root)
  const corpus = parseCorpus(value.corpus)
  const completeness = parseCompleteness(value.completeness)
  if (!policy || !sources || !sourceRoot || !corpus || !completeness
    || corpus.supported_files !== sources.supported.length
    || corpus.unsupported_files !== sources.unsupported.length) return null
  const parsed = value as unknown as IndexBuildState
  return computeBuildId(graph) === parsed.build_id ? parsed : null
}
