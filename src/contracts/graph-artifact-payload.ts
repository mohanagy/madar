/**
 * What makes a decoded v2 payload structurally a graph artifact.
 *
 * The workspace classifier and the artifact parser both have to answer this,
 * and they answered it differently. The classifier accepted any JSON body
 * after the magic header, so a header followed by `{}` classified as
 * `current_v2`: a default load selected it, `doctor` called the workspace
 * healthy, and the reuse paths proceeded — and then the parser threw a raw
 * invariant error with no workspace state on it. That is the same failure the
 * mixed-state work exists to prevent, one layer down: an unusable workspace
 * that answers instead of refusing.
 *
 * This module is the single owner of the question. It sits below both callers
 * so neither has to import the other — the parser depends on the classifier,
 * so the classifier cannot reach back into the parser for it.
 */

import { ENDPOINT_IDENTITY_POLICY_VERSION } from './endpoint-identity.js'
import { RELATION_DISCRIMINATOR_REGISTRY_ID } from './relation-discriminator.js'
import {
  EVIDENCE_OCCURRENCE_IDENTITY_SCHEMA_VERSION,
  SEMANTIC_FACT_IDENTITY_SCHEMA_VERSION,
} from './semantic-identity.js'

export const GRAPH_ARTIFACT_VERSION = 2 as const
export const GRAPH_ARTIFACT_RECEIPT_STORAGE_SCHEMA_VERSION = 1 as const

/** The version fields a payload must carry, with the only values accepted. */
export const SUPPORTED_GRAPH_ARTIFACT_VERSIONS: Readonly<Record<string, unknown>> = Object.freeze({
  graph_artifact: GRAPH_ARTIFACT_VERSION,
  semantic_fact_identity: SEMANTIC_FACT_IDENTITY_SCHEMA_VERSION,
  evidence_occurrence_identity: EVIDENCE_OCCURRENCE_IDENTITY_SCHEMA_VERSION,
  relation_discriminator_registry: RELATION_DISCRIMINATOR_REGISTRY_ID,
  endpoint_identity_qualification_policy: ENDPOINT_IDENTITY_POLICY_VERSION,
  receipt_storage_schema: GRAPH_ARTIFACT_RECEIPT_STORAGE_SCHEMA_VERSION,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The optional additive key that carries #658 normalized-boundary accounting.
 *
 * It lives *inside* `integrity_receipt` rather than beside it as a new payload
 * field, so a reader that predates #658 walks straight past it while reading
 * the storage-only receipt it already understands. Nothing about artifact
 * identity moves for it: same magic, same `graph_artifact: 2`, same
 * `receipt_storage_schema: 1`, same `out/graph.madar`.
 */
export const NORMALIZED_ACCOUNTING_ARTIFACT_KEY = 'normalized_accounting' as const

/** The exact key set of a normalized accounting block. Closed on both sides. */
export const NORMALIZED_ACCOUNTING_KEYS = [
  'receipt',
  'unresolved_records',
  'rejected_records',
  'conflict_records',
  'scope_failures',
  'scope_failure_retention',
  'reserved',
] as const

/** The exact key set of the normalized receipt the block carries. */
export const NORMALIZED_RECEIPT_KEYS = [
  'receipt_version',
  'reason_vocabulary_version',
  'accounting_scope',
  'emitted_candidates',
  'terminal_counts',
  'facts_retained',
  'occurrences_retained',
  'unique_endpoint_pairs',
  'terminal_reason_counts',
  'missing_source_endpoints',
  'missing_target_endpoints',
  'malformed_candidates',
  'unsupported_relations',
  'endpoint_identity',
  'durable_records',
  'status',
  'reasons',
  'strict_mode_result',
] as const

export const NORMALIZED_RECEIPT_ENDPOINT_IDENTITY_KEYS = [
  'statuses',
  'fact_pair_counts',
  'reason_fact_counts',
] as const

export const NORMALIZED_RECEIPT_DURABLE_RECORD_KEYS = [
  'unresolved',
  'rejected',
  'conflicting',
  'max_records_per_kind',
] as const

/**
 * Names the first *structural* problem with a normalized accounting block.
 *
 * Structural only, deliberately. This is the altitude the workspace classifier
 * works at for every other field: `nodes` must be an array, not a valid node
 * list. Meaning -- the candidate equation, record identity, share safety, a
 * status that agrees with its own counters -- belongs to the integrity
 * contracts and is enforced in the parser.
 *
 * What matters is that the classifier can no longer call a block healthy whose
 * *shape* the parser will refuse. That was the exact failure the storage
 * receipt taught: a workspace that answers instead of refusing, then throws one
 * layer down.
 */
export function normalizedAccountingStructureError(value: unknown, field: string): string | null {
  if (!isRecord(value)) return `${field} must be an object`

  const allowed = new Set<string>(NORMALIZED_ACCOUNTING_KEYS)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return `${field} carries unknown field ${JSON.stringify(key)}`
  }
  for (const key of NORMALIZED_ACCOUNTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return `${field} is missing required field ${JSON.stringify(key)}`
    }
  }

  if (!isRecord(value.receipt)) return `${field}.receipt must be an object`
  for (const key of ['unresolved_records', 'rejected_records', 'conflict_records', 'scope_failures'] as const) {
    if (!Array.isArray(value[key])) return `${field}.${key} must be an array`
  }
  if (!isRecord(value.scope_failure_retention)) return `${field}.scope_failure_retention must be an object`
  if (!isRecord(value.reserved)) return `${field}.reserved must be an object`
  if (Object.keys(value.reserved).length !== 0) {
    return `${field}.reserved is reserved and must be empty in artifact v2`
  }

  return null
}

