import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { serializeCanonicalJson } from './canonical-json.js'
import {
  ENDPOINT_IDENTITY_REASONS,
  ENDPOINT_IDENTITY_POLICY_VERSION,
  ENDPOINT_IDENTITY_STATUSES,
  classifyLegacyEndpoint,
  validateEndpointIdentityEndpointQualification,
  validateEndpointIdentityQualification,
  type EndpointIdentityEndpointQualification,
  type EndpointIdentityQualification,
  type EndpointIdentityReason,
  type EndpointIdentityStatus,
} from './endpoint-identity.js'
import { KnowledgeGraph, type GraphAttributes, type StorageBoundaryAdmissionSummary } from './graph.js'
import {
  canonicalEndpointPair,
  createEvidenceOccurrence,
  createSemanticFact,
  EVIDENCE_OCCURRENCE_IDENTITY_SCHEMA_VERSION,
  SEMANTIC_FACT_IDENTITY_SCHEMA_VERSION,
} from './semantic-identity.js'
import {
  LEGACY_PARALLEL_FACTS_UNRECOVERABLE,
  RELATION_DISCRIMINATOR_REGISTRY_ID,
  createLegacyRelationDiscriminator,
  type SemanticDiscriminator,
} from './relation-discriminator.js'
import type {
  ConfidenceObservation,
  EvidenceOccurrence,
  EvidenceProvenance,
  SemanticFact,
  SourceRange,
} from './semantic-graph.js'

export const GRAPH_ARTIFACT_V2_HEADER = 'MADAR_GRAPH_ARTIFACT/2\n' as const
export const GRAPH_ARTIFACT_V2_TOMBSTONE = [
  'MADAR_GRAPH_MOVED/2',
  'Use out/graph.madar with Madar >= the v2-supporting version.',
  '',
].join('\n')
export const GRAPH_ARTIFACT_VERSION = 2 as const
export const GRAPH_ARTIFACT_RECEIPT_STORAGE_SCHEMA_VERSION = 1 as const
export const UNREGISTERED_RELATION_AT_STORAGE_BOUNDARY = 'unregistered_relation_at_storage_boundary' as const

const EMPTY_ADMISSION_SUMMARY: StorageBoundaryAdmissionSummary = Object.freeze({
  unresolvedUnregisteredRelationCandidates: 0,
  unregisteredRelationCounts: Object.freeze({}),
})

export class GraphArtifactInvariantError extends Error {
  constructor(message: string) {
    super(`Graph artifact invariant failed: ${message}`)
    this.name = 'GraphArtifactInvariantError'
  }
}

export class GraphArtifactMovedError extends GraphArtifactInvariantError {
  constructor() {
    super('graph.json has moved; use out/graph.madar with a v2-supporting Madar version')
    this.name = 'GraphArtifactMovedError'
  }
}

export interface EndpointIdentityFactPairCounts {
  readonly stable: Readonly<Record<EndpointIdentityStatus, number>>
  readonly context_bound: Readonly<Record<EndpointIdentityStatus, number>>
  readonly unknown: Readonly<Record<EndpointIdentityStatus, number>>
  readonly legacy: Readonly<Record<EndpointIdentityStatus, number>>
}

export interface GraphArtifactStorageReceipt {
  readonly accounting_scope: 'storage_only'
  readonly status: 'degraded'
  readonly reasons: readonly string[]
  readonly endpoint_identity: {
    readonly statuses: typeof ENDPOINT_IDENTITY_STATUSES
    readonly fact_pair_counts: EndpointIdentityFactPairCounts
    /**
     * Overlapping diagnostics, not a partition: one fact carrying several
     * endpoint reasons contributes once to every applicable reason counter.
     */
    readonly reason_fact_counts: Readonly<Partial<Record<EndpointIdentityReason, number>>>
  }
  /**
   * Storage-boundary admissions refused because the relation is unregistered.
   * Present on every receipt so a zero is an asserted zero rather than an
   * absent field. Not full terminal accounting -- that is #658.
   */
  readonly storage_admission: {
    readonly unresolved_unregistered_relation_candidates: number
    readonly unregistered_relation_counts: Readonly<Record<string, number>>
  }
  readonly reserved: Readonly<Record<string, never>>
}

/**
 * Portable graph-level provenance. Deliberately excludes `root_path`: an
 * absolute checkout path is machine-local, so it travels in the untracked
 * `graph.local.json` sidecar instead of the publishable artifact.
 */
export interface GraphArtifactProvenance {
  readonly schema_version: number
  readonly extractor_version?: number
  readonly spi_mode?: boolean
  readonly generation_policy?: Readonly<Record<string, unknown>>
  readonly graph_build_freshness?: unknown
  readonly discovery_safety?: unknown
}

export interface SerializeGraphArtifactV2Input {
  readonly graph: KnowledgeGraph
  readonly repositoryRevision: string
  readonly generationMode: string
  readonly generatedAt: string
  readonly hyperedges?: readonly unknown[]
  readonly communityLabels?: Readonly<Record<string | number, string>>
  readonly integrityReceipt?: GraphArtifactStorageReceipt
  readonly provenance?: GraphArtifactProvenance
}

export interface ParsedGraphArtifactV2 {
  readonly versions: Readonly<Record<string, unknown>>
  readonly repository_revision: string
  readonly generation_mode: string
  readonly generated_at: string
  readonly directed: boolean
  readonly nodes: readonly unknown[]
  readonly facts: readonly unknown[]
  readonly occurrences: readonly unknown[]
  readonly hyperedges: readonly unknown[]
  readonly community_labels: Readonly<Record<string, unknown>>
  readonly integrity_receipt: unknown
  readonly provenance: Readonly<Record<string, unknown>>
  readonly reserved: Readonly<Record<string, never>>
}

export interface LoadGraphArtifactOptions {
  readonly mode?: 'normal' | 'strict' | 'qualification'
}

export interface LoadedGraphArtifact {
  readonly format: 'v2' | 'v1'
  readonly graph: KnowledgeGraph
  readonly repositoryRevision: string
  readonly generationMode: string
  readonly generatedAt: string
  readonly receipt: GraphArtifactStorageReceipt
  readonly diagnostics: readonly string[]
  readonly recommendation?: string
}

export interface GraphArtifactCacheIdentity {
  readonly graph_artifact_version: 1 | typeof GRAPH_ARTIFACT_VERSION
  readonly semantic_fact_identity_version: typeof SEMANTIC_FACT_IDENTITY_SCHEMA_VERSION
  readonly evidence_occurrence_identity_version: typeof EVIDENCE_OCCURRENCE_IDENTITY_SCHEMA_VERSION
  readonly relation_discriminator_registry_version: typeof RELATION_DISCRIMINATOR_REGISTRY_ID
  readonly endpoint_identity_policy_version: typeof ENDPOINT_IDENTITY_POLICY_VERSION
  readonly repository_revision: string
  readonly qualification: 'native_v2' | 'legacy_v1_degraded'
}

export interface GraphArtifactCacheCompatibility {
  readonly status: 'reusable' | 'incompatible'
  readonly reasons: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new GraphArtifactInvariantError(`${field} must be an object`)
  return value
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GraphArtifactInvariantError(`${field} must be a non-empty string`)
  }
  return value
}

function arrayField(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new GraphArtifactInvariantError(`${field} must be an array`)
  return value
}

