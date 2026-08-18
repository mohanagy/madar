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

  for (const field of ['repository_revision', 'generation_mode', 'generated_at'] as const) {
    if (typeof payload[field] !== 'string') return `${field} must be a string`
  }

  for (const field of ['nodes', 'facts', 'occurrences', 'hyperedges'] as const) {
    if (!Array.isArray(payload[field])) return `${field} must be an array`
  }

  const communityLabels = payload.community_labels
  if (!isRecord(communityLabels)) return 'community_labels must be an object'
  for (const [communityId, label] of Object.entries(communityLabels)) {
    if (!/^\d+$/.test(communityId) || typeof label !== 'string') {
      return 'community_labels must map non-negative integer keys to strings'
    }
  }

  if (payload.provenance !== undefined && !isRecord(payload.provenance)) {
    return 'provenance must be an object'
  }

  const reserved = payload.reserved
  if (reserved !== undefined && (!isRecord(reserved) || Object.keys(reserved).length > 0)) {
    return 'reserved must be an empty object'
  }

  return null
}
