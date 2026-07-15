import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeTextFileAtomically } from '../shared/atomic-file.js'

import {
  INDEXING_MANIFEST_VERSION,
  INDEXING_OUTCOME_STATUSES,
  INDEXING_REASON_CODES,
  type IndexingManifestV1,
  type IndexingOutcome,
  type IndexingOutcomeStatus,
  type IndexingReasonCode,
  type RelevantIndexingUncertainty,
} from '../contracts/indexing.js'
import { shareSafeIndexingManifest, summarizeIndexingOutcomes } from '../pipeline/indexing-outcomes.js'

export const INDEXING_MANIFEST_FILENAME = 'indexing-manifest.json'
export const SHARE_SAFE_INDEXING_MANIFEST_FILENAME = 'indexing-manifest.share-safe.json'
export const FAILED_INDEXING_MANIFEST_FILENAME = 'indexing-manifest.failed.json'
export const FAILED_SHARE_SAFE_INDEXING_MANIFEST_FILENAME = 'indexing-manifest.failed.share-safe.json'

const UNCERTAIN_STATUSES = new Set<IndexingOutcomeStatus>([
  'indexed_with_warnings',
  'skipped_by_policy',
  'unsupported',
  'failed',
])
const GENERIC_QUERY_TOKENS = new Set([
  'a', 'an', 'and', 'code', 'does', 'file', 'files', 'flow', 'how', 'in', 'is', 'of', 'or', 'path', 'repo',
  'repository', 'src', 'the', 'this', 'to', 'what', 'where', 'with',
])
const OUTCOME_STATUSES = new Set<string>(INDEXING_OUTCOME_STATUSES)
const REASON_CODES = new Set<string>(INDEXING_REASON_CODES)

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isIndexingOutcome(value: unknown): value is IndexingOutcome {
  if (!isRecord(value)) {
    return false
  }
  return typeof value.path === 'string'
    && (value.kind === 'file' || value.kind === 'directory')
    && typeof value.status === 'string'
    && OUTCOME_STATUSES.has(value.status)
    && typeof value.reason === 'string'
    && REASON_CODES.has(value.reason)
    && (value.capability === null || typeof value.capability === 'string')
    && (
      value.diagnostics === undefined
      || (
        Array.isArray(value.diagnostics)
        && value.diagnostics.every((diagnostic) =>
          isRecord(diagnostic)
          && typeof diagnostic.code === 'string'
          && (diagnostic.level === 'info' || diagnostic.level === 'warning' || diagnostic.level === 'error')
          && (diagnostic.message === undefined || typeof diagnostic.message === 'string'))
      )
    )
}

function isSpiDiagnostic(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.level === 'info' || value.level === 'warn' || value.level === 'error')
    && value.reason === 'spi_diagnostic'
    && (value.path === undefined || typeof value.path === 'string')
    && (value.message === undefined || typeof value.message === 'string')
}

export function parseIndexingManifest(value: unknown): IndexingManifestV1 | null {
  if (!isRecord(value) || value.version !== INDEXING_MANIFEST_VERSION || !Array.isArray(value.outcomes)) {
    return null
  }
  if (!isRecord(value.summary) || !Array.isArray(value.spi_diagnostics) || typeof value.generated_at !== 'string') {
    return null
  }
  if (!value.outcomes.every(isIndexingOutcome) || !value.spi_diagnostics.every(isSpiDiagnostic)) {
    return null
  }
  const outcomes = value.outcomes as IndexingOutcome[]
  return {
    version: INDEXING_MANIFEST_VERSION,
    generated_at: value.generated_at,
    summary: summarizeIndexingOutcomes(outcomes),
    outcomes,
    spi_diagnostics: value.spi_diagnostics as IndexingManifestV1['spi_diagnostics'],
  }
}

export function indexingManifestPathForGraph(graphPath: string): string {
  return join(dirname(graphPath), INDEXING_MANIFEST_FILENAME)
}