function assertEmptyReserved(value: unknown, field: string): Record<string, never> {
  const reserved = record(value, field)
  if (Object.keys(reserved).length !== 0) {
    throw new GraphArtifactInvariantError(`${field} is reserved and must be empty in artifact v2`)
  }
  return reserved as Record<string, never>
}

function emptyStatusCounts(): Record<EndpointIdentityStatus, number> {
  return {
    stable: 0,
    context_bound: 0,
    unknown: 0,
    legacy: 0,
  }
}

function buildStorageReceipt(
  facts: readonly SemanticFact[],
  admission: StorageBoundaryAdmissionSummary = EMPTY_ADMISSION_SUMMARY,
): GraphArtifactStorageReceipt {
  const pairCounts: Record<EndpointIdentityStatus, Record<EndpointIdentityStatus, number>> = {
    stable: emptyStatusCounts(),
    context_bound: emptyStatusCounts(),
    unknown: emptyStatusCounts(),
    legacy: emptyStatusCounts(),
  }
  const reasonFactCounts = new Map<EndpointIdentityReason, number>()
  const receiptReasons = new Set<string>(['full_emission_accounting_not_available'])

  for (const fact of facts) {
    // Undirected receipt orientation is the fact-identity orientation, never
    // insertion order. This prevents one symmetric fact from reaching two
    // different matrix cells across equivalent builds.
    const [canonicalSource, canonicalTarget] = canonicalEndpointPair(fact.source, fact.target)
    const endpointIdentity = fact.direction === 'undirected'
      && (fact.source !== canonicalSource || fact.target !== canonicalTarget)
      ? { source: fact.endpointIdentity.target, target: fact.endpointIdentity.source }
      : fact.endpointIdentity
    const sourceStatus = endpointIdentity.source.status
    const targetStatus = endpointIdentity.target.status
    pairCounts[sourceStatus][targetStatus] += 1

    const factReasons = new Set([
      ...endpointIdentity.source.reasons,
      ...endpointIdentity.target.reasons,
    ])
    for (const reason of factReasons) {
      reasonFactCounts.set(reason, (reasonFactCounts.get(reason) ?? 0) + 1)
      receiptReasons.add(reason)
    }
    if (fact.discriminator.legacy === true) {
      for (const reason of fact.discriminator.reasons) receiptReasons.add(reason)
    }
  }

  if (facts.some((fact) => fact.discriminator.legacy === true)) {
    receiptReasons.add('regeneration_recommended')
  }
  if (admission.unresolvedUnregisteredRelationCandidates > 0) {
    receiptReasons.add(UNREGISTERED_RELATION_AT_STORAGE_BOUNDARY)
  }

  return Object.freeze({
    accounting_scope: 'storage_only' as const,
    status: 'degraded' as const,
    reasons: Object.freeze([...receiptReasons].sort()),
    endpoint_identity: Object.freeze({
      statuses: ENDPOINT_IDENTITY_STATUSES,
      fact_pair_counts: Object.freeze({
        stable: Object.freeze(pairCounts.stable),
        context_bound: Object.freeze(pairCounts.context_bound),
        unknown: Object.freeze(pairCounts.unknown),
        legacy: Object.freeze(pairCounts.legacy),
      }),
      reason_fact_counts: Object.freeze(Object.fromEntries([...reasonFactCounts.entries()].sort())),
    }),
    storage_admission: Object.freeze({
      unresolved_unregistered_relation_candidates: admission.unresolvedUnregisteredRelationCandidates,
      unregistered_relation_counts: Object.freeze(
        Object.fromEntries(
          Object.entries(admission.unregisteredRelationCounts)
            .sort(([left], [right]) => left.localeCompare(right)),
        ),
      ),
    }),
    reserved: Object.freeze({}),
  })
}

/** Re-reads the summary back off a parsed receipt so a load can re-derive it. */
function receiptAdmissionSummary(receipt: GraphArtifactStorageReceipt): StorageBoundaryAdmissionSummary {
  return Object.freeze({
    unresolvedUnregisteredRelationCandidates: receipt.storage_admission.unresolved_unregistered_relation_candidates,
    unregisteredRelationCounts: receipt.storage_admission.unregistered_relation_counts,
  })
}

function assertReceiptMatchesFacts(
  receipt: GraphArtifactStorageReceipt,
  facts: readonly SemanticFact[],
  admission: StorageBoundaryAdmissionSummary = EMPTY_ADMISSION_SUMMARY,
): void {
  if (receipt.accounting_scope !== 'storage_only' || receipt.status !== 'degraded') {
    throw new GraphArtifactInvariantError('storage receipt must remain degraded with storage_only scope')
  }
  if (!receipt.reasons.includes('full_emission_accounting_not_available')) {
    throw new GraphArtifactInvariantError('storage receipt must disclose unavailable full emission accounting')
  }
  if (
    receipt.endpoint_identity.statuses.length !== ENDPOINT_IDENTITY_STATUSES.length
    || receipt.endpoint_identity.statuses.some((status, index) => status !== ENDPOINT_IDENTITY_STATUSES[index])
  ) {
    throw new GraphArtifactInvariantError('endpoint status order does not match the declared four-state policy')
  }

  const expected = buildStorageReceipt(facts, admission)
  const expectedReasons = expected.reasons
  if (
    receipt.reasons.length !== expectedReasons.length
    || receipt.reasons.some((reason, index) => reason !== expectedReasons[index])
  ) {
    throw new GraphArtifactInvariantError('storage receipt reasons disagree with retained facts')
  }
  if (Object.keys(receipt.reserved).length !== 0) {
    throw new GraphArtifactInvariantError('storage receipt reserved fields must remain empty')
  }
  const admissionEntries = Object.entries(receipt.storage_admission.unregistered_relation_counts)
  const admissionSum = admissionEntries.reduce((total, [, count]) => total + count, 0)
  if (receipt.storage_admission.unresolved_unregistered_relation_candidates !== admissionSum) {
    throw new GraphArtifactInvariantError('storage admission total disagrees with its per-relation counts')
  }
  if (admissionEntries.some(([, count]) => !Number.isSafeInteger(count) || count < 1)) {
    throw new GraphArtifactInvariantError('storage admission counts must be positive safe integers')
  }
  let matrixSum = 0
  for (const sourceStatus of ENDPOINT_IDENTITY_STATUSES) {
    const row = receipt.endpoint_identity.fact_pair_counts[sourceStatus]
    if (row === null || typeof row !== 'object') {
      throw new GraphArtifactInvariantError(`endpoint receipt matrix is missing ${sourceStatus} row`)
    }
    for (const targetStatus of ENDPOINT_IDENTITY_STATUSES) {
      const count = row[targetStatus]
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new GraphArtifactInvariantError('endpoint receipt matrix counts must be non-negative safe integers')
      }
      matrixSum += count
      if (count !== expected.endpoint_identity.fact_pair_counts[sourceStatus][targetStatus]) {
        throw new GraphArtifactInvariantError(
          `endpoint receipt partition disagrees at ${sourceStatus}/${targetStatus}`,
        )
      }
    }
    if (Object.keys(row).some((status) => !ENDPOINT_IDENTITY_STATUSES.includes(status as EndpointIdentityStatus))) {
      throw new GraphArtifactInvariantError('endpoint receipt matrix contains an unsupported target status')
    }
  }
  if (matrixSum !== facts.length) {
    throw new GraphArtifactInvariantError(
      `endpoint receipt partition sums to ${matrixSum}, expected ${facts.length}`,
    )
  }
  if (Object.keys(receipt.endpoint_identity.fact_pair_counts).some((status) => (
    !ENDPOINT_IDENTITY_STATUSES.includes(status as EndpointIdentityStatus)
  ))) {
    throw new GraphArtifactInvariantError('endpoint receipt matrix contains an unsupported source status')
  }
  if (serializeCanonicalJson(receipt.endpoint_identity.reason_fact_counts) !== serializeCanonicalJson(
    expected.endpoint_identity.reason_fact_counts,
  )) {
    throw new GraphArtifactInvariantError('endpoint reason_fact_counts disagree with retained facts')
  }
}