/**
 * Names the first structural problem with a decoded payload, or null when it
 * has none.
 *
 * A reason rather than a throw, because one caller is a boolean classifier on
 * the load path and the other is a parser that raises its own typed errors
 * with its own wording. Returning the reason lets both use one rule without
 * either inheriting the other's error contract.
 */
export function v2PayloadStructureError(payload: unknown): string | null {
  if (!isRecord(payload)) return 'artifact payload must be an object'

  const versions = payload.versions
  if (!isRecord(versions)) return 'versions must be an object'
  for (const [key, expected] of Object.entries(SUPPORTED_GRAPH_ARTIFACT_VERSIONS)) {
    if (versions[key] !== expected) {
      return `unsupported version for ${key}: ${JSON.stringify(versions[key])}`
    }
  }
  const unknownVersionKeys = Object.keys(versions)
    .filter((key) => !Object.prototype.hasOwnProperty.call(SUPPORTED_GRAPH_ARTIFACT_VERSIONS, key))
  if (unknownVersionKeys.length > 0) {
    return `unsupported version field ${JSON.stringify(unknownVersionKeys[0])}`
  }

  if (typeof payload.directed !== 'boolean') return 'directed must be boolean'

  const communityLabels = payload.community_labels
  if (!isRecord(communityLabels)) return 'community_labels must be an object'
  for (const [communityId, label] of Object.entries(communityLabels)) {
    if (!/^\d+$/.test(communityId) || typeof label !== 'string') {
      return 'community_labels must map non-negative integer keys to strings'
    }
  }

  // Non-empty, matching the parser: an empty repository_revision is not a
  // revision. An earlier version of this rule accepted any string, so such a
  // payload classified as usable and then failed in the parser -- the exact
  // divergence this module exists to close.
  for (const field of ['repository_revision', 'generation_mode', 'generated_at'] as const) {
    const value = payload[field]
    if (typeof value !== 'string' || value.length === 0) return `${field} must be a non-empty string`
  }

  for (const field of ['nodes', 'facts', 'occurrences', 'hyperedges'] as const) {
    if (!Array.isArray(payload[field])) return `${field} must be an array`
  }

  if (payload.provenance !== undefined && !isRecord(payload.provenance)) {
    return 'provenance must be an object'
  }

  // Optional and additive: a payload with no normalized accounting is a
  // perfectly good storage-only v2, which is what every artifact written before
  // #658 is. Present-and-malformed is a different thing, and it fails here
  // rather than one layer down in the parser.
  const integrityReceipt = payload.integrity_receipt
  if (
    isRecord(integrityReceipt)
    && Object.prototype.hasOwnProperty.call(integrityReceipt, NORMALIZED_ACCOUNTING_ARTIFACT_KEY)
  ) {
    const normalizedError = normalizedAccountingStructureError(
      integrityReceipt[NORMALIZED_ACCOUNTING_ARTIFACT_KEY],
      `integrity_receipt.${NORMALIZED_ACCOUNTING_ARTIFACT_KEY}`,
    )
    if (normalizedError !== null) return normalizedError
  }

  // Required, not optional: the parser reads it through the same object check
  // every other record field uses, so an absent reserved block is a refusal
  // there and has to be one here too.
  if (!isRecord(payload.reserved)) return 'reserved must be an object'
  if (Object.keys(payload.reserved).length !== 0) {
    return 'reserved is reserved and must be empty in artifact v2'
  }

  return null
}
