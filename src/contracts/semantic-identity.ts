import { createHash } from 'node:crypto'

import { canonicalJsonBytes, serializeCanonicalJson } from './canonical-json.js'
import {
  normalizeEndpointIdentityQualification,
  validateEndpointIdentityQualification,
  type EndpointIdentityQualification,
} from './endpoint-identity.js'
import {
  LEGACY_PARALLEL_FACTS_UNRECOVERABLE,
  LEGACY_RELATION_DISCRIMINATOR_POLICY_VERSION,
  RELATION_DISCRIMINATOR_REGISTRY_ID,
  RELATION_DISCRIMINATOR_REGISTRY_V1,
  isRegisteredRelation,
  type SemanticDiscriminator,
} from './relation-discriminator.js'
import type {
  ConfidenceObservation,
  EvidenceOccurrence,
  EvidenceOccurrenceId,
  EvidenceOccurrenceOwner,
  EvidenceProvenance,
  SemanticFact,
  SemanticFactDirection,
  SemanticFactId,
  SourceRange,
} from './semantic-graph.js'

export const SEMANTIC_FACT_IDENTITY_SCHEMA_VERSION = 1 as const
export const EVIDENCE_OCCURRENCE_IDENTITY_SCHEMA_VERSION = 1 as const

export class SemanticIdentityInvariantError extends Error {
  constructor(message: string) {
    super(`Semantic identity invariant failed: ${message}`)
    this.name = 'SemanticIdentityInvariantError'
  }
}

export class FatalIdentityCollisionError extends Error {
  readonly identity: string

  constructor(identity: string) {
    super(`FATAL semantic identity collision: ${identity} maps different canonical payloads to one hash`)
    this.name = 'FatalIdentityCollisionError'
    this.identity = identity
  }
}

export type IdentityHashFunction = (canonicalPayload: Buffer) => string

export interface SemanticFactIdentityInput {
  readonly direction: SemanticFactDirection
  readonly source: string
  readonly target: string
  readonly relation: string
  readonly discriminator: SemanticDiscriminator
  readonly [excludedFromIdentity: string]: unknown
}

export interface EvidenceOccurrenceIdentityInput {
  readonly factId: SemanticFactId
  readonly adapterId: string
  readonly strategy: string
  readonly repositoryRelativeSourceFile?: string | null
  readonly sourceRange?: SourceRange | null
  readonly repositoryRelativeTargetFile?: string | null
  readonly targetRange?: SourceRange | null
  readonly siteKind?: string | null
  readonly adapterEvidenceKey?: string | null
  readonly [excludedFromIdentity: string]: unknown
}

export interface SemanticFactInput extends SemanticFactIdentityInput {
  readonly endpointIdentity?: unknown
  readonly occurrenceIds?: readonly EvidenceOccurrenceId[]
  readonly annotations?: SemanticFact['annotations']
}

export interface EvidenceOccurrenceInput {
  readonly factId: SemanticFactId
  readonly owner: EvidenceOccurrenceOwner
  readonly sourceFile?: string
  readonly sourceRange?: SourceRange
  readonly targetFile?: string
  readonly targetRange?: SourceRange
  readonly siteKind?: string
  readonly adapterEvidenceKey?: string
  readonly provenance?: readonly EvidenceProvenance[]
  readonly confidenceObservations?: readonly ConfidenceObservation[]
  readonly metadata?: EvidenceOccurrence['metadata']
}

export type EvidenceOccurrenceDraft = Omit<EvidenceOccurrenceInput, 'factId'>

export function canonicalEndpointPair(source: string, target: string): readonly [string, string] {
  const sorted = [source, target].sort()
  return Object.freeze([sorted[0]!, sorted[1]!] as const)
}