function nodePayload(graph: KnowledgeGraph): readonly unknown[] {
  return graph.nodeEntries()
    .map(([id, attributes]) => ({
      id,
      endpoint_identity: graph.nodeEndpointIdentity(id),
      attributes,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

function factPayload(fact: SemanticFact, attributes: GraphAttributes): unknown {
  return {
    id: fact.id,
    direction: fact.direction,
    source: fact.source,
    target: fact.target,
    relation: fact.relation,
    discriminator: fact.discriminator,
    endpoint_identity: fact.endpointIdentity,
    occurrence_ids: [...fact.occurrenceIds].sort(),
    annotations: fact.annotations,
    attributes,
  }
}

function occurrencePayload(occurrence: EvidenceOccurrence): unknown {
  return {
    id: occurrence.id,
    fact_id: occurrence.factId,
    owner: {
      adapter_id: occurrence.owner.adapterId,
      strategy: occurrence.owner.strategy,
      ...(occurrence.owner.sourceFile !== undefined ? { source_file: occurrence.owner.sourceFile } : {}),
      ...(occurrence.owner.adapterVersion !== undefined ? { adapter_version: occurrence.owner.adapterVersion } : {}),
    },
    ...(occurrence.sourceFile !== undefined ? { source_file: occurrence.sourceFile } : {}),
    ...(occurrence.sourceRange !== undefined ? { source_range: occurrence.sourceRange } : {}),
    ...(occurrence.targetFile !== undefined ? { target_file: occurrence.targetFile } : {}),
    ...(occurrence.targetRange !== undefined ? { target_range: occurrence.targetRange } : {}),
    ...(occurrence.siteKind !== undefined ? { site_kind: occurrence.siteKind } : {}),
    ...(occurrence.adapterEvidenceKey !== undefined
      ? { adapter_evidence_key: occurrence.adapterEvidenceKey }
      : {}),
    provenance: occurrence.provenance,
    confidence_observations: occurrence.confidenceObservations,
    metadata: occurrence.metadata,
  }
}

function canonicalCommunityLabels(labels: Readonly<Record<string | number, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)))
}

/**
 * Provenance is portable by construction. `root_path` is rejected rather than
 * dropped: silently discarding a field the caller asked to publish would make
 * the sidecar boundary depend on nobody ever making that mistake.
 */
function canonicalProvenance(provenance: GraphArtifactProvenance | undefined): Record<string, unknown> {
  if (provenance === undefined) return {}
  if ('root_path' in provenance) {
    throw new GraphArtifactInvariantError('provenance must not carry root_path; it belongs in the local sidecar')
  }
  const entries = Object.entries(provenance).filter(([, value]) => value !== undefined)
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)))
}

function canonicalHyperedge(value: unknown): Record<string, unknown> {
  const hyperedge = record(value, 'hyperedge')
  const nodes = arrayField(hyperedge.nodes, 'hyperedge.nodes')
  if (nodes.some((node) => typeof node !== 'string')) {
    throw new GraphArtifactInvariantError('hyperedge.nodes must contain only node IDs')
  }
  return {
    ...hyperedge,
    nodes: [...new Set(nodes as readonly string[])].sort(),
  }
}

/**
 * The only artifact-v2 serialization boundary. All collection ordering is
 * established here, and object-key ordering is delegated to canonical JSON.
 */
export function serializeGraphArtifactV2(input: SerializeGraphArtifactV2Input): Buffer {
  const facts = input.graph.factRecords()
    .map(({ fact, attributes }) => ({ fact, attributes }))
    .sort((left, right) => left.fact.id.localeCompare(right.fact.id))
  const occurrences = [...input.graph.occurrenceEntries()].sort((left, right) => left.id.localeCompare(right.id))
  const hyperedges = [...(input.hyperedges
    ?? (Array.isArray(input.graph.graph.hyperedges) ? input.graph.graph.hyperedges : []))]
    .map(canonicalHyperedge)
    .sort((left, right) => serializeCanonicalJson(left, { arraySemantics: 'ordered' })
      .localeCompare(serializeCanonicalJson(right, { arraySemantics: 'ordered' })))
  const communityLabels = input.communityLabels
    ?? (input.graph.graph.community_labels !== null
      && typeof input.graph.graph.community_labels === 'object'
      && !Array.isArray(input.graph.graph.community_labels)
      ? input.graph.graph.community_labels as Record<string, string>
      : {})
  const admission = input.graph.storageAdmissionSummary()
  const integrityReceipt = input.integrityReceipt
    ?? buildStorageReceipt(facts.map(({ fact }) => fact), admission)
  assertReceiptMatchesFacts(integrityReceipt, facts.map(({ fact }) => fact), admission)

  const payload = {
    versions: {
      graph_artifact: GRAPH_ARTIFACT_VERSION,
      semantic_fact_identity: SEMANTIC_FACT_IDENTITY_SCHEMA_VERSION,
      evidence_occurrence_identity: EVIDENCE_OCCURRENCE_IDENTITY_SCHEMA_VERSION,
      relation_discriminator_registry: RELATION_DISCRIMINATOR_REGISTRY_ID,
      endpoint_identity_qualification_policy: ENDPOINT_IDENTITY_POLICY_VERSION,
      receipt_storage_schema: GRAPH_ARTIFACT_RECEIPT_STORAGE_SCHEMA_VERSION,
    },
    repository_revision: input.repositoryRevision,
    generation_mode: input.generationMode,
    generated_at: input.generatedAt,
    directed: input.graph.isDirected(),
    nodes: nodePayload(input.graph),
    facts: facts.map(({ fact, attributes }) => factPayload(fact, attributes)),
    occurrences: occurrences.map(occurrencePayload),
    hyperedges,
    community_labels: canonicalCommunityLabels(communityLabels),
    integrity_receipt: integrityReceipt,
    provenance: canonicalProvenance(input.provenance),
    reserved: {},
  }

  return Buffer.from(
    `${GRAPH_ARTIFACT_V2_HEADER}${serializeCanonicalJson(payload, {
      arraySemantics: 'ordered',
      fixedObjectKeyOrders: [ENDPOINT_IDENTITY_STATUSES],
    })}\n`,
    'utf8',
  )
}

export function graphArtifactDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function decodeArtifactBytes(bytes: Uint8Array | string): string {
  if (typeof bytes === 'string') return bytes
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new GraphArtifactInvariantError('artifact is not valid UTF-8')
  }
}