export function readIndexingManifestForGraph(graphPath: string): IndexingManifestV1 | null {
  const manifestPath = indexingManifestPathForGraph(graphPath)
  if (!existsSync(manifestPath)) {
    return null
  }
  try {
    return parseIndexingManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
  } catch {
    return null
  }
}

export function writeIndexingManifests(outputDir: string, manifest: IndexingManifestV1): {
  manifestPath: string
  shareSafeManifestPath: string
} {
  const manifestPath = join(outputDir, INDEXING_MANIFEST_FILENAME)
  const shareSafeManifestPath = join(outputDir, SHARE_SAFE_INDEXING_MANIFEST_FILENAME)
  writeTextFileAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  writeTextFileAtomically(shareSafeManifestPath, `${JSON.stringify(shareSafeIndexingManifest(manifest), null, 2)}\n`)
  rmSync(join(outputDir, FAILED_INDEXING_MANIFEST_FILENAME), { force: true })
  rmSync(join(outputDir, FAILED_SHARE_SAFE_INDEXING_MANIFEST_FILENAME), { force: true })
  return { manifestPath, shareSafeManifestPath }
}

export function writeFailedIndexingManifests(outputDir: string, manifest: IndexingManifestV1): {
  manifestPath: string
  shareSafeManifestPath: string
} {
  const manifestPath = join(outputDir, FAILED_INDEXING_MANIFEST_FILENAME)
  const shareSafeManifestPath = join(outputDir, FAILED_SHARE_SAFE_INDEXING_MANIFEST_FILENAME)
  writeTextFileAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  writeTextFileAtomically(shareSafeManifestPath, `${JSON.stringify(shareSafeIndexingManifest(manifest), null, 2)}\n`)
  return { manifestPath, shareSafeManifestPath }
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replaceAll('\\', '/')
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length >= 3 && !GENERIC_QUERY_TOKENS.has(token))
}

function outcomeMatches(outcome: IndexingOutcome, queryTokens: ReadonlySet<string>, owners: readonly string[]): boolean {
  const normalizedPath = outcome.path.toLowerCase().replaceAll('\\', '/')
  if (owners.some((owner) => {
    const normalizedOwner = owner.toLowerCase().replaceAll('\\', '/').replace(/^\.\//, '')
    return normalizedOwner.length > 0 && (normalizedPath.includes(normalizedOwner) || normalizedOwner.includes(normalizedPath))
  })) {
    return true
  }
  if (queryTokens.size === 0) {
    return false
  }
  const pathTokens = new Set(tokenize(normalizedPath))
  return [...queryTokens].some((token) => pathTokens.has(token))
}

function incrementReason(
  target: Partial<Record<IndexingReasonCode, number>>,
  reason: IndexingReasonCode,
): void {
  target[reason] = (target[reason] ?? 0) + 1
}

export function relevantIndexingUncertainty(
  manifest: IndexingManifestV1,
  input: { question?: string; coveredWorkflowOwners?: readonly string[] } = {},
): RelevantIndexingUncertainty {
  const uncertain = manifest.outcomes.filter((outcome) => UNCERTAIN_STATUSES.has(outcome.status))
  const queryTokens = new Set(tokenize(input.question ?? ''))
  const owners = input.coveredWorkflowOwners ?? []
  const relevant = uncertain.filter((outcome) => outcomeMatches(outcome, queryTokens, owners))
  const reasons: Partial<Record<IndexingReasonCode, number>> = {}
  const relevantReasons: Partial<Record<IndexingReasonCode, number>> = {}
  for (const outcome of uncertain) {
    incrementReason(reasons, outcome.reason)
  }
  for (const outcome of relevant) {
    incrementReason(relevantReasons, outcome.reason)
  }
  return {
    total: uncertain.length,
    relevant: relevant.length,
    state: manifest.summary.state,
    reasons,
    relevant_reasons: relevantReasons,
    has_relevant_failures: relevant.some((outcome) => outcome.status === 'failed'),
  }
}