function normalizedEndpoints(input: Pick<SemanticFactIdentityInput, 'direction' | 'source' | 'target'>): readonly [string, string] {
  if (typeof input.source !== 'string' || input.source.length === 0) {
    throw new SemanticIdentityInvariantError('source endpoint is missing')
  }
  if (typeof input.target !== 'string' || input.target.length === 0) {
    throw new SemanticIdentityInvariantError('target endpoint is missing')
  }
  return input.direction === 'directed'
    ? Object.freeze([input.source, input.target] as const)
    : canonicalEndpointPair(input.source, input.target)
}

function assertDiscriminatorMatchesRegistry(
  relation: string,
  discriminator: SemanticDiscriminator,
): void {
  if (discriminator.legacy === true) {
    const canonicalValue = discriminator.canonicalValue
    const legacyValue = canonicalValue as { readonly [key: string]: unknown }
    if (
      discriminator.registryId !== RELATION_DISCRIMINATOR_REGISTRY_ID
      || discriminator.policyVersion !== LEGACY_RELATION_DISCRIMINATOR_POLICY_VERSION
      || discriminator.completeness !== 'partial'
      || discriminator.reasons.length !== 1
      || discriminator.reasons[0] !== LEGACY_PARALLEL_FACTS_UNRECOVERABLE
      || canonicalValue === null
      || typeof canonicalValue !== 'object'
      || Array.isArray(canonicalValue)
      || !/^[a-f0-9]{64}$/.test(String(legacyValue.legacy_link_fingerprint ?? ''))
      || !Number.isSafeInteger(legacyValue.legacy_duplicate_ordinal)
      || (legacyValue.legacy_duplicate_ordinal as number) < 0
      || Object.keys(canonicalValue).sort().join(',') !== 'legacy_duplicate_ordinal,legacy_link_fingerprint'
    ) {
      throw new SemanticIdentityInvariantError('legacy discriminator is malformed')
    }
    return
  }
  if (!isRegisteredRelation(relation)) {
    throw new SemanticIdentityInvariantError(`relation ${JSON.stringify(relation)} is not registered`)
  }
  if (discriminator.legacy !== undefined) {
    throw new SemanticIdentityInvariantError('discriminator legacy marker must be true when present')
  }
  const policy = RELATION_DISCRIMINATOR_REGISTRY_V1[relation]
  if (discriminator.registryId !== RELATION_DISCRIMINATOR_REGISTRY_ID) {
    throw new SemanticIdentityInvariantError('discriminator registry identifier does not match v1')
  }
  if (discriminator.policyVersion !== policy.policyVersion) {
    throw new SemanticIdentityInvariantError(`discriminator policy version does not match relation ${relation}`)
  }
  if (discriminator.completeness !== policy.completeness) {
    throw new SemanticIdentityInvariantError(`discriminator completeness does not match relation ${relation}`)
  }
  const canonicalValue = serializeCanonicalJson(discriminator.canonicalValue, { arraySemantics: 'ordered' })
  if (
    policy.completeness === 'endpoint_only'
    && canonicalValue !== serializeCanonicalJson(policy.canonicalValue, { arraySemantics: 'ordered' })
  ) {
    throw new SemanticIdentityInvariantError(`endpoint-only relation ${relation} cannot carry discriminator data`)
  }
  if (
    discriminator.reasons.length !== policy.reasons.length
    || discriminator.reasons.some((reason, index) => reason !== policy.reasons[index])
  ) {
    throw new SemanticIdentityInvariantError(`discriminator reasons do not match relation ${relation}`)
  }
}

function semanticFactPayload(input: SemanticFactIdentityInput): Buffer {
  if (input.direction !== 'directed' && input.direction !== 'undirected') {
    throw new SemanticIdentityInvariantError('direction must be directed or undirected')
  }
  assertDiscriminatorMatchesRegistry(input.relation, input.discriminator)
  const [source, target] = normalizedEndpoints(input)
  return canonicalJsonBytes({
    identitySchemaVersion: SEMANTIC_FACT_IDENTITY_SCHEMA_VERSION,
    direction: input.direction,
    source,
    target,
    relation: input.relation,
    discriminatorRegistryId: input.discriminator.registryId,
    discriminatorPolicyVersion: input.discriminator.policyVersion,
    discriminatorCompleteness: input.discriminator.completeness,
    discriminatorValue: input.discriminator.canonicalValue,
    ...(input.discriminator.legacy === true ? { discriminatorLegacy: true } : {}),
  }, { arraySemantics: 'ordered' })
}