function assertSupportedVersions(value: unknown): Readonly<Record<string, unknown>> {
  const versions = record(value, 'versions')
  const supported: Readonly<Record<string, unknown>> = {
    graph_artifact: GRAPH_ARTIFACT_VERSION,
    semantic_fact_identity: SEMANTIC_FACT_IDENTITY_SCHEMA_VERSION,
    evidence_occurrence_identity: EVIDENCE_OCCURRENCE_IDENTITY_SCHEMA_VERSION,
    relation_discriminator_registry: RELATION_DISCRIMINATOR_REGISTRY_ID,
    endpoint_identity_qualification_policy: ENDPOINT_IDENTITY_POLICY_VERSION,
    receipt_storage_schema: GRAPH_ARTIFACT_RECEIPT_STORAGE_SCHEMA_VERSION,
  }
  for (const [key, expected] of Object.entries(supported)) {
    if (versions[key] !== expected) {
      throw new GraphArtifactInvariantError(`unsupported version for ${key}: ${JSON.stringify(versions[key])}`)
    }
  }
  const unknownKeys = Object.keys(versions).filter((key) => !Object.prototype.hasOwnProperty.call(supported, key))
  if (unknownKeys.length > 0) {
    throw new GraphArtifactInvariantError(`unsupported version field ${JSON.stringify(unknownKeys[0])}`)
  }
  return versions
}

/** Parses only the header-framed v2 wire format; pure JSON is never accepted here. */
export function parseGraphArtifactV2(bytes: Uint8Array | string): ParsedGraphArtifactV2 {
  const text = decodeArtifactBytes(bytes)
  if (!text.startsWith(GRAPH_ARTIFACT_V2_HEADER)) {
    throw new GraphArtifactInvariantError(`artifact header must be exactly ${JSON.stringify(GRAPH_ARTIFACT_V2_HEADER)}`)
  }
  const body = text.slice(GRAPH_ARTIFACT_V2_HEADER.length)
  if (body.trim().length === 0) throw new GraphArtifactInvariantError('artifact body is empty')

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : ''
    throw new GraphArtifactInvariantError(`artifact body is invalid JSON or has trailing non-whitespace${detail}`)
  }
  const payload = record(parsed, 'artifact payload')
  const versions = assertSupportedVersions(payload.versions)
  const directed = payload.directed
  if (typeof directed !== 'boolean') throw new GraphArtifactInvariantError('directed must be boolean')
  const communityLabels = record(payload.community_labels, 'community_labels')
  for (const [communityId, label] of Object.entries(communityLabels)) {
    if (!/^\d+$/.test(communityId) || typeof label !== 'string') {
      throw new GraphArtifactInvariantError('community_labels must map non-negative integer keys to strings')
    }
  }

  return Object.freeze({
    versions,
    repository_revision: stringField(payload.repository_revision, 'repository_revision'),
    generation_mode: stringField(payload.generation_mode, 'generation_mode'),
    generated_at: stringField(payload.generated_at, 'generated_at'),
    directed,
    nodes: arrayField(payload.nodes, 'nodes'),
    facts: arrayField(payload.facts, 'facts'),
    occurrences: arrayField(payload.occurrences, 'occurrences'),
    hyperedges: arrayField(payload.hyperedges, 'hyperedges'),
    community_labels: communityLabels,
    integrity_receipt: payload.integrity_receipt,
    provenance: payload.provenance === undefined ? {} : record(payload.provenance, 'provenance'),
    reserved: assertEmptyReserved(payload.reserved, 'reserved'),
  })
}

function canonicalRecord(value: unknown): string {
  return serializeCanonicalJson(value, { arraySemantics: 'ordered' })
}

function recordsByUniqueId(values: readonly unknown[], kind: string): readonly Record<string, unknown>[] {
  const byId = new Map<string, { readonly payload: string; readonly value: Record<string, unknown> }>()
  for (const rawValue of values) {
    const value = record(rawValue, kind)
    const id = stringField(value.id, `${kind}.id`)
    const payload = canonicalRecord(value)
    const existing = byId.get(id)
    if (existing !== undefined && existing.payload !== payload) {
      throw new GraphArtifactInvariantError(`duplicate ${kind} ID ${id} has a different payload`)
    }
    if (existing === undefined) byId.set(id, { payload, value })
  }
  return [...byId.values()].map(({ value }) => value)
}

function stringArray(value: unknown, field: string): readonly string[] {
  const values = arrayField(value, field)
  if (values.some((item) => typeof item !== 'string')) {
    throw new GraphArtifactInvariantError(`${field} must contain only strings`)
  }
  return values as readonly string[]
}

function assertSortedUnique(values: readonly string[], field: string): void {
  const sortedUnique = [...new Set(values)].sort()
  if (values.length !== sortedUnique.length || values.some((value, index) => value !== sortedUnique[index])) {
    throw new GraphArtifactInvariantError(`${field} must be sorted and unique`)
  }
}

function endpointQualificationEqual(
  left: EndpointIdentityEndpointQualification,
  right: EndpointIdentityEndpointQualification,
): boolean {
  return left.status === right.status
    && left.reasons.length === right.reasons.length
    && left.reasons.every((reason, index) => reason === right.reasons[index])
}

function qualificationEqual(left: EndpointIdentityQualification, right: EndpointIdentityQualification): boolean {
  return endpointQualificationEqual(left.source, right.source)
    && endpointQualificationEqual(left.target, right.target)
}

function parseReceipt(value: unknown): GraphArtifactStorageReceipt {
  const receipt = record(value, 'integrity_receipt')
  const reasons = stringArray(receipt.reasons, 'integrity_receipt.reasons')
  assertSortedUnique(reasons, 'integrity_receipt.reasons')
  const endpointIdentity = record(receipt.endpoint_identity, 'integrity_receipt.endpoint_identity')
  const statuses = stringArray(endpointIdentity.statuses, 'integrity_receipt.endpoint_identity.statuses')
  const rawMatrix = record(endpointIdentity.fact_pair_counts, 'integrity_receipt.endpoint_identity.fact_pair_counts')
  const matrix = {} as Record<EndpointIdentityStatus, Record<EndpointIdentityStatus, number>>
  for (const sourceStatus of ENDPOINT_IDENTITY_STATUSES) {
    const rawRow = record(rawMatrix[sourceStatus], `integrity receipt matrix row ${sourceStatus}`)
    const row = {} as Record<EndpointIdentityStatus, number>
    for (const targetStatus of ENDPOINT_IDENTITY_STATUSES) {
      const count = rawRow[targetStatus]
      if (!Number.isSafeInteger(count) || (count as number) < 0) {
        throw new GraphArtifactInvariantError('endpoint receipt matrix counts must be non-negative safe integers')
      }
      row[targetStatus] = count as number
    }
    matrix[sourceStatus] = row
  }
  const rawReasonCounts = record(
    endpointIdentity.reason_fact_counts,
    'integrity_receipt.endpoint_identity.reason_fact_counts',
  )
  const reasonFactCounts: Partial<Record<EndpointIdentityReason, number>> = {}
  for (const [reason, count] of Object.entries(rawReasonCounts)) {
    if (!ENDPOINT_IDENTITY_REASONS.includes(reason as EndpointIdentityReason)) {
      throw new GraphArtifactInvariantError(`integrity receipt has invalid reason ${JSON.stringify(reason)}`)
    }
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new GraphArtifactInvariantError('endpoint reason fact counts must be non-negative safe integers')
    }
    reasonFactCounts[reason as EndpointIdentityReason] = count as number
  }
  assertEmptyReserved(receipt.reserved, 'integrity_receipt.reserved')

  // Absent on nothing we write; a missing field means a foreign or truncated
  // artifact, so it is rejected rather than defaulted to a comfortable zero.
  const rawAdmission = record(receipt.storage_admission, 'integrity_receipt.storage_admission')
  const rawAdmissionCounts = record(
    rawAdmission.unregistered_relation_counts,
    'integrity_receipt.storage_admission.unregistered_relation_counts',
  )
  const admissionKeys = Object.keys(rawAdmissionCounts)
  assertSortedUnique(admissionKeys, 'integrity_receipt.storage_admission.unregistered_relation_counts')
  const admissionCounts: Record<string, number> = {}
  let admissionSum = 0
  for (const [relation, count] of Object.entries(rawAdmissionCounts)) {
    if (!Number.isSafeInteger(count) || (count as number) < 1) {
      throw new GraphArtifactInvariantError('unregistered relation counts must be positive safe integers')
    }
    admissionCounts[relation] = count as number
    admissionSum += count as number
  }
  const admissionTotal = rawAdmission.unresolved_unregistered_relation_candidates
  if (!Number.isSafeInteger(admissionTotal) || (admissionTotal as number) < 0) {
    throw new GraphArtifactInvariantError('unresolved unregistered relation candidates must be a non-negative safe integer')
  }
  if (admissionTotal !== admissionSum) {
    throw new GraphArtifactInvariantError('unresolved unregistered relation total disagrees with its per-relation counts')
  }
  if (admissionSum > 0 && !reasons.includes(UNREGISTERED_RELATION_AT_STORAGE_BOUNDARY)) {
    throw new GraphArtifactInvariantError('receipt records unregistered admissions without disclosing the reason')
  }

  return {
    accounting_scope: receipt.accounting_scope as GraphArtifactStorageReceipt['accounting_scope'],
    status: receipt.status as GraphArtifactStorageReceipt['status'],
    reasons,
    endpoint_identity: {
      statuses: statuses as unknown as typeof ENDPOINT_IDENTITY_STATUSES,
      fact_pair_counts: matrix,
      reason_fact_counts: reasonFactCounts,
    },
    storage_admission: {
      unresolved_unregistered_relation_candidates: admissionTotal as number,
      unregistered_relation_counts: admissionCounts,
    },
    reserved: {},
  }
}

