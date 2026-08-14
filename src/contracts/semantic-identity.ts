import { createHash } from 'node:crypto'

import { canonicalJsonBytes, serializeCanonicalJson } from './canonical-json.js'
import {
  normalizeEndpointIdentityQualification,
  validateEndpointIdentityQualification,
  type EndpointIdentityQualification,
} from './endpoint-identity.js'
import {
  RELATION_DISCRIMINATOR_REGISTRY_ID,
  RELATION_DISCRIMINATOR_REGISTRY_V1,
  isRegisteredRelation,
  type RegisteredRelation,
  type SemanticDiscriminator,
} from './relation-discriminator.js'
import type {
  EvidenceOccurrenceId,
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
  readonly relation: RegisteredRelation
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
): asserts relation is RegisteredRelation {
  if (!isRegisteredRelation(relation)) {
    throw new SemanticIdentityInvariantError(`relation ${JSON.stringify(relation)} is not registered`)
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
  if (
    serializeCanonicalJson(discriminator.canonicalValue, { arraySemantics: 'ordered' })
    !== serializeCanonicalJson(policy.canonicalValue, { arraySemantics: 'ordered' })
  ) {
    throw new SemanticIdentityInvariantError(`canonical discriminator value does not match relation ${relation}`)
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
  }, { arraySemantics: 'ordered' })
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