/**
 * The single repository-relative path contract for occurrence identity v1.
 *
 * Exported so no caller has to reimplement it. A second implementation already
 * existed in the graph compatibility adapter with subtly different rules: it
 * kept empty and "." segments, and its drive-letter test matched only a single
 * letter, so it accepted "https://host/a.ts" and handed it here to be thrown
 * out. Divergent copies of an identity rule are how a path becomes acceptable
 * to one layer and fatal to the next.
 *
 * These are exactly the v1 rules. Changing any of them changes occurrence ids
 * and is owned by #704, not by this function.
 */
export function normalizeIdentityRepositoryPath(value: string | null | undefined, field: string): string | null {
  return normalizeRepositoryRelativePath(value, field)
}

function normalizeRepositoryRelativePath(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) {
    return null
  }
  const normalizedSeparators = value.replaceAll('\\', '/')
  if (
    normalizedSeparators.length === 0
    || normalizedSeparators.startsWith('/')
    || /^[A-Za-z]:\//.test(normalizedSeparators)
    || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalizedSeparators)
  ) {
    throw new SemanticIdentityInvariantError(`${field} must be repository-relative`)
  }

  const segments = normalizedSeparators.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.includes('..')) {
    throw new SemanticIdentityInvariantError(`${field} must not escape the repository`)
  }
  return segments.join('/')
}

function optionalIdentityString(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new SemanticIdentityInvariantError(`${field} must be a string when present`)
  }
  return value
}

function evidenceOccurrencePayload(input: EvidenceOccurrenceIdentityInput): Buffer {
  if (typeof input.adapterId !== 'string' || input.adapterId.length === 0) {
    throw new SemanticIdentityInvariantError('adapterId is missing')
  }
  if (typeof input.strategy !== 'string' || input.strategy.length === 0) {
    throw new SemanticIdentityInvariantError('strategy is missing')
  }
  if (typeof input.factId !== 'string' || !/^sf_[a-f0-9]{64}$/.test(input.factId)) {
    throw new SemanticIdentityInvariantError('factId must be a full lowercase SemanticFactId')
  }

  return canonicalJsonBytes({
    occurrenceIdentitySchemaVersion: EVIDENCE_OCCURRENCE_IDENTITY_SCHEMA_VERSION,
    factId: input.factId,
    adapterId: input.adapterId,
    strategy: input.strategy,
    repositoryRelativeSourceFile: normalizeRepositoryRelativePath(
      input.repositoryRelativeSourceFile,
      'repositoryRelativeSourceFile',
    ),
    sourceRange: input.sourceRange ?? null,
    repositoryRelativeTargetFile: normalizeRepositoryRelativePath(
      input.repositoryRelativeTargetFile,
      'repositoryRelativeTargetFile',
    ),
    targetRange: input.targetRange ?? null,
    siteKind: optionalIdentityString(input.siteKind, 'siteKind'),
    adapterEvidenceKey: optionalIdentityString(input.adapterEvidenceKey, 'adapterEvidenceKey'),
  }, { arraySemantics: 'ordered' })
}

function sha256(canonicalPayload: Buffer): string {
  return createHash('sha256').update(canonicalPayload).digest('hex')
}

/**
 * Content-addressed ID factory with a process-local payload witness map. The
 * witness makes a digest collision a fatal invariant error instead of allowing
 * a later fact or occurrence to alias earlier semantic content.
 */