function parseSourceRange(value: unknown, field: string): SourceRange {
  const range = record(value, field)
  const start = record(range.start, `${field}.start`)
  const end = record(range.end, `${field}.end`)
  for (const [position, entry] of [['start', start], ['end', end]] as const) {
    if (
      typeof entry.line !== 'number'
      || !Number.isFinite(entry.line)
      || typeof entry.column !== 'number'
      || !Number.isFinite(entry.column)
    ) {
      throw new GraphArtifactInvariantError(`${field}.${position} must contain finite line and column numbers`)
    }
  }
  return {
    start: { line: start.line as number, column: start.column as number },
    end: { line: end.line as number, column: end.column as number },
  }
}

function parseOccurrence(value: Record<string, unknown>): EvidenceOccurrence {
  const owner = record(value.owner, 'occurrence.owner')
  const provenance = arrayField(value.provenance, 'occurrence.provenance')
  const confidenceObservations = arrayField(
    value.confidence_observations,
    'occurrence.confidence_observations',
  )
  if (provenance.some((entry) => !isRecord(entry))) {
    throw new GraphArtifactInvariantError('occurrence.provenance must contain objects')
  }
  if (confidenceObservations.some((entry) => !isRecord(entry))) {
    throw new GraphArtifactInvariantError('occurrence.confidence_observations must contain objects')
  }
  const occurrence = createEvidenceOccurrence({
    factId: stringField(value.fact_id, 'occurrence.fact_id') as EvidenceOccurrence['factId'],
    owner: {
      adapterId: stringField(owner.adapter_id, 'occurrence.owner.adapter_id'),
      strategy: stringField(owner.strategy, 'occurrence.owner.strategy'),
      ...(owner.source_file !== undefined
        ? { sourceFile: stringField(owner.source_file, 'occurrence.owner.source_file') }
        : {}),
      ...(owner.adapter_version !== undefined
        ? { adapterVersion: stringField(owner.adapter_version, 'occurrence.owner.adapter_version') }
        : {}),
    },
    ...(value.source_file !== undefined
      ? { sourceFile: stringField(value.source_file, 'occurrence.source_file') }
      : {}),
    ...(value.source_range !== undefined
      ? { sourceRange: parseSourceRange(value.source_range, 'occurrence.source_range') }
      : {}),
    ...(value.target_file !== undefined
      ? { targetFile: stringField(value.target_file, 'occurrence.target_file') }
      : {}),
    ...(value.target_range !== undefined
      ? { targetRange: parseSourceRange(value.target_range, 'occurrence.target_range') }
      : {}),
    ...(value.site_kind !== undefined
      ? { siteKind: stringField(value.site_kind, 'occurrence.site_kind') }
      : {}),
    ...(value.adapter_evidence_key !== undefined
      ? { adapterEvidenceKey: stringField(value.adapter_evidence_key, 'occurrence.adapter_evidence_key') }
      : {}),
    provenance: provenance as readonly EvidenceProvenance[],
    confidenceObservations: confidenceObservations as readonly ConfidenceObservation[],
    metadata: record(value.metadata, 'occurrence.metadata') as EvidenceOccurrence['metadata'],
  })
  if (occurrence.id !== value.id) {
    throw new GraphArtifactInvariantError(
      `occurrence identity ${String(value.id)} does not match its canonical payload ${occurrence.id}`,
    )
  }
  return occurrence
}

function validateHyperedges(values: readonly unknown[]): readonly unknown[] {
  const byId = new Map<string, string>()
  for (const value of values) {
    const hyperedge = record(value, 'hyperedge')
    if (hyperedge.id === undefined) continue
    const id = stringField(hyperedge.id, 'hyperedge.id')
    const serialized = canonicalRecord(hyperedge)
    const existing = byId.get(id)
    if (existing !== undefined && existing !== serialized) {
      throw new GraphArtifactInvariantError(`duplicate hyperedge ID ${id} has a different payload`)
    }
    byId.set(id, serialized)
  }
  return values
}