export class SemanticIdentityFactory {
  private readonly payloadByDigest = new Map<string, Buffer>()

  constructor(private readonly hash: IdentityHashFunction = sha256) {}

  private contentAddress(prefix: 'sf_' | 'eo_', payload: Buffer): string {
    const digest = this.hash(payload)
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new SemanticIdentityInvariantError('hash function must return full lowercase SHA-256 hex')
    }
    const identity = `${prefix}${digest}`
    const existingPayload = this.payloadByDigest.get(digest)
    if (existingPayload !== undefined && !existingPayload.equals(payload)) {
      throw new FatalIdentityCollisionError(identity)
    }
    if (existingPayload === undefined) {
      this.payloadByDigest.set(digest, Buffer.from(payload))
    }
    return identity
  }

  createSemanticFactId(input: SemanticFactIdentityInput): SemanticFactId {
    return this.contentAddress('sf_', semanticFactPayload(input)) as SemanticFactId
  }

  createEvidenceOccurrenceId(input: EvidenceOccurrenceIdentityInput): EvidenceOccurrenceId {
    return this.contentAddress('eo_', evidenceOccurrencePayload(input)) as EvidenceOccurrenceId
  }
}

const DEFAULT_IDENTITY_FACTORY = new SemanticIdentityFactory()

export function createSemanticFactId(input: SemanticFactIdentityInput): SemanticFactId {
  return DEFAULT_IDENTITY_FACTORY.createSemanticFactId(input)
}

export function createEvidenceOccurrenceId(input: EvidenceOccurrenceIdentityInput): EvidenceOccurrenceId {
  return DEFAULT_IDENTITY_FACTORY.createEvidenceOccurrenceId(input)
}

/** Builds a detached occurrence model and derives its ID only from evidence-site identity. */
export function createEvidenceOccurrence(input: EvidenceOccurrenceInput): EvidenceOccurrence {
  // Normalize once, then derive the id from the canonical values AND store
  // those same values. Previously the id normalized the path while the stored
  // payload kept whatever spelling arrived, so "src\a.ts", "src//a.ts" and
  // "src/./a.ts" all produced one id with three different recorded paths.
  const normalizedSource = normalizeRepositoryRelativePath(input.sourceFile ?? null, 'sourceFile')
  const normalizedOwnerSource = normalizeRepositoryRelativePath(input.owner.sourceFile ?? null, 'owner.sourceFile')
  if (
    normalizedSource !== null
    && normalizedOwnerSource !== null
    && normalizedSource !== normalizedOwnerSource
  ) {
    // Silently preferring one and storing the other is what produced an
    // occurrence carrying two conflicting source paths.
    throw new SemanticIdentityInvariantError(
      `sourceFile ${JSON.stringify(normalizedSource)} conflicts with owner.sourceFile ${JSON.stringify(normalizedOwnerSource)}`,
    )
  }
  const sourceFile = normalizedSource ?? normalizedOwnerSource ?? undefined
  const targetFile = normalizeRepositoryRelativePath(input.targetFile ?? null, 'targetFile') ?? undefined

  const id = createEvidenceOccurrenceId({
    factId: input.factId,
    adapterId: input.owner.adapterId,
    strategy: input.owner.strategy,
    repositoryRelativeSourceFile: sourceFile ?? null,
    sourceRange: input.sourceRange ?? null,
    repositoryRelativeTargetFile: targetFile ?? null,
    targetRange: input.targetRange ?? null,
    siteKind: input.siteKind ?? null,
    adapterEvidenceKey: input.adapterEvidenceKey ?? null,
  })

  return Object.freeze({
    id,
    factId: input.factId,
    owner: Object.freeze({
      ...input.owner,
      // A present owner.sourceFile always normalizes to a string or throws, so
      // a null here means it was absent and must stay absent.
      ...(normalizedOwnerSource !== null ? { sourceFile: normalizedOwnerSource } : {}),
    }),
    ...(sourceFile !== undefined ? { sourceFile } : {}),
    ...(input.sourceRange !== undefined ? { sourceRange: Object.freeze({
      start: Object.freeze({ ...input.sourceRange.start }),
      end: Object.freeze({ ...input.sourceRange.end }),
    }) } : {}),
    ...(targetFile !== undefined ? { targetFile } : {}),
    ...(input.targetRange !== undefined ? { targetRange: Object.freeze({
      start: Object.freeze({ ...input.targetRange.start }),
      end: Object.freeze({ ...input.targetRange.end }),
    }) } : {}),
    ...(input.siteKind !== undefined ? { siteKind: input.siteKind } : {}),
    ...(input.adapterEvidenceKey !== undefined ? { adapterEvidenceKey: input.adapterEvidenceKey } : {}),
    provenance: Object.freeze([...(input.provenance ?? [])].map((entry) => Object.freeze({ ...entry }))),
    confidenceObservations: Object.freeze(
      [...(input.confidenceObservations ?? [])].map((entry) => Object.freeze({ ...entry })),
    ),
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  })
}

/** Rebinds one evidence site when a graph transform intentionally changes its owning fact ID. */
export function rebindEvidenceOccurrence(
  occurrence: EvidenceOccurrence,
  factId: SemanticFactId,
): EvidenceOccurrence {
  return createEvidenceOccurrence({
    factId,
    owner: occurrence.owner,
    ...(occurrence.sourceFile !== undefined ? { sourceFile: occurrence.sourceFile } : {}),
    ...(occurrence.sourceRange !== undefined ? { sourceRange: occurrence.sourceRange } : {}),
    ...(occurrence.targetFile !== undefined ? { targetFile: occurrence.targetFile } : {}),
    ...(occurrence.targetRange !== undefined ? { targetRange: occurrence.targetRange } : {}),
    ...(occurrence.siteKind !== undefined ? { siteKind: occurrence.siteKind } : {}),
    ...(occurrence.adapterEvidenceKey !== undefined ? { adapterEvidenceKey: occurrence.adapterEvidenceKey } : {}),
    provenance: occurrence.provenance,
    confidenceObservations: occurrence.confidenceObservations,
    metadata: occurrence.metadata,
  })
}

function orientedQualification(
  input: SemanticFactInput,
  qualification: EndpointIdentityQualification,
  source: string,
  target: string,
): EndpointIdentityQualification {
  if (input.direction === 'directed' || (source === input.source && target === input.target)) {
    return qualification
  }
  return validateEndpointIdentityQualification({
    source: qualification.target,
    target: qualification.source,
  })
}

/** Builds the Stage 1 model while making qualification explicit on every fact. */
export function createSemanticFact(input: SemanticFactInput): SemanticFact {
  if (input.direction !== 'directed' && input.direction !== 'undirected') {
    throw new SemanticIdentityInvariantError('direction must be directed or undirected')
  }
  if (typeof input.source !== 'string' || typeof input.target !== 'string') {
    throw new SemanticIdentityInvariantError('source and target endpoints must be strings')
  }
  assertDiscriminatorMatchesRegistry(input.relation, input.discriminator)
  const [source, target] = normalizedEndpoints(input)

  const qualification = normalizeEndpointIdentityQualification(input)
  const endpointIdentity = orientedQualification(input, qualification, source, target)
  const identityInput: SemanticFactIdentityInput = {
    direction: input.direction,
    source,
    target,
    relation: input.relation,
    discriminator: input.discriminator,
  }

  return Object.freeze({
    id: createSemanticFactId(identityInput),
    direction: input.direction,
    source,
    target,
    relation: input.relation,
    discriminator: input.discriminator,
    endpointIdentity,
    occurrenceIds: Object.freeze([...new Set(input.occurrenceIds ?? [])].sort()),
    annotations: Object.freeze({ ...(input.annotations ?? {}) }),
  })
}