function loadGraphArtifactV2(payload: ParsedGraphArtifactV2): LoadedGraphArtifact {
  const graph = new KnowledgeGraph({ directed: payload.directed })
  for (const node of recordsByUniqueId(payload.nodes, 'node')) {
    const id = stringField(node.id, 'node.id')
    const endpointIdentity = validateEndpointIdentityEndpointQualification(node.endpoint_identity)
    graph.addNode(id, {
      ...record(node.attributes, 'node.attributes'),
      endpointIdentity,
    })
  }

  const expectedOccurrencesByFact = new Map<string, ReadonlySet<string>>()
  for (const factValue of recordsByUniqueId(payload.facts, 'fact')) {
    const id = stringField(factValue.id, 'fact.id')
    const direction = factValue.direction
    if (direction !== 'directed' && direction !== 'undirected') {
      throw new GraphArtifactInvariantError('fact.direction must be directed or undirected')
    }
    if ((direction === 'directed') !== payload.directed) {
      throw new GraphArtifactInvariantError('fact direction disagrees with artifact directed flag')
    }
    const source = stringField(factValue.source, 'fact.source')
    const target = stringField(factValue.target, 'fact.target')
    if (!graph.hasNode(source) || !graph.hasNode(target)) {
      throw new GraphArtifactInvariantError(`fact ${id} references a missing endpoint`)
    }
    const endpointIdentity = validateEndpointIdentityQualification(factValue.endpoint_identity)
    const occurrenceIds = stringArray(factValue.occurrence_ids, 'fact.occurrence_ids')
    assertSortedUnique(occurrenceIds, 'fact.occurrence_ids')
    const rebuilt = createSemanticFact({
      direction,
      source,
      target,
      relation: stringField(factValue.relation, 'fact.relation'),
      discriminator: record(factValue.discriminator, 'fact.discriminator') as unknown as SemanticDiscriminator,
      endpointIdentity,
      occurrenceIds: occurrenceIds as SemanticFact['occurrenceIds'],
      annotations: record(factValue.annotations, 'fact.annotations') as SemanticFact['annotations'],
    })
    if (rebuilt.id !== id) {
      throw new GraphArtifactInvariantError(`fact identity ${id} does not match its canonical payload ${rebuilt.id}`)
    }
    if (rebuilt.source !== source || rebuilt.target !== target) {
      throw new GraphArtifactInvariantError(`undirected fact ${id} does not use canonical endpoint orientation`)
    }
    const nodeQualification: EndpointIdentityQualification = {
      source: graph.nodeEndpointIdentity(source),
      target: graph.nodeEndpointIdentity(target),
    }
    if (!qualificationEqual(endpointIdentity, nodeQualification)) {
      throw new GraphArtifactInvariantError(`fact ${id} endpoint qualification disagrees with its nodes`)
    }
    const admission = graph.addEdge(source, target, record(factValue.attributes, 'fact.attributes'), {
      discriminator: rebuilt.discriminator,
      recordOccurrence: false,
      ...(rebuilt.discriminator.legacy === true
        ? { legacyCompatibility: 'v1-artifact-loader' as const }
        : {}),
    })
    if (admission.status !== 'stored' || admission.factId !== id) {
      throw new GraphArtifactInvariantError(`fact ${id} could not be rebuilt with the same identity`)
    }
    expectedOccurrencesByFact.set(id, new Set(occurrenceIds))
  }

  const seenOccurrenceIds = new Set<string>()
  for (const occurrenceValue of recordsByUniqueId(payload.occurrences, 'occurrence')) {
    const factId = stringField(occurrenceValue.fact_id, 'occurrence.fact_id')
    const expected = expectedOccurrencesByFact.get(factId)
    if (expected === undefined) {
      throw new GraphArtifactInvariantError(`occurrence references unknown fact ${factId}`)
    }
    const occurrence = parseOccurrence(occurrenceValue)
    if (!expected.has(occurrence.id)) {
      throw new GraphArtifactInvariantError(`occurrence ${occurrence.id} is not listed by fact ${factId}`)
    }
    graph.addOccurrence(occurrence)
    seenOccurrenceIds.add(occurrence.id)
  }
  for (const [factId, expectedIds] of expectedOccurrencesByFact) {
    for (const occurrenceId of expectedIds) {
      if (!seenOccurrenceIds.has(occurrenceId)) {
        throw new GraphArtifactInvariantError(`fact ${factId} occurrence ${occurrenceId} does not exist`)
      }
    }
  }

  const receipt = parseReceipt(payload.integrity_receipt)
  assertReceiptMatchesFacts(receipt, graph.factRecords().map(({ fact }) => fact), receiptAdmissionSummary(receipt))
  const hyperedges = validateHyperedges(payload.hyperedges)
  graph.graph.hyperedges = [...hyperedges]
  graph.graph.community_labels = { ...payload.community_labels }
  graph.graph.artifact_integrity_receipt = receipt
  graph.graph.artifact_version = GRAPH_ARTIFACT_VERSION

  return Object.freeze({
    format: 'v2' as const,
    graph,
    repositoryRevision: payload.repository_revision,
    generationMode: payload.generation_mode,
    generatedAt: payload.generated_at,
    receipt,
    diagnostics: Object.freeze([]),
  })
}

const MAX_LEGACY_ARTIFACT_BYTES = 100 * 1024 * 1024
const MAX_LEGACY_RECORDS = 1_000_000

function legacyJson(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, 'utf8') > MAX_LEGACY_ARTIFACT_BYTES) {
    throw new GraphArtifactInvariantError('legacy artifact exceeds the bounded normal-mode size limit')
  }
  if (!text.trimStart().startsWith('{')) {
    throw new GraphArtifactInvariantError('artifact header is missing or altered')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : ''
    throw new GraphArtifactInvariantError(`legacy artifact is invalid JSON${detail}`)
  }
  const legacy = record(parsed, 'legacy artifact')
  if (
    (isRecord(legacy.versions) && legacy.versions.graph_artifact !== undefined)
    || Array.isArray(legacy.facts)
    || Array.isArray(legacy.occurrences)
  ) {
    throw new GraphArtifactInvariantError('v2 artifact header is missing')
  }
  if (
    (legacy.schema_version !== 1 && legacy.schema_version !== 2)
    || typeof legacy.directed !== 'boolean'
    || !Array.isArray(legacy.nodes)
    || (!Array.isArray(legacy.links) && !Array.isArray(legacy.edges))
  ) {
    throw new GraphArtifactInvariantError('JSON payload is not a compatible legacy v1 graph artifact')
  }
  return legacy
}

function legacyLinkFingerprint(link: Record<string, unknown>): { readonly canonical: string; readonly digest: string } {
  const canonical = canonicalRecord(link)
  return {
    canonical,
    digest: createHash('sha256').update(canonical, 'utf8').digest('hex'),
  }
}

function loadLegacyGraphArtifact(
  legacy: Record<string, unknown>,
  options: LoadGraphArtifactOptions,
): LoadedGraphArtifact {
  const mode = options.mode ?? 'normal'
  if (mode !== 'normal') {
    throw new GraphArtifactInvariantError(`legacy v1 artifacts are rejected in ${mode} mode; regenerate as v2`)
  }
  const nodes = arrayField(legacy.nodes, 'legacy nodes')
  const links = Array.isArray(legacy.links)
    ? legacy.links
    : Array.isArray(legacy.edges)
      ? legacy.edges
      : []
  if (nodes.length > MAX_LEGACY_RECORDS || links.length > MAX_LEGACY_RECORDS) {
    throw new GraphArtifactInvariantError('legacy artifact exceeds the bounded normal-mode record limit')
  }

  const graph = new KnowledgeGraph({ directed: legacy.directed === true })
  const legacyQualification = classifyLegacyEndpoint()
  for (const node of recordsByUniqueId(nodes, 'legacy node')) {
    const id = stringField(node.id, 'legacy node.id')
    const { id: _id, endpointIdentity: _oldQualification, endpoint_identity: _oldWireQualification, ...attributes } = node
    graph.addNode(id, { ...attributes, endpointIdentity: legacyQualification })
  }

  const sortableLinks = links.map((value, index) => {
    const link = record(value, `legacy link ${index}`)
    return { link, index, ...legacyLinkFingerprint(link) }
  }).sort((left, right) => (
    left.canonical < right.canonical
      ? -1
      : left.canonical > right.canonical
        ? 1
        : left.index - right.index
  ))
  const duplicateOrdinals = new Map<string, number>()
  for (const { link, canonical, digest } of sortableLinks) {
    const duplicateOrdinal = duplicateOrdinals.get(canonical) ?? 0
    duplicateOrdinals.set(canonical, duplicateOrdinal + 1)
    const source = typeof link.source === 'string' && link.source.length > 0 ? link.source : null
    const target = typeof link.target === 'string' && link.target.length > 0 ? link.target : null
    const relation = typeof link.relation === 'string' ? link.relation : ''
    if (
      source === null
      || target === null
      || !graph.hasNode(source)
      || !graph.hasNode(target)
    ) {
      continue
    }
    const { source: _source, target: _target, ...attributes } = link
    const discriminator = createLegacyRelationDiscriminator(digest, duplicateOrdinal)
    const admission = graph.addEdge(source, target, attributes, {
      discriminator,
      legacyCompatibility: 'v1-artifact-loader',
      occurrence: {
        owner: { adapterId: 'madar-v1-loader', strategy: 'legacy-artifact' },
        adapterEvidenceKey: `legacy-link:${digest}:${duplicateOrdinal}`,
        provenance: [],
        confidenceObservations: [],
        metadata: {
          diagnostics: [LEGACY_PARALLEL_FACTS_UNRECOVERABLE],
          historical_multiplicity_recovered: false,
        },
      },
    })
    if (admission.status !== 'stored') {
      throw new GraphArtifactInvariantError(`legacy relation ${relation} unexpectedly failed admission`)
    }
  }

  if (Array.isArray(legacy.hyperedges)) graph.graph.hyperedges = [...validateHyperedges(legacy.hyperedges)]
  if (isRecord(legacy.community_labels)) {
    graph.graph.community_labels = Object.fromEntries(
      Object.entries(legacy.community_labels).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  }
  const receipt = buildStorageReceipt(graph.factRecords().map(({ fact }) => fact), graph.storageAdmissionSummary())
  assertReceiptMatchesFacts(receipt, graph.factRecords().map(({ fact }) => fact), graph.storageAdmissionSummary())
  graph.graph.artifact_integrity_receipt = receipt
  graph.graph.artifact_version = 1
  graph.graph.artifact_diagnostics = [LEGACY_PARALLEL_FACTS_UNRECOVERABLE]

  return Object.freeze({
    format: 'v1' as const,
    graph,
    repositoryRevision: 'legacy-unavailable',
    generationMode: 'legacy_v1_compatibility',
    generatedAt: 'legacy-unavailable',
    receipt,
    diagnostics: Object.freeze([LEGACY_PARALLEL_FACTS_UNRECOVERABLE]),
    recommendation: 'Regenerate the graph from source to produce a native artifact v2; historical multiplicity was not recovered.',
  })
}

/** Loads exact-header v2 artifacts and bounded pure-JSON v1 compatibility artifacts. */
export function loadGraphArtifact(
  bytes: Uint8Array | string,
  options: LoadGraphArtifactOptions = {},
): LoadedGraphArtifact {
  const text = decodeArtifactBytes(bytes)
  if (text === GRAPH_ARTIFACT_V2_TOMBSTONE || text.startsWith('MADAR_GRAPH_MOVED/')) {
    throw new GraphArtifactMovedError()
  }
  if (text.startsWith(GRAPH_ARTIFACT_V2_HEADER)) {
    return loadGraphArtifactV2(parseGraphArtifactV2(text))
  }
  return loadLegacyGraphArtifact(legacyJson(text), options)
}

/**
 * Loads a published artifact path. During an interrupted activation, a valid
 * sibling graph.madar is preferred over stale legacy graph.json. Once the
 * tombstone is visible, callers receive the actionable moved-artifact error.
 */
export function loadGraphArtifactFromPath(
  graphPath: string,
  options: LoadGraphArtifactOptions = {},
): LoadedGraphArtifact {
  const currentBytes = readFileSync(graphPath)
  const currentText = decodeArtifactBytes(currentBytes)
  if (
    basename(graphPath) === 'graph.json'
    && currentText !== GRAPH_ARTIFACT_V2_TOMBSTONE
    && !currentText.startsWith('MADAR_GRAPH_MOVED/')
  ) {
    const v2Path = join(dirname(graphPath), 'graph.madar')
    if (existsSync(v2Path)) return loadGraphArtifact(readFileSync(v2Path), options)
  }
  return loadGraphArtifact(currentBytes, options)
}

/** Untracked, machine-local companion to the portable artifact. */
export const GRAPH_LOCAL_SIDECAR_BASENAME = 'graph.local.json'

export type GraphArtifactMetadataFormat = 'v2' | 'v1' | 'absent' | 'unreadable'

/**
 * Graph-level metadata resolved without constructing a KnowledgeGraph.
 *
 * Eleven callers previously reached for these fields with a bare
 * `JSON.parse(readFileSync(graphPath))`, ten of them inside a catch that
 * returned a plausible-looking default. Against a v2 artifact every one of
 * those would have degraded silently, so `format` is non-optional here:
 * a caller must be able to tell "the graph says no" from "I could not read
 * the graph".
 */
export interface GraphArtifactMetadata {
  readonly format: GraphArtifactMetadataFormat
  readonly schemaVersion: number | null
  readonly extractorVersion: number | null
  readonly spiMode: boolean
  readonly directed: boolean | null
  readonly generationPolicy: Readonly<Record<string, unknown>> | null
  readonly graphBuildFreshness: unknown
  readonly discoverySafety: unknown
  readonly communityLabels: Readonly<Record<string, unknown>>
  /** Machine-local; sourced from the sidecar for v2 and inline for v1. */
  readonly rootPath: string | null
  /** Distinct `source_file` values across nodes, in artifact order. */
  readonly nodeSourceFiles: readonly string[]
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nonEmptyStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function optionalRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null
}

function distinctSourceFiles(nodes: unknown): readonly string[] {
  if (!Array.isArray(nodes)) return []
  const seen = new Set<string>()
  for (const node of nodes) {
    if (!isRecord(node)) continue
    const sourceFile = node.source_file
    if (typeof sourceFile === 'string' && sourceFile.length > 0) seen.add(sourceFile)
  }
  return Object.freeze([...seen])
}

function readLocalSidecarRootPath(artifactPath: string): string | null {
  try {
    const sidecar = join(dirname(artifactPath), GRAPH_LOCAL_SIDECAR_BASENAME)
    if (!existsSync(sidecar)) return null
    return nonEmptyStringOrNull((JSON.parse(readFileSync(sidecar, 'utf8')) as { root_path?: unknown }).root_path)
  } catch {
    return null
  }
}

const ABSENT_METADATA: GraphArtifactMetadata = Object.freeze({
  format: 'absent',
  schemaVersion: null,
  extractorVersion: null,
  spiMode: false,
  directed: null,
  generationPolicy: null,
  graphBuildFreshness: undefined,
  discoverySafety: undefined,
  communityLabels: Object.freeze({}),
  rootPath: null,
  nodeSourceFiles: Object.freeze([]),
})

/**
 * Reads graph-level metadata from a v2 artifact, a v1 graph.json, or a
 * tombstoned graph.json whose sibling graph.madar carries the real payload.
 * Never throws: the format field carries the failure instead.
 */
export function readGraphArtifactMetadata(graphPath: string): GraphArtifactMetadata {
  let text: string
  let resolvedPath = graphPath
  try {
    if (!existsSync(graphPath)) return ABSENT_METADATA
    text = decodeArtifactBytes(readFileSync(graphPath))
    if (text === GRAPH_ARTIFACT_V2_TOMBSTONE || text.startsWith('MADAR_GRAPH_MOVED/')) {
      const sibling = join(dirname(graphPath), 'graph.madar')
      if (!existsSync(sibling)) return { ...ABSENT_METADATA, format: 'unreadable' }
      resolvedPath = sibling
      text = decodeArtifactBytes(readFileSync(sibling))
    }
  } catch {
    return { ...ABSENT_METADATA, format: 'unreadable' }
  }

  try {
    if (text.startsWith(GRAPH_ARTIFACT_V2_HEADER)) {
      const parsed = parseGraphArtifactV2(text)
      const provenance = parsed.provenance
      return Object.freeze({
        format: 'v2' as const,
        schemaVersion: finiteNumberOrNull(provenance.schema_version),
        extractorVersion: finiteNumberOrNull(provenance.extractor_version),
        spiMode: provenance.spi_mode === true,
        directed: parsed.directed,
        generationPolicy: optionalRecord(provenance.generation_policy),
        graphBuildFreshness: provenance.graph_build_freshness,
        discoverySafety: provenance.discovery_safety,
        communityLabels: parsed.community_labels,
        rootPath: readLocalSidecarRootPath(resolvedPath),
        nodeSourceFiles: distinctSourceFiles(parsed.nodes),
      })
    }

    const payload = JSON.parse(text) as Record<string, unknown>
    if (!isRecord(payload)) return { ...ABSENT_METADATA, format: 'unreadable' }
    return Object.freeze({
      format: 'v1' as const,
      schemaVersion: finiteNumberOrNull(payload.schema_version),
      extractorVersion: finiteNumberOrNull(payload.extractor_version),
      spiMode: payload.spi_mode === true,
      directed: typeof payload.directed === 'boolean' ? payload.directed : null,
      generationPolicy: optionalRecord(payload.generation_policy),
      graphBuildFreshness: payload.graph_build_freshness,
      discoverySafety: payload.discovery_safety,
      communityLabels: optionalRecord(payload.community_labels) ?? {},
      rootPath: nonEmptyStringOrNull(payload.root_path) ?? readLocalSidecarRootPath(resolvedPath),
      nodeSourceFiles: distinctSourceFiles(payload.nodes),
    })
  } catch {
    return { ...ABSENT_METADATA, format: 'unreadable' }
  }
}

const GRAPH_ARTIFACT_CACHE_IDENTITY_FIELDS = Object.freeze([
  'graph_artifact_version',
  'semantic_fact_identity_version',
  'evidence_occurrence_identity_version',
  'relation_discriminator_registry_version',
  'endpoint_identity_policy_version',
  'repository_revision',
  'qualification',
] as const)

/**
 * Builds the complete cache namespace for a loaded graph artifact. Legacy
 * compatibility loads remain explicitly degraded even though their newly
 * synthesized fact and occurrence IDs use the current identity algorithms.
 */
export function graphArtifactCacheIdentity(artifact: LoadedGraphArtifact): GraphArtifactCacheIdentity {
  return Object.freeze({
    graph_artifact_version: artifact.format === 'v2' ? GRAPH_ARTIFACT_VERSION : 1,
    semantic_fact_identity_version: SEMANTIC_FACT_IDENTITY_SCHEMA_VERSION,
    evidence_occurrence_identity_version: EVIDENCE_OCCURRENCE_IDENTITY_SCHEMA_VERSION,
    relation_discriminator_registry_version: RELATION_DISCRIMINATOR_REGISTRY_ID,
    endpoint_identity_policy_version: ENDPOINT_IDENTITY_POLICY_VERSION,
    repository_revision: artifact.repositoryRevision,
    qualification: artifact.format === 'v2' ? 'native_v2' : 'legacy_v1_degraded',
  })
}

function malformedCacheIdentity(value: unknown): boolean {
  if (!isRecord(value)) return true
  const keys = Object.keys(value)
  if (keys.some((key) => !GRAPH_ARTIFACT_CACHE_IDENTITY_FIELDS.includes(
    key as (typeof GRAPH_ARTIFACT_CACHE_IDENTITY_FIELDS)[number],
  ))) return false
  if (!GRAPH_ARTIFACT_CACHE_IDENTITY_FIELDS.every((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    return true
  }
  return !Number.isSafeInteger(value.graph_artifact_version)
    || !Number.isSafeInteger(value.semantic_fact_identity_version)
    || !Number.isSafeInteger(value.evidence_occurrence_identity_version)
    || typeof value.relation_discriminator_registry_version !== 'string'
    || typeof value.endpoint_identity_policy_version !== 'string'
    || typeof value.repository_revision !== 'string'
    || value.repository_revision.length === 0
    || (value.qualification !== 'native_v2' && value.qualification !== 'legacy_v1_degraded')
}

/** Fail-closed cache comparison; no version or provenance dimension is ignored. */
export function graphArtifactCacheCompatibility(
  cached: unknown,
  expected: GraphArtifactCacheIdentity,
): GraphArtifactCacheCompatibility {
  if (!isRecord(cached) || malformedCacheIdentity(cached)) {
    return Object.freeze({ status: 'incompatible', reasons: Object.freeze(['malformed_cache_identity']) })
  }

  const unknownFields = Object.keys(cached)
    .filter((key) => !GRAPH_ARTIFACT_CACHE_IDENTITY_FIELDS.includes(
      key as (typeof GRAPH_ARTIFACT_CACHE_IDENTITY_FIELDS)[number],
    ))
    .sort()
  if (unknownFields.length > 0) {
    return Object.freeze({
      status: 'incompatible',
      reasons: Object.freeze(unknownFields.map((field) => `unsupported_cache_identity_field:${field}`)),
    })
  }

  const unsupported: string[] = []
  if (cached.graph_artifact_version !== 1 && cached.graph_artifact_version !== GRAPH_ARTIFACT_VERSION) {
    unsupported.push('unsupported_cache_identity:graph_artifact_version')
  }
  if (cached.semantic_fact_identity_version !== SEMANTIC_FACT_IDENTITY_SCHEMA_VERSION) {
    unsupported.push('unsupported_cache_identity:semantic_fact_identity_version')
  }
  if (cached.evidence_occurrence_identity_version !== EVIDENCE_OCCURRENCE_IDENTITY_SCHEMA_VERSION) {
    unsupported.push('unsupported_cache_identity:evidence_occurrence_identity_version')
  }
  if (cached.relation_discriminator_registry_version !== RELATION_DISCRIMINATOR_REGISTRY_ID) {
    unsupported.push('unsupported_cache_identity:relation_discriminator_registry_version')
  }
  if (cached.endpoint_identity_policy_version !== ENDPOINT_IDENTITY_POLICY_VERSION) {
    unsupported.push('unsupported_cache_identity:endpoint_identity_policy_version')
  }
  if (unsupported.length > 0) {
    return Object.freeze({ status: 'incompatible', reasons: Object.freeze(unsupported) })
  }

  const mismatches = GRAPH_ARTIFACT_CACHE_IDENTITY_FIELDS
    .filter((field) => cached[field] !== expected[field])
    .map((field) => `cache_identity_mismatch:${field}`)
  return Object.freeze(mismatches.length === 0
    ? { status: 'reusable' as const, reasons: Object.freeze([] as string[]) }
    : { status: 'incompatible' as const, reasons: Object.freeze(mismatches) })
}
